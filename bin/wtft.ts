#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @command wtft
 * @description Command-line cost auditing tool for Pi Coding Agent session logs.
 */

import * as fs from "node:fs";
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
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
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
	type WatchSettings,
	type Interaction,
	type ModelPricing,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";
import { execSync } from "node:child_process";
import { loadConfig, readConfig } from "../extensions/lib/config.ts";
import {
	discoverSessions,
	selectSessionPrompt
} from "../extensions/lib/session-selector.ts";
import {
	parseWtftCliArgs,
	spawnWtftDaemon,
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
	parseEntryToInteraction,
	classifyInteraction,
	buildWtftLines,
	parseSessionFile,
	deduplicateInteractions,
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
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
	isInterruptMarker
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

// ---
// MAIN EXECUTION FLOW
// ---

async function main() {
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
		console.log(renderWtftVersion(manifestPath));
		return;
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
	if (opts.targetSession) {
		// Direct path — use as-is if it exists
		if (fs.existsSync(opts.targetSession)) {
			finalSessionPath = opts.targetSession;
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

	if (!finalSessionPath || !fs.existsSync(finalSessionPath)) {
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

		// Tag file path — always use the current version. The daemon
		// handles stale-version cleanup internally on startup.
		const sessionDir = path.dirname(finalSessionPath);
		const sessionBase = path.basename(finalSessionPath);
		const tagsDir = path.join(sessionDir, "wtft-tags");
		const tagPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

		// Auto-spawn daemon if not already running (singleton via PID file).
		const daemonPath = path.join(daemonDir, "wtft-daemon.mjs");
		if (!spawnWtftDaemon(finalSessionPath, daemonDir)) {
			console.error(`\x1b[31m❌ Failed to start log parser daemon: ${daemonPath}\x1b[0m`);
			process.exit(1);
		}

		// Wait briefly for daemon to write the first classified lines, then
		// enter the inotify-based watch loop.
		await new Promise(resolve => setTimeout(resolve, 500));
		await watchTagFile(finalSessionPath, tagPath, {
			interval: opts.hasInterval ? opts.interval : "1h",
			limit: opts.hasLimit ? opts.limit : 100,
			mode: opts.hasMode ? opts.mode : "cumulative",
			showTicks: opts.hasTicks ? opts.showTicks : true,
			timezone: opts.hasTimezone ? opts.timezone : undefined,
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

	// Compute tag path — always use the current version (no stale-version scan).
	const sessionDir = path.dirname(finalSessionPath);
	const sessionBase = path.basename(finalSessionPath);
	const tagsDir = path.join(sessionDir, "wtft-tags");
	const tagPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

	// Auto-spawn daemon (singleton via PID file).
	if (!spawnWtftDaemon(finalSessionPath, daemonDir)) {
		console.error(`\x1b[31m❌ wtft-daemon not found at ${path.join(daemonDir, "wtft-daemon.mjs")}\x1b[0m`);
		process.exit(1);
	}

	let interactions: Interaction[] = [];
	if (fs.existsSync(tagPath)) {
		interactions = readClassifiedTagFile(tagPath);
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
		console.log(`\x1b[33mDaemon started on session ${sessionName.slice(0, 12)}… — no data yet. Try again in a moment.\x1b[0m`);
		process.exit(0);
	}

	// Subagent rollup (#82): discover and merge subagent session interactions.
	// The daemon only classifies the main session file; subagent files are
	// raw-parsed and classified here. Walk is recursive up to Claude Code's
	// depth-5 limit.
	const subagentFiles = discoverSubagentSessionFiles(finalSessionPath);
	if (subagentFiles.length > 0) {
		const subInteractions = loadSubagentInteractions(subagentFiles);
		if (subInteractions.length > 0) {
			interactions = [...interactions, ...subInteractions];
			interactions.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
		}
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

	// --- Debug: compare tag file cost vs direct parse + dedup cost ---
	if (opts.debugMode) {
		const tagCost = interactions.reduce((sum: number, i: any) => sum + (i.cost || 0), 0);
		const rawInteractions = parseSessionFile(finalSessionPath);
		const directCost = deduplicateInteractions(rawInteractions).reduce((sum, i) => sum + i.cost, 0);
		console.log(padStr + `\x1b[90m── debug ─────────────────────────────────────────────\x1b[0m`);
		console.log(padStr + `\x1b[90m  tag file (daemon): $${tagCost.toFixed(4)}  (${interactions.length} entries)\x1b[0m`);
		console.log(padStr + `\x1b[90m  direct parse+dedup: $${directCost.toFixed(4)}  (${deduplicateInteractions(rawInteractions).length} entries)\x1b[0m`);
		console.log(padStr + `\x1b[90m  raw parse (no dedup): $${rawInteractions.reduce((sum, i) => sum + i.cost, 0).toFixed(4)}  (${rawInteractions.length} entries)\x1b[0m`);
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
		const tokenOutput = renderTokenSummary(interactions, Math.min(paddedWidth, 1023), opts.thinkingBudget);
		for (const line of tokenOutput.split("\n")) {
			console.log(padStr + line);
		}
	}
}

main().catch(err => {
	console.error(`❌ System Error: ${err.message}`);
	process.exit(1);
});
