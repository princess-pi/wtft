/**
 * @package wtft
 * @module research/other-corpus/shape-frequency
 * @description How often does a given command SHAPE actually occur? (#106)
 *
 * The classifier exists to give directional hints about where tokens go — a
 * category should move visibly when the work moves. It is not a shell, and the
 * agents writing these commands have habits rather than adversarial intent. So
 * a parser gap only matters if the shape it misses is a shape that HAPPENS.
 *
 * This counts each shape across every bash command in the transcript corpus, so
 * a review finding can be answered with "N occurrences in M sessions" instead
 * of with judgement. Zero occurrences is a decisive argument for postponing.
 *
 * Usage: bun research/other-corpus/shape-frequency.ts [--sessions N]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";

const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf("--sessions") + 1]) || 4000;

/** Each shape: the finding it answers, and a test over one raw command string. */
const SHAPES: { id: string; what: string; test: (c: string) => boolean }[] = [
	{ id: "F1  subshell group", what: "( cmd; cmd ) as a command", test: c => /(?:^|[;&|]\s*)\(\s*\w/.test(c) },
	{ id: "F15 subshell spawn", what: "( cd X && claude -p )", test: c => /\(\s*cd\s[^)]*claude\s+-/.test(c) },
	{ id: "F2  function NAME {", what: "multiline f() then { on next line", test: c => /\w+\s*\(\s*\)\s*\n\s*\{/.test(c) },
	{ id: "F3  heredoc delim -", what: "<<DELIM with non-identifier chars", test: c => /<<-?\s*[A-Za-z_][A-Za-z0-9_]*[^A-Za-z0-9_\s'\"]/.test(c) },
	{ id: "F4  bare & separator", what: "cmd & othercmd (background then more)", test: c => /(?<![0-9>&|])&(?![&>])\s*\S/.test(c.replace(/\d?>&\d?/g, "").replace(/&>/g, "")) },
	{ id: "F5  >& to a filename", what: "redirect >& file (not a descriptor)", test: c => />&\s*[A-Za-z._/~]/.test(c) },
	{ id: "F9  2+ heredocs, 1 line", what: "two << openers before a newline", test: c => (c.split("\n", 1)[0]!.match(/<<[^<]/g) || []).length >= 2 },
	{ id: "F10 delim + whitespace", what: "heredoc terminator line with trailing space", test: c => /\n[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+\n/.test(c) },
	{ id: "F11 short-circuit read", what: "false && / true || guarding a command", test: c => /(?:^|\s)(?:false\s*&&|true\s*\|\|)\s*\S/.test(c) },
	{ id: "F12 cd good then cd $VAR", what: "a literal cd followed by a dynamic cd", test: c => /cd\s+[^\s$`;&|]+[\s\S]{0,200}?cd\s+["']?[$`]/.test(c) },
	{ id: "F13 sed -i.bak", what: "sed -i with attached suffix or --in-place", test: c => /\bsed\s+(?:-\S+\s+)*(?:-i\S+|--in-place)/.test(c) },
	{ id: "F14 brace in heredoc", what: "function body whose heredoc contains {", test: c => /\w+\(\)\s*\{[\s\S]*<<[\s\S]*\{/.test(c) },
];

const counts = new Map<string, number>(SHAPES.map(s => [s.id, 0]));
const examples = new Map<string, string>();

const files = execSync(`find ${process.env.HOME}/.claude/projects ${process.env.HOME}/.pi/agent/sessions -name '*.jsonl' 2>/dev/null || true`,
	{ encoding: "utf8", maxBuffer: 1e9 }).trim().split("\n").filter(Boolean).slice(0, N);

let commands = 0, sessions = 0;
for (const f of files) {
	let txt: string;
	try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
	sessions++;
	for (const line of txt.split("\n")) {
		if (!line.includes('"command"')) continue;
		let e: any;
		try { e = JSON.parse(line); } catch { continue; }
		const content = e?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const b of content) {
			const cmd = b?.input?.command ?? b?.arguments?.command;
			if (typeof cmd !== "string" || !cmd) continue;
			commands++;
			for (const s of SHAPES) {
				let hit = false;
				try { hit = s.test(cmd); } catch { /* a regex that cannot run is a miss */ }
				if (!hit) continue;
				counts.set(s.id, counts.get(s.id)! + 1);
				if (!examples.has(s.id)) examples.set(s.id, cmd.slice(0, 120).replace(/\n/g, "\\n"));
			}
		}
	}
}

console.log(`${commands} bash commands across ${sessions} transcripts\n`);
console.log(`${"shape".padEnd(24)}${"hits".padStart(7)}  ${"per 10k".padStart(8)}  what`);
for (const s of SHAPES) {
	const n = counts.get(s.id)!;
	const rate = commands ? (n / commands * 10000).toFixed(1) : "0";
	console.log(`${s.id.padEnd(24)}${String(n).padStart(7)}  ${rate.padStart(8)}  ${s.what}`);
	const ex = examples.get(s.id);
	if (ex) console.log(`${" ".repeat(24)}         e.g. ${ex}`);
}
