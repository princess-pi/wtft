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
- **The turn is not the held one.** A turn that runs a Claude command, or one folded into such a
  turn, is never held back. So when a read ended with one, the held turn was an earlier ordinary
  turn, and the interrupt marked that one.

Now the reader remembers the last turn it read, of any kind, and an interrupt at the head of the
next read marks exactly that turn:

- **still held** → it is marked before it is written;
- **a command turn** → it is marked and written again;
- **an ordinary turn already written** → a second copy with the mark is written. A reader of the
  tag keeps one copy per id and ORs `interrupted` across copies (`deduplicateInteractions`), so
  the turn reads as interrupted and its cost is counted once;
- **a turn with no id** → there is nothing to match a second copy to, so the transcript is
  written again as a new generation, the move the reader makes for a rotation.

A read that adds no turns (a tool result, a control line) leaves the remembered turn as it was.
An interrupt with no turn before it marks nothing, as in a full parse. The stamp is never carried
to a later read.

## 2. A longer in-place rewrite and 3. a lower ordinary cost

Both already match a full parse on `c7864c0`. #220 was filed from a review round of #219, and by
the time #219 merged it carried the prefix hash taken on growth, which catches a same-inode rewrite
that is not an append, and the per-id cost map. The fixtures for these two pass without this
change. So the fail-before half of #220's Closer is shown here for case 1 only; cases 2 and 3 are
pinned so they stay true.

**Case 3 against #220's Expected.** #220 asks both that the tag match a full parse and that a
reader keeping the max cost per id not keep the retracted, higher figure. Those two conflict. A
full parse keeps the higher-cost copy of an id (`deduplicateInteractions`), as every wtft reader
does. This change follows the Closer: the tag matches a full parse, so the higher figure stands.
The per-id cost map's new generation re-derives that same answer. Whether that branch should be
kept is #242.

A prefix hash that cannot be read now warns once per transcript, as the other read failures do.
