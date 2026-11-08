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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { ASSETS_LOCK } from './asset-pack-lock.js'

export const ASSETS_VERSION = ASSETS_LOCK.version
export const ASSETS_FILE = ASSETS_LOCK.file
export const ASSETS_REPO = 'fourzkw/dsh-drawai'
export const ASSETS_TAG = `assets-${ASSETS_VERSION}`
/** 默认走 GitHub Release；企业内网 / 镜像可用 DRAWAI_ASSETS_URL 指到自己的地址。 */
export const ASSETS_URL = process.env.DRAWAI_ASSETS_URL || `https://github.com/${ASSETS_REPO}/releases/download/${ASSETS_TAG}/${ASSETS_FILE}`
export const ASSETS_PAGE = `https://github.com/${ASSETS_REPO}/releases/tag/${ASSETS_TAG}`

const SENTINELS = ['fonts/font-faces.json', 'media-library']
const READY_FILE = '.ready.json'

/** 素材缺失 / 下载失败时抛这个：带够用户能自己动手排查的信息。 */
export class AssetPackError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'AssetPackError'
    this.code = detail.code || 'assets-unavailable'
    this.url = ASSETS_URL
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

let inflight = null

/**
 * 保证素材可用。已经可用时是一次同步检查、立刻返回。
 * @param {{onProgress?: (got:number,total:number)=>void, force?: boolean}} [opts]
 */
export async function ensureAssets(opts = {}) {
  const ready = assetsRoot()
  if (ready && !opts.force) return { root: ready, source: 'existing', downloaded: false }
  if (inflight) return inflight
  inflight = (async () => {
    const dir = cacheDir()
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
    const archive = `${tmp}.tar.gz`
    try {
      mkdirSync(dirname(dir), { recursive: true })
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(tmp, { recursive: true })
      const { bytes, sha256 } = await downloadTo(ASSETS_URL, archive, opts.onProgress)
      if (ASSETS_LOCK.bytes && bytes !== ASSETS_LOCK.bytes) {
        throw new AssetPackError(`素材包大小不对（收到 ${bytes} 字节，应为 ${ASSETS_LOCK.bytes}），可能下载被截断了`, { code: 'size-mismatch' })
      }
      if (ASSETS_LOCK.sha256 && sha256 !== ASSETS_LOCK.sha256) {
        throw new AssetPackError('素材包校验失败（sha256 不匹配），请重试；反复失败请手动下载安装', { code: 'checksum' })
      }
      const entries = readTar(gunzipSync(readFileSync(archive)))
      const manifestEntry = entries.find((item) => item.path === 'manifest.json')
      const manifest = manifestEntry ? JSON.parse(manifestEntry.data.toString('utf8')) : null
      if (!manifest || !Array.isArray(manifest.files)) throw new AssetPackError('素材包里没有 manifest.json，无法校验', { code: 'no-manifest' })
      const expected = new Map(manifest.files.map((item) => [item.path, item.sha256]))
      let written = 0
      for (const entry of entries) {
        if (entry.path === 'manifest.json') continue
        assertSafePath(entry.path)
        const want = expected.get(entry.path)
        const got = createHash('sha256').update(entry.data).digest('hex')
        if (want && want !== got) throw new AssetPackError('素材包内容损坏：' + entry.path, { code: 'bad-file' })
        const target = join(tmp, entry.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, entry.data)
        written += 1
      }
      writeFileSync(join(tmp, READY_FILE), JSON.stringify({
        version: ASSETS_VERSION, files: written, bytes, sha256, at: new Date().toISOString(),
      }, null, 2) + '\n', 'utf8')
      rmSync(dir, { recursive: true, force: true })
      renameSync(tmp, dir)
      return { root: dir, source: 'download', downloaded: true, files: written }
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true })
      if (err instanceof AssetPackError) throw err
      throw new AssetPackError('素材包安装失败：' + (err?.message || err), { code: 'install', cause: err })
    } finally {
      rmSync(archive, { force: true })
      inflight = null
    }
  })()
  return inflight
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
