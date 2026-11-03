import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDrawingTaskManager } from '../src/drawing-tasks.js'
import { createVideoExportManager } from '../src/video-export.js'
import { createDocumentCommands } from '../src/document-commands.js'
import { emptyDocument, documentTransaction, cloneDocument } from '../src/document-core.js'
import { migrateMxfile, parseCanvas, applyCanvas, buildCanvas, exportCanvasToMxfile, migrateCanvasFile } from '../src/canvas-format.js'
import { parseMxfile } from '../src/mxfile.js'
import { mediaRootFor, packCanvasBundle, unpackCanvasBundle } from '../src/media.js'

const model = '<mxGraphModel pageWidth="1200" pageHeight="800"><root><mxCell id="0"/><mxCell id="1" parent="0" value="图层"/>' +
  '<object id="a" label="参考图" custom="keep"><mxCell vertex="1" parent="1" style="rounded=1;rotation=30"><mxGeometry x="10" y="20" width="100" height="80" as="geometry"/></mxCell></object>' +
  '<mxCell id="e" edge="1" parent="1" source="a" target="a"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="140" y="100"/></Array></mxGeometry></mxCell>' +
  '<mxCell id="opaque" parent="1" vendor="unknown"/><VendorExtension exact="keep"/></root></mxGraphModel>'
const xml = '<mxfile vendor="keep"><diagram id="first" name="第一张">' + model + '</diagram><diagram id="second" name="第二张">' + model + '</diagram></mxfile>'
const native = migrateMxfile(xml, 'old.drawio')
const project = JSON.parse(native)
assert.equal(project.compat.drawio, xml)
assert.equal(project.pages.length, 2)
assert.deepEqual(parseCanvas(native, { page: 1 }).doc.nodes.map((node) => ({ ...node, style: node.style.replace(/;$/, '') })), parseMxfile(xml, { page: 1 }).doc.nodes)
assert.deepEqual(parseCanvas(native).doc.drawOrder, ['a', 'e'])
assert.equal(parseCanvas(native).doc.page.w, 1200)
assert.equal(parseCanvas(native).doc.nodes[0].data.custom, 'keep')

const doc = parseCanvas(native).doc
doc.nodes[0].x = 500
doc.nodes[0].creation = { references: [{ assetId: 'image-1', role: 'firstFrame' }] }
doc.drawOrder = ['e', 'a']
const updated = applyCanvas(native, doc).text
assert.equal(parseCanvas(updated).doc.nodes[0].x, 500)
assert.deepEqual(parseCanvas(updated).doc.nodes[0].creation, doc.nodes[0].creation)
assert.deepEqual(parseCanvas(updated).doc.drawOrder, ['e', 'a'])
assert.deepEqual(JSON.parse(updated).pages[1], project.pages[1])
assert.equal(JSON.parse(updated).compat.drawio, xml)
const exported = exportCanvasToMxfile(updated)
assert.equal(parseMxfile(exported).doc.nodes[0].x, 500)
assert.match(exported, /<VendorExtension exact="keep"\/>/)
assert.match(exported, /vendor="unknown"/)
assert.equal(parseMxfile(exported, { page: 1 }).doc.nodes[0].x, 10)
assert.throws(() => parseCanvas(JSON.stringify({ ...project, schemaVersion: 99 })), /版本/)
assert.throws(() => applyCanvas(native, doc, { page: 10 }), /页面/)
assert.throws(() => parseCanvas('{"format":"dsh-drawai"}'), /版本/)

const commands = createDocumentCommands({ rename: (draft, command) => { draft.nodes[0].label = command.label } })
const commandResult = commands.execute(doc, { type: 'rename', label: '新标签' }, { expectRevision: doc.revision })
assert.equal(commandResult.doc.nodes[0].label, '新标签')
assert.notEqual(doc.nodes[0].label, '新标签')
assert.throws(() => commands.execute(doc, { type: 'unsupported' }), /命令/)
const original = cloneDocument(doc)
assert.throws(() => documentTransaction(doc, (draft) => { draft.nodes[0].creation.references[0].role = 'changed'; throw new Error('abort') }), /abort/)
assert.deepEqual(doc, original)
await assert.rejects(documentTransaction(doc, async (draft) => { draft.nodes.length = 0; throw new Error('async abort') }), /async abort/)
assert.deepEqual(doc, original)
assert.throws(() => documentTransaction(doc, () => {}, { expectRevision: 'wrong' }), /revision conflict/)
const transaction = documentTransaction(doc, (draft) => { draft.nodes[0].creation.references[0].role = 'style' })
assert.equal(doc.nodes[0].creation.references[0].role, 'firstFrame')
assert.equal(transaction.doc.nodes[0].creation.references[0].role, 'style')
assert.equal(parseCanvas(buildCanvas(emptyDocument(), { format: 'drawai' }).text).doc.layers.length, 1)

mkdirSync(resolve('tmp'), { recursive: true })
const directory = mkdtempSync(resolve('tmp/native-canvas-'))
try {
  const source = join(directory, 'sample.drawio'), destination = join(directory, 'sample.drawai')
  writeFileSync(source, xml)
  const media = mediaRootFor(source)
  mkdirSync(join(media, 'clip'), { recursive: true })
  writeFileSync(join(media, 'clip', 'source.mp4'), 'original video')
  const service = { readText: (path) => readFile(path, 'utf8'), writeText: (path, text) => writeFile(path, text),
    stat: async (path) => { try { return await stat(path) } catch (error) { if (error.code !== 'ENOENT') throw error } } }
  const args = { fs: service, source, destination, sourcePath: source, destinationPath: destination }
  const first = await migrateCanvasFile(args)
  assert.equal(first.reused, false)
  assert.equal(readFileSync(source, 'utf8'), xml)
  assert.notEqual(mediaRootFor(source), mediaRootFor(destination))
  assert.equal(readFileSync(join(mediaRootFor(destination), 'clip', 'source.mp4'), 'utf8'), 'original video')
  writeFileSync(join(mediaRootFor(destination), 'clip', 'source.mp4'), 'edited video')
  assert.equal(readFileSync(join(media, 'clip', 'source.mp4'), 'utf8'), 'original video')
  assert.equal((await migrateCanvasFile(args)).reused, true)
  writeFileSync(source, xml.replace('参考图', '外部编辑'))
  await assert.rejects(migrateCanvasFile(args), /已存在|更改/)
  assert.equal(readFileSync(destination, 'utf8'), first.text)
  writeFileSync(source, xml)
  const zip = packCanvasBundle(destination)
  const restored = join(directory, 'restore')
  const result = unpackCanvasBundle(zip, restored)
  assert.equal(result.path, 'sample.drawai')
  assert.equal(parseCanvas(readFileSync(join(restored, result.path), 'utf8')).pageCount, 2)
  assert.equal(readFileSync(join(result.mediaRoot, 'clip', 'source.mp4'), 'utf8'), 'edited video')
  const badSource = join(directory, 'bad.drawio'), badDestination = join(directory, 'bad.drawai')
  writeFileSync(badSource, '<broken/>')
  await assert.rejects(migrateCanvasFile({ ...args, source: badSource, destination: badDestination, sourcePath: badSource, destinationPath: badDestination }))
  assert.equal(existsSync(badDestination), false)
  // A different session's unloaded history must follow the new document too.
  const scope = { workspaceRoot: directory, sessionId: 'owner', drawioAbs: source, path: source }
  const taskId = randomUUID(), taskDirectory = join(directory, '.drawai-cache', 'drawing-tasks', taskId)
  mkdirSync(taskDirectory, { recursive: true })
  const taskFile = join(taskDirectory, 'job.json')
  const record = { id: taskId, scope: { ...scope, sessionId: 'foreign' }, status: 'running' }
  writeFileSync(taskFile, JSON.stringify(record))
  const tasks = createDrawingTaskManager({})
  assert.equal(tasks.canMigrateCanvas(scope, source), false)
  writeFileSync(taskFile, JSON.stringify({ ...record, status: 'paused' }))
  assert.equal(tasks.canMigrateCanvas(scope, source), true)
  tasks.migrateCanvas(scope, source, destination)
  assert.equal(JSON.parse(readFileSync(taskFile, 'utf8')).scope.drawioAbs, destination)
  await tasks.close()
  const exportId = randomUUID(), exportDirectory = join(directory, '.drawai-cache', 'video-export-history')
  mkdirSync(exportDirectory, { recursive: true })
  const exportFile = join(exportDirectory, exportId + '.json')
  const exportRecord = { token: exportId, sessionId: 'foreign', drawioAbs: source, status: 'running' }
  writeFileSync(exportFile, JSON.stringify(exportRecord))
  const exports = createVideoExportManager()
  assert.equal(exports.canMigrateCanvas(scope), false)
  writeFileSync(exportFile, JSON.stringify({ ...exportRecord, status: 'done' }))
  assert.equal(exports.canMigrateCanvas(scope), true)
  exports.migrateCanvas(scope, destination)
  assert.equal(JSON.parse(readFileSync(exportFile, 'utf8')).drawioAbs, destination)
  await exports.dispose()
} finally {
  if (!directory.startsWith(resolve('tmp') + '\\') && !directory.startsWith(resolve('tmp') + '/')) throw new Error('test directory escaped workspace')
  rmSync(directory, { recursive: true, force: true })
}
console.log('Native canvas: multi-page migration, compatibility, transactions, media isolation and bundle round trip passed')
