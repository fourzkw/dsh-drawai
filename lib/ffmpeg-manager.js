/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/**
 * 独立的 FFmpeg 管理器。
 *
 * 目标：新用户第一次用到音频 / 素材 / 视频功能时，自动拿到一个可用的 FFmpeg，
 * 而不是先看到「未找到 FFmpeg」再自己去装。查找顺序固定：
 *
 *   1. DRAWAI_FFMPEG_PATH（显式指定；无效就直接报错，不回退，免得用户以为设置生效了）
 *   2. 系统 PATH
 *   3. 开发工作区的 _local/bin（只有源码 checkout 里才有）
 *   4. 已验证的独立缓存 ~/.dsh/drawai-ffmpeg/<platform>-<arch>/
 *   5. 按平台下载 FFmpeg 官方页面列出的预编译构建，校验后放进缓存
 *
 * 缓存写入走 staging + 跨进程锁 + 原子 rename，失败或取消会清掉临时文件，
 * 下一次操作可以直接重试。下载只在真正需要 FFmpeg 时发生，模块 import 本身不做任何 IO。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import zlib from 'node:zlib'

const READY_FILE = '.ready.json'
const READY_SCHEMA = 1
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024
const DOWNLOAD_IDLE_MS = 90_000
const LOCK_STALE_MS = 10 * 60 * 1000
const LOCK_WAIT_MS = 3 * 60 * 1000
/** 项目用到 -fps_mode（FFmpeg 5.1 起）等较新选项，更老的构建会在真实任务里失败。 */
const FFMPEG_MIN_VERSION = [5, 1]
const FFMPEG_MIN_VERSION_TEXT = '5.1'

const BTBN_RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/'
const BTBN_VERSION = '8.1.3'

/**
 * 从 FFmpeg 官方下载页（https://ffmpeg.org/download.html）列出的预编译来源里
 * 固定下来的具体版本。所有条目都带 SHA-256：
 * - gyan.dev / BtbN 校验压缩包；
 * - osxexperts 只公布解压后 FFmpeg 文件的哈希，所以校验二进制本身。
 * 构建均为 GPL（含 libx264 / libx265），本项目只在运行时下载并作为独立进程调用。
 */
export const FFMPEG_REGISTRY = Object.freeze({
  'win32-x64': Object.freeze({
    version: '8.1.2',
    archive: 'zip',
    url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip',
    size: 109728040,
    sha256: 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec',
    license: 'GPL-3.0-or-later',
    credit: 'gyan.dev（FFmpeg 官方下载页列出的 Windows 构建）',
    homepage: 'https://www.gyan.dev/ffmpeg/builds/',
  }),
  'win32-arm64': Object.freeze({
    version: BTBN_VERSION,
    archive: 'zip',
    url: BTBN_RELEASE + 'ffmpeg-n8.1.3-27-g8dca1586f4-winarm64-gpl-8.1.zip',
    size: 134963677,
    sha256: '40029da82e02abf0d12491e23666e710b7a8943d13501594cf38e6135b95efba',
    license: 'GPL-3.0-or-later',
    credit: 'BtbN/FFmpeg-Builds（FFmpeg 官方下载页列出的 Windows 构建）',
    homepage: 'https://github.com/BtbN/FFmpeg-Builds',
  }),
  'linux-x64': Object.freeze({
    version: BTBN_VERSION,
    archive: 'tar.xz',
    url: BTBN_RELEASE + 'ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-8.1.tar.xz',
    size: 152246308,
    sha256: '41e9c565594c390622cf968d82fa4135d9e9a11d06c1515644288cbc844e3380',
    license: 'GPL-3.0-or-later',
    credit: 'BtbN/FFmpeg-Builds（FFmpeg 官方下载页列出的 Linux 构建）',
    homepage: 'https://github.com/BtbN/FFmpeg-Builds',
  }),
  'linux-arm64': Object.freeze({
    version: BTBN_VERSION,
    archive: 'tar.xz',
    url: BTBN_RELEASE + 'ffmpeg-n8.1.3-27-g8dca1586f4-linuxarm64-gpl-8.1.tar.xz',
    size: 127720576,
    sha256: 'a08c0ee6e1c4e02139344b303002dcc7c37cf125d639f1fbd15dabee40fcb525',
    license: 'GPL-3.0-or-later',
    credit: 'BtbN/FFmpeg-Builds（FFmpeg 官方下载页列出的 Linux 构建）',
    homepage: 'https://github.com/BtbN/FFmpeg-Builds',
  }),
  'darwin-arm64': Object.freeze({
    version: '9.0.2',
    archive: 'zip',
    url: 'https://www.osxexperts.net/ffmpeg902arm.zip',
    // 官网只公布解压后 FFmpeg 文件的 SHA-256，没有压缩包哈希。
    binarySha256: '762f16b2913b8d3b8fdb8092df12b691053b035b13ae9b88205513c55cb8e71e',
    license: 'GPL-3.0-or-later',
    credit: 'OSXExperts（FFmpeg 官方下载页列出的 Apple Silicon 构建）',
    homepage: 'https://www.osxexperts.net/',
  }),
  'darwin-x64': Object.freeze({
    version: '8.0',
    archive: 'zip',
    url: 'https://www.osxexperts.net/ffmpeg80intel.zip',
    binarySha256: 'df3f1e3facdc1ae0ad0bd898cdfb072fbc9641bf47b11f172844525a05db8d11',
    license: 'GPL-3.0-or-later',
    credit: 'OSXExperts（FFmpeg 官方下载页列出的 macOS Intel 构建）',
    homepage: 'https://www.osxexperts.net/',
  }),
})

/**
 * 项目实际用到的全部 FFmpeg 能力。来源是 src 里所有 ffmpeg 调用：
 * - 音频导入（mp3/wav/m4a/aac/ogg/flac/webm）与 48kHz 转码、响度/峰值分析
 * - 混音（裁切、循环、增益、淡入淡出、延迟、amix、限幅）
 * - 视频探测、抽帧、帧检（黑场/静帧/信号统计）、接触表
 * - 逐帧导出与 GIF/MP4/WebM 编码、调色板两遍法
 * - 剪映交付包（ProRes 母版、竖版合成）
 * 这些名字同时用于校验环境变量、PATH、缓存和下载的构建；缺一项都视为不可用。
 */
export const FFMPEG_REQUIRED_FEATURES = Object.freeze({
  encoders: Object.freeze(['libx264', 'libvpx-vp9', 'aac', 'libopus', 'gif', 'png', 'mjpeg', 'prores_ks', 'ffv1', 'pcm_s16le', 'pcm_s24le', 'rawvideo']),
  decoders: Object.freeze(['h264', 'hevc', 'vp9', 'png', 'mjpeg', 'gif', 'aac', 'opus', 'mp3', 'flac', 'vorbis', 'pcm_s16le', 'pcm_s24le']),
  filters: Object.freeze([
    'scale', 'crop', 'pad', 'overlay', 'split', 'lutrgb', 'palettegen', 'paletteuse', 'tile',
    'fps', 'format', 'tpad', 'trim', 'setpts', 'setsar', 'select', 'signalstats', 'metadata', 'gblur', 'color',
    'amix', 'alimiter', 'afade', 'apad', 'atrim', 'adelay', 'loudnorm', 'ebur128', 'volumedetect',
    'blackdetect', 'freezedetect', 'silencedetect', 'volume', 'aloop', 'asetpts',
  ]),
  muxers: Object.freeze(['mp4', 'mov', 'webm', 'gif', 'matroska', 'image2', 'image2pipe', 'wav', 'null', 'rawvideo', 's16le', 'ipod']),
  demuxers: Object.freeze(['mp4', 'mov', 'm4a', 'matroska', 'webm', 'ogg', 'wav', 'mp3', 'flac', 'aac', 'gif', 'image2', 'lavfi']),
})

const REQUIRED_FEATURES = FFMPEG_REQUIRED_FEATURES

const FEATURE_LABELS = Object.freeze({ encoders: '编码器', decoders: '解码器', filters: '滤镜', muxers: '封装器', demuxers: '解封装器' })
const FEATURE_LISTS = Object.freeze({
  encoders: ['-encoders'],
  decoders: ['-decoders'],
  filters: ['-filters'],
  muxers: ['-muxers'],
  demuxers: ['-demuxers'],
})

let memo = null
let state = {
  status: 'unknown',
  path: null,
  source: null,
  version: null,
  cacheDirectory: null,
  error: null,
  progress: null,
}

/** 缓存目录：默认 ~/.dsh/drawai-ffmpeg，可用 DRAWAI_FFMPEG_DIR 覆盖。 */
export function ffmpegCacheDirectory() {
  const configured = (process.env.DRAWAI_FFMPEG_DIR || '').trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh', 'drawai-ffmpeg')
}

/** 只读状态，给诊断/界面用。progress 是最近一次准备进度。 */
export function ffmpegState() {
  return { ...state, progress: state.progress ? { ...state.progress } : null }
}

/** 没有异步准备过时的同步近似值：env → PATH → 开发目录 → 缓存 → 'ffmpeg'。 */
export function ffmpegPathSync() {
  if (state.path) return state.path
  const explicit = explicitBinaryPath()
  if (explicit) return explicit
  const onPath = findOnPathSync()
  if (onPath) return onPath
  const development = developmentBinaryPath()
  if (development) return development
  const cached = cachedBinarySync()
  if (cached) return cached
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

/** 明确指定并已经验证过的路径；找不到时给 null。 */
export function resolvedFfmpegPath() {
  return state.status === 'ready' ? state.path : null
}

/**
 * 确保 FFmpeg 可用。同一次准备在进程内共享下载/校验/解压工作，但每个调用者
 * 有自己的取消信号与进度回调：某个调用者取消不会把别的调用者一起取消；
 * 只有所有等待者都取消时才中止后台下载，之后可以重新调用重试。
 */
export function ensureFfmpeg(options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const cacheDir = options.cacheDir || ffmpegCacheDirectory()
  if (options.signal?.aborted) return Promise.reject(abortedError())
  // PATH 与显式路径也进 key：环境变了就重新解析，避免沿用旧结论。
  const key = [
    `${platform}-${arch}`,
    cacheDir,
    options.registry ? 'custom' : 'default',
    explicitBinaryPath() || '',
    process.env.PATH || '',
  ].join('|')
  let record = memo && memo.key === key ? memo : null
  // 已经完成时 refresh 才需要重新解析；正在安装时 refresh 直接加入，避免并发下载。
  if (record?.settled && options.refresh) record = null
  if (!record) {
    record = { key, controller: new AbortController(), listeners: new Set(), waiters: 0, snapshot: null, settled: false, promise: null }
    memo = record
    record.promise = resolveFfmpeg({
      ...options,
      platform,
      arch,
      cacheDir,
      signal: record.controller.signal,
      onProgress: (event) => publish(record, event),
    })
    record.promise.then(
      () => { record.settled = true },
      () => { record.settled = true; if (memo === record) memo = null },
    )
  }
  return attachCaller(record, options)
}

/** 把进度事件发给当前所有调用者；晚加入的调用者会先收到最近一次快照。 */
function publish(record, event) {
  record.snapshot = event
  state = { ...state, progress: event }
  for (const listener of [...record.listeners]) {
    try {
      listener(event)
    } catch {
      // 单个调用者的回调异常不能中断准备
    }
  }
}

function attachCaller(record, { signal, onProgress }) {
  const listener = typeof onProgress === 'function'
    ? (event) => { try { onProgress(event) } catch { /* 忽略 */ } }
    : null
  record.waiters += 1
  if (listener) {
    record.listeners.add(listener)
    if (record.snapshot) queueMicrotask(() => { if (record.listeners.has(listener)) listener(record.snapshot) })
  }
  let done = false
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      if (listener) record.listeners.delete(listener)
      record.waiters = Math.max(0, record.waiters - 1)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (settle, value) => {
      if (done) return
      done = true
      cleanup()
      settle(value)
    }
    const onAbort = () => {
      finish(reject, abortedError())
      if (record.waiters === 0 && !record.settled) record.controller.abort()
    }
    record.promise.then((value) => finish(resolvePromise, value), (error) => finish(reject, error))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * 删掉**本平台**的独立缓存并忘记本次进程内的解析结果。
 * 只删除 `<cache>/<platform>-<arch>`、该平台的 staging 和锁目录；
 * 缓存目录里其他平台的文件、用户自己放的文件都不会动。
 */
export async function resetFfmpegCache({ cacheDir = ffmpegCacheDirectory(), platform = process.platform, arch = process.arch } = {}) {
  memo?.controller.abort()
  memo = null
  state = { status: 'unknown', path: null, source: null, version: null, cacheDirectory: null, error: null, progress: null }
  const suffix = `${platform}-${arch}`
  let entries
  try {
    entries = readdirSync(cacheDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === suffix || name === `.lock-${suffix}` || name.startsWith(`.staging-${suffix}-`)) {
      rmSync(join(cacheDir, name), { recursive: true, force: true })
    }
  }
}

async function resolveFfmpeg({ platform, arch, cacheDir, signal, onProgress, registry, probe = probeFfmpeg, readFeatures = readFfmpegFeatures, smoke = smokeFfmpeg, allowDownload = true, allowDevelopment = true }) {
  throwIfAborted(signal)
  setState({ status: 'resolving', cacheDirectory: cacheDir, path: null, error: null })
  emit(onProgress, { phase: 'resolve', message: '正在查找 FFmpeg…' })

  const rejected = []
  const explicit = explicitBinaryPath()
  if (explicit) {
    const inspection = await inspectBinary(explicit, { probe, readFeatures, smoke, signal })
    if (!inspection.ok) {
      const detail = inspection.missing.length ? `缺少项目需要的组件：${inspection.missing.join('、')}` : inspection.reason
      const error = ffmpegError(`DRAWAI_FFMPEG_PATH 指定的 FFmpeg 不可用：${explicit}（${detail}）。这个路径不会被自动替换成其他 FFmpeg；请修正路径，或删除这个环境变量，让 DrawAI 自动准备 FFmpeg。`, 'FFMPEG_INVALID_PATH')
      setState({ status: 'invalid', path: null, source: 'environment', error: error.message })
      throw error
    }
    return ready(explicit, 'environment', inspection.version)
  }

  for (const candidate of findOnPath(platform)) {
    const inspection = await inspectBinary(candidate, { probe, readFeatures, smoke, signal })
    if (inspection.ok) return ready(candidate, 'path', inspection.version)
    rejected.push(`${candidate}：${inspection.missing.length ? '缺少 ' + inspection.missing.join('、') : inspection.reason}`)
  }

  if (allowDevelopment) {
    const development = developmentBinaryPath(platform)
    if (development) {
      const inspection = await inspectBinary(development, { probe, readFeatures, smoke, signal })
      if (inspection.ok) return ready(development, 'development', inspection.version)
      rejected.push(`${development}：${inspection.missing.length ? '缺少 ' + inspection.missing.join('、') : inspection.reason}`)
    }
  }

  const table = registry || FFMPEG_REGISTRY
  const entry = table[`${platform}-${arch}`]
  // 缓存复用也要核对版本、二进制哈希和功能，而不是只要能跑 `-version` 就算数。
  const cached = await inspectCache(join(cacheDir, `${platform}-${arch}`), { platform, arch, entry, probe, readFeatures, smoke, signal })
  if (cached) return ready(cached.path, 'cache', cached.ready.version)

  if (!entry) {
    const suffix = rejected.length ? ` 已找到但不能用的 FFmpeg：${rejected.join('；')}。` : ''
    const error = ffmpegError(`当前平台（${platform}-${arch}）没有可自动下载的 FFmpeg 构建。请安装 FFmpeg 并加入系统 PATH，或把 DRAWAI_FFMPEG_PATH 设为 ffmpeg 可执行文件的路径；也可以把 DRAWAI_FFMPEG_DIR 指向已有的缓存目录。${suffix}`, 'FFMPEG_UNSUPPORTED')
    setState({ status: 'unsupported', path: null, source: null, error: error.message })
    throw error
  }
  if (!allowDownload) {
    const suffix = rejected.length ? ` 已找到但不能用的 FFmpeg：${rejected.join('；')}。` : ''
    const error = ffmpegError(`没有找到可用的 FFmpeg，而且当前操作不允许自动下载。请安装 FFmpeg 并加入 PATH，或把 DRAWAI_FFMPEG_PATH 设为可执行文件路径。${suffix}`, 'FFMPEG_MISSING')
    setState({ status: 'missing', path: null, error: error.message })
    throw error
  }

  let binary
  try {
    binary = await install(entry, { platform, arch, cacheDir, signal, onProgress, probe, readFeatures, smoke })
  } catch (error) {
    if (rejected.length && !isAbort(error)) {
      error.message += ` 另外，PATH 或开发目录中的 FFmpeg 也不可用：${rejected.join('；')}。`
    }
    throw error
  }
  return ready(binary, 'download', entry.version)
}

/** 取出 `8.1.3` / `7.1-essentials_build` 这类版本号的主次版本；`N-92722-…` 取不到就返回 null。 */
function numericVersion(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version || ''))
  return match ? [Number(match[1]), Number(match[2])] : null
}

/** 探测 + 读取能力清单，判断一个 FFmpeg 是否覆盖项目需要。 */
async function inspectBinary(binary, { probe, readFeatures, smoke = smokeFfmpeg, signal }) {
  const info = await probe(binary, { signal })
  if (!info.ok) return { ok: false, reason: info.reason || '无法运行', version: null, features: null, missing: [] }
  const version = numericVersion(info.version)
  if (version && (version[0] < FFMPEG_MIN_VERSION[0] || (version[0] === FFMPEG_MIN_VERSION[0] && version[1] < FFMPEG_MIN_VERSION[1]))) {
    return {
      ok: false,
      reason: `版本过旧（${info.version}），需要 FFmpeg ${FFMPEG_MIN_VERSION_TEXT} 或更新版本`,
      version: info.version,
      features: null,
      missing: [],
    }
  }
  let features
  try {
    features = await readFeatures(binary, { signal })
  } catch (error) {
    if (isAbort(error)) throw error
    return { ok: false, reason: `读取功能清单失败：${error.message}`, version: info.version, features: null, missing: [] }
  }
  const missing = missingFeatures(features)
  if (missing.length) {
    return { ok: false, reason: `缺少项目需要的组件：${missing.join('、')}`, version: info.version, features, missing }
  }
  const check = await smoke(binary, { signal })
  if (!check.ok) {
    return { ok: false, reason: `实际编码自检失败：${check.reason}`, version: info.version, features, missing: [] }
  }
  return { ok: true, reason: '', version: info.version, features, missing: [] }
}

function ready(path, source, version) {
  setState({ status: 'ready', path, source, version: version || null, error: null })
  return path
}

function setState(patch) {
  state = { ...state, ...patch }
}

function explicitBinaryPath() {
  const configured = (process.env.DRAWAI_FFMPEG_PATH || '').trim()
  return configured ? resolve(configured) : null
}

function findOnPathSync(platform = process.platform) {
  return findOnPath(platform)[0] || null
}

/** PATH 里所有名为 ffmpeg 的候选；逐个验证功能，不能只看第一个。 */
function findOnPath(platform = process.platform) {
  const names = platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  const found = []
  const seen = new Set()
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (seen.has(candidate)) continue
      seen.add(candidate)
      try {
        accessSync(candidate, fsConstants.F_OK)
        found.push(candidate)
      } catch {
        // 继续看下一个目录
      }
    }
  }
  return found
}

/** 开发 checkout 里自带的二进制：打包后的插件不会有这个目录。 */
function developmentBinaryPath(platform = process.platform) {
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidate = fileURLToPath(new URL(`../_local/bin/${name}`, import.meta.url))
  return existsSync(candidate) ? candidate : null
}

function cachedBinarySync(platform = process.platform, arch = process.arch) {
  const binary = join(ffmpegCacheDirectory(), `${platform}-${arch}`, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return existsSync(binary) ? binary : null
}

async function inspectCache(target, { platform, arch, entry, probe, readFeatures, smoke, signal }) {
  const readyPath = join(target, READY_FILE)
  if (!existsSync(readyPath)) return null
  let readyFile
  try {
    readyFile = JSON.parse(readFileSync(readyPath, 'utf8'))
  } catch {
    return null
  }
  if (readyFile?.schema !== READY_SCHEMA) return null
  if (readyFile.platform && readyFile.platform !== platform) return null
  if (readyFile.arch && readyFile.arch !== arch) return null
  // 缓存必须对应注册表里固定的版本；版本变了就重新下载，而不是默默沿用旧版。
  if (entry && readyFile.version !== entry.version) return null
  const binary = join(target, readyFile.binary || (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  if (!existsSync(binary)) return null
  if (readyFile.sha256) {
    const digest = await sha256File(binary)
    if (digest !== readyFile.sha256) return null
  }
  const inspection = await inspectBinary(binary, { probe, readFeatures, smoke, signal })
  if (!inspection.ok) return null
  return { path: binary, ready: { ...readyFile, version: readyFile.version || inspection.version }, inspection }
}

async function install(entry, { platform, arch, cacheDir, signal, onProgress, probe, readFeatures, smoke }) {
  mkdirSync(cacheDir, { recursive: true })
  const target = join(cacheDir, `${platform}-${arch}`)
  const binaryName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const release = await acquireLock(join(cacheDir, `.lock-${platform}-${arch}`), { signal, onProgress })
  try {
    throwIfAborted(signal)
    // 等锁期间可能已经被另一个进程装好了。
    const existing = await inspectCache(target, { platform, arch, entry, probe, readFeatures, smoke, signal })
    if (existing) {
      emit(onProgress, { phase: 'ready', message: 'FFmpeg 已经准备好' })
      return existing.path
    }

    const staging = mkdtempSync(join(cacheDir, `.staging-${platform}-${arch}-`))
    try {
      const extension = entry.archive === 'tar.xz' ? '.tar.xz' : '.zip'
      const archivePath = join(staging, `download${extension}`)
      const download = await downloadArchive(entry, archivePath, { signal, onProgress })

      emit(onProgress, { phase: 'verify', message: '正在校验下载的 FFmpeg…' })
      if (entry.sha256 && download.sha256 !== entry.sha256) {
        throw ffmpegError(`FFmpeg 下载校验失败：期望 SHA-256 ${entry.sha256}，实际 ${download.sha256}。已清理临时文件；请重试，若持续出现请检查网络或代理。`, 'FFMPEG_CHECKSUM')
      }
      if (entry.size && download.bytes !== entry.size) {
        throw ffmpegError(`FFmpeg 下载不完整：期望 ${entry.size} 字节，实际 ${download.bytes} 字节。已清理临时文件，请重试。`, 'FFMPEG_CHECKSUM')
      }

      emit(onProgress, { phase: 'extract', message: '正在解压 FFmpeg…' })
      const packageDir = join(staging, 'package')
      mkdirSync(packageDir, { recursive: true })
      const binaryPath = join(packageDir, binaryName)
      if (entry.archive === 'tar.xz') {
        const extracted = join(staging, 'extracted')
        mkdirSync(extracted, { recursive: true })
        await extractTarXz(archivePath, extracted, { signal })
        const found = await findBinary(extracted, binaryName)
        if (!found) throw new Error(`解压后的压缩包里没有 ${binaryName}`)
        copyFileSync(found, binaryPath)
        rmSync(extracted, { recursive: true, force: true })
      } else {
        extractZipBinary(archivePath, binaryPath, binaryName)
      }
      chmodSync(binaryPath, 0o755)
      const binarySha256 = await sha256File(binaryPath)
      if (entry.binarySha256 && binarySha256 !== entry.binarySha256) {
        throw ffmpegError(`FFmpeg 校验失败：期望 SHA-256 ${entry.binarySha256}，实际 ${binarySha256}。已清理临时文件；请重试，若持续出现请检查下载源是否更新。`, 'FFMPEG_CHECKSUM')
      }

      emit(onProgress, { phase: 'check', message: '正在检查 FFmpeg 是否包含所需功能…' })
      const inspection = await inspectBinary(binaryPath, { probe, readFeatures, smoke, signal })
      if (!inspection.ok) {
        const detail = inspection.missing.length
          ? `缺少项目需要的组件：${inspection.missing.join('、')}`
          : inspection.reason || '无法运行'
        throw ffmpegError(`下载的 FFmpeg 不可用：${detail}。已清理临时文件，请重试；若仍然出现，请设置 DRAWAI_FFMPEG_PATH 指向完整的 FFmpeg ${FFMPEG_MIN_VERSION_TEXT}+ 构建。`, 'FFMPEG_INCOMPLETE')
      }

      writeFileSync(join(packageDir, READY_FILE), JSON.stringify({
        schema: READY_SCHEMA,
        platform,
        arch,
        version: entry.version,
        binary: binaryName,
        binarySize: statSync(binaryPath).size,
        sha256: binarySha256,
        source: {
          url: entry.url,
          sha256: entry.sha256 || null,
          license: entry.license,
          credit: entry.credit,
          homepage: entry.homepage,
        },
        features: Object.fromEntries(Object.entries(inspection.features).map(([key, names]) => [key, [...names].filter((name) => REQUIRED_FEATURES[key]?.includes(name))])),
        installedAt: new Date().toISOString(),
      }, null, 2))

      await replaceDirectory(packageDir, target)
      emit(onProgress, { phase: 'ready', message: `FFmpeg ${entry.version} 已准备好（仅首次需要下载）` })
      return join(target, binaryName)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  } finally {
    release()
  }
}

/**
 * 把 staging/package 放进缓存目录。
 * Windows 上刚执行过的 ffmpeg.exe 可能还被 Defender/索引器短暂持有，rename 会报 EPERM；
 * 这里重试几次，仍不行就退回「复制 + 删 staging」，复制完成前不删源，避免半成品进入缓存。
 */
async function replaceDirectory(source, target) {
  rmSync(target, { recursive: true, force: true })
  let lastError = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  try {
    cpSync(source, target, { recursive: true })
    rmSync(source, { recursive: true, force: true })
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw lastError || error
  }
}

async function downloadArchive(entry, destination, { signal, onProgress }) {
  const url = downloadUrl(entry)
  emit(onProgress, {
    phase: 'download',
    message: `正在下载 FFmpeg ${entry.version}${entry.size ? `（约 ${formatBytes(entry.size)}，仅首次）` : '（仅首次）'}…`,
    received: 0,
    total: entry.size || 0,
  })
  const controller = new AbortController()
  let idleTimedOut = false
  let idleTimer = null
  let received = 0
  let total = entry.size || 0
  let lastEmit = 0
  let response = null
  const hash = createHash('sha256')
  const resetIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      controller.abort()
    }, DOWNLOAD_IDLE_MS)
  }
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) throw abortedError()
    signal.addEventListener('abort', onAbort, { once: true })
  }
  resetIdle()
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'drawai-ffmpeg/1' },
    })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
    total = Number(response.headers.get('content-length')) || total
    if (total > MAX_DOWNLOAD_BYTES) throw new Error(`下载文件超过 ${formatBytes(MAX_DOWNLOAD_BYTES)}`)
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > MAX_DOWNLOAD_BYTES) {
          callback(new Error(`下载文件超过 ${formatBytes(MAX_DOWNLOAD_BYTES)}`))
          return
        }
        hash.update(chunk)
        resetIdle()
        const now = Date.now()
        if (now - lastEmit > 250) {
          lastEmit = now
          emit(onProgress, {
            phase: 'download',
            message: `正在下载 FFmpeg ${entry.version}（${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}）…`,
            received,
            total,
          })
        }
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx' }))
    emit(onProgress, {
      phase: 'download',
      message: `FFmpeg ${entry.version} 下载完成（${formatBytes(received)}）`,
      received,
      total,
    })
    return { bytes: received, sha256: hash.digest('hex') }
  } catch (error) {
    await response?.body?.cancel?.().catch(() => {})
    if (idleTimedOut) {
      throw ffmpegError(`下载 FFmpeg 超时（${Math.round(DOWNLOAD_IDLE_MS / 1000)} 秒没有收到数据）。已清理临时文件，请检查网络后重试当前操作。${proxyHint()}`, 'FFMPEG_DOWNLOAD', { cause: error })
    }
    if (signal?.aborted || error?.name === 'AbortError') throw abortedError()
    throw ffmpegError(`下载 FFmpeg 失败：${describeError(error)}（${url}）。已清理临时文件，联网后重试当前操作即可。${proxyHint()}`, 'FFMPEG_DOWNLOAD', { cause: error })
  } finally {
    clearTimeout(idleTimer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 下载地址。可用 DRAWAI_FFMPEG_MIRROR 指向镜像前缀（例如公司内网镜像）：
 * 实际地址为 `<mirror>/<原文件名>`。镜像只改下载位置，哈希/大小仍然按注册表校验。
 */
function downloadUrl(entry) {
  const mirror = (process.env.DRAWAI_FFMPEG_MIRROR || '').trim()
  if (!mirror) return entry.url
  const name = basename(new URL(entry.url).pathname)
  if (!mirror.endsWith('/')) return `${mirror}/${name}`
  return `${mirror}${name}`
}

/** Node 的 fetch 不会自动使用 HTTP(S)_PROXY；检测到代理时给出可操作的替代方案。 */
function proxyHint() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
  if (!proxy) return ''
  return ` 检测到代理 ${proxy}，但程序内置下载不会自动使用它；可设置 DRAWAI_FFMPEG_MIRROR 指向可直连的镜像，或手动安装后把 DRAWAI_FFMPEG_PATH 设为 ffmpeg 可执行文件路径。`
}

async function extractTarXz(archive, directory, { signal }) {
  const { code } = await runLogged('tar', ['-xf', archive, '-C', directory], { signal, timeoutMs: 5 * 60 * 1000 })
  if (code !== 0) throw new Error(`解压 FFmpeg 失败（tar 退出码 ${code}）`)
}

async function findBinary(root, binaryName, maxDepth = 4) {
  const queue = [[root, 0]]
  const candidates = []
  while (queue.length) {
    const [directory, depth] = queue.shift()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push([full, depth + 1])
      } else if (entry.name === binaryName) {
        candidates.push(full)
      }
    }
  }
  return candidates.find((candidate) => candidate.split(/[\\/]/).includes('bin')) || candidates[0] || null
}

function extractZipBinary(archive, destination, binaryName) {
  const size = statSync(archive).size
  const fd = openSync(archive, 'r')
  try {
    const tailLength = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLength)
    readSync(fd, tail, 0, tailLength, size - tailLength)
    let eocd = -1
    for (let index = tailLength - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index
        break
      }
    }
    if (eocd < 0) throw new Error('压缩包结构无效（找不到中央目录）')
    const count = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 压缩包')
    const directory = Buffer.alloc(directorySize)
    readSync(fd, directory, 0, directorySize, directoryOffset)

    let pointer = 0
    let best = null
    for (let index = 0; index < count; index += 1) {
      if (pointer + 46 > directory.length || directory.readUInt32LE(pointer) !== 0x02014b50) break
      const flags = directory.readUInt16LE(pointer + 8)
      const method = directory.readUInt16LE(pointer + 10)
      const checksum = directory.readUInt32LE(pointer + 16)
      const compressedSize = directory.readUInt32LE(pointer + 20)
      const uncompressedSize = directory.readUInt32LE(pointer + 24)
      const nameLength = directory.readUInt16LE(pointer + 28)
      const extraLength = directory.readUInt16LE(pointer + 30)
      const commentLength = directory.readUInt16LE(pointer + 32)
      const localOffset = directory.readUInt32LE(pointer + 42)
      const name = directory.toString('utf8', pointer + 46, pointer + 46 + nameLength)
      pointer += 46 + nameLength + extraLength + commentLength
      const normalized = name.replace(/\\/g, '/')
      if (basename(normalized) !== binaryName) continue
      const candidate = { name: normalized, flags, method, checksum, compressedSize, uncompressedSize, localOffset }
      if (!best || (normalized.includes('/bin/') && !best.name.includes('/bin/'))) best = candidate
    }
    if (!best) throw new Error(`压缩包里没有 ${binaryName}`)
    if (best.flags & 0x1) throw new Error('压缩包已加密，无法解压')
    if (best.compressedSize > 200 * 1024 * 1024) throw new Error('压缩包里的 FFmpeg 文件过大')

    const header = Buffer.alloc(30)
    readSync(fd, header, 0, 30, best.localOffset)
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('压缩包条目损坏')
    const dataOffset = best.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const compressed = Buffer.alloc(best.compressedSize)
    readSync(fd, compressed, 0, compressed.length, dataOffset)
    let data
    if (best.method === 0) data = compressed
    else if (best.method === 8) data = inflateRawSync(compressed)
    else throw new Error('压缩包使用了不支持的压缩方式')
    if (data.length !== best.uncompressedSize) throw new Error('解压后的大小不符')
    if (crc32(data) !== (best.checksum >>> 0)) throw new Error('解压校验失败（CRC 不匹配）')
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, data)
  } finally {
    closeSync(fd)
  }
}

async function acquireLock(lockPath, { signal, onProgress }) {
  const startedAt = Date.now()
  while (true) {
    throwIfAborted(signal)
    try {
      mkdirSync(lockPath)
      return () => rmSync(lockPath, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true })
        continue
      }
    } catch {
      continue
    }
    if (Date.now() - startedAt > LOCK_WAIT_MS) {
      throw ffmpegError('另一个 DrawAI 任务正在准备 FFmpeg，等待超时。请稍后重试当前操作。', 'FFMPEG_BUSY')
    }
    emit(onProgress, { phase: 'waiting', message: '另一个任务正在准备 FFmpeg，等待中…' })
    await delay(500, signal)
  }
}

/** 运行一个子进程，把 stdout/stderr 写进临时文件（受限环境里管道会 EPERM）。 */
function runLogged(command, args, { signal, timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const logPath = join(tmpdir(), `drawai-${randomUUID()}.log`)
    const fd = openSync(logPath, 'w')
    let child = null
    let settled = false
    let timer = null
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        closeSync(fd)
      } catch {
        // 已经关掉了
      }
    }
    const settle = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      let text = ''
      try {
        text = readFileSync(logPath, 'utf8')
      } catch {
        // 日志读不到就用空字符串
      }
      try {
        rmSync(logPath, { force: true })
      } catch {
        // Windows 上偶尔还会被占用，留给系统临时目录清理
      }
      if (error) reject(error)
      else resolvePromise({ code: value.code, text })
    }
    const failSpawn = (error) => settle(error.code === 'ENOENT' ? new Error(`系统里没有 ${command} 命令`) : error)
    const onAbort = () => {
      child?.kill('SIGKILL')
      settle(abortedError())
    }
    timer = setTimeout(() => {
      child?.kill('SIGKILL')
      settle(ffmpegError(`${basename(command)} 执行超时`, 'FFMPEG_TIMEOUT'))
    }, timeoutMs)
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', fd, fd] })
    } catch (error) {
      failSpawn(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', failSpawn)
    child.on('close', (code) => settle(null, { code }))
  })
}

/**
 * 探测一个可执行文件是不是 FFmpeg：`-hide_banner -version` 必须成功并打印版本号。
 * 返回 { ok, version?, reason? }，不抛异常（取消除外）。
 */
export async function probeFfmpeg(binary, { signal, timeoutMs = 20_000 } = {}) {
  if (!binary) return { ok: false, reason: '没有提供可执行文件路径' }
  try {
    accessSync(binary, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.F_OK | fsConstants.X_OK)
  } catch (error) {
    return { ok: false, reason: error.code === 'EACCES' ? '文件不可执行' : '文件不存在' }
  }
  try {
    const { code, text } = await runLogged(binary, ['-hide_banner', '-version'], { signal, timeoutMs })
    if (code !== 0) return { ok: false, reason: `运行失败（退出码 ${code}）` }
    const match = /ffmpeg version\s+(\S+)/i.exec(text)
    if (!match) return { ok: false, reason: '不是可用的 FFmpeg 可执行文件' }
    return { ok: true, version: match[1].replace(/^v/i, '') }
  } catch (error) {
    if (isAbort(error)) throw error
    return { ok: false, reason: error.message }
  }
}

/**
 * 实际跑一次极短的编码，验证 `-fps_mode` 这类选项真的被这个构建接受。
 * 功能清单只能证明编码器/滤镜存在，不能证明命令行选项存在（FFmpeg 4.x 能通过清单，
 * 但在 `-fps_mode` 上直接报 Unrecognized option）。
 */
export async function smokeFfmpeg(binary, { signal } = {}) {
  try {
    const { code, text } = await runLogged(binary, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=0.1',
      '-frames:v', '2', '-fps_mode', 'passthrough',
      '-c:v', 'libx264', '-f', 'null', '-',
    ], { signal, timeoutMs: 60_000 })
    if (code === 0) return { ok: true }
    const unsupported = /Unrecognized option '([^']+)'/.exec(text)
    if (unsupported) return { ok: false, reason: `不支持选项 ${unsupported[1]}（需要 FFmpeg 5.1 或更新版本）` }
    const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1) || `退出码 ${code}`
    return { ok: false, reason: line }
  } catch (error) {
    if (isAbort(error)) throw error
    return { ok: false, reason: error.message }
  }
}

/** 读取编码器/解码器/滤镜/封装器/解封装器清单，用来确认构建覆盖项目需要的能力。 */
export async function readFfmpegFeatures(binary, { signal } = {}) {
  const features = {}
  for (const [key, args] of Object.entries(FEATURE_LISTS)) {
    const { code, text } = await runLogged(binary, ['-hide_banner', ...args], { signal, timeoutMs: 30_000 })
    if (code !== 0) throw new Error(`读取 FFmpeg ${FEATURE_LABELS[key]}清单失败（退出码 ${code}）`)
    features[key] = parseListing(text)
  }
  return features
}

function parseListing(text) {
  const names = new Set()
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 2) continue
    // 列表首列是能力标记（V/A/S/D/T/.）；demuxer 的输入设备还会多一个 `d` 列。
    let name = tokens[1]
    if (name === 'd' && tokens.length >= 3) name = tokens[2]
    if (!name || name.includes('=') || !/^[A-Za-z0-9_.,-]+$/.test(name)) continue
    // demuxers 会把 mov,mp4,m4a 写成同一行，拆开才能按名字查。
    for (const item of name.split(',')) if (item) names.add(item)
  }
  return names
}

function missingFeatures(features) {
  const missing = []
  for (const key of Object.keys(REQUIRED_FEATURES)) {
    for (const name of REQUIRED_FEATURES[key]) {
      if (!features[key]?.has(name)) missing.push(`${FEATURE_LABELS[key]} ${name}`)
    }
  }
  return missing
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const CRC32_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/** 纯 JS 的 CRC32（IEEE），供 Node 20 等没有 zlib.crc32 的运行时使用。 */
export function crc32Fallback(buffer) {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC32_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** 优先用 zlib 的原生实现；没有时退回纯 JS，保证 Node 20 也能解压 ZIP。 */
export function crc32(buffer) {
  return typeof zlib.crc32 === 'function' ? zlib.crc32(buffer) >>> 0 : crc32Fallback(buffer)
}

function formatBytes(bytes) {
  if (!bytes) return '未知大小'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function describeError(error) {
  const code = error?.cause?.code || error?.code || ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析下载地址（域名解析失败）'
  if (code === 'ECONNREFUSED') return '连接被拒绝'
  if (code === 'ECONNRESET') return '连接被重置'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
  if (code.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'HTTPS 证书校验失败'
  if (error?.name === 'TypeError' && /fetch failed/i.test(error.message)) return '网络请求失败'
  return error?.message || String(error)
}

function emit(onProgress, event) {
  if (typeof onProgress !== 'function') return
  try {
    onProgress(event)
  } catch {
    // 进度回调不能影响安装本身
  }
}

function delay(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError()
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'FFMPEG_CANCELLED'
}

function abortedError() {
  const error = new Error('已取消准备 FFmpeg')
  error.name = 'AbortError'
  error.code = 'FFMPEG_CANCELLED'
  return error
}

function ffmpegError(message, code, options) {
  const error = new Error(message, options)
  error.code = code
  return error
}
