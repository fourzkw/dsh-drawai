// Verify the actual npm package file list, not just the developer checkout.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ASSETS_LOCK } from '../src/motion/asset-pack-lock.js'

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(command, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, npm_config_cache: resolve('.tmp/npm-cache') },
})
assert.equal(result.status, 0, result.error?.message || result.stderr)
const [packed] = JSON.parse(result.stdout)
const files = new Set(packed.files.map(file => file.path))
const root = 'lib/motion/media-library/'
assert.ok(files.has('lib/motion/asset-pack.js'), '按需下载器未进入安装包')
assert.ok(files.has('lib/motion/asset-pack-lock.js'), '素材包校验信息未进入安装包')
assert.match(ASSETS_LOCK.file, /^drawai-assets-.+\.tar\.gz$/)
assert.match(ASSETS_LOCK.sha256, /^[a-f0-9]{64}$/)
assert.ok(ASSETS_LOCK.bytes > 0 && ASSETS_LOCK.files > 0, '素材包大小和文件数必须有效')
assert.ok(![...files].some(name => name.startsWith(root)), '外部素材库不应进入 npm 安装包')
assert.ok(![...files].some(name => name.startsWith('lib/motion/fonts/')), '外部字体不应进入 npm 安装包')
assert.ok(files.has('LICENSE'), '统一素材及第三方说明未进入安装包')
let included = 0
if (existsSync(root + 'upstream-files.json') && existsSync(root + 'checksums.sha256.json')) {
const catalog = JSON.parse(readFileSync(root + 'upstream-files.json', 'utf8'))
const sha256 = JSON.parse(readFileSync(root + 'checksums.sha256.json', 'utf8')).files
for (const item of catalog.files) {
  const name = root + item.path
  const data = readFileSync(join(root, ...item.path.split('/')))
  assert.equal(data.length, item.size, item.path)
  assert.equal(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'), item.sha, item.path)
  assert.equal(createHash('sha256').update(data).digest('hex'), sha256[item.path]?.sha256, item.path)
  included++
}
assert.ok(included > 1, '本地素材库缺少纹理和采样')
}
const fontRoot = 'lib/motion/fonts/'
let fontCount = 0
if (existsSync(fontRoot + 'checksums.sha256.json')) {
const fontChecksums = JSON.parse(readFileSync(fontRoot + 'checksums.sha256.json', 'utf8')).files
for (const [name, expected] of Object.entries(fontChecksums)) {
  const data = readFileSync(fontRoot + name)
  assert.equal(createHash('sha256').update(data).digest('hex'), expected.sha256, name)
  fontCount++
}
assert.ok(Object.keys(fontChecksums).length >= 36, '字体校验清单应包含中文字体和上游常用字体')
}
console.log(`npm 包含素材下载器及校验信息，未内置大素材；本地已校验 ${included} 项素材和 ${fontCount} 个字体文件`)
