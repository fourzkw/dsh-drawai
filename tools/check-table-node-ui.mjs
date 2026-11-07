// Browser regression for table rendering and editing through the real canvas.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { openBrowser } from '@remotion/renderer'
import { composeClientBody } from './build.mjs'
import { readCanvasSpec } from '../src/motion/canvas-spec.js'

const tableSource=readFileSync('src/table-node.js','utf8')
const parseTable=new Function(tableSource+'\nreturn parseCanvasTable')()
const oldWithoutTrailingPipes={label:'【分镜表】\n| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音\n| --- | --- | --- | --- | --- | ---\n| shot-1 | 0–89f | intro | 动作 | 画面 | 字幕'}
assert.equal(readCanvasSpec({nodes:[oldWithoutTrailingPipes]},{fps:30}).storyboard.length,1,'historical storyboard without trailing pipe is accepted by video project')
assert.ok(parseTable(oldWithoutTrailingPipes),'historical storyboard without trailing pipe is recognised by the canvas as well')
const historicalPath={label:'【分镜表】\n| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音 |\n| --- | --- | --- | --- | --- | --- |\n| shot-1 | 0–89f | intro | C:\\new\\test | \\\\server\\share | 字幕 |'}
assert.equal(parseTable(historicalPath).rows[1][3],'C:\\new\\test','unmarked historical Windows paths are not treated as escape sequences')
assert.equal(parseTable(historicalPath).rows[1][4],'\\\\server\\share','unmarked historical UNC paths are not rewritten')
const escapedTail={data:{drawaiTableEscaped:'1'},label:'| 标题一 | 标题二 |\n| --- | --- |\n| 首列 | 结尾\\|'}
assert.equal(parseTable(escapedTail).rows[1][1],'结尾|','escaped final pipe is part of the last cell, not a delimiter')

const entry = `import ReactRuntime from 'react';import {createRoot} from 'react-dom/client';
const module={exports:{}};const require=()=>ReactRuntime;
${composeClientBody()}
client={get:()=>undefined,interval:()=>()=>{},timeout:(fn,ms)=>{const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
window.tableTest={renderDiagram,svgTreeToDom};
window.saved={version:2,revision:'initial',meta:{pinned:true},layers:[{id:'1',name:'图层',visible:true,locked:false}],nodes:[
 {id:'story',x:80,y:80,w:720,h:160,label:'【分镜表】\\n| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音 |\\n| --- | --- | --- | --- | --- | --- |\\n| shot-1 | 0–89f | intro | 咖啡豆弹入 | 咖啡杯 | 第一镜 |\\n| shot-2 | 90–179f | outro | 杯子落下 | 桌面 | 第二镜 |',style:'text;html=1;whiteSpace=wrap;fontSize=12;'}
],edges:[]};
window.fetch=async(_url,options)=>{const req=JSON.parse(options.body);if(req.doc)window.saved=JSON.parse(JSON.stringify(req.doc));return {ok:true,json:async()=>({ok:true,exists:true,doc:window.saved,revision:'test',pageIndex:0,pageCount:1,pageNames:['画布'],jobs:[],focus:null})}};
document.head.appendChild(Object.assign(document.createElement('style'),{textContent:CSS+'body{margin:0;background:#f6f5f9;font:14px system-ui}'}));
createRoot(document.getElementById('app')).render(React.createElement(CanvasView,{sessionId:'test',path:'demo.drawai',active:true}));`
const bundle = await build({ stdin:{ contents:entry,resolveDir:process.cwd(),loader:'js' }, bundle:true,write:false,platform:'browser',format:'iife',logOverride:{'duplicate-object-key':'silent'} })
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<div id="app" style="position:absolute;inset:0"></div><script>'+bundle.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>')})
await new Promise((resolve,reject)=>{server.on('error',reject);server.listen(0,'127.0.0.1',resolve)})
let browser
try {
  browser=await openBrowser('chrome',{browserExecutable:process.env.DRAWAI_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',logLevel:'error'})
  const page=await browser.newPage({context:()=>null,logLevel:'error',indent:false,pageIndex:0,onBrowserLog:null,onLog:()=>{}})
  await page.setViewport({width:1200,height:800,deviceScaleFactor:1})
  const errors=[];page.on('pageerror',error=>errors.push(String(error)))
  await page.goto({url:'http://127.0.0.1:'+server.address().port,timeout:30000})
  const wait=async f=>{for(let i=0;i<120;i++){if(await page.evaluate(f))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out: '+f+'\n'+errors.join('\n'))}
  const click=async(selector,count=1)=>{const pos=await page.evaluate(selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}},selector);assert.ok(pos,'missing '+selector);for(let i=1;i<=count;i++){await page._client().send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:i});await page._client().send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:i})}}
  await wait(()=>!!document.querySelector('g[data-node-id="story"]'))
  const grid=await page.evaluate(()=>{const n=document.querySelector('g[data-node-id="story"]');return {rects:n.querySelectorAll('rect').length,text:n.textContent}})
  assert.ok(grid.rects>=18,'storyboard renders a grid for 3 rows × 6 columns')
  assert.ok(grid.text.includes('咖啡豆弹入')&&!grid.text.includes('| --- |'),'table shows content instead of Markdown markers')
  await click('g[data-node-id="story"]',2)
  await wait(()=>!!document.querySelector('[role="dialog"][aria-label="编辑表格"]'))
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.drawai-table-editor tr').length),3,'existing storyboard opens with all rows')
  const value='咖啡 | 杯\\路径\n下一行'
  await page.evaluate(value=>{const e=document.querySelector('textarea[aria-label="第1行第4列"]');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))},value)
  await page.evaluate(()=>[...document.querySelectorAll('.drawai-table-editor button')].find(b=>b.textContent==='保存').click())
  await wait(()=>!document.querySelector('.drawai-table-editor'))
  await wait(()=>window.saved.nodes[0].data?.drawaiTableEscaped==='1')
  const saved=await page.evaluate(()=>window.saved)
  assert.equal(saved.nodes[0].data.drawaiTableEscaped,'1')
  assert.ok(saved.nodes[0].label.includes('咖啡 \\| 杯\\\\路径\\n下一行'),'cell special characters are encoded')
  const spec=readCanvasSpec(saved,{fps:30,duration:6})
  assert.equal(spec.storyboard[0].intent,value,'video project receives the exact edited cell content')
  const exported=await page.evaluate(()=>{
    const tree=window.tableTest.renderDiagram(window.saved,'light','export',{current:null},{showGrid:false},{x:0,y:0,w:1000,h:800})
    const svg=window.tableTest.svgTreeToDom(tree,document)
    return new XMLSerializer().serializeToString(svg)
  })
  assert.ok(exported.includes('咖啡')&&exported.includes('下一行')&&(exported.match(/<rect/g)||[]).length>=18,'SVG export contains table cells and edited text')
  await click('button[aria-label="表格"]')
  const blank=await page.evaluate(()=>{const r=document.querySelector('.drawai-canvas').getBoundingClientRect();return {x:r.left+15,y:r.top+15}})
  await page._client().send('Input.dispatchMouseEvent',{type:'mousePressed',...blank,button:'left',clickCount:1})
  await page._client().send('Input.dispatchMouseEvent',{type:'mouseReleased',...blank,button:'left',clickCount:1})
  await wait(()=>window.saved.nodes.some(n=>n.id!=='story'))
  const created=await page.evaluate(()=>window.saved.nodes.find(n=>n.id!=='story').id)
  await click('g[data-node-id="'+created+'"]',2)
  await wait(()=>!!document.querySelector('.drawai-table-editor'))
  await page.evaluate(()=>{[...document.querySelectorAll('.drawai-table-editor button')].find(b=>b.textContent==='添加行').click();[...document.querySelectorAll('.drawai-table-editor button')].find(b=>b.textContent==='添加列').click()})
  await wait(()=>document.querySelectorAll('.drawai-table-editor tr').length===3 && document.querySelectorAll('.drawai-table-editor tr:first-child textarea').length===4)
  await page.evaluate(()=>[...document.querySelectorAll('.drawai-table-editor button')].find(b=>b.textContent==='保存').click())
  await wait(()=>!document.querySelector('.drawai-table-editor'))
  await wait(()=>window.saved.nodes.find(n=>n.id!== 'story')?.data?.drawaiTableEscaped==='1')
  assert.deepEqual(errors,[],'no page errors')
  if(process.env.DRAWAI_TABLE_SAMPLE){
    const file=JSON.parse(readFileSync(process.env.DRAWAI_TABLE_SAMPLE,'utf8'))
    const actual=file.pages.flatMap(page=>page.doc.nodes).find(node=>String(node.label).startsWith('【分镜表】'))
    assert.ok(actual,'real canvas contains storyboard')
    const model=parseTable(actual),video=readCanvasSpec({nodes:[actual],edges:[]},{fps:30})
    assert.ok(model&&model.rows.length>1,'real storyboard is recognised as a table')
    assert.equal(model.rows.length-1,video.storyboard.length,'real storyboard table and video project read the same row count')
  }
  console.log('Table nodes: old storyboard grid, cell editing, escaping, project parsing and generic row/column editing passed')
} finally {await browser?.close({silent:true});await new Promise(resolve=>server.close(resolve))}
