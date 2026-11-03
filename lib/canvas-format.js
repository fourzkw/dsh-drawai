/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/** Native JSON document codec. XML is retained only as a compatibility capsule. */
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { mediaRootFor } from './media.js'
import { parseMxfile, applyDocToMxfile, buildMxfile, contentHash } from './mxfile.js'
import { cloneDocument, normalizeDocument } from './document-core.js'

export const CANVAS_SCHEMA_VERSION = 1
export const isCanvasPath = (path) => typeof path === 'string' && /\.(drawai|drawio)$/i.test(path)
export const isNativeCanvasPath = (path) => typeof path === 'string' && /\.drawai$/i.test(path)
export const nativeCanvasPath = (path) => path.replace(/\.drawio$/i, '.drawai')
const nativeText = (text) => String(text).trimStart().startsWith('{')

function decode(text) {
  const project = JSON.parse(text)
  if (project.format !== 'dsh-drawai' || project.schemaVersion !== CANVAS_SCHEMA_VERSION) throw new Error('不支持的 DrawAI 文档版本')
  if (typeof project.id !== 'string' || !Array.isArray(project.pages) || !project.pages.length) throw new Error('DrawAI 文档缺少项目或页面')
  const ids = new Set()
  for (const page of project.pages) {
    if (!page || typeof page.id !== 'string' || ids.has(page.id) || !Array.isArray(page.doc?.nodes) || !Array.isArray(page.doc?.edges)) throw new Error('DrawAI 页面结构或身份无效')
    ids.add(page.id)
  }
  return project
}

function encode(project) { return JSON.stringify(project, null, 2) + '\n' }
function stored(doc) { const copy = cloneDocument(doc); delete copy.revision; return copy }

export function migrateMxfile(text, sourcePath = '') {
  const first = parseMxfile(text)
  const project = { format: 'dsh-drawai', schemaVersion: CANVAS_SCHEMA_VERSION, id: randomUUID(), pages: [],
    compat: { drawio: text }, migration: { sourcePath, sourceHash: contentHash(text) } }
  for (let i = 0; i < first.pageCount; i++) {
    const page = parseMxfile(text, { page: i })
    project.pages.push({ id: page.pageId || 'page-' + i, name: page.pageNames[i], doc: stored(page.doc), notes: page.notes })
  }
  const result = encode(project)
  decode(result)
  return result
}

export function parseCanvas(text, options = {}) {
  if (!nativeText(text)) return parseMxfile(text, options)
  const project = decode(text)
  const index = Math.max(0, Math.min(project.pages.length - 1, Math.floor(Number(options.page) || 0)))
  const page = project.pages[index]
  const doc = normalizeDocument(page.doc)
  doc.revision = contentHash(text)
  doc.meta = { ...doc.meta, pageIndex: index, pageCount: project.pages.length, pageNames: project.pages.map((item) => item.name) }
  return { doc, notes: page.notes || [], pageCount: project.pages.length, pageIndex: index,
    pageNames: project.pages.map((item) => item.name), pageId: page.id, pageIds: project.pages.map((item) => item.id) }
}

export function applyCanvas(text, doc, options = {}) {
  if (!nativeText(text)) return applyDocToMxfile(text, doc, options)
  const project = decode(text)
  const index = options.page === undefined ? 0 : Number(options.page)
  if (!Number.isInteger(index) || !project.pages[index]) throw new Error('页面不存在')
  project.pages[index].doc = stored(normalizeDocument(doc))
  return { text: encode(project), dropped: [] }
}

export function buildCanvas(doc, options = {}) {
  if (options.format !== 'drawai') return buildMxfile(doc, options)
  return { text: encode({ format: 'dsh-drawai', schemaVersion: CANVAS_SCHEMA_VERSION, id: randomUUID(),
    pages: [{ id: randomUUID(), name: options.name || '第 1 页', doc: stored(normalizeDocument(doc)) }] }), dropped: [] }
}

export function exportCanvasToMxfile(text) {
  if (!nativeText(text)) return text
  const project = decode(text)
  if (!project.compat?.drawio) {
    if (project.pages.length !== 1) throw new Error('缺少多页 drawio 兼容模板')
    return buildMxfile(project.pages[0].doc, { name: project.pages[0].name }).text
  }
  let xml = project.compat.drawio
  for (let page = 0; page < project.pages.length; page++) xml = applyDocToMxfile(xml, project.pages[page].doc, { page }).text
  return xml
}

export function forkNativeCanvas(text) {
  const project = decode(text)
  project.id = randomUUID()
  delete project.migration
  return encode(project)
}

/** Runs through the host filesystem service, preserving its workspace/policy checks. */
export async function migrateCanvasFile({ fs, source, destination, sourcePath, destinationPath, policy }) {
  const original = await fs.readText(source)
  if (await fs.stat(destination)) {
    const existing = await fs.readText(destination)
    const project = decode(existing)
    if (project.migration?.sourcePath !== sourcePath || project.migration.sourceHash !== contentHash(original)) throw new Error('迁移目标已存在或旧画布已更改；请先处理两个版本')
    return { text: existing, reused: true }
  }
  const text = migrateMxfile(original, sourcePath)
  if (destinationPath) copyMigrationMedia(sourcePath, destinationPath, contentHash(original))
  if (await fs.readText(source) !== original) throw new Error('迁移期间源画布已更改，请重新打开')
  if (await fs.stat(destination)) throw new Error('迁移目标已存在')
  await fs.writeText(destination, text, undefined, undefined, policy)
  return { text, reused: false }
}

// Never share mutable media with the retained original. Publish the complete copy
// by directory rename; an unrelated existing destination is never overwritten.
function copyMigrationMedia(source, destination, sourceHash) {
  const from = mediaRootFor(source), to = mediaRootFor(destination)
  if (!existsSync(from)) return
  const marker = '.drawai-migration.json'
  if (existsSync(to)) {
    if (lstatSync(to).isSymbolicLink()) throw new Error('迁移媒体目录不能为符号链接')
    const saved = JSON.parse(readFileSync(join(to, marker), 'utf8'))
    if (saved.source !== source || saved.sourceHash !== sourceHash) throw new Error('迁移媒体目录已存在')
    return
  }
  const temporary = join(dirname(to), '.drawai-migration-' + randomUUID())
  function copyDirectory(input, output) {
    if (lstatSync(input).isSymbolicLink()) throw new Error('迁移媒体不支持符号链接')
    mkdirSync(output)
    for (const entry of readdirSync(input, { withFileTypes: true })) {
      const src = join(input, entry.name), dst = join(output, entry.name)
      if (entry.isSymbolicLink()) throw new Error('迁移媒体不支持符号链接')
      if (entry.isDirectory()) copyDirectory(src, dst)
      else copyFileSync(src, dst, constants.COPYFILE_EXCL)
    }
  }
  copyDirectory(from, temporary)
  writeFileSync(join(temporary, marker), JSON.stringify({ source, sourceHash }), { flag: 'wx' })
  if (existsSync(to)) throw new Error('迁移媒体目录已存在')
  renameSync(temporary, to)
}
