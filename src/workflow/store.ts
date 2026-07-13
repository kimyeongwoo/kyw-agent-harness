import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { relative, resolve } from 'path';
import { spawnSync } from 'child_process';
import { DEFAULT_BRIDGE_SLOT } from '../lib/constants.js';
import { isProcessAlive } from '../lib/process-utils.js';
import {
  REQUIRED_DESIGN_ARTIFACTS,
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowAgent,
  type WorkflowArtifact,
  type WorkflowArtifactKind,
  type WorkflowTask,
  type WorkflowTaskStatus,
  type WorkflowTaskSummary,
  type WorkflowTaskType,
} from './types.js';

const TASK_ID_PATTERN = /^task_[a-z0-9]{12}$/;
const LOCK_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 15_000;

const ARTIFACT_FILE_NAMES: Record<WorkflowArtifactKind, string> = {
  brief: 'brief',
  requirements: 'requirements',
  'repository-facts': 'repository-facts',
  architecture: 'architecture',
  'implementation-plan': 'implementation-plan',
  'acceptance-criteria': 'acceptance-criteria',
  'test-plan': 'test-plan',
  risks: 'risks',
  'codex-review': 'codex-review',
  'design-change-request': 'design-change-request',
  'implementation-report': 'implementation-report',
  'validation-report': 'validation-report',
};

function nowIso(): string {
  return new Date().toISOString();
}

function createTaskId(): string {
  return `task_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function createEventId(): string {
  return `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function normalizeMarkdown(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) throw new Error('Artifact content must not be empty.');
  return `${normalized}\n`;
}

function normalizeGitStatus(text: string): string {
  return text
    .replace(/\\/g, '/')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const path = line.length > 3 ? line.slice(3).replace(/^"|"$/g, '') : line;
      return path !== '.bridge' && !path.startsWith('.bridge/');
    })
    .sort()
    .join('\n');
}

function getWorkingTreeFingerprint(workspaceRoot: string): string | undefined {
  try {
    const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (status.status !== 0) return undefined;
    const unstaged = spawnSync('git', ['diff', '--binary', '--no-ext-diff'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const staged = spawnSync('git', ['diff', '--binary', '--cached', '--no-ext-diff'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const hash = createHash('sha256');
    hash.update(normalizeGitStatus(status.stdout));
    hash.update('\0unstaged\0');
    hash.update(unstaged.status === 0 ? unstaged.stdout : '');
    hash.update('\0staged\0');
    hash.update(staged.status === 0 ? staged.stdout : '');

    if (untracked.status === 0) {
      const paths = untracked.stdout
        .replace(/\\/g, '/')
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((path) => path !== '.bridge' && !path.startsWith('.bridge/'))
        .sort();
      for (const path of paths) {
        hash.update(`\0untracked:${path}\0`);
        try { hash.update(readFileSync(resolve(workspaceRoot, path))); } catch {}
      }
    }

    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

function getGitSnapshot(workspaceRoot: string): { baseCommit?: string; dirty: boolean; fingerprint?: string } {
  try {
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const normalizedStatus = normalizeGitStatus(status.stdout);
    return {
      baseCommit: commit.status === 0 ? commit.stdout.trim() || undefined : undefined,
      dirty: status.status === 0 ? normalizedStatus.length > 0 : false,
      fingerprint: status.status === 0 ? getWorkingTreeFingerprint(workspaceRoot) : undefined,
    };
  } catch {
    return { dirty: false };
  }
}

export class WorkflowStore {
  readonly tasksDir: string;
  private readonly lockPath: string;

  constructor(readonly workspaceRoot: string) {
    this.tasksDir = resolve(workspaceRoot, '.bridge', 'tasks');
    this.lockPath = resolve(this.tasksDir, '.workflow.lock');
  }

  async createTask(input: {
    type: WorkflowTaskType;
    title: string;
    goal: string;
    slot?: string;
  }): Promise<WorkflowTask> {
    const title = input.title.trim();
    const goal = input.goal.trim();
    const slot = input.slot?.trim() || DEFAULT_BRIDGE_SLOT;
    if (!title) throw new Error('Task title is required.');
    if (!goal) throw new Error('Task goal is required.');
    if (input.type !== 'greenfield' && input.type !== 'existing-change') {
      throw new Error(`Unsupported task type: ${input.type}`);
    }

    return await this.withLock(async () => {
      const active = this.listTasksUnlocked().find(
        (task) => task.slot === slot && !TERMINAL_WORKFLOW_STATUSES.has(task.status),
      );
      if (active) {
        throw new Error(
          `Active task already exists for slot '${slot}': ${active.task_id} (${active.status})`,
        );
      }

      const snapshot = getGitSnapshot(this.workspaceRoot);
      const createdAt = nowIso();
      const task: WorkflowTask = {
        schema_version: 1,
        task_id: createTaskId(),
        workspace_root: this.workspaceRoot,
        slot,
        type: input.type,
        title,
        goal,
        status: 'discovery',
        base_commit: snapshot.baseCommit,
        dirty_at_creation: snapshot.dirty,
        read_only_fingerprint: snapshot.fingerprint,
        design_version: 0,
        review_round: 0,
        artifacts: [],
        events: [],
        created_at: createdAt,
        updated_at: createdAt,
      };

      this.addEvent(task, 'user', 'task_created', undefined, 'discovery', goal);
      this.writeArtifactUnlocked(task, 'user', 'brief', this.renderBrief(task), 1);
      this.writeTaskUnlocked(task);
      return task;
    });
  }

  listTasks(): WorkflowTaskSummary[] {
    return this.listTasksUnlocked()
      .map((task) => ({
        task_id: task.task_id,
        slot: task.slot,
        type: task.type,
        title: task.title,
        status: task.status,
        design_version: task.design_version,
        updated_at: task.updated_at,
      }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getTask(taskId: string): WorkflowTask {
    this.validateTaskId(taskId);
    const path = this.taskManifestPath(taskId);
    if (!existsSync(path)) throw new Error(`Workflow task not found: ${taskId}`);
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowTask;
    } catch (error) {
      throw new Error(`Failed to read workflow task ${taskId}: ${error}`);
    }
  }

  getActiveTask(slot?: string): WorkflowTask | null {
    const normalizedSlot = slot?.trim();
    return this.listTasksUnlocked()
      .filter((task) => !TERMINAL_WORKFLOW_STATUSES.has(task.status))
      .filter((task) => !normalizedSlot || task.slot === normalizedSlot)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }

  async beginDesign(taskId: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['discovery', 'design_draft', 'design_change_requested']);
      this.assertReadOnlyUnchanged(task, 'Claude design');
      this.transition(task, 'claude', 'design_started', 'design_draft');
    });
  }

  async submitDesign(taskId: string, input: {
    repositoryFacts?: string;
    requirements: string;
    architecture: string;
    implementationPlan: string;
    acceptanceCriteria: string;
    testPlan: string;
    risks: string;
  }): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['discovery', 'design_draft', 'design_change_requested']);
      this.assertReadOnlyUnchanged(task, 'Claude design');
      const version = task.design_version + 1;
      if (task.type === 'existing-change' && !input.repositoryFacts?.trim()) {
        throw new Error('Existing-change tasks require repositoryFacts with source evidence.');
      }
      if (input.repositoryFacts?.trim()) {
        this.writeArtifactUnlocked(task, 'claude', 'repository-facts', input.repositoryFacts, version);
      }
      this.writeArtifactUnlocked(task, 'claude', 'requirements', input.requirements, version);
      this.writeArtifactUnlocked(task, 'claude', 'architecture', input.architecture, version);
      this.writeArtifactUnlocked(task, 'claude', 'implementation-plan', input.implementationPlan, version);
      this.writeArtifactUnlocked(task, 'claude', 'acceptance-criteria', input.acceptanceCriteria, version);
      this.writeArtifactUnlocked(task, 'claude', 'test-plan', input.testPlan, version);
      this.writeArtifactUnlocked(task, 'claude', 'risks', input.risks, version);
      task.design_version = version;
      task.approved_design_version = undefined;
      task.approved_at = undefined;
      task.read_only_fingerprint = getWorkingTreeFingerprint(this.workspaceRoot);
      this.transition(task, 'claude', 'design_submitted', 'awaiting_review', `design v${version}`);
    });
  }

  async submitDesignReview(taskId: string, input: {
    verdict: 'approved' | 'changes_requested';
    review: string;
    maxReviewRounds?: number;
  }): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['awaiting_review']);
      this.assertReadOnlyUnchanged(task, 'Codex design review');
      const reviewRound = task.review_round + 1;
      const artifactVersion = this.nextArtifactVersion(task, 'codex-review');
      this.writeArtifactUnlocked(task, 'codex', 'codex-review', input.review, artifactVersion);
      task.review_round = reviewRound;

      if (input.verdict === 'approved') {
        this.transition(task, 'codex', 'design_review_approved', 'awaiting_approval', `review round ${reviewRound}`);
        return;
      }

      const maxRounds = Math.max(1, input.maxReviewRounds ?? 2);
      if (reviewRound >= maxRounds) {
        this.transition(
          task,
          'codex',
          'design_review_escalated',
          'awaiting_approval',
          `changes remain after ${reviewRound} review rounds; user decision required`,
        );
        return;
      }
      task.read_only_fingerprint = getWorkingTreeFingerprint(this.workspaceRoot);
      this.transition(task, 'codex', 'design_review_changes_requested', 'design_draft', `review round ${reviewRound}`);
    });
  }

  async approveTask(taskId: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['awaiting_approval']);
      this.assertReadOnlyUnchanged(task, 'User design approval');
      this.requireCompleteDesign(task);
      task.approved_design_version = task.design_version;
      task.approved_at = nowIso();
      this.transition(task, 'user', 'design_approved', 'approved', `design v${task.design_version}`);
    });
  }

  async requestUserChanges(taskId: string, reason: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['awaiting_approval']);
      const detail = reason.trim();
      if (!detail) throw new Error('A change reason is required.');
      task.review_round = 0;
      task.read_only_fingerprint = getWorkingTreeFingerprint(this.workspaceRoot);
      this.transition(task, 'user', 'design_changes_requested', 'design_draft', detail);
    });
  }

  async startImplementation(taskId: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['approved']);
      this.assertReadOnlyUnchanged(task, 'Codex implementation start');
      if (task.approved_design_version !== task.design_version) {
        throw new Error('The current design version has not been approved by the user.');
      }
      this.transition(task, 'codex', 'implementation_started', 'implementing', `design v${task.design_version}`);
    });
  }

  async requestDesignChange(taskId: string, reason: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['approved', 'implementing']);
      const detail = reason.trim();
      if (!detail) throw new Error('A design change reason is required.');
      const version = this.nextArtifactVersion(task, 'design-change-request');
      this.writeArtifactUnlocked(task, 'codex', 'design-change-request', detail, version);
      task.approved_design_version = undefined;
      task.review_round = 0;
      task.read_only_fingerprint = getWorkingTreeFingerprint(this.workspaceRoot);
      this.transition(task, 'codex', 'design_change_requested', 'design_change_requested', detail);
    });
  }

  async reportImplementation(taskId: string, report: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['implementing']);
      const version = this.nextArtifactVersion(task, 'implementation-report');
      this.writeArtifactUnlocked(task, 'codex', 'implementation-report', report, version);
      task.read_only_fingerprint = getWorkingTreeFingerprint(this.workspaceRoot);
      this.transition(task, 'codex', 'implementation_reported', 'awaiting_validation');
    });
  }

  async submitValidation(taskId: string, input: {
    verdict: 'pass' | 'needs_changes';
    report: string;
  }): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['awaiting_validation']);
      this.assertReadOnlyUnchanged(task, 'Claude implementation validation');
      const version = this.nextArtifactVersion(task, 'validation-report');
      this.writeArtifactUnlocked(task, 'claude', 'validation-report', input.report, version);
      if (input.verdict === 'pass') {
        this.transition(task, 'claude', 'validation_passed', 'awaiting_completion_approval');
      } else {
        this.transition(task, 'claude', 'validation_failed', 'implementing');
      }
    });
  }

  async completeTask(taskId: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      this.requireStatus(task, ['awaiting_completion_approval']);
      task.completed_at = nowIso();
      this.transition(task, 'user', 'task_completed', 'completed');
    });
  }

  async cancelTask(taskId: string, reason?: string): Promise<WorkflowTask> {
    return await this.mutateTask(taskId, (task) => {
      if (TERMINAL_WORKFLOW_STATUSES.has(task.status)) {
        throw new Error(`Task ${task.task_id} is already ${task.status}.`);
      }
      task.cancelled_at = nowIso();
      this.transition(task, 'user', 'task_cancelled', 'cancelled', reason?.trim() || undefined);
    });
  }

  readArtifact(task: WorkflowTask, kind: WorkflowArtifactKind, version?: number): string {
    const matches = task.artifacts
      .filter((artifact) => artifact.kind === kind)
      .filter((artifact) => version === undefined || artifact.version === version)
      .sort((a, b) => b.version - a.version);
    const artifact = matches[0];
    if (!artifact) throw new Error(`Artifact '${kind}' not found for task ${task.task_id}.`);
    return readFileSync(resolve(this.workspaceRoot, artifact.path), 'utf-8');
  }

  private async mutateTask(taskId: string, mutate: (task: WorkflowTask) => void): Promise<WorkflowTask> {
    return await this.withLock(async () => {
      const task = this.getTask(taskId);
      mutate(task);
      task.updated_at = nowIso();
      this.writeTaskUnlocked(task);
      return task;
    });
  }

  private renderBrief(task: WorkflowTask): string {
    return [
      `# ${task.title}`,
      '',
      `- Task ID: ${task.task_id}`,
      `- Type: ${task.type}`,
      `- Slot: ${task.slot}`,
      `- Base commit: ${task.base_commit ?? '(not a Git repository)'}`,
      `- Dirty at creation: ${task.dirty_at_creation ? 'yes' : 'no'}`,
      '',
      '## Goal',
      '',
      task.goal,
    ].join('\n');
  }

  private requireCompleteDesign(task: WorkflowTask): void {
    if (task.design_version <= 0) throw new Error('No design has been submitted.');
    const missing = REQUIRED_DESIGN_ARTIFACTS.filter(
      (kind) => !task.artifacts.some((artifact) => artifact.kind === kind && artifact.version === task.design_version),
    );
    if (missing.length > 0) {
      throw new Error(`Design v${task.design_version} is missing artifacts: ${missing.join(', ')}`);
    }
  }

  private assertReadOnlyUnchanged(task: WorkflowTask, phase: string): void {
    if (!task.read_only_fingerprint) return;
    const current = getWorkingTreeFingerprint(this.workspaceRoot);
    if (current && current !== task.read_only_fingerprint) {
      throw new Error(
        `${phase} changed the Git working tree during a read-only phase. Revert or explicitly preserve the changes before continuing.`,
      );
    }
  }

  private requireStatus(task: WorkflowTask, allowed: WorkflowTaskStatus[]): void {
    if (!allowed.includes(task.status)) {
      throw new Error(
        `Task ${task.task_id} is '${task.status}', expected one of: ${allowed.join(', ')}`,
      );
    }
  }

  private transition(
    task: WorkflowTask,
    actor: WorkflowAgent,
    action: string,
    toStatus: WorkflowTaskStatus,
    detail?: string,
  ): void {
    const fromStatus = task.status;
    task.status = toStatus;
    this.addEvent(task, actor, action, fromStatus, toStatus, detail);
  }

  private addEvent(
    task: WorkflowTask,
    actor: WorkflowAgent,
    action: string,
    fromStatus?: WorkflowTaskStatus,
    toStatus?: WorkflowTaskStatus,
    detail?: string,
  ): void {
    const timestamp = nowIso();
    task.events.push({
      event_id: createEventId(),
      actor,
      action,
      from_status: fromStatus,
      to_status: toStatus,
      detail,
      created_at: timestamp,
    });
    task.updated_at = timestamp;
  }

  private nextArtifactVersion(task: WorkflowTask, kind: WorkflowArtifactKind): number {
    return Math.max(0, ...task.artifacts.filter((artifact) => artifact.kind === kind).map((artifact) => artifact.version)) + 1;
  }

  private writeArtifactUnlocked(
    task: WorkflowTask,
    actor: WorkflowAgent,
    kind: WorkflowArtifactKind,
    content: string,
    version: number,
  ): WorkflowArtifact {
    const normalized = normalizeMarkdown(content);
    const artifactDir = resolve(this.taskDir(task.task_id), 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    const fileName = `${ARTIFACT_FILE_NAMES[kind]}-v${version}.md`;
    const absolutePath = resolve(artifactDir, fileName);
    writeFileSync(absolutePath, normalized, 'utf-8');

    const artifact: WorkflowArtifact = {
      kind,
      path: relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/'),
      sha256: sha256(normalized),
      version,
      created_by: actor,
      created_at: nowIso(),
    };
    task.artifacts = task.artifacts.filter(
      (existing) => !(existing.kind === kind && existing.version === version),
    );
    task.artifacts.push(artifact);
    return artifact;
  }

  private listTasksUnlocked(): WorkflowTask[] {
    if (!existsSync(this.tasksDir)) return [];
    const tasks: WorkflowTask[] = [];
    for (const entry of readdirSync(this.tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
      try {
        tasks.push(this.getTask(entry.name));
      } catch {}
    }
    return tasks;
  }

  private writeTaskUnlocked(task: WorkflowTask): void {
    const dir = this.taskDir(task.task_id);
    mkdirSync(dir, { recursive: true });
    const target = this.taskManifestPath(task.task_id);
    const temporary = resolve(dir, `.task-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, 'utf-8');
    renameSync(temporary, target);
  }

  private taskDir(taskId: string): string {
    this.validateTaskId(taskId);
    return resolve(this.tasksDir, taskId);
  }

  private taskManifestPath(taskId: string): string {
    return resolve(this.taskDir(taskId), 'task.json');
  }

  private validateTaskId(taskId: string): void {
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid workflow task ID: ${taskId}`);
  }

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    mkdirSync(this.tasksDir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: Date.now() }));
        closeSync(fd);
        try {
          return await fn();
        } finally {
          try { unlinkSync(this.lockPath); } catch {}
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        try {
          const lock = JSON.parse(readFileSync(this.lockPath, 'utf-8')) as { pid?: number; created_at?: number };
          const age = Date.now() - (lock.created_at ?? statSync(this.lockPath).mtimeMs);
          if (age > LOCK_STALE_MS || !isProcessAlive(lock.pid)) {
            rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          try { rmSync(this.lockPath, { force: true }); } catch {}
          continue;
        }
        await Bun.sleep(20);
      }
    }
    throw new Error('Timed out waiting for workflow task lock.');
  }
}
