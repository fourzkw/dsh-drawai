// End-to-end regression for selected nodes and in-place text editing.
// Requires a local Chrome/Chromium; DRAWAI_CHROME_PATH overrides the default.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { openBrowser } from '@remotion/renderer'
import { composeClientBody } from './build.mjs'

const entry = `import ReactRuntime from 'react';import {createRoot} from 'react-dom/client';
const module={exports:{}};const require=()=>ReactRuntime;
${composeClientBody()}
client={get:()=>undefined,interval:()=>()=>{},timeout:(fn,ms)=>{const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
window.saved={version:2,revision:'initial',meta:{pinned:true},layers:[{id:'1',name:'图层',visible:true,locked:false}],nodes:[
 {id:'text',x:100,y:100,w:240,h:80,label:'咖啡的一天',style:'text;html=1;whiteSpace=wrap;fontColor=#222222;fontSize=18;'},
 {id:'shape',x:450,y:100,w:240,h:100,label:'普通图形文字',style:'rounded=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=18;'}
],edges:[]};
window.fetch=async(_url,options)=>{
 const req=JSON.parse(options.body);
 if(req.doc)window.saved=JSON.parse(JSON.stringify(req.doc));
 return {ok:true,json:async()=>({ok:true,exists:true,doc:window.saved,revision:'test',pageIndex:0,pageCount:1,pageNames:['画布'],jobs:[],focus:null})};
};
document.head.appendChild(Object.assign(document.createElement('style'),{textContent:CSS+'body{margin:0;background:#f6f5f9;font:14px system-ui}'}));
createRoot(document.getElementById('app')).render(React.createElement(CanvasView,{sessionId:'test',path:'demo.drawai',active:true}));`
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'iife', logOverride: { 'duplicate-object-key': 'silent' } })
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html;charset=utf-8')
  res.end('<div id="app" style="position:absolute;inset:0"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>')
})
await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
try {
  browser = await openBrowser('chrome', { browserExecutable: process.env.DRAWAI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', logLevel: 'error' })
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} })
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto({ url: 'http://127.0.0.1:' + server.address().port, timeout: 30000 })
  const waitFor = async predicate => {
    for (let i = 0; i < 120; i++) {
      if (await page.evaluate(predicate)) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error('Timed out: ' + predicate + '\n' + errors.join('\n'))
  }
  const clickNode = async (id, count = 1) => {
    const pos = await page.evaluate(id => {
      const el = document.querySelector('g[data-node-id="' + id + '"]')
      if (!el) return null
      const box = el.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }, id)
    assert.ok(pos, 'node exists: ' + id)
    for (let i = 1; i <= count; i++) {
      await page._client().send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: i })
      await page._client().send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: i })
    }
  }
  const clickSelector = async selector => {
    const pos = await page.evaluate(selector => {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, selector)
    assert.ok(pos, 'control exists: ' + selector)
    await page._client().send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: 1 })
    await page._client().send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: 1 })
  }
  await waitFor(() => !!document.querySelector('g[data-node-id="text"]') && !!document.querySelector('g[data-node-id="shape"]'))
  for (const [id, result] of [['text', '已编辑文字'], ['shape', '已编辑图形']]) {
    await clickNode(id)
    await waitFor(() => !!document.querySelector('.drawai-selection-toolbar:popover-open'))
    const toolbarBefore = await page.evaluate(() => {
      const toolbar = document.querySelector('.drawai-selection-toolbar:popover-open')
      return [...toolbar.querySelectorAll('summary[aria-label],button[aria-label]')].map(el => el.getAttribute('aria-label'))
    })
    await clickNode(id, 2)
    await waitFor(() => !!document.querySelector('.drawai-edit'))
    const editing = await page.evaluate(() => {
      const toolbar = document.querySelector('.drawai-selection-toolbar:popover-open')
      const editor = document.querySelector('.drawai-edit')
      const style = getComputedStyle(editor)
      return { toolbar: !!toolbar, labels: toolbar ? [...toolbar.querySelectorAll('summary[aria-label],button[aria-label]')].map(el => el.getAttribute('aria-label')) : [],
        outline: style.outlineStyle, outlineWidth: style.outlineWidth, borderWidth: style.borderWidth, background: style.backgroundColor }
    })
    assert.ok(editing.toolbar, id + ' retains the selected-node toolbar when editing')
    assert.deepEqual(editing.labels, toolbarBefore, id + ' keeps the same toolbar controls')
    assert.ok(editing.outline === 'none' || editing.outlineWidth === '0px', id + ' has no conspicuous editor outline')
    assert.equal(editing.borderWidth, '0px', id + ' has no editor border')
    assert.equal(editing.background, 'rgba(0, 0, 0, 0)', id + ' has transparent editing background')
    if (id === 'text' || id === 'shape') {
      const selected = await page.evaluate(() => {
        const editor = document.querySelector('.drawai-edit')
        editor.focus()
        const range = document.createRange()
        range.setStart(editor.firstChild, 0); range.setEnd(editor.firstChild, 2)
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
        return selection.toString()
      })
      const selectedText = id === 'text' ? '咖啡' : '普通'
      assert.equal(selected, selectedText, 'select part of the text in ' + id)
      await clickSelector('summary[aria-label="字色"]')
      await waitFor(() => !!document.querySelector('[aria-label="字色面板"]:popover-open'))
      await clickSelector('[aria-label="字色面板"] [aria-label="字色：红"]')
      assert.ok(await page.evaluate(() => !!document.querySelector('.drawai-edit')), 'choosing a text color does not exit editing')
      const colorMarkup = await page.evaluate(() => document.querySelector('.drawai-edit').innerHTML)
      assert.ok(/(?:color=|color:)/i.test(colorMarkup) && colorMarkup.includes('>' + selectedText + '</'), 'selected text receives a local color: ' + colorMarkup)
      assert.ok(colorMarkup.includes(id === 'text' ? '的一天' : '图形文字'), 'unselected text is retained')
      await clickSelector('summary[aria-label="字号"]')
      await waitFor(() => !!document.querySelector('[aria-label="字号面板"]:popover-open'))
      await clickSelector('[aria-label="字号面板"] [aria-label="字号：24"]')
      assert.ok(await page.evaluate(() => !!document.querySelector('.drawai-edit')), 'choosing a text size does not exit editing')
      const sizeMarkup = await page.evaluate(() => document.querySelector('.drawai-edit').innerHTML)
      assert.match(sizeMarkup, /font-size:\s*24px/i, 'selected text receives the requested size: ' + sizeMarkup)
    }
    await page.evaluate(id => {
      const editor = document.querySelector('.drawai-edit'); editor.focus()
      const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    }, id)
    await page._client().send('Input.insertText', { text: result })
    await page.evaluate(() => document.querySelector('.drawai-canvas').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    await waitFor(() => !document.querySelector('.drawai-edit'))
    await waitFor(() => window.saved.nodes.find(node => node.id === id).label.endsWith(id === 'text' ? '已编辑文字' : '已编辑图形'))
  }
  await waitFor(() => window.saved.nodes.find(node => node.id === 'shape').label === '普通图形文字已编辑图形')
  const savedText = await page.evaluate(() => window.saved.nodes.find(node => node.id === 'text'))
  assert.equal(savedText.label, '咖啡的一天已编辑文字')
  assert.match(savedText.labelHtml, /(?:color=|color:)/i, 'local color is saved')
  assert.match(savedText.labelHtml, /font-size:\s*24px/i, 'local font size is saved')
  const savedShape = await page.evaluate(() => window.saved.nodes.find(node => node.id === 'shape'))
  assert.match(savedShape.labelHtml, /(?:color=|color:)/i, 'local color is saved for shape text')
  assert.match(savedShape.labelHtml, /font-size:\s*24px/i, 'local size is saved for shape text')
  assert.deepEqual(errors, [])
  console.log('Unified text toolbar: real CanvasView selection, editing appearance and persistence passed')
} finally {
  await browser?.close({ silent: true })
  await new Promise(resolve => server.close(resolve))
}
