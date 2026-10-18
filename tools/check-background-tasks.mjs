import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Resvg } from '@resvg/resvg-js'
import { createDrawingTaskManager } from '../src/drawing-tasks.js'
import { createVideoTracePool } from '../src/video-trace-pool.js'
import { createDocumentCoordinator, createMediaWorkSlots } from '../src/task-coordinator.js'
import { probeDrawingVideo, planDrawingVideo, executeDrawing } from '../src/drawing-runner.js'
import { ffmpegBinary } from '../src/video-export.js'
import { ensureClipPack, writeManifest, readManifest, clipDirFor, videoDataAttrs } from '../src/media.js'
import { buildMxfile, parseMxfile, contentHash } from '../src/mxfile.js'
import { applyTaskPatches } from '../src/task-patches.js'
import * as plugin from '../lib/index.js'

const root = mkdtempSync(resolve('_local/background-test-'))
const pool = createVideoTracePool({ size: 2 })
const disposers = [], tools = new Map()
let route
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#212028"/><path d="M12 8H40V40H12Z" fill="#244dbe"/><circle cx="32" cy="16" r="6" fill="#edb278"/></svg>').render().asPng()
const image = 'data:image/png;base64,' + png.toString('base64')
const node = { id: 'image', x: 10, y: 20, w: 64, h: 48, label: '', style: 'shape=image;image=' + image + ';' }
const file = join(root, 'demo.drawio')
writeFileSync(file, buildMxfile({ version: 2, nodes: [node], edges: [], labels: [], layers: [], meta: {} }).text)
plugin.apply({ tools: { register(value) { tools.set(value.name, value); return () => {} } },
  webServer: { register(value) { route = value; return () => {} } },
  fs: { async resolve(path, opts) { return { path: resolve(opts?.cwd || root, typeof path === 'object' ? path.path : path) } },
    processPath(value) { return value.path }, contains(a, b) { const rel = relative(a.path, b.path); return !rel.startsWith('..') && !isAbsolute(rel) },
    async stat(target) { return existsSync(target.path) ? statSync(target.path) : undefined },
    async readText(target) { return readFileSync(target.path, 'utf8') }, async writeText(target, value) { writeFileSync(target.path, value) } },
  sessions: { get(id) { return ['owner', 'other'].includes(id) ? { header: { cwd: root } } : undefined } },
  sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: root } } },
  effect(fn) { const result = fn(); if (typeof result === 'function') disposers.push(result); return result } })
async function request(action, extra = {}) {
  const listeners = {}, body = { sessionId: 'owner', path: 'demo.drawio', action, ...extra }
  const req = { method: 'POST', headers: { 'x-drawai-save': '1' }, on(name, fn) { listeners[name] = fn; return this } }
  let status, payload
  queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() })
  await route.handler(req, { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } })
  return { status, ...payload }
}
const delay = () => new Promise((resolve) => setTimeout(resolve, 15))
async function until(read, test) {
  const end = Date.now() + 45000
  while (Date.now() < end) { const value = await read(); if (test(value)) return value; await delay() }
  throw new Error('Timed out waiting for background task')
}
let manager
try {
  const coordinator = createDocumentCoordinator(), order = []
  await Promise.all([coordinator.run(file, async () => { order.push(1); await delay(); await coordinator.run(file, () => order.push(2)) }), coordinator.run(file, () => order.push(3))])
  assert.deepEqual(order, [1, 2, 3], 'writers serialize, including reentrant AI operations')
  const slots = createMediaWorkSlots(1), release = await slots.acquire(), controller = new AbortController()
  const aborted = slots.acquire(controller.signal); controller.abort(); await assert.rejects(aborted); release()
  const options = { level: 'medium', preset: 'default', colors: 24, removeBg: false }
  const old = parseMxfile(readFileSync(file, 'utf8')).doc
  const first = await request('drawing-task-start', { kind: 'image', sourceId: 'image', page: 0, options, revision: old.revision })
  assert.equal(first.ok, true, first.error)
  // Do not query the browser protocol while the host computes and delivers.
  await until(() => parseMxfile(readFileSync(file, 'utf8')).doc, (doc) => doc.nodes.length === 2)
  const firstState = await until(() => request('drawing-task-list'), (res) => res.jobs[0]?.delivery === 'applied')
  assert.equal(firstState.jobs[0].status, 'succeeded')
  const output = await request('drawing-task-result', { taskId: first.job.id })
  assert.ok(output.output.svg.includes('<svg') && output.output.drawing.steps.length)
  assert.equal((await request('drawing-task-result', { sessionId: 'other', taskId: first.job.id })).ok, false)
  old.nodes[0].x = 77
  const saved = await request(undefined, { revision: old.revision, doc: old, page: 0 })
  assert.equal(saved.ok, true, saved.error)
  assert.ok(saved.backgroundPatch)
  let current = parseMxfile(readFileSync(file, 'utf8')).doc
  assert.equal(current.nodes.length, 2); assert.equal(current.nodes[0].x, 77, 'a stale UI save keeps generated nodes and local edits')
  assert.equal((await request('drawing-task-command', { taskId: first.job.id, command: 'apply' })).ok, true)
  assert.equal(parseMxfile(readFileSync(file, 'utf8')).doc.nodes.length, 2, 'delivery is idempotent')
  const beforeUndo = structuredClone(current)
  const undone = await request('drawing-task-command', { taskId: first.job.id, command: 'undo' })
  assert.equal(undone.ok, true, undone.error)
  assert.equal(parseMxfile(readFileSync(file, 'utf8')).doc.nodes.length, 1)
  beforeUndo.nodes[1].x += 10
  const unsafe = await request(undefined, { revision: beforeUndo.revision, doc: beforeUndo, page: 0 })
  assert.equal(unsafe.ok, false, 'undo never silently deletes unsent edits from another view')
  assert.equal((await request('drawing-task-command', { taskId: first.job.id, command: 'apply' })).ok, true)
  current = parseMxfile(readFileSync(file, 'utf8')).doc
  current.nodes.find((item) => item.data?.drawaiTaskId).data.custom = 'keep me'
  assert.equal((await request(undefined, { revision: current.revision, doc: current, page: 0 })).ok, true)
  assert.equal((await request('drawing-task-command', { taskId: first.job.id, command: 'undo' })).ok, false, 'edited generated data prevents destructive undo')

  const scope = { workspaceRoot: root, sessionId: 'queue-test', path: 'demo.drawio', drawioAbs: file, page: 0, pageId: null, pageNames: ['page'] }
  let committed = 0
  manager = createDrawingTaskManager({ pool, commit: async () => { committed++; throw new Error('source changed') } })
  const one = await manager.enqueue(scope, { kind: 'image', source: { id: 'a', signature: 'a' }, options, label: 'a' }, png)
  const two = await manager.enqueue(scope, { kind: 'image', source: { id: 'b', signature: 'b' }, options, label: 'b' }, png)
  await until(() => manager.list(scope), (jobs) => jobs.every((job) => job.status === 'succeeded' && job.delivery === 'conflict'))
  assert.equal(committed, 2, 'pending delivery never blocks later computations')
  await manager.command(scope, null, 'pause-queue', true)
  const queued = await manager.enqueue(scope, { kind: 'image', source: { id: 'c', signature: 'c' }, options, label: 'c' }, png)
  assert.equal(manager.list(scope).find((job) => job.id === queued.id).status, 'queued')
  if (process.platform === 'win32') {
    const alias = await manager.enqueue({ ...scope, drawioAbs: file.toUpperCase(), workspaceRoot: root.toUpperCase() }, { kind: 'image', source: { id: 'c', signature: 'c' }, options, label: 'c' }, png)
    assert.equal(alias.id, queued.id, 'Windows path aliases refer to the same queued task')
  }
  await manager.close()
  manager = createDrawingTaskManager({ pool, commit: async () => ({ nodeId: 'result' }) })
  assert.equal(manager.list(scope).find((job) => job.id === queued.id).status, 'interrupted')
  await manager.command(scope, queued.id, 'resume'); await manager.command(scope, null, 'pause-queue', false)
  await until(() => manager.list(scope), (jobs) => jobs.find((job) => job.id === queued.id).status === 'succeeded')

  if (!spawnSync(ffmpegBinary(), ['-version'], { windowsHide: true }).error) {
    const video = join(root, 'source.mp4')
    const encoded = spawnSync(ffmpegBinary(), ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=30000/1001', '-frames:v', '9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { windowsHide: true })
    assert.equal(encoded.status, 0, String(encoded.stderr))
    const info = await probeDrawingVideo(video, new AbortController().signal)
    assert.deepEqual([info.w, info.h], [64, 48])
    const videoOptions = { ...options, range: 'all', fps: 30000 / 1001, resolution: '0' }
    assert.equal(planDrawingVideo(videoOptions, info).count, 9, 'fractional FPS preserves final sample')
    const job = await manager.enqueue(scope, { kind: 'video', source: { id: 'v', clip: 'clip-source', signature: 'video', extension: '.mp4' }, options: videoOptions, label: 'video' }, video)
    const completed = await until(() => manager.list(scope), (jobs) => ['succeeded', 'failed'].includes(jobs.find((item) => item.id === job.id).status))
    const state = completed.find((item) => item.id === job.id)
    assert.equal(state.status, 'succeeded', state.error)
    assert.equal(readManifest(clipDirFor(file, state.outputClip)).frames.length, 9)
    const pack = ensureClipPack(file, 'original', { kind: 'raster', w: 64, h: 48, fps: 30 })
    writeFileSync(join(pack.dir, 'source.mp4'), readFileSync(video)); writeManifest(pack.dir, { ...pack.manifest, source: 'source.mp4' })
    const extract = await manager.enqueue(scope, { kind: 'extract', source: { id: 'v', clip: 'original', signature: 'original' }, options: { ...options, from: 0, seconds: 0.2, fps: 10, width: 64, max: 10 }, label: 'extract' }, video)
    const extracted = await until(() => manager.list(scope), (jobs) => ['succeeded', 'failed'].includes(jobs.find((item) => item.id === extract.id).status))
    assert.equal(extracted.find((job) => job.id === extract.id).status, 'succeeded', JSON.stringify(extracted))
    assert.ok(existsSync(join(pack.dir, 'stills', '0002.png')))
    const canvas = parseMxfile(readFileSync(file, 'utf8')).doc
    canvas.nodes.push({ id: 'native-video', x: 1, y: 2, w: 64, h: 48, label: '', style: '', data: videoDataAttrs({ clip: 'original', kind: 'raster', w: 64, h: 48, fps: 30 }) })
    canvas.drawOrder?.push('native-video'); writeFileSync(file, buildMxfile(canvas).text)
    const aiExtraction = await tools.get('diagram_apply').execute({ path: 'demo.drawio', ops: [{ op: 'extractFrames', id: 'native-video', seconds: 0.1, fps: 10, width: 64, max: 10 }] }, { agent: { id: 'owner' } })
    assert.equal(aiExtraction.extract.status, 'pending')
    assert.equal((await request('read')).media, null, 'AI extraction never delegates decoding back to a browser')
    await until(() => request('drawing-task-list'), (res) => res.jobs.some((job) => job.kind === 'extract' && ['succeeded', 'failed'].includes(job.status)))
    assert.equal((await request('drawing-task-list')).jobs.find((job) => job.kind === 'extract').status, 'succeeded')
    assert.ok(!existsSync(join(pack.dir, 'stills', '0002.png')), 'publishing a shorter extraction removes stale tail frames')
    await request('drawing-task-command', { command: 'pause-queue', value: true })
    const submission = { kind: 'video', sourceId: 'native-video', page: 0, options: videoOptions }
    const originalTask = await request('drawing-task-start', submission)
    assert.equal(originalTask.ok, true, originalTask.error)
    assert.equal((await request('drawing-task-start', submission)).job.id, originalTask.job.id)
    writeFileSync(join(pack.dir, 'source.mp4'), Buffer.concat([readFileSync(video), Buffer.from('updated-source')]))
    const changedTask = await request('drawing-task-start', submission)
    assert.equal(changedTask.ok, true, changedTask.error)
    assert.notEqual(changedTask.job.id, originalTask.job.id, 'replacing bytes under the same media ID cannot deduplicate into the old task')
    for (const taskId of [originalTask.job.id, changedTask.job.id]) await request('drawing-task-command', { taskId, command: 'cancel' })
    await request('drawing-task-command', { command: 'pause-queue', value: false })
    // Pause after a committed boundary, then compare exact decoded samples to
    // an uninterrupted run. Hashing raw pixels isolates seek/timestamp errors.
    const rawPool = { size: 2, async runRaster(raster) { return { svg: '<svg>' + createHash('sha256').update(raster.data).digest('hex') + '</svg>' } } }
    const makeJob = (id, opts = videoOptions) => {
      const directory = join(root, id); mkdirSync(directory)
      return { id, directory, input: video, scope, options: opts, kind: 'video', source: { extension: '.mp4' }, done: 0 }
    }
    const pausedJob = makeJob('paused')
    const context = (pauseRequested) => ({ pool: rawPool, signal: new AbortController().signal, checkpoint() {}, update(patch) {}, pauseRequested })
    assert.equal(await executeDrawing(pausedJob, context(() => pausedJob.done >= 3)), null)
    assert.ok(pausedJob.done >= 3 && pausedJob.done < 9)
    const pausedDone = await executeDrawing(pausedJob, context(() => false))
    const reference = await executeDrawing(makeJob('reference'), context(() => false))
    for (let index = 1; index <= 9; index++) {
      const name = String(index).padStart(4, '0') + '.svg'
      assert.equal(readFileSync(join(clipDirFor(file, pausedDone.clip), 'frames', name), 'utf8'), readFileSync(join(clipDirFor(file, reference.clip), 'frames', name), 'utf8'), 'resume retains the sampling grid for frame ' + index)
    }
    writeFileSync(join(clipDirFor(file, pausedDone.clip), 'frames', '0001.svg'), '<svg>tampered</svg>')
    await assert.rejects(executeDrawing(pausedJob, context(() => false)), /检查点帧已变化/)
    const short = await executeDrawing(makeJob('short', { ...videoOptions, fps: 0.5 }), context(() => false))
    assert.equal(short.count, 1, 'short clips still produce their first sample at a low output FPS')
  }
  console.log('check-background-tasks: OK (native image/video/extract, unattended queue, revision patches, undo protection, ownership, cancellation and restart recovery)')
} finally {
  await manager?.close(); pool.close()
  for (const dispose of disposers.reverse()) await dispose()
  assert.ok(relative(resolve('_local'), root) && !relative(resolve('_local'), root).startsWith('..'))
  rmSync(root, { recursive: true, force: true })
}
