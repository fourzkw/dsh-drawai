// 预览：把"某几帧长什么样"变成一张能直接看见的拼图。
//
// 这是整个改造里最重要的一条：以前 image_view 只返回路径，模型看不见图，
// 于是要花一整轮工具调用来"取图"，34 次就是 34 个回合。现在预览工具
// 直接返回 {type:'image', attachment}，同一轮就能判断画面对不对。

import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffmpegBinary } from '../video-export.js'
import { renderProject, outputPath } from './render.js'

const exec = promisify(execFile)

export function previewDir(dir) {
  return join(dir, '.out', 'preview')
}

// 把已经渲染好的 PNG 拼成一张图。用 ffmpeg 的 tile，避免引入新依赖。
export async function contactSheet(images, options = {}) {
  if (!images.length) throw new Error('没有可拼的帧')
  const cols = Math.max(1, Math.min(4, Math.round(Number(options.cols) || 3)))
  const rows = Math.ceil(images.length / cols)
  const work = dirnameOf(images[0]) + '\\.sheet-' + createHash('sha1').update(images.join('|')).digest('hex').slice(0, 10)
  mkdirSync(work, { recursive: true })
  try {
    images.forEach((file, index) => copyFileSync(file, join(work, 'frame-' + (index + 1) + '.png')))
    const output = join(work, 'sheet.png')
    await exec(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(work, 'frame-%d.png'),
      '-frames:v', '1', '-vf', 'scale=640:-2:flags=lanczos,tile=' + cols + 'x' + rows + ':padding=8:margin=8:color=0x101010', output],
      { windowsHide: true, timeout: 60000 })
    if (!existsSync(output)) throw new Error('拼图失败')
    return output
  } finally {
    for (const file of readdirSync(work)) if (file !== 'sheet.png') rmSync(join(work, file), { force: true })
  }
}

function dirnameOf(file) {
  const index = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return index > 0 ? file.slice(0, index) : '.'
}

// 渲染 + 拼图 + 转附件，一次做完。
// 返回的 attachment 由调用方的 render() 拼成 {type:'image', attachment} 内容块。
export async function previewProject(dir, options = {}) {
  const frames = options.frames
  if (!Array.isArray(frames) || !frames.length) throw new Error('frames 必填，例如 [0, 60, 120]')
  const result = await renderProject(dir, { operation: 'still', frames, onProgress: options.onProgress }).promise
  const rendered = (result.frames || []).map((item) => item.filename ? join(dir, '.out', 'qa', item.filename) : null).filter(Boolean)
  if (!rendered.length) throw new Error('没有渲染出可预览的帧')
  const sheet = await contactSheet(rendered, { cols: options.cols })
  const bytes = await import('node:fs').then((fs) => fs.readFileSync(sheet))
  const attachments = options.attachments
  const attachment = attachments?.saveImage
    ? await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'preview-' + Date.now() + '.png' })
    : undefined
  return {
    frames: rendered.map((file, index) => ({ frame: Number(frames[index]), file, bytes: statSync(file).size })),
    sheet,
    attachment,
    output: outputPath(dir, 'preview.png'),
  }
}
