/** Shared CLI/extension interface layer. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { checkDaemonHealth, getTagPath, type DaemonStatus } from "./wtft-shared.js";
import { readConfig } from "@princess-pi/libs/config";
import { formatVersion } from "@princess-pi/libs/build-stamp";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "./wtft-config-dir.js";

// ---

export interface WtftCliOptions {
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
	/** `--json` — emit the machine-readable session summary instead of
	 *  rendering. CLI-only: the Pi extension parses it and ignores it, because a
	 *  TUI widget has no stdout to write an object to. */
	json: boolean;
}

// ---

/**
 * Breaking: `-t` and `-T` shortcuts are intentionally NOT supported.
 * `-t` was overloaded across --timezone, --tokens, --ticks, and a planned
 * --turns. Use the full `--` names instead.
 */
export function parseWtftCliArgs(argv: string[]): WtftCliOptions {
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
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

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
			// --by-model: alias — the token summary IS the per-model
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

		} else if (arg === "--hide" || arg === "-H") {
			hideWidget = true;
		} else if (arg === "--show" || arg === "-S") {
			// ACCEPTED AND INERT. `--hide --show` and `--show --hide` BOTH clear
			// the widget — this flag carries no force of its own. Kept accepted
			// so `-S` is never an unknown-flag error.
		} else if (arg === "--no-emojii" || arg === "--no-emoji") {
			enableEmoji = false;
		} else if (arg === "--emojii" || arg === "--emoji") {
			enableEmoji = true;
		} else if (arg === "--pager" || arg === "-p") {
			pager = true;

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
		} else if (arg === "--json") {
			json = true;
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
		json,
	};
}

// ---

/**
 * Is this a session .jsonl path that may simply not be written YET?
 *
 * Claude Code fixes the session id — and so the transcript path — at launch, but
 * writes the first line only after the first real prompt (not a /command)
 * completes. A caller that knows the path early must not be told "not found":
 * the file is late, not missing. The daemon already parks on such a path; this
 * predicate is what lets the CLI accept one.
 *
 * Deliberately narrow: absolute, ends in `.jsonl`, and is not a wtft tag file.
 * A relative fuzzy filter that matches no discovered session is still an error.
 */
export function isPendingSessionPath(p: string): boolean {
	return path.isAbsolute(p) && p.endsWith(".jsonl") && !p.includes(".wtft-tag.v");
}

/**
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

let _daemonSessionPath: string | null = null;
let _daemonSpawned = false;
let _daemonSpawnedAt = 0; // Date.now() when the last spawn was attempted

export function ensureDaemonRunning(sessionPath: string, daemonDir: string): boolean {
	if (_daemonSpawned && _daemonSessionPath === sessionPath) {
		const tagPath = getTagPath(sessionPath);
		const health = checkDaemonHealth(sessionPath, tagPath);
		if (health.alive) return true;
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

export function getDaemonStatus(sessionPath: string): DaemonStatus {
	if (!_daemonSessionPath) return { alive: false, reason: "not-started" };

	let sessionExists = false;
	try { sessionExists = fs.existsSync(sessionPath); } catch {}

	const tagPath = getTagPath(sessionPath);
	const health = checkDaemonHealth(sessionPath, tagPath);

	if (health.alive && !sessionExists) {
		return { alive: true, reason: "waiting-session" };
	}

	// Grace period: if the daemon PID is gone but the tag file was recently
	// written (within 2s), a new daemon instance is spinning up — mask the
	// restart gap by reporting alive (idle or live depending on session).
	if (!health.alive && _daemonSpawned) {
		const elapsed = Date.now() - _daemonSpawnedAt;
		// Within 5s of spawn: if PID file doesn't exist, daemon may still
		// be starting. If session file doesn't exist either, report
		// "waiting-session" instead of a generic "starting".
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

export function isEmojiDisabled(): boolean {
	const config = readConfig(WTFT_CONFIG_TOOL, WTFT_CONFIG_DIR);
	return typeof config.disabledEmoji === "boolean" ? config.disabledEmoji : false;
}

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
	/** The documented exit-code table. Optional so a manifest that predates
	 *  it still renders; `--help` omits the section when it is absent. */
	exitCodes?: { code: number; meaning: string }[];
	why?: unknown;
}

/**
 * The CLI hands over a manifest the bundler inlined — a published `bin/wtft.mjs`
 * has no package.json/manifest beside it. The path form stays because the Pi
 * extension still reads the repo copy from `process.cwd()`.
 */
export type ManifestSource = string | WtftManifest;

function loadManifest(src: ManifestSource): WtftManifest {
	return typeof src === "string"
		? JSON.parse(fs.readFileSync(src, "utf8")) as WtftManifest
		: src;
}

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

	// Exit codes are API. `--help` is where a human looks for them; rendering
	// from the manifest keeps this list from drifting from `--json` consumers.
	if (manifest.exitCodes && manifest.exitCodes.length > 0) {
		text += `\n\x1b[1mExit codes:\x1b[0m\n`;
		for (const c of manifest.exitCodes) {
			text += `  ${String(c.code).padEnd(30)} ${c.meaning}\n`;
		}
	}

	return text;
}

export async function renderWtftWhy(src: ManifestSource, invokedAs: string): Promise<string> {
	const { renderWhy } = await import("@princess-pi/libs/manifest-help");
	if (typeof src === "string") return renderWhy(src, invokedAs);

	// libs' renderWhy reads a PATH; spill the inlined manifest to a private
	// temp file for the length of the call rather than maintaining a second
	// copy of the renderer.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-why-"));
	const file = path.join(dir, "wtft-cmd.json");
	try {
		fs.writeFileSync(file, JSON.stringify(src));
		// `await` before returning: `finally` runs when the try block RETURNS,
		// not when the returned promise settles — a bare `return renderWhy(...)`
		// would delete the spill file during the read.
		const text = await renderWhy(file, invokedAs);
		return text;
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

/**
 * Render --version. NAME from the manifest; VERSION from package.json; build
 * stamp says which tree produced the artifact.
 * In a BUNDLED artifact package.json is read at BUILD time and substituted
 * below — an artifact in ~/bin has no package.json above it. Unbundled source
 * still reads it at run time.
 * The substituted name is a GLOBAL, not `process.env.WTFT_BUILD_VERSION` —
 * an env key would let any environment dictate the version this command reports.
 * `moduleUrl` must be the CALLER's import.meta.url: after bundling they are the
 * same file, but the Pi extension loads source where this lib's URL would name
 * the lib rather than the command you invoked.
 */
// Substituted by build.ts's `define` in a bundle, and declared nowhere else —
// `typeof` keeps the source path from throwing a ReferenceError.
declare const __WTFT_BUILD_VERSION__: string | undefined;

export function renderWtftVersion(src: ManifestSource, moduleUrl: string): string {
	const manifest = loadManifest(src);
	const injected = typeof __WTFT_BUILD_VERSION__ === "string" ? __WTFT_BUILD_VERSION__ : "";
	if (injected) return formatVersion(manifest.name, injected, moduleUrl);

	const pkgPath = path.join(path.dirname(fileURLToPath(moduleUrl)), "..", "package.json");
	let semver: string;
	try {
		semver = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
	} catch (err) {
		// Do not fall back to a second copy of the version — say what is missing.
		semver = `unknown (cannot read ${pkgPath}: ${(err as Error).message})`;
	}
	return formatVersion(manifest.name, semver, moduleUrl);
}
