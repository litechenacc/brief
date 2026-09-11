# Brief

Fork of [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode).

This repository exists because of that work. Thank you to [sirouk](https://github.com/sirouk) for building a usable VS Code frontend on top of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), and for publishing it as a community project.

**Community project.** Neither this fork nor the original extension is an official Prime Intellect release. The Prime Agent name and the butterfly mark are Prime Intellect's, used here to identify the CLI the extension drives.

## What this repo is right now

Today Brief is still very close to origin: a VS Code sidebar that runs `prime-agent --mode rpc` and renders the agent stream (assistant text, thinking, tool calls, sessions, subagents, processes).

That is intentional. The fork starts from a working Prime Agent UI instead of rewriting the runtime.

## Where it is going

The product thesis is in [`prd.md`](prd.md). Chat is not the destination.

Brief is meant to become a **file-native collaboration layer** on top of the existing agent harness:

- Human and agent work around a living Markdown document, not a long transcript that is summarized afterwards.
- `session.md` is the human interface. Prime Agent remains the execution history (turns, tools, session state).
- Document edits map to new agent turns without rewriting old harness history, so prompt-cache prefixes stay stable.

POC stages in the PRD:

1. VS Code ↔ Prime (this tree, still mostly origin)
2. Markdown structure + parser
3. Markdown-native conversation

Expect this repository to diverge substantially from [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode) as those stages land. Features, UI, and packaging names will change to match Brief rather than remaining a Prime Agent chat clone.

## Install (current tree)

The extension still talks to a local [`prime-agent` CLI](https://github.com/PrimeIntellect-ai/prime-agent). Install that first:

```sh
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Then from this repo:

```sh
just install
```

That packages a `.vsix` and installs `litechenacc.brief`. Reload the VS Code window afterwards.

From source without `just`:

```sh
npm ci
npm run package
code --install-extension brief-<version>.vsix --force
```

Requires VS Code 1.90+, `node` >= 22, and the `code` CLI on `PATH`.

## Settings and commands

Settings remain under `primeAgent.*` until the Brief surface is renamed. Commands are under the **Brief** category in the Command Palette (`Brief: Focus Chat`, `New Session`, `Stop Agent`, …).

See origin's README for the current chat-UI feature list; this tree still has that behavior, plus local work such as the working-row spinner and New Session empty-page lock.

## Development

```bash
npm install
npm run compile
npm run typecheck
npm run test
npm run package
```

Open this folder and press `F5` for an Extension Development Host.

## License

MIT — original copyright [sirouk](https://github.com/sirouk); see [LICENSE](LICENSE). The butterfly mark and the Prime Agent name are Prime Intellect's trademarks, used only to identify the CLI this extension drives.
