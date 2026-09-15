/** Brief-owned subscription queries. Only normalized quota data leaves this process. */
import { pathToFileURL } from "node:url";

const percent = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const timestamp = (value) => {
	const ms = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

async function getJson(url, headers) {
	const response = await fetch(url, { headers, redirect: "error" });
	if (!response.ok) {
		const error = new Error("Quota request failed");
		error.status = response.status;
		throw error;
	}
	return response.json();
}

async function codexHeaders(auth) {
	const token = await auth.getApiKey("openai-codex");
	const credential = auth.get("openai-codex");
	if (!token || credential?.type !== "oauth") throw new Error("Codex OAuth unavailable");
	const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "codex-cli" };
	if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
	return headers;
}

async function applyCodexReset(auth, requestId) {
	const headers = await codexHeaders(auth);
	// This POST is only entered after the extension host's explicit confirmation.
	const response = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
		method: "POST", headers: { ...headers, "Content-Type": "application/json" }, redirect: "error",
		body: JSON.stringify({ redeem_request_id: requestId }),
	});
	if (!response.ok) return { outcome: "unknown" };
	const data = await response.json();
	return { outcome: ["reset", "nothing_to_reset", "no_credit", "already_redeemed"].includes(data.code) ? data.code : "unknown" };
}

async function codex(auth) {
	const headers = await codexHeaders(auth);
	const data = await getJson("https://chatgpt.com/backend-api/wham/usage", headers);
	const window = [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]
		.find((window) => window?.limit_window_seconds === 604800);
	const count = data.rate_limit_reset_credits?.available_count;
	return { period: "weekly", usedPercent: percent(window?.used_percent), resetAt: timestamp(window?.reset_at),
		bankedResets: Number.isInteger(count) && count >= 0 ? count : undefined,
		...(!window ? { error: "The response did not provide a weekly quota window." } : {}) };
}

async function grok(auth) {
	const credential = auth.get("xai-oauth");
	if (credential?.type !== "oauth" || !credential.access) return { error: "Sign in using the existing xai-oauth login." };
	if (!(credential.expires > Date.now())) return { error: "The xai-oauth token has expired. Use the existing login flow, then refresh." };
	// Proxy identity follows pi-grok's current Web API contract, not its extension runtime.
	const version = process.env.PI_XAI_CLIENT_VERSION || "0.2.101";
	const headers = {
		Authorization: `Bearer ${credential.access}`, Accept: "application/json",
		"User-Agent": `grok-shell/${version}`,
		"x-grok-client-identifier": "grok-shell", "x-grok-client-version": version,
		"x-grok-client-mode": "interactive", "X-XAI-Token-Auth": "xai-grok-cli",
		"x-authenticateresponse": "authenticate-response",
	};
	const base = "https://cli-chat-proxy.grok.com/v1";
	const user = await getJson(`${base}/user`, headers);
	const data = await getJson(`${base}/billing?format=credits`, { ...headers, "x-userid": user.userId });
	const config = data.config;
	const periodType = config?.currentPeriod?.type;
	const period = periodType === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly"
		: periodType === "USAGE_PERIOD_TYPE_MONTHLY" ? "monthly" : "unknown";
	return { period, usedPercent: percent(config?.creditUsagePercent),
		resetAt: timestamp(config?.currentPeriod?.end ?? config?.billingPeriodEnd) };
}

async function query(provider, action) {
	try { return { provider, ...await action(), fetchedAt: new Date().toISOString() }; }
	catch (error) {
		const message = error.status === 401 || error.status === 403 ? "Authentication failed or access was denied. Check your subscription and login."
			: error.status ? `The quota service returned HTTP ${error.status}.` : "Could not query quota. Check the network, service, and login.";
		return { provider, fetchedAt: new Date().toISOString(), error: message };
	}
}

try {
	const { AuthStorage } = await import(pathToFileURL(process.argv[2]).href);
	const auth = AuthStorage.create();
	if (process.argv[3] === "apply-reset") {
		const result = await applyCodexReset(auth, process.argv[4]);
		process.send(result, () => process.disconnect());
	} else {
		const providers = await Promise.all([
			query("codex", () => codex(auth)), query("grok", () => grok(auth)),
		]);
		process.send({ providers }, () => process.disconnect());
	}
} catch {
	process.send({ error: "Could not load the installed Prime SDK or authentication settings." }, () => process.disconnect());
}
