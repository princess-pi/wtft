/**
 * @package princess-pi-tools
 * @module wtft-tagger-version
 * @description The tagger version — the ONE definition (#499). The daemon stamps
 *   it into every tag filename (`.wtft-tag.v{N}.jsonl`); readers resolve tag
 *   files by it. It lives alone in this leaf module so tag READERS (e.g.
 *   session-selector, which deliberately avoids daemon internals) can import the
 *   version without pulling in tag-file I/O. Never mirror this value into
 *   another file: a mirrored copy sat stale across every bump since 2.3.8 (found at 2.7.1) with
 *   nothing to diff it against.
 *
 * Bump it whenever tag SEMANTICS change and stale tags must re-parse:
 */
// 2.5.1 (#52 Phase 3): compaction/recache meter-split emits dual lines
// (main + "#oh" overhead line), interrupted turns carry `ir` — stale caches
// lack all three and must re-classify.
// 2.6.0 (#139/#140/#141): Claude 5 family pricing + user pricing registry
// change baked-in costs, and workflow subagent discovery adds transcripts —
// stale tags carry wrong totals and must re-parse.
// 2.6.1 (#146): 1h-TTL cache writes re-priced from 2.5x to 2.0x input for
// registry models — v2.6.0 tags overbill Claude Code sessions.
// 2.7.0 (#152): adds `miss` (observed cache miss). Cannot be back-derived from
// v2.6.1 tags — the meter-split writes cr and cw onto separate lines, so a full
// miss and a partial re-prime are indistinguishable once tagged.
// 2.7.1 (#148): claude-sonnet-5 re-priced to intro rate ($2/$10/$0.20/$2.50,
// derived 1h write $4.00) for interactions before 2026-09-01, was flat
// post-intro $3/$15 — v2.7.0 tags overbill every Sonnet 5 line by 50%.
// 2.7.2 (#22 A): server-tool cost now requires a `claude`/`anthropic` marker in
// the model id — a bare `opus`/`sonnet`/`haiku` id billed $0.03 per web_search
// request and now bills 0. The per-turn figure is baked into the tag as `sc`
// (wtft-daemon-lib), so a v2.7.1 tag from such a session keeps the overbill.
// Measured on this host: ZERO affected turns — no session records an alias-only
// model id with a server_tool_use block. The bump is for the hosts where a
// `claude-deepseek` session (ANTHROPIC_MODEL="opus") did record one, which this
// machine cannot rule out for anyone else.
// 2.7.3 (#100): DeepSeek V4.1 Flash. `deepseek-flash` gained a registry entry
// (was priced by the sibling GUESS at 0.22/0.66), and `deepseek-v4-flash`,
// `deepseek-v4-flash-vision-exp` and `deepseek-v4-pro` gained a dated window
// each because their names now route to V4.1 Flash. The per-turn dollar figure
// is baked into every tag line as `c` (serializeClassified, wtft-daemon-lib),
// so a v2.7.2 tag written after a name's cutover keeps that name's pre-cutover
// price. Worst case is `deepseek-v4-pro` after 2026-09-14T04:00Z: 0.66 against
// 0.15 input, 4.4x, and 0.022 against 0.003 on cache reads, 7.3x. The two
// v4-flash names are 1.47x on input from 2026-09-10T04:00Z, and `deepseek-flash`
// carries the full sibling-guess error, having had no entry at all.
// 2.8.0 (#106, with #10 and #11): classification semantics change wholesale.
// `gh` and the pr-/git- wrappers now classify `git`; test runners `tests`;
// build/typecheck `code`; shell file reads/writes and inline python3/node script
// bodies classify by the PATH they touch; a bash string is segmented so every
// command in it is read rather than only the first; and the tool map gained each
// harness's own spellings (Pi's `search_web`, `todo_write`) plus the MCP suffix
// rule. `other` falls by roughly three quarters on a deduplicated corpus, and
// the reclaimed dollars land in git/spec/code/tests.
//
// The measured figures live in docs/spec-52-finer-grain-categories.md
// Amendment 4 and are deliberately NOT repeated here. Two drafts of this comment
// carried numbers that contradicted that spec — one put Pi's pair under Claude
// Code's name, one went stale by a percentage point — because a figure copied
// into a second file has nothing holding the copies together. This comment
// points; the spec asserts; research/other-corpus/before-after.ts derives.
//
// The bump is the whole point, not bookkeeping: `_cat` is baked into every tag
// line and `classifyInteraction` SHORT-CIRCUITS on it (wtft-parser.ts), so a
// v2.7.3 tag keeps its old `other` attribution for the life of the file. Without
// this bump the change is inert on every session anyone has already run — which
// is every session that matters. Minor rather than patch: this is the largest
// semantic move since 2.5.1.
//
// Costs are NOT frozen by this bump, and an earlier draft of this comment
// claimed they were ("no cost figure changes, only the bucket"). Reclassifying
// cannot move a dollar between sessions, but the same change widens `claude -p`
// subagent discovery, and a subagent found for the first time adds cost that
// was previously invisible — measured at +$0.42 across the 250-session corpus
// (#3/#138). A session total may therefore RISE after this bump; it must never
// fall, and research/other-corpus/before-after.ts fails if it does.
export const WTFT_TAGGER_VERSION = "2.8.0";
