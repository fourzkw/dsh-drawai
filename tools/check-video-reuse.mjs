import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { deflateSync } from 'node:zlib'
import { checkVideoPalette, exactVideoFrameKey, videoTraceOptions } from '../src/video-trace-reuse.js'
import { traceRasterForToolbar } from '../src/trace-image.js'
import * as plugin from '../lib/index.js'

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8)
  let crc = 0xffffffff
  for (const byte of out.subarray(4, -4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out
}
const w = 64, h = 48
function pixels(bg = [35, 35, 35], actor = null, x = 28) {
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4)
  if (actor) for (let y = 18; y < 26; y++) for (let xx = x; xx < x + 8; xx++) data.set([...actor, 255], (y * w + xx) * 4)
  return data
}
function png(data, compression = 6) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6
  const rows = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) data.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: compression })), chunk('IEND', Buffer.alloc(0))])
}
const options = { level: 'high', preset: 'default', colors: 6, removeBg: false }
const manifest = { width: w, height: h }
const normalized = videoTraceOptions(options, manifest, 248000)
assert.equal(exactVideoFrameKey(png(pixels()), JSON.stringify(normalized)), exactVideoFrameKey(png(pixels()), JSON.stringify(normalized)))
assert.notEqual(exactVideoFrameKey(png(pixels()), JSON.stringify(normalized)), exactVideoFrameKey(png(pixels()), JSON.stringify({ ...normalized, colors: 12 })))
assert.throws(() => videoTraceOptions({ ...options, removeBg: undefined }, manifest, 248000), /removeBg/)
const tiny = Buffer.from([35, 35, 35, 255, 245, 235, 220, 255])
assert.equal(checkVideoPalette(tiny, [0, 1], [[35, 35, 35], [40, 40, 40]]).accepted, false, 'even a single foreground bright pixel rejects a dark palette')
assert.equal(checkVideoPalette(tiny, [0], [[35, 35, 35], [40, 40, 40]]).accepted, true, 'removed background is excluded from foreground validation')
assert.equal(checkVideoPalette(Buffer.from([60, 100, 60, 255]), [0], [[100, 80, 60], [0, 0, 0]]).reason, 'color-mismatch', 'near-equal luma must not hide a hue change')
assert.equal(checkVideoPalette(tiny, [0], [[NaN, 0, 0], [1, 2, 3]]).accepted, false)

const root = mkdtempSync(join(tmpdir(), 'drawai-reuse-')), disposers = []
let route
plugin.apply({ tools: { register() { return () => {} } }, webServer: { register(value) { route = value; return () => {} } },
  fs: { async resolve(path, opts) { return { path: resolve(opts?.cwd || root, path) } }, processPath(value) { return value.path },
    contains(a, b) { const rel = relative(a.path, b.path); return !rel.startsWith('..') && !isAbsolute(rel) } },
  sessions: { get(id) { return ['owner', 'other'].includes(id) ? { header: { cwd: root } } : undefined } },
  sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: root } } },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose } })
async function request(action, extra = {}) {
  const listeners = {}, body = { action, sessionId: 'owner', path: 'demo.drawio', ...extra }
  let payload
  const req = { method: 'POST', headers: { 'x-drawai-save': '1' }, on(event, fn) { listeners[event] = fn; return this } }
  queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() })
  await route.handler(req, { writeHead() {}, end(text) { payload = JSON.parse(text) } })
  return payload
}
async function start(count, fps = 30) {
  const job = await request('media-trace-start', { w, h, count, fps, maxBytes: 248000 })
  assert.equal(job.ok, true, job.error)
  return { clip: job.clip, token: job.token }
}
async function frame(auth, index, data, extra = {}) {
  const result = await request('media-trace-frame', { ...auth, ...options, index, pngBase64: png(data).toString('base64'), ...extra })
  assert.equal(result.ok, true, result.error)
  return result
}
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('frame request deadlocked')), 10000) })]) }
  finally { clearTimeout(timer) }
}
try {
  const auth = await start(5), dark = pixels(), light = pixels([35, 35, 35], [245, 235, 220])
  const first = await frame(auth, 0, dark)
  const identical = await frame(auth, 1, dark, { fingerprint: Buffer.alloc(576, 255).toString('base64') })
  assert.equal(identical.reused, true)
  assert.equal(identical.svg, first.svg)
  const bright = await frame(auth, 2, light, { fingerprint: Buffer.alloc(576, 0).toString('base64') })
  assert.equal(bright.reused, false, 'a small bright character cannot reuse the old dark SVG')
  assert.equal(bright.paletteShared, false)
  assert.equal(bright.paletteReuseReason, 'brightness-mismatch')
  const fresh = traceRasterForToolbar({ width: w, height: h, data: light }, { ...options, maxBytes: 248000, maxLongSide: w, allowEmpty: true, onlySelectedLevel: true })
  assert.equal(bright.svg, fresh.svg, 'rejected reuse falls back to the actual current frame, preserving bright colors')
  assert.ok(bright.svg.includes('#f5ebdc'))
  const moved = await frame(auth, 3, pixels([35, 35, 35], [245, 235, 220], 30))
  assert.equal(moved.reused, false, 'movement always recomputes geometry')
  assert.equal(moved.paletteShared, true, 'an applicable palette still saves quantization work')
  assert.notEqual(moved.svg, bright.svg)
  const movedAgain = await frame(auth, 4, pixels([35, 35, 35], [245, 235, 220], 30))
  assert.equal(movedAgain.reused, true)
  const finished = await request('media-trace-finish', auth)
  assert.equal(finished.manifest.frames.length, 5)
  assert.equal(finished.manifest.duration, 5 / 30, 'cache hits retain every frame timestamp')
  assert.equal((await request('media-trace-frame', { ...auth, sessionId: 'other', index: 0 })).ok, false)
  await request('media-trace-release', auth)

  const gradual = await start(15)
  let refreshes = 0
  for (let i = 0; i < 15; i++) {
    const value = 35 + i * 2, result = await frame(gradual, i, pixels([value, value, value]))
    assert.equal(result.reused, false, 'slowly changing pixels must not reuse whole SVGs')
    if (!result.paletteShared) refreshes++
    const fills = [...result.svg.matchAll(/<path fill='(#[0-9a-f]{6})'/g)].map((match) => parseInt(match[1].slice(1, 3), 16))
    assert.ok(fills.some((fill) => Math.abs(fill - value) <= 8), 'brightness cannot drift indefinitely from the generated palette')
  }
  assert.ok(refreshes >= 3)
  await request('media-trace-discard', gradual)

  const aged = await start(3, 1), samePixels = pixels([35, 35, 35], [200, 180, 160])
  assert.notDeepEqual(png(samePixels, 1), png(samePixels, 9))
  await frame(aged, 0, samePixels, { pngBase64: png(samePixels, 1).toString('base64') })
  const shared = await frame(aged, 1, samePixels, { pngBase64: png(samePixels, 9).toString('base64') })
  assert.equal(shared.paletteShared, true)
  const refreshed = await frame(aged, 2, samePixels, { pngBase64: png(samePixels, 1).toString('base64') })
  assert.equal(refreshed.paletteShared, false, 'shared frames do not reset the periodic refresh clock')
  assert.equal(refreshed.reused, false, 'different PNG encodings conservatively miss the exact cache')
  await request('media-trace-discard', aged)

  const params = await start(7)
  await frame(params, 0, light)
  for (const [index, extra] of [[1, { colors: 12 }], [2, { colors: 12, level: 'medium' }], [3, { colors: 12, level: 'medium', preset: 'lineart' }],
    [4, { colors: 12, level: 'medium', preset: 'lineart', removeBg: true }]]) {
    const changed = await frame(params, index, light, extra)
    assert.equal(changed.reused || changed.paletteShared, false, 'parameter changes cannot reuse a previous result/palette')
  }
  const normalizedHit = await frame(params, 5, light, { colors: '12', level: 'medium', preset: 'lineart', removeBg: true })
  assert.equal(normalizedHit.reused, true)
  const invalid = await request('media-trace-frame', { ...params, ...options, index: 6, pngBase64: png(light).toString('base64'), removeBg: undefined })
  assert.equal(invalid.ok, false, 'an exact input cannot bypass option validation')
  await request('media-trace-discard', params)

  // File-backed frame 0 can finish reading after inline frame 1. Their cache
  // dependencies must follow submission order, not read completion order.
  const piped = await start(3), bytes = png(light)
  assert.equal((await request('media-trace-frame-chunk', { ...piped, index: 0, offset: 0, base64: bytes.toString('base64') })).ok, true)
  const [p0, p1, p2] = await bounded(Promise.all([
    request('media-trace-frame', { ...piped, ...options, index: 0 }),
    request('media-trace-frame', { ...piped, ...options, index: 1, pngBase64: bytes.toString('base64') }),
    request('media-trace-frame', { ...piped, ...options, index: 2, pngBase64: bytes.toString('base64') }),
  ]))
  assert.ok(p0.ok && p1.ok && p2.ok, p0.error || p1.error || p2.error)
  assert.equal(p1.reused && p2.reused, true)
  assert.equal((await request('media-trace-finish', piped)).manifest.frames.length, 3)
  await request('media-trace-release', piped)

  const broken = await start(2), corrupt = bytes.subarray(0, 24).toString('base64')
  const failures = await bounded(Promise.all([0, 1].map((index) => request('media-trace-frame', { ...broken, ...options, index, pngBase64: corrupt }))))
  assert.ok(failures.every((failure) => failure.ok === false), 'failed predecessor rejects exact reuse without hanging')
  await request('media-trace-discard', broken)
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  rmSync(root, { recursive: true, force: true })
}
console.log('check-video-reuse: OK (exact-only frames, bright local details, hue/drift guards, palette age, frozen parameters, pipelined order, failure and ownership)')
