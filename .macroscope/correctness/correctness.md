---
requires:
  - git-channel
waitsForDiscoveryTimeout: 5
waitsForTimeout: 30
---

Review only heads whose `git-channel` job passed. A failing head is fixed before it is reviewed, so a
billed review never lands on code that CI already rejects.
