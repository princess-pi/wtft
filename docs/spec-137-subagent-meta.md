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

439 meta files under `~/.claude/projects/*/*/subagents/` on this host, 2026-09-17. Every one
parsed; **zero unparseable**. A wider `find` (which reaches nested subagent dirs the glob does
not) counts 487 meta files against 487 `agent-*.jsonl` — **1:1**.

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

## The seam

`readSubagentMeta(transcriptPath)` in `extensions/lib/wtft-parser.ts`, additive:

```ts
export interface SubagentMeta {
	agentType: string;
	description: string;
	toolUseId: string;
	spawnDepth: number;
	model?: string;
	parentAgentId?: string;
	isFork?: boolean;
}
export function readSubagentMeta(transcriptPath: string): SubagentMeta | null
```

**Additive on purpose.** `discoverSubagentSessionFiles` returns `{ files, unreadable }` and has
eleven rounds of failure-boundary reasoning in its comments. Widening its return type to carry
meta would put label lookup inside the function whose job is deciding what counts as an
unreadable subagent directory — two unrelated failure modes in one signature. A separate reader
any caller may use keeps the interface small and leaves that boundary exactly where #457 left it.

**A missing or broken meta is never an error.** It returns `null` and the caller renders what it
renders today. This is an **undocumented harness file**: it may vanish, gain fields, or change
names in any release, and wtft must degrade to today's behaviour rather than fail. Only the four
universal fields are required for a meta to be considered valid; anything else missing is a
`undefined`, never a rejection.

## Tests

`tests/wtft-137-subagent-meta.test.ts`.

| # | Asserts |
|---|---|
| M1 | a complete meta beside a transcript is read, every field carried |
| M2 | **`model` absent** → meta still valid, `model` undefined — the 20/439 case |
| M3 | no `.meta.json` at all → `null`, and the caller reports exactly what it reports today |
| M4 | unparseable JSON → `null`, no throw |
| M5 | a meta missing a REQUIRED field (`toolUseId`) → `null`; a partial record is not a record |
| M6 | wrong types (`spawnDepth: "1"`) → `null` |
| M7 | **the field-name pin.** The four universal names are asserted verbatim, so a harness rename fails this suite loudly instead of silently emptying every label |
| M8 | `parentAgentId` is carried, and is present exactly when `spawnDepth > 1` |
| R1 | **the Closer.** `wtft --json` on a session with a Task subagent reports that child's `description`, `model` and `toolUseId`; the rendered block shows the description in place of `agent-<hash>`; a subagent with no meta renders as it does today |

## Scope

Claude Code Task subagents only. Pi and shell-spawned children have no equivalent file, so this
**narrows** the invisible-child gap rather than closing it — those keep #116's ledger and #128's
cwd convention. Naming that here so the next reader does not mistake a partial win for a whole
one.

— 👑π🐱 Princess Pi
