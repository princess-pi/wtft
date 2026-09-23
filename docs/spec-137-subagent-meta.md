# #137 — the harness already writes the parent link; read it

Every built-in (Task) subagent transcript has a `.meta.json` beside it, written by the harness.
wtft reads none of it, and instead shows a hex basename where a human label was on disk the
whole time.

```
~/.claude/projects/<slug>/<parent-session>/subagents/
  agent-a641e532bfaae9903.jsonl        ← we parse this
  agent-a641e532bfaae9903.meta.json    ← we ignore this
```

## What is actually on disk — measured, not assumed

439 meta files under `~/.claude/projects/*/*/subagents/` on this host, 2026-09-17. Every one of
those 439 parsed; **zero unparseable**.

**Two limits on that number, stated because the first draft of this section overstated it**
(#137 review round 1). A wider `find` — which reaches nested subagent directories the glob does
not — counts **487** meta files and **487** `agent-*.jsonl`. Equal totals are not a pairing:
they are consistent with 1:1 and do not establish it, and the 48 files the glob missed were
never parsed or field-counted. So the census below covers 439 files, and "zero unparseable" is a
claim about those 439. What the equal totals do support is that meta files are not sparse —
there is no large population of transcripts without one.

**Why this section says 487 and the audit round below says 493.** Same recursive walk, two
different moments — the corpus grows while sessions run. Between the two readings this host
gained six subagent dispatches, and *both* methods moved by exactly six: the wider walk
487 → 493, the narrow glob 439 → 445. Neither count is wrong; every number in this document
is a reading with a timestamp, not a constant.

| Field | Present | Type | Notes |
|---|---:|---|---|
| `agentType` | 439/439 | string | which agent definition ran (`general-purpose`, `Explore`, …) |
| `description` | 439/439 | string | **the words typed at dispatch** — the label a human recognises |
| `toolUseId` | 439/439 | string | the exact `tool_use` block in the parent's transcript |
| `spawnDepth` | 439/439 | number | 1 (414), 2 (22), 3 (3) |
| `model` | 419/439 | string | **NOT universal** — 20 files (4.6%) have none |
| `requestShape` | 72/439 | string | `background` where present |
| `requestNonInteractive` | 72/439 | bool | co-occurs with `requestShape` |
| `isFork` | 26/439 | bool | fork-type dispatches |
| `parentAgentId` | 25/439 | string | a subagent spawned BY a subagent |
| `name` | 5/439 | string | |
| `cwd` | 2/439 | string | |

**Two things the issue did not know, both of which change the design.**

**1. `model` is optional.** The issue's Closer asks the report to carry `description`, `model`
and `toolUseId`. 20 of 439 files have no `model`, so the type is `string | undefined` and the
renderer needs a no-model arm. Treating it as required would have shipped a field that is
absent 4.6% of the time — the exact "a null is a gap, not a zero" mistake.

**2. The harness records the WHOLE tree, not just depth-1 edges.** `parentAgentId` appears on
exactly the files with `spawnDepth > 1`, and on no others:

```
depth == 1 but HAS parentAgentId:  0
depth  > 1 but NO  parentAgentId:  0
parentAgentId resolves to a sibling agent-*.jsonl:  25 / 25
```

25 deep files, 25 `parentAgentId`s, 25 resolving siblings. So a subagent's parent is a RECORD at
every depth, not only at the top — which is strictly more than #116's ledger reconstructs for
this class of child, and it is already on disk.

**That correlation is a CORPUS OBSERVATION, and the suite does not pin it** (#137 review round
1). M8 checks the reader carries `parentAgentId` when the harness writes one and leaves it
`undefined` when it does not — which is the reader's contract. It does not assert that the
harness only writes it below depth 1, because that is the harness's behaviour, not ours, and a
test that failed when a future release started writing it at depth 1 would be reporting a
correct change as a defect. The observation is what makes the field worth reading; it is not
something wtft can promise.

## The seam

`readSubagentMeta(transcriptPath)` in `extensions/lib/wtft-parser.ts`, additive:

```ts
export interface SubagentMeta {
	agentType: string;
	spawnDepth: number;
	/** Absent on workflow children — see the census above. */
	description?: string;
	/** Absent on workflow children — see the census above. */
	toolUseId?: string;
	model?: string;
	parentAgentId?: string;
	isFork?: boolean;
}
export function readSubagentMeta(transcriptPath: string): SubagentMeta | null
```

**Additive on purpose.** `discoverSubagentSessionFiles` returns `{ files, unreadable }`. Widening its return type to carry
meta would put label lookup inside the function whose job is deciding what counts as an
unreadable subagent directory — two unrelated failure modes in one signature. A separate reader
any caller may use keeps the interface small and leaves that boundary exactly where #457 left it.

**A missing or broken meta is never an error.** It returns `null` and the caller renders what it
renders today. This is an **undocumented harness file**: it may vanish, gain fields, or change
names in any release, and wtft must degrade to today's behaviour rather than fail. Only **two** fields — `agentType` and `spawnDepth` — are required for a meta to be considered
valid; anything else missing is `undefined`, never a rejection. The first cut required all
four, which would have silently declined the 48 workflow children that carry no `description`
or `toolUseId`; the audit round below is where that was caught and corrected.

## Tests

`tests/wtft-137-subagent-meta.test.ts`.

| # | Asserts |
|---|---|
| M1 | a complete meta beside a transcript is read, every field carried |
| M2 | **`model` absent** → meta still valid, `model` undefined — the 20/439 case |
| M3 | no `.meta.json` at all → `null`, and the caller reports exactly what it reports today |
| M4 | unparseable JSON → `null`, no throw |
| M5 | a meta missing a REQUIRED field — `agentType` or `spawnDepth`, the only two → `null`; a partial record is not a record. This row named `toolUseId` until review round 3, which is the four-field gate surviving in a third place after the seam and the prose were both corrected |
| M6 | wrong types (`spawnDepth: "1"`) → `null` |
| M7a | **the READER's names**, against our own fixture. Catches a wtft-side edit that drops or renames a required field. Says NOTHING about the harness — an earlier version claimed it did, and could not, because it wrote its own fixture using the current names |
| M7b | **the HARNESS's names**, against the NEWEST real `.meta.json` on this host (picked by mtime over a recursive walk — an arbitrary pick kept selecting a two-day-old file while the corpus ran to today, so a rename shipped now would leave 400+ stale files keeping it green). Host-gated: it SKIPS VISIBLY where there is no `~/.claude`, so CI does not check it |
| M5c | the `{agentType, spawnDepth}` shape — the Dynamic Workflow children, 48 of 493 files on this host, which the four-field guard declined whole |
| R1b | the key is OMITTED, never `[]`, when discovery failed |
| R1c | and it IS `[]` — present and empty — when discovery ran and found none. The two directions are separate tests because weakening either guard left the whole suite green |
| M8 | `parentAgentId` is carried through the reader when present, and is `undefined` when the harness omits it |
| R1 | **the Closer, `--json` half.** `wtft --json` on a session with a Task subagent reports that child's `description`, `model` and `toolUseId`; a subagent with NO meta is still listed, with its transcript and `meta: null` |

## The Closer's other half

The render half — the rendered block naming each subagent by its description — is specified and
delivered separately: `docs/spec-137-150-subagent-block.md`. It is its own `SUBAGENTS` block, not
a section of SPAWNED, because a built-in subagent's money is inside TOTAL.

## The shape of the `--json` addition

```jsonc
"subagents": [
  { "transcript": "…/agent-a641….jsonl",
    "meta": { "agentType": "general-purpose", "description": "Fix 116 prose drift…",
              "toolUseId": "toolu_014…", "spawnDepth": 1, "model": "sonnet" } },
  { "transcript": "…/agent-bbb….jsonl", "meta": null }
]
```

**The key is ABSENT, not `[]`, whenever the answer would be INCOMPLETE** — for any reason.

A consumer never needs to know which reason. Absent means the answer cannot be trusted as
complete; `[]` means discovery ran and found none. Test both directions separately — weakening
either guard leaves the other green. This is the same rule `uncounted` follows and for the same
reason: an empty array from a caller that never looked is indistinguishable from a session that
spawned nothing, and a consumer reading `subagents.length === 0` would conclude the latter.

**`meta: null` is a gap, not a missing subagent.** The transcript is always present and its cost
is whatever the tag file already made it; only the label is absent. Listing is
not counting — discovery reads the filesystem now, the tag is written by the daemon on its own
schedule, and `meta` bears on neither. Pi children, shell-spawned children, and any
future harness release that stops writing the file all land here.

## Scope

Claude Code Task subagents only. Pi and shell-spawned children have no equivalent file, so this
**narrows** the invisible-child gap rather than closing it — those keep #116's ledger and #128's
cwd convention. Naming that here so the next reader does not mistake a partial win for a whole
one.

— 👑π🐱 Princess Pi

## The local audit round — three fresh-context auditors, 26 findings

Run instead of a third billed review, because on the sibling #130 branch a local round out-found
three billed ones. It did so again here. The blocking findings, and what they have in common.

### The required set was FOUR and the corpus says TWO

`readSubagentMeta` demanded `agentType`, `description`, `toolUseId` and `spawnDepth`. The census
that justified "four universal fields" globbed two path segments then `subagents/`, which cannot
reach `subagents/workflows/wf_<id>/` — the Dynamic Workflow children. **This spec flagged the files
the glob missed and then derived the rule from the rest anyway.** Those missed files are exactly
the ones the rule rejected.

Re-measured with a recursive walk, and independently reproduced before adopting:

| field | present | note |
|---|---|---|
| `agentType` | 493/493 | universal |
| `spawnDepth` | 493/493 | universal |
| `description` | 445/493 | absent on the 48 workflow children |
| `toolUseId` | 445/493 | absent on the same 48 |
| `model` | 437/493 | |
| `parentAgentId` | 25/493 | on exactly the files with `spawnDepth > 1` |

Corpus 493, zero unparseable. The earlier numbers (439/439, `model` 419/439) were the narrowed
glob's.

**The cost was not a stricter reader — it was a WRONG ANSWER.** Every failure returns `null`, and
`null` is defined for consumers as "this harness wrote no record". On one real session **30 of 33
children reported no metadata** while the file sat on disk, readable, carrying two usable fields.
`M5b` and `M5c` pin both directions; RED-verified, 8 assertions fail against the four-field gate.

### Four tests that could not fail

Found by mutation — each edit applied, built, and run — not by reading.

- **`M4` and `M6` were asserting the ABSENT case while claiming the MALFORMED one.** Making the
  fixture helper's string-payload branch write no file left both green with no malformed file
  anywhere on disk. Every negative here expects `null`, which is also the answer when no meta
  exists, so a helper that silently stopped writing left them testing nothing. `fixtureWrote` now
  asserts the bytes landed before any `null` is trusted.
- **`R1`, labelled THE CLOSER, never reached the report path.** It ran the `no-data` arm:
  `total.costUsd` 0, `models` `[]`, one `no-data` notice. So this spec's "the transcript is listed
  and counted either way" was exercised by nothing. Worse, that arm exits **1**, not 9, so
  `runWtftCli` rethrows and an uncaught throw loses every assertion in the file with no tally line
  — observed three times, not reproducible on demand. The tag is now pre-populated and the
  precondition asserted.
- **The `[]` = "looked, found none" contract was pinned at NEITHER layer.** Weakening either guard
  to omit the key on an empty list left this suite green AND thirteen json/subagent suites green.
  `R1b` pinned only the ABSENT half — the direction round 2 fixed. `R1c` pins the other, and fails
  on the exact mutation that used to pass.
- **`M7b` sampled an arbitrary real `.meta.json`, not the newest.** It took `readdir` order from
  the first session that had any, selecting a file two days old from a corpus running to that
  morning. A rename shipped today leaves 400+ old files that keep it green while every label goes
  blank — the same defect `M7a` was split off for, one level up. It now picks by mtime over a
  recursive walk, and the assertion label carries the file's timestamp so a PASS says how fresh its
  evidence was.

### What the four have in common

Each was a measurement taken over a narrowed population and then treated as universal: a glob that
could not reach a directory, a fixture whose payload was never checked, a closer that never left
the `no-data` arm, a sample that was never the newest. **The suite was green throughout.** Green
was not evidence; the mutation was.

### Filed, not fixed here

#143 (the suite certifies the bundle — repo-wide: 45 of 45 suites import `bin/wtft.mjs`, 0 import
the source), #144 (`/tmp` sandbox leak), #145 (`EXT_WTFT.html`'s on-disk table), #146 (an
unreadable `.meta.json` reads as an absent one), #147 (discovery reads the whole parent transcript
to look at line 1 — 885.6 MB per run on a 212 MB session), #148 (depth truncation and symlink
loops), #149 (#137's own invariants are deletable with the suite green), #150 (no glossary entry
for "subagent meta", while `_meta` already means something else).

