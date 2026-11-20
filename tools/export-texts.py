"""Export a pack's phrase pools into a reviewable text file.

The settings panel edits one image at a time and saves into `pack.json`; this
tool writes the same content out as a single JSON file so the curated copy can
live in the repository and ship with the package.

Usage:
    python tools/export-texts.py                       # every pack in the store
    python tools/export-texts.py --pack 蓝色大肥鱼
"""

import argparse
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "assets", "texts")


def store_root():
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "storages", "think_skin")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", help="only this pack id")
    args = parser.parse_args()

    manifest = os.path.join(store_root(), "pack.json")
    if not os.path.exists(manifest):
        sys.exit("找不到 " + manifest)
    document = json.load(io.open(manifest, encoding="utf-8"))
    os.makedirs(OUT_DIR, exist_ok=True)

    for pack in document["packs"]:
        if args.pack and pack["id"] != args.pack:
            continue
        images = {}
        for image in pack.get("images", []):
            name = image.get("name") or image["id"]
            images[name] = {
                "texts": list(image.get("texts") or []),
                # 关闭"也用通用文案池"的图，出货时也保持关闭
                "useFallback": image.get("useFallback") is not False,
            }
        payload = {
            "pack": pack["id"],
            "fallbackTexts": list(pack.get("fallbackTexts") or []),
            "images": images,
        }
        path = os.path.join(OUT_DIR, pack["id"] + ".json")
        with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        total = sum(len(v["texts"]) for v in images.values())
        print("%-14s %2d 图 / %3d 句 / 通用 %d 句  →  %s" % (
            pack["id"], len(images), total, len(payload["fallbackTexts"]),
            os.path.relpath(path, ROOT)))


if __name__ == "__main__":
    main()
