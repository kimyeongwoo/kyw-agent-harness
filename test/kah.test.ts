import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const KAH_SCRIPT = resolve(PACKAGE_ROOT, 'bin', 'kah.ts');
const CODEX_SERVER = resolve(PACKAGE_ROOT, 'start-codex.ts').replace(/\\/g, '/');

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readText(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('kah init', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  it('updates an existing Codex bridge config block instead of skipping it', () => {
    const root = createTempDir('kah-test-');
    tempDirs.push(root);

    const workspace = resolve(root, 'workspace');
    const homeDir = resolve(root, 'home');
    const codexConfigDir = resolve(homeDir, '.codex');
    const configToml = resolve(codexConfigDir, 'config.toml');

    mkdirSync(workspace, { recursive: true });
    mkdirSync(codexConfigDir, { recursive: true });

    const originalConfig = [
      '[mcp_servers.bridge]',
      'command = "bun"',
      'args = ["old"]',
      '',
      '[other]',
      'value = 1',
      '',
    ].join('\n');
    writeFileSync(configToml, originalConfig);

    const result = Bun.spawnSync([process.execPath, KAH_SCRIPT, 'init', '--slot', 'demo'], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);

    const updatedConfig = readText(configToml);
    const backupPath = `${configToml}.bak`;
    const mcpJsonPath = resolve(workspace, '.mcp.json');
    const mcpJson = JSON.parse(readText(mcpJsonPath)) as {
      mcpServers: { bridge: { args: string[]; env?: Record<string, string> } };
    };

    expect(updatedConfig).toContain('[mcp_servers.bridge]');
    expect(updatedConfig).toContain(`args = ["${CODEX_SERVER}"]`);
    expect(updatedConfig).toContain('env = { BRIDGE_SLOT = "demo" }');
    expect(updatedConfig).toContain('[other]\nvalue = 1');
    expect(updatedConfig).not.toContain('args = ["old"]');
    expect(existsSync(backupPath)).toBe(true);
    expect(readText(backupPath)).toBe(originalConfig);
    expect(mcpJson.mcpServers.bridge.args[0]).toBe(resolve(PACKAGE_ROOT, 'start-claude.ts').replace(/\\/g, '/'));
    expect(mcpJson.mcpServers.bridge.env?.BRIDGE_SLOT).toBe('demo');
  });
});

describe('kah team install', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  it('copies SKILL.md and agents to ~/.claude and is idempotent', () => {
    const homeDir = createTempDir('kah-team-test-');
    tempDirs.push(homeDir);

    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    };

    // First run: should copy files
    const first = Bun.spawnSync([process.execPath, KAH_SCRIPT, 'team', 'install'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(first.exitCode).toBe(0);

    const destSkillFile = resolve(homeDir, '.claude', 'skills', 'team', 'SKILL.md');
    const destExecutorFile = resolve(homeDir, '.claude', 'agents', 'executor.md');
    const destVerifierFile = resolve(homeDir, '.claude', 'agents', 'verifier.md');

    expect(existsSync(destSkillFile)).toBe(true);
    expect(existsSync(destExecutorFile)).toBe(true);
    expect(existsSync(destVerifierFile)).toBe(true);

    // Verify content matches source (sanity check that the copy works correctly)
    const sourceSkill = readText(resolve(PACKAGE_ROOT, 'skills', 'team', 'SKILL.md'));
    expect(readText(destSkillFile)).toBe(sourceSkill);

    // Verify SKILL.md does NOT contain OMC keywords (regression guard)
    expect(readText(destSkillFile)).not.toContain('oh-my-claudecode');
    expect(readText(destSkillFile)).not.toContain('.omc/');
    expect(readText(destSkillFile)).not.toContain('state_write');

    // Second run: should be idempotent (no .bak files created)
    const second = Bun.spawnSync([process.execPath, KAH_SCRIPT, 'team', 'install'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(second.exitCode).toBe(0);
    const stdout = second.stdout.toString();
    expect(stdout).toContain('[SKIP] Already up to date');
    expect(existsSync(`${destSkillFile}.bak`)).toBe(false);
  });
});
