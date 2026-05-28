---
name: plan-mission
description: Decompose a complex goal into milestones and tasks with adversarial test coverage.
---

# Plan Mission

## Overview

This skill produces a structured mission plan—milestones, implementation tasks, and adversarial test tasks—that the user approves before execution begins. The output feeds directly into `mission_init` from the `run-mission` skill.

**Announce at start:** "I'm using the plan-mission skill to structure this goal and identify adversarial test coverage."

A mission plan ensures that:
1. The goal is decomposed into manageable, sequential units
2. Every piece of logic/behaviour that could fail is paired with planned adversarial test scenarios
3. The user can review and adjust the plan before any work begins
4. Execution (via `run-mission`) follows a plan the user has already approved

---

## When to use

- **Before starting a `run-mission` execution** — always load `plan-mission` first to produce an approved plan
- **Standalone, to plan without immediate execution** — use this skill when you need to structure a goal but aren't ready to begin work yet

---

## Phase 0a: Decompose the goal

### Step 1: Identify implementation units

Break the goal into discrete, atomic units of work. Each unit typically corresponds to:
- A new API route or endpoint
- A new module or service layer function
- A business rule or validation rule
- A state mutation (e.g., database write, cache invalidation)
- A cross-cutting concern (e.g., middleware, interceptor)

For each unit, describe:
- **What it does:** one sentence
- **What it accepts:** input types, constraints
- **What state it mutates:** DB tables, caches, session state, etc.
- **What invariants it upholds:** things that must remain true (e.g., "user_id must be non-null", "only admins can delete posts")

### Step 2: Classify each unit

For every unit, ask: **Is this logic/behaviour or exempt?**

**Logic/behaviour (requires adversarial test coverage):**
- Routes that accept user input and transform state
- Modules that enforce business rules or validate constraints
- State mutations (writes, deletes, updates)
- Authorization checks
- Anything that could fail in interesting ways

**Exempt (no adversarial test coverage required):**
- Pure configuration (environment setup, feature flags)
- Infrastructure tasks (database schema, deployment setup)
- Documentation
- Pure refactoring (no new behaviour)
- Read-only queries with no side effects

Write down the classification. This determines which units get adversarial test tasks.

---

## Phase 0b: Adversarial scenario analysis

For every **logic/behaviour** unit (and only those), reason through these failure categories:

| Category | What could go wrong? | Examples |
|---|---|---|
| **Invalid / malformed input** | The unit receives input that violates its contract | Missing required field, wrong type, oversized payload, null where non-null expected, malformed JSON |
| **Boundary conditions** | Off-by-one, empty collections, single element, max/min values | Empty list pagination, zero amount in transaction, negative ID |
| **Authorization bypass** | Accessing resources without proper credentials | Accessing another user's data, privilege escalation, ID enumeration |
| **Concurrent / race conditions** | Multiple simultaneous requests corrupt state | Double-submit of form, optimistic lock violation, TOCTOU (time-of-check–time-of-use) |
| **Partial failure / state corruption** | A multi-step operation partially succeeds | Database write succeeds but webhook fails; first transaction commits but second rolls back |
| **Contract violations** | The unit produces output that violates its contract | Returns unexpected null, extra fields, wrong HTTP status code, missing required header |

### Step 3: Group scenarios into clusters

For each unit, identify 2–4 **scenario clusters**. A cluster is a named group of related failure modes.

Example for a "Create user" endpoint:

```
Create user endpoint
├── Cluster: Invalid input (missing email, email already exists, invalid password)
├── Cluster: Authorization (non-admin cannot create other users)
└── Cluster: Race conditions (concurrent account creation with same email)
```

Each cluster becomes one adversarial test task.

### Step 4: Name clusters precisely

The cluster name becomes the adversarial test task title. Be specific; avoid generic names like "edge cases".

Good names:
- "Adversarial tests — token expiry (expired, future-dated, tampered claims)"
- "Adversarial tests — user creation (duplicate email, invalid password, non-admin access)"

Avoid:
- "Adversarial tests — bad input"
- "Adversarial tests — edge cases"

---

## Phase 0c: Structure the plan

### Rules for structuring milestones and tasks

1. **Inline adversarial tasks within the same milestone:** Every logic/behaviour implementation task must have at least one corresponding adversarial test task in the **same milestone**, placed immediately after the implementation task.

2. **Task naming:** 
   - Implementation tasks: descriptive verb phrase (e.g., "Implement token expiry middleware", "Add CSRF protection route")
   - Adversarial test tasks: `"Adversarial tests — <unit> (<scenario summary>)"`

3. **Task ordering within a milestone:**
   ```
   m1t1 — Implement unit A
   m1t2 — Adversarial tests for unit A (cluster 1)
   m1t3 — Adversarial tests for unit A (cluster 2)
   m1t4 — Implement unit B
   m1t5 — Adversarial tests for unit B (cluster 1)
   ```

4. **Exempt tasks:** Config, infra, refactor, and documentation tasks have no adversarial test tasks. Place them before or after logic/behaviour clusters.

5. **Final milestone task:** The last task of the last milestone should be: `"Run full test suite and verify"` — a verification task that isn't paired with adversarial tests.

6. **ID conventions:** Use `m<N>` for milestones and `m<N>t<N>` for tasks (e.g., `m1`, `m1t1`, `m2t3`). Do not reuse IDs.

---

## Phase 0d: Present and await approval

### Output format

Produce the plan in this markdown structure and **STOP**. Do not proceed until the user explicitly approves.

```markdown
## Mission Plan: <Goal Title>

### Milestone m1: <Title>

| ID | Title | Type |
|----|-------|------|
| m1t1 | <Implementation task> | implementation |
| m1t2 | Adversarial tests — <unit> (<scenario cluster>) | adversarial |
| m1t3 | <Another implementation task> | implementation |

**Scenarios covered by m1t2:**
- <Specific failure mode 1>
- <Specific failure mode 2>
- <Specific failure mode 3>

### Milestone m2: <Title>

| ID | Title | Type |
|----|-------|------|
| m2t1 | <Implementation task> | implementation |
| m2t2 | Adversarial tests — <unit> (<scenario cluster>) | adversarial |
| m2t3 | Run full test suite and verify | verification |

**Scenarios covered by m2t2:**
- <Specific failure mode 1>
- <Specific failure mode 2>

...
```

### Approval protocol

1. **Present the plan** with all milestones, tasks, and scenario annotations
2. **Stop and ask:** "Does this plan look right? Any changes before we proceed to `mission_init`?"
3. **Wait for explicit user approval** — do not proceed without a clear "yes" or equivalent
4. **If changes are requested:** Revise the plan and re-present. Loop until approval.
5. **After approval:** Inform the user that the orchestrator will now load `run-mission` and call `mission_init` with this exact structure

---

## Rules

### Never

- **Skip adversarial scenario analysis** for any logic/behaviour task — reason through all six categories
- **Present a plan without waiting for user approval** — stopping for feedback is mandatory
- **Add or remove tasks after user approval** — if the plan needs to change after approval, restart Phase 0 from scratch (don't mid-mission patch)
- **Call `mission_init`** — this skill produces a plan only; execution is `run-mission`'s responsibility
- **Begin implementation** — this skill's output is a written plan, not code

### Always

- **Classify every unit** (logic/behaviour vs. exempt) before analyzing scenarios
- **Name scenario clusters precisely** — the name becomes the task title and should be specific enough that a reader understands what's being tested
- **List covered scenarios explicitly** — under each adversarial test task, enumerate the specific failure modes that will be tested
- **Match the plan exactly in `mission_init`** — if the plan lists m1t1 through m1t5, `mission_init` must have exactly those task IDs and titles
- **Provide reasoning** — if a logic/behaviour task has no adversarial test tasks (or fewer than expected), explain why in a note

---

## Red Flags

### Never

- Skip adversarial scenario analysis for a logic/behaviour task — if you're unsure what could fail, reason harder or ask the user for clarification
- Present a plan with empty or generic scenario lists (e.g., "m1t2: Adversarial tests — token handling" with no scenario detail)
- Present a plan without waiting for explicit user approval
- Add or remove tasks after the user has approved the plan — restart Phase 0 instead

### Always

- Classify each unit (logic/behaviour vs. exempt) explicitly in your reasoning
- Name adversarial clusters precisely — the name must convey what's being tested
- List covered scenarios explicitly under each adversarial test task in the plan — specificity is key
- Reason through all six failure categories for every logic/behaviour task
- Pause for user approval before the plan is final

---

## Example: Adding auth adversarial tests

**Goal:** Add token expiry and CSRF protection.

**Phase 0a decomposition:**

| Unit | Type | What | Input | State mutation | Invariants |
|---|---|---|---|---|---|
| Token expiry middleware | logic | Check if JWT has expired | JWT token from header | Reject if expired | Token must have exp claim, exp must be numeric |
| CSRF protection route | logic | Generate & verify CSRF tokens | User ID, CSRF token in form | Write CSRF token to session | CSRF token must be non-empty, non-guessable |

**Phase 0b adversarial scenarios:**

Token expiry middleware:
- Cluster A: Expired tokens (token past exp time, way in past, exp=0, exp=negative)
- Cluster B: Tampered tokens (claim missing, exp not a number, exp=string)
- Cluster C: Race conditions (token expires mid-request, concurrent validation)

CSRF protection route:
- Cluster D: Invalid tokens (missing token, empty string, wrong format)
- Cluster E: Authorization bypass (user accessing another user's CSRF token)

**Phase 0c structure:**

```markdown
## Mission Plan: Auth adversarial tests

### Milestone m1: Token security

| ID | Title | Type |
|----|-------|------|
| m1t1 | Implement token expiry middleware | implementation |
| m1t2 | Adversarial tests — token expiry (expired, future-dated, tampered claims) | adversarial |
| m1t3 | Adversarial tests — token expiry (race conditions) | adversarial |

**Scenarios covered by m1t2:**
- Token with exp time in past (various deltas: -1s, -1h, -1y)
- Token with exp=0
- Token with exp as negative number
- Token with missing exp claim
- Token with exp as non-numeric value (string, array, object)

**Scenarios covered by m1t3:**
- Concurrent validation of token near expiry boundary
- Token validated successfully, but expires before response sent
- Multiple simultaneous requests with token expiring

### Milestone m2: CSRF and session hardening

| ID | Title | Type |
|----|-------|------|
| m2t1 | Implement CSRF protection route | implementation |
| m2t2 | Adversarial tests — CSRF (invalid tokens, missing tokens) | adversarial |
| m2t3 | Adversarial tests — CSRF (cross-user access) | adversarial |
| m2t4 | Run full test suite and verify | verification |

**Scenarios covered by m2t2:**
- Request with missing CSRF token header
- Request with empty CSRF token
- Request with malformed CSRF token (too short, wrong format)
- Request with CSRF token from another session

**Scenarios covered by m2t3:**
- User A attempts to use User B's CSRF token
- Unauthenticated user attempts to access CSRF token endpoint
- User attempts to access CSRF token for non-existent user ID
```

**Phase 0d approval:**

Stop here and ask: "Does this plan look right? Any changes before we proceed to `mission_init`?"

Wait for user approval before proceeding.

---

## Quick Reference

```
── Planning ──────────────────────────────────────────────────
Phase 0a          → decompose goal into units → classify (logic/behaviour vs exempt)
Phase 0b          → for each logic/behaviour unit: reason through 6 failure categories
Phase 0c          → group scenarios into clusters → structure milestones & tasks inline
Phase 0d          → present plan → wait for user approval → stop
Present plan      → markdown with milestones, tasks, scenario annotations
Approval gate     → explicit user sign-off before proceeding

── Units ──────────────────────────────────────────────────────
Logic/behaviour   → requires adversarial test tasks (new routes, state mutations, rules)
Exempt            → no adversarial test tasks (config, infra, refactor, docs)
Classify first    → before analyzing scenarios

── Scenarios ──────────────────────────────────────────────────
Six categories    → invalid input, boundaries, authorization, concurrency, partial failure, contract violation
Group into clusters → 2–4 clusters per unit, each becomes one adversarial test task
Name precisely    → e.g. "token expiry (expired, tampered, race conditions)" not "edge cases"

── Task structure ────────────────────────────────────────────
Inline placement  → impl task followed immediately by adversarial test task(s) in same milestone
Task naming       → "Implement X" and "Adversarial tests — X (<cluster summary>)"
Final task        → last task of last milestone: "Run full test suite and verify"
ID convention     → m<N>, m<N>t<N>; do not reuse IDs
```
