"""Slice Working files/Avatars.png into the 24 kid avatars the app uses.

The sheet draws each avatar as an ellipse of colour on a cream background with a
caption underneath. The app draws every kid inside a circle, so a plain crop is
not enough: an ellipse in a circle is either squashed or clipped, and the figures
run right to the bottom of their ellipse, so clipping costs them their feet.

So each avatar is instead widened out to a true circle using its own backdrop
colour, then zoomed slightly — drawn as they are, the character sits in a lot of
empty colour, which looks generous at 80px and reads as a speck at 32px.

    python3 tools/avatars/build.py

Writes PNG + WebP pairs to images/avatars/, matching how the rest of images/ is
stored. It owns that folder: existing avatar files are cleared first, so a
rename here does not leave a stale file behind.
"""

import json
import pathlib

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "Working files" / "Avatars.png"
OUT_DIR = ROOT / "images" / "avatars"

# Cream sheet background, and how far a pixel must sit from it to count as art.
SHEET_BG = np.array([251, 243, 233])
BG_TOLERANCE = 30

# Anything smaller than this is a caption, not an avatar.
MIN_BLOB = 80

# Pull each mask in slightly so the cream the source antialiased into an edge
# does not survive as a pale halo.
EDGE_INSET = 1.0

# Supersampling factor for the circular alpha, so edges stay smooth.
SS = 4

# How much to zoom in, and where to hold the crop. A little over 1 fills the
# circle without reaching the sprout leaves; the bias keeps the crop high, since
# the leaves matter and the bottom of the body does not.
ZOOM = 1.15
ZOOM_BIAS = 0.30

# One output size for all 24, so nothing in the app has to think about it.
# Comfortably over twice the largest size the app draws (80px on the PIN screen).
OUT_SIZE = 224

# Names as captioned on the sheet, in reading order. The sheet captions two
# avatars "Raincoat Boy"; they are numbered here so each name is its own.
# These never appear on screen — the picker is pictures only — so they exist for
# filenames, alt text and our own reference.
NAMES = [
    "Safari Boy", "Cap Boy", "Gardener Boy", "Scholar Boy", "Raincoat Boy 1", "Winter Boy",
    "Hiker Boy", "Sporty Boy", "Bow Girl", "Sunhat Girl", "Flower Girl", "Sunny Girl",
    "Explorer Boy", "Adventure Boy", "Raincoat Boy 2", "Surfer Boy", "Smarty Boy", "Team Boy",
    "Gardener Girl", "Explorer Girl", "Farmer Girl", "Artist Girl", "Bookworm Girl", "Sporty Girl",
]


def slug(name):
    return name.lower().replace(" ", "-")


def find_avatars(mask):
    """Return the 24 avatar bounding boxes in reading order."""
    labels, _ = ndimage.label(mask)
    boxes = []
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        rows, cols = box
        if rows.stop - rows.start > MIN_BLOB and cols.stop - cols.start > MIN_BLOB:
            boxes.append((index, rows, cols))

    # Group into rows before sorting left to right, since the grid is not
    # perfectly aligned and a plain sort by y would interleave neighbours.
    boxes.sort(key=lambda b: b[1].start)
    rows_of_boxes, current = [], [boxes[0]]
    for box in boxes[1:]:
        if box[1].start - current[0][1].start > MIN_BLOB:
            rows_of_boxes.append(current)
            current = []
        current.append(box)
    rows_of_boxes.append(current)

    ordered = []
    for row in rows_of_boxes:
        ordered.extend(sorted(row, key=lambda b: b[2].start))
    return ordered


def ellipse_alpha(width, height):
    """An antialiased filled ellipse that fits the given box."""
    ys, xs = np.mgrid[0:height * SS, 0:width * SS]
    cx, cy = width * SS / 2, height * SS / 2
    rx, ry = cx - EDGE_INSET * SS, cy - EDGE_INSET * SS
    inside = ((xs + 0.5 - cx) / rx) ** 2 + ((ys + 0.5 - cy) / ry) ** 2 <= 1
    return _coverage_to_mask(inside, width, height)


def circle_alpha(size):
    """An antialiased filled circle that fits a square of the given size."""
    ys, xs = np.mgrid[0:size * SS, 0:size * SS]
    centre = size * SS / 2
    radius = centre - EDGE_INSET * SS
    inside = (xs + 0.5 - centre) ** 2 + (ys + 0.5 - centre) ** 2 <= radius ** 2
    return _coverage_to_mask(inside, size, size)


def _coverage_to_mask(inside, width, height):
    coverage = inside.reshape(height, SS, width, SS).mean(axis=(1, 3))
    return Image.fromarray((coverage * 255).round().astype(np.uint8))


def widen_to_circle(oval, alpha):
    """Grow an oval crop into a square by extending its backdrop sideways.

    Each row is filled outward with the colour of the oval's own edge pixel on
    that row, so a backdrop that shades or carries snowflakes still lines up.
    The oval is then composited back on top, letting its antialiased edge win.
    """
    pixels = np.asarray(oval.convert("RGB"))
    mask = np.asarray(alpha)
    height, width = mask.shape
    size = height
    inset = (size - width) // 2

    canvas = np.zeros((size, size, 3), np.uint8)
    canvas[:, inset:inset + width] = pixels
    for y in range(height):
        opaque = np.where(mask[y] > 200)[0]
        if len(opaque) < 2:
            opaque = np.where(mask[y] > 40)[0]
        if len(opaque) < 2:
            continue
        left, right = opaque[0], opaque[-1]
        canvas[y, :inset + left] = pixels[y, left]
        canvas[y, inset + right + 1:] = pixels[y, right]

    square = Image.fromarray(canvas).convert("RGBA")
    oval_rgba = oval.convert("RGBA")
    oval_rgba.putalpha(alpha)
    square.alpha_composite(oval_rgba, (inset, 0))
    return square


def zoom_in(square):
    """Scale up and re-crop, holding the crop high so the leaves survive."""
    size = square.width
    grown = square.resize((round(size * ZOOM), round(size * ZOOM)), Image.LANCZOS)
    left = (grown.width - size) // 2
    top = round((grown.height - size) * ZOOM_BIAS)
    return grown.crop((left, top, left + size, top + size))


def backdrop_colour(pixels, rows, cols):
    """The avatar's own backdrop colour, sampled just inside its left edge."""
    y = (rows.start + rows.stop) // 2
    x = cols.start + 4
    return "#%02x%02x%02x" % tuple(pixels[y, x])


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in list(OUT_DIR.glob("avatar-*.png")) + list(OUT_DIR.glob("avatar-*.webp")):
        stale.unlink()

    sheet = Image.open(SOURCE).convert("RGB")
    pixels = np.asarray(sheet).astype(int)
    mask = np.abs(pixels - SHEET_BG).sum(axis=2) > BG_TOLERANCE

    boxes = find_avatars(mask)
    if len(boxes) != len(NAMES):
        raise SystemExit(f"expected {len(NAMES)} avatars on the sheet, found {len(boxes)}")

    round_mask = circle_alpha(OUT_SIZE)
    manifest = []
    for number, ((_, rows, cols), name) in enumerate(zip(boxes, NAMES), start=1):
        width, height = cols.stop - cols.start, rows.stop - rows.start
        oval = sheet.crop((cols.start, rows.start, cols.stop, rows.stop))

        avatar = widen_to_circle(oval, ellipse_alpha(width, height))
        avatar = zoom_in(avatar).resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
        avatar.putalpha(round_mask)

        stem = f"avatar-{number:02d}-{slug(name)}"
        avatar.save(OUT_DIR / f"{stem}.png")
        avatar.save(OUT_DIR / f"{stem}.webp", quality=90, method=6)

        manifest.append({
            "id": number,
            "name": name,
            "file": stem,
            "colour": backdrop_colour(pixels, rows, cols),
        })
        print(f"{stem}  {manifest[-1]['colour']}")

    (OUT_DIR / "avatars.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\n{len(manifest)} avatars at {OUT_SIZE}px written to {OUT_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
