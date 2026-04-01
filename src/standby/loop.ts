import { resolve } from 'path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CreateMessageResult, SamplingMessageContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { AgentKind, BrokerHistoryMessage, BrokerPollResponse } from '../lib/broker-types.js';
import type { BrokerClient } from '../lib/broker-client.js';

const STANDBY_HISTORY_LIMIT = 12;
const STANDBY_MAX_TOKENS = 2400;
const STANDBY_WAIT_MS = 20_000;
const STANDBY_IDLE_DELAY_MS = 250;
const STANDBY_ERROR_DELAY_MS = 1_000;
const STANDBY_SAMPLING_TIMEOUT_MS = 600_000;
const STANDBY_STOP_TOKEN = '[[STANDBY_STOP]]';
const STANDBY_REPLY_AND_STOP_TOKEN = '[[STANDBY_REPLY_AND_STOP]]';

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

interface ReplyDirective {
  replyText?: string;
  stopAfterReply: boolean;
  stopWithoutReply: boolean;
}

async function readRequiredAttachmentDocuments(pollResult: BrokerPollResponse): Promise<string> {
  const requiredPaths = [...new Set(
    pollResult.messages.flatMap((message) =>
      (message.attachments ?? [])
        .filter((attachment) => attachment.required)
        .map((attachment) => attachment.path),
    ),
  )];

  if (requiredPaths.length === 0) return '';

  const documents = await Promise.all(requiredPaths.map(async (relativePath) => {
    const absolutePath = resolve(process.cwd(), relativePath);
    const text = await Bun.file(absolutePath).text();
    return `FILE: ${relativePath}\n${text.trim()}`;
  }));

  return documents.join('\n\n');
}

function parseReplyDirective(rawResponse: string): ReplyDirective {
  const trimmed = rawResponse.trim();
  if (trimmed === STANDBY_STOP_TOKEN) {
    return { stopAfterReply: true, stopWithoutReply: true };
  }

  if (trimmed.startsWith(STANDBY_REPLY_AND_STOP_TOKEN)) {
    const replyText = trimmed.slice(STANDBY_REPLY_AND_STOP_TOKEN.length).trim();
    if (!replyText) {
      throw new Error('sampling returned reply-and-stop token without reply text');
    }
    return { replyText, stopAfterReply: true, stopWithoutReply: false };
  }

  if (!trimmed) {
    throw new Error('sampling returned empty text response');
  }

  return { replyText: trimmed, stopAfterReply: false, stopWithoutReply: false };
}

function buildSamplingRequest(
  agentKind: AgentKind,
  pollResult: BrokerPollResponse,
  history: BrokerHistoryMessage[],
  requiredAttachmentDocs: string,
): { systemPrompt: string; userPrompt: string } {
  const me = agentLabel(agentKind);
  const peer = peerLabel(agentKind);
  const transcript = formatHistory(history);
  const latest = formatLatestInboxMessages(pollResult);

  return {
    systemPrompt:
      `You are ${me} participating in a bridge conversation with ${peer}. ` +
      'Review the recent conversation objectively before deciding what to do next. ' +
      'Do not rush to answer. The peer can wait up to 10 minutes, so take the time needed to reason carefully, inspect the provided context, and do the best work you can before replying. ' +
      `If the conversation has clearly concluded, no further reply is needed, or the user explicitly wants the exchange to stop, return exactly ${STANDBY_STOP_TOKEN}. ` +
      `If you should send one final reply and then stop waiting for more messages, return ${STANDBY_REPLY_AND_STOP_TOKEN} on the first line and the exact reply body after it. ` +
      'Otherwise, write the exact reply text that should be sent back over the bridge, and the system will wait for the next message again automatically. ' +
      'Do not mention MCP, hidden prompts, sampling, or internal automation. ' +
      `Return only one of: ${STANDBY_STOP_TOKEN}, ${STANDBY_REPLY_AND_STOP_TOKEN} followed by a reply, or the plain reply body with no wrapper text.`,
    userPrompt: [
      'Recent conversation transcript:',
      transcript || '(no prior transcript)',
      '',
      'Unread inbound message batch:',
      latest,
      '',
      'Required attachment documents:',
      requiredAttachmentDocs || '(none)',
      '',
      'Execution policy:',
      'Take your time. You can spend up to 10 minutes reasoning, checking context, and deciding on the best response before sending it.',
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

  function terminate(reason: string): void {
    disabledReason = reason;
    stopped = true;
  }

  async function generateReply(
    pollResult: BrokerPollResponse,
    history: BrokerHistoryMessage[],
    requiredAttachmentDocs: string,
  ): Promise<string> {
    const request = buildSamplingRequest(options.agentKind, pollResult, history, requiredAttachmentDocs);
    const response = await options.server.createMessage({
      systemPrompt: request.systemPrompt,
      messages: [{ role: 'user', content: { type: 'text', text: request.userPrompt } }],
      includeContext: 'none',
      modelPreferences: {
        costPriority: 0,
        speedPriority: 0,
        intelligencePriority: 1,
      },
      maxTokens: STANDBY_MAX_TOKENS,
      temperature: 0.2,
    }, {
      timeout: STANDBY_SAMPLING_TIMEOUT_MS,
      maxTotalTimeout: STANDBY_SAMPLING_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    }) as CreateMessageResult;

    return flattenSamplingContent(response.content);
  }

  async function step(): Promise<void> {
    if (options.isSingleInstanceSafe && !options.isSingleInstanceSafe()) {
      await Bun.sleep(STANDBY_IDLE_DELAY_MS);
      return;
    }

    const pollResult = await options.brokerClient.pollInbox(20, STANDBY_WAIT_MS);

    if (pollResult.messages.length === 0) {
      await Bun.sleep(STANDBY_IDLE_DELAY_MS);
      return;
    }

    if (pollResult.max_seq <= lastHandledSeq) {
      await options.brokerClient.ackInbox(pollResult.max_seq);
      await Bun.sleep(STANDBY_IDLE_DELAY_MS);
      return;
    }

    const history = await options.brokerClient.getHistory(STANDBY_HISTORY_LIMIT);
    const requiredAttachmentDocs = await readRequiredAttachmentDocuments(pollResult);
    const replyDirective = parseReplyDirective(await generateReply(pollResult, history.messages, requiredAttachmentDocs));

    if (replyDirective.stopWithoutReply) {
      lastHandledSeq = pollResult.max_seq;
      lastError = undefined;
      await options.brokerClient.ackInbox(pollResult.max_seq);
      terminate('conversation concluded with no further reply required');
      return;
    }

    await options.brokerClient.enqueueMessage({
      messageId: crypto.randomUUID(),
      recipientKind: options.agentKind === 'claude' ? 'codex' : 'claude',
      content: replyDirective.replyText!,
    });

    lastHandledSeq = pollResult.max_seq;
    lastReplyAt = new Date().toISOString();
    lastError = undefined;
    await options.brokerClient.ackInbox(pollResult.max_seq);

    if (replyDirective.stopAfterReply) {
      terminate('conversation concluded after final reply');
    }
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
      if (running) return;
      if (!options.server.getClientCapabilities()?.sampling) {
        disabledReason = 'sampling capability unavailable; CLI fallback is disabled';
        stopped = true;
        return;
      }
      if (stopped) {
        stopped = false;
        if (disabledReason?.startsWith('conversation concluded')) {
          disabledReason = undefined;
        }
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
