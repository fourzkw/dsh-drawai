import { createVideoController } from './video-player.js'
import assert from 'node:assert/strict'

const node = () => ({ id: 'n', data: { drawaiMedia: '1', mediaClip: 'c', mediaKind: 'raster' } })
const meta = () => ({ clip: 'c', kind: 'raster', fps: 30 })
function harness() {
  let time = 0, next = 0
  const cbs = new Map()
  const c = createVideoController(async (a) => {
    if (a === 'media-manifest') return { hasSource: false, manifest: { frames: [], fps: 30, duration: 36.05 } }
    if (a === 'media-source-url') return { url: 'blob:x', mime: 'video/mp4' }
    return null
  }, { raf: fn => { const i = ++next; cbs.set(i, fn); return i }, caf: i => cbs.delete(i),
       now: () => time, makeUrl: () => 'blob:'+(++next), revoke: () => {} })
  return c
}
let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('  ✓ ' + msg) }

// 1) 暂停态下拖动，seek 期间的滞后 timeupdate 不得把位置弹回
{
  const c = harness()
  const v = { _t: 0, duration: 36.05, readyState: 4,
    get currentTime() { return this._t },
    set currentTime(x) { setTimeout(() => { this._t = x }, 25) },
    play(){ return Promise.resolve() }, pause(){} }
  await c.play(node(), meta())
  c.attach('n', v); c.mediaEvent('n', v, 'loadedmetadata')
  c.pause('n')
  c.seek('n', 20)
  c.mediaEvent('n', v, 'timeupdate')      // seek 未生效，携带旧位置 0
  await new Promise(r => setTimeout(r, 60))
  ok(Math.abs(c.get('n').time - 20) < 0.5, '暂停态拖动后位置保持在目标点，不被滞后 timeupdate 弹回')
}

// 2) seek 到达目标后，后续 timeupdate 必须正常跟随（不能被永久屏蔽）
{
  const c = harness()
  const v = { _t: 0, duration: 36.05, readyState: 4,
    get currentTime() { return this._t },
    set currentTime(x) { this._t = x },
    play(){ return Promise.resolve() }, pause(){} }
  await c.play(node(), meta())
  c.attach('n', v); c.mediaEvent('n', v, 'loadedmetadata')
  c.seek('n', 10)
  v._t = 10; c.mediaEvent('n', v, 'timeupdate')
  v._t = 15; c.mediaEvent('n', v, 'timeupdate')
  ok(Math.abs(c.get('n').time - 15) < 0.5, 'seek 完成后播放跟随恢复正常')
}

// 3) 游标位置限制在时长内
{
  const c = harness()
  const v = { _t: 0, duration: 36.05, readyState: 4,
    get currentTime() { return this._t }, set currentTime(x) { this._t = x },
    play(){ return Promise.resolve() }, pause(){} }
  await c.play(node(), meta())
  c.attach('n', v); c.mediaEvent('n', v, 'loadedmetadata')
  c.seek('n', 9999)
  ok(c.get('n').time <= 36.06, '超出时长的拖动被钳制在片长内')
}

console.log('\n  ' + n + ' checks passed')
