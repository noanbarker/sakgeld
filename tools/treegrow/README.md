# The savings-tree clip

An MP4 of the money-tree moment from the landing page — the counter climbing
from R0 to R5 000 while the tree grows under it.

Silent, six and a half seconds, no headline and no logo. Whatever words go with
a post get written in the post.

Three cuts. `reel` is the phone's treatment — the running tally with one tree
under it, each stage replacing the last — standing in a 1080×1920 frame. That
is the default, and the one to post. `panel` is the desktop row of five trees
side by side, about 16:9. `card` is the whole green card, left-hand words
included.

Every frame is a screenshot of the *real* section: `build.py` lifts the markup
straight out of `index.html`, renders it at one exact moment per frame, and
encodes the result. Nothing is redrawn and nothing is screen recorded. So
restyling the section on the site and re-running is the whole update, and
re-cutting at another size costs nothing.

## Building it

```bash
python3 tools/treegrow/build.py
```

It lands in `Working files/treegrow/`, which is outside the website — nothing
there gets deployed or committed. Upload from there.

```bash
python3 tools/treegrow/build.py --cut panel       # the desktop row of five
python3 tools/treegrow/build.py --cut card        # the whole green card, words and all
python3 tools/treegrow/build.py --aspect 1x1      # padded to a square
python3 tools/treegrow/build.py --currency USD    # the dollar cut
python3 tools/treegrow/build.py --loops 3         # plays through three times
python3 tools/treegrow/build.py --width 1080      # a narrower file
```

`reel` already comes out at 1080×1920, so it wants no `--aspect` at all.
For the other two, `--aspect native` keeps the section's own shape and anything
else pads it out with the card's green — so the artwork keeps its proportions
instead of being stretched or cropped into the new shape.

Each build also writes a `.png` of the final frame: the still to use as a
thumbnail, or as a plain image post.

A run takes about two minutes.

### First time

You need Google Chrome (already on the Mac) plus two Python packages:

```bash
pip3 install --user pillow imageio-ffmpeg
```

`imageio-ffmpeg` brings its own ffmpeg, so there is no Homebrew or system
install to do. The script checks for all of this and says what is missing.

## Changing what it shows

The timeline lives at the top of the script inside `frame.html`: `LEAD` is the
stillness before anything moves, `STAGGER` the gap between one tree and the
next, `GROW` how long a tree takes to come up, `FADE` and `RISE` the phone's
swap from one tree to the next, `COUNT` the counter's tween, and `TAIL` the hold
on the finished forest. Everything else — the crop, the number of frames, which
ones need rendering — follows from those, and `build.py` reads them back out of
the page rather than keeping its own copy.

The reel's proportions are the block of CSS under `body.cut-reel`: the size of
the tally, the height of the box the tree stands in, and how far up the frame
the pair sits. The trees keep their sizes relative to one another whatever that
box is set to, because the phone's own heights are applied as a share of it.

The trees, the milestones and the wording are not set here at all. They come
from `index.html`, and changing them there changes the clip.

## Things that will trip you up

**The tree stage is set twice, on the `<source>` as well as the `<img>`.** Not
belt and braces — a browser that takes the WebP picks it from the `<source>` and
ignores whatever `src` says, so setting only `src` changes nothing at all. That
was a real bug on the phone layout of the live page until 2026-08-27: the tree
grew taller and taller and stayed a seedling the whole way. `index.html` and
`features.html` now do the same thing this page does.

**Headless Chrome won't go below 500px wide.** Ask for a 360px phone viewport
and it quietly gives you 500px and a desktop layout. So the reel's stage is a
fixed 360×640 element inside a roomier window, and the crop is measured off the
element. Captured at 3x that lands on 1080×1920 exactly, with no resampling and
a tree filling about the same pixels as the artwork was drawn at.

**Chrome no longer quits when it is finished.** Chrome 151 writes the
screenshot in about two seconds and then stays up indefinitely. Waiting on its
exit status — the obvious thing, and what `tools/walkthrough` still does —
hangs the build forever with no error. So `run_chrome()` watches for the file,
checks it is complete, and kills Chrome itself.

**A file that exists is not a file that is finished.** Chrome writes a PNG in
pieces, so the wait ends only once the image decodes. Accepting the first
non-empty file gives you a half-written frame that fails somewhere else
entirely, in a different place each run.

**Two builds at once will wreck each other.** They share `.treegrow-build/`,
and whichever finishes first deletes it under the other. `stage()` refuses to
start if the folder is there — if a run was killed and left it behind, delete
it.

**The page's own transitions are switched off during capture.** Each frame is
drawn at an exact moment, so the browser must not be interpolating anything of
its own between them. `frame.html` computes the same easings in JavaScript
instead: the counter's `easeOutCubic`, the slot's `ease-out` fade and its
`cubic-bezier(.22,1,.36,1)` rise, all matching what `index.html` asks CSS for.

**Only about ninety of the 196 frames are actually rendered.** Nothing moves
between one tree finishing and the next starting, or through the closing hold.
Those stretches are captured once and repeated, which is most of why a run takes
two minutes rather than six.

**Measurements come back through `--dump-dom`, which never paints.** So
`frame.html` hands its numbers over on a `setTimeout`, never a
`requestAnimationFrame` — frame callbacks may never run.

**`loading="lazy"` is stripped from the section.** Off-screen images stay
unloaded in a headless capture, and a frame of missing trees looks like a build
that worked.

**The panel cut's crop follows the trees, not the column.** On the page the
artwork sits in a column far wider than it needs. Cropping to that column leaves
a third of the picture empty green down either side.

**The reel's lower third is meant to be empty.** That is where Instagram lays
its caption, the account name and the buttons. The tally and the tree sit above
the middle so none of it gets covered.

**`.treegrow-build/` is temporary.** The script writes the staged page there and
deletes it. It's gitignored and `.vercelignore`d, because a stray copy at the
site root would be served publicly. If a run crashes and leaves it behind, just
delete it.
