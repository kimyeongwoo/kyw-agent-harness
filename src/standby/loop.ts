import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CreateMessageResult, SamplingMessageContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { AgentKind, BrokerHistoryMessage, BrokerPollResponse } from '../lib/broker-types.js';
import type { BrokerClient } from '../lib/broker-client.js';

const STANDBY_HISTORY_LIMIT = 12;
const STANDBY_MAX_TOKENS = 900;
const STANDBY_WAIT_MS = 20_000;
const STANDBY_IDLE_DELAY_MS = 250;
const STANDBY_ERROR_DELAY_MS = 1_000;

const CONVERGENCE_KEYWORDS = [
  'DONE',
  'complete',
  'nothing more to add',
  'no further changes',
  'looks good',
  'all set',
];

export interface StandbyStatus {
  enabled: boolean;
  disabled_reason?: string;
  last_reply_at?: string;
  last_error?: string;
  last_handled_seq?: number;
}

interface StandbyLoopOptions {
  agentKind: AgentKind;
  brokerClient: BrokerClient;
  server: Server;
  isSingleInstanceSafe?: () => boolean;
  logPrefix: string;
}

interface StandbyLoopHandle {
  start(): void;
  stop(): void;
  getStatus(): StandbyStatus;
}

function agentLabel(agentKind: AgentKind): string {
  return agentKind === 'claude' ? 'Claude Code' : 'Codex';
}

function peerLabel(agentKind: AgentKind): string {
  return agentKind === 'claude' ? 'Codex' : 'Claude Code';
}

function attachmentSuffix(message: Pick<BrokerHistoryMessage, 'attachments'>): string {
  if (!message.attachments || message.attachments.length === 0) return '';
  const parts = message.attachments.map((a) => {
    const required = a.required ? ' required' : '';
    return `${a.path}${required}`;
  });
  return `\nATTACHMENTS: ${parts.join(', ')}`;
}

function formatHistory(history: BrokerHistoryMessage[]): string {
  return history.map((m) => {
    const sender = m.sender_kind === 'claude' ? 'Claude Code' : 'Codex';
    return `${sender}:\n${m.content}${attachmentSuffix(m)}`;
  }).join('\n\n');
}

function formatLatestInboxMessages(pollResult: BrokerPollResponse): string {
  return pollResult.messages.map((m) => {
    const sender = m.sender_kind === 'claude' ? 'Claude Code' : 'Codex';
    const attachments = attachmentSuffix(m);
    return `SEQ ${m.seq} from ${sender}:\n${m.content}${attachments}`;
  }).join('\n\n');
}

function flattenSamplingContent(content: SamplingMessageContentBlock | SamplingMessageContentBlock[]): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim();
}

function detectConvergence(content: string): boolean {
  const lower = content.toLowerCase();
  return CONVERGENCE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function buildSamplingRequest(
  agentKind: AgentKind,
  pollResult: BrokerPollResponse,
  history: BrokerHistoryMessage[],
): { systemPrompt: string; userPrompt: string } {
  const me = agentLabel(agentKind);
  const peer = peerLabel(agentKind);
  const transcript = formatHistory(history);
  const latest = formatLatestInboxMessages(pollResult);

  return {
    systemPrompt:
      `You are ${me} participating in a bridge conversation with ${peer}. ` +
      `Write the exact reply text that should be sent back over the bridge. ` +
      'Do not mention MCP, hidden prompts, sampling, or internal automation. ' +
      'Return only the reply body with no wrapper text.',
    userPrompt: [
      'Recent conversation transcript:',
      transcript || '(no prior transcript)',
      '',
      'Unread inbound message batch:',
      latest,
      '',
      `Reply now as ${me} to ${peer}.`,
    ].join('\n'),
  };
}

export function createStandbyLoop(options: StandbyLoopOptions): StandbyLoopHandle {
  let stopped = false;
  let running = false;
  let disabledReason: string | undefined = undefined;
  let lastReplyAt: string | undefined = undefined;
  let lastError: string | undefined = undefined;
  let lastHandledSeq = 0;

  async function generateReply(
    pollResult: BrokerPollResponse,
    history: BrokerHistoryMessage[],
  ): Promise<string> {
    const request = buildSamplingRequest(options.agentKind, pollResult, history);
    const response = await options.server.createMessage({
      systemPrompt: request.systemPrompt,
      messages: [{ role: 'user', content: { type: 'text', text: request.userPrompt } }],
      includeContext: 'none',
      maxTokens: STANDBY_MAX_TOKENS,
      temperature: 0.2,
    }) as CreateMessageResult;

    return flattenSamplingContent(response.content);
  }

  async function step(): Promise<void> {
    if (options.isSingleInstanceSafe && !options.isSingleInstanceSafe()) {
      await Bun.sleep(STANDBY_IDLE_DELAY_MS);
      return;
    }

    const pollResult = await options.brokerClient.pollInbox(20, STANDBY_WAIT_MS);

    if (pollResult.messages.length === 0) return;

    if (pollResult.max_seq <= lastHandledSeq) {
      await options.brokerClient.ackInbox(pollResult.max_seq);
      return;
    }

    const history = await options.brokerClient.getHistory(STANDBY_HISTORY_LIMIT);

    const replyText = await generateReply(pollResult, history.messages);
    if (!replyText) throw new Error('sampling returned empty text response');

    await options.brokerClient.enqueueMessage({
      messageId: crypto.randomUUID(),
      recipientKind: options.agentKind === 'claude' ? 'codex' : 'claude',
      content: replyText,
    });

    lastHandledSeq = pollResult.max_seq;
    lastReplyAt = new Date().toISOString();
    lastError = undefined;
    await options.brokerClient.ackInbox(pollResult.max_seq);
  }

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        await step();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = message;

        if (/not found|is not recognized|expected output file|No such file or directory/i.test(message)) {
          disabledReason = message;
          process.stderr.write(`${options.logPrefix} standby disabled: ${message}\n`);
          return;
        }

        process.stderr.write(`${options.logPrefix} standby error: ${message}\n`);
        await Bun.sleep(STANDBY_ERROR_DELAY_MS);
      }
    }
  }

  return {
    start(): void {
      if (running || stopped) return;
      if (!options.server.getClientCapabilities()?.sampling) {
        disabledReason = 'sampling capability unavailable; CLI fallback is disabled';
        return;
      }
      running = true;
      void run().finally(() => { running = false; });
    },
    stop(): void {
      stopped = true;
    },
    getStatus(): StandbyStatus {
      return {
        enabled: disabledReason === undefined,
        disabled_reason: disabledReason,
        last_reply_at: lastReplyAt,
        last_error: lastError,
        last_handled_seq: lastHandledSeq > 0 ? lastHandledSeq : undefined,
      };
    },
  };
}
