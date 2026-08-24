#!/usr/bin/env python3
"""
Rebuild the How It Works walkthrough clips from the live app.

    python3 tools/walkthrough/build.py

Every frame is a screenshot of app/index.html running against seeded demo data,
so the clips always show the product as it currently looks. Re-run this whenever
the app's appearance changes and the marketing pages catch up for free.

What it produces, into images/marketing/walkthrough/:

    step1.mp4  step2.mp4  step3.mp4          South African cut (Rand)
    step1-usd.mp4 ...                        rest-of-world cut (Dollar)
    step{n}[-usd]-poster.webp                first frame, shown before playback

Each clip pairs two app screens: it rests on the first, crossfades to the second,
rests, then fades back, so it loops without a visible seam.

How the capture works, and the two traps in it:

  * The app is copied to a throwaway .walkthrough-build/ folder at the repo root
    with tools/walkthrough/seed.js injected. It has to sit one level below the
    root, because app/index.html reaches assets via "../images".
  * Headless Chrome clamps its window to a 500px minimum width, so a 390px phone
    viewport can only be had inside an iframe. See frame.html.

Requirements: Google Chrome, Pillow, and imageio-ffmpeg (which ships its own
ffmpeg binary):

    pip3 install --user pillow imageio-ffmpeg
"""

import argparse
import http.server
import functools
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
STAGING = ROOT / ".walkthrough-build"          # gitignored; deleted on the way out
OUT_DIR = ROOT / "images" / "marketing" / "walkthrough"

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# The phone viewport, and the 2x screenshot it produces.
VIEW_W, VIEW_H = 390, 844
SHOT_W, SHOT_H = VIEW_W * 2, VIEW_H * 2

# Encoded at twice the size the pages actually display the phone at, which is all
# a retina screen resolves. The 2x capture is far larger than that and would just
# spend bytes.
OUT_W, OUT_H = 464, 1004

FPS = 30
HOLD = 2.6      # seconds each screen rests on screen
FADE = 0.45     # seconds of crossfade between the two

# scene number -> how far to scroll the app before shooting.
SCENES = {1: 0, 2: 0, 3: 0, 4: 430, 5: 0, 6: 0}
STEPS = {"step1": (1, 2), "step2": (3, 4), "step3": (5, 6)}
CURRENCIES = {"ZAR": "", "USD": "-usd"}


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


# ─── staging ──────────────────────────────────────────────────────────────────

def stage():
    """A copy of the real app with the demo-data script appended."""
    app = (ROOT / "app" / "index.html").read_text()
    if "</body>" not in app:
        sys.exit("app/index.html has no </body> to inject into — has it moved?")
    STAGING.mkdir(exist_ok=True)
    (STAGING / "index.html").write_text(
        app.replace("</body>", '\n<script src="/.walkthrough-build/seed.js"></script>\n</body>', 1))
    shutil.copy(HERE / "seed.js", STAGING / "seed.js")
    shutil.copy(HERE / "frame.html", STAGING / "frame.html")


# ─── capture ──────────────────────────────────────────────────────────────────

def capture(port, scene, currency, dest):
    from PIL import Image
    y = SCENES[scene]
    url = (f"http://127.0.0.1:{port}/.walkthrough-build/frame.html"
           f"?scene={scene}&cur={currency}" + (f"&y={y}" if y else ""))
    raw = STAGING / f"raw-{currency}-{scene}.png"
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=2", "--window-size=600,900",
         "--virtual-time-budget=15000", f"--screenshot={raw}", url],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not raw.exists():
        sys.exit(f"Chrome produced no screenshot for scene {scene} ({currency}).")
    with Image.open(raw) as im:
        im.crop((0, 0, SHOT_W, SHOT_H)).save(dest)
    raw.unlink()


# ─── encode ───────────────────────────────────────────────────────────────────

def frames_for(a, b):
    from PIL import Image
    hold_n, fade_n = round(HOLD * FPS), round(FADE * FPS)
    out = [a] * hold_n
    out += [Image.blend(a, b, i / fade_n) for i in range(1, fade_n)]
    out += [b] * hold_n
    out += [Image.blend(b, a, i / fade_n) for i in range(1, fade_n)]
    return out


def encode(ffmpeg, frames, mp4, poster, crf):
    w, h = frames[0].size
    frames[0].save(poster, quality=88, method=6)
    proc = subprocess.Popen(
        [ffmpeg, "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
         "-an",                                  # silent: no audio track at all
         "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-crf", str(crf), "-preset", "veryslow",
         "-g", str(FPS * 2), "-movflags", "+faststart",
         str(mp4)],
        stdin=subprocess.PIPE)
    for f in frames:
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit(f"ffmpeg failed writing {mp4.name}")


# ─── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--currency", choices=["ZAR", "USD"],
                    help="build only one cut (default: both)")
    ap.add_argument("--crf", type=int, default=26,
                    help="H.264 quality, lower is better and bigger (default: 26)")
    ap.add_argument("--keep-screens", action="store_true",
                    help="leave the captured PNGs in .walkthrough-build/ for inspection")
    args = ap.parse_args()

    ffmpeg = preflight()
    from PIL import Image

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    port = free_port()
    httpd = None
    try:
        stage()
        httpd = serve(port)
        print(f"serving {ROOT} on port {port}\n")

        currencies = {args.currency: CURRENCIES[args.currency]} if args.currency else CURRENCIES
        for currency, suffix in currencies.items():
            print(f"{currency}:")
            shots = {}
            for scene in sorted(SCENES):
                dest = STAGING / f"{currency}-s{scene}.png"
                capture(port, scene, currency, dest)
                shots[scene] = dest
                print(f"  captured scene {scene}")

            for name, (a, b) in STEPS.items():
                ia = Image.open(shots[a]).convert("RGB").resize((OUT_W, OUT_H), Image.LANCZOS)
                ib = Image.open(shots[b]).convert("RGB").resize((OUT_W, OUT_H), Image.LANCZOS)
                mp4 = OUT_DIR / f"{name}{suffix}.mp4"
                poster = OUT_DIR / f"{name}{suffix}-poster.webp"
                encode(ffmpeg, frames_for(ia, ib), mp4, poster, args.crf)
                print(f"  {mp4.name:18} {mp4.stat().st_size // 1024:4} KB   "
                      f"poster {poster.stat().st_size // 1024:3} KB")

            if args.keep_screens:
                for p in shots.values():
                    shutil.copy(p, STAGING / ("keep-" + p.name))
            print()

        print(f"written to {OUT_DIR.relative_to(ROOT)}")
        if args.keep_screens:
            print(f"screens kept in {STAGING.relative_to(ROOT)}")
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        # The staging copy must never survive into a commit or a deploy.
        if STAGING.exists() and not args.keep_screens:
            shutil.rmtree(STAGING, ignore_errors=True)


if __name__ == "__main__":
    main()
