import { xtermChannels } from "../../extensions/lib/wtft-chart.ts";
import { cellsHtml } from "../assets/cell-glyphs.mjs";

const SGR = /\x1b\[([0-9;]*)m/g;
const PAGE_BG = "#0e0e0e";


export function stripAnsi(text: string): string {
	return text.replace(SGR, "");
}

/** The xterm 256-colour palette entry `n` as a CSS colour. */
export function xtermRgb(n: number): string {
	return `rgb(${xtermChannels(n).join(",")})`;
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
		} else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
			const color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
			if (code === 38) next.fg = color; else next.bg = color;
			i += 4;
		}
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
		const bg = style.inverse ? (style.fg ?? xtermRgb(7)) : style.bg;
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
