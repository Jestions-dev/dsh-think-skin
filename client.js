/**
 * ThinkSkin — browser half (M4).
 *
 * The pack is no longer inlined: the host half serves it, so this file fetches
 * `/think-skin/pack.json` once and points `<img>` at `/think-skin/images/…`.
 * Images carry `immutable` caching, so the browser fetches each one once.
 *
 * Rewrites the Chat running-status row. Its shape, measured in M0:
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

    /**
     * Gradient paint rules. A linear-gradient background clipped to the glyphs,
     * with the text itself made transparent so only the gradient shows.
     */
    const STYLE_TEXT = [
      '[', GRAD_ATTR, '] {',
      'background-image: var(--ts-gradient);',
      '-webkit-background-clip: text;',
      'background-clip: text;',
      'color: transparent;',
      '-webkit-text-fill-color: transparent;',
      '}',
    ].join('')

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
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

    function imageUrl(image) {
      return ROUTE + '/images/' + encodeURI(image.file)
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

    /** Texts for one image, falling back to the pack pool. */
    function textsOf(image) {
      if (image !== undefined && Array.isArray(image.texts) && image.texts.length > 0) {
        return image.texts
      }
      const fallback = pack === null ? FALLBACK_TEXTS : pack.fallbackTexts
      return Array.isArray(fallback) && fallback.length > 0 ? fallback : FALLBACK_TEXTS
    }

    function nextAt(now) {
      return String(now + ROTATE_MIN + Math.random() * (ROTATE_MAX - ROTATE_MIN))
    }

    /**
     * Read, advance, and store the row's thinking state.
     * @returns {{ image: object, text: string } | null}
     */
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
     * Rewrite the copy wherever it lives: visible text, screen-reader line and the
     * shimmer attribute. Replaces both the upstream label and our previous text.
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
        // The screen-reader line stays painted normally; the decorative overlay
        // carries its copy in an attribute, not a text node, so it never lands here.
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
      const colors = appearance !== undefined && Array.isArray(appearance.gradient)
        ? appearance.gradient
        : null
      if (colors === null || colors.length < 2) return
      const gradient = 'linear-gradient(90deg, ' + colors.join(', ') + ')'
      for (const element of targets) {
        if (element.style.getPropertyValue('--ts-gradient') === gradient) continue
        element.setAttribute(GRAD_ATTR, '')
        element.style.setProperty('--ts-gradient', gradient)
      }
    }

    /** Apply the skin to every running row under a root. */
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
        swapIcon(row, imageUrl(state.image))
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

    const panelStyle = { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' }
    const labelStyle = { fontSize: '12px', opacity: 0.65, marginBottom: '6px', display: 'block' }
    const fieldStyle = {
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid currentColor',
      borderRadius: '6px',
      padding: '6px 8px',
      opacity: 0.9,
    }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }

    /**
     * Settings panel: pick a pack, tune its gradient, edit its text pool.
     * Everything is stored on the host; the row repaints as soon as a save lands.
     */
    function SettingsPanel() {
      const [data, setData] = React.useState(null)
      const [active, setActive] = React.useState('')
      const [gradient, setGradient] = React.useState(DEFAULT_GRADIENT)
      const [texts, setTexts] = React.useState('')
      const [note, setNote] = React.useState('')

      function adoptPack(entry) {
        setActive(entry.id)
        const colors = entry.appearance !== undefined && Array.isArray(entry.appearance.gradient)
          ? entry.appearance.gradient
          : []
        setGradient(colors.length >= 2 ? colors.slice(0, 2) : DEFAULT_GRADIENT)
        setTexts((Array.isArray(entry.fallbackTexts) ? entry.fallbackTexts : []).join('\n'))
      }

      function load(keepSelection) {
        const wanted = keepSelection === true ? active : ''
        fetch(ROUTE + '/pack.json', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((document) => {
            setData(document)
            const packs = Array.isArray(document.packs) ? document.packs : []
            const selected = packs.find((p) => p.id === wanted)
            const entry = selected || packs.find((p) => p.id === document.active) || packs[0]
            if (entry !== undefined) adoptPack(entry)
            if (packs.length === 0) setNote('还没有装任何套')
          })
          .catch((error) => setNote('读取失败：' + error.message))
      }

      React.useEffect(() => {
        load(false)
      }, [])

      function pick(id) {
        const packs = data !== null && Array.isArray(data.packs) ? data.packs : []
        const entry = packs.find((p) => p.id === id)
        if (entry !== undefined) adoptPack(entry)
      }

      function save() {
        const patch = {
          pack: active,
          gradient: gradient,
          fallbackTexts: texts.split('\n'),
        }
        if (data !== null && data.active !== active) patch.active = active
        fetch(ROUTE + '/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((response) => (response.ok ? response.json() : response.text().then((t) => Promise.reject(new Error(t)))))
          .then((document) => {
            setData(document)
            adoptDocument(document)
            setNote('已保存')
          })
          .catch((error) => setNote('保存失败：' + error.message))
      }

      const packs = data !== null && Array.isArray(data.packs) ? data.packs : []
      const preview = 'linear-gradient(90deg, ' + gradient.join(', ') + ')'

      function upload(files) {
        const list = Array.from(files || [])
        if (list.length === 0) return
        const packId = active || (packs[0] === undefined ? '' : packs[0].id)
        if (!packId) {
          setNote('先选一个套')
          return
        }
        setNote('导入中… ' + list.length + ' 个')
        let done = 0
        let failed = 0
        const next = () => {
          done += 1
          if (done < list.length) return
          setNote(failed === 0 ? '已导入 ' + (list.length - failed) + ' 个' : '导入完成，失败 ' + failed + ' 个')
          load(true)
        }
        for (const file of list) {
          file.arrayBuffer()
            .then((buffer) => fetch(
              ROUTE + '/upload?pack=' + encodeURIComponent(packId),
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/octet-stream',
                  'x-ts-name': encodeURIComponent(file.name),
                },
                body: buffer,
              },
            ))
            .then((response) => {
              if (!response.ok) failed += 1
            })
            .catch(() => {
              failed += 1
            })
            .finally(next)
        }
      }

      return h('div', { style: panelStyle },
        h('div', null,
          h('span', { style: labelStyle }, '套'),
          h('div', { style: rowStyle },
            packs.map((entry) => h('label', {
              key: entry.id,
              style: { ...rowStyle, gap: '6px', cursor: 'pointer', opacity: 0.9 },
            },
              h('input', {
                type: 'radio',
                name: 'think-skin-pack',
                checked: active === entry.id,
                onChange: () => pick(entry.id),
              }),
              h('span', null, entry.id + '（' + entry.images.length + ' 图）'),
            )),
          ),
        ),

        h('div', null,
          h('span', { style: labelStyle }, '文字渐变（两个颜色）'),
          h('div', { style: rowStyle },
            h('input', {
              type: 'color',
              value: gradient[0],
              onChange: (event) => setGradient([event.target.value, gradient[1]]),
            }),
            h('input', {
              type: 'color',
              value: gradient[1],
              onChange: (event) => setGradient([gradient[0], event.target.value]),
            }),
            h('span', {
              style: {
                backgroundImage: preview,
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                fontWeight: 600,
              },
            }, '正在思考，用时 3秒'),
          ),
        ),

        h('div', null,
          h('span', { style: labelStyle }, '文案池（一行一句；图没有自己的池时用这里）'),
          h('textarea', {
            value: texts,
            rows: 6,
            style: { ...fieldStyle, width: '100%', resize: 'vertical' },
            onChange: (event) => setTexts(event.target.value),
          }),
        ),

        h('div', null,
          h('span', { style: labelStyle }, '导入图片到当前套（复制进插件数据目录）'),
          h('div', { style: rowStyle },
            h('input', {
              type: 'file',
              accept: 'image/gif,image/png,image/webp',
              multiple: true,
              style: { fontSize: '12px' },
              onChange: (event) => {
                upload(event.target.files)
                event.target.value = ''
              },
            }),
            h('span', { style: { fontSize: '12px', opacity: 0.7 } },
              active === '' ? '' : '→ ' + active),
          ),
        ),

        h('div', { style: rowStyle },
          h('button', { type: 'button', style: { ...fieldStyle, cursor: 'pointer' }, onClick: save }, '保存'),
          h('button', { type: 'button', style: { ...fieldStyle, cursor: 'pointer' }, onClick: () => load(false) }, '重新读取'),
          h('span', { style: { fontSize: '12px', opacity: 0.7 } }, note),
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
