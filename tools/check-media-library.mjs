import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const build = process.argv.includes('--lib') ? 'lib' : 'src'
const { listMediaLibrary, importMediaLibrary } = await import('../' + build + '/motion/media-catalog.js')
const { readAssets } = await import('../' + build + '/motion/assets.js')
const items = listMediaLibrary()
assert.equal(items.length, 111)
assert.equal(items.filter(x => x.kind === 'image').length, 9)
assert.equal(items.filter(x => x.kind === 'audio').length, 102)
assert.ok(listMediaLibrary({ query: '钢琴' }).length > 1)
assert.equal(listMediaLibrary({ category: 'paper' }).length, 1)
for (const item of items) {
  const data = readFileSync(join(build, 'motion/media-library', ...item.id.split('/')))
  assert.equal(data.length, item.bytes, item.id)
  assert.equal(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'), item.gitSha, item.id)
}
const dir = mkdtempSync(join(tmpdir(), 'drawai-media-library-'))
try {
  const image = await importMediaLibrary(dir, items.find(x => x.category === 'paper').id)
  const audio = await importMediaLibrary(dir, items.find(x => x.category === 'piano').id)
  assert.equal(image.kind, 'image')
  assert.equal(audio.kind, 'audio')
  assert.ok(audio.seconds > 0)
  assert.equal(audio.license, 'CC0-1.0')
  assert.equal(readAssets(dir).items.length, 2)
  await importMediaLibrary(dir, items.find(x => x.category === 'piano').id)
  assert.equal(readAssets(dir).items.length, 2, '重复导入应按内容去重')
  await assert.rejects(importMediaLibrary(dir, '../../outside'), /未找到/)
  const partial = join(dir, 'partial'), library = join(partial, 'media-library')
  mkdirSync(join(library, 'assets', 'textures', 'paper'), { recursive: true })
  writeFileSync(join(partial, 'package.json'), '{"type":"module"}')
  writeFileSync(join(partial, 'assets.js'), `export {captureAsset,readAssets,writeAssets} from ${JSON.stringify(pathToFileURL(resolve(build, 'motion/assets.js')).href)}\n`)
  copyFileSync(join(build, 'motion', 'media-catalog.js'), join(partial, 'media-catalog.js'))
  const alteredIndex = JSON.parse(readFileSync(join(build, 'motion', 'media-library', 'upstream-files.json'), 'utf8'))
  alteredIndex.files.find(x => x.path.endsWith('Paper001_4K_color.jpg')).sha = '0'.repeat(40)
  writeFileSync(join(library, 'upstream-files.json'), JSON.stringify(alteredIndex))
  copyFileSync(join(build, 'motion', 'media-library', 'assets', 'textures', 'paper', 'Paper001_4K_color.jpg'), join(library, 'assets', 'textures', 'paper', 'Paper001_4K_color.jpg'))
  const partialCatalog = await import(pathToFileURL(join(partial, 'media-catalog.js')).href)
  assert.deepEqual(partialCatalog.listMediaLibrary().map(item => item.category), ['paper'], '缺失的文件不应显示在素材库里')
  const mismatched = await partialCatalog.importMediaLibrary(dir, 'assets/textures/paper/Paper001_4K_color.jpg')
  assert.ok(mismatched.integrity.warnings.some(x => x.includes('SHA-1')), 'SHA-1 不符应提示而不阻止导入')
  assert.match(mismatched.license, /未确认/, '上游内容不匹配时不能把原许可直接归给本地文件')
  assert.match(mismatched.integrity.sha256, /^[a-f0-9]{64}$/)
  assert.ok(readAssets(dir).items.find(x => x.file === mismatched.file).integrity.warnings.some(x => x.includes('SHA-1')), '校验提示应保存在工程素材清单')
  console.log(build + '：111 项哈希、筛选、图片和音频导入、去重通过')
} finally { rmSync(dir, { recursive: true, force: true }) }
