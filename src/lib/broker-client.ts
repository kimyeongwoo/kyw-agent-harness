import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  BROKER_LOCK_FILE,
  BROKER_RUNTIME_FILE,
  RUNTIME_DIR,
  BRIDGE_SLOT_ENV,
  DEFAULT_BRIDGE_SLOT,
  MAX_WAIT_TIMEOUT_MS,
  WORKSPACE_ROOT,
} from './constants.js';
import { detectMuxCommand, discoverMuxPaneTarget, validatePaneTarget } from './platform.js';
import type {
  AgentKind,
  BrokerEnqueueResponse,
  BrokerHealthResponse,
  BrokerHistoryResponse,
  BrokerPeerSession,
  BrokerPollResponse,
  BrokerReceiptState,
  BrokerResetResponse,
  BrokerRuntimeManifest,
  BrokerWorkspaceInspection,
  BrokerWorkspaceInspectionOptions,
  WakeMethod,
} from './broker-types.js';
import type { MessageAttachment } from './types.js';
import { isProcessAlive } from './process-utils.js';
import { detectGitRoot } from './workspace.js';

const SESSION_LOCK_TIMEOUT_MS = 2000;
const SESSION_LOCK_RETRY_MS = 10;
const SESSION_LOCK_STALE_MS = 10000;

interface LockInfo {
  pid: number;
  timestamp: number;
}

function runtimePathForWorkspace(workspaceRoot: string): string {
  return resolve(workspaceRoot, '.bridge', 'runtime', 'broker.json');
}

function getBrokerBaseUrl(manifest: BrokerRuntimeManifest): string {
  return `http://127.0.0.1:${manifest.port}`;
}

export function getBridgeSlot(): string {
  const rawValue = process.env[BRIDGE_SLOT_ENV]?.trim();
  return rawValue && rawValue.length > 0 ? rawValue : DEFAULT_BRIDGE_SLOT;
}

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export function getGitRoot(): string | undefined {
  return detectGitRoot(process.cwd());
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

export function resolveWakeMethod(target?: string): WakeMethod {
  if (!target) return 'none';
  if (isLoopbackHttpUrl(target)) return 'http_post';
  return validatePaneTarget(target) ? 'mux_send_keys' : 'none';
}

interface BrokerClientOptions {
  wakeTarget?: string;
}

class BrokerHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerHttpError';
  }
}

function isBrokerHttpError(error: unknown): error is BrokerHttpError {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'BrokerHttpError';
}

function getBrokerDaemonCandidates(): string[] {
  return [
    resolve(import.meta.dir, '..', 'broker', 'daemon.ts'),
    resolve(import.meta.dir, '..', 'src', 'broker', 'daemon.ts'),
  ];
}

function resolveBrokerDaemonPath(): string {
  const match = getBrokerDaemonCandidates().find((candidate) => existsSync(candidate));
  if (!match) throw new Error('Broker daemon script not found.');
  return match;
}

function readRuntimeManifestAt(runtimePath: string): BrokerRuntimeManifest | null {
  if (!existsSync(runtimePath)) return null;
  try {
    const text = readFileSync(runtimePath, 'utf-8');
    if (!text.trim()) return null;
    return JSON.parse(text) as BrokerRuntimeManifest;
  } catch {
    return null;
  }
}

function readRuntimeManifest(): BrokerRuntimeManifest | null {
  return readRuntimeManifestAt(BROKER_RUNTIME_FILE);
}

function buildLiveBrokerConflictError(manifest: Pick<BrokerRuntimeManifest, 'pid' | 'port'>): Error {
  return new Error(
    `Broker runtime manifest points to a live but unverified process ` +
    `(pid=${manifest.pid}, port=${manifest.port}). Refusing to replace it automatically.`,
  );
}

function isLockStale(): boolean {
  if (!existsSync(BROKER_LOCK_FILE)) return true;
  try {
    const info = JSON.parse(readFileSync(BROKER_LOCK_FILE, 'utf-8')) as LockInfo;
    if (Date.now() - info.timestamp > SESSION_LOCK_STALE_MS) return true;
    return !isProcessAlive(info.pid);
  } catch {
    return true;
  }
}

function acquireLock(): boolean {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  try {
    const fd = openSync(BROKER_LOCK_FILE, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() } satisfies LockInfo));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function releaseLock(): void {
  try { unlinkSync(BROKER_LOCK_FILE); } catch {}
}

async function withBrokerLaunchLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + SESSION_LOCK_TIMEOUT_MS;
  let staleRecovered = false;

  while (Date.now() < deadline) {
    if (acquireLock()) {
      try {
        return await fn();
      } finally {
        releaseLock();
      }
    }

    if (!staleRecovered && isLockStale()) {
      releaseLock();
      staleRecovered = true;
      continue;
    }

    await Bun.sleep(SESSION_LOCK_RETRY_MS);
  }

  throw new Error('Timed out waiting for broker launch lock.');
}

async function pingBroker(manifest: BrokerRuntimeManifest): Promise<BrokerHealthResponse | null> {
  try {
    const response = await fetch(`${getBrokerBaseUrl(manifest)}/health`, {
      headers: { 'X-Bridge-Token': manifest.token },
    });
    if (!response.ok) return null;
    return await response.json() as BrokerHealthResponse;
  } catch {
    return null;
  }
}

async function pingVerifiedBroker(manifest: BrokerRuntimeManifest): Promise<BrokerHealthResponse | null> {
  const health = await pingBroker(manifest);
  if (!health) return null;
  if (health.backend !== 'broker') return null;
  if (health.pid !== manifest.pid) return null;
  if (health.port !== manifest.port) return null;
  return health;
}

async function classifyRuntimeManifest(
  manifest: BrokerRuntimeManifest,
): Promise<'healthy' | 'dead' | 'live-unverified'> {
  const health = await pingVerifiedBroker(manifest);
  if (health) return 'healthy';
  return isProcessAlive(manifest.pid) ? 'live-unverified' : 'dead';
}

export function readBrokerRuntimeManifestForWorkspace(workspaceRoot: string): BrokerRuntimeManifest | null {
  return readRuntimeManifestAt(runtimePathForWorkspace(workspaceRoot));
}

export async function readBrokerHealthForWorkspace(workspaceRoot: string): Promise<BrokerHealthResponse | null> {
  const manifest = readBrokerRuntimeManifestForWorkspace(workspaceRoot);
  if (!manifest) return null;
  return await pingBroker(manifest);
}

export async function stopBrokerForWorkspace(
  workspaceRoot: string,
  options: { forceAfterMs?: number } = {},
): Promise<boolean> {
  const manifestPath = runtimePathForWorkspace(workspaceRoot);
  const manifest = readRuntimeManifestAt(manifestPath);
  if (!manifest) return false;
  const verifiedBroker = await pingVerifiedBroker(manifest);
  if (!verifiedBroker) {
    if (!isProcessAlive(manifest.pid)) {
      try { rmSync(manifestPath, { force: true }); } catch {}
      return true;
    }
    return false;
  }

  const deadline = Date.now() + (options.forceAfterMs ?? 3_000);
  try {
    process.kill(manifest.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      try { rmSync(manifestPath, { force: true }); } catch {}
      return true;
    }
  }

  while (Date.now() < deadline) {
    if (!isProcessAlive(manifest.pid)) {
      try { rmSync(manifestPath, { force: true }); } catch {}
      return true;
    }
    await Bun.sleep(50);
  }

  try { process.kill(manifest.pid, 'SIGKILL'); } catch {}
  await Bun.sleep(100);
  if (!isProcessAlive(manifest.pid)) {
    try { rmSync(manifestPath, { force: true }); } catch {}
    return true;
  }
  return false;
}

async function waitForBrokerManifest(timeoutMs = 5_000): Promise<BrokerRuntimeManifest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const manifest = readRuntimeManifest();
    if (manifest) {
      const health = await pingBroker(manifest);
      if (health) return manifest;
    }
    await Bun.sleep(50);
  }
  throw new Error('Broker did not become healthy in time.');
}

async function spawnBrokerProcess(): Promise<void> {
  const daemonPath = resolveBrokerDaemonPath();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  Bun.spawn([process.execPath, daemonPath], {
    cwd: WORKSPACE_ROOT,
    env: process.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
}

export async function ensureBrokerRunning(): Promise<BrokerRuntimeManifest> {
  const manifest = readRuntimeManifest();
  if (manifest) {
    const state = await classifyRuntimeManifest(manifest);
    if (state === 'healthy') return manifest;
    if (state === 'live-unverified') throw buildLiveBrokerConflictError(manifest);
    try { rmSync(BROKER_RUNTIME_FILE, { force: true }); } catch {}
  }

  return withBrokerLaunchLock(async () => {
    const currentManifest = readRuntimeManifest();
    if (currentManifest) {
      const currentState = await classifyRuntimeManifest(currentManifest);
      if (currentState === 'healthy') return currentManifest;
      if (currentState === 'live-unverified') throw buildLiveBrokerConflictError(currentManifest);
      try { rmSync(BROKER_RUNTIME_FILE, { force: true }); } catch {}
    }

    await spawnBrokerProcess();
    return await waitForBrokerManifest();
  });
}

async function brokerRequest<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  const manifest = await ensureBrokerRunning();
  const headers = new Headers(init?.headers);
  headers.set('X-Bridge-Token', manifest.token);
  if (!headers.has('content-type') && init?.body) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  try {
    const response = await fetch(`${getBrokerBaseUrl(manifest)}${path}`, { ...init, headers });
    if (!response.ok) {
      const errorText = await response.text();
      throw new BrokerHttpError(path, response.status, `${path} failed (${response.status}): ${errorText}`);
    }
    return await response.json() as T;
  } catch (error) {
    if (isBrokerHttpError(error)) throw error;
    if (!retry) throw error;

    const currentManifest = readRuntimeManifest();
    if (currentManifest) {
      const currentState = await classifyRuntimeManifest(currentManifest);
      if (currentState === 'healthy') throw error;
      if (currentState === 'live-unverified') throw buildLiveBrokerConflictError(currentManifest);
    }

    try { rmSync(BROKER_RUNTIME_FILE, { force: true }); } catch {}
    return await brokerRequest<T>(path, init, false);
  }
}

export async function inspectBrokerWorkspace(
  workspaceRoot: string,
  options: BrokerWorkspaceInspectionOptions = {},
): Promise<BrokerWorkspaceInspection> {
  const manifest = readBrokerRuntimeManifestForWorkspace(workspaceRoot);
  if (!manifest) throw new Error(`Broker runtime manifest not found for workspace: ${workspaceRoot}`);

  const response = await fetch(`${getBrokerBaseUrl(manifest)}/inspect-workspace`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'X-Bridge-Token': manifest.token,
    },
    body: JSON.stringify({
      workspace_root: workspaceRoot,
      ...(options.slot ? { slot: options.slot } : {}),
      ...(options.include_archived ? { include_archived: true } : {}),
      ...(options.include_messages ? { include_messages: true } : {}),
      ...(options.message_limit ? { message_limit: options.message_limit } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`/inspect-workspace failed (${response.status}): ${errorText}`);
  }

  return await response.json() as BrokerWorkspaceInspection;
}

export class BrokerClient {
  private readonly slot = getBridgeSlot();
  private readonly workspaceRoot = getWorkspaceRoot();
  private readonly gitRoot = getGitRoot();
  private readonly configuredWakeTarget?: string;
  private peerSession: BrokerPeerSession | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private registrationPromise: Promise<BrokerPeerSession> | null = null;

  constructor(private readonly agentKind: AgentKind, options: BrokerClientOptions = {}) {
    this.configuredWakeTarget = options.wakeTarget;
  }

  async ensureRegistered(): Promise<BrokerPeerSession> {
    if (this.peerSession) {
      try {
        this.peerSession = await brokerRequest<BrokerPeerSession>('/heartbeat', {
          method: 'POST',
          body: JSON.stringify({ peer_id: this.peerSession.peer_id }),
        });
        return this.peerSession;
      } catch {}
    }

    if (this.registrationPromise) return await this.registrationPromise;

    this.registrationPromise = (async () => {
      const paneTarget = await this.resolvePaneTarget();
      const session = await brokerRequest<BrokerPeerSession>('/register-peer', {
        method: 'POST',
        body: JSON.stringify({
          agent_kind: this.agentKind,
          workspace_root: this.workspaceRoot,
          slot: this.slot,
          cwd: process.cwd(),
          git_root: this.gitRoot,
          pid: process.pid,
          pane_target: paneTarget,
          wake_method: resolveWakeMethod(paneTarget),
          capabilities: { attachments: true, history: true },
        }),
      });
      this.peerSession = session;
      return session;
    })();

    try {
      return await this.registrationPromise;
    } finally {
      this.registrationPromise = null;
    }
  }

  async pollInbox(limit: number, waitMs?: number): Promise<BrokerPollResponse> {
    const clampedWaitMs = typeof waitMs === 'number'
      ? Math.min(Math.max(waitMs, 0), MAX_WAIT_TIMEOUT_MS)
      : undefined;
    const session = await this.ensureRegistered();
    return await brokerRequest<BrokerPollResponse>('/poll-inbox', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: session.conversation_id,
        recipient_kind: this.agentKind,
        limit,
        ...(clampedWaitMs !== undefined && clampedWaitMs > 0 ? { wait_ms: clampedWaitMs } : {}),
      }),
    });
  }

  async ackInbox(ackSeq: number): Promise<void> {
    const session = await this.ensureRegistered();
    await brokerRequest<{ ok: true }>('/ack-inbox', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: session.conversation_id,
        recipient_kind: this.agentKind,
        ack_seq: ackSeq,
      }),
    });
  }

  async getReceiptState(): Promise<BrokerReceiptState> {
    const session = await this.ensureRegistered();
    return await brokerRequest<BrokerReceiptState>('/get-receipt-state', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: session.conversation_id,
        recipient_kind: this.agentKind,
      }),
    });
  }

  async markAutoReplyHandled(handledSeq: number): Promise<BrokerReceiptState> {
    const session = await this.ensureRegistered();
    return await brokerRequest<BrokerReceiptState>('/mark-auto-reply-handled', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: session.conversation_id,
        recipient_kind: this.agentKind,
        handled_seq: handledSeq,
      }),
    });
  }

  async enqueueMessage(options: {
    messageId: string;
    recipientKind: AgentKind;
    content: string;
    attachments?: MessageAttachment[];
    automationHandledSeq?: number;
  }): Promise<BrokerEnqueueResponse> {
    const session = await this.ensureRegistered();
    const response = await brokerRequest<BrokerEnqueueResponse>('/enqueue-message', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: session.conversation_id,
        message_id: options.messageId,
        sender_peer_id: session.peer_id,
        sender_kind: this.agentKind,
        recipient_kind: options.recipientKind,
        content: options.content,
        attachments: options.attachments,
        automation_handled_seq: options.automationHandledSeq,
      }),
    });
    session.conversation_id = response.conversation_id;
    return response;
  }

  async getHistory(limit: number): Promise<BrokerHistoryResponse> {
    const session = await this.ensureRegistered();
    return await brokerRequest<BrokerHistoryResponse>('/get-history', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: session.conversation_id,
        limit,
      }),
    });
  }

  async resetConversation(): Promise<BrokerResetResponse> {
    const response = await brokerRequest<BrokerResetResponse>('/reset-conversation', {
      method: 'POST',
      body: JSON.stringify({
        workspace_root: this.workspaceRoot,
        slot: this.slot,
      }),
    });
    if (this.peerSession) {
      this.peerSession.conversation_id = response.conversation_id;
    }
    return response;
  }

  async health(): Promise<{ peer: BrokerPeerSession | null; broker: BrokerHealthResponse | null }> {
    const peer = await this.ensureRegistered().catch(() => null);
    const manifest = readRuntimeManifest();
    const broker = manifest ? await pingBroker(manifest) : null;
    return { peer, broker };
  }

  getSlot(): string {
    return this.slot;
  }

  startHeartbeatLoop(intervalMs = 25_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.ensureRegistered().catch(() => {});
    }, intervalMs);
    this.heartbeatTimer.unref();
    this.ensureRegistered().catch(() => {});
    process.stderr.write(`[broker-client] Heartbeat loop started (interval=${intervalMs}ms)\n`);
  }

  stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async resolvePaneTarget(): Promise<string | undefined> {
    if (this.configuredWakeTarget) return this.configuredWakeTarget;
    const mux = detectMuxCommand();
    if (!mux) return undefined;
    return discoverMuxPaneTarget();
  }
}
