// Oracle for the chart spec picker. Illustrates glyph choice, columns, and
// rules. It is not a port of the production quantizer.

const ESC = "\u001b";

export const CATS = {
	plan: { fg: 75, label: "Plan" },
	research: { fg: 141, label: "Research" },
	web: { fg: 209, label: "Web" },
	code: { fg: 179, label: "Code" },
	tests: { fg: 149, label: "Tests" },
};

const CAT_ORDER = ["plan", "research", "web", "code", "tests"];

// Oldest first. Turn 100 sits on the newest bin so a 100-turn rule can fire once.
const RAW = [
	{ time: "10:00", date: "Sep-25", turn: 10, miss: false, parts: [
		{ cat: "code", cost: 1.0, tokens: 800 },
		{ cat: "web", cost: 0.4, tokens: 0 },
	]},
	{ time: "12:00", date: "Sep-25", turn: 20, miss: false, parts: [
		{ cat: "code", cost: 2.2, tokens: 1400 },
	]},
	{ time: "18:00", date: "Sep-25", turn: 30, miss: false, parts: [
		{ cat: "research", cost: 0.8, tokens: 2200 },
	]},
	{ time: "14:00", date: "Sep-26", turn: 40, miss: false, parts: [
		{ cat: "plan", cost: 0.5, tokens: 600 },
		{ cat: "code", cost: 3.1, tokens: 1800 },
	]},
	{ time: "15:00", date: "Sep-26", turn: 100, miss: true, parts: [
		{ cat: "code", cost: 1.2, tokens: 900 },
		{ cat: "tests", cost: 0.7, tokens: 400 },
	]},
];

const FOUR = ["inc-cost", "total-cost", "inc-tokens", "total-tokens"];

export const PRESETS = {
	"cost-cumulative": {
		label: "Cost, cumulative",
		interval: "time",
		layout: "stack",
		measure: "total-cost",
		columns: FOUR,
		recency: false,
		rules: { miss: true, date: true, ten: false, hundred: false },
	},
	"cost-bucket": {
		label: "Cost, bucket",
		interval: "time",
		layout: "scatter",
		measure: "inc-cost",
		columns: FOUR,
		recency: false,
		rules: { miss: true, date: true, ten: false, hundred: false },
	},
	"tokens-cumulative": {
		label: "Tokens, cumulative",
		interval: "time",
		layout: "stack",
		measure: "total-tokens",
		columns: FOUR,
		recency: true,
		rules: { miss: true, date: true, ten: false, hundred: false },
	},
	"tokens-bucket": {
		label: "Tokens, bucket",
		interval: "time",
		layout: "stack",
		measure: "inc-tokens",
		columns: FOUR,
		recency: false,
		rules: { miss: true, date: true, ten: false, hundred: false },
	},
};

const COLUMN_ORDER = ["inc-cost", "total-cost", "inc-tokens", "total-tokens"];

function ansiFg(n, text) {
	return `${ESC}[38;5;${n}m${text}${ESC}[0m`;
}

function money(n, incremental) {
	const body = `$${Math.abs(n).toFixed(2)}`;
	return incremental ? `+${body}` : body;
}

function toks(n) {
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
	if (abs >= 1000) return `${(abs / 1000).toFixed(1)}k`;
	return String(abs);
}

function columnText(row, id) {
	if (id === "inc-cost") return money(row.incCost, true);
	if (id === "total-cost") return money(row.totalCost, false);
	if (id === "inc-tokens") return `+${toks(row.incTokens)}`;
	return `${toks(row.totalTokens)} tok`;
}

function withRunning(raw) {
	const running = {};
	for (const cat of CAT_ORDER) running[cat] = { cost: 0, tokens: 0 };
	let runCost = 0;
	let runTokens = 0;
	return raw.map((bin) => {
		const added = {};
		for (const part of bin.parts) {
			running[part.cat].cost += part.cost;
			running[part.cat].tokens += part.tokens;
			added[part.cat] = {
				cost: (added[part.cat]?.cost ?? 0) + part.cost,
				tokens: (added[part.cat]?.tokens ?? 0) + part.tokens,
			};
		}
		const incCost = bin.parts.reduce((sum, part) => sum + part.cost, 0);
		const incTokens = bin.parts.reduce((sum, part) => sum + part.tokens, 0);
		runCost += incCost;
		runTokens += incTokens;
		const parts = CAT_ORDER.map((cat) => ({
			cat,
			incCost: added[cat]?.cost ?? 0,
			totalCost: running[cat].cost,
			incTokens: added[cat]?.tokens ?? 0,
			totalTokens: running[cat].tokens,
		}));
		return {
			time: bin.time,
			date: bin.date,
			turn: bin.turn,
			miss: bin.miss,
			parts,
			incCost,
			totalCost: runCost,
			incTokens,
			totalTokens: runTokens,
		};
	});
}

const ROWS = withRunning(RAW);

function measureKey(measure) {
	if (measure === "inc-cost") return "incCost";
	if (measure === "total-cost") return "totalCost";
	if (measure === "inc-tokens") return "incTokens";
	return "totalTokens";
}

function incrementalMeasure(measure) {
	return measure === "inc-cost" || measure === "inc-tokens";
}

function largestRemainder(weights, slots) {
	if (slots <= 0) return weights.map((weight) => ({ ...weight, slots: 0 }));
	const total = weights.reduce((sum, weight) => sum + weight.value, 0);
	if (total <= 0) return weights.map((weight) => ({ ...weight, slots: 0 }));
	const raw = weights.map((weight) => {
		const exact = (weight.value / total) * slots;
		return { ...weight, slots: Math.floor(exact), frac: exact - Math.floor(exact) };
	});
	let used = raw.reduce((sum, weight) => sum + weight.slots, 0);
	const order = raw.map((_, index) => index).sort((a, b) => raw[b].frac - raw[a].frac || a - b);
	let cursor = 0;
	while (used < slots && order.length > 0) {
		raw[order[cursor % order.length]].slots += 1;
		used += 1;
		cursor += 1;
	}
	return raw;
}

function orderedParts(row, measure) {
	const key = measureKey(measure);
	const incKey = incrementalMeasure(measure) ? key : (measure === "total-cost" ? "incCost" : "incTokens");
	return CAT_ORDER
		.map((cat) => row.parts.find((part) => part.cat === cat))
		.filter((part) => part && part[key] > 0)
		.map((part) => ({ cat: part.cat, value: part[key], inc: part[incKey], bar: part[key] }));
}

function paintRecency(parts, width) {
	const alloc = largestRemainder(parts, width);
	let plain = "";
	let ansi = "";
	for (const part of alloc) {
		if (part.slots <= 0) continue;
		const ratio = part.bar > 0 ? part.inc / part.bar : 0;
		const rawNew = part.slots * ratio;
		const fresh = Math.min(part.slots, rawNew > 0 ? Math.max(1, Math.round(rawNew)) : 0);
		const old = part.slots - fresh;
		const fg = CATS[part.cat].fg;
		if (old > 0) {
			plain += "▃".repeat(old);
			ansi += ansiFg(fg, "▃".repeat(old));
		}
		if (fresh > 0) {
			plain += "▇".repeat(fresh);
			ansi += ansiFg(fg, "▇".repeat(fresh));
		}
	}
	return { plain, ansi };
}

function paintFull(parts, width) {
	const alloc = largestRemainder(parts, width);
	let plain = "";
	let ansi = "";
	for (const part of alloc) {
		if (part.slots <= 0) continue;
		const glyph = "█".repeat(part.slots);
		plain += glyph;
		ansi += ansiFg(CATS[part.cat].fg, glyph);
	}
	return { plain, ansi };
}

function paintScatter(parts, width, scaleMax) {
	const columns = Array.from({ length: width }, () => []);
	if (scaleMax > 0) {
		for (const part of parts) {
			if (part.value <= 0) continue;
			const pos = Math.round((part.value / scaleMax) * (width - 1));
			const index = Math.max(0, Math.min(width - 1, pos));
			columns[index].push(part);
		}
	}
	let plain = "";
	let ansi = "";
	for (const entries of columns) {
		if (entries.length === 0) {
			plain += " ";
			ansi += " ";
			continue;
		}
		let best = entries[0];
		for (const entry of entries) if (entry.value > best.value) best = entry;
		plain += "█";
		ansi += ansiFg(CATS[best.cat].fg, "█");
	}
	return { plain, ansi };
}

function encodingOf(opts, notes) {
	if (opts.layout === "scatter" && (opts.measure === "inc-tokens" || opts.measure === "total-tokens")) {
		notes.push("Scatter is the cost bucket bar. A token bar is a stack.");
	}
	if (opts.measure !== "total-tokens") {
		if (opts.recency) notes.push("Recency stays off. It is the token running-total bar.");
		return "full";
	}
	if (opts.layout === "scatter") {
		notes.push("Scatter has no recency glyph. A column keeps the larger category.");
		return "full";
	}
	if (opts.recency) return "recency";
	return "full";
}

function divider(label, width) {
	const prefix = `── ${label} `;
	return prefix + "─".repeat(Math.max(0, width - prefix.length));
}

function strideLabel(turn, rules) {
	if (rules.hundred && turn % 100 === 0) return "100 turns";
	if (rules.ten && turn % 10 === 0) return "10 turns";
	return null;
}

function lawText(encoding) {
	if (encoding === "recency") {
		return "A cell is one category. Color is the category. ▃ is carryover. ▇ is new this bin.";
	}
	return "A cell is one category, drawn as █. Color is the category.";
}

export function render(opts) {
	const width = opts.width ?? 16;
	const notes = [];
	const encoding = encodingOf(opts, notes);
	const columns = COLUMN_ORDER.filter((id) => (opts.columns ?? []).includes(id));
	const rules = {
		miss: true,
		date: true,
		ten: false,
		hundred: false,
		...opts.rules,
	};
	if (opts.interval !== "turns" && (rules.ten || rules.hundred)) notes.push("Turn lines are off: the interval is time.");
	if (!rules.miss || !rules.date) notes.push("The chart always draws a cache-miss line and a date change.");
	const shipped = (opts.layout === "stack" && opts.measure === "total-cost" && !opts.recency)
		|| (opts.layout === "scatter" && opts.measure === "inc-cost" && !opts.recency)
		|| (opts.layout === "stack" && opts.measure === "total-tokens" && opts.recency)
		|| (opts.layout === "stack" && opts.measure === "inc-tokens" && !opts.recency);
	if (!shipped) notes.push("This combination is not one of the four shipped pictures.");

	const newestFirst = [...ROWS].reverse();
	const labels = newestFirst.map((row) => (opts.interval === "turns" ? `${row.turn}t` : row.time));
	const labelWidth = Math.max(...labels.map((label) => label.length), 5);
	const columnWidths = columns.map((id) => Math.max(...ROWS.map((row) => columnText(row, id).length), id.length));

	const key = measureKey(opts.measure);
	const scaleMax = Math.max(...ROWS.map((row) => row[key]), 0);
	const barSlots = (row) => {
		if (scaleMax <= 0 || row[key] <= 0) return 0;
		return Math.max(0, Math.round((row[key] / scaleMax) * width));
	};

	const body = (row, label) => {
		const fields = columns.map((id, index) => columnText(row, id).padStart(columnWidths[index], " "));
		const parts = orderedParts(row, opts.measure);
		const slots = opts.layout === "scatter" ? width : barSlots(row);
		let bar;
		if (opts.layout === "scatter") bar = paintScatter(parts, slots, scaleMax);
		else if (encoding === "recency") bar = paintRecency(parts, slots);
		else bar = paintFull(parts, slots);
		const head = [label.padEnd(labelWidth, " "), ...fields].join("  ");
		return {
			plain: `${head}  ${bar.plain}`.replace(/ +$/g, ""),
			ansi: `${head}  ${bar.ansi}`.replace(/ +$/g, ""),
		};
	};

	const bodies = newestFirst.map((row, index) => body(row, labels[index]));
	const lineWidth = Math.max(...bodies.map((drawn) => drawn.plain.length));
	const plain = [];
	const ansi = [];
	const push = (text) => {
		plain.push(text);
		ansi.push(`${ESC}[90m${text}${ESC}[0m`);
	};

	for (let i = 0; i < newestFirst.length; i += 1) {
		const row = newestFirst[i];
		if (i > 0) {
			const newer = newestFirst[i - 1];
			if (rules.miss && newer.miss) push(divider("Cache Miss", lineWidth));
			const dateOn = rules.date;
			if (dateOn && newer.date !== row.date) push(divider(row.date, lineWidth));
			if (opts.interval === "turns") {
				const stride = strideLabel(newer.turn, rules);
				if (stride) push(divider(stride, lineWidth));
			}
		}
		plain.push(bodies[i].plain);
		ansi.push(bodies[i].ansi);
	}

	const oldest = newestFirst[newestFirst.length - 1];
	if (rules.miss && oldest.miss) push(divider("Cache Miss", lineWidth));
	if (opts.interval === "turns") {
		const stride = strideLabel(oldest.turn, rules);
		if (stride) push(divider(stride, lineWidth));
	}

	const present = new Set(ROWS.flatMap((row) => row.parts.filter((part) => part.incCost > 0 || part.incTokens > 0).map((part) => part.cat)));
	const legend = CAT_ORDER.filter((cat) => present.has(cat))
		.map((cat) => ({ cat, label: CATS[cat].label, fg: CATS[cat].fg }));

	return {
		law: lawText(encoding),
		notes,
		legend,
		plain,
		ansi,
		lineCount: plain.length,
	};
}

export function xtermRgb(n) {
	if (n < 16 || n > 255) return "rgb(180,180,180)";
	if (n >= 232) {
		const gray = 8 + (n - 232) * 10;
		return `rgb(${gray},${gray},${gray})`;
	}
	const index = n - 16;
	const step = [0, 95, 135, 175, 215, 255];
	return `rgb(${step[Math.floor(index / 36)]},${step[Math.floor(index / 6) % 6]},${step[index % 6]})`;
}
