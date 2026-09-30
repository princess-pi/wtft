#!/usr/bin/env python3
"""Screenshot a chart page in headless Chrome and count hairline gaps inside block runs.

usage: gaps.py <url> <out.png> [width height]
Prints JSON: {"hgaps": n, "vgaps": n}. A horizontal gap is a run of 1-3 pixels of another colour on a
pixel row with the same saturated colour on both sides. A vertical gap is the same down a pixel
column, 1-8 pixels, both sides the same colour.
"""
import json, subprocess, sys
from PIL import Image

HS = "/home/princess-pi/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
url, out = sys.argv[1], sys.argv[2]
w, h = (sys.argv[3], sys.argv[4]) if len(sys.argv) > 4 else ("1800", "1400")
subprocess.run([HS, "--no-sandbox", "--hide-scrollbars", f"--window-size={w},{h}", "--timeout=8000",
                f"--screenshot={out}", url], check=True, capture_output=True, timeout=120)
img = Image.open(out).convert("RGB")
W, H = img.size
px = img.load()

import os

def saturated(c):
    if __import__('os').environ.get('INK') == 'dark':
        return max(c) < 60
    return max(c) - min(c) > 40 and max(c) > 90

def dark(c):
    return max(c) < 40

def same(a, b):
    return all(abs(x - y) < 7 for x, y in zip(a, b))

def count(line, maxgap):
    n = 0
    L = len(line)
    i = 0
    while i < L - 1:
        c = line[i]
        if saturated(c) and not same(c, line[i + 1]):
            j = i + 1
            while j < L and j - i - 1 < maxgap and not same(c, line[j]):
                j += 1
            if j < L and same(c, line[j]) and 1 <= j - i - 1 <= maxgap:
                n += 1
                i = j
                continue
        i += 1
    return n

hg = sum(count([px[x, y] for x in range(W)], 3) for y in range(H))
vg = sum(count([px[x, y] for y in range(H)], 8) for x in range(W))
print(json.dumps({"hgaps": hg, "vgaps": vg, "size": [W, H]}))
