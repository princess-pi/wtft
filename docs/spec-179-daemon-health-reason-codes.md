# Spec — #179: daemon health reason becomes a code, not a sentence

**Issue:** [#179](https://github.com/duppypro/princess-pi-tools/issues/179)
**Status:** Code and Spec Approved
**Related:** #124 (the grace window this protects), #165 (where the coupling was found), #167

---

## 1. The bug, precisely

`DaemonStatus.reason` was typed `string` and carried a human sentence. Two different
consumers read it, for two different purposes (line numbers are pre-#179 positions):

| Site | Reads `reason` as | Consequence of a reword |
|---|---|---|
| `wtft-cli-shared.ts:371` | **a control token** — `health.reason === "daemon not found"` gates #124's 5 s startup grace window | branch goes always-false; widget shows `not found` for the first 5 s of every daemon start — the exact #124 regression |
| `wtft-daemon-lib.ts:497` | **display text** — `status.reason \|\| "unknown"` is printed to the user | nothing; it is copy |

One field, two contracts, opposite requirements. The control reader needs the string
frozen forever; the display reader wants it free to improve. #165 renamed both sides
together and only a manual `rg` stood between that sweep and a silent regression.

This is the **Agent-First Output** failure in miniature: state inferred from prose
written for humans. The test from `~/git-projects/CLAUDE.md` — *would the producer
consider rewording it a breaking change?* — has no answer here, because the producer is
doing both jobs at once.

## 2. Direction — split the two jobs

Not "freeze the sentence" (a union of the current display strings would do that, and
would make `tsc` catch a typo'd comparison — but it keeps the copy load-bearing forever,
so the next person who improves the wording is still writing a breaking change).

Instead: **`reason` becomes a stable machine code; display text is derived from it.**

```
producer  →  reason: DaemonHealthReason   (contract — never changes)
                     │
                     ├─→ control flow      compares codes
                     └─→ DAEMON_REASON_TEXT[code]   (copy — free to change)
```

The code is the API. The sentence is a rendering of it. Reword the sentence and nothing
breaks; that is the whole point.

### The contract

```ts
/**
 * Stable machine-readable daemon health codes. THIS is the contract — control flow
 * compares these, never the rendered text. Adding a member is a feature; renaming or
 * removing one is a breaking change. The human sentences in DAEMON_REASON_TEXT are
 * free to change at any time precisely because this union exists.
 */
export type DaemonHealthReason =
	| "not-started"      // no daemon spawned for this session yet
	| "starting"         // spawned, inside the #124 startup grace window
	| "waiting-session"  // spawned, session .jsonl not created yet
	| "not-found"        // no live PID and no heartbeat on record
	| "idle-timeout"     // exited after idling out (lastHbTime carries when)
	| "restart-failed";  // respawn attempted and did not come up
```

```ts
/** Display copy for each code. Change freely — no control flow reads these. */
export const DAEMON_REASON_TEXT: Record<DaemonHealthReason, string> = {
	"not-started":     "daemon not started",
	"starting":        "starting...",
	"waiting-session": "waiting for session .jsonl...",
	"not-found":       "daemon not found",
	"idle-timeout":    "idle timeout",
	"restart-failed":  "restart failed",
};
```

`DaemonStatus.reason` narrows from `string` to `DaemonHealthReason | undefined`. A
typo'd comparison — `health.reason === "daemon not found"` — now fails `tsc --noEmit`
with *"This comparison appears to be unintentional"* instead of compiling to a
permanently-false branch.

### What this removes

`DaemonStatus` carried two booleans that existed only because `reason` could not be
switched on:

- `starting?: boolean` — true exactly when `reason === "starting"`
- `waiting?: boolean` — true exactly when `reason === "waiting-session"`

Both are deleted. `renderDaemonStatus` switches on the code directly. Two derivable
fields, two chances for them to disagree with `reason`, gone.

`daemonStopReason` (the widget's stop-reason plumbing, `wtft-daemon-lib.ts:767/799/831`)
retypes from `string` to `DaemonHealthReason | null`, so the `"restart failed"` literal
at :831 joins the union rather than being a seventh unregistered sentence.

## 3. Why this is the house example of Agent-First Output

Worth stating plainly, because the shape recurs:

1. **The structured surface is not an afterthought bolted beside the prose** — it is the
   source, and the prose is generated from it. A `--json` mode that re-derives its
   values from a display string has not solved this problem.
2. **The contract is enforced by the compiler, not by discipline.** `rg` across the repo
   is what protected #124 last time. A union type is the same guard, run automatically,
   on every build, by a tool that cannot forget.
3. **It makes the copy cheap.** Before, improving `"daemon not found"` required knowing
   about a comparison in another file. After, it is a one-line edit to a lookup table.
   Freeing the prose is a *result* of giving the agent a contract, not a trade against it.
4. **Zero reasoning steps to consume.** `"not-found"` needs no parsing, no
   case-normalisation, no substring match, and never carries an ellipsis or a filename.

The general rule this instantiates: **when one field serves both a program and a person,
it is serving neither. Split it, and derive the person's half from the program's half.**

## 4. Scope

**In:**

- `extensions/lib/wtft-daemon-lib.ts` — the type, the text table, `daemonReasonText()`,
  `renderDaemonStatus`, both `checkDaemonHealth` return sites, and the `daemonStopReason`
  plumbing (now `DaemonHealthReason | null`).
- `extensions/lib/wtft-cli-shared.ts` — all four `getDaemonStatus` return sites and the
  grace-window comparison.
- Rebuild `bin/wtft.mjs` / `bin/wtft-daemon.mjs` from source (generated).
- `CONTEXT.md` — a `Daemon health reason` entry in `Language — WTFT`.
- `docs/EXT_WTFT.html` — index row for this spec. Not anticipated when this section was
  first written; `tests/wtft-doc-spec-index.test.ts` failed the run until it was added,
  which is the gate doing its job.

**Out:** the daemon's own `shutdown("idle timeout")` / `shutdown("n")` argument in
`bin/wtft-daemon.ts` — a separate wire vocabulary written to the tag file, and narrowing
it is its own cycle. Noted here so the next reader does not mistake the omission for an
oversight.

## 5. Verification

All of the below live in `tests/wtft-179-daemon-health-reason.test.ts` (V1–V4) and the
declared runner (V5). **Result: 17 assertions, 0 failures; full suite 53/53.**

| # | Check | How it was actually done | Result |
|---|---|---|---|
| V1 | No reason sentence survives in control flow | Scans the four consumer sources for `=== "<sentence>"` / `!== "<sentence>"` against every value in `DAEMON_REASON_TEXT`, exempting the table's own declaration. Derived from the table rather than a hardcoded list, so a sentence added later is covered without editing the test. | pass |
| V2 | A typo'd comparison fails typecheck | Negative-control probe in the style of `tests/typecheck-gate.test.ts`: writes `bin/__reason_code_probe__.ts` comparing `status.reason` to `"daemon not fuond"`, asserts `bun run typecheck` exits non-zero **and** that the diagnostic names the probe. Removed in a `finally`. | pass |
| V3 | **The #124 grace window actually works** | Points `ensureDaemonRunning` at a stand-in daemon (`process.exit(0)`, claims no PID file) so `checkDaemonHealth` reports `not-found` for the whole run — the exact state the window exists to mask. Asserts `waiting-session` with no session file, `starting` with one, and `not-found` after 5.2 s. | pass |
| V4 | Display text unchanged for the user | Pins all six code→sentence pairs, asserts the table has no missing member, asserts `undefined` degrades to `"unknown"` rather than throwing, and asserts the deleted `starting?:`/`waiting?:` booleans have not crept back. | pass |
| V5 | Existing suites green | `bun run test` — 53 suites. | 53/53 |

**Why V3's stand-in daemon, not a real one.** The spec draft said "spawn a daemon." A real
daemon races the assertion to `alive`, and a test that sometimes passes for the wrong
reason is worse than no test. The stand-in pins the health state deterministically and
still exercises the real `ensureDaemonRunning` → `getDaemonStatus` path.

**V3 was shown to go red.** Changing the grace-window comparison to a different valid code
(`"idle-timeout"`) makes 4 of V3's assertions fail, with the indicator rendering
`● daemon not found` — the literal #124 symptom. A guard never observed failing is not
known to be a guard (the lesson of #168, restated here because it is what makes V3 worth
more than V1 and V2 combined: V1/V2 protect the *representation*, V3 protects the
*behaviour*, so it survives any future change to how the reason is represented).

## 7. Landed after #181 — and #181 applied this ruling forward

This branch merged into `main` behind [#181](https://github.com/duppypro/princess-pi-tools/issues/181),
which is the same family of bug one layer out: `serve` inferring process *identity* from a
`ps aux` substring. One conflict, in `docs/EXT_WTFT.html` — both branches added a spec-index
row after `spec-168`. Both rows kept; nothing semantic overlapped, and the full suite is
54/54 on the merged tree.

Worth recording that the ruling travelled rather than staying local. #181's `serve/kill@1`
schema emits `"reason": "not-confirmed-dead"` — **a code, not a sentence** — because this
spec's §3 rule was already written when that surface was authored:

> when one field serves both a program and a person, it is serving neither. Split it, and
> derive the person's half from the program's half.

Applied at the point of writing costs nothing. Retrofitted, as here, it costs a spec, a
migration of six call sites, and a test to prove the grace window still holds. That
difference is the argument for the standard, stated in the only currency that matters.

---

— 👑π🐱 Princess Pi
