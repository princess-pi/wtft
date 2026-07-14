# Spec #95 — wtft-daemon lifecycle: takeover protocol, idle clamp, data-derived cache TTL

Status: **Code and Spec Approved** (2026-07-14) — implemented on branch
`95-daemon-lifecycle`, verified 24/24 (see Verification results below)
Issue: [#95](https://github.com/duppypro/princess-pi-packages/issues/95)

## Problem

Observed live (2026-07-13, during #52 pre-merge testing): five daemons attached to one
session, two tag files (v2.4.1 + v2.4.2) written simultaneously, and the `--watch` status
line on an **active** session flashing between `● idle (cache emptied)` and
`● idle (cache expires in 3min)` at the 667ms beat.

## Root cause chain (confirmed in code)

1. **`shutdown()` unlinks the PID file unconditionally** (`bin/wtft-daemon.ts`).
   When daemon B takes over (auto-upgrade path SIGTERMs A and writes B's PID),
   A's SIGTERM handler then deletes **B's** PID file. The singleton lock is now gone:
   the next `wtft` invocation spawns daemon C, whose `wx` create succeeds. B keeps
   running unowned. **Every upgrade/restart cycle leaks one daemon.** Same pattern in
   `--force` (bin + extension) and `restartDaemon()`.
2. **`shutdown()` appends `{"_hb":"stop"}` to its tag path unconditionally**, recreating
   the old-version tag file that the new daemon just deleted — so version hygiene never
   sticks, and two version files coexist.
3. **Old-build daemons are strandable**: a daemon bakes its tag path at startup; after a
   `WTFT_TAGGER_VERSION` bump the stranded old daemon heartbeats into the old-version
   file forever (24h idle-exit is the only reaper).
4. **`getTagPath` returns the first readdir match** of any version — with multiple
   version files present, which file a consumer reads is directory-order luck.
5. **Idle detection trusts heartbeats over classified data**: `checkDaemonHealth` scans
   backwards and takes `idleSinceMs` from the newest `_hb.first` without clamping by the
   newest classified entry's timestamp. With interleaved heartbeats from two daemons
   (divergent `first`), the status alternates per beat.
6. **Cache TTL is guessed from the model name** (`getModelCacheTtlMs`: claude → 5min),
   but the session transcript records the truth:
   `usage.cache_creation.ephemeral_1h_input_tokens > 0` proves a 1-hour cache.
   "cache emptied" was wrong in absolute terms in every reading observed.

## Fixes

### A. Takeover protocol (single-writer invariant)

- **Every beat**, the daemon re-reads its PID file. If it no longer contains its own PID
  (or is unreadable/missing), the daemon **exits immediately** — before writing any
  heartbeat or data. Ownership of the PID file IS ownership of the session.
- `shutdown()` becomes ownership-aware:
  - unlink the PID file **only if it still contains our own PID**;
  - append the stop heartbeat **only if our tag file still exists** (never recreate a
    file that version hygiene deleted).

### B. Version-aware spawn takeover

- Startup order: version scan → PID claim → hygiene.
- If an **old-version tag file** exists for the session, the new daemon **overwrites**
  the PID file with its own PID (no SIGTERM needed): the old daemon self-exits within
  one beat via the takeover protocol (A).
- Otherwise the existing atomic `wx` singleton check stands: exists + alive → exit
  quietly; exists + dead → unlink, retry `wx`.
- **Version hygiene**: after claiming the PID file, unlink all other-version tag files
  for the session (they are derived caches; regeneration is the point of the bump).
  Re-sweep once ~5s after startup to catch a final heartbeat the outgoing daemon may
  have written in its last beat window.

### C. `getTagPath` determinism

Prefer the **exact current-version** file; if absent, the **newest-mtime** matching
file; never readdir order. (Fallback keeps stale-version data readable while a fresh
daemon rebuilds.)

### D. Idle clamped by classified freshness

In `checkDaemonHealth`'s backward scan, record the newest classified entry's timestamp
(`t`) in the scan window and clamp:

```
idleSinceMs = max(newest _hb.first, newest classified t)
```

Heartbeats alone can never declare idle when classified lines are fresher. When the
clamped idle time is below `IDLE_THRESHOLD_MS`, the status is `live`.

### E. Cache TTL derived from data, not model name

- `Interaction` gains `cacheTtl?: "1h" | "5m"` — set at parse time from
  `usage.cache_creation`: `ephemeral_1h_input_tokens > 0` → `"1h"`, else
  `ephemeral_5m_input_tokens > 0` → `"5m"`, else unset.
- Wire format: `serializeClassified` writes `line.ttl`; `classifiedToInteraction` reads
  it back. (Tag-file wire-format sync rule: both functions updated together.)
- `checkDaemonHealth` takes the TTL class from the **newest classified entry carrying
  one** (same backward scan); observed `"1h"` → 3 600 000 ms, `"5m"` → 300 000 ms.
  Falls back to the `getModelCacheTtlMs` model-name heuristic only when no entry in the
  scan window carries a TTL class.
- Requires a `WTFT_TAGGER_VERSION` bump (**2.4.2 → 2.5.0** — wire format addition +
  lifecycle semantics) so existing caches re-serialize with `ttl`.

## Non-goals (roads not taken)

- No lock-file library or flock(2) — the beat loop already gives a natural ≤667ms
  takeover latency; PID-file-as-lease is sufficient and portable.
- No daemon-to-daemon signalling beyond the PID file — SIGTERM races are exactly what
  we are removing.
- TTL countdown remains a display estimate; per-block TTL accounting stays #55's domain.

## Verification (defines "Code Approved")

Automated (new `tests/wtft-daemon-lifecycle.test.ts`, run against built `bin/*.mjs`):

1. **Idle clamp fixture**: tag file with interleaved dual-daemon heartbeats (divergent
   `first`, both ≥ threshold old) + a classified line fresher than both → status is
   `live`, and **stable across 5 repeated `checkDaemonHealth` calls**.
2. **Takeover process test**: spawn the real daemon on a fixture session; overwrite its
   PID file with a foreign PID; daemon exits within 2 beats (~1.4s); the PID file is
   NOT deleted by the exiting daemon.
3. **Spawn-twice test**: spawn the daemon twice on one session; within 2 beats exactly
   one process remains alive and it is the PID-file owner.
4. **Version hygiene test**: pre-create an old-version tag file; spawn daemon; old file
   gone within startup+5s re-sweep; exactly one (current-version) tag file remains.
5. **getTagPath**: dir with both v-old and v-current → returns v-current; dir with only
   v-old → returns v-old (newest mtime); empty dir → default current-version path.
6. **TTL from data**: classified entry with `ttl:"1h"` on a `claude-*` model → idle
   status carries `cacheTtlMs === 3600000` (model heuristic would have said 5min);
   no `ttl` in window → falls back to heuristic.

Manual: run `wtft --watch` on the live session, `wtft-daemon --list` shows exactly one
daemon per session across repeated `wtft` invocations and a forced version bump.

## Verification results (2026-07-14, Code Approved)

- `tests/wtft-daemon-lifecycle.test.ts`: **24/24 pass, zero-shot** (first run after
  Code Draft commit). All six spec cases covered, including a real-process takeover
  (lease stolen → exit within 2 beats, foreign PID file left intact) and a
  spawn-twice singleton with `/proc/<pid>/cmdline` verification.
- Full regression: 23/25 suites pass. Two failures pre-existing and unrelated:
  `wtft-pricing-tiers` (DeepSeek surge case asserts non-peak price without pinning a
  timestamp — fails during peak UTC hours on any branch; filed as its own issue) and
  `session-name-display` (`@earendil-works/pi-tui` not installed).
- Manual: live session converged to exactly one daemon + one tag file.
- Implementation matches spec as written; the only addition discovered during
  testing is a **rollout note**: while v2.5.0 and older builds coexist on one
  machine, daemon ownership ping-pongs (old builds still use the SIGTERM path) and
  converges to whichever build ran last. Resolves on merge + global reinstall +
  Pi extension reload.
