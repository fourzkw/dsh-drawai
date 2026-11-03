// 成片回流：把渲染产物落成画布视频节点能播的 clip pack。
//
// 为什么不是"把 mp4 塞进 .drawio"：文档里只该有 id（mediaClip），字节留在
// `<画布>.media/<clip>/` 里。播放器对 raster clip 的做法是读 `source.mp4`
// 的原字节、用 <video> 直接播（见 src/video-player.js:203），所以只要
// source + manifest 就够，stills/ 只服务于"抽帧转 SVG"那条编辑路径。
//
// 这里不做视频解码之外的任何创作：渲染出来的像素原样搬，海报抽一帧。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ffmpegBinary } from '../video-export.js'
import {
  allocateClipId,
  clipDirFor,
  ensureClipPack,
  importSourceFile,
  POSTER_NAME,
  readManifest,
  videoDataAttrs,
  videoMetaFromData,
  writeManifest,
} from '../media.js'

const exec = promisify(execFile)
const MAX_SOURCE_BYTES = 512 * 1024 * 1024

function ffmpeg(args, options = {}) {
  return exec(ffmpegBinary(), args, {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
}

/** ffmpeg 不做 ffprobe 的活：`-i` 的 stderr 里就有尺寸、帧率、时长。 */
export async function probeVideo(file) {  let stderr = ''
  try {
    const result = await ffmpeg(['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
    stderr = result.stderr || ''
  } catch (error) {
    // ffmpeg 对"没有输出文件"的探测会以非零码退出，stderr 仍然有效。
    stderr = String((error && (error.stderr || error.message)) || '')
  }
  const size = /Stream #\d+:\d+.*?(\d{2,5})x(\d{2,5})/.exec(stderr)
  if (!size) throw new Error('读不出视频尺寸：' + file)
  const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0
  const seconds = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
  }
}

/** 抽一帧 PNG 当海报（默认取 0.4s，避开首帧可能的黑场/入场动画）。 */
export async function posterPng(file, atSeconds = 0.4) {
  // 海报最终以 base64 内嵌进节点 style，尺寸就是文档体积——所以先缩到 960 宽。
  const result = await ffmpeg(
    ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', file,
      '-frames:v', '1', '-vf', 'scale=640:-2:flags=lanczos', '-f', 'image2pipe', '-vcodec', 'png', '-'],
    { encoding: 'buffer' },
  )
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0) throw new Error('抽不出海报帧：' + file)
  return result.stdout
}

/** 把 PNG 包成节点海报需要的 SVG 标记（画布按 style 里的 svg 渲染封面）。 */
export function posterMarkup(pngBuffer, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 1))
  const h = Math.max(1, Math.round(Number(height) || 1))
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<image width="100%" height="100%" href="data:image/png;base64,' + pngBuffer.toString('base64') + '"/></svg>'
}

function existingClipIds(doc) {
  const out = []
  for (const node of (doc && doc.nodes) || []) {
    const meta = videoMetaFromData(node.data)
    if (meta) out.push(meta.clip)
  }
  return out
}

/**
 * 把一段成片落进节点的 clip pack。
 *
 * - 节点已有 clip 就复用，没有就分配 `clip-N`；
 * - source 复制成 `source.mp4`（保留原字节，播放器直接播它）；
 * - manifest 标成 raster，写回 fps/尺寸/时长；
 * - 返回 node.data 需要合并的属性 + 海报标记，调用方负责写文档。
 */
export async function applyFilm({ drawioAbs, doc, node, film, fpsFallback = 30 }) {
  if (typeof film !== 'string' || film.length === 0) throw new Error('缺少成片路径')
  if (existsSync(film) === false) throw new Error('成片还不存在：' + film)
  const bytes = statSync(film).size
  if (bytes <= 0) throw new Error('成片是空文件：' + film)
  if (bytes > MAX_SOURCE_BYTES) throw new Error('成片超过 ' + Math.round(MAX_SOURCE_BYTES / 1024 / 1024) + 'MB，先把画布外置存储清一清')

  const probed = await probeVideo(film)
  const fallbackFps = Number(fpsFallback) > 0 ? Number(fpsFallback) : 30
  const fps = probed.fps > 0 ? probed.fps : fallbackFps
  const existing = videoMetaFromData(node.data)
  // 注意：视频节点建出来时就有 drawaiMedia=1，但 mediaClip 还是空的——
  // videoMetaFromData 这时会返回 { clip: null }，不能直接信。
  const clip = existing && existing.clip ? existing.clip : allocateClipId(existingClipIds(doc))

  const clipDir = clipDirFor(drawioAbs, clip)
  ensureClipPack(drawioAbs, clip, { kind: 'raster', fps, w: probed.width, h: probed.height })
  const imported = importSourceFile(clipDir, film, 'source.mp4')
  // 只读位会跟着复制过来，Remotion 打包 publicDir 时会炸（EPERM copyfile）。
  try { chmodSync(join(clipDir, imported.rel), 0o644) } catch { /* 权限已够 */ }

  const manifest = readManifest(clipDir)
  manifest.kind = 'raster'
  manifest.fps = fps
  manifest.width = probed.width
  manifest.height = probed.height
  manifest.source = imported.rel
  manifest.sourceOffset = 0
  writeManifest(clipDir, manifest)

  const attrs = videoDataAttrs({ clip, kind: 'raster', fps, w: probed.width, h: probed.height, posterFrame: 0 })
  let mark = ''
  try {
    mark = posterMarkup(await posterPng(film, Math.min(0.4, Math.max(0, probed.seconds / 3))), probed.width, probed.height)
    // 顺手把海报也写进 clip pack：ensureClipPack 只会放一张占位图，
    // 打包画布（packCanvasBundle）或别处直接读 poster.svg 时才不会拿到空白。
    writeFileSync(join(clipDir, POSTER_NAME), mark, 'utf8')
  } catch {
    mark = ''
  }
  return {
    clip,
    dir: clipDir,
    source: imported.rel,
    width: probed.width,
    height: probed.height,
    fps,
    seconds: probed.seconds,
    frames: Math.round(probed.seconds * fps),
    bytes,
    attrs,
    poster: mark,
  }
}

/**
 * 把成片的音轨抽成单声道 wav，给回测用（motion_audio_verify）。
 * 20 秒的片子这一步不到 1 秒，别把整条视频解出来。
 */
export async function extractAudio(film, out) {
  if (!existsSync(film)) throw new Error('没有这个文件：' + film)
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', film, '-vn', '-ac', '1', '-ar', '22050', out])
  return out
}
