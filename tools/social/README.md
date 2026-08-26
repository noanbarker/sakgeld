# Social clips

Short, silent, looping clips of the real app, framed for social media. Five of
them, one per step of the story:

| Clip | What it shows |
|---|---|
| `setup` | Parent adds Zoe — name, avatar, PIN — then adds the Make Bed chore |
| `kid-login` | Zoe picks herself, taps in her PIN, lands on today's chores |
| `mark-done` | Zoe taps **Done!** and the chore moves to waiting for approval |
| `approve` | The parent taps **Approve all** and the balance moves |
| `growing` | The savings climb and the tree grows from Small Tree to Big Tree |

Every frame is a screenshot of `app/index.html` running against fake demo data —
not a drawing of it, and not a screen recording either. The app is real; the
movement over it is built. That is the point: change the app's look, re-run this,
and the clips catch up. Re-cut them at a different size and nothing has to be
re-shot.

## Building them

```bash
python3 tools/social/build.py
```

Roughly four minutes for all five. They land in `Working files/social/`, which is
outside the website — nothing here gets deployed or committed. Upload from there.

```bash
python3 tools/social/build.py growing            # just one clip
python3 tools/social/build.py --aspect 4x5       # feed cut instead of 9:16
python3 tools/social/build.py --currency USD     # dollar amounts
python3 tools/social/build.py --stills           # posters only, much quicker
python3 tools/social/build.py --foot ""          # drop the line along the bottom
```

Sizes: `9x16` (1080×1920, Reels/Stories/TikTok, the default), `4x5` (1080×1350,
the tallest an Instagram feed post can be), `1x1` (1080×1080).

Each clip also writes a `.webp` of its first frame — the still to use as a
thumbnail, or as a plain image post.

### First time

You need Google Chrome (already on the Mac) plus two Python packages:

```bash
pip3 install --user pillow imageio-ffmpeg
```

`imageio-ffmpeg` brings its own ffmpeg, so there is no Homebrew or system install
to do. The script checks for all of this and says what is missing.

## Changing what the clips say and show

`clips.py` is the storyboard — the wording, the order, which screen each beat
lands on. It is meant to be edited. `build.py` is the engine and shouldn't need
touching to reword a caption or reorder a beat.

A beat scrolls, then taps, then rests, skipping whichever of those it doesn't
need:

```python
{"scene": "kid-today", "cap": "One tap when it's done",
 "sub": "No nagging.", "y": 280, "tap": "kid-today", "hold": 0.7}
```

`seed.js` holds the pretend family — the children, the chores, the amounts — and
the named scenes. Add a scene there and `clips.py` can use it.

### Finding a scroll position

Guessing `y` means a rebuild per guess. Don't:

```bash
python3 tools/social/build.py --scout kid-today
```

That writes the whole screen at full height with a ruler down the side and the
phone's own window outlined in green, so the numbers can be read off a picture.

## Things that will trip you up

**A tap is aimed at a button by name, not by coordinate.** `TAP_TARGETS` in
`seed.js` finds the real button and measures it, so the finger follows it when
the layout changes. Coordinates written down here would go stale silently.

**Scrolling keeps the furniture still.** A screen is captured twice: as the phone
shows it, and again with its scrolling pane grown to full height. Panning drops a
window of the second into the first, so headers and a modal's edges stay put.
Panning the whole screenshot would slide them off the top, which no phone does.

**Almost nothing in the app scrolls the way you'd assume.** Its panes sit under
`min-height:100vh`, so they grow with their content and the *document* is what
scrolls. A modal sheet is the exception — capped at 90vh, it really does scroll
inside a still screen. `seed.js` works out which case it is; don't hard-code it.

**Animations are frozen during capture, on purpose.** The kid's chore icons float
on a 3.2 second loop, so without freezing them each capture catches the artwork
mid-bob and no two builds match. The movement in these clips is built on top —
the app's own idle animation would only fight it.

**Measurements come back through `--dump-dom`, which never paints.** So `seed.js`
and `canvas.html` hand their numbers over on a `setTimeout`, never a
`requestAnimationFrame` — frame callbacks may never run. And `frame.html` copies
the iframe's attributes up to itself, because `--dump-dom` only prints the top
document.

**Headless Chrome won't go below 500px wide.** Ask for a 390px phone viewport and
it quietly gives you 500px and a desktop layout. That's why the app renders
inside a fixed 390px iframe. Don't "simplify" that away.

**`.social-build/` is temporary.** The script copies the app there, works from it,
and deletes it. It's gitignored and `.vercelignore`d, because a stray copy of the
app at the site root would be served publicly. If a run crashes and leaves it
behind, just delete it.

**The date is today's date.** The kid screen says "Today's chores — Wednesday, 26
Aug" or whatever day you build on.

## The device shell

The bezel is drawn in `canvas.html`, copied from `.pr-clip-shell` on
`index.html`. If the phone on the marketing pages changes, change it here too, or
the posts and the site stop matching.
