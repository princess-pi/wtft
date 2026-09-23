/** How every long-lived log parser daemon is started. No imports: the CLI,
 *  the widget and the daemon itself all spawn one. */

/**
 * The daemon's argv. Under node it gets a 1 MB semi-space (V8's
 * young-generation setting): the daemon re-parses a changed subagent
 * transcript whole, and V8's default semi-space size lets that churn
 * inflate the resident heap (docs/spec-97-streaming-parse.md). bun is not
 * V8 and takes no such flag.
 */
export function daemonSpawnArgs(
	daemonPath: string,
	sessionPath: string,
	runtime: { node?: string; bun?: string } = process.versions,
): string[] {
	const v8Flags = runtime.bun ? [] : ["--max-semi-space-size=1"];
	return [...v8Flags, daemonPath, "--session", sessionPath];
}
