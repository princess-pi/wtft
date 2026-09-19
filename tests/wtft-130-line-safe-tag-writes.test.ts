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
 *   `lastLineStartByte` is the number that must be a byte offset and must land
 *   on a line boundary. Exporting it lets W1-W6 pin it directly.
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
import { lastLineStartByte, seedClassifiedTagFile, getCurrentVersionTagPath, readClassifiedTagFile, parseSessionFile, readPrefixSentinel, sentinelMatches, watcherAction, PREFIX_SENTINEL_BYTES } from "../bin/wtft.mjs";
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

// B0 — THE BUNDLE UNDER TEST MUST BE NEWER THAN THE SOURCE BEING SOURCE-CHECKED.
//
// This suite has two halves that can disagree without anything noticing
// (#130 local audit round). §E/R/C spawn `bin/wtft-daemon.mjs` and §W imports
// `bin/wtft.mjs` — gitignored BUILD OUTPUT. §S and P0 read `bin/wtft-daemon.ts`
// and `extensions/lib/wtft-daemon-lib.ts` — SOURCE. Nothing compares them, and
// `tests/run.ts` does not build; suites run sorted, so this one runs before the
// only suite that does.
//
// Edit the daemon, run `bun run test` without building, and the behavioural half
// green-lights the OLD daemon while the structural half certifies the NEW source.
// That is exactly the round-1 RED procedure — revert the .ts, rebuild — happening
// by accident, and it is the "fixture stops testing its subject" failure at the
// largest scale available here.
{
	const pairs: [string, string][] = [
		["bin/wtft-daemon.mjs", "bin/wtft-daemon.ts"],
		["bin/wtft.mjs", "bin/wtft.ts"],
		["bin/wtft.mjs", "extensions/lib/wtft-daemon-lib.ts"],
	];
	for (const [out, src] of pairs) {
		const outPath = path.resolve(import.meta.dirname, "..", out);
		const srcPath = path.resolve(import.meta.dirname, "..", src);
		let ok = false, detail = "";
		try {
			const o = fs.statSync(outPath).mtimeMs, i = fs.statSync(srcPath).mtimeMs;
			ok = o >= i;
			detail = `${out} is ${Math.round((i - o) / 1000)}s older than ${src} — run \`bun run build\``;
		} catch (err) {
			detail = `${out} or ${src} is missing (${(err as Error).message}) — run \`bun run build\``;
		}
		assert(`B0 ${out} is at least as new as ${src}`, ok, detail);
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
// passed while exercising neither property. So the test
// now reads the byte at the boundary and demands it be a UTF-8 CONTINUATION
// byte (0b10xxxxxx), which is the direct evidence that a sequence is split —
// no arithmetic to re-derive and get wrong a second time.
{
	const CHUNK = 512;
	// BOTH lines carry the dashes. That is the correction, and it is the whole
	// point of the fixture (#130 local audit round).
	//
	// The previous version put a short heartbeat FIRST and one long dash line
	// last. Its two preconditions were genuinely true — last line over a chunk,
	// boundary byte mid-sequence — and its answer was still insensitive to both,
	// because the newline that resolves the scan sits in the chunk starting at
	// byte 0 and everything BEFORE that newline is ASCII. All the multi-byte
	// content was AFTER the last newline, where it cannot move the arithmetic. A
	// decode-per-chunk scan returned the right answer anyway. Measured: truth 29,
	// broken scan 29.
	//
	// With dashes in the PRECEDING line, the decoded string index and the byte
	// index diverge before the newline, and the broken scan returns 351 against a
	// truth of 619.
	const line = `{"t":1,"cmd":["${"—".repeat(200)}"]}`;
	const f = fixture("w3-straddle.jsonl", `${line}\n${line}\n`);
	const buf = fs.readFileSync(f.file);
	const chunkStart = (f.size - 1) - CHUNK;   // scan skips the trailing \n, then reads CHUNK back
	assert("W3 the last line is longer than one chunk, so the scan must widen",
		f.size - f.truth > CHUNK, `last line is ${f.size - f.truth} bytes, chunk is ${CHUNK}`);
	assert("W3 the chunk boundary falls INSIDE a 3-byte sequence",
		(buf[chunkStart] & 0xc0) === 0x80,
		`byte at ${chunkStart} is 0x${buf[chunkStart].toString(16)} — not a continuation byte, so nothing is split`);
	// The precondition that was missing: multi-byte content BEFORE the newline the
	// scan must find. Without this, a string-index scan agrees with a byte-index
	// one and the assertion below cannot fail.
	assert("W3 there is multi-byte content ahead of the resolving newline — the byte and string indices must differ",
		Buffer.byteLength(buf.subarray(0, f.truth).toString("utf8"), "utf8") > buf.subarray(0, f.truth).toString("utf8").length,
		"everything before the last newline is ASCII, so a decoded-string scan gives the same answer");
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
// because a caller writes or truncates at whatever comes back.
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
// loop returns immediately. The widening is asserted directly: an answer below
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

// W7 — `seedClassifiedTagFile` takes its offset from the bytes it PARSED.
//
// The shape it replaces was `readClassifiedTagFile(p)` then
// `lastReadOffset = fs.statSync(p).size`, at three call sites. A whole-file read
// landing inside a multi-write() append returns a fragment, which the parse
// drops and the stat COUNTS — so the offset lands inside a line that completes a
// moment later and is then never re-read.
{
	const complete = `{"_hb":{"first":0,"last":1}}\n{"_meta":{"swept":1788828490280}}\n`;
	const f1 = fixture("w7-whole.jsonl", complete);
	assert("W7 a file of whole lines seeds at its full size",
		seedClassifiedTagFile(f1.file).offset === f1.size);

	// The same file caught mid-append: complete lines plus a fragment.
	const f2 = fixture("w7-fragment.jsonl", complete + `{"t":1,"cmd":["a \u2192 b`);
	const seeded = seedClassifiedTagFile(f2.file);
	assert("W7 a trailing fragment is NOT counted into the offset",
		seeded.offset === complete.length,
		`expected ${complete.length}, got ${seeded.offset} — the fragment's bytes were consumed without being parsed`);
	assert("W7 so the fragment's line is still waiting to be read",
		seeded.offset < f2.size);

	assert("W7 a missing file seeds empty, at zero, without throwing",
		seedClassifiedTagFile(path.join(root, "w7-absent.jsonl")).offset === 0);

	// W7b — ABSENT AND UNREADABLE ARE DIFFERENT. A seed that cannot read the file
	// must say so, because the watcher's recovery path uses that answer to decide
	// whether to replace a correct chart with an empty one. `read: false` means
	// "no information", which is not the claim "there is nothing".
	assert("W7b a successful read reports read: true", seedClassifiedTagFile(f1.file).read === true);
	assert("W7b an absent file reports read: false — not an empty session",
		seedClassifiedTagFile(path.join(root, "w7-absent.jsonl")).read === false);
	{
		const noPerm = fixture("w7-unreadable.jsonl", complete);
		let chmodded = false;
		try { fs.chmodSync(noPerm.file, 0o000); chmodded = true; } catch { /* root, or a filesystem that ignores it */ }
		if (chmodded && (() => { try { fs.readFileSync(noPerm.file); return false; } catch { return true; } })()) {
			assert("W7b an unreadable file reports read: false, with no throw",
				seedClassifiedTagFile(noPerm.file).read === false);
		} else {
			console.log("  SKIPPED W7b unreadable case — this process can read a 000 file (running as root?)");
		}
		try { fs.chmodSync(noPerm.file, 0o644); } catch { /* best effort */ }
	}
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

/** The daemon's beat. It is a private const in `bin/wtft-daemon.ts`, not part of
 *  the bundle's public surface, and R4 needs it to pace a dribble across several
 *  polls. Copied rather than exported — widening the public API for one test is
 *  the wrong trade — and PINNED below, so a change to the daemon's beat fails
 *  this suite by name instead of quietly shortening R4 until it stops crossing a
 *  poll boundary at all, which is precisely how R4 was toothless to begin with. */
const POLL_MS = 667;
{
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.ts"), "utf8");
	const m = /const POLL_MS = (\d+);/.exec(src);
	assert(`P0 the daemon's POLL_MS is still ${POLL_MS} — R4's pacing depends on it`,
		m !== null && Number(m[1]) === POLL_MS,
		m ? `daemon says ${m[1]}, this suite assumes ${POLL_MS}` : "no `const POLL_MS = <n>;` found in bin/wtft-daemon.ts");
}
const children: ChildProcess[] = [];

/** An assistant turn whose text and command carry multi-byte UTF-8. The `cmd`
 *  array is where the corpus got its arrows: tool descriptions and commit
 *  messages land there verbatim through serializeClassified. */
/** A turn the harness wrote without a message id.
 *
 *  These exist, they are classified, and `dedupeClassifiedById` passes them
 *  STRAIGHT THROUGH (`wtft-daemon-lib.ts`, the `if (!id)` arm) — which is the
 *  entire reason a crashed tag is rebuilt rather than resumed. With ids, a
 *  replayed batch collapses and no test can see the replay; without them it
 *  doubles the money, which is what C1b measures. */
function idlessTurn(tsMs: number): string {
	return JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: { input_tokens: 1500, output_tokens: 120 },
			content: [{ type: "text", text: "no id — build → test → ship — done" }],
		},
	}) + "\n";
}

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

		// The replacement must actually have fired, or this suite would pass just
		// as well against a daemon that never touches the last line. Two properties pin it,
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
		// What distinguishes replacing from appending is that the file DOES NOT
		// GROW. Watch it across a quiet stretch where the daemon writes nothing
		// but heartbeats: the timestamp must advance while the size holds
		// exactly still.
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
// survive.
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
		// One byte per write, PACED SO THAT POLLS LAND INSIDE IT.
		//
		// The first version slept 1ms every 64 bytes, which ran the whole ~2 KB
		// dribble in tens of milliseconds — comfortably inside a single 667ms
		// beat. The daemon then read the finished file in one poll and never saw
		// a mid-line cut, so the test passed against the pre-fix reader too and
		// proved nothing.
		//
		// The dribble now spans at least four beats by construction, so several
		// polls are guaranteed to land at offsets nobody chose — inside JSON
		// strings, inside multi-byte sequences, between a key and its value.
		const BEATS = 4;
		const perByteMs = Math.max(1, Math.ceil((POLL_MS * BEATS) / payload.length));
		const fd = fs.openSync(sessionPath, "a");
		const dribbleStart = Date.now();
		try {
			for (let i = 0; i < payload.length; i++) {
				fs.writeSync(fd, payload, i, 1);
				await sleep(perByteMs);
			}
		} finally { fs.closeSync(fd); }
		const dribbleMs = Date.now() - dribbleStart;
		assert(`R4 the dribble spanned at least ${BEATS} poll intervals (${dribbleMs}ms over ${payload.length} one-byte writes)`,
			dribbleMs >= POLL_MS * BEATS,
			`${dribbleMs}ms is under ${POLL_MS * BEATS}ms — polls may never have cut the stream, so this test proves nothing`);

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

		// Ids alone would pass while every cost came out wrong. Compare the money
		// the two paths arrive at.
		// `cost`, not `costUsd`. The first spelling of this summed `undefined ?? 0`
		// on BOTH sides and reported a confident $0.000000 == $0.000000 — a
		// comparison that could not fail, in the same round that removed two other
		// assertions for exactly that.
		const sum = (rows: any[]) => rows.reduce((a, r) => a + (r.cost ?? 0), 0);
		const wantCost = sum(parseSessionFile(sessionPath) as any[]);
		const gotCost = sum(readClassifiedTagFile(tagPath) as any[]);
		assert("R4 the fixture actually costs something — otherwise the comparison below is vacuous",
			wantCost > 0, `whole-file parse totals $${wantCost}`);
		assert(`R4 and the daemon arrives at the same total ($${wantCost.toFixed(6)})`,
			Math.abs(wantCost - gotCost) < 1e-9,
			`whole-file $${wantCost.toFixed(6)} vs daemon $${gotCost.toFixed(6)}`);
	}

	child.kill("SIGTERM");
}

// ---
// § C — a daemon killed mid-append does not weld the next daemon's heartbeat on
// ---
//
// THE SECOND ROUTE TO THE SAME CORPUS DAMAGE.
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
		// Two identified turns, then one WITHOUT a message id — and the id-less one
		// is what makes this test able to fail. Each turn gets its own poll, so the
		// tag ends up carrying several `_meta.offset` markers, which is the branch
		// that resumes incrementally rather than rebuilding.
		const t0 = Date.now();
		for (let i = 0; i < 2; i++) {
			fs.appendFileSync(sessionPath, multibyteTurn(`msg_c1_${i}`, t0 + i * 1000));
			await sleep(1500);
		}
		fs.appendFileSync(sessionPath, idlessTurn(t0 + 2000));
		await sleep(1500);
		await pollUntil(
			() => (readClassifiedTagFile(tagPath) as any[]).length >= 3,
			10000,
		);

		// SIGKILL: no handler runs, no `rebuild` token is written, the lease is
		// left holding a plain PID. This is the crash, not a simulation of one.
		first.kill("SIGKILL");
		await sleep(500);

		// And the half-written append it was inside.
		//
		// ENTIRELY IN BYTES. The first version of this fixture did
		// `Buffer.from(before).lastIndexOf(0x0a)` and then `before.slice(0, n)` on
		// the STRING — a byte offset used as a UTF-16 index, which is #130's own
		// defect, reproduced inside the test that guards against it. Because every
		// `cmd` here carries `→` and `—`, the byte index always EXCEEDED the string
		// length, so `slice` returned the whole string and the "cut" removed zero
		// characters. The fixture asserted it ended mid-line and it did — on the
		// appended fragment alone, having destroyed nothing.
		//
		// AND IT CUTS THE `_meta.offset` LINE SPECIFICALLY, because that is the one
		// a crash can actually destroy: `flushPending` appends the classified batch
		// and THEN the offset marker, so a writer killed inside the second append
		// leaves the batch complete and the offset line half-written. Cutting a
		// trailing heartbeat instead — which is what the old fixture did when it
		// worked at all — leaves every offset intact, and a daemon that merely cut
		// the fragment and resumed would produce byte-identical output. The test
		// would then pass against the very behaviour round 3 replaced.
		const before = fs.readFileSync(tagPath);
		const lineStarts: number[] = [0];
		for (let i = 0; i < before.length - 1; i++) if (before[i] === 0x0a) lineStarts.push(i + 1);
		let offsetLineStart = -1;
		for (const start of lineStarts) {
			const nl = before.indexOf(0x0a, start);
			const line = before.subarray(start, nl === -1 ? before.length : nl).toString("utf8");
			if (line.includes('"_meta"') && line.includes('"offset"')) offsetLineStart = start;
		}
		assert("C1 the fixture found a `_meta.offset` marker to destroy", offsetLineStart >= 0,
			before.toString("utf8"));
		const priorOffsets = lineStarts.filter(st => st < offsetLineStart).map(st => {
			const nl = before.indexOf(0x0a, st);
			return before.subarray(st, nl === -1 ? before.length : nl).toString("utf8");
		}).filter(l => l.includes('"offset"'));
		assert(`C1 and an EARLIER offset survives for a cut-only daemon to resume from (${priorOffsets.length})`,
			priorOffsets.length > 0,
			"without one, a resume and a rebuild both start from zero and C1b cannot tell them apart");

		fs.writeFileSync(tagPath, Buffer.concat([
			before.subarray(0, offsetLineStart),
			Buffer.from('{"_meta":{"offs', "utf8"),   // killed mid-append: no close, no newline
		]));
		const afterCut = fs.readFileSync(tagPath);
		assert("C1 the fixture really does end mid-line",
			afterCut.length > 0 && afterCut[afterCut.length - 1] !== 0x0a);
		assert(`C1 and it is SHORTER than what it cut from (${afterCut.length} < ${before.length})`,
			afterCut.length < before.length,
			"the cut removed nothing — a byte index was used as a string index");

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
		assert(`C1 the earlier turns survived the repair (${classified.length} rows)`,
			classified.length >= 3, JSON.stringify(classified.map(r => r.messageId)));

		// C1b — AND NEITHER IS COUNTED TWICE. This is why a cut tail escalates to
		// a rebuild rather than merely being cut. `flushPending` appends the batch
		// and THEN `_meta.offset`; a daemon killed inside that second append
		// leaves the batch on disk with the offset line as the fragment, so a
		// resume re-classifies turns already in the file. `dedupeClassifiedById`
		// does NOT save us — it passes an interaction with no `messageId` straight
		// through — so an id-less turn would be billed twice, permanently
		//
		// Exact equality, not `>=`: a double count is the failure, and `>=` is
		// how it would go unnoticed.
		// The id-less turn is the one that can double. With ids, a replayed batch
		// collapses in `dedupeClassifiedById` and a resume is indistinguishable
		// from a rebuild; without one, a resume from the surviving earlier offset
		// re-classifies it and its money lands twice.
		const want = (parseSessionFile(sessionPath) as any[]);
		const idless = classified.filter(r => !r.messageId);
		assert(`C1b the id-less turn appears exactly ONCE — a resume would replay it (${idless.length})`,
			idless.length === 1,
			JSON.stringify(classified.map(r => r.messageId ?? "<no id>")));
		assert(`C1b the rebuilt tag holds exactly what the transcript holds (${classified.length} vs ${want.length})`,
			classified.length === want.length,
			`daemon ${JSON.stringify(classified.map(r => r.messageId))}\nwhole-file ${JSON.stringify(want.map(r => r.messageId))}`);
		const cost = (rows: any[]) => rows.reduce((a, r) => a + (r.cost ?? 0), 0);
		assert(`C1b and the same money ($${cost(want).toFixed(6)})`,
			Math.abs(cost(want) - cost(classified)) < 1e-9,
			`whole-file $${cost(want).toFixed(6)} vs daemon $${cost(classified).toFixed(6)}`);

		second.kill("SIGTERM");
	}
}

// ---
// § S — the invariant is structural, not a habit
// ---
//
// E1 proves the daemon that exists today writes whole lines. It cannot stop the
// NEXT writer from reintroducing the defect, and the defect survived months
// precisely because every reader tolerated it silently. These four checks read
// the source and fail on the shapes that caused #130 — S1 an append that bypasses
// the one guarded helper, S2 a truncate to an offset of unknown provenance, S3 a
// heartbeat that goes back to cut-and-append, S4 a watcher that only notices the
// file growing.

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
	// Checked by NAME WITHIN THE ENCLOSING FUNCTION, which is as close to
	// provenance as a source check gets. Three versions of this, each fixing the
	// last:
	//
	//  1. proximity — look back six lines for `lastLineStartByte`. Failed on the
	//     very fix it protects, because the binding sat nine lines above its use.
	//  2. a FILE-GLOBAL name match. That is not provenance at all: any
	//     `const lineStart = lastLineStartByte(...)` anywhere in the file
	//     satisfied every truncate whose argument happened to be called
	// `lineStart`, in any other function.
	//  3. this — the binding must appear in the SAME function body as the
	//     truncate that uses it.
	//
	// Still a source check and still fallible: it cannot see a variable
	// reassigned between binding and use. It is aimed at the shape that actually
	// caused #130 — an offset computed some other way and handed to ftruncate —
	// not at an adversary.
	// Split the source into function bodies so a binding can be required in the
	// SAME one as its use, rather than anywhere in the file.
	// Split on a column-0 `function`/`async function`, and account for lines
	// EXACTLY — the first version advanced by `lines - 1` while testing against
	// `seen + lines`, drifting one line earlier per boundary (#130 local audit
	// round). Today's only non-zero truncate is early enough that the drift did
	// not reach it, which is precisely why it would have gone unnoticed until
	// someone added a truncate further down.
	const srcLines = daemonSrc.split("\n");
	const fnStarts: number[] = [];
	srcLines.forEach((l, i) => { if (/^(async )?function /.test(l)) fnStarts.push(i + 1); });
	const bodyOf = (lineNo: number): string => {
		let start = -1, end = srcLines.length + 1;
		for (let i = 0; i < fnStarts.length; i++) {
			if (fnStarts[i] <= lineNo) { start = fnStarts[i]; end = fnStarts[i + 1] ?? srcLines.length + 1; }
		}
		if (start === -1) return daemonSrc;
		return srcLines.slice(start - 1, end - 1).join("\n");
	};
	const truncateOffsets: { n: number; expr: string; line: string }[] = [];
	daemonSrc.split("\n").forEach((line, i) => {
		const m = /f?truncateSync\(\s*[^,]+,\s*([^)]+)\)/.exec(line);
		if (m) truncateOffsets.push({ n: i + 1, expr: m[1].trim(), line: line.trim() });
	});
	assert("S2 the daemon still truncates tag files at all — the check has a subject",
		truncateOffsets.length > 0);
	// An `expr` that is not a bare identifier is REJECTED rather than interpolated.
	// `fs.ftruncateSync(fd, lastLineStartByte(fd, size))` is a legitimate
	// refactor, and the capture at the top stops at the first `)`, so `expr`
	// would be `lastLineStartByte(fd, size` — an unbalanced paren that makes
	// `new RegExp` throw a SyntaxError and takes the whole suite down instead of
	// failing one assertion (#130 local audit round).
	const badTruncates = truncateOffsets.filter(({ expr, n }) => {
		if (expr === "0") return false;   // to zero: there is no line to break
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr)) return true;   // not a name we can trace — treat as unproven
		return !new RegExp(`\\b(const|let|var)\\s+${expr}\\s*=\\s*lastLineStartByte\\(`).test(bodyOf(n));
	});
	assert("S2 every tag truncate cuts to zero or to a lastLineStartByte offset",
		badTruncates.length === 0,
		badTruncates.map(({ n, line }) => `${n}: ${line}`).join("\n"));

	// S2 SELF-CHECK. `bodyOf` falls back to the whole file when it cannot place a
	// line, and that fallback is indistinguishable from working: every assertion
	// above would still pass while the scoping did nothing — which is exactly the
	// file-global match round 3 objected to, wearing a new coat. So prove the
	// narrowing is real, both ways.
	const nonZero = truncateOffsets.find(({ expr }) => expr !== "0");
	assert("S2 self-check: there is a non-zero truncate to scope", nonZero !== undefined);
	if (nonZero) {
		const body = bodyOf(nonZero.n);
		assert("S2 self-check: bodyOf returns ONE function, not the whole file",
			body.length < daemonSrc.length && /^function /.test(body.trim()),
			`body is ${body.length} chars of a ${daemonSrc.length}-char file`);
		// The narrowing proved by CONTENT, not by a regex that matches nowhere.
		// The first spelling of this asked whether `pendingFragmentSize` was bound
		// from `lastLineStartByte` in the body — and `pendingFragmentSize` is bound
		// once, as `let pendingFragmentSize = 0`, from nothing. The regex matched
		// nowhere in the entire 104k-char file, so the assertion was true of the
		// whole source and would have passed unchanged had `bodyOf` returned it
		// (#130 local audit round). A check that cannot fail does not prove a
		// narrowing.
		assert("S2 self-check: the body contains the truncate it was looked up for",
			body.includes(nonZero.line.slice(0, 40)),
			`bodyOf(${nonZero.n}) does not contain its own truncate line`);
		assert("S2 self-check: and does NOT contain other functions that also bind from lastLineStartByte",
			!body.includes("function upsertHeartbeat"),
			"bodyOf returned more than one function, so a binding anywhere in that span would satisfy the check");
	}

	// S3 — the heartbeat upsert holds ONE descriptor and never truncates.
	//
	// The shape this forbids is truncate-then-append across two descriptors: cut
	// the stale heartbeat on an `r+` fd, close it, reopen through
	// `appendTagFile`. It left whole lines at every instant, so E1 could not see
	// it — but the file briefly got SHORTER, and an offset-tracking reader only
	// ever asks whether the file GREW.
	//
	// The replacement is a same-width `writeSync` at a `lastLineStartByte`
	// offset, which changes no byte count at all. Pinned structurally because
	// nothing observable at 667ms resolution can tell the two apart: with 13-digit
	// millisecond timestamps both heartbeats are the same width, so the old shape
	// was size-neutral end to end and the window it opened was too short to poll.
	// A behavioural test here would have been theatre.
	// S4 — the watcher re-seeds when the file SHRINKS.
	//
	// The callback only ever asked whether the file grew. The daemon truncates
	// the tag to zero in three places, and a `--watch` reader stays attached
	// across a daemon restart — so its offset is left past the new EOF, and
	// nothing recovers until the rebuilt file grows past it, at which point the
	// reader starts mid-line and every rebuilt line before that offset is lost
	//
	// Structural, for the same reason as S3: driving it would mean standing up
	// the interactive watch TUI and racing a daemon restart against it. The
	// branch either exists or it does not, and its absence is the whole bug.
	{
		const libSrc = fs.readFileSync(path.resolve(import.meta.dirname, "..", "extensions", "lib", "wtft-daemon-lib.ts"), "utf8");
		// REWRITTEN (#142). This pair used to be two regexes over the library
		// source, requiring `stat.size < lastReadOffset` to sit within 1600
		// characters of `seedClassifiedTagFile(`. Both were pinned to the SHAPE
		// of the code rather than to what it does, and the first one passed by
		// matching a COMMENT — the docstring above `seedClassifiedTagFile`
		// quotes the branch by name. The #142 fix moved the comparison into
		// `watcherAction`, the regex stopped matching, and the test failed
		// against code that was strictly more correct.
		//
		// The stated excuse was that driving it "would mean standing up the
		// interactive watch TUI and racing a daemon restart". That is no longer
		// true: `watcherAction` is pure, so the decision can be asserted
		// directly. G1 is the full table; these two keep S4's own claim.
		assert("S4 the watcher re-seeds when the file shrinks below the offset",
			watcherAction(10, 50, true) === "reseed");
		// Its own fixture: a file that has SHRUNK under a reader whose offset is
		// now past EOF. The re-seed must land the offset at the new EOF — the
		// "guessing" S4 is named for was leaving it where it was.
		const shrinkDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-S4-")));
		const shrinkFile = path.join(shrinkDir, "s.wtft-tag.v3.jsonl");
		fs.writeFileSync(shrinkFile, JSON.stringify({ id: "a" }) + "\n" + JSON.stringify({ id: "b" }) + "\n");
		const staleOffset = fs.statSync(shrinkFile).size;
		fs.writeFileSync(shrinkFile, JSON.stringify({ id: "a" }) + "\n");       // shrank
		const shrunkSize = fs.statSync(shrinkFile).size;
		assert("S4 fixture precondition: the file is now SHORTER than the reader's offset",
			shrunkSize < staleOffset, `size=${shrunkSize} offset=${staleOffset}`);
		const reseed = seedClassifiedTagFile(shrinkFile);
		assert("S4 and it re-seeds from the file rather than guessing an offset",
			reseed.read === true && reseed.offset === shrunkSize, `read=${reseed.read} offset=${reseed.offset} size=${shrunkSize}`);
	}

	const upsertBody = /function upsertHeartbeat\([\s\S]*?\n}/.exec(daemonSrc)?.[0] ?? "";
	assert("S3 upsertHeartbeat was found in the source — the check has a subject", upsertBody.length > 0);
	assert("S3 the heartbeat upsert never truncates",
		!/truncateSync/.test(upsertBody),
		upsertBody);
	assert("S3 it replaces the line in place, at a lastLineStartByte offset",
		/fs\.writeSync\(\s*fd\s*,/.test(upsertBody) && /lastLineStartByte\(/.test(upsertBody),
		upsertBody);
}

// --- G: a rebuild that lands AT OR ABOVE the stale offset (#142) ---
//
// and it is a gap in the shrink branch THIS
// BRANCH added. That branch fires only on `stat.size < lastReadOffset`. A
// daemon that truncates and rebuilds before the `fs.watch` callback runs (one
// coalesced event — the normal case, not a race you have to engineer) leaves
// the final size at or ABOVE the stale offset, so the check never fires.
//
// Reproduced before fixing: a 3-record file rebuilt to 5 records left the
// reader holding `orig-1..3` — records from a file that no longer exists —
// reading from the stale offset into the MIDDLE of a line, dropping the
// fragment, and silently losing `rebuilt-1..3`. Wrong in both directions at
// once. `stat.ino` cannot see it either: truncate-and-rewrite keeps the inode.
{
	const gdir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-130-G-")));
	const gtag = path.join(gdir, "s.wtft-tag.v3.jsonl");
	const line = (id: string) => JSON.stringify({ id }) + "\n";

	// -- G1: the decision table, pure --
	assert("G1 a file shorter than the offset reseeds", watcherAction(10, 50, true) === "reseed");
	assert("G1a a LARGER file whose consumed prefix changed reseeds too — the case the shrink check could not see",
		watcherAction(140, 75, false) === "reseed");
	assert("G1b a larger file with an intact prefix is an ordinary read", watcherAction(140, 75, true) === "read");
	// A null sentinel comparison must reseed, not idle: `prefixSentinel` is
	// refreshed only where the offset moves, the offset moves only on the
	// `read` branch, and `read` is unreachable while the comparison is `null`
	// — so one failed sentinel read froze the watch permanently.
	assert("G1c an unreadable prefix RE-SEEDS — idling here freezes the watch forever",
		watcherAction(140, 75, null) === "reseed");
	assert("G1d a file that did not grow is idle", watcherAction(75, 75, true) === "idle");
	// A shrink outranks an unreadable sentinel: the bytes are provably gone.
	assert("G1e a shrink reseeds even when the sentinel could not be read", watcherAction(10, 50, null) === "reseed");

	// G5 — the deadlock property itself, stated as a rule rather than a case.
	// Every state that does not advance the offset must be one the NEXT event
	// can leave. `idle` is the only non-advancing action, so `idle` must never
	// be reachable while the file has bytes we have not read: if it were, the
	// sentinel could never be refreshed and nothing would ever move again.
	const stuck = ([140, 200, 1000] as const).flatMap(size =>
		([true, false, null] as const)
			.filter(m => watcherAction(size, 75, m) === "idle")
			.map(m => `size=${size} matches=${String(m)}`));
	assert("G5 no unread-bytes state resolves to `idle`, so the watch can always make progress",
		stuck.length === 0, `states that would freeze: ${JSON.stringify(stuck)}`);
	// The converse, so G5 cannot pass by `idle` having been deleted outright.
	assert("G5a and a file with nothing new IS idle — the action still exists",
		watcherAction(75, 75, true) === "idle");

	// -- G2: the sentinel reads the bytes it claims to --
	fs.writeFileSync(gtag, line("orig-1") + line("orig-2") + line("orig-3"));
	const off = fs.statSync(gtag).size;
	const sentinel = readPrefixSentinel(gtag, off);
	assert("G2 the sentinel is non-null on a readable file", sentinel !== null);
	const whole = fs.readFileSync(gtag);
	// It anchors at the START OF THE LAST CONSUMED LINE, not at the offset, and
	// samples BELOW that — the heartbeat occupies the last line and mutates in
	// place, so a window ending at the offset straddles bytes that change by
	// design (G6).
	const anchorOff = whole.lastIndexOf(0x0a, off - 2) + 1;
	assert("G2a it anchors at the start of the last consumed line, not at the offset",
		sentinel !== null && sentinel.anchor === anchorOff,
		`anchor=${sentinel?.anchor} expected=${anchorOff} offset=${off}`);
	assert("G2a' and the anchor is strictly BELOW the offset — otherwise the mutable last line is still in the window",
		sentinel !== null && sentinel.anchor < off);
	assert("G2b the bytes are exactly those immediately below the anchor",
		sentinel !== null && sentinel.bytes.equals(
			whole.subarray(Math.max(0, anchorOff - PREFIX_SENTINEL_BYTES), anchorOff)));
	assert("G2c an offset of 0 has no prefix, so the sentinel is empty and cannot mismatch",
		readPrefixSentinel(gtag, 0)?.bytes.length === 0);
	assert("G2d a file that cannot be opened is `null`, not an empty match",
		readPrefixSentinel(path.join(gdir, "does-not-exist.jsonl"), 10) === null);

	// -- G3: the end-to-end property, on the exact shape that was silently lossy --
	const rebuilt = ["rebuilt-1", "rebuilt-2", "rebuilt-3", "rebuilt-4", "rebuilt-5"].map(line).join("");
	fs.writeFileSync(gtag, rebuilt);                     // truncate + rewrite, one shot
	const sizeNow = fs.statSync(gtag).size;

	// The precondition IS the bug: assert the shrink check would NOT have fired,
	// or this test silently stops exercising the case it was written for.
	assert("G3 fixture precondition: the rebuilt file is LARGER than the stale offset, so the shrink check cannot fire",
		sizeNow >= off, `size=${sizeNow} offset=${off}`);

	const after = readPrefixSentinel(gtag, off);
	const matches = sentinelMatches(after, sentinel);
	assert("G3a the sentinel notices the prefix changed under it", matches === false);
	assert("G3b so the watcher reseeds instead of reading from a stale offset",
		watcherAction(sizeNow, off, matches) === "reseed");

	// And the reseed recovers every rebuilt record, losing none and keeping no ghosts.
	const reseeded = seedClassifiedTagFile(gtag);
	assert("G3c the reseed reads the file", reseeded.read);
	assert("G3d and lands the offset at EOF, so nothing is re-read or skipped",
		reseeded.offset === sizeNow, `offset=${reseeded.offset} size=${sizeNow}`);

	// -- G4: the seam is actually wired in, not merely exported --
	const libSrc = fs.readFileSync(path.resolve(import.meta.dirname, "..", "extensions", "lib", "wtft-daemon-lib.ts"), "utf8");
	assert("G4 the watcher calls watcherAction — an exported decision nothing invokes is not a fix",
		/const action = watcherAction\(/.test(libSrc));
	// NOT a count of `lastReadOffset = ` occurrences — the first draft of this
	// assertion did exactly that and failed, because it was counting COMMENTS
	// and docstrings alongside statements. Pin the one thing that makes the fix
	// work instead: the callback recomputes the sentinel on EVERY event, so a
	// rebuild between two events cannot slip through on a stale copy.
	assert("G4a and recomputes the sentinel on every event, not once at attach",
		/const sentinelNow = readPrefixSentinel\(/.test(libSrc));

	// -- G6: an IDLE heartbeat is not a rebuild --
	//
	// The regression this pins: the sentinel used to sample the 64 bytes before
	// the reader's OFFSET, which sits at EOF. The last line of a tag file is the
	// heartbeat, rewritten in place at the daemon's every beat with a new `last`
	// timestamp — same width, same file size. So the window straddled a line
	// that mutates by design, mismatched on every beat, and an idle watch
	// re-seeded: a whole-file re-read and re-parse of a file that gained
	// nothing. 8 MB, 644,312
	// lines): 585 ms per re-seed against a 667 ms beat.
	//
	// The fixture writes a REAL heartbeat, the shape `upsertHeartbeat` writes,
	// and beats it the way the daemon does — a same-width in-place write, never
	// a rewrite of the file.
	const hbOf = (last: number) => JSON.stringify({ _hb: { first: 1758000000000, last } }) + "\n";
	fs.writeFileSync(gtag, line("rec-1") + line("rec-2") + line("rec-3") + hbOf(1758000000000));
	const hbSize = fs.statSync(gtag).size;
	const hbOff = hbSize;                          // the reader consumed every whole line
	const hbBefore = readPrefixSentinel(gtag, hbOff);

	const beat = Buffer.from(hbOf(1758000000667), "utf8");
	// Precondition: the beat must be the same width, or it is an APPEND and this
	// test stops exercising the in-place case it was written for.
	assert("G6 fixture precondition: a beat is the same width, so the file size cannot change",
		beat.length === Buffer.byteLength(hbOf(1758000000000)));
	const hbFd = fs.openSync(gtag, "r+");
	fs.writeSync(hbFd, beat, 0, beat.length, hbSize - beat.length);
	fs.closeSync(hbFd);
	assert("G6a fixture precondition: the size really is unchanged, so the shrink branch cannot fire",
		fs.statSync(gtag).size === hbSize);
	// And the beat really did change bytes — otherwise a no-op write would pass
	// this test while the bug was still there.
	const hbTail = fs.readFileSync(gtag).subarray(hbSize - beat.length);
	assert("G6b fixture precondition: the new beat landed, and differs from the old one",
		hbTail.equals(beat) && !beat.equals(Buffer.from(hbOf(1758000000000), "utf8")));

	const hbAfter = readPrefixSentinel(gtag, hbOff);
	const hbMatches = sentinelMatches(hbAfter, hbBefore);
	assert("G6c a heartbeat beat does NOT look like a rebuild — the prefix below the last line is untouched",
		hbMatches === true);
	assert("G6d so an idle watch idles instead of re-reading the whole file",
		watcherAction(hbSize, hbOff, hbMatches) === "idle");

	// The converse, so G6 cannot pass by the sentinel having been defanged into
	// always matching: a real rebuild at the same size is still caught.
	// Same-length ids on purpose: the rebuild must differ from the original in
	// CONTENT only, so size cannot be what distinguishes it.
	const sameSizeRebuild = line("gho-1") + line("gho-2") + line("gho-3") + hbOf(1758000000000);
	assert("G6e fixture precondition: the rebuild is byte-identical in LENGTH, so only content can distinguish it",
		Buffer.byteLength(sameSizeRebuild) === hbSize);
	fs.writeFileSync(gtag, sameSizeRebuild);
	const rebuiltSentinel = readPrefixSentinel(gtag, hbOff);
	assert("G6f a rebuild that kept the file's SIZE is still caught",
		sentinelMatches(rebuiltSentinel, hbBefore) === false);
	assert("G6g and still reseeds",
		watcherAction(hbSize, hbOff, sentinelMatches(rebuiltSentinel, hbBefore)) === "reseed");
}


// --- A: a slowly-written record is read once, not once per poll (#142) ---
//
// `lastSize` advanced only by WHOLE LINES, so a
// record still missing its newline left the offset parked behind it and every
// poll re-allocated and re-read the entire partial record from disk. Quadratic
// in the record's size.
//
// MEASURED, replaying this function's exact offset arithmetic against a 64 MiB
// record written in 1 MiB chunks, one chunk per poll:
//   before — 2,144 MiB read to deliver 64 MiB, largest single alloc 64 MiB, 33.5x
//   after  —    64 MiB read to deliver 64 MiB, largest single alloc  1 MiB,  1.0x
//
// The report also claimed it "throws at MAX_LENGTH". It cannot: `buffer.constants
// .MAX_LENGTH` is 8,388,608 GiB on this node, so that needs an 8-PiB single line.
// Fixed for the real reason — the quadratic re-read — and the thread says so.
//
// The SEMANTICS are guarded behaviourally by R3 (a complete record with no
// trailing newline is still counted) and R4 (1,830 one-byte writes across four
// poll intervals reach the same total). Those two are what would break if the
// carry-forward were wrong. This block is SOURCE-LEVEL and says so: it pins the
// offset discipline that makes the cost linear, which no observable at 667 ms
// resolution distinguishes — the same reasoning S2 and S3 are written under.
{
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.ts"), "utf8");
	const lines = src.split("\n");
	const starts: number[] = [];
	lines.forEach((l, i) => { if (/^(async )?function /.test(l)) starts.push(i + 1); });
	const at = lines.findIndex(l => /^function parseNewLines\(/.test(l)) + 1;
	assert("A0 parseNewLines is still in the daemon — the check has a subject", at > 0);
	const end = starts.find(n => n > at) ?? lines.length + 1;
	const body = lines.slice(at - 1, end - 1).join("\n");

	// SELF-CHECK first, same discipline as S2: an extraction that silently
	// returned the whole file would make every assertion below meaningless.
	assert("A0a self-check: the extracted body is parseNewLines and not the whole file",
		body.includes("function parseNewLines(") && body.length < src.length,
		`body=${body.length} src=${src.length}`);
	assert("A0b self-check: it does not swallow the next function",
		(body.match(/^function /gm) ?? []).length === 1);

	assert("A1 the offset advances to the file size on every read, so no byte is fetched twice",
		/lastSize = currentSize;/.test(body));
	assert("A2 and the whole-line-only advance that caused the re-read is gone",
		!/lastSize \+=/.test(body), "`lastSize +=` is back — the offset is parked behind a partial record again");
	assert("A3 the partial record is carried as BYTES between polls, not merely as a length",
		/pendingFragment = Buffer\.from\(/.test(body));
	assert("A4 a quiet poll still evaluates the held fragment, or a dead writer's last record is never released",
		/!grew && pendingFragment\.length === 0/.test(body));
	// The settled check must compare bytes: a same-length replacement is a
	// DIFFERENT record, and the old length-equality test called it settled.
	assert("A5 the writer-died check compares the fragment's bytes, not its length",
		/fragment\.equals\(pendingFragment\)/.test(body));
	assert("A6 a truncation clears the carried fragment — bytes from the old file say nothing about the new one",
		/pendingFragment = Buffer\.alloc\(0\);/.test(src.slice(0, src.indexOf("const grew = currentSize > lastSize"))));
}


for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}\n`);
if (failed > 0) process.exit(1);
