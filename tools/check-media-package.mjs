// Verify the actual npm package file list, not just the developer checkout.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(command, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, npm_config_cache: resolve('.tmp/npm-cache') },
})
assert.equal(result.status, 0, result.error?.message || result.stderr)
const [packed] = JSON.parse(result.stdout)
const files = new Set(packed.files.map(file => file.path))
const root = 'lib/motion/media-library/'
const catalog = JSON.parse(readFileSync(root + 'upstream-files.json', 'utf8'))
const sha256 = JSON.parse(readFileSync(root + 'checksums.sha256.json', 'utf8')).files
assert.ok(files.has(root + 'upstream-files.json'), '素材索引未进入安装包')
assert.ok(files.has(root + 'checksums.sha256.json'), 'SHA-256 校验清单未进入安装包')
assert.ok(files.has('LICENSE'), '统一素材及第三方说明未进入安装包')
let included = 0
for (const item of catalog.files) {
  const name = root + item.path
  assert.ok(files.has(name), '插件安装包缺少素材：' + item.path)
  const data = readFileSync(join(root, ...item.path.split('/')))
  assert.equal(data.length, item.size, item.path)
  assert.equal(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'), item.sha, item.path)
  assert.equal(createHash('sha256').update(data).digest('hex'), sha256[item.path]?.sha256, item.path)
  included++
}
assert.ok(included > 1, '发布包没有包含纹理和采样')
const fontRoot = 'lib/motion/fonts/'
const fontChecksums = JSON.parse(readFileSync(fontRoot + 'checksums.sha256.json', 'utf8')).files
for (const [name, expected] of Object.entries(fontChecksums)) {
  assert.ok(files.has(fontRoot + name), '插件安装包缺少字体：' + name)
  const data = readFileSync(fontRoot + name)
  assert.equal(createHash('sha256').update(data).digest('hex'), expected.sha256, name)
}
assert.ok(Object.keys(fontChecksums).length >= 36, '字体校验清单应包含中文字体和上游常用字体')
console.log(`npm 安装包素材检查通过：${included} 项已验证，索引和许可说明均已打包`)
