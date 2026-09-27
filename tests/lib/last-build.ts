import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/** Written by every successful `bun run build`, whether or not a bundle changed (build.ts). */
export const LAST_BUILD = path.join(REPO, "tmp", "last-build");

/** When the last successful build started, or null when none is recorded. */
export function lastBuildMs(): number | null {
	try { return fs.statSync(LAST_BUILD).mtimeMs; } catch { return null; }
}

/** Every source the CLI and daemon bundles are built from, repo-relative. */
export function bundleSources(): string[] {
	const lib = path.join(REPO, "extensions", "lib");
	return [
		"bin/wtft.ts",
		"bin/wtft-daemon.ts",
		...fs.readdirSync(lib, { recursive: true, encoding: "utf8" })
			.filter(f => f.endsWith(".ts"))
			.map(f => path.join("extensions", "lib", f)),
	];
}
