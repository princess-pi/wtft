/**
 * The tag file's record kinds, read once and typed. Every reader of a tag file
 * decides a line's kind here, never by substring. Format: docs/wtft-tag-format.md.
 */

import type { Interaction } from "./wtft-parser.js";
import { classifiedToInteraction } from "./wtft-daemon-lib.js";

export type TagRecord =
	| { kind: "turn"; interaction: Interaction; source: string | undefined; raw: any }
	| { kind: "heartbeat"; first: number; last: number }
	| { kind: "stop"; reason: string | undefined }
	| { kind: "offset"; offset: number }
	/** A sweep marker may share its line with an offset. */
	| { kind: "swept"; at: number; offset?: number }
	| { kind: "unswept"; at: number; offset?: number }
	| { kind: "spawn-pending"; key: string; at: number; commands: string[] }
	| { kind: "spawn-settled"; key: string; children: string[] }
	| { kind: "fold"; parent: string | undefined; child: string; source: string | undefined }
	| { kind: "generation"; source: string; session: string | undefined }
	/** A `_meta` object none of the shapes above match: a marker, passed over. */
	| { kind: "meta-other" }
	/** A parsed object of no known shape. Not a marker: the sweep state reads it as data. */
	| { kind: "unknown" };

/** Data records are what a reader counts; markers are the daemon's own state. */
export function isDataRecord(r: TagRecord): boolean {
	return r.kind === "turn" || r.kind === "fold" || r.kind === "generation";
}

/** One line, or null when it does not parse as JSON (a final-line fragment). */
export function parseTagLine(line: string): TagRecord | null {
	const text = line.trim();
	if (!text) return null;
	let obj: any;
	try { obj = JSON.parse(text); } catch { return null; }
	return recordOf(obj);
}

export function recordOf(obj: any): TagRecord {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { kind: "unknown" };
	if ("_hb" in obj) {
		const hb = obj._hb;
		if (hb === "stop") return { kind: "stop", reason: typeof obj.reason === "string" ? obj.reason : undefined };
		if (hb && typeof hb === "object") return { kind: "heartbeat", first: Number(hb.first) || 0, last: Number(hb.last) || 0 };
		return { kind: "unknown" };
	}
	if ("_meta" in obj) {
		const meta = obj._meta;
		if (!meta || typeof meta !== "object") return { kind: "meta-other" };
		const offset = typeof meta.offset === "number" ? meta.offset : undefined;
		if (typeof meta.unswept === "number") return { kind: "unswept", at: meta.unswept, ...(offset !== undefined ? { offset } : {}) };
		if (typeof meta.swept === "number") return { kind: "swept", at: meta.swept, ...(offset !== undefined ? { offset } : {}) };
		if (offset !== undefined) return { kind: "offset", offset };
		const p = meta.spawnPending;
		if (p && typeof p === "object" && typeof p.key === "string" && typeof p.at === "number" && Array.isArray(p.commands)) {
			return { kind: "spawn-pending", key: p.key, at: p.at, commands: p.commands.filter((c: unknown): c is string => typeof c === "string") };
		}
		if (typeof meta.spawnSettled === "string") {
			const children = Array.isArray(meta.children) ? meta.children.filter((c: unknown): c is string => typeof c === "string") : [];
			return { kind: "spawn-settled", key: meta.spawnSettled, children };
		}
		return { kind: "meta-other" };
	}
	if ("_fold" in obj) {
		const f = obj._fold;
		if (f && typeof f === "object" && typeof f.child === "string" && f.child) {
			return { kind: "fold", parent: typeof f.parent === "string" ? f.parent : undefined, child: f.child, source: typeof f.s === "string" ? f.s : undefined };
		}
		return { kind: "unknown" };
	}
	if ("_gen" in obj) {
		const g = obj._gen;
		if (g && typeof g === "object" && typeof g.s === "string") {
			return { kind: "generation", source: g.s, session: typeof g.session === "string" ? g.session : undefined };
		}
		return { kind: "unknown" };
	}
	// A malformed field throws inside the decoder; that line is skipped on its own.
	let interaction: Interaction | null;
	try { interaction = classifiedToInteraction(obj); } catch { return { kind: "unknown" }; }
	if (!interaction) return { kind: "unknown" };
	return { kind: "turn", interaction, source: interaction.source, raw: obj };
}

/** Every parseable line of `content`, in file order. A line that does not
 *  parse is skipped on its own and never fails the read. */
export function tagRecords(content: string): TagRecord[] {
	const out: TagRecord[] = [];
	for (const line of content.split("\n")) {
		const r = parseTagLine(line);
		if (r) out.push(r);
	}
	return out;
}

/** `records` minus every sourced record a later generation record for the
 *  same source supersedes. A record with no source always counts. */
export function currentGeneration(records: TagRecord[]): TagRecord[] {
	const lastGenAt = new Map<string, number>();
	records.forEach((r, at) => { if (r.kind === "generation") lastGenAt.set(r.source, at); });
	if (lastGenAt.size === 0) return records;
	return records.filter((r, at) => {
		const s = r.kind === "turn" || r.kind === "fold" ? r.source : undefined;
		if (s === undefined) return true;
		const genAt = lastGenAt.get(s);
		return genAt === undefined || at > genAt;
	});
}

/** The last marker that decides the sweep state, scanning back from the end:
 *  `swept` or `unswept` wins; a data record before either means unswept; a
 *  heartbeat, offset or other marker is passed over. */
export function sweepState(records: TagRecord[]): "swept" | "unswept" {
	for (let i = records.length - 1; i >= 0; i--) {
		const r = records[i];
		if (r.kind === "unswept") return "unswept";
		if (r.kind === "swept") return "swept";
		if (isDataRecord(r) || r.kind === "unknown") return "unswept";
	}
	return "unswept";
}

/** The last offset marker, or null when the tag carries none. */
export function lastOffset(records: TagRecord[]): number | null {
	for (let i = records.length - 1; i >= 0; i--) {
		const r = records[i];
		if (r.kind === "offset") return r.offset;
		if ((r.kind === "swept" || r.kind === "unswept") && r.offset !== undefined) return r.offset;
	}
	return null;
}
