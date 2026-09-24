# Spec 242 — a lower copy of a written turn no longer rewrites the transcript

**Issue:** [#242](https://github.com/princess-pi/wtft/issues/242) ·
**Test:** `tests/wtft-220-subagent-offset-cases.test.ts` (the lower-cost case)

`syncSubagentTranscript` kept `plainCost`, the cost it had written for each ordinary id. When a
lower copy of an id arrived, it opened a new generation and re-read the whole transcript. That
re-read goes through `deduplicateInteractions`, which keeps the higher-cost copy, so the tag ended
up where it started: one full re-read and one full rewrite of that source's lines, for no change.

**Decided (direction A of #242):** the branch and the map are gone. A lower copy is written as a
line of its own, and every tag reader collapses copies of one id to the highest cost
(`dedupeClassifiedById`), which is what a full parse gives.

**Closer:** a lower copy of a turn already in the tag adds no `_gen` record, and the tag still
matches a full parse of the transcript.
