===== LENS correctness =====
Reviewed the diff, read the whole of `bin/install-wtft`, `build.ts`, both suites and the spec, then ran things. Baseline: `bun run test wtft-46-install-wtft wtft-36-relocatable` → 2 suites pass; `run-mutants.sh` → 3 OK.

## Findings

**High** — `bin/install-wtft:181` — the human shadow remedy prints `rm '"<path>"'`, not `rm '<path>'`: the `'"'"'` idiom is applied inside a *double*-quoted string, so it emits double quotes where single quotes were intended. Verified by piping the printed line into `eval`: `rm: cannot remove '"/tmp/46rev-s3-rUEd/wtft"': No such file or directory`, exit 1, decoy still on disk. This is the exact defect spec §V6h/S18 claims to have closed; only the JSON field got fixed.

**High** — `bin/install-wtft:80` + `:127` — `self_path` resolves `$0`'s *directory* but never the script symlink itself, so a symlinked `install-wtft` computes `REPO` from the link's location. Verified: link at `$FAKEHOME/bin/install-wtft` → clone gives `REPO=$HOME`, `SRC_DIR=$HOME/bin` = default `DEST_DIR`, every artifact compared against itself, `--check --json` → `status:"ok"`, exit 0 — on a payload that `--check --dir <same dir>` invoked by path reported `stale` one command earlier. The header at `:57–60` warns only about a *copy* in `~/bin`; the `resolve()` helper already in the file is not applied to `$0`.

**High** — `tests/wtft-46-install-wtft.test.ts:48–51` + `:73` — `BUN_DIR` is read from the developer's real PATH and then prepended to the installer child's PATH, so any `wtft` beside `bun` registers as a shadow. On this host `bun` is `/home/princess-pi/bin/bun` — `~/bin`, the installer's own default target — so the first real `install-wtft` run breaks the suite. Verified with a `bun` shim + `wtft` in one dir: 7 checks fail (V2a, V2b, V2h, V3a, V5a, V5e, V6i). The header claim at `:14–18` ("Nothing here … reads the developer's real PATH") is false.

**High** — `research/46-install-mutants/run-mutants.sh:30` — `fails=$((fails+1))` executes inside `$( … )`, a subshell, so the parent's counter never moves and `exit $(( fails > 0 ))` at `:54` always exits 0. Verified by forcing an expected-value mismatch: prints `MISMATCH`, exits 0. The header's "Exit: 0 if every mutant reported ok" cannot fail.

**Medium** — `bin/install-wtft:132` — the unset-`HOME` path exits 64 emitting no document. Verified: `env -u HOME bin/install-wtft --check --json` → exit 64, 0 bytes stdout. Contradicts the `finish` comment at `:162–164` ("Every exit after argument parsing goes through here, so `--json` never has a path that exits with no document") — this exit is after argument parsing — and README.md:30. Same for `--json --bogus` at `:122`.

**Medium** — `bin/install-wtft:217` — the early `finish` for `no-dir` emits `"artifacts":[]`, against spec:108 ("always exactly four records, in a fixed order"); its `"onPath":false` and `"shadow":null` are the `${ON_PATH:-false}` / `${SHADOW_JSON:-null}` defaults, never measured, so a caller branching on them reads fabricated state. Verified: `--json --dir /dev/null/nope`. `build-failed` carries real values, so the two error documents disagree about what their fields mean.

**Medium** — `bin/install-wtft:228–232` — the link loop lacks the `[ -f "$src" ] || continue` guard the copy loop has at `:221`, so with payloads absent install still writes `<dir>/wtft` and `<dir>/wtft-daemon` as dangling symlinks. Verified (symlinked installer + a `bun` shim exiting 0): exit 1 / `no-source`, and `<dir>/wtft --version` → "no such file or directory", exit 127.

**Medium** — `bin/install-wtft:119` + `:129` — `--dir ""` passes the `--*` guard, then `[ -z "$DEST_DIR" ]` reads it as "no `--dir` given" and silently retargets `$HOME/bin`. Verified: `--check --json --dir ""` → `"dir":"/home/princess-pi/bin"`. An unexpanded caller variable writes to the real `~/bin`.

**Medium** — `tests/wtft-46-install-wtft.test.ts:172–179` — "Every node on this host" is `command -v node` plus `/usr/bin/node`, i.e. 2 of the 4 here (18.19.1, 20.20.2, 22.22.3, 24.16.0). Verified from suite output: only v22.22.3 and v18.19.1 ran. Node 20 — the version `build.ts:135–139` and spec:164 name for `bad option: --experimental-strip-types` — is never exercised, nor is 24.

**Medium** — `build.ts:67–70` — the licence lookup tries only `LICENSE`, `LICENSE.md`, `LICENCE`, `license` under top-level `node_modules/<name>` and `throw`s otherwise, so a dependency shipping `COPYING`, `LICENSE.txt` or `LICENSE-MIT` makes `bun run build` a hard failure (and `install-wtft` exit 3) on a filename variant.

**Low** — `tests/wtft-46-install-wtft.test.ts:410–414` — V6h's stated subject is "the **printed** `rm`", but it asserts only `spacedDoc.shadow.remedy` (the JSON field); nothing reads the human line, which is why the `:181` defect is green.

**Low** — `build.ts:59` — the marker regex captures only the first path segment, so a nested `// node_modules/wcwidth/node_modules/defaults/…` marker attributes to `wcwidth` and drops `defaults`' notice — the exact miss the rewrite exists to prevent. Latent: verified 0 nested markers in both bundles today.

**Low** — `tests/wtft-36-relocatable-build.test.ts:239` — "build.ts's define compiles the fallback out of the bundle altogether" is false; verified the `unknown (cannot read …)` fallback survives at `bin/wtft.mjs:5618–5625`, merely unreachable behind `if (injected) return`. The conclusion drawn from it happens to hold, for a different reason.

**Low** — `docs/EXT_WTFT.html:90` — says install-wtft "copies `wtft`, `wtft-daemon` and `wtft-daemon.mjs` into `~/bin`": three names, omitting `wtft.mjs`, and calling the two symlinks copies. spec:43/108 and README:22–24 say four entries, two copies and two symlinks.

**Low** — `README.md:30` — "`--json` gives the whole report as one document, on every exit path" — false for exit 64 (see the `:132` finding).

## Checked and clean

`--dir` last-wins and the `--*` rejection; `--help`/`--version` exiting inside the loop; `EVAL_LIST` field splitting; every array expansion and `cp`/`ln`/`mkdir` argument is quoted; drift-outranks-shadow (verified `drift` + populated `shadow` on the same document); `build-failed` carrying a real shadow and real artifact states (verified with a failing `bun` shim); `resolve()` following the final symlink so our own copy is `onPath`, not a shadow (V4g/V6d reproduce); `cp -f src src` refuses without truncating; the `define` substitution lands as `const injected = "1.0.0"` in both bundles with the identifier fully replaced; both bundles carry `clone`, `defaults` and `wcwidth` notices verbatim with a flagless line-1 shebang; the daemon-name dependency is 4 sites in `bin/wtft.ts` + 1 in `wtft-cli-shared.ts`, as the header claims.
[lens correctness exit=0]
===== LENS contract =====
Branch moved three times during the review (`0b5666f` → `b8e44f4` → `af8ec83`); everything below is verified against the clean tip **`af8ec83`**. At tip: 50/50 in `tests/wtft-46-install-wtft.test.ts`, 3/3 in `run-mutants.sh`.

---

## 1. Does the branch deliver what issue #46 asked for?

The mechanism ships and works. `bin/install-wtft` builds, installs four entries, reports drift, reports shadows without deleting them, and the installed command runs by name on node 18.19.1 / 20.20.2 / 22.22.3 / 24.16.0. Closer 1's *first* half — "`bin/install-wtft` exists here" — is met.

Closer 1's *second* half is not.

- **A · High · `node_modules/@princess-pi/libs/extensions/lib/build-stamp.ts:104`** — `built-from` is emitted only when `bin/build-stamp.json` sits beside the module. `build.ts` never writes one and `install-wtft` never copies one, so an installed `wtft --version` prints two lines (`/wtft 1.0.0`, `path /tmp/…/bin/wtft.mjs`) and no third. Issue #46 closer 1 asks for exactly that third line: `built-from .../git-projects/wtft`. Unreachable from this repo's build, installed or not.
- **B · High · `bin/install-wtft:171`** — the `path` line cannot stand in for it. Because the payload is a *copy*, `path` names the install directory, not the clone; a symlink would have realpath'd back to the clone. The layout removes the last repo-identifying signal from the artifact, which is the one question #46 exists to answer.
- **C · Medium · verified live** — on the host #46 describes, running the tool cannot reach closer 1's state: `~/.bun/bin` precedes `~/bin`, so the install exits `2` and `wtft --version` still answers `1.1.0+309bd82-dev-1`, `built-from …/princess-pi-tools`. The closer needs a human to run the printed `rm`; the spec defends never deleting. Not a defect — but the closer as written is not satisfiable by the tool alone.
- **D · none** — closer 2 (output parity vs ppt `1.1.0`) not attempted, declared out of scope at `docs/spec-46-install-wtft.md:26`. Matches the issue's own ordering.
- **E · none** — closer 3 not attempted; `git -C princess-pi-tools ls-files bin/ | grep wtft` still returns four files. Correctly deferred to Duppy.
- **F · Low · `build.ts:57-88`** — mild overreach, declared: the derived licence notice and LICENSE-filename discovery are a separate defect from "put this repo's build on PATH." The `define`-injected version (`build.ts:120-135`) does belong to #46 — the install layout breaks the old `../package.json` read.

## 2. Is every spec promise true of the code?

**Flag table (spec:41-50)** — all six rows hold. `--check` creates nothing; `--json` is ignored by `--version`/`--help`; `--dir` rejects `--*` and `""`, is last-wins, defaults to `~/bin`; `--version` prints the absolute script path even through a symlink; `--` exits `64`.

- **G · Medium · `bin/install-wtft:14`** — `--help` prints "build, then install **three** files into ~/bin". The layout is four. spec:43, `README.md:23` and `docs/EXT_WTFT.html:90` all say four; `--help` is the only surface still saying three, and spec:47 promises `--help` *is* this header.
- **H · Low · spec:46 vs spec:73** — the flag table's `--dir` row rejects only "a value beginning with `--`"; the exit-code table adds the empty string. The code (`bin/install-wtft:127`) rejects both. One row is stale against the other.

**Exit codes (spec:67-73)** — each verified separately: `0` (install / in-sync / `--version` / `--help`); `1` (missing, stale, not-executable, no-source, no-dir — all five reproduced); `2` (install wording and `--check` wording both correct, decoy survives); `3` (measured with `node_modules` absent); `64` (unknown arg, bare `--dir`, `--dir --json`, `--dir ""`, unset `HOME`).

- **I · Medium · spec:52-53 and `bin/install-wtft:63`** — both state "`build.ts` imports `@princess-pi/libs` and `wcwidth`". `build.ts:29-30` imports `node:fs` and `node:path`, nothing else. Exit `3` is real; the named cause is wrong — the failure is `Bun.build` resolving the *entrypoints'* imports plus `noticeFor` reading `node_modules/<pkg>/LICENSE`.

**JSON schema `install-wtft@1` (spec:99-139)** — every field checked individually, all true. `schema` literal; `mode` both values; `dir` absolute (lexical, uncreated); `status` all five reachable and observed; `onPath` boolean; `artifacts` exactly four in fixed order **including** `no-dir` and `build-failed`; copy vocabulary `ok|missing|stale|not-executable|no-source` all observed; link vocabulary `ok|missing|no-source|not-a-link|wrong-target` all observed; `shadow` null-or-record with a correctly single-quoted `remedy` for a path containing a space. `no-source` reproduced under `--check` and alongside `build-failed`. `build-failed` carries a populated `shadow` (spec:134) — measured. "Every field measured, not defaulted" (spec:92-95) — `no-dir` now reports a real shadow. The escaper limit (spec:136) is exactly as documented: a tab in the path yields a document `JSON.parse` rejects. Streams (spec:85-90) hold, including the exit-64 no-document carve-out.

**Layout table (spec:143-148)** — both copies byte-identical at `0755`, both symlinks relative and correctly targeted, both commands run by name, `wtft-daemon` works. The `0755`-written / any-execute-bit-checked distinction (spec:218) holds: a hand-`chmod`ed `0700` copy still reports `ok`.

- **J · Low · spec:148** — the `wtft-daemon` symlink row is justified by "the README's `wtft-daemon start`". `wtft-daemon start` is not a real invocation; it answers `wtft-daemon: --session <path> is required`. `README.md:51` documents it anyway. The package.json `bin`-map half of the justification is sound.

**V-table and mutation table** — V1–V6 all reproduce. V3's "on **every** `node` on the host" (spec:211) is now true; it was two of four at `0b5666f`. `run-mutants.sh` runs and matches its printed table.

**K · context** — four findings I confirmed at `0b5666f` are fixed at tip by `b8e44f4`: `no-dir` emitting `"artifacts":[]`, the human remedy printing `rm '"<path>"'` while only the JSON field was quoted, `self_path` resolving the parent directory but not its own symlink (a symlinked installer computed `REPO=$HOME`, making `SRC_DIR` the default `DEST_DIR` and `--check` report `ok` on a payload it had just called stale), and `--dir ""` silently retargeting the real `~/bin`. None are open.

Nothing filed and nothing changed, per the no-triage instruction — this report is the record. Findings **A** and **B** are the two that touch whether #46 can be closed; **G**, **I**, **J** and **H** are doc-vs-code.
[lens contract exit=0]
===== LENS reasoning =====
Read `git diff origin/main..HEAD`, all nine touched files, and reproduced three of the cited measurements on this host. Findings below, lettered for back-reference.

## High

**A** · `"Measured: extensionless → exit 1 on 18, 20 and 22 via shebang"` — `bin/install-wtft:154`, echoed at `docs/spec-46-install-wtft.md:159` and `tests/wtft-46-install-wtft.test.ts:168` · Not reproducible against the fixed build: I copied `bin/wtft.mjs` to an extensionless name and ran it through its own shebang — exit **0** on 20.20.2, 22.22.3 and 24.16.0, exit 1 only on 18.19.1. The measurement was taken while the old `-S node --experimental-strip-types` shebang was still present, so it attributes to the missing extension a failure the shebang caused; no reproduction command is recorded anywhere.

**B** · `"The GREEDY .* takes the LAST node_modules/ on the line, so a nested … marker attributes to defaults rather than silently … dropping a notice"` — `build.ts:58-61` · The lookup two lines later joins that bare name onto the **top-level** `node_modules` (`build.ts:70`), so a genuinely nested package has no directory there and `build.ts:80` **throws** instead of emitting the notice. The comment argues for a design the code does not implement; today's tree has no nested markers, so nothing exercises it.

**C** · `"Nothing here writes to the real ~/bin or reads the developer's real PATH"` — `tests/wtft-46-install-wtft.test.ts:15-16` · `execSync("command -v bun")` at `:55` and `execSync("command -v node")` at `:185` both read the real PATH. `docs/spec-46-install-wtft.md:219-223` already corrects this exact sentence ("an earlier draft of this paragraph claimed no test read the real PATH at all, which was false in exactly those two places") — the corrected claim landed in the spec and the false one still stands in the test header.

**D** · `BUNDIR="$(dirname "$(command -v bun)")"` — `research/46-install-mutants/run-mutants.sh:22` · On this host `bun` is `~/bin/bun`, i.e. install-wtft's **default target**; the first real `install-wtft` run puts `~/bin/wtft` on the mutant's PATH, after which the M1 and M3 mutants report `shadowed` rather than `ok` and the script exits 1 on a correct mutation. `tests/wtft-46-install-wtft.test.ts:42-52` names this exact trap ("a trap that arms itself the first time anybody uses this tool for real") and defends against it with a one-entry bun shim; the script the spec says to trust over its own table does not.

## Medium

**E** · `"Node only guesses module type for an extensionless file from 20.10 (flagged) and 22 (default)"` — `bin/install-wtft:152-153`, `docs/spec-46-install-wtft.md:156` · Detection is unflagged from **20.19.0** and **22.7.0**; this host's 20.20.2 has it on by default, so the "flagged" premise the symlink layout leans on is false for every 20.x anyone will actually run.

**F** · `"on two of the three majors package.json's engines: >=18 promises"` — `build.ts:150` · `>=18` is open-ended, not three majors, and this host has four (`/usr/bin/node` 18.19.1, nvm 20.20.2 and 22.22.3, `/usr/local/bin/node` 24.16.0).

**G** · `"reports a real version instead of a -dev stamp against a working tree that has since changed"` — `bin/install-wtft:46`, `docs/spec-46-install-wtft.md:167` · Does not discriminate copy from symlink: a symlink into the clone points at the same built `wtft.mjs` and prints the identical string. Verified — the relocated copy prints `wtft 1.0.0 / path …` with **no** build stamp at all, because `build-stamp.json` is not among the four installed entries. The copy is also what *broke* `--version` (spec:262), which the same document says two sections later.

**H** · `"build.ts imports @princess-pi/libs and wcwidth"` — `bin/install-wtft:63-64`, `docs/spec-46-install-wtft.md:52-53` · `build.ts` imports only `node:fs` and `node:path` (`build.ts:29-30`). The real `bun install` dependency is Bun.build resolving those out of `bin/wtft.ts`, plus `noticeFor` reading `node_modules/<pkg>/LICENSE`.

**I** · `"Deriving it fixes all three and cannot drift"` — `build.ts:51` · `if (pkgs.size === 0) return ""` (`build.ts:66`) means any change to bun's `// node_modules/…` marker format, or a minified build, produces **no notice at all** — silently, with a green build. The absent-notice case is the violation the rewrite exists to prevent, and it is the one failure mode with no error.

**J** · `"A fixed four-name list turned a dependency's filename choice into a hard build failure … a large penalty for a naming convention nobody agrees on"` — `build.ts:71-74` · `build.ts:80` still hard-fails when nothing matches, and `tests/wtft-36-relocatable-build.test.ts:177` still uses exactly a fixed four-name list (`LICENSE`, `LICENSE.md`, `LICENCE`, `license`) with no `COPYING` — so a dependency shipping `COPYING` builds green under the new rule and fails the suite that gates it. The two matchers disagree.

**K** · `"A silent cp failure used to surface only as drift, whose remedy is to re-run the same failing cp"` — `bin/install-wtft:195-199` · The fix adds a stderr line only; `STATUS` stays `drift`, `finish` still prints `Run: <self_path>` (`bin/install-wtft:186`), and the JSON document has no field for the write failure. The remedy the comment calls wrong is still the one emitted.

**L** · `"install-workflow-tools has never contained a single wtft reference"` — `bin/install-wtft:8-10`, `docs/spec-46-install-wtft.md:15-16` · An absolute historical claim about a repo that is not this one, with no command, path or sha cited; nothing in this tree can falsify it.

**M** · `"1 and 64 match install-workflow-tools deliberately, so the two installers never disagree about what a number means"` — `bin/install-wtft:36-38`, `docs/spec-46-install-wtft.md:75-77` · Depends on a tool that exists only in another clone on this one host, and no test here pins the correspondence, so the two can diverge without either side noticing.

**N** · `"on every node we can find"` / `"against every node it can find on the host"` — `tests/wtft-46-install-wtft.test.ts:176-190`, `docs/spec-46-install-wtft.md:182-183` · Four fixed paths plus `~/.nvm`; fnm, volta, asdf, homebrew and bun-managed nodes are invisible to it. "Every" is true only of this host's layout — the same class of blind spot the comment at `:178-182` says it is fixing.

**O** · `"Run it; do not trust the table"` — `docs/spec-46-install-wtft.md:246-248` · `tests/run.ts:75-86` collects only `tests/*.test.ts` and `tests/*.test.sh`, so nothing ever runs `run-mutants.sh`; the three mutation results remain measurements a reader must re-derive by hand, which is the state the script was committed to end.

**P** · `"what it installs then runs on stock node, with no node_modules anywhere"` — `README.md:13-14` · True of static imports; `bin/wtft.ts:288` calls `loadExternalHarnesses()` before the display-flag exits and `import()`s whatever `wtft-harnesses.json` names, which `build.ts:100` acknowledges in the same PR. The claim holds only on a host with no external harness config.

## Low

**Q** · `"each LICENSE is copied verbatim"` / `"reproduced verbatim"` — `build.ts:53`, `build.ts:86` · Each line is re-prefixed `" * "` and trailing whitespace stripped (`build.ts:81-82`); a licence containing `*/` would close the comment block early. Verbatim up to a reformatting the word does not admit.

**R** · `"@princess-pi/libs is MIT-0 … so it is skipped by name"` — `build.ts:64` · The code skips the whole `@princess-pi/` **scope**, not the name — any future `@princess-pi/*` package under a different licence drops out of the notice silently.

**S** · `"A define'd global has no such reader"` — `build.ts:134`, restated `extensions/lib/wtft-cli-shared.ts:527-529` · In the unbundled source path the identifier resolves through `globalThis`, so `NODE_OPTIONS=--import <preload>` dictates the reported version exactly as the env key would. The property holds inside the bundle only — which is the one place the env key could not have been read either.

**T** · `"Drift outranks shadow … a shadowed copy of the wrong bytes is still the wrong bytes"` — `bin/install-wtft:38-40`, `docs/spec-46-install-wtft.md:79-81` · Justifies the exit-code ordering, but the human `drift` branch (`bin/install-wtft:184-187`) drops the shadow line even though `SHADOW_JSON` is populated, so a human needs two runs to see both. The same argument justifies printing both and returning 1.

**U** · `"~/.bun/bin precedes ~/bin on this host's PATH — four times over"` — `docs/spec-46-install-wtft.md:187`, `tests/wtft-46-install-wtft.test.ts:239` · One host, one PATH, and a count with no reproduction command, carrying the whole motivation for the shadow rule.

**V** · `"It exits 0 in sync, 1 drift, 2 shadowed on PATH, 3 build failed, 64 bad usage — so --check is scriptable"` — `README.md:35-36` · `--check` never builds, so it cannot return 3; the install-mode table is presented as `--check`'s contract.

**W** · `"every OTHER suite in this repo imports ../bin/wtft.mjs"` — `tests/wtft-46-install-wtft.test.ts:62-63` · 40 of 57 `tests/*.test.ts` reference it.

**X** · `status: "no-dir"` listed as a general status — `docs/spec-46-install-wtft.md:104` · Reachable in install mode only; `--check` against an un-creatable `--dir` never calls `mkdir` and reports `drift` with four `missing` records instead, which the exit-code table at `:70` merges into one row without saying which mode produces which.
[lens reasoning exit=0]
ALL LENSES DONE
