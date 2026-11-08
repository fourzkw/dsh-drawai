// 音频轨：画面和声音共用一条时间轴。
//
// 为什么不是"渲染完再用 ffmpeg 混音"：混音只能调已有素材的音量，
// 改不了画面；而卡点需要"这一帧的画面事件"和"这一拍的重音"同时成立。
// 所以音频必须进 Remotion 的 plan，由 entry.jsx 在渲染时挂 <Audio>。
//
// 时间轴上的音频条目（timeline.json 的 audio[]）：
//   { id, file, role, from, durationInFrames, gainDb, fadeIn, fadeOut, trimStart, loop, duck }
// - file 相对 <工程>/assets/，渲染时用 staticFile(file)；
// - from 是**全片帧坐标**，和 shots 同一坐标系（不写场景内相对帧）；
// - gainDb 用 dB（0 = 原样，-6 = 一半），entry 里转成线性增益；
// - duck=true 时，旁白区间自动压低（BGM 专用）。

import { randomUUID } from 'node:crypto'
import { OUTPUT_AUDIO_OFFSET_F } from './beats.js'

export const AUDIO_ROLES = ['bgm', 'voice', 'sfx']
export const DUCK_DB = -12
export const DUCK_RAMP_FRAMES = 6

/** 把一条音频条目规范成渲染能吃的形状；缺字段给默认值，越界直接拒绝。 */
export function normalizeCue(raw, fps, totalFrames) {
  if (!raw || typeof raw !== 'object') return null
  const file = typeof raw.file === 'string' ? raw.file.replace(/\\/g, '/') : ''
  if (!file || file.indexOf('..') >= 0) return null
  const role = AUDIO_ROLES.includes(raw.role) ? raw.role : 'sfx'
  const from = Math.max(0, Math.round(Number(raw.from) || 0))
  const duration = Math.max(1, Math.round(Number(raw.durationInFrames) || Math.round(Number(raw.duration) * fps) || fps))
  const gainDb = Number.isFinite(Number(raw.gainDb)) ? Number(raw.gainDb) : (role === 'bgm' ? -10 : 0)
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'cue-' + randomUUID().slice(0, 8),
    file,
    role,
    from: Math.min(from, Math.max(0, totalFrames - 1)),
    durationInFrames: Math.min(duration, Math.max(1, totalFrames - from)),
    gainDb,
    fadeIn: Math.max(0, Math.round(Number(raw.fadeIn) || 0)),
    fadeOut: Math.max(0, Math.round(Number(raw.fadeOut) || 0)),
    trimStart: Math.max(0, Number(raw.trimStart) || 0),
    loop: raw.loop === true || raw.loop === '1',
    duck: role === 'bgm' ? raw.duck !== false : false,
  }
}

export function readTrack(timeline) {
  const fps = Number(timeline.fps) || 30
  const total = Number(timeline.durationInFrames) || 0
  const list = Array.isArray(timeline.audio) ? timeline.audio : []
  return list.map((cue) => normalizeCue(cue, fps, total)).filter(Boolean)
}

export function writeTrack(timeline, cues) {
  timeline.audio = cues
  return timeline
}

export function addCue(timeline, cue) {
  const cues = readTrack(timeline)
  const next = normalizeCue(cue, Number(timeline.fps) || 30, Number(timeline.durationInFrames) || 0)
  if (!next) throw new Error('音频条目缺少 file')
  // 只替换「同一个文件 + 同一个角色 + 同一个位置」的那一条（重复调用是幂等的）；
  // 同一个音效放在不同时间点是两条轨，不能互相顶掉。
  const filtered = cues.filter((item) => !(item.file === next.file && item.role === next.role && item.from === next.from))
  filtered.push(next)
  filtered.sort((a, b) => a.from - b.from)
  return writeTrack(timeline, filtered)
}

export function removeCue(timeline, id) {
  const cues = readTrack(timeline).filter((cue) => cue.id !== id)
  return writeTrack(timeline, cues)
}

/**
 * 旁白区间（全片帧），给 ducking 用。
 * 提前 4 帧起、延后 8 帧收，避免声音尾巴被"掐断"。
 */
export function voiceWindows(cues) {
  return cues.filter((cue) => cue.role === 'voice').map((cue) => ({
    from: Math.max(0, cue.from - 4),
    to: cue.from + cue.durationInFrames + 8,
  }))
}

/** dB → 线性增益。 */
export function dbToGain(db) {
  return Math.pow(10, Number(db || 0) / 20)
}

/**
 * 把一条音频钉到某个"画面事件帧"上（原版 sound-design §4.6 的公式）。
 * sourcePeakLagFrames 由 wb audio analyze 给出（peakLag × fps）。
 */
export function cuePinnedAt(targetPeakFrame, sourcePeakLagFrames = 0) {
  return Math.max(0, Math.round(targetPeakFrame - (sourcePeakLagFrames || 0) - OUTPUT_AUDIO_OFFSET_F))
}

/** 音频轨摘要：给工具返回值和 BRIEF 用。 */
export function describeTrack(cues, fps) {
  if (!cues.length) return '（无音频）'
  return cues.map((cue) => '- ' + cue.role + ' ' + cue.file + ' @ ' + (cue.from / fps).toFixed(2) + 's · '
    + (cue.durationInFrames / fps).toFixed(2) + 's · ' + cue.gainDb + 'dB' + (cue.duck ? ' · 旁白避让' : '')).join('\n')
}
