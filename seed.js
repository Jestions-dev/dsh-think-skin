/**
 * 内置套组的「出厂内容」—— 装完就该有的那三个套。
 *
 * 之前只有 seedBuiltinMusic：音乐铺进去了，图没铺，所以别人装完看到的是空列表。
 * 这里把「一个套由什么组成」写成纯数据 + 纯函数，index.js 只负责读盘和拷文件，
 * 逻辑本身能直接用 node 跑测试（不用起 DSH）。
 *
 * 约定：
 *   · 图片的 file 字段是「<套名>/fNNN.<ext>」，相对 storages/think_skin/images/
 *   · texts 来自 assets/texts/<套名>.json，按图片名（文件名词干）对齐
 *   · 只补缺的套，不覆盖用户已经改过的
 */

/** 出厂套组的清单。dirs 是素材可能所在的目录（按顺序找，找到就用）。 */
export const BUILTIN_PACKS = [
  { id: '蓝色大肥鱼', dirs: ['compiled-128/蓝色大肥鱼', '蓝色大肥鱼'] },
  { id: 'ClaudeCode', dirs: ['ClaudeCode'] },
  { id: '酒狐', dirs: ['酒狐'] },
]

/** 每个套的配色/转圈样式。图能扫出来，但这些是设计决定，写死在这里。 */
const APPEARANCE = {
  蓝色大肥鱼: { gradient: ['#a8cdff', '#5b8dff'], mode: 'sweep', speed: 3 },
  ClaudeCode: {
    gradient: ['#f0a882', '#d97757'],
    mode: 'sweep',
    speed: 3,
    spinner: { mode: 'glyph', interval: 165, color: '#eb720f', period: 2000 },
  },
  酒狐: { gradient: ['#ffd6a5', '#ff9e6d'] },
}

const IMAGE_EXT = new Set(['.gif', '.png', '.webp', '.jpg', '.jpeg', '.avif'])

/** 文件名去掉扩展名 —— texts 里就是用这个名字当键。 */
export function stem(fileName) {
  return String(fileName).replace(/\.[^.]+$/, '')
}

/**
 * 把「素材目录里有哪些文件」+「texts 里的文案」拼成一个套的完整数据。
 *
 * @param {string} packId 套名，也是目录名
 * @param {{ fallbackTexts?: string[], images?: Record<string, {texts?: string[], useFallback?: boolean}> }} texts
 * @param {string[]} fileNames 素材目录下的文件名列表（只留图片）
 * @param {string} [assetDir] 素材目录（相对 assets/），用于生成拷贝来源
 * @returns {{ pack: object, copies: {from: string, to: string}[] }}
 */
export function buildBuiltinPack(packId, texts, fileNames, assetDir = packId) {
  const imagesByName = new Map()
  for (const name of texts?.images && Object.keys(texts.images).length > 0
    ? Object.keys(texts.images)
    : []) {
    imagesByName.set(name, texts.images[name] || {})
  }

  const usable = (fileNames || [])
    .filter((n) => IMAGE_EXT.has(String(n).slice(String(n).lastIndexOf('.')).toLowerCase()))
    // 文案表里有名字的优先，没名字的按文件名排序跟在后面（别丢图）
    .sort((a, b) => {
      const ia = imagesByName.has(stem(a)) ? 0 : 1
      const ib = imagesByName.has(stem(b)) ? 0 : 1
      return ia - ib || String(a).localeCompare(String(b), 'zh')
    })

  const images = []
  const copies = []
  let index = 0
  for (const fileName of usable) {
    const name = stem(fileName)
    const meta = imagesByName.get(name) || {}
    const ext = String(fileName).slice(String(fileName).lastIndexOf('.')).toLowerCase()
    index += 1
    const id = 'f' + String(index).padStart(3, '0')
    const stored = id + ext
    images.push({
      id,
      file: packId + '/' + stored,
      name,
      texts: Array.isArray(meta.texts) ? meta.texts : [],
      useFallback: meta.useFallback !== false,
      music: [],
      useFallbackMusic: true,
    })
    copies.push({ from: assetDir + '/' + fileName, to: packId + '/' + stored })
  }

  const appearance = APPEARANCE[packId] || { gradient: ['#a8cdff', '#5b8dff'] }
  const pack = {
    id: packId,
    name: packId,
    cover: images.length > 0 ? images[0].file : null,
    fallbackTexts:
      Array.isArray(texts?.fallbackTexts) && texts.fallbackTexts.length > 0
        ? texts.fallbackTexts
        : ['正在思考'],
    appearance: { ...appearance },
    images,
    builtin: true,
  }
  if (appearance.spinner !== undefined) pack.spinner = { ...appearance.spinner }

  return { pack, copies }
}

/**
 * 决定这次要补哪几个套。
 *
 * @param {string[]} existingIds 文档里已有的套名
 * @param {Record<string, {dir?: string, fileNames: string[], texts: object}>} material 每个套能用的素材
 * @returns {{ id: string, pack: object, copies: {from: string, to: string}[] }[]}
 */
export function planBuiltinSeeds(existingIds, material) {
  const have = new Set(existingIds || [])
  const out = []
  for (const entry of BUILTIN_PACKS) {
    const id = entry.id
    if (have.has(id)) continue
    const m = material[id]
    if (m === undefined || !Array.isArray(m.fileNames) || m.fileNames.length === 0) continue
    const { pack, copies } = buildBuiltinPack(id, m.texts || {}, m.fileNames, m.dir || id)
    if (pack.images.length === 0) continue
    out.push({ id, pack, copies })
  }
  return out
}
