/**
 * The spawn ledger — the parent→child edge, written down at spawn
 *   time because it cannot be recovered afterwards.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Bumped when the record's shape changes. A reader SKIPS any other value
 *  rather than guessing at a field it does not know. */
export const SPAWN_RECORD_SCHEMA = "wtft/spawn@1";

/** Cap on one appended line, newline included.
 *  Linux takes the inode lock for the duration of one
 *  `write`, which is what makes a single-call O_APPEND write land whole in
 *  practice. 4096 is a deliberately conservative bound — small enough to be one
 *  page and one call, and the same figure as PIPE_BUF. Two spawners
 *  interleaving would lose BOTH edges, not one. */
export const MAX_RECORD_BYTES = 4096;

/** Per-field cap on every text field, so a pathological value cannot push a
 *  record past MAX_RECORD_BYTES. */
export const MAX_FIELD_BYTES = 512;

export interface SpawnRecord {
	schema: typeof SPAWN_RECORD_SCHEMA;
	/** ISO-8601 UTC, when the EDGE was recorded — not when the child finished. */
	ts: string;
	parent: string;
	child: string;
	/** Who made the edge: `pr-review-lens`, `herdr-agent-start`, … */
	mechanism: string;
	/** The child's cwd, when the spawner knows it. Never used to FIND the child
	 *  — a worktree move relocates the transcript and a recorded path would
	 *  rot, while the uuid does not. */
	cwd?: string;
	label?: string;
	model?: string;
}

/** One edge as read back. Deliberately NOT carrying a ledger line number. */
export type SpawnEdge = SpawnRecord;

export interface SpawnLedger {
	childrenOf: Map<string, SpawnEdge[]>;
	/** Lines that could not be used, COUNTED. A line dropped silently is money
	 *  dropped silently; this number is reported so a broken writer is visible. */
	malformedLines: number;
}

const UUID_ANYWHERE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** Longest id we will record. A session id is a filename component. */
const MAX_SESSION_ID_BYTES = 128;

/**
 * A session id AS ITS HARNESS SPELLS IT.
 * the id must CONTAIN a uuid.
 */
export function isSessionId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (Buffer.byteLength(value, "utf8") > MAX_SESSION_ID_BYTES) return false;
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
	if (value === "." || value === ".." || value.includes("..")) return false;
	return UUID_ANYWHERE.test(value);
}

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

/** C0 controls, DEL, and the C1 range — every character that can move a cursor,
 *  start an escape sequence, or forge a line break in a rendered report.
 *  Refused at the WRITER so a bad record never reaches the
 *  file; the renderer sanitises anyway because the file can be hand-edited. */
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function requireField(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`spawn record: ${name} is required and must be a non-empty string`);
	}
	if (Buffer.byteLength(value, "utf8") > MAX_FIELD_BYTES) {
		throw new Error(`spawn record: ${name} exceeds ${MAX_FIELD_BYTES} bytes`);
	}
	if (TERMINAL_CONTROL.test(value)) {
		throw new Error(`spawn record: ${name} contains a control character — a newline forges a report row and an escape sequence runs in the reader's terminal`);
	}
	return value;
}

function optionalField(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return requireField(value, name);
}

/**
 * Validation happens HERE, at the spawner: a malformed uuid is a permanently
 * unresolvable edge, and the report that finds it months later cannot ask the
 * spawner what it meant.
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
	// Omitted, never nulled: `"cwd": null` and an absent cwd say the same thing.
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
 * A spawner is expected to ignore the failure — an unwritten edge
 * degrades to exactly today's behaviour, and blocking a spawn over accounting
 * would be the worse trade.
 */
export function appendSpawnRecord(record: SpawnRecord, file: string = spawnLedgerPath()): void {
	const line = serializeSpawnRecord(record) + "\n";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const buf = Buffer.from(line, "utf8");
	// O_NONBLOCK: `openSync(file, "a")` on a FIFO blocks until a reader shows
	// up. With O_NONBLOCK the open returns and the fstat below refuses it.
	const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NONBLOCK, 0o600);
	try {
		if (!fs.fstatSync(fd).isFile()) {
			throw new Error(`spawn ledger is not a regular file (${file}) — refusing to append; a FIFO or device here is not a ledger`);
		}
		// One write, and a check that it was one write — a short write is legal,
		// so ignoring it would report a truncated line as a recorded edge.
		const written = fs.writeSync(fd, buf);
		if (written !== buf.length) {
			throw new Error(`spawn ledger: short write (${written} of ${buf.length} bytes) — the disk is probably full; one partial line remains and is reported as a malformed line on the next read`);
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Refuse to read a ledger larger than this.
 * NOT a window: the reader takes the whole file or none of it. Refusing is
 * both simpler and stricter — a refusal cannot omit an edge silently, and it
 * comes back as `ledgerError` with a remedy in it. */
export const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

/** Read the whole ledger, or refuse — never part of it.
 *  Open first, then ask the descriptor — not `statSync` then `readFileSync`:
 *   - TOCTOU: a ledger growing between the two is read IN FULL however large
 *     it got, so the advertised refusal would not hold.
 *   - A FIFO at the ledger path blocks forever on `readFileSync`. */
function readLedgerText(file: string): string | null {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	} catch (err) {
		// ENOENT is ordinary: nothing has ever spawned. Any other open error
		// must not read as "no edges".
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) {
			throw new Error(`spawn ledger is not a regular file (${file}) — a FIFO, device or directory here cannot be read as a ledger, and reading it could block the report forever`);
		}
		if (stat.size > MAX_LEDGER_BYTES) {
			throw new Error(`spawn ledger is ${stat.size} bytes, over the ${MAX_LEDGER_BYTES}-byte limit (${file}) — prune it; reading part of it would drop edges without saying which`);
		}
		// Bounded by the size we just verified on this descriptor. A concurrent
		// append lands past it and is simply not in this snapshot.
		const buf = Buffer.alloc(stat.size);
		let read = 0;
		while (read < buf.length) {
			const n = fs.readSync(fd, buf, read, buf.length - read, read);
			if (n === 0) break;   // truncated under us; the snapshot is what we got
			read += n;
		}
		return buf.subarray(0, read).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * A line that is not JSON, carries a schema this reader does not know, is
 * missing a required field, or carries a `parent`/`child` that is not uuid-
 * shaped is skipped AND COUNTED. (A blank line is skipped and NOT counted — it
 * is whitespace, not a failed record.)
 */
export function readSpawnLedger(file: string = spawnLedgerPath()): SpawnLedger {
	const childrenOf = new Map<string, SpawnEdge[]>();
	let malformedLines = 0;

	const read = readLedgerText(file);
	if (read === null) return { childrenOf, malformedLines };

	const lines = read.split("\n");

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
		// A session file's basename and its id are both accepted by the writer;
		// the walk keys on one spelling, or one session is counted twice.
		const edge: SpawnEdge = {
			schema: SPAWN_RECORD_SCHEMA,
			ts: r.ts,
			parent: r.parent.replace(/\.jsonl$/i, ""),
			child: r.child.replace(/\.jsonl$/i, ""),
			mechanism: r.mechanism,
		};
		if (typeof r.cwd === "string") edge.cwd = r.cwd;
		if (typeof r.label === "string") edge.label = r.label;
		if (typeof r.model === "string") edge.model = r.model;

		const list = childrenOf.get(edge.parent);
		if (list) list.push(edge); else childrenOf.set(edge.parent, [edge]);
	}

	return { childrenOf, malformedLines };
}

// ---
// `wtft spawn-record` — the one line a launcher calls
// ---

/** Exit codes, versioned API (README + docs/manifests/wtft-cmd.json). */
export const SPAWN_RECORD_EXIT = {
	OK: 0,
	BAD_ARGS: 2,
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
 * The ledger path and the clock are parameters with defaults rather than direct
 * reads, so the exit-code table above is testable without a process.
 * Every failure names the flag that caused it. A spawner calls this from a
 * shell script and will not read a stack trace.
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
		// `--flag value` and `--flag=value` both. No `--ts`: the clock fills it.
		const m = /^--(parent|child|mechanism|cwd|label|model)(?:=(.*))?$/.exec(arg);
		if (!m) {
			// Silently ignoring an unknown flag is how a typo'd `--mechansim`
			// becomes a missing-argument error that blames the wrong flag.
			return { exitCode: SPAWN_RECORD_EXIT.BAD_ARGS, stdout: "", stderr: `wtft spawn-record: unknown argument ${arg}\n${SPAWN_RECORD_USAGE}` };
		}
		const value = m[2] !== undefined ? m[2] : argv[++i];
		// A bare `--flag` followed by another flag must not swallow it.
		// `--flag=--value` still works for a value that really starts with `--`.
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
