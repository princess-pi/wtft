import * as fs from "node:fs";

import type { Interaction } from "./wtft-parser.ts";
import { classifiedInteractionsFromContent } from "./wtft-daemon-lib.ts";

export interface TagFileStat {
	ino: number;
	size: number;
}

export interface TagReadIo {
	stat(path: string): TagFileStat | null;
	read(path: string): { stat: TagFileStat; content: string } | null;
}

export interface TagReadCache {
	interactions(path: string): Interaction[];
	retain(paths: Iterable<string>): void;
}

const nodeIo: TagReadIo = {
	stat(path) {
		try {
			const { ino, size } = fs.statSync(path);
			return { ino, size };
		} catch {
			return null;
		}
	},
	read(path) {
		let fd: number;
		try { fd = fs.openSync(path, "r"); } catch { return null; }
		try {
			const { ino } = fs.fstatSync(fd);
			const bytes = fs.readFileSync(fd);
			return { stat: { ino, size: bytes.length }, content: bytes.toString("utf8") };
		} catch {
			return null;
		} finally {
			fs.closeSync(fd);
		}
	},
};

export function createTagReadCache(io: TagReadIo = nodeIo): TagReadCache {
	const entries = new Map<string, { stat: TagFileStat; interactions: Interaction[] }>();
	return {
		interactions(path) {
			const now = io.stat(path);
			const prev = entries.get(path);
			if (now && prev && prev.stat.ino === now.ino && prev.stat.size === now.size) return prev.interactions;
			entries.delete(path);
			const got = now && io.read(path);
			if (!got) return [];
			const interactions = classifiedInteractionsFromContent(got.content);
			entries.set(path, { stat: got.stat, interactions });
			return interactions;
		},
		retain(paths) {
			const keep = new Set(paths);
			for (const path of entries.keys()) if (!keep.has(path)) entries.delete(path);
		},
	};
}
