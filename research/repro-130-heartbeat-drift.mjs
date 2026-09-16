#!/usr/bin/env node
// ---
// #130 repro — the daemon's own heartbeat upsert welds two lines together.
//
// Replicates `upsertHeartbeat` from bin/wtft-daemon.ts verbatim in its essential
// part: a backward chunk scan that reads BYTES and then measures the result in a
// DECODED STRING, so `searchOffset + lastLineStart` adds a byte offset to a
// UTF-16 code-unit index. Every multi-byte character between the two makes the
// truncate land that many bytes early — inside the preceding line.
//
// Run: node research/repro-130-heartbeat-drift.mjs
// ---
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-repro-"));

// The buggy scan, lifted from bin/wtft-daemon.ts upsertHeartbeat.
function buggyTruncateOffset(file) {
	const stat = fs.statSync(file);
	const fd = fs.openSync(file, "r");
	const CHUNK = 512;
	let searchOffset = stat.size;
	let tail = "";
	let lastNl = -1;
	while (searchOffset > 0 && lastNl === -1) {
		const readSize = Math.min(CHUNK, searchOffset);
		searchOffset -= readSize;
		const buf = Buffer.alloc(readSize);
		fs.readSync(fd, buf, 0, readSize, searchOffset);
		tail = buf.toString("utf8") + tail;       // BYTES -> a JS string
		lastNl = tail.lastIndexOf("\n");          // an index in code units
	}
	fs.closeSync(fd);
	let lastLineStart;
	if (lastNl === tail.length - 1) {
		const prevNl = tail.lastIndexOf("\n", tail.length - 2);
		lastLineStart = prevNl === -1 ? 0 : prevNl + 1;
	} else if (lastNl === -1) {
		lastLineStart = 0;
	} else {
		lastLineStart = lastNl + 1;
	}
	return searchOffset + lastLineStart;          // BYTE offset + STRING index
}

// The truth: where the last line actually begins, in bytes.
function trueLastLineStart(file) {
	const buf = fs.readFileSync(file);
	const end = buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length;
	const nl = buf.subarray(0, end).lastIndexOf(0x0a);
	return nl === -1 ? 0 : nl + 1;
}

const FIXTURES = [
	["pure ASCII", "run the build and wait"],
	["one em dash", "run the build — then wait"],
	["arrows + dashes", "a → b — c → d"],
];

console.log("fixture            drift  lines before -> after  corrupt");
for (const [name, text] of FIXTURES) {
	const file = path.join(dir, name.replace(/\W+/g, "-") + ".jsonl");
	fs.writeFileSync(file,
		JSON.stringify({ t: 1, cmd: [text] }) + "\n" +
		JSON.stringify({ _meta: { swept: 1788828490280 } }) + "\n" +
		JSON.stringify({ _hb: { first: 0, last: 1 } }) + "\n");
	const before = fs.readFileSync(file, "utf8").trimEnd().split("\n").length;

	// Exactly what the daemon does: truncate the stale heartbeat, append a fresh one.
	const truncAt = buggyTruncateOffset(file);
	const drift = trueLastLineStart(file) - truncAt;
	const fd = fs.openSync(file, "r+");
	fs.ftruncateSync(fd, truncAt);
	fs.closeSync(fd);
	fs.appendFileSync(file, JSON.stringify({ _hb: { first: 1, last: 2 } }) + "\n");

	const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
	let corrupt = 0;
	for (const line of lines) { try { JSON.parse(line); } catch { corrupt++; } }
	console.log(`${name.padEnd(18)} ${String(drift).padStart(2)} B  ${before} -> ${lines.length}`.padEnd(48) + String(corrupt));
	for (const line of lines) { try { JSON.parse(line); } catch { console.log("    " + line); } }
}
console.log(`\nfixtures left in ${dir}`);
