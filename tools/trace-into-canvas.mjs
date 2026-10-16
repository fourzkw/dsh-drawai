/**
 * 一次性把多张图批量矢量化并作为 svg 内容节点写进 .drawio。
 *
 * 为什么走这条路（与 diagram_apply 的 traceImage 等价，但更适合批量）：
 *   · 用的是**同一份** src/trace-image.js（不重复实现），参数语义完全一致；
 *   · 不经工具返回值传输 —— 批量时 CLI 只回指标、写盘由本脚本负责，比一轮轮
 *     diagram_apply 更省往返（曾误把宿主的 `not lossless JSON` 归咎于返回值太大；
 *     真正的雷是回执里挂了 `undefined` 自有属性，已在 summarizeTraceForAi 修好）。
 *   · 写盘前比对文件是否真的变了（没变就不写），避免无谓触发画布重载。
 *
 * 用法:
 *   node tools/trace-into-canvas.mjs --canvas <目标.drawio> --grid 700 \
 *        --remove-bg true|false \
 *        --place "img.png:x,y,w,h" [--place ...] [--preset lineart] [--colors N] ...
 *   可选参数与 vectorize-image.mjs 同名：--preset --colors --colors-dark --epsilon
 *        --min-area --protect-luma --majority-contrast --grid-h
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decodeRaster } from '../src/raster.js'
import { traceRasterToSvg } from '../src/trace-image.js'

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
function num(name, def) {
  const v = arg(name, undefined)
  return v === undefined ? def : Number(v)
}
function all(name) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--' + name) out.push(argv[i + 1])
  return out
}

const CANVAS = arg('canvas', null)
const places = all('place')
if (CANVAS === null || places.length === 0) {
  console.error('用法: node tools/trace-into-canvas.mjs --canvas <file.drawio> --grid 700 --place "img.png:x,y,w,h" [...]')
  process.exit(2)
}

const removeBgRaw = arg('remove-bg', undefined)
if (removeBgRaw === undefined || removeBgRaw === true) {
  console.error('必须显式传 --remove-bg true 或 --remove-bg false（不再支持 auto / 省略）')
  process.exit(2)
}
const baseOpts = {
  preset: String(arg('preset', 'lineart')),
  grid: num('grid', 700),
  gridH: num('grid-h', 0),
  colors: num('colors', undefined),
  colorsDark: num('colors-dark', undefined),
  epsilon: num('epsilon', undefined),
  minArea: num('min-area', undefined),
  protectLuma: num('protect-luma', undefined),
  majorityContrast: num('majority-contrast', undefined),
  removeBg: removeBgRaw,
}
for (const k of Object.keys(baseOpts)) if (baseOpts[k] === undefined) delete baseOpts[k]

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function svgToImageValue(svg) {
  return 'data:image/svg+xml,' + String(svg)
    .replace(/%/g, '%25').replace(/</g, '%3C').replace(/>/g, '%3E')
    .replace(/#/g, '%23').replace(/"/g, '%22').replace(/ /g, '%20')
}

let xml = readFileSync(CANVAS, 'utf8')
const beforeHash = createHash('sha256').update(xml).digest('hex')

// 取最后一个含 mxGraphModel 的 diagram
const starts = []
const re = /<diagram\b[^>]*>/g
let m
while ((m = re.exec(xml)) !== null) starts.push(m.index)
let bounds = null
for (let i = starts.length - 1; i >= 0; i -= 1) {
  const from = starts[i]
  const to = i + 1 < starts.length ? starts[i + 1] : xml.length
  const ms = xml.indexOf('<mxGraphModel', from)
  if (ms >= 0 && ms < to) {
    const close = xml.indexOf('</diagram>', ms)
    bounds = { from, modelStart: ms, diagramEnd: close >= 0 && close < to ? close : to }
    break
  }
}
if (bounds === null) {
  console.error('没找到含 mxGraphModel 的 diagram')
  process.exit(4)
}

const indent = '        '
const rows = []
for (const spec of places) {
  const cut = spec.indexOf(':')
  if (cut < 0) {
    console.error('--place 格式应为 文件:x,y,w,h —— 得到 ' + spec)
    process.exit(2)
  }
  const file = spec.slice(0, cut)
  const parts = spec.slice(cut + 1).split(',').map(Number)
  const [x, y, w, h] = parts
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    console.error('--place 坐标不合法: ' + spec)
    process.exit(2)
  }
  const raster = await decodeRaster(readFileSync(file))
  const out = traceRasterToSvg(raster, Object.assign({}, baseOpts))
  if (out.svg.length > 250000) {
    console.error(file + ': SVG ' + out.svg.length + ' 字符，超过画布上限 250000（把 --grid 调小或减少 colors）')
    process.exit(5)
  }
  const id = 't' + createHash('sha256').update(file).digest('hex').slice(0, 6)
  rows.push({
    id,
    file,
    svg: out.svg,
    chars: out.svg.length,
    work: out.metrics.work.width + 'x' + out.metrics.work.height,
    colors: out.metrics.palette.length,
    loops: out.metrics.loopsKept,
    attempts: out.metrics.attempts,
    exact: out.metrics.exactPixelCoverage,
    x, y, w, h,
  })
}

// 插在目标页 root 最后一个单元之后（同 embed-image 的写法）
const rootClose = xml.indexOf('</root>', bounds.modelStart)
const insertBefore = rootClose >= 0 && rootClose < bounds.diagramEnd ? rootClose : bounds.diagramEnd
const lastCell = xml.lastIndexOf('</mxCell>', insertBefore)
const at = lastCell >= 0 ? lastCell + '</mxCell>'.length : insertBefore
const block = rows.map((r) => [
  indent + '<mxCell id="' + r.id + '" style="shape=image;imageAspect=0;image=' + svgToImageValue(r.svg) + '" vertex="1" parent="1">',
  indent + '  <mxGeometry x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" as="geometry" />',
  indent + '</mxCell>',
].join('\n')).join('\n')
const next = xml.slice(0, at) + '\n' + block + xml.slice(at)

const afterHash = createHash('sha256').update(next).digest('hex')
if (beforeHash === afterHash) {
  console.log('文件内容无变化，未写盘')
} else {
  copyFileSync(CANVAS, CANVAS + '.bak')
  writeFileSync(CANVAS, next, 'utf8')
  console.log('写盘 ' + CANVAS + '（备份 ' + CANVAS + '.bak）')
}
for (const r of rows) {
  console.log(JSON.stringify({
    id: r.id, file: r.file, placed: r.x + ',' + r.y + ' ' + r.w + 'x' + r.h,
    work: r.work, colors: r.colors, loops: r.loops, attempts: r.attempts,
    chars: r.chars, exact: r.exact,
  }))
}
console.log('fileBytes ' + Buffer.byteLength(next, 'utf8'))
