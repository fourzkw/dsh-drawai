import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {ffmpegBinary} from '../src/video-export.js'
import {openBrowser} from '@remotion/renderer'
import {composeClientBody} from './build.mjs'
mkdirSync('artifacts',{recursive:true})
const fixture='artifacts/audio-ui-preview.m4a'
const encoded=spawnSync(ffmpegBinary(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','aac',fixture],{windowsHide:true})
assert.equal(encoded.status,0,encoded.stderr?.toString())
const previewBase64=readFileSync(fixture).toString('base64')
const entry=`import ReactRuntime from 'react';import {createRoot} from 'react-dom/client';
const module={exports:{}};const require=()=>ReactRuntime;
${composeClientBody()}
client={get:()=>undefined,interval:()=>()=>{},timeout:(fn,ms)=>{const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
window.saved={version:2,revision:'initial',meta:{},layers:[{id:'1',name:'图层',visible:true,locked:false}],nodes:[{id:'movie',x:450,y:150,w:400,h:225,label:'声音测试',style:'',data:motionCore.motionNodeData()}],edges:[]};
window.saved.nodes[0].data.motion.prompt='制作一个带声音的产品演示';
window.actions=[];let first=true;
window.fetch=async(_url,options)=>{
 const req=JSON.parse(options.body);window.actions.push(req);
 if(req.doc)window.saved=JSON.parse(JSON.stringify(req.doc));
 const asset={clip:'audio-test',manifest:{name:'提示音.wav',duration:1},data:{...motionCore.audioNodeData(),audioClip:'audio-test',audioName:'提示音.wav',audioDuration:'1',audioSha256:'hash'}};
 let result={};
 if(req.action==='audio-upload-start')result={token:'test-token'};
 if(req.action==='audio-upload-finish'||req.action==='audio-get')result=asset;
 if(req.action==='audio-read')result={base64:${JSON.stringify(previewBase64)},mime:'audio/mp4',manifest:asset.manifest};
 if(req.action==='audio-search')result={results:[{id:'fs:123',title:'Soft Whoosh',license_label:'Creative Commons 0'}]};
 return {ok:true,json:async()=>({ok:true,exists:true,doc:window.saved,revision:'test',pageIndex:0,pageCount:1,pageNames:['画布'],jobs:[],focus:null,...(req.action==='read'&&first?(first=false,{highlight:['movie']}):{}),...result})}
};
document.head.appendChild(Object.assign(document.createElement('style'),{textContent:CSS+'body{margin:0;background:#f6f5f9;font:14px system-ui}'}));
createRoot(document.getElementById('app')).render(React.createElement(CanvasView,{sessionId:'test',path:'demo.drawai',active:true}));`
const result=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'js'},bundle:true,write:false,platform:'browser',format:'iife',logOverride:{'duplicate-object-key':'silent'}})
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<div id="app" style="position:absolute;inset:0"></div><script>'+result.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try{
 browser=await openBrowser('chrome',{browserExecutable:process.env.DRAWAI_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',logLevel:'error'})
 const page=await browser.newPage({context:()=>null,logLevel:'error',indent:false,pageIndex:0,onBrowserLog:null,onLog:()=>{}})
 await page.setViewport({width:1440,height:1100,deviceScaleFactor:1})
 const errors=[];page.on('pageerror',error=>errors.push(String(error)))
 await page.goto({url:'http://127.0.0.1:'+server.address().port,timeout:30000})
 async function until(check){for(let i=0;i<100;i++){if(await page.evaluate(check))return;await new Promise(r=>setTimeout(r,60))}throw Error('Browser condition timed out: '+check+' errors '+errors.join('\n'))}
 await until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='添加音频'))
 await page.evaluate(()=>{const click=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type!=='file')return click.call(this)}})
 await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='添加音频').click())
 await until(()=>!!document.querySelector('[aria-label="音频节点设置"]'))
 await until(()=>!!document.querySelector('input[type="file"]'))
 await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(1024)],'提示音.wav',{type:'audio/wav'}));const input=document.querySelector('input[type="file"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})
 await until(()=>!!document.querySelector('audio[aria-label="音频试听"]'))
 await until(()=>document.querySelector('audio[aria-label="音频试听"]').duration>0)
 await page.evaluate(async()=>{const audio=document.querySelector('audio[aria-label="音频试听"]');audio.muted=true;await audio.play()})
 await until(()=>document.querySelector('audio[aria-label="音频试听"]').currentTime>0)
 await page.evaluate(()=>document.querySelector('audio[aria-label="音频试听"]').pause())
 await until(()=>window.saved.nodes.some(n=>n.data?.audioClip==='audio-test'))
 const saved=await page.evaluate(()=>window.saved)
 const audio=saved.nodes.find(n=>n.data?.drawaiAudio==='1');assert.ok(audio)
 assert.ok(saved.edges.some(e=>e.from===audio.id&&e.to==='movie'&&e.data.motionReference.role==='audio'))
 const upload=await page.evaluate(()=>window.actions.filter(a=>a.action?.startsWith('audio-upload-')).map(a=>a.action))
 assert.ok(upload.includes('audio-upload-chunk'));assert.ok(upload.includes('audio-upload-finish'))
 await page.evaluate(()=>{const input=document.querySelector('[aria-label="音效搜索词"]');input.closest('details').open=true;input.focus()})
 await page._client().send('Input.insertText',{text:'soft whoosh'})
 await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='搜索').click())
 await until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='下载到此节点'))
 await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='下载到此节点').click())
 await until(()=>window.actions.some(a=>a.action==='audio-get'&&a.id==='fs:123'))
 await page.evaluate(()=>{const input=document.querySelector('[aria-label="音频用途"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,'bgm');input.dispatchEvent(new Event('change',{bubbles:true}))})
 await until(()=>window.saved.nodes.some(n=>n.data?.audioRole==='bgm'))
 mkdirSync('artifacts',{recursive:true});const screenshot=await page._client().send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('artifacts/audio-canvas.png',Buffer.from(screenshot.value.data,'base64'))
 await page.evaluate(()=>document.querySelector('button[title="音频：添加音效、音乐或旁白节点"]').click())
 await page._client().send('Input.dispatchMouseEvent',{type:'mousePressed',x:1000,y:950,button:'left',clickCount:1})
 await page._client().send('Input.dispatchMouseEvent',{type:'mouseReleased',x:1000,y:950,button:'left',clickCount:1})
 await until(()=>window.saved.nodes.filter(n=>n.data?.drawaiAudio==='1').length===2)
 assert.deepEqual(errors,[])
 console.log('Audio browser: production CanvasView add/connect, chunk upload, preview, role settings and Freesound search/get interactions passed (mock media endpoints).')
}finally{await browser?.close({silent:true});await new Promise(resolve=>server.close(resolve))}
