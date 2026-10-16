import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { composeClientBody } from './build.mjs'
import { svgMarkupFromStyle } from '../src/style-kernel.js'
import * as plugin from '../lib/index.js'

let videoElement, inputElement, revoked = 0, decodeError = false
class FakeVideo extends EventTarget {
  videoWidth = 1920; videoHeight = 1080; duration = 5
  load() { if (this.src) this.dispatchEvent(new Event(decodeError ? 'error' : 'loadeddata')) }
  pause() {}
  removeAttribute() { this.src = '' }
}
class FakeFileReader {
  readAsDataURL(blob) { blob.arrayBuffer().then((bytes) => { if (!this.aborted) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(bytes).toString('base64'); this.onload() } }) }
  abort() { this.aborted = true; this.onabort?.() }
}
const document = { body: { appendChild() {} }, createElement(type) {
  if (type === 'video') return (videoElement = new FakeVideo())
  if (type === 'input') return (inputElement = { style: {}, click() {}, remove() {} })
  return { getContext() { return { drawImage() {} } }, toDataURL() { return 'data:image/png;base64,AA==' } }
} }
const React = { Component: class {} }
const mod = { exports: {} }
new Function('module', 'exports', 'require', 'document', 'URL', 'FileReader', composeClientBody())(
  mod, mod.exports, () => React, document, { createObjectURL() { return 'blob:test' }, revokeObjectURL() { revoked++ } }, FakeFileReader)
const { mediaFilesFromDataTransfer, hasMediaFileDrag, videoFileExtension, readVideoFile, uploadVideoFile, applyImportedVideoToDoc } = mod.exports.__routeInternals
const mp4 = { name: 'clip.MP4', type: '', size: 10 }, webm = { name: 'clip', type: 'video/webm', size: 10 }, image = { type: 'image/png' }
assert.equal(videoFileExtension(mp4), 'mp4')
assert.equal(videoFileExtension(webm), 'webm')
assert.equal(videoFileExtension({ name: 'x.txt', type: 'text/plain' }), null)
assert.deepEqual(mediaFilesFromDataTransfer({ files: [mp4, image, mp4] }), [mp4, image])
assert.deepEqual(mediaFilesFromDataTransfer({ items: [{ kind: 'file', getAsFile() { return webm } }] }), [webm])
assert.ok(hasMediaFileDrag({ types: ['Files'], items: [{ kind: 'file', getAsFile() { return null } }] }), 'protected drag data must still allow drop')
assert.equal(hasMediaFileDrag({ types: ['text/plain'] }), false)
const metadata = await readVideoFile(mp4, new AbortController().signal)
assert.equal(metadata.w, 1920)
assert.match(metadata.poster, /<image/)
assert.equal(revoked, 1)
decodeError = true
await assert.rejects(readVideoFile(mp4, new AbortController().signal), /解码失败/)
assert.equal(revoked, 2, 'decode failure releases URL')
decodeError = false
await assert.rejects(readVideoFile({ ...mp4, size: 49 * 1024 * 1024 }, new AbortController().signal), /48MB/)

const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const pendingVideoRef = { current: null }, videoImportsRef = { current: new Set() }, placement = [], imported = []
let note
const env = { hasPath: true, activeLayerLocked: () => false, videoImportsRef, pendingVideoRef, document,
  videoFileExtension, VIDEO_FILE_MAX_BYTES: 48 * 1024 * 1024,
  setSaveNote(value) { note = value }, setPlaceEdgeKind() {}, setSelectedIds() {}, setPlaceTool(value) { placement.push(value) }, setMenu() {} }
const pickerSource = clientSource.slice(clientSource.indexOf('  function openVideoFilePicker()'), clientSource.indexOf('  async function insertVideoFiles'))
const picker = new Function(...Object.keys(env), pickerSource + '\nreturn openVideoFilePicker')(...Object.values(env))
picker()
assert.equal(placement.length, 0, 'opening picker creates no placement or node')
inputElement.oncancel()
assert.equal(pendingVideoRef.current, null)
picker(); inputElement.files = [mp4]; inputElement.onchange()
assert.equal(pendingVideoRef.current, mp4)
assert.equal(placement.at(-1), 'video', 'only file selection arms placement')
assert.match(note, /点击画布/)
const createEnv = { ...env, docRef: { current: { nodes: [], edges: [] } },
  openVideoFilePicker: picker, insertVideoFiles(files, x, y) { imported.push({ files, x, y }) },
  applyLocal() { throw new Error('must not create an empty node') } }
const createSource = clientSource.slice(clientSource.indexOf('  function createNodeAt('), clientSource.indexOf('  /**\n   * 在空白处新建一条'))
const create = new Function(...Object.keys(createEnv), createSource + '\nreturn createNodeAt')(...Object.values(createEnv))
create('video', '', 100, 200)
assert.deepEqual(imported, [{ files: [mp4], x: 100, y: 200 }])
assert.equal(pendingVideoRef.current, null)
create('video', '', 0, 0)
assert.equal(imported.length, 1, 'video without a selected file reopens picker')
inputElement.oncancel()
picker(); const staleInput = inputElement
for (const control of videoImportsRef.current) control.abort()
staleInput.files = [mp4]; staleInput.onchange()
assert.equal(pendingVideoRef.current, null, 'switching canvas invalidates the pending picker')

const received = []
const transferEnv = { mediaFilesFromDataTransfer, hasMediaFileDrag, toUserSpace: () => ({ x: 75, y: 95 }), viewportCenterUser: () => ({ x: 0, y: 0 }),
  insertMediaFiles(files, x, y) { received.push({ files, x, y }) } }
const dropStart = clientSource.indexOf('        onDrop: (event) => {')
const dropCode = clientSource.slice(dropStart + '        onDrop: '.length, clientSource.indexOf('\n        },', dropStart) + 10)
const drop = new Function(...Object.keys(transferEnv), 'return (' + dropCode + ')')(...Object.values(transferEnv))
let prevented = 0
drop({ dataTransfer: { files: [mp4, image] }, preventDefault() { prevented++ } })
assert.equal(prevented, 1)
assert.deepEqual(received[0], { files: [mp4, image], x: 75, y: 95 })
const pasteEnv = { ...transferEnv, active: true, editing: null, rootRef: { current: {} }, document: { activeElement: {} },
  canvasOwnsKeyboard: () => true, isTextEntry: () => false, clipboard: null }
const pasteSource = clientSource.slice(clientSource.indexOf('    function onPaste(event)'), clientSource.indexOf("    window.addEventListener('paste'"))
const paste = new Function(...Object.keys(pasteEnv), pasteSource + '\nreturn onPaste')(...Object.values(pasteEnv))
paste({ clipboardData: { files: [webm] }, preventDefault() { prevented++ } })
assert.deepEqual(received[1], { files: [webm], x: 0, y: 0 })

mkdirSync('artifacts', { recursive: true })
const root = mkdtempSync(resolve('artifacts/video-import-'))
let route
plugin.apply({ tools: { register() { return () => {} } }, webServer: { register(r) { route = r; return () => {} } },
  fs: { async resolve(p, options) { return { path: resolve(options?.cwd || root, p) } }, processPath(t) { return t.path },
    contains(a, b) { const rel = relative(a.path, b.path); return !rel.startsWith('..') && !isAbsolute(rel) } },
  sessions: { get(id) { return ['s', 'other'].includes(id) ? { header: { cwd: root } } : undefined } },
  sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: root } } }, effect(fn) { return fn() } })
async function request(action, extra = {}) {
  const body = { sessionId: 's', path: 'demo.drawio', action, ...extra }, listeners = {}
  const req = { method: 'POST', headers: { 'x-drawai-save': '1' }, on(e, fn) { listeners[e] = fn; return this } }
  let status, payload
  const res = { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } }
  queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() })
  await route.handler(req, res)
  return { status, payload }
}
try {
  const bytes = Buffer.alloc(1024 * 1024 + 17, 123), blob = new Blob([bytes], { type: 'video/mp4' })
  Object.defineProperty(blob, 'name', { value: 'sample.mp4' })
  const offsets = [], chunks = [], progress = []
  const api = async (action, args) => {
    const { payload } = await request(action, args)
    if (!payload.ok) throw new Error(payload.error)
    if (action === 'media-upload-chunk') { offsets.push(args.offset); chunks.push(Buffer.from(args.base64, 'base64').length) }
    return payload
  }
  const result = await uploadVideoFile(blob, metadata, api, new AbortController().signal, (done) => progress.push(done))
  assert.deepEqual(offsets, [0, 1024 * 1024])
  assert.deepEqual(chunks, [1024 * 1024, 17])
  assert.equal(progress.at(-1), bytes.length)
  const dir = join(root, 'demo.media', result.clip)
  assert.deepEqual(readFileSync(join(dir, 'source.mp4')), bytes, 'chunk upload preserves exact source bytes')
  assert.equal(existsSync(join(dir, 'source.upload')), false)
  const doc = { nodes: [], edges: [], layers: [{ id: 'L1' }], meta: {} }
  const id = applyImportedVideoToDoc(doc, result, { x: 100, y: 200 }, 'L1')
  assert.equal(doc.nodes[0].id, id)
  assert.equal(doc.nodes[0].data.mediaKind, 'raster')
  assert.equal(doc.nodes[0].data.mediaW, '1920')
  assert.equal(svgMarkupFromStyle(doc.nodes[0].style), metadata.poster)
  assert.equal(doc.nodes[0].layer, 'L1')
  assert.ok(Math.abs(doc.nodes[0].w / doc.nodes[0].h - 16 / 9) < 0.02)
  doc.layers[0].locked = true
  assert.throws(() => applyImportedVideoToDoc(doc, result, { x: 0, y: 0 }, 'L1'), /锁定/)
  assert.throws(() => applyImportedVideoToDoc(doc, result, { x: 0, y: 0 }, 'deleted'), /删除/)
  const auth = { clip: result.clip, token: result.token }
  assert.equal((await request('media-upload-discard', { ...auth, sessionId: 'other' })).payload.ok, false)
  await api('media-upload-release', auth)
  assert.equal((await request('media-upload-discard', auth)).payload.ok, false)
  assert.ok(existsSync(dir), 'completed source cannot be deleted by stale upload token')
  const insertSource = clientSource.slice(clientSource.indexOf('  async function insertVideoFiles('), clientSource.indexOf('  function insertMediaFiles('))
  async function insertWorkflow(lockDuringUpload) {
    const current = { nodes: [], edges: [], layers: [{ id: 'L1' }], meta: {} }, docRef = { current }
    const undo = [], requests = []
    let selected, message, createdClip
    const environment = { hasPath: true, docRef, activeLayerId: 'L1', activeLayerLocked: () => false,
      videoImportsRef: { current: new Set() }, readVideoFile, uploadVideoFile, applyImportedVideoToDoc, GRID: 10,
      setSaveNote(value) { message = value }, setSelectedIds(value) { selected = value }, setMenu() {},
      applyLocal(mutate) { undo.push(structuredClone(docRef.current)); const next = structuredClone(docRef.current); mutate(next); docRef.current = next },
      mediaAction(action, args) {
        const call = api(action, args).then((payload) => {
          if (action === 'media-upload-start') createdClip = payload.clip
          if (action === 'media-upload-finish' && lockDuringUpload) current.layers[0].locked = true
          return payload
        })
        requests.push(call)
        return call
      },
    }
    const insert = new Function(...Object.keys(environment), insertSource + '\nreturn insertVideoFiles')(...Object.values(environment))
    await insert([blob], 123, 456)
    await Promise.all(requests)
    if (lockDuringUpload) {
      assert.equal(docRef.current.nodes.length, 0)
      assert.equal(undo.length, 0, 'a locked layer must not add an empty undo entry')
      assert.ok(!existsSync(join(root, 'demo.media', createdClip)))
      assert.match(message, /锁定/)
    } else {
      assert.equal(docRef.current.nodes.length, 1)
      assert.equal(undo.length, 1)
      assert.equal(selected[0], docRef.current.nodes[0].id)
      assert.equal(docRef.current.nodes[0].data.mediaClip, createdClip)
      assert.match(message, /已导入 1 个视频/)
    }
  }
  await insertWorkflow(false)
  await insertWorkflow(true)
  assert.equal((await request('media-upload-start', { extension: 'exe', size: 1, w: 1, h: 1 })).payload.ok, false)
  assert.equal((await request('media-upload-start', { extension: 'mp4', size: 1, w: 1, h: 1, path: '../escape.drawio' })).status, 403)
  let partial
  const cancel = new AbortController()
  await assert.rejects(uploadVideoFile(blob, metadata, async (action, args) => {
    const payload = await api(action, args)
    if (action === 'media-upload-start') partial = payload.clip
    if (action === 'media-upload-chunk') cancel.abort()
    return payload
  }, cancel.signal, () => {}), /取消/)
  assert.ok(!existsSync(join(root, 'demo.media', partial)), 'cancellation removes partial source')
  const failed = new AbortController()
  await assert.rejects(uploadVideoFile(blob, metadata, async (action, args) => {
    if (action === 'media-upload-chunk' && args.offset > 0) throw new Error('network failure')
    const payload = await api(action, args)
    if (action === 'media-upload-start') partial = payload.clip
    return payload
  }, failed.signal, () => {}), /network failure/)
  assert.ok(!existsSync(join(root, 'demo.media', partial)), 'upload failure removes partial source')
  console.log('check-video-import: OK (picker before placement, drag/paste, decoding, chunk roundtrip, cancellation, cleanup, poster and native video node)')
} finally { rmSync(root, { recursive: true, force: true }) }
