/**
 * DrawAI 视频旁路媒体包 —— 路径约定、manifest、帧读写、画布包 zip。
 *
 * 约定：画布 `foo.drawio` ↔ 旁路根 `foo.media/<clipId>/`。
 * 节点只存 `mediaClip`（及 drawaiMedia 等元数据），目录主名由画布 stem 推导，
 * 成对改名时不必改 XML。
 */

import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import { dirname, basename, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip, deflateRawSync, inflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { DEFAULT_VIDEO_POSTER } from './style-kernel.js'

export { DEFAULT_VIDEO_POSTER }

export const MEDIA_DIR_SUFFIX = '.media'
export const MANIFEST_NAME = 'manifest.json'
export const FRAMES_DIR = 'frames'
export const STILLS_DIR = 'stills'
export const POSTER_NAME = 'poster.svg'
export const MEDIA_VERSION = 1
export const MAX_FRAME_SVG_CHARS = 250000
export const MAX_APPEND_FRAMES = 48
export const DEFAULT_MEDIA_FPS = 12
export const DEFAULT_MEDIA_W = 320
export const DEFAULT_MEDIA_H = 180

const MEDIA_DATA_KEYS = ['drawaiMedia', 'mediaKind', 'mediaClip', 'mediaFps', 'mediaW', 'mediaH', 'mediaPosterFrame']

/** 从画布路径得到 stem（去掉 .drawio）。 */
export function drawioStem(drawioPath) {
  const base = basename(String(drawioPath || ''))
  return base.replace(/\.drawio$/i, '') || 'canvas'
}

/** `foo.drawio` → `…/foo.media`（绝对或相对，跟随入参形态）。 */
export function mediaRootFor(drawioPath) {
  const p = String(drawioPath || '')
  const dir = dirname(p)
  const stem = drawioStem(p)
  return dir === '.' ? stem + MEDIA_DIR_SUFFIX : join(dir, stem + MEDIA_DIR_SUFFIX)
}

/** clip 目录：`…/foo.media/clip-a` */
export function clipDirFor(drawioPath, clipId) {
  const clip = sanitizeClipId(clipId)
  if (clip === null) throw new Error('invalid mediaClip id')
  return join(mediaRootFor(drawioPath), clip)
}

export function sanitizeClipId(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (s.length === 0 || s.length > 64) return null
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s) === false) return null
  if (s === '.' || s === '..') return null
  return s
}

export function allocateClipId(existing) {
  const used = new Set((existing || []).map((x) => String(x)))
  let n = 1
  while (used.has('clip-' + n)) n += 1
  return 'clip-' + n
}

export function isVideoData(data) {
  if (data === null || data === undefined || typeof data !== 'object') return false
  const v = data.drawaiMedia
  return v === '1' || v === 1 || v === true
}

export function videoMetaFromData(data) {
  if (isVideoData(data) === false) return null
  const clip = sanitizeClipId(data.mediaClip)
  const kind = data.mediaKind === 'raster' ? 'raster' : 'svg'
  const fps = Number(data.mediaFps)
  const w = Number(data.mediaW)
  const h = Number(data.mediaH)
  const posterFrame = Number(data.mediaPosterFrame)
  return {
    clip: clip,
    kind: kind,
    fps: Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_MEDIA_FPS,
    w: Number.isFinite(w) && w > 0 ? w : DEFAULT_MEDIA_W,
    h: Number.isFinite(h) && h > 0 ? h : DEFAULT_MEDIA_H,
    posterFrame: Number.isFinite(posterFrame) && posterFrame >= 0 ? Math.floor(posterFrame) : 0,
  }
}

export function videoDataAttrs(meta) {
  const m = meta || {}
  const clip = sanitizeClipId(m.clip || m.mediaClip) || 'clip-1'
  const kind = m.kind === 'raster' || m.mediaKind === 'raster' ? 'raster' : 'svg'
  const fps = Number(m.fps !== undefined ? m.fps : m.mediaFps)
  const w = Number(m.w !== undefined ? m.w : m.mediaW)
  const h = Number(m.h !== undefined ? m.h : m.mediaH)
  const posterFrame = Number(m.posterFrame !== undefined ? m.posterFrame : m.mediaPosterFrame)
  return {
    drawaiMedia: '1',
    mediaKind: kind,
    mediaClip: clip,
    mediaFps: String(Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_MEDIA_FPS),
    mediaW: String(Number.isFinite(w) && w > 0 ? Math.round(w) : DEFAULT_MEDIA_W),
    mediaH: String(Number.isFinite(h) && h > 0 ? Math.round(h) : DEFAULT_MEDIA_H),
    mediaPosterFrame: String(Number.isFinite(posterFrame) && posterFrame >= 0 ? Math.floor(posterFrame) : 0),
  }
}

export function stripVideoData(data) {
  if (data === null || data === undefined || typeof data !== 'object') return data
  const out = Object.assign({}, data)
  for (let i = 0; i < MEDIA_DATA_KEYS.length; i += 1) delete out[MEDIA_DATA_KEYS[i]]
  return out
}

export function frameFileName(index) {
  const n = Math.floor(Number(index))
  if (Number.isFinite(n) === false || n < 0) throw new Error('frame index must be >= 0')
  return String(n + 1).padStart(4, '0') + '.svg'
}

export function stillFileName(index) {
  const n = Math.floor(Number(index))
  if (Number.isFinite(n) === false || n < 0) throw new Error('frame index must be >= 0')
  return String(n + 1).padStart(4, '0') + '.png'
}

export function emptyManifest(opts) {
  const o = opts || {}
  const fps = Number(o.fps)
  const width = Number(o.width !== undefined ? o.width : o.w)
  const height = Number(o.height !== undefined ? o.height : o.h)
  return {
    version: MEDIA_VERSION,
    kind: o.kind === 'raster' ? 'raster' : 'svg',
    fps: Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_MEDIA_FPS,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_MEDIA_W,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_MEDIA_H,
    source: typeof o.source === 'string' && o.source.length > 0 ? o.source : null,
    sourceOffset: Number.isFinite(Number(o.sourceOffset)) && Number(o.sourceOffset) >= 0 ? Number(o.sourceOffset) : 0,
    frames: Array.isArray(o.frames) ? o.frames.slice() : [],
    duration: 0,
  }
}

function syncDuration(manifest) {
  const frames = Array.isArray(manifest.frames) ? manifest.frames.length : 0
  const fps = Number(manifest.fps)
  manifest.duration = frames > 0 && Number.isFinite(fps) && fps > 0 ? frames / fps : 0
  return manifest
}

export function normalizeManifest(raw) {
  const base = emptyManifest()
  if (raw === null || raw === undefined || typeof raw !== 'object') return base
  const fps = Number(raw.fps)
  const width = Number(raw.width)
  const height = Number(raw.height)
  const frames = []
  if (Array.isArray(raw.frames)) {
    for (let i = 0; i < raw.frames.length; i += 1) {
      const f = raw.frames[i]
      if (f === null || typeof f !== 'object') continue
      const file = typeof f.file === 'string' ? f.file.replace(/\\/g, '/') : null
      if (file === null || file.indexOf('..') >= 0) continue
      const t = Number(f.t)
      frames.push({ file: file, t: Number.isFinite(t) ? t : i / (Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_MEDIA_FPS) })
    }
  }
  return syncDuration({
    version: Number(raw.version) || MEDIA_VERSION,
    kind: raw.kind === 'raster' ? 'raster' : 'svg',
    fps: Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_MEDIA_FPS,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_MEDIA_W,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_MEDIA_H,
    source: typeof raw.source === 'string' && raw.source.length > 0 ? raw.source.replace(/\\/g, '/') : null,
    sourceOffset: Number.isFinite(Number(raw.sourceOffset)) && Number(raw.sourceOffset) >= 0 ? Number(raw.sourceOffset) : 0,
    frames: frames,
    duration: 0,
  })
}

export function readManifest(clipDir) {
  const path = join(clipDir, MANIFEST_NAME)
  if (existsSync(path) === false) return emptyManifest()
  try {
    return normalizeManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    throw new Error('manifest.json 无法解析：' + (error && error.message ? error.message : String(error)))
  }
}

export function writeManifest(clipDir, manifest) {
  mkdirSync(clipDir, { recursive: true })
  const next = syncDuration(normalizeManifest(manifest))
  writeFileSync(join(clipDir, MANIFEST_NAME), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

export function ensureClipPack(drawioPath, clipId, opts) {
  const clip = sanitizeClipId(clipId)
  if (clip === null) throw new Error('invalid mediaClip id')
  const dir = clipDirFor(drawioPath, clip)
  mkdirSync(join(dir, FRAMES_DIR), { recursive: true })
  mkdirSync(join(dir, STILLS_DIR), { recursive: true })
  const existing = existsSync(join(dir, MANIFEST_NAME))
  if (existing === false) {
    const m = emptyManifest(opts)
    writeManifest(dir, m)
    writeFileSync(join(dir, POSTER_NAME), DEFAULT_VIDEO_POSTER, 'utf8')
  }
  return { clip: clip, dir: dir, manifest: readManifest(dir) }
}

export function listFrameEntries(manifest, from, to) {
  const frames = Array.isArray(manifest.frames) ? manifest.frames : []
  const start = Number.isFinite(Number(from)) ? Math.max(0, Math.floor(Number(from))) : 0
  const end = Number.isFinite(Number(to)) ? Math.min(frames.length, Math.floor(Number(to)) + 1) : frames.length
  const out = []
  for (let i = start; i < end; i += 1) {
    out.push({ index: i, file: frames[i].file, t: frames[i].t })
  }
  return { total: frames.length, from: start, to: Math.max(start, end - 1), frames: out }
}

export function readFrameSvg(clipDir, manifest, index) {
  const frames = Array.isArray(manifest.frames) ? manifest.frames : []
  const i = Math.floor(Number(index))
  if (Number.isFinite(i) === false || i < 0 || i >= frames.length) {
    throw new Error('frame index out of range (0..' + Math.max(0, frames.length - 1) + ')')
  }
  const rel = frames[i].file
  const abs = join(clipDir, rel)
  if (abs.startsWith(resolve(clipDir) + sep) === false && resolve(abs) !== resolve(clipDir, rel)) {
    // containment: resolve both
  }
  const resolved = resolve(abs)
  const root = resolve(clipDir)
  if (resolved !== root && resolved.startsWith(root + sep) === false) {
    throw new Error('frame path escapes clip directory')
  }
  return readFileSync(resolved, 'utf8')
}

export function writeFrameSvg(clipDir, manifest, index, svg) {
  if (typeof svg !== 'string' || svg.indexOf('<svg') < 0) {
    throw new Error('frame svg must be an SVG markup string')
  }
  if (svg.length > MAX_FRAME_SVG_CHARS) {
    throw new Error('frame svg too long (' + svg.length + ' > ' + MAX_FRAME_SVG_CHARS + ')')
  }
  const i = Math.floor(Number(index))
  if (Number.isFinite(i) === false || i < 0) throw new Error('frame index must be >= 0')
  mkdirSync(join(clipDir, FRAMES_DIR), { recursive: true })
  const file = FRAMES_DIR + '/' + frameFileName(i)
  writeFileSync(join(clipDir, file), svg, 'utf8')
  const next = normalizeManifest(manifest)
  const fps = next.fps
  while (next.frames.length <= i) {
    const j = next.frames.length
    next.frames.push({ file: FRAMES_DIR + '/' + frameFileName(j), t: j / fps })
  }
  next.frames[i] = { file: file, t: i / fps }
  return writeManifest(clipDir, next)
}

export function appendFrameSvgs(clipDir, manifest, svgs) {
  if (Array.isArray(svgs) === false) throw new Error('svgs must be an array')
  if (svgs.length === 0) return normalizeManifest(manifest)
  if (svgs.length > MAX_APPEND_FRAMES) {
    throw new Error('appendFrames limited to ' + MAX_APPEND_FRAMES + ' per call')
  }
  let next = normalizeManifest(manifest)
  for (let i = 0; i < svgs.length; i += 1) {
    next = writeFrameSvg(clipDir, next, next.frames.length, svgs[i])
  }
  return next
}

export function findSourceFile(clipDir, manifest) {
  if (manifest && typeof manifest.source === 'string' && manifest.source.length > 0) {
    const abs = join(clipDir, manifest.source)
    if (existsSync(abs)) return { rel: manifest.source.replace(/\\/g, '/'), abs: abs }
  }
  const names = ['source.webm', 'source.mp4', 'source.mov', 'source.mkv']
  for (let i = 0; i < names.length; i += 1) {
    const abs = join(clipDir, names[i])
    if (existsSync(abs)) return { rel: names[i], abs: abs }
  }
  return null
}

export function importSourceFile(clipDir, sourcePath, preferredName) {
  if (existsSync(sourcePath) === false) throw new Error('source file not found: ' + sourcePath)
  mkdirSync(clipDir, { recursive: true })
  const ext = basename(sourcePath).toLowerCase().match(/\.(webm|mp4|mov|mkv)$/)
  const name = typeof preferredName === 'string' && preferredName.length > 0
    ? preferredName
    : 'source' + (ext ? ext[0] : '.webm')
  if (name.indexOf('..') >= 0 || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
    throw new Error('invalid source file name')
  }
  const dest = join(clipDir, name)
  copyFileSync(sourcePath, dest)
  const manifest = readManifest(clipDir)
  manifest.source = name
  if (manifest.kind !== 'svg' || manifest.frames.length === 0) manifest.kind = 'raster'
  writeManifest(clipDir, manifest)
  return { rel: name, abs: dest, manifest: readManifest(clipDir) }
}

export function writeStillPng(clipDir, index, pngBuffer) {
  mkdirSync(join(clipDir, STILLS_DIR), { recursive: true })
  const file = STILLS_DIR + '/' + stillFileName(index)
  writeFileSync(join(clipDir, file), pngBuffer)
  return file
}

export function readStillPng(clipDir, index) {
  const file = join(clipDir, STILLS_DIR, stillFileName(index))
  if (existsSync(file) === false) throw new Error('still not found: ' + stillFileName(index))
  return readFileSync(file)
}

export function listStillIndices(clipDir) {
  const dir = join(clipDir, STILLS_DIR)
  if (existsSync(dir) === false) return []
  const names = readdirSync(dir)
  const out = []
  for (let i = 0; i < names.length; i += 1) {
    const m = /^(\d+)\.png$/i.exec(names[i])
    if (m) out.push(parseInt(m[1], 10) - 1)
  }
  out.sort((a, b) => a - b)
  return out
}

/** 递归复制目录（覆盖目标同名文件）。 */
export function copyDirRecursive(src, dest) {
  if (existsSync(src) === false) return false
  mkdirSync(dest, { recursive: true })
  const entries = readdirSync(src, { withFileTypes: true })
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    const from = join(src, e.name)
    const to = join(dest, e.name)
    if (e.isDirectory()) copyDirRecursive(from, to)
    else copyFileSync(from, to)
  }
  return true
}

/** 另存为：把源画布旁的 `*.media` 复制到新主名。 */
export function copyMediaBeside(fromDrawio, toDrawio) {
  const fromRoot = mediaRootFor(fromDrawio)
  const toRoot = mediaRootFor(toDrawio)
  if (existsSync(fromRoot) === false) return { copied: false, from: fromRoot, to: toRoot }
  if (resolve(fromRoot) === resolve(toRoot)) return { copied: false, from: fromRoot, to: toRoot }
  if (existsSync(toRoot)) rmSync(toRoot, { recursive: true, force: true })
  copyDirRecursive(fromRoot, toRoot)
  return { copied: true, from: fromRoot, to: toRoot }
}

export function listClipIds(drawioPath) {
  const root = mediaRootFor(drawioPath)
  if (existsSync(root) === false) return []
  const entries = readdirSync(root, { withFileTypes: true })
  const out = []
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].isDirectory() && sanitizeClipId(entries[i].name)) out.push(entries[i].name)
  }
  out.sort()
  return out
}

export function collectReferencedClips(doc) {
  const used = new Set()
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc.nodes) === false) return used
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const meta = videoMetaFromData(doc.nodes[i].data)
    if (meta !== null && meta.clip !== null) used.add(meta.clip)
  }
  return used
}

export function cleanupUnreferencedClips(drawioPath, doc) {
  const used = collectReferencedClips(doc)
  const all = listClipIds(drawioPath)
  const removed = []
  for (let i = 0; i < all.length; i += 1) {
    if (used.has(all[i])) continue
    rmSync(clipDirFor(drawioPath, all[i]), { recursive: true, force: true })
    removed.push(all[i])
  }
  const root = mediaRootFor(drawioPath)
  if (existsSync(root) && listClipIds(drawioPath).length === 0) {
    rmSync(root, { recursive: true, force: true })
  }
  return removed
}

/* ----------------------------- 最小 zip（store + deflate） ----------------------------- */

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n >>> 0, 0)
  return b
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

/**
 * 把文件表打成 zip Buffer。
 * @param {{name:string, data:Buffer|string}[]} files
 */
export function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (let i = 0; i < files.length; i += 1) {
    const name = String(files[i].name).replace(/\\/g, '/')
    const data = Buffer.isBuffer(files[i].data) ? files[i].data : Buffer.from(String(files[i].data), 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data)
    const useStore = compressed.length >= data.length
    const payload = useStore ? data : compressed
    const method = useStore ? 0 : 8
    const crc = crc32(data)
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      payload,
    ])
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralDir = Buffer.concat(centrals)
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat(locals.concat([centralDir, end]))
}

export function parseZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const files = []
  let i = 0
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break
    const method = buf.readUInt16LE(i + 8)
    const compSize = buf.readUInt32LE(i + 18)
    const uncompSize = buf.readUInt32LE(i + 22)
    const nameLen = buf.readUInt16LE(i + 26)
    const extraLen = buf.readUInt16LE(i + 28)
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8')
    const start = i + 30 + nameLen + extraLen
    const payload = buf.slice(start, start + compSize)
    let data
    if (method === 0) data = payload
    else if (method === 8) data = inflateRawSync(payload)
    else throw new Error('unsupported zip method ' + method + ' for ' + name)
    if (name.endsWith('/') === false) files.push({ name: name, data: data })
    i = start + compSize
  }
  return files
}

function walkFiles(dir, prefix, out) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    const rel = prefix.length > 0 ? prefix + '/' + e.name : e.name
    const abs = join(dir, e.name)
    if (e.isDirectory()) walkFiles(abs, rel, out)
    else out.push({ name: rel.replace(/\\/g, '/'), data: readFileSync(abs) })
  }
}

/** 导出画布包：`stem.drawio` + `stem.media/**` → zip Buffer */
export function packCanvasBundle(drawioPath) {
  const stem = drawioStem(drawioPath)
  const files = []
  if (existsSync(drawioPath) === false) throw new Error('drawio not found: ' + drawioPath)
  files.push({ name: stem + '.drawio', data: readFileSync(drawioPath) })
  const mediaRoot = mediaRootFor(drawioPath)
  if (existsSync(mediaRoot)) {
    const mediaFiles = []
    walkFiles(mediaRoot, stem + MEDIA_DIR_SUFFIX, mediaFiles)
    for (let i = 0; i < mediaFiles.length; i += 1) files.push(mediaFiles[i])
  }
  return buildZip(files)
}

/** 导入画布包到目标目录；返回写出的 .drawio 相对名。 */
export function unpackCanvasBundle(zipBuffer, destDir, preferredStem) {
  const entries = parseZip(zipBuffer)
  if (entries.length === 0) throw new Error('empty zip')
  let drawioEntry = null
  for (let i = 0; i < entries.length; i += 1) {
    if (/\.drawio$/i.test(entries[i].name) && entries[i].name.indexOf('/') < 0) {
      drawioEntry = entries[i]
      break
    }
  }
  if (drawioEntry === null) {
    for (let i = 0; i < entries.length; i += 1) {
      if (/\.drawio$/i.test(entries[i].name)) {
        drawioEntry = entries[i]
        break
      }
    }
  }
  if (drawioEntry === null) throw new Error('zip 里没有 .drawio')
  const stem = preferredStem || basename(drawioEntry.name).replace(/\.drawio$/i, '')
  mkdirSync(destDir, { recursive: true })
  const drawioOut = join(destDir, stem + '.drawio')
  if (existsSync(drawioOut)) throw new Error('already exists: ' + stem + '.drawio')
  writeFileSync(drawioOut, drawioEntry.data)
  const mediaOut = join(destDir, stem + MEDIA_DIR_SUFFIX)
  for (let i = 0; i < entries.length; i += 1) {
    const name = entries[i].name.replace(/\\/g, '/')
    if (/\.drawio$/i.test(name)) continue
    // 接受 `foo.media/...` 或任意 `*.media/...`
    const m = /([^/]+)\.media\/(.+)$/i.exec(name)
    if (m === null) continue
    const rel = m[2]
    if (rel.indexOf('..') >= 0) continue
    const abs = join(mediaOut, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, entries[i].data)
  }
  return { path: stem + '.drawio', mediaRoot: mediaOut }
}

/** 导出单个 clip 为 SVG 视频 zip（manifest + frames + poster）。 */
export function packSvgVideoZip(clipDir) {
  const manifest = readManifest(clipDir)
  const files = [{ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') }]
  const poster = join(clipDir, POSTER_NAME)
  const source = findSourceFile(clipDir, manifest)
  if (source) files.push({ name: source.rel, data: readFileSync(source.abs) })
  if (existsSync(poster)) files.push({ name: POSTER_NAME, data: readFileSync(poster) })
  for (let i = 0; i < manifest.frames.length; i += 1) {
    const rel = manifest.frames[i].file
    const abs = join(clipDir, rel)
    if (existsSync(abs)) files.push({ name: rel.replace(/\\/g, '/'), data: readFileSync(abs) })
  }
  return buildZip(files)
}

export function unpackSvgVideoZip(zipBuffer, clipDir) {
  const entries = parseZip(zipBuffer)
  mkdirSync(join(clipDir, FRAMES_DIR), { recursive: true })
  let manifest = null
  for (let i = 0; i < entries.length; i += 1) {
    const name = entries[i].name.replace(/\\/g, '/')
    if (name.indexOf('..') >= 0) continue
    if (basename(name) === MANIFEST_NAME || name === MANIFEST_NAME) {
      manifest = normalizeManifest(JSON.parse(entries[i].data.toString('utf8')))
      continue
    }
    const abs = join(clipDir, name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, entries[i].data)
  }
  if (manifest === null) {
    // 仅有 frames/*.svg
    const frames = []
    for (let i = 0; i < entries.length; i += 1) {
      const name = entries[i].name.replace(/\\/g, '/')
      if (/\.svg$/i.test(name)) frames.push({ file: name, t: frames.length / DEFAULT_MEDIA_FPS })
    }
    frames.sort((a, b) => a.file.localeCompare(b.file))
    for (let i = 0; i < frames.length; i += 1) frames[i].t = i / DEFAULT_MEDIA_FPS
    manifest = emptyManifest({ kind: 'svg', frames: frames })
  }
  manifest.kind = 'svg'
  writeManifest(clipDir, manifest)
  return readManifest(clipDir)
}

export function contentFingerprint(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

// 避免未使用 import 告警（部分环境 tree-shake 敏感）
void createReadStream
void createWriteStream
void pipeline
void createGzip
void createGunzip
void Readable
void renameSync
void statSync
