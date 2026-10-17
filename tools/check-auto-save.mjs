import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Execute the real canvas saving functions with deferred transport, so a slow
// large-image request overlaps the next edit exactly as it does in the browser.
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('  async function saveNow()'), source.indexOf('  function snap(value)'))
const requests = [], notes = [], errors = [], acknowledgments = []
const refs = { docRef: { current: { nodes: [{ id: 'first' }] } }, dirtyRef: { current: true },
  revisionRef: { current: 'r0' }, saveInFlightRef: { current: null } }
const environment = { ...refs, client: {}, hasPath: true, sessionId: 's', target: 'test.drawio', pageIndex: 0,
  SAVE_ENDPOINT: '/save', SAVE_HEADER: 'x-drawai-save', videoTraceRun: { pendingSave: { taskId: 'task' } },
  setSaveNote: (note) => notes.push(note), drawingQueue: { resultError: (...args) => errors.push(args) },
  canvasSessions: { acknowledge: (_, doc) => acknowledgments.push(doc) },
  fetch: (_, options) => new Promise((resolve, reject) => requests.push({ body: JSON.parse(options.body),
    finish: (payload) => resolve({ json: async () => payload }), reject })) }
const saveNow = new Function(...Object.keys(environment), code + '\nreturn saveNow')(...Object.values(environment))
const first = saveNow()
refs.docRef.current = { nodes: [{ id: 'second' }] }; refs.dirtyRef.current = true
const second = saveNow()
assert.equal(requests.length, 1, 'only one save is in flight')
requests[0].finish({ ok: true, revision: 'r1' })
await first
await new Promise((resolve) => setImmediate(resolve))
assert.equal(requests.length, 2)
assert.equal(requests[1].body.revision, 'r1', 'later edits use the acknowledged revision')
assert.equal(requests[1].body.doc.nodes[0].id, 'second')
requests[1].finish({ ok: true, revision: 'r2' }); await second
assert.equal(acknowledgments.length, 2, 'saving acknowledges results without any confirmation click')
refs.dirtyRef.current = true
const failed = saveNow(); requests[2].reject(new Error('offline')); await failed
assert.equal(refs.dirtyRef.current, true)
assert.match(errors.at(-1)[1], /offline/)
const retry = saveNow(); requests[3].finish({ ok: true, revision: 'r3' }); await retry
assert.equal(refs.dirtyRef.current, false)
assert.equal(refs.saveInFlightRef.current, null)
console.log('check-auto-save: OK (serialized saves, latest snapshot/revision, automatic acknowledgment and retry)')
