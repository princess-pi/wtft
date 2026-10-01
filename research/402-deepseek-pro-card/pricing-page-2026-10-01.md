# DeepSeek pricing page, read 2026-10-01

Source: https://api-docs.deepseek.com/quick_start/pricing and https://api-docs.deepseek.com/updates (2026-09-10 entry), fetched 2026-10-01.

Footnote (2), verbatim, on both pages: "In response to user demand, we have decided to continue providing API services for DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged. We will provide further notice should there be any changes. Thank you for your understanding and support!"

On that footnote's words, "continue providing API services for DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged", the 2026-09-10 announcement's routing of `deepseek-v4-pro` to V4.1-Flash from 2026-09-14 (`research/100-deepseek-v41-flash/pricing-page-2026-09-10.md`) is withdrawn.

| Model | Version | Cache hit off-peak / peak | Cache miss off-peak / peak | Output off-peak / peak |
|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash | 0.003 / 0.006 | 0.15 / 0.3 | 0.6 / 1.2 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 0.022 / 0.044 | 0.66 / 1.32 | 1.98 / 3.96 |

Prices per 1M tokens, USD. Peak is 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday. Off-peak is half of peak.
