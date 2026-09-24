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

Every turn Ovrhd counts as a recache now also gets a divider. The converse does not hold: a
zero-read turn that fails the recache test, such as a session's first turn, still gets a divider
with no Ovrhd share.

**After a daemon restart.** The previous context is not carried across a restart: the daemon
starts it at 0 and resumes at its offset. So the first turn it reads after a restart is judged
with no previous context, and neither Ovrhd nor the divider calls it a recache. The two stay in
step.

**Only the session's own lines.** The recache case is decided in the split, and only the
session's own turns are serialized through it (`flushPending`, `reparseOne`). Subagent lines are
written by `syncSubagentTranscript` through `serializeClassified`, with no split, so the #115
parent-only rule still holds. The Pi widget and the CLI both read the session's own turns from
the tag file (`readTagFileWithVerdict`), so both see the flag.

**Measured 2026-09-24** on the 300 most recently modified sessions on this host, parent turns
only, each counted once:

| Rule | Turns |
|---|---|
| zero-read only (both were a session's first turn) | 2 |
| recache only (the new cases) | 2 |
| both | 1 |

Every recache turn came after an idle gap longer than 60 minutes. A repeat run can differ, because
the set of most recent sessions moves.

**The reported session, verified.** Reparsing a copy of `159d7c78…` with this build writes
`miss: 1` on the 03:14:42Z turn and on no other line. `wtft -i 20m --cost` then draws the Cache
Miss divider between the 18:40 and 20:00 rows.

## Tagger version

`WTFT_TAGGER_VERSION` goes from 2.10.0 to 2.11.0. The `miss` flag changes meaning for turns
already tagged, so a 2.10.0 tag reads `stale-version` and is rebuilt.
