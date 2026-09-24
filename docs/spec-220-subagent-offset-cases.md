# Spec 220 — the subagent offset reader agrees with a full parse

**Issue:** [#220](https://github.com/princess-pi/wtft/issues/220) ·
**Test:** `tests/wtft-220-subagent-offset-cases.test.ts`

The daemon reads a subagent transcript by offset (`syncSubagentTranscript`), and the tag must
say what a full parse of the finished transcript says. #220 named three cases. The test checks
each one against `deduplicateInteractions(parseSessionFile(file))`.

## 1. An interrupt marks the turn it follows, and no other

An interrupt control record stamps the assistant turn before it as interrupted. The reader holds
the last ordinary turn of a read back for one poll, so that an interrupt arriving next can still
mark it before it is written. Two cases used to go wrong:

- **The turn is already written.** The reader carried the stamp forward, so it could land on a
  later turn, and the turn the interrupt followed stayed unmarked.
- **The held turn is not the last turn of its read.** A turn that runs a Claude command, or one
  folded into such a turn, is never held back. So when a read ended with one, the held turn was
  an earlier ordinary turn, and the interrupt marked that one.

Now the held turn is marked only when it was the last turn of its read, of any kind. In every
other case where a turn precedes the interrupt, the reader writes the transcript again as a new
generation, the same move it makes for a rotation, so the full parse's marking replaces what was
written. An interrupt with no turn before it marks nothing, as in a full parse. The stamp is
never carried to a later read.

## 2. A longer in-place rewrite and 3. a lower ordinary cost

Both already match a full parse on `c7864c0`. #220 was filed from a review round of #219, and by
the time #219 merged it carried the prefix hash taken on growth, which catches a same-inode rewrite
that is not an append, and the per-id cost map. The fixtures for these two pass without this
change. So the fail-before half of #220's Closer is shown here for case 1 only; cases 2 and 3 are
pinned so they stay true.

A full parse keeps the higher-cost copy of an id (`deduplicateInteractions`), and so does a reader
of the tag. A lower copy that arrives while the first is still held back leaves the tag with both,
and the reader keeps the higher one: the same answer as a full parse.

A prefix hash that cannot be read now warns once per transcript, as the other read failures do.
