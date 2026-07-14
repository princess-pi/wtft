# Spec #52 — Finer-grain category mapping (Phases 1–4)

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

### Amendment 3 verification results (Code Approved `647cff5`, 2026-07-14)

- `tests/wtft-phase3-overhead.test.ts`: **39/39 zero-shot** — all seven cases
  above, including 6 negative single-condition recache cases, sidechain
  exclusion, exact cost conservation on the dual-line split, both interrupt
  marker spellings with tool-result/assistant-text noise immunity, and #90
  `compactionTokensBefore` unaffected.
- Full regression 24/25 (pre-existing environmental session-name-display
  failure only). One batch-load timing flake in the legend case fixed by
  polling for the daemon tag file before asserting.
- Live check (case 7) on a copy of session `ea0143ab`: **overhead 2 msgs
  $2.28** = exactly the 2 recache events the trigger analysis found;
  **compaction 1 msg $0.21** (matching the pre-implementation estimate);
  **interrupted 1 msg $0.03**. Tagger shipped at **2.5.1**.
- Implementation note vs spec: the daemon serializes at flush (pendingItems
  hold parsed interactions, not strings) so an interrupt marker arriving
  within the same beat window can still stamp the killed turn; a marker
  arriving after its turn was flushed is dropped — bounded by one 667ms beat,
  as specced under "Mechanism".

## Phase 4 — Decision record (close-out, 2026-07-14)

Phases 1–3 shipped the *activity-axis* refinement: relabel (Ph1), tool recognition
(Ph2), and the overhead meter-split — `compaction`/`overhead`/`interrupted` (Ph3).
Phase 4 records the decisions that bound the umbrella, so #52 can close.

**`--tokens` is the designated honest input/output decomposition view.** The default
`wtft` render answers *"what activity was the money spent on?"* (one category per
billed turn, latest-stage-wins). The question *"how did the tokens split across
input / output / cache-read / cache-write?"* is answered by `--tokens`, which renders a
**per-model token summary table** (Input / Output / Reasoning / cache-read / cache-write
columns) directly from the billing meters with **no modeling** — every number is
measured, not attributed. This is the road out of the false-confidence
concern that motivated the sub-turn-split research: rather than invent a per-tool
proportional split (which the meters can't support — see below), we expose the raw
meter breakdown as its own view and let the reader see where the dollars actually are
(≈85–92% cache economics). `--tokens` is thus the *complement* to the activity view,
not a competitor. (Its row-overflow rendering bug is tracked separately in #99.)

## Roads not taken

- **Per-tool proportional cost split within one message** — *declined, with a re-decision
  rule.* The sub-turn-split research (5 independent subagent proposals + a measurement
  harness over 3 real sessions, all preserved under `docs/research/52-split-strategies/`)
  found the movable money is tiny: **strict multi-category-tool messages hold 0.0–0.5%**
  of session cost, and the **total dollars any sub-turn splitter can move is 1.9–4.0%**,
  most of it merely shuffling between `prompt` and the action category. 92–98% of every
  session is a turn-level context property (cache_read/cache_write) that is invariant
  under *any* sub-turn split. Adopt splitting only if a future re-run of the harness shows
  **strict-mixed cost share > 5%** or **movable dollars > 10%** (e.g. if harnesses start
  batching many heterogeneous tool calls into one API call). Today's numbers are an order
  of magnitude below both thresholds. Full analysis: `docs/research/52-split-strategies/skeptic-report.md`.
- **`--by=rent` (Context-Ledger) view** — *parked, not declined.* The cache-rent economist
  proposal (`proposal-context-ledger.md`) models cache_read as rent on accumulated context,
  attributing the ~53% cache_read dollars to the categories whose content still resides in
  the window — a genuinely different, defensible lens (answers *"what content is the money
  paying for?"* vs the default *"what were we doing when it left?"*). It is shelved rather
  than rejected: it is a *second* view (`--by=rent` alongside the default `--by=activity`),
  its rent split rides on deposit-size estimates (only ~38–55% of cache_write is directly
  explained), and it uniquely reveals the "compact earlier" lever. Revisit if the rent
  question becomes load-bearing.
- **CoT / reasoning-token dimension (Direction B)** — *split out to #101.* Measured zero
  thinking-only turns: reasoning rides inside a turn's `output_tokens`, so a *category*
  is the wrong shape (it would steal whole turns). The right shape is a **dimension overlay**
  (legend "CoT") that re-describes output dollars already counted without moving any between
  activity categories. Filed as its own issue rather than declined, because it is concretely
  useful once shaped as an overlay.
- **2-D matrix view (category × meter, Direction D)** — *declined.* A full activity × meter
  cross-tab is the maximal version of both `--tokens` (meter axis) and `--by=rent` (attribution
  axis). Declined as too heavy for the payoff: `--tokens` already exposes the meter axis
  honestly, and the matrix multiplies render complexity (13 categories × 4 meters) for a view
  no measurement showed a need for. The two axes are more legible shipped as separate views
  than crossed into one grid.
