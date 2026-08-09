# Spec — Observed cache expiry (#152) + CLI `-p` no-op (#153)

Two independent wtft defects, both fixed by deleting code rather than adding it.

---

## #152 — "Cache Expired" divider predicts instead of observes

### Problem

`extensions/lib/wtft-renderer.ts:882-907` infers cache expiry from **elapsed time**:
walk interactions chronologically, track `latestExpiry = ts + (cacheTtl === "1h" ? 3600000 : 300000)`,
and mark a bin when the next interaction lands past it. It never reads `cacheReadTokens`,
even though the API records the miss verbatim in every usage block.

Two consequences, both measured:

**Structural false negatives.** The cache is keyed per model (and per prefix). Anything that
invalidates the key without consuming time is invisible to a clock. Session `d730d9c3`:

| turn | model | gap | predicted | observed |
|---|---|---:|---|---|
| 19:48:04Z | `claude-opus-4-8` | (first) | — | miss, cw 43,048 |
| **19:59:57Z** | **`claude-opus-5`** | **539s** | **no divider** | **miss, cw 51,072** |

A full 51k re-prime nine minutes in. The same blindness applies to a system-prompt edit or
any other prefix mutation.

**Turn mode shows nothing.** `:888` gates the entire walk behind `intervalConfig.type !== "turns"`
(#121, "cache TTL is time-based"). Session `b1f54c2f` has two real misses —

```
2026-08-09T06:42:42Z   cr=0   cw=48,278
2026-08-09T19:08:58Z   cr=0   cw=76,435     (~$0.76 re-prime on Opus 5)
```

— and `wtft -i 3t --cost` renders zero dividers, while `-i 1h` renders two. The gate suppresses
real, measured events in exactly the view a user reaches for when asking what a turn cost.

### Decision

Delete the predictive walk. Derive the divider from the observation already parsed into
`Interaction`:

```
cacheReadTokens === 0 && cacheWriteTokens > 0
```

### Why removal, not augmentation

The divider renders on `getBinInfo(ix.timestamp, …)` — the bin of the interaction *following*
the expiry. It can only ever draw where a following interaction exists, and that interaction
always carries the miss in its own usage block. **Prediction cannot reach a case observation
cannot.** It is strictly a lossy proxy for data in hand.

Removal also deletes:

- the `3600000` / `300000` TTL constants,
- the `latestExpiry` accumulator and its second chronological sort,
- the renderer's dependency on `Interaction.cacheTtl`,
- the `intervalConfig.type !== "turns"` gate from #121.

Detection collapses into the existing bin-population loop, where `key` is already in scope
(`:836`). No separate pass. Order-independence is a bonus: the predictive walk had to re-sort
because it compared neighbours; observation judges each interaction alone.

`Interaction.cacheTtl` stays on the type — `wtft-parser.ts:200-205` sets it and the recache
signature (#52 Phase 3) consumes it. Only the renderer's use goes.

### Behaviour change: the session's first turn

A session's first interaction is always a miss (cold cache), so it now draws a divider where
the predictive model drew none (`latestExpiry` started `null`).

Kept deliberately. It is a true observation — you pay a full re-prime — and suppressing it
would mean special-casing "first", which is ambiguous under `-l` windowing: the first
interaction of a *rendered slice* is not necessarily the first of the *session*, and a real
mid-session expiry landing at a window edge would be silently dropped. One honest divider beats
a special case that can hide a real event.

### Road not taken: partial re-primes

`cr === 0` does not catch a *partial* re-prime, where a small prefix survives and the bulk is
rewritten:

```
b1f54c2f  2026-08-09T08:01:08Z   cr=17,266   cw=333,021
d730d9c3  2026-08-09T07:50:40Z   cr=17,293   cw=163,455
```

A ratio heuristic (`cw >> cr`) would flag these, but that trades a measured signal for a tuned
threshold, and a partial re-prime is arguably a different event deserving its own marker if it
deserves one at all. Out of scope; recorded so the omission is deliberate.

### Test plan

`tests/wtft-issue-152-cache-expiry.test.ts`, against `buildWtftLines`:

1. **Observed miss draws a divider** — an interaction with `cr=0, cw>0` yields a
   `Cache Expired` line.
2. **All-hit renders none** — every interaction `cr>0` yields no divider.
3. **No cache activity renders none** — `cr=0, cw=0` (the #121 mock shape) yields no divider,
   guarding against a naive `cr === 0` test.
4. **Turn mode shows it** — the same miss under `-i 1t` draws the divider, which is the #121
   regression this fix exists to close.
5. **Model switch inside the TTL** — two interactions 539s apart, second with `cr=0, cw>0`,
   draws a divider. The predictive model produced none here.
6. **Divider count equals miss count** — a mixed run of hits and misses draws exactly one
   divider per bin containing a miss.

Regression: `tests/wtft-issue-121.test.ts` must stay green unchanged. Its mocks use
`cacheReadTokens: 0, cacheWriteTokens: 0`, which case 3 covers.

No `WTFT_TAGGER_VERSION` bump — `cacheReadTokens` / `cacheWriteTokens` are already tagged.
This is renderer-only; existing tag files re-render correctly.

---

## #153 — CLI `-p` / `--pager` is a silent no-op

### Problem

`extensions/lib/wtft-cli-shared.ts:168-169` parses the flag and returns it at `:270`.
`extensions/wtft.ts:464-479` is the only consumer — it opens a Pi TUI overlay.
`bin/wtft.ts` never references `opts.pager`.

So in the standalone CLI the flag is accepted, packed into the options object, and dropped.
No output, no warning, no error — the render is byte-identical to the same command without `-p`.

The intended contract is already documented: `docs/manifests/wtft-cmd.json:50` reads
*"(Pi TUI only — not available in the CLI.)"*. Only the code disagrees.

### Decision

Reject the flag in the CLI with the house error shape (`bin/wtft.ts:232`):

```
❌ Error: -p/--pager is a Pi TUI overlay and is not available in the CLI. Pipe to a pager instead: wtft … | less -R
```

exit 1.

### Road not taken: implement paging

Spawning `${PAGER:-less -R}` would commit the CLI to owning a subprocess, TTY detection, and
the SIGPIPE / early-exit path — to reproduce what `| less -R` already does, correctly, today.
The `-R` is not optional; the output is dense ANSI. Rejecting is the smaller change and makes
the flag stop lying.

### Test plan

`tests/wtft-issue-153-pager-cli.test.ts`:

1. `wtft -p` exits non-zero.
2. Its stderr names both `--pager` and `less -R`.
3. `wtft` without `-p` still renders (the guard is not swallowing normal runs).

The Pi TUI path (`extensions/wtft.ts:464`) is untouched and keeps working.

---

## Verification

- `bun run build` — regenerate `bin/*.mjs`; tests import from `bin/wtft.mjs`.
- `bun run typecheck` — TS7 clean.
- `node --experimental-strip-types tests/wtft-issue-152-cache-expiry.test.ts`
- `node --experimental-strip-types tests/wtft-issue-153-pager-cli.test.ts`
- `node --experimental-strip-types tests/wtft-issue-121.test.ts` (regression)
- Manual, against live sessions:
  - `wtft -i 1d -s <d730d9c3 path>` → divider on the 19:59:57Z model-switch turn.
  - `wtft -i 3t -s <b1f54c2f path>` → dividers now present where there were none.
