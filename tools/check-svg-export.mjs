/**
 * `diagram_export` 的宿主侧渲染器回归 —— 不靠浏览器，纯文档进、SVG/PNG 出。
 *
 * 这里守的是"没有画布通道时也能拿到成品图"（issue #23）那条路最容易悄悄坏掉的几处：
 *   · 坐标里混进 NaN/undefined（SVG 会静默丢掉整条路径，图看着像少画了东西）；
 *   · 正交边被画成斜线（存下来的折点直接连线，与画布上看到的不一致）；
 *   · 隐藏图层里的单元跑到导出件里；
 *   · 标签里的 `<` `&` 把 XML 撑坏；
 *   · 箭头/虚线这些"文档里的 style 键"没有落到 SVG 属性上；
 *   · 自环（from === to）被静默丢掉、stats 把没画出来的东西也算进去；
 *   · 超大 scale 先吃满内存再报错（尺寸上限要在栅格化之前算）。
 */
import assert from 'node:assert/strict'
import { buildExportSvg, exportBoxes, exportScaleFor, rasterizeSvgToPng } from '../src/svg-export.js'

const EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;jettySize=auto;html=1;endArrow=classic;'

function doc(overrides) {
  const base = {
    nodes: [
      { id: 'a', x: 0, y: 0, w: 120, h: 60, label: '开始' },
      { id: 'b', x: 300, y: 0, w: 120, h: 60, label: '结束' },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', style: EDGE_STYLE }],
    layers: [],
    labels: [],
  }
  return Object.assign(base, overrides)
}

/** 从 `<g data-edge-id="…">` 里取出路径的 `d`（同一条边可能有多个子路径，用空格拼在一起）。 */
function edgePath(svg, id) {
  const group = svg.split('<g ').find((part) => part.startsWith('data-edge-id="' + id + '"'))
  assert.ok(group, '没有找到连线 ' + id + ' 的分组')
  const out = []
  const re = /<path[^>]*\sd="([^"]*)"/g
  let hit = re.exec(group)
  while (hit !== null) {
    out.push(hit[1])
    hit = re.exec(group)
  }
  assert.ok(out.length > 0, '连线 ' + id + ' 没有画出来')
  return out.join(' ')
}

/**
 * 折线里每一段都必须**只沿一个轴**走。
 *
 * 圆角（`rounded=1`）会追加二次曲线，曲线段不参与判断 —— 只查 `L` 段，
 * 因为斜线是 `L` 才画得出来的，`Q` 本身就带弧度。
 */
function assertAxisAligned(d, label) {
  const tokens = String(d).replace(/,/g, ' ').trim().split(/\s+/)
  let x = null
  let y = null
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'M' || tokens[i] === 'L') {
      const nx = Number(tokens[i + 1])
      const ny = Number(tokens[i + 2])
      assert.ok(Number.isFinite(nx) && Number.isFinite(ny), label + ' 的坐标不是有限数：' + tokens.slice(i, i + 3).join(' '))
      if (tokens[i] === 'L' && x !== null) {
        const movedX = Math.abs(nx - x) > 0.01
        const movedY = Math.abs(ny - y) > 0.01
        assert.ok(movedX !== movedY, label + ' 里有斜线段 ' + [x, y, nx, ny].join(','))
      }
      x = nx
      y = ny
      i += 2
    } else if (tokens[i] === 'Q') {
      i += 4
    }
  }
}

// ── 1. 基本形状：合法 XML 头、viewBox、两个标签都在 ─────────────────────
const plain = buildExportSvg(doc(), {})
assert.match(plain.svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
assert.match(plain.svg, /<svg [^>]*viewBox="[^"]*"/)
assert.deepEqual(plain.stats, { nodes: 2, edges: 1 })
assert.ok(plain.width > 0 && plain.height > 0)
for (const part of [plain.viewBox.x, plain.viewBox.y, plain.viewBox.width, plain.viewBox.height]) assert.ok(Number.isFinite(part))
assert.ok(plain.svg.includes('开始') && plain.svg.includes('结束'), '节点标签没进导出件')
assert.ok(plain.svg.includes('<g data-node-id="a">'), '节点没有按 id 分组')
assert.ok(plain.svg.includes('<g data-edge-id="e1">'), '连线没有按 id 分组')
assert.equal(plain.warnings.length, 0, '干净文档不该有降级警告：' + plain.warnings.join(' / '))
for (const bad of ['NaN', 'undefined', 'Infinity']) assert.equal(plain.svg.includes(bad), false, 'SVG 里混进了 ' + bad)

// ── 2. 正交边：存不存折点都不许画出斜线 ─────────────────────────────────
assertAxisAligned(edgePath(plain.svg, 'e1'), '无折点的正交边')
const withWaypoint = buildExportSvg(doc({
  edges: [{ id: 'e1', from: 'a', to: 'b', style: EDGE_STYLE, points: [{ x: 180, y: 140 }] }],
}), {})
assertAxisAligned(edgePath(withWaypoint.svg, 'e1'), '带一个折点的正交边')
// 折点是用户数据：掰成直角之后仍然必须经过它（x 方向经过 180、y 方向经过 140）。
const routed = edgePath(withWaypoint.svg, 'e1')
assert.ok(routed.includes('180'), '折点的 x 没被保留：' + routed)
assert.ok(routed.includes('140'), '折点的 y 没被保留：' + routed)

// ── 3. style 键 → SVG 属性：箭头、虚线 ─────────────────────────────────
assert.match(plain.svg, /marker-end="url\(#[^)]*-end\)"/, 'endArrow=classic 没画箭头')
const noArrow = buildExportSvg(doc({ edges: [{ id: 'e1', from: 'a', to: 'b', style: 'endArrow=none;' }] }), {})
assert.equal(/marker-end=/.test(noArrow.svg), false, 'endArrow=none 不该画箭头')
const both = buildExportSvg(doc({ edges: [{ id: 'e1', from: 'a', to: 'b', style: 'endArrow=classic;startArrow=classic;' }] }), {})
assert.match(both.svg, /marker-start="url\(#[^)]*-start\)"/, 'startArrow=classic 没画起点箭头')
const dashed = buildExportSvg(doc({ edges: [{ id: 'e1', from: 'a', to: 'b', style: 'dashed=1;' }] }), {})
assert.match(dashed.svg, /stroke-dasharray="[^"]+"/, 'dashed=1 没变成虚线')

// ── 4. 文档里的颜色优先于主题缺省 ──────────────────────────────────────
const colored = buildExportSvg(doc({
  nodes: [
    { id: 'a', x: 0, y: 0, w: 120, h: 60, label: '红', style: 'fillColor=#ff0000;strokeColor=#00ff00;fontColor=#0000ff;' },
    { id: 'b', x: 300, y: 0, w: 120, h: 60, label: '蓝' },
  ],
  edges: [{ id: 'e1', from: 'a', to: 'b', style: 'strokeColor=#123456;' }],
}), {})
assert.ok(colored.svg.includes('fill="#ff0000"'), '节点填充色没进导出件')
assert.ok(colored.svg.includes('stroke="#00ff00"'), '节点描边色没进导出件')
assert.ok(colored.svg.includes('fill="#0000ff"'), '字色没进导出件')
assert.ok(colored.svg.includes('#123456'), '连线颜色没进导出件')

// ── 5. 主题与背景 ──────────────────────────────────────────────────────
const light = buildExportSvg(doc(), {})
assert.match(light.svg, /<rect[^>]*fill="#ffffff"[^>]*\/>/, '浅色导出缺白底')
const dark = buildExportSvg(doc(), { theme: 'dark' })
// 只看正文之前那段（defs + 背景）：深色主题不铺白底，节点自己的白底照画。
assert.equal(/<rect/.test(dark.svg.split('<g ')[0]), false, '深色导出不该铺整幅底色')
// 深色主题：连线用浅色、没写 fillColor 的节点用深灰底（与客户端 src/client.js:462 同一套）。
assert.ok(dark.svg.includes('#c9c9c9'), '深色导出的线/边没用浅色')
assert.ok(dark.svg.includes('fill="#2a2a2a"'), '深色导出的节点没用深灰底')
const transparent = buildExportSvg(doc(), { background: 'transparent' })
assert.equal(/<rect[^>]*\/>/.test(transparent.svg.split('<g ')[0]), false, 'transparent 背景不该铺整幅 rect')

// ── 6. 隐藏图层不参与导出 ──────────────────────────────────────────────
const hiddenDoc = buildExportSvg(doc({
  layers: [{ id: 'L1', visible: false }],
  nodes: [
    { id: 'a', x: 0, y: 0, w: 120, h: 60, label: '可见' },
    { id: 'z', x: 0, y: 200, w: 120, h: 60, label: '藏起来', layer: 'L1' },
  ],
  edges: [],
}), {})
assert.ok(hiddenDoc.svg.includes('可见'))
assert.equal(hiddenDoc.svg.includes('藏起来'), false, '隐藏图层里的节点被导出了')
assert.deepEqual(hiddenDoc.stats, { nodes: 1, edges: 0 })

// ── 7. XML 转义 ────────────────────────────────────────────────────────
const escaped = buildExportSvg(doc({
  nodes: [{ id: 'a', x: 0, y: 0, w: 200, h: 60, label: '<a & b>' }],
  edges: [],
}), {})
assert.ok(escaped.svg.includes('&lt;a &amp; b&gt;'), '标签里的尖括号/和号没转义')
assert.equal(/<text[^>]*>[^<]*<a & b>/.test(escaped.svg), false)

// ── 8. 中文标签的字号/换行与客户端同一套口径 ───────────────────────────
const longLabel = buildExportSvg(doc({
  nodes: [{ id: 'a', x: 0, y: 0, w: 100, h: 60, label: '很长很长很长很长很长很长很长很长的中文标签' }],
  edges: [],
}), {})
assert.ok((longLabel.svg.match(/<tspan/g) || []).length >= 2, '超宽中文标签没有换行')

// ── 9. 空文档：不抛错，也不产出 NaN 尺寸 ───────────────────────────────
const empty = buildExportSvg({ nodes: [], edges: [] }, {})
assert.deepEqual(empty.stats, { nodes: 0, edges: 0 })
assert.ok(Number.isFinite(empty.width) && empty.width > 0)
assert.equal(/NaN/.test(empty.svg), false)

// ── 10. 几何：文字撑高节点（客户端 nodeBoxOf 的那一条） ────────────────
const grown = exportBoxes({
  nodes: [{ id: 'a', x: 0, y: 0, w: 100, h: 40, label: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十' }],
  layers: [],
})
assert.ok(grown[0].geo.h > 40, '文字超长时节点高度没有被撑开：' + grown[0].geo.h)
assert.equal(grown[0].geo.h % 10, 0, '撑高后的高度应该吸附到整格')

// ── 11. PNG 栅格化 ────────────────────────────────────────────────────
const png = await rasterizeSvgToPng(plain.svg, { scale: 2 })
assert.deepEqual([...png.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG 魔数不对')
assert.equal(png.width, Math.round(plain.width * 2))
assert.equal(png.height, Math.round(plain.height * 2))
assert.ok(png.png.length > plain.svg.length, 'PNG 比 SVG 还小，八成是空白图')

// ── 12. scale 兜底 ────────────────────────────────────────────────────
assert.equal(exportScaleFor(3), 3)
assert.equal(exportScaleFor(0), 0.1, 'scale 不该被算成 0')
assert.equal(exportScaleFor(undefined), 2)
assert.equal(exportScaleFor('abc'), 2)

// ── 13. 自环：两端是同一个节点也要画出来 ──────────────────────────────
const selfLoopDoc = (style) => doc({ edges: [{ id: 'e1', from: 'a', to: 'a', style: style }] })
const loopES = buildExportSvg(selfLoopDoc('edgeStyle=orthogonalEdgeStyle;exitX=0.5;exitY=1;entryX=0;entryY=0.5;endArrow=classic;'), {})
assert.deepEqual(loopES.stats, { nodes: 2, edges: 1 }, '自环没有被算成一条画出来的边')
assertAxisAligned(edgePath(loopES.svg, 'e1'), '自环（下 → 左）')
assert.equal(loopES.warnings.length, 0, '自环不该再报"两端都落不到任何节点上"：' + loopES.warnings.join(' / '))
// 桩点 35：从底边出去是 y=95，从左边回来是 x=-35 —— 桩点得真的画出来，不能只连两个端点。
const loopPath = edgePath(loopES.svg, 'e1')
assert.ok((loopPath.match(/-?\d+(?:\.\d+)?/g) || []).includes('95'), '自环的下侧桩点没画出来：' + loopPath)
const loopEW = buildExportSvg(selfLoopDoc('edgeStyle=orthogonalEdgeStyle;exitX=1;exitY=0.5;entryX=0;entryY=0.5;'), {})
assertAxisAligned(edgePath(loopEW.svg, 'e1'), '自环（右 → 左）')
assert.ok(loopEW.viewBox.y < 0, 'e → w 的自环没有从盒子上方绕出去：' + loopEW.viewBox.y)

// ── 14. stats 只数真的画出来的边 ──────────────────────────────────────
const hiddenEdge = buildExportSvg(doc({
  layers: [{ id: 'L1', visible: false }],
  edges: [{ id: 'e1', from: 'a', to: 'b', layer: 'L1', style: EDGE_STYLE }],
}), {})
assert.deepEqual(hiddenEdge.stats, { nodes: 2, edges: 0 }, '隐藏图层里的边被算进了 stats')
assert.equal(hiddenEdge.svg.includes('data-edge-id'), false, '隐藏图层里的边被导出了')
const dangling = buildExportSvg(doc({ edges: [{ id: 'e1', from: 'a', to: 'missing', style: EDGE_STYLE }] }), {})
assert.deepEqual(dangling.stats, { nodes: 2, edges: 0 }, '落到不存在节点上的边被算进了 stats')
assert.ok(dangling.warnings.some((line) => line.includes('两端都落不到任何节点上')), '跳过的边没留 warning')

// ── 15. PNG 尺寸上限：栅格化之前就要拦下来 ────────────────────────────
const svgOf = (w, h) => '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"></svg>'
await assert.rejects(() => rasterizeSvgToPng(svgOf(20000, 200), { scale: 1 }), /PNG 尺寸过大/, '单边超限没被拦住')
await assert.rejects(() => rasterizeSvgToPng(svgOf(4000, 4000), { scale: 2 }), /PNG 尺寸过大/, '总量超限没被拦住')
await assert.rejects(() => rasterizeSvgToPng(svgOf(4000, 4000), { scale: 2 }), /请调小 scale/, '报错没有告诉用户怎么办')

console.log('check-svg-export: OK (正交化、箭头/虚线、配色与主题、隐藏图层、转义、换行、撑高、自环、stats、PNG、尺寸上限、scale 兜底)')
