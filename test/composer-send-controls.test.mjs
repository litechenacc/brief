import { Window } from "happy-dom";
import { buildSync } from "esbuild";
import assert from "node:assert/strict";

const window = new Window({ url: "https://webview.local" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "FileReader"]) {
	globalThis[name] = name === "window" ? window : window[name];
}
const built = buildSync({ entryPoints: ["webview/composer.ts"], bundle: true, platform: "browser", format: "esm", write: false });
const { Composer } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const sends = [], creates = [];
let stops = 0;
const c = new Composer({
	onSend: (text) => sends.push({ text, behavior: c.streamingBehavior, queued: c.queuesNextSend }),
	onStop: () => { stops++; },
	onSearchFiles() {}, onPickImage() {}, onAttachSelection() {}, onAttachActiveFile() {},
	onSetModel() {}, onSetThinking() {}, onToggleFavorite() {}, onOpenFile() {},
	onDraftChanged() {}, onNewSession() {}, onCreateAttachment: attachment => creates.push(attachment), onOpenAttachment() {},
});
document.body.append(c.root);
const textarea = c.root.querySelector("textarea");
const control = c.root.querySelector(".send-control");
assert.ok(control, "send actions share a split control");
const main = control.querySelector(".send-btn");
const toggle = control.querySelector(".send-mode-btn");
const stop = c.root.querySelector(".stop");
assert.ok(main && toggle && stop);
assert.equal(control.contains(stop), false, "Stop is independent of Send");
const visible = element => !element.hidden && element.style.display !== "none";
function state(expected, label, disabled, menuVisible) {
	assert.equal(control.dataset.state, expected);
	assert.equal(main.textContent.trim(), label);
	assert.equal(main.disabled, disabled);
	assert.equal(visible(toggle), menuVisible);
	if (menuVisible) assert.equal(toggle.disabled, false);
}
function key(options = {}) {
	const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
	textarea.dispatchEvent(event);
	return event;
}
function menu() {
	toggle.click();
	const dropdown = document.querySelector(".dropdown");
	assert.ok(dropdown, "mode menu opens");
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	assert.deepEqual([...dropdown.querySelectorAll(".dropdown-text")].map(row => row.textContent), ["Queue", "Steer"]);
	return dropdown;
}
function closed() {
	assert.equal(document.querySelector(".dropdown"), null);
	assert.notEqual(toggle.getAttribute("aria-expanded"), "true");
}
function choose(label, current) {
	const before = sends.length;
	const dropdown = menu();
	assert.equal(dropdown.querySelector(".dropdown-item.current .dropdown-text")?.textContent, current);
	const row = [...dropdown.querySelectorAll(".dropdown-item")].find(row => row.querySelector(".dropdown-text").textContent === label);
	row.querySelector(".dropdown-select").click();
	closed();
	assert.equal(sends.length, before, "choosing mode never sends");
	assert.equal(document.activeElement, textarea, "choosing mode restores editing focus");
}
function parity(label, behavior, queued) {
	for (const action of [() => main.click(), () => key()]) {
		c.setText("message");
		state(queued ? "queue" : label === "Steer" ? "steer" : "submit", label, false, label !== "Send");
		const before = sends.length;
		action();
		assert.equal(sends.length, before + 1);
		assert.deepEqual(sends.at(-1), { text: "message", behavior, queued });
		assert.equal(textarea.value, "");
		state("blocked", label, true, label !== "Send");
	}
}
try {
	state("blocked", "Blocked", true, false);
	c.setEnabled(true);
	c.setSteerDefault("followUp");
	assert.equal(c.isStreaming, false, "streaming getter reports idle state");
	state("blocked", "Send", true, false);
	parity("Send", "followUp", false);
	c.setStreaming(true);
	assert.equal(c.isStreaming, true, "streaming getter reports active state");
	state("blocked", "Queue", true, true);
	assert.equal(visible(stop), true);
	parity("Queue", "followUp", true);
	choose("Steer", "Queue");
	state("blocked", "Steer", true, true);
	parity("Steer", "steer", false);
	choose("Queue", "Steer");
	parity("Queue", "followUp", true);

	c.setText("keep text");
	const beforeKeys = sends.length;
	assert.equal(key({ shiftKey: true }).defaultPrevented, false, "Shift+Enter allows browser newline editing");
	key({ isComposing: true });
	key({ keyCode: 229 });
	textarea.dispatchEvent(new window.CompositionEvent("compositionstart"));
	key();
	main.click();
	textarea.dispatchEvent(new window.CompositionEvent("compositionend"));
	key();
	assert.equal(sends.length, beforeKeys, "IME candidate confirmation never sends");
	assert.equal(textarea.value, "keep text");
	// Wait for the existing zero-delay composition confirmation guard, not a browser IME UI.
	await new Promise(resolve => window.setTimeout(resolve, 0));
	key();
	assert.equal(sends.length, beforeKeys + 1, "later intentional Enter sends");

	for (const block of [
		() => c.setEnabled(false, "Runtime unavailable", true),
		() => c.setObserving(true),
	]) {
		c.setEnabled(true); c.setObserving(false); c.setText("blocked draft");
		menu(); block(); closed();
		state("blocked", "Blocked", true, false);
		const before = sends.length;
		main.click(); key();
		assert.equal(sends.length, before);
		assert.equal(textarea.value, "blocked draft");
	}
	assert.equal(visible(stop), false, "read-only observation cannot stop someone else's run");
	c.setObserving(false); c.setEnabled(true); c.setText("");
	state("blocked", "Queue", true, true);
	const beforeStop = sends.length;
	stop.click();
	assert.equal(stops, 1, "empty draft does not disable Stop");
	assert.equal(sends.length, beforeStop);

	const paste = new window.Event("paste", { cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: () => "x".repeat(1001) } });
	textarea.dispatchEvent(paste);
	assert.equal(creates.length, 1);
	state("blocked", "Blocked", true, true);
	main.click(); key();
	assert.equal(sends.length, beforeStop, "pending attachment blocks click and Enter");
	stop.click(); assert.equal(stops, 2, "pending attachment does not disable Stop");
	c.attachmentCreated(creates[0].id);
	state("queue", "Queue", false, true);

	choose("Steer", "Queue");
	menu(); c.setStreaming(false); closed();
	assert.equal(visible(stop), false);
	assert.equal(c.streamingBehavior, "followUp", "stream end restores configured Queue default");
	state("submit", "Send", false, false);
	c.setStreaming(true);
	state("queue", "Queue", false, true);
	c.setSteerDefault("steer");
	assert.equal(c.streamingBehavior, "followUp", "configuration does not replace active-run choice");
	c.setStreaming(false); c.setStreaming(true);
	state("steer", "Steer", false, true);
	choose("Queue", "Steer");
	c.setStreaming(false); c.setStreaming(true);
	assert.equal(c.streamingBehavior, "steer", "stream end also restores configured Steer default");
	menu(); c.resetForSessionBoundary(); closed();
	assert.equal(textarea.value, "");
	assert.equal(main.disabled, true);
	console.log("PASS composer split send states, mode menu, click/Enter parity, IME, gates, defaults and independent Stop");
} finally {
	window.happyDOM.abort();
}
