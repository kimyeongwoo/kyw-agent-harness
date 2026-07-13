import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { WORKSPACE_ROOT } from '../lib/constants.js';
import type { AgentKind } from '../lib/broker-types.js';
import type { WorkflowConfig, WorkflowModelPolicy } from './types.js';

export const WORKFLOW_CONFIG_PATH = resolve(WORKSPACE_ROOT, '.bridge', 'workflow.json');

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  schema_version: 1,
  enabled: true,
  claude: {
    role: 'lead_architect',
    require_model_match: false,
  },
  codex: {
    role: 'implementation_developer',
    require_model_match: false,
  },
  max_review_rounds: 2,
  require_user_approval: true,
};

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

export function loadWorkflowConfig(path = WORKFLOW_CONFIG_PATH): WorkflowConfig {
  let fileConfig: Partial<WorkflowConfig> = {};
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WorkflowConfig>;
    } catch {}
  }

  return {
    ...DEFAULT_WORKFLOW_CONFIG,
    ...fileConfig,
    schema_version: 1,
    claude: {
      ...DEFAULT_WORKFLOW_CONFIG.claude,
      ...(fileConfig.claude ?? {}),
    },
    codex: {
      ...DEFAULT_WORKFLOW_CONFIG.codex,
      ...(fileConfig.codex ?? {}),
    },
  };
}

export function writeWorkflowConfig(config: WorkflowConfig, path = WORKFLOW_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function getWorkflowModelPolicy(
  agentKind: AgentKind,
  config = loadWorkflowConfig(),
): WorkflowModelPolicy {
  const section = config[agentKind];
  const prefix = agentKind === 'claude' ? 'KAH_CLAUDE' : 'KAH_CODEX';
  const modelHint = process.env[`${prefix}_MODEL_HINT`]?.trim() || section.model_hint;
  const requireModelMatch = envBoolean(
    process.env[`${prefix}_REQUIRE_MODEL_MATCH`],
    section.require_model_match,
  );

  return {
    model_hint: modelHint,
    require_model_match: requireModelMatch,
  };
}

export function createFableWorkflowConfig(): WorkflowConfig {
  return {
    ...DEFAULT_WORKFLOW_CONFIG,
    claude: {
      ...DEFAULT_WORKFLOW_CONFIG.claude,
      model_hint: 'claude-fable-5',
      require_model_match: true,
    },
  };
}
