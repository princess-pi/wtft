# @princess-pi/wtft

> **⚠️ Barely tested outside a single box.** This runs daily on exactly one machine. Since [#32](https://github.com/princess-pi/wtft/issues/32) every push builds and tests it on a clean Ubuntu runner, which is how the install breaks now get caught. That is a *developer* install in a checkout, not a stranger's install — the job that would prove a stranger can install it currently gets a 404, because [#29](https://github.com/princess-pi/wtft/issues/29) has not published yet. Try it — no guarantees, and expect the install to be the part that breaks.

**wtft** — _what the f**k tokens_ — a live cost tracker for [Claude Code](https://claude.ai/code) and Pi harness sessions. Shows real-time token spend, cost breakdowns, and session history.

> Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).

**Origin:** [btw#63](https://github.com/duppypro/btw/issues/63) — the spec that produced this split from `princess-pi-tools`.

## Install

From a clone. Needs [bun](https://bun.sh) on PATH to build; what it installs then
runs on stock node with no `node_modules` anywhere — for its own code. If you
point `wtft-harnesses.json` at an external harness, that file is `import()`ed at
runtime and has to be reachable.

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
prints the `rm`, it never deletes anything itself. `install-wtft --json` gives
the whole report as one document on every exit path but one: a usage error (64)
is reported on stderr and carries no document, because the arguments that would
say what to report are the thing that is wrong. `install-wtft --help` lists the
rest. (`wtft` has its own unrelated `--json` — a session summary, and no 64;
see [Usage](#usage) below.)

Re-run it after every rebuild; `--check` is how you find out you needed to, and
it is scriptable: **0** in sync, **1** drift, **2** shadowed on PATH, **64** bad
usage. A plain install adds **3** for a failed build, which `--check` cannot
return because it never builds. Two of those codes have a second cause: **1**
is also a `--dir` that cannot be created (status `no-dir`), and **64** is also
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

**The known-red job is not allowed to simply fail.** A step that can never
fail is not a check, so it names the *one* tolerated outcome and fails on
anything else — otherwise a real regression hides behind an open issue for as
long as that issue stays open:

| Known red | Tolerated outcome | Everything else | Clears when |
|---|---|---|---|
| `registry channel on stock node` | `E404` — the package is not published | fails the job | [#29](https://github.com/princess-pi/wtft/issues/29) publishes; no edit needed here |

`tests/wtft-daemon.test.sh` was a second known-red row here until
[#72](https://github.com/princess-pi/wtft/issues/72): it looked for the tag
file beside the session, where the daemon has not written it since `wtft-tags/`
arrived. It is a plain gating step now, and hermetic — it exports a private
`TMPDIR`, so it never touches a daemon it did not start.

Once the package is on the registry, the stock-node job installs it by name and
runs `--version`, `--help`, `--why` and `wtft-daemon --help` — `--why` because
that is the command the #29 dynamic-import defect broke while the build stayed
green.

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
repeated in the object's `notices[]`. The schema is `wtft/session@1`; field names
and exit codes are versioned API, the prose inside `notices[].text` is not. Full
contract: [`docs/spec-26-json.md`](./docs/spec-26-json.md).

The numbers come from the same aggregation the rendered `--tokens` table formats,
so those two cannot report different totals. The **bar chart's** total is a
different figure on purpose: it bins every interaction, including ones carrying
no model id, and it adds server-side tool cost that per-interaction cost does not.

`--json` suppresses the rendering flags. It does **not** apply to the commands
that run instead of a report — `--help`/`--why`/`--version`, `--watch`, and
`--list`/`--cleanup`/`--restart`/`--stop` keep their own output, and `-p` is
still refused with exit 1. With several sessions discovered and no `--session`,
`--json` does not prompt: it takes the newest and says so in `notices[]`.

`wtft` exits with:

- **0** — report produced, including when there is nothing to report yet (the
  session file is not written, or the tag holds no classified data). Under
  `--json`, stdout carries one object.
- **1** — error: no session found or selected, an invalid path, a daemon that
  died before producing data, or a refused flag (`--pager`). The reason is on
  stderr; under `--json`, stdout carries nothing.
- **9** — provisional ([#443](https://github.com/princess-pi/wtft/issues/443)):
  the report was produced in full, but the total may still grow under the daemon.
  Under `--json`, `provisional.provisional` is `true` and `provisional.reason`
  names the condition, so `$?` and the field agree.
- **130** — the interactive session selector was cancelled with `q` or Ctrl-C.
  The SIGINT convention (128+2), not a wtft-specific code. `--json` never
  prompts, so it never returns this.

The same table is in `docs/manifests/wtft-cmd.json`, which is what `wtft --help`
renders its **Exit codes** section from.

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
