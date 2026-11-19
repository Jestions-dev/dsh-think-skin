/**
 * ThinkSkin — host half (M4).
 *
 * Owns the pack on disk and serves it to the browser half over a named route:
 *
 *   GET /think-skin/pack.json          the active pack (images + text pools)
 *   GET /think-skin/images/<file>      one image, immutable
 *
 * Data lives under `$DSH_HOME/storages/think_skin/`, the same per-domain
 * convention `dsh_dl_jobs` uses. Nothing is inlined into the bundle.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE = '/think-skin'
const STORE = 'think_skin'

const MIME = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.apng': 'image/apng',
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Read a JSON file, tolerating a UTF-8 BOM.
 *
 * `JSON.parse` rejects a leading BOM while a browser's `Response.json()` strips
 * it, so a file written by a BOM-emitting tool reads fine in the page and breaks
 * every host-side write. Strip it here rather than trust the writer.
 * @param file - absolute path.
 */
async function readJson(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

function notFound() {
  return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } })
}

export const inject = ['webServer']

/** Largest accepted settings body. The pack manifest is far smaller than this. */
const MAX_BODY = 1 << 20

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Apply one settings patch to pack.json.
 * @param root - data directory.
 * @param patch - `{ active?, appearance?, fallbackTexts? }`, scoped to one pack.
 * @returns the saved document.
 */
async function saveSettings(root, patch) {
  const file = path.join(root, 'pack.json')
  const data = await readJson(file)
  const packs = Array.isArray(data.packs) ? data.packs : []

  if (typeof patch.active === 'string' && packs.some((p) => p.id === patch.active)) {
    data.active = patch.active
  }

  const target = packs.find((p) => p.id === (patch.pack || data.active))
  if (target !== undefined) {
    if (Array.isArray(patch.gradient)) {
      const colors = patch.gradient.filter((c) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c))
      target.appearance = { ...(target.appearance || {}), gradient: colors }
    }
    if (Array.isArray(patch.fallbackTexts)) {
      const lines = patch.fallbackTexts
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      if (lines.length > 0) target.fallbackTexts = lines
    }
  }

  await fs.writeFile(file, JSON.stringify(data, null, 1), 'utf8')
  return data
}

export function apply(ctx) {
  const root = dataRoot()

  const dispose = ctx.webServer.register({
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
        try {
          const data = await readJson(path.join(root, 'pack.json'))
          return new Response(JSON.stringify(data), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          })
        } catch {
          return json({ error: 'no pack installed', root }, 404)
        }
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

  ctx.effect(() => dispose)

  /**
   * Settings writer. A handler (not a resource) because only a handler receives
   * non-GET methods; the resource contract answers GET and HEAD alone.
   */
  const disposeWrite = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/settings',
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' })
        res.end('method not allowed')
        return
      }
      try {
        const body = await readBody(req)
        const patch = JSON.parse(body)
        const data = await saveSettings(root, patch)
        const payload = JSON.stringify(data)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(payload)),
        })
        res.end(payload)
      } catch (error) {
        const message = String((error && error.message) || error)
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
    },
  })

  ctx.effect(() => disposeWrite)

  /**
   * Image import. The browser posts raw bytes with the target pack in `?pack=`
   * and the file name in `x-ts-name`; the host copies it into the pack directory
   * and appends it to the manifest. Import copies, it never links: the source
   * file on the user's disk stays theirs to delete.
   */
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
        if (!Object.prototype.hasOwnProperty.call(MIME, ext)) return fail(415, 'unsupported type: ' + ext)
        if (!/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .()（）\-]*$/.test(packId)) return fail(400, 'bad pack id')

        const body = await new Promise((resolve, reject) => {
          const chunks = []
          let size = 0
          req.on('data', (chunk) => {
            size += chunk.length
            if (size > 32 * 1024 * 1024) {
              reject(new Error('image too large'))
              req.destroy()
              return
            }
            chunks.push(chunk)
          })
          req.on('end', () => resolve(Buffer.concat(chunks)))
          req.on('error', reject)
        })
        if (body.length === 0) return fail(400, 'empty body')

        const dir = path.join(root, 'images', packId)
        await fs.mkdir(dir, { recursive: true })
        const file = 'up-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4) + ext
        const absolute = path.join(dir, file)
        await fs.writeFile(absolute, body)

        try {
          const manifestPath = path.join(root, 'pack.json')
          const data = await readJson(manifestPath)
          const packs = Array.isArray(data.packs) ? data.packs : []
          let target = packs.find((entry) => entry.id === packId)
          if (target === undefined) {
            target = { id: packId, name: packId, fallbackTexts: [], appearance: {}, images: [] }
            packs.push(target)
            data.packs = packs
          }
          const base = path.basename(name, ext)
          target.images.push({
            id: file.slice(0, -ext.length),
            file: packId + '/' + file,
            name: base,
            texts: [],
          })
          await fs.writeFile(manifestPath, JSON.stringify(data, null, 1), 'utf8')
        } catch (error) {
          // 字节落盘了但清单没写成：把文件删回去，别让目录里堆无人引用的图
          await fs.unlink(absolute).catch(() => {})
          throw error
        }

        const payload = JSON.stringify({ ok: true, added: packId + '/' + file, pack: target.id })
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
