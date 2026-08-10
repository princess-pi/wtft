# Spec 148 — Sonnet 5 intro pricing, and a generalized dated-rate seam

**Issue:** #148
**Branch:** `148-sonnet-5-intro-pricing`
**State:** Code and Spec Approved (tested; reconciled to shipped code)

---

## 1. What was actually measured

Verified against the code on this branch (`main` @ `ad91cdc`), not trusted from the issue text.

`MODEL_PRICING["claude-sonnet-5"]`, `extensions/lib/wtft-cost.ts:109`:

```ts
"claude-sonnet-5":   { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
```

These are the **post-intro** (standard) rates. Anthropic's introductory rate for Sonnet 5 is
$2.00 input / $10.00 output per MTok through **2026-08-31**; $3/$15 applies from **2026-09-01**.
The issue's derived cache figures check out against the codebase's own rules:

- `cacheRead = 0.1 × input` — matches the ratio already used for every other entry in
  `MODEL_PRICING` (e.g. `claude-opus-5`: `0.50 / 5.00 = 0.1`).
- `cacheWrite` (5m) `= 1.25 × input` — same pattern (`claude-opus-5`: `6.25 / 5.00 = 1.25`).
- 1h write `= 2.00 × input` — this is not a registry field; it is *derived* at cost-calc time by
  `calculateClaudeCost` (`wtft-cost.ts:293`): `const cw1hPrice = cacheWritePrice === 0 ? 0 :
  inputPrice * 2.00;`. `inputPrice` there is `rates.input` from `resolveTieredRates` — i.e.
  whatever the *effective* input rate is, the 1h derivation already scales with it. This is the
  load-bearing fact for the design below: fixing `rates.input` to be date-aware makes the 1h
  derivation date-aware **for free**, with no separate dated field needed. #146 confirmed this
  formula (2.00×input, not 2.5×input) against Claude Code's own arithmetic (#149's first
  comment); this spec does not touch that formula, only the input it's fed.

Every Sonnet 5 line ever costed used the standard rate — confirmed by grep, `wtft-cost.ts` has
no other Sonnet-5-specific branch and no existing date logic besides DeepSeek's.

**Timestamp is already threaded to the pricing function everywhere it's called** — this is not
new plumbing:

- `wtft-parser.ts:211` (`buildInteractionFromTurn`) parses `turn.timestamp` (string or number,
  defaulting to `0` when absent — `:189-194`) and passes it as `calculateClaudeCost`'s third arg.
- `wtft-parser.ts:426-429` (the overhead-cost split) passes `interaction.timestamp` the same way,
  for both the `full` and `withoutCw` calls.
- `calculateClaudeCost(model, usage, timestamp?)` signature already exists (`wtft-cost.ts:227`)
  and already forwards `timestamp` into `getDeepSeekPeakMultiplier(timestamp)` for DeepSeek surge
  pricing (`wtft-cost.ts:66`, `:245`, `:256`).

So the only structurally new thing this issue needs is: **a Sonnet-5-shaped `ModelPricing` entry
that resolves different base rates depending on where `timestamp` falls**, generalized so any
registry model can carry one.

`WTFT_TAGGER_VERSION` is defined at `extensions/lib/wtft-daemon-lib.ts:194`, currently `"2.7.0"`
(bumped for #152's `miss` field). Every prior cost-formula change bumped it (`2.6.0 → 2.6.1` for
#146) so stale tags re-price; this fix needs the same treatment.

---

## 2. Direction chosen: a dated-rate window on `ModelPricing` (issue's option 1)

Add a new optional field, sibling to the existing `tiers?: CostTier[]` (size-based tiering):

```ts
/** A dated rate window: applies when the interaction timestamp is strictly
 *  before `effectiveBefore` (epoch ms). Falls back to the model's base rates
 *  when no timestamp is supplied or no window matches — resolution never
 *  reads the host clock (see #96 test hazard, §4). */
export interface DateTier {
	effectiveBefore: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: CostTier[];
	dateTiers?: DateTier[];
}
```

`resolveTieredRates(pricing, usage, timestamp?)` gains a third parameter. It resolves the
*base* rates first (before applying size-tier thresholds) by checking `pricing.dateTiers` against
`timestamp`: the earliest window whose `effectiveBefore` is still greater than `timestamp` wins;
no match (or no `timestamp`) leaves the model's plain `input/output/cacheRead/cacheWrite` fields
as the base. Size-tiering then proceeds exactly as before, on top of whichever base was chosen.
The gate is `if (pricing.dateTiers && timestamp)` — a **falsy check**, so `timestamp === 0` takes
the same base/standard fallback path as `timestamp === undefined`. This is deliberate, not an
edge case slipping through: `wtft-parser.ts:189-194` already defaults an unparsed/absent
`turn.timestamp` to `0`, so `0` is that upstream code's spelling of "timestamp unknown," and must
resolve identically to "no timestamp supplied" here. Confirmed by implementation
(`wtft-cost.ts:202`) and a dedicated test (`wtft-pricing-tiers.test.ts`, "uses base rates when
timestamp is 0").

`claude-sonnet-5`'s entry becomes:

```ts
"claude-sonnet-5": {
	input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75,
	dateTiers: [
		// Intro rate through 2026-08-31; standard $3/$15 from 2026-09-01.
		{ effectiveBefore: 1788220800000 /* 2026-09-01T00:00:00Z */,
		  input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
	],
},
```

The base fields stay the **post-intro** (permanent, long-run) rate — the dated window is the
exception, not the rule, matching how the field will read once 2026-09-01 passes and the window
is just historical.

`calculateClaudeCost` needs one change: pass `timestamp` as the third arg to
`resolveTieredRates` (currently called with two args, `wtft-cost.ts:243`). Because
`inputPrice = rates.input` already feeds the existing 1h-write derivation
(`inputPrice * 2.00`, `:293`), 1h writes come out dated automatically — $4.00/MTok intro,
$6.00/MTok standard — with no new code at that line.

### What this commits the codebase to

- Pricing moves from a pure `model → rate` map to a `(model, timestamp) → rate` function for any
  entry that opts in via `dateTiers`. Every caller of `resolveTieredRates` or
  `calculateClaudeCost` that wants correct pricing for a dated model must supply a real
  timestamp; omitting it silently and safely falls back to the base (non-dated) rate rather than
  reading the clock, but that fallback is a **coverage gap** for any interaction whose timestamp
  genuinely couldn't be parsed — noted in §6.
- Historical re-parses stay correct forever: re-tagging an old session re-evaluates
  `timestamp < effectiveBefore` against that session's own recorded time, not "now". This is the
  property option 2 (flat rate + manual flip) explicitly does not have.
- `MODEL_PRICING` entries are no longer guaranteed flat for their base four fields — any code
  that reads `MODEL_PRICING[key].input` directly (bypassing `resolveTieredRates`) gets the
  *base/standard* rate, not the effective one for a given interaction. Grepped: nothing in this
  codebase does that today (`resolveTieredRates` / `calculateClaudeCost` are the only readers
  used for actual billing), but it's a sharp edge for future code — worth a docstring, not a
  guard, since `ModelPricing.tiers` already has the identical property for size-tiering and no
  guard exists for that either.

### Roads not taken

- **Issue's option 2 — flat intro rate now + a dated follow-up issue to flip it 2026-09-01.**
  Simpler (no new field), but silently wrong for any session re-parsed after the flip unless a
  human remembers to file and execute that follow-up. Rejected: this repo's own history (#146)
  shows a wrong baked-in rate propagates for a full release cycle before anyone notices via a
  bill audit, not a reminder.
- **Issue's option 3 — leave the flat standard rate, accept the overbill until 2026-08-31.**
  Zero implementation cost, but knowingly wrong today, which is what #148 was filed to fix.
- **A `sonnet5IntroRate` special case inside `calculateClaudeCost`** (an `if (m ===
  "claude-sonnet-5" && timestamp < CUTOFF)` branch) instead of a registry field. Faster to write,
  but doesn't generalize — the issue explicitly asks for a seam any model can use, and Anthropic
  ships introductory pricing on new model launches as a pattern (this is not Sonnet 5's first
  rodeo), so the next one hits the same problem again. The registry-field direction reuses the
  exact shape (`tiers?`) the codebase already chose for GPT-5.x size-based tiering.
- **Defaulting an absent `timestamp` to `Date.now()`**, mirroring
  `getDeepSeekPeakMultiplier`'s `timestamp || Date.now()` (`wtft-cost.ts:67`). Rejected on
  purpose: DeepSeek's surge multiplier is *supposed* to reflect "right now" when nothing else is
  known (it's a live-pricing feature, not a historical fact). Sonnet 5's intro window is a
  historical fact about when an interaction happened — defaulting to wall-clock would make
  `resolveTieredRates` and `calculateClaudeCost` non-deterministic for missing-timestamp inputs,
  which is exactly the #96 hazard the issue calls out, just moved from tests into production. The
  chosen fallback (base/standard rate) is deterministic and, as a side effect, is the
  conservative (non-under-billing) choice once 2026-09-01 is behind us either way.
- **A single `introUntil` + intro-rate quad on `ModelPricing`** instead of a `dateTiers` array.
  Simpler for exactly one window, but named fields don't generalize past a single before/after
  split, and the issue explicitly asks the seam to generalize ("any model can get dated
  windows") — a future model with, say, three pricing eras would need another one-off field. An
  array of `{ effectiveBefore, ...rates }` handles N windows with the same resolution loop.

---

## 3. Test hazard (#96) — how this spec avoids it

#96: a DeepSeek surge test asserted a non-peak price by comparing against whatever
`getDeepSeekPeakMultiplier(undefined)` resolved to at whatever moment the suite happened to run,
which flips value near UTC peak-window boundaries. The fix pattern already in this repo
(`wtft-pricing-tiers.test.ts`, "DeepSeek v4-pro at off-peak/peak UTC") is to construct a fixed
`Date(...).getTime()` and pass it explicitly as the timestamp argument — never rely on the
function's internal fallback. (Line numbers on that pre-existing block moved when this branch's
own `dateTiers` describe-block was inserted above it — naming the test by title instead of a
line number here so this reference doesn't rot the same way.)

Every new test in this branch does the same: `PRE_CUTOFF`, `POST_CUTOFF`, and
`EXACT_CUTOFF` are all `new Date("...Z").getTime()` constants, passed explicitly as
`calculateClaudeCost`'s third argument. None of them call `Date.now()`, and — per the "roads not
taken" decision above — `resolveTieredRates` itself never calls it either, so there is no
internal fallback left that *could* leak wall-clock state into a result.

---

## 4. `WTFT_TAGGER_VERSION` bump

`extensions/lib/wtft-daemon-lib.ts:194`, currently `"2.7.0"`. This change alters baked-in cost
for every Sonnet 5 line tagged before 2026-08-31 (and changes the 1h-write figure too) — the same
class of change that bumped `2.6.0 → 2.6.1` for #146. Bumping to **`2.7.1`** (patch — a cost-only
correction, not a new field on the tag schema, matching the `2.6.0 → 2.6.1` precedent rather than
`2.6.1 → 2.7.0`'s minor bump for a genuinely new `miss` field) forces existing v2.7.0 tags to
re-price on next read.

---

## 5. Proposed change

1. **`extensions/lib/wtft-cost.ts`**
   - Add `DateTier` interface; add `dateTiers?: DateTier[]` to `ModelPricing`.
   - `resolveTieredRates(pricing, usage, timestamp?)`: resolve the base rates from
     `pricing.dateTiers` (if present and `timestamp` truthy) before applying size `tiers`.
   - `claude-sonnet-5` entry in `MODEL_PRICING` gains the `dateTiers` window described in §2.
   - `calculateClaudeCost`: pass `timestamp` as `resolveTieredRates`'s third argument
     (`wtft-cost.ts:243`).
2. **`extensions/lib/wtft-daemon-lib.ts`** — bump `WTFT_TAGGER_VERSION` `"2.7.0" → "2.7.1"` with a
   dated changelog comment, matching the existing comment-per-bump convention (`:183-193`).
3. **Tests** (new, alongside the two suites that already own this surface):
   - `tests/wtft-pricing-tiers.test.ts` — direct `resolveTieredRates` unit coverage of
     `dateTiers`: before-cutoff, at-cutoff (boundary, standard wins), after-cutoff,
     no-timestamp-supplied, `timestamp=0` (both fall back to base, per the falsy-gate note in
     §2), and a `dateTiers`-less `ModelPricing` confirming a supplied `timestamp` is a no-op when
     the model doesn't opt in.
   - `tests/wtft-claude5-pricing.test.ts` — `calculateClaudeCost("claude-sonnet-5", ...)`
     end-to-end: intro quad ($2/$10/$0.20/$2.50), standard quad ($3/$15/$0.30/$3.75), and the 1h
     derivation at both ends ($4.00 intro / $6.00 standard, tying back to #146's formula).
4. **No other test file needs a Sonnet-5 dollar-figure update.** Verified by grep (§6): the four
   other suites named in the issue's acceptance criteria (`wtft-server-tool-cost`,
   `wtft-daemon-cost-cross-validation`, `wtft-cli-e2e-cost-parity`, plus `wtft-pricing-tiers`
   itself for its *existing* cases) reference `claude-sonnet-4-6` / `claude-sonnet-4-20250514` —
   distinct registry/fallback keys untouched by this change — never `claude-sonnet-5`. They are
   expected to keep passing unmodified; this is a claim under test (V10), not an assumption.

---

## 6. Grep evidence for §5.4 (no other suite touches `claude-sonnet-5` dollar figures)

```
$ rg -n 'sonnet-5' tests/*.ts
tests/wtft-claude5-pricing.test.ts:79-108     — dollar assertions + isModelPriced (updated here)
extensions/rate-limiter.ts / rate-limiter-model-registry.test.ts — TPM limit lookup, not $ pricing
tests/wtft-issue-52-tool-categories.test.ts:40,54  — tool→category classification, no cost assert
tests/wtft-daemon-lifecycle.test.ts:71,97      — fixture cost is hardcoded `c: 0.01`, never calls
                                                   calculateClaudeCost
tests/wtft-compaction-tracking.test.ts        — usage.cost.total is fixture-supplied, never calls
                                                   calculateClaudeCost
```

`wtft-claude5-pricing.test.ts:79-82`'s existing assertion (`calculateClaudeCost("claude-sonnet-5",
{ input_tokens: MTOK })` with **no timestamp arg**, expecting `3.00`) is the one case that
depends on the "no timestamp → base/standard rate" fallback decision in §2. It is left unchanged
by this branch and continues to pass under the new resolution order specifically *because* that
fallback was chosen over `Date.now()` — had `Date.now()` been chosen, this exact line would have
gone flaky the same way #96 did, since "now" is currently before the cutoff. This is called out
explicitly as the reason that road was not taken, not left as an accidental side effect.

---

## 7. Spec gate — verification criteria

| # | Check | Expected |
|---|---|---|
| V1 | `calculateClaudeCost("claude-sonnet-5", {input_tokens: 1e6}, PRE_CUTOFF)` | `2.00` |
| V2 | same call, `output_tokens: 1e6` | `10.00` |
| V3 | same call, `cache_read_input_tokens: 1e6` | `0.20` |
| V4 | same call, `cache_creation_input_tokens: 1e6` (flat, no TTL split) | `2.50` |
| V5 | same call, `cache_creation_input_tokens: 1e6` with `cache_creation.ephemeral_1h_input_tokens: 1e6` | `4.00` (2.00 × intro input, ties to #146) |
| V6 | `calculateClaudeCost("claude-sonnet-5", {input_tokens: 1e6}, EXACT_CUTOFF)` where `EXACT_CUTOFF = new Date("2026-09-01T00:00:00Z").getTime()` | `3.00` — boundary is standard, not intro |
| V7 | same as V1-V5 but with `POST_CUTOFF = new Date("2026-09-15T00:00:00Z").getTime()` | `3.00 / 15.00 / 0.30 / 3.75`, 1h write `6.00` |
| V8 | `calculateClaudeCost("claude-sonnet-5", {input_tokens: 1e6})` — no timestamp arg | `3.00` (base/standard fallback, not `Date.now()`-dependent) |
| V9 | `resolveTieredRates` direct unit tests for `dateTiers` (before/at/after/absent/`timestamp=0`, plus a `dateTiers`-less model ignoring `timestamp` entirely) | rates match §2 exactly at each point; `timestamp=0` resolves identically to absent (falsy gate, §2) |
| V10 | `bun run test wtft-claude5-pricing`, `wtft-pricing-tiers`, `wtft-server-tool-cost`, `wtft-daemon-cost-cross-validation`, `wtft-cli-e2e-cost-parity` | all green, no Sonnet-5 dollar figure elsewhere needed updating |
| V11 | `WTFT_TAGGER_VERSION` | `"2.7.1"`, with a dated changelog comment above it |
| V12 | `bun run build` after the `.ts` edits | succeeds, `bin/*.mjs` regenerated and committed |

Every V above is mechanically checkable by running the named test file(s) or reading the named
constant — no criterion depends on a subjective read.

---

## 8. Step 5 reconciliation record

File-level blast radius (`git diff ad91cdc..HEAD --name-only`): `extensions/lib/wtft-cost.ts`,
`extensions/lib/wtft-daemon-lib.ts`, `tests/wtft-claude5-pricing.test.ts`,
`tests/wtft-pricing-tiers.test.ts`, `bin/wtft.mjs`, `bin/wtft-daemon.mjs` (generated, verified
byte-consistent with a clean `bun run build`), plus this spec. Every docstring/comment in each
`.ts` file was swept in file order against the shipped code; `README.md`, `docs/manifests/*.json`,
and `docs/EXT_*.html` were grepped for any Sonnet-5/`dateTiers`/pricing-figure claim.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `docs/spec-139-140-141-pricing-and-workflow-rollup.md:45` (pre-#148) | "Sonnet 5 intro pricing … is a road not taken — wtft prices at list rates … (no date-dependent pricing)" | `wtft-cost.ts:134-140` — `claude-sonnet-5` now carries a `dateTiers` window; #148 took exactly that road | ✅ V1-V9 | Fixed this commit — struck through, pointer to new Errata §148 added |
| `docs/spec-139-140-141-pricing-and-workflow-rollup.md:34` table | `claude-sonnet-5` row lists flat `3.00/15.00/0.30/3.75` with no caveat | Same rates are the base only; effective rate is date-dependent below the 2026-09-01 cutoff | ✅ V1-V9 | Fixed this commit — added a caveat line pointing to spec-148 |
| `docs/spec-148-sonnet-5-intro-pricing.md:96` (§3, pre-fix) | "fix pattern already in this repo (`wtft-pricing-tiers.test.ts:191`, `:203`)" | Those lines are `wtft-pricing-tiers.test.ts:247`/`:259` as of this branch's own `dateTiers` describe-block insertion (52 lines) above them | N/A (a citation, not a behavior claim) | Fixed this commit — cited by test title instead of line number so it can't rot the same way again |
| `extensions/lib/wtft-daemon-lib.ts:178-182` (pre-fix) | Orphaned JSDoc "Compute the tag file path for a given session path. Scans wtft-tags/ subdirectory…" (plus a stray duplicate `/**` and a misplaced `// DAEMON HEALTH CHECK` banner) sat directly above `WTFT_TAGGER_VERSION` — TS/reader attaches it to that constant, not to any tag-path function | `getTagPath` (`:306`) already carries its own correct, fuller docstring; `checkDaemonHealth` (`:564`) is the real daemon-health-check function. Pre-existing at baseline `ad91cdc` (predates #148), found because this file is in #148's blast radius | N/A (comment-only, no assertion) | Fixed this commit — deleted the orphaned banner/docstring/stray-`/**`, no logic touched; `bun run build` confirms zero `.mjs` diff, `bun run typecheck`/`bun run test` re-verified green |
| `tests/wtft-pricing-tiers.test.ts:1-9` header (pre-fix) | Describes only #88 (size-based `tiers`) | File now also carries a full `dateTiers`/#148 `describe` block (7 tests) | ✅ (the tests themselves) | Fixed this commit — header now names both #88 and #148 |
| `tests/wtft-claude5-pricing.test.ts:1-10` header (pre-fix) | Describes only #139/#140 | File now also carries a "Sonnet 5 intro pricing (#148)" `describe` block (5 tests) | ✅ (the tests themselves) | Fixed this commit — header now names #148 too |
| `extensions/lib/wtft-cost.ts` — `DateTier`/`ModelPricing`/`resolveTieredRates` docstrings | Describe the dated-window resolution order, the falsy `timestamp` gate, and the `claude-sonnet-5` entry's dual rates | Read against `resolveTieredRates` (`:185-238`) and the registry entry (`:134-140`) — no discrepancy found | ✅ V1-V9 | No action — verified accurate |
| `extensions/lib/wtft-daemon-lib.ts` `WTFT_TAGGER_VERSION` changelog comment | `2.7.1` bump, dated, cites the 50% overbill figure | `"2.7.1"` (`:197`) confirmed; `(3.00-2.00)/2.00 = 50%` checks out arithmetically | ✅ V11 | No action — verified accurate |
| `docs/EXT_WTFT.html` "Model Pricing" table | Lists only Opus 4 / Sonnet 4 / Haiku 4.5 / DeepSeek — no Fable 5, Mythos 5, Opus 5, Sonnet 5 (or its `dateTiers`), or any GPT-5.x row | `MODEL_PRICING` (`wtft-cost.ts:113-169`) has carried the full Claude 5 + GPT-5.x lineup since #139/#141, well before this branch | N/A (doc-only) | **Not fixed here** — predates #148, this branch never touched the file, and a correct fix needs a design call (generate the table from the registry, per the doc's existing manifest-fetch pattern) rather than a mechanical edit. Filed as [#169](https://github.com/duppypro/princess-pi-packages/issues/169) |
| `docs/manifests/wtft-cmd.json` (`--by-model`/`--cost` flag descriptions) | No model names or dollar figures asserted | N/A — manifest describes flags, not rates | N/A | No action — not a contradiction, out of scope for this table |
| `README.md` | No Sonnet-5/pricing-figure claims | N/A | N/A | No action |

**Re-audit pass (post-fix):** re-ran the same sweep after applying the fixes above — no new
contradictions surfaced. `bun run typecheck` (2 pre-existing unrelated TS7016 on
`bin/serve.ts`→`serve/cloudflare.js`, present on `main` before this branch), `bun run build`
(clean, zero `.mjs` diff from the comment-only `.ts` edit), and `bun run test` (43/43 suites
green) all re-verified after the reconciliation edits, not just before them.

— 👑π🐱 Princess Pi
