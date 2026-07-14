# Spec #52 — Finer-grain category mapping (Phases 1–2)

Umbrella: [#52](https://github.com/duppypro/princess-pi-packages/issues/52). This spec covers
Phase 1 (relabel) and Phase 2 (tool recognition) of the resolution plan posted 2026-07-13.
Phase 3 (compaction/interrupted overhead classes) reserves its categories here but wires them
in a follow-up slice.

---

## Measurements driving the spec (2026-07-13)

`debug/measure-prompt-composition.mjs` over three real Claude Code sessions
(193 / 316 / 33 deduped assistant messages):

| Session | prompt-like output-token share | …of which unmodeled tools | thinking-only msgs |
|---|---|---|---|
| 8548d7f1 (2.5 MB) | 39.9% | 9.1% | **0** |
| f2661571 (4.1 MB) | 20.1% | 4.6% | **0** |
| ea0143ab (current) | 6.9% | 0.0% | **0** |

Top unmodeled tools: `Agent`×13, `WebFetch`×7, `TaskCreate`/`TaskUpdate`×8, `AskUserQuestion`,
`ToolSearch`, `WebSearch`, `Skill`, `Monitor`.

**Consequences:**
1. **No CoT category.** Zero thinking-only messages — thinking blocks always co-occur with a
   text block or tool call in the same message, so no reasoning turn is misfiled as `prompt`.
   A reasoning *category* would catch nothing; reasoning stays a *dimension* (Direction B,
   deferred). Naming decision recorded for when B lands: legend label **"CoT"** (industry-standard,
   self-explanatory) over "Sys2" (requires Kahneman context).
2. **`agents` earns its own category.** Subagent spawns are the single largest unmodeled tool
   and are billed the parent's orchestration tokens.
3. **`plan` earns its own category** (Duppy decision 2026-07-13): planning/steering tools split
   out of `prompt` so `prompt` means *conversational reply*, nothing else.

---

## Phase 1 — Relabel (Direction E)

The bars are faithful *cost totals tagged by the turn's action* — not a decomposition of tokens
by purpose. Labels must say so.

- `docs/manifests/wtft-cmd.json` `description`: reword to "…bar chart of your session's **cost
  during each activity** (Spec, Code, Plan, Agents, …)". Add one sentence: "Prompt = conversational
  replies; every turn's cost includes the context re-send overhead regardless of category. For an
  input/output token decomposition use `--tokens`."
- First `why` entry `result`: same rewording.
- No renderer string changes needed beyond the legend additions in Phase 2 (legend labels are
  category names, not claims).

## Phase 2 — Tool recognition (Direction C core)

### Category union (single source of truth)

`Category` and `Interaction` are currently **referenced everywhere but defined nowhere** — the
definitions were lost in the #68 monolith split and the gap is invisible because `build.mjs`
strips types without typechecking. Fix: define and export both in `extensions/lib/wtft-parser.ts`.

```
Category = spec | code | mixed | tests | research | git | grep
         | web | agents | plan | prompt | compaction | interrupted | other
```

`compaction` and `interrupted` are **reserved now** (so the daemon tag-file version bumps once)
and wired in Phase 3.

### Tool → category map (`tool_use` blocks, Claude Code; `toolCall`, Pi)

| Tool name (lowercased) | Effect |
|---|---|
| `task`, `agent`, `workflow` | toolCat `agents` |
| `websearch`, `webfetch` | toolCat `web` (token side; #73 request-cost side already bills `web`) |
| `grep` | toolCat `grep` |
| `todowrite`, `taskcreate`, `taskupdate`, `taskget`, `tasklist`, `askuserquestion`, `enterplanmode`, `exitplanmode`, `skill`, `toolsearch` | toolCat `plan` |
| `notebookedit` | file write (`args.notebook_path`) — classified by path like `edit` |
| any other tool | marks `hasUnrecognizedTool` |

### Path rule: `docs/research/` → `plan` (Duppy decision 2026-07-13)

Written explorations are thinking artifacts, not normative specs. `docs/research/**`
(analysis docs, audits, why-not writeups) classifies **`plan`** for both reads and writes
— checked *before* the general `docs/` → `spec` rule. The taxonomy's clean lines:

- **spec** — normative specification documents (`docs/`, `.md` elsewhere)
- **plan** — steering/thinking artifacts: planning tools *and* `docs/research/` documents
- **research** — running experiments: code and mock data (root `research/`)

Observation recorded, no classifier change: root `research/` currently holds ten `.md`
files that are mostly specs (`14-token-unit-mode-spec.md`, `serve-*-spec.md`, …). The
`.md` rule already classifies them `spec` — accidentally correct, but they likely belong
under `docs/` per the convention above. File-placement cleanup, separate from #52.

### Mechanism

- `Interaction` gains `toolCats?: Category[]` (populated at parse time, serialized to the tag
  file like `files`/`commands`).
- `classifyInteraction` precedence (top wins):
  1. file **writes** (existing, incl. `mixed` on multi-target writes)
  2. file **reads** (existing, incl. `mixed`)
  3. toolCats by priority `agents` > `web` > `plan` > `grep`
  4. bash commands (`git` / `grep` / `other`) — existing
  5. texts → `prompt`
  6. fallback → `other`
- **Prompt purification:** a message with any `tool_use`/`toolCall` block but no recognized
  mapping and no files/commands classifies `other`, never `prompt` — `prompt` becomes purely
  "Claude replied/planned in prose".

### Amendment 2 (Duppy decisions 2026-07-13, pre-merge testing)

**Workflow-order display.** One `CATEGORY_ORDER` constant in the renderer drives the legend,
the cost-mode stacked bar, the bucket-mode marker chart, and token-mode segments — so bar
stacking always matches legend order by construction:

```
plan → spec → research → web → grep → code → tests → git → agents → prompt
     → compaction → interrupted → other
```

Rationale: mirrors the 5-step flow (plan/grill → spec → research → build → test → commit),
with support activities adjacent to the stage they serve (web by research, grep by code),
delegation (`agents`) and conversation (`prompt`) after, harness overhead last.

**`mixed` removed.** With finer-grained assignment, multi-category turns now resolve by
**latest-workflow-stage-wins** priority instead of collapsing to `mixed`:
`tests > code > research > spec > plan` (writes first, then reads, as before). A TDD turn
writing code + tests reads `tests`; a spec tweak during coding reads `code` — the furthest
stage is the turn's real progress; earlier-stage touches are supporting edits. Roads not
taken: keeping `mixed` (hides exactly the signal #52 exists to surface); splitting cost
across categories (blocked by the per-message billing floor). Tagger → **2.4.2**.

### Renderer additions

| Category | Legend | fg (legend/bar) | bg (token mode) |
|---|---|---|---|
| `agents` | Agents | 141 (violet) | 55 (dark purple) |
| `plan` | Plan | 116 (soft cyan) | 30 (dark cyan) |
| `compaction` (Phase 3) | Cmpct | 143 (olive) | 58 (dark olive) |
| `interrupted` (Phase 3) | Intr | 167 (soft red) | 52 (dark red) |

Touch points: `TOKEN_BG_COLORS`, `legendItems`, `accumulateTokens` init list, `ALL_CATEGORIES`,
`categoriesInReverse`. Phase 3 categories get colors now but stay out of `legendItems` until wired.

### Daemon tag-file version

`WTFT_TAGGER_VERSION` `2.3.8` → `2.4.0` — stale `classified.jsonl` caches carry `_cat` values
from the old map and must re-classify.

---

## Verification (Code Approved gate)

1. New fixture + test in `tests/`: a synthetic session.jsonl containing messages with `Task`,
   `WebSearch`, `Grep`, `TodoWrite`, `NotebookEdit`, an unknown tool (`Monitor`), a pure reply,
   and a `bash git` turn — assert each classification, including prompt purification.
2. Existing suites pass (`npm test`).
3. Re-run the classification over session `8548d7f1` and record before/after `prompt`+`other`
   share in the issue (expect the ~9% unmodeled-tool share to migrate to `agents`/`web`/`plan`).
4. `npm run build` then run built `bin/wtft.mjs --tokens` and cost mode against a live session —
   legend shows Plan/Agents, no color collisions, daemon regenerates tags at v2.4.0.

## Verification results (2026-07-13, Code Approved b83127a)

All four gates passed:

1. `tests/wtft-issue-52-tool-categories.test.ts` — **25/25 pass** (tool map, prompt
   purification, precedence, Pi schema, dedup toolCats merge).
2. All 15 existing wtft suites pass. (`tests/session-name-display.test.ts` fails
   pre-existing: `@earendil-works/pi-tui` absent from repo `node_modules` — Pi sandbox only.)
3. Live before/after on session `8548d7f1` ($36.13, 193 messages), old classifier taken
   from the `a5a8cbd` build:

   | Category | Before | After |
   |---|---|---|
   | other | 101 msgs · 49.5% | 95 msgs · 44.4% |
   | prompt | 57 msgs · 37.1% | 46 msgs · 32.7% |
   | web | — | 9 msgs · 6.2% |
   | plan | — | 5 msgs · 1.9% |
   | agents | — | 3 msgs · 1.4% |

   `prompt`+`other` fell 86.6% → 77.1% — the migrated $3.44 matches the predicted ~9%
   unmodeled-tool share from the pre-spec measurement.
4. Built `bin/wtft.mjs` renders cost and `--tokens` modes with the Agents/Plan legend and
   new bar segments; daemon regenerated tags at v2.4.0.

**Amendment (Code Approved `044ceeb`):** `docs/research/` → `plan` path rule verified —
suite grew to 30/30 (write→plan, read→plan, `docs/` still spec, root `research/` code still
research). Tagger bumped to **2.4.1**.

**Amendment 2 (Code Approved `43a3ea0`):** workflow-order `CATEGORY_ORDER` + `mixed` removal
verified — suite at 32/32 (latest-stage-wins: research+src→code, src+tests→tests,
spec+src→code); all 15 suites pass after assertion updates; live render confirms legend and
bar segment order match by construction. Tagger bumped to **2.4.2**.

## Amendment 3 (Phase 3, Spec Draft 2026-07-14) — wire `compaction` + `interrupted`

The two harness-overhead categories reserved since Phase 1 (`label: null` in
`CATEGORY_STYLE`) get detection, attribution, and legend labels.

### Corrected measurements (live sessions, 2026-07-14)

The Phase-1 plan's assumptions do not survive contact with transcript data:

| Assumed | Measured |
|---|---|
| `interrupted: true` field marks interrupts | No such true-valued field exists; `"interrupted":false` is tool-result metadata. Real marker: `type:"user"` entry whose content text is `[Request interrupted by user]` |
| 36–220 interrupts per session | 1–3 (the big number counted the always-present metadata flag) |
| Compaction cost visible on the marker | Marker (`isCompactSummary:true`, `type:"user"`) carries **zero usage** — as does the interrupt marker |

Cost reality: the assistant message immediately after a compact summary wrote
**34,538 cache tokens vs. a 981 median** (35×) — compaction cost is real and lands
on exactly one adjacent message. Interrupted turns are cost-unremarkable but their
spend is discarded work, worth honest labeling.

### Detection and attribution (rev 2 — meter-split, per the split-strategies research)

Grounding: `docs/research/52-split-strategies/` measured that the post-compaction
and recache turns' overhead is exactly their **cache_write meter component** — an
exact billing decomposition, not an estimate — while interrupted turns are wholly
wasted spend. Three attributions:

- **Compaction (meter-split)** — Claude Code: `entry.isCompactSummary === true`
  (a `user` entry, zero usage) flags the **next** assistant interaction; Pi:
  `type:"compaction"` stamping (#90) flags likewise. The flagged interaction's
  **cache_write dollar component → `compaction`**; the remainder (input, output,
  cache_read) classifies normally — the turn's real work stays visible.
- **Overhead / recache (meter-split, new category)** — detection is the exact
  meter conjunction from the research (all conditions, per deduped non-sidechain
  message): `cacheWrite > 30k` ∧ `ephemeral_1h == cacheWrite` ∧ `input ≤ 16` ∧
  `cacheRead < 0.2×(cacheRead+cacheWrite)` ∧ `|ctx − prevCtx| < 0.15×prevCtx` ∧
  `iterations ≤ 1` ∧ not compaction-flagged. The **cache_write dollar component →
  `overhead`**; remainder classifies normally. Measured impact: 13.7–39.1% of
  Claude session cost, previously billed to work categories. Triggers: 1h TTL
  expiry (primary), early-context mutation e.g. memory writes (secondary, #98).
- **Interrupted (whole-message)** — a `user` entry whose content contains the
  prefix `[Request interrupted by user` (matches both marker spellings) stamps
  the **preceding** assistant interaction `interrupted`; its whole cost is
  discarded work. Precedence: `interrupted` wins the remainder classification;
  a compaction/recache meter-split still extracts its cache_write component
  first (`compaction`/`overhead` beat `interrupted` for that component).

### Mechanism (wire format)

The daemon (sole classifier) tracks `prevCtx` (input+cacheRead+cacheWrite of the
previous non-sidechain deduped message) across beats. When a meter-split applies
it emits **two** classified lines: the main line (cost = remainder, `cat` =
normal classification, cache-write tokens zeroed) and an overhead line
(`{t, c: cacheWrite$, cat: "compaction"|"overhead", id: <messageId>+"#oh",
cw: <tokens>}`). Message-id dedup treats the `#oh` suffix as distinct; renderers
need no changes — two interactions in the same bucket stack naturally. New
Interaction fields: `interrupted` (wire `ir:1`), `afterCompaction` (wire
implied by split), `cacheWrite1hTokens`/`iterations` (parser-internal, for
detection). The cache_write dollar component comes from a new `wtft-cost`
helper exposing the per-meter decomposition already computed internally
(TTL-split #55 rates). Tagger bump **2.5.0 → 2.5.1**.

### Rendering

`Category` union gains `"overhead"`. `CATEGORY_ORDER`: ... `prompt`,
`compaction`, `interrupted`, `overhead`, `other`. `CATEGORY_STYLE` labels flip
from `null` to `Cmpct`, `Intr`; `overhead` gets `Ovrhd` (Duppy: "we will
definitely add an 'overhead' category").

### Verification (defines Code Approved)

New cases (Phase-3 suite):
1. Claude fixture: `isCompactSummary` user entry, then an assistant code-write
   message with large cache_write → tag file has TWO lines: `compaction` line
   carrying the cache_write $ and a `code` line carrying the remainder; the two
   sum to the original message cost.
2. Recache fixture: message matching the 5-condition signature after a normal
   message → `overhead` line + remainder line; a message failing any single
   condition (e.g. `input=20`) does NOT split.
3. Claude fixture: assistant message followed by `[Request interrupted by user
   for tool use]` user entry → whole message classifies `interrupted` (both
   marker spellings).
4. Pi fixture: `type:"compaction"` entry → next interaction meter-splits and
   still carries `compactionTokensBefore` (#90 unaffected).
5. Non-adjacent noise: interrupt literal inside a tool RESULT or assistant text
   does NOT reclassify (only `user`-entry content counts).
6. Legend renders `Cmpct`/`Intr`/`Ovrhd`; stacking slots match `CATEGORY_ORDER`;
   conservation: session total unchanged vs pre-split build.
7. Live check on this session: recache events ≈ the 2 found by
   `debug/recache-trigger-analysis.mjs`; 1 compaction split; 1 interrupted turn.

## Roads not taken

- **CoT/Sys2 category** — measured zero thinking-only turns (see table). Revisit only as part
  of Direction B, as a dimension overlay, with legend label "CoT".
- **Per-tool cost split within one message** — blocked by the per-message billing floor.
