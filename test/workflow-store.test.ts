import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { WorkflowStore } from '../src/workflow/store.js';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'kah-workflow-'));
}

const DESIGN = {
  repositoryFacts: '# Repository Facts\n\n- Existing entry point: `src/index.ts`.',
  requirements: '# Requirements\n\n## Goals\n\n- Add the feature safely.\n\n## Non-goals\n\n- No unrelated refactor.',
  architecture: '# Architecture\n\nUse a modular service boundary.',
  implementationPlan: '# Implementation Plan\n\n1. Add the service.\n2. Add tests.',
  acceptanceCriteria: '# Acceptance Criteria\n\n- The feature works.\n- Existing behavior remains compatible.',
  testPlan: '# Test Plan\n\n- Unit tests\n- Integration tests',
  risks: '# Risks\n\n- Migration risk with rollback.',
};

describe('WorkflowStore', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      try { rmSync(workspaces.pop()!, { recursive: true, force: true }); } catch {}
    }
  });

  function setup(): { root: string; store: WorkflowStore } {
    const root = makeWorkspace();
    workspaces.push(root);
    return { root, store: new WorkflowStore(root) };
  }

  it('runs the complete Fable design -> approval -> Codex implementation workflow', async () => {
    const { root, store } = setup();
    let task = await store.createTask({
      type: 'existing-change',
      title: 'Add audit history',
      goal: 'Design and implement audit history without breaking existing APIs.',
      slot: 'audit',
    });

    expect(task.status).toBe('discovery');
    expect(task.artifacts.some((artifact) => artifact.kind === 'brief')).toBe(true);
    expect(store.getActiveTask('audit')?.task_id).toBe(task.task_id);

    task = await store.beginDesign(task.task_id);
    expect(task.status).toBe('design_draft');

    task = await store.submitDesign(task.task_id, DESIGN);
    expect(task.status).toBe('awaiting_review');
    expect(task.design_version).toBe(1);
    expect(task.artifacts.filter((artifact) => artifact.version === 1)).toHaveLength(8);
    for (const artifact of task.artifacts) {
      expect(artifact.path.includes('..')).toBe(false);
      expect(artifact.sha256).toHaveLength(64);
      expect(existsSync(resolve(root, artifact.path))).toBe(true);
    }

    task = await store.submitDesignReview(task.task_id, {
      verdict: 'approved',
      review: '# Codex Review\n\nThe plan is implementable.',
    });
    expect(task.status).toBe('awaiting_approval');

    task = await store.approveTask(task.task_id);
    expect(task.status).toBe('approved');
    expect(task.approved_design_version).toBe(1);

    task = await store.startImplementation(task.task_id);
    expect(task.status).toBe('implementing');

    task = await store.reportImplementation(task.task_id, '# Implementation Report\n\nAll changes and tests completed.');
    expect(task.status).toBe('awaiting_validation');

    task = await store.submitValidation(task.task_id, {
      verdict: 'pass',
      report: '# Validation\n\nImplementation conforms to design v1.',
    });
    expect(task.status).toBe('awaiting_completion_approval');

    task = await store.completeTask(task.task_id);
    expect(task.status).toBe('completed');
    expect(store.getActiveTask('audit')).toBeNull();

    const persisted = JSON.parse(readFileSync(resolve(root, '.bridge', 'tasks', task.task_id, 'task.json'), 'utf-8'));
    expect(persisted.events.map((event: { action: string }) => event.action)).toContain('task_completed');
  });

  it('blocks Codex implementation before user approval', async () => {
    const { store } = setup();
    const task = await store.createTask({
      type: 'greenfield',
      title: 'New service',
      goal: 'Create a new service architecture.',
    });

    expect(store.startImplementation(task.task_id)).rejects.toThrow("expected one of: approved");
  });

  it('invalidates approval when Codex requests a design change', async () => {
    const { store } = setup();
    let task = await store.createTask({ type: 'existing-change', title: 'Change API', goal: 'Change the API safely.' });
    task = await store.submitDesign(task.task_id, DESIGN);
    task = await store.submitDesignReview(task.task_id, { verdict: 'approved', review: 'Ready.' });
    task = await store.approveTask(task.task_id);
    task = await store.startImplementation(task.task_id);
    task = await store.requestDesignChange(task.task_id, 'The proposed API does not exist in the repository.');

    expect(task.status).toBe('design_change_requested');
    expect(task.approved_design_version).toBeUndefined();
    expect(task.artifacts.some((artifact) => artifact.kind === 'design-change-request')).toBe(true);

    task = await store.submitDesign(task.task_id, {
      ...DESIGN,
      architecture: `${DESIGN.architecture}\n\nUse the actual repository API.`,
    });
    expect(task.design_version).toBe(2);
    expect(task.status).toBe('awaiting_review');
  });

  it('allows only one active task per slot but permits another slot', async () => {
    const { store } = setup();
    await store.createTask({ type: 'greenfield', title: 'A', goal: 'Goal A', slot: 'default' });

    expect(store.createTask({ type: 'greenfield', title: 'B', goal: 'Goal B', slot: 'default' }))
      .rejects.toThrow('Active task already exists');

    const other = await store.createTask({ type: 'greenfield', title: 'C', goal: 'Goal C', slot: 'parallel' });
    expect(other.slot).toBe('parallel');
  });

  it('escalates to the user after the configured review round limit', async () => {
    const { store } = setup();
    let task = await store.createTask({ type: 'greenfield', title: 'Review loop', goal: 'Avoid an endless review loop.' });
    task = await store.submitDesign(task.task_id, DESIGN);
    task = await store.submitDesignReview(task.task_id, {
      verdict: 'changes_requested',
      review: 'First revision required.',
      maxReviewRounds: 2,
    });
    expect(task.status).toBe('design_draft');

    task = await store.submitDesign(task.task_id, DESIGN);
    task = await store.submitDesignReview(task.task_id, {
      verdict: 'changes_requested',
      review: 'One issue remains and requires a user decision.',
      maxReviewRounds: 2,
    });
    expect(task.status).toBe('awaiting_approval');
    expect(task.events.at(-1)?.action).toBe('design_review_escalated');
  });

  it('rejects a design submission when source files changed during the read-only phase', async () => {
    const { root, store } = setup();
    writeFileSync(resolve(root, 'app.ts'), 'export const value = 1;\n');
    Bun.spawnSync(['git', 'init'], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: root });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: root });
    Bun.spawnSync(['git', 'add', 'app.ts'], { cwd: root });
    Bun.spawnSync(['git', 'commit', '-m', 'initial'], { cwd: root, stdout: 'ignore', stderr: 'ignore' });

    const task = await store.createTask({
      type: 'existing-change',
      title: 'Read-only guard',
      goal: 'Design without modifying source files.',
    });
    expect(task.dirty_at_creation).toBe(false);

    writeFileSync(resolve(root, 'app.ts'), 'export const value = 2;\n');

    expect(store.submitDesign(task.task_id, DESIGN)).rejects.toThrow('changed the Git working tree');
    expect(store.getTask(task.task_id).status).toBe('discovery');
  });

  it('detects additional edits to a file that was already dirty when the task started', async () => {
    const { root, store } = setup();
    writeFileSync(resolve(root, 'app.ts'), 'export const value = 1;\n');
    Bun.spawnSync(['git', 'init'], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: root });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: root });
    Bun.spawnSync(['git', 'add', 'app.ts'], { cwd: root });
    Bun.spawnSync(['git', 'commit', '-m', 'initial'], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
    writeFileSync(resolve(root, 'app.ts'), 'export const value = 2;\n');

    const task = await store.createTask({
      type: 'existing-change',
      title: 'Dirty baseline guard',
      goal: 'Preserve pre-existing user changes during design.',
    });
    expect(task.dirty_at_creation).toBe(true);

    writeFileSync(resolve(root, 'app.ts'), 'export const value = 3;\n');
    expect(store.submitDesign(task.task_id, DESIGN)).rejects.toThrow('changed the Git working tree');
  });
});
