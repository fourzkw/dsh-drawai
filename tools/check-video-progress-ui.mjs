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
`

// 海报占位：真机上 poster 是 SVG 片段，这里给一张 1x1 的，免得浏览器抱怨空 src。
const POSTER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#000"/></svg>')

const entry = `
import ReactRuntime from 'react'
import { createRoot } from 'react-dom/client'
import { createVideoController, VideoSurface } from './src/video-player.js'
globalThis.React = ReactRuntime

const FPS = ${FPS}
const request = () => (action, extra) => {
  if (action === 'media-manifest') return Promise.resolve({ hasSource: false, manifest: {
    version: 1, kind: 'svg', fps: FPS, width: 960, height: 540, source: null, sourceOffset: 0, duration: ${DURATION},
    frames: Array.from({ length: ${FRAMES} }, (_, i) => ({ file: 'frames/' + String(i + 1).padStart(4, '0') + '.svg', t: i / FPS })),
  } })
  if (action === 'media-frame') return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 54"><rect width="96" height="54" fill="#0b0b0b"/><text x="10" y="34" fill="#fff" font-size="22" font-family="monospace">' + extra.index + '</text></svg>' })
  return Promise.reject(new Error('unexpected ' + action))
}
// 两个 clip 对应画布上两种真实数据：
//   'svgclip'  = SVG 复刻，文档里没有 mediaDuration（宣传片.drawai 就是这样）
//   'rasterclip' = 导入的源视频，导入时写了 mediaDuration
const clips = {
  svgclip: { id: 'svgclip', meta: { clip: 'svgclip', kind: 'svg', fps: FPS, duration: 0, posterFrame: 0 } },
  rasterclip: { id: 'rasterclip', meta: { clip: 'rasterclip', kind: 'svg', fps: FPS, duration: ${DURATION}, posterFrame: 0 } },
}
for (const clip of Object.values(clips)) { clip.controller = createVideoController(request()) }
const surface = (clip) => ReactRuntime.createElement(VideoSurface, {
  controller: clip.controller, node: { id: clip.id, data: { drawaiMedia: '1', mediaClip: clip.id } },
  meta: clip.meta, poster: ${JSON.stringify(POSTER)},
})
function App() {
  return ReactRuntime.createElement('div', { style: { display: 'flex', gap: 20, padding: 20 } },
    ReactRuntime.createElement('div', { 'data-clip': 'svgclip', style: { width: 420, height: 236 } }, surface(clips.svgclip)),
    ReactRuntime.createElement('div', { 'data-clip': 'rasterclip', style: { width: 420, height: 236 } }, surface(clips.rasterclip)))
}
createRoot(document.getElementById('app')).render(ReactRuntime.createElement(App))

window.__state = (id) => { const s = clips[id].controller.get(id)
  return { status: s.status, time: Number((s.time || 0).toFixed(3)), duration: Number((s.duration || 0).toFixed(3)), index: s.index, kind: s.kind || null, error: s.error || '' } }
window.__bar = (id) => { const root = document.querySelector('[data-clip="' + id + '"]')
  const el = root && root.querySelector('.drawai-video-chrome-progress'); if (!el) return null
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
const server = createServer((_req, res) => {
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

try {
  browser = await openBrowser('chrome', { browserExecutable: process.env.DRAWAI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', logLevel: 'error' })
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} })
  await page.setViewport({ width: 960, height: 360, deviceScaleFactor: 1 })
  await page.goto({ url: 'http://127.0.0.1:' + server.address().port, timeout: 30000 })
  await settle(page, 80)

  // ---- 1. 时长已知（导入了源视频的节点）：还没起播就点 70% ----
  const beforeKnown = await clickBar(page, 'rasterclip', 0.7)
  check(beforeKnown.max === DURATION, '时长已知时进度条 max 是真实时长', beforeKnown)
  const afterKnown = await waitReady(page, 'rasterclip')
  check(afterKnown.status === 'playing', '起播前点进度条会起播', afterKnown)
  check(near(afterKnown.time, DURATION * 0.7), '起播前点 70% 落在 70% 处，而不是从头开始', { time: afterKnown.time, want: DURATION * 0.7 })
  await settle(page, 400)
  const laterKnown = await state(page, 'rasterclip')
  check(laterKnown.time > afterKnown.time, '落位之后继续往前走，没有被拉回开头', { from: afterKnown.time, to: laterKnown.time })

  // ---- 2. 时长未知（SVG 复刻，文档没写 mediaDuration）：还没起播就点 70% ----
  const beforeUnknown = await clickBar(page, 'svgclip', 0.7)
  check(beforeUnknown.disabled === false, '时长未知时进度条仍然可点', beforeUnknown)
  const afterUnknown = await waitReady(page, 'svgclip')
  check(afterUnknown.status === 'playing', '时长未知时点进度条会起播', afterUnknown)
  check(near(afterUnknown.time, DURATION * 0.7), '时长未知时点 70% 也在 70% 处起播，而不是从头开始', { time: afterUnknown.time, want: DURATION * 0.7 })
  check(afterUnknown.index > 0, '画面直接落到目标帧，而不是从第 0 帧开始', { index: afterUnknown.index, time: afterUnknown.time })

  // ---- 3. 播放中点 25% ----
  await clickBar(page, 'svgclip', 0.25)
  const midPlay = await state(page, 'svgclip')
  check(near(midPlay.time, DURATION * 0.25), '播放中点 25% 落位', { time: midPlay.time, want: DURATION * 0.25 })
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

  console.log('\ncheck-video-progress-ui: ' + (failures ? failures + ' 项不通过 / ' + checks : 'OK（' + checks + ' 项）'))
} finally {
  await browser?.close({ silent: true })
  await new Promise((resolve) => server.close(resolve))
}
if (failures) process.exitCode = 1
