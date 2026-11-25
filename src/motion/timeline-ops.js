// 多轨时间轴：工程数据模型与纯函数编辑操作。
//
// 落盘仍是 timeline.json：version 2 起多了 tracks（主镜头轨 + 画面叠加轨），
// shots 继续保留为“场景来源”清单，旧读取方仍能按原来的字段读到镜头文件与时长。
//
// 时间单位一律是整数帧（全片坐标）。音频条目仍在 audio[]，role 决定 UI 上的音轨。
//
// 主镜头轨规则（首版，测试固定）：
//   - tracks[0] 是主镜头轨（role=main），必须按 startFrame 升序、同轨不重叠；
//   - 重排 = 把片段移到新顺序后，从 0 帧重新连续排布，总长不变；
//   - 左裁 = startFrame 右移、inOffset 同步右移；右裁 = durationFrames 缩短；
//   - 裁剪不 ripple：保留空隙，其他片段绝对位置不动；
//   - 分割 = 左段保留原 start/inOffset，右段 start=播放头、inOffset 增加分割点偏移。
//
// 叠加轨（role=overlay）首版只有一条，片段可自由落点；同轨重叠按数组顺序后者盖前者。

export const TIMELINE_VERSION = 2
export const MAIN_TRACK_ID = 'main'
export const OVERLAY_TRACK_ID = 'overlay-1'
export const VIDEO_MIN_DURATION = 2

let clipSequence = 0

/** 浏览器/宿主共用：不依赖 node:crypto，片段 id 只需在单个工程内稳定唯一。 */
export function newClipId(prefix = 'clip') {
  clipSequence += 1
  return prefix + '-' + Date.now().toString(36) + '-' + clipSequence.toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

const integer = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}

export function sourceDurationOf(shot) {
  return Math.max(1, integer(shot?.sourceDurationFrames ?? shot?.durationFrames, 1))
}

function normalizeClip(raw, track, timeline, index) {
  if (!raw || typeof raw !== 'object') throw new Error('轨道 ' + track.id + ' 第 ' + (index + 1) + ' 个片段不是对象')
  const shotId = typeof raw.shotId === 'string' ? raw.shotId : typeof raw.sourceId === 'string' ? raw.sourceId : ''
  if (!shotId) throw new Error('轨道 ' + track.id + ' 第 ' + (index + 1) + ' 个片段缺少 shotId')
  if (!timeline.shots.some((shot) => shot.id === shotId)) throw new Error('片段引用了不存在的场景来源：' + shotId)
  const startFrame = Math.max(0, integer(raw.startFrame ?? raw.start, 0))
  const durationFrames = Math.max(1, integer(raw.durationFrames ?? raw.duration, 1))
  const inOffset = Math.max(0, integer(raw.inOffset, 0))
  const sourceDurationFrames = sourceDurationOf(timeline.shots.find((shot) => shot.id === shotId))
  if (startFrame + durationFrames > timeline.durationInFrames)
    throw new Error('片段超出片长：' + (raw.id || shotId) + '（' + (startFrame + durationFrames) + ' > ' + timeline.durationInFrames + '）')
  if (inOffset >= sourceDurationFrames) throw new Error('片段裁入点超出场景长度：' + (raw.id || shotId))
  // 时长可以超过场景的原始长度：Remotion 场景是帧的纯函数，旁白重排/拉长时按新时长重算
  // （原管线就是这个语义）。sourceDurationFrames 只用来保留右裁后的收尾动画时间。
  const opacity = track.kind === 'video' ? Math.min(1, Math.max(0, Number(raw.opacity ?? 1))) : 1
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newClipId('clip'),
    shotId,
    startFrame,
    durationFrames,
    inOffset,
    ...(track.kind === 'video' ? { opacity } : {}),
  }
}

function normalizeTrack(raw, timeline, index) {
  const role = raw?.role === 'overlay' || raw?.id === OVERLAY_TRACK_ID ? 'overlay' : 'main'
  const kind = raw?.kind === 'audio' ? 'audio' : 'video'
  const track = {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : index === 0 ? MAIN_TRACK_ID : OVERLAY_TRACK_ID,
    name: typeof raw?.name === 'string' && raw.name ? raw.name : role === 'overlay' ? '画面叠加' : '主镜头',
    kind,
    role,
    clips: Array.isArray(raw?.clips) ? raw.clips.map((clip, clipIndex) => normalizeClip(clip, { id: raw.id || MAIN_TRACK_ID, kind, role }, timeline, clipIndex)) : [],
  }
  track.clips.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
  if (track.role === 'main') {
    for (let i = 1; i < track.clips.length; i += 1) {
      const previous = track.clips[i - 1], current = track.clips[i]
      if (previous.startFrame + previous.durationFrames > current.startFrame)
        throw new Error('主镜头轨片段重叠：' + previous.id + ' 与 ' + current.id)
    }
  }
  return track
}

function clipsFromShots(timeline) {
  return timeline.shots.map((shot) => ({
    id: 'clip-' + shot.id,
    shotId: shot.id,
    startFrame: Math.max(0, integer(shot.startFrame, 0)),
    durationFrames: Math.max(1, integer(shot.durationFrames, 1)),
    inOffset: 0,
    opacity: 1,
  }))
}

/**
 * 把任意版本的 timeline 规范成内存模型（不改磁盘）：
 *   - version 1 / 没有 tracks 的旧工程 → 主镜头轨（每个 shot 一个片段）
 *   - 补齐 sourceDurationFrames、opacity、inOffset 等字段
 *   - 确保有一条空的画面叠加轨（仅内存；保存时才落盘）
 *   - shots 的 startFrame/durationFrames 镜像主镜头轨第一个同源片段（兼容旧读取方）
 */
export function normalizeTimeline(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('timeline 必须是对象')
  const timeline = structuredClone(input)
  delete timeline.revision
  if (!Array.isArray(timeline.shots) || timeline.shots.length === 0) throw new Error('timeline.json 缺少 shots')
  timeline.version = TIMELINE_VERSION
  timeline.width = Math.max(1, integer(timeline.width, 1280))
  timeline.height = Math.max(1, integer(timeline.height, 720))
  timeline.fps = Number(timeline.fps) > 0 ? Number(timeline.fps) : 30
  timeline.durationInFrames = Math.max(1, integer(timeline.durationInFrames, 1))
  const shotIds = new Set()
  for (const [index, shot] of timeline.shots.entries()) {
    if (!shot || typeof shot !== 'object') throw new Error('shots 第 ' + (index + 1) + ' 项不是对象')
    if (typeof shot.id !== 'string' || !shot.id) throw new Error('shots 第 ' + (index + 1) + ' 项缺少 id')
    if (shotIds.has(shot.id)) throw new Error('shot.id 重复：' + shot.id)
    shotIds.add(shot.id)
    shot.sourceDurationFrames = sourceDurationOf(shot)
    if (typeof shot.file !== 'string' || !shot.file) shot.file = 'scene-' + index + '.tsx'
    if (!shot.anchors || typeof shot.anchors !== 'object') shot.anchors = {}
  }

  let tracks = Array.isArray(timeline.tracks) && timeline.tracks.length
    ? timeline.tracks.map((track, index) => normalizeTrack(track, timeline, index))
    : [{ id: MAIN_TRACK_ID, name: '主镜头', kind: 'video', role: 'main', clips: clipsFromShots(timeline) }]
  // normalizeTrack 需要 timeline.shots 已经补齐 sourceDurationFrames，所以旧工程要在上面处理完再映射。
  const mainIndex = tracks.findIndex((track) => track.role === 'main')
  if (mainIndex < 0) {
    tracks.unshift({ id: MAIN_TRACK_ID, name: '主镜头', kind: 'video', role: 'main', clips: clipsFromShots(timeline) })
  } else if (mainIndex !== 0) {
    const [main] = tracks.splice(mainIndex, 1)
    tracks.unshift(main)
  }
  if (!tracks.some((track) => track.role === 'overlay')) {
    tracks.push({ id: OVERLAY_TRACK_ID, name: '画面叠加', kind: 'video', role: 'overlay', clips: [] })
  }
  // 只有一条主镜头轨；多余的同 role 轨按叠加处理，避免“两个主轨”这种无法解释的状态。
  for (const track of tracks) if (track !== tracks[0] && track.role === 'main') track.role = 'overlay'
  timeline.tracks = tracks

  const main = tracks[0]
  const firstByShot = new Map()
  for (const clip of main.clips) if (!firstByShot.has(clip.shotId)) firstByShot.set(clip.shotId, clip)
  for (const shot of timeline.shots) {
    const clip = firstByShot.get(shot.id)
    if (clip) {
      shot.startFrame = clip.startFrame
      shot.durationFrames = clip.durationFrames
    }
  }
  if (!Array.isArray(timeline.audio)) timeline.audio = []
  return timeline
}

export function mainTrackOf(timeline) {
  return normalizeTimeline(timeline).tracks[0]
}

export function mainClipsOf(timeline) {
  return normalizeTimeline(timeline).tracks[0].clips
}

export function overlayTracksOf(timeline) {
  return normalizeTimeline(timeline).tracks.slice(1)
}

export function sourceOf(timeline, shotId) {
  const shot = timeline.shots.find((item) => item.id === shotId)
  if (!shot) throw new Error('找不到场景来源：' + shotId)
  return shot
}

export function clipById(timeline, clipId) {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((item) => item.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

export function clipEnd(clip) {
  return clip.startFrame + clip.durationFrames
}

/** 主镜头轨的“剪辑视图”：每个片段带上场景来源字段，供 QA / 导出 / 旁白按时间定位。 */
export function editShotsOf(timeline) {
  const normalized = normalizeTimeline(timeline)
  return normalized.tracks[0].clips.map((clip) => {
    const source = sourceOf(normalized, clip.shotId)
    return {
      ...source,
      id: clip.id,
      shotId: clip.shotId,
      sourceId: clip.shotId,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      inOffset: clip.inOffset,
      opacity: clip.opacity,
      sourceDurationFrames: sourceDurationOf(source),
    }
  })
}

/** 时间轴上的所有片段（渲染/预览用），按轨道从下到上排列。 */
export function allClipsOf(timeline) {
  const normalized = normalizeTimeline(timeline)
  return normalized.tracks.flatMap((track, layer) => track.clips.map((clip) => ({
    ...clip, trackId: track.id, trackName: track.name, layer, role: track.role, kind: track.kind,
    source: sourceOf(normalized, clip.shotId),
  })))
}

export function addOverlayClip(timeline, { shotId, startFrame, durationFrames, inOffset = 0, opacity = 1 }) {
  const next = normalizeTimeline(timeline)
  const source = sourceOf(next, shotId)
  const overlay = next.tracks.find((track) => track.role === 'overlay')
  const start = Math.max(0, Math.min(integer(startFrame, 0), next.durationInFrames - 1))
  const duration = Math.max(1, Math.min(integer(durationFrames, 1), next.durationInFrames - start))
  const offset = Math.max(0, Math.min(integer(inOffset, 0), Math.max(0, sourceDurationOf(source) - 1)))
  const clip = { id: newClipId('overlay'), shotId, startFrame: start, durationFrames: Math.min(duration, sourceDurationOf(source) - offset), inOffset: offset, opacity: Math.min(1, Math.max(0, Number(opacity))) }
  overlay.clips.push(clip)
  overlay.clips.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
  return next
}

/** 重排主镜头：移到 toIndex 后从 0 帧连续排布，总长不变。 */
export function reorderMainClip(timeline, clipId, toIndex) {
  const next = normalizeTimeline(timeline)
  const track = next.tracks[0]
  const from = track.clips.findIndex((clip) => clip.id === clipId)
  if (from < 0) throw new Error('找不到片段：' + clipId)
  const [clip] = track.clips.splice(from, 1)
  const to = Math.max(0, Math.min(track.clips.length, Math.round(Number(toIndex) || 0)))
  track.clips.splice(to, 0, clip)
  let cursor = 0
  for (const item of track.clips) {
    item.startFrame = cursor
    cursor += item.durationFrames
  }
  if (cursor > next.durationInFrames) throw new Error('重排后超出片长：' + cursor + ' > ' + next.durationInFrames)
  return next
}

/** 在 clipId 的播放头处分割；返回 null 表示播放头不在片段内部。 */
export function splitClipAt(timeline, clipId, frame) {
  const next = normalizeTimeline(timeline)
  const hit = clipById(next, clipId)
  if (!hit) throw new Error('找不到片段：' + clipId)
  const at = integer(frame, 0)
  const local = at - hit.clip.startFrame
  if (local <= 0 || local >= hit.clip.durationFrames) return null
  const source = sourceOf(next, hit.clip.shotId)
  if (hit.clip.inOffset >= sourceDurationOf(source)) return null
  if (hit.clip.inOffset + local >= sourceDurationOf(source)) return null
  const right = {
    ...structuredClone(hit.clip),
    id: newClipId(hit.track.role === 'overlay' ? 'overlay' : 'clip'),
    startFrame: at,
    durationFrames: hit.clip.durationFrames - local,
    inOffset: hit.clip.inOffset + local,
  }
  hit.clip.durationFrames = local
  const index = hit.track.clips.indexOf(hit.clip)
  hit.track.clips.splice(index + 1, 0, right)
  hit.track.clips.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
  return next
}

/**
 * 拖动片段边缘。
 * edge='left'：保持右端不动，start/inOffset 一起右移（可回到更早的源帧）；
 * edge='right'：保持左端不动，只改长度。
 */
export function trimClipAt(timeline, clipId, edge, frame) {
  const next = normalizeTimeline(timeline)
  const hit = clipById(next, clipId)
  if (!hit) throw new Error('找不到片段：' + clipId)
  const source = sourceOf(next, hit.clip.shotId)
  const sourceDuration = sourceDurationOf(source)
  const at = integer(frame, 0)
  const right = hit.clip.startFrame + hit.clip.durationFrames
  const index = hit.track.clips.indexOf(hit.clip)
  const previousClip = hit.track.role === 'main' ? hit.track.clips[index - 1] : null
  const nextClip = hit.track.role === 'main' ? hit.track.clips[index + 1] : null
  if (edge === 'left') {
    const minStart = previousClip ? previousClip.startFrame + previousClip.durationFrames : 0
    let start = Math.max(minStart, Math.min(at, right - VIDEO_MIN_DURATION))
    if (hit.clip.inOffset + (start - hit.clip.startFrame) < 0) start = hit.clip.startFrame - hit.clip.inOffset
    const finalDelta = start - hit.clip.startFrame
    const duration = right - start
    if (duration < VIDEO_MIN_DURATION) throw new Error('片段太短')
    if (hit.clip.inOffset + finalDelta >= sourceDuration) throw new Error('左裁超出场景素材长度')
    hit.clip.startFrame = start
    hit.clip.durationFrames = duration
    hit.clip.inOffset = hit.clip.inOffset + finalDelta
  } else {
    const maxEnd = Math.min(
      nextClip ? nextClip.startFrame : next.durationInFrames,
      hit.clip.startFrame + (sourceDuration - hit.clip.inOffset),
    )
    const end = Math.max(hit.clip.startFrame + VIDEO_MIN_DURATION, Math.min(at, maxEnd))
    const duration = end - hit.clip.startFrame
    hit.clip.durationFrames = duration
  }
  return next
}

export function moveClipAt(timeline, clipId, startFrame) {
  const next = normalizeTimeline(timeline)
  const hit = clipById(next, clipId)
  if (!hit) throw new Error('找不到片段：' + clipId)
  if (hit.track.role === 'main') throw new Error('主镜头轨请用重排，不要自由拖动')
  const start = Math.max(0, Math.min(integer(startFrame, 0), next.durationInFrames - hit.clip.durationFrames))
  hit.clip.startFrame = start
  hit.track.clips.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
  return next
}

export function updateClipAt(timeline, clipId, patch = {}) {
  const next = normalizeTimeline(timeline)
  const hit = clipById(next, clipId)
  if (!hit) throw new Error('找不到片段：' + clipId)
  if (patch.opacity !== undefined) hit.clip.opacity = Math.min(1, Math.max(0, Number(patch.opacity)))
  if (patch.inOffset !== undefined) hit.clip.inOffset = Math.max(0, integer(patch.inOffset, hit.clip.inOffset))
  if (patch.durationFrames !== undefined) {
    const duration = Math.max(VIDEO_MIN_DURATION, integer(patch.durationFrames, hit.clip.durationFrames))
    hit.clip.durationFrames = Math.min(duration, next.durationInFrames - hit.clip.startFrame)
  }
  if (patch.startFrame !== undefined) {
    const start = Math.max(0, integer(patch.startFrame, hit.clip.startFrame))
    hit.clip.startFrame = Math.min(start, Math.max(0, next.durationInFrames - hit.clip.durationFrames))
  }
  hit.track.clips.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
  return next
}

export function removeClip(timeline, clipId) {
  const next = normalizeTimeline(timeline)
  for (const track of next.tracks) track.clips = track.clips.filter((clip) => clip.id !== clipId)
  return next
}

/** 主镜头轨重排时的目标下标：按片段中线判断。 */
export function mainReorderIndex(timeline, xFrame, excludeId) {
  const clips = mainClipsOf(timeline).filter((clip) => clip.id !== excludeId)
  let index = 0
  for (const clip of clips) {
    const middle = clip.startFrame + clip.durationFrames / 2
    if (xFrame >= middle) index += 1
  }
  return index
}

/** 去掉派生字段，得到可安全回传/写盘的时间轴。 */
export function serializeTimeline(timeline) {
  const next = normalizeTimeline(timeline)
  delete next.revision
  if (next.sync && typeof next.sync === 'object') {
    next.sync = structuredClone(next.sync)
    delete next.sync.resolved
  }
  return next
}

export function validateTimeline(timeline) {
  const errors = []
  try {
    const normalized = normalizeTimeline(timeline)
    const main = normalized.tracks[0]
    let cursor = -1
    for (const clip of main.clips) {
      if (clip.startFrame < cursor) errors.push('主镜头轨片段重叠：' + clip.id)
      cursor = clip.startFrame + clip.durationFrames
    }
    for (const track of normalized.tracks) {
      const ids = new Set()
      for (const clip of track.clips) {
        if (ids.has(clip.id)) errors.push('片段 id 重复：' + clip.id)
        ids.add(clip.id)
      }
    }
  } catch (error) {
    errors.push(error.message || String(error))
  }
  return errors
}

/** 给工作台/预览用的场景来源清单（去重）。 */
export function uniqueSources(timeline) {
  const normalized = normalizeTimeline(timeline)
  const seen = new Map()
  for (const shot of normalized.shots) {
    if (!seen.has(shot.id)) seen.set(shot.id, shot)
  }
  return [...seen.values()]
}
