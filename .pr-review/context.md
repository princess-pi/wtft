# Review context — wtft

One developer runs wtft, on one machine, with his agents.

- Code does not pre-check, catch, wrap, retry or auto-fix an error the OS already surfaces (a missing file, a permission denied, a missing command) unless the requirement names a harm the OS report would not surface. A finding that asks for such handling is out of scope.
- A guard is the exception: one that cannot read the input it checks refuses, never passes.
- Otherwise, a finding that needs an input, a host state or a concurrent actor nobody has observed here is graded Low at most, and its fix is optional. Malformed or hand-edited files, unusual transcript shapes, and races that need a second actor all count.
- A defect that the change's own happy path or a documented flow hits keeps its severity.
