import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { BROKER_LOG_FILE, BROKER_RUNTIME_FILE, MAX_WAIT_TIMEOUT_MS, PAYLOADS_DIR, RUNTIME_DIR } from '../lib/constants.js';
import type { AgentKind, BrokerHealthResponse, BrokerRuntimeManifest } from '../lib/broker-types.js';
import type { MessageAttachment } from '../lib/types.js';
import { createBrokerStore } from './db.js';

function nowIso(): string {
  return new Date().toISOString();
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function writeBrokerLog(line: string): void {
  try {
    appendFileSync(BROKER_LOG_FILE, `[${nowIso()}] ${line}\n`, 'utf-8');
  } catch {}
}

async function parseRequestJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

// Long-poll waiter map
const waiterMap = new Map<string, Set<() => void>>();

function waiterKey(conversationId: string, recipientKind: AgentKind): string {
  return `${conversationId}:${recipientKind}`;
}

export function wakeWaiters(conversationId: string, recipientKind?: AgentKind): void {
  const kinds: AgentKind[] = recipientKind ? [recipientKind] : ['claude', 'codex'];
  for (const kind of kinds) {
    const key = waiterKey(conversationId, kind);
    const waiters = waiterMap.get(key);
    if (waiters && waiters.size > 0) {
      waiterMap.delete(key);
      for (const resolve of Array.from(waiters)) resolve();
    }
  }
}

function registerWaiter(
  conversationId: string,
  recipientKind: AgentKind,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const key = waiterKey(conversationId, recipientKind);
  let waiters = waiterMap.get(key);
  if (!waiters) {
    waiters = new Set();
    waiterMap.set(key, waiters);
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      waiters!.delete(doResolve);
      if (waiters!.size === 0) {
        waiterMap.delete(key);
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const doResolve = settle;
    waiters!.add(doResolve);

    timer = setTimeout(settle, waitMs);
    if (signal) {
      abortHandler = () => {
        settle();
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

export async function startBrokerServer(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(PAYLOADS_DIR, { recursive: true });
  mkdirSync(dirname(BROKER_LOG_FILE), { recursive: true });

  const store = createBrokerStore();
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const startedAt = nowIso();
  const startTime = Date.now();
  let port = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 30,
    fetch: async (request, server) => {
      try {
        if (request.headers.get('X-Bridge-Token') !== token) {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }

        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/health') {
          const stats = store.getBrokerStats();
          const payload: BrokerHealthResponse & typeof stats = {
            pid: process.pid,
            port,
            started_at: startedAt,
            uptime_ms: Date.now() - startTime,
            backend: 'broker',
            ...stats,
          };
          return jsonResponse(payload);
        }

        if (request.method === 'POST' && url.pathname === '/register-peer') {
          const body = await parseRequestJson<{
            agent_kind: AgentKind;
            workspace_root: string;
            slot: string;
            cwd: string;
            git_root?: string;
            pid: number;
            pane_target?: string;
            wake_method: 'none' | 'mux_send_keys' | 'http_post';
            capabilities: Record<string, boolean>;
          }>(request);
          return jsonResponse(store.registerPeer(body));
        }

        if (request.method === 'POST' && url.pathname === '/heartbeat') {
          const body = await parseRequestJson<{ peer_id: string }>(request);
          return jsonResponse(store.heartbeat(body.peer_id));
        }

        if (request.method === 'POST' && url.pathname === '/resolve-conversation') {
          const body = await parseRequestJson<{ workspace_root: string; slot: string }>(request);
          return jsonResponse(store.resolveConversation(body.workspace_root, body.slot));
        }

        if (request.method === 'POST' && url.pathname === '/poll-inbox') {
          const body = await parseRequestJson<{
            conversation_id: string;
            recipient_kind: AgentKind;
            limit: number;
            wait_ms?: number;
          }>(request);

          const result = store.pollInbox(body.conversation_id, body.recipient_kind, body.limit);
          const waitMs = typeof body.wait_ms === 'number'
            ? Math.min(Math.max(body.wait_ms, 0), MAX_WAIT_TIMEOUT_MS)
            : 0;

          if (waitMs > 0 && result.messages.length === 0) {
            server.timeout(request, Math.ceil(waitMs / 1000) + 5);
            await registerWaiter(body.conversation_id, body.recipient_kind, waitMs, request.signal);
            const freshResult = store.pollInbox(body.conversation_id, body.recipient_kind, body.limit);
            return jsonResponse(freshResult);
          }

          return jsonResponse(result);
        }

        if (request.method === 'POST' && url.pathname === '/ack-inbox') {
          const body = await parseRequestJson<{
            conversation_id: string;
            recipient_kind: AgentKind;
            ack_seq: number;
          }>(request);
          store.ackInbox(body.conversation_id, body.recipient_kind, body.ack_seq);
          return jsonResponse({ ok: true });
        }

        if (request.method === 'POST' && url.pathname === '/get-receipt-state') {
          const body = await parseRequestJson<{
            conversation_id: string;
            recipient_kind: AgentKind;
          }>(request);
          return jsonResponse(store.getReceiptState(body.conversation_id, body.recipient_kind));
        }

        if (request.method === 'POST' && url.pathname === '/mark-auto-reply-handled') {
          const body = await parseRequestJson<{
            conversation_id: string;
            recipient_kind: AgentKind;
            handled_seq: number;
          }>(request);
          return jsonResponse(store.markAutoReplyHandled(body.conversation_id, body.recipient_kind, body.handled_seq));
        }

        if (request.method === 'POST' && url.pathname === '/enqueue-message') {
          const body = await parseRequestJson<{
            conversation_id: string;
            message_id: string;
            sender_peer_id: string;
            sender_kind: AgentKind;
            recipient_kind: AgentKind;
            content: string;
            attachments?: MessageAttachment[];
            automation_handled_seq?: number;
          }>(request);
          const enqueueResult = store.enqueueMessage(body);
          wakeWaiters(body.conversation_id, body.recipient_kind);
          return jsonResponse(enqueueResult);
        }

        if (request.method === 'POST' && url.pathname === '/get-history') {
          const body = await parseRequestJson<{
            conversation_id: string;
            limit: number;
          }>(request);
          return jsonResponse(store.getHistory(body.conversation_id, body.limit));
        }

        if (request.method === 'POST' && url.pathname === '/reset-conversation') {
          const body = await parseRequestJson<{ workspace_root: string; slot: string }>(request);
          const oldConversation = store.resolveConversation(body.workspace_root, body.slot);
          const oldConversationId = oldConversation.conversation_id;
          const resetResult = store.resetConversation(body.workspace_root, body.slot);
          wakeWaiters(oldConversationId);
          return jsonResponse(resetResult);
        }

        if (request.method === 'POST' && url.pathname === '/inspect-workspace') {
          const body = await parseRequestJson<{
            workspace_root: string;
            slot?: string;
            include_archived?: boolean;
            include_messages?: boolean;
            message_limit?: number;
          }>(request);
          return jsonResponse(store.inspectWorkspace(body.workspace_root, {
            slot: body.slot,
            include_archived: body.include_archived,
            include_messages: body.include_messages,
            message_limit: body.message_limit,
          }));
        }

        return jsonResponse({ error: 'Not found' }, 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeBrokerLog(`request error: ${message}`);
        return jsonResponse({ error: message }, 500);
      }
    },
  });

  if (typeof server.port !== 'number') throw new Error('Broker failed to bind to a port.');
  port = server.port;

  const manifest: BrokerRuntimeManifest = {
    pid: process.pid,
    port,
    token,
    version: '2',
    started_at: startedAt,
  };

  writeFileSync(BROKER_RUNTIME_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
  writeBrokerLog(`broker started on 127.0.0.1:${port}`);

  const shutdown = () => {
    try {
      const existing = existsSync(BROKER_RUNTIME_FILE)
        ? JSON.parse(readFileSync(BROKER_RUNTIME_FILE, 'utf-8')) as BrokerRuntimeManifest
        : null;
      if (existing?.pid === process.pid) rmSync(BROKER_RUNTIME_FILE, { force: true });
    } catch {}
    try { server.stop(true); } catch {}
    try { store.close(); } catch {}
    writeBrokerLog('broker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
