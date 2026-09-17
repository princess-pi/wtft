// debug/142-heartbeat-reseed.mjs — reproduce Macroscope's PR #142 Medium finding
// before adopting it: does an IDLE watch reseed on every heartbeat?
//
// The claim: `readPrefixSentinel` samples the 64 bytes immediately before the
// reader's offset. The reader's offset sits at EOF, and the final line is the
// heartbeat, which `upsertHeartbeat` rewrites in place every POLL_MS. So the
// sampled window overlaps a line that mutates by design, the sentinel
// mismatches, and `watcherAction` returns "reseed" — a whole-file re-read and
// re-parse — on a file that gained nothing.
//
// Run: node debug/142-heartbeat-reseed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPrefixSentinel, sentinelMatches, watcherAction, PREFIX_SENTINEL_BYTES } from "../bin/wtft.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-142-"));
const tag = path.join(dir, "tag.jsonl");

// A tag file shaped like a real one: records, then the heartbeat last.
const records = [];
for (let i = 0; i < 400; i++) {
	records.push(JSON.stringify({ id: `turn-${i}`, model: "claude-opus-5", costUsd: 0.0123, cat: "read" }));
}
const hb = (last) => JSON.stringify({ _hb: { first: 1758000000000, last } });
fs.writeFileSync(tag, records.join("\n") + "\n" + hb(1758000000000) + "\n");

const size = fs.statSync(tag).size;
const offset = size; // the reader consumed every whole line, so it sits at EOF
console.log(`tag file: ${records.length} records + 1 heartbeat, ${size} bytes`);
console.log(`heartbeat line is ${hb(1758000000000).length + 1} bytes; sentinel window is ${PREFIX_SENTINEL_BYTES}`);

const before = readPrefixSentinel(tag, offset);

// One beat: rewrite the heartbeat IN PLACE, same width, no size change.
const hbLine = Buffer.from(hb(1758000000667) + "\n", "utf8");
const fd = fs.openSync(tag, "r+");
fs.writeSync(fd, hbLine, 0, hbLine.length, size - hbLine.length);
fs.closeSync(fd);

const after = readPrefixSentinel(tag, offset);
const sizeNow = fs.statSync(tag).size;
const matches = sentinelMatches(after, before);
const action = watcherAction(sizeNow, offset, matches);

console.log(`size unchanged:      ${sizeNow === size}`);
console.log(`sentinel matches:    ${matches}`);
console.log(`watcherAction:       ${action}   <-- "idle" is correct here; nothing was appended`);

// And the cost of being wrong, at the daemon's real cadence.
const POLL_MS = 667;
const t0 = process.hrtime.bigint();
const N = 50;
for (let i = 0; i < N; i++) {
	const buf = fs.readFileSync(tag, "utf8");
	let n = 0;
	for (const line of buf.split("\n")) { if (line) { try { JSON.parse(line); n++; } catch {} } }
	if (n !== records.length + 1) throw new Error(`parsed ${n}`);
}
const perReseed = Number(process.hrtime.bigint() - t0) / 1e6 / N;
console.log(`\nwhole-file re-read + parse: ${perReseed.toFixed(2)} ms`);
console.log(`at one per ${POLL_MS} ms beat: ${((perReseed / POLL_MS) * 100).toFixed(2)}% of a core, forever, while IDLE`);

fs.rmSync(dir, { recursive: true, force: true });
