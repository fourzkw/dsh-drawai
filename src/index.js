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
  DEFAULT_FONT,
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
  lineKindFromStyle,
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
  styleWithLineKind,
  styleWithNodeShape,
  styleWithSide,
  styleWithTextColorName,
  textColorNameFromStyle,
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
/** `order` 的四种去向（与画布右键的顺序菜单同一套：后面的在上面）。 */
const ORDER_MODES = ['front', 'back', 'up', 'down']
/** `duplicate` 的默认位移：两格 —— 与画布上 Ctrl+V 同一套（不然复制出来的正好压在原图上）。 */
const DUPLICATE_OFFSET = 20

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

/**
 * 线型四选一：直线 / 直角折线 / 圆角折线 / 曲线。
 *
 * 模型可能说 "elbow"/"orthogonal"/"折线"（= 直角折线）或 "rounded"/"圆角"/"圆角折线"
 * （= 只在折点处倒角），都归一到内核的 `styleWithLineKind` 认得的那四个值上。
 */
function normalizeLineKind(value, where) {
  const v = String(value).toLowerCase().trim()
  if (v === 'straight' || v === 'line' || v === 'direct' || v === '直线') return 'straight'
  if (v === 'sharp' || v === 'orthogonal' || v === 'elbow' || v === '折线' || v === '正交' || v === '直角折线') return 'sharp'
  if (v === 'rounded' || v === 'round' || v === '圆角' || v === '圆角折线') return 'rounded'
  if (v === 'curved' || v === 'curve' || v === 'arc' || v === '曲线' || v === '弧线') return 'curved'
  throw new Error(where + ': unknown line "' + value + '"; use straight, sharp, rounded, curved')
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
  //
  // 带一个缺省图层：落盘时写出来的就是 `<mxCell id="1" parent="0" />`（与 drawio 一致，
  // 字节不变），而**内存里的形状与"落盘后再打开"一致** —— 否则新建出来的画布在图层面板里
  // 会显示"没有图层信息"，一存一开又有了。
  return {
    version: 2,
    revision: '',
    meta: { layout: 'dagre-tb' },
    nodes: [],
    edges: [],
    layers: [{ id: '1', name: '', visible: true, locked: false }],
  }
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
    // 纸张尺寸同理（丢了就悄悄变回 A4 缺省，谁都不会发现）。
    ...(doc.page !== undefined ? { page: doc.page } : {}),
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
 * `fontColor` 糖 → drawio 的 `fontColor` 键值。
 *
 * 三种写法都收（与画布上"文字换色"那一套对齐）：
 *   · 调色板名（plain/blue/red…）→ 取**文字色**那一支（`styleWithTextColorName`，与独立文字的
 *     配色落点是同一个值，否则同一个名字在菜单里和 AI 手里会是两种颜色）；
 *   · 任何别的非空字符串（`#b85450`、`rgb(...)`、CSS 名）→ 原样写（drawio 也是原样存）；
 *   · `null` / 空串 → 删键回缺省（drawio 缺省是黑字）。
 */
function fontColorValue(raw, where) {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (text.length === 0) return null
  const names = paletteNames()
  if (names.indexOf(text) >= 0) {
    const probe = styleWithTextColorName(DEFAULT_NODE_STYLE, text)
    const hex = styleGet(probe, 'fontColor', null)
    // 'plain' 就是"回缺省字色" = 删键。
    return hex === null ? null : hex
  }
  if (where !== undefined && /^[a-z]+$/i.test(text)) {
    // 纯字母但不在调色板里：多半是把颜色名写错了（'gren'）。报错比静默写一个 drawio 不认的字面值好。
    throw new Error(where + ': unknown font color "' + text + '"; use a palette name (' + names.join(', ') + ') or a hex value like #b85450')
  }
  return text
}

/**
 * 派生给模型看的**字色**：命中调色板就给名字（AI 好读），认不出的十六进制给原值。
 * 缺省黑字（没写键、或写的就是缺省）返回 undefined —— 与派生 color 的规矩一致（缺省不报）。
 */
function fontColorFieldOf(style) {
  const name = textColorNameFromStyle(style)
  if (name !== null && name !== 'plain') return name
  const raw = styleGet(style, 'fontColor', null)
  if (raw !== null && raw !== DEFAULT_FONT) return raw
  return undefined
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
  if (typeof op.style === 'string' && op.style.length > 0) {
    // 文字元素（独立文字）没有填充与描边：给它调色板名要落到 **fontColor** 上，
    // 否则 AI 说 style:"red"、屏幕上一个像素都不变（而且文件里还多两个没用的键）。
    if (nodeShapeFromStyle(out) === 'text' && op.style.indexOf('=') < 0 && op.style.indexOf(';') < 0) {
      const named = styleWithTextColorName(out, op.style)
      if (named === out && textColorNameFromStyle(out) !== op.style) {
        throw new Error(
          where + ': unknown style "' + op.style + '"; use a palette name (' + paletteNames().join(', ') + ') for the text color',
        )
      }
      out = named
    } else {
      out = styleValueFromOp(out, op.style, where)
    }
  }
  // 字号：`fontSize` 是 drawio 的键，节点标签与独立文字都吃它（null = 删键回缺省）。
  if (has(op, 'fontSize')) out = stylePatch(out, { fontSize: op.fontSize === null ? null : String(op.fontSize) })
  // 字色：`fontColor`（节点标签、独立文字都吃它）。调色板名按"文字换色"那一套取色。
  if (has(op, 'fontColor')) out = stylePatch(out, { fontColor: fontColorValue(op.fontColor, where + ' fontColor') })
  if (has(op, 'keys')) out = stylePatch(out, styleKeysFromOp(op.keys, where))
  return out
}

/**
 * 连线的"曲线"要看得见，就得有一个中点。
 *
 * drawio 的曲线是把**现有走线**抹圆（mxPolyline.paintCurvedLine）；两点直连时控制点落在起点上，
 * 于是退化成直线 —— 屏幕上什么都看不出来。所以给这种边补一个**垂直弓形的中点**，
 * 与人在画布上手动拖一个中点出来是同一件事（文件里就是普通的折点，drawio 打开一样）。
 *
 * 取两端落点：连着节点用节点中心，悬空端用自由点。弓高 = 长度的 12%，至少 20px，吸附到半格。
 */
function arcWaypointFor(doc, edge) {
  const endOf = (which) => {
    const nodeId = which === 'source' ? edge.from : edge.to
    const free = which === 'source' ? edge.sourcePoint : edge.targetPoint
    if (typeof nodeId === 'string') {
      for (let i = 0; i < doc.nodes.length; i += 1) {
        const n = doc.nodes[i]
        if (String(n.id) !== nodeId) continue
        return { x: numberOr(n.x, 0) + numberOr(n.w, DEFAULT_W) / 2, y: numberOr(n.y, 0) + numberOr(n.h, DEFAULT_H) / 2 }
      }
    }
    if (free !== null && free !== undefined && Number.isFinite(Number(free.x)) && Number.isFinite(Number(free.y))) {
      return { x: Number(free.x), y: Number(free.y) }
    }
    return null
  }
  const a = endOf('source')
  const b = endOf('target')
  if (a === null || b === null) return null
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (!(len > 1)) return null
  const unit = 5 // 与画布一致：折点的最小单位是半格
  const bow = Math.max(20, Math.round((len * 0.12) / unit) * unit)
  return {
    x: Math.round(((a.x + b.x) / 2 - (dy / len) * bow) / unit) * unit,
    y: Math.round(((a.y + b.y) / 2 + (dx / len) * bow) / unit) * unit,
  }
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
  // 线型糖：直线 / 折线 / 曲线（drawio 的 Straight / Orthogonal / Curved 三个键组合）。
  // `edgeStyle`（orthogonalEdgeStyle|none）仍然保留 —— 它是键级的写法，line 是它的语义写法。
  if (has(op, 'line')) out = styleWithLineKind(out, normalizeLineKind(op.line, where))
  if (typeof op.edgeStyle === 'string') out = stylePatch(out, { edgeStyle: op.edgeStyle })
  if (has(op, 'avoid')) out = styleWithAvoid(out, op.avoid === true)
  // 字号：连线的文字（边自己的 value 与挂在边上的标签单元）都是 `fontSize`。
  if (has(op, 'fontSize')) out = stylePatch(out, { fontSize: op.fontSize === null ? null : String(op.fontSize) })
  // 字色：连线上的文字（边自己的 value、以及挂在边上的标签单元）都吃 `fontColor`。
  if (has(op, 'fontColor')) out = stylePatch(out, { fontColor: fontColorValue(op.fontColor, where + ' fontColor') })
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
  /**
   * 本次调用里的**别名**（`addNode`/`addEdge` 的 `as`）。
   *
   * 为什么要有：id 省略时是自动分配的（n7、e3…），模型在**同一个 ops 数组**里没法引用
   * "刚建的那个" —— 只能猜下一个编号；画布上已经有 n1..n5 时就猜错，只能等报错再重试。
   * 有了别名，`{op:'addNode', label:'开始', as:'start'}` 之后就能直接 `{op:'addEdge', from:'start'}`。
   */
  const aliases = new Map()
  /**
   * 本次调用真的建了/改了/删了哪些 id。
   *
   * 以前只有 summary 文本（"+ node n7 ..."）—— 模型要用这个 id 就得去解析自然语言。
   * 现在结构化回给它（`diagram_apply` 的 output schema 里有 created/changed/removed）。
   */
  const created = []
  const changed = []
  const removed = []
  function recordCreated(id, type, label) {
    for (let i = 0; i < created.length; i += 1) if (created[i].id === id) return
    created.push(typeof label === 'string' && label.length > 0 ? { id: id, type: type, label: label } : { id: id, type: type })
  }
  function recordChanged(id) {
    if (changed.indexOf(id) < 0) changed.push(id)
  }
  function findNode(id) {
    for (let i = 0; i < doc.nodes.length; i += 1) if (doc.nodes[i].id === id) return i
    return -1
  }
  function findEdge(id) {
    for (let i = 0; i < doc.edges.length; i += 1) if (doc.edges[i].id === id) return i
    return -1
  }
  /** 别名先解析成真 id（别名指"这次调用里刚建的那个"，不指别的东西）。 */
  function resolveId(raw) {
    return typeof raw === 'string' && aliases.has(raw) ? aliases.get(raw) : raw
  }
  function known() {
    const ids = []
    for (let i = 0; i < doc.nodes.length; i += 1) ids.push(doc.nodes[i].id)
    const base = ids.length === 0 ? '(none)' : ids.join(', ')
    if (aliases.size === 0) return base
    const pairs = []
    aliases.forEach((id, name) => pairs.push(name + '→' + id))
    return base + '（本次调用里的别名：' + pairs.join(', ') + '）'
  }
  /** 只涉及连线的 op 报错时列边不列节点（拿节点 id 去重接边时，看节点列表没有帮助）。 */
  function knownEdges() {
    const ids = []
    for (let i = 0; i < doc.edges.length; i += 1) ids.push(doc.edges[i].id)
    return ids.length === 0 ? '(none)' : ids.join(', ')
  }
  /**
   * `ids: [...]` 与 `id` 两种写法归一成一个数组（批量改样式/改标签/移动/删除都要）。
   *
   * 为什么值得有：用户说"把这几个换成绿色"时，AI 看到的是 12 个 id —— 逐个发 op 只是
   * 让模型多写 11 遍同样的参数，多一份写错的机会。
   */
  function idList(op, index, what) {    if (Array.isArray(op.ids) && op.ids.length > 0) {
      const ids = []
      for (let k = 0; k < op.ids.length; k += 1) {
        const v = op.ids[k]
        if (typeof v !== 'string' || v.length === 0) throw new Error('ops[' + index + '] ' + what + ': "ids" must be non-empty strings')
        ids.push(resolveId(v))
      }
      if (op.id !== undefined) throw new Error('ops[' + index + '] ' + what + ': give either "id" or "ids", not both')
      return ids
    }
    const one = typeof op.id === 'string' && op.id.length > 0 ? resolveId(op.id) : undefined
    if (one === undefined) throw new Error('ops[' + index + '] ' + what + ' needs string "id" or string array "ids"')
    return [one]
  }

  function layerList() {
    return Array.isArray(doc.layers) ? doc.layers : []
  }
  /** 报错时把可选项列出来（层名可能为空，那就报 id）。 */
  function layerDescription() {
    const list = layerList()
    if (list.length === 0) return '(没有图层信息)'
    const parts = []
    for (let i = 0; i < list.length; i += 1) {
      const l = list[i]
      const name = typeof l.name === 'string' && l.name.length > 0 ? l.name : '(无名)'
      parts.push(name + '#' + String(l.id) + (l.visible === false ? ' 🚫' : ''))
    }
    return parts.join(', ')
  }
  /**
   * 把"层 id 或层名"解析成层 id。
   *
   * 为什么两种都收：`diagram_read` 回的是层表（名字 + id），用户说"放到'标注'层"时模型手里
   * 只有名字，而文件里挂单元用的是 id。别名（`addLayer … as:"x"`）也在这里解析。
   */
  function resolveLayerRef(raw, where) {
    const ref = typeof raw === 'string' && aliases.has(raw) ? aliases.get(raw) : raw
    const list = layerList()
    if (list.length === 0) throw new Error(where + ': 这份文档没有图层信息（layers 为空）')
    for (let i = 0; i < list.length; i += 1) if (String(list[i].id) === ref) return String(list[i].id)
    for (let i = 0; i < list.length; i += 1) {
      const name = typeof list[i].name === 'string' ? list[i].name : ''
      if (name.length > 0 && name === ref) return String(list[i].id)
    }
    throw new Error(where + ': unknown layer "' + ref + '". Layers: ' + layerDescription())
  }
  /** 别名注册（addNode/addEdge/addLayer/duplicate 共用）：撞已有 id、已有层名、已用别名都直接报错。 */
  function registerAlias(name, id, where) {
    if (typeof name !== 'string' || name.length === 0) return
    if (aliases.has(name)) throw new Error(where + ': alias "' + name + '" is already used by ' + aliases.get(name))
    if (findNode(name) >= 0 || findEdge(name) >= 0) throw new Error(where + ': alias "' + name + '" collides with an existing id')
    const list = layerList()
    for (let i = 0; i < list.length; i += 1) {
      const layerName = typeof list[i].name === 'string' ? list[i].name : ''
      if (String(list[i].id) === name || (layerName.length > 0 && layerName === name)) {
        throw new Error(where + ': alias "' + name + '" collides with a layer')
      }
    }
    aliases.set(name, id)
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
      // 别名：给这个名字之后就能在同一个 ops 数组里引用它（见 applyOps 开头的注释）。
      registerAlias(op.as, id, 'ops[' + i + '] addNode')
      const node = {
        id: id,
        label: label,
        // 形状/配色是糖，落盘只有 style 键；不给就是 drawio 缺省（空串 = 普通矩形 + 缺省配色）。
        style: nodeStyleFromOp(DEFAULT_NODE_STYLE, op, 'ops[' + i + '] addNode'),
        w: numberOr(op.w, estimateWidth(label)),
        h: numberOr(op.h, DEFAULT_H),
      }
      if (typeof op.layer === 'string' && op.layer.length > 0) node.layer = resolveLayerRef(op.layer, 'ops[' + i + '] addNode layer')
      // 关键：只有显式给了坐标才写入。缺省写 (0,0) 会让 placeMissing 以为"坐标齐全"而不补位，
      // 新节点就会堆在原点压住别人。
      if (has(op, 'x')) node.x = numberOr(op.x, 0)
      if (has(op, 'y')) node.y = numberOr(op.y, 0)
      doc.nodes.push(node)
      recordCreated(id, 'node', label)
      notes.push('+ node ' + id + ' "' + label + '"' + (has(op, 'x') || has(op, 'y') ? ' at explicit coords' : ' (position pending)'))
      continue
    }

    if (kind === 'addEdge') {
      const from = typeof op.from === 'string' ? resolveId(op.from) : undefined
      const to = typeof op.to === 'string' ? resolveId(op.to) : undefined
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
      if (typeof op.as === 'string' && op.as.length > 0) {
        registerAlias(op.as, id, 'ops[' + i + '] addEdge')
      }
      const edge = { id: id }
      // 新单元进哪一层：不给就由写回按缺省层处理（宿主看不到客户端的"当前层"，
      // 所以 AI 想让它进某一层必须显式说 —— 层 id 或层名都收）。
      if (typeof op.layer === 'string' && op.layer.length > 0) edge.layer = resolveLayerRef(op.layer, 'ops[' + i + '] addEdge layer')
      if (from !== undefined) edge.from = from
      if (to !== undefined) edge.to = to
      // 自由点只在那一端**没有真实顶点**时生效（drawio 语义，与内核的 edgeFreePoint 一致）。
      if (from === undefined && fromPoint !== null) edge.sourcePoint = fromPoint
      if (to === undefined && toPoint !== null) edge.targetPoint = toPoint
      if (typeof op.label === 'string' && op.label.length > 0) edge.label = op.label
      // 建边时就能带上画法：AI 想表达"这是一条异步/可选依赖"时，
      // 不该被迫先 addEdge 再补一次 setStyle（两次写盘、两次往返）。
      edge.style = edgeStyleFromOp(DEFAULT_EDGE_STYLE, op, 'ops[' + i + '] addEdge')
      // 线型是"语义 + 几何"两件事：直线不带折点（新边本来就没有）；曲线要看得见就得有个中点
      // （见 arcWaypointFor —— 两点直连的曲线在 drawio 里会退化成一条直线）。
      if (has(op, 'line') && normalizeLineKind(op.line, 'ops[' + i + '] addEdge') === 'curved') {
        const bow = arcWaypointFor(doc, edge)
        if (bow !== null) edge.points = [bow]
      }
      doc.edges.push(edge)
      recordCreated(id, 'edge', typeof edge.label === 'string' ? edge.label : undefined)
      const head = from !== undefined ? from : '(free ' + fromPoint.x + ',' + fromPoint.y + ')'
      const tail = to !== undefined ? to : '(free ' + toPoint.x + ',' + toPoint.y + ')'
      notes.push('+ edge ' + id + ' ' + head + ' -> ' + tail + styleNote(edge.style))
      continue
    }

    if (kind === 'duplicate') {
      // 复制一组单元（Ctrl+C/V 的工具版）：**新 id、整体平移**，而折点、端点约束、标签位置、
      // 自定义数据全都照旧带过去。
      //
      // 以前 AI 想"再来一份"只能重新 addNode + addEdge —— 折点、端点约束、label 位置全丢，
      // 而且新边还得自己重连一遍。
      const ids = idList(op, i, 'duplicate')
      // 与画布上的 Ctrl+V 同一套位移：两格（2 × 10px），不然复制出来的会正好压在原图上。
      const dx = Number.isFinite(Number(op.dx)) ? Number(op.dx) : DUPLICATE_OFFSET
      const dy = Number.isFinite(Number(op.dy)) ? Number(op.dy) : DUPLICATE_OFFSET
      // 默认把"两端都在被复制节点之间"的边一起复制 —— 用户说"复制这个子图"时指的就是它；
      // withEdges:false 只要节点。
      const withEdges = op.withEdges !== false
      const layer = typeof op.layer === 'string' && op.layer.length > 0 ? resolveLayerRef(op.layer, 'ops[' + i + '] duplicate layer') : undefined
      const srcNodes = []
      const srcEdges = []
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          srcNodes.push(doc.nodes[ni])
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          srcEdges.push(doc.edges[ei])
          continue
        }
        throw new Error('ops[' + i + '] duplicate: unknown id "' + id + '". Known nodes: ' + known())
      }
      if (typeof op.as === 'string' && op.as.length > 0 && srcNodes.length !== 1) {
        throw new Error('ops[' + i + '] duplicate: "as" 只在复制**单个节点**时可用（一组没有唯一的新 id 可指）')
      }
      if (srcNodes.length === 0) {
        // 只复制连线：接在节点上的边不行 —— 新边会继续指着**原来的**节点，那不是"复制"。
        for (let k = 0; k < srcEdges.length; k += 1) {
          const e = srcEdges[k]
          if (typeof e.from === 'string' && typeof e.to === 'string') {
            throw new Error(
              'ops[' + i + '] duplicate: edge "' + e.id + '" 两端都接在节点上 —— 把它的两端节点一起写进 ids（否则新边还指着原来的节点）',
            )
          }
        }
      }
      const remap = {}
      for (let k = 0; k < srcNodes.length; k += 1) {
        const src = srcNodes[k]
        const id = nextId(doc.nodes, 'n')
        remap[String(src.id)] = id
        // 整份浅拷 + 改写 id 与新位置：label/style/w/h/data/layer 都在里面。
        const copy = Object.assign({}, src, {
          id: id,
          x: Math.round(numberOr(src.x, 0) + dx),
          y: Math.round(numberOr(src.y, 0) + dy),
        })
        if (layer !== undefined) copy.layer = layer
        doc.nodes.push(copy)
        recordCreated(id, 'node', typeof copy.label === 'string' ? copy.label : undefined)
        notes.push('+ node ' + id + '（复制自 ' + src.id + '）')
      }
      const wantEdges = srcEdges.slice()
      if (withEdges && srcNodes.length > 0) {
        for (let k = 0; k < doc.edges.length; k += 1) {
          const e = doc.edges[k]
          // 两端都在新节点里就带上（自环 from === to 也自然算在内）
          if (remap[String(e.from)] === undefined || remap[String(e.to)] === undefined) continue
          let already = false
          for (let j = 0; j < wantEdges.length; j += 1) if (wantEdges[j].id === e.id) already = true
          if (already === false) wantEdges.push(e)
        }
      }
      for (let k = 0; k < wantEdges.length; k += 1) {
        const src = wantEdges[k]
        const from = src.from === undefined ? undefined : remap[String(src.from)]
        const to = src.to === undefined ? undefined : remap[String(src.to)]
        if (src.from !== undefined && from === undefined) {
          throw new Error('ops[' + i + '] duplicate: edge "' + src.id + '" 的起点 ' + src.from + ' 不在被复制的节点里（把两端一起复制）')
        }
        if (src.to !== undefined && to === undefined) {
          throw new Error('ops[' + i + '] duplicate: edge "' + src.id + '" 的终点 ' + src.to + ' 不在被复制的节点里（把两端一起复制）')
        }
        const id = nextId(doc.edges, 'e')
        const copy = Object.assign({}, src, { id: id })
        if (from !== undefined) copy.from = from
        if (to !== undefined) copy.to = to
        if (layer !== undefined) copy.layer = layer
        // 折点与自由端点**深拷**并跟着位移：共用数组是这类复制最经典的坑
        //（改一份另一份跟着变，客户端 pasteInto 里也专门盯着它）。
        if (Array.isArray(src.points)) copy.points = src.points.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }))
        if (src.sourcePoint !== undefined && src.sourcePoint !== null) {
          copy.sourcePoint = { x: Math.round(src.sourcePoint.x + dx), y: Math.round(src.sourcePoint.y + dy) }
        }
        if (src.targetPoint !== undefined && src.targetPoint !== null) {
          copy.targetPoint = { x: Math.round(src.targetPoint.x + dx), y: Math.round(src.targetPoint.y + dy) }
        }
        doc.edges.push(copy)
        recordCreated(id, 'edge', typeof copy.label === 'string' ? copy.label : undefined)
        notes.push('+ edge ' + id + '（复制自 ' + src.id + '）')
      }
      if (typeof op.as === 'string' && op.as.length > 0 && srcNodes.length === 1) {
        registerAlias(op.as, remap[String(srcNodes[0].id)], 'ops[' + i + '] duplicate')
      }
      continue
    }

    if (kind === 'move') {
      const ids = idList(op, i, 'move')
      const hasX = Number.isFinite(Number(op.x))
      const hasY = Number.isFinite(Number(op.y))
      const dx = Number.isFinite(Number(op.dx)) ? Number(op.dx) : 0
      const dy = Number.isFinite(Number(op.dy)) ? Number(op.dy) : 0
      if (hasX === false && hasY === false && dx === 0 && dy === 0) {
        throw new Error('ops[' + i + '] move needs "x"/"y" (absolute) or a non-zero "dx"/"dy"')
      }
      // 批量移动只认相对位移：给一组 id + 一个绝对 x/y 等于"把它们全叠到同一个点上"，
      // 几乎不可能是本意（那是 N 个节点压成一摞），所以直接拒绝而不是猜。
      if (ids.length > 1 && (hasX || hasY)) {
        throw new Error('ops[' + i + '] move: with "ids" use "dx"/"dy" (one absolute x/y would stack them all on the same point)')
      }
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        // 节点：绝对坐标（给 x/y）或相对位移（给 dx/dy）都行。
        // 以前只能"删掉重画"来改位置 —— 那会丢 id、丢边上的端点约束与折点，是实打实的损失。
        const ni = findNode(id)
        if (ni >= 0) {
          const n = doc.nodes[ni]
          n.x = Math.round(hasX ? Number(op.x) : numberOr(n.x, 0) + dx)
          n.y = Math.round(hasY ? Number(op.y) : numberOr(n.y, 0) + dy)
          recordChanged(id)
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
        recordChanged(id)
        notes.push('~ edge ' + id + ' moved by ' + dx + ',' + dy + (touched === 0 ? '（它两端都接在节点上、也没有折点，等于没有可平移的几何）' : ''))
      }
      continue
    }

    if (kind === 'order') {
      // 顺序（z-order）：模型数组里的先后 = 画布上的覆盖顺序 = 文件里单元的先后。
      // 与画布右键的「置顶/上移/下移/置底」完全同一套语义（见客户端 reorderItem）。
      //
      // 为什么 AI 需要它：**所有边都画在所有节点下面**（画布目前的层叠限制），
      // "让这条边压在那几个节点上面"只能靠图层，而图层 ops 还没有 —— 至少先把
      // 同一类之间的顺序（谁压谁）交给 AI。
      const ids = idList(op, i, 'order')
      const to = typeof op.to === 'string' ? op.to : undefined
      if (ORDER_MODES.indexOf(to) < 0) {
        throw new Error('ops[' + i + '] order needs "to": ' + ORDER_MODES.join('|') + '（后面的在上面）')
      }
      if (ids.length > 1 && to !== 'front' && to !== 'back') {
        throw new Error('ops[' + i + '] order: 一组只能用 front/back（up/down 是"挪一层"，一组里谁先谁后说不清）')
      }
      // 节点与连线是**两条**序列（文件里它们可能交错，但模型与画布都按各自的序列层叠）。
      let target = null
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        const ei = findEdge(id)
        if (ni < 0 && ei < 0) throw new Error('ops[' + i + '] order: unknown id "' + id + '". Known nodes: ' + known())
        const which = ni >= 0 ? 'node' : 'edge'
        if (target === null) target = which
        else if (target !== which) throw new Error('ops[' + i + '] order: 一次只能排同一类单元（节点和连线是两条序列）')
      }
      const list = target === 'node' ? doc.nodes : doc.edges
      if (to === 'up' || to === 'down') {
        const id = ids[0]
        let at = -1
        for (let k = 0; k < list.length; k += 1) {
          if (list[k].id === id) {
            at = k
            break
          }
        }
        const item = list.splice(at, 1)[0]
        // 与客户端同一套：at 是"拔出来之前"的位置，插回时按它 +1 / -1 并夹在范围内。
        if (to === 'up') list.splice(Math.min(at + 1, list.length), 0, item)
        else list.splice(Math.max(at - 1, 0), 0, item)
      } else {
        // 一组：先按它们在序列里的原顺序取出来，再整体放到头/尾 —— 组内相对顺序不变
        //（"把这三条边置顶"不该顺手把它们互换个位置）。
        const picked = []
        for (let k = list.length - 1; k >= 0; k -= 1) if (ids.indexOf(list[k].id) >= 0) picked.unshift(list.splice(k, 1)[0])
        if (to === 'front') for (let k = 0; k < picked.length; k += 1) list.push(picked[k])
        else for (let k = picked.length - 1; k >= 0; k -= 1) list.unshift(picked[k])
        for (let k = 0; k < ids.length; k += 1) recordChanged(ids[k])
        notes.push('~ order: ' + ids.join(', ') + ' → ' + to + '（' + (target === 'node' ? '节点' : '连线') + '共 ' + list.length + ' 个）')
        continue
      }
      recordChanged(ids[0])
      notes.push('~ order: ' + ids[0] + ' → ' + to)
      continue
    }

    if (kind === 'setEdge') {
      // 重接一条边：只改 source/target（或某一端的自由点），**其它一切照旧** ——
      // id、标签、标签位置、折点、端点约束（exitX/entryX）都留着。
      // 以前只能 remove + addEdge 重画，那会把这些全丢掉。
      const ids = idList(op, i, 'setEdge')
      if (ids.length !== 1) throw new Error('ops[' + i + '] setEdge: 一次改一条边，给单个 "id"')
      const id = ids[0]
      const ei = findEdge(id)
      if (ei < 0) throw new Error('ops[' + i + '] setEdge: unknown edge "' + id + '". Known edges: ' + knownEdges())
      const edge = doc.edges[ei]
      let touched = 0
      // 两端各处理一次：`from`（节点 id）/`fromPoint`（绝对点）二选一，`to`/`toPoint` 同理。
      for (let end = 0; end < 2; end += 1) {
        const isSource = end === 0
        const nodeKey = isSource ? 'from' : 'to'
        const pointKey = isSource ? 'fromPoint' : 'toPoint'
        const pointAlias = isSource ? 'sourcePoint' : 'targetPoint'
        const freeKey = isSource ? 'sourcePoint' : 'targetPoint'
        const rawPoint = op[pointKey] !== undefined ? op[pointKey] : op[pointAlias]
        const nodeDeclared = has(op, nodeKey)
        const rawNode = op[nodeKey]
        // 明确写 `from: null` / `to: null` = "这一端不接节点"（模型表达"脱开"的自然写法）。
        const hasNode = nodeDeclared && rawNode !== null
        const hasPoint = rawPoint !== undefined && rawPoint !== null
        if (nodeDeclared === true && rawNode === null && hasPoint === false) {
          throw new Error(
            'ops[' + i + '] setEdge: ' + nodeKey + ' 给 null 表示"这一端不接节点"，那就要一起给 ' + pointKey + '（自由端得有坐标）',
          )
        }
        if (hasNode === false && hasPoint === false) continue
        if (hasNode === true && hasPoint === true) {
          throw new Error('ops[' + i + '] setEdge: ' + nodeKey + ' 与 ' + pointKey + ' 只能给一个（接节点还是接一个自由点）')
        }
        if (hasNode === true) {
          const ref = rawNode
          if (typeof ref !== 'string' || ref.length === 0) {
            throw new Error('ops[' + i + '] setEdge: ' + nodeKey + ' 要么是节点 id，要么给 null + ' + pointKey + '（脱开节点需要有坐标）')
          }
          const nodeId = resolveId(ref)
          if (findNode(nodeId) < 0) throw new Error('ops[' + i + '] setEdge: unknown "' + nodeKey + '" node "' + nodeId + '". Known nodes: ' + known())
          if (isSource) edge.from = nodeId
          else edge.to = nodeId
          // 那一端接上节点之后，旧的自由点必须删掉：drawio 的规矩是"有真实顶点时忽略自由点"，
          // 留着不会显示，但会在文件里留一条过期几何，下次换个工具打开就是脏数据。
          delete edge[freeKey]
          touched += 1
          continue
        }
        const point = edgePointFromOp(rawPoint, 'ops[' + i + '] setEdge ' + pointKey)
        if (point === null) throw new Error('ops[' + i + '] setEdge: ' + pointKey + ' 需要 {x, y}')
        delete edge[nodeKey]
        edge[freeKey] = point
        touched += 1
      }
      if (touched === 0) throw new Error('ops[' + i + '] setEdge needs "from"/"to" (node id) or "fromPoint"/"toPoint" (absolute point)')
      const head = typeof edge.from === 'string' ? edge.from : '(free ' + edge.sourcePoint.x + ',' + edge.sourcePoint.y + ')'
      const tail = typeof edge.to === 'string' ? edge.to : '(free ' + edge.targetPoint.x + ',' + edge.targetPoint.y + ')'
      const kept = []
      if (Array.isArray(edge.points) && edge.points.length > 0) kept.push(edge.points.length + ' 个折点')
      if (typeof edge.label === 'string' && edge.label.length > 0) kept.push('标签')
      recordChanged(id)
      notes.push('~ edge ' + id + ' 改接为 ' + head + ' -> ' + tail + (kept.length > 0 ? '（' + kept.join('、') + '照旧）' : ''))
      continue
    }

    if (kind === 'setLabelPos') {
      // 边上的文字在**画布上的位置**。drawio 存法：边几何的 x = 沿边比例（-1..1，0 = 弧长中点）、
      // y = 垂直偏移 px、`<mxPoint as="offset">` = 取整剩下的零头（见 mxfile 的 relativeLabelPos）。
      //
      // 客户端能按住线上的字拖，AI 却既看不见位置、也改不了 —— "文字压住线"这种小毛病
      // 原来只能让用户自己动手。现在：read 回 x/y，改给 setLabelPos。
      const id = typeof op.id === 'string' && op.id.length > 0 ? resolveId(op.id) : undefined
      if (id === undefined) throw new Error('ops[' + i + '] setLabelPos needs string "id"')
      const ei = findEdge(id)
      if (ei < 0) throw new Error('ops[' + i + '] setLabelPos: unknown edge "' + id + '". Known edges: ' + knownEdges())
      const edge = doc.edges[ei]
      // center：放回弧长中点（= 删掉位置，与画布右键「标签居中」同一件事）。
      if (op.center === true) {
        delete edge.labelX
        delete edge.labelY
        delete edge.labelOffsetX
        delete edge.labelOffsetY
        recordChanged(id)
        notes.push('~ edge ' + id + ' 标签放回弧长中点')
        continue
      }
      const hasX = Number.isFinite(Number(op.x))
      const hasY = Number.isFinite(Number(op.y))
      const dx = Number.isFinite(Number(op.dx)) ? Number(op.dx) : 0
      const dy = Number.isFinite(Number(op.dy)) ? Number(op.dy) : 0
      const hasOffX = Number.isFinite(Number(op.offsetX))
      const hasOffY = Number.isFinite(Number(op.offsetY))
      if (hasX === false && hasY === false && dx === 0 && dy === 0 && hasOffX === false && hasOffY === false) {
        throw new Error('ops[' + i + '] setLabelPos needs "x"/"y" (absolute, relative to the path) or "dx"/"dy" (nudge) or center:true')
      }
      const curX = Number.isFinite(Number(edge.labelX)) ? Number(edge.labelX) : 0
      const curY = Number.isFinite(Number(edge.labelY)) ? Number(edge.labelY) : 0
      const nextX = hasX ? Number(op.x) : curX + dx
      if (nextX < -1 || nextX > 1) {
        throw new Error('ops[' + i + '] setLabelPos: "x" 是**沿边比例**（-1..1，0 = 中点），要按像素挪动请用 dy')
      }
      // x 收四位小数（与客户端拖动时同一套存法）；y 取整。
      edge.labelX = Math.round(nextX * 10000) / 10000
      edge.labelY = Math.round(hasY ? Number(op.y) : curY + dy)
      // 零头只在显式给的时候写：它是"客户端拖到某个像素后取整剩下的那点偏移"，
      // 我们按 x/y 设定位置时留着它会把落点带偏（真实位置 = x/y + offset）。
      if (hasOffX || hasOffY) {
        const offX = hasOffX ? Math.round(Number(op.offsetX)) : numberOr(edge.labelOffsetX, 0)
        const offY = hasOffY ? Math.round(Number(op.offsetY)) : numberOr(edge.labelOffsetY, 0)
        if (offX === 0) delete edge.labelOffsetX
        else edge.labelOffsetX = offX
        if (offY === 0) delete edge.labelOffsetY
        else edge.labelOffsetY = offY
      } else {
        delete edge.labelOffsetX
        delete edge.labelOffsetY
      }
      recordChanged(id)
      notes.push('~ edge ' + id + ' 标签位置 x=' + edge.labelX + '（沿边比例）y=' + edge.labelY + 'px')
      continue
    }

    if (kind === 'addLayer') {
      // 新建一层（加在最上面）。有了它 + setLayer，"把这一组放到新图层"才做得到 ——
      // 以前 AI 看得到层表却一层都加不了。
      const list = layerList()
      const used = {}
      for (let k = 0; k < list.length; k += 1) used[String(list[k].id)] = true
      let id = undefined
      if (typeof op.id === 'string' && op.id.length > 0) {
        if (used[op.id] === true) throw new Error('ops[' + i + '] addLayer: layer id "' + op.id + '" already exists')
        id = op.id
      } else {
        // 与 drawio 一致地挑一个数字串 id（最小的空缺），避开已用的。
        let n = 1
        while (used[String(n)] === true) n += 1
        id = String(n)
      }
      const name = typeof op.name === 'string' ? op.name : ''
      doc.layers = list.concat([{ id: id, name: name, visible: op.visible !== false, locked: op.locked === true }])
      registerAlias(op.as, id, 'ops[' + i + '] addLayer')
      recordCreated(id, 'layer', name)
      notes.push('+ layer ' + id + (name.length > 0 ? ' "' + name + '"' : '') + '（加在最上面；新单元要显式写 layer 才进这一层）')
      continue
    }

    if (kind === 'setLayer') {
      // 把已有单元**移到**另一层（层 id 或层名）。客户端 v2 的"把选中移到别的层"，
      // AI 侧就是这一条 —— 隐藏/锁定别的层与它配合才能"只看一部分"。
      const ids = idList(op, i, 'setLayer')
      const ref = typeof op.layer === 'string' && op.layer.length > 0 ? op.layer : undefined
      if (ref === undefined) throw new Error('ops[' + i + '] setLayer needs string "layer"（层 id 或层名）')
      const layerId = resolveLayerRef(ref, 'ops[' + i + '] setLayer')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          doc.nodes[ni].layer = layerId
          recordChanged(id)
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          doc.edges[ei].layer = layerId
          recordChanged(id)
          continue
        }
        throw new Error('ops[' + i + '] setLayer: unknown node or edge "' + id + '". Known nodes: ' + known())
      }
      notes.push('~ ' + ids.length + ' 个单元移到图层 ' + layerId)
      continue
    }

    if (kind === 'setLayerProps') {
      // 层的名字 / 显示 / 锁定 —— 纯文档状态（隐藏是写进文件的显示状态，不是删除）。
      const ref = typeof op.layer === 'string' && op.layer.length > 0 ? op.layer : undefined
      if (ref === undefined) throw new Error('ops[' + i + '] setLayerProps needs string "layer"（层 id 或层名）')
      const layerId = resolveLayerRef(ref, 'ops[' + i + '] setLayerProps')
      const list = layerList()
      let target = null
      for (let k = 0; k < list.length; k += 1) if (String(list[k].id) === layerId) target = list[k]
      if (target === null) throw new Error('ops[' + i + '] setLayerProps: 找不到层 ' + layerId)
      const changedKeys = []
      if (has(op, 'name')) {
        target.name = typeof op.name === 'string' ? op.name : ''
        changedKeys.push('name="' + target.name + '"')
      }
      if (has(op, 'visible')) {
        target.visible = op.visible !== false
        changedKeys.push(target.visible === false ? '隐藏' : '显示')
      }
      if (has(op, 'locked')) {
        target.locked = op.locked === true
        changedKeys.push(target.locked === true ? '锁定' : '解锁')
      }
      if (changedKeys.length === 0) throw new Error('ops[' + i + '] setLayerProps needs at least one of "name"/"visible"/"locked"')
      notes.push('~ layer ' + layerId + ' ' + changedKeys.join(' '))
      continue
    }

    if (kind === 'export') {
      // 导出这张画布（svg 落成文件、png 走浏览器下载）。
      //
      // 为什么是"请求"而不是当场生成：渲染器在浏览器那一半（正交路由、避让、圆角、断线），
      // 宿主这边只有文档。所以这里只登记意图，真正的渲染由画布在下一次轮询时完成。
      const format = typeof op.format === 'string' ? op.format.toLowerCase() : 'svg'
      if (format !== 'svg' && format !== 'png') {
        throw new Error('ops[' + i + '] export: "format" 只能是 svg 或 png（默认 svg）')
      }
      let name = typeof op.name === 'string' ? op.name.trim() : ''
      if (name.length > 0) {
        name = name.replace(/\.(svg|png)$/i, '')
        // 只收**基名**：导出永远落在 .drawio 旁边，不收路径（想放别处请先让用户另存到那儿）。
        if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
          throw new Error('ops[' + i + '] export: "name" 只能是文件基名（不含路径分隔符与非法字符）')
        }
      }
      if (out !== undefined && out !== null) out.export = { format: format, name: name }
      notes.push('⤓ 已请求导出 ' + format.toUpperCase() + (name.length > 0 ? '（' + name + '）' : '') + '：画布下一次刷新时渲染')
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
      const label = typeof op.label === 'string' ? op.label : undefined
      if (label === undefined) throw new Error('ops[' + i + '] setLabel needs string "label"')
      const ids = idList(op, i, 'setLabel')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          doc.nodes[ni].label = label
          recordChanged(id)
          notes.push('~ node ' + id + ' label = "' + label + '"')
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          doc.edges[ei].label = label
          recordChanged(id)
          notes.push('~ edge ' + id + ' label = "' + label + '"')
          continue
        }
        throw new Error('ops[' + i + '] setLabel: unknown id "' + id + '". Known nodes: ' + known())
      }
      continue
    }

    if (kind === 'setStyle') {
      const ids = idList(op, i, 'setStyle')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
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
          // 显式清折点（右键"自动路由"与 AI 都能用同一件事）。
          //
          // **自由端点不是折点**：一端没有真实顶点时，那个自由点就是这条线的落点。无条件删它，
          // "两端都自由"的独立线就一个落点都不剩 —— 写回会把它当成"两端都没有落点的边"整条跳过
          //（实测：画好的一条尾巴就这么没了，notes 里那句"已略过"没人会去看）。
          // 所以只在那一端**有真实顶点**时才删（那种情况下 drawio 本来就忽略自由点）。
          if (op.clearPoints === true) {
            delete edge.points
            if (typeof edge.from === 'string') delete edge.sourcePoint
            if (typeof edge.to === 'string') delete edge.targetPoint
          }
          // 线型带来的几何后果（与画布右键菜单同一套语义，见客户端的 applyLineKind）：
          //   直线 = 无折点：留着折点就不是直线了；
          //   曲线 = 把现有折线抹圆，而**两点直连的边**在 drawio 里曲线会退化成直线
          //   （mxPolyline.paintCurvedLine 两点时控制点落在起点上），所以补一个弓形中点。
          if (has(op, 'line')) {
            const kind = normalizeLineKind(op.line, where)
            if (kind === 'straight') delete edge.points
            else if (kind === 'curved' && (Array.isArray(edge.points) === false || edge.points.length === 0)) {
              const bow = arcWaypointFor(doc, edge)
              if (bow !== null) edge.points = [bow]
            }
          }
          recordChanged(id)
          notes.push('~ edge ' + id + ' style' + styleNote(edge.style === undefined ? base : edge.style))
          continue
        }
        const node = doc.nodes[ni]
        const nodeBase = node.style === undefined ? DEFAULT_NODE_STYLE : node.style
        const nextStyle = nodeStyleFromOp(nodeBase, op, 'ops[' + i + '] setStyle')
        if (nextStyle !== nodeBase) node.style = nextStyle
        if (has(op, 'w')) node.w = numberOr(op.w, node.w)
        if (has(op, 'h')) node.h = numberOr(op.h, node.h)
        recordChanged(id)
        notes.push('~ node ' + id + ' [' + nodeShapeFromStyle(nextStyle) + ']' + (nextStyle.length === 0 ? ' (默认样式)' : ''))
      }
      continue
    }

    if (kind === 'remove') {
      const ids = idList(op, i, 'remove')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          doc.nodes.splice(ni, 1)
          const kept = []
          let dropped = 0
          for (let j = 0; j < doc.edges.length; j += 1) {
            const e = doc.edges[j]
            if (e.from === id || e.to === id) dropped += 1
            else kept.push(e)
          }
          doc.edges = kept
          if (removed.indexOf(id) < 0) removed.push(id)
          notes.push('- node ' + id + (dropped > 0 ? ' (and ' + dropped + ' edge(s))' : ''))
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          doc.edges.splice(ei, 1)
          if (removed.indexOf(id) < 0) removed.push(id)
          notes.push('- edge ' + id)
          continue
        }
        throw new Error('ops[' + i + '] remove: unknown id "' + id + '". Known nodes: ' + known())
      }
      continue
    }

    throw new Error(
      'ops[' + i + '] unknown op ' + JSON.stringify(kind) +
        '. Supported: addNode, addEdge, setLabel, setLabelPos, setStyle, setEdge, order, duplicate, addLayer, setLayer, setLayerProps, move, remove, highlight',
    )
  }
  // 结构化返回"这次到底动了什么"：模型要用新建的 id（或确认改到了谁）时不必解析 summary 文本。
  if (out !== undefined && out !== null) {
    out.created = created
    out.changed = changed
    out.removed = removed
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
1. **diagram_read(path?, layer?, ids?)** —— 先读。返回节点（id/label/shape/style/**x·y·w·h 坐标尺寸**）、
   边（id/from/to/label/style/dash/arrow/折点/悬空端的自由点/标签位置 labelX·labelY）、
   revision（**文件内容指纹**，不是版本号）、page（**纸张尺寸**：文件里写了才有）、
   layers（**图层表**：顺序 = 叠放顺序，含 name/visible/locked）、每个单元的 layer（它在哪一层）、
   notes（画布表示不了但会原样保留的东西：多页、分组、图片、HTML 标签）、
   **selection（用户此刻选中的单元 id）**、highlight（AI 自己请求的高亮，见下）、
   canRevert / revertSteps（AI 的改动还能退回几步，见下）、export（导出状态）。
   fontColor（设过才有）是**字色**的派生名：命中调色板给名字（red/grey…），否则给十六进制。
   visible:false 的层在画布上不画，但里面的单元**照旧读得到** —— 隐藏是显示状态，不是删除；
   想让人看见就提醒用户去「图层」菜单打开。
   **大图先过滤**：layer（层 id 或层名）只看一层、ids 只看几个单元 —— 过滤时返回体会带
   filtered 与 totalNodes/totalEdges（整张有多少），层表照旧整份回。别一上来就把几百个单元读完。
2. **diagram_apply(path, ops, layout?, expectRevision?)** —— 再改。给一组结构化编辑，宿主**无损写回**：只改我们拥有的单元，
   文件其余部分（别的页、未知单元、自定义属性）逐字节保留。打开后原样保存 = 文件一个字节都不变。

不传 path 时，优先改**用户当前打开的那张画布**（客户端上报的聚焦路径），最后才退回 demo.drawio。
用户说"这张图"时通常不用传 path。改完可以再 read 一次自查。

**当前是哪一张，有两个来源**：用户在画布面板里切换标签页时，宿主会把"当前画布 = <路径>"
**注入到会话里**（你会看到一条 plugin 来源的上下文）；不放心时也不带 path 调一次
diagram_read —— 返回里的 path 就是它（这两条是一致的，同一个记录）。

**"这几个"是哪几个**：用户在画布上选中的单元会随 diagram_read 一起回来（selection）。
用户说"把这几个挪一下/换个颜色"时就用那些 id —— 别靠坐标猜。选中的是连线也一样能用
（setStyle/move/remove 都收边 id）。没人选时它是空数组。

**读到的 revision 别扔**：下次改这张图时把它当 expectRevision 传进来。对不上（用户在 drawio 里
改过、或另一个会话动过）调用会**直接失败、一个字节都不写** —— 重新 read 一次拿新指纹再改。
不传就是不检查（并发编辑时可能覆盖别人的改动，所以"读过再改"的流程里最好都传）。

## ops 速查
    {op:"addNode", label:"必填", as?, shape?, style?, keys?, w?, h?, x?, y?, fontColor?}
    {op:"addEdge", from?, to?, fromPoint?, toPoint?, as?, label?, style?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, keys?}
    {op:"setLabel", id|ids, label}
    {op:"setLabelPos", id, x?, y?, dx?, dy?, center?}
    {op:"setStyle", id|ids, shape?, style?, keys?, w?, h?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, clearPoints?}
    {op:"setEdge", id, from?, to?, fromPoint?, toPoint?}
    {op:"order", id|ids, to:"front"|"back"|"up"|"down"}
    {op:"duplicate", id|ids, dx?, dy?, withEdges?, layer?, as?}
    {op:"addLayer", name?, id?, visible?, as?}
    {op:"setLayer", id|ids, layer}
    {op:"setLayerProps", layer, name?, visible?, locked?}
    {op:"export", format?:"svg"|"png", name?}
    {op:"move", id|ids, dx?, dy?, x?, y?}
    {op:"remove", id|ids}
    {op:"highlight", ids:["n1","n2"]}

- **改接一条边用 setEdge，别 remove + addEdge 重画**：setEdge 只换 source/target（from/to 给节点 id，
  或 fromPoint/toPoint 给绝对点 = 脱开节点变成自由端），边的 **id、标签、标签位置、折点、
  端点约束（exitX/entryX）全都留着** —— 重画会把这些丢掉，还会让别的引用它的地方失效。
- **边上的文字压住线**：diagram_read 回 labelX/labelY（拖过才有；x = 沿边比例 -1..1，0 = 弧长中点、
  y = 垂直偏移 px）。{op:"setLabelPos", id, center:true} 放回中点（= 画布右键「标签居中」）；
  {op:"setLabelPos", id, dy:12} 往上/下挪 12px（dx 是比例，一般别用）。
- **顺序（谁压谁）用 order**：to 是 front（到最上面）/back/up/down，与画布右键的顺序菜单同一套。
  它改的是**文件里单元的先后**（drawio 打开也是这个层叠）。注意"所有边都画在所有节点下面"
  是画布目前的层叠限制，所以"让边压住节点"要放到更上面的**图层**里，不是 order 能解决的。
- **再来一份用 duplicate**：新 id + 整体平移（默认两格 20px，与画布 Ctrl+V 一样），
  折点、端点约束、标签位置、自定义数据都带过去。默认会把"两端都在被复制节点之间"的边一起复制
  （withEdges:false 只要节点）；只列一条接在节点上的边会被拒 —— 把两端节点一起写进 ids。
- **图层**：addLayer 新建一层（加在最上面，返回它的 id）、addNode/addEdge/duplicate 可以带 layer
  （层 id 或层名）、setLayer 把已有单元移到别的层、setLayerProps 改层的名字/显示/锁定。
  隐藏一层是**文档状态**（写进文件，drawio 打开也是隐藏的），不是删除 —— 隐藏层里的单元照旧读得到。
- **导出**：{op:"export", format:"svg"} 会让画布渲染一张 SVG 落在 .drawio 旁边（同名的 .svg，
  可以用 name 指定基名）；format:"png" 则是**浏览器下载**一张 PNG（用户下载目录里）。
  渲染在画布那一半做，所以这一步是"请求"：返回值/下一次 read 里的 export 状态
  pending → done（带文件路径）/ downloaded / failed。看到 pending 说明画布还没刷新 ——
  别反复请求，等下一次 read 再看（或提醒用户打开那张画布）。

- **改一组用 ids**：{op:"setStyle", ids:["n1","n2","n5"], style:"green"} —— setStyle / setLabel /
  move / remove 都收 ids，不要为了"把这几个改成绿色"发 12 个 op。批量 move 只收 dx/dy
  （给一个绝对 x/y 等于把它们叠成一摞，宿主会直接拒绝）。
- **引用刚建的那个用 as**：{op:"addNode", label:"开始", as:"start"} 之后，同一个 ops 数组里
  from/to/id 可以直接写 "start"。id 省略时是自动分配的（n 几/e 几），猜编号在非空画布上必错。
- **返回值里看 created/changed/removed**：新建单元的 id（含自动分配的）在这里，接着引用它们
  不必再 read 一次、也不用去解析 summary 文本。
- id 省略会自动分配（n1/n2…、e1/e2…）；addEdge 的 from/to 必须是**已存在的节点 id**，
  引用了不存在的节点会**在写盘之前**直接报错并列出已知 id。
- **线的两端可以给绝对点**（fromPoint/toPoint）而不是节点：两端都给点就是一条**独立线** ——
  drawio 里边的两端都可以是自由点，线可以完全不接节点（先画线、之后再拖端点接到节点上也行）。
  只有一端给点就是**悬空端**（另一半接在节点上）。
- **move**：改已有元素的位置。节点给 dx/dy（相对）或 x/y（绝对）；连线只能给 dx/dy
  （平移它自己的折点与自由端点；两端接在节点上时端点由节点决定）。
  一整组一起挪就写 ids:[...] + dx/dy —— 与画布上拖选区是同一套语义（相对位置一点不变）。
  以前没有 move，想把某个节点挪一下就只好删掉重画 —— 那会丢 id、丢边上的端点约束与折点。
- **line**（连线线型，四选一）：straight（直线，不带折点）| sharp（直角折线，缺省）|
  rounded（**圆角折线**：只在折点处倒圆角，rounded=1）| curved（曲线，curved=1）。
  line:"straight" 会**清掉折点**；line:"rounded" 只改样式（折点就是折线的拐角，照旧有用）；
  line:"curved" 在边本来就是两点直连时会补一个弓形中点 ——
  因为 drawio 的曲线是把**现有折线**抹圆，两点时它退化成直线（屏幕上什么都看不出来）。
  与它等价的键级写法是 edgeStyle:"none"（直线）、keys:{rounded:1}（圆角）、keys:{curved:1}（曲线）。
- **fontSize**（字号）：节点标签、独立文字、连线上的文字都吃它（drawio 的 fontSize 键）；
  给 null 就是删键回缺省。例：{op:"setStyle", id:"n1", fontSize:18}。
- **fontColor**（**字色**）：节点标签、独立文字、连线上的文字都吃它（drawio 的 fontColor 键）。
  给调色板名（plain|blue|green|orange|yellow|red|purple|grey）就按画布上"文字换色"那一支取色
  （红 = #b85450，不是填充色），给 #b85450 这类色值就原样写，给 null 删键回缺省黑字。
  例：{op:"setStyle", ids:["n1","n2"], fontColor:"#666666"}；连线上的字同理
  （color 是**线本身**的颜色，fontColor 是**字**的颜色 —— 两件事，别混）。
- **highlight** 只是"让画布选中这几个"给你看，不改文档、也不重排。
- **图层现在已经能操作了**（见上面的 addLayer/setLayer/setLayerProps）：新建一层、
  让新单元进指定层、把已有单元移到别的层、改名/显示/隐藏/锁定。
  隐藏层里的单元照旧读得到 —— 隐藏是**显示状态**，不是删除；用户想看见就提醒他去「图层」菜单打开。
- **容器/分组**：单元带 parent 就说明它在某个容器（分组）里。画布按**绝对位置**显示，
  所以 move 一个容器**不会**带走它的子单元、remove 容器则会把子单元接到还活着的祖先上 ——
  要"整组一起动"就把容器和子单元一起写进 move 的 ids 里。分组本身 AI 还不能新建。
- 糖（shape/style/dash/arrow/color/exit/entry/jettySize/edgeStyle/avoid）由宿主翻译成 drawio 的 style 键，
  **绝不落盘**；keys 用来写任意 drawio 键，值给 null = 删键回默认。
- shape：rect | rounded | **text**（独立文字：无边框无底色的一段字）| stadium | ellipse | diamond | parallelogram | cylinder | document | hexagon
  要"一段不带框的说明/标题文字"就用 addNode {shape:"text", label:"…", x, y} —— 它就是 drawio 的
  text 形状（样式原样写 text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;rounded=0）。
  文字元素想换颜色要写 **fontColor**（setStyle {id, keys:{fontColor:"#b85450"}}）：
  它没有填充与描边，往它身上写 fillColor/strokeColor 屏幕上不会有任何变化。
- style：调色板名 plain|blue|green|orange|yellow|red|purple|grey，或直接给一段 style 串
- dash：solid|dashed|dotted；arrow：end（单向）|both（双向）|none（无）|start（反向）
- exit/entry：进出侧 n|e|s|w；edgeStyle：orthogonalEdgeStyle|none（none = 直线）
- 自环写成 from === to（与 drawio 一致）；自动布局忽略自环，只摆节点。

## 一段完整的例子
用户说"画一个登录流程，失败回到登录页"：

    diagram_apply({ ops: [
      {op:"addNode", label:"开始",   shape:"stadium", style:"green",  as:"start"},
      {op:"addNode", label:"输入账号", shape:"rect",  style:"blue",   as:"input"},
      {op:"addNode", label:"校验",   shape:"diamond", style:"yellow", as:"check"},
      {op:"addNode", label:"进入首页", shape:"rect",  style:"blue",   as:"home"},
      {op:"addEdge", from:"start", to:"input"},
      {op:"addEdge", from:"input", to:"check"},
      {op:"addEdge", from:"check", to:"home", label:"通过"},
      {op:"addEdge", from:"check", to:"input", label:"失败", dash:"dashed", color:"red"}
    ], layout:"dagre-tb" })

写 as 别名而不是 n1/n2：画布上已经有节点时，自动分配的编号猜不准（错一次就白跑一轮）。

用户说"把这几个（他在画布上选中的）换成绿色"：

    diagram_read()          // 返回里的 selection 就是"这几个"
    diagram_apply({ ops: [{op:"setStyle", ids:[...selection], style:"green"}],
                    expectRevision:"<上一步 read 回来的 revision>" })

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
  把 AI 的改动悄悄顶掉）。宿主留了一个**回退栈**（最多 8 步），用户界面「编辑 → 撤销 AI 改动」
  每按一次退一步；read 返回里的 revertSteps 就是"还剩几步"，canRevert 是"还有没有"。
  所以：改了别慌，也别自己"改回去"—— 告诉用户可以连按几次撤销就行。
- **纸张尺寸**（page）：文件里写了就报出来（例如 850 × 1100 = drawio 的 A4 竖版缺省）。
  布局取舍与"要不要给用户导出建议"都该看它 —— 内容远比纸张宽时提醒一句比闷头画更好。

## 想看效果图的时候（diagram_read 带 render:true）
- 传 render:true 就是"让我看一眼这张画布"：正交路由、避让、圆角、文字断线这些
  **只有看图才知道**的东西，几何数据里没有（宿主也不算走线，那是画布算的）。
- 渲染在画布那一半做，所以是两步：第一次返回 look.status="pending"（已请求），
  **等几秒再调一次** diagram_read（render:true），图就作为图片内容块跟回来了。
- **不会在用户的工作区里生成任何文件**：图片存在宿主那边的附件库里（与用户上传图片同一套存储，
  在工作区之外），看完即取走 —— 要再看就再要一次（图不会被反复塞给你）。
- **纯改图不需要它**：几何、样式、图层、纸张从普通 diagram_read 里就有。
  只在判断"这样摆好不好看/线有没有压住节点/别人看不看得懂"时用。
- 看不了的情况会明说：这个部署没挂附件服务、或当前模型没声明图片输入 —— 那时
  look.status 是 unsupported（附原因），照常用几何数据干活即可。
- 那张图是"你请求渲染那一刻"的画面：回执之后你又改过图的话 look.stale 会是 true，
  想看新的就再 render:true 一次。

## style 键与 drawio 同构
文档里存的就是 drawio 的 style 键：fillColor / strokeColor / shape= / rounded= / arcSize= /
dashed / dashPattern / strokeWidth / fontSize / fontColor / edgeStyle / jettySize / orthogonalLoop /
endArrow / startArrow / exitX·exitY·entryX·entryY / libavoidRouting …
**默认值一律省略**（写出来等于多一份噪音），认不出的键原样保留。
边自己的文字存在边的 value 上（diagram_read 里是 label），可以写成多行；
拖动过的边标签位置存在边几何的 x/y/offset 里（沿边比例 + 垂距 + 残余），read 会作为
labelX/labelY 报出来，要改就用 setLabelPos（见上）。

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
      '返回体的 shape/dash/arrow/color/exit/entry/fontColor 是**从 style 串推导出来的便于阅读的名字**，改图请改 style 或对应 op 参数；' +
      'notes 是这个文件里画布表示不了、但会原样保留的东西（多页、分组层级、图片…）。' +
      'layers 是图层表（顺序 = 叠放顺序；visible:false 的层在画布上不画，但里面的单元照旧读得到它们带 layer 字段）；加层/移层/改名/显示隐藏用 addLayer、setLayer、setLayerProps。' +
      '节点带 parent 说明它在某个容器（分组）里 —— 画布按绝对位置显示，所以移动容器不会带走子单元，要整组动就把它们一起写进 ids。' +
      'selection 是**用户此刻在画布上选中的单元 id**（按文件配对、按存在过滤；没人选就是空数组）—— 用户说"把这几个挪一下/换个颜色"时，"这几个"就是它们，别靠坐标猜。' +
      '返回的 revision 可以直接当 diagram_apply 的 expectRevision 用（读→改之间被别人动过就会被拦下）。' +
      '不传 path 时读的是**用户当前打开的那张画布**（返回里的 path 就是它）。',
    parameters: {
      path: {
        type: 'string',
        description:
          '工作区相对路径或绝对路径。**不传 = 用户当前打开的那张画布**（没打开任何画布时才退回 ' +
          DEFAULT_PATH +
          '）—— 想知道用户在看哪张，直接不传 path 调一次，返回里的 path 就是它。',
      },
      layer: {
        type: 'string',
        description:
          '只看某一层（层 id 或层名）：大图上先看一层能省掉一大段上下文。层表照旧整份回。不传 = 全部层。',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: '只看这几个单元（节点/连线 id）：想确认"刚改的那几个现在什么样"时用它，别把整张图再读一遍。',
      },
      render: {
        type: 'boolean',
        description:
          '**看一眼这张画布的渲染结果**（正交路由、避让、圆角、文字断线这些只有看图才知道的东西）。' +
          '渲染在画布那一半做，所以第一次调用通常回 look.status="pending"（已请求，画布几秒内渲染完），**再调一次**就会带上图片块。' +
          '图片经附件通道直接进上下文 —— **不会在你的工作区里生成任何文件**。' +
          '只在确实需要"看"的时候用（判断重叠/压线/观感），纯粹改图不需要它。',
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
          // 纸张尺寸（文件里写了才有）：布局与导出建议要看它。
          page: {
            type: 'object',
            additionalProperties: false,
            properties: {
              w: { type: 'number', required: true },
              h: { type: 'number', required: true },
            },
          },
          // 这次是不是被 layer/ids 过滤过（过滤时上面那些计数只是"看到的部分"）。
          filtered: { type: 'boolean' },
          totalNodes: { type: 'number' },
          totalEdges: { type: 'number' },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          // AI 的高亮请求（取走即清）与"有没有可退回的 AI 改动"。
          highlight: { type: 'array', items: { type: 'string' } },
          canRevert: { type: 'boolean' },
          // AI 改动的回退栈还剩几步（可以连着退；0 = 没有可退的了）。
          revertSteps: { type: 'number' },
          // 用户此刻在画布上选中的单元 id（按**文件**配对、按**存在**过滤）。
          // 用户说"把这几个挪一下"时，"这几个"就是它 —— 以前只能靠坐标猜。
          selection: { type: 'array', items: { type: 'string' } },
          // 导出状态（只有用过 `{op:'export'}` 才有）：pending（画布还没渲染）/ done（文件已写出，
          // 带 path）/ downloaded（png 已由浏览器下载）/ failed（error 是原因）。
          export: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              format: { type: 'string', required: true },
              path: { type: 'string' },
              error: { type: 'string' },
            },
          },
          // 「看一眼」的状态（只有传了 render:true 才有）：pending / ready / unsupported / failed。
          // 图片本身不走 schema，而是走 render 的输出块（见下面的 render()）。
          look: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              stale: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          // 这张图的附件引用（有图才有）。render() 用它拼出 `{type:'image', attachment}` 块。
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              name: { type: 'string' },
            },
          },
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
                // 字色（设过且不是缺省黑字才有）：命中调色板给名字，否则给十六进制。
                fontColor: { type: 'string' },
                // 容器父级（**只读信息**）：单元挂在某个容器/分组里时才有。
                // 画布按绝对位置显示，所以"移动容器"不会带走它 —— 要一起动就把它们一起写进 ids。
                parent: { type: 'string' },
              },
            },
          },
          // 图层列表（顺序 = 叠放顺序，后面的在上面）。加层/移层/改名看 diagram_apply 的
          // addLayer / setLayer / setLayerProps。
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
                // 边上文字的位置（拖过才有）：x = 沿边比例（-1..1，0 = 中点）、y = 垂直偏移 px。
                // 客户端能拖，AI 原来既看不见也改不了 —— 见 setLabelPos。
                labelX: { type: 'number' },
                labelY: { type: 'number' },
                labelOffsetX: { type: 'number' },
                labelOffsetY: { type: 'number' },
                // 线上文字的字色（设过且不是缺省黑字才有）。
                fontColor: { type: 'string' },
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
          '画布 ' + value.path + '（revision ' + value.revision + '，' + value.nodes.length + ' 节点 / ' + value.edges.length + ' 边' +
            (value.filtered === true ? '（**过滤后**；整张是 ' + value.totalNodes + ' 节点 / ' + value.totalEdges + ' 边）' : '') + '）',
        ]
        if (value.page !== undefined && value.page !== null) {
          lines.push('  📄 纸张 ' + value.page.w + ' × ' + value.page.h)
        }
        for (let i = 0; i < value.nodes.length; i += 1) {
          const n = value.nodes[i]
          lines.push(
            '  节点 ' + n.id + ' [' + n.shape + '] ' + n.label + '  @' + n.x + ',' + n.y + ' ' + n.w + '×' + n.h +
              (n.style.length === 0 ? '（默认样式）' : '  style: ' + n.style) + inLayer(n) +
              (typeof n.parent === 'string' ? '  ⌂在 ' + n.parent + ' 里' : ''),
          )
        }
        for (let i = 0; i < value.edges.length; i += 1) {
          const e = value.edges[i]
          const bits = [e.dash, e.arrow + ' arrow']
          if (e.color !== undefined) bits.push(e.color)
          // 线上文字的字色（与"线的颜色"是两件事，所以分开报）。
          if (e.fontColor !== undefined) bits.push('font ' + e.fontColor)
          if (e.exit !== undefined || e.entry !== undefined) bits.push((e.exit === undefined ? '?' : e.exit) + '->' + (e.entry === undefined ? '?' : e.entry))
          if (Array.isArray(e.points)) bits.push(e.points.length + ' waypoint(s)')
          // 边标签被拖过（不是弧长中点了）：位置一起报出来，改它用 setLabelPos。
          if (e.labelX !== undefined) {
            const off = (e.labelOffsetX || e.labelOffsetY) ? '+off(' + numberOr(e.labelOffsetX, 0) + ',' + numberOr(e.labelOffsetY, 0) + ')' : ''
            bits.push('label@' + e.labelX + ',' + e.labelY + off)
          }
          lines.push(
            '  边 ' + e.id + ' ' + e.from + ' -> ' + e.to + (typeof e.label === 'string' && e.label.length > 0 ? ' "' + e.label + '"' : '') +
              ' [' + bits.join(', ') + ']' + inLayer(e),
          )
        }
        for (let i = 0; i < value.notes.length; i += 1) lines.push('  ⚠ ' + value.notes[i])
        // 导出状态：请求过才有一行（让 AI 知道"那张 SVG 到底写出来了没有"）。
        if (value.export !== undefined && value.export !== null && typeof value.export.status === 'string') {
          const ex = value.export
          lines.push(
            '  ⤓ 导出：' + ex.status + '（' + ex.format + '）' +
              (typeof ex.path === 'string' ? ' → ' + ex.path : '') +
              (typeof ex.error === 'string' ? ' ← ' + ex.error : ''),
          )
        }
        // 用户当前的选区：AI 说"这几个"时指的就是它们（不传 path 读的就是用户眼前那张）。
        if (Array.isArray(value.selection) && value.selection.length > 0) {
          lines.push('  🔵 用户当前选中 ' + value.selection.length + ' 项：' + value.selection.join(', '))
        }
        // 图层表：v1 只读。名字 + 可见性（隐藏层里的东西 AI 也照读，但它得知道"用户现在看不见"）。
        if (layers.length > 0) {
          lines.push('  图层（顺序 = 叠放顺序，后面的在上面）：')
          for (let i = 0; i < layers.length; i += 1) {
            const l = layers[i]
            lines.push('    ' + (l.visible === false ? '🚫' : '👁') + ' ' + l.name + ' (id ' + l.id + ')' + (l.locked === true ? ' 🔒' : ''))
          }
        }
        // 「看一眼」的状态：请求过才有 —— 模型要知道"图还没渲好"还是"这个部署/模型看不了图"。
        if (value.look !== undefined && value.look !== null && typeof value.look.status === 'string') {
          const look = value.look
          if (look.status === 'pending') {
            lines.push('  👁 已请求渲染这张画布：画布几秒内渲好，**再调一次 diagram_read（render:true）**就能看到图')
          } else if (look.status === 'ready') {
            lines.push('  👁 渲染结果在图块里' + (look.stale === true ? '（**注意：这是你请求渲染时的样子，之后文件又被改过**）' : ''))
          } else if (look.status === 'unsupported') {
            lines.push('  👁 看不了图：' + String(look.error === undefined ? '这个部署没有可用的图片通道' : look.error))
          } else {
            lines.push('  👁 渲染失败：' + String(look.error === undefined ? '未知原因' : look.error))
          }
        }
        const textBlock = { type: 'text', text: lines.join('\n') }
        // 有图就带上 **image 内容块**：图片走附件通道（DSH 的附件库，工作区零文件），
        // 与 `read_image` 返回的是同一种块，模型直接"看见"。
        if (value.image !== undefined && value.image !== null && typeof value.image.attachmentId === 'string') {
          return [textBlock, { type: 'image', attachment: Object.assign({}, value.image) }]
        }
        return [textBlock]
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
      // 过滤（大图省上下文）：`layer` 只看一层、`ids` 只看几个单元。
      // 计数与"整张有多少"分开报 —— 只报过滤后的数字会让模型以为图变小了。
      const wantLayer = typeof args.layer === 'string' && args.layer.length > 0 ? args.layer : undefined
      const wantIds = Array.isArray(args.ids) ? args.ids.filter((v) => typeof v === 'string' && v.length > 0) : []
      let layerFilter = null
      if (wantLayer !== undefined) {
        const list = Array.isArray(doc.layers) ? doc.layers : []
        for (let i = 0; i < list.length; i += 1) {
          if (String(list[i].id) === wantLayer) layerFilter = String(list[i].id)
        }
        if (layerFilter === null) {
          for (let i = 0; i < list.length; i += 1) {
            const name = typeof list[i].name === 'string' ? list[i].name : ''
            if (name.length > 0 && name === wantLayer) layerFilter = String(list[i].id)
          }
        }
        if (layerFilter === null) {
          throw new Error('没有叫 "' + wantLayer + '" 的图层。Layers: ' + list.map((l) => (l.name || '(无名)') + '#' + l.id).join(', '))
        }
      }
      const keepNode = (n) => {
        if (wantIds.length > 0 && wantIds.indexOf(String(n.id)) < 0) return false
        if (layerFilter !== null && String(n.layer) !== layerFilter) return false
        return true
      }
      const keepEdge = (e) => {
        if (wantIds.length > 0 && wantIds.indexOf(String(e.id)) < 0) return false
        if (layerFilter !== null && String(e.layer) !== layerFilter) return false
        return true
      }
      const filtered = layerFilter !== null || wantIds.length > 0
      const nodes = []
      for (let i = 0; i < doc.nodes.length; i += 1) {
        const n = doc.nodes[i]
        if (keepNode(n) === false) continue
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
          // 容器父级：AI 得知道"这东西在哪个分组里"，否则把容器挪走/删掉时它不知道会连带什么。
          ...(typeof n.parent === 'string' && n.parent.length > 0 ? { parent: n.parent } : {}),
          ...(fontColorFieldOf(style) !== undefined ? { fontColor: fontColorFieldOf(style) } : {}),
        })
      }
      const edges = []
      for (let i = 0; i < doc.edges.length; i += 1) {
        const e = doc.edges[i]
        if (keepEdge(e) === false) continue
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
        // 标签位置（拖过才有）：给了 x/y 就一起回，改它用 setLabelPos。
        if (Number.isFinite(Number(e.labelX)) && Number.isFinite(Number(e.labelY))) {
          item.labelX = Number(e.labelX)
          item.labelY = Number(e.labelY)
          if (Number.isFinite(Number(e.labelOffsetX))) item.labelOffsetX = Number(e.labelOffsetX)
          if (Number.isFinite(Number(e.labelOffsetY))) item.labelOffsetY = Number(e.labelOffsetY)
        }
        if (typeof e.layer === 'string' && e.layer.length > 0) item.layer = e.layer
        const edgeFont = fontColorFieldOf(style)
        if (edgeFont !== undefined) item.fontColor = edgeFont
        edges.push(item)
      }
      // 顺路带两件事（都要在 output.schema 里声明 —— additionalProperties:false 会把
      // 没声明的字段整个判为非法输出，这条踩过一次）：
      //   highlight —— AI 用 `{op:'highlight'}` 请求的高亮，取走即清；
      //   canRevert —— 这张画布上有没有可退回的 AI 改动。
      const pendingHighlight = highlightFor.get(sessionIdOf(exec))
      if (pendingHighlight !== undefined) highlightFor.delete(sessionIdOf(exec))
      const exportState = exportStateFor(sessionIdOf(exec), loaded.absolute)
      // 「看一眼」（render:true）：交图，或挂一个渲染请求。
      //
      // 三道门依次过：附件服务在不在（图片的落脚处）→ 模型声明不声明图片输入 → 手上有没有渲好的图。
      // 前两道过不去时**给一句人话**（而不是抛错）—— AI 还能照常读几何、改图，只是看不到图。
      let lookState = undefined
      let imageValue = undefined
      if (args.render === true) {
        const attachments = attachmentsService()
        if (attachments === undefined || attachments === null) {
          lookState = { status: 'unsupported', error: '这个部署没有挂附件服务（attachments），图片进不了模型上下文' }
        } else {
          const capable = await imageInputSupported(exec)
          if (capable === false) {
            lookState = { status: 'unsupported', error: '当前模型没有声明图片输入能力；换一个支持图片的模型再看' }
          } else {
            const state = renderStateFor(sessionIdOf(exec), loaded.absolute, doc.revision)
            if (state !== undefined && state.status === 'failed') {
              lookState = { status: 'failed', error: state.error }
              renderedImages.delete(sessionIdOf(exec))
            } else if (state !== undefined && state.status === 'ready') {
              const taken = takeRenderedImage(sessionIdOf(exec))
              if (taken !== undefined) {
                lookState = taken.revision === doc.revision ? { status: 'ready' } : { status: 'ready', stale: true }
                imageValue = taken.image
              }
            } else {
              // 同一张画布已有请求就沿用（客户端按 requestId 去重，换 id 会让它再渲一遍）。
              const existing = renderRequests.get(sessionIdOf(exec))
              if (existing === undefined || existing.absolute !== loaded.absolute) {
                // 换了画布：上一张渲好的图作废（否则会把 A 图的画面当 B 图交给模型）。
                renderedImages.delete(sessionIdOf(exec))
                renderRequests.set(sessionIdOf(exec), {
                  requestId: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                  absolute: loaded.absolute,
                  revision: doc.revision,
                })
              }
              lookState = { status: 'pending' }
            }
          }
        }
      }
      return {
        path: loaded.absolute,
        revision: doc.revision,
        ...(doc.page !== undefined && doc.page !== null ? { page: { w: Number(doc.page.w), h: Number(doc.page.h) } } : {}),
        ...(filtered ? { filtered: true, totalNodes: doc.nodes.length, totalEdges: doc.edges.length } : {}),
        ...(lookState !== undefined ? { look: lookState } : {}),
        ...(imageValue !== undefined ? { image: imageValue } : {}),
        notes: loaded.notes,
        nodes: nodes,
        edges: edges,
        ...(exportState !== undefined ? { export: exportState } : {}),
        highlight: Array.isArray(pendingHighlight) ? pendingHighlight : [],
        canRevert: revertDepth(snapshotKey(sessionIdOf(exec), loaded.absolute)) > 0,
        // 还能退回几步（栈深）：模型据此告诉用户"可以连按几次撤销"。
        revertSteps: revertDepth(snapshotKey(sessionIdOf(exec), loaded.absolute)),
        // 用户当前的选区（按文件配对、按存在过滤）：用户说"把这几个…"时指的就是它们。
        // 过滤过也要照旧回 —— "用户选中的那几个"正是最该看的东西。
        selection: selectionForCanvas(sessionIdOf(exec), loaded.absolute, doc),
        // 图层表（顺序 = 叠放顺序）：加层/移层/改名看 diagram_apply 的 addLayer/setLayer/setLayerProps。
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
      'ops 的每一项形如 {op:"addNode", label:"...", as?, shape?, style?, keys?, w?, h?, x?, y?, fontColor?} / ' +
      '{op:"addEdge", from?, to?, fromPoint?, toPoint?, as?, label?, style?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, keys?} / ' +
      '{op:"setLabel", id|ids, label} / {op:"setLabelPos", id, x?, y?, dx?, dy?, center?} / {op:"setStyle", id|ids, shape?, style?, keys?, w?, h?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, clearPoints?} / ' +
      '{op:"setEdge", id, from?, to?, fromPoint?, toPoint?} / {op:"order", id|ids, to:"front"|"back"|"up"|"down"} / ' +
      '{op:"duplicate", id|ids, dx?, dy?, withEdges?, layer?, as?} / {op:"addLayer", name?, as?} / {op:"setLayer", id|ids, layer} / {op:"setLayerProps", layer, name?, visible?, locked?} / ' +
      '{op:"export", format?:"svg"|"png", name?} / ' +
      '{op:"move", id|ids, dx?, dy?, x?, y?} / {op:"remove", id|ids} / {op:"highlight", ids:[...]}；节点 id 省略时自动分配。' +
      '**改接一条边**用 setEdge（换 from/to 或某一端改成自由点）—— id、标签、标签位置、折点、端点约束全都留着；' +
      '不要 remove + addEdge 重画（那会把这些丢掉）。' +
      '**边上的文字压住线**时用 setLabelPos {id, center:true} 放回弧长中点，或用 {id, dy:12} 把它往上/下挪 12px' +
      '（x 是沿边比例 -1..1，0 = 中点；diagram_read 回 labelX/labelY 告诉你它现在在哪）。' +
      '**顺序**用 order（front 到最上面 / back / up / down，与画布右键同一套；它改的是文件里单元的先后）。' +
      '**再复制一份**用 duplicate（新 id + 整体平移两格，折点/端点约束/标签位置都带过去；默认连"两端都在复制范围内的边"一起复制）。' +
      '**图层**用 addLayer/setLayer/setLayerProps（加层、把单元移到别的层、改名/显示/隐藏/锁定；隐藏≠删除）。' +
      '**导出**用 export：format:"svg" 会让画布渲染一张 SVG 落在 .drawio 旁边、format:"png" 是浏览器下载；' +
      '这一步由画布执行，返回值里的 export.status 是 pending/done/downloaded/failed（pending = 画布还没刷新）。' +
      '**一次改一组**就写 ids:[...]（setStyle/setLabel/move/remove 都收，move 的批量只收 dx/dy 相对位移）—— 用户说"把这几个换成绿色"时不要逐个发 op。' +
      '**引用刚建的那个**用 as:"名字"：{op:"addNode", label:"开始", as:"start"} 之后同一个 ops 数组里 from/to/id 可以直接写 "start"，不必猜自动分配的 n7。' +
      '返回值里的 created/changed/removed 是结构化 id（含自动分配的那些），不用去解析 summary 文本。' +
      'expectRevision：把上一次 diagram_read 返回的 revision 传进来当乐观锁 —— 对不上（用户同时在 drawio 里改过）就**直接报错、一个字节都不写**，重读一次再改。' +
      'addEdge 的两端各自可以给**节点 id** 或**绝对点**（fromPoint/toPoint）—— 两端都给点就是一条**独立线**' +
      '（drawio 里边的两端都可以是自由点，线可以完全不接节点）。' +
      'move 改已有元素的位置：节点可以给 dx/dy（相对）或 x/y（绝对），连线只能给 dx/dy（平移它自己的折点与自由端点）。' +
      '以前没有 move，只能删掉重画 —— 那会丢 id、丢边上的端点约束与折点。' +
      'highlight 只让客户端选中那几个（不改文档，也不重排）。' +
      '文档里存的是 **drawio 的 style 键**（dashed/dashPattern/edgeStyle/jettySize/libavoidRouting/exitX·exitY·entryX·entryY/endArrow·startArrow/strokeColor/fillColor/shape=/rounded=/arcSize=…），默认值一律省略、认不出的键原样保留；' +
      '上面这些 shape/style/dash/arrow/color/exit/entry 是给模型用的**糖**，由宿主翻译成 style 键，绝不落盘。' +
      'style 既可以是调色板名（plain/blue/green/orange/yellow/red/purple/grey），也可以直接是一段 style 串；keys 用来写任意 drawio 键（值给 null = 删键回默认）。' +
      'setStyle 的 id 可以是节点也可以是连线：节点用 shape/style/keys/w/h/fontColor，连线用 dash（solid|dashed|dotted）、arrow（end 单向|both 双向|none 无箭头|start 反向）、color（**线本身**的颜色）、exit/entry（n|e|s|w 进出侧）、jettySize（引出段长度，数字或 auto）、edgeStyle（orthogonalEdgeStyle|none）、line（straight 直线|sharp 直角折线|rounded 圆角折线|curved 曲线）、avoid（是否参与避让路由）、fontSize（字号）、fontColor（**文字**颜色）、clearPoints（清掉折点）。' +
      'fontColor 给调色板名（plain/blue/green/orange/yellow/red/purple/grey）就按画布上"文字换色"那一支取色，给 #b85450 这类色值就原样写；fontColor:null 删键回缺省（黑字）。' +
      '文档若带 meta.pinned（人手工摆过位置），不加 layout 就不会重排；显式重排会清掉端点已移动的那些边上的过期折点。' +      '边引用了不存在的节点会直接报错，且失败发生在写盘之前。自环写成 from === to（与 drawio 一致）；自动布局会忽略自环，只摆节点。' +
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
      expectRevision: {
        type: 'string',
        description:
          '乐观锁：上一次 diagram_read 返回的 revision（文件内容指纹）。对不上说明这份文件在你会话中途被别人改过（用户同时在 drawio 里编辑），本次调用**直接失败且不写盘**，重新读一次再改。不传 = 不检查。',
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
          // 这次调用真的建了哪些单元（含自动分配的 id 与别名指向的那个）——
          // 模型要接着引用它们时不必再读一次、也不必解析 summary 文本。
          created: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                label: { type: 'string' },
              },
            },
          },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          removed: { type: 'array', required: true, items: { type: 'string' } },
          // 导出状态（只有请求过导出才有）：pending = 画布还没渲染，done = 文件已写出（path），
          // downloaded = png 已由浏览器下载，failed = 渲染失败（error 是原因）。
          export: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              format: { type: 'string', required: true },
              path: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
      render: function (args, value) {
        const created = Array.isArray(value.created) ? value.created : []
        const bits = []
        if (created.length > 0) {
          bits.push('新建 ' + created.map((c) => c.id + '(' + c.type + ')').join(', '))
        }
        if (Array.isArray(value.changed) && value.changed.length > 0) bits.push('改动 ' + value.changed.join(', '))
        if (Array.isArray(value.removed) && value.removed.length > 0) bits.push('删除 ' + value.removed.join(', '))
        return [
          {
            type: 'text',
            text:
              '已更新 ' + value.path + '：revision ' + value.revision + '，' + value.nodeCount + ' 节点 / ' + value.edgeCount +
              ' 边，布局 ' + value.layout + (bits.length > 0 ? '\n' + bits.join('；') : '') + '\n' + value.summary,
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

      // 乐观锁：`revision` 是**文件内容指纹**（见 loadDoc），把它传给 expectRevision 就能保证
      // "我读到的那一版"和"我现在要改的那一版"是同一份。
      //
      // 为什么需要：read 返回的 revision 原来在 AI 侧**没有任何用处**（409 只存在于画布保存那条
      // 路由上），于是"AI 读 → 用户在 drawio 里改 → AI 写"这条时序会把用户的改动**静默**覆盖掉。
      // 现在基线对不上就直接报错、**一个字节都不写**，让模型重读一次再改。
      const expect = typeof args.expectRevision === 'string' && args.expectRevision.length > 0 ? args.expectRevision : undefined
      if (expect !== undefined && expect !== doc.revision) {
        throw new Error(
          'revision conflict：你给的是 ' + expect + '，"' + loaded.absolute + '" 现在是 ' +
            (loaded.exists === true ? doc.revision : '(文件不存在)') +
            ' —— 别覆盖别人的改动。重新 diagram_read 一次，拿新的 revision 再改。',
        )
      }

      // 人工摆过的文档（meta.pinned）默认不再自动重排 —— 否则 AI 一改图，
      // 人手工调好的位置就被 dagre 全冲掉了。想重排必须显式指定 layout。
      const pinned = doc.meta !== null && typeof doc.meta === 'object' && doc.meta.pinned === true
      // `highlight` 只是"让客户端选中这几个"、`export` 只是"让画布渲染一张图"—— 都不改文档：
      //   · 一次全是这类 op 的调用**不写盘**（也不会顺手重排，那条特别危险）；
      //   · 混着编辑时，它们跟着一起生效。
      const edits = ops.filter((op) => op === null || typeof op !== 'object' || (op.op !== 'highlight' && op.op !== 'export'))
      const noDocEdit = edits.length === 0
      // 默认布局：pinned、纯 highlight、以及**ops 里自带几何**（addNode 给了 x/y、有 move、
      // 或有 duplicate —— 复制出来的位置是相对原件的）时都不重排 —— 否则"把 n1 往右挪 40"
      // 会被 dagre 立刻冲掉（实测：move 完坐标原样回来，看起来像工具坏了），
      // 复制也一样（刚贴出来的那份会连同原件一起被重排走）。
      const explicitGeometry = ops.some(
        (op) =>
          op !== null &&
          typeof op === 'object' &&
          (op.op === 'move' ||
            op.op === 'duplicate' ||
            (op.op === 'addNode' && (Number.isFinite(Number(op.x)) || Number.isFinite(Number(op.y))))),
      )
      const mode = typeof args.layout === 'string' ? args.layout : pinned || noDocEdit || explicitGeometry ? 'none' : 'dagre-tb'
      if (LAYOUTS.indexOf(mode) < 0) throw new Error('unknown layout "' + mode + '"; use one of ' + LAYOUTS.join(', '))

      const out = {}
      const notes = applyOps(doc, ops, out)
      if (Array.isArray(out.highlight)) highlightFor.set(sessionId, out.highlight)
      // 删掉的东西不该还挂在"用户选中"里（id 会被复用，见 forgetSelection）。
      if (Array.isArray(out.removed) && out.removed.length > 0) forgetSelection(sessionId, loaded.absolute, out.removed)
      // 导出请求：登记下来（画布下一次轮询时取走并渲染），并把上一次的结果清掉，免得模型看到旧的。
      if (out.export !== undefined && out.export !== null) {
        const requestId = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        exportRequests.set(sessionId, { requestId: requestId, absolute: loaded.absolute, format: out.export.format, name: out.export.name })
        exportResults.delete(sessionId)
      }
      if (noDocEdit) {
        return {
          path: loaded.absolute,
          revision: doc.revision,
          nodeCount: doc.nodes.length,
          edgeCount: doc.edges.length,
          layout: 'none',
          created: [],
          changed: [],
          removed: [],
          ...(exportStateFor(sessionId, loaded.absolute) !== undefined ? { export: exportStateFor(sessionId, loaded.absolute) } : {}),
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
        pushRevertSnapshot(snapshotKey(sessionId, loaded.absolute), { text: loaded.text, revision: doc.revision })
      }
      try {
        if (policy === undefined) await ctx.fs.writeText(loaded.target, rendered.text)
        else await ctx.fs.writeText(loaded.target, rendered.text, undefined, undefined, policy)
      } catch (error) {
        const scope = policy === undefined ? 'unresolved policy' : policy.mode + ' @ ' + String(policy.workspaceRoot)
        throw new Error('write "' + loaded.absolute + '" failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']')
      }
      if (revertDepth(snapshotKey(sessionId, loaded.absolute)) > 0) {
        notes.push('↩ 这次改动可以退回（还能退 ' + revertDepth(snapshotKey(sessionId, loaded.absolute)) + ' 步）：界面上「编辑 → 撤销 AI 改动」')
      }
      return {
        path: loaded.absolute,
        revision: doc.revision,
        nodeCount: doc.nodes.length,
        edgeCount: doc.edges.length,
        layout: mode,
        // 结构化"这次动了什么"：新建的 id（含自动分配的）与别名解析结果都在这里，
        // 模型不必再从 summary 文本里认 id。改完的 revision 也可以直接当 expectRevision 用。
        created: Array.isArray(out.created) ? out.created : [],
        changed: Array.isArray(out.changed) ? out.changed : [],
        removed: Array.isArray(out.removed) ? out.removed : [],
        ...(exportStateFor(sessionId, loaded.absolute) !== undefined ? { export: exportStateFor(sessionId, loaded.absolute) } : {}),
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
   * AI 改动前的"上一版"文本（按 会话+路径 存，**一个栈**，最多 `REVERT_STEPS` 层）。
   *
   * 客户端的撤销历史在服务端推来新版本时会被清空（故意的：否则一次 Ctrl+Z
   * 会把 AI 刚写的改动悄悄顶掉），所以 AI 的改动要能退，就得宿主自己留回退点。
   *
   * 为什么是栈而不是一层：一轮会话里 AI 往往连改好几次（"再挪一点""这两条也换颜色"），
   * 只留一层的话，用户按一下「撤销 AI 改动」就直接跳回最开始 —— 中间那几步无从恢复。
   * 现在每按一次退一步（界面上的菜单项可以连按），read 的 `revertSteps` 告诉模型还剩几步。
   */
  const revertSnapshots = new Map()
  /** 回退栈深度上限：够用（一轮对话的改图次数）又不至于把内存堆起来（每个快照就是一份文件全文）。 */
  const REVERT_STEPS = 8
  function pushRevertSnapshot(key, entry) {
    const stack = revertSnapshots.get(key)
    if (stack === undefined) revertSnapshots.set(key, [entry])
    else {
      stack.push(entry)
      while (stack.length > REVERT_STEPS) stack.shift()
    }
  }
  function revertDepth(key) {
    const stack = revertSnapshots.get(key)
    return stack === undefined ? 0 : stack.length
  }
  /** AI 请求的"高亮这些"（按会话，客户端下次来读时取走并清空）。 */
  const highlightFor = new Map()
  /**
   * 「看一眼这张画布」：把画布渲染成一张 PNG，经**附件的通道**直接进模型。
   *
   * 为什么不是落一个文件在工作区：用户的诉求是"AI 看图，但别在我的项目里留东西"。
   * 所以这条路**一个字节都不写工作区** —— 渲染好的 PNG 交给 DSH 的附件服务
   * （`attachments.saveImage`，内容寻址、在工作区之外，与用户上传图片是同一套存储），
   * 工具结果里带一个 `{type:'image', attachment}` 内容块，模型就"看见"了。
   *
   * 渲染仍然在浏览器那一半（正交路由、避让、圆角、断线都在那儿），所以这是一条
   * **请求/回执**通道：宿主挂请求 → 客户端轮询取走 → canvas 渲成 PNG → base64 回执
   * → 宿主存成附件 → 下一次 `diagram_read {render:true}` 把图带回去。
   */
  const renderRequests = new Map()
  /** 渲染好的图（按会话）：`{ absolute, revision, image, at }` —— 取走即清，超时作废。 */
  const renderedImages = new Map()
  /** 渲染结果的保鲜期：超过它就不再交付（要新的请重新请求一次，免得给模型看一张老图）。 */
  const RENDER_TTL_MS = 5 * 60 * 1000

  /** 附件服务（可选依赖）：这个部署没装它就没法"看图"，但插件其余功能照旧。 */
  function attachmentsService() {
    if (typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get('attachments')
    } catch (error) {
      return undefined
    }
  }

  /**
   * 当前路由的模型是否声明了**图片输入**。
   *
   * 与 `read_image` 同一套判据（provider/model 取会话的路由配置，回落到 agent options，
   * 再问 llm 服务的 `resolveModelInfo`）。**判不出来时不算失败**：DSH 自己会把图片降级成
   * 一句文字占位符（text-only 模型），所以这里只用来提前给一句人话，而不是拦死。
   */
  async function imageInputSupported(exec) {
    if (typeof ctx.get !== 'function') return undefined
    let llm
    try {
      llm = ctx.get('llm')
    } catch (error) {
      return undefined
    }
    if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') return undefined
    const agent = exec === undefined || exec === null ? undefined : exec.agent
    let provider
    let model
    try {
      const header = agent !== undefined && agent.session !== undefined && typeof agent.session.requestHeader === 'function' ? agent.session.requestHeader() : undefined
      const routed = header === undefined || header === null ? undefined : header.config
      provider = routed === undefined || routed === null ? undefined : routed.provider
      model = routed === undefined || routed === null ? undefined : routed.model
      if (provider === undefined && agent !== undefined && agent.options !== undefined) provider = agent.options.provider
      if (model === undefined && agent !== undefined && agent.options !== undefined) model = agent.options.model
    } catch (error) {
      return undefined
    }
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    try {
      const info = await llm.resolveModelInfo(provider, model, exec === undefined ? undefined : exec.signal)
      if (info === undefined || info === null || Array.isArray(info.inputModalities) === false) return undefined
      return info.inputModalities.indexOf('image') >= 0
    } catch (error) {
      return undefined
    }
  }

  /**
   * 「看图」这条路当前的可用性 + 待交付的图。
   *
   * 状态：`pending`（已请求，等画布渲染）/ `ready`（有图，这一次带回模型）/
   * `unsupported`（这个部署/模型看不了图，附一句为什么）/ `failed`（渲染回执说失败了）。
   */
  function renderStateFor(sessionId, absolute, revision) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const pending = renderRequests.get(sessionId)
    if (pending !== undefined && pending.absolute === absolute) return { status: 'pending' }
    const done = renderedImages.get(sessionId)
    if (done === undefined || done.absolute !== absolute) return undefined
    if (Date.now() - done.at > RENDER_TTL_MS) {
      renderedImages.delete(sessionId)
      return undefined
    }
    if (done.status === 'failed') return { status: 'failed', error: String(done.error) }
    return { status: 'ready', stale: done.revision !== revision, image: done.image }
  }

  /** 取走那张图（一次性）：模型看过就不再重复塞给它，要再看就再请求一次。 */
  function takeRenderedImage(sessionId) {
    const done = renderedImages.get(sessionId)
    if (done === undefined || done.status !== 'ready') return undefined
    renderedImages.delete(sessionId)
    return done
  }

  /**
   * 用户当前**选中**了哪几个单元（按会话）：`{ absolute, ids }`。
   *
   * 为什么需要：用户说"把这几个换成绿色""把它们挪右边一点"时，AI 原来只能靠坐标猜
   * （README 的 D 节第一条）。客户端本来就有选区状态，只是从来没告诉宿主。
   *
   * 两条设计约束：
   *   · **认文件**：记录里带绝对路径，只有读的正是那一张时才回 —— 否则"在 A 图选中的 n1"
   *     会被当成 B 图里的 n1（两个文件里都叫 n1 太常见了）；
   *   · **认存在**：回给模型前按**当前文档**过滤一遍（见 selectionForCanvas）—— 用户或 AI
   *     刚删掉的东西不该还在"选中"里。
   * 选区只是"用户在看什么"的提示，不是文档状态：**不进文件**，关掉画布就清。
   */
  const canvasSelection = new Map()
  /**
   * AI 请求的导出（按会话）：`{ requestId, absolute, format, name }`。
   *
   * 渲染只在浏览器里（路由、避让、圆角都在画布那一半），所以导出是一条**请求/回执**通道：
   * 宿主挂上请求 → 客户端下次轮询的 `read` 里取走 → 渲染完 POST 回 `export-result`
   * → 宿主写文件（svg）或记一笔"已下载"（png 走浏览器下载，与菜单导出同一条路）。
   */
  const exportRequests = new Map()
  /** 最近一次导出的结果（`diagram_read` 把它带回给模型）。 */
  const exportResults = new Map()

  /** 路径小工具：导出文件落在 `.drawio` 旁边，所以只需要在同级拼名字。 */
  function dirOf(absolute) {
    const text = String(absolute)
    const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
    return at > 0 ? text.slice(0, at) : ''
  }
  function baseNameOf(absolute) {
    const text = String(absolute)
    const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
    return (at >= 0 ? text.slice(at + 1) : text).replace(/\.drawio$/i, '')
  }

  /**
   * 这张画布上的导出状态：还挂着请求 = pending；已经回过结果就报结果；什么都没发生过 = undefined。
   *
   * 路径必须对得上 —— 导出是"这张画布"的事，换了标签之后不该把上一张的结果报成这一张的。
   */
  function exportStateFor(sessionId, absolute) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const pending = exportRequests.get(sessionId)
    if (pending !== undefined && pending.absolute === absolute) {
      return { status: 'pending', format: pending.format }
    }
    const done = exportResults.get(sessionId)
    if (done === undefined || done.absolute !== absolute) return undefined
    if (done.status === 'done') return { status: 'done', format: done.format, path: done.path }
    if (done.status === 'downloaded') return { status: 'downloaded', format: done.format }
    return { status: 'failed', format: done.format, error: String(done.error) }
  }

  /**
   * 把"这次被删掉的单元"从选区记录里划掉。
   *
   * 光靠读时的存在性过滤不够：id 是**会被复用的**（删掉 n3 再建一个，下一个还是 n3），
   * 于是"用户之前选中的 n3"会凭空变成刚新建的那个节点 —— 删除时就划掉才干净。
   */
  function forgetSelection(sessionId, absolute, ids) {
    const entry = canvasSelection.get(sessionId)
    if (entry === undefined || entry.absolute !== absolute) return
    entry.ids = entry.ids.filter((id) => ids.indexOf(id) < 0)
    if (entry.ids.length === 0) canvasSelection.delete(sessionId)
  }

  function snapshotKey(sessionId, absolute) {
    return String(sessionId) + '\n' + String(absolute)
  }

  /**
   * 把选区记录过滤成"这张文档里真的还存在"的 id 列表。
   *
   * 路径对不上就返回空数组（切了标签、或 AI 读的是另一张图）。
   * 过滤而不是原样回：`remove` 之后残留的 id 会让模型以为东西还在。
   */
  function selectionForCanvas(sessionId, absolute, doc) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    const entry = canvasSelection.get(sessionId)
    if (entry === undefined || entry.absolute !== absolute) return []
    const alive = {}
    for (let i = 0; i < doc.nodes.length; i += 1) alive[String(doc.nodes[i].id)] = true
    for (let i = 0; i < doc.edges.length; i += 1) alive[String(doc.edges[i].id)] = true
    const out = []
    for (let i = 0; i < entry.ids.length; i += 1) if (alive[entry.ids[i]] === true) out.push(entry.ids[i])
    return out
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
        // 导出请求顺路带给客户端：它渲染完再 POST 回 export-result（渲染器在浏览器那一半）。
        const pendingExport = exportRequests.get(sessionId)
        const exportForThis =
          pendingExport !== undefined && pendingExport.absolute === loaded.absolute
            ? { requestId: pendingExport.requestId, format: pendingExport.format, name: pendingExport.name }
            : null
        // 「看一眼」的渲染请求同理：客户端渲成 PNG 回执给 render-result，宿主存成**附件**
        // （工作区零文件），下一次 diagram_read 把 image 块交给模型。
        const pendingRender = renderRequests.get(sessionId)
        const renderForThis =
          pendingRender !== undefined && pendingRender.absolute === loaded.absolute ? { requestId: pendingRender.requestId } : null
        sendJson(res, 200, {
          ok: true,
          exists: true,
          path: rawPath,
          absolute: loaded.absolute,
          revision: loaded.doc.revision,
          doc: loaded.doc,
          notes: loaded.notes,
          highlight: Array.isArray(pendingHighlight) ? pendingHighlight : [],
          canRevert: revertDepth(snapshotKey(sessionId, loaded.absolute)) > 0,
          // 用户当前的选区（客户端可选地用来做提示；AI 侧由工具读回）。
          selection: selectionForCanvas(sessionId, loaded.absolute, loaded.doc),
          export: exportForThis,
          render: renderForThis,
        })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: '这个文件读不出画布：' + messageOf(error) })
      }
      return
    }

    // action: 'render-result' —— 客户端把画布渲成 PNG 回执给宿主（AI 的 `diagram_read {render:true}` 走这条）。
    //
    // **这条路的产物不进工作区**：图片交给附件服务存（内容寻址，在工作区之外，与用户上传图片同一套），
    // 下一次 read 用一个 `{type:'image', attachment}` 内容块把它交给模型。
    // 与 export-result 同一条护栏：只有"这个会话此刻真的挂着一个请求"才收。
    if (body.action === 'render-result') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const pending = renderRequests.get(sessionId)
      if (pending === undefined) {
        sendJson(res, 409, { ok: false, error: 'no pending render request' })
        return
      }
      if (typeof body.requestId === 'string' && body.requestId !== pending.requestId) {
        sendJson(res, 409, { ok: false, error: 'stale render request' })
        return
      }
      const noteFailure = (message) => {
        renderRequests.delete(sessionId)
        renderedImages.set(sessionId, {
          absolute: pending.absolute,
          revision: pending.revision,
          status: 'failed',
          error: message,
          at: Date.now(),
        })
      }
      // 失败回执也要收下：否则请求一直挂着，模型永远看到 pending。
      if (body.ok === false) {
        noteFailure(typeof body.error === 'string' && body.error.length > 0 ? body.error : '画布没能渲染出这张图')
        sendJson(res, 200, { ok: true })
        return
      }
      const attachments = attachmentsService()
      if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
        noteFailure('这个部署没有可用的附件服务（attachments），图片存不下来')
        sendJson(res, 409, { ok: false, error: 'no attachment service' })
        return
      }
      const base64 = typeof body.png === 'string' ? body.png : ''
      const bytes = base64.trim().length === 0 ? Buffer.alloc(0) : Buffer.from(base64, 'base64')
      if (bytes.length === 0) {
        sendJson(res, 400, { ok: false, error: 'png is empty' })
        return
      }
      const limits = attachments.imageLimits === undefined || attachments.imageLimits === null ? {} : attachments.imageLimits
      if (Number.isFinite(Number(limits.maxImageBytes)) && bytes.length > Number(limits.maxImageBytes)) {
        noteFailure('这张图 ' + bytes.length + ' 字节，超过这个部署的图片上限 ' + Number(limits.maxImageBytes) + ' 字节')
        sendJson(res, 413, { ok: false, error: 'image too large: ' + bytes.length + ' > ' + Number(limits.maxImageBytes) })
        return
      }
      if (Array.isArray(limits.mediaTypes) && limits.mediaTypes.indexOf('image/png') < 0) {
        noteFailure('这个部署不接受 image/png')
        sendJson(res, 415, { ok: false, error: 'image/png is not accepted by this deployment' })
        return
      }
      const fallbackName = baseNameOf(pending.absolute) + '.png'
      let ref = null
      try {
        ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name: fallbackName })
      } catch (error) {
        noteFailure(messageOf(error))
        sendJson(res, 500, { ok: false, error: 'save failed: ' + messageOf(error) })
        return
      }
      if (ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') {
        noteFailure('附件服务没有返回可用的图片引用')
        sendJson(res, 500, { ok: false, error: 'attachment service returned no usable reference' })
        return
      }
      renderRequests.delete(sessionId)
      const width = Number.isFinite(Number(ref.width)) ? Number(ref.width) : Number(body.width)
      const height = Number.isFinite(Number(ref.height)) ? Number(ref.height) : Number(body.height)
      renderedImages.set(sessionId, {
        absolute: pending.absolute,
        revision: pending.revision,
        status: 'ready',
        at: Date.now(),
        image: {
          attachmentId: String(ref.attachmentId),
          mediaType: typeof ref.mediaType === 'string' && ref.mediaType.length > 0 ? ref.mediaType : 'image/png',
          bytes: Number.isFinite(Number(ref.bytes)) ? Number(ref.bytes) : bytes.length,
          width: Number.isFinite(width) ? width : 0,
          height: Number.isFinite(height) ? height : 0,
          name: typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : fallbackName,
        },
      })
      sendJson(res, 200, { ok: true, bytes: bytes.length })
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
      const stack = revertSnapshots.get(key)
      const snapshot = stack === undefined || stack.length === 0 ? undefined : stack[stack.length - 1]
      if (snapshot === undefined) {
        sendJson(res, 200, { ok: false, error: '这张画布没有可退回的 AI 改动了' })
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
      // 退一步：把这一层弹掉（界面上的「撤销 AI 改动」可以接着按，read 的 revertSteps 是剩余步数）。
      stack.pop()
      if (stack.length === 0) revertSnapshots.delete(key)
      sendJson(res, 200, { ok: true, revision: contentHash(snapshot.text), path: revertAbsolute, stepsLeft: revertDepth(key) })
      return
    }

    // action: 'export-result' —— 客户端把渲染好的图回执给宿主（AI 的 `{op:'export'}` 走这条）。
    //
    // 只有"这个会话此刻真的挂着一个请求"才收：否则任何能发这个 POST 的东西都能往工作区里写文件。
    // svg → 落在 `.drawio` 旁边（同名，可用请求里的 name 改基名）；png 在浏览器里直接下载，
    // 这里只记一笔"已下载"（宿主写二进制要另开通道，而用户点一次就有的东西不值得为它搬 base64）。
    if (body.action === 'export-result') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const pending = exportRequests.get(sessionId)
      if (pending === undefined) {
        sendJson(res, 409, { ok: false, error: 'no pending export request' })
        return
      }
      if (typeof body.requestId === 'string' && body.requestId !== pending.requestId) {
        sendJson(res, 409, { ok: false, error: 'stale export request' })
        return
      }
      if (body.ok === false) {
        exportRequests.delete(sessionId)
        exportResults.set(sessionId, {
          absolute: pending.absolute,
          status: 'failed',
          format: pending.format,
          error: typeof body.error === 'string' && body.error.length > 0 ? body.error : '客户端没能渲染出这张图',
        })
        sendJson(res, 200, { ok: true })
        return
      }
      if (pending.format === 'png') {
        exportRequests.delete(sessionId)
        exportResults.set(sessionId, { absolute: pending.absolute, status: 'downloaded', format: 'png' })
        sendJson(res, 200, { ok: true, downloaded: true })
        return
      }
      const svg = typeof body.svg === 'string' ? body.svg : ''
      if (svg.trim().length === 0) {
        sendJson(res, 400, { ok: false, error: 'svg is empty' })
        return
      }
      if (Buffer.byteLength(svg, 'utf8') > SAVE_MAX_BYTES) {
        sendJson(res, 413, { ok: false, error: 'svg exceeds ' + SAVE_MAX_BYTES + ' bytes' })
        return
      }
      const base = pending.name !== undefined && pending.name.length > 0 ? pending.name : baseNameOf(pending.absolute)
      const dir = dirOf(pending.absolute)
      let exportTarget = null
      try {
        exportTarget = dir.length > 0 ? await ctx.fs.resolve(base + '.svg', { cwd: dir }) : await ctx.fs.resolve(base + '.svg')
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      const exportPolicy = policyFor(sessionId)
      try {
        if (exportPolicy === undefined) await ctx.fs.writeText(exportTarget, svg)
        else await ctx.fs.writeText(exportTarget, svg, undefined, undefined, exportPolicy)
      } catch (error) {
        exportRequests.delete(sessionId)
        exportResults.set(sessionId, { absolute: pending.absolute, status: 'failed', format: 'svg', error: messageOf(error) })
        sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) })
        return
      }
      exportRequests.delete(sessionId)
      exportResults.set(sessionId, {
        absolute: pending.absolute,
        status: 'done',
        format: 'svg',
        path: absoluteHint(exportTarget, base + '.svg'),
      })
      sendJson(res, 200, { ok: true, path: absoluteHint(exportTarget, base + '.svg') })
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
        // 画布都关了，选区当然也不算数了
        canvasSelection.delete(sessionId)
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
      // 换了一张画布 = 上一张的选区作废（否则"在 A 图选中的 n1"会变成 B 图里的 n1 ——
      // 两个文件里都叫 n1 太常见了）。客户端切换标签后会重新上报新选区。
      if (before !== raw) canvasSelection.delete(sessionId)
      if (before !== raw) notifyFocusedCanvas(sessionId, raw)
      sendJson(res, 200, { ok: true, focused: raw })
      return
    }

    // action: 'selection' —— 画布告诉宿主"用户现在选中了哪几个单元"。
    //
    // 为什么需要：用户说"把这几个换成绿色""把它们往右挪一点"时，AI 原来只能靠坐标猜
    // （"这几个"是哪几个它看不见）。客户端本来就有选区状态，只是从来没告诉宿主。
    //
    // 与聚焦同一条规矩：**只存路径与 id，不读内容、也不进文件** —— 选区是"用户在看什么"
    // 的提示，不是文档状态。存的是**解析后的绝对路径**，读的时候按它配对（见 selectionForCanvas）。
    if (body.action === 'selection') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const selRoot = workspaceRootOf(sessionId)
      if (selRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const selRaw = typeof body.path === 'string' ? body.path : ''
      const selIds = []
      if (Array.isArray(body.ids)) {
        // 上限只是护栏：一次点击不可能选到 500 个，写进来的是别的客户端时别把内存撑爆。
        for (let i = 0; i < body.ids.length && selIds.length < 500; i += 1) {
          const v = body.ids[i]
          if (typeof v === 'string' && v.length > 0) selIds.push(v)
        }
      }
      // 空路径（画布没绑定文件）或空选区 = 清掉记录：别让上一次的选区继续跟着走。
      if (selRaw.length === 0 || selIds.length === 0 || selRaw.toLowerCase().endsWith('.drawio') === false) {
        canvasSelection.delete(sessionId)
        sendJson(res, 200, { ok: true, count: 0 })
        return
      }
      let selTarget
      try {
        selTarget = await ctx.fs.resolve(selRaw, { cwd: selRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(selRoot)
        if (!ctx.fs.contains(rootTarget, selTarget)) {
          sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(selTarget, selRaw) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      canvasSelection.set(sessionId, { absolute: absoluteHint(selTarget, selRaw), ids: selIds })
      sendJson(res, 200, { ok: true, count: selIds.length })
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
      // 文档形状直接用 emptyDoc()（**含那个缺省图层**）—— 别再手搭一份
      // `{version, meta, nodes, edges}`：这就是同一个"逐个字段抄"的毛病，
      // 抄漏 layers 之后内存里的画布与盘上的文件对不上。
      const blankDoc = Object.assign({}, emptyDoc(), { meta: { pinned: true } })
      const blankBuilt = buildMxfile(blankDoc, { name: nameCheck.name.replace(/\.drawio$/i, '') })
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
