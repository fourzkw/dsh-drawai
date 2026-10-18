import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMediaPerformance } from '../src/performance-metrics.js'
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const start = source.indexOf('  async function encodeVideoToFile(')
const body = source.slice(start, source.indexOf('  async function grabVideoStill(', start))
async function run(kind = 'svg', format = 'mp4', mode = 'success') {
  const calls = [], downloads = [], revoked = []
  let jobs = [], note = '', encoded
  const task = { token: 'task', clip: 'clip', count: 8, fps: 30, format, status: 'rendering', bytes: 7, path: 'folder/demo-clip.' + format }
  const env = { createMediaPerformance, videoMetaOf: () => ({ clip: 'clip', kind }), target: 'demo.drawio',
    setVideoExportJobs(fn) { jobs = fn(jobs) }, setSaveNote(value) { note = value },
    async mediaAction(action, args) {
      calls.push(action)
      if (action === 'media-manifest') return { manifest: { source: mode === 'native' ? 'source.mp4' : null } }
      if (action === 'media-export-source') return { path: 'exported.mp4' }
      if (action === 'media-video-export-start') { if (mode === 'missing-ffmpeg') throw Error('未找到 FFmpeg'); return task }
      if (action === 'media-video-export-read') return { offset: mode === 'bad-download' ? 1 : args.offset, total: 7, bytes: 7, base64: Buffer.from('encoded').toString('base64') }
      assert.fail('browser must not render, upload frames, finish, or cancel a background export: ' + action)
    },
    document: { createElement(type) { assert.equal(type, 'a', 'background exports never create a canvas or media element'); return { click() { downloads.push(this.download) } } } },
    Image: class { constructor() { assert.fail('browser image decoding is forbidden') } },
    URL: { createObjectURL(blob) { encoded = blob; return 'blob:result' }, revokeObjectURL(url) { revoked.push(url) } },
  }
  const api = new Function(...Object.keys(env), body + '\nreturn { encodeVideoToFile, downloadVideoExport }')(...Object.values(env))
  if (mode === 'missing-ffmpeg') {
    await assert.rejects(api.encodeVideoToFile({}, format), /FFmpeg/)
    assert.equal(jobs.length, 0); return
  }
  await api.encodeVideoToFile({}, format)
  if (mode === 'native') { assert.deepEqual(calls, ['media-manifest', 'media-export-source']); return }
  assert.deepEqual(calls, ['media-manifest', 'media-video-export-start'], 'one start request is sufficient; no browser polling drives the job')
  assert.equal(jobs[0].token, 'task'); assert.match(note, /后台/)
  assert.equal(downloads.length, 0, 'result is persisted by the host; downloading is optional')
  if (mode === 'bad-download') {
    await assert.rejects(api.downloadVideoExport(task), /不完整/)
    assert.ok(!calls.includes('media-video-export-discard'), 'a download failure cannot delete or cancel the saved result'); return
  }
  await api.downloadVideoExport(task)
  assert.deepEqual(downloads, ['demo-clip.' + format])
  assert.equal(encoded.type, format === 'gif' ? 'image/gif' : 'video/' + format)
  assert.equal(await encoded.text(), 'encoded'); assert.deepEqual(revoked, ['blob:result'])
}
for (const format of ['mp4', 'webm', 'gif']) { await run('svg', format); await run('raster', format) }
await run('raster', 'mp4', 'native')
await run('svg', 'mp4', 'missing-ffmpeg'); await run('svg', 'gif', 'bad-download')
// Run the real progress effect through a view teardown and remount. Its cleanup
// may stop polling, but must never send a cancellation request to the host.
const effectStart = source.lastIndexOf('  React.useEffect(', source.indexOf("await mediaAction('media-video-export-list'"))
const effectCode = 'const [videoExportJobs, setVideoExportJobs] = React.useState([])\n' + source.slice(effectStart, source.indexOf('  React.useEffect(() => () => videoController.reset()', effectStart))
let state, cleanup, serverJobs = [{ token: 'background', status: 'rendering' }]
const timers = new Map(), listeners = new Map(), requests = []
let timerId = 0
const environment = { client: {}, hasPath: true, active: true, sessionId: 's', target: 'test.drawio',
  React: { useState: (value) => [value, (next) => { state = next }], useEffect(fn) { cleanup = fn() } },
  async mediaAction(action) { requests.push(action); assert.equal(action, 'media-video-export-list'); return { jobs: serverJobs } },
  document: { hidden: false, addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name) { listeners.delete(name) } },
  setTimeout(fn) { timers.set(++timerId, fn); return timerId }, clearTimeout(id) { timers.delete(id) },
}
const mount = () => new Function(...Object.keys(environment), effectCode)(...Object.values(environment))
const tick = () => new Promise((resolve) => setImmediate(resolve))
mount(); await tick(); assert.equal(state[0].status, 'rendering')
cleanup(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0)
serverJobs = [{ token: 'background', status: 'done', path: 'test-clip.gif' }]
mount(); await tick(); assert.equal(state[0].path, 'test-clip.gif', 'remount rediscovers the saved result')
listeners.get('visibilitychange')(); await tick()
assert.ok(requests.length >= 3, 'returning to the foreground refreshes task status')
cleanup()

const panelCode = source.slice(source.indexOf('function VideoExportJobs('), source.indexOf('function DrawingQueuePanel('))
const React = { useState: (value) => [value, () => {}], createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
const Panel = new Function('React', panelCode + '\nreturn VideoExportJobs')(React)
const flatten = (node) => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.children)] : []
let downloaded, discarded
const complete = { token: 'done', clip: 'clip', format: 'gif', status: 'done', path: 'saved.gif' }
const working = { token: 'running', clip: 'clip', format: 'mp4', status: 'rendering', received: 4, count: 10 }
const panel = flatten(Panel({ jobs: [complete, working], onDownload(job) { downloaded = job.token }, onDiscard(job) { discarded = job.token } }))
panel.find((node) => node.type === 'button' && node.children.includes('下载文件')).props.onClick()
assert.equal(downloaded, 'done')
panel.find((node) => node.type === 'button' && node.children.includes('取消导出')).props.onClick()
assert.equal(discarded, 'running')
console.log('check-video-audio: OK (host-only export startup, no canvas/Image/uploads, optional download, MIME, source passthrough and retained results)')
