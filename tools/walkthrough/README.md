# Walkthrough clips

The three short clips in the **How It Works** section of `index.html` and
`how-it-works.html`. Each numbered step has its own silent looping MP4.

Every frame is a screenshot of the real app running against fake demo data — not
a drawing of it. So when the app's look changes, you re-run this and the
marketing pages catch up. No redrawing, no hand-editing.

## Rebuilding them

```bash
python3 tools/walkthrough/build.py
```

Takes about a minute and writes into `images/marketing/walkthrough/`. Review the
result, then commit.

```bash
python3 tools/walkthrough/build.py --currency ZAR   # just the Rand cut, faster
python3 tools/walkthrough/build.py --keep-screens   # leave the PNGs to inspect
python3 tools/walkthrough/build.py --crf 22         # better quality, bigger files
```

### First time

You need Google Chrome (already on the Mac) plus two Python packages:

```bash
pip3 install --user pillow imageio-ffmpeg
```

`imageio-ffmpeg` brings its own ffmpeg, so there's no Homebrew or system install
to do. The script checks for all of this and tells you what's missing.

## What gets built

| File | What it shows |
|---|---|
| `step1.mp4` | Parent adds Zoe, then adds the Make Bed chore |
| `step2.mp4` | Zoe's screen: today's chores, then Make Bed waiting for approval |
| `step3.mp4` | Parent's queue of three, then cleared with balances moved |

Each also gets a `-poster.webp` (the still shown before playback starts) and a
`-usd` twin for visitors outside South Africa. Twelve files in all.

A clip rests on its first screen, crossfades to the second, rests, then fades
back — so it loops without a visible seam.

## Changing what the clips show

`seed.js` holds the pretend family: the children, the chores, the amounts, and
which screen each of the six scenes lands on. Change it there and rebuild.

The six scenes pair into the three steps: 1+2, 3+4, 5+6. If you add a scene,
`SCENES` and `STEPS` at the top of `build.py` need to know about it.

## Things that will trip you up

**The clips are the phone screen only.** The device shell around them is drawn in
CSS on the marketing pages (`.pr-clip-shell`). That's deliberate — all three
steps then share one identical shell, it stays sharp instead of being softened by
video compression, and no bytes are wasted encoding a bezel. If you change the
video dimensions, check the shell still fits.

**Headless Chrome won't go below 500px wide.** Ask it for a 390px phone viewport
and it quietly gives you 500px and a desktop layout. That's why the app is
rendered inside a fixed 390px iframe (`frame.html`) and the screenshot is cropped
to it. Don't "simplify" that away.

**`.walkthrough-build/` is temporary.** The script copies the app there, works
from it, and deletes it. It's gitignored and `.vercelignore`d, because a stray
copy of the app at the site root would be served publicly. If a run crashes and
leaves it behind, just delete it.

**Output is not byte-identical between runs.** Re-running produces clips a few
pixels different in places — chore icons render at very slightly different sizes
depending on which image source Chrome resolves first. It's invisible to the eye,
but it does mean git will show the files as changed even when nothing meaningful
did. Only commit a rebuild you actually meant to make.

**The date is today's date.** The kid screen shows "Today's chores — Monday, 24
Aug" or whatever day you build on. Nothing depends on it, but that's why the
files change if you rebuild on a different day.

## Where the pages use them

- `index.html` — three columns, clip above each numbered card (mobile flips this:
  card above clip)
- `how-it-works.html` — clip beside each numbered row
- `js/walkthrough-clips.js` — swaps in the `-usd` files outside South Africa, and
  holds off loading each clip until it scrolls into view
