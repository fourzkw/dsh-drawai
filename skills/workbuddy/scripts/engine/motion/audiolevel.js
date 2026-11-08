// 音轨电平：加一条音轨的时候就算清楚它进混音会是什么样。
//
// 这不是混音器，只是把"要不要减一点增益"这件事从**渲完再发现**挪到**加的时候就知道**。
// 两个依据：素材自带的样本峰值（ffmpeg volumedetect）和这条的增益。
//
// 为什么不能直接照抄 suggestedGainDb：
//   那个建议是把 RMS 拉到 -16dB，对**短促的打击类音效**是错的 ——
//   RMS 很低但峰值很高，照抄会把峰值推到 +5dBFS（实测 fs:615308 就是这样）。
//   所以这里按峰值再夹一次：清单说多少都可以，但峰值不许过天花板。

import { dbToGain } from './audio.js'

/** 留出的天花板：峰值到 -1 dBFS 就当作"会顶"（编码器前端还有取样间过冲）。 */
export const PEAK_CEILING_DB = -1

/** 已知峰值时，这条最多还能加多少 dB。 */
export function maxGainFor(peakDb, ceilingDb = PEAK_CEILING_DB) {
  if (!Number.isFinite(Number(peakDb))) return null
  return Math.floor((ceilingDb - Number(peakDb)) * 10) / 10
}

/** 增益从哪来：显式 > 音频清单的建议 > 角色默认；非显式的再按峰值夹一道。 */
export function resolveGainDb({ explicitGain, manifestGain, role, peakDb } = {}) {
  if (Number.isFinite(Number(explicitGain))) return { gainDb: Number(explicitGain), source: 'explicit' }
  const suggested = Number.isFinite(Number(manifestGain))
  const proposed = suggested ? Number(manifestGain) : (role === 'bgm' ? -10 : 0)
  const source = suggested ? 'manifest' : 'role'
  const limit = maxGainFor(peakDb)
  if (limit !== null && proposed > limit) return { gainDb: limit, source, capped: proposed }
  return { gainDb: proposed, source }
}

/** 音频清单里这个文件被建议的增益（wb sfx get 量出来写进去的）。 */
export function suggestedGainOf(manifest, file) {
  const entry = (manifest?.assets || []).find((item) => item.file === file)
  const gain = entry?.analysis?.suggestedGainDb
  return Number.isFinite(Number(gain)) ? Number(gain) : null
}

/** 一个素材加完增益之后的峰值；素材测不出来时给 null（不假装知道）。 */
export function cueLevel({ peakDb, gainDb } = {}) {
  const known = peakDb !== null && peakDb !== undefined && Number.isFinite(Number(peakDb))
  const peak = known ? Math.round((Number(peakDb) + Number(gainDb || 0)) * 10) / 10 : null
  return { peakDb: peak, headroomDb: peak === null ? null : Math.round((PEAK_CEILING_DB - peak) * 10) / 10, clips: peak !== null && peak > PEAK_CEILING_DB }
}

/** 几条同时响的峰值做线性相加的保守估计（不是 LUFS，只是"会不会顶"）。 */
export function mixPeakDb(cuePeaksDb) {
  const sum = (cuePeaksDb || []).reduce((total, db) => (Number.isFinite(Number(db)) ? total + dbToGain(Number(db)) : total), 0)
  return sum > 0 ? Math.round(20 * Math.log10(sum) * 10) / 10 : null
}

/** 给工具返回值用的人话。 */
export function describeLevel({ cue, gain, level, overlaps }) {
  const source = { explicit: '显式指定', manifest: '音频清单的 suggestedGainDb', role: '角色默认' }[gain.source] || gain.source
  const lines = ['增益 ' + cue.gainDb + 'dB —— ' + source
    + (gain.capped === undefined ? '' : '（原文建议 ' + gain.capped + 'dB，按峰值夹到 ' + cue.gainDb + 'dB，否则会削波）')]
  if (level.peakDb === null) lines.push('素材量不出峰值（空的或格式没解析），电平只能靠听')
  else if (level.clips) lines.push('这一条加完峰值约 ' + level.peakDb + ' dBFS，已经顶到天花板')
  else lines.push('这一条加完峰值约 ' + level.peakDb + ' dBFS，余量 ' + level.headroomDb + 'dB')
  if (overlaps > 0) lines.push('这个时间段已经有 ' + overlaps + ' 条音轨，叠加后峰值只会更高')
  return lines.join('\n')
}
