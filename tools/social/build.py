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
COUNT_SECS = 1.69               # how long the balance takes to climb
COUNT_STEPS = 14                # how many balances the climb passes through
TAP_SECS = 0.81                 # finger down, press, ripple, gone
TYPE_CHAR = 0.14                # seconds per typed character — a real thumb's pace


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
            "--force-device-scale-factor=%d" % SCALE, "--virtual-time-budget=20000",
            *extra, url]


def shoot(url, css_w, css_h, dest):
    # Retried, because roughly one launch in a few hundred comes back having
    # written nothing at all — no error, no file. A form being filled in is
    # hundreds of launches, so "rare" happens every run.
    dest = Path(dest)
    for attempt in range(3):
        dest.unlink(missing_ok=True)
        subprocess.run(
            chrome_args(url, [f"--window-size={css_w},{css_h}", f"--screenshot={dest}"]),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if dest.exists():
            return
    sys.exit(f"Chrome produced no screenshot after three tries:\n  {url}")


def probe(url, css_w, css_h):
    """Read the measurements seed.js and canvas.html write onto <html>."""
    out = subprocess.run(
        chrome_args(url, [f"--window-size={css_w},{css_h}", "--dump-dom"]),
        capture_output=True, text=True).stdout
    m = re.search(r"<html\b([^>]*)>", out)
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
        """Where the button has got to once the screen is scrolled to y."""
        if self.tap is None:
            return None
        x, ty = self.tap
        if self.tall is None:
            return (x, ty)                      # measured on the screen as shown
        pt = self.pane[1] / SCALE
        tt = self.tall_pane[1] / SCALE
        return (x, pt + (ty - tt) - min(y, self.max_y))

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


# Screens already captured this clip, keyed by the URL that produced them. A
# form being filled in revisits the same state repeatedly — once to rest on it,
# again to measure the button about to be pressed — and each capture is a second
# of Chrome.
_SHOTS = {}


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


def draw_tap(img, point, t):
    """
    A finger landing on a button, drawn over the screen.

    t runs 0→1 across the press. The disc arrives, shrinks as it makes contact,
    and two rings spread out from under it — the same shape a real touch ripple
    makes. Deliberately emphatic: on a silent clip watched at arm's length this
    is the only thing telling the viewer which button caused what happens next.
    """
    from PIL import Image, ImageDraw
    if not point:
        return img
    w, h = img.size
    cx = point[0] / VIEW_W * w
    cy = point[1] / VIEW_H * h
    r0 = w * 0.082

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def ring(radius, colour, alpha, width):
        if alpha > 2:
            d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                      outline=colour + (int(alpha),), width=max(2, int(width)))

    if t < 0.26:                      # arriving
        k = ease(t / 0.26)
        r, on = r0 * (1.55 - 0.55 * k), k
    elif t < 0.50:                    # held down
        r, on = r0 * 0.80, 1.0
    else:                             # lifting
        k = ease((t - 0.50) / 0.50)
        r, on = r0 * (0.80 + 0.20 * k), 1 - k

    # The fingertip: light enough to read the label under it, ringed so it still
    # has a hard edge on a white card.
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, int(150 * on)))
    ring(r, (15, 23, 42), 190 * on, w * 0.006)

    # Two rings leaving the point of contact, the second trailing the first.
    for delay, weight in ((0.30, 1.0), (0.42, 0.6)):
        if t >= delay:
            k = ease_out(min(1.0, (t - delay) / 0.55))
            ring(r0 * (0.9 + 2.9 * k), (22, 163, 74), 200 * weight * (1 - k), w * 0.008 * (1 - k * 0.5))

    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def scroll_frames(scr, plate, a, b):
    """A pan from a to b. A short one should not take as long as a long one."""
    secs = min(SCROLL_MAX, max(SCROLL_MIN, abs(b - a) / SCROLL_SPEED))
    n = max(2, round(secs * FPS))
    for i in range(n):
        yield fit(scr.at(a + (b - a) * ease(i / (n - 1))), plate)


def tap_frames(scr, plate, y):
    n = max(2, round(TAP_SECS * FPS))
    still = fit(scr.at(y), plate)
    point = scr.tap_at(y)
    for i in range(n):
        yield draw_tap(still, point, i / (n - 1))


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

    def shot(tap=None, scrolls=False):
        return capture_screen(port, scene, currency, params=state, tap=tap, scrolls=scrolls)

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
            yield from tap_frames(scr, plate, y)

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
        # step is a real render, so everything that depends on the number moves
        # together instead of only the digits changing.
        lo, hi = COUNT_USD[clip_name] if currency == "USD" and clip_name in COUNT_USD else beat["count"]
        last = None
        for i in range(COUNT_STEPS + 1):
            v = lo + (hi - lo) * ease_out(i / COUNT_STEPS)
            scr = capture_screen(port, scene, currency, params={"bal": round(v, 2)})
            last = fit(scr.at(beat.get("y", 0)), plate)
            yield from rest(last, COUNT_SECS / COUNT_STEPS)
        yield from rest(last, hold)
        return

    scrolls = bool(beat.get("scroll")) or bool(beat.get("y")) or "tap" in beat
    scr = capture_screen(port, scene, currency, params=beat.get("params"),
                         tap=beat.get("tap"), scrolls=scrolls)

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
        yield from tap_frames(scr, plate, y)

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

        for name in wanted:
            clip = CLIPS[name]
            total = len(clip["beats"])
            print(f"{name} — {clip['title']}")

            def beats_of(clip=clip, name=name, total=total):
                for i, beat in enumerate(clip["beats"]):
                    print(f"  beat {i + 1}/{total}  {beat['scene']}")
                    yield beat_screens(port, beat, args.currency, plate, name)

            stem = f"{name}-{args.aspect}{suffix}"
            poster = OUT_DIR / f"{stem}.webp"
            mp4 = OUT_DIR / f"{stem}.mp4"
            if args.stills:
                first = next(iter(next(beats_of())))
                paste_screen(plate, first,
                             rounded_mask(*plate.rect[2:], plate.radius)).save(poster, quality=90, method=6)
                print(f"  {poster.name:26} {poster.stat().st_size // 1024:5} KB\n")
            else:
                n = render(ffmpeg, plate, beats_of(), mp4, poster, args.crf)
                print(f"  {mp4.name:26} {mp4.stat().st_size // 1024:5} KB   {n / FPS:.1f}s\n")

        print(f"written to {OUT_DIR}")
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        # The staging copy must never survive into a commit or a deploy.
        shutil.rmtree(STAGING, ignore_errors=True)


if __name__ == "__main__":
    main()
