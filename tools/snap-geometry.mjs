/**
 * 一次性几何迁移：把工作区里所有 `.drawio` 的几何对齐到格线
 * （节点位置与尺寸对齐整格、折点与自由端点对齐半格）。
 *
 * 为什么需要一个脚本而不只是画布里的菜单项：菜单一次只整理**打开着的那张**，
 * 而这个迁移是一次性的、面向"盘上已有的文件"—— 从 drawio 手画来的图、
 * 早期写下的坐标、旧版本估宽留下的 186/56 这种尺寸，都可能散落在一堆文件里。
 *
 * 规矩（与画布里的写回同一条）：
 *   · 只动几何。style 键、标签、两端约束、层级、其他页一律不碰；
 *   · 走**无损写回**（applyDocToMxfile），所以"没改动的单元逐字节不变"这条性质仍然成立；
 *   · 默认 --dry：先说会改什么，写盘要显式 --write。
 *
 * 用法：
 *   node tools/snap-geometry.mjs            # 扫工作区、只报告
 *   node tools/snap-geometry.mjs --write    # 真的写回
 *   node tools/snap-geometry.mjs --write a.drawio sub/b.drawio
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDocToMxfile, parseMxfile } from '../src/mxfile.js'
import { snapDocGeometry } from '../src/style-kernel.js'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const args = process.argv.slice(2)
const write = args.indexOf('--write') >= 0
const explicit = args.filter((a) => a.startsWith('--') === false)

/** 没给文件名就找：根目录 + 一层子目录（与「打开」菜单的扫描范围一致）。 */
function discover() {
  const found = []
  const seen = new Set()
  const push = (dir, name) => {
    const rel = dir.length === 0 ? name : dir + '/' + name
    if (seen.has(rel) === false && name.toLowerCase().endsWith('.drawio')) {
      seen.add(rel)
      found.push(rel)
    }
  }
  const entries = readdirSync(workspace, { withFileTypes: true })
  for (const entry of entries) if (entry.isFile()) push('', entry.name)
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    for (const sub of readdirSync(join(workspace, entry.name), { withFileTypes: true })) if (sub.isFile()) push(entry.name, sub.name)
  }
  return found.sort()
}

const targets = explicit.length > 0 ? explicit : discover()
if (targets.length === 0) {
  console.log('没有找到 .drawio 文件。')
  process.exit(0)
}

let touched = 0
let clean = 0
let failed = 0
for (const rel of targets) {
  const path = resolve(workspace, rel)
  if (existsSync(path) === false || statSync(path).isDirectory()) {
    console.log('✗ ' + rel + '：不是文件')
    failed += 1
    continue
  }
  let text
  let parsed
  try {
    text = readFileSync(path, 'utf8')
    parsed = parseMxfile(text)
  } catch (error) {
    console.log('✗ ' + rel + '：读不出来 —— ' + (error && error.message ? error.message : String(error)))
    failed += 1
    continue
  }
  const result = snapDocGeometry(parsed.doc, { grid: 10, edgeGrid: 5, minW: 60, minH: 40 })
  if (result.changes === 0) {
    console.log('· ' + rel + '：本来就在格线上')
    clean += 1
    continue
  }
  let written = null
  try {
    written = applyDocToMxfile(text, result.doc)
  } catch (error) {
    console.log('✗ ' + rel + '：算不出写回结果 —— ' + (error && error.message ? error.message : String(error)))
    failed += 1
    continue
  }
  console.log((write ? '✓ ' : '→ ') + rel + '：' + result.changes + ' 处几何要整理' + (write ? '（已写回）' : '（--dry，未写盘）'))
  if (write) {
    writeFileSync(path, written.text, 'utf8')
    touched += 1
  } else {
    touched += 1
  }
}

console.log('')
console.log((write ? '已整理 ' : '需要整理 ') + touched + ' 份' + (clean > 0 ? '，' + clean + ' 份本来就在格线上' : '') + (failed > 0 ? '，失败 ' + failed + ' 份' : ''))
if (!write && touched > 0) console.log('加 --write 才会真的写盘。')
