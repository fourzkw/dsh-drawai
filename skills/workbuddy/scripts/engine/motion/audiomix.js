// 混音后级：成片渲完再走一遍 loudnorm + alimiter。
//
// 为什么需要这一级：
//   Remotion 把各条 <Audio> 直接相加编码成 AAC，**没有任何限幅**；
//   而画布那条旧链路（audio-media.js）混音时一直带 alimiter。
//   缺这一级的后果是可实测的：n1 那条片的真峰值一度 +1.8 dBFS（削波），
//   只能靠帧检事后发现再回头手改每一条的增益。
//
// 用的是 loudnorm 的两遍法：
//   第一遍只量（print_format=json 拿到 measured_*），
//   第二遍把测得值喂回去并开 linear=true —— 能线性就线性（不动动态），
//   线性会把真峰值顶穿时 loudnorm 自己退回动态模式。
//   最后再挂一级 alimiter 兜底，防止编码器前端出现取样间过冲。

import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runFfmpeg } from './ffmpeg.js'

/**
 * 目标响度：交付规范是 −14 LUFS / 真峰值 ≤ −1 dBTP（网络平台上传标准）。
 * 早先取 −16 / −1.5 是「保守一点」的折中；既然插件出的就是交付件，默认就该是交付值。
 * 要旧行为可以在 timeline.json 的 audioMix 里显式写回。
 */
export const MIX_DEFAULTS = { normalize: true, lufs: -14, truePeak: -1, lra: 11 }

/** 从 loudnorm 的 stderr 里取最后一段 JSON（前面还有滤镜的日志行）。 */
export function parseLoudnormJson(text) {
  const blocks = [...String(text || '').matchAll(/\{[^{}]*\}/g)]
  for (let index = blocks.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(blocks[index][0])
      if (parsed && parsed.input_i !== undefined) return parsed
    } catch { /* 不是 JSON，继续往前找 */ }
  }
  return null
}

/** 量整段的综合响度与真峰值（取 ebur128 结尾的 Summary 段）。没有音轨时返回 null 值。 */
export async function measureLoudness(file, options = {}) {
  const text = await runFfmpeg(['-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { cwd: options.cwd, log: options.log || 'mix-ebur128.log', allowFail: true, timeoutMs: options.timeoutMs })
  // ebur128 每 100ms 打一行进度，开头那几行的 I 是 -70（还没攒够数据）；
  // 只有结尾 Summary 段才是整段的结论，所以从 Summary 开始截，并取最后一个匹配。
  const index = text.lastIndexOf('Summary:')
  const summary = index >= 0 ? text.slice(index) : text
  const grab = (pattern) => {
    const matches = [...summary.matchAll(pattern)]
    return matches.length ? Number(matches[matches.length - 1][1]) : null
  }
  return {
    integratedLufs: grab(/I:\s*(-?[\d.]+)\s*LUFS/g),
    truePeakDb: grab(/Peak:\s*(-?[\d.]+)\s*dBFS/g),
  }
}

/**
 * 把一条成片的音轨归一化到目标响度并限幅。
 * 视频流用 -c:v copy 直接搬，不重编画面；只有 AAC 音频流被重编。
 */
export async function normalizeMix(file, options = {}) {
  // 只认这四个字段：cwd/log/timeoutMs 是调用参数，不该跟着结果一起存进 job 记录。
  const picked = {}
  for (const key of ['normalize', 'lufs', 'truePeak', 'lra']) if (options[key] !== undefined) picked[key] = options[key]
  const settings = { ...MIX_DEFAULTS, ...picked }
  if (!existsSync(file)) throw new Error('找不到要归一化的成片：' + file)
  const cwd = options.cwd || dirname(file)
  const log = options.log || join(cwd, 'mix.log')
  const before = await measureLoudness(file, { cwd, log: log.replace(/\.log$/, '-before.log') })
  if (before.integratedLufs === null) {
    return { applied: false, reason: '这条片子没有音轨，跳过响度归一', before, after: before, settings }
  }
  // 已经在目标附近就别再动它：反复归一化会有零点几 LU 的漂移。
  const close = Math.abs(before.integratedLufs - settings.lufs) <= 0.5
  const safe = before.truePeakDb === null || before.truePeakDb <= settings.truePeak + 0.35
  if (close && safe) {
    return { applied: false, reason: '响度已在目标附近（' + before.integratedLufs + ' LUFS）', before, after: before, settings }
  }

  const measureText = await runFfmpeg([
    '-i', file,
    '-af', 'loudnorm=I=' + settings.lufs + ':TP=' + settings.truePeak + ':LRA=' + settings.lra + ':print_format=json',
    '-f', 'null', '-',
  ], { cwd, log: log.replace(/\.log$/, '-measure.log'), timeoutMs: options.timeoutMs })
  const measured = parseLoudnormJson(measureText)
  if (!measured) throw new Error('loudnorm 没给出测量结果，无法归一化')

  // 限幅器比目标再低 1dB：AAC 编码会在取样间造出新的过冲。
  // 但过冲的大小取决于素材（-14 LUFS 比 -16 压得更狠，过冲也更大），
  // 所以不能靠固定余量赌：编完量一次，还在目标之上就按实测差值再压一轮。
  let limitDb = settings.truePeak - 1.0
  let after = null
  const temporary = join(dirname(file), basename(file, '.mp4') + '.mixing.mp4')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 第一轮：loudnorm 归一到目标 + 限幅。第二轮只挂限幅器 ——
    // 文件已经是目标响度了，再跑一遍 loudnorm 会拿上一轮的测量值再加一次增益（实测 +1.2 LU）。
    const limiter = 'alimiter=limit=' + Math.pow(10, limitDb / 20).toFixed(4) + ':attack=5:release=50:level=0'
    const filter = attempt === 0
      ? [
        'loudnorm=I=' + settings.lufs + ':TP=' + settings.truePeak + ':LRA=' + settings.lra,
        'measured_I=' + measured.input_i,
        'measured_TP=' + measured.input_tp,
        'measured_LRA=' + measured.input_lra,
        'measured_thresh=' + measured.input_thresh,
        'offset=' + (measured.target_offset || 0),
        'linear=true',
        'print_format=summary',
      ].join(':') + ',' + limiter
      : limiter

    try {
      await runFfmpeg([
        '-i', file,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-af', filter,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        temporary,
      ], { cwd, log, timeoutMs: options.timeoutMs })
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    after = await measureLoudness(file, { cwd, log: log.replace(/\.log$/, '-after.log') })
    const overshoot = after.truePeakDb === null ? 0 : after.truePeakDb - settings.truePeak
    if (overshoot <= 0) break
    // 第二轮只压限幅器，不再重算 loudnorm 的测量值：响度已经到位了。
    limitDb -= overshoot + 0.3
  }
  return { applied: true, before, after, settings, measured, limitDb }
}

/** 一行给人看的结论。 */
export function describeMix(mix) {
  if (!mix) return ''
  if (!mix.applied) return '响度：' + (mix.reason || '未处理')
  const before = mix.before.integratedLufs === null ? '—' : mix.before.integratedLufs + ' LUFS'
  const after = mix.after.integratedLufs === null ? '—' : mix.after.integratedLufs + ' LUFS'
  const peakBefore = mix.before.truePeakDb === null ? '—' : mix.before.truePeakDb + ' dBFS'
  const peakAfter = mix.after.truePeakDb === null ? '—' : mix.after.truePeakDb + ' dBFS'
  return '响度：' + before + ' → ' + after + '，真峰值 ' + peakBefore + ' → ' + peakAfter
}
