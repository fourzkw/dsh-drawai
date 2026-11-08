// 渲染入口：把"工程目录 + 一个操作"翻译成一次 worker 调用。
//
// 三条规则（对应之前 58 分钟里最贵的三个坑）：
//   1. 永远异步：调用方拿到 jobId 就返回，不要把对话卡在 await 上；
//   2. 永远复用 bundle：预览和全片共用 .out/bundle/.drawai-bundle-key；
//   3. 永远先出图：预览走 renderStill，几秒钟，不跑全片。

import { videoRuntimeDirectory } from './video-runtime.js'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildComposition, readTimeline } from './project.js'
import { assetsHash } from './assets.js'
import { normalizeMix } from './audiomix.js'
import { writeBundledFonts } from './fonts.js'
import { syncRevision, filmHash } from './sync.js'
import { resolveRenderSettings, timeoutFor, describeRenderSettings } from './render-settings.js'

const WORKER = fileURLToPath(new URL('../motion-render-worker.js', import.meta.url))
// entry.jsx 是打包入口：它改了（比如加了 <Audio>）也必须重建 bundle，
// 否则会拿旧缓存渲染出一条没有声音的片子。
const ENTRY = fileURLToPath(new URL('./entry.jsx', import.meta.url))

export function outputPath(dir, name = 'film.mp4') {
  return join(dir, '.out', name)
}

// bundle 的缓存键 = 所有场景源码 + 时间轴 + 尺寸 + 素材指纹。改任何一个字节就重建一次。
export function bundleKey(composition, projectDir) {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({
    width: composition.width, height: composition.height, fps: composition.fps,
    durationFrames: composition.durationFrames,
    shots: composition.shots.map((shot) => [shot.id, shot.startFrame, shot.durationFrames]),
    assets: projectDir ? assetsHash(projectDir) : '',
  }))
  for (const shot of composition.shots) hash.update(shot.sceneSource)
  if (projectDir && existsSync(projectDir)) {
    const walk = (rel = '') => {
      for (const entry of readdirSync(join(projectDir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && ['.out', 'assets', 'node_modules', '.git'].includes(entry.name)) continue
        const next = rel ? join(rel, entry.name) : entry.name
        if (entry.isDirectory()) walk(next)
        else if (entry.isSymbolicLink()) throw new Error('视频工程源码目录不支持符号链接：' + next)
        else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|css|json|svg|wasm)$/i.test(entry.name)) {
          const content = readFileSync(join(projectDir, next))
          hash.update(JSON.stringify([next.replace(/\\/g, '/'), content.length])).update(content)
        }
      }
    }
    walk()
  }
  hash.update(readFileSync(ENTRY))
  hash.update(videoRuntimeDirectory())
  return hash.digest('hex')
}

function prepare(dir, options) {
  writeBundledFonts(dir)
  const composition = options.composition || buildComposition(dir)
  if (!options.composition) composition.bundledFonts = true
  const outDirectory = join(dir, '.out')
  mkdirSync(outDirectory, { recursive: true })
  const publicDir = join(dir, 'assets')
  return { composition, outDirectory, publicDir: existsSync(publicDir) ? publicDir : undefined }
}

// 起一个 render worker。返回 { promise, cancel }：
// promise 在 done/error/exit 时结算，不阻塞调用方。
export function renderProject(dir, options = {}) {
  const { composition, outDirectory, publicDir } = prepare(dir, options)
  const timeline = readTimeline(dir)
  const syncReceipt = timeline.sync ? { revision: syncRevision(dir, timeline), fps: timeline.fps } : null
  const operation = options.operation || 'still'
  // 预览永远按 1× 渲：我们要看的是构图和字，不是锯齿；超采样留给成片。
  const settings = resolveRenderSettings(timeline, options.render)
  const render = operation === 'still' ? { ...settings, scale: 1, samples: 1, estimatedCost: 1 } : settings
  const output = options.output || outputPath(dir, operation === 'still' ? 'still.mp4' : 'film.mp4')
  // 场景拿到的 plan.render 必须是**夹取后的**值：只透传时间轴原值的话，
  // 没写 render 的工程在场景里看到的是 {}，默认采样数就丢了。
  composition.render = render
  const bundleDir = join(outDirectory, 'bundle')
  const request = {
    composition,
    projectDirectory: dir,
    output,
    publicDir,
    bundleDir,
    bundleKey: bundleKey(composition, dir),
    reuseBundle: options.reuseBundle !== false,
    keepBundle: true,
    preserveSources: true,
    operation,
    assets: options.assets || {},
    render,
    frames: operation === 'still' ? (options.frames || []).map((frame) => Math.round(Number(frame))) : undefined,
    frameRange: options.frameRange,
    qaDirectory: join(outDirectory, 'qa'),
    poster: join(outDirectory, 'poster.png'),
  }
  if (operation === 'still' && !request.frames.length) throw new Error('预览需要至少一帧，例如 frames:[0,60,120]')
  if (operation === 'still' && request.frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= composition.durationFrames))
    throw new Error('预览帧超出 0–' + (composition.durationFrames - 1))

  // 临时目录放进工程里，别用系统的 %TEMP%（issue #26）。
  //
  // Windows 上 `.dsh` 可能带 Low 完整性标签：DSH 的沙箱会给自己当工作区用过的目录打
  // Low 标签，标签可继承，于是 `.dsh` 里的 ffmpeg.exe 以 Low IL 运行，而 Low IL 受
  // no-write-up 约束，写不了 Medium 的 `C:\Users\…\AppData\Local\Temp`。renderMedia 的
  // 中间文件 `pre-encode.mp4` 恰好写在 `os.tmpdir()`（@remotion/renderer 里硬编码，
  // 没有参数可改），正片渲到几十帧就 `Error opening output … Permission denied`。
  //
  // 指到工程目录下就没这个问题：那是工作区，Low IL 也写得进去（motion_preview 一直好使，
  // 因为 renderStill 只往 `.out/qa/` 写）。fork 时通过 env 传，子进程里的 os.tmpdir()
  // 会先读 TMP/TEMP。
  const tempDirectory = join(outDirectory, 'tmp')
  mkdirSync(tempDirectory, { recursive: true })
  const child = fork(WORKER, [], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: [],
    env: { ...process.env, TEMP: tempDirectory, TMP: tempDirectory },
  })
  let settled = false
  let cancelTimer
  const rendered = new Promise((resolve, reject) => {
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(cancelTimer); fn(value) }
    const timeout = setTimeout(() => { child.kill(); finish(reject, new Error('渲染超过 ' + Math.round(timeoutFor(render, composition.durationFrames) / 60000) + ' 分钟，请拆小场景或在 timeline.json 的 render.timeoutMs 里放大预算')) }, options.timeoutMs || (timeoutFor(render, composition.durationFrames) + 11 * 60000))
    let stderr = ''
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-4000) })
    child.on('message', (message) => {
      if (message.type === 'progress') options.onProgress?.(message)
      if (message.type === 'done') { clearTimeout(timeout); finish(resolve, { ...message, output, bundleDir }) }
      if (message.type === 'error') { clearTimeout(timeout); finish(reject, new Error(message.error)) }
    })
    child.on('error', (error) => { clearTimeout(timeout); finish(reject, error) })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (!settled) finish(reject, new Error('渲染进程退出（' + code + '）：' + stderr))
    })
    child.send(request)
  })
  const cancel = () => {
    if (child.connected) child.send({ type: 'cancel' })
    cancelTimer = setTimeout(() => child.kill(), 5000)
  }
  // 渲完之后再过一遍响度归一 + 限幅。
  // 只对整片做：切片渲染（frameRange）归一化会把片段当整条量，结果是错的。
  // 归一化的目标可以在 timeline.json 的 audioMix 里改，也可以在调用时用 options.mix 覆盖。
  const promise = rendered.then(async (result) => {
    if (operation !== 'full' || options.frameRange) return result
    if (!(composition.audio || []).length) return result
    let config = {}
    try { config = { ...(readTimeline(dir).audioMix || {}) } } catch { config = {} }
    config = { ...config, ...(options.mix || {}) }
    if (config.normalize === false) return result
    options.onProgress?.({ type: 'progress', phase: 'mixing', progress: 0.97 })
    try {
      const mix = await normalizeMix(output, { ...config, cwd: outDirectory, log: join(outDirectory, 'mix.log'), timeoutMs: 180000 })
      return { ...result, mix }
    } catch (error) {
      // 混音后级失败不该让一条已经渲好的片子作废：带着错误回去，由调用方提示。
      return { ...result, mixError: error.message }
    }
  })
  const completed = promise.then((result) => {
    if (operation === 'full' && !options.frameRange && syncReceipt) writeFileSync(output + '.sync.json', JSON.stringify({ ...syncReceipt, filmHash: filmHash(output) }))
    return { ...result, render, renderSummary: describeRenderSettings(render) }
  })
  return { promise: completed, cancel, output, bundleDir, render }
}

export function outputInfo(file) {
  if (!existsSync(file)) return null
  const stat = statSync(file)
  return { path: file, bytes: stat.size, at: stat.mtime.toISOString() }
}
