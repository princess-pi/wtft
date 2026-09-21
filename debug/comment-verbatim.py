# Delete-only audit: every comment line in the working tree must be a verbatim substring of the
# same file's comment text at <ref> (whitespace-normalized; a trailing period may be added).
# Usage: python3 debug/comment-verbatim.py <ref> <file.ts>...   Exit 0 clean, 1 on any new text.
import re, subprocess, sys

def comment_texts(src):
    out, inb = [], False
    for line in src.split("\n"):
        s = line.strip()
        if inb or s.startswith("/*"):
            inb = not ("*/" in s[2:] if s.startswith("/*") else "*/" in s) 
            t = re.sub(r"^/\*\*?|\*/$", "", s).strip()
            t = re.sub(r"^\*(?!/)", "", t).strip()
            t = re.sub(r"\*/$", "", t).strip()
        elif s.startswith("//"):
            t = s[2:].strip()
        else:
            continue
        if t: out.append(t)
    return out

ref, bad = sys.argv[1], 0
for f in sys.argv[2:]:
    orig = " ".join(comment_texts(subprocess.run(["git", "show", f"{ref}:{f}"], capture_output=True, text=True, check=True).stdout))
    orig = re.sub(r"\s+", " ", orig)
    for t in comment_texts(open(f).read()):
        t = re.sub(r"\s+", " ", t)
        if t not in orig and not (t.endswith(".") and t[:-1] in orig):
            bad += 1
            print(f"NEW {f}: {t}")
print(f"{'clean' if not bad else f'{bad} new'}: {len(sys.argv) - 2} files")
sys.exit(1 if bad else 0)
