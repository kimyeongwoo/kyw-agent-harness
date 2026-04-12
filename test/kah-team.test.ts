import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const KAH_SCRIPT = resolve(PACKAGE_ROOT, 'bin', 'kah.ts');
const SOURCE_SKILL = resolve(PACKAGE_ROOT, 'skills', 'team', 'SKILL.md');
const SOURCE_AGENTS_DIR = resolve(PACKAGE_ROOT, 'agents');

const KAH_MARKER = '<!-- kah-managed -->';
const AGENT_FILES = [
  'analyst.md',
  'architect.md',
  'critic.md',
  'debugger.md',
  'executor.md',
  'explore.md',
  'planner.md',
  'verifier.md',
];

function readText(path: string): string {
  return readFileSync(path, 'utf-8');
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runKah(args: string[], env: Record<string, string | undefined>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync([process.execPath, KAH_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// =============================================================================
// Source file validation — verifies the agent/skill source files are correct
// =============================================================================

describe('source file validation', () => {
  it('all agent source files contain kah-managed marker', () => {
    for (const file of AGENT_FILES) {
      const content = readText(resolve(SOURCE_AGENTS_DIR, file));
      expect(content).toContain(KAH_MARKER);
    }
  });

  it('SKILL.md source contains kah-managed marker', () => {
    const content = readText(SOURCE_SKILL);
    expect(content).toContain(KAH_MARKER);
  });

  it('SKILL.md version comment is version-agnostic', () => {
    const skillContent = readText(SOURCE_SKILL);
    expect(skillContent).toContain('team skill: kyw_agent_harness (aligned with Claude Code');
    // Ensure no hardcoded version number in the comment
    expect(skillContent).not.toMatch(/team skill: kyw_agent_harness v\d+\.\d+/);
  });

  it('no agent files reference non-existent agents in handoff/responsibility lists', () => {
    // These are the only valid agent names (matching the 8 .md files)
    const validAgents = AGENT_FILES.map((f) => f.replace('.md', ''));

    // Known non-existent agent names that should NOT appear
    const invalidAgents = [
      'designer',
      'code-reviewer',
      'security-reviewer',
      'qa-tester',
      'test-engineer',
    ];

    for (const file of AGENT_FILES) {
      const content = readText(resolve(SOURCE_AGENTS_DIR, file));
      for (const invalid of invalidAgents) {
        // Check for parenthetical references like "(security-reviewer)"
        // or handoff references like "security-reviewer (deep audit)"
        const regex = new RegExp(`\\b${invalid.replace('-', '[-_]?')}\\b`, 'i');
        expect(content).not.toMatch(regex);
      }
    }
  });

  it('no OMC-specific artifacts in any source file', () => {
    const omcKeywords = [
      'oh-my-claudecode',
      '.omc/',
      'state_write',
      'linked_ralph',
      'RALPLAN',
      'cleanup-orphans',
      'omc team',
      'codex_worker',
      'gemini_worker',
    ];

    const skillContent = readText(SOURCE_SKILL);
    for (const kw of omcKeywords) {
      expect(skillContent).not.toContain(kw);
    }

    for (const file of AGENT_FILES) {
      const content = readText(resolve(SOURCE_AGENTS_DIR, file));
      for (const kw of omcKeywords) {
        expect(content).not.toContain(kw);
      }
    }
  });

  it('ast_grep_search/replace references include "(when available)" qualifier', () => {
    // These files are known to reference ast_grep tools
    const filesWithAstGrep = ['executor.md', 'explore.md', 'architect.md'];

    for (const file of filesWithAstGrep) {
      const content = readText(resolve(SOURCE_AGENTS_DIR, file));
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // If line mentions ast_grep_search or ast_grep_replace as a tool instruction
        // (not just a passing mention in investigation protocol)
        if (
          (line.includes('ast_grep_search') || line.includes('ast_grep_replace')) &&
          (line.trimStart().startsWith('- Use') || line.trimStart().startsWith('- Prefer'))
        ) {
          expect(line).toContain('when available');
        }
      }
    }
  });

  it('KAH_AGENT_FILES constant matches actual agent source files', () => {
    const actualFiles = readdirSync(SOURCE_AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort();
    const expectedFiles = [...AGENT_FILES].sort();
    expect(actualFiles).toEqual(expectedFiles);
  });

  it('SKILL.md Stage Agent Routing table only references existing agents', () => {
    const content = readText(SOURCE_SKILL);
    const validAgents = AGENT_FILES.map((f) => f.replace('.md', ''));

    // Extract the routing table section
    const tableStart = content.indexOf('| Stage |');
    const tableEnd = content.indexOf('\n\n', tableStart);
    const tableSection = content.slice(tableStart, tableEnd);

    // Extract backtick-quoted agent names from the table
    const agentRefs = tableSection.match(/`(\w+)`/g) || [];
    const referencedAgents = agentRefs
      .map((ref) => ref.replace(/`/g, ''))
      .filter((name) => !['model:', 'opus', 'sonnet', 'haiku'].includes(name));

    for (const agent of referencedAgents) {
      // Skip non-agent keywords
      if (['team-plan', 'team-prd', 'team-exec', 'team-verify', 'team-fix'].includes(agent)) continue;
      expect(validAgents).toContain(agent);
    }
  });
});

// =============================================================================
// kah team install — marker-aware behavior
// =============================================================================

describe('kah team install (marker-aware)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  it('fresh install copies all files', () => {
    const homeDir = createTempDir('kah-team-fresh-');
    tempDirs.push(homeDir);

    const { exitCode, stdout } = runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    expect(exitCode).toBe(0);

    // Skill file installed
    const destSkill = resolve(homeDir, '.claude', 'skills', 'team', 'SKILL.md');
    expect(existsSync(destSkill)).toBe(true);
    expect(readText(destSkill)).toBe(readText(SOURCE_SKILL));

    // All agent files installed
    for (const file of AGENT_FILES) {
      const dest = resolve(homeDir, '.claude', 'agents', file);
      expect(existsSync(dest)).toBe(true);
      expect(readText(dest)).toBe(readText(resolve(SOURCE_AGENTS_DIR, file)));
    }

    // Written messages (not Updated or SKIP)
    expect(stdout).toContain('Written');
    expect(stdout).not.toContain('[SKIP]');
  });

  it('skips user-owned files without kah-managed marker', () => {
    const homeDir = createTempDir('kah-team-user-');
    tempDirs.push(homeDir);

    // Pre-create user's own executor.md (no marker)
    const agentsDir = resolve(homeDir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const userContent = '---\nname: executor\n---\nMy custom executor.';
    writeFileSync(resolve(agentsDir, 'executor.md'), userContent);

    // Pre-create user's own SKILL.md (no marker)
    const skillDir = resolve(homeDir, '.claude', 'skills', 'team');
    mkdirSync(skillDir, { recursive: true });
    const userSkill = '---\nname: team\n---\nMy custom team skill.';
    writeFileSync(resolve(skillDir, 'SKILL.md'), userSkill);

    const { exitCode, stdout } = runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    expect(exitCode).toBe(0);

    // User file should NOT be overwritten
    expect(readText(resolve(agentsDir, 'executor.md'))).toBe(userContent);
    expect(readText(resolve(skillDir, 'SKILL.md'))).toBe(userSkill);

    // Should show skip messages
    expect(stdout).toContain('not kah-managed');
    expect(stdout).toContain('--force');

    // No .bak should be created for skipped files
    expect(existsSync(resolve(agentsDir, 'executor.md.bak'))).toBe(false);
    expect(existsSync(resolve(skillDir, 'SKILL.md.bak'))).toBe(false);

    // Other agent files should still be installed
    for (const file of AGENT_FILES.filter((f) => f !== 'executor.md')) {
      expect(existsSync(resolve(agentsDir, file))).toBe(true);
    }
  });

  it('--force overwrites user-owned files with backup', () => {
    const homeDir = createTempDir('kah-team-force-');
    tempDirs.push(homeDir);

    // Pre-create user's own executor.md (no marker)
    const agentsDir = resolve(homeDir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const userContent = '---\nname: executor\n---\nMy custom executor.';
    writeFileSync(resolve(agentsDir, 'executor.md'), userContent);

    const { exitCode } = runKah(['team', 'install', '--force'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    expect(exitCode).toBe(0);

    // File should be overwritten with kah version
    expect(readText(resolve(agentsDir, 'executor.md'))).toBe(
      readText(resolve(SOURCE_AGENTS_DIR, 'executor.md')),
    );

    // Backup should exist
    expect(existsSync(resolve(agentsDir, 'executor.md.bak'))).toBe(true);
    expect(readText(resolve(agentsDir, 'executor.md.bak'))).toBe(userContent);
  });

  it('updates kah-managed files (marker present, different content)', () => {
    const homeDir = createTempDir('kah-team-update-');
    tempDirs.push(homeDir);

    // First install
    runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    // Manually modify installed file (keep marker)
    const destExecutor = resolve(homeDir, '.claude', 'agents', 'executor.md');
    const oldContent = readText(destExecutor);
    const modifiedContent = oldContent + '\n<!-- modified -->';
    writeFileSync(destExecutor, modifiedContent);

    // Re-install should update
    const { exitCode, stdout } = runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Updated: executor.md');

    // File should be restored to source version
    expect(readText(destExecutor)).toBe(readText(resolve(SOURCE_AGENTS_DIR, 'executor.md')));

    // Backup should contain the modified version
    expect(readText(`${destExecutor}.bak`)).toBe(modifiedContent);
  });

  it('idempotent re-install skips unchanged files', () => {
    const homeDir = createTempDir('kah-team-idempotent-');
    tempDirs.push(homeDir);

    // First install
    runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    // Second install
    const { exitCode, stdout } = runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('[SKIP] Already up to date');
    expect(stdout).toContain(`${AGENT_FILES.length} unchanged`);

    // No .bak files should exist
    for (const file of AGENT_FILES) {
      expect(existsSync(resolve(homeDir, '.claude', 'agents', `${file}.bak`))).toBe(false);
    }
  });
});

// =============================================================================
// kah team uninstall
// =============================================================================

describe('kah team uninstall', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  it('removes all kah-managed files after install', () => {
    const homeDir = createTempDir('kah-team-uninstall-');
    tempDirs.push(homeDir);

    // Install first
    runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    // Uninstall
    const { exitCode, stdout } = runKah(['team', 'uninstall'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Removed');

    // All files should be gone
    const destSkill = resolve(homeDir, '.claude', 'skills', 'team', 'SKILL.md');
    expect(existsSync(destSkill)).toBe(false);
    for (const file of AGENT_FILES) {
      expect(existsSync(resolve(homeDir, '.claude', 'agents', file))).toBe(false);
    }
  });

  it('restores .bak files when present', () => {
    const homeDir = createTempDir('kah-team-uninstall-restore-');
    tempDirs.push(homeDir);

    // Create user's executor.md first
    const agentsDir = resolve(homeDir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const userContent = '---\nname: executor\n---\nMy custom executor.';
    writeFileSync(resolve(agentsDir, 'executor.md'), userContent);

    // Force install (creates .bak of user file)
    runKah(['team', 'install', '--force'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    expect(existsSync(resolve(agentsDir, 'executor.md.bak'))).toBe(true);

    // Uninstall should restore the .bak
    const { exitCode, stdout } = runKah(['team', 'uninstall'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Restored: executor.md');

    // User's original file should be back
    expect(readText(resolve(agentsDir, 'executor.md'))).toBe(userContent);

    // .bak should be gone (it was renamed back)
    expect(existsSync(resolve(agentsDir, 'executor.md.bak'))).toBe(false);
  });

  it('skips user-managed files during uninstall', () => {
    const homeDir = createTempDir('kah-team-uninstall-user-');
    tempDirs.push(homeDir);

    // Create user's executor.md (no kah marker)
    const agentsDir = resolve(homeDir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const userContent = '---\nname: executor\n---\nMy custom executor.';
    writeFileSync(resolve(agentsDir, 'executor.md'), userContent);

    const { exitCode, stdout } = runKah(['team', 'uninstall'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Not kah-managed: executor.md');

    // User file should still exist
    expect(readText(resolve(agentsDir, 'executor.md'))).toBe(userContent);
  });

  it('handles uninstall when nothing is installed', () => {
    const homeDir = createTempDir('kah-team-uninstall-empty-');
    tempDirs.push(homeDir);

    const { exitCode, stdout } = runKah(['team', 'uninstall'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Not installed');
    expect(stdout).toContain('not found');
  });
});

// =============================================================================
// kah team install — env var check
// =============================================================================

describe('kah team install (env var check)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  it('warns when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is not set', () => {
    const homeDir = createTempDir('kah-team-env-warn-');
    tempDirs.push(homeDir);

    const { exitCode, stdout } = runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is not set');
  });

  it('no warning when env var is set in shell environment', () => {
    const homeDir = createTempDir('kah-team-env-shell-');
    tempDirs.push(homeDir);

    const { exitCode, stdout } = runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is not set');
  });

  it('no warning when env var is set in ~/.claude/settings.json', () => {
    const homeDir = createTempDir('kah-team-env-settings-');
    tempDirs.push(homeDir);

    // Create settings.json with the env var
    const settingsDir = resolve(homeDir, '.claude');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      resolve(settingsDir, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }),
    );

    const { exitCode, stdout } = runKah(['team', 'install'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is not set');
  });
});

// =============================================================================
// kah team help
// =============================================================================

describe('kah team help', () => {
  it('shows usage with install and uninstall subcommands', () => {
    const { exitCode, stdout } = runKah(['team'], {});

    expect(exitCode).toBe(0);
    expect(stdout).toContain('install');
    expect(stdout).toContain('uninstall');
  });
});
