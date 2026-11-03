// 镜头卡 → 时间轴：画布上连到视频节点的 shotcard 就是这条片的镜头顺序。
//
// 卡片的 duration 是给人看的自由文本（「约5.6s（168f@30fps）」），
// 所以优先取其中的绝对帧数（**按卡自己的 fps 换算成本工程 fps**），其次秒数，
// 都没有才回落 3 秒。168f@30fps 在 15fps 的工程里是 84 帧，不是 168 帧。

import { layoutShots } from './spec.js'

const FALLBACK_SECONDS = 3
// 卡片配方默认按 30fps 写；文本里没写帧率时才用它。
const CARD_FPS = 30

/** 把「168f@30fps」「5.6s」「约 5.6 秒」统一读成秒。 */
export function cardSeconds(duration) {
  const text = String(duration ?? '')
  const frames = /(\d+(?:\.\d+)?)\s*f(?:rames?)?\b/i.exec(text)
  if (frames) {
    const fpsTag = /@\s*(\d+(?:\.\d+)?)\s*fps/i.exec(text) || /(\d+(?:\.\d+)?)\s*fps/i.exec(text)
    const cardFps = fpsTag ? Number(fpsTag[1]) : CARD_FPS
    return Number(frames[1]) / (cardFps > 0 ? cardFps : CARD_FPS)
  }
  const seconds = /(\d+(?:\.\d+)?)\s*(?:s\b|sec|秒)/i.exec(text)
  if (seconds) return Number(seconds[1])
  return FALLBACK_SECONDS
}

export function cardFrames(duration, fps = 30) {
  return Math.max(1, Math.round(cardSeconds(duration) * (fps || 30)))
}

// 把各段按比例拉到 target 帧，总和精确等于 target（最大余数法）。
function fitDurations(durations, target) {
  const total = durations.reduce((sum, value) => sum + value, 0)
  if (!target || !total || target === total) return durations
  const exact = durations.map((value) => (value * target) / total)
  const out = exact.map((value) => Math.max(1, Math.floor(value)))
  let rest = target - out.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac)
  let cursor = 0
  while (rest > 0) {
    out[order[cursor % order.length].index] += 1
    rest -= 1
    cursor += 1
  }
  while (rest < 0) {
    const biggest = out.indexOf(Math.max(...out))
    if (out[biggest] <= 1) break
    out[biggest] -= 1
    rest += 1
  }
  return out
}

// cards: [{ cardId, styleKey, duration, frames, nodeId }]，顺序即镜头顺序。
// options.fitFrames：显式指定总帧数时，按卡片之间的相对时长等比拉伸。
export function timelineFromCards(spec, cards, options = {}) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : []
  if (!list.length) throw new Error('没有可排布的镜头卡')
  const raw = list.map((card) => (Number.isFinite(card.frames) && card.frames > 0
    ? Math.round(card.frames)
    : cardFrames(card.duration, spec.fps)))
  const fit = Number(options.fitFrames) > 0 ? Math.round(Number(options.fitFrames)) : 0
  const durations = fit ? fitDurations(raw, fit) : raw
  const total = durations.reduce((sum, frames) => sum + frames, 0)
  const shots = layoutShots({ ...spec, totalFrames: total }, durations).map((shot, index) => ({
    id: shot.id,
    file: 'scene-' + index + '.tsx',
    startFrame: shot.startFrame,
    durationFrames: shot.durationFrames,
    card: list[index].cardId,
    style: list[index].styleKey,
  }))
  return { version: 1, width: spec.width, height: spec.height, fps: spec.fps, durationInFrames: total, shots }
}

export function describeCards(cards) {
  return (cards || []).map((card) => card.cardId + (card.styleKey && card.styleKey !== card.cardId ? ' · ' + card.styleKey : ''))
}
