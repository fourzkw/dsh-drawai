/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { isShotCardNode } from './shotcard-core.js'
/* Serializable motion documents shared by the host and canvas. Scene sources are rendered only by the worker. */
export const MOTION_VERSION = 1
export const MOTION_ROLES = ['material', 'copy', 'instruction', 'style', 'layout', 'shotcard', 'audio']
const motionClone = (value) => JSON.parse(JSON.stringify(value))
const motionStable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)

export function motionSettings(raw = {}) {
  const integer = (value, fallback, min, max) => {
    const n = value === undefined ? fallback : Number(value)
    if (!Number.isInteger(n) || n < min || n > max) throw new Error('无效的动效尺寸、帧率或时长')
    return n
  }
  if (raw.mode !== undefined && raw.mode !== 'scene') throw new Error('仅支持 Shotcraft 场景创作')
  if (raw.preferredCards !== undefined && (!Array.isArray(raw.preferredCards) || raw.preferredCards.length > 6 || raw.preferredCards.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)))) throw new Error('最多选择 6 张镜头参考卡')
  const fps = integer(raw.fps, 30, 12, 30)
  const duration = Number(raw.duration ?? 12)
  if (!Number.isFinite(duration) || duration < 2 || duration > 60) throw new Error('无效的动效尺寸、帧率或时长')
  if(raw.audioMode!==undefined&&!['auto','manual','off'].includes(raw.audioMode))throw new Error('未知声音制作模式')
  if(raw.audioPlan!==undefined&&(!raw.audioPlan||typeof raw.audioPlan!=='object'||Array.isArray(raw.audioPlan)||JSON.stringify(raw.audioPlan).length>100000))throw new Error('声音时间表无效或过大')
  return { prompt: String(raw.prompt || '').trim().slice(0, 12000), mode: 'scene',
    ...(raw.audioMode?{audioMode:raw.audioMode}:{}),...(raw.audioPrompt!==undefined?{audioPrompt:String(raw.audioPrompt).slice(0,5000)}:{}),...(raw.audioPlan?{audioPlan:motionClone(raw.audioPlan)}:{}),
    ...(raw.preferredCards ? { preferredCards: [...new Set(raw.preferredCards)] } : {}),
    width: integer(raw.width, 1280, 256, 1920), height: integer(raw.height, 720, 256, 1920),
    fps, duration: Math.round(duration * fps) / fps }
}

// Explicit tool settings override stored values; rendering always uses whole frames.
export function mergeMotionSettings(current, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings 必须是设置对象')
  if (Object.keys(patch).some((key) => !['width', 'height', 'fps', 'duration', 'totalFrames', 'audioMode', 'audioPrompt', 'audioPlan'].includes(key))) throw new Error('未知视频设置字段')
  const { totalFrames, ...values } = patch
  const next = motionSettings({ ...current, ...values })
  if (totalFrames !== undefined) {
    if (!Number.isInteger(totalFrames) || totalFrames < next.fps * 2 || totalFrames > next.fps * 60) throw new Error('totalFrames 必须为 2–60 秒范围内的整数帧数')
    if (patch.duration !== undefined && Math.round(Number(patch.duration) * next.fps) !== totalFrames) throw new Error('duration 与 totalFrames 冲突')
    next.duration = totalFrames / next.fps
  }
  return { ...current, ...next }
}

export function isMotionNode(node) { return node?.data?.drawaiMotion === '1' }
export function isAudioNode(node) { return node?.data?.drawaiAudio === '1' }
export function audioNodeData(role = 'sfx') {
  if (!['sfx','bgm','voice'].includes(role)) throw new Error('未知音频用途')
  return { drawaiAudio:'1',audioRole:role,audioGainDb:role==='bgm'?'-14':'0',audioTrimStart:'0',audioTrimEnd:'0',audioAt:'0',audioFadeIn:role==='bgm'?'0.3':'0',audioFadeOut:role==='bgm'?'0.5':'0',audioLoop:'0' }
}
export function audioNodeSettings(data) {
  const number=(key,fallback,min,max)=>{const value=Number(data[key]??fallback);if(!Number.isFinite(value)||value<min||value>max)throw new Error('无效音频设置：'+key);return value}
  const role=data.audioRole||'sfx'
  if(!['sfx','bgm','voice'].includes(role))throw new Error('未知音频用途')
  const settings={role,gainDb:number('audioGainDb',role==='bgm'?-14:0,-60,18),trimStart:number('audioTrimStart',0,0,600),trimEnd:number('audioTrimEnd',0,0,600),
    at:number('audioAt',0,0,60),fadeIn:number('audioFadeIn',0,0,60),fadeOut:number('audioFadeOut',0,0,60),loop:data.audioLoop==='1'}
  if(settings.trimEnd && settings.trimEnd<=settings.trimStart)throw new Error('音频裁切结束必须晚于开始')
  return settings
}

export function validateAudioTimeline(raw,composition,input) {
  if(!raw)return {version:1,cues:[],notes:[]}
  if(!Array.isArray(raw.cues)||raw.cues.length>64)throw new Error('声音时间表最多64条')
  const fps=composition.fps,total=composition.durationFrames
  const cues=raw.cues.map((cue,index)=>{
    const ref=input.refs.find(ref=>ref.id===cue.referenceId&&ref.role==='audio')
    if(!ref)throw new Error('音频来源不存在：'+cue.referenceId)
    const node=ref.nodes.find(isAudioNode),defaults=audioNodeSettings(node?.data||{})
    const shot=cue.shotId?composition.shots.find(shot=>shot.id===cue.shotId):null
    if(cue.shotId&&!shot)throw new Error('音频引用未知镜头')
    const offset=Number(cue.offsetFrames??0),from=(shot?.startFrame||0)+offset
    const duration=Number(cue.durationFrames??Math.min(total-from,shot?.durationFrames||total))
    const gainDb=Number(cue.gainDb??defaults.gainDb),trimStart=Number(cue.trimStart??defaults.trimStart)
    const fadeIn=Number(cue.fadeIn??defaults.fadeIn),fadeOut=Number(cue.fadeOut??defaults.fadeOut)
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(duration)||duration<1||from+duration>total||from>=total||!Number.isFinite(gainDb)||gainDb< -60||gainDb>18||!Number.isFinite(trimStart)||trimStart<0||trimStart>600||![fadeIn,fadeOut].every(value=>Number.isFinite(value)&&value>=0&&value<=duration/fps))throw new Error('音频时间、增益或淡入淡出无效：'+(index+1))
    return {id:'cue-'+(index+1),referenceId:ref.id,role:defaults.role,...(shot?{shotId:shot.id}:{}),offsetFrames:offset,from,durationFrames:duration,
      trimStart,gainDb,fadeIn,fadeOut,loop:cue.loop===undefined?defaults.loop:cue.loop===true,action:String(cue.action||'').slice(0,600)}
  })
  return {version:1,cues,notes:Array.isArray(raw.notes)?raw.notes.map(String).slice(0,12):[]}
}
export function motionNodeData() {
  return { drawaiMedia: '1', drawaiMotion: '1', motion: { version: MOTION_VERSION, ...motionSettings(), mode: 'scene', results: [] } }
}

// Incoming canvas arrows are the reference connections, including existing untagged edges.
export function motionReferenceEdges(doc, nodeId) {
  const seen = new Set()
  return doc.edges.filter((edge) => {
    if (edge.to !== nodeId || seen.has(edge.from)) return false
    seen.add(edge.from)
    return true
  })
}

export function motionReferenceRole(doc, edge) {
  if (isAudioNode(doc.nodes.find((item) => item.id === edge.from))) return 'audio'
  if (isShotCardNode(doc.nodes.find((item) => item.id === edge.from))) return 'shotcard'
  if (edge.data?.motionReference?.role !== undefined) return edge.data.motionReference.role
  const node = doc.nodes.find((item) => item.id === edge.from)
  const style = node?.style || ''
  if (/(?:^|;)text(?:=[^;]*)?(?:;|$)/.test(style)) return 'copy'
  if (/(?:^|;)(?:group(?:=[^;]*)?|container=1)(?:;|$)/.test(style) || doc.nodes.some((item) => item.parent === edge.from)) return 'layout'
  return 'material'
}

export function bindMotionReference(doc, sourceId, targetId, role = 'material', edgeId) {
  const source = doc.nodes.find((node) => node.id === sourceId), target = doc.nodes.find((node) => node.id === targetId)
  if (!source || !isMotionNode(target) || sourceId === targetId) throw new Error('请选择有效的来源和目标视频节点')
  assertMotionEditable(doc, targetId)
  if (!MOTION_ROLES.includes(role)) throw new Error('未知参考用途')
  const seen = new Set()
  function reaches(id) {
    if (id === sourceId) return true
    if (seen.has(id)) return false
    seen.add(id)
    return doc.edges.some((edge) => (edge.data?.motionReference || isMotionNode(doc.nodes.find((item) => item.id === edge.to))) && edge.from === id && reaches(edge.to))
  }
  if (reaches(targetId)) throw new Error('生成参考不能形成循环')
  const existing = doc.edges.find((edge) => edge.from === sourceId && edge.to === targetId && edge.data?.motionReference)
  if (existing) { existing.data.motionReference.role = role; return existing }
  if (!edgeId || doc.nodes.concat(doc.edges, doc.layers || []).some((item) => item.id === edgeId)) throw new Error('参考连线 ID 无效或冲突')
  const edge = { id: edgeId, from: sourceId, to: targetId, label: '',
    style: 'dashed=1;strokeColor=#7c6df2;endArrow=open;', data: { motionReference: { role } } }
  if (target.layer || doc.layers?.[0]?.id) edge.layer = target.layer || doc.layers[0].id
  doc.edges.push(edge)
  if (Array.isArray(doc.drawOrder)) doc.drawOrder.unshift(edge.id)
  return edge
}

export function motionInput(doc, nodeId) {
  const node = doc.nodes.find((item) => item.id === nodeId)
  if (!isMotionNode(node)) throw new Error('目标不是动效视频节点')
  const settings = motionSettings(node.data.motion)
  if (!settings.prompt) throw new Error('请先描述要生成的视频')
  const visiting = new Set(), visited = new Set()
  function visit(id) {
    if (visiting.has(id)) throw new Error('生成参考不能形成循环')
    if (visited.has(id)) return
    visiting.add(id)
    for (const edge of motionReferenceEdges(doc, id)) if (isMotionNode(doc.nodes.find((item) => item.id === id)) || edge.data?.motionReference) visit(edge.from)
    visiting.delete(id); visited.add(id)
  }
  visit(nodeId)
  const refs = motionReferenceEdges(doc, nodeId).map((edge) => {
    const root = doc.nodes.find((item) => item.id === edge.from)
    if (!root) throw new Error('参考素材已删除')
    const role = motionReferenceRole(doc, edge)
    if (!MOTION_ROLES.includes(role)) throw new Error('参考用途无效')
    const ids = new Set([root.id])
    for (let i = 0; i < doc.nodes.length; i++) for (const item of doc.nodes) if (ids.has(item.parent)) ids.add(item.id)
    if (ids.has(nodeId)) throw new Error('参考分组不能包含目标视频')
    const nodes = doc.nodes.filter((item) => ids.has(item.id)).map((item) => {
      const data = { ...(item.data || {}) }; delete data.motion
      return { id: item.id, label: item.label || '', style: item.style || '', x: item.x, y: item.y, w: item.w, h: item.h, parent: item.parent, data }
    })
    return { id: root.id, role, nodes, edges: doc.edges.filter((item) => ids.has(item.from) && ids.has(item.to) && !item.data?.motionReference) }
  })
  if (refs.length > 24 || refs.reduce((n, ref) => n + ref.nodes.length, 0) > 200) throw new Error('每次最多使用 24 组参考、200 个元素')
  return { version: MOTION_VERSION, nodeId, settings, refs }
}

export function motionInputKey(input) {
  const text = motionStable(input), words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
  for (let i = 0; i < text.length; i++) for (let n = 0; n < words.length; n++) words[n] = Math.imul(words[n] ^ text.charCodeAt(i), 16777619 + n * 2) >>> 0
  return words.map((word) => word.toString(16).padStart(8, '0')).join('')
}

export function validateMotionPlan(raw, input) {
  if (!raw || !Array.isArray(raw.shots) || !raw.shots.length || raw.shots.length > 24) throw new Error('分镜需要 1–24 个镜头')
  const total = Math.round(input.settings.fps * input.settings.duration), ids = new Set(input.refs.map((ref) => ref.id))
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback
  const shots = raw.shots.map((shot, index) => {
    if (shot.recipeId !== 'scene') throw new Error('不支持的场景类型：' + shot.recipeId)
    if (shot.recipeId === 'scene' && (typeof shot.sceneSource !== 'string' || shot.sceneSource.length < 20 || shot.sceneSource.length > 100000)) throw new Error('场景源码需要 20–100000 字符')
    if (shot.sceneComponents !== undefined && (!Array.isArray(shot.sceneComponents) || shot.sceneComponents.length > 12)) throw new Error('每个镜头最多 12 个场景组件')
    const componentIds = new Set()
    const sceneComponents = (shot.sceneComponents || []).map((component) => {
      if (!component || !/^[A-Z][A-Za-z0-9]{0,47}$/.test(component.id) || componentIds.has(component.id)) throw new Error('场景组件名称无效或重复')
      if (typeof component.source !== 'string' || component.source.length < 20 || component.source.length > 100000) throw new Error('组件源码需要 20–100000 字符')
      componentIds.add(component.id)
      return { id: component.id, description: String(component.description || '').slice(0, 4000), source: component.source }
    })
    const start = Number(shot.startFrame), duration = Number(shot.durationFrames)
    if (!Number.isInteger(start) || !Number.isInteger(duration) || start < 0 || duration < 1 || start + duration > total) throw new Error('镜头时间超出成片范围')
    // A linked shot card is a motion constraint, never an image asset. Recover
    // this unambiguous director mistake while still rejecting fabricated IDs.
    const refs = (Array.isArray(shot.referenceIds) ? [...new Set(shot.referenceIds)] : [])
      .filter((id) => !['shotcard','audio'].includes(input.refs.find((ref) => ref.id === id)?.role))
    if (refs.some((id) => !ids.has(id) || !['material', 'layout'].includes(input.refs.find((ref) => ref.id === id).role))) throw new Error('镜头引用了不存在或仅供参考的素材')
    return { id: 'shot-' + (index + 1), recipeId: shot.recipeId, recipeVersion: 1, startFrame: start, durationFrames: duration,
      ...(shot.recipeId === 'scene' ? { sceneSource: shot.sceneSource, ...(sceneComponents.length ? { sceneComponents } : {}), cardId: String(shot.cardId || ''), demo: String(shot.demo || ''), motionCards: Array.isArray(shot.motionCards) ? motionClone(shot.motionCards) : [], fidelity: Array.isArray(shot.fidelity) ? motionClone(shot.fidelity) : [], description: String(shot.description || '').slice(0, 2000) } : {}),
      referenceIds: refs, title: String(shot.title || '').slice(0, 300), subtitle: String(shot.subtitle || '').slice(0, 600),
      background: color(shot.background, '#101827'), color: color(shot.color, '#ffffff'), accent: color(shot.accent, '#8b9dff') }
  }).sort((a, b) => a.startFrame - b.startFrame)
  let end = 0
  for (const shot of shots) { if (shot.startFrame !== end) throw new Error('分镜必须连续且不能重叠'); end += shot.durationFrames }
  if (end !== total) throw new Error('分镜总时长必须等于视频时长')
  if (raw.production && (typeof raw.production !== 'object' || Array.isArray(raw.production) || JSON.stringify(raw.production).length > 100000)) throw new Error('制作记录无效或过大')
  return { version: MOTION_VERSION, ...(raw.production ? { production: motionClone(raw.production) } : {}), width: input.settings.width, height: input.settings.height,
    fps: input.settings.fps, durationFrames: total, shots,...(raw.audio?{audio:validateAudioTimeline(raw.audio,{fps:input.settings.fps,durationFrames:total,shots},input)}:{}) }
}

export function assertMotionEditable(doc, nodeId) {
  const node = doc.nodes.find((item) => item.id === nodeId)
  if (!node) throw new Error('目标视频已删除，成片保留在任务历史')
  const seen = new Set()
  for (let item = node; item; item = doc.nodes.find((n) => n.id === item.parent)) {
    if (seen.has(item.id)) throw new Error('分组结构无效')
    seen.add(item.id)
    if (item.locked || /(?:^|;)locked=1(?:;|$)/.test(item.style || '') || (doc.layers || []).find((layer) => layer.id === (item.layer || doc.layers?.[0]?.id))?.locked) throw new Error('节点或图层已锁定，成片保留在任务历史')
  }
  return node
}

export function applyMotionResult(doc, job, result) {
  const node = assertMotionEditable(doc, job.nodeId)
  if (node.data.motion?.lastJobId === job.id) return node
  if (node.data.motion?.requestId !== job.id || motionInputKey(motionInput(doc, node.id)) !== job.inputKey) throw new Error('描述或参考已变化，成片保留在任务历史')
  const motion = node.data.motion
  node.data = { ...node.data, ...result.data, motion: { ...motion, lastJobId: job.id,
    composition: motionClone(result.composition), inputKey: job.inputKey,
    results: [{ jobId: job.id, clip: result.data.mediaClip }, ...(Array.isArray(motion.results) ? motion.results : [])].slice(0, 12) } }
  node.style = result.style
  return node
}
