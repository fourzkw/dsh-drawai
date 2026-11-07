/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,realpathSync,statSync} from 'node:fs'
import {join,relative,isAbsolute,dirname} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {agentHash,agentAtomicJson} from './motion-agent-files.js'
import {readMotionProject,prepareMotionProject} from './motion-project.js'
import {validateMotionPlan,validateAudioTimeline,audioNodeData,audioNodeSettings} from './motion-core.js'
import {composeSceneSource} from './motion-source.js'
import {shotCardCatalog,shotcraftFile,shotcraftLibrary,enforceMotionCards} from './motion-library.js'
import {searchShotCards} from './shotcard-core.js'
import {ffmpegBinary} from './video-export.js'
import {createAudioService} from './audio-service.js'
import {frozenAudioFile,analyzeAudio} from './audio-media.js'
import {captureMotionPage} from './motion-capture.js'
const exec=promisify(execFile)
const string={type:'string'},number={type:'number'},object={type:'object',additionalProperties:true}
const declaration=(name,description,properties,required=[])=>({name,description,parameters:{type:'object',properties,required,additionalProperties:false}})

export const motionAgentToolDeclarations=[
  declaration('page_capture','打开真实HTTP(S)产品页面，采集2x整页图、元素PNG切片、布局坐标和视觉字体颜色。可先不传elements查看页面元素，再带选择器增量采集。steps支持click/fill/scroll，每次重开隔离页面并重放steps；不继承用户登录。hideForBackplate指定隐藏元素生成空底板。返回可直接用于referenceIds的内部素材ID及assets。',{url:string,width:number,height:number,scale:number,waitMs:number,elements:{type:'array',items:object,maxItems:20},steps:{type:'array',items:object,maxItems:16},hideForBackplate:string},['url']),
  declaration('project_files','操作当前工程文件。list/search/read/write/patch；read返回sha256，覆盖write需expectedSha256；patch的oldText必须唯一匹配。路径相对project目录，可自由拆分普通TSX模块。',{action:{type:'string',enum:['list','search','read','write','patch']},path:string,query:string,offset:number,limit:number,content:string,expectedSha256:string,oldText:string,newText:string},['action']),
  declaration('shotcraft_library','搜索镜头或读取原始规范/准确demo/组件。search返回准确路径；read支持offset/limit分页；index列出规范与模块路径。资料只读，内容可自由适配。',{action:{type:'string',enum:['search','read','index']},query:string,category:string,path:string,offset:number,limit:number},['action']),
  declaration('project_plan','建立或更新分镜。plan含production和连续覆盖全片的shots；每镜recipeId:scene、startFrame、durationFrames、referenceIds、motionCards，components可列图层id/description。写入composition.json，入口scene-0.tsx等；图层存components/shot-1/Name.tsx，普通辅助模块可自由组织。不会覆盖已有场景源码。',{plan:object},['plan']),
  declaration('project_render','编译或渲染当前磁盘工程。compile检查真实构建；still按frames取帧；preview用startFrame/endFrame渲染片段；full生成完整画面与QA关键帧。返回日志及图片路径，不代表你已看过。',{action:{type:'string',enum:['compile','still','preview','full']},frames:{type:'array',items:number,maxItems:12},startFrame:number,endFrame:number},['action']),
  declaration('image_view','实际查看图片像素。area为project/assets/qa/observations，path相对该区域；视频素材可指定time抽帧；region可按像素[x,y,w,h]裁切。成功的图片将在下一轮工具结果中作为图片输入，无法看图时明确返回原因。',{area:{type:'string',enum:['project','assets','qa','observations']},path:string,time:number,region:{type:'array',items:number,minItems:4,maxItems:4}},['area','path']),
  declaration('project_review','调用干净上下文独立检查最新版完整画面。需要先full渲染，返回逐镜问题及参考样片情况。按问题修改，再渲染复查；不可把无法检查说成通过。',{}),
  declaration('audio_assets','list读取已冻结声音参数；analyze测量声音；search搜索Freesound；get下载音效到当前工程快照并返回内部referenceId及许可，不修改用户画布节点。',{action:{type:'string',enum:['list','analyze','search','get']},referenceId:string,query:string,id:string,role:{type:'string',enum:['sfx','bgm','voice']},license:{type:'string',enum:['cc0','by']},limit:number},['action']),
  declaration('audio_timeline','保存声音时间表{cues:[{referenceId,shotId?,offsetFrames,durationFrames,trimStart,gainDb,fadeIn,fadeOut,loop,action}]}。使用真实声音ID，帧数按实际fps；裁切和淡入淡出单位秒。宿主在画面交付后混音。',{plan:object},['plan']),
  declaration('finish_production','交付已实际渲染、查看并独立检查过的工程。必须单独调用；只有最新源码对应的完整渲染可交付。检查不可用时保留未验收标记。',{summary:string},['summary']),
]

export function createMotionAgentTools(options,state,files) {
  const {projectDirectory,packDir,publicDir,signal,assets}=options
  const audioService=createAudioService()
  const input=()=>({...options.input,refs:[...options.input.refs,...state.references]})
  const load=()=>readMotionProject(projectDirectory,input())
  const saveMeta=value=>agentAtomicJson(files.path('composition.json',{write:true}),value)
  const safeArea=(area,name)=>{
    const roots={project:projectDirectory,assets:publicDir,qa:join(packDir,'qa'),observations:join(packDir,'agent-observations')}
    if(!Object.hasOwn(roots,area)||typeof name!=='string'||isAbsolute(name)||name.includes(':')||/^\\\\/i.test(name)||name.includes('\0'))throw new Error('图片路径无效')
    const root=realpathSync(roots[area]),file=realpathSync(join(root,name)),rel=relative(root,file)
    if(isAbsolute(rel)||rel==='..'||/^\.\.[\\/]/.test(rel))throw new Error('图片超出工程或冻结素材目录')
    if(area==='project')files.path(name)
    return file
  }
  async function imageView(args) {
    let area=args.area,name=args.path,file=safeArea(area,name)
    if(args.time!==undefined||args.region){
      const directory=join(packDir,'agent-observations');mkdirSync(directory,{recursive:true})
      const time=Number(args.time??0)
      if(!Number.isFinite(time)||time<0||time>600)throw new Error('抽帧时间无效')
      const region=args.region
      if(region&&(!Array.isArray(region)||region.length!==4||region.some(n=>!Number.isInteger(n)||n<0||n>100000)||region[2]<1||region[3]<1))throw new Error('裁切区域无效')
      const output=agentHash(JSON.stringify({file,sha:agentHash(readFileSync(file)),time,region})).slice(0,24)+'.png'
      const command=['-hide_banner','-loglevel','error','-y',...(args.time!==undefined?['-ss',String(time)]:[]),'-i',file,'-frames:v','1',...(region?['-vf',`crop=${region[2]}:${region[3]}:${region[0]}:${region[1]},scale='min(1600,iw)':-2`]:['-vf','scale=1600:-2']),join(directory,output)]
      await exec(ffmpegBinary(),command,{windowsHide:true,timeout:30000,maxBuffer:1024*1024,signal})
      area='observations';name=output;file=join(directory,output)
    }
    if(!/\.(png|jpe?g|webp)$/i.test(file)||statSync(file).size>16*1024*1024)throw new Error('请查看16MB内的PNG/JPEG/WebP；视频请指定time')
    const descriptor={area,path:name,sha256:agentHash(readFileSync(file)),fingerprint:files.fingerprint()}
    return {value:{image:descriptor,note:'像素将通过宿主附件传给下一轮模型；未支持视觉时会明确说明。'},images:[descriptor]}
  }
  const handlers={
    async page_capture(args){
      const capture=await captureMotionPage(args,{directory:join(packDir,'captures'),signal})
      let n=Math.max(0,...Object.values(assets).flat().map(a=>Number(/^asset-(\d+)/.exec(a.src)?.[1])||0))
      const existingBytes=Object.values(assets).flat().filter(a=>a.kind==='image').reduce((sum,a)=>sum+statSync(join(publicDir,a.src)).size,0)
      if(existingBytes+capture.files.reduce((sum,f)=>sum+statSync(join(packDir,'captures',f.filename)).size,0)>48*1024*1024)throw Error('冻结图片总量超过48MB，请减少页面或切片')
      const rows=[]
      for(const [index,file]of capture.files.entries()){
        const id=capture.id+'-'+index,src='asset-'+(++n)+'.png'
        copyFileSync(join(packDir,'captures',file.filename),join(publicDir,src))
        assets[id]=[{kind:'image',src,sha256:file.sha256,width:file.width*capture.viewport.scale,height:file.height*capture.viewport.scale,sourceNodeId:id,provenance:{url:capture.url,captureId:capture.id,selector:file.selector,kind:file.kind}}]
        state.references.push({id,role:'material',nodes:[{id,label:file.label||file.kind,style:'shape=image;',x:file.x,y:file.y,w:file.width,h:file.height,data:{}}],edges:[]})
        rows.push({...file,referenceId:id,asset:assets[id][0]})
      }
      files.write('captures/'+capture.id+'.json',JSON.stringify({...capture,files:rows},null,2))
      state.lastRender=null;state.lastReview=null
      await options.onReferences?.(state.references)
      return {...capture,files:rows,note:'素材已冻结。用image_view area:assets检查图片，分镜referenceIds引用返回ID；完整布局在project/captures。'}
    },
    async project_files(args){
      if(args.action==='list')return {files:files.entries()}
      if(args.action==='read')return files.read(args.path,args.offset,args.limit)
      if(args.action==='write'){const result=files.write(args.path,args.content,args.expectedSha256);state.lastRender=null;state.lastReview=null;return result}
      if(args.action==='patch'){const result=files.patch(args.path,args.oldText,args.newText);state.lastRender=null;state.lastReview=null;return result}
      if(args.action==='search'){
        if(typeof args.query!=='string'||!args.query||args.query.length>200)throw new Error('搜索词无效')
        const matches=[]
        for(const row of files.entries().filter(row=>/\.(tsx?|jsx?|json|css|md|txt)$/.test(row.path)&&row.bytes<=400000)){
          const text=readFileSync(files.path(row.path),'utf8'),index=text.indexOf(args.query)
          if(index>=0)matches.push({path:row.path,index,excerpt:text.slice(Math.max(0,index-120),index+600)})
          if(matches.length>=40)break
        }
        return {matches}
      }
      throw new Error('未知文件操作')
    },
    async shotcraft_library(args){
      if(args.action==='search')return {matches:searchShotCards(shotCardCatalog,args.query,args.category).slice(0,30)}
      if(args.action==='index')return {commit:shotcraftLibrary.commit,files:Object.keys(shotcraftLibrary.files).filter(path=>!args.query||path.includes(args.query)).slice(0,300)}
      if(args.action==='read'){
        const text=shotcraftFile(args.path),offset=Number(args.offset??0),limit=Number(args.limit??24000)
        if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100000)throw new Error('资料读取范围无效')
        return {path:args.path,sha256:agentHash(text),length:text.length,offset,text:text.slice(offset,offset+limit),more:offset+limit<text.length}
      }
      throw new Error('未知镜头资料操作')
    },
    async project_plan(args){
      const raw=args.plan
      if(!raw||!Array.isArray(raw.shots))throw new Error('需要分镜plan.shots')
      const placeholder='export default function Scene(){return null}'
      const plan=enforceMotionCards(validateMotionPlan({...raw,shots:raw.shots.map(shot=>({...shot,recipeId:'scene',sceneSource:placeholder,
        ...((shot.components||shot.sceneComponents)?{sceneComponents:(shot.components||shot.sceneComponents).map(c=>({...c,source:placeholder}))}:{})}))},input()),input())
      saveMeta(plan)
      for(const [index,shot]of plan.shots.entries())if(shot.sceneComponents?.length&&!existsSync(files.path('scene-'+index+'.tsx'))){
        files.write('scene-'+index+'.tsx',composeSceneSource(shot))
      }
      prepareMotionProject(plan,projectDirectory,{preserveSources:true,refreshEntry:true})
      state.lastRender=null;state.lastReview=null
      await options.onStage?.('storyboard',{production:plan.production,shots:plan.shots.map(({sceneSource,sceneComponents,...shot})=>shot)})
      return {settings:input().settings,shots:plan.shots.map((shot,index)=>({id:shot.id,sceneFile:'scene-'+index+'.tsx',components:shot.sceneComponents?.map(c=>({id:c.id,path:`components/${shot.id}/${c.id}.tsx`}))})),note:'按上述入口写入真实场景。现有源码保留；修改图层清单时请同步修改场景组装。'}
    },
    async project_render(args){
      if(!['compile','still','preview','full'].includes(args.action))throw new Error('未知渲染操作')
      const composition=load(),fingerprint=files.fingerprint()
      if(args.action==='still'&&(!Array.isArray(args.frames)||args.frames.length<1||args.frames.length>12||args.frames.some(n=>!Number.isInteger(n)||n<0||n>=composition.durationFrames)))throw new Error('请指定1–12个有效截图帧')
      if(args.action==='preview'&&(!Number.isInteger(args.startFrame)||!Number.isInteger(args.endFrame)||args.startFrame<0||args.endFrame<args.startFrame||args.endFrame>=composition.durationFrames))throw new Error('预览范围无效')
      const preview=join(packDir,'agent-previews');mkdirSync(preview,{recursive:true})
      const full=args.action==='full',output=full?join(packDir,'source.mp4'):join(preview,'preview.mp4')
      const result=await options.render({composition,assets,publicDir,projectDirectory,preserveSources:true,
        qaDirectory:full?join(packDir,'qa'):join(packDir,'agent-observations'),
        operation:full?'render':args.action==='preview'?'render':args.action,
        output,poster:full?join(packDir,'poster.png'):join(preview,'poster.png'),
        ...(args.frames?{frames:args.frames}:{}),...(args.action==='preview'?{frameRange:[args.startFrame,args.endFrame]}:{})})
      if(files.fingerprint()!==fingerprint)throw new Error('渲染期间工程发生变化，请重新检查并渲染')
      if(full){state.lastRender={fingerprint,qa:result?.qa||{},output:'source.mp4'};state.lastReview=null}
      // still/preview QA live beside their output, outside the project sources.
      return {action:args.action,output:full?'source.mp4':args.action==='preview'?'agent-previews/preview.mp4':undefined,
        frames:(result?.frames||result?.qa?.frames||[]).map(frame=>({...frame,area:full?'qa':'observations',path:frame.filename})),
        qa:result?.qa||null,compiled:result?.compiled||false,note:args.action==='still'?'用image_view area:observations查看返回帧。':'用image_view查看完整渲染的qa图片，再独立检查。'}
    },
    image_view:imageView,
    async project_review(){
      const fingerprint=files.fingerprint()
      if(!state.lastRender||state.lastRender.fingerprint!==fingerprint)throw new Error('请先完整渲染最新工程')
      const composition=load(),qa=state.lastRender.qa
      let review=options.review?await options.review(composition,qa):{status:'unavailable',reason:'宿主未提供独立视觉审查'}
      if(options.inspectFilm){
        const film=await options.inspectFilm(composition)
        qa.film=film
        if(film.motion.status==='changes-requested')review={...review,status:'changes-requested',issues:[...(review.issues||[]),...film.motion.sequences.flatMap(s=>s.issues||[])]}
        else if(film.motion.status==='unavailable'&&review.status==='passed')review={...review,status:'unavailable',reason:'关键帧通过；全片时序审查未完成'}
      }
      state.lastReview={fingerprint,review}
      return {...review,...(qa.referenceFrames?{referenceFrames:qa.referenceFrames}:{})}
    },
    async audio_assets(args){
      if(args.action==='list')return {sources:input().refs.filter(ref=>ref.role==='audio').map(ref=>({referenceId:ref.id,label:ref.nodes[0]?.label,asset:assets[ref.id]?.[0]}))}
      if(args.action==='search')return audioService.search(options.scope,args,signal)
      if(args.action==='get'){
        audioNodeData(args.role||'sfx')
        const result=await audioService.get(options.scope,args,signal),{file,manifest}=frozenAudioFile(options.scope.drawioAbs,result.clip)
        const count=Math.max(0,...Object.values(assets).flat().map(a=>Number(/^asset-(\d+)/.exec(a.src)?.[1])||0))+1
        const src='asset-'+count+'.wav',id='agent-audio-'+count
        if(Object.values(assets).flat().filter(a=>a.kind==='audio').reduce((n,a)=>n+(statSync(join(publicDir,a.src)).size),0)+statSync(file).size>128*1024*1024)throw new Error('音频快照超过128MB')
        const data={...result.data,...audioNodeData(args.role||'sfx')}
        copyFileSync(file,join(publicDir,src))
        assets[id]=[{kind:'audio',src,sha256:manifest.sha256,duration:manifest.duration,provenance:manifest.provenance,...audioNodeSettings(data)}]
        state.references.push({id,role:'audio',nodes:[{id,label:manifest.name,style:'',data}],edges:[]})
        await options.onReferences?.(state.references)
        return {referenceId:id,asset:assets[id][0],note:'这是当前工程内部声音来源；来源许可随成片工程保存。'}
      }
      if(args.action==='analyze'){
        const asset=assets[args.referenceId]?.[0]
        if(asset?.kind!=='audio')throw new Error('请选择已冻结音频')
        const file=safeArea('assets',asset.src),{log,...result}=await analyzeAudio(file,signal)
        return {...result,log:log.slice(-4000),listening:'not-performed'}
      }
      throw new Error('未知声音操作')
    },
    async audio_timeline(args){const composition=load(),audio=validateAudioTimeline(args.plan,composition,input());const raw=JSON.parse(readFileSync(files.path('composition.json'),'utf8'));saveMeta({...raw,audio});return audio},
    async finish_production(args){
      const fingerprint=files.fingerprint(),composition=load()
      if(!state.lastRender||state.lastRender.fingerprint!==fingerprint)throw new Error('最新工程尚未完整渲染')
      if(!state.lastReview||state.lastReview.fingerprint!==fingerprint)throw new Error('请先调用project_review独立检查最新成片')
      if(state.lastReview.review.status==='changes-requested')throw new Error('独立检查要求修复，请修改后重新渲染并检查')
      if(options.canViewImages&&!state.viewed.some(image=>image.fingerprint===fingerprint&&image.area==='qa'))throw new Error('请实际查看最新版成片QA图片，再完成制作')
      if(!existsSync(join(packDir,'source.mp4'))||!existsSync(join(packDir,'poster.png')))throw new Error('缺少成片或封面')
      return {finished:true,composition,qa:{...state.lastRender.qa,review:state.lastReview.review,
        visualReview:state.lastReview.review.status==='passed'?'sampled-keyframes-passed':'manual-required'},summary:String(args.summary||'').slice(0,2000)}
    },
  }
  return {handlers,input,load,safeArea}
}
