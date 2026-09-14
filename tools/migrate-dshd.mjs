/**
 * 一次性迁移：`.dshd.json`（旧载体）→ `.drawio`（drawio 的 mxfile）。
 *
 * 为什么要这一步：载体已经改成 `.drawio` 了 —— 画布只认它、AI 工具只认它、
 * 「打开」菜单也只列它。旧文件不会自己变成新格式，没有这个脚本，用户原来那张画布
 * 就等于打不开了。
 *
 * 规矩：
 *   · **不删任何东西**。旧 `.dshd.json` 原样留着，由人自己决定什么时候清理。
 *   · **不覆盖任何东西**。目标 `.drawio` 已存在就跳过并说明（宁可让人多看一眼）。
 *   · 文档先过一遍共用的归一化（`src/style-kernel.js` 的 `normalizeDrawioDoc`），
 *     再交给 `buildMxfile` 从零生成 —— 这里没有"原稿"可保护，本来就是新建一份文件。
 *   · 旧文档一律打 `meta.pinned`：它是人手工摆过的版面，AI 不该再自动重排。
 *
 * 用法：
 *   node tools/migrate-dshd.mjs            # 扫工作区（根目录 + 一层子目录）
 *   node tools/migrate-dshd.mjs a.dshd.json sub/b.dshd.json
 *   node tools/migrate-dshd.mjs --dry      # 只看会做什么，不写盘
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMxfile } from '../src/mxfile.js'
import { normalizeDrawioDoc } from '../src/style-kernel.js'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const args = process.argv.slice(2)
const dryRun = args.indexOf('--dry') >= 0
const explicit = args.filter((a) => a.startsWith('--') === false)

/** 没给文件名就找：根目录 + 一层子目录（和「打开」菜单的扫描范围一致）。 */
function discover() {
  const found = []
  const seen = new Set()
  const push = (dir, name) => {
    const rel = dir.length === 0 ? name : dir + '/' + name
    if (seen.has(rel) === false && name.toLowerCase().endsWith('.dshd.json')) {
      seen.add(rel)
      found.push(rel)
    }
  }
  const entries = readdirSync(workspace, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile()) push('', entry.name)
  }
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    for (const sub of readdirSync(join(workspace, entry.name), { withFileTypes: true })) {
      if (sub.isFile()) push(entry.name, sub.name)
    }
  }
  return found.sort()
}

const targets = explicit.length > 0 ? explicit : discover()
if (targets.length === 0) {
  console.log('没有找到 .dshd.json —— 不需要迁移。')
  process.exit(0)
}

let converted = 0
let skipped = 0
let failed = 0
for (const rel of targets) {
  const source = resolve(workspace, rel)
  const outRel = rel.replace(/\.dshd\.json$/i, '.drawio')
  const out = resolve(workspace, outRel)
  if (existsSync(source) === false) {
    console.log('✗ ' + rel + '：文件不存在')
    failed += 1
    continue
  }
  if (statSync(source).isDirectory()) {
    console.log('✗ ' + rel + '：是个目录')
    failed += 1
    continue
  }
  if (existsSync(out)) {
    console.log('· ' + rel + ' → ' + outRel + '：目标已存在，跳过（不覆盖）')
    skipped += 1
    continue
  }
  let doc
  try {
    doc = normalizeDrawioDoc(JSON.parse(readFileSync(source, 'utf8')))
  } catch (error) {
    console.log('✗ ' + rel + '：读不出来 —— ' + (error && error.message ? error.message : String(error)))
    failed += 1
    continue
  }
  doc.meta = Object.assign({}, doc.meta, { pinned: true })
  const built = buildMxfile(doc, { name: outRel.replace(/\.drawio$/i, '') })
  if (dryRun) {
    console.log('→ ' + rel + ' → ' + outRel + '（' + doc.nodes.length + ' 节点 / ' + doc.edges.length + ' 边，未写盘）')
    converted += 1
    continue
  }
  writeFileSync(out, built.text, 'utf8')
  console.log('✓ ' + rel + ' → ' + outRel + '（' + doc.nodes.length + ' 节点 / ' + doc.edges.length + ' 边）')
  converted += 1
}

console.log('')
console.log('迁移 ' + converted + ' 份' + (skipped > 0 ? '，跳过 ' + skipped + ' 份（目标已存在）' : '') + (failed > 0 ? '，失败 ' + failed + ' 份' : '') + (dryRun ? '（--dry：没有写盘）' : ''))
console.log('旧的 .dshd.json 一个都没动 —— 确认新文件没问题之后，你可以自己删掉它们。')
