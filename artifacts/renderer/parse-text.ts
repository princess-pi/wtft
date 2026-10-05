/**
 * The parser playground's read of pasted JSONL: the per-line loop
 * `parseSessionFileCounted` runs over a file, run over a string instead, then
 * the dedupe, the classifier and the overhead split the daemon applies before
 * it writes a tag line. Every decision is the parser's own exported function;
 * this file only walks the lines and keeps notes for the page.
 *
 * Left out, because the browser has no filesystem: the `claude -p` fold
 * (`attributeClaudeSubAgentCosts`) and subagent discovery.
 */

import {
	applyControlEntry,
	classifyInteraction,
	commandSpawnsAgent,
	deduplicateInteractions,
	newParseStreamState,
	parseEntryToInteraction,
	readControlEntry,
	splitOverheadCost,
	type Category,
	type Interaction,
} from "../../extensions/lib/wtft-parser.ts";
import { extractRealCommands } from "../../extensions/lib/wtft-command-shapes.ts";

export type LineKind = "blank" | "bad-json" | "partial" | "control" | "turn" | "ignored" | "error";

/** What the loop did with one line of the input. */
export interface LineNote {
	/** 1-based. */
	line: number;
	kind: LineKind;
	/** The control signal's kind, for a control line. */
	control?: string;
	/** The JSON or parse error, for a bad or failed line. */
	error?: string;
	/** Index into `raw`, for a turn line. */
	raw?: number;
}

/** Which input the classifier decided on, found by running it on each input alone. */
export type Decider = "tag" | "interrupted" | "files" | "tools" | "commands" | "texts" | "fallback";

/** One deduplicated interaction and what the daemon would decide about it. */
export interface ParsedTurn {
	interaction: Interaction;
	category: Category;
	decidedBy: Decider;
	/** 1-based input lines whose turns were merged into this one. */
	lines: number[];
	/** input + cacheRead + cacheWrite of the previous non-sidechain turn; 0 for the first. */
	prevCtxTokens: number;
	/** The daemon's split of this turn's cache-write cost, when it makes one. */
	overhead: { kind: "compaction" | "overhead"; overheadCost: number } | null;
	/** True when a command spawns `claude`: the daemon would fold that child's cost in here. */
	spawnsAgent: boolean;
}

export interface ParsedText {
	notes: LineNote[];
	/** Turns as parsed, before the dedupe, in line order. */
	raw: Interaction[];
	turns: ParsedTurn[];
	/** Non-blank lines, and lines that parsed as JSON, as `parseSessionFileStrict` counts them. */
	lines: number;
	jsonLines: number;
}

/**
 * Which input decided the category, read in the classifier's own order: a tag's
 * `_cat`, the interrupt flag, file paths, tool categories, shell commands, then
 * text. File paths and tool categories are tested by running the classifier on
 * that input alone; shell commands decide whenever one real command is left
 * after `extractRealCommands` strips navigation and wrappers.
 */
export function decidedBy(interaction: Interaction): Decider {
	if (interaction._cat) return "tag";
	if (interaction.interrupted) return "interrupted";
	const bare: Interaction = { ...interaction, files: [], commands: [], texts: [], toolCats: undefined, unrecognizedTool: undefined };
	if (interaction.files.length > 0 && classifyInteraction({ ...bare, files: interaction.files }) !== "other") return "files";
	if (interaction.toolCats?.length && classifyInteraction({ ...bare, toolCats: interaction.toolCats }) !== "other") return "tools";
	if (interaction.commands.flatMap((cmd) => extractRealCommands(cmd)).length > 0) return "commands";
	if (interaction.texts.length > 0 && !interaction.unrecognizedTool) return "texts";
	return "fallback";
}

/** Parses pasted JSONL the way the daemon parses a session file, short of the `claude -p` fold. */
export function parseJsonlText(text: string): ParsedText {
	const notes: LineNote[] = [];
	const raw: Interaction[] = [];
	const rawLine: number[] = [];
	const state = newParseStreamState();
	const all = text.split("\n");
	let lines = 0;
	let jsonLines = 0;
	all.forEach((lineText, at) => {
		const line = at + 1;
		if (!lineText.trim()) { notes.push({ line, kind: "blank" }); return; }
		lines++;
		let entry: unknown;
		try {
			entry = JSON.parse(lineText);
		} catch (err) {
			// The text after the last newline, unparsed, is a line still being written.
			const partial = at === all.length - 1;
			if (partial) lines--;
			notes.push({ line, kind: partial ? "partial" : "bad-json", error: (err as Error).message });
			return;
		}
		jsonLines++;
		try {
			const signal = readControlEntry(entry);
			const isControl = applyControlEntry(entry, state, () => {
				if (raw.length > 0) raw[raw.length - 1].interrupted = true;
			});
			if (isControl) { notes.push({ line, kind: "control", control: signal?.kind }); return; }
			const interaction = parseEntryToInteraction(entry, state.thinkingLevel, state.compactionTokensBefore, state.afterCompaction, state.model);
			if (!interaction) { notes.push({ line, kind: "ignored" }); return; }
			notes.push({ line, kind: "turn", raw: raw.length });
			raw.push(interaction);
			rawLine.push(line);
			state.compactionTokensBefore = undefined;
			state.afterCompaction = false;
		} catch (err) {
			notes.push({ line, kind: "error", error: (err as Error).message });
		}
	});

	// Copies, so `raw` stays as parsed. The dedupe passes a turn with no twin
	// through as the same object, and builds a new one for a merged group.
	const copies = raw.map((i) => ({ ...i }));
	const lineOf = new Map(copies.map((copy, i) => [copy, rawLine[i]!]));
	const deduped = deduplicateInteractions(copies);
	const turns: ParsedTurn[] = [];
	let prevCtxTokens = 0;
	for (const interaction of deduped) {
		const own = lineOf.get(interaction);
		const sourceLines = own !== undefined ? [own] : raw.flatMap((r, i) => (r.messageId === interaction.messageId ? [rawLine[i]!] : []));
		turns.push({
			interaction,
			category: classifyInteraction(interaction),
			decidedBy: decidedBy(interaction),
			lines: sourceLines,
			prevCtxTokens,
			overhead: splitOverheadCost(interaction, prevCtxTokens),
			spawnsAgent: interaction.commands.some(commandSpawnsAgent),
		});
		if (!interaction.isSidechain) prevCtxTokens = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
	}
	return { notes, raw, turns, lines, jsonLines };
}
