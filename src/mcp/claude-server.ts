import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { detectPlatform, isMuxAvailable } from '../lib/platform.js';
import type { HealthStatus } from '../lib/types.js';
import { prepareMessagePayload } from '../lib/payloads.js';
import { CLAUDE_MCP_INSTANCE_DIR, MAX_MESSAGE_BATCH_SIZE } from '../lib/constants.js';
import { BrokerClient } from '../lib/broker-client.js';
import { resolveWakeMethod } from '../lib/broker-client.js';
import { collectRequiredAttachmentPaths, normalizeBatchSize, normalizeWaitMs, sendWakeup } from '../lib/adapter-utils.js';
import { createStandbyLoop } from '../standby/loop.js';
import { createMessageLoop } from '../standby/message-loop.js';
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
      'To check for new messages from Codex, call the check_messages tool. When idle, prefer wait_for_messages so you can block until a new message arrives instead of polling. For continuous background monitoring until stopped, use start_message_loop and stop_message_loop. To send a message to Codex, call the reply tool with your message text. If a received message includes attachments with required=true, you must read those attachment documents before replying. To reset the conversation, call the reset_session tool with confirm=true.',
  },
);
const brokerClient = new BrokerClient('claude');
brokerClient.startHeartbeatLoop();
const messageLoop = createMessageLoop({
  agentKind: 'claude',
  brokerClient,
  server: mcp,
  isSingleInstanceSafe: () => !refreshSingleInstanceWarning(),
  logPrefix: '[claude-mcp]',
});

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
      name: 'reply',
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
            maximum: 30000,
            description: 'Optional wait timeout in milliseconds. Defaults to 30000.',
          },
        },
      },
    },
    {
      name: 'start_message_loop',
      description: 'Start a background loop that continuously watches for new bridge messages until stopped.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'stop_message_loop',
      description: 'Stop the background message loop.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'message_loop_status',
      description: 'Return current background message loop status.',
      inputSchema: { type: 'object', properties: {} },
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

  if (request.params.name === 'start_message_loop') {
    const started = messageLoop.start();
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, started, running: messageLoop.getStatus().running }) }],
    };
  }

  if (request.params.name === 'stop_message_loop') {
    const stopped = messageLoop.stop();
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, stopped, running: messageLoop.getStatus().running }) }],
    };
  }

  if (request.params.name === 'message_loop_status') {
    return {
      content: [{ type: 'text', text: JSON.stringify(messageLoop.getStatus()) }],
    };
  }

  if (request.params.name === 'health_check') {
    const { peer, broker } = await brokerClient.health();
    const otherInstance = refreshSingleInstanceWarning();
    const standbyStatus = standbyLoop?.getStatus();
    const messageLoopStatus = messageLoop.getStatus();
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
      message_loop_running: messageLoopStatus.running,
      message_loop_last_error: messageLoopStatus.last_error,
      message_loop_last_notified_seq: messageLoopStatus.last_notified_seq,
      message_loop_last_notified_at: messageLoopStatus.last_notified_at,
      message_loop_notification_count: messageLoopStatus.notification_count,
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
    return { content: [{ type: 'text', text: 'Session reset. Fresh conversation started.' }] };
  }

  if (request.params.name !== 'reply') {
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
    process.stderr.write(`[claude-mcp] reply error: ${error}\n`);
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
  messageLoop.stop();
  brokerClient.stopHeartbeatLoop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
