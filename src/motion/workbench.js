// 剪辑工作台的预览打包。
//
// 预览和正式渲染共用 entry.jsx 里的 MotionMovie；工作台 UI + Remotion Player 与工程场景
// 一起打成一个独立 bundle。bundleKey 只覆盖“会进代码”的东西（场景源码、组件、素材、运行时），
// **不包含片段时序**：拖动播放头/重排片段只更新 Player 的 inputProps，不会重新打包。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleKey } from './render.js'
import { prepareMotionProject } from '../motion-project.js'
import { videoRuntimeRequire, videoRuntimeDirectory } from './video-runtime.js'
import { BUNDLE_KEY_FILE, bundleCacheIsReusable, resetBundleDirectory } from './bundle-cache.js'
import { uniqueSources } from './timeline.js'

const RUNTIME = fileURLToPath(new URL('./workbench-runtime.jsx', import.meta.url))
const OPS = fileURLToPath(new URL('./timeline-ops.js', import.meta.url))
const GENERATED = '// 由 dsh-drawai 生成，请勿手改；插件更新后会按源文件重新生成。\n'
const ENTRY = 'workbench-entry.gen.jsx'
// 工作台 bundle 协议版本：改了入口生成规则或运行时契约就 +1。
const WORKBENCH_BUNDLE_VERSION = 1

export function workbenchBundleDir(dir) {
  return join(dir, '.out', 'workbench', 'bundle')
}

export function workbenchBundleKey(dir, timeline) {
  const sources = uniqueSources(timeline)
  const composition = {
    width: timeline.width, height: timeline.height, fps: timeline.fps,
    shots: sources.map((source) => ({
      id: source.id,
      sceneFile: source.file,
      sceneSource: existsSync(join(dir, source.file)) ? readFileSync(join(dir, source.file), 'utf8') : '',
    })),
  }
  const hash = createHash('sha256')
  hash.update('workbench-v' + WORKBENCH_BUNDLE_VERSION)
  hash.update(bundleKey(composition, dir))
  hash.update(readFileSync(RUNTIME))
  hash.update(readFileSync(OPS))
  hash.update(JSON.stringify(sources.map((source) => [source.id, source.file])))
  hash.update(JSON.stringify({ width: timeline.width, height: timeline.height, fps: timeline.fps }))
  if (existsSync(dir)) {
    for (const entry of ['theme.ts', 'theme.tsx', 'scene-kit']) {
      const path = join(dir, entry)
      if (existsSync(path) && statSync(path).isFile()) hash.update(entry).update(readFileSync(path))
    }
  }
  return hash.digest('hex').slice(0, 24)
}

function writeGenerated(file, source) {
  const desired = GENERATED + source
  if (existsSync(file) && readFileSync(file, 'utf8') === desired) return
  mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  writeFileSync(file, desired, 'utf8')
}

/** 生成工作台入口：场景按**文件**去重 import，片段 id 稳定映射到同一个组件。 */
export function prepareWorkbenchEntry(dir, composition) {
  const imports = [], entries = new Map(), byFile = new Map()
  for (const shot of composition.shots) {
    if (shot.recipeId !== 'scene') continue
    const file = String(shot.sceneFile || shot.file || '').replace(/\\/g, '/')
    if (!file) throw new Error('工作台场景缺少文件：' + shot.id)
    let local = byFile.get(file)
    if (!local) {
      local = 'Scene' + byFile.size
      byFile.set(file, local)
      imports.push(`import ${local} from './${file}';`)
    }
    entries.set(shot.sourceId || shot.id, local)
  }
  const source = `import {registerWorkbenchRoot} from './workbench-runtime.gen.jsx';\n${imports.join('\n')}\nregisterWorkbenchRoot({${[...entries].map(([id, local]) => JSON.stringify(id) + ':' + local).join(',')}});\n`
  const entry = join(dir, ENTRY)
  if (!existsSync(entry) || readFileSync(entry, 'utf8') !== source) writeFileSync(entry, source, 'utf8')
  return entry
}

export function prepareWorkbenchSources(dir, composition, options = {}) {
  // 运行时和纯编辑操作也复制进工程：Remotion 的 webpack 只对工程目录里的相对模块挂 loader。
  writeGenerated(join(dir, 'workbench-runtime.gen.jsx'), readFileSync(RUNTIME, 'utf8'))
  writeGenerated(join(dir, 'timeline-ops.gen.js'), readFileSync(OPS, 'utf8'))
  const project = prepareMotionProject(composition, dir, { preserveSources: true, runtimeDirectory: options.runtimeDirectory })
  const entryPoint = prepareWorkbenchEntry(dir, composition)
  return { entryPoint, webpackOverride: project.webpackOverride }
}

/**
 * 确保预览 bundle 是最新的。返回 {dir, key, reused}。
 * 调用方负责先 ensureVideoRuntime（需要 @remotion/bundler）。
 */
const pendingBuilds = new Map()

export function ensureWorkbenchBundle(args = {}) {
  const key = String(args.dir || '')
  if (!key) return Promise.reject(new Error('工作台打包缺少工程目录'))
  if (pendingBuilds.has(key)) return pendingBuilds.get(key)
  const work = buildWorkbenchBundle(args)
  pendingBuilds.set(key, work)
  work.finally(() => pendingBuilds.delete(key)).catch(() => {})
  return work
}

async function buildWorkbenchBundle({ dir, composition, timeline, runtimeDirectory = videoRuntimeDirectory(), force = false, onProgress } = {}) {
  // 先生成入口文件再算 key：生成文件本身也在 bundleKey 的源码遍历里，
  // 反过来算会在第一次打开后多触发一次重建。
  const { entryPoint, webpackOverride } = prepareWorkbenchSources(dir, composition, { runtimeDirectory })
  const key = workbenchBundleKey(dir, timeline)
  const bundleDir = workbenchBundleDir(dir)
  if (!force && bundleCacheIsReusable({ bundleDir, key, reuse: true })) {
    return { dir: bundleDir, key, reused: true }
  }
  resetBundleDirectory(bundleDir)
  mkdirSync(bundleDir, { recursive: true })
  const require = videoRuntimeRequire(runtimeDirectory)
  const { bundle } = require('@remotion/bundler')
  await bundle({
    entryPoint,
    outDir: bundleDir,
    webpackOverride,
    ignoreRegisterRootWarning: true,
    onProgress: (progress) => onProgress?.({ phase: 'bundling', progress: Math.max(0, Math.min(1, Number(progress) / 100 || 0)) }),
  })
  if (!existsSync(join(bundleDir, 'bundle.js'))) throw new Error('预览打包没有产出 bundle.js：' + bundleDir)
  writeFileSync(join(bundleDir, BUNDLE_KEY_FILE), key, 'utf8')
  return { dir: bundleDir, key, reused: false }
}

export function workbenchRuntimeFiles() {
  return { runtime: RUNTIME, ops: OPS }
}
