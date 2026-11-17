import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureStyleFrames } from '../src/motion/style-frames.js'
import { findStyleReferenceCollection, listStyleReferenceFrames, styleReferenceRoot } from '../src/motion/style-reference-store.js'

const parent = resolve(tmpdir())
const temp = mkdtempSync(join(parent, 'drawai-style-ref-test-'))
const previous = process.env.DRAWAI_STYLE_REFERENCE_DIR
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fixture(slug, mode, times) {
  const dir = join(temp, slug)
  mkdirSync(dir)
  const frames = times.map((time, i) => {
    const file = `frame-${i}.png`, data = Buffer.concat([image, Buffer.from([i])])
    writeFileSync(join(dir, file), data)
    const entry = { file, sha256: sha(data) }
    if (mode === 'legacy') Object.assign(entry, { time_seconds: time, frame_index: i * 30, width: 1920, height: 1080 })
    if (mode === 'current') Object.assign(entry, { seconds: time, frame_index: i * 30 })
    if (mode === 'compilation') Object.assign(entry, { timeSeconds: time, sourceFrame: i * 6 })
    return entry
  })
  const meta = mode === 'legacy'
    ? { source_video_url: 'https://example.test/a', source_video_width: 1920, source_video_height: 1080, source_video_frame_rate: '30/1', source_video_duration_seconds: 10 }
    : mode === 'current'
      ? { source_url: 'https://example.test/b', width: 1080, height: 1920, video_fps: 30, source_video_duration_seconds: 10 }
      : { sourceUrl: 'https://example.test/c', sourceTitle: 'collection', sourceRelease: 'v1', sourceWidth: 1920, sourceHeight: 1080, sourceFps: 24, sourceDurationSeconds: 41.25, license: 'redistribution unverified' }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ slug, frames, ...meta }))
  return { dir, frames, meta }
}

try {
  const collections = join(temp, 'collections')
  mkdirSync(collections)
  assert.equal(findStyleReferenceCollection(collections), null)
  for (const name of ['collection-20260101', 'collection-20261116', 'collection-20261231']) {
    const dir = join(collections, name)
    mkdirSync(dir)
    if (!name.endsWith('1231')) writeFileSync(join(dir, 'index.json'), '{}')
  }
  assert.equal(findStyleReferenceCollection(collections), join(collections, 'collection-20261116'), '应跳过没有索引的新目录')
  process.env.DRAWAI_STYLE_REFERENCE_DIR = temp
  assert.equal(styleReferenceRoot(), temp, '显式路径直接指向集合，不要求 index.json')
  const a = fixture('01-flat-vector', 'legacy', [0.5, 2, 4, 8])
  fixture('18-hanazi', 'current', [1, 3])
  const ink = fixture('23-ink-wash', 'compilation', [10.75, 11, 11.25, 11.5])
  const all = listStyleReferenceFrames()
  assert.equal(all.length, 10)
  assert.match(all[0].id, /^style-reference\/01-flat-vector\//)
  assert.equal(all[0].styleName, '扁平矢量·一点成城')
  assert.equal(all[0].fps, 30)
  assert.equal(listStyleReferenceFrames({ slug: '18-hanazi' })[0].width, 1080)
  assert.throws(() => listStyleReferenceFrames({ slug: '../outside' }), /slug 无效/)
  assert.throws(() => listStyleReferenceFrames({ slug: '02-line-art' }), (e) => e.code === 'STYLE_REFERENCE_UNAVAILABLE')
  const half = await captureStyleFrames({ slug: '01-flat-vector', count: 2 })
  assert.deepEqual(half.times, [0.5, 8])
  const near = await captureStyleFrames({ slug: '01-flat-vector', times: [0.4, 0.7, 2.1] })
  assert.deepEqual(near.times, [0.5, 2])
  assert.deepEqual(near.files.map((f) => f.requestedTime), [0.4, 2.1])
  const water = await captureStyleFrames({ slug: '23-ink-wash', count: 8 })
  assert.equal(water.files.length, 4)
  assert.equal(water.duration, 41.25)
  assert.equal(water.timeBasis, 'source-compilation')
  assert.match(water.notes.join(' '), /合集视频/)
  assert.match(water.license, /unverified/)
  const out = join(temp, 'export')
  const copied = await captureStyleFrames({ slug: '01-flat-vector', count: 1, directory: out })
  assert.equal(sha(readFileSync(copied.files[0].path)), a.frames[0].sha256)
  await captureStyleFrames({ slug: '01-flat-vector', count: 1, directory: out })
  writeFileSync(copied.files[0].path, 'not the reference')
  await assert.rejects(captureStyleFrames({ slug: '01-flat-vector', count: 1, directory: out }), /已存在且内容不同/)
  writeFileSync(join(a.dir, a.frames[0].file), 'tampered')
  assert.throws(() => listStyleReferenceFrames({ slug: '01-flat-vector' }), /SHA-256 不匹配/)
  const manifestFile = join(ink.dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.frames[0].file = '../outside.png'
  writeFileSync(manifestFile, JSON.stringify(manifest))
  assert.throws(() => listStyleReferenceFrames({ slug: '23-ink-wash' }), /文件名无效/)
  manifest.frames[0].file = 'escape.png'
  const outside = join(temp, 'outside.png')
  writeFileSync(outside, image)
  let symlinkTested = false
  try {
    symlinkSync(outside, join(ink.dir, 'escape.png'))
    symlinkTested = true
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
  }
  if (symlinkTested) {
    manifest.frames[0].sha256 = sha(image)
    writeFileSync(manifestFile, JSON.stringify(manifest))
    assert.throws(() => listStyleReferenceFrames({ slug: '23-ink-wash' }), /不在该风格目录内/)
  }
  process.env.DRAWAI_STYLE_REFERENCE_DIR = join(temp, 'missing')
  assert.throws(() => listStyleReferenceFrames(), (e) => e.code === 'STYLE_REFERENCE_UNAVAILABLE')
  console.log('[style-reference] 本地清单、实际时间、缺失/损坏、目录复制和越界检查通过' + (symlinkTested ? '' : '（当前系统不允许创建符号链接）'))
} finally {
  if (previous === undefined) delete process.env.DRAWAI_STYLE_REFERENCE_DIR
  else process.env.DRAWAI_STYLE_REFERENCE_DIR = previous
  const rel = relative(parent, temp)
  if (dirname(temp) === parent && rel && !rel.startsWith('..' + sep) && !isAbsolute(rel) && rel.startsWith('drawai-style-ref-test-')) {
    rmSync(temp, { recursive: true, force: true })
  }
}
