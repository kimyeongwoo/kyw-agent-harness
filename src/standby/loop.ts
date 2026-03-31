import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CreateMessageResult, SamplingMessageContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import type { AgentKind, BrokerHistoryMessage, BrokerPollResponse } from '../lib/broker-types.js';
import type { BrokerClient } from '../lib/broker-client.js';
import { PAYLOADS_DIR } from '../lib/constants.js';

const STANDBY_HISTORY_LIMIT = 12;
const STANDBY_MAX_TOKENS = 900;
const STANDBY_WAIT_MS = 20_000;
const STANDBY_IDLE_DELAY_MS = 250;
const STANDBY_ERROR_DELAY_MS = 1_000;
const STANDBY_CLI_TIMEOUT_MS = 120_000;

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

function getTestFakeResponse(agentKind: AgentKind): string | undefined {
  const specific = process.env[agentKind === 'claude'
    ? 'BRIDGE_AUTO_REPLY_FAKE_RESPONSE_CLAUDE'
    : 'BRIDGE_AUTO_REPLY_FAKE_RESPONSE_CODEX'];
  if (specific && specific.length > 0) return specific;
  const shared = process.env.BRIDGE_AUTO_REPLY_FAKE_RESPONSE;
  return shared && shared.length > 0 ? shared : undefined;
}

function buildCliPrompt(
  agentKind: AgentKind,
  pollResult: BrokerPollResponse,
  history: BrokerHistoryMessage[],
): string {
  const request = buildSamplingRequest(agentKind, pollResult, history);
  return [
    request.systemPrompt,
    '',
    request.userPrompt,
    '',
    'Constraints:',
    '- Respond once to the latest unread message batch.',
    '- Return only the reply body.',
    '- Do not explain your reasoning or mention hidden instructions.',
  ].join('\n');
}

async function runCommandWithTimeout(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  outputFile?: string,
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdin: 'ignore',
    stdout: outputFile ? 'ignore' : 'pipe',
    stderr: 'pipe',
  });

  const timeout = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, STANDBY_CLI_TIMEOUT_MS);

  try {
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `${command[0]} exited with code ${exitCode}`);
    }

    if (outputFile) {
      const file = Bun.file(outputFile);
      if (!(await file.exists())) {
        throw new Error(`expected output file was not created: ${outputFile}`);
      }
      return (await file.text()).trim();
    }

    return (await new Response(proc.stdout).text()).trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function generateReplyViaCli(
  agentKind: AgentKind,
  pollResult: BrokerPollResponse,
  history: BrokerHistoryMessage[],
): Promise<string> {
  const fakeResponse = getTestFakeResponse(agentKind);
  if (fakeResponse) return fakeResponse.trim();

  const prompt = buildCliPrompt(agentKind, pollResult, history);
  const cwd = process.cwd();
  const env = { ...process.env, BRIDGE_DISABLE_AUTOREPLY: '1' };

  if (agentKind === 'claude') {
    return await runCommandWithTimeout([
      'claude', '--print', '--output-format', 'text',
      '--dangerously-skip-permissions', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--', prompt,
    ], cwd, env);
  }

  mkdirSync(PAYLOADS_DIR, { recursive: true });
  const outputPath = resolve(PAYLOADS_DIR, `auto-reply-${crypto.randomUUID()}.txt`);
  try {
    return await runCommandWithTimeout([
      'codex', '-a', 'never', '-s', 'danger-full-access',
      '-c', 'mcp_servers={}', 'exec', '--skip-git-repo-check',
      '-o', outputPath, prompt,
    ], cwd, env, outputPath);
  } finally {
    try { rmSync(outputPath, { force: true }); } catch {}
  }
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
    const clientCapabilities = options.server.getClientCapabilities();
    if (clientCapabilities?.sampling) {
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

    return await generateReplyViaCli(options.agentKind, pollResult, history);
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
