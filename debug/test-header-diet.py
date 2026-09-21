#!/usr/bin/env python3
"""Delete-only test-header diet: keep the first sentence of @description.

Surviving lines keep their original text (no reflow); the last one is cut at
the sentence end. --apply writes, default is a dry run.
"""
import re, subprocess, sys

APPLY = "--apply" in sys.argv
SENT = re.compile(r'(?<![.\d])[.!?](?!\.)(?=\s|$)')


def header_span(L):
    i = 1 if L and L[0].startswith("#!") else 0
    if i >= len(L) or not L[i].strip().startswith("/**"):
        return None
    if "*/" in L[i]:
        return None
    j = i
    while j < len(L) and "*/" not in L[j]:
        j += 1
    return (i, j) if j < len(L) else None


def rebuild(L, i, j):
    prefix = re.match(r'(\s*)', L[i]).group(1)
    star = prefix + " *"
    body = []
    for k in range(i, j + 1):
        t = L[k]
        t = re.sub(r'^\s*/\*\*\s?', '', t) if k == i else re.sub(r'^\s*\*\s?', '', t)
        t = re.sub(r'\s*\*/\s*$', '', t)
        body.append(t.rstrip())
    start = None
    for k, t in enumerate(body):
        m = re.match(r'\s*@description\s+(.*)', t)
        if m:
            body[k] = m.group(1)
            start = k
            break
    if start is None:
        start = next((k for k, t in enumerate(body) if t.strip() and not t.strip().startswith("@")), None)
        if start is None:
            return None
    # A bare "#165." is no purpose at all: keep taking sentences until the
    # text carries something, capped at two.
    kept = []
    sentences = 0
    for k in range(start, len(body)):
        t = body[k]
        if k > start and (not t.strip() or t.strip().startswith("@")):
            break
        cut = None
        for m in SENT.finditer(t):
            sentences += 1
            if len(" ".join(kept + [t[:m.end()]])) >= 48 or sentences >= 2:
                cut = m.end()
                break
        if cut is not None:
            kept.append(t[:cut].rstrip())
            break
        kept.append(t.rstrip())
    while kept and not kept[-1].strip():
        kept.pop()
    kept[0] = kept[0].lstrip()
    # "tests/foo.test.ts — real purpose" restates the filename.
    kept[0] = re.sub(r'^(?:tests/)?\S+\.(?:test\.)?ts\s+[—–-]\s+', '', kept[0])
    # "#165." names an issue, not a purpose: fall through to the next paragraph.
    words = [w for w in re.sub(r'#\S+|[^A-Za-z ]', ' ', " ".join(kept)).split() if len(w) > 1]
    if len(words) < 2:
        rest = body[start + len(kept):]
        while rest and not rest[0].strip():
            rest.pop(0)
        for t in rest:
            if not t.strip():
                break
            m = SENT.search(t)
            kept.append((t[:m.end()] if m else t).rstrip())
            if m:
                break
    if not kept:
        return None
    if kept[-1].rstrip().endswith(":"):
        kept[-1] = kept[-1].rstrip()[:-1].rstrip()
    out = [prefix + "/**"]
    out += [(star + " " + t.strip()).rstrip() if k == 0 else (star + " " + t).rstrip() for k, t in enumerate(kept)]
    out.append(star + "/")
    return out


files = subprocess.run(["git", "ls-files", "tests/"], capture_output=True, text=True).stdout.split()
before = after = 0
for f in files:
    src = open(f).read()
    L = src.split("\n")
    span = header_span(L)
    if not span:
        continue
    i, j = span
    new = rebuild(L, i, j)
    if not new or len(new) >= j - i + 1:
        continue
    before += j - i + 1
    after += len(new)
    if APPLY:
        open(f, "w").write("\n".join(L[:i] + new + L[j + 1:]))
    else:
        print(f"=== {f}  {j-i+1} -> {len(new)}")
        print("\n".join(new))
print(f"header lines {before} -> {after}")
