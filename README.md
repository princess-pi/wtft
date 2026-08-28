# @princess-pi/wtft

**wtft** — _what the f**k tokens_ — a live cost tracker for [Claude Code](https://claude.ai/code) and Pi harness sessions. Shows real-time token spend, cost breakdowns, and session history.

> Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).

**Origin:** [btw#63](https://github.com/duppypro/btw/issues/63) — the spec that produced this split from `princess-pi-tools`.

## Install

```sh
npm install -g @princess-pi/wtft
```

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
