import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildWtftLines as sharedBuildWtftLines,
	type Interaction,
	renderOtherHistogram,
	renderTokenSummary,
	deduplicateInteractions,
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
	getTerminalWidth,
	getVisualLength,
	readClassifiedTagFile,
	renderDaemonStatus,
	getTagPath,
	getDaemonPidPath,
	getModelCacheTtlMs,
} from "./lib/wtft-shared.js";
import { readConfig, writeConfig, hasConfig } from "./lib/config.js";
import {
	parseWtftCliArgs,
	ensureDaemonRunning,
	getDaemonStatus,
	isEmojiDisabled,
	renderWtftHelp,
	renderWtftWhy,
	renderWtftVersion,
} from "./lib/wtft-cli-shared.js";

// ---
// SINGLE DATA SOURCE: classified tag file from wtft-daemon (#92)
// All interactions are read from the tag file on each event — no internal
// accumulation state. The daemon writes at most every 667ms; the gap between
// agent_settled and the next daemon beat is invisible at widget render time.
// ---
let _currentThinkingLevel: string | undefined;

// Daemon directory relative to this extension file
const _daemonDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");



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
	const tokens = (typeof config.tokens === "boolean" ? config.tokens : false) as boolean;

	// Width auto-fits to terminal (no separate lock/default — CLI doesn't use it either)
	const width = Math.min(getTerminalWidth(true, disabledEmoji), 240);

	// Auto-show if config exists (user has configured wtft at least once)
	const visible = hasConfig("wtft");

	return { interval, limit, width, visible, showTicks, mode, timezone, disabledEmoji, tokens };
}

// ---
// TUI WIDGET UPDATE ENGINE & COMPILER
// ---

// ---
// SUBAGENT SESSION ROLLUP (#83)
// Subagent discovery and loading are shared with the CLI via
// extensions/lib/wtft-parser.ts (discoverSubagentSessionFiles,
// loadSubagentInteractions).
//
// Two discovery patterns:
//   1. Claude Code: <session>/subagents/agent-*.jsonl (recursive, depth ≤ 5)
//   2. Pi (pre-emptive): sibling files with parentSession header match
// ---

/** Read interactions from the daemon's classified tag file (#92),
 *  merged with subagent session interactions (#83, #82). */
function readInteractions(ctx: any): Interaction[] {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionFile) return [];
	const tagPath = getTagPath(sessionFile);
	const mainInteractions = readClassifiedTagFile(tagPath);

	// Subagent rollup: discover and parse subagent session files (#83, #82)
	const subagentFiles = discoverSubagentSessionFiles(sessionFile);
	if (subagentFiles.length === 0) return mainInteractions;

	const subInteractions = loadSubagentInteractions(subagentFiles);
	if (subInteractions.length === 0) return mainInteractions;

	// Merge chronologically — subagent turns interleave with parent turns
	const merged = [...mainInteractions, ...subInteractions];
	merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	return merged;
}

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
		sessionNameSuffix?: string;
	}
): string[] | null {
	// Read from the classified tag file — single source of truth (#92).
	const interactions = readInteractions(ctx);
	const settings = getSettings(ctx);

	return sharedBuildWtftLines(interactions, settings, {
		...opts,
		unit: settings.tokens ? "tokens" as const : "cost" as const,
	});
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
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	const sessionNameSuffix = sessionFile ? path.basename(sessionFile) : undefined;
	const buildOpts = { ...opts, model: modelId, sessionNameSuffix };
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
		if (sessionFile) {
			const status = getDaemonStatus(sessionFile);
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
	if (sessionFile) {
		const status = getDaemonStatus(sessionFile);
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
			ensureDaemonRunning(sessionFile, _daemonDir);
		}

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

	// 2. Track thinking level for --tokens budget display.
	pi.on("thinking_level_select", (event) => {
		_currentThinkingLevel = event.level;
	});

	// 3. End-of-turn: read tag file + render (#92).
	pi.on("agent_settled", async (_event, ctx) => {
		_wtftCtx = ctx;
		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 4. Tree navigation: re-read tag file so widget reflects the new branch (#92).
	pi.on("session_tree", async (_event, ctx) => {
		_wtftCtx = ctx;
		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 5. Daemon health revive — keep CLI wtft --watch alive after idle timeout.
	pi.on("agent_end", async (_event, ctx) => {
		_wtftCtx = ctx;
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile) {
			ensureDaemonRunning(sessionFile, _daemonDir);
		}
	});

	// 6. Command registration
	pi.registerCommand("wtft", {
		description: "Where The F***ing Tokens?! (WTFT) - Cost Auditing Widget",
		handler: async (args, ctx) => {
			const opts = parseWtftCliArgs((args || "").trim().split(/\s+/).filter(Boolean));
			const { forceReparse, enableEmoji, showVersion, showHelp, showWhy,
				other, tokens, cost, hideWidget, hasInterval, interval,
				hasLimit, limit, hasWidth, width, hasTicks, showTicks,
				hasMode, mode, hasTimezone, timezone, pager } = opts;

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
				// Respawn daemon (reads session file from scratch, rewrites tag file)
				ensureDaemonRunning(sessionFile, _daemonDir);
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
					ctx.ui.notify(renderWtftVersion(manifestPath), "info");
				} catch (err) {
					ctx.ui.notify(`\u26A0\uFE0F Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			// Render manifest help menu if requested
			if (showHelp) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					ctx.ui.notify(renderWtftHelp(manifestPath, "/wtft"), "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			// Render --why scenario-driven output
			if (showWhy) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					const whyText = await renderWtftWhy(manifestPath, "/wtft");
					ctx.ui.notify(whyText, "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			const current = getSettings(ctx);

			if (other) {
				const interactions = readInteractions(ctx);
				const deduped = deduplicateInteractions(interactions);
				const output = renderOtherHistogram(deduped, Math.max(current.width, 40));
				ctx.ui.notify(output, "info");
				return;
			}

			if (tokens || cost) {
			// Toggle widget token-unit mode and persist (#14).
			// --cost explicitly switches back to $ units.
			writeConfig("wtft", { tokens });
			updateWtftWidget(ctx, pi, { visible: true });

			if (tokens) {
				// Map current thinking level to budget tokens (#79)
				const BUDGET_MAP: Record<string, number> = {
					minimal: 1024, low: 4096, medium: 10240,
					high: 32768, xhigh: 65536, max: 131072
				};
				const budget = _currentThinkingLevel ? BUDGET_MAP[_currentThinkingLevel] : undefined;
				const interactions = readInteractions(ctx);
				const output = renderTokenSummary(interactions, Math.max(current.width, 40), budget);
				ctx.ui.notify(output, "info");
				return;
			}
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
