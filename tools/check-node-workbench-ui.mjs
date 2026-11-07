import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { openBrowser } from '@remotion/renderer'
import { composeClientBody } from './build.mjs'

// Exercise the production components and CSS in Chromium, including top-layer hit testing.
const entry = `import ReactRuntime from 'react'; import {createRoot} from 'react-dom/client';
const module = {exports:{}}; const require = () => ReactRuntime;
${composeClientBody()}
document.head.appendChild(Object.assign(document.createElement('style'), {textContent: CSS + 'body{margin:0;background:#f3f4f8;font:14px system-ui}.drawai-selection-toolbar::backdrop{background:transparent}'}));
const node={id:'video-1',data:motionCore.motionNodeData()}; node.data.motion.prompt='绘制星际探索动画：火箭升空，行星与星点形成视差，镜头缓慢上移。';
const jobs=[{id:'task-1',nodeId:node.id,page:0,status:'coding',stageDetail:{shotId:'shot-1',componentId:'Rocket'}}];
function App(){const canvasRef=React.useRef(null); const [shown,setShown]=React.useState(true); const [cancelled,setCancelled]=React.useState(false); const [preview,setPreview]=React.useState(false); window.showPreview=()=>setPreview(true);
window.hideCard=()=>setShown(false); window.cancelled=cancelled;
return React.createElement('div',{className:'drawai-root',style:{position:'absolute',left:440,top:30,width:600,height:1120,overflow:'hidden',background:'#171715',border:'1px solid #33312f'}},
React.createElement('div',{ref:canvasRef,style:{position:'absolute',inset:0,overflow:'hidden',backgroundImage:'linear-gradient(#ffffff06 1px,transparent 1px),linear-gradient(90deg,#ffffff06 1px,transparent 1px)',backgroundSize:'40px 40px'}},
React.createElement('div',{style:{position:'absolute',left:preview?40:-40,top:100,width:520,height:293,background:'#282523',border:'2px solid #3786ff',borderRadius:26,color:'#a8a29e',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:20}},videoWorkbenchIcon('video'),'空视频节点'),
shown?React.createElement(NodeToolCard,{canvasRef,className:'drawai-selection-toolbar drawai-video-action-toolbar',style:{left:preview?'90px':'10px',top:'20px',width:'420px'}},React.createElement(VideoNodeToolbar,{node,onDelete:()=>setShown(false),onEdit:()=>document.querySelector('.drawai-video-prompt').focus(),onUpload:()=>{}})):null,
shown?React.createElement(NodeToolCard,{canvasRef,'aria-label':'视频节点工具卡片',className:'drawai-selection-toolbar drawai-motion-toolbar',style:{left:preview?'40px':'-40px',top:'410px',width:'520px'}},
React.createElement(MotionPanel,{mode:'dark',node,doc:{nodes:[node],edges:[]},jobs:cancelled?[]:jobs,page:0,onChange:()=>{},onGenerate:async()=>{},onTask:async()=>setCancelled(true),onShowTasks:()=>{}})):null),
React.createElement(BackgroundTaskPanel,{jobs:[],exports:[],motions:cancelled?[]:jobs,onMotionCommand:async()=>setCancelled(true),onCommand:async()=>{},path:'demo.drawai',page:0,onHide:()=>{}}));}
createRoot(document.getElementById('app')).render(React.createElement(App));`
const result = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'iife', logOverride: { 'duplicate-object-key': 'silent' } })
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<div id="app"></div><script>' + result.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>') })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await openBrowser('chrome', { browserExecutable: process.env.DRAWAI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', logLevel: 'error' })
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} })
  await page.setViewport({ width: 1200, height: 1200, deviceScaleFactor: 1 })
  await page.goto({ url: 'http://127.0.0.1:' + server.address().port, timeout: 30000 })
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate(() => !!document.querySelector('[aria-label="视频节点工具卡片"]:popover-open'))) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const card = await page.evaluate(() => {
    const panel = document.querySelector('[aria-label="视频节点工具卡片"]'), canvas = panel.parentElement
    const a = panel.getBoundingClientRect(), b = canvas.getBoundingClientRect()
    return { open: panel.matches(':popover-open'), left: a.left, canvasLeft: b.left, width: a.width,
      hittable: panel.contains(document.elementFromPoint(a.left + 24, a.top + 24)), text: panel.textContent,
      progress: !!document.querySelector('[aria-label="绘制视频 · video-1进度"]') }
  })
  assert.equal(card.open, true)
  assert.equal(card.width, 520)
  assert.equal(card.left, card.canvasLeft - 40)
  assert.equal(card.hittable, true, 'tool card stays interactive outside the overflow:hidden canvas')
  assert.match(card.text, /绘制动画视频.*生视频 API/)
  assert.doesNotMatch(card.text, /主会话/)
  assert.equal(card.progress, true, 'task progress remains visible outside the selected node')
  mkdirSync('artifacts', { recursive: true })
  await page.evaluate(() => window.showPreview())
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate(() => document.querySelector('[aria-label="视频节点工具卡片"]').getBoundingClientRect().left > 440)) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const shot = await page._client().send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync('artifacts/video-node-composer.png', Buffer.from(shot.value.data, 'base64'))
  await page.evaluate(() => { const panel = document.querySelector('[aria-label="视频节点工具卡片"]'); [...panel.querySelectorAll('button')].find((button) => button.textContent === '取消').click() })
  for (let i = 0; i < 100 && !await page.evaluate(() => window.cancelled); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await page.evaluate(() => window.cancelled), true)
  await page.evaluate(() => window.hideCard())
  for (let i = 0; i < 100 && await page.evaluate(() => !!document.querySelector('[aria-label="视频节点工具卡片"]')); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await page.evaluate(() => !!document.querySelector('[aria-label="视频节点工具卡片"]')), false, 'deselection removes the top-layer card')
  console.log('Node workbench browser: real components, unclipped top-layer card, task progress, cancellation and deselection passed.')
} finally { await browser?.close({ silent: true }); await new Promise((resolve) => server.close(resolve)) }
