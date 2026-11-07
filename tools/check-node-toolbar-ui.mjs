// Browser regression for the real selection-toolbar branches at a short viewport.
// Run with a local Chromium installation; DRAWAI_CHROME_PATH overrides its path.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { openBrowser } from '@remotion/renderer'
import { composeClientBody } from './build.mjs'

const source = readFileSync('src/client.js', 'utf8')
const start = source.indexOf('function renderSelectionToolbar(')
const end = source.indexOf('function renderShapeRail(', start)
assert.ok(start >= 0 && end > start, 'selection toolbar implementation exists')
const selectionToolbar = source.slice(start, end)

const entry = `import ReactRuntime from 'react'; import {createRoot} from 'react-dom/client';
const module = {exports:{}}; const require = () => ReactRuntime;
${composeClientBody()}
document.head.appendChild(Object.assign(document.createElement('style'),{textContent:CSS}));
const root = createRoot(document.getElementById('app'));
window.fixtureState = {uploads:0, changes:[]};
function Fixture({kind}) {
  const canvasRef=React.useRef(null), rootRef=canvasRef, routeMemoryRef={current:new Map()};
  const node=kind==='audio' ? {id:'audio',x:280,y:210,w:60,h:50,data:motionCore.audioNodeData()} :
    {id:'movie',label:'视频',x:280,y:210,w:60,h:50,data:motionCore.motionNodeData()};
  const doc={nodes:[node],edges:[]},selectedIds=[node.id],view={x:0,y:0,w:320,h:300},size={w:320,h:300};
  const active=true,editing=null,menu=null,placeEdgeKind=null,placeTool=null,uid='fixture',hasPath=true;
  const nodeBoxOf=n=>n,filterEditableIds=(_doc,ids)=>ids,boxOfBoxes=boxes=>boxes[0];
  const mediaAction=async()=>({}),openAudioFilePicker=()=>{},videoImportsRef={current:null},applyAudioResult=()=>{};
  const applyLocal=()=>{},deleteById=()=>{},setSelectedIds=()=>{},openVideoFilePicker=()=>{window.fixtureState.uploads++};
  const renderMotionPanel=n=>React.createElement(MotionPanel,{node:n,doc,jobs:[],page:0,onChange:patch=>window.fixtureState.changes.push(patch),onGenerate:async()=>{},onReference:()=>{},onTask:async()=>{},onExport:async()=>{},onImport:()=>{}});
  ${selectionToolbar}
  return React.createElement('div',{ref:canvasRef,style:{position:'relative',width:'100vw',height:'100vh',background:'#222',
    '--dsw-alias-bg-overlay':'#25262a','--dsw-alias-label-primary':'#eceef2'}},renderSelectionToolbar());
}
window.showFixture=kind=>root.render(React.createElement(Fixture,{key:kind,kind}));`

const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false,
  platform: 'browser', format: 'iife', logOverride: { 'duplicate-object-key': 'silent' } })
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<div id="app"></div><style>body{margin:0}</style><script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>')
})
await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
try {
  browser = await openBrowser('chrome', { browserExecutable: process.env.DRAWAI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', logLevel: 'error' })
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} })
  await page.setViewport({ width: 320, height: 300, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto({ url: 'http://127.0.0.1:' + server.address().port, timeout: 30000 })
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (await page.evaluate(predicate)) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error('Timed out waiting for toolbar UI: ' + predicate + '\n' + errors.join('\n'))
  }
  for (const [kind, trigger, panel] of [['video', '编辑', '编辑面板'], ['audio', '音频设置', '音频设置面板']]) {
    await page.evaluate(kind => window.showFixture(kind), kind)
    await waitFor(() => !!document.querySelector('.drawai-selection-toolbar:popover-open'))
    const toolbar = await page.evaluate(() => {
      const el=document.querySelector('.drawai-selection-toolbar:popover-open'),r=el.getBoundingClientRect()
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}
    })
    assert.ok(toolbar.left >= 7 && toolbar.top >= 7 && toolbar.right <= 313 && toolbar.bottom <= 293, kind + ' toolbar stays in viewport')
    if (kind === 'video') {
      assert.equal(await page.evaluate(() => !!document.querySelector('button[aria-label="上传视频"]')), true)
      await page.evaluate(() => document.querySelector('button[aria-label="上传视频"]').click())
      assert.equal(await page.evaluate(() => window.fixtureState.uploads), 1, 'upload callback is retained')
    }
    await page.evaluate(trigger => document.querySelector('summary[aria-label="'+trigger+'"]').click(), trigger)
    await waitFor(() => !!document.querySelector('.drawai-palette-panel:popover-open'))
    const details = await page.evaluate(panel => {
      const el=document.querySelector('[aria-label="'+panel+'"]'),r=el.getBoundingClientRect()
      const scrollTarget=[el,...el.querySelectorAll('*')].find(item=>item.scrollHeight>item.clientHeight+1 && /auto|scroll/.test(getComputedStyle(item).overflowY))||el
      scrollTarget.scrollTop=60
      return {open:el.matches(':popover-open'),left:r.left,top:r.top,right:r.right,bottom:r.bottom,
        scrollHeight:scrollTarget.scrollHeight,clientHeight:scrollTarget.clientHeight,scrollTop:scrollTarget.scrollTop,
        overflow:getComputedStyle(scrollTarget).overflowY,hasPrompt:!!el.querySelector('[aria-label="视频描述"]'),
        hasAudioUpload:[...el.querySelectorAll('button')].some(b=>b.textContent==='上传音频')}
    }, panel)
    assert.ok(details.open && details.left >= 7 && details.top >= 7 && details.right <= 313 && details.bottom <= 293, panel + ' stays in viewport')
    assert.equal(details.overflow, 'auto', panel + ' uses scrolling')
    assert.ok(details.scrollHeight > details.clientHeight && details.scrollTop > 0, panel + ' is scrollable')
    assert.ok(kind === 'video' ? details.hasPrompt : details.hasAudioUpload, panel + ' retains its content')
  }
  assert.deepEqual(errors, [], 'no browser runtime errors')
  console.log('Node toolbars: video and audio panels stay in a 320×300 viewport, scroll, and retain their actions')
} finally {
  await browser?.close({ silent: true })
  await new Promise(resolve => server.close(resolve))
}
