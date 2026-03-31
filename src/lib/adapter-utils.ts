import { BROKER_WAKE_DEBOUNCE_MS, DEFAULT_HISTORY_LIMIT, DEFAULT_MESSAGE_BATCH_SIZE, MAX_HISTORY_LIMIT, MAX_MESSAGE_BATCH_SIZE } from './constants.js';
import type { AgentKind, WakeMethod } from './broker-types.js';
import type { BridgeMessage } from './types.js';
import { muxSendKeys } from './platform.js';

const wakeTimestamps = new Map<string, number>();

export function normalizeBatchSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MESSAGE_BATCH_SIZE;
  return Math.min(MAX_MESSAGE_BATCH_SIZE, Math.floor(parsed));
}

export function normalizeHistoryLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.floor(parsed));
}

export function normalizeWaitMs(value: unknown, defaultMs = 30_000, maxMs = 30_000): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMs;
  return Math.min(maxMs, Math.floor(parsed));
}

export function collectRequiredAttachmentPaths(messages: Array<Pick<BridgeMessage, 'attachments'>>): string[] {
  return messages.flatMap((message) =>
    (message.attachments ?? [])
      .filter((attachment) => attachment.required)
      .map((attachment) => attachment.path),
  );
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

export async function sendWakeup(
  conversationId: string,
  recipientKind: AgentKind,
  wakeMethod: WakeMethod | undefined,
  wakeTarget: string | undefined,
  text: string,
): Promise<boolean> {
  if (!wakeTarget || !wakeMethod || wakeMethod === 'none') return false;

  const key = `${conversationId}:${recipientKind}`;
  const now = Date.now();
  const lastWake = wakeTimestamps.get(key) ?? 0;
  if (now - lastWake < BROKER_WAKE_DEBOUNCE_MS) {
    return false;
  }

  let sent = false;
  if (wakeMethod === 'mux_send_keys') {
    sent = await muxSendKeys(wakeTarget, text);
  } else if (wakeMethod === 'http_post') {
    if (!isLoopbackHttpUrl(wakeTarget)) {
      process.stderr.write(`[harness] Refusing non-loopback wake target: ${wakeTarget}\n`);
      return false;
    }
    try {
      const response = await fetch(wakeTarget, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text }),
      });
      sent = response.ok;
    } catch (error) {
      process.stderr.write(`[harness] http_post wake failed: ${error}\n`);
      sent = false;
    }
  }

  if (sent) {
    wakeTimestamps.set(key, now);
  }
  return sent;
}
