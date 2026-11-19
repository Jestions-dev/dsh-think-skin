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
}
