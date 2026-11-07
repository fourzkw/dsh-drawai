/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { readFile, realpath } from 'node:fs/promises'
import { relative, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureFfmpeg } from './ffmpeg-manager.js'
const exec=promisify(execFile)

export async function loadFrozenReferenceImages(input,assets,publicDir,options) {
  const {llm,config,attachments,signal}=options
  const visualRefs=input.refs.filter(ref=>['material','layout','style'].includes(ref.role))
  if(!visualRefs.length)return {status:'not-needed',images:[]}
  if(!llm?.resolveModelInfo||!attachments?.saveImage||!config?.provider||!config?.model)return {status:'unavailable',reason:'宿主未提供可确认的图片输入或附件能力',images:[]}
  const model=await llm.resolveModelInfo(config.provider,config.model,signal)
  if(!model?.inputModalities?.includes('image'))return {status:'unavailable',reason:'当前模型未声明图片输入能力',images:[]}
  if(!publicDir)return {status:'not-needed',images:[]}
  const root=await realpath(publicDir),images=[]
  for(const ref of input.refs) for(const [index,asset] of (assets?.[ref.id]||[]).entries()) {
    if(asset.kind==='audio')continue
    if(signal?.aborted)throw new Error('已取消参考图片准备')
    if(!/^asset-\d+\.(png|jpg|webp|mp4)$/.test(asset.src))throw new Error('图片理解素材路径无效')
    const path=await realpath(join(root,asset.src)),rel=relative(root,path)
    if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('图片理解素材超出冻结目录')
    const samples=asset.kind==='video'?[0,.5]:[null]
    for(const fraction of samples){
      if(signal?.aborted)throw new Error('已取消参考图片准备')
      let data,mediaType,name=asset.src
      if(fraction===null){data=await readFile(path);mediaType=asset.src.endsWith('jpg')?'image/jpeg':asset.src.endsWith('webp')?'image/webp':'image/png'}
      else{
        // Video snapshots describe appearance; two stills are not motion analysis.
        const binary=await ensureFfmpeg({signal})
        const {stdout}=await exec(binary,['-hide_banner','-loglevel','error','-ss',String(fraction),'-i',path,'-frames:v','1','-vf','scale=1280:-2','-f','image2pipe','-vcodec','png','pipe:1'],{encoding:'buffer',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,signal})
        data=stdout;mediaType='image/png';name=asset.src+'-'+fraction+'.png'
      }
      const attachment=await attachments.saveImage({data,mediaType,name})
      images.push({referenceId:ref.id,nodeId:asset.sourceNodeId||ref.nodes[index]?.id||ref.id,index,role:ref.role,
        ...(fraction!==null?{videoTime:fraction}:{}),sha256:createHash('sha256').update(data).digest('hex'),content:{type:'image',attachment}})
    }
  }
  const missingReferences=visualRefs.filter(ref=>!images.some(image=>image.referenceId===ref.id)).map(ref=>ref.id)
  return {status:missingReferences.length?'partial':'ready',images,missingReferences,
    ...(missingReferences.length?{reason:'以下参考未提供可见快照：'+missingReferences.join(', ')}:{})}
}
