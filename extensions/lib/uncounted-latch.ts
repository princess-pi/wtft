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

/** True once any of the given transcripts holds a compaction or a recap: docs/spec-515-floor-marker.md § 3. */
export function createUncountedLatch(io: UncountedLatchIo = nodeIo, chunkBytes: number = PARSE_CHUNK_BYTES): UncountedLatch {
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
		throw new RangeError(`createUncountedLatch: chunkBytes must be a positive safe integer, got ${chunkBytes}`);
	}
	const progress = new Map<string, { offset: number; carry: Buffer[] }>();
	let latched = false;
	const scan = (path: string): boolean => {
		const size = io.size(path);
		if (size === null) return false;
		let at = progress.get(path) ?? { offset: 0, carry: [] };
		if (size < at.offset) at = { offset: 0, carry: [] };
		progress.set(path, at);
		while (at.offset < size) {
			const chunk = io.readFrom(path, at.offset, Math.min(chunkBytes, size - at.offset));
			if (chunk === null || chunk.length === 0) break;
			at.offset += chunk.length;
			const end = chunk.lastIndexOf(0x0a) + 1;
			if (end === 0) {
				at.carry.push(chunk);
				continue;
			}
			const complete = Buffer.concat([...at.carry, chunk.subarray(0, end)]);
			at.carry = [chunk.subarray(end)];
			for (const line of complete.toString("utf8").split("\n")) {
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
