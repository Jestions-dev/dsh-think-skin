/**
 * ThinkSkin — browser half.
 *
 * Two jobs:
 *   1. rewrite the Chat running-status row (icon, copy, gradient)
 *   2. own the settings page (pack cards, per-image phrase pools)
 *
 * The row's shape, measured in M0:
 *
 *   <div data-chat-running="true">
 *     <span role="status" aria-live="polite">深度求索中</span>   ← screen reader, INSIDE
 *     <span class="…runningIcon"><svg viewBox="0 0 16 16">…</svg></span>
 *     <span class="…runningText">
 *       <span>深度求索中，用时 3秒 ···</span>
 *       <span data-shimmer-text="深度求索中，用时 3秒 ···"></span>
 *     </span>
 *   </div>
 *
 * React rewrites the row about once a second, so every write here is an
 * idempotent post-pass. State lives on the element: the plugin is re-applied
 * often enough that module variables cannot be trusted across a re-apply.
 */

window.__ModuleLoader__.load({
  id: 'dsh-think-skin',
  factory(require) {
    const ROUTE = '/think-skin'
    const ROW = '[data-chat-running]'
    const ICON_ATTR = 'data-ts-icon'
    const SHIMMER_ATTR = 'data-shimmer-text'
    const GRAD_ATTR = 'data-ts-grad'
    const STYLE_ID = 'think-skin-style'

    /** Upstream copy fragment we replace; the elapsed timer is left alone. */
    const SOURCE_LABEL = '深度求索中'

    /** Text rotation window, in milliseconds. */
    const ROTATE_MIN = 7000
    const ROTATE_MAX = 15000

    /**
     * 32px layout box with a 1.5× transform: the row lays out 32px while the
     * icon draws at 48px. Transform keeps the drawing out of layout.
     */
    const ICON_STYLE = [
      'width:32px',
      'height:32px',
      'flex:none',
      'object-fit:contain',
      'transform:scale(1.5)',
      'transform-origin:center',
      'margin-right:2px',
    ].join(';')

    const FALLBACK_TEXTS = ['正在思考']

    /**
     * Claude Code's spinner, taken from its binary: six glyphs that grow one
     * step at a time, played forward then backward, 2 s per step, with the
     * colour sliding toward rgb(171,43,63) as the glyph grows.
     */
    // Claude Code 的 spinner 定义（二进制里唯一的一处）：
    //   spinner: { interval: 80, frames: ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'].map(yellow) }
    const SPIN_BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    /**
     * 字符画那组，正走再倒回。
     *
     * 二进制里的默认数组是 ['·','✢','*','✶','✻','✽']。其中 `*`(U+002A) 和
     * `✶`(U+2736 实心六角星) 是锐利字形——终端等宽字体下还能看，浏览器里
     * 就是尖角，和 `✢ ✻ ✽` 这族水滴形完全不搭。所以只留水滴形那一族，
     * 顺序按"从点长成花"排：点 → 四瓣 → 六瓣 → 八瓣。
     */
    const SPIN_GLYPHS = ['·', '✢', '✻']

    const SPIN_INTERVAL = 80
    const SPIN_COOL = '#8b8f96'
    const SPIN_HOT = '#ab2b3f'
    const SPIN_ATTR = 'data-ts-spin'

    const DEFAULT_GRADIENT = ['#a8cdff', '#5b8dff']

    const React = require('react')
    const h = React.createElement

    const STYLE_TEXT = [
      // 扫光带：最上层是一条 3 字符宽的白色亮带，位置由 --ts-gl 驱动
      '[', GRAD_ATTR, '][data-ts-glimmer="1"] {',
      'background-image:',
      '  linear-gradient(100deg,',
      '    transparent calc(var(--ts-gl, 50%) - 7%),',
      '    rgba(255,255,255,.85) var(--ts-gl, 50%),',
      '    transparent calc(var(--ts-gl, 50%) + 7%)),',
      '  var(--ts-gradient);',
      '}',
      '[', GRAD_ATTR, '] {',
      'background-image: var(--ts-gradient);',
      'background-size: 100% 100%;',
      '-webkit-background-clip: text;',
      'background-clip: text;',
      'color: transparent;',
      '-webkit-text-fill-color: transparent;',
      '}',
      // 流动：图案本身首尾同色（见 loopGradient），位移正好一个图案周期
      // → 循环处无缝，不会突然快一下
      '[', GRAD_ATTR, '][data-ts-mode="flow"] {',
      'background-size: 200% 100%;',
      'animation: ts-flow var(--ts-flow-speed, 3s) linear infinite;',
      '}',
      '@keyframes ts-flow {',
      'from { background-position-x: 0%; }',
      'to { background-position-x: -200%; }',
      '}',

      // 扫光：图案宽 3 倍，高光只占中间一小段，剩下三分之二是安静底色
      // 位移 = 一个图案周期（3 格位移 → 百分比 -150%），循环处同样无缝
      '[', GRAD_ATTR, '][data-ts-mode="sweep"] {',
      'background-size: 300% 100%;',
      'animation: ts-sweep var(--ts-sweep-speed, 3s) linear infinite;',
      '}',
      '@keyframes ts-sweep {',
      'from { background-position-x: 0%; }',
      'to { background-position-x: -150%; }',
      '}',
      '.ts-card:hover { background: rgba(127,127,127,.13); }',
      // 鼠标点击不给焦点圈（它和"选中"撞车）；键盘 Tab 过来才显示
      '.ts-card:focus { outline: none; }',
      '.ts-card:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 2px; }',

      // 2D 拟物按钮：顶部高光 + 底部投影 = 凸起；按下时内阴影 + 位移 = 凹进去
      '.ts-btn {',
      '  border: 1px solid rgba(127,127,127,.45);',
      '  border-radius: 8px;',
      '  background: rgba(127,127,127,.11);',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,.14),',
      '              0 1px 2px rgba(0,0,0,.38);',
      '  transition: box-shadow .07s ease, transform .07s ease, background .12s;',
      '  outline: none;',
      '}',
      '.ts-btn:hover { background: rgba(127,127,127,.18); }',
      '.ts-btn:active {',
      '  transform: translateY(1px);',
      '  background: rgba(127,127,127,.08);',
      '  box-shadow: inset 0 2px 5px rgba(0,0,0,.5),',
      '              inset 0 -1px 0 rgba(255,255,255,.04);',
      '}',
      '.ts-btn:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 2px; }',

      // 主题：面板默认跟随系统，右上角可强制浅/深
      '.ts-root { color: var(--ts-fg); color-scheme: var(--ts-scheme); }',
      '.ts-root[data-ts-theme="dark"] {',
      '  --ts-fg: #e8e8e8; --ts-scheme: dark;',
      '  --ts-fill: rgba(255,255,255,.08); --ts-fill-hover: rgba(255,255,255,.14);',
      '}',
      '.ts-root[data-ts-theme="light"] {',
      '  --ts-fg: #1f2328; --ts-scheme: light;',
      '  --ts-fill: rgba(0,0,0,.06); --ts-fill-hover: rgba(0,0,0,.11);',
      '}',
      '.ts-row:hover { background: rgba(127,127,127,.08); }',
      '.ts-switch { position: relative; width: 38px; height: 22px; flex: none; border-radius: 999px;',
      '  background: rgba(127,127,127,.38); cursor: pointer; transition: background .15s; }',
      '.ts-switch[data-on="1"] { background: #4c8bf5; }',
      '.ts-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;',
      '  border-radius: 50%; background: #fff; transition: transform .15s; }',
      '.ts-switch[data-on="1"]::after { transform: translateX(16px); }',
    ].join('')

    function ensureStyle() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        // The plugin is re-applied without a page reload during development;
        // refresh the rules instead of trusting the ones already in the head.
        if (existing.textContent !== STYLE_TEXT) existing.textContent = STYLE_TEXT
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
    }

    /** Active pack, fetched once per page load. */
    let pack = null
    let loading = null

    function loadPack() {
      if (pack !== null) return Promise.resolve(pack)
      if (loading !== null) return loading
      loading = fetch(ROUTE + '/pack.json', { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('pack ' + response.status)
          return response.json()
        })
        .then((data) => {
          const packs = Array.isArray(data.packs) ? data.packs : []
          pack = packs.find((entry) => entry.id === data.active) || packs[0] || null
          if (data.settings !== undefined && data.settings !== null) {
            docSettings = {
              musicEnabled: data.settings.musicEnabled !== false,
              musicVolume: Number.isFinite(Number(data.settings.musicVolume))
                ? Number(data.settings.musicVolume)
                : 40,
            }
            Music.applyVolume()
          }
          return pack
        })
        .catch(() => null)
        .finally(() => {
          loading = null
        })
      return loading
    }

    function imageUrl(file) {
      return ROUTE + '/images/' + encodeURI(file)
    }

    /** Elapsed seconds in the row, or null when the copy has no timer yet. */
    function secondsOf(row) {
      const text = row.textContent || ''
      const m = text.match(/用时\s*(?:(\d+)\s*分)?\s*(\d+)\s*秒/)
      if (m === null) return null
      const minutes = m[1] === undefined ? 0 : Number(m[1])
      return minutes * 60 + Number(m[2])
    }

    function pickIndex(length, avoid) {
      if (length <= 1) return 0
      const index = Math.floor(Math.random() * length)
      if (index === avoid) return (index + 1 + Math.floor(Math.random() * (length - 1))) % length
      return index
    }

    /**
     * One image's effective pool: its own lines, optionally merged with the
     * pack's generic pool. Deduplicated, because a line in both is still one line.
     */
    function textsOf(image) {
      const own = image !== undefined && Array.isArray(image.texts) ? image.texts : []
      const generic = pack !== null && Array.isArray(pack.fallbackTexts) ? pack.fallbackTexts : []
      const merged = image !== undefined && image.useFallback === false ? own : own.concat(generic)
      const unique = Array.from(new Set(merged.filter((line) => typeof line === 'string' && line.length > 0)))
      if (unique.length > 0) return unique
      return generic.length > 0 ? generic : FALLBACK_TEXTS
    }

    function nextAt(now) {
      return String(now + ROTATE_MIN + Math.random() * (ROTATE_MAX - ROTATE_MIN))
    }

    /** Read, advance, and store the row's thinking state. */
    function stateOf(row) {
      if (pack === null) return null
      const isSpinner = pack.spinner !== undefined && pack.spinner !== null
      if (!isSpinner && (!Array.isArray(pack.images) || pack.images.length === 0)) return null
      const now = Date.now()
      const seconds = secondsOf(row)
      const lastSeconds = row.getAttribute('data-ts-sec')
      const storedImage = row.getAttribute('data-ts-img')
      const storedText = row.getAttribute('data-ts-txt')
      const due = Number(row.getAttribute('data-ts-next') || 0)

      const isNewRun =
        storedImage === null ||
        storedText === null ||
        (seconds !== null && lastSeconds !== null && seconds < Number(lastSeconds))

      let imageIndex = storedImage === null ? 0 : Number(storedImage) % pack.images.length
      let textIndex = storedText === null ? -1 : Number(storedText)

      if (isNewRun) {
        imageIndex = isSpinner ? 0 : pickIndex(pack.images.length, Number(storedImage ?? -1))
        textIndex = pickIndex(textsOf(pack.images[imageIndex]).length, -1)
        row.setAttribute('data-ts-next', nextAt(now))
      } else if (now >= due) {
        textIndex = pickIndex(textsOf(pack.images[imageIndex]).length, textIndex)
        row.setAttribute('data-ts-next', nextAt(now))
      }

      if (seconds !== null) row.setAttribute('data-ts-sec', String(seconds))
      row.setAttribute('data-ts-img', String(imageIndex))
      row.setAttribute('data-ts-txt', String(textIndex))

      const image = pack.images[imageIndex]
      const texts = textsOf(image)
      return { image, text: texts[Math.min(Math.max(textIndex, 0), texts.length - 1)] }
    }

    /** Put our image where the row's own icon box is, swapping it when the pick changes. */
    /** Mix two hex colours; used for the spinner's colour ramp. */
    function lerpHex(a, b, t) {
      const one = parseHex(a)
      const two = parseHex(b)
      if (one === null || two === null) return a
      return '#' + one
        .map((v, i) => Math.round(v + (two[i] - v) * t).toString(16).padStart(2, '0'))
        .join('')
    }

    /**
     * Draw the breathing glyph instead of an image.
     *
     * The frame comes from a timestamp stamped on the row rather than from a
     * timer: React rewrites the row every second, and a timer would restart.
     */
    function swapSpinner(row, spinnerConfig) {
      // 模式决定用哪组字符。以前 frames 会盖掉模式，于是"切成字符画还在转盲文"。
      const mode = spinnerConfig.mode === 'glyph' ? 'glyph' : 'braille'
      const glyphs = mode === 'glyph' ? SPIN_GLYPHS : SPIN_BRAILLE
      // 呼吸字形正反来回；盲文是单向转圈
      const frames = mode === 'glyph'
        ? glyphs.concat(glyphs.slice(0, -1).reverse())
        : glyphs
      // 两种模式的时长含义不同：盲文是"每帧多久"，字符画是"一整趟多久"。
      // 分开存，切换模式才不会把一个模式的数字带到另一个模式里。
      const interval = mode === 'glyph'
        ? (Number.isFinite(Number(spinnerConfig.period))
          ? Number(spinnerConfig.period)
          : 2000)
        : (Number.isFinite(Number(spinnerConfig.interval))
          ? Number(spinnerConfig.interval)
          : 165)
      const cool = typeof spinnerConfig.cool === 'string' ? spinnerConfig.cool : SPIN_COOL
      const hot = typeof spinnerConfig.hot === 'string' ? spinnerConfig.hot : SPIN_HOT
      const fixed = typeof spinnerConfig.color === 'string'
        ? spinnerConfig.color
        : (mode === 'glyph' ? '' : '#e5c07b')

      const existing = row.querySelector('span[' + SPIN_ATTR + ']')
      if (existing !== null) {
        // 配置变了就地更新；已经画出来的标记不会自己重建
        const signature = [frames.join(''), interval, cool, hot, fixed, mode].join('|')
        if (existing.getAttribute('data-ts-sig') !== signature) {
          existing.setAttribute('data-ts-glyphs', frames.join(''))
          existing.setAttribute('data-ts-interval', String(interval))
          existing.setAttribute('data-ts-cool', cool)
          existing.setAttribute('data-ts-hot', hot)
          existing.setAttribute('data-ts-fixed', fixed)
          existing.setAttribute('data-ts-count', String(glyphs.length))
          existing.setAttribute('data-ts-breathe', mode === 'glyph' ? '1' : '0')
          existing.setAttribute('data-ts-sig', signature)
          existing.setAttribute('data-ts-since', String(Date.now()))
        }
        return
      }

      const svg = row.querySelector('svg')
      const box = svg === null ? null : svg.parentElement
      if (box === null) return

      const mark = document.createElement('span')
      mark.setAttribute(SPIN_ATTR, '')
      mark.setAttribute('aria-hidden', 'true')
      mark.setAttribute('data-ts-glyphs', frames.join(''))
      mark.setAttribute('data-ts-interval', String(interval))
      mark.setAttribute('data-ts-cool', cool)
      mark.setAttribute('data-ts-hot', hot)
      // chalk 的 yellow ≈ #e5c07b，Claude Code 的转圈就是这个颜色
      mark.setAttribute('data-ts-fixed', fixed)
      mark.setAttribute('data-ts-count', String(glyphs.length))
      mark.setAttribute('data-ts-breathe', mode === 'glyph' ? '1' : '0')
      mark.setAttribute('data-ts-sig',
        [frames.join(''), interval, cool, hot, fixed, mode].join('|'))
      mark.setAttribute('data-ts-since', String(Date.now()))
      mark.style.cssText = [
        'width:32px',
        'height:32px',
        'flex:none',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'font-size:24px',
        'line-height:1',
        'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
      ].join(';')
      box.style.setProperty('display', 'none')
      box.before(mark)
    }

    /**
     * Move the glimmer band across every painted text run.
     *
     * Claude Code walks a highlight three characters wide over the message at
     * 200 ms per step; we reproduce the cadence and let it ride on top of the
     * static gradient.
     */
    function tickGlimmer(root, now) {
      let nodes
      try {
        nodes = root.querySelectorAll('[data-ts-glimmer="1"]')
      } catch {
        return
      }
      for (const element of nodes) {
        const since = Number(element.getAttribute('data-ts-gl-since')) || now
        const length = (element.textContent || '').length || 12
        const span = length + 6
        // 和打字同速：亮带每步走一个字符，两条动效不会互相打架
        const step = TYPE_MS
        const pos = Math.floor((now - since) / step) % span
        const percent = ((pos / span) * 120 - 10).toFixed(2) + '%'
        if (element.style.getPropertyValue('--ts-gl') !== percent) {
          element.style.setProperty('--ts-gl', percent)
        }
      }
    }

    /** Advance every visible spinner to the frame the clock says it is on. */
    function tickSpinners(root) {
      let marks
      try {
        marks = root.querySelectorAll('span[' + SPIN_ATTR + ']')
      } catch {
        return
      }
      const now = Date.now()
      for (const mark of marks) {
        const frames = (mark.getAttribute('data-ts-glyphs') || '').split('')
        if (frames.length === 0) continue
        const interval = Number(mark.getAttribute('data-ts-interval')) || SPIN_INTERVAL
        const since = Number(mark.getAttribute('data-ts-since')) || now
        const elapsed = now - since
        const breathe = mark.getAttribute('data-ts-breathe') === '1'

        // 官方：Oon(t) = (1 - cos(2πt / 2000)) / 2，帧 = round(Oon * (n-1))
        // 也就是说 2000ms 走完「小→大→小」一整趟，不是每帧 2000ms。
        let index
        let phase
        if (breathe) {
          const period = interval > 0 ? interval : 2000
          phase = (1 - Math.cos(2 * Math.PI * elapsed / period)) / 2
          index = Math.round(phase * (frames.length - 1))
        } else {
          index = Math.floor(elapsed / interval) % frames.length
          phase = 0
        }
        const glyph = frames[index]
        if (mark.textContent !== glyph) mark.textContent = glyph
        // 固定色（例如 Claude Code 的黄色）直接套；没配颜色就跟着主题走。
        // 只有 glyph 模式才做"卡住变红"的混色，而且那是独立强度，不跟帧。
        // 字号跟着呼吸走：点最小，花最大。20px 上下浮动看不出形状差别，
        // 加上尺寸变化，"从点长成花"才读得出来。
        const size = Math.round((breathe ? 15 + phase * 11 : 22) * 10) / 10
        const sizeText = size.toFixed(1) + 'px'
        if (mark.style.fontSize !== sizeText) mark.style.fontSize = sizeText

        const fixed = mark.getAttribute('data-ts-fixed')
        if (fixed !== null && fixed !== '') {
          if (mark.style.color !== fixed) mark.style.color = fixed
        }
      }
    }

    function swapIcon(row, src) {
      const existing = row.querySelector(`img[${ICON_ATTR}]`)
      if (existing !== null) {
        if (existing.getAttribute('src') !== src) existing.src = src
        return
      }
      const svg = row.querySelector('svg')
      const box = svg === null ? null : svg.parentElement
      if (box === null) return
      const image = document.createElement('img')
      image.setAttribute(ICON_ATTR, '')
      image.setAttribute('aria-hidden', 'true')
      image.alt = ''
      image.draggable = false
      image.style.cssText = ICON_STYLE
      image.src = src
      image.addEventListener('error', () => {
        image.remove()
        box.style.removeProperty('display')
      }, { once: true })
      box.style.setProperty('display', 'none')
      box.before(image)
    }

    /**
     * Rewrite the copy wherever it lives. Replaces both the upstream label and
     * our previous text, so a rotation reaches a string React has not rewritten.
     * @returns the elements that received new visible text, for gradient painting.
     */
    /** 每字符的揭示间隔：12 个字符约 1.1 秒打完。 */
    const TYPE_MS = 90

    function swapCopy(row, full) {
      // 词条换了就重置打字进度；同一个词一直打，打完就停
      if (row.getAttribute('data-ts-full') !== full) {
        row.setAttribute('data-ts-full', full)
        row.setAttribute('data-ts-typed-at', String(Date.now()))
        row.setAttribute('data-ts-shown', '')
      }
      const startedAt = Number(row.getAttribute('data-ts-typed-at')) || Date.now()
      const typed = Math.min(full.length, Math.max(1, Math.floor((Date.now() - startedAt) / TYPE_MS)))
      const text = full.slice(0, typed)
      const previous = row.getAttribute('data-ts-shown')
      const targets = new Set()
      const replaceIn = (value) => {
        let next = value
        if (next.includes(SOURCE_LABEL)) next = next.split(SOURCE_LABEL).join(text)
        if (previous !== null && previous !== '' && previous !== text && next.includes(previous)) {
          next = next.split(previous).join(text)
        }
        // 上游写的是「文案，用时 3秒」。文案常常自带标点，紧跟一个逗号很挤，
        // 换成两个空格；React 每秒写回原样，所以每次都要重新替换。
        // 只认「，用时」这一处，文案内部的逗号不受影响。
        // 间隔：一个全角空格 + 一个半角空格（约 1.25em），比原来两个半角宽一倍多
        if (next.includes('，用时')) next = next.split('，用时').join('\u3000 用时')
        return next
      }

      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue
        if (value === null) continue
        const next = replaceIn(value)
        if (next === value) continue
        node.nodeValue = next
        const parent = node.parentElement
        if (parent !== null && parent.closest('[role="status"]') === null) targets.add(parent)
      }
      for (const element of row.querySelectorAll(`[${SHIMMER_ATTR}]`)) {
        const value = element.getAttribute(SHIMMER_ATTR)
        if (value === null) continue
        const next = replaceIn(value)
        if (next !== value) element.setAttribute(SHIMMER_ATTR, next)
      }

      row.setAttribute('data-ts-shown', text)
      return targets
    }

    /** Paint the pack's gradient onto the elements that hold our copy. */
    function applyGradient(targets, appearance) {
      const rawMode = appearance !== undefined && typeof appearance.mode === 'string'
        ? appearance.mode
        : 'static'
      const mode = ['none', 'static', 'flow', 'sweep'].includes(rawMode) ? rawMode : 'static'
      const colors = appearance !== undefined && Array.isArray(appearance.gradient)
        ? appearance.gradient
        : null
      const usable = colors !== null && colors.length >= 2 && mode !== 'none'
      let gradient = ''
      if (usable) {
        if (mode === 'sweep') {
          gradient = sweepGradient(colors[0], colors.length > 1 ? colors[1] : '#ffffff')
        } else if (mode === 'flow') {
          gradient = loopGradient(colors)
        } else {
          gradient = 'linear-gradient(90deg, ' + colors.join(', ') + ')'
        }
      }
      const glimmer = appearance === undefined || appearance.glimmer !== false
      const glimmerable = glimmer && (mode === 'static' || mode === 'none')

      for (const element of targets) {
        if (!usable) {
          if (element.hasAttribute(GRAD_ATTR)) {
            element.removeAttribute(GRAD_ATTR)
            element.style.removeProperty('--ts-gradient')
            element.style.removeProperty('--ts-flow-speed')
          }
          continue
        }
        if (element.style.getPropertyValue('--ts-gradient') === gradient
          && element.getAttribute('data-ts-mode') === mode) continue
        element.setAttribute(GRAD_ATTR, '')
        element.setAttribute('data-ts-mode', mode)
        if (glimmerable) {
          if (element.getAttribute('data-ts-glimmer') !== '1') {
            element.setAttribute('data-ts-glimmer', '1')
            element.setAttribute('data-ts-gl-since', String(Date.now()))
          }
        } else if (element.hasAttribute('data-ts-glimmer')) {
          element.removeAttribute('data-ts-glimmer')
          element.style.removeProperty('--ts-gl')
        }
        element.style.setProperty('--ts-gradient', gradient)
        const seconds = appearance !== undefined && Number.isFinite(Number(appearance.speed))
          ? Math.max(1, Math.min(60, Number(appearance.speed)))
          : 3
        element.style.setProperty('--ts-flow-speed', seconds + 's')
        element.style.setProperty('--ts-base', colors[0])
        element.style.setProperty('--ts-shine', colors.length > 1 ? colors[1] : '#ffffff')
        element.style.setProperty('--ts-sweep-speed', seconds + 's')
      }
    }

    // ---------------------------------------------------------------- music

    /** 文档根部的音乐设置，loadPack 时顺手抓下来。 */
    let docSettings = { musicEnabled: true, musicVolume: 40 }

    function musicUrl(file) {
      return ROUTE + '/music/' + encodeURI(file)
    }

    /** 当前这一行用哪一组音乐：本图的池，加上（默认）通用池。 */
    function musicPoolOf(state) {
      if (pack === null || state === null || state === undefined) return []
      const merged = []
      const image = state.image
      if (image !== undefined && image !== null && Array.isArray(image.music)) {
        for (const track of image.music) merged.push(track)
      }
      if (image === undefined || image === null || image.useFallbackMusic !== false) {
        for (const track of Array.isArray(pack.fallbackMusic) ? pack.fallbackMusic : []) {
          merged.push(track)
        }
      }
      return merged
    }

    /**
     * 思考行出现时放歌：单例、洗牌袋、极短淡入淡出。
     *
     * 不走 <audio>：那条路由整块返回字节，而音频元素会先探测长度、按 Range 分块取。
     * 空闲时把 AudioContext 挂起 —— 一直 running 会让系统不敢进休眠。
     */
    const Music = (() => {
      let audio = null
      let master = null
      let playing = null        // 正在放的曲目 id
      let active = false        // 思考行是否在
      let starting = false      // 有一次 play 还在 await，期间不许再起
      let pool = []
      let poolKey = ''
      let bag = []
      let token = 0
      let idleTimer = 0
      const live = new Set()    // 所有没停掉的音源：万一有漏网的，也一定能一起叫停
      const cache = new Map()

      function ensure() {
        if (audio !== null) return audio
        const AC = window.AudioContext || window.webkitAudioContext
        if (AC === undefined) return null
        try {
          audio = new AC()
          master = audio.createGain()
          master.gain.value = volumeGain()
          master.connect(audio.destination)
        } catch {
          audio = null
          master = null
        }
        return audio
      }

      function volumeGain() {
        const raw = Number(docSettings.musicVolume)
        const v = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 40
        return Math.pow(v / 100, 1.7) * 0.9
      }

      function unlock() {
        const ac = ensure()
        if (ac === null) return Promise.resolve()
        if (ac.state === 'suspended') return ac.resume().catch(() => {})
        return Promise.resolve()
      }
      if (typeof document !== 'undefined') {
        const once = () => {
          unlock()
          document.removeEventListener('pointerdown', once, true)
          document.removeEventListener('keydown', once, true)
        }
        document.addEventListener('pointerdown', once, true)
        document.addEventListener('keydown', once, true)
      }

      function idle() {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (audio !== null && playing === null && live.size === 0 && audio.state === 'running') {
            audio.suspend().catch(() => {})
          }
        }, 20000)
      }

      async function bytes(file) {
        if (cache.has(file)) return cache.get(file)
        try {
          const response = await fetch(musicUrl(file), { cache: 'force-cache' })
          if (!response.ok) return null
          const buffer = await response.arrayBuffer()
          cache.set(file, buffer)
          while (cache.size > 3) cache.delete(cache.keys().next().value)
          return buffer
        } catch {
          return null
        }
      }

      function shuffle() {
        bag = pool.slice()
        for (let i = bag.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1))
          const tmp = bag[i]
          bag[i] = bag[j]
          bag[j] = tmp
        }
        if (bag.length > 1 && bag[0].id === playing) {
          const tmp = bag[0]
          bag[0] = bag[1]
          bag[1] = tmp
        }
      }

      function pick() {
        if (pool.length === 0) return null
        if (bag.length === 0) shuffle()
        return bag.shift() || null
      }

      /** 停掉每一路音源（可带淡出），并把它们从活音源集合里清掉。 */
      function killAll(fadeMs) {
        const dying = Array.from(live)
        live.clear()
        for (const node of dying) {
          try {
            if (fadeMs > 0) {
              const now = audio === null ? 0 : audio.currentTime
              node.gain.gain.cancelScheduledValues(now)
              node.gain.gain.setValueAtTime(node.gain.gain.value, now)
              node.gain.gain.linearRampToValueAtTime(0.0001, now + fadeMs / 1000)
            }
          } catch {
            /* 节点可能已经断了 */
          }
        }
        const wait = fadeMs > 0 ? fadeMs + 60 : 0
        setTimeout(() => {
          for (const node of dying) {
            try {
              node.source.onended = null
              node.source.stop()
            } catch {
              /* 已经停了 */
            }
            try {
              node.source.disconnect()
              node.gain.disconnect()
            } catch {
              /* 同上 */
            }
          }
        }, wait)
        playing = null
      }

      function stop() {
        token += 1
        starting = false
        if (playing !== null || live.size > 0) killAll(300)
        idle()
      }

      async function play(track) {
        const ac = ensure()
        if (ac === null) return
        const mine = ++token
        starting = true
        const data = await bytes(track.file)
        if (mine !== token) {
          starting = false
          return
        }
        if (data === null) {
          starting = false
          if (active) setTimeout(() => next(), 400)
          return
        }
        let buffer = null
        try {
          buffer = await ac.decodeAudioData(data.slice(0))
        } catch {
          buffer = null
        }
        if (mine !== token) {
          starting = false
          return
        }
        if (buffer === null) {
          starting = false
          if (active) setTimeout(() => next(), 400)
          return
        }
        await unlock()
        if (mine !== token) {
          starting = false
          return
        }

        // 到这里才真正开声音：先清掉可能残留的其它音源，保证同时只有一路
        killAll(0)
        const gain = ac.createGain()
        const source = ac.createBufferSource()
        source.buffer = buffer
        gain.gain.value = 0.0001
        source.connect(gain)
        gain.connect(master)
        const node = { source, gain }
        live.add(node)
        playing = track.id

        const started = ac.currentTime
        const fade = Math.min(0.25, buffer.duration / 4)
        try {
          gain.gain.setValueAtTime(0.0001, started)
          gain.gain.linearRampToValueAtTime(1, started + fade)
        } catch {
          gain.gain.value = 1
        }

        source.onended = () => {
          live.delete(node)
          try {
            source.disconnect()
            gain.disconnect()
          } catch {
            /* 已经断了 */
          }
          if (playing === track.id) playing = null
          if (mine !== token) return
          if (active) setTimeout(() => next(), 120)
          else idle()
        }

        try {
          source.start(0)
        } catch {
          live.delete(node)
          playing = null
          starting = false
          return
        }
        starting = false

        // 结尾先淡出，别硬切
        const tail = Math.max(0, buffer.duration - Math.min(0.3, buffer.duration / 4))
        setTimeout(() => {
          if (mine !== token || !live.has(node)) return
          try {
            const now = ac.currentTime
            gain.gain.cancelScheduledValues(now)
            gain.gain.setValueAtTime(gain.gain.value, now)
            gain.gain.linearRampToValueAtTime(0.0001, now + 0.26)
          } catch {
            /* 已经结束 */
          }
        }, Math.max(200, tail * 1000))
      }

      function next() {
        if (!active || starting || playing !== null || live.size > 0) return
        const track = pick()
        if (track === null) return
        play(track)
      }

      function sync(want, list) {
        const enabled = docSettings.musicEnabled !== false
        const key = list.map((t) => t.id).join('|')
        if (key !== poolKey) {
          poolKey = key
          bag = []
          if (playing !== null && !list.some((t) => t.id === playing)) stop()
        }
        pool = list
        const should = want && enabled && list.length > 0
        if (!should) {
          if (active) {
            active = false
            stop()
          }
          return
        }
        active = true
        if (playing === null && !starting && live.size === 0) next()
      }

      /** 巡检：paint 有可能漏掉「行没了」这一帧，这里兜住。 */
      function tick(hasRow) {
        if (!hasRow && active) {
          active = false
          stop()
        }
      }

      function applyVolume() {
        if (master === null || audio === null) return
        const target = volumeGain()
        try {
          const now = audio.currentTime
          // 取消排队中的自动化再线性过渡 80ms：拖滑轨时是立刻听出来的
          master.gain.cancelScheduledValues(now)
          master.gain.setValueAtTime(master.gain.value, now)
          master.gain.linearRampToValueAtTime(target, now + 0.08)
        } catch {
          master.gain.value = target
        }
      }

      function previewVolume(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return
        docSettings = {
          musicEnabled: docSettings.musicEnabled,
          musicVolume: Math.max(0, Math.min(100, Math.round(n))),
        }
        applyVolume()
      }

      return { sync, tick, applyVolume, previewVolume, unlock, stop }
    })()
    function paint(root) {
      if (pack === null) {
        loadPack().then(() => paint(document))
        return
      }
      let rows
      try {
        rows = root.querySelectorAll(ROW)
      } catch {
        return
      }
      const spinner = pack.spinner !== undefined && pack.spinner !== null
        ? pack.spinner
        : null

      let firstState = null
      for (const row of rows) {
        const state = stateOf(row)
        if (state === null) continue
        if (firstState === null) firstState = state
        if (spinner !== null) swapSpinner(row, spinner)
        else swapIcon(row, imageUrl(state.image.file))
        const targets = swapCopy(row, state.text)
        applyGradient(targets, pack.appearance)
      }
      tickSpinners(document)
      // 行还在 = 正在思考，音乐跟着走；行消失就淡出
      Music.sync(rows.length > 0, musicPoolOf(firstState))
    }

    /** Replace the in-memory pack after a save, then repaint. */
    function adoptDocument(data) {
      const packs = Array.isArray(data.packs) ? data.packs : []
      pack = packs.find((entry) => entry.id === data.active) || packs[0] || null
      if (data.settings !== undefined && data.settings !== null) {
        docSettings = {
          musicEnabled: data.settings.musicEnabled !== false,
          musicVolume: Number.isFinite(Number(data.settings.musicVolume))
            ? Number(data.settings.musicVolume)
            : 40,
        }
        Music.applyVolume()
      }
      paint(document)
    }

    // ---------------------------------------------------------------- settings

    const S = {
      section: { display: 'flex', flexDirection: 'column', gap: '22px', maxWidth: '720px' },
      label: { fontSize: '12px', opacity: 0.6, marginBottom: '8px', display: 'block' },
      cards: { display: 'flex', flexWrap: 'wrap', gap: '10px' },
      card: {
        width: '96px',
        padding: '8px',
        border: '1px solid transparent',
        outline: 'none',
        boxShadow: 'none',
        WebkitTapHighlightColor: 'transparent',
        borderRadius: '10px',
        background: 'rgba(127,127,127,.06)',
        color: 'inherit',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        font: 'inherit',
      },
      cardOn: { borderColor: '#4c8bf5', background: 'rgba(76,139,245,.14)' },
      cardOff: { borderColor: 'transparent', outline: 'none', boxShadow: 'none' },
      cardArt: {
        width: '64px',
        height: '64px',
        objectFit: 'contain',
        borderRadius: '6px',
        background: 'rgba(127,127,127,.10)',
      },
      cardArtEmpty: {
        width: '64px',
        height: '64px',
        borderRadius: '6px',
        background: 'rgba(127,127,127,.10)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '20px',
        opacity: 0.5,
      },
      cardName: {
        fontSize: '11px',
        textAlign: 'center',
        lineHeight: 1.2,
        wordBreak: 'break-all',
        maxHeight: '28px',
        overflow: 'hidden',
      },
      poolList: {
        border: '1px solid rgba(127,127,127,.25)',
        borderRadius: '12px',
        overflowY: 'auto',
        overflowX: 'hidden',
        // 黄金矩形：高度由宽度算出，不写死像素
        aspectRatio: '1.618',
      },
      poolRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '10px 16px',
        minHeight: '90px',
        boxSizing: 'border-box',
        cursor: 'pointer',
        borderBottom: '1px solid rgba(127,127,127,.15)',
      },
      poolThumb: {
        width: '56px',
        height: '56px',
        objectFit: 'contain',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.10)',
        flex: 'none',
      },
      poolPreview: {
        flex: 1,
        minWidth: 0,
        fontSize: '12px',
        opacity: 0.8,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      poolCount: { fontSize: '11px', opacity: 0.45, flex: 'none' },
      field: {
        font: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid rgba(127,127,127,.4)',
        borderRadius: '8px',
        padding: '6px 9px',
      },
      btn: {
        font: 'inherit',
        fontSize: '13px',
        color: 'inherit',
        padding: '5px 12px',
        cursor: 'pointer',
        background: 'rgba(127,127,127,.11)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      hint: { fontSize: '12px', opacity: 0.55 },
      danger: { fontSize: '11px', opacity: 0.5, cursor: 'pointer', color: 'inherit', background: 'transparent', border: 'none', font: 'inherit' },
    }

    /**
     * A file picker that looks like the rest of the panel.
     *
     * The native input button cannot be styled to match, so it hides and a plain
     * button drives it. `directory` turns on folder selection; the attribute is
     * set through the node because React does not know `webkitdirectory`.
     */
    function FilePick({ label, accept, multiple, directory, onFiles }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const node = ref.current
        if (node !== null && directory === true) node.setAttribute('webkitdirectory', '')
      }, [directory])
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'ts-btn',
          style: { ...S.btn, fontSize: '12px', padding: '4px 10px' },
          onClick: () => {
            if (ref.current !== null) ref.current.click()
          },
        }, label),
        h('input', {
          ref,
          type: 'file',
          accept: accept === undefined ? 'image/gif,image/png,image/webp' : accept,
          multiple: multiple !== false,
          style: { display: 'none' },
          onChange: (event) => {
            const files = Array.from(event.target.files || [])
            event.target.value = ''
            onFiles(files)
          },
        }),
      )
    }

    /** Parse #rgb / #rrggbb into [r,g,b], or null. */
    function parseHex(hex) {
      let body = String(hex).replace('#', '')
      if (body.length === 3) body = body.split('').map((c) => c + c).join('')
      if (!/^[0-9a-f]{6}$/i.test(body)) return null
      return [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16))
    }

    /** Blend two hex colors, t=0 gives a, t=1 gives b. */
    function mixHex(a, b, t) {
      const one = parseHex(a)
      const two = parseHex(b)
      if (one === null || two === null) return a
      return '#' + one
        .map((v, i) => Math.round(v + (two[i] - v) * t).toString(16).padStart(2, '0'))
        .join('')
    }

    /**
     * A gradient that tiles seamlessly.
     *
     * A plain linear-gradient(a, b) ends on b and starts on a, so the next tile
     * puts b beside a: a visible hard seam every tile width. Mirroring the
     * sequence gives both edges the same color.
     */
    function loopGradient(colors) {
      const seq = colors.concat(colors.slice(0, -1).reverse())
      const segments = seq.length - 1
      const span = 100 / segments
      // 线性插值在浅色一侧显得"一下就过去"。每段插 6 个子色标，用 smoothstep
      // 缓入缓出，两端慢、中间快，过渡才看起来是晕开的。
      const SUB = 6
      const stops = []
      for (let segment = 0; segment < segments; segment += 1) {
        const from = seq[segment]
        const to = seq[segment + 1]
        const start = segment * span
        for (let k = 0; k < SUB; k += 1) {
          const t = k / SUB
          const eased = t * t * (3 - 2 * t)
          stops.push([start + span * t, mixHex(from, to, eased)])
        }
      }
      stops.push([100, seq[seq.length - 1]])
      return 'linear-gradient(90deg, '
        + stops.map(([at, color]) => color + ' ' + at.toFixed(2) + '%').join(', ')
        + ')'
    }

    /**
     * Base color with one soft shine band, the rest flat.
     *
     * Five interpolated stops per side instead of two is what makes the light
     * bloom rather than arrive as a hard stripe; the flat two thirds are what
     * make a pass read as an event instead of a conveyor belt.
     */
    function sweepGradient(base, shine) {
      const stops = [
        [0, base], [40, base],
        [43, mixHex(base, shine, 0.20)],
        [46, mixHex(base, shine, 0.58)],
        [50, shine],
        [54, mixHex(base, shine, 0.58)],
        [57, mixHex(base, shine, 0.20)],
        [60, base], [100, base],
      ]
      return 'linear-gradient(100deg, '
        + stops.map(([at, color]) => color + ' ' + at + '%').join(', ')
        + ')'
    }

    /**
     * A live copy of the spinner mark, driven by the values in the form rather
     * than the saved ones, so switching mode shows the result immediately.
     */
    function SpinPreview({ mode, interval, color }) {
      const glyphs = mode === 'glyph' ? SPIN_GLYPHS : SPIN_BRAILLE
      const [, setTick] = React.useState(0)
      const startedAt = React.useRef(Date.now())
      React.useEffect(() => {
        startedAt.current = Date.now()
      }, [mode, interval, color])
      React.useEffect(() => {
        const timer = window.setInterval(() => setTick((n) => n + 1), 40)
        return () => window.clearInterval(timer)
      }, [])

      const elapsed = Date.now() - startedAt.current
      let index
      let phase
      if (mode === 'glyph') {
        const period = interval > 0 ? interval : 2000
        phase = (1 - Math.cos((2 * Math.PI * elapsed) / period)) / 2
        index = Math.round(phase * (glyphs.length - 1))
      } else {
        index = Math.floor(elapsed / Math.max(16, interval)) % glyphs.length
        phase = 0
      }
      const size = mode === 'glyph' ? 15 + phase * 11 : 22
      const shade = typeof color === 'string' && color !== ''
        ? color
        : (mode === 'glyph' ? 'currentColor' : '#e5c07b')

      return h('span', {
        style: {
          width: '30px',
          height: '30px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size.toFixed(1) + 'px',
          lineHeight: 1,
          color: shade,
          fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
        },
        'aria-hidden': true,
      }, glyphs[index])
    }

    /**
     * The little preview line under the gradient controls.
     *
     * It draws from the pack's own pool instead of a hard-coded sentence, so
     * the preview shows what that pack will actually say. Glyph packs also get
     * the typewriter cadence and switch phrase every two seconds.
     */
    function PreviewLine({ lines, typing, gradient, mode, speed, gradientMode }) {
      const [phrase, setPhrase] = React.useState('正在思考')
      const [shown, setShown] = React.useState('正在思考')
      const key = lines.join('\u0000')

      React.useEffect(() => {
        const pick = () => (lines.length === 0
          ? '正在思考'
          : lines[Math.floor(Math.random() * lines.length)])
        setPhrase(pick())
        if (!typing) return undefined
        // 预览里 5 秒换一次词条，比真实那行慢，看着不吵
        const timer = window.setInterval(() => setPhrase(pick()), 5000)
        return () => window.clearInterval(timer)
      }, [key, typing])

      React.useEffect(() => {
        if (!typing) {
          setShown(phrase)
          return undefined
        }
        let count = 0
        setShown('')
        const timer = window.setInterval(() => {
          count += 1
          setShown(phrase.slice(0, count))
          if (count >= phrase.length) window.clearInterval(timer)
        }, 90)
        return () => window.clearInterval(timer)
      }, [phrase, typing])

      if (gradientMode === 'none') {
        return h('span', { style: { fontWeight: 600 } }, shown)
      }
      return h('span', {
        'data-ts-grad': '',
        'data-ts-mode': gradientMode,
        style: {
          '--ts-gradient': mode === 'sweep'
            ? sweepGradient(gradient[0], gradient.length > 1 ? gradient[1] : '#ffffff')
            : mode === 'flow'
              ? loopGradient(gradient)
              : 'linear-gradient(90deg, ' + gradient.join(', ') + ')',
          '--ts-flow-speed': speed + 's',
          '--ts-base': gradient[0],
          '--ts-shine': gradient.length > 1 ? gradient[1] : '#ffffff',
          '--ts-sweep-speed': speed + 's',
          fontWeight: 600,
        },
      }, shown)
    }

    const previewOf = (lines) => (lines.length === 0 ? '（空）' : lines.slice(0, 5).join(' · ') + (lines.length > 5 ? ' …' : ''))

    /**
     * Settings page.
     *
     * The phrase pools are one vertical list: the pack's generic pool first, then
     * one row per image. Clicking a row opens its editor.
     */
    function SettingsPanel() {
      const [data, setData] = React.useState(null)
      const [selected, setSelected] = React.useState('')
      const [musicEnabled, setMusicEnabled] = React.useState(true)
      const [musicVolume, setMusicVolume] = React.useState(40)
      const [gradient, setGradient] = React.useState(DEFAULT_GRADIENT)
      const [gradientMode, setGradientMode] = React.useState('static')
      const [gradientSpeed, setGradientSpeed] = React.useState(3)
      const [spinMode, setSpinMode] = React.useState('braille')
      const [spinInterval, setSpinInterval] = React.useState(165)
      const [spinPeriod, setSpinPeriod] = React.useState(2000)
      const [spinColor, setSpinColor] = React.useState('#e5c07b')
      const [detail, setDetail] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [note, setNote] = React.useState('')
      const [newName, setNewName] = React.useState('')

      React.useEffect(() => {
        const settings = data === null || data.settings === undefined ? null : data.settings
        if (settings === null || settings === null) return
        setMusicEnabled(settings.musicEnabled !== false)
        setMusicVolume(Number.isFinite(Number(settings.musicVolume)) ? Number(settings.musicVolume) : 40)
      }, [data])
      const [coverFile, setCoverFile] = React.useState(null)
      const [coverPreview, setCoverPreview] = React.useState('')
      const [seedFiles, setSeedFiles] = React.useState([])
      const [importDoc, setImportDoc] = React.useState(null)
      const [importZip, setImportZip] = React.useState(null)
      const [importPreviews, setImportPreviews] = React.useState({})
      const [importCover, setImportCover] = React.useState(null)
      const [importUrl, setImportUrl] = React.useState('')
      const [theme, setTheme] = React.useState(() => {
        try {
          const saved = window.localStorage.getItem('think-skin-theme')
          return saved === 'light' || saved === 'dark' ? saved : 'auto'
        } catch {
          return 'auto'
        }
      })

      function adoptPack(entry) {
        setSelected(entry.id)
        const appearance = entry.appearance === undefined ? {} : entry.appearance
        const colors = Array.isArray(appearance.gradient) ? appearance.gradient : []
        setGradient(colors.length >= 2 ? colors.slice(0, 4) : DEFAULT_GRADIENT)
        setGradientMode(
          ['none', 'flow', 'sweep'].includes(appearance.mode) ? appearance.mode : 'static',
        )
        setGradientSpeed(
          Number.isFinite(Number(appearance.speed)) ? Number(appearance.speed) : 3,
        )
        const spinner = entry.spinner === undefined || entry.spinner === null ? {} : entry.spinner
        setSpinMode(spinner.mode === 'glyph' ? 'glyph' : 'braille')
        setSpinInterval(Number.isFinite(Number(spinner.interval)) ? Number(spinner.interval) : 165)
        setSpinPeriod(Number.isFinite(Number(spinner.period)) ? Number(spinner.period) : 2000)
        setSpinColor(typeof spinner.color === 'string' ? spinner.color : '')
        setDetail(null)
      }

      function load(keepSelection) {
        const wanted = keepSelection === true ? selected : ''
        fetch(ROUTE + '/pack.json', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((document) => {
            setData(document)
            const packs = Array.isArray(document.packs) ? document.packs : []
            const entry = packs.find((p) => p.id === wanted)
              || packs.find((p) => p.id === document.active)
              || packs[0]
            if (entry !== undefined) adoptPack(entry)
            if (packs.length === 0) setNote('还没有装任何套')
          })
          .catch((error) => setNote('读取失败：' + error.message))
      }

      React.useEffect(() => {
        load(false)
      }, [])

      const packs = data !== null && Array.isArray(data.packs) ? data.packs : []
      const current = packs.find((p) => p.id === selected)

      const systemDark = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
      const resolvedTheme = theme === 'auto' ? (systemDark ? 'dark' : 'light') : theme
      const themeLabel = theme === 'auto' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'

      function cycleTheme() {
        const next = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto'
        setTheme(next)
        try {
          window.localStorage.setItem('think-skin-theme', next)
        } catch {
          /* a locked-down storage just means the choice does not persist */
        }
      }

      const rootProps = {
        className: 'ts-root',
        'data-ts-theme': resolvedTheme,
        style: S.section,
      }

      function post(url, body) {
        return fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then((response) => (response.ok
          ? response.json()
          : response.text().then((t) => Promise.reject(new Error(t)))))
      }

      /** Save whatever the caller changed, then repaint the row. */
      function commit(patch, message) {
        post(ROUTE + '/settings', patch)
          .then((document) => {
            setData(document)
            adoptDocument(document)
            const entry = document.packs.find((p) => p.id === (patch.pack || document.active))
            if (entry !== undefined && detail === null) adoptPack(entry)
            setNote(message)
          })
          .catch((error) => setNote('保存失败：' + error.message))
      }

      function saveSpinner() {
        commit({
          pack: selected,
          spinner: {
            mode: spinMode,
            interval: spinInterval,
            period: spinPeriod,
            color: spinColor,
          },
        }, '字形已保存')
      }

      function saveGradient() {
        commit({ pack: selected, gradient, mode: gradientMode, speed: gradientSpeed, active: selected }, '已保存')
      }

      function switchPack(id) {
        const entry = packs.find((p) => p.id === id)
        if (entry === undefined) return
        adoptPack(entry)
        commit({ active: id }, '已切换到 ' + id)
      }

      function createPack() {
        const id = newName.trim()
        if (id === '') {
          setNote('套名不能为空')
          return
        }
        setNote('创建中…')
        post(ROUTE + '/pack', { action: 'create', id })
          .then(async (created) => {
            let failed = 0
            let cover = null
            if (coverFile !== null) {
              const receipt = await uploadOne(coverFile, id)
              if (receipt === null) failed += 1
              else cover = receipt.added
            }
            for (const file of seedFiles) {
              const receipt = await uploadOne(file, id)
              if (receipt === null) failed += 1
            }
            if (cover !== null) {
              return post(ROUTE + '/settings', { pack: id, cover })
            }
            return created
          })
          .then((document) => {
            setData(document)
            setNewName('')
            setCoverFile(null)
            setCoverPreview('')
            setSeedFiles([])
            setDetail(null)
            const entry = document.packs.find((p) => p.id === id)
            if (entry !== undefined) adoptPack(entry)
            setNote('已创建 ' + id)
          })
          .catch((error) => setNote('新建失败：' + error.message))
      }

      function deletePack(id) {
        post(ROUTE + '/pack', { action: 'delete', id })
          .then((document) => {
            setData(document)
            adoptDocument(document)
            const entry = document.packs.find((p) => p.id === document.active) || document.packs[0]
            if (entry !== undefined) adoptPack(entry)
            setNote('已删除 ' + id)
          })
          .catch((error) => setNote('删除失败：' + error.message))
      }

      /** Upload one file into a pack. Resolves to the parsed receipt, or null. */
      function uploadOne(file, packId) {
        return file.arrayBuffer()
          .then((buffer) => fetch(ROUTE + '/upload?pack=' + encodeURIComponent(packId), {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-ts-name': encodeURIComponent(file.name),
            },
            body: buffer,
          }))
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
      }

      /** Minimal zip reader: reads the central directory, stores entries as-is. */
      function readZipEntries(buffer) {
        const view = new DataView(buffer)
        const bytes = new Uint8Array(buffer)
        let end = -1
        const floor = Math.max(0, bytes.length - 22 - 0xffff)
        for (let i = bytes.length - 22; i >= floor; i -= 1) {
          if (view.getUint32(i, true) === 0x06054b50) {
            end = i
            break
          }
        }
        if (end < 0) throw new Error('不是 zip 文件')
        const count = view.getUint16(end + 10, true)
        let cursor = view.getUint32(end + 16, true)
        const entries = new Map()
        for (let i = 0; i < count; i += 1) {
          if (view.getUint32(cursor, true) !== 0x02014b50) break
          const method = view.getUint16(cursor + 10, true)
          const compressed = view.getUint32(cursor + 20, true)
          const nameLength = view.getUint16(cursor + 28, true)
          const extraLength = view.getUint16(cursor + 30, true)
          const commentLength = view.getUint16(cursor + 32, true)
          const localOffset = view.getUint32(cursor + 42, true)
          const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
          const localName = view.getUint16(localOffset + 26, true)
          const localExtra = view.getUint16(localOffset + 28, true)
          const start = localOffset + 30 + localName + localExtra
          entries.set(name, { method, raw: bytes.subarray(start, start + compressed) })
          cursor += 46 + nameLength + extraLength + commentLength
        }
        return entries
      }

      /** Stored entries pass through; deflated ones go through DecompressionStream. */
      async function entryBytes(entry) {
        if (entry.method === 0) return entry.raw
        const stream = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
        return new Uint8Array(await new Response(stream).arrayBuffer())
      }

            /** Save a JSON payload as a download. */
      function download(name, text) {
        const blob = new Blob([text], { type: 'application/json' })
        const href = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.download = name
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(href), 1000)
      }

      function exportPack() {
        if (current === undefined) return
        setNote('导出中…')
        fetch(ROUTE + '/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pack: current.id }),
        })
          .then((response) => {
            if (!response.ok) {
              return response.text().then((t) => Promise.reject(new Error(t)))
            }
            return response.blob()
          })
          .then((blob) => {
            const href = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = href
            anchor.download = current.id + '.tskin.zip'
            anchor.click()
            window.setTimeout(() => URL.revokeObjectURL(href), 1000)
            setNote('已导出 ' + Math.round(blob.size / 1024) + ' KB')
          })
          .catch((error) => setNote('导出失败：' + error.message))
      }

      /** Read a pack file in the browser so the page can preview it first. */
      function adoptImport(document, zipBytes, previews) {
        setImportDoc(document)
        setImportZip(zipBytes)
        setImportPreviews(previews)
        const images = Array.isArray(document.pack.images) ? document.pack.images : []
        setImportCover(document.pack.cover || (images[0] === undefined ? null : images[0].file))
        setNote('已载入 ' + images.length + ' 张图，可以换封面或直接导入')
      }

      function loadPackFile(files) {
        const file = files[0]
        if (file === undefined) return
        const isZip = /\.zip$/i.test(file.name)
        if (!isZip) {
          file.text()
            .then((text) => {
              const document = JSON.parse(text)
              if (document.format !== 'dsh-think-skin/pack') {
                setNote('这不是套组文件')
                return
              }
              const previews = {}
              for (const image of document.pack.images || []) {
                if (typeof image.data === 'string') {
                  previews[image.file] = 'data:image/gif;base64,' + image.data
                }
              }
              adoptImport(document, null, previews)
            })
            .catch((error) => setNote('文件解析失败：' + error.message))
          return
        }

        file.arrayBuffer()
          .then(async (buffer) => {
            const entries = readZipEntries(buffer)
            const manifestEntry = entries.get('pack.json')
            if (manifestEntry === undefined) {
              setNote('压缩包里没有 pack.json')
              return
            }
            const document = JSON.parse(new TextDecoder().decode(await entryBytes(manifestEntry)))
            if (document.format !== 'dsh-think-skin/pack') {
              setNote('这不是套组文件')
              return
            }
            const previews = {}
            for (const image of document.pack.images || []) {
              const entry = entries.get(image.file)
              if (entry === undefined) continue
              const bytes = await entryBytes(entry)
              previews[image.file] = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }))
            }
            adoptImport(document, buffer, previews)
          })
          .catch((error) => setNote('解压失败：' + error.message))
      }

      function finishImport(receipt) {
        setNote('已导入「' + receipt.pack + '」，' + receipt.images + ' 张图')
        setImportDoc(null)
        setImportCover(null)
        setImportUrl('')
        setDetail(null)
        load(true)
      }

      function runImport() {
        if (importDoc === null) {
          setNote('先选一个套组文件')
          return
        }
        setNote('导入中…')
        if (importZip !== null) {
          // zip 直接原样上传，宿主那边解；封面改动通过请求头带过去
          fetch(ROUTE + '/import', {
            method: 'POST',
            headers: {
              'content-type': 'application/zip',
              'x-ts-cover': encodeURIComponent(importCover === null ? '' : importCover),
            },
            body: importZip,
          })
            .then((response) => (response.ok
              ? response.json()
              : response.text().then((t) => Promise.reject(new Error(t)))))
            .then(finishImport)
            .catch((error) => setNote('导入失败：' + error.message))
          return
        }
        const document = { ...importDoc, pack: { ...importDoc.pack, cover: importCover } }
        post(ROUTE + '/import', { file: document })
          .then(finishImport)
          .catch((error) => setNote('导入失败：' + error.message))
      }

      function importFromUrl() {
        const url = importUrl.trim()
        if (url === '') {
          setNote('先填一个 URL')
          return
        }
        setNote('下载中…')
        post(ROUTE + '/import', { url })
          .then(finishImport)
          .catch((error) => setNote('下载导入失败：' + error.message))
      }

      function upload(files) {
        const list = Array.from(files || [])
        if (list.length === 0) return
        if (selected === '') {
          setNote('先选一个套')
          return
        }
        setNote('导入中… ' + list.length + ' 个')
        let done = 0
        let failed = 0
        const next = () => {
          done += 1
          if (done < list.length) return
          setNote(failed === 0
            ? '已导入 ' + (list.length - failed) + ' 个到 ' + selected
            : '导入完成，失败 ' + failed + ' 个')
          load(true)
        }
        for (const file of list) {
          uploadOne(file, selected)
            .then((receipt) => {
              if (receipt === null) failed += 1
            })
            .finally(next)
        }
      }

      // ---- music pool ------------------------------------------------------

    /** 把一首歌传进某个池：imageId 为空 = 这个套的通用音乐池。 */
    function uploadMusic(file, packId, imageId) {
      const query = '?pack=' + encodeURIComponent(packId)
        + (imageId ? '&image=' + encodeURIComponent(imageId) : '')
      return fetch(ROUTE + '/music' + query, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-ts-name': encodeURIComponent(file.name),
        },
        body: file,
      }).then((response) => {
        if (!response.ok) throw new Error('music ' + response.status)
        return response.json()
      })
    }

    function removeMusic(packId, imageId, id) {
      return post(ROUTE + '/music-remove', { pack: packId, image: imageId || undefined, id })
    }

    function humanSize(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    /** 一个音乐池：导入、列表、删除。通用池和单图池共用这一个。 */
    function MusicPool({ packId, imageId, list, note, onChanged }) {
      const [busy, setBusy] = React.useState('')
      const tracks = Array.isArray(list) ? list : []

      const add = (files) => {
        const picked = Array.from(files || [])
        if (picked.length === 0) return
        setBusy('导入中… ' + picked.length + ' 个')
        let done = 0
        const step = () => {
          done += 1
          if (done < picked.length) return
          setBusy('')
          onChanged()
        }
        for (const file of picked) {
          uploadMusic(file, packId, imageId).catch(() => {}).finally(step)
        }
      }

      // 一个框装一整池：内容多就往下长，长到 220px 之后自己滚
      const box = {
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: '10px',
        background: 'rgba(127,127,127,.05)',
        overflow: 'hidden',
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: S.row },
          h(FilePick, { label: '导入音乐', multiple: true, accept: 'audio/*', onFiles: add }),
          h('span', { style: S.hint }, tracks.length === 0 ? '空池' : tracks.length + ' 首'),
          busy === '' ? null : h('span', { style: S.hint }, busy),
        ),

        h('div', { style: box },
          tracks.length === 0
            ? h('div', {
                style: { padding: '14px 14px', fontSize: '12px', opacity: 0.55, textAlign: 'center' },
              }, '还没有音乐。点上面「导入音乐」，可以多选。')
            : h('div', {
                style: { display: 'flex', flexDirection: 'column', maxHeight: '220px', overflowY: 'auto' },
              },
                tracks.map((track, i) => h('div', {
                  key: track.id,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    padding: '7px 12px',
                    fontSize: '12px',
                    borderTop: i === 0 ? 'none' : '1px solid rgba(127,127,127,.16)',
                  },
                },
                  h('span', {
                    style: {
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  }, track.name || track.id),
                  h('span', { style: { opacity: 0.5, flex: 'none' } }, humanSize(track.size)),
                  h('button', {
                    type: 'button',
                    style: { ...S.danger, flex: 'none' },
                    onClick: () => {
                      removeMusic(packId, imageId, track.id).then(onChanged).catch(() => {})
                    },
                  }, '删除'),
                )),
              ),
        ),

        note === '' ? null : h('span', { style: S.hint }, note),
      )
    }
    function openGeneric() {
        setNote('')
        setDetail({ kind: 'generic' })
        setDraft((current === undefined ? [] : current.fallbackTexts || []).join('\n'))
      }

      function openImage(image) {
        setNote('')
        setDetail({ kind: 'image', id: image.id, name: image.name })
        setDraft((image.texts || []).join('\n'))
      }

      function saveDetail() {
        const lines = draft.split('\n')
        if (detail.kind === 'generic') {
          commit({ pack: selected, fallbackTexts: lines }, '通用池已保存')
        } else {
          commit({ pack: selected, image: { id: detail.id, texts: lines } }, '文案已保存')
        }
        setDetail(null)
      }

      function toggleFallback(image) {
        commit({ pack: selected, image: { id: image.id, useFallback: image.useFallback === false } }, '')
      }

      function toggleFallbackMusic(image) {
        if (image === undefined) return
        const next = image.useFallbackMusic === false
        commit({ pack: selected, image: { id: image.id, useFallbackMusic: next } }, '')
      }

      // ---- detail view -------------------------------------------------------

      if (detail !== null && detail.kind === 'import') {
        const images = importDoc === null || !Array.isArray(importDoc.pack.images)
          ? []
          : importDoc.pack.images
        return h('div', rootProps,
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('strong', { style: { fontSize: '14px' } }, '导入套组'),
            h('button', {
              type: 'button',
              className: 'ts-btn',
              style: S.btn,
              onClick: () => {
                setDetail(null)
                setImportDoc(null)
              },
            }, '返回'),
          ),

          h('div', { style: { ...S.row, alignItems: 'flex-start', gap: '20px' } },
            h('div', { style: { ...S.card, ...S.cardOn, cursor: 'default', flex: 'none' } },
              importCover === null
                ? h('div', { style: S.cardArtEmpty }, '空')
                : h('img', {
                  // 还没导入时它在存储里不存在，用浏览器刚解出来的对象 URL
                  src: importPreviews[importCover] || imageUrl(importCover),
                  style: S.cardArt,
                  alt: '',
                }),
              h('div', { style: S.cardName },
                importDoc === null ? '未载入' : (importDoc.pack.id || '导入的套')),
            ),
            h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', null,
                h('span', { style: S.label }, '本地文件（整份复制进内部存储）'),
                h('div', { style: S.row },
                  h(FilePick, {
                    label: '选 .zip',
                    accept: '.zip,application/zip',
                    multiple: false,
                    onFiles: loadPackFile,
                  }),
                  h(FilePick, {
                    label: '选旧版 .json',
                    accept: '.json,application/json',
                    multiple: false,
                    onFiles: loadPackFile,
                  }),
                  h('span', { style: S.hint },
                    importDoc === null ? '未选择' : images.length + ' 张图已载入'),
                ),
              ),
              h('div', null,
                h('span', { style: S.label }, '或者从 URL 下载（由宿主下载，绕过跨域）'),
                h('div', { style: S.row },
                  h('input', {
                    value: importUrl,
                    placeholder: 'https://example.com/pack.zip',
                    style: { ...S.field, flex: 1, minWidth: '220px' },
                    onChange: (event) => setImportUrl(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') importFromUrl()
                    },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'ts-btn',
                    style: S.btn,
                    onClick: importFromUrl,
                  }, '下载并导入'),
                ),
              ),
              images.length === 0
                ? null
                : h('div', null,
                  h('span', { style: S.label }, '换封面（点一张，导入后它就是封面）'),
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                    images.slice(0, 60).map((image, index) => h('img', {
                      key: 'cover' + index,
                      src: importPreviews[image.file] || '',
                      alt: '',
                      onClick: () => setImportCover(image.file),
                      style: {
                        width: '44px',
                        height: '44px',
                        objectFit: 'contain',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: 'rgba(127,127,127,.10)',
                        outline: importCover === image.file ? '2px solid #4c8bf5' : 'none',
                      },
                    })),
                  ),
                ),
            ),
          ),

          h('div', { style: S.row },
            h('button', {
              type: 'button',
              className: 'ts-btn',
              style: S.btn,
              onClick: runImport,
            }, '导入'),
            h('span', { style: S.hint }, note),
          ),

          // 小广告：作者自己的下载器
          h('div', {
            style: {
              marginTop: '6px',
              padding: '10px 14px',
              borderRadius: '10px',
              border: '1px dashed rgba(127,127,127,.35)',
              background: 'rgba(127,127,127,.05)',
              fontSize: '12px',
              lineHeight: 1.7,
              opacity: 0.75,
            },
          },
            h('strong', { style: { fontWeight: 600 } }, '顺带一提'),
            h('br'),
            'URL 只认直链：对象存储、GitHub raw、你自己的静态服务器都行；网盘分享页拿不到直链，用不了。',
            h('br'),
            '推荐作者自己的 DLS（下载服务器插件）：多线程 + 断点续传，几十 MB 的包下起来稳一些。',
            h('br'),
            h('span', { style: { opacity: 0.7 } }, '（只是推荐，这里和 DLS 没有联动。）'),
          ),
        )
      }

      if (detail !== null && detail.kind === 'create') {
        return h('div', rootProps,
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('strong', { style: { fontSize: '14px' } }, '新建套组'),
            h('button', {
              type: 'button',
              className: 'ts-btn',
              style: S.btn,
              onClick: () => setDetail(null),
            }, '返回'),
          ),
          h('div', { style: { ...S.row, alignItems: 'flex-start', gap: '20px' } },
            // 实时预览：和列表里的卡片同一套样式
            h('div', { style: { ...S.card, ...S.cardOn, cursor: 'default', flex: 'none' } },
              coverPreview === ''
                ? h('div', { style: S.cardArtEmpty }, '空')
                : h('img', { src: coverPreview, style: S.cardArt, alt: '' }),
              h('div', { style: S.cardName }, newName.trim() === '' ? '新套组' : newName.trim()),
            ),
            h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', null,
                h('span', { style: S.label }, '套名'),
                h('input', {
                  value: newName,
                  placeholder: '例如 酒狐 2',
                  autoFocus: true,
                  style: { ...S.field, width: '100%' },
                  onChange: (event) => setNewName(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') createPack()
                  },
                }),
              ),
              h('div', null,
                h('span', { style: S.label }, '封面（可留空，用第一张导入的图）'),
                h('div', { style: S.row },
                  h(FilePick, {
                    label: '选封面',
                    multiple: false,
                    onFiles: (files) => {
                      const file = files[0]
                      setCoverFile(file === undefined ? null : file)
                      setCoverPreview(file === undefined ? '' : URL.createObjectURL(file))
                    },
                  }),
                  coverPreview === '' ? null : h('button', {
                    type: 'button',
                    style: S.danger,
                    onClick: () => {
                      setCoverFile(null)
                      setCoverPreview('')
                    },
                  }, '清除'),
                ),
              ),
              h('div', null,
                h('span', { style: S.label }, '顺便导入图片（多选，或整个文件夹）'),
                h('div', { style: S.row },
                  h(FilePick, {
                    label: '选图片',
                    onFiles: (files) => setSeedFiles(files),
                  }),
                  h(FilePick, {
                    label: '选文件夹',
                    directory: true,
                    onFiles: (files) => setSeedFiles(files.filter((f) => /\.(gif|png|webp|apng|jpe?g)$/i.test(f.name))),
                  }),
                  h('span', { style: S.hint },
                    seedFiles.length === 0 ? '未选择' : seedFiles.length + ' 个文件'),
                ),
              ),
            ),
          ),
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              className: 'ts-btn',
              style: S.btn,
              onClick: createPack,
            }, '创建'),
            h('span', { style: S.hint }, note),
          ),
        )
      }

      if (detail !== null) {
        const title = detail.kind === 'generic' ? '通用文案池' : '「' + (detail.name || detail.id) + '」的文案'
        const detailImage = detail.kind === 'image'
          ? (current === undefined ? [] : current.images).find((img) => img.id === detail.id)
          : undefined
        return h('div', rootProps,
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('strong', { style: { fontSize: '14px' } }, title),
            h('button', {
              type: 'button',
              className: 'ts-btn',
              style: S.btn,
              onClick: () => setDetail(null),
            }, '返回'),
          ),
          detail.kind === 'generic'
            ? h('div', { style: S.hint },
                '通用池由这一套共用。某张图打开「也用通用文案池」后，它的句子会和这里合在一起随机。')
            : h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                h('div', null,
                  h('div', { style: { fontSize: '13px' } }, '也用通用文案池'),
                  h('div', { style: S.hint }, '开启：和通用池合在一起随机（去重）；关闭：只抽这张图自己的'),
                ),
                h('div', {
                  className: 'ts-switch',
                  'data-on': detailImage !== undefined && detailImage.useFallback !== false ? '1' : '0',
                  onClick: () => toggleFallback(detailImage),
                  role: 'switch',
                  'aria-checked': detailImage !== undefined && detailImage.useFallback !== false,
                }),
              ),

          // 改文案时要看得见图：左边放大图，右边一行小预览
          detail.kind === 'image' && detailImage !== undefined
            ? h('div', { style: { ...S.row, alignItems: 'flex-start', gap: '18px' } },
              h('img', {
                src: imageUrl(detailImage.file),
                alt: '',
                style: {
                  width: '96px',
                  height: '96px',
                  objectFit: 'contain',
                  borderRadius: '10px',
                  background: 'rgba(127,127,127,.08)',
                  flex: 'none',
                },
              }),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('span', { style: { fontSize: '12px', opacity: 0.6 } },
                  detailImage.name || detailImage.id),
                h('div', { style: { ...S.row, gap: '8px' } },
                  h('span', { style: S.hint }, '预览'),
                  h(PreviewLine, {
                    lines: (draft.split('\n').map((l) => l.trim()).filter((l) => l !== '')),
                    typing: true,
                    gradient: gradient,
                    mode: gradientMode,
                    speed: gradientSpeed,
                    gradientMode: gradientMode,
                  }),
                ),
              ),
            )
            : null,

          h('div', null,
            h('span', { style: S.label },
              detail.kind === 'generic' ? '通用音乐池（这一套所有图共用）' : '这张图的音乐池'),
            h(MusicPool, {
              packId: selected,
              imageId: detail.kind === 'generic' ? '' : detail.id,
              list: detail.kind === 'generic'
                ? (current === undefined ? null : current.fallbackMusic)
                : (detailImage === undefined ? null : detailImage.music),
              note: '',
              onChanged: () => load(true),
            }),
            detail.kind === 'generic'
              ? null
              : h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: '4px' } },
                  h('div', null,
                    h('div', { style: { fontSize: '13px' } }, '也用通用音乐'),
                    h('div', { style: S.hint }, '开启：和通用音乐池合在一起抽（默认）；关闭：只放这张图自己的'),
                  ),
                  h('div', {
                    className: 'ts-switch',
                    'data-on': detailImage !== undefined && detailImage.useFallbackMusic !== false ? '1' : '0',
                    onClick: () => toggleFallbackMusic(detailImage),
                    role: 'switch',
                    'aria-checked': detailImage !== undefined && detailImage.useFallbackMusic !== false,
                  }),
                ),
          ),

          h('div', null,
            h('span', { style: S.label }, '一行一句；这张图会从这些句子里随机'),
            h('textarea', {
              value: draft,
              rows: 12,
              style: { ...S.field, width: '100%', resize: 'vertical' },
              onChange: (event) => setDraft(event.target.value),
            }),
          ),
          h('div', { style: S.row },
            h('button', { type: 'button', className: 'ts-btn',
              style: S.btn, onClick: saveDetail }, '保存'),
            h('span', { style: S.hint }, note),
          ),
        )
      }

      // ---- list view ---------------------------------------------------------

      const isSpinnerPack = current !== undefined
        && current.spinner !== undefined
        && current.spinner !== null
      const images = current === undefined || !Array.isArray(current.images) ? [] : current.images
      const generic = current === undefined ? [] : current.fallbackTexts || []
      const previewLines = Array.from(new Set(
        generic.concat(images.flatMap((img) => (Array.isArray(img.texts) ? img.texts : []))),
      )).filter((line) => typeof line === 'string' && line.length > 0)

      return h('div', rootProps,

        // 顶部工具条：主题切换放在最右边
        h('div', { style: { ...S.row, justifyContent: 'flex-end', marginBottom: '-10px' } },
          h('button', {
            type: 'button',
            className: 'ts-btn',
            style: { ...S.btn, fontSize: '12px', padding: '4px 10px' },
            title: '点击切换：跟随系统 → 浅色 → 深色',
            onClick: cycleTheme,
          }, '主题：' + themeLabel),
        ),

        // 音乐：总开关 + 音量（照系统音量条那一排）
        h('div', null,
          h('span', { style: S.label }, '音乐'),
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '10px 14px', borderRadius: '10px',
              background: 'rgba(127,127,127,.07)',
            },
          },
            h('svg', {
              width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
              stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
              strokeLinejoin: 'round', style: { opacity: musicEnabled ? 0.9 : 0.35, flex: 'none' },
            },
              h('path', { d: 'M4 9v6h3.5L12 19V5L7.5 9H4z' }),
              musicEnabled && musicVolume > 0 ? h('path', { d: 'M16 8.5a5 5 0 0 1 0 7' }) : null,
              musicEnabled && musicVolume > 50 ? h('path', { d: 'M18.6 6a8.5 8.5 0 0 1 0 12' }) : null,
            ),
            h('input', {
              type: 'range', min: 0, max: 100, step: 1,
              value: musicVolume,
              disabled: !musicEnabled,
              style: { flex: 1, minWidth: 0, accentColor: '#4c8bf5' },
              onChange: (event) => {
                const next = Number(event.target.value)
                setMusicVolume(next)
                Music.previewVolume(next)
              },
              onPointerUp: () => commit({ musicVolume: musicVolume }, ''),
              onKeyUp: () => commit({ musicVolume: musicVolume }, ''),
            }),
            h('span', { style: { fontSize: '12px', opacity: 0.6, width: '34px', textAlign: 'right', flex: 'none' } },
              musicEnabled ? musicVolume + '%' : '关'),
            h('div', {
              className: 'ts-switch',
              'data-on': musicEnabled ? '1' : '0',
              role: 'switch',
              'aria-checked': musicEnabled,
              title: '思考时放音乐',
              onClick: () => commit({ musicEnabled: !musicEnabled }, ''),
            }),
          ),
          h('div', { style: S.hint },
            '只在「思考中」那一行出现时播放，行一消失就淡出。用哪几首在下面每张图 / 通用池里配。'),
        ),

        // pack cards
        h('div', null,
          h('span', { style: S.label }, '套组'),
          h('div', { style: S.cards },
            packs.map((entry) => h('button', {
              key: entry.id,
              type: 'button',
              className: 'ts-card',
              style: entry.id === selected ? { ...S.card, ...S.cardOn } : { ...S.card, ...S.cardOff },
              onClick: () => switchPack(entry.id),
              title: entry.builtin === true ? '内置套（不可改名或删除）' : entry.id,
            },
              entry.cover === null || entry.cover === undefined
                ? h('div', { style: S.cardArtEmpty }, '空')
                : h('img', { src: imageUrl(entry.cover), style: S.cardArt, alt: '' }),
              h('div', { style: S.cardName }, entry.id),
            )),
            h('button', {
              type: 'button',
              className: 'ts-card',
              style: S.card,
              onClick: () => {
                setNewName('')
                setNote('')
                setDetail({ kind: 'create' })
              },
            },
              h('div', { style: S.cardArtEmpty }, '+'),
              h('div', { style: S.cardName }, '新建'),
            ),
            h('button', {
              type: 'button',
              className: 'ts-card',
              style: S.card,
              onClick: () => {
                setImportDoc(null)
                setImportCover(null)
                setImportUrl('')
                setNote('')
                setDetail({ kind: 'import' })
              },
            },
              h('div', { style: S.cardArtEmpty }, '↧'),
              h('div', { style: S.cardName }, '导入套组'),
            ),
          ),
        ),

        // 字形包（没有图片，用字符转圈）
        current !== undefined && current.spinner !== undefined && current.spinner !== null
          ? h('div', null,
            h('span', { style: S.label }, '字形（这一套用字符转圈，不用图片）'),
            h('div', { style: S.row },
              h('span', { style: S.hint }, '模式'),
              [['braille', '盲文'], ['glyph', '字符画']].map(([id, text]) => h('button', {
                key: 'spin-' + id,
                type: 'button',
                className: 'ts-btn',
                style: {
                  ...S.btn,
                  padding: '4px 10px',
                  ...(spinMode === id ? { borderColor: '#4c8bf5', background: 'rgba(76,139,245,.16)' } : null),
                },
                onClick: () => setSpinMode(id),
              }, text)),
              h('span', { style: S.hint }, spinMode === 'glyph' ? '整趟时长' : '帧间隔'),
              h('input', {
                type: 'number',
                min: 16,
                max: 6000,
                step: 10,
                value: spinMode === 'glyph' ? spinPeriod : spinInterval,
                style: { ...S.field, width: '76px', padding: '4px 6px' },
                onChange: (event) => {
                  const value = Number(event.target.value)
                  if (!Number.isFinite(value)) return
                  const clamped = Math.max(16, Math.min(6000, Math.round(value)))
                  if (spinMode === 'glyph') setSpinPeriod(clamped)
                  else setSpinInterval(clamped)
                },
              }),
              h('span', { style: S.hint }, 'ms'),
              h('span', { style: S.hint }, '颜色'),
              h('input', {
                type: 'color',
                value: spinColor === '' ? '#e5c07b' : spinColor,
                onChange: (event) => setSpinColor(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'ts-btn',
                style: { ...S.btn, fontSize: '12px', padding: '4px 10px' },
                title: '去掉固定色，让字形跟着主题走',
                onClick: () => setSpinColor(''),
              }, '用主题色'),
              h('button', {
                type: 'button',
                className: 'ts-btn',
                style: S.btn,
                onClick: saveSpinner,
              }, '保存'),
            ),
            h('div', { style: { ...S.row, marginTop: '10px' } },
              h('span', { style: S.hint }, '预览'),
              h(SpinPreview, {
                mode: spinMode,
                interval: spinMode === 'glyph' ? spinPeriod : spinInterval,
                color: spinColor,
              }),
              h(PreviewLine, {
                lines: previewLines,
                typing: true,
                gradient: gradient,
                mode: gradientMode,
                speed: gradientSpeed,
                gradientMode: gradientMode,
              }),
            ),
            h('div', { style: { marginTop: '6px', fontSize: '12px', opacity: 0.55 } },
              '盲文：⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ 单向转圈，时长＝每帧毫秒（官方 80）。'
              + '字符画：· ✢ ✻ 余弦呼吸，时长＝一整趟毫秒（官方 2000）。两个值各存各的。'),
          )
          : null,

        // gradient
        h('div', null,
          h('span', { style: S.label }, '文字渐变（2–4 色）'),
          h('div', { style: S.row },
            gradient.map((color, index) => h('input', {
              key: 'c' + index,
              type: 'color',
              value: color,
              onChange: (event) => {
                const next = gradient.slice()
                next[index] = event.target.value
                setGradient(next)
              },
            })),
            gradient.length < 4
              ? h('button', {
                type: 'button',
                className: 'ts-btn',
                style: { ...S.btn, padding: '4px 9px' },
                title: '加一个颜色',
                onClick: () => setGradient(gradient.concat(gradient[gradient.length - 1])),
              }, '+')
              : null,
            gradient.length > 2
              ? h('button', {
                type: 'button',
                className: 'ts-btn',
                style: { ...S.btn, padding: '4px 9px' },
                title: '去掉最后一个颜色',
                onClick: () => setGradient(gradient.slice(0, -1)),
              }, '−')
              : null,
          ),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h('span', { style: S.hint }, '模式'),
            [['none', '无渐变'], ['static', '静态'], ['flow', '流动'], ['sweep', '扫光']].map(([id, text]) => h('button', {
              key: id,
              type: 'button',
              className: 'ts-btn',
              style: {
                ...S.btn,
                padding: '4px 10px',
                ...(gradientMode === id ? { borderColor: '#4c8bf5', background: 'rgba(76,139,245,.16)' } : null),
              },
              onClick: () => setGradientMode(id),
            }, text)),
            h('span', { style: { ...S.hint, marginLeft: '4px' } }, '一圈'),
            h('input', {
              type: 'number',
              min: 1,
              max: 60,
              step: 1,
              value: gradientSpeed,
              style: { ...S.field, width: '58px', padding: '4px 6px' },
              onChange: (event) => {
                const value = Number(event.target.value)
                if (Number.isFinite(value)) {
                  setGradientSpeed(Math.max(1, Math.min(60, Math.round(value))))
                }
              },
            }),
            h('span', { style: S.hint }, '秒'),
            h('button', { type: 'button', className: 'ts-btn', style: S.btn, onClick: saveGradient }, '保存'),
          ),
          h('div', { style: { marginTop: '6px', fontSize: '12px', opacity: 0.55 } },
            '扫光只用前两个颜色：第一个是字的底色，第二个是高光。第 3、4 个颜色在扫光模式下不参与，'
            + '切回流动/静态才用得上。'),
          h('div', { style: { ...S.row, marginTop: '10px' } },
            h('span', { style: S.hint }, '预览'),
            h(PreviewLine, {
              lines: previewLines,
              typing: isSpinnerPack,
              gradient: gradient,
              mode: gradientMode,
              speed: gradientSpeed,
              gradientMode: gradientMode,
            }),
          ),
        ),

        // phrase pools
        h('div', null,
          h('span', { style: S.label }, '文案池'),
          h('div', {
            style: isSpinnerPack
              ? { ...S.poolList, aspectRatio: 'auto', overflowY: 'visible' }
              : S.poolList,
          },
            h('div', {
              className: 'ts-row',
              style: S.poolRow,
              onClick: openGeneric,
            },
              h('div', {
                style: {
                  ...S.poolThumb,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  lineHeight: 1.15,
                  textAlign: 'center',
                  padding: '4px',
                },
              }, '通用文案池'),
              h('div', { style: S.poolPreview }, '通用 · ' + previewOf(generic)),
              h('span', { style: S.poolCount }, generic.length + ' 句'),
            ),
            (current !== undefined && current.spinner !== undefined && current.spinner !== null
              ? []
              : images).map((image) => h('div', {
              key: image.id,
              className: 'ts-row',
              style: S.poolRow,
              onClick: () => openImage(image),
            },
              h('img', { src: imageUrl(image.file), style: S.poolThumb, alt: '' }),
              h('div', { style: S.poolPreview },
                (image.name === undefined ? '' : image.name + ' · ')
                + previewOf(Array.from(new Set((image.texts || []).concat(
                  image.useFallback === false ? [] : generic,
                ))))),
              h('span', { style: S.poolCount }, (image.texts || []).length + ' 句'),
            )),
          ),
          h('span', { style: { ...S.hint, display: 'block', marginTop: '6px' } },
            current !== undefined && current.spinner !== undefined && current.spinner !== null
              ? '这一套用字符转圈，没有图片池；文案全部来自上面的通用池。'
              : images.length + ' 张图 · 点任意一行进去改文案'),
        ),

        // import（字形包不需要）
        current !== undefined && current.spinner !== undefined && current.spinner !== null
          ? null
          : h('div', null,
          h('span', { style: S.label }, '导入图片到「' + (selected === '' ? '未选择' : selected) + '」'),
          h('div', { style: S.row },
            h(FilePick, {
              label: '选图片',
              onFiles: (files) => upload(files),
            }),
            h(FilePick, {
              label: '选文件夹',
              directory: true,
              onFiles: (files) => upload(files.filter((f) => /\.(gif|png|webp|apng|jpe?g)$/i.test(f.name))),
            }),
          ),
        ),

        // 套组级操作：和「导入图片」分开，别混在那一行里
        h('div', null,
          h('span', { style: S.label }, '套组操作'),
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              className: 'ts-btn',
              style: S.btn,
              onClick: exportPack,
              title: '导出成 .tskin.json，图片会内嵌在文件里',
            }, '导出这个套'),
            current !== undefined && current.builtin !== true
              ? h('button', {
                type: 'button',
                className: 'ts-btn',
                style: { ...S.btn, color: '#f2777a' },
                onClick: () => deletePack(current.id),
              }, '删除这个套')
              : h('span', { style: S.hint }, '内置套不能删除'),
          ),
        ),

        h('div', { style: S.row },
          h('button', { type: 'button', className: 'ts-btn',
              style: S.btn, onClick: () => load(false) }, '重新读取'),
          h('span', { style: S.hint }, note),
        ),
      )
    }

    /**
     * The nav icon for our settings section.
     *
     * `settings.section.icon` hands the component `size` (requested square edge)
     * and `active` (whether the section is selected). We show the active pack's
     * cover; glyph packs get a star instead, since they have no artwork.
     */
    function SettingsIcon({ size, active }) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        if (pack === null) loadPack().then(() => bump((n) => n + 1))
      }, [])
      const edge = Number.isFinite(Number(size)) ? Number(size) : 16
      const box = { width: edge + 'px', height: edge + 'px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }

      if (pack === null) return h('span', { style: { ...box, fontSize: edge * 0.9 } }, '✻')
      // 字形套也有封面（那个橙色 ✻ 占位图），照样用它，别退化成文字
      const file = pack.cover || (Array.isArray(pack.images) && pack.images[0] !== undefined
        ? pack.images[0].file
        : null)
      if (file === null) return h('span', { style: { ...box, fontSize: edge * 0.9 } }, '✻')
      return h('img', {
        src: imageUrl(file),
        alt: '',
        style: {
          width: edge + 'px',
          height: edge + 'px',
          objectFit: 'contain',
          borderRadius: '3px',
          opacity: active === false ? 0.85 : 1,
        },
      })
    }

    /** Register the settings page. Failure here must not take the skin down. */
    function registerSettings(ctx) {
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'think-skin',
          order: 40,
          label: () => '思考状态',
          inject: () => ({}),
        }, SettingsPanel))

        // 同一个 id 才会被挂到我们那一行的图标位上
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'think-skin',
          order: 40,
          label: () => '思考状态',
          inject: () => ({}),
        }, SettingsIcon))
      } catch {
        /* the panel is optional; the skin keeps working without it */
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          ensureStyle()
          paint(document)
          registerSettings(ctx)
          const observer = new MutationObserver(() => {
            paint(document)
          })
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: [SHIMMER_ATTR],
          })
          // React's once-a-second re-render is the tick; this interval only covers
          // a missed mutation and lets the text rotate on a quiet row.
          const interval = setInterval(() => {
            paint(document)
            // paint 靠突变和这条心跳触发；行被整块拿走时补一刀，音乐没机会赖着不放
            let hasRow = false
            try {
              hasRow = document.querySelectorAll(ROW).length > 0
            } catch {
              hasRow = false
            }
            Music.tick(hasRow)
          }, 1000)
          // 字形每 80ms 一帧，1 秒的节拍会让它一顿一顿地跳，所以单独给一条快节拍。
          // 只改文字和颜色，不做查询以外的重活。
          const fast = setInterval(() => {
            tickSpinners(document)
            tickGlimmer(document, Date.now())
            // 有词条还没打完就重画一次（打完就不再触发，避免每秒白跑）
            for (const row of document.querySelectorAll(ROW)) {
              const full = row.getAttribute('data-ts-full')
              const shown = row.getAttribute('data-ts-shown') || ''
              if (full !== null && shown.length < full.length) {
                paint(document)
                break
              }
            }
          }, 80)
          return () => {
            observer.disconnect()
            clearInterval(interval)
            clearInterval(fast)
          }
        })
      },
    }
  },
})
