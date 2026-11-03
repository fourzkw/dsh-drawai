// 节拍检测：把音频解成单声道 PCM，用能量包络的瞬时差找重音，用自相关估 BPM，
// 再用最小二乘把重音序列拟合成等距网格（原版 music-beat-sync 的核心一步）。
//
// 为什么必须拟合网格：beat_track 类的 BPM 标量常偏 2%+，直接按 BPM 推拍子，
// 30 秒后会漂掉一整个拍。拿到重音时刻后再回归直线 t_i = t0 + i*T，
// 才能真正拿到"可信网格"，残差就是自检指标（≤±15ms 才算机器鼓点）。
//
// 结果永远带 confidence / residualMs / reliable：
// 置信度低、残差大时调用方应当只做参考，不要硬对。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { ffmpegBinary } from '../video-export.js'

const exec = promisify(execFile)
const SAMPLE_RATE = 22050
const HOP = 512
const WINDOW = 1024

export async function decodePcm(file) {
  if (!existsSync(file)) throw new Error('找不到音频文件：' + file)
  const { stdout } = await exec(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'], { encoding: 'buffer', windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024 })
  return { pcm: stdout, sampleRate: SAMPLE_RATE, hop: HOP, window: WINDOW }
}

// 能量（对数）+ 半波整流差 = 重音包络。
export function onsetEnvelope(pcm, sampleRate = SAMPLE_RATE, hop = HOP, window = WINDOW) {
  const count = Math.max(0, Math.floor((pcm.length / 2 - window) / hop))
  const energy = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    let sum = 0
    const start = index * hop * 2
    for (let offset = 0; offset < window * 2; offset += 2) {
      const sample = pcm.readInt16LE(start + offset) / 32768
      sum += sample * sample
    }
    energy[index] = Math.log1p(Math.sqrt(sum / window) * 12)
  }
  const flux = new Float64Array(count)
  for (let index = 1; index < count; index++) flux[index] = Math.max(0, energy[index] - energy[index - 1])
  // 三点平滑，压掉单帧毛刺
  const smooth = new Float64Array(count)
  for (let index = 1; index < count - 1; index++) smooth[index] = (flux[index - 1] + flux[index] * 2 + flux[index + 1]) / 4
  return { flux: smooth, framesPerSecond: sampleRate / hop, seconds: (count * hop) / sampleRate, energy }
}

/** RBJ 二阶带通（分频段看鼓件用；不分频段时 kick 会把 snare 埋掉）。 */
function bandpassCoefficients(sampleRate, lo, hi) {
  const f0 = Math.sqrt(lo * hi)
  const q = Math.max(0.4, f0 / Math.max(1, hi - lo))
  const w0 = (2 * Math.PI * f0) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cos = Math.cos(w0)
  const a0 = 1 + alpha
  return {
    b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
  }
}

function applyBiquad(samples, coefficients) {
  const out = new Float64Array(samples.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let index = 0; index < samples.length; index++) {
    const x0 = samples[index]
    const y0 = coefficients.b0 * x0 + coefficients.b1 * x1 + coefficients.b2 * x2 - coefficients.a1 * y1 - coefficients.a2 * y2
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
    out[index] = y0
  }
  return out
}

function toSamples(pcm) {
  const samples = new Float64Array(Math.floor(pcm.length / 2))
  for (let index = 0; index < samples.length; index++) samples[index] = pcm.readInt16LE(index * 2) / 32768
  return samples
}

/** 某个频段的能量包络（把整段 PCM 滤波后逐窗求 RMS）。 */
function bandEnvelope(samples, sampleRate, lo, hi, hop = HOP, window = WINDOW) {
  const filtered = applyBiquad(samples, bandpassCoefficients(sampleRate, lo, hi))
  const count = Math.max(0, Math.floor((filtered.length - window) / hop))
  const envelope = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    let sum = 0
    const start = index * hop
    for (let offset = 0; offset < window; offset++) sum += filtered[start + offset] ** 2
    envelope[index] = Math.sqrt(sum / window)
  }
  return envelope
}

function autocorrelation(values, minLag, maxLag) {
  let bestLag = 0, bestScore = 0
  for (let lag = Math.round(minLag); lag <= Math.round(maxLag); lag++) {
    let score = 0
    for (let index = lag; index < values.length; index++) score += values[index] * values[index - lag]
    score /= values.length - lag
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }
  return { lag: bestLag, score: bestScore }
}

/**
 * 最小二乘拟合等距网格：t_i = t0 + i*T。
 *
 * 先把每个重音时刻归到最近格点上，再对 (i, t) 做一次直线回归；
 * 迭代两轮即可稳定（第一轮用 BPM 推的 T，第二轮用回归出的 T）。
 */
export function fitGrid(times, periodGuess, tolerance = 0.02) {
  if (times.length < 4 || !(periodGuess > 0)) return null
  let period = periodGuess
  let t0 = times[0]
  let inliers = times
  // 两轮：用上一轮的"在格点上的重音"重新回归，把杂音（半拍、漏检）剔出去。
  // 索引必须逐拍累加而不是全局 round((t-t0)/T)：BPM 初值偏 2% 时，
  // 几十拍之后全局取整会整体错位一格，回归出来的残差全是假的。
  for (let round = 0; round < 2; round++) {
    const offsets = times.map((t) => {
      const ratio = (t - t0) / period
      return (ratio - Math.round(ratio)) * period
    })
    const picked = []
    for (let index = 0; index < times.length; index++) if (Math.abs(offsets[index]) <= tolerance) picked.push(times[index])
    if (picked.length < Math.max(4, times.length * 0.3)) return null
    inliers = picked
    const indices = [0]
    for (let k = 1; k < inliers.length; k++) indices.push(indices[k - 1] + Math.max(1, Math.round((inliers[k] - inliers[k - 1]) / period)))
    const n = indices.length
    const sumI = indices.reduce((s, value) => s + value, 0)
    const sumT = inliers.reduce((s, value) => s + value, 0)
    const sumII = indices.reduce((s, value) => s + value * value, 0)
    const sumIT = indices.reduce((s, value, k) => s + value * inliers[k], 0)
    const denominator = n * sumII - sumI * sumI
    if (!denominator) return null
    period = (n * sumIT - sumI * sumT) / denominator
    t0 = (sumT - period * sumI) / n
    if (!(period > 0.2 && period < 2)) return null
  }
  let residual = 0
  for (const t of inliers) {
    const ratio = (t - t0) / period
    residual = Math.max(residual, Math.abs(ratio - Math.round(ratio)) * period)
  }
  return { period, t0, residualMs: residual * 1000, bpm: 60 / period, coverage: inliers.length / times.length }
}

/** 0.5x / 1x / 2x 三个候选里选覆盖真实重音最多的那个（半倍帧歧义必查）。 */
function bestGrid(times, bpm) {
  const candidates = [bpm * 0.5, bpm, bpm * 2].filter((value) => value >= 55 && value <= 210)
  let best = null
  for (const value of candidates) {
    const grid = fitGrid(times, 60 / value)
    if (!grid) continue
    const score = grid.coverage - Math.min(0.5, grid.residualMs / 200)
    if (!best || score > best.score) best = { ...grid, score }
  }
  // 覆盖率太低说明"重音根本不在这条网格上"——宁可报 null，也不要给个假拍子。
  if (!best || best.coverage < 0.45) return null
  return best
}

/**
 * 音源自身的峰值滞后：很多素材的能量峰不在文件头（渐强、前置气口），
 * 按文件头对齐等于晚到。返回秒数，调用方换算成帧再扣。
 */
export function peakLagSeconds(pcm, sampleRate = SAMPLE_RATE) {
  const samples = toSamples(pcm)
  const hop = 256
  const window = 1024
  const count = Math.max(1, Math.floor((samples.length - window) / hop))
  const envelope = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    let sum = 0
    const start = index * hop
    for (let offset = 0; offset < window; offset++) sum += samples[start + offset] ** 2
    envelope[index] = Math.sqrt(sum / window)
  }
  let max = 0
  for (const value of envelope) if (value > max) max = value
  if (max <= 0) return 0
  for (let index = 0; index < count; index++) {
    if (envelope[index] >= max * 0.35) return (index * hop) / sampleRate
  }
  return 0
}

/**
 * 把包络上的重音帧细化到采样级。
 *
 * 能量包络的峰值天然比真实攻击早半个窗（窗口把声音"提前"看见了），
 * 实测能差 20–40ms——在 30fps 下就是 1 帧多，足够毁掉卡点。
 * 这里回到原始采样，找攻击上升沿的第一个显著点。
 */
function refineOnsets(pcm, sampleRate, frames, hop, window) {
  const total = Math.floor(pcm.length / 2)
  const out = []
  for (const frame of frames) {
    const start = Math.max(0, (frame - 2) * hop)
    const end = Math.min(total, (frame + 2) * hop + window)
    let peak = 0
    for (let index = start; index < end; index++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(index * 2) / 32768))
    if (peak <= 0.002) { out.push((frame * hop) / sampleRate); continue }
    let found = -1
    for (let index = start; index < end; index++) {
      if (Math.abs(pcm.readInt16LE(index * 2) / 32768) >= peak * 0.35) { found = index; break }
    }
    out.push(((found >= 0 ? found : frame * hop)) / sampleRate)
  }
  return out
}

export async function analyzeBeats(file, options = {}) {
  const { pcm, sampleRate, hop, window } = await decodePcm(file)
  const { flux, framesPerSecond, seconds, energy } = onsetEnvelope(pcm, sampleRate, hop, window)
  if (!flux.length) return { bpm: null, confidence: 0, beats: [], duration: 0, method: 'onset-flux-v2' }

  const minLag = framesPerSecond * 60 / (options.maxBpm || 200)
  const maxLag = framesPerSecond * 60 / (options.minBpm || 60)
  const { lag, score } = autocorrelation(flux, minLag, maxLag)
  const roughBpm = lag ? (60 * framesPerSecond) / lag : null

  let mean = 0
  for (const value of flux) mean += value
  mean /= flux.length
  let variance = 0
  for (const value of flux) variance += (value - mean) ** 2
  variance /= flux.length
  const threshold = mean + Math.sqrt(variance) * 0.9

  const beats = [], minGap = Math.round(framesPerSecond * (options.minGap || 0.16))
  for (let index = 1; index < flux.length - 1; index++) {
    const value = flux[index]
    if (value < threshold || value < flux[index - 1] || value < flux[index + 1]) continue
    const frame = index
    if (beats.length && frame - beats[beats.length - 1].frame < minGap) {
      if (value > beats[beats.length - 1].strength) beats[beats.length - 1] = { frame, strength: value }
      continue
    }
    beats.push({ frame, strength: value })
  }

  const strengths = beats.map((beat) => beat.strength)
  const strengthMean = strengths.reduce((sum, value) => sum + value, 0) / Math.max(1, strengths.length)
  const contrast = strengthMean > 0 ? Math.min(1, (strengthMean - mean) / (strengthMean || 1)) : 0
  const expected = roughBpm ? Math.max(1, (seconds * roughBpm / 60) * 0.5) : Math.max(1, beats.length)
  const coverage = Math.min(1, beats.length / expected)
  const base = contrast * 0.6 + Math.min(1, score * 4) * 0.4
  const confidence = Math.max(0, Math.min(1, base * (0.3 + 0.7 * coverage)))

  // 拍点太少（氛围铺底、纯音效）时自相关也能凑出一个 BPM，但那是假的：
  // 宁可报 null，也不要让上层拿一个 199 BPM 去对 15 秒里 4 个重音。
  const reliable = beats.length >= 6 && confidence >= 0.35
  const times = refineOnsets(pcm, sampleRate, beats.map((beat) => beat.frame), hop, window)
  const grid = reliable && roughBpm ? bestGrid(times, roughBpm) : null

  // 分频段把重音归类：kick 驱动"被砸"的一拍，snare 驱动"换一件事"，hihat 驱动微动。
  let hits = []
  if (beats.length) {
    const samples = toSamples(pcm)
    const bands = {
      kick: bandEnvelope(samples, sampleRate, 40, 160),
      snare: bandEnvelope(samples, sampleRate, 1200, 3000),
      hihat: bandEnvelope(samples, sampleRate, 6000, 12000),
    }
    hits = beats.map((beat, order) => {
      const index = Math.min(bands.kick.length - 1, Math.round((beat.frame * hop) / hop))
      const kick = bands.kick[index] || 0
      const snare = bands.snare[index] || 0
      const hihat = bands.hihat[index] || 0
      const kind = kick >= snare && kick >= hihat ? 'kick' : snare >= hihat ? 'snare' : 'hihat'
      return { at: Number(times[order].toFixed(3)), strength: round3(beat.strength), kind, kick: round3(kick), snare: round3(snare), hihat: round3(hihat) }
    })
  }

  // 结构表：每 4 拍的 RMS 能量，用来给分镜排"高能段/呼吸位"。
  const structure = []
  if (grid) {
    const barFrames = 4 * grid.period
    for (let at = 0; at + barFrames <= seconds + 0.5; at += barFrames) {
      const from = Math.floor((at * sampleRate) / hop)
      const to = Math.min(energy.length, Math.ceil(((at + barFrames) * sampleRate) / hop))
      let sum = 0, count = 0
      for (let index = from; index < to; index++) { sum += Math.expm1(energy[index]); count += 1 }
      structure.push({ at: Number(at.toFixed(2)), rms: Number((count ? sum / count : 0).toFixed(3)) })
    }
  }

  const peak = beats.length ? Math.max(...strengths) : 0
  return {
    bpm: grid ? Number(grid.bpm.toFixed(2)) : reliable && roughBpm ? Number(roughBpm.toFixed(2)) : null,
    confidence: Number(confidence.toFixed(2)),
    reliable,
    duration: Number(seconds.toFixed(2)),
    grid: grid ? { t0: Number(grid.t0.toFixed(4)), periodMs: Number((grid.period * 1000).toFixed(2)), residualMs: Number(grid.residualMs.toFixed(1)), coverage: Number(grid.coverage.toFixed(2)) } : null,
    peakLag: Number(peakLagSeconds(pcm, sampleRate).toFixed(3)),
    beats: beats.map((beat, order) => ({ at: Number(times[order].toFixed(3)), strength: Number(beat.strength.toFixed(3)) })),
    hits,
    structure,
    strongest: peak,
    method: 'onset-flux-v2',
    note: reliable
      ? (grid && grid.residualMs <= 15 ? '网格残差 ≤15ms，可以按格点卡点' : '残差偏大（可能有变速段），按 hits 的实测时刻卡，别按 BPM 推')
      : '拍点太少，估不出可信 BPM；beats 只当"重音出现的大致位置"，不要硬吸附',
  }
}

function round3(value) {
  return Number(Number(value || 0).toFixed(3))
}

// 把 [start,start+duration] 的切点吸到最近的拍子上，越界就原样返回。
export function snapFrame(frame, beats, fps, tolerance = 4) {
  let best = frame, bestDistance = Infinity
  for (const beat of beats) {
    const target = Math.round(beat.at * fps)
    const distance = Math.abs(target - frame)
    if (distance < bestDistance) { bestDistance = distance; best = target }
  }
  return bestDistance <= tolerance ? best : frame
}

/**
 * 钉帧公式（原版 sound-design §4.6）：
 *   Sequence.from = 目标峰值帧 − 音源峰值滞后帧 − 输出音轨偏移帧
 *
 * 两个偏移都不补时会叠加，实测最重一击晚 0.27s——足够被读成"没卡上"。
 */
// 输出音轨的整体滞后（帧）：AAC 编码器 priming 让成片里的声音比画面晚约 1.3 帧。
// 实测（tmp/test-audio.mjs，120 BPM 点击轨 → 渲染 → 抽回成片音轨量首拍）：
// 源首拍 0.5000s，成片首拍 0.5430s，差 43ms = 1.29 帧@30fps。
// 换帧率按 1.28 折算（原版实测 1.27–1.29）。
export const OUTPUT_AUDIO_OFFSET_F = 1.29

export function pinFrame(targetPeakFrame, sourcePeakLagFrames = 0, outputOffsetFrames = OUTPUT_AUDIO_OFFSET_F) {
  return Math.max(0, Math.round(targetPeakFrame - (sourcePeakLagFrames || 0) - (outputOffsetFrames || 0)))
}
