import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { providerChoices } from "../src/runtime/prime-auth-helper.mjs";

const work = mkdtempSync(join(tmpdir(), "brief-prime-auth-"));
const require = createRequire(import.meta.url);
try {
	const providers = [{ id: "anthropic", name: "Anthropic subscription" }, { id: "openai-codex", name: "Codex" }, { id: "new-oauth", name: "New OAuth" }, { id: "mcp:notion", name: "Notion" }];
	const rows = providerChoices({ getOAuthProviders: () => providers }, {
		getAll: () => ["anthropic", "openai-codex", "new-oauth", "custom-key", "custom-key", "amazon-bedrock", "prime-inference"].map((provider) => ({ provider })),
		getProviderDisplayName: (id) => id,
	});
	assert.ok(rows.every((row) => !row.id.startsWith("mcp:")));
	assert.equal(rows.filter((row) => row.id === "anthropic").length, 2);
	assert.equal(rows.filter((row) => row.id === "openai-codex").length, 1);
	assert.equal(rows.filter((row) => row.id === "new-oauth").length, 1);
	assert.equal(rows.filter((row) => row.id === "custom-key").length, 1);
	assert.match(rows.find((row) => row.id === "amazon-bedrock").unsupported, /external AWS/);
	assert.match(rows.find((row) => row.id === "prime-inference").detail, /API key only/);

	const packageRoot = join(work, "node_modules", "prime-agent");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "prime-agent", type: "module", exports: { ".": { import: "./sdk.mjs" } } }));
	const cli = join(packageRoot, "cli.js");
	writeFileSync(cli, "#!/usr/bin/env node\n");
	const bin = join(work, "bin"); mkdirSync(bin);
	const shim = join(bin, "prime-agent"); symlinkSync(cli, shim);
	const saved = join(work, "saved.json");
	const sdkSource = `
import { writeFileSync, readFileSync } from 'node:fs';
let errors = [];
export class AuthStorage {
 static create(path, options) { this.path=path ?? process.env.PRIME_AGENT_CODING_AGENT_DIR + '/auth.json'; this.options=options ?? {usePrimeCliConfig: true}; return new this(); }
 list() { return Object.keys(JSON.parse(process.env.AUTH_TEST_CREDENTIALS ?? '{}')); }
 get(id) { return JSON.parse(process.env.AUTH_TEST_CREDENTIALS ?? '{}')[id]; }
 getPrimeCliConfigPath() { return process.env.AUTH_TEST_PRIME_CONFIG; }
 logout(id) {
  if(process.env.AUTH_TEST_THROW) throw new Error('secret logout token');
  if(process.env.AUTH_TEST_FAIL) { errors.push(new Error('secret storage token')); return; }
  const credentials=JSON.parse(process.env.AUTH_TEST_CREDENTIALS ?? '{}'); delete credentials[id];
  if(id==='prime-inference' && process.env.AUTH_TEST_PRIME_CONFIG) {
   const config=JSON.parse(readFileSync(process.env.AUTH_TEST_PRIME_CONFIG,'utf8'));
   delete config.api_key; delete config.team_id; writeFileSync(process.env.AUTH_TEST_PRIME_CONFIG,JSON.stringify(config));
  }
  writeFileSync(process.env.AUTH_TEST_SAVED,JSON.stringify({removed:id,credentials}));
 }
 getOAuthProviders() { return [{id:'oauth-test', name:'OAuth Test'}]; }
 drainErrors() { const found=errors; errors=[]; return found; }
 set(id, credential) { if(process.env.AUTH_TEST_FAIL) { errors.push(new Error('secret error credential')); return; } writeFileSync(process.env.AUTH_TEST_SAVED, JSON.stringify({ id, credential, path: AuthStorage.path, options: AuthStorage.options, cwd: process.cwd(), env: process.env.AUTH_TEST_ENV })); }
 setPrimeInferenceApiKey(key) { this.set('prime-inference', {key, prime:true}); }
 async login(id, cb) {
  cb.onAuth({url:'https://example.com/login',instructions:'Enter device code 1234'});
  cb.onProgress?.('Waiting for browser');
  const tenant=await cb.onSelect({message:'Tenant',options:[{id:'team',label:'Team'}]});
  if(process.env.AUTH_TEST_MANUAL) {
   cb.onManualCodeInput();
   await new Promise(resolve=>setTimeout(resolve,30));
   this.set(id,{type:'oauth',tenant}); return;
  }
  const code=await cb.onPrompt({message:'Code',placeholder:'Paste code'});
  this.set(id,{type:'oauth',code,tenant});
 }
}
export class ModelRegistry {
 static create(auth,path) { return new this(); }
 getError() { return undefined; }
 getAll() { return ['custom-key','prime-inference','amazon-bedrock'].map(provider=>({provider})); }
 getProviderDisplayName(id) { return id; }
}
`;
	writeFileSync(join(packageRoot, "sdk.mjs"), sdkSource);
	const locatorBundle = join(work, "runtime.cjs");
	await esbuild.build({ entryPoints: ["src/runtime/prime-auth-runtime.ts"], bundle: true, platform: "node", format: "cjs", outfile: locatorBundle, logLevel: "silent" });
	const { findPrimeSdk, resolvePrimeAuthRuntime } = require(locatorBundle);
	assert.equal(findPrimeSdk(shim), join(packageRoot, "sdk.mjs"));
	assert.throws(() => findPrimeSdk(process.execPath), /does not expose/);
	const runtime = await resolvePrimeAuthRuntime({ command: shim, cwd: work, env: { ELECTRON_RUN_AS_NODE: "1", AUTH_TEST_ENV: "same-env" } });
	assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, undefined);
	assert.equal(runtime.env.AUTH_TEST_ENV, "same-env");
	const relativeRuntime = await resolvePrimeAuthRuntime({ command: "./bin/prime-agent", cwd: work });
	assert.equal(relativeRuntime.sdk, join(packageRoot, "sdk.mjs"));
	assert.ok(relativeRuntime.env.PATH.startsWith(bin));

	let selectedProvider = "custom-key";
	let inputValue = "secret-api-key";
	let cancelInput = false;
	let waitInput = false;
	let browserResult = true;
	let openUrls = [];
	let errors = [];
	let warnings = [];
	let notices = [];
	let passwordOptions = [];
	let progressCancel;
	let confirmRemoval = "Remove credentials";
	let waitConfirmation = false;
	let confirmationOpened;
	let resolveConfirmation;
	let pickedRows = [];
	class CancellationTokenSource {
		constructor() {
			this.event = new EventEmitter();
			this.token = { isCancellationRequested: false, onCancellationRequested: (fn) => { this.event.on("cancel", fn); return { dispose: () => this.event.off("cancel", fn) }; } };
		}
		cancel() { this.token.isCancellationRequested = true; this.event.emit("cancel"); }
		dispose() { this.event.removeAllListeners(); }
	}
	globalThis.__authVscode = {
		CancellationTokenSource,
		ProgressLocation: { Notification: 15 },
		Uri: { parse: (value) => ({ scheme: new URL(value).protocol.slice(0,-1), value }) },
		env: { openExternal: async (url) => { openUrls.push(url.value); return browserResult; } },
		window: {
			withProgress: async (_options, task) => { progressCancel = new CancellationTokenSource(); return task({ report() {} }, progressCancel.token); },
			showQuickPick: async (rows) => { pickedRows = rows; return rows.find((row) => row.provider?.id === selectedProvider) ?? rows.find((row) => row.id === "team"); },
			showInputBox: async (options, token) => {
				passwordOptions.push(options);
				if (waitInput) return new Promise((resolve) => token.onCancellationRequested(() => resolve(undefined)));
				return cancelInput ? undefined : inputValue;
			},
			showErrorMessage: async (message) => { errors.push(message); },
			showWarningMessage: async (message, options) => { warnings.push(message); if (options?.modal) { assert.match(options.detail, /other Brief and CLI sessions/); assert.match(options.detail, /Environment variables/); if (waitConfirmation) { confirmationOpened?.(); return new Promise((resolve) => { resolveConfirmation = resolve; }); } return confirmRemoval; } },
			showInformationMessage: async (message) => { notices.push(message); },
		},
	};
	const bundle = join(work, "ui.cjs");
	await esbuild.build({ entryPoints: ["src/runtime/prime-auth.ts"], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent", plugins: [{ name: "vscode-test", setup(build) {
		build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
		build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "module.exports = globalThis.__authVscode;", loader: "js" }));
	} }] });
	const { loginPrimeAgent, logoutPrimeAgent } = require(bundle);
	const options = { command: shim, cwd: work, helperPath: resolve("src/runtime/prime-auth-helper.mjs"), env: { AUTH_TEST_SAVED: saved, AUTH_TEST_ENV: "same-env", PRIME_AGENT_CODING_AGENT_DIR: join(work, "agent-dir"), PRIME_AGENT_SESSION_DIR: join(work, "unrelated-sessions") } };
	assert.equal(await loginPrimeAgent(options), true);
	let stored = JSON.parse(readFileSync(saved));
	assert.equal(stored.credential.key, "secret-api-key");
	assert.equal(stored.cwd, work);
	assert.equal(stored.env, "same-env");
	assert.equal(stored.path, join(options.env.PRIME_AGENT_CODING_AGENT_DIR, "auth.json"));
	assert.equal(stored.options.usePrimeCliConfig, true);
	assert.ok(passwordOptions.every((option) => option.password));
	assert.ok(notices.some((message) => message.includes("credentials saved") && message.includes("environment settings")));

	selectedProvider = "prime-inference";
	assert.equal(await loginPrimeAgent(options), true);
	assert.equal(JSON.parse(readFileSync(saved)).credential.prime, true);
	selectedProvider = "oauth-test";
	inputValue = "secret-oauth-code";
	assert.equal(await loginPrimeAgent(options), true);
	stored = JSON.parse(readFileSync(saved));
	assert.equal(stored.credential.code, inputValue);
	assert.equal(stored.credential.tenant, "team");
	assert.deepEqual(openUrls, ["https://example.com/login"]);

	waitInput = true;
	assert.equal(await loginPrimeAgent({ ...options, env: { ...options.env, AUTH_TEST_MANUAL: "1" } }), true, "callback success closes pending manual input");
	waitInput = false;
	selectedProvider = "custom-key";
	cancelInput = true;
	rmSync(saved);
	assert.equal(await loginPrimeAgent(options), false);
	assert.equal(existsSync(saved), false);
	cancelInput = false;
	assert.equal(await loginPrimeAgent({ ...options, env: { ...options.env, AUTH_TEST_FAIL: "1" } }), false);
	assert.ok(errors.every((error) => !error.includes("secret")), "SDK credential errors are redacted");
	selectedProvider = "amazon-bedrock";
	assert.equal(await loginPrimeAgent(options), false);
	assert.equal(warnings.length, 1);

	selectedProvider = "custom-key";
	waitInput = true;
	const abort = new AbortController();
	const first = loginPrimeAgent({ ...options, signal: abort.signal });
	assert.equal(loginPrimeAgent(options), first, "duplicate login shares the active flow");
	setTimeout(() => abort.abort(), 50);
	assert.equal(await first, false);
	assert.equal(existsSync(saved), false);
	assert.equal(await loginPrimeAgent({ ...options, signal: abort.signal }), false);

	waitInput = false;
	const credentials = { "custom-key": { type: "api_key", key: "secret-key" }, "oauth-test": { type: "oauth", access: "secret-oauth" }, "mcp:notion": { type: "oauth", access: "secret-mcp" }, "prime-agent-traces": { type: "api_key", key: "secret-traces" }, "amazon-bedrock": { type: "api_key", key: "external" } };
	const primeConfig = join(work, "prime-config.json");
	writeFileSync(primeConfig, JSON.stringify({ api_key: "secret-prime", team_id: "team", unrelated: "keep" }));
	const logoutOptions = { ...options, env: { ...options.env, AUTH_TEST_CREDENTIALS: JSON.stringify(credentials), AUTH_TEST_PRIME_CONFIG: primeConfig, PRIME_API_KEY: "environment-override" } };
	for (const provider of ["custom-key", "oauth-test", "prime-inference"]) {
		selectedProvider = provider;
		assert.equal(await logoutPrimeAgent(logoutOptions), true);
		assert.equal(notices.at(-1), "Saved provider credentials removed. Environment settings may still provide access.");
		const removed = JSON.parse(readFileSync(saved));
		assert.equal(removed.removed, provider);
		const remaining = { ...credentials }; delete remaining[provider];
		assert.deepEqual(removed.credentials, remaining, "other providers are preserved");
		assert.ok(pickedRows.every((row) => !row.provider.id.startsWith("mcp:") && !["prime-agent-traces", "amazon-bedrock"].includes(row.provider.id)));
		assert.ok(!JSON.stringify(pickedRows).includes("secret"), "menu contains no credentials");
	}
	assert.deepEqual(JSON.parse(readFileSync(primeConfig)), { unrelated: "keep" }, "Prime CLI key and team removed with other fields preserved");
	rmSync(saved);
	selectedProvider = "custom-key";
	confirmRemoval = undefined;
	assert.equal(await logoutPrimeAgent(logoutOptions), false, "confirmation cancellation");
	assert.equal(existsSync(saved), false);
	confirmRemoval = "Remove credentials";
	selectedProvider = "not-selected";
	assert.equal(await logoutPrimeAgent(logoutOptions), false, "selection cancellation");
	assert.equal(existsSync(saved), false);
	assert.equal(await logoutPrimeAgent({ ...options, env: { ...options.env, PRIME_API_KEY: "environment-only" } }), false, "empty list including environment-only credentials");
	assert.match(notices.at(-1), /No stored/);
	selectedProvider = "custom-key";
	for (const failure of ["AUTH_TEST_FAIL", "AUTH_TEST_THROW"]) {
		assert.equal(await logoutPrimeAgent({ ...logoutOptions, env: { ...logoutOptions.env, [failure]: "1" } }), false);
		assert.equal(existsSync(saved), false);
		assert.ok(!errors.at(-1).includes("secret"));
		assert.match(errors.at(-1), /may not have been fully removed/);
	}
	writeFileSync(primeConfig, "invalid secret JSON");
	assert.equal(await logoutPrimeAgent(logoutOptions), false, "unreadable config fails safely");
	assert.ok(!errors.at(-1).includes("secret"));
	writeFileSync(primeConfig, "{}");
	waitConfirmation = true;
	const opened = new Promise((resolve) => { confirmationOpened = resolve; });
	const logoutAbort = new AbortController();
	const pendingLogout = logoutPrimeAgent({ ...logoutOptions, signal: logoutAbort.signal });
	assert.equal(logoutPrimeAgent(logoutOptions), pendingLogout, "duplicate logout shares flow");
	assert.equal(await loginPrimeAgent(options), false, "login cannot overlap logout");
	await opened;
	logoutAbort.abort();
	assert.equal(await pendingLogout, false);
	resolveConfirmation("Remove credentials");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(existsSync(saved), false, "abort while confirmation open cannot remove credentials");
	waitConfirmation = false;
	waitInput = true;
	const loginAbort = new AbortController();
	const pendingLogin = loginPrimeAgent({ ...options, signal: loginAbort.signal });
	assert.equal(await logoutPrimeAgent(logoutOptions), false, "logout cannot overlap login");
	loginAbort.abort();
	assert.equal(await pendingLogin, false);
	assert.equal(await logoutPrimeAgent({ ...logoutOptions, signal: loginAbort.signal }), false);

	console.log("PASS prime-auth: SDK discovery, dynamic providers, API key/Prime/OAuth persistence, callbacks, cancellation, duplicate guard, logout selection/confirmation, scoped removal, Prime CLI storage, mutual exclusion, redacted errors");
} finally {
	delete globalThis.__authVscode;
	rmSync(work, { recursive: true, force: true });
}
