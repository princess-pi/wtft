# @princess-pi/wtft

> **⚠️ Untested outside a single box.** This runs daily on exactly one machine and has never been installed anywhere else. Try it — no guarantees, and expect the install to be the part that breaks. Public testing will come when the install scripts are ready.

**wtft** — _what the f**k tokens_ — a live cost tracker for [Claude Code](https://claude.ai/code) and Pi harness sessions. Shows real-time token spend, cost breakdowns, and session history.

> Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).

**Origin:** [btw#63](https://github.com/duppypro/btw/issues/63) — the spec that produced this split from `princess-pi-tools`.

## Install

From a clone. Needs [bun](https://bun.sh) on PATH to build; the two files it
installs then run on stock node with nothing beside them.

```sh
git clone https://github.com/princess-pi/wtft && cd wtft
bun install
bin/install-wtft            # builds, then copies into ~/bin
bin/install-wtft --check    # later: has a rebuild left ~/bin stale?
```

`install-wtft` copies `wtft`, `wtft-daemon` and `wtft-daemon.mjs` into `~/bin`
(override with `--dir`), and tells you if some other `wtft` wins on your PATH —
it prints the `rm`, it never deletes anything itself. `--json` gives the whole
report as one document. Re-run it after every rebuild; `--check` is how you find
out you needed to.

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
