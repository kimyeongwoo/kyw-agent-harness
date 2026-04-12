---
name: team
description: N coordinated agents on shared task list using Claude Code native teams
argument-hint: "[N:agent-type] <task description>"
aliases: []
---

<!-- kah-managed -->
<!-- team skill: kyw_agent_harness (aligned with Claude Code 2.1 schema) -->

# Team Skill

Spawn N coordinated agents working on a shared task list using Claude Code's native team tools (`TeamCreate`, `Agent` with `team_name`, `SendMessage`, `TeamDelete`). Provides built-in team management, inter-agent messaging, and task dependencies — no external dependencies required.

> Requires Claude Code **v2.1.32 or later** with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The spawn tool is named `Agent` in Claude Code 2.1+ (formerly `Task`).

## Usage

```
/team N:agent-type "task description"
/team "task description"
```

### Parameters

- **N** — Number of teammate agents (1-20). Optional; defaults to auto-sizing based on task decomposition.
  - **Guideline:** Start with 3-5 teammates. Aim for 5-6 tasks per teammate. Larger teams increase coordination overhead without proportional throughput gains.
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
              +-- Agent(team_name="fix-ts-errors", name="worker-1") x 3
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
| **team-plan** | `explore`, `planner` | `analyst`, `architect` | Use `analyst` for unclear requirements. Use `architect` for systems with complex boundaries. |
| **team-prd** | `analyst` | `critic` | Use `critic` to challenge scope. |
| **team-exec** | `executor` | `debugger`, `executor` with `model: "opus"` | Match agent to subtask type. Escalate to opus for complex autonomous work. Use `debugger` for compilation issues. |
| **team-verify** | `verifier` | `critic` | Always run `verifier`. Add `critic` for >20 files, architectural changes, or security-sensitive work — `critic` includes security engineer perspective in its multi-perspective review, covering the role of a dedicated security reviewer. |
| **team-fix** | `executor` | `debugger`, `executor` with `model: "opus"` | Use `debugger` for type/build errors and regression isolation. Escalate `executor` to opus for complex multi-file fixes. |

**Model override**: The `Agent` tool accepts a `model: "sonnet" | "opus" | "haiku"` parameter that overrides the agent file's default (set in frontmatter). Use this to escalate any agent to opus for complex work without maintaining separate agent files. Each agent's default model is defined in its own `.md` file (e.g., `executor` defaults to sonnet, `planner` defaults to opus, `explore` defaults to haiku).

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

The lead writes handoffs to `~/.claude/teams/{team-name}/handoffs/<stage-name>.md`.

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
3. **On team cancellation, preserve handoffs before cleanup.** Since handoffs live inside `~/.claude/teams/{team-name}/`, `TeamDelete` will remove them. Before calling `TeamDelete` during cancellation, copy handoffs to a project-local backup (e.g., `.team-handoffs/{team-name}/`) if resume may be needed later.
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

- **Resume:** check `~/.claude/teams/{team-name}/config.json` for team existence, `~/.claude/tasks/{team-name}/` for task status, and `~/.claude/teams/{team-name}/handoffs/` for stage transition history. The most recent handoff file indicates the last completed stage. Resume from the next stage in the pipeline. If the team was fully deleted, check for a project-local backup at `.team-handoffs/{team-name}/` (created during cancellation) to recover stage context.
- **Cancel:** request teammate shutdown, wait for responses (best effort), copy handoffs to `.team-handoffs/{team-name}/` for potential resume, then call `TeamDelete` to clean up team resources.
- Terminal states are `complete`, `failed`, and `cancelled`.

## Workflow

### Phase 0: Pre-flight

Before creating a team, verify the experimental flag is enabled:

1. Check that `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is set to `1` in either:
   - Shell environment (`echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`)
   - `~/.claude/settings.json` → `env` block
   - Project `.claude/settings.json` → `env` block
2. If not set, add to the appropriate settings.json:
   ```json
   { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
   ```
3. Verify Claude Code version >= 2.1.32 (`claude --version`)

If either check fails, inform the user and stop. Do not attempt `TeamCreate` without the flag — it will fail silently or error.

### Phase 1: Parse Input

- Extract **N** (agent count), validate 1-20
- Extract **agent-type**, validate it maps to a known subagent
- Extract **task** description

### Phase 2: Analyze & Decompose

Use `explore` or `architect` (via Agent tool) to analyze the codebase and break the task into N subtasks:

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

`TaskCreate` accepts only `{subject, description, activeForm?, metadata?}`. The
on-disk task file (e.g. `1.json`) includes additional fields that are managed
via subsequent `TaskUpdate` calls — NOT passed to `TaskCreate`:

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

Fields `owner`, `status`, `blocks`, `blockedBy` are set via `TaskUpdate` (see below).

For tasks with dependencies, use `TaskUpdate` after creation:

```json
// Task #3 depends on task #1 (shared types must be fixed first)
{
  "taskId": "3",
  "addBlockedBy": ["1"]
}
```

**Pre-assign owners from the lead** to avoid contention (file locking exists, but pre-assignment is cleaner):

```json
// Assign task #1 to worker-1
{
  "taskId": "1",
  "owner": "worker-1"
}
```

### Phase 5: Spawn Teammates

Spawn N teammates using `Agent` with `team_name` and `name` parameters. Each teammate gets the team worker preamble (see below) plus their specific assignment. The `description` field is required (3-5 words summarizing the worker's role). The `model` field optionally overrides the agent file's default (`"sonnet" | "opus" | "haiku"`).

```json
{
  "subagent_type": "executor",
  "team_name": "fix-ts-errors",
  "name": "worker-1",
  "description": "fix auth type errors",
  "prompt": "<worker-preamble + assigned tasks>",
  "model": "opus"
}
```

Omit `model` to use the agent's default (e.g., `executor` defaults to sonnet).

**Plan approval mode:** For complex or risky tasks, spawn teammates with `mode: "plan"` to require plan approval before implementation. The teammate works in read-only plan mode until the lead approves their approach via `SendMessage`. This is useful for architectural changes, security-sensitive work, or when the lead wants to validate the approach before execution begins.

```json
{
  "subagent_type": "executor",
  "team_name": "fix-ts-errors",
  "name": "worker-1",
  "description": "fix auth type errors",
  "prompt": "<worker-preamble + assigned tasks>",
  "mode": "plan"
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

- **Unblock a teammate:** Send a plain-text `SendMessage` with guidance or missing context
- **Reassign work:** If a teammate finishes early, use `TaskUpdate` to assign pending tasks to them and notify via `SendMessage`
- **Handle failures:** If a teammate reports failure, reassign the task or spawn a replacement

**Peer discovery:** Teammates (and the lead) can read
`~/.claude/teams/{team-name}/config.json` to enumerate team members. The
`members` array lists each teammate with `name` (use for communication),
`agentId` (reference only — never use for messaging), and `agentType`. Always
address peers by `name`.

**Idle notifications:** After every turn, teammates automatically go idle. The
lead receives idle notifications; these are informational. Idle is NOT an error
state — idle teammates can still receive messages. See Task Watchdog Policy for
how to distinguish idle from stuck.

#### Task Watchdog Policy

**Idle ≠ stuck.** Per official Claude Code semantics, teammates go idle after
every turn. A teammate that sent a message and went idle is waiting for input,
not dead. Do not treat idle as an error.

**Signs of actual stuckness (all three must hold):**
- A task remains `in_progress` with no `TaskUpdate` activity AND no inbound
  `SendMessage` for a period clearly exceeding the task's expected complexity.
- Your status-check ping goes unanswered after one full orchestration cycle.
- No peer DM summary for the suspected worker in recent idle notifications.

**Escalation sequence (never assume dead without verification):**
1. Send a plain-text status-check `SendMessage` to the suspected-stuck teammate.
2. If no response after one full orchestration cycle, reassign the task via
   `TaskUpdate(taskId, owner=<new worker>)` and notify both the old and new
   owners via `SendMessage`.
3. If a worker fails 2+ reassigned tasks, stop routing new work to it and
   report to the user.

### Phase 7: Completion

**IMPORTANT:** Only enter Phase 7 when the user explicitly requests teardown OR
when a clear terminal condition is reached (all real tasks `completed` AND user
confirmation). Do NOT auto-shutdown solely because all tasks hit `completed` —
per official SendMessage docs: "Don't originate `shutdown_request` unless asked."

**When all real tasks reach `completed` status:** Proactively inform the user that
all work is done and ask whether they want to tear down the team. Example:
"All N tasks are completed. Would you like me to shut down the team, or do you
want to review the results first?" This avoids idle resource waste while respecting
the no-auto-shutdown policy.

When authorized:

1. **Verify results** — Check that all real tasks (metadata._internal != true) are marked `completed` via `TaskList`, and confirm with the user.
2. **Shutdown teammates** — Send a wrapped `shutdown_request` to each active teammate:
   ```json
   {
     "to": "worker-1",
     "message": { "type": "shutdown_request", "reason": "All work complete, shutting down team" }
   }
   ```
3. **Await responses** — Each teammate responds with a wrapped `shutdown_response(approve: true)` and terminates
4. **Delete team** — Call `TeamDelete` (uses current team context, no parameters):
   ```
   TeamDelete()
   ```
5. **Report summary** — Present results to the user

## Pre-flight Analysis (Optional)

For large ambiguous tasks, run analysis before team creation:

1. Spawn `Agent(subagent_type="planner", ...)` with task description + codebase context
2. Use the analysis to produce better task decomposition
3. Create team and tasks with enriched context

This is especially useful when the task scope is unclear and benefits from external reasoning before committing to a specific decomposition.

## Agent Preamble

When spawning teammates, include this preamble in the prompt to establish the work protocol. Replace `{team_name}` and `{worker_name}` with the actual values before sending. Adapt the preamble per teammate with their specific task assignments.

```
You are a TEAM WORKER in team "{team_name}". Your name is "{worker_name}".
You report to the team lead ("team-lead").
You are not the leader and must not perform leader orchestration actions.

== WORK PROTOCOL ==

1. CLAIM: Call TaskList to see your assigned tasks (owner = "{worker_name}").
   Skip any task whose metadata._internal is true — those are auto-created
   lifecycle tasks, not real work. Pick the first real task with status "pending"
   that is assigned to you. Call TaskUpdate to set status "in_progress":
   {"taskId": "ID", "status": "in_progress"}
   (Your owner was pre-assigned by the lead; do not re-set it here.)

2. WORK: Execute the task using your tools (Read, Write, Edit, Bash).
   Do NOT spawn sub-agents. Do NOT delegate. Work directly.

3. COMPLETE: When done, mark the task completed via TaskUpdate:
   {"taskId": "ID", "status": "completed"}

4. REPORT: After TaskUpdate, send a plain-text progress message to the lead:
   SendMessage({"to": "team-lead", "message": "Task #ID complete: <one-line summary of what was done>", "summary": "Task #ID done"})
   Plain text only — never wrap the message in {"type": "message", ...} or similar JSON.

5. NEXT: Check TaskList for more assigned real tasks (non-internal). If you have
   more pending tasks, go to step 1. If no more tasks are assigned to you:
   SendMessage({"to": "team-lead", "message": "All assigned tasks complete. Standing by.", "summary": "Standing by"})

6. SHUTDOWN: When you receive a shutdown_request, respond by wrapping the
   shutdown_response object inside the SendMessage `message` field:
   SendMessage({"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "<from incoming request>", "approve": true}})
   The request_id is auto-generated by Claude Code and included in the inbound
   shutdown_request payload — extract it; do NOT fabricate one.

== BLOCKED TASKS ==
If a task has blockedBy dependencies, skip it until those tasks are completed.
Check TaskList periodically to see if blockers have been resolved.

== ERRORS ==
If you cannot complete a task, report the failure via plain text:
SendMessage({"to": "team-lead", "message": "FAILED task #ID: <reason>", "summary": "Task #ID failed"})
Do NOT mark the task as completed. Leave it in_progress so the lead can reassign.

== RULES ==
- NEVER spawn sub-agents via the `Agent` tool (or the legacy `Task` tool)
- NEVER run team spawning/orchestration skills or commands
- ALWAYS use absolute file paths
- ALWAYS report progress via plain-text SendMessage to "team-lead"
- NEVER send structured JSON status messages (e.g. {"type":"task_completed",...});
  use TaskUpdate for task state and plain text for communication
- NEVER use "*" as recipient — only send to "team-lead" or named teammates.
  Broadcast is reserved for the lead
- Skip tasks whose metadata._internal is true — those are lifecycle tasks,
  not real work
```

## Communication Patterns

All communication goes through `SendMessage({to, message, summary})`. Messages are
**plain text** by default. The only structured messages are `shutdown_request` /
`shutdown_response` / `plan_approval_response`, which go inside the `message` field.

### Teammate to Lead (task completion report)

```json
{
  "to": "team-lead",
  "message": "Completed task #1: Fixed 3 type errors in src/auth/login.ts and 2 in src/auth/session.ts. All files pass tsc --noEmit.",
  "summary": "Task #1 complete"
}
```

### Lead to Teammate (reassignment or guidance)

```json
{
  "to": "worker-2",
  "message": "Task #3 is now unblocked. Also pick up task #5 which was originally assigned to worker-1.",
  "summary": "New task assignment"
}
```

### Broadcast (use sparingly — sends N separate messages, O(N) cost)

```json
{
  "to": "*",
  "message": "STOP: shared types in src/types/index.ts have changed. Pull latest before continuing.",
  "summary": "Shared types changed"
}
```

Broadcast delivers a separate message to every teammate. Prefer DMs for targeted
coordination; reserve `to: "*"` for truly team-wide critical alerts.

### Shutdown Protocol (BLOCKING)

**CRITICAL:** Steps must execute in exact order. Never call `TeamDelete` before
shutdown is confirmed. **Only originate a `shutdown_request` when the user
explicitly requests teardown, OR when a clear terminal condition is reached
(all real tasks `completed` AND user confirmation). Do NOT auto-shutdown merely
because all tasks hit `completed`.** (Per official SendMessage docs: "Don't
originate shutdown_request unless asked.")

**Step 1: Verify completion**
```
Call TaskList — verify all real tasks (metadata._internal != true) are
completed or failed. Confirm with the user before proceeding.
```

**Step 2: Request shutdown from each teammate**

The lead sends a structured `shutdown_request` wrapped inside SendMessage's
`message` field. Note: `summary` is optional when `message` is a structured
object — omit it.

```json
{
  "to": "worker-1",
  "message": { "type": "shutdown_request", "reason": "All work complete, shutting down team" }
}
```

**Step 3: Wait for responses (BLOCKING)**
- Wait up to 30s per teammate for `shutdown_response`
- Track which teammates confirmed vs timed out
- If a teammate doesn't respond within 30s: log warning, mark as unresponsive

The teammate receives the request and responds by wrapping `shutdown_response`
inside SendMessage's `message` field:

```json
{
  "to": "team-lead",
  "message": { "type": "shutdown_response", "request_id": "<extracted from incoming request>", "approve": true }
}
```

`request_id` is auto-generated by Claude Code when the lead sends
`shutdown_request`. The teammate extracts it from the inbound message payload
and echoes it in the response. **Do NOT fabricate request IDs.**

After approval:
- Teammate process terminates
- Teammate auto-removed from `config.json` members array
- Internal task for that teammate completes

**Step 4: TeamDelete — only after ALL teammates confirmed or timed out**

```
TeamDelete()
```

`TeamDelete` uses the current session's team context and accepts no parameters.
If it fails, the lead may have lost team context — manually clean up
`~/.claude/teams/{team_name}/` and `~/.claude/tasks/{team_name}/` as a last resort.

**Shutdown sequence is BLOCKING:** Do not proceed to TeamDelete until all teammates have either:
- Confirmed shutdown (`shutdown_response` with `approve: true`), OR
- Timed out (30s with no response)

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
4. If needed, spawn a replacement teammate with `Agent(team_name, name)`

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

> **Note on model defaults:** Each agent's default model is set in its own frontmatter (e.g., `model: claude-sonnet-4-6` in `executor.md`). The lead can override per-spawn via the `model` parameter on the `Agent` tool (`"sonnet" | "opus" | "haiku"`). Since teammates can spawn their own subagents, the session model acts as the orchestration layer while subagents can use any model tier.

## Gotchas

1. **Internal tasks pollute TaskList** — When a teammate is spawned, the system auto-creates an internal task with `metadata._internal: true`. These appear in `TaskList` output. Filter them when counting real task progress. The subject of an internal task is the teammate's name.

2. **Task claiming has file locking, but pre-assignment is preferred** — Claude Code uses file locking to prevent race conditions on concurrent claims. However, the lead should still pre-assign owners via `TaskUpdate(taskId, owner)` before spawning teammates to avoid contention entirely. Teammates should only work on tasks assigned to them.

3. **Task IDs are strings** — IDs are auto-incrementing strings ("1", "2", "3"), not integers. Always pass string values to `taskId` fields.

4. **TeamDelete requires empty team** — All teammates must be shut down before calling `TeamDelete`. The lead (the only remaining member) is excluded from this check.

5. **Messages are auto-delivered** — Teammate messages arrive to the lead as new conversation turns. No polling or inbox-checking is needed for inbound messages. However, if the lead is mid-turn (processing), messages queue and deliver when the turn ends.

6. **Teammate prompt stored in config** — The full prompt text is stored in `config.json` members array. Do not put secrets or sensitive data in teammate prompts.

7. **Members auto-removed on shutdown** — After a teammate approves shutdown and terminates, it is automatically removed from `config.json`. Do not re-read config expecting to find shut-down teammates.

8. **shutdown_response needs request_id** — The teammate must extract the `request_id` from the delivered shutdown message and echo it back. The runtime injects `request_id` during message delivery — it is not part of the `shutdown_request` schema as sent by the lead. Do not fabricate this value; extract whatever the runtime provides.

9. **Team name must be a valid slug** — Use lowercase letters, numbers, and hyphens. Derive from the task description (e.g., "fix TypeScript errors" becomes "fix-ts-errors").

10. **Broadcast is expensive** — Each broadcast sends a separate message to every teammate. Use `message` (DM) by default. Only broadcast for truly team-wide critical alerts.

11. **skills/mcpServers frontmatter not applied to teammates** — The `skills` and `mcpServers` frontmatter fields in a subagent definition are not applied when that definition runs as a teammate. Teammates inherit the lead's MCP server configuration but do not load skill-specific or agent-specific MCP servers declared in frontmatter.

12. **/resume and /rewind do not restore teammates** — Claude Code's `/resume` and `/rewind` commands do not restore in-process teammates. If the lead session is resumed, you must manually re-detect the team state and respawn teammates as needed (see Idempotent Recovery).

13. **Hooks enable quality gates** — Use `TeammateIdle`, `TaskCreated`, and `TaskCompleted` hooks to enforce quality checks. A hook returning exit code 2 sends its stdout as feedback to the agent, allowing automated review gates (e.g., running linters or tests on task completion). Configure hooks in `.claude/settings.json` under the `hooks` key.
