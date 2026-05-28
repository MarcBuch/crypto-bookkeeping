---
name: run-mission
description: Run a long-horizon goal as a structured mission. Use when a task spans multiple milestones and subagents. Provides shared state between orchestrator and subagents via mission tools.
---

# Run Mission

## Overview

A mission is a long-running goal broken into **milestones**, each containing **tasks**. The orchestrator owns all state transitions. Subagents do work and report results — they never update mission state directly.

**Announce at start:** "I'm using the run-mission skill to manage this as a structured mission."

## Hierarchy

```
Mission        — the overall goal
└── Milestone  — a meaningful checkpoint (e.g. "Token security tests")
    └── Task   — a unit of work delegated to one subagent
```

## Orchestrator Responsibilities

The orchestrator:
1. Defines the full mission structure upfront via `mission_init`
2. Marks tasks `in_progress` before delegating them
3. Delegates each task to a subagent, passing full context and prior handoffs
4. Receives the subagent's result, reads the handoff record, then marks the task `completed` or `failed`
5. **Immediately spawns a Scrutiny Validator subagent** after every completed task (see [Scrutiny Validator](#scrutiny-validator))
6. If the validator returns `FAIL`, spawns a Fix subagent then re-validates before proceeding
7. Reviews progress after each milestone before starting the next
8. Decides whether to retry, skip, or abort on failure

Subagents **never** call `mission_update_task`. They call `mission_handoff` as their last action, then return results to the orchestrator, which records the final status.

## Workflow

### Prerequisite: Plan the mission first

Before calling `mission_init`, load and complete the **`plan-mission`** skill:

1. Load the skill: `skill("plan-mission")`
2. Follow its protocol to decompose the goal, analyse adversarial scenarios, and produce a written plan
3. Present the plan to the user and wait for explicit approval
4. Only after approval: call `mission_init` with a structure that matches the approved plan exactly

**Do not call `mission_init` until `plan-mission` produces an approved plan.** This is a hard prerequisite, not a recommendation.

### Step 1: Initialize the Mission

Call `mission_init` with the full milestone and task tree before spawning any subagents.

```
mission_init(
  title: "Add auth adversarial tests",
  milestones: [
    {
      id: "m1",
      title: "Token security tests",
      tasks: [
        { id: "m1t1", title: "Write token expiry tests" },
        { id: "m1t2", title: "Write token replay tests" }
      ]
    },
    {
      id: "m2",
      title: "CSRF and session tests",
      tasks: [
        { id: "m2t1", title: "Write CSRF tests" },
        { id: "m2t2", title: "Run full test suite and verify" }
      ]
    }
  ]
)
```

**Rules:**
- Define all milestones and tasks upfront — do not add tasks mid-mission
- Use short, stable IDs (`m1`, `m1t1`, `m2t3`, etc.)
- Order milestones and tasks in execution order
- `mission_init` always overwrites any existing mission file

### Step 2: Execute Milestones in Order

Work through milestones sequentially. Within a milestone, tasks may be parallelized if they are independent, but default to sequential unless parallelism is clearly safe.

For each task:

#### 2a. Mark the task in progress

```
mission_update_task(taskId: "m1t1", status: "in_progress")
```

#### 2b. Delegate to a subagent

Before delegating, read prior handoffs for the current milestone so the subagent has full context on what prior workers discovered:

```
mission_read_handoffs()   ← returns all handoffs for the current in_progress milestone
```

Include in the subagent's prompt:
- The task ID and title
- The full mission context from `mission_read`
- Prior handoffs from `mission_read_handoffs` (paste the output)
- Any relevant files, constraints, or prior results
- The instruction to call `mission_handoff` as the last action before reporting back

Example subagent prompt:
```
Your task is m1t1: "Write token expiry tests".

Mission context:
<paste mission_read output here>

Prior handoffs for this milestone:
<paste mission_read_handoffs output here — or "none yet" if first task>

Instructions:
- Implement the tests described in your task
- Do not update mission state
- After making changes, run the two-phase test strategy (do NOT run the full suite):
    Phase 1 — targeted:  bun test <your-modified-file>
    Phase 2 — smoke:     bun test test/integration/health.test.ts test/integration/static.test.ts test/unit/architecture-boundaries.test.ts
    Typecheck:           bun run check
- Call mission_handoff as your last action before reporting back
- After calling mission_handoff, report your result to me
```

#### 2c. Record the result

After the subagent calls `mission_handoff` and returns, read the handoff to review what was done:

```
mission_read_handoffs(taskId: "m1t1")
```

Then update the task status, using the handoff summary as notes:

```
mission_update_task(
  taskId: "m1t1",
  status: "completed",
  notes: "6 tests written, all passing. Covers 15min and 24h expiry windows."
)
```

Use `failed` if the subagent could not complete the task:

```
mission_update_task(
  taskId: "m1t1",
  status: "failed",
  notes: "Could not locate auth token middleware. Needs investigation."
)
```

#### 2d. Run the Scrutiny Validator

After every `completed` task, **always** spawn a Scrutiny Validator subagent before proceeding to the next task. See the [Scrutiny Validator](#scrutiny-validator) section for the full prompt template and verdict handling.

```
PASS          → proceed to next task
PASS WITH NOTES → record findings in task notes via mission_update_task, proceed
FAIL          → mark task in_progress, spawn Fix subagent, re-run Scrutiny Validator
               → loop until PASS or PASS WITH NOTES
```

When recording a validator result, append the verdict to the task notes:

```
mission_update_task(
  taskId: "m1t1",
  status: "completed",
  notes: "6 tests written, all passing. [Scrutiny: PASS]"
)
```

### Step 3: Review After Each Milestone

After all tasks in a milestone are done:

#### 3a. Run the full test suite for affected workspaces

Before calling `mission_summary`, determine which workspaces were modified during
this milestone by reviewing the `implemented` fields from all task handoffs.

Then run the full test suite **only** in affected workspaces:

```bash
# If apps/api was modified:
bun test test                    # from apps/api/

# If apps/web was modified:
bun test src                     # from apps/web/

# If packages/contracts was modified:
bun test src                     # from packages/contracts/
```

Do NOT run `bun run test` from root (which tests all workspaces) unless multiple
workspaces were modified. If only one workspace was touched, test only that one.

If the full suite fails, investigate before proceeding. Do not advance to the
next milestone with a broken suite.

#### 3b. Call mission_summary

```
mission_summary()
```

Review the output. If any tasks failed:
- Decide whether to retry (re-run the task), skip (`skipped` status), or abort
- Do not proceed to the next milestone with unresolved failures unless explicitly acceptable

### Step 4: Complete the Mission

When all milestones are completed, call `mission_summary` one final time and report the outcome to the user.

---

## Subagent Reporting

Every subagent must call `mission_handoff` as its **last action** before returning results to the orchestrator. This is not optional.

### What to report

```
mission_handoff(
  taskId: "m1t1",
  taskTitle: "Write token expiry tests",
  milestoneId: "m1",
  implemented: [
    "tests/auth/token-expiry.test.ts — 6 tests covering 15min, 1h, 24h expiry windows",
    "tests/helpers/auth.ts — added generateExpiredToken() helper"
  ],
  leftUndone: [
    "Refresh token expiry not tested — refresh token logic is in a separate middleware not yet located"
  ],
  commands: [
    { cmd: "bun run test --filter token-expiry", exit: 0, note: "All 6 new tests passing" },
    { cmd: "bun run typecheck", exit: 0 }
  ],
  issues: [
    "Token middleware imports from apps/api/src/modules/auth/token.ts, not the route layer — future workers should read that file first"
  ],
  proceduresFollowed: {
    readArchitectureMd: true,
    ranBaselineTests: true,
    noDirectDependencyEdits: true
  }
)
```

### Field rules

**`implemented`**
- One entry per file or logical unit changed
- Include the file path and a short description of what changed
- Never leave empty unless the task genuinely produced no output

**`leftUndone`**
- Be honest — this is the most valuable field for the next worker
- Include the reason why something was not done
- Empty array only if genuinely nothing was left undone

**`commands`**
- Record every command run, in execution order
- Use the full command as run, including flags and arguments
- Record the actual exit code — do not normalize failures to 0

**`issues`**
- Discoveries, gotchas, unexpected behaviours, or structural findings
- Anything that would have saved you time if a prior worker had told you
- Empty array only if there are genuinely no issues to report

**`proceduresFollowed`**
These map directly to the rules in `AGENTS.md`:

| Field | Rule |
|---|---|
| `readArchitectureMd` | Read `apps/api/ARCHITECTURE.md` before editing API code |
| `ranBaselineTests` | Run the two-phase test strategy after making changes: targeted file + smoke tests + typecheck. Do NOT run the full suite per-task. |
| `noDirectDependencyEdits` | Use `bun install` / `bun remove` — never edit `package.json` or `bun.lock` directly |

If a procedure was not applicable (e.g. no API code was touched), set the boolean to `true` and explain in `note`. Only set `false` if the procedure was applicable but was not followed — and always explain why in `note`.

---

## Scrutiny Validator

After every completed task, spawn a **Scrutiny Validator** subagent. This is not optional — every task must pass validation before the next task starts.

### What the validator does

1. **Quality gate** — two-phase test strategy (fast, targeted — do NOT run the full suite):

   **Phase 1 — Targeted (always run):** run only the file(s) modified by the task:
   ```bash
   bun test <modified-test-file>   # e.g. bun test test/integration/auth-adversarial.test.ts
   ```

   **Phase 2 — Smoke test (always run):** run fast non-integration tests to catch obvious cross-cutting regressions:
   ```bash
   bun test test/integration/health.test.ts test/integration/static.test.ts test/unit/architecture-boundaries.test.ts
   ```

   **Typecheck (always run):**
   ```bash
   bun run check
   ```

   **Lint (run if script exists, skip with a note if not):**
   ```bash
   bun run lint
   ```

   > The full suite is **not** run per-task — it is reserved for the mandatory milestone-end verification in Step 3 (scoped to affected workspaces). Running it per-task is too expensive for integration-heavy suites.

2. **Code review** — review only the diff introduced by the just-completed task (not the full file). Assess each finding with a severity:
   - `critical` — correctness bug or security hole
   - `major` — type unsafety, incorrect assertion, misleading invariant
   - `minor` — hygiene, missing assertion, connection leak
   - `nit` — duplication, comment accuracy, weak assertion

### Verdict rules

| Verdict | Condition | Action |
|---------|-----------|--------|
| `PASS` | Quality gate clean, no critical/major findings | Proceed to next task |
| `PASS WITH NOTES` | Quality gate clean, only minor/nit findings | Record findings in task notes, proceed |
| `FAIL` | Quality gate fails **or** any critical/major finding | Spawn Fix subagent, re-validate |

### Scrutiny Validator prompt template

Use this template when spawning the validator. Fill in `<TASK_ID>`, `<TASK_TITLE>`, `<MODIFIED_FILES>`, and `<DIFF>`:

```
You are the Scrutiny Validator for task <TASK_ID>: "<TASK_TITLE>".

## Step 1 — Quality gate (two-phase — do NOT run the full suite)

Run from the relevant app directory (e.g. apps/api/):

Phase 1 — Targeted (only the modified files):
  bun test <MODIFIED_FILES>   e.g. bun test test/integration/auth-adversarial.test.ts

Phase 2 — Smoke test (fast non-integration tests):
  bun test test/integration/health.test.ts test/integration/static.test.ts test/unit/architecture-boundaries.test.ts

Typecheck:
  bun run check

Lint (skip with a note if the script does not exist):
  bun run lint

Record every command and its exit code.

## Step 2 — Code review
Review only the diff below. Do not review the full file.
Assess each finding with severity: critical | major | minor | nit.

<DIFF>

## Step 3 — Verdict
Return one of:
  PASS          — quality gate clean, no critical/major findings
  PASS WITH NOTES — quality gate clean, only minor/nit findings
  FAIL          — quality gate fails OR any critical/major finding

## Report format
1. Quality gate results (pass/fail per command, errors quoted verbatim)
2. Code review findings (severity, file:line, description, suggested fix)
3. Overall verdict: PASS | PASS WITH NOTES | FAIL
```

### Fix subagent

When the validator returns `FAIL`:
1. Mark the task `in_progress`
2. Spawn a Fix subagent with the validator's full findings as input
3. After the fix subagent completes, re-spawn the Scrutiny Validator
4. Repeat until `PASS` or `PASS WITH NOTES`

---

## Failure Handling

| Situation | Action |
|---|---|
| Task failed, retryable | Mark `failed` with notes, re-delegate |
| Task failed, non-blocking | Mark `skipped` with reason, continue |
| Task failed, blocks milestone | Stop, report to user, wait for guidance |
| Subagent returns partial result | Mark `in_progress`, delegate a follow-up task |
| Scrutiny Validator returns FAIL | Mark `in_progress`, spawn Fix subagent, re-validate |

---

## ID Conventions

| Level | Format | Example |
|---|---|---|
| Milestone | `m<N>` | `m1`, `m2`, `m3` |
| Task | `m<N>t<N>` | `m1t1`, `m1t2`, `m2t3` |

Keep IDs short and stable. Do not reuse IDs within a mission.

---

## Status Reference

| Status | Meaning |
|---|---|
| `pending` | Not started |
| `in_progress` | Delegated to a subagent, awaiting result |
| `completed` | Subagent returned a successful result |
| `failed` | Subagent could not complete the task |
| `skipped` | Intentionally bypassed |

Milestone and mission status are **derived automatically** — never set them directly.

---

## Quick Reference

```
── Orchestrator ──────────────────────────────────────────────
Plan the mission     → load plan-mission skill first    ← hard prerequisite
Start mission        → mission_init(title, milestones)  ← only after user approves plan
Before delegate      → mission_update_task(id, "in_progress")
Read prior handoffs  → mission_read_handoffs()              ← current milestone
After subagent done  → mission_read_handoffs(taskId: id)    ← specific task
Record outcome       → mission_update_task(id, "completed"|"failed", notes)
After every complete → spawn Scrutiny Validator             ← always, no exceptions
  PASS/NOTES         → mission_update_task(id, notes append "[Scrutiny: PASS]")
  FAIL               → mission_update_task(id, "in_progress"), spawn Fix subagent
End of milestone     → bun test (affected workspaces only) ← mandatory before mission_summary
Check progress       → mission_summary()
Full state           → mission_read()

── Subagent / Scrutiny Validator (per-task tests) ────────────
Targeted tests       → bun test <modified-file>
Smoke tests          → bun test test/integration/health.test.ts test/integration/static.test.ts test/unit/architecture-boundaries.test.ts
Typecheck            → bun run check
Full suite           → NEVER per-task; only at milestone end

── Subagent (last action before returning) ───────────────────
Report handoff       → mission_handoff(taskId, taskTitle, milestoneId, ...)
```

---

## Red Flags

**Never:**
- Call `mission_update_task` from a subagent — only the orchestrator updates state
- Skip `mission_handoff` at the end of a task — the orchestrator depends on it
- Skip `mission_init` — subagents call `mission_read` and expect the file to exist
- Add milestones or tasks after `mission_init` — define the full structure upfront
- Proceed past a failed milestone without an explicit decision
- Leave `leftUndone` or `issues` empty as a shortcut — empty arrays must reflect reality
- Skip the Scrutiny Validator after a completed task — it is mandatory, not optional
- Proceed to the next task while the validator verdict is `FAIL`
- Call `mission_init` without first completing the `plan-mission` skill and receiving user approval

**Always:**
- Mark a task `in_progress` before delegating it
- Include `mission_read` output in every subagent prompt
- Include `mission_read_handoffs` output in every subagent prompt
- Instruct every subagent to call `mission_handoff` before reporting back
- Read the handoff with `mission_read_handoffs(taskId)` before calling `mission_update_task`
- Spawn the Scrutiny Validator immediately after marking a task `completed`
- Append the validator verdict (`[Scrutiny: PASS]`, `[Scrutiny: PASS WITH NOTES]`, or `[Scrutiny: FAIL → fixed]`) to the task notes
- Call `mission_summary` after each milestone to verify progress before continuing
- Set `proceduresFollowed` fields honestly — use `note` to explain any false value
