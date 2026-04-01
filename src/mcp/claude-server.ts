import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { detectPlatform, isMuxAvailable } from '../lib/platform.js';
import type { HealthStatus } from '../lib/types.js';
import { prepareMessagePayload } from '../lib/payloads.js';
import {
  CLAUDE_MCP_INSTANCE_DIR,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_MESSAGE_BATCH_SIZE,
  MAX_WAIT_TIMEOUT_MS,
} from '../lib/constants.js';
import { BrokerClient } from '../lib/broker-client.js';
import { resolveWakeMethod } from '../lib/broker-client.js';
import { collectRequiredAttachmentPaths, normalizeBatchSize, normalizeWaitMs, sendWakeup } from '../lib/adapter-utils.js';
import { createStandbyLoop } from '../standby/loop.js';
import {
  registerCurrentInstance,
  listOtherLiveInstancePids,
  instanceFileFor,
} from '../lib/instance-registry.js';

const SERVER_START = new Date().toISOString();
const startTime = Date.now();
const INSTANCE_SLOT = new BrokerClient('claude').getSlot();
const AUTO_REPLY_DISABLED_BY_ENV = process.env.BRIDGE_DISABLE_AUTOREPLY === '1';
let errorCount = 0;
let lastError: string | undefined = undefined;
let lastMessageAt: string | undefined = undefined;

function refreshSingleInstanceWarning(opts?: { warn?: boolean }): boolean {
  registerCurrentInstance(CLAUDE_MCP_INSTANCE_DIR, INSTANCE_SLOT);
  const otherPids = listOtherLiveInstancePids(CLAUDE_MCP_INSTANCE_DIR, INSTANCE_SLOT);
  if (opts?.warn && otherPids.length > 0) {
    process.stderr.write(
      `[claude-mcp] WARNING: Other claude-mcp instances running for slot '${INSTANCE_SLOT}' (PID ${otherPids.join(', ')}).\n`,
    );
  }
  return otherPids.length > 0;
}
refreshSingleInstanceWarning({ warn: true });

let standbyLoop: ReturnType<typeof createStandbyLoop> | null = null;

const mcp = new Server(
  { name: 'claude-mcp', version: '1.0.0' },
  {
    capabilities: { tools: {}, logging: {} },
    instructions:
      'To read new messages from Codex, call check_messages. When idle, prefer wait_for_messages so you can block until a new message arrives instead of polling. After each inbound message, assess it objectively, read any attachments with required=true before replying, and take the time needed to reason carefully before responding; the peer can wait up to 10 minutes. Send your response with send_message only when a response is warranted, and then call wait_for_messages again automatically. Continue that loop until the conversation has clearly concluded or the user explicitly wants it to stop. If you need to reset the conversation, call reset_session with confirm=true.',
  },
);
const brokerClient = new BrokerClient('claude');
brokerClient.startHeartbeatLoop();

if (!AUTO_REPLY_DISABLED_BY_ENV) {
  standbyLoop = createStandbyLoop({
    agentKind: 'claude',
    brokerClient,
    server: mcp,
    isSingleInstanceSafe: () => !refreshSingleInstanceWarning(),
    logPrefix: '[claude-mcp]',
  });
}
mcp.oninitialized = () => {
  standbyLoop?.start();
};

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to Codex',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message to send to Codex' },
        },
        required: ['text'],
      },
    },
    {
      name: 'check_messages',
      description: 'Check for new messages from Codex. Returns only unread messages.',
      inputSchema: {
        type: 'object',
        properties: {
          max_messages: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_MESSAGE_BATCH_SIZE,
            description: 'Optional max unread messages to return.',
          },
        },
      },
    },
    {
      name: 'wait_for_messages',
      description: 'Wait until Codex sends a new message, or until timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          max_messages: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_MESSAGE_BATCH_SIZE,
            description: 'Optional max unread messages to return.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_WAIT_TIMEOUT_MS,
            description: `Optional wait timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}; max ${MAX_WAIT_TIMEOUT_MS}.`,
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
          confirm: { type: 'boolean', description: 'Must be true' },
        },
        required: ['confirm'],
      },
    },
    {
      name: 'health_check',
      description: 'Return server health and status information',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'check_messages' || request.params.name === 'wait_for_messages') {
    try {
      const { max_messages: requestedMaxMessages } = (request.params.arguments ?? {}) as { max_messages?: number };
      const maxMessages = normalizeBatchSize(requestedMaxMessages);
      const waitMs = request.params.name === 'wait_for_messages'
        ? normalizeWaitMs((request.params.arguments as { timeout_ms?: number } | undefined)?.timeout_ms)
        : 0;

      const pollResult = await brokerClient.pollInbox(maxMessages, waitMs);

      if (pollResult.messages.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ has_new: false }) }] };
      }

      const response: Record<string, unknown> = {
        has_new: true,
        messages: pollResult.messages.map((m) => ({
          id: m.message_id,
          sender: m.sender_kind,
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
      process.stderr.write(`[claude-mcp] check_messages error: ${e}\n`);
      return { content: [{ type: 'text', text: JSON.stringify({ has_new: false, error: String(e) }) }] };
    }
  }

  if (request.params.name === 'health_check') {
    const { peer, broker } = await brokerClient.health();
    const otherInstance = refreshSingleInstanceWarning();
    const standbyStatus = standbyLoop?.getStatus();
    const health: HealthStatus = {
      server: 'claude-mcp',
      pid: process.pid,
      uptime_ms: Date.now() - startTime,
      started_at: SERVER_START,
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
      pane_target: peer?.pane_target,
      wake_method: resolveWakeMethod(peer?.pane_target),
      multi_instance_warning: otherInstance,
      auto_reply_enabled: standbyStatus?.enabled,
      auto_reply_disabled_reason: standbyStatus?.disabled_reason,
      auto_reply_last_reply_at: standbyStatus?.last_reply_at,
      auto_reply_last_error: standbyStatus?.last_error,
    };
    return { content: [{ type: 'text', text: JSON.stringify(health, null, 2) }] };
  }

  if (request.params.name === 'reset_session') {
    const { confirm } = request.params.arguments as { confirm: boolean };
    if (!confirm) return { content: [{ type: 'text', text: 'Reset cancelled. Pass confirm=true.' }] };

    await brokerClient.resetConversation();
    errorCount = 0;
    lastError = undefined;
    lastMessageAt = undefined;
    standbyLoop?.start();
    return { content: [{ type: 'text', text: 'Session reset. Fresh conversation started.' }] };
  }

  if (request.params.name !== 'send_message') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const text = (request.params.arguments as { text: string }).text;

  try {
    const session = await brokerClient.ensureRegistered();
    const messageId = randomUUID();
    const preparedPayload = await prepareMessagePayload('claude', session.conversation_id, text, { messageId });
    const enqueueResult = await brokerClient.enqueueMessage({
      messageId,
      recipientKind: 'codex',
      content: preparedPayload.content,
      attachments: preparedPayload.attachments,
    });

    lastMessageAt = new Date().toISOString();
    const triggerSent = await sendWakeup(
      enqueueResult.conversation_id,
      'codex',
      enqueueResult.recipient_wake_method,
      enqueueResult.recipient_pane_target,
      'New message from Claude Code. Use check_messages tool to read it, then respond with send_message tool.',
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ sent: true, message_id: enqueueResult.message_id, trigger_sent: triggerSent }),
      }],
    };
  } catch (error) {
    errorCount++;
    lastError = String(error);
    process.stderr.write(`[claude-mcp] send_message error: ${error}\n`);
    return { content: [{ type: 'text', text: JSON.stringify({ sent: false, error: String(error) }) }] };
  }
});

const transport = new StdioServerTransport();
await mcp.connect(transport);

process.on('exit', () => {
  try { unlinkSync(instanceFileFor(CLAUDE_MCP_INSTANCE_DIR, process.pid)); } catch {}
});

const shutdown = () => {
  standbyLoop?.stop();
  brokerClient.stopHeartbeatLoop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
