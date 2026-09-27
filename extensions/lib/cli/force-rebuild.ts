import * as fs from "node:fs";
import * as path from "node:path";
import { getDaemonPidPath, forceRebuildSession, describeForceRebuildFailure } from "../wtft-shared.js";
import { spawnWtftDaemon } from "../wtft-cli-shared.js";

/** `-F`: rebuild the session's tag, and wait for a harness to adopt it. Exits 1 when nothing was rebuilt. */
export async function runForceRebuild(finalSessionPath: string, daemonDir: string): Promise<void> {
	const how = forceRebuildSession(finalSessionPath);
	let adopted = true;
	if (how === "rebuild") {
		// The report below reads the tag, so wait until the harness has
		// adopted the session; it truncates the tag in the same step as it
		// claims the lease, and the pause after covers that step.
		if (!spawnWtftDaemon(finalSessionPath, daemonDir)) {
			console.error(`❌ Force re-parse: the log parser daemon for ${path.basename(finalSessionPath)} could not be started, so the harness was not asked for it. Its lease reads "rebuild"; run -F again.`);
			process.exit(1);
		}
		const lease = getDaemonPidPath(finalSessionPath);
		adopted = false;
		for (const until = Date.now() + 10_000; Date.now() < until && !adopted;) {
			let held = "";
			try { held = fs.readFileSync(lease, "utf8").trim(); } catch { /* not claimed yet */ }
			adopted = held !== "rebuild" && held !== "";
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
		console.error(`❌ Force re-parse: a log parser daemon for ${path.basename(finalSessionPath)} did not stop within 2 s, or its lease changed or was released meanwhile, so nothing was deleted. Run -F again once it has stopped.`);
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
