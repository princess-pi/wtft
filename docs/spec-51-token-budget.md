# spec-51-token-budget

**Status:** Active · **Issue:** princess-pi/wtft#51 (decision 1 — rename) · **Tool:** `extensions/token-budget.ts`

## What it is

Token Budget is the Pi extension that stops an agent from breaching model
subscription quota. It budgets **velocity** — tokens per minute (TPM) — per
model, and it is the surface the absolute-spend budget and the
distance-to-budget visualizations will land on (princess-pi/wtft#53).

It runs transparently: it intercepts provider requests, checks a sliding 120s
window of TPM across all active local sessions, and when a model crosses its
safety threshold (~80% of that model's subscription quota — the
`MODEL_QUOTA_REGISTRY` ceilings are 80–83% per model), it enforces a 40s
synchronous cooldown rather than letting the provider hard-fail.

## One tool, one name

Canonical term is **Token Budget**. The four pre-rename names are retired:

| surface | then | now |
|---|---|---|
| file | `extensions/rate-limiter.ts` | `extensions/token-budget.ts` |
| slash command | `/tpm` | `/budget` |
| widget / status key | `rate-limiter` | `token-budget` |
| config file | `tpm.json` | `token-budget.json` |

"TPM" survives only as the *metric* the budget tracks (tokens per minute), never
as the tool's name. In a harness the short command is `/budget`; "Token Budget"
is the name you find the tool under.

The issue's quote names the old command `/tps`; the code was `/tpm` (`\btps\b`
appears nowhere in this repo). The table records the code, not the misquote.

## Contract

- **Config** — `~/.config/princess-pi-tools/token-budget.json`, resolved by
  `@princess-pi/libs/config`. Keys: `widget` (bool), `footer` (bool),
  `emojiDisabled` (bool). Read and written by the extension. The
  config-persistence split (the CLI reads config and never writes it) is
  decision 3 of #51, not this rename — its guard is yet to land.
  The config *key* rename (`tpm` → `token-budget`) moves the on-disk file from
  `tpm.json` to `token-budget.json`; on the one host that runs this, the file
  is renamed by hand, not migrated in code.
- **Command** — `/budget` with no flags toggles the widget panel on/off; flags
  `--widget on|off`, `--footer on|off`, `--emoji`, `--no-emoji`, `--reset`,
  `--why`, with `-w` / `-f` aliases, toggle each display explicitly.
- **Widget / status** — a below-editor panel plus a footer line, each showing
  per-model TPM as a colored bar against that model's ceiling (green below 50%,
  yellow above 50%, red above 80%; zero-TPM models are skipped in the panel and
  grayed in the footer).
- **Dependency on the tag format** — it scans `wtft-tags/` and parses
  `.wtft-tag.vX.Y.Z.jsonl` filenames. That grammar is a wire-format contract,
  not an implementation detail: it is pinned by `tests/wtft-tag-format.test.ts`
  against `docs/wtft-tag-format.md`, so a tagger rename is a caught break, not a
  silent one.

## Renamed, except where the name is an external contract

The `/tmp` state files keep their names — `pi-rate-limit-coffee.json` (the
cooldown lockfile) and `pi-rate-limit-stats.json` (the stats cache). The
lockfile is read by external tmux / status-bar integrations, so renaming it is a
breaking change for *them*, not a rename of this tool. Treat "rate-limit" there
as describing what the file holds, not the tool's name.

## Not this tool

- The absolute-spend budget and the distance-to-budget visualization are
  princess-pi/wtft#53 — named here, not yet built.
- Provider quota changes are out of scope: Token Budget displays and monitors;
  it cannot raise an API limit.
- The glossary entry (closer item 1) lands with princess-pi/wtft#52, which
  creates `CONTEXT.md`; it is not part of this rename.
