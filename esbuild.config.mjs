import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, watch as watchFile } from "node:fs";
import { execFileSync } from "node:child_process";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const shared = {
	logLevel: "info",
	sourcemap: !production,
	minify: production,
};

function sourceRevision() {
	try {
		const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return revision || "nogit";
	} catch {
		return "nogit";
	}
}

// BUILD_REV takes precedence for release builds. SOURCE_DATE_EPOCH makes a
// source build reproducible, while a normal local build still changes its
// webview cache key after a rebuild.
const buildTimestamp = process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000).toString();
const buildRev = process.env.BUILD_REV ?? `${sourceRevision()}-${buildTimestamp}`;

const extensionConfig = {
	...shared,
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/extension.js",
	external: ["vscode"],
	define: { BRIEF_BUILD_REV: JSON.stringify(buildRev) },
};

const webviewConfig = {
	...shared,
	entryPoints: ["webview/main.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	outfile: "media/main.js",
	define: { BRIEF_BUILD_REV: JSON.stringify(buildRev) },
};

// Test harness bundles are built together and never shipped.
const testConfig = {
	...shared,
	entryPoints: {
		controller: "src/session/session-controller.ts",
		"session-actions": "src/session/session-actions.ts",
		"daemon-sidecar": "src/runtime/daemon-sidecar.ts",
		"bash-processes": "src/runtime/bash-processes.ts",
		"background-tasks": "src/runtime/background-tasks.ts",
	},
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outdir: "dist",
	outExtension: { ".js": ".cjs" },
	external: ["vscode"],
};

const smokeConfig = {
	...shared,
	entryPoints: ["test/smoke.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	outfile: "test/smoke.mjs",
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
};

// The installed SDK runs in its own Node process, not the extension host.
function copyAuthHelper() {
	mkdirSync("dist", { recursive: true });
	copyFileSync("src/runtime/prime-auth-helper.mjs", "dist/prime-auth-helper.mjs");
	copyFileSync("src/runtime/prime-quota-helper.mjs", "dist/prime-quota-helper.mjs");
}
copyAuthHelper();

if (watch) {
	watchFile("src/runtime/prime-auth-helper.mjs", copyAuthHelper);
	watchFile("src/runtime/prime-quota-helper.mjs", copyAuthHelper);
	const ext = await esbuild.context(extensionConfig);
	const web = await esbuild.context(webviewConfig);
	await Promise.all([ext.watch(), web.watch()]);
} else {
	await esbuild.build(extensionConfig);
	await esbuild.build(webviewConfig);
	if (!production) {
		await esbuild.build(smokeConfig);
		await esbuild.build(testConfig);
	}
}
