import { createMediaPerformance } from '../src/performance-metrics.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const start = source.indexOf('  async function encodeVideoToFile(')
const body = source.slice(start, source.indexOf('  async function grabVideoStill(', start))

async function run(kind = 'svg', mode = 'success', format = 'mp4') {
  const count = 8, fps = 30, rendered = [], committed = [], actions = [], offsets = new Map(), downloads = [], revoked = []
  let clock = 0, note = '', canvas, encoded, polls = 0, drawIndex = -1
  const environment = {
    createMediaPerformance,
    videoMetaOf: () => ({ clip: 'traced', kind, fps }), target: 'folder/demo.drawio',
    async mediaAction(action, args) {
      actions.push(action)
      if (action === 'media-manifest') return { hasSource: true, manifest: { source: mode === 'native' ? 'source.mp4' : null } }
      if (action === 'media-export-source') return { path: 'exported.mp4' }
      if (action === 'media-video-export-start') {
        if (mode === 'missing-ffmpeg') throw new Error('未找到 FFmpeg')
        return { token: 'token', count: kind === 'svg' ? count : 0, fps, w: 642, h: 360 }
      }
      if (action === 'media-frame') {
        // Deliberately slower than 30fps: no frame may be skipped or repeated.
        clock += 140; rendered.push(args.index); drawIndex = args.index
        if (mode === 'frame-error' && args.index === 2) throw new Error('frame read failed')
        return { svg: '<svg/>' }
      }
      if (action === 'media-video-export-chunk') {
        assert.equal(args.index, committed.length)
        assert.equal(args.offset, offsets.get(args.index) || 0)
        const bytes = Buffer.from(args.base64, 'base64')
        assert.ok(bytes.length <= 1024 * 1024)
        offsets.set(args.index, args.offset + bytes.length)
        return { received: args.offset + bytes.length }
      }
      if (action === 'media-video-export-frame') { committed.push(args.index); return {} }
      if (action === 'media-video-export-finish') return { status: 'encoding', encoded: 0 }
      if (action === 'media-video-export-status') {
        if (++polls < 2) return { status: 'encoding', encoded: 4 }
        return { status: mode === 'encode-error' ? 'error' : 'done', error: 'encoder failed', bytes: 7 }
      }
      if (action === 'media-video-export-read') return { offset: mode === 'bad-download' ? 1 : args.offset, total: 7, bytes: 7, base64: Buffer.from('encoded').toString('base64') }
      if (action === 'media-video-export-discard') return {}
      throw new Error('unexpected action ' + action)
    },
    setSaveNote(value) { note = value },
    document: { createElement(type) {
      if (type === 'a') return { click() { downloads.push(this.download) } }
      assert.equal(type, 'canvas', 'offline export does not play audio/video in the browser')
      canvas = { getContext: () => ({ fillRect() { assert.equal(this.fillStyle, '#fff') }, drawImage() {} }),
        toBlob(callback) { callback(new Blob([Buffer.alloc(drawIndex === 0 ? 1024 * 1024 + 11 : 11)])) },
        captureStream() { throw new Error('realtime recording must not be used') } }
      return canvas
    } },
    Image: class { set src(value) { queueMicrotask(() => this.onload()) } },
    async readVideoChunk(blob) { return Buffer.from(await blob.arrayBuffer()).toString('base64') },
    URL: { createObjectURL(blob) { encoded = blob; return 'blob:output' }, revokeObjectURL(url) { revoked.push(url) } },
    setTimeout(fn) { queueMicrotask(fn) },
  }
  const encode = new Function(...Object.keys(environment), body + '\nreturn encodeVideoToFile')(...Object.values(environment))
  if (mode.includes('error') || mode === 'bad-download' || mode === 'missing-ffmpeg') {
    await assert.rejects(encode({ w: 32, h: 18 }, format), /failed|不完整|FFmpeg/)
    assert.equal(downloads.length, 0)
    if (mode !== 'missing-ffmpeg') assert.equal(actions.at(-1), 'media-video-export-discard', 'all failures release uploaded frames and temporary output')
    return
  }
  await encode({ w: 32, h: 18 }, format)
  if (mode === 'native') {
    assert.deepEqual(actions, ['media-manifest', 'media-export-source'])
    assert.match(note, /保留源视频画质与音频/)
    return
  }
  if (kind === 'svg') {
    assert.deepEqual(rendered, Array.from({ length: count }, (_, i) => i))
    assert.deepEqual(committed, rendered, 'every slow frame is acknowledged in order')
    assert.ok(clock / 1000 > count / fps, 'export may take longer than the video while preserving all frames')
    assert.equal(offsets.get(0), 1024 * 1024 + 11, 'large PNGs use sequential chunks')
    assert.equal(canvas.width, 642)
    assert.match(note, /8 帧，30fps/)
  } else assert.equal(canvas, undefined, 'source conversion is entirely offline on the host')
  assert.deepEqual(downloads, ['demo-traced.' + format])
  assert.equal(encoded.type, 'video/' + format)
  assert.equal(await encoded.text(), 'encoded')
  assert.deepEqual(revoked, ['blob:output'])
  assert.equal(actions.at(-1), 'media-video-export-discard')
}
await run()
await run('svg', 'success', 'webm')
await run('raster')
await run('raster', 'native')
for (const mode of ['frame-error', 'encode-error', 'bad-download', 'missing-ffmpeg']) await run('svg', mode)
console.log('check-video-audio: OK (offline sequential frames, slow rendering, chunking, MP4/WebM, white background, source passthrough, failure cleanup)')
