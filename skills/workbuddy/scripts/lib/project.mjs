// 工程侧共用逻辑：规格、分镜表、镜头卡、整片风格、工程概览。
// 这些在插件里都是画布节点的数据；命令行版改成文件 + 参数，但语义完全照搬。

import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { num } from './cli.mjs'

const DEFAULT_SPEC = { width: 1920, height: 1080, fps: 30, duration: 15 }
const ASPECTS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
}

/** `1920x1080@30`、`1080x1920@24/12s`、`9:16` 三种写法都认。 */
export function parseSpec(raw) {
  const text = String(raw || '').trim()
  if (!text) return {}
  if (ASPECTS[text]) {
    const [width, height] = ASPECTS[text]
    return { width, height }
  }
  const match = text.match(/^(\d{2,4})\s*[x×*]\s*(\d{2,4})(?:@(\d{1,2})(?:fps)?)?(?:\s*\/\s*(\d+(?:\.\d+)?)\s*s?)?$/i)
  if (!match) throw new Error('--spec 读不出来：' + text + '\n写成 `1920x1080@30` 或 `9:16`，时长单独用 --duration 秒。')
  const spec = { width: Number(match[1]), height: Number(match[2]) }
  if (match[3]) spec.fps = Number(match[3])
  if (match[4]) spec.duration = Number(match[4])
  return spec
}

/**
 * 规格优先级：显式 --spec/--duration > 分镜表的帧区间总和 > 风格节奏 > 默认 1920×1080@30/15s。
 * 分镜表优先于风格：表是"每一镜要干什么"的真相源，片的长度不该被风格偷偷改掉。
 */
export function resolveSpec(flags, { storyboard = null, style = null } = {}) {
  const explicit = parseSpec(flags.spec)
  const rhythm = style && style.rhythm ? style.rhythm : {}
  const rhythmSpec = {}
  if (rhythm.fps) rhythmSpec.fps = Number(rhythm.fps)
  if (rhythm.duration) rhythmSpec.duration = Number(rhythm.duration)
  if (rhythm.aspect && ASPECTS[rhythm.aspect]) {
    const [width, height] = ASPECTS[rhythm.aspect]
    rhythmSpec.width = width
    rhythmSpec.height = height
  }
  const base = { ...DEFAULT_SPEC, ...rhythmSpec, ...explicit }
  if (flags.aspect && ASPECTS[flags.aspect]) {
    const [width, height] = ASPECTS[flags.aspect]
    base.width = width
    base.height = height
  }
  const durationGiven = num(flags.duration, undefined) !== undefined || explicit.duration !== undefined
  let duration = num(flags.duration, base.duration)
  // 分镜表每行都写了时长时，全片长度就是各行之和。
  if (!durationGiven && storyboard && storyboard.rows.length >= 2 && storyboard.rows.every((row) => Number(row.durationFrames) > 0)) {
    duration = Math.round(storyboard.rows.reduce((sum, row) => sum + Number(row.durationFrames), 0) / (base.fps || 30) * 100) / 100
  }
  return {
    mode: 'animation',
    width: Math.round(base.width),
    height: Math.round(base.height),
    fps: Math.round(base.fps),
    duration,
    totalFrames: Math.max(1, Math.round((base.fps || 30) * duration)),
    durationGiven,
    fitFrames: durationGiven ? Math.max(1, Math.round((base.fps || 30) * duration)) : 0,
  }
}

/** `--style` 的整片风格包；给错 slug 时把可选项列出来。 */
export async function resolveStyle(slug) {
  if (!slug) return null
  const { mgStyleKit, mgStyleCatalog } = await import('../engine/motion-library.js')
  try {
    return mgStyleKit({ slug: String(slug) })
  } catch (error) {
    const slugs = mgStyleCatalog.styles.map((style) => style.slug + '（' + style.name + '）').join('、')
    throw new Error('没有这个整片风格：' + slug + '\n可选：' + slugs)
  }
}

/**
 * 分镜表：CLI 版读工程里的 storyboard.md（或 --storyboard 指定的文件）。
 * 解析器与画布【分镜表】节点是同一份（engine/motion/canvas-spec.js）。
 */
export async function readStoryboard(flags, { dir = process.cwd(), fps = 30 } = {}) {
  const { parseStoryboard } = await engineCanvasSpec()
  const raw = flags.storyboard
  if (raw === undefined) {
    const fallback = join(dir, 'storyboard.md')
    if (!existsSync(fallback)) return null
    return parseFile(fallback, fps)
  }
  if (raw === false || raw === 'none') return null
  const file = isAbsolute(String(raw)) ? String(raw) : resolve(process.cwd(), String(raw))
  if (!existsSync(file)) throw new Error('找不到分镜表文件：' + file)
  return parseFile(file, fps)

  function parseFile(file, rate) {
    const text = readFileSync(file, 'utf8')
    const { rows, problems } = parseStoryboard(text, { fps: rate })
    return { rows, problems, file, name: basename(file) }
  }
}

async function engineCanvasSpec() {
  return import('../engine/motion/canvas-spec.js')
}

/**
 * 镜头卡：`--cards "assemble-then-type-flyin:assemble-then-type-flyin,..."`。
 * 只写卡名时，卡上只有一个样式才自动选中（和画布节点行为一致）。
 */
export async function resolveCards(raw) {
  if (raw === undefined || raw === false) return []
  const { shotCardCatalog } = await import('../engine/motion-library.js')
  const list = (Array.isArray(raw) ? raw : [raw]).flatMap((item) => String(item).split(/[,;\s]+/)).filter(Boolean)
  return list.map((token) => {
    const [cardId, styleKey] = token.split(':')
    const card = shotCardCatalog.cards.find((item) => item.id === cardId)
    if (!card) throw new Error('没有这张镜头卡：' + cardId + '\n用 `wb card search <关键词>` 找，或 `wb card list` 看全部。')
    let style = null
    if (styleKey) {
      style = card.styles.find((item) => item.key === styleKey)
      if (!style) throw new Error('镜头卡 ' + cardId + ' 没有样式 ' + styleKey + '，可选：' + card.styles.map((item) => item.key).join('、'))
    } else if (card.styles.length === 1) {
      style = card.styles[0]
    } else {
      throw new Error('镜头卡 ' + cardId + ' 有 ' + card.styles.length + ' 个样式，必须指定：' + card.styles.map((item) => card.id + ':' + item.key).join('、'))
    }
    return { cardId: card.id, styleKey: style.key, duration: style.duration || card.duration, frames: num(style.frames, undefined) }
  })
}

/** 工程概览：时间轴、镜头、音轨、字幕、主题、风格。 */
export async function projectSummary(dir) {
  const { readTimeline } = await import('../engine/motion/project.js')
  const timeline = readTimeline(dir)
  const fps = timeline.fps || 30
  const shots = (timeline.shots || []).map((shot, index) => ({
    index: index + 1,
    id: shot.id,
    file: shot.file,
    startFrame: shot.startFrame,
    durationFrames: shot.durationFrames,
    startSeconds: Math.round(shot.startFrame / fps * 100) / 100,
    seconds: Math.round(shot.durationFrames / fps * 100) / 100,
    card: shot.card || (shot.motionCards || []).map((item) => item.cardId + ':' + item.styleKey).join(' ') || '',
  }))
  return {
    dir,
    width: timeline.width,
    height: timeline.height,
    fps,
    durationInFrames: timeline.durationInFrames,
    seconds: Math.round((timeline.durationInFrames / fps) * 100) / 100,
    shots,
    style: timeline.style?.slug || null,
    title: timeline.title || timeline.name || null,
    audio: (timeline.audio || []).map((cue) => ({
      id: cue.id, file: cue.file, role: cue.role,
      at: Math.round((cue.from / fps) * 100) / 100,
      seconds: Math.round((cue.durationInFrames / fps) * 100) / 100,
      gainDb: cue.gainDb, loop: !!cue.loop, duck: !!cue.duck,
    })),
    subtitles: (timeline.subtitles || []).length,
    sync: timeline.sync ? { musicCueId: timeline.sync.musicCueId, anchors: (timeline.sync.anchors || []).length, toleranceFrames: timeline.sync.toleranceFrames } : null,
  }
}


// ── 配色可读性 ──────────────────────────────────────────────────────
// 风格色板是上游从 demo 里抠出来的，偶尔会把「舞台底色」写进 page（19-paperclip 就是：
// page #1D2731 与 text #25313D 只有 1.14:1，场景按 PAPER 铺底、INK 写字会直接看不见）。
// 建工程时量一次；真不行就把 page 换成 surface，并说明为什么。
function channelLuminance(hex) {
  const text = String(hex || '').replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null
  const parts = [0, 2, 4].map((offset) => parseInt(text.slice(offset, offset + 2), 16) / 255)
  const linear = parts.map((value) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** WCAG 对比度；任一颜色不是 6 位 hex 就返回 null（不猜）。 */
export function contrastRatio(foreground, background) {
  const a = channelLuminance(foreground)
  const b = channelLuminance(background)
  if (a === null || b === null) return null
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** 给一套色板量 page/text；太糊就换 surface 当纸色，返回 {palette, note}。 */
export function readablePalette(palette) {
  if (!palette || !palette.page || !palette.text) return { palette, note: null }
  const ratio = contrastRatio(palette.page, palette.text)
  if (ratio === null || ratio >= 3) return { palette, note: null }
  const alternative = palette.surface && contrastRatio(palette.surface, palette.text) >= 4.5 ? palette.surface : null
  if (!alternative) {
    return { palette, note: '这套风格的 page/text 对比度只有 ' + ratio.toFixed(2) + ':1：场景里别用 PAPER 当底、INK 当字，或者用 --tokens 换一套色。' }
  }
  return {
    palette: { ...palette, page: alternative },
    note: '这套风格的色板把舞台底色写进了 page（page/text 对比度 ' + ratio.toFixed(2) + ':1），theme 的 page 已换成 surface ' + alternative + '；STYLE.md 保留上游原色板，要原样就用 --tokens 覆盖。',
  }
}
