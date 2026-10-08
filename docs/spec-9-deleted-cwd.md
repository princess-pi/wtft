# `wtft` in a deleted working directory

Issue: https://github.com/princess-pi/wtft/issues/9

## Behaviour

- **A deleted working directory does not crash `wtft`.** Before it reads any config, the CLI checks
  that its working directory still exists. When it does not, it moves to the `--dir` directory, or
  to the home directory when there is no `--dir` or that directory cannot be entered.
- **When it falls back to the home directory it says so on stderr**, naming that directory, and
  `--dir` as the way to pick the project when there was none. The exit code is whatever the run itself
  returns.
- **`spawn-record` moves to the home directory with no notice**: its `--cwd` names the spawned
  child's directory, not one to run from.
- **A working directory that exists is untouched**, with or without `--dir`.

## Verification

`tests/wtft-9-deleted-cwd.test.ts` runs the built CLI from a shell whose working directory was
removed, after checking that node cannot read it:

- **V1** `--version` exits 0 and prints the version.
- **V2** `--json` with no `--dir` and no sessions: no `uv_cwd` error, and stderr names the home
  directory and `--dir`.
- **V3** `--json --dir <project>` discovers that project's session, and stderr has no notice.
- **V4** `--json --dir` naming a directory that does not exist, and `--dir .`: stderr names the
  home directory.
- **V5** `spawn-record`, with and without `--cwd`: exit 0, nothing on stdout or stderr.
