/** Browser regression: DOM-only tests cannot detect missing CSS animation. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage({ reducedMotion: "no-preference" });
	await page.setContent(`<body style="--vscode-foreground: #ccc; --vscode-descriptionForeground: #ccc">
		<div class="working-row" role="status" aria-label="Working">
			<span class="working-mark" aria-hidden="true">B</span>
			<span class="working-label">Thinking</span><span class="working-elapsed">7s</span>
		</div>
		<div class="status-strip"><span class="conn-dot working"></span><span class="live-label working">running</span></div>
		<span class="conn-dot" id="idle-lamp"></span>
		<span class="conn-dot complete" id="complete-lamp"></span>
		<span class="running-mark working"><span class="running-dot"></span></span>
		<span class="running-mark complete"><span class="running-dot"></span></span>
	</body>`);
	await page.addStyleTag({ path: "media/main.css" });
	assert.equal(await page.locator("#idle-lamp").evaluate(el => getComputedStyle(el).display), "none", "idle has no lamp or reserved width");
	for (const selector of [".conn-dot.working", ".running-mark.working .running-dot"]) {
		assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor), "rgb(229, 72, 77)");
	}
	for (const selector of ["#complete-lamp", ".running-mark.complete .running-dot"]) {
		assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor), "rgb(48, 164, 108)");
	}
	assert.equal(await page.locator(".working-mark").evaluate(el => getComputedStyle(el).fontWeight), "800");
	for (const selector of [".working-label", ".working-elapsed"]) {
		const samples = await page.locator(selector).evaluate(element => {
			const animation = element.getAnimations()[0];
			if (!animation) return null;
			animation.pause();
			animation.currentTime = 0;
			const start = getComputedStyle(element).backgroundPosition;
			animation.currentTime = 3400;
			return { start, end: getComputedStyle(element).backgroundPosition,
				name: getComputedStyle(element).animationName,
				gradient: getComputedStyle(element).backgroundImage };
		});
		assert.equal(samples?.name, "working-sheen", `${selector} has sweeping animation`);
		assert.notEqual(samples.start, samples.end);
		assert.ok(samples.gradient.includes("gradient"), "sheen has a brightness gradient even with identical theme colors");
	}
	const layout = await page.locator(".working-row").evaluate(row => {

		const label = row.querySelector(".working-label");
		const elapsed = row.querySelector(".working-elapsed");
		return {
			sameAnimation: getComputedStyle(label).animationName === getComputedStyle(elapsed).animationName,
			gapBeforeDot: elapsed.getBoundingClientRect().left - label.getBoundingClientRect().right,
			gapAfterDot: getComputedStyle(elapsed).gap,
			dot: getComputedStyle(elapsed, "::before").content,
		};
	});
	assert.ok(layout.sameAnimation, "verb and timer share the sweeping animation");
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
	for (const media of [{ reducedMotion: "reduce" }, { reducedMotion: "no-preference", forcedColors: "active" }]) {
		await page.emulateMedia(media);
		assert.equal(await page.locator(".working-row").evaluate(el => el.getAnimations({ subtree: true }).length), 0);
		for (const selector of [".working-label", ".working-elapsed"]) {
			assert.notEqual(await page.locator(selector).evaluate(el => getComputedStyle(el).webkitTextFillColor), "rgba(0, 0, 0, 0)");
		}
	}
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
