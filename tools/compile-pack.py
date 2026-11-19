"""Recompile a pack's images at 128px, keeping every frame and its delay.

The rule this file exists to protect: **never rewrite per-frame timing.** A GIF
carries its own cadence — the fish sources run at 20 ms per frame, the fox at
100 ms. Forcing a fixed frame rate is what made the fox spin twice too fast and
cost the fish two thirds of its frames.

Usage:
    python tools/compile-pack.py --pack 蓝色大肥鱼 --source assets/蓝色大肥鱼
    python tools/compile-pack.py --pack 酒狐 --source assets/酒狐
    python tools/compile-pack.py --pack 蓝色大肥鱼 --source ... --dry-run
"""

import argparse
import io
import json
import os
import re
import sys

try:
    from PIL import Image, ImageSequence
except ImportError:
    sys.exit("需要 Pillow：pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BOX = (128, 128)


def store_root():
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "storages", "think_skin")


def action_of(filename):
    """`蓝色大肥鱼_思考(认真地)_2026-08-18-14-37-25.gif` -> `思考(认真地)`."""
    stem = os.path.splitext(os.path.basename(filename))[0]
    stem = re.sub(r"_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$", "", stem)
    stem = re.sub(r"^[^_]+_", "", stem)
    return stem.strip()


def compile_gif(src, dst):
    """Resize every frame to fit BOX, preserving the frame count and delays."""
    im = Image.open(src)
    frames = []
    durations = []
    for frame in ImageSequence.Iterator(im):
        durations.append(frame.info.get("duration", 100) or 100)
        rgba = frame.convert("RGBA")
        w, h = rgba.size
        scale = min(BOX[0] / w, BOX[1] / h)
        size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
        scaled = rgba.resize(size, Image.LANCZOS)
        canvas = Image.new("RGBA", BOX, (0, 0, 0, 0))
        canvas.paste(scaled, ((BOX[0] - size[0]) // 2, (BOX[1] - size[1]) // 2), scaled)
        frames.append(canvas)
    frames[0].save(
        dst,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=True,
    )
    return len(frames), sum(durations)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", required=True, help="pack id in pack.json")
    parser.add_argument("--source", required=True, help="directory of original GIFs")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest_path = os.path.join(store_root(), "pack.json")
    document = json.load(io.open(manifest_path, encoding="utf-8"))
    pack = next((p for p in document["packs"] if p["id"] == args.pack), None)
    if pack is None:
        sys.exit("pack.json 里没有 " + args.pack)

    sources = {}
    for name in os.listdir(args.source):
        path = os.path.join(args.source, name)
        if os.path.splitext(name)[1].lower() != ".gif":
            continue
        sources[action_of(name)] = path

    print("源目录 %d 个 GIF，清单 %d 张图" % (len(sources), len(pack["images"])))
    before = 0
    after = 0
    missing = []
    for image in pack["images"]:
        target = os.path.join(store_root(), "images", image["file"].replace("/", os.sep))
        if os.path.exists(target):
            before += os.path.getsize(target)
        src = sources.get(image.get("name", ""))
        if src is None:
            missing.append(image.get("name", "?"))
            continue
        if args.dry_run:
            continue
        frames, total = compile_gif(src, target)
        after += os.path.getsize(target)
        print("  %-16s %3d 帧  %.2fs  %4d KB" % (
            image.get("name", "")[:16], frames, total / 1000, os.path.getsize(target) // 1024))

    if missing:
        print("没找到源文件: " + ", ".join(missing))
    if not args.dry_run:
        print("合计 %.2f MB → %.2f MB" % (before / 1024 / 1024, after / 1024 / 1024))


if __name__ == "__main__":
    main()
