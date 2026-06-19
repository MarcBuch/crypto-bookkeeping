#!/usr/bin/env bun

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";

type CommandOptions = {
  cwd?: string;
  quiet?: boolean;
};

function usage() {
  console.error("Usage: bun run scripts/create-worktree.ts <branch-name> [worktree-name]");
}

function run(command: string[], options: CommandOptions = {}) {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
  });

  if (!result.success) {
    const rendered = command.map((part) => JSON.stringify(part)).join(" ");
    throw new Error(`Command failed: ${rendered}`);
  }

  if (result.stdout instanceof Uint8Array) {
    return new TextDecoder().decode(result.stdout).trim();
  }
  return '';
}

function branchExists(branchName: string) {
  const result = Bun.spawnSync(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  return result.exitCode === 0;
}

function slugifyBranchName(branchName: string) {
  return branchName
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const branchName = process.argv[2]?.trim();
const providedWorktreeName = process.argv[3]?.trim();

if (!branchName) {
  usage();
  process.exit(1);
}

const worktreeName = providedWorktreeName || slugifyBranchName(branchName);

if (!worktreeName) {
  console.error("Could not derive a worktree directory name from the branch name.");
  usage();
  process.exit(1);
}

try {
  const repoRoot = run(["git", "rev-parse", "--show-toplevel"], { quiet: true });
  const worktreesDir = join(repoRoot, ".worktrees");
  const worktreePath = join(worktreesDir, worktreeName);
  const configPath = join(repoRoot, "config.json");

  if (!existsSync(configPath)) {
    throw new Error(`Missing config.json at ${configPath}`);
  }

  if (branchExists(branchName)) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir);
  }

  run(["git", "check-ignore", "-q", ".worktrees"], { cwd: repoRoot, quiet: true });

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  run(["git", "worktree", "add", worktreePath, "-b", branchName], { cwd: repoRoot });
  copyFileSync(configPath, join(worktreePath, basename(configPath)));
  run(["bun", "install"], { cwd: worktreePath });

  console.log(`Worktree created: ${worktreePath}`);
  console.log(`Branch: ${branchName}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
