# `wtft` in a deleted working directory

Issue: https://github.com/princess-pi/wtft/issues/9

## Behaviour

- **A deleted working directory does not crash `wtft`.** Before it reads any config, the CLI checks
  that its working directory still exists. When it does not, it moves to the `--dir` directory, or
  to the home directory when there is no `--dir` or that directory cannot be entered, and carries on
  from there: the config walk-up, session discovery and the daemons it spawns all start from that
  directory.
- **Without `--dir` it says so on stderr**, naming the directory it moved to and `--dir` as the way
  to pick the project. The exit code is whatever the run itself returns.
- **A working directory that exists is untouched**, with or without `--dir`.

## Verification

`tests/wtft-9-deleted-cwd.test.ts` runs the built CLI from a shell whose working directory was
removed, after checking that node cannot read it:

- **V1** `--version` exits 0 and prints the version.
- **V2** `--json` with no `--dir` and no sessions: no `uv_cwd` error, and stderr names the home
  directory and `--dir`.
- **V3** `--json --dir <project>` discovers that project's session, and stderr has no notice.
