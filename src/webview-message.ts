/**
 * Parse untrusted webview postMessage payloads into bounded protocol objects.
 */
import type { ChatViewState, ComposerDraft, ImageAttachment, PromptPayload, SelectionAttachment, WebviewToHost } from "./protocol.js";

const MAX_PROMPT_TEXT_CHARS = 200_000;
// Keep this transport envelope aligned with the image picker and composer.
const MAX_PROMPT_IMAGES = 8;
// Matches webview/image-fit.ts MAX_DECODED_IMAGE_BYTES: 7 MiB decodes to
// ~9.79 MB of base64, under the provider 's 10 MB ceiling-measured-on-the-wire.
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_DATA_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_SELECTIONS = 16;
const MAX_SELECTION_TEXT_CHARS = 100_000;
const MAX_TOTAL_SELECTION_TEXT_CHARS = 500_000;
const MAX_PATH_CHARS = 4_096;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_QUERY_CHARS = 4_096;
const MAX_DRAFT_CHARS = 200_000;
const MAX_COMPACT_INSTRUCTIONS_CHARS = 20_000;
const MAX_LINE_NUMBER = 10_000_000;
const MAX_FORK_ORDINAL = 1_000_000;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
	return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.length > 0) && !value.includes("\0");
}

function isIdentifier(value: unknown): value is string {
	return isBoundedString(value, MAX_IDENTIFIER_CHARS) && IDENTIFIER.test(value);
}

function isPath(value: unknown): value is string {
	return isBoundedString(value, MAX_PATH_CHARS);
}

function isRequestId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLineNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE_NUMBER;
}

function isBase64(value: string): boolean {
	return value.length > 0 && value.length % 4 === 0 && BASE64.test(value);
}

function base64ByteLength(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function parsePromptPayload(value: unknown, allowEmpty = false): PromptPayload | undefined {
	if (!isRecord(value)) return undefined;
	if (!isBoundedString(value.text, MAX_PROMPT_TEXT_CHARS, true)) return undefined;
	if (value.streamingBehavior !== "steer" && value.streamingBehavior !== "followUp") return undefined;
	if (!Array.isArray(value.images) || value.images.length > MAX_PROMPT_IMAGES) return undefined;
	if (!Array.isArray(value.selections) || value.selections.length > MAX_SELECTIONS) return undefined;

	const images: ImageAttachment[] = [];
	let totalImageBytes = 0;
	for (const image of value.images) {
		if (!isRecord(image)) return undefined;
		if (!isBoundedString(image.data, MAX_IMAGE_DATA_CHARS) || !isBase64(image.data)) return undefined;
		if (typeof image.mimeType !== "string" || !IMAGE_MIME_TYPES.has(image.mimeType)) return undefined;
		if (image.name !== undefined && !isBoundedString(image.name, MAX_NAME_CHARS)) return undefined;
		const imageBytes = base64ByteLength(image.data);
		if (imageBytes > MAX_IMAGE_BYTES) return undefined;
		totalImageBytes += imageBytes;
		if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) return undefined;
		images.push(image.name === undefined
			? { data: image.data, mimeType: image.mimeType }
			: { data: image.data, mimeType: image.mimeType, name: image.name });
	}

	const selections: SelectionAttachment[] = [];
	let totalSelectionTextChars = 0;
	for (const selection of value.selections) {
		if (!isRecord(selection)) return undefined;
		if (!isPath(selection.path) || !isLineNumber(selection.startLine) || !isLineNumber(selection.endLine)) return undefined;
		if (selection.endLine < selection.startLine) return undefined;
		if (!isBoundedString(selection.text, MAX_SELECTION_TEXT_CHARS, true)) return undefined;
		if (!isBoundedString(selection.languageId, MAX_IDENTIFIER_CHARS)) return undefined;
		totalSelectionTextChars += selection.text.length;
		if (totalSelectionTextChars > MAX_TOTAL_SELECTION_TEXT_CHARS) return undefined;
		selections.push({
			path: selection.path,
			startLine: selection.startLine,
			endLine: selection.endLine,
			text: selection.text,
			languageId: selection.languageId,
		});
	}

	if (!allowEmpty && value.text.length === 0 && images.length === 0 && selections.length === 0) return undefined;
	if (value.clientRequestId !== undefined && !isIdentifier(value.clientRequestId)) return undefined;
	if (value.sessionId !== undefined && !isIdentifier(value.sessionId)) return undefined;
	return {
		text: value.text,
		images,
		selections,
		streamingBehavior: value.streamingBehavior,
		...(value.clientRequestId === undefined ? {} : { clientRequestId: value.clientRequestId }),
		...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
	};
}

/**
 * Parse the untrusted webview transport payload into a fresh, bounded protocol
 * object. This is intentionally stricter than TypeScript's compile-time union:
 * webview postMessage data can be supplied by a compromised page at runtime.
 */
function parseComposerDraft(value: unknown): ComposerDraft | undefined {
	if (!isRecord(value)) return undefined;
	const payload = parsePromptPayload({ ...value, streamingBehavior: "steer" }, true);
	if (!payload || !Array.isArray(value.accepted) || value.accepted.length > 256 || !value.accepted.every(isPath)) return undefined;
	return { text: payload.text, images: payload.images, selections: payload.selections, accepted: [...value.accepted] };
}

export function parseChatViewState(value: unknown): ChatViewState | undefined {
	if (!isRecord(value) || !isRecord(value.composer) || !isRecord(value.transcript)) return undefined;
	const c = value.composer;
	const t = value.transcript;
	const draft = parseComposerDraft(c.draft);
	const stash = c.stash === null ? null : parseComposerDraft(c.stash);
	const lastNonSlashDraft = parseComposerDraft(c.lastNonSlashDraft);
	if (!draft || stash === undefined || !lastNonSlashDraft) return undefined;
	if (!isRequestId(c.selectionStart) || !isRequestId(c.selectionEnd) || c.selectionStart > c.selectionEnd || c.selectionEnd > draft.text.length) return undefined;
	if (c.behavior !== "steer" && c.behavior !== "followUp") return undefined;
	if (!Array.isArray(t.expandedBlocks) || t.expandedBlocks.length > 10_000 || !t.expandedBlocks.every((index) => isRequestId(index) && index <= 1_000_000)) return undefined;
	if (!isRequestId(t.olderCount) || t.olderCount > 1_000_000 || !isRequestId(t.anchorIndex) || t.anchorIndex > 1_000_000) return undefined;
	if (typeof t.scrollTop !== "number" || !Number.isFinite(t.scrollTop) || t.scrollTop < 0 || t.scrollTop > 1_000_000_000) return undefined;
	if (typeof t.anchorOffset !== "number" || !Number.isFinite(t.anchorOffset) || Math.abs(t.anchorOffset) > 1_000_000_000 || typeof t.stickToBottom !== "boolean") return undefined;
	return {
		composer: { draft, stash, lastNonSlashDraft, selectionStart: c.selectionStart, selectionEnd: c.selectionEnd, behavior: c.behavior },
		transcript: { olderCount: t.olderCount, scrollTop: t.scrollTop, stickToBottom: t.stickToBottom, anchorIndex: t.anchorIndex, anchorOffset: t.anchorOffset, expandedBlocks: [...t.expandedBlocks] },
	};
}

export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;

	switch (value.type) {
		case "viewStateCaptured": {
			if (!isIdentifier(value.requestId) || !(value.sessionId === "" || isIdentifier(value.sessionId))) return undefined;
			const state = parseChatViewState(value.state);
			return state ? { type: "viewStateCaptured", requestId: value.requestId, sessionId: value.sessionId, state } : undefined;
		}
		case "viewStateRestored":
			return isIdentifier(value.requestId) && (value.sessionId === "" || isIdentifier(value.sessionId))
				? { type: "viewStateRestored", requestId: value.requestId, sessionId: value.sessionId } : undefined;
		case "viewStateFailed":
			return isIdentifier(value.requestId) && (value.sessionId === "" || isIdentifier(value.sessionId)) && isBoundedString(value.error, 1024)
				? { type: "viewStateFailed", requestId: value.requestId, sessionId: value.sessionId, error: value.error } : undefined;
		case "viewFocused":
		case "ready":
		case "abort":
		case "newSession":
		case "exportChat":
		case "restart":
		case "requestState":
		case "requestModels":
		case "requestCommands":
		case "requestHistory":
		case "stopObserving":
		case "backToParent":
		case "copyConversation":
		case "dismissInstallPrompt":
		case "attachActiveFile":
		case "attachSelection":
		case "pickModel":
		case "pickThinkingLevel":
			return { type: value.type };
		case "prompt": {
			const payload = parsePromptPayload(value.payload);
			return payload ? { type: "prompt", payload } : undefined;
		}
		case "compact":
			if (value.instructions !== undefined && !isBoundedString(value.instructions, MAX_COMPACT_INSTRUCTIONS_CHARS, true)) return undefined;
			return value.instructions === undefined ? { type: "compact" } : { type: "compact", instructions: value.instructions };
		case "forkFromUser":
			return isRequestId(value.ordinal) && value.ordinal <= MAX_FORK_ORDINAL ? { type: "forkFromUser", ordinal: value.ordinal } : undefined;
		case "browseChild":
			return isIdentifier(value.browseRef) ? { type: "browseChild", browseRef: value.browseRef } : undefined;
		case "noticeAction":
			return isIdentifier(value.id) ? { type: "noticeAction", id: value.id } : undefined;
		case "renameSession":
			return isBoundedString(value.name, MAX_NAME_CHARS, true) ? { type: "renameSession", name: value.name } : undefined;
		case "renameHistorySession":
			return isPath(value.path) && isIdentifier(value.sessionId) && isBoundedString(value.name, MAX_NAME_CHARS, true)
				? { type: "renameHistorySession", path: value.path, sessionId: value.sessionId, name: value.name }
				: undefined;
		case "stopSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "stopSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "archiveSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "archiveSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "deleteSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "deleteSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "draftChanged":
			return isBoundedString(value.text, MAX_DRAFT_CHARS, true) && isIdentifier(value.sessionId)
				? { type: "draftChanged", text: value.text, sessionId: value.sessionId }
				: undefined;
		case "setCompactThreshold":
			return value.percent === null || (isLineNumber(value.percent) && value.percent >= 20 && value.percent <= 97)
				? { type: "setCompactThreshold", percent: value.percent }
				: undefined;
		case "searchHistory":
			return isBoundedString(value.query, MAX_QUERY_CHARS, true) ? { type: "searchHistory", query: value.query } : undefined;
		case "setModel":
			return isBoundedString(value.provider, MAX_IDENTIFIER_CHARS) && isBoundedString(value.modelId, MAX_IDENTIFIER_CHARS)
				? { type: "setModel", provider: value.provider, modelId: value.modelId }
				: undefined;
		case "setThinkingLevel":
			return isBoundedString(value.level, MAX_IDENTIFIER_CHARS) ? { type: "setThinkingLevel", level: value.level } : undefined;
		case "switchSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "switchSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "searchFiles":
			return isBoundedString(value.query, MAX_QUERY_CHARS, true) && isRequestId(value.requestId)
				? { type: "searchFiles", query: value.query, requestId: value.requestId }
				: undefined;
		case "openFile": {
			if (!isPath(value.path)) return undefined;
			if (value.startLine !== undefined && !isLineNumber(value.startLine)) return undefined;
			if (value.endLine !== undefined && !isLineNumber(value.endLine)) return undefined;
			if (value.endLine !== undefined && (value.startLine === undefined || value.endLine < value.startLine)) return undefined;
			return {
				type: "openFile",
				path: value.path,
				...(value.startLine === undefined ? {} : { startLine: value.startLine }),
				...(value.endLine === undefined ? {} : { endLine: value.endLine }),
			};
		}
		case "pickImage":
			return isRequestId(value.requestId) ? { type: "pickImage", requestId: value.requestId } : undefined;
		case "toggleFavoriteModel":
			return isBoundedString(value.provider, MAX_IDENTIFIER_CHARS) && isBoundedString(value.modelId, MAX_IDENTIFIER_CHARS)
				? { type: "toggleFavoriteModel", provider: value.provider, modelId: value.modelId }
				: undefined;
		case "openExternal":
			return isBoundedString(value.url, MAX_PATH_CHARS) ? { type: "openExternal", url: value.url } : undefined;
		default:
			return undefined;
	}
}
