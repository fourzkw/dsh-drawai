import assert from 'node:assert/strict'
import {motionAgentFixture} from './motion-agent-test-fixture.mjs'
import {randomUUID} from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { apply } from '../lib/index.js'
import { buildCanvas, parseCanvas } from '../src/canvas-format.js'
import { contentHash } from '../src/mxfile.js'
import { motionNodeData } from '../src/motion-core.js'
import { Resvg } from '@resvg/resvg-js'

mkdirSync('artifacts', { recursive: true })
const root = mkdtempSync(resolve('artifacts/motion-host-')), path = join(root, 'canvas.drawai')
let route, readonly = false, calls = 0, truncateScene = false
let visionMode = false
const visionRequests = [], visionAttachments = []
const disposers = [], tools = [], messages = []
const initial = { meta: {}, nodes: [{ id: 'movie', label: '', x: 0, y: 0, w: 320, h: 180, style: '', data: motionNodeData() }], edges: [], layers: [{ id: '1' }] }
initial.nodes[0].data.motion = { ...initial.nodes[0].data.motion, mode: 'scene', prompt: '制作一个标题渐显视频', duration: 2, fps: 12, width: 640, height: 360 }
const save = (doc = initial) => writeFileSync(path, buildCanvas(doc, { format: 'drawai' }).text)
save()
const session = { header: { cwd: root }, requestHeader: () => ({ config: { provider: 'mock', model: 'director' } }) }
apply({ tools: { register: (tool) => {tools.push(tool); return () => {}} }, webServer: { register(value) { route = value; return () => {} } },
  fs: {
    resolve: async (p, options) => typeof p === 'object' ? p : { path: resolve(options?.cwd || root, p) },
    processPath: (target) => typeof target === 'string' ? target : target.path,
    contains: (a, b) => { const rel = relative(a.path, b.path); return !isAbsolute(rel) && !rel.startsWith('..') },
    stat: async (target) => existsSync(target.path) ? { size: readFileSync(target.path).length } : undefined,
    readText: async (target) => readFileSync(target.path, 'utf8'),
    writeText: async (target, text) => { assert.equal(readonly, false); writeFileSync(target.path, text) },
  }, sessions: { get: (id) => ['s', 'other'].includes(id) ? session : undefined },
  sandboxPolicy: { resolve: () => ({ mode: readonly ? 'read-only' : 'workspace-write', workspaceRoot: root }) },
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup); return cleanup },
  get(name) {
    if(name==='attachments')return {saveImage:async image=>{visionAttachments.push(image);return {attachmentId:'vision-'+visionAttachments.length}}}
    if (name === 'agents') return {get:(id)=>({followup:(message)=>messages.push({...message,sessionId:id})})}
    if (name === 'sessionController') throw new Error('Canvas drawing must not require the main-session prompt service')
    if (name !== 'llm') return undefined
    return { resolveModelInfo:async()=>({inputModalities:['text','image']}),async *stream(request) {
      calls++; assert.equal(request.provider, 'mock'); assert.equal(request.model, 'director')
      await new Promise(resolve=>setTimeout(resolve,30))
      if(visionMode)visionRequests.push(request)
      if(request.system.startsWith('你是 DrawAI 后台')){
        yield* motionAgentFixture(request,{truncate:truncateScene,source:"import React from 'react';import {AbsoluteFill,useCurrentFrame} from 'remotion';export default function Scene(){const f=useCurrentFrame();return <AbsoluteFill style={{background:'#162340'}}><div style={{margin:40,width:80+f,height:80,background:'#80e9ce'}}/></AbsoluteFill>}"});return
      }
      if(request.system.startsWith('你是独立的')){yield {type:'text-delta',text:JSON.stringify({status:'passed',issues:[]})};yield {type:'finish',reason:{kind:'stop'}};return}
      if (truncateScene && !request.system.startsWith('你是视频导演')) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }; return
      }
      const shot = { recipeId: 'scene', startFrame: 0, durationFrames: 24, referenceIds: visionMode?['picture']:[], title: '一句话成片', subtitle: 'DrawAI 原生动效' }
      const reply = !request.system.startsWith('你是视频导演') ? { sceneSource: "import React from 'react';import {AbsoluteFill,useCurrentFrame} from 'remotion';export default function Scene(){const f=useCurrentFrame();return <AbsoluteFill style={{background:'#162340'}}><svg width='640' height='360'><circle cx={180+f*8} cy={180+Math.sin(f/6)*60} r='55' fill='#80e9ce'/><path d='M0 300 Q160 200 320 290 T640 300V360H0Z' fill='#585f8a'/></svg></AbsoluteFill>}" } : { production: { brief: '测试成片' }, shots: [shot] }
      yield { type: 'text-delta', text: request.system.startsWith('你是视频导演') ? JSON.stringify(reply) : reply.sceneSource }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  },
})
async function request(action, extra = {}) {
  const listeners = {}, body = { action, sessionId: 's', path: 'canvas.drawai', ...extra }
  const req = { method: 'POST', headers: { 'x-drawai-save': '1' }, on(event, fn) { listeners[event] = fn; return this } }
  let status, payload
  const res = { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } }
  queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() })
  await route.handler(req, res)
  return { status, ...payload }
}
try {
  const search = tools.find((tool) => tool.name === 'shotcraft_search')
  const found = JSON.parse((await search.execute({ query: '甩镜' })).details)
  assert.ok(found.styles.some((item) => item.styleKey === 'whip-pan' && item.demo.endsWith('WhipBrakeReal.tsx')))
  const applyCanvas = tools.find((tool) => tool.name === 'diagram_apply')
  await applyCanvas.execute({ path: 'canvas.drawai', layout: 'none', ops: [
    { op: 'addNode', shape: 'shotcard', cardId: 'shot-transitions', styleKey: 'whip-pan', as: 'camera', x: -400, y: 0 },
    { op: 'addNode', shape: 'shotcard', cardId: 'wall-reveal-moves', styleKey: 'wireframe-draw-on', as: 'reveal', x: -400, y: 240 },
    { op: 'addEdge', from: 'camera', to: 'movie' }, { op: 'addEdge', from: 'reveal', to: 'movie' },
  ] }, { agent: { id: 's' } })
  const cardsDoc = parseCanvas(readFileSync(path, 'utf8')).doc
  assert.equal(cardsDoc.nodes.filter((node) => node.data?.drawaiShotCard === '1').length, 2)
  const cardRead = await tools.find((tool) => tool.name === 'diagram_read').execute({ path: 'canvas.drawai' }, { agent: { id: 's' } })
  assert.ok(cardRead.nodes.some((node) => node.shape === 'shotcard' && node.styleKey === 'whip-pan'))
  const beforeBad = readFileSync(path, 'utf8')
  await assert.rejects(applyCanvas.execute({ path: 'canvas.drawai', ops: [{ op: 'addNode', shape: 'shotcard', cardId: 'shot-transitions', styleKey: 'missing' }] }, { agent: { id: 's' } }), /不匹配/)
  assert.equal(readFileSync(path, 'utf8'), beforeBad, 'invalid styles are rejected without a partial write')
  save()
  const arranged = await tools.find((tool) => tool.name === 'diagram_apply').execute({ path: 'canvas.drawai', layout: 'none', ops: [
    { op: 'addNode', shape: 'text', label: '火箭升空', as: 'copy', x: 20, y: 30 },
    { op: 'addNode', shape: 'video', as: 'target', x: 400, y: 30 },
    { op: 'addEdge', from: 'copy', to: 'target' },
  ] }, { agent: { id: 's' } })
  const arrangedDoc = parseCanvas(readFileSync(path, 'utf8')).doc
  const targetNode = arrangedDoc.nodes.find((node) => node.id !== 'movie' && node.data?.drawaiMotion === '1')
  assert.ok(arranged.created.some((item) => item.id === targetNode?.id))
  assert.equal(targetNode.data.drawaiMotion, '1', 'dialogue creates the same empty video node as the canvas')
  assert.equal(targetNode.data.mediaClip, undefined, 'an empty video has no fabricated media clip')
  assert.ok(arrangedDoc.edges.some((edge) => edge.to === targetNode.id), 'dialogue can connect the workflow on the shared canvas')
  save()
  assert.equal((await request('motion-task-list')).ok, true)
  assert.equal((await request('motion-task-list', { sessionId: 'unknown' })).ok, false)
  assert.equal((await request('motion-task-list', { path: '../outside.drawai' })).ok, false)
  assert.equal((await request('motion-task-list', { path: 'legacy.drawio' })).ok, false)
  assert.equal((await request('motion-task-start', { nodeId: 'movie', revision: 'stale' })).ok, false)
  const args = () => ({ requestId:randomUUID(),nodeId: 'movie', page: 0, revision: contentHash(readFileSync(path, 'utf8')) })
  readonly = true
  assert.equal((await request('motion-task-start', args())).ok, false)
  readonly = false
  const locked = structuredClone(initial)
  locked.nodes.push({ id: 'parent', label: '', x: 0, y: 0, w: 400, h: 400, style: 'locked=1;' })
  locked.nodes[0].parent = 'parent'; save(locked)
  assert.match((await request('motion-task-start', args())).error, /锁定/)
  save()
  assert.match((await request('motion-task-start', { ...args(), composition: { shots: [] } })).error, /分镜/)
  assert.equal(calls, 0, 'invalid requests never call a model')
  truncateScene = true
  const failedStart = await request('motion-task-start', args())
  assert.equal(failedStart.ok, true, failedStart.error)
  let failed
  for (let i = 0; i < 200; i++) {
    failed = await request('motion-task-result', { taskId: failedStart.job.id })
    if (failed.job.status === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(failed.job.status, 'error')
  assert.match(failed.job.error, /max-tokens/)
  const statusArgs = { action: 'status', path: 'canvas.drawai', taskId: failedStart.job.id }
  const statusTool = tools.find((tool) => tool.name === 'motion_task')
  const failedStatus = await statusTool.execute(statusArgs, { agent: { id: 's' } })
  const renderedStatus = statusTool.output.render(statusArgs, failedStatus)
  assert.match(renderedStatus[0].text, /max-tokens/)
  assert.match(renderedStatus[0].text, /视频任务：error/)
  assert.equal(calls, 1, 'incomplete tool turns stop without executing partial calls')
  assert.equal(messages.length, 0, 'failed tasks also stay out of the main conversation')
  readonly = true
  assert.match((await request('motion-task-resume', { taskId: failedStart.job.id })).error, /只读/)
  readonly = false
  const originalTaskDocument = readFileSync(path, 'utf8')
  writeFileSync(path, originalTaskDocument.replace('制作一个标题渐显视频', 'changed input'))
  assert.match((await request('motion-task-resume', { taskId: failedStart.job.id })).error, /已变化/)
  writeFileSync(path, originalTaskDocument)
  const continued = await request('motion-task-resume', { taskId: failedStart.job.id })
  assert.equal(continued.ok, true, continued.error)
  assert.equal(continued.job.id, failedStart.job.id)
  for (let i = 0; i < 200; i++) {
    const current = await request('motion-task-result', { taskId: failedStart.job.id })
    if (current.job.status === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(calls, 2, 'resume retries the interrupted native tool turn')
  readonly = true
  assert.match((await request('motion-task-remove', { taskId: failedStart.job.id })).error, /只读/)
  readonly = false
  assert.equal((await request('motion-task-remove', { taskId: failedStart.job.id, sessionId: 'other' })).ok, false)
  assert.equal((await request('motion-task-remove', { taskId: failedStart.job.id })).ok, true)
  assert.ok(!(await request('motion-task-list')).jobs.some((item) => item.id === failedStart.job.id))
  const taskTool = tools.find((tool) => tool.name === 'motion_task')
  const exec = { agent: { id: 's' } }
  const configured = JSON.parse((await taskTool.execute({action:'configure',path:'canvas.drawai',nodeId:'movie',settings:{fps:30,duration:9.3,width:1280,height:720}},exec)).details)
  assert.equal(configured.settings.totalFrames,279)
  assert.equal(parseCanvas(readFileSync(path,'utf8')).doc.nodes[0].data.motion.duration,9.3)
  const unchanged = readFileSync(path,'utf8')
  await assert.rejects(taskTool.execute({action:'configure',path:'canvas.drawai',nodeId:'movie',settings:{duration:9.3,totalFrames:360}},exec),/冲突/)
  assert.equal(readFileSync(path,'utf8'),unchanged)
  await assert.rejects(taskTool.execute({action:'resume',path:'canvas.drawai',nodeId:'movie',settings:{duration:9.7}},exec),/原任务快照/)
  readonly = true
  await assert.rejects(taskTool.execute({action:'configure',path:'canvas.drawai',nodeId:'movie',settings:{duration:9.7}},exec),/只读/)
  readonly = false
  save()
  readonly = true
  await assert.rejects(taskTool.execute({ action: 'start', path: 'canvas.drawai', nodeId: 'movie', prompt: '新视频' }, exec), /只读/)
  readonly = false
  const dialogue = JSON.parse((await taskTool.execute({ action: 'start', path: 'canvas.drawai', nodeId: 'movie', prompt: '从对话启动绘制', settings:{fps:12,totalFrames:24,width:640,height:360} }, exec)).details)
  assert.equal(dialogue.settings.totalFrames,24)
  assert.equal(dialogue.session.silent, true)
  assert.equal(parseCanvas(readFileSync(path, 'utf8')).doc.nodes[0].data.motion.prompt, '从对话启动绘制')
  await assert.rejects(taskTool.execute({ action: 'start', path: 'canvas.drawai', nodeId: 'movie' }, exec), /正在绘制/)
  await taskTool.execute({ action: 'cancel', path: 'canvas.drawai', taskId: dialogue.id }, exec)
  for (let i = 0; i < 200 && (await request('motion-task-result', { taskId: dialogue.id })).job.status !== 'cancelled'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  const newSettings = JSON.parse((await taskTool.execute({action:'revise',path:'canvas.drawai',taskId:dialogue.id,settings:{fps:30,duration:9.7}},exec)).details)
  assert.equal(newSettings.settings.totalFrames,291)
  assert.equal(newSettings.settings.duration,9.7)
  assert.equal(parseCanvas(readFileSync(path,'utf8')).doc.nodes[0].data.motion.duration,9.7)
  await taskTool.execute({action:'cancel',path:'canvas.drawai',taskId:newSettings.id},exec)
  for (let i=0;i<200&&(await request('motion-task-result',{taskId:newSettings.id})).job.status!=='cancelled';i++) await new Promise(resolve=>setTimeout(resolve,10))
  const visualDoc=structuredClone(initial)
  visualDoc.nodes.push({id:'picture',label:'参考图',style:'shape=image;',x:0,y:200,w:320,h:180})
  visualDoc.edges.push({id:'picture-ref',from:'picture',to:'movie'})
  save(visualDoc)
  const image=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>').render().asPng()
  visionMode=true;truncateScene=true
  const visionStart=await request('motion-task-start',{...args(),previews:{picture:'data:image/png;base64,'+image.toString('base64')}})
  assert.equal(visionStart.ok,true,visionStart.error)
  let visionResult
  for(let i=0;i<200;i++){
    visionResult=await request('motion-task-result',{taskId:visionStart.job.id})
    if(visionResult.job.status==='error')break
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  assert.equal(visionResult.job.status,'error')
  assert.equal(visionRequests.length,2,'Agent requests the frozen image before the interrupted production turn')
  assert.ok(visionRequests[1].messages.some(message=>message.content.some(block=>block.type==='image')))
  assert.ok(visionAttachments.at(-1).data.equals(image),'host submits the frozen image bytes to its attachment service')
  assert.equal(JSON.parse(visionRequests[0].messages[0].content[0].text).assets.picture[0].kind,'image')
  visionMode=false
  truncateScene = false; calls = 0; messages.length = 0; save()
  if (process.argv.includes('--render')) {
    const startArgs=args()
    const started = await request('motion-task-start', startArgs)
    assert.equal(started.ok, true, started.error)
    assert.equal(messages.length, 0, 'canvas generation never posts to the main conversation')
    assert.equal((await request('motion-task-start',startArgs)).job.id,started.job.id,'retry with the same request id survives the changed document revision')
    assert.ok(parseCanvas(readFileSync(path, 'utf8')).doc.nodes[0].data.motion.requestId)
    let last
    for (let i = 0; i < 1800; i++) {
      last = await request('motion-task-result', { taskId: started.job.id })
      if (['done', 'retained', 'error'].includes(last.job.status)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(last.job.status, 'done', last.job.error)
    assert.ok(calls>=8,'production uses native file/render/view/review tools')
    const firstCalls=calls
    const saved = parseCanvas(readFileSync(path, 'utf8')).doc.nodes[0]
    assert.equal(saved.data.mediaKind, 'raster')
    assert.equal(saved.data.motion.lastJobId, started.job.id)
    assert.equal(saved.data.motion.composition.shots[0].title, '一句话成片')
    assert.match(saved.data.motion.composition.shots[0].sceneSource,/useCurrentFrame/)
    const foreign = await request('motion-task-result', { taskId: started.job.id, sessionId: 'other' })
    assert.equal(foreign.ok, false)
    const read = await request('read', { revision: initial.revision || 'old' })
    assert.equal(read.ok, true)
    const taskTool=tools.find(tool=>tool.name==='motion_task'),exec={agent:{id:'s'}}
    const status=await taskTool.execute({action:'status',path:'canvas.drawai',taskId:started.job.id},exec)
    assert.doesNotMatch(status.details,/sceneSource/)
    assert.match(JSON.parse(status.details).outputPath,/source.mp4$/)
    await assert.rejects(taskTool.execute({action:'status',path:'canvas.drawai',taskId:started.job.id},{agent:{id:'other'}}),/不属于/)
    readonly=true
    await assert.rejects(taskTool.execute({action:'revise',path:'canvas.drawai',taskId:started.job.id,prompt:'更慢'},exec),/只读/)
    readonly=false
    await taskTool.execute({action:'focus',path:'canvas.drawai',taskId:started.job.id},exec)
    assert.equal((await request('motion-task-list')).focus.nodeId,'movie')
    const revised=JSON.parse((await taskTool.execute({action:'revise',path:'canvas.drawai',taskId:started.job.id,prompt:'运动放慢一些，保留图像主体'},exec)).details)
    assert.notEqual(revised.id,started.job.id)
    for(let i=0;i<1800;i++){
      last=await request('motion-task-result',{taskId:revised.id})
      if(['done','retained','error'].includes(last.job.status))break
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.equal(last.job.status,'done',last.job.error)
    assert.match(parseCanvas(readFileSync(path,'utf8')).doc.nodes[0].data.motion.prompt,/运动放慢/)
    assert.ok(calls>firstCalls,'revision operates the copied engineering project')
    assert.equal(messages.length, 0, 'storyboard, completion and revisions remain in the canvas task UI')
    console.log('Host: session model → planner → real renderer → native document delivery passed.')
  }
  console.log('Motion host: workspace/session guards, stale revision, read-only, locked parent and invalid plan checks passed.')
} finally {
  await Promise.allSettled(disposers.map((dispose) => Promise.resolve().then(dispose)))
  const rel = relative(resolve('artifacts'), root)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true })
}
