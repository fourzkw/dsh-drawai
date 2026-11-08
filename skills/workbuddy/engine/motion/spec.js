// 视频节点的唯一数据契约。
//
// 这里只描述"一条视频是什么"，不描述"怎么渲染"。
// 所有工具（wb create / wb preview / wb render / wb status）
// 都从这里取默认值和校验，避免每个入口各写一套规则。

export const MODES = ['api', 'animation']
export const REF_ROLES = ['shot-card', 'image', 'audio']
export const REF_EFFECTS = ['design-only', 'in-frame', 'in-track']

// role 决定 effect 的默认值：镜头卡只是设计参考，图片进画面，音频进轨道。
export const EFFECT_OF_ROLE = { 'shot-card': 'design-only', image: 'in-frame', audio: 'in-track' }

export const LIMITS = {
  width: [256, 1920],
  height: [256, 1920],
  fps: [12, 30],
  duration: [2, 60],
}

export const DEFAULT_SPEC = { width: 1920, height: 1080, fps: 30, duration: 15 }

const clampInt = (value, fallback, [min, max]) => {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

// 时长是唯一允许小数的规格（9.3 秒这种要原样保留，不能四舍五入成 9）。
const clampSeconds = (value, fallback, [min, max]) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.round(Math.min(max, Math.max(min, number)) * 100) / 100
}

function positiveInt(value, fallback) {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

// 节点里存的 motion 字段历史上是"设置 + 运行快照"混在一起。
// 这里只把它读成一个干净的 spec，不改节点。
export function readSpec(motion = {}) {
  const width = clampInt(motion.width, DEFAULT_SPEC.width, LIMITS.width)
  const height = clampInt(motion.height, DEFAULT_SPEC.height, LIMITS.height)
  const fps = clampInt(motion.fps, DEFAULT_SPEC.fps, LIMITS.fps)
  const duration = clampSeconds(motion.duration, DEFAULT_SPEC.duration, LIMITS.duration)
  return {
    mode: MODES.includes(motion.mode) ? motion.mode : 'animation',
    width,
    height,
    fps,
    duration,
    totalFrames: Math.max(1, Math.round(fps * duration)),
  }
}

export function normalizeRef(ref) {
  if (!ref || typeof ref !== 'object') throw new Error('参考项必须是对象')
  const role = REF_ROLES.includes(ref.role) ? ref.role : 'image'
  return {
    id: String(ref.id || ''),
    role,
    effect: REF_EFFECTS.includes(ref.effect) ? ref.effect : EFFECT_OF_ROLE[role],
    assetId: ref.assetId ? String(ref.assetId) : undefined,
    cardId: ref.cardId ? String(ref.cardId) : undefined,
    note: ref.note ? String(ref.note) : undefined,
  }
}

export function readClips(motion = {}) {
  const clips = Array.isArray(motion.clips) ? motion.clips : []
  return clips
    .filter((clip) => clip && typeof clip === 'object')
    .map((clip, index) => ({
      id: String(clip.id || 'clip-' + (index + 1)),
      kind: ['api-shot', 'scene', 'asset'].includes(clip.kind) ? clip.kind : 'scene',
      from: positiveInt(clip.from, 0),
      durationFrames: positiveInt(clip.durationFrames, 1),
    }))
}

export function readRefs(motion = {}) {
  const refs = Array.isArray(motion.refs) ? motion.refs : []
  return refs.map(normalizeRef).filter((ref) => ref.id)
}

// 校验返回**错误列表**而不是抛异常：工具层要一次把问题全列给模型。
export function validateSpec(spec) {
  const errors = []
  if (!MODES.includes(spec.mode)) errors.push('mode 必须是 api 或 animation')
  for (const key of ['width', 'height']) {
    const value = Number(spec[key])
    if (!Number.isInteger(value) || value < LIMITS[key][0] || value > LIMITS[key][1]) errors.push(key + ' 超出 ' + LIMITS[key].join('–'))
    else if (value % 2) errors.push(key + ' 必须是偶数')
  }
  if (!Number.isInteger(spec.fps) || spec.fps < LIMITS.fps[0] || spec.fps > LIMITS.fps[1]) errors.push('fps 超出 ' + LIMITS.fps.join('–'))
  if (!Number.isFinite(spec.duration) || spec.duration < LIMITS.duration[0] || spec.duration > LIMITS.duration[1]) errors.push('duration 超出 ' + LIMITS.duration.join('–') + ' 秒')
  return errors
}

// 把 spec 变成一条可渲染的镜头表：一场景一文件，首尾相接，不重叠。
export function layoutShots(spec, durations) {
  const total = spec.totalFrames
  const list = Array.isArray(durations) && durations.length ? durations : [total]
  let cursor = 0
  return list.map((frames, index) => {
    const durationFrames = Math.max(1, Math.round(frames))
    const shot = { id: 'shot-' + (index + 1), index, startFrame: cursor, durationFrames }
    cursor += durationFrames
    return shot
  })
}
