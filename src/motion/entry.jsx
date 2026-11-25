import React from 'react'
import { registerRoot, Composition, AbsoluteFill, Sequence, Audio, staticFile, delayRender, continueRender, cancelRender, useCurrentFrame } from 'remotion'
const defaults = { plan: { width: 1280, height: 720, fps: 30, durationFrames: 90, shots: [], audio: [] }, assets: {} }

// 音频条目的增益曲线：dB → 线性，再叠淡入淡出。
// volume 回调收到的是"本条 Audio 自己的局部帧"（从 0 开始）。
function gainOf(cue, local) {
  let gain = Math.pow(10, (Number(cue.gainDb) || 0) / 20)
  if (cue.fadeIn > 0) gain *= Math.min(1, local / cue.fadeIn)
  if (cue.fadeOut > 0) gain *= Math.min(1, (cue.durationInFrames - local) / cue.fadeOut)
  return Math.max(0, Math.min(4, gain))
}

// 旁白避让：进入旁白区间压到 -12dB，两端各留 6 帧斜坡。
function duckFactor(local, windows, depthDb, ramp) {
  const depth = Math.pow(10, depthDb / 20)
  let factor = 1
  for (const window of windows) {
    if (local >= window.from && local <= window.to) factor = Math.min(factor, depth)
    else if (local >= window.from - ramp && local < window.from) {
      factor = Math.min(factor, 1 - (1 - depth) * ((local - (window.from - ramp)) / ramp))
    } else if (local > window.to && local <= window.to + ramp) {
      factor = Math.min(factor, depth + (1 - depth) * ((local - window.to) / ramp))
    }
  }
  return factor
}

/**
 * 片段可见窗口。外层 Sequence 按**源时长**铺开，所以 useVideoConfig().durationInFrames
 * 仍是整个场景的长度——右裁之后，场景自己的收尾动画不会提前；裁剪只在这里隐藏画面。
 * useCurrentFrame() 是源局部帧：时间轴起点对应 inOffset。
 */
function ClipGate({ clip, children }) {
  const frame = useCurrentFrame()
  const inOffset = Math.max(0, Number(clip.inOffset) || 0)
  const duration = Math.max(1, Number(clip.durationFrames) || 1)
  if (frame < inOffset || frame >= inOffset + duration) return null
  return children
}

/**
 * 画面 + 声音的唯一合成器。正式渲染（registerMotionRoot）和浏览器预览（Remotion Player）
 * 都用这个组件，保证轨道顺序、透明度、裁剪与声音语义一致。
 *
 * plan.shots 是片段实例，不是场景来源：
 *   { id, sourceId, startFrame, durationFrames, sourceDurationFrames, inOffset, opacity, anchors, referenceIds }
 */
export function MotionMovie({ plan, assets = {}, scenes }) {
  const [fontWait] = React.useState(() => plan.bundledFonts ? delayRender('加载内置中文字体') : null)
  React.useEffect(() => {
    if (fontWait === null) return
    Promise.all([document.fonts.load('400 16px "Noto Sans SC"'), document.fonts.load('400 16px "Noto Serif SC"')])
      .then(() => document.fonts.ready).then(() => continueRender(fontWait)).catch(error => cancelRender(error))
  }, [fontWait])
  const fps = plan.fps || 30
  const audio = Array.isArray(plan.audio) ? plan.audio : []
  const voices = audio.filter((cue) => cue.role === 'voice')
    .map((cue) => ({ from: Math.max(0, cue.from - 4), to: cue.from + cue.durationInFrames + 8 }))
  return (
    <AbsoluteFill>
      {plan.bundledFonts && <style>{(plan.fontFaces || []).map(face => `@font-face{font-family:${JSON.stringify(face.family)};src:url(${JSON.stringify(staticFile('fonts/' + face.file))}) format("truetype");font-weight:${face.weight};font-style:${face.style};font-display:block}`).join('\n')}</style>}
      {plan.shots.map((clip) => {
        const sourceId = clip.sourceId || clip.id
        const Component = scenes[sourceId]
        if (clip.recipeId !== 'scene' || !Component) throw new Error('场景组件缺失：' + sourceId)
        const allowed = Object.fromEntries((clip.referenceIds || []).map((id) => [id, assets[id] || []]))
        const duration = Math.max(1, Number(clip.durationFrames) || 1)
        const inOffset = Math.max(0, Number(clip.inOffset) || 0)
        const sceneDuration = Math.max(Number(clip.sceneDurationFrames) || 0, Number(clip.sourceDurationFrames) || duration, inOffset + duration)
        // 场景看到的 shot.durationFrames 是**源时间语义**（右裁仍保留原收尾、拉长按新长度），
        // 片段在时间轴上的长度另给 clipDurationFrames。
        const shot = { ...clip, id: sourceId, clipId: clip.id, durationFrames: sceneDuration,
          sourceDurationFrames: Number(clip.sourceDurationFrames) || sceneDuration,
          clipDurationFrames: duration, inOffset, anchors: clip.anchors || {} }
        return (
          <Sequence key={clip.id} from={clip.startFrame - inOffset} durationInFrames={sceneDuration}>
            <ClipGate clip={clip}>
              <AbsoluteFill style={{ opacity: clip.opacity === undefined ? 1 : clip.opacity }}>
                <Component shot={shot} anchors={clip.anchors || {}} assets={allowed} render={plan.render || {}} />
              </AbsoluteFill>
            </ClipGate>
          </Sequence>
        )
      })}
      {audio.map((cue) => {
        const local = cue.duck ? voices.map((window) => ({ from: window.from - cue.from, to: window.to - cue.from })) : []
        return (
          <Sequence key={cue.id} from={cue.from} durationInFrames={cue.durationInFrames}>
            <Audio
              src={staticFile(cue.file)}
              startFrom={Math.max(0, Math.round((Number(cue.trimStart) || 0) * fps))}
              loop={cue.loop === true}
              volume={(frame) => gainOf(cue, frame) * (cue.duck ? duckFactor(frame, local, -12, 6) : 1)}
            />
          </Sequence>
        )
      })}
    </AbsoluteFill>
  )
}

export function registerMotionRoot(scenes) {
  function Movie({ plan, assets }) {
    return <MotionMovie plan={plan} assets={assets} scenes={scenes} />
  }
  function Root() {
    return <Composition id="DrawAiMotion" component={Movie} width={1280} height={720} fps={30} durationInFrames={90} defaultProps={defaults}
      calculateMetadata={({ props }) => ({ width: props.plan.width, height: props.plan.height, fps: props.plan.fps, durationInFrames: props.plan.durationFrames })} />
  }
  registerRoot(Root)
}
