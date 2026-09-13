/** Browser regression: DOM-only tests cannot detect missing CSS animation. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage({ reducedMotion: "no-preference" });
	await page.setContent(`<body style="--vscode-foreground: #ccc; --vscode-descriptionForeground: #ccc">
		<div class="working-row" role="status" aria-label="Working">
			<span class="working-mark" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /></svg></span>
			<span class="working-label">Thinking</span><span class="working-elapsed">7s</span>
		</div>
		<div class="status-strip"><span class="conn-dot working"></span><span class="live-label working">running</span></div>
		<span class="conn-dot" id="idle-lamp"></span>
		<span class="conn-dot complete" id="complete-lamp"></span>
		<span class="running-mark working"><span class="running-dot"></span></span>
		<span class="running-mark complete"><span class="running-dot"></span></span>
	</body>`);
	await page.locator(".working-mark").evaluate(mark => {
		const svg = mark.querySelector("svg");
		svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
		mark.style.setProperty("--working-icon", `url("data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}")`);
	});
	await page.addStyleTag({ path: "media/main.css" });
	assert.equal(await page.locator("#idle-lamp").evaluate(el => getComputedStyle(el).display), "none", "idle has no lamp or reserved width");
	for (const selector of [".conn-dot.working", ".running-mark.working .running-dot"]) {
		assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor), "rgb(229, 72, 77)");
	}
	for (const selector of ["#complete-lamp", ".running-mark.complete .running-dot"]) {
		assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor), "rgb(48, 164, 108)");
	}
	const row = page.locator(".working-row");
	assert.equal(await row.evaluate(el => el.getAnimations({ subtree: true }).length), 1,
		"working row has one sweep and no separate icon pulse");
	const samples = await row.evaluate(element => {
		const animation = element.getAnimations()[0];
		animation.pause();
		animation.currentTime = 0;
		const start = getComputedStyle(element).backgroundPosition;
		animation.currentTime = 2550;
		return { start, end: getComputedStyle(element).backgroundPosition,
			name: getComputedStyle(element).animationName,
			duration: getComputedStyle(element).animationDuration };
	});
	assert.equal(samples.name, "working-sheen");
	assert.equal(samples.duration, "3s");
	assert.notEqual(samples.start, samples.end);
	for (const selector of [".working-mark", ".working-label", ".working-elapsed"]) {
		const style = await page.locator(selector).evaluate(el => ({
			animation: getComputedStyle(el).animationName,
			background: getComputedStyle(el).backgroundImage,
			fill: getComputedStyle(el).webkitTextFillColor,
		}));
		assert.equal(style.animation, "none", `${selector} has no independent animation`);
		assert.equal(style.background, selector === ".working-mark"
			? await row.evaluate(el => getComputedStyle(el).backgroundImage) : "none",
			`${selector} shares the row gradient`);
		assert.equal(style.fill, "rgba(0, 0, 0, 0)", `${selector} reveals the shared gradient`);
	}
	// Check painted text, not only computed animation properties, in both themes.
	for (const theme of [
		{ name: "vscode-dark", foreground: "#cccccc", background: "#181818" },
		{ name: "vscode-light", foreground: "#616161", background: "#ffffff" },
	]) {
		await page.evaluate(theme => {
			document.body.className = theme.name;
			document.body.style.setProperty("--vscode-foreground", theme.foreground);
			document.body.style.setProperty("--vscode-sideBar-background", theme.background);
		}, theme);
		for (const selector of [".working-mark", ".working-label", ".working-elapsed"]) {
			await row.evaluate(el => { el.getAnimations()[0].currentTime = 0; });
			const before = await page.locator(selector).screenshot();
			await row.evaluate(el => { el.getAnimations()[0].currentTime = 1650; });
			assert.notDeepEqual(await page.locator(selector).screenshot(), before,
				`${theme.name} visibly sweeps ${selector}, including elapsed time`);
		}
		if (theme.name === "vscode-light") {
			assert.ok(await row.evaluate(el => getComputedStyle(el).backgroundImage.includes("rgb(0, 95, 184)")),
				"light theme uses a colored sweep instead of gray-to-black shading");
		}
	}
	const layout = await page.locator(".working-row").evaluate(row => {

		const label = row.querySelector(".working-label");
		const elapsed = row.querySelector(".working-elapsed");
		return {
			rowWidth: row.getBoundingClientRect().width,
			contentWidth: elapsed.getBoundingClientRect().right - row.getBoundingClientRect().left,
			gapBeforeDot: elapsed.getBoundingClientRect().left - label.getBoundingClientRect().right,
			gapAfterDot: getComputedStyle(elapsed).gap,
			dot: getComputedStyle(elapsed, "::before").content,
		};
	});
	assert.ok(Math.abs(layout.rowWidth - layout.contentWidth - 2) < 1, "gradient fits the text, not the transcript width");
	assert.equal(layout.gapBeforeDot, 8);
	assert.equal(layout.gapAfterDot, "8px");
	assert.equal(layout.dot, '"·"');
	const statusMotion = await page.locator(".status-strip").evaluate(strip => {
		const dot = strip.querySelector(".conn-dot");
		const label = strip.querySelector(".live-label");
		const sample = element => {
			const animation = element.getAnimations()[0];
			animation.pause();
			animation.currentTime = 0;
			const start = { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
			animation.currentTime = 1400;
			return { start, end: { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform } };
		};
		const dotBox = dot.getBoundingClientRect();
		const labelBox = label.getBoundingClientRect();
		return {
			dot: sample(dot),
			label: sample(label),
			centerDelta: Math.abs((dotBox.top + dotBox.bottom) / 2 - (labelBox.top + labelBox.bottom) / 2),
		};
	});
	for (const target of [statusMotion.dot, statusMotion.label]) {
		assert.ok(Math.abs(target.start.opacity - target.end.opacity) > 0.3, "status marker changes brightness");
		assert.equal(target.start.transform, "none", "status marker does not scale");
		assert.equal(target.end.transform, "none", "status marker does not scale");
	}
	assert.ok(statusMotion.centerDelta < 0.5, "status dot and label are vertically aligned");
	// VS Code can override the OS preference with workbench.reduceMotion: off.
	await page.emulateMedia({ reducedMotion: "reduce" });
	assert.equal(await row.evaluate(el => el.getAnimations().length), 1,
		"shared sheen follows VS Code's motion setting, not the OS media query");
	for (const state of [
		{ reducedMotion: "reduce", className: "vscode-reduce-motion" },
		{ reducedMotion: "no-preference", className: "vscode-reduce-motion" },
		{ reducedMotion: "no-preference", className: "", forcedColors: "active" },
		{ reducedMotion: "no-preference", className: "vscode-high-contrast" },
		{ reducedMotion: "no-preference", className: "vscode-high-contrast-light" },
	]) {
		await page.emulateMedia({ reducedMotion: state.reducedMotion, forcedColors: state.forcedColors ?? "none" });
		await page.evaluate(className => { document.body.className = className; }, state.className);
		assert.equal(await page.locator(".working-row").evaluate(el => el.getAnimations({ subtree: true }).length), 0);
		for (const selector of [".working-label", ".working-elapsed"]) {
			assert.notEqual(await page.locator(selector).evaluate(el => getComputedStyle(el).webkitTextFillColor), "rgba(0, 0, 0, 0)");
		}
	}
	await page.evaluate(() => { document.body.className = ""; });
	assert.equal(await row.evaluate(el => getComputedStyle(el).animationName), "working-sheen",
		"turning reduced motion off restores sheen without reloading");
	const startup = await browser.newPage({ reducedMotion: "no-preference" });
	await startup.setContent('<div id="app"></div><script id="cached-models" type="application/json">[{"provider":"cached","id":"cached-model"}]</script>');
	await startup.evaluate(() => {
		window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
	});
	await startup.addStyleTag({ path: "media/main.css" });
	await startup.addScriptTag({ path: "media/main.js" });
	const input = startup.locator("textarea");
	const send = startup.locator(".send-btn:not(.stop)");
	await input.fill("draft before connection");
	assert.equal(await send.isDisabled(), true);
	assert.equal(await send.evaluate(el => getComputedStyle(el).borderTopStyle), "dashed");
	assert.equal(await send.evaluate(el => el.getAnimations({ subtree: true }).length), 0, "loading send button is static");
	assert.equal(await startup.locator(".boot-splash").count(), 0);
	assert.ok(await startup.locator(".welcome").evaluate(el => el.getAnimations({ subtree: true }).length > 0), "welcome keeps its decorative animation");
	await startup.locator(".rail-pill.model").click();
	assert.ok(await startup.locator(".dropdown-item").filter({ hasText: "cached-model" }).count(), "cached picker is usable before connection");
	await startup.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
		type: "status", status: { connected: true, restoring: false, sessionId: "created", modelLabel: "cached/cached-model", modelProvider: "cached", modelId: "cached-model", thinkingLevel: "off" },
	} })));
	assert.equal(await input.inputValue(), "draft before connection");
	assert.equal(await send.isDisabled(), false);
	assert.notEqual(await send.evaluate(el => getComputedStyle(el).borderTopStyle), "dashed");
	await input.press("Escape");
	await send.click();
	const working = startup.locator(".working-row");
	for (const provider of ["openai-codex", "anthropic"]) {
		await startup.evaluate(provider => {
			document.body.className = "vscode-light";
			document.body.style.setProperty("--vscode-foreground", "#616161");
			document.body.style.setProperty("--vscode-sideBar-background", "#ffffff");
			window.dispatchEvent(new MessageEvent("message", { data: {
				type: "status", status: { connected: true, sessionId: "created", modelProvider: provider, modelId: "test-model", modelLabel: `${provider}/test-model` },
			} }));
		}, provider);
		const mark = working.locator(".working-mark");
		assert.ok(await mark.evaluate(el => getComputedStyle(el).maskImage.includes("data:image/svg+xml")),
			`${provider} uses its SVG shape as the sweep mask`);
		await working.evaluate(el => { const a = el.getAnimations()[0]; a.pause(); a.currentTime = 0; });
		const before = await mark.screenshot();
		await working.evaluate(el => { el.getAnimations()[0].currentTime = 1500; });
		assert.notDeepEqual(await mark.screenshot(), before, `${provider} icon visibly changes with the shared sweep`);
		assert.equal(await working.evaluate(el => el.getAnimations({ subtree: true }).length), 1);
		await startup.evaluate(() => document.body.classList.add("vscode-reduce-motion"));
		assert.equal(await mark.evaluate(el => getComputedStyle(el).maskImage), "none");
		assert.equal(await mark.locator("svg").evaluate(el => getComputedStyle(el).visibility), "visible",
			"reduced motion keeps the original provider icon visible");
	}

	for (const status of [
		{ connected: false },
		{ connected: true, streaming: true, historyRunning: true, statusText: "running" },
		{ connected: true, streaming: false, historyRunning: false, unreadComplete: true },
	]) {
		await startup.evaluate(status => window.dispatchEvent(new MessageEvent("message", { data: {
			type: "status", status: { sessionId: "created", ...status },
		} })), status);
		assert.equal(await startup.locator(".status-strip").evaluate(el => getComputedStyle(el).display), "none", "composer status stays hidden after runtime updates");
		for (const selector of [".status-strip", ".conn-dot", ".live-label"]) {
			assert.equal(await startup.locator(selector).boundingBox(), null, `${selector} has no visible content or reserved space`);
		}
	}
	console.log("PASS composer runtime indicator stays hidden without reserved space");
	console.log("PASS startup draft, cached picker, static dashed send and decorative welcome animation");
	console.log("PASS working verb/timer sheen, reduced motion and forced colors");
} finally {
	await browser.close();
}
