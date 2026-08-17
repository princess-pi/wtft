# Spec — #308: a session `.jsonl` that is not written *yet* is not "not found"

**Issue:** [#308](https://github.com/duppypro/princess-pi-packages/issues/308)
**Status:** Code Approved (tests green), spec reconciled
**Related:** #124 / #129 (daemon waits for the session file), #130 (startup reaper), #155 (moved ≠ gone), #179 (health codes)

---

## 1. The principle

> Anything that says "not found" must be a true fact. If the thing being looked for is
> known to have good reasons to lag, say *that* — a periodic "no data yet…" that keeps
> trying is a fact; "not found" is not.  — Duppy, 2026-08-17

The canonical lagging thing here is a Claude Code transcript. The session id — and so the
transcript path — is fixed at launch, but the first line lands only after the first *real*
prompt (not a `/command`) completes. Anyone who knows the path early (a `SessionStart` hook,
a statusline, `wtft -s <path>` fired at launch) was told the session did not exist.

## 2. What was wrong (pre-#308 positions)

| Site | Said | Truth |
|---|---|---|
| `bin/wtft.ts:322,344` | `does not exist as a file…` / `invalid or does not exist`, exit 1 | path is late, not missing |
| `bin/wtft.ts:398` | `sleep(500)` before `watchTagFile` | a guess standing in for a state the lib already checks |
| `wtft-daemon-lib.ts:1120-1128` | after 5 s: `did not create tag file within 5s. Is wtft-daemon installed?`, exit 1 | on a slow box: still starting; on a fast one: file already there |
| `bin/wtft-daemon.ts:494` (`reapAndWarn`, #130) | session path absent ⇒ "gone" ⇒ SIGTERM | absent ⇒ *never written yet* is the normal launch state. The reaper runs at every daemon's startup, so it killed the parked daemon **and itself** — the #124 `waiting-session` state was unreachable by any live daemon (verified: `KILLED PID …: session gone` in `~/.local/state/wtft/reap.log` on a fresh spawn against an absent path). |

## 3. What changed

1. **`isPendingSessionPath(p)`** (`wtft-cli-shared.ts`): absolute, `*.jsonl`, not a tag file. `wtft -s` accepts such a path when it does not exist. A relative fuzzy filter that matches nothing is still an error — that was never a fact.
2. **Non-watch:** if the session file is absent, print `Session log not written yet: <path>` + one line saying why and what to do, exit 0, no wait. A spawned daemon that already exited non-zero is reported with its code, not as "no data yet".
3. **Watch:** the tag-file wait is on state — tag present → watch; lease alive → wait; spawned child exited **and** no lease → error with exit code. Without a child handle (no caller today) a bounded 5 s ceiling remains, documented. The view renders `Waiting for session .jsonl to be written (first prompt not completed yet)...` while the transcript is absent. The 500 ms pre-sleep is gone.
4. **Reaper (`sessionIsGone`):** "gone" now requires evidence the session once existed — a classified line or a `_meta` offset in its tag file. Never reaps its own PID. `--cleanup` shares the predicate.
5. **Daemon:** `SESSION_WAIT_MAX_MS = 1 h` — a never-seen session parks the daemon for at most an hour (matches `ZERO_INTERACTIONS_AGE`); shutdown reason `session never written`. A session seen once and then removed still exits on the daemon's own `sessionExisted` knowledge. A later `wtft` run respawns for free.

## 3b. PR #309 review — what changed after the first cut

Two review rounds (macroscopeapp; every finding verified against the code before adoption):

- **Reader resolves the tag path, never assembles it.** `bin/wtft.ts` hand-built
  `<dir>/wtft-tags/<base>.wtft-tag.v<N>.jsonl`; after a #155 move the daemon adopts the
  *sibling* file, so the assembled path is one nobody writes — `--watch` sat on
  "Waiting for session data…" forever with a full tag one directory over. Non-watch now
  uses `getTagPath` (a stale-version tag is still data worth charting); `--watch` uses
  `getCurrentVersionTagPath`, the same resolver the daemon uses to pick its *writer*
  path, and re-resolves inside the wait loop, re-seeding both `allInteractions` and
  `lastReadOffset` from whichever file won.
- **"The daemon is running and waiting on it" is checked before it is said.**
  `awaitDaemonUp(sessionPath, child, ceilingMs)` polls state (no fixed delay):
  `up` ⇔ a live process holds the lease (`checkDaemonHealth().alive`) — the daemon writes
  its PID file before `initClassified()`, and this covers the singleton case where the
  child exits 0 because an older daemon owns the session; `dead` ⇔ child gone (exit code
  **or signal**) AND no lease, re-checked *after* the exit is observed (a concurrent daemon
  can claim the lease in the gap); `unknown` ⇔ ceiling hit with the child alive and
  nothing claimed — still exit 0, a slow box is not a failure. **A tag file is not
  proof:** tags outlive daemons (previous run, or a sibling-dir file the #155 lookup
  adopts) — measured: a stale tag under `/tmp` made a SIGKILLed stand-in read as "up".
  Both the pending-session branch and the "no data yet" branch route through it.

## 4. Verification

`tests/wtft-308-lagging-session.test.ts` (41 assertions, every wait a poll on a predicate):

1. non-watch on an absent path: exit 0, no `not found` / `does not exist` / `invalid`, states "not written yet", names the path, daemon holds the lease, file not created by the CLI
2. session written afterwards: the **same** daemon classifies it, second run renders bars
3. `--watch` on an absent path: waiting line renders, still running past the retired 5 s ceiling, no failure copy, chart renders once the file appears, `q` exits 0
4. reaper: daemon A (never written) survives daemon C's startup reap; daemon B (written, then removed) is reaped; A never SIGTERMed itself
5. #155 move: daemon classifies in `proj-a`, transcript moves to `proj-b`, tag left behind — non-watch charts it, `--watch` renders instead of hanging
6. pending session + a daemon that dies during startup (structural injection: `wtft.mjs` copied next to no `wtft-daemon.mjs`) → exit ≠ 0, names the daemon, never claims "running and waiting"
7. `awaitDaemonUp` proof rules, child stood in by bare node processes: (a) leftover tag + child exit 1 + no lease → `dead`; (b) SIGKILLed child → `dead` naming the signal; (c) child exit 0 while another process holds the lease → `up`
8. existing session, daemon dead before any data → exit ≠ 0, never "no data yet"

`bun run test wtft`: 32/32 suites green. `tests/wtft-daemon.test.sh`: green.

## 5. Roads not taken

- **Require the parent dir to exist** for a pending path — would catch typos, but I could not confirm Claude Code creates `~/.claude/projects/<slug>/` before the first write; the daemon `mkdir -p`s the tags dir either way. A typo now parks a daemon for ≤1 h and prints the path it is waiting on. Revisit if that bites.
- **Non-watch keeps polling** — a one-shot CLI that blocks is the "block other tasks" failure the principle names; `--watch` is the stay-attached mode.
