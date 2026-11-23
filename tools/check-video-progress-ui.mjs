/**
 * 画布上「点进度条」到底发生在哪一刻 —— 真 Chrome、真 React、真 DOM 鼠标事件。
 *
 * 为什么需要它：现有进度条测试（check-video-player.mjs）用自写的假 React 渲染器，
 * 只断言 props（onChange / max / disabled），**测不到真实 <input type=range> 的行为**：
 * ① 时长未知时 max=0，点击根本不会产生 value 变化 → onChange 不触发，点击被吞；
 * ② 已经知道时长但会话还没起播（kind 为空）时，点击被当成"先起播"，落位意图丢了 →
 *    视频从 0 开始播，看起来就是"点了进度条，它从头开始播"。
 * 这里把真正的 VideoSurface 挂进 Chromium，用 CDP 发真实鼠标按下/抬起，直接读播放器状态。
 *
 * 用法：node tools/check-video-progress-ui.mjs
 */
import assert from 'node:assert/strict'
import { createReadStream, statSync } from 'node:fs'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { openBrowser } from '@remotion/renderer'

const FRAMES = 504
const FPS = 29.97
const DURATION = FRAMES / FPS

const css = `
html,body{margin:0;background:#111}
.drawai-video-surface{position:relative;width:100%;height:100%;overflow:hidden;background:#000}
.drawai-video-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:44px;min-height:44px;border:1px solid #ffffff80;border-radius:999px;background:#101827bf;color:#fff;font-size:16px;cursor:pointer;z-index:1}
.drawai-video-chrome{position:absolute;left:0;right:0;bottom:0;z-index:2;display:flex;align-items:center;gap:6px;background:linear-gradient(transparent,#0009)}
.drawai-video-chrome-progress{flex:1 1 auto;min-width:0;height:4px;margin:0;accent-color:#fff;cursor:pointer}
.drawai-video-preview{position:absolute;inset:0;background:#111}
.drawai-video-preview-media{height:280px}
.drawai-video-controls input[type=range]{width:400px}
`

// 海报占位：真机上 poster 是 SVG 片段，这里给一张 1x1 的，免得浏览器抱怨空 src。
const POSTER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#000"/></svg>')

const entry = `
import ReactRuntime from 'react'
import { createRoot } from 'react-dom/client'
import { createVideoController, VideoSurface, VideoPreview } from './src/video-player.js'
globalThis.React = ReactRuntime

const FPS = ${FPS}
const params = new URLSearchParams(location.search)
const svgFrameGate = new Promise((resolve) => { window.__allowSvgFrames = resolve })
const request = () => async (action, extra) => {
  if (extra.clip === 'sourceclip') {
    if (action === 'media-manifest') return { hasSource: true, manifest: { frames: [] } }
    if (action === 'media-source-url') return { url: '/fixture.mp4' + (params.has('desktop') ? '?desktop' : '') }
  }
  if (action === 'media-manifest' && params.has('slow')) await new Promise((resolve) => setTimeout(resolve, 350))
  if (action === 'media-manifest') return Promise.resolve({ hasSource: false, manifest: {
    version: 1, kind: 'svg', fps: FPS, width: 960, height: 540, source: null, sourceOffset: 0, duration: ${DURATION},
    frames: Array.from({ length: ${FRAMES} }, (_, i) => ({ file: 'frames/' + String(i + 1).padStart(4, '0') + '.svg', t: i / FPS })),
  } })
  if (action === 'media-frame') {
    if (params.has('slowframes') && extra.index >= 12) await svgFrameGate
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 54"><rect width="96" height="54" fill="#0b0b0b"/><text x="10" y="34" fill="#fff" font-size="22" font-family="monospace">' + extra.index + '</text></svg>' }
  }
  return Promise.reject(new Error('unexpected ' + action))
}
const clips = {
  svgclip: { id: 'svgclip', meta: { clip: 'svgclip', kind: 'svg', fps: FPS, duration: 0, posterFrame: 0 } },
  rasterclip: { id: 'rasterclip', meta: { clip: 'rasterclip', kind: 'svg', fps: FPS, duration: ${DURATION}, posterFrame: 0 } },
  sourceclip: { id: 'sourceclip', meta: { clip: 'sourceclip', kind: 'raster', fps: FPS, duration: 0, posterFrame: 0 } },
}
for (const clip of Object.values(clips)) {
  clip.controller = createVideoController(request(), { protocol: params.has('desktop') ? 'dsh-app:' : location.protocol })
  clip.node = { id: clip.id, data: { drawaiMedia: '1', mediaClip: clip.id, mediaKind: clip.meta.kind } }
  let previous = clip.controller.get(clip.id)
  clip.controller.subscribe(() => {
    const current = clip.controller.get(clip.id)
    // Capture the landing before playback advances. Wall time here depends on browser load.
    if (current.kind === 'svg' && !current.seeking && (previous.seeking || Math.abs(current.time - previous.time) >= 2)) {
      clip.svgLanding = current.time
    }
    previous = current
  })
}
const surface = (clip) => ReactRuntime.createElement(VideoSurface, {
  controller: clip.controller, node: clip.node,
  meta: clip.meta, poster: ${JSON.stringify(POSTER)},
})
function App() {
  if (params.has('desktop')) {
    return ReactRuntime.createElement('div', { 'data-clip': 'sourceclip', style: { width: 520, height: 292, margin: 20 } }, surface(clips.sourceclip))
  }
  if (params.has('preview')) {
    const clip = clips.sourceclip
    return ReactRuntime.createElement('div', { 'data-clip': clip.id },
      ReactRuntime.createElement('button', { id: 'open-preview', onClick: async () => {
        await clip.controller.play(clip.node, clip.meta)
        clip.controller.configure(clip.id, { expanded: true })
      } }, '打开预览'),
      ReactRuntime.createElement(VideoPreview, { controller: clip.controller, nodes: [clip.node],
        metaOf: () => clip.meta, posterOf: () => ${JSON.stringify(POSTER)} }))
  }
  return ReactRuntime.createElement('div', { style: { display: 'flex', gap: 20, padding: 20 } },
    ReactRuntime.createElement('div', { 'data-clip': 'svgclip', style: { width: 420, height: 236 } }, surface(clips.svgclip)),
    ReactRuntime.createElement('div', { 'data-clip': 'rasterclip', style: { width: 420, height: 236 } }, surface(clips.rasterclip)))
}
createRoot(document.getElementById('app')).render(ReactRuntime.createElement(App))

window.__state = (id) => { const s = clips[id].controller.get(id); const video = document.querySelector('video')
  const root = document.querySelector('[data-clip="' + id + '"]')
  const img = root?.querySelector('img')
  const frame = img?.complete && img.naturalWidth ? /<text [^>]+>([0-9]+)/.exec(decodeURIComponent(img.currentSrc))?.[1] : undefined
  return { status: s.status, time: Number((s.time || 0).toFixed(3)), duration: Number((s.duration || 0).toFixed(3)), index: s.index, kind: s.kind || null, error: s.error || '',
    nativeTime: video?.currentTime, nativeSeeking: video?.seeking, readyState: video?.readyState, nativeBlob: video?.currentSrc.startsWith('blob:'),
    svgLanding: clips[id].svgLanding,
    presentedTime: window.__presentedTime, presentedFrame: frame === undefined ? undefined : Number(frame),
    message: root?.querySelector('.drawai-video-message[role=status]')?.textContent } }
window.__bar = (id) => { const root = document.querySelector('[data-clip="' + id + '"]')
  const el = root && root.querySelector('.drawai-video-chrome-progress,.drawai-video-controls input[type=range]'); if (!el) return null
  const r = el.getBoundingClientRect(); return { value: Number(el.value), max: Number(el.max), disabled: el.disabled, left: r.left, top: r.top, width: r.width, height: r.height } }
window.__center = (id) => { const root = document.querySelector('[data-clip="' + id + '"]'); const b = root && root.querySelector('.drawai-video-play')
  if (!b) return null; const r = b.getBoundingClientRect(); return { left: r.left + r.width / 2, top: r.top + r.height / 2 } }
window.__ctl = (id) => ({ png: () => 0 })
window.__settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
`

const result = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  logOverride: { 'duplicate-object-key': 'silent' },
})
const source = new URL('../docs/media/motion-showcase.mp4', import.meta.url)
const sourceSize = statSync(source).size
const desktopRanges = []
let allowMedia
const mediaAllowed = new Promise((resolve) => { allowMedia = resolve })
const server = createServer(async (req, res) => {
  if (req.url === '/fixture.mp4' || req.url === '/fixture.mp4?desktop') {
    await mediaAllowed
    if (res.destroyed) return
    const desktop = req.url.endsWith('?desktop')
    if (desktop) desktopRanges.push({ range: req.headers.range, destination: req.headers['sec-fetch-dest'] })
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Number(range[2]) : sourceSize - 1
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' }
    if (desktop) delete headers['Content-Length']
    if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + sourceSize
    res.writeHead(range ? 206 : 200, headers)
    const stream = createReadStream(source, { start, end })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<style>' + css + '</style><div id="app"></div><script>' + result.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

let browser
let failures = 0
let checks = 0
function check(condition, label, detail) {
  checks += 1
  if (condition) { console.log('  ✓ ' + label); return true }
  failures += 1
  console.log('  ✗ ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  return false
}

/** 真鼠标事件：和用户手上的点击走同一条路（CDP Input 域）。 */
async function click(page, x, y) {
  const send = (type, extra = {}) => page._client().send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', clickCount: 1 }, extra))
  await send('mouseMoved', { button: 'none' })
  await send('mousePressed')
  await send('mouseReleased')
}
const settle = (page, ms) => page.evaluate((value) => window.__settle(value), ms)
const state = (page, id) => page.evaluate((clip) => window.__state(clip), id)
const bar = (page, id) => page.evaluate((clip) => window.__bar(clip), id)

function scrub(page, box) {
  const send = (type, ratio, down, offsetY = 0) => page._client().send('Input.dispatchMouseEvent', {
    type, x: box.left + box.width * ratio, y: box.top + box.height / 2 + offsetY,
    button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  })
  return {
    async start(ratio) { await send('mouseMoved', ratio, false); await send('mousePressed', ratio, true) },
    move: (ratio) => send('mouseMoved', ratio, true),
    release: (ratio, offsetY) => send('mouseReleased', ratio, false, offsetY),
  }
}

/** 悬停到视频上（露出悬停 chrome），再点进度条 ratio 处。 */
async function clickBar(page, id, ratio) {
  const box = await page.evaluate((clip) => { const root = document.querySelector('[data-clip="' + clip + '"]'); const r = root.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top } }, id)
  await page._client().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' })
  await settle(page, 60)
  const before = await bar(page, id)
  if (!before) throw new Error(id + ' 悬停后没出现进度条')
  const x = before.left + Math.max(1, Math.min(before.width - 1, before.width * ratio))
  await click(page, x, before.top + before.height / 2)
  await settle(page, 150)
  return before
}
async function waitReady(page, id) {
  for (let i = 0; i < 120; i++) {
    const s = await state(page, id)
    if (s.status === 'playing' || s.status === 'paused' || s.status === 'ended' || s.status === 'error') return s
    await settle(page, 50)
  }
  return state(page, id)
}
const near = (value, target, tolerance = 0.6) => Math.abs(value - target) <= tolerance
async function waitFor(read, condition) {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (condition(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('等待浏览器状态超时')
}

try {
  browser = await openBrowser('chrome', { browserExecutable: process.env.DRAWAI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', logLevel: 'error' })
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} })
  await page.setViewport({ width: 960, height: 360, deviceScaleFactor: 1 })
  await page.goto({ url: 'http://127.0.0.1:' + server.address().port, timeout: 30000 })
  await settle(page, 80)

  // ---- 1. 时长已知（导入了源视频的节点）：还没起播就点 70% ----
  const beforeKnown = await clickBar(page, 'rasterclip', 0.7)
  check(beforeKnown.max === DURATION, '时长已知时进度条 max 是真实时长', beforeKnown)
  const afterKnown = await waitFor(() => state(page, 'rasterclip'), (value) => value.svgLanding !== undefined)
  check(afterKnown.status === 'playing', '起播前点进度条会起播', afterKnown)
  check(near(afterKnown.svgLanding, DURATION * 0.7), '起播前点 70% 落在 70% 处，而不是从头开始', afterKnown)
  await settle(page, 400)
  const laterKnown = await state(page, 'rasterclip')
  check(laterKnown.time > afterKnown.time, '落位之后继续往前走，没有被拉回开头', { from: afterKnown.time, to: laterKnown.time })

  // ---- 2. 时长未知（SVG 复刻，文档没写 mediaDuration）：还没起播就点 70% ----
  const beforeUnknown = await clickBar(page, 'svgclip', 0.7)
  check(beforeUnknown.disabled === false, '时长未知时进度条仍然可点', beforeUnknown)
  const afterUnknown = await waitFor(() => state(page, 'svgclip'), (value) => value.svgLanding !== undefined)
  check(afterUnknown.status === 'playing', '时长未知时点进度条会起播', afterUnknown)
  check(near(afterUnknown.svgLanding, DURATION * 0.7), '时长未知时点 70% 也在 70% 处起播，而不是从头开始', afterUnknown)
  check(afterUnknown.index > 0, '画面直接落到目标帧，而不是从第 0 帧开始', { index: afterUnknown.index, time: afterUnknown.time })

  // ---- 3. 播放中点 25% ----
  await clickBar(page, 'svgclip', 0.25)
  const midPlay = await waitFor(() => state(page, 'svgclip'), (value) => value.svgLanding !== afterUnknown.svgLanding)
  check(near(midPlay.svgLanding, DURATION * 0.25), '播放中点 25% 落位', midPlay)
  check(midPlay.status === 'playing', '播放中 seek 不打断播放', midPlay)

  // ---- 4. 暂停中点 80% ----
  const center = await page.evaluate(() => window.__center('svgclip'))
  await click(page, center.left, center.top)
  await settle(page, 150)
  const paused = await state(page, 'svgclip')
  check(paused.status === 'paused', '中央按钮可以暂停', paused)
  await clickBar(page, 'svgclip', 0.8)
  const afterPaused = await state(page, 'svgclip')
  check(near(afterPaused.time, DURATION * 0.8), '暂停中点 80% 落位', { time: afterPaused.time, want: DURATION * 0.8 })
  check(afterPaused.status === 'paused', '暂停中 seek 不会自己播起来', afterPaused)
  const pausedBar = await bar(page, 'svgclip')
  // range 的拇指有宽度，点到的实际值与"像素比例"差半个拇指；断言进度条与暂停位置一致即可。
  check(near(pausedBar.value, afterPaused.time, 0.05), '暂停中进度条停在落位处', { value: pausedBar.value, time: afterPaused.time })

  // 手动跳到终点应停在最后一帧，自然播到终点仍按循环设置处理。
  await click(page, center.left, center.top)
  await clickBar(page, 'svgclip', 0.995)
  const afterEnd = await state(page, 'svgclip')
  check(afterEnd.status === 'ended' && near(afterEnd.time, DURATION, 0.001) && afterEnd.index === FRAMES - 1,
    '播放中点击进度条最右端停在最后一帧', afterEnd)
  await page.goto({ url: 'http://127.0.0.1:' + server.address().port, timeout: 30000 })
  await settle(page, 80)
  await clickBar(page, 'svgclip', 0.995)
  const startAtEnd = await waitReady(page, 'svgclip')
  check(startAtEnd.status === 'ended' && near(startAtEnd.time, DURATION, 0.001) && startAtEnd.index === FRAMES - 1,
    '起播前点击最右端等时长读到后停在最后一帧', startAtEnd)

  const origin = 'http://127.0.0.1:' + server.address().port
  for (let open = 0; open < 2; open += 1) {
    await page.goto({ url: origin + '/?slow', timeout: 30000 })
    await page._client().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 140, button: 'none' })
    const slider = await waitFor(() => bar(page, 'svgclip'), Boolean)
    const drag = scrub(page, slider)
    await drag.start(0.05)
    await drag.move(0.3)
    await settle(page, 100)
    await drag.move(0.74)
    const held = await bar(page, 'svgclip')
    check(held && near(held.value, 0.74, 0.04) && (await state(page, 'svgclip')).status === 'idle',
      '冷加载拖动时滑块跟手且松手前保持原播放状态', held)
    await drag.release(0.74, 20)
    const afterDrag = await waitFor(() => state(page, 'svgclip'), (value) => value.svgLanding !== undefined)
    check(afterDrag.status === 'playing' && near(afterDrag.svgLanding, DURATION * 0.74),
      open ? '重新打开画布后首次拖动仍落在松手位置' : '首次拖动从松手位置起播', afterDrag)
  }

  await page.goto({ url: origin + '/?preview', timeout: 30000 })
  const openPreview = await waitFor(() => page.evaluate(() => {
    const rect = document.getElementById('open-preview')?.getBoundingClientRect()
    return rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }), Boolean)
  await click(page, openPreview.x, openPreview.y)
  const previewBar = await waitFor(() => bar(page, 'sourceclip'), Boolean)
  const previewDrag = scrub(page, previewBar)
  await previewDrag.start(0.05)
  await previewDrag.move(0.32)
  const waiting = await state(page, 'sourceclip')
  check(waiting.readyState === 0, '放大预览在源视频元数据到达前开始拖动', waiting)
  allowMedia()
  const metadata = await waitFor(() => state(page, 'sourceclip'), (value) => value.duration > 0)
  const duringLoad = await bar(page, 'sourceclip')
  check(duringLoad.max === 1 && near(duringLoad.value, 0.32, 0.04), '元数据在拖动中到达时保留滑块刻度和位置', duringLoad)
  await previewDrag.move(0.68)
  await previewDrag.release(0.68)
  const afterPreview = await waitFor(() => state(page, 'sourceclip'), (value) => !value.nativeSeeking && near(value.nativeTime, metadata.duration * 0.68, metadata.duration * 0.025))
  check(afterPreview.status === 'playing', '放大预览松手后源视频继续从目标位置播放', afterPreview)
  const warmDrag = scrub(page, await bar(page, 'sourceclip'))
  await warmDrag.start(0.68)
  await warmDrag.move(0.34)
  await warmDrag.release(0.34)
  const afterWarmDrag = await waitFor(() => state(page, 'sourceclip'), (value) => !value.nativeSeeking && near(value.nativeTime, metadata.duration * 0.34, metadata.duration * 0.025))
  check(afterWarmDrag.status === 'playing', '同一视频加载完成后可继续拖动跳转', afterWarmDrag)

  await page.evaluate(() => {
    const video = document.querySelector('video')
    video.pause()
    const frame = (_now, metadata) => {
      window.__presentedTime = metadata.mediaTime
      video.requestVideoFrameCallback(frame)
    }
    video.requestVideoFrameCallback(frame)
    // MPEG 本身可跳转。临时限制浏览器报告的范围，复现媒体加载事件晚于跳转请求。
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 0 } })
  })
  await waitFor(() => state(page, 'sourceclip'), (value) => value.status === 'paused')
  const deferredDrag = scrub(page, await bar(page, 'sourceclip'))
  await deferredDrag.start(0.34)
  await deferredDrag.move(0.82)
  await deferredDrag.release(0.82)
  const blocked = await state(page, 'sourceclip')
  check(near(blocked.time, metadata.duration * 0.82, metadata.duration * 0.025) && blocked.nativeTime < metadata.duration * 0.55 &&
    blocked.message === '正在定位视频…', '媒体暂不可跳转时保留松手目标并提示正在定位', blocked)
  await page.evaluate(() => {
    const video = document.querySelector('video')
    delete video.seekable
    video.dispatchEvent(new Event('progress'))
  })
  const target = blocked.time
  const decoded = await waitFor(() => state(page, 'sourceclip'), (value) => near(value.presentedTime, target, 0.45))
    .catch(() => state(page, 'sourceclip'))
  check(near(decoded.presentedTime, target, 0.45) && !decoded.nativeSeeking && decoded.status === 'paused' && !decoded.message,
    '收到加载通知后实际呈现目标位置的 MP4 帧并保持暂停', decoded)

  await page.evaluate(async () => {
    const video = document.querySelector('video')
    await video.play()
    const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
    window.__seekAttempts = []
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return currentTime.get.call(video) },
      set(time) {
        const requested = window.__seekAttempts
        requested.push(time)
        // 让真实解码器第一次完成一次错误的跳转并发出 seeked，第二次才接收目标秒数。
        const landed = requested.length === 1 ? Math.max(0, currentTime.get.call(video) - 0.25) : time
        currentTime.set.call(video, landed)
      },
    })
  })
  const verifyDrag = scrub(page, await bar(page, 'sourceclip'))
  await verifyDrag.start(0.82)
  await verifyDrag.move(0.5)
  await verifyDrag.release(0.5)
  const recovered = await waitFor(() => state(page, 'sourceclip'),
    (value) => value.status === 'playing' && !value.message && near(value.presentedTime, metadata.duration * 0.5, 0.35))
    .catch(() => state(page, 'sourceclip'))
  const attempts = await page.evaluate(() => window.__seekAttempts)
  check(recovered.status === 'playing' && !recovered.message && near(recovered.presentedTime, metadata.duration * 0.5, 0.35) &&
    attempts.length === 2 && attempts[0] === attempts[1], '浏览器错报落点后重试同一目标，显示目标帧再继续播放', { ...recovered, attempts })

  await page.goto({ url: origin + '/?slowframes', timeout: 30000 })
  await page._client().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 140, button: 'none' })
  const startSvg = await waitFor(() => page.evaluate(() => window.__center('svgclip')), Boolean)
  await click(page, startSvg.left, startSvg.top)
  await waitFor(() => state(page, 'svgclip'), (value) => value.presentedFrame >= 0)
  await clickBar(page, 'svgclip', 0.72)
  const firstTarget = await state(page, 'svgclip')
  await settle(page, 250)
  const waitingSvg = await state(page, 'svgclip')
  check(near(waitingSvg.time, firstTarget.time, 0.01) && waitingSvg.presentedFrame < waitingSvg.index &&
    waitingSvg.message === '正在定位视频…',
    'SVG 目标帧还没取回时将播放时钟留在拖动位置', waitingSvg)
  await page.evaluate(() => window.__allowSvgFrames())
  const shown = await waitFor(() => state(page, 'svgclip'), (value) => value.presentedFrame >= waitingSvg.index)
    .catch(() => state(page, 'svgclip'))
  check(near(shown.presentedFrame, firstTarget.index, 6) && shown.status === 'playing', 'SVG 目标帧实际显示并从目标位置继续播放', shown)

  for (let open = 0; open < 2; open += 1) {
    const requestStart = desktopRanges.length
    await page.goto({ url: origin + '/?desktop', timeout: 30000 })
    await page._client().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 240, y: 120, button: 'none' })
    const desktopBar = await waitFor(() => bar(page, 'sourceclip'), Boolean)
    const desktopDrag = scrub(page, desktopBar)
    await desktopDrag.start(0.025)
    await desktopDrag.move(0.68)
    await desktopDrag.release(0.68)
    const landed = await waitFor(() => state(page, 'sourceclip'), (value) => value.nativeBlob && value.readyState >= 2 &&
      !value.nativeSeeking && !value.message && near(value.nativeTime, value.duration * 0.68, 0.45))
      .catch(() => state(page, 'sourceclip'))
    const requests = desktopRanges.slice(requestStart)
    check(landed.status === 'playing' && landed.nativeBlob && landed.readyState >= 2 && !landed.nativeSeeking &&
      !landed.message && near(landed.nativeTime, landed.duration * 0.68, 0.45) &&
      requests.length === 2 && requests[0].range === 'bytes=0-0' &&
      requests[1].range === 'bytes=0-' + (sourceSize - 1) && requests.every((request) => request.destination !== 'video'),
    open ? '桌面重新打开画布后首次拖动仍从目标帧起播' : '桌面代理省略长度时，首个画布定位用本地媒体地址完成',
    { landed, requests })
  }

  console.log('\ncheck-video-progress-ui: ' + (failures ? failures + ' 项不通过 / ' + checks : 'OK（' + checks + ' 项）'))
} finally {
  allowMedia()
  await browser?.close({ silent: true })
  await new Promise((resolve) => server.close(resolve))
}
if (failures) process.exitCode = 1
