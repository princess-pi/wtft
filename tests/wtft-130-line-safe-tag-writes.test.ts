#!/usr/bin/env bun
/**
 * @package princess-pi-tools
 * @test wtft-130-line-safe-tag-writes
 * @description #130 — the tag file is line-safe BY CONSTRUCTION.
 *
 *   Duppy's rule: any daemon parser that writes less than a full line to a tag
 *   file is a bug in the parser. Readers may presume every line is complete, so
 *   the guarantee has to live in the writer, in one place.
 *
 *   WHAT WAS BROKEN. `upsertHeartbeat` scanned backwards from EOF for the start
 *   of the last line, reading BYTES and then measuring in a DECODED STRING:
 *   `searchOffset + lastLineStart` adds a byte offset to a UTF-16 code-unit
 *   index. Every multi-byte character in between drove the truncate that many
 *   bytes into the PRECEDING line, and the fresh heartbeat was welded onto the
 *   severed half. Measured on this host: 96 of 327 tag files, 2,562 welded
 *   lines, 99.7% of them with `→` or `—` in the preceding 2 KiB.
 *
 *   WHY A SEAM AND NOT A PRIVATE FIX. `lastLineStartByte` is the whole defect in
 *   one function: it is the number that must be a byte offset and must land on a
 *   line boundary. Exporting it is what lets W1-W6 pin it directly instead of
 *   inferring it from a corrupted file after the fact.
 *
 *   The Closer is E1, which drives the REAL daemon — a seam that is right in
 *   isolation and miswired in `upsertHeartbeat` would pass W1-W6 and still
 *   corrupt the file.
 *
 * @usage bun run test wtft-130-line-safe-tag-writes
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { lastLineStartByte, getCurrentVersionTagPath, readClassifiedTagFile } from "../bin/wtft.mjs";
import { pollUntil, sleep } from "./lib/poll";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("130-line-safe");

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else {
		console.log(`  ${RED}FAIL${RESET} ${label}`); failed++;
		if (detail) console.log(detail.split("\n").map(l => `      │ ${l}`).join("\n"));
	}
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-")));

/** Write `content` and return the byte offset where its last line truly begins.
 *  Computed from the raw bytes, which is the definition the code under test owes
 *  an answer to — never from a decoded string, which is the bug. */
function fixture(name: string, content: string): { file: string; truth: number; size: number } {
	const file = path.join(root, name);
	fs.writeFileSync(file, content);
	const buf = fs.readFileSync(file);
	const end = buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length;
	const nl = buf.subarray(0, end).lastIndexOf(0x0a);
	return { file, truth: nl === -1 ? 0 : nl + 1, size: buf.length };
}

function offsetOf(file: string, size: number, chunkSize?: number): number {
	const fd = fs.openSync(file, "r");
	try { return lastLineStartByte(fd, size, chunkSize); }
	finally { fs.closeSync(fd); }
}

console.log("\n§ W — lastLineStartByte answers in BYTES, on a line boundary\n");

// W1 — the baseline the broken version also passes. Present so a regression can
// be told apart from a fixture that never exercised the defect at all.
{
	const f = fixture("w1-ascii.jsonl",
		`{"t":1,"cmd":["run the build"]}\n{"_meta":{"swept":1788828490280}}\n{"_hb":{"first":0,"last":1}}\n`);
	const got = offsetOf(f.file, f.size);
	assert("W1 ASCII-only: the last line's byte offset", got === f.truth, `expected ${f.truth}, got ${got}`);
}

// W2 — THE defect. Two multi-byte characters ahead of the last line; the string
// -index version returns an offset 4 bytes short, inside the `_meta` line.
{
	const f = fixture("w2-multibyte.jsonl",
		`{"t":1,"cmd":["a → b — c"]}\n{"_meta":{"swept":1788828490280}}\n{"_hb":{"first":0,"last":1}}\n`);
	const got = offsetOf(f.file, f.size);
	assert("W2 → and — ahead of it: still the true BYTE offset", got === f.truth, `expected ${f.truth}, got ${got} (short by ${f.truth - got} bytes — the #130 drift)`);
}

// W3 — a multi-byte sequence straddling the chunk boundary. Decoding a chunk in
// isolation yields U+FFFD and the scan measures text the file does not contain,
// so this fails for a fix that works in bytes only per-chunk.
{
	const pad = "—".repeat(200);          // 600 bytes of 3-byte characters
	const f = fixture("w3-straddle.jsonl",
		`{"t":1,"cmd":["${pad}"]}\n{"_hb":{"first":0,"last":1}}\n`);
	const got = offsetOf(f.file, f.size, 512);
	assert("W3 multi-byte sequence across the chunk boundary", got === f.truth, `expected ${f.truth}, got ${got}`);
}

// W4 — no trailing newline. The last line is the unterminated one, and it starts
// after the last \n, not before it.
{
	const f = fixture("w4-no-trailing-nl.jsonl",
		`{"t":1,"cmd":["→"]}\n{"_hb":{"first":0,"last":1}}`);
	const got = offsetOf(f.file, f.size);
	assert("W4 no trailing newline: last line starts after the last \\n", got === f.truth, `expected ${f.truth}, got ${got}`);
}

// W5 — the degenerate ends. An empty file has no last line; a single
// unterminated line begins at 0. Both must answer 0 rather than -1 or throw,
// because the caller truncates to whatever comes back.
{
	const empty = fixture("w5-empty.jsonl", "");
	const one = fixture("w5-one-line.jsonl", `{"_hb":{"first":0,"last":1}}`);
	const oneNl = fixture("w5-one-line-nl.jsonl", `{"_hb":{"first":0,"last":1}}\n`);
	assert("W5a empty file → 0", offsetOf(empty.file, empty.size) === 0);
	assert("W5b single unterminated line → 0", offsetOf(one.file, one.size) === 0);
	assert("W5c single terminated line → 0", offsetOf(oneNl.file, oneNl.size) === 0);
}

// W6 — a classified line with a long `cmd` array runs past one chunk, which is
// the case the backward scan exists for. The scan must widen, not give up at 0.
{
	const long = JSON.stringify({ t: 1, cmd: Array.from({ length: 200 }, (_, i) => `cmd-${i} → arg`) });
	const f = fixture("w6-long-line.jsonl", `${long}\n{"_hb":{"first":0,"last":1}}\n`);
	const got = offsetOf(f.file, f.size, 512);
	assert("W6 line longer than one chunk: the scan widens", got === f.truth, `expected ${f.truth}, got ${got}`);
	assert("W6 and that offset is past the long line, not 0", got > 512);
}

// ---
// § E — THE CLOSER: the real daemon, over a transcript full of arrows and dashes
// ---
//
// W1-W6 pin the seam. They cannot catch a seam that is right in isolation and
// miswired at the call site, and the corpus damage came from the call site. So
// this drives the actual daemon binary against a session whose assistant text
// carries `→` and `—` — the exact characters behind 99.7% of the 2,562 welded
// lines — through enough 667ms beats to force several heartbeat upserts, and
// then reads every byte the daemon wrote.

const daemonPath = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const children: ChildProcess[] = [];

/** An assistant turn whose text and command carry multi-byte UTF-8. The `cmd`
 *  array is where the corpus got its arrows: tool descriptions and commit
 *  messages land there verbatim through serializeClassified. */
function multibyteTurn(id: string, tsMs: number): string {
	return JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: { input_tokens: 1500, output_tokens: 120 },
			content: [
				{ type: "text", text: `${id} — build → test → ship — done` },
				{ type: "tool_use", name: "Bash", id: `tu_${id}`, input: { command: `echo "a → b — c"` } },
			],
		},
	}) + "\n";
}

console.log("\n§ E — the Closer: every line the daemon writes parses as JSON\n");

{
	const eRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-e1-")));
	const sessionPath = path.join(eRoot, "session.jsonl");
	fs.writeFileSync(sessionPath, "");

	const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
		env: { ...process.env },
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(child);
	let daemonErr = "";
	child.stderr?.on("data", chunk => { daemonErr += String(chunk); });

	const tagPath = getCurrentVersionTagPath(sessionPath);
	const created = await pollUntil(() => fs.existsSync(tagPath), 8000);
	assert("E1 the daemon created a tag file", created, daemonErr);

	if (created) {
		// Interleave turns with idle gaps. A gap longer than one beat is what
		// makes the daemon upsert the heartbeat rather than append classified
		// data, which is the write under test; the turns in between put
		// multi-byte `cmd` content directly ahead of it.
		const t0 = Date.now();
		for (let i = 0; i < 4; i++) {
			fs.appendFileSync(sessionPath, multibyteTurn(`msg_130_${i}`, t0 + i * 1000));
			await sleep(1500);   // >= two 667ms beats
		}
		await pollUntil(
			() => readClassifiedTagFile(tagPath).some((row: any) => row.messageId === "msg_130_3"),
			8000,
		);

		const raw = fs.readFileSync(tagPath, "utf8");
		const lines = raw.split("\n").filter(l => l.trim().length > 0);
		const bad: string[] = [];
		for (const line of lines) {
			try { JSON.parse(line); } catch { bad.push(line); }
		}
		assert(
			`E1 every one of the ${lines.length} tag lines parses as JSON`,
			bad.length === 0,
			bad.slice(0, 4).join("\n"),
		);

		// A welded line is not merely unparseable — it is TWO records where one
		// should be. Pinning "no line carries two objects" catches a future weld
		// that happens to land somewhere JSON.parse tolerates.
		const welded = lines.filter(l => l.slice(1).includes('{"_hb"') || l.slice(1).includes('{"_meta"'));
		assert("E1 no line carries a second record welded onto it", welded.length === 0, welded.slice(0, 4).join("\n"));

		// The file must end on a newline: a reader woken by inotify after the
		// last write has to see a terminated line, not a fragment.
		assert("E1 the file ends on a line boundary", raw.length === 0 || raw.endsWith("\n"));

		// The truncate must actually have fired, or this suite would pass just as
		// well against a daemon that never cuts anything. Two properties pin it,
		// and neither is "few heartbeats": the upsert replaces the last line ONLY
		// when that line is itself a heartbeat, so one `_hb` per idle run is
		// correct and expected — a `_meta` marker between two runs legitimately
		// leaves both.
		//
		//  - No two CONSECUTIVE `_hb` lines. That pair is exactly what the cut
		//    prevents, and the only shape its absence would produce.
		//  - At least one heartbeat with `last > first`, which can only exist if
		//    an earlier heartbeat line was replaced in place of being appended.
		let consecutive = 0, updated = 0;
		let prevWasHb = false;
		for (const line of lines) {
			const isHb = line.includes('"_hb"');
			if (isHb && prevWasHb) consecutive++;
			if (isHb) {
				try {
					const hb = JSON.parse(line)._hb;
					if (hb && typeof hb === "object" && hb.last > hb.first) updated++;
				} catch { /* E1's parse assertion above owns this case */ }
			}
			prevWasHb = isHb;
		}
		assert("E1 no two consecutive heartbeat lines — the cut fired", consecutive === 0, lines.join("\n"));
		assert("E1 a heartbeat was updated in place, not only appended", updated > 0, lines.join("\n"));

		// And the money still landed. A "fix" that writes nothing also writes no
		// broken lines.
		const classified = readClassifiedTagFile(tagPath) as any[];
		assert(`E1 all 4 turns are still classified (${classified.length} rows)`, classified.length >= 4,
			JSON.stringify(classified.map(r => r.messageId)));
	}

	child.kill("SIGTERM");
}

// ---
// § R — a session line written in two halves is counted, not dropped
// ---

console.log("\n§ R — a partial trailing line is re-read, never skipped\n");

{
	const rRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-r1-")));
	const sessionPath = path.join(rRoot, "session.jsonl");
	fs.writeFileSync(sessionPath, "");

	const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
		env: { ...process.env },
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(child);

	const tagPath = getCurrentVersionTagPath(sessionPath);
	const created = await pollUntil(() => fs.existsSync(tagPath), 8000);
	assert("R1 the daemon created a tag file", created);

	if (created) {
		// Write the turn in two halves with several beats in between, so the
		// daemon provably polls while the line is incomplete. Before #130 the
		// offset advanced past the fragment on that poll and the completed line
		// was never re-read — the turn vanished with nothing counting it.
		const line = multibyteTurn("msg_130_split", Date.now());
		const cut = Math.floor(line.length / 2);
		fs.appendFileSync(sessionPath, line.slice(0, cut));
		await sleep(2500);                                  // >= three beats mid-line
		fs.appendFileSync(sessionPath, line.slice(cut));

		const landed = await pollUntil(
			() => (readClassifiedTagFile(tagPath) as any[]).some(row => row.messageId === "msg_130_split"),
			10000,
		);
		assert("R1 the split turn is counted once the line completes", landed,
			JSON.stringify((readClassifiedTagFile(tagPath) as any[]).map(r => r.messageId)));

		const rows = (readClassifiedTagFile(tagPath) as any[]).filter(r => r.messageId === "msg_130_split");
		assert(`R1 and counted exactly once (${rows.length})`, rows.length === 1);
	}

	child.kill("SIGTERM");
}

// ---
// § S — the invariant is structural, not a habit
// ---
//
// E1 proves the daemon that exists today writes whole lines. It cannot stop the
// NEXT writer from reintroducing the defect, and the defect survived months
// precisely because every reader tolerated it silently. These two checks read
// the source and fail on the shapes that caused #130.

console.log("\n§ S — no writer can reintroduce a partial line unnoticed\n");

{
	const daemonSrc = fs.readFileSync(path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.ts"), "utf8");

	// S1 — every tag append goes through the one helper that enforces the
	// trailing newline. A direct fs.appendFileSync onto the tag path bypasses it.
	const directAppends = daemonSrc.split("\n")
		.map((line, i) => ({ line, n: i + 1 }))
		.filter(({ line }) => /fs\.appendFileSync\(\s*tagPath/.test(line));
	assert("S1 no append reaches the tag file except through appendTagFile",
		directAppends.length === 0,
		directAppends.map(({ line, n }) => `${n}: ${line.trim()}`).join("\n"));

	// S2 — a truncate on a tag file cuts to a line boundary or to zero, and
	// nothing else. #130 was one ftruncateSync to an offset derived from a
	// decoded string; an offset that does not come from lastLineStartByte is
	// that bug wearing different arithmetic.
	//
	// Checked by NAME, not by proximity: the first version of this check looked
	// back six lines for the word `lastLineStartByte` and failed on the very fix
	// it exists to protect, because the offset is bound nine lines above its use.
	// Proximity is not the property — provenance is.
	const truncateOffsets: { n: number; expr: string; line: string }[] = [];
	daemonSrc.split("\n").forEach((line, i) => {
		const m = /f?truncateSync\(\s*[^,]+,\s*([^)]+)\)/.exec(line);
		if (m) truncateOffsets.push({ n: i + 1, expr: m[1].trim(), line: line.trim() });
	});
	assert("S2 the daemon still truncates tag files at all — the check has a subject",
		truncateOffsets.length > 0);
	const badTruncates = truncateOffsets.filter(({ expr }) => {
		if (expr === "0") return false;   // to zero: there is no line to break
		return !new RegExp(`\\b(const|let|var)\\s+${expr}\\s*=\\s*lastLineStartByte\\(`).test(daemonSrc);
	});
	assert("S2 every tag truncate cuts to zero or to a lastLineStartByte offset",
		badTruncates.length === 0,
		badTruncates.map(({ n, line }) => `${n}: ${line}`).join("\n"));
}

for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}\n`);
if (failed > 0) process.exit(1);
