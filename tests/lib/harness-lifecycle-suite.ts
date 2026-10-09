/** Fixture helpers shared by the harness lifecycle suites. */


import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { getCurrentVersionTagPath, readClassifiedTagFile } from "../../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./sandbox";

export const TMP = isolateTmpdir("239-lifecycle");

export const DAEMON = path.resolve(import.meta.dirname, "..", "..", "bin", "wtft-daemon.mjs");
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
export function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

export function turnLine(id: string, ts: number): string {
	return JSON.stringify({
		type: "assistant", timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "t" }],
		},
	}) + "\n";
}

export const TWO_DAYS_AGO = new Date(Date.now() - 2 * 86_400_000);

/** A root of `count` sessions last written two days ago. */
export function makeRoot(label: string, count: number): { root: string; files: string[] } {
	const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-239-${label}-`)));
	const files: string[] = [];
	for (let i = 0; i < count; i++) {
		const dir = path.join(root, `proj-${i % 20}`);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `s-${label}-${i}.jsonl`);
		fs.writeFileSync(file, turnLine(`${label}-${i}`, TWO_DAYS_AGO.getTime()));
		fs.utimesSync(file, TWO_DAYS_AGO, TWO_DAYS_AGO);
		files.push(file);
	}
	return { root, files };
}

export const envFor = (root: string) => ({
	...process.env,
	WTFT_DAEMON_DEBUG: "1",
	WTFT_CLAUDE_PROJECTS_DIR: root,
	WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi"),
});

export const pids: number[] = [];
/** `snapDir`: the daemon writes a heap snapshot there on SIGUSR2. */
export function start(root: string, args: string[], errName: string, snapDir?: string, extraEnv: Record<string, string> = {}): { pid: number; err: string } {
	const err = path.join(root, errName);
	const fd = fs.openSync(err, "a");
	const flags = snapDir ? ["--heapsnapshot-signal=SIGUSR2"] : [];
	const child = spawn("node", [...flags, DAEMON, ...args], { detached: true, stdio: ["ignore", "ignore", fd], env: { ...envFor(root), ...extraEnv }, cwd: snapDir });
	child.unref();
	fs.closeSync(fd);
	if (child.pid) pids.push(child.pid);
	return { pid: child.pid ?? 0, err };
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
export const harnessPidFile = (root: string) =>
	path.join(TMP, `wtft-harness-claude-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}.pid`);
export const leasesNaming = (pid: number) =>
	fs.readdirSync(TMP).filter(n => /^wtft-daemon-.*\.pid$/.test(n) && read(path.join(TMP, n)).trim() === String(pid)).length;
/** Live heap in MiB: a heap snapshot collects garbage first, so this is what
 *  the daemon retains, which RSS is not. */
export async function liveHeapMiB(pid: number, dir: string): Promise<number> {
	for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
	process.kill(pid, "SIGUSR2");
	let size = -1;
	for (let i = 0; i < 300; i++) {
		await sleep(200);
		const snap = fs.readdirSync(dir).find(f => f.endsWith(".heapsnapshot"));
		if (!snap) continue;
		const now = fs.statSync(path.join(dir, snap)).size;
		if (now > 0 && now === size) {
			const d = JSON.parse(fs.readFileSync(path.join(dir, snap), "utf8"));
			const fields = d.snapshot.meta.node_fields, n = fields.length, at = fields.indexOf("self_size");
			let t = 0;
			for (let k = at; k < d.nodes.length; k += n) t += d.nodes[k];
			return t / 1048576;
		}
		size = now;
	}
	return NaN;
}
export const classified = (file: string, id: string) => {
	try { return readClassifiedTagFile(getCurrentVersionTagPath(file)).some((r: { messageId?: string }) => r.messageId === id); }
	catch { return false; }
};

/** Harness processes serving `root`, found by command line and environment. */
export function harnessesFor(root: string): number[] {
	const out: number[] = [];
	for (const name of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		const cmd = read(`/proc/${name}/cmdline`).split("\0");
		if (!cmd.includes(DAEMON) || !cmd.includes("--harness")) continue;
		if (read(`/proc/${name}/environ`).split("\0").includes(`WTFT_CLAUDE_PROJECTS_DIR=${root}`)) out.push(Number(name));
	}
	return out;
}

/** Milliseconds until `pred` holds, or Infinity after `limitMs`. */
export async function until(pred: () => boolean, limitMs: number): Promise<number> {
	const t = Date.now();
	while (Date.now() - t < limitMs) {
		if (pred()) return Date.now() - t;
		await sleep(50);
	}
	return Infinity;
}


/** Stop every daemon a section started, print the tally, and exit 1 on a failure. */
export async function finish(): Promise<void> {
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	await sleep(300);
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}
