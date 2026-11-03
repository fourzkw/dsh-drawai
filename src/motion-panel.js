/* Included in the existing client factory; React and motionCore belong to that factory. */
function videoWorkbenchIcon(name) {
  const paths = { plus: 'M12 5v14M5 12h14', arrow: 'M12 19V5M6 11l6-6 6 6', settings: 'M4 7h6m4 0h6M4 17h10m4 0h2M10 4v6m4 4v6',
    video: 'M15 9l6-3v12l-6-3M5 5h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z',
    info: 'M12 11v6M12 7v.1', delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5',
    edit: 'M4 17v3h3L20 7l-3-3L4 17zM14 7l3 3', text: 'M5 5h14M12 5v15M8 20h8', image: 'M4 4h16v16H4zM4 17l5-5 4 4 3-3 4 4M8 8h.1' }
  return React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    name === 'info' ? React.createElement('circle', { cx: 12, cy: 12, r: 9 }) : null,
    React.createElement('path', { d: paths[name] || paths.video }))
}

function VideoNodeToolbar(props) {
  const [info, setInfo] = React.useState(false)
  const button = (icon, text, onClick) => React.createElement('button', { type: 'button', className: 'drawai-video-action', onClick }, videoWorkbenchIcon(icon), text)
  return React.createElement('div', { className: 'drawai-video-actions', role: 'toolbar', 'aria-label': '视频节点操作' },
    button('info', '信息', () => setInfo(!info)), button('delete', '删除', props.onDelete),
    button('edit', '编辑', props.onEdit), button('video', '上传视频', props.onUpload),
    info ? React.createElement('div', { className: 'drawai-video-info', role: 'status' },
      React.createElement('strong', null, props.node.label || '视频'),
      React.createElement('div', null, props.node.data.mediaClip ? '已添加视频内容' : '空视频节点'),
      React.createElement('div', null, Math.round(props.node.w) + ' × ' + Math.round(props.node.h)),
      React.createElement('small', null, props.node.id)) : null)
}

function MotionFilmReview({job,onLoad,onSave,onRevise}){
  const [url,setUrl]=React.useState(''),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[progress,setProgress]=React.useState({motion:0,sound:0}),[note,setNote]=React.useState(''),[confirmed,setConfirmed]=React.useState(false)
  const heard=React.useRef([]),previous=React.useRef(null),film=job.qa.film
  React.useEffect(()=>()=>{if(url)URL.revokeObjectURL(url)},[url])
  const coverage=ranges=>{
    const sorted=ranges.slice().sort((a,b)=>a[0]-b[0]);let end=0,total=0
    for(const [from,to]of sorted){total+=Math.max(0,to-Math.max(end,from));end=Math.max(end,to)}return total
  }
  const update=event=>{
    const v=event.currentTarget,now=performance.now(),last=previous.current,delta=last?v.currentTime-last.time:0
    if(last&&(!v.paused||v.ended)&&!v.muted&&v.volume>0&&delta>0&&delta<=Math.min(1.5,(now-last.wall)/1000*v.playbackRate+.15))heard.current.push([last.time,v.currentTime])
    previous.current={time:v.currentTime,wall:now}
    const played=Array.from({length:v.played.length},(_,i)=>[v.played.start(i),v.played.end(i)])
    setProgress({motion:coverage(played),sound:coverage(heard.current)})
  }
  const load=async()=>{
    setBusy(true);setError('')
    try{const result=await onLoad(job.clip),bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));setUrl(URL.createObjectURL(new Blob([bytes],{type:result.mime||'video/mp4'})));heard.current=[];previous.current=null;setProgress({motion:0,sound:0});setConfirmed(false)}catch(e){setError(e.message)}finally{setBusy(false)}
  }
  const save=async status=>{
    setBusy(true);setError('')
    try{await onSave(job.id,{status,sha256:film.sha256,motionSeconds:progress.motion,soundSeconds:progress.sound,note})}catch(e){setError(e.message)}finally{setBusy(false)}
  }
  const ready=progress.motion>=film.duration*.98&&(!film.audio.hasAudio||progress.sound>=film.duration*.98)
  return React.createElement('details',{className:'drawai-film-review'},
    React.createElement('summary',null,film.manual.status==='passed'?'全片回放验收已确认':film.manual.status==='changes-requested'?'全片验收要求修改':'全片运动与声音验收'),
    React.createElement('p',null,'全片解码：'+film.decode+' · 时序画面：'+film.motion.status+'（6帧/秒有序抽检）'),
    film.audio.hasAudio?React.createElement('p',null,'音轨：'+(film.audio.integratedLufs??'—')+' LUFS · 真峰值 '+(film.audio.truePeakDb??'—')+' dBFS。听感需完整有声回放确认。'):React.createElement('p',null,'成片无音轨。'),
    (film.warnings||[]).map((w,i)=>React.createElement('p',{key:i},(w.from===undefined?'':w.from.toFixed(2)+'秒：')+w.note)),
    (film.motion.sequences||[]).filter(s=>s.status!=='passed').map((s,i)=>React.createElement('p',{key:'issue'+i},s.from.toFixed(1)+'–'+s.to.toFixed(1)+'秒：'+(s.reason||JSON.stringify(s.issues)))),
    onLoad?React.createElement('button',{type:'button',className:'drawai-btn',disabled:busy,onClick:load},url?'重新加载成片':'加载完整成片回放'):null,
    url?React.createElement('video',{src:url,controls:true,playsInline:true,preload:'metadata','aria-label':'全片验收回放',style:{width:'100%',maxHeight:360},
      onTimeUpdate:update,onEnded:update,onPlay:e=>{previous.current={time:e.currentTarget.currentTime,wall:performance.now()}},onSeeking:()=>{previous.current=null},onVolumeChange:()=>{previous.current=null}}):null,
    url?React.createElement('p',{role:'status'},'已回放 '+progress.motion.toFixed(1)+'/'+film.duration.toFixed(1)+' 秒'+(film.audio.hasAudio?' · 已有声试听 '+progress.sound.toFixed(1)+' 秒':'')):null,
    React.createElement('textarea',{'aria-label':'成片验收意见',placeholder:'记录跳变、转场、节奏或声音问题及发生时间',value:note,onChange:e=>setNote(e.target.value),style:{width:'100%',minHeight:60}}),
    React.createElement('label',null,React.createElement('input',{type:'checkbox',checked:confirmed,onChange:e=>setConfirmed(e.target.checked)}),'我已检查整片运动、转场、信息可读性'+(film.audio.hasAudio?'及声音听感':'')),
    onSave?React.createElement('div',null,
      React.createElement('button',{type:'button',className:'drawai-btn',disabled:busy||!ready||!confirmed,onClick:()=>save('passed')},'确认全片验收通过'),
      React.createElement('button',{type:'button',className:'drawai-btn',disabled:busy||!note.trim(),onClick:()=>save('changes-requested')},'记录需修改问题')):null,
    film.manual.note?React.createElement('p',null,'验收记录：'+film.manual.note):null,
    film.manual.status==='changes-requested'&&onRevise?React.createElement('button',{type:'button',className:'drawai-btn',disabled:busy,onClick:onRevise},'按验收意见修改视频'):null,
    error?React.createElement('p',{role:'alert'},error):null)
}

function MotionPanel(props) {
  const motion = props.node.data.motion || {}
  const [error, setError] = React.useState('')
  const [starting, setStarting] = React.useState(false)
  const [editor, setEditor] = React.useState('')
  const [sceneEditors, setSceneEditors] = React.useState({})
  const refs = motionCore.motionReferenceEdges(props.doc, props.node.id)
  const jobs = props.jobs.filter((job) => job.nodeId === props.node.id && job.page === props.page)
  const running = jobs.find((job) => !['done', 'error', 'cancelled', 'interrupted', 'retained'].includes(job.status))
  const labels = { 'agent-thinking':'正在规划', 'agent-tool':'正在操作工程', 'sound-design':'编排声音', mixing:'混音中', 'awaiting-session': '准备任务', queued: '排队中', planning: '规划镜头', brief: '设计风格与分镜', storyboard: '分镜已确定', coding: '编写场景动画', reviewing: '检查镜头关键帧', repairing: '修复场景动画', bundling: '准备渲染', rendering: '渲染中', done: '已生成', retained: '成片已保留', error: '生成失败', cancelled: '已取消', interrupted: '任务已中断' }
  const roleLabels = { material: '成片素材', copy: '文案', instruction: '附加要求', style: '配色参考', layout: '布局参考', shotcard: '镜头参考', audio:'声音参考' }
  let stale = false
  if (motion.inputKey) { try { stale = motionCore.motionInputKey(motionCore.motionInput(props.doc, props.node.id)) !== motion.inputKey } catch { stale = true } }
  const run = async (composition) => {
    if (starting || running) return
    setStarting(true); setError('')
    try { await props.onGenerate(composition); setEditor(''); setSceneEditors({}) }
    catch (failure) { setError(String(failure.message || failure)) }
    finally { setStarting(false) }
  }
  const change = (key, value) => { setError(''); try { props.onChange({ [key]: value }) } catch (failure) { setError(failure.message) } }
  const candidates = props.doc.nodes.filter((node) => node.id !== props.node.id && !refs.some((edge) => edge.from === node.id))
  return React.createElement('div', { className: 'drawai-motion-panel drawai-video-composer', 'data-tone': props.mode || 'light',
    onPointerDown: (event) => event.stopPropagation(), onDoubleClick: (event) => event.stopPropagation(), onKeyDown: (event) => event.stopPropagation() },
    React.createElement('div', { className: 'drawai-video-reference-heading' }, '参考内容', props.onShotLibrary ? React.createElement('button', { type: 'button', className: 'drawai-btn', onClick: props.onShotLibrary }, '添加镜头卡') : null),
    React.createElement('div', { className: 'drawai-video-references' },
      refs.map((edge) => {
        const node = props.doc.nodes.find((item) => item.id === edge.from)
        const preview = node && props.previewOf?.(node)
        const role = roleLabels[motionCore.motionReferenceRole(props.doc, edge)] || '参考'
        return React.createElement('div', { key: edge.id, className: 'drawai-video-reference', title: (node?.label || edge.from) + ' · ' + role },
          preview ? React.createElement('img', { src: preview, alt: node?.label || '参考素材' }) : videoWorkbenchIcon(role === '文案' ? 'text' : 'image'),
          React.createElement('span', null, node?.label || edge.from), React.createElement('small', null, role))
      }),
      React.createElement('details', { className: 'drawai-video-ref-picker' },
        React.createElement('summary', { 'aria-label': '添加参考内容', title: '连接画布参考内容' }, videoWorkbenchIcon('plus')),
        React.createElement('div', { className: 'drawai-video-ref-menu' },
          React.createElement('strong', null, '从画布添加参考'),
          candidates.length ? candidates.map((node) => React.createElement('button', { key: node.id, type: 'button', className: 'drawai-choice-button',
            onClick: async (event) => { const details = event.currentTarget.closest('details'); try { await props.onReference?.(node.id); details.open = false } catch (failure) { setError(failure.message) } }
          }, node.label || node.id)) : React.createElement('p', null, '先在画布添加文字、图片或视频，再用箭头连接到此节点。')))),
    React.createElement('div', { className: 'drawai-video-reference-note', role: 'status', 'aria-label': '画布参考节点' },
      refs.length ? '已识别 ' + refs.length + ' 个参考节点' : '暂无参考节点，将画布元素用箭头连接到此视频即可自动引用。'),
    stale ? React.createElement('div', { role: 'status', className: 'drawai-export-info' }, '描述或参考已变化，当前播放的是上一版视频。') : null,
    React.createElement('textarea', { className: 'drawai-video-prompt', 'aria-label': '视频描述', placeholder: '描述要生成的视频内容',
      value: motion.prompt || '', onChange: (event) => change('prompt', event.target.value) }),
    React.createElement('div', { className: 'drawai-video-composer-footer' },
      React.createElement('details', { className: 'drawai-video-settings' },
        React.createElement('summary', { 'aria-label': '视频参数' }, videoWorkbenchIcon('settings'),
          motion.height + 'p · ' + (motion.width === motion.height ? '1:1' : motion.width > motion.height ? '16:9' : '9:16') + ' · ' + (motion.duration || 12) + 's'),
        React.createElement('div', { className: 'drawai-video-settings-menu' },
          React.createElement('label', null, '时长（秒）', React.createElement('input', { type: 'number', min: 2, max: 60, step: 'any', 'aria-label': '视频时长', value: motion.duration || 12,
            onChange: (event) => change('duration', Number(event.target.value)) })),
          React.createElement('label', null, '画面比例', React.createElement('select', { 'aria-label': '视频比例', value: motion.width === motion.height ? 'square' : motion.width > motion.height ? 'wide' : 'tall',
            onChange: (event) => props.onChange(event.target.value === 'square' ? { width: 720, height: 720 } : event.target.value === 'tall' ? { width: 720, height: 1280 } : { width: 1280, height: 720 }) },
            [['wide', '横屏'], ['tall', '竖屏'], ['square', '方形']].map(([value, label]) => React.createElement('option', { key: value, value }, label)))),
          React.createElement('label', null, '帧率', React.createElement('select', { 'aria-label': '视频帧率', value: motion.fps || 30, onChange: (event) => change('fps', Number(event.target.value)) },
            [12, 24, 25, 30].map((fps) => React.createElement('option', { key: fps, value: fps }, fps + ' fps')))))),
      React.createElement('div', { className: 'drawai-export-info', role: 'status', style: { flex: 1, minWidth: 0 } },
        running ? labels[running.status] + (running.stageDetail?.tool ? ' · ' + running.stageDetail.tool : '') : '由对话主线制作：让 AI 建工程、改场景、看预览、渲染')),
    React.createElement('details',{className:'drawai-video-project'},
      React.createElement('summary',null,'声音'),
      React.createElement('p',{className:'drawai-export-info'},'声音挂在工程的时间轴上（timeline.json 的 audio[]），渲染时和画面一起播。让 AI 用 motion_audio add 加一条：旁白自动压低背景音乐，切镜可以吸到拍子上。'),
      React.createElement('button',{type:'button',className:'drawai-btn',onClick:()=>{try{props.onAddAudio?.()}catch(e){setError(e.message)}}},'添加音频节点')),
    error ? React.createElement('div', { role: 'alert', className: 'drawai-imagegen-status err' }, error) : null,
    React.createElement('div', { className: 'drawai-motion-task-heading' }, '任务情况',
      props.onShowTasks ? React.createElement('button', { type: 'button', className: 'drawai-trace-pin', onClick: props.onShowTasks }, '全部任务') : null),
    !jobs.length ? React.createElement('div', { className: 'drawai-export-info' }, '就绪 · 在对话里让 AI 建工程、写场景、看预览、出片') : null,
    jobs.slice(0, 4).map((job) => React.createElement('div', { key: job.id, className: 'drawai-imagegen-status' },
      React.createElement('div', { role: 'status' }, (job.status==='film-review'?'检查整片运动与声音':labels[job.status]) + (job.stageDetail?.shotId ? ' · ' + job.stageDetail.shotId : '')
        + (job.stageDetail?.tool ? ' · ' + job.stageDetail.tool : '')
        + (job.stageDetail?.componentId ? ' · ' + job.stageDetail.componentId : '') + (job.stageDetail?.attempt > 1 ? ' · 第 ' + job.stageDetail.attempt + ' 次尝试' : '')
        + (job.status === 'rendering' ? ' ' + Math.round(job.progress * 100) + '%' : '')),
      job === running ? React.createElement('progress', { 'aria-label': '绘制视频进度', max: 100,
        value: job.status === 'rendering' ? Math.round((job.progress || 0) * 100) : undefined, style: { width: '100%' } }) : null,
      job.qa ? React.createElement('details', { className: 'drawai-export-info' },
        React.createElement('summary', null, job.qa.review?.fidelity === 'reference-samples-passed' ? '所有指定样式的样片对照抽检通过' : job.qa.review?.status === 'passed' ? '逐镜关键帧视觉抽检通过' : '已渲染；效果验收未完成'),
        React.createElement('p', null, job.qa.review?.reason || '抽帧验收不等于全片逐帧或运动曲线一致性验证。'),
        (job.qa.warnings || []).map((text, index) => React.createElement('p', { key: index }, text)),
        React.createElement('pre', { style: { maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11 } }, JSON.stringify(job.qa.review || { status: 'unavailable' }, null, 2))) : null,

      job.error ? React.createElement('details', { style: { marginTop: 6, minWidth: 0 } },
        React.createElement('summary', { role: 'alert', style: { overflowWrap: 'anywhere', cursor: 'pointer' } }, String(job.error).split(/\r?\n/)[0].slice(0, 160) + (String(job.error).split(/\r?\n/)[0].length > 160 ? '…' : '') + '（展开详情）'),
        React.createElement('pre', { style: { maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text', font: 'inherit' } }, job.error)) : null,
      job.notificationError ? React.createElement('div', { role: 'alert' }, job.notificationError) : null,
      job === running ? React.createElement('button', { type: 'button', className: 'drawai-btn', onClick: () => props.onTask('cancel', job.id).catch((e) => setError(e.message)) }, '取消') : null,
      job.status === 'retained' ? React.createElement('button', { type: 'button', className: 'drawai-btn', onClick: () => props.onTask('apply', job.id).catch((e) => setError(e.message)) }, '尝试回填') : null,
      ['done', 'error', 'cancelled', 'interrupted', 'retained'].includes(job.status) ? React.createElement('button', { type: 'button', className: 'drawai-btn',
        onClick: () => props.onTask('remove', job.id).catch((e) => setError(e.message)) }, '移除记录') : null,
      job.clip ? React.createElement('button', { type: 'button', className: 'drawai-btn', onClick: () => props.onExport(job.clip).catch((e) => setError(e.message)) }, '导出此版本') : null,
      job.qa?.film?React.createElement(MotionFilmReview,{key:job.id+job.qa.film.sha256,job,onLoad:props.onLoadFilm,onSave:props.onReviewFilm,onRevise:undefined}):null,
      job.qa?.audio ? React.createElement('div',{role:'status'},'声音：'+(job.qa.audio.status==='mixed'?'已混音，需试听':'静音')+(Number.isFinite(job.qa.audio.samplePeakDb)?' · 采样峰值 '+job.qa.audio.samplePeakDb+' dB':'')) : null,
      (job.qa?.audio?.warnings||[]).map((warning,index)=>React.createElement('p',{key:'audio-warning-'+index,role:'status'},warning)),
      job.qa?.audio?.variants?.picture ? React.createElement('button',{className:'drawai-btn',onClick:()=>props.onExport(job.clip,'picture').catch(e=>setError(e.message))},'导出无声画面') : null,
      job.qa?.audio?.variants?.noBgm ? React.createElement('button',{className:'drawai-btn',onClick:()=>props.onExport(job.clip,'noBgm').catch(e=>setError(e.message))},'导出无背景音乐版') : null,
      job.clip ? React.createElement('button', { type: 'button', className: 'drawai-btn', onClick: () => props.onUseVersion(job.id).catch((e) => setError(e.message)) }, '使用此版本') : null)),
    motion.composition ? React.createElement('details', { className: 'drawai-video-project' },
      React.createElement('summary', null, '工程与版本'),
    motion.composition ? React.createElement('details', { style: { marginTop: 8 } },
      React.createElement('summary', null, '编辑分镜（' + motion.composition.shots.length + ' 镜）'),
      React.createElement('textarea', { className: 'drawai-imagegen-prompt', style: { minHeight: 160, fontFamily: 'monospace' },
        'aria-label': '分镜工程', value: editor || JSON.stringify(motion.composition, null, 2), onChange: (event) => setEditor(event.target.value) }),
      React.createElement('button', { type: 'button', className: 'drawai-btn', disabled: !!running || starting, onClick: () => {
        try { run(JSON.parse(editor || JSON.stringify(motion.composition))) } catch { setError('分镜 JSON 格式无效') }
      } }, '按此分镜重新渲染'),
      props.onExportProject ? React.createElement('button', { type: 'button', className: 'drawai-btn', onClick: props.onExportProject }, '导出分镜与场景源码') : null) : null,
    motion.composition?.production ? React.createElement('details', { style: { marginTop: 8 } },
      React.createElement('summary', null, '制作方案与验证范围'),
      React.createElement('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 11 } }, JSON.stringify(motion.composition.production, null, 2))) : null,
    motion.composition?.shots.filter((shot) => shot.recipeId === 'scene').map((shot) => React.createElement('details', { key: shot.id, style: { marginTop: 8 } },
      React.createElement('summary', null, '场景源码 · ' + shot.id + (shot.cardId ? ' · ' + shot.cardId : ' · 自由创作')),
      React.createElement('textarea', { 'aria-label': '场景源码 ' + shot.id, value: sceneEditors[shot.id] ?? shot.sceneSource,
        style: { width: '100%', boxSizing: 'border-box', minHeight: 240, fontFamily: 'monospace', fontSize: 11 },
        onChange: (event) => setSceneEditors({ ...sceneEditors, [shot.id]: event.target.value }) }),
      (shot.sceneComponents || []).map((component) => React.createElement('details', { key: component.id },
        React.createElement('summary', null, component.id + ' · ' + component.description),
        React.createElement('textarea', { 'aria-label': '组件源码 ' + shot.id + ' ' + component.id,
          value: sceneEditors[shot.id + ':' + component.id] ?? component.source,
          style: { width: '100%', boxSizing: 'border-box', minHeight: 240, fontFamily: 'monospace', fontSize: 11 },
          onChange: (event) => setSceneEditors({ ...sceneEditors, [shot.id + ':' + component.id]: event.target.value }) }))),
      React.createElement('button', { type: 'button', className: 'drawai-btn', disabled: !!running || starting, onClick: () => run({ ...motion.composition,
        shots: motion.composition.shots.map((item) => ({ ...item, ...(sceneEditors[item.id] !== undefined ? { sceneSource: sceneEditors[item.id] } : {}),
          ...(item.sceneComponents ? { sceneComponents: item.sceneComponents.map((component) => ({ ...component,
            source: sceneEditors[item.id + ':' + component.id] ?? component.source })) } : {}) })) }) }, '渲染修改后的场景'))) || null) : null,
  )
}
