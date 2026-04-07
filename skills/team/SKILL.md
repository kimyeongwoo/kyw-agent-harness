---
name: team
description: N coordinated agents on shared task list using Claude Code native teams
argument-hint: "[N:agent-type] <task description>"
aliases: []
level: 4
---

# Team Skill

Spawn N coordinated agents working on a shared task list using Claude Code's native team tools (`TeamCreate`, `Task` with `team_name`, `SendMessage`, `TeamDelete`). Provides built-in team management, inter-agent messaging, and task dependencies — no external dependencies required.

## Usage

```
/team N:agent-type "task description"
/team "task description"
```

### Parameters

- **N** — Number of teammate agents (1-20). Optional; defaults to auto-sizing based on task decomposition.
- **agent-type** — Agent to spawn for the `team-exec` stage (e.g., `executor`, `debugger`). Optional; defaults to stage-aware routing. See Stage Agent Routing below.
- **task** — High-level task to decompose and distribute among teammates.

### Examples

```bash
/team 5:executor "fix all TypeScript errors across the project"
/team 3:debugger "fix build errors in src/"
/team "refactor the auth module with security review"
```

## Architecture

```
User: "/team 3:executor fix all TypeScript errors"
              |
              v
      [TEAM ORCHESTRATOR (Lead)]
              |
              +-- TeamCreate("fix-ts-errors")
              |       -> lead becomes team-lead@fix-ts-errors
              |
              +-- Analyze & decompose task into subtasks
              |       -> explore/architect produces subtask list
              |
              +-- TaskCreate x N (one per subtask)
              |       -> tasks #1, #2, #3 with dependencies
              |
              +-- TaskUpdate x N (pre-assign owners)
              |       -> task #1 owner=worker-1, etc.
              |
              +-- Task(team_name="fix-ts-errors", name="worker-1") x 3
              |       -> spawns teammates into the team
              |
              +-- Monitor loop
              |       <- SendMessage from teammates (auto-delivered)
              |       -> TaskList polling for progress
              |       -> SendMessage to unblock/coordinate
              |
              +-- Completion
                      -> SendMessage(shutdown_request) to each teammate
                      <- SendMessage(shutdown_response, approve: true)
                      -> TeamDelete("fix-ts-errors")
```

**Storage layout (managed by Claude Code):**
```
~/.claude/
  teams/fix-ts-errors/
    config.json          # Team metadata + members array
  tasks/fix-ts-errors/
    .lock                # File lock for concurrent access
    1.json               # Subtask #1
    2.json               # Subtask #2 (may be internal)
    3.json               # Subtask #3
    ...
```

## Staged Pipeline (Canonical Team Runtime)

Team execution follows a staged pipeline:

`team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`

### Stage Agent Routing

Each pipeline stage uses **specialized agents** — not just executors. The lead selects agents based on the stage and task characteristics.

| Stage | Required Agents | Optional Agents | Selection Criteria |
|-------|----------------|-----------------|-------------------|
| **team-plan** | `explore` (haiku), `planner` (opus) | `analyst` (opus), `architect` (opus) | Use `analyst` for unclear requirements. Use `architect` for systems with complex boundaries. |
| **team-prd** | `analyst` (opus) | `critic` (opus) | Use `critic` to challenge scope. |
| **team-exec** | `executor` (sonnet) | `executor` (opus), `debugger` (sonnet) | Match agent to subtask type. Use `executor` (opus) for complex autonomous work, `debugger` for compilation issues. |
| **team-verify** | `verifier` (sonnet) | `critic` (opus) | Always run `verifier`. Add `critic` for >20 files or architectural changes. |
| **team-fix** | `executor` (sonnet) | `debugger` (sonnet), `executor` (opus) | Use `debugger` for type/build errors and regression isolation. Use `executor` (opus) for complex multi-file fixes. |

**Routing rules:**

1. **The lead picks agents per stage, not the user.** The user's `N:agent-type` parameter only overrides the `team-exec` stage worker type. All other stages use stage-appropriate specialists.
2. **Specialist agents complement executor agents.** Route analysis/review to architect/critic agents.
3. **Risk level escalates review.** Security-sensitive or >20 file changes must include `critic` in `team-verify`.

### Stage Entry/Exit Criteria

- **team-plan**
  - Entry: Team invocation is parsed and orchestration starts.
  - Agents: `explore` scans codebase, `planner` creates task graph, optionally `analyst`/`architect` for complex tasks.
  - Exit: decomposition is complete and a runnable task graph is prepared.
- **team-prd**
  - Entry: scope is ambiguous or acceptance criteria are missing.
  - Agents: `analyst` extracts requirements, optionally `critic`.
  - Exit: acceptance criteria and boundaries are explicit.
- **team-exec**
  - Entry: `TeamCreate`, `TaskCreate`, assignment, and worker spawn are complete.
  - Agents: workers spawned as the appropriate specialist type per subtask (see routing table).
  - Exit: execution tasks reach terminal state for the current pass.
- **team-verify**
  - Entry: execution pass finishes.
  - Agents: `verifier` + task-appropriate reviewers (see routing table).
  - Exit (pass): verification gates pass with no required follow-up.
  - Exit (fail): fix tasks are generated and control moves to `team-fix`.
- **team-fix**
  - Entry: verification found defects/regressions/incomplete criteria.
  - Agents: `executor`/`debugger` depending on defect type.
  - Exit: fixes are complete and flow returns to `team-exec` then `team-verify`.

### Verify/Fix Loop and Stop Conditions

Continue `team-exec -> team-verify -> team-fix` until:
1. verification passes and no required fix tasks remain, or
2. work reaches an explicit terminal blocked/failed outcome with evidence.

`team-fix` is bounded by max attempts. If fix attempts exceed the configured limit (default: 3), transition to terminal `failed` (no infinite loop).

### Stage Handoff Convention

When transitioning between stages, important context — decisions made, alternatives rejected, risks identified — lives only in the lead's conversation history. If the lead's context compacts or agents restart, this knowledge is lost.

**Each completing stage MUST produce a handoff document before transitioning.**

The lead writes handoffs to `handoffs/<stage-name>.md` (relative to the working directory).

#### Handoff Format

```markdown
## Handoff: <current-stage> → <next-stage>
- **Decided**: [key decisions made in this stage]
- **Rejected**: [alternatives considered and why they were rejected]
- **Risks**: [identified risks for the next stage]
- **Files**: [key files created or modified]
- **Remaining**: [items left for the next stage to handle]
```

#### Handoff Rules

1. **Lead reads previous handoff BEFORE spawning next stage's agents.** The handoff content is included in the next stage's agent spawn prompts, ensuring agents start with full context.
2. **Handoffs accumulate.** The verify stage can read all prior handoffs (plan → prd → exec) for full decision history.
3. **On team cancellation, handoffs survive** in `handoffs/` for session resume. They are not deleted by `TeamDelete`.
4. **Handoffs are lightweight.** 10-20 lines max. They capture decisions and rationale, not full specifications (those live in deliverable files like DESIGN.md).

#### Example

```markdown
## Handoff: team-plan → team-exec
- **Decided**: Microservice architecture with 3 services (auth, api, worker). PostgreSQL for persistence. JWT for auth tokens.
- **Rejected**: Monolith (scaling concerns), MongoDB (team expertise is SQL), session cookies (API-first design).
- **Risks**: Worker service needs Redis for job queue — not yet provisioned. Auth service has no rate limiting in initial design.
- **Files**: DESIGN.md, TEST_STRATEGY.md
- **Remaining**: Database migration scripts, CI/CD pipeline config, Redis provisioning.
```

### Resume and Cancel Semantics

- **Resume:** restart from the last non-terminal stage using staged state + live task status. Read `handoffs/` to recover stage transition context.
- **Cancel:** request teammate shutdown, wait for responses (best effort), mark phase `cancelled`, capture cancellation metadata, then delete team resources. Handoff files in `handoffs/` are preserved for potential resume.
- Terminal states are `complete`, `failed`, and `cancelled`.

## Workflow

### Phase 1: Parse Input

- Extract **N** (agent count), validate 1-20
- Extract **agent-type**, validate it maps to a known subagent
- Extract **task** description

### Phase 2: Analyze & Decompose

Use `explore` or `architect` (via Task tool) to analyze the codebase and break the task into N subtasks:

- Each subtask should be **file-scoped** or **module-scoped** to avoid conflicts
- Subtasks must be independent or have clear dependency ordering
- Each subtask needs a concise `subject` and detailed `description`
- Identify dependencies between subtasks (e.g., "shared types must be fixed before consumers")

### Phase 3: Create Team

Call `TeamCreate` with a slug derived from the task:

```json
{
  "team_name": "fix-ts-errors",
  "description": "Fix all TypeScript errors across the project"
}
```

**Response:**
```json
{
  "team_name": "fix-ts-errors",
  "team_file_path": "~/.claude/teams/fix-ts-errors/config.json",
  "lead_agent_id": "team-lead@fix-ts-errors"
}
```

The current session becomes the team lead (`team-lead@fix-ts-errors`).

### Phase 4: Create Tasks

Call `TaskCreate` for each subtask. Set dependencies with `TaskUpdate` using `addBlockedBy`.

```json
// TaskCreate for subtask 1
{
  "subject": "Fix type errors in src/auth/",
  "description": "Fix all TypeScript errors in src/auth/login.ts, src/auth/session.ts, and src/auth/types.ts. Run tsc --noEmit to verify.",
  "activeForm": "Fixing auth type errors"
}
```

**Response stores a task file (e.g. `1.json`):**
```json
{
  "id": "1",
  "subject": "Fix type errors in src/auth/",
  "description": "Fix all TypeScript errors in src/auth/login.ts...",
  "activeForm": "Fixing auth type errors",
  "owner": "",
  "status": "pending",
  "blocks": [],
  "blockedBy": []
}
```

For tasks with dependencies, use `TaskUpdate` after creation:

```json
// Task #3 depends on task #1 (shared types must be fixed first)
{
  "taskId": "3",
  "addBlockedBy": ["1"]
}
```

**Pre-assign owners from the lead** to avoid race conditions (there is no atomic claiming):

```json
// Assign task #1 to worker-1
{
  "taskId": "1",
  "owner": "worker-1"
}
```

### Phase 5: Spawn Teammates

Spawn N teammates using `Task` with `team_name` and `name` parameters. Each teammate gets the team worker preamble (see below) plus their specific assignment.

```json
{
  "subagent_type": "executor",
  "team_name": "fix-ts-errors",
  "name": "worker-1",
  "prompt": "<worker-preamble + assigned tasks>"
}
```

**Response:**
```json
{
  "agent_id": "worker-1@fix-ts-errors",
  "name": "worker-1",
  "team_name": "fix-ts-errors"
}
```

**Side effects:**
- Teammate added to `config.json` members array
- An **internal task** is auto-created (with `metadata._internal: true`) tracking the agent lifecycle
- Internal tasks appear in `TaskList` output — filter them when counting real tasks

**IMPORTANT:** Spawn all teammates in parallel (they are background agents). Do NOT wait for one to finish before spawning the next.

### Phase 6: Monitor

The lead orchestrator monitors progress through two channels:

1. **Inbound messages** — Teammates send `SendMessage` to `team-lead` when they complete tasks or need help. These arrive automatically as new conversation turns (no polling needed).

2. **TaskList polling** — Periodically call `TaskList` to check overall progress:
   ```
   #1 [completed] Fix type errors in src/auth/ (worker-1)
   #3 [in_progress] Fix type errors in src/api/ (worker-2)
   #5 [pending] Fix type errors in src/utils/ (worker-3)
   ```
   Format: `#ID [status] subject (owner)`

**Coordination actions the lead can take:**

- **Unblock a teammate:** Send a `message` with guidance or missing context
- **Reassign work:** If a teammate finishes early, use `TaskUpdate` to assign pending tasks to them and notify via `SendMessage`
- **Handle failures:** If a teammate reports failure, reassign the task or spawn a replacement

#### Task Watchdog Policy

Monitor for stuck or failed teammates:

- **Max in-progress age**: If a task stays `in_progress` for more than 5 minutes without messages, send a status check
- **Suspected dead worker**: No messages + stuck task for 10+ minutes → reassign task to another worker
- **Reassign threshold**: If a worker fails 2+ tasks, stop assigning new tasks to it

### Phase 7: Completion

When all real tasks (non-internal) are completed or failed:

1. **Verify results** — Check that all subtasks are marked `completed` via `TaskList`
2. **Shutdown teammates** — Send `shutdown_request` to each active teammate:
   ```json
   {
     "type": "shutdown_request",
     "recipient": "worker-1",
     "content": "All work complete, shutting down team"
   }
   ```
3. **Await responses** — Each teammate responds with `shutdown_response(approve: true)` and terminates
4. **Delete team** — Call `TeamDelete` to clean up:
   ```json
   { "team_name": "fix-ts-errors" }
   ```
   Response:
   ```json
   {
     "success": true,
     "message": "Cleaned up directories and worktrees for team \"fix-ts-errors\"",
     "team_name": "fix-ts-errors"
   }
   ```
5. **Report summary** — Present results to the user

## Pre-flight Analysis (Optional)

For large ambiguous tasks, run analysis before team creation:

1. Spawn `Task(subagent_type="planner", ...)` with task description + codebase context
2. Use the analysis to produce better task decomposition
3. Create team and tasks with enriched context

This is especially useful when the task scope is unclear and benefits from external reasoning before committing to a specific decomposition.

## Agent Preamble

When spawning teammates, include this preamble in the prompt to establish the work protocol. Adapt it per teammate with their specific task assignments.

```
You are a TEAM WORKER in team "{team_name}". Your name is "{worker_name}".
You report to the team lead ("team-lead").
You are not the leader and must not perform leader orchestration actions.

== WORK PROTOCOL ==

1. CLAIM: Call TaskList to see your assigned tasks (owner = "{worker_name}").
   Pick the first task with status "pending" that is assigned to you.
   Call TaskUpdate to set status "in_progress":
   {"taskId": "ID", "status": "in_progress", "owner": "{worker_name}"}

2. WORK: Execute the task using your tools (Read, Write, Edit, Bash).
   Do NOT spawn sub-agents. Do NOT delegate. Work directly.

3. COMPLETE: When done, mark the task completed:
   {"taskId": "ID", "status": "completed"}

4. REPORT: Notify the lead via SendMessage:
   {"type": "message", "recipient": "team-lead", "content": "Completed task #ID: <summary of what was done>", "summary": "Task #ID complete"}

5. NEXT: Check TaskList for more assigned tasks. If you have more pending tasks, go to step 1.
   If no more tasks are assigned to you, notify the lead:
   {"type": "message", "recipient": "team-lead", "content": "All assigned tasks complete. Standing by.", "summary": "All tasks done, standing by"}

6. SHUTDOWN: When you receive a shutdown_request, respond with:
   {"type": "shutdown_response", "request_id": "<from the request>", "approve": true}

== BLOCKED TASKS ==
If a task has blockedBy dependencies, skip it until those tasks are completed.
Check TaskList periodically to see if blockers have been resolved.

== ERRORS ==
If you cannot complete a task, report the failure to the lead:
{"type": "message", "recipient": "team-lead", "content": "FAILED task #ID: <reason>", "summary": "Task #ID failed"}
Do NOT mark the task as completed. Leave it in_progress so the lead can reassign.

== RULES ==
- NEVER spawn sub-agents or use the Task tool
- NEVER run team spawning/orchestration skills or commands
- ALWAYS use absolute file paths
- ALWAYS report progress via SendMessage to "team-lead"
- Use SendMessage with type "message" only -- never "broadcast"
```

## Communication Patterns

### Teammate to Lead (task completion report)

```json
{
  "type": "message",
  "recipient": "team-lead",
  "content": "Completed task #1: Fixed 3 type errors in src/auth/login.ts and 2 in src/auth/session.ts. All files pass tsc --noEmit.",
  "summary": "Task #1 complete"
}
```

### Lead to Teammate (reassignment or guidance)

```json
{
  "type": "message",
  "recipient": "worker-2",
  "content": "Task #3 is now unblocked. Also pick up task #5 which was originally assigned to worker-1.",
  "summary": "New task assignment"
}
```

### Broadcast (use sparingly — sends N separate messages)

```json
{
  "type": "broadcast",
  "content": "STOP: shared types in src/types/index.ts have changed. Pull latest before continuing.",
  "summary": "Shared types changed"
}
```

### Shutdown Protocol (BLOCKING)

**CRITICAL: Steps must execute in exact order. Never call TeamDelete before shutdown is confirmed.**

**Step 1: Verify completion**
```
Call TaskList — verify all real tasks (non-internal) are completed or failed.
```

**Step 2: Request shutdown from each teammate**

**Lead sends:**
```json
{
  "type": "shutdown_request",
  "recipient": "worker-1",
  "content": "All work complete, shutting down team"
}
```

**Step 3: Wait for responses (BLOCKING)**
- Wait up to 30s per teammate for `shutdown_response`
- Track which teammates confirmed vs timed out
- If a teammate doesn't respond within 30s: log warning, mark as unresponsive

**Teammate receives and responds:**
```json
{
  "type": "shutdown_response",
  "request_id": "shutdown-1770428632375@worker-1",
  "approve": true
}
```

After approval:
- Teammate process terminates
- Teammate auto-removed from `config.json` members array
- Internal task for that teammate completes

**Step 4: TeamDelete — only after ALL teammates confirmed or timed out**
```json
{ "team_name": "fix-ts-errors" }
```

**Shutdown sequence is BLOCKING:** Do not proceed to TeamDelete until all teammates have either:
- Confirmed shutdown (`shutdown_response` with `approve: true`), OR
- Timed out (30s with no response)

**IMPORTANT:** The `request_id` is provided in the shutdown request message that the teammate receives. The teammate must extract it and pass it back. Do NOT fabricate request IDs.

## Error Handling

### Teammate Fails a Task

1. Teammate sends `SendMessage` to lead reporting the failure
2. Lead decides: retry (reassign same task to same or different worker) or skip
3. To reassign: `TaskUpdate` to set new owner, then `SendMessage` to the new owner

### Teammate Gets Stuck (No Messages)

1. Lead detects via `TaskList` — task stuck in `in_progress` for too long
2. Lead sends `SendMessage` to the teammate asking for status
3. If no response, consider the teammate dead
4. Reassign the task to another worker via `TaskUpdate`

### Dependency Blocked

1. If a blocking task fails, the lead must decide whether to:
   - Retry the blocker
   - Remove the dependency (`TaskUpdate` with modified blockedBy)
   - Skip the blocked task entirely
2. Communicate decisions to affected teammates via `SendMessage`

### Teammate Crashes

1. Internal task for that teammate will show unexpected status
2. Teammate disappears from `config.json` members
3. Lead reassigns orphaned tasks to remaining workers
4. If needed, spawn a replacement teammate with `Task(team_name, name)`

## Idempotent Recovery

If the lead crashes mid-run, the team skill should detect existing state and resume:

1. Check `~/.claude/teams/` for teams matching the task slug
2. If found, read `config.json` to discover active members
3. Resume monitor mode instead of creating a duplicate team
4. Call `TaskList` to determine current progress
5. Continue from the monitoring phase

This prevents duplicate teams and allows graceful recovery from lead failures.

## Cancellation

To cancel a running team:

1. Send `shutdown_request` to all active teammates (from `config.json` members)
2. Wait for `shutdown_response` from each (15s timeout per member)
3. Call `TeamDelete` to remove team and task directories

If teammates are unresponsive, `TeamDelete` may fail. In that case, wait briefly and retry, or manually clean up `~/.claude/teams/{team_name}/` and `~/.claude/tasks/{team_name}/`.

## State Cleanup

On successful completion, `TeamDelete` handles all Claude Code state:
- Removes `~/.claude/teams/{team_name}/` (config)
- Removes `~/.claude/tasks/{team_name}/` (all task files + lock)

**IMPORTANT:** Call `TeamDelete` only AFTER all teammates have been shut down. `TeamDelete` will fail if active members (besides the lead) still exist in the config.

> **Note:** Team members do not have a hardcoded model default. Each teammate is a separate Claude Code session that inherits the user's configured model. Since teammates can spawn their own subagents, the session model acts as the orchestration layer while subagents can use any model tier.

## Git Worktree Integration

Teammates can operate in isolated git worktrees to prevent file conflicts between concurrent workers.

### How It Works

1. **Worktree creation**: Before spawning a worker, create an isolated worktree at `.claude/worktrees/{team}/{worker}` with branch `team/{teamName}/{workerName}`.

2. **Worker isolation**: Pass the worktree path as the working directory in the worker's context. The worker operates exclusively in its own worktree.

3. **Merge coordination**: After a worker completes its tasks, verify the branch can be cleanly merged, then merge with `--no-ff` for clear history.

4. **Team cleanup**: On team shutdown, remove all worktrees and their branches.

### Important Notes

- Worktree lifecycle is managed separately from team session lifecycle
- Worktrees are NOT cleaned up on individual worker shutdown — only on team shutdown, to allow post-mortem inspection
- Branch names should be sanitized to prevent injection
- All paths must be validated against directory traversal

## Gotchas

1. **Internal tasks pollute TaskList** — When a teammate is spawned, the system auto-creates an internal task with `metadata._internal: true`. These appear in `TaskList` output. Filter them when counting real task progress. The subject of an internal task is the teammate's name.

2. **No atomic claiming** — There is no transactional guarantee on `TaskUpdate`. Two teammates could race to claim the same task. **Mitigation:** The lead should pre-assign owners via `TaskUpdate(taskId, owner)` before spawning teammates. Teammates should only work on tasks assigned to them.

3. **Task IDs are strings** — IDs are auto-incrementing strings ("1", "2", "3"), not integers. Always pass string values to `taskId` fields.

4. **TeamDelete requires empty team** — All teammates must be shut down before calling `TeamDelete`. The lead (the only remaining member) is excluded from this check.

5. **Messages are auto-delivered** — Teammate messages arrive to the lead as new conversation turns. No polling or inbox-checking is needed for inbound messages. However, if the lead is mid-turn (processing), messages queue and deliver when the turn ends.

6. **Teammate prompt stored in config** — The full prompt text is stored in `config.json` members array. Do not put secrets or sensitive data in teammate prompts.

7. **Members auto-removed on shutdown** — After a teammate approves shutdown and terminates, it is automatically removed from `config.json`. Do not re-read config expecting to find shut-down teammates.

8. **shutdown_response needs request_id** — The teammate must extract the `request_id` from the incoming shutdown request JSON and pass it back. The format is `shutdown-{timestamp}@{worker-name}`. Fabricating this ID will cause the shutdown to fail silently.

9. **Team name must be a valid slug** — Use lowercase letters, numbers, and hyphens. Derive from the task description (e.g., "fix TypeScript errors" becomes "fix-ts-errors").

10. **Broadcast is expensive** — Each broadcast sends a separate message to every teammate. Use `message` (DM) by default. Only broadcast for truly team-wide critical alerts.
