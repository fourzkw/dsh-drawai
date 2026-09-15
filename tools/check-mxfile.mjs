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
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { __plan, applyDocToMxfile, buildMxfile, contentHash, parseMxfile } from '../src/mxfile.js'

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
  ok(/2 页/.test(notes), 'notes 说明只显示/编辑第 1 页：' + notes)
  ok(/1 个分组\/容器/.test(notes), 'notes 说明分组/容器按绝对位置显示（层级仍保留）')
  ok(/1 个图片\/自定义形状按矩形显示/.test(notes), 'notes 说明图片按矩形显示（单元原样保留）')
  ok(/HTML 标签按纯文本/.test(notes), 'notes 说明 HTML 标签折成纯文本')
  ok(/1 条边是悬空端/.test(notes), 'notes 说明有悬空端')
  ok(/1 条边的两端都找不到落点/.test(notes), 'notes 说明有边不显示但原样保留')
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

console.log('\n[3] 新建一份 .drawio：语义文档 → mxfile → 再读回来')
{
  const doc = {
    version: 2,
    revision: 3,
    meta: { pinned: false },
    nodes: [
      { id: 'n1', label: '起点 & 终点', style: 'rounded=1;arcSize=50;fillColor=#dae8fc;strokeColor=#6c8ebf;', x: 10, y: 20, w: 130, h: 60 },
      { id: 'n2', label: '', style: '', x: 300, y: 200, w: 186, h: 86 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: '带折点', style: 'edgeStyle=orthogonalEdgeStyle;html=1;endArrow=classic;exitX=1;exitY=0.5;', points: [{ x: 200, y: 50 }, { x: 200, y: 240 }] },
      { id: 'e2', from: 'n1', sourcePoint: undefined, targetPoint: { x: 700, y: 700 }, style: 'edgeStyle=none;endArrow=none;' },
    ],
  }
  const xml = buildMxfile(doc).text
  ok(xml.indexOf('<mxfile') === 0 && xml.indexOf('</mxfile>') > 0, '生成的是一份完整 mxfile')
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
  ok(back.revision === contentHash(xml), '文档的 revision 就是文件内容指纹')

  // 再写一次应当与第一次**逐字节相同**（写回是确定性的）
  ok(buildMxfile(back).text === xml, '生成是确定性的（同一份文档生成两次结果一致）')

  // 压缩形态同样能被自己读回
  const packedXml = buildMxfile(doc, { compressed: true }).text
  ok(packedXml.indexOf('<mxGraphModel') < 0, '压缩生成确实压掉了 XML')
  const backPacked = parseMxfile(packedXml).doc
  ok(JSON.stringify({ nodes: backPacked.nodes, edges: backPacked.edges }) === JSON.stringify({ nodes: back.nodes, edges: back.edges }), '压缩生成读回来与未压缩一致')
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

console.log('\n[5] 无损写回：在原文件上做定点手术')
{
  // 一份"drawio 真实产物形状"的文件：<object> 包装、容器 + 子单元、第二页、
  // 我们不认识的边（两端都没落点）、alternateBounds、自定义属性，且**页 1 是压缩的**。
  const page1 =
    '<mxGraphModel dx="0" dy="0">' +
    '<root><mxCell id="X-0" /><mxCell id="1" parent="X-0" />' +
    '<object label="容器" placeholders="1" subnet="10.0.0" id="cont">' +
    '<mxCell style="container=1;" parent="1" vertex="1">' +
    '<mxGeometry x="100" y="50" width="400" height="300" as="geometry">' +
    '<mxRectangle x="100" y="50" width="250" height="60" as="alternateBounds" />' +
    '</mxGeometry></mxCell></object>' +
    '<mxCell id="child" value="子" style="rounded=1;" parent="cont" vertex="1">' +
    '<mxGeometry x="20" y="30" width="120" height="60" as="geometry" /></mxCell>' +
    '<mxCell id="ghost" style="edgeStyle=none;" edge="1" parent="1" source="nope" target="nada">' +
    '<mxGeometry relative="1" as="geometry" /></mxCell>' +
    '<mxCell id="img" style="image;image=x.png;" parent="1" vertex="1">' +
    '<mxGeometry x="500" y="500" width="40" height="40" as="geometry" /></mxCell>' +
    '</root></mxGraphModel>'
  const page2 = '<diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram>'
  const real =
    '<mxfile host="app.diagrams.net" compressed="true">\n  <diagram id="p1" name="Page-1">\n    ' +
    deflateRawSync(Buffer.from(encodeURIComponent(page1), 'utf8')).toString('base64') +
    '\n  </diagram>\n  ' +
    page2 +
    '\n</mxfile>\n'
  const bodyOf = (text) => {
    const payload = /<diagram id="p1"[^>]*>\s*([^<\s][^<]*?)\s*<\/diagram>/.exec(text)
    return payload === null ? text : decodeURIComponent(inflateRawSync(Buffer.from(payload[1], 'base64')).toString('utf8'))
  }

  const read = parseMxfile(real)
  const doc = read.doc
  ok(doc.nodes.length === 3 && doc.edges.length === 0, '容器 + 子单元 + 图片导入成 3 个顶点（实际 ' + doc.nodes.length + '）')
  ok(doc.nodes.filter((n) => n.id === 'child')[0].x === 120, '容器子单元读成绝对坐标（100+20）')

  // ── 第一条不变量：打开后原样保存，文件逐字节不变 ──
  ok(applyDocToMxfile(real, doc).text === real, '**原样写回 ⇒ 文件逐字节不变**')
  ok(__plan(real, doc).edits.length === 0, '原样写回时编辑计划为空（0 条编辑）')

  // ── 改内容：节点/边/标签/坐标 ──
  const moved = JSON.parse(JSON.stringify(doc))
  moved.nodes.filter((n) => n.id === 'child')[0].x = 220 // 绝对 220 → 相对父级 120
  moved.nodes.filter((n) => n.id === 'cont')[0].label = '改名了'
  moved.meta.pinned = true
  const written = applyDocToMxfile(real, moved).text
  const backDoc = parseMxfile(written).doc
  ok(backDoc.nodes.filter((n) => n.id === 'child')[0].x === 220, '子单元移动后读回来还在 220（相对坐标写对了）')
  ok(backDoc.nodes.filter((n) => n.id === 'cont')[0].label === '改名了', '<object> 包装的标签改在**外层** label 上')
  ok(backDoc.meta.pinned === true, 'meta.pinned 落进文件（元数据单元）')
  // 页 1 是压缩的，所以要在**解压后**的页体里数字面量（base64 里当然找不到）。
  const firstBody = bodyOf(written)
  ok((firstBody.match(/drawai-meta/g) || []).length === 1, '元数据单元只有一个（不会每次保存追加一个）')
  const secondWrite = applyDocToMxfile(written, backDoc).text
  ok((bodyOf(secondWrite).match(/drawai-meta/g) || []).length === 1, '再保存一次也仍然只有一个元数据单元')
  ok(applyDocToMxfile(written, backDoc).text === written, '写回幂等：同一份文档写两次结果一致')
  ok(parseMxfile(written).pageCount === 2 && written.indexOf(page2) > 0, '第 2 页**逐字节保留**')
  ok(/<diagram id="p1"[^>]*>\s*[^<\s]/.test(written), '页 1 写回后仍是压缩形态（形态不被我们改掉）')

  const body = bodyOf(written)
  ok(body.indexOf('alternateBounds') > 0, '几何里的 <mxRectangle as="alternateBounds"> 原样保留')
  ok(body.indexOf('placeholders="1"') > 0 && body.indexOf('subnet="10.0.0"') > 0, '<object> 上的自定义属性原样保留')
  ok(/<mxCell id="child"[^>]*>\s*<mxGeometry x="120"/.test(body), '子单元写出的是**相对父级**的 x="120"')
  ok(body.indexOf('id="ghost"') > 0, '我们不认识的边（两端没落点）原样留在文件里')
  ok(body.indexOf('image;image=x.png;') > 0, '图片单元的 style 没被动过')

  // ── 删除：只删我们拥有、且模型里已经没有的单元 ──
  const killCont = JSON.parse(JSON.stringify(doc))
  killCont.nodes = killCont.nodes.filter((n) => n.id !== 'cont')
  const killed = applyDocToMxfile(real, killCont).text
  const killedBody = bodyOf(killed)
  ok(killedBody.indexOf('id="cont"') < 0, '删掉容器后它的单元被移除')
  const parentOfChild = /<mxCell id="child"[^>]*parent="([^"]+)"/.exec(killedBody)
  ok(parentOfChild !== null && parentOfChild[1] !== 'cont', '子单元被接到还活着的祖先上：parent=' + (parentOfChild === null ? '(无)' : parentOfChild[1]))
  ok(/<mxCell id="child"[^>]*>\s*<mxGeometry x="120" y="80"/.test(killedBody), '接走时坐标补成新父级下的绝对坐标（120,80）')
  ok(parseMxfile(killed).doc.nodes.filter((n) => n.id === 'child')[0].x === 120, '画布上的位置没因删容器而变')
  ok(killedBody.indexOf('id="ghost"') > 0, '删容器不影响我们不认识的单元')
  ok(applyDocToMxfile(killed, parseMxfile(killed).doc).text === killed, '删完再写一次仍幂等')

  // ── 容器被移动：子单元保持**画布上**的绝对位置 ──
  const moveCont = JSON.parse(JSON.stringify(doc))
  moveCont.nodes.filter((n) => n.id === 'cont')[0].x = 700
  const movedText = applyDocToMxfile(real, moveCont).text
  const afterMove = parseMxfile(movedText).doc
  ok(afterMove.nodes.filter((n) => n.id === 'cont')[0].x === 700, '容器移动写回')
  ok(afterMove.nodes.filter((n) => n.id === 'child')[0].x === 120, '子单元**没有**跟着容器漂移（与画布所见一致）')
  ok(applyDocToMxfile(movedText, afterMove).text === movedText, '移动容器后仍幂等')

  // ── 新增：插到第一个图层下 ──
  const added = JSON.parse(JSON.stringify(doc))
  added.nodes.push({ id: 'new1', label: '新', style: 'rounded=1;', x: 700, y: 700, w: 130, h: 60 })
  added.edges.push({ id: 'newedge', from: 'new1', to: 'cont', style: 'endArrow=classic;' })
  const addedText = applyDocToMxfile(real, added).text
  const addedDoc = parseMxfile(addedText).doc
  ok(addedDoc.nodes.filter((n) => n.id === 'new1').length === 1 && addedDoc.nodes.filter((n) => n.id === 'new1')[0].x === 700, '新节点写进文件且坐标正确')
  ok(addedDoc.edges.filter((e) => e.id === 'newedge')[0].from === 'new1', '新边写进文件')
  ok(applyDocToMxfile(addedText, addedDoc).text === addedText, '新增后仍幂等')
  ok(addedText.indexOf(page2) > 0, '新增后第 2 页仍逐字节保留')
  ok(bodyOf(addedText).indexOf('container=1;') > 0, '新增后原有单元的 style 仍在')

  // ── 边上没有一个落点：宁可丢掉并如实上报，也不写出画不出的边 ──
  const orphan = JSON.parse(JSON.stringify(doc))
  orphan.edges.push({ id: 'orphan', from: 'nope', to: 'nada', style: '' })
  const orphanPlan = __plan(real, orphan)
  ok(orphanPlan.dropped.indexOf('orphan') >= 0, '两端都没落点的边被丢掉并记进 dropped')

  // ── 压缩与非压缩都走同一条写回路径 ──
  const plainFile = buildMxfile(doc).text
  const plainWritten = applyDocToMxfile(plainFile, doc).text
  ok(plainWritten === plainFile, '非压缩文件同样"原样写回逐字节不变"')
}

console.log('\n[6] 边标签单元（drawio 的 edgeLabel）不导入、不拥有、原样保留')
{
  // 真实产物里就有这种单元：drawio 的"边标签"是一个 **vertex**，
  // 样式带 `edgeLabel`、几何是 `relative="1"` + `<mxPoint as="offset"/>`。
  // 当成普通节点读进来会出两件坏事：画布上多一个鬼影框；被拖动时写回会把绝对坐标
  // 写进一个"相对"几何里，把 drawio 里的标签偏移弄歪。
  const withLabel = [
    '<mxfile host="app.diagrams.net" compressed="false">',
    '  <diagram id="p1" name="Page-1">',
    '    <mxGraphModel dx="0" dy="0"><root>',
    '      <mxCell id="0" /><mxCell id="1" parent="0" />',
    '      <mxCell id="n1" value="起点" style="rounded=1;" vertex="1" parent="1">',
    '        <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />',
    '      </mxCell>',
    '      <mxCell id="n2" value="终点" style="rounded=1;" vertex="1" parent="1">',
    '        <mxGeometry x="400" y="40" width="120" height="60" as="geometry" />',
    '      </mxCell>',
    '      <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="n1" target="n2">',
    '        <mxGeometry relative="1" as="geometry" />',
    '      </mxCell>',
    '      <mxCell id="elabel1" value="Text" style="edgeLabel;html=1;align=center;points=[];" vertex="1" connectable="0" parent="1">',
    '        <mxGeometry relative="1" x="-30" y="10" as="geometry"><mxPoint as="offset" /></mxGeometry>',
    '      </mxCell>',
    '    </root></mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ].join('\n')

  const read = parseMxfile(withLabel)
  ok(read.doc.nodes.length === 2, '两个真节点（边标签单元不算节点，实际 ' + read.doc.nodes.length + '）')
  ok(read.doc.nodes.every((n) => n.id !== 'elabel1'), '边标签单元没有被当成节点导入')
  ok(read.doc.edges.length === 1 && read.doc.edges[0].id === 'e1', '那条边照常导入')
  ok(read.notes.join(' | ').indexOf('边标签单元') >= 0, 'notes 里说明了它被原样保留：' + read.notes.join(' | '))

  // 打开后原样保存：逐字节不变，且**没有任何编辑** —— 这说明它不在我们的所有权里
  // （一旦被"拥有"，模型里没有它就会被当成用户删除而抹掉，那是真正的数据丢失）。
  ok(applyDocToMxfile(withLabel, read.doc).text === withLabel, '原样写回逐字节不变（含那个标签单元）')
  ok(__plan(withLabel, read.doc).edits.length === 0, '原样写回时 0 条编辑（它不归我们管，所以不会被删）')

  // 挪一个真节点：标签单元仍在，几何还是相对坐标，没被动过。
  const moved = JSON.parse(JSON.stringify(read.doc))
  moved.nodes.filter((n) => n.id === 'n1')[0].x = 80
  const written = applyDocToMxfile(withLabel, moved).text
  ok(written.indexOf('id="elabel1"') > 0 && written.indexOf('edgeLabel;') > 0, '挪别的节点之后，边标签单元仍在文件里')
  const labelBlock = /<mxCell id="elabel1"[\s\S]*?<\/mxCell>/.exec(written)
  ok(labelBlock !== null && labelBlock[0].indexOf('relative="1" x="-30" y="10"') > 0, '它的几何没被动过（仍是相对坐标 -30,10）')
  ok(written.indexOf('<mxPoint as="offset" />') > 0, '几何里的 <mxPoint as="offset" /> 也原样保留')

  // 现在**要读得出来**：挂在边上的按"沿边比例 + 垂直偏移 + 残余偏移"记下来，
  // 没挂在边上的（从别处粘过来那种）按它自己的坐标记下来。
  ok(Array.isArray(read.doc.labels) && read.doc.labels.length === 1, 'doc.labels 里读到 1 个标签单元（实际 ' + (Array.isArray(read.doc.labels) ? read.doc.labels.length : '-') + '）')
  const one = read.doc.labels[0]
  ok(one.id === 'elabel1' && one.text === 'Text', '文本与 id 读对了：' + JSON.stringify({ id: one.id, text: one.text }))
  ok(one.edgeId === null, '它的 parent 是图层（不是边）→ edgeId 为 null（按自己的坐标显示）')
  ok(one.relative === true && one.x === -30 && one.y === 10, '相对几何的三个量都读出来了：' + JSON.stringify([one.relative, one.x, one.y]))
  ok(one.offsetX === 0 && one.offsetY === 0, '<mxPoint as="offset" /> 没有 x/y → 残余偏移 (0,0)')

  // 挂在边上的那种（drawio 真正创建标签时的形态：parent = 边）
  const onEdge = withLabel.replace('connectable="0" parent="1"', 'connectable="0" parent="e1"').replace('<mxPoint as="offset" />', '<mxPoint x="7" y="-3" as="offset" />')
  const read2 = parseMxfile(onEdge)
  ok(read2.doc.labels[0].edgeId === 'e1', 'parent 是边 → 关联到那条边（' + String(read2.doc.labels[0].edgeId) + '）')
  ok(read2.doc.labels[0].offsetX === 7 && read2.doc.labels[0].offsetY === -3, '残余偏移读对了：' + JSON.stringify([read2.doc.labels[0].offsetX, read2.doc.labels[0].offsetY]))
  ok(applyDocToMxfile(onEdge, read2.doc).text === onEdge, '这种形态同样：原样写回逐字节不变')
}

console.log('\n[7] 顺序（z-order）：模型里的先后要真的写回文件')
{
  // drawio 的"谁在上面"就是单元在 root 里的先后，而画布上节点的先后也决定覆盖顺序 ——
  // 所以"置顶/置底"改的是模型数组顺序，文件那边必须跟着改，否则重新载入又变回原样。
  const W = (id, x) => ({ id: id, label: id, style: '', x: x, y: 0, w: 130, h: 60 })
  const doc = { version: 2, revision: '', meta: {}, nodes: [W('n1', 0), W('n2', 200), W('n3', 400)], edges: [] }
  const built = buildMxfile(doc).text
  const back = parseMxfile(built).doc
  const ids = (text) => [...text.matchAll(/<mxCell id="(n\d)"/g)].map((m) => m[1])
  ok(ids(built).join(',') === 'n1,n2,n3', '起始顺序：' + ids(built).join(','))

  // 没有改动时**一条编辑都不发**（这条保住了"打开后原样保存逐字节不变"）
  ok(applyDocToMxfile(built, back).text === built, '没有改动时逐字节不变')
  ok(__plan(built, back).edits.length === 0, '没有改动时 0 条编辑')

  // 把 n1 置顶：模型顺序变成 n2,n3,n1
  const front = JSON.parse(JSON.stringify(back))
  front.nodes.push(front.nodes.shift())
  const out = applyDocToMxfile(built, front)
  ok(ids(out.text).join(',') === 'n2,n3,n1', '置顶之后文件里的先后跟着变：' + ids(out.text).join(','))
  const reread = parseMxfile(out.text).doc
  ok(reread.nodes.map((n) => n.id).join(',') === 'n2,n3,n1', '读回来的模型顺序一致')
  ok(reread.nodes.length === 3 && reread.nodes.filter((n) => n.id === 'n1')[0].x === 0, '单元没丢、几何没坏')
  ok(applyDocToMxfile(out.text, reread).text === out.text, '重排之后仍然幂等')

  // 置底：变成 n1,n2,n3 → 再置底 n1 就是 n2,n3,n1
  const back2 = JSON.parse(JSON.stringify(back))
  back2.nodes.unshift(back2.nodes.pop())
  ok(ids(applyDocToMxfile(built, back2).text).join(',') === 'n3,n1,n2', '置底同样写回：' + ids(applyDocToMxfile(built, back2).text).join(','))

  // 顺序**没**变时不该产生编辑（否则每次保存都会顺手重排文件）
  const plan = __plan(built, back)
  ok(plan.edits.every((e) => e.insert === false), '没有重排时不会有"插入"型编辑')
}

console.log('\n[8] 编辑数据：`<object>` 上的自定义属性')
{
  // drawio 的"编辑数据"就存在 `<object>` 包装的自定义属性上（mxCell 上的陌生属性会被它丢掉）。
  const src = [
    '<mxfile host="app.diagrams.net" compressed="false">',
    '  <diagram id="p1" name="Page-1">',
    '    <mxGraphModel dx="0" dy="0"><root>',
    '      <mxCell id="0" /><mxCell id="1" parent="0" />',
    '      <object label="带数据的节点" placeholders="1" subnet="192.168.0" id="n1">',
    '        <mxCell style="rounded=1;" vertex="1" parent="1">',
    '          <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />',
    '        </mxCell>',
    '      </object>',
    '      <mxCell id="n2" value="没有数据的节点" style="" vertex="1" parent="1">',
    '        <mxGeometry x="300" y="40" width="120" height="60" as="geometry" />',
    '      </mxCell>',
    '    </root></mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ].join('\n')

  const read = parseMxfile(src)
  const n1 = read.doc.nodes.filter((n) => n.id === 'n1')[0]
  ok(n1 !== undefined && n1.data !== undefined, '包装上的自定义属性读进了 node.data')
  ok(n1.data.placeholders === '1' && n1.data.subnet === '192.168.0', '数据值都读对了：' + JSON.stringify(n1.data))
  ok(n1.data.id === undefined && n1.data.label === undefined, 'id / label 不算数据（它们是包装的固定字段）')
  ok(read.doc.nodes.filter((n) => n.id === 'n2')[0].data === undefined, '没有包装的节点没有 data')
  ok(applyDocToMxfile(src, read.doc).text === src, '原样写回逐字节不变（含数据属性）')

  // 改数据：只动包装上的属性
  const edited = JSON.parse(JSON.stringify(read.doc))
  edited.nodes.filter((n) => n.id === 'n1')[0].data = { placeholders: '1', subnet: '10.1.2.0', owner: '我' }
  const outText = applyDocToMxfile(src, edited).text
  const out = parseMxfile(outText).doc
  const n1b = out.nodes.filter((n) => n.id === 'n1')[0]
  ok(n1b.data.subnet === '10.1.2.0' && n1b.data.owner === '我', '改值 + 新增键都写回了：' + JSON.stringify(n1b.data))
  ok(n1b.data.placeholders === '1', '没动的键还在')
  ok(outText.indexOf('placeholders="1"') > 0, '属性仍在包装上（不是写进 mxCell）')
  ok(parseMxfile(outText).doc.nodes.filter((n) => n.id === 'n2')[0].label === '没有数据的节点', '别的单元没被牵连')

  // 删键：模型里去掉的键要从包装上消失
  const removed = JSON.parse(JSON.stringify(out))
  removed.nodes.filter((n) => n.id === 'n1')[0].data = { subnet: '10.1.2.0' }
  const removedText = applyDocToMxfile(outText, removed).text
  ok(removedText.indexOf('placeholders=') < 0 && removedText.indexOf('owner=') < 0, '模型里删掉的键从包装上消失')
  ok(parseMxfile(removedText).doc.nodes.filter((n) => n.id === 'n1')[0].data.subnet === '10.1.2.0', '留着的键还在')

  // 给**裸 mxCell** 加数据 → 要包成 `<object>`（否则 drawio 保存时会把属性丢掉）
  const wrapped = JSON.parse(JSON.stringify(read.doc))
  wrapped.nodes.filter((n) => n.id === 'n2')[0].data = { kind: '服务器' }
  const wrappedText = applyDocToMxfile(src, wrapped).text
  ok(/<object label="没有数据的节点" kind="服务器" id="n2">/.test(wrappedText), '裸 mxCell 被包成 <object>，label 移到外层：' + JSON.stringify((/<object[^>]*n2[^>]*>/.exec(wrappedText) || [''])[0]))
  const reWrapped = parseMxfile(wrappedText).doc.nodes.filter((n) => n.id === 'n2')[0]
  ok(reWrapped.data.kind === '服务器' && reWrapped.label === '没有数据的节点', '读回来：数据与标签都对')
  ok(reWrapped.x === 300 && reWrapped.w === 120, '几何没被包装弄坏')
  ok(applyDocToMxfile(wrappedText, parseMxfile(wrappedText).doc).text === wrappedText, '包好之后再保存是幂等的')

  // 从零生成：带数据的单元也要包一层
  const built = buildMxfile({ version: 2, revision: '', meta: {}, nodes: [{ id: 'x', label: '甲', style: '', x: 0, y: 0, w: 100, h: 60, data: { a: '1' } }], edges: [] }).text
  ok(/<object label="甲" a="1" id="x">/.test(built), '生成的 mxfile 里也带包装')
  ok(parseMxfile(built).doc.nodes[0].data.a === '1', '生成的文件读回来数据在')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
