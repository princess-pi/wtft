# Spec 220 — the subagent offset reader agrees with a full parse

**Issue:** [#220](https://github.com/princess-pi/wtft/issues/220) ·
**Test:** `tests/wtft-220-subagent-offset-cases.test.ts`

The daemon reads a subagent transcript by offset (`syncSubagentTranscript`), and the tag must
say what a full parse of the finished transcript says. #220 named three cases. The test checks
each one against `deduplicateInteractions(parseSessionFile(file))`.

## 1. An interrupt marks the turn it follows, and never a later one

An interrupt control record stamps the assistant turn before it as interrupted. The reader holds
the last turn of a read back for one poll so that an interrupt arriving next can mark it. When the
interrupt arrives after that turn is already in the tag, the reader used to carry the stamp
forward, so it could land on a later turn, and the turn it followed stayed unmarked.

Now the reader writes the transcript again as a new generation (the same move it makes for a
rotation), so the full parse's marking replaces the line already written. An interrupt with no
turn before it marks nothing, as in a full parse. The stamp is never carried to a later read.

## 2. A longer in-place rewrite and 3. a lower ordinary cost — already true on `main`

Both already match a full parse. The prefix hash taken on growth catches a same-inode rewrite
that is not an append, and the per-id cost map opens a new generation when an ordinary turn comes
back lower. The test pins both, and this change does not touch either.
