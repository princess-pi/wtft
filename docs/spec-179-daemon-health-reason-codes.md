# Spec — #179: daemon health reason becomes a code, not a sentence

**Issue:** [#179](https://github.com/duppypro/princess-pi-packages/issues/179)
**Status:** Spec Draft
**Related:** #124 (the grace window this protects), #165 (where the coupling was found), #167

---

## 1. The bug, precisely

`DaemonStatus.reason` is typed `string` and carries a human sentence. Two different
consumers read it, for two different purposes:

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

`DaemonStatus` currently carries two booleans that exist only because `reason` could not
be switched on:

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

- `extensions/lib/wtft-daemon-lib.ts` — the type, the text table, `renderDaemonStatus`,
  the `checkDaemonHealth` return sites (:677, :686), the `daemonStopReason` plumbing.
- `extensions/lib/wtft-cli-shared.ts` — the `getDaemonStatus` return sites (:345, :360,
  :373, :375) and the grace-window comparison (:371).
- Rebuild `bin/wtft.mjs` / `bin/wtft-daemon.mjs` from source (generated).
- `CONTEXT.md` — a `Daemon health reason` entry in `Language — WTFT`.

**Out:** the daemon's own `shutdown("idle timeout")` / `shutdown("n")` argument in
`bin/wtft-daemon.ts` — a separate wire vocabulary written to the tag file, and narrowing
it is its own cycle. Noted here so the next reader does not mistake the omission for an
oversight.

## 5. Verification

| # | Check | How |
|---|---|---|
| V1 | No bare reason literal survives in control flow | `rg '=== "daemon not found"'` and friends return nothing |
| V2 | A typo'd comparison fails typecheck | negative-control probe in the style of `tests/typecheck-gate.test.ts` — a scratch file comparing `reason` to `"daemon not fuond"` must make `tsc --noEmit` exit non-zero |
| V3 | **The #124 grace window actually works** | spawn a daemon with no session file yet, assert `getDaemonStatus()` returns code `starting` (or `waiting-session`) — *not* `not-found` — inside the first 5 s, and `not-found` after it. This test does not exist today, which is why the coupling was invisible. |
| V4 | Display text unchanged for the user | `renderDaemonStatus` output strings byte-identical to before for every code |
| V5 | Existing suites green | `bun run test` — `wtft-daemon-lifecycle`, `typecheck-gate`, `build-staleness-gate` in particular |

V3 is the test the issue asks for and the one that has real value: it exercises the
behaviour, so it survives any future refactor of *how* the reason is represented.

---

— 👑π🐱 Princess Pi
