# Avatar slicer

Cuts the 24-avatar contact sheet at `Working files/Avatars.png` into individual
files for the kid profiles.

```bash
python3 tools/avatars/build.py
```

Needs `pillow`, `numpy` and `scipy`.

## What it does

The sheet draws each avatar as a solid ellipse of colour on a cream background,
with a caption underneath. The script finds those ellipses by looking for
everything that is not cream, ignores the captions (too small), and then for
each avatar:

- crops to the ellipse's own bounds, so nothing is stretched to a common size
- knocks the cream outside the ellipse out to transparency, pulled in a pixel so
  no pale halo survives at the edge
- writes a `.png` and a `.webp`, matching the rest of `images/`

Output lands in `images/avatars/`, named `avatar-<nn>-<name>.png`. The number
prefix is the position on the sheet and keeps filenames unique — two avatars
share the caption "Raincoat Boy" (05 and 15).

`images/avatars/avatars.json` lists every avatar with its display name, pixel
size and backdrop colour, so the app can pick a matching ring or accent without
re-reading the image.

## Re-running

Safe to re-run; it overwrites in place. If the sheet is ever re-exported at a
different size the script re-measures everything, but it will stop with an error
if it does not find exactly 24 avatars — a sign the background colour or layout
changed and `SHEET_BG` needs a look.
