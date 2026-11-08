import React from 'react'
import { registerRoot, Composition, AbsoluteFill, Sequence, Audio, staticFile, delayRender, continueRender, cancelRender } from 'remotion'
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

export function registerMotionRoot(scenes) {
  function Movie({ plan, assets }) {
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
        {plan.shots.map((shot) => {
          const Component = scenes[shot.id]
          if (shot.recipeId !== 'scene' || !Component) throw new Error('场景组件缺失：' + shot.id)
          const allowed = Object.fromEntries(shot.referenceIds.map((id) => [id, assets[id] || []]))
          // render 是这条片子的渲染规格（samples / shutter / scale）：场景按它决定
          // 累积几个子帧、开多久快门，不要自己写死数字——写死了改规格就没人跟着改。
          return <Sequence key={shot.id} from={shot.startFrame} durationInFrames={shot.durationInFrames ?? shot.durationFrames}><Component shot={shot} anchors={shot.anchors || {}} assets={allowed} render={plan.render || {}} /></Sequence>
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
  function Root() {
    return <Composition id="DrawAiMotion" component={Movie} width={1280} height={720} fps={30} durationInFrames={90} defaultProps={defaults}
      calculateMetadata={({ props }) => ({ width: props.plan.width, height: props.plan.height, fps: props.plan.fps, durationInFrames: props.plan.durationFrames })} />
  }
  registerRoot(Root)
}
