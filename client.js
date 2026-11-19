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
    const DEFAULT_GRADIENT = ['#a8cdff', '#5b8dff']

    const React = require('react')
    const h = React.createElement

    const STYLE_TEXT = [
      '[', GRAD_ATTR, '] {',
      'background-image: var(--ts-gradient);',
      'background-size: 100% 100%;',
      '-webkit-background-clip: text;',
      'background-clip: text;',
      'color: transparent;',
      '-webkit-text-fill-color: transparent;',
      '}',
      // 流动：把渐变拉长到 3 倍，再让 background-position 平移，形成循环流光
      '[', GRAD_ATTR, '][data-ts-mode="flow"] {',
      'background-size: 300% 100%;',
      'animation: ts-flow var(--ts-flow-speed, 5s) linear infinite;',
      '}',
      '@keyframes ts-flow {',
      'from { background-position: 0% 50%; }',
      'to { background-position: 300% 50%; }',
      '}',
      // 扫光：底色铺满，中间夹一条窄高光，整条带子横移
      '[', GRAD_ATTR, '][data-ts-mode="sweep"] {',
      'background-image: linear-gradient(100deg,',
      '  var(--ts-base) 0%, var(--ts-base) 38%,',
      '  var(--ts-shine) 50%,',
      '  var(--ts-base) 62%, var(--ts-base) 100%);',
      'background-size: 220% 100%;',
      'animation: ts-sweep var(--ts-sweep-speed, 3s) linear infinite;',
      '}',
      '@keyframes ts-sweep {',
      'from { background-position: 220% 50%; }',
      'to { background-position: -120% 50%; }',
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
      if (pack === null || !Array.isArray(pack.images) || pack.images.length === 0) return null
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
        imageIndex = pickIndex(pack.images.length, Number(storedImage ?? -1))
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
    function swapCopy(row, text) {
      const previous = row.getAttribute('data-ts-last')
      const targets = new Set()
      const replaceIn = (value) => {
        let next = value
        if (next.includes(SOURCE_LABEL)) next = next.split(SOURCE_LABEL).join(text)
        if (previous !== null && previous !== text && next.includes(previous)) {
          next = next.split(previous).join(text)
        }
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

      row.setAttribute('data-ts-last', text)
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
      const gradient = usable ? 'linear-gradient(90deg, ' + colors.join(', ') + ')' : ''
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
        element.style.setProperty('--ts-gradient', gradient)
        element.style.setProperty('--ts-flow-speed', '5s')
        element.style.setProperty('--ts-base', colors[0])
        element.style.setProperty('--ts-shine', colors.length > 1 ? colors[1] : '#ffffff')
        element.style.setProperty('--ts-sweep-speed', '3s')
      }
    }

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
      for (const row of rows) {
        const state = stateOf(row)
        if (state === null) continue
        swapIcon(row, imageUrl(state.image.file))
        const targets = swapCopy(row, state.text)
        applyGradient(targets, pack.appearance)
      }
    }

    /** Replace the in-memory pack after a save, then repaint. */
    function adoptDocument(data) {
      const packs = Array.isArray(data.packs) ? data.packs : []
      pack = packs.find((entry) => entry.id === data.active) || packs[0] || null
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
      const [gradient, setGradient] = React.useState(DEFAULT_GRADIENT)
      const [gradientMode, setGradientMode] = React.useState('static')
      const [detail, setDetail] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [note, setNote] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [coverFile, setCoverFile] = React.useState(null)
      const [coverPreview, setCoverPreview] = React.useState('')
      const [seedFiles, setSeedFiles] = React.useState([])
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

      function saveGradient() {
        commit({ pack: selected, gradient, mode: gradientMode, active: selected }, '已保存')
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

      function openGeneric() {
        setDetail({ kind: 'generic' })
        setDraft((current === undefined ? [] : current.fallbackTexts || []).join('\n'))
      }

      function openImage(image) {
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

      // ---- detail view -------------------------------------------------------

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

      const images = current === undefined || !Array.isArray(current.images) ? [] : current.images
      const generic = current === undefined ? [] : current.fallbackTexts || []

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
                setDetail({ kind: 'create' })
              },
            },
              h('div', { style: S.cardArtEmpty }, '+'),
              h('div', { style: S.cardName }, '新建'),
            ),
          ),
        ),

        // gradient
        h('div', null,
          h('span', { style: S.label }, '文字渐变（2–4 色；扫光模式只用前两色：底 → 高光）'),
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
            h('button', { type: 'button', className: 'ts-btn', style: S.btn, onClick: saveGradient }, '保存'),
          ),
          h('div', { style: { ...S.row, marginTop: '10px' } },
            h('span', { style: S.hint }, '预览'),
            gradientMode === 'none'
              ? h('span', { style: { fontWeight: 600 } }, '正在思考，用时 3秒')
              : h('span', {
                'data-ts-grad': '',
                'data-ts-mode': gradientMode,
                style: {
                  '--ts-gradient': 'linear-gradient(90deg, ' + gradient.join(', ') + ')',
                  '--ts-flow-speed': '5s',
                  '--ts-base': gradient[0],
                  '--ts-shine': gradient.length > 1 ? gradient[1] : '#ffffff',
                  '--ts-sweep-speed': '3s',
                  fontWeight: 600,
                },
              }, '正在思考，用时 3秒'),
          ),
        ),

        // phrase pools
        h('div', null,
          h('span', { style: S.label }, '文案池'),
          h('div', { style: S.poolList },
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
            images.map((image) => h('div', {
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
            images.length + ' 张图 · 点任意一行进去改文案'),
        ),

        // import
        h('div', null,
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
            current !== undefined && current.builtin !== true
              ? h('button', {
                type: 'button',
                style: S.danger,
                onClick: () => deletePack(current.id),
              }, '删除这个套')
              : null,
          ),
        ),

        h('div', { style: S.row },
          h('button', { type: 'button', className: 'ts-btn',
              style: S.btn, onClick: () => load(false) }, '重新读取'),
          h('span', { style: S.hint }, note),
        ),
      )
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
          }, 1000)
          return () => {
            observer.disconnect()
            clearInterval(interval)
          }
        })
      },
    }
  },
})
