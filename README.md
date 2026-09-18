# @princess-pi/wtft

> **⚠️ Barely tested outside a single box.** This runs daily on exactly one machine. Since [#32](https://github.com/princess-pi/wtft/issues/32) every push builds and tests it on a clean Ubuntu runner, which is how the install breaks now get caught. That is a *developer* install in a checkout, not a stranger's install — the job that would prove a stranger can install it is disabled (`if: false`, [#77](https://github.com/princess-pi/wtft/issues/77)) until [#29](https://github.com/princess-pi/wtft/issues/29) publishes. Try it — no guarantees, and expect the install to be the part that breaks.

**wtft** — _what the f**k tokens_ — a live cost tracker for [Claude Code](https://claude.ai/code) and Pi harness sessions. Shows real-time token spend, cost breakdowns, and session history.

> Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).

**Origin:** [btw#63](https://github.com/duppypro/btw/issues/63) — the spec that produced this split from `princess-pi-tools`.

## Install

From a clone. Needs [bun](https://bun.sh) on PATH to build; what it installs then
runs on stock node with no `node_modules` anywhere — for its own code. If you
point `~/.config/wtft/harnesses.json` at an external harness, that file is
`import()`ed at runtime and has to be reachable.

```sh
git clone https://github.com/princess-pi/wtft && cd wtft
bun install
bin/install-wtft            # builds, then copies into ~/bin
bin/install-wtft --check    # later: has a rebuild left ~/bin stale?
```

`install-wtft` puts four entries in `~/bin` (override with `--dir`): the two
bundles `wtft.mjs` and `wtft-daemon.mjs`, plus `wtft` and `wtft-daemon` as
symlinks to them. The `.mjs` names are not spares — `wtft` finds its daemon by
that exact name in its own directory, and Node needs the extension to read the
file as ESM at all on Node 18. It also tells you if some other `wtft` wins on
your PATH: it
prints the `rm`, it never deletes anything itself. It also moves, ONCE, any
config file it finds still sitting at the pre-#156 path
(`~/.config/princess-pi-tools/`) into `~/.config/wtft/` — there is no runtime
fallback read of the old location, so a file left behind stays invisible to
wtft until this script (or a human) moves it; `--check` reports one without
moving it. `install-wtft --json` gives
the whole report as one document on every exit path but one: a usage error (64)
is reported on stderr and carries no document, because the arguments that would
say what to report are the thing that is wrong. `install-wtft --help` lists the
rest. (`wtft` has its own unrelated `--json` — a session summary, and no 64;
see [Usage](#usage) below.)

Re-run it after every rebuild; `--check` is how you find out you needed to, and
it is scriptable: **0** in sync, **1** drift, **2** shadowed on PATH, **4** a
config file still at the old path, **64** bad
usage. A plain install adds **3** for a failed build, which `--check` cannot
return because it never builds. Three of those codes have a second cause: **1**
is also a `--dir` that cannot be created (status `no-dir`), **4** is also install
mode either declining to overwrite a DIFFERENT config file already at the new
path, a file appearing there mid-move, or the copy itself failing partway (a
permissions problem, say) — a file that copies fine but cannot be removed from
the old path afterward is reported as installed; a later run removes that
identical leftover once the old directory allows it, and reports **4** until then — either way a
human resolves which copy is authoritative, and **64** is also
`HOME` unset with no `--dir`, or a relative `--dir` whose current directory is
gone. Two surprises `--help` spells out: `--version` prints the absolute path of
the script, not a version number, and `--` is not an end-of-options marker.

**Not on npm yet.** `npm install -g @princess-pi/wtft` will not work — nothing is
published. Tracked in [#29](https://github.com/princess-pi/wtft/issues/29).

## What CI gates

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the only workflow here.
It runs on **every** branch push and on pull requests, so a PR branch runs both;
each ref gets its own concurrency group and a new push cancels the run in flight.

**Job `git-channel` — gating.** Checkout, node 22, bun `latest`, then: echo the
three toolchain versions, delete `bun.lock` so resolution comes from the
manifest, `npm install`, `npm run typecheck`, `npm test`.

`npm install` resolves with **npm**, then fires `prepare`, which builds with bun.
`prepare`'s `bun install` branch is guarded on a missing `node_modules` and so
never fires here — npm has already installed by then. It does fire for a
consumer installing the git URL.

The suite is where the real assertions live:

- `wtft-36-relocatable-build` — scans every path in the `files` allowlist and
  requires that **`node:` builtins are the only thing any bundle imports**, in
  all four syntactic forms (`… from "x"`, `import("x")`, side-effect
  `import "x"`, `require("x")`). A surviving relative import fails it, which
  matters because that is #29's defect 2 exactly. It also proves the copy's
  directory has no ancestor `node_modules` to cheat with, runs
  `--help`/`--why`/`--version` plus `wtft-daemon --help` from a bare directory
  on stock node, checks the licence of every package vendored **into the two
  CLI bins** is reproduced verbatim (the two Pi bundles are not yet covered —
  [#73](https://github.com/princess-pi/wtft/issues/73)), and checks `--version`
  answers from the artifact rather than a neighbouring `package.json`.
- `pack-and-smoke` — `npm pack`, install the tarball, run it on plain node with
  bun stripped from PATH.

**Job `stock-node-registry` is disabled** (`if: false`,
[#77](https://github.com/princess-pi/wtft/issues/77), Duppy, 2026-09-18): it
does not run on any push. An earlier cut ran it as a *known-red* job — the one
tolerated outcome was `E404` (the package not yet published), anything else
failed it, surfacing as a `::warning::` — but a green board with a warning
line nobody reads is closer to "quietly omitted" than to a real gate, so CI no
longer runs it at all rather than keep pass-with-warning. The job's body is
unchanged and will run once re-enabled.

`tests/wtft-daemon.test.sh` was a second known-red row here until
[#72](https://github.com/princess-pi/wtft/issues/72): it looked for the tag
file beside the session, where the daemon has not written it since `wtft-tags/`
arrived. It is a plain gating step now, and hermetic — it exports a private
`TMPDIR`, so it never touches a daemon it did not start.

Once the package is on the registry, `stock-node-registry` is re-enabled — the
`if: false` line deleted in the same PR that un-parks
[#29](https://github.com/princess-pi/wtft/issues/29) — and installs the
package by name, running `--version`, `--help`, `--why` and
`wtft-daemon --help` — `--why` because that is the command the #29
dynamic-import defect broke while the build stayed green.

`npm test` runs every `tests/*.test.ts`, serially, each in its own process. It
does **not** run `tests/wtft-daemon.test.sh` — shell suites are excluded from the
driver; CI runs it as its own gating step, and locally it is
`bash tests/wtft-daemon.test.sh`.

## Usage

```sh
# Render this session's cost breakdown
wtft

# Widen the window and show more buckets
wtft --interval 3h --limit 20

# Cost by model instead of by activity
wtft --by-model

# Render a specific session once, or stay attached and re-render as it grows
wtft --session <path>
wtft --session <path> --watch

# List the running log parser daemons
wtft --list

# Machine-readable: one JSON object on stdout, exact numbers, no ANSI
wtft --json
wtft --json | jq .total.costUsd
```

### `--json` and the exit codes

`wtft --json` writes **exactly one JSON object** to stdout and nothing else —
no chart, no ANSI, and no `3.6k`-style abbreviation, which is lossy. Human prose
goes to stderr, and every sentence that would otherwise have been on stdout is
repeated in the object's `notices[]`. The schema is `wtft/session@4`; field names
and exit codes are versioned API, the prose inside `notices[].text` is not. Full
contract: [`docs/spec-26-json.md`](./docs/spec-26-json.md).

The numbers come from the same aggregation the rendered `--tokens` table formats,
so those two cannot report different totals. The **bar chart's** total is a
different figure on purpose: it bins every interaction, including ones carrying
no model id. As of `@4` a consumer can size that divergence itself:
`total.costUsd + total.untaggedCostUsd` equals the chart's total
([#119](https://github.com/princess-pi/wtft/issues/119)).

`--json` suppresses the rendering flags. It does **not** apply to the commands
that run instead of a report — `--help`/`--why`/`--version`, `--watch`, and
`--list`/`--cleanup`/`--restart`/`--stop` keep their own output, and `-p` is
still refused with exit 1. With an interactive terminal, `--json` no longer
skips the session picker the way it used to — it still shows one whenever the
population IS ambiguous, drawn to stderr so stdout stays one clean JSON
document ([#89](https://github.com/princess-pi/wtft/issues/89)). An already
unambiguous population (exactly one `-s` match, or exactly one session
discovered with no `-s`) is selected immediately with no picker at all,
interactive terminal or not — the same shortcut a plain, non-`--json` launch
already took. With **no** interactive terminal and an AMBIGUOUS population
(zero or several), see exit **10** below — this replaces the old no-prompt
auto-pick-the-newest behaviour and its `auto-selected-session` notice, both
retired in `@4`.

`wtft` exits with:

- **0** — report produced, including when there is nothing to report yet (the
  session file is not written, or the tag holds no classified data), unless the
  report is provisional (see **9** below). Under `--json`, stdout carries one
  object.
- **1** — error: no session found or selected, an invalid path, a daemon that
  could not be spawned or that died before producing data, a refused flag
  (`--pager`), or an unhandled exception. The reason is on stderr; under
  `--json`, stdout carries nothing.
- **9** — provisional ([#443](https://github.com/princess-pi/wtft/issues/443)):
  the report was produced in full, but the total may still grow under the daemon.
  Under `--json`, `provisional.provisional` is `true` and `provisional.reason`
  names the condition, so `$?` and the field agree. One condition is
  mode-dependent: `subagent-unreadable` is found by the uncounted scan, which
  runs under `--tokens` and `--json` but not on a plain `wtft` run, so a session
  provisional for that reason alone exits 9 in those two modes and 0 on a plain
  run.
- **2** / **3** — `wtft spawn-record` only (see below): the call was wrong, or
  the ledger could not be written. The report path never returns either, and
  `spawn-record` also returns **0** — on a successful append, and on `--help`,
  which appends nothing.
- **10** — session not specified precisely enough
  ([#89](https://github.com/princess-pi/wtft/issues/89)): no interactive
  terminal, and either `-s <substring>` matched zero or several sessions, or no
  `-s` was given and the picker's own default-scoped population (this
  worktree, last 20 minutes — not machine-wide) held zero or several
  sessions. Every match is named on stderr; under `--json`, stdout carries
  nothing, same as exit 1. **Zero with no `-s`** is this exit too, not the old
  exit 1 "no session found" — a script relying on that split needs to read
  the message on stderr, since both the zero and several cases share exit
  10.
- **130** — the interactive session selector was cancelled with `q` or Ctrl-C.
  The SIGINT convention (128+2), not a wtft-specific code. With no interactive
  terminal wtft never shows the selector at all (see exit 10), so this exit is
  unreachable there.

The same table is in `docs/manifests/wtft-cmd.json`, which is what `wtft --help`
renders its **Exit codes** section from.

### `spawn-record` — the spawn ledger

Some agent sessions are started by a *launcher*, not by a `claude` command in the
parent's own transcript: a `pr-review` lens in a `/tmp` sandbox, a
`herdr agent start` child in a worktree. Those children are invisible to the
tree, and not because the parser is missing something —
**neither transcript contains a field naming the other**, so there is no edge to
re-derive and no amount of re-parsing can reach the money. Measured on one real
session: $70.33 reported, $69.68 of its own lens children INVISIBLE — not
`unattributed`, which is the narrower thing: a RECORDED edge whose child could
not be read. Those children had no record at all, which is why the issue exists.

So the spawner writes the edge down when it is free, which is at spawn time —
`claude --session-id <uuid>` takes the child's id as *input*, so it is known
before the child runs:

```sh
wtft spawn-record --parent "$PARENT_SESSION" --child "$CHILD_SESSION" \
  --mechanism pr-review-lens --label correctness --model opus
```

`--flag value` and `--flag=value` both work, `--json` echoes the line written,
and without it nothing is printed at all. `--help` prints the usage. There is no
`--ts`: the clock fills it, so the ledger cannot disagree with itself.

One append-only line in `$XDG_STATE_HOME/wtft/spawns.jsonl`
(`~/.local/state/wtft/spawns.jsonl` by default), written with a single `write(2)`
so concurrent spawners cannot interleave. Each text field is capped at 512 bytes
and the whole line at 4 KiB, which is what keeps that one write one write.
Exit **2** is a bad call — a missing or unknown flag, a flag with no value (a
bare `--label --json` is refused rather than recording the label `--json`), a
malformed session id, an oversized field. Exit **3** is an
unwritable ledger; the edge is then not recorded at all, so the child is
*invisible* rather than unattributed. A spawner is meant to ignore both, since an unrecorded edge
simply degrades to the old behaviour.

`spawn-record` is positional: it must be the **first** argument, so
`wtft --json spawn-record …` is a report run, not a recording.

`wtft --json` then reports the lineage under `spawned` — every edge with its
provenance, every descendant counted exactly once, and every gap named rather
than zeroed — plus `tree`, which is self + descendants as a field so nobody adds
two numbers and guesses. **`total` keeps meaning this session's own turns**; not
one dollar moved into or out of it.

Three bounds are reported rather than hidden: the walk stops at **depth 5**
(`spawned.depthCapped` counts the cuts), a ledger over **8 MiB** is refused
outright rather than partly read, and a ledger it cannot read comes back as
`spawned.ledgerError` rather than as an empty tree. `tree` covers *resolved* descendants, so it is a
floor whenever anything went uncounted, under FOUR conditions: `unattributed`
non-empty, `depthCapped` non-zero, `ledgerError` set, or `malformedLedgerLines`
non-zero. The last was missing until round 5 — a malformed ledger line was a
record, so its edge is lost, and nothing else reports it.

`wtft --tokens` shows the same thing as a `SPAWNED` / `TREE` block below
`TOTAL`. It prints nothing when this session recorded no edges AND the ledger
was read cleanly; an unreadable ledger, or one with skipped lines, still prints
— saying so is the whole point, since "no edges" and "could not tell" are not
the same report. Full
contract: [`docs/spec-116-spawn-ledger.md`](./docs/spec-116-spawn-ledger.md).

`--pager` is a Pi TUI overlay, not a CLI flag — the CLI says so and exits 1,
suggesting `wtft … | less -R`. Any `wtft` run that produces a report spawns the log
parser daemon if one is not already holding the session's lease, and the daemon
revives after an idle timeout. The commands that run instead of a report —
`--help`/`--why`/`--version` and the daemon-management group — return before
that and spawn nothing. `wtft-daemon` exists for debugging, not for normal use.

`wtft --help` is the flag reference — the examples above are a tour, not the
list.

## License

[MIT-0](./LICENSE) — no attribution required.
