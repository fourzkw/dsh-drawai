/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, realpathSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname, basename, relative, isAbsolute } from 'node:path'
import { searchSfx, getSfx } from './motion/sfx.js'
import { ffmpegBinary } from './video-export.js'
import { clipDirFor, ensureClipPack, mediaRootFor } from './media.js'
import { audioNodeData, audioNodeSettings, validateAudioTimeline } from './motion-core.js'
const exec = promisify(execFile)
const MAX_BYTES = 32 * 1024 * 1024
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const run = (args,signal,timeout=120000) => exec(ffmpegBinary(),args,{windowsHide:true,timeout,maxBuffer:2*1024*1024,signal})

export function audioScopeDirectory(drawioAbs,directory,create=false) {
  const root=realpathSync(dirname(drawioAbs))
  let ancestor=directory
  while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw new Error('音频目录无效');ancestor=parent}
  const inside=value=>{const rel=relative(root,realpathSync(value));if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw new Error('音频真实路径超出画布目录')}
  inside(ancestor)
  if(create)mkdirSync(directory,{recursive:true})
  if(existsSync(directory))inside(directory)
  return directory
}

export function frozenAudioFile(drawioAbs,clip) {
  const directory=realpathSync(audioScopeDirectory(drawioAbs,clipDirFor(drawioAbs,clip))),file=realpathSync(join(directory,'audio.wav'))
  const rel=relative(directory,file)
  if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('音频文件超出媒体包')
  const manifest=JSON.parse(readFileSync(audioScopeDirectory(drawioAbs,join(directory,'audio.json')),'utf8'))
  if(sha(readFileSync(file))!==manifest.sha256)throw new Error('音频文件已改变，请重新导入')
  return {file,manifest}
}

export async function analyzeAudio(file,signal) {
  const {stderr}=await run(['-hide_banner','-i',file,'-map','0:a:0','-af','volumedetect','-f','null','-'],signal)
  const duration=/Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr)
  if(!duration)throw new Error('无法读取音频时长')
  const seconds=Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3])
  const peak=/max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1]
  return {duration:seconds,samplePeakDb:peak==='-inf'?null:Number(peak),hasAudio:true,measurement:'sample peak; not true peak or LUFS',log:stderr}
}

export async function importAudioFile(drawioAbs,source,{name=basename(source),role='sfx',provenance={provider:'upload'},signal}={}) {
  audioNodeData(role)
  if(statSync(source).size>MAX_BYTES)throw new Error('音频源文件不能超过32MB')
  const before=await analyzeAudio(source,signal)
  if(before.duration<=0||before.duration>600)throw new Error('音频时长须在0–600秒内')
  audioScopeDirectory(drawioAbs,mediaRootFor(drawioAbs),true)
  const clip='audio-'+randomUUID(),{dir}=ensureClipPack(drawioAbs,clip,{kind:'raster'})
  await run(['-hide_banner','-loglevel','error','-y','-i',source,'-map','0:a:0','-vn','-ac','2','-ar','48000','-c:a','pcm_s16le',join(dir,'audio.wav')],signal)
  await run(['-hide_banner','-loglevel','error','-y','-i',join(dir,'audio.wav'),'-c:a','aac','-b:a','128k','-movflags','+faststart',join(dir,'preview.m4a')],signal)
  const bytes=readFileSync(join(dir,'audio.wav'))
  if(bytes.length>128*1024*1024)throw new Error('标准化音频过大')
  const {log,...analysis}=await analyzeAudio(join(dir,'audio.wav'),signal)
  const manifest={version:1,name:String(name).slice(0,240),sha256:sha(bytes),sourceSha256:sha(readFileSync(source)),...analysis,provenance,
    changes:['Decoded to stereo 48kHz PCM for mixing'],createdAt:new Date().toISOString()}
  writeFileSync(join(dir,'audio.json'),JSON.stringify(manifest,null,2))
  return {clip,manifest,data:{...audioNodeData(role),audioClip:clip,audioName:manifest.name,audioDuration:String(manifest.duration),audioSha256:manifest.sha256}}
}

export function defaultAudioPlan(input,composition,assets) {
  const fps=composition.fps,total=composition.durationFrames
  const cues=input.refs.filter(ref=>ref.role==='audio').map(ref=>{
    const data=ref.nodes.find(node=>node.data?.drawaiAudio==='1')?.data||{},settings=audioNodeSettings(data)
    const duration=Number(assets[ref.id]?.[0]?.duration||data.audioDuration)
    if(!duration)throw new Error('音频还未上传：'+ref.id)
    const from=Math.round(settings.at*fps),end=settings.trimEnd||duration
    const length=Math.min(total-from,settings.loop?total:Math.max(1,Math.floor((end-settings.trimStart)*fps)))
    return {referenceId:ref.id,offsetFrames:from,durationFrames:length,trimStart:settings.trimStart,
      gainDb:settings.gainDb,fadeIn:Math.min(settings.fadeIn,length/fps),fadeOut:Math.min(settings.fadeOut,length/fps),loop:settings.loop,action:'节点设置：'+settings.role}
  })
  return validateAudioTimeline({cues},composition,input)
}

export async function mixMotionAudio({input,composition,assets,publicDir,packDir,signal,plateSource}) {
  const plan=validateAudioTimeline(composition.audio,composition,input),fps=composition.fps,seconds=composition.durationFrames/fps
  const source=join(packDir,'source.mp4'),picture=join(packDir,'picture.mp4')
  const logs=[]
  if((plateSource||plan.cues.length)&&plateSource!==picture){
    const result=await run(['-hide_banner','-y','-i',plateSource||source,'-map','0:v:0','-c:v','copy','-an',picture],signal)
    logs.push(result.stderr)
  }
  if(!plan.cues.length){
    if(plateSource)copyFileSync(picture,source)
    mkdirSync(join(packDir,'project'),{recursive:true})
    writeFileSync(join(packDir,'project','audio-plan.json'),JSON.stringify(plan,null,2))
    return {status:'silent',listening:'not-performed',variants:{picture:plateSource?'picture.mp4':'source.mp4',full:'source.mp4'}}
  }
  const manifest=[]
  const validateAsset=cue=>{
    const asset=assets[cue.referenceId]?.[0]
    if(asset?.kind!=='audio'||!/^asset-\d+\.wav$/.test(asset.src))throw new Error('音频快照不存在：'+cue.referenceId)
    const root=realpathSync(publicDir),file=realpathSync(join(root,asset.src)),rel=relative(root,file)
    if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('音频快照超出工程')
    if(sha(readFileSync(file))!==asset.sha256)throw new Error('音频快照哈希不一致')
    return {asset,file}
  }
  async function mix(cues,filename){
    if(!cues.length){copyFileSync(picture,join(packDir,filename));return}
    const args=['-hide_banner','-y','-i',picture],filters=[],voices=cues.filter(cue=>cue.role==='voice')
    cues.forEach((cue,index)=>{
      const {asset,file}=validateAsset(cue),length=cue.durationFrames/fps,end=Number(asset.trimEnd||asset.duration)
      if(cue.trimStart>=end||end>asset.duration+.011)throw new Error('音频裁切超出素材：'+cue.referenceId)
      args.push('-i',file)
      const chain=[`atrim=start=${cue.trimStart}:end=${end}`,'asetpts=PTS-STARTPTS']
      if(cue.loop)chain.push(`aloop=loop=-1:size=${Math.max(1,Math.round((end-cue.trimStart)*48000))}`)
      chain.push(`atrim=duration=${length}`,`volume=${Math.pow(10,cue.gainDb/20)}`)
      if(cue.fadeIn)chain.push(`afade=t=in:st=0:d=${cue.fadeIn}`)
      if(cue.fadeOut)chain.push(`afade=t=out:st=${Math.max(0,length-cue.fadeOut)}:d=${cue.fadeOut}`)
      if(cue.role==='bgm'&&voices.length){
        const windows=voices.map(voice=>`between(t,${(voice.from-cue.from)/fps},${(voice.from+voice.durationFrames-cue.from)/fps})`).join('+')
        chain.push(`volume='if(gt(${windows},0),0.28,1)':eval=frame`)
      }
      chain.push(`apad=pad_dur=${length}`,`atrim=duration=${length}`,`adelay=${Math.round(cue.from/fps*48000)}S:all=1`)
      filters.push(`[${index+1}:a]${chain.join(',')}[a${index}]`)
      manifest.push({referenceId:cue.referenceId,sha256:asset.sha256,provenance:asset.provenance})
    })
    filters.push(cues.map((_,index)=>`[a${index}]`).join('')+`amix=inputs=${cues.length}:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad,atrim=duration=${seconds}[mix]`)
    const script=join(packDir,'project','mix-'+filename+'.txt');mkdirSync(dirname(script),{recursive:true});writeFileSync(script,filters.join(';\n'))
    const temporary=join(packDir,filename+'.mixing.mp4')
    try {
    const result=await run([...args,'-filter_complex_script',script,'-map','0:v:0','-map','[mix]','-c:v','copy','-c:a','aac','-ar','48000','-b:a','192k','-t',String(seconds),'-movflags','+faststart',temporary],signal,180000)
    logs.push(result.stderr);renameSync(temporary,join(packDir,filename))
    } finally { if(existsSync(script))unlinkSync(script); if(existsSync(temporary))unlinkSync(temporary) }
  }
  await mix(plan.cues,'source.mp4')
  if(plan.cues.some(cue=>cue.role==='bgm'))await mix(plan.cues.filter(cue=>cue.role!=='bgm'),'no-bgm.mp4')
  const {log,...analysis}=await analyzeAudio(source,signal);logs.push(log)
  writeFileSync(join(packDir,'project','audio-plan.json'),JSON.stringify(plan,null,2))
  writeFileSync(join(packDir,'project','audio-manifest.json'),JSON.stringify([...new Map(manifest.map(item=>[item.referenceId,item])).values()],null,2))
  return {status:'mixed',...analysis,listening:'not-performed',warnings:analysis.samplePeakDb===null||analysis.samplePeakDb<=-90?['成片音轨几乎静音，请试听检查']:[],
    variants:{full:'source.mp4',picture:'picture.mp4',...(plan.cues.some(cue=>cue.role==='bgm')?{noBgm:'no-bgm.mp4'}:{})}}
}

// 两个音效入口共用 JS 下载器，避免 Python 分支的许可拦截与重复清单。
export async function sourceFreesound(action,args,directory,signal) {
  signal?.throwIfAborted()
  if(action==='search') {
    const found=await searchSfx({...args,signal})
    return {provider:'freesound',query:found.query,results:found.results.map(row=>({...row,name:row.title,duration:row.seconds,license_label:row.licenseLabel}))}
  }
  const result=await getSfx(directory,[args.id],{persist:false,signal})
  signal?.throwIfAborted()
  return {...result,results:result.results.map(row=>row.ok?{...row,asset:{...row.asset,file:'assets/'+row.asset.file}}:row)}
}
