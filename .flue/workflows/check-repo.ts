import { defineWorkflow } from '@flue/runtime';
import type { ActionContext } from '@flue/runtime';
import * as v from 'valibot';

import checkRunner from '../agents/check-runner';

const DEFAULT_COMMAND = 'bun run check';
const MAX_FIX_ITERATIONS = 3;
const MAX_CHANGED_FILES = 10;

const inputSchema = v.object({
	command: v.optional(v.string()),
});

const fixSchema = v.object({
	attemptedFixes: v.array(v.string()),
	changedFiles: v.array(v.string()),
	reasonCategory: v.picklist(['fixed', 'blocked_scope', 'blocked_risk', 'blocked_missing_context']),
	blocker: v.optional(v.string()),
});

const outputSchema = v.object({
	passed: v.boolean(),
	initialFailingCommand: v.optional(v.string()),
	activeFailureClass: v.optional(v.string()),
	resolvedFailureClass: v.optional(v.string()),
	nextFailureClass: v.optional(v.string()),
	stoppedBecause: v.optional(v.string()),
	attemptedFixes: v.array(v.string()),
	changedFiles: v.array(v.string()),
	maxContextSizeUsed: v.optional(v.number()),
	finalFailingCommand: v.optional(v.string()),
	blocker: v.optional(v.string()),
	relevantOutput: v.optional(v.string()),
	runArtifactPath: v.string(),
});

export default defineWorkflow({
	agent: checkRunner,
	input: inputSchema,
	output: outputSchema,
	async run({ harness, input, log }: ActionContext<typeof inputSchema>) {
		const command = input.command?.trim() || DEFAULT_COMMAND;
		const artifactDir = `run-artifacts/check-repo/${new Date().toISOString().replaceAll(':', '-')}`;
		const attemptedFixes: string[] = [];
		const changedFiles = new Set<string>();
		let maxContextSizeUsed = 0;
		let initialFailingCommand: string | undefined;
		let activeFailureClass: string | undefined;
		let resolvedFailureClass: string | undefined;
		let nextFailureClass: string | undefined;
		let stoppedBecause: string | undefined;
		let finalFailingCommand: string | undefined;
		let blocker: string | undefined;
		let relevantOutput: string | undefined;

		for (let iteration = 0; iteration <= MAX_FIX_ITERATIONS; iteration += 1) {
			const checkResult = await harness.shell(command, { timeoutMs: 120000 });
			const failure = extractFirstFailure(checkResult);

			await harness.fs.writeFile(
				`${artifactDir}/iteration-${iteration + 1}-check.txt`,
				[`exitCode: ${checkResult.exitCode}`, '', 'stdout:', checkResult.stdout, '', 'stderr:', checkResult.stderr].join('\n'),
			);

			if (!failure) {
				const result = {
					passed: true,
					initialFailingCommand,
					activeFailureClass,
					resolvedFailureClass,
					nextFailureClass,
					stoppedBecause,
					attemptedFixes,
					changedFiles: [...changedFiles],
					maxContextSizeUsed: maxContextSizeUsed > 0 ? maxContextSizeUsed : undefined,
					finalFailingCommand: undefined,
					blocker,
					relevantOutput,
					runArtifactPath: `${artifactDir}/summary.json`,
				};

				await writeSummary(harness, artifactDir, result);
				return result;
			}

			initialFailingCommand ??= failure.command;
			activeFailureClass ??= classifyFailureCommand(failure.command);
			finalFailingCommand = failure.command;
			relevantOutput = failure.relevantOutput;
			const currentFailureClass = classifyFailureCommand(failure.command);

			if (iteration === MAX_FIX_ITERATIONS) {
				blocker = `Fix budget exhausted after ${MAX_FIX_ITERATIONS} iterations.`;
				stoppedBecause = 'budget_exhausted';
				break;
			}

			if (iteration > 0 && activeFailureClass && currentFailureClass !== activeFailureClass) {
				resolvedFailureClass = activeFailureClass;
				nextFailureClass = currentFailureClass;
				blocker = `Failure class changed from ${activeFailureClass} to ${currentFailureClass}; stopping before a new fix stage.`;
				stoppedBecause = 'next_failure_class_detected';
				break;
			}

			const scopeResult = await harness.shell(failure.command, { timeoutMs: 120000 });
			const allowedFiles = collectAllowedFiles(`${scopeResult.stdout}\n${scopeResult.stderr}`);

			if (allowedFiles.length === 0) {
				blocker = 'No explicit implicated files could be extracted from the failing output; refusing broad diagnosis.';
				stoppedBecause = 'blocked_missing_context';
				break;
			}

			await harness.fs.writeFile(
				`${artifactDir}/iteration-${iteration + 1}-scope.txt`,
				[`exitCode: ${scopeResult.exitCode}`, '', 'stdout:', scopeResult.stdout, '', 'stderr:', scopeResult.stderr].join('\n'),
			);

			const session = await harness.session(`fix-${iteration + 1}`);
			const fixResult = await session.prompt(buildFixPrompt({
				failure,
				allowedFiles,
				changedFiles: [...changedFiles],
				remainingFixes: MAX_FIX_ITERATIONS - iteration,
			}), { result: fixSchema });

			maxContextSizeUsed = Math.max(maxContextSizeUsed, fixResult.usage.input);

			for (const attemptedFix of fixResult.data.attemptedFixes) {
				attemptedFixes.push(attemptedFix);
			}

			for (const file of fixResult.data.changedFiles) {
				if (!allowedFiles.includes(file)) {
					blocker = `Out-of-scope file edit attempted: ${file}. Allowed files: ${allowedFiles.join(', ')}`;
					stoppedBecause = 'blocked_scope';
					break;
				}
				changedFiles.add(file);
			}

			await harness.fs.writeFile(
				`${artifactDir}/iteration-${iteration + 1}-fix.json`,
				JSON.stringify({
					...fixResult.data,
					contextSizeUsed: fixResult.usage.input,
				}, null, 2),
			);

			blocker ||= fixResult.data.blocker;

			if (changedFiles.size > MAX_CHANGED_FILES) {
				blocker = `Changed file budget exceeded (${changedFiles.size}/${MAX_CHANGED_FILES}).`;
				stoppedBecause = 'budget_exhausted';
				break;
			}

			if (blocker || fixResult.data.reasonCategory !== 'fixed') {
				blocker ||= `Fixer stopped with reason category ${fixResult.data.reasonCategory}.`;
				stoppedBecause ||= fixResult.data.reasonCategory;
				break;
			}

			const focusedResult = await harness.shell(failure.command, { timeoutMs: 120000 });

			await harness.fs.writeFile(
				`${artifactDir}/iteration-${iteration + 1}-focused.txt`,
				[`exitCode: ${focusedResult.exitCode}`, '', 'stdout:', focusedResult.stdout, '', 'stderr:', focusedResult.stderr].join('\n'),
			);

			if (focusedResult.exitCode !== 0) {
				relevantOutput = extractRelevantOutput(focusedResult);
				log.warn('Focused rerun still failing', { command: failure.command, iteration: iteration + 1 });
			} else {
				log.info('Focused rerun passed', { command: failure.command, iteration: iteration + 1 });
			}
		}

		const result = {
			passed: false,
			initialFailingCommand,
			activeFailureClass,
			resolvedFailureClass,
			nextFailureClass,
			stoppedBecause,
			attemptedFixes,
			changedFiles: [...changedFiles],
			maxContextSizeUsed: maxContextSizeUsed > 0 ? maxContextSizeUsed : undefined,
			finalFailingCommand,
			blocker,
			relevantOutput,
			runArtifactPath: `${artifactDir}/summary.json`,
		};

		await writeSummary(harness, artifactDir, result);
		return result;
	},
});

type FailureDetails = {
	command: string;
	relevantOutput: string;
};

function extractFirstFailure(result: { exitCode: number; stdout: string; stderr: string }): FailureDetails | undefined {
	if (result.exitCode === 0) {
		return undefined;
	}

	const output = `${result.stdout}\n${result.stderr}`;
	const failingScript = output.match(/error: script "([^"]+)" exited with code \d+/)?.[1];
	const command = failingScript ? `bun run ${failingScript}` : DEFAULT_COMMAND;

	return {
		command,
		relevantOutput: extractRelevantOutput(result),
	};
}

function extractRelevantOutput(result: { stdout: string; stderr: string }): string {
	const combined = `${result.stdout}\n${result.stderr}`.trim();
	const lines = combined.split('\n').filter(Boolean);
	return lines.slice(-40).join('\n');
}

function buildFixPrompt(input: { failure: FailureDetails; allowedFiles: string[]; changedFiles: string[]; remainingFixes: number }): string {
	return [
		`The first failing command is: ${input.failure.command}`,
		`Remaining fix iterations: ${input.remainingFixes}`,
		`The only files you may inspect or modify are: ${input.allowedFiles.join(', ')}`,
		`Already changed files in this workflow run: ${input.changedFiles.length > 0 ? input.changedFiles.join(', ') : 'none'}`,
		'Fix only the failure described below.',
		'Do not diagnose the repository globally.',
		'Do not revert, reset, or undo any existing repo changes.',
		'Do not use git checkout, git restore, git reset, or similar commands.',
		'Do not inspect or modify any file outside the allowed-file list.',
		'Do not run whole-repo autofix commands like `bun run format` or `bun run lint:fix`; prefer manual localized edits confined to the allowed files.',
		'If the failure would require broader changes or touching many unrelated files, set blocker instead of continuing.',
		'Return JSON only with reasonCategory set to one of: fixed, blocked_scope, blocked_risk, blocked_missing_context.',
		'Relevant failing output:',
		input.failure.relevantOutput,
	].join('\n\n');
}

function collectAllowedFiles(output: string): string[] {
	const sanitizedOutput = stripAnsi(output);
	const matches = sanitizedOutput.matchAll(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx|ts|jsx|json|js|md)/g);
	return [...new Set([...matches].map((match) => match[0]))];
}

function stripAnsi(value: string): string {
	return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function classifyFailureCommand(command: string): string {
	if (command.includes('jscpd')) {
		return 'jscpd';
	}

	if (command.includes('lint')) {
		return 'lint';
	}

	if (command.includes('format:check')) {
		return 'format';
	}

	if (command.includes('typecheck') || command.includes('scripts:check')) {
		return 'typecheck';
	}

	return 'unknown';
}

async function writeSummary(
	harness: { fs: { writeFile(path: string, content: string | Uint8Array): Promise<void> } },
	artifactDir: string,
	summary: unknown,
) {
	await harness.fs.writeFile(`${artifactDir}/summary.json`, JSON.stringify(summary, null, 2));
}
