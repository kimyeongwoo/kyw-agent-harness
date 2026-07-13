#!/usr/bin/env bun

import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { buildCodexBridgeSection, upsertCodexBridgeConfig } from '../src/lib/codex-config.js';
import { syncHistory } from '../src/prompts/sync.js';
import { exportPrompts } from '../src/prompts/export.js';
import { listProjects } from '../src/prompts/list.js';
import { WorkflowStore } from '../src/workflow/store.js';
import {
  createFableWorkflowConfig,
  loadWorkflowConfig,
  writeWorkflowConfig,
} from '../src/workflow/config.js';
import { inspectBrokerWorkspace, readBrokerHealthForWorkspace, resolveWakeMethod } from '../src/lib/broker-client.js';
import { sendWakeup } from '../src/lib/adapter-utils.js';
import { DEFAULT_BRIDGE_SLOT } from '../src/lib/constants.js';
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
  case 'task':
    await cmdTask();
    break;
  case 'doctor':
    await cmdDoctor();
    break;
  default:
    printUsage();
}

function printUsage(): void {
  console.log(`kyw_agent_harness (kah) — Bridge between Claude Code and Codex CLI

Usage:
  kah init [--slot name] [--fable5]  Configure MCP servers and optional Fable workflow
  kah statusline            Install HUD status line for Claude Code
  kah prompts <command>     Manage prompt history (sync, export, list)
  kah task <command>        Run Fable design -> approval -> Codex implementation workflows
  kah doctor                Diagnose bridge and workflow readiness

Run 'kah prompts' or 'kah task' for subcommand help.`);
}

async function cmdInit(): Promise<void> {
  const cwd = process.cwd();
  const slotValue = readFlagValue('--slot');
  const bunCommand = resolveBunCommand();
  const bridgeWorkspaceRoot = resolveBridgeWorkspaceRoot(cwd);
  const enableFableWorkflow = process.argv.includes('--fable5');

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
  const claudeEnv: Record<string, string> = {};
  if (slotValue) claudeEnv[BRIDGE_SLOT_ENV] = slotValue;
  if (enableFableWorkflow) {
    claudeEnv.KAH_CLAUDE_MODEL_HINT = 'claude-fable-5';
    claudeEnv.KAH_CLAUDE_REQUIRE_MODEL_MATCH = '1';
  }
  if (Object.keys(claudeEnv).length > 0) {
    bridgeServer.env = claudeEnv;
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

  if (enableFableWorkflow) {
    const workflowConfigPath = resolve(bridgeDir, 'workflow.json');
    writeWorkflowConfig(createFableWorkflowConfig(), workflowConfigPath);
    console.log(`[workflow] Fable 5 architect workflow enabled: ${workflowConfigPath}`);
    console.log('  Claude role: lead architect (read-only design)');
    console.log('  Codex role: design reviewer and implementation developer');
    console.log('  User approval is required before implementation.\n');
  }

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

async function cmdTask(): Promise<void> {
  const subcommand = process.argv[3];
  const workspaceRoot = resolveBridgeWorkspaceRoot(process.cwd());
  const store = new WorkflowStore(workspaceRoot);
  const slot = readFlagValue('--slot') ?? process.env.BRIDGE_SLOT ?? DEFAULT_BRIDGE_SLOT;

  try {
    switch (subcommand) {
      case 'create': {
        const type = readFlagValue('--type');
        const title = readFlagValue('--title');
        const goalFlag = readFlagValue('--goal');
        const briefPath = readFlagValue('--brief');
        const goal = goalFlag ?? (briefPath ? readFileSync(resolve(process.cwd(), briefPath), 'utf-8') : undefined);
        if (type !== 'greenfield' && type !== 'existing-change') {
          throw new Error("--type must be 'greenfield' or 'existing-change'.");
        }
        if (!title) throw new Error('--title is required.');
        if (!goal) throw new Error('Provide --goal <text> or --brief <markdown-file>.');

        const task = await store.createTask({ type, title, goal, slot });
        console.log(`[kah] Created workflow task ${task.task_id}`);
        printTaskSummary(task);
        const woke = await wakeWorkflowAgent(
          workspaceRoot,
          task.slot,
          'claude',
          `New architecture task ${task.task_id} is ready. Call get_active_task, inspect the project read-only, and follow the Claude next_action.`,
        );
        console.log(`  Claude wake: ${woke ? 'sent' : 'not available; start or prompt Claude manually'}`);
        break;
      }
      case 'list': {
        const tasks = store.listTasks();
        if (tasks.length === 0) {
          console.log('[kah] No workflow tasks found.');
          break;
        }
        console.log('[kah] Workflow tasks:\n');
        for (const task of tasks) {
          console.log(`  ${task.task_id}  ${task.status.padEnd(29)}  ${task.type.padEnd(15)}  ${task.title}`);
        }
        break;
      }
      case 'status': {
        const taskId = process.argv[4];
        const task = taskId && !taskId.startsWith('--') ? store.getTask(taskId) : store.getActiveTask(slot);
        if (!task) {
          console.log(`[kah] No active workflow task for slot '${slot}'.`);
          break;
        }
        printTaskSummary(task, true);
        break;
      }
      case 'approve': {
        const taskId = requiredTaskId();
        const task = await store.approveTask(taskId);
        console.log(`[kah] Approved ${task.task_id} design v${task.design_version}.`);
        const woke = await wakeWorkflowAgent(
          workspaceRoot,
          task.slot,
          'codex',
          `User approved workflow task ${task.task_id} design v${task.design_version}. Call get_active_task, then start_implementation before modifying source code.`,
        );
        console.log(`  Codex wake: ${woke ? 'sent' : 'not available; start or prompt Codex manually'}`);
        break;
      }
      case 'request-changes': {
        const taskId = requiredTaskId();
        const reason = readFlagValue('--reason');
        if (!reason) throw new Error('--reason is required.');
        const task = await store.requestUserChanges(taskId, reason);
        console.log(`[kah] Returned ${task.task_id} to Fable design.`);
        await wakeWorkflowAgent(
          workspaceRoot,
          task.slot,
          'claude',
          `User requested design changes for ${task.task_id}: ${reason}. Call get_active_task and submit a revised design.`,
        );
        break;
      }
      case 'complete': {
        const task = await store.completeTask(requiredTaskId());
        console.log(`[kah] Completed workflow task ${task.task_id}.`);
        break;
      }
      case 'cancel': {
        const task = await store.cancelTask(requiredTaskId(), readFlagValue('--reason'));
        console.log(`[kah] Cancelled workflow task ${task.task_id}.`);
        break;
      }
      default:
        printTaskUsage();
    }
  } catch (error) {
    console.error(`[kah] Task error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function requiredTaskId(): string {
  const taskId = process.argv[4];
  if (!taskId || taskId.startsWith('--')) throw new Error('A task ID is required.');
  return taskId;
}

function printTaskSummary(task: ReturnType<WorkflowStore['getTask']>, verbose = false): void {
  console.log(`  Task ID: ${task.task_id}`);
  console.log(`  Title: ${task.title}`);
  console.log(`  Type: ${task.type}`);
  console.log(`  Status: ${task.status}`);
  console.log(`  Slot: ${task.slot}`);
  console.log(`  Design version: ${task.design_version}${task.approved_design_version ? ` (approved v${task.approved_design_version})` : ''}`);
  console.log(`  Base commit: ${task.base_commit ?? '(none)'}`);
  console.log(`  Dirty at creation: ${task.dirty_at_creation ? 'yes' : 'no'}`);
  if (verbose) {
    console.log(`  Goal: ${task.goal}`);
    console.log(`  Artifacts:`);
    for (const artifact of task.artifacts) {
      console.log(`    - ${artifact.kind} v${artifact.version}: ${artifact.path}`);
    }
    const latestEvent = task.events[task.events.length - 1];
    if (latestEvent) console.log(`  Latest event: ${latestEvent.actor}/${latestEvent.action} at ${latestEvent.created_at}`);
  }
}

function printTaskUsage(): void {
  console.log(`Usage:
  kah task create --type <greenfield|existing-change> --title <text> (--goal <text> | --brief <file>) [--slot <name>]
  kah task list
  kah task status [task-id] [--slot <name>]
  kah task approve <task-id>
  kah task request-changes <task-id> --reason <text>
  kah task complete <task-id>
  kah task cancel <task-id> [--reason <text>]

Workflow:
  Fable discovery/design -> Codex design review -> user approval -> Codex implementation
  -> Fable validation -> user completion approval`);
}

async function wakeWorkflowAgent(
  workspaceRoot: string,
  slot: string,
  agentKind: 'claude' | 'codex',
  text: string,
): Promise<boolean> {
  try {
    const inspection = await inspectBrokerWorkspace(workspaceRoot, { slot });
    const conversation = inspection.active_conversations[0];
    const peer = conversation?.peers.find((candidate) => candidate.agent_kind === agentKind && candidate.status === 'active');
    if (!conversation || !peer?.pane_target) return false;
    return await sendWakeup(
      conversation.conversation_id,
      agentKind,
      resolveWakeMethod(peer.pane_target),
      peer.pane_target,
      text,
    );
  } catch {
    return false;
  }
}

async function cmdDoctor(): Promise<void> {
  const workspaceRoot = resolveBridgeWorkspaceRoot(process.cwd());
  const configPath = resolve(workspaceRoot, '.bridge', 'workflow.json');
  const config = loadWorkflowConfig(configPath);
  const store = new WorkflowStore(workspaceRoot);
  const activeTask = store.getActiveTask();
  const bun = Bun.spawnSync(['bun', '--version'], { stdout: 'pipe', stderr: 'ignore' });
  const broker = await readBrokerHealthForWorkspace(workspaceRoot);

  console.log('[kah] Doctor\n');
  console.log(`  [${bun.exitCode === 0 ? 'OK' : 'FAIL'}] Bun ${bun.exitCode === 0 ? bun.stdout.toString().trim() : 'not available'}`);
  console.log(`  [OK] Workspace: ${workspaceRoot}`);
  console.log(`  [${existsSync(configPath) ? 'OK' : 'WARN'}] Workflow config: ${configPath}`);
  console.log(`  [${broker ? 'OK' : 'INFO'}] Broker: ${broker ? `pid ${broker.pid}, port ${broker.port}` : 'not running'}`);
  console.log(`  [${config.claude.model_hint ? 'OK' : 'WARN'}] Claude model hint: ${config.claude.model_hint ?? 'not configured'}`);
  console.log(`  [${config.claude.require_model_match ? 'OK' : 'WARN'}] Sampling model match: ${config.claude.require_model_match ? 'required' : 'not required'}`);
  console.log(`  [${activeTask ? 'INFO' : 'OK'}] Active task: ${activeTask ? `${activeTask.task_id} (${activeTask.status})` : 'none'}`);
  console.log('\n  Note: MCP can verify background sampling results, but cannot prove the model selected in an interactive Claude session. Confirm Claude shows Fable 5 before starting design work.');
}
