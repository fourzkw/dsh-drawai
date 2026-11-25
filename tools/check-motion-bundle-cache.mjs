// bundle 复用判据与重建清理（issue #46）：产物半份 / key 不一致都必须重建，
// 重建前要把上一批按构建期 id 命名的分块清掉。这里只测纯逻辑，不跑打包。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  BUNDLE_ENTRY_FILE, BUNDLE_KEY_FILE, BUNDLE_MAIN_FILE,
  assertBundleDirectory, bundleCacheIsReusable, resetBundleDirectory,
} from '../lib/motion/bundle-cache.js'
import { bundleKey } from '../lib/motion/render.js'

mkdirSync('.tmp', { recursive: true })
const root = mkdtempSync(resolve('.tmp/motion-bundle-cache-'))
try {
  const bundleDir = join(root, '.out', 'bundle')
  mkdirSync(bundleDir, { recursive: true })
  const fill = (key) => {
    writeFileSync(join(bundleDir, BUNDLE_ENTRY_FILE), '<html><body></body></html>')
    writeFileSync(join(bundleDir, BUNDLE_MAIN_FILE), 'console.log("entry")')
    writeFileSync(join(bundleDir, '720.bundle.js'), 'console.log("chunk")')
    writeFileSync(join(bundleDir, BUNDLE_KEY_FILE), key)
  }

  // 空目录什么都不能复用
  assert.equal(bundleCacheIsReusable({ bundleDir, key: 'k1', reuse: true }), false, '空目录不能复用')

  fill('k1')
  assert.equal(bundleCacheIsReusable({ bundleDir, key: 'k1', reuse: true }), true, '文件齐全且 key 一致应复用')
  assert.equal(bundleCacheIsReusable({ bundleDir, key: 'k2', reuse: true }), false, 'key 不一致必须重建')
  assert.equal(bundleCacheIsReusable({ bundleDir, key: 'k1', reuse: false }), false, '调用方没同意复用就重建')
  assert.equal(bundleCacheIsReusable({ bundleDir, key: '', reuse: true }), false, '没有 key 不能复用')
  assert.equal(bundleCacheIsReusable({}), false, '空参数不能复用')

  // 半份产物：index.html 还在、入口分块丢了。页面能打开但画不出任何东西，必须重建。
  rmSync(join(bundleDir, BUNDLE_MAIN_FILE))
  assert.equal(bundleCacheIsReusable({ bundleDir, key: 'k1', reuse: true }), false, '入口分块缺失必须重建')
  rmSync(join(bundleDir, BUNDLE_ENTRY_FILE))
  assert.equal(bundleCacheIsReusable({ bundleDir, key: 'k1', reuse: true }), false, 'index.html 缺失必须重建')

  // 重建清理：清空内容、保留目录本身，并报告确实清掉了东西
  fill('k1')
  assert.equal(resetBundleDirectory(bundleDir), true, '有旧产物时应报告已清理')
  assert.equal(existsSync(bundleDir), true, '清理不能把 bundle 目录本身删掉')
  assert.deepEqual(readdirSync(bundleDir), [], '重建前应清空上一批产物')
  assert.equal(resetBundleDirectory(bundleDir), false, '已经空的目录不算清理过')

  // 目录还不存在：不报错，也不能声称清理过
  rmSync(bundleDir, { recursive: true, force: true })
  assert.equal(resetBundleDirectory(bundleDir), false, '目录不存在时返回 false')

  // 只允许清理我们自己的 bundle 目录，别的一律拒绝
  assert.throws(() => resetBundleDirectory(join(root, '.out')), /拒绝清理/, '.out 本身不能清')
  assert.throws(() => resetBundleDirectory(join(root, 'bundle2')), /不是 bundle 目录/, '名字不是 bundle 不能清')
  assert.throws(() => assertBundleDirectory(''), /拒绝清理/, '空路径不能当作 bundle 目录')

  // bundleKey：片段时序不进 key（拖动/重排不重打包），场景源码、素材、来源 id 才进 key。
  const project = join(root, 'project')
  mkdirSync(join(project, 'assets'), { recursive: true })
  writeFileSync(join(project, 'scene-0.tsx'), 'export default function Scene(){return null}')
  writeFileSync(join(project, 'scene-1.tsx'), 'export default function Scene(){return null}')
  const composition = (shots) => ({ width: 640, height: 360, fps: 30, durationFrames: 180, shots })
  const baseShots = [
    { id: 'clip-a', sourceId: 'shot-1', sceneFile: 'scene-0.tsx', sceneSource: 'export default function Scene(){return null}', startFrame: 0, durationFrames: 90 },
    { id: 'clip-b', sourceId: 'shot-2', sceneFile: 'scene-1.tsx', sceneSource: 'export default function Scene(){return null}', startFrame: 90, durationFrames: 90 },
  ]
  const key = bundleKey(composition(baseShots), project)
  const retimed = baseShots.map((shot, index) => ({ ...shot, id: index === 0 ? 'clip-a2' : shot.id, startFrame: index === 0 ? 30 : 120, durationFrames: index === 0 ? 120 : 60 }))
  assert.equal(bundleKey(composition([...retimed].reverse()), project), key, '重排/裁剪/改片段 id 不应触发重打包')
  writeFileSync(join(project, 'scene-0.tsx'), 'export default function Scene(){return 1}')
  assert.notEqual(bundleKey(composition(baseShots), project), key, '场景源码变化必须重打包')
  writeFileSync(join(project, 'scene-0.tsx'), 'export default function Scene(){return null}')
  writeFileSync(join(project, 'assets', 'hit.wav'), Buffer.from('1234'))
  assert.notEqual(bundleKey(composition(baseShots), project), key, '素材变化必须重打包')
  rmSync(join(project, 'assets', 'hit.wav'))
  const extraSource = [...baseShots, { ...baseShots[0], id: 'clip-c', sourceId: 'shot-3', startFrame: 120, durationFrames: 30 }]
  assert.notEqual(bundleKey(composition(extraSource), project), key, '同一文件的新场景来源要重新登记入口')
  console.log('bundleKey 时序无关与来源/素材敏感通过')
  console.log('bundle 复用判据与重建清理通过')
} finally { try { rmSync(root, { recursive: true, force: true }) } catch { /* 受限工作区可能禁止删除，断言结果不依赖清理 */ } }
