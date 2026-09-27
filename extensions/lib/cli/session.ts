import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSessions, selectSessionPrompt } from "../session-selector.js";
import { isPendingSessionPath } from "../wtft-cli-shared.js";
import { TIME_WINDOW_MS } from "../picker-state.js";
import type { WtftCliOptions } from "../wtft-cli-shared.js";
import { EXIT_SESSION_AMBIGUOUS } from "./exit-codes.js";

/** The session this run reports on: `-s`, else the picker, else exit 10 without a terminal. */
export async function selectSession(opts: WtftCliOptions): Promise<string> {
	// Lazy + memoised: only the `-s` fuzzy fallback pays for full discovery.
	// Named `getCandidates` (verb) so a missing `()` cannot read as "no sessions"
	// via Function.length arity.
	let candidateCache: ReturnType<typeof discoverSessions> | null = null;
	const getCandidates = (): ReturnType<typeof discoverSessions> =>
		(candidateCache ??= discoverSessions(opts.harnessOption, opts.cwdOverride));

	let defaultScopedCache: ReturnType<typeof discoverSessions> | null = null;
	const getDefaultScoped = (): ReturnType<typeof discoverSessions> =>
		(defaultScopedCache ??= discoverSessions(opts.harnessOption, opts.cwdOverride, {
			scope: "worktree",
			windowMs: TIME_WINDOW_MS["20m"],
		}));

	let finalSessionPath = "";
	// Absolute *.jsonl that does not exist yet is lagging (first prompt not done), not an error.
	let sessionPending = false;

	// ---
	// Picker draws to stderr under `--json` so stdout stays one JSON document.
	// Need stdin AND the picker's output stream both TTYs — `| less -R` keeps
	// stdin on the terminal while stdout is a pipe.
	const pickerOut: NodeJS.WriteStream = opts.json ? process.stderr : process.stdout;
	const canShowPicker = !!process.stdin.isTTY && !!pickerOut.isTTY;

	const showPicker = async (found: ReturnType<typeof discoverSessions>, substringFilter?: string): Promise<string> =>
		selectSessionPrompt(found, {
			harnessOption: opts.harnessOption,
			cwdOverride: opts.cwdOverride,
			out: pickerOut,
			substringFilter,
		});

	const failAmbiguous = (found: ReturnType<typeof discoverSessions>, label: string, discoveredTotal?: number): never => {
		const names = found.map(c => `  - ${c.displayPath}  (${c.path})`).join("\n");
		const availability = discoveredTotal !== undefined ? ` (${discoveredTotal} available)` : "";
		const text = found.length === 0
			? `Session not specified precisely enough: ${label} matched no sessions${availability}.`
			: `Session not specified precisely enough: ${label} matched ${found.length} session${found.length === 1 ? "" : "s"}:\n${names}`;
		// writeSync: stderr on a pipe is async on macOS; process.exit would truncate.
		fs.writeSync(2, `\x1b[33m${text}\x1b[0m\n`);
		if (found.length > 0) fs.writeSync(2, `\x1b[90mPass -s <path|substring> that matches exactly one.\x1b[0m\n`);
		process.exit(EXIT_SESSION_AMBIGUOUS);
	};

	if (opts.targetSession) {
		if (fs.existsSync(opts.targetSession)) {
			finalSessionPath = opts.targetSession;
		} else if (isPendingSessionPath(opts.targetSession)) {
			finalSessionPath = opts.targetSession;
			sessionPending = true;
		} else {
			const filter = opts.targetSession.toLowerCase();
			const found = getCandidates();
			const filtered = found.filter(c =>
				c.path.toLowerCase().includes(filter) ||
				c.name.toLowerCase().includes(filter)
			);
			if (filtered.length === 1) {
				finalSessionPath = filtered[0].path;
			} else if (!canShowPicker) {
				failAmbiguous(filtered, `-s ${opts.targetSession}`, found.length);
			} else if (filtered.length === 0) {
				console.error(`❌ Error: Session '${opts.targetSession}' does not exist as a file and matches no discovered sessions (${found.length} available).`);
				process.exit(1);
			} else {
				finalSessionPath = await showPicker(filtered, opts.targetSession);
			}
		}
	} else {
		// No `-s`: default-scoped population. Without a TTY only `-s` selects
		// (scope is time-windowed — a lone match would depend on the clock).
		const found = getDefaultScoped();
		if (!canShowPicker) {
			failAmbiguous(found, "no -s and no interactive terminal");
		} else if (found.length === 1) {
			finalSessionPath = found[0].path;
		} else {
			// Shown even on zero rows — the picker names Ctrl+T rather than this CLI widening.
			finalSessionPath = await showPicker(found);
		}
	}

	if (!finalSessionPath || (!sessionPending && !fs.existsSync(finalSessionPath))) {
		console.error("❌ Error: Selected session log file path is invalid or does not exist.");
		process.exit(1);
	}
	return finalSessionPath;
}
