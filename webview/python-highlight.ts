/**
 * Python highlighter for tool cards.
 *
 * Token colors come from the current VS Code Color Theme
 * (`--vscode-symbolIcon-*` in media/main.css). The webview cannot read
 * TextMate grammars, so the lexer is local and small.
 */

import { el } from "./dom.js";

export type PyTokenKind = "kw" | "fn" | "cls" | "str" | "cmt" | "num" | "op" | "dec" | "txt";

export interface PyToken {
	kind: PyTokenKind;
	text: string;
}

const KEYWORDS = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"case",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"match",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"type",
	"while",
	"with",
	"yield",
]);

const OPS = [
	"//=",
	"**=",
	">>=",
	"<<=",
	"...",
	"->",
	":=",
	"//",
	"**",
	"<<",
	">>",
	"==",
	"!=",
	"<=",
	">=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"@=",
	"+",
	"-",
	"*",
	"/",
	"%",
	"&",
	"|",
	"^",
	"~",
	"@",
	"=",
	"<",
	">",
	"!",
];

const NUMBER =
	/^(0[xX](_?[0-9a-fA-F])+|0[bB](_?[01])+|0[oO](_?[0-7])+|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)/;

const PREFIX_CHARS = "rRuUfFbB";

function isIdStart(c: string): boolean {
	return ("A" <= c && c <= "Z") || ("a" <= c && c <= "z") || c === "_";
}

function isIdPart(c: string): boolean {
	return isIdStart(c) || ("0" <= c && c <= "9");
}

function push(out: PyToken[], kind: PyTokenKind, text: string): void {
	if (!text) return;
	const last = out[out.length - 1];
	if (last && last.kind === kind) last.text += text;
	else out.push({ kind, text });
}

function readNumber(source: string, i: number): number {
	const c = source[i];
	if (c === ".") {
		const n = source[i + 1];
		if (n === undefined || n < "0" || n > "9") return 0;
	} else if (c < "0" || c > "9") {
		return 0;
	}
	const match = NUMBER.exec(source.slice(i));
	return match ? i + match[0].length : 0;
}

function readString(source: string, i: number): number {
	let j = i;
	while (j < source.length && PREFIX_CHARS.includes(source[j])) j++;
	const quote = source[j];
	if (quote !== '"' && quote !== "'") return 0;
	const raw = /[rR]/.test(source.slice(i, j));
	const triple = source.startsWith(quote + quote + quote, j);
	const delim = triple ? quote + quote + quote : quote;
	let k = j + delim.length;
	while (k < source.length) {
		if (source.startsWith(delim, k)) return k + delim.length;
		if (!raw && source[k] === "\\") {
			k += 2;
			continue;
		}
		if (!triple && source[k] === "\n") break;
		k++;
	}
	return k;
}

function nextNonSpace(source: string, i: number): string {
	let j = i;
	while (j < source.length && (source[j] === " " || source[j] === "\t")) j++;
	return source[j] ?? "";
}

export function tokenizePython(source: string): PyToken[] {
	const out: PyToken[] = [];
	let i = 0;
	let named: "fn" | "cls" | null = null;

	while (i < source.length) {
		const c = source[i];

		if (c === "#") {
			let j = i + 1;
			while (j < source.length && source[j] !== "\n") j++;
			push(out, "cmt", source.slice(i, j));
			i = j;
			named = null;
			continue;
		}

		const strEnd = readString(source, i);
		if (strEnd) {
			push(out, "str", source.slice(i, strEnd));
			i = strEnd;
			named = null;
			continue;
		}

		const numEnd = readNumber(source, i);
		if (numEnd) {
			push(out, "num", source.slice(i, numEnd));
			i = numEnd;
			named = null;
			continue;
		}

		if (isIdStart(c)) {
			let j = i + 1;
			while (j < source.length && isIdPart(source[j])) j++;
			const id = source.slice(i, j);
			if (KEYWORDS.has(id)) {
				push(out, "kw", id);
				if (id === "def") named = "fn";
				else if (id === "class") named = "cls";
				else if (id !== "async") named = null;
			} else if (named) {
				push(out, named, id);
				named = null;
			} else if (nextNonSpace(source, j) === "(") {
				push(out, "fn", id);
			} else {
				push(out, "txt", id);
			}
			i = j;
			continue;
		}

		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			push(out, "txt", c);
			i++;
			continue;
		}

		if (c === "@" && i + 1 < source.length && isIdStart(source[i + 1])) {
			let j = i + 1;
			while (j < source.length && (isIdPart(source[j]) || source[j] === ".")) j++;
			while (j > i + 1 && source[j - 1] === ".") j--;
			push(out, "dec", source.slice(i, j));
			i = j;
			named = null;
			continue;
		}

		named = null;
		let op = "";
		for (const candidate of OPS) {
			if (source.startsWith(candidate, i)) {
				op = candidate;
				break;
			}
		}
		if (op) {
			push(out, "op", op);
			i += op.length;
			continue;
		}

		push(out, "txt", c);
		i++;
	}

	return out;
}

export function renderPythonCode(source: string, parent: HTMLElement): void {
	parent.classList.add("hl-python");
	for (const tok of tokenizePython(source)) {
		if (tok.kind === "txt") parent.appendChild(document.createTextNode(tok.text));
		else parent.appendChild(el("span", `tok-${tok.kind}`, tok.text));
	}
}
