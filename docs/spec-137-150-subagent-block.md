# Spec — #137 render half and #150: the SUBAGENTS block

> **Issues:** [#137](https://github.com/princess-pi/wtft/issues/137) (render half; its `--json`
> half shipped with #141) and [#150](https://github.com/princess-pi/wtft/issues/150) (the glossary
> entry). **P8** of [#194](https://github.com/princess-pi/wtft/issues/194).

## The gap

A built-in (Task-tool) subagent's cost is already inside TOTAL: the daemon syncs each
`<session>/subagents/agent-*.jsonl` into the session's tag file. But no rendered surface says
which subagents that money came from, or what each one was for. `--json` lists them
(`subagents[]`, with the harness's `.meta.json`), but carries no cost per subagent.

## The change

**`--tokens` gains a `SUBAGENTS` block**, printed after TOTAL and the UNCOUNTED line and before
SPAWNED, whenever the session has at least one built-in subagent, i.e. a transcript under
`<session>/subagents/`. A Pi sibling session is not one (Pi subagent tracking is deferred, #209),
and when discovery could not complete the block is not printed, as `--json` omits `subagents`:

```
SUBAGENTS  3 built-in subagent(s) — INSIDE TOTAL above, not added to it
           Audit the 116 test suite                  opus         $1.10
           Fix 116 prose drift, grep-verified        sonnet       $0.42
           agent-b7c2e910442d1f88                    —            $0.03
```

- **One row per subagent, most expensive first.** The name is the harness's `description`, or the
  transcript's basename when there is no `.meta.json` or no `description`. The model is the meta's
  `model`, or `—` when the harness did not record one. Past 20 rows, one more line says how many
  were not shown and that every row is in `--json`.
- **"INSIDE TOTAL above, not added to it."** This is the block's whole contract, and it is why the
  block is not a section of SPAWNED, whose heading says "NOT in TOTAL above". A reader who added
  these rows to TOTAL would double them.
- **A row's cost is exactly the dollars TOTAL holds for that subagent.** It is summed from the tag
  file's lines whose source key `s` is that subagent's, after the same generation filter and id
  dedup TOTAL uses, over model-tagged turns only. A subagent with no tagged lines yet shows
  `(not yet tagged)`, never `$0.00`.
- **A row shows description and model only.** `agentType`, `spawnDepth` and `toolUseId` stay in
  `--json` `subagents[].meta`; the block is for reading cost at a glance.
- **A stale-version tag prints no block**, and `subagents[].total` is absent: an older tagger's
  lines carry no source key, so no line can be attributed to a subagent.
- **The widget is unchanged.** It is a Pi surface, and Pi subagent tracking is deferred (#209).

**`--json`: `subagents[].total`**, the same number: a `TokenTotals` or `null` when no line is
tagged for that subagent yet. It is a nested key, so `wtft/session@6` → `@7`. The rendered block
and the field come from one function, so they cannot disagree.

**To make that possible, a tag line's source reaches the reader.** `classifiedToInteraction` now
copies `s` onto `Interaction.source`. A subagent's source is `transcriptSourceId(<transcript>,
<session dir>)`, the same derivation the daemon writes. No tag-format change.

**Glossary (#150).** `CONTEXT.md` gains **Subagent meta**, the harness's `.meta.json` beside each
built-in subagent transcript, distinguished from the tag file's `_meta` record, and **Subagents
block**.

**`docs/spec-137-subagent-meta.md` § "The Closer's other half"** said the render half was "a
small change to `renderSpawnTree`" and belonged in SPAWNED. Both were wrong: SPAWNED enumerates
spawn-ledger edges, and a built-in subagent's money is inside TOTAL. That section is replaced by
a pointer here.

## Verification

`tests/wtft-137-subagent-block.test.ts`:

- A session whose tag file carries lines for two subagents, one with a meta `description` and
  `model` and one with no meta: `--tokens` prints the block with the description, the model and
  `—`, most expensive first, and each row's cost equals the sum of that subagent's own tagged
  lines.
- In a fixture with no `claude -p` children, the rows plus the session's own turns equal TOTAL.
  So the block states money already in TOTAL rather than adding to it. (A `claude -p` child is
  also inside TOTAL, under its own source, and is not a built-in subagent, so it gets no row.)
- A subagent transcript with no tagged lines shows `(not yet tagged)` and `total: null`.
- Untagged turns are not counted, as in TOTAL.
- `--json` `subagents[].total` equals the rendered row, and the schema is `wtft/session@7`.
- A session with no built-in subagent prints no block.
- An unreadable `.meta.json` prints its `subagent-meta-unreadable` notice to stderr under `--tokens`,
  as `--json` carries it in `notices[]`.
- More than 20 subagents: 20 rows plus the "not shown" line.
