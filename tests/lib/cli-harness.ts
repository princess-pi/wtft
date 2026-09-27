/**
 * Runs the built `wtft` CLI, or the built Pi widget, without a log parser
 * daemon behind it. The session is tagged in this process first, and the
 * bundles are copies whose sibling bin/wtft-daemon.mjs is a stand-in, so the
 * daemon the CLI starts on every report does no work.
 *
 * The stand-in exits at once, unless WTFT_STAND_IN says otherwise:
 * - `alive`: it stays up for 3 s and writes nothing, as a daemon that has not
 *   read the session yet. The CLI reads that as "no data yet", not as a dead
 *   daemon, on a session with nothing tagged.
 * - `heartbeat`: it also heartbeats into the session's tag, which is what the
 *   CLI waits for on a session whose log is not written yet.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readTagProvisional } from "../../extensions/lib/wtft-daemon-lib.ts";
import { WTFT_TAGGER_VERSION } from "../../extensions/lib/wtft-tagger-version.ts";
import { trackSandbox } from "./sandbox";
import { tagSession, type TaggedSession } from "./tagger-harness.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/** The prefix debug/count-daemon-spawners.sh reads as "not the real daemon". */
export const CLI_HARNESS_PREFIX = "wtft-cli-harness-";

const STAND_IN = `import * as fs from "node:fs";
import * as path from "node:path";
const mode = process.env.WTFT_STAND_IN;
const at = process.argv.indexOf("--session");
if (mode === "alive" || mode === "heartbeat") setTimeout(() => {}, 3000);
// daemonLaunchArgs always passes --session; without it there is no tag to beat into.
if (mode === "heartbeat" && at < 0) process.exit(3);
if (mode === "heartbeat" && at > 0) {
	const session = process.argv[at + 1];
	const tag = path.join(path.dirname(session), "wtft-tags", path.basename(session) + ".wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl");
	fs.mkdirSync(path.dirname(tag), { recursive: true });
	const beat = () => { const now = Date.now(); fs.appendFileSync(tag, JSON.stringify({ _hb: { first: now, last: now } }) + "\\n"); };
	beat();
	const timer = setInterval(beat, 100);
	setTimeout(() => clearInterval(timer), 3000);
}
`;

let root: string | null = null;

function harnessRoot(): string {
	if (root) return root;
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), CLI_HARNESS_PREFIX)));
	fs.mkdirSync(path.join(dir, "bin"));
	fs.mkdirSync(path.join(dir, "pi"));
	fs.copyFileSync(path.join(REPO, "bin", "wtft.mjs"), path.join(dir, "bin", "wtft.mjs"));
	fs.copyFileSync(path.join(REPO, "pi", "wtft.js"), path.join(dir, "pi", "wtft.js"));
	fs.writeFileSync(path.join(dir, "bin", "wtft-daemon.mjs"), STAND_IN);
	root = dir;
	return dir;
}

/** The copy of bin/wtft.mjs. Made once per process; the bundles must be built. */
export function cliWithoutDaemon(): string {
	return path.join(harnessRoot(), "bin", "wtft.mjs");
}

/** The copy of pi/wtft.js, whose daemon is the same stand-in. */
export function widgetWithoutDaemon(): string {
	return path.join(harnessRoot(), "pi", "wtft.js");
}

/** Tags `sessionPath` until the tag holds data and reads swept, as a daemon
 *  would have left it, and throws if it does not; returns the tagger. */
export function tagForCli(sessionPath: string, opts: { start?: number } = {}): TaggedSession {
	const tagger = tagSession(sessionPath, opts);
	const settled = tagger.until(() => fs.readFileSync(tagger.tagPath, "utf8").includes('"cat"')
		&& !readTagProvisional(tagger.tagPath).provisional, 40);
	if (!settled) throw new Error(`tagForCli: ${sessionPath} did not settle in 40 polls`);
	return tagger;
}
