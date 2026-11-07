import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { apply } from '../lib/index.js'
import { buildCanvas, parseCanvas } from '../src/canvas-format.js'
import { motionNodeData } from '../src/motion-core.js'
import {spawnSync} from 'node:child_process'
import {ffmpegBinary} from '../src/video-export.js'

mkdirSync('artifacts', { recursive: true })
const root = mkdtempSync(resolve('artifacts/motion-host-')), path = join(root, 'canvas.drawai')
let route, readonly = false
const disposers = [], tools = []
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
    if (name === 'llm' || name === 'sessionController') throw new Error('Audio tools must not require a background agent')
    return undefined
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
  const call = (name, args) => tools.find(t => t.name === name).execute({path:'canvas.drawai', nodeId:'movie', ...args}, exec)
  const project = JSON.parse((await call('motion_project', {action:'create', segments:1,
    spec:{width:640, height:360, fps:12, duration:2}})).details)
  const timeline = () => JSON.parse(readFileSync(join(project.dir, 'timeline.json'), 'utf8'))
  const addAudio = gainDb => call('motion_audio', {action:'add', audioNodeId:node.id, role:'bgm',
    at:0, duration:2, gainDb, fadeIn:.2, fadeOut:.2, loop:true})
  await addAudio(-20)
  let cue = timeline().audio[0]
  assert.equal(cue.gainDb, -20)
  assert.equal(cue.role, 'bgm')
  assert.equal(cue.durationInFrames, 24)
  assert.equal(cue.loop, true)
  assert.ok(existsSync(join(project.dir, 'assets', cue.file)), 'audio is copied into the project')
  assert.match((await call('motion_audio', {action:'list'})).details, /bgm/)
  readonly = true
  await assert.rejects(addAudio(-25), /只读/)
  await assert.rejects(call('motion_audio', {action:'remove', cueId:cue.id}), /只读/)
  readonly = false
  assert.equal(timeline().audio.length, 1, 'read-only operations leave the track unchanged')
  if(process.argv.includes('--render')){
    writeFileSync(join(project.dir, 'scene-0.tsx'), "import React from 'react';import {AbsoluteFill,useCurrentFrame} from 'remotion';export default function Scene(){const f=useCurrentFrame();return <AbsoluteFill style={{background:'#162340'}}><div style={{margin:40,width:80+f,height:80,background:'#80e9ce'}}/></AbsoluteFill>}")
    const renderAndApply = async () => {
      const started = JSON.parse((await call('motion_render', {action:'start'})).details)
      const deadline = Date.now() + 180000
      try {
        while (Date.now() < deadline) {
          const job = JSON.parse((await call('motion_render', {action:'status', jobId:started.jobId})).details)
          if (job.status === 'done') {
            const applied = JSON.parse((await call('motion_render', {action:'apply', jobId:job.id})).details)
            const film = isAbsolute(applied.source) ? applied.source : join(applied.dir, applied.source)
            assert.ok(existsSync(film), 'applied film exists')
            const audio = spawnSync(ffmpegBinary(), ['-hide_banner', '-i', film,
              '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], {windowsHide:true, encoding:'utf8'})
            assert.equal(audio.status, 0, audio.stderr)
            const mean = /mean_volume:\s*([\d.-]+) dB/.exec(audio.stderr)
            assert.ok(mean && Number.isFinite(Number(mean[1])), 'rendered film contains non-silent audio')
            assert.equal(parseCanvas(readFileSync(path,'utf8')).doc.nodes.find(n=>n.id==='movie').data.mediaClip, applied.clip)
            return applied
          }
          assert.ok(!['failed','cancelled'].includes(job.status), job.error || job.status)
          await new Promise(resolve=>setTimeout(resolve,100))
        }
        throw new Error('render timeout')
      } catch (error) {
        await call('motion_render', {action:'cancel', jobId:started.jobId})
        throw error
      }
    }
    await renderAndApply()
    await call('motion_audio', {action:'remove', cueId:cue.id})
    await addAudio(-25)
    assert.equal(timeline().audio[0].gainDb, -25)
    await renderAndApply()
    console.log('Audio host live render: project audio → render/status/apply, gain update and re-render passed.')
  }
  cue = timeline().audio[0]
  await call('motion_audio', {action:'remove', cueId:cue.id})
  assert.equal(timeline().audio.length, 0, 'audio removal is persisted')
  console.log('Audio host: actual tools import/connect/configure/read, upload routes, workspace/session ownership and read-only checks passed (SDK loader shim).')
}finally {
  await Promise.allSettled(disposers.map(dispose=>Promise.resolve().then(dispose)))
  const rel=relative(resolve('artifacts'),root);if(rel&&!rel.startsWith('..')&&!isAbsolute(rel))rmSync(root,{recursive:true,force:true})
}
