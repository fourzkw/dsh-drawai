import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { decodePng } from '../src/raster.js'
import { composeClientBody } from './build.mjs'
import { TRACE_DEFAULTS, TRACE_FRAGMENT_LEVELS, traceRasterForToolbar, traceRasterToSvg } from '../src/trace-image.js'
import { styleWithImageDataUri, svgMarkupFromStyle } from '../src/style-kernel.js'
import * as plugin from '../lib/index.js'

assert.deepEqual(Object.keys(TRACE_FRAGMENT_LEVELS), ['low', 'medium', 'high'])
const raster = { width: 32, height: 24, data: Buffer.alloc(32 * 24 * 4, 255) }
for (let i = 0; i < 32 * 24; i += 1) {
  raster.data[i * 4] = i % 32 < 16 ? 20 : 220
  raster.data[i * 4 + 1] = 40
  raster.data[i * 4 + 2] = 60
}
for (const level of Object.keys(TRACE_FRAGMENT_LEVELS)) {
  const traced = traceRasterForToolbar(raster, { level, removeBg: false })
  assert.equal(traced.metrics.budget, TRACE_DEFAULTS.maxBytes, '所有碎片档位使用相同内部上限')
  assert.equal(traced.metrics.fragmentLevel, level)
  assert.ok(traced.svg.length <= traced.metrics.budget)
  assert.ok(traced.metrics.fragments > 0)
}
assert.throws(() => traceRasterForToolbar(raster, { level: 'other', removeBg: false }))
assert.throws(() => traceRasterForToolbar(raster, { level: 'low', colors: 1000, removeBg: false }))
const narrow = traceRasterForToolbar({ width: 4, height: 2048, data: Buffer.alloc(4 * 2048 * 4, 255) }, { level: 'medium', removeBg: false })
assert.deepEqual(narrow.metrics.work, { width: 1, height: 712, scale: 1 }, '细长图片也按比例封顶')
const highNarrow = traceRasterForToolbar({ width: 4, height: 2048, data: Buffer.alloc(4 * 2048 * 4, 255) }, { level: 'high', removeBg: false })
assert.equal(highNarrow.metrics.work.height, 887, '高档使用参考图对应的工作尺度')

const busyImage = { width: 384, height: 384, data: Buffer.alloc(384 * 384 * 4, 255) }
let seed = 42
for (let by = 0; by < 96; by += 1) for (let bx = 0; bx < 96; bx += 1) {
  seed = (seed * 1664525 + 1013904223) >>> 0
  const value = (seed >>> 24) % 12 * 7
  for (let y = by * 4; y < by * 4 + 4; y += 1) for (let x = bx * 4; x < bx * 4 + 4; x += 1) {
    const offset = (y * 384 + x) * 4
    busyImage.data[offset] = busyImage.data[offset + 1] = busyImage.data[offset + 2] = value
  }
}
const busyLow = traceRasterForToolbar(busyImage, { level: 'low', removeBg: false, preset: 'lineart', colors: 24 })
assert.ok(busyLow.svg.length <= TRACE_DEFAULTS.maxBytes)

// 内容含不同大小的浅色块：验证真实碎片差异，而不是只检查参数或 SVG 字符数。
const texture = { width: 256, height: 192, data: Buffer.alloc(256 * 192 * 4, 255) }
for (let y = 8; y < 180; y += 16) for (let x = 8; x < 244; x += 16) {
  const side = x < 85 ? 2 : x < 170 ? 4 : 8
  for (let dy = 0; dy < side; dy += 1) for (let dx = 0; dx < side; dx += 1) {
    texture.data.set([140, 200, 220], ((y + dy) * 256 + x + dx) * 4)
  }
}
const enlarged = { width: 512, height: 384, data: Buffer.alloc(512 * 384 * 4) }
for (let y = 0; y < enlarged.height; y += 1) for (let x = 0; x < enlarged.width; x += 1) {
  const start = (Math.floor(y / 2) * 256 + Math.floor(x / 2)) * 4
  enlarged.data.set(texture.data.subarray(start, start + 4), (y * 512 + x) * 4)
}
const fragmentCounts = []
let sharedEpsilon
let adaptiveThresholds
for (const level of ['low', 'medium', 'high']) {
  const original = traceRasterForToolbar(texture, { level, colors: 6, removeBg: false })
  const scaled = traceRasterForToolbar(enlarged, { level, colors: 6, removeBg: false })
  fragmentCounts.push(original.metrics.fragments)
  assert.equal(original.metrics.targetReached, true, '实际碎片数落在本图自适应范围内')
  assert.ok(original.metrics.fragments >= original.metrics.targetFragments.min && original.metrics.fragments <= original.metrics.targetFragments.max)
  assert.equal(original.metrics.imageAnalysis.sourcePixels, texture.width * texture.height)
  if (sharedEpsilon === undefined) sharedEpsilon = original.metrics.optionsApplied.epsilon
  else assert.equal(original.metrics.optionsApplied.epsilon, sharedEpsilon, '高档不再通过减小轮廓容差变成细节还原')
  adaptiveThresholds = original.metrics.fragmentThresholds
  // A small feature may survive at higher resolution; do not retain pixel stair steps to force equal counts.
  assert.equal(scaled.metrics.optionsApplied.epsilon, original.metrics.optionsApplied.epsilon, `${level} 放大前后使用相同的工作像素简化强度`)
  assert.equal(original.metrics.optionsApplied.epsilon, 2, '小图也保持折面画风，容差不能降到亚像素')
  assert.equal(original.metrics.colors, 6, '颜色数不随碎片程度变化')
}
assert.ok(fragmentCounts[0] <= fragmentCounts[1] && fragmentCounts[1] <= fragmentCounts[2], '孤立同色块不为了数量而强行拆分')
assert.ok(adaptiveThresholds.low.target <= adaptiveThresholds.medium.target && adaptiveThresholds.medium.target <= adaptiveThresholds.high.target)

// 用户提供的原图校准样本：参数与实际轮廓共同锁定，避免又退化成过度合并或像素直出。
const referenceRaster = decodePng(readFileSync(new URL('./fixtures/image-trace-reference.png', import.meta.url)))
const calibrated = { low: [899, 320, 569], medium: [1227, 400, 711], high: [1467, 499, 887] }
for (const [level, [fragments, width, height]] of Object.entries(calibrated)) {
  const traced = traceRasterForToolbar(referenceRaster, { level, colors: 12, removeBg: false })
  assert.equal(traced.metrics.fragments, fragments, `${level} 保持已目视验证的参考碎片密度`)
  assert.deepEqual(traced.metrics.work, { width, height, scale: 1 })
  assert.equal(traced.metrics.optionsApplied.epsilon, 2)
  assert.equal(traced.metrics.optionsApplied.minArea, 10)
  assert.equal(traced.metrics.optionsApplied.minRegionArea, 0)
  assert.equal(traced.metrics.targetReached, true)
}
const simple = traceRasterForToolbar(raster, { level: 'high', removeBg: false })
assert.ok(adaptiveThresholds.high.target > simple.metrics.targetFragments.target, '丰富图像和简单图像使用不同的数量阈值')

// User regression: the 223×205 pink-haired character previously used epsilon≈0.503,
// retaining more than 12,000 staircase segments instead of the intended polygonal facets.
const smallReference = decodePng(readFileSync(new URL('./fixtures/image-trace-small-reference.png', import.meta.url)))
assert.deepEqual([smallReference.width, smallReference.height], [223, 205])
for (const level of ['low', 'medium', 'high']) {
  const traced = traceRasterForToolbar(smallReference, { level, colors: 12, removeBg: false })
  assert.equal(traced.metrics.optionsApplied.epsilon, 2, `${level} 小尺寸角色保持 2px 折面简化`)
  assert.ok((traced.svg.match(/[Ll]/g) || []).length < 3000, `${level} 不再输出上万条像素台阶线段`)
  assert.ok(traced.metrics.fragments > 20 && traced.metrics.fragments < 700, `${level} 保留实际碎片，不保留大量单像素噪点`)
}

// 使用真实渲染器产生 PNG；该依赖可选，缺失时仍有固定 PNG 验证入口。
let image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
try {
  const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js')
  image = 'data:image/png;base64,' + Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#ff0000"/></svg>').render().asPng()).toString('base64')
} catch { /* 固定 PNG 后备 */ }
let route
let writes = 0
plugin.apply({
  tools: { register() { return () => {} } },
  webServer: { register(r) { route = r; return () => {} } },
  fs: { async writeText() { writes += 1 } },
  sessions: { get(id) { return id === 's' ? { header: { cwd: 'D:/workspace' } } : undefined } },
  sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: 'D:/workspace' } } },
  effect(fn) { return fn() },
})
async function request(body, headers = { 'x-drawai-save': '1' }) {
  const listeners = {}
  const req = { method: 'POST', headers, on(event, fn) { listeners[event] = fn; return this } }
  let status, payload
  const res = { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } }
  queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() })
  await route.handler(req, res)
  return { status, payload }
}
const requestBody = { action: 'trace-node-image', sessionId: 's', image, removeBg: false, level: 'low' }
const generated = await request(requestBody)
assert.equal(generated.status, 200)
assert.ok(generated.payload.svg.startsWith('<svg'))
assert.equal(generated.payload.metrics.budget, TRACE_DEFAULTS.maxBytes)
assert.ok(generated.payload.drawing.steps.length > 0, '绘制 API 返回真实轮廓色块的展示序列')
assert.equal(writes, 0, '绘制 API 本身不写文件')
assert.equal((await request({ ...requestBody, sessionId: 'missing' })).status, 403)
assert.equal((await request({ ...requestBody, level: 'invalid' })).status, 400)
assert.equal((await request({ ...requestBody, image: 'https://example.com/image.png' })).status, 400)
assert.equal((await request(requestBody, {})).status, 403)

// 通过真实客户端组合源码执行面板与文档变更：一键生成并落盘（始终保留原图）。
const slots = []
let cursor = 0
const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
  useRef(init) { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i] },
  useEffect() {}, Component: class {},
}
const mod = { exports: {} }
new Function('module', 'exports', 'require', composeClientBody())(mod, mod.exports, (name) => {
  if (name === 'react') return React
  throw new Error(name)
})
const { ImageTracePanel, applyImageTraceToDoc, traceDrawingLayers, createTraceDrawingPlayback, renderDiagram } = mod.exports.__routeInternals
let options, applied
const props = { source: { id: 'a', image }, async onGenerate(o) { options = o; return generated.payload }, onApply(result) { applied = { result } }, onClose() {} }
const flatten = (node) => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.children)] : []
const render = () => { cursor = 0; return flatten(ImageTracePanel(props)) }
const field = (nodes, label) => nodes.find((n) => n.props['aria-label'] === label)
const button = (nodes, label) => nodes.find((n) => n.type === 'button' && n.children.includes(label))
let nodes = render()
assert.equal(field(nodes, '碎片数量').props.value, 'medium')
assert.equal(field(nodes, '容量档位'), undefined, '不提供容量档位选择')
assert.equal(field(nodes, '保留原图'), undefined, '不再提供是否保留原图选项')
assert.equal(button(nodes, '生成预览'), undefined, '不再提供预览步骤')
assert.equal(button(nodes, '替换原图'), undefined, '始终保留原图，无替换入口')
assert.equal(button(nodes, '让大肥鱼开始画画！').props.disabled, false)
assert.equal(nodes.filter((n) => n.type === 'img').length, 0, '面板不展示对照预览')
field(nodes, '碎片数量').props.onChange({ target: { value: 'high' } })
nodes = render()
await button(nodes, '让大肥鱼开始画画！').props.onClick()
assert.equal(options.level, 'high')
assert.equal(applied.result.svg, generated.payload.svg)

const doc = { nodes: [{ id: 'a', x: 10, y: 20, w: 100, h: 80, layer: 'L1', style: styleWithImageDataUri('', image) }], edges: [], layers: [{ id: 'L1', name: '图片' }], meta: {} }
const copy = structuredClone(doc)
const id = applyImageTraceToDoc(copy, props.source, generated.payload.svg)
assert.equal(copy.nodes[0].style, doc.nodes[0].style)
assert.equal(copy.nodes[1].x, 134)
assert.equal(copy.nodes[1].layer, 'L1')
assert.equal(copy.nodes[1].w, 100)
assert.equal(copy.nodes[1].id, id)
assert.equal(svgMarkupFromStyle(copy.nodes[1].style), generated.payload.svg)
assert.throws(() => applyImageTraceToDoc(doc, { id: 'a', image: 'data:image/png;base64,xxxx' }, generated.payload.svg), /原图已更改/)
copy.layers[0].locked = true
assert.throws(() => applyImageTraceToDoc(copy, props.source, generated.payload.svg), /锁定/)

// Revealed regions retain their holes, and completing the reveal renders the exact final geometry.
const ring = { width: 32, height: 32, data: Buffer.alloc(32 * 32 * 4, 255) }
for (let y = 4; y < 28; y++) for (let x = 4; x < 28; x++) {
  if (x >= 10 && x < 22 && y >= 10 && y < 22) continue
  ring.data.set([0, 0, 0, 255], (y * 32 + x) * 4)
}
const traceOptions = { removeBg: false, colors: 2, grid: 32, epsilon: 0, minArea: 0, minRegionArea: 0, protectLuma: 0 }
const full = traceRasterToSvg(ring, traceOptions)
const reveal = traceRasterToSvg(ring, { ...traceOptions, includeDrawing: true })
assert.equal(full.svg, reveal.svg, '展示元数据不能改变最终 SVG 或原有复刻画风')
assert.equal(full.drawing, undefined, '普通 AI 复刻请求不额外返回展示数据')
const { drawing } = reveal
assert.ok(drawing.steps.length > drawing.fills.length, '同一颜色的断开色块独立展示')
assert.ok(drawing.steps.every((s, i) => i === 0 || drawing.steps[i - 1].area >= s.area), '先铺大色块再补细节')
const blackStep = drawing.steps.find((s) => drawing.fills[s.layer] === '#000000')
assert.ok((blackStep.d.match(/M/g) || []).length >= 2, '外轮廓和镂空洞属于同一个展示步骤')
assert.ok(traceDrawingLayers(drawing, 0).every((d) => d === ''), '展示开始时是空白画面')
assert.ok(traceDrawingLayers(drawing, 1).filter(Boolean).length === 1, '首批只显示已完成的色块')
const stageSvg = (count) => '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="' + drawing.viewBox.join(' ') + '">' +
  traceDrawingLayers(drawing, count).map((d, i) => d ? '<path fill="' + drawing.fills[i] + '" fill-rule="nonzero" d="' + d + '"/>' : '').join('') + '</svg>'
let Resvg
try { ({ Resvg } = createRequire(import.meta.url)('@resvg/resvg-js')) } catch { /* optional renderer */ }
if (Resvg) {
  const finalPixels = decodePng(Buffer.from(new Resvg(full.svg, { fitTo: { mode: 'width', value: 32 } }).render().asPng()))
  const revealPixels = decodePng(Buffer.from(new Resvg(stageSvg(drawing.steps.length)).render().asPng()))
  assert.deepEqual(revealPixels.data, finalPixels.data, '展示结束和完整 SVG 的渲染逐像素一致')
  const holeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#000" fill-rule="nonzero" d="' + blackStep.d + '"/></svg>'
  const hole = decodePng(Buffer.from(new Resvg(holeSvg).render().asPng()))
  assert.equal(hole.data[(16 * 32 + 16) * 4 + 3], 0, '色块单独出现时洞内保持透明')
}
let clock = 0, rafId = 0, completions = 0
const callbacks = new Map()
const updates = []
const playback = createTraceDrawingPlayback({ total: 20, duration: 1000,
  now: () => clock, raf: (fn) => { callbacks.set(++rafId, fn); return rafId }, caf: (id) => callbacks.delete(id),
  onProgress: (state) => updates.push(state), onComplete: () => { completions++ },
})
const advance = (ms) => { clock += ms; const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((fn) => fn(clock)) }
playback.resume()
advance(250)
assert.equal(updates.at(-1).count, 1, '绘制进度对应实际已显示的色块数，大色块有更长展示时间')
playback.pause()
advance(1000)
assert.equal(updates.at(-1).count, 1)
assert.equal(callbacks.size, 0, '暂停后释放动画任务')
playback.resume()
advance(250)
assert.equal(updates.at(-1).count, 5, '继续后从暂停处绘制')
playback.finish()
assert.equal(updates.at(-1).count, 20)
assert.equal(completions, 1, '直接完成只触发一次完成回调')
playback.finish()
assert.equal(completions, 1)
playback.dispose()
assert.equal(callbacks.size, 0)
let disposedCompletions = 0
const disposable = createTraceDrawingPlayback({ total: 3, duration: 1000,
  now: () => clock, raf: (fn) => { callbacks.set(++rafId, fn); return rafId }, caf: (id) => callbacks.delete(id),
  onProgress() {}, onComplete: () => { disposedCompletions++ },
})
disposable.resume()
disposable.dispose()
advance(2000)
assert.equal(callbacks.size, 0, '删除节点或关闭画布后取消绘制动画')
assert.equal(disposedCompletions, 0, '销毁后不再执行完成回调')
const interactive = renderDiagram({ ...copy, layers: [] }, 'light', 'drawing-test', { current: null }, {
  traceDrawing: { id, drawing, svg: reveal.svg }, onTraceDrawingComplete() {},
}, null)
assert.equal(flatten(interactive).filter((n) => n.props.key === 'trace-drawing').length, 1, '画布中绘制过程仅覆盖目标节点')
const exported = renderDiagram({ ...copy, layers: [] }, 'light', 'drawing-export', { current: null }, { showGrid: false }, null)
assert.equal(flatten(exported).filter((n) => n.props.key === 'trace-drawing').length, 0, '导出直接使用完整 SVG，不包含过程控件')
console.log('check-image-trace: OK（自适应碎片、逐块展示、暂停续绘、完整图像一致性、导出隔离、原图保留与锁定检查）')
