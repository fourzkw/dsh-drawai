// 素材捕获：把真实文件搬进工程，并量出场景需要的元数据（尺寸、色板、摘要）。
//
// 为什么不是"画布快照"：快照经过一次光栅化，颜色和像素都被画布缩放改过。
// 场景要对齐品牌色、要对齐文案排版，就必须拿到原始字节。
//
// 落地形态：<工程>/assets/<名字>.<ext> + <工程>/assets/manifest.json。
// 目录同时是 Remotion 的 publicDir，场景里用 staticFile('xxx.png') 取。

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { open as openFile } from 'node:fs/promises'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ensureFfmpeg } from '../ffmpeg-manager.js'
import { parseProjectJson } from './json.js'

const exec = promisify(execFile)
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])
// 矢量素材（官方 logo / 图标）单独一类：不经 ffprobe 量尺寸，场景里 <Img> 照样能画，
// 而且缩放到 4K 也不糊——品牌资产优先要这个，而不是截一张 PNG。
const VECTOR_EXT = new Set(['.svg'])
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv'])
const MAX_BYTES = 24 * 1024 * 1024
const MAX_VIDEO_BYTES = 256 * 1024 * 1024
export const MEDIA_EXT = new Set([...IMAGE_EXT, ...AUDIO_EXT, ...VIDEO_EXT, ...VECTOR_EXT])

async function run(args, options = {}) {
  const binary = await ensureFfmpeg({ signal: options.signal })
  return exec(binary, args, { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options })
}

export function assetsDirectory(projectDir) {
  return join(projectDir, 'assets')
}

export function readAssets(projectDir) {
  const file = join(assetsDirectory(projectDir), 'manifest.json')
  if (!existsSync(file)) return { version: 1, items: [] }
  try {
    const raw = parseProjectJson(readFileSync(file, 'utf8'))
    return { version: 1, items: Array.isArray(raw.items) ? raw.items : [] }
  } catch {
    return { version: 1, items: [] }
  }
}

export function writeAssets(projectDir, manifest) {
  const dir = assetsDirectory(projectDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, items: manifest.items }, null, 2))
}

// 素材一变，bundle 就必须重建——所以指纹要参与 bundleKey。
export function assetsHash(projectDir) {
  const { items } = readAssets(projectDir)
  const hash = createHash('sha256')
  for (const item of items) hash.update(JSON.stringify([item.id, item.file, item.sha256, item.width, item.height]))
  // motion_sfx / motion_audio 落进 assets/sfx 的文件不写 manifest.json，但一样是 public 资源。
  // 只认 manifest 会让 bundle 复用旧 public（缺 sfx/），渲染时 404 —— 所以目录本身也要进指纹。
  const dir = assetsDirectory(projectDir)
  if (existsSync(dir)) {
    const walk = (rel) => {
      for (const entry of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const next = rel ? join(rel, entry.name) : entry.name
        if (entry.isDirectory()) walk(next)
        else {
          if (!entry.isFile()) throw new Error('素材目录不支持符号链接：' + next)
          const file = join(dir, next), stat = statSync(file)
          hash.update(JSON.stringify([next.replace(/\\/g, '/'), stat.size]))
          const fd = openSync(file, 'r'), buffer = Buffer.allocUnsafe(256 * 1024)
          try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)) } finally { closeSync(fd) }
        }
      }
    }
    walk('')
  }
  return hash.digest('hex').slice(0, 16)
}

export function listAssets(projectDir) {
  const { items } = readAssets(projectDir)
  return items.map((item) => ({ ...item, path: join(assetsDirectory(projectDir), item.file) }))
}

// ffmpeg 不做 ffprobe 的活，但 -i 的 stderr 里第一段视频流就有尺寸。
export async function probeImage(file) {
  const { stderr } = await run(['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  const match = /Stream #\d+:\d+.*?(\d{2,5})x(\d{2,5})/.exec(stderr)
  if (!match) throw new Error('读不出图片尺寸：' + basename(file))
  return { width: Number(match[1]), height: Number(match[2]) }
}

// 音频只关心时长与峰值：时长给时间轴算 durationInFrames，峰值给"钉帧"用。
export async function probeAudio(file) {
  const { stderr } = await run(['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!duration) throw new Error('读不出音频时长：' + basename(file))
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
  const peak = await run(['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const maxVolume = /max_volume:\s*(-?\d+(?:\.\d+)?)/.exec(peak.stderr || '')
  return { seconds, samplePeakDb: maxVolume ? Number(maxVolume[1]) : null }
}

function rgb(r, g, b) {
  return '#' + [r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')
}

function rgbAt(buffer, offset = 0) {
  return rgb(buffer[offset], buffer[offset + 1], buffer[offset + 2])
}

// 两种读数：平均色（scale=1:1）给"底色"，主色统计（缩到 48×48 再按频次聚类）给"色板"。
// 不用 palettegen：它会把没用满的槽位填成纯绿，色板里混进假颜色。
export async function colorsOf(file, maxColors = 8) {
  const average = await run(['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })
  const sampled = await run(['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=48:48:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })
  const buckets = new Map()
  for (let offset = 0; offset + 2 < sampled.stdout.length; offset += 3) {
    const r = sampled.stdout[offset], g = sampled.stdout[offset + 1], b = sampled.stdout[offset + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 }
    bucket.count++
    bucket.r += r
    bucket.g += g
    bucket.b += b
    buckets.set(key, bucket)
  }
  const colors = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors)
    .map((bucket) => rgb(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count))
  return { average: average.stdout.length >= 3 ? rgbAt(average.stdout) : null, colors }
}

function slug(name) {
  return String(name || 'asset')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'asset'
}

function uniqueName(projectDir, base, ext) {
  const dir = assetsDirectory(projectDir)
  const taken = new Set(existsSync(dir) ? readdirSync(dir) : [])
  let index = 1, name = base + ext
  while (taken.has(name)) name = base + '-' + (++index) + ext
  return name
}

async function describe(file, item) {
  const ext = extname(file).toLowerCase()
  if (VECTOR_EXT.has(ext)) return { ...item, kind: 'vector' }
  if (AUDIO_EXT.has(ext)) {
    const { seconds, samplePeakDb } = await probeAudio(file)
    return { ...item, kind: 'audio', seconds, samplePeakDb }
  }
  if (VIDEO_EXT.has(ext)) {
    const { width, height } = await probeImage(file)
    const { seconds } = await probeAudio(file)
    return { ...item, kind: 'video', width, height, seconds }
  }
  const { width, height } = await probeImage(file)
  const { average, colors } = await colorsOf(file)
  return { ...item, kind: 'image', width, height, average, colors }
}

export async function captureAsset(projectDir, sourceFile, options = {}) {
  const ext = extname(sourceFile).toLowerCase()
  if (!MEDIA_EXT.has(ext)) throw new Error('只支持图片 png/jpg/webp/gif/avif、音频 mp3/wav/m4a/aac/ogg/flac、视频 mp4/webm/mov/mkv：' + basename(sourceFile))
  const bytes = statSync(sourceFile).size
  const limit = VIDEO_EXT.has(ext) ? MAX_VIDEO_BYTES : MAX_BYTES
  if (bytes > limit) throw new Error('素材超过 ' + Math.round(limit / 1024 / 1024) + 'MB，请先压缩')
  const dir = assetsDirectory(projectDir)
  mkdirSync(dir, { recursive: true })
  // 内容去重：同一个文件（同 sha256）只落一份。音效被反复引用时，
  // 重复拷贝会让 assets/ 里堆一串 a-2.mp3、a-3.mp3，打包也跟着变大。
  const sha256 = createHash('sha256').update(readFileSync(sourceFile)).digest('hex')
  const existing = readAssets(projectDir).items.find((item) => item.sha256 === sha256 && existsSync(join(dir, item.file)))
  if (existing) return existing
  const file = uniqueName(projectDir, options.name ? slug(options.name) : slug(basename(sourceFile)), ext)
  const target = join(dir, file)
  if (existsSync(target)) chmodSync(target, 0o644)
  copyFileSync(sourceFile, target)
  // 源文件可能带只读属性（截图被复制过来时常见），落地后一律清掉：
  // 否则下一次渲染把素材复制进 bundle/public 会因为目标已存在且只读而 EPERM。
  chmodSync(target, 0o644)
  const entry = await describe(target, {
    id: file.replace(/\.[a-z0-9]+$/i, ''), file, bytes, sha256,
    source: options.source || basename(sourceFile),
    ...(options.license ? { license: String(options.license).slice(0, 160) } : {}),
    ...(options.caption ? { caption: String(options.caption).slice(0, 400) } : {}),
    at: new Date().toISOString(),
  })
  const manifest = readAssets(projectDir)
  manifest.items.push(entry)
  writeAssets(projectDir, manifest)
  return entry
}

export async function cropAsset(projectDir, sourceFile, options = {}) {
  const dir = assetsDirectory(projectDir)
  mkdirSync(dir, { recursive: true })
  const x = Math.max(0, Math.round(Number(options.x) || 0)), y = Math.max(0, Math.round(Number(options.y) || 0))
  const w = Math.round(Number(options.w) || 0), h = Math.round(Number(options.h) || 0)
  if (!w || !h) throw new Error('裁切需要 w 与 h')
  const file = uniqueName(projectDir, options.name ? slug(options.name) : 'crop', '.png')
  const target = join(dir, file)
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', sourceFile, '-vf', 'crop=' + w + ':' + h + ':' + x + ':' + y, target])
  const entry = await describe(target, {
    id: file.replace(/\.png$/, ''), file, bytes: statSync(target).size,
    sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
    source: basename(sourceFile), crop: { x, y, w, h },
    ...(options.caption ? { caption: String(options.caption).slice(0, 400) } : {}),
    at: new Date().toISOString(),
  })
  const manifest = readAssets(projectDir)
  manifest.items.push(entry)
  writeAssets(projectDir, manifest)
  return entry
}

const MIME_EXT = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  ['image/avif', '.avif'], ['image/svg+xml', '.svg'], ['video/mp4', '.mp4'], ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'], ['audio/wav', '.wav'], ['audio/mp4', '.m4a'], ['audio/ogg', '.ogg'],
])

function extensionForAsset(contentType, sourceUrl) {
  const byType = MIME_EXT.get(String(contentType || '').toLowerCase())
  if (byType) return byType
  try {
    const ext = extname(new URL(sourceUrl).pathname).toLowerCase()
    return MEDIA_EXT.has(ext) ? ext : null
  } catch {
    return null
  }
}

/**
 * 把网址上的原始字节下载进 assets/。
 *
 * 有它是因为"官方 logo"这件事不能靠截图也不能靠重画：品牌规范里的 SVG 才是唯一正确的像素，
 * 截屏会带背景、会掉精度、比例还可能被浏览器改过。下载后走与 capture 相同的落盘与量测路径，
 * 只是多记一个 source URL —— 交付时要能把"这张图哪来的"说清楚。
 */
export async function fetchAsset(projectDir, sourceUrl, options = {}) {
  let url
  try {
    url = new URL(String(sourceUrl))
  } catch {
    throw new Error('不是一个合法的地址：' + sourceUrl)
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http(s) 地址')
  const controller = new AbortController(), upstream = options.signal
  const abort = () => controller.abort(upstream?.reason)
  if (upstream?.aborted) abort()
  else upstream?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('素材下载超时')), 60000)
  let temp
  try {
    const response = await fetch(url.href, { redirect: 'follow', headers: { 'user-agent': 'dsh-drawai/asset-fetch' }, signal: controller.signal })
    if (!response.ok) throw new Error('下载失败 HTTP ' + response.status + '：' + url.href)
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const ext = extensionForAsset(contentType, url.href)
    if (!ext) { await response.body?.cancel(); throw new Error('这个地址不是图片/音视频/svg（content-type: ' + (contentType || '未知') + '）：' + url.href) }
    const limit = VIDEO_EXT.has(ext) ? MAX_VIDEO_BYTES : MAX_BYTES
    const tooLarge = () => new Error('素材超过 ' + Math.round(limit / 1024 / 1024) + 'MB，请先压缩')
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw tooLarge() }
    temp = join(tmpdir(), 'drawai-fetch-' + randomUUID() + ext)
    const handle = await openFile(temp, 'wx')
    try {
      let bytes = 0
      if (!response.body) throw new Error('下载响应没有内容')
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > limit) throw tooLarge()
        await handle.writeFile(chunk)
      }
    } finally { await handle.close() }
    const baseName = options.name || basename(url.pathname).replace(/\.[a-z0-9]+$/i, '') || 'asset'
    return await captureAsset(projectDir, temp, { name: baseName, caption: options.caption, source: url.href })
  } finally {
    clearTimeout(timer)
    upstream?.removeEventListener('abort', abort)
    if (temp) try { unlinkSync(temp) } catch {}
  }
}
