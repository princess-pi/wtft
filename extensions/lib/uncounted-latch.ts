import * as fs from "node:fs";

import { PARSE_CHUNK_BYTES, readUncountedBillableClass } from "./wtft-parser.ts";

export interface UncountedLatchIo {
	size(path: string): number | null;
	readFrom(path: string, offset: number, length: number): Buffer | null;
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
	readFrom(path, offset, length) {
		let fd: number;
		try { fd = fs.openSync(path, "r"); } catch { return null; }
		try {
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, offset);
			return buf.subarray(0, n);
		} catch {
			return null;
		} finally {
			fs.closeSync(fd);
		}
	},
};

/** True once any of the given transcripts holds a compaction or a recap: docs/spec-515-floor-marker.md § 3.
 *  `paths` is iterated only while nothing has been seen. */
export function createUncountedLatch(io: UncountedLatchIo = nodeIo, chunkBytes: number = PARSE_CHUNK_BYTES): UncountedLatch {
	const progress = new Map<string, { offset: number; tail: Buffer }>();
	let latched = false;
	const scan = (path: string): boolean => {
		const size = io.size(path);
		if (size === null) return false;
		let at = progress.get(path) ?? { offset: 0, tail: Buffer.alloc(0) };
		if (size < at.offset) at = { offset: 0, tail: Buffer.alloc(0) };
		while (at.offset < size) {
			const chunk = io.readFrom(path, at.offset, Math.min(chunkBytes, size - at.offset));
			if (chunk === null || chunk.length === 0) break;
			const bytes = Buffer.concat([at.tail, chunk]);
			const end = bytes.lastIndexOf(0x0a) + 1;
			at = { offset: at.offset + chunk.length, tail: bytes.subarray(end) };
			progress.set(path, at);
			for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				let entry: unknown;
				try { entry = JSON.parse(line); } catch { continue; }
				if (readUncountedBillableClass(entry)) return true;
			}
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
