/**
 * 导出卡面回归（issue #53）—— 纯 node，不开浏览器。
 *
 * 画布上的卡面（镜头卡 / 整片风格 / 空视频 / 音频）是 foreignObject 里的 HTML。
 * 麻烦在于：**含 HTML 的 foreignObject 会让 SVG-as-image 的 canvas 标脏**
 * （Chrome 157 实测），`toDataURL()` / `toBlob()` 直接抛 SecurityError；光栅导出
 * 只能带 `aggressive=true` 把所有 foreignObject 全摘掉，于是导出图里的卡面变成
 * 空底色框 —— 这就是 issue #53 报的现象。
 *
 * 所以导出模式（`ui.faces === 'text'`）必须只用 SVG 原生图元。这里直接拿客户端的
 * `renderDiagram` 渲染一棵树来守这条线：
 *   · 导出树里不能有任何 foreignObject（否则一定会标脏、卡面一定会被摘掉）；
 *   · 卡面文字（卡 id / 风格 slug / 占位文案）必须在；
 *   · 交互画布（不给 faces）仍然走 HTML 卡面，不能被这次改动波及。
 */
import assert from 'node:assert/strict'
import { composeClientBody } from './build.mjs'

const React = {
  Component: class {},
  createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(8) } },
}
const mod = { exports: {} }
const api = new Function('module', 'exports', 'require', composeClientBody() + '\nreturn { renderDiagram }')(mod, mod.exports, () => React)

const doc = {
  nodes: [
    { id: 'card', x: 0, y: 0, w: 240, h: 200, label: '', data: { drawaiShotCard: '1', shotCardId: 'wall-reveal-moves', shotStyleKey: 'moves' } },
    { id: 'style', x: 280, y: 0, w: 240, h: 200, label: '', data: { drawaiMgStyle: '1', mgStyleSlug: '09-bauhaus' } },
    { id: 'film', x: 0, y: 240, w: 520, h: 280, label: '成片节点', data: { drawaiMotion: '1' } },
    { id: 'song', x: 0, y: 560, w: 240, h: 90, label: '', data: { drawaiAudio: '1', audioName: 'whoosh', audioRole: 'sfx', audioDuration: '1.4' } },
  ],
  edges: [],
  layers: [],
  labels: [],
}

/** 平铺整棵树，返回所有元素。 */
function flatten(tree, out = []) {
  if (Array.isArray(tree)) { for (const item of tree) flatten(item, out); return out }
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  out.push(tree)
  flatten(tree.children, out)
  return out
}

const textOf = (tree) => flatten(tree)
  .filter((item) => item.type === 'text')
  .map((item) => item.children.filter((child) => typeof child === 'string').join(''))

// ── 导出/给 AI 看一眼：SVG 原生卡面，一个 foreignObject 都不能有 ──────────
const exported = api.renderDiagram(doc, 'light', 'uid', { current: null }, { current: null, faces: 'text' }, null)
const exportNodes = flatten(exported)
assert.equal(exportNodes.filter((item) => item.type === 'foreignObject').length, 0,
  '导出树里还有 foreignObject：canvas 会被标脏，卡面又会被 aggressive 重试摘掉（issue #53）')
const printed = textOf(exported).join(' | ')
for (const expected of ['wall-reveal-moves', 'moves', '空视频节点', 'whoosh', '音效 · 1.4 秒', '成片节点']) {
  assert.ok(printed.includes(expected), '导出卡面里缺 "' + expected + '"：' + printed)
}
// 风格卡的标题优先用目录里的中文名，目录里查不到时退回 slug —— 两者都算"可读"。
assert.ok(printed.includes('整片风格'), '风格卡没有卡面标题：' + printed)
assert.ok(/09-bauhaus|几何构成/.test(printed), '风格卡既没有中文名也没有 slug：' + printed)
// 目录里没有的 slug 必须原样露出来，不能变成一个空框。
const unknown = api.renderDiagram({
  nodes: [{ id: 'x', x: 0, y: 0, w: 240, h: 200, label: '', data: { drawaiMgStyle: '1', mgStyleSlug: 'not-a-style' } }],
  edges: [], layers: [], labels: [],
}, 'light', 'uid2', { current: null }, { current: null, faces: 'text' }, null)
assert.ok(textOf(unknown).join(' | ').includes('not-a-style'), '未知风格 slug 没进导出件')
// 卡面必须落在节点自己的 <g> 里（与形状同组），否则叠放顺序和包围盒都会错。
const groups = exportNodes.filter((item) => item.type === 'g' && item.props && item.props['data-node-id'])
assert.equal(groups.length, doc.nodes.length, '节点没有各自成组')
for (const group of groups) {
  const hasText = flatten(group.children).some((item) => item.type === 'text')
  assert.ok(hasText, '节点 ' + group.props['data-node-id'] + ' 的组里一个字都没有')
}

// ── 深色主题：卡面底色跟着换（否则深色导出里会浮着几个浅色块） ──────────
const darkTree = api.renderDiagram(doc, 'dark', 'uid', { current: null }, { current: null, faces: 'text' }, null)
const fills = new Set(flatten(darkTree).filter((item) => item.type === 'rect').map((item) => item.props.fill))
assert.ok(fills.has('#292535') && fills.has('#2d2a20'), '深色主题下卡面没换深色底：' + Array.from(fills).join(','))

// ── 交互画布：仍然是 HTML 卡面 ────────────────────────────────────────────
const canvasTree = api.renderDiagram(doc, 'light', 'uid', { current: null }, { current: null }, null)
const canvasFaces = flatten(canvasTree).filter((item) => item.type === 'foreignObject')
assert.ok(canvasFaces.length >= 4, '交互画布的 HTML 卡面被改掉了：' + canvasFaces.length)

console.log('check-export-faces: OK (导出树无 foreignObject、卡面文字与深色底、交互画布仍走 HTML 卡面)')
