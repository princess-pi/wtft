# @princess-pi/wtft

> **⚠️ Untested outside a single box.** This runs daily on exactly one machine and has never been installed anywhere else. Try it — no guarantees, and expect the install to be the part that breaks. Public testing will come when the install scripts are ready.

**wtft** — _what the f**k tokens_ — a live cost tracker for [Claude Code](https://claude.ai/code) and Pi harness sessions. Shows real-time token spend, cost breakdowns, and session history.

> Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).

**Origin:** [btw#63](https://github.com/duppypro/btw/issues/63) — the spec that produced this split from `princess-pi-tools`.

## Install

From a clone. Needs [bun](https://bun.sh) on PATH to build; what it installs then
runs on stock node, with no `node_modules` anywhere.

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
report as one document, on every exit path. `--help` lists the rest.

Re-run it after every rebuild; `--check` is how you find out you needed to. It
exits **0** in sync, **1** drift, **2** shadowed on PATH, **3** build failed,
**64** bad usage — so `--check` is scriptable.

**Not on npm yet.** `npm install -g @princess-pi/wtft` will not work — nothing is
published. Tracked in [#29](https://github.com/princess-pi/wtft/issues/29).

## Usage

```sh
# Watch token spend live
wtft

# Show session history
wtft --history

# Start the background daemon
wtft-daemon start
```

## License

[MIT-0](./LICENSE) — no attribution required.
