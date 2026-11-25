/**
 * ThinkSkin — host half.
 *
 * Owns the pack document and serves it to the browser half over named routes:
 *
 *   GET  /think-skin/pack.json          the whole document (packs + active)
 *   GET  /think-skin/images/<file>      one image, immutable
 *   POST /think-skin/settings           patch the active pack
 *   POST /think-skin/images/<pack>/<id> patch one image's pool
 *   POST /think-skin/pack               create or delete a custom pack
 *   POST /think-skin/upload?pack=<id>   import one image
 *
 * Data lives under `$DSH_HOME/storages/think_skin/`, the same per-domain
 * convention `dsh_dl_jobs` uses. Nothing is inlined into the bundle.
 */

import fs from 'node:fs/promises'
import zlib from 'node:zlib'
import os from 'node:os'
import path from 'node:path'

import { BUILTIN_PACKS, planBuiltinSeeds } from './seed.js'

const ROUTE = '/think-skin'
const STORE = 'think_skin'

/** Packs that ship with the plugin: fixed, never renamed or deleted. */
const BUILTIN = new Set(['蓝色大肥鱼', 'ClaudeCode', '酒狐'])

const MIME = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.apng': 'image/apng',
}

/** Largest accepted settings body. */
const MAX_BODY = 1 << 20
/** Largest accepted image upload. */
const MAX_IMAGE = 32 * 1024 * 1024
/** 套组文件（含 base64 图片）可以有几十 MB。 */
const MAX_PACK_FILE = 192 * 1024 * 1024
/** 单个音乐文件的技术上限（不对外宣传，只是防止一次读爆内存）。 */
const MAX_MUSIC = 512 * 1024 * 1024

const MUSIC_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
}

// ---------------------------------------------------------------- access gate

/**
 * 这些路由挂在 DSH 自己的 web server 上，任何网页都能向它发请求——所以必须
 * 自己确认请求来自 DSH 的页面，而不是别的标签页。
 *
 * 判断顺序：
 *   1. Sec-Fetch-Site 由浏览器附加，页面 JS 改不了：cross-site / same-site 直接拒。
 *   2. 有 Origin 时，它的 host 必须和 Host 头一致（同源）。
 *   3. 两个头都没有，说明不是浏览器（curl、脚本），那是本机主人，放行。
 */
function originAllowed(get) {
  const site = String(get('sec-fetch-site') || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return false

  const origin = get('origin')
  if (origin !== undefined && origin !== null && origin !== '') {
    try {
      return new URL(String(origin)).host === String(get('host') || '')
    } catch {
      return false
    }
  }
  return true
}

/**
 * DSH 自己的访问检查：`ctx.connection.requestRejection` 走 Host/Origin 围栏，
 * 并要求请求来自**已认证的活跃 Peer**。返回状态码表示拒绝，undefined 表示放行。
 *
 * 老版本 DSH 没有这个服务时退回上面的同源检查——不会比现在更宽。
 */
function requestRejection(context, request, get) {
  let connection = null
  try {
    connection = context.connection
  } catch {
    connection = null
  }
  if (connection === undefined || connection === null) {
    try {
      if (typeof context.get === 'function') connection = context.get('connection')
    } catch {
      connection = null
    }
  }
  if (connection !== undefined && connection !== null
    && typeof connection.requestRejection === 'function') {
    try {
      const status = connection.requestRejection(request)
      return status === undefined || status === null ? undefined : status
    } catch {
      return 403
    }
  }
  return originAllowed(get) ? undefined : 403
}

/** 本机回环、内网、云元数据地址——导入下载器一律不碰。 */
function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 169 && b === 254) return true          // link-local / 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (host.startsWith('fc') || host.startsWith('fd')) return true  // 唯一本地
    if (host.startsWith('fe80')) return true                          // 链路本地
  }
  return false
}

/** 只有 http/https、且不指向本机/内网的 URL 才能交给主机去下载。 */
function safeRemoteUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (isPrivateHost(url.hostname)) return null
  return url
}

// ---------------------------------------------------------------- zip helpers

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Build a zip from `[{ name, data }]`.
 *
 * Entries deflate when that actually saves bytes, store otherwise — a GIF is
 * already compressed, so most images end up stored and the archive stays close
 * to the sum of the images. Names are flagged UTF-8 so non-ASCII pack names
 * survive on every unzip tool.
 */
function makeZip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const deflated = zlib.deflateRawSync(file.data)
    const useDeflate = deflated.length < file.data.length
    const body = useDeflate ? deflated : file.data
    const method = useDeflate ? 8 : 0
    const crc = crc32(file.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(file.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36)
    entry.writeUInt32LE(0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)

    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, directory, end])
}

/** Read a zip into `Map<name, Buffer>`. Handles stored and deflated entries. */
function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let end = -1
  const floor = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('不是 zip 文件')

  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  const files = new Map()
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8')

    const localName = view.getUint16(localOffset + 26, true)
    const localExtra = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localName + localExtra
    const raw = buffer.subarray(start, start + compressedSize)
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw))

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}

/** Root of this plugin's data directory. */
export function dataRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', STORE)
}

/**
 * Resolve a request path under a root, refusing anything that escapes it.
 * @param root - directory that bounds the read.
 * @param relative - decoded, slash-separated relative path.
 * @returns absolute path, or null when it escapes or holds a parent segment.
 */
function resolveInside(root, relative) {
  const clean = relative.replace(/^\/+/, '')
  if (clean === '' || clean.includes('\0')) return null
  const absolute = path.resolve(root, clean)
  const prefix = path.resolve(root) + path.sep
  return absolute.startsWith(prefix) ? absolute : null
}

/**
 * Read a JSON file, tolerating a UTF-8 BOM.
 *
 * `JSON.parse` rejects a leading BOM while a browser's `Response.json()` strips
 * it, so a file written by a BOM-emitting tool reads fine in the page and breaks
 * every host-side write. Strip it here rather than trust the writer.
 */
async function readJson(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

const manifestOf = (root) => path.join(root, 'pack.json')

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function notFound() {
  return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } })
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Normalize one string array: trim, drop empties, keep order. */
function cleanLines(value) {
  if (!Array.isArray(value)) return null
  return value
    .filter((line) => typeof line === 'string')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** A valid gradient is two or more hex colors. */
function cleanGradient(value) {
  if (!Array.isArray(value)) return null
  const colors = value.filter((c) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c))
  return colors.length >= 2 ? colors.slice(0, 4) : null
}

/** Mark built-in packs so the page never offers to rename or delete them. */
function decorate(document) {
  const packs = Array.isArray(document.packs) ? document.packs : []

  // 音乐总开关与音量存在文档根部，跟着套组一起走
  if (document.settings === null || typeof document.settings !== 'object') document.settings = {}
  if (typeof document.settings.musicEnabled !== 'boolean') document.settings.musicEnabled = true
  const volume = Number(document.settings.musicVolume)
  document.settings.musicVolume = Number.isFinite(volume) && volume >= 0 && volume <= 100
    ? Math.round(volume)
    : 40
  // 一轮里怎么选歌：随机 / 顺序 / 单曲循环
  if (!['random', 'sequential', 'single'].includes(document.settings.musicMode)) {
    document.settings.musicMode = 'random'
  }

  for (const pack of packs) {
    if (typeof pack.builtin !== 'boolean') pack.builtin = BUILTIN.has(pack.id)
    pack.slug = pack.id
    if (!Array.isArray(pack.fallbackMusic)) pack.fallbackMusic = []
    if (typeof pack.cover !== 'string' || pack.cover.length === 0) {
      const first = Array.isArray(pack.images) ? pack.images[0] : undefined
      pack.cover = first === undefined ? null : first.file
    }
    for (const image of Array.isArray(pack.images) ? pack.images : []) {
      if (typeof image.useFallback !== 'boolean') image.useFallback = true
      if (!Array.isArray(image.music)) image.music = []
      if (typeof image.useFallbackMusic !== 'boolean') image.useFallbackMusic = true
    }
  }
  return document
}

/** 内置套组自带的音乐：包里的文件，首次加载时复制进 storages。 */
const BUILTIN_MUSIC = {
  '酒狐': ['朋友的酒 1.ogg', '朋友的酒 2.ogg', '朋友的酒 3.ogg'],
}

export const inject = ['webServer']

export function apply(ctx) {
  const root = dataRoot()

  /**
   * 读-改-写的临界区。
   *
   * 一次多选导入会并发打到同一条路由，而每条都要 load → 改 → save；
   * 不加锁的话后写的会把先写的覆盖掉（三个文件只留下最后一个）。
   */
  let critical = Promise.resolve()
  function lock(fn) {
    const run = critical.then(fn, fn)
    critical = run.then(() => {}, () => {})
    return run
  }

  /** Read the document, or an empty skeleton when no pack is installed yet. */
  async function load() {
    try {
      return decorate(await readJson(manifestOf(root)))
    } catch {
      return decorate({ packs: [], active: null })
    }
  }

  async function save(document) {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(manifestOf(root), JSON.stringify(document, null, 1), 'utf8')
    return document
  }

  const disposeRead = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    async resource(request) {
      const blocked = requestRejection(ctx, request, (name) => request.headers.get(name))
      if (blocked !== undefined) {
        return new Response('forbidden', {
          status: blocked,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
      let pathname
      try {
        pathname = new URL(request.url).pathname
      } catch {
        return notFound()
      }
      const relative = decodeURIComponent(pathname.slice(ROUTE.length))

      if (relative === '' || relative === '/' || relative === '/pack.json') {
        return json(await load())
      }

      if (!relative.startsWith('/images/') && !relative.startsWith('/music/')) return notFound()

      // 图片与音乐都在各自根目录下，按同样的「不许逃出根目录」规则解析
      const music = relative.startsWith('/music/')
      const base = music ? path.join(root, 'music') : path.join(root, 'images')
      const file = resolveInside(base, relative.slice(music ? '/music/'.length : '/images/'.length))
      if (file === null) return notFound()

      try {
        const bytes = await fs.readFile(file)
        const table = music ? MUSIC_MIME : MIME
        return new Response(bytes, {
          headers: {
            'content-type': table[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': String(bytes.byteLength),
          },
        })
      } catch {
        return notFound()
      }
    },
  })

  ctx.effect(() => disposeRead)

  /**
   * Pack-level settings: which pack is active, its gradient, its generic pool,
   * its cover, and optionally one image's pool.
   */
  const disposeSettings = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/settings',
    async handler(req, res) {
      const fail = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
      const blocked = requestRejection(ctx, req, (name) => req.headers[name])
      if (blocked !== undefined) return fail(blocked, 'forbidden')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      try {
        const patch = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'))
        const document = await load()
        const packs = document.packs

        if (typeof patch.active === 'string' && packs.some((p) => p.id === patch.active)) {
          document.active = patch.active
        }

        const target = packs.find((p) => p.id === (patch.pack || document.active))
        if (target !== undefined) {
          const gradient = cleanGradient(patch.gradient)
          if (gradient !== null) {
            target.appearance = { ...(target.appearance || {}), gradient }
          }
          const MODES = ['none', 'static', 'flow', 'sweep']
          if (MODES.includes(patch.mode)) {
            target.appearance = { ...(target.appearance || {}), mode: patch.mode }
          }
          // 循环一圈的秒数：小于 1 秒看着像抽搐，大于 60 秒等于不动
          const speed = Number(patch.speed)
          if (Number.isFinite(speed) && speed >= 1 && speed <= 60) {
            target.appearance = { ...(target.appearance || {}), speed }
          }
          // 字形包的旋转参数：模式 / 帧间隔 / 颜色（空 = 跟主题）
          if (patch.spinner !== undefined && patch.spinner !== null && typeof patch.spinner === 'object') {
            const next = { ...(target.spinner || {}) }
            if (patch.spinner.mode === 'braille' || patch.spinner.mode === 'glyph') {
              next.mode = patch.spinner.mode
            }
            const interval = Number(patch.spinner.interval)
            if (Number.isFinite(interval) && interval >= 16 && interval <= 6000) {
              next.interval = Math.round(interval)
            }
            // 字符画的一整趟时长，和盲文的帧间隔分开存
            const period = Number(patch.spinner.period)
            if (Number.isFinite(period) && period >= 200 && period <= 6000) {
              next.period = Math.round(period)
            }
            if (typeof patch.spinner.color === 'string') {
              if (patch.spinner.color === '') delete next.color
              else if (/^#[0-9a-f]{3,8}$/i.test(patch.spinner.color)) next.color = patch.spinner.color
            }
            if (Array.isArray(patch.spinner.frames) && patch.spinner.frames.length > 1) {
              next.frames = patch.spinner.frames.filter((f) => typeof f === 'string' && f.length > 0)
            }
            target.spinner = next
          }
          const fallback = cleanLines(patch.fallbackTexts)
          if (fallback !== null) target.fallbackTexts = fallback
          if (typeof patch.cover === 'string' && patch.cover.length > 0) target.cover = patch.cover

          const imagePatch = patch.image
          if (imagePatch !== undefined && typeof imagePatch.id === 'string') {
            const image = target.images.find((i) => i.id === imagePatch.id)
            if (image !== undefined) {
              const texts = cleanLines(imagePatch.texts)
              if (texts !== null) image.texts = texts
              if (typeof imagePatch.useFallback === 'boolean') {
                image.useFallback = imagePatch.useFallback
              }
              if (typeof imagePatch.useFallbackMusic === 'boolean') {
                image.useFallbackMusic = imagePatch.useFallbackMusic
              }
            }
          }
        }

        // 音乐总开关与音量：文档根部，所有套组共用
        const settings = document.settings
        if (typeof patch.musicEnabled === 'boolean') settings.musicEnabled = patch.musicEnabled
        if (patch.musicVolume !== undefined) {
          const volume = Number(patch.musicVolume)
          if (Number.isFinite(volume) && volume >= 0 && volume <= 100) {
            settings.musicVolume = Math.round(volume)
          }
        }
        if (typeof patch.musicMode === 'string'
          && ['random', 'sequential', 'single'].includes(patch.musicMode)) {
          settings.musicMode = patch.musicMode
        }

        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(await save(document)))
      } catch (error) {
        fail(400, String((error && error.message) || error))
      }
    },
  })

  ctx.effect(() => disposeSettings)

  /** Create or delete a custom pack. Built-in packs are refused. */
  const disposePack = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/pack',
    async handler(req, res) {
      const fail = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
      const blocked = requestRejection(ctx, req, (name) => req.headers[name])
      if (blocked !== undefined) return fail(blocked, 'forbidden')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      try {
        const body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'))
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .()（）\-]*$/.test(id)) {
          return fail(400, '套名只能含中英文、数字、空格和括号')
        }
        const document = await load()
        if (body.action === 'delete') {
          const index = document.packs.findIndex((p) => p.id === id)
          if (index < 0) return fail(404, '没有这个套')
          if (document.packs[index].builtin === true) return fail(409, '内置套不能删')
          document.packs.splice(index, 1)
          if (document.active === id) {
            document.active = document.packs.length > 0 ? document.packs[0].id : null
          }
          await fs.rm(path.join(root, 'images', id), { recursive: true, force: true })
          // 这个套的音乐（通用池 + 每张图的池）一起清掉
          await fs.rm(path.join(root, 'music', id), { recursive: true, force: true })
          const musicRoot = path.join(root, 'music')
          try {
            for (const entry of await fs.readdir(musicRoot)) {
              if (entry.startsWith(id + '-')) {
                await fs.rm(path.join(musicRoot, entry), { recursive: true, force: true })
              }
            }
          } catch {
            /* music 目录还没建过就没什么可删 */
          }
        } else {
          if (document.packs.some((p) => p.id === id)) return fail(409, '这个套名已经有了')
          document.packs.push({
            id,
            name: id,
            cover: null,
            fallbackTexts: ['正在思考'],
            appearance: { gradient: ['#a8cdff', '#5b8dff'] },
            images: [],
          })
          if (!document.active) document.active = id
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(await save(document)))
      } catch (error) {
        fail(400, String((error && error.message) || error))
      }
    },
  })

  ctx.effect(() => disposePack)

  /** Image import: raw bytes, target pack in the query, file name in a header. */
  const disposeUpload = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/upload',
    async handler(req, res) {
      const fail = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
      const blocked = requestRejection(ctx, req, (name) => req.headers[name])
      if (blocked !== undefined) return fail(blocked, 'forbidden')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      try {
        const url = new URL(req.url, 'http://local')
        const packId = url.searchParams.get('pack')
        const rawName = req.headers['x-ts-name']
        if (!packId || !rawName) return fail(400, 'need ?pack= and x-ts-name')

        let name
        try {
          name = decodeURIComponent(String(rawName))
        } catch {
          return fail(400, 'bad x-ts-name')
        }
        const ext = path.extname(name).toLowerCase()
        if (!Object.prototype.hasOwnProperty.call(MIME, ext)) {
          return fail(415, 'unsupported type: ' + ext)
        }

        const body = await readBody(req, MAX_IMAGE)
        if (body.length === 0) return fail(400, 'empty body')

        const dir = path.join(root, 'images', packId)
        await fs.mkdir(dir, { recursive: true })
        const file = 'up-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4) + ext
        const absolute = path.join(dir, file)
        await fs.writeFile(absolute, body)

        try {
          const document = await load()
          let target = document.packs.find((p) => p.id === packId)
          if (target === undefined) {
            target = {
              id: packId,
              name: packId,
              cover: null,
              fallbackTexts: ['正在思考'],
              appearance: { gradient: ['#a8cdff', '#5b8dff'] },
              images: [],
            }
            document.packs.push(target)
          }
          const base = path.basename(name, ext)
          target.images.push({
            id: file.slice(0, -ext.length),
            file: packId + '/' + file,
            name: base,
            texts: [],
            useFallback: true,
          })
          if (!target.cover) target.cover = packId + '/' + file
          await save(document)
        } catch (error) {
          // The bytes landed but the document did not: take the file back out so
          // the directory never accumulates images no pack refers to.
          await fs.unlink(absolute).catch(() => {})
          throw error
        }

        const payload = JSON.stringify({ ok: true, added: packId + '/' + file, pack: packId })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(payload)),
        })
        res.end(payload)
      } catch (error) {
        fail(400, String((error && error.message) || error))
      }
    },
  })

  ctx.effect(() => disposeUpload)

  /** Find a pack, and inside it either the pack-level pool or one image's pool. */
  function musicBucket(document, packId, imageId) {
    const pack = document.packs.find((p) => p.id === packId)
    if (pack === undefined) return null
    if (imageId === null || imageId === undefined || imageId === '') {
      if (!Array.isArray(pack.fallbackMusic)) pack.fallbackMusic = []
      return { list: pack.fallbackMusic, dir: packId, holder: pack, key: 'fallbackMusic' }
    }
    const image = (Array.isArray(pack.images) ? pack.images : []).find((i) => i.id === imageId)
    if (image === undefined) return null
    if (!Array.isArray(image.music)) image.music = []
    return { list: image.music, dir: packId + '-' + imageId, holder: image, key: 'music' }
  }

  /**
   * 音乐导入：原始字节，套组/图片由查询参数指定，文件名走 x-ts-name。
   * 音频复制进 storages，套组导出时再原样带出去 —— 和图片一个规矩。
   */
  const disposeMusicUp = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/music',
    async handler(req, res) {
      const fail = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
      const blocked = requestRejection(ctx, req, (name) => req.headers[name])
      if (blocked !== undefined) return fail(blocked, 'forbidden')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      try {
        const url = new URL(req.url, 'http://local')
        const packId = url.searchParams.get('pack')
        const imageId = url.searchParams.get('image')
        const rawName = req.headers['x-ts-name']
        if (!packId || !rawName) return fail(400, 'need ?pack= and x-ts-name')

        let name
        try {
          name = decodeURIComponent(String(rawName))
        } catch {
          return fail(400, 'bad x-ts-name')
        }
        const ext = path.extname(name).toLowerCase()
        if (!Object.prototype.hasOwnProperty.call(MUSIC_MIME, ext)) {
          return fail(415, 'unsupported audio type: ' + ext)
        }

        const body = await readBody(req, MAX_MUSIC)
        if (body.length === 0) return fail(400, 'empty body')

        // 整个「读文档 → 落盘 → 写清单」都在锁里：多选导入是并发请求，
        // 不加锁时后一次 save 会用旧文档把前一次的结果覆盖掉
        const result = await lock(async () => {
          const document = await load()
          const bucket = musicBucket(document, packId, imageId)
          if (bucket === null) return { status: 404, message: '没有这个套或这张图' }

          const dir = path.join(root, 'music', bucket.dir)
          await fs.mkdir(dir, { recursive: true })
          const file = 'm-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6) + ext
          const absolute = path.join(dir, file)
          await fs.writeFile(absolute, body)

          bucket.list.push({
            id: file.slice(0, -ext.length),
            file: bucket.dir + '/' + file,
            name: path.basename(name, ext),
            size: body.length,
          })
          try {
            await save(document)
          } catch (error) {
            // 字节落盘了但清单没写进去：把文件收回来，别留下没人认领的音频
            await fs.unlink(absolute).catch(() => {})
            throw error
          }
          return { status: 200, added: bucket.dir + '/' + file }
        })

        if (result.status !== 200) return fail(result.status, result.message)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ ok: true, added: result.added, pack: packId }))
      } catch (error) {
        fail(400, String((error && error.message) || error))
      }
    },
  })

  ctx.effect(() => disposeMusicUp)

  /** 删掉音乐池里的一首（同时删盘上的文件）。 */
  const disposeMusicDel = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/music-remove',
    async handler(req, res) {
      const fail = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
      const blocked = requestRejection(ctx, req, (name) => req.headers[name])
      if (blocked !== undefined) return fail(blocked, 'forbidden')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      try {
        const body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'))
        const outcome = await lock(async () => {
          const document = await load()
          const bucket = musicBucket(document, String(body.pack || ''), body.image)
          if (bucket === null) return { status: 404, message: '没有这个套或这张图' }
          const index = bucket.list.findIndex((m) => m.id === body.id)
          if (index < 0) return { status: 404, message: '没有这首' }
          const entry = bucket.list.splice(index, 1)[0]
          await save(document)
          return { status: 200, file: entry.file }
        })
        if (outcome.status !== 200) return fail(outcome.status, outcome.message)
        await fs.unlink(path.join(root, 'music', outcome.file.replace('/', path.sep))).catch(() => {})
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ ok: true }))
      } catch (error) {
        fail(400, String((error && error.message) || error))
      }
    },
  })
  ctx.effect(() => disposeMusicDel)

  /**
   * 把内置套组（蓝色大肥鱼 / ClaudeCode / 酒狐）铺进 storages。
   *
   * 之前只有音乐会被铺进来，图没有 —— 所以别人装完看到的是空列表。
   * 素材在 assets/ 下，文案在 assets/texts/<套名>.json，
   * 拼装逻辑在 seed.js（纯函数，能直接用 node 测，不用起 DSH）。
   * 只补缺的套，用户改过的不覆盖。
   */
  async function seedBuiltinPacks() {
    let touched = false
    try {
      const document = await load()
      const material = {}
      for (const entry of BUILTIN_PACKS) {
        for (const dir of entry.dirs) {
          let fileNames = []
          try {
            const names = await fs.readdir(new URL('./assets/' + dir + '/', import.meta.url))
            fileNames = names.filter((n) => /\.(gif|png|webp|jpe?g|avif)$/i.test(n))
          } catch {
            continue
          }
          if (fileNames.length === 0) continue
          let texts = {}
          try {
            texts = JSON.parse(
              await fs.readFile(
                new URL('./assets/texts/' + entry.id + '.json', import.meta.url),
                'utf8',
              ),
            )
          } catch {
            /* 没有文案表就退化成「按文件名当名字」 */
          }
          material[entry.id] = { dir, fileNames, texts }
          break
        }
      }

      for (const item of planBuiltinSeeds(document.packs.map((p) => p.id), material)) {
        const dir = path.join(root, 'images', item.id)
        await fs.mkdir(dir, { recursive: true })
        for (const copy of item.copies) {
          const bytes = await fs.readFile(new URL('./assets/' + copy.from, import.meta.url))
          await fs.writeFile(path.join(dir, copy.to.slice(item.id.length + 1)), bytes)
        }
        document.packs.push(item.pack)
        if (!document.active) document.active = item.id
        touched = true
      }
      if (touched) await save(document)
    } catch {
      /* 内置套组是送分项，铺不进去也不该挡住插件启动 */
    }
  }

  /**
   * 把内置套组自带的音乐铺进 storages。
   *
   * 只在缺的时候复制：用户删掉的不会被硬塞回来这件事要另说 —— 目前按文件名判断，
   * 删掉后下次启动会重新出现，内置资源就该这样。
   */
  async function seedBuiltinMusic() {
    let touched = false
    try {
      const document = await load()
      for (const [packId, files] of Object.entries(BUILTIN_MUSIC)) {
        const pack = document.packs.find((p) => p.id === packId)
        if (pack === undefined) continue
        if (!Array.isArray(pack.fallbackMusic)) pack.fallbackMusic = []
        for (const [order, name] of files.entries()) {
          const label = name.replace(/\.[^.]+$/, '')
          if (pack.fallbackMusic.some((m) => m.name === label)) continue
          let bytes = null
          try {
            bytes = await fs.readFile(new URL('./assets/music/' + packId + '/' + name, import.meta.url))
          } catch {
            continue
          }
          const dir = path.join(root, 'music', packId)
          await fs.mkdir(dir, { recursive: true })
          const file = 'builtin-' + String(order + 1) + path.extname(name)
          await fs.writeFile(path.join(dir, file), bytes)
          pack.fallbackMusic.push({
            id: file.replace(/\.[^.]+$/, ''),
            file: packId + '/' + file,
            name: label,
            size: bytes.length,
            builtin: true,
          })
          touched = true
        }
      }
      if (touched) await save(document)
    } catch {
      /* 内置音乐是可选的，铺不进去也不该影响插件启动 */
    }
  }

  // 先铺套组（音乐只给「已存在的套」铺，所以顺序不能反）
  seedBuiltinPacks()
    .then(seedBuiltinMusic)
    .catch(() => {})

  /**
   * Export one pack as a self-contained JSON document.
   *
   * Images travel as base64 inside the file, so a pack can be handed to someone
   * else as one attachment with no side files and no URLs that rot.
   */
  const disposeExport = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/export',
    async handler(req, res) {
      const fail = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
      const blocked = requestRejection(ctx, req, (name) => req.headers[name])
      if (blocked !== undefined) return fail(blocked, 'forbidden')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      try {
        const body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'))
        const data = await load()
        const pack = data.packs.find((p) => p.id === body.pack)
        if (pack === undefined) return fail(404, '没有这个套')

        // zip: pack.json + images/<name> + music/<name>，二进制原样搬
        const entries = []
        const images = []
        let index = 0

        /** 把一首歌读出来塞进 zip，返回清单里那一条。 */
        let musicIndex = 0
        async function packMusicEntry(entry) {
          const file = path.join(root, 'music', String(entry.file || '').replace('/', path.sep))
          let bytes = null
          try {
            bytes = await fs.readFile(file)
          } catch {
            bytes = null
          }
          if (bytes === null) return null
          musicIndex += 1
          const ext = path.extname(entry.file).toLowerCase() || '.mp3'
          const name = 'music/m' + String(musicIndex).padStart(3, '0') + ext
          entries.push({ name, data: bytes })
          return { file: name, name: entry.name, size: bytes.length }
        }

        for (const image of pack.images) {
          const file = path.join(root, 'images', image.file.replace('/', path.sep))
          let bytes = null
          try {
            bytes = await fs.readFile(file)
          } catch {
            bytes = null
          }
          if (bytes === null) continue
          index += 1
          const ext = path.extname(image.file).toLowerCase() || '.gif'
          const name = 'images/i' + String(index).padStart(3, '0') + ext
          entries.push({ name, data: bytes })

          const trackList = []
          for (const track of Array.isArray(image.music) ? image.music : []) {
            const packed = await packMusicEntry(track)
            if (packed !== null) trackList.push(packed)
          }

          images.push({
            id: image.id,
            name: image.name,
            texts: Array.isArray(image.texts) ? image.texts : [],
            useFallback: image.useFallback !== false,
            useFallbackMusic: image.useFallbackMusic !== false,
            music: trackList,
            file: name,
            sourceFile: image.file,
          })
        }

        const packMusic = []
        for (const track of Array.isArray(pack.fallbackMusic) ? pack.fallbackMusic : []) {
          const packed = await packMusicEntry(track)
          if (packed !== null) packMusic.push(packed)
        }

        const manifest = {
          format: 'dsh-think-skin/pack',
          version: 3,
          exportedAt: new Date().toISOString(),
          pack: {
            id: pack.id,
            name: pack.name,
            appearance: pack.appearance || {},
            fallbackTexts: Array.isArray(pack.fallbackTexts) ? pack.fallbackTexts : [],
            fallbackMusic: packMusic,
            spinner: pack.spinner === undefined ? null : pack.spinner,
            cover: (images.find((i) => i.sourceFile === pack.cover) || images[0] || {}).file || null,
            images,
          },
          settings: {
            musicEnabled: data.settings.musicEnabled,
            musicVolume: data.settings.musicVolume,
          },
        }
        entries.unshift({ name: 'pack.json', data: Buffer.from(JSON.stringify(manifest, null, 1), 'utf8') })

        const zip = makeZip(entries)
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="pack.zip"',
          'cache-control': 'no-store',
          'content-length': String(zip.length),
        })
        res.end(zip)
      } catch (error) {
        fail(400, String((error && error.message) || error))
      }
    },
  })

  ctx.effect(() => disposeExport)

  /** Pick a pack id that is not taken yet. */
  function freePackId(taken, wanted) {
    if (!taken.has(wanted)) return wanted
    for (let n = 2; n < 1000; n += 1) {
      const candidate = wanted + ' ' + n
      if (!taken.has(candidate)) return candidate
    }
    return wanted + ' ' + Date.now()
  }

  /**
   * Import a pack document, copying every image into the store.
   *
   * Accepts either an inline document or a URL to fetch on the host, which
   * sidesteps CORS and hotlink referer checks that a browser fetch would hit.
   */
  const disposeImport = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/import',
    async handler(req, res) {
      const fail = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
      const blocked = requestRejection(ctx, req, (name) => req.headers[name])
      if (blocked !== undefined) return fail(blocked, 'forbidden')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      let dir = null
      try {
        const body = await readBody(req, MAX_PACK_FILE)
        const type = String(req.headers['content-type'] || '')

        // 三种来源：zip 字节（本地/URL 下载）、旧版 JSON 载荷、服务端下载 URL
        let document = null
        let zipFiles = null

        if (type.startsWith('application/zip')) {
          zipFiles = readZip(body)
          const manifest = zipFiles.get('pack.json')
          if (manifest === undefined) return fail(400, '压缩包里没有 pack.json')
          document = JSON.parse(manifest.toString('utf8'))
        } else {
          const request = JSON.parse(body.toString('utf8'))
          if (request.file !== undefined) {
            document = request.file
          } else if (typeof request.url === 'string') {
            // 主机替浏览器去下载：只允许 http/https，且不能落到本机或内网，
            // 否则这个接口就成了「让别人的网页指挥我的机器访问内网」的通道。
            const target = safeRemoteUrl(request.url)
            if (target === null) {
              return fail(400, '这个链接不行：只支持 http/https，且不能指向本机或内网地址。')
            }
            let response
            try {
              response = await fetch(target, {
                redirect: 'follow',
                signal: AbortSignal.timeout(30000),
              })
            } catch (error) {
              return fail(400, '下载失败：' + String((error && error.message) || error))
            }
            // 跟随重定向之后可能已经跳到内网，再验一次
            let finalUrl = null
            try {
              finalUrl = new URL(response.url)
            } catch {
              finalUrl = null
            }
            if (finalUrl !== null && (finalUrl.protocol === 'http:' || finalUrl.protocol === 'https:')) {
              if (isPrivateHost(finalUrl.hostname)) {
                return fail(400, '这个链接不行：重定向到了本机或内网地址。')
              }
            }
            if (!response.ok) return fail(400, '下载失败：HTTP ' + response.status)
            const declared = Number(response.headers.get('content-length') || '0')
            if (Number.isFinite(declared) && declared > MAX_PACK_FILE) {
              return fail(413, '文件太大，超过 192 MB。')
            }
            const downloaded = Buffer.from(await response.arrayBuffer())
            if (downloaded.length > MAX_PACK_FILE) return fail(413, '文件太大，超过 192 MB。')

            // 网盘分享页、登录页、错误页都会返回 HTML；直接说清楚，别让用户猜
            const head = downloaded.subarray(0, 512).toString('utf8').trim().toLowerCase()
            const contentType = String(response.headers.get('content-type') || '').toLowerCase()
            if (contentType.includes('text/html') || head.startsWith('<!doctype') || head.startsWith('<html')) {
              return fail(
                400,
                '这个 URL 返回的是网页，不是文件。网盘分享页和需要登录的链接都不行，'
                + '请用直链（对象存储、GitHub raw、你自己的静态服务器等）。',
              )
            }
            const looksZip = downloaded.length > 4 && downloaded.readUInt32LE(0) === 0x04034b50
            if (looksZip) {
              zipFiles = readZip(downloaded)
              const manifest = zipFiles.get('pack.json')
              if (manifest === undefined) return fail(400, '压缩包里没有 pack.json')
              document = JSON.parse(manifest.toString('utf8'))
            } else {
              document = JSON.parse(downloaded.toString('utf8'))
            }
          }
        }
        if (document === null || typeof document !== 'object') return fail(400, '没有内容')
        if (document.format !== 'dsh-think-skin/pack') return fail(400, '不是套组文件')
        const source = document.pack
        if (source === null || typeof source !== 'object') return fail(400, '套组内容缺失')
        const images = Array.isArray(source.images) ? source.images : []

        const data = await load()
        const taken = new Set(data.packs.map((p) => p.id))
        const base = typeof source.id === 'string' && source.id.trim() !== ''
          ? source.id.trim()
          : '导入的套'
        const id = freePackId(taken, base)

        dir = path.join(root, 'images', id)
        await fs.mkdir(dir, { recursive: true })

        const stored = []
        let cover = null
        for (let index = 0; index < images.length; index += 1) {
          const image = images[index]
          const sourceName = typeof image.file === 'string' ? image.file : 'f.gif'
          const ext = path.extname(sourceName).toLowerCase()
          if (!Object.prototype.hasOwnProperty.call(MIME, ext)) continue
          let bytes = null
          if (zipFiles !== null) {
            bytes = zipFiles.get(sourceName) === undefined ? null : zipFiles.get(sourceName)
          } else if (typeof image.data === 'string' && image.data.length > 0) {
            bytes = Buffer.from(image.data, 'base64')
          }
          if (bytes === null) continue
          const file = 'i' + String(index + 1).padStart(3, '0') + ext
          await fs.writeFile(path.join(dir, file), bytes)
          stored.push({
            id: file.slice(0, -ext.length),
            file: id + '/' + file,
            name: typeof image.name === 'string' ? image.name : '',
            texts: Array.isArray(image.texts) ? image.texts : [],
            useFallback: image.useFallback !== false,
          })
          if (image.file === source.cover) cover = id + '/' + file
        }
        if (stored.length === 0) return fail(400, '套组里没有可导入的图片')

        // 用户在导入页换过封面：按文件名对上，覆盖清单里的默认值
        const wanted = req.headers['x-ts-cover']
        if (typeof wanted === 'string' && wanted !== '') {
          try {
            const base = path.basename(decodeURIComponent(wanted))
            const hit = stored.find((entry) => path.basename(entry.file) === base)
            if (hit !== undefined) cover = hit.file
          } catch {
            /* 头部解不开就沿用清单里的封面 */
          }
        }
        if (cover === null) cover = stored[0].file

        // 音乐：清单里记的路径都在 zip 的 music/ 下，原样搬进 storages
        const musicRoot = path.join(root, 'music', id)
        async function importTrack(track) {
          if (track === null || typeof track !== 'object') return null
          const raw = typeof track.file === 'string' ? track.file : ''
          if (raw === '') return null
          const base = path.basename(raw)
          const ext = path.extname(base).toLowerCase()
          if (!Object.prototype.hasOwnProperty.call(MUSIC_MIME, ext)) return null
          let bytes = null
          if (zipFiles !== null && zipFiles.get(raw) !== undefined) bytes = zipFiles.get(raw)
          else if (zipFiles !== null && zipFiles.get(base) !== undefined) bytes = zipFiles.get(base)
          if (bytes === undefined || bytes === null) return null
          await fs.mkdir(musicRoot, { recursive: true })
          const file = 'imp-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6) + ext
          await fs.writeFile(path.join(musicRoot, file), bytes)
          return {
            id: file.slice(0, -ext.length),
            file: id + '/' + file,
            name: typeof track.name === 'string' ? track.name : path.basename(base, ext),
            size: bytes.length,
          }
        }

        const importedFallbackMusic = []
        for (const track of Array.isArray(source.fallbackMusic) ? source.fallbackMusic : []) {
          const got = await importTrack(track)
          if (got !== null) importedFallbackMusic.push(got)
        }

        // 每张图自己的音乐池：用导出时的文件名对齐（stored 会跳过无效图片）
        const sourceImages = Array.isArray(source.images) ? source.images : []
        let cursor = 0
        for (const item of stored) {
          if (cursor >= sourceImages.length) break
          const record = sourceImages[cursor]
          cursor += 1
          const list = []
          for (const track of Array.isArray(record.music) ? record.music : []) {
            const got = await importTrack(track)
            if (got !== null) list.push(got)
          }
          if (list.length > 0) item.music = list
          item.useFallbackMusic = record.useFallbackMusic !== false
        }

        data.packs.push({
          id,
          name: id,
          builtin: false,
          cover,
          fallbackTexts: Array.isArray(source.fallbackTexts) && source.fallbackTexts.length > 0
            ? source.fallbackTexts
            : ['正在思考'],
          appearance: source.appearance !== null && typeof source.appearance === 'object'
            ? source.appearance
            : {},
          spinner: source.spinner !== null && typeof source.spinner === 'object'
            ? source.spinner
            : null,
          fallbackMusic: importedFallbackMusic,
          images: stored,
        })
        if (!data.active) data.active = id
        await save(data)

        const payload = JSON.stringify({ ok: true, pack: id, images: stored.length, cover })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(payload)),
        })
        res.end(payload)
      } catch (error) {
        if (dir !== null) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
        await fs.rm(path.join(root, 'music', String(id || '')), { recursive: true, force: true }).catch(() => {})
        fail(400, String((error && error.message) || error))
      }
    },
  })

  ctx.effect(() => disposeImport)

}
