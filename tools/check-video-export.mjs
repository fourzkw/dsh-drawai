import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { createVideoExportManager } from '../src/video-export.js'
import { ensureClipPack, writeManifest } from '../src/media.js'
import * as plugin from '../lib/index.js'

const local = resolve('_local/bin/' + (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const binary = process.env.DRAWAI_FFMPEG_PATH || (existsSync(local) ? local : 'ffmpeg')
const probe = spawnSync(binary, ['-version'], { windowsHide: true })
if (probe.error) {
  console.log('check-video-export: SKIP real encoding (install FFmpeg or set DRAWAI_FFMPEG_PATH); offline client checks still run')
  process.exit(0)
}
function ffmpeg(args) {
  const result = spawnSync(binary, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr))
  return result
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8)
  let crc = 0xffffffff
  for (const b of bytes.subarray(4, -4)) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}
function png(w, h, index, large = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6
  const rows = Buffer.alloc(h * (w * 4 + 1), 255)
  for (let y = 0; y < h; y++) {
    rows[y * (w * 4 + 1)] = 0
    for (let x = 16; x < 48; x++) if (y > 12 && y < 36) {
      const pos = y * (w * 4 + 1) + 1 + x * 4
      rows.fill(index * 7, pos, pos + 3)
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), ...(large ? [chunk('tEXt', Buffer.concat([Buffer.from('padding\0'), Buffer.alloc(1024 * 1024, 120)]))] : []), chunk('IEND', Buffer.alloc(0))])
}
const root = mkdtempSync(resolve('_local/drawai-export-test-'))
const drawioAbs = join(root, 'demo.drawio')
const manager = createVideoExportManager({ ffmpegPath: binary, profile: true })
const disposers = []
let route
plugin.apply({ tools: { register() { return () => {} } }, webServer: { register(value) { route = value; return () => {} } },
  fs: { async resolve(path, options) { return { path: resolve(options?.cwd || root, path) } }, processPath(value) { return value.path },
    contains(a, b) { const rel = relative(a.path, b.path); return !rel.startsWith('..') && !isAbsolute(rel) } },
  sessions: { get(id) { return ['owner', 'other'].includes(id) ? { header: { cwd: root } } : undefined } },
  sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: root } } },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose } })
async function request(action, extra = {}) {
  const listeners = {}, body = { sessionId: 'owner', path: 'demo.drawio', clip: 'clip', action, ...extra }
  const req = { method: 'POST', headers: { 'x-drawai-save': '1' }, on(event, fn) { listeners[event] = fn; return this } }
  let status, payload
  queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() })
  await route.handler(req, { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } })
  return { status, payload }
}
async function wait(scope, token) {
  const until = Date.now() + 30000
  let state = manager.finish(scope, token)
  while (state.status === 'encoding' && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    state = manager.status(scope, token)
  }
  assert.equal(state.status, 'done', state.error)
  return state
}
try {
  const pack = ensureClipPack(drawioAbs, 'clip', { kind: 'svg', w: 65, h: 49, fps: 30 })
  const wav = Buffer.alloc(44 + 96000 * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
  for (let i = 0; i < 96000; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (i < 24000 ? 220 : 880) * i / 48000) * 8000), 44 + i * 2)
  writeFileSync(join(pack.dir, 'source.wav'), wav)
  for (const [format, fps, count, audio] of [['mp4', 30, 30, true], ['webm', 29.97, 9, false]]) {
    writeManifest(pack.dir, { ...pack.manifest, fps, source: audio ? 'source.wav' : null, sourceOffset: 0.5, frames: Array.from({ length: count }, (_, i) => ({ file: 'frames/' + i + '.svg' })) })
    // findSourceFile also discovers unlisted source.* files: remove it for a silent sequence.
    if (!audio) rmSync(join(pack.dir, 'source.wav'))
    const scope = { sessionId: 'owner', drawioAbs, clip: 'clip' }
    const job = await manager.start(scope, format)
    const cache = join(root, '.drawai-cache', 'video-exports')
    assert.equal(readdirSync(cache).length, 1, 'default export cache is inside the canvas workspace')
    assert.ok(existsSync(join(cache, readdirSync(cache)[0], 'output.' + format)), 'preflight proves FFmpeg can write the exact output path')
    assert.throws(() => manager.status({ ...scope, sessionId: 'other' }, job.token), /不属于/)
    assert.throws(() => manager.finish(scope, job.token), /尚未全部/)
    for (let index = 0; index < count; index++) {
      const bytes = png(65, 49, index, index === 0)
      assert.throws(() => manager.chunk(scope, { token: job.token, index, offset: 1, base64: 'AA==' }), /位置无效/)
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) manager.chunk(scope, { token: job.token, index, offset, base64: bytes.subarray(offset, offset + 1024 * 1024).toString('base64') })
      manager.frame(scope, { token: job.token, index })
    }
    const state = await wait(scope, job.token)
    assert.equal(state.encoded, count)
    const parts = []
    for (let offset = 0; offset < state.bytes;) { const part = manager.read(scope, job.token, offset); parts.push(Buffer.from(part.base64, 'base64')); offset += part.bytes }
    const output = join(root, 'output.' + format)
    writeFileSync(output, Buffer.concat(parts))
    const decoded = ffmpeg(['-i', output, '-map', '0:v:0', '-vf', 'showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-'])
    const times = Array.from(decoded.stderr.toString().matchAll(/\bn:\s*\d+\s+pts:.*?pts_time:([\d.]+)/g), (match) => Number(match[1]))
    assert.equal(times.length, count, 'actual encoded file contains every input frame')
    times.forEach((time, index) => assert.ok(Math.abs(time - index / fps) < (format === 'webm' ? 0.0011 : 0.00002), 'frame timestamps preserve the requested cadence'))
    const pixels = ffmpeg(['-i', output, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']).stdout
    assert.equal(pixels.length, count * 66 * 50 * 3)
    for (let index = 0; index < count; index++) {
      const center = index * 66 * 50 * 3 + (24 * 66 + 32) * 3
      assert.ok(Math.abs(pixels[center] - index * 7) < 10, 'frame content is not skipped or repeated')
      assert.ok(pixels[index * 66 * 50 * 3] > 240, 'white background is retained')
    }
    if (audio) {
      const pcm = ffmpeg(['-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']).stdout
      assert.ok(Math.abs(pcm.length / 2 / 48000 - count / fps) < 1 / fps, 'audio duration matches the complete video')
      let crossings = 0
      for (let i = 2401; i < 12000; i++) if (pcm.readInt16LE((i - 1) * 2) <= 0 && pcm.readInt16LE(i * 2) > 0) crossings++
      assert.ok(Math.abs(crossings / (9599 / 48000) - 880) < 30, 'audio starts at the selected segment offset')
    }
    await manager.discard(scope, job.token)
    assert.deepEqual(readdirSync(cache), [], 'discard removes temporary frames and encoded output')
    assert.throws(() => manager.status(scope, job.token), /已失效/)
    console.log('  ' + format + ': ' + count + ' distinct frames, ' + fps + 'fps, fixed timestamps' + (audio ? ', audio offset and duration verified' : ''))
  }
  const cancelScope = { sessionId: 'owner', drawioAbs, clip: 'clip' }
  const cancelled = await manager.start(cancelScope, 'mp4')
  for (let index = 0; index < cancelled.count; index++) {
    manager.chunk(cancelScope, { token: cancelled.token, index, offset: 0, base64: png(65, 49, index).toString('base64') })
    manager.frame(cancelScope, { token: cancelled.token, index })
  }
  manager.finish(cancelScope, cancelled.token)
  await manager.discard(cancelScope, cancelled.token)
  assert.throws(() => manager.status(cancelScope, cancelled.token), /已失效/, 'cancellation stops the encoder and invalidates its token')
  const started = await request('media-video-export-start', { format: 'mp4' })
  assert.equal(started.payload.ok, true, started.payload.error)
  assert.equal((await request('media-video-export-status', { token: started.payload.token, sessionId: 'other' })).payload.ok, false)
  assert.equal((await request('media-video-export-start', { format: 'mp4', path: '../outside.drawio' })).status, 403)
  assert.equal((await request('media-video-export-finish', { token: started.payload.token })).payload.ok, false)
  assert.equal((await request('media-video-export-discard', { token: started.payload.token })).payload.ok, true)
  const missing = createVideoExportManager({ ffmpegPath: join(root, 'missing-ffmpeg') })
  await assert.rejects(missing.start({ sessionId: 'owner', drawioAbs, clip: 'clip' }, 'mp4'), /未找到 FFmpeg/)
  await missing.dispose()
  assert.deepEqual(readdirSync(join(root, '.drawai-cache', 'video-exports')), [], 'failed preflight also cleans its temporary directory')
  const reports = readdirSync(join(root, '.drawai-cache', 'performance')).map((name) => JSON.parse(readFileSync(join(root, '.drawai-cache', 'performance', name), 'utf8')))
  const completed = reports.find((report) => report.status === 'done')
  assert.ok(completed.stages.ffmpegEncode.totalMs > 0)
  assert.ok(completed.counters.receivedFrames > 0 && completed.counters.downloadedBytes > 0)
  assert.ok(completed.peaks.tempTotalBytes >= completed.counters.outputBytes)
  console.log('check-video-export: OK (real CFR files, frame content, audio sync, fractional fps, chunking, route authorization, telemetry and cleanup)')
} finally {
  await manager.dispose()
  for (const dispose of disposers.reverse()) await dispose()
  rmSync(root, { recursive: true, force: true })
}
