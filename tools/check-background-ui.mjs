import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyTaskPatches } from '../src/task-patches.js'

// Run the actual queue component and invoke its controls with persistent hooks.
const states = []; let cursor = 0
const React = { useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial
  return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false) } } }
const Component = new Function('React', 'writeClipboardText', readFileSync(new URL('../src/background-task-panel.js', import.meta.url), 'utf8') + '\nreturn BackgroundTaskPanel')(React, async () => {})
const calls = []
const props = { path: 'demo.drawio', page: 0, exports: [], jobs: [], onCommand: async (...args) => calls.push(args), onOpen: (path) => calls.push(path) }
const job = (id, status, more = {}) => ({ id, status, kind: 'video', label: id, scope: { path: 'demo.drawio', page: 0 }, options: { colors: 24 }, ...more })
props.jobs = [job('running', 'running', { total: 30, done: 12, phase: 'tracing' }), job('first', 'queued'), job('last', 'queued'),
  job('interrupted', 'interrupted'), job('conflict', 'succeeded', { delivery: 'conflict', error: 'source changed' }), job('done', 'succeeded', { delivery: 'applied' })]
const render = () => { cursor = 0; return Component(props) }
const all = (node) => typeof node === 'object' ? [node, ...node.children.flatMap(all)] : []
const text = (node) => typeof node === 'object' ? node.children.map(text).join('') : String(node)
const button = (tree, label) => all(tree).find((node) => node.type === 'button' && text(node) === label)
let tree = render()
assert.equal(all(tree).filter((node) => node.type === 'article').length, 5, 'active filter also exposes conflicts and interrupted work')
assert.ok(text(tree).includes('12/30 帧 · 40%'))
assert.equal(all(tree).find((node) => node.type === 'progress').props.value, 40)
const waiting = all(tree).find((node) => node.type === 'article' && text(node).startsWith('first'))
assert.equal(button(waiting, '上移').props.disabled, true)
assert.equal(button(waiting, '下移').props.disabled, false)
await button(waiting, '下移').props.onClick()
assert.equal(calls.at(-1)[1], 'move'); assert.equal(calls.at(-1)[2], 1)
button(tree, '已结束').props.onClick(); tree = render()
assert.equal(all(tree).filter((node) => node.type === 'article').length, 1)
assert.ok(button(tree, '撤销生成'))
button(tree, '需处理').props.onClick(); tree = render()
assert.equal(all(tree).filter((node) => node.type === 'article').length, 2)
props.onCommand = async () => { throw new Error('cannot resume') }
await button(tree, '继续').props.onClick(); tree = render()
assert.ok(all(tree).some((node) => node.props.role === 'alert' && text(node).includes('cannot resume')))
button(tree, '全部').props.onClick(); tree = render()
assert.equal(all(tree).filter((node) => node.type === 'article').length, 6)
button(tree, '收起').props.onClick(); tree = render()
assert.equal(all(tree).filter((node) => node.type === 'article').length, 0)
props.onHide = () => { props.hidden = true }
tree = render()
button(tree, '隐藏').props.onClick()
assert.equal(render(), null, 'hiding removes the whole task panel')
props.hidden = false
tree = render(); button(tree, '展开').props.onClick(); tree = render()
assert.equal(all(tree).filter((node) => node.type === 'article').length, 6, 'showing the panel retains task records and the selected filter')
const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const taskButtonCode = client.slice(client.indexOf('    const activeTaskCount ='), client.indexOf('    const rail = React.createElement(', client.indexOf('    const activeTaskCount =')))
let preference
const taskButtons = (shown) => new Function('React', 'backgroundDrawingJobs', 'videoExportJobs', 'showTaskList', 'patchPrefs', 'railIcon', 'chips', taskButtonCode + '\nreturn chips')(
  React, props.jobs, [], shown, (patch) => { preference = patch }, () => null, [])
let toggle = taskButtons(false).find((node) => node.type === 'button')
assert.equal(toggle.props['aria-expanded'], false)
toggle.props.onClick(); assert.equal(preference.showTaskList, true)
toggle = taskButtons(true).find((node) => node.type === 'button')
assert.equal(toggle.props['aria-expanded'], true)
toggle.props.onClick(); assert.equal(preference.showTaskList, false)
const merger = client.slice(client.indexOf('  function mergeBackgroundHistory('), client.indexOf('  function resetHistory('))
const historyRef = { current: { past: [{ nodes: [{ id: 'source', x: 1 }], edges: [] }], future: [{ nodes: [{ id: 'source', x: 3 }], edges: [] }] } }
const docRef = { current: { nodes: [{ id: 'source', x: 2 }], edges: [] } }, lastCoalesceRef = { current: 'drag' }
new Function('historyRef', 'docRef', 'lastCoalesceRef', 'applyTaskPatches', 'cloneDoc', 'setDoc', merger + '\nmergeBackgroundHistory({added:[{id:"generated"}]})')(historyRef, docRef, lastCoalesceRef, applyTaskPatches, structuredClone, () => {})
assert.equal(docRef.current.nodes[0].x, 2)
assert.equal(historyRef.current.past[0].nodes[0].x, 1)
assert.ok(historyRef.current.past.concat(historyRef.current.future, docRef.current).every((doc) => doc.nodes.some((node) => node.id === 'generated')), 'ordinary undo retains separately generated nodes')
const submitCode = client.slice(client.indexOf('  async function submitBackgroundDrawing('), client.indexOf('  async function enqueueVideoTrace('))
const sent = [], revisionRef = { current: 'old' }
const environment = { async saveNow() { sent.push('save'); revisionRef.current = 'saved' }, dirtyRef: { current: false }, saveInFlightRef: { current: null },
  pageIndex: 2, revisionRef, autoReplayTasks: { current: new Set() }, setBackgroundDrawingJobs() {}, setSaveNote() {},
  async mediaAction(action, body) { sent.push({ action, body }); return { job: { id: 'task' } } } }
const submit = new Function(...Object.keys(environment), submitCode + '\nreturn submitBackgroundDrawing')(...Object.values(environment))
await submit('image', { id: 'source', image: 'large-raster-data' }, { colors: 24 })
assert.equal(sent[0], 'save'); assert.equal(sent[1].action, 'drawing-task-start')
assert.equal(sent[1].body.revision, 'saved'); assert.equal(sent[1].body.page, 2)
assert.equal(sent[1].body.image, undefined, 'queue submission references the saved asset without another base64 upload')
console.log('check-background-ui: OK (filters, progress, ordering, pause/recovery controls, local errors and collapse)')
