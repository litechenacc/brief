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

const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));
send(snapshot(0));
check("hidden without turns", document.querySelector(".conversation-lens")?.hidden === true);
for (const count of [1, 2, 7, 10, 11, 31, 200]) {
	send(snapshot(count));
	const lens = document.querySelector(".conversation-lens");
	const rows = [...lens.querySelectorAll(".lens-marker")];
	check(`${count} turns each have a direct row`, !lens.hidden && rows.length === count && rows.every((row, index) => row.classList.contains("lens-individual") && Number(row.dataset.start) === index && Number(row.dataset.end) === index));
	check("exactly one current turn", rows.filter(row => row.getAttribute("aria-current") === "true").length === 1);
	lens.dispatchEvent(new window.MouseEvent("mouseenter"));
	check("hover expands immediately, including short threads", lens.classList.contains("expanded"));
	rows[0].dispatchEvent(new window.MouseEvent("mouseenter"));
	await wait(220);
	check("hover preserves row identities without groups or tooltip", rows.every((row, index) => row === lens.querySelectorAll(".lens-marker")[index]) && !lens.querySelector('.lens-tooltip, .lens-context-5, .lens-context-10'));
	lens.dispatchEvent(new window.MouseEvent("mouseleave"));
	check("mouseleave has collapse grace period", lens.classList.contains("expanded"));
	await wait(180);
	check("mouseleave collapses", !lens.classList.contains("expanded"));
}
const prompts = ["short", "1234567890123456", "12345678901234567", "  hello\n\t world  ", "👨‍👩‍👧‍👦".repeat(17), "e\u0301".repeat(17), "", "<b>literal</b>"];
const labels = ["short", "1234567890123456", "1234567890123456…", "hello world", "👨‍👩‍👧‍👦".repeat(16) + "…", "e\u0301".repeat(16) + "…", "(image prompt)", "<b>literal</b>"];
send({ ...snapshot(0), messages: prompts.map(text => ({ role: "user", content: text ? [{ type: "text", text }] : [{ type: "image", data: "", mimeType: "image/png" }] })) });
for (const [index, row] of [...document.querySelectorAll(".lens-marker")].entries()) {
	check(`prompt ${index}: normalized grapheme-safe label`, row.querySelector(".lens-label")?.textContent === labels[index]);
	const aria = row.getAttribute("aria-label") ?? "";
	check(`prompt ${index}: accessible full prompt and turn`, aria.includes(prompts[index].replace(/\s+/g, " ").trim() || "(image prompt)") && aria.includes(`Turn ${index + 1} of ${prompts.length}`));
}
check("prompt markup stays plain text", !document.querySelector(".lens-label b"));
// Keep the existing direct-jump geometry regression.
send(snapshot(31));
const scroller = document.querySelector(".messages");
Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
Object.defineProperty(scroller, "getBoundingClientRect", { value: () => ({ top: 0, height: 400, left: 0, right: 500, width: 500 }) });
const targetRow = scroller.querySelector('[data-lens-turn="0"]');
Object.defineProperty(targetRow, "getBoundingClientRect", { value: () => ({ top: 500, height: 30, left: 0, right: 500, width: 500 }) });
scroller.scrollTop = 0;
document.querySelector('.lens-marker[data-start="0"]').click();
check("click jumps prompt toward upper viewport", scroller.scrollTop === 400);
send(snapshot(200));
check("oldest turn initially windowed out", !scroller.querySelector('[data-lens-turn="0"]'));
document.querySelector('.lens-marker[data-start="0"]').click();
check("outline jump loads windowed history", scroller.querySelector('[data-lens-turn="0"]')?.textContent.includes("prompt 1"));

// Real browser checks exercise CSS, scrolling, hit testing and focus modality.
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [320, 1000]) {
		const page = await browser.newPage({ viewport: { width, height: 800 } });
		await page.setContent('<body style="--vscode-foreground:#ccc;--vscode-descriptionForeground:#999;--vscode-sideBar-background:#181818;--vscode-button-background:#0078d4"><div id="app"></div></body>');
		await page.addStyleTag({ content: css });
		await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} }); });
		await page.addScriptTag({ path: "media/main.js" });
		const lens = page.locator(".conversation-lens");
		const rail = page.locator(".lens-rail");
		const markers = page.locator(".lens-marker");
		for (const count of [0, 1, 2, 10, 31, 200]) {
			await page.mouse.move(0, 0);
			await page.evaluate(() => document.activeElement?.blur());
			await page.waitForTimeout(200);
			await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), snapshot(count));
			check(`${width}px: visibility at ${count} turns`, await lens.isVisible() === (count > 0));
			if (!count) continue;
			const before = await lens.boundingBox();
			const transcriptBefore = await page.locator(".messages").boundingBox();
			const parent = await lens.evaluate(el => el.parentElement.getBoundingClientRect().toJSON());
			check(`${width}px: collapsed overlay is 40px at top-right`, before.width === 40 && Math.abs(parent.right - before.x - before.width) < 1 && Math.abs(before.y - parent.y - 12) < 1);
			check("drawer has a flush square right edge", await lens.evaluate(el => { const s = getComputedStyle(el); return s.borderTopRightRadius === "0px" && s.borderBottomRightRadius === "0px" && s.borderRightWidth === "0px"; }));
			check("labels sit close to the left edge", await markers.first().evaluate(el => { const label = el.querySelector(".lens-label").getBoundingClientRect(); const panel = el.closest(".conversation-lens").getBoundingClientRect(); return label.left - panel.left === 9; }));
			check("collapsed rows are compact", await markers.first().evaluate(el => el.getBoundingClientRect().height) === 18);
			check("collapsed labels use 8px font", await markers.first().evaluate(el => getComputedStyle(el.querySelector(".lens-label")).fontSize) === "8px");
			await lens.evaluate(el => { window.savedLensRows = [...el.querySelectorAll(".lens-marker")]; });
			await page.mouse.move(before.x + before.width - 4, before.y + 4);
			await page.waitForFunction(() => document.querySelector(".conversation-lens").classList.contains("expanded"));
			await page.waitForFunction(() => { const el = document.querySelector(".conversation-lens"); return Math.abs(el.getBoundingClientRect().width - Math.min(260, el.parentElement.getBoundingClientRect().width - 24)) < 0.1; });
			const expanded = await lens.boundingBox();
			check(`${width}px: expanded width stays inside parent`, Math.abs(expanded.width - Math.min(260, parent.width - 24)) < 1 && expanded.x >= parent.x && expanded.x + expanded.width <= parent.right);
			check("expanded labels use 13px font", await markers.first().evaluate(el => getComputedStyle(el.querySelector(".lens-label")).fontSize) === "13px");
			check("expansion never reflows transcript", JSON.stringify(transcriptBefore) === JSON.stringify(await page.locator(".messages").boundingBox()));
			check("expansion preserves top and right hover anchors", Math.abs(before.y - expanded.y) < 1 && Math.abs(before.x + before.width - expanded.x - expanded.width) < 1);
			check("pointer remains over expanded outline", await page.evaluate(({x, y}) => !!document.elementFromPoint(x, y)?.closest(".conversation-lens"), { x: before.x + before.width - 4, y: before.y + 4 }));
			check("all rows are fixed 30px without overlap", await markers.evaluateAll(rows => rows.every((row, i) => Math.abs(row.getBoundingClientRect().height - 30) < 0.1 && (i === 0 || Math.abs(row.getBoundingClientRect().top - rows[i - 1].getBoundingClientRect().bottom) < 0.1))));
			const visibleMarker = page.locator('.lens-marker[aria-current="true"]');
			check("current turn uses the theme accent", await visibleMarker.evaluate(el => getComputedStyle(el).color === "rgb(0, 120, 212)"));
			const markerBefore = await visibleMarker.boundingBox();
			await visibleMarker.hover();
			check("row hover does not displace its target", JSON.stringify(markerBefore) === JSON.stringify(await visibleMarker.boundingBox()));
			check("hover never rebuilds rows", await lens.evaluate(el => window.savedLensRows.every((row, index) => row === el.querySelectorAll(".lens-marker")[index])));
			if (count === 200) {
				check("long outline scrolls inside bounded rail", await rail.evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight <= 360 && getComputedStyle(el).overflowY === "auto"));
				check("opening reveals current turn", await visibleMarker.evaluate(el => { const r = el.getBoundingClientRect(); const rail = el.parentElement.getBoundingClientRect(); return r.top >= rail.top - 1 && r.bottom <= rail.bottom + 1; }));
				await rail.evaluate(el => { el.scrollTop = 0; });
				await markers.first().click();
				check("browser click loads oldest history", await page.locator('.messages [data-lens-turn="0"]').count() === 1);
			}
			await page.mouse.move(0, 0);
			await page.waitForFunction(() => !document.querySelector(".conversation-lens").classList.contains("expanded"));
			check("mouse click does not pin outline open", !(await lens.evaluate(el => el.classList.contains("expanded"))));
		}
		// Short threads cannot align each prompt to the viewport anchor.
		await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), snapshot(3));
		check("short thread follows latest prompt", await markers.nth(2).getAttribute("aria-current") === "true");
		for (const index of [0, 1, 2]) {
			await lens.hover();
			await markers.nth(index).click();
			await page.waitForTimeout(100);
			check(`short thread click selects turn ${index + 1}`, await markers.nth(index).getAttribute("aria-current") === "true");
		}
		await page.locator("textarea").fill("new prompt");
		await page.locator("textarea").press("Enter");
		await page.waitForTimeout(100);
		check("own send selects new prompt", await markers.count() === 4 && await markers.nth(3).getAttribute("aria-current") === "true");
		await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), {
			type: "event", event: { type: "message_start", message: { role: "user", content: "new prompt" } },
		});
		check("confirmed prompt stays selected", await markers.count() === 4 && await markers.nth(3).getAttribute("aria-current") === "true");
		await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), snapshot(200));
		await page.mouse.move(0, 0);
		await page.evaluate(() => document.activeElement?.blur());
		await page.waitForTimeout(180);
		// Keyboard entry must reveal either end of a long outline, not only current turn.
		for (const index of [0, 199]) {
			await markers.nth(index).focus();
			check(`keyboard focus reveals turn ${index + 1}`, await markers.nth(index).evaluate(el => { const r = el.getBoundingClientRect(); const rail = el.parentElement.getBoundingClientRect(); return r.top >= rail.top - 1 && r.bottom <= rail.bottom + 1; }));
			await page.evaluate(() => document.activeElement.blur());
			await page.waitForTimeout(180);
		}
		await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), snapshot(3));
		await markers.first().focus();
		await page.keyboard.press("Tab");
		check("keyboard focus expands outline", await lens.evaluate(el => el.classList.contains("expanded")) && await markers.nth(1).evaluate(el => el === document.activeElement && el.matches(":focus-visible")));
		await lens.dispatchEvent("mouseleave");
		await page.waitForTimeout(180);
		check("keyboard focus keeps outline expanded after mouseleave", await lens.evaluate(el => el.classList.contains("expanded")));
		await page.keyboard.press("Enter");
		check("keyboard activation retains row focus", await markers.nth(1).evaluate(el => el === document.activeElement));
		await page.evaluate(() => document.activeElement.blur());
		await page.waitForFunction(() => !document.querySelector(".conversation-lens").classList.contains("expanded"));
		await page.emulateMedia({ reducedMotion: "reduce" });
		await lens.hover();
		check("reduced motion still expands without animation", await lens.evaluate(el => el.classList.contains("expanded") && getComputedStyle(el).transitionDuration.split(",").every(value => parseFloat(value) === 0)));
		await page.mouse.move(0, 0);
		await page.waitForTimeout(200);
		await page.setViewportSize({ width, height: 400 });
		const chinese = { ...snapshot(31), messages: Array.from({ length: 31 }, (_, index) => ({ role: "user", content: [{ type: "text", text: `第${index + 1}個問題：請說明這個功能如何使用並提供範例` }] })) };
		await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), chinese);
		check("short viewport keeps outline inside transcript parent", await lens.evaluate(el => { const r = el.getBoundingClientRect(); const parent = el.parentElement.getBoundingClientRect(); return r.bottom <= parent.bottom - 11 && r.top >= parent.top; }));
		check("short viewport keeps long rail scrollable", await rail.evaluate(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight));
		await page.setViewportSize({ width, height: 800 });
		for (const theme of ["light", "dark"]) {
			await page.evaluate(theme => {
				document.body.className = `vscode-${theme}`;
				for (const [token, value] of Object.entries({ "font-family": "sans-serif", "editorWidget-background": theme === "light" ? "#fff" : "#202020", "widget-border": theme === "light" ? "#ccc" : "#454545", foreground: theme === "light" ? "#333" : "#ccc", descriptionForeground: theme === "light" ? "#666" : "#999", "sideBar-background": theme === "light" ? "#f3f3f3" : "#181818", "list-hoverBackground": theme === "light" ? "#e4e4e4" : "#303030" })) document.body.style.setProperty(`--vscode-${token}`, value);
			}, theme);
			await page.screenshot({ path: `/tmp/brief-outline-${width}-${theme}-collapsed.png` });
			await lens.hover();
			await page.screenshot({ path: `/tmp/brief-outline-${width}-${theme}-expanded.png` });
			await page.mouse.move(0, 0);
			await page.waitForTimeout(180);
			// Match the reported two-prompt case as well as the long outline.
			await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), {
				...snapshot(2), messages: ["目前這個 hover 區很醜，並且很難點", "ar"].map(text => ({ role: "user", content: [{ type: "text", text }] })),
			});
			await lens.hover({ position: { x: 2, y: 2 } });
			check(`${theme}: current turn is text-only, not a filled selection`, await page.locator('.lens-marker[aria-current="true"]').evaluate(el => getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)"));
			await markers.first().hover();
			check(`${theme}: hover leaves every row in place`, await markers.evaluateAll(rows => rows.every(row => row.getBoundingClientRect().height === 30)));
			await page.screenshot({ path: `/tmp/brief-outline-${width}-${theme}-two.png` });
			await page.mouse.move(0, 0);
			await page.waitForTimeout(180);
			check(`${theme}: collapsed drawer has a translucent box`, await lens.evaluate(el => { const style = getComputedStyle(el); return style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor.includes("0.82") && style.borderTopStyle === "solid"; }));
			await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), chinese);
		}
		await page.close();
	}
} finally {
	await browser.close();
}
console.log("PASS conversation-lens");
