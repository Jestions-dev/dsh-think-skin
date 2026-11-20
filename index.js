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
  for (const pack of packs) {
    if (typeof pack.builtin !== 'boolean') pack.builtin = BUILTIN.has(pack.id)
    pack.slug = pack.id
    if (typeof pack.cover !== 'string' || pack.cover.length === 0) {
      const first = Array.isArray(pack.images) ? pack.images[0] : undefined
      pack.cover = first === undefined ? null : first.file
    }
    for (const image of Array.isArray(pack.images) ? pack.images : []) {
      if (typeof image.useFallback !== 'boolean') image.useFallback = true
    }
  }
  return document
}

export const inject = ['webServer']

export function apply(ctx) {
  const root = dataRoot()

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

      if (!relative.startsWith('/images/')) return notFound()
      const file = resolveInside(path.join(root, 'images'), relative.slice('/images/'.length))
      if (file === null) return notFound()

      try {
        const bytes = await fs.readFile(file)
        return new Response(bytes, {
          headers: {
            'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
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
            }
          }
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
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      try {
        const body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'))
        const data = await load()
        const pack = data.packs.find((p) => p.id === body.pack)
        if (pack === undefined) return fail(404, '没有这个套')

        // zip: pack.json + images/<name>，图片原样存，不经 base64
        const entries = []
        const images = []
        let index = 0
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
          images.push({
            id: image.id,
            name: image.name,
            texts: Array.isArray(image.texts) ? image.texts : [],
            useFallback: image.useFallback !== false,
            file: name,
            sourceFile: image.file,
          })
        }

        const manifest = {
          format: 'dsh-think-skin/pack',
          version: 2,
          exportedAt: new Date().toISOString(),
          pack: {
            id: pack.id,
            name: pack.name,
            appearance: pack.appearance || {},
            fallbackTexts: Array.isArray(pack.fallbackTexts) ? pack.fallbackTexts : [],
            spinner: pack.spinner === undefined ? null : pack.spinner,
            cover: (images.find((i) => i.sourceFile === pack.cover) || images[0] || {}).file || null,
            images,
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
            let response
            try {
              response = await fetch(request.url, { redirect: 'follow' })
            } catch (error) {
              return fail(400, '下载失败：' + String((error && error.message) || error))
            }
            if (!response.ok) return fail(400, '下载失败：HTTP ' + response.status)
            const downloaded = Buffer.from(await response.arrayBuffer())

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
        fail(400, String((error && error.message) || error))
      }
    },
  })

  ctx.effect(() => disposeImport)

}
