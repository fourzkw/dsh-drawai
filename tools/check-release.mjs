/**
 * 发版闸门：打 tag 之前必须 build，而且构建产物必须已经在提交里。
 *
 * 为什么需要它：0.4.5 的 src/motion/sync.js 改了、lib/motion/sync.js 没重建，
 * 发布提交（chore(release)）又只动了 package.json 与文档，再加上 check-package
 * 的同步检查不含 lib/motion/** —— 三个口子叠在一起，带旧参数（-vsync）的产物
 * 进了 tag 和 npm 包（#43）。
 *
 * 用法：
 *   npm run release:check                       # 完整：build + 同步 + 烟测 + 全量测试
 *   node tools/check-release.mjs --skip-tests   # 跳过 npm test（CI / 快速自检）
 *   node tools/check-release.mjs --skip-package # 跳过 check-package（没有 @deepseek-ai/dsh-tools 的环境）
 *
 * 退出码 0 才允许 git tag。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const flags = new Set(process.argv.slice(2))
const skipTests = flags.has('--skip-tests')
const skipPackage = flags.has('--skip-package')

function fail(message) {
  console.error('\n✗ ' + message)
  process.exit(1)
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function run(label, file, args) {
  console.log('\n▶ ' + label)
  const started = Date.now()
  const result = spawnSync(file, args, { stdio: 'inherit' })
  if (result.error) fail(label + ' 起不来：' + result.error.message)
  if (result.status !== 0) fail(label + ' 失败（退出码 ' + result.status + '）')
  console.log('✓ ' + label + '（' + ((Date.now() - started) / 1000).toFixed(1) + 's）')
}

try {
  git('rev-parse', '--is-inside-work-tree')
} catch (error) {
  fail('不在 git 工作区里：发版检查要看提交与 tag')
}

// 脏着打 tag，未提交的构建产物就漏在版本外面了。
const before = git('status', '--porcelain')
if (before !== '') fail('工作树不干净，先提交或还原再发版：\n' + before)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

// 真的跑一次构建：lib/ 是由 src/ 生成的，不跑就等于没更新。
run('构建（node tools/build.mjs）', process.execPath, ['tools/build.mjs'])

// 构建之后还有差异 = 提交里的 lib/ 是旧的（或 src/ 改了没提交）。
const after = git('status', '--porcelain')
if (after !== '') {
  fail('构建产物和提交对不上——把 lib/ 的变更一起提交后再打 tag：\n' + after)
}

if (!skipPackage) run('安装前烟测（node tools/check-package.mjs）', process.execPath, ['tools/check-package.mjs'])

if (!skipTests) {
  if (process.platform === 'win32') run('全量测试（npm test）', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm test'])
  else run('全量测试（npm test）', 'npm', ['test'])
}

// 版本号提醒：同一个版本号不要再发一份内容不同的包（只提醒，不拦）。
try {
  const tagged = git('rev-parse', '-q', '--verify', 'refs/tags/v' + pkg.version)
  const head = git('rev-parse', 'HEAD')
  console.log('\n! 版本 ' + pkg.version + ' 已经有 tag v' + pkg.version + '（' + tagged.slice(0, 7) + '）'
    + (tagged === head ? '，指向当前提交' : '') + '；要发新内容先升 package.json 的版本号。')
} catch (error) {
  // 还没有这个 tag：正常。
}

console.log('\n✓ 构建产物与提交一致，可以打 tag：git tag v' + pkg.version + ' && git push github v' + pkg.version)
