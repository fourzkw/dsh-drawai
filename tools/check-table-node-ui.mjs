// Browser regression for table rendering and in-place cell editing through the real canvas.
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
  const wait=async(f,args)=>{for(let i=0;i<160;i++){if(await page.evaluate(f,args))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out: '+f+'\n'+errors.join('\n'))}
  const point=async(f,args)=>{const pos=await page.evaluate(f,args);assert.ok(pos,'missing target');return pos}
  const clickAt=async(pos,count=1,button='left')=>{for(let i=1;i<=count;i++){await page._client().send('Input.dispatchMouseEvent',{type:'mousePressed',x:pos.x,y:pos.y,button,clickCount:i});await page._client().send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x,y:pos.y,button,clickCount:i})}}
  const click=async(selector,count=1)=>clickAt(await point(selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}},selector),count)
  // 单元格中心直接取画出来的 rect（不再靠宽高权重反算，避免标题带/行高估算偏一行）。
  const cellPoint=async(id,row,col,cols=6)=>point(([id,row,col,cols])=>{
    const cells=[...document.querySelectorAll('g[data-node-id="'+id+'"] rect[stroke="#cbd2dd"]')]
    const rect=cells[row*cols+col]
    if(!rect)return null
    const r=rect.getBoundingClientRect()
    return {x:r.left+r.width/2,y:r.top+r.height/2}
  },[id,row,col,cols])
  const key=async(k,code,vk,modifiers=0)=>{await page._client().send('Input.dispatchKeyEvent',{type:'keyDown',key:k,code,windowsVirtualKeyCode:vk,modifiers});await page._client().send('Input.dispatchKeyEvent',{type:'keyUp',key:k,code,windowsVirtualKeyCode:vk,modifiers})}
  const label=()=>page.evaluate(()=>{const el=document.querySelector('textarea.drawai-cell-editor');return el===null?null:el.getAttribute('aria-label')})
  const waitLabel=async expected=>{for(let i=0;i<160;i++){if((await label())===expected)return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('cell editor should show '+expected+', got '+await label())}
  const menuItems=()=>page.evaluate(()=>[...document.querySelectorAll('.drawai-menu button')].map(b=>b.textContent))
  const menuClick=async text=>page.evaluate(text=>{const target=[...document.querySelectorAll('.drawai-menu button')].find(b=>b.textContent===text);if(!target)return false;target.click();return true},text)

  await wait(()=>!!document.querySelector('g[data-node-id="story"]'))
  const grid=await page.evaluate(()=>{const n=document.querySelector('g[data-node-id="story"]');return {rects:n.querySelectorAll('rect').length,text:n.textContent}})
  assert.ok(grid.rects>=18,'storyboard renders a grid for 3 rows × 6 columns')
  assert.ok(grid.text.includes('咖啡豆弹入')&&!grid.text.includes('| --- |'),'table shows content instead of Markdown markers')

  // 双击单元格 → 画布上就地出现一格编辑框（不再弹对话框页）。
  // 表头行双击也是就地编辑，并且带表头底色。
  await clickAt(await cellPoint('story',0,0),2)
  await waitLabel('第1行第1列')
  assert.equal(await page.evaluate(()=>document.querySelector('[role="dialog"]')),null,'cell editing no longer opens a dialog')
  assert.ok(await page.evaluate(()=>document.querySelector('textarea.drawai-cell-editor').classList.contains('drawai-cell-editor-head')),'header row cell is styled as a header')
  assert.equal(await page.evaluate(()=>document.querySelectorAll('textarea.drawai-cell-editor').length),1,'only the edited cell gets an editor')
  await key('Escape','Escape',27)
  await wait(()=>!document.querySelector('textarea.drawai-cell-editor'))

  // 数据格：双击落到「第2行第4列」（shot-1 的"这一镜要做什么"），改完 Tab 提交右移。
  await clickAt(await cellPoint('story',1,3),2)
  await waitLabel('第2行第4列')
  assert.ok(!(await page.evaluate(()=>document.querySelector('textarea.drawai-cell-editor').classList.contains('drawai-cell-editor-head'))),'data row cells stay on the body background')
  const value='咖啡 | 杯\\路径\n下一行'
  await page.evaluate(value=>{const e=document.querySelector('textarea.drawai-cell-editor');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))},value)
  await key('Tab','Tab',9)
  await waitLabel('第2行第5列')
  await wait(()=>window.saved.nodes[0].data?.drawaiTableEscaped==='1')
  const saved=await page.evaluate(()=>window.saved)
  assert.equal(saved.nodes[0].data.drawaiTableEscaped,'1')
  assert.ok(saved.nodes[0].label.includes('咖啡 \\| 杯\\\\路径\\n下一行'),'cell special characters are encoded')
  const spec=readCanvasSpec(saved,{fps:30,duration:6})
  assert.equal(spec.storyboard[0].intent,value,'video project receives the exact edited cell content')

  // Shift+Tab 左移、Enter 下移、Esc 关掉。
  await key('Tab','Tab',9,8)
  await waitLabel('第2行第4列')
  await key('Enter','Enter',13)
  await waitLabel('第3行第4列')
  await key('Escape','Escape',27)
  await wait(()=>!document.querySelector('textarea.drawai-cell-editor'))

  // 右键单元格 → 行列操作都在菜单里，不再需要"打开编辑器页面"。
  await clickAt(await cellPoint('story',1,0),1,'right')
  await wait(()=>!!document.querySelector('.drawai-menu'))
  const items=await menuItems()
  for(const expected of ['编辑此格','上方插入行','下方插入行','删除本行']) assert.ok(items.includes(expected),'cell menu offers '+expected)
  assert.ok(!items.includes('左侧插入列'),'storyboard columns are fixed, so no column operations')
  assert.ok(await menuClick('下方插入行'),'insert row from the cell menu')
  await wait(()=>window.saved.nodes[0].label.split('\n').filter(line=>line.trim().startsWith('|')).length===5)
  await clickAt(await cellPoint('story',1,0),1,'right')
  await wait(()=>!!document.querySelector('.drawai-menu'))
  assert.ok(await menuClick('编辑此格'),'edit the cell from the menu')
  await wait(()=>!!document.querySelector('textarea.drawai-cell-editor'))
  assert.equal(await label(),'第2行第1列','menu opens the clicked cell')
  await key('Escape','Escape',27)
  await wait(()=>!document.querySelector('textarea.drawai-cell-editor'))

  const exported=await page.evaluate(()=>{
    const tree=window.tableTest.renderDiagram(window.saved,'light','export',{current:null},{showGrid:false},{x:0,y:0,w:1000,h:800})
    const svg=window.tableTest.svgTreeToDom(tree,document)
    return new XMLSerializer().serializeToString(svg)
  })
  assert.ok(exported.includes('咖啡')&&exported.includes('下一行')&&(exported.match(/<rect/g)||[]).length>=18,'SVG export contains table cells and edited text')

  // 新建表格也走就地编辑：点工具条 → 落节点 → 双击开格 → 右键加行列。
  await click('button[aria-label="表格"]')
  const blank=await point(()=>{const r=document.querySelector('.drawai-canvas').getBoundingClientRect();return {x:r.left+15,y:r.top+15}})
  await clickAt(blank)
  await wait(()=>window.saved.nodes.some(n=>n.id!=='story'))
  const created=await page.evaluate(()=>window.saved.nodes.find(n=>n.id!=='story').id)
  const shapeOf=async id=>page.evaluate(id=>{
    const node=window.saved.nodes.find(n=>n.id===id)
    const lines=String(node.label).split('\n').filter(line=>line.trim().startsWith('|'))
    return {rows:lines.length,cols:lines.length?lines[0].split('|').length-2:0}
  },created)
  const before=await shapeOf(created)
  const createdBox=await point(id=>{const g=document.querySelector('g[data-node-id="'+id+'"]');if(!g)return null;const r=g.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}},created)
  await clickAt(createdBox,2)
  await wait(()=>!!document.querySelector('textarea.drawai-cell-editor'))
  assert.match(await label(),/^第\d+行第\d+列$/,'a fresh table opens for in-place editing too')
  await key('Escape','Escape',27)
  await wait(()=>!document.querySelector('textarea.drawai-cell-editor'))
  await clickAt(createdBox,1,'right')
  await wait(()=>!!document.querySelector('.drawai-menu'))
  assert.ok((await menuItems()).includes('右侧插入列'),'generic tables offer column operations')
  assert.ok(await menuClick('右侧插入列'))
  await wait(([id,cols])=>window.saved.nodes.find(n=>n.id===id).label.split('\n').filter(l=>l.trim().startsWith('|'))[0].split('|').length-2===cols,[created,before.cols+1])
  await clickAt(createdBox,1,'right')
  await wait(()=>!!document.querySelector('.drawai-menu'))
  assert.ok(await menuClick('下方插入行'))
  await wait(([id,rows])=>window.saved.nodes.find(n=>n.id===id).label.split('\n').filter(l=>l.trim().startsWith('|')).length===rows,[created,before.rows+1])
  assert.deepEqual(errors,[],'no page errors')
  if(process.env.DRAWAI_TABLE_SAMPLE){
    const file=JSON.parse(readFileSync(process.env.DRAWAI_TABLE_SAMPLE,'utf8'))
    const actual=file.pages.flatMap(page=>page.doc.nodes).find(node=>String(node.label).startsWith('【分镜表】'))
    assert.ok(actual,'real canvas contains storyboard')
    const model=parseTable(actual),video=readCanvasSpec({nodes:[actual],edges:[]},{fps:30})
    assert.ok(model&&model.rows.length>1,'real storyboard is recognised as a table')
    assert.equal(model.rows.length-1,video.storyboard.length,'real storyboard table and video project read the same row count')
  }
  console.log('Table nodes: storyboard grid, in-place cell editing (double click / Tab / Enter / Esc), escaping, project parsing and cell-menu row-column editing passed')
} finally {await browser?.close({silent:true});await new Promise(resolve=>server.close(resolve))}
