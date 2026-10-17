/** Playback is transient: no document mutations or undo entries. */
function createVideoController(request, environment = {}) {
  const raf = environment.raf || ((fn) => requestAnimationFrame(fn))
  const caf = environment.caf || ((id) => cancelAnimationFrame(id))
  const now = environment.now || (() => performance.now())
  const makeUrl = environment.makeUrl || ((source) => {
    const bytes = Uint8Array.from(atob(source.base64), (c) => c.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: source.mime || 'video/webm' }))
  })
  const revoke = environment.revoke || ((url) => URL.revokeObjectURL(url))
  const sessions = new Map()
  const listeners = new Set()
  let activeId = null
  let generation = 0
  let animation = null
  let element = null
  let elementPositioned = false
  let anchor = 0
  let anchorTime = 0
  const idle = Object.freeze({ status: 'idle', time: 0, duration: 0, index: 0, loop: true, muted: false, fit: 'contain', expanded: false })
  const get = (id) => sessions.get(id) || idle
  const emit = () => listeners.forEach((fn) => fn())
  const patch = (id, values) => {
    if (!sessions.has(id)) return
    sessions.set(id, Object.assign({}, get(id), values))
    emit()
  }
  const cancel = () => {
    if (animation !== null) caf(animation)
    animation = null
  }
  const svgTime = (state, ts = now()) => Math.max(0, state.audio && state.audio.readyState >= 2 && !state.audio.paused
    ? state.audio.currentTime - state.sourceOffset : anchorTime + (ts - anchor) / 1000)
  /** 时间 → 帧号：上下都钳制，避免负时间/空序列算出 -1 再显示成「第 0/-n 帧」。 */
  function frameIndexOf(state, time) {
    const last = Math.max(0, (state.frames && state.frames.length ? state.frames.length : 1) - 1)
    return Math.max(0, Math.min(last, Math.floor(Math.max(0, Number(time) || 0) * (Number(state.fps) > 0 ? state.fps : 1))))
  }
  function clampFrameIndex(state, index) {
    const last = Math.max(0, (state.frames && state.frames.length ? state.frames.length : 1) - 1)
    const i = Math.floor(Number(index))
    return Number.isFinite(i) ? Math.max(0, Math.min(last, i)) : 0
  }
  function wrapSvgTime(state, elapsed) {
    const time = Math.max(0, elapsed)
    if (!(state.duration > 0)) return 0
    return state.loop ? time % state.duration : Math.min(state.duration, time)
  }
  function seekAudio(state, time) {
    if (state.audio) { try { state.audio.currentTime = state.sourceOffset + time } catch {} }
  }
  function disposeAudio(state) {
    if (state.audio) { state.audio.pause(); state.audio.removeAttribute('src'); state.audio.load() }
    if (state.audioUrl) revoke(state.audioUrl)
  }
  // 长序列按播放位置预取，最多保留 48 帧 SVG 内容，避免全片驻留内存。
  function loadSvgWindow(id, index) {
    const state = get(id), cache = state.cache
    if (!cache) return Promise.resolve()
    index = clampFrameIndex(state, index)
    cache.wanted = index
    if (cache.loading) return cache.loading
    const valid = () => get(id).cache === cache
    const indices = Array.from({ length: Math.min(12, Math.max(0, state.frames.length - index)) }, (_, i) => index + i)
      .filter((i) => i >= 0 && i < state.frames.length && !state.frames[i])
    if (!indices.length) return Promise.resolve()
    let cursor = 0
    cache.loading = Promise.all(Array.from({ length: Math.min(4, indices.length) }, async () => {
      while (cursor < indices.length && valid()) {
        const i = indices[cursor++]
        const frame = await request('media-frame', { clip: state.clip, index: i })
        if (!valid()) return
        if (!frame || typeof frame.svg !== 'string') throw new Error('读取第 ' + (i + 1) + ' 帧失败')
        const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(frame.svg)
        state.frames[i] = uri; cache.entries.set(i, uri)
        while (cache.entries.size > 48) {
          const currentIndex = get(id).index
          const remove = Array.from(cache.entries.keys()).sort((a, b) => Math.abs(b - currentIndex) - Math.abs(a - currentIndex))[0]
          cache.entries.delete(remove); delete state.frames[remove]
        }
        const currentFrame = state.frames[get(id).index]
        patch(id, currentFrame ? { lastFrame: currentFrame } : {})
      }
    })).catch((error) => {
      if (valid()) { if (id === activeId) cancel(); if (state.audio) state.audio.pause(); patch(id, { status: 'error', error: error.message || String(error) }) }
      throw error
    }).finally(() => {
      cache.loading = null
      if (valid() && get(id).status !== 'error' && cache.wanted !== index) loadSvgWindow(id, cache.wanted).catch(() => {})
    })
    return cache.loading
  }
  function pause(id = activeId) {
    if (id !== activeId) return
    generation += 1
    cancel()
    const state = get(id)
    if (element) {
      if (elementPositioned) patch(id, { time: element.currentTime })
      element.pause()
    }
    if (state.status === 'playing' && state.kind === 'svg') {
      const time = wrapSvgTime(state, svgTime(state))
      patch(id, { time, index: frameIndexOf(state, time) })
    }
    if (state.audio) state.audio.pause()
    if (state.status === 'playing') patch(id, { status: 'paused' })
    if (state.status === 'loading') patch(id, { status: 'idle' })
  }
  function tick(ts) {
    animation = null
    const state = get(activeId)
    if (state.status !== 'playing' || state.kind !== 'svg') return
    let time = svgTime(state, ts)
    if (time >= state.duration) {
      if (!state.loop) {
        if (state.audio) state.audio.pause()
        const endIndex = frameIndexOf(state, state.duration)
        patch(activeId, { status: 'ended', time: state.duration, index: endIndex })
        loadSvgWindow(activeId, endIndex).catch(() => {})
        return
      }
      time = wrapSvgTime(state, time)
      anchor = ts
      anchorTime = time
      seekAudio(state, time)
      if (state.audio) playElement(activeId, state.audio)
    }
    const index = frameIndexOf(state, time)
    if (index !== state.index || Math.abs(time - state.time) >= 0.1) patch(activeId, Object.assign({ time, index }, state.frames[index] ? { lastFrame: state.frames[index] } : {}))
    if (state.cache) loadSvgWindow(activeId, index).catch(() => {})
    animation = raf(tick)
  }
  function resume(id) {
    const state = get(id)
    if (state.status === 'ended') seek(id, 0)
    patch(id, { status: 'playing', error: '' })
    if (state.kind === 'svg') {
      if (state.cache) loadSvgWindow(id, state.index).catch(() => {})
      cancel()
      anchor = now()
      anchorTime = get(id).time
      seekAudio(state, anchorTime)
      if (state.audio) { state.audio.muted = state.muted; playElement(id, state.audio) }
      animation = raf(tick)
    } else if (element && elementPositioned) {
      playElement(id, element)
    }
  }
  function playElement(id, video) {
    const promise = video.play()
    if (promise && typeof promise.catch === 'function') promise.catch((error) => {
      if ((element === video || get(id).audio === video) && activeId === id && get(id).status === 'playing' && error.name !== 'AbortError') {
        pause(id)
        patch(id, { status: 'paused', error: '播放失败，请点击重试：' + error.message })
      }
    })
  }
  function positionElement(id, video) {
    if (video.readyState < 1 || elementPositioned) return
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const time = duration > 0 ? Math.min(get(id).time, duration) : get(id).time
    video.currentTime = time
    elementPositioned = true
    patch(id, { duration, time })
    if (get(id).status === 'playing') playElement(id, video)
  }
  async function play(node, meta) {
    const id = node.id
    if (!meta) {
      sessions.set(id, Object.assign({}, idle, { id, status: 'error', error: '视频缺少媒体信息，请重新导入' }))
      emit()
      return
    }
    if (activeId !== id) {
      pause()
      if (activeId !== null) patch(activeId, { expanded: false, active: false })
      element = null
      activeId = id
    }
    const previous = get(id)
    patch(id, { active: true })
    if (previous.status === 'loading') return
    if (previous.status === 'playing' && previous.clip === meta.clip) return
    if (previous.clip === meta.clip && previous.kind && previous.status !== 'error' && previous.status !== 'idle') {
      resume(id)
      return
    }
    const token = ++generation
    if (previous.url) revoke(previous.url)
    disposeAudio(previous)
    sessions.set(id, Object.assign({}, idle, { id, clip: meta.clip, sourceKind: meta.kind, active: true, status: 'loading', expanded: previous.expanded, muted: previous.muted }))
    emit()
    const current = () => token === generation && activeId === id
    try {
      const info = await request('media-manifest', { clip: meta.clip })
      if (!current()) return
      if (!info) throw new Error('无法读取媒体，请检查画布是否已保存或重试')
      if (info.missing) throw new Error('媒体包缺失：' + meta.clip)
      const manifest = info.manifest || {}
      const frames = Array.isArray(manifest.frames) ? manifest.frames : []
      const fps = Number(manifest.fps) > 0 ? Number(manifest.fps) : meta.fps
      if (meta.kind === 'raster' || (info.hasSource && frames.length === 0)) {
        const source = await request('media-source-bytes', { clip: meta.clip })
        if (!current()) return
        if (!source) throw new Error('无法读取源视频')
        patch(id, { kind: 'raster', url: makeUrl(source), fps, status: 'ready' })
      } else {
        if (!frames.length) throw new Error('还没有 SVG 帧，请导入媒体或添加帧')
        const svgs = new Array(frames.length)
        if (frames.length > 48) {
          patch(id, { kind: 'svg', frames: svgs, fps, duration: frames.length / fps,
            cache: { entries: new Map(), wanted: 0, loading: null } })
          await loadSvgWindow(id, 0)
          if (!current()) return
          patch(id, { status: 'ready' })
        } else {
        let cursor = 0
        // Bounded concurrency keeps long sequences from opening hundreds of requests.
        await Promise.all(Array.from({ length: Math.min(4, frames.length) }, async () => {
          while (cursor < frames.length && current()) {
            const index = cursor++
            const frame = await request('media-frame', { clip: meta.clip, index })
            if (!current()) return
            if (!frame || typeof frame.svg !== 'string') throw new Error('读取第 ' + (index + 1) + ' 帧失败')
            svgs[index] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(frame.svg)
          }
        }))
        if (!current()) return
        patch(id, { kind: 'svg', frames: svgs, fps, duration: frames.length / fps, status: 'ready' })
        }
        if (info.hasSource) {
          const source = await request('media-source-bytes', { clip: meta.clip })
          if (!current()) return
          if (!source) throw new Error('无法读取复刻视频的音频来源')
          const audio = environment.createAudio ? environment.createAudio() : document.createElement('audio')
          const audioUrl = makeUrl(source)
          audio.preload = 'auto'; audio.src = audioUrl; audio.muted = get(id).muted
          patch(id, { audio, audioUrl, sourceOffset: Number(manifest.sourceOffset) || 0 })
          audio.onloadedmetadata = () => { if (get(id).audio === audio) seekAudio(get(id), get(id).time) }
          audio.onerror = () => { if (get(id).audio === audio) { pause(id); patch(id, { error: '音频解码失败，请检查原视频格式' }) } }
        }
      }
      resume(id)
    } catch (error) {
      if (current()) {
        generation += 1
        patch(id, { status: 'error', error: error.message || String(error) })
      }
    }
  }
  function seek(id, value) {
    const state = get(id)
    if (!state.kind || state.status === 'loading' || state.status === 'error') return
    const time = Math.max(0, Math.min(state.duration, Number(value) || 0))
    patch(id, { time, index: state.kind === 'svg' ? frameIndexOf(state, time) : 0,
      status: state.status === 'ended' ? 'paused' : state.status })
    if (state.cache) loadSvgWindow(id, get(id).index).catch(() => {})
    if (id === activeId) {
      anchor = now()
      anchorTime = time
      seekAudio(state, time)
      if (element && element.readyState >= 1) element.currentTime = time
    }
  }
  function release(id) {
    if (id === activeId) {
      pause(id)
      element = null
      activeId = null
    }
    const state = get(id)
    if (state.url) revoke(state.url)
    disposeAudio(state)
    sessions.delete(id)
    emit()
  }
  return {
    get,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    play,
    pause,
    toggle(node, meta) { return get(node.id).status === 'playing' ? pause(node.id) : play(node, meta) },
    seek,
    stop(id) { pause(id); seek(id, 0) },
    step(id, delta) { const s = get(id); if (s.kind === 'svg') { pause(id); seek(id, (s.index + delta) / s.fps) } },
    configure(id, values) {
      patch(id, values)
      if (id === activeId && element && 'loop' in values) element.loop = values.loop
      if (id === activeId && element && 'muted' in values) element.muted = values.muted
      if (get(id).audio && 'muted' in values) get(id).audio.muted = values.muted
    },
    /** 当前画面：源视频为 PNG data URI，SVG 视频为当前帧标记。 */
    still(id) {
      const state = get(id)
      if (state.kind === 'svg') {
        const uri = state.frames && state.frames[state.index]
        if (typeof uri !== 'string' || uri.length === 0) throw new Error('当前帧正在加载，请稍后再抽帧')
        return { kind: 'svg', markup: decodeURIComponent(uri.split(',').slice(1).join(',')) }
      }
      if (state.kind !== 'raster' || id !== activeId || !element || element.readyState < 2 || !element.videoWidth) {
        throw new Error('请稍候，当前画面尚未解码')
      }
      const canvas = document.createElement('canvas')
      canvas.width = element.videoWidth
      canvas.height = element.videoHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法导出当前帧')
      context.drawImage(element, 0, 0)
      return { kind: 'raster', png: canvas.toDataURL('image/png') }
    },
    poster(id) {
      const state = get(id)
      if (state.kind === 'svg') {
        if (!state.frames[state.index]) throw new Error('当前帧正在加载，请稍后再设为封面')
        return decodeURIComponent(state.frames[state.index].split(',').slice(1).join(','))
      }
      if (id !== activeId || !element || element.readyState < 2) throw new Error('请先播放视频，再设置封面')
      const canvas = document.createElement('canvas')
      canvas.width = element.videoWidth
      canvas.height = element.videoHeight
      canvas.getContext('2d').drawImage(element, 0, 0)
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + canvas.width + ' ' + canvas.height + '"><image width="100%" height="100%" href="' + canvas.toDataURL('image/png') + '"/></svg>'
    },
    attach(id, video) {
      if (id !== activeId) return
      if (element === video) return
      if (element) {
        const previous = element
        if (elementPositioned) patch(id, { time: previous.currentTime })
        element = null
        previous.pause()
      }
      element = video
      elementPositioned = false
      if (!video) return
      video.loop = get(id).loop
      video.muted = get(id).muted
      positionElement(id, video)
    },
    detach(id, video) {
      if (id !== activeId || element !== video || !video) return
      if (elementPositioned) patch(id, { time: video.currentTime })
      element = null
      elementPositioned = false
      video.pause()
    },
    mediaEvent(id, video, type) {
      if (id !== activeId || element !== video) return
      const s = get(id)
      if (type === 'loadedmetadata') {
        positionElement(id, video)
      } else if (type === 'error') {
        patch(id, { status: 'error', error: '视频解码失败，请检查文件格式后重试' })
      } else if (!elementPositioned) {
        return
      } else if (type === 'ended') {
        patch(id, { status: 'ended', time: video.currentTime })
      } else if (type === 'timeupdate' || type === 'pause' || type === 'play') {
        patch(id, { time: video.currentTime, status: type === 'pause' && s.status === 'playing' ? 'paused' : type === 'play' ? 'playing' : s.status })
      }
    },
    suspend() { pause(); sessions.forEach((s, id) => { if (s.expanded) patch(id, { expanded: false }) }) },
    prune(nodes) {
      sessions.forEach((s, id) => {
        const n = nodes.find((node) => node.id === id)
        if (!n || !n.data || n.data.mediaClip !== s.clip || !['1', 1, true].includes(n.data.drawaiMedia) ||
          (n.data.mediaKind === 'raster' ? 'raster' : 'svg') !== s.sourceKind) release(id)
      })
    },
    reset() { Array.from(sessions.keys()).forEach(release); generation += 1 },
    expanded() { return Array.from(sessions.values()).find((s) => s.expanded) || null },
  }
}

function useVideoSnapshot(controller, id) {
  const [state, setState] = React.useState(() => ({ id, value: controller.get(id) }))
  React.useEffect(() => {
    const sync = () => {
      const value = controller.get(id)
      setState((old) => old.id === id && old.value === value ? old : { id, value })
    }
    sync()
    return controller.subscribe(sync)
  }, [controller, id])
  return state.id === id ? state.value : controller.get(id)
}

function videoTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0))
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0')
}

function VideoSurface(props) {
  const { controller, node, meta, poster, preview } = props
  const state = useVideoSnapshot(controller, node.id)
  const videoRef = React.useRef(null)
  const hoverState = React.useState(false)
  const hovered = hoverState[0]
  const setHovered = hoverState[1]
  React.useEffect(() => {
    if (!state.active || state.kind !== 'raster' || (!preview && state.expanded)) return
    const video = videoRef.current
    controller.attach(node.id, video)
    return () => controller.detach(node.id, video)
  }, [controller, node.id, state.url, state.expanded, state.active, preview])
  let media
  const mediaStyle = { width: '100%', height: '100%', objectFit: state.fit, display: 'block', pointerEvents: 'none' }
  if (state.kind === 'raster' && state.url && (preview || !state.expanded)) {
    const events = {}
    for (const type of ['loadedmetadata', 'timeupdate', 'ended', 'error', 'pause', 'play']) {
      const name = { loadedmetadata: 'onLoadedMetadata', timeupdate: 'onTimeUpdate', ended: 'onEnded', error: 'onError', pause: 'onPause', play: 'onPlay' }[type]
      events[name] = (event) => controller.mediaEvent(node.id, event.currentTarget, type)
    }
    media = React.createElement('video', Object.assign({ ref: videoRef, src: state.url, muted: state.muted, playsInline: true, loop: state.loop, style: mediaStyle }, events))
  } else {
    media = React.createElement('img', { src: state.kind === 'svg' ? state.frames[state.index] || state.lastFrame || poster : poster, alt: '', draggable: false, style: mediaStyle })
  }
  const loading = state.status === 'loading'
  const playing = state.status === 'playing'
  const ready = !!state.kind && !['idle', 'loading', 'error'].includes(state.status)
  // 中央播放/暂停与底部进度条均仅悬停时显示；加载中/出错时保留可点的中央按钮。
  const showCenter = preview ? !playing : (hovered || loading || !!state.error)
  const showChrome = !preview && hovered && state.status !== 'loading' && !state.error
  const stopBubble = (event) => event.stopPropagation()
  const centerLabel = loading ? '正在加载视频' : state.error ? '重试播放' : playing ? '暂停视频' : '播放视频'
  const centerTitle = loading ? '正在加载' : state.error ? '重试播放' : playing ? '暂停视频' : '播放视频'
  return React.createElement('div', {
    xmlns: 'http://www.w3.org/1999/xhtml', className: 'drawai-video-surface' + (hovered ? ' is-hovered' : ''),
    onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false),
  }, media,
    showCenter ? React.createElement('button', {
      type: 'button', className: 'drawai-video-play', disabled: loading,
      title: centerTitle, 'aria-label': centerLabel,
      onPointerDown: stopBubble, onDoubleClick: stopBubble,
      onClick: (event) => {
        event.stopPropagation()
        if (playing) { controller.pause(node.id); return }
        if (props.onPlay) props.onPlay()
        controller.play(node, meta)
      },
    }, loading ? '…' : state.error ? '重试' : playing ? '❚❚' : '▶') : null,
    showChrome ? React.createElement('div', {
      className: 'drawai-video-chrome', role: 'group', 'aria-label': '节点播放控制',
      onPointerDown: stopBubble, onDoubleClick: stopBubble,
    },
      React.createElement('button', {
        type: 'button', className: 'drawai-video-chrome-toggle',
        title: playing ? '暂停' : '播放', 'aria-label': playing ? '暂停' : '播放',
        onClick: (event) => {
          event.stopPropagation()
          if (!playing && props.onPlay) props.onPlay()
          controller.toggle(node, meta)
        },
      }, playing ? '❚❚' : '▶'),
      React.createElement('input', {
        type: 'range', className: 'drawai-video-chrome-progress',
        min: 0, max: state.duration || 0, step: state.kind === 'svg' ? 1 / (state.fps || 1) : 0.01,
        value: state.time || 0, disabled: !ready || !state.duration, 'aria-label': '播放进度',
        onChange: (event) => controller.seek(node.id, event.target.value),
      }),
      React.createElement('span', { className: 'drawai-video-chrome-time' }, videoTime(state.time) + ' / ' + videoTime(state.duration)),
    ) : null,
    state.error ? React.createElement('div', { className: 'drawai-video-message', role: 'status' }, state.error) : null,
    !preview && state.expanded ? React.createElement('div', { className: 'drawai-video-message' }, '正在放大预览') : null,
  )
}

function VideoControls(props) {
  const { controller, node, meta, actions } = props
  const state = useVideoSnapshot(controller, node.id)
  const ready = !!state.kind && !['idle', 'loading', 'error'].includes(state.status)
  const button = (text, title, click, disabled = false) => React.createElement('button', { type: 'button', title, disabled, onClick: click }, text)
  if (props.compact) {
    const icon = (kind) => React.createElement('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: kind === 'draw' ? 'M14 4l6 6M5 15L17 3l4 4L9 19H5v-4zM3 21h7' : kind === 'preview' ? 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5' : kind === 'frame' ? 'M4 5h16v14H4zM8 5v14M4 9h4M4 15h4' : 'M12 3v12m-4-4l4 4 4-4M4 16v5h16v-5' }))
    const run = (action) => Promise.resolve().then(action.run).catch(props.onError)
    const primary = (actions || []).find((action) => action.primary && (!action.mediaKind || action.mediaKind === meta?.kind))
    const grab = (actions || []).find((action) => action.grab)
    const exports = (actions || []).filter((action) => action.export && (!action.mediaKind || action.mediaKind === meta?.kind))
    const face = (kind, label) => [React.createElement('span', { key: 'icon', className: 'drawai-tool-icon', style: { paddingRight: 0 } }, icon(kind)),
      React.createElement('span', { key: 'label', className: 'drawai-color-label' }, label)]
    return React.createElement('div', { className: 'drawai-video-actions', role: 'toolbar', 'aria-label': '视频操作',
      onPointerDown: (event) => event.stopPropagation(), onDoubleClick: (event) => event.stopPropagation(),
      onKeyDown: (event) => { event.stopPropagation(); if (event.key === 'Escape') for (const menu of event.currentTarget.querySelectorAll('details[open]')) menu.open = false },
    },
    primary ? props.renderDraw ? props.renderDraw(primary, state, icon('draw')) : React.createElement('button', { type: 'button', className: 'drawai-toolbar-button', 'aria-label': '绘制复刻', title: '设置画质、帧率和范围，绘制 SVG 视频', disabled: primary.disabled(state), onClick: () => run(primary) }, face('draw', '绘制复刻')) : null,
    React.createElement('button', { type: 'button', className: 'drawai-toolbar-button', 'aria-label': '预览', title: '打开视频预览', disabled: state.status === 'loading', onClick: () => run({ run: async () => {
      if (!ready) await controller.play(node, meta)
      if (controller.get(node.id).kind) controller.configure(node.id, { expanded: true })
    } }) }, face('preview', '预览')),
    grab ? React.createElement('button', { type: 'button', className: 'drawai-toolbar-button', 'aria-label': '抽帧', title: '把当前画面抽成图像节点', disabled: grab.disabled(state), onClick: () => run(grab) }, face('frame', '抽帧')) : null,
    exports.length ? props.renderExport ? props.renderExport(exports, state, run, icon('export')) : React.createElement('details', { className: 'drawai-color-palette', onPointerEnter: (event) => { event.currentTarget.open = true } },
      React.createElement('summary', { title: '导出视频', 'aria-label': '导出' }, face('export', '导出')),
      React.createElement('div', { className: 'drawai-video-export-menu', role: 'group', 'aria-label': '视频导出' }, exports.map((action) => React.createElement('button', {
        key: action.label, type: 'button', disabled: action.disabled(state), onClick: (event) => { event.currentTarget.closest('details').open = false; run(action) },
      }, action.label)))) : null)
  }
  return React.createElement('div', { className: 'drawai-video-controls', role: 'toolbar', 'aria-label': '视频控制',
    onPointerDown: (event) => event.stopPropagation(), onDoubleClick: (event) => event.stopPropagation(), onKeyDown: (event) => event.stopPropagation(),
  },
  button(state.status === 'playing' ? '暂停' : state.status === 'loading' ? '加载中…' : '播放', '播放 / 暂停', () => controller.toggle(node, meta), state.status === 'loading'),
  button('停止', '停止并回到开头', () => controller.stop(node.id), !ready),
  button(state.muted ? '开启声音' : '静音', '切换视频声音', () => controller.configure(node.id, { muted: !state.muted }), !ready),
  button('‹', '上一帧', () => controller.step(node.id, -1), !ready || state.kind !== 'svg'),
  button('›', '下一帧', () => controller.step(node.id, 1), !ready || state.kind !== 'svg'),
  React.createElement('input', { type: 'range', min: 0, max: state.duration || 0, step: state.kind === 'svg' ? 1 / state.fps : 0.01,
    value: state.time, disabled: !ready || !state.duration, 'aria-label': '播放进度', onChange: (event) => controller.seek(node.id, event.target.value) }),
  React.createElement('span', { className: 'drawai-video-time' }, videoTime(state.time) + ' / ' + videoTime(state.duration)),
  React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked: state.loop, disabled: !ready, onChange: (event) => controller.configure(node.id, { loop: event.target.checked }) }), '循环'),
  React.createElement('select', { value: state.fit, disabled: !ready, 'aria-label': '画面适配', onChange: (event) => controller.configure(node.id, { fit: event.target.value }) },
    ['contain', 'cover', 'fill'].map((fit, i) => React.createElement('option', { key: fit, value: fit }, ['等比适配', '裁切填满', '拉伸'][i]))),
  button(state.expanded ? '收起' : '放大', '放大预览', async () => { if (!ready) await controller.play(node, meta); if (controller.get(node.id).kind) controller.configure(node.id, { expanded: !controller.get(node.id).expanded }) }),
  actions ? React.createElement('details', { className: 'drawai-video-more' }, React.createElement('summary', null, '更多'),
    React.createElement('div', null, actions.map((action) => React.createElement('button', { key: action.label, type: 'button', disabled: action.disabled(state), onClick: (event) => {
      event.currentTarget.closest('details').open = false
      Promise.resolve().then(action.run).catch(props.onError)
    } }, action.label)))) : null,
  state.kind === 'svg' ? React.createElement('span', null, (state.index + 1) + ' / ' + state.frames.length + ' 帧') : null,
  state.error ? React.createElement('span', { role: 'status' }, state.error) : null,
  )
}

function VideoPreview(props) {
  const [expanded, setExpanded] = React.useState(() => props.controller.expanded())
  React.useEffect(() => props.controller.subscribe(() => {
    const next = props.controller.expanded()
    setExpanded((old) => old && next && old.id === next.id ? old : next)
  }), [props.controller])
  const closeRef = React.useRef(null)
  React.useEffect(() => {
    if (!expanded) return
    const previous = document.activeElement
    if (closeRef.current) closeRef.current.focus()
    return () => { if (previous && previous.isConnected) previous.focus() }
  }, [expanded && expanded.id])
  if (!expanded) return null
  const node = props.nodes.find((n) => n.id === expanded.id)
  if (!node) return null
  const close = () => props.controller.configure(node.id, { expanded: false })
  return React.createElement('div', { className: 'drawai-video-preview', role: 'dialog', 'aria-modal': true, 'aria-label': '视频预览',
    onPointerDown: (event) => event.stopPropagation(), onDoubleClick: (event) => event.stopPropagation(),
    onKeyDown: (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const items = Array.from(event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary'))
        const index = items.indexOf(document.activeElement)
        if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus() }
        else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0].focus() }
      }
    },
  }, React.createElement('button', { ref: closeRef, type: 'button', className: 'drawai-video-close', onClick: close }, '关闭预览 ×'),
  React.createElement('div', { className: 'drawai-video-preview-media' }, React.createElement(VideoSurface, { controller: props.controller, node, meta: props.metaOf(node), poster: props.posterOf(node), preview: true })),
  React.createElement(VideoControls, { controller: props.controller, node, meta: props.metaOf(node) }))
}

export { createVideoController, VideoSurface, VideoControls, VideoPreview }
