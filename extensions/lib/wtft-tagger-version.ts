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
export const WTFT_TAGGER_VERSION = "2.7.1";
