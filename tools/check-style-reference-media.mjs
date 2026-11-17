import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'drawai-style-media-'))
const refs = join(tmp, 'references'), assets = join(tmp, 'installed-assets'), project = join(tmp, 'project')
const fixture = readFileSync(fileURLToPath(new URL('./fixtures/image-trace-small-reference.png', import.meta.url)))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const env = { refs: process.env.DRAWAI_STYLE_REFERENCE_DIR, assets: process.env.DRAWAI_ASSETS_DIR }

try {
  process.env.DRAWAI_STYLE_REFERENCE_DIR = refs
  process.env.DRAWAI_ASSETS_DIR = assets
  for (const [slug, license] of [['06-collage', 'MIT'], ['23-ink-wash', '视频及画面再分发条件未确认']]) {
    const dir = join(refs, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'frame.png'), fixture)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ slug, source_url: 'https://example.com/' + slug,
      source_license: license, frames: [{ file: 'frame.png', time_seconds: 1, sha256: sha256(fixture) }] }))
  }

  // Test an isolated source copy so a developer's bundled assets cannot shadow
  // the fixture supplied through DRAWAI_ASSETS_DIR.
  const isolated = join(tmp, 'source'), motion = join(isolated, 'motion')
  mkdirSync(join(motion, 'mgstyles'), { recursive: true })
  writeFileSync(join(isolated, 'package.json'), '{"type":"module"}')
  for (const file of ['media-catalog.js', 'style-reference-store.js', 'asset-pack.js', 'asset-pack-lock.js', 'demo-assets-lock.js', 'style-frames-lock.js', 'assets.js', 'json.js']) {
    copyFileSync(fileURLToPath(new URL('../src/motion/' + file, import.meta.url)), join(motion, file))
  }
  copyFileSync(fileURLToPath(new URL('../src/motion/mgstyles/catalog.json', import.meta.url)), join(motion, 'mgstyles', 'catalog.json'))
  copyFileSync(fileURLToPath(new URL('../src/ffmpeg-manager.js', import.meta.url)), join(isolated, 'ffmpeg-manager.js'))
  const { listMediaLibrary, importMediaLibrary } = await import(pathToFileURL(join(motion, 'media-catalog.js')).href)
  const bySlug = listMediaLibrary({ query: '06-collage', category: 'style-reference' })
  assert.equal(bySlug.length, 1, '插件素材包缺失时也能按风格查询参考帧')
  assert.equal(bySlug[0].id, 'style-reference/06-collage/frame.png')
  assert.equal(bySlug[0].kind, 'image')
  assert.equal(bySlug[0].path, undefined, '搜索结果不暴露可被调用方篡改的内部路径')
  assert.equal(listMediaLibrary({ query: '拼贴', category: 'image' })[0].id, bySlug[0].id)
  assert.equal(listMediaLibrary({ query: '参考帧' }).length, 2)
  assert.equal(listMediaLibrary({ query: '拼贴参考帧' })[0].id, bySlug[0].id)
  assert.equal(listMediaLibrary({ query: '拼贴 参考帧' })[0].id, bySlug[0].id)
  assert.equal(listMediaLibrary({ query: bySlug[0].id })[0].id, bySlug[0].id)
  assert.equal(listMediaLibrary({ query: 'frame.png' }).length, 2)
  const ink = listMediaLibrary({ query: '水墨', category: '风格参考帧' })[0]
  assert.match(ink.license, /未确认/)

  const imported = await importMediaLibrary(project, bySlug[0].id)
  assert.equal(imported.kind, 'image')
  assert.equal(imported.source, 'https://example.com/06-collage')
  assert.equal(imported.license, 'MIT')
  assert.equal(imported.integrity.sha256, sha256(fixture))
  assert.deepEqual(readFileSync(join(project, 'assets', imported.file)), fixture)
  const saved = JSON.parse(readFileSync(join(project, 'assets', 'manifest.json'), 'utf8')).items[0]
  assert.equal(saved.libraryId, bySlug[0].id)
  assert.equal(saved.license, imported.license)
  assert.equal(saved.source, imported.source)

  // 原有素材库与参考帧库互相独立，既有查询/导入保持兼容。
  const textureId = 'assets/textures/paper/paper.png', soundId = 'lib/audio/samples/piano/key.flac'
  const library = join(assets, 'media-library')
  mkdirSync(join(assets, 'fonts'), { recursive: true })
  writeFileSync(join(assets, 'fonts', 'font-faces.json'), '{}')
  mkdirSync(join(library, 'assets', 'textures', 'paper'), { recursive: true })
  mkdirSync(join(library, 'lib', 'audio', 'samples', 'piano'), { recursive: true })
  writeFileSync(join(library, ...textureId.split('/')), fixture)
  const sound = Buffer.from('library fixture')
  writeFileSync(join(library, ...soundId.split('/')), sound)
  writeFileSync(join(library, 'upstream-files.json'), JSON.stringify({ commit: '49052d80bfaf9fa8412cc9710530e5e95a3b8d8c', files: [
    { path: textureId, size: fixture.length, sha: gitBlob(fixture) },
    { path: soundId, size: sound.length, sha: gitBlob(sound) },
  ] }))
  writeFileSync(join(library, 'checksums.sha256.json'), JSON.stringify({ files: { [textureId]: { sha256: sha256(fixture) } } }))
  assert.equal(listMediaLibrary({ query: '钢琴' })[0].id, soundId)
  assert.equal(listMediaLibrary({ query: '纸张' })[0].id, textureId)

  // 被篡改、丢失或越界的帧不允许导入；不影响不相关的纹理/音频查询。
  writeFileSync(join(refs, '06-collage', 'frame.png'), Buffer.from('tampered'))
  await assert.rejects(importMediaLibrary(project, bySlug[0].id), /SHA-256|校验/)
  const allAfterDamage = listMediaLibrary()
  assert.ok(allAfterDamage.some(item => item.id === textureId), '参考帧损坏不能阻止全库浏览已有素材')
  assert.ok(allAfterDamage.some(item => item.id === ink.id), '全库浏览应保留其他完好的参考帧')
  assert.match(allAfterDamage[0].libraryWarnings?.join(' ') || '', /06-collage|SHA-256/)
  const imagesAfterDamage = listMediaLibrary({ category: 'image' })
  assert.ok(imagesAfterDamage.some(item => item.id === textureId), '参考帧损坏不能阻止图片库浏览')
  assert.ok(imagesAfterDamage.some(item => item.id === ink.id), '图片库浏览应保留其他完好的参考帧')
  assert.match(imagesAfterDamage[0].libraryWarnings?.join(' ') || '', /06-collage|SHA-256/)
  const onlyDamaged = listMediaLibrary({ query: '拼贴' })
  assert.equal(onlyDamaged.length, 0)
  assert.match(onlyDamaged.libraryWarnings?.join(' ') || '', /06-collage|SHA-256/)
  assert.equal(listMediaLibrary({ query: ink.id })[0].id, ink.id, '完整 ID 查询不受其他风格损坏影响')
  assert.throws(() => listMediaLibrary({ query: '拼贴', category: 'style-reference' }), /SHA-256|校验/)
  assert.equal(listMediaLibrary({ query: '钢琴' })[0].id, soundId)
  assert.equal(listMediaLibrary({ query: '纸张' })[0].id, textureId)
  assert.equal((await importMediaLibrary(project, textureId)).kind, 'image')
  await assert.rejects(importMediaLibrary(project, 'style-reference/../outside.png'), /无效/)
  writeFileSync(join(refs, '06-collage', 'manifest.json'), JSON.stringify({ slug: '06-collage',
    frames: [{ file: '../escape.png', time_seconds: 1, sha256: sha256(fixture) }] }))
  assert.throws(() => listMediaLibrary({ query: '06-collage', category: 'style-reference' }), /文件名无效/)

  process.env.DRAWAI_STYLE_REFERENCE_DIR = join(tmp, 'missing')
  assert.equal(listMediaLibrary({ query: '钢琴' })[0].id, soundId)
  assert.equal(listMediaLibrary({ query: '纸张' })[0].id, textureId)
  assert.throws(() => listMediaLibrary({ category: 'style-reference' }), { code: 'STYLE_REFERENCE_UNAVAILABLE' })
  console.log('风格参考帧素材库：搜索、图片导入、来源许可、完整性、越界和旧素材兼容通过')
} finally {
  if (env.refs === undefined) delete process.env.DRAWAI_STYLE_REFERENCE_DIR; else process.env.DRAWAI_STYLE_REFERENCE_DIR = env.refs
  if (env.assets === undefined) delete process.env.DRAWAI_ASSETS_DIR; else process.env.DRAWAI_ASSETS_DIR = env.assets
  const cleanup = relative(resolve(tmpdir()), resolve(tmp))
  if (!cleanup || isAbsolute(cleanup) || cleanup.startsWith('..')) throw new Error('测试清理路径超出临时目录：' + tmp)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
}
