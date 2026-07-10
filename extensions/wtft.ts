import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	buildWtftLines as sharedBuildWtftLines,
	type Category,
	type Interaction,
	parseEntryToInteraction,
	renderOtherHistogram,
	renderTokenSummary,
	deduplicateInteractions,
	getTerminalWidth,
	getVisualLength,
	checkDaemonHealth,
	readClassifiedTagFile,
	restartDaemon,
	renderDaemonStatus,
	getTagPath,
	getDaemonPidPath,
	getModelCacheTtlMs,
	type DaemonStatus
} from "./lib/wtft-shared.js";
import { readConfig, writeConfig, hasConfig } from "./lib/config.js";
import { BurstAccumulator } from "./lib/wtft-burst.js";
// ---
// LOG PARSER STATE (keeps wtft-tag file warm for CLI use)
// ---
let _parserSessionPath: string | null = null;
let _parserSpawned = false;

// ---
// BURST-AWARE ACCUMULATION STATE (#78)
// _allInteractions: merged history (branch walk from session_start + flushed bursts)
// _burstAccumulator: per-burst incremental accumulator, flushed on agent_settled
// _currentThinkingLevel: tracked from thinking_level_select events (#77)
// ---
let _allInteractions: Interaction[] = [];
let _burstAccumulator = new BurstAccumulator();
let _currentThinkingLevel: string | undefined;

function ensureParserRunning(sessionPath: string): void {
	// Same session, already spawned — but verify daemon is actually alive.
	// If the daemon died (idle timeout, crash), reset and re-spawn.
	if (_parserSpawned && _parserSessionPath === sessionPath) {
		const tagPath = getTagPath(sessionPath);
		const health = checkDaemonHealth(sessionPath, tagPath);
		if (health.alive) return;
		// Daemon dead — fall through to re-spawn
		_parserSpawned = false;
	}

	const daemonPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..", "bin", "wtft-daemon.mjs"
	);

	try {
		const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
			detached: true,
			stdio: "ignore"
		});
		child.unref();
		_parserSpawned = true;
		_parserSessionPath = sessionPath;
	} catch (_) {
		// Daemon not available — status will show "log parser not found"
	}
}

function getParserStatus(sessionPath: string): DaemonStatus {
	if (!_parserSessionPath) return { alive: false, reason: "log parser not started" };
	const tagPath = getTagPath(sessionPath);
	return checkDaemonHealth(sessionPath, tagPath);
}


// ---
// ARGUMENT PARSING
// ---

function parseArgs(argsStr: string = "") {
	const str = argsStr || "";
	const args = str.trim().split(/\s+/).filter(Boolean);
	let interval = "1h";
	let limit = 10;
	let width = 80;
	let timezone: string | undefined = undefined;
	let hideWidget = false;
	let showWidget = false;
	let showHelp = false;
	let showWhy = false;
	let showVersion = false;

	let showTicks = true;
	let mode: "bucket" | "cumulative" = "cumulative";
	let pager = false;
	let other = false;
	let tokens = false;
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

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			showHelp = true;
		} else if (arg === "--version") {
			showVersion = true;
		} else if (arg === "--why") {
			showWhy = true;
		} else if (arg === "--hide" || arg === "-H") {
			hideWidget = true;
		} else if (arg === "--show" || arg === "-S") {
			showWidget = true;
		} else if (arg === "-o" || arg === "--other") {
			other = true;
			hasOther = true;
		} else if (arg === "--tokens" || arg === "-T") {
			tokens = true;
			hasTokens = true;
		} else if (arg === "--force" || arg === "-F") {
			forceReparse = true;
		} else if (arg === "--ticks") {
			showTicks = true;
			hasTicks = true;
		} else if (arg === "--no-ticks") {
			showTicks = false;
			hasTicks = true;
		} else if (arg === "--no-emojii" || arg === "--no-emoji") {
			enableEmoji = false;
		} else if (arg === "--emojii" || arg === "--emoji") {
			enableEmoji = true;
		} else if (arg === "--cumulative" || arg === "-c") {
			mode = "cumulative";
			hasMode = true;
		} else if (arg === "--bucket" || arg === "-b") {
			mode = "bucket";
			hasMode = true;
		} else if (arg === "--pager" || arg === "-p") {
			pager = true;
		} else if (arg === "-i" || arg === "--interval") {
			const val = args[i + 1];
			if (val && /^(\d+)([mhdw])$/.test(val)) {
				interval = val;
				hasInterval = true;
				i++;
			}
		} else if (arg === "-l" || arg === "--limit") {
			const val = args[i + 1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				limit = num;
				hasLimit = true;
				i++;
			}
		} else if (arg === "-w" || arg === "--width") {
			const val = args[i + 1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				width = num;
				hasWidth = true;
				i++;
			}
		} else if (arg === "-t" || arg === "--tz" || arg === "--timezone") {
			const val = args[i + 1];
			if (val && !val.startsWith("-")) {
				timezone = val;
				hasTimezone = true;
				i++;
			}
		} else if (arg.startsWith("--interval=")) {
			const val = arg.split("=")[1];
			if (val && /^(\d+)([mhdw])$/.test(val)) {
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
		} else if (arg.startsWith("--tz=")) {
			timezone = arg.split("=")[1];
			hasTimezone = true;
		} else if (arg.startsWith("--timezone=")) {
			timezone = arg.split("=")[1];
			hasTimezone = true;
		}
	}

	return {
		interval,
		limit,
		width,
		timezone,
		hideWidget,
		showWidget,
		showTicks,
		mode,
		showHelp,
		showWhy,
		showVersion,
		pager,
		hasInterval,
		hasLimit,
		hasWidth,
		hasTicks,
		hasMode,
		hasTimezone,
		hasOther,
		hasTokens,
		forceReparse,
		other,
		tokens,
		enableEmoji
	};
}

// ---
// TUI CUSTOM PAGER OVERLAY
// ---

class PagerComponent {
	private lines: string[];
	private scrollOffset = 0;
	private onDone: () => void;

	constructor(lines: string[], onDone: () => void) {
		this.lines = lines;
		this.onDone = onDone;
	}

	render(width: number): string[] {
		const termHeight = process.stdout.rows || 24;
		const displayHeight = Math.max(5, termHeight - 4); // Leave space for headers/footers

		const rendered: string[] = [];
		rendered.push(`\x1b[1;36m┌─── WTFT Cost Audit Scrollable Pager ──────────────────────────┐\x1b[0m`);
		
		const limit = Math.min(this.lines.length, this.scrollOffset + displayHeight);
		for (let i = this.scrollOffset; i < limit; i++) {
			rendered.push("│ " + this.lines[i]);
		}
		
		const actualPrinted = limit - this.scrollOffset;
		for (let i = actualPrinted; i < displayHeight; i++) {
			rendered.push("│");
		}

		rendered.push(`\x1b[1;36m└─── ↑↓/j/k navigate • PageUp/PageDown • q/Esc exit (Row ${this.scrollOffset + 1}/${this.lines.length}) ──┘\x1b[0m`);
		return rendered;
	}

	handleInput(data: string): void {
		const termHeight = process.stdout.rows || 24;
		const displayHeight = Math.max(5, termHeight - 4);

		if (data === "q" || data === "\x1b") {
			this.onDone();
		} else if (data === "\x1b[A" || data === "k") {
			if (this.scrollOffset > 0) this.scrollOffset--;
		} else if (data === "\x1b[B" || data === "j") {
			if (this.scrollOffset < this.lines.length - displayHeight) this.scrollOffset++;
		} else if (data === "\x1b[5~") { // Page Up
			this.scrollOffset = Math.max(0, this.scrollOffset - displayHeight);
		} else if (data === "\x1b[6~") { // Page Down
			this.scrollOffset = Math.min(Math.max(0, this.lines.length - displayHeight), this.scrollOffset + displayHeight);
		}
	}

	invalidate(): void {}
}

// ---
// STATE PERSISTENCE (STORE/RETRIEVE)
// ---

function isEmojiDisabled(): boolean {
	const config = readConfig("wtft");
	return typeof config.disabledEmoji === "boolean" ? config.disabledEmoji : false;
}

/**
 * Retrieves setting configurations from the harness-agnostic config file (#72).
 * All settings (including TUI appearance) are now config-only — no .jsonl persistence.
 * Widget auto-shows on session_start if any config exists.
 */
function getSettings(_ctx: any) {
	const config = readConfig("wtft");

	const interval = (config.interval as string) || "1h";
	const limit = (typeof config.limit === "number" ? config.limit : 10) as number;
	const showTicks = (typeof config.showTicks === "boolean" ? config.showTicks : true) as boolean;
	const mode: "bucket" | "cumulative" = (config.mode === "bucket" || config.mode === "cumulative" ? config.mode : "cumulative") as "bucket" | "cumulative";
	const timezone: string | undefined = (typeof config.timezone === "string" ? config.timezone : "America/Los_Angeles") as string | undefined;
	const disabledEmoji = isEmojiDisabled();

	// Width auto-fits to terminal (no separate lock/default — CLI doesn't use it either)
	const width = Math.min(getTerminalWidth(true, disabledEmoji), 240);

	// Auto-show if config exists (user has configured wtft at least once)
	const visible = hasConfig("wtft");

	return { interval, limit, width, visible, showTicks, mode, timezone, disabledEmoji };
}

// ---
// TUI WIDGET UPDATE ENGINE & COMPILER
// ---

function buildWtftLines(
	ctx: any,
	pi: ExtensionAPI,
	opts?: {
		interval?: string;
		limit?: number;
		width?: number;
		showTicks?: boolean;
		mode?: "bucket" | "cumulative";
		timezone?: string;
		forceLegendRow?: boolean;
	}
): string[] | null {
	// Use pre-accumulated interactions (branch walk on session_start +
	// incremental burst accumulation from message_end). O(1) at widget
	// render time instead of O(n) branch walk on every refresh (#78).
	const interactions = _allInteractions;

	return sharedBuildWtftLines(interactions, getSettings(ctx), opts);
}

/**
 * Dynamically computes costs binned by interval and updates the TUI widget
 * positioned below the editor. Operates in the configured timezone.
 */
function updateWtftWidget(
	ctx: any,
	pi: ExtensionAPI,
	opts?: {
		interval?: string;
		limit?: number;
		width?: number;
		visible?: boolean;
		showTicks?: boolean;
		mode?: "bucket" | "cumulative";
		timezone?: string;
	}
) {
	const current = getSettings(ctx);
	const visible = opts?.visible !== undefined ? opts.visible : current.visible;

	if (!visible) {
		ctx.ui.setWidget("wtft", undefined);
		return;
	}

	// Detect model for SURGE timeline coloring (passed to shared buildWtftLines).
	let modelId: string | undefined;
	try {
		const sessionCtx = ctx.sessionManager.buildSessionContext();
		modelId = sessionCtx?.model?.modelId;
	} catch (_) {}

	// Force legend to its own row — SURGE timeline is appended to title line inside buildWtftLines
	const buildOpts = { ...opts, forceLegendRow: true, model: modelId };
	const lines = buildWtftLines(ctx, pi, buildOpts);
	if (!lines || lines.length === 0) {
		// --- Show cache/empty state instead of hiding widget. ---
		const emptyModel = modelId || "";
		const cacheTtl = getModelCacheTtlMs(emptyModel);
		const emptyLine = cacheTtl === null
			? "\x1b[90mNo Cache (local model)\x1b[0m"
			: "\x1b[90mCache Empty\x1b[0m";

		let parserStatusStr = "";
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile && _parserSpawned) {
			const status = getParserStatus(sessionFile);
			parserStatusStr = renderDaemonStatus(status, false);
		}

		const widgetLines = parserStatusStr
			? [emptyLine, parserStatusStr.trim()]
			: [emptyLine];
		ctx.ui.setWidget("wtft", widgetLines, { placement: "belowEditor" });
		return;
	}

	// ---
	// Append log parser status (inline if it fits, otherwise separate line).
	// ---
	let parserStatusStr = "";
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (sessionFile && _parserSpawned) {
		const status = getParserStatus(sessionFile);
		parserStatusStr = renderDaemonStatus(status, false);
	}

	if (parserStatusStr) {
		const titleVisualLen = getVisualLength(lines[0]);
		const statusVisualLen = getVisualLength(parserStatusStr);
		const width = getTerminalWidth(true, false);
		if (titleVisualLen + statusVisualLen <= width - 2) {
			lines[0] = lines[0] + parserStatusStr;
		} else {
			lines.splice(1, 0, parserStatusStr.trim());
		}
	}

	ctx.ui.setWidget("wtft", lines, { placement: "belowEditor" });
}

// ---
// MAIN EXTENSION ENTRY POINT
// ---

// Periodic refresh (1 min) so the 24hr timeline diamond and surge APPROACHING/ENDING
// badges update in real time even without new session activity.
let _wtftCtx: any = null;
let _wtftRefreshTimer: ReturnType<typeof setInterval> | null = null;

export default function wtftExtension(pi: ExtensionAPI) {
	// 1. Auto-restore on startup + spawn log parser
	pi.on("session_start", async (_event, ctx) => {
		_wtftCtx = ctx;
		// Spawn log parser for this session to keep wtft-tag file warm for CLI use.
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile) {
			ensureParserRunning(sessionFile);
		}

		// Reconstruct historical interactions from the daemon's classified
		// tag file — same source as the CLI, ensuring widget and CLI totals
		// never diverge. Fall back to branch walk if the daemon hasn't
		// written the tag file yet (e.g., first session start).
		_allInteractions = [];
		if (sessionFile) {
			const tagPath = getTagPath(sessionFile);
			const tagInteractions = readClassifiedTagFile(tagPath);
			if (tagInteractions.length > 0) {
				_allInteractions = tagInteractions;
			}
		}
		// Fallback: if tag file is empty, walk the branch directly.
		if (_allInteractions.length === 0) {
			const branch = ctx.sessionManager.getBranch();
			let branchThinkingLevel: string | undefined;
			for (let i = 0; i < branch.length; i++) {
				// Track thinking level changes (#77)
				if (branch[i].type === "thinking_level_change" && branch[i].thinkingLevel) {
					branchThinkingLevel = branch[i].thinkingLevel;
					continue;
				}
				const interaction = parseEntryToInteraction(branch[i], branchThinkingLevel);
				if (interaction) {
					_allInteractions.push(interaction);
				}
			}
		}
		_burstAccumulator = new BurstAccumulator();

		// Auto-show widget if user has configured wtft at least once (#72)
		if (hasConfig("wtft")) {
			updateWtftWidget(ctx, pi);
		}
		// Start 1-minute timer for timeline live-updates
		if (!_wtftRefreshTimer) {
			_wtftRefreshTimer = setInterval(() => {
				if (_wtftCtx) {
					const s = getSettings(_wtftCtx);
					if (s.visible) {
						updateWtftWidget(_wtftCtx, pi);
					}
				}
			}, 60000);
		}
	});

	// 2. Track thinking level changes so burst accumulator can stamp
	//    each interaction with the active effort level (#77).
	pi.on("thinking_level_select", (event) => {
		_currentThinkingLevel = event.level;
	});

	// 3. Incremental accumulation: classify each assistant message as it
	//    completes, without walking the branch (#78).
	pi.on("message_end", async (event, ctx) => {
		_wtftCtx = ctx;
		// Only accumulate assistant messages with usage data.
		if ((event.message as any).role !== "assistant") return;
		const usage = (event.message as any).usage;
		if (!usage) return;
		// Wrap in Pi-schema entry form so parseEntryToInteraction works.
		const fakeEntry = { type: "message", message: event.message };
		_burstAccumulator.accumulateFromEntry(fakeEntry, _currentThinkingLevel);
	});

	// 4. Burst boundary: agent_settled fires once per prompt after all
	//    retries, compactions, and follow-ups are done. This is the
	//    definitive per-prompt boundary — render the widget once with
	//    complete data (#78).
	pi.on("agent_settled", async (_event, ctx) => {
		_wtftCtx = ctx;
		// Flush burst → persistent interaction store
		const flushed = _burstAccumulator.flush();
		_allInteractions.push(...flushed);

		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 5. Tree navigation: when the user navigates to a different point
	//    in the session tree (/tree), the active branch changes. Rebuild
	//    _allInteractions from the new branch so the widget reflects the
	//    correct history (#78).
	pi.on("session_tree", async (_event, ctx) => {
		_wtftCtx = ctx;
		// Rebuild from daemon's classified tag file (same source as CLI).
		_allInteractions = [];
		const sFile = ctx.sessionManager.getSessionFile?.();
		if (sFile) {
			const tagPath = getTagPath(sFile);
			const tagInteractions = readClassifiedTagFile(tagPath);
			if (tagInteractions.length > 0) {
				_allInteractions = tagInteractions;
			}
		}
		if (_allInteractions.length === 0) {
			const branch = ctx.sessionManager.getBranch();
			let branchThinkingLevel: string | undefined;
			for (let i = 0; i < branch.length; i++) {
				// Track thinking level changes (#77)
				if (branch[i].type === "thinking_level_change" && branch[i].thinkingLevel) {
					branchThinkingLevel = branch[i].thinkingLevel;
					continue;
				}
				const interaction = parseEntryToInteraction(branch[i], branchThinkingLevel);
				if (interaction) {
					_allInteractions.push(interaction);
				}
			}
		}
		_burstAccumulator = new BurstAccumulator();

		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 6. Daemon health check only — no widget refresh here.
	//    agent_end fires multiple times per burst (retry, compaction+retry,
	//    follow-up). Widget flicker from mid-burst refreshes is eliminated
	//    by moving rendering to agent_settled (#78).
	pi.on("agent_end", async (_event, ctx) => {
		_wtftCtx = ctx;
		// Revive dead daemon so CLI wtft --watch stays live after idle timeout.
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile) {
			ensureParserRunning(sessionFile);
		}
	});

	// 6. Command registration
	pi.registerCommand("wtft", {
		description: "Where The F***ing Tokens?! (WTFT) - Cost Auditing Widget",
		handler: async (args, ctx) => {
			const {
				interval,
				limit,
				width,
				timezone,
				hideWidget,
				showWidget,
				showTicks,
				mode,
				showHelp,
				showWhy,
				showVersion,
				pager,
				hasInterval,
				hasLimit,
				hasWidth,
				hasTicks,
				hasMode,
				hasTimezone,
				hasOther,
				hasTokens,
				forceReparse,
				other,
				tokens,
				enableEmoji
			} = parseArgs(args);

			// --force: kill daemon, delete tag file, respawn → full re-parse (#78)
			if (forceReparse) {
				const sessionFile = ctx.sessionManager.getSessionFile?.();
				if (!sessionFile) {
					ctx.ui.notify("No session file available for re-parse.", "warning");
					return;
				}
				const tagPath = getTagPath(sessionFile);
				const pidPath = getDaemonPidPath(sessionFile);
				// Kill existing daemon
				try {
					const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
					if (pid > 0) {
						try { process.kill(pid, "SIGTERM"); } catch {}
					}
					try { fs.unlinkSync(pidPath); } catch {}
				} catch {}
				// Delete tag file
				try { fs.unlinkSync(tagPath); } catch {}
				// Rebuild _allInteractions from scratch
				_allInteractions = [];
				const branch = ctx.sessionManager.getBranch();
				let branchThinkingLevel: string | undefined;
				for (let i = 0; i < branch.length; i++) {
					// Track thinking level changes (#77)
					if (branch[i].type === "thinking_level_change" && branch[i].thinkingLevel) {
						branchThinkingLevel = branch[i].thinkingLevel;
						continue;
					}
					const interaction = parseEntryToInteraction(branch[i], branchThinkingLevel);
					if (interaction) _allInteractions.push(interaction);
				}
				_burstAccumulator = new BurstAccumulator();
				// Respawn daemon
				_parserSpawned = false;
				_parserSessionPath = null;
				ensureParserRunning(sessionFile);
				updateWtftWidget(ctx, pi);
				ctx.ui.notify("Tag file deleted and log parser respawned — full session re-parse in progress.", "info");
				return;
			}

			if (typeof enableEmoji === "boolean") {
				// Persist to harness-agnostic config file (#72)
				writeConfig("wtft", { disabledEmoji: !enableEmoji });
				const statusText = enableEmoji ? "enabled" : "disabled";
				ctx.ui.notify(`Emoji icons in widgets have been ${statusText}.`, "info");
				updateWtftWidget(ctx, pi);
				return;
			}

			// Display tool version if requested
			if (showVersion) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
					ctx.ui.notify(`${manifest.name} ${manifest.version}`, "info");
				} catch (err) {
					ctx.ui.notify(`\u26A0\uFE0F Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			// Render manifest help menu if requested
			if (showHelp) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					const manifestStr = fs.readFileSync(manifestPath, "utf8");
					const manifest = JSON.parse(manifestStr);

					let helpText = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m - ${manifest.tagline}\n\n`;
					helpText += `${manifest.description}\n\n`;

					helpText += `\x1b[1mUsage:\x1b[0m\n`;
					for (const u of manifest.usage) {
						helpText += `  ${manifest.name} ${(u.flags).padEnd(28)} ${u.desc}\n`;
					}

					helpText += `\n\x1b[1mExamples:\x1b[0m\n`;
					for (const e of manifest.examples) {
						helpText += `  ${(e.cmd).padEnd(30)} ${e.desc}\n`;
					}

					ctx.ui.notify(helpText, "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			// Render --why scenario-driven output
			if (showWhy) {
				try {
					const { renderWhy } = await import("./lib/merge/help.js");
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					const whyText = renderWhy(manifestPath, "/wtft");
					ctx.ui.notify(whyText, "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			const current = getSettings(ctx);

			if (other) {
				const deduped = deduplicateInteractions(_allInteractions);
				const output = renderOtherHistogram(deduped, Math.max(current.width, 40));
				ctx.ui.notify(output, "info");
				return;
			}

			if (tokens) {
			// Map current thinking level to budget tokens (#79)
			const BUDGET_MAP: Record<string, number> = {
				minimal: 1024, low: 4096, medium: 10240,
				high: 32768, xhigh: 65536, max: 131072
			};
			const budget = _currentThinkingLevel ? BUDGET_MAP[_currentThinkingLevel] : undefined;
			const output = renderTokenSummary(_allInteractions, Math.max(current.width, 40), budget);
			ctx.ui.notify(output, "info");
			return;
		}

			if (hideWidget) {
				ctx.ui.setWidget("wtft", undefined);
				ctx.ui.notify("Token cost audit widget hidden.", "info");
				return;
			}

			const nextInterval = hasInterval ? interval : current.interval;
			const nextLimit = hasLimit ? limit : current.limit;
			
			// Dynamic fallback (minus safety padding) capped at 240 if no explicit width set
			const termColumns = getTerminalWidth(true, isEmojiDisabled());
			const nextWidth = hasWidth ? Math.min(width, 240) : Math.min(termColumns, 240);

			const nextTicks = hasTicks ? showTicks : current.showTicks;
			const nextMode = hasMode ? mode : current.mode;
			const nextTimezone = hasTimezone ? timezone : current.timezone;

			if (pager) {
				const lines = buildWtftLines(ctx, pi, {
					interval: nextInterval,
					limit: hasLimit ? nextLimit : 100, // Large default for pager
					width: nextWidth,
					showTicks: nextTicks,
					mode: nextMode,
					timezone: nextTimezone
				});

				if (!lines || lines.length === 0) {
					ctx.ui.notify("No cost history found to display in the pager.", "warning");
					return;
				}

				// Launch TUI custom pager overlay
				await ctx.ui.custom((tui, _theme, _keybindings, done) => {
					return new PagerComponent(lines, () => done(null));
				}, { overlay: true });
				return;
			}

			// Persist all settings to harness-agnostic config file (#72)
			writeConfig("wtft", {
				interval: nextInterval,
				limit: nextLimit,
				showTicks: nextTicks,
				mode: nextMode,
				timezone: nextTimezone
			});

			updateWtftWidget(ctx, pi, {
				interval: nextInterval,
				limit: nextLimit,
				width: nextWidth,
				visible: true,
				showTicks: nextTicks,
				mode: nextMode,
				timezone: nextTimezone
			});

			ctx.ui.notify("Token cost audit widget updated below the editor.", "info");
		}
	});


}
