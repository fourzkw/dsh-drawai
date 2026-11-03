// Scripted provider fixture uses the host's native tool-call protocol. It is
// deliberately separate from production: no automatic JSON-only fallback.
export async function* motionAgentFixture(request,{source,truncate=false}={}) {
  const brief=JSON.parse(request.messages[0].content[0].text)
  const results=request.messages.filter(m=>m.role==='tool'),calls=request.messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(b=>b.type==='tool-call'))
  const last=name=>results.findLast(m=>calls.some(c=>c.id===m.toolCallId&&c.name===name))
  const has=name=>!!last(name)
  let name,args
  const image=Object.values(brief.assets).flat().find(a=>a.kind==='image')
  if(image&&!has('image_view')){name='image_view';args={area:'assets',path:image.src}}
  else if(truncate){yield {type:'finish',reason:{kind:'max-tokens'}};return}
  else if(!has('project_plan')){name='project_plan';args={plan:{production:{brief:'测试成片'},shots:[{recipeId:'scene',startFrame:0,durationFrames:brief.totalFrames,referenceIds:brief.references.filter(r=>['material','layout'].includes(r.role)).map(r=>r.id),title:'一句话成片',motionCards:brief.requiredMotionCards}]}}}
  else if(!calls.some(c=>c.name==='project_files'&&JSON.parse(c.arguments).action==='read')){name='project_files';args={action:'read',path:'scene-0.tsx'}}
  else if(!calls.some(c=>c.name==='project_files'&&JSON.parse(c.arguments).action==='write')){
    const read=JSON.parse(last('project_files').content[0].text)
    name='project_files';args={action:'write',path:'scene-0.tsx',content:source,...(read.sha256?{expectedSha256:read.sha256}:{})}
  }
  else if(!has('project_render')){name='project_render';args={action:'full'}}
  else if(!results.some(m=>{const c=calls.find(c=>c.id===m.toolCallId);return c?.name==='image_view'&&JSON.parse(c.arguments).area==='qa'})){
    const render=JSON.parse(last('project_render').content[0].text)
    if(render.error)throw Error(render.error)
    name='image_view';args={area:'qa',path:render.frames[0].path}
  }
  else if(!has('project_review')){name='project_review';args={}}
  else{name='finish_production';args={summary:'已生成并检查'}}
  yield {type:'block-end',index:0,block:{type:'tool-call',id:'fixture-'+(calls.length+1),name,arguments:JSON.stringify(args)}}
  yield {type:'finish',reason:{kind:'tool-calls'},replayState:{fixture:true}}
}
