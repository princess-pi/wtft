import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildWtftLines, chartLimit, renderSpawnTree, emptyTotals, renderOtherHistogram, renderTokenSummary, renderSubagentBlock, deduplicateInteractions, scanUncountedBillables, scanUncountedBillablesChecked, newUncountedBillables, addUncountedBillables, discoverSubagentSessionFiles, readSubagentMetaChecked, readTagProvisional, readTagFileWithVerdict, detectSessionHarness, buildSessionJson, type WtftSubagentJson, renderSessionJson, type WtftNotice, type UncountedBillables, getTagPath, awaitDaemonUp, IDLE_THRESHOLD_MS, WTFT_TAGGER_VERSION, taggerIsOlder, describeProvisionalReason, isModelPriced, describeFallbackPricing, getUserPricingPath, getCurrentVersionTagPath, resolveLastCwd, type Interaction, getTerminalWidth } from "../wtft-shared.js";
import { computeSpawnTree, type SpawnTree } from "../wtft-spawn-tree.js";
import { subagentRows, type SubagentRow } from "../wtft-subagent-block.js";
import { readConfig } from "@princess-pi/libs/config";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "../wtft-config-dir.js";
import { spawnWtftDaemon, isEmojiDisabled } from "../wtft-cli-shared.js";
import type { WtftCliOptions } from "../wtft-cli-shared.js";
import { EXIT_PROVISIONAL } from "./exit-codes.js";

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

/** The one action that ends the provisional state. Does not name `-F`. */
function describeProvisionalRemedy(provisional: { reason: string | null }, tagPath: string): string {
	if (provisional.reason === "descendant-live") {
		return `run wtft again once every descendant has been quiet for ${IDLE_THRESHOLD_MS / 1000} s`;
	}
	if (provisional.reason === "stale-version") {
		// A newer build's daemon keeps its tag, so no rebuild comes.
		const version = /\.wtft-tag\.v([\d.]+)\.jsonl$/.exec(tagPath)?.[1];
		return version && taggerIsOlder(WTFT_TAGGER_VERSION, version)
			? "This tag was written by a newer wtft build — update this wtft to read it at its own version"
			: "The daemon is rebuilding this tag at the current version — run wtft again in a moment to read the settled total";
	}
	return provisional.reason === "subagent-unreadable"
		? "restore the unreadable session file's readability, then run wtft again — the daemon re-reads it on its next poll, and wtft reads it directly on the --tokens and --json paths"
		: "The daemon is still reading this session's subagents into its tag — run wtft again once they have stopped writing to read the settled total";
}

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

/** One report: spawn the daemon, read its tag, and print the chart, `--tokens` or `--json`. */
export async function runReport(opts: WtftCliOptions, finalSessionPath: string, daemonDir: string, unit: "cost" | "tokens"): Promise<void> {
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
				: { turns: interactions, rootCwd: resolveLastCwd(finalSessionPath), rootFile: finalSessionPath },
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
		console.error(`\x1b[33m⚠ PROVISIONAL: ${describeProvisionalReason(provisional, tagPath)}. ${describeProvisionalRemedy(provisional, tagPath)}. Exit ${EXIT_PROVISIONAL}.\x1b[0m`);
	};

	// `pending` pins "file absent" decided before awaitDaemonUp — do not re-derive after.
	const finishEmptyReport = (opt: { pending?: boolean } = {}) => {
		if (!opt.pending) scanSessionUncounted();
		// Before the warning and the exit code: the tree can set `provisional`.
		const emptyArmSubagents = opts.tokens && !opt.pending ? collectSubagentJson() : undefined;
		for (const n of emptyArmSubagents?.notices ?? []) warnNotice(n);
		const emptyArmBlock = emptyArmSubagents ? renderSubagentBlock(emptyArmSubagents.block) : "";
		const emptyArmTree = opts.tokens ? renderSpawnTree(emptyTotals(), sessionSpawnTree({ pending: opt.pending })) : "";
		warnProvisionalOnce();
		// SUBAGENTS and SPAWNED under `--tokens` even when own total is empty (matches populated path).
		// Same --pad as the populated path.
		const emptyPad = " ".repeat(Math.min(opts.hasPad ? opts.pad : 1, Math.max(0, Math.floor(getTerminalWidth() / 2) - 1)));
		const padded = (s: string) => s.split("\n").map(l => (l ? emptyPad + l : l)).join("\n");
		if (emptyArmBlock) process.stdout.write(padded(emptyArmBlock));
		if (emptyArmTree) process.stdout.write(padded(emptyArmTree));
		// exitCode, never process.exit — stdout is async on a pipe.
		process.exitCode = provisional.provisional ? EXIT_PROVISIONAL : 0;
	};

	/** A notice names a file path, which can hold a newline or an escape sequence. */
	const warnNotice = (n: WtftNotice) => console.error(`\x1b[33m⚠ ${n.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD")}\x1b[0m`);

	/** Subagents this session spawned. `rows` omitted (not `[]`) when discovery was incomplete. */
	const collectSubagentJson = (): { rows: WtftSubagentJson[] | undefined; notices: WtftNotice[]; block: SubagentRow[] } | undefined => {
		if (!fs.existsSync(finalSessionPath)) return undefined;
		const discovered = discoverOnce();
		const notices: WtftNotice[] = [];
		const listed = discovered.files.map(transcript => {
			const read = readSubagentMetaChecked(transcript);
			if (read.error) {
				notices.push({ code: "subagent-meta-unreadable", text: `subagent metadata could not be read (${read.metaPath}): ${read.error.message}` });
			}
			return { transcript, meta: read.meta };
		});
		// One computation for both surfaces, so the rendered row and the JSON
		// field cannot disagree.
		// An older tagger's lines carry no source key, so no line can be attributed:
		// the totals are unknown, not null.
		if (tagPath !== getCurrentVersionTagPath(finalSessionPath)) {
			return discovered.unreadable ? { rows: undefined, notices, block: [] } : { rows: listed, notices, block: [] };
		}
		// Built-in means Claude Code's `<session>/subagents/` layout; a Pi sibling is not one.
		const builtinDir = path.join(path.resolve(path.dirname(finalSessionPath)), path.basename(finalSessionPath, ".jsonl"), "subagents") + path.sep;
		const all = subagentRows(interactions, listed, path.dirname(finalSessionPath));
		const block = all.filter(r => path.resolve(r.transcript).startsWith(builtinDir));
		const totalOf = new Map(all.map(r => [r.transcript, r.total]));
		const rows = listed.map(r => ({ ...r, total: totalOf.get(r.transcript) ?? null }));
		// A partial list is never shown as whole, on either surface.
		return discovered.unreadable ? { rows: undefined, notices, block: [] } : { rows, notices, block };
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
					? [{ code: "provisional" as const, text: `${describeProvisionalReason(provisional, tagPath)}. ${describeProvisionalRemedy(provisional, tagPath)}.` }]
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
			console.error(`\x1b[31m❌ wtft-daemon exited ${how} before serving this session — nothing is waiting on ${finalSessionPath}\x1b[0m`);
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
	const finalLimit = chartLimit(opts, sessionLimit);
	const finalMode = opts.hasMode ? opts.mode : (sessionMode ?? "cumulative");
	const finalTimezone = opts.hasTimezone ? opts.timezone : sessionTimezone;

	const defaultSettings = {
		interval: "1h",
		limit: 100,
		width: Math.min(paddedWidth, 1023),
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: undefined
	};

	const outputLines = buildWtftLines(interactions, defaultSettings, {
		interval: finalInterval,
		limit: finalLimit,
		padRowsTo: finalLimit,
		width: Math.min(paddedWidth, 1023),
		mode: finalMode,
		timezone: finalTimezone,
		disabledEmoji,
		sessionNameSuffix: path.basename(finalSessionPath),
		unit,
		showCostColumns: !opts.hideCostColumns,
		showTokenColumns: !opts.hideTokenColumns,
	});

	console.log(padStr + `\x1b[90m${finalSessionPath}\x1b[0m`);
	for (const line of outputLines!) {
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
		const subagents = collectSubagentJson();
		for (const n of subagents?.notices ?? []) warnNotice(n);
		const tokenOutput = renderTokenSummary(interactions, Math.min(paddedWidth, 1023), opts.thinkingBudget, scanSessionUncounted(), sessionSpawnTree(), subagents?.block);
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
		const remedy = describeProvisionalRemedy(provisional, tagPath);
		console.error(`\x1b[90m  ${remedy}. Exit ${EXIT_PROVISIONAL}.\x1b[0m`);
		process.exitCode = EXIT_PROVISIONAL;
		return;
	}
}
