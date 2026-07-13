import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const KAH_SCRIPT = resolve(PACKAGE_ROOT, 'bin', 'kah.ts');

describe('kah task', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch {}
    }
  });

  it('creates and inspects a structured workflow task', () => {
    const root = mkdtempSync(join(tmpdir(), 'kah-task-cli-'));
    roots.push(root);

    const created = Bun.spawnSync([
      process.execPath,
      KAH_SCRIPT,
      'task',
      'create',
      '--type',
      'existing-change',
      '--title',
      'Add audit log',
      '--goal',
      'Design an audit log and preserve API compatibility.',
      '--slot',
      'audit',
    ], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(created.exitCode).toBe(0);
    const stdout = created.stdout.toString();
    const taskId = stdout.match(/task_[a-z0-9]{12}/)?.[0];
    expect(taskId).toBeTruthy();
    expect(stdout).toContain('Status: discovery');
    expect(stdout).toContain('Claude wake: not available');

    const manifestPath = resolve(root, '.bridge', 'tasks', taskId!, 'task.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.type).toBe('existing-change');
    expect(manifest.slot).toBe('audit');
    expect(manifest.artifacts[0].kind).toBe('brief');

    const status = Bun.spawnSync([
      process.execPath,
      KAH_SCRIPT,
      'task',
      'status',
      taskId!,
    ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain('Add audit log');
    expect(status.stdout.toString()).toContain('brief v1');
  });
});
