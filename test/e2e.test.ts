import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { stopBrokerForWorkspace } from '../src/lib/broker-client.js';

const TEST_WORKSPACE = resolve(import.meta.dir, '.test-workspace-e2e');
const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const CLAUDE_MCP = resolve(PACKAGE_ROOT, 'src', 'mcp', 'claude-server.ts');
const CODEX_MCP = resolve(PACKAGE_ROOT, 'src', 'mcp', 'codex-server.ts');
const TEST_RUN_ID = Date.now().toString(36);

function slot(name: string): string {
  return `${name}-${TEST_RUN_ID}`;
}

interface McpProcess {
  proc: ReturnType<typeof Bun.spawn>;
  pendingResponses: Map<number, (result: unknown) => void>;
  nextId: number;
  stdoutReader: Promise<void>;
}

function spawnMcpAt(script: string, cwd: string, env: Record<string, string> = {}): McpProcess {
  const proc = Bun.spawn(['bun', script], {
    cwd,
    env: {
      ...process.env,
      BRIDGE_DISABLE_AUTOREPLY: '1',
      BRIDGE_WORKSPACE_ROOT: TEST_WORKSPACE,
      BRIDGE_SLOT: 'e2e-test',
      ...env,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const pendingResponses = new Map<number, (result: unknown) => void>();
  // Background stdout reader
  const stdoutReader = (async () => {
    let buffer = '';
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.id === 'number' && pendingResponses.has(parsed.id)) {
            pendingResponses.get(parsed.id)!(parsed.result);
            pendingResponses.delete(parsed.id);
          }
        } catch {}
      }
    }
  })();

  return { proc, pendingResponses, nextId: 1, stdoutReader };
}

function spawnMcp(script: string, env: Record<string, string> = {}): McpProcess {
  return spawnMcpAt(script, TEST_WORKSPACE, env);
}

function writeToStdin(mcp: McpProcess, text: string): void {
  (mcp.proc.stdin as any).write(text);
  (mcp.proc.stdin as any).flush();
}

async function sendRequest(mcp: McpProcess, method: string, params: unknown = {}): Promise<unknown> {
  const id = mcp.nextId++;
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  const resultPromise = new Promise<unknown>((resolve, reject) => {
    mcp.pendingResponses.set(id, resolve);
    setTimeout(() => {
      if (mcp.pendingResponses.has(id)) {
        mcp.pendingResponses.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 10000);
  });

  writeToStdin(mcp, request + '\n');
  return await resultPromise;
}

async function initializeMcp(mcp: McpProcess): Promise<void> {
  await sendRequest(mcp, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  const notif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  writeToStdin(mcp, notif + '\n');
  await Bun.sleep(100); // Let the server process the notification
}

async function callTool(mcp: McpProcess, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await sendRequest(mcp, 'tools/call', { name, arguments: args }) as { content: Array<{ text: string }> };
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function killMcp(mcp: McpProcess): void {
  try { mcp.proc.kill(); } catch {}
}

beforeEach(() => {
  try { rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  mkdirSync(TEST_WORKSPACE, { recursive: true });
});

afterEach(async () => {
  await stopBrokerForWorkspace(TEST_WORKSPACE).catch(() => false);
  try { rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

describe('E2E: Claude ↔ Codex via broker', () => {
  it('full roundtrip: Claude sends → Codex receives → Codex sends → Claude receives', async () => {
    const claude = spawnMcp(CLAUDE_MCP, { BRIDGE_SLOT: slot('e2e-roundtrip') });
    const codex = spawnMcp(CODEX_MCP, { BRIDGE_SLOT: slot('e2e-roundtrip') });

    try {
      await initializeMcp(claude);
      await initializeMcp(codex);

      // Claude sends a message
      const sendResult = await callTool(claude, 'send_message', { text: 'Hello from Claude' }) as { sent: boolean; message_id: string };
      expect(sendResult.sent).toBe(true);
      expect(sendResult.message_id).toBeTruthy();

      // Codex checks messages
      const checkResult = await callTool(codex, 'check_messages') as { has_new: boolean; messages: Array<{ content: string }> };
      expect(checkResult.has_new).toBe(true);
      expect(checkResult.messages).toHaveLength(1);
      expect(checkResult.messages[0].content).toBe('Hello from Claude');

      // Codex sends a response
      const codexSend = await callTool(codex, 'send_message', { text: 'Hello from Codex' }) as { sent: boolean; message_id: string };
      expect(codexSend.sent).toBe(true);

      // Claude checks messages
      const claudeCheck = await callTool(claude, 'check_messages') as { has_new: boolean; messages: Array<{ content: string }> };
      expect(claudeCheck.has_new).toBe(true);
      expect(claudeCheck.messages).toHaveLength(1);
      expect(claudeCheck.messages[0].content).toBe('Hello from Codex');

    } finally {
      killMcp(claude);
      killMcp(codex);
    }
  }, 15000);

  it('health_check returns broker info', async () => {
    const claude = spawnMcp(CLAUDE_MCP, {
      BRIDGE_DISABLE_AUTOREPLY: '0',
      BRIDGE_SLOT: slot('e2e-health'),
    });

    try {
      await initializeMcp(claude);
      const health = await callTool(claude, 'health_check') as Record<string, unknown>;
      expect(health.server).toBe('claude-mcp');
      expect(health.broker_connected).toBe(true);
      expect(health.broker_pid).toBeGreaterThan(0);
      expect(health.slot).toBe(slot('e2e-health'));
      expect(health.auto_reply_enabled).toBe(false);
      expect(health.auto_reply_disabled_reason).toContain('sampling capability unavailable');
    } finally {
      killMcp(claude);
    }
  }, 10000);

  it('wait_for_messages blocks until a peer sends a message', async () => {
    const claude = spawnMcp(CLAUDE_MCP, { BRIDGE_SLOT: slot('e2e-wait') });
    const codex = spawnMcp(CODEX_MCP, { BRIDGE_SLOT: slot('e2e-wait') });

    try {
      await initializeMcp(claude);
      await initializeMcp(codex);

      const waitPromise = callTool(codex, 'wait_for_messages', { timeout_ms: 5000 }) as Promise<{
        has_new: boolean;
        messages: Array<{ content: string }>;
      }>;

      await Bun.sleep(250);
      await callTool(claude, 'send_message', { text: 'Wake from Claude' });

      const waited = await waitPromise;
      expect(waited.has_new).toBe(true);
      expect(waited.messages).toHaveLength(1);
      expect(waited.messages[0].content).toBe('Wake from Claude');
    } finally {
      killMcp(claude);
      killMcp(codex);
    }
  }, 15000);

  it('reset_session starts a fresh conversation', async () => {
    const claude = spawnMcp(CLAUDE_MCP, { BRIDGE_SLOT: slot('e2e-reset') });
    const codex = spawnMcp(CODEX_MCP, { BRIDGE_SLOT: slot('e2e-reset') });

    try {
      await initializeMcp(claude);
      await initializeMcp(codex);

      await callTool(claude, 'send_message', { text: 'Before reset' });
      await callTool(codex, 'check_messages');

      const resetResult = await callTool(claude, 'reset_session', { confirm: true });
      expect(typeof resetResult === 'string' ? resetResult : '').toContain('reset');

      // After reset, new messages in old conversation are gone
      // Codex's broker client will re-register on next call
      const check = await callTool(codex, 'check_messages') as { has_new: boolean };
      expect(check.has_new).toBe(false);
    } finally {
      killMcp(claude);
      killMcp(codex);
    }
  }, 15000);

  it('shares the same bridge state across different subdirectories in one workspace', async () => {
    const nestedWorkspace = resolve(TEST_WORKSPACE, 'nested');
    mkdirSync(nestedWorkspace, { recursive: true });

    const claude = spawnMcp(CLAUDE_MCP, { BRIDGE_SLOT: slot('e2e-subdir-shared') });
    const codex = spawnMcpAt(CODEX_MCP, nestedWorkspace, {
      BRIDGE_SLOT: slot('e2e-subdir-shared'),
    });

    try {
      await initializeMcp(claude);
      await initializeMcp(codex);

      await callTool(claude, 'send_message', { text: 'Hello across subdirectories' });

      const checkResult = await callTool(codex, 'check_messages') as {
        has_new: boolean;
        messages: Array<{ content: string }>;
      };
      expect(checkResult.has_new).toBe(true);
      expect(checkResult.messages).toHaveLength(1);
      expect(checkResult.messages[0].content).toBe('Hello across subdirectories');
    } finally {
      killMcp(claude);
      killMcp(codex);
    }
  }, 15000);
});
