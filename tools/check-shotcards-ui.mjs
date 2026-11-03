import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { openBrowser } from '@remotion/renderer'
import { composeClientBody } from './build.mjs'
const entry = `import ReactRuntime from 'react';import {createRoot} from 'react-dom/client';
const module={exports:{}};const require=()=>ReactRuntime;
${composeClientBody()}
client={get:()=>undefined,interval:()=>()=>{},timeout:(fn,ms)=>{const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
window.saved={version:2,revision:'initial',meta:{},layers:[{id:'1',name:'图层',visible:true,locked:false}],nodes:[{id:'movie',x:450,y:150,w:400,h:225,label:'产品演示',style:'',data:motionCore.motionNodeData()}],edges:[]};
window.saved.nodes[0].data.motion.prompt='用镜头参考展示产品的生成过程';
let first=true;window.fetch=async(_url,options)=>{const req=JSON.parse(options.body);if(req.doc)window.saved=JSON.parse(JSON.stringify(req.doc));return {ok:true,json:async()=>({ok:true,exists:true,doc:window.saved,revision:'test',pageIndex:0,pageCount:1,pageNames:['画布'],jobs:[],focus:null,...(req.action==='read'&&first?(first=false,{highlight:['movie']}):{})})}};
document.head.appendChild(Object.assign(document.createElement('style'),{textContent:CSS+'body{margin:0;background:#f6f5f9;font:14px system-ui}'}));
createRoot(document.getElementById('app')).render(React.createElement(CanvasView,{sessionId:'test',path:'demo.drawai',active:true}));`
const result=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'js'},bundle:true,write:false,platform:'browser',format:'iife',logOverride:{'duplicate-object-key':'silent'}})
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<div id="app" style="position:absolute;inset:0"></div><script>'+result.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
  browser=await openBrowser('chrome',{browserExecutable:process.env.DRAWAI_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',logLevel:'error'})
  const page=await browser.newPage({context:()=>null,logLevel:'error',indent:false,pageIndex:0,onBrowserLog:null,onLog:()=>{}})
  await page.setViewport({width:1440,height:1000,deviceScaleFactor:1})
  await page.goto({url:'http://127.0.0.1:'+server.address().port,timeout:30000})
  async function until(check){for(let i=0;i<120;i++){if(await page.evaluate(check))return;await new Promise(r=>setTimeout(r,50))}throw Error('Browser condition timed out: '+check+'; '+await page.evaluate(()=>document.querySelector('dialog')?.textContent.slice(-600)))}
  await until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='添加镜头卡'))
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='添加镜头卡').click())
  await until(()=>!!document.querySelector('dialog[open]'))
  assert.equal(await page.evaluate(()=>document.querySelectorAll('dialog article').length),150)
  await page.evaluate(()=>document.querySelector('[aria-label="搜索镜头卡"]').focus())
  await page._client().send('Input.insertText', {text:'wall-reveal-moves'})
  await until(()=>document.querySelectorAll('dialog article').length===3)
  await page.evaluate(()=>[...document.querySelectorAll('dialog input[type="checkbox"]')].filter(b=>b.getAttribute('aria-label').includes('wall-reveal-moves')).forEach(b=>b.click()))
  await until(()=>[...document.querySelectorAll('dialog button')].some(b=>b.textContent==='添加到画布并连接'&&!b.disabled))
  mkdirSync('artifacts',{recursive:true})
  const shot=await page._client().send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('artifacts/shotcard-library.png',Buffer.from(shot.value.data,'base64'))
  await page.evaluate(()=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='添加到画布并连接').click())
  await until(()=>window.saved.nodes.filter(n=>n.data?.drawaiShotCard==='1').length===2)
  const saved=await page.evaluate(()=>window.saved)
  assert.equal(saved.edges.length,2)
  assert.ok(saved.edges.every(e=>e.to==='movie'&&e.data.motionReference.role==='shotcard'))
  assert.deepEqual(saved.nodes.filter(n=>n.data?.drawaiShotCard).map(n=>n.data.shotStyleKey).sort(),['bento-light-up','wireframe-draw-on'])
  await until(()=>[...document.querySelectorAll('.drawai-video-reference')].length===2)
  const canvasShot=await page._client().send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('artifacts/shotcard-canvas.png',Buffer.from(canvasShot.value.data,'base64'))
  await page.evaluate(()=>document.querySelector('[data-node-id="'+window.saved.nodes.find(n=>n.data?.drawaiShotCard).id+'"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})))
  await until(()=>!!document.querySelector('dialog[open]'))
  assert.equal(await page.evaluate(()=>document.querySelector('dialog h3').textContent.includes('bento-light-up')),true)
  await page.evaluate(()=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='关闭').click())
  assert.equal(await page.evaluate(()=>!!document.querySelector('dialog[open]')),false)
  console.log('Shot-card browser: production CanvasView, 150 searchable styles, multi-select insertion, automatic video reference edges, persisted identity and double-click preview passed.')
} finally {await browser?.close({silent:true});await new Promise(resolve=>server.close(resolve))}
