#!/usr/bin/env python3
"""
Build the social media clips from the live app.

    python3 tools/social/build.py                 # every clip, 9:16, Rand
    python3 tools/social/build.py growing         # just one
    python3 tools/social/build.py --aspect 4x5    # square-ish feed cut
    python3 tools/social/build.py --currency USD  # dollar cut
    python3 tools/social/build.py --stills        # posters only, no video

Output lands in "Working files/social/" — outside the site, so nothing here gets
deployed or committed. Upload the files from there.

Every frame is a screenshot of app/index.html running against seeded demo data,
so the clips always show the product as it actually looks. The motion on top —
the finger, the scrolling, the counting — is built here rather than screen
recorded, which is why it can be re-cut at any size without re-shooting.

How it fits together:

    seed.js      puts the app into a named state and measures it
    canvas.html  draws the brand frame around the phone, and says where the
                 screen goes
    clips.py     the storyboard: which screens, in what order, with what words
    build.py     captures both, moves things, and encodes

The two traps carried over from tools/walkthrough:

  * The app is copied to a throwaway .social-build/ folder at the repo root. It
    has to sit one level below the root, because app/index.html reaches its
    assets via "../images".
  * Headless Chrome clamps its window to a 500px minimum width, so a 390px phone
    viewport can only be had inside an iframe. See frame.html.

Requirements: Google Chrome, Pillow, imageio-ffmpeg.

    pip3 install --user pillow imageio-ffmpeg
"""

import argparse
import functools
import http.server
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from clips import CLIPS, COUNT_USD                      # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
STAGING = ROOT / ".social-build"                        # gitignored; deleted on the way out
OUT_DIR = ROOT / "Working files" / "social"

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

VIEW_W, VIEW_H = 390, 844       # the phone viewport, in CSS pixels
SCALE = 2                       # capture and render at 2x, then downscale to the frame
MAX_TALL = 4200                 # Chrome gets unreliable past a few thousand pixels

ASPECTS = {"9x16": (1080, 1920), "4x5": (1080, 1350), "1x1": (1080, 1080)}
MARGIN = 20                     # CSS pixels of background around the handset
PHONE_RATIO = 2.226             # handset height as a multiple of its screen width

FPS = 30
CROSSFADE = 0.44                # seconds between one beat and the next
DEFAULT_HOLD = 1.8              # seconds a beat rests once it has finished moving
SCROLL_SPEED = 477              # pixels of scroll per second
SCROLL_MIN = 0.46               # ... but never quicker than this
SCROLL_MAX = 1.56               # ... nor slower
PIN_DIGIT = 0.26                # seconds per PIN digit
COUNT_RATE = 0.18               # seconds the balance rests on each figure
TYPE_CHAR = 0.055               # seconds per typed character
PRESS_SECS = 0.50               # button down, held, back up, ring gone
PRESS_STEPS = 4                 # how many depths the press is rendered at
PULSE_SECS = 1.30               # one breath of the ring that points something out


# ─── preflight ────────────────────────────────────────────────────────────────

def preflight():
    missing = []
    if not Path(CHROME).exists():
        missing.append(f"Google Chrome (looked in {CHROME})")
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        missing.append("Pillow            — pip3 install --user pillow")
    try:
        import imageio_ffmpeg  # noqa: F401
    except ImportError:
        missing.append("imageio-ffmpeg    — pip3 install --user imageio-ffmpeg")
    if missing:
        sys.exit("Cannot build. Missing:\n  " + "\n  ".join(missing))
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


# ─── local server ─────────────────────────────────────────────────────────────

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(port):
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def stage():
    """A copy of the real app with the demo-data script appended."""
    # Two builds at once share this folder, and whichever finishes first deletes
    # it — leaving the other serving 404s and producing no screenshots, or a
    # half-written video where both were encoding to the same path. Neither
    # failure says what it is, so refuse the second build outright.
    if STAGING.exists():
        sys.exit(f"{STAGING.name}/ already exists — another build is running.\n"
                 f"Wait for it, or if nothing is running, delete the folder and retry.")
    app = (ROOT / "app" / "index.html").read_text()
    if "</body>" not in app:
        sys.exit("app/index.html has no </body> to inject into — has it moved?")
    STAGING.mkdir(exist_ok=True)
    (STAGING / "index.html").write_text(
        app.replace("</body>", '\n<script src="/.social-build/seed.js"></script>\n</body>', 1))
    for f in ("seed.js", "frame.html", "canvas.html"):
        shutil.copy(HERE / f, STAGING / f)


# ─── driving Chrome ───────────────────────────────────────────────────────────

def chrome_args(url, extra):
    return [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--no-first-run", "--no-default-browser-check",
            "--force-device-scale-factor=%d" % SCALE, "--virtual-time-budget=20000",
            f"--user-data-dir={STAGING}/chrome-profile",
            *extra, url]


def run_chrome(url, css_w, css_h, extra, out, ready, stdout_to=None, patience=60):
    """
    Run Chrome once and wait for the file it was asked to write, not for Chrome.

    Chrome 151 does the work and then simply stays up: the screenshot is on disk
    in a couple of seconds and the process is still running a minute later.
    Waiting on the exit status — which is what this did until Chrome changed
    under it — hangs the build outright, with nothing on stderr to say why. So
    watch the file, and kill Chrome the moment its output is complete.
    """
    out = Path(out)
    out.unlink(missing_ok=True)
    sink = open(stdout_to, "w") if stdout_to else None
    proc = subprocess.Popen(chrome_args(url, [f"--window-size={css_w},{css_h}", *extra]),
                            stdout=sink or subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + patience
        while time.time() < deadline:
            # A file that exists is not a file that is finished — Chrome writes
            # a PNG in pieces, so completeness is decided by the caller.
            if out.exists() and out.stat().st_size and ready(out):
                return True
            if proc.poll() is not None and out.exists() and ready(out):
                return True
            time.sleep(0.05)
        return False
    finally:
        proc.kill()
        proc.wait()
        if sink:
            sink.close()


def png_ready(path):
    from PIL import Image
    try:
        with Image.open(path) as im:
            im.load()          # a truncated file raises here, not on open
        return True
    except (OSError, SyntaxError):
        return False


def shoot(url, css_w, css_h, dest):
    # Retried, because roughly one launch in a few hundred produces nothing
    # usable — sometimes no file, sometimes half a PNG — with nothing on stderr
    # to say so. A clip is hundreds of launches; "rare" happens on most runs,
    # and an unchecked half-file surfaces much later as a crash in the middle of
    # a beat.
    for _ in range(4):
        if run_chrome(url, css_w, css_h, [f"--screenshot={dest}"], dest, png_ready):
            return
    sys.exit(f"Chrome produced no usable screenshot after four tries:\n  {url}")


def probe(url, css_w, css_h):
    """Read the measurements seed.js and canvas.html write onto <html>."""
    dump = STAGING / "dom.html"
    ok = run_chrome(url, css_w, css_h, ["--dump-dom"], dump,
                    lambda p: "</html>" in p.read_text(errors="ignore"), stdout_to=dump)
    if not ok:
        return {}
    m = re.search(r"<html\b([^>]*)>", dump.read_text(errors="ignore"))
    if not m:
        return {}
    return dict(re.findall(r'data-([a-z-]+)="([^"]*)"', m.group(1)))


def nums(s):
    return [int(round(float(v))) for v in s.split(",")] if s else None


# ─── one app screen ───────────────────────────────────────────────────────────

class Screen:
    """
    An app screen, and the ability to look at any scroll position within it.

    A screen is captured twice when it scrolls: once as the phone really shows
    it, and once with the scrolling pane grown to its full height. Looking at
    scroll position y drops a window of the tall capture into the pane's slot on
    the normal one — so the header, the tab bar and a modal's edges stay put
    while only the part that really scrolls moves. Panning the whole screenshot
    instead would slide the furniture off the top, which no phone does.
    """

    def __init__(self, base, pane, tall=None, tall_pane=None, tap=None):
        self.base, self.pane = base, pane
        self.tall, self.tall_pane = tall, tall_pane
        self.tap = tap          # button centre, in the coordinates it was measured in

    @property
    def max_y(self):
        """How far this screen can scroll, in CSS pixels — the storyboard's unit."""
        if self.tall is None:
            return 0
        return max(0, (self.tall_pane[3] - self.pane[3]) / SCALE)

    def tap_at(self, y):
        """The button's outline — x, y, w, h, radius — once scrolled to y."""
        if self.tap is None:
            return None
        x, ty, w, h, r = self.tap
        if self.tall is None:
            return (x, ty, w, h, r)             # measured on the screen as shown
        pt = self.pane[1] / SCALE
        tt = self.tall_pane[1] / SCALE
        return (x, pt + (ty - tt) - min(y, self.max_y), w, h, r)

    def at(self, y):
        y = max(0.0, min(float(y), self.max_y))
        if self.tall is None or (y == 0 and self.max_y == 0):
            return self.base
        off = int(round(y * SCALE))
        pl, pt, pw, ph = self.pane
        tl, tt, tw, _ = self.tall_pane
        win = self.tall.crop((tl, tt + off, tl + min(pw, tw), tt + off + ph))
        out = self.base.copy()
        out.paste(win, (pl, pt))
        return out


# Screens already captured, keyed by the URL that produced them. A state gets
# shot twice in quick succession — once to rest on, again to measure the button
# about to be pressed — and each capture is a second of Chrome.
#
# Kept deliberately small. A screen is four megabytes, or fourteen with its
# full-height twin, and typing a sentence produces one state per letter that is
# never looked at again. Remembering them all costs hundreds of megabytes, which
# on a machine with no swap is enough for the system to kill the build outright
# — silently, mid-capture, with a half-written video left behind.
_SHOTS = OrderedDict()
SHOT_CACHE = 8


def capture_screen(port, scene, currency, params=None, tap=None, scrolls=False):
    """Capture one scene in one state. Returns a Screen."""
    from PIL import Image

    def url(**extra):
        q = {"scene": scene, "cur": currency}
        q.update({k: v for k, v in (params or {}).items() if v is not None})
        if tap:
            q["tap"] = tap
        q.update(extra)
        return f"http://127.0.0.1:{port}/.social-build/frame.html?" + urlencode(q)

    key = (url(), scrolls)
    if key in _SHOTS:
        _SHOTS.move_to_end(key)
        return _SHOTS[key]

    def grab(u, css_h):
        raw = STAGING / "raw.png"
        shoot(u, VIEW_W + 210, css_h + 40, raw)   # a little slack around the iframe
        with Image.open(raw) as im:
            out = im.crop((0, 0, VIEW_W * SCALE, css_h * SCALE)).convert("RGB")
        raw.unlink()
        return out

    # Measuring costs a whole Chrome launch, so only pay for it when something
    # actually needs the numbers: a finger to place, or a scroll to compute.
    # A screen resting at the top needs neither.
    if tap or scrolls:
        a = probe(url(), VIEW_W + 210, VIEW_H + 40)
        pane = [v * SCALE for v in (nums(a.get("pane")) or [0, 0, VIEW_W, VIEW_H])]
        point = nums(a.get("tap"))
    else:
        pane, point = [0, 0, VIEW_W * SCALE, VIEW_H * SCALE], None
    base = grab(url(), VIEW_H)

    tall = tall_pane = None
    if scrolls:
        t = probe(url(tall=1), VIEW_W + 210, VIEW_H + 40)
        tall_h = min(MAX_TALL, int(t.get("tall-h") or VIEW_H))
        if tall_h > VIEW_H:
            tall_pane = [v * SCALE for v in (nums(t.get("pane")) or [0, 0, VIEW_W, tall_h])]
            tall = grab(url(tall=1, h=tall_h), tall_h)
            # Take the button's position from the full-height render too. On the
            # clipped one it is wherever the unscrolled screen happens to put it,
            # which is not where the finger needs to land once we have scrolled.
            point = nums(t.get("tap")) or point

    _SHOTS[key] = Screen(base, pane, tall, tall_pane, point)
    while len(_SHOTS) > SHOT_CACHE:
        _SHOTS.popitem(last=False)
    return _SHOTS[key]


# ─── the brand frame around the phone ─────────────────────────────────────────

class Plate:
    """The still canvas a clip's frames are dropped into: background and bezel."""

    def __init__(self, image, rect, radius, notch=None):
        self.image, self.rect, self.radius = image, rect, radius
        self.notch = notch      # x, y, w, h, corner radius — drawn over each frame


def capture_plate(port, size):
    from PIL import Image
    out_w, out_h = size
    css_w, css_h = out_w // SCALE, out_h // SCALE
    q = {"w": css_w, "h": css_h, "scale": SCALE, "margin": MARGIN}
    url = f"http://127.0.0.1:{port}/.social-build/canvas.html?" + urlencode(q)

    a = probe(url, css_w, css_h)
    if "screen" not in a:
        sys.exit("canvas.html did not report where the phone screen goes.")
    dest = STAGING / "plate.png"
    shoot(url, css_w, css_h, dest)
    with Image.open(dest) as im:
        image = im.crop((0, 0, out_w, out_h)).convert("RGB")
    dest.unlink()
    return Plate(image, nums(a["screen"]), int(a["radius"]), nums(a.get("notch")))


def device_size(width=1080):
    """A canvas cropped to the handset itself, for when a background is unwanted."""
    phone_w = (width - MARGIN * SCALE * 2) / 1.062
    height = round(phone_w * PHONE_RATIO) + MARGIN * SCALE * 2
    return (width, height + height % 2)


# ─── motion ───────────────────────────────────────────────────────────────────

def ease(t):
    """Slow at both ends. Movement that starts and stops abruptly reads as a glitch."""
    return t * t * (3 - 2 * t)


def ease_out(t):
    return 1 - (1 - t) ** 3


def fit(img, plate):
    """One app screen, sized to the hole in the plate."""
    from PIL import Image
    return img.resize((plate.rect[2], plate.rect[3]), Image.LANCZOS)


def press_amount(t):
    """How far the button is pushed in, across a press. t runs 0→1."""
    if t < 0.34:
        return ease(t / 0.34)
    if t < 0.50:
        return 1.0
    return 1 - ease((t - 0.50) / 0.50)


def draw_ring(img, rect, t):
    """
    The ring that leaves a button as it is released.

    The push itself is rendered by the app — the button really does shrink and
    dim. This is the part the app has no state for: a highlight spreading out
    from the button's own outline, which is what carries the press at a glance
    on a silent clip.
    """
    from PIL import Image, ImageDraw
    if not rect or t < 0.42:
        return img
    k = ease_out(min(1.0, (t - 0.42) / 0.58))
    alpha = int(200 * (1 - k))
    if alpha < 3:
        return img

    w, h = img.size
    sx, sy = w / VIEW_W, h / VIEW_H
    x, y, bw, bh, r = rect
    spread = 5 + 16 * k

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        [x * sx - spread, y * sy - spread, (x + bw) * sx + spread, (y + bh) * sy + spread],
        radius=(r + spread) * sx, outline=(22, 163, 74, alpha),
        width=max(2, int(w * 0.007 * (1 - k * 0.4))))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def draw_pulse(img, rect, t):
    """
    A ring drawn round something already on the screen, to point at it.

    Not a press — nothing is being touched. It is how the clip says "this row,
    this one" about a line in a list that a viewer has no reason to pick out on
    their own. It breathes rather than sitting still, because a static outline
    on a still screen reads as part of the design.
    """
    from PIL import Image, ImageDraw
    if not rect:
        return img
    w, h = img.size
    sx, sy = w / VIEW_W, h / VIEW_H
    x, y, bw, bh, r = rect

    # Two breaths over the shot: in quickly, out slowly, and never all the way
    # out — the ring has to still be there when the frame is paused on.
    phase = (t % PULSE_SECS) / PULSE_SECS
    k = 0.55 + 0.45 * (ease_out(phase / 0.3) if phase < 0.3 else 1 - ease((phase - 0.3) / 0.7))
    spread = 6 * sx

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        [x * sx - spread, y * sy - spread, (x + bw) * sx + spread, (y + bh) * sy + spread],
        radius=(r + 6) * sx, outline=(22, 163, 74, int(235 * k)),
        width=max(3, int(w * 0.009)))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def highlight_frames(scr, plate, y, rect, secs):
    """The screen held still with the ring pulsing on it. One render, many frames."""
    base = fit(scr.at(y), plate)
    for i in range(round(secs * FPS)):
        yield draw_pulse(base, rect, i / FPS)


def scroll_frames(scr, plate, a, b):
    """A pan from a to b. A short one should not take as long as a long one."""
    secs = min(SCROLL_MAX, max(SCROLL_MIN, abs(b - a) / SCROLL_SPEED))
    n = max(2, round(secs * FPS))
    for i in range(n):
        yield fit(scr.at(a + (b - a) * ease(i / (n - 1))), plate)


def press_frames(shot, plate, y, target, secs=None):
    """
    A button being pressed.

    The app renders the push — a handful of depths, held for a few frames each,
    which is enough for half a second of movement. The ring on the way back out
    is drawn here, from the button's measured outline.
    """
    n = max(2, round((secs or PRESS_SECS) * FPS))

    # One render per depth, reused across the frames that sit at that depth.
    # Only the first asks for a measurement: the button is measured before any
    # press shrinks it, so the outline is the same at every depth, and each
    # measurement is a whole Chrome launch of its own.
    at_rest = shot(tap=target, press=target, amt=0)
    rect = at_rest.tap_at(y)
    depths = {0: fit(at_rest.at(y), plate)}
    for i in range(1, PRESS_STEPS + 1):
        depths[i] = fit(shot(press=target, amt=round(i / PRESS_STEPS, 3)).at(y), plate)

    for i in range(n):
        t = i / (n - 1)
        yield draw_ring(depths[round(press_amount(t) * PRESS_STEPS)], rect, t)


def rest(img, secs):
    """The same frame, held. One image, yielded many times — not many images."""
    for _ in range(round(secs * FPS)):
        yield img


def step_frames(port, beat, currency, plate):
    """
    A beat given as a sequence of small moves: a form being filled in.

    Each step may scroll, then press a button, then change the screen, then
    rest — skipping whichever of those it doesn't need. The state carries over
    from step to step, so a name typed one letter at a time is a list of states
    rather than a list of screens.

    Order matters: the press is drawn on the screen as it stands *before* the
    change it causes, because that is the order a person sees it happen in.
    """
    state = dict(beat.get("params", {}))
    scene = beat["scene"]
    y = float(beat.get("y", 0) or 0)
    last = None

    def shot(tap=None, press=None, amt=None, scrolls=False):
        p = dict(state)
        if press is not None:
            p["press"], p["amt"] = press, amt
        return capture_screen(port, scene, currency, params=p, tap=tap, scrolls=scrolls)

    for st in beat["steps"]:
        # The full-height capture is only worth its two Chrome launches when
        # this step scrolls, or when we are already part-way down the screen.
        deep = y > 0 or "y" in st
        scr = shot(tap=st.get("tap"), scrolls=deep)

        if "y" in st:
            target = scr.max_y if st["y"] == "end" else float(st["y"])
            if abs(target - y) > 1:
                yield from scroll_frames(scr, plate, y, target)
                y = target

        if "tap" in st:
            yield from press_frames(
                lambda **kw: shot(scrolls=deep, **kw), plate, y, st["tap"], st.get("secs"))

        if "type" in st:
            # One capture per character, hard cut between them. Dissolving would
            # turn typing into a smear; a letter appearing is a cut in real life.
            name, text = st["type"]
            per = st.get("rate", TYPE_CHAR)
            for k in range(1, len(text) + 1):
                state[name] = text[:k]
                last = fit(shot(scrolls=deep).at(y), plate)
                yield from rest(last, per)

        if "set" in st:
            state.update(st["set"])

        if st.get("hold"):
            last = fit(shot(scrolls=deep).at(y), plate)
            yield from rest(last, st["hold"])

    if last is None:
        last = fit(shot(scrolls=y > 0).at(y), plate)
        yield last
    yield from rest(last, beat.get("hold", 0))


def beat_screens(port, beat, currency, plate, clip_name):
    """
    Turn one beat of the storyboard into the run of app screens it plays through.

    A plain beat scrolls, then taps, then rests — any of which it may skip.
    Filling, counting and a step list each stand alone, because each is already
    a whole movement.

    Yielded one at a time rather than returned as a list. A form being filled in
    runs to several hundred frames, and a frame is four megabytes; holding a
    whole clip in memory at once is how this ran the machine out of it.
    """
    scene = beat["scene"]
    hold = beat.get("hold", DEFAULT_HOLD)

    # Captures are worth remembering within a beat — a state gets shot once to
    # rest on and again to measure the button about to be pressed — but not
    # across beats, which share nothing and would only pile up.
    _SHOTS.clear()

    if "steps" in beat:
        yield from step_frames(port, beat, currency, plate)
        return

    if "pin" in beat:
        # One capture per digit: the dots really do fill in, rather than a dot
        # being drawn on top of a screenshot of an empty pad.
        lo, hi = beat["pin"]
        last = None
        for n in range(lo, hi + 1):
            last = fit(capture_screen(port, scene, currency, params={"pin": n}).at(0), plate)
            yield from rest(last, PIN_DIGIT)
        yield from rest(last, hold)
        return

    if "count" in beat:
        # The balance climbing, and with it the progress ring and the tree. Each
        # figure is a real render, so everything that depends on the number moves
        # together instead of only the digits changing.
        #
        # Whole units, one at a time. Fractions would show cents the app then
        # rounds for display, so the figure would appear to stall and then jump
        # two at once; and a counter that visibly goes up by one is the point.
        lo, hi = COUNT_USD[clip_name] if currency == "USD" and clip_name in COUNT_USD else beat["count"]
        per = beat.get("rate", COUNT_RATE)
        last = None
        for v in range(int(lo), int(hi) + 1, int(beat.get("step", 1))):
            scr = capture_screen(port, scene, currency, params={"bal": v})
            last = fit(scr.at(beat.get("y", 0)), plate)
            yield from rest(last, per)
        yield from rest(last, hold)
        return

    scrolls = bool(beat.get("scroll")) or bool(beat.get("y")) or "tap" in beat
    scr = capture_screen(port, scene, currency, params=beat.get("params"),
                         tap=beat.get("tap") or beat.get("ring"), scrolls=scrolls)

    def offset(v):
        # "end" is how far this screen can actually go, which beats writing a
        # number that quietly stops being right when the screen grows a row.
        return scr.max_y if v == "end" else float(v)

    if "scroll" in beat:
        a, b = (offset(v) for v in beat["scroll"])
        yield from scroll_frames(scr, plate, a, b)
        y = b
    else:
        y = offset(beat.get("y", 0))

    if "tap" in beat:
        def shot(tap=None, press=None, amt=None):
            p = dict(beat.get("params") or {})
            if press is not None:
                p["press"], p["amt"] = press, amt
            return capture_screen(port, scene, currency, params=p, tap=tap, scrolls=scrolls)
        yield from press_frames(shot, plate, y, beat["tap"], beat.get("secs"))

    if "ring" in beat:
        yield from highlight_frames(scr, plate, y, scr.tap_at(y), hold)
        return

    yield from rest(fit(scr.at(y), plate), hold)


# ─── assembling and encoding ──────────────────────────────────────────────────

def compose(plate, screen, mask):
    out = plate.image.copy()
    out.paste(screen, (plate.rect[0], plate.rect[1]), mask)
    return out


def paste_screen(plate, screen, mask):
    """One app frame, dropped into the handset, with the camera notch on top."""
    from PIL import ImageDraw
    out = plate.image.copy()
    out.paste(screen, (plate.rect[0], plate.rect[1]), mask)
    if plate.notch:
        x, y, w, h, r = plate.notch
        # Square along the top, where it meets the bezel; rounded where it hangs
        # down into the screen.
        ImageDraw.Draw(out).rounded_rectangle(
            [x, y - r, x + w, y + h], radius=r, fill=(11, 15, 21),
            corners=(False, False, True, True))
    return out


def rounded_mask(w, h, r):
    from PIL import Image, ImageDraw
    # Drawn at 4x and shrunk, because PIL's rounded rectangle has no antialiasing
    # of its own and a hard-edged corner against a dark bezel is very visible.
    m = Image.new("L", (w * 4, h * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1], radius=r * 4, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def render(ffmpeg, plate, beats, mp4, poster, crf):
    """
    Walk the beats, crossfading between them, straight into ffmpeg.

    Beats arrive as generators and frames are written as they are made. Only the
    handful held back for the next crossfade is ever in memory at once: a frame
    is four megabytes, and the setup clip runs past seven hundred of them.
    Holding a whole clip is what ran the machine out of memory.

    Returns the number of frames written.
    """
    from PIL import Image
    from collections import deque
    from itertools import islice

    fade_n = round(CROSSFADE * FPS)
    mask = rounded_mask(*plate.rect[2:], plate.radius)
    w, h = plate.image.size
    first = None
    written = 0

    proc = subprocess.Popen(
        [ffmpeg, "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
         "-an",
         "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-crf", str(crf), "-preset", "slow",
         "-g", str(FPS * 2), "-movflags", "+faststart", str(mp4)],
        stdin=subprocess.PIPE)

    def write(screen):
        nonlocal first, written
        out = paste_screen(plate, screen, mask)
        if first is None:
            first = out.copy()
        proc.stdin.write(out.tobytes())
        written += 1

    tail = []                     # the previous beat's last frames, held back
    for it in beats:
        it = iter(it)
        if tail:
            head = list(islice(it, len(tail)))
            for j, f in enumerate(head):
                write(Image.blend(tail[j], f, (j + 1) / (len(tail) + 1)))
            for f in tail[len(head):]:
                write(f)          # the beat was shorter than the crossfade
            tail = []
        pending = deque()
        for f in it:
            pending.append(f)
            if len(pending) > fade_n:
                write(pending.popleft())
        tail = list(pending)
    for f in tail:
        write(f)                  # the last beat has nothing to fade into

    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit(f"ffmpeg failed writing {mp4.name}")
    if first is not None:
        first.save(poster, quality=90, method=6)
    return written


def stitch(ffmpeg, parts, out, poster):
    """
    Join the section clips into one reel, crossfading between them.

    The reel is assembled from finished sections rather than captured in one
    fifteen-beat run. That run took a quarter of an hour and kept dying part way
    through with nothing to show for it — one long build has no way to survive
    anything going wrong, and no way to resume. Sections are minutes each, they
    can be checked on their own, and reworking one costs one section instead of
    the lot.

    `parts` is a list of (path, seconds).
    """
    inputs = []
    for path, _ in parts:
        inputs += ["-i", str(path)]

    # xfade overlaps each pair, so every join shortens the reel by one crossfade
    # and every later offset has to account for all the ones before it.
    graph, prev, elapsed = [], "0:v", 0.0
    for i, (_, secs) in enumerate(parts[:-1]):
        elapsed += secs if i == 0 else secs
        offset = elapsed - CROSSFADE * (i + 1)
        label = f"v{i}"
        graph.append(f"[{prev}][{i + 1}:v]xfade=transition=fade:"
                     f"duration={CROSSFADE}:offset={offset:.3f}[{label}]")
        prev = label

    args = [ffmpeg, "-y", "-loglevel", "error", *inputs]
    if graph:
        args += ["-filter_complex", ";".join(graph), "-map", f"[{prev}]"]
    args += ["-an", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
             "-crf", "21", "-preset", "slow", "-r", str(FPS),
             "-g", str(FPS * 2), "-movflags", "+faststart", str(out)]
    if subprocess.run(args).returncode != 0:
        sys.exit(f"ffmpeg failed joining {out.name}")

    total = sum(secs for _, secs in parts) - CROSSFADE * (len(parts) - 1)
    shutil.copy(parts[0][0].with_suffix(".webp"), poster)
    return total


def scout(port, scene, currency, dest):
    """
    Save a scene at its full height with a ruler down the side.

    Choosing a scroll offset by trial and error means a rebuild per guess. This
    gives you the whole screen with the numbers written on it, so the offsets in
    clips.py can be read off a picture instead.
    """
    from PIL import Image, ImageDraw
    scr = capture_screen(port, scene, currency, scrolls=True)
    img = (scr.tall or scr.base).convert("RGB")
    w, h = img.size
    out = Image.new("RGB", (w + 96, h), "white")
    out.paste(img, (96, 0))
    d = ImageDraw.Draw(out)
    for css in range(0, int(h / SCALE) + 1, 50):
        y = css * SCALE
        major = css % 250 == 0
        d.line([(96 - (26 if major else 14), y), (96, y)], fill="#94a3b8", width=2)
        if major:
            d.line([(96, y), (w + 96, y)], fill="#e2e8f0", width=1)
            d.text((8, y + 4), str(css), fill="#334155")
    # The window the phone actually shows, if you scrolled to 0.
    d.rectangle([96, 0, w + 95, VIEW_H * SCALE - 1], outline="#16a34a", width=3)
    out.save(dest)
    return dest, int(h / SCALE), round(scr.max_y)


# ─── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="*", help="clip names to build (default: all)")
    ap.add_argument("--aspect", choices=sorted(ASPECTS) + ["device"], default="9x16",
                    help='"device" crops to the handset itself (default: 9x16)')
    ap.add_argument("--currency", choices=["ZAR", "USD"], default="ZAR")
    ap.add_argument("--crf", type=int, default=21, help="H.264 quality, lower is better and bigger")
    ap.add_argument("--stills", action="store_true", help="posters only, skip the video")
    ap.add_argument("--scout", metavar="SCENE",
                    help="save that scene full-height with a ruler, to read scroll offsets off")
    args = ap.parse_args()

    if args.scout:
        preflight()
        port = free_port()
        httpd = None
        try:
            stage()
            httpd = serve(port)
            dest = OUT_DIR / f"scout-{args.scout}.png"
            dest.parent.mkdir(parents=True, exist_ok=True)
            path, total, scrollable = scout(port, args.scout, args.currency, dest)
            print(f"{args.scout}: {total}px tall, scrolls {scrollable}px\n{path}")
        finally:
            if httpd:
                httpd.shutdown(); httpd.server_close()
            shutil.rmtree(STAGING, ignore_errors=True)
        return

    unknown = [c for c in args.clips if c not in CLIPS]
    if unknown:
        sys.exit(f"No such clip: {', '.join(unknown)}\nHave: {', '.join(CLIPS)}")
    wanted = args.clips or list(CLIPS)

    ffmpeg = preflight()
    size = device_size() if args.aspect == "device" else ASPECTS[args.aspect]
    suffix = "" if args.currency == "ZAR" else "-usd"
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    port = free_port()
    httpd = None
    try:
        stage()
        httpd = serve(port)
        print(f"serving {ROOT} on port {port}")
        print(f"{args.aspect} · {args.currency} · {size[0]}×{size[1]}\n")

        # One handset, one background, no words — so the frame is the same for
        # every beat of every clip and is worth rendering once.
        plate = capture_plate(port, size)

        def path_of(name):
            stem = f"{name}-{args.aspect}{suffix}"
            return OUT_DIR / f"{stem}.mp4", OUT_DIR / f"{stem}.webp"

        def build_one(name):
            """One section, straight through to a file. Returns its length."""
            clip = CLIPS[name]
            beats = clip["beats"]
            print(f"{name} — {clip['title']}")

            def beats_of():
                for i, beat in enumerate(beats):
                    print(f"  beat {i + 1}/{len(beats)}  {beat['scene']}")
                    yield beat_screens(port, beat, args.currency, plate, name)

            mp4, poster = path_of(name)
            if args.stills:
                first = next(iter(next(beats_of())))
                paste_screen(plate, first,
                             rounded_mask(*plate.rect[2:], plate.radius)).save(poster, quality=90, method=6)
                print(f"  {poster.name:26} {poster.stat().st_size // 1024:5} KB\n")
                return 0.0
            n = render(ffmpeg, plate, beats_of(), mp4, poster, args.crf)
            secs = n / FPS
            print(f"  {mp4.name:26} {mp4.stat().st_size // 1024:5} KB   {secs:.1f}s\n")
            return secs

        for name in wanted:
            clip = CLIPS[name]
            if "join" not in clip:
                build_one(name)
                continue

            # A joined clip is assembled from its sections, each built and
            # finished on its own. See stitch() for why it is not one long run.
            print(f"{name} — {clip['title']}\n")
            parts = [(path_of(sub)[0], build_one(sub)) for sub in clip["join"]]
            if args.stills:
                continue
            mp4, poster = path_of(name)
            total = stitch(ffmpeg, parts, mp4, poster)
            print(f"{name}: {mp4.name}  {mp4.stat().st_size // 1024} KB   {total:.1f}s\n")

        print(f"written to {OUT_DIR}")
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        # The staging copy must never survive into a commit or a deploy.
        shutil.rmtree(STAGING, ignore_errors=True)


if __name__ == "__main__":
    main()
