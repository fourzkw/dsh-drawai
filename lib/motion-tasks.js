/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { enforceMotionCards } from './motion-library.js'
import { fork } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, copyFileSync, realpathSync, statSync, cpSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipDirFor, ensureClipPack, readManifest, writeManifest, findSourceFile } from './media.js'
import { motionInputKey, validateMotionPlan, audioNodeSettings, validateAudioTimeline } from './motion-core.js'
import { frozenAudioFile, defaultAudioPlan, mixMotionAudio } from './audio-media.js'
import { prepareMotionProject } from './motion-project.js'
import { validateMotionSources, validateSceneSource, sceneComponentPath } from './motion-source.js'

const motionEnded = (job) => ['done', 'error', 'cancelled', 'interrupted', 'retained'].includes(job.status)
export function createMotionTaskManager(options = {}) {
  const jobs = new Map()
  let closed = false
  const root = (scope) => join(dirname(scope.drawioAbs), '.drawai-cache', 'motion', createHash('sha256').update(scope.drawioAbs).digest('hex'))
  const dir = (job) => join(root(job.scope), job.id)
  function persist(job) {
    const record = { ...job }; delete record.child; delete record.control; delete record.promise
    mkdirSync(dir(job), { recursive: true })
    const file = join(dir(job), 'job.json')
    writeFileSync(file + '.tmp', JSON.stringify(record)); renameSync(file + '.tmp', file)
  }
  function load(scope) {
    if (!existsSync(root(scope))) return
    for (const id of readdirSync(root(scope))) {
      if (!/^[a-f0-9-]{36}$/.test(id) || jobs.has(id)) continue
      try {
        const job = JSON.parse(readFileSync(join(root(scope), id, 'job.json'), 'utf8'))
        if (job.id !== id || job.scope.drawioAbs !== scope.drawioAbs || job.scope.sessionId !== scope.sessionId) continue
        if (!motionEnded(job)) { job.status = 'interrupted'; job.error = '宿主已停止，可继续生成并复用已完成的代码' }
        job.control = new AbortController(); jobs.set(id, job)
      } catch { /* A damaged task cannot hide other results. */ }
    }
  }
  function view(job) {
    return { engine:job.engine||'legacy', id: job.id, nodeId: job.nodeId, page: job.scope.page, status: job.status, progress: job.progress || 0,
      settings: { ...job.input.settings, totalFrames: Math.round(job.input.settings.fps * job.input.settings.duration) },
      error: job.error || '', createdAt: job.createdAt, clip: job.output?.data.mediaClip, composition: job.composition || null,
      stageDetail: job.stageDetail, attempts: job.attempts?.length || 0, qa: job.output?.qa || null, session: job.session || null,
      notificationError: job.notificationError || '', storyboard: job.storyboard || null,
      projectPath: job.packDir ? join(job.packDir, 'project') : '', sourceProgress: job.sourceProgress || {},
      canResume: ['error', 'cancelled', 'interrupted'].includes(job.status), resumeCount: job.resumeCount || 0 }
  }
  async function notify(job, event) {
    if (job.session?.silent || !job.session?.accepted || !options.notify || job.notified?.includes(event)) return
    try {
      await options.notify(job, event)
      job.notified = [...(job.notified || []), event]; job.notificationError = ''
    } catch (error) { job.notificationError = '主会话通知失败：' + error.message }
    persist(job)
  }
  function owned(scope, id) {
    load(scope)
    const job = jobs.get(id)
    if (!job || job.scope.sessionId !== scope.sessionId || job.scope.drawioAbs !== scope.drawioAbs) throw new Error('动效任务不属于当前会话画布')
    return job
  }
  function copyProject(original, target) {
    const sourceProject=join(original.packDir,'project')
    if(!existsSync(sourceProject))return
    cpSync(sourceProject,target,{recursive:true,filter:source=>{
      const rel=relative(sourceProject,source)
      if(rel.split(/[\\/]/).some(part=>['.agent','node_modules','bundle'].includes(part.toLowerCase())))return false
      const real=relative(realpathSync(sourceProject),realpathSync(source))
      if(isAbsolute(real)||real==='..'||/^\.\.[\\/]/.test(real))throw new Error('原工程包含外部路径')
      return true
    }})
  }
  function snapshotAssets(job, previews) {
    const pack = ensureClipPack(job.scope.drawioAbs, 'motion-' + job.id, { kind: 'raster', fps: job.input.settings.fps, w: job.input.settings.width, h: job.input.settings.height })
    const publicDir = join(pack.dir, 'assets'); mkdirSync(publicDir, { recursive: true })
    const assets = {}
    let n = 0, totalBytes = 0, audioBytes = 0
    const saveImage = (dataUri) => {
      const match = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUri || '')
      if (!match) throw new Error('动效预览必须是内嵌 PNG/JPEG/WebP')
      const bytes = Buffer.from(match[2], 'base64'); totalBytes += bytes.length
      if (bytes.length > 16 * 1024 * 1024 || totalBytes > 48 * 1024 * 1024) throw new Error('参考素材快照超过 48MB')
      const name = 'asset-' + (++n) + '.' + (match[1] === 'jpeg' ? 'jpg' : match[1].toLowerCase())
      writeFileSync(join(publicDir, name), bytes); return name
    }
    for (const ref of job.input.refs) {
      if(ref.role==='audio'){
        const node=ref.nodes.find(node=>node.data?.drawaiAudio==='1')
        if(!node?.data.audioClip)throw new Error('请先为音频节点上传文件：'+ref.id)
        const {file,manifest}=frozenAudioFile(job.scope.drawioAbs,node.data.audioClip),settings=audioNodeSettings(node.data)
        const src='asset-'+(++n)+'.wav';audioBytes+=statSync(file).size
        if(audioBytes>128*1024*1024)throw new Error('冻结素材总量超过176MB')
        copyFileSync(file,join(publicDir,src))
        assets[ref.id]=[{kind:'audio',src,duration:manifest.duration,sha256:manifest.sha256,provenance:manifest.provenance,...settings}]
        continue
      }
      if (!['material', 'layout', 'style'].includes(ref.role)) continue
      if(ref.role==='style') {
        assets[ref.id]=ref.nodes.filter(node=>previews[node.id]).map(node=>({kind:'image',src:saveImage(previews[node.id]),sourceNodeId:node.id,width:node.w,height:node.h}))
        continue
      }
      if (ref.role === 'layout') {
        if (!previews[ref.id]) throw new Error('布局参考缺少画布快照，请在画布中生成')
        assets[ref.id] = [{ kind: 'image', src: saveImage(previews[ref.id]),sourceNodeId:ref.id }]; continue
      }
      assets[ref.id] = []
      for (const node of ref.nodes) {
        if (node.data?.drawaiMedia) {
          if (node.data.mediaKind !== 'raster') throw new Error('SVG 复刻视频请先导出 MP4 并导入，再作为视频素材')
          const sourceDir = clipDirFor(job.scope.drawioAbs, node.data.mediaClip), source = findSourceFile(sourceDir, readManifest(sourceDir))
          if (!source) throw new Error('参考视频还没有源文件，请先生成或导入视频')
          const rel = relative(realpathSync(sourceDir), realpathSync(source.abs))
          if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('参考视频路径超出媒体包')
          if (statSync(source.abs).size > 128 * 1024 * 1024) throw new Error('参考视频超过 128MB')
          const name = 'asset-' + (++n) + '.mp4'
          copyFileSync(source.abs, join(publicDir, name))
          assets[ref.id].push({ kind: 'video', src: name, sourceNodeId:node.id,width: node.w, height: node.h })
        } else if (previews[node.id]) assets[ref.id].push({ kind: 'image', src: saveImage(previews[node.id]),sourceNodeId:node.id, width: node.w, height: node.h })
        else throw new Error('参考元素缺少画布快照：' + node.id)
      }
    }
    return { dir: pack.dir, publicDir, assets }
  }
  async function render(job, request) {
    if (job.control.signal.aborted) throw new Error('已取消动效生成')
    if (options.render) return options.render(job, request)
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./motion-render-worker.js', import.meta.url)), [], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
      })
      job.child = child
      let errorText = '', result, error
      const timeout = setTimeout(() => { error = new Error('场景渲染超过 10 分钟，请简化镜头'); child.kill() }, options.renderTimeoutMs || 600000)
      let cancelTimer
      const abort = () => { if (child.connected) child.send({ type: 'cancel' }); cancelTimer = setTimeout(() => child.kill(), 10000) }
      job.control.signal.addEventListener('abort', abort, { once: true })
      child.stderr.on('data', (bytes) => { errorText = (errorText + bytes).slice(-4000) })
      child.on('message', (message) => {
        if (message.type === 'progress') { job.progress = message.progress; job.status = message.phase || 'rendering' }
        if (message.type === 'done') result = message
        if (message.type === 'error') error = new Error(message.error)
      })
      child.on('error', (failure) => { clearTimeout(timeout); clearTimeout(cancelTimer); job.control.signal.removeEventListener('abort', abort); error = failure; reject(failure) })
      child.on('exit', (code) => {
        clearTimeout(timeout); clearTimeout(cancelTimer); job.control.signal.removeEventListener('abort', abort)
        job.child = null
        if (job.control.signal.aborted) reject(new Error('已取消动效生成'))
        else if (error || code !== 0 || !result) reject(error || new Error('动效渲染失败：' + errorText))
        else resolve(result)
      })
      child.send(request)
    })
  }
  async function run(job) {
    let release
    try {
      release = await options.slots?.acquire(job.control.signal)
      if (job.control.signal.aborted) throw new Error('已取消动效生成')
      let rendered
      if(job.engine==='agent' && !job.plateSource){
        if(!options.produce)throw new Error('当前宿主未提供制作 Agent，任务已保留')
        const produced=await options.produce(job,{
          projectDirectory:join(job.packDir,'project'),packDir:job.packDir,publicDir:job.publicDir,assets:job.assets,
          render:request=>render(job,{...request,browserExecutable:options.browserExecutable}),
          inspectFilm:options.inspectFilm?(composition=>options.inspectFilm(job,composition)):undefined,
          review:options.review?((composition,qa)=>options.review({...job.input,refs:[...job.input.refs,...(job.agentReferences||[])]},composition,qa,job.packDir,job.scope,job.control.signal)):undefined,
          onReferences:async refs=>{job.agentReferences=JSON.parse(JSON.stringify(refs));persist(job)},
          onStage:async(stage,detail)=>{job.status=stage;job.stageDetail=detail;if(stage==='storyboard')job.storyboard=detail;persist(job)},
        })
        const effective={...job.input,refs:[...job.input.refs,...(job.agentReferences||[])]}
        job.composition=validateMotionSources(validateMotionPlan(produced.composition,effective))
        enforceMotionCards(job.composition,effective)
        rendered={qa:produced.qa};job.agentSummary=produced.summary
        copyFileSync(join(job.packDir,'source.mp4'),join(job.packDir,'picture.mp4'))
        job.visualReady=true;job.visualQa=rendered.qa;persist(job)
      }else{
      const legacyInput={...job.input,refs:[...job.input.refs,...(job.agentReferences||[])]}
      if (!job.composition) {
        job.status = 'planning'; persist(job)
        job.composition = await options.plan(legacyInput, job.scope, job.control.signal, job.previousComposition, async (stage, detail) => {
          job.status = stage; job.stageDetail = detail
          if (detail?.file) job.sourceProgress = { ...(job.sourceProgress || {}), [detail.file]: { attempt: detail.attempt, reason: detail.reason || '' } }
          persist(job)
          if (stage === 'storyboard') { job.storyboard = detail; await notify(job, 'storyboard') }
        }, { projectDirectory: join(job.packDir, 'project'), resume: !!job.resumeCount, assets:job.assets,publicDir:job.publicDir })
      }
      job.composition = validateMotionSources(validateMotionPlan(job.composition, legacyInput))
      await notify(job, 'storyboard')
      if(job.visualReady && existsSync(join(job.packDir,'picture.mp4'))) {job.plateSource=join(job.packDir,'picture.mp4');job.platePoster=join(job.packDir,'poster.png');job.previousQa=job.visualQa}
      enforceMotionCards(job.composition, legacyInput)
      for (let attempt = 0; attempt < 3 && !job.plateSource; attempt++) {
        job.status = 'bundling'; job.stageDetail = undefined; persist(job)
        try {
          rendered = await render(job, { attempt, composition: job.composition, assets: job.assets, publicDir: job.publicDir,
            output: join(job.packDir, 'source.mp4'), poster: join(job.packDir, 'poster.png'), browserExecutable: options.browserExecutable })
          if (options.review && rendered?.qa && job.composition.shots.some((shot) => shot.recipeId === 'scene')) {
            job.status = 'reviewing'; persist(job)
            let review
            try { review = await options.review(legacyInput, job.composition, rendered.qa, job.packDir, job.scope, job.control.signal) }
            catch (error) {
              if (job.control.signal.aborted) throw error
              review = { status: 'unavailable', reason: error.message }
            }
            rendered.qa.review = review
            rendered.qa.visualReview = review.status === 'passed' ? 'sampled-keyframes-passed' : 'manual-required'
            writeFileSync(join(job.packDir, 'qa', 'report.json'), JSON.stringify(rendered.qa, null, 2))
            if (review.status === 'changes-requested') throw new Error('关键帧视觉检查需要修复：' + JSON.stringify(review.issues))
          }
          copyFileSync(join(job.packDir,'source.mp4'),join(job.packDir,'picture.mp4'))
          job.visualReady=true;job.visualQa=rendered?.qa;persist(job)
          break
        } catch (error) {
          job.attempts = [...(job.attempts || []), { attempt: attempt + 1, error: String(error.message).slice(0, 12000), composition: job.composition }]
          persist(job)
          if (job.control.signal.aborted || attempt === 2 || !options.repair || !job.composition.shots.some((shot) => shot.recipeId === 'scene')) throw error
          job.status = 'repairing'; persist(job)
          job.composition = validateMotionSources(validateMotionPlan(await options.repair(legacyInput, job.composition, error.message, job.scope, job.control.signal,
            { projectDirectory: join(job.packDir, 'project'), assets:job.assets,publicDir:job.publicDir,onStage: async (stage, detail) => {
              job.status = stage; job.stageDetail = detail
              if (detail?.file) job.sourceProgress = { ...(job.sourceProgress || {}), [detail.file]: { attempt: detail.attempt, reason: detail.reason || '' } }
              persist(job)
            } }), legacyInput))
        }
      }
      if(job.plateSource){
        if(job.platePoster!==join(job.packDir,'poster.png'))copyFileSync(job.platePoster,join(job.packDir,'poster.png'))
        rendered={qa:job.previousQa||{status:'existing-picture-reused',frames:[]}}
      }
      }
      const effectiveInput={...job.input,refs:[...job.input.refs,...(job.agentReferences||[])]}
      if(job.input.settings.audioMode==='off')job.composition.audio={version:1,cues:[],notes:['用户关闭声音']}
      else if(job.input.settings.audioMode==='manual')job.composition.audio=validateAudioTimeline(job.input.settings.audioPlan||defaultAudioPlan(effectiveInput,job.composition,job.assets),job.composition,effectiveInput)
      else if(!job.composition.audio&&effectiveInput.refs.some(ref=>ref.role==='audio')){
        job.status='sound-design';persist(job)
        job.composition.audio=options.planAudio?await options.planAudio(effectiveInput,job.composition,job.assets,job.scope,job.control.signal):defaultAudioPlan(effectiveInput,job.composition,job.assets)
      }
      if(job.composition.audio||job.plateSource){
        job.status='mixing';persist(job)
        const audio=await mixMotionAudio({input:effectiveInput,composition:job.composition,assets:job.assets,publicDir:job.publicDir,packDir:job.packDir,signal:job.control.signal,plateSource:job.plateSource})
        rendered={...rendered,qa:{...rendered?.qa,audio}}
      }
      if (job.control.signal.aborted) throw new Error('已取消动效生成')
      if(job.composition.audio){
        if(job.composition.production)job.composition.production.audio=rendered?.qa?.audio?.status||'silent'
        mkdirSync(join(job.packDir,'project'),{recursive:true});writeFileSync(join(job.packDir,'project','composition.json'),JSON.stringify(job.composition,null,2))
      }
      if(options.inspectFilm){
        job.status='film-review';persist(job)
        const film=await options.inspectFilm(job,job.composition,rendered?.qa?.film,true)
        rendered={...rendered,qa:{...rendered?.qa,film}}
      }
      const manifest = readManifest(job.packDir); manifest.source = 'source.mp4'; writeManifest(job.packDir, manifest)
      const poster = readFileSync(join(job.packDir, 'poster.png')).toString('base64')
      const { width, height, fps } = job.composition
      if (job.composition.production) job.composition.production.verification = { render: rendered?.qa?.status || 'completed', visual: rendered?.qa?.visualReview || 'manual-required' }
      job.output = { composition: job.composition, qa: rendered?.qa || null, inputKey: job.inputKey, poster: 'data:image/png;base64,' + poster,
        data: { drawaiMedia: '1', mediaKind: 'raster', mediaClip: 'motion-' + job.id,
          mediaFps: String(fps), mediaW: String(width), mediaH: String(height), mediaDuration: String(job.input.settings.duration), mediaPosterFrame: '0' } }
      job.status = 'retained'; persist(job)
      try { await options.commit(job, job.output); job.status = 'done' }
      catch (error) { job.error = error.message }
      job.progress = 1
      job.stageDetail = undefined
    } catch (error) {
      job.status = job.control.signal.aborted ? 'cancelled' : 'error'; job.error = error.message || String(error)
    } finally { release?.(); persist(job); await notify(job, 'finished') }
  }
  return {
    async start(scope, nodeId, input, previews = {}, composition, beforeStart, previousComposition, draft = {}) {
      if (closed) throw new Error('动效服务已关闭')
      if (!composition && !options.plan && !options.produce && !draft.audioOnly) throw new Error('旧视频任务不再支持自动规划，请使用 motion_project 创建工程并通过 motion_render 渲染')
      load(scope)
      if (draft.requestId) {
        const existing = [...jobs.values()].find((job) => job.scope.sessionId === scope.sessionId && job.scope.drawioAbs === scope.drawioAbs && job.session?.requestId === draft.requestId)
        if (existing) {
          if (existing.nodeId !== nodeId || existing.inputKey !== motionInputKey(input)) throw new Error('请求 ID 已被另一个视频请求使用')
          return view(existing)
        }
      }
      if ([...jobs.values()].some((job) => job.scope.sessionId === scope.sessionId && job.scope.drawioAbs === scope.drawioAbs
        && job.scope.page === scope.page && job.nodeId === nodeId && !motionEnded(job))) throw new Error('此视频节点正在绘制，请等待完成或取消任务')
      if ([...jobs.values()].filter((job) => !motionEnded(job)).length >= 8) throw new Error('动效队列已满，请稍后再试')
      const job = { id: randomUUID(), scope, nodeId, input, inputKey: motionInputKey(input),
        engine:!composition&&options.produce&&!draft.audioOnly?'agent':'legacy',
        composition: composition ? structuredClone(composition) : null, previousComposition, createdAt: Date.now(),
        status: draft.defer ? 'awaiting-session' : 'queued', session: draft.requestId ? { sessionId: scope.sessionId, requestId: draft.requestId, accepted: false, silent: draft.silent === true } : undefined, control: new AbortController() }
      if (draft.reuseJobId) {
        const original = owned(scope, draft.reuseJobId)
        job.reviewFeedback=original.output?.qa?.film?.manual
        const visible=refs=>refs.filter(ref=>ref.role!=='audio')
        if (motionInputKey(draft.audioOnly?visible(original.input.refs):original.input.refs) !== motionInputKey(draft.audioOnly?visible(input.refs):input.refs)) throw new Error('参考素材已变化，请回到画布重新提交以更新快照')
        if(draft.audioOnly){
          if(!original.output)throw new Error('请先完成画面制作')
          if(['width','height','fps','duration'].some(key=>original.input.settings[key]!==input.settings[key]))throw new Error('仅混音不能改变画幅、帧率或时长，请使用 revise')
          const picture=join(original.packDir,existsSync(join(original.packDir,'picture.mp4'))?'picture.mp4':'source.mp4')
          job.plateSource=picture;job.platePoster=join(original.packDir,'poster.png');job.previousQa=structuredClone(original.output.qa)
          job.composition=validateMotionSources(validateMotionPlan({...original.composition,audio:undefined},{...input,refs:[...input.refs,...(original.agentReferences||[])]}))
        }
        const pack = ensureClipPack(scope.drawioAbs, 'motion-' + job.id, { kind: 'raster', fps: input.settings.fps, w: input.settings.width, h: input.settings.height })
        job.packDir = pack.dir; job.publicDir = join(pack.dir, 'assets'); mkdirSync(job.publicDir, { recursive: true })
        if(draft.audioOnly){
          copyProject(original,join(pack.dir,'project'))
          copyFileSync(job.plateSource,join(pack.dir,'picture.mp4'));job.plateSource=join(pack.dir,'picture.mp4')
          copyFileSync(job.platePoster,join(pack.dir,'poster.png'));job.platePoster=join(pack.dir,'poster.png')
          prepareMotionProject(job.composition,join(pack.dir,'project'))
        }
        if(!draft.audioOnly)copyProject(original,join(pack.dir,'project'))
        job.agentReferences=JSON.parse(JSON.stringify(original.agentReferences||[]))
        job.assets = JSON.parse(JSON.stringify(original.assets))
        if(draft.audioOnly)for(const ref of original.input.refs.filter(ref=>ref.role==='audio'))delete job.assets[ref.id]
        for (const asset of Object.values(job.assets).flat()) {
          if (!/^asset-\d+\.(png|jpg|webp|mp4|wav)$/.test(asset.src)) throw new Error('素材快照文件名无效')
          const source = realpathSync(join(original.publicDir, asset.src)), rel = relative(realpathSync(original.publicDir), source)
          if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('素材快照超出媒体包')
          copyFileSync(source, join(job.publicDir, asset.src))
        }
        if(draft.audioOnly){
          let n=Math.max(0,...Object.values(job.assets).flat().map(asset=>Number(/asset-(\d+)/.exec(asset.src)?.[1])||0)),total=0
          for(const ref of input.refs.filter(ref=>ref.role==='audio')){
            const node=ref.nodes.find(node=>node.data?.drawaiAudio==='1'),{file,manifest}=frozenAudioFile(scope.drawioAbs,node?.data.audioClip),settings=audioNodeSettings(node.data)
            total+=statSync(file).size;if(total>128*1024*1024)throw new Error('音频快照超过128MB')
            const src='asset-'+(++n)+'.wav';copyFileSync(file,join(job.publicDir,src))
            job.assets[ref.id]=[{kind:'audio',src,duration:manifest.duration,sha256:manifest.sha256,provenance:manifest.provenance,...settings}]
          }
        }
      } else Object.assign(job, (() => { const pack = snapshotAssets(job, previews); return { packDir: pack.dir, publicDir: pack.publicDir, assets: pack.assets } })())
      // A fresh request freezes its own inputs, while retaining ordinary helper
      // modules from the selected version for continued source editing.
      if(!draft.reuseJobId&&draft.projectFromJobId){
        const original=owned(scope,draft.projectFromJobId)
        job.reviewFeedback=original.output?.qa?.film?.manual
        if(original.nodeId!==nodeId)throw new Error('原工程不属于当前视频节点')
        copyProject(original,join(job.packDir,'project'))
        job.agentReferences=structuredClone(original.agentReferences||[])
        let assetNumber=Math.max(0,...Object.values(job.assets).flat().map(asset=>Number(/^asset-(\d+)/.exec(asset.src)?.[1])||0))
        for(const ref of job.agentReferences){
          if(!['audio','material'].includes(ref.role))throw new Error('原工程内部引用类型无效')
          job.assets[ref.id]=(original.assets[ref.id]||[]).map(asset=>{
            if(!['audio','image'].includes(asset.kind)||!/^asset-\d+\.(wav|png)$/.test(asset.src))throw new Error('原工程内部素材快照无效')
            const source=realpathSync(join(original.publicDir,asset.src)),rel=relative(realpathSync(original.publicDir),source)
            if(isAbsolute(rel)||rel==='..'||/^\.\.[\\/]/.test(rel))throw new Error('声音快照超出原工程')
            const src='asset-'+(++assetNumber)+(asset.kind==='audio'?'.wav':'.png');copyFileSync(source,join(job.publicDir,src));return {...asset,src}
          })
        }
        if(job.previousComposition)prepareMotionProject(job.previousComposition,join(job.packDir,'project'))
      }
      if(job.composition)job.composition=validateMotionSources(validateMotionPlan(job.composition,{...input,refs:[...input.refs,...(job.agentReferences||[])]}))
      if (beforeStart) await beforeStart(job)
      jobs.set(job.id, job); persist(job)
      if (!draft.defer) job.promise = run(job)
      return view(job)
    },
    async accepted(scope, id) {
      const job = owned(scope, id)
      if (!job.session) throw new Error('任务没有关联主会话')
      job.session.accepted = true; persist(job)
      if (job.status === 'awaiting-session' && !job.promise) { job.status = 'queued'; job.promise = run(job) }
      else if (motionEnded(job)) await notify(job, 'finished')
      return view(job)
    },
    details(scope, id) { const job = owned(scope, id); return { scope: { ...job.scope }, input: JSON.parse(JSON.stringify(job.input)), composition: job.composition, session: job.session } },
    findRequest(scope, requestId) { load(scope); const job = [...jobs.values()].find((job) => job.scope.sessionId === scope.sessionId && job.scope.drawioAbs === scope.drawioAbs && job.session?.requestId === requestId); return job ? view(job) : null },
    list(scope) { load(scope); return [...jobs.values()].filter((job) => !job.dismissedAt && job.scope.sessionId === scope.sessionId && job.scope.drawioAbs === scope.drawioAbs).sort((a, b) => b.createdAt - a.createdAt).map(view) },
    leases(scope) {
      const ids = new Set([...jobs.values()].filter((job) => job.scope.drawioAbs === scope.drawioAbs).map((job) => job.id))
      if (existsSync(root(scope))) for (const id of readdirSync(root(scope))) if (/^[a-f0-9-]{36}$/.test(id)) ids.add(id)
      return [...ids].map((id) => 'motion-' + id)
    },
    result(scope, id) { const job = owned(scope, id); return { job: view(job), output: job.output || null } },
    reviewFilm(scope,id,value){
      const job=owned(scope,id),film=job.output?.qa?.film
      if(!film||!['passed','changes-requested'].includes(value.status))throw Error('当前任务没有可验收的成片')
      if(value.sha256!==film.sha256||createHash('sha256').update(readFileSync(join(job.packDir,'source.mp4'))).digest('hex')!==film.sha256)throw Error('成片已变化，请重新加载并验收')
      if(value.status==='passed'&&(!Number.isFinite(value.motionSeconds)||value.motionSeconds<film.duration*.98||film.audio.hasAudio&&(!Number.isFinite(value.soundSeconds)||value.soundSeconds<film.duration*.98)))throw Error('请先完整回放成片；有音轨时需要打开声音试听')
      film.manual={status:value.status,motion:value.status,sound:film.audio.hasAudio?value.status:'not-applicable',note:String(value.note||'').slice(0,4000),reviewedAt:new Date().toISOString(),reviewer:scope.sessionId,sha256:film.sha256}
      const directory=join(job.packDir,'film-review',film.sha256.slice(0,16));mkdirSync(directory,{recursive:true})
      writeFileSync(join(directory,'report.json'),JSON.stringify(film,null,2));persist(job)
      return view(job)
    },
    remove(scope, id) {
      const job = owned(scope, id)
      if (!motionEnded(job)) throw new Error('请先取消正在进行的任务，再移除记录')
      // Hide the notification while keeping the checkpoint, media lease and
      // task ID available for explicit recovery and historical canvas versions.
      job.dismissedAt = Date.now(); persist(job)
      return view(job)
    },
    async resume(scope, id, beforeResume) {
      if (closed) throw new Error('动效服务已关闭')
      const job = owned(scope, id)
      if (!motionEnded(job)) return view(job)
      if (!['error', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('此任务无需继续生成')
      if (job.promise) await job.promise
      // Recheck after awaiting the previous run: concurrent requests must not
      // launch two renderers for the same task.
      if (!motionEnded(job)) return view(job)
      if ([...jobs.values()].some((other) => other !== job && other.scope.drawioAbs === job.scope.drawioAbs
        && other.scope.page === job.scope.page && other.nodeId === job.nodeId && !motionEnded(other))) throw new Error('此视频节点正在绘制')
      if ([...jobs.values()].filter((other) => !motionEnded(other)).length >= 8) throw new Error('动效队列已满，请稍后再试')
      if (!job.packDir || !existsSync(job.publicDir)) throw new Error('任务素材快照已丢失，无法继续生成')
      const status = job.status
      job.status = 'queued'
      try {
        if (beforeResume) await beforeResume(job)
        const project = join(job.packDir, 'project')
        const effectiveInput={...job.input,refs:[...job.input.refs,...(job.agentReferences||[])]}
        let composition = job.composition
        if (job.engine!=='agent' && !composition && existsSync(join(project, 'composition.json'))) {
          try { composition = validateMotionPlan(JSON.parse(readFileSync(join(project, 'composition.json'), 'utf8')), effectiveInput) }
          catch { /* Resume from the storyboard and finalized component files. */ }
        }
        if (job.engine!=='agent' && composition) {
          composition = structuredClone(composition)
          const readSource = (filename, fallback) => {
            if (!existsSync(join(project, filename))) return fallback
            const source = readFileSync(join(project, filename), 'utf8')
            try { validateSceneSource(source); return source } catch { return fallback }
          }
          for (const [index, shot] of composition.shots.entries()) {
            shot.sceneSource = readSource('scene-' + index + '.tsx', shot.sceneSource)
            for (const component of shot.sceneComponents || []) component.source = readSource(sceneComponentPath(shot.id, component.id), component.source)
          }
          job.composition = validateMotionSources(validateMotionPlan(composition, effectiveInput))
        }
      } catch (error) { job.status = status; throw error }
      job.control = new AbortController(); job.error = ''; job.progress = 0; job.stageDetail = undefined
      job.resumeCount = (job.resumeCount || 0) + 1
      delete job.dismissedAt
      job.notified = (job.notified || []).filter((event) => event !== 'finished')
      persist(job); job.promise = run(job)
      return view(job)
    },
    async cancel(scope, id) {
      const job = owned(scope, id)
      if (!motionEnded(job)) {
        job.control.abort()
        if (job.promise) await job.promise
        else { job.status = 'cancelled'; persist(job); await notify(job, 'finished') }
      }
      return view(job)
    },
    async apply(scope, id) {
      const job = owned(scope, id)
      if (!job.output) throw new Error('任务还没有成片')
      await options.commit(job, job.output); job.status = 'done'; job.error = ''; persist(job); return view(job)
    },
    async close() {
      closed = true
      for (const job of jobs.values()) if (!motionEnded(job)) job.control.abort()
      await Promise.allSettled([...jobs.values()].map((job) => job.promise))
    },
  }
}
