# Spec 98 — Z.ai GLM-5.3 rate cards

Module: extensions/lib/wtft-cost.ts

**State:** Code and Spec Approved

Evidence: `research/98-glm-pricing/pricing-pages-2026-10-08.md`.

---

## 1. Today

`claude-glm` sends `z-ai/glm-5.3[1m]` (omit, opus, sonnet) and `z-ai/glm-5.3-flash` (haiku, fable, subagents) to OpenRouter.
A Claude transcript's `message.model` is the id OpenRouter serves back: `z-ai/glm-5.3` and `z-ai/glm-5.3-flash`.
`MODEL_PRICING` has no GLM key, so `lookupModelPricing` returns null, `isModelPriced` is false, and the turn prices at the $3 / $15 / $0.30 / $3.75 fallback with a `?` cost cell.
That overstates output about 3.4x for the flagship and 30x for Flash.

## 2. Want

Four flat cards, USD per 1M tokens, no `surge`, no `dateTiers`:

| Registry key | input (cache miss) | cacheRead | cacheWrite | output |
|---|---:|---:|---:|---:|
| `z-ai/glm-5.3` | 1.40 | 0.26 | 0 | 4.40 |
| `z-ai/glm-5.3-flash` | 0.15 | 0.03 | 0 | 0.50 |
| `z-ai/glm-5.3-flashx` | 0.37 | 0.075 | 0 | 1.25 |
| `z-ai/glm-5.3-prime` | 2.80 | 0.56 | 0 | 8.80 |

- **Longest key wins.** `z-ai/glm-5.3` is a substring of the other three, and `z-ai/glm-5.3-flash` of `-flashx`. A registry holding only the flagship key would price Flash, FlashX and Prime at the flagship card and report `isModelPriced` true, which hides the `?`. All four keys are required.
- **Prime has its own key.** OpenRouter lists `z-ai/glm-5.3-prime` at $2.80 / $8.80 / $0.56 from one host, Alibaba Cloud Int. Z.ai's page has no Prime row. The OpenRouter model page and its models API are the only published source; the card is registered from them.
- **`cacheWrite: 0`.** The Z.ai page publishes a cached-input rate and no cache-creation rate. All 363 real `claude-glm` turns read, flagship and Flash only, reported `cache_creation_input_tokens: 0`; no FlashX or Prime turn was available. A non-zero value on any of the four would have no published rate to price at, so 0 stays.
- **No surge.** Z.ai publishes no peak window. Reasoning tokens already bill at the output rate in `calculateClaudeCost`.
- **`:batch` ids** (`z-ai/glm-5.3:batch`, `z-ai/glm-5.3-flash:batch`) stay on the substring rule and inherit the non-batch card. OpenRouter's models API lists them at lower rates (recorded in the evidence file), but `claude-glm` never sends one and Z.ai publishes no batch rate, so they get no key until a turn carries one.
- **Z.ai list, not a cheap host.** Matches the DeepSeek rows, which are the first-party card. Prime is the one exception: Z.ai publishes no Prime row, and its only OpenRouter host lists it at the rate registered.
- **`WTFT_TAGGER_VERSION` bumps 2.14.0 to 2.15.0**, so tags written with GLM turns at the fallback re-parse.
- **Out of scope:** the DeepSeek rows and Claude's own `/cost`.

## 3. Verification

`tests/wtft-98-glm-rates.test.ts`, through `calculateClaudeCost`, `lookupModelPricing`, `isModelPriced` and `getPeakMultiplier`:

- 1,000,000 each of `input_tokens`, `cache_read_input_tokens` and `output_tokens` costs 6.06 for `z-ai/glm-5.3`, 0.68 for `-flash`, 1.695 for `-flashx`, 12.16 for `-prime`. `z-ai/glm-5.3[1m]` costs 6.06.
- `lookupModelPricing` returns the Flash, FlashX and Prime cards for their ids, not the flagship card.
- `isModelPriced` is true for all four, and for `z-ai/glm-5.3:batch`.
- `getPeakMultiplier` is 1 for all four ids, at an instant inside the DeepSeek peak window and one outside it.
- `cache_creation_input_tokens` of 1,000,000 costs 0 for each.

`tests/wtft-pricing-manifest.test.ts` closes the manifest: `docs/manifests/wtft-pricing.json` equals `renderPricingManifest()`.

## 4. Reconciliation record

| Artifact | Claim | Checked against | Covered by a test? | Action |
|---|---|---|---|---|
| this spec, section 2 | four flat cards at the listed rates | `MODEL_PRICING` in `extensions/lib/wtft-cost.ts` | yes, `tests/wtft-98-glm-rates.test.ts` | none, matches |
| this spec, section 2 | `:batch` ids inherit the non-batch card | `lookupModelPricing` | yes, same suite | none, matches |
| `docs/manifests/wtft-pricing.json` | one row per registry key | `renderPricingManifest()` | yes, `tests/wtft-pricing-manifest.test.ts` | regenerated |
| `docs/wtft.html` spec index | every spec is linked | `tests/wtft-doc-spec-index.test.ts` | yes | row added |
| `artifacts/renderer/wtft-chart.mjs` | bundles the registry | `bun run artifacts` | yes, stale-bundle test | regenerated |

The retired term is the tagger version `2.14.0`. Two surviving mentions, in `docs/spec-442-daemon-roster.md` and `docs/spec-451-tag-read-cache.md`, are example filenames and a fixture description, and stay as history.
