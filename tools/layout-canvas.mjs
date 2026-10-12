/**
 * 画布排版：把一批 svg 节点 + 它们的说明行，按「列数固定」重新摆成整齐网格。
 *
 * 为什么不用 diagram_apply 的 move：说明行（caption）是独立单元，move 一次只能收
 * 一组相对位移，逐节点算绝对位置会更笨；而且这里要**同时**改节点与说明行、并保持
 * 二者的相对关系（说明永远贴在节点下方），直接改 mxGeometry 最直白。
 *
 * 布局：格子 colPitch × rowPitch，节点放在格子左上，说明行贴在节点下方（gap 间距）。
 * 列数默认 3 —— 目标是**落进 850×1100 的纸面**（纸面是画布的默认视野）。
 *
 * 用法:
 *   node tools/layout-canvas.mjs --canvas <file.drawio> --origin 40,60 --cell 240,360 \
 *        --cols 3 --gap 24 --place "n3:gemini" --place "n2:claude" ...
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
function all(name) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--' + name) out.push(argv[i + 1])
  return out
}
function pair(text, def) {
  if (typeof text !== 'string') return def
  const p = text.split(',').map(Number)
  return p.length === 2 && p.every(Number.isFinite) ? p : def
}

const CANVAS = arg('canvas', null)
const places = all('place')
if (CANVAS === null || places.length === 0) {
  console.error('用法: node tools/layout-canvas.mjs --canvas <f.drawio> --place "id:label" ...')
  process.exit(2)
}
const ORIGIN = pair(arg('origin', '40,60'), [40, 60])
const CELL = pair(arg('cell', '240,360'), [240, 360])
const COLS = Number(arg('cols', 3))
const GAP = Number(arg('gap', 26))
const COL_PITCH = CELL[0] + GAP
const ROW_PITCH = CELL[1] + GAP + 22 // 22 = 说明行的高度

const items = places.map((spec, index) => {
  const cut = spec.indexOf(':')
  const id = cut < 0 ? spec : spec.slice(0, cut)
  const label = cut < 0 ? '' : spec.slice(cut + 1)
  const col = index % COLS
  const row = Math.floor(index / COLS)
  return {
    id,
    label,
    x: ORIGIN[0] + col * COL_PITCH,
    y: ORIGIN[1] + row * ROW_PITCH,
  }
})

let xml = readFileSync(CANVAS, 'utf8')
const before = createHash('sha256').update(xml).digest('hex')

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 1) 把已有单元的几何改成目标位置
let moved = 0
for (const item of items) {
  const cellRe = new RegExp('<mxCell id="' + item.id + '"[\\s\\S]*?</mxCell>')
  const cell = cellRe.exec(xml)
  if (cell === null) {
    console.log('跳过（没找到）: ' + item.id)
    continue
  }
  const geoRe = /<mxGeometry[^>]*as="geometry" \/>/
  const geo = geoRe.exec(cell[0])
  if (geo === null) {
    console.log('跳过（无几何）: ' + item.id)
    continue
  }
  const newGeo = '<mxGeometry x="' + item.x + '" y="' + item.y + '" width="' + CELL[0] +
    '" height="' + CELL[1] + '" as="geometry" />'
  const newCell = cell[0].replace(geo[0], newGeo)
  xml = xml.slice(0, cell.index) + newCell + xml.slice(cell.index + cell[0].length)
  moved += 1
  // 说明行：已有 caption 就挪，没有就新建一条
  const capId = item.id + '-cap'
  const capRe = new RegExp('<mxCell id="' + capId + '"[\\s\\S]*?</mxCell>')
  const capGeo = '<mxGeometry x="' + item.x + '" y="' + (item.y + CELL[1] + 4) +
    '" width="' + CELL[0] + '" height="18" as="geometry" />'
  const cap = capRe.exec(xml)
  if (cap !== null) {
    const g = /<mxGeometry[^>]*as="geometry" \/>/.exec(cap[0])
    if (g !== null) {
      const newCap = cap[0].replace(g[0], capGeo)
      xml = xml.slice(0, cap.index) + newCap + xml.slice(cap.index + cap[0].length)
    }
  } else {
    // 插到该节点之后
    const after = new RegExp('<mxCell id="' + item.id + '"[\\s\\S]*?</mxCell>')
    const found = after.exec(xml)
    const capCell = '\n        <mxCell id="' + capId + '" value="' + escapeAttr(item.label) +
      '" style="text;html=1;align=center;verticalAlign=middle;fontSize=11;fontColor=#333333;fillColor=none;" vertex="1" parent="1">\n' +
      '          ' + capGeo + '\n        </mxCell>'
    const at = found.index + found[0].length
    xml = xml.slice(0, at) + capCell + xml.slice(at)
  }
}

const after = createHash('sha256').update(xml).digest('hex')
if (before === after) {
  console.log('内容无变化，未写盘')
} else {
  copyFileSync(CANVAS, CANVAS + '.bak')
  writeFileSync(CANVAS, xml, 'utf8')
  console.log('写盘 ' + CANVAS + '（已挪 ' + moved + ' 个节点，' + items.length + ' 条说明）')
}
const cols = COLS
const rows = Math.ceil(items.length / COLS)
console.log('网格 ' + cols + '×' + rows + '，格子 ' + CELL[0] + '×' + CELL[1] +
  '，起点 ' + ORIGIN[0] + ',' + ORIGIN[1] +
  '，右下角 ≈ ' + (ORIGIN[0] + (cols - 1) * COL_PITCH + CELL[0]) + ',' + (ORIGIN[1] + (rows - 1) * ROW_PITCH + CELL[1]))
for (const it of items) console.log('  ' + it.id.padEnd(10) + ' @' + it.x + ',' + it.y + '  ' + it.label)
console.log('fileBytes ' + Buffer.byteLength(xml, 'utf8'))
