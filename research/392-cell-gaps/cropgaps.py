#!/usr/bin/env python3
"""Count hairlines and row bands inside one rectangle of a screenshot.

usage: [INK=dark] cropgaps.py <png> <left,top,right,bottom>
Uses gaps.py's rules from the same directory. INK=dark treats near-black as the bar colour, for the
light-themed spec browser.
"""
import json, os, sys
from PIL import Image

png, box = sys.argv[1], tuple(int(v) for v in sys.argv[2].split(","))
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "gaps.py")).read()
ns = {}
exec("def saturated" + src.split("def saturated", 1)[1].split("hg = sum", 1)[0], ns)
img = Image.open(png).convert("RGB").crop(box)
W, H = img.size
px = img.load()
hg = sum(ns["count"]([px[x, y] for x in range(W)], 3) for y in range(H))
vg = sum(ns["count"]([px[x, y] for y in range(H)], 8) for x in range(W))
print(json.dumps({"hgaps": hg, "vgaps": vg}))
