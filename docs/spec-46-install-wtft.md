# spec-46 — `bin/install-wtft`: put this repo's build on PATH

Status: **Draft** · Issue: [#46](https://github.com/princess-pi/wtft/issues/46)

---

## The problem this closes

`wtft` on PATH is not this repo. It resolves to
`~/.bun/bin/wtft` → `~/.bun/install/global/node_modules/princess-pi-tools` → the
**princess-pi-tools clone**, reporting `1.1.0+309bd82-dev-1` and
`built-from .../princess-pi-tools`, while this repo builds `1.0.0`.

The route is `bun link princess-pi-tools` plus that repo's `package.json` `bin` map.
`install-workflow-tools` contains **zero** wtft references — it never installed wtft,
so there is nothing to remove from it. Nothing it deploys calls wtft either.

Consequence: every fix merged here — #36, #37, #39, #18 — is absent from the `wtft`
that runs on this box, and lazy session discovery was implemented **twice**, once in
each repo (ppt #566, here #38).

This spec covers the **mechanism** only: a tool in this repo that puts this repo's
build on PATH. Two things are deliberately out of scope, because each needs its own
evidence and one needs Duppy:

- **The cutover** — proving this repo's binary is not a regression against ppt's
  `1.1.0`. Gated by output parity, tracked on #46, not here.
- **Deleting wtft sources from princess-pi-tools** — Duppy's call, after the cutover
  sticks.

---

## Contract

```
install-wtft [--check] [--json] [--dir <dir>]
install-wtft -h | --help
install-wtft --version
```

| Flag | Meaning |
|---|---|
| *(none)* | Build, then install **four** entries into `--dir` — two copies and two symlinks |
| `--check` | Report drift; **write nothing**. Doctor mode. |
| `--json` | Emit the machine-readable document. Valid with or without `--check`; **ignored** by `--version` and `--help`, which exit inside the argument loop. |
| `--dir <dir>` | Install target. Default `~/bin`. The seam the tests drive. A value beginning with `--` is rejected — `--dir --json` used to install into a directory literally named `--json`. Repeats are last-wins. |
| `-h`, `--help` | This script's header, minus the `#` |
| `--version` | The **absolute path of this script**, not a version number — the same convention as `install-workflow-tools`. |

`--` is **not** an end-of-options marker; it is an unknown argument.

**Install mode needs `bun install` first.** `build.ts` imports `@princess-pi/libs` and
`wcwidth`, so a clone with no `node_modules` exits `3`.

**This script does not install itself**, unlike `install-workflow-tools`. `REPO` is
derived from the script's own location, so a copy in `~/bin` would compute `REPO=$HOME`,
making `SRC_DIR` equal to the default `DEST_DIR` — every artifact compared against itself
and `--check` reporting `ok` on a payload it had just called `stale`. A doctor that always
says healthy is worse than no doctor. Invoke it by path: `<clone>/bin/install-wtft`.

A **symlinked** copy is safe: `self_path` resolves the link itself, not just the directory
holding it, so `<anywhere>/install-wtft -> <clone>/bin/install-wtft` still finds the clone.
Resolving only the parent was the bug — it produced exactly the self-comparing `ok` above.

### Exit codes

| Code | Meaning | Remedy |
|---|---|---|
| `0` | Installed, or `--check` found this host in sync. Also `--version` and `--help`. | — |
| `1` | Drift: an artifact is missing, stale, not executable, or **not built** (`no-source`); or `--dir` could not be created (`no-dir`) | run `install-wtft`, or fix the directory |
| `2` | In sync but **shadowed** on PATH by a different `wtft` | the printed `rm` |
| `3` | The build failed | read the build output on stderr |
| `64` | Bad usage: unknown argument, `--dir` with no directory, `--dir` followed by a flag **or given an empty string**, or no `--dir` on a host with `HOME` unset | — |

`1` and `64` match `install-workflow-tools` deliberately, so the two installers do not
disagree about what a number means. `2` is separate because its remedy is a different
verb entirely: re-running the installer cannot fix a PATH shadow.

**Drift outranks shadow** when both hold — a shadowed copy of the wrong bytes is still
the wrong bytes, and fixing drift is the prerequisite. So exit `2` implies the artifacts
are in sync.

### Streams

Human output goes to **stdout** only when `status` is `ok`; every other status goes to
**stderr**, as does the build's own output. Under `--json` the document goes to stdout in
every case past the argument loop, including `no-dir` and `build-failed` — three paths used
to exit with no document at all on a tool whose point is a machine-readable surface. **Exit
64 is the stated exception**: a usage error is reported on stderr and carries no document,
because the arguments that would say what to report are the thing that is wrong.

Every field of an error document is **measured, not defaulted**. The `no-dir` path used to
finish early with `"artifacts":[]` — against a schema promising four records — and with
`onPath`/`shadow` left at their initialiser values, which a caller reads as findings. It
now falls through the same evaluation as every other exit.

### JSON document — schema `install-wtft@1`

```json
{
  "schema": "install-wtft@1",
  "mode": "check" | "install",
  "dir": "/home/u/bin",
  "status": "ok" | "drift" | "shadowed" | "build-failed" | "no-dir",
  "onPath": true | false,
  "artifacts": [
    { "name": "wtft.mjs", "path": "…/bin/wtft.mjs",
      "state": "ok" | "missing" | "stale" | "not-executable" | "no-source" },
    { "name": "wtft", "path": "…/bin/wtft",
      "state": "ok" | "missing" | "no-source" | "not-a-link" | "wrong-target" }
  ],
  "shadow": null | { "found": "/home/u/.bun/bin/wtft", "remedy": "rm '/home/u/.bun/bin/wtft'" }
}
```

Flat, one record per artifact, stable keys. `status` is the single field a caller reads
to branch; `artifacts[].state` says which file to blame, and the same list is rendered
per-artifact in human mode.

- **`artifacts` is always exactly four records, in a fixed order**: the two copies
  (`wtft.mjs`, `wtft-daemon.mjs`), then the two command symlinks (`wtft`,
  `wtft-daemon`). The two kinds have **different state vocabularies**: a copy can be
  `stale` or `not-executable`, a link can be `not-a-link` or `wrong-target`.
- **`dir` and every `path` are absolute** — a relative `--dir` is made absolute against
  the cwd lexically, *without creating anything*, because `--check` must be able to name
  a directory it refuses to make.
- **`no-source`** means `bin/*.mjs` has not been built. Reachable under `--check`, which
  never builds, **and in install mode after a build failure**, where it appears alongside
  `status: "build-failed"`.
- **`onPath`** reports whether the installed copy is the one PATH resolves. Never fatal —
  a directory that is not on PATH is a host-wiring fact, not drift — but a successful
  install into an off-PATH directory says so in human mode too, because a green run that
  hides a command nobody can type is worse than a warning.
- **`status: "build-failed"` can still carry a populated `shadow`**: shadow detection runs
  unconditionally, and only the *status promotion* is guarded.
- **The escaper handles backslash and double-quote only.** A control character in a path
  (a literal tab) produces a document `JSON.parse` rejects. Left as a documented limit
  rather than code: no path this tool is pointed at has ever contained one, and a lossy
  escaper would be a worse answer than a stated boundary.

## Layout: two copies and two symlinks

| Installed as | Kind | Why |
|---|---|---|
| `<dir>/wtft.mjs` | copy of `bin/wtft.mjs` | the payload |
| `<dir>/wtft-daemon.mjs` | copy of `bin/wtft-daemon.mjs` | the payload, **and** the literal name `daemonDir` joins |
| `<dir>/wtft` | symlink → `wtft.mjs` | the command |
| `<dir>/wtft-daemon` | symlink → `wtft-daemon.mjs` | the command, matching package.json's `bin` map and the README's `wtft-daemon start` |

**The `.mjs` extension is load-bearing twice over.**

1. `bin/wtft.ts` computes `daemonDir = dirname(fileURLToPath(import.meta.url))` and joins
   the literal `"wtft-daemon.mjs"` onto it — four sites in that file and a fifth in
   `extensions/lib/wtft-cli-shared.ts` (`spawnWtftDaemon`).
2. **Node needs it to see ESM.** Node only guesses module type for an *extensionless*
   file from 20.10 (flagged) and 22 (default), and `/usr/bin/node` on this host is
   **18.19.1** — exactly the floor `package.json`'s `engines: >=18` promises.

The first layout installed the command as an extensionless copy. Measured: **exit 1 on
node 18, 20 and 22** when invoked by name, dying on the bundle's first `import`. A
symlink resolves to the `.mjs` realpath — which sits in the same directory, so `daemonDir`
still finds the daemon — and works on all three.

**The payload is a copy; only the command name is a link.** A symlink into the *clone* was
the only workable option before #36, because the artifact still carried bare imports and
ran only from a directory with `node_modules` in an ancestor. The copy survives the clone
moving or being deleted and reports a real version instead of a `-dev` stamp against a
tree that has since changed; the link targets are **relative**, so the whole install
directory can be moved. The cost is re-running `install-wtft` after each build, which
`--check` is what makes visible.

### The shebang had to be rewritten too

`bun` copies the entrypoint's shebang through verbatim, so the plain-JS bundle carried
`#!/usr/bin/env -S node --experimental-strip-types` — correct on `bin/wtft.ts`, fatal on
the output: node 18 and 20 answer `node: bad option: --experimental-strip-types` and exit.
`build.ts` replaces it with `#!/usr/bin/env node`.

**Both defects were invisible for the same reason:** every test in this repo ran the
artifact as `node <file>`, which hands node an explicit entry point. No test had ever
invoked it the way a consumer does — by typing its name. V3 does now, against every `node`
it can find on the host rather than the first one, because the failure was version-
dependent and testing one version is how it stayed hidden.

## The shadow rule: report, never delete

`~/.bun/bin` precedes `~/bin` on this host's PATH — four times over. So installing to
`~/bin` while `~/.bun/bin/wtft` exists produces a **successful install that changes
nothing**, and an installer that exits 0 there is lying.

`install-wtft` therefore resolves `wtft` against `$PATH` after installing. If the
winner is not the file it just wrote, it exits `2` and prints the exact `rm`.

**It never removes the other file.** The precedent is `install-workflow-tools`, which
reports a retired hook and prints its `rm` rather than deleting it, on the reasoning
that silently removing an executable another repo manages is the same class of move as
silently installing one. A `bun link` this tool deletes would also come back the next
time anyone re-links princess-pi-tools, so deleting it would be both rude and
ineffective.

---

## Seams under test

Six sections, all driven through the CLI — no internal function is imported.

| # | Seam | Verified by |
|---|---|---|
| **V1** | `--check --json` on an empty dir | exit `1`, `status: "drift"`, all **four** artifacts `missing`, and the directory still empty afterwards |
| **V2** | install into an empty dir | exit `0`, two copies byte-identical to `bin/*.mjs` at mode `0755`, two symlinks with the right **relative** targets; `--check` then exits `0` |
| **V3** | the installed command runs **when you type its name** | `<dir>/wtft --version` through its own shebang, on **every** `node` on the host, exits 0 and prints the version; `<dir>/wtft-daemon.mjs` sits beside it |
| **V4** | shadow detection | a decoy `wtft` earlier on `PATH` → exit `2`, `shadow.found` names it, the decoy is **still there**, the install still happened, and our own copy winning is exit `0` / `shadow: null` / `onPath: true` |
| **V5** | staleness | append a byte to the installed `wtft.mjs` → `--check` exits `1`, that payload `stale`, the untouched one still `ok`; `chmod 0644` → `not-executable`; a command symlink repointed at the other payload → `wrong-target` |
| **V6** | the nine defects a fresh-context reconcile audit found | see below |

`0755` is what install *writes* and what V2 asserts; the **tool's** check is any execute
bit, so a hand-`chmod`ed `0700` copy still reports `ok`.

**No test writes to the real `~/bin`**, and the installer child's `PATH` is always
constructed by the suite. Two reads do go to the developer's real `PATH` —
`command -v bun` and `command -v node`, resolving the two interpreters the suite must
hand the child — and an earlier draft of this paragraph claimed no test read the real
`PATH` at all, which was false in exactly those two places.

### V6 — what the audit found, and the before/after

Nine defects, none of which V1–V5 caught: every one passed a green 35-check suite. They
are not regressions; they are things nothing ever asserted. Each check was run against
the previous commit's script as well as the fixed one.

| # | Defect | Previous script | Fixed |
|---|---|---|---|
| V6a | `--check` **created** its target — `mkdir -p` ran during argument handling, before the mode branch, while three separate places claimed "writes nothing" | directory created | not created |
| V6b | the human drift report named **no artifact at all** — `STATE_JSON` was piped through `tr ',' '\n'`, which splits each record across three lines, so `name` and `state` never shared one and the `sed` matched nothing | zero per-artifact lines | one line each |
| V6c | exit `2` under `--check` printed "installed into …", having installed nothing | "installed into" | mode-aware wording |
| V6d | a **symlink to our own copy** was reported as a foreign `wtft`, with a remedy that would delete a working command — the comparison resolved the parent directory but never the final symlink | exit `2`, shadowed | exit `0`, `onPath: true` |
| V6e | `--dir --json` installed into a directory literally named `--json` and exited 0 | exit `1` | exit `64` |
| V6f | an unset `HOME` aborted with bash's own `unbound variable` and no document | `line 81: HOME: unbound variable` | exit `64`, named remedy |
| V6g | an un-creatable `--dir` exited 1 with **no document** under `--json`, behind raw `mkdir` stderr | 0-byte stdout | `status: "no-dir"` |
| V6h | the printed `rm` interpolated the winner unquoted, so a path with a space produced a command that does not run | unquoted | single-quoted |
| V6i | `onPath` lived in the document and in no human line, so a green install into an off-PATH directory said nothing | silent | prints the `add … to PATH` note |
| V6j | the **printed** `rm` emitted `rm '"<path>"'` — double quotes inside the single ones — so the command failed on the path it named. V6h had checked only the JSON field, which is why the first fix left this green | `rm '"…"'` | `rm '…'` |

### Mutation-proofs — a script, not a paragraph

`research/46-install-mutants/run-mutants.sh` deletes three branches from a copy of the
script and prints the real-vs-mutant status for each. Run it; do not trust the table.

| Mutation | Real | Mutant |
|---|---|---|
| never escalate a bad artifact state to `drift` | `drift` | `ok` |
| never escalate a foreign PATH winner to `shadowed` | `shadowed` | `ok` |
| never `cmp` source against destination | `drift` | `ok` |

**The mutant must live in `bin/`.** `REPO` is derived from the script's own location, so a
copy anywhere else computes the wrong repo, fails `build-failed`, and proves nothing about
the branch it deleted — which is what happened on the first attempt. The script commits
that constraint rather than leaving the next reader to rediscover it.

## The version had to move into the artifact

Installing into `~/bin` broke `--version`, and V3 caught it on the first run.

`renderWtftVersion` read `<artifactDir>/../package.json`. That resolves in a package
install and in this repo, and in **no other layout** — including this one, where the
lookup lands on `$HOME/package.json`. Two outcomes, and the second is the dangerous one:

- **absent** → `wtft --version` prints `unknown`, on the one command anybody runs when
  they already suspect they are running the wrong build. That command is exactly how #46
  was diagnosed, so an install that breaks it defeats its own purpose.
- **present** → it prints an unrelated project's version, confidently. A stray
  `package.json` in a home directory is not exotic.

`build.ts` now reads package.json at build time and substitutes the literal into the
bundle (`define`). package.json stays the single source of truth; the artifact answers
from itself. Unbundled source — the Pi extension loads it directly — keeps the run-time
read, which is correct there because the file is genuinely reachable.

This also closes the last hole in #36's own thesis: "the emitted ESM reaches for nothing
outside itself" was true of imports and false of the version. `tests/wtft-36-relocatable-build.test.ts`
V5 was rewritten to assert the new contract with a **deliberately wrong** neighbouring
`package.json` (`9.9.9-decoy`), so the old read coming back fails the check instead of
passing on a value that happens to match — the previous V5 could no longer fail for its
stated reason once the version was injected.

## What this spec does not claim

It does not claim the installed binary is **correct** — only that it is *this repo's*
binary, present, executable and unshadowed. Correctness against ppt `1.1.0` is the
cutover's evidence, and it is a separate step on #46 with its own closer: both binaries,
same session, byte-identical render, or every difference named.
