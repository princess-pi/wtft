# WTFT

Where The F\*\*\*ing Tokens?! — the cost-auditing widget and CLI for coding-agent sessions.

> **Glossary provenance.** This `Language — WTFT` glossary was ported from
> `princess-pi-tools`'s `CONTEXT.md`, removed there when wtft was extracted (#584). Bare issue
> numbers below refer to **princess-pi-tools** issues (the source repo); wtft's own issue
> numbering starts fresh. Where the glossary names a file, it names this repo's copy.

## Language — WTFT

> **Daemon vs. log parser — two registers, not a winner.** These named the same thing in two
> layers: `daemon` throughout the code (131× in `extensions/lib/wtft-daemon-lib.ts`, 12 filenames),
> `log parser` in user-facing text and, as it turned out, in runtime strings and comments too.
> The first ruling (#162, 2026-08-09) picked **daemon** outright and put `log parser` on the
> `_Avoid_` list. **Reversed 2026-08-10** by Duppy: a single word could not serve both a reader
> meeting the process for the first time and a variable name. The standing ruling is the
> two-register rule in the `Daemon` entry below — **"log parser daemon"** to explain, **"daemon"**
> to refer. What stayed from the first ruling: bare **"log parser"** is still avoided.
>
> *Why the reversal is worth recording.* The original count was taken over docs only, so the
> ruling was made against 13 occurrences when the real surface was 69. `wtft --cleanup` printing
> `Cleaned up 0 log parser(s).` — a runtime string no issue's scope had covered — is what exposed
> both the miscount and the fact that one word was doing two jobs. The sweep is
> [#165](https://github.com/duppypro/princess-pi-tools/issues/165). See
> `docs/spec-160-161-162-wtft-spec-surfaces.md` §4.1 for the original count table and its
> correction.

**Daemon**:
The persistent background process (`bin/wtft-daemon.ts` / `wtft-daemon.mjs`, driven by
`extensions/lib/wtft-daemon-lib.ts`) that watches a session's `.jsonl` file, classifies each
interaction, and writes pre-computed entries to a tag file so the CLI and Pi widget don't
re-parse the whole log on every read. Spawned on `session_start`, auto-revived on idle-timeout
death, auto-replaced on a version bump. Health is exposed via `checkDaemonHealth()` and rendered
via `renderDaemonStatus()`.

*Two registers, one concept.* Say **"log parser daemon"** in high-level user-facing prose — doc
headings, the first mention in any `--help` or manifest description, anywhere a reader is meeting
the process for the first time. Say **"daemon"** as the shorthand everywhere the referent is
already established: code, variable and file names, inline comments, terse operational output
(`Cleaned up 3 daemons.`), and secondary explanations. The long form teaches what it does; the
short form is what you call it once you know. Neither is a synonym to be swapped freely — pick by
whether the reader needs teaching.

*Tie-break, when "first mention" is ambiguous.* Scope it to **the surface a reader sees in one
screen**, not to the file. A `--help` block whose header already says "Log parser daemon" has
established the referent, so its flag lines say "daemon". A manifest `desc` string is
independently addressable — `--why` and per-flag lookups render it with no header above it — so
each one carries the full form itself. Same rule, opposite outcomes, because the unit of reading
differs.

*When the long form does not fit.* Fixed-width surfaces — ASCII box diagrams, aligned help
columns, the title-line status indicator — take the shorthand, and the surrounding prose does the
teaching. Never widen a box or truncate a word to force the long form in. `wtft-daemon` in a
diagram needs no gloss at all when the section heading above it already says "Log parser daemon";
the parenthetical `(log parser)` that used to sit there existed only to bridge two unreconciled
names, and reconciling them retired it.
_Avoid_: bare "log parser" (always promote to "log parser daemon"), watcher, background process,
session parser

**Daemon health reason** (the code) / **status text** (the sentence):
Two different things, deliberately (#179). A **health reason** is one of six machine-readable
codes on the `DaemonHealthReason` union — `not-started`, `starting`, `waiting-session`,
`not-found`, `idle-timeout`, `restart-failed`. It is the contract: control flow compares codes,
and `tsc` rejects a typo'd comparison. **Status text** is what the user sees, looked up from
`DAEMON_REASON_TEXT` by `daemonReasonText()` and rendered only inside `renderDaemonStatus()`.
Reword the text freely — nothing reads it. Renaming a code is a breaking change.

Say "health reason" (or "the code") when you mean the value a program branches on; say "status
text" when you mean the words in the indicator. They were one `string` field until #179, which is
what let a rename in #165 nearly regress #124's startup grace window.
_Avoid_: using "reason" alone for the displayed sentence; "status string" for the code

**Interval**:
The user-specified size+unit that decides how interactions are grouped — the `-i, --interval`
value (e.g. `4h`, `5t`), parsed by `parseInterval()` into an `IntervalConfig`. An interval is a
*request*; a bin (below) is the concrete result of applying one.
_Avoid_: Bucket (see the Bin/Bucket split below), window, period

**Bin**:
The concrete time-or-turn slot an interaction is grouped into, computed by `getBinInfo()` from
an `IntervalConfig` and a timestamp — e.g. "the `22:00` bin" or "turn-bin `000010`". Binning
happens identically regardless of render mode; every render bins first, then decides how to
display each bin's total.
_Avoid_: Bucket — reserved for the render mode, not the grouping unit. This split is intentional:
`getBinInfo()` never returns anything the code itself calls a "bucket," but comments and prose
sometimes use "binned"/"bucket" as loose synonyms for this concept. They are not the same word
in the type system (`IntervalConfig`, `mode: "bucket" | "cumulative"`) and should not be treated
as interchangeable in new prose.

**Bucket (mode)**:
One of the two render modes, set by `-b/--bucket` (the other is `-c/--cumulative`, default):
shows each bin's own discrete total rather than a running sum. `mode: "bucket" | "cumulative"`
in `wtft-renderer.ts`/`wtft.ts`. Not a grouping concept — see Bin above. Also overloaded once,
harmlessly: `wtft-renderer.ts:1292` has an unrelated local variable named `buckets` (a `Map`
used only for same-column marker tie-breaking inside *cumulative*-mode rendering) — it is not
the `-b/--bucket` flag and should not be confused with it when reading that function.
_Avoid_: Bin (see above), interval

**Cumulative (mode)**:
The default render mode (`-c/--cumulative`): each bin's bar shows the running sum of cost up to
and including that bin, not just that bin's own total. Guarantees monotonically non-decreasing
bar widths (#106).
_Avoid_: Running mode, total mode

**Session**:
One coding-agent conversation's append-only `.jsonl` log — the unit wtft parses, classifies, and
renders costs for. Identified by a UUID-bearing basename (Claude Code) or a
timestamp-prefixed UUID basename (Pi); see `isSessionIdBasename()`.
_Avoid_: Chat, conversation, log (ambiguous with "tag file", below), transcript

**Sidechain**:
A subagent's own interaction stream within the *same* session file — marked
`Interaction.isSidechain`, excluded from prevCtx recache-signature tracking because it does not
share the parent turn's context window. Distinct from a subagent session (below): a sidechain is
inline entries in one file; a subagent session is a separate file.
_Avoid_: Sub-thread, branch, fork

**Subagent session**:
A separate `.jsonl` log for a spawned subagent, stored under `<session-id>/subagents/` (Claude
Code). wtft recursively discovers and blends these chronologically into the parent's timeline
(Recursive Subagent Rollup). Distinct from a sidechain (above), which lives inline in the parent
file rather than as its own file.
_Avoid_: Child session, nested session

**Tag file**:
The per-session output file the daemon writes classified entries to:
`wtft-tags/<session>.wtft-tag.v{N}.jsonl`. One tag file per source session, versioned so a
daemon upgrade can detect and replace a stale one. Read by `readClassifiedTagFile()`.
_Avoid_: Cache file, index file

**Tags dir**:
The `wtft-tags/` directory itself — one per project/session root, holding every tag file for
sessions discovered there. `wtft-parser.ts` explicitly excludes it from session discovery
("`wtft-tags` is our own output") so the daemon never treats its own writes as a session to
parse.
_Avoid_: Tag cache, output dir

**Surge (window / pricing)**:
DeepSeek's peak-valley pricing: `input`, `output` and `cacheRead` are billed at 2× inside
certain UTC hour ranges on weekdays. (`cacheWrite` is never surged — for DeepSeek it is 0
anyway.) The schedule is `DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES` in `extensions/lib/wtft-cost.ts`,
weekday-gated from `DEEPSEEK_WEEKEND_OFFPEAK_FROM`. **The hours are deliberately not written
here** — read them from those constants, or from the generated
`docs/manifests/wtft-pricing.json`. They used to be re-typed in code and in prose across the
repo, with nothing that failed when a change missed one, and one prose copy said "as of July
2026" nine days after the rates moved (#495). No count is given, because every count of them
written so far has been wrong; `grep` is the authority.
`getSurgeLocalHours()` maps the schedule onto display-timezone hours by asking
`getDeepSeekPeakMultiplier` what each hour costs, so no hour is coloured differently from the
way that hour is billed. It resolves the day containing the instant passed to it, and the
renderer passes `now` — so the bar describes today while the bins under it may be older
(#496). `checkSurgeProximity()` asks it only whether the day surges at all; the
inside/approaching/ending decision is minute arithmetic over the same shared window constant.
Rendered as the SURGE Timeline badge and orange segments.
_Avoid_: Peak pricing, rush hour, premium window

**Rate card (DeepSeek)**:
The published per-1M quad. A `MODEL_PRICING` entry's unconditioned rates are the **off-peak**
card, which is what DeepSeek publishes as "half of the peak rates". `input` is the
**cache-MISS** rate and `cacheRead` the **cache-HIT** rate — the Anthropic-format endpoint
reports no cache-creation tokens and bills a miss as plain input, so `cacheWrite: 0` is correct
rather than missing. A superseded card lives on as a `dateTiers` window so historical sessions
keep pricing right; `DEEPSEEK_RATE_CARD_FROM` (2026-08-16T16:00Z) is the current cutover.
Two consequences worth stating, because both are silent when wrong:
`deepseek-v4-flash-vision-exp` carries **no** `dateTiers` — it was released after that cutover,
so an old-card window for it would be a fiction nothing can reach; and `lookupModelPricing`
resolves **longest registry key first**, because `deepseek-v4-flash` is a substring of
`deepseek-v4-flash-vision-exp` and insertion order would otherwise decide a pricing question.
The same `dateTiers` field also carries `claude-sonnet-5`'s intro window (#148).
_Avoid_: List price, tariff. Also an **unqualified** "base rate" for a DeepSeek quad — say
off-peak or peak, because for DeepSeek the two differ by 2x and "base" names neither. ("Base
rates" is fine where the model has no surge, and where the very next words say which card is
meant, as in `wtft-cost.ts`'s registry comments.) Narrowed in #495: the ban was written
absolute, and then the same branch used the word three times legitimately while dropping it
from the one surface — the rendered table — where a reader had no disambiguating sentence.

**Priced model / unpriced model** (#140, narrowed #22):
A model is **priced** when `isModelPriced` is true: a `MODEL_PRICING` entry resolves for it
(built-in or user-merged), or one of `calculateClaudeCost`'s legacy hardcoded rate branches
(`haiku`, `opus`) applies. The tests run in `calculateClaudeCost`'s own order, `deepseek`
first, so an id carrying both words — `deepseek-opus` — is unpriced, matching the branch it
actually reaches. Everything else is **unpriced** — its cost is a fallback figure,
marked `?` in the per-model table and announced once per run on stderr. A **sibling guess** is
NOT priced: a DeepSeek id that matches no registry key is costed by borrowing the nearest
sibling's card, and that was called priced until #22 B, which suppressed the warning for
exactly the models it exists for (a model newer than the registry). `describeFallbackPricing`
names which fallback a given unpriced model took, so the warning and the legend never claim a
rate the run did not use.
_Avoid_: "unknown model" for the unpriced class (a model can be perfectly well known and still
carry no card); "default rates" as an umbrella (there are two defaults — the Sonnet quad and
the DeepSeek sibling guess — and naming the wrong one is the drift #22 B fixed).

**Category** (the classification vocabulary):
The `Category` union (`extensions/lib/wtft-parser.ts`) an interaction is classified into:
`plan`, `spec`, `research`, `web`, `grep`, `code`, `tests`, `git`, `agents`, `prompt`,
`compaction`, `interrupted`, `overhead`, `other`. Display labels differ from the type names for
the Phase-3 overhead trio: `compaction` → **Cmpct**, `interrupted` → **Waste**, `overhead` →
**Ovrhd** (`CATEGORY_STYLE` in `wtft-renderer.ts`). Use the type name in code/tests, the display
label only in UI-facing prose.
_Avoid_: Type, tag, class, bucket (see Bin/Bucket — a category is not a bin)

**Overhead vs. waste vs. compaction** (the Phase-3 trio, #52):
Three distinct causes of cost that isn't the model doing requested work, each its own category:
- **Overhead** (`Ovrhd`) — a full-context recache: the 1h cache tier rewrote, driven by a
  recache signature the parser detects from raw usage.
- **Waste** — a turn the user killed (`interrupted: true`); its whole cost is discarded work,
  not overhead from re-priming.
- **Compaction** (`Cmpct`) — a turn immediately following a compact summary
  (`afterCompaction: true`); its cache-write component is specifically the compaction bill.
_Avoid_: Using "overhead" as an umbrella term for all three — each has a different cause and a
different fix; conflating them was the exact ambiguity #52 Phase 3 resolved.

**Thinking level**:
A *signal* — the model's current reasoning-depth setting, read from a harness event
(`thinking_level_change`) and carried on `Interaction.thinkingLevel`. Describes what happened.
_Avoid_: Thinking budget (see below — a different concept, not a synonym)

**Thinking budget**:
A *CLI input* — the `--thinking-budget <n>` flag, a token budget used only to compute a
utilization percentage in `--tokens`/`--by-model` output. Not read from the session; supplied by
the caller. Describes a ceiling to compare against, not what happened.
_Avoid_: Thinking level (see above)

**Token Budget** (the tool — not the `--thinking-budget` flag):
The Pi extension (`extensions/token-budget.ts`, command `/budget`) that budgets **velocity** —
tokens per minute (TPM) per model — to keep an agent from breaching its model subscription
quota. It intercepts provider requests, sums each model's recent TPM from the wtft tag files,
and when a TPM-limited model crosses its ceiling (`MODEL_QUOTA_REGISTRY`) it enforces a 40s
synchronous cooldown rather than letting the provider hard-fail. Models that are
concurrency-limited rather than TPM-limited (DeepSeek, short-code prefix `d`) redline the meter
for visibility but never cooldown. Canonical name is **Token Budget**; "TPM" survives only as
the *metric*, and "rate limiter"/"TPS" are retired (princess-pi/wtft#51 decision 1, spec-51).
Config: `~/.config/princess-pi-tools/token-budget.json`.
Distinct from **Thinking budget** (above) — that flag is a token ceiling the caller supplies
for utilization display; Token Budget is a live request-rate guard the extension enforces.
See `docs/spec-51-token-budget.md`.
_Avoid_: rate limiter, TPS, rate-limit tool, TPM-as-a-name (TPM stays, as the metric)


**Harness**:
The coding-agent runtime a session log came from — `pi` or `claude-code`, selected via
`--harness <pi|claude-code|auto>` (default `auto`). Determines which session-discovery and
parse adapter (`extensions/lib/harness/<id>/`) wtft uses. Not the same as "widget" (below) —
harness is about which agent produced the log; widget is about how wtft displays it.
_Avoid_: Agent, client, platform

**Widget**:
The persistent TUI panel wtft renders below the editor inside the Pi harness — auto-shown on
session start if config exists, toggled via `-S/--show` / `-H/--hide`. Distinct from the CLI
(below): the widget only exists inside Pi.
_Avoid_: Panel, sidebar (reserved for the `serve` tool's widget — `serve` is a separate tool, not part of wtft)

**CLI**:
Running `wtft` (or `./wtft`, or the npm-global install) directly from the host shell, outside
Pi — reuses the same classification engine as the widget but prints to stdout. Supports modes
the widget does not (`--other` histogram, `--watch`, `--json`). Refuses `-p/--pager`, which is
the widget's (see **Pager**).
_Avoid_: Standalone mode, binary (the binary is `bin/wtft.mjs`; "CLI" names the usage mode)

**JSON mode** (#26):
`--json` — the CLI's machine-readable mode. Writes exactly one JSON object (schema
`wtft/session@1`) to stdout and nothing else: no ANSI, no `3.6k` abbreviation, no chart.
Human prose goes to stderr and is repeated in the object's `notices[]`, where `code` is the
contract and `text` is disposable. Its numbers come from `computeSessionSummary`
(`extensions/lib/wtft-renderer.ts`), the same aggregation the `--tokens` table formats, so
the two cannot report different totals. Contract: `docs/spec-26-json.md`. CLI only — the
widget has no stdout to write an object to.
_Avoid_: Porcelain mode, machine mode, structured mode (the flag is `--json`; "JSON mode"
names the usage mode)

**Pager**:
`-p/--pager` — a fullscreen, interactive, scrollable TUI overlay for browsing expanded cost
history. A Pi-only feature, implemented in `extensions/wtft.ts` as a TUI overlay; it is not
available in the CLI, which refuses `-p` and suggests `wtft … | less -R` instead
(`bin/wtft.ts`). An earlier entry had this exactly inverted (#75).
_Avoid_: Scroll mode, viewer

**Watch mode**:
`--watch` (`-W`) — a companion-terminal mode that tails a session file and re-renders in
real-time as new interactions are logged, until `Ctrl+C`/`q`. Distinct from the widget's own
periodic refresh (which lives inside Pi); watch mode is a standalone CLI process meant to run in
a separate pane.
_Avoid_: Live mode, tail mode
