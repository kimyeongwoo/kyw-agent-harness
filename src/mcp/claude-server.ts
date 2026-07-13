import { unlinkSync } from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { detectPlatform, isMuxAvailable } from '../lib/platform.js';
import type { HealthStatus } from '../lib/types.js';
import {
  CLAUDE_MCP_INSTANCE_DIR,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_MESSAGE_BATCH_SIZE,
  MAX_WAIT_TIMEOUT_MS,
} from '../lib/constants.js';
import { BrokerClient } from '../lib/broker-client.js';
import { resolveWakeMethod } from '../lib/broker-client.js';
import { collectRequiredAttachmentPaths, normalizeBatchSize, normalizeWaitMs } from '../lib/adapter-utils.js';
import { sendBridgeMessage } from '../lib/bridge-messenger.js';
import { createStandbyLoop } from '../standby/loop.js';
import { getWorkflowModelPolicy } from '../workflow/config.js';
import { getWorkflowTools, handleWorkflowTool, hasActiveWorkflowTask } from '../workflow/mcp.js';
import {
  registerCurrentInstance,
  listOtherLiveInstancePids,
  instanceFileFor,
} from '../lib/instance-registry.js';

const SERVER_START = new Date().toISOString();
const startTime = Date.now();
const INSTANCE_SLOT = new BrokerClient('claude').getSlot();
const MODEL_POLICY = getWorkflowModelPolicy('claude');
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
  { name: 'claude-mcp', version: '3.1.0' },
  {
    capabilities: { tools: {}, logging: {} },
    instructions:
      'You are the lead architect in structured workflow tasks. Call get_active_task when a workflow task is mentioned. During discovery and design, inspect the project read-only and do not modify project source code. Submit complete design artifacts with submit_design. After Codex implementation, validate conformance with submit_validation and do not fix the code yourself. For ordinary bridge conversations, use check_messages, wait_for_messages, and send_message. Read every required attachment before replying. Reset only with reset_session(confirm=true).',
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
    getPauseReason: () => hasActiveWorkflowTask(INSTANCE_SLOT)
      ? 'structured workflow task active; main Claude session owns architecture work'
      : undefined,
    modelHint: MODEL_POLICY.model_hint,
    requireModelMatch: MODEL_POLICY.require_model_match,
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
    ...getWorkflowTools('claude'),
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const workflowResult = await handleWorkflowTool(
    'claude',
    request.params.name,
    request.params.arguments,
    INSTANCE_SLOT,
  );
  if (workflowResult.handled) {
    let notificationResult: unknown;
    if (workflowResult.notification) {
      try {
        notificationResult = await sendBridgeMessage({
          brokerClient,
          senderKind: 'claude',
          recipientKind: workflowResult.notification.recipient,
          text: workflowResult.notification.text,
          wakeText: workflowResult.notification.wake_text,
        });
      } catch (error) {
        errorCount++;
        lastError = String(error);
        notificationResult = { sent: false, error: String(error) };
      }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ task: workflowResult.payload, notification: notificationResult }, null, 2),
      }],
    };
  }

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
      auto_reply_disabled_reason: standbyStatus?.disabled_reason ?? standbyStatus?.paused_reason,
      auto_reply_last_reply_at: standbyStatus?.last_reply_at,
      auto_reply_last_error: standbyStatus?.last_error,
      auto_reply_last_model: standbyStatus?.last_model,
      auto_reply_model_hint: MODEL_POLICY.model_hint,
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
    const sendResult = await sendBridgeMessage({
      brokerClient,
      senderKind: 'claude',
      recipientKind: 'codex',
      text,
      wakeText: 'New message from Claude Code. Use check_messages tool to read it, then respond with send_message tool.',
    });
    lastMessageAt = new Date().toISOString();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(sendResult),
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
