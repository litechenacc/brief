/** Resolve the SDK belonging to the configured CLI, never Brief's dependencies. */
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { locateAgent, searchDirs, splitPath } from "./agent-locator.js";

export interface PrimeAuthOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	helperPath?: string;
	signal?: AbortSignal;
}

export function findPrimeSdk(command: string): string {
	let directory = dirname(realpathSync(command));
	// npm on Windows uses a .cmd file beside node_modules, not a symlink.
	const adjacent = join(directory, "node_modules", "prime-agent");
	const candidates = [adjacent];
	while (true) {
		candidates.push(directory);
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	for (const candidate of candidates) {
		try {
			const metadata = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
			if (metadata.name !== "prime-agent") continue;
			const entry = metadata.exports?.["."]?.import;
			if (typeof entry !== "string" || !entry.startsWith("./")) continue;
			const sdk = resolve(candidate, entry);
			if (existsSync(sdk)) return sdk;
		} catch { /* Not a package root. */ }
	}
	throw new Error("The configured Prime Agent command does not expose its installed SDK. Configure brief.command with the npm-installed prime-agent executable.");
}

export async function resolvePrimeAuthRuntime(options: PrimeAuthOptions): Promise<{ node: string; sdk: string; env: NodeJS.ProcessEnv }> {
	const configured = /[\\/]/.test(options.command) ? resolve(options.cwd, options.command) : options.command;
	const located = await locateAgent(configured);
	const env = { ...process.env, ...options.env };
	if (located.envPath) env.PATH = located.envPath;
	delete env.ELECTRON_RUN_AS_NODE;
	const command = resolve(options.cwd, located.command);
	const sdk = findPrimeSdk(command);
	const node = searchDirs("node", splitPath(env.PATH));
	if (!node) throw new Error("Prime Agent login requires the Node.js runtime used by your installed agent.");
	return { node, sdk, env };
}
