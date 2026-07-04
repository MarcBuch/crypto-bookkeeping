import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { type Credential, type OAuthCredential } from '@earendil-works/pi-ai';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { Hono } from 'hono';

const provider = githubCopilotProvider();
const oauth = provider.auth.oauth;
const credential = oauth ? await readGitHubCopilotCredential() : undefined;

if (oauth) {
	if (credential) {
		const activeCredential = credential.expires <= Date.now() ? await oauth.refresh(credential) : credential;
		const auth = await oauth.toAuth(activeCredential);

		registerProvider('github-copilot', {
			apiKey: auth.apiKey,
			baseUrl: auth.baseUrl,
			headers: sanitizeHeaders(auth.headers),
		});
	} else {
		throw new Error('Missing GitHub Copilot OAuth credential at ~/.pi/agent/auth.json for Flue provider registration.');
	}
}

const app = new Hono();

app.route('/', flue());

export default app;

async function readGitHubCopilotCredential(): Promise<OAuthCredential | undefined> {
	const authFilePath = join(homedir(), '.pi', 'agent', 'auth.json');

	let authFile: string;

	try {
		authFile = await readFile(authFilePath, 'utf8');
	} catch {
		return undefined;
	}

	const parsed = JSON.parse(authFile) as Record<string, Credential | undefined>;
	const currentCredential = parsed['github-copilot'];

	if (!currentCredential || currentCredential.type !== 'oauth') {
		return undefined;
	}

	return currentCredential;
}

function sanitizeHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}

	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}
