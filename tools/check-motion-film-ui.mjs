import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {openBrowser} from '@remotion/renderer'
import {ffmpegBinary} from '../src/video-export.js'
mkdirSync('artifacts',{recursive:true})
const root=mkdtempSync(resolve('artifacts/film-ui-')),videoFile=join(root,'film.mp4')
execFileSync(ffmpegBinary(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x256:rate=12:duration=2','-f','lavfi','-i','sine=frequency=600:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',videoFile],{windowsHide:true})
const film=readFileSync(videoFile)
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
${readFileSync('src/motion-panel.js','utf8')}
const job={id:'test',clip:'clip',qa:{film:{sha256:'hash',duration:2,decode:'passed',motion:{status:'passed',sequences:[]},audio:{hasAudio:true,integratedLufs:-21,truePeakDb:-18},warnings:[],manual:{status:'pending'}}}};
window.records=[];createRoot(document.getElementById('app')).render(React.createElement(MotionFilmReview,{job,onLoad:async()=>({mime:'video/mp4',url:'/film.mp4'}),onSave:async(id,review)=>{window.records.push({id,review})}}));`
const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'js'},bundle:true,write:false,platform:'browser',format:'iife'})
const server=createServer((req,res)=>{if(req.url==='/film.mp4'){res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':film.length});res.end(film);return}res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<div id="app" style="width:600px"></div><button id="play" onclick="document.querySelector(\'video\').play()">播放</button><script>'+bundle.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser
try{
  browser=await openBrowser('chrome',{browserExecutable:process.env.DRAWAI_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',logLevel:'error'})
  const page=await browser.newPage({context:()=>null,logLevel:'error',indent:false,pageIndex:0,onBrowserLog:null,onLog:()=>{}})
  await page.setViewport({width:1000,height:1000,deviceScaleFactor:1});await page.goto({url:'http://127.0.0.1:'+server.address().port,timeout:30000})
  const until=async(fn)=>{for(let i=0;i<150;i++){if(await page.evaluate(fn))return;await new Promise(r=>setTimeout(r,50))}throw Error('UI condition timed out: '+fn)}
  await until(()=>!!document.querySelector('details'))
  await page.evaluate(()=>{document.querySelector('details').open=true;[...document.querySelectorAll('button')].find(b=>b.textContent==='加载完整成片回放').click()})
  await until(()=>document.querySelector('video')?.readyState>=2)
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='确认全片验收通过').disabled),true)
  await page.evaluate(async()=>{const v=document.querySelector('video');v.muted=true;await v.play()})
  await until(()=>document.querySelector('video').ended)
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='确认全片验收通过').disabled),true,'muted playback cannot certify listening')
  await page.evaluate(()=>{const v=document.querySelector('video');v.currentTime=0;v.muted=false;document.querySelector('input[type="checkbox"]').click()})
  const box=await page.evaluate(()=>{const r=document.getElementById('play').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})
  await page._client().send('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1})
  await page._client().send('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1})
  await until(()=>!document.querySelector('video').paused)
  await until(()=>document.querySelector('video').ended)
  await until(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='确认全片验收通过').disabled)
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='确认全片验收通过').click())
  await until(()=>window.records.length===1)
  const record=await page.evaluate(()=>window.records[0])
  assert.equal(record.review.sha256,'hash');assert.ok(record.review.soundSeconds>=1.96);assert.equal(record.review.status,'passed')
  console.log('Film UI: actual video/audio decode, muted-playback rejection, complete audible replay, confirmation gate and hash-bound review submission passed.')
}finally{await browser?.close({silent:true}).catch(()=>{});await new Promise(r=>server.close(r));if(root.startsWith(resolve('artifacts')+'\\')||root.startsWith(resolve('artifacts')+'/'))rmSync(root,{recursive:true,force:true})}
