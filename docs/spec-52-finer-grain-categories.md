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

## Roads not taken

- **CoT/Sys2 category** — measured zero thinking-only turns (see table). Revisit only as part
  of Direction B, as a dimension overlay, with legend label "CoT".
- **Per-tool cost split within one message** — blocked by the per-message billing floor.
