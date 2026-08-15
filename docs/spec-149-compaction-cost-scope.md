# Spec 149 — The wtft ↔ Claude Code cost gap is transcript-invisible spend at turn boundaries

**Issue:** #149
**Branch:** `149-compaction-cost-scope`
**State:** Code and Spec Approved (Step 5)

---

## 1. What was actually measured

Every number below comes from running
`research/149-cost-scope/paired-window-audit.mjs --all` against the seven sessions logged
in `~/.claude/statusline-logs/` on 2026-08-10. Nothing is carried over from the issue body
on trust; the two claims from the issue that I re-verified in code are called out in §2.

> **These are a snapshot, not a standing fact.** The measurement reads live, still-growing
> session logs on one machine, so re-running the harness later returns different numbers by
> construction. Every figure in §1 is stamped **as of 2026-08-10T11:00Z**. §1.4 records a
> Step-5 re-run against the same seven sessions six hours later, and what changed between
> them turned out to matter — see §7.

**No logged session had the `…a578` shape** *at that instant*. All seven were
`claude-opus-5`, and none used Task subagents — probed directly: zero `isSidechain` entries
and zero `Task` `tool_use` blocks across all seven transcripts as of 2026-08-10T11:00Z. The
Fable-5-plus-35-subagents session that produced the original 11% observation predates the
logging and cannot be re-measured. This spec therefore measures the gap on the sessions that
exist and says plainly what that does and does not settle about a578 (§7).

*(That "none uses subagents" fact expired the same day: by 2026-08-10T17:00Z session
`e0d2ec4b` — live and partial in the table below — had acquired 18 subagent transcripts.
§1.4 and §7 record what that revealed.)*

### 1.1 Headline (as of 2026-08-10T11:00Z)

| | |
|---|---|
| sessions audited | 7 (5 with enough records to be meaningful) |
| Claude Code billed over the aligned spans | **$137.709154** |
| residual not explained by the transcript | **$6.494548** |
| residual as a fraction of billed | **4.72%** |
| downward steps in the residual (instrument sanity) | **0** |

### 1.2 Per session (as of 2026-08-10T11:00Z)

| session | model | billed (aligned span) | residual | % | steps | compactions |
|---|---|---:|---:|---:|---:|---:|
| `227cbd29` | opus-5 | $21.158022 | $0.744724 | 3.52% | 5 | 0 |
| `b1f54c2f` | opus-5 | $41.761565 | $2.250626 | 5.39% | 12 | 1 |
| `b3df8f20` | opus-5 | $9.396260 | $0.271562 | 2.89% | 3 | 0 |
| `d730d9c3` | opus-5 | $28.714775 | $1.828154 | 6.37% | 10 | 0 |
| `ee53e779` | opus-5 | $33.089463 | $1.185673 | 3.58% | 9 | 0 |
| `e0d2ec4b` | opus-5 | $3.589026 | $0.213809 | 5.96% | 3 | 0 (live, partial) |
| `d7b5ff30` | opus-5 | — | — | — | 0 | 0 (3 records, no span) |

### 1.3 Decomposition of the $6.494548 (as of 2026-08-10T11:00Z)

| class | steps | usd | share of residual |
|---|---:|---:|---:|
| **compaction** (`/compact` — a `compact_boundary` sits inside the step's window) | 1 | $0.673267 | 10.4% |
| **turn-boundary, unattributed** | 41 | $5.821281 | 89.6% |

The single compaction step reproduces the issue's earlier measurement to the cent
($0.673267 on `b1f54c2f`), which is a useful cross-check that the new instrument agrees
with the old one-off. **But compaction is not the story.** Four of the five substantial
sessions have zero compactions and still show a 2.9–6.4% residual.

### 1.4 Step-5 re-run (2026-08-10T17:20Z) — the same seven sessions, six hours later

`node research/149-cost-scope/paired-window-audit.mjs --all`, same log dir, same seven ids:

| | 11:00Z | 17:20Z |
|---|---:|---:|
| billed over aligned spans | $137.709154 | $174.896350 |
| residual | $6.494548 | $7.226350 |
| residual as % of billed | 4.72% | 4.13% |
| invisible-spend steps | 42 | 51 |
| **downward steps** | **0** | **6** |

The drift in the dollar figures is expected — live sessions kept billing. **The six downward
steps are not.** All six are on `e0d2ec4b`, the row marked *(live, partial)* above, which in
the interim ran a multi-agent workflow and grew 18 subagent transcripts. `ee53e779`, which
has none, re-ran byte-identical: same $33.089463, same 9 steps at the same nine timestamps
with the same amounts as the §4 table.

A downward step is the instrument declaring itself unsound on that session — not a finding
about spend. It is the first empirical confirmation of the caveat §7 had only asserted, and
it is tracked as **#176**; the mechanism is deliberately not named here (see #176 for what
is ruled out and what is only suspected). Consequences already carried:

- the harness prints `⚠️  alignment broke` whenever `negativeSteps > 0`, and since #256
  also RECORDS each downward step in `dips[]` — magnitude, the records either side, and
  the Claude cumulative before/after — because a tally said a session was out of scope
  without saying by how much;
- V1 skips subagent-bearing sessions rather than asserting on them, and since #256 no
  longer asserts monotonicity on the non-subagent ones either — it surveys and reports
  them (§8);
- the §1 numbers are scoped to non-subagent sessions everywhere they are quoted.

---

## 2. Two claims from the issue, re-verified in code

**(a) wtft has no compaction line at all for Claude Code sessions.** The renderer's
compaction summary keys off `Interaction.compactionTokensBefore`
(`extensions/lib/wtft-renderer.ts:1683-1694`, post-branch line numbers), which is only ever
set from a `{ kind: "compaction"; tokensBefore }` control signal. The **Pi** adapter emits
that signal (`extensions/lib/harness/pi/parse.ts:98-99`); the **Claude Code** adapter emits
only `{ kind: "after-compaction" }` from `entry.isCompactSummary`
(`extensions/lib/harness/claude-code/parse.ts:94`) and never reads
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

**Sanity result: 0 downward steps across all 7 sessions as they stood at 2026-08-10T11:00Z
— none of which had Task subagents.** A sound instrument on a one-directional phenomenon
should never go backwards, and on those sessions this one doesn't. The sawtooth is entirely
gone. Alignment coverage: 225/225 interactions on `ee53e779`, 267/267 on `d730d9c3`,
146/147 on `227cbd29`.

**Where it is not sound.** Once `e0d2ec4b` grew 18 subagent transcripts the same harness
reported 6 downward steps on it (§1.4), and alignment coverage collapsed to 55/107 records
against 490/1003 interactions. So the monotonicity result above is a property of *this
instrument on non-subagent sessions*, not of the instrument in general. The mechanism is
unidentified and is tracked as **#176** — asserting one here would be exactly the
plausible-story-ahead-of-a-measurement error §3.1 documents. Ruled out already:
`loadWtftInteractions` does fold subagent files in, so it is not a missing-input problem.
Practically: **treat any non-zero `negativeSteps` as "out of scope for this instrument",
never as a finding.** The harness prints `⚠️  alignment broke` to make that unmissable.

### 3.3 Dedup rule (do not "fix" this)

The harness calls wtft's own `deduplicateInteractions`, which keeps the **max-cost** copy of
each message id — the final streamed usage, which is the billed value (#54). Deduping by
first copy undercounts output ~33% and manufactures a residual that is not there. The
harness deliberately reuses wtft's function rather than reimplementing it, so the residual
measures **scope** and can never measure a difference in how the two sides were assembled.

---

## 4. What the invisible spend actually is

Counts here are the 2026-08-10T11:00Z snapshot over the five substantial **non-subagent**
sessions (§1.1); they do not include `e0d2ec4b`'s post-17:00Z steps, which the instrument
flagged as unsound (§1.4). Each step has a consistent shape. Sample from `ee53e779` (Opus 5:
cache read $0.50/MTok, output $25/MTok) — re-run at Step 5 and byte-identical, all nine
steps at the same timestamps and amounts:

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

New exports in `extensions/lib/wtft-parser.ts` — four functions and a type, all of them
public because the CLI sums across several files and the tests exercise each step:

```ts
export interface UncountedBillables { compaction: number; recap: number; }

export function newUncountedBillables(): UncountedBillables;
export function addUncountedBillables(a: UncountedBillables, b: UncountedBillables): UncountedBillables;
export function readUncountedBillableClass(entry: any): UncountedBillableClass | null;
export function scanUncountedBillables(filePath: string): UncountedBillables;
```

`new`/`add` exist because §6.4 folds subagent files into one figure and needs an identity
and a sum rather than ad-hoc `+`. `readUncountedBillableClass` is the registry fan-out and
is exported so a test can assert the tie-break directly instead of inferring it from a file
scan. `scanUncountedBillables` never throws: an unreadable or missing file reports no blind
spot, because a session with no readable subagent file must not take the summary down.

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
the non-watch `--tokens` path only (`bin/wtft.ts`, the `if (opts.tokens)` block).

**A build constraint the code revealed (found at Step 4, not designed in).** `bin/wtft.ts`
has an explicit `export { … }` block, and Bun tree-shakes anything absent from it out of
`bin/wtft.mjs`. Every new symbol the tests import must therefore be added there — including
`renderTokenSummary`, which this branch had to add even though it is *pre-existing* and
*already used internally by `bin/wtft.ts`*: internal use is not a re-export, so it had never
been reachable from the bundle. Any future test importing an existing helper from
`bin/wtft.mjs` will hit the same wall. This is a packaging fact about the seam, not a
change in behaviour — no runtime path changed by exporting it.

### Deliberately not in scope

- No change to any cost arithmetic. #146 is confirmed correct twice over.
- No change to the daemon tag-file format or to `parseSessionFile`'s return type.
- No estimate, anywhere, of what the uncounted events cost.
- No UNCOUNTED line in watch mode (`wtft-daemon.mjs`, `serve.mjs`). Deferred rather than
  wired blind: the watch UI redraws per keystroke/tail-event, and whether re-scanning the
  transcript file on every redraw is cheap enough is untested. Naming a per-redraw cost
  without measuring it is the same error §3.1 documents, so it stays an open question.

  **What the built bundles actually contain** (verified at Step 5 by grepping them, because
  the Step-2 draft asserted this wrongly): only `bin/wtft.mjs` carries the new functions —
  `scanUncountedBillables`, `renderUncountedBillables`, `newUncountedBillables`,
  `addUncountedBillables`, `readUncountedBillableClass`. `bin/wtft-daemon.mjs` carries only
  the two adapters' `readUncountedBillable` methods, because it inlines the harness registry
  and *not* `bin/wtft.ts`. `bin/serve.mjs` is untouched by this branch and carries none of
  it. So wiring watch mode later is a real code change in two bundles, not a one-line call
  into functions that are already there.

---

## 7. What this does and does not settle about a578

**Settles:** the gap is scope, the dominant class is per-turn transcript-invisible calls
that scale with context, and compaction is a real but minority contributor (10.4% of the
measured residual here; the issue's own scaled estimate for a578 was ~15%).

**Does not settle:** a578 itself. Measured here is 4.72%; a578 showed ~11%. a578 was Fable 5
(2× rates, which cancels in a ratio) with 35 subagent transcripts and one compaction — and
**no logged session had subagents at measurement time**, so the interaction between subagent
sidechains and this invisible class is untested. The residual gap for a578 is roughly 6
percentage points, still unexplained.

**The obvious next step was attempted, and it failed for a new reason.** By 2026-08-10T17Z a
subagent-bearing session existed (`e0d2ec4b`, 18 subagent transcripts) and the harness ran
against it. It reported a residual of 2.32% — and 6 downward steps (§1.4), which is the
instrument declaring the number unsound rather than producing one. **So this spec still has
no valid measurement of the subagent case**, and it is now clear that logging such a session
was never sufficient: the instrument must first be made sound on sidechain sessions. That is
filed as **#176**.

**This issue therefore stays OPEN.** Revised next step, in order:

1. **#176 first** — make usage alignment sound on subagent-bearing sessions, or establish
   that `current_usage` cannot serve as a join key there. Until `negativeSteps === 0` on
   such a session, any residual it reports is not evidence.
2. **Then re-measure a578's shape** — with a sound instrument, check whether each subagent
   contributes its own turn-boundary steps. That is the hypothesis that would roughly double
   the per-turn class on a subagent-heavy session and close most of the remaining ~6 points.
   It remains a hypothesis; nothing here tests it.

Closing #149 now on a 4.72% non-subagent measurement presented as if it were the 11% would
be a worse outcome than leaving it open — and closing it on `e0d2ec4b`'s 2.32% would be
worse still, since that figure comes from a run the instrument itself flagged as broken.

**What this branch does ship, independent of the above:** the blind spot is now *named* in
the product (§6), which was the fork chosen in §5 and does not depend on resolving a578.

---

## 8. Spec gate — verification criteria

Each is concretely checkable. V1–V4 are properties of the harness, V5–V10 of the wtft change.
V1 was **restated** and V2b/V2c **added** on 2026-08-14 (#256); the rows say what changed and why.
All ten passed at Step 5 (2026-08-10T17:20Z): `bun run test` — **44 suites, 44 passed, 0
failed**. The "status" column records what actually backs each row, including the two halves
that no test covers.

| | criterion | how it is checked | status |
|---|---|---|---|
| **V1** | ~~against every *non-subagent* session on the machine, `negativeSteps === 0`~~ **restated 2026-08-14 (#256):** the harness surveys *every* logged session, accounts for each one in exactly one bucket, and prints what it found. The harness also runs by prefix and against `--all` and exits 0. | The exit-0 half is still checked by hand — `node research/149-cost-scope/paired-window-audit.mjs ee53e779` and `--all` both exit 0. The survey is `tests/wtft-issue-149-uncounted-billables.test.ts`, which prints one flat `#149-survey  key=value` record per session plus a totals line, and asserts only what holds on unknown data: `audited + skipped_subagent + unreadable + unauditable === sessions`, `readStatusLog` ascending by `_epoch_ms` on **every** log (not just `ids[0]`), steps positive, dips negative, and `negativeSteps === dips.length`. | pass. The monotonicity half was **withdrawn**, not weakened: it was measured on 7 sessions and asserted over 23, and is false on 2 of them (§1.4, #256, #282). It now lives on synthetic fixtures as V2b/V2c where the arithmetic is decidable. The CLI-exit-0 half remains **reconciled-against-untested** (no suite shells out to the harness binary). |
| **V2** | The residual staircase is monotone: `negativeSteps === 0` on every session with ≥ 2 aligned records. | printed as `downward steps (instrument sanity)`; asserted in `tests/wtft-issue-149-uncounted-billables.test.ts` over a synthetic log + transcript pair | pass **on synthetic fixtures only** (#256). The criterion as originally worded ("every session") is false in general — see §1.4/§3.2, #176 and #282. The scope limit is the finding, not a weakening of the test. |
| **V2b** | *(added 2026-08-14, #256)* A Claude Code counter RESET — cumulative `total_cost_usd` restarting mid-session — is recorded as exactly one dip of exactly the cost it dropped, and is **not** reported as a step. | synthetic fixture whose third status record carries only its own turn's cost; asserts `dips.length === 1`, `dips[0].usd` to 1e-9, `dips[0].at`, and `steps.length === 0` | pass. This is the shape `d971ae4a` has on this host: −$20.906723, landing on exactly the cost of the next turn (#282). Reset ≠ invisible spend, and conflating the two would have made a $20.91 instrument artifact look like a $20.91 finding. |
| **V2c** | *(added 2026-08-14, #256)* `negativeSteps` and `dips` never disagree, and a clean session records neither. | same lagged fixture as V3 | pass. Guards the count-vs-record split that let the $20.91 dip stay invisible while the tally knew about it. |
| **V3** | Alignment is by usage, not timestamp: a synthetic transcript whose entries are written 5 s *after* the status record that bills them still yields residual 0. | test fixture with deliberately lagged timestamps | pass |
| **V4** | An injected invisible call (status cost advances with no matching transcript usage) is detected as exactly one step of exactly that size. | test fixture; assert `steps.length === 1` and `steps[0].usd` to 6 dp | pass (injected $0.157782, the magnitude measured on `ee53e779`, recovered to < 1e-9) |
| **V5** | `scanUncountedBillables` counts a Claude Code `system`/`compact_boundary` as one compaction. | unit test with a synthetic Claude Code JSONL | pass — fixture pairs the boundary with its `isCompactSummary` user entry and asserts the count is 1, not 2 |
| **V6** | `scanUncountedBillables` counts a Claude Code `system`/`away_summary` as one recap. | same | pass — same fixture asserts a sibling `system`/`turn_duration` is **not** counted (§5 "roads not taken": only ~55% of turn boundaries coincide with spend) |
| **V7** | `scanUncountedBillables` counts a Pi `type: "compaction"` entry as one compaction, and does **not** double-count it via the existing control-signal path. | unit test with a synthetic Pi JSONL; also assert the existing `compactionTokensBefore` stamp still lands | pass — `compactionTokensBefore === 50000` still lands on the following interaction |
| **V8** | `renderTokenSummary` emits an `UNCOUNTED` line naming both counts when either is non-zero, and emits nothing new when both are zero or the argument is omitted. | string assertions on the rendered output | pass, at both levels: `renderUncountedBillables` directly (singular/plural, only non-zero classes, `""` for all-zero and for `undefined`) and through `renderTokenSummary` |
| **V9** | No cost number changes: `renderTokenSummary`'s TOTAL for a fixture is byte-identical with and without the `uncounted` argument. | assert the TOTAL row is unchanged | pass, and additionally that the block is *appended*, never interleaved |
| **V10** | Existing compaction behaviour is untouched: `tests/wtft-compaction-tracking.test.ts` passes unmodified. | run that suite | pass, unmodified — and 43 other suites with it |

**Typecheck.** `bun run typecheck` is red with 2 × TS7016 in `bin/serve.ts` and
`extensions/lib/serve/process.ts`, both pointing at `extensions/lib/serve/cloudflare.js`.
Verified byte-identical to `main` @ `ad91cdc` — pre-existing baseline debt on a file this
branch does not touch, already tracked as **#168** ("typecheck is red on clean main — and
nothing gates it"). Not fixed here: Step 5 forbids production-code changes, and the fix is
`serve`'s, not `wtft`'s.

---

## 9. Reconciliation record (Step 5)

Pass performed 2026-08-10T17:20Z against the code at `f67425c` (Code Approved). Scope was
**file-level**: every file the branch touched was audited whole, plus every readable surface
that describes them — `docs/manifests/wtft-cmd.json` (drives `--help`, `--why` and the HTML
docs), `docs/adding-a-harness.md`, `docs/EXT_WTFT.html`, `CONTEXT.md`, module docstrings,
test header comments, and the rendered CLI output itself.

Two passes were run; the second found nothing new.

| artifact | claim it made | contradicted by | test-covered? | action |
|---|---|---|---|---|
| `docs/adding-a-harness.md` §2 | `HarnessParseAdapter` has exactly three methods | `extensions/lib/harness/types.ts` — a fourth, optional `readUncountedBillable` | yes, `wtft-issue-156-harness-seam` proves an adapter without it stays valid | **fixed** — method added to the interface block with an "optional (#149)" marker and a bullet stating the first-match-wins rule, the "omit it and your harness reports no blind spot" contract, and the 4.72% motivation. An omission, not a false statement: a harness author reading it concluded the method did not exist. |
| `docs/manifests/wtft-cmd.json` `--tokens` | `--tokens` prints "a per-model token summary table with utilization" — full stop | `bin/wtft.ts` also prints an UNCOUNTED line under `--tokens`; verified live against `ee53e779` (`UNCOUNTED  3 recaps …`) | yes, V8 | **fixed** — flag description now names the UNCOUNTED line, that subagent transcripts are included, and that it is deliberately not in TOTAL |
| `docs/manifests/wtft-cmd.json` `why` | nine scenarios, none explaining why TOTAL reads lower than the harness's own counter — the single most likely question this feature provokes | §5's chosen fork exists precisely to answer it | partly — V8 covers the wording, nothing covers the manifest | **fixed** — added a `why` scenario with a demo captured from real output. Also states the watch-mode limitation, which no user-facing surface said anywhere. |
| spec §6.4 + "Deliberately not in scope" | `wtft-daemon.mjs` and `serve.mjs` "both bundles carry the new exports … because they inline the whole of `bin/wtft.ts`" | grep of the built bundles: only `bin/wtft.mjs` has them; `wtft-daemon.mjs` has only the two adapters' `readUncountedBillable`; `serve.mjs` is untouched by this branch | no — no suite asserts bundle contents | **fixed** — replaced with the verified contents, and the consequence spelled out: wiring watch mode later is a real change in two bundles, not a one-line call. `reconciled-against-untested`. |
| spec §6.2 | wtft-parser gains 1 function + 1 interface | code exports 4 functions + 1 interface (`new`/`add`/`readUncountedBillableClass`/`scan`) | yes — every one is imported by name in the test suite | **fixed** — full signature list, plus why each is public and the never-throws contract on `scan` |
| spec §6.4 | (silent) | `renderTokenSummary` had to be added to `bin/wtft.ts`'s explicit re-export block or Bun tree-shakes it out of `bin/wtft.mjs` — a pre-existing symbol, used internally, never reachable from the bundle | yes, by construction: the test imports it and failed until the export landed | **fixed** — documented as a packaging fact of the seam that will bite the next test that imports an existing helper |
| spec §1 | "none uses Task subagents — zero `isSidechain` entries … across all seven transcripts" | `e0d2ec4b` now has 18 subagent transcripts (`discoverSubagentSessionFiles`) | yes, and it is why V1 skips such sessions | **fixed** — every §1 figure is now stamped *as of 2026-08-10T11:00Z* and flagged as a snapshot over live, growing logs |
| spec §1.1 / §3.2 | "0 downward steps across all 7 sessions" | Step-5 re-run: 6 downward steps, all on `e0d2ec4b` | yes (V1/V2 scope) | **fixed** — new §1.4 records the re-run side by side; §3.2 gains an explicit "where it is not sound" and the practical rule that a non-zero `negativeSteps` is an out-of-scope signal, never a finding. Filed as **#176**. |
| spec §2(a) | cites `wtft-renderer.ts:1675-1684`, `pi/parse.ts:97-98`, `claude-code/parse.ts:93` | this branch's own edits shifted all three | no | **fixed** — now `1683-1694`, `98-99`, `94`. (Line-number citations are inherently fragile; kept because §2 is an argument about specific code, and marked "post-branch".) |
| spec §7 | next step is "log a session that uses Task subagents, re-run the harness" | that was done, and the run was unsound — so the step was never sufficient | n/a | **fixed** — next step re-ordered: #176 first, a578's shape second. #149 stays open, now with a sharper reason than "not measured yet". |
| `research/…/paired-window-audit.mjs` header | "Measured across five logged sessions, R has ZERO negative steps" — stated as a property of the instrument | the subagent case | yes | **fixed** — split into "where it is validated" and "where it is not", with the mechanism explicitly *not* named (naming one would repeat the error the SAWTOOTH paragraph two lines above documents) |
| `tests/wtft-issue-149-…test.ts` header | "Two halves: V2–V4 … V5–V10" | the file also contains a V1 group | n/a (it is the header) | **fixed** — three groups, with V1's machine-dependence and its skip rule stated in the header rather than only in an inline comment 170 lines down |
| `extensions/lib/wtft-parser.ts` `@description` | module "extracts token usage and cost per assistant message, and classifies interactions"; neutral vocabulary is "AssistantTurn / ParsedBlock / ControlSignal" | it now also runs a scan producing *no* interactions, over a fourth vocabulary type | yes, V5–V7 | **fixed** — both sentences updated |
| `extensions/lib/wtft-renderer.ts` `@description` | "Builds visual output from parsed Interaction arrays" | `renderUncountedBillables` takes no Interaction array | yes, V8 | **fixed** — called out as the one renderer whose input is not interactions, and the only output reporting spend wtft cannot price |
| `docs/agents/tool-conventions.md` | "Manifest `why` entries have three fields" | the shared help renderer (`extensions/lib/merge/help.ts:44-45`) also renders a fourth, `demo` — used throughout `wtft-cmd.json`, including the entry added by this pass | no | **fixed** — fourth field documented as optional, with the ANSI-escape convention (written `\u001b[…m` in the JSON, never a raw control byte) and the rule to paste real output rather than invent it. Not a file this branch touched, but it is the doc that governs the manifest this branch edits, and it would have misled the next author. |
| `docs/agents/build-and-toolchain.md` | states the GENERATED rule and that "tests must run against the built `.mjs`", and stops there | the two rules together produce a failure it never mentions: a suite cannot import a symbol missing from `bin/wtft.ts`'s explicit `export { … }` block, even one the file itself uses | yes — the Step-4 failure was exactly this | **fixed** — new subsection with the real error text and the `renderTokenSummary` case. The most reusable finding of this branch; it will recur for any suite reaching for an existing helper. |
| §4 counts | step counts stated without scope | they exclude `e0d2ec4b`'s later, unsound steps | n/a | **fixed** — snapshot + non-subagent scope stated inline; `ee53e779`'s nine-step table re-verified byte-identical at Step 5 |
| `docs/EXT_WTFT.html` | — | audited; describes the bar chart, cache-miss divider and pricing tables, and never enumerates `--tokens` summary rows, so the UNCOUNTED line contradicts nothing there | n/a | **no change**. Its own separate staleness is already tracked as #169/#167. |
| `CONTEXT.md` | — | has only a `Language — Serve` section; no WTFT glossary exists yet to contradict | n/a | **no change** — a `Language — WTFT` section is #166's scope, and "uncounted billable" belongs in it when written |
| `bin/*.mjs` | — | rebuilt from `.ts` at Step 4 and committed; re-verified at Step 5 that `bin/wtft.mjs` exports all five new symbols and the live CLI prints the line | yes, end to end | **no change** |

### Verified unchanged (the point of the exercise)

No production code was modified in this step. `git diff f67425c..HEAD` touches only
`docs/` (spec, manifest, `adding-a-harness.md`, `tool-conventions.md`,
`build-and-toolchain.md`), a `.mjs` module
*comment* under `research/`, a test *header comment*, and two `@description` blocks in
`extensions/`. Both `extensions/` edits are JSDoc — no statement, expression or signature
changed, and no `bin/*.mjs` needed rebuilding (the manifest is read from disk at runtime,
not bundled). `bun run test` re-run after the edits: **44 suites, 44 passed, 0 failed**.

### Left open deliberately

- **#149** — see §7. A 4.72% non-subagent measurement is not the ~11% the issue asked about,
  and the one subagent measurement available is from a run the instrument flagged as broken.
- **#176** (new) — usage alignment on subagent-bearing sessions. Blocks step 2 of §7.
- **#168** — repo-wide red typecheck, pre-existing, `serve`-side.
- **Watch-mode UNCOUNTED line** — §6 "Deliberately not in scope", now with the accurate
  statement of what wiring it would actually cost.
