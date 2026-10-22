import { createMediaPerformance } from '../src/performance-metrics.js'
import { createDrawingQueue } from '../src/drawing-queue.js'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { composeClientBody } from './build.mjs'
import { svgMarkupFromStyle } from '../src/style-kernel.js'
import { packSvgVideoZip, parseZip, readManifest, unpackSvgVideoZip } from '../src/media.js'
import { traceRasterForToolbar } from '../src/trace-image.js'
import { createCanvasSessionStore } from '../src/canvas-sessions.js'
import { deflateSync } from 'node:zlib'
import * as plugin from '../lib/index.js'

const slots = []
let cursor = 0
const React = { createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
  useRef(init) { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i] },
  useEffect() {}, Component: class {} }
const mod = { exports: {} }
new Function('module', 'exports', 'require', composeClientBody())(mod, mod.exports, (name) => { if (name === 'react') return React; throw new Error(name) })
const { videoTracePlan, waitForVideoTraceEvent, applyVideoTraceToDoc, VideoTracePanel } = mod.exports.__routeInternals
const opts = { from: 2, seconds: 5, fps: 12, width: 480 }
const empty = traceRasterForToolbar({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 255) }, {
  removeBg: true, allowEmpty: true, maxBytes: 60000,
})
assert.equal(empty.metrics.foregroundPixels, 0, 'fully removed background is a valid blank video frame')
assert.equal(empty.metrics.budget, 60000)
assert.deepEqual(videoTracePlan(opts, 10, 1920, 1080), { from: 2, fps: 12, count: 60, w: 480, h: 270, maxBytes: 120000 })
assert.deepEqual(videoTracePlan(opts, 3, 1080, 1920), { from: 2, fps: 12, count: 12, w: 270, h: 480, maxBytes: 120000 })
for (const [level, budget] of [['low', 60000], ['medium', 120000], ['high', 248000]]) {
  assert.equal(videoTracePlan({ ...opts, level, maxBytes: 2000 }, 10, 1920, 1080).maxBytes, budget, 'fragment level determines budget and overrides legacy detail settings')
}
assert.equal(videoTracePlan(opts, 10, 32, 24).w, 32, 'small source is not enlarged')
assert.equal(videoTracePlan({ ...opts, seconds: 120, fps: 30 }, 200, 100, 100).count, 3600)
assert.equal(videoTracePlan({ ...opts, seconds: 10, fps: 29.97 }, 200, 100, 100).count, 300)
assert.deepEqual(videoTracePlan({ range: 'all', fps: 60, resolution: '0', level: 'high' }, 60, 1920, 1080),
  { from: 0, fps: 60, count: 3600, w: 1920, h: 1080, maxBytes: 248000 })
assert.equal(videoTracePlan({ from: 10, end: '', fps: 25, resolution: 'custom', width: 1024 }, 60, 1920, 1080).count, 1250)
assert.equal(videoTracePlan({ from: 0, end: 1, fps: 30, resolution: '1440' }, 60, 3840, 2160).w, 1440)
assert.throws(() => videoTracePlan({ from: 1, end: 1, fps: 30, resolution: '0' }, 60, 100, 100), /结束时间/)
assert.throws(() => videoTracePlan({ range: 'all', fps: 0, resolution: '0' }, 60, 100, 100), /帧率/)
assert.throws(() => videoTracePlan({ range: 'all', fps: 30, resolution: '0' }, 60, 8000, 8000), /1600 万/)
assert.throws(() => videoTracePlan({ ...opts, from: 10 }, 10, 100, 100), /开始时间/)
assert.throws(() => videoTracePlan({ ...opts, seconds: NaN }, 10, 100, 100))
const eventVideo = new EventTarget()
const controller = new AbortController()
await waitForVideoTraceEvent(eventVideo, 'seeked', controller.signal, () => eventVideo.dispatchEvent(new Event('seeked')))
const pending = waitForVideoTraceEvent(eventVideo, 'seeked', controller.signal, () => {})
controller.abort()
await assert.rejects(pending, /取消/)
await assert.rejects(waitForVideoTraceEvent(eventVideo, 'seeked', controller.signal, () => { throw new Error('must not trigger') }), /取消/)
await assert.rejects(waitForVideoTraceEvent(eventVideo, 'loadeddata', new AbortController().signal, () => eventVideo.dispatchEvent(new Event('error'))), /解码失败/)

const flatten = (n) => Array.isArray(n) ? n.flatMap(flatten) : n && typeof n === 'object' ? [n, ...flatten(n.children)] : []
let started, cancelled = false
const panelProps = { onStart(o) { started = o }, onCancel() { cancelled = true }, onClose() {} }
cursor = 0
let panel = flatten(VideoTracePanel(panelProps))
assert.ok(!panel.some((n) => n.props['aria-label'] === '细节保留'))
assert.ok(panel.some((n) => n.props['aria-label'] === '碎片数量'))
panel.find((n) => n.type === 'button' && n.children.includes('让大肥鱼开始画画！')).props.onClick()
assert.equal(started.end, 5)
assert.equal(started.range, 'clip')
assert.equal(started.removeBg, false)
cursor = 0
panel = flatten(VideoTracePanel({ ...panelProps, job: { busy: true, done: 2, total: 60, message: '绘制中' } }))
assert.ok(panel.filter((n) => n.type === 'select' || n.type === 'input').every((n) => n.props.disabled))
panel.find((n) => n.type === 'button' && n.children.includes('取消复刻')).props.onClick()
assert.ok(cancelled)

// 选区工具栏的排队模式只传 queued/onStart/onClose：提交中同样会 busy，但没有 job 也不能崩。
{
  cursor = 0
  slots.length = 0
  let resolveSubmit, closed = false
  const queuedProps = { queued: true, inline: true, onClose() { closed = true },
    onStart() { return new Promise((resolve) => { resolveSubmit = resolve }) } }
  let queuedPanel = flatten(VideoTracePanel(queuedProps))
  const submit = queuedPanel.find((n) => n.type === 'button' && n.children.includes('加入绘制队列')).props.onClick()
  cursor = 0
  queuedPanel = flatten(VideoTracePanel(queuedProps))
  const progress = queuedPanel.find((n) => n.props['aria-label'] === '视频复刻进度')
  assert.ok(progress, '排队提交中也应有进度反馈')
  assert.equal(progress.props.value, undefined, '没有 job 时进度条是不确定态，而不是读 job.done')
  assert.ok(queuedPanel.filter((n) => n.type === 'select' || n.type === 'input').every((n) => n.props.disabled))
  assert.doesNotThrow(() => queuedPanel[0].props.onKeyDown({ key: 'Escape', stopPropagation() {} }), '没有 onCancel 时按 Esc 不能抛错')
  resolveSubmit()
  await submit
  assert.equal(closed, false)
  cursor = 0
  queuedPanel = flatten(VideoTracePanel(queuedProps))
  assert.ok(!queuedPanel.some((n) => n.props['aria-label'] === '视频复刻进度'))
  assert.ok(queuedPanel.filter((n) => n.type === 'select' || n.type === 'input').every((n) => !n.props.disabled))
}

// 视频绘制和导出使用与图片同一个悬停卡片，验证真正的展开/延迟关闭行为。
{
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const popoverSource = source.slice(source.indexOf('function ToolbarPopover(props)'), source.indexOf('const ImageTraceControl = ToolbarPopover'))
  const refs = [], effects = [], timers = new Map(), listeners = new Map()
  const hoverReact = { createElement: React.createElement, useState: (value) => [value, () => {}], useRef(value) { const ref = { current: value }; refs.push(ref); return ref }, useEffect(fn) { effects.push(fn) } }
  const input = { tagName: 'INPUT' }
  const doc = { documentElement: { clientWidth: 800, clientHeight: 600 }, activeElement: null,
    addEventListener(type, fn) { listeners.set(type, fn) }, removeEventListener(type) { listeners.delete(type) } }
  const win = { addEventListener() {}, removeEventListener() {} }
  const Popover = new Function('React', 'document', 'window', 'setTimeout', 'clearTimeout', popoverSource + '\nreturn ToolbarPopover')(
    hoverReact, doc, win, (fn) => { const id = {}; timers.set(id, fn); return id }, (id) => timers.delete(id))
  const tree = Popover({ label: '导出', renderPanel: (close) => React.createElement('button', { onClick: close }, '导出 SVG 视频') })
  const anchor = { open: false, contains(target) { return target === input }, getBoundingClientRect() { return { left: 100, top: 500, bottom: 550 } } }
  let visible = false
  const panel = { style: {}, offsetWidth: 320, contains(target) { return target === input },
    matches() { return visible }, showPopover() { visible = true }, hidePopover() { visible = false }, getBoundingClientRect() { return { height: 200 } } }
  refs[0].current = anchor; refs[1].current = panel
  const cleanup = effects.map((fn) => fn())
  const nodes = flatten(tree), panelNode = nodes.find((n) => n.props['aria-label'] === '导出面板')
  assert.equal(tree.props.className, 'drawai-color-palette')
  assert.ok(nodes.some((n) => n.props.className === 'drawai-tool-icon'))
  assert.ok(nodes.some((n) => n.props.className === 'drawai-color-label'))
  tree.props.onPointerEnter()
  assert.ok(anchor.open && visible)
  assert.equal(panel.style.top, '288px', 'hover panel appears above toolbar when space permits')
  tree.props.onPointerLeave()
  assert.equal(timers.size, 1)
  panelNode.props.onPointerEnter()
  assert.equal(timers.size, 0, 'moving from button to popover cancels delayed close')
  doc.activeElement = input
  panelNode.props.onPointerLeave()
  assert.equal(timers.size, 0, 'focused video parameter inputs keep the hover panel open')
  doc.activeElement = null
  panelNode.props.onPointerLeave()
  for (const fn of timers.values()) fn()
  assert.ok(!anchor.open && !visible)
  nodes.find((n) => n.type === 'summary').props.onFocus()
  assert.ok(anchor.open && visible, 'keyboard focus opens the shared popover')
  listeners.get('pointerdown')({ target: {} })
  assert.ok(!anchor.open && !visible, 'outside click closes the shared popover')
  for (const fn of cleanup) if (typeof fn === 'function') fn()
  assert.equal(listeners.size, 0)
}

// 任务卡片不创建模态层，收起后仍能取消，失败重试继续使用原参数。
{
  const { VideoTraceStatusCard } = mod.exports.__routeInternals
  slots.length = 0; cursor = 0
  let cancelled = false, retried = false, closed = false
  const props = { job: { busy: true, done: 3, total: 10, message: '绘制中' },
    onCancel: () => { cancelled = true }, onRetry: () => { retried = true }, onClose: () => { closed = true } }
  let tree = VideoTraceStatusCard(props), nodes = flatten(tree)
  assert.equal(tree.props.role, 'region')
  assert.ok(nodes.every((n) => n.props['aria-modal'] !== true && !n.props.autoFocus && n.props.role !== 'dialog'))
  nodes.find((n) => n.props['aria-label'] === '收起复刻进度').props.onClick()
  cursor = 0; nodes = flatten(VideoTraceStatusCard(props))
  assert.ok(!nodes.some((n) => n.props.className === 'drawai-video-task-detail'))
  nodes.find((n) => n.type === 'button' && n.children.includes('取消')).props.onClick()
  assert.ok(cancelled)
  slots.length = 0; cursor = 0
  nodes = flatten(VideoTraceStatusCard({ ...props, job: { error: true, options: opts, message: '失败' } }))
  nodes.find((n) => n.children.includes('重试复刻')).props.onClick()
  nodes.find((n) => n.children.includes('关闭')).props.onClick()
  assert.ok(retried && closed)

}

const root = mkdtempSync(join(tmpdir(), 'drawai-video-trace-'))
const previousPerf = process.env.DRAWAI_PERF
process.env.DRAWAI_PERF = '1'
let route
plugin.apply({ tools: { register() { return () => {} } }, webServer: { register(r) { route = r; return () => {} } },
  fs: { async resolve(p, options) { return { path: resolve(options?.cwd || root, p) } }, processPath(t) { return t.path },
    contains(a, b) { const rel = relative(a.path, b.path); return !rel.startsWith('..') && !isAbsolute(rel) } },
  sessions: { get(id) { return ['s', 'other'].includes(id) ? { header: { cwd: root } } : undefined } },
  sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: root } } }, effect(fn) { return fn() } })
async function request(action, extra = {}) {
  const body = { sessionId: 's', path: 'demo.drawio', action, ...extra }, listeners = {}
  const req = { method: 'POST', headers: { 'x-drawai-save': '1' }, on(e, fn) { listeners[e] = fn; return this } }
  let status, payload
  const res = { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } }
  queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() })
  await route.handler(req, res)
  return { status, payload }
}
try {
  assert.equal((await request('media-trace-start', { count: 0, fps: 12, w: 1, h: 1 })).payload.ok, false)
  const extended = (await request('media-trace-start', { count: 3600, fps: 29.97, w: 1920, h: 1080, maxBytes: 248000 })).payload
  assert.equal(extended.ok, true, extended.error)
  await request('media-trace-discard', { clip: extended.clip, token: extended.token })
  assert.equal((await request('media-trace-start', { count: 1, fps: 30, w: 8000, h: 8000 })).payload.ok, false)
  assert.equal((await request('media-trace-start', { count: 1, fps: 12, w: 1, h: 1, path: '../outside.drawio' })).status, 403)
  const start = await request('media-trace-start', { count: 2, fps: 12, w: 1, h: 1 })
  assert.equal(start.status, 200)
  assert.ok(start.payload.poolSize >= 1 && start.payload.poolSize <= 4, 'trace start reports the worker pool size')
  const { token, clip } = start.payload
  const auth = { token, clip }
  assert.equal((await request('media-trace-discard', { ...auth, sessionId: 'other' })).payload.ok, false)
  assert.equal((await request('media-trace-finish', auth)).payload.ok, false, 'cannot finish partial result')
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
  // 一个实际 1024px 的有效 PNG，验证工作线程没有沿用图片的 887px 隐式上限。
  const pngChunk = (type, data) => {
    const typed = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff
    for (const byte of typed) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); typed.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
    return out
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1024); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6
  const rows = Buffer.alloc((1024 * 4 + 1) * 32)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 1024; x++) { const offset = y * (1024 * 4 + 1) + 1 + x * 4; rows[offset] = 255; rows[offset + 3] = 255 }
  const widePng = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))])
  const widePack = (await request('media-trace-start', { count: 1, fps: 30, w: 1024, h: 32, maxBytes: 248000 })).payload
  const wideAuth = { token: widePack.token, clip: widePack.clip, index: 0 }
  const split = Math.floor(widePng.length / 2)
  assert.equal((await request('media-trace-frame-chunk', { ...wideAuth, offset: 1, base64: widePng.toString('base64') })).payload.ok, false)
  assert.equal((await request('media-trace-frame-chunk', { ...wideAuth, offset: 0, base64: widePng.subarray(0, split).toString('base64') })).payload.ok, true)
  assert.equal((await request('media-trace-frame-chunk', { ...wideAuth, offset: split, base64: widePng.subarray(split).toString('base64') })).payload.ok, true)
  const wideFrame = (await request('media-trace-frame', { ...wideAuth, level: 'high', removeBg: false })).payload
  assert.equal(wideFrame.ok, true, wideFrame.error)
  assert.equal(wideFrame.work.width, 1024)
  assert.equal(wideFrame.work.height, 32)
  await request('media-trace-discard', wideAuth)
  const frame = { ...auth, pngBase64, level: 'medium', preset: 'default', colors: 6, removeBg: false }
  assert.equal((await request('media-trace-frame', { ...frame, index: 1 })).payload.ok, false, 'cannot skip frames')
  const first = await request('media-trace-frame', { ...frame, index: 0 })
  assert.equal(first.payload.ok, true, first.payload.error)
  assert.ok(first.payload.svg.length <= 60000)
  assert.equal((await request('media-trace-frame', { ...frame, index: 0 })).payload.ok, false, 'cannot overwrite a completed frame')
  assert.equal((await request('media-trace-frame', { ...frame, index: 1 })).payload.ok, true)
  const finish = await request('media-trace-finish', auth)
  const piped = (await request('media-trace-start', { count: 2, fps: 12, w: 1, h: 1 })).payload
  const pipeAuth = { token: piped.token, clip: piped.clip, pngBase64, level: 'medium', preset: 'default', colors: 6, removeBg: false }
  const [pipe0, pipe1] = await Promise.all([
    request('media-trace-frame', { ...pipeAuth, index: 0 }),
    request('media-trace-frame', { ...pipeAuth, index: 1 }),
  ])
  assert.equal(pipe0.payload.ok, true, pipe0.payload.error)
  assert.equal(pipe1.payload.ok, true, pipe1.payload.error)
  assert.equal((await request('media-trace-finish', { token: piped.token, clip: piped.clip })).payload.manifest.frames.length, 2)
  await request('media-trace-release', { token: piped.token, clip: piped.clip })
  const still = Buffer.alloc(32 * 18, 40).toString('base64')
  const near = Buffer.alloc(32 * 18, 50).toString('base64')
  const far = Buffer.alloc(32 * 18, 200).toString('base64')
  const accel = (await request('media-trace-start', { count: 4, fps: 12, w: 1, h: 1 })).payload
  const accelFrame = { token: accel.token, clip: accel.clip, pngBase64, level: 'medium', preset: 'default', colors: 6, removeBg: false }
  const same0 = (await request('media-trace-frame', { ...accelFrame, index: 0, fingerprint: still })).payload
  const same1 = (await request('media-trace-frame', { ...accelFrame, index: 1, fingerprint: still })).payload
  assert.equal(same0.ok && same1.ok && same1.reused === true && same1.svg === same0.svg, true, 'identical PNGs with matching parameters reuse the previous SVG')
  const shared = (await request('media-trace-frame', { ...accelFrame, index: 2, fingerprint: near })).payload
  assert.equal(shared.ok && shared.reused === true && shared.paletteShared === false, true, 'legacy gray fingerprint hints do not affect exact reuse')
  const changed = (await request('media-trace-frame', { ...accelFrame, index: 3, fingerprint: far })).payload
  assert.equal(changed.ok && changed.reused === true && changed.paletteShared === false, true, 'a contradictory legacy fingerprint cannot invalidate identical PNG content')
  await request('media-trace-discard', { token: accel.token, clip: accel.clip })
  assert.equal(finish.payload.manifest.frames.length, 2)
  assert.equal(finish.payload.manifest.duration, 2 / 12)
  const doc = { nodes: [{ id: 'n1', x: 10, y: 20, w: 100, h: 80, layer: 'L1', style: '', data: { drawaiMedia: '1', mediaKind: 'raster', mediaClip: 'source' } }], edges: [], layers: [{ id: 'L1' }], meta: {} }
  const original = structuredClone(doc)
  const result = { clip, poster: first.payload.svg, w: 1, h: 1, fps: 12 }
  const id = applyVideoTraceToDoc(doc, { id: 'n1', clip: 'source' }, result)
  assert.deepEqual(doc.nodes[0], original.nodes[0], 'source video is untouched')
  const output = doc.nodes.find((n) => n.id === id)
  assert.equal(output.x, 134)
  assert.equal(output.layer, 'L1')
  assert.equal(output.data.mediaKind, 'svg')
  assert.equal(svgMarkupFromStyle(output.style), first.payload.svg)
  doc.layers[0].locked = true
  assert.throws(() => applyVideoTraceToDoc(doc, { id: 'n1', clip: 'source' }, result), /锁定/)
  assert.throws(() => applyVideoTraceToDoc(doc, { id: 'n1', clip: 'changed' }, result), /更改/)
  const dir = join(root, 'demo.media', clip)
  const entries = parseZip(packSvgVideoZip(dir))
  assert.equal(entries.filter((e) => e.name.startsWith('frames/')).length, 2)
  assert.equal((await request('media-trace-release', auth)).payload.ok, true)
  assert.equal((await request('media-trace-discard', auth)).payload.ok, false, 'released output cannot be discarded')
  assert.ok(existsSync(dir))
  const cancelledStart = (await request('media-trace-start', { count: 2, fps: 12, w: 1, h: 1 })).payload
  const cancelAuth = { token: cancelledStart.token, clip: cancelledStart.clip }
  await request('media-trace-frame', { ...frame, ...cancelAuth, index: 0 })
  assert.equal((await request('media-trace-discard', cancelAuth)).payload.ok, true)
  assert.ok(!existsSync(join(root, 'demo.media', cancelAuth.clip)), 'cancel removes partial frames')
  assert.equal((await request('media-trace-frame', { ...frame, ...cancelAuth, index: 1 })).payload.ok, false)
  assert.ok(existsSync(dir), 'cancel leaves completed clips intact')

  // 执行真实 CanvasView 调度函数，浏览器仅替换解码与画布，媒体写盘走真实路由。
  const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const runSource = clientSource.slice(clientSource.indexOf('  async function startVideoTrace('), clientSource.indexOf('  React.useEffect(() => {\n    if (!traceDrawing)'))
  assert.ok(runSource.includes('media-trace-finish'))
  assert.ok(runSource.includes('VIDEO_TRACE_PIPELINE') && runSource.includes('pack.poolSize') && !runSource.includes('fingerprint'), 'client aligns pipeline depth with the pool without approximate fingerprints')
  async function runWorkflow(mode) {
    mkdirSync(join(root, 'demo.media', 'source'), { recursive: true })
    writeFileSync(join(root, 'demo.media', 'source', 'source.mp4'), Buffer.from('source-with-audio'))
    const documentState = structuredClone(original), before = structuredClone(documentState)
    const drawingQueue = createDrawingQueue()
    const canvasSessions = createCanvasSessionStore({ onApplied: (id) => drawingQueue.applied(id), onSaved: (id) => drawingQueue.saved(id) })
    const docRef = { current: documentState }, videoTraceRun = canvasSessions.task('s', 'demo.drawio', 0), history = [], times = [], discarded = [], pendingCalls = []
    let state, selected, revoked = 0, taskClip, pauseCheck, pauseError
    const receive = () => {
      state = videoTraceRun.job
      canvasSessions.consume(videoTraceRun, ({ source, output, taskId }) => {
        const next = structuredClone(docRef.current)
        const id = applyVideoTraceToDoc(next, source, output)
        if (taskId) next.nodes.find((node) => node.id === id).data.drawaiTaskId = taskId
        history.push(structuredClone(docRef.current))
        docRef.current = next
        selected = [id]
      })
      if (videoTraceRun.pendingSave) canvasSessions.acknowledge(videoTraceRun, docRef.current)
    }
    let unsubscribe = canvasSessions.subscribe(videoTraceRun, receive)
    class FakeVideo extends EventTarget {
      duration = 10; videoWidth = 1; videoHeight = 1; position = 0
      get currentTime() { return this.position }
      set currentTime(value) { this.position = value; this.dispatchEvent(new Event('seeked')) }
      load() { if (this.src) this.dispatchEvent(new Event('loadeddata')) }
      pause() {}
      removeAttribute() { this.src = '' }
    }
    const video = new FakeVideo()
    const environment = {
      createMediaPerformance,
      drawingQueue, pageIndex: 0,
      canvasSessions, videoTraceRun, videoTraceSource: { id: 'n1', clip: 'source' }, docRef,
      setVideoTraceSource(source) { canvasSessions.update(videoTraceRun, { source }) },
      setVideoTraceJob(value) { canvasSessions.update(videoTraceRun, { job: typeof value === 'function' ? value(videoTraceRun.job) : value }) },
      setSaveNote() {}, setSelectedIds(value) { selected = value },
      applyLocal(mutate) { const next = structuredClone(docRef.current); mutate(next); history.push(structuredClone(docRef.current)); docRef.current = next },
      videoController: { suspend() {} }, target: 'demo.drawio', sessionId: 's', SAVE_ENDPOINT: '/save', SAVE_HEADER: 'x-drawai-save',
      document: { createElement(type) { return type === 'video' ? video : {
        getContext() { return { drawImage() { times.push(video.currentTime) } } },
        toBlob(callback) { callback(new Blob([Buffer.from(pngBase64, 'base64'), ...(mode === 'chunked' ? [Buffer.alloc(1024 * 1024)] : [])], { type: 'image/png' })) },
      } } },
      URL: { createObjectURL() { return 'blob:test' }, revokeObjectURL() { revoked++ } },
      videoTracePlan, waitForVideoTraceEvent, applyVideoTraceToDoc,
      async readVideoChunk(blob) { return Buffer.from(await blob.arrayBuffer()).toString('base64') },
      fetch(url, init) {
        const body = JSON.parse(init.body)
        if (mode === 'queued-pause' && body.action === 'media-trace-frame' && body.index === 0) {
          const id = drawingQueue.list()[0].id
          drawingQueue.pause(id)
          pauseCheck = (async () => {
            const until = Date.now() + 10000
            while (drawingQueue.list()[0].status !== 'paused' && Date.now() < until) await new Promise((done) => setTimeout(done, 5))
            assert.equal(drawingQueue.list()[0].status, 'paused')
            assert.equal(times.length, 1, 'pause stops extraction after draining the in-flight first frame')
            drawingQueue.resume(id)
          })().catch((error) => { pauseError = error; drawingQueue.resume(id) })
        }
        if (mode === 'detached' && body.action === 'media-trace-frame') unsubscribe()
        const response = (payload, status = 200) => ({ ok: status === 200, status, async json() { return payload } })
        if (body.action === 'media-source-bytes') return Promise.resolve(response({ ok: true, base64: 'AA==', mime: 'video/mp4' }))
        if (body.action === 'media-trace-frame' && body.index === 1 && mode === 'failure') return Promise.resolve(response({ ok: false, error: '模拟绘制失败' }, 500))
        const call = request(body.action, body).then(({ status, payload }) => {
          if (body.action === 'media-trace-start') taskClip = payload.clip
          if (body.action === 'media-trace-discard') discarded.push(body.clip)
          if (body.action === 'media-trace-frame' && mode === 'cancel') videoTraceRun.current.abort()
          return response(payload, status)
        })
        pendingCalls.push(call)
        return call
      },
    }
    // The legacy decoder remains a compatibility path. The default host queue
    // and pause/restart semantics are exercised by check-background-tasks.
    const run = new Function(...Object.keys(environment), runSource + '\nreturn startVideoTrace')(...Object.values(environment))
    const options = { from: 2, seconds: 0.5, fps: 6, width: 320, level: 'low', preset: 'default', colors: 6, removeBg: false }
    await run(options)
    await Promise.all(pendingCalls)
    if (mode === 'detached') {
      assert.deepEqual(docRef.current, before, 'an unmounted view is never mutated by a background completion')
      assert.equal(history.length, 0)
      assert.equal(videoTraceRun.job.busy, false, 'drawing completes while no progress UI is subscribed')
      assert.ok(videoTraceRun.result, 'complete media awaits the original canvas')
      const restored = canvasSessions.task('s', 'demo.drawio', 0)
      assert.equal(restored, videoTraceRun)
      unsubscribe = canvasSessions.subscribe(restored, receive)
      receive()
      assert.equal(history.length, 1, 'returning to the original canvas inserts the result exactly once')
    }
    assert.equal(videoTraceRun.current, null)
    assert.equal(revoked, 1, 'always releases decoder blob URL')
    assert.equal(state.busy, false)
    if (mode === 'success' || mode === 'chunked' || mode === 'detached' || mode === 'queued' || mode === 'queued-pause') {
      assert.equal(history.length, 1, 'complete workflow is one undo operation')
      assert.deepEqual(history[0], before)
      assert.equal(docRef.current.nodes.length, 2)
      assert.deepEqual(docRef.current.nodes[0], before.nodes[0])
      assert.equal(selected.length, 1)
      assert.deepEqual(times, [2, 2 + 1 / 6, 2 + 2 / 6], 'samples requested segment at the requested fps')
      assert.match(state.message, /3 帧，0.50 秒/)
      assert.equal(state.options.fps, 6, 'progress dialog receives the options chosen in the hover panel')
      assert.equal(discarded.length, 0)
      assert.ok(existsSync(join(root, 'demo.media', taskClip)))
      const tracedDir = join(root, 'demo.media', taskClip)
      assert.equal(readManifest(tracedDir).sourceOffset, 2)
      assert.equal(readFileSync(join(tracedDir, 'source.mp4'), 'utf8'), 'source-with-audio', 'trace owns its audio source independently of original clip')
      rmSync(join(root, 'demo.media', 'source'), { recursive: true, force: true })
      const retainedSource = await request('media-source-bytes', { clip: taskClip })
      assert.equal(Buffer.from(retainedSource.payload.base64, 'base64').toString(), 'source-with-audio', 'removing original clip cannot remove traced audio')
      const zipped = packSvgVideoZip(tracedDir)
      assert.ok(parseZip(zipped).some((entry) => entry.name === 'source.mp4'), 'SVG video export includes its audio source')
      const restoredDir = join(root, 'restored-' + mode)
      assert.equal(unpackSvgVideoZip(zipped, restoredDir).sourceOffset, 2)
      assert.equal(readFileSync(join(restoredDir, 'source.mp4'), 'utf8'), 'source-with-audio')
    } else {
      assert.deepEqual(docRef.current, before, 'incomplete workflow never changes document')
      assert.equal(history.length, 0)
      assert.equal(discarded.length, 1)
      assert.ok(!existsSync(join(root, 'demo.media', taskClip)))
      assert.match(state.message, mode === 'cancel' ? /已取消/ : /第 2 帧失败/)
    }
    unsubscribe()
    drawingQueue.dispose()
  }
  await runWorkflow('success')
  await runWorkflow('chunked')
  await runWorkflow('detached')
  await runWorkflow('cancel')
  await runWorkflow('failure')
  const reports = readdirSync(join(root, '.drawai-cache', 'performance')).map((name) => JSON.parse(readFileSync(join(root, '.drawai-cache', 'performance', name), 'utf8')))
  const complete = reports.find((report) => report.status === 'done' && report.stages['browser.pngEncode'])
  assert.ok(complete, 'actual client and host aggregate into the same scoped report')
  assert.ok(complete.stages['browser.request.media-trace-frame'].count > 0, 'request stage names preserve hyphens')
  assert.ok(complete.stages['worker.pngDecode'].count > 0)
  assert.ok(complete.counters.frames > 0 && complete.peaks.hostRssBytes > 0)
  console.log('check-video-trace: OK (plans, controls, decoding cancellation, scoped jobs, complete SVG sequence, export, source preservation)')
} finally {
  if (previousPerf === undefined) delete process.env.DRAWAI_PERF; else process.env.DRAWAI_PERF = previousPerf
  rmSync(root, { recursive: true, force: true })
}
