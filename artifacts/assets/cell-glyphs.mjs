const FILL = "linear-gradient(currentColor,currentColor)";
const LIGHT = "max(1px,.08em)";
const HEAVY = "max(2px,.16em)";

const rect = (position, size) => `${FILL} ${position} / ${size} no-repeat`;

const LINE = {
	l: (t) => rect("left center", `50% ${t}`),
	r: (t) => rect("right center", `50% ${t}`),
	u: (t) => rect("center top", `${t} 50%`),
	d: (t) => rect("center bottom", `${t} 50%`),
};

const box = (arms, t = LIGHT) => [...arms].map((arm) => LINE[arm](t)).join(",");

const PAINT = new Map([
	["─", { layers: rect("left center", `100% ${LIGHT}`), run: true }],
	["━", { layers: rect("left center", `100% ${HEAVY}`), run: true }],
	["│", { layers: box("ud") }],
	["┃", { layers: box("ud", HEAVY) }],
	["┌", { layers: box("rd") }],
	["┐", { layers: box("ld") }],
	["└", { layers: box("ru") }],
	["┘", { layers: box("lu") }],
	["├", { layers: box("udr") }],
	["┤", { layers: box("udl") }],
	["┬", { layers: box("lrd") }],
	["┴", { layers: box("lru") }],
	["┼", { layers: box("lrud") }],
	["╴", { layers: box("l") }],
	["╵", { layers: box("u") }],
	["╶", { layers: box("r") }],
	["╷", { layers: box("d") }],
	["▀", { layers: rect("left top", "100% 50%"), run: true }],
	["▔", { layers: rect("left top", "100% 12.5%"), run: true }],
	["▐", { layers: rect("right top", "50% 100%") }],
	["▕", { layers: rect("right top", "12.5% 100%") }],
]);
for (let eighths = 1; eighths <= 8; eighths++) {
	PAINT.set(String.fromCodePoint(0x2580 + eighths), { layers: rect("left bottom", `100% ${eighths * 12.5}%`), run: true });
}
for (let eighths = 7; eighths >= 1; eighths--) {
	PAINT.set(String.fromCodePoint(0x2590 - eighths), { layers: rect("left top", `${eighths * 12.5}% 100%`) });
}
const QUADRANT = { a: "left top", b: "right top", c: "left bottom", d: "right bottom" };
for (const [ch, quarters] of [["▖", "c"], ["▗", "d"], ["▘", "a"], ["▙", "acd"], ["▚", "ad"], ["▛", "abc"], ["▜", "abd"], ["▝", "b"], ["▞", "bc"], ["▟", "bcd"]]) {
	PAINT.set(ch, { layers: [...quarters].map((q) => rect(QUADRANT[q], "50% 50%")).join(",") });
}

function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text in, HTML out: `&`, `<` and `>` escaped, and each block or box-drawing glyph docs/spec-392-cell-glyphs.md lists painted as a cell span. */
export function cellsHtml(text) {
	let html = "";
	const chars = [...text];
	for (let i = 0; i < chars.length;) {
		const paint = PAINT.get(chars[i]);
		if (!paint) {
			html += escapeHtml(chars[i]);
			i++;
			continue;
		}
		let end = i + 1;
		if (paint.run) while (end < chars.length && chars[end] === chars[i]) end++;
		const style = `display:inline-block;width:${end - i}ch;height:1lh;vertical-align:top;overflow:hidden;-webkit-text-fill-color:transparent;background:${paint.layers}`;
		html += `<span style="${style}">${chars.slice(i, end).join("")}</span>`;
		i = end;
	}
	return html;
}
