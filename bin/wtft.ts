#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @command wtft
 * @description Command-line cost auditing tool for Pi Coding Agent session logs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildWtftLines,
	parseSessionFile,
	parseEntryToInteraction,
	classifyInteraction,
	renderOtherHistogram,
	renderTokenSummary,
	deduplicateInteractions,
	scanUncountedBillables,
	newUncountedBillables,
	addUncountedBillables,
	readUncountedBillableClass,
	renderUncountedBillables,
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
	attributeClaudeSubAgentCosts,
	parseInterval,
	getBinInfo,
	calculateClaudeCost,
	calculateServerToolCost,
	distributeHalfSlots,
	halfSlotCountsToArray,
	renderHalfBlockBar,
	CATEGORY_ORDER,
	watchTagFile,
	readClassifiedTagFile,
	getDaemonPidPath,
	getTagPath,
	awaitDaemonUp,
	checkDaemonHealth,
	IDLE_THRESHOLD_MS,
	WTFT_TAGGER_VERSION,
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
	resolveCwdHistory,
	pickLiveCwd,
	pathExists,
	cwdToSlug,
	cwdToStrictSlug,
	cwdSlugVariants,
	slugMatchesCwd,
	resetCwdCache,
	getCwdReadCount,
	getCwdHistoryReadCount,
	type WatchSettings,
	type Interaction,
	type ModelPricing,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";
import { execSync } from "node:child_process";
import { loadConfig, readConfig } from "../extensions/lib/config.ts";
import {
	discoverSessions,
	harnessLabel,
	selectSessionPrompt
} from "../extensions/lib/session-selector.ts";
import { buildDisplayPath } from "../extensions/lib/session-path-shortener.ts";
import { findRepoRoot, listWorktreeDirs, fanOutCwd } from "../extensions/lib/harness/worktrees.ts";
import {
	parseWtftCliArgs,
	spawnWtftDaemon,
	isPendingSessionPath,
	isEmojiDisabled,
	renderWtftHelp,
	renderWtftWhy,
	renderWtftVersion,
} from "../extensions/lib/wtft-cli-shared.ts";

// ---
// Re-exports for test imports from built bin/wtft.mjs
// (the bundler tree-shakes unused imports; explicit exports keep them in the bundle)
// ---
export {
	calculateClaudeCost,
	calculateServerToolCost,
	resolveTieredRates,
	lookupModelPricing,
	MODEL_PRICING,
	// Pricing registry + miss-path (#139/#140)
	applyUserPricing,
	isModelPriced,
	loadUserPricing,
	getUserPricingPath,
	parseEntryToInteraction,
	classifyInteraction,
	buildWtftLines,
	parseSessionFile,
	deduplicateInteractions,
	renderTokenSummary,
	// Uncounted billables (#149) — counted blind spot, never priced
	scanUncountedBillables,
	newUncountedBillables,
	addUncountedBillables,
	readUncountedBillableClass,
	renderUncountedBillables,
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
	attributeClaudeSubAgentCosts,
	parseInterval,
	getBinInfo,
	distributeHalfSlots,
	halfSlotCountsToArray,
	renderHalfBlockBar,
	CATEGORY_ORDER,
	serializeClassified,
	classifiedToInteraction,
	readClassifiedTagFile,
	getTerminalWidth,
	WTFT_TAGGER_VERSION,
	// Daemon lifecycle (#95) — takeover/idle-clamp/TTL tests
	checkDaemonHealth,
	getTagPath,
	getDaemonPidPath,
	IDLE_THRESHOLD_MS,
	// Phase 3 overhead classes (#52) — meter-split + interrupt tests
	splitOverheadCost,
	serializeClassifiedWithOverheadSplit,
	isInterruptMarker,
	// Harness seam (#156) + moved-session follow (#155)
	discoverSessions,
	harnessLabel,
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
	// Session discovery: slug encodings (#144), relocation history (#164),
	// worktree fan-out (#145)
	resolveCwdHistory,
	pickLiveCwd,
	pathExists,
	cwdToStrictSlug,
	cwdSlugVariants,
	slugMatchesCwd,
	getCwdHistoryReadCount,
	buildDisplayPath,
	findRepoRoot,
	listWorktreeDirs,
	fanOutCwd
};

// ---
// CONFIG + ARG PARSING
// ---

// Load config file (#20) — overrides hardcoded defaults, CLI flags override both
const cfg = loadConfig("wtft", { interval: "1h", limit: 100, mode: "cumulative" }) as {
	interval?: string;
	limit?: number;
	mode?: "bucket" | "cumulative";
	timezone?: string;
	tokens?: boolean;
};

const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "wtft-cmd.json");
const daemonDir = path.dirname(fileURLToPath(import.meta.url));

// Parse all CLI args through the shared parser (#94)
const opts = parseWtftCliArgs(process.argv.slice(2));

// Derive unit from CLI flags or config default
let unit: "cost" | "tokens" = cfg.tokens ? "tokens" : "cost";
if (opts.hasTokens) unit = "tokens";
if (opts.hasCost) unit = "cost";

const WARN_LOG = path.join(os.homedir(), ".local", "state", "wtft", "reap.log");

/** Surface reap warnings from the last daemon spawn (#130). */
function showReapWarnings() {
  try {
    if (!fs.existsSync(WARN_LOG)) return;
    const content = fs.readFileSync(WARN_LOG, "utf8").trim();
    if (!content) return;
    const lines = content.split("\n");
    // Only show warnings from the last hour (avoid stale repeats)
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
      // Color-code: KILLED = red, WARN = yellow
      const isKilled = line.includes("KILLED");
      const prefix = isKilled ? "\x1b[31m" : "\x1b[33m";
      console.error(`${prefix}│ ${line}\x1b[0m`);
    }
    console.error("\x1b[33m└──────────────────────────────────────────────────────\x1b[0m\n");
    // Truncate log after showing (warnings have been surfaced)
    try { fs.truncateSync(WARN_LOG, 0); } catch (_) {}
  } catch (_) {}
}

// ---
// MAIN EXECUTION FLOW
// ---

async function main() {
	// User pricing registry (#140) — merge ~/.config overrides before any
	// cost math in this process (tree-navigation divergence, renderers).
	// The daemon loads it independently for tag-file cost computation.
	loadUserPricing();

	// Out-of-tree harnesses (#156) — config-declared modules must register
	// before any discovery. Built-ins need no load step.
	await loadExternalHarnesses();

	// Early exits for display-only flags (#94)
	if (opts.showHelp) {
		console.log(renderWtftHelp(manifestPath, "wtft"));
		return;
	}
	if (opts.showWhy) {
		console.log(await renderWtftWhy(manifestPath, "wtft"));
		return;
	}
	if (opts.showVersion) {
		console.log(renderWtftVersion(manifestPath, import.meta.url));
		return;
	}

	// -p/--pager opens a Pi TUI overlay (extensions/wtft.ts) — there is no overlay to
	// open out here, and the flag used to be parsed and silently dropped (#153). The
	// manifest already documented it as TUI-only; only the code disagreed. Refuse
	// rather than page: `| less -R` already does this correctly, and implementing it
	// would commit the CLI to a subprocess, TTY detection, and the SIGPIPE path.
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

	const candidates = discoverSessions(opts.harnessOption, opts.cwdOverride);
	
	let finalSessionPath = "";
	// #308: a session .jsonl that does not exist YET is a known-lagging path, not an
	// error. Claude Code fixes the session id — and so the transcript path — at launch,
	// but writes the first line only after the first real prompt (not a /command)
	// completes. The daemon has waited on that file since #124/#129; the CLI must
	// state that fact instead of "does not exist". Only an absolute *.jsonl path
	// qualifies — a fuzzy substring that matches nothing is still an error below.
	let sessionPending = false;
	if (opts.targetSession) {
		// Direct path — use as-is if it exists
		if (fs.existsSync(opts.targetSession)) {
			finalSessionPath = opts.targetSession;
		} else if (isPendingSessionPath(opts.targetSession)) {
			finalSessionPath = opts.targetSession;
			sessionPending = true;
		} else {
			// Fuzzy substring filter against discovered sessions
			const filter = opts.targetSession.toLowerCase();
			const filtered = candidates.filter(c =>
				c.path.toLowerCase().includes(filter) ||
				c.name.toLowerCase().includes(filter)
			);
			if (filtered.length === 0) {
				console.error(`❌ Error: Session '${opts.targetSession}' does not exist as a file and matches no discovered sessions (${candidates.length} available).`);
				process.exit(1);
			} else if (filtered.length === 1) {
				finalSessionPath = filtered[0].path;
			} else {
				finalSessionPath = await selectSessionPrompt(filtered);
			}
		}
	} else {
		// Auto select or show selector prompt
		if (candidates.length === 0) {
			console.error("❌ Error: No active session log files found. Ensure Pi or Claude has been run, or specify an explicit session log path with -s.");
			process.exit(1);
		} else if (candidates.length === 1) {
			finalSessionPath = candidates[0].path;
		} else {
			// Show select menu!
			finalSessionPath = await selectSessionPrompt(candidates);
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
		// Kill existing daemon
		try {
			const pid = parseInt(fs.readFileSync(forcePidPath, "utf8").trim(), 10);
			if (pid > 0) {
				try { process.kill(pid, "SIGTERM"); } catch {}
			}
			try { fs.unlinkSync(forcePidPath); } catch {}
		} catch {}
		// Delete tag file (and any stale-version tag files)
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
	// WATCH MODE: enter live re-render loop (#45, #53)
	// Spawns the wtft-daemon for classified tag output, then watches the
	// tag file via inotify (fs.watch) instead of polling session.jsonl.
	// ---
	if (opts.showWatch) {

		// Tag file path — ASK, do not assemble (#309 review). Hand-building the
		// own-dir path here quietly opted the CLI out of #155: a session that
		// changed project dirs keeps its tag file in the old dir, and the daemon
		// adopts it rather than starting a second one. getCurrentVersionTagPath is
		// the same resolution the writer uses, so reader and writer cannot disagree
		// about where the file is. (watchTagFile re-resolves too, for a move that
		// happens after this line.)
		const tagPath = getCurrentVersionTagPath(finalSessionPath);

		// Auto-spawn daemon if not already running (singleton via PID file).
		const daemonPath = path.join(daemonDir, "wtft-daemon.mjs");
		const daemonChild = spawnWtftDaemon(finalSessionPath, daemonDir);
		if (!daemonChild) {
			console.error(`\x1b[31m❌ Failed to start log parser daemon: ${daemonPath}\x1b[0m`);
			process.exit(1);
		}

		// No pre-sleep here (#308): watchTagFile waits for the tag file on daemon
		// STATE (tag present / lease held / child exited), and its reader catches
		// up from lastReadOffset, so nothing written before the watch attaches is
		// lost. A fixed delay was a guess standing in for that check.
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
		});
		return; // watchTagFile never returns until SIGINT
	}

	// ---
	// NON-WATCH MODE: spawn daemon, read classified tag file, render.
	// Both watch and non-watch now read from the same tag file format —
	// the daemon is the sole harness→tag converter.
	// ---

	// Resolve the tag path, same as watch mode above (#309 review). getTagPath —
	// not getCurrentVersionTagPath — because this is a one-shot READ: a stale
	// version's tag is still data worth charting, and nothing here attaches an
	// fs.watch that the daemon's startup sweep could pull out from under us.
	const tagPath = getTagPath(finalSessionPath);

	// Auto-spawn daemon (singleton via PID file).
	const daemonChild = spawnWtftDaemon(finalSessionPath, daemonDir);
	if (!daemonChild) {
		console.error(`\x1b[31m❌ wtft-daemon not found at ${path.join(daemonDir, "wtft-daemon.mjs")}\x1b[0m`);
		process.exit(1);
	}

	let interactions: Interaction[] = [];
	if (fs.existsSync(tagPath)) {
		interactions = readClassifiedTagFile(tagPath);
	}
	// #308: nothing to wait for while the session log itself is unwritten — the
	// daemon is parked on it (heartbeating) and will parse the first line when it
	// lands. Say so and exit 0: a one-shot CLI must not block, and "not written yet"
	// is the true state. Only an existing-but-unclassified session earns the short
	// wait below.
	if (interactions.length === 0 && !fs.existsSync(finalSessionPath)) {
		// "The daemon is running and waiting on it" is the whole value of this
		// message, and it was never checked (#309 review): spawnWtftDaemon only
		// proves spawn() did not throw, so a daemon that dies during startup
		// printed reassurance and exited 0. Nothing else in this branch ever looks
		// at the daemon again — this is the last chance to tell the truth.
		//
		// State, not a stopwatch: a healthy daemon claims its lease in a poll or
		// two, so the ceiling only bounds the case where the child is alive and has
		// claimed nothing — and that case still exits 0, because a slow box is not
		// a failure.
		const DAEMON_START_CEILING_MS = 5000;
		const startup = await awaitDaemonUp(finalSessionPath, daemonChild, DAEMON_START_CEILING_MS);
		if (startup.state === "dead") {
			const how = startup.signalCode ? `on ${startup.signalCode}` : `with code ${startup.exitCode}`;
			console.error(`\x1b[31m❌ wtft-daemon exited ${how} before claiming this session — nothing is waiting on ${finalSessionPath}\x1b[0m`);
			console.error(`\x1b[90mExpected the daemon at ${path.join(daemonDir, "wtft-daemon.mjs")}\x1b[0m`);
			process.exit(1);
		}
		console.log(`\x1b[33mSession log not written yet: ${finalSessionPath}\x1b[0m`);
		console.log(`\x1b[90mClaude Code writes its first line after the first real prompt (not a /command) completes. ` +
			`The wtft daemon is running and waiting on it — run again after the first response, or use --watch to stay attached.\x1b[0m`);
		process.exit(0);
	}
	if (interactions.length === 0) {
		// Wait up to 2 daemon beats for the freshly-spawned daemon to produce the tag file.
		const tagWaitStart = Date.now();
		while (Date.now() - tagWaitStart < 1400) {
			if (fs.existsSync(tagPath)) {
				interactions = readClassifiedTagFile(tagPath);
				if (interactions.length > 0) break;
			}
			await new Promise(r => setTimeout(r, 667));
		}
	}
	if (interactions.length === 0) {
		const sessionName = path.basename(finalSessionPath).replace(/.jsonl$/, "");
		// A daemon we spawned that already died is a fact worth more than "try again"
		// (#308). Same proof rule as the pending branch (#309 review): the child gone
		// by exit code OR signal, and no live lease — a child that exited 0 because an
		// older daemon owns the session is up, not dead. Ceiling 0: the tag wait above
		// already spent the time; this is a one-shot read of the state.
		const startup = await awaitDaemonUp(finalSessionPath, daemonChild, 0);
		if (startup.state === "dead") {
			const how = startup.signalCode ? `on ${startup.signalCode}` : `with code ${startup.exitCode}`;
			console.error(`\x1b[31m❌ wtft-daemon exited ${how} before writing any classified data for session ${sessionName.slice(0, 12)}….\x1b[0m`);
			process.exit(1);
		}
		console.log(`\x1b[33mDaemon started on session ${sessionName.slice(0, 12)}… — no data yet. Try again in a moment.\x1b[0m`);
		process.exit(0);
	}

	// Read settings from harness-agnostic config file (#72).
	const config = readConfig("wtft");
	const disabledEmoji = isEmojiDisabled();
	const sessionInterval = (typeof config.interval === "string" ? config.interval : undefined) as string | undefined;
	const sessionLimit = (typeof config.limit === "number" ? config.limit : undefined) as number | undefined;
	const sessionMode = (config.mode === "cumulative" || config.mode === "bucket" ? config.mode : undefined) as "cumulative" | "bucket" | undefined;
	const sessionShowTicks = (typeof config.showTicks === "boolean" ? config.showTicks : undefined) as boolean | undefined;
	const sessionTimezone = (typeof config.timezone === "string" ? config.timezone : undefined) as string | undefined;
	// ---
	// REAP WARNINGS: surface any reap.log findings from daemon spawn (#130)
	// ---
	showReapWarnings();

	// ---
	// COMPILING AND PRINTING
	// ---

	const termColumns = getTerminalWidth();
	// Pad: default 1 to match Pi TUI widget's enforced 1-space padding.
	// Clamp to valid range (max: floor(term/2)-1).
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

	// Session file path above chart (once)
	console.log(padStr + `\x1b[90m${finalSessionPath}\x1b[0m`);
	for (const line of outputLines) {
		console.log(padStr + line);
	}

	if (opts.other) {
		console.log(""); // empty line spacer
		const dedupedInteractions = deduplicateInteractions(interactions);
		const otherOutput = renderOtherHistogram(dedupedInteractions, Math.min(paddedWidth, 1023));
		for (const line of otherOutput.split("\n")) {
			console.log(padStr + line);
		}
	}

	if (opts.tokens) {
		// Blind-spot scan (#149) reads the raw session files, never the tag file:
		// the events it counts leave no interaction behind, so nothing the daemon
		// serializes could carry them. Subagent files are scanned too — a
		// compaction inside a subagent is just as invisible as one in the parent.
		let uncounted = newUncountedBillables();
		uncounted = addUncountedBillables(uncounted, scanUncountedBillables(finalSessionPath));
		for (const sub of discoverSubagentSessionFiles(finalSessionPath)) {
			uncounted = addUncountedBillables(uncounted, scanUncountedBillables(sub));
		}
		const tokenOutput = renderTokenSummary(interactions, Math.min(paddedWidth, 1023), opts.thinkingBudget, uncounted);
		for (const line of tokenOutput.split("\n")) {
			console.log(padStr + line);
		}
	}

	// ---
	// UNKNOWN-MODEL WARNING (#140): one stderr line per distinct model that
	// priced at fallback defaults. Costs are computed in the daemon process,
	// so the miss is re-derived here from the tag file's model ids rather
	// than shared in-process state.
	// ---
	const unknownModels = new Set<string>();
	for (const i of interactions) {
		if (i.model && i.model !== "<synthetic>" && !isModelPriced(i.model)) {
			unknownModels.add(i.model);
		}
	}
	for (const m of unknownModels) {
		console.error(`\x1b[33m⚠ no pricing for ${m} — using default $3/$15 rates; totals may be unreliable. Add an entry to ${getUserPricingPath()} (no rebuild needed).\x1b[0m`);
	}
}

// Entry-point guard: only run main() when executed directly, not when imported
// (e.g. debug/verify-daemon-parse.mjs imports from the built bundle).
if (process.argv[1]) {
	const entry = fileURLToPath(import.meta.url);
	const invoked = process.argv[1];
	if (invoked === entry || invoked.endsWith("/wtft") || invoked.endsWith("/wtft.mjs")) {
		main().catch(err => {
			console.error(`❌ System Error: ${err.message}`);
			process.exit(1);
		});
	}
}
