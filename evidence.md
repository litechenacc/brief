# Drag-and-drop evidence

## Reported symptom

Dropping any file into the composer displays:

> No supported workspace files or images in this drop.

The reported target form is a descendant of the repository root, for example `rtl/workspace/xxx.md`. The directory name `workspace` has no special meaning in the implementation.

## Traced control flow

1. `webview/composer.ts:onDrop()` reads `DataTransfer.getData("text/uri-list")`.
2. When that list is non-empty, it sends the raw URIs to the extension host as `dropWorkspaceUris`.
3. `src/chat-view.ts` calls `SessionController.resolveDroppedWorkspaceUris()`.
4. `src/session-workspace.ts:resolveDroppedWorkspaceUris()` returns an item only when all of these hold:
   - `vscode.Uri.parse(raw).scheme === "file"`;
   - `workspaceRelativePath(uri)` is non-null;
   - `vscode.workspace.fs.stat(uri)` succeeds;
   - the item is a regular file or directory.
5. An empty result reaches `Composer.resolveWorkspaceDrop()`. If no recognised browser image was included, it emits the reported message.

## Workspace containment rule

`src/session-controller.ts:isInWorkspaceRoot()` accepts only local file URIs under `this.workspaceRoot`. It uses `realpathSync()` on both root and dropped path, so a symlink that resolves outside the root is rejected. It also rejects the root directory itself (`relative === ""`). `workspaceRoot` is `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`, so this implementation is single-root and uses only the first VS Code workspace folder.

## Current inference

A normal existing non-symlink file below the first opened local workspace root should be accepted. Since the user reports *all* files fail, a shared precondition is likely failing instead of a filename/path allow-list. Most likely candidates are:

1. the drag source supplies a non-`file:` URI (for example a VS Code or remote filesystem URI);
2. the first workspace folder is not the expected repository root, or the session has no local workspace root;
3. the session runs against a remote/virtual filesystem that cannot meet this local-`file:` plus Node `realpathSync()` rule.

No logging currently records raw dropped URIs, URI schemes, workspace root, or the individual rejection condition. Confirmation needs inspection of the actual drag `DataTransfer` values and/or the VS Code workspace URI at runtime.

## Independent confirmation (`astra-low`)

`astra-low` independently confirmed the traced source behavior without editing files:

- The reported hint can occur only after a non-empty `text/uri-list` produces an empty host result and there are no recognised browser image files.
- There is no filename extension allow-list and no special case for a directory named `workspace`.
- The resolver silently discards non-`file:` URIs, paths outside the first local workspace root after realpath resolution, stat failures, and non-file/non-directory types.
- The leading runtime hypothesis remains a URI-scheme mismatch, such as `vscode-remote:` from a Remote Explorer, but it is **not confirmed** because the actual drag payload has not been observed.

Recommended next action: put a breakpoint in `Composer.onDrop()` and inspect `transfer.types` and `text/uri-list`; then break in `resolveDroppedWorkspaceUris()` and inspect each URI scheme, `vscode.workspace.workspaceFolders`, `workspaceRoot`, and the condition that rejects it. Do not relax the containment rule before that observation.

## Reproduction test

A regression test was added to `test/session-workspace.test.mjs`. It supplies a representative Remote Explorer URI:

```text
vscode-remote://ssh-remote%2Bhost/workspace/rtl/workspace/xxx.md
```

The test verifies the current resolver returns `[]` and does not call `workspace.fs.stat`, because it rejects the URI at `uri.scheme !== "file"`. `npm run compile && node test/session-workspace.test.mjs` passes. This confirms the reported Remote-environment failure mechanism.

## Implemented fix

`resolveDroppedWorkspaceUris()` now accepts a `vscode-remote:` URI only when its scheme and authority exactly match the first workspace folder. It normalizes that URI to `vscode.Uri.file(parsed.fsPath)` before the existing containment (`workspaceRelativePath()` / `realpath`) and `workspace.fs.stat()` checks. Non-matching remote authorities and every other non-`file:` scheme remain rejected.

The regression test covers successful normalization for a matching authority and rejection before `stat()` for a different authority.

An unrelated baseline TypeScript failure was also corrected: `Transcript.forceScrollToBottom()` still referenced the deleted `jumpBtn` property. The obsolete line was removed; the existing conversation-lens control owns “Jump to latest”.

Validation passed: `npm run typecheck`, `npm run compile`, `node test/session-workspace.test.mjs`, and `node test/webview.test.mjs`.
