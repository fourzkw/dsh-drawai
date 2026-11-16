/**
 * bundle 目录的复用判据与重建清理。
 *
 * 背景（issue #46）：一次渲染页拍出来的帧只有容器底色时，除了浏览器本身的问题，
 * 还有一种可能是 `.out/bundle` 里混着两次构建的产物 —— webpack 分块的文件名是按
 * 构建期 id 定的（`720.bundle.js`、`98.bundle.js`…，同名不同内容），而
 * `@remotion/bundler` 的 `bundle()` 并不清理 outDir：重建一次，上一批分块还留在
 * 目录里，一个工程的 `.out` 能涨到几十 MB。这里把「能不能复用」收紧到必需文件
 * 齐全，并在重建前先清空目录，只留这一批干净的产物。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const BUNDLE_KEY_FILE = '.drawai-bundle-key'
export const BUNDLE_ENTRY_FILE = 'index.html'
// 入口分块由 @remotion/bundler 固定命名为 bundle.js；其余分块按构建期 id 命名。
export const BUNDLE_MAIN_FILE = 'bundle.js'

/** 目录是不是一次打包的完整产物：缺任何一个必需文件都不能当成命中缓存。 */
export function bundleCacheIsReusable({ bundleDir, key, reuse } = {}) {
  if (reuse !== true || !key) return false
  if (typeof bundleDir !== 'string' || !bundleDir) return false
  if (!existsSync(join(bundleDir, BUNDLE_ENTRY_FILE))) return false
  // 只剩 index.html、入口分块丢了的话，页面照样能打开，却画不出任何东西 ——
  // 这种「半份产物」必须重新打包（对应报告里那种只有容器底色的帧）。
  if (!existsSync(join(bundleDir, BUNDLE_MAIN_FILE))) return false
  const cacheFile = join(bundleDir, BUNDLE_KEY_FILE)
  if (!existsSync(cacheFile)) return false
  return readFileSync(cacheFile, 'utf8').trim() === key
}

/** 只允许清理我们自己的 `<工程>/.out/bundle`；别的路径一律拒绝，避免误删。 */
export function assertBundleDirectory(bundleDir) {
  const target = resolve(bundleDir)
  if (basename(target) !== 'bundle') throw new Error('拒绝清理 bundle 目录：' + target + ' 不是 bundle 目录')
  if (!existsSync(target)) return target
  if (!statSync(target).isDirectory()) throw new Error('拒绝清理 bundle 目录：' + target + ' 不是目录')
  return target
}

/** 重建前清空：上一批的 index.html 与按 id 命名的分块一起清掉，避免新旧混批。 */
export function resetBundleDirectory(bundleDir) {
  const target = assertBundleDirectory(bundleDir)
  if (!existsSync(target)) return false
  const entries = readdirSync(target)
  for (const entry of entries) rmSync(join(target, entry), { recursive: true, force: true })
  return entries.length > 0
}
