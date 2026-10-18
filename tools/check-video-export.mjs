import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { decodePng } from '../src/raster.js'
import { createVideoExportManager } from '../src/video-export.js'
import { ensureClipPack, writeManifest } from '../src/media.js'
import { renderExportFrame, validateExportSvg } from '../src/video-export-worker.js'
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
function png(w, h, index, large = false, transparent = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6
  const rows = Buffer.alloc(h * (w * 4 + 1), 255)
  for (let y = 0; y < h; y++) {
    rows[y * (w * 4 + 1)] = 0
    if (transparent) for (let x = 0; x < 16; x++) {
      const pos = y * (w * 4 + 1) + 1 + x * 4
      rows.fill(0, pos, pos + 4)
    }
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
  let state = manager.status(scope, token)
  while (['rendering', 'encoding'].includes(state.status) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    state = manager.status(scope, token)
  }
  assert.equal(state.status, 'done', state.error)
  return state
}
try {
  const rendered = decodePng(renderExportFrame('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path fill="red" fill-rule="evenodd" d="M0 0H20V10H0Z M5 2H15V8H5Z"/></svg>', 80, 20))
  assert.deepEqual([rendered.width, rendered.height], [80, 20], 'manifest dimensions control output even for a different source aspect ratio')
  assert.deepEqual([...rendered.data.subarray(0, 4)], [255, 0, 0, 255], 'the original SVG is rendered, not omitted as an unsupported image')
  assert.deepEqual([...rendered.data.subarray((10 * 80 + 40) * 4, (10 * 80 + 40) * 4 + 4)], [255, 255, 255, 255], 'transparent holes retain the white background')
  for (const svg of ['<svg><image href="file:///secret.png"/></svg>', '<svg><image href="https://example.com/x.png"/></svg>',
    '<svg><rect fill="url(file:///secret.svg)"/></svg>', '<!DOCTYPE svg><svg/>', '<svg><foreignObject/></svg>']) {
    assert.throws(() => validateExportSvg(svg), /外部|foreignObject/, 'host rendering rejects external resources')
  }
  assert.throws(() => renderExportFrame('<svg xmlns="http://www.w3.org/2000/svg"><path></svg>', 10, 10), 'malformed source XML must fail instead of silently rendering an empty frame')
  const pack = ensureClipPack(drawioAbs, 'clip', { kind: 'svg', w: 65, h: 49, fps: 30 })
  const wav = Buffer.alloc(44 + 96000 * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
  for (let i = 0; i < 96000; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (i < 24000 ? 220 : 880) * i / 48000) * 8000), 44 + i * 2)
  writeFileSync(join(pack.dir, 'source.wav'), wav)
  for (const [format, fps, count, audio] of [['mp4', 30, 30, true], ['webm', 29.97, 9, false], ['gif', 30, 30, false], ['gif', 29.97, 9, false]]) {
    writeManifest(pack.dir, { ...pack.manifest, fps, source: format === 'gif' ? 'missing.mp4' : audio ? 'source.wav' : null, sourceOffset: 0.5, frames: Array.from({ length: count }, (_, i) => ({ file: 'frames/' + i + '.svg' })) })
    // findSourceFile also discovers unlisted source.* files: remove it for a silent sequence.
    if (!audio) rmSync(join(pack.dir, 'source.wav'), { force: true })
    for (let index = 0; index < count; index++) writeFileSync(join(pack.dir, 'frames', index + '.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="65" height="49"><rect x="16" y="13" width="32" height="23" fill="rgb(' + [index * 7, index * 7, index * 7].join(',') + ')"/></svg>')
    const scope = { sessionId: 'owner', drawioAbs, clip: 'clip' }
    const job = await manager.start(scope, format)
    const cache = join(root, '.drawai-cache', 'video-exports')
    assert.equal(readdirSync(cache).length, 1, 'default export cache is inside the canvas workspace')
    assert.ok(existsSync(join(cache, readdirSync(cache)[0], 'output.' + format)), 'preflight proves FFmpeg can write the exact output path')
    assert.throws(() => manager.status({ ...scope, sessionId: 'other' }, job.token), /不属于/)
    assert.equal(job.background, true)
    assert.equal(manager.list({ ...scope, sessionId: 'other' }).length, 0)
    // No finish call, browser callbacks, PNG uploads, or status requests occur here.
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(manager.status(scope, job.token).received > 0, 'host renders while the browser is entirely absent')
    const state = await wait(scope, job.token)
    assert.equal(state.encoded, count)
    const parts = []
    for (let offset = 0; offset < state.bytes;) { const part = manager.read(scope, job.token, offset); parts.push(Buffer.from(part.base64, 'base64')); offset += part.bytes }
    const output = join(root, 'output.' + format)
    writeFileSync(output, Buffer.concat(parts))
    const gifInput = format === 'gif' ? ['-ignore_loop', '1'] : []
    const decoded = ffmpeg([...gifInput, '-i', output, '-map', '0:v:0', '-vf', 'showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-'])
    const times = Array.from(decoded.stderr.toString().matchAll(/\bn:\s*\d+\s+pts:.*?pts_time:([\d.]+)/g), (match) => Number(match[1]))
    assert.equal(times.length, count, 'actual encoded file contains every input frame')
    times.forEach((time, index) => assert.ok(Math.abs(time - index / fps) < (format === 'gif' ? 0.011 : format === 'webm' ? 0.0011 : 0.00002), 'frame timestamps preserve the requested cadence within format precision'))
    const width = format === 'gif' ? 65 : 66, height = format === 'gif' ? 49 : 50
    const pixels = ffmpeg([...gifInput, '-i', output, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']).stdout
    assert.equal(pixels.length, count * width * height * 3)
    for (let index = 0; index < count; index++) {
      const center = index * width * height * 3 + (24 * width + 32) * 3
      assert.ok(Math.abs(pixels[center] - index * 7) < 10, 'frame content is not skipped or repeated')
      assert.ok(pixels[index * width * height * 3] > 240, 'white background is retained')
    }
    if (format === 'gif') {
      const bytes = readFileSync(output)
      assert.match(bytes.toString('ascii', 0, 6), /^GIF8[79]a$/)
      const loop = bytes.indexOf('NETSCAPE2.0')
      assert.ok(loop > 0, 'GIF includes a loop extension')
      assert.deepEqual([...bytes.subarray(loop + 11, loop + 16)], [3, 1, 0, 0, 0], 'GIF loops indefinitely')
      assert.doesNotMatch(decoded.stderr.toString(), /Audio:/, 'GIF does not claim to contain audio')
    }
    if (audio) {
      const pcm = ffmpeg(['-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']).stdout
      assert.ok(Math.abs(pcm.length / 2 / 48000 - count / fps) < 1 / fps, 'audio duration matches the complete video')
      let crossings = 0
      for (let i = 2401; i < 12000; i++) if (pcm.readInt16LE((i - 1) * 2) <= 0 && pcm.readInt16LE(i * 2) > 0) crossings++
      assert.ok(Math.abs(crossings / (9599 / 48000) - 880) < 30, 'audio starts at the selected segment offset')
    }
    await manager.discard(scope, job.token)
    assert.ok(existsSync(state.path), 'saved export survives removing the task record')
    assert.deepEqual(readdirSync(cache), [], 'discard removes temporary frames and encoded output')
    assert.throws(() => manager.status(scope, job.token), /已失效/)
    console.log('  ' + format + ': ' + count + ' distinct frames, ' + fps + 'fps, fixed timestamps' + (audio ? ', audio offset and duration verified' : ''))
  }
  const raster = ensureClipPack(drawioAbs, 'gif-source', { kind: 'raster', w: 65, h: 49, fps: 15 })
  const rasterSource = join(raster.dir, 'source.mkv')
  const transparentPng = join(root, 'transparent.png')
  writeFileSync(transparentPng, png(65, 49, 10, false, true))
  ffmpeg(['-loop', '1', '-framerate', '15', '-i', transparentPng, '-t', '0.4', '-c:v', 'ffv1', '-pix_fmt', 'bgra', rasterSource])
  writeManifest(raster.dir, { ...raster.manifest, source: 'source.mkv' })
  const rasterScope = { sessionId: 'owner', drawioAbs, clip: 'gif-source' }
  const rasterJob = await manager.start(rasterScope, 'gif')
  const rasterState = await wait(rasterScope, rasterJob.token)
  const rasterParts = []
  for (let offset = 0; offset < rasterState.bytes;) {
    const part = manager.read(rasterScope, rasterJob.token, offset)
    rasterParts.push(Buffer.from(part.base64, 'base64')); offset += part.bytes
  }
  const rasterOutput = join(root, 'raster.gif')
  writeFileSync(rasterOutput, Buffer.concat(rasterParts))
  const rasterDecoded = ffmpeg(['-ignore_loop', '1', '-i', rasterOutput, '-vf', 'showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-'])
  assert.equal([...rasterDecoded.stderr.toString().matchAll(/\bn:\s*\d+\s+pts:/g)].length, 6, 'raster GIF export includes every source frame')
  const rasterPixels = ffmpeg(['-ignore_loop', '1', '-i', rasterOutput, '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']).stdout
  assert.equal(rasterPixels.length, 6 * 65 * 49 * 3)
  assert.deepEqual([...rasterPixels.subarray(0, 3)], [255, 255, 255], 'transparent source video is composited onto white')
  const restoredManager = createVideoExportManager({ ffmpegPath: binary })
  assert.equal(restoredManager.list(rasterScope).find((job) => job.token === rasterJob.token).status, 'done', 'finished exports survive a host restart')
  assert.equal(restoredManager.read(rasterScope, rasterJob.token, 0).total, rasterState.bytes, 'restored exports remain downloadable')
  assert.equal(restoredManager.list({ ...rasterScope, sessionId: 'other' }).length, 0)
  await restoredManager.dispose()
  await manager.discard(rasterScope, rasterJob.token)
  const bad = ensureClipPack(drawioAbs, 'bad-export', { kind: 'svg', w: 65, h: 49, fps: 30 })
  writeFileSync(join(bad.dir, 'frames', 'bad.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///secret.png"/></svg>')
  writeManifest(bad.dir, { ...bad.manifest, frames: [{ file: 'frames/bad.svg' }] })
  const badScope = { sessionId: 'owner', drawioAbs, clip: 'bad-export' }
  const badJob = await manager.start(badScope, 'gif')
  const errorDeadline = Date.now() + 5000
  let failed
  do { await new Promise((resolve) => setTimeout(resolve, 10)); failed = manager.status(badScope, badJob.token) }
  while (['rendering', 'encoding'].includes(failed.status) && Date.now() < errorDeadline)
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /外部/)
  assert.equal(failed.path, null, 'failed rendering cannot publish a partial export')
  assert.ok(manager.list(badScope).some((job) => job.token === badJob.token && job.status === 'error'), 'failure remains discoverable after a browser refresh')
  await manager.discard(badScope, badJob.token)
  writeManifest(pack.dir, { ...pack.manifest, source: null,
    frames: Array.from({ length: 3 }, (_, i) => ({ file: 'frames/' + i + '.svg' })) })
  const cancelScope = { sessionId: 'owner', drawioAbs, clip: 'clip' }
  for (const format of ['mp4', 'gif']) {
  const cancelled = await manager.start(cancelScope, format)
  await manager.discard(cancelScope, cancelled.token)
  assert.throws(() => manager.status(cancelScope, cancelled.token), /已失效/, 'cancellation stops the encoder and invalidates its token')
  }
  const shutdownManager = createVideoExportManager({ ffmpegPath: binary, slots: { acquire(signal) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })) } } })
  const interrupted = await shutdownManager.start(cancelScope, 'mp4')
  await shutdownManager.dispose()
  const afterRestart = createVideoExportManager({ ffmpegPath: binary })
  assert.equal(afterRestart.list(cancelScope).find((job) => job.token === interrupted.token).status, 'interrupted', 'shutdown cannot turn a queued encoder into success')
  await afterRestart.discard(cancelScope, interrupted.token); await afterRestart.dispose()
  const gifRoute = await request('media-video-export-start', { format: 'gif' })
  assert.equal(gifRoute.payload.ok, true, gifRoute.payload.error)
  assert.equal(gifRoute.payload.format, 'gif')
  await request('media-video-export-discard', { token: gifRoute.payload.token })
  const started = await request('media-video-export-start', { format: 'mp4' })
  assert.equal(started.payload.ok, true, started.payload.error)
  assert.equal((await request('media-video-export-status', { token: started.payload.token, sessionId: 'other' })).payload.ok, false)
  assert.equal((await request('media-video-export-start', { format: 'mp4', path: '../outside.drawio' })).status, 403)
  assert.equal((await request('media-video-export-finish', { token: started.payload.token })).payload.ok, true, 'legacy finish is idempotent and never required')
  assert.ok((await request('media-video-export-list')).payload.jobs.some((job) => job.token === started.payload.token), 'page reload can discover existing jobs')
  assert.equal((await request('media-video-export-list', { sessionId: 'other' })).payload.jobs.length, 0, 'job discovery is session scoped')
  assert.equal((await request('media-video-export-discard', { token: started.payload.token })).payload.ok, true)
  const missing = createVideoExportManager({ ffmpegPath: join(root, 'missing-ffmpeg') })
  await assert.rejects(missing.start({ sessionId: 'owner', drawioAbs, clip: 'clip' }, 'mp4'), /未找到 FFmpeg/)
  await missing.dispose()
  assert.deepEqual(readdirSync(join(root, '.drawai-cache', 'video-exports')), [], 'failed preflight also cleans its temporary directory')
  const reports = readdirSync(join(root, '.drawai-cache', 'performance')).map((name) => JSON.parse(readFileSync(join(root, '.drawai-cache', 'performance', name), 'utf8')))
  const completed = reports.find((report) => report.status === 'done' && report.counters.renderedFrames > 0)
  assert.ok(completed.stages.ffmpegEncode.totalMs > 0)
  assert.ok(completed.counters.renderedFrames > 0 && completed.counters.outputBytes > 0)
  assert.ok(completed.stages.hostSvgRender.totalMs > 0)
  assert.ok(completed.peaks.tempTotalBytes >= completed.counters.outputBytes)
  assert.ok(reports.some((report) => report.status === 'done' && report.stages.gifPaletteGenerate?.totalMs > 0), 'GIF palette generation has its own timing stage')
  console.log('check-video-export: OK (real CFR files, frame content, audio sync, fractional fps, chunking, route authorization, telemetry and cleanup)')
} finally {
  await manager.dispose()
  for (const dispose of disposers.reverse()) await dispose()
  rmSync(root, { recursive: true, force: true })
}
