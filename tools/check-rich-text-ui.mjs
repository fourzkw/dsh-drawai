import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { openBrowser } from '@remotion/renderer'
import { composeClientBody } from './build.mjs'
import { buildMxfile, parseMxfile } from '../src/mxfile.js'

const entry = `import ReactRuntime from 'react'; import {createRoot} from 'react-dom/client';
const module = {exports:{}}; const require = () => ReactRuntime;
${composeClientBody()}
const node={id:'rich',label:'Hello World',labelHtml:'Hello <b>World</b>',style:'text;html=1;whiteSpace=wrap;',x:20,y:20,w:250,h:100};
const doc={nodes:[node],edges:[]};
window.richTest={sanitizeLabelHtml,labelHtmlText,plainLabelHtml,clearRichLabelFormatting,svgTreeToDom,renderDiagram,cloneClipNode,cloneDoc,doc};
createRoot(document.getElementById('app')).render(renderDiagram(doc,'light','rich',{current:null},{showGrid:false},{x:0,y:0,w:300,h:150}));`
const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'iife', logOverride: { 'duplicate-object-key': 'silent' } })
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<div id="app"></div><script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>') })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await openBrowser('chrome', { browserExecutable: process.env.DRAWAI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', logLevel: 'error' })
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} })
  await page.goto({ url: 'http://127.0.0.1:' + server.address().port, timeout: 30000 })
  const result = await page.evaluate(async () => {
    const api = window.richTest
    const safe = api.sanitizeLabelHtml('<div onclick="alert(1)">A <b>bold</b><img src="https://example.com/x"><script>alert(1)</script><span style="color:red;background-image:url(https://example.com/x)"> red</span></div><div>B</div>')
    const imported = api.sanitizeLabelHtml('<a href="https://example.com/doc" onclick="alert(1)"><font face="Arial" color="red">链接</font></a><a href="javascript:alert(1)">危险链接</a><span style="font-family:Arial;background-color:yellow">高亮</span>')
    const shapeRich = {style:'rounded=1;html=1;', labelHtml:'<b><font color="red" size="5">图形</font></b>'}
    api.clearRichLabelFormatting(shapeRich, {color:true})
    const rich = {style:'text;html=1;', labelHtml:'<b><font color="red" size="5">标题</font></b><span style="color:blue;font-size:24px;font-style:italic">正文</span>'}
    const snapshot = api.cloneDoc({nodes:[rich], edges:[]})
    api.clearRichLabelFormatting(rich, {color:true})
    const wholeColor = rich.labelHtml
    api.clearRichLabelFormatting(rich, {size:true})
    const wholeSize = rich.labelHtml
    const shorthand = {style:'text;',labelHtml:'<span style="font: italic bold 18px Arial">X</span>'}
    api.clearRichLabelFormatting(shorthand, {size:true})
    const shorthandTemplate = document.createElement('template'); shorthandTemplate.innerHTML = shorthand.labelHtml
    const shorthandSize = shorthandTemplate.content.querySelector('span').style.fontSize
    const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.textContent = '咖啡的一天'; document.body.appendChild(editor); editor.focus()
    const range = document.createRange(); range.setStart(editor.firstChild,0); range.setEnd(editor.firstChild,2)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    const boldApplied = document.execCommand('bold',false,null)
    const edited = api.sanitizeLabelHtml(editor.innerHTML); editor.remove()
    const shown = document.querySelector('#app tspan[font-weight="bold"]')
    const tree = api.renderDiagram(api.doc,'light','export',{current:null},{showGrid:false},{x:0,y:0,w:300,h:150})
    const svg = api.svgTreeToDom(tree,document)
    svg.setAttribute('xmlns','http://www.w3.org/2000/svg'); svg.setAttribute('width','300'); svg.setAttribute('height','150'); svg.setAttribute('viewBox','0 0 300 150')
    const xml = new XMLSerializer().serializeToString(svg)
    const image = new Image()
    const url = URL.createObjectURL(new Blob([xml],{type:'image/svg+xml'}))
    const loaded = await new Promise((resolve) => { image.onload=()=>resolve(true); image.onerror=()=>resolve(false); image.src=url })
    let ink = 0
    if (loaded) { const canvas=document.createElement('canvas'); canvas.width=300; canvas.height=150; const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0); const pixels=ctx.getImageData(0,0,300,150).data; for(let i=0;i<pixels.length;i+=4) if(pixels[i+3] && pixels[i]<100 && pixels[i+1]<100 && pixels[i+2]<100) ink++ }
    URL.revokeObjectURL(url)
    return {safe, imported, shapeRich:shapeRich.labelHtml, wholeColor, wholeSize, shorthandSize, snapshot:snapshot.nodes[0].labelHtml, text:api.labelHtmlText(safe), boldApplied, edited, editedText:api.labelHtmlText(edited), shown:shown && shown.textContent, xml, loaded, ink, copy:api.cloneClipNode(api.doc.nodes[0]).labelHtml}
  })
  assert.match(result.safe, /<b>bold<\/b>/)
  assert.doesNotMatch(result.safe, /script|onclick|img|background-image/i)
  assert.match(result.imported, /href="https:\/\/example\.com\/doc"/i, 'safe links survive editing preparation')
  assert.match(result.imported, /face="Arial"/i, 'imported font survives editing preparation')
  assert.match(result.imported, /background-color:\s*yellow/i, 'imported highlight survives editing preparation')
  assert.doesNotMatch(result.imported, /javascript:|onclick/i, 'unsafe imported link and event handler are removed')
  assert.doesNotMatch(result.shapeRich, /color=/i, 'whole-node color clears shape text overrides')
  assert.match(result.shapeRich, /<b>/i, 'whole-node color retains shape text emphasis')
  assert.doesNotMatch(result.wholeColor, /(?:\bcolor\s*=|\bcolor\s*:)/i)
  assert.match(result.wholeColor, /size="5"/)
  assert.match(result.wholeColor, /font-size:\s*24px/i)
  assert.doesNotMatch(result.wholeSize, /(?:\bsize\s*=|font-size\s*:)/i)
  assert.equal(result.shorthandSize, '')
  assert.match(result.wholeSize, /<b>/i)
  assert.match(result.wholeSize, /font-style:\s*italic/i)
  assert.match(result.snapshot, /color="red"/i)
  assert.match(result.snapshot, /size="5"/i)
  const richDoc = (html) => ({nodes:[{id:'a',label:'标题正文',labelHtml:html,style:'text;html=1;',x:0,y:0,w:200,h:80}],edges:[],meta:{}})
  assert.equal(parseMxfile(buildMxfile(richDoc(result.wholeSize)).text).doc.nodes[0].labelHtml, result.wholeSize)
  assert.equal(parseMxfile(buildMxfile(richDoc(result.snapshot)).text).doc.nodes[0].labelHtml, result.snapshot)
  assert.equal(result.text, 'A bold red\nB')
  assert.equal(result.boldApplied, true)
  assert.match(result.edited, /<b>咖啡<\/b>/)
  assert.equal(result.editedText, '咖啡的一天')
  assert.equal(result.shown, 'World')
  assert.match(result.xml, /font-weight="bold"[^>]*>World<\/tspan>/)
  assert.equal(result.loaded, true)
  assert.ok(result.ink > 0, 'rendered rich text is present in rasterized SVG')
  assert.equal(result.copy, 'Hello <b>World</b>')
  console.log('rich text: sanitizer, rendered HTML, copy, SVG and PNG rasterization passed')
} finally { await browser?.close({ silent: true }); await new Promise((resolve) => server.close(resolve)) }
