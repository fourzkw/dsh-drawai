import assert from 'node:assert/strict'
import {motionAgentFixture} from './motion-agent-test-fixture.mjs'
import {randomUUID} from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { apply } from '../lib/index.js'
import { buildCanvas, parseCanvas } from '../src/canvas-format.js'
import { contentHash } from '../src/mxfile.js'
import { motionNodeData } from '../src/motion-core.js'
import {spawnSync} from 'node:child_process'
import {ffmpegBinary} from '../src/video-export.js'
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
      if(request.system.startsWith('你是声音设计师')){
        const source=JSON.parse(request.messages[0].content[0].text).sources[0]
        yield {type:'text-delta',text:JSON.stringify({cues:[{referenceId:source.referenceId,shotId:'shot-1',offsetFrames:0,durationFrames:24,gainDb:-18,fadeIn:.2,fadeOut:.2,loop:true}]})};return
      }
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
  const source=join(root,'sound.wav'),ff=spawnSync(ffmpegBinary(),['-y','-f','lavfi','-i','sine=frequency=600:duration=1',source],{windowsHide:true})
  assert.equal(ff.status,0,ff.stderr?.toString())
  const tool=tools.find(t=>t.name==='audio_asset'),exec={agent:{id:'s'}}
  assert.ok(tool)
  const imported=JSON.parse((await tool.execute({action:'import',path:'canvas.drawai',file:'sound.wav',targetId:'movie',role:'bgm'},exec)).details)
  let doc=parseCanvas(readFileSync(path,'utf8')).doc
  const node=doc.nodes.find(n=>n.data?.drawaiAudio==='1');assert.ok(node);assert.equal(node.data.audioRole,'bgm')
  assert.ok(doc.edges.some(e=>e.from===node.id&&e.to==='movie'))
  const configured=JSON.parse((await tool.execute({action:'configure',path:'canvas.drawai',nodeId:node.id,settings:{audioGainDb:-20,audioLoop:'1'}},exec)).details)
  assert.equal(configured.settings.gainDb,-20)
  await assert.rejects(tool.execute({action:'configure',path:'canvas.drawai',nodeId:node.id,settings:{audioTrimStart:3,audioTrimEnd:2}},exec),/结束/)
  const read=await tools.find(t=>t.name==='diagram_read').execute({path:'canvas.drawai'},exec)
  assert.match(JSON.stringify(read),/audioGainDb/)
  await assert.rejects(tool.execute({action:'import',path:'canvas.drawai',file:'../outside.wav'},exec),/超出/)
  readonly=true
  await assert.rejects(tool.execute({action:'configure',path:'canvas.drawai',nodeId:node.id,settings:{audioGainDb:0}},exec),/只读/)
  assert.equal((await request('audio-upload-start',{name:'x.wav',extension:'wav',size:3})).ok,false)
  readonly=false
  assert.equal((await request('audio-read',{clip:imported.clip})).mime,'audio/mp4')
  const bytes=readFileSync(source),start=await request('audio-upload-start',{name:'x.wav',extension:'wav',size:bytes.length})
  assert.equal(start.ok,true,start.error)
  assert.equal((await request('audio-upload-chunk',{token:start.token,offset:0,base64:bytes.toString('base64'),sessionId:'other'})).ok,false)
  assert.equal((await request('audio-upload-chunk',{token:start.token,offset:0,base64:bytes.toString('base64')})).ok,true)
  const finish=await request('audio-upload-finish',{token:start.token});assert.equal(finish.ok,true,finish.error)
  await request('audio-upload-release',{token:start.token})
  const settings=JSON.parse((await tools.find(t=>t.name==='motion_task').execute({action:'configure',path:'canvas.drawai',nodeId:'movie',settings:{audioMode:'manual',audioPrompt:'轻音乐'}},exec)).details)
  assert.equal(settings.settings.audioMode,'manual')
  if(process.argv.includes('--render')){
    const task=tools.find(t=>t.name==='motion_task')
    const started=JSON.parse((await task.execute({action:'start',path:'canvas.drawai',nodeId:'movie',settings:{audioMode:'auto'}},exec)).details)
    const done=async id=>{for(let i=0;i<1200;i++){const r=await request('motion-task-result',{taskId:id});if(['done','error','retained'].includes(r.job.status))return r;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('render timeout')}
    const generated=await done(started.id);assert.equal(generated.job.status,'done',generated.job.error);assert.equal(generated.job.qa.audio.status,'mixed')
    assert.equal(generated.job.composition.audio.cues[0].referenceId,node.id)
    await tool.execute({action:'configure',path:'canvas.drawai',nodeId:node.id,settings:{audioGainDb:-25}},exec)
    await task.execute({action:'configure',path:'canvas.drawai',nodeId:'movie',settings:{audioMode:'manual'}},exec)
    const remixed=await request('motion-task-remix',{taskId:started.id});assert.equal(remixed.ok,true,remixed.error)
    const finished=await done(remixed.job.id);assert.equal(finished.job.status,'done',finished.job.error);assert.equal(finished.job.qa.audio.status,'mixed')
    assert.notEqual(finished.output.data.mediaClip,generated.output.data.mediaClip)
    const exported=await request('media-export-source',{clip:finished.output.data.mediaClip,variant:'noBgm'})
    assert.equal(exported.ok,true,exported.error);assert.match(exported.path,/no-bgm.mp4$/)
    console.log('Audio host live render: model → Remotion → AI sound plan → FFmpeg → canvas, remix → new version and no-BGM export passed.')
  }
  console.log('Audio host: actual tools import/connect/configure/read, upload routes, workspace/session ownership and read-only checks passed (SDK loader shim).')
}finally {
  await Promise.allSettled(disposers.map(dispose=>Promise.resolve().then(dispose)))
  const rel=relative(resolve('artifacts'),root);if(rel&&!rel.startsWith('..')&&!isAbsolute(rel))rmSync(root,{recursive:true,force:true})
}
