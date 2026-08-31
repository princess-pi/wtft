# #46 review lenses — the coverage `pr-review` could not produce

`pr-open` refused twice on this branch, correctly: **3 of 3 lenses timed out**, first at the
default 600 s ceiling and again at 1500 s each, with empty stderr and exit 124. No PR, no
findings, ~35 minutes of paid work, twice.

**Measured cause — slow, not hung** (filed as `princess-pi-tools#581`):

| stdin | ceiling | result |
|---|---|---|
| 23 bytes | 120 s | exit 0 in **3 s** |
| 8 KB slice of the diff | 700 s | exit 0 in **122 s** |
| 82 KB full diff | 1500 s | exit 124 |

The 8 KB run's own accounting: `output_tokens: 11104`, of which `thinking_tokens: 9614`.
87 % thinking, scaling worse than linearly with the diff. One constant ceiling cannot serve
both a one-file branch and this one.

## What ran instead

Three lenses as separate `claude -p --model opus` calls that **read the branch with tools** —
`git diff`, whole-file reads, and running the code — rather than receiving 82 KB on stdin.
All three completed. The prompts are `lens-*.txt`; the verbatim output is `findings.md`.

They found more than a passing run would have been expected to:

- **correctness** — 4 High, verified by reproduction, including a printed `rm` that emitted
  `rm '"<path>"'` (double quotes inside the single ones, so the copyable command failed on
  the path it named) and a symlinked installer that computed `REPO=$HOME`, compared every
  artifact against itself, and reported `ok` on a payload it had called `stale` one command
  earlier.
- **contract** — every schema field and exit code checked individually against the code, and
  the finding that closer 1 as originally written was unreachable (→ #47, closer amended).
- **reasoning** — that `"exit 1 on 18, 20 and 22"` credited the missing file extension with a
  failure the shebang caused. Re-measured: node 18 only.

## Why this is committed rather than summarised

The same rule this branch keeps running into: a measurement a reader cannot re-derive is a
claim wearing evidence's clothes. The PR says a review happened and findings were fixed;
this directory is what makes that checkable, including the findings that were **declined**
and why.

One cost worth knowing: a tool-using lens runs in the worktree and can leave scratch files
behind. One (`bin/.head-install-wtft`) reached a commit before it was noticed. Check
`git status` before the commit, not after.
