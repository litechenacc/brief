/**
 * Webview DOM harness: drives the built media/main.js inside happy-dom with
 * the same host->webview messages SessionController sends.
 */

import { Window } from "happy-dom";
import * as fs from "node:fs";

const window = new Window({ url: "https://webview.local/" });
const document = window.document;
document.body.innerHTML = '<div id="app"></div><script id="cached-models" type="application/json">[{"provider":"cached","id":"cached-model","reasoning":true}]</script>';
document.body.className = "vscode-dark";

const posted = [];
let savedWebviewState = { historyFolds: { archive: true } };
const vscodeApi = {
	postMessage: (m) => posted.push(m),
	getState: () => savedWebviewState,
	setState: (state) => { savedWebviewState = state; },
};

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

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

function hostMessage(data) {
	window.dispatchEvent(new window.MessageEvent("message", { data }));
}

function requestImageFromPicker() {
	const attach = [...document.querySelectorAll(".composer-rail .icon-btn")].find((button) => button.title.startsWith("Attach"));
	attach.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	const imageItem = [...document.querySelectorAll(".dropdown-item")].find((item) => item.textContent.includes("Image…"));
	imageItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	return posted.filter((message) => message.type === "pickImage").at(-1);
}

const code = fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
window.eval(code);

check("sends ready on boot", posted.some((m) => m.type === "ready"));
check("welcome screen visible", !!document.querySelector(".welcome"));
const earlyModelButton = document.querySelector(".rail-pill.model");
check("model button has a label before RPC", earlyModelButton.textContent === "Choose model");
earlyModelButton.click();
const earlyModelItem = [...document.querySelectorAll(".dropdown-item")].find((item) => item.textContent.includes("cached-model"));
check("cached model picker works before any host message", !!earlyModelItem);
earlyModelItem?.click();
check("cached selection immediately paints and queues the host operation", earlyModelButton.textContent.includes("cached-model") && posted.some((message) => message.type === "setModel" && message.modelId === "cached-model"));

// The chat opens immediately. The status strip remains the connection indicator,
// while the composer accepts a draft before the first status arrives.
const splash = document.querySelector(".boot-splash");
check("boot does not block the chat", !splash && !document.querySelector("textarea")?.disabled && document.querySelector(".live-label")?.textContent === "connecting");
hostMessage({ type: "runningTasks", tasks: [
	{ id: "bash:1", kind: "bash", label: "npm test", startedAt: Date.now() - 5_000, pid: 123 },
	{ id: "bg:1", kind: "background", label: "synthesis", startedAt: Date.now() - 65_000 },
] });
const runningTasksStrip = document.querySelector(".running-tasks-strip");
check("running tasks strip opens for newly detected work", runningTasksStrip?.classList.contains("visible") && runningTasksStrip.querySelectorAll(".running-task-row").length === 2);
check("bash and background tasks share the strip", [...runningTasksStrip.querySelectorAll(".running-task-kind")].map(node => node.textContent).join("|") === "bash|background task");
check("running task elapsed time paints", [...runningTasksStrip.querySelectorAll(".running-task-time")].map(node => node.textContent).join("|") === "5s|1m05s");
hostMessage({ type: "runningTasks", tasks: [] });
check("running tasks strip disappears when work ends", !runningTasksStrip.classList.contains("visible"));
const startupInput = document.querySelector("textarea");
const startupSend = document.querySelector(".send-btn:not(.stop)");
check("startup send is disabled with a static unavailable border", startupSend.disabled && startupSend.classList.contains("unavailable"));
check("startup send has an accessible connection explanation", startupSend.getAttribute("aria-label").includes("Connecting"));
startupInput.value = "draft while connecting";
startupInput.dispatchEvent(new window.Event("input", { bubbles: true }));
for (const restoring of [false, true]) {
	hostMessage({ type: "status", status: { connected: false, restoring, streaming: false, modelLabel: "Agent", thinkingLevel: "off" } });
	check(`startup remains editable (restoring=${restoring})`, !startupInput.disabled && startupInput.placeholder === "Message Brief…");
	check("connection-only status preserves the cached choice", earlyModelButton.textContent.includes("cached-model"));
	startupInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	startupSend.click();
	check("startup cannot send by Enter or click", !posted.some((m) => m.type === "prompt") && startupInput.value === "draft while connecting");
}
// A restoring status must not overwrite the cached local choice.
hostMessage({ type: "status", status: { connected: false, restoring: true, streaming: false, modelLabel: "Agent", thinkingLevel: "off" } });
check("startup status does not erase cached selection", earlyModelButton.textContent.includes("cached-model"));

hostMessage({ type: "uiState", title: "early agent title", statusText: "warming up" });
check("uiState statusText paints before the first status snapshot", document.querySelector(".live-label")?.textContent === "warming up");

const baseStatus = {
	connected: true, streaming: false, compacting: false, retrying: false, restoring: false,
	modelLabel: "chutes/kimi", thinkingLevel: "max", sessionName: "demo", sessionId: "019fd749-x",
	sessionFile: "/known/demo.jsonl",
	statsText: "", usageTotal: 4483, costUsd: 0.004,
	contextTokens: 60000, contextWindow: 262144, contextPercent: 23,
	modelProvider: "chutes", modelId: "kimi",
};

hostMessage({
	type: "snapshot",
	messages: [
		{ role: "user", content: "hello there" },
		{
			role: "assistant", model: "kimi", stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "I will edit the file.\n\n- a\n- b\n\n```py\nprint(1)\n```" },
				{ type: "toolCall", id: "tc1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 2;\nconst y = 3;" }] } },
				// Real shape: prime-agent's default active toolset is `ipython` alone, so a
				// shell run arrives as a %%bash cell, never as a tool named `bash`.
				{ type: "toolCall", id: "tc2", name: "ipython", arguments: { code: "%%bash\nset -euo pipefail\ncd /Users/chrisk/repo\nnpm run build" } },
				{ type: "toolCall", id: "tc3", name: "ipython", arguments: { code: "import os\nimport time\nsubprocess.run([\"git\", \"status\"])" } },
			],
			usage: { input: 4555, output: 348, totalTokens: 4903, cost: { input: 0.013665, output: 0.00522, total: 0.018885 } },
		},
		{ role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [{ type: "text", text: "edited src/app.ts" }] },
		{ role: "toolResult", toolCallId: "tc2", toolName: "ipython", content: [{ type: "text", text: "done" }] },
		{ role: "assistant", model: "kimi", stopReason: "stop", content: [{ type: "text", text: "The answer is **4**." }] },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: baseStatus,
	steerDefault: "steer",
});

check("first session identity preserves the startup draft", startupInput.value === "draft while connecting");
check("ready session enables send before live models arrive", !startupSend.disabled && !startupSend.classList.contains("unavailable"));
check("ready send restores its accessible label", startupSend.getAttribute("aria-label") === "Send (Enter)");
startupInput.value = "";
startupInput.dispatchEvent(new window.Event("input", { bubbles: true }));

check("status persists the exact session for editor restoration", savedWebviewState.session?.sessionId === baseStatus.sessionId && savedWebviewState.session?.sessionFile === baseStatus.sessionFile);
check("session persistence preserves history fold state", savedWebviewState.historyFolds?.archive === true);
const scroller = document.querySelector(".messages");
check("connected status keeps the chat unobstructed", !document.querySelector(".boot-splash"));
check("welcome removed after snapshot", !document.querySelector(".welcome"));
check("user bubble rendered", !!scroller.querySelector(".bubble-user"));
check("assistant row has no avatar (full width)", !scroller.querySelector(".avatar svg") && !!scroller.querySelector(".row-assistant .row-body"));
check("markdown list rendered", scroller.querySelectorAll(".md li").length === 2);
check("code block with header rendered", scroller.querySelectorAll(".codeblock").length === 1);
check("thinking block rendered", !!scroller.querySelector("details.thinking"));
check("edit diff lines rendered", scroller.querySelectorAll(".diff-line.del").length === 1 && scroller.querySelectorAll(".diff-line.add").length === 2,
	`${scroller.querySelectorAll(".diff-line").length} diff lines`);
check("edit path row rendered", !!scroller.querySelector(".tool-path"));
check("bash term prompt rendered", [...scroller.querySelectorAll(".term-prompt")].some((p) => p.textContent === "$ "));
check("no busy done pill (dot conveys state)", [...scroller.querySelectorAll(".tool-pill")].every((p) => p.textContent !== "done"));
check("usage line rendered", scroller.querySelectorAll(".usage-line").length >= 1);
check("user card contains copy + fork", scroller.querySelectorAll(".row-user > .bubble-user > .user-footer .uf-icon").length === 2);
check("user actions leave no footer row below the card", !scroller.querySelector(".row-user > .user-footer"));
// --- #56/#20: an ipython %%bash cell is a SHELL card, summarised by what actually ran ---
const shellCard = [...scroller.querySelectorAll(".tool")].find((t) => t.dataset.toolKind === "shell");
const pyCard = [...scroller.querySelectorAll(".tool")].find((t) => t.dataset.toolKind === "python");
check("%%bash ipython cell is a shell card", !!shellCard && shellCard.dataset.toolName === "ipython",
	[...scroller.querySelectorAll(".tool")].map((t) => `${t.dataset.toolName}/${t.dataset.toolKind}`).join("|"));
check("shell summary shows the command, not the cd/set preamble",
	shellCard?.querySelector(".tool-summary")?.textContent === "npm build",
	shellCard?.querySelector(".tool-summary")?.textContent ?? "<none>");
check("shell section labeled shell, not python",
	shellCard?.querySelector(".tool-section-head span")?.textContent === "shell",
	shellCard?.querySelector(".tool-section-head span")?.textContent ?? "<none>");
check("shell input drops the %%bash magic line",
	!shellCard?.querySelector(".tool-section:not(.tool-result) pre")?.textContent?.includes("%%bash"),
	shellCard?.querySelector(".tool-section:not(.tool-result) pre")?.textContent ?? "<none>");
check("plain python cell stays a python card, summarised by its real work",
	!!pyCard && pyCard.querySelector(".tool-summary").textContent === "git status",
	pyCard?.querySelector(".tool-summary")?.textContent ?? "<none>");
check("tool-call replies keep card copy without the duplicate full-reply copy",
	!!pyCard?.querySelector(".tool-copy-all") && !pyCard?.closest(".row-assistant")?.querySelector(".usage-copy"));
check("text replies keep full-reply copy",
	[...scroller.querySelectorAll(".row-assistant")].some((row) => !row.querySelector(".tool") && !!row.querySelector(".usage-copy")));
const pyPre = pyCard?.querySelector(".tool-section:not(.tool-result) pre");
check("python card highlights keywords and calls",
	pyPre?.classList.contains("hl-python")
		&& [...pyPre.querySelectorAll(".tok-kw")].some((n) => n.textContent === "import")
		&& [...pyPre.querySelectorAll(".tok-fn")].some((n) => n.textContent === "run"),
	pyPre?.innerHTML ?? "<none>");
check("python highlight preserves the source text",
	pyPre?.textContent === 'import os\nimport time\nsubprocess.run(["git", "status"])',
	JSON.stringify(pyPre?.textContent));

// copy of a shell card fences as bash, without the decorative $ prompt
let clipboard = "";
Object.defineProperty(window.navigator, "clipboard", {
	configurable: true,
	get: () => ({ writeText: async (t) => { clipboard = t; } }),
});
shellCard.querySelector(".tool-copy-all").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 0));
check("shell copy uses a bash fence with the real script", clipboard.includes("```bash\nset -euo pipefail") && !clipboard.includes("$ "), JSON.stringify(clipboard));
check("shell copy carries the output too", clipboard.includes("done"), JSON.stringify(clipboard));

// #20: an edit card copies its diff, and its output exactly once
const editCard = [...scroller.querySelectorAll(".tool")].find((t) => t.dataset.toolName === "edit");
check("tool copy is a sibling of the expandable tool control",
	!!editCard?.querySelector(".tool-header > .tool-toggle + .tool-copy-all") && !editCard?.querySelector(".tool-toggle .tool-copy-all"));
clipboard = "";
editCard.querySelector(".tool-copy-all").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 0));
check("edit copy includes the path and the hunks", clipboard.includes("src/app.ts") && clipboard.includes("```diff") && clipboard.includes("-const x = 1;") && clipboard.includes("+const y = 3;"), JSON.stringify(clipboard));
check("edit copy emits the output once, not twice", clipboard.split("edited src/app.ts").length - 1 === 1, JSON.stringify(clipboard));

// --- Streamed tool arguments. Replays the event order a real `prime-agent --mode rpc`
// emits (verified against the CLI): the FIRST message_update carrying a toolCall has
// `arguments: {}`, the code lands over later updates, and tool_execution_start repeats
// it only afterwards. The card is created on that first empty frame, so the collapsed
// summary and the expanded call both have to survive being built from nothing.
{
	// Appends to the live transcript on purpose — resetting with a snapshot here
	// would wipe the turns the checks further down still need.
	const partial = { role: "assistant", content: [{ type: "toolCall", id: "stream-1", name: "ipython", arguments: {} }] };
	hostMessage({ type: "event", event: { type: "agent_start" } });
	hostMessage({ type: "event", event: { type: "message_start", message: partial } });
	hostMessage({ type: "event", event: { type: "message_update", message: partial } });
	check("unfinished tool calls stay behind the working row by default",
		!scroller.querySelector('[data-part="tool-stream-1"]') && !!scroller.querySelector(".working-row"),
		scroller.querySelector(".working-row")?.textContent ?? "none");

	const full = {
		role: "assistant",
		content: [{ type: "toolCall", id: "stream-1", name: "ipython", arguments: { code: "%%bash\ncd /repo\nnpm run build -- --prod" } }],
	};
	hostMessage({ type: "event", event: { type: "message_update", message: full } });
	check("complete arguments still wait for execution when liveTranscript is off",
		!scroller.querySelector('[data-part="tool-stream-1"]'));

	hostMessage({ type: "event", event: { type: "tool_execution_start", toolCallId: "stream-1", toolName: "ipython", args: full.content[0].arguments } });
	const card = [...document.querySelectorAll(".messages .tool")].pop();
	const summaryText = () => card?.querySelector(".tool-summary")?.textContent ?? "";
	const inputText = () => card?.querySelector(".tool-section:not(.tool-result) pre")?.textContent ?? "";
	check("tool_execution_start reveals the card", !!card && card.dataset.part === "tool-stream-1", card?.dataset.part ?? "<none>");
	check("collapsed summary fills in once the tool starts", summaryText().includes("npm build"), JSON.stringify(summaryText()));
	check("expanded call fills in too", inputText().includes("npm run build -- --prod"), JSON.stringify(inputText()));
	check("execution upgrades the card to a shell card", card?.dataset.toolKind === "shell", card?.dataset.toolKind ?? "<none>");
	hostMessage({ type: "event", event: { type: "message_update", message: partial } });
	check("a later empty frame cannot blank the summary", summaryText().includes("npm build"), JSON.stringify(summaryText()));
	check("a later empty frame cannot blank the call", inputText().includes("npm run build -- --prod"), JSON.stringify(inputText()));
	check("tool_execution_start leaves the completed card intact", summaryText().includes("npm build"), JSON.stringify(summaryText()));
	hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
}

// A websocket can lose tool_execution_end while agent_end still carries the durable result.
{
	const id = "tool-end-recovery";
	hostMessage({ type: "event", event: { type: "agent_start" } });
	hostMessage({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: "ipython", args: { code: "print('done')" } } });
	hostMessage({ type: "event", event: { type: "agent_end", messages: [
		{ role: "toolResult", toolCallId: id, toolName: "ipython", content: [{ type: "text", text: "done" }] },
	] } });
	const recovered = scroller.querySelector(`[data-part="tool-${id}"]`);
	check("agent_end settles a tool whose end event was lost", recovered?.querySelector(".tool-dot")?.classList.contains("done") && recovered.textContent.includes("done"));
}

{
	hostMessage({ type: "status", status: { ...baseStatus, liveTranscript: true } });
	const partial = { role: "assistant", content: [{ type: "toolCall", id: "stream-live-1", name: "ipython", arguments: {} }] };
	hostMessage({ type: "event", event: { type: "message_start", message: partial } });
	hostMessage({ type: "event", event: { type: "message_update", message: partial } });
	const liveCard = [...document.querySelectorAll(".messages .tool")].pop();
	check("liveTranscript paints the tool card on the first argument-less frame",
		!!liveCard && liveCard.dataset.toolName === "ipython" && liveCard.dataset.part === "tool-stream-live-1",
		liveCard?.dataset.part ?? "<none>");
	check("summary starts empty because the arguments have not arrived",
		(liveCard?.querySelector(".tool-summary")?.textContent ?? "") === "");
	hostMessage({ type: "status", status: { ...baseStatus, liveTranscript: false } });
}

// Messages themselves do not show estimates or input cost; model details stay collapsed by default.
check("user footer has no token estimate or input price", !scroller.querySelector(".uf-tokens, .uf-cost"));
check("user copy and fork remain", scroller.querySelectorAll(".row-user .user-footer .uf-icon").length >= 2);
check("reply usage is off by default", !scroller.classList.contains("show-usage-details"));
hostMessage({ type: "status", status: { ...baseStatus, showUsageDetails: true } });
check("usage config enables existing replies immediately", scroller.classList.contains("show-usage-details"));
const modelUsage = scroller.querySelector("details.model-usage");
check("model usage is collapsed with a neutral summary", !!modelUsage && !modelUsage.open && modelUsage.querySelector("summary").textContent === "Usage details");
check("model usage includes input output total and reported cost", /Input: 4.6k tokens/.test(modelUsage.textContent) && /Output: 348 tokens/.test(modelUsage.textContent) && modelUsage.textContent.includes("$0.0189"));
modelUsage.open = true;
check("model usage can be expanded", modelUsage.open);
modelUsage.open = false;
hostMessage({ type: "status", status: { ...baseStatus, showUsageDetails: false } });
check("usage config disables existing replies immediately", !scroller.classList.contains("show-usage-details"));
check("disabling reply usage keeps copy and session fee", !!scroller.querySelector(".usage-copy") && !document.querySelector(".stats-label").hidden);

// Thought process visibility is independent of usage details and thinking level.
check("thought process defaults to hidden", !scroller.classList.contains("show-thought-process"));
const thoughtBlock = scroller.querySelector("details.thinking");
hostMessage({ type: "status", status: { ...baseStatus, showThoughtProcess: true } });
check("thought config reveals existing blocks without rebuilding", scroller.classList.contains("show-thought-process") && scroller.querySelector("details.thinking") === thoughtBlock);
check("thought config leaves usage hidden", !scroller.classList.contains("show-usage-details"));
hostMessage({ type: "status", status: { ...baseStatus, showThoughtProcess: false, showUsageDetails: true } });
check("thought config hides immediately independent of usage", !scroller.classList.contains("show-thought-process") && scroller.classList.contains("show-usage-details"));
check("hiding thoughts preserves reply and tool content", !!scroller.querySelector(".row-assistant .md") && !!scroller.querySelector(".tool"));
hostMessage({ type: "status", status: { ...baseStatus, showThoughtProcess: true } });

// --- #22: expanding a collapsed block keeps the selection and sweeps in what it revealed ---
const thinking = scroller.querySelector("details.thinking");
const summaryEl = thinking.querySelector("summary");
const prose = scroller.querySelector(".row-assistant .md");
const selRange = document.createRange();
selRange.setStart(summaryEl.firstChild, 0);
selRange.setEnd(prose.firstChild.firstChild ?? prose.firstChild, 1);
const sel = window.getSelection();
sel.removeAllRanges();
sel.addRange(selRange);
summaryEl.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
thinking.open = true;
thinking.dispatchEvent(new window.Event("toggle", { bubbles: true }));
const after = window.getSelection();
check("selection spanning a collapsed block survives expanding it",
	after.rangeCount === 1 && !after.getRangeAt(0).collapsed && after.getRangeAt(0).startContainer === summaryEl.firstChild,
	`ranges=${after.rangeCount} collapsed=${after.rangeCount ? after.getRangeAt(0).collapsed : "n/a"}`);
// ...and a selection that ENDED inside the collapsed block extends over the text
// the expand just revealed, so the operator never re-selects (#22).
thinking.open = false;
const inner = document.createRange();
inner.setStart(summaryEl.firstChild, 0);
inner.setEnd(summaryEl.firstChild, 7);
sel.removeAllRanges();
sel.addRange(inner);
summaryEl.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
thinking.open = true;
thinking.dispatchEvent(new window.Event("toggle", { bubbles: true }));
const swept = window.getSelection().getRangeAt(0);
check("expanding sweeps the selection over the revealed thinking text",
	thinking.querySelector(".thinking-body").contains(swept.endContainer),
	`end=${swept.endContainer.nodeValue ?? swept.endContainer.nodeName}`);
check("session id shown", document.querySelector(".session-id").textContent === "#019fd749");
check("runtime label is hidden from the composer", document.querySelector(".status-strip").hidden);
check("live badge state is retained for webview updates", document.querySelector(".live-label").textContent === "live");
check("context meter labeled", document.querySelector(".context-label").textContent === "Context 23% · 60K / 262K");

// --- model menu with favorites ---
hostMessage({
	type: "models",
	models: [
		{ provider: "chutes", id: "kimi", contextWindow: 262144, reasoning: true, input: ["text", "image"] },
		{ provider: "chutes", id: "glm", contextWindow: 131072, reasoning: false, input: ["text"] },
		{ provider: "openai", id: "gpt-5", contextWindow: 400000, reasoning: true, input: ["text", "image"] },
	],
});
hostMessage({ type: "favorites", favorites: [{ provider: "chutes", modelId: "kimi" }] });
const modelBtn = [...document.querySelectorAll(".rail-pill.model")][0];
modelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const dropdown = document.querySelector(".dropdown");
check("model menu opens", !!dropdown);
check("model menu has search", !!dropdown.querySelector(".dropdown-search"));
check("favorites section present", [...document.querySelectorAll(".dropdown-section")].some((s) => s.textContent === "Favorites"));
check("model menu items only (no thinking section)", document.querySelectorAll(".dropdown-item").length === 3,
	`${document.querySelectorAll(".dropdown-item").length} items`);
check("dropdown is portaled outside its button anchor", !modelBtn.contains(dropdown));
check("open model menu contains no nested native controls",
	document.querySelectorAll("button button, button input, button select, button textarea").length === 0,
	[...document.querySelectorAll("button button, button input, button select, button textarea")].map((node) => node.outerHTML).join("\n"));
// Selection changes must not rebuild rows or their favorite buttons.
{
	const rows = [...dropdown.querySelectorAll(".dropdown-item")];
	const stars = rows.map((row) => row.querySelector(".dropdown-star"));
	const search = dropdown.querySelector(".dropdown-search");
	const createElement = document.createElement;
	const createElementNS = document.createElementNS;
	let created = 0;
	document.createElement = function (...args) { created++; return createElement.apply(this, args); };
	document.createElementNS = function (...args) { created++; return createElementNS.apply(this, args); };
	const hover = (index) => dropdown.querySelectorAll(".dropdown-item")[index]
		.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
	const key = (value) => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
	try {
		hover(1);
		check("dropdown hover selects the pointed row", dropdown.querySelectorAll(".dropdown-item")[1].classList.contains("selected"));
		hover(2);
		hover(0);
		key("ArrowUp");
		check("dropdown ArrowUp wraps to last row", dropdown.querySelectorAll(".dropdown-item")[2].classList.contains("selected"));
		key("ArrowDown");
		check("dropdown ArrowDown wraps to first row", dropdown.querySelectorAll(".dropdown-item")[0].classList.contains("selected"));
		key("ArrowDown");
	} finally {
		document.createElement = createElement;
		document.createElementNS = createElementNS;
	}
	check("dropdown six selection moves create zero DOM elements", created === 0, `${created} elements created`);
	check("dropdown selection preserves row and favorite button identity", rows.every((row, index) =>
		dropdown.querySelectorAll(".dropdown-item")[index] === row && row.querySelector(".dropdown-star") === stars[index]));
	check("dropdown navigation keeps search focused", document.activeElement === search);
	check("dropdown navigation has exactly one selected row", dropdown.querySelectorAll(".dropdown-item.selected").length === 1);
	search.value = "glm";
	search.dispatchEvent(new window.Event("input", { bubbles: true }));
	check("dropdown filtering still rebuilds and resets selection", dropdown.querySelectorAll(".dropdown-item").length === 1 &&
		dropdown.querySelector(".dropdown-item.selected")?.textContent.includes("glm") && !dropdown.querySelector(".dropdown-section"));
	search.value = "no-such-model";
	search.dispatchEvent(new window.Event("input", { bubbles: true }));
	key("ArrowDown");
	check("dropdown empty filter remains open on arrow navigation", !!dropdown.querySelector(".dropdown-empty") && dropdown.isConnected);
	search.value = "";
	search.dispatchEvent(new window.Event("input", { bubbles: true }));
	check("dropdown clearing search restores sections and first selection", dropdown.querySelectorAll(".dropdown-item").length === 3 &&
		!!dropdown.querySelector(".dropdown-section") && dropdown.querySelector(".dropdown-item").classList.contains("selected"));
}
posted.length = 0;
// toggle favorite on the gpt-5 row
const gptRow = [...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("gpt-5"));
gptRow.querySelector(".dropdown-star").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("star posts toggle", posted.some((m) => m.type === "toggleFavoriteModel" && m.modelId === "gpt-5"));
// select a model row
const glmRow = [...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("glm"));
glmRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("select posts setModel", posted.some((m) => m.type === "setModel" && m.modelId === "glm"));
check("menu closed after select", !document.querySelector(".dropdown"));
// brain is its own rail pill right of the model pill
const brainPill = document.querySelector(".composer-rail .rail-pill.brain");
check("brain rail pill present", !!brainPill);
check("brain pill shows icon and current level", !!brainPill.querySelector("svg") && brainPill.textContent === "max");
// non-reasoning model: brain pill disabled, and model rows have no per-row accessories beyond the star
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm", thinkingLevel: "off" } });
check("brain pill disabled on non-reasoning model", document.querySelector(".composer-rail .rail-pill.brain").className.includes("disabled-pill"));
check("brain pill shows off on non-reasoning model", brainPill.textContent === "off");
modelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const glmRowAcc = [...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("glm"));
check("no brain accessory on model rows", glmRowAcc && !glmRowAcc.querySelector(".dropdown-brain"));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
// reasoning model: the brain pill lists exactly what the model declares. Kimi K3 TEE's
// real thinkingLevelMap maps every level to null except "max" — the host derives that
// and the menu must show "max" as its own row and never invent "xhigh".
const kimiLevels = { ...baseStatus, availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "max"] };
hostMessage({ type: "status", status: kimiLevels });
hostMessage({ type: "snapshot", messages: [], state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" }, status: kimiLevels });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const tDrop = document.querySelector(".dropdown");
check("thinking menu opens from brain pill", !!tDrop && (tDrop.querySelector(".dropdown-header")?.textContent ?? "").startsWith("Thinking —"));
const tLevels = [...(tDrop?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("max listed as its own level, xhigh not invented", tLevels.some((l) => l.startsWith("max")) && !tLevels.some((l) => l.startsWith("xhigh")), JSON.stringify(tLevels));
check("current level marked (max, unaliased)", [...(tDrop?.querySelectorAll(".dropdown-item") ?? [])].some((r) => r.className.includes("current") && r.textContent.startsWith("max")));
posted.length = 0;
[...tDrop.querySelectorAll(".dropdown-item")].find((r) => r.textContent.startsWith("high")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("select posts setThinkingLevel", posted.some((m) => m.type === "setThinkingLevel" && m.level === "high"));
hostMessage({ type: "status", status: { ...kimiLevels, thinkingLevel: "high" } });
check("brain pill updates visible level after host confirmation", brainPill.textContent === "high" && !!brainPill.querySelector("svg"));
// available-levels feed filters the list
hostMessage({ type: "status", status: { ...baseStatus, availableThinkingLevels: ["off", "medium", "high"] } });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const treatedLevels = [...(document.querySelector(".dropdown")?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("available levels filter the picker", treatedLevels.length === 3 && treatedLevels.every((l) => ["off", "medium", "high"].some((a) => l.startsWith(a))), JSON.stringify(treatedLevels));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
// unknown model (no list from the host): fall back to the levels every reasoning model
// takes — never xhigh/max, which exist only where the model declares them.
hostMessage({ type: "status", status: { ...baseStatus, availableThinkingLevels: null } });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const fallbackLevels = [...(document.querySelector(".dropdown")?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("unknown model never offers xhigh/max", fallbackLevels.length === 5 && !fallbackLevels.some((l) => l.startsWith("xhigh") || l.startsWith("max")), JSON.stringify(fallbackLevels));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

// --- unified attach menu (vision-gated image item on a text model) ---
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
const attachBtn = [...document.querySelectorAll(".composer-rail .icon-btn")].find((b) => b.title.startsWith("Attach"));
attachBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const attachMenu = document.querySelector(".dropdown");
check("attach menu opens", !!attachMenu);
const imageItem = [...attachMenu.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("Image"));
check("image item disabled on text-only model", imageItem.className.includes("disabled"));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

// --- composer send ---
posted.length = 0;
const textarea = document.querySelector("textarea");
textarea.value = "test prompt";
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const promptMsg = posted.find((m) => m.type === "prompt");
check("enter sends prompt", !!promptMsg && promptMsg.payload.text === "test prompt");

// --- IME composition: the mirror must show the composing range, and Enter must
// not send while a candidate is still being chosen (the native underline is
// invisible because the textarea is color:transparent).
posted.length = 0;
textarea.value = "輸入";
textarea.selectionStart = 0;
textarea.selectionEnd = 2;
textarea.dispatchEvent(new window.CompositionEvent("compositionstart", { data: "輸入" }));
textarea.dispatchEvent(new window.CompositionEvent("compositionupdate", { data: "輸入" }));
textarea.dispatchEvent(new window.InputEvent("input", { data: "輸入", isComposing: true, bubbles: true }));
check("composing range is underlined on the mirror",
	[...document.querySelectorAll(".composer-mirror .ime")].some((n) => n.textContent === "輸入"),
	document.querySelector(".composer-mirror")?.innerHTML ?? "<none>");
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
check("Enter during composition does not send", !posted.some((m) => m.type === "prompt"), JSON.stringify(posted.map((m) => m.type)));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true, keyCode: 229 }));
check("IME keyCode 229 Enter does not send", !posted.some((m) => m.type === "prompt"));
textarea.dispatchEvent(new window.CompositionEvent("compositionend", { data: "輸入" }));
textarea.dispatchEvent(new window.InputEvent("input", { data: "輸入", bubbles: true }));
check("underline clears after compositionend",
	document.querySelectorAll(".composer-mirror .ime").length === 0,
	document.querySelector(".composer-mirror")?.innerHTML ?? "<none>");
const confirmEnter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
textarea.dispatchEvent(confirmEnter);
check("Enter that confirms composition does not send", !posted.some((m) => m.type === "prompt"), JSON.stringify(posted.map((m) => m.type)));
await new Promise((resolve) => setTimeout(resolve, 0));
posted.length = 0;
textarea.value = "輸入";
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("Enter after composition sends the committed text",
	posted.some((m) => m.type === "prompt" && m.payload.text === "輸入"),
	JSON.stringify(posted.filter((m) => m.type === "prompt").map((m) => m.payload?.text)));


// --- history view (grouped) ---
posted.length = 0;
const historyBtn = document.querySelector('button[title="Session history"]');
historyBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("requests history on toggle", posted.some((m) => m.type === "requestHistory"));
hostMessage({
	type: "history",
	sessions: [
		{ path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true, id: "hist-a", sessionId: "019fd749-a" },
		{ path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});
const historyScope = document.querySelector(".history-scope");
check("history defaults to this workspace", historyScope.textContent === "This workspace" && document.querySelectorAll(".history-item").length === 1);
check("workspace scope uses Active and hides other sessions",
	document.querySelector(".history-group-summary")?.textContent === "Active (1)" && !document.querySelector(".history-list")?.textContent.includes("work on proj"));
historyScope.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("scope toggle shows all sessions", historyScope.textContent === "All sessions" && document.querySelectorAll(".history-item").length === 2);
check("scope toggle persists", savedWebviewState.historyScope === "all");
check("all-session scope keeps folder context", [...document.querySelectorAll(".history-item")].some((i) => i.textContent.includes("proj")));
historyScope.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
hostMessage({
	type: "history",
	sessions: [
		{ id: "scope-live", path: "/tmp/scope-live.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "workspace active", inWorkspace: true },
		{ id: "scope-arch", path: "/tmp/scope-arch.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "workspace archive", inWorkspace: true, archived: true },
		{ id: "other-arch", path: "/tmp/other-arch.jsonl", cwd: "/other", timestamp: new Date().toISOString(), name: "other archive", inWorkspace: false, archived: true },
	],
});
check("workspace scope filters Active and Archive alike",
	[...document.querySelectorAll(".history-group-summary")].map((n) => n.textContent).join("|") === "Active (1)|Archive (1)" &&
	!document.querySelector(".history-list")?.textContent.includes("other archive"));
historyScope.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("all-session scope keeps lifecycle groups without workspace groups",
	[...document.querySelectorAll(".history-group-summary")].map((n) => n.textContent).join("|") === "Active (1)|Archive (2)");
hostMessage({
	type: "history",
	sessions: [
		{ path: "/tmp/old.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 86_400e3 * 3).toISOString(), modifiedMs: Date.now() - 86_400e3 * 3, sortMs: Date.now() - 86_400e3 * 3, name: "oldest", inWorkspace: true },
		{ path: "/tmp/new.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 86_400e3).toISOString(), modifiedMs: Date.now() - 86_400e3, sortMs: Date.now() - 86_400e3, name: "renamed-just-now", inWorkspace: true },
		{ path: "/tmp/mid.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), sortMs: Date.now(), name: "newest", inWorkspace: true },
		{ path: "/tmp/busy.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now() + 86_400e3, sortMs: Date.now() - 86_400e3 * 10, name: "still-running-old", inWorkspace: true, status: "running" },
	],
});
const itemNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("priority sort keeps running sessions ahead, then uses frozen sortMs", itemNames.join("|") === "still-running-old|newest|renamed-just-now|oldest", itemNames.join("|"));
const relativeTimes = [...document.querySelectorAll(".history-item .history-item-time")].map((n) => n.textContent);
check("renamed session labels by activity time", relativeTimes[2].includes("d"), JSON.stringify(relativeTimes));
check("history groups rendered", document.querySelectorAll(".history-item").length === 4);
check("active group is foldable",
	[...document.querySelectorAll(".history-group-summary")].some((n) => n.textContent.includes("Active")));
const historySort = document.querySelector(".history-sort");
historySort.value = "birth";
historySort.dispatchEvent(new window.Event("change", { bubbles: true }));
const birthNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("birth-time sort uses session creation time", birthNames[0] === "newest" && birthNames.at(-1) === "oldest", birthNames.join("|"));
historySort.value = "priority";
historySort.dispatchEvent(new window.Event("change", { bubbles: true }));
hostMessage({
	type: "history",
	sessions: [
		{ id: "read", path: "/tmp/read.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "read", inWorkspace: true },
		{ id: "running", path: "/tmp/running.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "running", inWorkspace: true, status: "running" },
		{ id: "done", path: "/tmp/done.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "done", inWorkspace: true, unreadComplete: true },
	],
});
const priorityNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("priority sort orders done, running, then read", priorityNames.join("|") === "done|running|read", priorityNames.join("|"));
check("history sort selection persists", savedWebviewState.historySort === "priority");
 // re-seed the canonical 2-item list for downstream checks
hostMessage({
	type: "history",
	sessions: [
		{ id: "hist-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ id: "hist-b", path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});
check("other session shows folder", [...document.querySelectorAll(".history-item")].some((i) => i.textContent.includes("proj")));
posted.length = 0;
document.querySelectorAll(".history-item")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("resume switches session", posted.some((m) => m.type === "switchSession" && m.path === "/tmp/b.jsonl"));

// Current session uses the same row chrome as every other row. Clicking it
// closes history without asking the host to reload the thread.
hostMessage({
	type: "history",
	sessions: [
		{ id: "019fd749-x", path: "/tmp/current.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "current thread", inWorkspace: true },
		{ id: "hist-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
	],
});
{
	const currentRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("current thread"));
	check("current row is marked current", currentRow?.classList.contains("current"));
	check("current resume exposes its current state", currentRow?.querySelector(".history-resume")?.getAttribute("aria-current") === "true");
	check("other resumes are not marked current", [...document.querySelectorAll(".history-item:not(.current) .history-resume")].every((button) => !button.hasAttribute("aria-current")));
	check("history has a concise heading and named search", document.querySelector(".history-title")?.textContent === "Sessions" && document.querySelector(".history-search")?.getAttribute("aria-label") === "Search sessions");
	check("current row title is not suffixed", currentRow?.querySelector(".history-item-name")?.textContent === "current thread");
	check("current idle row keeps time without a lamp", !!currentRow?.querySelector(".history-item-meta .history-item-time") && !currentRow?.querySelector(".history-item-meta .running-mark"));
	check("current row still has a resume control", currentRow?.querySelector("button.history-resume") instanceof window.HTMLButtonElement);
	posted.length = 0;
	currentRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("clicking current session requests a confirmed reopen", document.querySelector(".history-view")?.style.display === "none" && posted.some((m) => m.type === "switchSession"), JSON.stringify(posted.map((m) => m.type)));
}
hostMessage({
	type: "history",
	sessions: [
		{ id: "hist-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ id: "hist-b", path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});

// --- subagents strip: renders children, browses into one, returns via parent ---
check("subagents strip hidden with no children", !document.querySelector(".subagents-strip.visible"));

// --- bottom stack order -----------------------------------------------------
{
	const order = [...document.querySelector("#app").children]
		.map((node) => node.className.split(" ")[0])
		.filter((name) => ["subagents-strip", "composer-dock"].includes(name));
	check(
		"bottom stack reads subagents then composer",
		order.join(" > ") === "subagents-strip > composer-dock",
		order.join(" > "),
	);
}
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "019fdaa1-0000", activeSessionId: "abcdef123450", browseRef: "browse-verify-threads", name: "verify-threads", runtimeKind: "subagent", rlmDepth: 1, isStreaming: true, attachedClients: 0 },
		{ id: "019fdaa2-0001", activeSessionId: "abcdef123451", name: "audit-style", runtimeKind: "subagent", rlmDepth: 1, isStreaming: false, attachedClients: 1 },
	],
});
check("subagents strip visible with children", !!document.querySelector(".subagents-strip.visible"));
const stripHeader = document.querySelector(".subagents-strip .subagents-header");
check("strip header names each state, not one lumped total",
	stripHeader && stripHeader.textContent.includes("Subagents (1 running · 1 idle)"), stripHeader?.textContent ?? "");
stripHeader.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rows = document.querySelectorAll(".subagents-strip .subagent-row");
check("two subagent rows", rows.length === 2);
check("a running child is badged with the same word the header counts",
	[...rows].some((r) => r.querySelector(".subagent-badge")?.textContent === "running"));
posted.length = 0;
[...rows].find((r) => r.textContent.includes("verify-threads")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("browse posts the host-issued child reference", posted.some((m) => m.type === "browseChild" && m.browseRef === "browse-verify-threads"));
// host confirms the browse with a parent context: back-row appears and is clickable.
// The viewed subagent stays in the list — leaving it out is what made the count
// drop by one and left the green "viewing" highlight with nothing to land on.
hostMessage({
	type: "sessionChildren",
	children: [],
	parent: { id: "019fd749-root", activeSessionId: "019fd749main", name: "parent-agent" },
	siblings: [
		{ id: "019fdaa1-0000", activeSessionId: "abcdef123450", name: "verify-threads", runtimeKind: "subagent", rlmDepth: 1, status: "running", isStreaming: true, attachedClients: 1 },
		{ id: "019fdaa2-0001", activeSessionId: "abcdef123451", name: "audit-style", runtimeKind: "subagent", rlmDepth: 1, status: "idle", isStreaming: false, attachedClients: 1 },
	],
	viewedActiveSessionId: "abcdef123450",
});
const backRow = document.querySelector(".subagents-strip .subagents-back-row");
check("back-row appears while viewing a child", !!backRow, document.querySelector(".subagents-strip")?.textContent?.slice(0, 60) ?? "");
check("sibling section keeps every child of the parent", [...document.querySelectorAll(".subagents-list.siblings .subagent-row")].length === 2);
const viewingRow = document.querySelector(".subagent-row.viewing");
check("viewed child is highlighted", !!viewingRow && viewingRow.textContent.includes("verify-threads"), viewingRow?.textContent ?? "none");
check("count does not drop on entering a child", document.querySelector(".subagents-header").textContent.includes("Subagents (1 running · 1 idle)"), document.querySelector(".subagents-header").textContent);
// historical (finished, non-resident) subagents: separate collapsed group, not counted as live
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "live-1", activeSessionId: "aaaa0001", name: "shell-adapter", runtimeKind: "subagent", rlmDepth: 1, status: "idle", isStreaming: false, attachedClients: 0 },
		{ id: "done-1", activeSessionId: "019fd742-done1", name: "verify-vault", runtimeKind: "subagent", rlmDepth: 1, status: "inactive", isStreaming: false, attachedClients: 0 },
		{ id: "done-2", activeSessionId: "019fd742-done2", name: "verify-shell", runtimeKind: "subagent", rlmDepth: 1, status: "inactive", isStreaming: false, attachedClients: 0 },
	],
	parent: { id: "019fd749-root", activeSessionId: "019fd749main", name: "parent-agent" },
});
check("header separates idle from finished", document.querySelector(".subagents-header").textContent.includes("Subagents (1 idle · 2 finished)"), document.querySelector(".subagents-header").textContent);
check("live list holds only the resident subagent", document.querySelectorAll(".subagents-list:not(.historical) .subagent-row").length === 1);
check("historical group is collapsed by default", !document.querySelector(".subagents-list.historical"));
const histHead = document.querySelector(".subagents-subhead");
check("historical group has its own toggle", !!histHead && histHead.textContent.includes("Historical (2)"), histHead?.textContent ?? "none");
histHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("expanding historical reveals the finished rows", document.querySelectorAll(".subagents-list.historical .subagent-row").length === 2);
check("finished rows read finished, not idle", [...document.querySelectorAll(".subagents-list.historical .subagent-badge")].every((b) => b.textContent === "finished"));
histHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
posted.length = 0;
document.querySelector(".subagents-strip .subagents-back-row").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("back-row click posts backToParent", posted.some((m) => m.type === "backToParent"));

// A later disconnect only changes the status strip; it never covers the transcript.
hostMessage({ type: "status", status: { ...baseStatus, connected: true, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
hostMessage({ type: "status", status: { ...baseStatus, connected: false } });
check("a later disconnect leaves the transcript unobstructed", !document.querySelector(".boot-splash"));
check("the dropout is told in the status strip instead", document.querySelector(".live-label").textContent === "offline", document.querySelector(".live-label").textContent);
hostMessage({ type: "status", status: { ...baseStatus, connected: true, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });

// --- send button muted until content ---
const sendBtn = document.querySelector(".composer-dock .send-btn:not(.stop)");
check("send muted while empty", sendBtn.className.includes("muted"));
textarea.value = "something";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
check("send armed with input", !document.querySelector(".composer-dock .send-btn:not(.stop)").className.includes("muted"));
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("send muted again after send", document.querySelector(".composer-dock .send-btn:not(.stop)").className.includes("muted"));

// --- history: stateful refresh + search filter ---
posted.length = 0;
document.querySelector(".history-search").value = "proj";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
const visibleItems = document.querySelectorAll(".history-item");
check("history search filters", visibleItems.length === 1 && visibleItems[0].textContent.includes("proj"));
document.querySelector(".history-search").value = "";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
check("search cleared restores both groups", document.querySelectorAll(".history-item").length === 2);

hostMessage({ type: "history", sessions: [{ id: "new-tab", path: "new-tab", cwd: "/ws", timestamp: new Date().toISOString(), inWorkspace: true, isNew: true, status: "idle" }] });
check("unsent session has explicit new label", document.querySelector(".history-item-name")?.textContent === "New session" && document.querySelector(".history-new-session")?.textContent === "New session");
check("unsent session has no file management actions", document.querySelectorAll(".history-actions button").length === 0);
posted.length = 0;
document.querySelector(".history-resume").click();
check("new session row routes to its open tab", posted.some((message) => message.type === "switchSession" && message.sessionId === "new-tab"));
hostMessage({ type: "history", sessions: [] });
check("closed unsent session leaves no row", document.querySelectorAll(".history-item").length === 0);

// The history-only sidebar follows editor focus, including list refreshes.
hostMessage({ type: "setHistoryMode", enabled: true });
const focusSessions = ["focus-a", "focus-b"].map(id => ({ id, path: `/tmp/${id}.jsonl`, cwd: "/ws", timestamp: new Date().toISOString(), name: id, inWorkspace: true }));
hostMessage({ type: "history", sessions: focusSessions });
for (const sessionId of ["focus-a", "focus-b"]) {
	hostMessage({ type: "historySelection", sessionId });
	hostMessage({ type: "history", sessions: focusSessions });
	check("sidebar highlights only the focused editor session after refresh", document.querySelectorAll(".history-item.current").length === 1 && document.querySelector(".history-item.current .history-item-name")?.textContent === sessionId);
}
const selectedHistoryRow = document.querySelector(".history-item.current");
hostMessage({ type: "historySelection", sessionId: "focus-b" });
check("repeated streaming selection updates preserve clickable history rows", document.querySelector(".history-item.current") === selectedHistoryRow);
hostMessage({ type: "historySelection" });
check("closing the focused session clears selection", !document.querySelector(".history-item.current"));
hostMessage({ type: "setHistoryMode", enabled: false });

// Context capacity is separate from session cost; cumulative tokens stay in the details.
{
	const label = document.querySelector(".context-label");
	const observer = new window.MutationObserver(() => {});
	observer.observe(label, { childList: true });
	hostMessage({ type: "status", status: { ...baseStatus, compactDefaultPercent: 94 } });
	const addedTextNodes = observer.takeRecords().reduce((count, record) => count + record.addedNodes.length, 0);
	observer.disconnect();
	check("status renders context label once", addedTextNodes === 1, `${addedTextNodes} text replacements per status`);
}
check("context label shows capacity", document.querySelector(".context-label").textContent === "Context 23% · 60K / 262K");
check("context tooltip shows used and total tokens", document.querySelector(".context-meter").title === "Context 23% · 60,000 / 262,144 tokens");
const sessionUsage = document.querySelector("details.stats-label");
check("session status remains below the prompt controls", document.querySelector(".composer-card").lastElementChild === document.querySelector(".status-strip"));
check("session id and fee share the composer rail", document.querySelector(".composer-rail .session-id") && document.querySelector(".composer-rail .stats-label"));
check("session status has no conversation copy button", !document.querySelector(".status-strip button"));
check("session fee uses two decimals and details stay collapsed", !sessionUsage.open && sessionUsage.querySelector("summary").textContent === "$0.00");
hostMessage({ type: "status", status: { ...baseStatus, costUsd: 1.236 } });
check("session fee rounds to two decimals", sessionUsage.querySelector("summary").textContent === "$1.24");
hostMessage({ type: "status", status: baseStatus });
check("session details state scope and cumulative usage", sessionUsage.textContent.includes("4.5k tokens") && sessionUsage.textContent.includes("subagents") && sessionUsage.textContent.includes("$0.0040"));
sessionUsage.open = true;
hostMessage({ type: "status", status: { ...baseStatus, costUsd: 0 } });
check("zero cost remains visible", !sessionUsage.hidden && sessionUsage.querySelector("summary").textContent.includes("$0.00"));
hostMessage({ type: "status", status: { ...baseStatus, composerToolbar: ["context", "id", "cost", "btn"] } });
const configuredRail = document.querySelector(".composer-rail");
const configuredItems = [...configuredRail.children].map((item) => item.className);
check("composer toolbar config controls visible items and their order",
	configuredItems.join("|") === "icon-btn|composer-meta context-meter|composer-meta session-id|composer-meta stats-label|send-btn stop|send-control",
	configuredItems.join("|"));
hostMessage({ type: "status", status: { ...baseStatus, costUsd: undefined, usageTotal: undefined } });
check("missing usage hides session stats", sessionUsage.hidden);
hostMessage({ type: "status", status: { ...baseStatus, contextPercent: null, contextTokens: null } });
check("unknown context is pending not zero", document.querySelector(".context-label").textContent === "Context pending · pending / 262K" && !document.querySelector(".context-fill, .context-tokens"));
hostMessage({ type: "status", status: { ...baseStatus, contextPercent: 90, compactDefaultPercent: 94 } });
check("context below effective threshold has no hardcoded warning", !document.querySelector(".context-label").classList.contains("warm") && !document.querySelector(".context-label").classList.contains("hot"));
hostMessage({ type: "compactThreshold", percent: 85 });
check("threshold-only update refreshes context warning", document.querySelector(".context-label").classList.contains("warm"));
hostMessage({ type: "status", status: { ...baseStatus, compactDefaultPercent: 94 } });
sessionUsage.open = false;

// Context is read-only, including while streaming or receiving threshold updates.
const meter = document.querySelector(".context-meter");
posted.length = 0;
meter.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("context has no controls or threshold tick", !meter.querySelector("input, button, .context-tick, .threshold-flyout"));
check("context click does not post settings", !posted.some((m) => m.type === "setCompactThreshold"));
hostMessage({ type: "status", status: { ...baseStatus, streaming: true, contextTokens: 0, contextPercent: 0 } });
check("zero context is visible", meter.title === "Context 0% · 0 / 262,144 tokens" && meter.querySelector(".context-label").textContent === "Context 0% · 0K / 262K");
hostMessage({ type: "status", status: { ...baseStatus, contextTokens: null, contextPercent: null } });
check("pending usage keeps total capacity visible", meter.title === "Context pending · pending / 262,144 tokens");
hostMessage({ type: "status", status: { ...baseStatus, contextTokens: null, contextPercent: null, contextWindow: undefined } });
check("missing capacity hides stale context", meter.style.display === "none");
hostMessage({ type: "status", status: baseStatus });
check("context usage returns on status", meter.style.display !== "none" && meter.title === "Context 23% · 60,000 / 262,144 tokens");

// --- install prompt banner ---
check("install banner hidden initially", !document.querySelector(".install-banner.visible"));
hostMessage({ type: "installPrompt", url: "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md", reason: "test reason" });
const banner = document.querySelector(".install-banner.visible");
check("install banner appears on prompt", !!banner, document.querySelector(".install-card")?.textContent?.slice(0, 60) ?? "");
check("banner links the quickstart", banner?.querySelector(".install-cta") !== null);
// An operator who cannot reach the CLI wants the command, not a doc tour.
check("banner shows Prime Intellect's own install one-liner",
	banner?.querySelector(".install-cmd")?.textContent === "curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh",
	banner?.querySelector(".install-cmd")?.textContent ?? "<none>");
posted.length = 0;
banner.querySelector(".install-dismiss").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("dismiss posts and hides", !document.querySelector(".install-banner.visible") && posted.some((m) => m.type === "dismissInstallPrompt"));

// --- spawn cards: announced inline on new child registrations, clickable to view ---
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "sub-a", activeSessionId: "aaaa1111", name: "verify-threads", runtimeKind: "subagent", created: "2026-08-07T15:00:00Z", isStreaming: true, attachedClients: 0, rlmDepth: 1 },
	],
	spawned: [{ activeSessionId: "aaaa1111", browseRef: "browse-spawn-verify", name: "verify-threads", created: "2026-08-07T15:00:00Z" }],
});
const spawnCard = document.querySelector(".spawned-card");
check("spawn card visible with name", !!spawnCard && spawnCard.textContent.includes("Subagent spawned — verify-threads"), spawnCard?.textContent ?? "");
posted.length = 0;
spawnCard.querySelector(".spawned-view").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("spawn card click posts its host-issued child reference", posted.some((m) => m.type === "browseChild" && m.browseRef === "browse-spawn-verify"));
// seeded baseline (second payload): ended child gets NO card at all; running one keeps theirs
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "sub-a", activeSessionId: "aaaa1111", name: "verify-threads", runtimeKind: "subagent", created: "2026-08-07T15:00:00Z", isStreaming: false, attachedClients: 0, rlmDepth: 1 },
	],
});
check("re-broadcast does not duplicate the spawn card", document.querySelectorAll(".spawned-card").length === 1);
hostMessage({ type: "snapshot", messages: [], state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "high" }, status: baseStatus });
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "old-sub", activeSessionId: "bbbb2222", name: "login-session", runtimeKind: "subagent", created: "2026-08-06T10:00:00Z", isStreaming: false, attachedClients: 0, rlmDepth: 1 },
		{ id: "live-sub", activeSessionId: "cccc3333", name: "audit-live", runtimeKind: "subagent", created: "2026-08-07T16:00:00Z", isStreaming: true, attachedClients: 0, rlmDepth: 1 },
	],
});
const cards = document.querySelectorAll(".spawned-card");
check("baseline seeds cards only for running children", cards.length === 1 && cards[0].textContent.includes("Subagent spawned — audit-live"), cards.length + " cards: " + [...cards].map((c) => c.textContent).join("|"));
check("re-broadcast does not duplicate the spawn card", document.querySelectorAll(".spawned-card").length === 1);

// --- spawn card placement: at the creation point in the run, not dumped at the bottom.
// Message timestamps are epoch-ms numbers (the agent writes Date.now()), which is
// what tags the rows the ordered insert compares against.
const spawnT0 = Date.parse("2026-08-07T12:00:00Z");
const spawnCreated = new Date(spawnT0 + 300_000).toISOString();
hostMessage({
	type: "snapshot",
	messages: [
		{ role: "user", content: "kick off the audit", timestamp: spawnT0 },
		{ role: "assistant", model: "kimi", stopReason: "stop", content: [{ type: "text", text: "audit finished" }], timestamp: spawnT0 + 600_000 },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "high" },
	status: baseStatus,
});
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "mid-sub", activeSessionId: "dddd4444", name: "mid-run", runtimeKind: "subagent", created: spawnCreated, status: "running", isStreaming: true, attachedClients: 0, rlmDepth: 1 },
	],
	spawned: [{ activeSessionId: "dddd4444", name: "mid-run", created: spawnCreated }],
});
const placed = [...document.querySelector(".messages").children];
const cardIdx = placed.findIndex((n) => n.className.includes("spawned-card"));
const userIdx = placed.findIndex((n) => n.className.includes("row-user"));
const asstIdx = placed.findIndex((n) => n.className.includes("row-assistant"));
check(
	"spawn card sits between the messages that bracket its start time",
	cardIdx > userIdx && cardIdx < asstIdx && userIdx >= 0 && asstIdx >= 0,
	`user=${userIdx} card=${cardIdx} assistant=${asstIdx}`,
);

// --- history: running indicator + stop/rename/delete ordering ---
hostMessage({
	type: "history",
	sessions: [
		{ id: "run-1", path: "/tmp/run.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "live worker", inWorkspace: true, running: true, status: "running" },
		{ id: "idle-1", path: "/tmp/idle.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "quiet archive", inWorkspace: true, status: "idle" },
		{ id: "gone-1", path: "/tmp/gone.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "retired thread", inWorkspace: true, status: "inactive" },
		{ id: "old-host", path: "/tmp/old.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "legacy row", inWorkspace: true },
	],
});
const rowNamed = (text) => [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes(text));
const markOf = (text) => rowNamed(text)?.querySelector(".running-mark");
const runRow = rowNamed("live worker");
check("running row shows the animated mark", !!runRow.querySelector(".running-dot"));
const runningDotDelay = Number.parseFloat(runRow.querySelector(".running-dot")?.style.animationDelay ?? "");
const runningDotPhase = ((-runningDotDelay % 2800) + 2800) % 2800;
const wallClockPhase = Date.now() % 2800;
const phaseDelta = Math.min(Math.abs(runningDotPhase - wallClockPhase), 2800 - Math.abs(runningDotPhase - wallClockPhase));
check("rebuilt running lamps join a shared animation phase", Number.isFinite(runningDotDelay) && phaseDelta < 50, `${runningDotDelay}ms, delta=${phaseDelta}ms`);
check("a running row is the red working lamp", markOf("live worker")?.className.includes("working"), markOf("live worker")?.className);
check("an idle row has no lamp", !markOf("quiet archive"));
check("an inactive row has no lamp", !markOf("retired thread"));
check("working tooltip describes execution", markOf("live worker")?.title === "Working");
check("unknown execution has no lamp", !markOf("legacy row"));
check("unknown execution is conveyed in text", rowNamed("legacy row")?.textContent.includes("Execution status unavailable"));
check("history has no manual unread action", !document.querySelector('[title="Mark unread"]'));
hostMessage({
	type: "history",
	sessions: [
		{ id: "done-1", path: "/tmp/done.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "just finished", inWorkspace: true, status: "idle", unreadComplete: true },
	],
});
check("a finished unread row is the green complete lamp", markOf("just finished")?.className.includes("complete"), markOf("just finished")?.className);
check("completion tooltip describes the window reminder", markOf("just finished")?.title === "Newly completed");
posted.length = 0;
rowNamed("just finished")?.querySelector(".history-resume")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("opening a finished row keeps its lamp until a successful host-confirmed render",
	markOf("just finished")?.className.includes("complete") && posted.some((message) => message.type === "switchSession"), markOf("just finished")?.className);
hostMessage({
	type: "history",
	sessions: [
		{ id: "run-1", path: "/tmp/run.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "live worker", inWorkspace: true, running: true, status: "running" },
		{ id: "idle-1", path: "/tmp/idle.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "quiet archive", inWorkspace: true, status: "idle" },
		{ id: "gone-1", path: "/tmp/gone.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "retired thread", inWorkspace: true, status: "inactive" },
		{ id: "old-host", path: "/tmp/old.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "legacy row", inWorkspace: true },
	],
});
const liveRow = rowNamed("live worker");
check("history actions are siblings of its resume control", !!liveRow.querySelector(".history-item-top > .history-resume + .history-actions") && !liveRow.querySelector(".history-resume button"));
const idleRow = rowNamed("quiet archive");
check("an idle row offers no Stop — there is no run to stop",
	![...idleRow.querySelectorAll(".history-action")].some((b) => b.title.startsWith("Stop")));
const actTitles = [...liveRow.querySelectorAll(".history-action")].map((b) => b.title);
check("actions ordered stop -> rename -> delete", actTitles[0].startsWith("Stop") && actTitles.some((t) => t.startsWith("Rename")) && actTitles.some((t) => t.startsWith("Delete")), actTitles.join("|"));
posted.length = 0;
[...liveRow.querySelectorAll(".history-action")].find((b) => b.title.startsWith("Stop")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("stop posts stopSession", posted.some((m) => m.type === "stopSession" && m.sessionId === "run-1"));
hostMessage({
	type: "history",
	sessions: [
		{ id: "hist-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ id: "hist-b", path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});

check("session chrome actions stay in the webview for tests and welcome",
	!!document.querySelector('button[title="New session"]') && !!document.querySelector('button[title="Session history"]'));

// --- the strip header tallies each state, and stays right as they change -----
{
	const kid = (id, status) => ({ id: `u-${id}`, activeSessionId: id, browseRef: `r-${id}`, name: id,
		runtimeKind: "subagent", rlmDepth: 1, isStreaming: status === "running", status, attachedClients: 0 });
	const headerText = () => document.querySelector(".subagents-strip .subagents-header")?.textContent ?? "";
	const roster = (children) => hostMessage({ type: "sessionChildren", children });

	roster([kid("h0000000001", "running"), kid("h0000000002", "running"), kid("h0000000003", "idle"), kid("h0000000004", "inactive")]);
	check("every state is named with its own count", headerText().includes("Subagents (2 running · 1 idle · 1 finished)"), headerText());

	roster([kid("h0000000001", "running"), kid("h0000000002", "running")]);
	check("empty buckets are dropped, not printed as zero", headerText().includes("Subagents (2 running)"), headerText());

	roster([kid("h0000000003", "idle")]);
	check("an idle-only strip says idle, never live", headerText().includes("Subagents (1 idle)"), headerText());

	roster([kid("h0000000004", "inactive"), kid("h0000000005", "inactive")]);
	check("a finished-only strip counts them as finished", headerText().includes("Subagents (2 finished)"), headerText());

	// The counts follow the roster in real time, including a child going quiet.
	roster([kid("h0000000001", "running"), kid("h0000000003", "idle")]);
	check("the tally follows a status change", headerText().includes("Subagents (1 running · 1 idle)"), headerText());
	roster([kid("h0000000001", "inactive"), kid("h0000000003", "inactive")]);
	check("a child finishing moves it out of the live counts", headerText().includes("Subagents (2 finished)"), headerText());

	// The title spells all three out even when a bucket is empty, so hovering
	// always answers "how many of each" without arithmetic.
	check("the header title always states all three",
		(document.querySelector(".subagents-strip .subagents-header")?.title ?? "").startsWith("0 running · 0 idle · 2 finished"),
		document.querySelector(".subagents-strip .subagents-header")?.title);
}

// --- a compacted thread must not open mid-conversation ----------------------
// After compaction get_messages returns only what survived (84 of 12,257 on a
// real thread) and the single record of everything before is a compactionSummary
// message. Dropping it as an unknown role left a long thread starting abruptly
// with no "load earlier" affordance — because there is genuinely nothing earlier
// in the agent's context; the rest lives in the session file.
{
	hostMessage({ type: "snapshot", state: null, status: baseStatus, messages: [
		{ role: "compactionSummary", summary: "## Goal\n- keep the workbench provider-neutral", tokensBefore: 255756, retainedMessageCount: 84 },
		{ role: "user", content: "carry on" },
		{ role: "custom", customType: "agent_message", display: true,
			content: "Agent-to-agent message received.\n\nfinding: budgets drifted",
			details: { message: "finding: **budgets drifted**", from: { sessionId: "child-1", sessionName: "auditor", model: "claude-sonnet" } } },
		{ role: "custom", customType: "internal_bookkeeping", display: false, content: "should never be shown" },
	] });
	const compaction = document.querySelector(".compaction-summary");
	check("a compacted thread shows where it was compacted", !!compaction);
	check("the boundary states what it replaced",
		/255\.8k tokens summarized/.test(compaction?.querySelector("summary")?.textContent ?? "") &&
		/84 messages kept/.test(compaction?.querySelector("summary")?.textContent ?? ""),
		compaction?.querySelector("summary")?.textContent);
	check("the summary text itself is reachable",
		/provider-neutral/.test(compaction?.querySelector(".compaction-summary-body")?.textContent ?? ""));
	check("it starts collapsed, since it is long", compaction && !compaction.open);

	// Subagent replies are compact conversations, not transport notes.
	const reply = document.querySelector(".conversation-message");
	const bubble = reply?.querySelector(".conversation-bubble");
	check("a subagent reply is shown as a conversation bubble", !!reply && !!bubble);
	check("the sender and model are visible", /auditor/.test(reply?.textContent ?? "") && /claude-sonnet/.test(reply?.textContent ?? ""));
	check("subagent keeps an initials avatar", reply?.querySelector(".conversation-avatar")?.textContent === "A" && !reply.querySelector(".conversation-avatar svg"));
	check("the transport envelope is not shown", !reply?.textContent.includes("Agent-to-agent message received"));
	check("the reply starts folded", bubble && !bubble.open);
	bubble.open = true;
	check("the expanded reply renders markdown", bubble.querySelector("strong")?.textContent === "budgets drifted");
	check("an entry marked display:false stays hidden", !document.body.textContent.includes("should never be shown"));
}

// Unnamed daemon agents have endpoint IDs but no sessionName.
{
	const content = "Agent-to-agent message received.\nSource: agent_message\nFrom: active 0d1a3b8a04c5, session child-session, client daemon-client:sender\nTo: active receiver, session parent-session\nMessage id: agentmsg_test\n\n我已完成，**不再編輯**。";
	const senders = [
		{ activeSessionId: "0d1a3b8a04c5", sessionId: "child-session", clientId: "daemon-client:sender" },
		{ sessionName: "  ", sessionId: "session-only" },
		{ clientId: "daemon-client:only" },
		undefined,
	];
	hostMessage({ type: "snapshot", state: null, status: baseStatus, messages: senders.map((from) => ({
		role: "custom", customType: "agent_message", display: true, content,
		details: { message: "我已完成，**不再編輯**。", from },
	})) });
	const replies = [...document.querySelectorAll(".conversation-message")];
	check("unnamed agent messages render as conversation bubbles", replies.length === 4 && !document.querySelector(".custom-note"));
	check("unnamed senders use endpoint identity or an agent label", JSON.stringify(replies.map((row) => row.querySelector(".conversation-sender")?.textContent)) === JSON.stringify(["0d1a3b8a04c5", "session-only", "daemon-client:only", "agent"]));
	check("unnamed replies hide the transport envelope and render body markdown", replies.length === 4 && replies.every((row) => !row.textContent.includes("Source: agent_message") && row.querySelector("strong")?.textContent === "不再編輯"));
}

// Async shell completions and background-task wake prompts use the same folded conversation bubble.
{
	hostMessage({ type: "snapshot", state: null, status: baseStatus, messages: [
		{ role: "custom", customType: "async_bash_completion", display: true,
			content: "Shell message received.\nSource: bash\nCommand completed (pid 321, exit code 0).\nCommand: \"npm test\"",
			details: { pid: 321, command: "npm test", exitCode: 0 } },
		{ role: "user", content: "Background task 'tests' (12345678-1234-1234-1234-123456789abc) completed with exit code 0. Inspect receipt /tmp/task/state.json and logs." },
	] });
	const conversations = [...document.querySelectorAll(".conversation-message")];
	const bash = conversations.find((row) => row.textContent.includes("npm test"));
	const task = conversations.find((row) => row.textContent.includes("Background task 'tests'"));
	check("async bash completion is a conversation bubble", !!bash?.querySelector(".conversation-bubble") && bash.textContent.includes("completed"));
	check("background task completion is a conversation bubble", !!task?.querySelector(".conversation-bubble") && task.textContent.includes("completed"));
	check("bash and background tasks use distinct neutral icons", !!bash?.querySelector(".conversation-avatar-tool svg") && !!task?.querySelector(".conversation-avatar-tool svg") && bash.querySelector("svg path").getAttribute("d") !== task.querySelector("svg path").getAttribute("d"));
	check("tool avatars do not repeat initials", bash?.querySelector(".conversation-avatar")?.textContent === "" && task?.querySelector(".conversation-avatar")?.textContent === "");
}

// Identity comes from the sender, not its model or a name that resembles a tool.
{
	const agent = (sessionName, model) => ({ role: "custom", customType: "agent_message", display: true,
		content: "Review complete", details: { message: "Review complete", from: { sessionId: sessionName, sessionName, model } } });
	hostMessage({ type: "snapshot", state: null, status: baseStatus, messages: [
		agent("hybrid-views", "same-model"), agent("tab-tests", "same-model"), agent("hybrid-views", "other-model"), agent("bash", "same-model"),
		{ role: "bashExecution", command: "echo ready", output: "ready", exitCode: 0 },
		{ role: "custom", customType: "notification", display: true, content: "Background task 'build' (12345678-1234-1234-1234-123456789abc) failed with exit code 1." },
	] });
	const avatars = [...document.querySelectorAll(".conversation-avatar")];
	const hue = (i) => avatars[i].style.getPropertyValue("--conversation-hue");
	check("same-model agents get sender-specific colors", hue(0) !== hue(1));
	check("sender color stays stable across model changes", hue(0) === hue(2));
	check("an agent named bash still has an initials avatar", avatars[3].textContent === "B" && !avatars[3].querySelector("svg"));
	check("bash history and custom background notifications use tool icons", avatars.slice(4).length === 2 && avatars.slice(4).every((avatar) => avatar.matches(".conversation-avatar-tool") && avatar.querySelector("svg")));
}

// Runtime queue previews stay separate from inputs already in the conversation.
{
	const actions = { queuedCount: 2, steering: ["review <script>unsafe</script>"], followUps: ["run final tests"] };
	hostMessage({ type: "snapshot", messages: [], state: { sessionActions: actions }, status: baseStatus });
	const queue = document.querySelector(".pending-inputs");
	check("snapshot restores pending inputs outside durable transcript", !queue.hidden && queue.querySelectorAll(".pending-input").length === 2 && !queue.closest(".messages"));
	check("pending inputs distinguish next-turn from after-run delivery", queue.textContent.includes("Next turn") && queue.textContent.includes("After run"));
	check("queue previews are plain text", !queue.querySelector("script") && queue.textContent.includes("<script>unsafe</script>"));
	queue.open = false;
	hostMessage({ type: "event", event: { type: "session_action_update", actions } });
	check("queue updates replace previews without duplicating or reopening", queue.querySelectorAll(".pending-input").length === 2 && !queue.open);
	hostMessage({ type: "event", event: { type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "preparing", label: "run final tests" } } } });
	check("selected input remains visible as Delivering, not read", !queue.hidden && queue.textContent.includes("Delivering"));
	hostMessage({ type: "event", event: { type: "message_start", message: { role: "user", content: "run final tests" } } });
	check("conversation arrival does not guess queue identity from text", !queue.hidden && document.querySelector(".row-user")?.textContent.includes("run final tests"));
	hostMessage({ type: "event", event: { type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running", label: "run final tests" } } } });
	check("runtime running phase retires pending strip and keeps conversation", queue.hidden && document.querySelector(".row-user")?.textContent.includes("run final tests"));
	hostMessage({ type: "event", event: { type: "session_action_update", actions } });
	hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
	check("agent_end does not falsely consume queued follow-ups", !queue.hidden);
	hostMessage({ type: "snapshot", messages: [], state: null, status: baseStatus });
	check("resync replaces stale queue even in the same session", queue.hidden);
	hostMessage({ type: "event", event: { type: "session_action_update", actions } });
	hostMessage({ type: "status", status: { ...baseStatus, sessionId: "queue-other" } });
	check("session switch clears pending inputs", queue.hidden);
	hostMessage({ type: "observedSession", sessionId: "watched", messages: [] });
	hostMessage({ type: "observedEvent", sessionId: "watched", event: { type: "session_action_update", actions } });
	check("observed session receives its own queue updates", !queue.hidden);
	hostMessage({ type: "observedEvent", sessionId: "old-watched", event: { type: "session_action_update" } });
	check("late observed queue event cannot change the current view", !queue.hidden);
	hostMessage({ type: "newThread" });
	check("new thread clears pending inputs", queue.hidden);
	hostMessage({ type: "snapshot", messages: [], state: null, status: baseStatus });
}

// The active-session indicator stays after notifications, not between senders.
{
	hostMessage({ type: "snapshot", state: null, status: baseStatus, messages: [] });
	hostMessage({ type: "event", event: { type: "agent_start" } });
	const working = document.querySelector(".working-row");
	for (const message of [
		{ role: "custom", customType: "agent_message", display: true, content: "Done", details: { message: "Done", from: { sessionName: "tab-tests", sessionId: "child" } } },
		{ role: "custom", customType: "async_bash_completion", display: true, content: "Command completed", details: { pid: 1, exitCode: 0 } },
		{ role: "user", content: "Background task 'tests' (12345678-1234-1234-1234-123456789abc) completed with exit code 0." },
	]) {
		hostMessage({ type: "event", event: { type: "message_start", message } });
		hostMessage({ type: "event", event: { type: "message_end", message } });
	}
	const rows = [...working.parentElement.children];
	check("inserted notifications stay above Working", [...document.querySelectorAll(".conversation-message")].every((row) => rows.indexOf(row) < rows.indexOf(working)));
	check("notifications preserve the Working element and timer", document.querySelector(".working-row") === working);
	check("Working belongs to the session, not a sender bubble", !working.closest(".conversation-message"));
	hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
	check("the indicator retires when the session run ends", !document.querySelector(".working-row"));
}

// --- the usage line must not appear under a reply still being written --------
// renderSnapshot repaints EVERY message as non-partial, so a snapshot arriving
// mid-turn used to stamp a token/cost line under the live reply, which its next
// delta removed again. A row growing and shrinking many times a second reads as
// the whole transcript juddering.
{
	const live = {
		role: "assistant", model: "kimi",
		content: [{ type: "text", text: "still writing this" }],
		usage: { totalTokens: 1234, cost: { total: 0.0021 } },
	};
	hostMessage({ type: "snapshot", messages: [{ role: "user", content: "go" }, live], state: null, status: baseStatus });
	check("a snapshot of an unfinished reply shows no token line", !document.querySelector(".usage-line"),
		document.querySelector(".usage-line")?.textContent);

	// The same message still streaming: still nothing.
	hostMessage({ type: "event", event: { type: "message_update", message: { ...live, content: [{ type: "text", text: "still writing this more" }] } } });
	check("a delta on an unfinished reply shows no token line", !document.querySelector(".usage-line"));

	// A second snapshot mid-flight — this is the exact flicker cycle.
	hostMessage({ type: "snapshot", messages: [{ role: "user", content: "go" }, live], state: null, status: baseStatus });
	check("a repeated mid-turn snapshot still shows no token line", !document.querySelector(".usage-line"));

	// Finished: stopReason is the honest signal that the numbers are final.
	const done = { ...live, stopReason: "stop" };
	hostMessage({ type: "snapshot", messages: [{ role: "user", content: "go" }, done], state: null, status: baseStatus });
	const usage = document.querySelector(".usage-line");
	check("a finished reply does show its tokens and cost", !!usage && /1\.2k tokens/.test(usage.textContent) && usage.textContent.includes("$0.0021"),
		usage?.textContent);

	// A failed reply has no stopReason of its own but is equally final.
	const failed = { role: "assistant", model: "kimi", content: [], errorMessage: "provider exploded" };
	hostMessage({ type: "snapshot", messages: [{ role: "user", content: "go" }, failed], state: null, status: baseStatus });
	check("a failed reply still reports why", /provider exploded/.test(document.querySelector(".usage-line")?.textContent ?? ""),
		document.querySelector(".usage-line")?.textContent);
}

// --- auto-expanding the strip when a subagent starts -------------------------
// The value is the moment work begins; every other rule here exists so it never
// fights the operator. A host-confirmed thread boundary resets the strip.
// Requesting a new editor tab must leave the source document intact.
{
	const kid = (id, name, streaming, status) => ({
		id: `uuid-${id}`, activeSessionId: id, browseRef: `ref-${id}`, name,
		runtimeKind: "subagent", rlmDepth: 1, isStreaming: streaming, status, attachedClients: 0,
	});
	const roster = (children, spawned) => hostMessage({ type: "sessionChildren", children, ...(spawned ? { spawned } : {}) });
	const expanded = () => !!document.querySelector(".subagents-strip .subagent-row");
	const header = () => document.querySelector(".subagents-strip .subagents-header");
	// Guarded: a selector that silently stops matching would reset nothing and
	// make every check below pass for the wrong reason.
	const newChatBtn = document.querySelector('button[title="New session"]');
	check("the New session control is reachable for these fixtures", !!newChatBtn);
	const freshThread = () => hostMessage({ type: "newThread" });
	const sourceTranscript = document.querySelector(".messages").innerHTML;
	hostMessage({ type: "draft", text: "keep this source draft", sessionId: baseStatus.sessionId });
	const sourceInput = document.querySelector("textarea");
	const sourceDraft = sourceInput.value;
	const sourceDisabled = sourceInput.disabled;
	const beforeNew = posted.length;
	newChatBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("New session requests a native tab", posted.slice(beforeNew).some((m) => m.type === "newSession"));
	check("New session preserves source transcript", document.querySelector(".messages").innerHTML === sourceTranscript);
	check("New session preserves source draft and composer state", sourceDraft === "keep this source draft" && sourceInput.value === sourceDraft && sourceInput.disabled === sourceDisabled);

	// Resuming a thread that already has live subagents is not activity.
	freshThread();
	roster([kid("aaaa00000001", "already-running", true, "running")]);
	check("a resumed roster does not force the strip open", !expanded());

	// ...but the next one to start does.
	roster([kid("aaaa00000001", "already-running", true, "running"), kid("aaaa00000002", "just-spawned", true, "running")],
		[{ activeSessionId: "aaaa00000002", browseRef: "ref-aaaa00000002", name: "just-spawned" }]);
	check("a subagent that spawns opens a collapsed strip", expanded());

	// Nothing auto-collapses: a finished subagent leaves the strip as it was.
	roster([kid("aaaa00000001", "already-running", false, "inactive"), kid("aaaa00000002", "just-spawned", true, "running")]);
	check("a subagent finishing never closes the strip", expanded());

	// A re-activation counts too: idle -> running with no spawn record.
	freshThread();
	roster([kid("bbbb00000001", "waiting", false, "idle")]);
	check("an idle roster leaves a collapsed strip alone", !expanded());
	roster([kid("bbbb00000001", "waiting", true, "running")]);
	check("a subagent going back to work opens the strip", expanded());

	// Collapsing by hand is an instruction, and it is respected.
	freshThread();
	roster([kid("cccc00000001", "one", false, "idle")]);
	header().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("the header still expands by hand", expanded());
	header().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("the header still collapses by hand", !expanded());
	roster([kid("cccc00000001", "one", false, "idle"), kid("cccc00000002", "two", true, "running")],
		[{ activeSessionId: "cccc00000002", browseRef: "ref-cccc00000002", name: "two" }]);
	check("a spawn does not reopen a strip the operator shut", !expanded());

	// A new thread carries no instruction from the last one.
	freshThread();
	roster([kid("dddd00000001", "seed", false, "idle")]);
	roster([kid("dddd00000001", "seed", false, "idle"), kid("dddd00000002", "fresh", true, "running")],
		[{ activeSessionId: "dddd00000002", browseRef: "ref-dddd00000002", name: "fresh" }]);
	check("a new thread starts auto-expanding again", expanded());

	// Inside a subagent the strip is the way back out — never open it under them.
	freshThread();
	roster([kid("eeee00000001", "seed", false, "idle")]);
	hostMessage({
		type: "sessionChildren",
		children: [kid("eeee00000002", "grandchild", true, "running")],
		parent: { id: "uuid-parent", activeSessionId: "parent000001", name: "the-parent" },
		viewedActiveSessionId: "eeee00000001",
		spawned: [{ activeSessionId: "eeee00000002", browseRef: "ref-eeee00000002", name: "grandchild" }],
	});
	check("browsing inside a subagent keeps the strip as the operator left it", !expanded());
	check("the way back out is still rendered", !!document.querySelector(".subagents-strip .subagents-back-row"));

	freshThread();
}

// --- a notice can carry a one-shot recovery ---------------------------------
posted.length = 0;
hostMessage({ type: "notice", level: "error", text: "Compaction failed: refused.",
	action: { id: "9f1c2b7a-0000-4a11-9c3d-abcdefabcdef", label: "Compact with Roomy" } });
{
	const btn = [...document.querySelectorAll(".notice .notice-action")].find((b) => b.textContent === "Compact with Roomy");
	check("a notice action renders as a button", !!btn);
	btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("clicking it posts the host's id back verbatim",
		posted.some((m) => m.type === "noticeAction" && m.id === "9f1c2b7a-0000-4a11-9c3d-abcdefabcdef"),
		JSON.stringify(posted.slice(-2)));
	check("the notice retires once its action is taken",
		![...document.querySelectorAll(".notice .notice-action")].some((b) => b.textContent === "Compact with Roomy"));
}
// Dismissing goes through the same retire path that gives the tail back, and
// retiring something already gone must be harmless (auto-dismiss can race a click).
{
	hostMessage({ type: "notice", level: "warning", text: "dismiss me please" });
	const note = [...document.querySelectorAll(".notice")].find((n) => n.textContent.includes("dismiss me please"));
	check("a notice renders with a dismiss control", !!note?.querySelector(".notice-dismiss"));
	note.querySelector(".notice-dismiss").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("dismissing removes the notice", !document.body.textContent.includes("dismiss me please"));
	// Second click on the detached node: the guard must swallow it.
	note.querySelector(".notice-dismiss").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("retiring an already-removed notice is harmless", !document.body.textContent.includes("dismiss me please"));
}

hostMessage({ type: "notice", level: "error", text: "Plain failure, nothing to offer." });
check("a notice without an action renders no button",
	[...document.querySelectorAll(".notice")].slice(-1)[0]?.querySelector(".notice-action") === null);

// Toasts overlay the thread instead of sitting above it in flow. As a flow
// sibling each one shortened the scroller by its own height, which pushed the
// tail out from under a reader following it — worst when opening a subagent,
// where the notice and the new thread arrive together.
{
	const dock = document.querySelector(".notices-dock");
	check("the notice stack lives in its own dock", !!dock && dock.querySelector(".notices") !== null);
	check("every notice renders inside that dock",
		[...document.querySelectorAll(".notice")].every((note) => dock.contains(note)));
	const children = [...document.querySelector("#app").children];
	check("the dock sits above the views, so toasts land over the thread",
		children.indexOf(dock) < children.indexOf(document.querySelector(".chat-view")));
	check("the persistent banners stay above the dock, never covered by a toast",
		children.indexOf(document.querySelector(".install-banner")) < children.indexOf(dock));
}

// --- a parent with working subagents is not idle ---------------------------
// The parent's own turn really has ended, so `streaming` stays false and every
// control keeps its honest meaning. Reading plain "live" beside working
// subagents said the run had died when it had not.
{
	hostMessage({ type: "status", status: { ...baseStatus, streaming: false } });
	hostMessage({ type: "sessionChildren", children: [
		{ id: "w-1", activeSessionId: "dddd4444", name: "worker-one", runtimeKind: "subagent", rlmDepth: 1, status: "running", isStreaming: true, attachedClients: 0 },
		{ id: "w-2", activeSessionId: "dddd4445", name: "worker-two", runtimeKind: "subagent", rlmDepth: 1, status: "idle", isStreaming: false, attachedClients: 0 },
	] });
	const label = document.querySelector(".live-label");
	check("an idle parent reports the subagents still working for it",
		label.textContent === "working · 1 subagent working", label.textContent);
	check("...and the connection dot uses the working session lamp",
		document.querySelector(".conn-dot").className.includes("working"),
		document.querySelector(".conn-dot").className);
	// Plural, and repainted from the roster alone — no status push follows one.
	hostMessage({ type: "sessionChildren", children: [
		{ id: "w-1", activeSessionId: "dddd4444", name: "worker-one", runtimeKind: "subagent", rlmDepth: 1, status: "running", isStreaming: true, attachedClients: 0 },
		{ id: "w-2", activeSessionId: "dddd4445", name: "worker-two", runtimeKind: "subagent", rlmDepth: 1, status: "running", isStreaming: true, attachedClients: 0 },
	] });
	check("the roster alone repaints the count", document.querySelector(".live-label").textContent === "working · 2 subagents working",
		document.querySelector(".live-label").textContent);
	// The parent's own run outranks the note: "running" already says it is working.
	hostMessage({ type: "status", status: { ...baseStatus, streaming: true } });
	check("a streaming parent still just says running", document.querySelector(".live-label").textContent === "running",
		document.querySelector(".live-label").textContent);
	hostMessage({ type: "status", status: { ...baseStatus, streaming: false } });
	hostMessage({ type: "sessionChildren", children: [] });
	check("no working subagents, no note", document.querySelector(".live-label").textContent === "live",
		document.querySelector(".live-label").textContent);
}

// --- derived row label for an unnamed session ---
// A first prompt is very often a pasted block. Rendered raw it arrives as one
// run-on smear ("...HANDOFF.md first.Now for your ultimate mission:# HANDOFF"),
// which is what made a real session unidentifiable in the list.
hostMessage({ type: "history", sessions: [
	{ path: "/tmp/pasted.jsonl", id: "pasted-1", cwd: "/Users/dev/ai-secpipe", timestamp: new Date().toISOString(),
	  firstPrompt: "Written to `/Users/dev/ai-secpipe/HANDOFF.md` first.\n\nNow for your ultimate mission:\n\n# HANDOFF\n\nrest of the brief", inWorkspace: true },
	{ path: "/tmp/heading.jsonl", id: "heading-1", cwd: "/Users/dev/ai-secpipe", timestamp: new Date().toISOString(),
	  firstPrompt: "   \n\n## Ship the release gate\n\nand then do the rest", inWorkspace: true },
	{ path: "/tmp/blank.jsonl", id: "blank-1", cwd: "/Users/dev/ai-secpipe", timestamp: new Date().toISOString(),
	  firstPrompt: "\n\n   \n", inWorkspace: true },
	{ path: "/tmp/verylong.jsonl", id: "long-1", cwd: "/Users/dev/ai-secpipe", timestamp: new Date().toISOString(),
	  firstPrompt: `${"word ".repeat(60)}end`, inWorkspace: true },
] });
{
	const labelOf = (id) => [...document.querySelectorAll(".history-item")]
		.map((row) => row.querySelector(".history-item-name")?.textContent ?? "")
		.find((text) => text.includes(id)) ?? "";
	const names = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
	check("a pasted prompt labels from its first meaningful line",
		names.some((n) => n === "Written to `/Users/dev/ai-secpipe/HANDOFF.md` first."), JSON.stringify(names.slice(0, 4)));
	check("no label runs two lines together",
		!names.some((n) => /first\.Now|:#/.test(n)), JSON.stringify(names.slice(0, 4)));
	check("a leading markdown heading loses its ornament",
		names.some((n) => n === "Ship the release gate"), JSON.stringify(names.slice(0, 4)));
	check("an all-whitespace prompt falls back to a placeholder",
		names.some((n) => n === "(untitled session)"), JSON.stringify(names.slice(0, 4)));
	const long = names.find((n) => n.startsWith("word word"));
	check("a very long line is cut on a word boundary", !!long && long.length <= 81 && long.endsWith("\u2026") && !long.includes("wor\u2026"),
		JSON.stringify(long));
}
// Put the shared fixture back: `history` replaces the list wholesale, and the
// checks below this point look for rows it defines.
hostMessage({ type: "history", sessions: [
	{ id: "hist-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
] });

// --- history row pencil rename ---
posted.length = 0;
const hRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("local chat"));
const pencil = [...hRow.querySelectorAll(".history-action")].find((b) => b.title === "Rename session");
check("history row has pencil action", !!pencil);
pencil.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const renameInput = hRow.querySelector(".history-rename-input");
check("history rename input appears", !!renameInput);
check("history rename input is not inside a button", !renameInput.closest("button"));
renameInput.value = "local-chat-updated";
renameInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("enter posts renameHistorySession", posted.some((m) => m.type === "renameHistorySession" && m.sessionId === "hist-a" && m.name === "local-chat-updated"), "payload=" + JSON.stringify(posted.filter((m) => m.type === "renameHistorySession")));

// --- model pill truncation + hover shows full name ---
hostMessage({ type: "status", status: { ...baseStatus, modelLabel: "chutes/Qwen/Qwen3-235B-A22B-Thinking-2507-TEE" } });
const pillLabel = document.querySelector(".rail-pill.model .pill-label");
check("model pill truncates tastefully mid-path", pillLabel.textContent === "chutes/…/Qwen3-235B-A22B-Thinking-2507-TEE", pillLabel.textContent);
check("model pill full name on hover", document.querySelector(".rail-pill.model").title.includes("chutes/Qwen/Qwen3-235B-A22B-Thinking-2507-TEE"));
{
	const observer = new window.MutationObserver(() => {});
	observer.observe(pillLabel, { childList: true });
	const originalText = pillLabel.firstChild;
	for (let i = 0; i < 3; i++) {
		hostMessage({ type: "status", status: { ...baseStatus, modelLabel: "chutes/Qwen/Qwen3-235B-A22B-Thinking-2507-TEE" } });
	}
	const addedTextNodes = observer.takeRecords().reduce((count, record) => count + record.addedNodes.length, 0);
	observer.disconnect();
	check("identical long model labels cause zero text replacements", addedTextNodes === 0, `${addedTextNodes} replacements for 3 status updates`);
	check("identical long model labels preserve text node identity", pillLabel.firstChild === originalText);
	hostMessage({ type: "status", status: { ...baseStatus, modelLabel: "renamed-model" } });
	check("changed label with same model identity still updates", pillLabel.textContent === "renamed-model" && document.querySelector(".rail-pill.model").title.includes("renamed-model"));
	hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "renamed-model" } });
	check("changed model identity with same label refreshes capabilities", document.querySelector(".rail-pill.brain").disabled);
	hostMessage({ type: "status", status: baseStatus });
}


// --- history search ranking: exact beats tokens beats fuzzy; recency breaks ties ---
hostMessage({
	type: "history",
	sessions: [
		{ id: "r1", path: "/tmp/r1.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 4000).toISOString(), modifiedMs: Date.now() - 4000, name: "ray button setup", inWorkspace: true },
		{ id: "r2", path: "/tmp/r2.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "ray tracing demo", inWorkspace: true },
		{ id: "r3", path: "/tmp/r3.jsonl", cwd: "/other", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "totally different topic", inWorkspace: false },
	],
});
document.querySelector(".history-search").value = "ray";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
const rNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("exact/tokens results keep bucket order, recency breaks ties", rNames[0] === "ray tracing demo" && rNames[1] === "ray button setup", rNames.join("|"));
check("non-matching entries filtered", rNames.length === 2);

// --- inline mentions: mirror styles typed tokens; folders accepted with trailing slash ---
hostMessage({ type: "fileSearchResults", requestId: 0, files: [] }); // no-op staleness guard
textarea.value = "";
textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
// typed token styles via mirror (mirror replaces textarea's visible text)
textarea.value = "see @media/main.css and @webview/ please";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const mms = document.querySelectorAll(".composer-mirror .mm");
check("typed mentions styled in mirror", mms.length === 2 && mms[0].textContent === "@media/main.css" && mms[1].textContent === "@webview/");
check("folder token styles with trailing slash", [...mms].some((m) => m.textContent.endsWith("/")));
// typed text stays intact for send
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const sentPrompt = posted.find((m) => m.type === "prompt");
check("send keeps inline @text intact", !!sentPrompt && sentPrompt.payload.text.includes("@media/main.css") && sentPrompt.payload.text.includes("@webview/"));

// folder via the autocomplete: dir row gets trailing slash + dir class
textarea.value = "@web";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const req2 = posted.filter((m) => m.type === "searchFiles").at(-1);
check("mention query posts searchFiles", !!req2 && req2.query === "web");
posted.length = 0;
hostMessage({
	type: "fileSearchResults",
	requestId: req2.requestId,
	files: [
		{ path: "webview", isDir: true },
		{ path: "webview/main.ts", isDir: false },
	],
});
const dirRow = [...document.querySelectorAll(".ac-item")].find((r) => r.textContent.includes("webview/"));
check("folder row shows trailing slash + dir class", !!dirRow && dirRow.classList.contains("dir") && dirRow.querySelector(".ac-label").textContent === "webview/");
posted.length = 0;
dirRow.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
check("folder accepted with trailing slash", textarea.value.includes("@webview/"));
check("mirror styles folder token", [...document.querySelectorAll(".composer-mirror .mm")].some((m) => m.textContent === "@webview/"));
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const prompt2 = posted.find((m) => m.type === "prompt");
check("folder mention sent inline", !!prompt2 && prompt2.payload.text.includes("@webview/"));

// --- mentions the pattern alone cannot recognise (#19: it must LOOK selected) ---
posted.length = 0;
textarea.value = "@LICE";
textarea.selectionStart = textarea.selectionEnd = 5;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const reqLic = posted.filter((m) => m.type === "searchFiles").at(-1);
hostMessage({ type: "fileSearchResults", requestId: reqLic.requestId, files: [{ path: "LICENSE", isDir: false }] });
[...document.querySelectorAll(".ac-item")][0].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
check("extensionless mention pilled once accepted", [...document.querySelectorAll(".composer-mirror .mm")].some((m) => m.textContent === "@LICENSE"), textarea.value);
// A workspace filename is host input. Quotes in an accepted path must not end
// the mirror's data-path attribute when its highlighted HTML is rebuilt.
posted.length = 0;
textarea.value = "@quoted";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const reqQuoted = posted.filter((m) => m.type === "searchFiles").at(-1);
const quotedPath = 'quoted" data-injected="yes';
hostMessage({ type: "fileSearchResults", requestId: reqQuoted.requestId, files: [{ path: quotedPath, isDir: false }] });
document.querySelector(".ac-item").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
const quotedMention = document.querySelector(".composer-mirror .mm");
check("quoted mention keeps its complete path in data-path", quotedMention?.dataset.path === quotedPath, quotedMention?.outerHTML ?? "<none>");
check("quoted mention cannot inject a mirror attribute", !quotedMention?.hasAttribute("data-injected"), quotedMention?.outerHTML ?? "<none>");
textarea.value = "look at @.github/workflows/publish.yml now";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
check("dot-prefixed path styles", [...document.querySelectorAll(".composer-mirror .mm")].some((m) => m.textContent === "@.github/workflows/publish.yml"));
textarea.value = "ping @bob about it";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
check("bare @word is never a mention", document.querySelectorAll(".composer-mirror .mm").length === 0);

// --- a mention search with no matches must disarm the panel, not swallow Enter ---
posted.length = 0;
textarea.value = "explain @zzzmissing";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const reqMiss = posted.filter((m) => m.type === "searchFiles").at(-1);
hostMessage({ type: "fileSearchResults", requestId: reqMiss.requestId, files: [] });
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("zero-result mention does not swallow Enter", posted.some((m) => m.type === "prompt"), JSON.stringify(posted.map((m) => m.type)));

// --- `+` -> "Mention a file in chat" mid-sentence: needs a separator or nothing opens ---
textarea.value = "review the changes in";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
posted.length = 0;
const plusBtn = [...document.querySelectorAll(".composer-rail .icon-btn")].find((b) => b.title.startsWith("Attach"));
plusBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
[...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("Mention a file")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("+ mention inserts a separated @", textarea.value === "review the changes in @", JSON.stringify(textarea.value));
check("+ mention opens the file search", posted.some((m) => m.type === "searchFiles"), JSON.stringify(posted.map((m) => m.type)));
textarea.value = "";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));

// --- sticky drafts are per thread: an empty payload CLEARS, it is not "no news" ---
hostMessage({ type: "draft", text: "remember to check the retry path" });
check("draft restored into the composer", textarea.value === "remember to check the retry path", textarea.value);
hostMessage({ type: "draft", text: "" });
check("empty draft clears the box so it can't follow into the next thread", textarea.value === "", textarea.value);

// --- A host-confirmed session boundary owns the entire unsent composer state.
// A status can arrive ahead of its replacement snapshot, so exercise both
// message shapes. No stale draft timer, optimistic rejection, attachment, picker,
// or file-search response may cross from A into B/C.
const boundaryStatusA = { ...baseStatus, sessionId: "session-boundary-a", sessionName: "boundary A" };
const boundaryStatusB = { ...baseStatus, sessionId: "session-boundary-b", sessionName: "boundary B" };
const boundaryStatusC = { ...baseStatus, sessionId: "session-boundary-c", sessionName: "boundary C" };
hostMessage({ type: "status", status: boundaryStatusA });
posted.length = 0;
textarea.value = "old optimistic prompt";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const oldSessionPrompt = posted.find((m) => m.type === "prompt");
textarea.value = "@old-session-file";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const oldSessionSearch = posted.filter((m) => m.type === "searchFiles").at(-1);
hostMessage({ type: "fileSearchResults", requestId: oldSessionSearch.requestId, files: [{ path: "src/old-session.ts", isDir: false }] });
const oldSessionImageRequest = requestImageFromPicker();
hostMessage({ type: "imagePicked", requestId: oldSessionImageRequest.requestId, images: [{ data: "aGk=", mimeType: "image/png", name: "old-session.png" }] });
hostMessage({ type: "insertSelection", selection: { path: "src/old-session.ts", startLine: 1, endLine: 2, text: "old", languageId: "typescript" } });
const boundaryModelBtn = document.querySelector(".rail-pill.model");
boundaryModelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("session-boundary setup has stale chips, autocomplete, and a picker", document.querySelectorAll(".composer-chips .compose-chip").length === 2 && document.querySelector(".autocomplete.visible") && document.querySelector(".dropdown"));
hostMessage({ type: "status", status: boundaryStatusB });
check("status boundary clears unsent text and attachments", textarea.value === "" && document.querySelectorAll(".composer-chips .compose-chip").length === 0,
	`text=${JSON.stringify(textarea.value)} chips=${document.querySelectorAll(".composer-chips .compose-chip").length}`);
check("status boundary closes stale autocomplete and picker", !document.querySelector(".autocomplete.visible") && !document.querySelector(".dropdown"));
hostMessage({ type: "imagePicked", requestId: oldSessionImageRequest.requestId, images: [{ data: "aGk=", mimeType: "image/png", name: "stale-session.png" }] });
check("old image picker result is ignored after a session boundary", document.querySelectorAll(".composer-chips .compose-chip.image").length === 0);
hostMessage({ type: "fileSearchResults", requestId: oldSessionSearch.requestId, files: [{ path: "src/stale-response.ts", isDir: false }] });
check("old file-search result is ignored after status boundary", !document.querySelector(".autocomplete.visible") && !document.querySelector(".ac-item"));
hostMessage({ type: "promptRejected", error: "old session rejected", clientRequestId: oldSessionPrompt?.payload?.clientRequestId });
check("old optimistic rejection cannot restore a draft into the new session", textarea.value === "", textarea.value);
await new Promise((resolve) => setTimeout(resolve, 350));
check("cancelled old draft debounce cannot write into the new session", !posted.some((m) => m.type === "draftChanged" && m.text === "@old-session-file"), JSON.stringify(posted.filter((m) => m.type === "draftChanged")));

textarea.value = "@snapshot-session-file";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const snapshotSessionSearch = posted.filter((m) => m.type === "searchFiles").at(-1);
hostMessage({ type: "fileSearchResults", requestId: snapshotSessionSearch.requestId, files: [{ path: "src/snapshot-session.ts", isDir: false }] });
const snapshotImageRequest = requestImageFromPicker();
hostMessage({ type: "imagePicked", requestId: snapshotImageRequest.requestId, images: [{ data: "aGk=", mimeType: "image/png", name: "snapshot-session.png" }] });
hostMessage({ type: "insertSelection", selection: { path: "src/snapshot-session.ts", startLine: 3, endLine: 4, text: "snapshot", languageId: "typescript" } });
boundaryModelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
hostMessage({ type: "snapshot", messages: [], state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" }, status: boundaryStatusC });
check("snapshot boundary clears all composer-local session state", textarea.value === "" && document.querySelectorAll(".composer-chips .compose-chip").length === 0 && !document.querySelector(".autocomplete.visible") && !document.querySelector(".dropdown"));
hostMessage({ type: "fileSearchResults", requestId: snapshotSessionSearch.requestId, files: [{ path: "src/stale-snapshot-response.ts", isDir: false }] });
check("old file-search result is ignored after snapshot boundary", !document.querySelector(".autocomplete.visible") && !document.querySelector(".ac-item"));

// --- The slash catalog must survive a session boundary.
// resetForSessionBoundary() discards it with the rest of the composer's
// per-session state, and the host only volunteers it in answer to `ready` —
// once per webview. Without a re-request, "/" opened an empty menu in every
// thread after the first one this panel showed.
hostMessage({ type: "commands", commands: [
	{ name: "compact", description: "Compact the context" },
	{ name: "security-pipeline", description: "Run the security review" },
] });
const slashItems = () => {
	textarea.value = "/";
	textarea.selectionStart = textarea.selectionEnd = 1;
	textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
	return [...document.querySelectorAll(".ac-item")].map((item) => item.textContent.trim());
};
const listed = slashItems();
check("slash menu lists /login", listed.some((item) => item.startsWith("/login")));
check("slash menu lists UI commands before the agent's catalog",
	listed[0]?.startsWith("/model") && listed.some((item) => item.startsWith("/effort")) && listed.some((item) => item.startsWith("/stash")) && listed.some((item) => item.startsWith("/new")),
	JSON.stringify(listed));
check("slash menu still lists the agent's commands", listed.some((item) => item.startsWith("/compact")) && listed.some((item) => item.includes("security-pipeline")), JSON.stringify(listed));
posted.length = 0;
hostMessage({ type: "status", status: { ...baseStatus, sessionId: "session-boundary-slash", sessionName: "slash" } });
check("a session boundary re-requests the slash catalog it just discarded",
	posted.some((message) => message.type === "requestCommands"),
	JSON.stringify(posted.map((message) => message.type)));
hostMessage({ type: "commands", commands: [
	{ name: "compact", description: "Compact the context" },
	{ name: "security-pipeline", description: "Run the security review" },
] });
const resumed = slashItems();
check("the slash menu works again in the resumed thread",
	resumed.some((item) => item.startsWith("/compact")) && resumed.some((item) => item.startsWith("/model")),
	JSON.stringify(resumed));
textarea.value = "";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));

// --- /model /effort intercept the composer instead of prompting; /stash parks the draft ---
hostMessage({
	type: "models",
	models: [
		{ provider: "chutes", id: "kimi", contextWindow: 262144, reasoning: true, input: ["text", "image"] },
		{ provider: "chutes", id: "glm", contextWindow: 131072, reasoning: false, input: ["text"] },
		{ provider: "openai", id: "gpt-5", contextWindow: 400000, reasoning: true, input: ["text", "image"] },
	],
});
hostMessage({ type: "status", status: { ...baseStatus, availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "max"] } });

textarea.value = "keep this draft";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.value = "/stash";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("/stash parks the draft and clears the composer", textarea.value === "", JSON.stringify(textarea.value));
check("/stash does not send a prompt", !posted.some((m) => m.type === "prompt"));
check("/stash hint is shown", (document.querySelector(".composer-hint")?.textContent ?? "").includes("Stashed"));
textarea.value = "/stash";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("/stash restores the parked draft", textarea.value === "keep this draft", JSON.stringify(textarea.value));
check("restoring stash does not prompt", !posted.some((m) => m.type === "prompt"));

textarea.value = "draft before model";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.value = "/model";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
posted.length = 0;
const modelSlashRow = [...document.querySelectorAll(".ac-item")].find((row) => row.textContent.startsWith("/model"));
check("/ lists /model as a local command", !!modelSlashRow, JSON.stringify([...document.querySelectorAll(".ac-item")].map((row) => row.textContent)));
modelSlashRow.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
const modelDrop = document.querySelector(".dropdown");
check("accepting /model opens the model menu", !!modelDrop && !!modelDrop.querySelector(".dropdown-search"));
check("model search box has keyboard focus", document.activeElement === modelDrop.querySelector(".dropdown-search"));
check("/model does not prompt", !posted.some((m) => m.type === "prompt"));
check("/model stashes the prior draft out of the composer", textarea.value === "", JSON.stringify(textarea.value));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("ArrowDown+Enter picks a model from /model", posted.some((m) => m.type === "setModel"), JSON.stringify(posted.map((m) => m.type)));
check("picking a model restores the stashed draft", textarea.value === "draft before model", JSON.stringify(textarea.value));
check("model menu closed after keyboard select", !document.querySelector(".dropdown"));

textarea.value = "/model glm";
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("/model glm sets the model without a picker", posted.some((m) => m.type === "setModel" && m.modelId === "glm") && !document.querySelector(".dropdown"), JSON.stringify(posted));
check("/model glm restores the prior draft", textarea.value === "draft before model", JSON.stringify(textarea.value));

textarea.value = "/effort";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const effortDrop = document.querySelector(".dropdown");
check("/effort opens the thinking menu", !!effortDrop && (effortDrop.querySelector(".dropdown-header")?.textContent ?? "").startsWith("Thinking"));
check("thinking search box has keyboard focus", document.activeElement === effortDrop.querySelector(".dropdown-search"));
check("/effort does not prompt", !posted.some((m) => m.type === "prompt"));
effortDrop.querySelector(".dropdown-search").value = "high";
effortDrop.querySelector(".dropdown-search").dispatchEvent(new window.Event("input", { bubbles: true }));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("typing a level and Enter sets thinking", posted.some((m) => m.type === "setThinkingLevel" && m.level === "high"), JSON.stringify(posted));
check("/effort restores the stashed draft after pick", textarea.value === "draft before model", JSON.stringify(textarea.value));

textarea.value = "/effort medium";
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("/effort medium sets the level without a picker", posted.some((m) => m.type === "setThinkingLevel" && m.level === "medium") && !document.querySelector(".dropdown"), JSON.stringify(posted));

textarea.value = "keep for next thread";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.value = "/new";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("/new posts newSession instead of a prompt", posted.some((m) => m.type === "newSession") && !posted.some((m) => m.type === "prompt"), JSON.stringify(posted.map((m) => m.type)));
check("/new does not persist the slash as the outgoing draft", !posted.some((m) => m.type === "draftChanged" && m.text === "/new"), JSON.stringify(posted.filter((m) => m.type === "draftChanged")));
check("/new preserves the source tab draft", textarea.value === "keep for next thread", JSON.stringify(textarea.value));

textarea.value = "/new extra args";
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("/new ignores extra args and still starts a session", posted.some((m) => m.type === "newSession") && !posted.some((m) => m.type === "prompt"), JSON.stringify(posted.map((m) => m.type)));

// /login is local, both when typed and selected from autocomplete.
textarea.value = "/login";
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("/login posts only a local login action", posted.filter((m) => m.type === "login").length === 1 && !posted.some((m) => m.type === "prompt"));
check("/login preserves the source draft", textarea.value === "keep for next thread", JSON.stringify(textarea.value));
textarea.value = "/log";
textarea.selectionStart = textarea.selectionEnd = 4;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
posted.length = 0;
document.querySelector(".ac-item")?.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
check("/login autocomplete opens login without prompting", posted.filter((m) => m.type === "login").length === 1 && !posted.some((m) => m.type === "prompt"));

// --- paste image on a text-only model shows a composer hint ---
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
posted.length = 0;
const pasteEvent = new window.Event("paste", { bubbles: true, cancelable: true });
// happy-dom has no DataTransfer-backed ClipboardEvent; inject the shape onPaste reads.
pasteEvent.clipboardData = { files: [{ type: "image/png", name: "shot.png" }] };
textarea.dispatchEvent(pasteEvent);
const pasteHint = document.querySelector(".composer-hint");
check(
	"paste image on text-only model shows hint",
	!!pasteHint && pasteHint.classList.contains("visible") && pasteHint.textContent.includes("text-only"),
	pasteHint?.textContent ?? "<no hint>",
);
check("paste did not post a prompt", !posted.some((m) => m.type === "prompt"));

// --- Native image picker retains tracked position and rejects text-only sends without data loss. ---
posted.length = 0;
hostMessage({ type: "status", status: { ...baseStatus } });
const textOnlyImageRequest = requestImageFromPicker();
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
hostMessage({ type: "imagePicked", requestId: textOnlyImageRequest.requestId, images: [{ data: "aGk=", mimeType: "image/png", name: "pic.png" }] });
check("image pick refused on text-only model", document.querySelectorAll(".composer-chips .attachment-card").length === 0);
check("refusal hint visible", pasteHint.classList.contains("visible") && pasteHint.textContent.includes("text-only"), pasteHint.textContent);
hostMessage({ type: "status", status: { ...baseStatus } });
textarea.value = "with image ";
textarea.dispatchEvent(new window.Event("input"));
textarea.setSelectionRange(textarea.value.length, textarea.value.length);
const visionImageRequest = requestImageFromPicker();
hostMessage({ type: "imagePicked", requestId: visionImageRequest.requestId, images: [{ data: "aGk=", mimeType: "image/png", name: "pic.png" }] });
const createdImage = posted.filter(m => m.type === "createAttachment").at(-1);
check("image picker requests a host-owned temporary image", createdImage?.attachment.kind === "image");
if (createdImage) hostMessage({ type: "attachmentCreated", sessionId: createdImage.sessionId, id: createdImage.attachment.id });
check("image card rendered on vision model", document.querySelectorAll(".composer-chips .attachment-card").length === 1);
const imageDraft = textarea.value;
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("text-only send keeps image draft instead of silently discarding it", !posted.some(m => m.type === "prompt") && textarea.value === imageDraft);
check("send guard explains text-only refusal", pasteHint.classList.contains("visible") && pasteHint.textContent.includes("text-only"), pasteHint.textContent);
check("refused send preserves image card", document.querySelectorAll(".composer-chips .attachment-card").length === 1);
check("refused send has no optimistic image bubble", !document.querySelector(".bubble-images"));
document.querySelector(".composer-chips .attachment-card .chip-remove")?.click();
check("explicit card removal also removes its marker", textarea.value === "with image " && document.querySelectorAll(".composer-chips .attachment-card").length === 0);
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("text-only text sends after explicit image removal", posted.some(m => m.type === "prompt" && m.payload.text === "with image" && m.payload.images.length === 0));
hostMessage({ type: "status", status: { ...baseStatus } });

// --- @-mention chips in user bubbles ---
hostMessage({
	type: "snapshot",
	messages: [
		{ role: "user", content: "edit @src/a.ts now" },
		{ role: "user", content: "mail name@domain.com or see https://x.io/@u/p end" },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: baseStatus,
});
const chips = [...document.querySelectorAll(".mention-chip")];
check("mention chip rendered for @path", chips.length === 1 && chips[0].textContent === "@src/a.ts", `${chips.length} chips`);
check("email and URL do not become chips", document.querySelector(".messages").textContent.includes("name@domain.com"));
posted.length = 0;
chips[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const openFileMsg = posted.find((m) => m.type === "openFile");
check("chip click posts openFile", !!openFileMsg && openFileMsg.path === "src/a.ts", JSON.stringify(openFileMsg));

// --- full-history user ordinals survive transcript windowing ---
const longMessages = Array.from({ length: 100 }, (_, index) => [
	{ role: "user", content: `question ${index}` },
	{ role: "assistant", model: "kimi", content: [{ type: "text", text: `answer ${index}` }] },
]).flat();
hostMessage({
	type: "snapshot",
	messages: longMessages,
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: baseStatus,
});
const windowedUserRows = [...scroller.querySelectorAll(".row-user")];
check("long snapshot renders a bounded user window", windowedUserRows.length < 100 && windowedUserRows.length > 0, String(windowedUserRows.length));
posted.length = 0;
const lastWindowedFork = [...(windowedUserRows.at(-1)?.querySelectorAll(".uf-icon") ?? [])].find((button) => button.title === "Fork the session starting from this message");
lastWindowedFork?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("fork uses the full-session user ordinal after windowing",
	posted.some((m) => m.type === "forkFromUser" && m.ordinal === 99), JSON.stringify(posted));

// --- Prompt rejection must remove only the exact optimistic bubble. Multiple
// queued sends can be settled out of order, so text alone is not a safe key. ---
hostMessage({ type: "snapshot", messages: [], state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" }, status: baseStatus });
posted.length = 0;
textarea.value = "first optimistic prompt";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const firstOptimisticPrompt = posted.find((m) => m.type === "prompt");
textarea.value = "second optimistic prompt";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const secondOptimisticPrompt = posted.filter((m) => m.type === "prompt").at(-1);
check("separate sends carry separate client request ids",
	!!firstOptimisticPrompt?.payload?.clientRequestId &&
		firstOptimisticPrompt?.payload?.clientRequestId !== secondOptimisticPrompt?.payload?.clientRequestId,
	JSON.stringify(posted.filter((m) => m.type === "prompt").map((m) => m.payload.clientRequestId)));
check("two optimistic rows render before either verdict", scroller.querySelectorAll(".row-user").length === 2, String(scroller.querySelectorAll(".row-user").length));
check("send paints a working indicator before the first token", !!scroller.querySelector(".working-row .working-mark") && (scroller.querySelector(".working-label")?.textContent ?? "").length > 0 && !/Sending/.test(scroller.querySelector(".working-label")?.textContent ?? ""), scroller.querySelector(".working-label")?.textContent ?? "none");
const workingLabel = scroller.querySelector(".working-label");
const workingText = workingLabel.firstChild;
check("working icon matches the active model provider", scroller.querySelector(".working-mark .provider-icon")?.innerHTML === document.querySelector(".rail-pill.model .provider-icon")?.innerHTML && scroller.querySelector(".working-mark")?.getAttribute("aria-hidden") === "true");
check("working verb uses plain text for CSS sheen", workingText?.nodeType === 3);
const originalWorkingRow = scroller.querySelector(".working-row");
for (const provider of ["openai-codex", "anthropic", "custom"]) {
	hostMessage({ type: "status", status: { ...baseStatus, modelProvider: provider, modelId: "test-model", modelLabel: `${provider}/test-model` } });
	const activeIcon = scroller.querySelector(".working-mark .provider-icon");
	check(`working provider icon updates for ${provider}`, !!activeIcon && activeIcon.innerHTML === document.querySelector(".rail-pill.model .provider-icon")?.innerHTML);
	check("provider update preserves the working row and label", originalWorkingRow === scroller.querySelector(".working-row") && workingLabel === scroller.querySelector(".working-label"));
	hostMessage({ type: "status", status: { ...baseStatus, modelProvider: provider, modelId: "test-model", modelLabel: `${provider}/test-model` } });
	check("unchanged provider preserves icon identity", activeIcon === scroller.querySelector(".working-mark .provider-icon"));
}
hostMessage({ type: "status", status: baseStatus });

await new Promise(resolve => window.setTimeout(resolve, 450));
check("timer tick preserves animated text", workingLabel.firstChild === workingText);
hostMessage({ type: "promptRejected", error: "transport disconnected", clientRequestId: firstOptimisticPrompt?.payload?.clientRequestId });
check("rejection removes the exact optimistic row", !scroller.textContent.includes("first optimistic prompt") && scroller.textContent.includes("second optimistic prompt"), scroller.textContent);
check("rejection of one queued send keeps the working spinner", !!scroller.querySelector(".working-row") && !/Sending/.test(scroller.querySelector(".working-label")?.textContent ?? ""));
check("rejection restores the rejected draft when no newer draft exists", textarea.value === "first optimistic prompt", textarea.value);
textarea.value = "";
hostMessage({ type: "event", event: { type: "message_start", message: { role: "user", content: "second optimistic prompt" } } });
check("confirmed second prompt does not duplicate its optimistic row", scroller.querySelectorAll(".row-user").length === 1, String(scroller.querySelectorAll(".row-user").length));

// --- history delete: inline confirm posts deleteSession ---
const historyBtnAgain = document.querySelector('button[title="Session history"]');
historyBtnAgain.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
// Search must be cleared BEFORE the fixture: the needle blocks lastSessions updates.
document.querySelector(".history-search").value = "";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
hostMessage({
	type: "history",
	sessions: [
		{ id: "sess-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ id: "sess-b", path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});
const delItem = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("local chat"));
posted.length = 0;
[...delItem.querySelectorAll(".history-action")].find((b) => (b.title ?? "").startsWith("Delete")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("delete arms inline confirm", delItem.classList.contains("confirming"));
const confirmBtn = delItem.querySelector(".history-action.destructive");
check("confirm button labeled Delete", !!confirmBtn && confirmBtn.textContent.includes("Delete"));
confirmBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const delMsg = posted.find((m) => m.type === "deleteSession");
check(
	"confirm posts deleteSession",
	!!delMsg && delMsg.path === "/tmp/a.jsonl" && delMsg.sessionId === "sess-a",
	JSON.stringify(delMsg),
);
check("confirm disarms item", !delItem.classList.contains("confirming"));
check("no resume fired during delete", !posted.some((m) => m.type === "switchSession"));

// --- history delete: cancel restores the item without posting ---
const cancelItem = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("work on proj"));
posted.length = 0;
[...cancelItem.querySelectorAll(".history-action")].find((b) => (b.title ?? "").startsWith("Delete")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("second item arms confirm", cancelItem.classList.contains("confirming"));
const cancelBtn = [...cancelItem.querySelectorAll(".history-action")].find((b) => b.title === "Cancel");
cancelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("cancel posts no deleteSession", !posted.some((m) => m.type === "deleteSession"));
const restored = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("work on proj"));
check(
	"cancel restores item",
	!!restored && restored !== cancelItem && !restored.classList.contains("confirming") && !!restored.querySelector(".history-action"),
);

// --- history: archive only classifies idle/inactive sessions; it never stops a run ---
for (const [status, running, allowed] of [
	["running", false, false], [undefined, false, false], ["unknown", false, false],
	["idle", true, false], ["inactive", true, false], [undefined, true, false],
	["idle", false, true], ["inactive", false, true],
]) {
	hostMessage({ type: "history", sessions: [{
		id: "archive-status", path: "/tmp/archive-status.jsonl", cwd: "/ws",
		timestamp: new Date().toISOString(), name: "archive status", inWorkspace: true, status, running,
	}] });
	const button = [...document.querySelectorAll(".history-action")].find((b) => b.title.startsWith("Archive"));
	check(`archive eligibility (${status}, running=${running})`, button?.disabled === !allowed);
	if (!allowed) check("disabled archive explains why", button.title.includes(running || status === "running" ? "running" : "unknown"));
	posted.length = 0;
	button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	check("archive eligibility also guards dispatched clicks", posted.some((m) => m.type === "archiveSession") === allowed);
	check("archive never stops or deletes a session", !posted.some((m) => ["stopSession", "deleteSession"].includes(m.type)));
}

hostMessage({ type: "status", status: { ...baseStatus, sessionId: "current-archive" } });
hostMessage({
	type: "history",
	sessions: [{ id: "current-archive", path: "/tmp/current-archive.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "current archive", inWorkspace: true, status: "idle" }],
});
const currentArchiveRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("current archive"));
check("current row offers archive but not delete", !!currentArchiveRow &&
	[...currentArchiveRow.querySelectorAll(".history-action")].some((b) => (b.title ?? "").startsWith("Archive")) &&
	![...currentArchiveRow.querySelectorAll(".history-action")].some((b) => (b.title ?? "").startsWith("Delete")));
hostMessage({ type: "status", status: baseStatus });
hostMessage({
	type: "history",
	sessions: [
		{ id: "arch-1", path: "/tmp/arch.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "finished experiment", inWorkspace: true, status: "inactive",
			children: [{ id: "arch-child", name: "expanded worker", status: "running" }] },
	],
});
const archRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("finished experiment"));
const archBtn = [...archRow.querySelectorAll(".history-action")].find((b) => (b.title ?? "").startsWith("Archive"));
check("expanded subagent is rendered with archive actions", archRow.textContent.includes("expanded worker") && !!archBtn);
posted.length = 0;
archBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("archive posts on the first click", posted.some((m) => m.type === "archiveSession" && m.sessionId === "arch-1"), JSON.stringify(posted));
check("archive does not arm a confirm", !archRow.classList.contains("confirming"));
check("archive does not stop or delete", !posted.some((m) => ["stopSession", "deleteSession"].includes(m.type)));
check("archive immediately moves the row without a host refresh",
	document.querySelector(".history-group-summary")?.textContent === "Archive (1)" &&
	!!document.querySelector('[title="Move out of Archive"]'));
hostMessage({
	type: "history",
	sessions: [
		{ id: "arch-1", path: "/tmp/arch.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "finished experiment", inWorkspace: true, archived: true },
		{ id: "live-2", path: "/tmp/live2.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "still open", inWorkspace: true },
	],
});
const archiveGroup = [...document.querySelectorAll(".history-group")].find((g) => g.querySelector(".history-group-summary")?.textContent.includes("Archive"));
check("archive section starts folded", archiveGroup?.open === false);
archiveGroup.open = true;
check("archived row moves into its own section", archiveGroup.textContent.includes("finished experiment"));
check("active list still shows the unarchived row",
	[...document.querySelectorAll(".history-item .history-item-name")].some((n) => n.textContent.includes("still open")));
const archivedRow = [...archiveGroup.querySelectorAll(".history-item")].find((i) => i.textContent.includes("finished experiment"));
check("an already-archived row has no archive action",
	!!archivedRow && ![...archivedRow.querySelectorAll(".history-action")].some((b) => (b.title ?? "").startsWith("Archive")));
const unarchiveBtn = [...archivedRow.querySelectorAll(".history-action")].find((b) => b.title === "Move out of Archive");
check("an archived row offers a move-out action", !!unarchiveBtn);
posted.length = 0;
unarchiveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("move-out posts without opening the session",
	posted.some((m) => m.type === "unarchiveSession" && m.sessionId === "arch-1") && !posted.some((m) => m.type === "switchSession"),
	JSON.stringify(posted));
check("move-out immediately restores the active classification",
	[...document.querySelectorAll(".history-group-summary")].map((n) => n.textContent).join("|") === "Active (2)");
check("history actions stay in the title row",
	!!archivedRow.querySelector(".history-item-top > .history-actions"));

// --- history search reaches the host, and transcript hits rank and explain themselves ---
posted.length = 0;
document.querySelector(".history-search").value = "octopus";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 400));
check("typing asks the host to search the conversations", posted.some((m) => m.type === "searchHistory" && m.query === "octopus"), JSON.stringify(posted));
hostMessage({
	type: "history",
	sessions: [
		{ id: "s-name", path: "/tmp/s-name.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 90_000).toISOString(), modifiedMs: Date.now() - 90_000, name: "octopus notes", inWorkspace: true },
		{ id: "s-body", path: "/tmp/s-body.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "unrelated title", inWorkspace: true, matchSnippet: "…we talked about the octopus problem…" },
		{ id: "s-body", path: "/tmp/s-body.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "unrelated title", inWorkspace: true, matchSnippet: "…we talked about the octopus problem…" },
	],
});
const searchNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("transcript-only hit survives the local filter", searchNames.includes("unrelated title"), searchNames.join("|"));
check("duplicate rows from the host are collapsed by path", searchNames.length === 2, searchNames.join("|"));
check("match snippet shown as the row subtitle", !!document.querySelector(".history-item-sub.match"));
document.querySelector(".history-search").value = "";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));

check("rendered webview has no nested native interactive controls",
	document.querySelectorAll("button button, button input, button select, button textarea").length === 0,
	[...document.querySelectorAll("button button, button input, button select, button textarea")].map((node) => node.outerHTML).join("\n"));

// Reusing a native editor tab must leave its history screen before focusing or attaching.
hostMessage({ type: "showHistory" });
check("focus fixture starts in history", document.querySelector(".history-view")?.style.display !== "none");
hostMessage({ type: "focusComposer" });
check("focusComposer returns from history to chat", document.querySelector(".history-view")?.style.display === "none" && document.querySelector(".composer-dock").style.display !== "none");
check("focusComposer focuses the visible input", document.activeElement === textarea);
hostMessage({ type: "showHistory" });
check("selection fixture starts in history", document.querySelector(".history-view")?.style.display !== "none");
hostMessage({ type: "insertSelection", selection: { path: "src/history-selection.ts", startLine: 1, endLine: 2, text: "selected code", languageId: "typescript" } });
check("insertSelection returns from history to chat", document.querySelector(".history-view")?.style.display === "none" && document.querySelector(".composer-dock").style.display !== "none");
check("insertSelection retains the attached selection", [...document.querySelectorAll(".composer-chips .compose-chip")].some((chip) => chip.textContent.includes("history-selection.ts")));

// Session actions now live in the VS Code view title bar, not a webview kebab.
hostMessage({ type: "newThread" });
check("host newThread returns to chat", document.querySelector(".history-view")?.style.display === "none");
check("newThread paints the empty session immediately", !!document.querySelector(".welcome"), document.querySelector(".messages")?.textContent?.slice(0, 80) ?? "none");
check("newThread accepts a draft while send waits for the session", !textarea.disabled && textarea.placeholder === "Message Brief…" && document.querySelector(".send-btn.unavailable"), `${textarea.disabled} ${textarea.placeholder}`);
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("Enter during create does not post a prompt", !posted.some((m) => m.type === "prompt"), JSON.stringify(posted.map((m) => m.type)));
textarea.value = "new thread startup draft";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
hostMessage({
	type: "snapshot",
	messages: [],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: { ...baseStatus, sessionId: "session-created", sessionName: "", restoring: false },
});
check("new thread draft survives session creation", textarea.value === "new thread startup draft");
textarea.value = "";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
check("the created session unlocks the composer", !textarea.disabled && textarea.placeholder === "Message Brief…", `${textarea.disabled} ${textarea.placeholder}`);

// --- #5/C10: steer vs queue while a run is live, and a Stop that really aborts ---
const behaviorPill = document.querySelector(".composer-rail .send-mode-btn");
const deliveryButton = document.querySelector(".send-control .send-btn");
const stopBtn = document.querySelector(".composer-dock .send-btn.stop");
check("run controls stay hidden while idle", behaviorPill.style.display === "none" && stopBtn.style.display === "none",
	`behavior=${behaviorPill.style.display} stop=${stopBtn.style.display}`);
hostMessage({ type: "status", status: { ...baseStatus, streaming: true } });
check("run controls appear while streaming", behaviorPill.style.display !== "none" && stopBtn.style.display !== "none",
	`behavior=${behaviorPill.style.display} stop=${stopBtn.style.display}`);
check("delivery starts at the configured default", deliveryButton.textContent === "Steer", deliveryButton.textContent);
behaviorPill.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const queueOption = [...document.querySelectorAll(".dropdown-select")].find((item) => item.textContent.startsWith("Queue"));
check("queue option explains delivery timing", queueOption?.textContent.includes("when the run ends"));
queueOption.click();
check("choosing queue updates the send action", deliveryButton.textContent === "Queue", deliveryButton.textContent);
// The choice is only real if it rides along with the message.
posted.length = 0;
textarea.value = "and then run the tests";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const midRunPrompt = posted.find((m) => m.type === "prompt");
check("a mid-run send carries the chosen delivery to the host", midRunPrompt?.payload?.streamingBehavior === "followUp",
	JSON.stringify(midRunPrompt?.payload?.streamingBehavior ?? "<none>"));
check("queued input is not painted as a sent conversation message", !scroller.textContent.includes("and then run the tests"), scroller.textContent);
hostMessage({ type: "event", event: { type: "session_action_update", actions: { queuedCount: 1, steering: [], followUps: ["and then run the tests"] } } });
check("queued input stays in the pending input strip", !document.querySelector(".pending-inputs").hidden && document.querySelector(".pending-inputs").textContent.includes("and then run the tests"));
hostMessage({ type: "promptRejected", error: "queue rejected", clientRequestId: midRunPrompt?.payload?.clientRequestId });
check("rejected queued input returns to the composer", textarea.value === "and then run the tests", textarea.value);
textarea.value = "";
posted.length = 0;
stopBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("stop posts abort", posted.some((m) => m.type === "abort"), JSON.stringify(posted));
// #68: while observing, the run on screen belongs to another client — our Stop
// would not reach it, so it must not be offered.
hostMessage({ type: "status", status: { ...baseStatus, streaming: true, observingId: "other-1" } });
check("stop is withdrawn while watching someone else's run", stopBtn.style.display === "none", stopBtn.style.display);
hostMessage({ type: "status", status: { ...baseStatus, streaming: false } });
check("run controls retire when the run ends", behaviorPill.style.display === "none" && stopBtn.style.display === "none",
	`behavior=${behaviorPill.style.display} stop=${stopBtn.style.display}`);
check("idle delivery returns to Send", deliveryButton.textContent === "Send", deliveryButton.textContent);

// --- #45/#19/#53: the scroll lock and the jump-to-bottom pill ---
// happy-dom does no layout, so every metric is 0 and the handler would always
// conclude "already at the bottom". Stub the geometry to get a real scrollback.
Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
scroller.scrollTop = 0;
scroller.dispatchEvent(new window.Event("scroll"));
const jumpBtn = scroller.querySelector(".jump-to-latest");
check("jump-to-bottom appears once the reader scrolls away", !!jumpBtn && jumpBtn.className.includes("visible"), jumpBtn?.className ?? "<none>");
check("jump button is a labeled down arrow", jumpBtn?.title === "Jump to bottom" && jumpBtn.getAttribute("aria-label") === "Jump to bottom" && jumpBtn.className.includes("down"),
	`${jumpBtn?.title ?? "<none>"} / ${jumpBtn?.className ?? ""}`);
hostMessage({ type: "event", event: { type: "message_start", message: { role: "assistant", model: "kimi", content: [{ type: "text", text: "still going" }] } } });
hostMessage({ type: "event", event: { type: "message_update", message: { role: "assistant", model: "kimi", content: [{ type: "text", text: "still going and going" }] } } });
check("streaming never yanks a scrolled-up reader back down", scroller.scrollTop === 0, String(scroller.scrollTop));
jumpBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("jump returns to the latest and retires the pill", scroller.scrollTop === 2000 && !jumpBtn.className.includes("visible"),
	`${scroller.scrollTop} / ${jumpBtn.className}`);
hostMessage({ type: "event", event: { type: "message_update", message: { role: "assistant", model: "kimi", content: [{ type: "text", text: "still going and going and going" }] } } });
check("auto-follow resumes after the jump", scroller.scrollTop === 2000, String(scroller.scrollTop));

// --- Up/Down recall of previous prompts from an EMPTY composer ---------------
const recallStatus = { ...baseStatus, sessionId: "session-recall" };
hostMessage({
	type: "snapshot",
	status: recallStatus,
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	messages: [
		{ role: "user", content: "first prompt" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		{ role: "user", content: [{ type: "text", text: "second prompt" }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	],
});
const upKey = () => textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
const downKey = () => textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
textarea.value = "";
upKey();
check("ArrowUp on an empty box recalls the newest prompt", textarea.value === "second prompt", JSON.stringify(textarea.value));
check("recall puts the caret at the end", textarea.selectionStart === "second prompt".length, String(textarea.selectionStart));
upKey();
check("ArrowUp again walks further back", textarea.value === "first prompt", JSON.stringify(textarea.value));
upKey();
check("ArrowUp holds at the oldest prompt", textarea.value === "first prompt", JSON.stringify(textarea.value));
downKey();
check("ArrowDown walks forward again", textarea.value === "second prompt", JSON.stringify(textarea.value));
downKey();
check("ArrowDown past the newest returns to an empty box", textarea.value === "", JSON.stringify(textarea.value));
// With text the operator wrote, the arrows belong to the caret.
textarea.value = "half-written thought";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const caretEvent = new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
textarea.dispatchEvent(caretEvent);
check("ArrowUp does not hijack a draft the operator is writing", textarea.value === "half-written thought", JSON.stringify(textarea.value));
check("...and the key is left to the textarea", !caretEvent.defaultPrevented);
textarea.value = "";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
// A sent prompt joins the history immediately.
textarea.value = "just sent this";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
upKey();
check("a prompt sent in this panel is recalled first", textarea.value === "just sent this", JSON.stringify(textarea.value));
textarea.value = "";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));

// --- agent_end must not render an already completed assistant twice --------
const finalReply = { role: "assistant", model: "kimi", stopReason: "stop", content: [{ type: "text", text: "final reply" }] };
for (const completed of [true, false]) {
	hostMessage({ type: "snapshot", status: baseStatus, state: null, messages: [] });
	hostMessage({ type: "event", event: { type: "agent_start" } });
	hostMessage({ type: "event", event: { type: "message_start", message: { ...finalReply, content: [] } } });
	hostMessage({ type: "event", event: { type: "message_update", message: { ...finalReply, content: [{ type: "text", text: "partial reply" }] } } });
	if (completed) hostMessage({ type: "event", event: { type: "message_end", message: finalReply } });
	const replyRow = scroller.querySelector(".row-assistant");
	hostMessage({ type: "event", event: { type: "agent_end", messages: [finalReply] } });
	check(`agent_end ${completed ? "keeps completed" : "finishes partial"} reply in the same single row`,
		scroller.querySelectorAll(".row-assistant").length === 1 && scroller.querySelector(".row-assistant") === replyRow && replyRow.textContent.includes("final reply"));
	check("agent_end removes the working row", !scroller.querySelector(".working-row"));
}

// --- Empty thinking parts must not draw an empty "Thought process" box -------
hostMessage({
	type: "snapshot",
	status: { ...baseStatus, sessionId: "session-thinking" },
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "   " }, { type: "text", text: "answer" }] }],
});
check("a blank thinking part renders no box", !scroller.querySelector("details.thinking"),
	scroller.querySelector("details.thinking")?.outerHTML?.slice(0, 60) ?? "none");
check("...while the reply itself still renders", /answer/.test(scroller.textContent));
// Streaming: the slot arrives before its first delta. The box must appear with
// the content and must be the SAME node afterwards, or it would lose its
// open/closed state on every frame.
hostMessage({ type: "snapshot", status: { ...baseStatus, sessionId: "session-thinking-2" }, state: null, messages: [] });
const realWorkingInterval = window.setInterval;
const realWorkingNow = window.Date.now;
let workingTick;
let workingNow = realWorkingNow();
window.Date.now = () => workingNow;
window.setInterval = (callback, delay, ...args) => {
	if (delay === 400) workingTick = callback;
	return realWorkingInterval.call(window, callback, delay, ...args);
};
hostMessage({ type: "event", event: { type: "agent_start" } });
const initialWorkingLabel = scroller.querySelector(".working-label");
const initialWorkingVerb = initialWorkingLabel.textContent;
workingNow += 7_999;
workingTick();
check("working verb stays for eight seconds", initialWorkingLabel.textContent === initialWorkingVerb);
check("elapsed time is separate from the animated verb", scroller.querySelector(".working-elapsed")?.textContent === "7s");
workingNow += 1;
workingTick();
check("working verb changes after eight seconds without replacing its element", initialWorkingLabel === scroller.querySelector(".working-label") && initialWorkingLabel.textContent !== initialWorkingVerb);
check("decorative updates do not announce each tick", initialWorkingLabel.getAttribute("aria-hidden") === "true" && scroller.querySelector(".working-row")?.getAttribute("aria-label") === "Working");
window.setInterval = realWorkingInterval;
window.Date.now = realWorkingNow;
check("agent_start paints a working row immediately", !!scroller.querySelector(".working-row .working-mark"), scroller.querySelector(".working-row")?.textContent ?? "none");
hostMessage({ type: "event", event: { type: "message_start", message: { role: "assistant", model: "kimi", content: [{ type: "thinking", thinking: "" }] } } });
check("no box while the thinking slot is still empty", !scroller.querySelector("details.thinking"));
check("empty message_start keeps the working spinner", !!scroller.querySelector(".working-row") && !scroller.querySelector(".row-assistant"), scroller.querySelector(".working-row")?.textContent ?? "none");
hostMessage({ type: "event", event: { type: "message_update", message: { role: "assistant", model: "kimi", content: [{ type: "thinking", thinking: "step one" }] } } });
check("thinking stays behind the working row until it settles", !scroller.querySelector("details.thinking") && !!scroller.querySelector(".working-row"));
hostMessage({ type: "event", event: { type: "message_end", message: { role: "assistant", model: "kimi", content: [{ type: "thinking", thinking: "step one, step two" }] } } });
const born = scroller.querySelector("details.thinking");
check("the box appears once thinking settles", !!born && /step two/.test(born.textContent));
check("settled thinking is collapsed by default", born instanceof window.HTMLDetailsElement && born.open === false);
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });

hostMessage({ type: "snapshot", status: { ...baseStatus, sessionId: "session-thinking-live", liveTranscript: true }, state: null, messages: [] });
hostMessage({ type: "event", event: { type: "agent_start" } });
hostMessage({ type: "event", event: { type: "message_start", message: { role: "assistant", model: "kimi", content: [{ type: "thinking", thinking: "" }] } } });
hostMessage({ type: "event", event: { type: "message_update", message: { role: "assistant", model: "kimi", content: [{ type: "thinking", thinking: "step one" }] } } });
const liveBorn = scroller.querySelector("details.thinking");
check("liveTranscript paints thinking on the first delta", !!liveBorn && /step one/.test(liveBorn.textContent));
check("visible thinking keeps the working spinner", !!scroller.querySelector(".working-row"));
hostMessage({ type: "event", event: { type: "message_update", message: { role: "assistant", model: "kimi", content: [{ type: "thinking", thinking: "step one, step two" }] } } });
check("later deltas grow the same node, not a new one", scroller.querySelector("details.thinking") === liveBorn);
check("...and its text keeps up", /step two/.test(scroller.querySelector("details.thinking").textContent));
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });

// The run indicator survives visible text, hidden tool arguments, and tool execution.
for (const liveTranscript of [false, true]) {
	hostMessage({ type: "snapshot", status: { ...baseStatus, sessionId: `working-lifecycle-${liveTranscript}`, liveTranscript }, state: null, messages: [] });
	hostMessage({ type: "event", event: { type: "agent_start" } });
	const working = scroller.querySelector(".working-row");
	const text = { type: "text", text: "I will run a tool." };
	const message = { role: "assistant", content: [text] };
	const call = { type: "toolCall", id: "working-tool", name: "ipython", arguments: { code: "print(1)" } };
	const toolMessage = { ...message, content: [text, call] };
	for (const event of [
		{ type: "message_start", message },
		{ type: "message_update", message },
		{ type: "message_update", message: toolMessage },
		{ type: "message_end", message: toolMessage },
		{ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments },
		{ type: "tool_execution_end", toolCallId: call.id, result: { content: [{ type: "text", text: "1" }] }, isError: false },
		{ type: "turn_end" },
	]) {
		hostMessage({ type: "event", event });
		check(`${event.type} preserves the run indicator (live=${liveTranscript})`, !!working && scroller.querySelector(".working-row") === working);
		check("working indicator remains below transcript content", scroller.lastElementChild === working);
	}
	hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
	check("handoff removes the run indicator", !scroller.querySelector(".working-row"));
}

// --- recall must work at ANY point in a thread, not only at rest -------------
const anytimeStatus = { ...baseStatus, sessionId: "session-anytime" };
hostMessage({
	type: "snapshot", status: anytimeStatus, state: null,
	messages: [
		{ role: "user", content: "alpha" }, { role: "assistant", content: [{ type: "text", text: "a" }] },
		{ role: "user", content: "beta" }, { role: "assistant", content: [{ type: "text", text: "b" }] },
	],
});
const clearBox = () => { textarea.value = ""; textarea.dispatchEvent(new window.Event("input", { bubbles: true })); };
const arrow = (key) => textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

hostMessage({ type: "event", event: { type: "agent_start" } });
clearBox(); arrow("ArrowUp");
check("recall works while a run is streaming", textarea.value === "beta", JSON.stringify(textarea.value));
hostMessage({ type: "status", status: anytimeStatus });
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });

clearBox();
textarea.value = "steer now";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
arrow("Enter");
arrow("ArrowUp");
check("a steering prompt is recalled first", textarea.value === "steer now", JSON.stringify(textarea.value));

clearBox(); arrow("ArrowUp"); arrow("ArrowUp");
check("browsed back before the interruption", textarea.value === "beta", JSON.stringify(textarea.value));
hostMessage({ type: "draft", text: "" });
arrow("ArrowUp");
check("a host draft push restarts recall at the newest", textarea.value === "steer now", JSON.stringify(textarea.value));
clearBox();

// Read receipts require a successfully rendered visible chat; the host checks foreground focus.
let readingFocused = true;
Object.defineProperty(document, "hasFocus", { configurable: true, value: () => readingFocused });
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
const readFrame = () => new Promise((resolve) => window.requestAnimationFrame(resolve));
const readReceipt = { sessionId: "read-session", path: "/tmp/read.jsonl", revision: 1, completedAt: 42 };
const readSnapshot = { type: "snapshot", status: { ...baseStatus, sessionId: readReceipt.sessionId }, state: null,
	messages: [{ role: "assistant", content: [{ type: "text", text: "Rendered completion" }] }], readReceipt };
hostMessage({ type: "focusComposer" });
posted.length = 0;
hostMessage(readSnapshot); await readFrame();
check("successful focused snapshot acknowledges exact identity", posted.some((m) => m.type === "chatRendered" && m.receipt.revision === 1));
posted.length = 0;
hostMessage({ type: "status", status: { ...baseStatus, sessionId: readReceipt.sessionId, unreadComplete: true } });
hostMessage({ type: "history", sessions: [] }); await readFrame();
check("status and history repaint do not acknowledge read", !posted.some((m) => m.type === "chatRendered"));
check("header uses shared unread state", document.querySelector(".conn-dot")?.classList.contains("complete"));
hostMessage({ type: "status", status: { ...baseStatus, connected: false, streaming: true, compacting: true, retrying: true, sessionId: readReceipt.sessionId } });
check("offline header has no lamp for stale local execution", document.querySelector(".conn-dot")?.className === "conn-dot" && document.querySelector(".live-label")?.textContent === "offline");
hostMessage({ type: "status", status: { ...baseStatus, connected: false, historyRunning: true, sessionId: readReceipt.sessionId } });
check("known global execution stays red without a local attachment", document.querySelector(".conn-dot")?.classList.contains("working"));
hostMessage({ type: "status", status: { ...baseStatus, statusText: "opened", historyRunning: true, sessionId: readReceipt.sessionId } });
check("running lamp never labels an attached session opened", document.querySelector(".conn-dot")?.classList.contains("working") && document.querySelector(".live-label")?.textContent === "working");
hostMessage({ type: "status", status: { ...baseStatus, statusText: "opened", historyRunning: false, sessionId: readReceipt.sessionId } });
check("authoritative idle clears red after response ends", document.querySelector(".conn-dot")?.className === "conn-dot" && document.querySelector(".live-label")?.textContent === "");
hostMessage({ type: "sessionChildren", children: [{ id: "stale", activeSessionId: "stale", status: "running" }] });
hostMessage({ type: "status", status: { ...baseStatus, streaming: true, compacting: true, retrying: true, historyRunning: false, sessionId: readReceipt.sessionId } });
for (const statusText of ["running", "working", "compacting…", "retrying…"]) {
	hostMessage({ type: "status", status: { ...baseStatus, streaming: true, statusText, historyRunning: false, sessionId: readReceipt.sessionId } });
	check(`known idle overrides stale ${statusText} label`, document.querySelector(".live-label")?.textContent === "live");
}
check("known idle beats stale streaming and child state", document.querySelector(".conn-dot")?.className === "conn-dot" && document.querySelector(".live-label")?.textContent === "live");
hostMessage({ type: "status", status: { ...baseStatus, streaming: true, historyRunning: null, sessionId: readReceipt.sessionId } });
check("explicit unknown suppresses stale work and uses text", document.querySelector(".conn-dot")?.className === "conn-dot" && document.querySelector(".live-label")?.textContent === "Execution status unavailable");
hostMessage({ type: "sessionChildren", children: [] });
hostMessage({ type: "showHistory" });
posted.length = 0;
hostMessage({ ...readSnapshot, readReceipt: { ...readReceipt, revision: 2 } }); await readFrame();
check("hidden chat does not acknowledge a snapshot", !posted.some((m) => m.type === "chatRendered"));
hostMessage({ type: "requestReadReceipt" }); await readFrame();
check("native activation does not acknowledge hidden chat", !posted.some((m) => m.type === "chatRendered"));
window.dispatchEvent(new window.Event("focus"));
check("focusing history actions does not request chat reading", !posted.some((m) => m.type === "chatFocused"));
readingFocused = false;
hostMessage({ type: "focusComposer" }); await readFrame();
check("opening rendered chat acknowledges without document focus", posted.some((m) => m.type === "chatRendered" && m.receipt.revision === 2));
posted.length = 0;
hostMessage({ type: "requestReadReceipt" }); await readFrame();
check("native tab activation acknowledges rendered chat without document focus", posted.some((m) => m.type === "chatRendered" && m.receipt.revision === 2));
readingFocused = true;
window.dispatchEvent(new window.Event("focus")); await readFrame();
check("focusing rendered chat acknowledges pending snapshot", posted.some((m) => m.type === "chatRendered" && m.receipt.revision === 2));
check("returning to chat does not use the removed manual-unread focus message", !posted.some((m) => m.type === "chatFocused"));
hostMessage({ type: "setHistoryMode", enabled: true });
posted.length = 0;
hostMessage({ ...readSnapshot, readReceipt: { ...readReceipt, revision: 3 } });
window.dispatchEvent(new window.Event("focus")); await readFrame();
check("history-only view never acknowledges chat", !posted.some((m) => m.type === "chatRendered"));
hostMessage({ type: "setHistoryMode", enabled: false }); await readFrame();
posted.length = 0;
hostMessage({ type: "event", event: { type: "agent_end", messages: [] }, readReceipt: { ...readReceipt, revision: 4 } }); await readFrame();
check("completed output is acknowledged after render", posted.some((m) => m.type === "chatRendered" && m.receipt.revision === 4));

console.log(failed === 0 ? "\nPASS webview harness" : `\n${failed} webview checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
