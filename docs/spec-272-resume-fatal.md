# Spec 272 — a tag the daemon cannot read at start is fatal

**Tests:** `tests/wtft-272-resume-fatal.test.ts`

## Behaviour

- **At start, without a rebuild lease, `initClassified` reads the existing tag.** When the read
  fails for any reason but "no such file", or a truncate it needs (a tag with no data record, or
  no offset marker) fails, it calls `fatalTagMutation` with `resume read` or
  `resume truncate`: the lease reads `rebuild`, the FATAL line names the tag, and the daemon exits 1.
  The next `wtft` rebuilds the tag from the transcript when the tag can still be truncated (a
  write-only tag); one that cannot (mode 000, an unsearchable tags directory) fails the rebuild
  truncate too, and stays fatal until storage is fixed, as the FATAL line says.
- **The last offset marker is found in the tag already read**, anywhere in it (`lastOffset` over
  the whole file). The second read of the last 8 KiB is gone, and with it both its swallowed
  failure and #320 A: a marker further back than 8 KiB read as none, and a valid tag was rebuilt.
- **Before**, both failures were swallowed: the daemon set its read position to 0 and appended a
  full re-parse after content it could not clear, so id-less turns were billed twice. The rebuild
  branch already treated a failed truncate this way.
- **Also before**, an exception from `resumeTagger` was caught with the read and led to the same
  re-parse. It now calls `fatalTagMutation` too (`resume`), from any caller: a per-session start
  or any harness adoption, including those that run from a timer or a watch callback.
- **In a harness daemon** the fatal exit stops the whole process, as every `fatalTagMutation`
  does there (#320 B).

## Closer

A tag that is writable but not readable (mode 0200) at daemon start: the daemon exits 1 with
`FATAL: the derived tag resume read failed`, the lease reads `rebuild`, and the tag gains no byte.
On the build before this change the same fixture gained a full re-parse.
