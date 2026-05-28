---
name: commit
description: Git commit workflow using conventional commit messages. Use this when asked to make commits.
---

# Commit Changes Skill

## Overview

Create git commits for changes made during a session with user approval and no Claude attribution. Every commit must include a body that explains why the change was made so later agents can understand the intent behind the diff.

## Context

- You are tasked with creating meaningful git commits for all changes
- The user trusts your judgment on grouping related changes
- Commits must be authored solely by the user
- All changes should follow conventional commit message style
- Every commit must include a non-empty body that captures the rationale for the change

## Workflow

### Step 1: Review Changes

- Review the conversation history to understand what was accomplished
- Run `git status` to see current changes
- Run `git diff` to understand the modifications
- Determine if changes should be one commit or multiple logical commits

### Step 2: Plan Commits

- Identify which files belong together logically
- Draft clear, descriptive commit messages using imperative mood
- Draft both a conventional commit subject and a short body
- Focus on why the changes were made, not just what
- Make the body explain at least one of: the problem being solved, the new use case being supported, the reason something was removed, or the constraint/tradeoff that motivated the change
- Follow the Conventional Commit format with scope notation

### Step 3: Present Plan to User

- List the files you plan to add for each commit
- Show the full commit message(s), including body, you'll use
- Ask for confirmation: "I plan to create [N] commit(s) with these changes. Shall I proceed?"

### Step 4: Execute Upon Confirmation

- Use `git add` with specific files (never use `-A` or `.`)
- Create commits with the planned messages
- Show results with `git log --oneline -n [number]`

## Conventions

### Commit Message Format

```
<type>(<scope>): <subject>

<body>
```

### Body Requirements

- Every commit must include a non-empty body
- The body must explain why the change was made, not just restate what changed
- Prefer 1-3 short sentences in natural language
- Include useful context for future agents and reviewers, such as:
  - the bug, limitation, or user need that motivated the change
  - the reason something was added, removed, or refactored
  - any important tradeoff, constraint, or follow-up implication
- For removals, explain why the old behavior or code was no longer wanted
- For additions, explain the use case or capability being introduced
- For modifications, explain what was insufficient or broken about the previous behavior

### Type Prefixes

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation changes
- `chore`: Other changes
- `refactor`: Code changes that neither fix a bug nor add a feature
- `test`: Adding or updating tests

### Scope Format

- For changes affecting the api, use: `(api/[topic])`
- For changes affecting the web, use: `(web/[topic])`
- For changes affecting shared contracts, use: `(contracts/[topic])`

Examples of valid scopes:

- `(api/authentication)`
- `(web/dashboard)`
- `(web/components/button)`

### Message Example

`feat(web/excel-upload): add excel upload validation`

Example body:

```text
Prevent invalid spreadsheet formats from reaching the import flow.
This gives users earlier feedback in the UI and reduces avoidable backend validation failures.
```

## Important Constraints

- **User-only authorship**: Commits must be authored solely by the user
- **No attribution**: Do not include "Generated with Claude" messages
- **No co-authoring**: Do not add "Co-Authored-By" lines
- **Natural voice**: Write commit messages as if the user wrote them
- **Atomic commits**: Group related changes together; keep commits focused
- **Conventional style**: Always use the conventional commit format
- **Required rationale**: Always include a body that explains why something was changed, added, or removed
