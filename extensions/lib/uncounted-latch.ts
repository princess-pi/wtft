import * as fs from "node:fs";

import { readUncountedBillableClass } from "./wtft-parser.ts";

export interface UncountedLatchIo {
	size(path: string): number | null;
	readFrom(path: string, offset: number): string | null;
}

export interface UncountedLatch {
	seen(paths: Iterable<string>): boolean;
}

const nodeIo: UncountedLatchIo = {
	size(path) {
		try {
			return fs.statSync(path).size;
		} catch {
			return null;
		}
	},
	readFrom(path, offset) {
		let fd: number;
		try { fd = fs.openSync(path, "r"); } catch { return null; }
		try {
			const size = fs.fstatSync(fd).size;
			if (size <= offset) return "";
			const buf = Buffer.alloc(size - offset);
			const n = fs.readSync(fd, buf, 0, buf.length, offset);
			return buf.subarray(0, n).toString("utf8");
		} catch {
			return null;
		} finally {
			fs.closeSync(fd);
		}
	},
};

/** True once any of the given transcripts holds a compaction or a recap: docs/spec-515-floor-marker.md § 3. */
export function createUncountedLatch(io: UncountedLatchIo = nodeIo): UncountedLatch {
	const progress = new Map<string, { offset: number; tail: string }>();
	let latched = false;
	const scan = (path: string): boolean => {
		const size = io.size(path);
		if (size === null) return false;
		let at = progress.get(path) ?? { offset: 0, tail: "" };
		if (size < at.offset) at = { offset: 0, tail: "" };
		if (size === at.offset) return false;
		const chunk = io.readFrom(path, at.offset);
		if (chunk === null) return false;
		const lines = (at.tail + chunk).split("\n");
		const tail = lines.pop() ?? "";
		progress.set(path, { offset: at.offset + Buffer.byteLength(chunk), tail });
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			if (readUncountedBillableClass(entry)) return true;
		}
		return false;
	};
	return {
		seen(paths) {
			if (latched) return true;
			for (const path of paths) {
				if (scan(path)) return (latched = true);
			}
			return false;
		},
	};
}
