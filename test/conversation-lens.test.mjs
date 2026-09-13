/** Conversation Turn Lens DOM checks. */
import { Window } from "happy-dom";
import * as fs from "node:fs";

const window = new Window({ url: "https://webview.local/" });
const document = window.document;
document.body.innerHTML = '<div id="app"></div>';
document.body.className = "vscode-dark";
const posted = [];
const css = fs.readFileSync(new URL("../media/main.css", import.meta.url), "utf8");
const vscodeApi = { postMessage: (message) => posted.push(message), getState: () => undefined, setState: () => {} };
globalThis.window = window;
globalThis.document = document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLAnchorElement = window.HTMLAnchorElement;
globalThis.SVGSVGElement = window.SVGSVGElement;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.FileReader = window.FileReader;
globalThis.Event = window.Event;
globalThis.acquireVsCodeApi = () => vscodeApi;
window.acquireVsCodeApi = () => vscodeApi;
window.eval(fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8"));

const status = { connected: true, streaming: false, compacting: false, retrying: false, restoring: false,
	modelLabel: "test/model", thinkingLevel: "off", sessionId: "lens-session", sessionFile: "/tmp/lens.jsonl" };
const snapshot = (count) => ({ type: "snapshot", status, state: null,
	messages: Array.from({ length: count }, (_, index) => ({ role: "user", content: [{ type: "text", text: `prompt ${index + 1}` }] })) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, condition) => { if (!condition) throw new Error(`FAIL ${name}`); console.log(`PASS ${name}`); };

window.dispatchEvent(new window.MessageEvent("message", { data: snapshot(0) }));
check("hidden without turns", document.querySelector(".conversation-lens")?.hidden === true);
for (const count of [1, 2, 7, 10]) {
	window.dispatchEvent(new window.MessageEvent("message", { data: snapshot(count) }));
	check(`visible at ${count} turns without hover`, document.querySelector(".conversation-lens")?.hidden === false);
	check(`short thread has ${count} markers`, document.querySelectorAll(".lens-individual").length === count);
	const shortLens = document.querySelector(".conversation-lens");
	shortLens.dispatchEvent(new window.MouseEvent("mouseenter"));
	check("short thread does not magnify on hover", !shortLens.classList.contains("expanded"));
}
window.dispatchEvent(new window.MessageEvent("message", { data: snapshot(11) }));
const lens = document.querySelector(".conversation-lens");
check("visible at eleven turns", lens?.hidden === false);
check("lens leaves the native scrollbar gutter usable", /\.conversation-lens \{[^}]*right: 24px;/.test(css));
window.dispatchEvent(new window.MessageEvent("message", { data: snapshot(200) }));
Object.defineProperty(lens, "getBoundingClientRect", { value: () => ({ top: 0, height: 600, left: 0, right: 24, width: 24 }) });
lens.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
check("expanded lens has seven individual turns", lens.querySelectorAll(".lens-individual").length === 7);
const densePositions = [...lens.querySelectorAll(".lens-individual")].map((marker) => Number.parseFloat(marker.style.top));
check("dense thread gives singles distinct ordered positions", densePositions.length === 7 && new Set(densePositions).size === 7 && densePositions.every((top, index) => index === 0 || top > densePositions[index - 1]));
const denseContext = lens.querySelector(".lens-context-5");
const denseMidpoint = denseContext ? Math.round((Number(denseContext.dataset.start) + Number(denseContext.dataset.end)) / 2) : -1;
denseContext?.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
await wait(50);
check("context hover focuses its midpoint", denseMidpoint >= 0 && [...lens.querySelectorAll(".lens-individual")].some((marker) => Number(marker.dataset.start) === denseMidpoint));
// Keep the 31-turn fixture for tooltip and click behavior.
window.dispatchEvent(new window.MessageEvent("message", { data: snapshot(31) }));
// Move to the beginning and end: each edge has seven real turns, not blank slots.
lens.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientY: 0 }));
await wait(50);
check("focus window starts at first turn", lens.querySelector('.lens-individual[data-start="0"]') != null && lens.querySelectorAll(".lens-individual").length === 7);
lens.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientY: 600 }));
await wait(50);
check("focus window ends at last turn", lens.querySelector('.lens-individual[data-end="30"]') != null && lens.querySelectorAll(".lens-individual").length === 7);
// A middle window paints both aggregate context scales and still has seven singles.
lens.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientY: 300 }));
await wait(50);
check("middle focus includes five and ten turn context", lens.querySelectorAll(".lens-individual").length === 7 && lens.querySelector(".lens-context-5") != null && lens.querySelector(".lens-context-10") != null);
const individual = lens.querySelector(".lens-individual");
const individualIndex = Number(individual?.dataset.start ?? -1);
check("individual marker represents one turn", individual?.className.includes("lens-individual"));
individual.dispatchEvent(new window.MouseEvent("mouseenter"));
await wait(220);
check("tooltip names turn and only prompt text", new RegExp(`Turn ${individualIndex + 1} of 31`).test(lens.querySelector(".lens-tooltip")?.textContent ?? "") && (lens.querySelector(".lens-tooltip")?.textContent ?? "").includes(`prompt ${individualIndex + 1}`));
// Click a visible prompt and verify the direct upper-viewport jump.
const scroller = document.querySelector(".messages");
Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
Object.defineProperty(scroller, "getBoundingClientRect", { value: () => ({ top: 0, height: 400, left: 0, right: 500, width: 500 }) });
const targetRow = scroller.querySelector(`[data-lens-turn="${individualIndex}"]`);
Object.defineProperty(targetRow, "getBoundingClientRect", { value: () => ({ top: 500, height: 30, left: 0, right: 500, width: 500 }) });
scroller.scrollTop = 0;
individual.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("click jumps prompt toward upper viewport", scroller.scrollTop === 400);
console.log("PASS conversation-lens");

// Real CSS/layout: a mounted DOM node alone does not prove the lens is visible.
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	for (const width of [320, 1000]) {
		await page.setViewportSize({ width, height: 800 });
		await page.setContent('<body style="--vscode-foreground:#ccc;--vscode-descriptionForeground:#999;--vscode-sideBar-background:#181818;--vscode-button-background:#0078d4"><div id="app"></div></body>');
		await page.addStyleTag({ content: css });
		await page.evaluate(() => {
			window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
		});
		await page.addScriptTag({ path: "media/main.js" });
		for (const count of [0, 1, 2, 10, 11, 31]) {
			await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), snapshot(count));
			const rail = page.locator(".conversation-lens");
			check(`${width}px: lens visibility at ${count} turns`, await rail.isVisible() === (count > 0));
			if (!count) continue;
			await page.mouse.move(0, 0);
			check(`${width}px: panel is invisible without hover`, await rail.evaluate(el => getComputedStyle(el).opacity) === "0");
			await rail.hover({ position: { x: 2, y: 2 } });
			check(`${width}px: hover reveals panel`, await rail.evaluate(el => getComputedStyle(el).opacity) === "1");
			const marker = page.locator(".lens-individual").first();
			const box = await page.evaluate(() => document.querySelector(".lens-individual").getBoundingClientRect().toJSON());
			check(`${width}px: wide click target stays inside viewport (${JSON.stringify(box)})`, box.width >= 40 && Math.abs(box.height - 8) < 0.01 && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 800);
			const panel = await rail.boundingBox();
			check(`${width}px: floating panel is compact and away from scrollbar`, panel.height <= 320 && width - panel.x - panel.width === 24);
			if (count <= 10) {
				check(`${count} turns have exactly ${count} bars`, await page.locator(".lens-marker").count() === count);
				check("short panel height follows turn count", panel.height === count * 8 + 48);
				const dense = await page.locator(".lens-marker").evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().toJSON()));
				check("bars start eight pixels apart", dense.every((box, index) => index === 0 || Math.abs(box.y - dense[index - 1].y - 8) < 0.01));
				await marker.hover();
				const spread = await page.locator(".lens-marker").evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().toJSON()));
				check("hover opens a stable 24px click target", spread[0].height === 24 && Math.abs(spread[0].y + 12 - dense[0].y - 4) < 0.01);
				check("nearby bars move out of the click target", spread.length === 1 || spread[1].y >= spread[0].bottom);
				check("short hover keeps the same panel size", JSON.stringify(panel) === JSON.stringify(await rail.boundingBox()) && !(await rail.evaluate(el => el.classList.contains("expanded"))));
				await page.locator(".lens-marker").last().click();
				if (count === 2) await page.screenshot({ path: `/tmp/brief-lens-two-${width}.png` });
				await rail.hover({ position: { x: 2, y: 2 } });
				check("bars pack again after leaving the row", await marker.evaluate(el => el.getBoundingClientRect().height) === 8);
			}
			await page.mouse.move(0, 0);
			check(`${width}px: leaving hides panel even after clicking`, await rail.evaluate(el => getComputedStyle(el).opacity) === "0");

		}
		const scroller = page.locator(".messages");
		const before = await scroller.boundingBox();
		await page.locator(".conversation-lens").hover();
		await page.waitForFunction(() => document.querySelector(".conversation-lens").classList.contains("expanded"));
		check(`${width}px: hover expands without transcript reflow`, JSON.stringify(before) === JSON.stringify(await scroller.boundingBox()));
	}
} finally {
	await browser.close();
}
