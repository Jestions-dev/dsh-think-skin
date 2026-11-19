# dsh-think-skin

**Give the DSH thinking row your own face and your own words.**

The row that says `深度求索中，用时 3秒 ···` next to a whale tail is the one thing you look at
more than the answer. This replaces its icon and its copy, and keeps the timer.

![The row, reskinned](assets/compiled-128/蓝色大肥鱼/f001.gif)

---

## What it does

```
图标      换成你自己的图（GIF / PNG / WebP）
文案      每次「思考」随机抽一句，从这张图自己的池子里抽
轮换      同一轮里每 7–15 秒换一句，图不变
渐变      文字用 2 色渐变填充
设置      设置 → 思考状态：选套、调颜色、改文案池、导入图片
```

**双随机：** 一次运行抽一张图（整轮固定），图再带自己的文案池，池里每 7–15 秒抽一句。
两个随机在不同尺度上，组合数远大于单池。

**一次运行怎么判定：** 行出现 = 新一轮；「用时 N秒」归零也算新一轮。
踩过两次坑才定下来——见 [DESIGN.md](DESIGN.md)。

---

## Install

```bash
dsh plugin add github:Jestions-dev/dsh-think-skin
```

Then restart DSH once.

**Local development** (edit → refresh, no restart):

```bash
dsh plugin add link:D:/path/to/dsh-think-skin
```

---

## Packs

A pack is a folder of images; every image may carry its own list of phrases.

```
pack
├─ images[]          一次运行抽一张
│   └─ texts[]       这张图自己的文案池（可空 → 用套级池）
└─ fallbackTexts[]   套级兜底池
```

**Image data lives on the host, not in the bundle:**

```
$DSH_HOME/storages/think_skin/
  pack.json
  images/<pack>/f001.gif …
```

The browser fetches `pack.json` once and each image with `immutable` caching, so the bundle
stays around 19 KB no matter how many images a pack holds.

**导入图片：** 设置 → 思考状态 → 选择文件。文件会被**复制**进上面的目录，原文件随便处置。
**Import from the CLI:**

```bash
python tools/import-pack.py --pack 我的套 --dir /path/to/gifs
python tools/import-pack.py --claudecode     # placeholder + the 179 verbs
```

---

## Bundled packs

| Pack | Images | What |
|---|---|---|
| 蓝色大肥鱼 | 39 | Blue Fat Fish stickers, 128×128 / 20 fps |
| Claude Code | 1 | A placeholder ✻; its 179 real spinner verbs are the pool |

**The Claude Code pack is a placeholder on purpose.** Claude Code's spinner is not an image:
it cycles `· ✢ * ✶ ✻ ✽` as terminal text, 2 s per frame, forward then back, blending the colour
toward `rgb(171,43,63)`. Reproducing that needs a text mode, not a GIF. Everything measured from
its binary is recorded in [assets/ClaudeCode/FINDINGS.md](assets/ClaudeCode/FINDINGS.md).

---

## Credits

- **Mechanism reference:** [`huanlinoto/dsh-plugin-prts-neuron`](https://github.com/huanlinoto/dsh-plugin-prts-neuron).
  No code was copied — that repository carries no license, so it was read for the DOM facts only
  (`data-chat-running`, `data-shimmer-text`, the icon box being the `svg`'s parent).
- **Claude Code verb list:** extracted from `@anthropic-ai/claude-code` v2.1.121 by
  [`shanraisshan/claude-code-best-practice`](https://github.com/shanraisshan/claude-code-best-practice),
  cross-checked against the verb array inside `claude.exe` 2.1.328.
- **Layout reference:** [`Saknutella/dsh-thinking-quips`](https://github.com/Saknutella/dsh-thinking-quips)
  for how a third-party page claims `settings.section`.

MIT.
