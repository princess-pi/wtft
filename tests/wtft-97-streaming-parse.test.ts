#!/usr/bin/env -S bun
/**
 * Parsing a transcript in chunks: same output, bounded memory.
 * Spec: docs/spec-97-streaming-parse.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("97-streaming-parse");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-97-")));
// Nested `claude -p` discovery must never see the real projects tree.
process.env.WTFT_CLAUDE_PROJECTS_DIR = path.join(dir, "projects");

function turn(i: number, text: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "assistant", timestamp: new Date(Date.UTC(2026, 8, 22, 5, 0, i)).toISOString(), cwd: "/tmp/x",
		message: {
			role: "assistant", id: `m-${i}`, model: "claude-opus-5",
			content: [{ type: "text", text }],
			usage: { input_tokens: 10 + i, output_tokens: 100 + i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		...extra,
	});
}

// ---
// PART E — the same interactions at any chunk size
// ---
console.log("\nPART E — output does not depend on where chunks fall");
{
	const file = path.join(dir, "mixed.jsonl");
	const lines = [
		turn(0, "plain"),
		"",
		"{not json",
		turn(1, "emoji 😀 and accents é ü — multi-byte on purpose"),
		JSON.stringify({ type: "model_change", modelId: "claude-sonnet-5" }),
		turn(2, "日本語のテキスト".repeat(40)),
		turn(3, "last line has no newline"),
	];
	fs.writeFileSync(file, lines.join("\n"));
	// The baseline: one chunk holding the whole fixture (well under 1 MiB), i.e. a single
	// read of the entire file split on newlines — what the old whole-string read did.
	const baseline = JSON.stringify(parseSessionFile(file));
	check(JSON.parse(baseline).length === 4, `E1 fixture precondition: the single-chunk baseline finds the 4 turns (got ${JSON.parse(baseline).length})`);
	for (const chunk of [1, 3, 7, 64, 1000]) {
		const chunked = JSON.stringify(parseSessionFile(file, new Set(), chunk));
		check(chunked === baseline, `E2 chunk size ${chunk}: identical interactions to the single-chunk baseline`);
	}
	const truncated = path.join(dir, "truncated.jsonl");
	fs.writeFileSync(truncated, lines.slice(0, 4).join("\n") + "\n" + turn(9, "cut off").slice(0, 40));
	check(JSON.stringify(parseSessionFile(truncated, new Set(), 5)) === JSON.stringify(parseSessionFile(truncated)),
		"E3 a truncated last line is dropped the same way at any chunk size");
}

// ---
// PART R — an invalid chunkBytes throws, never a silent empty parse
// ---
console.log("\nPART R — chunkBytes must be a positive safe integer");
{
	const file = path.join(dir, "reject.jsonl");
	fs.writeFileSync(file, turn(0, "x"));
	for (const bad of [0, -1, NaN, 1.5]) {
		let threw: unknown = null;
		try { parseSessionFile(file, new Set(), bad); } catch (e) { threw = e; }
		check(threw instanceof RangeError, `R chunkBytes ${bad} throws RangeError (got ${threw})`);
	}
}

// ---
// PART M — peak memory does not scale with the file
// ---
console.log("\nPART M — a ~40 MB transcript parses without holding it several times over");
{
	const big = path.join(dir, "big.jsonl");
	const fd = fs.openSync(big, "w");
	const pad = "x".repeat(4000);
	let bytes = 0;
	for (let i = 0; bytes < 40 * 1024 * 1024; i++) {
		// Most bytes are in lines that are not turns, as in a real transcript
		// full of tool results; one turn in fifty keeps the interaction list small.
		const line = (i % 50 === 0 ? turn(i, "t") : JSON.stringify({ type: "user", message: { content: pad } })) + "\n";
		fs.writeSync(fd, line);
		bytes += line.length;
	}
	fs.closeSync(fd);
	const script = `
		const { parseSessionFile } = await import(${JSON.stringify(path.resolve(import.meta.dirname, "..", "extensions", "lib", "wtft-parser.ts"))});
		const before = process.resourceUsage().maxRSS;
		const n = parseSessionFile(${JSON.stringify(big)}).length;
		console.log(JSON.stringify({ n, beforeKb: before, afterKb: process.resourceUsage().maxRSS }));
	`;
	const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env } });
	const out = JSON.parse((r.stdout || "{}").trim().split("\n").pop() || "{}");
	const grewMb = (out.afterKb - out.beforeKb) / 1024;
	check(out.n > 0, `M1 fixture precondition: the parse found turns (got ${out.n}; stderr ${(r.stderr || "").slice(0, 200)})`);
	check(grewMb < 20, `M2 peak RSS grows by under half the file's size (the old whole-string read grew about 49 MB; this grew ${grewMb.toFixed(1)} MB for a 40 MB file)`);
}

// ---
// PART L — one very long line costs linear time, not quadratic
// ---
console.log("\nPART L — a 4 MB single line at a 1 KB chunk size");
{
	const long = path.join(dir, "long-line.jsonl");
	fs.writeFileSync(long, turn(0, "y".repeat(4 * 1024 * 1024)) + "\n" + turn(1, "after"));
	const t0 = performance.now();
	const out = parseSessionFile(long, new Set(), 1024);
	const ms = performance.now() - t0;
	check(out.length === 2, `L1 both turns parse, the long one intact (got ${out.length})`);
	check(ms < 3000, `L2 a 4 MB line read in 1 KB chunks parses in linear time, well inside 3 s (took ${Math.round(ms)} ms)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
