import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createMotionTaskManager } from '../src/motion-tasks.js'
import { submitMotionSession, motionSessionNotice } from '../src/motion-session.js'
import { validateMotionPlan } from '../src/motion-core.js'

mkdirSync('artifacts', { recursive: true })
const root = mkdtempSync(resolve('artifacts/motion-session-'))
const scope = {sessionId:'owner',path:'canvas.drawai',drawioAbs:join(root,'canvas.drawai'),page:0}
const input = {settings:{mode:'scene',prompt:'火箭升空，丰富插画和粒子',width:640,height:360,fps:12,duration:2},refs:[]}
const source = "import React from 'react';export default function Scene(){return <div>火箭</div>}"
const composition=validateMotionPlan({production:{brief:'测试火箭'},shots:[{recipeId:'scene',sceneSource:source,startFrame:0,durationFrames:24,description:'火箭起飞',referenceIds:[]}]},input)
const notices=[],submitted=[];let planning=0
const manager=createMotionTaskManager({plan:async(_input,_scope,_signal,_previous,onStage)=>{
  planning++;await onStage('storyboard',{production:composition.production,shots:composition.shots});return composition
},render:async(_job,request)=>{writeFileSync(request.output,'mp4');writeFileSync(request.poster,'png')},commit:async()=>{},notify:async(job,event)=>notices.push(motionSessionNotice(job,event))})
const wait=async(id)=>{for(let n=0;n<200;n++){const result=manager.result(scope,id);if(['done','cancelled','error'].includes(result.job.status))return result;await new Promise(r=>setTimeout(r,10))}throw Error('timeout')}
try {
  const requestId=randomUUID()
  const draft=await manager.start(scope,'movie',input,{},undefined,undefined,undefined,{defer:true,requestId})
  assert.equal(draft.status,'awaiting-session');assert.equal(planning,0,'no model calls before the main session accepts')
  const controller={prompt:async(request)=>{submitted.push(request);return {accepted:true}}}
  await submitMotionSession({controller,manager,scope,job:draft,input})
  const result=await wait(draft.id)
  assert.equal(result.job.status,'done',result.job.error)
  assert.equal(submitted[0].mode,'queue');assert.equal(submitted[0].sessionId,'owner')
  assert.match(submitted[0].content[0].text,/火箭升空/);assert.match(submitted[0].content[0].text,/motion_task/)
  assert.equal(notices.length,2);assert.match(notices[0],/后台分镜/);assert.match(notices[1],/后台结果/)
  assert.doesNotMatch(notices.join('\n'),/sceneSource/,'source code is not dumped into every main-session message')
  const duplicate=await manager.start(scope,'movie',input,{},undefined,undefined,undefined,{defer:true,requestId})
  await submitMotionSession({controller,manager,scope,job:duplicate,input})
  assert.equal(duplicate.id,draft.id);assert.equal(planning,1);assert.equal(submitted.length,1,'a repeated accepted request is not sent twice')
  assert.throws(()=>manager.result({...scope,sessionId:'outsider'},draft.id),/不属于/)
  const rejected=await manager.start(scope,'other',input,{},undefined,undefined,undefined,{defer:true,requestId:randomUUID()})
  await assert.rejects(submitMotionSession({controller:{prompt:async()=>{throw Error('主会话离线')}},manager,scope,job:rejected,input}),/离线/)
  assert.equal(manager.result(scope,rejected.id).job.status,'cancelled');assert.equal(planning,1)
  const before=await manager.start(scope,'cancelled',input,{},undefined,undefined,undefined,{defer:true,requestId:randomUUID()})
  await manager.cancel(scope,before.id);assert.equal(manager.result(scope,before.id).job.status,'cancelled')
  const nextInput={...input,settings:{...input.settings,prompt:'第二镜更慢'}}
  const revised=await manager.start(scope,'movie',nextInput,{},composition,undefined,composition,{reuseJobId:draft.id,requestId:randomUUID(),defer:true})
  manager.accepted(scope,revised.id);assert.equal((await wait(revised.id)).job.status,'done')
  assert.equal(manager.details(scope,revised.id).input.settings.prompt,'第二镜更慢')
  assert.equal(manager.findRequest(scope,requestId).id,draft.id)
  const noticeCount = notices.length
  const silent = await manager.start(scope, 'quiet-video', input, {}, undefined, undefined, undefined, { defer: true, silent: true, requestId: randomUUID() })
  await manager.accepted(scope, silent.id)
  assert.equal((await wait(silent.id)).job.status, 'done')
  assert.equal(notices.length, noticeCount, 'silent canvas tasks never emit storyboard or completion messages')
  assert.equal(manager.result(scope, silent.id).job.session.silent, true, 'silence survives task persistence and status queries')
  await assert.rejects(manager.start(scope,'movie',{...input,refs:[{id:'new',role:'copy',nodes:[]}]},{},undefined,undefined,composition,{reuseJobId:draft.id}),/参考素材已变化/)
  console.log('Motion session: deferred start, official queued prompt, deduplication, storyboard/result notices, submission failure, cancellation, ownership and revision passed.')
} finally {
  await manager.close()
  const rel=relative(resolve('artifacts'),root)
  if(rel&&!rel.startsWith('..')&&!isAbsolute(rel))rmSync(root,{recursive:true,force:true})
}
