/**
 * @package princess-pi-tools
 * @module wtft-cli-shared
 * @description Shared CLI/extension interface layer — argument parsing, daemon
 *   lifecycle, config reading, and manifest-driven help/why/version rendering.
 *   Consumed by both `extensions/wtft.ts` (Pi extension) and `bin/wtft.ts` (CLI).
 *
 *   #94: extracted from ~300 lines duplicated across both callers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { checkDaemonHealth, getTagPath, type DaemonStatus } from "./wtft-shared.js";
import { readConfig } from "@princess-pi/libs/config";
import { formatVersion } from "@princess-pi/libs/build-stamp";

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
			// ACCEPTED AND INERT, which is the accurate description — #79 owns
			// the decision about whether that should change.
			//
			// A `/wtft --show` run does end with the widget rendered, but the
			// default path is what renders it: `--hide --show` and
			// `--show --hide` BOTH clear the widget, so this flag carries no
			// force of its own in either order. It used to set a `showWidget`
			// field that nothing read; removing that removed a misleading
			// signal, not the inertness.
			//
			// Kept accepted so `-S` is never an unknown-flag error, and because
			// CONTEXT.md documents `-S`/`-H` as a pair — dropping it is a
			// user-facing change that belongs with that entry, not here.
			// Behaviour pinned by tests/wtft-74-budget-flag-parsing.test.ts §4.
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
		hideWidget,
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
 * Is this a session .jsonl path that may simply not be written YET? (#308)
 *
 * Claude Code fixes the session id — and so the transcript path — at launch, but
 * writes the first line only after the first real prompt (not a /command)
 * completes. A caller that knows the path early (a SessionStart hook, a
 * statusline, `wtft -s <path>` fired at launch) must not be told "not found":
 * the file is late, not missing. The daemon already parks on such a path
 * (#124/#129); this predicate is what lets the CLI accept one.
 *
 * Deliberately narrow: absolute, ends in `.jsonl`, and is not a wtft tag file
 * (the daemon refuses those anyway). A relative fuzzy filter that matches no
 * discovered session is still an error — that path was never a fact.
 */
export function isPendingSessionPath(p: string): boolean {
	return path.isAbsolute(p) && p.endsWith(".jsonl") && !p.includes(".wtft-tag.v");
}

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
 * The manifest fields these renderers read. Loose on purpose — the manifest is
 * hand-maintained JSON, and a renderer is not the place to enforce its schema.
 */
export interface WtftManifest {
	name: string;
	tagline: string;
	description: string;
	usage: { flags: string; desc: string }[];
	examples: { cmd: string; desc: string }[];
	why?: unknown;
}

/**
 * A manifest, or a path to one (#36).
 *
 * Every renderer used to take only a path, which is why a published or copied
 * `bin/wtft.mjs` could not print its own help: `files` ships the bundle alone,
 * so the path pointed at a file no install contains. The CLI now hands over a
 * manifest the bundler inlined. The path form stays because the Pi extension
 * still reads the repo copy from `process.cwd()`, where the file really is.
 */
export type ManifestSource = string | WtftManifest;

function loadManifest(src: ManifestSource): WtftManifest {
	return typeof src === "string"
		? JSON.parse(fs.readFileSync(src, "utf8")) as WtftManifest
		: src;
}

/**
 * Render --help from the manifest. Returns the formatted help string;
 * callers output via ctx.ui.notify (extension) or console.log (CLI).
 */
export function renderWtftHelp(src: ManifestSource, invokedAs: string): string {
	const manifest = loadManifest(src);

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
 * Render --why from the manifest. Delegates to @princess-pi/libs/manifest-help renderWhy
 * for the scenario-driven output format.
 */
export async function renderWtftWhy(src: ManifestSource, invokedAs: string): Promise<string> {
	const { renderWhy } = await import("@princess-pi/libs/manifest-help");
	if (typeof src === "string") return renderWhy(src, invokedAs);

	// libs' renderWhy reads a PATH, and this repo pins @princess-pi/libs to a
	// commit, so widening it there is a separate release — filed as
	// princess-pi/libs#3. Until that lands the inlined manifest is spilled to a
	// private temp file for the length of the call. Deliberately a spill and not
	// a second copy of the renderer: one renderer that occasionally needs a file
	// cannot drift from itself, and two that never need one can. Delete this
	// branch when libs#3 lands.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-why-"));
	const file = path.join(dir, "wtft-cmd.json");
	try {
		fs.writeFileSync(file, JSON.stringify(src));
		// `await` before returning, not `return renderWhy(...)`: `finally` runs when
		// the try block RETURNS, not when the returned promise settles, so the bare
		// return would delete the spill file during the read it exists for.
		// Demonstrated with an async reader — the bare form throws ENOENT, this one
		// returns the content. Latent rather than live today only because libs'
		// renderWhy is synchronous (fs.readFileSync), which is a property of a
		// PINNED external package that this call site cannot see and does not
		// assert; the await is correct under either implementation. (Review round 1.)
		const text = await renderWhy(file, invokedAs);
		return text;
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

/**
 * Render --version. The NAME still comes from the manifest; the VERSION comes
 * from package.json (#347 — the manifest carried a second copy that only one
 * of the two release paths ever bumped), and the build stamp says which tree
 * produced the artifact answering (#178).
 *
 * WHEN package.json is read has changed (#46): in a BUNDLED artifact it is read
 * at BUILD time and substituted below, because an artifact installed into ~/bin
 * has no package.json above it — and if one happens to be there, it is not
 * ours. Unbundled source, where the define is undeclared, still reads it at run
 * time. Same single source of truth, resolved at whichever moment the file is
 * actually reachable.
 *
 * The substituted name is a GLOBAL, not `process.env.WTFT_BUILD_VERSION`. With
 * an env key the source path read it live, so any environment could dictate the
 * version this command reports about itself.
 *
 * `moduleUrl` must be the CALLER's import.meta.url, not this module's: after
 * bundling they are the same file, but the Pi extension loads source, where
 * this lib's URL would name the lib rather than the command you invoked.
 */
// Substituted by build.ts's `define` in a bundle, and declared nowhere else —
// `typeof` is what keeps the source path from throwing a ReferenceError.
declare const __WTFT_BUILD_VERSION__: string | undefined;

export function renderWtftVersion(src: ManifestSource, moduleUrl: string): string {
	const manifest = loadManifest(src);
	// Substituted by build.ts in a bundle; undeclared in source. See the docstring.
	const injected = typeof __WTFT_BUILD_VERSION__ === "string" ? __WTFT_BUILD_VERSION__ : "";
	if (injected) return formatVersion(manifest.name, injected, moduleUrl);

	const pkgPath = path.join(path.dirname(fileURLToPath(moduleUrl)), "..", "package.json");
	let semver: string;
	try {
		semver = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
	} catch (err) {
		// #347: this used to fall back to `manifest.version` — a second copy of the
		// number that only one release path ever bumped. Falling back to it made an
		// unreadable package.json print a STALE version instead of failing, which is
		// the worst possible behaviour for the one command you run when you already
		// suspect you are running the wrong build. Say what is missing instead.
		semver = `unknown (cannot read ${pkgPath}: ${(err as Error).message})`;
	}
	return formatVersion(manifest.name, semver, moduleUrl);
}
