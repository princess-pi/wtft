#!/usr/bin/env bun
/**
 * #137 — the harness already writes the parent link; read it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSubagentMeta, WTFT_TAGGER_VERSION } from "../bin/wtft.mjs";
import { trackSandbox } from "./lib/sandbox";
import { skip } from "./lib/skips";
import { runWtftCli } from "./lib/wtft-cli";

const CLI_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else {
		console.log(`  ${RED}FAIL${RESET} ${label}`); failed++;
		if (detail) console.log(detail.split("\n").map(l => `      │ ${l}`).join("\n"));
	}
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-137-")));

/** Write a transcript plus (optionally) its sibling meta, as the harness lays them out.
 *
 *  `wroteMeta` records what actually landed on disk. WHY (local audit round):
 *  every negative case below expects `null`, which is ALSO the answer when no
 *  meta exists — so a helper that silently stopped writing left them green while
 *  testing nothing. Measured: making the string-payload branch write no file left
 *  M4 ("unparseable JSON") and M6 ("a bare `null` document") both passing with no
 *  malformed file anywhere on disk. They were asserting the ABSENT case while
 *  claiming the MALFORMED one. `fixtureWrote` is the precondition that closes it. */
const wroteMeta = new Map<string, string>();

function subagent(name: string, meta: unknown | null): string {
	const dir = path.join(root, name, "subagents");
	fs.mkdirSync(dir, { recursive: true });
	const transcript = path.join(dir, `agent-${name}.jsonl`);
	fs.writeFileSync(transcript, "");
	if (meta !== null) {
		const payload = typeof meta === "string" ? meta : JSON.stringify(meta);
		const metaPath = path.join(dir, `agent-${name}.meta.json`);
		fs.writeFileSync(metaPath, payload);
		wroteMeta.set(transcript, payload);
	}
	return transcript;
}

/** Assert the fixture put the bytes it claims on disk, before trusting a `null`. */
function fixtureWrote(label: string, transcript: string): void {
	const payload = wroteMeta.get(transcript);
	const metaPath = transcript.replace(/\.jsonl$/, ".meta.json");
	assert(`${label} — fixture precondition: the meta file exists and holds what was asked for`,
		payload !== undefined && fs.existsSync(metaPath) && fs.readFileSync(metaPath, "utf8") === payload,
		`payload=${JSON.stringify(payload)} exists=${fs.existsSync(metaPath)}`);
}

console.log("\n§ M — readSubagentMeta, and every way it must decline\n");

// M1 — a full meta: the two universal fields plus `description`, `toolUseId`
// and `model`. M5c pins the other end, a workflow child with neither
// `description` nor `toolUseId`.
{
	const t = subagent("a641e532bfaae9903", {
		agentType: "general-purpose",
		description: "Fix 116 prose drift, grep-verified",
		toolUseId: "toolu_014xWPgGcSUHnLejKyXB1947",
		spawnDepth: 1,
		model: "sonnet",
	});
	const m = readSubagentMeta(t);
	assert("M1 a complete meta beside a transcript is read", m !== null);
	assert("M1 description — the words typed at dispatch, not a hash",
		m?.description === "Fix 116 prose drift, grep-verified", JSON.stringify(m));
	assert("M1 toolUseId — the RECORD of the parent link #116 said did not exist",
		m?.toolUseId === "toolu_014xWPgGcSUHnLejKyXB1947", JSON.stringify(m));
	assert("M1 agentType", m?.agentType === "general-purpose", JSON.stringify(m));
	assert("M1 spawnDepth", m?.spawnDepth === 1, JSON.stringify(m));
	assert("M1 model", m?.model === "sonnet", JSON.stringify(m));
}

// M2 — `model` absent, which is a real and recurring shape on this host. It is
// uncommon but routine — frequent enough that any caller will meet it, and the
// issue's Closer asked for `model` as though it were always there. The meta is
// still valid; `model` is undefined and the caller needs an arm for it. A null
// here is a gap, not a zero.
{
	const t = subagent("no-model-child", {
		agentType: "Explore", description: "sweep the corpus",
		toolUseId: "toolu_nomodel", spawnDepth: 1,
	});
	const m = readSubagentMeta(t);
	assert("M2 a meta with no `model` is still a valid meta", m !== null, JSON.stringify(m));
	assert("M2 and `model` is undefined, not the empty string",
		m !== null && m.model === undefined, JSON.stringify(m));
	assert("M2 the rest is intact", m?.description === "sweep the corpus", JSON.stringify(m));
}

// M3 — no `.meta.json` at all. Pi children and shell-spawned children have none,
// and that is not a failure: it is the ordinary case for everything #137 does
// not cover. The caller must be able to tell "no meta" from "broken meta"
// without a try/catch, so both are `null` and neither throws.
{
	const t = subagent("meta-less-child", null);
	let threw = false;
	let m: unknown;
	try { m = readSubagentMeta(t); } catch { threw = true; }
	assert("M3 a transcript with no meta does not throw", !threw);
	assert("M3 it returns null, so the caller renders what it renders today", m === null);
}

// M4 — unparseable. A meta half-written by a killed harness, or truncated.
{
	const t = subagent("broken-json-child", '{"agentType":"general-purpose","desc');
	fixtureWrote("M4", t);
	let threw = false;
	let m: unknown;
	try { m = readSubagentMeta(t); } catch { threw = true; }
	assert("M4 unparseable JSON does not throw", !threw);
	assert("M4 it returns null", m === null);
}

// M5 — a REQUIRED field missing, and the required set is TWO, not four.
//
// It was four until the local audit round. The census behind that globbed two
// path segments then `subagents/`, so it never saw `subagents/workflows/wf_<id>/`
// — the Dynamic Workflow children, which carry only `{agentType, spawnDepth}`.
// 48 of 493 files on this host. Every one was declined WHOLE, and `null` is
// defined for consumers as "this harness wrote no record", so the report claimed
// an absence that was not there while two usable fields sat on disk.
{
	const full = {
		agentType: "general-purpose", description: "d",
		toolUseId: "toolu_x", spawnDepth: 1,
	} as Record<string, unknown>;
	for (const missing of ["agentType", "spawnDepth"]) {
		const partial = { ...full };
		delete partial[missing];
		const t = subagent(`missing-${missing}`, partial);
		fixtureWrote(`M5 ${missing}`, t);
		assert(`M5 a meta with no \`${missing}\` is declined, not half-read`,
			readSubagentMeta(t) === null, JSON.stringify(readSubagentMeta(t)));
	}
	// The other direction, which is the bug: these must NOT be declined.
	for (const missing of ["description", "toolUseId"]) {
		const partial = { ...full };
		delete partial[missing];
		const t = subagent(`optional-${missing}`, partial);
		fixtureWrote(`M5b ${missing}`, t);
		const m = readSubagentMeta(t);
		assert(`M5b a meta with no \`${missing}\` still PARSES — it is absent on 48 of 493 real files`,
			m !== null, `got null for ${JSON.stringify(partial)}`);
		assert(`M5b and the field it does not have is \`undefined\`, not invented`,
			m !== null && (m as Record<string, unknown>)[missing] === undefined);
	}
}

// M5c — the exact shape the workflow children carry, and the count that made it
// worth changing the guard for.
{
	const t = subagent("workflow-child", { agentType: "workflow-subagent", spawnDepth: 1 });
	fixtureWrote("M5c", t);
	const m = readSubagentMeta(t);
	assert("M5c a meta with neither `description` nor `toolUseId` — the Dynamic Workflow shape — parses",
		m !== null, JSON.stringify(m));
	assert("M5c and keeps both fields it does have",
		m?.agentType === "workflow-subagent" && m?.spawnDepth === 1);
	assert("M5c while the two it lacks stay undefined rather than empty strings",
		m?.description === undefined && m?.toolUseId === undefined);
}

// M6 — right names, wrong types. `spawnDepth: "1"` is a harness change, not a
// depth, and a check that only tested presence would carry the string straight
// into arithmetic.
{
	const t = subagent("string-depth-child", {
		agentType: "general-purpose", description: "d",
		toolUseId: "toolu_y", spawnDepth: "1",
	});
	fixtureWrote("M6", t);
	assert("M6 `spawnDepth` as a string is declined", readSubagentMeta(t) === null);

	const t2 = subagent("array-meta-child", [1, 2, 3]);
	fixtureWrote("M6 array", t2);
	// Declined BY the `Array.isArray` guard, which fires first: the shape check is
	// one short-circuited OR — `obj === null || typeof obj !== "object" ||
	// Array.isArray(obj)` — so an array returns before any field is looked at.
	assert("M6 a JSON array is declined by the Array.isArray guard, before any field check",
		readSubagentMeta(t2) === null);

	// The dead `const t3 = subagent("null-meta-child", null as never); void t3;`
	// is gone: `null` in the helper means WRITE NO META, so it built a meta-less
	// transcript nothing read and then discarded it, while reading as though the
	// bare-null case were covered twice.
	const tNull = subagent("literal-null-child", "null");
	fixtureWrote("M6 bare null", tNull);
	assert("M6 a bare `null` document is declined", readSubagentMeta(tNull) === null);
}

const CORPUS_DIR = path.join(import.meta.dirname, "fixtures", "meta-corpus");
function corpusFiles(): string[] {
	try {
		return fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith(".meta.json")).sort().map(f => path.join(CORPUS_DIR, f));
	} catch { return []; }
}

// M7 — THE FIELD-NAME PIN, in two halves that catch two different drifts.
//
// `.meta.json` is UNDOCUMENTED harness output. If a release renames
// `description` to `label`, every guard above still returns null, every caller
// still degrades politely, and the report goes back to showing hashes with
// nothing reporting the regression.
//
// Two halves, each honest about its subject:
{
	// TWO, not four — see M5. `description` and `toolUseId` are near-universal
	// (445/493 on this host) and absent on every Dynamic Workflow child.
	const REQUIRED = ["agentType", "spawnDepth"];
	const NEAR_UNIVERSAL = ["description", "toolUseId"];

	// M7a — the READER's names, against a hand-authored fixture. Catches a
	// wtft-side edit that drops or renames a required field. Says nothing about
	// the harness.
	const t = subagent("pin-child", {
		agentType: "general-purpose",
		description: "the words typed at dispatch",
		toolUseId: "toolu_pin",
		spawnDepth: 1,
	});
	assert("M7a the two required field names still parse", readSubagentMeta(t) !== null);
	for (const k of REQUIRED) {
		const dropped = {
			agentType: "general-purpose", description: "d", toolUseId: "toolu_pin", spawnDepth: 1,
		} as Record<string, unknown>;
		delete dropped[k];
		assert(`M7a \`${k}\` is load-bearing — dropping it changes the answer`,
			readSubagentMeta(subagent(`pin-drop-${k}`, dropped)) === null);
	}
	// The near-universal pair must be READ when present — otherwise making them
	// optional would quietly become making them ignored.
	for (const k of NEAR_UNIVERSAL) {
		const only = {
			agentType: "general-purpose", spawnDepth: 1, [k]: "carried",
		} as Record<string, unknown>;
		const m = readSubagentMeta(subagent(`pin-keep-${k}`, only));
		assert(`M7a \`${k}\` is still CARRIED when the harness writes it`,
			m !== null && (m as Record<string, unknown>)[k] === "carried",
			JSON.stringify(m));
	}

	// M7b — THE HARNESS's names, against a REAL `.meta.json` on this host. This
	// is the half that can see a rename, because its input is the harness's
	// output rather than ours. It is host-gated, so it SKIPS VISIBLY where there
	// is none (CI has no `~/.claude`): a check that silently passed having read
	// nothing is the coverage claim this repo's skip contract exists to refuse.
	// NEWEST by mtime, over a RECURSIVE walk. The first version took
	// `metas[0]` from the first session that had any — `readdir` order, no
	// mtime — and the local audit measured it selecting a file from
	// 2026-09-15 out of a corpus running to today. A rename shipped in the
	// current release leaves 400+ old files on disk, so an arbitrary sample
	// keeps passing while every label in the report goes blank. That is the
	// same defect M7a was split off for, one level up.
	//
	// Recursive also matters: the flat `<session>/subagents` walk could never
	// draw a `subagents/workflows/wf_<id>/` child, which is the shape M5c is
	// about.
	const real = (() => {
		const base = path.join(os.homedir(), ".claude", "projects");
		let best: { file: string; mtime: number } | null = null;
		const walk = (dir: string, depth: number): void => {
			if (depth > 6) return;
			let entries: fs.Dirent[] = [];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) { walk(full, depth + 1); continue; }
				if (!e.name.endsWith(".meta.json")) continue;
				try {
					const m = fs.statSync(full).mtimeMs;
					if (!best || m > best.mtime) best = { file: full, mtime: m };
				} catch { /* raced away */ }
			}
		};
		walk(base, 0);
		return best;
	})();

	if (!real) {
		skip("M7b no real .meta.json on this host — the harness field names were NOT checked against harness output");
	} else {
		const realFile: string = real.file;
		const age = new Date(real.mtime).toISOString();
		let obj: Record<string, unknown> | null = null;
		try { obj = JSON.parse(fs.readFileSync(realFile, "utf8")); } catch { /* assertion below owns it */ }
		// The label carries the mtime on purpose: a PASS that says WHEN its
		// evidence was written is auditable; one that does not is a claim.
		assert(`M7b the NEWEST real harness .meta.json parses (${path.basename(realFile)}, written ${age})`, obj !== null, realFile);
		if (obj) {
			for (const k of REQUIRED) {
				assert(`M7b the harness still writes \`${k}\` — a rename fails HERE`,
					k in obj,
					`${realFile} has keys ${JSON.stringify(Object.keys(obj))} — the harness renamed or dropped \`${k}\`, and every label in the report just went blank`);
			}
			// NOT asserted as required: a workflow child legitimately has neither,
			// and this picker can now draw one. Reported so a rename of the pair
			// is still VISIBLE in the output rather than silently tolerated.
			const carried = NEAR_UNIVERSAL.filter(k => k in (obj as Record<string, unknown>));
			assert(`M7b and it carries ${carried.length} of the 2 near-universal names (${JSON.stringify(carried)}) — 0 is legitimate only for a workflow child (agentType=${JSON.stringify((obj as Record<string, unknown>).agentType)})`,
				carried.length === 2 || (obj as Record<string, unknown>).agentType === "workflow-subagent",
				`${realFile} keys ${JSON.stringify(Object.keys(obj))}`);
			// And end to end: the reader accepts the harness's OWN file, not just
			// our fixture of it. This is the assertion that would catch a value
			// whose TYPE changed while its name stayed — `spawnDepth: "1"`.
			const realMeta = readSubagentMeta(realFile.replace(/\.meta\.json$/, ".jsonl"));
			assert("M7b and the reader accepts the harness's own file, types and all",
				realMeta !== null,
				`readSubagentMeta declined ${realFile} although every required name is present — a value's TYPE changed`);
			// The corpus M7c reads everywhere is a snapshot; this is what says it aged.
			const corpusKeys = new Set(corpusFiles().flatMap(f => {
				try { return Object.keys(JSON.parse(fs.readFileSync(f, "utf8"))); } catch { return []; }
			}));
			const uncovered = Object.keys(obj).filter(k => !corpusKeys.has(k));
			assert(`M7b the committed corpus carries every key the newest real file does (${JSON.stringify(Object.keys(obj))})`,
				uncovered.length === 0,
				`${realFile} carries ${JSON.stringify(uncovered)}, which no file in tests/fixtures/meta-corpus/ has — refresh the corpus: tests/fixtures/meta-corpus/README.md`);
		}
	}

	// M7c — THE HARNESS's names, against the committed corpus of real files.
	// Runs on every host, CI included, which M7b cannot.
	const corpus = corpusFiles();
	const OPTIONAL_CARRIED = ["description", "toolUseId", "model", "parentAgentId", "isFork"];
	const CORPUS = ["agent-a12b520b52dfc5d2a", "agent-a170388e12a7fa3bc", "agent-a20ea0d14166e9999", "agent-a9b6ca6692517846a",
		"agent-ab7a653fd7de39292", "agent-ace7ef5933e128a87", "agent-aed7cbd64d6f241d1"].map(b => `${b}.meta.json`);
	assert(`M7c the committed corpus is the seven files CORPUS lists`,
		JSON.stringify(corpus.map(f => path.basename(f))) === JSON.stringify(CORPUS),
		JSON.stringify(corpus.map(f => path.basename(f))));
	// Every key in the corpus is one the reader carries or one it knowingly
	// ignores, so a rename brought in by a refresh fails here rather than
	// leaving a field silently unread.
	const CARRIED = [...REQUIRED, ...OPTIONAL_CARRIED];
	const IGNORED = ["requestShape", "requestNonInteractive", "name", "cwd"];
	for (const file of corpus) {
		let keys: string[] = [];
		try { keys = Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* M7c parse check owns it */ }
		const unknown = keys.filter(k => !CARRIED.includes(k) && !IGNORED.includes(k));
		assert(`M7c ${path.basename(file)} has no key the reader neither carries nor knowingly ignores`,
			unknown.length === 0, `unknown ${JSON.stringify(unknown)} — carry it in parseSubagentMeta or add it to IGNORED`);
	}
	for (const file of corpus) {
		const name = path.basename(file);
		let obj: Record<string, unknown> | null = null;
		try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* assertion below owns it */ }
		assert(`M7c ${name} parses as JSON`, obj !== null, file);
		if (!obj) continue;
		for (const k of REQUIRED) {
			assert(`M7c ${name} carries \`${k}\``, k in obj, `keys ${JSON.stringify(Object.keys(obj))}`);
		}
		if (obj.agentType !== "workflow-subagent") {
			const missing = NEAR_UNIVERSAL.filter(k => !(k in (obj as Record<string, unknown>)));
			assert(`M7c ${name} carries the near-universal pair`, missing.length === 0, `missing ${JSON.stringify(missing)}`);
		}
		const meta = readSubagentMeta(file.replace(/\.meta\.json$/, ".jsonl")) as Record<string, unknown> | null;
		assert(`M7c ${name} is accepted by the reader, types and all`, meta !== null, file);
		for (const k of OPTIONAL_CARRIED) {
			if (!(k in obj)) continue;
			assert(`M7c ${name} \`${k}\` survives the reader`, meta?.[k] === obj[k],
				`corpus ${JSON.stringify(obj[k])}, reader ${JSON.stringify(meta?.[k])}`);
		}
	}
}

// M8 — `parentAgentId`, which is the finding the issue did not have.
//
// It appeared on exactly the files with `spawnDepth > 1` — 25 of 439 here, 0
// mismatches either way, and all 25 resolving to a sibling `agent-*.jsonl`. So a
// subagent's parent is a RECORD at every depth, not only at the top: strictly
// more than #116's ledger reconstructs for this class of child, and already on
// disk.
//
// THAT CORRELATION IS THE HARNESS'S BEHAVIOUR, NOT OURS, and the assertions
// below do not pin it — they pin that the READER carries the field when it is
// there and leaves it undefined when it is not. Pinning the correlation would
// mean failing the build when a future release starts writing `parentAgentId` at
// depth 1, which would be reporting a correct change as a defect.
{
	const t = subagent("deep-child", {
		agentType: "general-purpose", description: "a subagent's subagent",
		toolUseId: "toolu_deep", spawnDepth: 2,
		parentAgentId: "aaf0bdce9cfa3e0d6",
	});
	const m = readSubagentMeta(t);
	assert("M8 `parentAgentId` is carried", m?.parentAgentId === "aaf0bdce9cfa3e0d6", JSON.stringify(m));
	assert("M8 alongside the depth that explains it", m?.spawnDepth === 2, JSON.stringify(m));

	const shallow = readSubagentMeta(subagent("shallow-child", {
		agentType: "general-purpose", description: "top-level", toolUseId: "toolu_top", spawnDepth: 1,
	}));
	assert("M8 and is undefined at depth 1, where the parent is the session itself",
		shallow !== null && shallow.parentAgentId === undefined, JSON.stringify(shallow));
}

// ---
// § R — THE CLOSER: the real CLI, `--json`, a session with a Task subagent
// ---
//
// M1-M8 pin the reader. They cannot catch a reader that is right in isolation
// and never wired to anything, which is the failure mode that left this file
// unread for the whole life of the project: it was on disk, it parsed, and no
// code path asked for it.
//
// SCOPE. This suite covers the `--json` half only. The render half — showing
// the description in place of `agent-<hash>` in #116's SPAWNED block — is #137,
// still open; see docs/spec-137-subagent-meta.md for why the split stands.

console.log("\n§ R — the Closer: `wtft --json` names its subagents\n");

{
	const projects = path.join(root, "projects");
	const slug = path.join(projects, "-home-princess-pi-demo");
	const sessionId = "11111111-2222-3333-4444-555555555555";
	const sessionPath = path.join(slug, `${sessionId}.jsonl`);
	const subDir = path.join(slug, sessionId, "subagents");
	fs.mkdirSync(subDir, { recursive: true });

	const turn = (id: string) => JSON.stringify({
		type: "assistant",
		// Top level, beside `type` — where real transcripts put it.
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			usage: { input_tokens: 1200, output_tokens: 90 },
			content: [{ type: "text", text: "work" }],
		},
	}) + "\n";

	fs.writeFileSync(sessionPath, turn("msg_parent_1"));

	// One child WITH a meta — the labelled case.
	const namedChild = path.join(subDir, "agent-a641e532bfaae9903.jsonl");
	fs.writeFileSync(namedChild, turn("msg_child_1"));
	fs.writeFileSync(path.join(subDir, "agent-a641e532bfaae9903.meta.json"), JSON.stringify({
		agentType: "general-purpose",
		description: "Fix 116 prose drift, grep-verified",
		toolUseId: "toolu_014xWPgGcSUHnLejKyXB1947",
		spawnDepth: 1,
		model: "sonnet",
	}));

	// One child WITHOUT — the case that must keep behaving exactly as it did.
	const bareChild = path.join(subDir, "agent-bbbbbbbbbbbbbbbbb.jsonl");
	fs.writeFileSync(bareChild, turn("msg_child_2"));

	// Pre-populate the tag, so this reaches the REPORT path.
	//
	// WHY (local audit round). R1 is labelled THE CLOSER and it was landing on
	// the `no-data` arm: `total.costUsd` 0, `models` [], one `no-data` notice.
	// So R1's subagent rows were asserted against a document that counted
	// nothing, and R1 would have kept passing if the daemon had stopped
	// producing tags altogether.
	//
	// This tag carries `msg_parent_1` ONLY — the parent's turn. Neither child's
	// turn is in it, so `total.costUsd > 0` below proves the REPORT path and
	// nothing about a child's cost reaching `total`. A populated tag also
	// avoids the no-data arm (exit 1), which would abort the suite.
	const classified = (id: string, tsMs: number) => JSON.stringify({
		t: tsMs, c: 0.0123, cat: "code", f: [], cmd: [],
		id, m: "claude-sonnet-4-6", in: 1200, out: 90,
	}) + "\n";
	const tagsDir = path.join(slug, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	fs.writeFileSync(
		path.join(tagsDir, `${sessionId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		classified("msg_parent_1", Date.now() - 60_000)
		+ JSON.stringify({ _meta: { offset: fs.statSync(sessionPath).size, swept: Date.now() - 60_000 } }) + "\n");

	const out = runWtftCli(`node ${JSON.stringify(CLI_BIN)} -s ${JSON.stringify(sessionPath)} --json`, {
		env: { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: projects },
	});

	let doc: any = null;
	try { doc = JSON.parse(out); } catch { /* R1's first assertion owns this */ }
	assert("R1 `--json` emitted one parseable document", doc !== null, out.slice(0, 400));
	// THE PRECONDITION. Without it R1 asserts its subagent rows against a
	// document that counted nothing, and says so to nobody.
	if (doc) {
		assert("R1 fixture precondition: this is the REPORT path, not the `no-data` arm",
			!(doc.notices ?? []).some((n: any) => n.code === "no-data"),
			`notices=${JSON.stringify(doc.notices)}`);
		assert("R1 fixture precondition: the session costs something, so the rows below are asserted against a document that counted SOMETHING (the parent; no child turn is in this tag)",
			doc.total?.costUsd > 0, `total=${JSON.stringify(doc.total)}`);
	}

	if (doc) {
		assert("R1 the document carries a `subagents` array", Array.isArray(doc.subagents),
			JSON.stringify(Object.keys(doc)));
		const rows: any[] = doc.subagents ?? [];
		assert(`R1 both children are listed (${rows.length})`, rows.length === 2,
			JSON.stringify(rows.map(r => path.basename(r.transcript))));

		const named = rows.find(r => r.transcript.includes("a641e532bfaae9903"));
		assert("R1 the labelled child carries its meta", named?.meta != null, JSON.stringify(named));
		assert("R1 `description` — the words typed at dispatch, not a hash",
			named?.meta?.description === "Fix 116 prose drift, grep-verified", JSON.stringify(named));
		assert("R1 `toolUseId` — the parent link, read rather than inferred",
			named?.meta?.toolUseId === "toolu_014xWPgGcSUHnLejKyXB1947", JSON.stringify(named));
		assert("R1 `model` — which makes the #504 downshift auditable from the report",
			named?.meta?.model === "sonnet", JSON.stringify(named));

		// R1b — AN UNREADABLE SUBAGENTS DIRECTORY OMITS THE KEY, never emits `[]`.
		//
		// `[]` means "looked, found none". A discovery failure is "nobody looked,
		// or looked and could not see", and emitting an empty array for it hands a
		// consumer a partial result presented as complete — the exact confusion
		// this document's absent-versus-empty rule exists to prevent, committed by
		// the code that states the rule.
		{
			const blindDir = path.join(slug, sessionId, "subagents");
			let chmodded = false;
			try { fs.chmodSync(blindDir, 0o000); chmodded = true; } catch { /* best effort */ }
			const unreadable = chmodded && (() => { try { fs.readdirSync(blindDir); return false; } catch { return true; } })();
			if (!unreadable) {
				skip("R1b could not make the subagents dir unreadable (running as root?) — the omit-on-failure path was NOT checked");
			} else {
				const out2 = runWtftCli(`node ${JSON.stringify(CLI_BIN)} -s ${JSON.stringify(sessionPath)} --json`, {
					env: { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: projects },
				});
				let d2: any = null;
				try { d2 = JSON.parse(out2); } catch { /* assertion owns it */ }
				assert("R1b the document still parses with an unreadable subagents dir", d2 !== null, out2.slice(0, 300));
				if (d2) {
					assert("R1b `subagents` is ABSENT, not an empty array",
						!("subagents" in d2),
						`subagents = ${JSON.stringify(d2.subagents)} — an empty list reads as "spawned nothing"`);
					assert("R1b and provisional still names the real reason",
						d2.provisional?.reason === "subagent-unreadable",
						JSON.stringify(d2.provisional));
				}
			}
			try { fs.chmodSync(blindDir, 0o755); } catch { /* best effort */ }
		}

		// The no-meta child. `meta: null` is a GAP, not an absence of cost: the
		// transcript is still there and still counted, it simply has no label.
		const bare = rows.find(r => r.transcript.includes("bbbbbbbbbbbbbbbbb"));
		assert("R1 a child with no meta is still LISTED, with its transcript",
			bare !== undefined && typeof bare.transcript === "string", JSON.stringify(rows));
		assert("R1 and its meta is null — a gap, not a dropped subagent",
			bare?.meta === null, JSON.stringify(bare));
	}
}

// --- R1c: `[]` means "looked, found none" — the half nothing pinned ---
//
// The contract is asserted in prose at two layers:
//   spec-26-json.md  "An empty array therefore always means 'looked, found
//                     none' — never 'nobody looked'."
//   spec-137         "an empty array from a caller that never looked is
//                     indistinguishable from a session that spawned nothing"
//
// R1b pins the ABSENT half. This pins the PRESENT half: an empty array still
// emits the key.
//
// Two shapes, because they reach the emitter differently: no `subagents/`
// directory at all, and one that exists and is empty.
{
	const mk = (name: string, makeSubDir: boolean) => {
		const projects = path.join(root, `r1c-${name}`, "projects");
		const slug = path.join(projects, "-home-princess-pi-demo");
		const sessionId = `9999${name.length}999-2222-3333-4444-55555555555${name.length}`;
		const sessionPath = path.join(slug, `${sessionId}.jsonl`);
		fs.mkdirSync(slug, { recursive: true });
		if (makeSubDir) fs.mkdirSync(path.join(slug, sessionId, "subagents"), { recursive: true });
		const t = Date.now() - 60_000;
		fs.writeFileSync(sessionPath, JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant", id: `msg_${name}`, model: "claude-sonnet-4-6",
				timestamp: new Date(t).toISOString(),
				usage: { input_tokens: 1200, output_tokens: 90 },
				content: [{ type: "text", text: "work" }],
			},
		}) + "\n");
		const tagsDir = path.join(slug, "wtft-tags");
		fs.mkdirSync(tagsDir, { recursive: true });
		fs.writeFileSync(path.join(tagsDir, `${sessionId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
			JSON.stringify({ t, c: 0.0123, cat: "code", f: [], cmd: [], id: `msg_${name}`, m: "claude-sonnet-4-6", in: 1200, out: 90 }) + "\n"
			+ JSON.stringify({ _meta: { offset: fs.statSync(sessionPath).size, swept: t } }) + "\n");
		const out = runWtftCli(`node ${JSON.stringify(CLI_BIN)} -s ${JSON.stringify(sessionPath)} --json`, {
			env: { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: projects },
		});
		try { return JSON.parse(out); } catch { return null; }
	};

	for (const [label, makeSubDir] of [["no subagents directory at all", false], ["an EMPTY subagents directory", true]] as const) {
		const doc = mk(makeSubDir ? "empty" : "none", makeSubDir);
		assert(`R1c (${label}) the document parses`, doc !== null);
		if (!doc) continue;
		// The precondition: this must be the report path, or the assertions below
		// are about the pending arm and prove nothing about discovery.
		assert(`R1c (${label}) fixture precondition: the report path, not \`no-data\``,
			!(doc.notices ?? []).some((n: any) => n.code === "no-data"), JSON.stringify(doc.notices));
		assert(`R1c (${label}) the key is PRESENT — discovery ran and found none`,
			"subagents" in doc, `keys=${JSON.stringify(Object.keys(doc))}`);
		assert(`R1c (${label}) and it is an EMPTY ARRAY, never omitted`,
			Array.isArray(doc.subagents) && doc.subagents.length === 0, JSON.stringify(doc.subagents));
		// The whole point: this state must be DISTINGUISHABLE from the failure
		// state R1b pins. If both omitted the key, a consumer could not tell
		// "spawned nothing" from "could not look".
		assert(`R1c (${label}) so it is distinguishable from the unreadable case, which omits the key`,
			doc.provisional?.reason !== "subagent-unreadable", JSON.stringify(doc.provisional));
	}
}


console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}\n`);
if (failed > 0) process.exit(1);
