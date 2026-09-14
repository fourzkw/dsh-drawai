/**
 * mxfile（`.drawio`）↔ 语义文档 互转的自测 —— 不需要 drawio、也不需要 DSH。
 *
 * 夹具按 drawio **真实产物**的形状写（对照 checkout 里的
 * `src/main/webapp/templates/basic/placeholder.xml`）：`<object>` 包装、root/layer 的 id
 * 带前缀（**不是** "0"/"1"）、容器子单元的相对几何、`<Array as="points">`、
 * `as="sourcePoint"/"targetPoint"`、实体与 HTML 标签、多页。
 *
 * 压缩形态在测试里**现生成**（deflateRaw + base64 + encodeURIComponent），
 * 与 drawio 的 `Graph.compress` 是同一套算法 —— 于是"我们解得开 drawio 压的"这件事有据可依。
 *
 * 用法：node tools/check-mxfile.mjs
 */
import { deflateRawSync } from 'node:zlib'
import { buildMxfile, parseMxfile } from '../src/mxfile.js'

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

/** 未压缩的 mxfile 夹具（形状取自真实模板文件）。 */
const PLAIN = `<mxfile host="test.draw.io" modified="2024-06-05T05:50:32.730Z" agent="Mozilla/5.0" compressed="false" type="device">
  <diagram id="YmL12bMKpDGza6XwsDPr" name="Page-1">
    <mxGraphModel dx="2154" dy="981" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="827" pageHeight="1169" background="none" math="1" shadow="0">
      <root>
        <mxCell id="X5NqExCQtvZxIxQ7pmgY-0" />
        <mxCell id="1" parent="X5NqExCQtvZxIxQ7pmgY-0" />
        <object label="分组&lt;br&gt;容器" placeholders="1" subnet="192.168.0" id="cont1">
          <mxCell style="ellipse;whiteSpace=wrap;html=1;fillColor=#EDF5FF;strokeWidth=2;container=1;verticalAlign=top;" parent="1" vertex="1">
            <mxGeometry x="100" y="50" width="400" height="300" as="geometry">
              <mxRectangle x="100" y="50" width="250" height="60" as="alternateBounds" />
            </mxGeometry>
          </mxCell>
        </object>
        <mxCell id="child1" value="子节点 &amp; 细节" style="rounded=1;arcSize=50;fillColor=#d5e8d4;strokeColor=#82b366;" parent="cont1" vertex="1">
          <mxGeometry x="20" y="30" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="e1" value="实线" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" parent="1" source="child1" target="cont1" edge="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="300" y="200" as="targetPoint" />
            <Array as="points">
              <mxPoint x="200" y="120" />
              <mxPoint x="260" y="120" />
            </Array>
          </mxGeometry>
        </mxCell>
        <mxCell id="e2" style="edgeStyle=none;endArrow=none;" parent="1" source="child1" edge="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="600" y="600" as="targetPoint" />
          </mxGeometry>
        </mxCell>
        <mxCell id="e3" style="edgeStyle=orthogonalEdgeStyle;" parent="1" source="ghost" target="also-ghost" edge="1">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="img1" style="image;html=1;image=img/lib/clip_art/computers/Monitor.png;" parent="1" vertex="1">
          <mxGeometry x="40" y="400" width="115" height="79" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
  <diagram id="page2" name="Page-2">
    <mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel>
  </diagram>
</mxfile>
`

/** 用 drawio 的算法压一段 mxGraphModel（deflateRaw → base64 → 包进 diagram）。 */
function compressedMxfile(modelXml) {
  const payload = deflateRawSync(Buffer.from(encodeURIComponent(modelXml), 'utf8')).toString('base64')
  return '<mxfile host="app.diagrams.net" compressed="true">\n  <diagram id="p1" name="Page-1">\n    ' + payload + '\n  </diagram>\n</mxfile>\n'
}

console.log('dsh-drawai mxfile 编解码自测\n')

console.log('[1] 读未压缩的 .drawio（真实产物形状）')
const plain = parseMxfile(PLAIN)
{
  const byId = {}
  for (const n of plain.doc.nodes) byId[n.id] = n
  ok(plain.doc.version === 2, '导入结果就是 v2 文档（version=2）')
  ok(plain.doc.nodes.length === 3, '三个顶点：容器 / 子节点 / 图片形状（实际 ' + plain.doc.nodes.length + '）')
  ok(byId.cont1 !== undefined && byId.cont1.label === '分组 容器', '<object> 包装的 id 与 label 都取到了（label=' + JSON.stringify(byId.cont1 && byId.cont1.label) + '）')
  ok(byId.cont1.x === 100 && byId.cont1.y === 50 && byId.cont1.w === 400 && byId.cont1.h === 300, '容器几何正确（' + [byId.cont1.x, byId.cont1.y, byId.cont1.w, byId.cont1.h].join(',') + '）')
  // 子单元在 drawio 里是**相对父级**的：20,30 + 容器 100,50 = 120,80
  ok(byId.child1.x === 120 && byId.child1.y === 80, '容器的子单元坐标被换算成绝对坐标（120,80）')
  ok(byId.child1.label === '子节点 & 细节', '实体（&amp;）解码正确：' + JSON.stringify(byId.child1.label))
  ok(byId.cont1.style.indexOf('container=1') >= 0 && byId.cont1.style.indexOf('fillColor=#EDF5FF') >= 0, 'style 串原样搬运（含我们不解释的 container=1）')
  ok(byId.img1 !== undefined && byId.img1.x === 40, '图片形状也按顶点导入（几何在）')

  const byEdge = {}
  for (const e of plain.doc.edges) byEdge[e.id] = e
  ok(plain.doc.edges.length === 2 && byEdge.e3 === undefined, '两条边可导入、两端都无落点的那条被跳过（实际 ' + plain.doc.edges.length + '）')
  ok(byEdge.e1.from === 'child1' && byEdge.e1.to === 'cont1', 'e1 的 source/target 映射成 from/to')
  ok(byEdge.e1.points !== undefined && byEdge.e1.points.length === 2 && byEdge.e1.points[0].x === 200, '折点从 <Array as="points"> 读出（' + JSON.stringify(byEdge.e1.points) + '）')
  ok(byEdge.e1.targetPoint === undefined, '端点连着真实顶点时 targetPoint 被忽略（drawio 语义）')
  ok(byEdge.e1.style.indexOf('exitX=1') >= 0 && byEdge.e1.style.indexOf('edgeStyle=orthogonalEdgeStyle') >= 0, '边的 style 串原样搬运（含 exitX/entryY）')
  ok(byEdge.e2.to === undefined && byEdge.e2.targetPoint !== undefined && byEdge.e2.targetPoint.x === 600, '悬空端落到 targetPoint 上（' + JSON.stringify(byEdge.e2.targetPoint) + '）')

  ok(plain.pageCount === 2, '认出这是 2 页的文件')
  const notes = plain.notes.join(' | ')
  ok(/2 页/.test(notes), 'notes 说明"只导入了第 1 页"：' + notes)
  ok(/1 个分组\/容器被摊平/.test(notes), 'notes 说明分组被摊平')
  ok(/1 个图片\/自定义形状按矩形导入/.test(notes), 'notes 说明图片按矩形导入')
  ok(/HTML 标签按纯文本/.test(notes), 'notes 说明 HTML 标签折成纯文本')
  ok(/1 条边是悬空端/.test(notes), 'notes 说明有悬空端')
  ok(/1 条边的两端都找不到落点/.test(notes), 'notes 说明有边被跳过')
}

console.log('\n[2] 读压缩的 .drawio（drawio 默认形态）')
{
  const modelXml = /<mxGraphModel[\s\S]*<\/mxGraphModel>/.exec(PLAIN)[0]
  const packed = compressedMxfile(modelXml)
  ok(packed.indexOf('<mxGraphModel') < 0, '夹具确实是压缩形态（正文里没有 mxGraphModel）')
  const parsed = parseMxfile(packed)
  const strip = (d) => JSON.stringify({ nodes: d.nodes, edges: d.edges })
  ok(strip(parsed.doc) === strip(plain.doc), '压缩形态解出来的文档与未压缩**逐字节一致**')
  // 判据是内容而不是 compressed 属性：属性撒谎也要按内容走
  const lying = packed.replace('compressed="true"', 'compressed="false"')
  ok(strip(parseMxfile(lying).doc) === strip(plain.doc), 'compressed 属性标错也不影响（按内容判形态）')
}

console.log('\n[3] 导出成 .drawio：语义文档 → mxfile → 再读回来')
{
  const doc = {
    version: 2,
    revision: 3,
    meta: { engine: 'drawio-svg' },
    nodes: [
      { id: 'n1', label: '起点 & 终点', style: 'rounded=1;arcSize=50;fillColor=#dae8fc;strokeColor=#6c8ebf;', x: 10, y: 20, w: 130, h: 60 },
      { id: 'n2', label: '', style: '', x: 300, y: 200, w: 186, h: 86 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: '带折点', style: 'edgeStyle=orthogonalEdgeStyle;html=1;endArrow=classic;exitX=1;exitY=0.5;', points: [{ x: 200, y: 50 }, { x: 200, y: 240 }] },
      { id: 'e2', from: 'n1', sourcePoint: undefined, targetPoint: { x: 700, y: 700 }, style: 'edgeStyle=none;endArrow=none;' },
    ],
  }
  const xml = buildMxfile(doc)
  ok(xml.indexOf('<mxfile') === 0 && xml.indexOf('</mxfile>') > 0, '导出的是一份完整 mxfile')
  ok(xml.indexOf('<mxCell id="0" />') > 0 && xml.indexOf('<mxCell id="1" parent="0" />') > 0, '带上 drawio 的 root 与默认图层单元')
  ok(xml.indexOf('style="rounded=1;arcSize=50;fillColor=#dae8fc;strokeColor=#6c8ebf;"') > 0, 'style 串原样写出（未做任何键名翻译）')
  ok(xml.indexOf('&amp;') > 0, '标签里的 &amp; 转义正确')

  const back = parseMxfile(xml).doc
  ok(back.nodes.length === 2 && back.edges.length === 2, '读回来节点/边数量一致（' + back.nodes.length + '/' + back.edges.length + '）')
  const n1 = back.nodes.filter((n) => n.id === 'n1')[0]
  ok(n1.label === '起点 & 终点' && n1.x === 10 && n1.y === 20 && n1.w === 130 && n1.h === 60, '节点标签与几何往返无损')
  ok(n1.style === doc.nodes[0].style, '节点 style 往返无损')
  const e1 = back.edges.filter((e) => e.id === 'e1')[0]
  ok(e1.from === 'n1' && e1.to === 'n2' && e1.label === '带折点', '边的端点与标签往返无损')
  ok(e1.style === doc.edges[0].style, '边 style 往返无损')
  ok(JSON.stringify(e1.points) === JSON.stringify(doc.edges[0].points), '折点往返无损：' + JSON.stringify(e1.points))
  const e2 = back.edges.filter((e) => e.id === 'e2')[0]
  ok(e2.sourcePoint === undefined && e2.targetPoint !== undefined && e2.targetPoint.x === 700, '悬空端往返无损（sourcePoint 缺省、targetPoint 保留）')

  // 再导一次应当与第一次**逐字节相同**（导出是确定性的）
  ok(buildMxfile(back) === xml, '导出是确定性的（同一份文档导出两次结果一致）')

  // 压缩导出同样能被自己读回
  const packedXml = buildMxfile(doc, { compressed: true })
  ok(packedXml.indexOf('<mxGraphModel') < 0, '压缩导出确实压掉了 XML')
  const backPacked = parseMxfile(packedXml).doc
  ok(JSON.stringify({ nodes: backPacked.nodes, edges: backPacked.edges }) === JSON.stringify({ nodes: back.nodes, edges: back.edges }), '压缩导出读回来与未压缩导出一致')
}

console.log('\n[4] 坏输入要报错，而不是给出半张图')
{
  const throws = (text) => {
    try {
      parseMxfile(text)
      return false
    } catch (error) {
      return true
    }
  }
  ok(throws(''), '空文件报错')
  ok(throws('{"nodes":[]}'), '不是 mxfile 的 JSON 报错')
  ok(throws('<mxfile><diagram></diagram></mxfile>'), '没有 mxGraphModel 报错')

  // BOM：有的编辑器会给 UTF-8 文件加一个 U+FEFF，不该因此读不开。
  const withBom = parseMxfile('\ufeff' + PLAIN)
  ok(JSON.stringify(withBom.doc.nodes) === JSON.stringify(plain.doc.nodes), '带 BOM 的 UTF-8 文件照样能读（BOM 被摘掉）')

  // UTF-16：按 UTF-8 读进来时字节之间全是空字符。**不猜**，给一句能照做的错 ——
  // 硬按 UTF-16 重解释会把中日韩标签变成乱码，而乱码是看不见的损失。
  const utf16 = Buffer.from(PLAIN, 'utf16le').toString('utf8')
  let utf16Message = ''
  try {
    parseMxfile(utf16)
  } catch (error) {
    utf16Message = error && error.message ? error.message : String(error)
  }
  ok(/UTF-16/.test(utf16Message), 'UTF-16 文件给出明确的编码诊断：' + utf16Message)
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
