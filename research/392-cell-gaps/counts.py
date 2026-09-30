#!/usr/bin/env python3
"""Count hairlines and row bands inside one rectangle of a screenshot.

usage: [INK=dark] counts.py <png> <left,top,right,bottom>
Prints {"hgaps": n, "vgaps": n}. A hairline (hgaps) is a run of 1-3 pixels of another colour on a
pixel row between two pixels of the same bar colour; a row band (vgaps) is the same down a pixel
column, 1-8 pixels. A bar colour is saturated, or near-black with INK=dark (the light-themed spec
browser draws its bars black).
"""
import json
import os
import sys

from PIL import Image


def is_ink(c):
    if os.environ.get("INK") == "dark":
        return max(c) < 60
    return max(c) - min(c) > 40 and max(c) > 90


def same(a, b):
    return all(abs(x - y) < 7 for x, y in zip(a, b))


def count(line, maxgap):
    n = 0
    i = 0
    while i < len(line) - 1:
        c = line[i]
        if is_ink(c) and not same(c, line[i + 1]):
            j = i + 1
            while j < len(line) and j - i - 1 < maxgap and not same(c, line[j]):
                j += 1
            if j < len(line) and same(c, line[j]) and 1 <= j - i - 1 <= maxgap:
                n += 1
                i = j
                continue
        i += 1
    return n


def main():
    png, box = sys.argv[1], tuple(int(v) for v in sys.argv[2].split(","))
    img = Image.open(png).convert("RGB").crop(box)
    w, h = img.size
    px = img.load()
    hg = sum(count([px[x, y] for x in range(w)], 3) for y in range(h))
    vg = sum(count([px[x, y] for y in range(h)], 8) for x in range(w))
    print(json.dumps({"hgaps": hg, "vgaps": vg}))


if __name__ == "__main__":
    main()
