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

## 2. 动画：正走一遍再倒回来（呼吸），每帧 2 秒

```js
LYd = E8e()
ALo = [...LYd, ...[...LYd].reverse()]        // 12 帧
MYd = 2000                                    // 每帧 2000 ms
OYd = {r:171, g:43, b:63}                     // 目标色
NYd = {r:0, g:0, b:0}
TLo = "\u25CF"                                // ● 强度高时换成实心圆
```

```js
let eie = ALo[ldC % ALo.length]               // 取帧
```

**一个完整周期 = 12 × 2000 ms = 24 秒。**

---

## 3. 渲染：1 行 × 2 列的窄格子，颜色随强度插值

```js
// 字形
jsx(h, { color: nL(fdC), children: eie })
jsx(H, { "aria-hidden": true, flexWrap: "wrap", height: 1, width: 2, children: pB })

// 强度够高时换实心 ● 并加粗
jsx(h, { color: nL(pdC), bold: cUe >= 0.5, children: TLo })
```

**「呼吸」= 字形从小长到大 **+** 颜色从暗插值到 `rgb(171,43,63)`。**
**两件事同时发生。只做字形变化（GIF 常见做法）做不像。**

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

**不能用 GIF。** 必须是：

```
不是插 <img>，而是插 <span>
每 2000 ms 换一个字符：· ✢ * ✶ ✻ ✽ ✻ ✶ * ✢ ·
颜色在「当前文字色 ↔ rgb(171,43,63)」之间按强度插值
强度到顶时换 ● 并加粗
占 1 行 × 2 列，不是正方形
```

**这件事冻结在 M7 之后做（文本模式）。当前 Claude Code 套用占位图 + 真动词表。**
