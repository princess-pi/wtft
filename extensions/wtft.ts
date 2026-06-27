import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
	buildWtftLines as sharedBuildWtftLines,
	type Category,
	type Interaction,
	classifyInteraction,
	formatCost,
	parseEntryToInteraction,
	renderOtherHistogram,
	getTerminalWidth
} from "./lib/wtft-shared.js";

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
	let showTicks = true;
	let mode: "bucket" | "cumulative" = "cumulative";
	let pager = false;
	let other = false;
	let enableEmoji: boolean | undefined = undefined;

	let hasInterval = false;
	let hasLimit = false;
	let hasWidth = false;
	let hasTicks = false;
	let hasMode = false;
	let hasTimezone = false;
	let hasOther = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			showHelp = true;
		} else if (arg === "--hide" || arg === "-H") {
			hideWidget = true;
		} else if (arg === "--show" || arg === "-S") {
			showWidget = true;
		} else if (arg === "-o" || arg === "--other") {
			other = true;
			hasOther = true;
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
		pager,
		hasInterval,
		hasLimit,
		hasWidth,
		hasTicks,
		hasMode,
		hasTimezone,
		hasOther,
		other,
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

function isEmojiDisabled(ctx: any): boolean {
	if (!ctx || !ctx.sessionManager) return false;
	let disabled = false;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "emoji-settings") {
			if (entry.data && typeof entry.data.disabled === "boolean") {
				disabled = entry.data.disabled;
			}
		}
	}
	return disabled;
}

/**
 * Retrieves setting configurations stored persistently in the session log.
 * Defaults mode to "cumulative" for cohesive cost progression tracks.
 */
function getSettings(ctx: any) {
	let interval = "1h";
	let limit = 10;
	
	const disabledEmoji = isEmojiDisabled(ctx);
	// Reset default fallback to 240 max so we can easily test scaling down on-the-fly to terminal columns
	const termColumns = getTerminalWidth(true, disabledEmoji);
	let width = 240;
	let widthIsLocked = false;
	let visible = false; // Default invisible on fresh session
	let showTicks = true;
	let mode: "bucket" | "cumulative" = "cumulative";
	let timezone: string | undefined = "America/Los_Angeles";

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "wtft-settings") {
			if (entry.data) {
				if (entry.data.interval) interval = entry.data.interval;
				if (typeof entry.data.limit === "number") limit = entry.data.limit;
				if (typeof entry.data.width === "number") {
					if (entry.data.widthIsLocked) {
						width = Math.min(entry.data.width, termColumns, 240);
						widthIsLocked = true;
					} else {
						// Responsive auto-fit on the fly!
						const termColumnsDynamic = getTerminalWidth(true, disabledEmoji);
						width = Math.min(termColumnsDynamic, 240);
					}
				}
				if (typeof entry.data.visible === "boolean") visible = entry.data.visible;
				if (typeof entry.data.showTicks === "boolean") showTicks = entry.data.showTicks;
				if (entry.data.mode) mode = entry.data.mode;
				if (entry.data.timezone) timezone = entry.data.timezone;
			}
		}
	}

	return { interval, limit, width, widthIsLocked, visible, showTicks, mode, timezone, disabledEmoji };
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
	}
): string[] | null {
	const branch = ctx.sessionManager.getBranch();
	const interactions: Interaction[] = [];

	for (let i = 0; i < branch.length; i++) {
		const interaction = parseEntryToInteraction(branch[i]);
		if (interaction) {
			interactions.push(interaction);
		}
	}

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

	const lines = buildWtftLines(ctx, pi, opts);
	if (!lines) {
		ctx.ui.setWidget("wtft", undefined);
		return;
	}

	ctx.ui.setWidget("wtft", lines, { placement: "belowEditor" });
}

// ---
// MAIN EXTENSION ENTRY POINT
// ---

export default function wtftExtension(pi: ExtensionAPI) {
	// 1. Auto-restore on startup
	pi.on("session_start", async (_event, ctx) => {
		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 2. Auto-refresh on turn completion (zero token cost)
	pi.on("agent_end", async (_event, ctx) => {
		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 3. Command registration
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
				pager,
				hasInterval,
				hasLimit,
				hasWidth,
				hasTicks,
				hasMode,
				hasTimezone,
				hasOther,
				other,
				enableEmoji
			} = parseArgs(args);

			if (typeof enableEmoji === "boolean") {
				pi.appendEntry("emoji-settings", { disabled: !enableEmoji });
				const statusText = enableEmoji ? "enabled" : "disabled";
				ctx.ui.notify(`Emoji icons in widgets have been ${statusText}.`, "info");
				updateWtftWidget(ctx, pi);
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

			const current = getSettings(ctx);

			if (other) {
				const branch = ctx.sessionManager.getBranch();
				const interactions = branch
					.map((entry: any) => parseEntryToInteraction(entry))
					.filter((i: any): i is NonNullable<typeof i> => i !== null);
				
				const output = renderOtherHistogram(interactions, Math.max(current.width, 40));
				ctx.ui.notify(output, "info");
				return;
			}

			if (hideWidget) {
				pi.appendEntry("wtft-settings", {
					interval: current.interval,
					limit: current.limit,
					width: current.width,
					visible: false,
					showTicks: current.showTicks,
					mode: current.mode,
					timezone: current.timezone
				});
				ctx.ui.setWidget("wtft", undefined);
				ctx.ui.notify("Token cost audit widget hidden.", "info");
				return;
			}

			const nextInterval = hasInterval ? interval : current.interval;
			const nextLimit = hasLimit ? limit : current.limit;
			
			// Dynamic fallback (minus safety padding) capped at 240 if no explicit width set
			const termColumns = getTerminalWidth(true, isEmojiDisabled(ctx));
			const nextWidth = hasWidth ? Math.min(width, 240) : Math.min(termColumns, 240);
			const nextWidthIsLocked = hasWidth || current.widthIsLocked || false;
			
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

			pi.appendEntry("wtft-settings", {
				interval: nextInterval,
				limit: nextLimit,
				width: nextWidth,
				widthIsLocked: nextWidthIsLocked,
				visible: true,
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
