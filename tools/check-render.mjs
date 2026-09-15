/**
 * 渲染路径自测 —— 不需要浏览器。
 *
 * 路由自测（check-route-preview.mjs）覆盖的是"折线算得对不对"，
 * 这个脚本覆盖的是另一半："算出来的东西有没有真的画进 SVG"。
 *
 * 做法：给 client.js 一个**极简 React 桩**（createElement 只产出普通对象树），
 * 然后直接调用内部的 renderDiagram，把返回的元素树按 className / key 检索。
 * 这样"预览线根本没被渲染"、"吸附环画在了错误的节点上"这类问题会在命令行里暴露，
 * 而不是等到打开页面才发现。
 *
 * 用法：node tools/check-render.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { composeClientBody } from './build.mjs'
// 造 style 键夹具时直接用内核（与宿主/客户端同一份），免得把键名再抄一遍。
import { DEFAULT_EDGE_STYLE, NODE_SHAPES, curvedFromStyle, lineKindFromStyle, nodeShapeFromStyle, normalizeDrawioDoc, styleGet, stylePatch, styleWithLineKind, styleWithNodeShape, styleWithTextColorName, textColorNameFromStyle } from '../src/style-kernel.js'

const here = dirname(fileURLToPath(import.meta.url))
/** 源码文本断言用（CSS 串、函数名这些在 src/client.js 里就有）。 */
const source = resolve(here, '..', 'src', 'client.js')
// 客户端半边依赖"构建时内联的样式内核"，所以 eval 的是**与产物同款的组合 body**
// （内核 + src/client.js），而不是裸的 src/client.js —— 测的正是真正会被加载的那份文本。
const clientBody = composeClientBody()

let failures = 0
let checks = 0

function ok(condition, label) {
  checks += 1
  if (condition) {
    console.log('  ✓ ' + label)
    return true
  }
  failures += 1
  console.log('  ✗ ' + label)
  return false
}

/** React 桩：只保留 type / props / children，够我们在元素树上做检索。 */
const reactStub = {
  Component: class Component {},
  createElement: (type, props, ...children) => ({ type: type, props: props === null || props === undefined ? {} : props, children: children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
}

const module = { exports: {} }
const require = (spec) => {
  if (spec === 'react') return reactStub
  throw new Error('check-render: 意外 require(' + spec + ')')
}
new Function('module', 'exports', 'require', 'window', 'document', clientBody)(module, module.exports, require, {}, {})

const internals = module.exports.__routeInternals
const renderDiagram = internals.renderDiagram
if (typeof renderDiagram !== 'function') throw new Error('renderDiagram 没有导出，无法做渲染自测')

/** 深度遍历元素树，收集所有满足 predicate 的节点（含根）。 */
function walk(node, predicate, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  walk(node.children, predicate, out)
  return out
}

const byClass = (tree, cls) => walk(tree, (n) => typeof n.props.className === 'string' && n.props.className.split(/\s+/).indexOf(cls) >= 0, [])
const byKey = (tree, key) => walk(tree, (n) => n.props.key === key, [])

const doc = {
  nodes: [
    { id: 'a', x: 0, y: 0, w: 160, h: 60, label: 'A' },
    { id: 'b', x: 420, y: 300, w: 160, h: 60, label: 'B' },
    { id: 'c', x: 100, y: 400, w: 160, h: 60, label: 'C' },
  ],
  edges: [{ id: 'e1', from: 'a', to: 'b' }],
}

const geometry = internals.buildGeometry(doc)

console.log('base：没有拖拽时不该有任何预览件')
{
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  ok(byClass(tree, 'drawai-preview').length === 0, '无预览路径')
  ok(byClass(tree, 'drawai-hot-ring').length === 0, '无吸附环')
  ok(byClass(tree, 'drawai-preview-tip').length === 0, '无收尾线')
  ok(byClass(tree, 'drawai-node').length === 3, '三个节点都渲染了')
}

console.log('\n拖线（空白处）：预览折线 + 收尾线 + 起点圆点都要出现')
{
  const cursor = { x: 700, y: 500 }
  const route = internals.routePreviewFor(doc, geometry, cursor, 'a', geometry.byId.a.geo, { from: 'a', side: 'e' }, internals.HOT_PAD, 'a')
  const ui = { selectedIds: ['a'], connectFrom: 'a', connectTo: cursor, connectSide: 'e', connectHover: null, connectPreview: route, edgePreview: null }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, ui, null)
  const previews = byClass(tree, 'drawai-preview')
  ok(previews.length >= 2, '预览件齐了（折线 + 起点圆点，共 ' + previews.length + ' 件）')
  const path = previews.filter((n) => n.type === 'path')
  ok(path.length === 1, '恰好一条预览折线')
  const d = path[0].props.d
  ok(typeof d === 'string' && d.length > 0 && d.indexOf('NaN') < 0, '预览折线的 d 合法：' + d)
  // d 的起笔点必须等于路由折线的第一个点。
  const head = route.points[0]
  ok(d.indexOf('M ' + Math.round(head.x * 100) / 100 + ' ' + Math.round(head.y * 100) / 100) === 0, 'd 从路由折线的起点起笔')
  // 空白处：折线终点**就是**指针，收尾线没有存在意义（不该多画一段零长度线）。
  ok(byClass(tree, 'drawai-preview-tip').length === 0, '折线已到指针时不再画收尾线')
  ok(byClass(tree, 'drawai-hot-ring').length === 0, '空白处没有吸附环')
  ok(byClass(tree, 'drawai-node-hot').length === 0, '空白处没有高亮节点')
}

console.log('\n拖线（吸附到 b）：目标节点要亮环 + 光标变成 copy')
{
  const cursor = { x: 440, y: 320 }
  const route = internals.routePreviewFor(doc, geometry, cursor, 'a', geometry.byId.a.geo, { from: 'a', side: 'e' }, internals.HOT_PAD, 'a')
  const ui = { selectedIds: ['a'], connectFrom: 'a', connectTo: cursor, connectSide: 'e', connectHover: route.hot.id, connectPreview: route, edgePreview: null }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, ui, null)
  const rings = byClass(tree, 'drawai-hot-ring')
  ok(rings.length === 1, '恰好一个吸附环')
  const hot = byClass(tree, 'drawai-node-hot')
  ok(hot.length === 1, '恰好一个节点被标成高亮')
  ok(hot[0].props['data-node-id'] === 'b', '高亮的是目标节点 b（实际 ' + hot[0].props['data-node-id'] + '）')
  // 环必须包住 b 的形状，而不是画在别处。
  const ring = rings[0]
  const g = geometry.byId.b.geo
  ok(
    ring.props.x === g.x - 6 && ring.props.y === g.y - 6 && ring.props.width === g.w + 12 && ring.props.height === g.h + 12,
    '吸附环贴着 b 的形状（外扩 6px）',
  )
  // 吸附时折线终点在 b 的边框上，指针在框外 —— 收尾线必须把这一段补上。
  ok(byClass(tree, 'drawai-preview-tip').length === 1, '吸附时仍有收尾线接向指针')
  const previews = byClass(tree, 'drawai-preview')
  const path = previews.filter((n) => n.type === 'path')[0]
  ok(path.props.d.indexOf('NaN') < 0, '吸附态的预览折线 d 合法')
}

console.log('\n改接端点：预览折线 + 目标亮环')
{
  const doc2 = { nodes: doc.nodes, edges: doc.edges }
  const geo2 = internals.buildGeometry(doc2)
  const cursor = { x: 120, y: 420 }
  const routed = internals.edgePreviewRoute(doc2, geo2, doc2.edges[0], 'to', cursor, internals.HOT_PAD)
  const ui = { selectedIds: ['e1'], connectFrom: null, connectTo: null, connectSide: 'e', connectHover: null, edgePreview: Object.assign({ edgeId: 'e1', kind: 'to', x: cursor.x, y: cursor.y }, routed) }
  const tree = renderDiagram(doc2, 'light', 'u1', { current: null }, ui, null)
  const paths = byClass(tree, 'drawai-preview').filter((n) => n.type === 'path')
  ok(paths.length === 1, '改接端点时渲染出一条预览折线')
  ok(typeof paths[0].props.d === 'string' && paths[0].props.d.indexOf('NaN') < 0, '改接预览折线 d 合法：' + paths[0].props.d)
  ok(byClass(tree, 'drawai-hot-ring').length === 1, '改接时目标节点亮环')
  const hot = byClass(tree, 'drawai-node-hot')
  ok(hot.length === 1 && hot[0].props['data-node-id'] === routed.hot.id, '亮的是吸附到的那个节点（' + (hot[0] && hot[0].props['data-node-id']) + '）')
}

console.log('\n退化兜底：路由给不出折线时，预览也不能消失')
{
  // 故意传一个残缺的 connectPreview，模拟路由失败。
  const ui = { selectedIds: ['a'], connectFrom: 'a', connectTo: { x: 300, y: 40 }, connectSide: 'e', connectHover: null, connectPreview: null, edgePreview: null }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, ui, null)
  const paths = byClass(tree, 'drawai-preview').filter((n) => n.type === 'path')
  ok(paths.length === 1, '没有路由结果时退化成直线预览（仍在渲染）')
  ok(typeof paths[0].props.d === 'string' && paths[0].props.d.indexOf('NaN') < 0, '兜底直线 d 合法')
}

console.log('\n端点标记：拖到节点附近要画出四个端点，并高亮将连接的那个')
{
  /** 某个节点 <g> 里的端点标记。 */
  const anchorsOf = (tree, nodeId) => {
    const groups = walk(tree, (n) => n.type === 'g' && n.props['data-node-id'] === nodeId, [])
    if (groups.length === 0) return []
    return walk(groups[0].children, (n) => typeof n.props.className === 'string' && n.props.className.indexOf('drawai-anchor') >= 0, [])
  }
  const d4 = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60, label: 'A' },
      { id: 'b', x: 400, y: 300, w: 160, h: 60, label: 'B' },
    ],
    edges: [],
  }
  const g4 = internals.buildGeometry(d4)
  const bGeo = g4.byId.b.geo
  const bAnchors = internals.anchorSidesOf(bGeo)

  // 没有在拖拽：不该有任何端点标记（不然图上会一直挂着四个点，很吵）。
  const idle = renderDiagram(d4, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  ok(anchorsOf(idle, 'b').length === 0, '没在拖拽时不显示端点标记')

  // 指针停在 b 的每个端点近旁：四个端点都要画出来，且恰好一个高亮。
  for (const side of internals.SIDES) {
    const a = bAnchors[side]
    const cursor = { x: a.x + (side === 'e' ? 14 : side === 'w' ? -14 : 0), y: a.y + (side === 's' ? 14 : side === 'n' ? -14 : 0) }
    const route = internals.routePreviewFor(d4, g4, cursor, 'a', g4.byId.a.geo, { from: 'a', side: 'e' }, internals.HOT_PAD, 'a')
    const ui = { selectedIds: ['a'], connectFrom: 'a', connectTo: cursor, connectSide: 'e', connectHover: 'b', connectPreview: route, edgePreview: null }
    const tree = renderDiagram(d4, 'light', 'u1', { current: null }, ui, null)
    const marks = anchorsOf(tree, 'b')
    const on = marks.filter((n) => n.props.className.indexOf('drawai-anchor-on') >= 0)
    // 高亮那个必须是用户看到的那个端点，且坐标就是该端点。
    const hit = on.length === 1 && Math.abs(on[0].props.cx - a.x) < 0.51 && Math.abs(on[0].props.cy - a.y) < 0.51
    ok(marks.length === 4 && on.length === 1, '指针靠 ' + side + '：四个端点都画出、恰好一个高亮')
    ok(hit, '指针靠 ' + side + '：高亮的就是 ' + side + ' 这个端点（' + (on[0] ? on[0].props.cx + ',' + on[0].props.cy : '无') + '）')
    ok(marks.every((n) => n.props.className.indexOf('drawai-anchor') >= 0), '端点标记带 drawai-anchor 类（CSS 里设了 pointer-events:none）')
  }

  // 改接端点时同样要显示（用的是 edgePreview.side）。
  const routed = internals.edgePreviewRoute({ nodes: d4.nodes, edges: [{ id: 'e1', from: 'a', to: 'b' }] }, internals.buildGeometry({ nodes: d4.nodes, edges: [] }), { id: 'e1', from: 'a', to: 'b' }, 'to', bAnchors.w, internals.HOT_PAD)
  const d5 = { nodes: d4.nodes, edges: [{ id: 'e1', from: 'a', to: 'b' }] }
  const ui5 = { selectedIds: ['e1'], connectFrom: null, connectTo: null, connectSide: 'e', connectHover: null, edgePreview: Object.assign({ edgeId: 'e1', kind: 'to', x: bAnchors.w.x, y: bAnchors.w.y }, routed) }
  const tree5 = renderDiagram(d5, 'light', 'u1', { current: null }, ui5, null)
  const marks5 = anchorsOf(tree5, 'b')
  const on5 = marks5.filter((n) => n.props.className.indexOf('drawai-anchor-on') >= 0)
  ok(marks5.length === 4 && on5.length === 1, '改接端点时也显示四个端点（选中 ' + routed.side + '）')
}

console.log('\n连线的画法：style 键（dashed / dashPattern / endArrow / strokeColor / rounded）')
{
  /** 取第 n 条边的可见 path（跳过 drawai-edge-hit 命中层）。 */
  const edgePaths = (tree) => walk(tree, (n) => n.type === 'path' && typeof n.props.d === 'string' && n.props.className !== 'drawai-edge-hit', [])
  /**
   * 造一条边并取它的可见 path props。
   * keys 是**drawio 的 style 键**（与文档里的写法完全一致）—— v1 的 dash/arrow/color 字段已不存在，
   * 那些只是宿主工具层的糖，落盘前就翻成了这里的键。
   */
  const styled = (keys) => {
    const style = stylePatch(DEFAULT_EDGE_STYLE, keys === undefined ? {} : keys)
    const d2 = { nodes: doc.nodes, edges: [{ id: 'e1', from: 'a', to: 'b', style: style }] }
    const tree = renderDiagram(d2, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
    const paths = edgePaths(tree)
    return paths.length === 0 ? null : paths[paths.length - 1].props
  }

  const solid = styled({})
  ok(solid !== null, '默认边渲染出来了')
  ok(solid.strokeDasharray === undefined, '默认实线不写 strokeDasharray')
  ok(typeof solid.markerEnd === 'string' && solid.markerEnd.indexOf('arrow') >= 0, '默认末端有箭头（缺省样式里显式写着 endArrow=classic）')
  ok(solid.markerStart === undefined, '默认起点没有箭头')

  ok(styled({ dashed: '1' }).strokeDasharray === '3 3', 'dashed=1 → 用 drawio 画布缺省的 3 3')
  ok(styled({ dashed: '1', dashPattern: '1 2' }).strokeDasharray === '1 2', '点线就是 dashed=1 + dashPattern=1 2')
  ok(styled({ dashed: '1', dashPattern: '8 8' }).strokeDasharray === '8 8', 'dashPattern 覆盖缺省（虚线间距也是文档的一部分）')
  ok(styled({ dashed: '0', dashPattern: '8 8' }).strokeDasharray === undefined, 'dashed=0 不算虚线（只有 =1 才是）')

  const both = styled({ startArrow: 'classic' })
  ok(both.markerEnd !== undefined && both.markerStart !== undefined && both.markerEnd !== both.markerStart, 'endArrow + startArrow → 两端都有箭头，且用的是两个不同 marker')
  const noArrow = styled({ endArrow: 'none' })
  ok(noArrow.markerEnd === undefined && noArrow.markerStart === undefined, 'endArrow=none → 末端没箭头')
  const bare = styled({ endArrow: null })
  ok(bare.markerEnd === undefined && bare.markerStart === undefined, '键缺省 = 不画箭头（drawio 的 mxConnector 语义：缺省就是 NONE）')
  const startOnly = styled({ endArrow: null, startArrow: 'classic' })
  ok(startOnly.markerEnd === undefined && startOnly.markerStart !== undefined, '只有 startArrow → 只有起点有箭头')

  ok(styled({ strokeColor: '#b85450' }).stroke === '#b85450', 'strokeColor 覆盖默认线色')
  ok(styled({}).stroke !== '#b85450', '未指定 strokeColor 时跟随主题')
  ok(styled({ rounded: '1' }).d !== styled({ rounded: '0' }).d, 'rounded=1 与 rounded=0 的折角画法不同（drawio 缺省是直角）')
  // 默认省略的等价性：显式删键、与从未写过这个键，渲染必须一模一样。
  ok(styled({ dashed: null, dashPattern: null }).d === solid.d && styled({ dashed: null }).stroke === solid.stroke, '显式删键与从未写过键渲染完全一致（默认省略的语义）')

  // 选中态压过自定义颜色（选中反馈必须看得见，不能被边的配色盖掉）。
  const d3 = { nodes: doc.nodes, edges: [{ id: 'e1', from: 'a', to: 'b', style: stylePatch(DEFAULT_EDGE_STYLE, { strokeColor: '#b85450' }) }] }
  const tree3 = renderDiagram(d3, 'light', 'u1', { current: null }, { selectedIds: ['e1'] }, null)
  const sel = edgePaths(tree3)
  ok(sel[sel.length - 1].props.stroke === '#1a73e8', '选中时用选中色，而不是边的自定义色')
  ok(sel[sel.length - 1].props.strokeDasharray === undefined, '选中不改线型')

  // 起点箭头的 marker 必须在 defs 里真的存在，否则 SVG 会静默不画（最难查的一种"没反应"）。
  const tree4 = renderDiagram({ nodes: doc.nodes, edges: [{ id: 'e1', from: 'a', to: 'b', style: stylePatch(DEFAULT_EDGE_STYLE, { startArrow: 'classic' }) }] }, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const markers = walk(tree4, (n) => n.type === 'marker', [])
  const ids = markers.map((m) => m.props.id)
  const refs = []
  for (const p of edgePaths(tree4)) {
    if (typeof p.props.markerStart === 'string') refs.push(p.props.markerStart)
    if (typeof p.props.markerEnd === 'string') refs.push(p.props.markerEnd)
  }
  const allDefined = refs.every((ref) => {
    const id = /#([^)]+)\)/.exec(ref)
    return id !== null && ids.indexOf(id[1]) >= 0
  })
  ok(markers.length >= 2 && allDefined, 'markerStart/markerEnd 引用的 marker 都在 defs 里存在（' + ids.join(', ') + '）')
}

console.log('\n对齐 / 分布：computeAlignMoves 的坐标')
{
  const g = internals.GRID
  // 故意用不整齐的坐标（不是 10 的倍数），逼出 snap 行为。
  const d = {
    nodes: [
      { id: 'a', x: 13, y: 107, w: 100, h: 40 },
      { id: 'b', x: 233, y: 51, w: 60, h: 80 },
      { id: 'c', x: 97, y: 301, w: 140, h: 20 },
      { id: 'other', x: 999, y: 999, w: 10, h: 10 },
    ],
    edges: [],
  }
  const ids = ['a', 'b', 'c']
  const val = (moves, id) => (moves[id] === undefined ? null : moves[id].value)
  const axis = (moves, id) => (moves[id] === undefined ? null : moves[id].axis)

  const left = internals.computeAlignMoves(d, ids, 'left', g)
  ok(val(left, 'a') === 10 && val(left, 'b') === 10 && val(left, 'c') === 10, '左对齐：三个都贴到最左（13→10，snap 过）')
  ok(axis(left, 'a') === 'x', '左对齐只动 x')
  ok(left.other === undefined, '没选中的节点不动')

  const right = internals.computeAlignMoves(d, ids, 'right', g)
  // 最右边缘 = max(a.x+a.w=113, b.x+b.w=293, c.x+c.w=237) = 293
  ok(val(right, 'a') === 190 && val(right, 'b') === 230 && val(right, 'c') === 150, '右对齐：右边缘都贴到 293（减去各自宽度后 snap）')

  const centerX = internals.computeAlignMoves(d, ids, 'centerX', g)
  // 真正的语义是"每个节点的中心都落到外接框中心的**吸附值**上"；
  // 因为最后一步 snap 是对左上角坐标做的，各节点中心会差在半个网格内 ——
  // 拿未 snap 的中心去逐像素比是错的，要按网格容差比。
  const targetCenter = Math.round(((13 + 293) / 2) / g) * g
  const centers = { a: val(centerX, 'a') + 50, b: val(centerX, 'b') + 30, c: val(centerX, 'c') + 70 }
  const withinHalfGrid = Object.keys(centers).every((k) => Math.abs(centers[k] - targetCenter) <= g / 2)
  ok(withinHalfGrid, '水平居中：三个节点的中心都落到外接框中心（' + targetCenter + '，容差半格）：' + JSON.stringify(centers))
  ok(val(centerX, 'c') === 80, '水平居中：最宽的那个挪得最多（c 140 宽 → 80）')

  const top = internals.computeAlignMoves(d, ids, 'top', g)
  ok(val(top, 'a') === 50 && val(top, 'b') === 50 && val(top, 'c') === 50, '顶对齐：都贴到最上（51→50）')
  ok(axis(top, 'a') === 'y', '顶对齐只动 y')

  const bottom = internals.computeAlignMoves(d, ids, 'bottom', g)
  // 最下边缘 = max(147, 131, 321) = 321
  ok(val(bottom, 'a') === 280 && val(bottom, 'b') === 240 && val(bottom, 'c') === 300, '底对齐：下边缘都贴到 321')

  const dx = internals.computeAlignMoves(d, ids, 'distributeX', g)
  // x 排序 a(13) c(97) b(233)：首尾钉住，中间那个落到 (13+233)/2 = 123
  ok(val(dx, 'c') === 120, '水平等距：中间节点落到首尾中点（123→120）')
  ok(dx.a === undefined && dx.b === undefined, '水平等距：首尾钉住不动')

  const dy = internals.computeAlignMoves(d, ids, 'distributeY', g)
  // y 排序 b(51) a(107) c(301)：中间那个落到 (51+301)/2 = 176
  ok(val(dy, 'a') === 180, '垂直等距：中间节点落到首尾中点（176→180）')
  ok(axis(dy, 'a') === 'y', '垂直等距只动 y')

  // 边界：少于 2 个 / 少于 3 个。
  ok(Object.keys(internals.computeAlignMoves(d, ['a'], 'left', g)).length === 0, '只选 1 个 → 不动（无需对齐）')
  ok(Object.keys(internals.computeAlignMoves(d, ['a', 'b'], 'distributeX', g)).length === 0, '只选 2 个 → 拒绝分布（没有间距可均分）')
  ok(Object.keys(internals.computeAlignMoves(d, ['a', 'b'], 'left', g)).length === 2, '只选 2 个 → 对齐仍然有效')
  ok(Object.keys(internals.computeAlignMoves(d, ids, 'nonsense', g)).length === 0, '未知 kind → 返回空表（不误动坐标）')
  // 幂等：对齐过的结果再对齐一次不该再动（否则会看到"点了对齐它还在挪"）。
  const once = internals.computeAlignMoves(d, ids, 'left', g)
  const d2 = { nodes: d.nodes.map((n) => (once[n.id] === undefined ? n : Object.assign({}, n, { x: once[n.id].value }))), edges: [] }
  const twice = internals.computeAlignMoves(d2, ids, 'left', g)
  ok(Object.keys(twice).every((id) => twice[id].value === once[id].value), '重复左对齐是幂等的（不会持续漂移）')
}

console.log('\n空画布必须可渲染（"新建"出来的第一屏就是它）')
{
  // 这里曾经有个真 bug：把"0 个节点"判成错误，于是新建出来的空画布
  // 一进去就是红字「文档里没有可渲染的 nodes」，右键也点不了 —— 等于新建功能废掉。
  //
  // 载体换成 .drawio 之后，客户端不再自己解析文件（mxfile 可能被 drawio 压过，
  // 浏览器没有 zlib），改由宿主读、客户端只校验**宿主的响应载荷**。
  const payloadOf = (doc) => ({ ok: true, exists: true, revision: '', doc: doc, notes: [] })
  const empty = internals.docFromPayload(payloadOf({ nodes: [], edges: [] }))
  ok(empty.error === undefined && empty.doc.nodes.length === 0, '空文档读回空画布而不是错误')
  ok(internals.docFromPayload({ ok: true, exists: false, doc: null, notes: [] }).created === true, '文件还不存在 → 当作待创建的空画布')
  // 该报错的还得报错：载荷不是画布文档时不能静默当空画布（否则会把别的东西当成白纸盖掉）。
  ok(internals.docFromPayload({ ok: false, error: '读不出来' }).error !== undefined, '宿主报错 → 客户端报错')
  ok(internals.docFromPayload({ ok: true, exists: true, doc: [] }).error !== undefined, 'doc 是数组 → 报错')
  ok(internals.docFromPayload(payloadOf({ nodes: 'nope', edges: [] })).error !== undefined, 'nodes 不是数组 → 报错')
  ok(internals.docFromPayload(null).error !== undefined, '响应不是对象 → 报错')

  // 空画布要能真的画出来（不抛错、也不是空字符串）。
  const tree = internals.renderDiagram({ nodes: [], edges: [] }, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  ok(tree !== null && tree.type === 'svg', '空画布渲染出 svg（网格纸还在，可以右键加节点）')
}

console.log('\n空舞台：不造"幽灵空文档"；而空画布文件本身仍能渲染')
{
  // 需求：打开 drawai 画布后应该为空（零标签），而不是直接冒出一张未绑定画布。
  // 于是"没有文件"时不再就地造一份本地空文档 —— 屏幕上不该出现一张没有对应文件的图。
  const src = readFileSync(source, 'utf8')
  ok(!/const blank = \{ version: 2/.test(src), '空舞台不再就地造本地空文档')
  ok(/kind: 'empty'/.test(src), '空舞台是一个显式状态')
  ok(/还没有打开画布/.test(src), '空舞台给出"还没有打开画布"的提示')
  // 但一个**合法的空画布文件**（nodes/edges 都是空数组）仍然要能渲染出来。
  const blank = internals.docFromPayload({ ok: true, exists: true, doc: { nodes: [], edges: [] }, revision: '', notes: [] })
  ok(blank.error === undefined, '空文档解析通过')
  const tree = internals.renderDiagram(blank.doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  ok(tree !== null && tree.type === 'svg', '空画布渲染出可交互的网格纸（右键加节点）')
}

console.log('\n空画布的视口要合理（曾经是 185% 这种荒唐值）')
{
  // 空画布的外接框是 1×1 的退化值，按它算出来视口只有几十单位宽 ——
  // 状态栏显示"缩放 185%"，一点滚轮就飞出可视区。
  const empty = internals.contentBounds({ nodes: [], edges: [] })
  for (const aspect of [0.5, 1, 2.2]) {
    const v = internals.computeFitView(empty, aspect)
    ok(v.w >= 400 && v.w <= 4000, '空画布 aspect=' + aspect + ' 的视口宽度合理（w=' + v.w + '）')
  }
  // 有内容时必须还是"贴合内容"，不能因为上面那条兜底被写死。
  const doc = { nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60 }, { id: 'b', x: 400, y: 300, w: 160, h: 60 }], edges: [] }
  const v = internals.computeFitView(internals.contentBounds(doc), 1)
  ok(v.w < 900, '有内容的画布仍然贴合内容（w=' + v.w + '）')
  ok(v.x < 0 && v.y < 0, '有内容时视口覆盖内容外接框')
}

console.log('\n多画布标签页：同一文件不重复开')
{
  let list = [{ key: 'tab:a.drawio', path: 'a.drawio' }]
  const open = (path) => {
    const r = internals.openTabIn(list, path)
    list = r.tabs
    return r.active
  }
  ok(open('b.drawio') === 'tab:b.drawio' && list.length === 2, '打开新文件 → 新开一个标签')
  ok(open('a.drawio') === 'tab:a.drawio' && list.length === 2, '重复打开已开的文件 → 只切过去，不新开')
  ok(open('A.DRAWIO') === 'tab:a.drawio' && list.length === 2, '大小写不同视为同一个文件（Windows 路径）')
  const before = list.length
  ok(open(undefined) === null && list.length === before, '非法路径（undefined）不会造出垃圾标签')
  ok(open('') === null && list.length === before, '空字符串同样被挡掉')

  // 标签名：取文件名。空路径给一个中性名字 —— 已经没有"未绑定"这种状态了。
  ok(internals.tabLabelOf('sub/b.drawio') === 'b.drawio', '文件标签取文件名（含子目录路径）')
  ok(internals.tabLabelOf('') === '画布', '空路径给中性名字（不再有"(未绑定)"）')
}

console.log('\n布局：不许依赖 height:100% 这条脆链子')
{
  // 这里连续出过两次"画布没高度"（先是只占上方一小条，后来整块消失），根因同一个：
  // `height:100%` 要求父级有**确定高度**，而宿主给的容器不保证这一点。
  // 现在改成绝对定位铺满（inset:0），只依赖"祖先里有定位元素"，而那是我们自己的 .drawai-pane。
  const css = readFileSync(source, 'utf8')
  const wrap = /\.drawai-tabs-wrap\{([^}]*)\}/.exec(css)
  const root = /\.drawai-root\{([^}]*)\}/.exec(css)
  const pane = /\.drawai-pane\{([^}]*)\}/.exec(css)
  const panes = /\.drawai-panes\{([^}]*)\}/.exec(css)
  ok(wrap !== null && /position:absolute/.test(wrap[1]) && /bottom:0/.test(wrap[1]), '.drawai-tabs-wrap 用绝对定位铺满（不靠 flex:1）')
  ok(root !== null && /position:absolute/.test(root[1]) && /bottom:0/.test(root[1]), '.drawai-root 用绝对定位铺满（不靠 height:100%）')
  ok(root !== null && !/height:100%/.test(root[1]), '.drawai-root 不再依赖 height:100%')
  ok(pane !== null && /position:absolute/.test(pane[1]), '.drawai-pane 绝对定位铺满面板')
  ok(panes !== null && /position:relative/.test(panes[1]), '.drawai-panes 是定位上下文（绝对定位子元素要有参照）')
}

console.log('\n标签条只能有一份，且只由活动窗格渲染')
{
  // 曾经同时有两条渲染路径：CanvasTabs 里渲染一份，又通过 tabBar prop 让 CanvasView 渲染第二份，
  // 于是界面上出现两条一模一样的标签栏。现在：**只在一处构造**（源码里一处），
  // 并且只交给活动窗格渲染（DOM 里也只有一份）。
  const src = readFileSync(source, 'utf8')
  const marks = [...src.matchAll(/className: 'drawai-tabs'/g)]
  ok(marks.length === 1, "源码里只有一处构建标签条（className: 'drawai-tabs' 出现 " + marks.length + " 次）")
  ok(/tabStrip: isActive \? tabBar : null/.test(src), '标签条只交给活动窗格')
  ok(!/props\.tabBar/.test(src), '没有第二套 tabBar 传递路径')
}

console.log('\n层级：工作栏在标签页之上，菜单挂在 root 上')
{
  // 右栏窄：'对当前画布做什么'（工作栏）要一直在最上面，'现在看哪张'（标签条）在它下面。
  const src = readFileSync(source, 'utf8')
  const rootStart = src.indexOf("className: 'drawai-root'")
  const rootEnd = src.indexOf("className: 'drawai-note'", rootStart)
  const block = rootStart >= 0 && rootEnd > rootStart ? src.slice(rootStart, rootEnd) : ''
  const iHead = block.indexOf('head,')
  const iStrip = block.indexOf('props.tabStrip')
  const iBody = block.indexOf('body,')
  ok(iHead >= 0 && iStrip > iHead && iBody > iStrip, '渲染顺序是 工作栏 → 标签条 → 画布（' + iHead + ' / ' + iStrip + ' / ' + iBody + '）')
  // 菜单/面板挂在 root 上（不在画布里）：插进标签条之后，按画布算的坐标会变成负数而被裁掉。
  const posFn = /function menuPosFor\(key\) \{[\s\S]*?\n  \}/.exec(src)
  ok(posFn !== null && /rootRef\.current/.test(posFn[0]), 'menuPosFor 量的是 root（定位上下文）')
  ok(/renderDocMenu\(\),/.test(block), '工具条下拉与文件面板挂在 root 的子树里')
}

console.log('\n地址解析：要认得出绝对路径（否则 tab 永久停在"未绑定"）')
{
  // 原来只认 dsh-resource://file/session/<id>/<rel>，其余一律 undefined。
  // 而地址实际还可能是别的形式（用户那个 tab 就解析不出来 → 永久"(未绑定)"，
  // 屏幕空白、AI 却会去改 demo.drawio）。现在按形式逐个处理。
  const cases = [
    ['dsh-resource://file/session/abc/demo.drawio', 'demo.drawio'],
    ['dsh-resource://file/demo.drawio', 'demo.drawio'],
    ['file:///D:/ws/a.drawio', 'D:/ws/a.drawio'],
    ['/D:/ws/a.drawio', 'D:/ws/a.drawio'],
    ['D:\\ws\\a.drawio', 'D:/ws/a.drawio'],
    ['D:/ws/sub/a.drawio', 'D:/ws/sub/a.drawio'],
    ['dsh-resource://file/session/abc/', undefined],
    ['', undefined],
  ]
  for (const [addr, want] of cases) {
    const got = internals.pathFromAddress(addr)
    ok(got === want, JSON.stringify(addr) + ' → ' + JSON.stringify(got))
  }
  ok(internals.pathFromAddress(undefined) === undefined, 'undefined 地址不炸')
}

console.log('\n「打开」不能关掉或覆盖其他画布')
{
  const openTabIn = internals.openTabIn
  const names = (l) => l.map((t) => t.path.split(/[\\/]/).pop())
  let list = [
    { key: 'tab:D:/ws/demo.drawio', path: 'D:/ws/demo.drawio' },
    { key: 'tab:D:/ws/bfs.drawio', path: 'D:/ws/bfs.drawio' },
  ]
  const baseline = names(list)
  let vanished = 0
  const open = (p) => {
    const before = names(list)
    const r = openTabIn(list, p)
    list = r.tabs
    // 打开操作**绝不允许**让任何已开着的画布消失
    for (const n of before) if (names(list).indexOf(n) < 0) vanished += 1
  }
  open('D:/ws/demo.drawio') // 已开着 → 切过去
  open('D:/ws/new.drawio') // 没开过 → 新增
  open('D:/ws/new.drawio') // 重复 → 不重复开
  open('D:/WS/NEW.drawio') // 大小写不同 → 仍是同一个
  open('D:\\ws\\new.drawio') // 分隔符不同 → 仍是同一个
  open('D:/ws/third.drawio') // 另一个新文件

  ok(vanished === 0, '6 次打开都没有让已开画布消失')
  for (const n of baseline) ok(names(list).indexOf(n) >= 0, '原有画布仍在：' + n)
  const seg = names(list).filter((n) => n.toLowerCase() === 'new.drawio')
  ok(seg.length === 1, '大小写/分隔符不同的同一路径只占一个标签（实际 ' + seg.length + ' 个）')
  ok(names(list).length === 4, '标签总数 = 2 原有 + new + third = 4（实际 ' + names(list).length + '）')
  // 移除标签只有一条路径：closeTab（标签上的 × 按钮）
  const srcText = readFileSync(source, 'utf8')
  ok(/const next = tabs\.filter\(\(t\) => t\.key !== key\)/.test(srcText), '移除标签只发生在 closeTab（× 按钮）里')
}
console.log('\n适应内容：居中、覆盖，且缩放锚点不漂移')
{
  const doc = {
    nodes: [
      { id: 'a', x: 100, y: 200, w: 160, h: 60 },
      { id: 'b', x: 700, y: 900, w: 160, h: 60 },
    ],
    edges: [],
  }
  const b = internals.contentBounds(doc)
  const ccx = (b.minX + b.maxX) / 2
  const ccy = (b.minY + b.maxY) / 2
  // 各种容器宽高比（右栏窄高 = 小 aspect）：视野中心必须始终等于内容中心
  for (const aspect of [0.4, 1, 3]) {
    const v = internals.computeFitView(b, aspect)
    const centered = Math.abs(v.x + v.w / 2 - ccx) < 0.01 && Math.abs(v.y + v.h / 2 - ccy) < 0.01
    const covers = v.x <= b.minX + 0.01 && v.y <= b.minY + 0.01 && v.x + v.w >= b.maxX - 0.01 && v.y + v.h >= b.maxY - 0.01
    ok(centered, 'aspect=' + aspect + ' 时内容居中')
    ok(covers, 'aspect=' + aspect + ' 时内容完整可见')
  }
  // computeFitView 必须**返回 h**：调用方再拿 w*aspect 推一次就成了两处算法，中心会不一致
  ok(typeof internals.computeFitView(b, 1).h === 'number', 'computeFitView 返回 h（视野矩形只在一处算）')
  const empty = internals.computeFitView(internals.contentBounds({ nodes: [], edges: [] }), 1)
  ok(empty.w >= 400 && empty.h >= 400, '空画布给的是合理视口（不是退化值）')

  // 容器尺寸变化（拖右栏）：**缩放比例不变、宽高比跟着容器走** ——
  // 这两条一起修掉"拖侧边栏时画布跟着缩放 + 内容畸形"。
  const before = { x: 100, y: 50, w: 800, h: 600 }
  const sizes = [
    [{ w: 800, h: 600 }, { w: 500, h: 600 }], // 右栏被拖窄
    [{ w: 800, h: 600 }, { w: 1200, h: 600 }], // 拖宽
    [{ w: 500, h: 900 }, { w: 500, h: 400 }], // 只改高度
  ]
  let rescaled = 0
  let distorted = 0
  let moved = 0
  for (const [prevSize, nextSize] of sizes) {
    const next = internals.resizeViewFor(before, prevSize, nextSize)
    if (next === null) {
      distorted += 1
      continue
    }
    const scaleBefore = prevSize.w / before.w
    const scaleAfter = nextSize.w / next.w
    if (Math.abs(scaleBefore - scaleAfter) > 1e-9) rescaled += 1
    if (Math.abs(next.h / next.w - nextSize.h / nextSize.w) > 1e-9) distorted += 1
    if (next.x !== before.x || next.y !== before.y) moved += 1
  }
  ok(rescaled === 0, '容器尺寸变化后缩放比例不变（内容不会跟着放大缩小）')
  ok(distorted === 0, '视口宽高比始终等于容器宽高比（preserveAspectRatio=none 不会拉伸变形）')
  ok(moved === 0, '视野左上角不动（拖动过程中画面不会漂移）')
  ok(internals.resizeViewFor(null, { w: 800, h: 600 }, { w: 500, h: 600 }) === null, '还没有视口时不折算（交给自适应）')
  ok(internals.resizeViewFor(before, { w: 0, h: 0 }, { w: 500, h: 600 }) === null, '尺寸还没量到时（0）不折算')
  ok(internals.resizeViewFor(before, { w: 800, h: 600 }, { w: 0, h: 0 }) === null, '新尺寸是 0 时不折算（隐藏的标签页）')

  // 锚点缩放：滚轮手感的关键 —— 锚点前后必须停在同一位置
  const current = { x: 0, y: 0, w: 800, h: 600 }
  let drifted = 0
  for (const anchor of [{ x: 200, y: 150 }, { x: 400, y: 300 }, { x: 790, y: 590 }]) {
    for (const factor of [0.8, 1.25, 2]) {
      const next = internals.zoomViewAt(current, anchor, factor)
      if (
        Math.abs((anchor.x - current.x) / current.w - (anchor.x - next.x) / next.w) > 1e-9 ||
        Math.abs((anchor.y - current.y) / current.h - (anchor.y - next.y) / next.h) > 1e-9
      ) {
        drifted += 1
      }
    }
  }
  ok(drifted === 0, '9 组（3 锚点 × 3 倍率）缩放锚点都不漂移')
  const z = internals.zoomViewAt(current, { x: 100, y: 100 }, 1.7)
  ok(Math.abs(z.h / z.w - current.h / current.w) < 1e-9, '缩放时宽高比不变（否则画面整体位移）')

  // 视口高度必须**存下来**，不能每帧按容器宽高比现算 —— 那正是"元素突变位置"的根因
  const srcText = readFileSync(source, 'utf8')
  ok(!/viewOverride\.w \* aspect/.test(srcText), '不再按 viewOverride.w * aspect 现算高度')
  // 用函数体 + 包含判断，别用正则数嵌套（那行很长，我在这儿跟正则较劲了三次）
  const bodyOf = (name) => {
    const start = srcText.indexOf('function ' + name + '(')
    if (start < 0) return ''
    const open = srcText.indexOf('{', start)
    let depth = 0
    for (let i = open; i < srcText.length; i += 1) {
      if (srcText[i] === '{') depth += 1
      else if (srcText[i] === '}') {
        depth -= 1
        if (depth === 0) return srcText.slice(open, i + 1)
      }
    }
    return ''
  }
  const moveBody = bodyOf('onCanvasPointerMove')
  ok(moveBody.length > 0 && /h: pan\.h/.test(moveBody), '平移写入 h（pan.h）')
  const wheelBody = srcText.slice(srcText.indexOf('function onWheel('), srcText.indexOf('function onWheel(') + 900)
  ok(/zoomViewAt\(current, point, factor\)/.test(wheelBody), '滚轮缩放走 zoomViewAt（锚点数学在纯函数里）')
  ok(/h: current\.h,/.test(srcText), 'panRef 记下了当前高度')
}

console.log('\n文本与直线：fontSize / fontColor / whiteSpace / edgeStyle=none')
{
  const textOf = (tree) => walk(tree, (n) => n.type === 'text', [])[0]
  const lineCount = (el) => {
    if (el === undefined || el === null) return -1
    const first = el.children[0]
    return Array.isArray(first) ? first.length : el.children.length
  }
  const twoNodes = [
    { id: 'a', x: 0, y: 0, w: 120, h: 60 },
    { id: 'b', x: 400, y: 300, w: 120, h: 60 },
  ]
  const edgePathOf = (tree) =>
    walk(tree, (n) => n.type === 'path' && n.props.pointerEvents === 'none' && typeof n.props.d === 'string', [])[0]

  // fontSize / fontColor：标签的画法也是文档的一部分
  const styled = renderDiagram(
    { nodes: [{ id: 'a', x: 0, y: 0, w: 200, h: 60, label: '大字号', style: 'fontSize=22;fontColor=#b85450;' }], edges: [] },
    'light',
    'u1',
    { current: null },
    { selectedIds: [] },
    null,
  )
  const labelEl = textOf(styled)
  ok(labelEl !== undefined && labelEl.props.fontSize === 22, 'fontSize 进入文档后真的驱动了标签字号（' + (labelEl === undefined ? '-' : labelEl.props.fontSize) + '）')
  ok(labelEl !== undefined && labelEl.props.fill === '#b85450', 'fontColor 驱动标签字色')

  // whiteSpace：缺省换行，nowrap 不换行（drawio 的语义）
  const longLabel = '这是一条很长很长很长很长很长很长的标签'
  const wrapped = renderDiagram({ nodes: [{ id: 'a', x: 0, y: 0, w: 120, h: 60, label: longLabel }], edges: [] }, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const nowrap = renderDiagram(
    { nodes: [{ id: 'a', x: 0, y: 0, w: 120, h: 60, label: longLabel, style: 'whiteSpace=nowrap;' }], edges: [] },
    'light',
    'u1',
    { current: null },
    { selectedIds: [] },
    null,
  )
  ok(lineCount(textOf(wrapped)) > 1, '缺省 whiteSpace 会按宽度换行（' + lineCount(textOf(wrapped)) + ' 行）')
  ok(lineCount(textOf(nowrap)) === 1, 'whiteSpace=nowrap 不换行')

  // edgeStyle=none = 直线；缺省（orthogonalEdgeStyle）走正交折线
  const straight = renderDiagram(
    { nodes: twoNodes, edges: [{ id: 'e1', from: 'a', to: 'b', style: stylePatch(DEFAULT_EDGE_STYLE, { edgeStyle: 'none' }) }] },
    'light',
    'u1',
    { current: null },
    { selectedIds: [] },
    null,
  )
  const ortho = renderDiagram(
    { nodes: twoNodes, edges: [{ id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE }] },
    'light',
    'u1',
    { current: null },
    { selectedIds: [] },
    null,
  )
  const straightPath = edgePathOf(straight)
  const orthoPath = edgePathOf(ortho)
  ok(straightPath !== undefined && straightPath.props.d.split('L').length === 2, 'edgeStyle=none 画成一条直线（只有两个点）')
  ok(orthoPath !== undefined && orthoPath.props.d.split('L').length > 2, '缺省 edgeStyle 走正交折线（多于两个点）')

  // ── 默认值绝不能被算成 0 ──
  // 这是**真机上踩过**的 bug：`Number(null) === 0` 且 0 是有限数，于是"取不到就用缺省"
  // 静默变成 0 —— fontSize=0 / strokeWidth=0，表现是"节点没有文字、连线完全看不见"，
  // 而且不报任何错。下面几条就是把这类回归钉死。
  const labelTextOf = (el) => {
    if (el === undefined || el === null) return ''
    const spans = Array.isArray(el.children[0]) ? el.children[0] : el.children
    return spans.map((s) => (s !== null && s !== undefined && Array.isArray(s.children) ? s.children.join('') : '')).join('')
  }
  const plainTree = renderDiagram(
    { nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60, label: '默认' }], edges: [] },
    'light',
    'u1',
    { current: null },
    { selectedIds: [] },
    null,
  )
  const plainText = textOf(plainTree)
  ok(plainText !== undefined && plainText.props.fontSize === 12, '缺省标签字号是 12px（不是 0）')
  ok(labelTextOf(plainText) === '默认', '缺省标签的文字确实在元素里（不是空串）')
  const plainRect = walk(plainTree, (n) => n.type === 'rect' && n.props.width === 160, [])[0]
  ok(plainRect !== undefined && plainRect.props.strokeWidth === 1, '缺省节点描边是 1px（不是 0）')
  const plainEdge = edgePathOf(
    renderDiagram({ nodes: twoNodes, edges: [{ id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE }] }, 'light', 'u1', { current: null }, { selectedIds: [] }, null),
  )
  ok(plainEdge !== undefined && plainEdge.props.strokeWidth === 1, '缺省连线是 1px 的可见线（不是 0）')

  // rounded=1 不带 arcSize → drawio 的 15% 圆角；写成 Number(null) 会得到 0（= 直角）
  const roundedTree = renderDiagram(
    { nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60, label: '', style: 'rounded=1;' }], edges: [] },
    'light',
    'u1',
    { current: null },
    { selectedIds: [] },
    null,
  )
  const roundedRect = walk(roundedTree, (n) => n.type === 'rect' && typeof n.props.rx === 'number' && n.props.rx > 0, [])[0]
  ok(roundedRect !== undefined && Math.abs(roundedRect.props.rx - 9) < 0.01, 'rounded=1 且缺省 arcSize → 15% 圆角（60 高的盒子 rx=9）')
}

console.log('\n悬空端：解析不丢边，渲染画得出来')
{
  const dangling = {
    version: 2,
    nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60 }],
    edges: [{ id: 'e1', from: 'a', targetPoint: { x: 500, y: 300 }, style: DEFAULT_EDGE_STYLE }],
  }
  const parsed = internals.docFromPayload({ ok: true, exists: true, revision: '', notes: [], doc: dangling })
  ok(parsed.error === undefined && parsed.doc.edges.length === 1, '带悬空端的边不会被丢掉（只有画布不认的边才会消失）')
  const tree = renderDiagram(parsed.error === undefined ? parsed.doc : { nodes: [], edges: [] }, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  // 只认**可见的连线 path**：命中层有 className，网格线没有 pointerEvents:none。
  const paths = walk(tree, (n) => n.type === 'path' && n.props.pointerEvents === 'none' && typeof n.props.d === 'string', [])
  ok(paths.length === 1 && paths[0].props.d.indexOf('NaN') < 0, '悬空端的边真的画出了一条合法路径（paths=' + paths.length + '，d=' + (paths.length > 0 ? String(paths[0].props.d).slice(0, 70) : '-') + '）')
}

console.log('\n自环：画得出一个真的环（不是一个点、也不是 NaN）')
{
  const loopDoc = {
    version: 2,
    nodes: [{ id: 'a', x: 40, y: 40, w: 160, h: 60 }],
    edges: [{ id: 'e1', from: 'a', to: 'a', label: '自己', style: 'edgeStyle=orthogonalEdgeStyle;exitX=1;exitY=0.5;entryX=0.5;entryY=0;' }],
  }
  const parsed = internals.docFromPayload({ ok: true, exists: true, revision: '', notes: [], doc: loopDoc })
  ok(parsed.error === undefined && parsed.doc.edges.length === 1, '自环不会被解析器丢掉（from === to 是合法的）')
  const tree = renderDiagram(parsed.doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const paths = walk(tree, (n) => n.type === 'path' && n.props.pointerEvents === 'none' && typeof n.props.d === 'string', [])
  const d = paths.length > 0 ? String(paths[0].props.d) : ''
  ok(paths.length === 1 && d.indexOf('NaN') < 0, '自环画出了一条合法路径（paths=' + paths.length + '，d=' + d.slice(0, 70) + '）')
  // 环必须真的绕出去：路径里至少有一个点在节点右/上边界之外。
  const pts = internals.edgeRoutePoints(parsed.doc, parsed.doc.edges[0])
  ok(
    Array.isArray(pts) && pts.some((p) => p.x > 40 + 160 + 0.01 || p.y < 40 - 0.01),
    '环绕到了节点外面（' + JSON.stringify(pts) + '）',
  )
  ok(Array.isArray(pts) && pts.length >= 4, '环有至少 4 个顶点（出边—折—回边）')
}

console.log('\n剪贴板：复制/粘贴的语义（id 不撞、折点不共享、只搬内部连线）')
{
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'n1', label: '一', style: 'fillColor=#dae8fc;', x: 0, y: 0, w: 130, h: 60 },
      { id: 'n2', label: '二', style: '', x: 200, y: 0, w: 130, h: 60 },
      { id: 'n3', label: '三', style: '', x: 400, y: 0, w: 130, h: 60 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: '内部', style: DEFAULT_EDGE_STYLE, points: [{ x: 165, y: 90 }] },
      { id: 'e2', from: 'n2', to: 'n3', label: '跨出去', style: DEFAULT_EDGE_STYLE },
      { id: 'e3', from: 'n1', to: 'n1', style: DEFAULT_EDGE_STYLE },
    ],
  }

  // 只选中 n1 / n2：e1（两端都在选区）该进来，e2（跨出去）不该。
  const clip = internals.collectClipboard(doc, ['n1', 'n2'])
  ok(clip !== null && clip.nodes.length === 2, '复制收了选中的两个节点')
  ok(
    clip !== null && clip.edges.length === 2 && clip.edges.map((e) => e.id).join(',') === 'e1,e3',
    '只收两端都在选区内的边（跨出去的 e2 不收；自环 e3 两端都在，收）',
  )
  // 深拷贝：改剪贴板里的折点不能动到原文档。
  clip.edges[0].points[0].x = 999
  ok(doc.edges[0].points[0].x === 165, '剪贴板里的折点是拷贝（改它不动原文档）')

  const clip2 = internals.collectClipboard(doc, ['n1', 'n2'])
  const pasted = internals.pasteInto(doc, clip2, 20, 20)
  ok(pasted !== null && pasted.doc.nodes.length === 5, '粘贴后节点数 +2（实际 ' + (pasted === null ? '-' : pasted.doc.nodes.length) + '）')
  const ids = pasted.doc.nodes.map((n) => n.id)
  ok(new Set(ids).size === ids.length, '节点 id 不撞车：' + ids.join(','))
  ok(pasted.doc.nodes.filter((n) => n.id === 'n4')[0].x === 20 && pasted.doc.nodes.filter((n) => n.id === 'n4')[0].y === 20, '粘贴的节点整体平移（+20,+20）')
  ok(pasted.doc.nodes.filter((n) => n.id === 'n4')[0].label === '一' && pasted.doc.nodes.filter((n) => n.id === 'n4')[0].style === 'fillColor=#dae8fc;', '标签与样式跟着走')
  const newEdge = pasted.doc.edges.filter((e) => e.id === 'e4')[0]
  ok(newEdge !== undefined && newEdge.from === 'n4' && newEdge.to === 'n5', '内部连线的两端被改写成新节点：' + (newEdge === undefined ? '-' : newEdge.from + '→' + newEdge.to))
  ok(newEdge !== undefined && newEdge.points[0].x === 185, '折点也跟着平移（165+20）')
  ok(doc.nodes.length === 3 && doc.edges.length === 3, '粘贴不改原文档（纯函数）')
  ok(pasted.ids.indexOf('n4') >= 0 && pasted.ids.indexOf('e4') >= 0, '返回新选中集（贴完接着能拖）')

  // 再贴一次：id 继续往后排，不会覆盖上一次贴出来的。
  const twice = internals.pasteInto(pasted.doc, clip2, 20, 20)
  ok(
    twice.doc.nodes.filter((n) => n.id === 'n6').length === 1 && twice.doc.edges.filter((e) => e.id === 'e6').length === 1,
    '连贴两次各自拿到新 id：' + twice.doc.nodes.map((n) => n.id).join(','),
  )

  // 没选中任何节点 → 没有可复制的（调用方据此提示，而不是静默无反应）。
  ok(internals.collectClipboard(doc, []) === null, '空选区复制不出东西')
  ok(internals.collectClipboard(doc, ['nope']) === null, '选了个不存在的 id 也复制不出东西')
  ok(internals.pasteInto(doc, null, 0, 0) === null, '空剪贴板粘不出东西')
}

console.log('\n短线段也要有可拖的段把手（每段一个，不能因为短就省略）')
{
  // 实测报过："短线段没有可移动的段点"。原来渲染时 `if (segLen < 26) continue` ——
  // 短段整段挪不动，而差几像素的台阶、贴边的引出段恰恰都是短段。
  // 造一条**确有短段**的边：两个节点只隔 10px，那条边就是一整段 10px。
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 170, y: 0, w: 160, h: 60 },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE }],
  }
  const pts = internals.edgeRoutePoints(doc, doc.edges[0])
  ok(Array.isArray(pts) && pts.length >= 2, '这条边算得出路径（实际 ' + (pts === null ? '-' : pts.length) + ' 个点）')
  const segLengths = []
  for (let i = 1; i < pts.length; i += 1) segLengths.push(Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y))
  const shortSegs = segLengths.filter((n) => n < 26).length
  ok(shortSegs > 0, '用例里确实存在短段（' + shortSegs + ' 段 < 26px：' + segLengths.map((n) => Math.round(n)).join(',') + '）')

  const pressed = []
  const ui = {
    selectedIds: ['e1'],
    onEdgeHandlePointerDown: (edgeId, kind, index) => pressed.push(kind + ':' + index),
  }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, ui, null)
  const handles = walk(tree, (n) => n.type === 'circle' && n.props.stroke === '#f2a900', [])
  ok(handles.length === pts.length - 1, '每一段都有一个段把手（段 ' + (pts.length - 1) + ' 个，把手 ' + handles.length + ' 个）')
  const endpoints = walk(tree, (n) => n.type === 'circle' && (n.props.fill === '#0a7d32' || n.props.fill === '#b85450'), [])
  ok(endpoints.length === 2, '两个端点把手还在（绿/红）')

  // 每个把手都落在它负责的那一段上（不许飘到别处）。
  const onSomeSegment = handles.every((h) =>
    segLengths.some((_, s) => {
      const a = pts[s]
      const b = pts[s + 1]
      const inX = h.props.cx >= Math.min(a.x, b.x) - 0.6 && h.props.cx <= Math.max(a.x, b.x) + 0.6
      const inY = h.props.cy >= Math.min(a.y, b.y) - 0.6 && h.props.cy <= Math.max(a.y, b.y) + 0.6
      return inX && inY
    }),
  )
  ok(onSomeSegment, '每个段把手都落在某一段上（不飘）')

  // 真正按下每一个把手：必须报到对应的段号（这就是"能不能拖"的判据）。
  for (let s = 0; s < handles.length; s += 1) {
    const down = handles[s].props.onPointerDown
    if (typeof down === 'function') down({ button: 0, preventDefault: () => {}, stopPropagation: () => {}, pointerId: 1 })
  }
  ok(
    pressed.length === pts.length - 1 && pressed.every((tag, i) => tag === 'segment:' + i),
    '每个段把手按下都报到对应的段号：' + JSON.stringify(pressed),
  )
  // 短段的手把必须真的在里面（这是这次报的 bug 的核心）。
  const shortIdx = segLengths.map((n, i) => (n < 26 ? i : -1)).filter((i) => i >= 0)
  ok(shortIdx.every((i) => pressed.indexOf('segment:' + i) >= 0), '短段的把手也在，并且能按下：' + JSON.stringify(shortIdx))
}

console.log('\ndrawio 的独立边标签单元：读出来、画在 mxGraph 算出的位置上')
{
  // 位置语义对着 mxGraphView.getPoint 核实过：x 是**沿边比例**（0=中点，±1=两端），
  // y 是垂直偏移（px），offset 是残余偏移。
  const straight = [{ x: 0, y: 0 }, { x: 200, y: 0 }] // 左→右的横线
  const mid = internals.edgeLabelPointAt(straight, 0, 0, 0, 0)
  ok(mid !== null && mid.x === 100 && mid.y === 0, 'x=0 → 落在边的中点：' + JSON.stringify(mid))
  const atStart = internals.edgeLabelPointAt(straight, -1, 0, 0, 0)
  ok(atStart !== null && atStart.x === 0, 'x=-1 → 源端：' + JSON.stringify(atStart))
  const atEnd = internals.edgeLabelPointAt(straight, 1, 0, 0, 0)
  ok(atEnd !== null && atEnd.x === 200, 'x=+1 → 目标端：' + JSON.stringify(atEnd))
  const above = internals.edgeLabelPointAt(straight, 0, 10, 0, 0)
  ok(above !== null && above.y === -10, 'y>0 在横线的上方（mxGraph 的约定）：' + JSON.stringify(above))
  const shifted = internals.edgeLabelPointAt(straight, 0, 0, 7, -3)
  ok(shifted !== null && shifted.x === 107 && shifted.y === -3, '残余偏移照加：' + JSON.stringify(shifted))
  const vertical = [{ x: 0, y: 0 }, { x: 0, y: 100 }]
  const onVertical = internals.edgeLabelPointAt(vertical, 0, 10, 0, 0)
  ok(onVertical !== null && onVertical.x === 10 && onVertical.y === 50, '竖线（向下）时 y>0 在右侧：' + JSON.stringify(onVertical))
  ok(internals.edgeLabelPointAt([{ x: 0, y: 0 }], 0, 0, 0, 0) === null, '路径不足两点 → null（调用方跳过）')

  // 渲染：挂在边上的标签出现在算出来的位置；没挂边的按自己的坐标；空文字不画。
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 400, y: 0, w: 160, h: 60 },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE }],
    labels: [
      { id: 'L1', text: '挂在边上', edgeId: 'e1', x: 0, y: 0, offsetX: 0, offsetY: 0, relative: true, style: 'edgeLabel;' },
      { id: 'L2', text: '游离的', edgeId: null, x: 700, y: 500, offsetX: 0, offsetY: 0, relative: true, style: 'edgeLabel;' },
      { id: 'L3', text: '', edgeId: null, x: 900, y: 900, offsetX: 0, offsetY: 0, relative: true, style: 'edgeLabel;' },
    ],
  }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const texts = walk(tree, (n) => n.type === 'text' && typeof n.props.className === 'string' && n.props.className.indexOf('drawai-elabel') >= 0, [])
  ok(texts.length === 2, '两个有文字的标签画出来了（空文字的不画）：' + texts.length)
  const pts = internals.edgeRoutePoints(doc, doc.edges[0])
  const expect = internals.edgeLabelPointAt(pts, 0, 0, 0, 0)
  const onEdgeText = texts.filter((t) => t.children[0] === '挂在边上')[0]
  // y 容差 1.6：文字比几何中心低 1px（视觉基线微调，与既有的边标签画法一致）。
  ok(
    onEdgeText !== undefined && Math.abs(onEdgeText.props.x - expect.x) < 0.6 && Math.abs(onEdgeText.props.y - expect.y) < 1.6,
    '挂在边上的画在算出来的落点上：' + JSON.stringify(onEdgeText === undefined ? null : [onEdgeText.props.x, onEdgeText.props.y]),
  )
  const free = texts.filter((t) => t.children[0] === '游离的')[0]
  ok(
    free !== undefined && free.props.x === 700 && Math.abs(free.props.y - 500) < 1.6,
    '没挂边的按它自己的坐标画：' + JSON.stringify(free === undefined ? null : [free.props.x, free.props.y]),
  )

  // **必须穿过归一化**：宿主读出来有 labels，客户端归一化时被抹掉 = 画布上什么都不显示
  // （这条链路踩过：只在本地造 doc 的测试会漏掉它，所以这里走 docFromPayload）。
  const viaPayload = internals.docFromPayload({ ok: true, exists: true, revision: '', notes: [], doc: doc })
  ok(viaPayload.error === undefined && Array.isArray(viaPayload.doc.labels) && viaPayload.doc.labels.length === 3, 'labels 穿过归一化没丢：' + JSON.stringify(viaPayload.doc.labels === undefined ? null : viaPayload.doc.labels.length))
  ok(viaPayload.doc.labels[0].edgeId === 'e1' && viaPayload.doc.labels[0].offsetX === 0, '穿过之后字段还在（edgeId / offsetX）')
  const cloned = internals.cloneDocForTest ? null : null
  void cloned
}

console.log('\n线上的文字（边自己的 value）：落点照 drawio、双击/右键真能加上去')
{
  // 用户报的两个问题都在这一节：
  //   · "无法在线段上添加文字" —— 标签的底衬/文字、以及选中后压在**段中点**上的把手
  //     都画在 12px 命中带**上面**，又都没挂处理函数，于是双击被它们吃掉、编辑器永远不弹；
  //   · "和 drawio 有什么区别" —— drawio 把边自己的文字画在**整条折线的弧长中点**
  //     （mxGraphView.updateEdgeLabelOffset：geometry 是 relative 时走 getPoint()，x/y 缺省=0
  //      → dist = 0.5 × 总长），我们以前画在"第 2 段的中点"上。
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 400, y: 300, w: 160, h: 60 },
    ],
    // 折点让它拐两个弯：这时"弧长中点"和"第 2 段中点"必然不在同一处。
    edges: [{ id: 'e1', from: 'a', to: 'b', label: '线上文字', style: DEFAULT_EDGE_STYLE, points: [{ x: 300, y: 30 }] }],
  }
  const pts = internals.edgeRoutePoints(doc, doc.edges[0])
  const arc = internals.edgeLabelPointAt(pts, 0, 0, 0, 0)
  const secondSeg = { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 }
  ok(arc !== null && Math.abs(arc.x - secondSeg.x) + Math.abs(arc.y - secondSeg.y) > 1, '这组几何下两种落点算法确实不同（否则下面的断言是假绿）')

  const calls = []
  const ui = {
    selectedIds: ['e1'],
    onSelectEdge: (id) => calls.push('select:' + id),
    onEdgeDoubleClick: (id) => calls.push('edit:' + id),
    onEdgeContextMenu: (id) => calls.push('menu:' + id),
  }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, ui, null)
  const text = walk(tree, (n) => n.type === 'text' && n.props.key === 'edge-text-0', [])[0]
  const bg = walk(tree, (n) => n.type === 'rect' && n.props.key === 'edge-bg-0', [])[0]
  ok(text !== undefined, '有文字的边画出了文字')
  ok(bg === undefined, '默认**不画底衬**（线已经在字的位置断开了，再盖一层白会把网格也盖掉）')
  ok(text !== undefined && Math.abs(text.props.x - arc.x) < 0.6 && Math.abs(text.props.y - arc.y) < 1.6, '边自己的文字落在**弧长中点**上（drawio 的规则）：' + JSON.stringify(text === undefined ? null : [text.props.x, text.props.y]))
  ok(text !== undefined && Math.abs(text.props.x - secondSeg.x) + Math.abs(text.props.y - secondSeg.y) > 1, '不再是"第 2 段的中点"（旧算法的落点不同）')

  ok(text !== undefined && typeof text.props.onDoubleClick === 'function', '标签文字挂了双击 → 能就地改字')
  ok(text !== undefined && typeof text.props.onPointerDown === 'function' && typeof text.props.onContextMenu === 'function', '标签文字挂了单击 / 右键（拖动也挂在它身上）')
  if (text !== undefined) text.props.onPointerDown({})
  if (text !== undefined) text.props.onDoubleClick({})
  if (text !== undefined) text.props.onContextMenu({})
  ok(calls.join(',') === 'select:e1,edit:e1,menu:e1', '三处都报到这条线上：' + calls.join(','))

  // 样式明确要底衬时才画（drawio 的 labelBackgroundColor；它可能带透明度后缀 #rrggbbaa）
  const bgDoc = JSON.parse(JSON.stringify(doc))
  bgDoc.edges[0].style = DEFAULT_EDGE_STYLE + 'labelBackgroundColor=#ffffffe0;'
  const bgTree = renderDiagram(bgDoc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const painted = walk(bgTree, (n) => n.type === 'rect' && n.props.key === 'edge-bg-0', [])[0]
  ok(painted !== undefined, '样式给了 labelBackgroundColor 就画底衬')
  ok(painted !== undefined && painted.props.fill === '#ffffff' && Math.abs(painted.props.fillOpacity - 224 / 255) < 0.01, '8 位十六进制拆成 颜色 + fill-opacity：' + JSON.stringify(painted === undefined ? null : [painted.props.fill, painted.props.fillOpacity]))
  const box = internals.labelBox(internals.edgeLabelPointAt(internals.edgeRoutePoints(bgDoc, bgDoc.edges[0]), 0, 0, 0, 0), '线上文字', 10)
  ok(painted !== undefined && Math.abs(painted.props.width - box.w) < 0.01, '底衬的大小 = 挖空用的那个框（同一个来源）')

  // 把手：它正压在**段的中点**上 —— 恰恰是"给线加字"最自然的双击位置。
  const handles = byClass(tree, 'drawai-handle')
  ok(handles.length === pts.length - 1 + 2, '选中时画出两端的端点把手 + 每段一个段把手（' + handles.length + ' 个）')
  ok(handles.every((h) => typeof h.props.onDoubleClick === 'function'), '每个把手都挂了双击')
  const before = calls.length
  handles[handles.length - 1].props.onDoubleClick({})
  ok(calls.length === before + 1 && calls[calls.length - 1] === 'edit:e1', '双击把手 = 双击这条线（第二下不再被吃掉）')
  const hit = walk(tree, (n) => n.props.key === 'edge-hit-0', [])[0]
  ok(hit !== undefined && typeof hit.props.onDoubleClick === 'function' && typeof hit.props.onPointerDown === 'function', '命中带本身仍然挂着双击/单击')
}

console.log('\n拖线上的文字：位置存在边自己的几何上（drawio 的 moveLabel）')
{
  // drawio 的边标签能拖，是因为它把位置**存下来了**（mxEdgeHandler.moveLabel → mxGeometry 的
  // x/y/offset）。我们这边同理：拖的时候用 relativePointOnPath 反解，存进 labelX/labelY/labelOffset*。
  // 这一节盯三件事：反解能来回、存下来的形状与 drawio 一致、渲染真的用上了存下来的位置。
  const path = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }]
  const cases = [
    ['第一段正中', { x: 100, y: 0 }],
    ['第一段上方 30px', { x: 60, y: -30 }],
    ['第一段下方 25px', { x: 140, y: 25 }],
    ['拐点附近', { x: 195, y: 20 }],
    ['第二段右侧', { x: 230, y: 60 }],
  ]
  for (const [label, point] of cases) {
    const rel = internals.relativePointOnPath(path, point.x, point.y)
    const back = rel === null ? null : internals.edgeLabelPointAt(path, rel.x, rel.y, 0, 0)
    ok(
      rel !== null && back !== null && Math.abs(back.x - point.x) <= 1 && Math.abs(back.y - point.y) <= 1,
      label + '：反解 → 正算回到原处（' + JSON.stringify(back) + '）',
    )
  }
  // 投影落在路径之外时会被夹住（只有沿边比例 + 垂距，表示不了"越出端点"的那一截）——
  // 这没关系：拖标签时越出去的部分由 `offset`（残余）承担，见下面的 labelPosFor。
  const past = internals.relativePointOnPath(path, -40, 0)
  ok(past !== null && Math.abs(past.x + 1) < 1e-6 && Math.abs(past.y) < 1e-6, '端点之外 → 夹在端点（x=-1, y=0）：' + JSON.stringify(past))
  const pastPos = internals.labelPosFor(path, { x: -40, y: 0 })
  const pastBack = pastPos === null ? null : internals.edgeLabelPointAt(path, pastPos.labelX, pastPos.labelY, pastPos.labelOffsetX, pastPos.labelOffsetY)
  ok(pastBack !== null && Math.abs(pastBack.x + 40) <= 1 && Math.abs(pastBack.y) <= 1, '越出端点的部分由 offset 承担：落点回到指针处（' + JSON.stringify(pastBack) + '）')
  ok(internals.relativePointOnPath([{ x: 0, y: 0 }], 1, 1) === null, '路径不足两点 → null')
  ok(internals.relativePointOnPath([{ x: 5, y: 5 }, { x: 5, y: 5 }], 9, 9) === null, '零长路径 → null')

  // 存下来的形状与 drawio 的 moveLabel 一致：x 四位小数、y 取整、零头进 offset。
  const pos = internals.labelPosFor(path, { x: 63.3, y: -27.7 })
  ok(pos !== null && pos.labelX === Math.round(pos.labelX * 10000) / 10000, 'x 只留 4 位小数：' + pos.labelX)
  ok(pos !== null && pos.labelY === Math.round(pos.labelY), 'y 取整：' + pos.labelY)
  ok(pos !== null && pos.labelY > 0, '横线上方 → y 为正（drawio 的约定：正数在行进方向左侧/上方）')
  const below = internals.labelPosFor(path, { x: 100, y: 30 })
  ok(below !== null && below.labelY < 0, '横线下方 → y 为负：' + below.labelY)
  const landed = internals.edgeLabelPointAt(path, pos.labelX, pos.labelY, pos.labelOffsetX, pos.labelOffsetY)
  ok(landed !== null && Math.abs(landed.x - 63.3) <= 1 && Math.abs(landed.y + 27.7) <= 1, '落点仍在指针附近（零头补上了取整的差）：' + JSON.stringify(landed))

  // 渲染：模型里的位置真的被用上（否则拖了跟没拖一样）
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 400, y: 300, w: 160, h: 60 },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', label: '线上的字', style: DEFAULT_EDGE_STYLE, labelX: 0.5, labelY: 40, labelOffsetX: 2, labelOffsetY: -1 }],
  }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const text = walk(tree, (n) => n.type === 'text' && n.props.key === 'edge-text-0', [])[0]
  const pts = internals.edgeRoutePoints(doc, doc.edges[0])
  const want = internals.edgeLabelPointAt(pts, 0.5, 40, 2, -1)
  const center = internals.edgeLabelPointAt(pts, 0, 0, 0, 0)
  ok(want !== null && center !== null && Math.abs(want.x - center.x) + Math.abs(want.y - center.y) > 1, '这组位置与"弧长中点"确实不同（否则下面是假绿）')
  ok(text !== undefined && Math.abs(text.props.x - want.x) < 0.6 && Math.abs(text.props.y - want.y) < 1.6, '文字画在存下来的位置上：' + JSON.stringify(text === undefined ? null : [text.props.x, text.props.y]))
  ok(text !== undefined && Math.abs(text.props.x - center.x) + Math.abs(text.props.y - center.y) > 1, '不再是弧长中点')
  // 归一化是那道会静默丢字段的闸门（labels 和键盘归属都在这里踩过）
  const viaPayload = internals.docFromPayload({ ok: true, exists: true, revision: '', notes: [], doc: doc })
  ok(viaPayload.error === undefined && viaPayload.doc.edges[0].labelX === 0.5 && viaPayload.doc.edges[0].labelY === 40, '位置穿过归一化没丢：' + JSON.stringify([viaPayload.doc.edges[0].labelX, viaPayload.doc.edges[0].labelY]))
  ok(viaPayload.doc.edges[0].labelOffsetX === 2 && viaPayload.doc.edges[0].labelOffsetY === -1, '残余偏移也穿过了：' + JSON.stringify([viaPayload.doc.edges[0].labelOffsetX, viaPayload.doc.edges[0].labelOffsetY]))

  // 交互接线：标签按住是"拖标签"，命中带按住是"选中这条线"
  const calls = []
  const ui = {
    selectedIds: ['e1'],
    onSelectEdge: (id) => calls.push('select:' + id),
    onEdgeLabelPointerDown: (id) => calls.push('drag:' + id),
    onEdgeDoubleClick: (id) => calls.push('edit:' + id),
  }
  const tree2 = renderDiagram(doc, 'light', 'u1', { current: null }, ui, null)
  const labelText = walk(tree2, (n) => n.type === 'text' && n.props.key === 'edge-text-0', [])[0]
  const band = walk(tree2, (n) => n.props.key === 'edge-hit-0', [])[0]
  if (labelText !== undefined) labelText.props.onPointerDown({})
  if (band !== undefined) band.props.onPointerDown({})
  ok(calls.join(',') === 'drag:e1,select:e1', '标签按住 = 拖标签，命中带按住 = 选中（实际 ' + calls.join(',') + '）')
  ok(labelText !== undefined && typeof labelText.props.onDoubleClick === 'function', '标签仍然双击改字（拖动没有把它挤掉）')
}

console.log('\n整体拖动：相对位置一点都不能变')
{
  // 用户报的："框选全部后拖动，线段没有被拖动，只是保持着自动路由" ——
  // 以前拖动只挪节点坐标，连线的折点留在原地，于是形状被重新路由掉了。
  // 现在节点、折点、悬空端的自由端点用**同一个位移**一起走。
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      // 故意有一个不在格上的节点：它必须保持与其它节点的相对错位
      { id: 'a', x: 100, y: 100, w: 60, h: 40 },
      { id: 'b', x: 303, y: 100, w: 60, h: 40 },
      { id: 'c', x: 100, y: 300, w: 60, h: 40 },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE, points: [{ x: 230, y: 60 }] },
      { id: 'e2', from: 'c', targetPoint: { x: 277, y: 377 }, style: DEFAULT_EDGE_STYLE },
    ],
    labels: [],
  }
  const drag = {
    originX: 130,
    originY: 120,
    // 抓起来的是 a：位移由它算，所以它的落点会被吸到整格
    ref: { x: 100, y: 100 },
    hasNodes: true,
    starts: [
      { id: 'a', x: 100, y: 100 },
      { id: 'b', x: 303, y: 100 },
      { id: 'c', x: 100, y: 300 },
    ],
    edgeStarts: [
      { id: 'e1', points: [{ x: 230, y: 60 }], sourcePoint: null, targetPoint: null },
      { id: 'e2', points: null, sourcePoint: null, targetPoint: { x: 277, y: 377 } },
    ],
  }
  const move = internals.dragMoveOf(drag, { x: drag.originX + 23, y: drag.originY + 17 })
  ok(move.x === 20 && move.y === 20, '位移是"把抓起来的节点吸到整格"后的值（23,17 → 20,20）：' + JSON.stringify(move))
  const moved = internals.draggedGeometry(drag, move)
  const byId = {}
  for (const n of moved.nodes) byId[n.id] = n
  ok(byId.a.x === 120 && byId.a.y === 120, '抓起来的节点落在整格上：' + JSON.stringify([byId.a.x, byId.a.y]))
  ok(byId.b.x - byId.a.x === 203, '**相对位置不变**：b 与 a 的间距还是 203（以前逐点各自吸附会把它吸成 200）')
  ok(byId.c.y - byId.a.y === 200, '纵向上同样保持不变')
  const e1 = moved.edges.filter((e) => e.id === 'e1')[0]
  ok(e1.points[0].x === 250 && e1.points[0].y === 80, '折点跟着同一个位移走：' + JSON.stringify(e1.points[0]))
  const e2 = moved.edges.filter((e) => e.id === 'e2')[0]
  ok(e2.targetPoint.x === 297 && e2.targetPoint.y === 397, '悬空端的自由点也跟着走：' + JSON.stringify(e2.targetPoint))

  // 走线形状必须**整体平移**：把移动后的文档路由出来，减掉位移应当与原来逐点相同
  const after = {
    version: 2,
    revision: '',
    nodes: doc.nodes.map((n) => {
      const m = byId[n.id]
      return { id: n.id, x: m.x, y: m.y, w: n.w, h: n.h }
    }),
    edges: doc.edges.map((e) => {
      const m = moved.edges.filter((x) => x.id === e.id)[0]
      const out = { id: e.id, from: e.from, to: e.to, style: e.style }
      if (m.points !== null) out.points = m.points
      if (m.targetPoint !== null) out.targetPoint = m.targetPoint
      return out
    }),
    labels: [],
  }
  const beforePts = internals.edgeRoutePoints(doc, doc.edges[0])
  const afterPts = internals.edgeRoutePoints(after, after.edges[0])
  const shifted = afterPts === null ? null : afterPts.map((p) => ({ x: p.x - move.x, y: p.y - move.y }))
  const sameShape =
    beforePts !== null &&
    shifted !== null &&
    beforePts.length === shifted.length &&
    beforePts.every((p, i) => Math.abs(p.x - shifted[i].x) < 0.01 && Math.abs(p.y - shifted[i].y) < 0.01)
  ok(sameShape, '折线形状整体平移（逐点相同）：' + JSON.stringify(beforePts) + ' → ' + JSON.stringify(afterPts))

  // 只拖连线（选区里没有节点）：按半格吸附
  const edgeOnly = { originX: 0, originY: 0, ref: null, hasNodes: false, starts: [], edgeStarts: drag.edgeStarts }
  const onlyMove = internals.dragMoveOf(edgeOnly, { x: 13, y: -7 })
  ok(onlyMove.x === 15 && onlyMove.y === -5, '只拖连线时按半格吸附：' + JSON.stringify(onlyMove))
}

console.log('\n图层 v1：隐藏层整层不画、也点不到；新单元进当前层')
{
  const doc = {
    version: 2,
    revision: '',
    layers: [
      { id: '1', name: '主流程', visible: true, locked: false },
      { id: 'L2', name: '注释', visible: false, locked: false },
    ],
    nodes: [
      { id: 'n1', label: '看得见', x: 0, y: 0, w: 100, h: 40, layer: '1' },
      { id: 'n2', label: '看不见', x: 200, y: 0, w: 100, h: 40, layer: 'L2' },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n1', style: DEFAULT_EDGE_STYLE, layer: '1' },
      { id: 'e2', from: 'n2', to: 'n2', style: DEFAULT_EDGE_STYLE, layer: 'L2' },
    ],
    labels: [
      { id: 'lb1', text: '看得见', edgeId: null, x: 500, y: 500, offsetX: 0, offsetY: 0, relative: false, style: '', layer: '1' },
      { id: 'lb2', text: '看不见', edgeId: null, x: 600, y: 600, offsetX: 0, offsetY: 0, relative: false, style: '', layer: 'L2' },
    ],
  }
  const hidden = internals.hiddenLayerIds(doc)
  ok(hidden.size === 1 && hidden.has('L2'), '隐藏层集合 = {L2}：' + JSON.stringify([...hidden]))
  ok(internals.isHiddenCell(hidden, { layer: 'L2' }) === true && internals.isHiddenCell(hidden, { layer: '1' }) === false, 'isHiddenCell 按 layer 判断')
  ok(internals.isHiddenCell(hidden, {}) === false, '没有 layer 字段的单元视为可见')

  const geometry = internals.buildGeometry(doc)
  ok(geometry.boxes.length === 1 && geometry.boxes[0].id === 'n1', '几何里只有可见层的节点（隐藏层不参与渲染/命中/避让）：' + geometry.boxes.map((b) => b.id).join(','))

  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const texts = walk(tree, (n) => n.type === 'text', []).map((t) => String(t.children[0]))
  ok(texts.indexOf('看得见') >= 0 && texts.indexOf('看不见') < 0, '隐藏层的节点没画：' + JSON.stringify(texts))
  const pathKeys = walk(tree, (n) => typeof n.props.key === 'string' && n.props.key.indexOf('edge-') === 0, []).map((n) => n.props.key)
  ok(pathKeys.indexOf('edge-0') >= 0 && pathKeys.indexOf('edge-1') < 0, '隐藏层的连线没画：' + JSON.stringify(pathKeys))
  const labelTexts = walk(tree, (n) => n.type === 'text' && typeof n.props.className === 'string' && n.props.className.indexOf('drawai-elabel') >= 0, []).map((t) => String(t.children[0]))
  ok(labelTexts.indexOf('看得见') >= 0 && labelTexts.indexOf('看不见') < 0, '隐藏层的独立标签也没画：' + JSON.stringify(labelTexts))

  // 框选也框不到隐藏层的东西（哪怕框住整张图）
  const hits = internals.marqueeHits(doc, { x: -1000, y: -1000, w: 4000, h: 4000 }, null)
  ok(hits.indexOf('n2') < 0 && hits.indexOf('e2') < 0, '全选一遍框选：隐藏层的一个都不在里面：' + hits.join(','))
  ok(hits.indexOf('n1') >= 0 && hits.indexOf('e1') >= 0, '可见层的照旧：' + hits.join(','))

  // 新建图层 id / 名字兜底
  ok(internals.nextLayerIdOf(doc) === 'L3', '新层 id 避开已用的：' + internals.nextLayerIdOf(doc))
  ok(internals.layerLabelOf({ id: 'x', name: '' }, 2) === '第 3 层', '没名字的层用"第 N 层"兜底')
  ok(internals.layerLabelOf({ id: 'x', name: '注释' }, 0) === '注释', '有名字就用名字')

  // 粘贴进当前层
  const clip = internals.collectClipboard(doc, ['n1'])
  const pasted = internals.pasteInto(doc, clip, 20, 20, 'L2')
  ok(pasted !== null && pasted.doc.nodes.filter((n) => pasted.ids.indexOf(n.id) >= 0).every((n) => n.layer === 'L2'), '粘贴的节点进当前图层')
  const pastedOwn = internals.pasteInto(doc, clip, 20, 20)
  ok(pastedOwn !== null && pastedOwn.doc.nodes.filter((n) => pastedOwn.ids.indexOf(n.id) >= 0).every((n) => n.layer === '1'), '不给层时沿用原件那一层')
}

console.log('\n文档在客户端里转一圈不能把字段吃掉（图层就是这么丢的）')
{
  // 真实事故：图层菜单一直说"（这张画布没有图层信息）"，而文件里明明有图层 ——
  // 因为**客户端**有三处把文档"逐个字段抄"了一遍，都漏了 layers：
  //   docFromPayload（宿主 → 客户端）、cloneDoc（每次本地改动/撤销快照）、pasteInto（粘贴）。
  // 表现是：层显示不出来；而且"显示/隐藏"是**空操作**（mutate 拿到的 next.layers 是 undefined）。
  //
  // 这里用**键集合**来钉，而不是逐个字段写断言：拿"内核归一化后的文档"当基准，
  // 谁抄漏了字段就报出缺了哪个 —— 以后内核再加文档级字段，这三处必须自动跟上。
  const payload = {
    ok: true,
    exists: true,
    path: 'a.drawio',
    absolute: 'D:/ws/a.drawio',
    notes: [],
    doc: {
      version: 2,
      revision: 'abc123abc123',
      meta: { pinned: true },
      layers: [
        { id: '1', name: '主流程', visible: true, locked: false },
        { id: 'L2', name: '草稿', visible: false, locked: false },
      ],
      nodes: [{ id: 'n1', label: 'A', x: 0, y: 0, w: 100, h: 40, layer: '1' }],
      edges: [{ id: 'e1', from: 'n1', to: 'n1', style: DEFAULT_EDGE_STYLE, layer: '1' }],
      labels: [],
    },
  }
  /** 少了哪些键（基准 = 内核归一化后的文档键集合）。 */
  const missingKeys = (base, candidate) => Object.keys(base).filter((k) => Object.prototype.hasOwnProperty.call(candidate, k) === false)

  const fromPayload = internals.docFromPayload(payload)
  ok(fromPayload.error === undefined, 'docFromPayload 读得动')
  const d1 = fromPayload.doc
  const normalized = normalizeDrawioDoc(payload.doc)
  ok(Array.isArray(d1.layers) && d1.layers.length === 2, 'docFromPayload 带上图层表（实际 ' + JSON.stringify(d1.layers) + '）')
  ok(d1.layers[1].visible === false && d1.layers[1].name === '草稿', '图层的可见性与名字都在')
  ok(missingKeys(normalized, d1).length === 0, 'docFromPayload 不丢任何一个文档级字段（缺：' + JSON.stringify(missingKeys(normalized, d1)) + '）')
  ok(d1.meta.pinned === true && d1.nodes.length === 1 && d1.edges.length === 1, '原有的 meta/nodes/edges 照旧')

  // 文件还不存在（地址栏直接开新路径 / 新建画布）：空画布也要有缺省图层，
  // 否则图层面板在这张画布上永远说"没有图层信息"，一存一开又有了。
  const fresh = internals.docFromPayload({ ok: true, exists: false, path: 'new.drawio' })
  ok(fresh.error === undefined && Array.isArray(fresh.doc.layers) && fresh.doc.layers.length === 1, '文件还不存在时给一个缺省图层')
  ok(fresh.doc.layers.length === 1 && fresh.doc.layers[0].id === '1' && fresh.doc.layers[0].visible === true, '缺省图层与盘上那个 `<mxCell id="1" parent="0" />` 对应')

  // cloneDoc：本地每一次改动、每一个撤销快照都走它
  const cloned = internals.cloneDoc(d1)
  ok(Array.isArray(cloned.layers) && cloned.layers.length === 2, 'cloneDoc 带上图层表（实际 ' + JSON.stringify(cloned.layers) + '）')
  ok(missingKeys(d1, cloned).length === 0, 'cloneDoc 不丢字段（缺：' + JSON.stringify(missingKeys(d1, cloned)) + '）')
  ok(cloned.nodes !== d1.nodes && cloned.edges !== d1.edges && cloned.labels !== d1.labels, '数组是新的（快照互相不影响）')
  ok(cloned.layers !== d1.layers && cloned.layers[0] !== d1.layers[0], '图层对象也是新的 —— 否则改可见性会连快照一起改')
  cloned.layers[0].visible = false
  ok(d1.layers[0].visible === true, '改克隆出来的层不会回头改原件（撤销快照不能被写坏）')

  // pasteInto：粘贴一次不该把图层结构弄丢
  const clip = internals.collectClipboard(d1, ['n1'])
  const pasted = internals.pasteInto(d1, clip, 20, 20, 'L2')
  ok(Array.isArray(pasted.doc.layers) && pasted.doc.layers.length === 2, 'pasteInto 保留图层表')
  ok(missingKeys(d1, pasted.doc).length === 0, 'pasteInto 不丢字段（缺：' + JSON.stringify(missingKeys(d1, pasted.doc)) + '）')
}

console.log('\n双击节点 = 就地改标签（这条接线曾经被 pointer capture 打断）')
{
  // 真实事故：`onNodePointerDown` 里按下就 `setPointerCapture(画布)`，于是随后的
  // **click / dblclick 目标被改成捕获元素**（click 取按下/松开两个目标的公共祖先，而被捕获的
  // pointerup 目标是画布容器）—— 节点那个 <g> 根本不在事件路径里，双击改标签完全失灵。
  // 之前这里一条断言都没有：只在别处断言过"边上的文字"双击，节点这边是空白。
  const d = {
    nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60, label: 'A' }],
    edges: [],
  }
  const hits = []
  const ui = {
    selectedIds: [],
    onNodeDoubleClick: (id, event) => hits.push(id + ':' + (event === undefined ? 'undefined' : 'event')),
    onNodePointerDown: () => hits.push('down'),
    onNodeContextMenu: () => hits.push('menu'),
  }
  const tree = renderDiagram(d, 'light', 'u1', { current: null }, ui, null)
  const group = walk(tree, (n) => n.type === 'g' && n.props['data-node-id'] === 'a', [])[0]
  ok(group !== undefined, '节点 <g> 渲染出来了')
  if (group !== undefined) {
    ok(typeof group.props.onDoubleClick === 'function', '节点 <g> 挂着双击 → 能就地改标签')
    const fake = { type: 'dblclick' }
    group.props.onDoubleClick(fake)
    ok(hits.join(',') === 'a:event', '双击报到那条节点上（id 与事件都传对了）：' + hits.join(','))
    // 双击与按下是两条路：按下只负责选中/拖动，改标签必须靠双击
    ok(typeof group.props.onPointerDown === 'function' && hits.indexOf('down') < 0, '按下不会顺便开编辑框（改标签只由双击触发）')
    ok(group.props.onDoubleClick !== group.props.onPointerDown, '两者不是同一个处理器')
  }
}

console.log('\n独立文字：一段没有边框底色的字（drawio 的 text 形状）')
{
  // 为什么样式必须与 drawio 一字不差：`text` 是 drawio 的**裸键**（不是 shape=text），
  // 而且靠 strokeColor=none;fillColor=none 才没有边框与底色 ——
  // 少一个键，同一个元素在 drawio 里就多出一个白框（两边看到的不是同一张图）。
  ok(NODE_SHAPES.indexOf('text') >= 0, 'text 在形状枚举里（AI 的 shape:"text" 与右键形状面板都能用）')
  const textStyle = styleWithNodeShape('', 'text')
  // drawio 自己写的是裸键 `text;`；我们这边的规范化写法是 `text=1`（parseStyle 里两者等价，
  // 见内核注释），所以这里断言"text 这个键在"，别去比字节。
  ok(styleGet(textStyle, 'text', null) !== null, '落成 drawio 的 text 键（裸键；我们规范成 text=1）：' + textStyle)
  ok(
    styleGet(textStyle, 'strokeColor', null) === 'none' && styleGet(textStyle, 'fillColor', null) === 'none',
    '无边框无底色（strokeColor=none;fillColor=none）',
  )
  ok(styleGet(textStyle, 'whiteSpace', null) === 'wrap' && styleGet(textStyle, 'rounded', null) === '0', '与 Editor.defaultTextStyle 一致（whiteSpace=wrap;rounded=0）')
  ok(nodeShapeFromStyle(textStyle) === 'text', '从样式反推得回来')
  ok(nodeShapeFromStyle('text;html=1') === 'text', '只写 text;html=1 也认得（drawio 里手画的文字可能就这么简）')
  ok(nodeShapeFromStyle('rounded=1') === 'rounded', '别的形状不受影响（text 判定排在前面但只认这个键）')

  // 换形状：文字 → 矩形 必须把"隐形"设置一起清掉，否则换出来的是一只**看不见的矩形**
  const asRect = styleWithNodeShape(textStyle, 'rect')
  ok(styleGet(asRect, 'text', null) === null, '换成矩形后 text 键没了')
  ok(
    styleGet(asRect, 'strokeColor', null) === null && styleGet(asRect, 'fillColor', null) === null,
    '隐形设置也一起清掉（否则矩形看不见 —— 这是最容易漏的一步）',
  )
  // 有配色的矩形换成文字：drawio 的形状模板会盖掉 fill/stroke（文字本来就不该有底色）
  const blueRect = stylePatch('', { fillColor: '#dae8fc', strokeColor: '#6c8ebf' })
  const blueAsText = styleWithNodeShape(blueRect, 'text')
  ok(styleGet(blueAsText, 'fillColor', null) === 'none', '矩形（蓝）换成文字 → 底色被文字模板盖掉')

  // 文字元素的"配色"落到 fontColor 上（否则点一圈颜色屏幕上毫无变化）
  const redText = styleWithTextColorName(textStyle, 'red')
  ok(styleGet(redText, 'fontColor', null) === '#b85450', '文字换色落到 fontColor：' + styleGet(redText, 'fontColor', null))
  ok(
    styleGet(redText, 'fillColor', null) === 'none' && styleGet(redText, 'strokeColor', null) === 'none',
    '不会顺手给它加填充/描边',
  )
  ok(textColorNameFromStyle(redText) === 'red', '从字色反推得回调色板名')
  ok(textColorNameFromStyle(styleWithTextColorName(redText, 'plain')) === 'plain', '"默认"把 fontColor 删掉、回缺省字色')

  // 画面：只有字 + 一个透明命中框
  const tdoc = { nodes: [{ id: 't1', label: '一段说明', style: textStyle, x: 0, y: 0, w: 160, h: 60 }], edges: [] }
  const tree = renderDiagram(tdoc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const group = walk(tree, (n) => n.type === 'g' && n.props['data-node-id'] === 't1', [])[0]
  ok(group !== undefined, '文字元素照常进渲染（不是被当成不认识的形状丢掉）')
  if (group !== undefined) {
    const shapes = walk(group.children, (n) => ['rect', 'ellipse', 'polygon', 'path'].indexOf(n.type) >= 0, [])
    const painted = shapes.filter((s) => typeof s.props.fill === 'string' && s.props.fill !== 'transparent' && s.props.fill !== 'none')
    ok(painted.length === 0, '不画边框/底色（没有一个带真实填充的形状）：' + JSON.stringify(painted.map((s) => s.props.fill)))
    const hit = shapes.filter((s) => s.props.fill === 'transparent')
    ok(hit.length === 1, '但留了一个透明命中框 —— 否则点不到、拖不动、双击也改不了字')
    ok(hit.length === 1 && hit[0].props.width === 160 && hit[0].props.height === 60, '命中框就是它的包围盒')
    const texts = walk(group.children, (n) => n.type === 'text', [])
    // 标签是 <text><tspan>…</tspan></text>，把字符串叶子摊平了看（别去数嵌套层数）
    const flatten = (node) => {
      if (node === null || node === undefined) return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(flatten).join('')
      return flatten(node.children)
    }
    ok(texts.length === 1 && flatten(texts[0]) === '一段说明', '字照常画出来：' + (texts[0] === undefined ? '没有标签' : flatten(texts[0])))
  }
  const redDoc = { nodes: [{ id: 't1', label: '红字', style: redText, x: 0, y: 0, w: 160, h: 60 }], edges: [] }
  const redTree = renderDiagram(redDoc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const redGroup = walk(redTree, (n) => n.type === 'g' && n.props['data-node-id'] === 't1', [])[0]
  const redLabel = redGroup === undefined ? [] : walk(redGroup.children, (n) => n.type === 'text', [])
  ok(redLabel.length === 1 && redLabel[0].props.fill === '#b85450', '字色真的驱动渲染：' + (redLabel[0] === undefined ? '没有标签' : redLabel[0].props.fill))
}

console.log('\n线型（直线 / 折线 / 曲线）与字号')
{
  // 线型四选一：直线 / 直角折线 / 圆角折线 / 曲线。
  // 这是把 drawio 的两组键压平：走线（Straight vs Orthogonal）+ 拐角（sharp/rounded/curved，
  // 见 Format.js:6543）。直线在我们这里必须显式写 `edgeStyle=none`：drawio 的 Straight 是
  // **删掉 edgeStyle 键**，而我们的渲染器把"没有键"当正交 —— 不写 none 两边就不是同一条线。
  const base = 'edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=classic;'
  const straight = styleWithLineKind(base, 'straight')
  ok(styleGet(straight, 'edgeStyle', null) === 'none', '直线落成 edgeStyle=none：' + straight)
  ok(lineKindFromStyle(straight) === 'straight', '从样式反推得回直线')
  ok(styleGet(straight, 'rounded', null) === null, '直线不留 rounded（没有折点可倒角）')
  const sharp = styleWithLineKind(styleWithLineKind(base, 'rounded'), 'sharp')
  ok(lineKindFromStyle(sharp) === 'sharp', '直角折线就是缺省的正交折线')
  ok(styleGet(sharp, 'rounded', null) === null, '切回直角会把 rounded 删掉（不留 rounded=0 噪音）')
  const roundedLine = styleWithLineKind(base, 'rounded')
  ok(styleGet(roundedLine, 'rounded', null) === '1' && styleGet(roundedLine, 'edgeStyle', null) === 'orthogonalEdgeStyle', '圆角折线 = rounded=1（仍在正交路由上）：' + roundedLine)
  ok(lineKindFromStyle(roundedLine) === 'rounded', '从样式反推得回圆角折线')
  const curved = styleWithLineKind(base, 'curved')
  ok(styleGet(curved, 'curved', null) === '1' && styleGet(curved, 'edgeStyle', null) === 'orthogonalEdgeStyle', '曲线 = curved=1（路由仍留着）：' + curved)
  ok(lineKindFromStyle(curved) === 'curved', '从样式反推得回曲线')
  ok(styleGet(styleWithLineKind(roundedLine, 'curved'), 'rounded', null) === null, '曲线与圆角互斥：转曲线时把 rounded 清掉（drawio 里 paintCurvedLine 优先）')
  ok(styleWithLineKind(base, 'orthogonal') === styleWithLineKind(base, 'sharp'), "'orthogonal' 是 sharp 的别名（AI 老写法仍然有效）")
  ok(lineKindFromStyle('') === 'sharp', '没有路由键时算直角折线（drawio 的缺省外观）')
  ok(styleWithLineKind(base, 'unknown') === base, '认不出的线型原样返回（不猜）')
  ok(curvedFromStyle(curved) === true && curvedFromStyle(base) === false, 'curvedFromStyle 的判据是 curved=1')
  ok(styleGet(styleWithLineKind(straight, 'curved'), 'edgeStyle', null) === 'none', '直线转曲线：路由保持"直线"，只加 curved（由现有的折点决定弧度）')

  // 曲线怎么画：drawio 的 mxPolyline.paintCurvedLine（中间点当二次曲线的控制点）
  const pts3 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]
  const curvedD = internals.pathOf(pts3, 0, true)
  ok(curvedD.indexOf('Q') > 0 && curvedD.indexOf('L') < 0, '曲线路径只用二次曲线（没有直线段）：' + curvedD)
  ok(curvedD === 'M 0 0 Q 100 0 100 80', '三点曲线与 drawio 的算法逐字一致：' + curvedD)
  const pts4 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 200, y: 80 }]
  ok(
    internals.pathOf(pts4, 0, true) === 'M 0 0 Q 100 0 100 40 Q 100 80 200 80',
    '四点曲线：每个中间点收在下一点与它的中点上（drawio 的循环）：' + internals.pathOf(pts4, 0, true),
  )
  // 两点 + 曲线：控制点落在起点上 → 退化成直线（与 drawio 一致，不会凭空鼓起来）
  ok(internals.pathOf([{ x: 0, y: 0 }, { x: 50, y: 0 }], 0, true) === 'M 0 0 Q 0 0 50 0', '两点 + 曲线 = 退化成直线（所以"看得见的弧"要靠一个中点）')
  ok(internals.pathOf(pts3, 6, false) === 'M 0 0 L 94 0 Q 100 0 100 6 L 100 80', '不带曲线时还是原来的圆角折线：' + internals.pathOf(pts3, 6, false))

  // 圆角半径：drawio 的 mxPolyline.paintLine 取 arcSize，缺省 mxConstants.LINE_ARCSIZE(20) 再 /2 = 10px；
  // 样式里给了 arcSize 就用它（同样 /2）。以前写死 6px，与 drawio 对不上。
  const roundDoc = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', x: 300, y: 200, w: 100, h: 40 },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', style: styleWithLineKind(DEFAULT_EDGE_STYLE, 'rounded') },
      { id: 'e2', from: 'a', to: 'b', style: stylePatch(styleWithLineKind(DEFAULT_EDGE_STYLE, 'rounded'), { arcSize: '40' }) },
      { id: 'e3', from: 'a', to: 'b', style: styleWithLineKind(DEFAULT_EDGE_STYLE, 'sharp') },
    ],
  }
  const roundTree = renderDiagram(roundDoc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const dOf = (key) => {
    const el = walk(roundTree, (n) => n.props !== undefined && n.props.key === key, [])[0]
    return el === undefined ? '' : String(el.props.d)
  }
  const radiusOf = (d) => {
    // 取第一段弧的收尾点与拐点的距离（= 半径）：'L x y Q cx cy bx by'
    const m = /L ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+)/.exec(d)
    if (m === null) return null
    const [lx, ly, qx, qy] = m.slice(1).map(Number)
    return Math.round(Math.hypot(qx - lx, qy - ly))
  }
  ok(radiusOf(dOf('edge-0')) === 10, '圆角折线的缺省半径 = 10px（drawio 的 LINE_ARCSIZE/2，实际 ' + radiusOf(dOf('edge-0')) + '）')
  ok(radiusOf(dOf('edge-1')) === 20, 'arcSize=40 → 半径 20px（实际 ' + radiusOf(dOf('edge-1')) + '）')
  ok(radiusOf(dOf('edge-2')) === 0, '直角折线的圆角半径是 0（不留可见圆角；路径里那个 Q 是零长度、画不出东西）：' + radiusOf(dOf('edge-2')))

  // 画面：curved=1 的边用曲线画，命中带也是同一条曲线（否则"看着是弧、点起来按折线算"）
  const d = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', x: 300, y: 200, w: 100, h: 40 },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE },
      { id: 'e2', from: 'a', to: 'b', style: styleWithLineKind(DEFAULT_EDGE_STYLE, 'curved') },
      { id: 'e3', from: 'a', to: 'b', style: styleWithLineKind(DEFAULT_EDGE_STYLE, 'straight') },
    ],
  }
  const tree = renderDiagram(d, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const pathD = (key) => {
    const el = walk(tree, (n) => n.props !== undefined && n.props.key === key, [])[0]
    return el === undefined ? '' : String(el.props.d)
  }
  ok(pathD('edge-1').indexOf('Q') > 0 && pathD('edge-1').indexOf('L') < 0, '曲线那条边画成了曲线：' + pathD('edge-1'))
  ok(pathD('edge-hit-1') === pathD('edge-1'), '命中带用的是同一条曲线（点得中弧线本身）')
  ok(pathD('edge-2').indexOf('Q') < 0 && pathD('edge-2').split('L').length === 2, '直线那条边只有一段（M + 一个 L）：' + pathD('edge-2'))
  ok(pathD('edge-0').indexOf('Q') > 0, '缺省（正交 + 圆角）还是原来的折线')

  // 字号：drawio 的 fontSize 键，null = 删键
  const fs = stylePatch(DEFAULT_EDGE_STYLE, { fontSize: '18' })
  ok(styleGet(fs, 'fontSize', null) === '18', '字号落在 fontSize 键上')
  ok(styleGet(stylePatch(fs, { fontSize: null }), 'fontSize', null) === null, '删键回缺省')
}

console.log('\n右键菜单的"当前值"（一类一行只显示它）')
{
  // 菜单改成"一类一行 + 下拉"之后，风险从"按钮排不下"变成"当前值显示错了"——
  // 显示错了比铺开更糟：用户以为现在是直角折线，其实点开才发现是曲线。
  const sum = internals.styleSummary
  ok(typeof sum === 'function', 'styleSummary 有导出（自测能直接断言）')
  if (typeof sum === 'function') {
    // 形状：枚举 → 中文名；认不出的形状原样给名字，不显示"未知"
    ok(sum('', 'shape') === '矩形', '没有形状键 = 矩形：' + sum('', 'shape'))
    ok(sum('rounded=1', 'shape') === '圆角矩形', 'rounded=1 → 圆角矩形（不是"圆角"这种含糊说法）')
    ok(sum('text;html=1', 'shape') === '文字', 'text → 文字')
    ok(sum('shape=cylinder3', 'shape') === '数据库', '容器形状也认得：' + sum('shape=cylinder3', 'shape'))
    // 认不出的形状：内核的判据是"落回 rect"，而画面上我们确实按矩形画 —— 所以显示"矩形"是与画面一致的
    ok(sum('shape=whateverUnknown', 'shape') === '矩形', '认不出的形状按矩形显示（与渲染一致：它真的画成矩形）')

    // 配色：命中调色板给中文名；认不出的十六进制就把那个值给人看
    ok(sum('', 'color') === '默认', '空样式 = 默认配色')
    ok(sum('fillColor=#dae8fc;strokeColor=#6c8ebf', 'color') === '蓝', '蓝色命中调色板 → 蓝')
    ok(sum('fillColor=#123456;strokeColor=#654321', 'color') === '#123456', '认不出的颜色显示十六进制：' + sum('fillColor=#123456;strokeColor=#654321', 'color'))
    ok(sum('text;html=1;fontColor=#b85450', 'color') === '红', '独立文字的"配色"读的是字色')
    ok(sum('text;html=1', 'color') === '默认', '文字没设字色 = 默认')

    // 字号：没写键 = 默认（而不是 0 或空）
    ok(sum('', 'fontSize') === '默认', '没写 fontSize = 默认')
    ok(sum('fontSize=18', 'fontSize') === '18', '写了就是那个数：' + sum('fontSize=18', 'fontSize'))

    // 连线三类：与下拉里高亮的那一项必须同源
    ok(sum('', 'line') === '直角折线', '缺省线型 = 直角折线')
    ok(sum('edgeStyle=none', 'line') === '直线', 'edgeStyle=none → 直线')
    ok(sum('rounded=1', 'line') === '圆角折线', 'rounded=1 → 圆角折线')
    ok(sum('curved=1', 'line') === '曲线', 'curved=1 → 曲线')
    ok(sum('', 'dash') === '实线' && sum('dashed=1', 'dash') === '虚线' && sum('dashed=1;dashPattern=1 2', 'dash') === '点线', '实线/虚线/点线认得出来')
    ok(sum(DEFAULT_EDGE_STYLE, 'arrow') === '→ 单向', '我们新建的边（缺省样式带 endArrow=classic）→ 单向')
    ok(sum('', 'arrow') === '— 无箭头', '样式串里没有箭头键 = 不画箭头（drawio 的 mxConnector 语义）')
    ok(sum('endArrow=none', 'arrow') === '— 无箭头', 'endArrow=none → 无箭头')
    ok(sum('endArrow=classic;startArrow=classic', 'arrow') === '↔ 双向', '两端都有 → 双向')
    ok(sum('startArrow=classic', 'arrow') === '← 反向', '只有起点有 → 反向')
    ok(sum('', 'nonsense') === '', '认不出的类返回空串（不猜）')
  }

  // 字号可以手动调节：输入的解析/夹取是纯函数，边界情况在这里钉住
  const clampFs = internals.clampFontSize
  ok(typeof clampFs === 'function', 'clampFontSize 有导出')
  if (typeof clampFs === 'function') {
    ok(clampFs('18') === 18, '正常输入：18 → 18')
    ok(clampFs(22) === 22, '数字也收：22 → 22')
    ok(clampFs('14.6') === 15, '小数四舍五入到整数：14.6 → 15')
    ok(clampFs('0') === 8, '太小夹到下界：0 → 8')
    ok(clampFs('-5') === 8, '负数也夹到下界：-5 → 8')
    ok(clampFs('999') === 72, '太大夹到上界：999 → 72')
    ok(clampFs('abc') === null, '不是数字 → null（调用方忽略，不写文档）')
    ok(clampFs('') === null && clampFs('   ') === null, '空输入 → null（不把空当成 0）')
    ok(clampFs(null) === null && clampFs(undefined) === null, 'null/undefined → null')
    ok(clampFs('8') === 8 && clampFs('72') === 72, '边界值本身可用')
  }
}

console.log('\n对齐辅助线 / 批量改样式 / 全选')
{
  // ① 对齐辅助线（drawio 的 guides）：与**没在拖的**节点比 左/中/右、上/中/下，
  //    差在容差内就吸过去并把那条线画出来。以**整组的外接框**为准。
  const others = [{ x: 100, y: 0, w: 100, h: 40 }] // 左 100 / 中 150 / 右 200
  const near = { x: 104, y: 300, w: 60, h: 40 } // 左边差 4px（容差 6 内）
  const guides = internals.alignGuidesFor(others, near, 6)
  ok(guides.dx === -4 && guides.dy === 0, '差 4px → 吸过去（dx=-4）：' + JSON.stringify([guides.dx, guides.dy]))
  ok(guides.guides.length === 1 && guides.guides[0].axis === 'x' && guides.guides[0].at === 100, '出一条竖线辅助线（at=100）：' + JSON.stringify(guides.guides))
  ok(
    guides.guides.length === 1 && guides.guides[0].from === 0 && guides.guides[0].to === 340,
    '辅助线范围覆盖两边（0…340）：' + JSON.stringify(guides.guides[0] === undefined ? null : [guides.guides[0].from, guides.guides[0].to]),
  )
  const far = internals.alignGuidesFor(others, { x: 130, y: 300, w: 60, h: 40 }, 6)
  ok(far.dx === 0 && far.dy === 0 && far.guides.length === 0, '差得远（10px）→ 不吸、不画线')
  const mid = internals.alignGuidesFor(others, { x: 122, y: 300, w: 60, h: 40 }, 6) // 中 152 vs 150 → 差 2
  ok(mid.dx === -2 && mid.guides[0].at === 150, '几条都在容差内时取最近的那条（中线 150）：' + JSON.stringify([mid.dx, mid.guides[0].at]))
  const both = internals.alignGuidesFor(others, { x: 104, y: 3, w: 60, h: 40 }, 6) // 左边差 4、顶边差 3
  ok(both.dx === -4 && both.dy === -3 && both.guides.length === 2, '两个轴可以同时吸（并出两条线）：' + JSON.stringify([both.dx, both.dy, both.guides.length]))
  ok(internals.boxOfBoxes([{ x: 10, y: 20, w: 30, h: 40 }, { x: 100, y: 0, w: 20, h: 10 }]).w === 110, '整组外接框：宽 110')
  ok(internals.boxOfBoxes([]) === null, '空集合 → null')

  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 60, h: 60 },
      { id: 'b', x: 200, y: 0, w: 60, h: 60 },
    ],
    edges: [],
    labels: [],
  }
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, { selectedIds: [], guides: [{ axis: 'x', at: 100, from: 0, to: 60 }] }, null)
  const lines = walk(tree, (n) => n.type === 'line' && typeof n.props.key === 'string' && n.props.key.indexOf('guide-') === 0, [])
  ok(lines.length === 1 && lines[0].props.x1 === 100 && lines[0].props.strokeDasharray === '4 3', '辅助线真的画进了 SVG（虚线竖线 x=100），实际 ' + lines.length + ' 条')

  // ② 批量改样式：右键点中的那个在选区里 → 整组（且只挑同类型）
  const isNode = (id) => id === 'n1' || id === 'n2'
  ok(internals.styleTargets(['n1', 'n2'], 'n1', isNode).join(',') === 'n1,n2', '选区里点一个节点 → 整组节点')
  ok(internals.styleTargets(['n1', 'n2'], 'n9', isNode).join(',') === 'n9', '点的不在选区里 → 只改它自己')
  ok(internals.styleTargets(['n1', 'e9', 'n2'], 'n1', isNode).join(',') === 'n1,n2', '连线不在节点操作的名单里（类型分开）')
  ok(internals.styleTargets(['e9'], 'e9', (id) => id === 'e9').join(',') === 'e9', '类型对得上就整组')
  ok(internals.styleTargets([], 'n1', isNode).join(',') === 'n1', '没有选区时就是单个')

  // ③ 全选：节点与连线都算（与框选同一套语义）
  const all = internals.allIdsOf({ nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ id: 'e1' }] })
  ok(all.join(',') === 'n1,n2,e1', '全选 = 节点 + 连线：' + all.join(','))
  ok(internals.allIdsOf({ nodes: [], edges: [] }).length === 0, '空画布全选 → 空')
  ok(internals.allIdsOf(null).length === 0, 'null 文档不炸')
}

console.log('\n框选：节点与连线都要被框到才亮')
{
  // 用户报的："批量框选时线段也应该有被选中的提示" —— 以前框选只收节点，框住一排线时一条都不亮。
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 60, h: 40 },
      { id: 'b', x: 300, y: 200, w: 60, h: 40 },
      { id: 'c', x: 600, y: 0, w: 60, h: 40 },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE },
      { id: 'e2', from: 'a', to: 'c', style: DEFAULT_EDGE_STYLE },
    ],
    labels: [],
  }
  const pts1 = internals.edgeRoutePoints(doc, doc.edges[0])
  ok(pts1 !== null && pts1.length >= 3, 'a→b 是条折线（' + (pts1 === null ? '-' : pts1.length) + ' 点）')

  // 框住 c（它在右边，和 a/b 离得远）→ 必须有 c，且不能牵连 a/b。
  // 注意：c 身上连着 e2 的落点，所以框住一个节点时"从它身上过的线"也会被选中 —— 这是对的。
  const hitsNode = internals.marqueeHits(doc, { x: 595, y: -5, w: 70, h: 50 }, null)
  ok(hitsNode.indexOf('c') >= 0 && hitsNode.indexOf('a') < 0 && hitsNode.indexOf('b') < 0, '框住一个节点：它被选中，远处的节点不受牵连（' + hitsNode.join(',') + '）')
  // 框住 e1 最后一段的中段（y=220 那条，离 e2 的 y=20 很远）→ 只该选中 e1
  const lastA = pts1[pts1.length - 2]
  const lastB = pts1[pts1.length - 1]
  const mid = { x: (lastA.x + lastB.x) / 2, y: (lastA.y + lastB.y) / 2 }
  const hitsLine = internals.marqueeHits(doc, { x: mid.x - 10, y: mid.y - 10, w: 20, h: 20 }, null)
  ok(hitsLine.join(',') === 'e1', '框住折线中间的一段 → 只选中那条线（实际 ' + hitsLine.join(',') + '）')
  // 框住节点 + 从它身上过的线 → 两者都要
  const hitsBoth = internals.marqueeHits(doc, { x: -5, y: -5, w: 100, h: 50 }, null)
  ok(hitsBoth.indexOf('a') >= 0 && hitsBoth.indexOf('e2') >= 0, '框住节点与从它出发的线 → 都选中：' + hitsBoth.join(','))
  // 空框 → 什么都不选
  ok(internals.marqueeHits(doc, { x: 2000, y: 2000, w: 10, h: 10 }, null).length === 0, '框在空白处 → 空选集')
  // 悬空端也要能框到（它的路径算得出来）
  const dangling = {
    version: 2,
    revision: '',
    nodes: [{ id: 'a', x: 0, y: 0, w: 60, h: 40 }],
    edges: [{ id: 'ed', from: 'a', targetPoint: { x: 300, y: 0 }, style: DEFAULT_EDGE_STYLE }],
    labels: [],
  }
  ok(internals.marqueeHits(dangling, { x: 280, y: -10, w: 40, h: 20 }, null).join(',') === 'ed', '悬空端的线也能被框到')

  // 判定按**段**而不是按整条边的外接框：后者会把离得很远的边也选中（drawio 的 cell state 外接框就是这个毛病）
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts1) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const hole = { x: minX + 10, y: minY + 10, w: 30, h: 30 }
  const bboxOverlaps = hole.x < maxX && hole.x + hole.w > minX && hole.y < maxY && hole.y + hole.h > minY
  const hitsHole = internals.marqueeHits(doc, hole, null)
  ok(bboxOverlaps && hitsHole.indexOf('e1') < 0, '框在边的外接框里、但离线还远 → 不选它（按段判定，不是按外接框）：' + hitsHole.join(','))
}

console.log('\n线在文字的位置断开 + 拖动吸附')
{
  // 用户的两条要求：
  //   1) 不要"白色盖一层"（会把网格也盖掉、深色主题下一块白），要真的**不画那一段线**；
  //   2) 拖文字要有**吸附**（与画布其余部分同一套单位：连线几何走半格 5px）。
  const line = [{ x: 0, y: 100 }, { x: 300, y: 100 }]
  const box = { x: 120, y: 92, w: 60, h: 16 }
  const gaps = internals.labelGapsOnPath(line, box)
  ok(gaps.length === 1 && Math.abs(gaps[0].from - 120) < 0.01 && Math.abs(gaps[0].to - 180) < 0.01, '横线上与框相交的一段被挖掉：' + JSON.stringify(gaps))
  const cut = internals.cutPathByGaps(line, gaps)
  ok(cut.length === 2, '挖空后断成两段子折线：' + cut.length)
  ok(
    cut.length === 2 && Math.abs(cut[0][cut[0].length - 1].x - 120) < 0.01 && Math.abs(cut[1][0].x - 180) < 0.01,
    '断开的两个端头正好落在框的两侧：' + JSON.stringify([cut[0][cut[0].length - 1], cut[1][0]]),
  )
  ok(internals.cutPathByGaps(line, []).length === 1, '没有框要挖时原样返回')

  // 长标签压在短边上：两端各留一小截，别把整条线（含箭头）都挖没了
  const short = [{ x: 0, y: 0 }, { x: 40, y: 0 }]
  const wide = internals.cutPathByGaps(short, internals.labelGapsOnPath(short, { x: -60, y: -8, w: 200, h: 16 }))
  ok(wide.length === 2, '框比线还长时仍然画成两截（不是整条消失）：' + wide.length)
  ok(
    wide.length === 2 && wide[0][wide[0].length - 1].x > 0 && wide[1][wide[1].length - 1].x - wide[1][0].x > 0,
    '两端各留了一小截：' + JSON.stringify([wide[0][wide[0].length - 1], [wide[1][0].x, wide[1][wide[1].length - 1].x]]),
  )

  const vline = [{ x: 50, y: 0 }, { x: 50, y: 300 }]
  const vgaps = internals.labelGapsOnPath(vline, { x: 40, y: 120, w: 20, h: 40 })
  ok(vgaps.length === 1 && Math.abs(vgaps[0].from - 120) < 0.01 && Math.abs(vgaps[0].to - 160) < 0.01, '竖线按 y 挖：' + JSON.stringify(vgaps))

  ok(internals.labelGapsOnPath(line, { x: 120, y: 40, w: 60, h: 16 }).length === 0, '框离得远（不压线）→ 一点都不挖')

  // 折角上：框同时压到两段 → 两段各自挖，且合并成一段连续区间
  const corner = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const cgaps = internals.labelGapsOnPath(corner, { x: 90, y: -6, w: 20, h: 20 })
  ok(cgaps.length === 1, '压住折角时挖出的是一段连续区间（相邻区间已合并）：' + JSON.stringify(cgaps))

  // 渲染：d 里出现两个 M（线被断开），断开的位置就是框的两侧
  const doc = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 400, y: 0, w: 160, h: 60 },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', label: '线上的字', style: DEFAULT_EDGE_STYLE }],
  }
  const pts = internals.edgeRoutePoints(doc, doc.edges[0])
  const tree = renderDiagram(doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const path = walk(tree, (n) => n.props.key === 'edge-0', [])[0]
  const d = path === undefined ? '' : path.props.d
  ok((d.match(/M /g) || []).length === 2, '线上有字时，边被画成两条子路径（那一段不画）：' + d)
  const pos = internals.edgeLabelPosition(pts, doc.edges[0])
  const b = internals.labelBox(pos, '线上的字', 10)
  // 第一段子路径的终点应该停在框的左侧（留 2px 余量）
  const first = /M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/.exec(d)
  ok(first !== null && Math.abs(Number(first[3]) - (b.x - 2)) < 1.01, '断口就落在框的左边（含 2px 余量）：' + (first === null ? '-' : first[3]) + ' vs ' + (b.x - 2))
  const hit = walk(tree, (n) => n.props.key === 'edge-hit-0', [])[0]
  ok(hit !== undefined && (hit.props.d.match(/M /g) || []).length === 1, '命中带不挖空（线在字下面也要能点中/拖动）')

  // 吸附：半格（5px）+ 贴线
  const onLine = internals.snapLabelPoint(line, { x: 123, y: 102 })
  ok(onLine.x % 5 === 0 && onLine.y % 5 === 0, '指针吸到半格：' + JSON.stringify(onLine))
  const stuck = internals.snapLabelPoint(line, { x: 123, y: 98 })
  ok(Math.abs(stuck.y - 100) < 1.01, '离线 2px → 贴回线上：' + JSON.stringify(stuck))
  const off = internals.snapLabelPoint(line, { x: 123, y: 112 })
  ok(Math.abs(off.y - 110) < 1.01, '离线 12px（有意挪开）→ 只吸半格，不贴线：' + JSON.stringify(off))
  // 边框那一轴常常不在格上（例如 x=455）：贴线吸附负责这种情形
  const shifted = [{ x: 455, y: 100 }, { x: 455, y: 200 }]
  const near = internals.snapLabelPoint(shifted, { x: 457, y: 152 })
  ok(Math.abs(near.x - 455) < 1.01, '线不在格上时也能贴回线上：' + JSON.stringify(near))
  // 拖一次之后存下来的数：吸附过 → 垂距是半格的整数倍、零头 0（文件里就是干净的数）
  const saved = internals.labelPosFor(line, internals.snapLabelPoint(line, { x: 123, y: 128 }))
  ok(saved !== null && Math.abs(saved.labelY) === 30 && saved.labelOffsetX === 0 && saved.labelOffsetY === 0, '存下来的垂距是半格的整数倍、零头 0：' + JSON.stringify(saved))
}

console.log('\n悬空端：能拖回来、也能拖出去（预览与落盘同一套）')
{
  // 一端悬空的边：`to` 不写，只有 `targetPoint`（drawio 的规则：自由点只在那一端没有真实顶点时生效）。
  const doc = {
    version: 2,
    revision: '',
    nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60 }],
    edges: [{ id: 'e1', from: 'a', targetPoint: { x: 500, y: 300 }, style: DEFAULT_EDGE_STYLE }],
  }
  const geometry = internals.buildGeometry(doc)
  // 拖**悬空**那一端回到某个节点附近：预览必须算得出来（之前 byId 查不到就直接 return null）
  const doc2 = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 400, y: 200, w: 160, h: 60 },
    ],
    edges: [{ id: 'e1', from: 'a', targetPoint: { x: 500, y: 300 }, style: DEFAULT_EDGE_STYLE }],
  }
  const geometry2 = internals.buildGeometry(doc2)
  const toNode = internals.edgePreviewRoute(doc2, geometry2, doc2.edges[0], 'to', { x: 480, y: 230 }, internals.HOT_PAD)
  ok(toNode !== null && toNode.hot !== null && toNode.hot.id === 'b', '拖悬空端到节点上：预览命中该节点：' + JSON.stringify(toNode === null ? null : toNode.hot))
  ok(toNode !== null && Array.isArray(toNode.points) && toNode.points.length >= 2, '预览有折线（不是 null）')
  const toEmpty = internals.edgePreviewRoute(doc2, geometry2, doc2.edges[0], 'to', { x: 700, y: 600 }, internals.HOT_PAD)
  ok(toEmpty !== null && toEmpty.hot === null, '拖到空白处：预览仍然给出折线、hot 为 null（松手就变成悬空端）')
  // 拖**连着节点**的那一端出去（kind='from'）：固定端是悬空端，也要算得出来
  const fromOut = internals.edgePreviewRoute(doc2, geometry2, doc2.edges[0], 'from', { x: -200, y: -100 }, internals.HOT_PAD)
  ok(fromOut !== null, '拖连着节点的那一端出去时也有预览（固定端是悬空端）')
  void geometry

  // 源码接线：松手落空 → 建悬空边；端点落空 → 脱离形状
  const src = composeClientBody()
  ok(/function finishDanglingEdge\(point\)/.test(src), '有 finishDanglingEdge（落在空白处建悬空边）')
  ok(/next\.edges\.push\(\{ id: 'e' \+ \(max \+ 1\), from: link\.from, targetPoint:/.test(src), '建出来的边写的是 targetPoint（没有 to）')
  ok(/delete e\.to\n            e\.targetPoint =/.test(src) || /delete e\.to/.test(src), '端点拖到空处会删掉那一端的顶点、只留自由点')
  ok(/这一端已脱离形状/.test(src), '落空时有状态提示（不然用户以为没反应）')
}

console.log('\n一次性几何迁移：节点对齐整格、折点与自由端点对齐半格')
{
  const off = {
    version: 2,
    revision: 'x',
    meta: { pinned: true },
    nodes: [
      { id: 'n1', label: '甲', style: 'fillColor=#dae8fc;', x: 37, y: 211, w: 186, h: 56 },
      { id: 'n2', label: '乙', style: '', x: 300, y: 200, w: 130, h: 60 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: '带折点', style: 'endArrow=classic;', points: [{ x: 202, y: 93 }, { x: 240, y: 100 }] },
      { id: 'e2', from: 'n1', targetPoint: { x: 503, y: 307 }, style: '' },
    ],
    labels: [{ id: 'L', text: '独立标签', edgeId: null, x: 5, y: 5, offsetX: 0, offsetY: 0, relative: true, style: 'edgeLabel;' }],
  }
  const result = internals.snapDocGeometry(off, { grid: 10, edgeGrid: 5, minW: 60, minH: 40 })
  const n1 = result.doc.nodes[0]
  ok(n1.x === 40 && n1.y === 210 && n1.w === 190 && n1.h === 60, '节点位置与尺寸都对齐到整格：' + JSON.stringify([n1.x, n1.y, n1.w, n1.h]))
  ok(result.doc.nodes[1].x === 300 && result.doc.nodes[1].w === 130, '本来就在格线上的节点不动：' + JSON.stringify([result.doc.nodes[1].x, result.doc.nodes[1].w]))
  const e1 = result.doc.edges[0]
  ok(e1.points[0].x === 200 && e1.points[0].y === 95 && e1.points[1].x === 240 && e1.points[1].y === 100, '折点对齐到半格：' + JSON.stringify(e1.points))
  ok(e1.style === 'endArrow=classic;' && e1.label === '带折点' && e1.from === 'n1' && e1.to === 'n2', '只动几何：style / 标签 / 两端都没碰')
  const e2 = result.doc.edges[1]
  ok(e2.sourcePoint === undefined && e2.targetPoint.x === 505 && e2.targetPoint.y === 305, '自由端点也对齐到半格：' + JSON.stringify(e2.targetPoint))
  ok(e2.to === undefined, '悬空端仍然没有 to（迁移不会替它接上谁）')
  ok(result.doc.labels === off.labels, '独立边标签原样带过（只读，不参与迁移）')
  ok(result.changes > 0, 'changes 报出了改动数量（' + result.changes + '）')

  // 尺寸下限：太小的节点被抬到下限，而不是被抹成 0。
  const tiny = internals.snapDocGeometry({ version: 2, nodes: [{ id: 't', x: 1, y: 1, w: 8, h: 6 }], edges: [] }, { grid: 10, edgeGrid: 5, minW: 60, minH: 40 })
  ok(tiny.doc.nodes[0].w === 60 && tiny.doc.nodes[0].h === 40, '尺寸被抬到下限：' + JSON.stringify([tiny.doc.nodes[0].w, tiny.doc.nodes[0].h]))

  // 已经在格线上 → 一处都不改（幂等），且不改变任何字段。
  const clean = internals.snapDocGeometry(result.doc, { grid: 10, edgeGrid: 5, minW: 60, minH: 40 })
  ok(clean.changes === 0, '再跑一次是幂等的（changes=0）')
  ok(JSON.stringify(clean.doc.nodes) === JSON.stringify(result.doc.nodes) && JSON.stringify(clean.doc.edges) === JSON.stringify(result.doc.edges), '幂等时不产生任何差异')

  // 源码接线：菜单里真的有这个入口
  const src = composeClientBody()
  ok(/item\('整理几何（吸附到格线）', normalizeGeometry/.test(src), '编辑菜单里有「整理几何（吸附到格线）」')
  ok(/snapDocGeometry\(current, \{ grid: GRID, edgeGrid: EDGE_GRID/.test(src), '用的是画布自己的单位（GRID / EDGE_GRID）')
}

console.log('\n顺序（z-order）：菜单里有入口，模型顺序决定覆盖顺序')
{
  const src = composeClientBody()
  ok(/function reorderItem\(kind, id, mode\)/.test(src), '有 reorderItem（节点与边共用）')
  for (const label of ['置顶', '上移', '下移', '置底']) {
    ok(src.indexOf("'" + label + "'") > 0, '菜单里有「' + label + '」')
  }
  ok(/reorderItem\('node', menu\.id, 'front'\)/.test(src) && /reorderItem\('edge', menu\.id, 'front'\)/.test(src), '节点与边的右键菜单都接了')
  // 画布渲染顺序 = 模型顺序：把后画的节点放前面，它的 rect 就更早出现（被压在下面）。
  const two = {
    version: 2,
    revision: '',
    nodes: [
      { id: 'a', x: 0, y: 0, w: 100, h: 60, label: '甲' },
      { id: 'b', x: 50, y: 30, w: 100, h: 60, label: '乙' },
    ],
    edges: [],
  }
  const rectOrder = (doc) => {
    const tree = renderDiagram(doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
    return walk(tree, (n) => n.type === 'rect' && (n.props.width === 100 || n.props.width === 100), []).length
  }
  void rectOrder
  const treeA = renderDiagram(two, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const groupsA = walk(treeA, (n) => n.type === 'g' && typeof n.props['data-node-id'] === 'string', []).map((g) => g.props['data-node-id'])
  const swapped = { version: 2, revision: '', nodes: [two.nodes[1], two.nodes[0]], edges: [] }
  const treeB = renderDiagram(swapped, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  const groupsB = walk(treeB, (n) => n.type === 'g' && typeof n.props['data-node-id'] === 'string', []).map((g) => g.props['data-node-id'])
  ok(groupsA.join(',') === 'a,b' && groupsB.join(',') === 'b,a', '节点的画序跟着模型顺序（' + groupsA.join(',') + ' → ' + groupsB.join(',') + '）')
}

console.log('\n编辑数据：`key=value` 互转、穿过归一化、菜单接线')
{
  ok(internals.formatDataLines({ a: '1', b: '两' }) === 'a=1\nb=两', '数据 → 文本：' + JSON.stringify(internals.formatDataLines({ a: '1', b: '两' })))
  ok(internals.formatDataLines(undefined) === '' && internals.formatDataLines(null) === '', '没有数据 → 空文本（面板里就是空框）')
  const parsed = internals.parseDataLines('  subnet = 10.0.0.1 \n\n# 注释\nowner=我\n没有等号\n=空键\n')
  ok(JSON.stringify(parsed) === JSON.stringify({ subnet: '10.0.0.1', owner: '我' }), '文本 → 数据（裁空白、忽略空行/注释/无等号/=空键）：' + JSON.stringify(parsed))
  ok(internals.parseDataLines('id=x\nlabel=y\n').constructor === Object && Object.keys(internals.parseDataLines('id=x\nlabel=y')).length === 0, 'id / label 不算数据')
  ok(JSON.stringify(internals.parseDataLines(internals.formatDataLines({ k: 'v' }))) === JSON.stringify({ k: 'v' }), '互转是往返的')

  // 穿过归一化：宿主读出来的 data 不能在客户端被抹掉（否则"改数据"改的是空气）
  const viaPayload = internals.docFromPayload({
    ok: true,
    exists: true,
    revision: '',
    notes: [],
    doc: {
      version: 2,
      revision: '',
      nodes: [{ id: 'n1', x: 0, y: 0, w: 100, h: 60, data: { subnet: '10.0.0.0', n: 3 } }],
      edges: [{ id: 'e1', from: 'n1', to: 'n1', style: '', data: { note: 'x' } }],
    },
  })
  ok(viaPayload.error === undefined && viaPayload.doc.nodes[0].data.subnet === '10.0.0.0', '节点的 data 穿过归一化还在')
  ok(viaPayload.doc.nodes[0].data.n === '3', '非字符串值在入口就收敛成字符串：' + JSON.stringify(viaPayload.doc.nodes[0].data))
  ok(viaPayload.doc.edges !== undefined && viaPayload.doc.edges.length === 1, '边照常解析')

  const src = composeClientBody()
  ok(/function openDataEditor\(kind, id\)/.test(src) && /function commitDataEditor\(kind, id, text\)/.test(src), '有编辑数据的开关与提交')
  ok(/openDataEditor\('node', menu\.id\)/.test(src) && /openDataEditor\('edge', menu\.id\)/.test(src), '节点与边的右键菜单都接了「编辑数据…」')
  ok(/className: 'drawai-data'/.test(src) && /\.drawai-data\{/.test(src), '面板用 textarea，样式也在')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
