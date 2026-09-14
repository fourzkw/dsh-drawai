/**
 * 连线预览的路由自测 —— 不需要浏览器，也不需要 DSH 在跑。
 *
 * 为什么值得单独写一个：这个功能的正确性全在**几何**上，而几何在浏览器里只能靠眼睛看。
 * 眼睛看不出"预览折线和落盘折线差了一个折点"这种问题 —— 那正是要避免的回归
 * （预览和结果不一致 = 松手瞬间整条线跳变）。
 *
 * 做法：把 src/client.js 塞进一个最小的 CommonJS 沙箱跑起来，取出它导出的 __routeInternals，
 * 然后逐项断言：
 *   1) 预览折线是正交的（每段都是水平或垂直）且坐标有限；
 *   2) 预览折线**等于**同参数下松手后真正落盘的走线（同一条 routeEdge 通路）；
 *   3) 吸附判定确实会在容差内命中目标、容差外不命中；
 *   4) pathOf() 能把这些折线变成合法的 SVG d（没有 NaN）。
 *
 * 用法：node tools/check-route-preview.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { composeClientBody } from './build.mjs'
// 端点约束的写法与产物完全同源：用内核拼 style，而不是在测试里手抄键名。
import { DEFAULT_EDGE_STYLE, styleWithSide } from '../src/style-kernel.js'

const here = dirname(fileURLToPath(import.meta.url))
// 客户端半边依赖"构建时内联的样式内核"，所以这里 eval 的是**与产物同款的组合 body**。
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

/** 最小沙箱：client.js 是纯 CommonJS，只在模块顶层碰 exports 与 React 的 Component。 */
function loadInternals() {
  const module = { exports: {} }
  // CanvasBoundary extends React.Component 是模块顶层的类声明，所以 React 桩必须够用；
  // 但这里绝不会渲染任何东西 —— 只取纯几何函数。
  const reactStub = {
    Component: class Component {},
    createElement: () => null,
    useState: () => [null, () => {}],
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }
  const require = (spec) => {
    if (spec === 'react') return reactStub
    throw new Error('check-route-preview: 意外 require(' + spec + ')')
  }
  const fn = new Function('module', 'exports', 'require', 'window', 'document', clientBody)
  // window/document 只是占位：路由内核是纯函数，不会碰它们（真碰了就会在这里炸出来，也是有用的信号）。
  fn(module, module.exports, require, {}, {})
  const internals = module.exports.__routeInternals
  if (internals === undefined) throw new Error('src/client.js 没有导出 __routeInternals')
  return internals
}

/** 正交判定：每一段都必须是水平或垂直（容差 0.51 —— pathOf 的圆角与 fmt 的舍入都在其下）。 */
function orthogonal(points) {
  for (let i = 1; i < points.length; i += 1) {
    const dx = Math.abs(points[i].x - points[i - 1].x)
    const dy = Math.abs(points[i].y - points[i - 1].y)
    if (dx > 0.51 && dy > 0.51) return false
  }
  return true
}

function finite(points) {
  for (let i = 0; i < points.length; i += 1) {
    if (!Number.isFinite(points[i].x) || !Number.isFinite(points[i].y)) return false
  }
  return true
}

const internals = loadInternals()
const hotPad = internals.HOT_PAD

/** 测试文档：故意放一个"挡在中间"的节点，逼路由绕行，这样比直线更能暴露问题。 */
const doc = {
  nodes: [
    { id: 'a', x: 0, y: 0, w: 160, h: 60, label: 'A' },
    { id: 'b', x: 420, y: 300, w: 160, h: 60, label: 'B' },
    { id: 'wall', x: 180, y: 40, w: 120, h: 200, label: '挡路的' },
    { id: 'near', x: 300, y: 20, w: 120, h: 56, label: '近邻' },
  ],
  edges: [],
}
const geometry = internals.buildGeometry(doc)
const aBox = geometry.byId.a

console.log('routePreviewFor / 空白处拖拽')
{
  const cursor = { x: 600, y: 500 }
  const route = internals.routePreviewFor(doc, geometry, cursor, 'a', aBox.geo, { from: 'a', side: 'e' }, hotPad, 'a')
  ok(route !== null, '空白处也能算出预览（返回非 null）')
  ok(route.hot === null, '空白处不认目标节点（hot === null）')
  ok(Array.isArray(route.points) && route.points.length >= 2, '预览折线至少两个点')
  ok(finite(route.points), '预览折线坐标全部有限')
  ok(orthogonal(route.points), '预览折线是正交折线（无斜段）')
  const last = route.points[route.points.length - 1]
  ok(Math.abs(last.x - cursor.x) < 0.51 && Math.abs(last.y - cursor.y) < 0.51, '预览折线终点就是指针位置')
  const d = internals.pathOf(route.points, 6)
  ok(d.length > 0 && d.indexOf('NaN') < 0 && d.indexOf('Infinity') < 0, 'pathOf() 产出合法 d（无 NaN/Infinity）')
}

console.log('\n吸附：落在容差内 / 容差外')
{
  const bBox = geometry.byId.b
  // 正好压在 b 的边框上、以及边框外 hotPad-1 处，都该吸附到 b。
  const onBorder = { x: bBox.geo.x + bBox.geo.w + hotPad - 1, y: bBox.geo.y + 10 }
  const outside = { x: bBox.geo.x + bBox.geo.w + hotPad + 5, y: bBox.geo.y + 10 }
  const inside = { x: bBox.geo.x + 40, y: bBox.geo.y + 20 }
  const near = internals.routePreviewFor(doc, geometry, onBorder, 'a', aBox.geo, { from: 'a', side: 'e' }, hotPad, 'a')
  const far = internals.routePreviewFor(doc, geometry, outside, 'a', aBox.geo, { from: 'a', side: 'e' }, hotPad, 'a')
  const hit = internals.routePreviewFor(doc, geometry, inside, 'a', aBox.geo, { from: 'a', side: 'e' }, hotPad, 'a')
  ok(near.hot !== null && near.hot.id === 'b', '边框外 ' + (hotPad - 1) + 'px 仍吸附到 b')
  ok(far.hot === null, '边框外 ' + (hotPad + 5) + 'px 不吸附')
  ok(hit.hot !== null && hit.hot.id === 'b', '指针压在 b 内部时吸附到 b')
  ok(finite(hit.points) && orthogonal(hit.points), '吸附态的预览折线同样正交且有限')
  // 吸附时折线终点应落在目标边框上（而不是指针位置）—— 这正是"看起来已经接上了"的来源。
  const end = hit.points[hit.points.length - 1]
  const onEdge =
    Math.abs(end.x - bBox.geo.x) < 0.51 ||
    Math.abs(end.x - (bBox.geo.x + bBox.geo.w)) < 0.51 ||
    Math.abs(end.y - bBox.geo.y) < 0.51 ||
    Math.abs(end.y - (bBox.geo.y + bBox.geo.h)) < 0.51
  ok(onEdge, '吸附时预览折线终点贴在目标边框上')
}

console.log('\n预览 == 落盘（逐点一致 / 同一条 routeEdge 通路）')
{
  // 落盘路径就是 onNodePointerUp 的那一套：两端选中的端点写进 style 的 exitX/exitY 与 entryX/entryY。
  // 预览用的是 routePreviewFor(..., seed)。两者必须逐点一致，否则松手会跳变。
  const bBox = geometry.byId.b
  const cursor = { x: bBox.geo.x + 20, y: bBox.geo.y + 20 }
  const route = internals.routePreviewFor(doc, geometry, cursor, 'a', aBox.geo, { from: 'a', side: 'e' }, hotPad, 'a')
  const committed = {
    id: 'e1',
    from: 'a',
    to: 'b',
    style: styleWithSide(styleWithSide(DEFAULT_EDGE_STYLE, 'source', route.sides.from), 'target', route.sides.to),
  }
  const docWithEdge = { nodes: doc.nodes, edges: [committed] }
  const landed = internals.buildGeometry(docWithEdge)
  const drawn = internals.edgeRoutePoints(docWithEdge, committed)
  const same =
    drawn.length === route.points.length &&
    drawn.every((p, i) => Math.abs(p.x - route.points[i].x) < 0.51 && Math.abs(p.y - route.points[i].y) < 0.51)
  ok(same, '预览折线与落盘（端点约束写进 style）折线逐点一致（' + route.points.length + ' 个点）')
  ok(committed.points === undefined, '落盘不再把端点约束伪装成折点：edge.points 仍然是空的')
  const storedSides = internals.sidesFromStyle(committed.style)
  ok(storedSides.source === 'e' && storedSides.target === route.sides.to, '两端约束确实落在 style 的 exit*/entry* 上')
  ok(orthogonal(drawn), '落盘折线正交')
  // 更强的一条：预览的候选集与落盘完全同构时，代价也必须相等。
  // （预览把目标节点换成 __preview、并额外把目标本身当障碍 —— 这里用预览自己的代价做对照。）
  const previewCost = internals.pathCost(route.points, geometry.boxes, { a: true, b: true })
  const storedCost = internals.pathCost(drawn, landed.boxes, { a: true, b: true })
  ok(previewCost.hits === storedCost.hits && Math.abs(previewCost.length - storedCost.length) < 0.51, '预览与落盘代价一致（hits ' + previewCost.hits + '）')
}

console.log('\n障碍避让：能绕开时确实绕开')
{
  // 单独造一个"绕开很便宜"的场景：挡路方块正好压在 A 的水平出线上，指针在它右边。
  // 路由器是软惩罚（穿一个盒子要付代价），所以这种场景下它必然会绕。
  // 注意不能要求"任何情况下都不穿盒" —— 盒挤满时穿一个是算法给出的最优解，
  // 预览的职责是**如实反映**这个最优解，而不是比落盘更聪明（那才会让松手瞬间跳变）。
  const docA = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 120, h: 56 },
      { id: 'block', x: 300, y: 10, w: 80, h: 80 },
    ],
    edges: [],
  }
  const geoA = internals.buildGeometry(docA)
  const block = geoA.byId.block.geo
  const crossesBox = (pts, box) => {
    let n = 0
    for (let i = 1; i < pts.length; i += 1) {
      const x1 = Math.min(pts[i - 1].x, pts[i].x)
      const x2 = Math.max(pts[i - 1].x, pts[i].x)
      const y1 = Math.min(pts[i - 1].y, pts[i].y)
      const y2 = Math.max(pts[i - 1].y, pts[i].y)
      if (x1 < box.x + box.w && x2 > box.x && y1 < box.y + box.h && y2 > box.y) n += 1
    }
    return n
  }

  // (a) 自由路由（没有指定引出边）：这里避让必须生效 —— 六选一里有一条干净的。
  const free = internals.routePreview(
    { id: 'a', geo: geoA.byId.a.geo, label: 'a' },
    { id: '__cursor', geo: { x: 600, y: 48, w: 0, h: 0 }, boxes: geoA.boxes, bounds: geoA.bounds },
    null,
  )
  ok(free.length >= 3, '自由路由绕行时有折点（' + free.length + ' 个点）')
  ok(crossesBox(free, block) === 0, '自由路由绕开了挡路节点')

  // (b) 指定了引出边（用户按住 E 手柄拖出来）：引出侧是**用户给定的必经点**，
  //     路由必须照它走 —— 哪怕因此穿过障碍。预览在这里的职责是如实预告，不是自作聪明绕开：
  //     预览一旦比落盘聪明，松手瞬间就会跳变，那正是这次要消灭的毛病。
  const seeded = internals.routePreviewFor(docA, geoA, { x: 600, y: 48 }, 'a', geoA.byId.a.geo, { from: 'a', side: 'e' }, hotPad, 'a')
  ok(seeded.points.length >= 2 && finite(seeded.points) && orthogonal(seeded.points), '钉住引出侧时预览依然正交且有限')
  // 折线从**形状边框**起笔（视觉上就是贴着形状出来的），但要经过该侧的 stub 折点 —— 那个 stub 才是
  // 真正钉住"从这一边引出"的东西（和 onNodePointerUp 落盘时写的 points 是同一个点）。
  const stub = { x: geoA.byId.a.geo.x + geoA.byId.a.geo.w + 24, y: geoA.byId.a.geo.y + geoA.byId.a.geo.h / 2 }
  const onPath = seeded.points.some((p) => Math.abs(p.x - stub.x) < 0.51 && Math.abs(p.y - stub.y) < 0.51)
  ok(onPath, '钉住引出侧时折线经过该侧的 stub（与落盘一致）')
  ok(Math.abs(seeded.points[0].x - (geoA.byId.a.geo.x + geoA.byId.a.geo.w)) < 0.51, '折线从形状边框起笔')

  // (c) 差分：同一条 routeEdge 直接算，必须给出同一条折线（预览没有自己另搞一套）。
  const direct = internals.routePreviewFor(docA, geoA, { x: 600, y: 48 }, 'a', geoA.byId.a.geo, { from: 'a', side: 'e' }, hotPad, 'a')
  const identical =
    direct.points.length === seeded.points.length &&
    direct.points.every((p, i) => Math.abs(p.x - seeded.points[i].x) < 0.51 && Math.abs(p.y - seeded.points[i].y) < 0.51)
  ok(identical, 'routePreview 与 routePreviewFor 结果一致（同一条路由通路）')
}

console.log('\n改接端点预览')
{
  const doc2 = { nodes: doc.nodes, edges: [{ id: 'e1', from: 'a', to: 'b' }] }
  const geo2 = internals.buildGeometry(doc2)
  const edge = doc2.edges[0]
  const cursorNear = { x: geometry.byId.near.geo.x + 20, y: geometry.byId.near.geo.y + 20 }
  const toSide = internals.edgePreviewRoute(doc2, geo2, edge, 'to', cursorNear, hotPad)
  ok(toSide !== null && Array.isArray(toSide.points), '拖 to 端能算出预览折线')
  ok(orthogonal(toSide.points) && finite(toSide.points), '拖 to 端预览正交且有限')
  ok(toSide.hot !== null && toSide.hot.id === 'near', '拖 to 端吸附到 near')
  const fromSide = internals.edgePreviewRoute(doc2, geo2, edge, 'from', cursorNear, hotPad)
  ok(fromSide !== null && Array.isArray(fromSide.points), '拖 from 端能算出预览折线')
  ok(orthogonal(fromSide.points) && finite(fromSide.points), '拖 from 端预览正交且有限')
  ok(fromSide.points[0].x !== undefined, '拖 from 端折线是从被拖那一侧开始的')
  const dFrom = internals.pathOf(fromSide.points, 6)
  ok(dFrom.length > 0 && dFrom.indexOf('NaN') < 0, '拖 from 端 pathOf() 合法')
  ok(fromSide.hot !== null && fromSide.hot.id === 'near', '拖 from 端也吸附到 near')
  // 排除语义：被拖走的那一端自己（a 或 b）不算落点。
  // 下面两个坐标都取在**空白处**（b 的右下角外，wall/near 都覆盖不到），
  // 于是"被排除的节点没被算进来"就表现为 hot === null。
  const emptyNearOldFrom = { x: geo2.byId.a.geo.x + 20, y: geo2.byId.a.geo.y + 20 }
  const selfA = internals.edgePreviewRoute(doc2, geo2, edge, 'to', emptyNearOldFrom, hotPad)
  ok(selfA.hot === null, '拖 to 端时旧起点 a 不算落点（该处无其它节点）')
  ok(Array.isArray(selfA.points) && finite(selfA.points) && orthogonal(selfA.points), '不算落点时仍给出有效预览折线')
  // 反过来：拖 to 端到 b 自己身上是**合法的**（原地重接，b 是当前的固定端），必须给提示。
  const onB = { x: geo2.byId.b.geo.x + 20, y: geo2.byId.b.geo.y + 20 }
  const selfB = internals.edgePreviewRoute(doc2, geo2, edge, 'to', onB, hotPad)
  ok(selfB.hot !== null && selfB.hot.id === 'b', '拖 to 端落在固定端 b 上仍然给出提示')
  ok(internals.hitNodeAt(doc2, geo2, onB.x, onB.y, hotPad, 'b') === null, 'hitNodeAt 的 excludeId 确实排除了指定节点')
}

console.log('\n命中判定边界')
{
  ok(internals.hitNodeAt(doc, geometry, -5, -5, 0, null) === null, '容差 0 时形状外不命中')
  ok(internals.hitNodeAt(doc, geometry, -5, -5, 10, null) !== null, '容差 10 时形状外命中')
  ok(internals.hitNodeAt(doc, geometry, 10, 10, 10, 'a') === null, 'excludeId 生效')
  // 后画的压在先画的上面：倒序命中应命中文档里靠后的 wall 而不是 a。
  ok(internals.hitNodeAt(doc, geometry, aBox.geo.x + 5, aBox.geo.y + 5, 0, null).id === 'a', '无重叠时命中自身')
}

console.log('\n端点选择：指针靠近哪一边就接哪一边，且预览 == 落盘')
{
  const d = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60, label: 'A' },
      { id: 'b', x: 400, y: 300, w: 160, h: 60, label: 'B' },
    ],
    edges: [],
  }
  const geo = internals.buildGeometry(d)
  const aGeo = geo.byId.a.geo
  const bGeo = geo.byId.b.geo
  const anchors = internals.anchorSidesOf(bGeo)
  const cursorFor = (side) => {
    const a = anchors[side]
    return { x: a.x + (side === 'e' ? 14 : side === 'w' ? -14 : 0), y: a.y + (side === 's' ? 14 : side === 'n' ? -14 : 0) }
  }

  for (const side of internals.SIDES) {
    const route = internals.routePreviewFor(d, geo, cursorFor(side), 'a', aGeo, { from: 'a', side: 'e' }, hotPad, 'a')
    ok(route !== null && route.sides.to === side, '指针靠 ' + side + ' → 选中该端点（实际 ' + (route === null ? 'null' : route.sides.to) + '）')
    const a = anchors[side]
    const end = route.points[route.points.length - 1]
    ok(Math.abs(end.x - a.x) < 0.51 && Math.abs(end.y - a.y) < 0.51, '预览线末端正好落在 ' + side + ' 这个端点上（' + end.x + ',' + end.y + '）')

    // 松手落盘：把**同一对端点**写进 style 的 exit*/entry*，再重新路由 —— 必须和预览逐点相同。
    // 这条是"端点提示不是仅供参考"的核心保证：看到接哪边，存下来就接哪边。
    const committed = {
      id: 'e1',
      from: 'a',
      to: 'b',
      style: styleWithSide(styleWithSide(DEFAULT_EDGE_STYLE, 'source', route.sides.from), 'target', route.sides.to),
    }
    const after = internals.edgeRoutePoints({ nodes: d.nodes, edges: [committed] }, committed)
    const same =
      after.length === route.points.length &&
      after.every((p, i) => Math.abs(p.x - route.points[i].x) < 0.51 && Math.abs(p.y - route.points[i].y) < 0.51)
    ok(same, side + ' 方向：预览与落盘逐点一致（' + route.points.length + ' 点）')
  }

  // 指针落在节点正中：n/s 一对、e/w 一对等距，必须稳定且用"朝向源节点"打破平局。
  const middle = { x: bGeo.x + bGeo.w / 2, y: bGeo.y + bGeo.h / 2 }
  const first = internals.routePreviewFor(d, geo, middle, 'a', aGeo, { from: 'a', side: 'e' }, hotPad, 'a')
  let stable = true
  for (let i = 0; i < 5; i += 1) {
    const again = internals.routePreviewFor(d, geo, middle, 'a', aGeo, { from: 'a', side: 'e' }, hotPad, 'a')
    if (again.sides.to !== first.sides.to) stable = false
  }
  ok(stable, '指针落在节点正中时不会来回跳（选中 ' + first.sides.to + '）')
  // A 在 B 的左上：n 与 s 等距，取更靠源节点的 n。
  ok(first.sides.to === 'n', '正中时用朝向源节点打破平局（源在左上 → n）')
  // 源在正下方时，同样等距的一对里该取 s —— 说明判据真的在起作用，不是恒定取第一个。
  const below = {
    nodes: [
      { id: 'a', x: 400, y: 700, w: 160, h: 60, label: 'A' },
      { id: 'b', x: 400, y: 300, w: 160, h: 60, label: 'B' },
    ],
    edges: [],
  }
  const geoBelow = internals.buildGeometry(below)
  const pickBelow = internals.routePreviewFor(below, geoBelow, middle, 'a', geoBelow.byId.a.geo, { from: 'a', side: 'n' }, hotPad, 'a')
  ok(pickBelow.sides.to === 's', '源在正下方时平移选中 s（判据随源位置变化）')
}

console.log('\n改接端点：预览必须 == 落盘（两个方向、含带折点的边）')
{
  // 这一节是有来由的回归：之前只测了拖 to 端，于是"拖 from 端"整条路径**方向反了** ——
  // 预览从固定端画到指针，落盘却是从指针端画到固定端，两者逐点比对一正一反，
  // 用户看到的就是"预览和实际画出来的不是一条线"。
  const d = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 400, y: 300, w: 160, h: 60 },
      { id: 'c', x: 0, y: 400, w: 160, h: 60 },
    ],
    edges: [],
  }
  const geo = internals.buildGeometry(d)
  const geoOf = (id) => geo.byId[id].geo
  const boxOf = (id) => ({ id: id, geo: geoOf(id) })

  /** 复刻 finishEdgeDrag 的落盘判定：把两端约束写进 style，用户折点原样保留。 */
  const drop = (edge, kind, targetId, movedSide) => {
    const fixedEnd = kind === 'from' ? 'target' : 'source'
    const fixedSide = internals.pinnedSideOf(edge, fixedEnd)
    let style = typeof edge.style === 'string' ? edge.style : DEFAULT_EDGE_STYLE
    style = styleWithSide(style, kind === 'from' ? 'source' : 'target', movedSide)
    style = styleWithSide(style, kind === 'from' ? 'target' : 'source', fixedSide)
    const next = { id: edge.id, from: kind === 'from' ? targetId : edge.from, to: kind === 'to' ? targetId : edge.to, style: style }
    if (Array.isArray(edge.points)) next.points = edge.points.map((p) => ({ x: p.x, y: p.y }))
    return next
  }

  const cursorFor = (nodeId, side) => {
    const a = internals.anchorSidesOf(geoOf(nodeId))[side]
    return { x: a.x + (side === 'e' ? 14 : side === 'w' ? -14 : 0), y: a.y + (side === 's' ? 14 : side === 'n' ? -14 : 0) }
  }
  const compare = (label, edge, kind, targetId, side) => {
    const docE = { nodes: d.nodes, edges: [edge] }
    const ghost = internals.edgePreviewRoute(docE, internals.buildGeometry(docE), edge, kind, cursorFor(targetId, side), hotPad)
    const landed = drop(edge, kind, targetId, ghost === null ? null : ghost.side)
    const after = internals.edgeRoutePoints({ nodes: d.nodes, edges: [landed] }, landed)
    const agree =
      ghost !== null &&
      after.length === ghost.points.length &&
      after.every((p, i) => Math.abs(p.x - ghost.points[i].x) < 0.51 && Math.abs(p.y - ghost.points[i].y) < 0.51)
    return ok(agree, label + (agree ? '' : ' —— ghost ' + JSON.stringify(ghost && ghost.points) + ' / drawn ' + JSON.stringify(after)))
  }

  for (const side of internals.SIDES) {
    compare('拖 to 端到 a 的 ' + side + '：预览 == 落盘', { id: 'e1', from: 'c', to: 'b' }, 'to', 'a', side)
  }
  for (const side of internals.SIDES) {
    compare('拖 from 端到 a 的 ' + side + '：预览 == 落盘（方向不能反）', { id: 'e2', from: 'c', to: 'b' }, 'from', 'a', side)
  }
  // 带折点的边：旧折点该留的留、该丢的丢，且预览与落盘一致。
  for (const side of internals.SIDES) {
    compare(
      '带折点的边拖 to 端到 a 的 ' + side + '：预览 == 落盘',
      { id: 'e3', from: 'c', to: 'b', points: [{ x: 300, y: 330 }] },
      'to',
      'a',
      side,
    )
  }
}

console.log('\n拖动线段：松手不该跳变（prune 只能改表示、不能改几何）')
{
  const d = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 160, h: 60 },
      { id: 'b', x: 400, y: 300, w: 160, h: 60 },
    ],
    edges: [],
  }
  const segLen = (p, q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y)
  const trips = [[], [{ x: 300, y: 30 }], [{ x: 300, y: 30 }, { x: 300, y: 220 }]]
  let checked = 0
  let bad = 0
  for (const seed of trips) {
    const edge = { id: 'e1', from: 'a', to: 'b' }
    if (seed.length > 0) edge.points = seed.map((p) => ({ x: p.x, y: p.y }))
    const pts0 = internals.edgeRoutePoints({ nodes: d.nodes, edges: [edge] }, edge)
    for (let index = 0; index < pts0.length - 1; index += 1) {
      const points = Array.isArray(edge.points) ? edge.points.slice() : []
      const pinA = internals.ensurePinned(pts0, points, index)
      const pinB = internals.ensurePinned(pts0, points, index + 1)
      if (pinA < 0 || pinB < 0 || pinA === pinB) continue
      const saved = points.map((p) => ({ x: p.x, y: p.y }))
      const horizontal = Math.abs(pts0[index].y - pts0[index + 1].y) < 0.5
      for (const delta of [30, -40, 70]) {
        const moved = saved.map((p, i) =>
          i === pinA || i === pinB ? { x: p.x + (horizontal ? 0 : delta), y: p.y + (horizontal ? delta : 0) } : { x: p.x, y: p.y },
        )
        const live = { nodes: d.nodes, edges: [{ id: 'e1', from: 'a', to: 'b', points: moved }] }
        const livePts = internals.edgeRoutePoints(live, live.edges[0])
        const pruned = internals.prunePoints(live, live.edges[0])
        const afterEdge = { id: 'e1', from: 'a', to: 'b', points: pruned }
        const afterPts = internals.edgeRoutePoints({ nodes: d.nodes, edges: [afterEdge] }, afterEdge)
        checked += 1
        const same =
          afterPts.length === livePts.length &&
          afterPts.every((p, i) => Math.abs(p.x - livePts[i].x) < 0.51 && Math.abs(p.y - livePts[i].y) < 0.51)
        if (!same) bad += 1
      }
    }
  }
  ok(checked > 0, '覆盖到 ' + checked + ' 种拖动（起始折点 × 段 × 位移）')
  ok(bad === 0, '松手后的几何与拖动中完全相同（' + bad + ' 处跳变）')
  void segLen
}

console.log('\n线不能穿进节点内部（折点/锚点落在节点里时）')
{
  // 判定要把盒子内缩 ε：贴着边框走**不算**进去（很多正常路径就走在边框上）。
  const interior = (a, b, geo) => {
    const E = 0.5
    const box = { x: geo.x + E, y: geo.y + E, w: geo.w - 2 * E, h: geo.h - 2 * E }
    const dx = b.x - a.x
    const dy = b.y - a.y
    let t0 = 0
    let t1 = 1
    const clip = (p, q) => {
      if (Math.abs(p) < 1e-9) return q >= 0
      const r = q / p
      if (p < 0) {
        if (r > t1) return false
        if (r > t0) t0 = r
      } else {
        if (r < t0) return false
        if (r < t1) t1 = r
      }
      return true
    }
    if (!clip(-dx, a.x - box.x) || !clip(dx, box.x + box.w - a.x) || !clip(-dy, a.y - box.y) || !clip(dy, box.y + box.h - a.y)) return 0
    if (t1 <= t0) return 0
    return Math.abs((t1 - t0) * (Math.abs(dx) + Math.abs(dy)))
  }
  const deepest = (nodes, pts) => {
    let worst = 0
    for (const n of nodes) {
      for (let i = 1; i < pts.length; i += 1) worst = Math.max(worst, interior(pts[i - 1], pts[i], n))
    }
    return worst
  }
  const nodes = [
    { id: 'a', x: 0, y: 0, w: 160, h: 60 },
    { id: 'b', x: 400, y: 300, w: 160, h: 60 },
  ]

  // 折点落在节点内部：路由要先把它推出去，否则线会扎进节点 80px（实测过）。
  const cases = [
    ['折点在源节点内部', { x: 80, y: 30 }],
    ['折点在目标节点内部', { x: 480, y: 330 }],
    ['折点在目标边框上', { x: 400, y: 330 }],
    ['折点在两节点之间', { x: 300, y: 150 }],
  ]
  for (const [label, wp] of cases) {
    const edge = { id: 'e', from: 'a', to: 'b', points: [wp] }
    const pts = internals.edgeRoutePoints({ nodes, edges: [edge] }, edge)
    ok(deepest(nodes, pts) <= 0.5, label + '：线只在边框上或外部（最深 ' + Math.round(deepest(nodes, pts) * 10) / 10 + 'px）')
  }
}

console.log('\n折线不该在空地上来回折返（"不是最简洁路径"就是这条）')
{
  // 判据要说准：折点序列是**用户摆的**，它自己绕来绕去（466 → 153 → 466）不是路由器的错，
  // 路由器也不该擅自重排。可断言的是"**在给定折点序列下已经最短**"：
  //   路径长度 ≤ 起点→折点1→…→终点 的曼哈顿距离之和 + 3×段数
  // （那个余量是进出形状边框那一小段，横向/纵向各算一次）。
  //
  // 这条缺陷的实例：doc 的东侧起点 (246,433) 先向右跑到 x=466，再折回 x=153 ——
  // 因为 connectOrtho 当时无条件沿用"上一段的方向"决定先横还是先竖，完全不管目标在哪边。
  const docGeo = { x: 60, y: 390, w: 186, h: 86 }
  const humanGeo = { x: 400, y: 150, w: 132, h: 56 }
  const db = { id: 'doc', geo: docGeo, label: 'doc' }
  const hb = { id: 'human', geo: humanGeo, label: 'human' }
  const lengthOf = (pts) => {
    let n = 0
    for (let i = 1; i < pts.length; i += 1) n += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
    return Math.round(n)
  }
  const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  const lowerBound = (from, to, wps) => {
    let total = manhattan(from, wps[0])
    for (let i = 1; i < wps.length; i += 1) total += manhattan(wps[i - 1], wps[i])
    total += manhattan(wps[wps.length - 1], to)
    return total
  }

  const cases = [
    ['截图那条（3 折点）', [{ x: 466, y: 126 }, { x: 153, y: 366 }, { x: 153, y: 500 }]],
    ['单折点', [{ x: 466, y: 300 }]],
    ['两折点', [{ x: 466, y: 260 }, { x: 300, y: 260 }]],
    ['折点在反方向', [{ x: 100, y: 460 }]],
  ]
  for (const [label, wps] of cases) {
    const pts = internals.routeThroughWaypoints(db, hb, wps)
    const from = internals.borderPointToward(docGeo, wps[0])
    const to = internals.borderPointToward(humanGeo, wps[wps.length - 1])
    const bound = lowerBound(from, to, wps) + 3 * (wps.length + 1)
    const len = lengthOf(pts)
    ok(len <= bound, label + '：在给定折点下已接近最短（' + len + ' ≤ 下界+' + 3 * (wps.length + 1) + ' = ' + bound + '）')
  }

  // 具体防回归：旧算法在这两条上远超下界（截图那条 1341 vs 下界 ~950）。
  ok(lengthOf(internals.routeThroughWaypoints(db, hb, cases[0][1])) < 1150, '截图那条已收敛（旧算法 1341）')
  ok(lengthOf(internals.routeThroughWaypoints(db, hb, cases[2][1])) <= 450, '两折点那条已收敛（旧算法 741）')
}

console.log('\n共线化简：必须保首尾（这里翻过两次车）')
{
  const simp = internals.simplifyCollinear
  const L = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }]
  const ls = simp(L)
  ok(ls.length === 2, '三点共线 → 留 2 点')
  ok(ls[0].y === 0 && ls[1].y === 100, '保留的是**首尾**，不是后两点')

  const Z = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 120 }]
  const zs = simp(Z)
  ok(zs.length === 4, 'Z 形路径一点都不能少（4 点进、4 点出）')
  ok(zs[0].x === 0 && zs[0].y === 0, 'Z 形的起笔点还在')

  // 连续四个共线点：用 points[i+1] 当邻居的老实现会漏掉一个，留下多余的一段。
  const four = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }, { x: 0, y: 30 }]
  ok(simp(four).length === 2, '四点共线 → 留 2 点（不会漏成一个）')
  ok(simp([]).length === 0 && simp([{ x: 1, y: 1 }]).length === 1, '空/单点不炸')
}

console.log('\n中心对齐：差几个像素的节点不该连出斜台阶')
{
  const near = { x: 60, y: 390, w: 186, h: 86 }
  const close = { x: 80, y: 580, w: 143, h: 56 } // 中心 151.5，与 near 的 153 差 1.5
  const snapped = internals.snapNearAxis(near, close)
  ok(Math.abs(snapped.from.x + snapped.from.w / 2 - (snapped.to.x + snapped.to.w / 2)) < 0.01, '中心差 1.5px → 对齐成同一个值')
  ok(snapped.from.y === near.y && snapped.to.y === close.y, '只改 x（错开发生在横向），y 不动')
  ok(snapped.from.w === near.w && snapped.from.h === near.h, '对齐不改变尺寸')

  // demo 里 fs(151.5) / check(155) 差 3.5px，也是自动布局的零头，同样必须并掉。
  const check = { x: 80, y: 720, w: 150, h: 90 }
  const snapped2 = internals.snapNearAxis(close, check)
  ok(Math.abs(snapped2.from.x + snapped2.from.w / 2 - (snapped2.to.x + snapped2.to.w / 2)) < 0.01, '中心差 3.5px 也要对齐')

  // 差得远就绝不碰：那是作者有意摆的错位。
  const off = { x: 600, y: 580, w: 143, h: 56 }
  const kept = internals.snapNearAxis(near, off)
  ok(kept.from.x === near.x && kept.to.x === off.x, '中心差得远 → 原样返回')
}

console.log('\n悬空端：自由点只在该端没有真实顶点时生效（drawio 语义）')
{
  const d = { nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60 }], edges: [] }
  // 目标端悬空：路由器把自由点当零尺寸目标盒 —— 和预览给"空白处光标"用的是同一个技巧。
  const dangling = { id: 'e1', from: 'a', targetPoint: { x: 600, y: 400 } }
  const pts = internals.edgeRoutePoints(d, dangling)
  ok(pts !== null && pts.length >= 2, '悬空端也能算出路径（不会被整条丢掉）')
  const last = pts === null ? null : pts[pts.length - 1]
  ok(last !== null && Math.abs(last.x - 600) < 0.51 && Math.abs(last.y - 400) < 0.51, '路径终点就是那个自由点')
  ok(pts !== null && orthogonal(pts) && finite(pts), '悬空端路径正交且有限')

  // 同一端既有顶点又有自由点 → 自由点被忽略，仍然接在那个节点上。
  const d2 = { nodes: [{ id: 'a', x: 0, y: 0, w: 160, h: 60 }, { id: 'b', x: 600, y: 400, w: 160, h: 60 }], edges: [] }
  const both = { id: 'e2', from: 'a', to: 'b', targetPoint: { x: 20, y: 20 } }
  const pts2 = internals.edgeRoutePoints(d2, both)
  const end2 = pts2 === null ? null : pts2[pts2.length - 1]
  const onB = end2 !== null && end2.x >= 599.49 && end2.x <= 760.51 && end2.y >= 399.49 && end2.y <= 460.51
  ok(pts2 !== null && onB, '端点连着真实顶点时 targetPoint 被忽略（仍然接在节点边框上）')

  // 两端都悬空：drawio 里这种边也合法，照样要画得出来。
  const free = { id: 'e3', sourcePoint: { x: 0, y: 0 }, targetPoint: { x: 300, y: 200 } }
  const pts3 = internals.edgeRoutePoints(d, free)
  ok(pts3 !== null && pts3.length >= 2 && orthogonal(pts3) && finite(pts3), '两端都悬空也能画')
}

console.log('\n真机报过的组合：新节点上方 → 目标的下方/右方，以及同向平行边')
{
  // 用 demo 的真实几何：canvas 与 n1 在同一行、中间隔一段空隙。
  const nodes = [
    { id: 'canvas', x: 10, y: 150, w: 186, h: 56, label: '右栏画布自动重绘' },
    { id: 'n1', x: 350, y: 150, w: 130, h: 56, label: '新节点' },
  ]
  const commit = (from, to, exit, entry) => {
    const edge = { id: 'eX', from: from, to: to, style: styleWithSide(styleWithSide(DEFAULT_EDGE_STYLE, 'source', exit), 'target', entry) }
    return internals.edgeRoutePoints({ nodes: nodes, edges: [edge] }, edge)
  }
  for (const entry of internals.SIDES) {
    const pts = commit('n1', 'canvas', 'n', entry)
    ok(
      pts !== null && pts.length >= 2 && orthogonal(pts) && finite(pts),
      'n1 上方 → canvas 的 ' + entry + ' 侧：路径算得出来（' + (pts === null ? 'null' : pts.length + ' 点') + '）',
    )
  }

  // 同向平行边：两条都要能算出来 —— 这正是旧版被"同向边已存在就静默 return"吞掉的场景。
  const two = [
    { id: 'e1', from: 'n1', to: 'canvas', style: styleWithSide(styleWithSide(DEFAULT_EDGE_STYLE, 'source', 'w'), 'target', 'e') },
    { id: 'e2', from: 'n1', to: 'canvas', style: styleWithSide(styleWithSide(DEFAULT_EDGE_STYLE, 'source', 'n'), 'target', 's') },
  ]
  let routed = 0
  for (const e of two) {
    const p = internals.edgeRoutePoints({ nodes: nodes, edges: two }, e)
    if (p !== null && p.length >= 2) routed += 1
  }
  ok(routed === 2, '同向的两条平行边各自都算得出路径（' + routed + '/2）')

  // 落点回落：DOM 命中优先；没有 DOM 命中就认"预览高亮的那个节点"
  ok(internals.dropTargetOf('a', { hot: { id: 'b' } }) === 'a', 'DOM 命中优先于预览高亮')
  ok(internals.dropTargetOf(null, { hot: { id: 'b' } }) === 'b', '没有 DOM 命中时回落到预览高亮的节点（预览说会连上就连上）')
  ok(internals.dropTargetOf(null, { hot: null }) === null, '既没 DOM 命中也没高亮 → 不连（拖到空白处就是取消）')
  ok(internals.dropTargetOf(null, null) === null, '预览为空也不炸')
}

console.log('\n移动单位：节点整格（10px）、连线半格（5px）')
{
  ok(internals.GRID === 10 && internals.EDGE_GRID === 5, '单位常量：节点一格 10px、连线半格 5px')
  ok(internals.snapTo(187, internals.GRID) === 190 && internals.snapTo(183, internals.GRID) === 180, 'snapTo(10)：187 → 190、183 → 180')
  ok(internals.snapTo(103, internals.GRID) === 100, '节点移动：103 落到 100（整格）')
  ok(internals.snapTo(187, internals.EDGE_GRID) === 185 && internals.snapTo(188, internals.EDGE_GRID) === 190, 'snapTo(5)：187 → 185、188 → 190')

  // 缩放：尺寸吸附到整格、对边原地不动、下限也取整格
  const base = { x: 100, y: 50, w: 186, h: 56 }
  const east = internals.resizeBox(base, 'e', 30, 0)
  ok(east.w === 220 && east.x === base.x && east.y === base.y, '拖东边：186+30 吸附成整格 ' + east.w + '，西边不动')
  const west = internals.resizeBox(base, 'w', -30, 0)
  ok(west.w === 220 && west.x + west.w === base.x + base.w, '拖西边：宽度整格，东边界不动（' + west.x + '+' + west.w + '）')
  const south = internals.resizeBox(base, 's', 0, 7)
  ok(south.h === 60 && south.y === base.y, '拖南边：56+7 吸附成整格 ' + south.h + '，北边不动')
  const north = internals.resizeBox(base, 'n', 0, -7)
  ok(north.h === 60 && north.y + north.h === base.y + base.h, '拖北边：高度整格，南边界不动（' + north.y + '+' + north.h + '）')
  const corner = internals.resizeBox(base, 'se', 30, 30)
  ok(corner.w === 220 && corner.h === 90, '角上缩放：宽高都整格（' + corner.w + '×' + corner.h + '）')
  const tiny = internals.resizeBox(base, 'e', -1000, 0)
  ok(tiny.w === internals.MIN_NODE_W && tiny.w % 10 === 0, '缩到下限：下限本身也是整格（' + tiny.w + '）')
  ok(internals.resizeBox(base, 'e', 30, 0).w - internals.resizeBox(base, 'e', 20, 0).w === 10, '东边每移 10px，宽度正好变一格')

  // 连线：折点按半格吸附，且只动垂直于线段的那一轴（不会把线段拉长）
  const ref = { x: 244, y: 86 }
  const flat = internals.segmentMoveOf(ref, true, 0, 7)
  ok(flat.x === 0 && flat.y === 9 && internals.snapTo(ref.y + flat.y, internals.EDGE_GRID) === 95, '水平段拖 7px：位移 9px，落点 95（半格），另一轴 0')
  const upright = internals.segmentMoveOf(ref, false, 7, 0)
  ok(upright.y === 0 && internals.snapTo(ref.x + upright.x, internals.EDGE_GRID) === 250, '竖直段拖 7px：x 落到 250（半格），y 不动（线段不会被拉长）')
  ok(internals.segmentMoveOf({ x: 100, y: 100 }, false, 2, 0).x === 0, '已经落在半格上的点：2px 的意图被吸收成 0（最小单位就是半格）')
}

console.log('\n微小差距不该留下台阶（真机报过：竖线上 1px 的横跳）')
{
  // 用户拖出折点后折点在 x=244，而落点按"侧中点"算出来是 x=245 —— 最后一跳曾凭空多出
  // `244→245` 的 1px 横跳，竖线上就出现一个小台阶（两条线段差一像素、合不成一条）。
  const nodes = [
    { id: 'n1', x: -30, y: -20, w: 130, h: 56 },
    { id: 'n2', x: 180, y: 110, w: 130, h: 56 },
  ]
  const edge = { id: 'e1', from: 'n1', to: 'n2', points: [{ x: 244, y: 8 }, { x: 244, y: 86 }] }
  const pts = internals.edgeRoutePoints({ nodes: nodes, edges: [edge] }, edge)
  ok(pts !== null && finite(pts) && orthogonal(pts), '这条边算得出路径（' + (pts === null ? 'null' : pts.length + ' 点') + '）')
  let minSeg = Infinity
  for (let i = 1; pts !== null && i < pts.length; i += 1) {
    minSeg = Math.min(minSeg, Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y))
  }
  ok(minSeg >= 5, '最短段 ≥ 5px，没有 1px 台阶（实际 ' + minSeg + 'px：' + JSON.stringify(pts) + '）')
  const last = pts === null ? null : pts[pts.length - 1]
  const prev = pts === null ? null : pts[pts.length - 2]
  ok(last !== null && prev !== null && Math.abs(last.x - prev.x) < 0.51, '最后一跳是竖直的（正对接入点，不横跳）')
  // 折点是**用户数据**：路由可以决定接在哪，但绝不改写它。
  ok(edge.points[0].x === 244 && edge.points[1].x === 244 && edge.points[1].y === 86, '路由不改用户的折点坐标')
}

console.log('\n画布真图的连线不变量（直接读 demo.dshd.json）')
{
  // 直接拿工作区里那份真文档跑 —— 它就是用户看的那张图。
  // 断言的是"用户一眼能看出来的毛病"，而不是实现细节：
  //   · 路径里不该有 5px 以下的碎段：那是两个节点中心差几像素带出的斜台阶，
  //     视觉上像一条线、实际是两条，于是同一条线上冒出两个段把手；
  //   · 两个段把手不该挨在 30px 以内 —— 那就是「一条线段上有两个点」。
  let real = null
  try {
    real = JSON.parse(readFileSync(resolve(here, '..', 'demo.dshd.json'), 'utf8'))
  } catch (error) {
    // demo 是用户的示例文件，删掉是合法操作 —— 没它就跳过这一节，不要判失败
    // （之前判失败过一次，把"用户清理了工作区"误报成代码回归）。
    console.log('  · demo.dshd.json 不存在，跳过真图不变量（这不代表失败）')
  }
  if (real !== null) {
    // 真文档也先过一遍画布的解析器（读时升级）—— 否则 demo 换成 v2 之后，
    // 这一节测的还是旧字段，等于自己骗自己。
    const parsed = internals.parseDocument(JSON.stringify(real))
    ok(parsed.error === undefined, 'demo.dshd.json 能被画布的解析器读入' + (parsed.error === undefined ? '' : '：' + parsed.error))
    const docReal = parsed.error === undefined ? parsed.doc : { nodes: [], edges: [] }
    ok(docReal.version === 2, 'demo 读入后是 v2（v1 文档会在读时升级）')
    const segLen = (a, b) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    let broken = 0
    let routed = 0
    for (const edge of docReal.edges) {
      const pts = internals.edgeRoutePoints(docReal, edge)
      if (pts === null) continue
      routed += 1
      let minSeg = Infinity
      let tiny = 0
      for (let s = 0; s < pts.length - 1; s += 1) {
        const len = segLen(pts[s], pts[s + 1])
        if (len < minSeg) minSeg = len
        if (len < 5) tiny += 1
      }
      const mids = []
      for (let s = 0; s < pts.length - 1; s += 1) if (segLen(pts[s], pts[s + 1]) >= 26) mids.push({ x: (pts[s].x + pts[s + 1].x) / 2, y: (pts[s].y + pts[s + 1].y) / 2 })
      let minGap = Infinity
      for (let i = 0; i < mids.length; i += 1) {
        for (let j = i + 1; j < mids.length; j += 1) minGap = Math.min(minGap, Math.abs(mids[i].x - mids[j].x) + Math.abs(mids[i].y - mids[j].y))
      }
      const bad = tiny > 0 || minGap < 30
      if (bad) broken += 1
      ok(!bad, edge.id + ' ' + edge.from + '→' + edge.to + '：最短段 ' + minSeg + 'px，把手最近 ' + (minGap === Infinity ? '-' : minGap) + 'px')
    }
    // 这条是**防假绿**的关键：上面 `if (pts === null) continue` 会让"算不出路径"静默通过，
    // 于是整节报"全部通过"却什么都没测 —— 必须显式数一遍非 null 的路径数。
    ok(routed === docReal.edges.length, '每条边都算出了路径（' + routed + '/' + docReal.edges.length + '）')
    ok(broken === 0, 'demo 里 ' + docReal.edges.length + ' 条连线全部通过')
  }
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
