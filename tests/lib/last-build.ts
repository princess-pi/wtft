import * as fs from "node:fs";
import * as path from "node:path";

/** Written by every successful `bun run build`, whether or not a bundle changed (build.ts). */
export const LAST_BUILD = path.resolve(import.meta.dirname, "..", "..", "tmp", "last-build");

/** When the last successful build started, or null when none is recorded. */
export function lastBuildMs(): number | null {
	try { return fs.statSync(LAST_BUILD).mtimeMs; } catch { return null; }
}
