# Z.ai and OpenRouter pricing, read 2026-10-08 08:48Z

Z.ai list card, https://docs.z.ai/guides/overview/pricing.md, fetched directly with curl 2026-10-08.
A search-index copy of the same URL still showed the ended Flash promo and no FlashX row; the direct fetch is the record.

| Model | Input | Cached Input | Cached Input Storage | Output |
|---|---|---|---|---|
| GLM-5.3-Flash | $0.15 | $0.03 | Limited-time Free | $0.50 |
| GLM-5.3-FlashX | $0.37 | $0.075 | Limited-time Free | $1.25 |
| GLM-5.3 | $1.4 | $0.26 | Limited-time Free | $4.4 |

The page publishes no cache-creation rate and no GLM-5.3-Prime row.

OpenRouter model pages, fetched 2026-10-08:

- https://openrouter.ai/z-ai/glm-5.3, Z.ai row: $1.40 input, $4.40 output, $0.26 cache read.
- https://openrouter.ai/z-ai/glm-5.3-flash, Z.ai row: $0.15 input, $0.50 output, $0.03 cache read.
- https://openrouter.ai/z-ai/glm-5.3-prime, "This model is hosted by one provider", Alibaba Cloud Int.: $2.80 input, $8.80 output, $0.56 cache read. Released Sep 23, 2026. Described as the high-speed variant of GLM-5.3.
- https://openrouter.ai/api/v1/models lists `z-ai/glm-5.3-prime` at prompt 0.0000028, completion 0.0000088, input_cache_read 0.00000056 per token.

`cache_creation_input_tokens` in this host's Claude Code transcripts (`~/.claude/projects/-home-*`, assistant messages whose `message.model` starts `z-ai/glm`): 0 on all 363 turns read, 247 `z-ai/glm-5.3` and 116 `z-ai/glm-5.3-flash`. No Prime or FlashX turn was present.
