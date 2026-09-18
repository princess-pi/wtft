/**
 * @package @princess-pi/wtft
 * @module wtft-config-dir
 * @description wtft's own config directory name and settings-file tool name
 *   (#156). wtft is its own tool, not a princess-pi-tools tool, so every
 *   `@princess-pi/libs/config` call in this repo passes `WTFT_CONFIG_DIR` as
 *   the `dirName` parameter (libs#12) instead of that library's default
 *   ("princess-pi-tools"). Nothing in wtft should read or write config under
 *   "princess-pi-tools" after this file exists — `rg -n 'princess-pi-tools'
 *   extensions bin -g '*.ts'` should return no config-path hits.
 *
 *   Every file lives at `$XDG_CONFIG_HOME/wtft/<file>.json` (default
 *   `~/.config/wtft/`). File names inside that directory: config.json,
 *   pricing.json, harnesses.json, token-budget.json.
 *
 *   Only `config.json` and `token-budget.json` ALSO walk up from `<dir>/.wtft/`
 *   toward `~/` — they go through `@princess-pi/libs/config`'s `loadConfig`/
 *   `readConfig`, which is where walk-up lives. `pricing.json`
 *   (`extensions/lib/wtft-pricing-config.ts`'s `getUserPricingPath`) and
 *   `harnesses.json` (`extensions/lib/harness/registry.ts`'s
 *   `getHarnessConfigPath`) resolve the XDG global path directly and never
 *   walk up — a `.wtft/pricing.json` or `.wtft/harnesses.json` next to a
 *   project is silently never read.
 *
 *   KNOWN LIMITATION, not covered by `bin/install-wtft`'s migration: a
 *   project-local WALK-UP override under the pre-#156 name
 *   (`<dir>/.princess-pi-tools/wtft.json` or `.../token-budget.json`) is not
 *   detected or moved — only the single GLOBAL directory
 *   (`$XDG_CONFIG_HOME/princess-pi-tools/`) is, matching #156's own stated
 *   scope. A project relying on such an override silently stops finding it
 *   after upgrading; there is no `config-left`, no exit code, and no
 *   `--check` line for this case, unlike the global one. Migrating an
 *   arbitrary set of project directories is not something a one-shot,
 *   whole-host install script can discover on its own.
 *
 *   `bin/wtft-daemon.ts` makes NO direct `@princess-pi/libs/config` call of
 *   its own (verified: no `readConfig`/`loadConfig`/`writeConfig`/`hasConfig`
 *   import in that file) — it reaches config only through
 *   `loadUserPricing()`/`loadExternalHarnesses()`, both fixed here via their
 *   own resolvers, so it needed no direct change for #156.
 */

/** Passed as `dirName` to every `@princess-pi/libs/config` call in this repo. */
export const WTFT_CONFIG_DIR = "wtft";

/** The `toolName` wtft's own settings live under: `wtft/config.json`. */
export const WTFT_CONFIG_TOOL = "config";
