# Spec 149 — The wtft ↔ Claude Code cost gap is transcript-invisible spend at turn boundaries

**Issue:** #149
**Branch:** `149-compaction-cost-scope`
**State:** Spec Approved

---

## 1. What was actually measured

Every number below comes from running
`research/149-cost-scope/paired-window-audit.mjs --all` against the seven sessions logged
in `~/.claude/statusline-logs/` on 2026-08-10. Nothing is carried over from the issue body
on trust; the two claims from the issue that I re-verified in code are called out in §2.

**No logged session has the `…a578` shape.** All seven are `claude-opus-5`, and none uses
Task subagents — probed directly: zero `isSidechain` entries and zero `Task` `tool_use`
blocks across all seven transcripts. The Fable-5-plus-35-subagents session that produced the
original 11% observation predates the logging and cannot be re-measured. This spec therefore
measures the gap on the sessions that exist and says plainly what that does and does not
settle about a578 (§7).

### 1.1 Headline

| | |
|---|---|
| sessions audited | 7 (5 with enough records to be meaningful) |
| Claude Code billed over the aligned spans | **$137.709154** |
| residual not explained by the transcript | **$6.494548** |
| residual as a fraction of billed | **4.72%** |
| downward steps in the residual (instrument sanity) | **0** |

### 1.2 Per session

| session | model | billed (aligned span) | residual | % | steps | compactions |
|---|---|---:|---:|---:|---:|---:|
| `227cbd29` | opus-5 | $21.158022 | $0.744724 | 3.52% | 5 | 0 |
| `b1f54c2f` | opus-5 | $41.761565 | $2.250626 | 5.39% | 12 | 1 |
| `b3df8f20` | opus-5 | $9.396260 | $0.271562 | 2.89% | 3 | 0 |
| `d730d9c3` | opus-5 | $28.714775 | $1.828154 | 6.37% | 10 | 0 |
| `ee53e779` | opus-5 | $33.089463 | $1.185673 | 3.58% | 9 | 0 |
| `e0d2ec4b` | opus-5 | $3.589026 | $0.213809 | 5.96% | 3 | 0 (live, partial) |
| `d7b5ff30` | opus-5 | — | — | — | 0 | 0 (3 records, no span) |

### 1.3 Decomposition of the $6.494548

| class | steps | usd | share of residual |
|---|---:|---:|---:|
| **compaction** (`/compact` — a `compact_boundary` sits inside the step's window) | 1 | $0.673267 | 10.4% |
| **turn-boundary, unattributed** | 41 | $5.821281 | 89.6% |

The single compaction step reproduces the issue's earlier measurement to the cent
($0.673267 on `b1f54c2f`), which is a useful cross-check that the new instrument agrees
with the old one-off. **But compaction is not the story.** Four of the five substantial
sessions have zero compactions and still show a 2.9–6.4% residual.

---

## 2. Two claims from the issue, re-verified in code

**(a) wtft has no compaction line at all for Claude Code sessions.** The renderer's
compaction summary keys off `Interaction.compactionTokensBefore`
(`extensions/lib/wtft-renderer.ts:1675-1684`), which is only ever set from a
`{ kind: "compaction"; tokensBefore }` control signal. The **Pi** adapter emits that signal
(`extensions/lib/harness/pi/parse.ts:97-98`); the **Claude Code** adapter emits only
`{ kind: "after-compaction" }` from `entry.isCompactSummary`
(`extensions/lib/harness/claude-code/parse.ts:93`) and never reads
`system`/`compact_boundary` at all. So `tests/wtft-compaction-tracking.test.ts` — which
constructs `type: "compaction"` entries — exercises the Pi path only, and a Claude Code
session that compacted three times renders no compaction line whatsoever. The issue's
framing that "wtft already has compaction handling" is true for the *meter-split* and false
for the *count*.

**(b) The transcript records no usage for a compaction.** Confirmed on `b1f54c2f`: the
`system`/`compact_boundary` entry at `2026-08-09T08:24:34.707Z` carries `compactMetadata`
(`trigger: manual`, `preTokens: 376813`, `postTokens: 15148`, `durationMs: 119665`) and no
`usage` object; the compaction summary lands as a `user` entry with `isCompactSummary: true`,
also with no `usage`. Nothing in the file prices the call.

---

## 3. The instrument, and why the obvious one is wrong

### 3.1 What broke first

The first version of this harness did the obvious thing: pair consecutive `_epoch_ms`
records, diff `total_cost_usd`, and price the transcript messages whose timestamps fall
between them. That produces a **±$0.20 sawtooth**, not a residual.

Cause: Claude Code renders the status line the instant a response completes, and the
transcript entry for that same response is flushed up to ~1.5 s **later**. Every window
therefore either double-counts or misses exactly one message, and the sign alternates. On
`b1f54c2f` the naive pass reported a $2.83 "no-messages" window immediately after a $2.67
"over" window — one API call, counted on the wrong side of a boundary, presenting as two
separate anomalies. Three of the "invisible cost classes" the first pass turned up were this
artifact and nothing else.

This is the same failure mode as the totals comparison the issue already warned about, one
level down. Timestamps are not a sound join key between these two files.

### 3.2 What works — usage alignment

Every status-line record carries `context_window.current_usage`: the usage of the most
recent API response. **That is a join key.** Match it against the deduplicated interaction
list on `(input, output, cache_creation, cache_read)` and you know exactly which message
Claude Code had billed when it wrote that record — no timestamp guessing. Define, over
aligned records only:

```
R(k) = [claude_cost(k) − claude_cost(0)] − [wtft_cost_through_message(k) − wtft_cost_through_message(0)]
```

`R` is then a **monotone staircase**: flat while the transcript explains the bill, stepping
up exactly when Claude Code bills something the transcript never records.

Records whose usage matches nothing ahead of the pointer (mid-stream renders, where
`output_tokens` is a partial count) are skipped. Skipping costs nothing: `wtftCum` is a
prefix sum by *index*, so a skipped record never drops an interaction, it only defers it to
the next aligned record.

**Sanity result: 0 downward steps across all 7 sessions.** A sound instrument on a
one-directional phenomenon should never go backwards, and this one doesn't. The sawtooth is
entirely gone. Alignment coverage: 225/225 interactions on `ee53e779`, 267/267 on
`d730d9c3`, 146/147 on `227cbd29`.

### 3.3 Dedup rule (do not "fix" this)

The harness calls wtft's own `deduplicateInteractions`, which keeps the **max-cost** copy of
each message id — the final streamed usage, which is the billed value (#54). Deduping by
first copy undercounts output ~33% and manufactures a residual that is not there. The
harness deliberately reuses wtft's function rather than reimplementing it, so the residual
measures **scope** and can never measure a difference in how the two sides were assembled.

---

## 4. What the invisible spend actually is

Each step has a consistent shape. Sample from `ee53e779` (Opus 5: cache read $0.50/MTok,
output $25/MTok):

| step at | usd | context at step start | implied output tokens if the call re-read the whole context from cache |
|---|---:|---:|---:|
| 01:43:36Z | $0.080641 | 119,413 | 837 |
| 02:21:35Z | $0.102402 | 176,276 | 571 |
| 08:01:20Z | $0.111496 | 207,293 | 314 |
| 08:33:59Z | $0.131998 | 236,627 | 547 |
| 09:09:06Z | $0.135168 | 250,157 | 404 |
| 09:16:46Z | $0.143015 | 266,092 | 399 |
| 09:26:18Z | $0.165565 | 280,333 | 1,016 |
| 09:35:08Z | $0.157608 | 289,918 | 506 |
| 09:36:37Z | $0.157782 | 297,615 | 359 |

Three facts the data supports:

1. **Step size tracks context size.** Every step is within a few cents of
   `context × $0.50/MTok`, with the remainder pricing as a few hundred output tokens. The
   invisible call reads the whole conversation *from cache* and writes a short answer.
   This is why the gap grows through a session and why long sessions look worse.
2. **Steps land at human-prompt boundaries.** 36 of the 41 unattributed steps have a
   `human_prompt` marker inside their window. Not every prompt produces one:
   `ee53e779` 9 steps / 16 prompts, `d730d9c3` 10 / 17, `b3df8f20` 3 / 6, `227cbd29` 5 / 6.
3. **Every recap coincides with a step.** `system`/`away_summary` count equals
   steps-carrying-an-`away_summary` marker exactly on all four sessions where both are
   non-zero (3/3, 6/6, 3/3, 3/3). Recaps are therefore *one* generator of invisible spend —
   but they are only 15 of 41 steps, so they are not the whole class.

What the data does **not** support: naming the mechanism behind the other 26 steps. The
transcript contains no entry for them at all. Claiming "it's the recap" or "it's a retry"
would repeat exactly the mistake hypothesis A made — a plausible story ahead of a
measurement. The harness therefore reports them as **unattributed** and this spec leaves
them unattributed.

---

## 5. The fork

The gap is real, it is on Claude Code's side of the ledger, and **no parser can recover it**
— the numbers are not written anywhere wtft can read. That leaves three directions.

| direction | what it commits wtft to |
|---|---|
| **Estimate it** — price `preTokens × cacheRead` for compaction, and a per-turn fudge for the rest | wtft's TOTAL becomes partly modelled. The output half is unmeasurable, and the 26 unattributed steps have no metadata at all to estimate *from*. Pulls toward "wtft reports a number it cannot verify" — and toward silently absorbing future changes in Claude Code's internals. |
| **Read the status-line log** | wtft's total becomes correct on this machine, after 2026-08-09, for Claude Code only. Creates a hard dependency on a dotfile outside the repo, yields nothing for the sessions this very analysis had to reconstruct, and makes wtft's answer depend on whether the user installed a shell script. |
| **Name the blind spot** (chosen) | wtft's TOTAL stays strictly derived from recorded usage — every dollar traceable to a `usage` object. The events it *can* see but *cannot* price are counted and printed as an explicit UNCOUNTED line. The number stays honest and the omission stops being silent. |

**Chosen: name the blind spot.** The measurement in §1 is what makes this the right fork
rather than a cop-out: at 4.72% the omission is large enough that hiding it is misleading,
and the per-step metadata is thin enough that estimating it would be fiction.

### Roads not taken

- **Estimate compaction cost from `compactMetadata`.** `preTokens` gives a defensible
  cache-read floor, but §4 shows the output half is 15–40% of the bill and there is no
  field for it. Set aside because it would put a modelled number inside a total whose entire
  value is that it is derived.
- **Reconcile against `~/.claude/statusline-logs/`.** The right tool for *this* analysis
  (it is exactly what the harness does) and the wrong dependency for the product. Set aside
  for wtft; kept in `research/`.
- **Estimate the unattributed turn-boundary calls.** §4 gives a usable model
  (`context × cacheRead + ~500 output`), and it is tempting because it would close most of
  the gap. Set aside: the mechanism is unidentified, so the model would be fitted to five
  Opus-5 sessions on one machine and would drift the moment Claude Code changes.
- **Count `turn_duration` as an uncounted event.** It is the closest observable proxy for
  "a turn boundary happened", but only ~55% of turn boundaries produce a step, so counting
  them would over-report. Set aside in favour of counting only what is 1:1 with observed
  spend.

---

## 6. Proposed change

### 6.1 Harness seam — an optional adapter method

`HarnessParseAdapter` gains an **optional** method (`extensions/lib/harness/types.ts`):

```ts
/** Entries that Claude Code / Pi bill for but write no `usage` object for.
 *  Counted, never priced — see docs/spec-149-compaction-cost-scope.md. */
readUncountedBillable?(entry: any): UncountedBillableClass | null;

export type UncountedBillableClass = "compaction" | "recap";
```

Optional so external harnesses registered through the #156 seam stay valid without change.

- **claude-code** (`harness/claude-code/parse.ts`): `system`/`compact_boundary` →
  `"compaction"`; `system`/`away_summary` → `"recap"`.
- **pi** (`harness/pi/parse.ts`): `type: "compaction"` → `"compaction"`. (Pi's existing
  `{ kind: "compaction", tokensBefore }` control signal is untouched — that drives the
  meter-split and the "tokens freed" line, which are different facts.)

### 6.2 Parser — a scan that does not disturb the interaction list

New export in `extensions/lib/wtft-parser.ts`:

```ts
export interface UncountedBillables { compaction: number; recap: number; }
export function scanUncountedBillables(filePath: string): UncountedBillables;
```

A separate scan rather than a new field on `Interaction` or a changed
`parseSessionFile` return type: these events attach to no interaction (that is the whole
point), and `parseSessionFile`'s signature is load-bearing for the daemon tag file, the
watch path and 40-odd suites. Small interface, no ripple.

`readUncountedBillableClass(entry)` tries every registered harness adapter and returns the
first non-null hit. This is safe rather than merely convenient: each adapter's own
`readUncountedBillable` already gates on entry shape it owns (`entry.type === "system"` for
claude-code, `entry.type === "compaction"` for pi) so a given entry matches at most one
adapter in practice, but the "first wins" rule is the explicit tie-break if that ever stops
being true — it prevents a single entry from being double-counted across two adapters that
both happen to recognize it.

### 6.3 Renderer — the UNCOUNTED line

`renderTokenSummary` gains an optional 4th parameter `uncounted?: UncountedBillables` and,
when any count is non-zero, appends after the TOTAL row:

```
UNCOUNTED  1 compaction, 3 recaps — billed by the harness; the transcript records
           no usage for them, so they are NOT in TOTAL above (#149)
```

("billed by the harness", not "Claude Code bills these" — the wording is harness-neutral
because Pi also has a `compaction` class, even though Pi has no `recap` class.)

Existing behaviour is unchanged when the parameter is omitted or all counts are zero. The
Pi "Compaction: N event(s), X total tokens freed" line stays exactly as it is — it reports
tokens *freed*, a different fact from spend *not counted*.

### 6.4 CLI wiring

`bin/wtft.ts` calls `scanUncountedBillables` on the session file **and on every file
`discoverSubagentSessionFiles` finds** (the same discovery `--tokens` already uses to fold
subagent cost into TOTAL), summing the counts with `addUncountedBillables` before passing
the result to `renderTokenSummary`. A compaction or recap inside a subagent transcript is
exactly as invisible as one in the parent, so it must be counted the same way. Wired into
the non-watch `--tokens` path only (`bin/wtft.ts` around the `if (opts.tokens)` block); the
daemon (`wtft-daemon.mjs`) and `serve.mjs` watch loops export the same functions (rebuilt
into their bundles) but do not yet call `renderUncountedBillables` — see "Deliberately not
in scope" below.

### Deliberately not in scope

- No change to any cost arithmetic. #146 is confirmed correct twice over.
- No change to the daemon tag-file format or to `parseSessionFile`'s return type.
- No estimate, anywhere, of what the uncounted events cost.
- No UNCOUNTED line in watch mode (`wtft-daemon.mjs`, `serve.mjs`). Both bundles carry the
  new exports (`scanUncountedBillables`, `renderUncountedBillables`, …) because they inline
  the whole of `bin/wtft.ts`, but neither watch loop calls `renderUncountedBillables` yet.
  Deferred rather than wired blind: the watch UI redraws per keystroke/tail-event, and
  whether re-scanning the transcript file on every redraw is cheap enough is untested. Left
  as an open question for Step 4/5, not assumed here.

---

## 7. What this does and does not settle about a578

**Settles:** the gap is scope, the dominant class is per-turn transcript-invisible calls
that scale with context, and compaction is a real but minority contributor (10.4% of the
measured residual here; the issue's own scaled estimate for a578 was ~15%).

**Does not settle:** a578 itself. Measured here is 4.72%; a578 showed ~11%. a578 was Fable 5
(2× rates, which cancels in a ratio) with 35 subagent transcripts and one compaction — and
**no logged session has subagents**, so the interaction between subagent sidechains and
this invisible class is untested. The residual gap for a578 is roughly 6 percentage points,
still unexplained.

**This issue therefore stays OPEN** with a specific next step: log a session that uses Task
subagents, re-run the harness, and check whether each subagent contributes its own
turn-boundary steps (which would roughly double the per-turn class on a subagent-heavy
session and close most of the remaining 6 points). Closing it now on a 4.72% measurement
presented as if it were the 11% would be a worse outcome than leaving it open.

---

## 8. Spec gate — verification criteria

Each is concretely checkable. V1–V4 are properties of the harness, V5–V9 of the wtft change.

| | criterion | how it is checked |
|---|---|---|
| **V1** | The harness runs against any logged session id by prefix and against `--all`, and exits 0; against every *non-subagent* session on the machine, `negativeSteps === 0`. | `node research/149-cost-scope/paired-window-audit.mjs ee53e779` and `--all`; asserted live in `tests/wtft-issue-149-uncounted-billables.test.ts`, which skips (does not assert on) any logged session whose transcript has subagent files — §7 is explicit that alignment on subagent-bearing sessions is untested, and this machine now runs multi-agent workflows that log exactly such sessions mid-run. Caught for real during Step 4 (Code Approved): a live dispatcher session with Task subagents produced 6 negative steps, confirming the §7 caveat empirically rather than leaving it purely theoretical. |
| **V2** | The residual staircase is monotone: `negativeSteps === 0` on every session with ≥ 2 aligned records. | printed as `downward steps (instrument sanity)`; asserted in `tests/wtft-issue-149-uncounted-billables.test.ts` over a synthetic log + transcript pair |
| **V3** | Alignment is by usage, not timestamp: a synthetic transcript whose entries are written 5 s *after* the status record that bills them still yields residual 0. | test fixture with deliberately lagged timestamps |
| **V4** | An injected invisible call (status cost advances with no matching transcript usage) is detected as exactly one step of exactly that size. | test fixture; assert `steps.length === 1` and `steps[0].usd` to 6 dp |
| **V5** | `scanUncountedBillables` counts a Claude Code `system`/`compact_boundary` as one compaction. | unit test with a synthetic Claude Code JSONL |
| **V6** | `scanUncountedBillables` counts a Claude Code `system`/`away_summary` as one recap. | same |
| **V7** | `scanUncountedBillables` counts a Pi `type: "compaction"` entry as one compaction, and does **not** double-count it via the existing control-signal path. | unit test with a synthetic Pi JSONL; also assert the existing `compactionTokensBefore` stamp still lands |
| **V8** | `renderTokenSummary` emits an `UNCOUNTED` line naming both counts when either is non-zero, and emits nothing new when both are zero or the argument is omitted. | string assertions on the rendered output |
| **V9** | No cost number changes: `renderTokenSummary`'s TOTAL for a fixture is byte-identical with and without the `uncounted` argument. | assert the TOTAL row is unchanged |
| **V10** | Existing compaction behaviour is untouched: `tests/wtft-compaction-tracking.test.ts` passes unmodified. | run that suite |

---

## 9. Reconciliation record (Step 5)

_To be filled at Step 5._
