import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { composeClientBody } from './build.mjs'
import { applyDocToMxfile, buildMxfile, parseMxfile } from '../src/mxfile.js'
import { normalizeDrawioDoc, styleWithImageDataUri, styleWithSvgMarkup } from '../src/style-kernel.js'

const React = { Component: class {}, createElement(type, props, ...children) { return { type, props: props || {}, children } } }
const mod = { exports: {} }
const api = new Function('module', 'exports', 'require', composeClientBody() + '\nreturn { ...module.exports.__routeInternals, cloneClipNode }')(mod, mod.exports, () => React)
const flatten = (n) => Array.isArray(n) ? n.flatMap(flatten) : n && typeof n === 'object' ? [n, ...flatten(n.children || [])] : []
const base = { nodes: [{ id: 'n1', label: '图片说明', x: 100, y: 60, w: 160, h: 100, layer: 'L',
  style: styleWithImageDataUri('', 'data:image/png;base64,AA==') }], edges: [], layers: [{ id: 'L', name: '内容' }], meta: {} }

for (const compressed of [false, true]) {
  const xml = buildMxfile(base, { compressed }).text
  const doc = parseMxfile(xml).doc
  assert.equal(applyDocToMxfile(xml, doc).text, xml, 'unmoved labels keep original bytes')
  doc.nodes[0].labelOffsetX = -150.5; doc.nodes[0].labelOffsetY = 190
  const saved = applyDocToMxfile(xml, normalizeDrawioDoc(doc)).text
  const loaded = parseMxfile(saved).doc
  assert.equal(loaded.nodes[0].labelOffsetX, -150.5)
  assert.equal(loaded.nodes[0].labelOffsetY, 190)
  assert.deepEqual([loaded.nodes[0].x, loaded.nodes[0].y, loaded.nodes[0].w, loaded.nodes[0].h], [100, 60, 160, 100])
  assert.equal(applyDocToMxfile(saved, loaded).text, saved, 'moved labels save idempotently')
  assert.equal(parseMxfile(buildMxfile(loaded, { compressed }).text).doc.nodes[0].labelOffsetY, 190, 'new files preserve label position')
  loaded.nodes[0].labelOffsetX = 0; loaded.nodes[0].labelOffsetY = 0
  const reset = parseMxfile(applyDocToMxfile(saved, loaded).text).doc.nodes[0]
  assert.equal(reset.labelOffsetX, undefined)
  assert.equal(reset.labelOffsetY, undefined)
}
const custom = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="L" parent="0"/><mxCell id="n1" value="图注" vertex="1" parent="L"><mxGeometry x="100" y="60" width="160" height="100" as="geometry"><mxRectangle x="1" y="2" width="3" height="4" as="alternateBounds"/><mxPoint extra="keep" as="offset" x="7" y="9"/></mxGeometry></mxCell></root></mxGraphModel></diagram></mxfile>'
const customDoc = parseMxfile(custom).doc
assert.equal(customDoc.nodes[0].labelOffsetX, 7)
assert.equal(applyDocToMxfile(custom, customDoc).text, custom)
customDoc.nodes[0].labelOffsetX = -220; customDoc.nodes[0].labelOffsetY = -80
const changed = applyDocToMxfile(custom, customDoc).text
assert.ok(changed.includes('<mxRectangle x="1" y="2" width="3" height="4" as="alternateBounds"/>'))
assert.ok(changed.includes('extra="keep"'))
assert.equal(parseMxfile(changed).doc.nodes[0].labelOffsetX, -220)

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
assert.equal(source.indexOf('function onNodeLabelPointerDown('), -1, '节点文字不再可拖')
assert.equal(source.indexOf('function moveNodeLabel('), -1)

for (const kind of ['image', 'video', 'rect']) {
  const node = { ...base.nodes[0], label: '说明', labelOffsetX: -220, labelOffsetY: 180 }
  if (kind === 'video') { node.style = styleWithSvgMarkup('', '<svg viewBox="0 0 10 10"/>'); node.data = { drawaiMedia: '1', mediaKind: 'raster', mediaClip: 'video' } }
  if (kind === 'rect') node.style = ''
  const doc = { ...structuredClone(base), nodes: [node] }
  const rendered = flatten(api.renderDiagram(doc, 'light', 'labels', { current: null }, { selectedIds: ['n1'] }, null))
  const text = rendered.find((item) => item.type === 'text' && item.props['data-node-id'] === 'n1')
  assert.equal(rendered.some((item) => item.props['data-node-label-hit'] === 'n1'), false, kind + ' 没有可拖的文字热区')
  if (kind === 'rect') {
    assert.ok(text, '普通节点仍画文字')
    assert.equal(text.props.pointerEvents, 'none')
    assert.equal(text.props.onPointerDown, undefined)
    const box = api.labelTextBox({ node, geo: { x: node.x, y: node.y, w: node.w, h: node.h } })
    assert.equal(box.x, node.x + (node.w - box.w) / 2, '文字位置不再吃 labelOffset')
  } else {
    assert.equal(text, undefined, kind + ' 节点不画文字')
    assert.equal(api.labelPaintBounds(node, { x: node.x, y: node.y, w: node.w, h: node.h }), null)
  }
}
console.log('check-node-labels: OK (offset roundtrip kept, node labels are not draggable, image and video have no text)')
