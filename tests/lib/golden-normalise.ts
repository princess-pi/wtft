/**
 * The golden normalisation: what the golden-tag suite and the session-tagger
 * suite compare, so both judge a tag the same way.
 */

import * as path from "node:path";
import { readTagFileWithVerdict, transcriptSourceId } from "../../extensions/lib/wtft-daemon-lib.ts";
import { cwdToStrictSlug } from "../../extensions/lib/harness/session-cwd.ts";
import type { CorpusSession } from "./golden-corpus.ts";

/** One line of the tag with everything host- or clock-dependent replaced. */
export function normaliseLine(line: string, s: CorpusSession, sandbox: string): string {
	let obj: any;
	try { obj = JSON.parse(line); } catch { return `<unparseable> ${line}`; }
	if (obj._hb && typeof obj._hb === "object") obj._hb = { first: 0, last: 0 };
	if (obj._meta) {
		if (typeof obj._meta.offset === "number") obj._meta.offset = 0;
		if (typeof obj._meta.swept === "number") obj._meta.swept = 0;
		if (typeof obj._meta.unswept === "number") obj._meta.unswept = 0;
		// Discovery order is readdir order.
		if (Array.isArray(obj._meta.children)) obj._meta.children = [...obj._meta.children].sort();
	}
	let text = JSON.stringify(obj);
	const sessionDir = path.dirname(s.session);
	for (const [label, file] of Object.entries(s.children)) {
		text = text.split(transcriptSourceId(file, sessionDir)).join(`<s:${label}>`);
	}
	text = text.split(cwdToStrictSlug(sandbox)).join("<SLUG>");
	text = text.split(sandbox).join("<SANDBOX>");
	return text;
}

export function normaliseTag(content: string, s: CorpusSession, sandbox: string): string[] {
	return content.split("\n").filter(l => l.trim()).map(l => normaliseLine(l, s, sandbox)).sort();
}

/** What a reader takes from the tag, so a byte-identical multiset in a
 *  different order that changed meaning is still caught. */
export function viewOf(tagPath: string, s: CorpusSession): Record<string, unknown> {
	const read = readTagFileWithVerdict(tagPath);
	const bySource = new Map<string, string>();
	const sessionDir = path.dirname(s.session);
	for (const [label, file] of Object.entries(s.children)) bySource.set(transcriptSourceId(file, sessionDir), label);
	let output = 0;
	let cost = 0;
	for (const i of read.interactions) { output += i.outputTokens || 0; cost += i.cost || 0; }
	return {
		turns: read.interactions.length,
		outputTokens: output,
		costUsd: Number(cost.toFixed(6)),
		interrupted: read.interactions.filter((i: any) => i.interrupted).length,
		folded: [...read.folded].sort(),
		provisional: read.provisional,
	};
}
