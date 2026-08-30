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
| *(none)* | Build, then install both artifacts into `--dir` |
| `--check` | Report drift; **write nothing**. Doctor mode. |
| `--json` | Emit the machine-readable document. Valid with or without `--check`. |
| `--dir <dir>` | Install target. Default `~/bin`. The seam tests drive. |

### Exit codes

| Code | Meaning | Remedy |
|---|---|---|
| `0` | Installed, or `--check` found this host in sync | — |
| `1` | Drift: an artifact is missing, stale, or not executable | run `install-wtft` |
| `2` | Installed correctly but **shadowed** on PATH by a different `wtft` | the printed `rm` |
| `3` | The build failed | read the build output |
| `64` | Bad usage | — |

`1` and `64` match `install-workflow-tools` deliberately, so the two installers do not
disagree about what a number means. `2` is separate because its remedy is a different
verb entirely: re-running the installer cannot fix a PATH shadow.

### JSON document — schema `install-wtft@1`

```json
{
  "schema": "install-wtft@1",
  "mode": "check" | "install",
  "dir": "/home/u/bin",
  "status": "ok" | "drift" | "shadowed" | "build-failed",
  "artifacts": [
    { "name": "wtft", "path": "…/bin/wtft", "state": "ok" | "missing" | "stale" | "not-executable" }
  ],
  "shadow": null | { "found": "/home/u/.bun/bin/wtft", "remedy": "rm /home/u/.bun/bin/wtft" }
}
```

Flat, one record per artifact, stable keys. `status` is the single field a caller reads
to branch; `artifacts[].state` says which file to blame.

---

## Layout, and why it is not a symlink

Installed files:

| Source | Installed as | Why that name |
|---|---|---|
| `bin/wtft.mjs` | `<dir>/wtft` | the command |
| `bin/wtft-daemon.mjs` | `<dir>/wtft-daemon.mjs` | **the extension is load-bearing** |

`bin/wtft.ts` computes `daemonDir = path.dirname(fileURLToPath(import.meta.url))` and
then joins `"wtft-daemon.mjs"` onto it — at four call sites. So the daemon must sit
beside the installed command **under exactly that filename**. Installing it as
`<dir>/wtft-daemon` would leave `wtft --watch` unable to find its daemon while
everything else kept working, which is the failure mode hardest to notice.

**Copy, not symlink.** A symlink into the clone was the only workable option before
#36, because the artifact still had bare imports and only ran from a directory with
`node_modules` in an ancestor. #36 made both files self-contained, so a copy now runs
anywhere — asserted by `tests/wtft-36-relocatable-build.test.ts` V1–V3. What the copy
buys and costs:

- **Buys**: survives the clone moving or being deleted; `--version` reports the real
  version instead of a `-dev` stamp against a working tree that has since changed.
- **Costs**: re-run `install-wtft` after each build. `--check` is what makes that
  cost visible instead of silent.

A symlink is the road not taken; it keeps a live edit loop, at the price of a command
whose behaviour changes when the worktree does.

---

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

Four, all driven through the CLI — no internal function is imported.

| # | Seam | Verified by |
|---|---|---|
| **V1** | `--check --json` on an empty dir | exit `1`, `status: "drift"`, both artifacts `missing` |
| **V2** | install into an empty dir | exit `0`, both files present, mode `0755`, byte-identical to `bin/*.mjs`; `--check` then exits `0` |
| **V3** | the installed command runs | `node <dir>/wtft --version` exits 0 and prints the version; `<dir>/wtft-daemon.mjs` exists beside it |
| **V4** | shadow detection | a decoy `wtft` earlier on `PATH` → exit `2`, `shadow.found` names the decoy |
| **V5** | staleness | append a byte to the installed `wtft` → `--check` exits `1` with `state: "stale"` |

Every test drives a temp `--dir` and a temp `PATH`. **No test writes to the real
`~/bin`, and no test reads the developer's real `PATH`** — the seam exists so the suite
never depends on how this box happens to be wired.

V1, V4 and V5 are the mutation-proofs: each fails against a distinct regression
(no drift detection, no shadow detection, no content comparison).

---

## What this spec does not claim

It does not claim the installed binary is **correct** — only that it is *this repo's*
binary, present, executable and unshadowed. Correctness against ppt `1.1.0` is the
cutover's evidence, and it is a separate step on #46 with its own closer: both binaries,
same session, byte-identical render, or every difference named.
