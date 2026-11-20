# Claude Code 思考指示器 —— 二进制逆向还原

> 来源：`claude.exe`（winget 装的原生二进制，244 MB，Bun 打包，JS 以 Latin-1 + `\uXXXX` 转义内嵌）。
> 版本：**2.1.328**。所有结论下面都附了从二进制里读到的原始代码片段。

---

## 1. 字形数组（6 个，不是 7 个）

```js
E8e = Nr(() => {
  if (process.env.TERM === "xterm-ghostty")
    return ["\xB7","\u2722","\u2733","\u2736","\u273B","\u273B"];
  return ["\xB7","\u2722","*","\u2736","\u273B","\u273D"];
}, () => process.env.TERM);
```

**默认序列：**

| # | 字符 | 码点 | 形状 |
|---|---|---|---|
| 1 | · | U+00B7 | 点 |
| 2 | ✢ | U+2722 | 四瓣 |
| 3 | * | U+002A | 六芒 |
| 4 | ✶ | U+2736 | 八角 |
| 5 | ✻ | U+273B | 六瓣花 |
| 6 | ✽ | U+273D | 八瓣花 |

⚠️ **`✳`(U+2733) 只在 `TERM=xterm-ghostty` 变体里**，默认序列没有。
**之前按 7 个字形（含 ✳）做，方向就错了。**

---

## 2. 动画：余弦呼吸，一整趟 2 秒

**⚠️ 上面这段早期结论是错的，以本节为准。**

```js
Oon(e, t) = (1 - Math.cos(2 * Math.PI * e / t)) / 2    // 余弦，0 → 1 → 0
Qm_ = 2000                                             // 一整趟的毫秒数
sh_(e) = Math.round(Oon(e, Qm_) * (E8e().length - 1))  // 帧 = 呼吸值 × (n-1)
```

**`Qm_ = 2000` 是「一个来回」的总时长，不是「每帧」。**
**所以帧大约每 180ms 跳一档，2 秒走完「小 → 大 → 小」。**

```js
ALo = [...LYd, ...[...LYd].reverse()]
let eie = ALo[ldC % ALo.length]
```

**`ALo` 的倒序一半其实是冗余的**：`frame` 只取到 0..5，永远不会进到倒序段；
来回完全由余弦曲线给出。照抄数组反而会变成"正转一圈再倒转一圈"。

**另一组是终端 spinner，定义只有一处：**

```js
spinner: {
  interval: 80,
  frames: ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'].map(e => chalk.yellow(e))
}
```

**盲文、80ms/帧、黄色——这才是官方转圈本体。上面那组字形是另一个组件。**

---

## 3. 渲染：1 行 × 2 列的窄格子，颜色随强度插值

```js
// 字形
jsx(h, { color: nL(fdC), children: eie })
jsx(H, { "aria-hidden": true, flexWrap: "wrap", height: 1, width: 2, children: pB })

// 强度够高时换实心 ● 并加粗
jsx(h, { color: nL(pdC), bold: cUe >= 0.5, children: TLo })
```

**「呼吸」= 字形从小长到大 **+** 颜色变化。**
**但颜色不是跟着字形走的**：组件签名是

```js
{ frame, messageColor, stalledIntensity, thinkingIntensity, reducedMotion, time }
```

`frame` 决定字形；`stalledIntensity>0` 时才把颜色混向 `rgb(171,43,63)`；
`thinkingIntensity>0` 走向 warning 色；`reducedMotion` 时直接显示 `●`。
**正常状态下颜色就是主题的消息色。**

**我们自己实现时踩过两个坑：**
1. 把 `stalledIntensity` 当成了"帧亮度"，于是字形越大越红——错
2. 给盲文也套了正序+倒序，于是出现"一会儿顺时针一会儿逆时针"——错

---

## 4. 动作词：挂载时随机一个，整轮不变 —— **不轮换**

```js
function Of_(e) { var t = e.length; return t ? e[CKd(0, t-1)] : void 0 }   // 随机下标
nLo = Of_

let [W] = wz.useState(() => pO(N1t()))          // ← 挂载时取一次
let U = (a ?? activeForm ?? subject ?? (y || W)) + "\u2026"
```

**注意 `useState` 的惰性初始化：取一次就固定，整轮不换。**
**省略号 `…` 是渲染时拼上去的，不在词里。**

**我们的实现（每 7–15 秒换一句）是**我们自己加的**，不是 Claude Code 的行为。**

---

## 5. 动词表可配置

```js
function N1t() {
  let t = qn().spinnerVerbs;
  if (!t) return njs;
  if (t.mode === "replace") return t.verbs.length > 0 ? t.verbs : njs;
  return [...njs, ...t.verbs];      // 默认追加
}
```

---

## 6. 状态覆盖机制

渲染时按优先级取第一个非空：

```
overrideMessage → activeForm → subject → 随机动词
```

另有 `overrideColor` / `overrideShimmerColor` / `isCompacting` / `retryStatus` 等等。

---

## 7. 动词表落点

`verbs.json` —— **179 个**，来源是公开仓库从 v2.1.121 提取的表，
与二进制里的数组交叉验证一致（差异只有 `Channeling/Channelling` 一处拼写）。

---

## 8. 如果要做得「真的像」

**不能用 GIF。** 已实现为文本模式：

```
插 <span>，不是 <img>
盲文   10 帧单向循环，每帧 interval 毫秒（官方 80）
字符画 余弦呼吸，一整趟 period 毫秒（官方 2000），字号跟着变化
颜色   固定色，或跟随主题
文字   逐字打出 + 3 字符宽的亮带扫过（glimmerIndex = floor(t/200)）
```

**面板里两种模式可切，时长分开存（interval 是每帧，period 是一整趟）。**
