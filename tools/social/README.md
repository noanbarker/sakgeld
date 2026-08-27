# Social clips

Short, silent, looping clips of the real app, framed as a handset on a plain
background. No headlines and no logo — the clip is the screen, and whatever
words go with a post get written in the post.

The six sections each run under seven seconds. `full` is all of them joined, for
a Reel.

| Clip | What it shows |
|---|---|
| `add-child` | The parent adds Zoe — her name and PIN typed, her colour and avatar chosen |
| `add-chore` | The same for a chore: Make Bed typed in, its illustration picked |
| `kid-login` | Zoe picks herself, taps in her PIN, lands on today's chores |
| `mark-done` | Zoe taps **Done!** and the chore moves to waiting for approval |
| `approve` | The parent taps **Approve all** and the balance moves |
| `growing` | The savings climb a rand at a time and the tree grows from Small Tree to Big Tree |
| `full` | All six, joined into one reel — about half a minute |

One thread runs through it: Make Bed is added, Zoe marks Make Bed done, the
parent approves Zoe's Make Bed, and her balance moves by exactly that R5.

Every frame is a screenshot of `app/index.html` running against fake demo data —
not a drawing of it, and not a screen recording either. The app is real; the
movement over it is built. So changing the app's look and re-running is the whole
update, and re-cutting at another size costs nothing.

## Building them

```bash
python3 tools/social/build.py
```

They land in `Working files/social/`, which is outside the website — nothing here
gets deployed or committed. Upload from there.

```bash
python3 tools/social/build.py add-child          # just one clip
python3 tools/social/build.py --aspect 4x5       # feed cut instead of 9:16
python3 tools/social/build.py --aspect device    # cropped to the handset itself
python3 tools/social/build.py --currency USD     # dollar amounts
python3 tools/social/build.py --stills           # posters only, much quicker
```

Sizes: `9x16` (1080×1920, Reels/Stories/TikTok, the default), `4x5` (1080×1350,
the tallest an Instagram feed post can be), `1x1` (1080×1080), and `device`,
which crops to the handset and leaves almost no background.

Each clip also writes a `.webp` of its first frame — the still to use as a
thumbnail, or as a plain image post.

The two form clips take a few minutes each: every typed letter and every depth
of a button press is a fresh capture. The other four are well under a minute, and
`full` is the sum of all six plus a moment to join them.

`full` is assembled from finished section files rather than captured in one long
run. A twenty-minute build has no way to survive anything going wrong and no way
to resume; sections can be checked on their own, and reworking one costs one
section. `join` in `clips.py` lists them, so a section and the reel can never
drift apart.

### First time

You need Google Chrome (already on the Mac) plus two Python packages:

```bash
pip3 install --user pillow imageio-ffmpeg
```

`imageio-ffmpeg` brings its own ffmpeg, so there is no Homebrew or system install
to do. The script checks for all of this and says what is missing.

## Changing what the clips show

`clips.py` is the storyboard — the order, the pacing, which screen each beat
lands on, what gets typed into which field. It is meant to be edited. `build.py`
is the engine and shouldn't need touching for any of that.

A simple beat scrolls, then taps, then rests, skipping whichever it doesn't need:

```python
{"scene": "kid-today", "y": 280, "tap": "text:Done!", "hold": 0.7}
```

A beat that fills in a form uses `steps` — a list of small moves that carry
state from one to the next:

```python
{"scene": "add-kid", "params": {"name": "", "kpin": ""}, "steps": [
    {"type": ("name", "Zoe"), "hold": 0.2},
    {"type": ("kpin", "1234"), "hold": 0.2},
    {"tap": "[onclick*=\"pickKidColor('coral')\"]"},
    {"set": {"colour": "coral"}, "hold": 0.25},
    {"y": "end", "tap": "text:Add"},
]}
```

Press the decisions, not every field. Tapping a box before typing in it is true
to life but tells a viewer nothing, and each press costs half a second.

`seed.js` holds the pretend family — the children, the chores, the amounts — and
the named scenes. Add a scene there and `clips.py` can use it.

### Pacing

The constants at the top of `build.py` set the pace of everything: `TYPE_CHAR` is
seconds per typed letter, `PRESS_SECS` a whole button press, `SCROLL_SPEED`
pixels per second, `CROSSFADE` the join between beats. Change one and every clip
follows.

`PRESS_STEPS` is how many depths a press is rendered at — more is smoother and
slower to build, since each depth is its own capture.

### Finding a scroll position

Guessing `y` means a rebuild per guess. Don't:

```bash
python3 tools/social/build.py --scout kid-today
```

That writes the whole screen at full height with a ruler down the side and the
phone's own window outlined in green, so the numbers can be read off a picture.

## Things that will trip you up

**A press is rendered by the app, not drawn over it.** `seed.js` pushes the real
button in and dims it, so it keeps its own shape, shadow and background. Only the
ring that spreads out as it lifts is drawn here, from the button's measured
outline — the app has no state for that. A marker floating above the screen would
sit over the very label the viewer needs to read.

**A tap is aimed at a target, never a coordinate.** Either a label (`text:Done!`)
or anything a CSS selector reaches (`#k-name`, or
`[onclick*="pickKidColor('coral')"]`, since the colour swatches and icon tiles
carry their value in their onclick). `seed.js` measures the real element, so the
finger follows its button when the layout changes. Coordinates would go stale
silently.

**Scrolling keeps the furniture still.** A screen is captured twice: as the phone
shows it, and again with its scrolling pane grown to full height. Panning drops a
window of the second into the first, so headers and a modal's edges stay put.
Panning the whole screenshot would slide them off the top, which no phone does.

**Almost nothing in the app scrolls the way you'd assume.** Its panes sit under
`min-height:100vh`, so they grow with their content and the *document* is what
scrolls. A modal sheet is the exception — capped at 90vh, it really does scroll
inside a still screen. `seed.js` works out which case it is; don't hard-code it.

**An absent parameter and an empty one mean different things.** Leaving `name`
out of a beat's params gives the finished value; passing `""` gives an empty
field. That is how a form can be shown part-filled.

**Every screenshot is decoded before it is accepted.** Roughly one Chrome launch
in a few hundred fails — sometimes writing no file, sometimes half a PNG — with a
zero exit status and nothing on stderr. Checking only that a file appeared lets
the half-written one through, and it then fails somewhere else entirely, in a
different place each run. `shoot()` decodes and retries. Don't take that out.

**Two builds at once will wreck each other.** They share `.social-build/`, and
whichever finishes first deletes it under the other. `stage()` refuses to start
if the folder exists — if a run was killed and left it behind, delete it.

**The capture cache is deliberately small.** A screen is four megabytes, or
fourteen with its full-height twin, and typing a sentence makes one state per
letter that is never looked at again. `SHOT_CACHE` bounds it.

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

## Known gaps

`--currency USD` produces a broken `growing` section. The savings-tree thresholds
are fixed absolute figures — 100 / 250 / 500 / 1000 — and do not scale with
currency, so the dollar-sized balances in `COUNT_USD` never cross one and the
tree never grows. Either give the dollar cut its own thresholds or count over a
range that crosses them.

`--stills full` builds the section stills and stops without producing one for the
reel.

`--aspect 4x5`, `1x1` and `device` have not been exercised since the handset
frame was rewritten.

## The handset

Drawn in `canvas.html`: the bezel gradient is the one from `.pr-clip-shell` on
`index.html`, with a wide camera notch cut into the top of the screen. If the
phone on the marketing pages changes, change it here too, or the posts and the
site stop matching.
