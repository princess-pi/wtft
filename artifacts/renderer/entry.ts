export { parseWtftCliArgs } from "../../extensions/lib/wtft-cli-shared.ts";
export { CATEGORY_STYLE } from "../../extensions/lib/wtft-renderer.ts";
// The parser's pure per-line half, for the parser playground (artifacts/parser/).
// File-reading entry points (parseSessionFile, subagent discovery) stay out: in
// the browser `node:fs` is empty.
export {
	applyControlEntry,
	classifyInteraction,
	commandSpawnsAgent,
	deduplicateInteractions,
	INTERRUPT_PREFIX,
	isInterruptMarker,
	newParseStreamState,
	normalizeCommand,
	parseEntryToInteraction,
	readControlEntry,
	splitOverheadCost,
	type Category,
	type Interaction,
	type ParseStreamState,
} from "../../extensions/lib/wtft-parser.ts";
export { extractRealCommands, splitCommandWords } from "../../extensions/lib/wtft-command-shapes.ts";
export { ansiToHtml, stripAnsi, xtermRgb } from "./ansi.ts";
export { renderReport, withTerminal, type Report, type ReportEnv } from "./report.ts";
export { WTFT_MODELS, wtftSession } from "./fake-session.ts";
export { FAIR_ITEMS, FAIR_TZ, SOUVENIRS, fairBooth } from "./fair-session.ts";
export { FAIR_DEFAULTS, renderFair, type FairPicture, type FairState, type Substitution } from "./fair.ts";
export { PRESETS, SPEC_PIN, type Preset } from "./presets.ts";
export { decidedBy, parseJsonlText, type Decider, type LineNote, type ParsedText, type ParsedTurn } from "./parse-text.ts";
export { PARSER_PRESETS, presetText, type ParserPreset } from "./parser-presets.ts";
