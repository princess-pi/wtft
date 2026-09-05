# spec-51-token-budget

**Status:** Active · **Issue:** princess-pi/wtft#51 (decision 1 — rename) · **Tool:** `extensions/token-budget.ts`

## What it is

Token Budget is the Pi extension that stops an agent from breaching model
subscription quota. It budgets **velocity** — tokens per minute (TPM) — per
model, and it is the surface the absolute-spend budget and the
distance-to-budget visualizations will land on (princess-pi/wtft#53).

It intercepts provider requests, sums each model's recent TPM from the wtft
tag files, and when a TPM-limited model crosses its ceiling (the
`MODEL_QUOTA_REGISTRY`, sized against each model's subscription quota), it
enforces a 40s synchronous cooldown rather than letting the provider
hard-fail. Models that are concurrency-limited rather than TPM-limited
(DeepSeek, short-code prefix `d`) redline the meter for visibility but never
cooldown.

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
  config-persistence split (the CLI reads and never writes; extensions write
  their own configs) is decision 3 of #51, not this rename — its guard is
  `tests/config-persistence.test.ts`.
  The config *key* rename (`tpm` → `token-budget`) moves the on-disk file from
  `tpm.json` to `token-budget.json`; on the one host that runs this, the file
  is renamed by hand, not migrated in code.
- **Command** — `/budget`. Three behaviours, and conflating any two of them is
  how #74 hid:

  | Form | Behaviour |
  |---|---|
  | `/budget` (no flags) | **toggles** the widget |
  | `--widget`/`-w`, `--footer`/`-f` with **no** `on\|off` after it | **toggles** that one |
  | `--widget on\|off`, `--footer on\|off`, `--no-widget`, `--no-footer` | **sets**, never toggles |

  Other flags: `--emoji` / `--no-emoji`, `--reset`, `--help` / `-h`, `--why`.

  The set-vs-toggle distinction is load-bearing. Until #74 the negating forms
  toggled: `--no-widget` contains the substring `-w`, so it matched the
  `--widget` **alias** — `--widget` itself is not a substring of `--no-widget` —
  fell through to the valueless-toggle branch, and left its own arm
  unreachable. A single run from ON is indistinguishable from a correct `off`,
  which is why the guard, `tests/wtft-74-budget-flag-parsing.test.ts`, runs
  every negating flag twice and from both starting states. (That suite also
  pins `/wtft --show`/`--hide`, which is `wtft`'s widget rather than this one.)
- **Widget / status** — a below-editor panel and a footer line, showing
  per-model TPM as a colored bar against that model's ceiling.
- **Data source** — reads the wtft tag files under `wtft-tags/`, the same
  classified records the CLI and the session selector consume; the tag wire
  format is documented in `docs/wtft-tag-format.md`.

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
