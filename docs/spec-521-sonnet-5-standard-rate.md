# Spec 521 — Claude Sonnet 5 stays at $2/$10

Module: extensions/lib/wtft-cost.ts

**State:** Code and Spec Approved

Issue: https://github.com/princess-pi/wtft/issues/521.

---

## 1. Today

`claude-sonnet-5` prices at $3/$15/$0.30/$3.75 with a `dateTiers` window that applies
$2/$10/$0.20/$2.50 before 2026-09-01T00:00:00Z
([spec-148](spec-148-sonnet-5-intro-pricing.md)). Every turn since 2026-09-01, and every undated
turn, prices 1.5x over.

## 2. Want

The pricing page's footnote 3 (https://platform.claude.com/docs/en/about-claude/pricing, read
2026-10-15): "The $2/$10 per million input/output token pricing for Claude Sonnet 5, announced at
launch as introductory pricing through August 31, 2026, is now the standard price. The previously
scheduled increase to $3/$15 per million input/output tokens on September 1, 2026 will not occur."

One flat card, USD per 1M tokens, no `dateTiers`:

| Registry key | input (cache miss) | cacheRead | cacheWrite (5m) | output |
|---|---:|---:|---:|---:|
| `claude-sonnet-5` | 2.00 | 0.20 | 2.50 | 10.00 |

- **The 1h write** is $4.00 on the pricing page, which `calculateClaudeCost` derives as `2 × input`.
- **`WTFT_TAGGER_VERSION` bumps** a minor version, so tags written at $3/$15 re-price.
- The `dateTiers` field stays: the DeepSeek cards use it.

## 3. Verification

`tests/wtft-claude5-pricing.test.ts`, the Sonnet 5 describe: 1,000,000 each of `input_tokens`,
`output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` cost 2.00, 10.00, 0.20
and 2.50, and a 1h write of 1,000,000 costs 4.00, at 2026-08-15, at 2026-09-01T00:00:00Z, at
2026-10-01, and with no timestamp.

`tests/wtft-pricing-manifest.test.ts` closes the manifest.
