/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {ensureFfmpeg} from './ffmpeg-manager.js'
import {agentHash,agentAtomicJson} from './motion-agent-files.js'
import {streamAgentTurn,agentMessage} from './motion-agent-protocol.js'
const exec=promisify(execFile)
const run=async(args,signal)=>{const binary=await ensureFfmpeg({signal});return exec(binary,['-hide_banner','-nostdin',...args],{windowsHide:true,signal,timeout:180000,maxBuffer:8*1024*1024})}

// Decode the actual delivered file, including its final mixed audio. Visual
// semantics use ordered contact sheets; listening is a separate human verdict.
export async function inspectMotionFilm({packDir,composition,signal,reviewSequence,expectedAudio=false,previousMotion}){
  const source=join(packDir,'source.mp4'),sha256=agentHash(readFileSync(source)),directory=join(packDir,'film-review',sha256.slice(0,16))
  mkdirSync(directory,{recursive:true})
  const decoded=await run(['-xerror','-i',source,'-map','0:v:0','-vf','blackdetect=d=0.12:pix_th=0.02,freezedetect=n=-50dB:d=0.35','-an','-progress','pipe:1','-f','null','-'],signal)
  const log=decoded.stderr,frames=Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1])
  const durationMatch=/Duration:\s*(\d+):(\d+):([\d.]+)/.exec(log)
  if(!durationMatch||!frames)throw Error('成片无法完整解码')
  const duration=Number(durationMatch[1])*3600+Number(durationMatch[2])*60+Number(durationMatch[3]),expected=composition.durationFrames/composition.fps
  if(Math.abs(duration-expected)>Math.max(.12,2/composition.fps)||Math.abs(frames-composition.durationFrames)>1)throw Error('成片时长或帧数与工程不一致')
  const warnings=[]
  for(const match of log.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g))warnings.push({kind:'black',from:Number(match[1]),to:Number(match[2]),note:'可能为设计留黑，需结合画面判断'})
  for(const match of log.matchAll(/freeze_start: ([\d.]+)/g))warnings.push({kind:'freeze',from:Number(match[1]),note:'可能为有意停留，需结合分镜判断'})
  let audio={hasAudio:/Stream .*Audio:/.test(log),listening:'not-performed'}
  if(expectedAudio&&!audio.hasAudio)throw Error('声音时间表非空，但最终视频缺少音轨')
  if(audio.hasAudio){
    const measured=await run(['-i',source,'-map','0:a:0','-vn','-af','ebur128=peak=true,silencedetect=noise=-50dB:d=0.4','-f','null','-'],signal)
    const summary=measured.stderr.slice(measured.stderr.lastIndexOf('Summary:'))
    const value=(pattern)=>{const text=pattern.exec(summary)?.[1];return text&&Number.isFinite(Number(text))?Number(text):null}
    audio={...audio,integratedLufs:value(/I:\s*(-?[\d.]+) LUFS/),truePeakDb:value(/Peak:\s*(-?[\d.]+) dBFS/),
      silence:[...measured.stderr.matchAll(/silence_start: ([\d.]+)/g)].map(m=>Number(m[1]))}
    if(audio.truePeakDb!==null&&audio.truePeakDb>-.1)warnings.push({kind:'audio-peak',note:'真峰值接近或超过0 dBFS，请试听失真'})
    if(audio.integratedLufs!==null&&audio.integratedLufs<-50)warnings.push({kind:'audio-silence',note:'整片音轨近乎静音，请核对声音需求'})
    writeFileSync(join(directory,'audio-analysis.log'),measured.stderr)
  }
  const samplingFps=6,panelSeconds=12/samplingFps
  await run(['-y','-i',source,'-an','-vf',`fps=${samplingFps},scale=320:-2,tile=4x3:padding=2:margin=2`,'-fps_mode','vfr',join(directory,'sequence-%03d.png')],signal)
  const sheets=readdirSync(directory).filter(name=>/^sequence-\d+\.png$/.test(name)).sort().map((filename,index)=>({filename,from:index*panelSeconds,to:Math.min(duration,(index+1)*panelSeconds),
    times:Array.from({length:Math.min(12,Math.ceil((duration-index*panelSeconds)*samplingFps))},(_,j)=>(index*12+j)/samplingFps)}))
  const sequences=[]
  for(const sheet of sheets){
    signal?.throwIfAborted()
    if(previousMotion||!reviewSequence){sequences.push({...sheet,status:'unavailable',reason:'未配置支持图片的时序审查模型'});continue}
    try{
      const result=await reviewSequence({file:join(directory,sheet.filename),sheet,composition,warnings:warnings.filter(w=>w.from===undefined||w.from>=sheet.from&&w.from<=sheet.to)})
      if(!['passed','changes-requested','unavailable'].includes(result?.status))throw Error('时序审查响应状态无效')
      sequences.push({...sheet,...result})
    }catch(error){if(signal?.aborted)throw error;sequences.push({...sheet,status:'unavailable',reason:error.message})}
  }
  const motion=previousMotion||{status:sequences.some(s=>s.status==='changes-requested')?'changes-requested':sequences.some(s=>s.status!=='passed')?'unavailable':'passed',
    coverage:'whole-film-ordered-samples',samplingFps,note:'覆盖全片的有序采样；不等于每帧运动或完整视频感知验收',sequences}
  const result={version:1,sha256,duration,decodedFrames:frames,decode:'passed',motion,audio,warnings,
    manual:{status:'pending',motion:'pending',sound:audio.hasAudio?'pending':'not-applicable'},directory,createdAt:new Date().toISOString()}
  writeFileSync(join(directory,'decode.log'),log)
  agentAtomicJson(join(directory,'report.json'),result)
  return result
}

export function motionSequenceReviewer({llm,config,attachments,sessionId,signal}){
  return async({file,sheet,composition,warnings})=>{
    const attachment=await attachments.saveImage({data:readFileSync(file),mediaType:'image/png',name:sheet.filename})
    const assistant=await streamAgentTurn({llm,config,sessionId,signal},[agentMessage('user',[{type:'text',text:JSON.stringify({sheet,shots:composition.shots.map(({sceneSource,sceneComponents,...shot})=>shot),warnings})},{type:'image',attachment}])],[],
      '你是独立的视频时序审查员。图片每行从左到右、从上到下按times排列，每秒6帧。检查主体跳变、意外闪烁、跨镜头衔接、文字突然消失和停留节奏。区分有意切镜/静止和缺陷。只输出JSON {"status":"passed或changes-requested","issues":[{"time":秒,"reason":"具体可见问题"}]}。没有音频输入，不判断听感；不声称看到了采样之间的运动。')
    const text=assistant.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')
    const value=JSON.parse(text)
    if(!['passed','changes-requested'].includes(value.status)||!Array.isArray(value.issues))throw Error('时序审查响应无效')
    return {status:value.status,issues:value.issues.slice(0,12)}
  }
}
