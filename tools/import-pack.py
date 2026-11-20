"""Install a pack into the plugin's data directory.

Copies images into `$DSH_HOME/storages/think_skin/images/<pack>/` under ASCII
file names (so request paths never need escaping) and writes `pack.json`, which
the host half serves at `/think-skin/pack.json`.

Usage:
    python tools/import-pack.py --pack 蓝色大肥鱼 --dir assets/compiled-128/蓝色大肥鱼
    python tools/import-pack.py --claudecode

Picture text pools live in `assets/texts/<pack>.json`, written by
`tools/export-texts.py` from whatever the settings panel produced. When that
file exists it wins: it carries both the phrases and each image's
"also use the generic pool" flag.
"""

import argparse
import io
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

IMAGE_EXT = {".gif", ".png", ".webp", ".apng", ".jpg", ".jpeg"}

# Per-pack look. A gradient of two or more colors is applied by clipping a
# linear-gradient background to the text; a single color falls back to plain text.
APPEARANCE = {
    "蓝色大肥鱼": {"gradient": ["#a8cdff", "#5b8dff"]},
    "ClaudeCode": {"gradient": ["#f0a882", "#d97757"]},
    "酒狐": {"gradient": ["#ffd6a5", "#ff9e6d"]},
}

# Action word → few Chinese lines. None of these are authoritative; the user can
# rewrite any of them in the settings page later.
DEFAULT_TEXTS = [
    "正在思考",
    "在想事情",
    "琢磨中",
    "让我想想",
]


def store_root():
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "storages", "think_skin")


def action_of(filename):
    """`蓝色大肥鱼_思考(认真地)_2026-08-18-14-37-25.gif` → `思考(认真地)`."""
    stem = os.path.splitext(os.path.basename(filename))[0]
    stem = re.sub(r"_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$", "", stem)
    stem = re.sub(r"^蓝色大肥鱼_", "", stem)
    return stem.strip()


def load_text_snapshot(pack_id):
    """`assets/texts/<pack>.json`, or None when the pack has no curated copy."""
    path = os.path.join(ROOT, "assets", "texts", pack_id + ".json")
    if not os.path.exists(path):
        return None
    with io.open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_pack_json(root):
    path = os.path.join(root, "pack.json")
    if not os.path.exists(path):
        return {"packs": [], "active": None}
    with io.open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_pack_json(root, data):
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, "pack.json")
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    return path


def install(pack_id, sources, fallback_texts, texts_by_name=None, appearance=None,
            snapshot=None):
    """Copy images and merge one pack into pack.json."""
    root = store_root()
    target = os.path.join(root, "images", pack_id)
    os.makedirs(target, exist_ok=True)

    images = []
    for index, src in enumerate(sources, 1):
        ext = os.path.splitext(src)[1].lower()
        if ext not in IMAGE_EXT:
            continue
        name = action_of(src)
        file_name = "f%03d%s" % (index, ext)
        shutil.copyfile(src, os.path.join(target, file_name))
        texts = []
        use_fallback = True
        entry = (snapshot or {}).get("images", {}).get(name)
        if entry is not None:
            texts = entry.get("texts") or []
            use_fallback = entry.get("useFallback", True) is not False
        elif texts_by_name and name in texts_by_name:
            texts = texts_by_name[name]
        elif name:
            texts = ["正在%s" % name]
        images.append({"id": "f%03d" % index, "file": "%s/%s" % (pack_id, file_name),
                       "name": name, "texts": texts, "useFallback": use_fallback})

    data = load_pack_json(root)
    data["packs"] = [p for p in data["packs"] if p["id"] != pack_id]
    data["packs"].append({
        "id": pack_id,
        "name": pack_id,
        "fallbackTexts": (snapshot or {}).get("fallbackTexts") or fallback_texts,
        "appearance": appearance or APPEARANCE.get(pack_id, {}),
        "images": images,
    })
    if not data.get("active"):
        data["active"] = pack_id
    path = save_pack_json(root, data)

    size = sum(os.path.getsize(os.path.join(target, i["file"].split("/")[1]))
               for i in images if os.path.exists(os.path.join(target, i["file"].split("/")[1])))
    print("pack      %s" % pack_id)
    print("images    %d   %.2f MB" % (len(images), size / 1024 / 1024))
    print("root      %s" % root)
    print("manifest  %s" % path)
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack")
    parser.add_argument("--dir")
    parser.add_argument("--texts", help="JSON: {action: [lines...]}")
    parser.add_argument("--fallback", help="JSON array of fallback lines")
    parser.add_argument("--claudecode", action="store_true")
    args = parser.parse_args()

    if args.claudecode:
        verbs_path = os.path.join(ROOT, "assets", "ClaudeCode", "verbs.json")
        with io.open(verbs_path, encoding="utf-8") as fh:
            verbs = json.load(fh)["verbs"]
        placeholder = os.path.join(ROOT, "assets", "ClaudeCode", "placeholder.png")
        install("ClaudeCode", [placeholder], verbs, snapshot=load_text_snapshot("ClaudeCode"))
        return

    if not args.pack or not args.dir:
        sys.exit("need --pack and --dir (or --claudecode)")

    sources = sorted(
        os.path.join(args.dir, name)
        for name in os.listdir(args.dir)
        if os.path.splitext(name)[1].lower() in IMAGE_EXT
    )
    texts_by_name = None
    if args.texts:
        with io.open(args.texts, encoding="utf-8") as fh:
            texts_by_name = json.load(fh)
    fallback = DEFAULT_TEXTS
    if args.fallback:
        with io.open(args.fallback, encoding="utf-8") as fh:
            fallback = json.load(fh)
    install(args.pack, sources, fallback, texts_by_name,
            snapshot=load_text_snapshot(args.pack))


if __name__ == "__main__":
    main()
