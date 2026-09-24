# Spec 241 — a re-prime that keeps a small cached prefix is a Cache Miss

**Issue:** [#241](https://github.com/princess-pi/wtft/issues/241) ·
**Test:** `tests/wtft-241-partial-reprime-miss.test.ts`

## Why

spec-152/153 draws the Cache Miss divider from one observation: a parent turn that read **no**
cache and wrote some. It set partial re-primes aside on purpose (§ *Road not taken*). Duppy's
report reverses that. On session `159d7c78…`, the first turn after an 85-minute gap read 9,487
tokens and wrote 448,641, at $4.50. The small prefix still cached (most likely the system prompt
and tools) is enough to defeat the zero-read rule. So the divider stayed silent, while the
overhead split counted the same turn as a recache and Ovrhd jumped.

## The rule

A parent turn is a Cache Miss when either holds:

- **Zero read.** `cache_read_input_tokens === 0 && cache_creation_input_tokens > 0`, decided at
  parse time, unchanged.
- **Recache.** `splitOverheadCost` classifies the turn as `overhead`: `cw > 30,000`, `input ≤ 16`,
  `cr < 20%` of `cr + cw`, context within 15% of the previous parent turn's, and at most one
  iteration. This is decided where the split runs (`serializeClassifiedWithOverheadSplit`),
  because it needs the previous turn's context. The flag goes on the remainder line, never on
  the `#oh` line.

One rule is shared by the divider and by Ovrhd, so the two cannot disagree about which turn
re-primed.

**Measured** on the 300 most recent sessions on this host: 3 turns meet the recache rule, all
after an idle gap longer than 60 minutes, and 4 meet the zero-read rule.

## Tagger version

`WTFT_TAGGER_VERSION` goes from 2.10.0 to 2.11.0. The `miss` flag changes meaning for turns
already tagged, so a 2.10.0 tag reads `stale-version` and is rebuilt.
