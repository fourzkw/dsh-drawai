import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const start = source.indexOf('  async function encodeSvgFramesToWebm(')
const body = source.slice(start, source.indexOf('  function renderSelectionToolbar(', start))

async function run(hasAudio, rejectPlayback = false) {
  let clock = 0, created = 0, closed = false, connected = false, downloaded = false, note = '', recorder
  const seeks = [], revoked = [], frames = [], tracks = [{ kind: 'video', stop() { this.stopped = true } }]
  const audioTrack = { kind: 'audio', stop() { this.stopped = true } }
  const audio = new class extends EventTarget {
    time = 0; ended = false; paused = true
    get currentTime() { return this.time }
    set currentTime(value) { this.time = value; seeks.push(value); queueMicrotask(() => this.dispatchEvent(new Event('seeked'))) }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadeddata'))) }
    async play() { if (rejectPlayback) throw new Error('play blocked'); this.paused = false }
    pause() { this.paused = true }
    removeAttribute() { this.src = '' }
  }()
  const stream = { addTrack(track) { tracks.push(track) }, getTracks() { return tracks } }
  const context = { fillRect() {}, drawImage() {} }
  const canvas = { getContext: () => context, captureStream: () => stream }
  class AudioContext {
    async resume() {}
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [audioTrack] } } }
    createMediaElementSource(element) { assert.equal(element, audio); return { connect() { connected = true } } }
    async close() { closed = true }
  }
  class MediaRecorder {
    state = 'inactive'
    constructor(value) { assert.equal(value, stream); recorder = this }
    start() { this.state = 'recording'; assert.equal(tracks.length, hasAudio ? 2 : 1) }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['webm']) }); this.onstop?.() }
  }
  const environment = {
    videoMetaOf: () => ({ clip: 'traced', fps: 10 }), target: 'demo.drawio',
    async mediaAction(action, options) {
      if (action === 'media-manifest') return { hasSource: hasAudio, manifest: { frames: Array(4).fill({}), sourceOffset: 2 } }
      if (action === 'media-source-bytes') return { base64: 'AA==', mime: 'video/mp4' }
      frames.push(options.index); return { svg: '<svg/>' }
    },
    setSaveNote: (value) => { note = value },
    document: { createElement(type) { return type === 'canvas' ? canvas : type === 'audio' ? audio : { click() { downloaded = true } } } },
    window: { AudioContext }, MediaRecorder,
    URL: { createObjectURL() { return 'blob:' + ++created }, revokeObjectURL(url) { revoked.push(url) } },
    Image: class { set src(value) { queueMicrotask(() => this.onload()) } },
    performance: { now: () => clock },
    setTimeout(fn, ms) { clock += ms; if (!audio.paused) audio.time += ms / 1000; queueMicrotask(fn) },
    async waitForVideoTraceEvent(element, event, signal, trigger) {
      await new Promise((resolve) => { element.addEventListener(event, resolve, { once: true }); trigger() })
    },
  }
  const encode = new Function(...Object.keys(environment), body + '\nreturn encodeSvgFramesToWebm')(...Object.values(environment))
  if (rejectPlayback) await assert.rejects(encode({ w: 320, h: 180 }), /play blocked/)
  else await encode({ w: 320, h: 180 })
  assert.ok(tracks.every((track) => track.stopped), 'all capture tracks are stopped')
  assert.equal(downloaded, !rejectPlayback)
  if (hasAudio) {
    assert.ok(seeks.includes(2), 'audio begins at the selected segment offset')
    assert.ok(connected && closed && audio.paused && audio.src === '', 'audio graph and element are cleaned up')
  }
  if (!rejectPlayback) {
    assert.equal(recorder.state, 'inactive')
    assert.ok(frames.includes(0) && frames.includes(3), 'recording renders the beginning and end of the sequence')
    assert.match(note, hasAudio ? /含原视频音频/ : /已导出/)
  }
  assert.equal(revoked.length, rejectPlayback ? 1 : hasAudio ? 2 : 1)
}
await run(true)
await run(false)
await run(true, true)
assert.ok(!source.includes('function PinnedTraceSettingsCard') && !source.includes('traceCardProps('), 'fixed settings card feature has been removed')
console.log('check-video-audio: OK (WebM audio track, segment offset, silent legacy clips, playback rejection, cleanup, fixed-card removal)')
