# DeepSeek V4.1 Flash — rate card and routing, scraped 2026-09-10

Fetched 2026-09-10 for wtft#100. Two pages, both official DeepSeek:

- Announcement — https://api-docs.deepseek.com/news/news260910
- Models & Pricing — https://api-docs.deepseek.com/quick_start/pricing

Kept because the pricing page publishes **only the current card**. The moment V4.1 Pro ships
and the `deepseek-v4-pro` row moves again, the numbers below are unrecoverable from the web —
which is exactly how #495's superseded card had to be transcribed from an issue body instead of
a source. Committed the same way, and for the same reason, as
`princess-pi-tools/research/495-deepseek-pricing/pricing-page-2026-08-25.md`.

---

## The card (USD per 1M tokens)

Verbatim from the pricing page's PRICING rows. `deepseek-v4-pro`'s column is still its OWN card
on the day of the scrape — the reroute below had not happened yet, which is why both columns are
recorded rather than just the Flash one.

| | `deepseek-flash` off-peak | `deepseek-flash` peak | `deepseek-v4-pro` off-peak | `deepseek-v4-pro` peak |
|---|---|---|---|---|
| 1M input, cache **hit** | $0.003 | $0.006 | $0.022 | $0.044 |
| 1M input, cache **miss** | $0.15 | $0.30 | $0.66 | $1.32 |
| 1M output | $0.60 | $1.20 | $1.98 | $3.96 |

Footnote (3), verbatim: "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00
and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."

**The peak schedule did not change.** Same two windows, same weekdays-only rule as #495 recorded.
So `DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES`, `DEEPSEEK_WEEKEND_OFFPEAK_FROM` and
`getDeepSeekPeakMultiplier` are untouched by this change — only the cards moved.

## Routing — three names, one model

Announcement, verbatim: "Set your model to `deepseek-flash`." · "V4-Flash & V4-Flash-Vision-Exp
are retired. For compatibility, `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`
temporarily route to V4.1-Flash." · "Starting at 04:00 UTC on Sept 14, 2026, all
`deepseek-v4-pro` requests will route to V4.1-Flash at V4.1-Flash rates. This will continue
until V4.1-Pro launches."

| Name | Serves V4.1 Flash from | Billed at the Flash card from |
|---|---|---|
| `deepseek-flash` | 2026-09-10T04:00:00Z (it is the model) | always |
| `deepseek-v4-flash` | 2026-09-10T04:00:00Z | 2026-09-10T04:00:00Z |
| `deepseek-v4-flash-vision-exp` | 2026-09-10T04:00:00Z | 2026-09-10T04:00:00Z |
| `deepseek-v4-pro` | 2026-09-14T04:00:00Z | 2026-09-14T04:00:00Z |

Announcement, verbatim: "New pricing takes effect at 04:00 UTC on Sept 10, 2026."

Pricing-page footnote (2) gives the v4-pro date as "12:00 Beijing Time on September 14, 2026",
the announcement as "04:00 UTC on Sept 14". Beijing is UTC+8, so the two agree exactly; recorded
because a reader checking the CN page will meet the other spelling.

## Model facts, for the record

552B-parameter MoE, Causal Encoder–Decoder, 8B active parameters for input and 16B for output.
1M context, 384K max output, native vision (`deepseek-v4-pro` has none). Weights:
https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash
