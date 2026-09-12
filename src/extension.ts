/**
 * Brief VS Code extension entry point.
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import { ChatPanel, ChatViewProvider } from "./chat-view.js";
import { SessionController } from "./session-controller.js";

let controller: SessionController | null = null;

export function activate(context: vscode.ExtensionContext): void {
	const marker = process.env.BRIEF_VSCODE_LOG;
	if (marker) {
		try {
			fs.appendFileSync(marker, `activate ${Date.now()}\n`);
		} catch {
			// ignore
		}
	}
	const output = vscode.window.createOutputChannel("Brief");
	controller = new SessionController(context, output);
	context.subscriptions.push(controller, output);

	const provider = new ChatViewProvider(context.extensionUri, controller);
	// Keep the sidebar's DOM alive while it is hidden: without this an activity-bar
	// toggle tears the webview down and the operator's transcript, draft and scroll
	// position come back only after a fresh round-trip — the flash they asked us to
	// remove. The editor-tab panel already does the same.
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	context.subscriptions.push(provider);

	const reveal = () => {
		void vscode.commands.executeCommand("brief.chat.focus").then(
			() => provider.reveal(),
			() => provider.reveal(),
		);
	};
	// VS Code does not await command callbacks. Keep their rejection boundary at
	// the registration point so a transport failure cannot become an unhandled
	// extension-host rejection with no operator-visible explanation.
	const runCommand = (label: string, action: () => Promise<void>) => {
		void action().catch((err) => {
			const detail = err instanceof Error ? err.message : String(err);
			output.appendLine(`[prime-agent] ${label} failed: ${detail}`);
			controller?.showErrorNotice(`${label} failed: ${detail}`);
		});
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("brief.focusChat", () => {
			reveal();
			provider.focusComposer();
		}),
		vscode.commands.registerCommand("brief.openChat", () => {
			ChatPanel.createOrShow(context.extensionUri, controller!);
		}),
		vscode.commands.registerCommand("brief.newSession", () => runCommand("New session", () => controller!.newSession())),
		vscode.commands.registerCommand("brief.abort", () => runCommand("Stop", () => controller!.abort())),
		vscode.commands.registerCommand("brief.compact", () => runCommand("Compact", () => controller!.compact())),
		vscode.commands.registerCommand("brief.exportChat", () => runCommand("Export chat", () => controller!.exportChat())),
		vscode.commands.registerCommand("brief.restart", () => runCommand("Restart", () => controller!.restart())),
		vscode.commands.registerCommand("brief.history", () => {
			reveal();
			controller!.showHistoryView();
		}),
		vscode.commands.registerCommand("brief.renameSession", () =>
			runCommand("Rename session", async () => {
				const current = controller!.currentSessionName();
				const name = await vscode.window.showInputBox({
					title: "Rename session",
					value: current ?? "",
					prompt: "Name this session",
					placeHolder: "Session name",
					ignoreFocusOut: true,
				});
				if (name === undefined) return;
				await controller!.renameSession(name);
			}),
		),
		vscode.commands.registerCommand("brief.addSelectionToChat", () => {
			const selection = controller!.getActiveSelection();
			if (!selection) {
				void vscode.window.showInformationMessage("Select some code first.");
				return;
			}
			controller!.broadcastInsertSelection(selection);
			reveal();
		}),
		vscode.commands.registerCommand("brief.addActiveFileToChat", () => {
			const file = controller!.getActiveFilePath();
			if (!file) return;
			controller!.broadcastInsertMention(file);
			reveal();
		}),
	);
}

export function deactivate(): void {
	controller?.dispose();
	controller = null;
}
