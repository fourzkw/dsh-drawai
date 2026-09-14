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
import { DEFAULT_EDGE_STYLE, stylePatch } from '../src/style-kernel.js'

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
  // 这里曾经有个真 bug：parseDocument 把"0 个节点"判成错误，于是新建出来的空画布
  // 一进去就是红字「文档里没有可渲染的 nodes」，右键也点不了 —— 等于新建功能废掉。
  const empty = internals.parseDocument('{}')
  ok(empty.error === undefined && empty.doc.nodes.length === 0, '{} 解析成空画布而不是错误')
  const emptyArr = internals.parseDocument('{"nodes":[],"edges":[]}')
  ok(emptyArr.error === undefined && emptyArr.doc.nodes.length === 0, '空 nodes 数组同样可渲染')
  // 该报错的还得报错：文件根本不是画布文档时不能静默当空画布（否则会把别人的文件当成白纸盖掉）。
  ok(internals.parseDocument('{不是 json').error !== undefined, '坏 JSON 仍然报错')
  ok(internals.parseDocument('[]').error !== undefined, '根是数组仍然报错')

  // 空画布要能真的画出来（不抛错、也不是空字符串）。
  const tree = internals.renderDiagram({ nodes: [], edges: [] }, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  ok(tree !== null && tree.type === 'svg', '空画布渲染出 svg（网格纸还在，可以右键加节点）')
}

console.log('\n路径三态：不许静默兜底到 demo.dshd.json')
{
  // 曾经的行为：tab 地址解析不出路径时，画布**悄悄**绑到 demo.dshd.json ——
  // 用户以为在编辑 A，实际在改 B，屏幕上毫无提示。
  // 现在是三态：字符串=用户选的文件 / UNTITLED=未命名画布 / null=回到 tab，tab 也给不出就"未绑定"。
  const UNTITLED = '\u0000untitled'
  const stateOf = (pathOverride, path) => {
    const untitled = pathOverride === UNTITLED
    const overridePath = typeof pathOverride === 'string' && pathOverride.length > 0 ? pathOverride : null
    const tabPath = typeof path === 'string' && path.length > 0 ? path : null
    const unbound = !untitled && overridePath === null && tabPath === null
    const target = untitled ? '' : overridePath !== null ? overridePath : tabPath !== null ? tabPath : ''
    return { untitled: untitled, unbound: unbound, target: target, hasPath: !untitled && target.length > 0 }
  }
  const cases = [
    ['tab 有路径', null, 'demo.dshd.json', true, 'demo.dshd.json'],
    ['新建（未命名）', UNTITLED, 'demo.dshd.json', false, ''],
    ['另存为之后', 'my-flow.dshd.json', 'demo.dshd.json', true, 'my-flow.dshd.json'],
    ['tab 认不出路径', null, undefined, false, ''],
  ]
  for (const [label, ov, p, wantPath, wantTarget] of cases) {
    const s = stateOf(ov, p)
    ok(s.hasPath === wantPath && s.target === wantTarget, label + ' → ' + (s.hasPath ? '绑定 ' + s.target : s.untitled ? '未命名画布' : '未绑定（显式提示）'))
  }
  // 最关键的一条：认不出路径时**绝不能**落到 demo 上。
  ok(stateOf(null, undefined).target !== 'demo.dshd.json', '认不出路径时不会兜底到 demo.dshd.json')

  // 未命名画布必须可渲染（第一屏就是空网格）。
  const blank = internals.parseDocument('{}')
  ok(blank.error === undefined, '未命名画布的空文档解析通过')
  const tree = internals.renderDiagram(blank.doc, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  ok(tree !== null && tree.type === 'svg', '未命名画布渲染出可交互的空画布')
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

console.log('\n多画布标签页：同一文件不重复开、未命名各自独立')
{
  const U = internals.UNTITLED
  let list = [{ key: 'tab:a.dshd.json', path: 'a.dshd.json', untitled: false, unbound: false }]
  let counter = 1
  const open = (path) => {
    const r = internals.openTabIn(list, path, counter)
    list = r.tabs
    counter = r.counter
    return r.active
  }
  ok(open('b.dshd.json') === 'tab:b.dshd.json' && list.length === 2, '打开新文件 → 新开一个标签')
  ok(open('a.dshd.json') === 'tab:a.dshd.json' && list.length === 2, '重复打开已开的文件 → 只切过去，不新开')
  const u1 = open(U)
  const u2 = open(U)
  ok(u1 !== u2 && list.filter((t) => t.untitled).length === 2, '两次「新建」得到两个独立的未命名标签')
  const before = list.length
  ok(open(undefined) === null && list.length === before, '非法路径（undefined）不会造出垃圾标签')
  ok(open('') === null && list.length === before, '空字符串同样被挡掉')

  // 标签名：未命名带序号，其余取文件名
  ok(internals.tabLabelOf(U, 3) === '未命名 3', '未命名标签名带序号')
  ok(internals.tabLabelOf('sub/b.dshd.json', 1) === 'b.dshd.json', '文件标签取文件名（含子目录路径）')
  ok(internals.tabLabelOf('', 1) === '(未绑定)', '未绑定标签有明确名字')
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

console.log('\n标签条只能有一份（出现过"渲染两次"）')
{
  // 曾经同时有两条渲染路径：CanvasTabs 里渲染一份，又通过 tabBar prop 让 CanvasView 渲染第二份，
  // 于是界面上出现两条一模一样的标签栏。现在标签条只由 CanvasTabs 渲染。
  const css = readFileSync(source, 'utf8')
  const marks = [...css.matchAll(/className: 'drawai-tabs'/g)]
  ok(marks.length === 1, "源码里只有一处构建标签条（className: 'drawai-tabs' 出现 " + marks.length + " 次）")
  ok(!/props\.tabBar/.test(css), 'CanvasView 不再接收 tabBar（那条重复渲染路径已删除）')
  ok(!/tabBar: isActive/.test(css), '不再往子组件传递 tabBar')
}

console.log('\n未绑定画布必须说清"AI 改不到它"')
{
  // diagram_apply 只按**文件路径**工作：不传 path 会落到工作区里的 demo.dshd.json（实测），
  // 而未命名/未绑定的画布在屏幕上根本没有文件。不把这件事说出来，
  // 用户对着未命名画布说"画一张流程图"，图就出现在别的文件里，屏幕毫无反应。
  const css = readFileSync(source, 'utf8')
  ok(/AI 对话暂时改不到它/.test(css), '未命名画布的状态栏提示了"AI 改不到它"')
  ok(/AI 对话改不到它/.test(css), '未绑定文件的画布也提示了')
  ok(/先「另存为」给它一个文件名/.test(css), '提示里给出可执行的下一步')
}

console.log('\n地址解析：要认得出绝对路径（否则 tab 永久停在"未绑定"）')
{
  // 原来只认 dsh-resource://file/session/<id>/<rel>，其余一律 undefined。
  // 而地址实际还可能是别的形式（用户那个 tab 就解析不出来 → 永久"(未绑定)"，
  // 屏幕空白、AI 却会去改 demo.dshd.json）。现在按形式逐个处理。
  const cases = [
    ['dsh-resource://file/session/abc/demo.dshd.json', 'demo.dshd.json'],
    ['dsh-resource://file/demo.dshd.json', 'demo.dshd.json'],
    ['file:///D:/ws/a.dshd.json', 'D:/ws/a.dshd.json'],
    ['/D:/ws/a.dshd.json', 'D:/ws/a.dshd.json'],
    ['D:\\ws\\a.dshd.json', 'D:/ws/a.dshd.json'],
    ['D:/ws/sub/a.dshd.json', 'D:/ws/sub/a.dshd.json'],
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
  const U = internals.UNTITLED
  const openTabIn = internals.openTabIn
  const names = (l) => l.map((t) => (t.untitled ? '未命名' : t.path.split(/[\\/]/).pop()))
  let list = [
    { key: 'tab:D:/ws/demo.dshd.json', path: 'D:/ws/demo.dshd.json', untitled: false, unbound: false },
    { key: 'untitled:1', path: U, untitled: true, unbound: false },
    { key: 'tab:D:/ws/bfs.dshd.json', path: 'D:/ws/bfs.dshd.json', untitled: false, unbound: false },
  ]
  let counter = 2
  const baseline = names(list)
  let vanished = 0
  const open = (p) => {
    const before = names(list)
    const r = openTabIn(list, p, counter)
    list = r.tabs
    counter = r.counter
    // 打开操作**绝不允许**让任何已开着的画布消失
    for (const n of before) if (names(list).indexOf(n) < 0) vanished += 1
  }
  open('D:/ws/demo.dshd.json') // 已开着 → 切过去
  open('D:/ws/new.dshd.json') // 没开过 → 新增
  open('D:/ws/new.dshd.json') // 重复 → 不重复开
  open('D:/WS/NEW.dshd.json') // 大小写不同 → 仍是同一个
  open('D:\\ws\\new.dshd.json') // 分隔符不同 → 仍是同一个
  open('D:/ws/third.dshd.json') // 另一个新文件
  open(U) // 新建

  ok(vanished === 0, '7 次打开都没有让已开画布消失')
  for (const n of baseline) ok(names(list).indexOf(n) >= 0, '原有画布仍在：' + n)
  const seg = names(list).filter((n) => n.toLowerCase() === 'new.dshd.json')
  ok(seg.length === 1, '大小写/分隔符不同的同一路径只占一个标签（实际 ' + seg.length + ' 个）')
  ok(names(list).length === 6, '标签总数 = 3 原有 + new + third + 未命名 = 6（实际 ' + names(list).length + '）')
  // 移除标签只有一条路径：closeTab（标签上的 × 按钮）
  const cssText = readFileSync(source, 'utf8')
  ok(/const next = list\.filter\(\(t\) => t\.key !== key\)/.test(cssText), '移除标签只发生在 closeTab（× 按钮）里')
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
  const parsed = internals.parseDocument(JSON.stringify(dangling))
  ok(parsed.error === undefined && parsed.doc.edges.length === 1, '带悬空端的边不会被解析器丢掉（v1 会整条消失）')
  const tree = renderDiagram(parsed.error === undefined ? parsed.doc : { nodes: [], edges: [] }, 'light', 'u1', { current: null }, { selectedIds: [] }, null)
  // 只认**可见的连线 path**：命中层有 className，网格线没有 pointerEvents:none。
  const paths = walk(tree, (n) => n.type === 'path' && n.props.pointerEvents === 'none' && typeof n.props.d === 'string', [])
  ok(paths.length === 1 && paths[0].props.d.indexOf('NaN') < 0, '悬空端的边真的画出了一条合法路径（paths=' + paths.length + '，d=' + (paths.length > 0 ? String(paths[0].props.d).slice(0, 70) : '-') + '）')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
