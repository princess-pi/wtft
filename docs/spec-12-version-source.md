# `wtft --version` has one source

Issue: https://github.com/princess-pi/wtft/issues/12

## Behaviour

- **The version is `package.json`'s.** The build writes it into the bundle; unbundled source reads
  the package's own `package.json`, found from the module's location, never one found from the
  working directory.
- **The name is the command's**, `wtft` on the CLI and `/wtft` in Pi, not the manifest's `name`.
- **No manifest in `docs/manifests/` carries a `version` key**, so a second source of the version
  cannot come back in a manifest copied from an old one.

## Verification

`tests/wtft-12-version-source.test.ts`:

- **V1** No `docs/manifests/*.json` has a top-level `version` key. Adding one turns it red.
- **V2** The built CLI, run from the system temp directory, prints `wtft <package.json version>` as
  its first `--version` line.
