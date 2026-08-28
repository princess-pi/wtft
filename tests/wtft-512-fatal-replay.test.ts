#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-512-fatal-replay
 * @description #512 — a partial tag append is terminal, poisons the existing
 *   singleton lease, and the next owner rederives the transient cache.
 *
 * @usage bun run test wtft-512-fatal-replay
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getCurrentVersionTagPath, getDaemonPidPath, readClassifiedTagFile } from "../bin/wtft.mjs";
import { pollUntil, sleep } from "./lib/poll";
import { isolateTmpdir, trackSandbox } from "./lib/sandbox";

isolateTmpdir("fatal-replay");

const daemonPath = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-512-fatal-")));
const sessionPath = path.join(root, "session.jsonl");
const triggerPath = path.join(root, "inject-partial");
const observationPath = path.join(root, "partial-size.json");
const preloadPath = path.join(root, "partial-append-preload.mjs");
const reclaimPreloadPath = path.join(root, "stale-reclaim-preload.mjs");
const targetId = "msg_512_fatal_replay";
const children: ChildProcess[] = [];

function turn(id: string): string {
	return JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			timestamp: new Date().toISOString(),
			usage: { input_tokens: 1000, output_tokens: 100 },
			content: [{ type: "text", text: id }],
		},
	}) + "\n";
}

fs.writeFileSync(sessionPath, "");
fs.writeFileSync(preloadPath, `
import * as realFs from "node:fs";
import { mock } from "bun:test";
const originalAppend = realFs.appendFileSync.bind(realFs);
let injected = false;
function appendFileSync(file, data, ...rest) {
  const text = String(data);
  if (!injected && realFs.existsSync(process.env.WTFT_512_TRIGGER) && text.includes(process.env.WTFT_512_TARGET)) {
    injected = true;
    // Simulate a singleton takeover after this daemon's lease check but before
    // its append. The failing non-owner must not truncate the successor's tag.
    realFs.writeFileSync(process.env.WTFT_512_PID_PATH, process.env.WTFT_512_SUCCESSOR_PID);
    const before = realFs.statSync(file).size;
    const prefix = Buffer.from(text).subarray(0, Math.max(1, Math.floor(Buffer.byteLength(text) / 2)));
    originalAppend(file, prefix, ...rest);
    const after = realFs.statSync(file).size;
    realFs.writeFileSync(process.env.WTFT_512_OBSERVATION, JSON.stringify({ before, after }));
    setInterval(() => {}, 1000);
    throw Object.assign(new Error("injected partial append"), { code: "ENOSPC" });
  }
  return originalAppend(file, data, ...rest);
}
mock.module("node:fs", () => ({ ...realFs, appendFileSync, default: { ...realFs, appendFileSync } }));
`);

fs.writeFileSync(reclaimPreloadPath, `
import * as realFs from "node:fs";
import { mock } from "bun:test";
const originalRead = realFs.readFileSync.bind(realFs);
let injected = false;
function readFileSync(file, ...rest) {
  const value = originalRead(file, ...rest);
  if (!injected && String(file) === process.env.WTFT_512_PID_PATH && String(value).trim() === "rebuild") {
    injected = true;
    realFs.writeFileSync(file, process.env.WTFT_512_SUCCESSOR_PID);
  }
  return value;
}
mock.module("node:fs", () => ({ ...realFs, readFileSync, default: { ...realFs, readFileSync } }));
`);

function startDaemon(inject: boolean): { child: ChildProcess; stderr: () => string } {
	let output = "";
	const args = inject
		? ["--preload", preloadPath, daemonPath, "--session", sessionPath]
		: [daemonPath, "--session", sessionPath];
	const child = spawn(process.execPath, args, {
		env: {
			...process.env,
			WTFT_512_TRIGGER: triggerPath,
			WTFT_512_TARGET: targetId,
			WTFT_512_PID_PATH: getDaemonPidPath(sessionPath),
			WTFT_512_SUCCESSOR_PID: String(process.pid),
			WTFT_512_OBSERVATION: observationPath,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr?.on("data", chunk => { output += String(chunk); });
	children.push(child);
	return { child, stderr: () => output };
}

async function waitForExit(child: ChildProcess, ceilingMs = 2500): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	await Promise.race([
		new Promise<void>(resolve => child.once("exit", () => resolve())),
		sleep(ceilingMs),
	]);
	return child.exitCode;
}

try {
	const first = startDaemon(true);
	const tagPath = getCurrentVersionTagPath(sessionPath);
	const pidPath = getDaemonPidPath(sessionPath);
	if (!await pollUntil(() => fs.existsSync(tagPath), 5000)) throw new Error("initial tag was not created");

	fs.writeFileSync(triggerPath, "armed");
	fs.appendFileSync(sessionPath, turn(targetId));
	const firstExit = await waitForExit(first.child);
	if (firstExit !== 1) throw new Error(`partial append exited ${firstExit ?? "never"}, expected 1`);
	if (!first.stderr().includes("restart wtft to rederive")) throw new Error("fatal diagnostic omitted rederivation instructions");
	const observed = JSON.parse(fs.readFileSync(observationPath, "utf8")) as { before: number; after: number };
	if (observed.after <= observed.before) throw new Error("injected append did not leave a real partial fragment");
	if (fs.statSync(tagPath).size !== observed.after) throw new Error("fatal cleanup mutated the shared tag after the failed append");
	if (fs.readFileSync(pidPath, "utf8").trim() !== "rebuild") throw new Error("fatal append did not poison the singleton lease");

	// Force the version-takeover startup branch. A valid-looking offset after the
	// fragment would make ordinary incremental resume skip targetId, so recovery
	// proves takeover consumed (rather than overwrote) the rebuild token.
	fs.appendFileSync(tagPath, `\n${JSON.stringify({ _meta: { offset: fs.statSync(sessionPath).size } })}\n`);
	const historicalTagPath = path.join(
		path.dirname(tagPath),
		`${path.basename(sessionPath)}.wtft-tag.v0.0.0.jsonl`,
	);
	fs.writeFileSync(historicalTagPath, "{}");

	// The next owner consumes the poisoned lease, clears the disposable cache,
	// and enters the ordinary full-source parse path.
	const recovered = startDaemon(false);
	if (!await pollUntil(
		() => readClassifiedTagFile(tagPath).some((row: any) => row.messageId === targetId),
		8000,
	)) throw new Error("replay did not restore the source turn");
	if (fs.readFileSync(pidPath, "utf8").trim() !== String(recovered.child.pid)) {
		throw new Error("recovery daemon did not replace the poisoned lease");
	}

	// Prove the daemon's real poll loop enforces lease loss, rather than merely
	// trusting the fatal helper's comment about a live successor.
	fs.writeFileSync(pidPath, "rebuild");
	const successorExit = await waitForExit(recovered.child);
	if (successorExit !== 0) throw new Error(`live successor ignored poisoned lease (exit ${successorExit ?? "never"})`);
	const replayed = startDaemon(false);
	if (!await pollUntil(
		() => {
			let ownsLease = false;
			try { ownsLease = fs.readFileSync(pidPath, "utf8").trim() === String(replayed.child.pid); } catch {}
			return ownsLease && readClassifiedTagFile(tagPath).some((row: any) => row.messageId === targetId);
		},
		8000,
	)) throw new Error("second poisoned-lease replay did not restore the source turn");

	// A stale numeric PID is only evidence of an unclean process exit, not an
	// append failure. It must preserve #124 incremental resume rather than
	// turning every SIGKILL/OOM/reboot into an unnecessary full replay.
	const sentinelId = "stale-pid-resume-sentinel";
	fs.appendFileSync(tagPath, JSON.stringify({ t: Date.now(), c: 0.01, id: sentinelId }) + "\n");
	const replayedExit = new Promise<void>(resolve => replayed.child.once("exit", () => resolve()));
	replayed.child.kill("SIGKILL");
	await replayedExit;
	const staleRestart = startDaemon(false);
	if (!await pollUntil(
		() => {
			let ownsLease = false;
			try { ownsLease = fs.readFileSync(pidPath, "utf8").trim() === String(staleRestart.child.pid); } catch {}
			return ownsLease && readClassifiedTagFile(tagPath).some((row: any) => row.messageId === sentinelId);
		},
		8000,
	)) throw new Error("stale numeric lease discarded the resumable tag");

	// A contender can replace a stale lease after this daemon reads it but
	// before reclamation. The stale reader must not unlink that new live lease.
	staleRestart.child.kill("SIGKILL");
	await new Promise<void>(resolve => staleRestart.child.once("exit", () => resolve()));
	fs.writeFileSync(pidPath, "rebuild");
	const contender = spawn(process.execPath, ["--preload", reclaimPreloadPath, daemonPath, "--session", sessionPath], {
		env: {
			...process.env,
			WTFT_512_PID_PATH: pidPath,
			WTFT_512_SUCCESSOR_PID: String(process.pid),
		},
		stdio: "ignore",
	});
	children.push(contender);
	const contenderExit = await waitForExit(contender);
	if (contenderExit !== 0) throw new Error(`stale-lease contender exited ${contenderExit ?? "never"}`);
	if (fs.readFileSync(pidPath, "utf8").trim() !== String(process.pid)) {
		throw new Error("stale-lease contender unlinked a newly published live lease");
	}

	console.log("PASS append failure is fatal and the transient tag is rederived on restart");
} finally {
	for (const child of children) {
		try { child.kill("SIGTERM"); } catch {}
	}
	await sleep(100);
}
