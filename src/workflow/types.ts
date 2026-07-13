export type WorkflowAgent = 'claude' | 'codex' | 'user';

export type WorkflowTaskType = 'greenfield' | 'existing-change';

export type WorkflowTaskStatus =
  | 'discovery'
  | 'design_draft'
  | 'awaiting_review'
  | 'awaiting_approval'
  | 'approved'
  | 'implementing'
  | 'design_change_requested'
  | 'awaiting_validation'
  | 'awaiting_completion_approval'
  | 'completed'
  | 'cancelled';

export type WorkflowArtifactKind =
  | 'brief'
  | 'requirements'
  | 'repository-facts'
  | 'architecture'
  | 'implementation-plan'
  | 'acceptance-criteria'
  | 'test-plan'
  | 'risks'
  | 'codex-review'
  | 'design-change-request'
  | 'implementation-report'
  | 'validation-report';

export interface WorkflowArtifact {
  kind: WorkflowArtifactKind;
  path: string;
  sha256: string;
  version: number;
  created_by: WorkflowAgent;
  created_at: string;
}

export interface WorkflowTaskEvent {
  event_id: string;
  actor: WorkflowAgent;
  action: string;
  from_status?: WorkflowTaskStatus;
  to_status?: WorkflowTaskStatus;
  detail?: string;
  created_at: string;
}

export interface WorkflowTask {
  schema_version: 1;
  task_id: string;
  workspace_root: string;
  slot: string;
  type: WorkflowTaskType;
  title: string;
  goal: string;
  status: WorkflowTaskStatus;
  base_commit?: string;
  dirty_at_creation: boolean;
  read_only_fingerprint?: string;
  design_version: number;
  approved_design_version?: number;
  review_round: number;
  artifacts: WorkflowArtifact[];
  events: WorkflowTaskEvent[];
  created_at: string;
  updated_at: string;
  approved_at?: string;
  completed_at?: string;
  cancelled_at?: string;
}

export interface WorkflowTaskSummary {
  task_id: string;
  slot: string;
  type: WorkflowTaskType;
  title: string;
  status: WorkflowTaskStatus;
  design_version: number;
  updated_at: string;
}

export interface WorkflowModelPolicy {
  model_hint?: string;
  require_model_match: boolean;
}

export interface WorkflowConfig {
  schema_version: 1;
  enabled: boolean;
  claude: {
    role: 'lead_architect';
    model_hint?: string;
    require_model_match: boolean;
  };
  codex: {
    role: 'implementation_developer';
    model_hint?: string;
    require_model_match: boolean;
  };
  max_review_rounds: number;
  require_user_approval: boolean;
}

export const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowTaskStatus>([
  'completed',
  'cancelled',
]);

export const REQUIRED_DESIGN_ARTIFACTS: WorkflowArtifactKind[] = [
  'requirements',
  'architecture',
  'implementation-plan',
  'acceptance-criteria',
  'test-plan',
  'risks',
];
