/**
 * @package princess-pi-packages
 * @module wtft-cli-shared
 * @description Shared CLI/extension interface layer — argument parsing, daemon
 *   lifecycle, config reading, and manifest-driven help/why/version rendering.
 *   Consumed by both `extensions/wtft.ts` (Pi extension) and `bin/wtft.ts` (CLI).
 *
 *   #94: extracted from ~300 lines duplicated across both callers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { checkDaemonHealth, getTagPath, type DaemonStatus } from "./wtft-shared.js";
import { readConfig } from "./config.js";

// ---
// TYPES
// ---

export interface WtftCliOptions {
	// Shared
	showHelp: boolean;
	showWhy: boolean;
	showVersion: boolean;
	interval: string;
	hasInterval: boolean;
	limit: number;
	hasLimit: boolean;
	mode: "bucket" | "cumulative";
	hasMode: boolean;
	showTicks: boolean;
	hasTicks: boolean;
	timezone: string | undefined;
	hasTimezone: boolean;
	other: boolean;
	hasOther: boolean;
	tokens: boolean;
	hasTokens: boolean;
	cost: boolean;
	hasCost: boolean;
	forceReparse: boolean;
	// Extension-only
	hideWidget: boolean;
	showWidget: boolean;
	pager: boolean;
	width: number;
	hasWidth: boolean;
	enableEmoji: boolean | undefined;
	// CLI-only
	targetSession: string | undefined;
	cwdOverride: string | undefined;
	harnessOption: "auto" | "pi" | "claude-code";
	showWatch: boolean;
	pad: number;
	hasPad: boolean;
	daemonList: boolean;
	daemonCleanup: boolean;
	daemonRestart: boolean;
	daemonStop: string | undefined;
	thinkingBudget: number | undefined;
}

// ---
// ARGUMENT PARSING
// ---

/**
 * Parse CLI arguments (union of all flags from both Pi extension and CLI).
 * Each caller passes its argv however it likes — extension passes a split
 * string, CLI passes `process.argv.slice(2)`. Returns a typed options object;
 * callers destructure only what they need.
 *
 * Breaking: `-t` and `-T` shortcuts are intentionally NOT supported.
 * `-t` was overloaded across --timezone, --tokens, --ticks, and a planned
 * --turns. Use the full `--` names instead.
 */
export function parseWtftCliArgs(argv: string[]): WtftCliOptions {
	// --- defaults ---
	let showHelp = false;
	let showWhy = false;
	let showVersion = false;
	let interval = "1h";
	let limit = 10;
	let width = 80;
	let timezone: string | undefined = undefined;
	let hideWidget = false;
	let showWidget = false;
	let showTicks = true;
	let mode: "bucket" | "cumulative" = "cumulative";
	let pager = false;
	let other = false;
	let tokens = false;
	let cost = false;
	let enableEmoji: boolean | undefined = undefined;
	let forceReparse = false;

	let hasInterval = false;
	let hasLimit = false;
	let hasWidth = false;
	let hasTicks = false;
	let hasMode = false;
	let hasTimezone = false;
	let hasOther = false;
	let hasTokens = false;
	let hasCost = false;

	// CLI-only defaults
	let targetSession: string | undefined = undefined;
	let cwdOverride: string | undefined = undefined;
	let harnessOption: "auto" | "pi" | "claude-code" = "auto";
	let showWatch = false;
	let pad = 1;
	let hasPad = false;
	let daemonList = false;
	let daemonCleanup = false;
	let daemonRestart = false;
	let daemonStop: string | undefined = undefined;
	let thinkingBudget: number | undefined = undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		// --- shared flags ---
		if (arg === "--help" || arg === "-h") {
			showHelp = true;
		} else if (arg === "--version") {
			showVersion = true;
		} else if (arg === "--why") {
			showWhy = true;
		} else if (arg === "-o" || arg === "--other") {
			other = true;
			hasOther = true;
		} else if (arg === "--tokens" || arg === "--by-model") {
			// --by-model (#140): alias — the token summary IS the per-model
			// token/cost breakdown, one row per model id plus a TOTAL row.
			tokens = true;
			cost = false;
			hasTokens = true;
		} else if (arg === "--cost" || arg === "-C") {
			cost = true;
			tokens = false;
			hasCost = true;
		} else if (arg === "--force" || arg === "-F") {
			forceReparse = true;
		} else if (arg === "--ticks") {
			showTicks = true;
			hasTicks = true;
		} else if (arg === "--no-ticks") {
			showTicks = false;
			hasTicks = true;
		} else if (arg === "--cumulative" || arg === "-c") {
			mode = "cumulative";
			hasMode = true;
		} else if (arg === "--bucket" || arg === "-b") {
			mode = "bucket";
			hasMode = true;

		// --- extension-only flags ---
		} else if (arg === "--hide" || arg === "-H") {
			hideWidget = true;
		} else if (arg === "--show" || arg === "-S") {
			showWidget = true;
		} else if (arg === "--no-emojii" || arg === "--no-emoji") {
			enableEmoji = false;
		} else if (arg === "--emojii" || arg === "--emoji") {
			enableEmoji = true;
		} else if (arg === "--pager" || arg === "-p") {
			pager = true;

		// --- CLI-only flags ---
		} else if (arg === "-s" || arg === "--session") {
			targetSession = argv[++i];
		} else if (arg === "--dir" || arg === "--cwd") {
			cwdOverride = argv[++i];
		} else if (arg === "--harness") {
			const val = argv[++i];
			if (val === "pi" || val === "claude-code" || val === "auto") {
				harnessOption = val;
			}
		} else if (arg === "-W" || arg === "--watch") {
			showWatch = true;
		} else if (arg === "--pad") {
			const val = parseInt(argv[++i], 10);
			if (!isNaN(val) && val >= 0) {
				pad = val;
				hasPad = true;
			}
		} else if (arg === "--list") {
			daemonList = true;
		} else if (arg === "--cleanup") {
			daemonCleanup = true;
		} else if (arg === "--restart") {
			daemonRestart = true;
		} else if (arg === "--stop") {
			daemonStop = argv[++i];
		} else if (arg === "--thinking-budget") {
			const val = parseInt(argv[++i], 10);
			if (!isNaN(val) && val > 0) {
				thinkingBudget = val;
			}

		// --- valued flags (shared) ---
		} else if (arg === "-i" || arg === "--interval") {
			const val = argv[i + 1];
			if (val && /^(\d+)([mhdw]|t(?:urns?)?)$/.test(val)) {
				interval = val;
				hasInterval = true;
				i++;
			}
		} else if (arg === "-l" || arg === "--limit") {
			const val = argv[i + 1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				limit = num;
				hasLimit = true;
				i++;
			}
		} else if (arg === "-w" || arg === "--width") {
			const val = argv[i + 1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				width = num;
				hasWidth = true;
				i++;
			}
		} else if (arg === "--tz" || arg === "--timezone") {
			const val = argv[i + 1];
			if (val && !val.startsWith("-")) {
				timezone = val;
				hasTimezone = true;
				i++;
			}
		// --- valued flags (= syntax, extension already supports; CLI gets for free) ---
		} else if (arg.startsWith("--interval=")) {
			const val = arg.split("=")[1];
			if (val && /^(\d+)([mhdw]|t(?:urns?)?)$/.test(val)) {
				interval = val;
				hasInterval = true;
			}
		} else if (arg.startsWith("--limit=")) {
			const val = arg.split("=")[1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				limit = num;
				hasLimit = true;
			}
		} else if (arg.startsWith("--width=")) {
			const val = arg.split("=")[1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				width = num;
				hasWidth = true;
			}
		} else if (arg.startsWith("--tz=") || arg.startsWith("--timezone=")) {
			timezone = arg.split("=")[1];
			hasTimezone = true;
		}
	}

	return {
		showHelp, showWhy, showVersion,
		interval, hasInterval,
		limit, hasLimit,
		width, hasWidth,
		timezone, hasTimezone,
		hideWidget, showWidget,
		showTicks, hasTicks,
		mode, hasMode,
		pager,
		other, hasOther,
		tokens, hasTokens,
		cost, hasCost,
		enableEmoji,
		forceReparse,
		targetSession, cwdOverride, harnessOption,
		showWatch,
		pad, hasPad,
		daemonList, daemonCleanup, daemonRestart, daemonStop,
		thinkingBudget,
	};
}

// ---
// DAEMON LIFECYCLE
// ---

/**
 * Spawn the wtft-daemon for the given session. Returns the child process
 * or null on failure. Callers handle errors their own way.
 *
 * `daemonDir` is the directory containing `wtft-daemon.mjs`. Each caller
 * resolves this relative to its own location (extension: `../bin`, CLI: `.`).
 */
export function spawnWtftDaemon(sessionPath: string, daemonDir: string): ChildProcess | null {
	const daemonPath = path.join(daemonDir, "wtft-daemon.mjs");
	try {
		const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		return child;
	} catch {
		return null;
	}
}

// Module-level state for ensureDaemonRunning. Each caller environment
// (Pi extension, CLI process) gets its own instance — the CLI runs once
// and exits, so it naturally starts fresh every invocation.
let _daemonSessionPath: string | null = null;
let _daemonSpawned = false;
let _daemonSpawnedAt = 0; // Date.now() when the last spawn was attempted (#124)

/**
 * Ensure the wtft-daemon is running for the given session. If already
 * spawned for the same session, checks health; if dead, re-spawns.
 * Returns true if daemon is confirmed running (or was freshly spawned).
 */
export function ensureDaemonRunning(sessionPath: string, daemonDir: string): boolean {
	if (_daemonSpawned && _daemonSessionPath === sessionPath) {
		const tagPath = getTagPath(sessionPath);
		const health = checkDaemonHealth(sessionPath, tagPath);
		if (health.alive) return true;
		// Daemon dead — fall through to re-spawn
		_daemonSpawned = false;
	}

	const child = spawnWtftDaemon(sessionPath, daemonDir);
	if (child) {
		_daemonSpawned = true;
		_daemonSpawnedAt = Date.now();
		_daemonSessionPath = sessionPath;
		return true;
	}
	return false;
}

/**
 * Get the parser/daemon status for a session. Used by the extension's
 * widget to display daemon health inline.
 */
export function getDaemonStatus(sessionPath: string): DaemonStatus {
	if (!_daemonSessionPath) return { alive: false, reason: "not-started" };

	// Session file existence (#124): the daemon now waits for the session
	// file instead of exiting, but there's still a brief window where the
	// daemon was spawned and hasn't claimed the PID file yet. In that gap,
	// if the session file doesn't exist, report "waiting-session"
	// instead of "starting" → falling through to "not-found".
	let sessionExists = false;
	try { sessionExists = fs.existsSync(sessionPath); } catch {}

	const tagPath = getTagPath(sessionPath);
	const health = checkDaemonHealth(sessionPath, tagPath);

	// Daemon is alive — if session file doesn't exist, daemon is polling.
	if (health.alive && !sessionExists) {
		return { alive: true, reason: "waiting-session" };
	}

	// Grace period: if the daemon PID is gone but the tag file was recently
	// written (within 2s), a new daemon instance is spinning up — mask the
	// restart gap by reporting alive (idle or live depending on session).
	if (!health.alive && _daemonSpawned) {
		const elapsed = Date.now() - _daemonSpawnedAt;
		// Within 5s of spawn: if PID file doesn't exist, daemon may still
		// be starting. If session file doesn't exist either, the daemon is
		// waiting for it — report that instead of a generic "starting".
		//
		// #179: this compares a health CODE, not a display sentence. Typo it and
		// `tsc --noEmit` rejects the comparison instead of silently producing an
		// always-false branch — which is exactly how #124 could have regressed.
		if (elapsed < 5000 && health.reason === "not-found") {
			if (!sessionExists) {
				return { alive: false, reason: "waiting-session" };
			}
			return { alive: false, reason: "starting" };
		}
		try {
			const tagStat = fs.statSync(tagPath);
			const tagAge = Date.now() - tagStat.mtimeMs;
			if (tagAge < 2000 && tagStat.size > 0) {
				return { alive: true, idle: true, idleMs: 0 };
			}
		} catch { /* tag file missing — genuinely dead */ }
	}
	return health;
}

// ---
// CONFIG / SETTINGS
// ---

/** Read the emoji-disabled flag from the wtft config section. */
export function isEmojiDisabled(): boolean {
	const config = readConfig("wtft");
	return typeof config.disabledEmoji === "boolean" ? config.disabledEmoji : false;
}

// ---
// MANIFEST-DRIVEN RENDERING (help, why, version)
// ---

/**
 * Render --help from the manifest. Returns the formatted help string;
 * callers output via ctx.ui.notify (extension) or console.log (CLI).
 */
export function renderWtftHelp(manifestPath: string, invokedAs: string): string {
	const manifestStr = fs.readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(manifestStr);

	let text = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m - ${manifest.tagline}\n\n`;
	text += `${manifest.description}\n\n`;

	text += `\x1b[1mUsage:\x1b[0m\n`;
	for (const u of manifest.usage) {
		text += `  ${invokedAs} ${(u.flags).padEnd(28)} ${u.desc}\n`;
	}

	text += `\n\x1b[1mExamples:\x1b[0m\n`;
	for (const e of manifest.examples) {
		text += `  ${(e.cmd).padEnd(30)} ${e.desc}\n`;
	}

	return text;
}

/**
 * Render --why from the manifest. Delegates to merge/help.js renderWhy
 * for the scenario-driven output format.
 */
export async function renderWtftWhy(manifestPath: string, invokedAs: string): Promise<string> {
	const { renderWhy } = await import("./merge/help.js");
	return renderWhy(manifestPath, invokedAs);
}

/**
 * Render --version from the manifest. Returns "${name} ${version}".
 */
export function renderWtftVersion(manifestPath: string): string {
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	return `${manifest.name} ${manifest.version}`;
}
