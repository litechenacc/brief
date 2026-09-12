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

window.dispatchEvent(new window.MessageEvent("message", { data: snapshot(10) }));
check("hidden at ten turns", document.querySelector(".conversation-lens")?.hidden === true);
window.dispatchEvent(new window.MessageEvent("message", { data: snapshot(11) }));
const lens = document.querySelector(".conversation-lens");
check("visible at eleven turns", lens?.hidden === false);
check("lens leaves the native scrollbar gutter usable", /\.conversation-lens \{[^}]*right: 8px;/.test(css));
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
check("individual markers are eight pixels wide", individual?.className.includes("lens-individual"));
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
