#!/usr/bin/env -S node --experimental-strip-types
/** Command-line cost auditing for coding-agent sessions. Harness-agnostic (`--harness auto`). */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import wtftManifest from "../docs/manifests/wtft-cmd.json" with { type: "json" };
import {
	buildWtftLines,
	buildTimelineString,
	renderSpawnTree,
	emptyTotals,
	parseSessionFile,
	parseEntryToInteraction,
	classifyInteraction,
	normalizeCommand,
	extractCommandSegments,
	extractCwdFromBashCommand,
	extractRealCommands,
	claudeSpawnCwds,
	splitCommandWords,
	renderOtherHistogram,
	getSemanticCommandGroup,
	renderTokenSummary,
	renderSubagentBlock,
	deduplicateInteractions,
	scanUncountedBillables,
	scanUncountedBillablesChecked,
	newUncountedBillables,
	addUncountedBillables,
	readUncountedBillableClass,
	renderUncountedBillables,
	discoverSubagentSessionFiles,
	readSubagentMeta,
	readSubagentMetaChecked,
	discoverClaudeSubAgentSessionFiles,
	discoverClaudeSubAgentFilesForTurn,
	clearSubagentCacheMiss,
	loadSubagentInteractions,
	loadSubagentInteractionsChecked,
	attributeClaudeSubAgentCosts,
	collectSelfAttributedSessionIds,
	parseInterval,
	getBinInfo,
	calculateClaudeCost,
	calculateServerToolCost,
	getDeepSeekPeakMultiplier,
	getSurgeLocalHours,
	checkSurgeProximity,
	distributeHalfSlots,
	halfSlotCountsToArray,
	renderHalfBlockBar,
	CATEGORY_ORDER,
	watchTagFile,
	readClassifiedTagFile,
	seedClassifiedTagFile,
	readTagProvisional,
	readTagFileWithVerdict,
	lastLineStartByte,
	readPrefixSentinel,
	sentinelMatches,
	watcherAction,
	PREFIX_SENTINEL_BYTES,
	detectSessionHarness,
	buildSessionJson,
	type WtftSubagentJson,
	renderSessionJson,
	WTFT_JSON_SCHEMA,
	type WtftNotice,
	type UncountedBillables,
	getDaemonPidPath,
	getTagPath,
	forceRebuildSession,
	awaitDaemonUp,
	health,
	IDLE_THRESHOLD_MS,
	WTFT_TAGGER_VERSION,
	taggerIsOlder,
	describeForceRebuildFailure,
	describeProvisionalReason,
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
	describeFallbackPricing,
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
	cwdToSlug,
	cwdToStrictSlug,
	cwdSlugVariants,
	slugMatchesCwd,
	resetCwdCache,
	getCwdReadCount,
	getCwdBytesRead,
	getDirWalkCount,
	type WatchSettings,
	type Interaction,
	type ModelPricing,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";
import {
	runSpawnRecordCommand,
	readSpawnLedger,
	spawnLedgerPath,
	serializeSpawnRecord,
	appendSpawnRecord,
	SPAWN_RECORD_SCHEMA,
	SPAWN_RECORD_EXIT,
	MAX_RECORD_BYTES,
	MAX_FIELD_BYTES,
	isSessionId,
} from "../extensions/lib/wtft-spawn-ledger.ts";
import {
	computeSpawnTree,
	treeTotals,
	SPAWN_TREE_SCHEMA,
	DEFAULT_MAX_DEPTH,
	type SpawnTree,
} from "../extensions/lib/wtft-spawn-tree.ts";
import { subagentRows, type SubagentRow } from "../extensions/lib/wtft-subagent-block.ts";
import { loadConfig } from "@princess-pi/libs/config";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "../extensions/lib/wtft-config-dir.ts";
import {
	discoverSessions,
	harnessLabel,
	selectSessionPrompt
} from "../extensions/lib/session-selector.ts";
import { buildDisplayPath } from "@princess-pi/libs/session-path-shortener";
import {
	findRepoRoot,
	listWorktreeDirs,
	fanOutCwd,
	currentBranch,
	worktreeBranches,
	resolveBranchCheckout,
} from "../extensions/lib/harness/worktrees.ts";
import {
	parseWtftCliArgs,
	spawnWtftDaemon,
	isPendingSessionPath,
	isEmojiDisabled,
	renderWtftHelp,
	renderWtftWhy,
	renderWtftVersion,
} from "../extensions/lib/wtft-cli-shared.ts";
import {
	initPickerState,
	setRows,
	visibleWindow,
	applyKey,
	nextTimeWindow,
	windowMsFor,
	TIME_WINDOW_CYCLE,
	TIME_WINDOW_MS,
	ROW_LIMIT,
	VISIBLE_DATA_ROWS,
	type PickerState,
	type PickerRow,
	type PickerScope,
	type TimeWindowLabel,
	type PickerAction,
} from "../extensions/lib/picker-state.ts";
import { runDaemonCommand } from "../extensions/lib/cli/daemon-command.ts";
import { selectSession } from "../extensions/lib/cli/session.ts";
import { runForceRebuild } from "../extensions/lib/cli/force-rebuild.ts";
import { runWatch } from "../extensions/lib/cli/watch.ts";
import { runReport } from "../extensions/lib/cli/report.ts";
import {
	mainCloneDir,
	readHarnessOrder,
	recordHarnessOpened,
	orderByHarness,
} from "../extensions/lib/harness-order.ts";

// ---
// Re-exports for test imports from built bin/wtft.mjs
// (the bundler tree-shakes unused imports; explicit exports keep them in the bundle)
// ---
export {
	calculateClaudeCost,
	calculateServerToolCost,
	getDeepSeekPeakMultiplier,
	getSurgeLocalHours,
	checkSurgeProximity,
	resolveTieredRates,
	lookupModelPricing,
	MODEL_PRICING,
	applyUserPricing,
	isModelPriced,
	describeFallbackPricing,
	loadUserPricing,
	getUserPricingPath,
	parseEntryToInteraction,
	classifyInteraction,
	normalizeCommand,
	extractCommandSegments,
	extractCwdFromBashCommand,
	extractRealCommands,
	claudeSpawnCwds,
	splitCommandWords,
	renderOtherHistogram,
	getSemanticCommandGroup,
	buildWtftLines,
	buildTimelineString,
	parseSessionFile,
	deduplicateInteractions,
	renderTokenSummary,
	scanUncountedBillables,
	scanUncountedBillablesChecked,
	newUncountedBillables,
	addUncountedBillables,
	readUncountedBillableClass,
	renderUncountedBillables,
	discoverSubagentSessionFiles,
	readSubagentMeta,
	readSubagentMetaChecked,
	discoverClaudeSubAgentSessionFiles,
	discoverClaudeSubAgentFilesForTurn,
	clearSubagentCacheMiss,
	loadSubagentInteractions,
	loadSubagentInteractionsChecked,
	attributeClaudeSubAgentCosts,
	collectSelfAttributedSessionIds,
	parseInterval,
	getBinInfo,
	distributeHalfSlots,
	halfSlotCountsToArray,
	renderHalfBlockBar,
	CATEGORY_ORDER,
	serializeClassified,
	classifiedToInteraction,
	readClassifiedTagFile,
	seedClassifiedTagFile,
	readTagProvisional,
	readTagFileWithVerdict,
	lastLineStartByte,
	readPrefixSentinel,
	sentinelMatches,
	watcherAction,
	PREFIX_SENTINEL_BYTES,
	getTerminalWidth,
	WTFT_TAGGER_VERSION,
	health,
	getTagPath,
	getDaemonPidPath,
	IDLE_THRESHOLD_MS,
	splitOverheadCost,
	serializeClassifiedWithOverheadSplit,
	isInterruptMarker,
	discoverSessions,
	harnessLabel,
	buildSessionJson,
	type WtftSubagentJson,
	renderSessionJson,
	detectSessionHarness,
	WTFT_JSON_SCHEMA,
	runSpawnRecordCommand,
	readSpawnLedger,
	spawnLedgerPath,
	serializeSpawnRecord,
	appendSpawnRecord,
	isSessionId,
	SPAWN_RECORD_SCHEMA,
	SPAWN_RECORD_EXIT,
	MAX_RECORD_BYTES,
	MAX_FIELD_BYTES,
	computeSpawnTree,
	treeTotals,
	SPAWN_TREE_SCHEMA,
	DEFAULT_MAX_DEPTH,
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
	cwdToStrictSlug,
	cwdSlugVariants,
	slugMatchesCwd,
	getCwdBytesRead,
	getDirWalkCount,
	buildDisplayPath,
	findRepoRoot,
	listWorktreeDirs,
	fanOutCwd,
	currentBranch,
	worktreeBranches,
	resolveBranchCheckout,
	initPickerState,
	setRows,
	visibleWindow,
	applyKey,
	nextTimeWindow,
	windowMsFor,
	TIME_WINDOW_CYCLE,
	TIME_WINDOW_MS,
	ROW_LIMIT,
	VISIBLE_DATA_ROWS,
	mainCloneDir,
	readHarnessOrder,
	recordHarnessOpened,
	orderByHarness,
	type PickerState,
	type PickerRow,
	type PickerScope,
	type TimeWindowLabel,
	type PickerAction
}

export { EXIT_PROVISIONAL, EXIT_SESSION_AMBIGUOUS } from "../extensions/lib/cli/exit-codes.ts";

// ---

const cfg = loadConfig(WTFT_CONFIG_TOOL, { interval: "1h", limit: 100, mode: "cumulative" }, WTFT_CONFIG_DIR) as {
	interval?: string;
	limit?: number;
	mode?: "bucket" | "cumulative";
	timezone?: string;
	tokens?: boolean;
};

// Manifest is imported so the bundler inlines it — package `files` ships only bin/*.mjs.
const manifest = wtftManifest;
const daemonDir = path.dirname(fileURLToPath(import.meta.url));

// Positional `spawn-record` skips main() at the entry-point guard (parseWtftCliArgs
// ignores unknown args, so falling through would quietly run a full report).
const isSpawnRecord = process.argv[2] === "spawn-record";

const opts = parseWtftCliArgs(process.argv.slice(2));

let unit: "cost" | "tokens" = cfg.tokens ? "tokens" : "cost";
if (opts.hasTokens) unit = "tokens";
if (opts.hasCost) unit = "cost";


async function main() {
	loadUserPricing();

	// Config-declared harnesses must register before discovery.
	await loadExternalHarnesses();

	if (opts.showHelp) {
		console.log(renderWtftHelp(manifest, "wtft"));
		return;
	}
	if (opts.showWhy) {
		console.log(await renderWtftWhy(manifest, "wtft"));
		return;
	}
	if (opts.showVersion) {
		console.log(renderWtftVersion(manifest, import.meta.url));
		return;
	}

	// -p/--pager is a Pi TUI overlay only — refuse rather than silently drop or page.
	if (opts.pager) {
		console.error("❌ Error: -p/--pager is a Pi TUI overlay and is not available in the CLI. Pipe to a pager instead: wtft … | less -R");
		process.exit(1);
	}

	if (opts.daemonList || opts.daemonCleanup || opts.daemonRestart || opts.daemonStop) {
		runDaemonCommand(opts, daemonDir);
		return;
	}

	const sessionPath = await selectSession(opts);
	if (opts.forceReparse) await runForceRebuild(sessionPath, daemonDir);
	if (opts.showWatch) {
		await runWatch(opts, sessionPath, daemonDir, unit);
		return;
	}
	await runReport(opts, sessionPath, daemonDir, unit);
}

if (process.argv[1]) {
	const entry = fileURLToPath(import.meta.url);
	const invoked = process.argv[1];
	if (invoked === entry || invoked.endsWith("/wtft") || invoked.endsWith("/wtft.mjs")) {
		if (isSpawnRecord) {
			const result = runSpawnRecordCommand(process.argv.slice(3));
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
			process.exitCode = result.exitCode;
		} else {
			main().catch(err => {
				console.error(`❌ System Error: ${err.message}`);
				process.exit(1);
			});
		}
	}
}
