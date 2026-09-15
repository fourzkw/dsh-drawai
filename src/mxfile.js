/**
 * mxfile（`.drawio`）编解码 + **无损写回** —— **宿主半边**（要 node:zlib / node:crypto）。
 *
 * 载体决策（2026-09）：`.drawio` 就是唯一真相，不再有 `.dshd.json` 这种自定义格式。
 * 于是这个文件从"导入/导出的转换器"升级成"读写器"，而**写**必须满足一条硬要求：
 *
 *   **只改我们拥有的单元，其余原文一个字节都不动。**
 *
 * 为什么：drawio 的画布能力比我们大（多页、图层、分组层级、图片、HTML 标签、
 * UserObject 自定义属性、旋转翻转、页面设置…）。我们只理解其中一个子集 ——
 * 如果写回是"按模型重新生成整份 XML"，那么用户稿子里我们不理解的部分会在保存时
 * **被悄悄删掉**；而"悄悄"是最糟的失败方式（用户以为在编辑，其实在删）。
 * 所以写回做成外科手术：
 *   · 页 1 的 `<root>` 之外（其他页、mxfile 属性、空白）**逐字节保留**；
 *   · 单元按 id 对应：我们导入过的（节点/边）只重写 `value`/`style`/几何/端点这几处属性，
 *     连 `<object>` 包装上的自定义属性、`<mxRectangle as="alternateBounds">` 都原样留着；
 *   · 我们没导入的单元（两端都找不到落点的边等）原样留着，不因为我们不认识就删；
 *   · 只有"我们导入过、而模型里已经没有了"的单元才删 —— 那才是用户真的删了它；
 *   · 原本压缩的页体，写回后仍然压缩（保持 drawio 的形态，也保住别处的字节）。
 *
 * 结果是一条可断言的性质：**打开后原样保存，文件逐字节不变**（见 check-mxfile）。
 *
 * 另外两件必须落在文件里的事（载体是唯一真相，没有第二个地方可存）：
 *   · `meta.pinned`（人手工摆过版面，AI 别再自动重排）→ 一个隐藏的 `<object>` 元数据单元；
 *   · `revision` → **不用存**，直接用文件内容的指纹（`contentHash`）。这样 drawio 或别的
 *     编辑器改过文件，指纹自然就变了，乐观锁不会因为"属性被 drawio 丢掉"而假冲突。
 *
 * 格式依据（都在 drawio 仓库里核实过）：
 *   · 压缩：`Graph.compress = pako.deflateRaw(encodeURIComponent(xml))` → `btoa`；
 *     解压是逆过程（js/grapheditor/Graph.js 的 compress / decompress）。
 *   · 结构：`<mxfile><diagram><mxGraphModel><root>`；页面设置挂在 `mxGraphModel` 的属性上。
 *   · 单元：`<mxCell id/value/style/parent/source/target/vertex/edge>` + `<mxGeometry as="geometry">`。
 *   · 用户对象：`<object label="…" id="…">` —— id/label 在外层，自定义属性也挂外层
 *     （这正是 drawio 发明它来存任意属性的原因，所以我们的元数据也挂这种单元上）。
 *   · 容器子单元的 `<mxGeometry>` 坐标是**相对父级**的（读要累加，写要减回去）。
 */
import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync, inflateSync } from 'node:zlib'
// style 的"真相"只有一份（内核）：这里只借它做**语义比较**，
// 免得"文档层规范化过的 style 串"和"文件里原样的串"逐字不同，就把没动过的单元重写一遍。
import { DEFAULT_EDGE_STYLE, formatStyle } from './style-kernel.js'

/** 画布默认页尺寸（新建文件时写进 mxGraphModel，drawio 缺省与此一致：A4 竖版 × 100 dpi）。 */
const PAGE_W = 850
const PAGE_H = 1100

/**
 * 元数据单元的 id。它没有 `vertex`/`edge`，所以不会被当成图形单元；
 * 挂在图层下（不是 root 下），所以也不会被误认成图层。
 */
export const META_ID = 'drawai-meta'

// ---- 文本与属性小工具（mxfile 的属性/文本足够用，不引入 XML 依赖）-----------

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

/** 属性值转义（写回用）。*/
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

/** 内容指纹：revision 就是它（不落盘、不依赖属性存活）。*/
export function contentHash(text) {
  return createHash('sha256').update(String(text === undefined || text === null ? '' : text), 'utf8').digest('hex').slice(0, 12)
}

/**
 * 属性区解析：把一段属性拆成有序的 {name, leadStart, start, end, value}。
 * 保留顺序与原始空白，才能做到"没改的属性一个字节都不动"。
 */
function parseAttrs(text, from, to) {
  const out = []
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  re.lastIndex = from
  let match
  while ((match = re.exec(text)) !== null) {
    if (match.index >= to) break
    let lead = match.index
    while (lead > from && /\s/.test(text.charAt(lead - 1))) lead -= 1
    out.push({
      name: match[1],
      leadStart: lead,
      start: match.index,
      end: match.index + match[0].length,
      value: match[3] !== undefined ? match[3] : match[4],
    })
  }
  return out
}

/**
 * 在一段属性区里批量覆盖/追加/删除属性。**值必须是已转义的**，`null` 表示删掉这个键。
 *
 * 为什么要"批量"：同一区域连续改两个属性时，第一个属性的长度变化会让第二个属性的
 * 偏移失效 —— 实测过：`x="40"` 改成 `x="200"` 之后，`y` 被写进了标签中间，
 * 整份文件当场花掉。所以这里一次解析、按偏移**从右往左**改。
 */
function setAttrsIn(text, attrsStart, attrsEnd, pairs) {
  const list = parseAttrs(text, attrsStart, attrsEnd)
  const byName = {}
  for (const entry of list) byName[entry.name] = entry
  const edits = []
  const missing = []
  for (const name of Object.keys(pairs)) {
    const value = pairs[name]
    const found = byName[name]
    if (value === null) {
      if (found !== undefined) edits.push({ start: found.leadStart, end: found.end, text: '' })
      continue
    }
    const rendered = name + '="' + value + '"'
    if (found !== undefined) edits.push({ start: found.start, end: found.end, text: rendered })
    else missing.push(rendered)
  }
  edits.sort((a, b) => b.start - a.start)
  let out = text
  // 追加放在**原位**（所有替换点之后），这样先追加也不会影响替换点的偏移。
  if (missing.length > 0) {
    const body = text.slice(attrsStart, attrsEnd)
    const trimmed = body.replace(/\s+$/, '')
    const at = attrsStart + trimmed.length
    out = out.slice(0, at) + ' ' + missing.join(' ') + out.slice(at)
  }
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/**
 * 在一个单元的原文上按区域批量改写。
 *
 * 两条规则缺一不可（都踩过）：
 *   1. **同一个区域的多处改动要合成一次**：`value` 与 `style` 都在 `<mxCell …>` 的属性区里，
 *      分两次改的话，第一次的长度变化会让第二次的偏移失效，标签会被写进属性中间；
 *   2. 不同区域**从右往左**处理：左侧偏移不会因为右侧长度变化而失效。
 */
function withAttrChanges(text, changes) {
  const merged = []
  for (const change of changes) {
    const same = merged.filter((m) => m.attrsStart === change.attrsStart && m.attrsEnd === change.attrsEnd)[0]
    if (same === undefined) merged.push({ attrsStart: change.attrsStart, attrsEnd: change.attrsEnd, pairs: Object.assign({}, change.pairs) })
    else Object.assign(same.pairs, change.pairs)
  }
  merged.sort((a, b) => b.attrsStart - a.attrsStart)
  let out = text
  for (const change of merged) out = setAttrsIn(out, change.attrsStart, change.attrsEnd, change.pairs)
  return out
}

/** 从属性区里删掉一个属性（连它前面的空白一起删，免得留下双空格）。 */
function removeAttrIn(text, attrsStart, attrsEnd, name) {
  return setAttrsIn(text, attrsStart, attrsEnd, { [name]: null })
}

/** 取属性区里某个属性的原值（未解码），没有就 undefined。 */
function attrIn(text, attrsStart, attrsEnd, name) {
  const found = parseAttrs(text, attrsStart, attrsEnd).filter((a) => a.name === name)[0]
  return found === undefined ? undefined : found.value
}

// ---- 标签文本 ---------------------------------------------------------------

/**
 * 把 drawio 的标签文本变成"纯文本标签"。
 *
 * 我们按纯文本渲染标签，而 drawio 的标签常带 HTML（`html=1` + `<br>`、`<b>`…）。
 * 所以把 `<br>` 折成空格、去掉其余标签，再解实体 —— 读起来才是人写的那句话。
 * 代价：改过标签的单元写回时 markup 回不去（如实记在 notes 里）。
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

// ---- 页体：压缩 / 解压 ------------------------------------------------------

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

/** 按 drawio 的算法压一段 mxGraphModel（`Graph.compress` 的等价物）。*/
function compressModel(modelXml) {
  return deflateRawSync(Buffer.from(encodeURIComponent(modelXml), 'utf8')).toString('base64')
}

// ---- 扫描单元（带文本跨度，供写回做定点手术）--------------------------------

/**
 * 扫描 `[from, to)` 范围内的单元，返回**带文本跨度**的记录。
 *
 * `start`/`end` 是相对整份文档的绝对偏移；每个单元内部的 `attrsSpan`/`geo`/`wrapper`
 * 是**相对该单元起点**的偏移 —— 写回时先剪出单元原文，在它上面做定点替换，
 * 就不必再关心全局偏移。
 */
function scanCells(source, from, to) {
  const cells = []
  const re = /<(object|UserObject|mxCell)\b([^>]*?)(\/>|>)/g
  re.lastIndex = from
  let match
  while ((match = re.exec(source)) !== null) {
    if (match.index >= to) break
    const kind = match[1]
    const absStart = match.index
    const outerSelfClosing = match[3] === '/>'
    const outerAttrsStart = match.index + 1 + kind.length
    const outerAttrsEnd = match.index + match[0].length - (outerSelfClosing ? 2 : 1)
    let absEnd
    const blockFrom = outerAttrsEnd + (outerSelfClosing ? 2 : 1)
    let blockTo = blockFrom
    if (outerSelfClosing) {
      absEnd = outerAttrsEnd + 2
    } else {
      const close = source.indexOf('</' + kind + '>', blockFrom)
      blockTo = close < 0 ? to : close
      absEnd = close < 0 ? to : close + kind.length + 3
    }

    // 用户对象（<object>）：id/label/自定义属性在外层，里面才是 mxCell。
    let attrsStart = outerAttrsStart
    let attrsEnd = outerAttrsEnd
    let cellSelfClosing = outerSelfClosing
    let innerFrom = blockFrom
    let innerTo = blockTo
    let wrapper = null
    let wrapperAttrs = null
    if (kind !== 'mxCell') {
      wrapperAttrs = source.slice(outerAttrsStart, outerAttrsEnd)
      const inner = /<mxCell\b([^>]*?)(\/>|>)/.exec(source.slice(blockFrom, blockTo))
      if (inner !== null) {
        const innerStart = blockFrom + inner.index
        const innerSelf = inner[2] === '/>'
        attrsStart = innerStart + '<mxCell'.length
        attrsEnd = innerStart + inner[0].length - (innerSelf ? 2 : 1)
        cellSelfClosing = innerSelf
        innerFrom = attrsEnd + (innerSelf ? 2 : 1)
        if (innerSelf) {
          innerTo = innerFrom
        } else {
          const innerClose = source.indexOf('</mxCell>', innerFrom)
          innerTo = innerClose < 0 ? blockTo : innerClose
        }
      }
      wrapper = {
        attrsStart: outerAttrsStart - absStart,
        attrsEnd: outerAttrsEnd - absStart,
      }
    }

    // 几何（在单元内容区里找）
    let geometry = null
    let geo = null
    const content = source.slice(innerFrom, innerTo)
    const geoMatch = /<mxGeometry\b([^>]*?)(\/>|>)/.exec(content)
    if (geoMatch !== null) {
      const geoAbsStart = innerFrom + geoMatch.index
      const geoSelf = geoMatch[2] === '/>'
      const geoAttrsStart = geoAbsStart + '<mxGeometry'.length
      const geoAttrsEnd = innerFrom + geoMatch.index + geoMatch[0].length - (geoSelf ? 2 : 1)
      const geoInnerFrom = geoAttrsEnd + (geoSelf ? 2 : 1)
      let geoInnerTo = geoInnerFrom
      let geoAbsEnd = geoAttrsEnd + 2
      if (!geoSelf) {
        const geoClose = source.indexOf('</mxGeometry>', geoInnerFrom)
        geoInnerTo = geoClose < 0 ? innerTo : geoClose
        geoAbsEnd = geoClose < 0 ? innerTo : geoClose + '</mxGeometry>'.length
      }
      const geoAttrsText = source.slice(geoAttrsStart, geoAttrsEnd)
      const geoInnerText = source.slice(geoInnerFrom, geoInnerTo)

      const points = []
      const arrayMatch = /<Array\b[^>]*as\s*=\s*"points"[^>]*>([\s\S]*?)<\/Array>/.exec(geoInnerText)
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
        const re2 = new RegExp('<mxPoint\\b([^>]*?)as\\s*=\\s*"' + name + '"[^>]*?/>')
        const found = re2.exec(geoInnerText)
        if (found === null) return null
        const x = num(attr(found[1], 'x'))
        const y = num(attr(found[1], 'y'))
        return x === undefined || y === undefined ? null : { x: x, y: y }
      }
      // `<mxPoint as="offset"/>`：drawio 存"标签相对于那个点的残余偏移"用的。
      // 没有 x/y 属性时按 (0,0) 处理。
      const offsetMatch = /<mxPoint\b([^>]*?)as\s*=\s*"offset"[^>]*?\/>/.exec(geoInnerText)
      const offset =
        offsetMatch === null
          ? { x: 0, y: 0 }
          : { x: num(attr(offsetMatch[1], 'x')) === undefined ? 0 : num(attr(offsetMatch[1], 'x')), y: num(attr(offsetMatch[1], 'y')) === undefined ? 0 : num(attr(offsetMatch[1], 'y')) }
      geometry = {
        x: num(attr(geoAttrsText, 'x')),
        y: num(attr(geoAttrsText, 'y')),
        width: num(attr(geoAttrsText, 'width')),
        height: num(attr(geoAttrsText, 'height')),
        relative: attr(geoAttrsText, 'relative') === '1',
        points: points,
        sourcePoint: terminal('sourcePoint'),
        targetPoint: terminal('targetPoint'),
        offset: offset,
      }
      geo = {
        attrsStart: geoAttrsStart - absStart,
        attrsEnd: geoAttrsEnd - absStart,
        selfClosing: geoSelf,
        start: geoAbsStart - absStart,
        end: geoAbsEnd - absStart,
        innerFrom: geoInnerFrom - absStart,
        innerTo: geoInnerTo - absStart,
        innerText: geoInnerText,
      }
    }

    const cellAttrsText = source.slice(attrsStart, attrsEnd)
    // `<object>`/`<UserObject>` 包装的单元：内层 mxCell **不带 id**，id 在外层。
    // 漏了这条回退的后果实测过：已有的元数据单元被当成"不存在"，于是每次保存都再追加一个，
    // 文件里躺一串重复的 drawai-meta。
    const innerId = attr(cellAttrsText, 'id')
    const cellId = innerId === undefined && wrapperAttrs !== null ? attr(wrapperAttrs, 'id') : innerId
    cells.push({
      element: kind,
      id: cellId,
      label: wrapperAttrs !== null && attr(wrapperAttrs, 'label') !== undefined ? attr(wrapperAttrs, 'label') : attr(cellAttrsText, 'value'),
      style: rawAttr(cellAttrsText, 'style') === undefined ? '' : decodeEntities(rawAttr(cellAttrsText, 'style')),
      parent: attr(cellAttrsText, 'parent'),
      source: attr(cellAttrsText, 'source'),
      target: attr(cellAttrsText, 'target'),
      vertex: attr(cellAttrsText, 'vertex') === '1',
      edge: attr(cellAttrsText, 'edge') === '1',
      // drawio 的**边标签单元**：它是个 vertex，但既不是形状也不是容器 ——
      // 样式里带 `edgeLabel`，几何是 `relative="1"`（相对它所属的连线/父级定位）。
      // 当成普通节点读进来会出两件坏事：画布上多一个鬼影框（实测：用户那份 drawio 文件里
      // 就有一个 `value="Text"` 的 edgeLabel 单元，在画布上显示成一个写着 Text 的蓝框）；
      // 一旦被拖动，写回会把**绝对坐标**写进一个"相对"几何里，把 drawio 里的标签偏移弄歪。
      // 所以这类单元一律**不导入、不拥有、原样保留**（见 ownershipOf）。
      labelCell:
        (geometry !== null && geometry.relative === true) || /(^|;)edgeLabel[;=]/.test(rawAttr(cellAttrsText, 'style') === undefined ? '' : rawAttr(cellAttrsText, 'style')),
      geometry: geometry,
      // 文本跨度
      start: absStart,
      end: absEnd,
      attrsSpan: { attrsStart: attrsStart - absStart, attrsEnd: attrsEnd - absStart, selfClosing: cellSelfClosing },
      wrapper: wrapper,
      wrapperAttrs: wrapperAttrs,
      geo: geo,
    })
    re.lastIndex = absEnd
  }
  return cells
}

// ---- 分析：定位页 1、解出 mxGraphModel、拿到全部单元与文本跨度 ----------------

/**
 * 全文分析。**解析与写回共用同一份结构** —— 两边对"哪些单元属于我们"必须完全一致，
 * 否则写回会把我们不认识的单元当成"用户删掉的"删掉。
 */
function analyzeMxfile(source) {
  const diagrams = [...source.matchAll(/<diagram\b([^>]*?)(\/>|>)([\s\S]*?)(?:<\/diagram>|$)/g)]
  if (diagrams.length === 0) throw new Error('这不是 mxfile：找不到 <diagram> 元素')
  const first = diagrams[0]
  const closed = first[0].endsWith('</diagram>')
  const bodyEnd = first.index + first[0].length - (closed ? '</diagram>'.length : 0)
  const bodyStart = bodyEnd - first[3].length
  // 页体的**核心**（去掉两侧空白）：写回时只替换这一段，
  // 否则 trim 过的 XML 会把原文里的换行/缩进一起吃掉（实测过：整份文件被压成一行）。
  const lead = /^\s*/.exec(first[3])[0]
  const trail = /\s*$/.exec(first[3])[0]
  const coreStart = bodyStart + lead.length
  const coreEnd = bodyEnd - trail.length
  const core = first[3].slice(lead.length, first[3].length - trail.length)
  const compressed = core.charAt(0) !== '<'
  const modelXml = decodeDiagramBody(core)
  const modelMatch = /<mxGraphModel\b([^>]*?)(\/>|>)/.exec(modelXml)
  if (modelMatch === null) throw new Error('这个 <diagram> 里没有 <mxGraphModel>')
  const rootStart = modelXml.indexOf('<root>')
  const rootEnd = modelXml.indexOf('</root>')
  if (rootStart < 0 || rootEnd < rootStart) throw new Error('mxGraphModel 里没有 <root>')
  const innerFrom = rootStart + '<root>'.length
  const innerTo = rootEnd
  const cells = scanCells(modelXml, innerFrom, innerTo)

  const byId = new Map()
  for (const cell of cells) if (typeof cell.id === 'string') byId.set(cell.id, cell)
  const rootCell = cells.find((c) => c.parent === undefined || c.parent === null || c.parent === '')
  const rootId = rootCell === undefined ? undefined : rootCell.id
  // 图层：挂在 root 下、既不是顶点也不是边、也没有几何的单元。
  // 元数据单元挂在图层下（parent 是图层而不是 root），所以不会被误判成图层。
  const isLayer = (cell) =>
    cell.id !== META_ID && cell.parent === rootId && cell.vertex !== true && cell.edge !== true && cell.geometry === null
  const layerIds = new Set(cells.filter(isLayer).map((c) => c.id))
  const layerOrder = cells.filter(isLayer).map((c) => c.id)

  return {
    source: source,
    pageCount: diagrams.length,
    bodyStart: coreStart,
    bodyEnd: coreEnd,
    compressed: compressed,
    modelXml: modelXml,
    rootStart: rootStart,
    rootEnd: rootEnd,
    innerFrom: innerFrom,
    innerTo: innerTo,
    cells: cells,
    byId: byId,
    rootId: rootId,
    layerIds: layerIds,
    layerOrder: layerOrder,
    isLayer: isLayer,
  }
}

/**
 * "哪些单元归我们管" —— 读与写必须用**同一套判据**。
 * 顶点：所有非 root、非图层、非边标签的顶点（含容器与图片形状）。
 * 边：两端至少各有一个真实落点或自由点（与 drawio 一致；两端都落空的边我们不认识，原样留着）。
 *
 * `labelCell`（drawio 的边标签单元）**一律不拥有** —— 不拥有才不会在"模型里没有它"时被当成
 * 用户删除而抹掉（那是真正的数据丢失），也不会把绝对坐标写进它的相对几何里。
 */
function ownershipOf(info) {
  const nodeIds = new Set()
  const owned = new Set()
  for (const cell of info.cells) {
    if (cell.vertex !== true) continue
    if (cell.id === info.rootId || info.layerIds.has(cell.id) || cell.id === META_ID) continue
    if (cell.labelCell === true) continue
    if (typeof cell.id === 'string') {
      nodeIds.add(cell.id)
      owned.add(cell.id)
    }
  }
  for (const cell of info.cells) {
    if (cell.edge !== true) continue
    const geo = cell.geometry
    const hasSource = typeof cell.source === 'string' && nodeIds.has(cell.source)
    const hasTarget = typeof cell.target === 'string' && nodeIds.has(cell.target)
    const freeSource = geo !== null && geo.sourcePoint !== null && geo.sourcePoint !== undefined
    const freeTarget = geo !== null && geo.targetPoint !== null && geo.targetPoint !== undefined
    if (!hasSource && !freeSource) continue
    if (!hasTarget && !freeTarget) continue
    if (typeof cell.id === 'string') owned.add(cell.id)
  }
  return { owned: owned, nodeIds: nodeIds }
}

/** 父链的偏移量之和（不包含自己）：容器子单元的坐标是相对父级的。**读**用这个。 */
function parentOffsetOf(info, cell) {
  let x = 0
  let y = 0
  let parentId = cell.parent
  const seen = new Set()
  while (typeof parentId === 'string' && seen.has(parentId) === false) {
    seen.add(parentId)
    const parent = info.byId.get(parentId)
    if (parent === undefined || info.layerIds.has(parent.id) || parent.id === info.rootId) break
    x += parent.geometry !== null && parent.geometry.x !== undefined ? parent.geometry.x : 0
    y += parent.geometry !== null && parent.geometry.y !== undefined ? parent.geometry.y : 0
    parentId = parent.parent
  }
  return { x: x, y: y }
}

/**
 * **写**回时，某个单元的"新父级 + 新父链偏移"。
 *
 * 与读时的 `parentOffsetOf` 有两处关键差别：
 *   1. 画布是这次保存的真相 —— 父级自己可能也被移动了，子单元的相对坐标要按**新**的
 *      父级位置反算（不然用户看到的画面和文件里存的对不上）；
 *   2. 父级可能**被删了**：那就往上接到最近一个还活着的祖先，并把被删祖先的那段偏移补回去。
 *      漏了这条，文件里会留下指向不存在单元的 `parent`（drawio 打开会丢层级）。
 *
 * 返回的 offset 是"沿父链累加的相对坐标总量"，于是写入值 = 绝对坐标 − offset。
 */
function writeChainOf(info, modelAbs, deletedIds, cell) {
  let parentId = cell.parent
  const seen = new Set()
  while (typeof parentId === 'string' && seen.has(parentId) === false) {
    seen.add(parentId)
    if (info.layerIds.has(parentId) || parentId === info.rootId) return { parentId: parentId, offset: { x: 0, y: 0 } }
    const abs = modelAbs.get(parentId)
    // 活下来的祖先：它的相对坐标已经按"绝对 − 它自己的父链"写过，所以整条链的偏移就等于它的绝对坐标。
    if (abs !== undefined) return { parentId: parentId, offset: abs }
    const parent = info.byId.get(parentId)
    if (parent === undefined) return { parentId: layerOrRoot(info), offset: { x: 0, y: 0 } }
    parentId = parent.parent
  }
  return { parentId: layerOrRoot(info), offset: { x: 0, y: 0 } }
}

function layerOrRoot(info) {
  return info.layerOrder.length > 0 ? info.layerOrder[0] : info.rootId
}

// ---- 解析 → 语义文档 -------------------------------------------------------

/**
 * 解析 mxfile 文本 → 语义文档。
 *
 * @param text `.drawio` 全文
 * @param options.existing 可选的现有文档（用来保住 meta.pinned）
 * @returns { doc, notes, pageCount } —— notes 是给人看的损失说明（多页、分组…）
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
    throw new Error('这个文件像是 UTF-16 编码（读进来时每两个字节夹着一个空字符）：请用 UTF-8 另存后再打开')
  }
  if (source.trim().length === 0) throw new Error('.drawio 文件是空的')

  const info = analyzeMxfile(source)
  const owned = ownershipOf(info)
  const nodeIds = owned.nodeIds
  const pageCount = info.pageCount

  if (info.layerIds.size > 1) {
    notes.push('这个文件有 ' + info.layerIds.size + ' 个图层，画布把它们叠在一起显示；保存时图层结构照旧保留')
  }

  const nodes = []
  let containers = 0
  let imageShapes = 0
  let markupLabels = 0
  let labelCells = 0
  for (const cell of info.cells) {
    if (cell.vertex === true && cell.labelCell === true) labelCells += 1
    if (cell.vertex !== true || owned.owned.has(String(cell.id)) === false) continue
    const isContainer = info.cells.some((c) => c.parent === cell.id && c !== cell)
    if (isContainer) containers += 1
    if (typeof cell.style === 'string' && /(^|;)image[;=]/.test(cell.style)) imageShapes += 1
    if (hasMarkup(cell.label)) markupLabels += 1
    const offset = parentOffsetOf(info, cell)
    const geo = cell.geometry
    nodes.push({
      id: String(cell.id),
      label: labelFromValue(cell.label),
      style: cell.style === undefined ? '' : String(cell.style),
      x: (geo !== null && geo.x !== undefined ? geo.x : 0) + offset.x,
      y: (geo !== null && geo.y !== undefined ? geo.y : 0) + offset.y,
      w: geo !== null && geo.width !== undefined ? geo.width : 120,
      h: geo !== null && geo.height !== undefined ? geo.height : 60,
    })
  }

  const edges = []
  let dangling = 0
  let kept = 0
  for (const cell of info.cells) {
    if (cell.edge !== true) continue
    if (owned.owned.has(String(cell.id)) === false) {
      kept += 1
      continue
    }
    const geo = cell.geometry === null ? {} : cell.geometry
    const hasSource = typeof cell.source === 'string' && nodeIds.has(cell.source)
    const hasTarget = typeof cell.target === 'string' && nodeIds.has(cell.target)
    const freeSource = geo.sourcePoint === undefined || geo.sourcePoint === null ? null : geo.sourcePoint
    const freeTarget = geo.targetPoint === undefined || geo.targetPoint === null ? null : geo.targetPoint
    if (!hasSource || !hasTarget) dangling += 1
    const edge = { id: String(cell.id), style: cell.style === undefined || cell.style === '' ? '' : String(cell.style) }
    if (hasSource) edge.from = cell.source
    if (hasTarget) edge.to = cell.target
    if (!hasSource && freeSource !== null) edge.sourcePoint = freeSource
    if (!hasTarget && freeTarget !== null) edge.targetPoint = freeTarget
    const label = labelFromValue(cell.label)
    if (label.length > 0) edge.label = label
    if (hasMarkup(cell.label)) markupLabels += 1
    const points = geo.points === undefined ? [] : geo.points
    if (points.length > 0) edge.points = points
    edges.push(edge)
  }

  if (pageCount > 1) notes.push('这个文件有 ' + pageCount + ' 页，画布只显示/编辑第 1 页（其余页保存时原样保留）')
  if (containers > 0) notes.push(containers + ' 个分组/容器：画布按绝对位置显示，文件里的父子层级照旧保留')
  if (imageShapes > 0) notes.push(imageShapes + ' 个图片/自定义形状按矩形显示（本画布不画图片，单元原样保留）')
  if (markupLabels > 0) notes.push(markupLabels + ' 个 HTML 标签按纯文本显示（改标签会写成纯文本）')
  if (dangling > 0) notes.push(dangling + ' 条边是悬空端（用 sourcePoint/targetPoint 保留）')
  if (kept > 0) notes.push(kept + ' 条边的两端都找不到落点：不显示，但原样保留在文件里')

  // drawio 的**独立边标签单元**：按它自己的几何画出来（只读 —— 画布不改它们，保存原样带回）。
  // 位置语义与 `mxGraphView.getPoint` 一致：挂在边上的（parent 是那条边）用
  // x = 沿边比例（0 中点、±1 两端）、y = 垂直偏移、offset = 残余偏移；
  // 没挂在边上的（例如从别处粘过来、parent 是图层）就按它的绝对坐标显示。
  const labels = []
  for (const cell of info.cells) {
    if (cell.vertex !== true || cell.labelCell !== true) continue
    const parentCell = typeof cell.parent === 'string' ? info.byId.get(cell.parent) : undefined
    const onEdge = parentCell !== undefined && parentCell.edge === true
    const geo = cell.geometry === null ? {} : cell.geometry
    const offset = geo.offset === undefined || geo.offset === null ? { x: 0, y: 0 } : geo.offset
    labels.push({
      id: String(cell.id),
      text: labelFromValue(cell.label),
      edgeId: onEdge ? String(cell.parent) : null,
      x: geo.x === undefined ? 0 : geo.x,
      y: geo.y === undefined ? 0 : geo.y,
      offsetX: offset.x,
      offsetY: offset.y,
      relative: geo.relative === true,
      style: cell.style === undefined ? '' : String(cell.style),
    })
  }
  if (labels.length > 0) {
    const onEdges = labels.filter((l) => l.edgeId !== null).length
    notes.push(
      labels.length + ' 个边标签单元（drawio 的 edgeLabel）按原样显示（只读，保存时原样保留）' +
        (onEdges < labels.length ? '：其中 ' + (labels.length - onEdges) + ' 个没挂在任何边上，按它自己的坐标显示' : ''),
    )
  }

  const existing = options !== undefined && options.existing !== undefined && options.existing !== null ? options.existing : null
  const metaCell = info.byId.get(META_ID)
  const metaAttrs =
    metaCell === undefined
      ? undefined
      : metaCell.wrapperAttrs !== null
        ? metaCell.wrapperAttrs
        : info.modelXml.slice(metaCell.start + metaCell.attrsSpan.attrsStart, metaCell.start + metaCell.attrsSpan.attrsEnd)
  const pinned = metaCell !== undefined && attr(metaAttrs, 'drawaiPinned') === '1'
  const doc = {
    version: 2,
    revision: contentHash(source),
    meta: { pinned: pinned === true },
    nodes: nodes,
    edges: edges,
    labels: labels,
  }
  if (existing !== null && existing.meta !== undefined && existing.meta !== null && existing.meta.pinned === true) {
    doc.meta.pinned = true
  }
  return { doc: doc, notes: notes, pageCount: pageCount }
}

// ---- 单元的 XML 生成（新单元、以及从零生成一份文件时共用）--------------------

function nodeCellXml(node, parentId, indent) {
  const style = typeof node.style === 'string' && node.style.length > 0 ? ' style="' + escapeAttr(node.style) + '"' : ''
  const label = typeof node.label === 'string' && node.label.length > 0 ? ' value="' + escapeAttr(node.label) + '"' : ''
  const x = Number.isFinite(Number(node.x)) ? Number(node.x) : 0
  const y = Number.isFinite(Number(node.y)) ? Number(node.y) : 0
  const w = Number.isFinite(Number(node.w)) ? Number(node.w) : 120
  const h = Number.isFinite(Number(node.h)) ? Number(node.h) : 60
  return [
    indent + '<mxCell id="' + escapeAttr(String(node.id)) + '"' + label + style + ' vertex="1" parent="' + escapeAttr(parentId) + '">',
    indent + '  <mxGeometry x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" as="geometry" />',
    indent + '</mxCell>',
  ].join('\n')
}

/** 边的几何内部（自由端点 + 折点）。缩进按 indent 缩进一级。 */
function edgeInnerXml(edge, indent) {
  const points = Array.isArray(edge.points) ? edge.points : []
  const sourcePoint = edge.sourcePoint !== undefined && edge.sourcePoint !== null ? edge.sourcePoint : null
  const targetPoint = edge.targetPoint !== undefined && edge.targetPoint !== null ? edge.targetPoint : null
  if (points.length === 0 && sourcePoint === null && targetPoint === null) return ''
  const lines = []
  const inner = indent + '  '
  if (sourcePoint !== null) lines.push(inner + '<mxPoint x="' + Number(sourcePoint.x) + '" y="' + Number(sourcePoint.y) + '" as="sourcePoint" />')
  if (targetPoint !== null) lines.push(inner + '<mxPoint x="' + Number(targetPoint.x) + '" y="' + Number(targetPoint.y) + '" as="targetPoint" />')
  if (points.length > 0) {
    lines.push(inner + '<Array as="points">')
    for (const point of points) lines.push(inner + '  <mxPoint x="' + Number(point.x) + '" y="' + Number(point.y) + '" />')
    lines.push(inner + '</Array>')
  }
  return '\n' + lines.join('\n') + '\n' + indent
}

function edgeCellXml(edge, parentId, indent) {
  const style = typeof edge.style === 'string' && edge.style.length > 0 ? ' style="' + escapeAttr(edge.style) + '"' : ''
  const label = typeof edge.label === 'string' && edge.label.length > 0 ? ' value="' + escapeAttr(edge.label) + '"' : ''
  const from = typeof edge.from === 'string' ? ' source="' + escapeAttr(edge.from) + '"' : ''
  const to = typeof edge.to === 'string' ? ' target="' + escapeAttr(edge.to) + '"' : ''
  const inner = edgeInnerXml(edge, indent)
  const head = indent + '<mxCell id="' + escapeAttr(String(edge.id)) + '"' + label + style + ' edge="1" parent="' + escapeAttr(parentId) + '"' + from + to + '>'
  if (inner.length === 0) {
    return [head, indent + '  <mxGeometry relative="1" as="geometry" />', indent + '</mxCell>'].join('\n')
  }
  return [head, indent + '  <mxGeometry relative="1" as="geometry">' + inner + '</mxGeometry>', indent + '</mxCell>'].join('\n')
}

/** 元数据单元：没有 vertex/edge，所以不会显示，也不会被我们当成图形单元。 */
function metaCellXml(parentId, indent, meta) {
  const pinned = meta !== undefined && meta !== null && meta.pinned === true ? '1' : '0'
  return [
    indent + '<object label="" drawaiMeta="1" drawaiPinned="' + pinned + '" id="' + META_ID + '">',
    indent + '  <mxCell parent="' + escapeAttr(parentId) + '" />',
    indent + '</object>',
  ].join('\n')
}

// ---- 写回：在原文件上做定点手术 ---------------------------------------------

function spliceEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  for (const edit of sorted) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

function pointsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (Number(a[i].x) !== Number(b[i].x) || Number(a[i].y) !== Number(b[i].y)) return false
  }
  return true
}

function samePoint(a, b) {
  const aNull = a === undefined || a === null
  const bNull = b === undefined || b === null
  if (aNull && bNull) return true
  if (aNull !== bNull) return false
  return Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y)
}

/**
 * style 是否等价 —— 写回时"没变就别动"的判据。
 *
 * 不能逐字比：文档层会把 style 规范化（键序、结尾分号），于是一个**没被碰过**的单元
 * 也会因为"串长得不一样"被重写，逐字节不变的性质当场破掉（实测踩过）。
 * 也不能只做语义比较：文件里没写 style 的连线 = drawio 的默认连线样式，
 * 文档里显式写着默认值同样算没变。
 */
function stylesEqual(fileStyle, docStyle, isEdge) {
  const a = typeof fileStyle === 'string' ? fileStyle : ''
  const b = typeof docStyle === 'string' ? docStyle : ''
  if (a === b) return true
  const na = formatStyle(a)
  const nb = formatStyle(b)
  if (na === nb) return true
  if (isEdge === true && na === '' && nb === formatStyle(DEFAULT_EDGE_STYLE)) return true
  return false
}

/** 给一个还没有几何的单元补上几何（自闭合的单元要展开成开闭标签对）。 */
function appendGeometry(text, cell, geometryXml) {
  const attrsEnd = cell.attrsSpan.attrsEnd
  if (cell.attrsSpan.selfClosing) {
    // <mxCell … /> → <mxCell …>geometry</mxCell>
    return text.slice(0, attrsEnd) + '>' + geometryXml + '</mxCell>' + text.slice(attrsEnd + 2)
  }
  return text.slice(0, attrsEnd + 1) + geometryXml + text.slice(attrsEnd + 1)
}

/**
 * 重新定位单个单元的文本跨度。属性改写会让长度变化，需要**重新定位**再动结构
 * （补几何 / 换几何内部）—— 拿旧偏移去做插入必然写错地方。
 */
function rescanCell(text) {
  const cells = scanCells(text, 0, text.length)
  return cells.length > 0 ? cells[0] : null
}

/** 改写一个顶点单元：标签、style、几何（几何要写回**相对父级**的坐标）。 */
function rebuildNodeCell(info, cell, node, chain) {
  // 单元跨度是**相对页体（mxGraphModel）**的，不是相对整份文件 —— 切错参照系会把
  // 页面开头的几十个字符当成这个单元的原文（实测：改一个坐标把 mxGraphModel 标签搬进了单元里）。
  const original = info.modelXml.slice(cell.start, cell.end)
  const changes = []
  const label = typeof node.label === 'string' ? node.label : ''
  if (label !== labelFromValue(cell.label)) {
    const span = cell.wrapper !== null ? cell.wrapper : cell.attrsSpan
    changes.push({
      attrsStart: span.attrsStart,
      attrsEnd: span.attrsEnd,
      pairs: { [cell.wrapper !== null ? 'label' : 'value']: escapeAttr(label) },
    })
  }
  const style = typeof node.style === 'string' ? node.style : ''
  if (stylesEqual(cell.style, style, false) === false) {
    changes.push({ attrsStart: cell.attrsSpan.attrsStart, attrsEnd: cell.attrsSpan.attrsEnd, pairs: { style: style.length > 0 ? escapeAttr(style) : null } })
  }

  const offset = chain.offset
  const x = (Number.isFinite(Number(node.x)) ? Number(node.x) : 0) - offset.x
  const y = (Number.isFinite(Number(node.y)) ? Number(node.y) : 0) - offset.y
  const w = Number.isFinite(Number(node.w)) ? Number(node.w) : 120
  const h = Number.isFinite(Number(node.h)) ? Number(node.h) : 60
  // 父级换了（原来的容器被删了）也要写回，否则文件里留下悬空 parent。
  if (typeof chain.parentId === 'string' && chain.parentId !== cell.parent) {
    changes.push({ attrsStart: cell.attrsSpan.attrsStart, attrsEnd: cell.attrsSpan.attrsEnd, pairs: { parent: escapeAttr(chain.parentId) } })
  }
  const geo = cell.geometry
  const unchanged = geo !== null && geo.x === x && geo.y === y && geo.width === w && geo.height === h
  if (unchanged) return withAttrChanges(original, changes)

  if (cell.geo !== null && cell.geo.selfClosing) {
    // 只有属性、没有子元素：连 x/y/width/height 一起在一次批量改写里做（同一区域！）
    const pairs = { x: String(x), y: String(y), width: String(w), height: String(h) }
    if (attrIn(original, cell.geo.attrsStart, cell.geo.attrsEnd, 'as') === undefined) pairs.as = 'geometry'
    changes.push({ attrsStart: cell.geo.attrsStart, attrsEnd: cell.geo.attrsEnd, pairs: pairs })
    return withAttrChanges(original, changes)
  }
  if (cell.geo !== null) {
    // 几何带子元素（例如 `<mxRectangle as="alternateBounds">`）：只改属性，子元素原样留着。
    const pairs = { x: String(x), y: String(y), width: String(w), height: String(h) }
    if (attrIn(original, cell.geo.attrsStart, cell.geo.attrsEnd, 'as') === undefined) pairs.as = 'geometry'
    changes.push({ attrsStart: cell.geo.attrsStart, attrsEnd: cell.geo.attrsEnd, pairs: pairs })
    return withAttrChanges(original, changes)
  }
  // 本来没有几何：先做属性改写，**重新定位**后再补几何。
  const withAttrs = withAttrChanges(original, changes)
  const fresh = rescanCell(withAttrs)
  const geometry = '<mxGeometry x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" as="geometry" />'
  return fresh === null ? withAttrs : appendGeometry(withAttrs, fresh, geometry)
}

/** 改写一条边：标签、style、端点、折点/自由点（几何内部只在**语义**变了时才重建）。 */
function rebuildEdgeCell(info, cell, edge, chain) {
  const original = info.modelXml.slice(cell.start, cell.end)
  const changes = []
  const label = typeof edge.label === 'string' ? edge.label : ''
  if (label !== labelFromValue(cell.label)) {
    const span = cell.wrapper !== null ? cell.wrapper : cell.attrsSpan
    changes.push({
      attrsStart: span.attrsStart,
      attrsEnd: span.attrsEnd,
      pairs: { [cell.wrapper !== null ? 'label' : 'value']: escapeAttr(label) },
    })
  }
  const style = typeof edge.style === 'string' ? edge.style : ''
  if (stylesEqual(cell.style, style, true) === false) {
    changes.push({ attrsStart: cell.attrsSpan.attrsStart, attrsEnd: cell.attrsSpan.attrsEnd, pairs: { style: style.length > 0 ? escapeAttr(style) : null } })
  }
  // 端点：只在真的换了落点时才动属性（同一区域，必须并进同一次批量改写）
  const from = typeof edge.from === 'string' ? edge.from : undefined
  const to = typeof edge.to === 'string' ? edge.to : undefined
  const endpointPairs = {}
  if (cell.source !== from) endpointPairs.source = from === undefined ? null : escapeAttr(from)
  if (cell.target !== to) endpointPairs.target = to === undefined ? null : escapeAttr(to)
  if (Object.keys(endpointPairs).length > 0) {
    changes.push({ attrsStart: cell.attrsSpan.attrsStart, attrsEnd: cell.attrsSpan.attrsEnd, pairs: endpointPairs })
  }

  // 几何内部：折点与自由端点。语义相同就一个字节都不动（保住幂等与最小 diff）。
  const geo = cell.geometry
  const parsedPoints = geo !== null && Array.isArray(geo.points) ? geo.points : []
  const modelPoints = Array.isArray(edge.points) ? edge.points : []
  const parsedSource = geo === null ? null : geo.sourcePoint
  const parsedTarget = geo === null ? null : geo.targetPoint
  const modelSource = from === undefined && edge.sourcePoint !== undefined && edge.sourcePoint !== null ? edge.sourcePoint : null
  const modelTarget = to === undefined && edge.targetPoint !== undefined && edge.targetPoint !== null ? edge.targetPoint : null
  const innerUnchanged = pointsEqual(parsedPoints, modelPoints) && samePoint(parsedSource, modelSource) && samePoint(parsedTarget, modelTarget)
  const text = withAttrChanges(original, changes)
  if (innerUnchanged) return text

  const fresh = rescanCell(text)
  if (fresh === null) return text
  const inner = edgeInnerXml({ points: modelPoints, sourcePoint: modelSource, targetPoint: modelTarget }, '')
  const geometry = inner.length === 0 ? '<mxGeometry relative="1" as="geometry" />' : '<mxGeometry relative="1" as="geometry">' + inner + '</mxGeometry>'
  if (fresh.geo === null) return appendGeometry(text, fresh, geometry)
  if (fresh.geo.selfClosing) return text.slice(0, fresh.geo.start) + geometry + text.slice(fresh.geo.end)
  return text.slice(0, fresh.geo.innerFrom) + inner + text.slice(fresh.geo.innerTo)
}

/**
 * 算出"要把原文件改成什么样"的**编辑计划**（不改文本）。
 *
 * 抽出来是为了两件事：自测能直接断言"没改动时编辑数为 0"（无损的第一条不变量），
 * 以及出问题时能看见每条编辑落在哪儿 —— 偏移错了写出来的文件会当场花掉。
 *
 * @returns { info, edits, dropped }
 */
function planDocEdits(originalText, doc) {
  const source = String(originalText === undefined || originalText === null ? '' : originalText)
  const info = analyzeMxfile(source)
  const owned = ownershipOf(info).owned
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  const edges = Array.isArray(doc.edges) ? doc.edges : []
  const nodeIds = new Set(nodes.map((n) => String(n.id)))
  const wanted = new Map()
  for (const node of nodes) if (node !== null && typeof node === 'object') wanted.set(String(node.id), { kind: 'node', item: node })
  for (const edge of edges) if (edge !== null && typeof edge === 'object') wanted.set(String(edge.id), { kind: 'edge', item: edge })

  /** 一条边的落点：doc 里的顶点才算真实落点，否则用自由点；两者都没有就丢掉它。 */
  const anchorsOf = (edge) => {
    const from = typeof edge.from === 'string' && nodeIds.has(edge.from) ? edge.from : undefined
    const to = typeof edge.to === 'string' && nodeIds.has(edge.to) ? edge.to : undefined
    const sourcePoint = edge.sourcePoint !== undefined && edge.sourcePoint !== null ? edge.sourcePoint : undefined
    const targetPoint = edge.targetPoint !== undefined && edge.targetPoint !== null ? edge.targetPoint : undefined
    if (from === undefined && sourcePoint === undefined) return null
    if (to === undefined && targetPoint === undefined) return null
    return Object.assign({}, edge, { from: from, to: to, sourcePoint: sourcePoint, targetPoint: targetPoint })
  }

  const dropped = []
  const edits = []
  // 画布上的绝对坐标：写回时容器子单元的相对坐标要按它反算。
  const modelAbs = new Map()
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    modelAbs.set(String(node.id), { x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0, y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0 })
  }
  // 被删掉的单元（我们导入过、模型里没有了）。它们若是别人的父级，下面是"孤儿"，要接走。
  const deletedIds = new Set()
  for (const cell of info.cells) {
    const id = String(cell.id)
    if (owned.has(id) && wanted.get(id) === undefined) deletedIds.add(id)
  }
  for (const cell of info.cells) {
    const id = String(cell.id)
    const want = wanted.get(id)
    if (want === undefined) {
      // 我们导入过、而模型里没有了 → 用户真的删了它。
      // 我们**没**导入过的（不认识的边）不是删除，原样留着。
      if (owned.has(id)) edits.push({ start: cell.start, end: cell.end, text: '' })
      continue
    }
    const chain = writeChainOf(info, modelAbs, deletedIds, cell)
    if (want.kind === 'edge') {
      const anchors = anchorsOf(want.item)
      if (anchors === null) {
        dropped.push(id)
        edits.push({ start: cell.start, end: cell.end, text: '' })
        continue
      }
      const rebuilt = rebuildEdgeCell(info, cell, anchors, chain)
      if (rebuilt !== info.modelXml.slice(cell.start, cell.end)) edits.push({ start: cell.start, end: cell.end, text: rebuilt })
      continue
    }
    const rebuilt = rebuildNodeCell(info, cell, want.item, chain)
    if (rebuilt !== info.modelXml.slice(cell.start, cell.end)) edits.push({ start: cell.start, end: cell.end, text: rebuilt })
  }

  // 我们不认识的单元如果挂在被删的容器下，也要接走 —— 否则文件里留下悬空 parent。
  // （我们不"拥有"它，所以只改 parent，不碰它的其他属性。）
  if (deletedIds.size > 0) {
    for (const cell of info.cells) {
      const id = String(cell.id)
      if (deletedIds.has(id) || wanted.get(id) !== undefined) continue
      if (typeof cell.parent !== 'string' || deletedIds.has(cell.parent) === false) continue
      const chain = writeChainOf(info, modelAbs, deletedIds, cell)
      const original = info.modelXml.slice(cell.start, cell.end)
      const rebuilt = setAttrsIn(original, cell.attrsSpan.attrsStart, cell.attrsSpan.attrsEnd, { parent: escapeAttr(chain.parentId) })
      if (rebuilt !== original) edits.push({ start: cell.start, end: cell.end, text: rebuilt })
    }
  }

  // 新单元：插到最后一个单元之后（parent 用第一个图层）
  //
  // 缩进与插入点都**跟着这个文件走**，不硬编码：硬编码会留下多余空白，
  // 于是"只追加了一个单元"变成"顺带改了别处的字节"，逐字节不变的性质就没了。
  const layerId = info.layerOrder.length > 0 ? info.layerOrder[0] : info.rootId
  const rootLineStart = info.modelXml.lastIndexOf('\n', info.innerTo)
  const rootIndent = rootLineStart < 0 ? '' : info.modelXml.slice(rootLineStart + 1, info.innerTo)
  const childIndent = rootIndent + '  '
  const additions = []
  for (const node of nodes) {
    if (node === null || typeof node !== 'object' || info.byId.has(String(node.id))) continue
    additions.push(nodeCellXml(node, layerId, childIndent))
  }
  for (const edge of edges) {
    if (edge === null || typeof edge !== 'object' || info.byId.has(String(edge.id))) continue
    const anchors = anchorsOf(edge)
    if (anchors === null) {
      dropped.push(String(edge.id))
      continue
    }
    additions.push(edgeCellXml(anchors, layerId, childIndent))
  }

  // 元数据单元（pin 状态）：有就更新，需要而没有就新建，不需要就删掉
  const metaCell = info.byId.get(META_ID)
  const wantPinned = doc.meta !== undefined && doc.meta !== null && doc.meta.pinned === true
  if (metaCell !== undefined) {
    if (wantPinned === false) {
      edits.push({ start: metaCell.start, end: metaCell.end, text: '' })
    } else {
      const original = info.modelXml.slice(metaCell.start, metaCell.end)
      const span = metaCell.wrapper !== null ? metaCell.wrapper : metaCell.attrsSpan
      const rebuilt = attrIn(original, span.attrsStart, span.attrsEnd, 'drawaiPinned') === '1'
        ? original
        : setAttrIn(original, span.attrsStart, span.attrsEnd, 'drawaiPinned', '1')
      if (rebuilt !== original) edits.push({ start: metaCell.start, end: metaCell.end, text: rebuilt })
    }
  } else if (wantPinned === true) {
    additions.push(metaCellXml(layerId, childIndent, doc.meta))
  }
  if (additions.length > 0) {
    const insertAt = rootLineStart < 0 ? info.innerTo : rootLineStart
    edits.push({ start: insertAt, end: insertAt, text: '\n' + additions.join('\n') })
  }

  return { info: info, edits: edits, dropped: dropped }
}

/**
 * 把语义文档写回一份**已有的** mxfile 文本。
 *
 * 只改我们拥有的单元（见文件头），其余原文逐字节保留；原本压缩的页体写回后仍压缩。
 *
 * @returns { text, dropped } —— dropped 是被略过的边 id（两端都没有落点），调用方应如实上报
 */
export function applyDocToMxfile(originalText, doc, options) {
  const source = String(originalText === undefined || originalText === null ? '' : originalText)
  const plan = planDocEdits(source, doc)
  const model = spliceEdits(plan.info.modelXml, plan.edits)
  const bodyText = plan.info.compressed ? compressModel(model) : model
  return {
    text: source.slice(0, plan.info.bodyStart) + bodyText + source.slice(plan.info.bodyEnd),
    dropped: plan.dropped,
  }
}

// ---- 自测钩子 ---------------------------------------------------------------

/**
 * 仅供自测：暴露全文分析（页 / 图层 / 归属 / 每个单元的文本跨度）。
 *
 * 写回是"按偏移做定点手术"，偏移错了就会写出花掉的文件 —— 所以要能直接把跨度
 * 拿出来断言，而不是靠"看起来对"。归属判据也一并暴露：读与写必须用同一套。
 */
export function __analyze(text) {
  const info = analyzeMxfile(String(text === undefined || text === null ? '' : text))
  const ownership = ownershipOf(info)
  return {
    pageCount: info.pageCount,
    compressed: info.compressed,
    bodyStart: info.bodyStart,
    bodyEnd: info.bodyEnd,
    rootId: info.rootId,
    layerOrder: info.layerOrder,
    innerFrom: info.innerFrom,
    innerTo: info.innerTo,
    owned: [...ownership.owned],
    nodeIds: [...ownership.nodeIds],
    cells: info.cells.map((cell) => ({
      id: cell.id,
      element: cell.element,
      start: cell.start,
      end: cell.end,
      parent: cell.parent,
      vertex: cell.vertex,
      edge: cell.edge,
      attrsSpan: cell.attrsSpan,
      wrapper: cell.wrapper,
      geo:
        cell.geo === null
          ? null
          : {
              attrsStart: cell.geo.attrsStart,
              attrsEnd: cell.geo.attrsEnd,
              selfClosing: cell.geo.selfClosing,
              start: cell.geo.start,
              end: cell.geo.end,
              innerFrom: cell.geo.innerFrom,
              innerTo: cell.geo.innerTo,
            },
    })),
  }
}

/**
 * 仅供自测：暴露**编辑计划**（每条编辑的范围与预览）。
 * "打开后原样保存 ⇒ 编辑数为 0" 是写回无损的第一条不变量，必须能直接断言。
 */
export function __plan(text, doc) {
  const plan = planDocEdits(text, doc)
  return {
    dropped: plan.dropped,
    info: { bodyStart: plan.info.bodyStart, bodyEnd: plan.info.bodyEnd, innerTo: plan.info.innerTo, compressed: plan.info.compressed },
    edits: plan.edits.map((edit) => ({
      start: edit.start,
      end: edit.end,
      insert: edit.start === edit.end,
      old: plan.info.modelXml.slice(edit.start, Math.min(edit.end, edit.start + 40)),
      text: edit.text.slice(0, 60),
    })),
  }
}

// ---- 从零生成一份 mxfile（新建 / 另存为用）----------------------------------
/**
 * 文档 → 全新的 mxfile。默认**不压缩**（人可读、diff 友好；drawio 两种都认）。
 *
 * 注意：这是"从零生成"，只写模型里的东西 —— 所以只用于新建文件；
 * 覆盖已有文件一律走 `applyDocToMxfile`（无损写回）。
 *
 * @returns { text, dropped }
 */
export function buildMxfile(doc, options) {
  const compressed = options !== undefined && options.compressed === true
  const pageName = options !== undefined && typeof options.name === 'string' && options.name.length > 0 ? options.name : 'Page-1'
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  const edges = Array.isArray(doc.edges) ? doc.edges : []
  const nodeIds = new Set(nodes.map((n) => String(n.id)))
  const dropped = []
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
  if (doc.meta !== undefined && doc.meta !== null && doc.meta.pinned === true) lines.push(metaCellXml('1', '        ', doc.meta))
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    lines.push(nodeCellXml(node, '1', '        '))
  }
  for (const edge of edges) {
    if (edge === null || typeof edge !== 'object') continue
    const from = typeof edge.from === 'string' && nodeIds.has(edge.from) ? edge.from : undefined
    const to = typeof edge.to === 'string' && nodeIds.has(edge.to) ? edge.to : undefined
    const sourcePoint = edge.sourcePoint !== undefined && edge.sourcePoint !== null ? edge.sourcePoint : undefined
    const targetPoint = edge.targetPoint !== undefined && edge.targetPoint !== null ? edge.targetPoint : undefined
    if (from === undefined && sourcePoint === undefined) {
      dropped.push(String(edge.id))
      continue
    }
    if (to === undefined && targetPoint === undefined) {
      dropped.push(String(edge.id))
      continue
    }
    lines.push(edgeCellXml(Object.assign({}, edge, { from: from, to: to, sourcePoint: sourcePoint, targetPoint: targetPoint }), '1', '        '))
  }
  lines.push('      </root>')
  lines.push('    </mxGraphModel>')
  const model = lines.slice(2).join('\n')
  const head = lines.slice(0, 2).join('\n')
  const tail = ['  </diagram>', '</mxfile>', ''].join('\n')
  if (!compressed) return { text: head + '\n' + model + '\n' + tail, dropped: dropped }
  return {
    text:
      '<mxfile host="dsh-drawai" agent="dsh-drawai" type="device">\n  <diagram id="dsh-drawai-page-1" name="' +
      escapeAttr(pageName) +
      '">\n    ' +
      compressModel(model) +
      '\n  </diagram>\n</mxfile>\n',
    dropped: dropped,
  }
}
