---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with smart directory selection and safety verification
---

# Using Git Worktrees

## Overview

Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches simultaneously without switching.

**Core principle:** Systematic directory selection + safety verification = reliable isolation.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

This skill is responsible only for choosing a safe worktree location and creating the worktree. Repo-specific bootstrap steps belong in a follow-up skill.

## Directory Selection Process

Follow this priority order:

### 1. Check Existing Directories

```bash
# Check in priority order
ls -d .worktrees 2>/dev/null     # Preferred (hidden)
ls -d worktrees 2>/dev/null      # Alternative
```

**If found:** Use that directory. If both exist, `.worktrees` wins.

### 2. Check AGENTS.md

```bash
grep -i "worktree.*director\|worktree.*directory" AGENTS.md 2>/dev/null
```

**If preference specified:** Use it without asking.

### 3. Ask User

If no directory exists and no AGENTS.md preference:

```
No worktree directory found. Where should I create worktrees?

1. .worktrees/ (project-local, hidden)
2. ~/.config/superpowers/worktrees/<project-name>/ (global location)

Which would you prefer?
```

## Safety Verification

### For Project-Local Directories (.worktrees or worktrees)

**MUST verify directory is ignored before creating worktree:**

```bash
# Check if directory is ignored (respects local, global, and system gitignore)
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

**If NOT ignored:**

Per Jesse's rule "Fix broken things immediately":

1. Add appropriate line to .gitignore
2. Commit the change
3. Proceed with worktree creation

**Why critical:** Prevents accidentally committing worktree contents to repository.

### For Global Directory (~/.config/superpowers/worktrees)

No .gitignore verification needed - outside project entirely.

## Creation Steps

### 1. Detect Project Name

```bash
project=$(basename "$(git rev-parse --show-toplevel)")
```

### 2. Create Worktree

```bash
# Determine full path
case $LOCATION in
  .worktrees|worktrees)
    path="$LOCATION/$BRANCH_NAME"
    ;;
  ~/.config/superpowers/worktrees/*)
    path="~/.config/superpowers/worktrees/$project/$BRANCH_NAME"
    ;;
esac

# Create worktree with new branch
git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
```

### 3. Report The Worktree Path

Report the full worktree path and branch once creation succeeds.

### 4. Load Follow-Up Bootstrap Skill When Needed

If the repository has repo-specific setup requirements after worktree creation, load the follow-up skill immediately after creating the worktree.

### 5. Report Ready For Bootstrap

```
Worktree created at <full-path>
Branch: <branch-name>
Next: load any repo-specific follow-up bootstrap skill before running setup commands
```

## Quick Reference

| Situation                  | Action                                      |
| -------------------------- | ------------------------------------------- |
| `.worktrees/` exists       | Use it (verify ignored)                     |
| `worktrees/` exists        | Use it (verify ignored)                     |
| Both exist                 | Use `.worktrees/`                           |
| Neither exists             | Check `AGENTS.md` -> Ask user               |
| Directory not ignored      | Add to `.gitignore` + commit                |
| Repo needs bootstrap steps | Load the repo-specific follow-up skill      |
| No follow-up skill exists  | Report the path and ask how to bootstrap it |

## Common Mistakes

### Skipping ignore verification

- **Problem:** Worktree contents get tracked, pollute git status
- **Fix:** Always use `git check-ignore` before creating project-local worktree

### Assuming directory location

- **Problem:** Creates inconsistency, violates project conventions
- **Fix:** Follow priority: existing > AGENTS.md > ask

### Proceeding with failing tests

- **Problem:** Can't distinguish new bugs from pre-existing issues
- **Fix:** Keep baseline verification in a repo-specific follow-up skill and report failures before implementation

### Mixing creation with repo bootstrap

- **Problem:** Generic worktree creation guidance becomes wrong for repos with extra setup like `.env`, generated clients, or local services
- **Fix:** Keep this skill focused on worktree creation and link to a repo-specific bootstrap skill

## Example Workflow

```
You: I'm using the using-git-worktrees skill to set up an isolated workspace.

[Check .worktrees/ - exists]
[Verify ignored - git check-ignore confirms .worktrees/ is ignored]
[Create worktree: git worktree add .worktrees/auth -b feature/auth]
[Load follow-up bootstrap skill]

Worktree created at /Users/jesse/myproject/.worktrees/auth
Branch: feature/auth
Next: load any repo-specific follow-up bootstrap skill before running setup commands
```

## Red Flags

**Never:**

- Create worktree without verifying it's ignored (project-local)
- Skip a required repo-specific bootstrap skill
- Assume directory location when ambiguous
- Skip AGENTS.md check

**Always:**

- Follow directory priority: existing > AGENTS.md > ask
- Verify directory is ignored for project-local
- Stop after creation unless bootstrap is part of this skill
- Load the repo-specific follow-up skill when one exists
- Do not merge back or cherrypick into main branches - worktrees are for isolated experimentation only
