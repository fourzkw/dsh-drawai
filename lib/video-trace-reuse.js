/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { createHash } from 'node:crypto'
import { TRACE_DEFAULTS, TRACE_FRAGMENT_LEVELS, TRACE_PRESET_NAMES } from './trace-image.js'

// Normalize/validate before an exact-cache lookup: a hit must not bypass validation.
export function videoTraceOptions(raw, manifest, maxBytes) {
  const level = raw.level === undefined ? 'medium' : raw.level
  const preset = raw.preset === undefined ? 'default' : raw.preset
  const colors = raw.colors === undefined ? TRACE_DEFAULTS.colors : Number(raw.colors)
  if (!Object.prototype.hasOwnProperty.call(TRACE_FRAGMENT_LEVELS, level)) throw new Error('未知碎片程度')
  if (!TRACE_PRESET_NAMES.includes(preset)) throw new Error('未知复刻画风')
  if (!Number.isInteger(colors) || colors < 2 || colors > 24) throw new Error('颜色数须在 2–24 之间')
  if (typeof raw.removeBg !== 'boolean') throw new Error('removeBg 必须为 true 或 false')
  return { width: manifest.width, height: manifest.height, level, preset, colors, removeBg: raw.removeBg, maxBytes }
}

export function exactVideoFrameKey(png, optionsKey) {
  // Equal uploaded PNG bytes guarantee equal decoded pixels. Different PNG encodings
  // may miss this conservative cache; they always go through normal decoding.
  return createHash('sha256').update(png).update('\0').update(optionsKey).digest('hex')
}

export function checkVideoPalette(work, foreground, palette) {
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 24 ||
      !palette.every((rgb) => Array.isArray(rgb) && rgb.length === 3 && rgb.every((c) => Number.isInteger(c) && c >= 0 && c <= 255))) {
    return { accepted: false, reason: 'invalid-palette' }
  }
  // Check actual composited/downsampled foreground, not a global gray average.
  // Any new bright/color detail can reject reuse, regardless of its area.
  const seen = new Set()
  for (const pixel of foreground) {
    const at = pixel * 4, r = work[at], g = work[at + 1], b = work[at + 2]
    const key = (r << 16) | (g << 8) | b
    if (seen.has(key)) continue
    let nearest = null, best = Infinity
    for (const rgb of palette) {
      const dr = r - rgb[0], dg = g - rgb[1], db = b - rgb[2]
      const distance = dr * dr + dg * dg + db * db
      if (distance < best) { best = distance; nearest = rgb }
    }
    const dr = r - nearest[0], dg = g - nearest[1], db = b - nearest[2]
    const lumaError = Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db)
    if (lumaError > 8) return { accepted: false, reason: 'brightness-mismatch' }
    if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) > 12) return { accepted: false, reason: 'color-mismatch' }
    // Bounded exact RGB memoization speeds up flat animation without sampling away details.
    if (seen.size < 4096) seen.add(key)
  }
  return { accepted: true, reason: 'fits-foreground' }
}
