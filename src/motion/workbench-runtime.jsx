// 独立打包的剪辑工作台。这个文件会被复制到工程目录，和场景入口一起交给
// @remotion/bundler 打包；工作台只通过宿主提供的 token API 读写工程。
//
// 数据流：
//   boot 页面 → /drawai/workbench/api {action:'open'} → 本 bundle 挂载
//   时间轴编辑只改 React state；保存时整份 timeline 回传，宿主做版本校验和原子写盘。
//   预览用 <Player> + 运行时 inputProps，拖播放头/片段不会触发重新打包。

import React from 'react'
import { createRoot } from 'react-dom/client'
import { Player } from '@remotion/player'
import { MotionMovie } from './entry.gen.jsx'
import * as OPS from './timeline-ops.gen.js'

const BOOT = window.__DRAWAI_WORKBENCH__ || {}
const API = '/drawai/workbench/api'
const HEADER_W = 152
const MIN_DURATION = 2

const clone = (value) => JSON.parse(JSON.stringify(value))
const clamp = (value, low, high) => Math.min(Math.max(value, low), high)
const frameOf = (value) => Math.round(Number(value) || 0)
const fpsOf = (timeline) => Number(timeline?.fps) || 30
const durationOf = (timeline) => Number(timeline?.durationInFrames) || 1

async function request(action, payload = {}) {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-drawai-save': '1' },
    body: JSON.stringify({ token: BOOT.token, action, ...payload }),
  })
  let data
  try { data = await response.json() } catch { throw new Error('工作台接口返回不是 JSON（HTTP ' + response.status + '）') }
  if (!response.ok) throw new Error(data?.error || ('HTTP ' + response.status))
  if (data && data.ok === false && !data.conflict) throw new Error(data.error || '操作失败')
  return data
}

function mainTrackOf(timeline) {
  return (timeline.tracks || []).find((track) => track.role === 'main') || timeline.tracks[0]
}
function overlayTrackOf(timeline) {
  return (timeline.tracks || []).find((track) => track.role === 'overlay')
}
function sourceMapOf(timeline) {
  return new Map((timeline.shots || []).map((shot) => [shot.id, shot]))
}

function timecode(frame, fps) {
  const total = Math.max(0, frame) / fps
  const seconds = Math.floor(total)
  const frames = Math.round((total - seconds) * fps)
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return mm + ':' + ss + ':' + String(frames).padStart(2, '0')
}

function bindingsOf(timeline, bindings) {
  void timeline
  return OPS.cueBindingsOf(bindings)
}

function cueColor(role) {
  if (role === 'voice') return '#3f8cff'
  if (role === 'bgm') return '#9b7bff'
  return '#28b487'
}

const css = `
*{box-sizing:border-box}
html,body,#root{height:100%;margin:0}
body{background:#141519;color:#e8e9ee;font-family:Inter,"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;overflow:hidden}
.wb-root{height:100%;display:flex;flex-direction:column;background:#141519}
.wb-header{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid #2a2c33;background:#191a20;flex-wrap:wrap}
.wb-title{font-weight:650;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42vw}
.wb-meta{font-size:12px;color:#8e919c;white-space:nowrap}
.wb-spacer{flex:1}
.wb-btn{appearance:none;border:1px solid #353842;background:#23252c;color:#e8e9ee;border-radius:8px;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.wb-btn:hover{border-color:#4c4f5b;background:#2a2c35}
.wb-btn:disabled{opacity:.42;cursor:default}
.wb-btn.primary{background:#6f5bd6;border-color:#7d6ae0}
.wb-btn.primary:hover{background:#7d6ae0}
.wb-btn.danger{color:#ffb4b4;border-color:#5a3434}
.wb-main{flex:1;min-height:0;display:flex}
.wb-preview-col{flex:1;min-width:0;display:flex;flex-direction:column;padding:12px 14px 8px;gap:8px;border-right:1px solid #2a2c33}
.wb-stage{flex:1;min-height:120px;background:#0b0c0f;border:1px solid #2a2c33;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
.wb-stage .player{width:100%;height:100%}
.wb-stage-empty{color:#767a86;font-size:13px;text-align:center;padding:24px;line-height:1.8;max-width:560px}
.wb-transport{display:flex;align-items:center;gap:8px;font-size:12px;color:#a4a7b2}
.wb-transport .tc{font-variant-numeric:tabular-nums;color:#fff;letter-spacing:.2px}
.wb-inspector{width:292px;flex-shrink:0;overflow:auto;padding:14px;background:#18191f}
.wb-inspector h3{margin:0 0 10px;font-size:12px;letter-spacing:.06em;color:#9a9eaa;text-transform:uppercase}
.wb-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:12px;color:#a4a7b2}
.wb-field input,.wb-field select{height:30px;border:1px solid #343741;border-radius:7px;background:#202229;color:#e8e9ee;padding:0 8px;font:inherit;font-size:12px;min-width:0}
.wb-field input[type=range]{height:22px;padding:0;accent-color:#7d6ae0}
.wb-field .row{display:flex;gap:6px}
.wb-field .row>*{flex:1}
.wb-hint{font-size:11.5px;line-height:1.65;color:#7f8490;margin:0 0 10px}
.wb-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid #353842;border-radius:999px;padding:2px 8px;font-size:11px;color:#b9bdc8;margin:0 5px 6px 0}
.wb-pill.lock{color:#ffcf7a;border-color:#5b4826;background:#2a2317}
.wb-timeline{border-top:1px solid #2a2c33;background:#17181d;flex-shrink:0}
.wb-tl-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid #262830;flex-wrap:wrap}
.wb-tl-toolbar .wb-btn{padding:5px 9px}
.wb-tl-scroll{overflow:auto;max-height:44vh;min-height:180px}
.wb-tl-content{position:relative;min-width:100%}
.wb-ruler-row{display:flex;height:28px;border-bottom:1px solid #262830;position:sticky;top:0;background:#17181d;z-index:3}
.wb-track-head{width:152px;flex-shrink:0;padding:0 10px;display:flex;align-items:center;gap:7px;font-size:12px;color:#b9bdc8;border-right:1px solid #262830;position:sticky;left:0;background:#18191f;z-index:2}
.wb-track-head small{color:#717582;font-size:10.5px}
.wb-track-row{display:flex;border-bottom:1px solid #23252c;min-height:48px}
.wb-track-row.audio{min-height:38px}
.wb-lane{position:relative;flex:1;min-width:0;background:linear-gradient(180deg,#191b21,#17191e)}
.wb-lane.main{background:linear-gradient(180deg,#1b1d24,#181a20)}
.wb-lane.overlay{background:linear-gradient(180deg,#1d1a25,#191720)}
.wb-ruler{position:relative;flex:1;cursor:pointer;user-select:none}
.wb-tick{position:absolute;top:0;bottom:0;border-left:1px solid #2d3039;font-size:10px;color:#6f7480;padding-left:4px;white-space:nowrap}
.wb-tick.major{border-color:#3d414c;color:#a0a4af}
.wb-clip{position:absolute;top:5px;bottom:5px;border-radius:6px;border:1px solid #3a3e4a;border-left:3px solid #7d6ae0;background:linear-gradient(180deg,#2b2f3a,#242833);overflow:hidden;cursor:grab;user-select:none;min-width:10px}
.wb-clip.selected{outline:2px solid #a18cff;outline-offset:0;box-shadow:0 0 0 3px #7d6ae033}
.wb-clip .label{position:absolute;inset:4px 8px auto 8px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e7e8ee}
.wb-clip .meta{position:absolute;left:8px;bottom:3px;font-size:10px;color:#9ba0ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;right:8px}
.wb-clip .trim{position:absolute;top:0;bottom:0;width:7px;cursor:ew-resize;background:#ffffff0c}
.wb-clip .trim:hover{background:#a18cff44}
.wb-clip .trim.l{left:0}.wb-clip .trim.r{right:0}
.wb-clip.bound{border-left-color:#e0a94b}
.wb-clip.audio{border-left-color:#28b487;background:linear-gradient(180deg,#20312c,#1d2926);cursor:grab}
.wb-clip.audio.voice{border-left-color:#3f8cff;background:linear-gradient(180deg,#1d2838,#1a2331)}
.wb-clip.audio.bgm{border-left-color:#9b7bff;background:linear-gradient(180deg,#271f38,#211b2f)}
.wb-playhead{position:absolute;top:0;bottom:0;width:1px;background:#ff5d6c;z-index:6;pointer-events:none}
.wb-playhead::before{content:"";position:absolute;top:0;left:-5px;border:5px solid transparent;border-top:7px solid #ff5d6c}
.wb-bound{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed #e0a94b;z-index:4;pointer-events:none}
.wb-bound::after{content:"";position:absolute;top:2px;left:-4px;width:7px;height:7px;background:#e0a94b;transform:rotate(45deg)}
.wb-banner{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#2a2317;border-bottom:1px solid #5b4826;color:#ffd993;font-size:12px}
.wb-banner.error{background:#2b1a1d;border-color:#5d2a31;color:#ffb4bd}
.wb-banner .wb-btn{padding:4px 9px}
.wb-render{display:flex;flex-direction:column;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid #2b2d35}
.wb-progress{height:6px;border-radius:4px;background:#24262e;overflow:hidden}
.wb-progress>div{height:100%;background:linear-gradient(90deg,#6f5bd6,#a18cff);transition:width .25s}
.wb-job{border:1px solid #2e313a;border-radius:8px;padding:8px;margin-bottom:6px;font-size:11.5px;color:#a4a7b2;line-height:1.55}
.wb-job strong{color:#e8e9ee;font-weight:600}
.wb-job .stale{color:#ffcf7a}
.wb-empty{color:#717582;font-size:12px;line-height:1.7;padding:8px 2px}
.wb-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#2a2c35;border:1px solid #454955;color:#f0f1f5;padding:8px 14px;border-radius:9px;font-size:12px;z-index:30;box-shadow:0 10px 30px #0007;max-width:80vw}
.wb-error{color:#ffb4bd;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.wb-mini{font-size:10.5px;color:#7f8490;line-height:1.5}
@media (max-width:900px){.wb-inspector{width:244px}.wb-title{max-width:30vw}}
`

class PlayerBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    return this.state.error
      ? <div className="wb-stage-empty"><div className="wb-error">预览渲染失败：{String(this.state.error?.message || this.state.error)}</div></div>
      : this.props.children
  }
}

function ErrorBoundary({ children }) {
  return <PlayerBoundary>{children}</PlayerBoundary>
}

function clampCue(timeline, cue) {
  const total = durationOf(timeline)
  const from = clamp(frameOf(cue.from), 0, Math.max(0, total - 1))
  const duration = clamp(frameOf(cue.durationInFrames), 1, Math.max(1, total - from))
  return { ...cue, from, durationInFrames: duration }
}

function editCue(timeline, cueId, patch) {
  const next = clone(timeline)
  const cue = next.audio.find((item) => item.id === cueId)
  if (!cue) throw new Error('找不到音轨：' + cueId)
  Object.assign(cue, patch)
  Object.assign(cue, clampCue(next, cue))
  next.audio.sort((a, b) => a.from - b.from)
  return next
}

function clipDisplayName(clip, sources) {
  const source = sources.get(clip.shotId)
  return source?.id || clip.shotId
}

function App({ scenes }) {
  const initial = BOOT.timeline
  const [timeline, setTimeline] = React.useState(initial)
  const timelineRef = React.useRef(timeline)
  timelineRef.current = timeline
  LIVE_TIMELINE = timeline
  const [past, setPast] = React.useState([])
  const [future, setFuture] = React.useState([])
  const [dirty, setDirty] = React.useState(false)
  const [revision, setRevision] = React.useState(BOOT.revision)
  const revisionRef = React.useRef(BOOT.revision)
  revisionRef.current = revision
  const [bindings, setBindings] = React.useState(BOOT.bindings || {})
  const [selected, setSelected] = React.useState(null)
  const [playhead, setPlayhead] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)
  const [loop, setLoop] = React.useState(true)
  const [ppf, setPpf] = React.useState(3)
  const [message, setMessage] = React.useState('')
  const [conflict, setConflict] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [bundleUrl, setBundleUrl] = React.useState(BOOT.bundleUrl || '')
  const [bundleStale, setBundleStale] = React.useState(false)
  const [jobs, setJobs] = React.useState(BOOT.jobs || [])
  const [renderJob, setRenderJob] = React.useState(() => (BOOT.jobs || []).find((job) => ['queued', 'running'].includes(job.status)) || null)
  const [renderBusy, setRenderBusy] = React.useState(false)
  const [applying, setApplying] = React.useState(false)
  const [overlaySource, setOverlaySource] = React.useState(BOOT.sources?.[0]?.id || '')
  const [drag, setDrag] = React.useState(null)
  const [fontsReady, setFontsReady] = React.useState(!(BOOT.fontFaces || []).length)
  const playerRef = React.useRef(null)
  const rootRef = React.useRef(null)
  const readOnly = BOOT.project?.readOnly === true
  const sources = React.useMemo(() => sourceMapOf(timeline), [timeline])
  const resolution = React.useMemo(() => {
    const cueBindings = bindingsOf(timeline, bindings)
    return { cuts: cueBindings.cuts, sfxIds: cueBindings.sfx, musicCueId: cueBindings.musicCueId }
  }, [timeline, bindings])
  const total = durationOf(timeline)
  const fps = fpsOf(timeline)

  React.useEffect(() => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  React.useEffect(() => {
    const faces = BOOT.fontFaces || []
    if (!faces.length) { setFontsReady(true); return }
    const mediaBase = String(BOOT.mediaBase || '').replace(/\/$/, '')
    const style = document.createElement('style')
    style.textContent = faces.map((face) => '@font-face{font-family:' + JSON.stringify(face.family) + ';src:url(' + JSON.stringify(mediaBase + '/fonts/' + face.file) + ') format("truetype");font-weight:' + face.weight + ';font-style:' + face.style + ';font-display:block}').join('\n')
    document.head.appendChild(style)
    Promise.all(faces.slice(0, 8).map((face) => document.fonts.load('400 16px ' + JSON.stringify(face.family)).catch(() => null)))
      .then(() => document.fonts.ready).then(() => setFontsReady(true)).catch(() => setFontsReady(true))
    return () => style.remove()
  }, [])

  // 播放器事件：唯一的时间源。拖动播放头时直接 seekTo，不与 frameupdate 抢状态。
  React.useEffect(() => {
    const player = playerRef.current
    if (!player) return
    const onFrame = (event) => setPlayhead(clamp(frameOf(event.detail?.frame), 0, total - 1))
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    player.addEventListener('frameupdate', onFrame)
    player.addEventListener('play', onPlay)
    player.addEventListener('pause', onPause)
    return () => {
      player.removeEventListener('frameupdate', onFrame)
      player.removeEventListener('play', onPlay)
      player.removeEventListener('pause', onPause)
    }
  }, [bundleUrl, total, fontsReady])

  React.useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 2600)
    return () => clearTimeout(timer)
  }, [message])

  React.useEffect(() => {
    if (!dirty) return
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  React.useEffect(() => {
    if (!renderJob?.id) return
    if (['done', 'failed', 'error', 'canceled', 'cancelled', 'interrupted'].includes(renderJob.status)) return
    const timer = setInterval(async () => {
      try {
        const result = await request('job', { jobId: renderJob.id })
        setRenderJob(result.job)
        if (result.job && !['queued', 'running'].includes(result.job.status)) {
          setJobs((list) => [result.job, ...list.filter((item) => item.id !== result.job.id)])
        }
      } catch (error) { setMessage(error.message) }
    }, 900)
    return () => clearInterval(timer)
  }, [renderJob?.id, renderJob?.status])

  const snapshot = React.useCallback(() => {
    setPast((list) => [...list.slice(-49), clone(timelineRef.current)])
    setFuture([])
  }, [])

  const apply = React.useCallback((next) => {
    setTimeline(next)
    timelineRef.current = next
    LIVE_TIMELINE = next
    setDirty(true)
  }, [])

  const run = React.useCallback((operation, history = true) => {
    try {
      if (history) snapshot()
      const next = operation(timelineRef.current)
      if (next) apply(next)
    } catch (error) {
      setMessage(error.message || String(error))
    }
  }, [apply, snapshot])

  const undo = React.useCallback(() => {
    setPast((list) => {
      if (!list.length) return list
      const previous = list[list.length - 1]
      setFuture((forward) => [clone(timelineRef.current), ...forward].slice(0, 50))
      setTimeline(previous)
      timelineRef.current = previous
      LIVE_TIMELINE = previous
      setDirty(true)
      setSelected(null)
      return list.slice(0, -1)
    })
  }, [])

  const redo = React.useCallback(() => {
    setFuture((list) => {
      if (!list.length) return list
      const next = list[0]
      setPast((back) => [...back.slice(-49), clone(timelineRef.current)])
      setTimeline(next)
      timelineRef.current = next
      LIVE_TIMELINE = next
      setDirty(true)
      setSelected(null)
      return list.slice(1)
    })
  }, [])

  const seek = React.useCallback((frame) => {
    const next = clamp(frameOf(frame), 0, total - 1)
    setPlayhead(next)
    try { playerRef.current?.seekTo(next) } catch { /* 预览还没挂载 */ }
  }, [total])

  const togglePlay = React.useCallback(() => {
    const player = playerRef.current
    if (!player) return
    if (player.isPlaying()) player.pause()
    else player.play()
  }, [])

  const splitSelected = React.useCallback(() => {
    if (!selected) return
    run((current) => {
      const next = OPS.splitClipAt(current, selected.id, playhead)
      if (!next) throw new Error('播放头不在所选片段内部')
      return next
    })
  }, [playhead, run, selected])

  const removeSelected = React.useCallback(() => {
    if (!selected) return
    run((current) => {
      if (selected.kind === 'audio') {
        const next = clone(current)
        next.audio = (next.audio || []).filter((cue) => cue.id !== selected.id)
        return next
      }
      return OPS.removeClip(current, selected.id)
    })
    setSelected(null)
  }, [run, selected])

  const save = React.useCallback(async (force = false) => {
    if (saving) return false
    setSaving(true)
    try {
      const result = await request('save', { timeline: timelineRef.current, baseRevision: revisionRef.current, force })
      if (result.conflict) {
        setConflict({ revision: result.revision, error: result.error || '工程已被其他编辑修改' })
        return null
      }
      setRevision(result.revision)
      revisionRef.current = result.revision
      if (result.bindings) setBindings(result.bindings)
      setTimeline(result.timeline || timelineRef.current)
      timelineRef.current = result.timeline || timelineRef.current
      LIVE_TIMELINE = timelineRef.current
      setDirty(false)
      setConflict(null)
      setBundleStale(result.bundleStale === true)
      setMessage('已保存')
      return { revision: result.revision }
    } catch (error) {
      setMessage('保存失败：' + error.message)
      return null
    } finally { setSaving(false) }
  }, [saving])

  const reload = React.useCallback(async () => {
    try {
      const result = await request('reload')
      setTimeline(result.timeline)
      timelineRef.current = result.timeline
      LIVE_TIMELINE = result.timeline
      setRevision(result.revision)
      revisionRef.current = result.revision
      setBindings(result.bindings || {})
      setPast([]); setFuture([]); setDirty(false); setConflict(null); setSelected(null)
      setMessage('已载入磁盘版本')
    } catch (error) { setMessage(error.message) }
  }, [])

  const refreshPreview = React.useCallback(async () => {
    try {
      if (dirty && !(await save())) return
      setMessage('正在重新打包场景…')
      const result = await request('bundle')
      setBundleUrl(result.bundleUrl)
      setBundleStale(false)
      setMessage('预览已更新，正在刷新')
      setTimeout(() => window.location.reload(), 500)
    } catch (error) { setMessage('刷新预览失败：' + error.message) }
  }, [dirty, save])

  const startRender = React.useCallback(async () => {
    if (renderBusy) return
    setRenderBusy(true)
    try {
      let baseRevision = revisionRef.current
      if (dirty || conflict) {
        const saved = await save(false)
        if (!saved) return
        baseRevision = saved.revision
      }
      const result = await request('render', { baseRevision })
      if (result.conflict) {
        setConflict({ revision: result.revision, error: result.error || '工程已保存为更新版本' })
        return
      }
      setRenderJob(result.job)
      setJobs((list) => [result.job, ...list.filter((item) => item.id !== result.job.id)])
      setMessage('已提交渲染：' + result.job.id)
    } catch (error) {
      setMessage('渲染启动失败：' + error.message)
    } finally { setRenderBusy(false) }
  }, [conflict, dirty, renderBusy, save])

  const cancelRender = React.useCallback(async () => {
    if (!renderJob?.id) return
    try {
      const result = await request('cancel', { jobId: renderJob.id })
      setRenderJob(result.job)
    } catch (error) { setMessage(error.message) }
  }, [renderJob?.id, renderJob?.status])

  const applyJob = React.useCallback(async (job) => {
    if (!job || applying) return
    setApplying(true)
    try {
      const result = await request('apply', { jobId: job.id })
      setMessage('已回填到画布节点：' + result.nodeId)
      try { window.parent.postMessage({ type: 'drawai-workbench-applied', nodeId: result.nodeId, jobId: job.id }, window.location.origin) } catch { /* 不在 iframe 里 */ }
    } catch (error) { setMessage('回填失败：' + error.message) }
    finally { setApplying(false) }
  }, [applying])

  const close = React.useCallback(() => {
    if (dirty && !window.confirm('时间轴还有未保存的修改，确定关闭工作台？')) return
    try { window.parent.postMessage({ type: 'drawai-workbench-close' }, window.location.origin) } catch { window.close() }
  }, [dirty])

  React.useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      if (event.data?.type === 'drawai-workbench-request-close') close()
    }
    window.addEventListener('message', onMessage)
    // 外壳与运行时同窗：外壳只能用这个同步标记判断运行时已接管关闭确认。
    // 只给 parent 发 ready 的话，外壳永远收不到自己的消息，会抢在确认前关掉 iframe。
    window.__DRAWAI_WORKBENCH_RUNTIME_READY__ = true
    try { window.parent.postMessage({ type: 'drawai-workbench-ready' }, window.location.origin) } catch { /* 不在 iframe 里 */ }
    return () => window.removeEventListener('message', onMessage)
  }, [close])

  React.useEffect(() => {
    const onKey = (event) => {
      const tag = event.target?.tagName?.toLowerCase()
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); if (event.shiftKey) redo(); else undo(); return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return }
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); return }
      if (event.key === 'ArrowLeft') { event.preventDefault(); seek(playhead - (event.shiftKey ? fps : 1)); return }
      if (event.key === 'ArrowRight') { event.preventDefault(); seek(playhead + (event.shiftKey ? fps : 1)); return }
      if (event.key === 's' || event.key === 'S') { event.preventDefault(); splitSelected(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, playhead, redo, removeSelected, save, seek, splitSelected, togglePlay, undo])

  const plan = React.useMemo(() => OPS.workbenchPlanOf(timeline, BOOT.fontFaces || []), [timeline])
  const inputProps = React.useMemo(() => ({ plan }), [plan])
  const Movie = React.useMemo(() => function MovieView(props) {
    return <MotionMovie plan={props.plan} scenes={scenes} />
  }, [scenes])

  const selectedClip = React.useMemo(() => {
    if (!selected || selected.kind !== 'clip') return null
    for (const track of timeline.tracks) {
      const clip = track.clips.find((item) => item.id === selected.id)
      if (clip) return { track, clip }
    }
    return null
  }, [selected, timeline])
  const selectedCue = React.useMemo(() => selected?.kind === 'audio' ? timeline.audio.find((cue) => cue.id === selected.id) : null, [selected, timeline])
  const overlay = overlayTrackOf(timeline)
  const main = mainTrackOf(timeline)
  const someActive = renderJob && ['queued', 'running'].includes(renderJob.status)

  return (
    <div className="wb-root" ref={rootRef}>
      <header className="wb-header">
        <div className="wb-title" title={BOOT.project?.dir || ''}>{BOOT.project?.name || '剪辑工作台'}</div>
        <div className="wb-meta">{timeline.width}×{timeline.height} · {fps}fps · {(total / fps).toFixed(2)}s · {main.clips.length} 镜{overlay.clips.length ? ' · 叠加 ' + overlay.clips.length : ''}</div>
        <div className="wb-spacer" />
        <button className="wb-btn" onClick={undo} disabled={!past.length} title="撤销 Ctrl+Z">撤销</button>
        <button className="wb-btn" onClick={redo} disabled={!future.length} title="重做 Ctrl+Shift+Z">重做</button>
        <button className="wb-btn" onClick={() => save()} disabled={readOnly || saving || !dirty}>{saving ? '保存中…' : dirty ? '保存*' : '已保存'}</button>
        <button className="wb-btn primary" onClick={refreshPreview} title="场景源码或素材变了之后重新打包">刷新预览</button>
        <button className="wb-btn primary" onClick={startRender} disabled={readOnly || renderBusy || someActive}>{someActive ? '渲染中…' : '导出成片'}</button>
        <button className="wb-btn" onClick={close}>关闭</button>
      </header>

      {readOnly ? <div className="wb-banner">当前画布是只读的：可以查看和试编，保存与导出会被宿主拒绝。</div> : null}
      {conflict ? (
        <div className="wb-banner">
          <span>工程在另一个窗口被修改（磁盘版本 {conflict.revision}）。当前草稿仍保留。</span>
          <button className="wb-btn" onClick={reload}>载入磁盘版本</button>
          <button className="wb-btn" onClick={() => save(true)}>覆盖保存</button>
        </div>
      ) : null}
      {bundleStale ? <div className="wb-banner"><span>场景源码或素材已变化，预览仍是旧画面。</span><button className="wb-btn" onClick={refreshPreview}>重新打包预览</button></div> : null}
      {!bundleUrl ? <div className="wb-banner error"><span>预览场景没有打包成功。{BOOT.bundleError ? ' ' + BOOT.bundleError : ' 请检查视频环境后点「刷新预览」。'}</span></div> : null}

      <div className="wb-main">
        <div className="wb-preview-col">
          <div className="wb-stage">
            {bundleUrl && fontsReady ? (
              <ErrorBoundary>
                <Player
                  ref={playerRef}
                  component={Movie}
                  inputProps={inputProps}
                  durationInFrames={total}
                  compositionWidth={timeline.width}
                  compositionHeight={timeline.height}
                  fps={fps}
                  loop={loop}
                  controls={false}
                  clickToPlay
                  numberOfSharedAudioTags={32}
                  acknowledgeRemotionLicense
                  style={{ width: '100%', height: '100%' }}
                />
              </ErrorBoundary>
            ) : <div className="wb-stage-empty">{bundleUrl ? '正在加载字体…' : '预览不可用。时间轴仍可编辑和保存；修复视频环境后点「刷新预览」。'}</div>}
          </div>
          <div className="wb-transport">
            <button className="wb-btn" onClick={() => seek(0)} title="到开头">⏮</button>
            <button className="wb-btn" onClick={() => seek(playhead - 1)} title="上一帧 ←">◀|</button>
            <button className="wb-btn" onClick={togglePlay} title="播放/暂停 Space" disabled={!bundleUrl}>{playing ? '⏸' : '▶'}</button>
            <button className="wb-btn" onClick={() => seek(playhead + 1)} title="下一帧 →">|▶</button>
            <span className="tc">{timecode(playhead, fps)}</span>
            <span style={{ opacity: .55 }}>/ {timecode(total - 1, fps)}</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /> 循环</label>
            <span className="wb-spacer" />
            <span className="wb-mini">帧 {playhead}</span>
          </div>
        </div>

        <aside className="wb-inspector">
          <h3>属性</h3>
          {selectedClip ? (
            <ClipInspector
              timeline={timeline} track={selectedClip.track} clip={selectedClip.clip} source={sources.get(selectedClip.clip.shotId)}
              resolution={resolution} playhead={playhead}
              onBegin={snapshot} onApply={apply} onMessage={setMessage}
              onSplit={splitSelected} onRemove={removeSelected}
            />
          ) : selectedCue ? (
            <CueInspector
              timeline={timeline} cue={selectedCue} resolution={resolution}
              onBegin={snapshot} onApply={apply} onMessage={setMessage}
            />
          ) : (
            <div className="wb-empty">
              选中时间轴上的片段查看轨道、裁入点和透明度。<br /><br />
              主镜头轨：拖动片段重排，拖两端裁剪，按 S 在播放头处分割。<br />
              画面叠加轨：从下方选一个场景，把片段放到播放头位置，可自由移动、裁剪、调透明度。<br />
              音频轨：拖动落点、拖右边缘改时长、在属性里调音量。带 🔒 的是卡点绑定，先解除绑定再动位置。
            </div>
          )}

          <div className="wb-render">
            <h3 style={{ marginBottom: 4 }}>渲染任务</h3>
            {renderJob ? <JobCard job={renderJob} currentRevision={revision} dirty={dirty} onCancel={cancelRender} onApply={applyJob} applying={applying} active /> : <div className="wb-empty">还没有从工作台提交的渲染。</div>}
            {jobs.filter((job) => job.id !== renderJob?.id).slice(0, 6).map((job) => (
              <JobCard key={job.id} job={job} currentRevision={revision} dirty={dirty} onApply={applyJob} applying={applying} />
            ))}
          </div>
        </aside>
      </div>

      <TimelinePanel
        timeline={timeline} sources={sources} ppf={ppf} setPpf={setPpf} playhead={playhead} total={total} fps={fps}
        selected={selected} setSelected={setSelected} seek={seek} resolution={resolution}
        dirty={dirty} snapshot={snapshot} apply={apply} run={run} message={setMessage}
        overlaySource={overlaySource} setOverlaySource={setOverlaySource}
        main={main} overlay={overlay} drag={drag} setDrag={setDrag}
        onSplit={splitSelected} onRemove={removeSelected} onUndo={undo} onRedo={redo} canUndo={!!past.length} canRedo={!!future.length}
      />
      {message ? <div className="wb-toast" role="status">{message}</div> : null}
    </div>
  )
}

function ClipInspector({ timeline, track, clip, source, resolution, playhead, onBegin, onApply, onMessage, onSplit, onRemove }) {
  const { updateClipAt } = OPS
  const sourceDuration = Number(source?.sourceDurationFrames) || Number(source?.durationFrames) || 1
  const maxDuration = Math.max(MIN_DURATION, Math.min(sourceDuration - clip.inOffset, timeline.durationInFrames - clip.startFrame))
  const isMain = track.role === 'main'
  const boundStart = isMain && resolution.cuts.has(clip.startFrame)
  const boundEnd = isMain && resolution.cuts.has(clip.startFrame + clip.durationFrames)
  const edit = (fn) => {
    try { onApply(fn(clone(timeline))) } catch (error) { onMessage(error.message) }
  }
  return (
    <div>
      <div className="wb-pill">{track.role === 'main' ? '主镜头轨' : '画面叠加轨'}</div>
      <div className="wb-pill">{source?.id || clip.shotId}</div>
      {boundStart || boundEnd ? <div className="wb-pill lock">🔒 卡点绑定边界</div> : null}
      <div className="wb-field"><label>场景来源</label><div>{source?.file || '—'}</div></div>
      <div className="wb-field"><label>时间轴起点（帧）</label><div>{clip.startFrame}</div></div>
      <div className="wb-field">
        <label>片段长度（帧，最多 {maxDuration}）</label>
        <input type="number" min={MIN_DURATION} max={maxDuration} value={clip.durationFrames}
          onFocus={onBegin}
          onChange={(event) => edit((current) => updateClipAt(current, clip.id, { durationFrames: Math.max(MIN_DURATION, Math.min(Number(event.target.value), maxDuration)) }))} />
      </div>
      <div className="wb-field"><label>裁入点（源帧）</label><div>{clip.inOffset}</div></div>
      <div className="wb-field">
        <label>透明度 {Math.round((clip.opacity ?? 1) * 100)}%</label>
        <input type="range" min={0} max={100} value={Math.round((clip.opacity ?? 1) * 100)}
          onPointerDown={onBegin}
          onChange={(event) => edit((current) => updateClipAt(current, clip.id, { opacity: Number(event.target.value) / 100 }))} />
      </div>
      <div className="wb-field"><label>播放头</label><div>{playhead}（片段内 {playhead - clip.startFrame}）</div></div>
      <div className="wb-hint">裁剪、分割后场景源码仍按来源定位；同一场景可以出现多次。主镜头轨同轨不重叠，重排会从 0 帧重新连续排布。</div>
      <div className="row" style={{ display: 'flex', gap: 6 }}>
        <button className="wb-btn" onClick={onSplit} disabled={playhead <= clip.startFrame || playhead >= clip.startFrame + clip.durationFrames}>分割</button>
        <button className="wb-btn danger" onClick={onRemove}>删除片段</button>
      </div>
    </div>
  )
}

function CueInspector({ timeline, cue, resolution, onBegin, onApply, onMessage }) {
  const fps = fpsOf(timeline)
  const bound = resolution.sfxIds.has(cue.id) || resolution.musicCueId === cue.id
  const edit = (patch) => {
    try { onApply(editCue(clone(timeline), cue.id, patch)) } catch (error) { onMessage(error.message) }
  }
  return (
    <div>
      <div className="wb-pill">{cue.role === 'voice' ? '旁白' : cue.role === 'bgm' ? '配乐' : '音效'}</div>
      <div className="wb-pill" title={cue.file}>{cue.file}</div>
      {bound ? <div className="wb-pill lock">🔒 {resolution.musicCueId === cue.id ? '卡点音乐' : '卡点音效'}：位置绑定</div> : null}
      <div className="wb-field"><label>起始帧</label><input type="number" min={0} max={durationOf(timeline) - 1} value={cue.from} disabled={bound}
        onFocus={onBegin} onChange={(event) => edit({ from: Number(event.target.value) })} /></div>
      <div className="wb-field"><label>时长（帧）</label><input type="number" min={1} value={cue.durationInFrames} disabled={bound}
        onFocus={onBegin} onChange={(event) => edit({ durationInFrames: Number(event.target.value) })} /></div>
      <div className="wb-field"><label>裁入（秒）</label><input type="number" min={0} step="0.01" value={Number(cue.trimStart) || 0} disabled={bound}
        onFocus={onBegin} onChange={(event) => edit({ trimStart: Math.max(0, Number(event.target.value)) })} /></div>
      <div className="wb-field"><label>音量 {Number(cue.gainDb || 0).toFixed(1)} dB</label>
        <input type="range" min={-40} max={12} step={0.5} value={Number(cue.gainDb) || 0} onPointerDown={onBegin}
          onChange={(event) => edit({ gainDb: Number(event.target.value) })} /></div>
      <div className="wb-field"><label>淡入 / 淡出（帧）</label><div className="row">
        <input type="number" min={0} value={cue.fadeIn || 0} onFocus={onBegin} onChange={(event) => edit({ fadeIn: Number(event.target.value) })} />
        <input type="number" min={0} value={cue.fadeOut || 0} onFocus={onBegin} onChange={(event) => edit({ fadeOut: Number(event.target.value) })} />
      </div></div>
      <div className="wb-field"><label><input type="checkbox" checked={cue.duck === true} onChange={(event) => edit({ duck: event.target.checked })} /> 旁白避让（仅配乐）</label></div>
      <div className="wb-hint">旁白避让与淡入淡出沿用原语义。音效的落点若被卡点绑定，先调整绑定再移动；音量始终可调。</div>
    </div>
  )
}

function JobCard({ job, currentRevision, dirty, onCancel, onApply, applying, active }) {
  const terminal = ['done', 'failed', 'error', 'canceled', 'cancelled', 'interrupted'].includes(job.status)
  const done = job.status === 'done'
  const owned = job.outputOwned === true
  const percent = Math.round((Number(job.progress) || 0) * 100)
  const stale = job.timelineRevision && currentRevision && job.timelineRevision !== currentRevision
  return (
    <div className="wb-job">
      <div><strong>{job.kind === 'pilot' ? '样片' : job.kind === 'still' ? '静帧' : '整片'}</strong> · {job.status}{job.phase ? ' · ' + job.phase : ''} {job.id ? <span style={{ opacity: .5 }}>{job.id.slice(-8)}</span> : null}</div>
      {!terminal ? <div className="wb-progress"><div style={{ width: percent + '%' }} /></div> : null}
      {job.message ? <div>{job.message}</div> : null}
      {job.timelineRevision ? <div className={stale ? 'stale' : ''}>{stale ? '结果对应旧版本 ' : '版本 '}{job.timelineRevision}{stale ? '（已保存版本 ' + currentRevision + '）' : ''}</div> : null}
      {dirty && job.timelineRevision && job.timelineRevision === currentRevision ? <div className="stale">当前草稿在提交后又改过；这个结果对应上次保存的版本。</div> : null}
      {job.error ? <div className="wb-error">{job.error}</div> : null}
      {!terminal && onCancel ? <button className="wb-btn" onClick={onCancel}>取消</button> : null}
      {done && job.kind === 'film' && onApply && owned ? <button className="wb-btn primary" onClick={() => onApply(job)} disabled={applying}>{applying ? '回填中…' : '回填所选版本'}</button> : null}
      {done && job.kind === 'film' && !owned ? <div className="stale">旧任务没有独立成片文件，无法确认文件归属；请重新导出后再回填。</div> : null}
      {done && job.kind === 'pilot' ? <div className="wb-mini">样片不会回填主节点；回填请选整片任务。</div> : null}
    </div>
  )
}

function TimelinePanel(props) {
  const { timeline, sources, ppf, setPpf, playhead, total, fps, selected, setSelected, seek, resolution, dirty, snapshot, apply, run, message, overlaySource, setOverlaySource, main, overlay, drag, setDrag, onSplit, onRemove, onUndo, onRedo, canUndo, canRedo } = props
  const scrollerRef = React.useRef(null)
  const contentW = Math.max(600, total * ppf + 140)
  const stepSec = [0.25, 0.5, 1, 2, 5, 10, 30, 60].find((step) => step * fps * ppf >= 68) || 60
  const ticks = []
  for (let sec = 0; sec <= total / fps + stepSec; sec += stepSec / 2) ticks.push({ sec, major: Math.round((sec / stepSec) * 2) % 2 === 0 })
  const lanes = [
    { role: 'voice', name: '旁白', cues: timeline.audio.filter((cue) => cue.role === 'voice') },
    { role: 'bgm', name: '配乐', cues: timeline.audio.filter((cue) => cue.role === 'bgm') },
    { role: 'sfx', name: '音效', cues: timeline.audio.filter((cue) => cue.role === 'sfx') },
  ]

  const frameAt = (event, element) => {
    const rect = element.getBoundingClientRect()
    return clamp(Math.round((event.clientX - rect.left) / ppf), 0, total - 1)
  }
  const scrub = (event, element) => {
    if (event.button !== 0) return
    seek(frameAt(event, element))
    const move = (ev) => seek(frameAt(ev, element))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const addOverlay = () => {
    if (!overlaySource) return
    run((current) => {
      const source = (current.shots || []).find((shot) => shot.id === overlaySource)
      if (!source) throw new Error('请选择场景来源')
      const sourceDuration = Math.max(1, Number(source.sourceDurationFrames) || Number(source.durationFrames) || 1)
      const duration = Math.min(sourceDuration, Math.max(12, Math.round(fps * 3)), Math.max(1, total - playhead))
      return OPS.addOverlayClip(current, { shotId: overlaySource, startFrame: playhead, durationFrames: duration })
    })
  }
  const fit = () => {
    const width = scrollerRef.current?.clientWidth
    if (width) setPpf(clamp((width - HEADER_W - 90) / total, 0.3, 10))
  }

  return (
    <section className="wb-timeline">
      <div className="wb-tl-toolbar">
        <button className="wb-btn" onClick={onUndo} disabled={!canUndo}>撤销</button>
        <button className="wb-btn" onClick={onRedo} disabled={!canRedo}>重做</button>
        <span style={{ width: 1, height: 18, background: '#2e313a' }} />
        <button className="wb-btn" onClick={onSplit} disabled={!selected || selected.kind !== 'clip'}>分割</button>
        <button className="wb-btn danger" onClick={onRemove} disabled={!selected}>删除</button>
        <span style={{ width: 1, height: 18, background: '#2e313a' }} />
        <select value={overlaySource} onChange={(event) => setOverlaySource(event.target.value)} title="选择要放到画面叠加轨的场景" style={{ height: 28, background: '#202229', color: '#e8e9ee', border: '1px solid #343741', borderRadius: 7, fontSize: 12, maxWidth: 190 }}>
          {(timeline.shots || []).map((shot) => <option key={shot.id} value={shot.id}>{shot.id} · {shot.file}</option>)}
        </select>
        <button className="wb-btn" onClick={addOverlay} disabled={!overlaySource || !overlay}>放到叠加轨</button>
        <span className="wb-spacer" />
        <button className="wb-btn" onClick={fit}>适配</button>
        <span className="wb-mini">缩放</span>
        <input type="range" min={0.4} max={9} step={0.1} value={ppf} onChange={(event) => setPpf(Number(event.target.value))} style={{ width: 110, accentColor: '#7d6ae0' }} />
        <span className="wb-mini">{dirty ? '未保存' : '已保存'}</span>
      </div>
      <div className="wb-tl-scroll" ref={scrollerRef}>
        <div className="wb-tl-content" style={{ width: HEADER_W + contentW }}>
          <div className="wb-ruler-row">
            <div className="wb-track-head" style={{ position: 'sticky' }}>时间</div>
            <div className="wb-ruler" style={{ width: contentW }} onPointerDown={(event) => scrub(event, event.currentTarget)}>
              {ticks.map(({ sec, major }, index) => (
                <div key={index} className={'wb-tick' + (major ? ' major' : '')} style={{ left: sec * fps * ppf }}>
                  {major ? Math.round(sec) + 's' : ''}
                </div>
              ))}
            </div>
          </div>

          <TrackRow track={overlay} sources={sources} ppf={ppf} total={total} fps={fps} selected={selected} setSelected={setSelected}
            resolution={resolution} snapshot={snapshot} apply={apply} message={message} drag={drag} setDrag={setDrag}
            onReorder={null} label="画面叠加" />
          <TrackRow track={main} sources={sources} ppf={ppf} total={total} fps={fps} selected={selected} setSelected={setSelected}
            resolution={resolution} snapshot={snapshot} apply={apply} message={message} drag={drag} setDrag={setDrag}
            onReorder={(clipId, frame) => { try { apply(OPS.reorderMainClip(LIVE_TIMELINE, clipId, OPS.mainReorderIndex(LIVE_TIMELINE, frame, clipId))) } catch (error) { message(error.message) } }} label="主镜头" />

          {lanes.map((lane) => (
            <div className="wb-track-row audio" key={lane.role}>
              <div className="wb-track-head"><span>{lane.name}</span><small>{lane.cues.length}</small></div>
              <div className="wb-lane" style={{ width: contentW }}>
                {lane.cues.map((cue) => (
                  <AudioBlock key={cue.id} cue={cue} ppf={ppf} total={total} fps={fps} selected={selected?.kind === 'audio' && selected.id === cue.id}
                    bound={resolution.sfxIds.has(cue.id) || resolution.musicCueId === cue.id}
                    onSelect={() => setSelected({ kind: 'audio', id: cue.id })} snapshot={snapshot} apply={apply} message={message} />
                ))}
              </div>
            </div>
          ))}

          {[...resolution.cuts.values()].map((cut) => (
            <div key={'bound-' + cut.id} className="wb-bound" style={{ left: HEADER_W + cut.frame * ppf, top: 28 }}
              title={'卡点 ' + cut.id + ' · 第 ' + cut.frame + ' 帧'} />
          ))}
          <div className="wb-playhead" style={{ left: HEADER_W + playhead * ppf }} />
        </div>
      </div>
    </section>
  )
}

function TrackRow({ track, sources, ppf, total, fps, selected, setSelected, resolution, snapshot, apply, message, drag, setDrag, onReorder, label }) {
  if (!track) return null
  return (
    <div className="wb-track-row">
      <div className="wb-track-head"><span>{label}</span><small>{track.clips.length} 段</small></div>
      <div className={'wb-lane ' + (track.role === 'main' ? 'main' : 'overlay')} style={{ width: Math.max(600, total * ppf + 140) }}
        onPointerDown={(event) => { if (event.target === event.currentTarget) setSelected(null) }}>
        {track.clips.map((clip) => (
          <VideoBlock key={clip.id} clip={clip} track={track} ppf={ppf} total={total} fps={fps}
            source={sources.get(clip.shotId)}
            selected={selected?.kind === 'clip' && selected.id === clip.id}
            boundStart={track.role === 'main' && resolution.cuts.has(clip.startFrame)} boundEnd={track.role === 'main' && resolution.cuts.has(clip.startFrame + clip.durationFrames)}
            onSelect={() => setSelected({ kind: 'clip', id: clip.id })}
            snapshot={snapshot} apply={apply} message={message}
            drag={drag} setDrag={setDrag} onReorder={onReorder} />
        ))}
      </div>
    </div>
  )
}

function VideoBlock({ clip, track, ppf, total, fps, source, selected, boundStart, boundEnd, onSelect, snapshot, apply, message, drag, setDrag, onReorder }) {
  const [trimEdge, setTrimEdge] = React.useState('')
  const offset = drag && drag.clipId === clip.id ? drag.delta : 0
  const start = clip.startFrame + (track.role === 'main' ? offset : 0)
  const onBodyDown = (event) => {
    if (event.button !== 0) return
    event.stopPropagation()
    onSelect()
    if (track.role === 'main' && (boundStart || boundEnd)) {
      message('这个片段的首尾有卡点绑定，不能直接拖动重排；先调整绑定。')
      return
    }
    snapshot()
    const startX = event.clientX
    const origin = clip.startFrame
    let moved = 0
    if (track.role === 'main') {
      const move = (ev) => {
        moved = Math.round((ev.clientX - startX) / ppf)
        setDrag({ clipId: clip.id, delta: moved })
      }
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
        setDrag(null)
        if (!moved) return
        onReorder?.(clip.id, origin + moved + clip.durationFrames / 2)
      }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    } else {
      const move = (ev) => {
        const frame = clamp(origin + Math.round((ev.clientX - startX) / ppf), 0, total - clip.durationFrames)
        try { apply(OPS.moveClipAt(LIVE_TIMELINE, clip.id, frame)) } catch (error) { message(error.message) }
      }
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    }
  }
  const onTrimDown = (edge) => (event) => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    if ((edge === 'left' && boundStart) || (edge === 'right' && boundEnd)) {
      message('这个边界由卡点绑定。先在对话里调整绑定（motion_sync），再回来裁剪。')
      return
    }
    onSelect(); snapshot(); setTrimEdge(edge)
    const startX = event.clientX
    const origin = edge === 'left' ? clip.startFrame : clip.startFrame + clip.durationFrames
    const move = (ev) => {
      const frame = Math.round(origin + (ev.clientX - startX) / ppf)
      try { apply(OPS.trimClipAt(LIVE_TIMELINE, clip.id, edge, frame)) } catch (error) { message(error.message) }
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setTrimEdge('') }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  return (
    <div className={'wb-clip' + (selected ? ' selected' : '') + (boundStart || boundEnd ? ' bound' : '')}
      style={{ left: start * ppf, width: Math.max(10, clip.durationFrames * ppf) }}
      onPointerDown={onBodyDown} title={source ? source.file : clip.shotId}>
      <div className="label">{source?.id || clip.shotId}{clip.opacity !== undefined && clip.opacity < 1 ? ' · ' + Math.round(clip.opacity * 100) + '%' : ''}</div>
      <div className="meta">{(clip.durationFrames / fps).toFixed(2)}s · in {clip.inOffset} · #{start}</div>
      <div className="trim l" onPointerDown={onTrimDown('left')} />
      <div className="trim r" onPointerDown={onTrimDown('right')} />
      {boundStart || boundEnd ? <div className="meta" style={{ left: 'auto', right: 8, color: '#e0a94b' }}>🔒</div> : null}
    </div>
  )
}

function AudioBlock({ cue, ppf, total, fps, selected, bound, onSelect, snapshot, apply, message }) {
  const [trimEdge, setTrimEdge] = React.useState('')
  const onBodyDown = (event) => {
    if (event.button !== 0) return
    event.stopPropagation(); onSelect()
    if (bound) { message('这条音轨被卡点绑定，位置不能直接移动；音量仍可调。'); return }
    snapshot()
    const startX = event.clientX, origin = cue.from
    const move = (ev) => {
      const frame = clamp(origin + Math.round((ev.clientX - startX) / ppf), 0, total - cue.durationInFrames)
      try { apply(editCue(LIVE_TIMELINE, cue.id, { from: frame })) } catch (error) { message(error.message) }
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const onTrimDown = (edge) => (event) => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    if (bound) { message('这条音轨被卡点绑定，位置和长度不能直接改；音量仍可调。'); return }
    snapshot(); setTrimEdge(edge)
    const startX = event.clientX
    const originFrom = cue.from, originDuration = cue.durationInFrames, originTrim = Number(cue.trimStart) || 0
    const move = (ev) => {
      const delta = Math.round((ev.clientX - startX) / ppf)
      try {
        if (edge === 'left') {
          const nextFrom = clamp(originFrom + delta, 0, originFrom + originDuration - 1)
          const shift = nextFrom - originFrom
          apply(editCue(LIVE_TIMELINE, cue.id, { from: nextFrom, durationInFrames: originDuration - shift, trimStart: Math.max(0, originTrim + shift / fps) }))
        } else {
          const nextDuration = clamp(originDuration + delta, 1, total - cue.from)
          apply(editCue(LIVE_TIMELINE, cue.id, { durationInFrames: nextDuration }))
        }
      } catch (error) { message(error.message) }
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setTrimEdge('') }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  return (
    <div className={'wb-clip audio ' + (cue.role || 'sfx') + (selected ? ' selected' : '') + (bound ? ' bound' : '')}
      style={{ left: cue.from * ppf, width: Math.max(8, cue.durationInFrames * ppf) }}
      onPointerDown={onBodyDown} title={cue.file}>
      <div className="label">{cue.role === 'voice' ? '旁白' : cue.role === 'bgm' ? '配乐' : '音效'} · {cue.file?.split('/').pop()}</div>
      <div className="meta">{(cue.durationInFrames / fps).toFixed(2)}s · {Number(cue.gainDb || 0).toFixed(0)}dB {bound ? '🔒' : ''}</div>
      <div className="trim l" onPointerDown={onTrimDown('left')} />
      <div className="trim r" onPointerDown={onTrimDown('right')} />
    </div>
  )
}

// 事件处理器里读最新 timeline：避免闭包拿到指针按下那一刻的旧 state。
let LIVE_TIMELINE = null

export function registerWorkbenchRoot(scenes) {
  const root = createRoot(document.getElementById('root'))
  root.render(<App scenes={scenes} />)
}
