import assert from 'node:assert/strict'
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {buildCanvas} from '../src/canvas-format.js'
import {motionNodeData} from '../src/motion-core.js'
import {apply} from '../lib/index.js'

const parent=mkdtempSync(resolve('.tmp/motion-boundaries-')), root=join(parent,'workspace'), outside=join(parent,'outside.svg')
mkdirSync(root); writeFileSync(outside,'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
const node=id=>({id,label:id,x:0,y:0,w:320,h:180,style:'',data:motionNodeData()})
const initial=JSON.parse(buildCanvas({meta:{},nodes:[node('shared')],edges:[],layers:[{id:'1'}]},{format:'drawai'}).text)
const bad=node('bad'); bad.data.motion.project='../../outside-project'
initial.pages.push({id:'page-two',name:'第二页',doc:{meta:{},nodes:[node('shared'),node('second'),bad],edges:[],layers:[{id:'1'}]}})
writeFileSync(join(root,'first.drawai'),JSON.stringify(initial));writeFileSync(join(root,'other.drawai'),JSON.stringify(initial))
let readonly=false
const tools=[],session={header:{cwd:root}},ctx={tools:{register:t=>{tools.push(t);return()=>{}}},webServer:{register:()=>()=>{}},fs:{resolve:async(p,o)=>typeof p==='object'?p:{path:resolve(o?.cwd||root,p)},processPath:t=>typeof t==='string'?t:t.path,contains:(a,b)=>{const r=relative(a.path,b.path);return !isAbsolute(r)&&!r.startsWith('..')},stat:async t=>existsSync(t.path)?{size:readFileSync(t.path).length}:undefined,readText:async t=>readFileSync(t.path,'utf8'),writeText:async(t,s)=>writeFileSync(t.path,s)},sessions:{get:id=>id==='s'?session:undefined},sandboxPolicy:{resolve:()=>({mode:readonly?'read-only':'workspace-write',workspaceRoot:root})},effect(fn){return fn()}}
try {
  apply(ctx)
  const project=tools.find(x=>x.name==='motion_project'),assets=tools.find(x=>x.name==='motion_assets'),audio=tools.find(x=>x.name==='motion_audio'),qa=tools.find(x=>x.name==='motion_qa'),preview=tools.find(x=>x.name==='motion_preview'),render=tools.find(x=>x.name==='motion_render'), exec={agent:{id:'s'}}
  const create=async(path,page,nodeId,prompt)=>JSON.parse((await project.execute({action:'create',path,page,nodeId,prompt},exec)).details).dir
  const a=await create('first.drawai',0,'shared','first'),b=await create('first.drawai',1,'shared','second'),c=await create('other.drawai',0,'shared','other')
  assert.equal(new Set([a,b,c]).size,3)
  assert.match(readFileSync(join(a,'BRIEF.md'),'utf8'),/first/)
  assert.match(readFileSync(join(b,'BRIEF.md'),'utf8'),/second/)
  await create('first.drawai',1,'second','second only')
  await assert.rejects(project.execute({action:'open',path:'first.drawai',page:1,nodeId:'bad'},exec),/超出工作区/)
  await assert.rejects(assets.execute({action:'capture',path:'first.drawai',page:0,nodeId:'shared',file:outside},exec),/超出工作区/)
  await assert.rejects(audio.execute({action:'add',path:'first.drawai',page:0,nodeId:'shared',file:outside},exec),/超出工作区/)
  assert.ok(preview.parameters.properties.page && render.parameters.properties.page)
  await assert.rejects(preview.execute({path:'first.drawai',page:0,nodeId:'second',frames:[999999]},exec),/找不到视频节点/)
  await assert.rejects(preview.execute({path:'first.drawai',page:1,nodeId:'second',frames:[999999]},exec),/超出|范围/)
  const report=join(a,'.out','qa','framecq','previous.txt');mkdirSync(join(a,'.out','qa','framecq'),{recursive:true});writeFileSync(report,'unchanged')
  readonly=true
  await assert.rejects(qa.execute({action:'inspect',path:'first.drawai',page:0,nodeId:'shared'},exec),/只读/)
  await assert.rejects(preview.execute({path:'first.drawai',page:0,nodeId:'shared',frames:[0]},exec),/只读/)
  assert.equal(readFileSync(report,'utf8'),'unchanged')
  console.log('工程跨画布/页面隔离、工作区路径、页面选择和只读保护通过')
} finally { rmSync(parent,{recursive:true,force:true}) }
