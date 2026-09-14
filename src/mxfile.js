/**
 * mxfile（`.drawio`）↔ 语义文档 互转 —— **宿主半边**。
 *
 * 为什么放在宿主：读 `.drawio` 要解压（drawio 默认把 `<diagram>` 的内容压成
 * base64(raw deflate(URI 编码的 XML))），而浏览器侧没有 zlib；宿主是 Node，`node:zlib` 现成，
 * 而且**写盘本来就必须走宿主的 ctx.fs**（带沙箱策略）。于是客户端只做两件事：
 * 让宿主"把这个 .drawio 读成文档"，以及"把这份文档写成 .drawio"。
 *
 * 转换原则：
 *   · **style 串原样搬运**。本轮的格式改造已经把我们的 style 键对齐到 drawio，
 *     所以节点/边的 `style` 属性可以直接带走、也能原样带回 —— 这是互通的根。
 *   · 只有**几何与结构**需要翻译：顶点坐标（含容器子单元的相对坐标 → 绝对）、
 *     折点（`<Array as="points">`）、悬空端（`sourcePoint`/`targetPoint`）、标签（`value`/`object@label`）。
 *   · 存不下的东西**如实报**（多页、图层、分组、图片/自定义形状），返回 notes 让界面说明，
 *     而不是假装成功。
 *
 * 格式依据（都在 drawio 仓库里核实过）：
 *   · 压缩：`Graph.compress = pako.deflateRaw(encodeURIComponent(xml))` → `btoa`；
 *     解压是逆过程（js/grapheditor/Graph.js 的 compress / decompress）。
 *   · 结构：`<mxfile><diagram><mxGraphModel><root>`；页面设置挂在 `mxGraphModel` 的属性上。
 *   · 单元：`<mxCell id/value/style/parent/source/target/vertex/edge>` + `<mxGeometry as="geometry">`。
 *   · 用户对象：`<object label="…" id="…"><mxCell …/></object>` —— id/label 在外层。
 */
import { deflateRawSync, inflateRawSync, inflateSync } from 'node:zlib'

/** 画布默认页尺寸（导出时写进 mxGraphModel，drawio 缺省与此一致：A4 竖版 × 100 dpi）。 */
const PAGE_W = 850
const PAGE_H = 1100

// ---- XML 小工具（mxfile 的属性/文本足够用，不引入 XML 依赖）-------------------

/** 解码 XML 实体（含数字实体）。*/
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 属性值转义（导出用）。*/
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 从一段"标签的属性区"里取一个属性的原值（未解码）。*/
function rawAttr(attrs, name) {
  const match = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs)
  return match === null ? undefined : match[1]
}

/** 取一个属性并解码实体。*/
function attr(attrs, name) {
  const raw = rawAttr(attrs, name)
  return raw === undefined ? undefined : decodeEntities(raw)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 把 drawio 的标签文本变成"纯文本标签"。
 *
 * 我们按纯文本渲染标签，而 drawio 的标签常带 HTML（`html=1` + `<br>`、`<b>`…）。
 * 所以把 `<br>` 折成空格、去掉其余标签，再解实体 —— 读起来才是人写的那句话。
 * 代价：导出时 markup 回不去（如实记在 notes 里）。
 */
function labelFromValue(value) {
  if (value === undefined || value === null) return ''
  let text = String(value)
  if (text.indexOf('<') < 0 && text.indexOf('&') < 0) return text
  const hadMarkup = /<[a-zA-Z/][^>]*>/.test(text)
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
  text = decodeEntities(text)
  return hadMarkup ? text.replace(/\s+/g, ' ').trim() : text
}

/** 这个标签文本里是否含 markup（用于 notes）。*/
function hasMarkup(value) {
  return typeof value === 'string' && /<[a-zA-Z/][^>]*>/.test(value)
}

/** 解压一段 `<diagram>` 内容：未压缩直接返回，压缩的按 drawio 的算法解。 */
function decodeDiagramBody(body) {
  const trimmed = String(body === undefined || body === null ? '' : body).trim()
  if (trimmed.length === 0) return ''
  if (trimmed.charAt(0) === '<') return trimmed
  const buffer = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64')
  let xml
  try {
    xml = inflateRawSync(buffer).toString('utf8')
  } catch (error) {
    // 少数文件用的是带 zlib 头的 deflate；再试一次，仍失败就把原因抛给调用方。
    xml = inflateSync(buffer).toString('utf8')
  }
  try {
    return decodeURIComponent(xml)
  } catch (error) {
    return xml
  }
}

// ---- 解析 ------------------------------------------------------------------

/** 把 `<root>…</root>` 里的单元扫成 [{attrs, geometry, wrapper}]（保持文档顺序）。*/
function scanCells(rootXml) {
  const cells = []
  const cellRe = /<(object|UserObject|mxCell)\b([^>]*?)(\/>|>)/g
  let match
  while ((match = cellRe.exec(rootXml)) !== null) {
    const kind = match[1]
    const attrs = match[2]
    const selfClosing = match[3] === '/>'
    const startTagEnd = match.index + match[0].length
    let block = ''
    let end = startTagEnd
    if (selfClosing) {
      end = startTagEnd
    } else if (kind === 'mxCell') {
      const close = rootXml.indexOf('</mxCell>', startTagEnd)
      end = close < 0 ? rootXml.length : close + '</mxCell>'.length
      block = rootXml.slice(startTagEnd, close < 0 ? rootXml.length : close)
    } else {
      const close = rootXml.indexOf('</' + kind + '>', startTagEnd)
      end = close < 0 ? rootXml.length : close + ('</' + kind + '>').length
      block = rootXml.slice(startTagEnd, close < 0 ? rootXml.length : close)
    }
    // 用户对象（<object>）：id/label 在外层，里面才是 mxCell。
    let cellAttrs = attrs
    let cellBlock = block
    let wrapperLabel
    if (kind !== 'mxCell') {
      wrapperLabel = attr(attrs, 'label')
      const inner = /<mxCell\b([^>]*?)(\/>|>)/.exec(block)
      if (inner !== null) {
        cellAttrs = inner[1]
        const innerStart = inner.index + inner[0].length
        const innerClose = block.indexOf('</mxCell>', innerStart)
        cellBlock = block.slice(innerStart, innerClose < 0 ? block.length : innerClose)
        if (inner[2] === '/>') cellBlock = ''
      }
    }
    const geometryMatch = /<mxGeometry\b([^>]*?)(\/>|>)/.exec(cellBlock)
    let geometry = null
    if (geometryMatch !== null) {
      const geoAttrs = geometryMatch[1]
      let geoInner = ''
      if (geometryMatch[2] === '>') {
        const close = cellBlock.indexOf('</mxGeometry>', geometryMatch.index)
        geoInner = close < 0 ? '' : cellBlock.slice(geometryMatch.index + geometryMatch[0].length, close)
      }
      const points = []
      const arrayMatch = /<Array\b[^>]*as\s*=\s*"points"[^>]*>([\s\S]*?)<\/Array>/.exec(geoInner)
      if (arrayMatch !== null) {
        const pointRe = /<mxPoint\b([^>]*?)\/>/g
        let pm
        while ((pm = pointRe.exec(arrayMatch[1])) !== null) {
          const x = num(attr(pm[1], 'x'))
          const y = num(attr(pm[1], 'y'))
          if (x !== undefined && y !== undefined) points.push({ x: x, y: y })
        }
      }
      const terminal = (name) => {
        const re = new RegExp('<mxPoint\\b([^>]*?)as\\s*=\\s*"' + name + '"[^>]*?/>')
        const found = re.exec(geoInner)
        if (found === null) return null
        const x = num(attr(found[1], 'x'))
        const y = num(attr(found[1], 'y'))
        return x === undefined || y === undefined ? null : { x: x, y: y }
      }
      geometry = {
        x: num(attr(geoAttrs, 'x')),
        y: num(attr(geoAttrs, 'y')),
        width: num(attr(geoAttrs, 'width')),
        height: num(attr(geoAttrs, 'height')),
        relative: attr(geoAttrs, 'relative') === '1',
        points: points,
        sourcePoint: terminal('sourcePoint'),
        targetPoint: terminal('targetPoint'),
      }
    }
    // `<object>`/`<UserObject>` 包装的单元：内层 mxCell **不带 id**，id 在外层。
    const innerId = attr(cellAttrs, 'id')
    cells.push({
      id: innerId === undefined ? attr(attrs, 'id') : innerId,
      label: wrapperLabel !== undefined ? wrapperLabel : attr(cellAttrs, 'value'),
      style: rawAttr(cellAttrs, 'style') === undefined ? '' : decodeEntities(rawAttr(cellAttrs, 'style')),
      parent: attr(cellAttrs, 'parent'),
      source: attr(cellAttrs, 'source'),
      target: attr(cellAttrs, 'target'),
      vertex: attr(cellAttrs, 'vertex') === '1',
      edge: attr(cellAttrs, 'edge') === '1',
      geometry: geometry,
    })
    cellRe.lastIndex = end
  }
  return cells
}

/**
 * 解析 mxfile 文本 → 语义文档。
 *
 * @param text `.drawio` / mxfile 的全文
 * @param options.existing 可选的现有文档（保留它的 meta / revision）
 * @returns { doc, notes, pageCount } —— notes 是给人看的损失说明（多页、图层、分组…）
 */
export function parseMxfile(text, options) {
  const notes = []
  let source = String(text === undefined || text === null ? '' : text)
  // 有的编辑器（记事本、某些 IDE 插件）会给 UTF-8 文件加 BOM。摘掉它更省心 ——
  // 虽然"按内容找 <diagram>"本来就不受影响，但留着它会让文件首字符变成 U+FEFF。
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
  // UTF-16（记事本的"Unicode"）被当 UTF-8 读进来时，ASCII 之间全是空字符。
  // 这种情况**不猜**：硬按 UTF-16 重解释，中日韩标签会变成乱码，而乱码是看不见的损失。
  // 宁可报一句用户马上能照做的错。
  if (source.indexOf('\u0000') >= 0) {
    throw new Error('这个文件像是 UTF-16 编码（读进来时每两个字节夹着一个空字符）：请用 UTF-8 另存后再导入')
  }
  if (source.trim().length === 0) throw new Error('.drawio 文件是空的')
  const diagrams = [...source.matchAll(/<diagram\b([^>]*?)(\/>|>)([\s\S]*?)(?:<\/diagram>|$)/g)]
  if (diagrams.length === 0) throw new Error('这不是 mxfile：找不到 <diagram> 元素')
  const pageCount = diagrams.length
  const first = diagrams[0]
  const body = decodeDiagramBody(first[3])
  const modelMatch = /<mxGraphModel\b([^>]*?)(\/>|>)/.exec(body)
  if (modelMatch === null) throw new Error('这个 <diagram> 里没有 <mxGraphModel>')

  const rootStart = body.indexOf('<root>')
  const rootEnd = body.indexOf('</root>')
  if (rootStart < 0 || rootEnd < rootStart) throw new Error('mxGraphModel 里没有 <root>')
  const cells = scanCells(body.slice(rootStart, rootEnd))

  // 结构识别（**不能**假定 root 的 id 是 "0"：从模板出来的文件里 id 是带前缀的）。
  const byId = new Map()
  for (const cell of cells) if (typeof cell.id === 'string') byId.set(cell.id, cell)
  const rootCell = cells.find((c) => c.parent === undefined || c.parent === null || c.parent === '')
  const rootId = rootCell === undefined ? undefined : rootCell.id
  const isLayer = (cell) => cell.parent === rootId && cell.vertex !== true && cell.edge !== true && cell.geometry === null
  const layerIds = new Set(cells.filter(isLayer).map((c) => c.id))
  if (layerIds.size > 1) notes.push('导入时把 ' + layerIds.size + ' 个图层摊平在一起（本画布没有图层）')

  /** 顶点：几何是**相对父级**的（容器子单元），沿 parent 链累加成绝对坐标。 */
  const absoluteOf = (cell) => {
    let x = cell.geometry !== null && cell.geometry.x !== undefined ? cell.geometry.x : 0
    let y = cell.geometry !== null && cell.geometry.y !== undefined ? cell.geometry.y : 0
    let parentId = cell.parent
    const guard = new Set()
    while (typeof parentId === 'string' && guard.has(parentId) === false) {
      guard.add(parentId)
      const parent = byId.get(parentId)
      if (parent === undefined || layerIds.has(parent.id) || parent.id === rootId) break
      x += parent.geometry !== null && parent.geometry.x !== undefined ? parent.geometry.x : 0
      y += parent.geometry !== null && parent.geometry.y !== undefined ? parent.geometry.y : 0
      parentId = parent.parent
    }
    return { x: x, y: y }
  }

  const nodes = []
  const keptIds = new Set()
  let containers = 0
  let imageShapes = 0
  let markupLabels = 0
  for (const cell of cells) {
    if (cell.vertex !== true) continue
    if (cell.id === rootId || layerIds.has(cell.id)) continue
    const isContainer = cells.some((c) => c.parent === cell.id && c !== cell)
    if (isContainer) containers += 1
    if (typeof cell.style === 'string' && /(^|;)image[;=]/.test(cell.style)) imageShapes += 1
    if (hasMarkup(cell.label)) markupLabels += 1
    const abs = absoluteOf(cell)
    nodes.push({
      id: String(cell.id),
      label: labelFromValue(cell.label),
      style: cell.style === undefined ? '' : String(cell.style),
      x: abs.x,
      y: abs.y,
      w: cell.geometry !== null && cell.geometry.width !== undefined ? cell.geometry.width : 120,
      h: cell.geometry !== null && cell.geometry.height !== undefined ? cell.geometry.height : 60,
    })
    keptIds.add(String(cell.id))
  }

  const edges = []
  let dangling = 0
  let dropped = 0
  for (const cell of cells) {
    if (cell.edge !== true) continue
    const source = typeof cell.source === 'string' ? cell.source : undefined
    const target = typeof cell.target === 'string' ? cell.target : undefined
    const hasSource = source !== undefined && keptIds.has(source)
    const hasTarget = target !== undefined && keptIds.has(target)
    const geometry = cell.geometry === null ? {} : cell.geometry
    const freeSource = geometry.sourcePoint === undefined || geometry.sourcePoint === null ? null : geometry.sourcePoint
    const freeTarget = geometry.targetPoint === undefined || geometry.targetPoint === null ? null : geometry.targetPoint
    if (!hasSource && freeSource === null) {
      dropped += 1
      continue
    }
    if (!hasTarget && freeTarget === null) {
      dropped += 1
      continue
    }
    if (!hasSource || !hasTarget) dangling += 1
    const edge = { id: String(cell.id), style: cell.style === undefined || cell.style === '' ? '' : String(cell.style) }
    if (hasSource) edge.from = source
    if (hasTarget) edge.to = target
    if (!hasSource && freeSource !== null) edge.sourcePoint = freeSource
    if (!hasTarget && freeTarget !== null) edge.targetPoint = freeTarget
    const label = labelFromValue(cell.label)
    if (label.length > 0) edge.label = label
    if (hasMarkup(cell.label)) markupLabels += 1
    const points = geometry.points === undefined ? [] : geometry.points
    if (points.length > 0) edge.points = points
    edges.push(edge)
  }

  if (pageCount > 1) notes.push('这个文件有 ' + pageCount + ' 页，只导入了第 1 页')
  if (containers > 0) notes.push(containers + ' 个分组/容器被摊平（本画布没有父子几何）')
  if (imageShapes > 0) notes.push(imageShapes + ' 个图片/自定义形状按矩形导入（本画布不画图片）')
  if (markupLabels > 0) notes.push(markupLabels + ' 个 HTML 标签按纯文本导入（`<br>` 折成空格）')
  if (dangling > 0) notes.push(dangling + ' 条边是悬空端（用 sourcePoint/targetPoint 保留）')
  if (dropped > 0) notes.push(dropped + ' 条边的两端都找不到落点，已跳过')

  const existing = options !== undefined && options.existing !== undefined && options.existing !== null ? options.existing : null
  const doc = {
    version: 2,
    revision: existing !== null && Number.isFinite(Number(existing.revision)) ? Number(existing.revision) : 0,
    meta: existing !== null && existing.meta !== undefined && existing.meta !== null ? existing.meta : { engine: 'drawio-svg' },
    nodes: nodes,
    edges: edges,
  }
  return { doc: doc, notes: notes, pageCount: pageCount }
}

// ---- 导出 ------------------------------------------------------------------

/** 文档 → mxfile 文本。默认**不压缩**（人可读、diff 友好；drawio 两种都认）。*/
export function buildMxfile(doc, options) {
  const compressed = options !== undefined && options.compressed === true
  const pageName = options !== undefined && typeof options.name === 'string' && options.name.length > 0 ? options.name : 'Page-1'
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  const edges = Array.isArray(doc.edges) ? doc.edges : []
  const cellById = new Set(nodes.map((n) => String(n.id)))
  const lines = []
  lines.push('<mxfile host="dsh-drawai" agent="dsh-drawai" type="device">')
  lines.push('  <diagram id="dsh-drawai-page-1" name="' + escapeAttr(pageName) + '">')
  lines.push(
    '    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="' +
      PAGE_W +
      '" pageHeight="' +
      PAGE_H +
      '" math="0" shadow="0">',
  )
  lines.push('      <root>')
  lines.push('        <mxCell id="0" />')
  lines.push('        <mxCell id="1" parent="0" />')
  for (const node of nodes) {
    const style = typeof node.style === 'string' && node.style.length > 0 ? ' style="' + escapeAttr(node.style) + '"' : ''
    const label = typeof node.label === 'string' && node.label.length > 0 ? ' value="' + escapeAttr(node.label) + '"' : ''
    const x = Number.isFinite(Number(node.x)) ? Number(node.x) : 0
    const y = Number.isFinite(Number(node.y)) ? Number(node.y) : 0
    const w = Number.isFinite(Number(node.w)) ? Number(node.w) : 120
    const h = Number.isFinite(Number(node.h)) ? Number(node.h) : 60
    lines.push('        <mxCell id="' + escapeAttr(String(node.id)) + '"' + label + style + ' vertex="1" parent="1">')
    lines.push('          <mxGeometry x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" as="geometry" />')
    lines.push('        </mxCell>')
  }
  for (const edge of edges) {
    const from = typeof edge.from === 'string' && cellById.has(edge.from) ? edge.from : undefined
    const to = typeof edge.to === 'string' && cellById.has(edge.to) ? edge.to : undefined
    const style = typeof edge.style === 'string' && edge.style.length > 0 ? ' style="' + escapeAttr(edge.style) + '"' : ''
    const label = typeof edge.label === 'string' && edge.label.length > 0 ? ' value="' + escapeAttr(edge.label) + '"' : ''
    const terminals = (from === undefined ? '' : ' source="' + escapeAttr(from) + '"') + (to === undefined ? '' : ' target="' + escapeAttr(to) + '"')
    lines.push('        <mxCell id="' + escapeAttr(String(edge.id)) + '"' + label + style + ' edge="1" parent="1"' + terminals + '>')
    const points = Array.isArray(edge.points) ? edge.points : []
    const sourcePoint = edge.sourcePoint !== undefined && edge.sourcePoint !== null ? edge.sourcePoint : null
    const targetPoint = edge.targetPoint !== undefined && edge.targetPoint !== null ? edge.targetPoint : null
    const hasInner = points.length > 0 || sourcePoint !== null || targetPoint !== null
    if (!hasInner) {
      lines.push('          <mxGeometry relative="1" as="geometry" />')
    } else {
      lines.push('          <mxGeometry relative="1" as="geometry">')
      if (sourcePoint !== null) lines.push('            <mxPoint x="' + Number(sourcePoint.x) + '" y="' + Number(sourcePoint.y) + '" as="sourcePoint" />')
      if (targetPoint !== null) lines.push('            <mxPoint x="' + Number(targetPoint.x) + '" y="' + Number(targetPoint.y) + '" as="targetPoint" />')
      if (points.length > 0) {
        lines.push('            <Array as="points">')
        for (const point of points) lines.push('              <mxPoint x="' + Number(point.x) + '" y="' + Number(point.y) + '" />')
        lines.push('            </Array>')
      }
      lines.push('          </mxGeometry>')
    }
    lines.push('        </mxCell>')
  }
  lines.push('      </root>')
  lines.push('    </mxGraphModel>')
  const model = lines.slice(2).join('\n')
  const head = lines.slice(0, 2).join('\n')
  const tail = ['  </diagram>', '</mxfile>', ''].join('\n')
  if (!compressed) return head + '\n' + model + '\n' + tail
  const payload = deflateRawSync(Buffer.from(encodeURIComponent(model), 'utf8')).toString('base64')
  return '<mxfile host="dsh-drawai" agent="dsh-drawai" type="device">\n  <diagram id="dsh-drawai-page-1" name="' + escapeAttr(pageName) + '">\n    ' + payload + '\n  </diagram>\n</mxfile>\n'
}
