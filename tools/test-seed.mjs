/**
 * 跑一遍「从零安装」时内置套组的铺装流程，不依赖 DSH。
 *
 *   node tools/test-seed.mjs            → 用临时目录做 storage，跑完打印结果
 *   node tools/test-seed.mjs --keep     → 保留临时目录，方便自己进去看
 *
 * 覆盖的是 index.js 里 seedBuiltinPacks 的同一套逻辑（素材扫描 → planBuiltinSeeds
 * → 拷文件），差别只在 storage 根是临时的。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILTIN_PACKS, planBuiltinSeeds } from '../seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const assetsRoot = path.join(here, '..', 'assets')
const keep = process.argv.includes('--keep')

const isImage = (n) => /\.(gif|png|webp|jpe?g|avif)$/i.test(n)

async function readMaterial() {
  const material = {}
  for (const entry of BUILTIN_PACKS) {
    for (const dir of entry.dirs) {
      let fileNames = []
      try {
        fileNames = (await fs.readdir(path.join(assetsRoot, dir))).filter(isImage)
      } catch {
        continue
      }
      if (fileNames.length === 0) continue
      let texts = {}
      try {
        texts = JSON.parse(await fs.readFile(path.join(assetsRoot, 'texts', entry.id + '.json'), 'utf8'))
      } catch {
        /* 没有文案表也能跑 */
      }
      material[entry.id] = { dir, fileNames, texts }
      break
    }
  }
  return material
}

async function main() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-seed-'))
  const material = await readMaterial()

  console.log('素材扫描:')
  for (const [id, m] of Object.entries(material)) {
    console.log('  %s ← assets/%s  (%d 张图, 文案 %d 条)', id, m.dir, m.fileNames.length,
      Array.isArray(m.texts?.fallbackTexts) ? m.texts.fallbackTexts.length : 0)
  }

  // 空文档 = 全新安装的样子
  const document = { packs: [], active: null, settings: { musicEnabled: true, musicVolume: 42, musicMode: 'random' } }
  const plan = planBuiltinSeeds(document.packs.map((p) => p.id), material)

  for (const item of plan) {
    const dir = path.join(storage, 'images', item.id)
    await fs.mkdir(dir, { recursive: true })
    for (const copy of item.copies) {
      const bytes = await fs.readFile(path.join(assetsRoot, copy.from))
      await fs.writeFile(path.join(dir, copy.to.slice(item.id.length + 1)), bytes)
    }
    document.packs.push(item.pack)
    if (!document.active) document.active = item.id
  }
  await fs.writeFile(path.join(storage, 'pack.json'), JSON.stringify(document, null, 2), 'utf8')

  // ── 校验 ────────────────────────────────────────────────────────────
  const problems = []
  const onDisk = JSON.parse(await fs.readFile(path.join(storage, 'pack.json'), 'utf8'))
  for (const pack of onDisk.packs) {
    if (!pack.builtin) problems.push(pack.id + ': 没标 builtin')
    if (!pack.cover) problems.push(pack.id + ': 没有 cover')
    if (pack.images.length === 0) problems.push(pack.id + ': 一张图都没有')
    for (const image of pack.images) {
      const p = path.join(storage, 'images', image.file)
      try {
        const st = await fs.stat(p)
        if (st.size === 0) problems.push(pack.id + '/' + image.id + ': 文件是空的')
      } catch {
        problems.push(pack.id + '/' + image.id + ': 文件不存在 ' + image.file)
      }
    }
  }

  console.log('\n铺装结果:')
  for (const pack of onDisk.packs) {
    const stats = await Promise.all(pack.images.map((i) => fs.stat(path.join(storage, 'images', i.file))))
    const bytes = stats.reduce((sum, s) => sum + s.size, 0)
    const line = '  ' + pack.id.padEnd(10) +
      ' images=' + String(pack.images.length).padEnd(4) +
      ' cover=' + String(pack.cover).padEnd(26) +
      ' fallback=' + String(pack.fallbackTexts.length).padEnd(4) +
      Math.round(bytes / 1024) + ' KB'
    console.log(line)
  }
  console.log('  active =', onDisk.active)

  const withTexts = onDisk.packs.flatMap((p) => p.images).filter((i) => i.texts.length > 0).length
  const totalImages = onDisk.packs.flatMap((p) => p.images).length
  console.log('  有独立文案的图: %d / %d（其余走 fallback）', withTexts, totalImages)

  if (problems.length > 0) {
    console.log('\n❌ 问题:')
    for (const p of problems.slice(0, 12)) console.log('   ' + p)
    process.exitCode = 1
  } else {
    console.log('\n✅ 三个内置套全部铺好，文件都在、非空、cover 有效')
  }

  if (keep) console.log('\n临时目录: ' + storage)
  else await fs.rm(storage, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
