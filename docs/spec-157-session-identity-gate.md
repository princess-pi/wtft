# Spec — A bare basename is not a session identity (#157)

Regression fix for #155. Small change, but the reasoning is worth recording because the
mistake is easy to repeat: #155 needed an identity that survives a move, reached for the
cheapest thing that looked like one, and did not ask whether it was unique.

---

## The defect

#155 keyed two cross-directory behaviours on `path.basename(sessionPath)`:

```ts
const sessionHash = createHash("sha256").update(path.basename(sessionPath)).digest("hex").slice(0, 12);
```

and `findSiblingTagPath()`, which treats `dirname(dirname(sessionPath))` as the projects root
and searches every sibling directory for a tag file matching that basename.

Both are correct for a real transcript at `~/.claude/projects/<slug>/<uuid>.jsonl`. Neither is
correct for an arbitrary path — and `wtft -s <path>` accepts any path.

### Measured

`tests/wtft-daemon-lifecycle.test.ts` went from **30 passed / 0 failed** at `f3fbc58` to
**25 passed / 5 failed** at `83ad2c5`. Its fixtures are all named `session.jsonl`, in separate
`mkdtemp` directories under `/tmp` — the exact shape that breaks a basename identity.

```
/tmp/wtft-lifecycle-reap-orphan-AAA/session.jsonl
/tmp/wtft-lifecycle-reap-new-BBB/session.jsonl
→ getDaemonPidPath() returns the same path for both
```

Two consequences, both observed:

1. **Lease collision.** Daemon B could not claim a PID file already held by daemon A, so it
   exited at startup. `daemon B still alive` failed, and with no daemon running the
   version-hygiene assertions failed with it (`old-version tag file removed`,
   `current-version tag file exists`).
2. **A wandering scan.** For `/tmp/<fixture>/session.jsonl` the grandparent is `/tmp` itself,
   so `findSiblingTagPath()` swept every directory in `/tmp` for
   `session.jsonl.wtft-tag.v<ver>.jsonl` and found one belonging to an unrelated fixture.
   `empty dir → default current-version path` and `old versions only → newest mtime` failed.

## The rule

Both behaviours are gated on the basename actually being a session id:

```ts
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function isSessionIdBasename(sessionPath: string): boolean {
	return UUID_RE.test(path.basename(sessionPath));
}
```

- `getDaemonPidPath()` keys on the basename when it is a session id, otherwise on the full
  path — the pre-#155 behaviour.
- `findSiblingTagPath()` returns null for a non-session basename, so the grandparent of an
  arbitrary directory is never scanned.

Every real harness transcript carries a UUID: `<uuid>.jsonl` (Claude Code),
`<timestamp>_<uuid>.jsonl` (Pi). Only real harness sessions move between project dirs, so the
gate costs nothing and everything else falls back to the strictly safer path key.

## Roads not taken

- **Inode identity.** Genuinely "the same file", but not derivable from a path before opening
  it, and it does not survive the copy-then-delete form of a move.
- **Hash basename + projects root.** Would keep uniqueness, but the root has to be inferred
  from the path — the same unsound assumption that made the sibling scan wander.
- **Ask the registry whether the path is under a harness root.** Correct, but it costs
  filesystem scans on a function called on every CLI invocation, and it fails for a session
  whose file was just deleted — which is precisely when the daemon calls it.

## Verification

| Assertion | Where |
|---|---|
| Same session id in two project dirs → one PID file | `tests/wtft-issue-155-daemon-follow.test.ts` PART A |
| Two distinct session ids → distinct PID files | PART A |
| Pi's `<timestamp>_<uuid>` basename is also an identity | PART A |
| Two files both named `session.jsonl` in different dirs → **different** PID files | PART A |
| `isSessionIdBasename` separates a session id from an arbitrary filename | PART A |
| A non-UUID basename never reaches into sibling dirs | PART B |
| The whole #155 behaviour set still holds (follow, fixed tag path, single daemon) | PARTS B–D |

As run:

```
node --experimental-strip-types tests/wtft-daemon-lifecycle.test.ts        → 30 passed, 0 failed
node --experimental-strip-types tests/wtft-issue-155-daemon-follow.test.ts → 27 passed, 0 failed
node --experimental-strip-types tests/wtft-issue-156-harness-seam.test.ts  → 63 passed, 0 failed
```

Full suite: 32 pass / 10 fail, and the failure set is **identical** to the pre-merge baseline at
`f3fbc58` — those 10 are tracked in #158.

## Process note

This fix was developed against an already-failing test, so no zero-shot Code Draft measurement
is available for it. The Code Draft commit carries the source change only; the Code Approved
commit carries the test updates and the evidence above.

---

*Built by the AI Princess Pi. Inspired by her human, Duppy (github.com/duppypro)*
