/**
 * @package @princess-pi/wtft
 * @module wtft-spawn-ledger
 * @description The spawn ledger (#116, direction A) — the parent→child edge,
 *   written down at spawn time because it cannot be recovered afterwards.
 *   Spec: docs/spec-116-spawn-ledger.md.
 *
 *   A launcher-spawned session (a `pr-review` lens, `herdr agent start`, any
 *   wrapper script) leaves NO trace of its parent. The parent's transcript has
 *   no `cd` and no `claude` at the command head, so `cwdForClaudeSpawn` returns
 *   null; the child's transcript lives in a project dir the parent never wrote
 *   to; and neither file contains a field naming the other. There is no edge to
 *   re-derive, so no tagger version bump can reach the money — measured at
 *   $69.68 unattributed on a session reporting $70.33.
 *
 *   The spawner knows both ids before the child runs (`claude --session-id`
 *   takes the child's uuid as INPUT), so this module's job is to make writing
 *   that fact cost one line, and to make reading it back honest about what it
 *   could not use.
 *
 *   This module owns the FILE and the `spawn-record` command line. It parses no
 *   session, prices nothing, and imports no renderer — the walk that turns edges
 *   into money is wtft-spawn-tree.ts. That separation is why a spawner's call
 *   does no session-reading work at runtime, whatever the bundler packs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Bumped when the record's shape changes. A reader SKIPS any other value
 *  rather than guessing at a field it does not know. */
export const SPAWN_RECORD_SCHEMA = "wtft/spawn@1";

/** Cap on one appended line, newline included.
 *
 *  POSIX does not promise that a `write(2)` to a regular file is atomic against
 *  a concurrent writer; Linux takes the inode lock for the duration of one
 *  `write`, which is what makes a single-call O_APPEND write land whole in
 *  practice. 4096 is a deliberately conservative bound on how much we rely on
 *  that — small enough to be one page and one call, and the same figure as
 *  PIPE_BUF, which is where the number comes from even though the guarantee is
 *  not the pipe one. Two spawners interleaving would lose BOTH edges, not one.
 *
 *  Reachable only through JSON escape expansion in practice: five capped text
 *  fields plus two uuids come to roughly 2.2 KiB of ordinary characters, so the
 *  field cap below normally pre-empts this one. It is the backstop. */
export const MAX_RECORD_BYTES = 4096;

/** Per-field cap, applied to EVERY text field — `ts` and `mechanism` as well as
 *  the three optional ones — so a pathological value cannot push a record past
 *  MAX_RECORD_BYTES and put the single-write append above out of reach. */
export const MAX_FIELD_BYTES = 512;

export interface SpawnRecord {
	schema: typeof SPAWN_RECORD_SCHEMA;
	/** ISO-8601 UTC, when the EDGE was recorded — not when the child finished.
	 *  `wtft spawn-record` fills this from the clock; there is no flag for it,
	 *  because a spawner passing its own timestamp is a way for the ledger to
	 *  disagree with itself and buys nothing. Checked for ISO-8601 shape on
	 *  write: an unparseable `ts` is as permanently useless as a bad uuid. */
	ts: string;
	/** Session id of the spawning session, as its harness spells it. */
	parent: string;
	/** Session id of the spawned session, as its harness spells it. */
	child: string;
	/** Who made the edge: `pr-review-lens`, `herdr-agent-start`, … */
	mechanism: string;
	/** The child's cwd, when the spawner knows it. Never used to FIND the child
	 *  — a worktree move relocates the transcript (#6) and a recorded path
	 *  would rot, while the uuid does not. */
	cwd?: string;
	/** A human name for the child (`correctness`, `agent/824`). */
	label?: string;
	/** The model the child was started with. */
	model?: string;
}

/** One edge as read back.
 *
 *  Deliberately NOT carrying a ledger line number. The first version did, and it
 *  was wrong by construction on any ledger over LEDGER_TAIL_BYTES: the tail read
 *  starts mid-file and drops a partial first line, so the index is an offset
 *  into the window, not into the file. A number that is right until the ledger
 *  gets big is worse than no number. */
export type SpawnEdge = SpawnRecord;

export interface SpawnLedger {
	/** parent session id → its recorded edges, in ledger order. */
	childrenOf: Map<string, SpawnEdge[]>;
	/** The read stopped at LEDGER_TAIL_BYTES, so edges older than that window
	 *  were never seen — plus the one line the window boundary always drops.
	 *  Reported rather than inferred: those edges are in neither `childrenOf`
	 *  nor `malformedLines`, so without this flag a truncated read looks exactly
	 *  like a complete one. */
	truncated: boolean;
	/** Lines that could not be used, COUNTED. A line dropped silently is money
	 *  dropped silently; this number is reported so a broken writer is visible. */
	malformedLines: number;
}

const UUID_ANYWHERE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** Longest id we will record. A session id is a filename component, and a
 *  pathological one is a way to make the ledger unreadable for everyone. */
const MAX_SESSION_ID_BYTES = 128;

/**
 * A session id AS ITS HARNESS SPELLS IT.
 *
 * Claude Code names a session file for a bare uuid; Pi prefixes it with a
 * timestamp (CONTEXT.md, **Session**). An earlier version of this required a
 * bare uuid, which meant a Pi session could never be a parent — so the Pi
 * widget's spawn block was unreachable code on the only harness it runs in.
 *
 * The rule is the repo's existing one (`isSessionIdBasename`): the id must
 * CONTAIN a uuid. Plus two constraints this file adds, because the id becomes
 * part of a filename lookup: one path component, and bounded.
 */
export function isSessionId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (Buffer.byteLength(value, "utf8") > MAX_SESSION_ID_BYTES) return false;
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
	if (value === "." || value === ".." || value.includes("..")) return false;
	return UUID_ANYWHERE.test(value);
}

/** ISO-8601 shape, and a date the runtime can actually parse. */
function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string"
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
		&& !Number.isNaN(Date.parse(value));
}

/** `$XDG_STATE_HOME/wtft/spawns.jsonl`, defaulting to `~/.local/state/…`. */
export function spawnLedgerPath(): string {
	const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	return path.join(state, "wtft", "spawns.jsonl");
}

function requireField(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`spawn record: ${name} is required and must be a non-empty string`);
	}
	if (Buffer.byteLength(value, "utf8") > MAX_FIELD_BYTES) {
		throw new Error(`spawn record: ${name} exceeds ${MAX_FIELD_BYTES} bytes`);
	}
	return value;
}

function optionalField(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return requireField(value, name);
}

/**
 * One record → the JSON text of one line (no trailing newline; the caller adds
 * it), or a throw naming what is wrong. The size check counts the newline,
 * because the newline is part of the write that has to land whole.
 *
 * Validation happens HERE, at the spawner, because it is the last moment it is
 * cheap: a malformed uuid is a permanently unresolvable edge, and the report
 * that finds it months later cannot ask the spawner what it meant.
 */
export function serializeSpawnRecord(record: SpawnRecord): string {
	if (record.schema !== SPAWN_RECORD_SCHEMA) {
		throw new Error(`spawn record: schema must be ${SPAWN_RECORD_SCHEMA}`);
	}
	if (!isSessionId(record.parent)) throw new Error(`spawn record: parent is not a session id: ${String(record.parent).slice(0, 64)}`);
	if (!isSessionId(record.child)) throw new Error(`spawn record: child is not a session id: ${String(record.child).slice(0, 64)}`);
	if (!isIsoTimestamp(record.ts)) throw new Error(`spawn record: ts is not an ISO-8601 UTC timestamp: ${String(record.ts).slice(0, 64)}`);

	const out: SpawnRecord = {
		schema: SPAWN_RECORD_SCHEMA,
		ts: requireField(record.ts, "ts"),
		parent: record.parent,
		child: record.child,
		mechanism: requireField(record.mechanism, "mechanism"),
	};
	// Omitted, never nulled: `"cwd": null` and an absent cwd say the same thing
	// to a reader, and only one of them costs bytes in a 4 KiB budget.
	const cwd = optionalField(record.cwd, "cwd");
	if (cwd !== undefined) out.cwd = cwd;
	const label = optionalField(record.label, "label");
	if (label !== undefined) out.label = label;
	const model = optionalField(record.model, "model");
	if (model !== undefined) out.model = model;

	const line = JSON.stringify(out) + "\n";
	if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
		throw new Error(`spawn record: ${Buffer.byteLength(line, "utf8")} bytes exceeds the ${MAX_RECORD_BYTES}-byte atomic-append limit`);
	}
	return JSON.stringify(out);
}

/**
 * Append one edge. One `write(2)` under O_APPEND, so concurrent spawners
 * interleave whole lines rather than halves of two.
 *
 * Throws on a bad record (the caller's bug) or an unwritable ledger (the host's
 * problem). A spawner is expected to ignore the failure — an unwritten edge
 * degrades to exactly today's behaviour, and blocking a spawn over accounting
 * would be the worse trade.
 */
export function appendSpawnRecord(record: SpawnRecord, file: string = spawnLedgerPath()): void {
	const line = serializeSpawnRecord(record) + "\n";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const buf = Buffer.from(line, "utf8");
	const fd = fs.openSync(file, "a");
	try {
		// ONE write, and then a check that it was one write. `writeSync` returns
		// a byte count and a short write is legal: ignoring it leaves a
		// truncated line in the ledger and still exits 0, which is a malformed
		// record reported as a recorded edge. A retry would append the REST of
		// the line as a second record, so the only honest move is to say the
		// append failed — the caller's contract is already "an unwritten edge
		// degrades to the old behaviour".
		let written = 0;
		try {
			written = fs.writeSync(fd, buf);
		} finally {
			// TERMINATE THE FRAGMENT. A partial line with no newline is not just
			// one lost record: the next spawner's O_APPEND lands directly after
			// those bytes and MERGES INTO them, so a second, correctly recorded
			// edge is destroyed by the first one's failure — and that child goes
			// invisible rather than unattributed. One best-effort newline turns
			// two casualties into one. It runs in `finally` because the throwing
			// case (ENOSPC mid-write) is exactly the one that leaves a fragment.
			if (written > 0 && written !== buf.length) {
				try { fs.writeSync(fd, Buffer.from("\n", "utf8")); } catch { /* nothing more to try */ }
			}
		}
		if (written !== buf.length) {
			throw new Error(`spawn ledger: short write (${written} of ${buf.length} bytes) — one partial line remains, terminated so the next record stays intact`);
		}
	} finally {
		fs.closeSync(fd);
	}
}

/** Read no more than this from the tail. Past it, the ledger is older than any
 *  live session's lineage, and a whole-file read of an append-only log that
 *  nothing prunes is an unbounded cost that grows for the life of the host. */
export const LEDGER_TAIL_BYTES = 8 * 1024 * 1024;

function readLedgerText(file: string): { text: string; truncated: boolean } | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch (err) {
		// ENOENT is the ordinary case: nothing has ever spawned. Any other stat
		// error is a read failure and must not read as "no edges" — that would
		// report a complete tree built from a ledger nobody could open.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (stat.size <= LEDGER_TAIL_BYTES) {
		return { text: fs.readFileSync(file, "utf8"), truncated: false };
	}
	const start = stat.size - LEDGER_TAIL_BYTES;
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(LEDGER_TAIL_BYTES);
		const got = fs.readSync(fd, buf, 0, LEDGER_TAIL_BYTES, start);
		return { text: buf.subarray(0, got).toString("utf8"), truncated: true };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Read the ledger into `parent → edges`.
 *
 * A line that is not JSON, carries a schema this reader does not know, is
 * missing a required field, or carries a `parent`/`child` that is not uuid-
 * shaped is skipped AND COUNTED. (A blank line is skipped and NOT counted — it
 * is whitespace, not a failed record.) Counting is the whole point:
 * this file is the only record of an edge that cannot be recovered any other
 * way, so a writer quietly producing garbage must show up as a number a report
 * can print, not as an absence indistinguishable from "nothing spawned".
 */
export function readSpawnLedger(file: string = spawnLedgerPath()): SpawnLedger {
	const childrenOf = new Map<string, SpawnEdge[]>();
	let malformedLines = 0;

	const read = readLedgerText(file);
	if (read === null) return { childrenOf, malformedLines, truncated: false };

	const lines = read.text.split("\n");
	// A tail read starts mid-line; that fragment is not a malformed record, it
	// is half of a record whose other half we chose not to read. The drop is
	// UNCONDITIONAL on a truncated read because the two cases are genuinely
	// indistinguishable from inside the window — so past LEDGER_TAIL_BYTES one
	// intact record may be dropped with it. That costs one edge out of the
	// ~40,000 an 8 MiB ledger holds, and only once the ledger is that big.
	if (read.truncated && lines.length > 0) lines.shift();

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim();
		if (!raw) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			malformedLines++;
			continue;
		}
		const r = parsed as Partial<SpawnRecord>;
		if (r?.schema !== SPAWN_RECORD_SCHEMA
			|| !isSessionId(r.parent)
			|| !isSessionId(r.child)
			|| typeof r.ts !== "string" || !r.ts
			|| typeof r.mechanism !== "string" || !r.mechanism) {
			malformedLines++;
			continue;
		}
		const edge: SpawnEdge = {
			schema: SPAWN_RECORD_SCHEMA,
			ts: r.ts,
			parent: r.parent,
			child: r.child,
			mechanism: r.mechanism,
		};
		if (typeof r.cwd === "string") edge.cwd = r.cwd;
		if (typeof r.label === "string") edge.label = r.label;
		if (typeof r.model === "string") edge.model = r.model;

		const list = childrenOf.get(edge.parent);
		if (list) list.push(edge); else childrenOf.set(edge.parent, [edge]);
	}

	return { childrenOf, malformedLines, truncated: read.truncated };
}

// ---
// `wtft spawn-record` — the one line a launcher calls
// ---

/** Exit codes, versioned API (README + docs/manifests/wtft-cmd.json). */
export const SPAWN_RECORD_EXIT = {
	OK: 0,
	/** Bad arguments: missing required flag, malformed uuid, oversized field. */
	BAD_ARGS: 2,
	/** The ledger could not be written. */
	UNWRITABLE: 3,
} as const;

export interface SpawnRecordCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export const SPAWN_RECORD_USAGE =
	"usage: wtft spawn-record --parent <uuid> --child <uuid> --mechanism <name>\n" +
	"                        [--cwd <path>] [--label <text>] [--model <name>] [--json]\n";

/**
 * Parse, validate, append.
 *
 * The ledger path and the clock are parameters with defaults rather than direct
 * reads, so the exit-code table above is testable without a process — not
 * because this function is pure (its defaults read `process.env` and the wall
 * clock), but because a caller can supply both.
 *
 * Every failure names the flag that caused it. A spawner calls this from a
 * shell script and will not read a stack trace; the whole value of validating
 * here is that the message reaches whoever can still fix the spawn.
 */
export function runSpawnRecordCommand(
	argv: string[],
	file: string = spawnLedgerPath(),
	now: () => string = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): SpawnRecordCommandResult {
	const flags: Record<string, string> = {};
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") { json = true; continue; }
		if (arg === "-h" || arg === "--help") {
			return { exitCode: SPAWN_RECORD_EXIT.OK, stdout: SPAWN_RECORD_USAGE, stderr: "" };
		}
		// `--flag value` and `--flag=value` both. No `--ts`: the clock fills it
		// (see the SpawnRecord field doc), and a spawner-supplied timestamp is a
		// way for the ledger to disagree with itself for no gain.
		const m = /^--(parent|child|mechanism|cwd|label|model)(?:=(.*))?$/.exec(arg);
		if (!m) {
			// Silently ignoring an unknown flag is how a typo'd `--mechansim`
			// becomes a missing-argument error that blames the wrong flag (#91).
			return { exitCode: SPAWN_RECORD_EXIT.BAD_ARGS, stdout: "", stderr: `wtft spawn-record: unknown argument ${arg}\n${SPAWN_RECORD_USAGE}` };
		}
		const value = m[2] !== undefined ? m[2] : argv[++i];
		// A bare `--flag` followed by another flag used to swallow it: `--label
		// --json` recorded the label "--json" and dropped the echo, and
		// `--mechanism --parent <uuid>` then blamed `<uuid>` as the unknown
		// argument — the opposite of naming the flag that caused the failure.
		// `--flag=--value` still works, for a value that really does start with
		// a dash.
		if (value === undefined || (m[2] === undefined && value.startsWith("--"))) {
			return { exitCode: SPAWN_RECORD_EXIT.BAD_ARGS, stdout: "", stderr: `wtft spawn-record: --${m[1]} needs a value (use --${m[1]}=<value> for one starting with --)\n${SPAWN_RECORD_USAGE}` };
		}
		flags[m[1]] = value;
	}

	for (const required of ["parent", "child", "mechanism"] as const) {
		if (!flags[required]) {
			return { exitCode: SPAWN_RECORD_EXIT.BAD_ARGS, stdout: "", stderr: `wtft spawn-record: --${required} is required\n${SPAWN_RECORD_USAGE}` };
		}
	}

	const record: SpawnRecord = {
		schema: SPAWN_RECORD_SCHEMA,
		ts: now(),
		parent: flags.parent,
		child: flags.child,
		mechanism: flags.mechanism,
		cwd: flags.cwd,
		label: flags.label,
		model: flags.model,
	};

	let line: string;
	try {
		line = serializeSpawnRecord(record);
	} catch (err) {
		return { exitCode: SPAWN_RECORD_EXIT.BAD_ARGS, stdout: "", stderr: `wtft ${err instanceof Error ? err.message : String(err)}\n` };
	}

	try {
		appendSpawnRecord(JSON.parse(line) as SpawnRecord, file);
	} catch (err) {
		return { exitCode: SPAWN_RECORD_EXIT.UNWRITABLE, stdout: "", stderr: `wtft spawn-record: could not write ${file}: ${err instanceof Error ? err.message : String(err)}\n` };
	}

	return { exitCode: SPAWN_RECORD_EXIT.OK, stdout: json ? line + "\n" : "", stderr: "" };
}
