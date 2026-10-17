import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { composeClientBody } from './build.mjs'
import { styleWithImageDataUri, styleWithSvgMarkup } from '../src/style-kernel.js'

const React = { Component: class {} }
const mod = { exports: {} }
const api = new Function('module', 'exports', 'require', composeClientBody() +
  '\nreturn { nodeImageExportInfo, nodeImageExportBlob }')(mod, mod.exports, () => React)
const bytes = Buffer.from([0, 255, 128, 13, 10, 42])
for (const [mime, extension] of [['png', 'png'], ['jpeg', 'jpg'], ['jpg', 'jpg'], ['gif', 'gif'], ['webp', 'webp']]) {
  const node = { id: 'photo', label: '照片.' + extension, style: styleWithImageDataUri('', 'data:image/' + mime + ';base64,' + bytes.toString('base64')), w: 10, h: 20 }
  const info = api.nodeImageExportInfo(node)
  assert.equal(info.filename, '照片.' + extension)
  const blob = api.nodeImageExportBlob(info)
  assert.equal(blob.type, 'image/' + mime)
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes, 'original bytes survive export regardless of canvas dimensions')
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><text>中文 🎨</text></svg>'
for (const image of ['data:image/svg+xml,' + encodeURIComponent(svg), 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')]) {
  const info = api.nodeImageExportInfo({ id: 'svg-1', style: 'shape=image;image=' + image + ';' })
  assert.equal(info.filename, 'svg-1.svg')
  assert.equal(await api.nodeImageExportBlob(info).text(), svg, 'percent and base64 SVG retain Unicode and vector markup')
}
const node = { id: 'n1', label: 'a/b:*?"<>|.svg', style: styleWithSvgMarkup('', svg) }
assert.equal(api.nodeImageExportInfo(node).filename, 'a_b_______.svg')
for (const value of [null, { style: '' }, { style: 'shape=image;image=https://example.com/image.png;' },
  { ...node, data: { drawaiMedia: '1', mediaKind: 'svg', mediaClip: 'clip' } }]) {
  assert.equal(api.nodeImageExportInfo(value), null)
}

// Exercise the same download action called by the toolbar and context menu.
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const action = source.slice(source.indexOf('  function downloadBlob('), source.indexOf('  function downloadPng('))
let note, menu, clicked = false, removed = false, revoked = false, downloaded, pngNode
const anchor = { click() { clicked = true; downloaded = this.download } }
const run = new Function('nodeImageExportInfo', 'nodeImageExportBlob', 'nodeImageExportPng', 'document', 'URL', 'setTimeout', 'setMenu', 'setSaveNote',
  action + '\nreturn exportNodeImage')(api.nodeImageExportInfo, api.nodeImageExportBlob,
  async (value, info) => { pngNode = value; assert.equal(info.mime, 'image/svg+xml'); return new Blob(['png'], { type: 'image/png' }) },
  { createElement: () => anchor, body: { appendChild() {}, removeChild() { removed = true } } },
  { createObjectURL(blob) { assert.ok(blob instanceof Blob); return 'blob:test' }, revokeObjectURL() { revoked = true } },
  (callback) => callback(), (value) => { menu = value }, (value) => { note = value })
await run(node)
assert.equal(menu, null)
assert.equal(clicked && removed && revoked, true)
assert.equal(downloaded, 'a_b_______.svg')
assert.match(note, /已导出/)
await run(node, 'png')
assert.equal(pngNode, node)
assert.equal(downloaded, 'a_b_______.png')
assert.match(note, /已导出/)
await run({ style: 'shape=image;image=data:image/png;base64,!!invalid!!;' })
assert.match(note, /图片导出失败/)

const pngHelper = source.slice(source.indexOf('function nodeImageExportPng('), source.indexOf('function allocateClientClipId('))
const elementReact = { createElement(type, props, ...children) { return { type, props, children } } }
const makePng = new Function('React', 'svgTreeToDom', 'document', 'encodeExportPng', 'exportOutputSize', 'styleGet', pngHelper + '\nreturn nodeImageExportPng')(
  elementReact, (tree) => tree, {}, async (tree, output) => ({ tree, output }),
  new Function('module', 'exports', 'require', composeClientBody() + '\nreturn exportOutputSize')(mod, mod.exports, () => React),
  (style, key, fallback) => style.includes(key + '=1') ? '1' : fallback)
const result = await makePng({ ...node, w: 80, h: 40 }, api.nodeImageExportInfo(node))
assert.equal(result.tree.type, 'svg')
assert.equal(result.tree.props.viewBox, '0 0 80 40')
assert.equal(result.tree.children.length, 1, 'transparent export contains only the image, without canvas background or labels')
assert.equal(result.tree.children[0].props.href, api.nodeImageExportInfo(node).image)
assert.equal(result.tree.children[0].props.preserveAspectRatio, 'none')
assert.equal(result.output.width, 320)
assert.equal(result.output.height, 160)
const fitted = await makePng({ ...node, w: 80, h: 40, style: node.style + 'imageAspect=1;' }, api.nodeImageExportInfo(node))
assert.equal(fitted.tree.children[0].props.preserveAspectRatio, 'xMidYMid meet')
console.log('check-image-export: OK (original bytes, SVG encodings, transparent 4x PNG, aspect ratio, filenames, download and errors)')
