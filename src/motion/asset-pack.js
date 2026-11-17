/**
 * 动效素材包（字体 + 素材库）的定位与按需下载。
 *
 * 背景：素材约 200MB，塞进 npm tarball 会让包变成 147MB（0.4.0 实测），既不合适
 * 也不好发。改成发到 GitHub Release，插件首次用到时下载一次、逐文件校验、落到
 * 用户目录（`~/.dsh/drawai-assets/<version>/`），之后离线可用。
 *
 * 解析顺序（第一个命中的赢）：
 *   1. 环境变量 DRAWAI_ASSETS_DIR —— 测试与自定义安装位置
 *   2. 与代码同级（`lib/motion/` 或 `src/motion/`）—— 开发目录 / 源码安装
 *   3. 用户缓存目录 —— 下载下来的那一份
 *
 * 注意别和 `./assets.js` 搞混：那个管的是**工程里的**素材清单（capture/probe）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { ASSETS_LOCK } from './asset-pack-lock.js'
import { DEMO_ASSETS_LOCK } from './demo-assets-lock.js'
import { STYLE_FRAMES_LOCK } from './style-frames-lock.js'
import { styleReferenceParent, styleReferenceRoot } from './style-reference-store.js'

export const ASSETS_VERSION = ASSETS_LOCK.version
export const ASSETS_FILE = ASSETS_LOCK.file
export const ASSETS_REPO = 'fourzkw/dsh-drawai'
export const ASSETS_TAG = `assets-${ASSETS_VERSION}`
/** 默认走 GitHub Release；企业内网 / 镜像可用 DRAWAI_ASSETS_URL 指到自己的地址。 */
export const ASSETS_URL = process.env.DRAWAI_ASSETS_URL || `https://github.com/${ASSETS_REPO}/releases/download/${ASSETS_TAG}/${ASSETS_FILE}`
export const ASSETS_PAGE = `https://github.com/${ASSETS_REPO}/releases/tag/${ASSETS_TAG}`

/**
 * 上游 demo 用的数据文件（现在只有 22-hud 的 land-50m.json）单独一个小包：
 * 530KB，跟 200MB 的字体/素材库包分开，谁用到谁下载。
 */
export const DEMO_ASSETS_VERSION = DEMO_ASSETS_LOCK.version
export const DEMO_ASSETS_FILE = DEMO_ASSETS_LOCK.file
export const DEMO_ASSETS_TAG = `demo-assets-${DEMO_ASSETS_VERSION}`
export const DEMO_ASSETS_URL = process.env.DRAWAI_DEMO_ASSETS_URL || `https://github.com/${ASSETS_REPO}/releases/download/${DEMO_ASSETS_TAG}/${DEMO_ASSETS_FILE}`
export const DEMO_ASSETS_PAGE = `https://github.com/${ASSETS_REPO}/releases/tag/${DEMO_ASSETS_TAG}`

/**
 * 整片风格参考帧（约 40MB / 149 文件）单独一个小包：参考帧是可选素材，不该让不用它的
 * 人陪 145MB 的字体/素材库包一起下。安装位置是**集合目录本身**
 * （`~/.dsh/drawai-style-reference-frames/collection-<版本>/`），不是它上一级 ——
 * installPack 会先 rmSync 再改名，装到父目录会连用户自己放的其他集合一起删掉。
 */
export const STYLE_FRAMES_VERSION = STYLE_FRAMES_LOCK.version
export const STYLE_FRAMES_FILE = STYLE_FRAMES_LOCK.file
export const STYLE_FRAMES_COLLECTION = STYLE_FRAMES_LOCK.collection
export const STYLE_FRAMES_TAG = `style-frames-${STYLE_FRAMES_VERSION}`
/** 走 GitHub Release；镜像 / 内网可用 DRAWAI_STYLE_FRAMES_URL 指到自己的地址。 */
export const STYLE_FRAMES_URL = process.env.DRAWAI_STYLE_FRAMES_URL
  || `https://github.com/${ASSETS_REPO}/releases/download/${STYLE_FRAMES_TAG}/${STYLE_FRAMES_FILE}`
export const STYLE_FRAMES_PAGE = `https://github.com/${ASSETS_REPO}/releases/tag/${STYLE_FRAMES_TAG}`

const SENTINELS = ['fonts/font-faces.json', 'media-library']
const READY_FILE = '.ready.json'

/** 素材缺失 / 下载失败时抛这个：带够用户能自己动手排查的信息。 */
export class AssetPackError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'AssetPackError'
    this.code = detail.code || 'assets-unavailable'
    this.url = detail.url || ASSETS_URL
    this.dir = detail.dir || cacheDir()
    this.cause = detail.cause
  }
}

export function cacheDir() {
  const custom = process.env.DRAWAI_ASSETS_DIR
  if (custom) return custom
  return join(homedir(), '.dsh', 'drawai-assets', ASSETS_VERSION)
}

function isReady(dir) {
  if (!dir) return false
  try {
    return SENTINELS.every((rel) => existsSync(join(dir, rel)))
  } catch {
    return false
  }
}

export function bundledDir() {
  try {
    return fileURLToPath(new URL('./', import.meta.url))
  } catch {
    return null
  }
}

/** 已经能用的素材根目录；没有就返回 null。同步、很便宜。 */
export function assetsRoot() {
  const bundled = bundledDir()
  if (isReady(bundled)) return bundled
  const cache = cacheDir()
  if (isReady(cache)) return cache
  return null
}

/** 给状态展示用：不下载、只报告。 */
export function assetsState() {
  const bundled = bundledDir()
  if (isReady(bundled)) return { ready: true, source: 'bundled', root: bundled, dir: cacheDir(), version: ASSETS_VERSION }
  const cache = cacheDir()
  if (isReady(cache)) return { ready: true, source: 'cache', root: cache, dir: cache, version: ASSETS_VERSION }
  return { ready: false, source: null, root: null, dir: cache, version: ASSETS_VERSION, url: ASSETS_URL }
}

/** demo 数据包没有「随包一份」的形态，永远只落在用户缓存目录。 */
export function demoCacheDir() {
  const custom = process.env.DRAWAI_DEMO_ASSETS_DIR
  if (custom) return custom
  return join(homedir(), '.dsh', 'drawai-assets', 'demo-' + DEMO_ASSETS_VERSION)
}

/** 已经落地的 demo 数据根目录；没有就返回 null。同步、很便宜。 */
export function demoAssetsRoot() {
  const dir = demoCacheDir()
  return existsSync(join(dir, READY_FILE)) ? dir : null
}

/** 素材根目录下的某个文件（带越界校验）；没有就返回 null。 */
export function demoAssetsFile(relativePath) {
  const root = demoAssetsRoot()
  if (!root) return null
  const base = resolve(root)
  const file = resolve(join(base, relativePath))
  if (file !== base && !file.startsWith(base + sep)) return null
  return existsSync(file) ? file : null
}

function readManifest(root) {
  const file = join(root, 'manifest.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readTar(buf) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const raw = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '').trim()
    const prefix = raw(345, 155)
    const name = raw(0, 100)
    const size = parseInt(raw(124, 12) || '0', 8) || 0
    const flag = String.fromCharCode(header[156] || 48)
    const full = (prefix ? prefix + '/' + name : name).replace(/^\/+/, '')
    offset += 512
    const data = buf.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (flag === '5') continue
    if (!full) continue
    if (flag !== '0' && flag !== '\0' && flag !== '7') continue
    entries.push({ path: full, data })
  }
  return entries
}

function assertSafePath(rel) {
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new Error('素材包里有非法路径：' + rel)
  if (rel.split('/').includes('..')) throw new Error('素材包里有越级路径：' + rel)
}

/**
 * Node 22 的 fetch 不认系统/环境代理（NODE_USE_ENV_PROXY 要 24+），
 * 国内直连 github.com 基本连不上。所以设了代理就走 curl（Win10+ / macOS / 主流 Linux 都自带），
 * 由它处理 CONNECT 隧道与重定向。
 */
function proxyFromEnv() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
  return raw && raw.trim() ? raw.trim() : ''
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function downloadCurl(url, dest, onProgress, proxy) {
  return new Promise((resolve, reject) => {
    const args = [
      '-L', '--fail', '--silent', '--show-error',
      '--connect-timeout', '20', '--retry', '2', '--retry-delay', '2',
      '-o', dest,
    ]
    if (proxy) args.push('--proxy', proxy)
    args.push(url)
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { if (stderr.length < 500) stderr += chunk.toString() })
    const timer = setInterval(() => {
      try { if (onProgress) onProgress(statSync(dest).size, 0) } catch { /* 还没建文件 */ }
    }, 2000)
    child.on('error', (err) => { clearInterval(timer); reject(err) })
    child.on('close', async (code) => {
      clearInterval(timer)
      if (code !== 0) return reject(new Error('curl 退出码 ' + code + (stderr ? '：' + stderr.trim() : '')))
      try {
        const bytes = statSync(dest).size
        resolve({ bytes, sha256: await hashFile(dest) })
      } catch (err) { reject(err) }
    })
  })
}

async function downloadFetch(url, dest, onProgress) {
  if (typeof fetch !== 'function') throw new AssetPackError('当前 Node 没有 fetch（需要 18+）', { code: 'no-fetch' })
  let res
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-drawai-assets' } })
  } catch (err) {
    const wrapped = new Error(err?.message || String(err))
    wrapped.cause = err
    throw wrapped
  }
  if (!res.ok) throw new AssetPackError('下载失败：HTTP ' + res.status + '（' + url + '）', { code: 'http-' + res.status })
  const total = Number(res.headers.get('content-length') || 0)
  const hash = createHash('sha256')
  const out = createWriteStream(dest)
  let got = 0
  let lastTick = 0
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      got += chunk.length
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
      const now = Date.now()
      if (onProgress && now - lastTick > 2000) {
        lastTick = now
        onProgress(got, total)
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve))
  }
  return { bytes: got, sha256: hash.digest('hex') }
}

async function downloadTo(url, dest, onProgress) {
  const proxy = proxyFromEnv()
  try {
    return await downloadFetch(url, dest, onProgress)
  } catch (first) {
    if (!proxy) throw new AssetPackError('连不上 GitHub：' + (first?.message || first), { code: 'network', cause: first })
    try {
      return await downloadCurl(url, dest, onProgress, proxy)
    } catch (second) {
      const err = new AssetPackError('下载失败（直连与代理 ' + proxy + ' 都不通）：' + (second?.message || second), { code: 'network', cause: second })
      err.directCause = first
      throw err
    }
  }
}

/**
 * 下载并安装一个素材包。两个包（字体素材库 / demo 数据）共用这一段：
 * 落地、大小与 sha256 校验、逐文件校验、写 ready 标记，失败时清干净临时目录。
 */
async function installPack({ lock, url, dir, onProgress }) {
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
  const archive = `${tmp}.tar.gz`
  try {
    mkdirSync(dirname(dir), { recursive: true })
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const { bytes, sha256 } = await downloadTo(url, archive, onProgress)
    if (lock.bytes && bytes !== lock.bytes) {
      throw new AssetPackError(`素材包大小不对（收到 ${bytes} 字节，应为 ${lock.bytes}），可能下载被截断了`, { code: 'size-mismatch', url, dir })
    }
    if (lock.sha256 && sha256 !== lock.sha256) {
      throw new AssetPackError('素材包校验失败（sha256 不匹配），请重试；反复失败请手动下载安装', { code: 'checksum', url, dir })
    }
    const entries = readTar(gunzipSync(readFileSync(archive)))
    const manifestEntry = entries.find((item) => item.path === 'manifest.json')
    const manifest = manifestEntry ? JSON.parse(manifestEntry.data.toString('utf8')) : null
    if (!manifest || !Array.isArray(manifest.files)) throw new AssetPackError('素材包里没有 manifest.json，无法校验', { code: 'no-manifest', url, dir })
    const expected = new Map(manifest.files.map((item) => [item.path, item.sha256]))
    let written = 0
    for (const entry of entries) {
      if (entry.path === 'manifest.json') continue
      assertSafePath(entry.path)
      const want = expected.get(entry.path)
      const got = createHash('sha256').update(entry.data).digest('hex')
      if (want && want !== got) throw new AssetPackError('素材包内容损坏：' + entry.path, { code: 'bad-file', url, dir })
      const target = join(tmp, entry.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data)
      written += 1
    }
    writeFileSync(join(tmp, READY_FILE), JSON.stringify({
      version: lock.version, files: written, bytes, sha256, at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
    rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
    return { root: dir, source: 'download', downloaded: true, files: written }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    if (err instanceof AssetPackError) throw err
    throw new AssetPackError('素材包安装失败：' + (err?.message || err), { code: 'install', cause: err, url, dir })
  } finally {
    rmSync(archive, { force: true })
  }
}

let inflight = null
let demoInflight = null

/**
 * 保证素材可用。已经可用时是一次同步检查、立刻返回。
 * @param {{onProgress?: (got:number,total:number)=>void, force?: boolean}} [opts]
 */
export async function ensureAssets(opts = {}) {
  const ready = assetsRoot()
  if (ready && !opts.force) return { root: ready, source: 'existing', downloaded: false }
  if (inflight) return inflight
  inflight = installPack({ lock: ASSETS_LOCK, url: ASSETS_URL, dir: cacheDir(), onProgress: opts.onProgress })
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

/**
 * 保证 demo 数据包可用：上游 demo 第一次请求缺的数据文件时下载一次（约 530KB）。
 * 已经落地时是同步检查。
 */
export async function ensureDemoAssets(opts = {}) {
  const ready = demoAssetsRoot()
  if (ready && !opts.force) return { root: ready, source: 'existing', downloaded: false }
  if (demoInflight) return demoInflight
  demoInflight = installPack({ lock: DEMO_ASSETS_LOCK, url: DEMO_ASSETS_URL, dir: demoCacheDir(), onProgress: opts.onProgress })
  try {
    return await demoInflight
  } finally {
    demoInflight = null
  }
}

/** 工具层用：拿到素材根目录，或者抛一条人能照着做的错误。 */
export async function requireAssets({ onProgress } = {}) {
  try {
    const got = await ensureAssets({ onProgress })
    return got.root
  } catch (err) {
    const reason = err?.message || String(err)
    throw new AssetPackError(
      '动效素材包（字体 + 素材库，一次性约 ' + Math.round((ASSETS_LOCK.bytes || 0) / 1048576) + 'MB）还没准备好：' + reason + '\n'
      + '怎么处理：\n'
      + '  1) 联网后重试一次刚才的操作，插件会自动下载并校验；\n'
      + '  2) 或者手动下载 ' + ASSETS_URL + ' ，解压到 ' + cacheDir()
      + '（目录里应当直接看到 fonts/ 和 media-library/）；\n'
      + '  3) 走代理的话先设 HTTPS_PROXY 再重试。\n'
      + '在此之前，画布与图片相关功能不受影响，只有动效（字体/素材库）用不了。',
      { dir: cacheDir(), cause: err },
    )
  }
}

/** 素材包安装的父目录：DRAWAI_STYLE_FRAMES_DIR 或 ~/.dsh/drawai-style-reference-frames。 */
export function styleFramesParent() {
  return styleReferenceParent()
}

/** 素材包装出来的那个集合目录。父目录里可能还有用户自己的集合，互不影响。 */
export function styleFramesDir() {
  return join(styleFramesParent(), STYLE_FRAMES_COLLECTION)
}

function readReady(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, READY_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** 参考帧现在能不能用、用的是哪一份。同步、只读，不下载。 */
export function styleFramesState() {
  const override = process.env.DRAWAI_STYLE_REFERENCE_DIR
  const dir = override ? resolve(override) : styleFramesDir()
  let root = null
  try { root = styleReferenceRoot() } catch { root = null }
  if (root) {
    return {
      ready: true,
      source: override ? 'env' : (existsSync(join(dir, READY_FILE)) ? 'download' : 'local'),
      // 用的是哪一份就报哪一份：可能是素材包装的，也可能是用户自己放/指定的旧集合。
      root, dir, version: STYLE_FRAMES_VERSION, collection: basename(root),
    }
  }
  return {
    ready: false, source: null, root: null, dir, version: STYLE_FRAMES_VERSION,
    collection: STYLE_FRAMES_COLLECTION, url: STYLE_FRAMES_URL, page: STYLE_FRAMES_PAGE,
    ...(override ? { envOverride: true } : {}),
  }
}

let framesInflight = null

/**
 * 保证参考帧可用：没有就下载那个 40MB 的包（一次），已经有就是同步检查。
 * 环境变量指定了目录、或目标目录是用户自己放的集合时**不下载也不覆盖**。
 * @param {{onProgress?: (got:number,total:number)=>void, force?: boolean}} [opts]
 */
export async function ensureStyleFrames(opts = {}) {
  const state = styleFramesState()
  if (state.ready && !opts.force) return { root: state.root, source: 'existing', downloaded: false, version: STYLE_FRAMES_VERSION }
  if (state.envOverride) {
    throw new AssetPackError('风格参考帧目录由 DRAWAI_STYLE_REFERENCE_DIR 指定（' + state.dir + '），但它不是带 index.json 的集合；指定了目录时不会自动下载。', { code: 'style-frames-env', url: STYLE_FRAMES_URL, dir: state.dir })
  }
  const dir = styleFramesDir()
  if (existsSync(dir) && !existsSync(join(dir, READY_FILE))) {
    throw new AssetPackError('目标目录已存在，但不是素材包安装出来的集合：' + dir
      + '\n为避免删掉你自己准备的参考帧，这里不会覆盖它；先移走或改名，或用 DRAWAI_STYLE_REFERENCE_DIR 指向自己的集合。',
      { code: 'style-frames-unmanaged', url: STYLE_FRAMES_URL, dir })
  }
  if (framesInflight) return framesInflight
  framesInflight = installPack({ lock: STYLE_FRAMES_LOCK, url: STYLE_FRAMES_URL, dir, onProgress: opts.onProgress })
  try {
    return await framesInflight
  } finally {
    framesInflight = null
  }
}

/** 工具层用：拿到参考帧根目录，或者抛一条人能照着做的错误。 */
export async function requireStyleFrames({ onProgress } = {}) {
  try {
    const got = await ensureStyleFrames({ onProgress })
    return got.root
  } catch (err) {
    throw new AssetPackError(
      '风格参考帧素材包（16 种风格，一次性约 ' + Math.round((STYLE_FRAMES_LOCK.bytes || 0) / 1048576) + 'MB）还没准备好：' + (err?.message || err) + '\n'
      + '怎么处理：\n'
      + '  1) 联网后重试一次，插件会自动下载并逐文件校验；\n'
      + '  2) 或者手动下载 ' + STYLE_FRAMES_URL + ' ，解压到 ' + styleFramesDir()
      + '（目录里应当直接看到 index.json 和 01-… / 23-… 这些风格目录）；\n'
      + '  3) 走代理的话先设 HTTPS_PROXY 再重试；\n'
      + '  4) 也可以设置 DRAWAI_STYLE_REFERENCE_DIR 指向你自己准备的 collection 目录。\n'
      + '参考帧只是可选参考：没有它也能按风格施工包继续做片子。',
      { code: 'style-frames-unavailable', url: STYLE_FRAMES_URL, dir: styleFramesDir(), cause: err },
    )
  }
}

export function styleFramesSummary() {
  const state = styleFramesState()
  const ready = state.ready ? readReady(state.dir) : null
  return {
    ready: state.ready,
    version: STYLE_FRAMES_VERSION,
    collection: state.collection,
    source: state.source,
    root: state.root,
    dir: state.dir,
    files: ready?.files ?? null,
    bytes: ready?.bytes ?? null,
    url: STYLE_FRAMES_URL,
    page: STYLE_FRAMES_PAGE,
  }
}

/** 媒体素材库根目录（没有素材时返回 null，不抛）。 */
export function mediaLibraryRoot() {
  const root = assetsRoot()
  if (!root) return null
  const dir = join(root, 'media-library')
  return existsSync(dir) ? dir : null
}

/** 字体目录（没有素材时返回 null，不抛）。 */
export function fontsDir() {
  const root = assetsRoot()
  if (!root) return null
  const dir = join(root, 'fonts')
  return existsSync(dir) ? dir : null
}

export function assetsSummary() {
  const state = assetsState()
  if (!state.ready) return { ready: false, version: ASSETS_VERSION, dir: state.dir, url: ASSETS_URL, page: ASSETS_PAGE }
  const manifest = readManifest(state.root) || {}
  return {
    ready: true,
    version: ASSETS_VERSION,
    source: state.source,
    root: state.root,
    files: manifest.counts?.files ?? null,
    bytes: manifest.counts?.bytes ?? null,
    url: ASSETS_URL,
    page: ASSETS_PAGE,
  }
}
