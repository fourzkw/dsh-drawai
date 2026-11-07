import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { importAudioFile, frozenAudioFile, sourceFreesound, audioScopeDirectory } from './audio-media.js'
import { audioNodeData } from './motion-core.js'
import { clipDirFor } from './media.js'

export function createAudioService() {
  const uploads=new Map()
  const cache=scope=>audioScopeDirectory(scope.drawioAbs,join(dirname(scope.drawioAbs),'.drawai-cache','audio'),true)
  const owner=(scope,token)=>{
    const job=uploads.get(token)
    if(!job||job.sessionId!==scope.sessionId||job.drawioAbs!==scope.drawioAbs)throw new Error('音频上传令牌不属于当前画布或会话')
    return job
  }
  return {
    async search(scope,args,signal){return sourceFreesound('search',args,join(cache(scope),'search'),signal)},
    async get(scope,args,signal){
      const directory=join(cache(scope),'freesound-'+randomUUID())
      try{
        const result=await sourceFreesound('get',args,directory,signal)
        const row=result.results?.find(item=>item.ok)?.asset
        if(!row||!/^assets\/sfx\/fs-\d+\.mp3$/.test(row.file))throw new Error('未下载到可用音效')
        return await importAudioFile(scope.drawioAbs,join(directory,row.file),{name:row.name||row.title||row.file,role:'sfx',provenance:row,signal})
      }finally{rmSync(audioScopeDirectory(scope.drawioAbs,directory),{recursive:true,force:true})}
    },
    start(scope,args){
      for(const [token,job]of uploads)if(!job.finishing&&Date.now()-job.time>3600000){rmSync(audioScopeDirectory(job.drawioAbs,job.directory),{recursive:true,force:true});uploads.delete(token)}
      audioNodeData(args.role||'sfx')
      if(uploads.size>=16)throw new Error('音频上传任务已满')
      if(!Number.isInteger(args.size)||args.size<1||args.size>32*1024*1024||!['mp3','wav','m4a','aac','ogg','flac','webm'].includes(args.extension))throw new Error('请选择32MB以内的音频文件')
      const token=randomUUID(),directory=join(cache(scope),'upload-'+token),file=join(directory,'source.'+args.extension)
      mkdirSync(directory,{recursive:true});writeFileSync(file,'')
      uploads.set(token,{...scope,directory,file,size:args.size,received:0,name:String(args.name||'音频').slice(0,240),role:args.role||'sfx',time:Date.now()})
      return {token}
    },
    chunk(scope,args){
      const job=owner(scope,args.token)
      if(job.finished||job.finishing||args.offset!==job.received||typeof args.base64!=='string'||args.base64.length>1400000||/[^A-Za-z0-9+/=]/.test(args.base64))throw new Error('音频分块顺序或格式无效')
      const bytes=Buffer.from(args.base64,'base64')
      if(bytes.toString('base64')!==args.base64)throw new Error('音频分块编码无效')
      if(bytes.length<1||bytes.length>1024*1024||job.received+bytes.length>job.size)throw new Error('音频分块超出范围')
      audioScopeDirectory(scope.drawioAbs,job.file)
      appendFileSync(job.file,bytes);job.received+=bytes.length;job.time=Date.now()
      return {received:job.received}
    },
    async finish(scope,args,signal){
      const job=owner(scope,args.token)
      if(job.finished)return job.result
      if(job.received!==job.size)throw new Error('音频尚未上传完整')
      if(job.finishing)throw new Error('音频正在处理')
      job.finishing=true
      try{job.result=await importAudioFile(scope.drawioAbs,job.file,{name:job.name,role:job.role,signal});job.finished=true;return job.result}
      finally{job.finishing=false}
    },
    release(scope,args){const job=owner(scope,args.token);if(job.finishing)throw new Error('音频仍在处理');rmSync(audioScopeDirectory(scope.drawioAbs,job.directory),{recursive:true,force:true});uploads.delete(args.token);return {}},
    read(scope,clip){
      const {manifest}=frozenAudioFile(scope.drawioAbs,clip),file=join(clipDirFor(scope.drawioAbs,clip),'preview.m4a')
      audioScopeDirectory(scope.drawioAbs,file)
      if(statSync(file).size>16*1024*1024)throw new Error('音频预览过大')
      return {manifest,mime:'audio/mp4',base64:readFileSync(file).toString('base64')}
    },
    leases(scope){return [...uploads.values()].filter(job=>job.drawioAbs===scope.drawioAbs&&job.result).map(job=>job.result.clip)},
  }
}
