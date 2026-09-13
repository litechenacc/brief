/** VS Code credential UI backed by the user's installed Prime Agent SDK. */
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolvePrimeAuthRuntime, type PrimeAuthOptions } from "./prime-auth-runtime.js";
export type { PrimeAuthOptions } from "./prime-auth-runtime.js";

interface ProviderChoice {
	id: string;
	name: string;
	method: "oauth" | "api_key";
	unsupported?: string;
	detail?: string;
}

let activeAuth: { action: "login" | "logout"; result: Promise<boolean> } | undefined;

/** True means the SDK saved credentials. The caller must refresh available models. */
export function loginPrimeAgent(options: PrimeAuthOptions): Promise<boolean> {
	return startAuth(options, "login");
}

/** True means stored credentials were removed. The caller must refresh models. */
export function logoutPrimeAgent(options: PrimeAuthOptions): Promise<boolean> {
	return startAuth(options, "logout");
}

function startAuth(options: PrimeAuthOptions, action: "login" | "logout"): Promise<boolean> {
	if (activeAuth) {
		if (activeAuth.action === action) return activeAuth.result;
		void vscode.window.showWarningMessage("Finish or cancel the current Prime Agent login/logout first.");
		return Promise.resolve(false);
	}
	const result = runAuth(options, action).finally(() => { activeAuth = undefined; });
	activeAuth = { action, result };
	return result;
}

async function runAuth(options: PrimeAuthOptions, action: "login" | "logout"): Promise<boolean> {
	if (options.signal?.aborted) return false;
	try {
		const runtime = await resolvePrimeAuthRuntime(options);
		if (options.signal?.aborted) return false;
		return await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Prime Agent ${action}`,
			cancellable: true,
		}, (progress, cancellation) => new Promise<boolean>((resolveResult) => {
			const uiCancellation = new vscode.CancellationTokenSource();
			const child = spawn(runtime.node, [
				options.helperPath ?? join(__dirname, "prime-auth-helper.mjs"), runtime.sdk, action,
			], {
				cwd: options.cwd, env: runtime.env,
				// SDK dependencies may print sensitive diagnostics. Only IPC is read.
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			let finished = false;
			let ready = false;
			const finish = (success: boolean, error?: string): void => {
				if (finished) return;
				finished = true;
				clearTimeout(startupTimer);
				clearTimeout(loginTimer);
				options.signal?.removeEventListener("abort", abort);
				cancelSubscription.dispose();
				uiCancellation.cancel();
				uiCancellation.dispose();
				// Some SDK OAuth providers do not forward AbortSignal to their
				// callback server. Process exit also closes those listening sockets.
				if (child.connected) child.send({ type: "cancel" }, () => {});
				child.kill("SIGTERM");
				if (child.exitCode === null && child.signalCode === null) {
					const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
					killTimer.unref();
					child.once("exit", () => clearTimeout(killTimer));
				}
				if (error) void vscode.window.showErrorMessage(error);
				resolveResult(success);
			};
			const abort = (): void => finish(false);
			const cancelSubscription = cancellation.onCancellationRequested(abort);
			const startupTimer = setTimeout(() => finish(false, "The installed Prime Agent SDK did not start. Check its Node.js runtime and installation."), 30_000);
			const loginTimer = setTimeout(() => finish(false, `Prime Agent ${action} timed out. Please try again.`), 10 * 60_000);
			options.signal?.addEventListener("abort", abort, { once: true });
			const send = (message: object): void => {
				if (!finished && child.connected) child.send(message, (error) => {
					if (error) finish(false, `Prime Agent ${action} connection failed.`);
				});
			};
			child.on("error", () => finish(false, "Could not start the installed Prime Agent Node.js runtime."));
			child.on("exit", () => finish(false, `Prime Agent ${action} stopped before completion.`));
			child.on("message", (value: unknown) => {
				if (finished) return;
				void handleMessage(value).catch(() => finish(false, `Prime Agent ${action} could not complete.`));
			});
			async function handleMessage(value: unknown): Promise<void> {
				if (!value || typeof value !== "object") throw new Error("Invalid login message");
				const message = value as Record<string, unknown>;
				switch (message.type) {
					case "ready": {
						if (ready || !Array.isArray(message.choices)) throw new Error("Invalid provider list");
						ready = true;
						clearTimeout(startupTimer);
						const rows = message.choices as ProviderChoice[];
						if (rows.some((row) => !row || typeof row.id !== "string" || typeof row.name !== "string" || !["oauth", "api_key"].includes(row.method))) throw new Error("Invalid provider");
						if (action === "logout" && rows.length === 0) {
							void vscode.window.showInformationMessage("No stored model-provider credentials to remove.");
							finish(false); return;
						}
						const choice = await vscode.window.showQuickPick(rows.map((row) => ({
							label: row.name,
							description: action === "logout" ? "Stored credentials" : row.unsupported ? "Unsupported in Brief" : row.method === "oauth" ? "Browser login (OAuth)" : "API key",
							detail: row.unsupported ?? row.detail,
							provider: row,
						})), { title: action === "logout" ? "Prime Agent: Logout" : "Prime Agent: Login", placeHolder: action === "logout" ? "Choose a provider to remove stored credentials" : "Choose a provider and login method", ignoreFocusOut: true }, uiCancellation.token);
						if (finished) return;
						if (!choice) { finish(false); return; }
						if (action === "logout") {
							const confirmed = await vscode.window.showWarningMessage(
								`Remove stored credentials for ${choice.provider.name}?`,
								{ modal: true, detail: "Shared credentials may affect other Brief and CLI sessions. Environment variables and external tool credentials are not removed. Provider tokens and browser sessions may remain valid. Running requests may continue; agents and sessions will not be stopped or restarted." },
								"Remove credentials",
							);
							if (finished) return;
							if (confirmed !== "Remove credentials") { finish(false); return; }
							send({ type: "logout", provider: choice.provider.id, method: choice.provider.method });
							return;
						}
						if (choice.provider.unsupported) {
							void vscode.window.showWarningMessage(choice.provider.unsupported);
							finish(false); return;
						}
						progress.report({ message: `Signing in to ${choice.provider.name}` });
						send({ type: "login", provider: choice.provider.id, method: choice.provider.method });
						return;
					}
					case "auth": {
						if (typeof message.url !== "string") throw new Error("Missing login URL");
						const url = vscode.Uri.parse(message.url, true);
						if (url.scheme !== "https" && url.scheme !== "http") throw new Error("Invalid login URL");
						if (typeof message.instructions === "string" && message.instructions) {
							progress.report({ message: message.instructions });
							void vscode.window.showInformationMessage(message.instructions);
						}
						if (!await vscode.env.openExternal(url)) finish(false, "Could not open the login page in your browser.");
						return;
					}
					case "prompt": {
						if (typeof message.id !== "number" || typeof message.message !== "string") throw new Error("Invalid login prompt");
						let answer: string | undefined;
						if (message.kind === "select") {
							if (!Array.isArray(message.options) || message.options.some((option) => !option || typeof option.id !== "string" || typeof option.label !== "string")) throw new Error("Invalid login options");
							const selected = await vscode.window.showQuickPick(message.options as Array<{ id: string; label: string }>, { title: message.message, ignoreFocusOut: true }, uiCancellation.token);
							answer = selected?.id;
						} else if (message.kind === "input") {
							answer = await vscode.window.showInputBox({
								title: `Prime Agent ${action}`, prompt: message.message,
								placeHolder: typeof message.placeholder === "string" ? message.placeholder : undefined,
								password: true, ignoreFocusOut: true,
								validateInput: (input) => message.allowEmpty || input.trim() ? undefined : "Enter a value or press Escape to cancel.",
							}, uiCancellation.token);
						} else throw new Error("Unknown login prompt");
						if (finished) return;
						if (answer === undefined) { finish(false); return; }
						send({ type: "reply", id: message.id, value: answer });
						return;
					}
					case "progress":
						if (typeof message.message === "string") progress.report({ message: message.message });
						return;
					case "done":
						void vscode.window.showInformationMessage(action === "logout"
							? "Saved provider credentials removed. Environment settings may still provide access."
							: "Prime Agent credentials saved. Existing environment settings can override saved API keys.");
						finish(true); return;
					case "error": finish(false, `Prime Agent ${action} failed. Credentials may not have been ${action === "logout" ? "fully removed" : "saved"}. Check the installed SDK and auth configuration.`); return;
					default: throw new Error("Unknown login message");
				}
			}
			if (cancellation.isCancellationRequested || options.signal?.aborted) abort();
		}));
	} catch {
		// Do not display arbitrary SDK, process, or filesystem exception payloads.
		void vscode.window.showErrorMessage(`Prime Agent ${action} is unavailable. Configure brief.command with the npm-installed prime-agent executable and its Node.js runtime.`);
		return false;
	}
}
