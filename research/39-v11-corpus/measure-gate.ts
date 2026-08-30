#!/usr/bin/env bun
/**
 * research/39-v11-corpus/measure-gate.ts — pick V11's numbers from data (#39).
 *
 * V11 asserted cold discovery within a constant multiple of the memoised pass.
 * That bound broke 6 runs in 6, because cold scales with the LIVE corpus while
 * warm is cache hits — so the ratio grows without bound as `pr-cleanup` strands
 * more sessions. A constant multiple of a memoised call cannot bound an
 * unmemoised one.
 *
 * The fix is to let the TEST own the corpus. This probe measures what the #164
 * gate is actually worth on a corpus we build, so the replacement assertion's
 * threshold comes from a measurement rather than a guess.
 *
 * live     = recorded cwd EXISTS  -> gate closed -> 8 KB tail read (TAIL_WINDOWS[0])
 * stranded = recorded cwd is gone -> gate open   -> resolveCwdHistory whole-file read
 *
 * OUTCOME (2026-08-30): this probe did its job and then argued itself out of the
 * test. Measured on this host: 250 files x 256 KB -> live 6-15ms, stranded
 * 31-84ms, ratio 4.9-5.6x (128 KB x 300 -> 2.5-3.3x; 512 KB x 200 -> 7.6-8.7x).
 * A timing ratio would have worked, but it still needs a threshold, and the
 * counters `getCwdHistoryReadCount()` / `getCwdReadCount()` measure the SAME
 * gate as an exact integer. So the shipped V11 asserts on those counters and
 * this file stays only for the number a counter cannot give: what the gate is
 * WORTH in wall-clock, which is the argument for keeping the gate at all.
 *
 * Run: bun research/39-v11-corpus/measure-gate.ts [fileKB] [count]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FILE_KB = Number(process.argv[2] || 128);
const COUNT = Number(process.argv[3] || 300);

const line = (text: string) => JSON.stringify({
	type: "assistant",
	message: {
		role: "assistant", id: "filler", model: "claude-sonnet-4-20250514",
		usage: { input_tokens: 10, output_tokens: 10 },
		content: [{ type: "text", text }],
	},
}) + "\n";

function buildCorpus(label: string, cwdFor: (i: number) => string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `wtft-39-${label}-`));
	const proj = path.join(root, "-home-synthetic-project");
	fs.mkdirSync(proj, { recursive: true });
	const filler = line("y".repeat(900));
	const body = filler.repeat(Math.ceil((FILE_KB * 1024) / filler.length));
	for (let i = 0; i < COUNT; i++) {
		const id = `39c0de00-1a9b-4c3d-9e8f-${String(i).padStart(12, "0")}`;
		// The cwd marker sits in the LAST line, inside the 8 KB tail window, so
		// both arms find it with one cheap read. Only what happens NEXT differs.
		fs.writeFileSync(path.join(proj, `${id}.jsonl`),
			body + JSON.stringify({ type: "user", cwd: cwdFor(i), message: { role: "user", content: "hi" } }) + "\n");
	}
	return root;
}

const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-39-livecwd-"));
const live = buildCorpus("live", () => liveDir);
const stranded = buildCorpus("stranded", (i) => `/home/princess-pi/NO-SUCH-DIR-${i}`);

async function timeDiscovery(projectsDir: string): Promise<number> {
	process.env.WTFT_CLAUDE_PROJECTS_DIR = projectsDir;
	process.env.WTFT_PI_SESSIONS_DIR = path.join(os.tmpdir(), "wtft-39-nopi");
	fs.mkdirSync(process.env.WTFT_PI_SESSIONS_DIR, { recursive: true });
	const mod: any = await import("../../bin/wtft.mjs");
	mod.resetCwdCache?.();
	const t0 = performance.now();
	mod.discoverSessions("claude-code", liveDir);
	return performance.now() - t0;
}

const rows: string[] = [];
for (let r = 0; r < 3; r++) {
	const l = await timeDiscovery(live);
	const s = await timeDiscovery(stranded);
	rows.push(`run ${r + 1}: live ${l.toFixed(0)}ms  stranded ${s.toFixed(0)}ms  ratio ${(s / l).toFixed(2)}x`);
}
console.log(`corpus: ${COUNT} files x ${FILE_KB} KB (tail window is 8 KB)`);
for (const r of rows) console.log(r);

for (const d of [live, stranded, liveDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
