import { cellsHtml } from "../assets/cell-glyphs.mjs";

const SGR = /\x1b\[([0-9;]*)m/g;
const PAGE_BG = "#0e0e0e";

const BASIC = [
	"rgb(0,0,0)", "rgb(205,49,49)", "rgb(13,188,121)", "rgb(229,229,16)",
	"rgb(36,114,200)", "rgb(188,63,188)", "rgb(17,168,205)", "rgb(229,229,229)",
	"rgb(136,136,136)", "rgb(241,76,76)", "rgb(35,209,139)", "rgb(245,245,67)",
	"rgb(59,142,234)", "rgb(214,112,214)", "rgb(41,184,219)", "rgb(255,255,255)",
];

export function stripAnsi(text: string): string {
	return text.replace(SGR, "");
}

/** The xterm 256-colour palette entry `n` as a CSS colour. */
export function xtermRgb(n: number): string {
	if (n < 16) return BASIC[n] ?? BASIC[7];
	if (n > 255) return BASIC[7];
	if (n >= 232) {
		const gray = 8 + (n - 232) * 10;
		return `rgb(${gray},${gray},${gray})`;
	}
	const index = n - 16;
	const step = [0, 95, 135, 175, 215, 255];
	return `rgb(${step[Math.floor(index / 36)]},${step[Math.floor(index / 6) % 6]},${step[index % 6]})`;
}

interface Style { bold: boolean; inverse: boolean; fg: string | null; bg: string | null }

function applyCodes(style: Style, codes: number[]): Style {
	const next = { ...style };
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === 0) { next.bold = false; next.inverse = false; next.fg = null; next.bg = null; }
		else if (code === 1) next.bold = true;
		else if (code === 22) next.bold = false;
		else if (code === 7) next.inverse = true;
		else if (code === 27) next.inverse = false;
		else if (code >= 30 && code <= 37) next.fg = xtermRgb(code - 30);
		else if (code >= 90 && code <= 97) next.fg = xtermRgb(code - 90 + 8);
		else if (code === 39) next.fg = null;
		else if (code === 49) next.bg = null;
		else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
			const color = xtermRgb(codes[i + 2] ?? 7);
			if (code === 38) next.fg = color; else next.bg = color;
			i += 2;
		} else if ((code === 38 || code === 48) && codes[i + 1] === 2) i += 4;
	}
	return next;
}

/** One terminal line's colour codes as HTML spans; text is escaped and block and box glyphs painted as cells. Codes it does not know are dropped. */
export function ansiToHtml(text: string): string {
	let html = "";
	let style: Style = { bold: false, inverse: false, fg: null, bg: null };
	let last = 0;
	const emit = (chunk: string) => {
		if (!chunk) return;
		const body = cellsHtml(chunk);
		const fg = style.inverse ? (style.bg ?? PAGE_BG) : style.fg;
		const bg = style.inverse ? (style.fg ?? BASIC[7]) : style.bg;
		const css = [
			style.bold ? "font-weight:700" : "",
			fg ? `color:${fg}` : "",
			bg ? `background:${bg}` : "",
		].filter(Boolean).join(";");
		html += css ? `<span style="${css}">${body}</span>` : body;
	};
	for (const match of text.matchAll(SGR)) {
		emit(text.slice(last, match.index));
		style = applyCodes(style, match[1] === "" ? [0] : match[1].split(";").map(Number));
		last = match.index + match[0].length;
	}
	emit(text.slice(last));
	return html;
}
