# spec-22 / spec-25 — pricing correctness: alias ids, unpriced DeepSeek, and four vacuous assertions

Two issues, one branch, because both land in `extensions/lib/wtft-cost.ts`.

- **#22** — a bare `opus`/`sonnet`/`haiku` id is billed Claude's per-request web-search
  rate; an unpriced DeepSeek id reports as priced; four assertions cannot fail.
- **#25** — DeepSeek pricing is unverified on the Pi harness, and `deepseek-reasoner`
  is in no registry entry while `isModelPriced` calls it priced.

Everything below is stated as a closing test, because a spec is not clear until it
names one.

---

## Measured before any change

Run on this host, 2026-09-04, against `~/.pi/agent/sessions` (read-only).

| Fact | Value |
|---|---|
| Pi session files (recursive) | 390 |
| Pi assistant turns whose model is a DeepSeek id | 14,276 |
| …that fall through to `calculateClaudeCost` (Pi `cost.total` is 0 while tokens > 0) | **11,923 (83.5%)** |
| …that use Pi's native cost | 2,353 (16.5%) |
| `deepseek-reasoner` turns | 527 |
| `deepseek-v4-flash-thinking` turns | 2 |

`calculateServerToolCost("opus", 10, 0)` returned `0.3`; `lookupModelPricing("deepseek-reasoner")`
returned `null` while `isModelPriced("deepseek-reasoner")` returned `true`.

The 83.5% answers #25's open question directly: wtft **is** the thing pricing Pi's
DeepSeek sessions, not a fallback that rarely runs. The regenerator is
`research/25-pi-deepseek-pricing/pi-fallthrough-count.mjs`.

---

## A — a bare alias id is not evidence of an Anthropic model

`calculateServerToolCost` billed `$0.03/request` for any id matching
`/\b(haiku|sonnet|opus)\b/`. That arm was added to catch a Claude id written
without the `claude-` prefix. It also matches the alias names a `claude-deepseek`
session serves, which set `ANTHROPIC_MODEL="opus"` against DeepSeek — a provider
the function's own docstring says does not bill server tools.

**Decision.** Bill per-request only when the id carries a vendor marker:
`claude` or `anthropic`. A bare alias bills `0`.

This is the least-wrong option by the registry's own annotations: every registry
Claude key is `claude-*`, every real Anthropic id (Bedrock `us.anthropic.claude-…`,
Vertex `claude-…`, the API's dated ids) carries one of the two markers, and no
DeepSeek-served alias carries either. The road not taken is keeping the alias arm
and excluding ids a DeepSeek session produces — set aside because the two are
byte-identical at this seam: a bare `opus` from Claude Code and a bare `opus` from
`claude-deepseek` are the same string, so no rule can separate them.

The exposure of the choice: a genuine Anthropic turn recorded with a bare alias id
**and** a `server_tool_use` block undercounts by $0.03/request. No such turn exists
in this host's corpus — Claude Code stamps the full dated id on every message.

**Closing test** (`tests/wtft-server-tool-cost.test.ts`):
`calculateServerToolCost` returns `0` for `opus`, `sonnet`, `haiku`, and
`0.03 × requests` for `claude-opus-5`, `us.anthropic.claude-sonnet-5-…`.

## B — an unmatched DeepSeek id is unpriced, and says so

`isModelPriced` returned `true` for any id containing `deepseek`, so the
unpriced-model warning never fired for a DeepSeek model newer than the registry —
the exact case the warning exists for. `calculateClaudeCost` still prices such an
id by borrowing a sibling registry entry, which the code's own comment calls a
*Guess*; the defect is that the guess was silent.

**Change.** `isModelPriced` drops the `deepseek` substring arm: it is true only
when a registry key matches, or when a legacy hardcoded branch in
`calculateClaudeCost` really exists (`haiku`, `opus`). The sibling-guess branch
stays — it is a better guess than the $3/$15 Sonnet default — but the turn is now
marked with the renderer's `?` and the stderr warning.

The warning's wording changes with it: it said "using default $3/$15 rates", which
is untrue for a DeepSeek id taking the sibling-guess path. It now names the actual
fallback per model.

**Closing tests:** `isModelPriced("deepseek-reasoner") === false`,
`isModelPriced("deepseek-chat") === false`, `isModelPriced("deepseek-v4-pro") === true`
(`tests/wtft-claude5-pricing.test.ts`). This is also #25's Closer for
`deepseek-reasoner`, which gets no invented rate card: no sourced card exists for
it in this repo, and a fabricated quad is worse than an honest `?`.

## C — four assertions that could not fail

- **C1** `wtft-pricing-manifest.test.ts` "lists exactly the registry's models" compared
  `buildPricingManifest().models`, built as `Object.keys(MODEL_PRICING).sort().map(…)`,
  against `Object.keys(MODEL_PRICING).sort()`. Tautological. **Now** compares the
  **committed** `docs/manifests/wtft-pricing.json` against the registry, which fails on
  a registry edit that skipped `bun run build`.
- **C2/C3** `wtft-pricing-tiers.test.ts` — the `#96` no-host-clock guards asserted
  `3.00` against a fixture whose window ended 2026-09-01. From that date the clock
  gives `3.00` too, so both passed whether or not the resolver read `Date.now()`.
  **Now** the fixture's `effectiveBefore` is 2099-01-01: an implementation that read
  the clock would resolve inside the window and return `2.00`.
- **C4** "GPT-5.6-sol cache writes are zero when no cache data" passed a usage object
  with no cache fields, so it asserted a property of every model at every rate and
  nothing about `gpt-5.6-sol`. Deleted as a duplicate of the base-rate test three
  cases above it, and replaced by two that bite: a flat cache-creation billing at
  `gpt-5.6-sol`'s `cacheWrite` of `$6.25/MTok`, and a 1h-TTL write billing at
  `2 × input`.

## D — the Pi corpus check (#25)

`research/25-pi-deepseek-pricing/corpus-check.mjs` walks every Pi session on the
host, selects the turns that actually reach `calculateClaudeCost`, and compares
wtft's number against a rate card transcribed independently in that file — not
imported from `wtft-cost.ts`, or the check would agree with itself by construction.

It prints a scope line naming what it did **not** examine, a mismatch percentage,
and `--json`. Turns whose model resolves to no card (`deepseek-reasoner`) are
counted as `unpriced`, never silently compared.

**Closer:** `corpus-check.mjs` reports `0.0000%` mismatch over the priced Pi turns
and a non-zero `unpriced` count that matches the `deepseek-reasoner` turn count.

---

## Result of D, measured

`node research/25-pi-deepseek-pricing/corpus-check.mjs`, 2026-09-04:

```
  files                    395
  deepseek turns           14281
  priced by Pi natively    2358   (not checked here)
  compared against card    11397
  unpriced (no card)       526   deepseek-reasoner
  mismatches               0  (0.0000%)
```

The `unpriced` count is the point, not a leftover: those 526 turns are
`deepseek-reasoner` reaching `calculateClaudeCost` with no card, and since #22 B
each one now carries the `?` marker and the stderr warning instead of passing as
priced. The counts drift upward between runs because the corpus is live.

**The check can fail.** Changing `deepseek-v4-pro`'s current-card `input` from
`0.66` to `0.67` produces `328 mismatches (2.8780%)` with per-turn expected/actual
lines. Only 2.88%, not 100%, because most v4-pro turns on this host predate
2026-08-16T16:00Z and price from the `before` window the mutation did not touch —
which is itself worth knowing before quoting a mismatch percentage as coverage.

---

## Reconciliation record

Run after GREEN, before `pr-open`. Scope: every source file the branch touched
(`extensions/lib/wtft-cost.ts`, `bin/wtft.ts`), plus the term blast radius of the
lines the diff removed, plus Tier 4's host-scoped set.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `wtft-renderer.ts` (`renderTokenSummary` legend) | `? = model not in pricing registry — priced at default $3/$15 rates` | a `?`-marked DeepSeek id takes the sibling-guess branch, not the Sonnet default (`wtft-cost.ts`, `calculateClaudeCost`) | ❌ `reconciled-against-untested` — no suite renders an unpriced row | Fixed: the legend now composes `describeFallbackPricing` over the marked models |
| `docs/manifests/wtft-cmd.json` (`--by-model`) | `marked '?' (priced at default rates)` | two different defaults exist, and this names neither | ❌ `reconciled-against-untested` | Fixed; Tier 1, so `--help` and `docs/EXT_WTFT.html` correct together |
| `spec-139-140-141-…md` §#140 | `isModelPriced` true when a legacy branch `(deepseek/haiku/opus)` applies | `deepseek` names a guess, not a branch — `isModelPriced` (`wtft-cost.ts`) | ✅ `wtft-claude5-pricing.test.ts` | Fixed, with a pointer to this spec |
| `spec-139-140-141-…md` §#140 | the warning reads `using default $3/$15 rates` | `bin/wtft.ts` now interpolates `describeFallbackPricing` | ✅ `wtft-claude5-pricing.test.ts` | Fixed |
| `spec-139-140-141-…md` verification list | `isModelPriced("deepseek-chat")` true | now false | ✅ same suite | Fixed |
| `wtft-tagger-version.ts` | `2.7.1` | `sc` (server-tool cost) is baked into every tag and its value changed for alias-only model ids | ✅ `tagger-version-single-source.test.ts` pins the single source, not the value | Bumped to `2.7.2` with the measurement (zero affected turns on this host) |
| `bin/wtft.ts` banner | `UNKNOWN-MODEL WARNING` | a model can be well known and carry no card | n/a — comment | Renamed to `UNPRICED-MODEL WARNING`, the glossary term |
| `CONTEXT.md` | no entry for the priced/unpriced distinction | the distinction is what `isModelPriced`, the `?` marker and the stderr line all turn on | n/a — glossary | Added *Priced model / unpriced model*, with `_Avoid_: "unknown model", "default rates" as an umbrella` |

**Tier 4 (host-scoped documents), checked and declared.** All 22 paths printed by
`ls ~/.claude/CLAUDE.md ~/git-projects/CLAUDE.md ~/.claude/settings.json
~/git-projects/*/CLAUDE.md ~/git-projects/*/AGENTS.md` exist and were searched for
`wtft`: **zero mentions**, so no host-scoped document asserts anything this branch
changed. This repo has no `CLAUDE.md` or `AGENTS.md` of its own — `CONTEXT.md` carries
the glossary and is audited above as Tier 2. A clone outside `~/git-projects/` is out of
this scope.

Two rows are `reconciled-against-untested`: the two user-facing strings that describe
the fallback. Both are correct now and neither is asserted by a suite — a lead for the
test process, not a reason to leave them wrong.
