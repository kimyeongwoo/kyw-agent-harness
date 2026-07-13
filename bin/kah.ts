#!/usr/bin/env bun

import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { buildCodexBridgeSection, upsertCodexBridgeConfig } from '../src/lib/codex-config.js';
import { syncHistory } from '../src/prompts/sync.js';
import { exportPrompts } from '../src/prompts/export.js';
import { listProjects } from '../src/prompts/list.js';
import {
  HISTORY_JSONL_PATH,
  PROMPT_HISTORY_DIR,
} from '../src/prompts/types.js';

const PACKAGE_ROOT = resolve(dirname(Bun.main), '..');
const CLAUDE_SERVER = resolve(PACKAGE_ROOT, 'start-claude.ts');
const CODEX_SERVER = resolve(PACKAGE_ROOT, 'start-codex.ts');
const BRIDGE_SERVER_NAME = 'bridge';
const BRIDGE_SLOT_ENV = 'BRIDGE_SLOT';

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeForConfig(value: string): string {
  return value.replace(/\\/g, '/');
}

function resolveBunCommand(): string {
  try {
    const result = Bun.spawnSync(['bun', '--version'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (result.exitCode === 0) {
      return 'bun';
    }
  } catch {}

  return normalizeForConfig(process.execPath);
}

function resolveBridgeWorkspaceRoot(cwd: string): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (result.exitCode === 0) {
      const gitRoot = result.stdout.toString().trim();
      if (gitRoot) {
        return resolve(gitRoot);
      }
    }
  } catch {}

  return cwd;
}

const command = process.argv[2];

switch (command) {
  case 'init':
    await cmdInit();
    break;
  case 'statusline':
    cmdStatusline();
    break;
  case 'prompts':
    cmdPrompts();
    break;
  default:
    printUsage();
}

function printUsage(): void {
  console.log(`kyw_agent_harness (kah) — Bridge between Claude Code and Codex CLI

Usage:
  kah init [--slot name]    Configure MCP servers for current directory
  kah statusline            Install HUD status line for Claude Code
  kah prompts <command>     Manage prompt history (sync, export, list)

Run 'kah prompts' for subcommand help.`);
}

async function cmdInit(): Promise<void> {
  const cwd = process.cwd();
  const slotValue = readFlagValue('--slot');
  const bunCommand = resolveBunCommand();
  const bridgeWorkspaceRoot = resolveBridgeWorkspaceRoot(cwd);

  console.log(`[kah] Initializing kyw_agent_harness in ${cwd}\n`);
  if (slotValue) console.log(`  Slot: ${slotValue}\n`);

  // 1. .mcp.json
  console.log('[1/3] .mcp.json');
  const mcpJsonPath = resolve(cwd, '.mcp.json');
  const claudeServerPath = CLAUDE_SERVER.replace(/\\/g, '/');
  const bridgeServer: Record<string, unknown> = {
    command: bunCommand,
    args: [claudeServerPath],
  };
  if (slotValue) {
    bridgeServer.env = { [BRIDGE_SLOT_ENV]: slotValue };
  }

  if (existsSync(mcpJsonPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as Record<string, unknown>;
      const mcpServers = ensureObject(existing.mcpServers);
      mcpServers[BRIDGE_SERVER_NAME] = bridgeServer;
      existing.mcpServers = mcpServers;
      writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2));
      console.log(`  Updated: ${mcpJsonPath}`);
    } catch {
      writeFileSync(`${mcpJsonPath}.bak`, readFileSync(mcpJsonPath));
      writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: bridgeServer } }, null, 2));
      console.log(`  Written: ${mcpJsonPath} (old file backed up)`);
    }
  } else {
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: bridgeServer } }, null, 2));
    console.log(`  Written: ${mcpJsonPath}`);
  }
  console.log(`  Claude server: ${CLAUDE_SERVER}\n`);

  // 2. Codex MCP registration
  console.log('[2/3] Codex MCP registration');
  const codexPath = CODEX_SERVER.replace(/\\/g, '/');
  let codexRegistered = false;

  if (!slotValue) {
    try {
      const result = Bun.spawnSync(['codex', 'mcp', 'add', 'bridge', '--', bunCommand, codexPath]);
      if (result.exitCode === 0) {
        console.log('  Registered via: codex mcp add');
        codexRegistered = true;
      }
    } catch {}
  }

  if (!codexRegistered) {
    const codexConfigDir = resolve(process.env.HOME || process.env.USERPROFILE || '~', '.codex');
    const configToml = resolve(codexConfigDir, 'config.toml');
    const bridgeSection = buildCodexBridgeSection({ bunCommand, codexPath, slotValue });

    if (existsSync(configToml)) {
      const existing = readFileSync(configToml, 'utf-8');
      const updated = upsertCodexBridgeConfig(existing, { bunCommand, codexPath, slotValue });

      if (updated === existing) {
        console.log('  [SKIP] Bridge config already current');
      } else {
        writeFileSync(`${configToml}.bak`, existing);
        writeFileSync(configToml, updated);
        console.log(`  Updated: ${configToml} (backup created)`);
      }
    } else {
      mkdirSync(codexConfigDir, { recursive: true });
      writeFileSync(configToml, `${bridgeSection}\n`);
      console.log(`  Created: ${configToml}`);
    }
  }
  console.log(`  Codex server: ${CODEX_SERVER}\n`);

  // 3. .bridge/ directory
  console.log('[3/3] Bridge state directory');
  const bridgeDir = resolve(bridgeWorkspaceRoot, '.bridge');
  mkdirSync(bridgeDir, { recursive: true });
  console.log(`  Created: ${bridgeDir}\n`);

  console.log("Done. Start Claude and Codex in separate terminals to begin.");
}

function cmdStatusline(): void {
  const hudScript = resolve(PACKAGE_ROOT, 'scripts', 'statusline-hud.sh').replace(/\\/g, '/');

  if (!existsSync(hudScript)) {
    console.error(`[kah] HUD script not found: ${hudScript}`);
    process.exit(1);
  }

  const settingsDir = resolve(process.env.HOME || process.env.USERPROFILE || '~', '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');

  mkdirSync(settingsDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      writeFileSync(`${settingsPath}.bak`, readFileSync(settingsPath));
    }
  }

  const statusLineCommand = `bash ${hudScript}`;
  if (settings.statusLine === statusLineCommand) {
    console.log('[kah] StatusLine HUD already configured.');
    return;
  }

  settings.statusLine = statusLineCommand;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`[kah] StatusLine HUD installed.`);
  console.log(`  Script: ${hudScript}`);
  console.log('  Restart Claude Code to see the status bar.');
}

function resolvePromptPaths(): {
  historyPath: string;
  archivePath: string;
  watermarkPath: string;
  exportsDir: string;
} {
  const dir = process.env.KAH_PROMPT_HISTORY_DIR ?? PROMPT_HISTORY_DIR;
  return {
    historyPath: process.env.KAH_HISTORY_JSONL ?? HISTORY_JSONL_PATH,
    archivePath: resolve(dir, 'archive.jsonl'),
    watermarkPath: resolve(dir, 'last-sync.json'),
    exportsDir: resolve(dir, 'exports'),
  };
}

function cmdPrompts(): void {
  const subcommand = process.argv[3];
  const paths = resolvePromptPaths();

  switch (subcommand) {
    case 'sync': {
      const result = syncHistory(paths);
      if (result.warning) console.warn(`[kah] Warning: ${result.warning}`);
      console.log(`[kah] Synced ${result.newEntries} new entries. Total archived: ${result.totalArchived}`);
      break;
    }
    case 'export': {
      const syncResult = syncHistory(paths);
      if (syncResult.warning) console.warn(`[kah] Warning: ${syncResult.warning}`);

      const exportResult = exportPrompts({
        archivePath: paths.archivePath,
        exportsDir: paths.exportsDir,
        project: readFlagValue('--project'),
        from: readFlagValue('--from'),
        to: readFlagValue('--to'),
        keyword: readFlagValue('--keyword'),
      });

      console.log(`[kah] Exported ${exportResult.totalPrompts} prompts to ${exportResult.filesWritten} files.`);
      console.log(`  Location: ${paths.exportsDir}`);
      break;
    }
    case 'list': {
      const syncResult = syncHistory(paths);
      if (syncResult.warning) console.warn(`[kah] Warning: ${syncResult.warning}`);

      const projects = listProjects({ archivePath: paths.archivePath });
      if (projects.length === 0) {
        console.log('[kah] No prompts found.');
        return;
      }

      console.log('[kah] Prompt history by project:\n');
      for (const p of projects) {
        console.log(`  ${p.slug.padEnd(30)} ${String(p.count).padStart(5)} prompts  ${String(p.sessions).padStart(3)} sessions  ${p.firstDate} ~ ${p.lastDate}`);
      }
      console.log(`\n  Total: ${projects.reduce((sum, p) => sum + p.count, 0)} prompts across ${projects.length} projects`);
      break;
    }
    default:
      console.log(`Usage:
  kah prompts sync                           Backup history.jsonl to archive
  kah prompts export [options]               Export prompts as markdown
  kah prompts list                           Show project summary

Export options:
  --project <name>    Filter by project (partial match, case insensitive)
  --from <YYYY-MM-DD> Start date
  --to <YYYY-MM-DD>   End date
  --keyword <text>    Filter by keyword`);
  }
}

function readFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
