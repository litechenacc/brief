/** Real Chromium editing regressions. Bundles current source in memory.
 * Clipboard writes + keyboard paste exercise browser default editing, not a
 * synthetic ClipboardEvent. IME events test handlers, not an OS candidate UI.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["webview/main.ts"], bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent" });

const server = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html" });
	response.end('<!doctype html><html><body><div id="app"></div></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let failures = 0;
const longText = Array.from({ length: 11 }, (_, i) => `text line ${i + 1}`).join("\n");
const status = {
	connected: true, streaming: false, compacting: false, retrying: false, restoring: false,
	modelLabel: "browser/model", thinkingLevel: "off", sessionName: "browser",
	sessionId: "browser-attachment-session", sessionFile: "/known/browser.jsonl",
	modelProvider: "browser", modelId: "model", statsText: "",
};

async function openComposer() {
	const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
	const page = await context.newPage();
	await page.goto(origin);
	await page.evaluate(() => {
		window.posted = [];
		window.nativeEdits = [];
		window.trustedPastes = 0;
		let state;
		window.acquireVsCodeApi = () => ({
			getState: () => state,
			setState: value => { state = value; },
			postMessage: message => { window.posted.push(structuredClone(message)); },
		});
		document.addEventListener("paste", event => { if (event.isTrusted) window.trustedPastes++; }, true);
		document.addEventListener("input", event => {
			window.nativeEdits.push({ type: event.inputType, trusted: event.isTrusted });
		}, true);
	});
	await page.addStyleTag({ path: "media/main.css" });
	await page.addScriptTag({ content: bundle.outputFiles[0].text });
	await page.evaluate(status => window.dispatchEvent(new MessageEvent("message", { data: {
		type: "snapshot", messages: [], status,
		state: { model: { provider: "browser", id: "model" }, thinkingLevel: "off" },
	} })), status);
	const textarea = page.locator("textarea");
	await textarea.focus();
	return { context, page, textarea };
}

async function pasteAttachment(page, textarea, text = longText) {
	const cardsBefore = await page.locator(".attachment-card").count();
	const pastesBefore = await page.evaluate(() => window.trustedPastes);
	const before = await page.evaluate(() => window.posted.filter(m => m.type === "createAttachment").length);
	await page.evaluate(text => navigator.clipboard.writeText(text), text);
	await textarea.press("ControlOrMeta+V");
	await page.waitForFunction(count => window.posted.filter(m => m.type === "createAttachment").length > count, before);
	const request = await page.evaluate(() => window.posted.filter(m => m.type === "createAttachment").at(-1));
	assert.equal(request.attachment.text, text, "native paste preserves complete source text");
	assert.equal(await page.evaluate(() => window.trustedPastes), pastesBefore + 1, "browser fired a trusted paste");
	await page.evaluate(request => window.dispatchEvent(new MessageEvent("message", { data: {
		type: "attachmentCreated", sessionId: request.sessionId, id: request.attachment.id,
	} })), request);
	assert.equal(await page.locator(".attachment-card").count(), cardsBefore + 1);
	assert.equal(await page.locator(".attachment-marker").count(), cardsBefore + 1);
	return request.attachment;
}


async function pickImage(page, moveFocus = false) {
	await page.getByTitle("Attach @file, selection, image…", { exact: true }).click();
	await page.locator(".dropdown-item").filter({ hasText: "Image…" }).click();
	const request = await page.evaluate(() => window.posted.filter(m => m.type === "pickImage").at(-1));
	assert.ok(request, "picker click must issue a host request");
	if (moveFocus) {
		await page.evaluate(() => {
			const input = document.createElement("input");
			input.id = "other-input";
			input.value = "other editor text";
			document.body.appendChild(input);
			input.focus();
		});
	}
	const image = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = 160; canvas.height = 90;
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#176d9c"; ctx.fillRect(0, 0, 160, 90);
		ctx.fillStyle = "#f6cd60"; ctx.fillRect(20, 20, 60, 50);
		return { data: canvas.toDataURL("image/png").split(",")[1], mimeType: "image/png", name: "preview.png" };
	});
	const before = await page.evaluate(() => window.posted.filter(m => m.type === "createAttachment").length);
	await page.evaluate(({ request, image }) => window.dispatchEvent(new MessageEvent("message", { data: {
		type: "imagePicked", requestId: request.requestId, images: [image],
	} })), { request, image });
	await page.waitForFunction(count => window.posted.filter(m => m.type === "createAttachment").length > count, before);
	const created = await page.evaluate(() => window.posted.filter(m => m.type === "createAttachment").at(-1));
	await page.evaluate(created => window.dispatchEvent(new MessageEvent("message", { data: {
		type: "attachmentCreated", sessionId: created.sessionId, id: created.attachment.id,
	} })), created);
	return created.attachment;
}

async function check(name, run) {
	const harness = await openComposer();
	try {
		await run(harness);
		console.log(`PASS ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}\n${error.stack}`);
	} finally {
		await harness.context.close();
	}
}

try {
	browser = await chromium.launch({ headless: true });
	await check("native paste keyboard undo/redo retains prior typing history", async ({ page, textarea }) => {
		await textarea.pressSequentially("earlier text ");
		const prior = await textarea.inputValue();
		await pasteAttachment(page, textarea);
		const attached = await textarea.inputValue();
		assert.ok(attached.startsWith(prior) && !attached.includes(longText));
		await textarea.press("ControlOrMeta+Z");
		assert.equal(await textarea.inputValue(), prior, "one undo removes the whole pasted attachment");
		assert.equal(await page.locator(".attachment-card").count(), 0);
		await textarea.press("ControlOrMeta+Shift+Z");
		assert.equal(await textarea.inputValue(), attached, "redo restores the exact placeholder");
		assert.equal(await page.locator(".attachment-card").count(), 1);
		await textarea.press("ControlOrMeta+Z");
		let previous = prior;
		for (let step = 0; step < prior.length + 2 && previous; step++) {
			await textarea.press("ControlOrMeta+Z");
			const value = await textarea.inputValue();
			assert.ok(prior.startsWith(value) && value.length <= previous.length, "undo walks earlier typing without inserting unrelated text");
			assert.equal(await page.locator(".attachment-card").count(), 0, "earlier typing undo must not resurrect the attachment");
			assert.equal(await page.locator(".attachment-marker").count(), 0);
			previous = value;
		}
		assert.equal(previous, "", "attachment editing must preserve all earlier typing history regardless of undo coalescing");
	});

	await check("browser editing undo/redo command restores the complete attachment", async ({ page, textarea }) => {
		await textarea.pressSequentially("keep ");
		await pasteAttachment(page, textarea);
		const attached = await textarea.inputValue();
		// Browser menu-like editing route, independent of the keyboard shortcut.
		// Assert user-visible results, not the history implementation or command
		// return value: a beforeinput handler may legitimately handle this edit.
		await page.evaluate(() => document.execCommand("undo"));
		assert.equal(await textarea.inputValue(), "keep ");
		assert.equal(await page.locator(".attachment-card").count(), 0);
		await page.evaluate(() => document.execCommand("redo"));
		assert.equal(await textarea.inputValue(), attached);
		assert.equal(await page.locator(".attachment-card").count(), 1);
	});

	await check("Backspace at placeholder end removes one whole block and undo restores it", async ({ page, textarea }) => {
		await textarea.pressSequentially("prefix ");
		await pasteAttachment(page, textarea);
		const attached = await textarea.inputValue();
		await textarea.press("Backspace");
		assert.equal(await textarea.inputValue(), "prefix ", "no half marker remains");
		assert.equal(await page.locator(".attachment-card").count(), 0);
		assert.equal(await page.locator(".attachment-marker").count(), 0);
		await textarea.press("ControlOrMeta+Z");
		assert.equal(await textarea.inputValue(), attached);
		assert.equal(await page.locator(".attachment-card").count(), 1);
	});

	await check("Chinese composition beside attachment never sends on candidate confirmation", async ({ page, textarea }) => {
		await pasteAttachment(page, textarea);
		const attached = await textarea.inputValue();
		// CDP drives Chromium's composition editing; this is still not a test
		// of a platform-specific Chinese candidate popup.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
		assert.equal(await page.locator(".composer-mirror .ime").textContent(), "中文");
		await textarea.evaluate(element => {
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
		});
		assert.equal(await page.evaluate(() => window.posted.filter(m => m.type === "prompt").length), 0);
		await cdp.send("Input.insertText", { text: "中文" });
		// Explicitly cover compositionend + confirmation keydown in one task,
		// including Chromium's ordering where composition ends before Enter.
		await textarea.evaluate(element => {
			element.dispatchEvent(new CompositionEvent("compositionend", { data: "中文", bubbles: true }));
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		assert.equal(await page.evaluate(() => window.posted.filter(m => m.type === "prompt").length), 0);
		assert.equal(await textarea.inputValue(), attached + "中文");
		assert.equal(await page.locator(".attachment-card").count(), 1);
		assert.equal(await page.locator(".composer-mirror .ime").count(), 0);
		// The next intentional send is a later interaction, outside the
		// composition-confirmation task and its zero-delay suppression timer.
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await textarea.press("Enter");
		const prompts = await page.evaluate(() => window.posted.filter(m => m.type === "prompt"));
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0].payload.text, attached + "中文");
		assert.equal(prompts[0].payload.attachments.length, 1);
		assert.equal(prompts[0].payload.attachments[0].text, longText);
	});

	await check("card remove click remains undoable and delayed image picker targets only composer", async ({ page, textarea }) => {
		await textarea.pressSequentially("prefix ");
		await pasteAttachment(page, textarea);
		const attached = await textarea.inputValue();
		await page.getByRole("button", { name: "Remove Text 1", exact: true }).click();
		assert.equal(await textarea.evaluate(element => document.activeElement === element), true, "remove click returns editing focus to composer");
		assert.equal(await textarea.inputValue(), "prefix ");
		assert.equal(await page.locator(".attachment-card").count(), 0);
		// Do not refocus the textarea: clicking a card button must not strand
		// the user outside the edit target or undo a different field.
		await page.keyboard.press("ControlOrMeta+Z");
		assert.equal(await textarea.inputValue(), attached);
		assert.equal(await page.locator(".attachment-card").count(), 1);
		// Undo may select the restored marker. Collapse at the end so this
		// picker adds an image instead of replacing that selected text block.
		await textarea.press("End");
		const image = await pickImage(page, true);
		assert.equal(await page.locator("#other-input").inputValue(), "other editor text");
		assert.ok((await textarea.inputValue()).includes(`[${image.label}]`));
		assert.equal(await page.locator(".attachment-card").count(), 2);
		// The picker reserves its marker when opened; completing it need not
		// steal focus back from a field the user focused while waiting.
		await textarea.focus();
		await page.keyboard.press("ControlOrMeta+Z");
		assert.equal(await textarea.inputValue(), attached, "one undo removes only the picked image");
		assert.equal(await page.locator(".attachment-card").count(), 1);
		assert.equal(await page.locator("#other-input").inputValue(), "other editor text");
	});

	await check("attachment composer visual preview", async ({ page, textarea }) => {
		await page.setViewportSize({ width: 960, height: 720 });
		await page.evaluate(() => {
			document.body.className = "vscode-dark";
			document.body.style.cssText = "--vscode-font-family:Arial, sans-serif;--vscode-editor-font-family:monospace;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-editor-background:#181818;--vscode-sideBar-background:#202020;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-textLink-foreground:#4daafc;--vscode-textLink-activeForeground:#4daafc;--vscode-textBlockQuote-background:#222222;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-widget-border:#454545";
		});
		await page.keyboard.insertText("請比對兩份文字附件，並參考圖片： ");
		await pasteAttachment(page, textarea);
		await page.keyboard.insertText(" 與 ");
		await pasteAttachment(page, textarea, "這是較長的參考內容。".repeat(110));
		await pickImage(page);
		await textarea.focus();
		await textarea.press("End");
		await page.keyboard.insertText(" 請整理差異並保留原始數據。");
		assert.equal(await page.locator(".attachment-card").count(), 3);
		for (const width of [960, 320]) {
			await page.setViewportSize({ width, height: 720 });
			const geometry = await page.locator(".attachment-card").evaluateAll(cards => cards.map(card => {
				const rect = element => {
					const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
					return { left, right, top, bottom, width, height };
				};
				return { card: rect(card), remove: rect(card.querySelector(".chip-remove")), container: rect(card.parentElement), composer: rect(card.closest(".composer-dock")) };
			}));
			for (const [index, { card, remove, container, composer }] of geometry.entries()) {
				assert.ok(remove.width > 0 && remove.height > 0, `${width}px card ${index}: remove has visible area`);
				assert.ok(remove.left >= card.left - 1 && remove.right <= card.right + 1 && remove.top >= card.top - 1 && remove.bottom <= card.bottom + 1, `${width}px card ${index}: remove stays inside card`);
				assert.ok(card.left >= container.left - 1 && card.right <= container.right + 1 && card.left >= composer.left - 1 && card.right <= composer.right + 1 && card.left >= 0 && card.right <= width, `${width}px card ${index}: no horizontal overflow`);
				// Trial click exercises visibility, stability, enabled state and hit
				// testing without deleting the card needed for the next viewport.
				await page.locator(".attachment-card .chip-remove").nth(index).click({ trial: true });
			}
		}
		await page.setViewportSize({ width: 960, height: 720 });
		await page.screenshot({ path: "/tmp/brief-attachments-preview.png" });
	});

} finally {
	await browser?.close();
	await new Promise(resolve => server.close(resolve));
}
if (failures) process.exitCode = 1;
