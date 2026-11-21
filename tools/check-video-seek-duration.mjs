import assert from 'node:assert/strict'
import { createVideoController } from '../src/video-player.js'

// 回归：进度条在 video.duration 尚未就绪时不可拖动 / 一拖就回开头。
// 曾因 positionElement 用 `readyState < 1 || elementPositioned` 整体早退，
// duration 永远停在 0：进度条 max=0 被禁用，且 seek 把时间钳到 [0, 0] 恒为 0。

const node = (id, kind = 'raster') => ({ id, data: { drawaiMedia: '1', mediaClip: id, mediaKind: kind } })
const meta = (id, kind = 'raster') => ({ clip: id, kind, fps: 30 })

function harness(request, environment = {}) {
  let time = 0
  let next = 0
  const callbacks = new Map()
  const calls = []
  const controller = createVideoController(async (action, body) => {
    calls.push([action, body.clip])
    return request(action, body)
  }, {
    raf: (fn) => { const id = ++next; callbacks.set(id, fn); return id },
    caf: (id) => callbacks.delete(id),
    now: () => time,
    makeUrl: () => 'blob:test-' + (++next),
    revoke: () => {},
    ...environment,
  })
  return { controller, calls, advance(ms) { time += ms } }
}

let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1; console.log('  ✓ ' + message) }

// raster 源视频：manifest 带 duration，但 video 元素 duration 一开始是 NaN（尚未 loadedmetadata）
{
  const video = {
    currentTime: 0, duration: NaN, readyState: 0,
    play() { return Promise.resolve() }, pause() {},
  }
  const h = harness((action) => {
    if (action === 'media-manifest') return { hasSource: true, manifest: { frames: [], fps: 30, duration: 36.05 } }
    if (action === 'media-source-url') return { url: '/video/x', mime: 'video/mp4' }
    return null
  })
  const c = h.controller
  await c.play(node('seg'), meta('seg'))

  check(c.get('seg').kind === 'raster', 'raster 源视频走 raster 分支')
  check(
    Math.abs(c.get('seg').duration - 36.05) < 0.001,
    'manifest 的 duration 被预置为播放时长，进度条 max 不会是 0',
  )

  // 拖动：此时 video 尚未 metadata 就绪，但时长已知，seek 不应把时间钳成 0
  c.seek('seg', 18)
  check(Math.abs(c.get('seg').time - 18) < 0.001, 'duration 已知时 seek 落到目标位置而不是回到起点')

  // 即使 duration 因任何原因仍是 0，也不能把拖动值吃掉
  c.patchDurationToZeroForTest = undefined
  c.attach('seg', video)
  video.readyState = 1
  video.duration = 36.05
  c.mediaEvent('seg', video, 'loadedmetadata')
  check(Math.abs(c.get('seg').duration - 36.05) < 0.001, 'loadedmetadata 后时长仍为真实值')
  c.seek('seg', 30)
  check(Math.abs(video.currentTime - 30) < 0.001, 'seek 写入当前 video 元素的 currentTime')
}

console.log('\n  ' + checks + ' checks passed')
