// 渲染规格：把「这一帧怎么变成文件」从散落的默认值里收成一份可校验、可记录、可复现的数据。
//
// 为什么要有这个文件：spec.js 说的是「这条片子是什么」（宽高 / 帧率 / 时长），
// 这里说的是「它怎么落成文件」（编码、色彩标签、超采样、并发、超时）。
// 两者混在一起，就会出现「想渲 3840 再缩 1920」这种根本表达不出来的事。
//
// 读取优先级：timeline.json 的 render → 调用参数 → RENDER_DEFAULTS。
// 越界的值不静默接受，也不让整条渲染失败：夹到边界并把原因写进 warnings，
// 由调用方决定是提示还是拒渲。

export const RENDER_DEFAULTS = {
  codec: 'h264',
  crf: 14,                 // 交付级质量；18 是「看一眼」的档，不是母版
  preset: 'slow',          // renderMedia 的 x264Preset
  pixelFormat: 'yuv420p',
  colorSpace: 'bt709',     // 淡紫底 #EEEAFC 不标 bt709 就会偏色 + 出色带
  scale: 1,                // 2 = 渲 3840 再缩回 1920（超采样），只对成片生效
  concurrency: 2,
  audioBitrate: '320k',
  sampleRate: 48000,
  timeoutMs: 30 * 60 * 1000,
  // 下面两个是场景层参数：插件不执行它们，只记录并把它们交给 scene-kit。
  samples: 1,              // 同帧子渲染次数（GPU 内累积）
  shutter: 0.5,            // 快门开角比例，1 = 360°
}

const LIMITS = {
  codec: ['h264', 'h265', 'vp8', 'vp9'],
  crf: [10, 18],
  preset: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
  pixelFormat: ['yuv420p', 'yuv422p', 'yuv444p'],
  colorSpace: ['bt709', 'bt2020-10', 'bt2020-12'],
  scale: [1, 2],
  concurrency: [1, 4],
  samples: [1, 16],
  shutter: [0, 1],
  timeoutMs: [60000, 6 * 60 * 60 * 1000],
}

const NUMERIC = new Set(['crf', 'scale', 'concurrency', 'samples', 'shutter', 'timeoutMs', 'sampleRate'])

function clean(input) {
  if (!input || typeof input !== 'object') return {}
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''))
}

export function resolveRenderSettings(timeline, overrides = {}) {
  const stored = timeline && typeof timeline.render === 'object' ? timeline.render : {}
  const merged = { ...RENDER_DEFAULTS, ...clean(stored), ...clean(overrides) }
  const warnings = []
  const settings = {}
  for (const key of Object.keys(RENDER_DEFAULTS)) {
    const value = merged[key]
    const limit = LIMITS[key]
    if (!limit) { settings[key] = value; continue }
    if (NUMERIC.has(key)) {
      const number = Number(value)
      if (!Number.isFinite(number)) {
        warnings.push(key + ' 不是数字（' + String(value) + '），用默认 ' + RENDER_DEFAULTS[key])
        settings[key] = RENDER_DEFAULTS[key]
        continue
      }
      if (number < limit[0] || number > limit[1]) {
        const clamped = Math.min(Math.max(number, limit[0]), limit[1])
        warnings.push(key + ' = ' + number + ' 超出允许范围 ' + limit[0] + '–' + limit[1] + '，已夹到 ' + clamped)
        settings[key] = clamped
        continue
      }
      settings[key] = Math.round(number * 1000) / 1000
      continue
    }
    if (!limit.includes(value)) {
      warnings.push(key + ' = ' + String(value) + ' 不在 ' + limit.join('/') + ' 里，用默认 ' + RENDER_DEFAULTS[key])
      settings[key] = RENDER_DEFAULTS[key]
      continue
    }
    settings[key] = value
  }
  // 超采样与累积是相乘的：scale² × samples。两条同时拉满能把单帧成本推到 64 倍，
  // 那时不是「慢一点」，是必然撞超时，所以先算预算再开跑。
  const pixels = Number(timeline?.width || 1920) * Number(timeline?.height || 1080)
  const cost = settings.scale * settings.scale * settings.samples
  const budget = 8 // 等效像素放大倍数的上限（1080p × 8）
  settings.estimatedCost = Math.round(cost * 100) / 100
  if (cost > budget) {
    const suggestSamples = Math.max(1, Math.floor(budget / (settings.scale * settings.scale)))
    warnings.push('scale=' + settings.scale + ' × samples=' + settings.samples + ' 相当于 ' + settings.estimatedCost
      + ' 倍像素工作量（预算 ' + budget + '）；建议 samples 降到 ' + suggestSamples + ' 或关掉超采样')
  }
  settings.pixels = pixels
  settings.warnings = warnings
  return settings
}

// 超时按帧数放大：settings.timeoutMs 是 300 帧整片的预算，
// 样片（几十帧）不该按整片等，长片（1200 帧）也不该被 30 分钟卡死。
export function timeoutFor(settings, frames) {
  const base = Number(settings?.timeoutMs) || RENDER_DEFAULTS.timeoutMs
  const count = Number(frames) || 300
  const scale = Math.max(0.25, Math.min(4, count / 300))
  return Math.round(base * scale)
}

// 写进报告的一行字：出问题时要能一眼看出「这条片子是用什么参数渲的」。
export function describeRenderSettings(settings) {
  const s = settings || RENDER_DEFAULTS
  return [
    s.codec, 'crf=' + s.crf, 'preset=' + s.preset, s.pixelFormat, s.colorSpace,
    'scale=' + s.scale, 'concurrency=' + s.concurrency,
    'audio=' + s.audioBitrate + '/' + Math.round(s.sampleRate / 1000) + 'k',
  ].join(' · ')
}
