/**
 * embed-image.mjs —— 把一张位图作为**内嵌位图节点**写进 .drawio（drawio 原生 shape=image + base64 data URI）。
 *
 * 为什么需要它（这是 traceImage 之外的另一条路）：
 *   `traceImage` 是**矢量化**（逐像素描成 SVG 内容节点），它只能走工具参数把标记送进画布，
 *   所以天然受两头上限夹击 —— SVG 标记 ≤ 250000 字符、位图要 ≤ 约 24 色调色板。
 *   对"渐变 + 细线"的插画（人物立绘这类），这两个上限必然把画面打碎成色块马赛克；
 *   而**位图 data URI 动辄几百 KB，塞不进一次工具调用**（也不该塞进模型上下文）。
 *   于是保真复刻走本地写盘：本脚本直接读图片字节 → base64 → 写进 .drawio。
 *
 * 画布那一半本来就画内嵌位图（src/client.js:1697-1705 对 shape=image + data:image/...;base64 渲染 <image>），
 * style 解析也专门为 data URI 里那个分号做了续行处理（src/style-kernel.js:188-198），所以这条路由画布原生支持。
 *
 * 用法:
 *   node tools/embed-image.mjs --in <图片> --canvas <目标.drawio> [--x 600] [--y 60] [--w 300] [--h 450]
 *        [--id replica] [--label "..."] [--caption "第一行|第二行"] [--force]
 *        [--format jpeg|png] [--quality 95]
 *
 * 默认：保持原始像素尺寸（w/h 省略时按图片尺寸）、JPEG q95（视觉无损，体积约 PNG 的 1/4）。
 * 目标文件里同 id 的节点默认**跳过**（幂等，可反复跑）；--force 则替换它。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

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

const IN = arg('in', null)
const CANVAS = arg('canvas', null)
if (IN === null || CANVAS === null || IN === true || CANVAS === true) {
  console.error('用法: node tools/embed-image.mjs --in <图片> --canvas <目标.drawio> [--x 600 --y 60 --w 300 --h 450]')
  process.exit(2)
}
const ID = String(arg('id', 'replica'))
const FORCE = argv.includes('--force')
const FORMAT = String(arg('format', 'jpeg')).toLowerCase()
const QUALITY = num('quality', 95)
// 裁剪：只取原图的一块（用于"局部保真"——比如脸。矢量化在 500px 工作图下必然丢五官，
// 这里直接把那块原始像素贴上去，像素级保真，且位置/尺寸由调用方按目标图的坐标给）
const CROP = (() => {
  const given = ['cropX', 'cropY', 'cropW', 'cropH'].filter((key) => argv.indexOf('--' + key) >= 0)
  if (given.length === 0) return null
  const box = { left: num('cropX', 0), top: num('cropY', 0), width: num('cropW', 0), height: num('cropH', 0) }
  if (box.width <= 0 || box.height <= 0) {
    console.error('--cropX/--cropY/--cropW/--cropH 要一起给，且 cropW/cropH 为正数')
    process.exit(2)
  }
  return box
})()

/* ── 1. 读图片 →（可选裁剪）→ 转成 JPEG/PNG 字节 ── */
function loadSharp() {
  const req = createRequire(import.meta.url)
  const candidates = [
    'sharp',
    'C:/Users/86476/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp',
  ]
  for (const spec of candidates) {
    try {
      return req(spec)
    } catch (error) {
      /* 换下一个候选 */
    }
  }
  return null
}

const raw = readFileSync(IN)
const sharp = loadSharp()
const isPngBytes = raw[0] === 0x89 && raw[1] === 0x50
// 只有"本来就是 PNG 且不裁剪"才能跳过 sharp 直接用原始字节
const passThrough = FORMAT === 'png' && isPngBytes && CROP === null
let bytes
let mime
if (passThrough) {
  bytes = raw
  mime = 'png'
} else if (sharp !== null) {
  let pipe = sharp(raw)
  if (CROP !== null) {
    const meta0 = await sharp(raw).metadata()
    if (CROP.left + CROP.width > meta0.width || CROP.top + CROP.height > meta0.height) {
      console.error('裁剪区域超出图片范围（图片 ' + meta0.width + '×' + meta0.height + '）')
      process.exit(3)
    }
    pipe = pipe.extract(CROP)
  }
  pipe = pipe.flatten({ background: { r: 252, g: 251, b: 254 } })
  bytes = FORMAT === 'png'
    ? await pipe.png({ compressionLevel: 9 }).toBuffer()
    : await pipe.jpeg({ quality: QUALITY, chromaSubsampling: '4:4:4' }).toBuffer()
  mime = FORMAT === 'png' ? 'png' : 'jpeg'
} else {
  console.error('需要 sharp 来转 ' + FORMAT + '；当前环境没装（或本来就是 PNG 可直接用 --format png）')
  process.exit(3)
}
const uri = 'data:image/' + mime + ';base64,' + bytes.toString('base64')

/* ── 2. 找到目标页的 mxGraphModel（明文 mxfile；未压缩） ── */
let text = readFileSync(CANVAS, 'utf8')
if (/<diagram[^>]*>\s*<diagram/i.test(text) === false && text.indexOf('<mxGraphModel') < 0) {
  console.error('这个文件里没有明文 <mxGraphModel>（可能是压缩页）—— 本脚本不处理压缩页')
  process.exit(4)
}
// 取**最后一个**含 mxGraphModel 的 diagram（= 画布当前显示的那一页的常见形态）
const diagramRe = /<diagram\b[^>]*>/g
let m
const starts = []
while ((m = diagramRe.exec(text)) !== null) starts.push(m.index)
let bounds = null
for (let i = starts.length - 1; i >= 0; i -= 1) {
  const from = starts[i]
  const to = i + 1 < starts.length ? starts[i + 1] : text.length
  const modelStart = text.indexOf('<mxGraphModel', from)
  if (modelStart >= 0 && modelStart < to) {
    const close = text.indexOf('</diagram>', modelStart)
    bounds = { modelStart, diagramEnd: close >= 0 && close < to ? close : to, from, to }
    break
  }
}
if (bounds === null) {
  console.error('没找到含 mxGraphModel 的 diagram')
  process.exit(4)
}

/* ── 3. 幂等：同 id 已存在就跳过（--force 则替换） ── */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
const region = text.slice(bounds.from, bounds.diagramEnd)
const idRe = new RegExp('<mxCell[^>]*\\bid="' + ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"')
const existing = region.match(idRe)
if (existing !== null && FORCE === false) {
  console.log('SKIP: 节点 "' + ID + '" 已存在（要替换加 --force）')
  process.exit(0)
}
if (existing !== null && FORCE) {
  // 替换：删掉那个 mxCell（含其 <mxGeometry> 与闭合标签）
  const start = bounds.from + region.indexOf(existing[0])
  const geo = text.indexOf('<mxGeometry', start)
  const cellEnd = text.indexOf('</mxCell>', geo >= 0 ? geo : start)
  text = text.slice(0, start) + text.slice(cellEnd + '</mxCell>'.length)
  // 重新定位（长度变了）
  const again = text.indexOf('<mxGraphModel', starts[0] >= 0 ? starts[0] : 0)
  bounds = { modelStart: again, diagramEnd: text.indexOf('</diagram>', again), from: bounds.from, to: text.length }
}

/* ── 4. 组装内嵌位图节点及其说明文字 ── */
const srcMeta = sharp === null ? { width: 0, height: 0 } : await sharp(raw).metadata()
const srcW = srcMeta.width
const srcH = srcMeta.height
const W = num('w', srcW)
const H = num('h', srcH)
const X = num('x', 600)
const Y = num('y', 60)
const label = arg('label', '') === true ? '' : String(arg('label', ''))
const caption = arg('caption', null)

const indent = '        '
const parts = []
parts.push(
  indent + '<mxCell id="' + escapeAttr(ID) + '"' +
  (label.length > 0 ? ' value="' + escapeAttr(label) + '"' : '') +
  ' style="shape=image;imageAspect=1;image=' + uri + '" vertex="1" parent="1">',
)
parts.push(indent + '  <mxGeometry x="' + X + '" y="' + Y + '" width="' + W + '" height="' + H + '" as="geometry" />')
parts.push(indent + '</mxCell>')

if (caption !== null && caption !== true) {
  const lines = String(caption).split('|')
  parts.push(
    indent + '<mxCell id="' + escapeAttr(ID) + '-caption" value="' + escapeAttr(lines.join('&#10;')) +
    '" style="text;html=1;align=left;verticalAlign=top;fontSize=12;fontColor=#333333;fillColor=none;" vertex="1" parent="1">',
  )
  parts.push(indent + '  <mxGeometry x="' + X + '" y="' + (Y + H + 16) + '" width="' + Math.max(W, 320) + '" height="' + (18 * lines.length + 8) + '" as="geometry" />')
  parts.push(indent + '</mxCell>')
}
const block = parts.join('\n') + '\n'

/* ── 5. 插在目标页 root 的最后一个单元之后 ── */
const rootClose = text.indexOf('</root>', bounds.modelStart)
const insertBefore = rootClose >= 0 && rootClose < bounds.diagramEnd ? rootClose : bounds.diagramEnd
const lastCell = text.lastIndexOf('</mxCell>', insertBefore)
const at = lastCell >= 0 ? lastCell + '</mxCell>'.length : insertBefore
text = text.slice(0, at) + '\n' + block + text.slice(at)

copyFileSync(CANVAS, CANVAS + '.bak')
writeFileSync(CANVAS, text, 'utf8')
console.log(JSON.stringify({
  ok: true,
  canvas: CANVAS,
  backup: CANVAS + '.bak',
  node: ID,
  image: IN,
  source: srcW + 'x' + srcH,
  placed: X + ',' + Y + ' ' + W + 'x' + H,
  format: mime,
  imageBytes: bytes.length,
  uriChars: uri.length,
  fileBytes: Buffer.byteLength(text, 'utf8'),
}))
