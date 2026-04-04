import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const KAH_SCRIPT = resolve(PACKAGE_ROOT, 'bin', 'kah.ts');

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'kah-prompts-'));
}

function makeEntry(display: string, timestamp: number, project: string, sessionId: string): string {
  return JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId });
}

function run(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync([process.execPath, KAH_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe('kah prompts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('sync + export + list roundtrip', () => {
    const root = tmpDir(); dirs.push(root);
    const claudeDir = join(root, '.claude');
    const historyPath = join(claudeDir, 'history.jsonl');
    const promptHistoryDir = join(claudeDir, 'prompt-history');

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(historyPath, [
      makeEntry('analyze this', new Date('2026-04-04T09:00:00Z').getTime(), 'C:\\proj\\MyApp', 'sess-1111'),
      makeEntry('fix the bug', new Date('2026-04-04T10:00:00Z').getTime(), 'C:\\proj\\MyApp', 'sess-1111'),
      makeEntry('deploy it', new Date('2026-04-04T11:00:00Z').getTime(), 'C:\\proj\\Other', 'sess-2222'),
    ].join('\n') + '\n');

    // Test sync
    const syncResult = run(['prompts', 'sync'], {
      KAH_PROMPT_HISTORY_DIR: promptHistoryDir,
      KAH_HISTORY_JSONL: historyPath,
    });
    expect(syncResult.exitCode).toBe(0);
    expect(syncResult.stdout).toContain('Synced 3 new');
    expect(existsSync(join(promptHistoryDir, 'archive.jsonl'))).toBe(true);

    // Test export
    const exportResult = run(['prompts', 'export', '--project', 'MyApp'], {
      KAH_PROMPT_HISTORY_DIR: promptHistoryDir,
      KAH_HISTORY_JSONL: historyPath,
    });
    expect(exportResult.exitCode).toBe(0);
    expect(exportResult.stdout).toContain('2 prompts');

    const md = readFileSync(join(promptHistoryDir, 'exports', 'MyApp', '2026-04-04.md'), 'utf-8');
    expect(md).toContain('# MyApp -- 2026-04-04');
    expect(md).toContain('analyze this');
    expect(md).toContain('fix the bug');
    expect(md).not.toContain('deploy it');

    // Test list
    const listResult = run(['prompts', 'list'], {
      KAH_PROMPT_HISTORY_DIR: promptHistoryDir,
      KAH_HISTORY_JSONL: historyPath,
    });
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('MyApp');
    expect(listResult.stdout).toContain('Other');
  });
});
