import React from 'react'
import { Img, OffthreadVideo, staticFile } from 'remotion'
export function ReferenceMedia({ referenceId, index = 0, assets, style = {}, region }) {
  const asset = (assets[referenceId] || []).at(index)
  if (!asset) throw new Error('场景缺少参考素材：' + referenceId + ':' + index)
  if(region && (!Array.isArray(region)||region.length!==4||region.some(value=>!Number.isFinite(value))||region[0]<0||region[1]<0||region[2]<=0||region[3]<=0||region[0]+region[2]>1.001||region[1]+region[3]>1.001))throw new Error('参考素材裁切区域无效')
  const props = { src: staticFile(asset.src), style: region ? {position:'absolute',objectFit:'fill',width:100/region[2]+'%',height:100/region[3]+'%',left:-region[0]/region[2]*100+'%',top:-region[1]/region[3]*100+'%'} : { objectFit: 'contain', ...style } }
  const media=asset.kind === 'video' ? <OffthreadVideo {...props} muted /> : <Img {...props} />
  return region?<div style={{...style,position:style.position||'relative',overflow:'hidden'}}>{media}</div>:media
}
