// 交付级派生：把 .out/film.mp4 变成平台要的几种文件。
//
// 为什么不属于插件：平台规则一直在变（码率上限、竖版裁切策略、字幕规矩），
// 这些东西写进插件就等于把一份会过期的知识固化在工具里。放在工程里，
// 用户想改就改，插件只保证「成片本身是对的」。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const POLISH = `#!/usr/bin/env node
// 交付级派生：把 .out/film.mp4 变成平台要的几种文件。
// 默认全跑；也可以单个跑。
//
//   node tools/polish.mjs             全部（母版 + 平台版 + 竖版 + 响度）
//   node tools/polish.mjs --master    ProRes 422 HQ 母版（给后期，给存档）
//   node tools/polish.mjs --web       平台版：1080p / 720p，crf 18，faststart
//   node tools/polish.mjs --vertical  竖版：等比缩放 + 模糊底，抖音/Reels
//   node tools/polish.mjs --loudness  只量响度，不产出文件
//
// FFmpeg 查找顺序：DRAWAI_FFMPEG_PATH → FFMPEG_PATH → PATH → Workbuddy 缓存
// (~/.dsh/drawai-ffmpeg/<平台>-<架构>/，可用 DRAWAI_FFMPEG_DIR 覆盖)。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const project = resolve(here, '..')
const source = join(project, '.out', 'film.mp4')
const dist = join(project, 'dist')

// 查找顺序与插件一致：显式路径 → 旧环境变量 → PATH → Workbuddy 的独立缓存。
// 显式路径无效时直接报错，不会悄悄换成别的 FFmpeg。
function usable(candidate) {
  if (!candidate) return false
  const result = spawnSync(candidate, ['-hide_banner', '-version'], { stdio: 'ignore' })
  return !result.error && result.status === 0
}
function resolveFfmpeg() {
  const explicit = process.env.DRAWAI_FFMPEG_PATH
  if (explicit) {
    if (!usable(explicit)) {
      console.error('DRAWAI_FFMPEG_PATH 指定的 FFmpeg 不可用：' + explicit + '。请修正这个路径，或删除这个环境变量，让脚本使用 PATH / Workbuddy 缓存。')
      process.exit(1)
    }
    return explicit
  }
  for (const candidate of [process.env.FFMPEG_PATH, 'ffmpeg']) if (usable(candidate)) return candidate
  const cacheRoot = process.env.DRAWAI_FFMPEG_DIR || join(homedir(), '.dsh', 'drawai-ffmpeg')
  const cached = join(cacheRoot, process.platform + '-' + process.arch, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (usable(cached)) return cached
  console.error('找不到 FFmpeg：先在 Workbuddy 里导出一次视频（首次使用会自动下载并校验），或把 ffmpeg 加入 PATH，或设置 DRAWAI_FFMPEG_PATH 指向可执行文件。')
  process.exit(1)
}
const ffmpeg = resolveFfmpeg()

if (!existsSync(source)) {
  console.error('找不到成片：' + source + '（先 wb render 渲整片）')
  process.exit(1)
}
const spec = (() => {
  try { return JSON.parse(readFileSync(join(project, 'timeline.json'), 'utf8').replace(/^\\uFEFF/, '')) } catch { return { width: 1920, height: 1080 } }
})()
const width = spec.width || 1920
const height = spec.height || 1080
const flags = process.argv.slice(2)
const want = (name) => flags.length === 0 || flags.includes('--' + name)
mkdirSync(dist, { recursive: true })

function run(args, label) {
  console.log('→ ' + label)
  const result = spawnSync(ffmpeg, ['-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.status !== 0) {
    console.error('失败：' + label)
    process.exit(result.status || 1)
  }
}

// bt709 三标签是硬要求：不打标签的片子换播放器就偏色，这不是「观感问题」。
const tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']

if (want('master')) {
  run(['-i', source, '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le',
    '-c:a', 'pcm_s24le', '-ar', '48000', ...tags, join(dist, 'film-master.mov')], 'ProRes 422 HQ 母版')
}

if (want('web')) {
  for (const target of [1080, 720]) {
    const w = target === 1080 ? width : Math.round(width * target / height / 2) * 2
    const h = target === 1080 ? height : Math.round(height * target / height / 2) * 2
    run(['-i', source, '-vf', 'scale=' + w + ':' + h + ':flags=lanczos+accurate_rnd+full_chroma_int',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-profile:v', 'high', '-x264-params', 'aq-mode=3',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
      ...tags, join(dist, 'film-' + h + 'p.mp4')], h + 'p 平台版')
  }
}

if (want('vertical')) {
  // 竖版不是「裁一刀」：等轴画面裁掉两侧就只剩中间一栋楼。等比缩进 9:16 再垫模糊底。
  const vw = 1080
  const vh = 1920
  run(['-i', source, '-filter_complex',
    '[0:v]scale=' + vw + ':' + vh + ':force_original_aspect_ratio=increase,crop=' + vw + ':' + vh + ',gblur=sigma=28[bg];'
    + '[0:v]scale=' + vw + ':-2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', ...tags, join(dist, 'film-vertical.mp4')], '竖版 1080×1920')
}

if (want('loudness')) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', source, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
    { encoding: 'utf8' })
  const text = (result.stderr || '') + (result.stdout || '')
  const match = text.match(/\\{[\\s\\S]*?"input_i"[\\s\\S]*?\\}/)
  if (!match) {
    console.error('量不出响度（片子里没有音轨？）')
    process.exit(1)
  }
  const data = JSON.parse(match[0])
  console.log('响度：' + data.input_i + ' LUFS / 真峰 ' + data.input_tp + ' dBTP / LRA ' + data.input_lra
    + '（目标 −14 / ≤−1）')
  if (Number(data.input_i) > -13 || Number(data.input_tp) > -0.9) {
    console.error('超出交付范围：检查 timeline.json 的 audioMix，或重跑 wb render（会自动过 loudnorm + 限幅）')
    process.exit(2)
  }
}
`

export const POLISH_FILE = 'tools/polish.mjs'

// 只写缺的文件，和 scene-kit 同一套规矩。
export function writeDelivery(dir, options = {}) {
  const io = options.io || { join, dirname, existsSync, mkdirSync, writeFileSync }
  const file = io.join(dir, 'tools', 'polish.mjs')
  io.mkdirSync(io.dirname(file), { recursive: true })
  if (io.existsSync(file) && !options.overwrite) return []
  io.writeFileSync(file, POLISH, 'utf8')
  return [POLISH_FILE]
}
