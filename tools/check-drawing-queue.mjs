import assert from 'node:assert/strict'
import { createDrawingQueue } from '../src/drawing-queue.js'
import { createCanvasSessionStore } from '../src/canvas-sessions.js'
import { buildMxfile, parseMxfile } from '../src/mxfile.js'
import { composeClientBody } from './build.mjs'

const tick = () => new Promise((done) => setTimeout(done, 0))
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
let ids = 0
const queue = createDrawingQueue({ id: () => 'job-' + ++ids }), order = [], first = deferred()
const input = (sourceId, path = 'one.drawio', sessionId = 'owner') => ({ kind: 'video', label: sourceId,
  scope: { sessionId, path, page: 0 }, source: { id: sourceId, clip: sourceId }, options: { colors: 6, level: 'medium' } })
try {
  const source = input('a')
  const a = queue.enqueue(source, async (_, frozenSource) => { order.push(frozenSource.id); await first.promise })
  source.source.id = 'mutated'
  assert.equal(queue.enqueue(input('a'), () => assert.fail('duplicate ran')).id, a.id)
  const b = queue.enqueue(input('b'), async () => { order.push('b'); throw new Error('expected failure') })
  const c = queue.enqueue(input('c'), async () => { order.push('c') })
  queue.move(c.id, -1)
  await tick(); assert.deepEqual(order, ['a'])
  queue.pauseQueue('owner', true); first.resolve(); await tick(); await tick()
  assert.equal(queue.list()[0].status, 'succeeded')
  assert.deepEqual(order, ['a'], 'pausing the queue lets active work finish and holds waiting jobs')
  queue.pauseQueue('owner', false); await tick(); await tick()
  assert.deepEqual(order, ['a', 'c', 'b'])
  assert.equal(queue.list().find((job) => job.id === b.id).error, 'expected failure')
  const retried = queue.retry(b.id)
  assert.notEqual(retried.id, b.id)
  await tick()
  assert.equal(queue.list().find((job) => job.id === retried.id).status, 'failed')

  const gate = deferred(), pausePoint = deferred(), resumed = deferred()
  const paused = queue.enqueue(input('pause'), async (context) => {
    pausePoint.resolve(); await gate.promise; await context.checkpoint(); resumed.resolve()
  })
  await pausePoint.promise
  queue.pause(paused.id); gate.resolve(); await tick()
  assert.equal(queue.list().find((job) => job.id === paused.id).status, 'paused')
  const same = queue.enqueue(input('same-page'), async () => { order.push('same-page') })
  queue.enqueue(input('other-page', 'two.drawio'), async () => { order.push('other-page') })
  await tick(); await tick()
  assert.ok(order.includes('other-page'), 'a drained paused video yields the compute slot to another canvas')
  assert.ok(!order.includes('same-page'), 'a second task cannot overwrite the paused canvas run')
  queue.resume(paused.id); await resumed.promise; await tick(); await tick()
  assert.ok(order.includes('same-page'))

  const store = createCanvasSessionStore({ onApplied: (id) => queue.applied(id), onSaved: (id) => queue.saved(id), onRestore: (id) => queue.restore(id) })
  const owner = store.task('owner', 'pending.drawio', 0)
  const ready = queue.enqueue(input('ready', 'pending.drawio'), async (context) => {
    context.ready(); store.publish(owner, { taskId: context.id, source: { id: 'ready' }, output: {} })
  })
  queue.enqueue(input('next', 'pending.drawio'), async () => { order.push('next') })
  queue.enqueue(input('unrelated', 'other.drawio'), async () => { order.push('unrelated') })
  await tick(); await tick()
  assert.ok(order.includes('unrelated') && !order.includes('next'), 'pending delivery releases compute but holds only its own page')
  let applied = 0
  store.consume(owner, () => { applied++ })
  assert.equal(queue.list().find((job) => job.id === ready.id).status, 'applied')
  queue.resultError(ready.id, new Error('save failed'))
  assert.equal(queue.list().find((job) => job.id === ready.id).error, 'save failed', 'automatic saving failures surface on the retained result')
  assert.equal(store.consume(owner, () => applied++), false)
  store.restore(owner, { nodes: [] })
  assert.ok(owner.result, 'reload after failed save restores the completed result')
  store.consume(owner, () => { applied++ })
  const doc = { version: 2, nodes: [{ id: 'n1', label: '', x: 0, y: 0, w: 10, h: 10, style: '', data: { drawaiTaskId: ready.id } }], edges: [], layers: [], meta: {} }
  const persisted = parseMxfile(buildMxfile(doc).text).doc
  assert.equal(persisted.nodes[0].data.drawaiTaskId, ready.id, 'delivery marker survives real drawio serialization')
  store.acknowledge(owner, { nodes: [] })
  assert.equal(queue.list().find((job) => job.id === ready.id).status, 'applied', 'an unrelated save cannot acknowledge a result')
  store.restore(owner, persisted)
  await tick(); await tick()
  assert.equal(queue.list().find((job) => job.id === ready.id).status, 'succeeded')
  assert.ok(order.includes('next'))
  assert.equal(applied, 2, 'restoring a missing result allows reapplication; saved result does not apply again')

  queue.pauseQueue('owner', true)
  let ran = false
  const cancelled = queue.enqueue(input('cancel'), async () => { ran = true })
  queue.cancel(cancelled.id); queue.pauseQueue('owner', false); await tick()
  assert.equal(ran, false)
  assert.equal(queue.list('other-owner').length, 0, 'another conversation never sees the task list')
  assert.ok(queue.list('owner').length > 0)
  queue.pauseQueue('owner', true)
  const closed = queue.enqueue(input('close'), async () => { assert.fail('closed canvas ran') })
  queue.closeScope('owner', 'one.drawio'); queue.pauseQueue('owner', false); await tick()
  assert.equal(queue.list().find((job) => job.id === closed.id).status, 'cancelled')
} finally { queue.dispose() }
const bounded = createDrawingQueue()
try {
  bounded.pauseQueue('owner', true)
  for (let i = 0; i < 16; i++) bounded.enqueue(input('bounded-' + i), async () => {})
  assert.throws(() => bounded.enqueue(input('overflow'), async () => {}), /队列已满/)
} finally { bounded.dispose() }

// Render the actual bundled panel and invoke its controls, without a browser shim for the scheduler.
const React = { Component: class {}, useState: (value) => [value, () => {}], useEffect() {},
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
const mod = { exports: {} }
const ui = new Function('module', 'exports', 'require', composeClientBody() + '\nreturn { DrawingQueuePanel, drawingQueue, canvasSessions }')(mod, mod.exports, () => React)
const flatten = (node) => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.children || [])] : []
const hold = deferred()
try {
  const job = ui.drawingQueue.enqueue(input('ui-preview'), async () => { await hold.promise })
  await tick()
  ui.canvasSessions.task('owner', 'one.drawio', 0).job = { svg: '<svg/>' }
  let panel = ui.DrawingQueuePanel({ sessionId: 'owner', path: 'one.drawio', page: 0 })
  assert.equal(panel.props['aria-label'], '绘制队列')
  assert.ok(flatten(panel).some((node) => node.type === 'img' && node.props.alt === '最近完成的绘制帧'))
  assert.equal(ui.DrawingQueuePanel({ sessionId: 'someone-else' }), null)
  flatten(panel).find((node) => node.type === 'button' && node.children.includes('暂停队列')).props.onClick()
  assert.equal(ui.drawingQueue.isPaused('owner'), true)
  ui.drawingQueue.enqueue(input('ui-waiting'), async () => {})
  panel = ui.DrawingQueuePanel({ sessionId: 'owner', path: 'one.drawio', page: 0 })
  assert.ok(flatten(panel).some((node) => node.type === 'button' && node.children.includes('上移')))
  flatten(panel).find((node) => node.type === 'button' && node.children.includes('取消')).props.onClick()
  assert.equal(ui.drawingQueue.list().find((item) => item.id === job.id).status, 'cancelling')
} finally { hold.resolve(); ui.drawingQueue.dispose(); await tick() }
console.log('check-drawing-queue: OK (FIFO/reorder, frozen inputs, pause/yield, scope isolation, retry/cancel, delivery/save acknowledgment and recovery)')
