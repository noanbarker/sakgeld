#!/usr/bin/env python3
"""
Home screen and browser icons, cut from the mascot artwork.

    python3 tools/icons/build.py

Writes apple-touch-icon.png, images/icon-192.png and images/icon-512.png.

Why this exists: the icons used to be the mascot filling the square edge to
edge, no margin at all. Both iOS and Android round the corners off an icon —
iOS takes about 4.4% of the square, Android can mask to a circle — so his
leaves and his feet were being sliced off on the home screen.

The fix is not to crop him tighter. It is to leave room: the artwork is scaled
to sit inside a safe area with a margin all round, so whatever shape the
platform masks to, the whole mascot survives inside it.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "images" / "mascot-cropped.png"

# Fraction of the square left empty around the artwork. 0.14 keeps the mascot
# clear of the iOS corner radius and inside Android's circular mask.
PAD = 0.14

# Matches the hero background on the marketing pages, so the icon and the site
# it opens look like the same product. A green mascot on a green field loses
# its edges, which is why this is the pale end of the palette.
BG_TOP = (240, 253, 244)
BG_BOTTOM = (209, 250, 229)

# No alpha anywhere: iOS composites a transparent icon onto black.
TARGETS = [
    (ROOT / "apple-touch-icon.png", 180),
    (ROOT / "images" / "icon-192.png", 192),
    (ROOT / "images" / "icon-512.png", 512),
]


def gradient(size):
    from PIL import Image, ImageDraw
    strip = Image.new("RGB", (1, size), BG_TOP)
    draw = ImageDraw.Draw(strip)
    for y in range(size):
        t = y / max(1, size - 1)
        draw.point((0, y), tuple(round(a + (b - a) * t)
                                 for a, b in zip(BG_TOP, BG_BOTTOM)))
    return strip.resize((size, size))


def main():
    try:
        from PIL import Image
    except ImportError:
        sys.exit("Cannot build. Missing:\n  Pillow — pip3 install --user pillow")
    if not SRC.exists():
        sys.exit(f"Cannot build. No mascot artwork at {SRC.relative_to(ROOT)}")

    src = Image.open(SRC).convert("RGBA")
    # Trim the transparent border the source carries, so PAD means the same
    # thing regardless of how the artwork happens to be framed.
    box = src.getchannel("A").point(lambda p: 255 if p > 8 else 0).getbbox()
    art = src.crop(box)

    for path, size in TARGETS:
        canvas = gradient(size)
        room = size * (1 - 2 * PAD)
        scale = min(room / art.width, room / art.height)
        w, h = round(art.width * scale), round(art.height * scale)
        mascot = art.resize((w, h), Image.LANCZOS)
        canvas.paste(mascot, ((size - w) // 2, (size - h) // 2), mascot)
        canvas.save(path, optimize=True)
        print(f"  {path.relative_to(ROOT)}  {size}x{size}  "
              f"{path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
