# Product comment share: comment-only lines / non-blank lines over bin/*.ts + extensions/**/*.ts.
# Usage: python3 debug/comment-share.py [top-N files]
import glob,sys,re
files=sorted(glob.glob('bin/*.ts')+glob.glob('extensions/**/*.ts',recursive=True))
T=C=0;rows=[]
for f in files:
    inb=False;c=n=0;ml=ol=sl=0
    for line in open(f):
        s=line.strip()
        if not s: continue
        n+=1
        if inb:
            c+=1
            if '*/' in s: inb=False
            continue
        if s.startswith('//'): c+=1;continue
        if s.startswith('/*'):
            c+=1
            if '*/' not in s[2:]: inb=True
            continue
    T+=n;C+=c;rows.append((c,n,f))
for c,n,f in sorted(rows,reverse=True)[:int(sys.argv[1]) if len(sys.argv)>1 else 0]: print(f"{c:5} {n:5} {100*c/n:5.1f}% {f}")
print(f"TOTAL {C}/{T} = {100*C/T:.1f}%")
