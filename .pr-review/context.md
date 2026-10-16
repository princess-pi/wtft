# Review context — wtft

One developer runs wtft, on one machine, with his agents.

- A finding that needs an input, a host state or a concurrent actor nobody has observed here is graded Low at most, and its fix is optional. Malformed or hand-edited files, unusual transcript shapes, and races that need a second actor all count.
- An error the OS already reports (a missing file, a permission denied, a missing command) is not caught, wrapped, retried or degraded unless the requirement names a harm the OS report would not surface. A finding asking for that handling is out of scope; a finding that code catches such an error with no named harm is in scope.
- A defect that the change's own happy path or a documented flow hits keeps its severity.
