#!/usr/bin/env -S node --experimental-strip-types
/** Command-line cost auditing for coding-agent sessions. Harness-agnostic (`--harness auto`). */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import wtftManifest from "../docs/manifests/wtft-cmd.json" with { type: "json" };
import {
	buildWtftLines,
	buildTimelineString,
	renderSpawnTree,
	emptyTotals,
	parseSessionFile,
	parseEntryToInteraction,
	classifyInteraction,
	normalizeCommand,
	extractCommandSegments,
	extractCwdFromBashCommand,
	extractRealCommands,
	claudeSpawnCwds,
	splitCommandWords,
	renderOtherHistogram,
	getSemanticCommandGroup,
	renderTokenSummary,
	deduplicateInteractions,
	scanUncountedBillables,
	scanUncountedBillablesChecked,
	newUncountedBillables,
	addUncountedBillables,
	readUncountedBillableClass,
	renderUncountedBillables,
	discoverSubagentSessionFiles,
	readSubagentMeta,
	readSubagentMetaChecked,
	discoverClaudeSubAgentSessionFiles,
	discoverClaudeSubAgentFilesForTurn,
	clearSubagentCacheMiss,
	loadSubagentInteractions,
	loadSubagentInteractionsChecked,
	attributeClaudeSubAgentCosts,
	collectSelfAttributedSessionIds,
	parseInterval,
	getBinInfo,
	calculateClaudeCost,
	calculateServerToolCost,
	getDeepSeekPeakMultiplier,
	getSurgeLocalHours,
	checkSurgeProximity,
	distributeHalfSlots,
	halfSlotCountsToArray,
	renderHalfBlockBar,
	CATEGORY_ORDER,
	watchTagFile,
	readClassifiedTagFile,
	seedClassifiedTagFile,
	readTagProvisional,
	readTagFileWithVerdict,
	lastLineStartByte,
	readPrefixSentinel,
	sentinelMatches,
	watcherAction,
	PREFIX_SENTINEL_BYTES,
	detectSessionHarness,
	buildSessionJson,
	type WtftSubagentJson,
	renderSessionJson,
	WTFT_JSON_SCHEMA,
	type WtftNotice,
	type UncountedBillables,
	getDaemonPidPath,
	getTagPath,
	awaitDaemonUp,
	checkDaemonHealth,
	IDLE_THRESHOLD_MS,
	WTFT_TAGGER_VERSION,
	describeProvisionalReason,
	splitOverheadCost,
	serializeClassifiedWithOverheadSplit,
	isInterruptMarker,
	serializeClassified,
	classifiedToInteraction,
	resolveTieredRates,
	lookupModelPricing,
	MODEL_PRICING,
	applyUserPricing,
	isModelPriced,
	describeFallbackPricing,
	loadUserPricing,
	getUserPricingPath,
	loadExternalHarnesses,
	getHarnesses,
	getHarness,
	getDiscoveries,
	getParseAdapters,
	registerHarness,
	resetHarnessRegistry,
	loadHarnessConfig,
	getHarnessConfigPath,
	getCurrentVersionTagPath,
	isSessionIdBasename,
	resolveMovedSession,
	applyControlEntry,
	newParseStreamState,
	readControlEntry,
	resolveLastCwd,
	cwdToSlug,
	cwdToStrictSlug,
	cwdSlugVariants,
	slugMatchesCwd,
	resetCwdCache,
	getCwdReadCount,
	getCwdBytesRead,
	getDirWalkCount,
	type WatchSettings,
	type Interaction,
	type ModelPricing,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";
import {
	runSpawnRecordCommand,
	readSpawnLedger,
	spawnLedgerPath,
	serializeSpawnRecord,
	appendSpawnRecord,
	SPAWN_RECORD_SCHEMA,
	SPAWN_RECORD_EXIT,
	MAX_RECORD_BYTES,
	MAX_FIELD_BYTES,
	isSessionId,
} from "../extensions/lib/wtft-spawn-ledger.ts";
import {
	computeSpawnTree,
	treeTotals,
	SPAWN_TREE_SCHEMA,
	DEFAULT_MAX_DEPTH,
	type SpawnTree,
} from "../extensions/lib/wtft-spawn-tree.ts";
import { execSync } from "node:child_process";
import { loadConfig, readConfig } from "@princess-pi/libs/config";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "../extensions/lib/wtft-config-dir.ts";
import {
	discoverSessions,
	harnessLabel,
	selectSessionPrompt
} from "../extensions/lib/session-selector.ts";
import { buildDisplayPath } from "@princess-pi/libs/session-path-shortener";
import {
	findRepoRoot,
	listWorktreeDirs,
	fanOutCwd,
	currentBranch,
	worktreeBranches,
	resolveBranchCheckout,
} from "../extensions/lib/harness/worktrees.ts";
import {
	parseWtftCliArgs,
	spawnWtftDaemon,
	isPendingSessionPath,
	isEmojiDisabled,
	renderWtftHelp,
	renderWtftWhy,
	renderWtftVersion,
} from "../extensions/lib/wtft-cli-shared.ts";
import {
	initPickerState,
	setRows,
	visibleWindow,
	applyKey,
	nextTimeWindow,
	windowMsFor,
	TIME_WINDOW_CYCLE,
	TIME_WINDOW_MS,
	ROW_LIMIT,
	VISIBLE_DATA_ROWS,
	type PickerState,
	type PickerRow,
	type PickerScope,
	type TimeWindowLabel,
	type PickerAction,
} from "../extensions/lib/picker-state.ts";
import {
	mainCloneDir,
	readHarnessOrder,
	recordHarnessOpened,
	orderByHarness,
} from "../extensions/lib/harness-order.ts";

// ---
// Re-exports for test imports from built bin/wtft.mjs
// (the bundler tree-shakes unused imports; explicit exports keep them in the bundle)
// ---
export {
	calculateClaudeCost,
	calculateServerToolCost,
	getDeepSeekPeakMultiplier,
	getSurgeLocalHours,
	checkSurgeProximity,
	resolveTieredRates,
	lookupModelPricing,
	MODEL_PRICING,
	applyUserPricing,
	isModelPriced,
	describeFallbackPricing,
	loadUserPricing,
	getUserPricingPath,
	parseEntryToInteraction,
	classifyInteraction,
	normalizeCommand,
	extractCommandSegments,
	extractCwdFromBashCommand,
	extractRealCommands,
	claudeSpawnCwds,
	splitCommandWords,
	renderOtherHistogram,
	getSemanticCommandGroup,
	buildWtftLines,
	buildTimelineString,
	parseSessionFile,
	deduplicateInteractions,
	renderTokenSummary,
	scanUncountedBillables,
	scanUncountedBillablesChecked,
	newUncountedBillables,
	addUncountedBillables,
	readUncountedBillableClass,
	renderUncountedBillables,
	discoverSubagentSessionFiles,
	readSubagentMeta,
	readSubagentMetaChecked,
	discoverClaudeSubAgentSessionFiles,
	discoverClaudeSubAgentFilesForTurn,
	clearSubagentCacheMiss,
	loadSubagentInteractions,
	loadSubagentInteractionsChecked,
	attributeClaudeSubAgentCosts,
	collectSelfAttributedSessionIds,
	parseInterval,
	getBinInfo,
	distributeHalfSlots,
	halfSlotCountsToArray,
	renderHalfBlockBar,
	CATEGORY_ORDER,
	serializeClassified,
	classifiedToInteraction,
	readClassifiedTagFile,
	seedClassifiedTagFile,
	readTagProvisional,
	readTagFileWithVerdict,
	lastLineStartByte,
	readPrefixSentinel,
	sentinelMatches,
	watcherAction,
	PREFIX_SENTINEL_BYTES,
	getTerminalWidth,
	WTFT_TAGGER_VERSION,
	checkDaemonHealth,
	getTagPath,
	getDaemonPidPath,
	IDLE_THRESHOLD_MS,
	splitOverheadCost,
	serializeClassifiedWithOverheadSplit,
	isInterruptMarker,
	discoverSessions,
	harnessLabel,
	buildSessionJson,
	type WtftSubagentJson,
	renderSessionJson,
	detectSessionHarness,
	WTFT_JSON_SCHEMA,
	runSpawnRecordCommand,
	readSpawnLedger,
	spawnLedgerPath,
	serializeSpawnRecord,
	appendSpawnRecord,
	isSessionId,
	SPAWN_RECORD_SCHEMA,
	SPAWN_RECORD_EXIT,
	MAX_RECORD_BYTES,
	MAX_FIELD_BYTES,
	computeSpawnTree,
	treeTotals,
	SPAWN_TREE_SCHEMA,
	DEFAULT_MAX_DEPTH,
	getHarnesses,
	getHarness,
	getDiscoveries,
	getParseAdapters,
	registerHarness,
	resetHarnessRegistry,
	loadHarnessConfig,
	loadExternalHarnesses,
	getHarnessConfigPath,
	getCurrentVersionTagPath,
	isSessionIdBasename,
	resolveMovedSession,
	applyControlEntry,
	newParseStreamState,
	readControlEntry,
	resolveLastCwd,
	cwdToSlug,
	resetCwdCache,
	getCwdReadCount,
	cwdToStrictSlug,
	cwdSlugVariants,
	slugMatchesCwd,
	getCwdBytesRead,
	getDirWalkCount,
	buildDisplayPath,
	findRepoRoot,
	listWorktreeDirs,
	fanOutCwd,
	currentBranch,
	worktreeBranches,
	resolveBranchCheckout,
	initPickerState,
	setRows,
	visibleWindow,
	applyKey,
	nextTimeWindow,
	windowMsFor,
	TIME_WINDOW_CYCLE,
	TIME_WINDOW_MS,
	ROW_LIMIT,
	VISIBLE_DATA_ROWS,
	mainCloneDir,
	readHarnessOrder,
	recordHarnessOpened,
	orderByHarness,
	type PickerState,
	type PickerRow,
	type PickerScope,
	type TimeWindowLabel,
	type PickerAction
}

/** Succeeded, but the printed total may still grow (distinct from exit 1 = failed). */
export const EXIT_PROVISIONAL = 9;

/** No interactive terminal: no `-s`, or `-s` did not match exactly one session. */
export const EXIT_SESSION_AMBIGUOUS = 10;

// ---
// SHARED WORDING — one sentence, two output modes.
// ---
// A sentence that reaches both modes is ONE literal. Pending/no-data go to
// stdout when rendered (they are the only output); under `--json` they move to
// stderr and `notices[]`. Unpriced and provisional lines are stderr in both.

function collectUnpricedModels(interactions: Interaction[]): string[] {
	const seen = new Set<string>();
	for (const i of interactions) {
		// Agree with computeSessionSummary: `(unknown)` is untagged, not a model.
		if (!i.model || i.model === "<synthetic>" || i.model === "(unknown)") continue;
		if (!isModelPriced(i.model)) seen.add(i.model);
	}
	return [...seen];
}

function unpricedModelWarning(model: string): string {
	return `no pricing for ${model} — ${describeFallbackPricing(model)}; totals may be unreliable. ` +
		`Add an entry to ${getUserPricingPath()} (no rebuild needed).`;
}

/** The one action that ends the provisional state. Does not name `-F` (that deletes the tag and falls through here). */
function describeProvisionalRemedy(provisional: { reason: string | null }): string {
	if (provisional.reason === "descendant-live") {
		return `run wtft again once every descendant has been quiet for ${IDLE_THRESHOLD_MS / 1000} s`;
	}
	return provisional.reason === "subagent-unreadable"
		? "restore the unreadable session file's readability, then run wtft again — the daemon re-reads it on its next poll, and wtft reads it directly on the --tokens and --json paths"
		: "The daemon is rebuilding this tag now — run wtft again in a moment to read the settled total";
}

// ---

const cfg = loadConfig(WTFT_CONFIG_TOOL, { interval: "1h", limit: 100, mode: "cumulative" }, WTFT_CONFIG_DIR) as {
	interval?: string;
	limit?: number;
	mode?: "bucket" | "cumulative";
	timezone?: string;
	tokens?: boolean;
};

// Manifest is imported so the bundler inlines it — package `files` ships only bin/*.mjs.
const manifest = wtftManifest;
const daemonDir = path.dirname(fileURLToPath(import.meta.url));

// Positional `spawn-record` skips main() at the entry-point guard (parseWtftCliArgs
// ignores unknown args, so falling through would quietly run a full report).
const isSpawnRecord = process.argv[2] === "spawn-record";

const opts = parseWtftCliArgs(process.argv.slice(2));

let unit: "cost" | "tokens" = cfg.tokens ? "tokens" : "cost";
if (opts.hasTokens) unit = "tokens";
if (opts.hasCost) unit = "cost";

const WARN_LOG = path.join(os.homedir(), ".local", "state", "wtft", "reap.log");

function showReapWarnings() {
  try {
    if (!fs.existsSync(WARN_LOG)) return;
    const content = fs.readFileSync(WARN_LOG, "utf8").trim();
    if (!content) return;
    const lines = content.split("\n");
    const oneHourAgo = Date.now() - 3600000;
    const recent = lines.filter(l => {
      const m = l.match(/^\[([^\]]+)\]/);
      if (!m) return false;
      const ts = Date.parse(m[1]);
      return !isNaN(ts) && ts > oneHourAgo;
    });
    if (recent.length === 0) return;
    console.error("\x1b[33m\n┌─ wtft reap warnings ────────────────────────────────\x1b[0m");
    for (const line of recent) {
      const isKilled = line.includes("KILLED");
      const prefix = isKilled ? "\x1b[31m" : "\x1b[33m";
      console.error(`${prefix}│ ${line}\x1b[0m`);
    }
    console.error("\x1b[33m└──────────────────────────────────────────────────────\x1b[0m\n");
    try { fs.truncateSync(WARN_LOG, 0); } catch (_) {}
  } catch (_) {}
}

// ---

async function main() {
	loadUserPricing();

	// Config-declared harnesses must register before discovery.
	await loadExternalHarnesses();

	if (opts.showHelp) {
		console.log(renderWtftHelp(manifest, "wtft"));
		return;
	}
	if (opts.showWhy) {
		console.log(await renderWtftWhy(manifest, "wtft"));
		return;
	}
	if (opts.showVersion) {
		console.log(renderWtftVersion(manifest, import.meta.url));
		return;
	}

	// -p/--pager is a Pi TUI overlay only — refuse rather than silently drop or page.
	if (opts.pager) {
		console.error("❌ Error: -p/--pager is a Pi TUI overlay and is not available in the CLI. Pipe to a pager instead: wtft … | less -R");
		process.exit(1);
	}

	// ---
	// DAEMON MANAGEMENT COMMANDS: passthrough to wtft-daemon
	// ---
	if (opts.daemonList || opts.daemonCleanup || opts.daemonRestart || opts.daemonStop) {
		const daemonPath = path.join(daemonDir, "wtft-daemon.mjs");
		const daemonArgs = [daemonPath];
		if (opts.daemonList) daemonArgs.push("--list");
		if (opts.daemonCleanup) daemonArgs.push("--cleanup");
		if (opts.daemonRestart) daemonArgs.push("--restart");
		if (opts.daemonStop) daemonArgs.push("--stop", opts.daemonStop);
		try {
			const result = execSync(`${process.execPath} ${daemonArgs.join(" ")}`, {
				encoding: "utf8",
				timeout: 10000
			});
			if (result) console.log(result.trim());
		} catch (err: any) {
			if (err.stdout) console.log(err.stdout.trim());
			if (err.stderr) console.error(err.stderr.trim());
		}
		return;
	}

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

	// ---
	// --force: kill existing daemon, delete tag file, re-parse from scratch.
	// ---
	if (opts.forceReparse) {
		const forceTagPath = getTagPath(finalSessionPath);
		const forcePidPath = getDaemonPidPath(finalSessionPath);
		try {
			const pid = parseInt(fs.readFileSync(forcePidPath, "utf8").trim(), 10);
			if (pid > 0) {
				try { process.kill(pid, "SIGTERM"); } catch {}
			}
			try { fs.unlinkSync(forcePidPath); } catch {}
		} catch {}
		const forceTagsDir = path.dirname(forceTagPath);
		const forceSessionBase = path.basename(finalSessionPath);
		try {
			for (const f of fs.readdirSync(forceTagsDir)) {
				if (f.startsWith(forceSessionBase + ".wtft-tag.v") && f.endsWith(".jsonl")) {
					fs.unlinkSync(path.join(forceTagsDir, f));
				}
			}
		} catch {}
		console.error(`\x1b[33mForce re-parse: killed daemon + deleted tag files for ${path.basename(finalSessionPath)}\x1b[0m`);
	}

	// ---
	// WATCH MODE: spawn daemon, watch tag file (not session.jsonl).
	// ---
	if (opts.showWatch) {

		// Same resolution the writer uses — do not hand-build the path (moved sessions).
		const tagPath = getCurrentVersionTagPath(finalSessionPath);

		const daemonPath = path.join(daemonDir, "wtft-daemon.mjs");
		const daemonChild = spawnWtftDaemon(finalSessionPath, daemonDir);
		if (!daemonChild) {
			console.error(`\x1b[31m❌ Failed to start log parser daemon: ${daemonPath}\x1b[0m`);
			process.exit(1);
		}

		// No pre-sleep: watchTagFile waits on daemon state; reader catches up from lastReadOffset.
		await watchTagFile(finalSessionPath, tagPath, {
			daemonChild,
			interval: opts.hasInterval ? opts.interval : "1h",
			limit: opts.hasLimit ? opts.limit : 100,
			mode: opts.hasMode ? opts.mode : "cumulative",
			showTicks: opts.hasTicks ? opts.showTicks : true,
			timezone: opts.hasTimezone ? opts.timezone : undefined,
			unit,
			daemonPath,
			pad: opts.pad,
			hasInterval: opts.hasInterval,
			hasLimit: opts.hasLimit,
			hasMode: opts.hasMode,
			hasTicks: opts.hasTicks,
			hasTimezone: opts.hasTimezone,
			disabledEmoji: typeof opts.enableEmoji === "boolean" ? !opts.enableEmoji : undefined,
		});
		return; // watchTagFile never returns until SIGINT
	}

	// ---
	// NON-WATCH MODE: spawn daemon, read classified tag file, render.
	// ---

	// getTagPath (not getCurrentVersionTagPath): one-shot read — a stale-version tag is still data.
	const tagPath = getTagPath(finalSessionPath);

	const daemonChild = spawnWtftDaemon(finalSessionPath, daemonDir);
	if (!daemonChild) {
		console.error(`\x1b[31m❌ wtft-daemon not found at ${path.join(daemonDir, "wtft-daemon.mjs")}\x1b[0m`);
		process.exit(1);
	}

	let interactions: Interaction[] = [];
	// Capture verdict WITH interactions — one readFileSync; re-deriving later can straddle a daemon sweep.
	let provisional: ReturnType<typeof readTagProvisional> = { provisional: false, reason: null };
	let folded = new Set<string>();
	if (fs.existsSync(tagPath)) {
		({ interactions, provisional, folded } = readTagFileWithVerdict(tagPath));
	}

	// Memoised lineage. No try/catch: computeSpawnTree reports ledger failure as ledgerError.
	// Keyed by mode: the pending tree excludes nothing and must never serve a full arm.
	const spawnTreeCache = new Map<boolean, SpawnTree>();
	// `pending`: the session log is absent, so nothing of it is in SELF to exclude.
	const sessionSpawnTree = (opt: { pending?: boolean } = {}): SpawnTree => {
		const pending = opt.pending === true;
		const cached = spawnTreeCache.get(pending);
		if (cached) return cached;
		const sessionId = path.basename(finalSessionPath).replace(/\.jsonl$/i, "");
		// SELF is the tag, so the ids to exclude are the ones the tag recorded folding.
		const tree = computeSpawnTree(sessionId, {
			alreadyAttributed: pending ? new Set<string>() : folded,
			unrecorded: pending
				? { turns: [], rootCwd: null }
				: { turns: interactions, rootCwd: resolveLastCwd(finalSessionPath) },
		});
		spawnTreeCache.set(pending, tree);
		// The tree never replaces a reason already set.
		if (!provisional.provisional && tree.edges.some(e => e.live)) {
			provisional = { provisional: true, reason: "descendant-live" };
		}
		return tree;
	};

	// ---
	// Blind-spot scan — hoisted: counts uncounted billables AND may downgrade provisional.
	// Memoised: at most one scan per run.
	// ---
	let uncountedCache: UncountedBillables | null = null;
	let discoveryCache: { files: string[]; unreadable: Error | null } | null = null;
	const discoverOnce = (): { files: string[]; unreadable: Error | null } => {
		if (discoveryCache) return discoveryCache;
		try {
			return (discoveryCache = discoverSubagentSessionFiles(finalSessionPath));
		} catch (err) {
			// Cache a dir-level throw so later callers cannot re-run and disagree.
			return (discoveryCache = { files: [], unreadable: err instanceof Error ? err : new Error(String(err)) });
		}
	};
	const scanSessionUncounted = (): UncountedBillables => {
		if (uncountedCache) return uncountedCache;
		// Absent session file is lagging, not unreadable — zeros, verdict untouched.
		if (!fs.existsSync(finalSessionPath)) return (uncountedCache = newUncountedBillables());
		let uncounted = newUncountedBillables();
		uncounted = addUncountedBillables(uncounted, scanUncountedBillables(finalSessionPath));
		let subagentFiles: string[] = [];
		{
			const discovered = discoverOnce();
			subagentFiles = discovered.files;
			if (discovered.unreadable) {
				// Direct evidence: restore-readability is the remedy (daemon cannot rebuild while unreadable).
				provisional = { provisional: true, reason: "subagent-unreadable" };
			}
		}
		for (const sub of subagentFiles) {
			// Listed ≠ readable — a refused read still degrades the verdict.
			const scanned = scanUncountedBillablesChecked(sub);
			uncounted = addUncountedBillables(uncounted, scanned.counts);
			if (!scanned.readable) provisional = { provisional: true, reason: "subagent-unreadable" };
		}
		return (uncountedCache = uncounted);
	};


	// ---
	// --json emitter — empty paths between here and the `--json` return also emit JSON.
	// Scan before reading provisional (scan may reassign it). Exit code set here so $?
	// and the field always agree. Latched provisional stderr for empty + full `--json` arms
	// (rendered full report prints its own two-line form).
	// ---
	let warnedProvisional = false;
	const warnProvisionalOnce = () => {
		if (warnedProvisional || !provisional.provisional) return;
		warnedProvisional = true;
		console.error(`\x1b[33m⚠ PROVISIONAL: ${describeProvisionalReason(provisional, tagPath)}. ${describeProvisionalRemedy(provisional)}. Exit ${EXIT_PROVISIONAL}.\x1b[0m`);
	};

	// `pending` pins "file absent" decided before awaitDaemonUp — do not re-derive after.
	const finishEmptyReport = (opt: { pending?: boolean } = {}) => {
		if (!opt.pending) scanSessionUncounted();
		// Before the warning and the exit code: the tree can set `provisional`.
		const emptyArmTree = opts.tokens ? renderSpawnTree(emptyTotals(), sessionSpawnTree({ pending: opt.pending })) : "";
		warnProvisionalOnce();
		// SPAWNED block under `--tokens` even when own total is empty (matches populated path).
		if (emptyArmTree) process.stdout.write(emptyArmTree);
		// exitCode, never process.exit — stdout is async on a pipe.
		process.exitCode = provisional.provisional ? EXIT_PROVISIONAL : 0;
	};

	/** Subagents this session spawned. `rows` omitted (not `[]`) when discovery was incomplete. */
	const collectSubagentJson = (): { rows: WtftSubagentJson[] | undefined; notices: WtftNotice[] } | undefined => {
		if (!fs.existsSync(finalSessionPath)) return undefined;
		const discovered = discoverOnce();
		const notices: WtftNotice[] = [];
		const rows = discovered.files.map(transcript => {
			const read = readSubagentMetaChecked(transcript);
			if (read.error) {
				notices.push({ code: "subagent-meta-unreadable", text: `subagent metadata could not be read (${read.metaPath}): ${read.error.message}` });
			}
			return { transcript, meta: read.meta };
		});
		return { rows: discovered.unreadable ? undefined : rows, notices };
	};

	const emitSessionJson = (opt: { notices?: WtftNotice[]; pending?: boolean } = {}) => {
		const uncounted = opt.pending ? newUncountedBillables() : scanSessionUncounted();
		const subagentJson = opt.pending ? undefined : collectSubagentJson();
		// Before `provisional` is read: the tree can set it.
		const spawned = sessionSpawnTree({ pending: opt.pending });
		const doc = buildSessionJson({
			interactions,
			session: {
				path: finalSessionPath,
				harness: opt.pending ? null : detectSessionHarness(finalSessionPath),
				taggerVersion: String(WTFT_TAGGER_VERSION),
				tagPath,
			},
			provisional,
			uncounted,
			// Ledger read on pending too — a handmade empty tree would claim "looked, found nothing".
			spawned,
			// Omit key when incomplete — empty array means "looked, found none".
			...(subagentJson?.rows ? { subagents: subagentJson.rows } : {}),
			notices: [
				...(opt.notices ?? []),
				...(subagentJson?.notices ?? []),
				// Every arm, empty ones included: the tree can make a pending report provisional.
				...(provisional.provisional
					? [{ code: "provisional" as const, text: `${describeProvisionalReason(provisional, tagPath)}. ${describeProvisionalRemedy(provisional)}.` }]
					: []),
			],
		});
		process.stdout.write(renderSessionJson(doc));
		warnProvisionalOnce();
		process.exitCode = provisional.provisional ? EXIT_PROVISIONAL : 0;
	};
	// Unwritten session log: daemon is parked on it. Wait only to verify the claim before saying so.
	if (interactions.length === 0 && !fs.existsSync(finalSessionPath)) {
		const DAEMON_START_CEILING_MS = 5000;
		const startup = await awaitDaemonUp(finalSessionPath, daemonChild, DAEMON_START_CEILING_MS);
		if (startup.state === "dead") {
			const how = startup.signalCode ? `on ${startup.signalCode}` : `with code ${startup.exitCode}`;
			console.error(`\x1b[31m❌ wtft-daemon exited ${how} before claiming this session — nothing is waiting on ${finalSessionPath}\x1b[0m`);
			console.error(`\x1b[90mExpected the daemon at ${path.join(daemonDir, "wtft-daemon.mjs")}\x1b[0m`);
			process.exit(1);
		}
		const pendingText = `Session log not written yet: ${finalSessionPath}. ` +
			`A harness writes its first line after the first real prompt (not a /command) completes. ` +
			`The log parser daemon is running and waiting on it — run again after the first response, or use --watch to stay attached.`;
		if (opts.json) {
			console.error(`\x1b[33m${pendingText}\x1b[0m`);
			emitSessionJson({ notices: [{ code: "pending-session", text: pendingText }], pending: true });
			return;
		}
		console.log(`\x1b[33mSession log not written yet: ${finalSessionPath}\x1b[0m`);
		console.log(`\x1b[90mA harness writes its first line after the first real prompt (not a /command) completes. ` +
			`The log parser daemon is running and waiting on it — run again after the first response, or use --watch to stay attached.\x1b[0m`);
		finishEmptyReport({ pending: true });
		return;
	}
	if (interactions.length === 0) {
		const tagWaitStart = Date.now();
		while (Date.now() - tagWaitStart < 1400) {
			if (fs.existsSync(tagPath)) {
				({ interactions, provisional, folded } = readTagFileWithVerdict(tagPath));
				if (interactions.length > 0) break;
			}
			await new Promise(r => setTimeout(r, 667));
		}
	}
	if (interactions.length === 0) {
		const sessionName = path.basename(finalSessionPath).replace(/.jsonl$/, "");
		// Ceiling 0: tag wait already spent the time; one-shot state check.
		const startup = await awaitDaemonUp(finalSessionPath, daemonChild, 0);
		if (startup.state === "dead") {
			const how = startup.signalCode ? `on ${startup.signalCode}` : `with code ${startup.exitCode}`;
			console.error(`\x1b[31m❌ wtft-daemon exited ${how} before writing any classified data for session ${sessionName.slice(0, 12)}….\x1b[0m`);
			process.exit(1);
		}
		const noDataText = `Daemon started on session ${sessionName.slice(0, 12)}… — no data yet. Try again in a moment.`;
		if (opts.json) {
			console.error(`\x1b[33m${noDataText}\x1b[0m`);
			emitSessionJson({ notices: [{ code: "no-data", text: noDataText }] });
			return;
		}
		console.log(`\x1b[33m${noDataText}\x1b[0m`);
		finishEmptyReport();
		return;
	}

	const config = readConfig(WTFT_CONFIG_TOOL, WTFT_CONFIG_DIR);
	// CLI flags override persisted emoji for this run only (CLI does not writeConfig).
	const disabledEmoji = typeof opts.enableEmoji === "boolean" ? !opts.enableEmoji : isEmojiDisabled();
	const sessionInterval = (typeof config.interval === "string" ? config.interval : undefined) as string | undefined;
	const sessionLimit = (typeof config.limit === "number" ? config.limit : undefined) as number | undefined;
	const sessionMode = (config.mode === "cumulative" || config.mode === "bucket" ? config.mode : undefined) as "cumulative" | "bucket" | undefined;
	const sessionShowTicks = (typeof config.showTicks === "boolean" ? config.showTicks : undefined) as boolean | undefined;
	const sessionTimezone = (typeof config.timezone === "string" ? config.timezone : undefined) as string | undefined;
	// ---
	showReapWarnings();


	// ---
	// --json: one object on stdout, before any renderer writes there.
	// ---
	if (opts.json) {
		const notices: WtftNotice[] = [];
		for (const m of collectUnpricedModels(interactions)) {
			notices.push({ code: "unpriced-model", text: unpricedModelWarning(m) });
			console.error(`\x1b[33m⚠ ${unpricedModelWarning(m)}\x1b[0m`);
		}
		emitSessionJson({ notices });
		return;
	}


	// ---

	const termColumns = getTerminalWidth();
	let pad = opts.hasPad ? opts.pad : 1;
	const maxPad = Math.max(0, Math.floor(termColumns / 2) - 1);
	pad = Math.min(pad, maxPad);
	const padStr = " ".repeat(pad);
	const paddedWidth = termColumns - 2 * pad;
	const finalInterval = opts.hasInterval ? opts.interval : (sessionInterval ?? "1h");
	const finalLimit = opts.hasLimit ? opts.limit : (sessionLimit ?? 100);
	const finalMode = opts.hasMode ? opts.mode : (sessionMode ?? "cumulative");
	const finalShowTicks = opts.hasTicks ? opts.showTicks : (sessionShowTicks ?? true);
	const finalTimezone = opts.hasTimezone ? opts.timezone : sessionTimezone;

	const defaultSettings = {
		interval: "1h",
		limit: 100,
		width: Math.min(paddedWidth, 1023),
		showTicks: true,
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: undefined
	};

	const outputLines = buildWtftLines(interactions, defaultSettings, {
		interval: finalInterval,
		limit: finalLimit,
		width: Math.min(paddedWidth, 1023),
		showTicks: finalShowTicks,
		mode: finalMode,
		timezone: finalTimezone,
		disabledEmoji,
		sessionNameSuffix: path.basename(finalSessionPath),
		unit,
	});

	if (!outputLines) {
		console.log(padStr + "No binned data found in session logs.");
		process.exit(0);
	}

	console.log(padStr + `\x1b[90m${finalSessionPath}\x1b[0m`);
	for (const line of outputLines) {
		console.log(padStr + line);
	}

	if (opts.other) {
		console.log("");
		const dedupedInteractions = deduplicateInteractions(interactions);
		const otherOutput = renderOtherHistogram(dedupedInteractions, Math.min(paddedWidth, 1023));
		for (const line of otherOutput.split("\n")) {
			console.log(padStr + line);
		}
	}

	if (opts.tokens) {
		const tokenOutput = renderTokenSummary(interactions, Math.min(paddedWidth, 1023), opts.thinkingBudget, scanSessionUncounted(), sessionSpawnTree());
		for (const line of tokenOutput.split("\n")) {
			console.log(padStr + line);
		}
	}

	// ---
	// UNPRICED-MODEL WARNING — re-derived from tag model ids (costs live in the daemon).
	// ---
	for (const m of collectUnpricedModels(interactions)) {
		console.error(`\x1b[33m⚠ ${unpricedModelWarning(m)}\x1b[0m`);
	}

	// ---
	// PROVISIONAL READ — print the total, say it may still grow. Exit code reports
	// what this run checked (plain wtft does not scan subagents; --tokens/--json do).
	// ---
	if (provisional.provisional) {
		const why = describeProvisionalReason(provisional, tagPath);
		console.error(`\x1b[33m⚠ PROVISIONAL: a number in this report may still change — ${why}.\x1b[0m`);
		const remedy = describeProvisionalRemedy(provisional);
		console.error(`\x1b[90m  ${remedy}. Exit ${EXIT_PROVISIONAL}.\x1b[0m`);
		process.exitCode = EXIT_PROVISIONAL;
		return;
	}
}

if (process.argv[1]) {
	const entry = fileURLToPath(import.meta.url);
	const invoked = process.argv[1];
	if (invoked === entry || invoked.endsWith("/wtft") || invoked.endsWith("/wtft.mjs")) {
		if (isSpawnRecord) {
			const result = runSpawnRecordCommand(process.argv.slice(3));
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
			process.exitCode = result.exitCode;
		} else {
			main().catch(err => {
				console.error(`❌ System Error: ${err.message}`);
				process.exit(1);
			});
		}
	}
}
