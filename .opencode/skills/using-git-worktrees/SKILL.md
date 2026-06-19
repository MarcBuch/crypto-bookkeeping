---
name: repo-worktree
description: Use when creating a git worktree for this crypto-bookkeeping repo with a dedicated branch, copied config.json, and bun install bootstrap.
---

# Repo Worktree

Use this skill when the user asks to create a new isolated worktree for this repository.

## Workflow

1. Ask for a branch name if the user did not provide one.
2. Run the helper script that lives next to this skill:

```bash
bun run .opencode/skills/using-git-worktrees/create-worktree.ts <branch-name> [worktree-name]
```

3. Only provide `[worktree-name]` when the user asks for a specific directory name. Otherwise let the script derive it from the branch name.
4. Report the resulting worktree path and branch from the script output.

## What The Helper Does

- Creates `.worktrees/` if needed.
- Verifies `.worktrees/` is gitignored before adding a project-local worktree.
- Fails if the branch already exists.
- Fails if the target worktree path already exists.
- Fails if root `config.json` is missing.
- Runs `git worktree add .worktrees/<name> -b <branch>`.
- Copies root `config.json` into the new worktree.
- Runs `bun install` inside the new worktree.

## Safety Notes

- `config.json` can contain local secrets and is gitignored; do not print its contents.
- Do not manually duplicate the helper behavior unless the helper itself is broken.
- Do not run tests automatically after creating the worktree unless the user asks.
