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

FPS = 30
CROSSFADE = 0.34                # seconds between one beat and the next
CAP_SWAP = (0.30, 0.72)         # the slice of a crossfade the words change over
DEFAULT_HOLD = 1.4              # seconds a beat rests once it has finished moving
SCROLL_SPEED = 620              # pixels of scroll per second
SCROLL_MIN = 0.35               # ... but never quicker than this
SCROLL_MAX = 1.20               # ... nor slower
PIN_DIGIT = 0.20                # seconds per PIN digit
COUNT_SECS = 1.30               # how long the balance takes to climb
COUNT_STEPS = 14                # how many balances the climb passes through
TAP_SECS = 0.62                 # finger down, press, ripple, gone


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
    subprocess.run(
        chrome_args(url, [f"--window-size={css_w},{css_h}", f"--screenshot={dest}"]),
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not Path(dest).exists():
        sys.exit(f"Chrome produced no screenshot for {url}")


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


def capture_screen(port, scene, currency, bal=None, pin=None, tap=None, scrolls=False):
    """Capture one scene. Returns (Screen, tap point in phone CSS pixels or None)."""
    from PIL import Image

    def url(**extra):
        q = {"scene": scene, "cur": currency}
        if bal is not None:
            q["bal"] = bal
        if pin is not None:
            q["pin"] = pin
        if tap:
            q["tap"] = tap
        q.update(extra)
        return f"http://127.0.0.1:{port}/.social-build/frame.html?" + urlencode(q)

    def grab(u, css_h):
        raw = STAGING / "raw.png"
        shoot(u, VIEW_W + 210, css_h + 40, raw)   # a little slack around the iframe
        with Image.open(raw) as im:
            out = im.crop((0, 0, VIEW_W * SCALE, css_h * SCALE)).convert("RGB")
        raw.unlink()
        return out

    a = probe(url(), VIEW_W + 210, VIEW_H + 40)
    pane = [v * SCALE for v in (nums(a.get("pane")) or [0, 0, VIEW_W, VIEW_H])]
    point = nums(a.get("tap"))
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

    return Screen(base, pane, tall, tall_pane, point)


# ─── the brand frame around the phone ─────────────────────────────────────────

class Plate:
    """The still canvas a clip's frames are dropped into: background, bezel, words."""

    def __init__(self, image, rect, radius):
        self.image, self.rect, self.radius = image, rect, radius


def capture_plate(port, cap, sub, foot, size):
    from PIL import Image
    out_w, out_h = size
    css_w, css_h = out_w // SCALE, out_h // SCALE
    q = {"w": css_w, "h": css_h, "scale": SCALE, "cap": cap, "sub": sub, "foot": foot}
    url = f"http://127.0.0.1:{port}/.social-build/canvas.html?" + urlencode(q)

    a = probe(url, css_w, css_h)
    if "screen" not in a:
        sys.exit("canvas.html did not report where the phone screen goes.")
    dest = STAGING / "plate.png"
    shoot(url, css_w, css_h, dest)
    with Image.open(dest) as im:
        image = im.crop((0, 0, out_w, out_h)).convert("RGB")
    dest.unlink()
    return Plate(image, nums(a["screen"]), int(a["radius"]))


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
    and a ring spreads out from under it — the same shape a real touch ripple
    makes, which is what makes it read as a press rather than a floating dot.
    """
    from PIL import Image, ImageDraw
    if not point:
        return img
    w, h = img.size
    cx = point[0] / VIEW_W * w
    cy = point[1] / VIEW_H * h
    r0 = w * 0.075

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    if t < 0.30:                      # arriving
        k = ease(t / 0.30)
        r, alpha = r0 * (1.5 - 0.5 * k), int(150 * k)
    elif t < 0.46:                    # pressed
        r, alpha = r0 * 0.84, 150
    else:                             # lifting
        k = ease((t - 0.46) / 0.54)
        r, alpha = r0 * (0.84 + 0.16 * k), int(150 * (1 - k))

    # Kept light on purpose: a solid disc over a button hides the very label the
    # viewer is meant to read. The ring carries the shape, the fill only hints.
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(15, 23, 42, int(alpha * 0.16)))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(15, 23, 42, int(alpha * 0.72)),
              width=max(2, int(w * 0.0042)))

    if t >= 0.38:                     # the ripple spreading out from the press
        k = ease_out(min(1.0, (t - 0.38) / 0.50))
        rr = r0 * (0.9 + 2.4 * k)
        a = int(120 * (1 - k))
        if a > 2:
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                      outline=(22, 163, 74, a), width=max(2, int(w * 0.006)))

    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def beat_screens(port, beat, currency, plate, clip_name):
    """
    Turn one beat of the storyboard into the run of app screens it plays through.

    A beat scrolls, then taps, then rests — any of which it may skip. Filling and
    counting stand alone, because both are already a whole movement.

    Everything comes back sized to the plate's hole, so the frame loop has only
    to paste, never to resize.
    """
    scene = beat["scene"]
    hold_n = round(beat.get("hold", DEFAULT_HOLD) * FPS)
    frames = []

    if "pin" in beat:
        # One capture per digit: the dots really do fill in, rather than a dot
        # being drawn on top of a screenshot of an empty pad.
        lo, hi = beat["pin"]
        for n in range(lo, hi + 1):
            scr = capture_screen(port, scene, currency, pin=n)
            frames += [fit(scr.at(0), plate)] * max(1, round(PIN_DIGIT * FPS))
        return frames + [frames[-1]] * hold_n

    if "count" in beat:
        # The balance climbing, and with it the progress ring and the tree. Each
        # step is a real render, so everything that depends on the number moves
        # together instead of only the digits changing.
        lo, hi = COUNT_USD[clip_name] if currency == "USD" and clip_name in COUNT_USD else beat["count"]
        per = max(1, round(COUNT_SECS * FPS / COUNT_STEPS))
        for i in range(COUNT_STEPS + 1):
            v = lo + (hi - lo) * ease_out(i / COUNT_STEPS)
            scr = capture_screen(port, scene, currency, bal=round(v, 2))
            frames += [fit(scr.at(beat.get("y", 0)), plate)] * per
        return frames + [frames[-1]] * hold_n

    scrolls = bool(beat.get("scroll")) or bool(beat.get("y")) or "tap" in beat
    scr = capture_screen(port, scene, currency, tap=beat.get("tap"), scrolls=scrolls)

    def offset(v):
        # "end" is how far this screen can actually go, which beats writing a
        # number that quietly stops being right when the screen grows a row.
        return scr.max_y if v == "end" else float(v)

    if "scroll" in beat:
        a, b = (offset(v) for v in beat["scroll"])
        # A short pan should not take as long as a long one, or it crawls.
        secs = min(SCROLL_MAX, max(SCROLL_MIN, abs(b - a) / SCROLL_SPEED))
        n = max(2, round(secs * FPS))
        frames += [fit(scr.at(a + (b - a) * ease(i / (n - 1))), plate) for i in range(n)]
        y = b
    else:
        y = offset(beat.get("y", 0))

    still = fit(scr.at(y), plate)

    if "tap" in beat:
        n = max(2, round(TAP_SECS * FPS))
        frames += [draw_tap(still, scr.tap_at(y), i / (n - 1)) for i in range(n)]

    return frames + [still] * hold_n


# ─── assembling and encoding ──────────────────────────────────────────────────

def compose(plate, screen, mask):
    out = plate.image.copy()
    out.paste(screen, (plate.rect[0], plate.rect[1]), mask)
    return out


def rounded_mask(w, h, r):
    from PIL import Image, ImageDraw
    # Drawn at 4x and shrunk, because PIL's rounded rectangle has no antialiasing
    # of its own and a hard-edged corner against a dark bezel is very visible.
    m = Image.new("L", (w * 4, h * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1], radius=r * 4, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def render(ffmpeg, segments, mp4, poster, crf):
    """
    Walk the beats, crossfading between them, straight into ffmpeg.

    Frames are written as they are made and thrown away again. A ten second 9:16
    clip is three hundred frames of six megabytes; holding them all would cost
    two gigabytes for no reason.
    """
    from PIL import Image
    fade_n = round(CROSSFADE * FPS)
    first = None
    w, h = segments[0][0].image.size

    plate, frames = segments[0]
    mask = rounded_mask(*plate.rect[2:], plate.radius)
    # Every beat's phone must land in the same place, or a crossfade would paste
    # one beat's screen through the other beat's hole. canvas.html reserves a
    # fixed caption block to guarantee it; this is the tripwire if that changes.
    odd = [p.rect for p, _ in segments if p.rect != plate.rect]
    if odd:
        sys.exit(f"the phone is not the same size on every beat: {plate.rect} vs {odd[0]}")

    proc = subprocess.Popen(
        [ffmpeg, "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
         "-an",
         "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-crf", str(crf), "-preset", "slow",
         "-g", str(FPS * 2), "-movflags", "+faststart", str(mp4)],
        stdin=subprocess.PIPE)

    def write(im):
        nonlocal first
        if first is None:
            first = im.copy()
        proc.stdin.write(im.tobytes())

    for i, (plate, frames) in enumerate(segments):
        mask = rounded_mask(*plate.rect[2:], plate.radius)
        nxt = segments[i + 1] if i + 1 < len(segments) else None
        tail = fade_n if nxt else 0
        body = frames[:len(frames) - tail] if tail else frames

        for f in body:
            write(compose(plate, f, mask))

        if nxt:
            nplate, nframes = nxt
            for j in range(tail):
                k = (j + 1) / (tail + 1)
                # The screen dissolves across the whole crossfade, but the words
                # change over a slice in the middle of it. Fading a headline into
                # a different headline at the same rate leaves several frames of
                # both being legible at once, which reads as a mistake.
                lo, hi = CAP_SWAP
                kc = ease(min(1.0, max(0.0, (k - lo) / (hi - lo))))
                bg = Image.blend(plate.image, nplate.image, kc)
                screen = Image.blend(frames[len(frames) - tail + j],
                                     nframes[min(j, len(nframes) - 1)], k)
                out = bg
                out.paste(screen, (plate.rect[0], plate.rect[1]), mask)
                write(out)
            # the frames the fade consumed are not replayed by the next segment
            segments[i + 1] = (nplate, nframes[tail:] or nframes[-1:])

    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit(f"ffmpeg failed writing {mp4.name}")
    if first is not None:
        first.save(poster, quality=90, method=6)


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
    ap.add_argument("--aspect", choices=sorted(ASPECTS), default="9x16")
    ap.add_argument("--currency", choices=["ZAR", "USD"], default="ZAR")
    ap.add_argument("--crf", type=int, default=21, help="H.264 quality, lower is better and bigger")
    ap.add_argument("--stills", action="store_true", help="posters only, skip the video")
    ap.add_argument("--foot", default="sproutallowance.com", help="the line along the bottom")
    ap.add_argument("--scout", metavar="SCENE",
                    help="save that scene full-height with a ruler, to read scroll offsets off")
    args = ap.parse_args()

    if args.scout:
        ffmpeg = preflight()
        port = free_port()
        httpd = None
        try:
            stage()
            httpd = serve(port)
            dest = ROOT / "Working files" / "social" / f"scout-{args.scout}.png"
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
    size = ASPECTS[args.aspect]
    suffix = "" if args.currency == "ZAR" else "-usd"
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    port = free_port()
    httpd = None
    try:
        stage()
        httpd = serve(port)
        print(f"serving {ROOT} on port {port}")
        print(f"{args.aspect} · {args.currency} · {size[0]}×{size[1]}\n")

        for name in wanted:
            clip = CLIPS[name]
            print(f"{name} — {clip['title']}")
            segments = []
            for i, beat in enumerate(clip["beats"]):
                plate = capture_plate(port, beat.get("cap", ""), beat.get("sub", ""), args.foot, size)
                frames = beat_screens(port, beat, args.currency, plate, name)
                segments.append((plate, frames))
                print(f"  beat {i + 1}/{len(clip['beats'])}  {beat['scene']:<14} {len(frames):>3} frames")

            stem = f"{name}-{args.aspect}{suffix}"
            poster = OUT_DIR / f"{stem}.webp"
            mp4 = OUT_DIR / f"{stem}.mp4"
            if args.stills:
                plate, frames = segments[0]
                compose(plate, frames[0], rounded_mask(*plate.rect[2:], plate.radius)).save(poster, quality=90, method=6)
                print(f"  {poster.name:26} {poster.stat().st_size // 1024:5} KB\n")
            else:
                render(ffmpeg, segments, mp4, poster, args.crf)
                secs = sum(len(f) for _, f in segments) / FPS
                print(f"  {mp4.name:26} {mp4.stat().st_size // 1024:5} KB   {secs:.1f}s\n")

        print(f"written to {OUT_DIR}")
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        # The staging copy must never survive into a commit or a deploy.
        shutil.rmtree(STAGING, ignore_errors=True)


if __name__ == "__main__":
    main()
