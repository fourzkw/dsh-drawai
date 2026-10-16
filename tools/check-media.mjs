/**
 * 旁路媒体包自测：路径约定、manifest、帧读写、zip 打包/解包、另存为成对复制。
 *
 * 用法：node tools/check-media.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_VIDEO_POSTER,
  allocateClipId,
  appendFrameSvgs,
  buildZip,
  cleanupUnreferencedClips,
  clipDirFor,
  copyMediaBeside,
  drawioStem,
  emptyManifest,
  ensureClipPack,
  frameFileName,
  listFrameEntries,
  mediaRootFor,
  normalizeManifest,
  packCanvasBundle,
  packSvgVideoZip,
  parseZip,
  readFrameSvg,
  readManifest,
  sanitizeClipId,
  unpackCanvasBundle,
  unpackSvgVideoZip,
  videoDataAttrs,
  videoMetaFromData,
  writeFrameSvg,
} from '../src/media.js'
import { isVideoNodeData, reportNodeShape, styleWithNodeShape, styleWithSvgMarkup } from '../src/style-kernel.js'

let failures = 0
let checks = 0

function ok(condition, label) {
  checks += 1
  if (condition) {
    console.log('  ✓ ' + label)
    return true
  }
  failures += 1
  console.log('  ✗ ' + label)
  return false
}

const root = mkdtempSync(join(tmpdir(), 'drawai-media-'))
const drawio = join(root, 'demo.drawio')
writeFileSync(drawio, '<mxfile/>', 'utf8')

console.log('media path helpers')
ok(drawioStem('a/b/登录流程.drawio') === '登录流程', 'drawioStem strips extension')
ok(mediaRootFor(drawio).endsWith('demo.media'), 'mediaRootFor uses stem + .media')
ok(sanitizeClipId('clip-1') === 'clip-1', 'sanitizeClipId accepts clip-1')
ok(sanitizeClipId('../x') === null, 'sanitizeClipId rejects ..')
ok(sanitizeClipId('') === null, 'sanitizeClipId rejects empty')
ok(allocateClipId(['clip-1', 'clip-2']) === 'clip-3', 'allocateClipId skips used')

console.log('video data attrs')
const data = videoDataAttrs({ clip: 'clip-1', kind: 'svg', fps: 12, w: 320, h: 180 })
ok(isVideoNodeData(data) === true, 'isVideoNodeData recognizes drawaiMedia')
ok(videoMetaFromData(data).clip === 'clip-1', 'videoMetaFromData.clip')
ok(reportNodeShape({ style: styleWithSvgMarkup(styleWithNodeShape('', 'video'), DEFAULT_VIDEO_POSTER), data }) === 'video', 'reportNodeShape prefers video data')
ok(reportNodeShape({ style: styleWithSvgMarkup(styleWithNodeShape('', 'svg'), DEFAULT_VIDEO_POSTER) }) === 'svg', 'reportNodeShape falls back to svg without data')

console.log('clip pack + frames')
const pack = ensureClipPack(drawio, 'clip-1', { fps: 8, w: 100, h: 60 })
ok(existsSync(join(pack.dir, 'manifest.json')), 'ensureClipPack writes manifest')
ok(existsSync(join(pack.dir, 'poster.svg')), 'ensureClipPack writes poster')
ok(pack.manifest.fps === 8, 'manifest fps')
const svg1 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00"/></svg>'
const svg2 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0f0"/></svg>'
let manifest = writeFrameSvg(pack.dir, pack.manifest, 0, svg1)
manifest = appendFrameSvgs(pack.dir, manifest, [svg2])
ok(manifest.frames.length === 2, 'two frames after write+append')
ok(frameFileName(0) === '0001.svg', 'frameFileName 0 → 0001.svg')
ok(readFrameSvg(pack.dir, manifest, 1).indexOf('circle') >= 0, 'readFrameSvg returns second frame')
const listed = listFrameEntries(manifest, 0, 0)
ok(listed.total === 2 && listed.frames.length === 1, 'listFrameEntries range')

console.log('svg video zip')
const svgZip = packSvgVideoZip(pack.dir)
const clipB = join(mediaRootFor(drawio), 'clip-b')
const unpacked = unpackSvgVideoZip(svgZip, clipB)
ok(unpacked.frames.length === 2, 'unpackSvgVideoZip restores frames')
ok(existsSync(join(clipB, 'frames', '0001.svg')), 'frame file on disk')

console.log('canvas bundle zip')
writeFileSync(drawio, '<mxfile><diagram name="p1"/></mxfile>', 'utf8')
const bundle = packCanvasBundle(drawio)
const entries = parseZip(bundle)
ok(entries.some((e) => e.name === 'demo.drawio'), 'bundle contains drawio')
ok(entries.some((e) => /demo\.media\//.test(e.name)), 'bundle contains media files')
const dest = join(root, 'imported')
const result = unpackCanvasBundle(bundle, dest, 'copied')
ok(result.path === 'copied.drawio', 'unpackCanvasBundle renames stem')
ok(existsSync(join(dest, 'copied.drawio')), 'unpacked drawio exists')
ok(existsSync(join(dest, 'copied.media', 'clip-1', 'manifest.json')), 'unpacked media follows new stem')

console.log('copyMediaBeside (save-as pairing)')
const other = join(root, 'other.drawio')
writeFileSync(other, '<mxfile/>', 'utf8')
const copied = copyMediaBeside(drawio, other)
ok(copied.copied === true, 'copyMediaBeside copies')
ok(existsSync(join(root, 'other.media', 'clip-1', 'manifest.json')), 'paired media under new stem')

console.log('cleanup unreferenced')
const removed = cleanupUnreferencedClips(drawio, {
  nodes: [{ id: 'n1', data: videoDataAttrs({ clip: 'clip-1' }) }],
})
ok(removed.indexOf('clip-b') >= 0, 'cleanup removes unused clip-b')
ok(existsSync(clipDirFor(drawio, 'clip-1')), 'cleanup keeps referenced clip-1')

console.log('zip roundtrip tiny')
const z = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }])
const parsed = parseZip(z)
ok(parsed.length === 1 && parsed[0].data.toString('utf8') === 'hello', 'buildZip/parseZip roundtrip')

console.log('normalizeManifest')
ok(normalizeManifest(null).version === 1, 'normalizeManifest null → defaults')
ok(emptyManifest({ kind: 'raster' }).kind === 'raster', 'emptyManifest kind')

try {
  rmSync(root, { recursive: true, force: true })
} catch (error) {
  // best-effort
}

console.log('')
console.log(checks + ' checks, ' + failures + ' failures')
if (failures > 0) process.exit(1)
