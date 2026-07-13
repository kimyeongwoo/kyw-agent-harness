import { resolve } from 'path';
import { WORKSPACE_ROOT } from '../lib/constants.js';
import type { AgentKind } from '../lib/broker-types.js';
import { loadWorkflowConfig } from './config.js';
import { WorkflowStore } from './store.js';
import type { WorkflowTask } from './types.js';

export interface WorkflowNotification {
  recipient: AgentKind;
  text: string;
  wake_text: string;
}

export interface WorkflowToolResult {
  handled: boolean;
  payload?: unknown;
  notification?: WorkflowNotification;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Argument '${name}' must be a non-empty string.`);
  }
  return value.trim();
}

function taskGuidance(task: WorkflowTask, agentKind: AgentKind): string {
  if (agentKind === 'claude') {
    switch (task.status) {
      case 'discovery':
      case 'design_draft':
      case 'design_change_requested':
        return 'Inspect the project read-only, produce the required design artifacts, then call submit_design. Do not modify project source code.';
      case 'awaiting_validation':
        return 'Review the implementation against the approved design and acceptance criteria, then call submit_validation. Do not fix the implementation yourself.';
      case 'awaiting_review':
      case 'awaiting_approval':
      case 'approved':
      case 'implementing':
        return 'Wait for Codex or the user. Do not implement project code.';
      case 'awaiting_completion_approval':
        return 'Validation passed. Wait for the user to complete the task.';
      default:
        return `Task is ${task.status}; no Claude workflow action is currently required.`;
    }
  }

  switch (task.status) {
    case 'awaiting_review':
      return 'Review the design against the real repository without modifying source code, then call submit_design_review.';
    case 'approved':
      return 'Call start_implementation before modifying source code. Implement only the approved design version.';
    case 'implementing':
      return 'Implement and test the approved design. If the design is flawed, call request_design_change instead of silently redesigning. Call report_implementation when done.';
    case 'awaiting_validation':
      return 'Wait for Claude Fable 5 to validate the implementation.';
    default:
      return `Task is ${task.status}; do not modify project source code.`;
  }
}

function taskView(task: WorkflowTask, agentKind: AgentKind): Record<string, unknown> {
  return {
    ...task,
    task_dir: resolve(WORKSPACE_ROOT, '.bridge', 'tasks', task.task_id),
    artifacts: task.artifacts.map((artifact) => ({
      ...artifact,
      absolute_path: resolve(WORKSPACE_ROOT, artifact.path),
    })),
    your_role: agentKind === 'claude' ? 'lead_architect' : 'design_reviewer_and_implementation_developer',
    next_action: taskGuidance(task, agentKind),
  };
}

const COMMON_TOOLS = [
  {
    name: 'get_active_task',
    description: 'Get the active structured development task, artifact paths, status, and your role-specific next action.',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'string', description: 'Optional workflow slot. Defaults to the current bridge slot.' },
      },
    },
  },
];

const CLAUDE_TOOLS = [
  {
    name: 'begin_design',
    description: 'Claim a task for read-only discovery and design. This does not authorize project source changes.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'submit_design',
    description: 'Submit a complete versioned design for Codex feasibility review. Claude must not implement source code.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        repository_facts: { type: 'string', description: 'Evidence-backed current-state findings with file references.' },
        requirements: { type: 'string', description: 'Problem, users, goals, non-goals, constraints, and resolved assumptions.' },
        architecture: { type: 'string' },
        implementation_plan: { type: 'string' },
        acceptance_criteria: { type: 'string' },
        test_plan: { type: 'string' },
        risks: { type: 'string' },
      },
      required: ['task_id', 'requirements', 'architecture', 'implementation_plan', 'acceptance_criteria', 'test_plan', 'risks'],
    },
  },
  {
    name: 'submit_validation',
    description: 'Validate Codex implementation against the approved design. Claude reviews only and must not fix code.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        verdict: { type: 'string', enum: ['pass', 'needs_changes'] },
        report: { type: 'string' },
      },
      required: ['task_id', 'verdict', 'report'],
    },
  },
];

const CODEX_TOOLS = [
  {
    name: 'submit_design_review',
    description: 'Review Claude Fable 5 design for repository accuracy and implementation feasibility without changing source code.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
        review: { type: 'string' },
      },
      required: ['task_id', 'verdict', 'review'],
    },
  },
  {
    name: 'start_implementation',
    description: 'Open the implementation gate after user approval. Do not modify source code unless this succeeds.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'request_design_change',
    description: 'Stop implementation and request a design revision instead of silently changing the approved design.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'report_implementation',
    description: 'Submit implementation evidence for Claude design-conformance validation.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        summary: { type: 'string' },
        changed_files: { type: 'array', items: { type: 'string' } },
        tests: { type: 'string' },
        remaining_risks: { type: 'string' },
      },
      required: ['task_id', 'summary', 'changed_files', 'tests'],
    },
  },
];

export function getWorkflowTools(agentKind: AgentKind): Array<Record<string, unknown>> {
  return [...COMMON_TOOLS, ...(agentKind === 'claude' ? CLAUDE_TOOLS : CODEX_TOOLS)];
}

export async function handleWorkflowTool(
  agentKind: AgentKind,
  name: string,
  rawArgs: unknown,
  currentSlot: string,
): Promise<WorkflowToolResult> {
  const knownNames = new Set(getWorkflowTools(agentKind).map((tool) => tool.name));
  if (!knownNames.has(name)) return { handled: false };

  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const store = new WorkflowStore(WORKSPACE_ROOT);
  const config = loadWorkflowConfig();

  if (name === 'get_active_task') {
    const slot = typeof args.slot === 'string' && args.slot.trim() ? args.slot.trim() : currentSlot;
    const task = store.getActiveTask(slot);
    return {
      handled: true,
      payload: task ? taskView(task, agentKind) : { active_task: null, slot },
    };
  }

  const taskId = stringArg(args, 'task_id');

  if (agentKind === 'claude') {
    if (name === 'begin_design') {
      const task = await store.beginDesign(taskId);
      return { handled: true, payload: taskView(task, agentKind) };
    }
    if (name === 'submit_design') {
      const task = await store.submitDesign(taskId, {
        repositoryFacts: typeof args.repository_facts === 'string' ? args.repository_facts : undefined,
        requirements: stringArg(args, 'requirements'),
        architecture: stringArg(args, 'architecture'),
        implementationPlan: stringArg(args, 'implementation_plan'),
        acceptanceCriteria: stringArg(args, 'acceptance_criteria'),
        testPlan: stringArg(args, 'test_plan'),
        risks: stringArg(args, 'risks'),
      });
      return {
        handled: true,
        payload: taskView(task, agentKind),
        notification: {
          recipient: 'codex',
          text: `Workflow task ${task.task_id} design v${task.design_version} is ready for feasibility review. Call get_active_task, inspect the referenced artifacts and repository, then use submit_design_review. Do not modify project source code.`,
          wake_text: `Design review requested for ${task.task_id}. Call get_active_task and follow the Codex next_action.`,
        },
      };
    }
    if (name === 'submit_validation') {
      const verdict = stringArg(args, 'verdict');
      if (verdict !== 'pass' && verdict !== 'needs_changes') throw new Error(`Invalid validation verdict: ${verdict}`);
      const task = await store.submitValidation(taskId, {
        verdict,
        report: stringArg(args, 'report'),
      });
      return {
        handled: true,
        payload: taskView(task, agentKind),
        ...(verdict === 'needs_changes' ? {
          notification: {
            recipient: 'codex' as const,
            text: `Workflow task ${task.task_id} failed design validation. Read the latest validation-report artifact, fix only the reported implementation issues, and call report_implementation again.`,
            wake_text: `Implementation changes requested for ${task.task_id}. Call get_active_task and continue the approved implementation.`,
          },
        } : {}),
      };
    }
  }

  if (agentKind === 'codex') {
    if (name === 'submit_design_review') {
      const verdict = stringArg(args, 'verdict');
      if (verdict !== 'approved' && verdict !== 'changes_requested') throw new Error(`Invalid review verdict: ${verdict}`);
      const task = await store.submitDesignReview(taskId, {
        verdict,
        review: stringArg(args, 'review'),
        maxReviewRounds: config.max_review_rounds,
      });
      return {
        handled: true,
        payload: taskView(task, agentKind),
        ...(task.status === 'design_draft' ? {
          notification: {
            recipient: 'claude' as const,
            text: `Codex requested changes to workflow task ${task.task_id} design. Read the latest codex-review artifact, revise the design without modifying project source code, and call submit_design again.`,
            wake_text: `Design changes requested for ${task.task_id}. Call get_active_task and revise the design.`,
          },
        } : {}),
      };
    }
    if (name === 'start_implementation') {
      const task = await store.startImplementation(taskId);
      return { handled: true, payload: taskView(task, agentKind) };
    }
    if (name === 'request_design_change') {
      const task = await store.requestDesignChange(taskId, stringArg(args, 'reason'));
      return {
        handled: true,
        payload: taskView(task, agentKind),
        notification: {
          recipient: 'claude',
          text: `Codex stopped implementation of workflow task ${task.task_id} and requested a design change. Read the design-change-request artifact, revise the design, and call submit_design. Source implementation remains blocked until new user approval.`,
          wake_text: `Design change requested for ${task.task_id}. Call get_active_task and revise the design.`,
        },
      };
    }
    if (name === 'report_implementation') {
      const changedFiles = Array.isArray(args.changed_files)
        ? args.changed_files.filter((value): value is string => typeof value === 'string')
        : [];
      if (changedFiles.length === 0) throw new Error("Argument 'changed_files' must contain at least one file path.");
      const remainingRisks = typeof args.remaining_risks === 'string' && args.remaining_risks.trim()
        ? args.remaining_risks.trim()
        : 'None reported.';
      const report = [
        '# Implementation Report',
        '',
        '## Summary',
        '',
        stringArg(args, 'summary'),
        '',
        '## Changed Files',
        '',
        ...changedFiles.map((path) => `- ${path}`),
        '',
        '## Tests and Verification',
        '',
        stringArg(args, 'tests'),
        '',
        '## Remaining Risks',
        '',
        remainingRisks,
      ].join('\n');
      const task = await store.reportImplementation(taskId, report);
      return {
        handled: true,
        payload: taskView(task, agentKind),
        notification: {
          recipient: 'claude',
          text: `Codex completed implementation for workflow task ${task.task_id}. Call get_active_task, inspect the implementation-report artifact and actual diff/tests, then use submit_validation. Review only; do not fix source code.`,
          wake_text: `Design validation requested for ${task.task_id}. Call get_active_task and validate the Codex implementation.`,
        },
      };
    }
  }

  return { handled: false };
}

export function hasActiveWorkflowTask(slot: string): boolean {
  try {
    return new WorkflowStore(WORKSPACE_ROOT).getActiveTask(slot) !== null;
  } catch {
    return false;
  }
}
