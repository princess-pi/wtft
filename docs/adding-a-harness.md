# Adding a harness to wtft

> **Provenance.** Ported from `princess-pi-tools` (removed there when wtft was
> extracted, #584). Bare issue numbers below (#144, #145, #164, #155, #149, #31)
> refer to **princess-pi-tools** issues; wtft's own issue numbering starts fresh.

Three steps. **No shared file is edited** — not `wtft-renderer.ts`, not `wtft-cost.ts`,
not `wtft-daemon-lib.ts`, not the selector's shared logic. If your harness needs one of
those touched, the seam is in the wrong place; file an issue rather than widening it.

---

## 1. `discovery` — where do this harness's transcripts live?

```ts
interface HarnessDiscovery {
  readonly id: string;     // must equal the directory name
  readonly label: string;  // selector column, e.g. "Codex"
  discover(targetCwd: string | null): SessionCandidate[];
  resolveSessionById(sessionId: string): string | null;
}
```

`discover` returns candidates for a target directory. You decide what a `null` target
means for your harness — Claude Code falls back to `process.cwd()`, Pi treats it as "no
filter". Both are policies, and both live inside their own discovery module.

If your harness records a `cwd` on its transcript entries, apply the **union rule**:
include a transcript when its project-dir slug matches the target **or** its own recorded
last-cwd does. `resolveLastCwd()` from `harness/session-cwd.ts` does the tail scan and
memoises it. Union, not replacement — a last-cwd-only rule silently drops sessions whose
directory slug is a parent of their cwd.

The union has grown three more arms (#144/#145/#164), each a shared helper you should reach
for rather than re-derive. Every one is **additive** — that is the invariant the whole rule
is measured against, and the reason none of them may be written as a replacement.

- **Match the slug, do not compute it.** `slugMatchesCwd(slug, cwd)` accepts *either* known
  encoding, because what a harness munges beyond `/` is usually only partly evidenced —
  Claude Code turns `.` into `-` as well, which is how `.claude/worktrees` paths went
  missing. If you need a single canonical string for *display*, that is `cwdToSlug()`; for
  *matching*, always the matcher. Pinning one encoding trades a known silent miss for an
  unknown one.
- **A deleted directory is not "nowhere".** If your transcripts record relocations, gate
  `resolveCwdHistory()` on `pathExists(lastCwd) === false` and match against every directory
  the session has ever occupied. Gate it, do not run it unconditionally: it is a whole-file
  read, measured at ~315 ms across this machine's transcripts versus ~11 ms for the tail scan.
- **"Here" may mean a whole repo.** `fanOutCwd(target)` returns every checkout of the
  target's git repo, so a session recorded in a sibling worktree is still found. It returns
  the target alone when there is no `.git` ancestor, which is what stops `~` from meaning
  the entire machine. Whether this fits your harness is a policy call, exactly like the
  `null`-target question above: Claude Code fans out, Pi does not.

None of this is required to ship a harness. A harness whose transcripts carry no `cwd`
resolves to `null` from `resolveLastCwd`, contributes nothing to any of these arms, and is
correct — that is Pi's situation, deliberately.

`resolveSessionById` is what lets a running daemon follow a session whose transcript moved
(#155). Return the newest match when an id appears more than once.

## 2. `parse` — what does this harness's entry schema mean?

```ts
interface HarnessParseAdapter {
  readonly id: string;
  matchAssistant(entry: any): AssistantTurn | null;
  readBlock(block: any): ParsedBlock | null;
  readControlEntry(entry: any): ControlSignal | null;
  readUncountedBillable?(entry: any): UncountedBillableClass | null;  // optional (#149)
}
```

This is **schema knowledge only**. Translate field locations and field names; do not
compute anything.

- `matchAssistant` — return `null` unless this entry is your harness's assistant turn.
  Fill `usage` with Anthropic-compat names, and set `nativeCost` only if your harness
  records a per-turn cost of its own (Pi does; Claude Code does not).
- `readBlock` — one content block. Map your tool argument names to `files` / `commands`.
  Set `handled: false` for a tool you did not branch on, so shared category mapping gets a
  shot at it.
- `readControlEntry` — recognize non-assistant entries that change how following turns
  read: model switches, thinking level, compaction markers, interrupts. Every registered
  adapter is consulted for every entry, first match wins.
- `readUncountedBillable` — **optional** (#149). Recognize an entry that stands for an API
  call your harness *bills for* but writes no `usage` object for, and return its class
  (`"compaction"` | `"recap"`). wtft counts these and prints them as an `UNCOUNTED` line
  under `--tokens`; it never prices them, because the dollars reach no file a parser can
  read. Omit the method entirely and your harness simply reports no blind spot — the
  out-of-tree loader does not require it, so an adapter written before #149 stays valid.
  Same first-match-wins consultation order as `readControlEntry`, and for the same reason:
  one entry must not be counted twice. Measured motivation: 4.72% of Claude Code's own
  `total_cost_usd` across seven logged sessions was spend of this kind — see
  `docs/spec-149-compaction-cost-scope.md`.

Cost, cache-miss observation, the meter-split, dedup, classification and every renderer are
inherited. That is the point.

## 3. Register it

**In-repo** — put the two files at `extensions/lib/harness/<id>/discovery.ts` and
`extensions/lib/harness/<id>/parse.ts`, then `bun run build`. `build.ts` scans the
directory and regenerates `harness/builtins.generated.ts`; your harness is in the table.

**Out-of-tree** — ship `.mjs` and point config at it. No rebuild:

```jsonc
// ~/.config/princess-pi-tools/wtft-harnesses.json
{
  "codex": {
    "label": "Codex",
    "discovery": "~/.config/princess-pi-tools/harness/codex/discovery.mjs",
    "parse":     "~/.config/princess-pi-tools/harness/codex/parse.mjs"
  }
}
```

`.mjs` only — stock node cannot import `.ts`, and requiring node ≥ 22.6 type-stripping from
a global install was ruled out in #31.

The same file disables a built-in:

```jsonc
{ "pi": { "enabled": false } }
```

---

## The worked example

`research/156-codex-harness-sketch/` is a complete third harness with a schema deliberately
unlike both built-ins — `{kind: "turn"}` assistant entries, `{op: "call"}` tool blocks, and
a third set of usage field names. It is exercised end to end by
`tests/wtft-issue-156-harness-seam.test.ts`, which asserts it discovers, parses, prices and
classifies through the registry with no shared file edited.

That test is the acceptance criterion for the seam. If it ever needs a change in
`extensions/lib/*.ts` to keep passing, the seam moved and the design is not done.

---

*Built by the AI Princess Pi. Inspired by her human, Duppy (github.com/duppypro)*
