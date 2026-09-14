/** Focused runtime validation coverage for the webview-to-host boundary. */
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const result = await esbuild.build({
	entryPoints: ["src/webview-message.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	write: false,
	logLevel: "silent",
});
const { parseWebviewMessage } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

assert.deepEqual(parseWebviewMessage({ type: "newSessionFromCurrent", extra: true }), { type: "newSessionFromCurrent" });
assert.deepEqual(parseWebviewMessage({ type: "newSession" }), { type: "newSession" });
for (const type of ["forkSession", "exportChat", "copyLastReply"]) {
	assert.deepEqual(parseWebviewMessage({ type, text: "not a prompt", attachments: ["not forwarded"] }), { type });
}

const prompt = {
	type: "prompt",
	payload: {
		text: "Review this image and selection",
		images: [{ data: "aGVsbG8=", mimeType: "image/png", name: "capture.png" }],
		selections: [{ path: "src/chat-view.ts", startLine: 10, endLine: 20, text: "const safe = true;", languageId: "typescript" }],
		streamingBehavior: "followUp",
		clientRequestId: "sidebar-1",
	},
	extra: "not forwarded",
};
const parsedPrompt = parseWebviewMessage(prompt);
assert.deepEqual(parsedPrompt, {
	type: "prompt",
	payload: {
		text: "Review this image and selection",
		images: [{ data: "aGVsbG8=", mimeType: "image/png", name: "capture.png" }],
		selections: [{ path: "src/chat-view.ts", startLine: 10, endLine: 20, text: "const safe = true;", languageId: "typescript" }],
		streamingBehavior: "followUp",
		clientRequestId: "sidebar-1",
	},
});
prompt.payload.images[0].data = "Y2hhbmdlZA==";
assert.equal(parsedPrompt.payload.images[0].data, "aGVsbG8=", "parser must copy nested payload data");

// The thread a prompt was composed in travels with it: the host refuses to
// deliver words into a conversation other than the one they were typed in,
// so this stamp has to survive the parser — and be rejected when forged.
const stamped = parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, sessionId: "01a05fe1-944a-7365-87b0-747f31bc9cf4" } });
assert.equal(stamped.payload.sessionId, "01a05fe1-944a-7365-87b0-747f31bc9cf4", "composed-in thread must survive parsing");
assert.equal(parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, sessionId: "../../etc/passwd" } }), undefined);
assert.equal(parsedPrompt.payload.sessionId, undefined, "an unstamped prompt still parses (older webview build)");

assert.deepEqual(parseWebviewMessage({ type: "login", command: "untrusted" }), { type: "login" });
assert.deepEqual(parseWebviewMessage({ type: "logout", provider: "untrusted" }), { type: "logout" });
assert.equal(parseWebviewMessage(null), undefined);
assert.equal(parseWebviewMessage({ type: "unknown" }), undefined);
assert.equal(parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, images: [{ data: "not base64", mimeType: "image/png" }] } }), undefined);
assert.equal(parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, text: "x".repeat(200_001) } }), undefined);
assert.equal(parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, selections: [{ ...prompt.payload.selections[0], startLine: 9, endLine: 8 }] } }), undefined);
assert.equal(parseWebviewMessage({ type: "browseChild", browseRef: "../forged" }), undefined);
assert.equal(parseWebviewMessage({ type: "switchSession", path: "/tmp/forged.jsonl" }), undefined);
assert.equal(parseWebviewMessage({ type: "deleteSession", path: "/tmp/session\0.jsonl", sessionId: "safe-id" }), undefined);
assert.deepEqual(parseWebviewMessage({ type: "unarchiveSession", path: "/tmp/known.jsonl", sessionId: "known-session" }), {
	type: "unarchiveSession",
	path: "/tmp/known.jsonl",
	sessionId: "known-session",
});
assert.equal(parseWebviewMessage({ type: "openFile", path: "src/app.ts", endLine: 4 }), undefined);
assert.equal(parseWebviewMessage({ type: "searchFiles", query: "src", requestId: Number.NaN }), undefined);
assert.deepEqual(parseWebviewMessage({ type: "dropWorkspaceUris", uris: ["file:///workspace/src/app.ts", "file:///workspace/src"], requestId: 1, requestId: 1 }), {
	type: "dropWorkspaceUris", uris: ["file:///workspace/src/app.ts", "file:///workspace/src"], requestId: 1,
});
assert.equal(parseWebviewMessage({ type: "dropWorkspaceUris", uris: [], requestId: 1 }), undefined);
assert.equal(parseWebviewMessage({ type: "dropWorkspaceUris", uris: ["x\0"], requestId: 1 }), undefined);
assert.equal(parseWebviewMessage({ type: "dropWorkspaceUris", uris: Array(65).fill("file:///workspace/a"), requestId: 1 }), undefined);
assert.equal(parseWebviewMessage({ type: "setCompactThreshold", percent: 19 }), undefined);
assert.equal(parseWebviewMessage({ type: "setCompactThreshold", percent: 22.5 }), undefined);
assert.deepEqual(parseWebviewMessage({ type: "setCompactThreshold", percent: 55 }), { type: "setCompactThreshold", percent: 55 });
assert.deepEqual(parseWebviewMessage({ type: "renameSession", name: "" }), { type: "renameSession", name: "" });
assert.deepEqual(parseWebviewMessage({ type: "browseChild", browseRef: "531d0ed5-3678-405e-9b8c-e9879bd9e552" }), {
	type: "browseChild",
	browseRef: "531d0ed5-3678-405e-9b8c-e9879bd9e552",
});

// Notice actions are host-issued capabilities, validated like a browseRef.
assert.equal(parseWebviewMessage({ type: "noticeAction", id: "../forged" }), undefined);
assert.equal(parseWebviewMessage({ type: "noticeAction" }), undefined);
assert.deepEqual(parseWebviewMessage({ type: "noticeAction", id: "6e5fb7c8-5c8f-48b2-91b5-80fd8229e8f2" }), {
	type: "noticeAction",
	id: "6e5fb7c8-5c8f-48b2-91b5-80fd8229e8f2",
});
assert.deepEqual(parseWebviewMessage({ type: "switchSession", path: "/tmp/known.jsonl", sessionId: "known-session" }), {
	type: "switchSession",
	path: "/tmp/known.jsonl",
	sessionId: "known-session",
});
assert.equal(parseWebviewMessage({ type: "draftChanged", text: "stale draft" }), undefined);
assert.deepEqual(parseWebviewMessage({ type: "draftChanged", text: "current draft", sessionId: "known-session" }), {
	type: "draftChanged",
	text: "current draft",
	sessionId: "known-session",
});

console.log("PASS chat-view webview message parser");

const receipt = { sessionId: "session-1", path: "/known/one.jsonl", revision: 1, completedAt: 42 };
assert.deepEqual(parseWebviewMessage({ type: "chatRendered", receipt }), { type: "chatRendered", receipt });
for (const invalid of [{ ...receipt, revision: -1 }, { ...receipt, sessionId: "bad/id" }, { ...receipt, path: "" }, { ...receipt, completedAt: NaN }]) {
	assert.equal(parseWebviewMessage({ type: "chatRendered", receipt: invalid }), undefined);
}
assert.equal(parseWebviewMessage({ type: "markSessionUnread", path: "/known/one.jsonl", sessionId: "session-1" }), undefined);
assert.equal(parseWebviewMessage({ type: "chatFocused", sessionId: "session-1" }), undefined);

const attachment = { id: "ref", kind: "text", label: "Text 1", start: 0, end: 8, status: "ready", text: "original" };
assert.ok(parseWebviewMessage({ type: "createAttachment", sessionId: "session", attachment }));
assert.equal(parseWebviewMessage({ type: "openAttachment", sessionId: "session", id: "../../etc/passwd" }), undefined);
const refPrompt = { type: "prompt", payload: { text: "[Text 1]", images: [], selections: [], streamingBehavior: "steer", sessionId: "session", attachments: [attachment] } };
assert.ok(parseWebviewMessage(refPrompt));
assert.equal(parseWebviewMessage({ ...refPrompt, payload: { ...refPrompt.payload, text: "forged" } }), undefined);
assert.equal(parseWebviewMessage({ ...refPrompt, payload: { ...refPrompt.payload, attachments: [attachment, attachment] } }), undefined);
assert.ok(parseWebviewMessage({ type: "draftChanged", sessionId: "session", text: "original", attachmentDraft: { text: "[Text 1]", attachments: [attachment] } }));
console.log("PASS attachment bus bounds, markers, duplicate refs, draft refs");

for (const type of ["promptRenameSession", "openSidebarHistory"]) {
 assert.deepEqual(parseWebviewMessage({ type, name: "ignored" }), { type });
}
assert.deepEqual(parseWebviewMessage({ type: "renameSession", name: "Name with spaces" }), { type: "renameSession", name: "Name with spaces" });
assert.equal(parseWebviewMessage({ type: "renameSession", name: 5 }), undefined);
assert.equal(parseWebviewMessage({ type: "renameSession", name: "x".repeat(257) }), undefined);
