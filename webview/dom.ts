/**
 * Small DOM helpers plus the inline icon set. Icons are hand-drawn minimal
 * stroke shapes on a 24x24 grid. The Brief mark also uses currentColor.
 */

export function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgIcon(paths: string[], size = 16, filled = false): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", filled ? "currentColor" : "none");
	svg.setAttribute("stroke", filled ? "none" : "currentColor");
	svg.setAttribute("stroke-width", filled ? "0" : "1.8");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	for (const d of paths) {
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", d);
		svg.appendChild(path);
	}
	return svg;
}

export const icons = {
	plus: ["M12 5v14M5 12h14"],
	terminal: ["M5 6l6 6-6 6", "M13 18h6"],
	history: ["M3.5 12a8.5 8.5 0 1 0 2.9-6.4", "M3.5 3.5v4.5H8", "M12 8v4.2l3 1.8"],
	kebab: ["M12 5.5h.01M12 12h.01M12 18.5h.01"],
	send: ["M12 19V6", "M5.5 12.5 12 6l6.5 6.5"],
	stop: ["M7 7h10v10H7z"],
	file: ["M6 2.5h8L20 8.5v13H6z", "M13.5 2.5V9H20"],
	image: ["M4 4h16v16H4z", "M8.8 10.3a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z", "M20 15.5 15 10l-8.5 8.5"],
	selection: ["M4 5.5h16", "M4 12h10", "M4 18.5h7"],
	chevron: ["M6 9.5l6 6 6-6"],
	close: ["M6 6l12 12M18 6L6 18"],
	copy: ["M9.5 9.5h10v10h-10z", "M5.5 14.5v-10h10"],
	brain: [
		"M9 4.2a3 3 0 0 0-3 3c-1.6.6-2.5 1.9-2.5 3.5 0 1.6.8 3 2.5 3.6.1 1.9 1.3 3.3 3 3.5",
		"M9 4.2c1 0 1.8.5 2.3 1.2",
		"M12 5.4v13",
		"M15 4.2a3 3 0 0 1 3 3c1.6.6 2.5 1.9 2.5 3.5 0 1.6-.8 3-2.5 3.6-.1 1.9-1.3 3.3-3 3.5",
		"M15 4.2c-1 0-1.8.5-2.3 1.2",
	],
	pencil: ["M13.5 5.5l5 5", "M4 20l3.5-1 11-11-2.5-2.5-11 11L4 20z"],
	reset: ["M4.5 12a7.5 7.5 0 1 0 2.2-5.3", "M4.5 4.5V8h3.5"],
	gear: [
		"M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z",
		"M12 3v2.2M12 18.8V21M4.2 6l1.6 1.3M18.2 16.7l1.6 1.3M3 10.8l1.9.7M16.4 12.5h4.6M16.4 11.5h4.6M3 13.2l1.9-.7M18.2 7.3L19.8 6M4.2 18l1.6-1.3",
	],
	fork: [
		"M6 4.5a1.8 1.8 0 1 0 .01 0",
		"M6 19a1.8 1.8 0 1 0 .01 0",
		"M18 4.8a1.8 1.8 0 1 0 .01 0",
		"M6 6.3v11",
		"M18 6.6c0 4.5-12 3-12 9",
	],
	check: ["M4.5 12.5 10 18 19.5 6.5"],
	spark: ["M12 3.5v3.5", "M12 17v3.5", "M3.5 12H7", "M17 12h3.5", "M6 6l2.2 2.2", "M15.8 15.8 18 18", "M6 18l2.2-2.2", "M15.8 8.2 18 6"],
	diff: ["M14 4H4v16h16V10", "M14 4l6 6", "M8.5 13.5h7", "M8.5 17h4.5"],
	external: ["M14 4h6v6", "M20 4 11 13", "M18 13.5V20H4V6h6.5"],
	clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5.2l3.2 2"],
	model: ["M4 7a3 3 0 0 1 6 0 3 3 0 0 1 6 0 3 3 0 0 1 4 2.8", "M4 7v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6.2", "M9.5 12.5h5", "M9.5 16h3.5"],
	message: ["M4 5h16v10.5H9L4 19z"],
	layers: ["M12 3 3 8.5 12 14l9-5.5z", "M5.5 12.5 12 16l6.5-3.5", "M5.5 16.5 12 20l6.5-3.5"],
	back: ["M15 5l-7 7 7 7"],
	refresh: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 3.5V8h-4.5"],
	export: ["M12 15V3.5", "M7.5 8 12 3.5 16.5 8", "M4.5 14v6h15v-6"],
	compact: ["M8 3.5h8M8 8h6M8 12.5h4M8 17h2.5", "M4 3.5v17M20 3.5v17"],
	star: ["M12 3.8l2.6 5.3 5.8 1-4.2 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.2-4.2 5.8-1z"],
	search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M21 21l-6-6"],
	archive: ["M3.5 4.5h17V9h-17z", "M5.5 9v10.5h13V9", "M10 12.5h4"],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof icons;

export function icon(name: IconName, size = 16): SVGSVGElement {
	return svgIcon(icons[name], size);
}

export function iconButton(name: IconName, title: string, size = 16): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.className = "icon-btn";
	btn.title = title;
	btn.setAttribute("aria-label", title);
	btn.appendChild(icon(name, size));
	return btn;
}

const BRIEF_MARK = "M7 2h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H8.5l-4.6 3.2a.6.6 0 0 1-.9-.5V6a4 4 0 0 1 4-4ZM8 5v12h5a3.4 3.4 0 0 0 2-6.2A3 3 0 0 0 13 5H8Zm2.3 2.5H13a1.1 1.1 0 0 1 0 2.2h-2.7V7.5Zm0 4.6H13a1.2 1.2 0 0 1 0 2.4h-2.7v-2.4Z";

export function brandMark(size = 18, className = ""): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	if (className) svg.setAttribute("class", className);
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", BRIEF_MARK);
	path.setAttribute("fill-rule", "evenodd");
	path.setAttribute("fill", "currentColor");
	svg.appendChild(path);
	return svg;
}
