import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createVideoController } from '../src/video-player.js'
import { composeClientBody } from './build.mjs'

const node = (id, kind = 'svg') => ({ id, data: { drawaiMedia: '1', mediaClip: id, mediaKind: kind } })
const meta = (id, kind = 'svg') => ({ clip: id, kind, fps: 10 })
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
function harness(request, environment = {}) {
  let time = 0
  let next = 0
  const callbacks = new Map()
  const revoked = []
  const calls = []
  const controller = createVideoController(async (action, body) => {
    calls.push([action, body.clip])
    if (request) return request(action, body)
    if (action === 'media-manifest') return { manifest: { frames: Array(10).fill({}), fps: 10 } }
    return { svg }
  }, {
    raf: (fn) => { const id = ++next; callbacks.set(id, fn); return id },
    caf: (id) => callbacks.delete(id), now: () => time,
    makeUrl: () => 'blob:test-' + (++next), revoke: (url) => revoked.push(url),
    ...environment,
  })
  return { controller, revoked, calls, callbacks,
    advance(ms) { time += ms; const pending = Array.from(callbacks.values()); callbacks.clear(); pending.forEach((fn) => fn(time)) },
  }
}
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1; console.log('  ✓ ' + message) }

{
  const audio = { currentTime: 0, readyState: 2, paused: true, src: '', play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true }, removeAttribute() { this.src = '' }, load() {} }
  const h = harness((action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: Array(10).fill({}), fps: 10, sourceOffset: 2 } }
    : action === 'media-source-url' ? { url: '/video/test', mime: 'video/mp4' } : { svg }, { createAudio: () => audio })
  const c = h.controller
  await c.play(node('sound'), meta('sound'))
  check(audio.currentTime === 2 && !audio.paused && audio.muted === false, 'SVG audio starts at the selected source segment with sound enabled')
  audio.currentTime = 2.45; h.advance(900)
  check(c.get('sound').index === 4, 'SVG frames follow the audio clock instead of drifting with rendering time')
  c.pause('sound')
  check(audio.paused && Math.abs(c.get('sound').time - 0.45) < 0.001, 'pausing stops audio and preserves the segment position')
  c.seek('sound', 0.7)
  check(audio.currentTime === 2.7, 'seeking includes the source segment offset')
  c.configure('sound', { muted: true })
  check(audio.muted === true, 'SVG audio can be muted without changing the document')
  await c.play(node('sound'), meta('sound'))
  audio.currentTime = 3.05; h.advance(50)
  check(Math.abs(audio.currentTime - 2.05) < 0.001 && c.get('sound').index === 0, 'looping returns audio to the selected segment instead of the whole source')
  c.configure('sound', { loop: false })
  audio.currentTime = 3.01; h.advance(50)
  check(audio.paused && c.get('sound').status === 'ended', 'non-looping SVG playback stops audio at the segment end')
  c.reset()
  check(audio.paused && audio.src === '' && h.revoked.length === 1, 'reset releases the owned audio element and blob URL')
}
{
  let availableEnd = 2.2
  const audio = { currentTime: 0, readyState: 2, paused: true,
    seekable: { length: 1, start: () => 0, end: () => availableEnd },
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true }, removeAttribute() {}, load() {} }
  const h = harness((action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: Array(10).fill({}), fps: 10, sourceOffset: 2 } }
    : action === 'media-source-url' ? { url: '/video/test' } : { svg }, { createAudio: () => audio })
  await h.controller.play(node('buffered-audio'), meta('buffered-audio'))
  h.controller.seek('buffered-audio', 0.6)
  h.advance(100)
  check(audio.paused && audio.currentTime === 2 && h.controller.get('buffered-audio').index === 7,
    'a temporarily unavailable audio seek does not drag the SVG playback clock back to the start')
  availableEnd = 3
  audio.onprogress()
  check(!audio.paused && Math.abs(audio.currentTime - 2.7) < 0.001,
    'SVG audio joins the current playback position once the target range is available')
  h.controller.reset()
}
{
  // 音频时钟略早于 sourceOffset 时，旧逻辑会 floor 出负帧号，错误文案变成「第 0/-n 帧」。
  const audio = { currentTime: 0, readyState: 2, paused: true, src: '', play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true }, removeAttribute() { this.src = '' }, load() {} }
  const requested = []
  const h = harness((action, body) => {
    if (action === 'media-manifest') return { hasSource: true, manifest: { frames: Array(80).fill({}), fps: 10, sourceOffset: 2 } }
    if (action === 'media-source-url') return { url: '/video/test', mime: 'video/mp4' }
    if (action === 'media-frame') {
      requested.push(body.index)
      return body.index < 0 || body.index >= 80 ? null : { svg }
    }
    return { svg }
  }, { createAudio: () => audio })
  const c = h.controller
  await c.play(node('clamp'), meta('clamp'))
  audio.currentTime = 1.999
  h.advance(16)
  check(c.get('clamp').status === 'playing' && c.get('clamp').index === 0, 'audio slightly before sourceOffset clamps to frame 0 instead of failing')
  check(!requested.some((index) => index < 0), 'SVG prefetch never requests negative frame indices')
  check(!String(c.get('clamp').error || '').match(/第\s*0\s*帧|第\s*-\d+\s*帧/), 'clamped playback does not report frame 0 or negative frame read errors')
  c.seek('clamp', -1)
  check(c.get('clamp').time === 0 && c.get('clamp').index === 0, 'seeking below zero clamps both time and frame index')
  c.reset()
}

console.log('Video playback controller')
{
  const h = harness((action) => action === 'media-manifest' ? { manifest: { frames: Array(3600).fill({}), fps: 29.97 } } : { svg })
  const c = h.controller
  await c.play(node('long'), meta('long'))
  check(h.calls.length <= 13, 'long SVG sequences start after loading a small window instead of all frames')
  check(c.get('long').frames.length === 3600 && c.get('long').fps === 29.97, 'custom fractional fps and complete frame count are preserved')
  const settle = async () => { while (c.get('long').cache?.loading) await c.get('long').cache.loading }
  for (let index = 100; index < 600; index += 100) {
    c.seek('long', index / 29.97)
    await settle()
    check(!!c.get('long').frames[c.get('long').index], 'seeking a long sequence loads the requested frame')
    check(c.get('long').cache.entries.size <= 48, 'SVG frame content cache remains bounded across distant seeks')
  }
  check(c.poster('long') === svg, 'cover capture uses the loaded frame in a long sequence')
  c.reset()
  check(c.get('long').status === 'idle', 'reset releases a long sequence and its frame cache')
}
{
  const h = harness()
  const c = h.controller
  const playedNode = node('a')
  const before = JSON.stringify(playedNode)
  await c.play(playedNode, meta('a'))
  h.advance(450)
  check(c.get('a').index === 4, 'SVG uses elapsed time and skips late frames')
  c.pause('a')
  const position = c.get('a').time
  h.advance(2000)
  check(c.get('a').time === position && !h.callbacks.size, 'pause retains the current frame and stops animation')
  const reads = h.calls.length
  await c.play(node('a'), meta('a'))
  h.advance(100)
  check(c.get('a').index === 5 && h.calls.length === reads, 'resume keeps position and reuses loaded frames')
  c.step('a', -1)
  check(c.get('a').status === 'paused' && c.get('a').index === 4, 'frame stepping pauses the selected SVG sequence')
  c.seek('a', -1)
  c.step('a', -1)
  check(c.get('a').index === 0, 'previous frame clamps at the beginning')
  c.seek('a', 0.95)
  c.configure('a', { loop: false })
  await c.play(node('a'), meta('a'))
  h.advance(200)
  check(c.get('a').status === 'ended' && c.get('a').index === 9 && !h.callbacks.size, 'non-looping playback ends on the last frame')
  await c.play(node('a'), meta('a'))
  check(c.get('a').time === 0, 'playing after the end restarts at the beginning')
  c.configure('a', { loop: true })
  h.advance(1250)
  check(c.get('a').index === 2, 'looping playback preserves elapsed-time remainder')
  c.configure('a', { loop: false })
  h.advance(100)
  check(c.get('a').status === 'playing' && c.get('a').index === 3, 'disabling loop continues from the current cycle')
  await c.play(node('b'), meta('b'))
  check(c.get('a').status === 'paused' && c.get('b').status === 'playing', 'switching nodes pauses the old node')
  c.step('a', 1)
  check(c.get('b').status === 'playing', 'stepping another node cannot pause or seek the active video')
  h.advance(100)
  check(c.get('b').index === 1, 'stepping an inactive node cannot alter the active playback clock')
  c.stop('b')
  check(c.get('b').time === 0 && c.get('b').status === 'paused', 'stop resets position independently of pause')
  check(c.poster('a') === svg, 'SVG cover capture returns the selected frame markup')
  check(c.still('a').kind === 'svg' && c.still('a').markup === svg, 'SVG still returns the current frame markup for an image node')
  check(JSON.stringify(playedNode) === before, 'playback does not change document data')
  c.reset()
  check(!h.callbacks.size && c.get('a').status === 'idle', 'reset releases playback state and animation')
}
{
  const h = harness(async (action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: [] } } : { base64: 'AA==' })
  const c = h.controller
  await c.play(node('r', 'raster'), meta('r', 'raster'))
  let plays = 0
  let pauses = 0
  const video = { currentTime: 0, duration: 5, readyState: 2, play: () => { plays += 1; return Promise.resolve() }, pause: () => { pauses += 1 } }
  c.attach('r', video)
  check(video.muted === false, 'source video playback enables sound by default')
  c.configure('r', { muted: true })
  check(video.muted === true, 'source video supports muting')
  c.mediaEvent('r', video, 'loadedmetadata')
  video.currentTime = 2.3
  c.mediaEvent('r', video, 'timeupdate')
  video.currentTime = 2.35
  const url = c.get('r').url
  c.pause('r')
  check(c.get('r').time === 2.35 && !h.revoked.length && pauses === 1, 'raster pause captures exact position between timeupdate events')
  check(c.get('r').duration === 5, 'attaching a video with loaded metadata initializes its duration')
  await c.play(node('r', 'raster'), meta('r', 'raster'))
  check(c.get('r').url === url && plays === 2 && h.calls.length === 2, 'raster resume reuses the original source')
  c.configure('r', { loop: false, fit: 'cover', expanded: true })
  check(video.loop === false && c.get('r').fit === 'cover', 'loop and display fit can be changed during playback')
  c.detach('r', video)
  const largeVideo = { ...video, currentTime: 0 }
  c.attach('r', largeVideo)
  c.detach('r', video)
  check(largeVideo.currentTime === 2.35 && c.get('r').status === 'playing', 'moving into the preview preserves position and ignores stale detach')
  c.seek('r', 3)
  check(largeVideo.currentTime === 3, 'seeking controls the currently attached preview element')
  // React may attach the incoming surface before cleaning up the outgoing one.
  // A fresh browser video has no metadata and emits zero-time events on startup.
  largeVideo.currentTime = 3.25
  const inlineVideo = { ...video, currentTime: 0, readyState: 0 }
  const playsBeforeTransfer = plays
  c.configure('r', { expanded: false })
  c.attach('r', inlineVideo)
  c.mediaEvent('r', inlineVideo, 'timeupdate')
  c.mediaEvent('r', inlineVideo, 'pause')
  c.detach('r', largeVideo)
  check(c.get('r').time === 3.25 && c.get('r').status === 'playing' && plays === playsBeforeTransfer,
    'leaving preview captures the latest position and waits for metadata without accepting startup events')
  inlineVideo.readyState = 1
  c.mediaEvent('r', inlineVideo, 'loadedmetadata')
  check(inlineVideo.currentTime === 3.25 && plays === playsBeforeTransfer + 1,
    'inline playback restores position before resuming after metadata loads')
  inlineVideo.currentTime = 3.5
  c.pause('r')
  c.configure('r', { expanded: true })
  c.detach('r', inlineVideo)
  const pausedPreview = { ...video, currentTime: 0, readyState: 0 }
  c.attach('r', pausedPreview)
  c.mediaEvent('r', pausedPreview, 'play')
  pausedPreview.readyState = 1
  const playsBeforeMetadata = plays
  c.mediaEvent('r', pausedPreview, 'loadedmetadata')
  check(pausedPreview.currentTime === 3.5 && c.get('r').status === 'paused' && plays === playsBeforeMetadata,
    'entering preview while paused restores position without autoplay')
  await c.play(node('r', 'raster'), meta('r', 'raster'))
  c.detach('r', pausedPreview)
  c.attach('r', largeVideo)
  largeVideo.videoWidth = 16
  largeVideo.videoHeight = 9
  const previousDocument = globalThis.document
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,QQ==' }) }
  const shot = c.still('r')
  globalThis.document = previousDocument
  check(shot.kind === 'raster' && shot.png.startsWith('data:image/png'), 'raster still exports the current decoded frame as a PNG')
  c.suspend()
  check(c.get('r').status === 'paused' && !c.expanded(), 'hidden canvas pauses playback and closes preview')
  c.prune([])
  check(h.revoked.length === 1 && c.get('r').status === 'idle', 'deleting a node revokes its source URL')
  c.mediaEvent('r', largeVideo, 'timeupdate')
  check(c.get('r').status === 'idle', 'detached media events cannot resurrect a deleted node')
}
{
  let finish
  const h = harness(async (action, body) => {
    if (body.clip === 'slow') return new Promise((resolve) => { finish = resolve })
    return action === 'media-manifest' ? { manifest: { frames: [{}], fps: 10 } } : { svg }
  })
  const c = h.controller
  const pending = c.play(node('slow'), meta('slow'))
  await c.play(node('fast'), meta('fast'))
  finish({ hasSource: true, manifest: { frames: [] } })
  await pending
  check(c.get('fast').status === 'playing' && c.get('slow').status === 'idle', 'late loading response cannot replace a newer video')
  check(!h.calls.some(([action, clip]) => clip === 'slow' && action === 'media-source-url'), 'cancelled loads do not fetch or allocate stale source data')
  c.reset()
}
{
  let finish
  const h = harness(() => new Promise((resolve) => { finish = resolve }))
  const c = h.controller
  const pending = c.play(node('removed'), meta('removed'))
  c.prune([])
  finish({ manifest: { frames: [{}] } })
  await pending
  check(c.get('removed').status === 'idle' && !h.callbacks.size, 'deleting while loading cancels the pending playback')
}
{
  let failing = true
  const h = harness(async (action) => action === 'media-manifest' ? { manifest: { frames: [{}] } } : failing ? null : { svg })
  await h.controller.play(node('retry'), meta('retry'))
  check(h.controller.get('retry').status === 'error' && h.controller.get('retry').error.includes('1'), 'frame failures produce a local retryable error')
  failing = false
  await h.controller.play(node('retry'), meta('retry'))
  check(h.controller.get('retry').status === 'playing', 'retry replaces the failed load with valid playback')
  h.controller.prune([node('retry', 'raster')])
  check(h.controller.get('retry').status === 'idle', 'changing a node media kind invalidates its cached playback')
}
{
  const source = readFileSync(new URL('../src/video-player.js', import.meta.url), 'utf8').replace(/^export \{[^\n]+\}\s*$/m, '')
  let hovered = false
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Component: class {},
    // hover 用 useState(false) 保持；snapshot 的函数初值每次重读 controller。
    useState: (init) => {
      if (init === false) return [hovered, (value) => { hovered = typeof value === 'function' ? value(hovered) : value }]
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const renderSurface = (props) => new Function('React', source + '\nreturn VideoSurface')(React)(props)
  const { VideoControls } = new Function('React', source + '\nreturn { VideoControls }')(React)
  const h = harness()
  const props = { controller: h.controller, node: node('ui'), meta: meta('ui'), poster: 'data:image/svg+xml,' }
  const flatten = (value) => !value ? [] : Array.isArray(value) ? value.flatMap(flatten) : typeof value !== 'object' ? [] : [value, ...flatten(value.children)]
  let controls = flatten(VideoControls(props))
  check(controls.find((n) => n.props.title === '上一帧').props.disabled, 'frame controls are disabled until media is loaded')
  let surface = flatten(renderSurface(props))
  const surfaceRoot = surface.find((n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('drawai-video-surface'))
  check(typeof surfaceRoot.props.onPointerEnter === 'function' && typeof surfaceRoot.props.onPointerLeave === 'function', 'video surface tracks pointer hover for chrome controls')
  check(!surface.some((n) => n.type === 'button' && n.props.className === 'drawai-video-play'), 'centered play button stays hidden until the pointer enters the node')
  check(!surface.some((n) => n.props && n.props.className === 'drawai-video-chrome'), 'hover chrome stays hidden until the pointer enters the node')
  surfaceRoot.props.onPointerEnter()
  surface = flatten(renderSurface(props))
  check(surface.some((n) => n.type === 'button' && n.props.className === 'drawai-video-play' && n.props['aria-label'] === '播放视频'), 'hovering a video node reveals the centered play button')
  check(surface.some((n) => n.props && n.props.className === 'drawai-video-chrome'), 'hovering a video node reveals the progress chrome')
  check(surface.some((n) => n.type === 'button' && (n.props['aria-label'] === '播放' || n.props['aria-label'] === '暂停')) && surface.some((n) => n.props && n.props['aria-label'] === '播放进度'), 'hover chrome exposes play/pause and a scrubber')
  surface.find((n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('drawai-video-surface')).props.onPointerLeave()
  surface = flatten(renderSurface(props))
  check(!surface.some((n) => n.type === 'button' && n.props.className === 'drawai-video-play') && !surface.some((n) => n.props && n.props.className === 'drawai-video-chrome'), 'leaving the node hides the centered button and hover chrome')
  await h.controller.play(props.node, props.meta)
  surface = flatten(renderSurface(props))
  check(!surface.some((n) => n.type === 'button' && n.props.className === 'drawai-video-play'), 'centered pause button stays hidden while playing without hover')
  surface.find((n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('drawai-video-surface')).props.onPointerEnter()
  surface = flatten(renderSurface(props))
  check(surface.some((n) => n.type === 'button' && n.props.className === 'drawai-video-play' && n.props['aria-label'] === '暂停视频'), 'hovering a playing video node reveals the centered pause button')
  controls = flatten(VideoControls(props))
  check(!controls.find((n) => n.props.title === '上一帧').props.disabled, 'SVG frame controls become available after loading')
  check(controls.some((n) => n.props['aria-label'] === '播放进度') && controls.some((n) => n.props['aria-label'] === '画面适配'), 'dedicated toolbar exposes timeline and fit controls')
  let drawn = 0, exportedVideo = 0
  const actions = [
    { label: '绘制复刻…', primary: true, mediaKind: 'raster', disabled: () => false, run() { drawn++ } },
    { label: '导出 SVG 视频', export: true, mediaKind: 'svg', disabled: () => false, run() { exportedVideo++ } },
    { label: '导出 WebM', export: true, mediaKind: 'svg', disabled: () => false, run() {} },
    { label: '导出 MP4', export: true, disabled: () => false, run() {} },
    { label: '导出 GIF', export: true, disabled: () => false, run() {} },
    { label: '导出源视频', export: true, mediaKind: 'raster', disabled: () => false, run() { exportedVideo++ } },
  ]
  const compactRaster = flatten(VideoControls({ ...props, compact: true, meta: meta('ui', 'raster'), actions, onError(error) { throw error } }))
  check(!compactRaster.some((n) => n.props.title === '播放 / 暂停' || n.props.title === '停止并回到开头' || n.props['aria-label'] === '播放进度' || n.props['aria-label'] === '画面适配' || n.type === 'input'), 'floating video toolbar excludes playback, stop, timeline and fit controls')
  check(compactRaster.some((n) => n.children.includes('绘制复刻')) && compactRaster.some((n) => n.children.includes('预览')), 'floating toolbar exposes draw and preview directly')
  let grabbed = 0
  const withGrab = flatten(VideoControls({ ...props, compact: true, meta: meta('ui', 'raster'), actions: actions.concat([{ label: '抽帧', grab: true, disabled: () => false, run() { grabbed += 1 } }]), onError(error) { throw error } }))
  check(withGrab.some((n) => n.type === 'button' && n.props['aria-label'] === '抽帧') && withGrab.some((n) => n.children.includes('抽帧')), 'floating toolbar exposes grab-frame as its own button')
  await withGrab.find((n) => n.type === 'button' && n.props['aria-label'] === '抽帧').props.onClick()
  check(grabbed === 1, 'grab-frame button runs the still-to-image action')
  check(compactRaster.some((n) => n.children.includes('导出源视频')) && !compactRaster.some((n) => n.children.includes('导出 SVG 视频')), 'raster export menu only shows relevant actions')
  check(compactRaster.some((n) => n.children.includes('导出 MP4')), 'raster videos expose MP4 export')
  check(compactRaster.some((n) => n.children.includes('导出 GIF')), 'raster videos expose GIF export')
  await compactRaster.find((n) => n.type === 'button' && n.props['aria-label'] === '绘制复刻').props.onClick()
  check(drawn === 1, 'compact primary action invokes the existing drawing workflow')
  const compactSvg = flatten(VideoControls({ ...props, compact: true, actions, onError(error) { throw error } }))
  check(compactSvg.some((n) => n.children.includes('导出 MP4')), 'SVG videos expose MP4 export')
  check(compactSvg.some((n) => n.children.includes('导出 GIF')), 'SVG videos expose GIF export')
  check(!compactSvg.some((n) => n.children.includes('绘制复刻')) && compactSvg.some((n) => n.children.includes('导出 SVG 视频')) && compactSvg.some((n) => n.children.includes('导出 WebM')) && !compactSvg.some((n) => n.children.includes('导出源视频')), 'SVG toolbar hides unsupported drawing and source export actions')
  let closed = false
  await compactSvg.find((n) => n.type === 'button' && n.children.includes('导出 SVG 视频')).props.onClick({ currentTarget: { closest() { return { set open(value) { closed = value === false } } } } })
  await Promise.resolve()
  check(closed && exportedVideo === 1, 'compact export invokes the action and closes its menu')
  check(flatten(renderSurface(props)).find((n) => n.type === 'img').props.style.objectFit === 'contain', 'video defaults to aspect-preserving display')
  const module = { exports: {} }
  const integrated = new Function('require', 'module', 'exports', composeClientBody() + '\nreturn { renderDiagram, canvasOwnsKeyboard }')(() => React, module, module.exports)
  const fixture = { nodes: [{ ...props.node, x: 0, y: 0, w: 320, h: 180, label: '' }], edges: [] }
  const interactive = integrated.renderDiagram(fixture, 'light', 'video-test', { current: null }, { videoController: h.controller }, null)
  check(flatten(interactive).some((n) => n.type === 'foreignObject' && n.props.width === 320), 'interactive canvas includes a video surface at node geometry')
  const exported = integrated.renderDiagram(fixture, 'light', 'video-export', { current: null }, { showGrid: false }, null)
  check(!flatten(exported).some((n) => n.type === 'foreignObject'), 'SVG export keeps the persisted poster and excludes player controls')
  const controlTarget = { closest: (sel) => sel.includes('drawai-video-chrome') ? {} : null }
  check(!integrated.canvasOwnsKeyboard({ target: controlTarget }, null, null), 'media control keyboard input cannot trigger canvas shortcuts')
  check(composeClientBody().includes('drawai-video-chrome'), 'client styles include hover chrome for video nodes')
  check(composeClientBody().includes('function placeVideoStill') && composeClientBody().includes('grabVideoStill'), 'client places a grabbed video frame as an image node')
  h.controller.reset()
}
// A tiny renderer for VideoSurface: the fake React above keeps the hover flag in a closure,
// which is what lets the chrome be inspected outside that block.
function surfaceHarness(controller) {
  const source = readFileSync(new URL('../src/video-player.js', import.meta.url), 'utf8').replace(/^export \{[^\n]+\}\s*$/m, '')
  let hovered = false
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      if (init === false) return [hovered, (value) => { hovered = typeof value === 'function' ? value(hovered) : value }]
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const VideoSurface = new Function('React', source + '\nreturn VideoSurface')(React)
  const flat = (value) => !value ? [] : Array.isArray(value) ? value.flatMap(flat) : typeof value !== 'object' ? [] : [value, ...flat(value.children)]
  return {
    enter() { hovered = true },
    bar(props) {
      const tree = flat(VideoSurface(props))
      return tree.find((n) => n.props && n.props.className === 'drawai-video-chrome-progress')
    },
  }
}
{
  // Regression: a released session must not reset the clock to 0. On the canvas a released
  // session means a brand new <video> (new ticket URL), which alone would play from 0 -- that
  // is what "drag the progress bar and the video reloads at the start" looked like.
  const h = harness(async (action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: [] } } : { base64: 'AA==' })
  const c = h.controller
  await c.play(node('keep', 'raster'), meta('keep', 'raster'))
  const first = { currentTime: 0, duration: 40, readyState: 2, play: () => Promise.resolve(), pause() {} }
  c.attach('keep', first)
  c.mediaEvent('keep', first, 'loadedmetadata')
  c.seek('keep', 12.5)
  check(c.get('keep').time === 12.5 && first.currentTime === 12.5, 'seeking a raster clip moves the element and the clock')
  // Data change (mediaClip edited away and back) releases the session in between.
  c.prune([{ id: 'keep', data: { drawaiMedia: '1', mediaClip: 'other', mediaKind: 'raster' } }])
  check(c.get('keep').status === 'idle', 'prune releases a session whose node data no longer matches')
  await c.play(node('keep', 'raster'), meta('keep', 'raster'))
  check(c.get('keep').time === 12.5, 'replaying a released clip resumes from its last position instead of 0')
  const second = { currentTime: 0, duration: 40, readyState: 1, play: () => Promise.resolve(), pause() {} }
  c.attach('keep', second)
  c.mediaEvent('keep', second, 'loadedmetadata')
  check(second.currentTime === 12.5, 'the rebuilt video element is positioned at the remembered time')
  // A different clip must start at 0 even though it shares the controller.
  await c.play(node('fresh', 'raster'), meta('fresh', 'raster'))
  check(c.get('fresh').time === 0, 'a different clip is not seeded with another clip position')
  // Stop is an explicit "back to the beginning".
  c.seek('keep', 20)
  c.stop('keep')
  check(c.get('keep').time === 0, 'stop returns to the beginning')
  await c.play(node('keep', 'raster'), meta('keep', 'raster'))
  check(c.get('keep').time === 0, 'a stopped clip starts from the beginning again')
  // Ending clears the memory: the documented contract is "play again starts over".
  const third = { currentTime: 39.9, duration: 40, readyState: 2, play: () => Promise.resolve(), pause() {} }
  c.attach('keep', third)
  c.mediaEvent('keep', third, 'loadedmetadata')
  c.mediaEvent('keep', third, 'ended')
  c.reset()
  await c.play(node('keep', 'raster'), meta('keep', 'raster'))
  check(c.get('keep').time === 0, 'a finished clip starts from the beginning next time')
  c.reset()
}
{
  // Regression: without a known duration the hover bar used to be disabled (max=0), so a click
  // was swallowed — and `min=max=0` makes a range input produce no value change at all, so not
  // even onChange fired. The bar now falls back to a 0..1 placeholder span and the click is
  // remembered as a ratio, applied once the duration arrives (it must never restart at 0).
  const h = harness(async (action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: [] } } : { base64: 'AA==' })
  const c = h.controller
  const ui = surfaceHarness(c)
  ui.enter()
  const props = { controller: c, node: node('idle', 'raster'), meta: meta('idle', 'raster'), poster: '', onPlay: () => {} }
  const bar = ui.bar(props)
  check(bar !== undefined, 'hover chrome renders a progress bar')
  check(bar.props.disabled === false, 'progress bar stays clickable before the first play')
  check(bar.props.max === 1 && bar.props.value === 0, 'unknown duration paints a placeholder span instead of collapsing to 0')
  bar.props.onChange({ target: { value: '0' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(c.get('idle').status === 'playing', 'clicking the bar starts playback to obtain the duration')
  check(c.get('idle').time === 0, 'the startup click does not seek to 0 on a live element')
  // Once the duration is known the same click must land on the requested position.
  const el = { currentTime: 0, duration: 8, readyState: 2, play: () => Promise.resolve(), pause() {} }
  c.attach('idle', el)
  c.mediaEvent('idle', el, 'loadedmetadata')
  const bar2 = ui.bar(props)
  check(bar2 !== undefined && bar2.props.max === 8, 'the bar picks up the measured duration')
  bar2.props.onChange({ target: { value: '6' } })
  check(c.get('idle').time === 6 && el.currentTime === 6, 'clicking the bar with a known duration seeks there')
  c.reset()
}
{
  // The reported bug: clicking the bar before playback started threw the position away and
  // started from 0 — it looked like "clicking the progress bar restarts the video".
  const h = harness(async (action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: [] } } : { base64: 'AA==' })
  const c = h.controller
  const ui = surfaceHarness(c)
  ui.enter()
  const props = { controller: c, node: node('lazy', 'raster'), meta: meta('lazy', 'raster'), poster: '', onPlay: () => {} }
  // No duration anywhere yet: the click is a ratio on the placeholder span.
  c.seekRatio('lazy', 0.75)
  await c.play(node('lazy', 'raster'), meta('lazy', 'raster'))
  check(c.get('lazy').status === 'playing', 'a click before playback still starts the clip')
  const lazyEl = { currentTime: 0, duration: 12, readyState: 2, play: () => Promise.resolve(), pause() {} }
  c.attach('lazy', lazyEl)
  c.mediaEvent('lazy', lazyEl, 'loadedmetadata')
  check(Math.abs(c.get('lazy').time - 9) < 1e-6 && Math.abs(lazyEl.currentTime - 9) < 1e-6,
    'a click made before the duration was known lands on the clicked position once metadata arrives')
  c.reset()
}
{
  // seekRatio on an already-seekable session must seek immediately (no pending state left).
  const h = harness(async (action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: [] } } : { base64: 'AA==' })
  const c = h.controller
  await c.play(node('ratio', 'raster'), meta('ratio', 'raster'))
  const ratioEl = { currentTime: 0, duration: 10.006, readyState: 2, paused: true,
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true } }
  c.attach('ratio', ratioEl)
  c.mediaEvent('ratio', ratioEl, 'loadedmetadata')
  c.seekRatio('ratio', 0.4)
  check(c.get('ratio').time === ratioEl.duration * 0.4 && ratioEl.currentTime === ratioEl.duration * 0.4,
    'seekRatio seeks at once when the duration is known')
  const ui = surfaceHarness(c)
  ui.enter()
  const bar = ui.bar({ controller: c, node: node('ratio', 'raster'), meta: meta('ratio', 'raster'), poster: '' })
  const lastStep = Math.floor(bar.props.max / bar.props.step) * bar.props.step
  bar.props.onChange({ target: { value: String(lastStep) } })
  check(c.get('ratio').time === ratioEl.duration && ratioEl.currentTime === ratioEl.duration && ratioEl.paused && c.get('ratio').status === 'ended',
    'seeking a playing raster clip to the end holds the last frame even with looping enabled')
  c.mediaEvent('ratio', ratioEl, 'play')
  check(c.get('ratio').status === 'ended', 'a delayed play event cannot resume a clip held at the end')
  await c.play(node('ratio', 'raster'), meta('ratio', 'raster'))
  check(c.get('ratio').time === 0 && ratioEl.currentTime === 0 && !ratioEl.paused, 'playing again after an end seek starts at zero')
  c.seekRatio('ratio', 2)
  check(c.get('ratio').time === ratioEl.duration, 'seekRatio clamps a ratio above 1')
  c.reset()
}
{
  // Declared duration (node data) must unlock the bar before any <video> exists.
  const h = harness(async (action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: [] } } : { base64: 'AA==' })
  const c = h.controller
  const ui = surfaceHarness(c)
  ui.enter()
  const declared = { clip: 'declared', kind: 'raster', fps: 10, duration: 20 }
  const bar = ui.bar({ controller: c, node: node('declared', 'raster'), meta: declared, poster: '', onPlay: () => {} })
  check(bar.props.max === 20 && bar.props.disabled === false, 'a declared media duration makes the bar usable before playback')
  bar.props.onChange({ target: { value: '20' } })
  check(c.get('declared').status !== 'idle' || h.calls.some((call) => call.action === 'media-manifest'),
    'clicking a declared-duration bar starts playback instead of dropping the position')
  await new Promise((resolve) => setTimeout(resolve, 0))
  let plays = 0
  const el = { currentTime: 0, duration: 12, readyState: 2, play() { plays += 1; return Promise.resolve() }, pause() {} }
  c.attach('declared', el)
  check(c.get('declared').status === 'ended' && c.get('declared').time === 12 && el.currentTime === 12 && plays === 0,
    'an end click before raster metadata uses the measured endpoint and stays paused there')
  c.reset()
}
{
  const h = harness(async (action) => action === 'media-manifest' ? { hasSource: true, manifest: { frames: [] } } : { url: '/video/test' })
  const c = h.controller
  const movie = node('buffering', 'raster')
  const data = { ...meta('buffering', 'raster'), duration: 8 }
  let end = 0
  let plays = 0
  const el = { currentTime: 0, duration: Infinity, readyState: 1, paused: true,
    seekable: { length: 1, start: () => 0, end: () => end },
    play() { plays += 1; this.paused = false; return Promise.resolve() },
    pause() { this.paused = true } }
  c.seekRatio('buffering', 0.7)
  await c.play(movie, data)
  c.attach('buffering', el)
  check(el.currentTime === 0 && plays === 0, 'a cold seek waits for a measured duration before starting playback')
  el.duration = 10
  c.mediaEvent('buffering', el, 'durationchange')
  c.mediaEvent('buffering', el, 'timeupdate')
  check(el.currentTime === 0 && plays === 0 && c.get('buffering').time === 7,
    'metadata alone does not apply a seek outside the available range or accept zero-time events')
  end = 10
  c.mediaEvent('buffering', el, 'progress')
  check(el.currentTime === 7 && plays === 1 && c.get('buffering').time === 7,
    'the saved seek starts playback at the requested ratio as soon as the range becomes available')
  end = 7
  c.seekRatio('buffering', 0.9)
  c.mediaEvent('buffering', el, 'timeupdate')
  check(el.currentTime === 7 && c.get('buffering').time === 9, 'a playing video keeps the latest seek while the native range is limited')
  c.seekRatio('buffering', 0.8)
  end = 10
  c.mediaEvent('buffering', el, 'canplay')
  check(el.currentTime === 8 && plays === 1 && c.get('buffering').time === 8,
    'range recovery uses the latest requested position and does not restart an already playing element')
  c.reset()
}
console.log('\nAll ' + checks + ' video playback checks passed')
