import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shotCardCatalog, enforceMotionCards } from '../src/motion-library.js'
import { shotCardData } from '../src/shotcard-core.js'
import { motionNodeData, motionInput, validateMotionPlan } from '../src/motion-core.js'
const directory=resolve('artifacts/shotcard-render');mkdirSync(directory,{recursive:true})
const data=shotCardData(shotCardCatalog,'wall-reveal-moves','wireframe-draw-on')
const movie={id:'movie',data:motionNodeData()};Object.assign(movie.data.motion,{prompt:'蓝图描线',fps:30,duration:5,width:640,height:360})
const input=motionInput({nodes:[{id:'reference',data},movie],edges:[{id:'edge',from:'reference',to:'movie'}]},'movie')
const composition=enforceMotionCards(validateMotionPlan({shots:[{recipeId:'scene',startFrame:0,durationFrames:150,referenceIds:[],motionCards:[{cardId:data.shotCardId,styleKey:data.shotStyleKey}],
 fidelity:[{cardId:data.shotCardId,styleKey:data.shotStyleKey,preserve:['20–82描线、88–118扫线、118–150停留，保持原 demo'],adaptation:'保留30fps，将1920画幅等比缩至640'}],
 sceneSource:"import React from 'react';import {AbsoluteFill} from 'remotion';import {WireframeDrawOn} from '@shotcraft/demos/ui-entrance/wall-reveal-moves/WireframeDrawOn';export default function Scene(){return <AbsoluteFill><div style={{position:'absolute',width:1920,height:1080,transform:'scale(0.3333333333)',transformOrigin:'top left'}}><WireframeDrawOn/></div></AbsoluteFill>}"
}]},input),input)
const output=resolve(directory,'wireframe.mp4'),poster=resolve(directory,'poster.png')
const qa=await new Promise((resolve,reject)=>{
 const child=fork(new URL('../src/motion-render-worker.js',import.meta.url),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});let done,error=''
 const timeout=setTimeout(()=>{child.kill();reject(Error('render timeout'))},180000)
 child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000)})
 child.on('message',message=>{if(message.type==='done')done=message;if(message.type==='error')error=message.error})
 child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code||!done)reject(Error(error||'render failed'));else resolve(done.qa)})
 child.send({composition,assets:{},publicDir:null,output,poster})
})
assert.equal(qa.frames.length,5)
assert.equal(new Set(qa.frames.map(frame=>frame.sha256)).size,5)
assert.ok(readFileSync(output).length>20000)
console.log('Exact shot-card demo compiled and rendered at 30fps; five distinct QA samples:',output)
