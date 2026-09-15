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

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
