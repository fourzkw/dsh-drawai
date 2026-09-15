/**
 * dsh-drawai —— 宿主半边（Host half）· 源文件
 *
 * 这是**源文件**，不要改 lib/index.js —— 那个由 tools/build.mjs 生成。
 *
 * 不需要语法转换：本文件是可直接运行的 ESM。构建器只加一行生成标记，
 * 所以宿主半边改完只要 `npm run build` + 重启 dsh web 就生效
 * （客户端半边有热重载，宿主半边没有 —— 宿主只在启动时加载一次）。
 *
 * 导出形式与 DSH 全部参考包一致：{ name, inject, apply }。
 * 注册的工具：
 *   - diagram_read  读回画布文档（节点/边/形状/配色）
 *   - diagram_apply 施加结构化编辑 → 分层自动布局 → 原子写回
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath, join as joinPath } from 'node:path'
import { applyDocToMxfile, buildMxfile, contentHash, parseMxfile } from './mxfile.js'
import {
  ARROW_KINDS,
  DASH_KINDS,
  DEFAULT_EDGE_STYLE,
  DEFAULT_NODE_STYLE,
  DEFAULT_STROKE,
  NODE_SHAPES,
  NODE_SHAPE_STYLE,
  PALETTE,
  SIDES,
  arrowFromStyle,
  avoidFromStyle,
  colorNameFromStyle,
  colorsFromStyle,
  dashFromStyle,
  edgeStyleValueFromStyle,
  formatStyle,
  jettyFromStyle,
  nodeShapeFromStyle,
  normalizeDrawioDoc,
  normalizePoints,
  parseStyle,
  sideFromStyle,
  styleWithArrow,
  styleWithAvoid,
  styleWithColorName,
  styleWithDash,
  styleWithJetty,
  styleWithNodeShape,
  styleWithSide,
  stylePatch,
  styleGet,
} from './style-kernel.js'

/**
 * 列目录走 Node 标准库。
 *
 * 为什么不用 ctx.fs：实测这个 DSH 版本的 ctx.fs **既没有 list 也没有 readRelated**
 * （诊断原话："ctx.fs 没有 list 方法 / ctx.fs 没有 readRelated 方法"）——
 * 我先后猜过这两个 API，都错了。插件本来就跑在宿主进程里，stdlib 一定可用。
 *
 * 沙箱围栏不受影响：**写盘**仍然全部走 ctx.fs.writeText（带策略），
 * 这里只做"列目录"这一件读操作。
 */
const nodeReaddir = readdir

/** 把可能相对的路径归一成绝对路径（宿主工作目录兜底）。 */
function toAbsolute(p, cwd) {
  const s = String(p === undefined || p === null ? '' : p)
  if (isAbsolute(s)) return s
  return joinPath(cwd === undefined || cwd === null || cwd.length === 0 ? process.cwd() : cwd, s)
}

const DEFAULT_PATH = 'demo.drawio'
const DEFAULT_W = 170
/** 缺省高度取**整格**（10px 的倍数）：否则节点中心会落在半像素上，连线容易出现"差一像素"的台阶。 */
const DEFAULT_H = 60
const GAP_PRIMARY = 90
const GAP_CROSS = 40
const LAYOUTS = ['dagre-lr', 'dagre-tb', 'grid', 'none']

/**
 * 工具语言 vs 文档语言 —— 这是本次改造最容易被误读的一条界线。
 *
 * **文档里存的是 drawio 的 style 键**（`dashed=1`、`dashPattern=8 8`、`edgeStyle=orthogonalEdgeStyle`、
 * `jettySize=auto`、`libavoidRouting=1`、`exitX/exitY/entryX/entryY`、`endArrow/startArrow`、
 * `fillColor/strokeColor`、`shape=`/`rounded=`/`arcSize=`…），默认值一律省略，
 * 认不出的键原样保留（开放集合）。这一切由 ../src/style-kernel.js 负责，宿主与客户端共用。
 *
 * **下面这几个枚举只是工具语言**（给模型用的糖）：AI 说"改成虚线""双向箭头""黄色"
 * 不该被迫拼 style 串。它们**绝不落盘**——由本文件翻译成上面的键。
 * drawio 自己也是这个分工：面板上给的是名字，文档里只有 fillColor/strokeColor。
 *
 * 旧的立场（"存语义、渲染参数属于客户端"）已按需求废弃：现在渲染参数就是文档的一部分，
 * 换主题/调间距会改文档 —— 与 drawio 一致。
 */
const DASHES = DASH_KINDS
const ARROWS = ARROW_KINDS

/** 容忍模型的口语说法：只为降低"op 被拒"的概率，落盘前一律归一成上面那几个枚举值。 */
function normalizeDash(value) {
  const v = String(value).toLowerCase().trim()
  if (v === 'solid' || v === 'line' || v === 'normal' || v === '实线') return 'solid'
  if (v === 'dashed' || v === 'dash' || v === '虚线') return 'dashed'
  if (v === 'dotted' || v === 'dot' || v === '点线' || v === '点状') return 'dotted'
  return null
}

function normalizeArrow(value) {
  const v = String(value).toLowerCase().trim()
  if (v === 'end' || v === 'forward' || v === 'target' || v === '单向') return 'end'
  if (v === 'both' || v === 'bidirectional' || v === '双向' || v === 'double') return 'both'
  if (v === 'none' || v === 'false' || v === '无') return 'none'
  if (v === 'start' || v === 'backward' || v === 'source' || v === '反向') return 'start'
  return null
}

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** 单字符显示宽度：CJK / 全角按一倍字宽，其余按 0.55 倍（近似 Helvetica）。 */
function charWidth(ch, size) {
  const code = ch.codePointAt(0)
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  return wide ? size : size * 0.55
}

/**
 * 按标签估算节点宽度并夹在 [130, 300]，避免模型手算尺寸。
 *
 * 结果**向上取整到整格（10px）**：与画布的移动/缩放单位一致。宽度不是整格时，
 * 节点中心会落在半像素上，连线就会多出"差一像素"的台阶。
 */
function estimateWidth(label) {
  const chars = Array.from(String(label))
  let w = 34
  for (let i = 0; i < chars.length; i += 1) w += charWidth(chars[i], 12)
  if (w < 130) return 130
  if (w > 300) return 300
  return Math.ceil(w / 10) * 10
}

/** 读一个"绝对点"参数（addEdge 的自由端点）。缺省 null；给了但形状不对直接报错。 */
function edgePointFromOp(value, where) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(where + ' must be {x, y}')
  const x = Number(value.x)
  const y = Number(value.y)
  if (Number.isFinite(x) === false || Number.isFinite(y) === false) throw new Error(where + ' needs finite x and y')
  return { x: x, y: y }
}

/** 扫描 `<prefix><n>` 形式的 id，返回 max+1 —— 多轮迭代不会打乱已有编号。 */
function nextId(list, prefix) {
  let max = 0
  const re = new RegExp('^' + prefix + '(\\d+)$')
  for (let i = 0; i < list.length; i += 1) {
    const m = re.exec(String(list[i].id))
    if (m !== null) {
      const n = parseInt(m[1], 10)
      if (n > max) max = n
    }
  }
  return prefix + (max + 1)
}

function emptyDoc() {
  // revision 是**文件内容指纹**（载体即真相，没有第二个地方存版本号）：
  // 空文档的指纹就是空串，第一次落盘后由写入器算出来。
  return { version: 2, revision: '', meta: { layout: 'dagre-tb' }, nodes: [], edges: [] }
}

/**
 * 读入归一化。
 *
 * 文档层只认 v2（drawio style 键）；归一化逻辑在 style-kernel 的 `normalizeDrawioDoc`，
 * 两侧半边共用同一份，所以"盘上写什么、两边读到什么"不会分叉。
 */
function normalizeDoc(raw) {
  const doc = normalizeDrawioDoc(raw)
  return {
    version: doc.version,
    revision: doc.revision,
    meta: doc.meta,
    nodes: doc.nodes,
    edges: doc.edges,
    labels: doc.labels,
    // 图层必须跟着走：丢掉它 = 保存时把单元挂回缺省层（用户的层就没了），
    // 而且 AI 读不到"哪一层是隐藏的"。
    layers: doc.layers,
  }
}

/** 节点位置快照，用于判断一次布局到底动没动端点。 */
function nodePositions(doc) {
  const map = Object.create(null)
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    map[n.id] = { x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, 0), h: numberOr(n.h, 0) }
  }
  return map
}

/**
 * 重新布局会让"人摆过的折点"变成过期坐标。
 *
 * 这是 v1 的一个真实缺口：宿主半边当时**完全不知道 `points` 存在**（零读写），
 * 于是 AI 一重排，盘上就留下一堆飘在旧位置上的折点，而没有任何清理或标记。
 * v2 起折点归宿主管：布局真的动了某条边的端点，就清掉它的折点与悬空端自由点 ——
 * 与 drawio 的自动路由在几何变化后重算路径同理。
 *
 * @returns 被清理的边数
 */
function invalidateStalePoints(doc, before) {
  const now = nodePositions(doc)
  let dropped = 0
  for (let i = 0; i < doc.edges.length; i += 1) {
    const edge = doc.edges[i]
    if (edge.points === undefined && edge.sourcePoint === undefined && edge.targetPoint === undefined) continue
    const moved = function (id) {
      const prev = before[id]
      const cur = now[id]
      if (prev === undefined || cur === undefined) return prev !== cur
      return prev.x !== cur.x || prev.y !== cur.y || prev.w !== cur.w || prev.h !== cur.h
    }
    if (!moved(edge.from) && !moved(edge.to)) continue
    delete edge.points
    delete edge.sourcePoint
    delete edge.targetPoint
    dropped += 1
  }
  return dropped
}

/** 调色板名清单（错误文案用）。 */
function paletteNames() {
  const names = []
  for (let i = 0; i < PALETTE.length; i += 1) names.push(PALETTE[i].name)
  return names
}

/** 工具语言的 `keys`：值给 null 表示**删键**（回到 drawio 缺省）。 */
function styleKeysFromOp(keys, where) {
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error(where + ': "keys" must be an object like { fillColor: "#fff2cc", dashed: null }')
  }
  return keys
}

/**
 * 节点/边的 `style` 这个糖：既收调色板名（'yellow'），也收**一段 drawio style 串**
 * （`fillColor=#fff2cc;strokeColor=#d6b656`）。判据是"有没有 '=' 或 ';'"，
 * 两者都不像就报错 —— 绝不把垃圾写进文档。
 */
function styleValueFromOp(style, value, where) {
  if (value.indexOf('=') >= 0 || value.indexOf(';') >= 0) {
    return formatStyle(Object.assign(parseStyle(style), parseStyle(value)))
  }
  const named = styleWithColorName(style, value)
  if (named === style && colorNameFromStyle(style) !== value) {
    throw new Error(
      where + ': unknown style "' + value + '"; use a palette name (' + paletteNames().join(', ') +
        ') or a drawio style string like "fillColor=#fff2cc;strokeColor=#d6b656"',
    )
  }
  return named
}

/** 边上的 `style` 糖：调色板名 → `strokeColor`（drawio 里连线的颜色就是 strokeColor）。 */
function edgeStyleValueFromOp(style, value, where) {
  if (value.indexOf('=') >= 0 || value.indexOf(';') >= 0) {
    return formatStyle(Object.assign(parseStyle(style), parseStyle(value)))
  }
  for (let i = 0; i < PALETTE.length; i += 1) {
    if (PALETTE[i].name !== value) continue
    return stylePatch(style, { strokeColor: value === 'plain' ? null : PALETTE[i].stroke })
  }
  throw new Error(
    where + ': unknown style "' + value + '"; use a palette name (' + paletteNames().join(', ') +
      ') or a drawio style string like "dashed=1;dashPattern=8 8"',
  )
}

/** 进出侧：'n'/'e'/'s'/'w'（也容忍 north/east/… 与中文），空值 = 清掉约束。 */
function normalizeSide(value, where) {
  if (value === null || value === undefined || value === '') return null
  const v = String(value).toLowerCase().trim()
  if (v === 'n' || v === 'north' || v === 'top' || v === '上') return 'n'
  if (v === 'e' || v === 'east' || v === 'right' || v === '右') return 'e'
  if (v === 's' || v === 'south' || v === 'bottom' || v === '下') return 's'
  if (v === 'w' || v === 'west' || v === 'left' || v === '左') return 'w'
  throw new Error(where + ': unknown side "' + value + '"; use ' + SIDES.join(', '))
}

/**
 * 节点样式：`shape` / `style` / `keys` 三种糖统一落成 drawio style 键。
 * rect 落成**空串** —— drawio 的 `defaultVertexStyle = {}`，普通矩形就是"没有 shape 键"。
 */
function nodeStyleFromOp(style, op, where) {
  let out = style === undefined || style === null ? DEFAULT_NODE_STYLE : String(style)
  if (typeof op.shape === 'string') {
    if (!Object.prototype.hasOwnProperty.call(NODE_SHAPE_STYLE, op.shape)) {
      throw new Error(where + ': unknown shape "' + op.shape + '"; use ' + NODE_SHAPES.join(', '))
    }
    out = styleWithNodeShape(out, op.shape)
  }
  if (typeof op.style === 'string' && op.style.length > 0) out = styleValueFromOp(out, op.style, where)
  if (has(op, 'keys')) out = stylePatch(out, styleKeysFromOp(op.keys, where))
  return out
}

/**
 * 边的画法糖：线型 / 箭头 / 颜色 / 进出侧 / 桩点长度 / 路由方式 / 避让，
 * 全部翻成 drawio 的 style 键（`dashed`、`dashPattern`、`endArrow`、`strokeColor`、
 * `exitX/exitY/entryX/entryY`、`jettySize`、`edgeStyle`、`libavoidRouting`）。
 */
function edgeStyleFromOp(style, op, where) {
  let out = style === undefined || style === null ? DEFAULT_EDGE_STYLE : String(style)
  if (typeof op.dash === 'string') {
    const dash = normalizeDash(op.dash)
    if (dash === null) throw new Error(where + ': unknown dash "' + op.dash + '"; use ' + DASHES.join(', '))
    out = styleWithDash(out, dash)
  }
  if (typeof op.arrow === 'string') {
    const arrow = normalizeArrow(op.arrow)
    if (arrow === null) throw new Error(where + ': unknown arrow "' + op.arrow + '"; use ' + ARROWS.join(', '))
    out = styleWithArrow(out, arrow)
  }
  if (typeof op.color === 'string') out = stylePatch(out, { strokeColor: op.color.length === 0 ? null : op.color })
  if (has(op, 'exit')) out = styleWithSide(out, 'source', normalizeSide(op.exit, where + ' exit'))
  if (has(op, 'entry')) out = styleWithSide(out, 'target', normalizeSide(op.entry, where + ' entry'))
  if (has(op, 'jettySize')) out = styleWithJetty(out, op.jettySize === null ? null : String(op.jettySize))
  if (typeof op.edgeStyle === 'string') out = stylePatch(out, { edgeStyle: op.edgeStyle })
  if (has(op, 'avoid')) out = styleWithAvoid(out, op.avoid === true)
  if (typeof op.style === 'string' && op.style.length > 0) out = edgeStyleValueFromOp(out, op.style, where)
  if (has(op, 'keys')) out = stylePatch(out, styleKeysFromOp(op.keys, where))
  return out
}

/** 一行摘要：把 style 串翻成人话，给 notes / render 用（只报与缺省不同的部分）。 */
function styleNote(style) {
  const bits = []
  const dash = dashFromStyle(style)
  if (dash !== 'solid') bits.push(dash)
  const arrow = arrowFromStyle(style)
  if (arrow === 'both') bits.push('both arrows')
  else if (arrow === 'none') bits.push('no arrow')
  else if (arrow === 'start') bits.push('reverse arrow')
  const name = colorNameFromStyle(style)
  if (name !== null && name !== 'plain') bits.push(name)
  const exit = sideFromStyle(style, 'source')
  const entry = sideFromStyle(style, 'target')
  if (exit !== null || entry !== null) bits.push((exit === null ? '?' : exit) + '->' + (entry === null ? '?' : entry))
  const jetty = jettyFromStyle(style)
  if (jetty !== null) bits.push('jetty ' + jetty)
  if (edgeStyleValueFromStyle(style) === 'none') bits.push('straight')
  if (avoidFromStyle(style)) bits.push('avoid')
  return bits.length === 0 ? '' : ' [' + bits.join(', ') + ']'
}

/**
 * 施加 ops。语义校验在这里：任何指向不存在节点的边、任何未知 id，都直接抛错并列出已知节点，
 * 于是失败发生在写盘之前 —— 不会画出半张烂图。
 */
function applyOps(doc, ops, out) {
  const notes = []
  function findNode(id) {
    for (let i = 0; i < doc.nodes.length; i += 1) if (doc.nodes[i].id === id) return i
    return -1
  }
  function findEdge(id) {
    for (let i = 0; i < doc.edges.length; i += 1) if (doc.edges[i].id === id) return i
    return -1
  }
  function known() {
    const ids = []
    for (let i = 0; i < doc.nodes.length; i += 1) ids.push(doc.nodes[i].id)
    return ids.length === 0 ? '(none)' : ids.join(', ')
  }

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new Error('ops[' + i + '] must be an object like { op: "addNode", label: "..." }')
    }
    const kind = op.op

    if (kind === 'addNode') {
      const label = typeof op.label === 'string' && op.label.length > 0 ? op.label : undefined
      if (label === undefined) throw new Error('ops[' + i + '] addNode needs a non-empty string "label"')
      let id = typeof op.id === 'string' && op.id.length > 0 ? op.id : undefined
      if (id !== undefined && findNode(id) >= 0) {
        throw new Error('ops[' + i + '] addNode: node "' + id + '" already exists. Use setLabel to change it, or omit "id" to auto-allocate one.')
      }
      if (id === undefined) id = nextId(doc.nodes, 'n')
      const node = {
        id: id,
        label: label,
        // 形状/配色是糖，落盘只有 style 键；不给就是 drawio 缺省（空串 = 普通矩形 + 缺省配色）。
        style: nodeStyleFromOp(DEFAULT_NODE_STYLE, op, 'ops[' + i + '] addNode'),
        w: numberOr(op.w, estimateWidth(label)),
        h: numberOr(op.h, DEFAULT_H),
      }
      // 关键：只有显式给了坐标才写入。缺省写 (0,0) 会让 placeMissing 以为"坐标齐全"而不补位，
      // 新节点就会堆在原点压住别人。
      if (has(op, 'x')) node.x = numberOr(op.x, 0)
      if (has(op, 'y')) node.y = numberOr(op.y, 0)
      doc.nodes.push(node)
      notes.push('+ node ' + id + ' "' + label + '"' + (has(op, 'x') || has(op, 'y') ? ' at explicit coords' : ' (position pending)'))
      continue
    }

    if (kind === 'addEdge') {
      const from = typeof op.from === 'string' ? op.from : undefined
      const to = typeof op.to === 'string' ? op.to : undefined
      // **独立线**：drawio 允许一条边的两端都是自由点（几何里的 sourcePoint/targetPoint），
      // 于是"先画一条线、再决定接哪儿"是合法形态 —— 线可以完全独立于节点存在。
      // 糖名用 fromPoint/toPoint（跟 from/to 对齐），模型名 sourcePoint/targetPoint 也认。
      const fromPoint = edgePointFromOp(op.fromPoint !== undefined ? op.fromPoint : op.sourcePoint, 'ops[' + i + '] addEdge fromPoint')
      const toPoint = edgePointFromOp(op.toPoint !== undefined ? op.toPoint : op.targetPoint, 'ops[' + i + '] addEdge toPoint')
      if (from === undefined && fromPoint === null) throw new Error('ops[' + i + '] addEdge needs "from" (node id) or "fromPoint" (absolute point)')
      if (to === undefined && toPoint === null) throw new Error('ops[' + i + '] addEdge needs "to" (node id) or "toPoint" (absolute point)')
      if (from !== undefined && findNode(from) < 0) throw new Error('ops[' + i + '] addEdge: unknown "from" node "' + from + '". Known nodes: ' + known())
      if (to !== undefined && findNode(to) < 0) throw new Error('ops[' + i + '] addEdge: unknown "to" node "' + to + '". Known nodes: ' + known())
      let id = typeof op.id === 'string' && op.id.length > 0 ? op.id : undefined
      if (id !== undefined && findEdge(id) >= 0) throw new Error('ops[' + i + '] addEdge: edge "' + id + '" already exists')
      if (id === undefined) id = nextId(doc.edges, 'e')
      const edge = { id: id }
      if (from !== undefined) edge.from = from
      if (to !== undefined) edge.to = to
      // 自由点只在那一端**没有真实顶点**时生效（drawio 语义，与内核的 edgeFreePoint 一致）。
      if (from === undefined && fromPoint !== null) edge.sourcePoint = fromPoint
      if (to === undefined && toPoint !== null) edge.targetPoint = toPoint
      if (typeof op.label === 'string' && op.label.length > 0) edge.label = op.label
      // 建边时就能带上画法：AI 想表达"这是一条异步/可选依赖"时，
      // 不该被迫先 addEdge 再补一次 setStyle（两次写盘、两次往返）。
      edge.style = edgeStyleFromOp(DEFAULT_EDGE_STYLE, op, 'ops[' + i + '] addEdge')
      doc.edges.push(edge)
      const head = from !== undefined ? from : '(free ' + fromPoint.x + ',' + fromPoint.y + ')'
      const tail = to !== undefined ? to : '(free ' + toPoint.x + ',' + toPoint.y + ')'
      notes.push('+ edge ' + id + ' ' + head + ' -> ' + tail + styleNote(edge.style))
      continue
    }

    if (kind === 'move') {
      const id = typeof op.id === 'string' ? op.id : undefined
      if (id === undefined) throw new Error('ops[' + i + '] move needs string "id"')
      const hasX = Number.isFinite(Number(op.x))
      const hasY = Number.isFinite(Number(op.y))
      const dx = Number.isFinite(Number(op.dx)) ? Number(op.dx) : 0
      const dy = Number.isFinite(Number(op.dy)) ? Number(op.dy) : 0
      if (hasX === false && hasY === false && dx === 0 && dy === 0) {
        throw new Error('ops[' + i + '] move needs "x"/"y" (absolute) or a non-zero "dx"/"dy"')
      }
      // 节点：绝对坐标（给 x/y）或相对位移（给 dx/dy）都行。
      // 以前只能"删掉重画"来改位置 —— 那会丢 id、丢边上的端点约束与折点，是实打实的损失。
      const ni = findNode(id)
      if (ni >= 0) {
        const n = doc.nodes[ni]
        n.x = Math.round(hasX ? Number(op.x) : numberOr(n.x, 0) + dx)
        n.y = Math.round(hasY ? Number(op.y) : numberOr(n.y, 0) + dy)
        notes.push('~ node ' + id + ' @' + n.x + ',' + n.y)
        continue
      }
      // 连线：整体平移它**自己的**几何（折点 + 悬空端的自由点），
      // 与画布上"拖整组"完全同一套语义（端点接在节点上时由节点决定，不受影响）。
      const ei = findEdge(id)
      if (ei < 0) throw new Error('ops[' + i + '] move: unknown node or edge "' + id + '". Known nodes: ' + known())
      if (hasX || hasY) throw new Error('ops[' + i + '] move: an edge can only be moved by "dx"/"dy" (its geometry is relative)')
      const edge = doc.edges[ei]
      let touched = 0
      if (Array.isArray(edge.points)) {
        edge.points = edge.points.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }))
        touched += 1
      }
      if (edge.sourcePoint !== undefined && edge.sourcePoint !== null) {
        edge.sourcePoint = { x: Math.round(edge.sourcePoint.x + dx), y: Math.round(edge.sourcePoint.y + dy) }
        touched += 1
      }
      if (edge.targetPoint !== undefined && edge.targetPoint !== null) {
        edge.targetPoint = { x: Math.round(edge.targetPoint.x + dx), y: Math.round(edge.targetPoint.y + dy) }
        touched += 1
      }
      notes.push('~ edge ' + id + ' moved by ' + dx + ',' + dy + (touched === 0 ? '（它两端都接在节点上、也没有折点，等于没有可平移的几何）' : ''))
      continue
    }

    if (kind === 'highlight') {
      // **只提示、不改文档**：把几个 id 记成"下次客户端来取时选中它们"，
      // 于是 AI 能说"你看这几个节点"而不用让用户自己找。
      const ids = Array.isArray(op.ids) ? op.ids.filter((v) => typeof v === 'string' && v.length > 0) : []
      if (ids.length === 0) throw new Error('ops[' + i + '] highlight needs non-empty string array "ids"')
      if (out !== undefined && out !== null) out.highlight = ids.slice()
      notes.push('👁 已请求高亮 ' + ids.length + ' 项（客户端下次刷新时会选中它们）')
      continue
    }

    if (kind === 'setLabel') {
      const id = typeof op.id === 'string' ? op.id : undefined
      const label = typeof op.label === 'string' ? op.label : undefined
      if (id === undefined || label === undefined) throw new Error('ops[' + i + '] setLabel needs string "id" and "label"')
      const ni = findNode(id)
      if (ni >= 0) {
        doc.nodes[ni].label = label
        notes.push('~ node ' + id + ' label = "' + label + '"')
        continue
      }
      const ei = findEdge(id)
      if (ei >= 0) {
        doc.edges[ei].label = label
        notes.push('~ edge ' + id + ' label = "' + label + '"')
        continue
      }
      throw new Error('ops[' + i + '] setLabel: unknown id "' + id + '". Known nodes: ' + known())
    }

    if (kind === 'setStyle') {
      const id = typeof op.id === 'string' ? op.id : undefined
      if (id === undefined) throw new Error('ops[' + i + '] setStyle needs string "id"')
      const ni = findNode(id)
      if (ni < 0) {
        // 连线也归 setStyle 管 —— 节点的"画法"是 shape/style，连线的"画法"是线型/箭头/颜色。
        // 分成两个 op 只是多一条要记的规则，对模型和人都没有好处。
        const ei = findEdge(id)
        if (ei < 0) throw new Error('ops[' + i + '] setStyle: unknown node or edge "' + id + '". Known nodes: ' + known())
        const edge = doc.edges[ei]
        const where = 'ops[' + i + '] setStyle'
        // 键级合并：只改点到的键，其余（含认不出的键）原样留着 —— 开放集合的代价与好处都在这。
        const base = edge.style === undefined ? DEFAULT_EDGE_STYLE : edge.style
        const next = edgeStyleFromOp(base, op, where)
        if (next !== base) edge.style = next
        // 显式清折点/悬空端的自由点（右键"自动路由"与 AI 都能用同一件事）。
        if (op.clearPoints === true) {
          delete edge.points
          delete edge.sourcePoint
          delete edge.targetPoint
        }
        notes.push('~ edge ' + id + ' style' + styleNote(edge.style === undefined ? base : edge.style))
        continue
      }
      const node = doc.nodes[ni]
      const nodeBase = node.style === undefined ? DEFAULT_NODE_STYLE : node.style
      const nextStyle = nodeStyleFromOp(nodeBase, op, 'ops[' + i + '] setStyle')
      if (nextStyle !== nodeBase) node.style = nextStyle
      if (has(op, 'w')) node.w = numberOr(op.w, node.w)
      if (has(op, 'h')) node.h = numberOr(op.h, node.h)
      notes.push('~ node ' + id + ' [' + nodeShapeFromStyle(nextStyle) + ']' + (nextStyle.length === 0 ? ' (默认样式)' : ''))
      continue
    }

    if (kind === 'remove') {
      const id = typeof op.id === 'string' ? op.id : undefined
      if (id === undefined) throw new Error('ops[' + i + '] remove needs string "id"')
      const ni = findNode(id)
      if (ni >= 0) {
        doc.nodes.splice(ni, 1)
        const kept = []
        let dropped = 0
        for (let k = 0; k < doc.edges.length; k += 1) {
          const e = doc.edges[k]
          if (e.from === id || e.to === id) dropped += 1
          else kept.push(e)
        }
        doc.edges = kept
        notes.push('- node ' + id + (dropped > 0 ? ' (and ' + dropped + ' edge(s))' : ''))
        continue
      }
      const ei = findEdge(id)
      if (ei >= 0) {
        doc.edges.splice(ei, 1)
        notes.push('- edge ' + id)
        continue
      }
      throw new Error('ops[' + i + '] remove: unknown id "' + id + '". Known nodes: ' + known())
    }

    throw new Error('ops[' + i + '] unknown op ' + JSON.stringify(kind) + '. Supported: addNode, addEdge, setLabel, setStyle, remove')
  }
  return notes
}

/** 分层自动布局：DFS 去回边 → 最长路径分层 → 重心排序减交叉 → 逐层居中定位
 *  （树/森林再补一遍"父节点居中于孩子"，见末尾那一段）。 */
function autoLayout(doc, mode) {
  const nodes = doc.nodes
  if (nodes.length === 0) return

  if (mode === 'grid') {
    const cols = Math.max(1, Math.round(Math.sqrt(nodes.length)))
    const rows = Math.ceil(nodes.length / cols)
    const colW = []
    for (let c = 0; c < cols; c += 1) colW.push(0)
    const rowH = []
    for (let r = 0; r < rows; r += 1) rowH.push(0)
    for (let i = 0; i < nodes.length; i += 1) {
      const c = i % cols
      const r = Math.floor(i / cols)
      const w = numberOr(nodes[i].w, DEFAULT_W)
      const h = numberOr(nodes[i].h, DEFAULT_H)
      if (w > colW[c]) colW[c] = w
      if (h > rowH[r]) rowH[r] = h
    }
    const colX = []
    let px = 0
    for (let c = 0; c < cols; c += 1) {
      colX.push(px)
      px += colW[c] + GAP_CROSS
    }
    const rowY = []
    let py = 0
    for (let r = 0; r < rows; r += 1) {
      rowY.push(py)
      py += rowH[r] + GAP_CROSS
    }
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].x = colX[i % cols]
      nodes[i].y = rowY[Math.floor(i / cols)]
    }
    return
  }

  const index = {}
  for (let i = 0; i < nodes.length; i += 1) index[nodes[i].id] = i

  const outgoing = {}
  for (let i = 0; i < doc.edges.length; i += 1) {
    const e = doc.edges[i]
    if (index[e.from] === undefined || index[e.to] === undefined) continue
    if (e.from === e.to) continue
    const key = typeof e.id === 'string' ? e.id : '#' + i
    if (outgoing[e.from] === undefined) outgoing[e.from] = []
    outgoing[e.from].push({ to: e.to, key: key })
  }

  // 去掉回边，保证分层在含环图上收敛（否则层号会一轮轮涨到爆）。
  const color = {}
  const isBack = {}
  function visit(id) {
    color[id] = 1
    const list = outgoing[id] === undefined ? [] : outgoing[id]
    for (let i = 0; i < list.length; i += 1) {
      const target = list[i].to
      if (color[target] === 1) {
        isBack[list[i].key] = true
        continue
      }
      if (color[target] === undefined) visit(target)
    }
    color[id] = 2
  }
  for (let i = 0; i < nodes.length; i += 1) if (color[nodes[i].id] === undefined) visit(nodes[i].id)

  const usedEdges = []
  for (let i = 0; i < doc.edges.length; i += 1) {
    const e = doc.edges[i]
    if (index[e.from] === undefined || index[e.to] === undefined) continue
    if (e.from === e.to) continue
    const key = typeof e.id === 'string' ? e.id : '#' + i
    if (isBack[key] === true) continue
    usedEdges.push(e)
  }

  const layer = {}
  for (let i = 0; i < nodes.length; i += 1) layer[nodes[i].id] = 0
  for (let iter = 0; iter < nodes.length; iter += 1) {
    let changed = false
    for (let i = 0; i < usedEdges.length; i += 1) {
      const e = usedEdges[i]
      if (layer[e.to] < layer[e.from] + 1) {
        layer[e.to] = layer[e.from] + 1
        changed = true
      }
    }
    if (!changed) break
  }

  let top = 0
  for (let i = 0; i < nodes.length; i += 1) if (layer[nodes[i].id] > top) top = layer[nodes[i].id]
  const buckets = []
  for (let L = 0; L <= top; L += 1) buckets.push([])
  for (let i = 0; i < nodes.length; i += 1) buckets[layer[nodes[i].id]].push(nodes[i])

  const pos = {}
  for (let L = 0; L <= top; L += 1) for (let i = 0; i < buckets[L].length; i += 1) pos[buckets[L][i].id] = i
  const preds = {}
  for (let i = 0; i < usedEdges.length; i += 1) {
    const e = usedEdges[i]
    if (preds[e.to] === undefined) preds[e.to] = []
    preds[e.to].push(e.from)
  }
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let L = 1; L <= top; L += 1) {
      const row = buckets[L]
      if (row.length < 2) continue
      const score = {}
      for (let i = 0; i < row.length; i += 1) {
        const id = row[i].id
        const list = preds[id]
        let sum = 0
        let count = 0
        if (list !== undefined) {
          for (let k = 0; k < list.length; k += 1) {
            const p = pos[list[k]]
            if (p !== undefined) {
              sum += p
              count += 1
            }
          }
        }
        score[id] = count > 0 ? sum / count : pos[id]
      }
      row.sort(function (a, b) {
        const d = score[a.id] - score[b.id]
        if (d !== 0) return d
        return pos[a.id] - pos[b.id]
      })
      for (let i = 0; i < row.length; i += 1) pos[row[i].id] = i
    }
  }

  const horizontal = mode !== 'dagre-tb'
  const thick = []
  const cross = []
  for (let L = 0; L <= top; L += 1) {
    let t = 0
    let c = 0
    for (let i = 0; i < buckets[L].length; i += 1) {
      const n = buckets[L][i]
      const w = numberOr(n.w, DEFAULT_W)
      const h = numberOr(n.h, DEFAULT_H)
      const primary = horizontal ? w : h
      const secondary = horizontal ? h : w
      if (primary > t) t = primary
      c += secondary + (i > 0 ? GAP_CROSS : 0)
    }
    thick.push(t)
    cross.push(c)
  }
  let maxCross = 0
  for (let L = 0; L <= top; L += 1) if (cross[L] > maxCross) maxCross = cross[L]

  let along = 0
  for (let L = 0; L <= top; L += 1) {
    let offset = (maxCross - cross[L]) / 2
    for (let i = 0; i < buckets[L].length; i += 1) {
      const n = buckets[L][i]
      const w = numberOr(n.w, DEFAULT_W)
      const h = numberOr(n.h, DEFAULT_H)
      if (horizontal) {
        n.x = Math.round(along)
        n.y = Math.round(offset)
      } else {
        n.y = Math.round(along)
        n.x = Math.round(offset)
      }
      offset += (horizontal ? h : w) + GAP_CROSS
    }
    along += thick[L] + GAP_PRIMARY
  }

  // ── 树/森林：改用"父节点居中于孩子"的摆法 ────────────────────────────────────
  //
  // 上面的逐层居中是"整层一起居中"，于是**父节点会正好压在某个孩子头上**：
  // 实测一棵完整的二叉树（A；B/C；D/E/F/G）排出来是
  //     A(180)  B(130)  C(230)  D(30) E(130) F(230) G(330)
  // —— B 落在 E 的正上方、D 甩在左边；而教科书（也是人的直觉）是父节点在两个孩子**中间**。
  //
  // 这一个 pass 只对**每个节点至多一个父**的图生效：二叉树、组织架构图、决策树都是这种。
  // 多父的 DAG（依赖图那种）保持原样 —— 那里"居中于父"本来就没有唯一答案。
  //
  // 两步，都只动**交叉轴**（tb 是 x、lr 是 y）：
  //   1. 自下而上：有孩子的节点摆到"最左孩子中心 … 最右孩子中心"的中点；
  //   2. 每一层从左往右：谁离左邻居太近就往右让（只让本节点，不搬子树）
  //      —— 对称的树（绝大多数）根本不会触发，只有真挤在一起时才牺牲一点居中换不重叠。
  const parentOf = {}
  const childrenOf = {}
  let forest = true
  for (let i = 0; i < usedEdges.length; i += 1) {
    const e = usedEdges[i]
    if (parentOf[e.to] !== undefined && parentOf[e.to] !== e.from) {
      forest = false
      break
    }
    parentOf[e.to] = e.from
    if (childrenOf[e.from] === undefined) childrenOf[e.from] = []
    childrenOf[e.from].push(e.to)
  }
  if (forest) {
    const byId = {}
    for (let i = 0; i < nodes.length; i += 1) byId[nodes[i].id] = nodes[i]
    const sizeOf = (n) => (horizontal ? numberOr(n.h, DEFAULT_H) : numberOr(n.w, DEFAULT_W))
    const crossOf = (n) => (horizontal ? n.y : n.x)
    const setCross = (n, value) => {
      if (horizontal) n.y = Math.round(value)
      else n.x = Math.round(value)
    }
    for (let L = top - 1; L >= 0; L -= 1) {
      const row = buckets[L]
      for (let i = 0; i < row.length; i += 1) {
        const kids = childrenOf[row[i].id]
        if (kids === undefined || kids.length === 0) continue
        let lo = Infinity
        let hi = -Infinity
        for (let k = 0; k < kids.length; k += 1) {
          const kid = byId[kids[k]]
          if (kid === undefined) continue
          const c = crossOf(kid)
          if (c < lo) lo = c
          if (c > hi) hi = c
        }
        if (lo <= hi) setCross(row[i], (lo + hi) / 2)
      }
      for (let i = 1; i < row.length; i += 1) {
        const prev = row[i - 1]
        const cur = row[i]
        const minGap = sizeOf(prev) / 2 + GAP_CROSS + sizeOf(cur) / 2
        const gap = crossOf(cur) - crossOf(prev)
        if (gap < minGap) setCross(cur, crossOf(prev) + minGap)
      }
    }
  }
}

/** `layout:'none'` 时的补位：只补缺失的那一轴，不覆盖已给的坐标。 */
function placeMissing(doc) {
  let maxY = 0
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    if (Number.isFinite(Number(n.y))) {
      const bottom = Number(n.y) + numberOr(n.h, DEFAULT_H)
      if (bottom > maxY) maxY = bottom
    }
  }
  let slot = 0
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    const hasX = Number.isFinite(Number(n.x))
    const hasY = Number.isFinite(Number(n.y))
    if (hasX && hasY) continue
    if (!hasX) n.x = slot * (DEFAULT_W + GAP_CROSS)
    if (!hasY) n.y = maxY + 80
    slot += 1
  }
}

/** 画布写回端点：人工编辑唯一的落盘通道。 */
export const SAVE_PATH = '/drawai/api/save'
/** 「打开」菜单最多下钻几个子目录 —— 不做全盘递归，避免撞上 node_modules 这类大目录。 */
const MAX_SCAN_DIRS = 12
/** 自定义请求头 —— 跨站表单设不了它，跨域 fetch 会被预检拦住（CSRF 围栏）。 */
export const SAVE_HEADER = 'x-drawai-save'
/** 请求体上限，防止一次误发把内存打满。 */
const SAVE_MAX_BYTES = 4 * 1024 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body exceeds ' + limitBytes + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export const name = 'drawai'
export const inject = ['tools', 'fs', 'sessions', 'sandboxPolicy', 'webServer']

/**
 * 插件**自带**的使用说明，以"内嵌技能"注册给 DSH 的 skill 注册表
 * （`ctx.skills.register()`，见 apply() 末尾）。
 *
 * 为什么要有它：工具名/描述/schema 本来就随 `lib/index.js` 一起装到任何机器上，模型一定看得到；
 * 但 README、源码、tools/ 都不会跟着插件走（`package.json.files` 只有 lib 与 cordis.patch.yml）。
 * 换了电脑、只装了插件时，模型能依仗的就只剩那段工具描述。技能是 DSH 为此准备的**正规通道**：
 * 它出现在会话的技能目录里，模型需要时按需取全文 —— 于是"怎么在这张画布上操作"这件事
 * 跟着插件走，而不是跟着这份仓库走。
 *
 * 写成模板串但**不用反引号**（markdown 里要写示例，反引号会破坏模板串）：代码块用四空格缩进。
 */
const SKILL_BODY = `# DrawAI 画布：怎么读、怎么改

## 一句话
工作区里任何一个 .drawio 文件**就是**一张 DrawAI 画布 —— 它是 drawio 自己的 mxfile 格式。
用户在 DSH 右栏画布面板里看到的、以及用 drawio 桌面版打开的，是同一份文件；
没有"导入/导出"这一步，你直接读写这个文件就是读写那张画布。

## 两个工具怎么配合
1. **diagram_read(path?)** —— 先读。返回节点（id/label/shape/style/**x·y·w·h 坐标尺寸**）、
   边（id/from/to/label/style/dash/arrow/折点/悬空端的自由点）、revision（**文件内容指纹**，不是版本号）、
   layers（**图层表**：顺序 = 叠放顺序，含 name/visible/locked）、每个单元的 layer（它在哪一层）、
   notes（画布表示不了但会原样保留的东西：多页、分组、图片、HTML 标签）、
   highlight（AI 自己请求的高亮，见下）、canRevert（有没有可退回的 AI 改动）。
   visible:false 的层在画布上不画，但里面的单元**照旧读得到** —— 隐藏是显示状态，不是删除；
   想让人看见就提醒用户去「图层」菜单打开。
2. **diagram_apply(path, ops, layout?)** —— 再改。给一组结构化编辑，宿主**无损写回**：只改我们拥有的单元，
   文件其余部分（别的页、未知单元、自定义属性）逐字节保留。打开后原样保存 = 文件一个字节都不变。

不传 path 时，优先改**用户当前打开的那张画布**（客户端上报的聚焦路径），最后才退回 demo.drawio。
用户说"这张图"时通常不用传 path。改完可以再 read 一次自查。

**当前是哪一张，有两个来源**：用户在画布面板里切换标签页时，宿主会把"当前画布 = <路径>"
**注入到会话里**（你会看到一条 plugin 来源的上下文）；不放心时也不带 path 调一次
diagram_read —— 返回里的 path 就是它（这两条是一致的，同一个记录）。

revision 是乐观锁：写回时若文件已被别处改过（比如用户同时在 drawio 里编辑），会返回 409 —— 重读一次再改。

## ops 速查
    {op:"addNode", label:"必填", shape?, style?, keys?, w?, h?, x?, y?}
    {op:"addEdge", from?, to?, fromPoint?, toPoint?, label?, style?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, avoid?, keys?}
    {op:"setLabel", id, label}
    {op:"setStyle", id, shape?, style?, keys?, w?, h?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, avoid?, clearPoints?}
    {op:"move", id, dx?, dy?, x?, y?}
    {op:"remove", id}
    {op:"highlight", ids:["n1","n2"]}

- id 省略会自动分配（n1/n2…、e1/e2…）；addEdge 的 from/to 必须是**已存在的节点 id**，
  引用了不存在的节点会**在写盘之前**直接报错并列出已知 id。
- **线的两端可以给绝对点**（fromPoint/toPoint）而不是节点：两端都给点就是一条**独立线** ——
  drawio 里边的两端都可以是自由点，线可以完全不接节点（先画线、之后再拖端点接到节点上也行）。
  只有一端给点就是**悬空端**（另一半接在节点上）。
- **move**：改已有元素的位置。节点给 dx/dy（相对）或 x/y（绝对）；连线只能给 dx/dy
  （平移它自己的折点与自由端点；两端接在节点上时端点由节点决定）。
  以前没有 move，想把某个节点挪一下就只好删掉重画 —— 那会丢 id、丢边上的端点约束与折点。
- **highlight** 只是"让画布选中这几个"给你看，不改文档、也不重排。
- **没有图层相关的 op**（v1）：你能**看到** layers 与每个单元的 layer，但还不能加层、
  把单元挪到别的层、按层导出。用户在「图层」菜单里做这些。
  注意：你 addNode 出来的新单元落在**第一个图层**（"当前层"是画布里的客户端状态，宿主看不到）——
  用户想让它进别的层，得自己在画布上挪（v3 才会有按层操作的 op）。
- 糖（shape/style/dash/arrow/color/exit/entry/jettySize/edgeStyle/avoid）由宿主翻译成 drawio 的 style 键，
  **绝不落盘**；keys 用来写任意 drawio 键，值给 null = 删键回默认。
- shape：rect | rounded | stadium | ellipse | diamond | parallelogram | cylinder | document | hexagon
- style：调色板名 plain|blue|green|orange|yellow|red|purple|grey，或直接给一段 style 串
- dash：solid|dashed|dotted；arrow：end（单向）|both（双向）|none（无）|start（反向）
- exit/entry：进出侧 n|e|s|w；edgeStyle：orthogonalEdgeStyle|none（none = 直线）
- 自环写成 from === to（与 drawio 一致）；自动布局忽略自环，只摆节点。

## 一段完整的例子
用户说"画一个登录流程，失败回到登录页"：

    diagram_apply({ ops: [
      {op:"addNode", label:"开始",   shape:"stadium", style:"green"},
      {op:"addNode", label:"输入账号", shape:"rect",  style:"blue"},
      {op:"addNode", label:"校验",   shape:"diamond", style:"yellow"},
      {op:"addNode", label:"进入首页", shape:"rect",  style:"blue"},
      {op:"addEdge", from:"n1", to:"n2"},
      {op:"addEdge", from:"n2", to:"n3"},
      {op:"addEdge", from:"n3", to:"n4", label:"通过"},
      {op:"addEdge", from:"n3", to:"n2", label:"失败", dash:"dashed", color:"red"}
    ], layout:"dagre-tb" })

## 布局与坐标
- **不要自己算坐标**：layout 选 dagre-tb（默认，贴合右栏窄高的形状）、dagre-lr（左到右）、
  grid（网格）、none（保留现有坐标，只给没有坐标的新节点补位）。
- 只有"必须摆在某个位置"时才传 x/y（宿主仍会把它吸附到网格）。
- 画布的吸附单位：**节点 10px，连线的折点/自由端点 5px**。手工摆过的画布带 meta.pinned，
  这时**不加 layout 就不会重排**（否则你一改图，人手工排好的版面就被冲掉）；想重排必须显式给 layout。
- **ops 里自带几何时（addNode 给了 x/y、或者有 move）也不会重排** ——
  否则"把 n1 往右挪 40"会被布局立刻冲掉，看起来像工具坏了。
- 显式重排会清掉"端点已移动"的那些边上的**过期折点**（不然折点会留在旧位置，走线会绕圈）。
- AI 改完的改动**不在用户本地的撤销历史里**（服务端推新版本时客户端会清空它，免得一次 Ctrl+Z
  把 AI 的改动悄悄顶掉）。宿主留了一层回退点，用户界面「编辑 → 撤销 AI 改动」可以退回上次 AI 写盘前的版本；
  read 返回里的 canRevert 就是"有没有这一层"。

## style 键与 drawio 同构
文档里存的就是 drawio 的 style 键：fillColor / strokeColor / shape= / rounded= / arcSize= /
dashed / dashPattern / strokeWidth / fontSize / fontColor / edgeStyle / jettySize / orthogonalLoop /
endArrow / startArrow / exitX·exitY·entryX·entryY / libavoidRouting …
**默认值一律省略**（写出来等于多一份噪音），认不出的键原样保留。
边自己的文字存在边的 value 上（diagram_read 里是 label），可以写成多行；
拖动过的边标签位置存在边几何的 x/y/offset 里（沿边比例 + 垂距 + 残余），一般不用你碰。

## 画布表示不了、但会原样保留的东西（notes 里会列出来）
多页只显示第 1 页、分组/容器按绝对位置显示、图片按矩形显示、HTML 标签按纯文本显示、
图层结构原样保留（画布把它们叠在一起显示）、drawio 的独立边标签单元（edgeLabel）只读显示。
**看到 notes 要如实告诉用户**：这份文件在 drawio 里打开时会和这里看到的略有差别。

## 别做这些
- 别直接改 .drawio 文件的文本（用 diagram_apply）：手改会破坏"没动的地方逐字节不变"这条保证。
- 别造别的后缀（.json/.xml/.svg）：画布只认 .drawio，其他后缀会"看起来成功、其实没人能打开"。
- 别把图重画一遍来表达"挪一下"：用户手工摆过的位置是有意义的。

## 用户可以这样操作（他问"怎么做"时照这个答）
- 双击节点改文字；双击线段、线段上的文字、或线上的把手，改**线上的文字**
- 按住线上的文字拖动 = 挪文字（有半格吸附，靠近线会贴回线上）；右键「标签居中」放回中点
- 选中连线后：绿/红端点拖到别的节点 = 改接；橙色空心把手拖 = 整段平移；右键有「自动路由」清掉折点
- 空白处左键拖 = 框选（框到节点或线段都算）；Shift 框选是加选；拖选区整体移动（连线形状一起走）
- Ctrl+C/X/V 复制剪切粘贴、Ctrl+Z/Y 撤销重做、Delete 删除；中键拖动平移、滚轮缩放
- 「文件 → 新建画布…/打开…/另存为…」；「视图 → 适应内容」；「整理几何（吸附到格线）」把整张图对齐
- 右键还能改线型/箭头/颜色/顺序（置顶置底）、编辑数据（drawio 用户对象的自定义属性）、删除
`

/**
 * 技能目录里那一段（模型先看到简介，需要时才取全文）。
 * 名字用 kebab-case —— DSH 的注册表按名字寻址并要求这个形状。
 */
const SKILL_SUMMARY = {
  name: 'drawai-canvas',
  description:
    '读写工作区里的 DrawAI 画布（.drawio，就是 drawio 的 mxfile）：diagram_read 看现状、diagram_apply 结构化改图（自动布局、无损写回）。',
  whenToUse:
    '用户让你画流程图/架构图/泳道图，或让你读/改某张 .drawio 画布，或问"这张图里有什么""画布上怎么操作"时。',
}

/**
 * 列出工作区里的画布文档（非递归进子目录，最多扫 MAX_SCAN_DIRS 个）。
 *
 * **列目录的 API 是 `list`，不是 `readRelated`**。之前用 readRelated 是错的：
 * dsh-api-workspace-files 的类型注释写得很明确 ——
 *   read / readBytes / stat / changes 用**绝对路径**；
 *   `list` speaks workspace paths，因为它的消费者是"以工作区根为根的树"。
 * 而且旧实现把异常整个吞掉（catch → null），于是"读不到目录"只表现为**空列表**，
 * 界面上就是"找不到文件"，看不出任何原因。现在：优先 list、失败退回 readRelated、
 * 两者都失败就把错误带回调用方显示。
 *
 * 只扫一层子目录：画布文档按惯例都在根目录或一层子目录下；递归全盘扫描既慢，
 * 又可能撞上 node_modules 这类大目录。
 */
async function listCanvases(root, cwd, dir) {
  const found = []
  const seen = {}
  const dirs = []
  const notes = []

  async function readDir(absPath) {
    try {
      const entries = await nodeReaddir(absPath, { withFileTypes: true })
      return { entries: entries, error: '' }
    } catch (error) {
      return { entries: null, error: messageOf(error) }
    }
  }

  function collect(entries, prefix) {
    if (!Array.isArray(entries)) return
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? entry.name : null
      if (typeof name !== 'string' || name.length === 0) continue
      const isDir =
        entry !== null && typeof entry === 'object'
          ? typeof entry.isDirectory === 'function'
            ? entry.isDirectory()
            : entry.kind === 'directory' || entry.type === 'directory' || entry.isDirectory === true
          : false
      const rel = prefix.length === 0 ? name : prefix + '/' + name
      // 载体就是 .drawio —— 列出来的每一个都能直接打开（不再有「先导入成别的东西」这一步）。
      if (!isDir && name.toLowerCase().endsWith('.drawio')) {
        if (seen[rel] !== true) {
          seen[rel] = true
          found.push(rel)
        }
        continue
      }
      // 只下钻一层，并跳过明显的重目录（node_modules / .git）—— 扫它们又慢又没意义。
      if (isDir && prefix.length === 0 && name !== 'node_modules' && name !== '.git' && dirs.length < MAX_SCAN_DIRS) dirs.push(rel)
    }
  }

  const startAbs = toAbsolute(typeof dir === 'string' && dir.length > 0 ? dir : root, cwd)
  const first = await readDir(startAbs)
  if (first.entries === null) notes.push('无法列出 ' + startAbs + '：' + first.error)
  else collect(first.entries, '')
  for (let d = 0; d < dirs.length; d += 1) {
    const subAbs = toAbsolute(dirs[d], cwd)
    const sub = await readDir(subAbs)
    if (sub.entries === null) {
      notes.push('无法列出 ' + subAbs + '：' + sub.error)
      continue
    }
    collect(sub.entries, dirs[d])
  }
  found.sort()
  return { files: found, notes: notes }
}


export function apply(ctx) {
  function sessionOf(sessionId) {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const session = ctx.sessions.get(sessionId)
      return session === undefined || session === null ? undefined : session
    } catch (error) {
      return undefined
    }
  }

  /**
   * 按**调用会话**解析沙箱策略。
   * 不带 request 的 resolve() 是"无会话"回退，workspaceRoot 会落到部署默认（process.cwd()），
   * 那样工作区文件不在可写根内，writeText 会被 FS_SANDBOX_DENIED 拒掉。
   * 带上 session 后，会话的不可变 cwd 成为可写边界 —— 这不是提权，部署设成 read-only 时照样会拒。
   */
  function policyFor(sessionId) {
    try {
      const session = sessionOf(sessionId)
      return session === undefined ? ctx.sandboxPolicy.resolve() : ctx.sandboxPolicy.resolve({ session: session })
    } catch (error) {
      return undefined
    }
  }

  function workspaceRootOf(sessionId) {
    try {
      const policy = policyFor(sessionId)
      if (policy !== undefined && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
        return policy.workspaceRoot
      }
      const session = sessionOf(sessionId)
      if (session === undefined) return undefined
      const header = session.header
      if (header === undefined || header === null) return undefined
      return typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
    } catch (error) {
      return undefined
    }
  }

  function sessionIdOf(exec) {
    try {
      if (exec === null || exec === undefined) return undefined
      const agent = exec.agent
      if (agent === null || agent === undefined) return undefined
      return typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : undefined
    } catch (error) {
      return undefined
    }
  }

  function absoluteHint(target, fallback) {
    try {
      return ctx.fs.processPath(target)
    } catch (error) {
      return fallback
    }
  }

  async function resolveTarget(path, sessionId) {
    const root = workspaceRootOf(sessionId)
    return root === undefined ? await ctx.fs.resolve(path) : await ctx.fs.resolve(path, { cwd: root })
  }

  /**
   * 读一份画布：**文件是真相**，读的就是 `.drawio`（mxfile）本身。
   *
   * revision 用文件内容指纹（`contentHash`），不落盘 —— 这样 drawio 或别的编辑器改过文件，
   * 指纹自然变，乐观锁不会因为"属性被 drawio 丢掉"而假冲突。
   */
  async function loadDoc(path, sessionId) {
    const target = await resolveTarget(path, sessionId)
    const absolute = absoluteHint(target, path)
    const info = await ctx.fs.stat(target)
    if (info === undefined) return { target: target, absolute: absolute, doc: emptyDoc(), notes: [], exists: false }
    const text = await ctx.fs.readText(target)
    const parsed = parseMxfile(text)
    return { target: target, absolute: absolute, doc: normalizeDoc(parsed.doc), notes: parsed.notes, exists: true, text: text }
  }

  /**
   * 写一份画布：**在原文件上做无损写回**（只改我们拥有的单元，其余原文逐字节保留）。
   *
   * 文件不存在（或为空）时才从零生成 —— 那是"新建"，没有原稿可保护。
   *
   * @returns { text, dropped, revision }
   */
  function renderDocText(originalText, doc, options) {
    const doc2 = normalizeDoc(doc)
    if (typeof originalText !== 'string' || originalText.trim().length === 0) {
      const built = buildMxfile(doc2, options)
      return { text: built.text, dropped: built.dropped, revision: contentHash(built.text) }
    }
    const applied = applyDocToMxfile(originalText, doc2, options)
    return { text: applied.text, dropped: applied.dropped, revision: contentHash(applied.text) }
  }

  /**
   * 工具的路径护栏：只认 `.drawio`。
   *
   * 载体只有一种格式 —— 放开后缀就等于允许 AI 在工作区里造出第二种画布文件，
   * 而那些文件没有画布认领、也不会被「打开」列出来，属于"看起来成功、其实没人能看见"。
   */
  function assertCanvasPath(path) {
    if (typeof path !== 'string' || path.toLowerCase().endsWith('.drawio') === false) {
      throw new Error('画布路径必须以 .drawio 结尾（drawio 的 mxfile 就是画布文件）：' + String(path))
    }
  }

  const readTool = defineTool({
    name: 'diagram_read',
    description:
      '读回工作区里的 DrawAI 画布（.drawio，就是 drawio 自己的 mxfile 格式）：节点 id/标签/形状/style 键，边 id/起点/终点/标签/画法/折点。做任何修改前先用它确认当前图。' +
      '文档存的是 drawio 的 style 键（dashed/dashPattern/edgeStyle/jettySize/libavoidRouting/exitX…/endArrow/strokeColor/shape=…），默认值省略；' +
      '返回体的 shape/dash/arrow/color/exit/entry 是**从 style 串推导出来的便于阅读的名字**，改图请改 style 或对应 op 参数；' +
      'notes 是这个文件里画布表示不了、但会原样保留的东西（多页、分组层级、图片…）。' +
      'layers 是图层表（顺序 = 叠放顺序；visible:false 的层在画布上不画，但里面的单元照旧读得到它们带 layer 字段）；v1 只能看，按层增删要等后续版本。' +
      '不传 path 时读的是**用户当前打开的那张画布**（返回里的 path 就是它）。',
    parameters: {
      path: {
        type: 'string',
        description:
          '工作区相对路径或绝对路径。**不传 = 用户当前打开的那张画布**（没打开任何画布时才退回 ' +
          DEFAULT_PATH +
          '）—— 想知道用户在看哪张，直接不传 path 调一次，返回里的 path 就是它。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          // revision = 文件内容指纹（改由文件决定，不再是我们自己 +1 的计数器）
          revision: { type: 'string', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          // AI 的高亮请求（取走即清）与"有没有可退回的 AI 改动"。
          highlight: { type: 'array', items: { type: 'string' } },
          canRevert: { type: 'boolean' },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                shape: { type: 'string', required: true },
                style: { type: 'string', required: true },
                x: { type: 'number', required: true },
                y: { type: 'number', required: true },
                w: { type: 'number', required: true },
                h: { type: 'number', required: true },
                // 这个单元在哪一层（图层 id）。多于一层的文档才带。
                layer: { type: 'string' },
              },
            },
          },
          // 图层列表：**看得见但 v1 还改不了**（AI 侧按层增删要等 v3 的 ops）。
          // 让 AI 至少知道"这些东西在哪几层""哪一层当前是隐藏的"。
          layers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                visible: { type: 'boolean', required: true },
                locked: { type: 'boolean', required: true },
              },
            },
          },
          edges: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                label: { type: 'string' },
                style: { type: 'string', required: true },
                dash: { type: 'string', required: true },
                arrow: { type: 'string', required: true },
                color: { type: 'string' },
                exit: { type: 'string' },
                entry: { type: 'string' },
                // 这几个是返回体里**确实会带**的字段（execute 里按需填）。
                // 漏声明的后果实测过：schema 是 additionalProperties:false，
                // 于是只要某条边带折点，diagram_read 整个调用被判为非法输出、
                // 直接报错 —— 连读都读不出来。新增返回字段时必须同步这里。
                points: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      x: { type: 'number', required: true },
                      y: { type: 'number', required: true },
                    },
                  },
                },
                sourcePoint: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                  },
                },
                targetPoint: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                  },
                },
                layer: { type: 'string' },
              },
            },
          },
        },
      },
      render: function (args, value) {
        const layers = Array.isArray(value.layers) ? value.layers : []
        const layerNameOf = function (id) {
          for (let i = 0; i < layers.length; i += 1) if (layers[i].id === id) return layers[i].name
          return id
        }
        const inLayer = function (item) {
          return layers.length > 1 && typeof item.layer === 'string' && item.layer.length > 0 ? '  ⟨' + layerNameOf(item.layer) + '⟩' : ''
        }
        const lines = [
          '画布 ' + value.path + '（revision ' + value.revision + '，' + value.nodes.length + ' 节点 / ' + value.edges.length + ' 边）',
        ]
        for (let i = 0; i < value.nodes.length; i += 1) {
          const n = value.nodes[i]
          lines.push(
            '  节点 ' + n.id + ' [' + n.shape + '] ' + n.label + '  @' + n.x + ',' + n.y + ' ' + n.w + '×' + n.h +
              (n.style.length === 0 ? '（默认样式）' : '  style: ' + n.style) + inLayer(n),
          )
        }
        for (let i = 0; i < value.edges.length; i += 1) {
          const e = value.edges[i]
          const bits = [e.dash, e.arrow + ' arrow']
          if (e.color !== undefined) bits.push(e.color)
          if (e.exit !== undefined || e.entry !== undefined) bits.push((e.exit === undefined ? '?' : e.exit) + '->' + (e.entry === undefined ? '?' : e.entry))
          if (Array.isArray(e.points)) bits.push(e.points.length + ' waypoint(s)')
          lines.push(
            '  边 ' + e.id + ' ' + e.from + ' -> ' + e.to + (typeof e.label === 'string' && e.label.length > 0 ? ' "' + e.label + '"' : '') +
              ' [' + bits.join(', ') + ']' + inLayer(e),
          )
        }
        for (let i = 0; i < value.notes.length; i += 1) lines.push('  ⚠ ' + value.notes[i])
        // 图层表：v1 只读。名字 + 可见性（隐藏层里的东西 AI 也照读，但它得知道"用户现在看不见"）。
        if (layers.length > 0) {
          lines.push('  图层（顺序 = 叠放顺序，后面的在上面）：')
          for (let i = 0; i < layers.length; i += 1) {
            const l = layers[i]
            lines.push('    ' + (l.visible === false ? '🚫' : '👁') + ' ' + l.name + ' (id ' + l.id + ')' + (l.locked === true ? ' 🔒' : ''))
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      // 与 diagram_apply 同一条回退链：显式 path > 用户当前打开的画布 > DEFAULT_PATH。
      // 两处必须一致 —— 否则 AI 会"读 A、写 B"。
      const focus = focusedPathFor(sessionIdOf(exec))
      const path =
        typeof args.path === 'string' && args.path.length > 0 ? args.path : focus !== undefined && focus.length > 0 ? focus : DEFAULT_PATH
      assertCanvasPath(path)
      const loaded = await loadDoc(path, sessionIdOf(exec))
      const doc = loaded.doc
      const nodes = []
      for (let i = 0; i < doc.nodes.length; i += 1) {
        const n = doc.nodes[i]
        const style = typeof n.style === 'string' ? n.style : ''
        nodes.push({
          id: String(n.id),
          label: typeof n.label === 'string' ? n.label : String(n.id),
          shape: nodeShapeFromStyle(style),
          style: style,
          // 坐标与尺寸：**AI 也要看得见位置**。不给的话它判断不了"会不会重叠""有没有对齐"
          // （实测：想让它把某几个节点往右挪一点，它只能靠猜或者干脆删掉重画）。
          x: numberOr(n.x, 0),
          y: numberOr(n.y, 0),
          w: numberOr(n.w, DEFAULT_W),
          h: numberOr(n.h, DEFAULT_H),
          ...(typeof n.layer === 'string' && n.layer.length > 0 ? { layer: n.layer } : {}),
        })
      }
      const edges = []
      for (let i = 0; i < doc.edges.length; i += 1) {
        const e = doc.edges[i]
        const style = typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE
        const item = {
          id: String(e.id),
          // 悬空端的这一端**没有真实顶点**：如实报空串，并把自由点一起给出
          // （报成 String(undefined) 会让模型以为那里真有个叫 "undefined" 的节点）。
          from: typeof e.from === 'string' ? e.from : '',
          to: typeof e.to === 'string' ? e.to : '',
          style: style,
          dash: dashFromStyle(style),
          arrow: arrowFromStyle(style),
        }
        if (typeof e.label === 'string' && e.label.length > 0) item.label = e.label
        // 派生 color：正好命中调色板就给名字（AI 好读），否则给原始 strokeColor ——
        // 不能因为"名字认不出"就让 AI 看不见颜色（drawio 的文档里本来就只有十六进制）。
        const name = colorNameFromStyle(style)
        if (name !== null && name !== 'plain') item.color = name
        else {
          const stroke = styleGet(style, 'strokeColor', null)
          if (stroke !== null && stroke !== DEFAULT_STROKE) item.color = stroke
        }
        const exit = sideFromStyle(style, 'source')
        const entry = sideFromStyle(style, 'target')
        if (exit !== null) item.exit = exit
        if (entry !== null) item.entry = entry
        const points = normalizePoints(e.points)
        if (points !== null) item.points = points
        if (e.sourcePoint !== undefined) item.sourcePoint = e.sourcePoint
        if (e.targetPoint !== undefined) item.targetPoint = e.targetPoint
        if (typeof e.layer === 'string' && e.layer.length > 0) item.layer = e.layer
        edges.push(item)
      }
      // 顺路带两件事（都要在 output.schema 里声明 —— additionalProperties:false 会把
      // 没声明的字段整个判为非法输出，这条踩过一次）：
      //   highlight —— AI 用 `{op:'highlight'}` 请求的高亮，取走即清；
      //   canRevert —— 这张画布上有没有可退回的 AI 改动。
      const pendingHighlight = highlightFor.get(sessionIdOf(exec))
      if (pendingHighlight !== undefined) highlightFor.delete(sessionIdOf(exec))
      return {
        path: loaded.absolute,
        revision: doc.revision,
        notes: loaded.notes,
        nodes: nodes,
        edges: edges,
        highlight: Array.isArray(pendingHighlight) ? pendingHighlight : [],
        canRevert: revertSnapshots.has(snapshotKey(sessionIdOf(exec), loaded.absolute)),
        // 图层（只读可见）：AI 至少知道自己画的图在哪几层、哪一层是隐藏的
        //（按层加单元、按层导出要等 v3 的 ops）。
        layers: (Array.isArray(doc.layers) ? doc.layers : []).map((l) => ({
          id: String(l.id),
          name: typeof l.name === 'string' ? l.name : '',
          visible: l.visible !== false,
          locked: l.locked === true,
        })),
      }
    },
  })

  const applyTool = defineTool({
    name: 'diagram_apply',
    description:
      '对工作区里的 DrawAI 画布文档施加一组结构化编辑（加节点/连边/改标签/改样式/移动/删除/高亮），然后自动布局并写回文件。布局默认由这里算；ops 里一旦自带几何（addNode 给了 x/y，或有 move）就不再重排，想重排请显式给 layout。' +
      'ops 的每一项形如 {op:"addNode", label:"...", shape?, style?, keys?, w?, h?, x?, y?} / ' +
      '{op:"addEdge", from?, to?, fromPoint?, toPoint?, label?, style?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, avoid?, keys?} / ' +
      '{op:"setLabel", id, label} / {op:"setStyle", id, shape?, style?, keys?, w?, h?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, avoid?, clearPoints?} / ' +
      '{op:"move", id, dx?, dy?, x?, y?} / {op:"remove", id} / {op:"highlight", ids:[...]}；节点 id 省略时自动分配。' +
      'addEdge 的两端各自可以给**节点 id** 或**绝对点**（fromPoint/toPoint）—— 两端都给点就是一条**独立线**' +
      '（drawio 里边的两端都可以是自由点，线可以完全不接节点）。' +
      'move 改已有元素的位置：节点可以给 dx/dy（相对）或 x/y（绝对），连线只能给 dx/dy（平移它自己的折点与自由端点）。' +
      '以前没有 move，只能删掉重画 —— 那会丢 id、丢边上的端点约束与折点。' +
      'highlight 只让客户端选中那几个（不改文档，也不重排）。' +
      '文档里存的是 **drawio 的 style 键**（dashed/dashPattern/edgeStyle/jettySize/libavoidRouting/exitX·exitY·entryX·entryY/endArrow·startArrow/strokeColor/fillColor/shape=/rounded=/arcSize=…），默认值一律省略、认不出的键原样保留；' +
      '上面这些 shape/style/dash/arrow/color/exit/entry 是给模型用的**糖**，由宿主翻译成 style 键，绝不落盘。' +
      'style 既可以是调色板名（plain/blue/green/orange/yellow/red/purple/grey），也可以直接是一段 style 串；keys 用来写任意 drawio 键（值给 null = 删键回默认）。' +
      'setStyle 的 id 可以是节点也可以是连线：节点用 shape/style/keys/w/h，连线用 dash（solid|dashed|dotted）、arrow（end 单向|both 双向|none 无箭头|start 反向）、color、exit/entry（n|e|s|w 进出侧）、jettySize（引出段长度，数字或 auto）、edgeStyle（orthogonalEdgeStyle|none）、avoid（是否参与避让路由）、clearPoints（清掉折点）。' +
      '文档若带 meta.pinned（人手工摆过位置），不加 layout 就不会重排；显式重排会清掉端点已移动的那些边上的过期折点。' +
      '边引用了不存在的节点会直接报错，且失败发生在写盘之前。自环写成 from === to（与 drawio 一致）；自动布局会忽略自环，只摆节点。' +
      '不传 path 时改的是**用户当前打开的那张画布**（没打开才退回 ' + DEFAULT_PATH + '）—— 用户说"这张图"时不用传 path。',
    parameters: {
      path: {
        type: 'string',
        description:
          '工作区相对路径或绝对路径。**不传 = 用户当前打开的那张画布**（没打开任何画布时才退回 ' +
          DEFAULT_PATH +
          '）—— 想知道用户在看哪张，直接不传 path 调一次，返回里的 path 就是它。',
      },
      ops: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description: '结构化编辑数组，见工具描述里的 ops 语法',
      },
      layout: {
        type: 'string',
        enum: ['dagre-lr', 'dagre-tb', 'grid', 'none'],
        description: '自动布局：dagre-tb 上到下（默认，贴合右栏窄高形状）、dagre-lr 左到右、grid 网格、none 保留现有坐标（只给无坐标的新节点补位）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          revision: { type: 'string', required: true },
          nodeCount: { type: 'number', required: true },
          edgeCount: { type: 'number', required: true },
          layout: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: function (args, value) {
        return [
          {
            type: 'text',
            text:
              '已更新 ' + value.path + '：revision ' + value.revision + '，' + value.nodeCount + ' 节点 / ' + value.edgeCount +
              ' 边，布局 ' + value.layout + '\n' + value.summary,
          },
        ]
      },
    },
    async execute(args, exec) {
      // 没有显式 path 时，优先用"用户当前打开的那张画布"（客户端上报的聚焦路径），
      // 最后才退回 DEFAULT_PATH。这样"帮我在这张画布上画"改的就是屏幕上那张，
      // 而不是工作区里的 demo.drawio（那个坑实测踩过）。
      const focused = focusedPathFor(sessionIdOf(exec))
      const path =
        typeof args.path === 'string' && args.path.length > 0 ? args.path : focused !== undefined && focused.length > 0 ? focused : DEFAULT_PATH
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Error('ops must contain at least one operation')

      const sessionId = sessionIdOf(exec)
      assertCanvasPath(path)
      const loaded = await loadDoc(path, sessionId)
      const doc = loaded.doc

      // 人工摆过的文档（meta.pinned）默认不再自动重排 —— 否则 AI 一改图，
      // 人手工调好的位置就被 dagre 全冲掉了。想重排必须显式指定 layout。
      const pinned = doc.meta !== null && typeof doc.meta === 'object' && doc.meta.pinned === true
      // `highlight` 只是"让客户端选中这几个"，不改文档 —— 于是：
      //   · 一次全是 highlight 的调用**不写盘**（也不会顺手重排，那条特别危险）；
      //   · 混着编辑时，它跟着一起生效。
      const edits = ops.filter((op) => op === null || typeof op !== 'object' || op.op !== 'highlight')
      const onlyHighlight = edits.length === 0
      // 默认布局：pinned、纯 highlight、以及**ops 里自带几何**（addNode 给了 x/y、或者有 move）
      // 时都不重排 —— 否则"把 n1 往右挪 40"会被 dagre 立刻冲掉（实测：move 完坐标原样回来，
      // 看起来像工具坏了）。想重排就显式给 layout。
      const explicitGeometry = ops.some(
        (op) =>
          op !== null &&
          typeof op === 'object' &&
          (op.op === 'move' || (op.op === 'addNode' && (Number.isFinite(Number(op.x)) || Number.isFinite(Number(op.y))))),
      )
      const mode = typeof args.layout === 'string' ? args.layout : pinned || onlyHighlight || explicitGeometry ? 'none' : 'dagre-tb'
      if (LAYOUTS.indexOf(mode) < 0) throw new Error('unknown layout "' + mode + '"; use one of ' + LAYOUTS.join(', '))

      const out = {}
      const notes = applyOps(doc, ops, out)
      if (Array.isArray(out.highlight)) highlightFor.set(sessionId, out.highlight)
      if (onlyHighlight) {
        return {
          path: loaded.absolute,
          revision: doc.revision,
          nodeCount: doc.nodes.length,
          edgeCount: doc.edges.length,
          layout: 'none',
          summary: notes.length === 0 ? '(no change)' : notes.join('\n'),
        }
      }
      if (mode === 'none') placeMissing(doc)
      else {
        const before = nodePositions(doc)
        autoLayout(doc, mode)
        const dropped = invalidateStalePoints(doc, before)
        if (dropped > 0) notes.push('~ 重排后端点位置变了，已清掉 ' + dropped + ' 条边上的过期折点')
      }
      // 写回：**在原文件上做无损写回**（只改我们拥有的单元，其余原文逐字节保留）。
      // revision 由文件内容算出来，不再是"我们自己 +1"—— 载体即真相，没有第二个计数器。
      // meta.pinned 的合并规则见下面那句注释。
      //
      // 这里曾经写的是 doc.meta = { engine, layout }，于是**第一次 AI 改图就把 pinned 擦掉了**：
      // 那一次没事（mode 已经是 'none'，人不人的位置都保住了），但从第二次起 pinned 读不到，
      // mode 回落到 'dagre-tb'，人手工摆好的版面被整张重排 —— 正是上面那个判断要防的事。
      // 教训：用整体赋值覆盖 meta 时，"没被显式处理"的字段会静默消失；新增 meta 字段时先看这里。
      doc.meta = Object.assign({}, doc.meta, { layout: mode }, pinned ? { pinned: true } : {})
      const rendered = renderDocText(loaded.text, doc)
      doc.revision = rendered.revision
      if (rendered.dropped.length > 0) notes.push('~ ' + rendered.dropped.length + ' 条边的两端都没有落点，已略过：' + rendered.dropped.join(', '))
      const policy = policyFor(sessionId)
      // 落盘前留一份"上一版"：AI 的改动**不在客户端的撤销历史里**（服务端推新版本时
      // 客户端会清空本地历史，免得一次 Ctrl+Z 把 AI 的改动悄悄顶掉），
      // 所以这边给一个一层的回退点，界面上对应「编辑 → 撤销 AI 改动」。
      if (loaded.exists === true && typeof loaded.text === 'string') {
        revertSnapshots.set(snapshotKey(sessionId, loaded.absolute), { text: loaded.text, revision: doc.revision })
      }
      try {
        if (policy === undefined) await ctx.fs.writeText(loaded.target, rendered.text)
        else await ctx.fs.writeText(loaded.target, rendered.text, undefined, undefined, policy)
      } catch (error) {
        const scope = policy === undefined ? 'unresolved policy' : policy.mode + ' @ ' + String(policy.workspaceRoot)
        throw new Error('write "' + loaded.absolute + '" failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']')
      }
      if (revertSnapshots.has(snapshotKey(sessionId, loaded.absolute))) {
        notes.push('↩ 这次改动可以退回：界面上「编辑 → 撤销 AI 改动」')
      }
      return {
        path: loaded.absolute,
        revision: doc.revision,
        nodeCount: doc.nodes.length,
        edgeCount: doc.edges.length,
        layout: mode,
        summary: notes.length === 0 ? '(no change)' : notes.join('\n'),
      }
    },
  })

/**
 * 校验"新建画布"的文件名。
 *
 * 只允许**单个文件名**（不含路径分隔符），且必须以 .drawio 结尾。
 * 这样即使用户在界面上输入 `..\\..\\x` 也进不来 —— 新建永远落在工作区根目录，
 * 不存在"写到哪里去了"的空间。想放到子目录请自己先建好再打开。
 */
function sanitizeNewName(raw) {
  const name = String(raw === undefined || raw === null ? '' : raw).trim()
  if (name.length === 0) return { ok: false, error: '请输入文件名' }
  if (/[\\/]/.test(name)) return { ok: false, error: '文件名不能包含路径分隔符（新建只落在工作区根目录）' }
  if (name === '.' || name === '..') return { ok: false, error: '文件名非法' }
  // 禁止 Windows 非法字符，省得写盘才失败
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return { ok: false, error: '文件名包含非法字符' }
  const withExt = name.toLowerCase().endsWith('.drawio') ? name : name + '.drawio'
  if (withExt.length > 120) return { ok: false, error: '文件名过长' }
  return { ok: true, name: withExt }
}

  /**
   * 「画布聚焦」：记录每个会话当前**打开着**的画布路径。
   *
   * 为什么需要：AI 改图只认路径。不传 path 时原来会落到 demo.drawio ——
   * 于是"帮我在这张画布上画"会画到别的文件里，用户屏幕上毫无反应（实测踩过）。
   * 有了聚焦记录，不传 path 就改"用户正看着的那张"。
   *
   * 只存路径、不读内容：画布内容始终以文件为唯一真相源，这里记的只是"在看哪一张"。
   */
  const focusedCanvas = new Map()
  /** 每个会话最近**注入过**的聚焦路径（同一张不重复打扰模型）。 */
  const injectedCanvas = new Map()
  /**
   * AI 改动前的"上一版"文本（按 会话+路径 存，**只留一层**）。
   *
   * 客户端的撤销历史在服务端推来新版本时会被清空（故意的：否则一次 Ctrl+Z
   * 会把 AI 刚写的改动悄悄顶掉），所以 AI 的改动要能退，就得宿主自己留一个回退点。
   */
  const revertSnapshots = new Map()
  /** AI 请求的"高亮这些"（按会话，客户端下次来读时取走并清空）。 */
  const highlightFor = new Map()

  function snapshotKey(sessionId, absolute) {
    return String(sessionId) + '\n' + String(absolute)
  }

  function focusedPathFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return focusedCanvas.get(sessionId)
  }

  /**
   * 用户切换画布时，把"当前打开的是哪一张"**注入**到那个会话（Agent 的 model-facing context）。
   *
   * 为什么值得主动说一句：工具不传 path 时本来就落到"用户当前打开的那张"，
   * 但模型在此之前**只能靠先调一次 diagram_read、看返回里的 path** 才知道是哪张 ——
   * 用户问"我现在看的是哪张图""在这张图上加个节点"时，它得先探一次才敢动。
   * 注入之后，模型在下一步就能直接看到，不用探。
   *
   * `agents` 是**可选**服务（走 ctx.get）：没有它的部署、或注入形状对不上老版本时，
   * 都只是少了这条提示 —— 工具那条回退链（显式 path > 聚焦画布 > DEFAULT_PATH）仍然是兜底。
   */
  function notifyFocusedCanvas(sessionId, path) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return
    let agent
    try {
      agent = agents.get(sessionId)
    } catch (error) {
      return
    }
    if (agent === undefined || agent === null || typeof agent.inject !== 'function') return
    // 只记"注入过哪一张"，同一张反复报（客户端每次挂载都会报一次）就不再打扰模型。
    if (injectedCanvas.get(sessionId) === path) return
    injectedCanvas.set(sessionId, path)
    const text =
      path.length > 0
        ? 'DrawAI 画布：用户现在打开的是 ' + path + '。diagram_read / diagram_apply 不传 path 时默认就操作这一张。'
        : 'DrawAI 画布：用户关掉了画布（此刻没有打开任何一张）。不传 path 时工具会退回 ' + DEFAULT_PATH + '。'
    try {
      // 形状照 @deepseek-ai/dsh-llm 的 UserMessage：role + content + source。
      // source 用 `{ kind: 'plugin', plugin: <本插件名> }`（与第一方 dsh-agent-instructions 同款）；
      // 不带 form —— 它只是个"环境事实"，不是 instructions/catalog 那几类。
      agent.inject({ role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: name } })
    } catch (error) {
      // 注入失败不该影响画布本身：工具那条回退链还在。
    }
  }

  /**
   * 人工编辑的写回端点。
   *
   * 为什么必须自带：客户端能用的 Remote 面**只有读方法**（workspaceFiles 的
   * read/readBytes/readAll/readRelated/stat/list/changes），整个 DSH 没有通用的
   * "写文件" Remote。人拖完节点要落盘，只能自己开一条通道 —— dsh-better-sidebar
   * 的编辑器 tab 保存文件走的也是这个办法（/sidebar/api）。
   *
   * 信任围栏（方案 §6.4 明确警告：开任意路径路由会绕过围栏，所以这里逐条校验）：
   *   1. 只接受 POST，且必须带自定义头 —— 跨站表单设不了它，跨域 fetch 会触发预检被浏览器拦掉
   *   2. 带 Origin 时必须同源
   *   3. 只写会话工作区根内的 .drawio（用 fs.contains 做真实路径包含判断，不是字符串前缀）
   *   4. revision 乐观锁：对不上就 409，绝不覆盖别人的改动
   *
   * 顺带把 meta.pinned 打成 true —— 从此这个文档被人手工摆过，
   * diagram_apply 不该再默认自动重排把它冲掉。
   */
  async function handleSave(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (req.headers[SAVE_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing ' + SAVE_HEADER + ' header' })
      return
    }
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === req.headers.host
      } catch (error) {
        sameOrigin = false
      }
      if (!sameOrigin) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
    }

    let text
    try {
      text = await readBody(req, SAVE_MAX_BYTES)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: messageOf(error) })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'request body is not JSON' })
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
      return
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
    const rawPath = typeof body.path === 'string' ? body.path : undefined

    // action: 'list' —— 列出工作区里可打开的 .drawio，供「打开」菜单用。
    // 复用同一条路由而不是另开一个：信任围栏（POST + 自定义头 + 同源）只写一次，
    // 少一个口子就少一处可能忘记校验的地方。
    if (body.action === 'list') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const root = workspaceRootOf(sessionId)
      if (root === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      // dir：只列出**这一个目录**（不递归下钻）。给"用文件管理器挑了一个目录"用 ——
      // 用户从系统选择器选中的目录可能在别处，所以这里必须做工作区包含校验，
      // 否则它就成了"列任意目录"的口子（信任围栏的意义就在这）。
      const dir = typeof body.dir === 'string' && body.dir.length > 0 ? body.dir : null
      if (dir !== null) {
        let dirTarget
        try {
          dirTarget = await ctx.fs.resolve(dir)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
          return
        }
        try {
          const rootTarget = await ctx.fs.resolve(root)
          if (!ctx.fs.contains(rootTarget, dirTarget)) {
            sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(dirTarget, dir) })
            return
          }
        } catch (error) {
          sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
          return
        }
        try {
          const listed = await listCanvases(root, root, dir)
          // 同时给出**绝对路径**：客户端按路径去重（同一个文件不该开出两个标签），
          // 而标签上的路径可能来自 tab 的资源地址（绝对），与列表里的相对路径不相等。
          // 让客户端用绝对路径当"身份"，就不会重复开标签。
          const abs = []
          for (let i = 0; i < listed.files.length; i += 1) abs.push(toAbsolute(listed.files[i], root))
          sendJson(res, 200, {
            ok: true,
            files: listed.files,
            absolute: abs,
            notes: listed.notes,
            root: absoluteHint(root, root),
            dir: absoluteHint(dirTarget, dir),
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: 'list failed: ' + messageOf(error) })
        }
        return
      }
      try {
        const listed = await listCanvases(root, root, root)
        const abs = []
        for (let i = 0; i < listed.files.length; i += 1) abs.push(toAbsolute(listed.files[i], root))
        sendJson(res, 200, {
          ok: true,
          files: listed.files,
          absolute: abs,
          notes: listed.notes,
          root: absoluteHint(root, root),
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'list failed: ' + messageOf(error) })
      }
      return
    }

    // action: 'read' —— 把 .drawio 读成语义文档交给界面。
    //
    // **为什么读也走宿主**：drawio 默认把页体压成 base64(raw deflate(xml))，而浏览器没有 zlib
    // （DecompressionStream 是异步的，塞不进同步渲染路径）。与其把解析器抄一份到客户端，
    // 不如让唯一的解析器待在它本来就在的地方：宿主。客户端只认文档，不认 mxfile。
    if (body.action === 'read') {
      if (sessionId === undefined || rawPath === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
        return
      }
      const readRoot = workspaceRootOf(sessionId)
      if (readRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      let readTarget
      try {
        readTarget = await ctx.fs.resolve(rawPath, { cwd: readRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(readRoot)
        if (!ctx.fs.contains(rootTarget, readTarget)) {
          sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absoluteHint(readTarget, rawPath) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      try {
        const info = await ctx.fs.stat(readTarget)
        if (info === undefined) {
          sendJson(res, 200, { ok: true, exists: false, path: rawPath, absolute: absoluteHint(readTarget, rawPath), revision: '', doc: emptyDoc(), notes: [] })
          return
        }
        const loaded = await loadDoc(rawPath, sessionId)
        // 两件"顺路带给客户端"的东西：
        //   highlight —— AI 用 `{op:'highlight', ids}` 请求的高亮，**取走即清**（一次性）；
        //   canRevert —— 这张画布上有没有可退回的 AI 改动（菜单项据此启用）。
        const pendingHighlight = highlightFor.get(sessionId)
        if (pendingHighlight !== undefined) highlightFor.delete(sessionId)
        sendJson(res, 200, {
          ok: true,
          exists: true,
          path: rawPath,
          absolute: loaded.absolute,
          revision: loaded.doc.revision,
          doc: loaded.doc,
          notes: loaded.notes,
          highlight: Array.isArray(pendingHighlight) ? pendingHighlight : [],
          canRevert: revertSnapshots.has(snapshotKey(sessionId, loaded.absolute)),
        })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: '这个文件读不出画布：' + messageOf(error) })
      }
      return
    }

    // action: 'revert' —— 退回**上一次 AI 改动**（就一层）。
    //
    // 为什么需要这条：客户端的撤销历史在服务端推来新版本时会被清空，
    // 所以 AI 改完以后用户按 Ctrl+Z 是退不回去的。宿主留一份改动前的文本，这里把它写回去。
    if (body.action === 'revert') {
      if (sessionId === undefined || rawPath === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
        return
      }
      let revertTarget
      let revertAbsolute
      try {
        const loaded = await loadDoc(rawPath, sessionId)
        revertTarget = loaded.target
        revertAbsolute = loaded.absolute
      } catch (error) {
        sendJson(res, 400, { ok: false, error: '这个文件读不出画布：' + messageOf(error) })
        return
      }
      const key = snapshotKey(sessionId, revertAbsolute)
      const snapshot = revertSnapshots.get(key)
      if (snapshot === undefined) {
        sendJson(res, 200, { ok: false, error: '这张画布没有可退回的 AI 改动（只保留最近一次）' })
        return
      }
      const policy = policyFor(sessionId)
      try {
        if (policy === undefined) await ctx.fs.writeText(revertTarget, snapshot.text)
        else await ctx.fs.writeText(revertTarget, snapshot.text, undefined, undefined, policy)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) })
        return
      }
      revertSnapshots.delete(key)
      sendJson(res, 200, { ok: true, revision: contentHash(snapshot.text), path: revertAbsolute })
      return
    }

    // action: 'focus' —— 画布告诉宿主"用户现在打开的是哪一张"。
    // 之后 diagram_apply 不传 path 时就改它（见下面的 execute）。
    // 校验后**只存相对工作区的路径**：绝对路径能存但会让日志/提示变长，
    // 而且工作区被移动后相对路径仍然有效。
    if (body.action === 'focus') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const focusRoot = workspaceRootOf(sessionId)
      if (focusRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const raw = typeof body.path === 'string' ? body.path : ''
      const before = focusedCanvas.get(sessionId)
      // 空路径 = 清掉聚焦（画布未绑定文件时）
      if (raw.length === 0) {
        focusedCanvas.delete(sessionId)
        if (before !== undefined) notifyFocusedCanvas(sessionId, '')
        sendJson(res, 200, { ok: true, focused: null })
        return
      }
      let focusTarget
      try {
        focusTarget = await ctx.fs.resolve(raw, { cwd: focusRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(focusRoot)
        if (!ctx.fs.contains(rootTarget, focusTarget)) {
          sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(focusTarget, raw) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      focusedCanvas.set(sessionId, raw)
      if (before !== raw) notifyFocusedCanvas(sessionId, raw)
      sendJson(res, 200, { ok: true, focused: raw })
      return
    }

    // action: 'suggest' —— 只**探**一个还没被占用的默认文件名，不建任何文件。
    //
    // 给界面上"新建"对话框预填用：用户要自己输名字，但默认值应该是
    // 当前可用的下一个（untitled / untitled-2 / untitled-3 …），而不是让人从空白开始想。
    // 刻意不落盘：预填只是提示，用户可能改主意取消 —— 不该留下空文件。
    if (body.action === 'suggest') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const suggestRoot = workspaceRootOf(sessionId)
      if (suggestRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const base = typeof body.base === 'string' && body.base.trim().length > 0 ? body.base.trim() : 'untitled'
      let name = base
      for (let n = 2; n <= 999; n += 1) {
        const candidate = sanitizeNewName(name)
        if (!candidate.ok) break
        let taken = true
        try {
          const target = await ctx.fs.resolve(candidate.name, { cwd: suggestRoot })
          taken = (await ctx.fs.stat(target)) !== undefined
        } catch (error) {
          taken = false
        }
        if (!taken) {
          sendJson(res, 200, { ok: true, name: candidate.name })
          return
        }
        name = base + '-' + n
      }
      sendJson(res, 200, { ok: true, name: base })
      return
    }

    // action: 'create' —— 新建一张**真实存在**的空画布并绑定到它。
    //
    // 为什么不"留着以后再说"：画布一旦没有文件，AI 对话就够不到它
    // （diagram_apply 只按路径工作，不传 path 会落到 demo.drawio —— 实测过）。
    // 与其让用户对着"未命名画布"说"画一张图"却改到别的文件，不如新建时就落一个空文件。
    // 同名文件已存在时**不覆盖**，返回 exists 让界面提示改名。
    if (body.action === 'create') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const nameCheck = sanitizeNewName(body.name)
      if (!nameCheck.ok) {
        sendJson(res, 400, { ok: false, error: nameCheck.error })
        return
      }
      const createRoot = workspaceRootOf(sessionId)
      if (createRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      let createTarget
      try {
        createTarget = await ctx.fs.resolve(nameCheck.name, { cwd: createRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(createRoot)
        if (!ctx.fs.contains(rootTarget, createTarget)) {
          sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absoluteHint(createTarget, nameCheck.name) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      try {
        const info = await ctx.fs.stat(createTarget)
        if (info !== undefined) {
          sendJson(res, 200, { ok: false, exists: true, error: 'already exists', path: nameCheck.name })
          return
        }
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'stat failed: ' + messageOf(error) })
        return
      }
      // 空画布也打 meta.pinned：它是人手工建的，不该被 AI 的自动布局重排。
      const blankBuilt = buildMxfile({ version: 2, revision: '', meta: { pinned: true }, nodes: [], edges: [] }, { name: nameCheck.name.replace(/\.drawio$/i, '') })
      const createPolicy = policyFor(sessionId)
      try {
        if (createPolicy === undefined) await ctx.fs.writeText(createTarget, blankBuilt.text)
        else await ctx.fs.writeText(createTarget, blankBuilt.text, undefined, undefined, createPolicy)
      } catch (error) {
        const scope = createPolicy === undefined ? 'unresolved policy' : createPolicy.mode + ' @ ' + String(createPolicy.workspaceRoot)
        sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        path: nameCheck.name,
        absolute: absoluteHint(createTarget, nameCheck.name),
        revision: contentHash(blankBuilt.text),
      })
      return
    }

    if (sessionId === undefined || rawPath === undefined) {
      sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
      return
    }
    if (!rawPath.toLowerCase().endsWith('.drawio')) {
      sendJson(res, 403, { ok: false, error: 'only .drawio documents may be written' })
      return
    }
    const doc = body.doc
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      sendJson(res, 400, { ok: false, error: 'doc must be a JSON object' })
      return
    }

    const root = workspaceRootOf(sessionId)
    if (root === undefined) {
      sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
      return
    }

    let target
    try {
      target = await ctx.fs.resolve(rawPath, { cwd: root })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
      return
    }
    const absolute = absoluteHint(target, rawPath)

    try {
      const rootTarget = await ctx.fs.resolve(root)
      if (!ctx.fs.contains(rootTarget, target)) {
        sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absolute })
        return
      }
    } catch (error) {
      sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
      return
    }

    // 乐观锁：基线是**文件内容指纹**（客户端打开时拿到的那个 revision）。
    // 不用"我们自己的计数器 +1"：载体是唯一真相，drawio 或别的编辑器改过文件之后，
    // 计数器无从得知；而指纹天然会变，冲突判定才是真的。
    let originalText
    let exists = false
    try {
      const info = await ctx.fs.stat(target)
      if (info !== undefined) {
        exists = true
        originalText = await ctx.fs.readText(target)
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'read current failed: ' + messageOf(error) })
      return
    }
    const baseRevision = typeof body.revision === 'string' && body.revision.length > 0 ? body.revision : undefined
    // createOnly（「另存为」）：目标**不该已存在**。已存在就直接拒绝，绝不静默覆盖。
    if (body.createOnly === true && exists) {
      sendJson(res, 409, { ok: false, error: 'already exists', path: absolute })
      return
    }
    if (baseRevision !== undefined && exists && contentHash(originalText) !== baseRevision) {
      sendJson(res, 409, { ok: false, error: 'revision conflict', currentRevision: contentHash(originalText) })
      return
    }

    // 人工编辑一律打 pinned：从此这张画布是人摆过版面的，AI 的自动布局不该再冲掉它。
    // （空文件 → 从零生成；已有文件 → 无损写回，见 renderDocText。）
    const next = normalizeDoc(doc)
    next.meta = Object.assign({}, next.meta, { pinned: true })
    let rendered
    try {
      rendered = renderDocText(exists ? originalText : undefined, next)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: '写入前解析原文件失败：' + messageOf(error) })
      return
    }
    const policy = policyFor(sessionId)
    try {
      if (policy === undefined) await ctx.fs.writeText(target, rendered.text)
      else await ctx.fs.writeText(target, rendered.text, undefined, undefined, policy)
    } catch (error) {
      const scope = policy === undefined ? 'unresolved policy' : policy.mode + ' @ ' + String(policy.workspaceRoot)
      sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']' })
      return
    }
    sendJson(res, 200, { ok: true, revision: rendered.revision, path: absolute, dropped: rendered.dropped })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SAVE_PATH, handler: handleSave }), 'drawai: ' + SAVE_PATH)

  ctx.effect(() => ctx.tools.register(readTool))
  ctx.effect(() => ctx.tools.register(applyTool))

  // 把"怎么用这张画布"注册成**内嵌技能**（见 SKILL_BODY 的注释）：
  // 换了电脑、只装了插件（没有源码/README/tools）时，模型依然知道该怎么操作。
  //
  // `skills` 是**可选**依赖：没装 skill 注册表的部署里照样能用（工具描述本身已经够启动），
  // 所以走 ctx.get 而不是写进 inject —— 缺它不该让整个插件停在等待态。
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills !== undefined && skills !== null && typeof skills.register === 'function') {
    ctx.effect(() =>
      skills.register({
        name: SKILL_SUMMARY.name,
        description: SKILL_SUMMARY.description,
        whenToUse: SKILL_SUMMARY.whenToUse,
        // `source: 'runtime'` 不能省：注册时只校验 name/description/invocation，
        // 但**取全文**时注册表会再跑一次 validateDefinition，那里要求 source 是字符串
        // （少了它，目录里看得见、一 load 就抛 "source must be a string"）。
        source: 'runtime',
        content: SKILL_BODY,
      }),
    )
  }
}
