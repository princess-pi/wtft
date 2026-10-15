# Spec 517 — The spawn tree is the default report

Module: `extensions/lib/wtft-spawn-tree.ts` · Seam: `computeSpawnTree`, tested in `tests/wtft-517-tree-default.test.ts`

**State:** Code and Spec Approved

Issue: https://github.com/princess-pi/wtft/issues/517. Also closes https://github.com/princess-pi/wtft/issues/198.

---

## 1. Today

- The chart in `wtft`, `wtft --watch` and the Pi widget shows **self**: this session's own turns
  plus its built-in subagents.
- The spawn tree (self plus every counted launcher-spawned descendant) appears
  only as `TREE` under `--tokens` and as `tree` in `--json`, and only as totals.
- `--watch` never reads the spawn ledger, so a running launcher child is invisible there.

## 2. Want

### 2.1 Decision (Duppy, 2026-10-14)

- **The tree is the default** for the one-shot chart, `--watch` and the Pi widget.
- **`--self` shows self only**, exactly today's chart. The use case is summing spend over a date
  range, where summing trees counts every child twice.
- **Categories are tree-accurate.** Each descendant turn is classified by the same classifier as a
  self turn and binned at its own timestamp. There is no single "Spawned" bucket.

### 2.2 The seam: `computeSpawnTree` collects descendant turns

`SpawnTreeOptions.collect`, when given, receives every counted descendant's turns and the
transcripts they were read from:

```ts
collect?: { turns: Interaction[]; files: string[] };
```

- **Same set as `tree.total`.** Only edges that count (`resolved: true`) contribute, each
  descendant's turns deduplicated the way its edge total is.
- **Fold shares come out of the turn that carries them.** Where a descendant's turn folds a session
  already in some total, the walk subtracts that share from the edge total; with `collect`, it
  subtracts the same share from that turn's cost and token fields, so the turns and the totals
  agree.
- **The invariant:** `computeSessionSummary(collect.turns).total`, without `untaggedCostUsd`, equals
  `tree.total` within float error. Untagged descendant turns are in `collect.turns`, as untagged
  self turns are in the chart: `computeSessionSummary` leaves them out of every total.
- `SpawnTree` itself does not change, so `--json`'s `spawned` keeps its shape.

### 2.3 What each surface shows

| Surface | Default (tree) | `--self` |
|---|---|---|
| One-shot chart, CLI and Pi `-o` histogram | self turns plus `collect.turns` | self turns |
| `--watch` | self turns plus `collect.turns`, re-walked at most every `TREE_REFRESH_MS` | self turns |
| Pi widget chart and pager | self turns plus `collect.turns`, walked on each widget refresh | self turns |
| `--tokens` summary | unchanged: TOTAL, SPAWNED, TREE | unchanged |
| `--json` | unchanged keys, plus `treeCategories` | unchanged: `--self` has no effect on `--json` |

- **The chart's running total** in tree mode equals `tree.costUsd` plus the untagged cost of self
  and of every counted descendant (`total.untaggedCostUsd` plus each
  `spawned.descendantUntagged[].untaggedCostUsd`), within float error. With no untagged turns it is
  `tree.costUsd`.
- **The `≥` floor marker** (spec-515) also scans every counted descendant's transcripts
  (`collect.files`) in tree mode.
- **The double-count guards hold.** A descendant inside self (`in-self-total`, a folded `claude -p`
  child, a Task subagent) contributes no turns, because it contributes no edge total. One
  exception, as in `spawned.descendantUntagged`: an untagged descendant turn keeps a `claude -p`
  child's share, so a child the ledger also records is charted twice.
- **A partial tree is not marked on the chart.** `--tokens` and `--json` say when the tree is a
  floor; the chart's `≥` covers compactions and recaps only.
- **Sessions that share message ids** (a forked or resumed transcript) collapse to one turn in the
  chart and in `treeCategories`, while `tree.total` counts each; the identities above hold when no
  two sessions share a message id.
- **Descendant turns are shaped as a tag stores them:** a recache or post-compaction cache write
  splits into an Ovrhd or Cmpct line, and no descendant turn draws a Cache Miss divider.
- **`--self` is not saved** to the wtft config, in the CLI or in Pi. In the Pi widget, `/wtft --self`
  draws self only, and any later `/wtft` call without it draws the tree again.

### 2.4 `--json`: `treeCategories`

`treeCategories` has the same shape and order as `categories`, summed over self turns plus
`collect.turns`. `sum(treeCategories[].costUsd)` equals `tree.costUsd` within float error. The
schema becomes `wtft/session@9`; no existing key changes meaning.

### 2.5 `--watch`: live children (#198)

In tree mode, `--watch` prints one line per counted descendant whose edge is `live`, under the
chart: its label (else the first 8 characters of its session id), its mechanism, and its edge
cost. A line goes away on the first tree refresh (frames render on tag changes and the
watchdog) after its transcript has been quiet for
`IDLE_THRESHOLD_MS`. `--self` prints none.

### 2.6 `TREE_REFRESH_MS`

The bound on `--watch`'s tree walk: a frame re-walks the tree only when the last walk is older
than this. Lower values show a child's new turns sooner and re-read the spawn ledger and the
children's transcripts more often; a few seconds to a minute is the useful range.

## 3. Roads not taken

- **A "Spawned" category.** It would make the total right and the split wrong; Duppy's decision
  asks for the split to be right.
- **Reading descendants' tag files.** A descendant often has no log parser daemon, so its tag may
  be absent or stale. The walk already parses each descendant's transcripts; classifying those
  turns costs nothing more.
- **Folding descendants into `total`.** `total` keeps meaning self, so `--json` consumers and
  date-range sums are unchanged.

## 4. Verification

`tests/wtft-517-tree-default.test.ts`:

- `computeSpawnTree` with `collect` on a fixture ledger with one `claude -p` child: the turns' summed
  cost equals `tree.total.costUsd`, and each turn keeps its own timestamp and category.
- A child already in self (`alreadyAttributed`) contributes no turns.
- A descendant turn folding a session already in self has that share subtracted.
- `buildSessionJson`: `sum(treeCategories[].costUsd)` equals `tree.costUsd`.
- `parseWtftCliArgs(["--self"])` sets `self`.
- `treeView` with a fresh child transcript lists it live and `renderLiveDescendants` names it;
  ten minutes quiet, the line is gone (#198).

Smoke, on a session with launcher children: `wtft`'s newest running total equals
`--json` `.tree.costUsd` plus the untagged costs above, and `wtft --self` equals `.total.costUsd`
plus `.total.untaggedCostUsd`.
