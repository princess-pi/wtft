/**
 * A stand-in process whose cmdline names `wtft-daemon.mjs`, so the holder
 * module (docs/spec-297-holder-module.md § 2) classifies it as a daemon.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./sandbox";

/** Arguments for `spawn(process.execPath, …)` that run `code` as a "daemon". */
export function standInDaemonArgs(code: string, ...extra: string[]): string[] {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-stand-in-")));
	const file = path.join(dir, "wtft-daemon.mjs");
	fs.writeFileSync(file, code + "\n");
	return [file, ...extra];
}
