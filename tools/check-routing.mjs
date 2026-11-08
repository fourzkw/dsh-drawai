import assert from 'node:assert/strict'
import { composeClientBody } from './build.mjs'
import { DEFAULT_EDGE_STYLE, routingModeOf, styleWithRoutingMode, styleWithSide, styleGet } from '../src/style-kernel.js'
import { createOrthogonalRouter, storedRoute, routingBoxes, validRoute } from '../src/routing/router.js'
import { getRoutingRuntime } from '../src/routing/node-runtime.js'
import { buildCanvas, parseCanvas, exportCanvasToMxfile } from '../src/canvas-format.js'
import { parseMxfile } from '../src/mxfile.js'
import { cloneDocument, documentTransaction } from '../src/document-core.js'

let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS ' + label) }
const clone = cloneDocument
const autoStyle = styleWithRoutingMode(DEFAULT_EDGE_STYLE, 'auto')
const node = (id, x, y, w = 120, h = 60) => ({ id, x, y, w, h })
const edge = (id, from, to, style = autoStyle) => ({ id, from, to, style })
const router = createOrthogonalRouter(getRoutingRuntime)
const pathOf = (doc, item = doc.edges[0]) => storedRoute(item, routingBoxes(doc))
const legal = (doc, item = doc.edges[0]) => validRoute(pathOf(doc, item), item, routingBoxes(doc))

check(routingModeOf({ style: DEFAULT_EDGE_STYLE }) === 'orthogonal', '旧普通正交线保持原有模式')
check(routingModeOf({ style: DEFAULT_EDGE_STYLE, points: [{ x: 10, y: 20 }] }) === 'manual', '旧折点属于用户')
check(routingModeOf({ style: autoStyle, points: [{ x: 10, y: 20 }] }) === 'auto', '自动模式下的折点属于引擎')
check(routingModeOf({ style: autoStyle + 'edgeStyle=none;' }) === 'straight', '直线模式优先于遗留避障标记')

const base = { nodes: [node('a', 0, 0), node('b', 500, 0), node('wall', 220, -40, 100, 140)], edges: [edge('e', 'a', 'b')] }
const result = router.update(null, base)
check(result.routed.length === 1 && legal(base), '真实 libavoid 引擎绕过中间障碍')
check(base.edges[0].points.length > 0, '自动折点落入文档，可保存和导出')
const count = router.solves
router.update(null, base)
check(router.solves === count, '重开已有合法路线无需重新求解')

const manual = clone(base)
manual.edges[0].style = styleWithRoutingMode(manual.edges[0].style, 'manual')
const savedManual = clone(manual.edges[0])
const movedManual = clone(manual); movedManual.nodes[2].x += 10
router.update(manual, movedManual)
check(JSON.stringify(movedManual.edges[0]) === JSON.stringify(savedManual), '手动线不被自动引擎覆盖')

const near = { nodes: [node('a', 0, 0), node('b', 144, 10)], edges: [edge('n', 'a', 'b', styleWithSide(styleWithSide(autoStyle, 'source', 'e'), 'target', 'w'))] }
router.update(null, near)
check(legal(near), '窄间距固定端点自动缩短引出段，不折返')

const scene = { nodes: [node('a', 0, 0), node('b', 500, 0), node('c', 0, 1000), node('d', 500, 1000), node('wall', 220, 200, 100, 100)], edges: [edge('e', 'a', 'b'), edge('far', 'c', 'd')] }
router.update(null, scene)
const next = clone(scene); next.nodes[4].y = -20
const distant = JSON.stringify(next.edges[1])
const affected = router.update(scene, next)
check(affected.affected.includes('e') && !affected.affected.includes('far'), '未相连的节点移入路线时，只失效附近连线')
check(legal(next) && JSON.stringify(next.edges[1]) === distant, '远处连线数据保持不变')
const away = clone(next); away.nodes[4].y = 200
check(router.update(next, away).affected.includes('e') && legal(away), '障碍移出路线后，附近路线重新优化')

const title = clone(next); title.edges[0].label = '仅编辑文字'
const beforeText = router.solves
router.update(next, title)
check(router.solves === beforeText, '修改连线文字不触发几何求解')

const rigid = clone(base)
for (const item of rigid.nodes) { item.x += 40; item.y += 30 }
const beforeRigid = router.solves
router.update(base, rigid)
check(router.solves === beforeRigid && legal(rigid), '整体平移合法内部路线，无需重新求解')
assert.deepEqual(rigid.edges[0].points, base.edges[0].points.map((p) => ({ x: p.x + 40, y: p.y + 30 })))

const contained = { nodes: [node('group', -50, -50, 700, 350), node('a', 0, 0), node('b', 500, 0), node('wall', 220, -20, 100, 140)], edges: [edge('inside', 'a', 'b')] }
contained.nodes[0].style = 'group;container=1;'
router.update(null, contained)
check(legal(contained), '容器内部允许走线，仍绕开兄弟节点')

const hidden = clone(base); hidden.layers = [{ id: 'hidden', visible: false }]; hidden.nodes[2].layer = 'hidden'; delete hidden.edges[0].points
hidden.edges[0].style = autoStyle
router.update(null, hidden)
check(legal(hidden) && hidden.edges[0].points.length === 0, '隐藏节点不阻挡水平直连')

const dangling = { nodes: [node('a', 0, 0), node('wall', 220, -20, 100, 100)], edges: [{ id: 'free', from: 'a', targetPoint: { x: 500, y: 30 }, style: autoStyle }] }
router.update(null, dangling)
check(legal(dangling) && pathOf(dangling).at(-1).x === 500, '悬空端使用真实自由点参与避障')
const both = { nodes: [node('wall', 220, -20, 100, 100)], edges: [{ id: 'free', sourcePoint: { x: 0, y: 30 }, targetPoint: { x: 500, y: 30 }, style: autoStyle }] }
router.update(null, both)
check(legal(both), '两端悬空线可以自动避障')

const overlap = { nodes: [node('a', 0, 0), node('b', 50, 0)], edges: [edge('blocked', 'a', 'b', styleWithSide(styleWithSide(autoStyle, 'source', 'e'), 'target', 'w'))] }
const blocked = router.update(null, overlap)
check(blocked.failed.includes('blocked') && styleGet(overlap.edges[0].style, 'drawaiRouteStatus', '') === 'blocked', '不可满足的约束明确标记失败')

const project = buildCanvas(base, { format: 'drawai' }).text
const reopened = parseCanvas(project).doc
assert.deepEqual(reopened.edges[0].points, base.edges[0].points)
check(routingModeOf(reopened.edges[0]) === 'auto', '原生格式保存模式及生成折点')
const xml = parseMxfile(exportCanvasToMxfile(project)).doc
assert.deepEqual(xml.edges[0].points, base.edges[0].points)
check(routingModeOf(xml.edges[0]) === 'auto', 'drawio 导出往返保持路由归属与几何')

const module = { exports: {} }
new Function('module', 'exports', 'require', 'window', 'document', composeClientBody())(module, module.exports,
  () => ({ Component: class {}, createElement: () => null }), {}, {})
const ui = module.exports.__routeInternals
const canvas = { nodes: [node('a', 0, 0), node('b', 500, 100), node('wall', 230, -20, 100, 150)], edges: [] }
const geometry = ui.buildGeometry(canvas)
const preview = ui.routePreviewFor(canvas, geometry, { x: 500, y: 130 }, 'a', geometry.byId.a.geo, { side: 'e' }, ui.HOT_PAD, 'a')
check(preview && preview.hot.id === 'b', '浏览器手动连线预览可吸附目标')
const manualPreview = documentTransaction(canvas, (draft) => draft.edges.push({ ...edge('manual', 'a', 'b', styleWithSide(styleWithSide(styleWithRoutingMode(DEFAULT_EDGE_STYLE, 'manual'), 'source', preview.sides.from), 'target', preview.sides.to)), points: preview.points.slice(1, -1) })).doc
const beforeManual = ui.routingEngine.solves
ui.updateDocumentRoutes(canvas, manualPreview)
assert.deepEqual(ui.edgeRoutePoints(manualPreview, manualPreview.edges[0]), preview.points)
check(ui.routingEngine.solves === beforeManual && routingModeOf(manualPreview.edges[0]) === 'manual', '新建手动连线保留预览折点，不调用自动避障')
const created = documentTransaction(canvas, (draft) => draft.edges.push({ ...edge('new', 'a', 'b', styleWithSide(styleWithSide(autoStyle, 'source', preview.sides.from), 'target', preview.sides.to)), __routePreview: preview.points })).doc
const beforePreviewCommit = ui.routingEngine.solves
ui.updateDocumentRoutes(canvas, created)
assert.deepEqual(ui.edgeRoutePoints(created, created.edges[0]), preview.points)
check(ui.routingEngine.solves === beforePreviewCommit && !('__routePreview' in created.edges[0]), '松手直接提交合法预览，不重算或泄漏临时字段')
const beforePaint = ui.routingEngine.solves
for (let i = 0; i < 20; i++) ui.edgeRoutePoints(created, created.edges[0], new Map())
check(ui.routingEngine.solves === beforePaint, '反复渲染和命中不会重新求解或改变路线')

const past = clone(created)
const moved = documentTransaction(created, (draft) => { draft.nodes[1].y += 100 }).doc
ui.updateDocumentRoutes(created, moved)
check(validRoute(ui.edgeRoutePoints(moved, moved.edges[0]), moved.edges[0], ui.buildGeometry(moved).boxes), '节点拖动事务中的增量路线合法')
assert.deepEqual(clone(past), created)
check(JSON.stringify(past.edges[0].points) !== JSON.stringify(moved.edges[0].points), '撤销快照同时保留节点和旧路线')

const plain = clone(created); plain.edges[0].style = styleWithRoutingMode(plain.edges[0].style, 'orthogonal'); delete plain.edges[0].points
const plainCount = ui.routingEngine.solves
ui.updateDocumentRoutes(created, plain)
check(ui.routingEngine.solves === plainCount, '关闭避障后不再调用引擎')

const corridor = { nodes: [node('a', 0, 0), node('b', 500, 0), node('wall', 220, -40, 100, 140)], edges: [edge('p1', 'a', 'b'), edge('p2', 'a', 'b'), edge('p3', 'a', 'b')] }
router.update(null, corridor)
check(corridor.edges.every((item) => legal(corridor, item)), '共享端点的多条线批量求解后均合法')
check(new Set(corridor.edges.map((item) => JSON.stringify(item.points))).size > 1, '拥挤通道中的平行线分配不同路线')

let moving = clone(base), bad = 0
for (let step = 0; step < 100; step++) {
  const draft = clone(moving)
  draft.nodes[1].x = 400 + step * 2
  draft.nodes[1].y = 120 + Math.round(Math.sin(step / 10) * 100)
  const state = router.update(moving, draft)
  if (state.failed.length || !legal(draft)) bad++
  moving = draft
}
check(bad === 0, '连续拖动 100 个位置，路线保持合法且不折返')

const reconnect = ui.edgePreviewRoute(created, ui.buildGeometry(created), created.edges[0], 'to', { x: 703, y: 297 }, ui.HOT_PAD)
check(reconnect && reconnect.points.at(-1).x === 705 && reconnect.points.at(-1).y === 295, '改接悬空端的预览与提交使用相同吸附坐标')
const cachedCount = ui.routingEngine.solves
ui.edgePreviewRoute(created, ui.buildGeometry(created), created.edges[0], 'to', { x: 703, y: 297 }, ui.HOT_PAD)
check(ui.routingEngine.solves === cachedCount, '相同端点预览命中缓存，不重复求解')

const loop = { nodes: [node('a', 0, 0)], edges: [{ ...edge('loop', 'a', 'a'), __routePreview: [{ x: 120, y: 30 }, { x: 140, y: 30 }] }] }
router.update(null, loop)
check(!('__routePreview' in loop.edges[0]), '自环跳过求解也会清除临时预览数据')

const covered = { nodes: [node('a', 0, 0), node('b', 500, 0), node('cover', -10, -10, 140, 80)], edges: [edge('covered', 'a', 'b')] }
check(router.update(null, covered).failed.includes('covered'), '普通覆盖节点不会被误当成可穿越容器')

// issue #13：从 git 克隆的包装不上 src/routing/vendor 时，引擎整个不可用。
// 这种情况必须在 update() 里降级，而不是把 ENOENT 抛给写回路径（那会让整次改图失败且不落盘）。
const noEngine = createOrthogonalRouter(() => {
  throw new Error("ENOENT: no such file or directory, open 'lib/routing/vendor/libavoid.min.js'")
})
const degradedScene = { nodes: [node('a', 0, 0), node('b', 500, 0), node('wall', 220, -40, 100, 140)], edges: [edge('e', 'a', 'b')] }
let degraded
try {
  degraded = noEngine.update(null, degradedScene)
} catch (error) {
  assert.fail('引擎不可用时 update 抛了异常：' + error.message)
}
check(typeof degraded.unavailable === 'string' && degraded.unavailable.includes('libavoid'), '引擎不可用时降级并带出原因（不抛异常）')
check(degraded.failed.length === 0 && degradedScene.edges[0].points === undefined, '降级时边保持原样，也不会被误标成 blocked')

console.log('Routing checks passed: ' + checks)
