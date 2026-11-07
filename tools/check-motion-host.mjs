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
  // 旧后台制作 Agent 已移除；无 composition 的旧入口应在创建任务前明确拒绝。
  const unsupported = await request('motion-task-start', args())
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.error, /旧视频任务不再支持自动规划/)
  assert.equal(calls, 0, 'unsupported requests must not start a model')
  assert.equal((await request('motion-task-list')).jobs.length, 0, 'unsupported requests must not create a partial job')
  const taskTool = tools.find(tool => tool.name === 'motion_task')
  await assert.rejects(taskTool.execute({action:'status',path:'canvas.drawai',taskId:'missing'},{agent:{id:'s'}}), /不属于|找不到/)
  console.log('Retired automatic planning: clear failure before job creation passed.')
  console.log('Motion host: workspace/session guards, stale revision, read-only, locked parent and invalid plan checks passed.')
} finally {
  await Promise.allSettled(disposers.map((dispose) => Promise.resolve().then(dispose)))
  const rel = relative(resolve('artifacts'), root)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true })
}
