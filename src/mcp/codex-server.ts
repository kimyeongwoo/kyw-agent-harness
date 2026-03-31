import { unlinkSync } from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { HealthStatus } from '../lib/types.js';
import { prepareMessagePayload } from '../lib/payloads.js';
import { detectPlatform, isMuxAvailable } from '../lib/platform.js';
import { BrokerClient } from '../lib/broker-client.js';
import { collectRequiredAttachmentPaths, normalizeBatchSize, normalizeHistoryLimit, sendWakeup } from '../lib/adapter-utils.js';
import { createStandbyLoop } from '../standby/loop.js';
import {
  CODEX_MCP_INSTANCE_DIR,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MESSAGE_BATCH_SIZE,
  MAX_HISTORY_LIMIT,
  MAX_MESSAGE_BATCH_SIZE,
} from '../lib/constants.js';
import {
  registerCurrentInstance,
  listOtherLiveInstancePids,
  instanceFileFor,
} from '../lib/instance-registry.js';

const SERVER_NAME = 'codex-mcp' as const;
const INSTANCE_SLOT = new BrokerClient('codex').getSlot();
const AUTO_REPLY_DISABLED_BY_ENV = process.env.BRIDGE_DISABLE_AUTOREPLY === '1';
const startTime = Date.now();
let errorCount = 0;
let lastError: string | undefined = undefined;
let lastMessageAt: string | undefined = undefined;
const brokerClient = new BrokerClient('codex');
brokerClient.startHeartbeatLoop();

let standbyLoop: ReturnType<typeof createStandbyLoop> | null = null;

function refreshSingleInstanceWarning(opts?: { warn?: boolean }): boolean {
  registerCurrentInstance(CODEX_MCP_INSTANCE_DIR, INSTANCE_SLOT);
  const otherPids = listOtherLiveInstancePids(CODEX_MCP_INSTANCE_DIR, INSTANCE_SLOT);
  if (opts?.warn && otherPids.length > 0) {
    process.stderr.write(
      `[codex-mcp] WARNING: Other codex-mcp instances running for slot '${INSTANCE_SLOT}' (PID ${otherPids.join(', ')}).\n`,
    );
  }
  return otherPids.length > 0;
}
refreshSingleInstanceWarning({ warn: true });

const server = new Server(
  { name: 'codex-mcp', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'To read new messages from Claude, call check_messages. If a received message includes attachments with required=true, you must read those attachment documents before replying. To send a message back, call send_message.',
  },
);

if (!AUTO_REPLY_DISABLED_BY_ENV) {
  standbyLoop = createStandbyLoop({
    agentKind: 'codex',
    brokerClient,
    server,
    isSingleInstanceSafe: () => !refreshSingleInstanceWarning(),
    logPrefix: '[codex-mcp]',
  });
}
server.oninitialized = () => {
  standbyLoop?.start();
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'check_messages',
      description: 'Check if Claude has sent a new message to Codex.',
      inputSchema: {
        type: 'object',
        properties: {
          max_messages: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_MESSAGE_BATCH_SIZE,
            description: `Optional max unread messages to return. Defaults to ${DEFAULT_MESSAGE_BATCH_SIZE}.`,
          },
        },
      },
    },
    {
      name: 'send_message',
      description: 'Send a message from Codex to Claude.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message text to send to Claude.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'get_history',
      description: 'Get the full conversation history between Claude and Codex.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_HISTORY_LIMIT,
            description: `Optional max messages to return. Defaults to ${DEFAULT_HISTORY_LIMIT}.`,
          },
        },
      },
    },
    {
      name: 'reset_session',
      description: 'Reset conversation. Clears all state.',
      inputSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Must be true to confirm' },
        },
        required: ['confirm'],
      },
    },
    {
      name: 'health_check',
      description: 'Returns server health status.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'check_messages') {
    try {
      const maxMessages = normalizeBatchSize((args as { max_messages?: number } | undefined)?.max_messages);
      const pollResult = await brokerClient.pollInbox(maxMessages, 0);

      if (pollResult.messages.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ has_new: false }) }] };
      }

      const response: Record<string, unknown> = {
        has_new: true,
        message: pollResult.messages[pollResult.messages.length - 1]?.content,
        messages: pollResult.messages.map((m) => ({
          id: m.message_id,
          content: m.content,
          attachments: m.attachments,
          turn: m.seq,
          timestamp: m.created_at,
        })),
        returned_messages: pollResult.messages.length,
        has_more: pollResult.has_more,
      };

      const requiredPaths = collectRequiredAttachmentPaths(
        pollResult.messages.map((m) => ({ attachments: m.attachments })),
      );
      if (requiredPaths.length > 0) {
        response.has_required_attachments = true;
        response.required_attachment_paths = requiredPaths;
      }

      await brokerClient.ackInbox(pollResult.max_seq);
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    } catch (e) {
      errorCount++;
      lastError = String(e);
      process.stderr.write(`[codex-mcp] check_messages error: ${e}\n`);
      return { content: [{ type: 'text', text: JSON.stringify({ has_new: false, error: String(e) }) }] };
    }
  }

  if (name === 'send_message') {
    const text = (args as { text: string }).text;

    try {
      const session = await brokerClient.ensureRegistered();
      const messageId = crypto.randomUUID();
      const preparedPayload = await prepareMessagePayload('codex', session.conversation_id, text, { messageId });
      const enqueueResult = await brokerClient.enqueueMessage({
        messageId,
        recipientKind: 'claude',
        content: preparedPayload.content,
        attachments: preparedPayload.attachments,
      });

      lastMessageAt = new Date().toISOString();
      const triggerSent = await sendWakeup(
        enqueueResult.conversation_id,
        'claude',
        enqueueResult.recipient_wake_method,
        enqueueResult.recipient_pane_target,
        'New message from Codex. Use check_messages tool to read it.',
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ sent: true, message_id: enqueueResult.message_id, trigger_sent: triggerSent }),
        }],
      };
    } catch (e) {
      errorCount++;
      lastError = String(e);
      process.stderr.write(`[codex-mcp] send_message error: ${e}\n`);
      return { content: [{ type: 'text', text: JSON.stringify({ sent: false, error: String(e) }) }] };
    }
  }

  if (name === 'get_history') {
    const { limit: requestedLimit } = (args ?? {}) as { limit?: number };
    const limit = normalizeHistoryLimit(requestedLimit);
    const history = await brokerClient.getHistory(limit);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          messages: history.messages.map((m) => ({
            id: m.message_id,
            sender: m.sender_kind,
            content: m.content,
            attachments: m.attachments,
            timestamp: m.created_at,
            turn: m.seq,
          })),
          returned_messages: history.returned_messages,
          has_more: history.has_more,
          limit: history.limit,
        }),
      }],
    };
  }

  if (name === 'reset_session') {
    const { confirm } = args as { confirm: boolean };
    if (!confirm) return { content: [{ type: 'text', text: 'Reset cancelled.' }] };

    await brokerClient.resetConversation();
    errorCount = 0;
    lastError = undefined;
    lastMessageAt = undefined;
    return { content: [{ type: 'text', text: 'Session reset complete.' }] };
  }

  if (name === 'health_check') {
    const { peer, broker } = await brokerClient.health();
    const otherInstance = refreshSingleInstanceWarning();
    const standbyStatus = standbyLoop?.getStatus();
    const health: HealthStatus = {
      server: SERVER_NAME,
      pid: process.pid,
      uptime_ms: Date.now() - startTime,
      started_at: new Date(startTime).toISOString(),
      error_count: errorCount,
      last_error: lastError,
      last_message_at: lastMessageAt,
      platform: detectPlatform(),
      mux_available: isMuxAvailable(),
      peer_id: peer?.peer_id,
      conversation_id: peer?.conversation_id,
      slot: brokerClient.getSlot(),
      broker_connected: broker !== null,
      broker_pid: broker?.pid,
      broker_port: broker?.port,
      broker_uptime_ms: broker?.uptime_ms,
      multi_instance_warning: otherInstance,
      auto_reply_enabled: standbyStatus?.enabled,
      auto_reply_disabled_reason: standbyStatus?.disabled_reason,
      auto_reply_last_reply_at: standbyStatus?.last_reply_at,
      auto_reply_last_error: standbyStatus?.last_error,
    };
    return { content: [{ type: 'text', text: JSON.stringify(health) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on('exit', () => {
  try { unlinkSync(instanceFileFor(CODEX_MCP_INSTANCE_DIR, process.pid)); } catch {}
});

const shutdown = () => {
  standbyLoop?.stop();
  brokerClient.stopHeartbeatLoop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
