/* drawai-style-kernel — 宿主半边与客户端半边共用同一份源码；见下方说明。 */
/**
 * drawio 风格样式内核 —— 宿主半边与客户端半边**共用同一份**源码。
 *
 * 用法：
 *   - 宿主半边（src/index.js）：`import { parseStyle, ... } from './style-kernel.js'`，
 *     构建时整个文件原样拷进 lib/style-kernel.js。
 *   - 客户端半边（src/client.js）：不 import；tools/build.mjs 在构建时把本文件
 *     **去掉末尾的 export 语句**后原样内联到 bundle 的 factory 作用域里，
 *     所以两边拿到的函数是同一份文本，不会漂移。
 *
 * 约束（构建期会强制）：
 *   - 纯函数、零依赖、不引用任何全局（window/document/process 都不许）；
 *   - **不许出现反引号**（客户端 bundle 靠加缩进套壳，模板字符串会让缩进不安全）；
 *   - 顶层只放 `var` / `function` 声明与 `export { ... }` 一行。
 *
 * 数据模型（v2）与 drawio 的对应关系，逐条都有 drawio 源码依据：
 *   - 形状/配色不再是封闭枚举，而是 **开放 style 键值集合**，默认值省略：
 *     `Graph.prototype.defaultVertexStyle = {}`（js/grapheditor/Graph.js:17586）——
 *     普通矩形就是**空样式**，这就是"rect = 没有 shape 键"的出处。
 *   - 虚线：`dashed=1` + `dashPattern`（mxConstants.js:1631，画布默认 '3 3'：
 *     mxgraph/src/util/mxAbstractCanvas2D.js:154）。
 *   - 箭头：`endArrow` / `startArrow`（mxConstants.js:1466、:912），
 *     **键缺省 = 不画箭头**（mxgraph/src/shape/mxConnector.js:139 用 NONE 当 getValue 缺省）。
 *     drawio 新建连线的默认样式里显式带 `endArrow=classic`，我们也照写。
 *   - 正交路由：`edgeStyle=orthogonalEdgeStyle`（mxConstants.js:2554，
 *     注册于 mxgraph/src/view/mxStyleRegistry.js:67）；`edgeStyle=none` = 直线。
 *   - 端点桩点（引出段长度）：`jettySize` / `sourceJettySize` / `targetJettySize`
 *     （mxConstants.js:2031；可为数字或 'auto'，见 drawio docs/claude/libavoid-routing.md:259-280）。
 *   - 进出侧：`exitX`/`exitY`/`entryX`/`entryY`（mxConstants.js:904/912/946/954），
 *     取值是**在顶点包围盒上的比例**（0=左/上，0.5=中，1=右/下）。
 *   - 避让：`libavoidRouting=1` 是 per-edge 的 style 键（libavoid-routing.md:210、:253）。
 *   - 折点归 `points`，与进出侧彻底分开；悬空端的自由点用 `sourcePoint`/`targetPoint`
 *     `{x,y}`（libavoid-routing.md:136-153），且**仅在该端没有真实顶点时才生效**
 *     （mxgraph/src/model/mxGeometry.js:100-113）。
 *   - 文档里存的是 drawio 的键；`shape`/`dashed`/`arrow`/颜色名这些**枚举只有工具与 UI 用**，
 *     由本内核在两侧翻译，绝不落盘。
 */

// ── 规范键序：落盘顺序稳定、diff 友好；不在表里的键（开放集合）按插入序排在后面 ──
var STYLE_KEY_ORDER = [
  'shape', 'ellipse', 'rhombus', 'rounded', 'arcSize', 'direction', 'flipH', 'flipV',
  'whiteSpace', 'html', 'fontSize', 'fontFamily', 'fontColor', 'fontStyle',
  'fillColor', 'strokeColor', 'strokeWidth', 'dashed', 'dashPattern',
  'edgeStyle', 'orthogonalLoop', 'jettySize', 'sourceJettySize', 'targetJettySize',
  'exitX', 'exitY', 'entryX', 'entryY', 'libavoidRouting', 'endArrow', 'startArrow',
  'endFill', 'startFill', 'endSize', 'startSize', 'labelBackgroundColor',
]

/** drawio 的 8 色经典调色板；'plain' 就是 drawio 缺省顶点的白底黑边。 */
var PALETTE = [
  { name: 'plain', fill: '#ffffff', stroke: '#000000', font: '#000000' },
  { name: 'blue', fill: '#dae8fc', stroke: '#6c8ebf', font: null },
  { name: 'green', fill: '#d5e8d4', stroke: '#82b366', font: null },
  { name: 'orange', fill: '#ffe6cc', stroke: '#d79b00', font: null },
  { name: 'yellow', fill: '#fff2cc', stroke: '#d6b656', font: null },
  { name: 'red', fill: '#f8cecc', stroke: '#b85450', font: null },
  { name: 'purple', fill: '#e1d5e7', stroke: '#9673a6', font: null },
  { name: 'grey', fill: '#f5f5f5', stroke: '#666666', font: null },
]

/** drawio 缺省顶点样式：白底、黑边（所以空样式渲染出来就是它）。 */
var DEFAULT_FILL = '#ffffff'
var DEFAULT_STROKE = '#000000'
var DEFAULT_FONT = '#000000'

/**
 * 形状枚举 → style 键。rect 映射成**空串**：drawio 里它就是"没有 shape 键"。
 * 键名与 0.2.0（src/mxfile.js 的 SHAPE_STYLE）一致，方便两代互认。
 *
 * `text`（独立文字）用的是 drawio 的 `Editor.defaultTextStyle` **原样**：
 *   `text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;rounded=0;`
 * （src/main/webapp/js/diagramly/Editor.js:376）。它是"没有边框没有填充的一段文字"，
 * 靠 `text` 这个裸键 + `strokeColor=none;fillColor=none` 表达 —— 所以换形状时必须把
 * 这两个 none 一起清掉，否则"文字改成矩形"会得到一只看不见的矩形。
 */
var NODE_SHAPE_STYLE = {
  rect: '',
  rounded: 'rounded=1',
  text: 'text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;rounded=0',
  stadium: 'rounded=1;arcSize=50',
  ellipse: 'ellipse=1',
  diamond: 'rhombus=1',
  parallelogram: 'shape=parallelogram',
  cylinder: 'shape=cylinder3',
  document: 'shape=document',
  hexagon: 'shape=hexagon',
}

/** 形状枚举的顺序（UI 菜单、read 输出的稳定顺序）。顺序对齐 drawio 的形状面板。 */
var NODE_SHAPES = ['rect', 'rounded', 'text', 'stadium', 'ellipse', 'diamond', 'parallelogram', 'cylinder', 'document', 'hexagon']

/** 文字形状独有的"隐形"设置：离开文字形状时要清掉（它们不该跟着变成别的形状）。 */
var TEXT_SHAPE_ONLY_KEYS = { strokeColor: 'none', fillColor: 'none' }

/** 线型枚举 → style 键。solid 是缺省，落盘即"没有 dashed 键"。 */
var DASH_PRESETS = {
  solid: null,
  dashed: { dashed: '1' },
  dotted: { dashed: '1', dashPattern: '1 2' },
}

/** 线型枚举顺序。 */
var DASH_KINDS = ['solid', 'dashed', 'dotted']

/** 箭头枚举 → style 键。none 是缺省（drawio 里键缺省就不画箭头），落盘即删键。 */
var ARROW_PRESETS = {
  none: null,
  end: { endArrow: 'classic' },
  both: { endArrow: 'classic', startArrow: 'classic' },
  start: { startArrow: 'classic' },
}

/** 箭头枚举顺序。 */
var ARROW_KINDS = ['end', 'both', 'none', 'start']

/** 四个进出侧 → drawio 的 exitX/exitY 比例（顶点包围盒上的比例坐标）。 */
var SIDE_FRACTION = {
  n: { x: 0.5, y: 0 },
  e: { x: 1, y: 0.5 },
  s: { x: 0.5, y: 1 },
  w: { x: 0, y: 0.5 },
}

/** 四个进出侧的顺序（UI 与预览里的稳定顺序：上右下左）。 */
var SIDES = ['n', 'e', 's', 'w']

/** 比例判定容差：drawio 的比例是浮点，比较必须带容差。 */
var FRACTION_EPS = 0.001

/** 缺省正交边样式：照抄 drawio 的 Graph.prototype.defaultEdgeStyle（Graph.js:17591），
 *  再补上 drawio 新建连线时显式写的箭头与 html（无 html 键时 drawio 按纯文本渲染标签）。 */
var DEFAULT_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;jettySize=auto;orthogonalLoop=1;html=1;endArrow=classic;'

/** 缺省顶点样式：空串 = drawio 的 defaultVertexStyle。 */
var DEFAULT_NODE_STYLE = ''

function isObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/** 归一化一个 style 值：数字转字符串、去空白；null/undefined 表示"删掉这个键"。 */
function styleValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value).trim()
}

/**
 * 解析 style 串为键值对象。
 *
 * drawio 语法（原样照抄）：以 ';' 分段；'k=v' 为键值；**单独一个键**（如 `ellipse;`）
 * 等价于 `ellipse=1`；空段忽略。键值两侧空白去掉，值内部空白保留（`dashPattern=3 3`）。
 */
function parseStyle(text) {
  var out = {}
  if (text === null || text === undefined) return out
  if (isObject(text)) {
    var keys = Object.keys(text)
    for (var i = 0; i < keys.length; i += 1) {
      var value = styleValue(text[keys[i]])
      if (value !== null) out[keys[i]] = value
    }
    return out
  }
  var parts = String(text).split(';')
  for (var p = 0; p < parts.length; p += 1) {
    var part = parts[p].trim()
    if (part.length === 0) continue
    var eq = part.indexOf('=')
    if (eq < 0) out[part] = '1'
    else {
      var key = part.slice(0, eq).trim()
      if (key.length === 0) continue
      out[key] = part.slice(eq + 1).trim()
    }
  }
  return out
}

/** 把键值对象拼回 style 串：规范键序 + 未知键按插入序 + 结尾分号。空对象 → 空串。 */
function formatStyle(value) {
  var map = parseStyle(value)
  var seen = {}
  var parts = []
  var i
  for (i = 0; i < STYLE_KEY_ORDER.length; i += 1) {
    var known = STYLE_KEY_ORDER[i]
    if (map[known] === undefined) continue
    seen[known] = true
    parts.push(known + '=' + map[known])
  }
  var rest = Object.keys(map)
  for (i = 0; i < rest.length; i += 1) {
    if (seen[rest[i]] === true) continue
    parts.push(rest[i] + '=' + map[rest[i]])
  }
  return parts.length === 0 ? '' : parts.join(';') + ';'
}

/** 读一个键，接受 style 串或已解析的对象。 */
function styleGet(style, key, fallback) {
  var map = isObject(style) ? style : parseStyle(style)
  var value = map[key]
  return value === undefined ? fallback : value
}

/**
 * 读一个**数值型** style 键：键不存在 / 空值 / 非数字一律回落 fallback。
 *
 * 为什么必须单独有一个：`Number(null) === 0`，而 0 是有限数 —— 于是
 * `numberOr(styleGet(style, 'fontSize', null), 12)` 这句看着像"取不到就用 12"，
 * 实际在缺省时返回的是 **0**。实测后果：节点文字与连线一起消失（fontSize=0、
 * strokeWidth=0），而且**不报任何错**。数值型的 style 键一律走这里读。
 */
function styleNumber(style, key, fallback) {
  var raw = styleGet(style, key, null)
  if (raw === null || raw === undefined || raw === '') return fallback
  var n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** 写/删一个键，返回新的 style 串（删键 = 回落 drawio 缺省）。 */
function styleSet(style, key, value) {
  var map = parseStyle(style)
  var normalized = styleValue(value)
  if (normalized === null) delete map[key]
  else map[key] = normalized
  return formatStyle(map)
}

/** 批量写/删：keys 里值为 null 表示删。 */
function stylePatch(style, keys) {
  var map = parseStyle(style)
  var names = Object.keys(keys)
  for (var i = 0; i < names.length; i += 1) {
    var normalized = styleValue(keys[names[i]])
    if (normalized === null) delete map[names[i]]
    else map[names[i]] = normalized
  }
  return formatStyle(map)
}

/** 是否"等于 drawio 缺省"（空样式）。 */
function styleIsEmpty(style) {
  return formatStyle(style).length === 0
}

// ── 形状 ─────────────────────────────────────────────────────────────────────

/**
 * 从 style 键反推形状枚举。判据顺序与 drawio 渲染一致：
 * shape= 的具体名字优先，其次 ellipse/rhombus 这两个裸键，再看 rounded/arcSize，最后 rect。
 * 认不出的组合落回 rect —— 但**不丢键**（开放集合，未知键原样保留在文档里）。
 */
function nodeShapeFromStyle(style) {
  // 独立文字：drawio 用裸键 `text`（不是 `shape=text`）表达，所以要单独认一次。
  if (styleGet(style, 'text', null) !== null) return 'text'
  var shape = styleGet(style, 'shape', null)
  if (shape === 'parallelogram') return 'parallelogram'
  if (shape === 'cylinder3' || shape === 'cylinder') return 'cylinder'
  if (shape === 'document') return 'document'
  if (shape === 'hexagon') return 'hexagon'
  if (shape === 'rhombus' || styleGet(style, 'rhombus', null) === '1') return 'diamond'
  if (styleGet(style, 'ellipse', null) === '1' || shape === 'ellipse') return 'ellipse'
  if (styleGet(style, 'rounded', null) === '1') {
    var arc = Number(styleGet(style, 'arcSize', null))
    if (Number.isFinite(arc) && arc >= 40) return 'stadium'
    return 'rounded'
  }
  return 'rect'
}

/** 形状枚举 → 只含形状键的 style 串。 */
function styleFromNodeShape(shape) {
  var preset = NODE_SHAPE_STYLE[shape]
  return preset === undefined ? '' : preset
}

/** 换形状：先清掉所有形状键，再套新形状的键（其它键原样保留）。 */
function styleWithNodeShape(style, shape) {
  var map = parseStyle(style)
  var wasText = nodeShapeFromStyle(style) === 'text'
  var shapeKeys = ['shape', 'ellipse', 'rhombus', 'rounded', 'arcSize', 'text']
  for (var i = 0; i < shapeKeys.length; i += 1) delete map[shapeKeys[i]]
  // 从"文字"换成别的形状：把它的隐形设置也清掉，否则换出来的矩形/椭圆是看不见的
  // （文字形状靠 strokeColor=none;fillColor=none 才没有边框和底色）。
  if (wasText && shape !== 'text') {
    var noneKeys = Object.keys(TEXT_SHAPE_ONLY_KEYS)
    for (var n = 0; n < noneKeys.length; n += 1) {
      if (String(map[noneKeys[n]]).toLowerCase() === TEXT_SHAPE_ONLY_KEYS[noneKeys[n]]) delete map[noneKeys[n]]
    }
  }
  var preset = parseStyle(styleFromNodeShape(shape))
  var names = Object.keys(preset)
  for (var p = 0; p < names.length; p += 1) map[names[p]] = preset[names[p]]
  return formatStyle(map)
}

// ── 配色 ─────────────────────────────────────────────────────────────────────

/** 从 style 取填充/描边/字色，缺省即 drawio 缺省（白底黑边黑字）。 */
function colorsFromStyle(style) {
  return {
    fill: styleGet(style, 'fillColor', DEFAULT_FILL),
    stroke: styleGet(style, 'strokeColor', DEFAULT_STROKE),
    font: styleGet(style, 'fontColor', DEFAULT_FONT),
  }
}

/** 精确命中调色板才给名字（"开放集合"里认不出的颜色就是没有名字）。 */
function colorNameFromStyle(style) {
  var fill = String(styleGet(style, 'fillColor', DEFAULT_FILL)).toLowerCase()
  var stroke = String(styleGet(style, 'strokeColor', DEFAULT_STROKE)).toLowerCase()
  for (var i = 0; i < PALETTE.length; i += 1) {
    if (PALETTE[i].fill.toLowerCase() === fill && PALETTE[i].stroke.toLowerCase() === stroke) return PALETTE[i].name
  }
  return null
}

/** 调色板名 → style 键；'plain' 即 drawio 缺省，落盘就是删掉这两个键。 */
function styleWithColorName(style, name) {
  var entry = null
  for (var i = 0; i < PALETTE.length; i += 1) if (PALETTE[i].name === name) entry = PALETTE[i]
  if (entry === null) return style
  if (entry.name === 'plain') {
    return stylePatch(style, { fillColor: null, strokeColor: null, fontColor: null })
  }
  var patch = { fillColor: entry.fill, strokeColor: entry.stroke }
  patch.fontColor = entry.font === null ? null : entry.font
  return stylePatch(style, patch)
}

/** 直接给两个色值（客户端取色器用）。 */
function styleWithColors(style, fill, stroke, font) {
  var patch = {}
  patch.fillColor = fill === undefined ? null : fill
  patch.strokeColor = stroke === undefined ? null : stroke
  if (font !== undefined) patch.fontColor = font
  return stylePatch(style, patch)
}

/**
 * 独立文字的"配色"：文字没有填充与描边，能换的只有**字色**。
 *
 * 所以对文字元素，调色板要把颜色写到 `fontColor` 上而不是 fillColor/strokeColor ——
 * 否则用户点了一圈颜色，屏幕上一点变化都没有（填充/描边被文字形状忽略）。
 */
function textColorNameFromStyle(style) {
  var font = String(styleGet(style, 'fontColor', DEFAULT_FONT)).toLowerCase()
  for (var i = 0; i < PALETTE.length; i += 1) {
    var want = String(PALETTE[i].name === 'plain' ? DEFAULT_FONT : PALETTE[i].stroke).toLowerCase()
    if (want === font) return PALETTE[i].name
  }
  return null
}

/** 文字元素的调色板：把颜色写成 fontColor（'plain' = 删键回缺省字色）。 */
function styleWithTextColorName(style, name) {
  var entry = null
  for (var i = 0; i < PALETTE.length; i += 1) if (PALETTE[i].name === name) entry = PALETTE[i]
  if (entry === null) return style
  if (entry.name === 'plain') return stylePatch(style, { fontColor: null })
  return stylePatch(style, { fontColor: entry.stroke })
}

// ── 线型 ─────────────────────────────────────────────────────────────────────

/** style → 线型枚举。dashed 不在就是实线；dashPattern 认得出点线就报 dotted，否则 custom。 */
function dashFromStyle(style) {
  if (styleGet(style, 'dashed', null) !== '1') return 'solid'
  var pattern = styleGet(style, 'dashPattern', null)
  if (pattern === null || pattern === '' || pattern === '3 3') return 'dashed'
  if (pattern === '1 2' || pattern === '1 1') return 'dotted'
  return 'custom'
}

/** 线型枚举 → style（custom 需要显式传 pattern）。 */
function styleWithDash(style, kind, pattern) {
  var cleared = stylePatch(style, { dashed: null, dashPattern: null })
  if (kind === 'solid' || kind === null || kind === undefined) return cleared
  if (kind === 'custom') return stylePatch(cleared, { dashed: '1', dashPattern: pattern === undefined ? '3 3' : pattern })
  var preset = DASH_PRESETS[kind]
  if (preset === undefined || preset === null) return cleared
  return stylePatch(cleared, preset)
}

/** 读虚线间距（给渲染用）：solid 返回 null，否则返回 drawio 画布缺省 '3 3'。 */
function dashPatternFromStyle(style) {
  if (dashFromStyle(style) === 'solid') return null
  return styleGet(style, 'dashPattern', '3 3')
}

// ── 箭头 ─────────────────────────────────────────────────────────────────────

/** 是否算"有箭头"：drawio 里只要不是 none/缺省就画。 */
function arrowValueIsSet(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'none' && value !== '0'
}

/** style → 箭头枚举。 */
function arrowFromStyle(style) {
  var end = arrowValueIsSet(styleGet(style, 'endArrow', null))
  var start = arrowValueIsSet(styleGet(style, 'startArrow', null))
  if (end && start) return 'both'
  if (end) return 'end'
  if (start) return 'start'
  return 'none'
}

/** 箭头枚举 → style。none 即删键（= drawio 缺省不画）。 */
function styleWithArrow(style, kind) {
  var cleared = stylePatch(style, { endArrow: null, startArrow: null })
  if (kind === null || kind === undefined || kind === 'none') return cleared
  var preset = ARROW_PRESETS[kind]
  if (preset === undefined || preset === null) return cleared
  return stylePatch(cleared, preset)
}

// ── 端点：进出侧（exitX/exitY/entryX/entryY）─────────────────────────────────

/** 端别 → 键名。source 端用 exitX/exitY，target 端用 entryX/entryY（drawio 命名如此）。 */
function sideKeysFor(end) {
  return end === 'source' ? ['exitX', 'exitY'] : ['entryX', 'entryY']
}

/** 比例 → 最近的侧；不是已知的四个侧中心就返回 null（保留了任意比例，只是没有侧名）。 */
function sideFromFraction(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  for (var i = 0; i < SIDES.length; i += 1) {
    var f = SIDE_FRACTION[SIDES[i]]
    if (Math.abs(f.x - x) <= FRACTION_EPS && Math.abs(f.y - y) <= FRACTION_EPS) return SIDES[i]
  }
  return null
}

/** 读某一端的进出侧：没有约束返回 null（= 由路由器自己挑边）。 */
function sideFromStyle(style, end) {
  var keys = sideKeysFor(end)
  var x = styleGet(style, keys[0], null)
  var y = styleGet(style, keys[1], null)
  if (x === null || y === null) return null
  return sideFromFraction(Number(x), Number(y))
}

/** 读某一端的比例约束（可能不是侧中心）；没有返回 null。 */
function fractionFromStyle(style, end) {
  var keys = sideKeysFor(end)
  var x = styleGet(style, keys[0], null)
  var y = styleGet(style, keys[1], null)
  if (x === null || y === null) return null
  var nx = Number(x)
  var ny = Number(y)
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null
  return { x: nx, y: ny }
}

/** 写/清某一端的进出侧约束；side 为 null 时删键（回到"路由器自己挑"）。 */
function styleWithSide(style, end, side) {
  var keys = sideKeysFor(end)
  var patch = {}
  if (side === null || side === undefined) {
    patch[keys[0]] = null
    patch[keys[1]] = null
  } else {
    var fraction = SIDE_FRACTION[side]
    if (fraction === undefined) return formatStyle(style)
    patch[keys[0]] = String(fraction.x)
    patch[keys[1]] = String(fraction.y)
  }
  return stylePatch(style, patch)
}

// ── 端点：桩点长度、正交路由、避让 ───────────────────────────────────────────

/** edgeStyle 键：缺省按 drawio 新建连线的缺省值当正交（Graph.js:17591）。 */
function edgeStyleValueFromStyle(style) {
  return styleGet(style, 'edgeStyle', 'orthogonalEdgeStyle')
}

/** 是否走正交路由（'none' = 直线；其余值不认识也按正交画，但键原样保留）。 */
function isOrthogonalEdgeStyle(style) {
  return edgeStyleValueFromStyle(style) !== 'none'
}

/** 某一端的桩点长度：'auto' 或缺省 → null（由渲染端用缺省值）；数字 → 数值。 */
function jettyFromStyle(style, end) {
  var key = end === 'source' ? 'sourceJettySize' : end === 'target' ? 'targetJettySize' : 'jettySize'
  var value = styleGet(style, key, null)
  if (value === null) value = end === undefined ? null : styleGet(style, 'jettySize', null)
  if (value === null || value === '' || value === 'auto') return null
  var n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 写桩点长度：数字或 'auto'；null 删键。 */
function styleWithJetty(style, value) {
  return stylePatch(style, { jettySize: value === null || value === undefined ? null : String(value) })
}

/** 避让开关（drawio 的 per-edge 键 `libavoidRouting`）。 */
function avoidFromStyle(style) {
  return styleGet(style, 'libavoidRouting', '0') === '1'
}

/** 写避让开关：开 = libavoidRouting=1，关 = 删键（回落缺省关）。 */
function styleWithAvoid(style, on) {
  return stylePatch(style, { libavoidRouting: on === true ? '1' : null })
}

// ── 折点与悬空端 ─────────────────────────────────────────────────────────────

/** 一个点是否可用（有限数）。 */
function normalizePoint(value) {
  if (!isObject(value)) return null
  var x = Number(value.x)
  var y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: x, y: y }
}

/** 归一化折点数组：丢掉非法项、保持顺序；空数组归一成 null（= 没有折点）。 */
function normalizePoints(value) {
  if (Array.isArray(value) === false) return null
  var out = []
  for (var i = 0; i < value.length; i += 1) {
    var point = normalizePoint(value[i])
    if (point !== null) out.push(point)
  }
  return out.length === 0 ? null : out
}

/** 两点是否同一位置（浮点容差）。 */
function pointsEqual(a, b, eps) {
  var tolerance = eps === undefined ? 0.5 : eps
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
}

/** 该端是否有真实顶点（drawio：有顶点时 sourcePoint/targetPoint 被忽略）。 */
function edgeTerminalId(edge, end) {
  var id = end === 'source' ? edge.from : edge.to
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** 该端的自由点（悬空端才有效）：返回归一化点或 null。 */
function edgeFreePoint(edge, end) {
  if (edgeTerminalId(edge, end) !== null) return null
  return normalizePoint(end === 'source' ? edge.sourcePoint : edge.targetPoint)
}

/**
 * 一次性几何迁移：把**节点几何对齐到整格**、**折点与自由端点对齐到半格**。
 *
 * 为什么需要它：画布自己的手势是吸附的，但文档还可能从别处来 —— drawio 手画的图、
 * AI 早期写下的坐标、旧版本估宽留下的 186/56 这种非整格尺寸。它们不会自己变整齐，
 * 而"差几像素的台阶"正是之前反复修的那类毛病（同一条线上两个段把手、连线抖动）的温床。
 *
 * 只动**几何**：style 键、标签、两端约束、层级、其他页一律不碰（写回仍然是无损手术）。
 * 尺寸下限取 minW/minH（默认一格）—— 传 0 表示不夹。
 *
 * @returns { doc, changes } —— changes 是被改动过的字段个数（0 表示本来就在格线上）
 */
function snapDocGeometry(doc, options) {
  var opt = isObject(options) ? options : {}
  var grid = Number.isFinite(Number(opt.grid)) && Number(opt.grid) > 0 ? Number(opt.grid) : 10
  var edgeGrid = Number.isFinite(Number(opt.edgeGrid)) && Number(opt.edgeGrid) > 0 ? Number(opt.edgeGrid) : grid / 2
  var minW = Number.isFinite(Number(opt.minW)) && Number(opt.minW) > 0 ? Number(opt.minW) : grid
  var minH = Number.isFinite(Number(opt.minH)) && Number(opt.minH) > 0 ? Number(opt.minH) : grid
  var snap = function (value, unit) {
    var n = Number(value)
    return Number.isFinite(n) ? Math.round(n / unit) * unit : 0
  }
  var changes = 0
  var nodesIn = Array.isArray(doc.nodes) ? doc.nodes : []
  var nodes = []
  var i
  for (i = 0; i < nodesIn.length; i += 1) {
    var node = Object.assign({}, nodesIn[i])
    var x = snap(node.x, grid)
    var y = snap(node.y, grid)
    var w = Math.max(minW, snap(node.w, grid))
    var h = Math.max(minH, snap(node.h, grid))
    if (x !== node.x) changes += 1
    if (y !== node.y) changes += 1
    if (w !== node.w) changes += 1
    if (h !== node.h) changes += 1
    node.x = x
    node.y = y
    node.w = w
    node.h = h
    nodes.push(node)
  }
  var edgesIn = Array.isArray(doc.edges) ? doc.edges : []
  var edges = []
  for (i = 0; i < edgesIn.length; i += 1) {
    var edge = Object.assign({}, edgesIn[i])
    if (Array.isArray(edge.points)) {
      var points = []
      for (var k = 0; k < edge.points.length; k += 1) {
        var px = snap(edge.points[k].x, edgeGrid)
        var py = snap(edge.points[k].y, edgeGrid)
        if (px !== edge.points[k].x) changes += 1
        if (py !== edge.points[k].y) changes += 1
        points.push({ x: px, y: py })
      }
      edge.points = points
    }
    var ends = ['sourcePoint', 'targetPoint']
    for (var e = 0; e < ends.length; e += 1) {
      var point = edge[ends[e]]
      if (point === undefined || point === null) continue
      var fx = snap(point.x, edgeGrid)
      var fy = snap(point.y, edgeGrid)
      if (fx !== point.x) changes += 1
      if (fy !== point.y) changes += 1
      edge[ends[e]] = { x: fx, y: fy }
    }
    edges.push(edge)
  }
  return {
    doc: {
      version: doc.version,
      revision: doc.revision,
      meta: doc.meta,
      nodes: nodes,
      edges: edges,
      labels: doc.labels,
    },
    changes: changes,
  }
}

/**
 * 自定义属性（drawio 的"编辑数据"）：只保留字符串值。
 *
 * 为什么单列一个函数：数据最终要写成 XML 属性，非字符串值（嵌套对象、数字以外的东西）
 * 没有意义，与其在写回时悄悄 String() 一下，不如在入口就收敛成字符串。
 */
function copyData(data) {
  var out = {}
  if (isObject(data) === false) return out
  var keys = Object.keys(data)
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i]
    if (key === 'id' || key === 'label') continue
    var value = data[key]
    if (value === undefined || value === null) continue
    out[key] = typeof value === 'string' ? value : String(value)
  }
  return out
}

/**
 * 文档归一化（字段清洗）。两侧半边都用它，保证读写同一套判据。
 *
 * 载体是 `.drawio`（drawio 的 mxfile）之后，这里**不再有 v1 迁移**：
 * 盘上只有一种格式，`shape:'rect'` / `style:'blue'` / `dash:'dashed'` 那套语义枚举
 * 随 `.dshd.json` 一起退场了。留着的迁移代码只会让人以为还有第二种格式。
 *
 * `revision` 是**文件内容指纹**（字符串），原样透传 —— 这里曾经把它 `Number()` 一下，
 * 于是十六进制指纹里只要有一个字母就变成 0，客户端的乐观锁直接失效。
 */
function normalizeDrawioDoc(raw) {
  var source = isObject(raw) ? raw : {}

  var nodesIn = Array.isArray(source.nodes) ? source.nodes : []
  var edgesIn = Array.isArray(source.edges) ? source.edges : []
  var nodes = []
  var i

  for (i = 0; i < nodesIn.length; i += 1) {
    var rawNode = isObject(nodesIn[i]) ? nodesIn[i] : {}
    var out = { id: rawNode.id }
    if (typeof rawNode.label === 'string') out.label = rawNode.label
    out.style = formatStyle(rawNode.style)
    out.x = Number.isFinite(Number(rawNode.x)) ? Number(rawNode.x) : 0
    out.y = Number.isFinite(Number(rawNode.y)) ? Number(rawNode.y) : 0
    out.w = Number.isFinite(Number(rawNode.w)) ? Number(rawNode.w) : 0
    out.h = Number.isFinite(Number(rawNode.h)) ? Number(rawNode.h) : 0
    // 编辑数据（drawio 用户对象上的自定义属性）：只收字符串值，原样带上。
    var data = rawNode.data
    if (isObject(data)) out.data = copyData(data)
    // 属于哪个图层（渲染时隐藏层整层不画）。
    if (typeof rawNode.layer === 'string' && rawNode.layer.length > 0) out.layer = rawNode.layer
    nodes.push(out)
  }

  var edges = []
  for (i = 0; i < edgesIn.length; i += 1) {
    var edge = isObject(edgesIn[i]) ? edgesIn[i] : {}
    var item = { id: edge.id, from: edge.from, to: edge.to }
    if (typeof edge.label === 'string' && edge.label.length > 0) item.label = edge.label
    item.style = formatStyle(edge.style === undefined ? DEFAULT_EDGE_STYLE : edge.style)
    var points = normalizePoints(edge.points)
    if (points !== null) item.points = points
    var sourcePoint = normalizePoint(edge.sourcePoint)
    if (sourcePoint !== null) item.sourcePoint = sourcePoint
    var targetPoint = normalizePoint(edge.targetPoint)
    if (targetPoint !== null) item.targetPoint = targetPoint
    // 边标签的位置（drawio 的 mxGeometry x/y + offset）：拖过标签才有，缺省 = 弧长中点。
    // 必须原样穿过归一化 —— 丢了它，画布会把用户拖过的标签画回中点（和 labels 那次踩的同一个坑）。
    var hasPos = edge.labelX !== undefined && edge.labelX !== null && edge.labelY !== undefined && edge.labelY !== null
    if (hasPos && Number.isFinite(Number(edge.labelX)) && Number.isFinite(Number(edge.labelY))) {
      item.labelX = Number(edge.labelX)
      item.labelY = Number(edge.labelY)
      var offX = Number(edge.labelOffsetX)
      var offY = Number(edge.labelOffsetY)
      if (Number.isFinite(offX) && offX !== 0) item.labelOffsetX = offX
      if (Number.isFinite(offY) && offY !== 0) item.labelOffsetY = offY
    }
    if (isObject(edge.data)) item.data = copyData(edge.data)
    if (typeof edge.layer === 'string' && edge.layer.length > 0) item.layer = edge.layer
    edges.push(item)
  }

  var meta = isObject(source.meta) ? source.meta : {}
  // drawio 的独立边标签单元：**只读**，但必须原样穿过归一化 ——
  // 它决定了渲染出来的标签位置。丢掉它 = 画布上看不见那些标签（实测踩过：
  // 宿主读出来有、客户端归一化时被抹掉，于是"读到了"却什么都不显示）。
  var labelsIn = Array.isArray(source.labels) ? source.labels : []
  var labels = []
  for (i = 0; i < labelsIn.length; i += 1) {
    var raw = isObject(labelsIn[i]) ? labelsIn[i] : {}
    if (typeof raw.id !== 'string') continue
    labels.push({
      id: raw.id,
      text: typeof raw.text === 'string' ? raw.text : '',
      edgeId: typeof raw.edgeId === 'string' && raw.edgeId.length > 0 ? raw.edgeId : null,
      x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : 0,
      y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : 0,
      offsetX: Number.isFinite(Number(raw.offsetX)) ? Number(raw.offsetX) : 0,
      offsetY: Number.isFinite(Number(raw.offsetY)) ? Number(raw.offsetY) : 0,
      relative: raw.relative === true,
      style: typeof raw.style === 'string' ? raw.style : '',
      ...(typeof raw.layer === 'string' && raw.layer.length > 0 ? { layer: raw.layer } : {}),
    })
  }
  // 图层：id + 名字 + 显示/隐藏 + 锁定（顺序 = 覆盖顺序）。缺省可见、未锁。
  var layersIn = Array.isArray(source.layers) ? source.layers : []
  var layers = []
  for (i = 0; i < layersIn.length; i += 1) {
    var rawLayer = isObject(layersIn[i]) ? layersIn[i] : {}
    if (typeof rawLayer.id !== 'string' || rawLayer.id.length === 0) continue
    layers.push({
      id: rawLayer.id,
      name: typeof rawLayer.name === 'string' ? rawLayer.name : '',
      visible: rawLayer.visible !== false,
      locked: rawLayer.locked === true,
    })
  }
  return {
    version: 2,
    revision: typeof source.revision === 'string' ? source.revision : Number.isFinite(Number(source.revision)) && source.revision !== undefined && source.revision !== null ? String(source.revision) : '',
    meta: meta,
    nodes: nodes,
    edges: edges,
    labels: labels,
    layers: layers,
  }
}

export {
  STYLE_KEY_ORDER, PALETTE, NODE_SHAPES, NODE_SHAPE_STYLE, DASH_KINDS, ARROW_KINDS, SIDES,
  DEFAULT_FILL, DEFAULT_STROKE, DEFAULT_FONT, DEFAULT_NODE_STYLE, DEFAULT_EDGE_STYLE,
  parseStyle, formatStyle, styleGet, styleSet, stylePatch, styleIsEmpty, styleNumber,
  nodeShapeFromStyle, styleFromNodeShape, styleWithNodeShape,
  colorsFromStyle, colorNameFromStyle, styleWithColorName, styleWithColors,
  textColorNameFromStyle, styleWithTextColorName,
  dashFromStyle, styleWithDash, dashPatternFromStyle,
  arrowFromStyle, styleWithArrow,
  sideFromStyle, fractionFromStyle, styleWithSide, sideFromFraction,
  edgeStyleValueFromStyle, isOrthogonalEdgeStyle, jettyFromStyle, styleWithJetty,
  avoidFromStyle, styleWithAvoid,
  normalizePoint, normalizePoints, pointsEqual,
  edgeTerminalId, edgeFreePoint,
  normalizeDrawioDoc, snapDocGeometry,
}
