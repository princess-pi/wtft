import * as fs from "node:fs";
import * as path from "node:path";
import { getDaemonPidPath, getCurrentVersionTagPath, forceRebuildSession, describeForceRebuildFailure } from "../wtft-shared.js";
import { parseTagLine } from "../tag-log.js";
import { spawnWtftDaemon } from "../wtft-cli-shared.js";

/** `-F`: rebuild the session's tag, and wait for a harness to adopt it. Exits 1 when nothing was rebuilt. */
export async function runForceRebuild(finalSessionPath: string, daemonDir: string): Promise<void> {
	const requestedAt = Date.now();
	const how = forceRebuildSession(finalSessionPath);
	let adopted = true;
	if (how === "rebuild") {
		if (!spawnWtftDaemon(finalSessionPath, daemonDir)) {
			console.error(`❌ Force re-parse: the log parser daemon for ${path.basename(finalSessionPath)} could not be started, so the harness was not asked for it. Its lease reads "rebuild"; run -F again.`);
			process.exit(1);
		}
		const lease = getDaemonPidPath(finalSessionPath);
		const tagDirs = [...new Set([path.dirname(getCurrentVersionTagPath(finalSessionPath)), path.join(path.dirname(finalSessionPath), "wtft-tags")])];
		adopted = false;
		// A started-over tag it cannot find (a moved session's tag under another build's
		// version) must not turn an adopted session into a "not taken up" failure.
		for (const until = Date.now() + 10_000; Date.now() < until;) {
			let held = "";
			try { held = fs.readFileSync(lease, "utf8").trim(); } catch { /* not claimed yet */ }
			adopted = held !== "rebuild" && held !== "";
			if (adopted && anyTagStartedSince(tagDirs, path.basename(finalSessionPath), requestedAt)) break;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
	const what = {
		rebuild: "the harness log parser daemon is rebuilding the tag",
		stopped: "stopped the log parser daemon and deleted the tag files",
		deleted: "deleted the tag files",
	}[how as "rebuild" | "stopped" | "deleted"];
	// Nothing rebuilt: an error, with no report of the tag as it was.
	if (how === "busy") {
		console.error(`❌ Force re-parse: a log parser daemon for ${path.basename(finalSessionPath)} did not stop within 2 s, could not be verified as one, or its lease changed or was released meanwhile, so nothing was deleted.`);
		process.exit(1);
	}
	const failure = describeForceRebuildFailure(how);
	if (failure) {
		console.error(`❌ Force re-parse of ${path.basename(finalSessionPath)}: ${failure}. Nothing was rebuilt.`);
		process.exit(1);
	}
	if (!adopted) {
		console.error(`❌ Force re-parse: the harness log parser daemon has not taken ${path.basename(finalSessionPath)} up after 10 s. It rebuilds the tag as soon as it does, with no new request; run wtft again shortly to read the rebuilt tag.`);
		process.exit(1);
	}
	console.error(`\x1b[33mForce re-parse: ${what} for ${path.basename(finalSessionPath)}\x1b[0m`);
}

function anyTagStartedSince(dirs: string[], sessionBase: string, since: number): boolean {
	for (const dir of dirs) {
		let names: string[] = [];
		try { names = fs.readdirSync(dir); } catch { continue; }
		for (const name of names) {
			if (name.startsWith(`${sessionBase}.wtft-tag.v`) && name.endsWith(".jsonl") && tagStartedSince(path.join(dir, name), since)) return true;
		}
	}
	return false;
}

function tagStartedSince(tag: string, since: number): boolean {
	const head = Buffer.alloc(256);
	let read = 0;
	try {
		const fd = fs.openSync(tag, "r");
		try { read = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
	} catch { return false; }
	const first = parseTagLine(head.subarray(0, read).toString("utf8").split("\n", 1)[0]);
	return first?.kind === "heartbeat" && first.first >= since;
}
