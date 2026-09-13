/** Brief VS Code extension entry point. */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { ChatPanels } from "./chat-view.js";

let chats: ChatPanels | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const marker = process.env.BRIEF_VSCODE_LOG;
	if (marker) {
		try { fs.appendFileSync(marker, `activate ${Date.now()}\n`); } catch { /* optional diagnostics */ }
	}
	const output = vscode.window.createOutputChannel("Brief");
	const panels = new ChatPanels(context, output);
	chats = panels;
	context.subscriptions.push(output, panels,
		vscode.window.registerWebviewPanelSerializer(ChatPanels.viewType, panels),
		vscode.window.registerWebviewViewProvider("brief.chat", panels, {
			webviewOptions: { retainContextWhenHidden: true },
		}));

	const command = (id: string, action: () => Promise<void> | void): vscode.Disposable =>
		vscode.commands.registerCommand(id, async () => {
			try { await action(); }
			catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				output.appendLine(`[brief] ${id} failed: ${detail}`);
				void vscode.window.showErrorMessage(`Brief: ${detail}`);
			}
		});

	context.subscriptions.push(
		command("brief.focusChat", () => panels.focus()),
		command("brief.openChat", () => panels.useLocation("editor")),
		command("brief.useEditor", () => panels.useLocation("editor")),
		command("brief.useSidebar", () => panels.useLocation("sidebar")),
		command("brief.toggleChatLocation", () => panels.toggleLocation()),
		command("brief.switchSession", () => panels.switchSidebarSession()),
		command("brief.newSession", () => panels.newSession()),
		command("brief.stashDraft", () => panels.stashOrRestoreDraft()),
		command("brief.abort", () => panels.run((controller) => controller.abort())),
		command("brief.compact", () => panels.run((controller) => controller.compact())),
		command("brief.exportChat", () => panels.run((controller) => controller.exportChat())),
		command("brief.restart", () => panels.run((controller) => controller.restart())),
		command("brief.history", () => panels.run((controller) => controller.showHistoryView(), true)),
		command("brief.renameSession", () => panels.run((controller) => panels.promptRenameSession(controller))),
		command("brief.addSelectionToChat", () => {
			// Capture the source before revealing a chat editor changes focus.
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.selection.isEmpty) {
				void vscode.window.showInformationMessage("Select some code first.");
				return;
			}
			const { document, selection } = editor;
			const text = document.getText(selection);
			if (text.length > 100_000) {
				void vscode.window.showWarningMessage("Select at most 100,000 characters.");
				return;
			}
			const selected = { uri: document.uri, text,
				startLine: selection.start.line + 1, endLine: selection.end.line + 1, languageId: document.languageId };
			return panels.run((controller) => {
				const path = controller.workspaceRelativePath(selected.uri);
				if (path) controller.broadcastInsertSelection({ path, text: selected.text,
					startLine: selected.startLine, endLine: selected.endLine, languageId: selected.languageId });
			}, true);
		}),
		command("brief.addActiveFileToChat", () => {
			const uri = vscode.window.activeTextEditor?.document.uri;
			if (!uri) return;
			return panels.run((controller) => {
				const path = controller.workspaceRelativePath(uri);
				if (path) controller.broadcastInsertMention(path);
			}, true);
		}),
	);
}

export function deactivate(): void {
	chats?.dispose();
	chats = undefined;
}
