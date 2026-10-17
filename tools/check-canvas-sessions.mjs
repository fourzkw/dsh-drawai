import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCanvasSessionStore } from '../src/canvas-sessions.js'
import { composeClientBody } from './build.mjs'

// Small hook runner that actually runs dependency cleanups and remounts.
function hooks() {
  const values = [], dependencies = [], cleanups = []
  let cursor = 0, pending = []
  return {
    Component: class {},
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const i = cursor++
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
      return [values[i], (value) => { values[i] = typeof value === 'function' ? value(values[i]) : value }]
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in values)) values[i] = { current: initial }
      return values[i]
    },
    useEffect(effect, deps) {
      const i = cursor++
      if (!dependencies[i] || deps.some((dep, index) => !Object.is(dep, dependencies[i][index]))) {
        pending.push(() => { cleanups[i]?.(); cleanups[i] = effect(); dependencies[i] = deps })
      }
    },
    render(fn) { cursor = 0; const tree = fn(); const effects = pending; pending = []; effects.forEach((run) => run()); return tree },
    unmount() { cleanups.forEach((cleanup) => cleanup?.()) },
  }
}
const flatten = (node) => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.children || [])] : []
let currentHooks
const React = new Proxy({}, { get(_, name) { return currentHooks[name] } })
currentHooks = hooks()
const module = { exports: {} }
const { CanvasTabs, CanvasStage, canvasSessions } = new Function('module', 'exports', 'require',
  composeClientBody() + '\nreturn { CanvasTabs, CanvasStage, canvasSessions }')(module, module.exports, () => React)
function mountTabs(sessionId, tabPath) {
  const runtime = hooks()
  return {
    render() {
      currentHooks = runtime
      return runtime.render(() => CanvasTabs({ sessionId, tabPath }))
    },
    unmount() { runtime.unmount() },
  }
}
const panes = (tree) => flatten(tree).filter((node) => node.type?.name === 'CanvasView')
let ui = mountTabs('chat-a')
let tree = ui.render()
assert.equal(panes(tree)[0].props.empty, true, 'first visit has an empty stage')
panes(tree)[0].props.onOpenTab('one.drawio')
tree = ui.render()
panes(tree)[0].props.onOpenTab('two.drawio')
tree = ui.render()
assert.deepEqual(panes(tree).map((pane) => pane.props.path), ['one.drawio', 'two.drawio'])
const job = canvasSessions.task('chat-a', 'one.drawio', 0)
job.current = new AbortController()
job.source = { id: 'video', clip: 'source' }
job.job = { busy: true, done: 7, total: 20 }
ui.unmount()
ui = mountTabs('chat-b')
assert.equal(panes(ui.render())[0].props.empty, true, 'another conversation never inherits tabs')
ui.unmount()
ui = mountTabs('chat-a', 'one.drawio')
tree = ui.render()
assert.deepEqual(panes(tree).map((pane) => pane.props.path), ['one.drawio', 'two.drawio'], 'returning to a conversation restores both tabs')
assert.equal(panes(tree).find((pane) => pane.props.active).props.path, 'two.drawio', 'active tab is restored')
assert.equal(job.job.done, 7)
assert.equal(job.current.signal.aborted, false, 'host remount never cancels the task')
currentHooks = hooks()
assert.notEqual(CanvasStage({ sessionId: 'chat-a' }).props.key, CanvasStage({ sessionId: 'chat-b' }).props.key, 'conversation switches recreate the correctly scoped tabs')
const firstTab = flatten(panes(tree).find((pane) => pane.props.active).props.tabStrip).find((node) => node.props.title === 'one.drawio' && node.type === 'button')
firstTab.props.onClick()
tree = ui.render()
assert.equal(panes(tree).find((pane) => pane.props.active).props.path, 'one.drawio')
const closeButtons = flatten(panes(tree).find((pane) => pane.props.active).props.tabStrip).filter((node) => node.props.title === '关闭这个标签')
closeButtons[0].props.onClick()
assert.equal(job.current.signal.aborted, true, 'explicitly closing the drawing canvas cancels its task')
ui.unmount()

// Exercise the actual task effects against a scope change and a UI remount.
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const lifecycle = source.slice(source.indexOf('  const videoTraceRun = canvasSessions.task('), source.indexOf('  async function startVideoTrace('))
const store = createCanvasSessionStore()
const task = store.task('owner', 'original.drawio', 1)
task.current = new AbortController()
task.source = { id: 'video', clip: 'source' }
task.job = { busy: true, done: 3 }
let doc = { nodes: [{ id: 'video', clip: 'source' }] }, active = true, currentTask = task, applied = 0
let runtime = hooks()
const docRef = { current: doc }, loadedDocumentRef = { current: task }
function renderTask(sessionId = 'owner', path = 'original.drawio', pageIndex = 1) {
  const environment = {
    React: runtime, canvasSessions: store, sessionId, target: path, pageIndex, doc, active,
    loadedDocumentRef, status: { kind: 'ready' }, videoMetaOf: (node) => ({ clip: node.clip }),
    applyLocal(mutate) { mutate(docRef.current) },
    applyVideoTraceToDoc(next, resultSource, output) {
      assert.equal(currentTask, task, 'result must be delivered to its original scope')
      assert.equal(resultSource, task.source)
      if (next.locked) throw new Error('locked')
      applied++
      next.nodes.push({ id: output.clip })
      return output.clip
    },
    setSelectedIds() {}, setSaveNote() {},
  }
  return runtime.render(() => new Function(...Object.keys(environment), lifecycle + '\nreturn videoTraceRun')(...Object.values(environment)))
}
renderTask()
active = false
renderTask()
assert.equal(task.current.signal.aborted, false, 'inactive canvas keeps drawing')
runtime.unmount()
assert.equal(task.listeners.size, 0, 'unmount unsubscribes progress UI only')
assert.equal(task.current.signal.aborted, false)
store.update(task, { job: { busy: false, done: 20 }, result: { source: task.source, output: { clip: 'finished' } } })
assert.equal(applied, 0, 'background completion does not mutate an unmounted document')
assert.notEqual(store.task('other-chat', 'original.drawio', 1), task)
assert.notEqual(store.task('owner', 'other.drawio', 1), task)
assert.notEqual(store.task('owner', 'original.drawio', 0), task)
runtime = hooks()
doc = null
docRef.current = null
loadedDocumentRef.current = null
renderTask()
assert.equal(task.current.signal.aborted, false, 'initial empty state during remount is not node deletion')
assert.ok(task.result)
doc = { nodes: [] }
docRef.current = doc
currentTask = store.task('owner', 'original.drawio', 0)
loadedDocumentRef.current = currentTask
renderTask('owner', 'original.drawio', 1)
assert.equal(applied, 0, 'previous page document cannot receive a result before the requested page loads')
doc = { nodes: [{ id: 'video', clip: 'source' }], locked: true }
docRef.current = doc
currentTask = task
loadedDocumentRef.current = task
renderTask()
assert.ok(task.result, 'failed insertion keeps the completed result for retry')
doc = { ...doc, locked: false }
docRef.current = doc
renderTask()
renderTask()
assert.equal(applied, 1, 'restored original page receives the finished result exactly once')
assert.equal(task.result, null)
runtime.unmount()
const other = store.task('owner', 'other.drawio', 0)
other.current = new AbortController()
store.dispose()
assert.equal(other.current.signal.aborted, true, 'plugin shutdown cancels remaining work')
console.log('check-canvas-sessions: OK (tab restoration, scope isolation, background completion, retry, cancellation and remount effects)')
