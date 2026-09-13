/**
 * Composer: textarea card with attachment chips, @ / slash autocomplete,
 * steering behavior picker, context meter, and Send/Stop controls.
 *
 * Slash items from the agent catalog are inserted and sent as prompts.
 * `/model`, `/effort`, `/thinking`, `/stash`, and `/new` are local UI commands:
 * they never go to the model.
 */

import { Dropdown, type DropdownItem } from "./dropdown.js";
import { fitImageDataUrl, MAX_DECODED_IMAGE_BYTES, planImageFit } from "./image-fit.js";
import { el, icon, iconButton, svgIcon } from "./dom.js";
import type { ChatViewState, ComposerAttachment, ImageAttachment, ModelRef, RpcModel, RpcSlashCommand, SelectionAttachment } from "../src/protocol.js";

/** Keys that move the caret without producing an input event. */
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
/** Previous prompts kept for Up/Down recall. Deep enough for a long thread. */
const PROMPT_HISTORY_MAX = 200;
const MAX_IMAGES = 8;
// 7 MiB decoded ≈ 9.79 MB base64, under the provider's 10 MB wire ceiling
// (measured on the encoded payload, not the file). A byte-level send cap this
// low would just refuse screenshots, so oversized images are resized on
// attach instead — see image-fit.js.
const MAX_IMAGE_BYTES = MAX_DECODED_IMAGE_BYTES;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

type UiSlashAction = "model" | "effort" | "stash" | "new";

const UI_SLASH_COMMANDS: Array<{ name: string; description: string; action: UiSlashAction }> = [
	{ name: "model", description: "Select model", action: "model" },
	{ name: "effort", description: "Select thinking level", action: "effort" },
	{ name: "thinking", description: "Select thinking level", action: "effort" },
	{ name: "stash", description: "Stash or restore the current prompt", action: "stash" },
	{ name: "new", description: "Start a new session", action: "new" },
];

const UI_SLASH_BY_NAME = new Map(UI_SLASH_COMMANDS.map((command) => [command.name, command.action]));

interface ComposerStash {
	text: string;
	images: ImageAttachment[];
	selections: SelectionAttachment[];
	accepted: string[];
	attachments?: ComposerAttachment[];
}

function emptyStash(): ComposerStash {
	return { text: "", images: [], selections: [], accepted: [] };
}

function stashHasContent(stash: ComposerStash): boolean {
	return stash.text.trim().length > 0 || stash.images.length > 0 || stash.selections.length > 0;
}

function cloneStash(stash: ComposerStash): ComposerStash {
	return {
		text: stash.text,
		images: [...stash.images],
		selections: [...stash.selections],
		accepted: [...stash.accepted],
		attachments: stash.attachments?.map((a) => ({ ...a })),
	};
}

/** Decoded byte count without allocating an image-sized buffer in the webview. */
function base64Bytes(value: string): number {
	const compact = value.replace(/\s/g, "");
	if (compact.length === 0) return 0;
	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

export interface ComposerDeps {
	onSend: (text: string, images: ImageAttachment[], selections: SelectionAttachment[], attachments?: ComposerAttachment[]) => void;
	onCreateAttachment: (attachment: ComposerAttachment) => void;
	onOpenAttachment: (id: string) => void;
	onStop: () => void;
	onSearchFiles: (query: string, requestId: number) => void;
	onPickImage: () => void;
	onAttachSelection: () => void;
	onAttachActiveFile: () => void;
	onSetModel: (provider: string, modelId: string) => void;
	onSetThinking: (level: string) => void;
	onToggleFavorite: (provider: string, modelId: string) => void;
	onOpenFile: (path: string, startLine?: number, endLine?: number) => void;
	onDraftChanged: (text: string, attachmentDraft?: { text: string; attachments: ComposerAttachment[] }) => void;
	onNewSession: () => void;
}

export class Composer {
	readonly root: HTMLElement;
	private textarea: HTMLTextAreaElement;
	private chipsEl: HTMLElement;
	private sendBtn: HTMLButtonElement;
	private stopBtn: HTMLButtonElement;
	private behaviorBtn: HTMLButtonElement;
	private contextWrap: HTMLElement;
	private contextLabel: HTMLElement;
	private modelBtn: HTMLButtonElement;
	private modelLabelEl: HTMLElement;
	private brainBtn: HTMLButtonElement;
	private availableThinkingLevels: string[] | null = null;
	private currentDisplayedLabel: string | null = null;
	private attachMenu: Dropdown | null = null;
	private autocompleteEl: HTMLElement;
	private textWrap: HTMLElement;
	private mirror: HTMLElement;
	private hintEl: HTMLElement | null = null;
	private hintTimer: number | undefined;

	private editRange: { start: number; end: number } | null = null;
	private attachments: ComposerAttachment[] = [];
	private attachmentRegistry = new Map<string, ComposerAttachment>();
	private attachmentErrors = new Map<string, string>();
	private attachmentSerial = 0;
	private sessionGeneration = 0;
	private trackedText = "";
	private undoEdits: Array<{ text: string; attachments: ComposerAttachment[] }> = [];
	private redoEdits: Array<{ text: string; attachments: ComposerAttachment[] }> = [];

	private images: ImageAttachment[] = [];
	private selections: SelectionAttachment[] = [];
	private commands: RpcSlashCommand[] = [];
	private streaming = false;
	/** Starts false: until a status says the agent answers, we cannot send a prompt. */
	private enabled = false;
	/** Lets a new, connecting chat collect its draft before sending is available. */
	private draftAllowed = true;
	private observing = false;
	/** Host-supplied reason the composer is blocked, if any. */
	private blockedReason: string | null = null;
	private behavior: "steer" | "followUp" = "steer";
	private models: RpcModel[] = [];
	private favorites: ModelRef[] = [];
	private currentModel: { provider?: string; modelId?: string } = {};
	private currentThinking = "off";
	private reasoning = true;
	private vision = false;
	private steerDefault: "steer" | "followUp" = "steer";
	private modelMenu: Dropdown | null = null;
	private thinkingMenu: Dropdown | null = null;

	private acItems: Array<{ label: string; sub?: string; insert: string; dir?: boolean; action?: UiSlashAction }> = [];
	private acSelected = 0;
	private acKind: "slash" | "mention" | null = null;
	private promptStash: ComposerStash | null = null;
	private lastNonSlashDraft: ComposerStash = emptyStash();
	private restoreStashAfterPicker = false;
	private suppressPickerHide = false;
	private acRequestId = 0;
	private mentionDebounce: number | undefined;
	private draftDebounce: number | undefined;
	/**
	 * Paths the operator actually picked from the file search. `LICENSE`,
	 * `.gitignore` and every extensionless file are indistinguishable from a
	 * plain word by pattern alone — the accept is the only evidence they are
	 * mentions, and #19 asked for a mention to *look* selected.
	 */
	private accepted = new Set<string>();
	/** IME composition range in `textarea.value`, painted on the mirror. */
	private composing = false;
	private compositionUndoIndex: number | null = null;
	private compositionStart = 0;
	private compositionEnd = 0;
	/** Confirming an IME candidate with Enter must not also send the prompt. */
	private swallowEnterAfterComposition = false;

	constructor(private readonly deps: ComposerDeps) {
		this.root = el("div", "composer-dock");
		this.chipsEl = el("div", "composer-chips");

		const card = el("div", "composer-card");
		this.textarea = document.createElement("textarea");
		this.textarea.rows = 1;
		this.textarea.placeholder = "Message Brief…";

		const rail = el("div", "composer-rail");
		const attachBtn = iconButton("plus", "Attach @file, selection, image…", 15);
		attachBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleAttachMenu(attachBtn);
		});

		this.modelBtn = document.createElement("button");
		this.modelBtn.className = "rail-pill model";
		this.modelBtn.title = "Choose model";
		this.modelLabelEl = el("span", "pill-label", "Choose model");
		this.modelBtn.appendChild(this.modelLabelEl);
		this.modelBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleModelMenu();
		});
		this.brainBtn = document.createElement("button");
		this.brainBtn.className = "rail-pill brain";
		this.brainBtn.title = "Thinking level";
		this.brainBtn.appendChild(icon("brain", 13));
		this.brainBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleThinkingMenu();
		});

		this.behaviorBtn = document.createElement("button");
		this.behaviorBtn.className = "rail-pill subtle behavior";
		this.behaviorBtn.style.display = "none";
		this.behaviorBtn.title = "How a message is delivered while the agent is working";
		this.behaviorBtn.addEventListener("click", () => this.toggleBehavior());

		this.contextWrap = el("div", "context-meter");
		this.contextLabel = el("span", "context-label", "");
		this.contextWrap.append(this.contextLabel);

		this.sendBtn = document.createElement("button");
		this.sendBtn.className = "send-btn muted";
		this.sendBtn.title = "Send (Enter)";
		this.sendBtn.appendChild(icon("send", 15));
		this.sendBtn.addEventListener("click", () => this.send());

		this.stopBtn = document.createElement("button");
		this.stopBtn.className = "send-btn stop";
		this.stopBtn.title = "Stop run (Esc)";
		this.stopBtn.appendChild(icon("stop", 13));
		this.stopBtn.style.display = "none";
		this.stopBtn.addEventListener("click", () => this.deps.onStop());

		rail.append(attachBtn, this.modelBtn, this.brainBtn, this.behaviorBtn, el("span", "spacer"), this.contextWrap, this.stopBtn, this.sendBtn);
		// Mentions render inline-styled via a mirrored layer behind a transparent textarea.
		this.textWrap = el("div", "composer-text-wrap");
		this.mirror = el("div", "composer-mirror");
		this.textWrap.append(this.mirror, this.textarea);
		card.append(this.textWrap, rail);
		this.root.append(this.chipsEl, card);

		this.autocompleteEl = el("div", "autocomplete");
		card.appendChild(this.autocompleteEl);

		this.textarea.addEventListener("keydown", (event) => this.onKeyDown(event));
		this.textarea.addEventListener("beforeinput", (event) => this.beforeEdit(event));
		this.textarea.addEventListener("compositionstart", () => {
			this.expandAttachmentSelection();
			this.compositionUndoIndex = this.undoEdits.length;
			this.composing = true;
			const caret = this.textarea.selectionStart ?? 0;
			this.compositionStart = caret;
			this.compositionEnd = caret;
		});
		this.textarea.addEventListener("compositionupdate", (event) => {
			this.refreshCompositionRange(event.data);
			this.autoGrow();
		});
		this.textarea.addEventListener("compositionend", () => {
			this.composing = false;
			if (this.compositionUndoIndex !== null) this.undoEdits.splice(this.compositionUndoIndex + 1);
			this.compositionUndoIndex = null;
			this.compositionStart = 0;
			this.compositionEnd = 0;
			// Chromium fires keydown Enter after compositionend for a confirm.
			this.swallowEnterAfterComposition = true;
			window.setTimeout(() => { this.swallowEnterAfterComposition = false; }, 0);
			this.autoGrow();
		});
		this.textarea.addEventListener("input", (event) => {
			const inputType = (event as InputEvent).inputType;
			if (inputType === "historyUndo" || inputType === "historyRedo") {
				this.restoreNativeEdit(inputType === "historyRedo"); return;
			}
			// Real typing ends history browsing: from here the text is the
			// operator's, so Up must go back to moving the caret.
			this.historyIndex = null;
			this.reconcileAttachments();
			this.rememberNonSlashDraft();
			if (this.composing) this.refreshCompositionRange();
			this.autoGrow();
			if (!this.composing) this.updateAutocomplete();
			window.clearTimeout(this.draftDebounce);
			this.draftDebounce = window.setTimeout(() => this.draftChanged(), 300);
		});
		// The caret moves without an input event too. A mention armed at one offset
		// and accepted at another splices the path into the middle of the line, and
		// a panel left armed over zero results swallows Enter with nothing on screen.
		this.textarea.addEventListener("click", (event) => {
			if (event.ctrlKey || event.metaKey) {
				for (const span of Array.from(this.mirror.querySelectorAll<HTMLElement>(".attachment-marker"))) {
					if (Array.from(span.getClientRects()).some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) {
						this.deps.onOpenAttachment(span.dataset.id!); return;
					}
				}
			}
			this.updateAutocomplete();
		});
		this.textarea.addEventListener("keyup", (event) => {
			// ArrowUp/Down belong to the open panel — they move the selection, not the caret.
			if (CARET_KEYS.has(event.key) && !this.composing) this.updateAutocomplete();
		});
		this.textarea.addEventListener("scroll", () => {
			if (this.mirror) this.mirror.scrollTop = this.textarea.scrollTop;
		});
		this.textarea.addEventListener("mousemove", (event) => this.updateMentionHover(event));
		this.textarea.addEventListener("mouseleave", () => {
			if (this.textarea.title) this.textarea.title = "";
		});
		this.textarea.addEventListener("paste", (event) => this.onPaste(event));
		this.textarea.addEventListener("drop", (event) => this.onDrop(event));
		this.textarea.addEventListener("dragover", (event) => event.preventDefault());
		this.autoGrow();
		this.updateBehaviorLabel();
		// Honest from the first frame: nothing has told us the agent answers yet.
		this.applyInputState();
	}

	// ---------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------

	captureViewState(): ChatViewState["composer"] {
		if (this.composing || this.attachments.some((a) => a.status === "pending")) throw new Error("Finish composing or attaching images before moving this chat.");
		// Picker menus are portaled outside the inert app. Closing a slash picker
		// also puts its parked draft back before we take the transfer snapshot.
		this.attachMenu?.hide();
		this.modelMenu?.hide();
		this.thinkingMenu?.hide();
		this.closeAutocomplete();
		this.flushDraft();
		return {
			draft: this.snapshotComposer(), stash: this.promptStash ? cloneStash(this.promptStash) : null,
			lastNonSlashDraft: cloneStash(this.lastNonSlashDraft),
			selectionStart: this.textarea.selectionStart, selectionEnd: this.textarea.selectionEnd, behavior: this.behavior,
		};
	}

	restoreViewState(state: ChatViewState["composer"]): void {
		this.applyComposerSnapshot(state.draft);
		this.promptStash = state.stash ? cloneStash(state.stash) : null;
		this.lastNonSlashDraft = cloneStash(state.lastNonSlashDraft);
		this.textarea.setSelectionRange(state.selectionStart, state.selectionEnd);
		this.behavior = state.behavior;
		this.updateBehaviorLabel();
		this.flushDraft();
	}

	setCommands(commands: RpcSlashCommand[]): void {
		this.commands = commands.filter((command) => !UI_SLASH_BY_NAME.has(command.name));
	}

	setModels(models: RpcModel[]): void {
		this.models = models;
		this.updateReasoningState();
	}

	setFavorites(favorites: ModelRef[]): void {
		this.favorites = favorites;
	}

	setModel(label: string, provider?: string, modelId?: string): void {
		// Debug hook: instrument setModel label churn to catch menu-killers live.
		const dbg = window as unknown as { __modelLog?: string[] };
		if (Array.isArray(dbg.__modelLog)) {
			dbg.__modelLog.push(`${this.currentModel.modelId ?? "?"}|${this.modelBtn.textContent} -> ${provider ?? "?"}/${modelId ?? "?"}|${label}`);
		}
		// Compare the full label, not its truncated display, to avoid repeating
		// label and capability writes on unchanged status updates.
		const unchanged =
			this.currentModel.provider === provider &&
			this.currentModel.modelId === modelId &&
			this.currentDisplayedLabel === label;
		if (unchanged) return;
		// The level list belongs to the outgoing model; carrying it into the new
		// one would offer levels the new model rejects until the next status lands.
		this.availableThinkingLevels = null;
		this.currentModel = { provider, modelId };
		this.currentDisplayedLabel = label;
		this.modelLabelEl.textContent = this.truncateModelLabel(label);
		this.modelBtn.title = `${label} — click to choose a model (full name on hover)`;
		this.updateReasoningState();
	}

	setThinking(level: string, availableLevels?: string[] | null): void {
		// "max" is a real level, distinct from "xhigh" — several models (Kimi K3 TEE)
		// support max and nothing else. Aliasing it made the pill read a level the
		// operator could not have chosen and never marked the current row.
		this.currentThinking = level;
		// Assign unconditionally: an absent list means "we don't know this model",
		// and keeping the last model's list is how stale levels survive a switch.
		this.availableThinkingLevels = Array.isArray(availableLevels) && availableLevels.length > 0 ? [...availableLevels] : null;
		if (this.reasoning) this.brainBtn.title = `Thinking level: ${this.currentThinking}`;
	}

	setObserving(observing: boolean): void {
		this.observing = observing;
		this.applyInputState();
		this.applyRunControls();
	}

	/**
	 * Offline means offline: an armed composer over an agent that does not answer
	 * buys the operator an optimistic bubble and a 120s timeout, nothing else.
	 */
	setEnabled(enabled: boolean, blockedReason: string | null = null, draftAllowed = false): void {
		this.enabled = enabled;
		this.draftAllowed = draftAllowed;
		this.blockedReason = enabled ? null : blockedReason;
		this.applyInputState();
	}

	/** True while a prompt would actually go somewhere. */
	private canSend(): boolean {
		return this.enabled && !this.observing;
	}

	private applyInputState(): void {
		const blocked = !this.canSend();
		this.textarea.disabled = this.observing || (!this.enabled && !this.draftAllowed);
		this.sendBtn.disabled = blocked;
		this.sendBtn.classList.toggle("unavailable", !this.enabled && !this.observing);
		const sendLabel = !this.enabled ? (this.blockedReason ?? "Connecting — send unavailable") : "Send (Enter)";
		this.sendBtn.title = sendLabel;
		this.sendBtn.setAttribute("aria-label", sendLabel);
		this.textarea.placeholder = this.observing
			? "Watching a live session — read-only"
			: this.enabled || this.draftAllowed
				? "Message Brief…"
				: (this.blockedReason ?? "Not connected — the agent runtime isn't answering");
		this.updateSendState();
	}

	setSteerDefault(behavior: "steer" | "followUp"): void {
		this.steerDefault = behavior;
		if (!this.streaming) this.behavior = behavior;
		this.updateBehaviorLabel();
	}

	private currentModelInfo(): RpcModel | undefined {
		return this.models.find((m) => m.provider === this.currentModel.provider && m.id === this.currentModel.modelId);
	}

	private updateReasoningState(): void {
		const model = this.currentModelInfo();
		this.reasoning = model?.reasoning ?? true;
		// Only block when the model is KNOWN to be text-only; undeclared input
		// fields mean "allow" so we don't silently eat pastes.
		this.vision = model?.input ? model.input.includes("image") : true;
		const visionNote = this.vision ? " (accepts images)" : " (text-only, image attach off)";
		// Rebuild from the model label only — reading modelBtn.title back would
		// re-append the suffix on every models/status push until the tooltip is a wall.
		this.modelBtn.title = `${this.currentDisplayedLabel ?? "Choose model"} — click to choose a model${visionNote}`;
		this.brainBtn.classList.toggle("disabled-pill", !this.reasoning);
		this.brainBtn.title = this.reasoning ? `Thinking level: ${this.currentThinking}` : "This model does not support thinking";
		this.brainBtn.disabled = !this.reasoning;
	}

	private showHint(text: string): void {
		if (!this.hintEl) {
			this.hintEl = el("div", "composer-hint");
			this.root.appendChild(this.hintEl);
		}
		this.hintEl.textContent = text;
		this.hintEl.classList.add("visible");
		window.clearTimeout(this.hintTimer);
		this.hintTimer = window.setTimeout(() => this.hintEl?.classList.remove("visible"), 3500);
	}

	private toggleAttachMenu(anchor: HTMLButtonElement): void {
		if (this.attachMenu?.isOpen()) {
			this.attachMenu.hide();
			return;
		}
		const items: DropdownItem[] = [
			{
				label: "Mention a file in chat",
				sub: "Type @ then search the workspace index",
				section: "Attach",
				onSelect: () => {
					this.insertTextAtCaret("@");
					this.updateAutocomplete();
				},
			},
			{ label: "Active editor file", sub: "Reference the file you're editing", onSelect: () => this.deps.onAttachActiveFile() },
			{ label: "Editor selection", sub: "Attach the selected lines as context", onSelect: () => this.deps.onAttachSelection() },
			{
				label: "Image…",
				sub: this.vision ? "Attach a png/jpg/webp screenshot or photo" : "Current model doesn't accept images",
				disabled: !this.vision,
				onSelect: () => this.deps.onPickImage(),
			},
		];
		this.modelMenu?.hide();
		this.thinkingMenu?.hide();
		this.attachMenu = new Dropdown(anchor, {});
		this.attachMenu.show(items);
	}

	private insertTextAtCaret(text: string): void {
		const caret = this.textarea.selectionStart ?? this.textarea.value.length;
		const before = this.textarea.value.slice(0, caret);
		// currentMentionQuery() only recognises an "@" at the start of the input or
		// after whitespace, so appending one to "…changes in" opened nothing and
		// left a stray character. Separate it the way insertMention already does.
		const sep = before && !/\s$/.test(before) ? " " : "";
		this.historyIndex = null;
		this.textarea.value = `${before}${sep}${text}${this.textarea.value.slice(caret)}`;
		this.textarea.selectionStart = this.textarea.selectionEnd = before.length + sep.length + text.length;
		this.autoGrow();
		this.textarea.focus();
	}

	setStreaming(streaming: boolean): void {
		this.streaming = streaming;
		this.applyRunControls();
		// Back to the configured default between runs — not hard-coded "steer",
		// which silently overrode brief.defaultStreamingBehavior=followUp.
		if (!streaming) this.behavior = this.steerDefault;
		this.updateBehaviorLabel();
	}

	private applyRunControls(): void {
		// Never while observing: this Stop belongs to our own session, and the run
		// on screen is owned by another client. Offering it there is a lie.
		const show = this.streaming && !this.observing;
		this.stopBtn.style.display = show ? "" : "none";
		this.behaviorBtn.style.display = show ? "" : "none";
	}

	// Parameter deliberately NOT named `window`: this class calls window.setTimeout
	// elsewhere, and shadowing the global with a number here is a TypeError
	// waiting for the next line of code added to this method.
	setContext(percent: number | null | undefined, tokens: number | null | undefined, contextWindow: number | undefined, compactThreshold: number | null, compactDefaultPercent: number | null): void {
		this.contextPercentCurrent = percent ?? null;
		this.contextTokensCurrent = tokens ?? null;
		this.contextWindowCurrent = contextWindow;
		this.setCompactThreshold(compactThreshold, compactDefaultPercent);
	}

	private renderContext(): void {
		const contextWindow = this.contextWindowCurrent;
		const percent = contextWindow == null ? null : this.contextPercentCurrent;
		const effective = this.compactThreshold ?? this.compactDefaultPercent;
		this.contextWrap.style.display = contextWindow == null ? "none" : "";
		this.contextLabel.classList.toggle("warm", percent != null && effective != null && percent >= effective);
		const label = percent == null ? "Context pending" : `Context ${Math.round(percent)}%`;
		const usedK = this.contextTokensCurrent == null ? "pending" : `${Math.round(this.contextTokensCurrent / 1000)}K`;
		const totalK = contextWindow == null ? "pending" : `${Math.round(contextWindow / 1000)}K`;
		this.contextLabel.textContent = `${label} · ${usedK} / ${totalK}`;
		const used = this.contextTokensCurrent == null ? "pending" : this.contextTokensCurrent.toLocaleString("en-US");
		const total = contextWindow == null ? "pending" : contextWindow.toLocaleString("en-US");
		this.contextWrap.title = `${label} · ${used} / ${total} tokens`;
	}

	private contextPercentCurrent: number | null = null;
	private contextTokensCurrent: number | null = null;
	private contextWindowCurrent: number | undefined;
	private compactThreshold: number | null = null;
	private compactDefaultPercent: number | null = null;

	setCompactThreshold(percent: number | null, defaultPercent: number | null = null): void {
		this.compactThreshold = percent;
		this.compactDefaultPercent = defaultPercent;
		this.renderContext();
	}

	addSelection(selection: SelectionAttachment): void {
		this.selections.push(selection);
		this.renderChips();
		this.focus();
	}

	private imagePicks = new Map<number, { attachment: ComposerAttachment; generation: number; replacedText: string; replacedAttachments: ComposerAttachment[] }>();

	beginImagePick(requestId: number): void {
		this.expandAttachmentSelection();
		const start = this.textarea.selectionStart, end = this.textarea.selectionEnd;
		const replacedText = this.textarea.value.slice(start, end);
		const replacedAttachments = this.attachments.filter((a) => a.start >= start && a.end <= end)
			.map((a) => ({ ...a, start: a.start - start, end: a.end - start }));
		const attachment = this.reserveAttachment("image");
		if (attachment) this.imagePicks.set(requestId, { attachment, generation: this.sessionGeneration, replacedText, replacedAttachments });
	}

	imagePicked(requestId: number, images: ImageAttachment[]): void {
		const pick = this.imagePicks.get(requestId); this.imagePicks.delete(requestId);
		if (!pick || pick.generation !== this.sessionGeneration) return;
		const current = this.attachments.find((a) => a.id === pick.attachment.id);
		if (!current) return;
		if (!images.length || !this.vision) {
			if (current.status !== "pending") return;
			const cancelled = this.attachmentRegistry.get(current.id);
			if (cancelled) cancelled.status = "error";
			this.attachmentErrors.set(current.id, images.length
				? "Current model is text-only. Remove this attachment or undo again."
				: "Image selection was cancelled. Remove this attachment or undo again.");
			const start = current.start;
			this.replaceTracked(start, current.end, pick.replacedText);
			for (const a of pick.replacedAttachments) {
				const cached = this.attachmentRegistry.get(a.id);
				this.attachments.push({ ...a, start: start + a.start, end: start + a.end,
					status: cached?.status ?? a.status, text: cached?.text ?? a.text, image: cached?.image ?? a.image });
			}
			this.attachments.sort((a, b) => a.start - b.start);
			this.changedAttachments();
			if (images.length) this.showHint("Current model is text-only — switch to a vision model to attach images.");
			return;
		}
		void this.finishImage(current, images[0], pick.generation);
		this.textarea.setSelectionRange(current.end, current.end);
		this.addImages(images.slice(1));
	}

	attachmentCreated(id: string, error?: string): void {
		const registered = this.attachmentRegistry.get(id);
		if (!registered) return;
		registered.status = error ? "error" : "ready";
		if (error) this.attachmentErrors.set(id, error); else this.attachmentErrors.delete(id);
		for (const a of this.attachments) if (a.id === id) a.status = registered.status;
		if (error) this.showHint(error);
		this.changedAttachments();
	}

	private draftChanged(): void {
		const expanded = this.expandedText();
		if (expanded.length > 200_000 || expanded.includes("\0")) {
			this.showHint("Draft exceeds 200,000 characters or contains NUL. Shorten it before saving or sending.");
			return;
		}
		this.deps.onDraftChanged(expanded, this.attachments.length ? {
			text: this.textarea.value, attachments: this.attachments.map((a) => ({ ...a })),
		} : undefined);
	}

	private expandedText(): string {
		let text = this.textarea.value;
		for (const a of [...this.attachments].sort((a, b) => b.start - a.start)) {
			text = text.slice(0, a.start) + (a.kind === "text" ? a.text ?? "" : "") + text.slice(a.end);
		}
		return text;
	}

	private editSnapshot(): { text: string; attachments: ComposerAttachment[] } {
		return { text: this.trackedText, attachments: this.attachments.map((a) => ({ ...a })) };
	}

	private restoreEdit(redo: boolean): void {
		const from = redo ? this.redoEdits : this.undoEdits;
		const next = from.pop(); if (!next) return;
		(redo ? this.undoEdits : this.redoEdits).push(this.editSnapshot());
		this.trackedText = this.textarea.value = next.text;
		this.attachments = next.attachments.map((a) => {
			const cached = this.attachmentRegistry.get(a.id);
			return { ...a, status: cached?.status ?? a.status, text: cached?.text ?? a.text, image: cached?.image ?? a.image };
		});
		this.textarea.setSelectionRange(next.text.length, next.text.length);
		this.changedAttachments();
	}

	private restoreNativeEdit(redo: boolean): void {
		const from = redo ? this.redoEdits : this.undoEdits;
		// Chromium can coalesce ordinary typing. Only a browser history event
		// can select a saved edit; literal marker-looking input never does.
		let index = from.length - 1;
		while (index >= 0 && from[index].text !== this.textarea.value) index--;
		if (index < 0) { this.reconcileAttachments(); this.changedAttachments(); return; }
		const next = from[index];
		(redo ? this.undoEdits : this.redoEdits).push(this.editSnapshot());
		from.splice(index);
		this.trackedText = next.text; this.editRange = null;
		this.attachments = next.attachments.map((a) => {
			const cached = this.attachmentRegistry.get(a.id);
			return { ...a, status: cached?.status ?? a.status, text: cached?.text ?? a.text, image: cached?.image ?? a.image };
		});
		this.changedAttachments();
	}

	private expandAttachmentSelection(inputType = ""): void {
		let start = this.textarea.selectionStart, end = this.textarea.selectionEnd;
		if (start === end) {
			if (inputType === "deleteContentBackward") start = Math.max(0, start - 1);
			if (inputType === "deleteContentForward") end = Math.min(this.textarea.value.length, end + 1);
		}
		for (const a of this.attachments) {
			if ((start < a.end && end > a.start) || (start === end && start > a.start && start < a.end)) {
				start = Math.min(start, a.start); end = Math.max(end, a.end);
			}
		}
		this.textarea.setSelectionRange(start, end);
	}

	private beforeEdit(event: InputEvent): void {
		if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
			if (typeof document.execCommand !== "function") { event.preventDefault(); this.restoreEdit(event.inputType === "historyRedo"); }
			return;
		}
		if (!this.composing) this.expandAttachmentSelection(event.inputType);
		this.editRange = { start: this.textarea.selectionStart, end: this.textarea.selectionEnd };
	}

	private reconcileAttachments(): void {
		let next = this.textarea.value;
		const old = this.trackedText;
		const range = this.editRange; this.editRange = null;
		if (next === old && (!range || range.start === range.end)) return;
		this.undoEdits.push(this.editSnapshot());
		if (this.undoEdits.length > 200) this.undoEdits.shift();
		this.redoEdits = [];
		let start = 0;
		while (start < old.length && start < next.length && old[start] === next[start]) start++;
		let oldEnd = old.length, newEnd = next.length;
		while (oldEnd > start && newEnd > start && old[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
		if (range && old.slice(0, range.start) === next.slice(0, range.start) && old.slice(range.end) === next.slice(range.end + next.length - old.length)) {
			start = range.start; oldEnd = range.end; newEnd = range.end + next.length - old.length;
		}
		// Non-cancelable input (IME, browser word deletion) may skip beforeinput.
		// Expand its actual edit against owned ranges, never against marker text.
		let expandedStart = start, expandedEnd = oldEnd;
		for (const a of this.attachments) {
			if ((start < a.end && oldEnd > a.start) || (start === oldEnd && start > a.start && start < a.end)) {
				expandedStart = Math.min(expandedStart, a.start); expandedEnd = Math.max(expandedEnd, a.end);
			}
		}
		if (expandedStart !== start || expandedEnd !== oldEnd) {
			const inserted = next.slice(start, newEnd);
			next = old.slice(0, expandedStart) + inserted + old.slice(expandedEnd);
			start = expandedStart; oldEnd = expandedEnd; newEnd = start + inserted.length;
			this.textarea.value = next; this.textarea.setSelectionRange(newEnd, newEnd);
		}
		const delta = newEnd - oldEnd;
		this.attachments = this.attachments.filter((a) => {
			if (a.end <= start) return true;
			if (a.start >= oldEnd) { a.start += delta; a.end += delta; return true; }
			return false;
		});
		this.trackedText = next;
		this.renderChips();
	}

	private replaceTracked(start: number, end: number, text: string): void {
		this.textarea.setSelectionRange(start, end);
		this.expandAttachmentSelection();
		start = this.textarea.selectionStart; end = this.textarea.selectionEnd;
		this.editRange = { start, end };
		// insertText is the textarea editing command that preserves Chromium's
		// native undo stack (including menu Undo/Redo and earlier typing).
		this.textarea.focus();
		if (typeof document.execCommand !== "function" || !document.execCommand("insertText", false, text)) {
			this.textarea.value = this.textarea.value.slice(0, start) + text + this.textarea.value.slice(end);
		}
		this.textarea.setSelectionRange(start + text.length, start + text.length);
		this.reconcileAttachments();
		this.changedAttachments();
	}

	private reserveAttachment(kind: "text" | "image"): ComposerAttachment | null {
		if (this.textarea.disabled) return null;
		if (this.attachments.length >= 64) { this.showHint("Maximum 64 attachments per prompt."); return null; }
		if (kind === "image" && this.attachments.filter((a) => a.kind === "image").length + this.images.length >= MAX_IMAGES) {
			this.showHint("Maximum 8 images per prompt."); return null;
		}
		this.expandAttachmentSelection();
		const start = this.textarea.selectionStart;
		let label: string;
		do { label = `${kind === "text" ? "Text" : "Image"} ${++this.attachmentSerial}`; }
		while ([...this.attachmentRegistry.values()].some((a) => a.label === label));
		const marker = `[${label}]`;
		this.replaceTracked(start, this.textarea.selectionEnd, marker);
		const a: ComposerAttachment = { id: crypto.randomUUID(), kind, label, start, end: start + marker.length, status: "pending" };
		this.attachments.push(a); this.attachments.sort((a, b) => a.start - b.start);
		this.attachmentRegistry.set(a.id, a);
		this.changedAttachments(); return a;
	}

	private changedAttachments(): void {
		this.renderChips(); this.autoGrow(); this.rememberNonSlashDraft();
		window.clearTimeout(this.draftDebounce);
		this.draftDebounce = window.setTimeout(() => this.draftChanged(), 300);
	}

	addImages(images: ImageAttachment[]): void {
		if (!this.vision) { this.showHint("Current model is text-only — switch to a vision model to attach images."); return; }
		for (const image of images) {
			const attachment = this.reserveAttachment("image");
			if (attachment) void this.finishImage(attachment, image, this.sessionGeneration);
		}
	}

	private async finishImage(attachment: ComposerAttachment, raw: ImageAttachment, generation: number): Promise<void> {
		try {
			const fitted = planImageFit(base64Bytes(raw.data)).action === "send" ? raw : await fitImageDataUrl(raw);
			if (generation !== this.sessionGeneration) return;
			const image = fitted ? { ...fitted, name: raw.name } : raw;
			const total = this.attachments.reduce((n, a) => n + (a.image ? base64Bytes(a.image.data) : 0), this.images.reduce((n, image) => n + base64Bytes(image.data), 0));
			if (!SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType) || base64Bytes(image.data) > MAX_IMAGE_BYTES || total + base64Bytes(image.data) > MAX_TOTAL_IMAGE_BYTES) throw new Error("Image exceeds attachment limits");
			attachment.image = image;
			this.deps.onCreateAttachment({ ...attachment });
		} catch (error) {
			if (generation === this.sessionGeneration) this.attachmentCreated(attachment.id, String(error));
		}
		if (generation === this.sessionGeneration) { this.renderChips(); this.autoGrow(); }
	}

	insertMention(path: string): void {
		this.accepted.add(path);
		const caret = this.textarea.selectionStart ?? this.textarea.value.length;
		const before = this.textarea.value.slice(0, caret);
		const after = this.textarea.value.slice(caret);
		const sep = before && !before.endsWith("\n") && !before.endsWith(" ") ? " " : "";
		this.historyIndex = null;
		this.textarea.value = `${before}${sep}@${path} ${after}`;
		const pos = before.length + sep.length + path.length + 2;
		this.textarea.selectionStart = this.textarea.selectionEnd = pos;
		this.autoGrow();
		this.focus();
	}

	textIsEmpty(): boolean {
		return this.textarea.value.trim() === "";
	}

	/** Restore one rejected send without overwriting an intervening draft. */
	restoreRejectedPayload(text: string, images: ImageAttachment[], selections: SelectionAttachment[], attachments?: ComposerAttachment[]): boolean {
		if (this.textarea.value.trim() || this.images.length > 0 || this.selections.length > 0) return false;
		this.historyIndex = null;
		this.textarea.value = text;
		this.trackedText = text;
		this.attachments = attachments?.map((a) => ({ ...a })) ?? [];
		for (const a of this.attachments) this.attachmentRegistry.set(a.id, a);
		this.images = [...images];
		this.selections = [...selections];
		this.renderChips();
		this.autoGrow();
		this.draftChanged();
		this.focus();
		return true;
	}

	setText(text: string): void {
		this.attachments = [];
		this.historyIndex = null;
		this.textarea.value = text;
		this.autoGrow();
		this.focus();
	}

	/**
	 * Host-authoritative draft for the thread now on screen. An empty payload
	 * means "this thread has no draft" and must clear the box: the old
	 * only-if-non-empty rule carried thread A's unsent sentence into thread B,
	 * where the next keystroke persisted it over B's own draft.
	 */
	setDraft(text: string): void {
		this.attachments = [];
		this.historyIndex = null;
		this.textarea.value = text;
		this.autoGrow();
		// Don't steal focus back from History just to clear the box.
		if (text) this.focus();
	}

	/**
	 * Drop UI state that belongs to the session which just left the panel.
	 *
	 * A host snapshot/status is authoritative for a different session, whereas
	 * chips, autocomplete results, open pickers, and a debounced local draft are
	 * not. In particular, cancelling the debounce prevents its late write from
	 * becoming the incoming session's draft.
	 */
	resetForSessionBoundary(): void {
		this.sessionGeneration++;
		this.editRange = null;
		this.compositionUndoIndex = null;
		this.imagePicks.clear();
		this.attachments = [];
		this.attachmentRegistry.clear();
		this.attachmentErrors.clear();
		this.undoEdits = [];
		this.redoEdits = [];
		this.trackedText = "";
		window.clearTimeout(this.draftDebounce);
		this.draftDebounce = undefined;
		window.clearTimeout(this.mentionDebounce);
		this.mentionDebounce = undefined;

		this.textarea.value = "";
		this.textarea.selectionStart = this.textarea.selectionEnd = 0;
		this.textarea.title = "";
		this.images = [];
		this.selections = [];
		this.accepted.clear();
		// History belongs to the thread that just left; the incoming snapshot
		// seeds the new one.
		this.promptHistory = [];
		this.historyIndex = null;
		this.commands = [];
		this.promptStash = null;
		this.lastNonSlashDraft = emptyStash();
		this.restoreStashAfterPicker = false;
		this.acRequestId += 1;
		this.acSelected = 0;
		this.closeAutocomplete();

		this.attachMenu?.hide();
		this.attachMenu = null;
		this.modelMenu?.hide();
		this.modelMenu = null;
		this.thinkingMenu?.hide();
		this.thinkingMenu = null;
		window.clearTimeout(this.hintTimer);
		this.hintEl?.classList.remove("visible");

		this.renderChips();
		this.autoGrow();
	}

	/** Persist the last keystrokes under the OUTGOING session, before a switch. */
	flushDraft(): void {
		window.clearTimeout(this.draftDebounce);
		this.draftChanged();
	}

	focus(): void {
		this.textarea.focus();
	}

	onFileSearchResults(requestId: number, files: Array<{ path: string; isDir: boolean }> | string[]): void {
		if (this.acKind !== "mention" || requestId !== this.acRequestId) return;
		this.acItems = files.slice(0, 12).map((f) => {
			const item = typeof f === "string" ? { path: f, isDir: f.endsWith("/") } : f;
			return item.isDir
				? { label: `${item.path}/`, sub: "folder", insert: `${item.path}/`, dir: true }
				: { label: item.path, insert: item.path };
		});
		this.acSelected = 0;
		this.renderAutocomplete();
	}

	// ---------------------------------------------------------------
	// Sending
	// ---------------------------------------------------------------

	send(): void {
		if (this.composing || this.attachments.some((a) => a.status !== "ready")) return;
		if (this.expandedText().length > 200_000) { this.showHint("Prompt exceeds 200,000 characters. Remove or shorten an attachment."); return; }
		if (this.tryRunUiSlashCommand(this.textarea.value)) return;
		// Keyboard paths (Enter) bypass the disabled button, so the gate lives here too.
		if (!this.canSend()) return;
		if (!this.vision && this.attachments.some((a) => a.kind === "image")) { this.showHint("Current model is text-only. Switch to a vision model or remove image attachments."); return; }
		const text = this.attachments.length ? this.textarea.value : this.textarea.value.trim();
		if (!text && this.images.length === 0 && this.selections.length === 0) return;
		if (this.images.length > 0 && !this.vision) {
			this.showHint("Dropped images: current model is text-only. Switch to a vision model or remove the chips.");
			this.images = [];
			this.renderChips();
		}
		// A text-only model can strip the sole content of a message. Do not turn
		// that into an empty RPC prompt after accurately warning the operator.
		if (!text && this.images.length === 0 && this.selections.length === 0) {
			this.closeAutocomplete();
			return;
		}
		if (!this.attachments.length) this.rememberPrompt(this.expandedText());
		this.deps.onSend(text, this.images, this.selections, this.attachments.map((a) => ({ ...a })));
		this.attachments = [];
		this.undoEdits = [];
		this.redoEdits = [];
		this.trackedText = "";
		this.textarea.value = "";
		this.images = [];
		this.selections = [];
		this.renderChips();
		this.autoGrow();
		this.closeAutocomplete();
		this.deps.onDraftChanged("");
	}

	get streamingBehavior(): "steer" | "followUp" {
		return this.behavior;
	}

	get queuesNextSend(): boolean {
		return this.streaming && this.behavior === "followUp";
	}

	private toggleBehavior(): void {
		this.behavior = this.behavior === "steer" ? "followUp" : "steer";
		this.updateBehaviorLabel();
	}

	private updateBehaviorLabel(): void {
		this.behaviorBtn.textContent = this.behavior === "steer" ? "steer" : "queue";
		this.behaviorBtn.title =
			this.behavior === "steer"
				? "Steer: delivered after the current turn, mid-run"
				: "Queue: delivered when the run ends";
	}

	// ---------------------------------------------------------------
	// Model + thinking menus
	// ---------------------------------------------------------------

	/** Mid-truncate a long model label tastefully: chutes/…/Model-Name. Fixed budget ~30 chars. */
	private truncateModelLabel(label: string, maxLen = 30): string {
		if (label.length <= maxLen) return label;
		const parts = label.split("/").filter(Boolean);
		if (parts.length >= 3) {
			return `${parts[0]}/…/${parts[parts.length - 1]}`;
		}
		if (parts.length === 2) {
			const budget = maxLen - parts[0].length - 3;
			if (budget > 8) return `${parts[0]}/${parts[1].slice(0, budget)}…`;
		}
		return `${label.slice(0, Math.max(8, maxLen - 1))}…`;
	}

	private modelLabelFor(model: RpcModel): string {
		return `${model.provider}/${model.id}`;
	}

	private formatCtx(windowSize?: number): string | undefined {
		if (!windowSize) return undefined;
		if (windowSize >= 1_000_000) return `${(windowSize / 1_000_000).toFixed(1)}M ctx`;
		if (windowSize >= 1_000) return `${Math.round(windowSize / 1_000)}k ctx`;
		return `${windowSize}`;
	}

	private isFavorite(model: RpcModel): boolean {
		return this.favorites.some((f) => f.provider === model.provider && f.modelId === model.id);
	}

	private thinkingLevels(): string[] {
		// Host-derived from the model's thinkingLevelMap. When we have no list,
		// fall back to the levels every reasoning model accepts — xhigh and max
		// exist only where the model declares them, so we never invent those.
		return this.availableThinkingLevels?.length ? this.availableThinkingLevels : ["off", "minimal", "low", "medium", "high"];
	}

	private pickerHideHandler(): () => void {
		return () => {
			if (this.suppressPickerHide) return;
			if (!this.restoreStashAfterPicker) return;
			this.restoreStashAfterPicker = false;
			this.restoreComposerStash(this.lastNonSlashDraft);
		};
	}

	private toggleThinkingMenu(initialQuery?: string): void {
		if (this.thinkingMenu?.isOpen()) {
			this.thinkingMenu.hide();
			return;
		}
		if (!this.reasoning) return;
		const model = this.currentModelInfo();
		const levels = this.thinkingLevels();
		const items: DropdownItem[] = levels.map((level, index) => ({
			label: level,
			sub: index === levels.length - 1 && levels.length > 1 ? "deepest reasoning this model supports" : undefined,
			current: level === this.currentThinking,
			onSelect: () => {
				const restore = this.restoreStashAfterPicker;
				this.restoreStashAfterPicker = false;
				if (!this.enabled && this.draftAllowed) this.setThinking(level, this.availableThinkingLevels);
				this.deps.onSetThinking(level);
				if (restore) this.restoreComposerStash(this.lastNonSlashDraft);
			},
		}));
		this.suppressPickerHide = true;
		this.modelMenu?.hide();
		this.suppressPickerHide = false;
		this.thinkingMenu = new Dropdown(this.brainBtn, {
			header: model ? `Thinking — ${this.modelLabelFor(model)}` : "Thinking level",
			placeholder: "Filter levels…",
			initialQuery,
			onHide: this.pickerHideHandler(),
		});
		this.thinkingMenu.show(items);
	}

	private starAccessory(model: RpcModel): (row: HTMLElement) => void {
		return (row) => {
			const star = el("button", `dropdown-star${this.isFavorite(model) ? " active" : ""}`);
			star.title = this.isFavorite(model) ? "Remove from favorites" : "Save as favorite";
			star.appendChild(svgIcon(["M12 3.8l2.6 5.3 5.8 1-4.2 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.2-4.2 5.8-1z"], 13));
			star.addEventListener("click", (event) => {
				event.stopPropagation();
				event.preventDefault();
				// Optimistic flip; the host confirms with a favorites broadcast.
				this.favorites = this.isFavorite(model)
					? this.favorites.filter((f) => !(f.provider === model.provider && f.modelId === model.id))
					: [...this.favorites, { provider: model.provider, modelId: model.id }];
				this.deps.onToggleFavorite(model.provider, model.id);
				// Rebuild the menu so the star + sections reorder immediately.
				const query = this.modelMenu?.query() || undefined;
				this.suppressPickerHide = true;
				this.modelMenu?.hide();
				this.modelMenu = null;
				this.suppressPickerHide = false;
				this.toggleModelMenu(query);
			});
			star.addEventListener("mousedown", (event) => event.preventDefault());
			row.appendChild(star);
		};
	}

	private toggleModelMenu(initialQuery?: string): void {
		if (this.modelMenu?.isOpen() && !initialQuery) {
			this.modelMenu.hide();
			return;
		}
		const favorites = this.models.filter((m) => this.isFavorite(m));
		const rest = this.models.filter((m) => !this.isFavorite(m));
		const imageBadge = (model: RpcModel): string | undefined => ((model.input ?? []).includes("image") ? "img" : undefined);
		const rightFor = (model: RpcModel): string | undefined => {
			const bits = [this.formatCtx(model.contextWindow), model.reasoning ? "T" : undefined, imageBadge(model)].filter(Boolean);
			return bits.length ? bits.join(" · ") : undefined;
		};
		const makeItem = (model: RpcModel, section: string): DropdownItem => ({
			label: this.modelLabelFor(model),
			title: model.name && model.name !== model.id ? `${this.modelLabelFor(model)} — ${model.name}` : this.modelLabelFor(model),
			sub: model.name && model.name !== model.id ? model.name : undefined,
			right: rightFor(model),
			section,
			current: model.provider === this.currentModel.provider && model.id === this.currentModel.modelId,
			accessory: this.starAccessory(model),
			onSelect: () => {
				const restore = this.restoreStashAfterPicker;
				this.restoreStashAfterPicker = false;
				if (!this.enabled && this.draftAllowed) this.setModel(this.modelLabelFor(model), model.provider, model.id);
				this.deps.onSetModel(model.provider, model.id);
				if (restore) this.restoreComposerStash(this.lastNonSlashDraft);
			},
		});
		const items: DropdownItem[] = [
			...favorites.map((m) => makeItem(m, "Favorites")),
			...rest.map((m) => makeItem(m, favorites.length > 0 ? "All models" : "Models")),
		];
		this.suppressPickerHide = true;
		this.attachMenu?.hide();
		this.thinkingMenu?.hide();
		this.modelMenu?.hide();
		this.suppressPickerHide = false;
		this.modelMenu = new Dropdown(this.modelBtn, {
			placeholder: "Search models…",
			maxHeight: 340,
			initialQuery,
			onHide: this.pickerHideHandler(),
		});
		this.modelMenu.show(items);
	}

	// ---- previous-prompt history (Up/Down from an empty composer) ----

	/** Oldest first. Seeded from the thread's own transcript, grown as you send. */
	private promptHistory: string[] = [];
	/** null = not browsing. Otherwise an index into promptHistory. */
	private historyIndex: number | null = null;

	/** Replace the history with the thread's own user messages (host snapshot). */
	setPromptHistory(prompts: string[]): void {
		const kept: string[] = [];
		for (const raw of prompts) {
			const text = typeof raw === "string" ? raw : "";
			// Consecutive repeats are noise to walk back through.
			if (text.trim() && text !== kept[kept.length - 1]) kept.push(text);
		}
		this.promptHistory = kept.slice(-PROMPT_HISTORY_MAX);
		this.historyIndex = null;
	}

	rememberAcceptedPrompt(text: string): void { this.rememberPrompt(text); }

	private rememberPrompt(text: string): void {
		if (text.trim() && text !== this.promptHistory[this.promptHistory.length - 1]) {
			this.promptHistory.push(text);
			if (this.promptHistory.length > PROMPT_HISTORY_MAX) this.promptHistory.shift();
		}
		this.historyIndex = null;
	}

	/**
	 * Walk the thread's previous prompts, the way a shell (and Claude, and Codex)
	 * does it. Deliberately only starts from an EMPTY composer: once there is
	 * text the operator wrote, Up and Down belong to the caret, and stealing them
	 * would make a multi-line draft impossible to navigate.
	 */
	private navigateHistory(direction: -1 | 1): boolean {
		if (this.promptHistory.length === 0) return false;
		if (this.historyIndex === null) {
			if (direction === 1) return false; // Down from a fresh empty box does nothing
			// Whitespace is an empty box to a human. A stray space or a newline left
			// by an edit must not be the reason recall silently refuses.
			if (this.textarea.value.trim() !== "") return false;
			this.historyIndex = this.promptHistory.length - 1;
		} else {
			// Browsing continues only while the box still holds what we put there.
			// If anything else changed it — a host draft push, an insertion, an
			// edit — the position is stale, so start again from the newest.
			if (this.textarea.value !== (this.promptHistory[this.historyIndex] ?? "")) {
				this.historyIndex = null;
				return this.navigateHistory(direction);
			}
			const next = this.historyIndex + direction;
			if (next < 0) return true; // already at the oldest: hold it there
			if (next >= this.promptHistory.length) {
				// Past the newest: back to the empty box you started from.
				this.historyIndex = null;
				this.textarea.value = "";
				this.afterHistoryFill();
				return true;
			}
			this.historyIndex = next;
		}
		this.textarea.value = this.promptHistory[this.historyIndex] ?? "";
		this.afterHistoryFill();
		return true;
	}

	/** Caret to the end, mirror and height in step, draft persisted like a normal edit. */
	private afterHistoryFill(): void {
		const end = this.textarea.value.length;
		this.textarea.selectionStart = this.textarea.selectionEnd = end;
		this.autoGrow();
		this.closeAutocomplete();
		this.textarea.scrollTop = this.textarea.scrollHeight;
		window.clearTimeout(this.draftDebounce);
		this.draftDebounce = window.setTimeout(() => this.draftChanged(), 300);
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (!event.isComposing && !this.composing && (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
			if (typeof document.execCommand !== "function") { event.preventDefault(); this.restoreEdit(event.shiftKey || event.key.toLowerCase() === "y"); }
			return;
		}
		// IME candidate keys (arrows, Enter, numbers) must reach the IME.
		// keyCode 229 is the legacy "processing" sentinel some IMEs still send.
		if (event.isComposing || event.keyCode === 229) return;
		if (this.swallowEnterAfterComposition && event.key === "Enter") {
			event.preventDefault();
			return;
		}
		if (this.acKind) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				this.moveAutocomplete(1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				this.moveAutocomplete(-1);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				this.applyAutocomplete();
				return;
			}
			if (event.key === "Escape") {
				this.closeAutocomplete();
				return;
			}
		}
		// After the autocomplete block above, so an open panel keeps Up/Down for
		// its own selection — the history only sees keys nothing else claimed.
		if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
			if (this.navigateHistory(event.key === "ArrowUp" ? -1 : 1)) {
				event.preventDefault();
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			this.send();
			return;
		}
		// Escape stops a run when the composer is empty
		if (event.key === "Escape" && this.streaming && !this.textarea.value) {
			this.deps.onStop();
		}
	}

	/** Mirror the textarea with @path tokens wrapped in styled spans (HTML-escaped). */
	/** Textarea + mirror scroll-parity: caret must never drift from the rendered text. */
	private syncScroll(): void {
		if (this.mirror) this.mirror.scrollTop = this.textarea.scrollTop;
	}

	/**
	 * Byte ranges in `text` that are mentions. Two sources, because neither alone
	 * is honest: the pattern catches anything path-shaped the operator typed by
	 * hand, and the accepted set catches what the file search offered but no
	 * pattern can distinguish from a word (`@LICENSE`, `@.gitignore`).
	 */
	private mentionRanges(text: string): Array<{ start: number; end: number; path: string }> {
		const ranges: Array<{ start: number; end: number; path: string }> = [];
		// A leading "." is legal in every segment (`.github/workflows/ci.yml`), and
		// a trailing "/" belongs INSIDE the pill — folders are shown with it (#36).
		const mentionRe = /(^|[\s(`"'])@((?:\.?[\w-]+\/)+(?:\.?[\w./-]*\w|)|\.?[\w-]+\.[\w]{1,8})(?=$|[\s),.;:'"`\/]|$)/g;
		let match: RegExpExecArray | null;
		while ((match = mentionRe.exec(text)) !== null) {
			const start = match.index + match[1].length;
			ranges.push({ start, end: start + match[2].length + 1, path: match[2] });
		}
		const overlaps = (start: number, end: number): boolean => ranges.some((r) => start < r.end && end > r.start);
		// Longest first so `src/a` never claims the head of an accepted `src/ab`.
		for (const path of [...this.accepted].sort((a, b) => b.length - a.length)) {
			const needle = `@${path}`;
			for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
				const end = at + needle.length;
				// Same boundaries as the pattern, so #51's no-bleed guarantee holds.
				if (at > 0 && !/[\s(`"']/.test(text[at - 1])) continue;
				if (end < text.length && !/[\s),.;:'"`\/]/.test(text[end])) continue;
				if (!overlaps(at, end)) ranges.push({ start: at, end, path });
			}
		}
		return ranges.sort((a, b) => a.start - b.start);
	}

	/**
	 * Turn #32 asked that hovering an inline mention reveal its path. The styled
	 * spans live in the mirror layer, which is pointer-events:none under an opaque
	 * textarea — their own tooltips are unreachable. Hit-test the span rects
	 * against the pointer and put the tooltip on the textarea, which does get the
	 * mouse. getClientRects() (not getBoundingClientRect) so a mention wrapped
	 * across two lines is hit on both of them.
	 */
	private updateMentionHover(event: MouseEvent): void {
		let hovered = "";
		for (const span of Array.from(this.mirror.querySelectorAll<HTMLElement>(".attachment-marker"))) {
			if (Array.from(span.getClientRects()).some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) { this.textarea.title = "Ctrl/Cmd+click to open attachment in editor"; return; }
		}
		for (const span of Array.from(this.mirror.querySelectorAll<HTMLElement>(".mm"))) {
			for (const rect of Array.from(span.getClientRects())) {
				if (
					event.clientX >= rect.left && event.clientX <= rect.right &&
					event.clientY >= rect.top && event.clientY <= rect.bottom
				) {
					hovered = span.dataset.path ?? "";
					break;
				}
			}
			if (hovered) break;
		}
		const title = hovered ? `${hovered} — mentioned file, sent as context` : "";
		if (this.textarea.title !== title) this.textarea.title = title;
	}

	/**
	 * Where the IME is currently composing. Prefer the live selection while
	 * composition is active; `event.data` is the fallback when the selection
	 * has not yet moved over the candidate.
	 */
	private refreshCompositionRange(data?: string): void {
		const value = this.textarea.value;
		const selStart = this.textarea.selectionStart ?? 0;
		const selEnd = this.textarea.selectionEnd ?? selStart;
		if (selEnd > selStart) {
			this.compositionStart = selStart;
			this.compositionEnd = selEnd;
			return;
		}
		if (data && data.length > 0) {
			const fromCaret = Math.max(0, selStart - data.length);
			if (value.slice(fromCaret, selStart) === data) {
				this.compositionStart = fromCaret;
				this.compositionEnd = selStart;
				return;
			}
			const at = value.lastIndexOf(data, selStart);
			if (at >= 0) {
				this.compositionStart = at;
				this.compositionEnd = at + data.length;
				return;
			}
		}
		this.compositionEnd = selStart;
		if (this.compositionStart > this.compositionEnd) this.compositionStart = this.compositionEnd;
	}

	private syncMirror(): void {
		if (!this.mirror) return;
		const text = this.textarea.value;
		// Both text and `data-path` below come from the editor / host file list.
		// Quotes must be escaped too: this string is assigned to innerHTML, and an
		// otherwise-valid filename can contain a quote that ends an attribute.
		const esc = (s: string) => s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
		const mentions = this.mentionRanges(text).filter((m) => !this.attachments.some((a) => a.start < m.end && a.end > m.start));
		const imeStart = Math.max(0, Math.min(this.compositionStart, text.length));
		const imeEnd = Math.max(0, Math.min(this.compositionEnd, text.length));
		const ime = this.composing && imeEnd > imeStart ? { start: imeStart, end: imeEnd } : null;
		const points = new Set<number>([0, text.length]);
		for (const a of this.attachments) { points.add(a.start); points.add(a.end); }
		for (const range of mentions) {
			points.add(range.start);
			points.add(range.end);
		}
		if (ime) {
			points.add(ime.start);
			points.add(ime.end);
		}
		const sorted = [...points].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
		let html = "";
		const mentionAt = (index: number) => mentions.find((range) => range.start <= index && index < range.end);
		const inIme = (index: number) => !!ime && ime.start <= index && index < ime.end;
		for (let i = 0; i < sorted.length - 1; i++) {
			const from = sorted[i];
			const to = sorted[i + 1];
			if (to <= from) continue;
			const slice = esc(text.slice(from, to));
			const mention = mentionAt(from);
			const composing = inIme(from);
			const attachment = this.attachments.find((a) => a.start <= from && from < a.end);
			if (attachment) {
				html += `<span class="attachment-marker" data-id="${esc(attachment.id)}">${slice}</span>`;
			} else if (mention && composing) {
				html += `<span class="mm" data-path="${esc(mention.path)}"><span class="ime">${slice}</span></span>`;
			} else if (mention) {
				html += `<span class="mm" data-path="${esc(mention.path)}">${slice}</span>`;
			} else if (composing) {
				html += `<span class="ime">${slice}</span>`;
			} else {
				html += slice;
			}
		}
		// A trailing newline collapses without this spacer — keep rows visible.
		if (text.endsWith("\n") || text.length === 0) html += " ";
		this.mirror.innerHTML = html;
		// static offset anchor (render size parity): textarea computes height = mirror height
		this.mirror.scrollTop = this.textarea.scrollTop;
	}

	private autoGrow(): void {
		this.reconcileAttachments();
		this.syncMirror();
		this.textarea.style.height = "auto";
		this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 200)}px`;
		this.syncScroll();
		this.updateSendState();
	}

	private updateSendState(): void {
		const hasContent =
			this.textarea.value.trim().length > 0 ||
			this.images.length > 0 ||
			this.selections.length > 0;
		this.sendBtn.disabled = !this.canSend() || this.attachments.some((a) => a.status !== "ready");
		this.sendBtn.classList.toggle("muted", !hasContent || this.sendBtn.disabled);
	}

	private renderChips(): void {
		this.updateSendState();
		this.chipsEl.textContent = "";
		for (const a of this.attachments) {
			const chip = el("div", "compose-chip attachment-card");
			const preview = a.kind === "text" ? (a.text ?? "").replace(/\s+/g, " ").trim().slice(0, 100) : "";
			const summary = a.kind === "text" ? `${(a.text ?? "").split(/\r\n|\r|\n/).length} lines · ${(a.text ?? "").length} characters · Pasted snapshot` : a.image?.name ?? "";
			chip.title = this.attachmentErrors.get(a.id) ?? [summary, preview].filter(Boolean).join("\n");
			const open = document.createElement("button");
			open.className = "attachment-open";
			open.title = `${chip.title ? `${chip.title}\n` : ""}Open attachment in editor`;
			open.setAttribute("aria-label", `Open ${a.label} in editor`);
			if (a.image) { const thumb = document.createElement("img"); thumb.src = `data:${a.image.mimeType};base64,${a.image.data}`; open.appendChild(thumb); }
			open.appendChild(el("span", "chip-label", `${a.label}${a.status === "ready" ? "" : ` · ${a.status}`}${summary ? ` · ${summary}` : ""}`));
			open.disabled = a.status !== "ready";
			open.addEventListener("click", () => this.deps.onOpenAttachment(a.id));
			const remove = el("button", "chip-remove", "×");
			remove.setAttribute("aria-label", `Remove ${a.label}`);
			remove.addEventListener("click", () => this.replaceTracked(a.start, a.end, ""));
			chip.append(open, remove); this.chipsEl.appendChild(chip);
		}
		for (const sel of this.selections) {
			const chip = el("div", "compose-chip");
			chip.title = `${sel.path} lines ${sel.startLine}-${sel.endLine}`;
			chip.appendChild(icon("selection", 12));
			chip.appendChild(el("span", "chip-label", `${sel.path}:${sel.startLine}-${sel.endLine}`));
			const remove = el("button", "chip-remove");
			// The chip's own title describes the selection; the ✕ needs to say what it does.
			remove.title = "Remove this selection";
			remove.setAttribute("aria-label", "Remove this selection");
			remove.appendChild(icon("close", 11));
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				this.selections = this.selections.filter((s) => s !== sel);
				this.renderChips();
			});
			chip.appendChild(remove);
			chip.addEventListener("click", () => this.deps.onOpenFile(sel.path, sel.startLine, sel.endLine));
			this.chipsEl.appendChild(chip);
		}
		for (const img of this.images) {
			const chip = el("div", "compose-chip image");
			const thumb = document.createElement("img");
			thumb.src = `data:${img.mimeType};base64,${img.data}`;
			chip.appendChild(thumb);
			if (img.name) chip.appendChild(el("span", "chip-label", img.name));
			const remove = el("button", "chip-remove");
			remove.title = "Remove this image";
			remove.setAttribute("aria-label", "Remove this image");
			remove.appendChild(icon("close", 11));
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				this.images = this.images.filter((i) => i !== img);
				this.renderChips();
			});
			chip.appendChild(remove);
			this.chipsEl.appendChild(chip);
		}
	}

	private onPaste(event: ClipboardEvent): void {
		const files = Array.from(event.clipboardData?.files ?? []).filter((f) => SUPPORTED_IMAGE_MIME_TYPES.has(f.type));
		if (files.length) { event.preventDefault(); this.readImageFiles(files); return; }
		const text = event.clipboardData?.getData("text/plain") ?? "";
		if (text.length > 1000 || text.split(/\r\n|\r|\n/).length > 10) {
			event.preventDefault();
			if (text.length > 200_000 || text.includes("\0")) {
				this.showHint("Pasted text must be at most 200,000 characters and cannot contain NUL. Your draft was not changed.");
				return;
			}
			this.expandAttachmentSelection();
			const start = this.textarea.selectionStart, end = this.textarea.selectionEnd;
			let replacedLength = end - start;
			for (const a of this.attachments) {
				if (a.start >= start && a.end <= end) replacedLength += (a.kind === "text" ? (a.text ?? "").length : 0) - (a.end - a.start);
			}
			if (this.expandedText().length - replacedLength + text.length > 200_000) {
				this.showHint("Paste would exceed 200,000 characters. Your draft was not changed.");
				return;
			}
			const a = this.reserveAttachment("text");
			if (a) { a.text = text; this.deps.onCreateAttachment({ ...a }); this.changedAttachments(); }
		}
	}

	private onDrop(event: DragEvent): void {
		event.preventDefault();
		this.readImageFiles(Array.from(event.dataTransfer?.files ?? []).filter((f) => SUPPORTED_IMAGE_MIME_TYPES.has(f.type)));
	}

	private readImageFiles(files: File[]): void {
		if (!this.vision) { this.showHint("Current model is text-only — switch to a vision model to attach images."); return; }
		for (const file of files) {
			const a = this.reserveAttachment("image");
			if (!a) continue;
			const generation = this.sessionGeneration;
			const reader = new FileReader();
			reader.onerror = reader.onabort = () => { if (generation === this.sessionGeneration) this.attachmentCreated(a.id, "Image read failed"); };
			reader.onload = () => {
				if (generation !== this.sessionGeneration) return;
				const data = String(reader.result).split(",")[1] ?? "";
				void this.finishImage(a, { data, mimeType: file.type, name: file.name || "image" }, generation);
			};
			reader.readAsDataURL(file);
		}
	}

	// ---------------------------------------------------------------
	// Autocomplete
	// ---------------------------------------------------------------

	private currentSlashQuery(): string | null {
		const caret = this.textarea.selectionStart ?? 0;
		const value = this.textarea.value;
		if (!value.startsWith("/")) return null;
		const firstSpace = value.indexOf(" ");
		if (firstSpace >= 0 && caret > firstSpace) return null;
		return value.slice(1, caret);
	}

	private currentMentionQuery(): { start: number; query: string } | null {
		const caret = this.textarea.selectionStart ?? 0;
		const before = this.textarea.value.slice(0, caret);
		const match = before.match(/(^|[\s])@([\w./-]*)$/);
		if (!match) return null;
		// start must include the "@" itself or accepting inserts a second one.
		return { start: caret - match[2].length - 1, query: match[2] };
	}

	private updateAutocomplete(): void {
		const slashQuery = this.currentSlashQuery();
		if (slashQuery !== null && slashQuery.length <= 30 && !slashQuery.includes("\n")) {
			const q = slashQuery.toLowerCase();
			const local = UI_SLASH_COMMANDS
				.filter((command) => command.name.includes(q) || command.description.toLowerCase().includes(q))
				.map((command) => ({
					label: `/${command.name}`,
					sub: command.description,
					insert: `/${command.name} `,
					action: command.action,
				}));
			const remote = this.commands
				.filter((command) => command.name.toLowerCase().includes(q) || (command.description ?? "").toLowerCase().includes(q))
				.map((command) => ({ label: `/${command.name}`, sub: command.description, insert: `/${command.name} ` }));
			const items = [...local, ...remote].slice(0, 12);
			if (items.length > 0) {
				this.acKind = "slash";
				this.acItems = items;
				this.acSelected = 0;
				this.renderAutocomplete();
				return;
			}
		}
		const mention = this.currentMentionQuery();
		if (mention) {
			this.acKind = "mention";
			// No debounce: per-keystroke freshness, staleness is guarded by the request id.
			// Keep request IDs monotonic. A response from the session that just left
			// cannot collide with a new search made in the same millisecond.
			this.acRequestId += 1;
			this.deps.onSearchFiles(mention.query, this.acRequestId);
			return;
		}
		this.closeAutocomplete();
	}

	private renderAutocomplete(): void {
		this.autocompleteEl.textContent = "";
		if (!this.acKind || this.acItems.length === 0) {
			// Disarm, don't just hide: onKeyDown gates on acKind alone, so a search
			// that matched nothing left Enter captured by an invisible panel — the
			// operator pressed it twice and the message never went anywhere.
			this.closeAutocomplete();
			return;
		}
		this.acItems.forEach((item, index) => {
			const row = el("button", `ac-item${index === this.acSelected ? " selected" : ""}${item.dir ? " dir" : ""}`);
			const label = el("span", "ac-label", item.label);
			if (item.dir) {
				label.classList.add("dir");
				label.title = `folder: ${item.label}`;
			}
			row.appendChild(label);
			if (item.sub) row.appendChild(el("span", "ac-sub", item.sub.slice(0, 80)));
			row.addEventListener("mousedown", (event) => {
				event.preventDefault();
				this.acSelected = index;
				this.applyAutocomplete();
			});
			this.autocompleteEl.appendChild(row);
		});
		this.autocompleteEl.classList.add("visible");
	}

	private moveAutocomplete(delta: number): void {
		if (this.acItems.length === 0) return;
		this.acSelected = (this.acSelected + delta + this.acItems.length) % this.acItems.length;
		this.renderAutocomplete();
	}

	private applyAutocomplete(): void {
		const item = this.acItems[this.acSelected];
		if (!item) return;
		const caret = this.textarea.selectionStart ?? this.textarea.value.length;
		if (this.acKind === "slash") {
			this.closeAutocomplete();
			if (item.action) {
				this.runUiSlashAction(item.action, "");
				return;
			}
			this.historyIndex = null;
			this.textarea.value = item.insert;
			this.textarea.selectionStart = this.textarea.selectionEnd = item.insert.length;
			this.autoGrow();
			this.textarea.focus();
			return;
		} else {
			// Re-derive the range instead of trusting the offset the panel opened
			// with: the caret may have moved since (click, arrows), and splicing at
			// the stale start duplicates the line around a second mention.
			const range = this.currentMentionQuery();
			if (!range) {
				this.closeAutocomplete();
				return;
			}
			// Inline mention: the @token lives IN the text (styled via the mirror layer).
			const before = this.textarea.value.slice(0, range.start);
			const after = this.textarea.value.slice(caret);
			const path = item.insert;
			const tail = after.replace(/^\s+/, "");
			// Always terminate the token: without the space, typed letters merge
			// into the path and the highlight bleeds forward.
			this.historyIndex = null;
			this.textarea.value = `${before}@${path} ${tail}`;
			const pos = before.length + path.length + 2;
			this.textarea.selectionStart = this.textarea.selectionEnd = pos;
			this.accepted.add(path);
		}
		this.closeAutocomplete();
		this.autoGrow();
		this.textarea.focus();
	}

	private closeAutocomplete(): void {
		this.acKind = null;
		this.acItems = [];
		this.autocompleteEl.textContent = "";
		this.autocompleteEl.classList.remove("visible");
	}

	private snapshotComposer(): ComposerStash {
		return {
			text: this.textarea.value,
			images: [...this.images],
			selections: [...this.selections],
			accepted: [...this.accepted],
			attachments: this.attachments.map((a) => ({ ...a })),
		};
	}

	private applyComposerSnapshot(stash: ComposerStash): void {
		this.historyIndex = null;
		this.textarea.value = stash.text;
		this.trackedText = stash.text;
		this.attachments = (stash.attachments ?? []).map((a) => {
			const cached = this.attachmentRegistry.get(a.id);
			return { ...a, status: cached?.status ?? a.status, text: cached?.text ?? a.text, image: cached?.image ?? a.image };
		});
		for (const a of this.attachments) this.attachmentRegistry.set(a.id, a);
		this.images = [...stash.images];
		this.selections = [...stash.selections];
		this.accepted = new Set(stash.accepted);
		this.renderChips();
		this.autoGrow();
		this.textarea.focus();
	}

	private restoreComposerStash(stash: ComposerStash): void {
		this.applyComposerSnapshot(cloneStash(stash));
		window.clearTimeout(this.draftDebounce);
		this.draftChanged();
	}

	private rememberNonSlashDraft(): void {
		if (this.textarea.value.startsWith("/")) return;
		this.lastNonSlashDraft = this.snapshotComposer();
	}

	private clearComposerForSlash(): void {
		this.historyIndex = null;
		this.textarea.value = "";
		this.images = [];
		this.selections = [];
		this.accepted.clear();
		this.renderChips();
		this.autoGrow();
		this.closeAutocomplete();
		window.clearTimeout(this.draftDebounce);
		this.deps.onDraftChanged("");
	}

	private parseLeadingSlash(text: string): { name: string; args: string } | null {
		if (!text.startsWith("/") || /[\n\r]/.test(text)) return null;
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
		if (!match) return null;
		return { name: match[1], args: (match[2] ?? "").trim() };
	}

	private tryRunUiSlashCommand(text: string): boolean {
		const parsed = this.parseLeadingSlash(text);
		if (!parsed) return false;
		const action = UI_SLASH_BY_NAME.get(parsed.name);
		if (!action) return false;
		this.runUiSlashAction(action, parsed.args);
		return true;
	}

	private runUiSlashAction(action: UiSlashAction, args: string): void {
		if (action === "stash") {
			this.handleStashCommand();
			return;
		}
		if (action === "new") {
			this.applyComposerSnapshot(this.lastNonSlashDraft);
			this.deps.onNewSession();
			return;
		}
		const snapshot = this.snapshotComposer();
		const strippedText = this.stripLeadingSlashCommand(snapshot.text);
		this.stripSnapshotPrefix(snapshot, strippedText);
		if (stashHasContent(snapshot)) this.lastNonSlashDraft = snapshot;
		this.clearComposerForSlash();
		if (action === "model") {
			this.handleModelCommand(args);
			return;
		}
		this.handleEffortCommand(args);
	}

	private stripSnapshotPrefix(snapshot: ComposerStash, text: string): void {
		const removed = snapshot.text.length - text.length;
		snapshot.attachments = (snapshot.attachments ?? []).filter((a) => a.start >= removed).map((a) => ({ ...a, start: a.start - removed, end: a.end - removed }));
		snapshot.text = text;
	}

	private stripLeadingSlashCommand(text: string): string {
		if (!text.startsWith("/")) return text;
		const remainder = text.replace(/^\/\S+(?:[ \t]+[^\n]*)?/, "");
		return remainder.replace(/^\n/, "");
	}

	private handleStashCommand(): void {
		const current = this.snapshotComposer();
		const stripped = cloneStash(current);
		if (this.parseLeadingSlash(current.text)) this.stripSnapshotPrefix(stripped, this.stripLeadingSlashCommand(current.text));
		const draft = stashHasContent(stripped) ? stripped : this.lastNonSlashDraft;
		if (stashHasContent(draft)) {
			if (this.promptStash && stashHasContent(this.promptStash)) {
				this.showHint("Prompt stash already has a draft. Restore it first with /stash.");
				return;
			}
			this.promptStash = cloneStash(draft);
			this.clearComposerForSlash();
			this.lastNonSlashDraft = emptyStash();
			this.showHint("Stashed prompt");
			return;
		}
		if (this.promptStash && stashHasContent(this.promptStash)) {
			const restored = cloneStash(this.promptStash);
			this.promptStash = null;
			this.lastNonSlashDraft = cloneStash(restored);
			this.restoreComposerStash(restored);
			this.showHint("Restored stashed prompt");
			return;
		}
		this.clearComposerForSlash();
		this.showHint("No prompt to stash");
	}

	private handleModelCommand(args: string): void {
		const query = args.trim();
		if (query) {
			const match = this.findExactModelMatch(query);
			if (match) {
				this.restoreStashAfterPicker = false;
				this.deps.onSetModel(match.provider, match.id);
				this.restoreComposerStash(this.lastNonSlashDraft);
				return;
			}
		}
		if (this.models.length === 0) {
			this.showHint("No models loaded yet.");
			this.restoreComposerStash(this.lastNonSlashDraft);
			return;
		}
		this.restoreStashAfterPicker = true;
		this.toggleModelMenu(query || undefined);
		const search = document.querySelector(".dropdown-search");
		if (search instanceof HTMLElement) search.focus();
	}

	private findExactModelMatch(query: string): RpcModel | undefined {
		const q = query.toLowerCase();
		const matches = this.models.filter((model) => {
			const label = this.modelLabelFor(model).toLowerCase();
			return model.id.toLowerCase() === q || label === q || `${model.provider}/${model.id}`.toLowerCase() === q;
		});
		return matches.length === 1 ? matches[0] : undefined;
	}

	private handleEffortCommand(args: string): void {
		if (!this.reasoning) {
			this.showHint("Current model does not support thinking");
			this.restoreComposerStash(this.lastNonSlashDraft);
			return;
		}
		const levels = this.thinkingLevels();
		const requested = args.trim().toLowerCase();
		if (requested) {
			if (!levels.includes(requested)) {
				this.showHint(`Unknown thinking level '${requested}'. Available: ${levels.join(", ")}`);
				this.restoreStashAfterPicker = true;
				this.toggleThinkingMenu(requested);
				return;
			}
			this.restoreStashAfterPicker = false;
			this.deps.onSetThinking(requested);
			this.restoreComposerStash(this.lastNonSlashDraft);
			return;
		}
		this.restoreStashAfterPicker = true;
		this.toggleThinkingMenu();
	}
}
