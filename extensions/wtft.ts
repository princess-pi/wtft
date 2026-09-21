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
	loadSubagentInteractionsChecked,
	getTerminalWidth,
	getVisualLength,
	readTagFileWithVerdict,
	describeProvisionalReason,
	type TagProvisional,
	renderDaemonStatus,
	getTagPath,
	getDaemonPidPath,
	getModelCacheTtlMs,
} from "./lib/wtft-shared.js";
import { readConfig, writeConfig, hasConfig } from "@princess-pi/libs/config";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "./lib/wtft-config-dir.js";
import { computeSpawnTree, type SpawnTree } from "./lib/wtft-spawn-tree.js";
import { collectSelfAttributedSessionIds } from "./lib/wtft-parser.js";
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

// The widget's own surface for a transcript that went uncounted: the parser
// warns on stderr, which the TUI never shows.
let _subagentUnreadable = false;
const PROVISIONAL_LINE = "\x1b[33m⚠ some transcripts could not be counted — total is provisional\x1b[0m";
// The tag's own verdict, which the widget's discovery cannot see (daemon-side).
let _tagProvisional: { verdict: TagProvisional; tagPath: string } | null = null;

/** One line per cause: the two have different remedies. */
function provisionalLines(): string[] {
	const lines: string[] = [];
	if (_tagProvisional?.verdict.provisional) {
		lines.push(`\x1b[33m⚠ ${describeProvisionalReason(_tagProvisional.verdict, _tagProvisional.tagPath)} — total is provisional\x1b[0m`);
	}
	if (_subagentUnreadable) lines.push(PROVISIONAL_LINE);
	return lines;
}

/** `text` plus the provisional lines from the last `readInteractions` — for
 *  the surfaces that print a total outside the widget. */
function withProvisionalLine(text: string): string {
	return [text, ...provisionalLines()].join("\n");
}

// What the render merged into SELF beyond the tag: the spawn tree skips these.
let _subagentFiles: string[] = [];
// The sessions the tag recorded folding.
let _tagFolded = new Set<string>();

const _daemonDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");



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

function getSettings(_ctx: any) {
	const config = readConfig(WTFT_CONFIG_TOOL, WTFT_CONFIG_DIR);

	const interval = (config.interval as string) || "1h";
	const limit = (typeof config.limit === "number" ? config.limit : 10) as number;
	const showTicks = (typeof config.showTicks === "boolean" ? config.showTicks : true) as boolean;
	const mode: "bucket" | "cumulative" = (config.mode === "bucket" || config.mode === "cumulative" ? config.mode : "cumulative") as "bucket" | "cumulative";
	const timezone: string | undefined = (typeof config.timezone === "string" ? config.timezone : "America/Los_Angeles") as string | undefined;
	const disabledEmoji = isEmojiDisabled();
	const tokens = (typeof config.tokens === "boolean" ? config.tokens : false) as boolean;

	const width = Math.min(getTerminalWidth(true, disabledEmoji), 240);

	const visible = hasConfig(WTFT_CONFIG_TOOL, WTFT_CONFIG_DIR);

	return { interval, limit, width, visible, showTicks, mode, timezone, disabledEmoji, tokens };
}

// ---

// ---
// SUBAGENT SESSION MERGE INTO SELF
// Two discovery patterns:
//   1. Claude Code: <session>/subagents/agent-*.jsonl (recursive)
//   2. Pi (pre-emptive): sibling files with parentSession header match
// ---

/** `computeSpawnTree` reports a ledger it could not read as `ledgerError`
 *  rather than throwing, so the widget shows that failure instead of hiding it.
 *  The catch has no reachable case left; it stays because a widget refresh
 *  running every turn must not take the panel down. */
function widgetSpawnTree(ctx: any, interactions: Interaction[]): SpawnTree | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionFile) return undefined;
	try {
		// The same double-count guard the CLI passes: `readInteractions` merges
		// every subagent session into SELF, so a spawner that also records one
		// as a ledger edge would bill it in TOTAL and again in SPAWNED.
		return computeSpawnTree(path.basename(sessionFile).replace(/\.jsonl$/i, ""), {
			alreadyAttributed: () => collectSelfAttributedSessionIds(_tagFolded, interactions, _subagentFiles),
		});
	} catch {
		return undefined;
	}
}

function readInteractions(ctx: any): Interaction[] {
	_subagentUnreadable = false;
	_tagProvisional = null;
	_tagFolded = new Set();
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionFile) return [];
	const tagPath = getTagPath(sessionFile);
	const { interactions: mainInteractions, provisional, folded } = readTagFileWithVerdict(tagPath);
	_tagFolded = folded;
	_tagProvisional = { verdict: provisional, tagPath };

	// render main interactions only rather than crash the widget on every
	// refresh.
	let subagentFiles: string[] = [];
	_subagentFiles = subagentFiles;
	try {
		const discovered = discoverSubagentSessionFiles(sessionFile);
		subagentFiles = discovered.files;
		_subagentFiles = subagentFiles;
		if (discovered.unreadable) _subagentUnreadable = true;
	} catch {
		_subagentUnreadable = true; // walkSubagentDir already warned; degrade to main interactions
	}
	if (subagentFiles.length === 0) return mainInteractions;

	const loaded = loadSubagentInteractionsChecked(subagentFiles);
	if (loaded.dropped.length > 0) _subagentUnreadable = true;
	const subInteractions = loaded.interactions;
	if (subInteractions.length === 0) return mainInteractions;

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
	const interactions = readInteractions(ctx);
	const settings = getSettings(ctx);

	return sharedBuildWtftLines(interactions, settings, {
		...opts,
		unit: settings.tokens ? "tokens" as const : "cost" as const,
	});
}

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

	let modelId: string | undefined;
	try {
		const sessionCtx = ctx.sessionManager.buildSessionContext();
		modelId = sessionCtx?.model?.modelId;
	} catch (_) {}

	const sessionFile = ctx.sessionManager.getSessionFile?.();
	const sessionNameSuffix = sessionFile ? path.basename(sessionFile) : undefined;
	const buildOpts = { ...opts, model: modelId, sessionNameSuffix };
	const lines = buildWtftLines(ctx, pi, buildOpts);
	if (!lines || lines.length === 0) {
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
		widgetLines.push(...provisionalLines());
		ctx.ui.setWidget("wtft", widgetLines, { placement: "belowEditor" });
		return;
	}

	// ---
	// Append daemon status (inline if it fits, otherwise separate line).
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

	lines.push(...provisionalLines());

	ctx.ui.setWidget("wtft", lines, { placement: "belowEditor" });
}

// ---

// Periodic refresh (1 min) so the 24hr timeline diamond and surge APPROACHING/ENDING
// badges update in real time even without new session activity.
let _wtftCtx: any = null;
let _wtftRefreshTimer: ReturnType<typeof setInterval> | null = null;

export default function wtftExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		_wtftCtx = ctx;
		// Spawn daemon for this session to keep wtft-tag file warm for CLI use.
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile) {
			ensureDaemonRunning(sessionFile, _daemonDir);
		}

		if (hasConfig(WTFT_CONFIG_TOOL, WTFT_CONFIG_DIR)) {
			updateWtftWidget(ctx, pi);
		}
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

	pi.on("thinking_level_select", (event) => {
		_currentThinkingLevel = event.level;
	});

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

	pi.registerCommand("wtft", {
		description: "Where The F***ing Tokens?! (WTFT) - Cost Auditing Widget",
		handler: async (args, ctx) => {
			const opts = parseWtftCliArgs((args || "").trim().split(/\s+/).filter(Boolean));
			const { forceReparse, enableEmoji, showVersion, showHelp, showWhy,
				other, tokens, cost, hideWidget, hasInterval, interval,
				hasLimit, limit, hasWidth, width, hasTicks, showTicks,
				hasMode, mode, hasTimezone, timezone, pager } = opts;

			if (forceReparse) {
				const sessionFile = ctx.sessionManager.getSessionFile?.();
				if (!sessionFile) {
					ctx.ui.notify("No session file available for re-parse.", "warning");
					return;
				}
				const tagPath = getTagPath(sessionFile);
				const pidPath = getDaemonPidPath(sessionFile);
				try {
					const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
					if (pid > 0) {
						try { process.kill(pid, "SIGTERM"); } catch {}
					}
					try { fs.unlinkSync(pidPath); } catch {}
				} catch {}
				try { fs.unlinkSync(tagPath); } catch {}
				ensureDaemonRunning(sessionFile, _daemonDir);
				updateWtftWidget(ctx, pi);
				ctx.ui.notify("Tag file deleted and log parser daemon respawned — full session re-parse in progress.", "info");
				return;
			}

			if (typeof enableEmoji === "boolean") {
				writeConfig(WTFT_CONFIG_TOOL, { disabledEmoji: !enableEmoji }, undefined, WTFT_CONFIG_DIR);
				const statusText = enableEmoji ? "enabled" : "disabled";
				ctx.ui.notify(`Emoji icons in widgets have been ${statusText}.`, "info");
				updateWtftWidget(ctx, pi);
				return;
			}

			if (showVersion) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					ctx.ui.notify(renderWtftVersion(manifestPath, import.meta.url), "info");
				} catch (err) {
					ctx.ui.notify(`\u26A0\uFE0F Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			if (showHelp) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					ctx.ui.notify(renderWtftHelp(manifestPath, "/wtft"), "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

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
				ctx.ui.notify(withProvisionalLine(output), "info");
				return;
			}

			if (tokens || cost) {
			// --cost explicitly switches back to $ units.
			writeConfig(WTFT_CONFIG_TOOL, { tokens }, undefined, WTFT_CONFIG_DIR);
			updateWtftWidget(ctx, pi, { visible: true });

			if (tokens) {
				const BUDGET_MAP: Record<string, number> = {
					minimal: 1024, low: 4096, medium: 10240,
					high: 32768, xhigh: 65536, max: 131072
				};
				const budget = _currentThinkingLevel ? BUDGET_MAP[_currentThinkingLevel] : undefined;
				const interactions = readInteractions(ctx);
				const output = renderTokenSummary(interactions, Math.max(current.width, 40), budget, undefined, widgetSpawnTree(ctx, interactions));
				ctx.ui.notify(withProvisionalLine(output), "info");
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
					ctx.ui.notify(withProvisionalLine("No cost history found to display in the pager."), "warning");
					return;
				}
				lines.push(...provisionalLines());

				await ctx.ui.custom((tui, _theme, _keybindings, done) => {
					return new PagerComponent(lines, () => done(null));
				}, { overlay: true });
				return;
			}

			writeConfig(WTFT_CONFIG_TOOL, {
				interval: nextInterval,
				limit: nextLimit,
				showTicks: nextTicks,
				mode: nextMode,
				timezone: nextTimezone
			}, undefined, WTFT_CONFIG_DIR);

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
