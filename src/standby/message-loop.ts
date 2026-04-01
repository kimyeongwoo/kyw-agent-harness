import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AgentKind, BrokerPollResponse } from '../lib/broker-types.js';
import type { BrokerClient } from '../lib/broker-client.js';

const MESSAGE_LOOP_WAIT_MS = 1_000;
const MESSAGE_LOOP_IDLE_DELAY_MS = 250;
const MESSAGE_LOOP_DUPLICATE_DELAY_MS = 1_000;
const MESSAGE_LOOP_ERROR_DELAY_MS = 1_000;
const MESSAGE_LOOP_STOP_TIMEOUT_MS = 2_500;

export interface MessageLoopStatus {
  running: boolean;
  last_error?: string;
  last_notified_seq?: number;
  last_notified_at?: string;
  notification_count: number;
}

interface MessageLoopOptions {
  agentKind: AgentKind;
  brokerClient: BrokerClient;
  server: Server;
  isSingleInstanceSafe?: () => boolean;
  logPrefix: string;
}

interface MessageLoopStopOptions {
  wait?: boolean;
  timeoutMs?: number;
}

interface MessageLoopHandle {
  start(): boolean;
  stop(options?: MessageLoopStopOptions): Promise<boolean>;
  getStatus(): MessageLoopStatus;
}

function peerLabel(agentKind: AgentKind): string {
  return agentKind === 'claude' ? 'Codex' : 'Claude Code';
}

function buildNotificationText(agentKind: AgentKind, pollResult: BrokerPollResponse): string {
  const count = pollResult.messages.length;
  const noun = count === 1 ? 'message' : 'messages';
  return `New bridge ${noun} from ${peerLabel(agentKind)}. Call check_messages to read and respond. Message loop remains active.`;
}

export function createMessageLoop(options: MessageLoopOptions): MessageLoopHandle {
  let running = false;
  let stopRequested = false;
  let lastError: string | undefined = undefined;
  let lastNotifiedSeq = 0;
  let lastNotifiedAt: string | undefined = undefined;
  let notificationCount = 0;
  let lastConversationId: string | undefined = undefined;
  let runPromise: Promise<void> | null = null;

  async function notify(pollResult: BrokerPollResponse): Promise<void> {
    const text = buildNotificationText(options.agentKind, pollResult);
    try {
      await options.server.sendLoggingMessage({ level: 'info', data: text });
    } catch {}
    process.stderr.write(`${options.logPrefix} ${text}\n`);
  }

  async function step(): Promise<void> {
    if (options.isSingleInstanceSafe && !options.isSingleInstanceSafe()) {
      await Bun.sleep(MESSAGE_LOOP_IDLE_DELAY_MS);
      return;
    }

    const pollResult = await options.brokerClient.pollInbox(20, MESSAGE_LOOP_WAIT_MS);

    if (pollResult.conversation_id !== lastConversationId) {
      lastConversationId = pollResult.conversation_id;
      lastNotifiedSeq = 0;
    }

    if (pollResult.messages.length === 0) return;

    if (pollResult.max_seq <= lastNotifiedSeq) {
      await Bun.sleep(MESSAGE_LOOP_DUPLICATE_DELAY_MS);
      return;
    }

    lastNotifiedSeq = pollResult.max_seq;
    lastNotifiedAt = new Date().toISOString();
    notificationCount++;
    lastError = undefined;
    await notify(pollResult);
  }

  async function run(): Promise<void> {
    while (!stopRequested) {
      try {
        await step();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = message;
        process.stderr.write(`${options.logPrefix} message loop error: ${message}\n`);
        await Bun.sleep(MESSAGE_LOOP_ERROR_DELAY_MS);
      }
    }
  }

  return {
    start(): boolean {
      if (running) return false;
      stopRequested = false;
      running = true;
      runPromise = run().finally(() => {
        running = false;
        runPromise = null;
      });
      return true;
    },
    async stop(stopOptions?: MessageLoopStopOptions): Promise<boolean> {
      if (!running) return false;
      stopRequested = true;
      if (stopOptions?.wait && runPromise) {
        await Promise.race([
          runPromise.catch(() => undefined),
          Bun.sleep(stopOptions.timeoutMs ?? MESSAGE_LOOP_STOP_TIMEOUT_MS),
        ]);
      }
      return true;
    },
    getStatus(): MessageLoopStatus {
      return {
        running,
        last_error: lastError,
        last_notified_seq: lastNotifiedSeq > 0 ? lastNotifiedSeq : undefined,
        last_notified_at: lastNotifiedAt,
        notification_count: notificationCount,
      };
    },
  };
}
