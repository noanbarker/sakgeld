#!/usr/bin/env python3
"""
Build an MP4 of the savings-tree moment from the live landing page.

    python3 tools/treegrow/build.py                  # the panel, as on the page
    python3 tools/treegrow/build.py --cut card       # the whole green card
    python3 tools/treegrow/build.py --aspect 1x1     # padded to a square
    python3 tools/treegrow/build.py --currency USD   # the dollar cut
    python3 tools/treegrow/build.py --loops 3        # play it through three times

Output lands in "Working files/treegrow/" — outside the site, so nothing here
gets deployed or committed.

The section is not re-drawn here and not screen recorded either. build.py lifts
the real markup out of index.html, renders it in Chrome at one exact moment per
frame, and encodes the result. So restyling the section on the site and
re-running is the whole update, and re-cutting at another size costs nothing.

    frame.html   the same section, rendered at a given moment instead of animated
    build.py     captures the moments, crops them, and encodes

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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
STAGING = ROOT / ".treegrow-build"                 # gitignored; deleted on the way out
OUT_DIR = ROOT / "Working files" / "treegrow"
SOURCE = ROOT / "index.html"

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

SCALE = 3                       # capture at 3x, then size down to the output width
WORKERS = 4                     # Chrome launches running at once
FPS = 30

# What each cut frames, and the window it is rendered in. Headless Chrome will
# not go below 500px wide — ask for a 360px phone and it quietly hands back 500
# and a desktop layout — so the reel's stage is a fixed-size element inside a
# roomier window, and the crop is measured off the element.
CUTS = {
    #        viewport      what to frame   green kept round it   finished width
    "reel":  dict(view=(700, 760), target="reel",  pad=0,  width=1080),
    "panel": dict(view=(1280, 900), target="panel", pad=34, width=1440),
    "card":  dict(view=(1280, 900), target="card",  pad=40, width=1920),
}
VIEW = CUTS["panel"]["view"]     # set for real once the cut is known

ASPECTS = {"1x1": 1 / 1, "4x5": 4 / 5, "9x16": 9 / 16, "16x9": 16 / 9}


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


# ─── the section, lifted out of the page ──────────────────────────────────────

def stage(geo):
    """frame.html with the real section and the real webfonts poured into it."""
    # Two builds at once share this folder, and whichever finishes first deletes
    # it under the other. Refuse the second outright rather than fail obscurely.
    if STAGING.exists():
        sys.exit(f"{STAGING.name}/ already exists — another build is running.\n"
                 f"Wait for it, or if nothing is running, delete the folder and retry.")

    page = SOURCE.read_text()

    m = re.search(r"<!-- MONEY TREE MOMENT -->(.*?)<!--", page, re.S)
    if not m:
        sys.exit("Could not find the MONEY TREE MOMENT block in index.html — has it been renamed?")
    section = m.group(1)
    if "pr-treegrow-counter" not in section:
        sys.exit("Found the MONEY TREE MOMENT block, but no counter in it — the markup has moved.")
    # Off-screen images stay unloaded in a headless capture, and a frame of
    # missing trees looks like a build that worked.
    section = section.replace(' loading="lazy"', "")

    fonts = next((s for s in re.findall(r"<style>(.*?)</style>", page, re.S) if "@font-face" in s), None)
    if not fonts:
        sys.exit("No @font-face block in index.html — the clip would come out in the wrong typeface.")

    html = (HERE / "frame.html").read_text()
    html = html.replace("__GEO__", geo).replace("__FONTS__", fonts).replace("__SECTION__", section)
    STAGING.mkdir()
    (STAGING / "frame.html").write_text(html)


# ─── driving Chrome ───────────────────────────────────────────────────────────

def url_for(port, t, cut):
    return (f"http://127.0.0.1:{port}/.treegrow-build/frame.html?"
            + urlencode({"t": f"{t:.4f}", "cut": cut}))


def chrome_args(url, extra, profile=0):
    return [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--no-first-run", "--no-default-browser-check",
            f"--force-device-scale-factor={SCALE}", "--virtual-time-budget=20000",
            f"--user-data-dir={STAGING}/prof{profile}",   # concurrent launches need their own
            f"--window-size={VIEW[0]},{VIEW[1]}", *extra, url]


def run_chrome(url, extra, out, ready, profile=0, patience=45, stdout_to=None):
    """
    Run Chrome once and wait for the file it was asked to write, not for Chrome.

    Chrome 151 does the work and then simply stays up: the screenshot is on disk
    in about two seconds and the process is still running forty seconds later.
    Waiting on the exit status — which is what you would normally do, and what
    the older clip builders in tools/ still do — hangs the build outright. So
    watch the file, and kill Chrome the moment its output is complete.
    """
    out = Path(out)
    out.unlink(missing_ok=True)
    sink = open(stdout_to, "w") if stdout_to else None
    proc = subprocess.Popen(chrome_args(url, extra, profile),
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
            im.load()          # a half-written file raises here, not on open
        return True
    except (OSError, SyntaxError):
        return False


def dom_ready(path):
    return "</html>" in path.read_text(errors="ignore")


def shoot(url, dest, profile=0):
    # Retried, because roughly one launch in a few hundred produces nothing
    # usable — sometimes no file, sometimes half a PNG — with nothing on stderr
    # to say so. A clip is hundreds of launches; "rare" happens on most runs.
    for _ in range(4):
        if run_chrome(url, [f"--screenshot={dest}"], dest, png_ready, profile):
            return
    sys.exit(f"Chrome produced no usable screenshot after four tries:\n  {url}")


def probe(url):
    """Read the measurements and the timeline frame.html writes onto <html>."""
    dump = STAGING / "dom.html"
    if not run_chrome(url, ["--dump-dom"], dump, dom_ready, stdout_to=dump):
        sys.exit(f"Chrome returned no page to measure:\n  {url}")
    m = re.search(r"<html\b([^>]*)>", dump.read_text(errors="ignore"))
    if not m:
        sys.exit("Chrome returned a page with no <html> tag — is index.html readable?")
    return dict(re.findall(r'data-([a-z-]+)="([^"]*)"', m.group(1)))


def nums(s):
    return [int(round(float(v))) for v in s.split(",")]


# ─── frames ───────────────────────────────────────────────────────────────────

def plan(duration, windows):
    """
    Every frame time, and which of them actually differ.

    Nothing moves between one tree finishing its growth and the next starting,
    and nothing moves at all through the closing hold. Those are two thirds of
    the clip, and rendering them is two thirds of the build for pictures already
    on disk. Each still stretch is captured once and repeated.
    """
    total = int(round(duration * FPS))
    times, keys = [], []
    for f in range(total):
        t = f / FPS
        live = next((w for w in windows if w[0] <= t < w[1] + 1 / FPS), None)
        if live:
            times.append(t)
            keys.append(f"t{t:.4f}")
        else:
            # A still stretch looks exactly like the moment the last motion ended.
            done = [w[1] for w in windows if w[1] <= t]
            at = max(done) if done else 0.0
            times.append(at)
            keys.append(f"s{at:.4f}")
    return times, keys


def crop_box(meta, cut):
    spec = CUTS[cut]
    l, t, w, h = nums(meta[spec["target"]])
    pad = spec["pad"] * SCALE
    box = [l - pad, t - pad, l + w + pad, t + h + pad]
    if cut == "panel":
        # Sideways, follow the trees rather than the column they sit in.
        rl, _, rw, _ = nums(meta["row"])
        box[0], box[2] = rl - pad, rl + rw + pad
        # And keep the crop inside the card, or the clip ends with a slice of
        # page background and a rounded corner down one edge.
        cl, ct, cw, ch = nums(meta["card"])
        inset = 2 * SCALE
        box = [max(box[0], cl + inset), max(box[1], ct + inset),
               min(box[2], cl + cw - inset), min(box[3], ct + ch - inset)]
    return tuple(box)


def finish(img, box, out_w, aspect):
    """Crop to the subject, pad to the asked-for shape, and size for encoding."""
    from PIL import Image
    im = img.crop(box)
    if aspect:
        want_w, want_h = im.width, im.height
        if im.width / im.height > aspect:
            want_h = int(round(im.width / aspect))
        else:
            want_w = int(round(im.height * aspect))
        pad = Image.new("RGB", (want_w, want_h), CARD_GREEN)
        pad.paste(im, ((want_w - im.width) // 2, (want_h - im.height) // 2))
        im = pad
    w = out_w
    h = int(round(im.height * w / im.width))
    w, h = w - w % 2, h - h % 2                 # yuv420p refuses odd dimensions
    return im.convert("RGB").resize((w, h), Image.LANCZOS)


# ─── build ────────────────────────────────────────────────────────────────────

def build(args, ffmpeg):
    from PIL import Image

    geo = "ROW" if args.currency.upper() in ("USD", "ROW") else "ZA"
    stage(geo)
    port = free_port()
    httpd = serve(port)
    shots = STAGING / "shots"
    frames = STAGING / "frames"
    shots.mkdir(), frames.mkdir()

    try:
        meta = probe(url_for(port, 0, args.cut))
        for key in ("panel", "card", "row", "reel", "duration", "windows"):
            if key not in meta:
                sys.exit(f"frame.html reported no {key} — the section did not render.")
        duration = float(meta["duration"])
        windows = [tuple(float(v) for v in w.split(":")) for w in meta["windows"].split(",")]
        box = crop_box(meta, args.cut)

        times, keys = plan(duration, windows)
        unique = sorted(set(zip(keys, times)))
        print(f"{len(times)} frames over {duration:.2f}s — {len(unique)} to render")

        def one(job):
            i, (key, t) = job
            shoot(url_for(port, t, args.cut), shots / f"{key}.png", profile=i % WORKERS)
            return key

        with ThreadPoolExecutor(WORKERS) as pool:
            for n, key in enumerate(pool.map(one, enumerate(unique)), 1):
                print(f"\r  rendered {n}/{len(unique)}", end="", flush=True)
        print()

        out_w = args.width or CUTS[args.cut]["width"]
        aspect = ASPECTS.get(args.aspect)
        done = {}
        for n, key in enumerate(keys):
            if key not in done:
                with Image.open(shots / f"{key}.png") as im:
                    done[key] = finish(im, box, out_w, aspect)
                    done[key].save(frames / f"{key}.png")
            shutil.copy(frames / f"{key}.png", frames / f"f{n:05d}.png")

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        name = f"savings-tree-{args.cut}"
        name += "" if args.aspect == "native" else f"-{args.aspect}"
        name += "" if geo == "ZA" else "-usd"
        mp4 = OUT_DIR / f"{name}.mp4"
        poster = OUT_DIR / f"{name}.png"

        cmd = [ffmpeg, "-y", "-framerate", str(FPS)]
        if args.loops > 1:
            cmd += ["-stream_loop", str(args.loops - 1)]
        cmd += ["-i", str(frames / "f%05d.png"),
                "-c:v", "libx264", "-preset", "slow", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit("ffmpeg failed:\n" + r.stderr[-2000:])

        shutil.copy(frames / f"f{len(keys) - 1:05d}.png", poster)
        size = done[keys[-1]].size
        print(f"\n{mp4.relative_to(ROOT)}   {size[0]}×{size[1]}, "
              f"{duration * args.loops:.1f}s, silent")
        print(f"{poster.relative_to(ROOT)}   final frame, as a still")
    finally:
        httpd.shutdown()
        shutil.rmtree(STAGING, ignore_errors=True)


def main():
    p = argparse.ArgumentParser(description="Build an MP4 of the landing page's savings tree.")
    p.add_argument("--cut", choices=list(CUTS), default="reel",
                   help="reel: the phone's one-tree-at-a-time cut, 9:16. "
                        "panel: the desktop row of five. card: the whole green card.")
    p.add_argument("--aspect", choices=["native", *ASPECTS], default="native",
                   help="native keeps the section's own shape; the rest pad it with card green.")
    p.add_argument("--currency", default="ZAR", help="ZAR (default) or USD")
    p.add_argument("--loops", type=int, default=1, help="how many times it plays through")
    p.add_argument("--width", type=int, help="finished width in pixels")
    args = p.parse_args()
    if args.loops < 1:
        sys.exit("--loops must be at least 1.")
    global VIEW
    VIEW = CUTS[args.cut]["view"]
    build(args, preflight())


if __name__ == "__main__":
    main()
