/* Included in the canvas client factory. */
function AudioPanel(props) {
  const [query,setQuery]=React.useState(''),[results,setResults]=React.useState([]),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[preview,setPreview]=React.useState('')
  const [manifest,setManifest]=React.useState(null)
  const data=props.node.data||{}
  React.useEffect(()=>{
    let active=true,url=''
    setPreview('');setManifest(null)
    if(data.audioClip)props.onRead(data.audioClip).then(result=>{
      if(!active)return
      setManifest(result.manifest||null)
      const bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0))
      url=URL.createObjectURL(new Blob([bytes],{type:result.mime}));setPreview(url)
    }).catch(e=>{if(active)setError(e.message)})
    return ()=>{active=false;if(url)URL.revokeObjectURL(url)}
  },[data.audioClip])
  const run=async fn=>{if(busy)return;setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}
  const change=patch=>{try{props.onChange(patch);setError('')}catch(e){setError(e.message)}}
  const field=(label,key,min,max,step='any')=>React.createElement('label',{style:{display:'block',margin:'6px 0'}},label,
    React.createElement('input',{type:'number',min,max,step,'aria-label':label,value:data[key]||'0',onChange:e=>change({[key]:e.target.value}),style:{width:90,float:'right'}}))
  return React.createElement('div',{className:'drawai-audio-panel','aria-label':'音频节点设置',onPointerDown:e=>e.stopPropagation(),onKeyDown:e=>e.stopPropagation(),style:{padding:14,maxHeight:props.maxHeight||560,overflow:'auto',minWidth:300}},
    React.createElement('strong',null,data.audioName||'音频节点'),
    React.createElement('p',null,data.audioDuration?Number(data.audioDuration).toFixed(2)+' 秒':'上传音效、音乐或旁白，再用箭头连接视频。'),
    preview?React.createElement('audio',{controls:true,src:preview,style:{width:'100%'},'aria-label':'音频试听'}):null,
    React.createElement('button',{className:'drawai-btn',disabled:busy,onClick:props.onUpload},data.audioClip?'更换音频':'上传音频'),
    React.createElement('button',{className:'drawai-btn',onClick:props.onCreateVideo},'制作视频'),
    React.createElement('label',null,'用途 ',React.createElement('select',{'aria-label':'音频用途',value:data.audioRole||'sfx',onChange:e=>{const defaults=motionCore.audioNodeData(e.target.value);change({audioRole:e.target.value,audioGainDb:defaults.audioGainDb,audioFadeIn:defaults.audioFadeIn,audioFadeOut:defaults.audioFadeOut})}},
      [['sfx','音效'],['bgm','背景音乐'],['voice','旁白']].map(([v,l])=>React.createElement('option',{key:v,value:v},l)))),
    field('增益（dB）','audioGainDb',-60,18),field('开始播放（秒）','audioAt',0,60),
    field('裁切开始（秒）','audioTrimStart',0,600),field('裁切结束（0 至末尾）','audioTrimEnd',0,600),
    field('淡入（秒）','audioFadeIn',0,60),field('淡出（秒）','audioFadeOut',0,60),
    React.createElement('label',null,React.createElement('input',{type:'checkbox',checked:data.audioLoop==='1',onChange:e=>change({audioLoop:e.target.checked?'1':'0'})}),'循环播放'),
    React.createElement('details',null,React.createElement('summary',null,'搜索 Freesound 音效'),
      React.createElement('p',null,'下载可用于混音的 MP3 预览版；来源及许可随工程保存（许可各不相同，用之前看一眼）。'),
      React.createElement('input',{'aria-label':'音效搜索词',value:query,onChange:e=>setQuery(e.target.value),placeholder:'例如 soft whoosh'}),
      React.createElement('button',{className:'drawai-btn',disabled:busy||!query.trim(),onClick:()=>run(async()=>{const r=await props.onSearch(query);setResults(r.results||[])})},busy?'处理中…':'搜索'),
      results.map(row=>React.createElement('div',{key:row.id,style:{margin:'8px 0'}},React.createElement('span',null,(row.name||row.title||row.id)+' · '+(row.license_label||'unknown')),
        React.createElement('button',{className:'drawai-btn',disabled:busy,onClick:()=>run(()=>props.onGet(row.id))},'下载到此节点')))),
    manifest?.provenance?React.createElement('details',null,React.createElement('summary',null,'素材来源与许可'),React.createElement('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:11}},JSON.stringify(manifest.provenance,null,2))):null,
    error?React.createElement('p',{role:'alert'},error):null)
}
