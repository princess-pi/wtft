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

Delete the predictive walk. Derive the divider from the observation the API already records —
`cache_read_input_tokens === 0 && cache_creation_input_tokens > 0` — evaluated **at parse time
against raw usage** and carried on `Interaction.cacheMiss`.

The "at parse time" half is not incidental; see *The meter-split trap* below. Evaluating the
same expression later, against tag-file `cr`/`cw`, is unsound.

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

### The meter-split trap

*Found at Step 4; it reversed the version-bump decision below.*

The compaction/recache meter-split (#52 Phase 3, `serializeClassifiedWithOverheadSplit`) emits
**two** tag lines for one interaction: a remainder with `cw` zeroed, and a `#oh` line with `cr`
zeroed. Its recache test is

```
cw > 30_000 && inputTokens <= 16 && cr < 0.2 * (cr + cw) && …
```

— which a **partial** re-prime satisfies just as well as a full miss (`17,266 / (17,266 +
333,021)` = 4.9%). So both produce a `#oh` line carrying `cr=0, cw>0`, and once tagged the two
are indistinguishable:

| case | remainder line | `#oh` line |
|---|---|---|
| full miss | `cr=0, cw=0` | `cr=0, cw=big` |
| partial re-prime | `cr=17k, cw=0` | `cr=0, cw=big` |

Measured on `b1f54c2f`: **4 of 5** `cr=0/cw>0` tag lines were split artifacts; 1 was a real miss.
A renderer-side `cr`/`cw` check would have drawn a divider on the partial re-prime this spec
explicitly put out of scope.

No renderer-only rule escapes this. Reading the `#oh` line over-reports partials; reading the
remainder line under-reports split full misses (its `cw` is zero); pairing the two by base id
reintroduces exactly the neighbour-comparison this issue set out to delete. The wire format
destroyed the signal, so the signal has to be captured before it reaches the wire.

Hence `cacheMiss` is set in `parseEntryToInteraction` from raw usage, propagates onto the
remainder line via the `{...interaction}` spread, and is explicitly cleared on the `#oh` line so
one event is reported once.

### Version bump — reversing the Step-2 decision

Step 2 declined a `WTFT_TAGGER_VERSION` bump. That call weighed a bump against a **cosmetic**
gain (suppressing sidechain dividers), and it was right on those terms. The meter-split trap
changes the terms: `cacheMiss` cannot be back-derived from a v2.6.1 tag file at all, so the
choice is a bump or a wrong divider.

**`WTFT_TAGGER_VERSION` 2.6.1 → 2.7.0.** Sessions re-tag on next read; `cr`/`cw` are unchanged,
so nothing else in the format moves.

The renderer ends up simpler than the Step-2 design anyway — `if (interaction.cacheMiss)`, no
token arithmetic at the render site at all.

### Behaviour change: the session's first turn

A session's first interaction is always a miss (cold cache), so it now draws a divider where
the predictive model drew none (`latestExpiry` started `null`).

Kept deliberately. It is a true observation — you pay a full re-prime — and suppressing it
would mean special-casing "first", which is ambiguous under `-l` windowing: the first
interaction of a *rendered slice* is not necessarily the first of the *session*, and a real
mid-session expiry landing at a window edge would be silently dropped. One honest divider beats
a special case that can hide a real event.

### Rename: "Cache Expired" → "Cache Miss"

`Expired` asserts a **cause** — a TTL elapsed — that observation cannot attest to. The
`d730d9c3` model-switch turn is the counterexample: a genuine full re-prime 539 seconds in,
with nothing expired. The observed signal supports only the weaker, true claim: this bin
contains a turn that paid a full re-prime.

Renaming makes the label state what was measured and stops the divider from making a claim the
new implementation deliberately gave up the ability to check. Touch points: the divider string
at `wtft-renderer.ts:1214` and its description in `docs/EXT_WTFT.html:164`.

### Subagent cold starts are marked too

Each subagent sidechain runs against its own cache namespace, so its first turn is a genuine
miss and now draws a divider on the parent timeline.

`Interaction.isSidechain` exists (`wtft-parser.ts:55`, populated at `:293` from
`entry.isSidechain`, which subagent transcripts do carry) and could gate it out — but it is
**not in the tag-file wire format**. `serializeClassified` / `classifiedToInteraction`
(`wtft-daemon-lib.ts:46,94`) never round-trip the field, so the renderer, which reads from the
tag file, sees `undefined` for every interaction. Excluding sidechains therefore means adding a
wire field *and* bumping `WTFT_TAGGER_VERSION` to re-tag every session.

*Superseded in part: the bump happened anyway, for the correctness reason above. The
measurement below still stands as the reason sidechains are **not** gated out — that decision
was never about the bump alone, and adding an `isSidechain` wire field remains unjustified.*

Measured against that cost, on `a578` — the most subagent-heavy session on this machine, 31
sidechain transcripts across two workflow bursts — its v2.6.1 tag file yields:

| | count |
|---|---:|
| interactions with `cr=0, cw>0` | 10 |
| distinct 1h bins containing one | **6** |
| distinct 1d bins containing one | **2** |

Six dividers on a worst-case session is information, not noise, and every one of them marks
real re-prime spend that already shows up in that bin's cost. Adding a wire-format field and a
full re-tag to suppress six lines is a bad trade and cuts against the simplification this issue
exists to make.

**Decision: no `isSidechain` wire field, no sidechain gating.** Recorded so the omission is
deliberate; revisit only if a session shows the dividers actually crowding the render.

### Road not taken: partial re-primes

The rule does not flag a *partial* re-prime, where a small prefix survives and the bulk is
rewritten:

```
b1f54c2f  2026-08-09T08:01:08Z   cr=17,266   cw=333,021
d730d9c3  2026-08-09T07:50:40Z   cr=17,293   cw=163,455
```

A ratio heuristic (`cw >> cr`) would flag these, but that trades a measured signal for a tuned
threshold, and a partial re-prime is arguably a different event deserving its own marker if it
deserves one at all. Out of scope; recorded so the omission is deliberate.

Worth noting that the meter-split's recache test already *is* such a heuristic
(`cr < 0.2 × (cr + cw)`), and it groups partials with full misses. That grouping is right for
its own purpose — attributing overhead cost — and wrong for this one, which is the whole reason
`cacheMiss` is captured separately rather than inferred from the split.

### Test plan

`tests/wtft-issue-152-cache-expiry.test.ts` — **20 assertions, three parts**. The three parts
exist because the trap above sits between them: the renderer and the parser can each be right
while the wire format between them loses the signal.

**Part A — renderer** (`buildWtftLines`, against `Interaction.cacheMiss`):

1. A flagged miss yields a `Cache Miss` line, and no `Cache Expired` line survives anywhere.
2. All-hit input yields no divider.
3. `cr=0, cw=0` yields no divider — the #121 mock shape, so it doubles as that suite's guard.
4. The same miss under `-i 1t` draws the divider: the #121 regression this fix exists to close.
5. One divider per *bin* containing a miss — two misses in one bin collapse to one line.
6. Shuffled input yields the same count, since nothing compares neighbours any more.

**Part B — parser** (`parseSessionFile`, against raw usage): `cacheMiss` is `true` for
`cr=0, cw>0` and falsy for a partial re-prime, a plain hit, and a turn with no cache activity.
The partial case uses the measured `17,266 / 333,021` shape from `b1f54c2f`.

**Part C — meter-split round-trip** (`serializeClassifiedWithOverheadSplit`), the regression for
the Step-4 defect:

- A full miss splits into two lines, exactly one carries `miss=1`, and it is the remainder — not
  the `#oh` line.
- A partial re-prime splits into two lines, **does** emit a `cr=0/cw>0` line (asserted
  explicitly, so the trap stays documented in executable form), and yet no line is flagged.
- A split full miss round-tripped through tag lines into `buildWtftLines` renders exactly one
  divider — covering the serialize → restore → render path the CLI actually uses.

Regression: `tests/wtft-issue-121.test.ts` stays green unchanged (27 assertions).

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

`tests/wtft-issue-153-pager-cli.test.ts` — **10 assertions**, driving the built
`bin/wtft.mjs` as a subprocess against a one-message fixture session:

1. `-p` exits non-zero; stderr names both `--pager` and `less -R`.
2. `--pager` is rejected identically — the long form is not a separate code path by accident.
3. Without the flag the CLI exits 0, emits output, and prints no pager error: the guard is not
   swallowing normal runs.
4. `--help` still exits 0 and still lists `--pager`. The flag remains valid inside the Pi TUI,
   so help keeps describing it — the CLI refuses to *run* it, it does not pretend it never
   existed.

The fixture matters: without a real session the control case could pass for the wrong reason
("no sessions found" is also non-zero).

The Pi TUI path (`extensions/wtft.ts:464`) is untouched and keeps working.

---

## Verification — as run (Step 4)

| check | result |
|---|---|
| `tests/wtft-issue-152-cache-expiry.test.ts` | 20 passed, 0 failed |
| `tests/wtft-issue-153-pager-cli.test.ts` | 10 passed, 0 failed |
| `tests/wtft-issue-121.test.ts` (regression) | 27 passed, 0 failed |
| `wtft-compaction-tracking`, `wtft-claude5-pricing`, `wtft-half-block`, `wtft-issue-21` | pass |
| `wtft-issue-141-workflow-discovery` | 7 passed, 0 failed |
| `wtft-daemon-lifecycle` | 30 passed, 0 failed |
| `wtft-daemon-cost-cross-validation` | 5 passed, 0 failed |
| `wtft-cli-e2e-cost-parity` | 5 passed, 0 failed |
| `bun run build` | pass |
| `bun run typecheck` | 2 pre-existing TS7016 in `serve/cloudflare.js`; 0 in files this branch touches |

Two suites fail identically on unmodified `main` (confirmed in a detached baseline worktree),
so they are environment, not regression: `wtft-auto-fit` ("CLI rendering should have ticks
line") and `session-name-display` (`ERR_MODULE_NOT_FOUND @earendil-works/pi-tui`).

Manual, divider counts cross-checked against `miss` flags in the regenerated v2.7.0 tag files:

| session | render | dividers | ground truth |
|---|---|---:|---|
| `b1f54c2f` | `-i 1h` | 2 | 2 flagged misses in 2 distinct 1h bins; 5 lines carry `cr=0/cw>0`, so the 3 phantoms are gone |
| `b1f54c2f` | `-i 3t` | present | previously zero — the #121 gate |
| `d730d9c3` | `-i 1d` | 3 | 5 flagged misses across 3 distinct local days (PDT) |

The `d730d9c3` set includes `2026-08-05T19:59:55Z`, the `opus-4-8` → `opus-5` switch 539
seconds after the previous turn — the case that motivated the issue. `07:50:38Z`, the partial
re-prime, is correctly not flagged.

`docs/EXT_WTFT.html` reconciled to the observed rule and the new label at Step 5.
