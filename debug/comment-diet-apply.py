# Delete-only comment diet: apply a plan of whole-line deletions to .ts files.
# Plan lines: "FILE <path>", "D <a>[-<b>]" (original line numbers), "K <n> <text>" (keep only
# <text> of line n's comment; must be a verbatim substring of it). After deletions a JSDoc block
# with no text left is removed, and one with a single text line collapses to "/** text */".
# Usage: python3 debug/comment-diet-apply.py <plan>
import re, sys

def blocks(lines):
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if s.startswith("/*") and "*/" not in s[2:]:
            j = i
            while "*/" not in lines[j] or j == i and "*/" not in lines[j][lines[j].index("/*") + 2:]:
                j += 1
            yield i, j
            i = j + 1
        else:
            i += 1

def text_of(line):
    s = line.strip()
    s = re.sub(r"^/\*\*?", "", s)
    s = re.sub(r"\*/$", "", s)
    s = re.sub(r"^\*(?!/)", "", s)
    return s.strip()

def apply(path, dels, keeps):
    lines = open(path).read().split("\n")
    out = {}
    for n, t in keeps.items():
        if t not in lines[n - 1] and not (t.endswith(".") and t[:-1] in lines[n - 1]):
            sys.exit(f"{path}:{n}: K text not in line: {t!r}")
        s = lines[n - 1]
        indent = s[: len(s) - len(s.lstrip())]
        st = s.strip()
        prefix = "// " if st.startswith("//") else ("* " if st.startswith("*") else None)
        if prefix is None or "*/" in st:
            sys.exit(f"{path}:{n}: K only rewrites a // line or a block's interior line")
        out[n - 1] = indent + ("// " if prefix == "// " else "* ") + t
    for n in dels:
        if not lines[n - 1].strip().startswith(("//", "/*", "*")) and lines[n - 1].strip():
            sys.exit(f"{path}:{n}: D on a code line: {lines[n-1]!r}")
        if "*/" in lines[n - 1] and lines[n - 1].split("*/", 1)[1].strip():
            sys.exit(f"{path}:{n}: D on a line with code after */: {lines[n-1]!r}")
    keep = [k not in dels for k in range(1, len(lines) + 1)]
    new = [out.get(k, l) for k, l in enumerate(lines)]
    for a, b in blocks(lines):
        opener, closer = lines[a].strip(), lines[b].strip()
        body = [k for k in range(a, b + 1) if keep[k] and text_of(new[k])]
        if not body:
            for k in range(a, b + 1): keep[k] = False
            continue
        if not (keep[a] and keep[b]):
            sys.exit(f"{path}:{a + 1}: deleted the opener or closer of a block that keeps text")
        elif len(body) == 1 and opener in ("/**", "/*") and closer == "*/" and keep[a] and keep[b]:
            k = body[0]
            indent = lines[a][: len(lines[a]) - len(lines[a].lstrip())]
            new[a] = f"{indent}{opener} {text_of(new[k])} */"
            for m in range(a + 1, b + 1): keep[m] = False
    res = []
    for k, l in enumerate(new):
        if not keep[k]: continue
        if not l.strip() and res and not res[-1].strip() and k > 0 and lines[k - 1].strip():
            continue
        res.append(l)
    open(path, "w").write("\n".join(res))

plan, cur, dels, keeps = open(sys.argv[1]).read().split("\n"), None, set(), {}
for raw in plan + ["FILE"]:
    ln = raw.split("#", 1)[0].rstrip() if not raw.startswith("K ") else raw
    if not ln.strip(): continue
    if ln.startswith("FILE"):
        if cur: apply(cur, dels, keeps)
        cur, dels, keeps = ln[5:].strip() or None, set(), {}
    elif ln.startswith("D "):
        for part in ln[2:].split():
            a, _, b = part.partition("-")
            dels.update(range(int(a), int(b or a) + 1))
    elif ln.startswith("K "):
        _, n, t = ln.split(" ", 2)
        keeps[int(n)] = t
