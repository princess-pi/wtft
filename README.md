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
prints the `rm`, it never deletes anything itself. `--json` gives the whole
report as one document on every exit path but one: a usage error (64) is
reported on stderr and carries no document, because the arguments that would say
what to report are the thing that is wrong. `--help` lists the rest.

Re-run it after every rebuild; `--check` is how you find out you needed to, and
it is scriptable: **0** in sync, **1** drift, **2** shadowed on PATH, **64** bad
usage. A plain install adds **3** for a failed build, which `--check` cannot
return because it never builds.

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

**Neither known-red thing is allowed to simply fail.** A step that can never
fail is not a check, so each names the *one* tolerated outcome and fails on
anything else — otherwise a real regression hides behind an open issue for as
long as that issue stays open:

| Known red | Tolerated outcome | Everything else | Clears when |
|---|---|---|---|
| `registry channel on stock node` | `E404` — the package is not published | fails the job | [#29](https://github.com/princess-pi/wtft/issues/29) publishes; no edit needed here |
| `Daemon shell suite — pinned to the #72 known-red set` | exactly the five known-failing assertions, **by name** | fails the step | [#72](https://github.com/princess-pi/wtft/issues/72) is fixed, and the pinned list empties |

The daemon pin is by **name**, not by tally — a count alone would stay green
across a regression that swapped one known failure for a new one. It cuts both
ways on purpose: fix one and CI goes red asking for it to be struck from the
list; break a different one and CI goes red naming it.

Once the package is on the registry, the stock-node job installs it by name and
runs `--version`, `--help`, `--why` and `wtft-daemon --help` — `--why` because
that is the command the #29 dynamic-import defect broke while the build stayed
green.

`npm test` runs every `tests/*.test.ts`, serially, each in its own process. It
does **not** run `tests/wtft-daemon.test.sh` — shell suites are excluded from the
driver, which is half of what #72 is about; CI runs it as the separate step above.

## Usage

```sh
# Render this session's cost breakdown
wtft

# Widen the window and show more buckets
wtft --interval 3h --limit 20

# Cost by model instead of by activity
wtft --by-model

# Follow a specific session's log parser daemon, or list the running ones
wtft --session <path>
wtft --list
```

`--pager` is a Pi TUI overlay, not a CLI flag — the CLI tells you so and
suggests `wtft … | less -R`. The log parser daemon starts itself on
`session_start` and revives after an idle timeout; `wtft-daemon` exists for
debugging, not for normal use.

## License

[MIT-0](./LICENSE) — no attribution required.
