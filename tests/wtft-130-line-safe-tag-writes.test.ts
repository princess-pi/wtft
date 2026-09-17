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
import { lastLineStartByte, getCurrentVersionTagPath, readClassifiedTagFile, parseSessionFile } from "../bin/wtft.mjs";
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
//
// THE LONG LINE MUST BE LAST, and the straddle is ASSERTED rather than assumed.
// The first version of this fixture put the dashes in the FIRST line and a short
// heartbeat after them, so the newline the scan is looking for sat inside the
// very first chunk read from EOF — the loop returned on iteration one and never
// touched a dash. Its boundary also happened to land character-aligned. It
// passed while exercising neither property (#130 review round 2). So the test
// now reads the byte at the boundary and demands it be a UTF-8 CONTINUATION
// byte (0b10xxxxxx), which is the direct evidence that a sequence is split —
// no arithmetic to re-derive and get wrong a second time.
{
	const CHUNK = 512;
	const f = fixture("w3-straddle.jsonl",
		`{"_hb":{"first":0,"last":1}}\n{"t":1,"cmd":["${"—".repeat(200)}"]}\n`);
	const buf = fs.readFileSync(f.file);
	const chunkStart = (f.size - 1) - CHUNK;   // scan skips the trailing \n, then reads CHUNK back
	assert("W3 the last line is longer than one chunk, so the scan must widen",
		f.size - f.truth > CHUNK, `last line is ${f.size - f.truth} bytes, chunk is ${CHUNK}`);
	assert("W3 the chunk boundary falls INSIDE a 3-byte sequence",
		(buf[chunkStart] & 0xc0) === 0x80,
		`byte at ${chunkStart} is 0x${buf[chunkStart].toString(16)} — not a continuation byte, so nothing is split`);
	const got = offsetOf(f.file, f.size, CHUNK);
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
//
// PURE ASCII on purpose, so this isolates WIDENING from the multi-byte handling
// W3 covers. And, as in W3, the long line has to be the LAST one: with a short
// heartbeat after it the terminating newline sits in the first chunk and the
// loop returns immediately. The old fixture had exactly that shape and asserted
// only `got > 512`, which was trivially true of an unwidened scan (#130 review
// round 2). The widening is now asserted directly: an answer below
// `size - CHUNK` cannot have come from a single chunk read backwards from EOF.
{
	const CHUNK = 512;
	const long = JSON.stringify({ t: 1, cmd: Array.from({ length: 200 }, (_, i) => `cmd-${i} arg`) });
	const f = fixture("w6-long-line.jsonl", `{"_hb":{"first":0,"last":1}}\n${long}\n`);
	const got = offsetOf(f.file, f.size, CHUNK);
	assert("W6 line longer than one chunk: the scan widens", got === f.truth, `expected ${f.truth}, got ${got}`);
	assert("W6 and the answer lies outside the first chunk — a single read could not have found it",
		got < f.size - CHUNK, `got ${got}, first chunk starts at ${f.size - CHUNK}`);
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
		//  - No two CONSECUTIVE `_hb` lines. That pair is exactly what the
		//    replacement prevents, and the only shape its absence would produce.
		let consecutive = 0;
		let prevWasHb = false;
		for (const line of lines) {
			const isHb = line.includes('"_hb"');
			if (isHb && prevWasHb) consecutive++;
			prevWasHb = isHb;
		}
		assert("E1 no two consecutive heartbeat lines — the replacement fired", consecutive === 0, lines.join("\n"));

		// E1b — THE REPLACEMENT IS IN PLACE, observed as it happens.
		//
		// This assertion used to be "some heartbeat has last > first", justified
		// as something only a replacement could produce. It was not: `initClassified`
		// writes `first == last`, the first clean poll appends a `_meta.swept`
		// marker after it, and `upsertHeartbeat` then finds a `_meta` last line and
		// APPENDS a fresh heartbeat which naturally has `last > first`. The
		// assertion passed whether or not a single byte was ever replaced (#130
		// review round 2).
		//
		// What actually distinguishes replacing from appending is that the file
		// DOES NOT GROW. So watch it directly across a quiet stretch, where the
		// daemon writes nothing but heartbeats: the timestamp must advance while
		// the size holds exactly still. That is also the property the offset
		// readers depend on — a heartbeat that changed the size is the bug this
		// round fixed — so pinning it here pins the thing that matters rather
		// than a side effect of it.
		const sizeOf = () => { try { return fs.statSync(tagPath).size; } catch { return -1; } };
		const lastHbOf = () => {
			try {
				const hbs = fs.readFileSync(tagPath, "utf8").split("\n")
					.filter(l => l.includes('"_hb"'));
				const hb = JSON.parse(hbs[hbs.length - 1])._hb;
				return hb && typeof hb === "object" ? hb.last : null;
			} catch { return null; }
		};
		let replacedInPlace = false, grewWhileQuiet = false;
		let prev = { size: sizeOf(), last: lastHbOf() };
		for (let i = 0; i < 12 && !replacedInPlace; i++) {
			await sleep(700);            // one 667ms beat
			const now = { size: sizeOf(), last: lastHbOf() };
			if (now.last !== null && prev.last !== null && now.last > prev.last) {
				if (now.size === prev.size) replacedInPlace = true;
				else grewWhileQuiet = true;
			}
			prev = now;
		}
		assert("E1b the heartbeat advanced without the file changing size — replaced in place, not appended",
			replacedInPlace,
			grewWhileQuiet
				? "the heartbeat advanced but the file GREW: it was appended, so an idle daemon still bloats the tag"
				: "no heartbeat advanced at all in ~8s of quiet — the beat is not running, so this proves nothing either way");

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

	// R2 — the split lands INSIDE a multi-byte sequence. R1 cuts at a UTF-16
	// index, so each half is valid UTF-8 on its own and the test passes even for
	// a reader that decodes before locating the newline. Cutting mid-sequence is
	// what pins the Buffer search: decode first and the trailing bytes become
	// U+FFFD, which never round-trips back to the original line.
	{
		const line = multibyteTurn("msg_130_bytesplit", Date.now());
		const bytes = Buffer.from(line, "utf8");
		// The first `→` in the text; cut one byte into its three.
		const arrow = bytes.indexOf(Buffer.from("→", "utf8"));
		assert("R2 the fixture actually contains a multi-byte sequence to split", arrow > 0);
		fs.appendFileSync(sessionPath, bytes.subarray(0, arrow + 1));
		await sleep(2500);
		fs.appendFileSync(sessionPath, bytes.subarray(arrow + 1));

		const landed = await pollUntil(
			() => (readClassifiedTagFile(tagPath) as any[]).some(row => row.messageId === "msg_130_bytesplit"),
			10000,
		);
		assert("R2 a turn split mid-UTF-8-sequence is counted once the line completes", landed);
		const rows = (readClassifiedTagFile(tagPath) as any[]).filter(r => r.messageId === "msg_130_bytesplit");
		assert(`R2b and counted exactly once (${rows.length})`, rows.length === 1);
	}

	// R3 — a record whose writer died before the newline. `parseSessionFile`
	// splits the whole file and counts that record, so a daemon that waited for a
	// newline forever would report a LOWER total than a rebuild of the same file
	// — the #156 drift. The fragment is taken once it has not grown for a beat
	// and parses as JSON.
	{
		const line = multibyteTurn("msg_130_no_newline", Date.now());
		fs.appendFileSync(sessionPath, line.slice(0, -1));   // everything but the \n
		const landed = await pollUntil(
			() => (readClassifiedTagFile(tagPath) as any[]).some(row => row.messageId === "msg_130_no_newline"),
			12000,
		);
		assert("R3 a complete record with no trailing newline is counted, as parseSessionFile counts it", landed,
			JSON.stringify((readClassifiedTagFile(tagPath) as any[]).map(r => r.messageId)));
		const rows = (readClassifiedTagFile(tagPath) as any[]).filter(r => r.messageId === "msg_130_no_newline");
		assert(`R3b and counted exactly once (${rows.length})`, rows.length === 1);
	}

	child.kill("SIGTERM");
}

// R4 — THE CLOSER'S SECOND HALF, which nothing enforced until now.
//
// #130's Closer says a session written one byte at a time must end up counting
// the same as the same session parsed whole. R1-R3 each split ONE line at one
// chosen point; none of them exercises the poll boundary landing at an arbitrary
// place, over and over, which is what the settled-fragment heuristic
// (`length unchanged for a beat` + `JSON.parse` succeeds) actually has to
// survive (#130 review round 2, Low/contract).
//
// So: dribble a whole multi-turn session in one-byte writes, faster than the
// beat, so polls land at unpredictable offsets — inside JSON strings, inside
// multi-byte sequences, between the two bytes of a `\r\n` that is not there.
// Then compare the daemon's classified rows against `parseSessionFile` over the
// finished file. Equal, or a turn was lost or double-counted.
{
	const r4Root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-r4-")));
	const sessionPath = path.join(r4Root, "session.jsonl");
	fs.writeFileSync(sessionPath, "");

	const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
		env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(child);

	const tagPath = getCurrentVersionTagPath(sessionPath);
	const started = await pollUntil(() => fs.existsSync(tagPath), 15000);
	assert("R4 the daemon created a tag file", started);

	if (started) {
		const t0 = Date.now();
		const payload = Buffer.from(
			[0, 1, 2, 3, 4].map(i => multibyteTurn(`msg_r4_${i}`, t0 + i * 1000)).join(""),
			"utf8",
		);
		// One byte per write. Several hundred writes across several beats, so the
		// daemon's polls cut the stream at offsets nobody chose.
		const fd = fs.openSync(sessionPath, "a");
		try {
			for (let i = 0; i < payload.length; i++) {
				fs.writeSync(fd, payload, i, 1);
				if (i % 64 === 0) await sleep(1);
			}
		} finally { fs.closeSync(fd); }

		const want = (parseSessionFile(sessionPath) as any[]).map(r => r.messageId).filter(Boolean).sort();
		const settled = await pollUntil(() => {
			const got = (readClassifiedTagFile(tagPath) as any[]).map(r => r.messageId).filter(Boolean).sort();
			return got.length === want.length && got.every((id, i) => id === want[i]);
		}, 20000);

		const got = (readClassifiedTagFile(tagPath) as any[]).map(r => r.messageId).filter(Boolean).sort();
		assert(`R4 byte-at-a-time gives the same ${want.length} turns as a whole-file parse`,
			settled, `whole-file: ${JSON.stringify(want)}\ndaemon:     ${JSON.stringify(got)}`);
		assert("R4 and counts each of them exactly once",
			new Set(got).size === got.length, JSON.stringify(got));
	}

	child.kill("SIGTERM");
}

// ---
// § C — a daemon killed mid-append does not weld the next daemon's heartbeat on
// ---
//
// THE SECOND ROUTE TO THE SAME CORPUS DAMAGE (#130 review round 2, Medium/crossfile).
// `appendTagFile` makes every COMPLETED write leave whole lines. It says nothing
// about a write that never completed. A daemon killed inside `fs.appendFileSync`
// — SIGKILL, the OOM killer, power loss — never reaches the #512 handler that
// would set the `rebuild` lease token, so it leaves a numeric PID lease the next
// daemon reaps as merely stale, and a tag file ending mid-line. That daemon then
// resumed incrementally and appended its start heartbeat straight onto the
// fragment: one unparseable line carrying two records, which is exactly the shape
// this issue was opened about, arriving by a route the arithmetic fix does not
// touch.
//
// The fragment here is made by truncating a real tag file mid-line, which is
// byte-for-byte what a killed append leaves behind.

console.log("\n§ C — a crash mid-append is repaired, not built upon\n");

{
	const cRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-c1-")));
	const sessionPath = path.join(cRoot, "session.jsonl");
	fs.writeFileSync(sessionPath, "");

	const first = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
		env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(first);

	const tagPath = getCurrentVersionTagPath(sessionPath);
	const started = await pollUntil(() => fs.existsSync(tagPath), 15000);
	assert("C1 the first daemon created a tag file", started);

	if (started) {
		// Two real turns, so the tag carries classified data and a `_meta` marker
		// — the branch that resumes incrementally rather than rebuilding.
		const t0 = Date.now();
		for (let i = 0; i < 2; i++) {
			fs.appendFileSync(sessionPath, multibyteTurn(`msg_c1_${i}`, t0 + i * 1000));
			await sleep(1500);
		}
		await pollUntil(
			() => readClassifiedTagFile(tagPath).some((row: any) => row.messageId === "msg_c1_1"),
			10000,
		);

		// SIGKILL: no handler runs, no `rebuild` token is written, the lease is
		// left holding a plain PID. This is the crash, not a simulation of one.
		first.kill("SIGKILL");
		await sleep(500);

		// And the half-written append it was inside. Cut the file mid-line.
		const before = fs.readFileSync(tagPath, "utf8");
		const lastNl = Buffer.from(before, "utf8").lastIndexOf(0x0a);
		const fragment = '{"t":1,"cmd":["a \u2192 b \u2014 c"],"cost';   // no closing brace, no newline
		fs.writeFileSync(tagPath, before.slice(0, lastNl + 1) + fragment);
		assert("C1 the fixture really does end mid-line",
			!fs.readFileSync(tagPath, "utf8").endsWith("\n"));

		// A second daemon takes over the same session.
		const second = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
			env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"],
		});
		children.push(second);
		await pollUntil(() => {
			try { return fs.readFileSync(tagPath, "utf8").endsWith("\n"); } catch { return false; }
		}, 15000);

		const raw = fs.readFileSync(tagPath, "utf8");
		const lines = raw.split("\n").filter(l => l.trim().length > 0);
		const bad = lines.filter(l => { try { JSON.parse(l); return false; } catch { return true; } });
		assert(`C1 every one of the ${lines.length} lines still parses after the takeover`,
			bad.length === 0, bad.slice(0, 4).join("\n"));

		// The specific damage: the new daemon's start heartbeat fused to the
		// fragment. A weld is not merely unparseable — it is two records in one
		// line, and it is what 2,562 lines on this host looked like.
		const welded = lines.filter(l => l.slice(1).includes('{"_hb"') || l.slice(1).includes('{"_meta"'));
		assert("C1 no heartbeat was welded onto the fragment", welded.length === 0,
			welded.slice(0, 4).join("\n"));

		// The fragment is gone, not completed. Nobody knows how much of it
		// reached the disk, so it is not a record and must not be treated as one.
		assert("C1 the fragment was discarded", !raw.includes('"cost'), raw);
		assert("C1 the file ends on a line boundary again", raw.endsWith("\n"));

		// And the repair did not cost the money. The two classified turns predate
		// the fragment and must survive it.
		const classified = readClassifiedTagFile(tagPath) as any[];
		assert(`C1 both earlier turns survived the repair (${classified.length} rows)`,
			classified.length >= 2, JSON.stringify(classified.map(r => r.messageId)));

		second.kill("SIGTERM");
	}
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

	// S3 — the heartbeat upsert holds ONE descriptor and never truncates.
	//
	// The shape this forbids is truncate-then-append across two descriptors: cut
	// the stale heartbeat on an `r+` fd, close it, reopen through
	// `appendTagFile`. It left whole lines at every instant, so E1 could not see
	// it — but the file briefly got SHORTER, and an offset-tracking reader only
	// ever asks whether the file GREW (#130 review round 2, Medium/contract).
	//
	// The replacement is a same-width `writeSync` at a `lastLineStartByte`
	// offset, which changes no byte count at all. Pinned structurally because
	// nothing observable at 667ms resolution can tell the two apart: with 13-digit
	// millisecond timestamps both heartbeats are the same width, so the old shape
	// was size-neutral end to end and the window it opened was too short to poll.
	// A behavioural test here would have been theatre.
	const upsertBody = /function upsertHeartbeat\([\s\S]*?\n}/.exec(daemonSrc)?.[0] ?? "";
	assert("S3 upsertHeartbeat was found in the source — the check has a subject", upsertBody.length > 0);
	assert("S3 the heartbeat upsert never truncates",
		!/truncateSync/.test(upsertBody),
		upsertBody);
	assert("S3 it replaces the line in place, at a lastLineStartByte offset",
		/fs\.writeSync\(\s*fd\s*,/.test(upsertBody) && /lastLineStartByte\(/.test(upsertBody),
		upsertBody);
}

for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}\n`);
if (failed > 0) process.exit(1);
