/** Runs only in the installed agent's Node runtime. No SDK code is bundled. */
import { pathToFileURL } from "node:url";

// Standard API-key entry cannot reproduce these providers' private/external setup.
const unsupported = {
	"prime-agent-traces": "Prime Agent Traces login is not exposed by the public SDK.",
	"amazon-bedrock": "Amazon Bedrock requires external AWS credential setup.",
	"google-vertex": "Google Vertex AI requires external Google Cloud credential setup.",
};

export function providerChoices(auth, registry) {
	// MCP service login also requires resource reload and is outside this UI.
	const oauth = auth.getOAuthProviders().filter(({ id }) => !id.startsWith("mcp:"));
	const choices = oauth.map(({ id, name }) => ({ id, name, method: "oauth", unsupported: unsupported[id] }));
	const oauthIds = new Set(oauth.map(({ id }) => id));
	for (const id of new Set(registry.getAll().map((model) => model.provider))) {
		if (id.startsWith("mcp:")) continue;
		// The SDK has no public API-key capability metadata. Do not offer keys
		// for subscription routes. Anthropic explicitly supports both methods.
		const name = registry.getProviderDisplayName(id);
		if (oauthIds.has(id) && id !== "anthropic") continue;
		choices.push({ id, name, method: "api_key", unsupported: unsupported[id],
			detail: id === "prime-inference" ? "API key only; browser login and team selection are unavailable in Brief." : undefined });
	}
	return choices.sort((a, b) => a.name.localeCompare(b.name) || a.method.localeCompare(b.method));
}

export async function runAuthHelper(sdkUrl, channel = process) {
	const send = (message) => { if (channel.connected) channel.send(message); };
	const controller = new AbortController();
	const pending = new Map();
	let sequence = 0;
	let busy = false;
	let auth;
	let choices;
	const ask = (kind, data = {}) => new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		send({ type: "prompt", id, kind, ...data });
	});
	const cancel = () => {
		controller.abort();
		for (const entry of pending.values()) entry.reject(new Error("Cancelled"));
		pending.clear();
	};
	channel.on("disconnect", cancel);
	channel.on("message", async (message) => {
		if (message?.type === "cancel") { cancel(); return; }
		if (message?.type === "reply") {
			const entry = pending.get(message.id);
			if (!entry) return;
			pending.delete(message.id);
			if (typeof message.value === "string") entry.resolve(message.value);
			else { entry.reject(new Error("Cancelled")); cancel(); }
			return;
		}
		if (message?.type !== "login" || busy || !choices) return;
		busy = true;
		try {
			const choice = choices.find((row) => row.id === message.provider && row.method === message.method);
			if (!choice || choice.unsupported) throw new Error("Unsupported provider");
			if (choice.method === "api_key") {
				const key = await ask("input", { message: `API key for ${choice.name}`, password: true });
				if (!key.trim() || key.trim().startsWith("!")) throw new Error("Invalid API key");
				if (controller.signal.aborted) return;
				if (choice.id === "prime-inference") auth.setPrimeInferenceApiKey(key.trim());
				else auth.set(choice.id, { type: "api_key", key: key.trim() });
			} else {
				await auth.login(choice.id, {
					onAuth: (info) => send({ type: "auth", url: info.url, instructions: info.instructions }),
					onPrompt: (prompt) => ask("input", { ...prompt, password: true }),
					onManualCodeInput: () => ask("input", { message: "Complete login in your browser, or paste the redirect URL / authorization code.", password: true }),
					onSelect: (prompt) => ask("select", prompt),
					onProgress: (message) => send({ type: "progress", message }),
					signal: controller.signal,
				});
			}
			if (auth.drainErrors().length) throw new Error("Credential storage failed");
			if (!controller.signal.aborted) send({ type: "done" });
		} catch {
			// SDK errors can include tokens, redirect URLs, or HTTP response bodies.
			send({ type: "error", message: "Prime Agent login failed or credentials could not be saved. Try again and check the provider configuration." });
		}
	});
	try {
		const { AuthStorage, ModelRegistry } = await import(sdkUrl);
		auth = AuthStorage.create();
		const registry = ModelRegistry.create(auth);
		if (auth.drainErrors().length || registry.getError()) throw new Error("Cannot load auth configuration");
		choices = providerChoices(auth, registry);
		send({ type: "ready", choices });
	} catch {
		send({ type: "error", message: "Cannot load the installed Prime Agent SDK or its auth configuration. Prime Agent requires Node.js 22.8 or newer." });
	}
}

if (process.argv[2] && process.send) void runAuthHelper(pathToFileURL(process.argv[2]).href);
