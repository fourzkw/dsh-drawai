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
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** 按 manifest 逐文件校验 tar 条目并写进临时目录；返回写入的文件数。 */
function writeTarEntries(entries, manifest, dest, context) {
  const expected = new Map((manifest.files || []).map((item) => [item.path, item.sha256]))
  const seen = new Set()
  let written = 0
  for (const entry of entries) {
    if (entry.path === 'manifest.json') continue
    assertSafePath(entry.path)
    const want = expected.get(entry.path)
    const got = createHash('sha256').update(entry.data).digest('hex')
    if (want && want !== got) throw new AssetPackError('素材包内容损坏：' + entry.path, { code: 'bad-file', ...context })
    const target = join(dest, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    seen.add(entry.path)
    written += 1
  }
  // manifest 里列了、包里却没有的文件：这份包不完整。以前这里会静默放过，
  // 结果是「装完就绪、读帧时才炸在某个风格上」。
  for (const item of manifest.files || []) {
    if (item.path === 'manifest.json' || seen.has(item.path)) continue
    throw new AssetPackError('素材包缺少文件：' + item.path, { code: 'bad-file', ...context })
  }
  return written
}

/**
 * 把一份已经躺在磁盘上的素材包解出来装好：大小 / sha256 / manifest 逐文件校验，
 * 写 ready 标记，最后原子替换目标目录。下载路径和本地文件路径共用这一段。
 * @param {{lock:object, archive:string, bytes:number, sha256:string, dir:string, url:string, origin:'download'|'file'}} pack
 */
async function unpackPack({ lock, archive, bytes, sha256, dir, url, origin }) {
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
  const context = { url, dir }
  const local = origin === 'file'
  try {
    mkdirSync(dirname(dir), { recursive: true })
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    if (lock.bytes && bytes !== lock.bytes) {
      throw new AssetPackError(`素材包大小不对（收到 ${bytes} 字节，应为 ${lock.bytes}），`
        + (local ? '这个文件不是 ' + (lock.file || lock.version) + '，或复制时被截断了' : '可能下载被截断了'),
        { code: 'size-mismatch', ...context })
    }
    if (lock.sha256 && sha256 !== lock.sha256) {
      throw new AssetPackError(local
        ? '素材包校验失败（sha256 不匹配）：这个文件不是 ' + (lock.file || lock.version) + '，或已损坏'
        : '素材包校验失败（sha256 不匹配），请重试；反复失败请手动下载安装',
      { code: 'checksum', ...context })
    }
    const entries = readTar(gunzipSync(readFileSync(archive)))
    const manifestEntry = entries.find((item) => item.path === 'manifest.json')
    const manifest = manifestEntry ? JSON.parse(manifestEntry.data.toString('utf8')) : null
    if (!manifest || !Array.isArray(manifest.files)) throw new AssetPackError('素材包里没有 manifest.json，无法校验', { code: 'no-manifest', ...context })
    const written = writeTarEntries(entries, manifest, tmp, context)
    // 包根上的 manifest 也留下：装好的目录因此是自描述的，之后可以再从目录安装/比对。
    writeFileSync(join(tmp, 'manifest.json'), manifestEntry.data)
    writeFileSync(join(tmp, READY_FILE), JSON.stringify({
      version: lock.version, files: written, bytes, sha256, origin: origin || 'download', at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
    rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
    return { root: dir, source: origin || 'download', downloaded: !local, files: written }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    if (err instanceof AssetPackError) throw err
    throw new AssetPackError('素材包安装失败：' + (err?.message || err), { code: 'install', cause: err, ...context })
  }
}

/**
 * 下载并安装一个素材包。两个包（字体素材库 / demo 数据）共用这一段。
 */
async function installPack({ lock, url, dir, onProgress }) {
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
  const archive = `${tmp}.tar.gz`
  try {
    mkdirSync(dirname(dir), { recursive: true })
    const { bytes, sha256 } = await downloadTo(url, archive, onProgress)
    return await unpackPack({ lock, archive, bytes, sha256, dir, url, origin: 'download' })
  } catch (err) {
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
    const ready = existsSync(join(dir, READY_FILE)) ? readReady(dir) : null
    return {
      ready: true,
      // 用的是哪一份就报哪一份：素材包（下载装的 / 本地文件装的）、用户自己放的、环境变量指定的。
      source: override ? 'env' : (ready ? (ready.origin === 'file' ? 'file' : 'download') : 'local'),
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

/** 本地安装能不能动这个目录：只覆盖素材包自己装出来的那份（有 ready 标记）。 */
function assertInstallTarget(dir) {
  if (!existsSync(dir)) return
  if (existsSync(join(dir, READY_FILE))) return
  const context = { code: 'style-frames-unmanaged', url: STYLE_FRAMES_URL, dir }
  if (existsSync(join(dir, 'index.json'))) {
    throw new AssetPackError('目标位置已经是一份可用的参考帧集合：' + dir
      + '\n它没有素材包的安装标记，替换会把它删掉；要换内容先移走这个目录，'
      + '或用 DRAWAI_STYLE_FRAMES_DIR 指向另一个父目录。', context)
  }
  throw new AssetPackError('目标目录已存在，但不是素材包安装出来的集合：' + dir
    + '\n为避免删掉你自己准备的参考帧，这里不会覆盖它；先移走或改名，或用 DRAWAI_STYLE_REFERENCE_DIR 指向自己的集合。', context)
}

/** 校验一份已经解压好的集合目录：manifest + index.json + 逐文件 sha256。 */
async function verifyCollectionDir(root) {
  const context = { url: STYLE_FRAMES_URL, dir: root }
  const manifest = readManifest(root)
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new AssetPackError('这个目录里没有 manifest.json，没法逐文件校验：' + root
      + '\n可以改传 Release 里的 ' + STYLE_FRAMES_FILE + '（.tar.gz），解包和校验由插件来做。', { code: 'no-manifest', ...context })
  }
  if (!existsSync(join(root, 'index.json'))) {
    throw new AssetPackError('这个目录里没有 index.json，不像参考帧集合：' + root, { code: 'no-index', ...context })
  }
  let bytes = 0
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string') throw new AssetPackError('manifest.json 里的文件条目不完整', { code: 'bad-file', ...context })
    try {
      assertSafePath(item.path)
    } catch (err) {
      throw new AssetPackError(err.message, { code: 'bad-file', ...context })
    }
    const file = join(root, item.path)
    if (!existsSync(file)) throw new AssetPackError('素材包目录缺少文件：' + item.path, { code: 'bad-file', ...context })
    if (item.sha256) {
      const got = await hashFile(file)
      if (got !== item.sha256) throw new AssetPackError('素材包内容损坏：' + item.path, { code: 'bad-file', ...context })
    }
    bytes += statSync(file).size
  }
  return { files: manifest.files.length, bytes, manifest }
}

/** 把校验过的集合目录整份复制到目标位置，再原子换上。 */
async function copyCollectionDir(source, manifest, dir) {
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(dir), { recursive: true })
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    let bytes = 0
    for (const item of manifest.files) {
      const to = join(tmp, item.path)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(source, item.path), to)
      bytes += statSync(to).size
    }
    if (existsSync(join(source, 'manifest.json'))) copyFileSync(join(source, 'manifest.json'), join(tmp, 'manifest.json'))
    writeFileSync(join(tmp, READY_FILE), JSON.stringify({
      version: STYLE_FRAMES_VERSION, files: manifest.files.length, bytes, sha256: null, origin: 'file', at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
    rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
    return { root: dir, source: 'file', downloaded: false, files: manifest.files.length, bytes }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    if (err instanceof AssetPackError) throw err
    throw new AssetPackError('从本地目录安装失败：' + (err?.message || err), { code: 'install', cause: err, dir })
  }
}

/**
 * 从本地安装参考帧：可以把 Release 里的 .tar.gz 直接指过来，也可以指已经解压好的集合目录。
 * 给了文件就完全不联网；校验强度与下载路径一致（大小 / sha256 / manifest 逐文件）。
 */
export async function installStyleFramesFromFile(file) {
  const raw = typeof file === 'string' ? file.trim().replace(/^"(.*)"$/, '$1') : ''
  const context = { url: STYLE_FRAMES_URL, dir: styleFramesDir() }
  if (!raw) {
    throw new AssetPackError('从本地安装需要 file：' + STYLE_FRAMES_FILE + ' 的路径，或已经解压好的集合目录'
      + '\n例如 mg_style {action:"install", file:"D:/downloads/' + STYLE_FRAMES_FILE + '"}', { code: 'no-file', ...context })
  }
  const source = resolve(raw)
  if (!existsSync(source)) {
    throw new AssetPackError('找不到这个素材包：' + source
      + '\n路径按当前工作目录解析，也可以用绝对路径；' + STYLE_FRAMES_FILE + ' 从 ' + STYLE_FRAMES_PAGE + ' 下载。', { code: 'no-file', ...context })
  }
  const override = process.env.DRAWAI_STYLE_REFERENCE_DIR
  const dir = override ? resolve(override) : styleFramesDir()
  assertInstallTarget(dir)
  const info = statSync(source)
  if (info.isDirectory()) {
    const verified = await verifyCollectionDir(source)
    return { ...(await copyCollectionDir(source, verified.manifest, dir)), version: STYLE_FRAMES_VERSION }
  }
  if (!/\.(tar\.gz|tgz)$/i.test(source)) {
    throw new AssetPackError('只认 .tar.gz（Release 里的素材包就是这个格式）：' + source
      + '\n如果是 .zip 或别的压缩格式，先解压成目录，再把目录路径传进来。', { code: 'unsupported-format', ...context, dir })
  }
  const got = await unpackPack({
    lock: STYLE_FRAMES_LOCK, archive: source, bytes: info.size, sha256: await hashFile(source), dir, url: source, origin: 'file',
  })
  return { ...got, version: STYLE_FRAMES_VERSION }
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
      + '  2) 离线 / 内网：先把 ' + STYLE_FRAMES_FILE + ' 下载到本机，再跑 mg_style {action:"install", file:"<路径>"}'
      + '（.tar.gz 或已经解压好的集合目录都可以，不联网）；\n'
      + '  3) 或者手动下载 ' + STYLE_FRAMES_URL + ' ，解压到 ' + styleFramesDir()
      + '（目录里应当直接看到 index.json 和 01-… / 23-… 这些风格目录）；\n'
      + '  4) 走代理的话先设 HTTPS_PROXY 再重试；\n'
      + '  5) 也可以设置 DRAWAI_STYLE_REFERENCE_DIR 指向你自己准备的 collection 目录。\n'
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
