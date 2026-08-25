# Avatar slicer

Cuts the 24-avatar contact sheet at `Working files/Avatars.png` into individual
files for the kid profiles.

```bash
python3 tools/avatars/build.py
```

Needs `pillow`, `numpy` and `scipy`.

## What it does

The sheet draws each avatar as an ellipse of colour on a cream background, with
a caption underneath. The app draws every kid inside a circle, and an ellipse in
a circle is either squashed or clipped — the figures run right to the bottom of
their ellipse, so clipping costs them their feet. The script finds the ellipses
by looking for everything that is not cream, ignores the captions (too small),
and then for each avatar:

- widens the ellipse out to a true circle, filling the new space with the
  avatar's own backdrop colour taken row by row, so the join is invisible
- knocks the cream outside the circle out to transparency, pulled in a pixel so
  no pale halo survives at the edge
- leaves the artwork itself uncropped — zooming in to fill more of the circle
  costs the clothing and props that tell the characters apart
- writes a `.png` and a `.webp` at 224px, matching the rest of `images/`

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
