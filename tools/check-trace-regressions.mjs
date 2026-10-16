// 无本地素材依赖：验证最终路径的填色、PNG 透明键与插件裁剪几何。
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { traceRasterToSvg } from '../src/trace-image.js'
import { decodePng } from '../src/raster.js'
import * as plugin from '../lib/index.js'

function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(type, 4)
  data.copy(bytes, 8)
  let crc = 0xffffffff
  for (const b of bytes.subarray(4, bytes.length - 4)) {
    crc ^= b
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}

function png(width, height, depth, type, rows, transparency) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = depth
  header[9] = type
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(transparency ? [chunk('tRNS', Buffer.from(transparency))] : []),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0)),
  ])
}

// 只解析管线实际输出的 M/L/l/z，按 SVG nonzero 绕数规则采样最终路径。
function colorAt(svg, x, y) {
  let color = null
  for (const path of svg.matchAll(/fill='([^']+)' fill-rule='nonzero' d='([^']+)'/g)) {
    const tokens = path[2].match(/[MLlz]|-?\d*\.?\d+/g)
    let px = 0, py = 0, sx = 0, sy = 0, winding = 0
    const edge = (nx, ny) => {
      const cross = (nx - px) * (y - py) - (x - px) * (ny - py)
      if (py <= y && ny > y && cross > 0) winding += 1
      if (py > y && ny <= y && cross < 0) winding -= 1
      px = nx; py = ny
    }
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i++]
      if (command === 'z') edge(sx, sy)
      else {
        const a = Number(tokens[i++]), b = Number(tokens[i++])
        if (command === 'M') { px = sx = a; py = sy = b }
        else if (command === 'L') edge(a, b)
        else edge(px + a, py + b)
      }
    }
    if (winding !== 0) color = path[1]
  }
  return color
}

const options = { removeBg: false, colors: 2, colorsDark: 0, protectLuma: 0, minArea: 0, epsilon: 0, grid: 999 }
const data = Buffer.alloc(48 * 48 * 4, 255)
for (let y = 8; y < 40; y += 1) for (let x = 8; x < 40; x += 1) {
  if (x >= 12 && x < 36 && y >= 12 && y < 36) continue
  data.fill(0, (y * 48 + x) * 4, (y * 48 + x) * 4 + 3)
}
const ring = traceRasterToSvg({ width: 48, height: 48, data }, options)
for (let y = 0; y < 48; y += 1) for (let x = 0; x < 48; x += 1) {
  assert.equal(colorAt(ring.svg, x + 0.5, y + 0.5), data[(y * 48 + x) * 4] === 0 ? '#000000' : '#ffffff')
}
assert.equal(ring.metrics.exactPixelCoverage, true)
let Resvg
try { Resvg = createRequire(import.meta.url)('@resvg/resvg-js').Resvg } catch { /* 可选渲染器 */ }
if (Resvg) {
  const rendered = decodePng(new Resvg(ring.svg).render().asPng())
  assert.deepEqual(rendered.data, data, '最终 SVG 栅格化后与方环原图逐像素一致')
} else console.log('check-trace-regressions: 未安装 resvg，使用始终执行的 SVG 绕数采样验证')

const tiny = Buffer.alloc(16 * 16 * 4, 255)
tiny[136 * 4 + 1] = tiny[136 * 4 + 2] = 0
const dot = traceRasterToSvg({ width: 16, height: 16, data: tiny }, options)
assert.equal(colorAt(dot.svg, 8.5, 8.5), '#ff0000')
assert.equal(dot.metrics.loopsDropped, 0)
assert.equal(dot.metrics.exactPixelCoverage, true)
const simplified = traceRasterToSvg({ width: 16, height: 16, data: tiny }, { ...options, epsilon: 3 })
assert.equal(simplified.metrics.labelPartitionComplete, true)
assert.equal(simplified.metrics.exactPixelCoverage, false)
assert.equal(simplified.metrics.drawnPixels, null)
assert.ok(simplified.metrics.loopsDropped > 0)
const budgeted = traceRasterToSvg({ width: 48, height: 48, data }, { ...options, maxBytes: 100 })
assert.ok(budgeted.metrics.attempts > 1)
assert.equal(budgeted.metrics.budgetExceeded, budgeted.svg.length > 100)

for (const [depth, type, rows, key] of [
  [8, 2, [0, 255, 0, 0, 254, 0, 0], [0, 255, 0, 0, 0, 0]],
  [16, 2, [0, 18, 52, 86, 120, 154, 188, 18, 53, 86, 120, 154, 188], [18, 52, 86, 120, 154, 188]],
  [1, 0, [0, 64], [0, 0]],
  [2, 0, [0, 96], [0, 1]],
  [4, 0, [0, 120], [0, 7]],
  [8, 0, [0, 128, 129], [0, 128]],
  [16, 0, [0, 18, 52, 18, 53], [18, 52]],
]) {
  const decoded = decodePng(png(2, 1, depth, type, rows, key))
  assert.equal(decoded.data[3], 0, `${depth}-bit type ${type} transparency`)
  assert.equal(decoded.data[7], 255, `${depth}-bit type ${type} opaque neighbor`)
}

// 用内存文件系统走真实工具入口，无需 .vectorize/input.png 或宿主安装。
const files = new Map([
  ['canvas.drawio', '<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'],
  ['ref.png', png(40, 30, 8, 2, Array.from({ length: 30 }, () => [0, ...Array(40).fill([20, 40, 60]).flat()]).flat())],
])
const registered = new Map()
const pathOf = (p) => typeof p === 'string' ? p : p.path
const ctx = {
  tools: { register(tool) { registered.set(tool.name, tool); return () => {} } },
  webServer: { register() { return () => {} } },
  fs: {
    processPath: pathOf,
    async resolve(p) { return { path: p } },
    async stat(p) { const value = files.get(pathOf(p)); return value === undefined ? undefined : { size: value.length } },
    async readText(p) { return files.get(pathOf(p)) },
    async readBytes(p) { return files.get(pathOf(p)) },
    async writeText(p, text) { files.set(pathOf(p), text) },
    contains() { return true },
  },
  sessions: { get() { return { header: { cwd: '.' } } } },
  sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: '.' } } },
  effect(fn) { if (typeof fn === 'function') fn(); return () => {} },
  get(name) { return name === 'skills' ? { register() { return () => {} } } : undefined },
}
plugin.apply(ctx)
const agent = { agent: { id: 'trace-regression' } }
const applied = await registered.get('diagram_apply').execute({ path: 'canvas.drawio', layout: 'none', ops: [
  { op: 'traceImage', image: 'ref.png', removeBg: false, cropX: 7, cropY: 9, cropW: 12, cropH: 8, as: 'crop' },
  { op: 'traceImage', image: 'ref.png', removeBg: false, cropX: 7, cropY: 9, cropW: 12, cropH: 8, x: 100, y: 200, w: 24, h: 16, as: 'scaled' },
] }, agent)
assert.equal(applied.created.length, 2)
const read = await registered.get('diagram_read').execute({ path: 'canvas.drawio' }, agent)
const geometries = read.nodes.map(({ x, y, w, h }) => ({ x, y, w, h }))
assert.deepEqual(geometries, [{ x: 7, y: 9, w: 12, h: 8 }, { x: 100, y: 200, w: 24, h: 16 }])
assert.equal(applied.trace[0].coverageBasis, 'quantized-label-map')
console.log('check-trace-regressions: OK（孔洞填色、小碎片、覆盖指标、预算、PNG 透明键、裁剪工具入口）')
