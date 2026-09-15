/** Subscription quota runs in the configured Prime installation's Node runtime. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { join } from "node:path";
import { resolvePrimeAuthRuntime, type PrimeAuthOptions } from "./prime-auth-runtime.js";
import type { CodexResetResult, QuotaSnapshot } from "../shared/protocol.js";

export function queryPrimeQuota(options: PrimeAuthOptions): Promise<QuotaSnapshot> {
	return runQuotaHelper<QuotaSnapshot>(options);
}

let activeReset: Promise<CodexResetResult> | undefined;
let resetRequestId: string | undefined;

/** One user-confirmed operation at a time, including across Brief views. */
export function applyPrimeCodexReset(options: PrimeAuthOptions): Promise<CodexResetResult> {
	if (activeReset) return activeReset;
	activeReset = (async (): Promise<CodexResetResult> => {
		const confirmed = await vscode.window.showWarningMessage(
			"Apply one banked Codex reset?",
			{ modal: true, detail: "This uses one available reset to refresh eligible 5-hour and weekly limits for the currently signed-in Codex account. If nothing needs resetting, the reset is kept. This cannot be undone." },
			"Apply reset",
		);
		if (confirmed !== "Apply reset" || options.signal?.aborted) return { outcome: "cancelled" };
		// Keep the same key after an uncertain network result. Never automatically retry consumption.
		resetRequestId ??= randomUUID();
		try {
			const result = await runQuotaHelper<CodexResetResult>(options, "apply-reset", resetRequestId);
			if (result.outcome !== "unknown") resetRequestId = undefined;
			return result;
		} catch {
			return { outcome: "unknown" };
		}
	})().finally(() => { activeReset = undefined; });
	return activeReset;
}

async function runQuotaHelper<T>(options: PrimeAuthOptions, action = "query", requestId = ""): Promise<T> {
	const runtime = await resolvePrimeAuthRuntime(options);
	return new Promise((resolve, reject) => {
		const child = spawn(runtime.node, [options.helperPath ?? join(__dirname, "prime-quota-helper.mjs"), runtime.sdk, action, requestId], {
			cwd: options.cwd, env: runtime.env, stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const stop = (): void => { child.kill(); };
		options.signal?.addEventListener("abort", stop, { once: true });
		child.once("message", (message) => {
			const result = message as T & { error?: string };
			if (result.error) reject(new Error(result.error));
			else resolve(result);
			stop();
		});
		child.once("error", () => reject(new Error("Could not start the quota process.")));
		child.once("exit", () => {
			options.signal?.removeEventListener("abort", stop);
			reject(new Error("The quota process stopped."));
		});
		if (options.signal?.aborted) stop();
	});
}
