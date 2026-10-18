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
    : action === 'media-source-bytes' ? { base64: 'AA==', mime: 'video/mp4' } : { svg }, { createAudio: () => audio })
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
  // 音频时钟略早于 sourceOffset 时，旧逻辑会 floor 出负帧号，错误文案变成「第 0/-n 帧」。
  const audio = { currentTime: 0, readyState: 2, paused: true, src: '', play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true }, removeAttribute() { this.src = '' }, load() {} }
  const requested = []
  const h = harness((action, body) => {
    if (action === 'media-manifest') return { hasSource: true, manifest: { frames: Array(80).fill({}), fps: 10, sourceOffset: 2 } }
    if (action === 'media-source-bytes') return { base64: 'AA==', mime: 'video/mp4' }
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
  check(!h.calls.some(([action, clip]) => clip === 'slow' && action === 'media-source-bytes'), 'cancelled loads do not fetch or allocate stale source data')
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
console.log('\nAll ' + checks + ' video playback checks passed')
