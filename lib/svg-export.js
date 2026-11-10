/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/* DrawAI 宿主侧导出：把文档对象直接画成 SVG（零依赖），PNG 再交给 @resvg/resvg-js。
 *
 * 为什么要有这条路径（issue #23）：导出一直挂在浏览器那一半 ——
 * `diagram_read {render:true}` 与 `diagram_apply {op:"export"}` 都要用户在右侧栏
 * 打开着画布才有人接。QQ / CLI 这类没有侧栏的通道里，宿主能读写 .drawai，
 * 成品图却拿不到，而那时成品图正是唯一的交付物。
 *
 * 这一份是**按同一套规则独立重画**，不是把客户端的渲染器搬过来：客户端是 React
 * 组件树 + 浏览器字体度量 + 画布缩放，宿主两样都没有。所以：
 *   · 几何（形状、连线、标签位置、换行、导出包围盒）照抄客户端的纯函数口径；
 *   · 文字量宽用 `charWidth`（CJK 按 1em、其余按 0.55em 估算）—— 与客户端
 *     **无 DOM 时的回退**同一套，常见标签断行一致，长标签可能差一行；
 *   · 视频/卡片/音频这类由客户端组件画的节点只画出通用形状，不还原内部画面。
 * 因此调用方要把保真度标成 `approximate`，并把 warnings 一并交出去。
 */

import {
  DEFAULT_FONT,
  arrowFromStyle,
  curvedFromStyle,
  dashPatternFromStyle,
  imageValueFromStyle,
  isOrthogonalEdgeStyle,
  nodeShapeFromStyle,
  sideFromStyle,
  styleGet,
  styleNumber,
} from './style-kernel.js'
import { createOrthogonalRouter, storedRoute } from './routing/router.js'
import { getRoutingRuntime } from './routing/node-runtime.js'

/**
 * 没有折点的正交边，用**宿主这一份**路由器补一条真走线。
 *
 * 为什么不干脆按直线画：`edgeStyle=orthogonalEdgeStyle` 的边在画布上从来不是斜线 ——
 * 客户端 `routeEdgeStyled` 会跑一遍自动路由。导出若画成对角线，同一份文档在两个地方
 * 长得不一样，而这正是 issue #23 抱怨的事（"拿不到成品图"之后紧接着就是"拿到的图不对"）。
 * 引擎是懒加载的 vendor 文件，缺了/坏了就退回 Z 形近似并在 warnings 里说明。
 */
const exportRouter = createOrthogonalRouter(getRoutingRuntime)

function solveMissingRoutes(edges, boxes, warnings) {
  const need = []
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]
    if (edge === null || typeof edge !== 'object') continue
    if (Array.isArray(edge.points) && edge.points.length > 0) continue
    const style = styleOf(edge)
    if (isOrthogonalEdgeStyle(style) !== true) continue
    if (curvedFromStyle(style) === true) continue
    const fromKey = edge.from === undefined || edge.from === null ? '' : String(edge.from)
    const toKey = edge.to === undefined || edge.to === null ? '' : String(edge.to)
    // 自环（两端同一个节点）由 routeForEdge 单独画：交给避障求解只会得到"两端同一点"。
    if (fromKey.length > 0 && fromKey === toKey) continue
    need.push(Object.assign({}, edge, { from: fromKey.length > 0 ? fromKey : edge.from, to: toKey.length > 0 ? toKey : edge.to }))
  }
  if (need.length === 0) return new Map()
  try {
    const routes = exportRouter.solve(need, boxes)
    const out = new Map()
    for (const id of Object.keys(routes)) {
      const points = routes[id]
      if (Array.isArray(points) && points.length > 0) out.set(id, points)
    }
    return out
  } catch (error) {
    warnings.push(
      '自动避障引擎不可用（' + (error instanceof Error ? error.message : String(error)) + '），没有折点的正交连线按 Z 形近似',
    )
    return new Map()
  }
}

/** 与客户端同一套数字（src/client.js:407-461）。改这里就要同步那边，反之亦然。 */
const GRID = 10
const FSIZE = 12
const LHEIGHT = 14
const FALLBACK_NODE_W = 150
const FALLBACK_NODE_H = 60

/**
 * 导出件里写的 font-family：客户端的 `Helvetica, Arial` 后面补一串常见中文字体。
 *
 * 为什么：画布在浏览器里显示中文靠的是**系统字体回退**（`Helvetica` 里没有汉字，
 * 浏览器按 lang 自己挑一个中文字体）。导出的 SVG 换到没有这一层回退的渲染器里
 * （resvg、Inkscape、某些 CI 的 headless），同一串 `Helvetica, Arial, sans-serif`
 * 就只剩方框。把常见中文系统字体显式列出来，交付物到哪都不至于变豆腐块。
 *
 * 顺序要紧：具名字体必须在 `sans-serif` **之前** —— 通用族一旦匹配上就不会再往后找。
 *
 * 量宽不读这个常量：`textWidth` 是逐字估算（CJK 1em、其余 0.55em，见 `charWidth`），
 * 与渲染时实际命中哪个字体无关，所以换字体不会让断行位置漂移。
 */
const SVG_FONT = 'Helvetica, Arial, "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif'
const ON_DARK_FONT = '#e8e8e8'

/** 浅色：导出交付物的缺省外观（白纸黑线），与画布的白底主题一致。 */
const LIGHT = {
  page: '#ffffff',
  text: '#000000',
  line: '#000000',
  labelBg: '#ffffff',
  default: { fill: '#ffffff', stroke: '#000000' },
}

/** 深色：透明纸 + 浅色字线，贴在深色文档/幻灯片里不突兀。 */
const DARK = {
  page: 'transparent',
  text: '#e8e8e8',
  line: '#c9c9c9',
  labelBg: '#1c1c1c',
  // 与客户端 src/client.js:462 一致：没写 fillColor 的节点在深色主题下是深灰底浅边，
  // 不是白底 —— 白块贴在深色文档里会像漏画了一层。
  default: { fill: '#2a2a2a', stroke: '#c9c9c9' },
}

/** 导出包围盒四周留白（与客户端 exportGeometry 的缺省一致）。 */
const DEFAULT_PADDING = 24
/** 栅格化的硬上限：单边与总像素。超了宁可报错，也不要让 resvg 吃掉几个 GB。 */
const MAX_SIDE = 16384
const MAX_PIXELS = 32000000

// ── 小工具 ──────────────────────────────────────────────────────────────

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const snapTo = (value, grid) => Math.round(value / grid) * grid
const fmt = (value) => {
  const n = Math.round(numberOr(value, 0) * 100) / 100
  return String(n)
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(text) {
  return escapeXml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 拼属性：值为 null/undefined/'' 的键直接不写（缺省即不画，与客户端一致）。 */
function attrs(map) {
  let out = ''
  for (const key of Object.keys(map)) {
    const value = map[key]
    if (value === null || value === undefined || value === '') continue
    out += ' ' + key + '="' + escapeAttr(String(value)) + '"'
  }
  return out
}

// ── 文字度量与断行（src/client.js:700-754 的宿主版）──────────────────────

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

function textWidth(text, size) {
  const chars = Array.from(String(text))
  let total = 0
  for (let i = 0; i < chars.length; i += 1) total += charWidth(chars[i], size)
  return total
}

function wrapLabel(label, maxWidth, size) {
  const fs = numberOr(size, FSIZE)
  const lines = []
  const paras = String(label).split('\n')
  for (let p = 0; p < paras.length; p += 1) {
    const chars = Array.from(paras[p])
    let current = ''
    for (let i = 0; i < chars.length; i += 1) {
      const nextWidth = textWidth(current + chars[i], fs)
      if (nextWidth > maxWidth && current.length > 0) {
        lines.push(current)
        current = ''
      }
      current += chars[i]
    }
    lines.push(current)
  }
  return lines.length > 0 ? lines : ['']
}

function labelLineHeight(fontSize) {
  return LHEIGHT * (numberOr(fontSize, FSIZE) / FSIZE)
}

// ── 配色（src/client.js:765-813）─────────────────────────────────────────

function parseHexColor(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const short = /^#([0-9a-fA-F]{3})$/.exec(text)
  if (short !== null) {
    const h = short[1]
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) }
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(text)
  if (full !== null) {
    const h = full[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  return null
}

/** 缺省字色只看节点自己的填充：浅底黑字、深底浅字（换主题不改文档里的字色）。 */
function defaultFontOnFill(fill) {
  const rgb = parseHexColor(fill)
  if (rgb === null) return DEFAULT_FONT
  const luma = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
  return luma > 0.55 ? DEFAULT_FONT : ON_DARK_FONT
}

/** `#rrggbbaa` 拆成颜色 + 透明度（SVG 的 fill 不认 8 位十六进制）。 */
function parseCssColor(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  const eight = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(text)
  if (eight !== null) return { color: '#' + eight[1], opacity: Math.round((parseInt(eight[2], 16) / 255) * 1000) / 1000 }
  return { color: text.length > 0 ? text : fallback, opacity: 1 }
}

function styleOf(node) {
  return typeof node.style === 'string' ? node.style : ''
}

function shapeOf(node) {
  return nodeShapeFromStyle(styleOf(node))
}

function colorOf(node, palette) {
  const style = styleOf(node)
  const fill = styleGet(style, 'fillColor', null)
  const stroke = styleGet(style, 'strokeColor', null)
  const font = styleGet(style, 'fontColor', null)
  return {
    fill: fill !== null ? fill : palette.default.fill,
    stroke: stroke !== null ? stroke : palette.default.stroke,
    font: font !== null ? font : defaultFontOnFill(fill !== null ? fill : palette.default.fill),
  }
}

// ── 标签排版（src/client.js:1031-1307）───────────────────────────────────

function labelWraps(node) {
  return styleGet(styleOf(node), 'whiteSpace', 'wrap') !== 'nowrap'
}

function labelInsetsOf(node) {
  const style = styleOf(node)
  const shape = shapeOf(node)
  const section = shape === 'section'
  const base = styleNumber(style, 'spacing', null)
  const lr = base !== null ? base : 6
  const tb = base !== null ? base : 0
  return {
    left: styleNumber(style, 'spacingLeft', section ? 10 : lr),
    right: styleNumber(style, 'spacingRight', lr),
    top: styleNumber(style, 'spacingTop', section ? 6 : tb),
    bottom: styleNumber(style, 'spacingBottom', tb),
    align: styleGet(style, 'align', section || shape === 'swimlane' ? 'left' : 'center'),
    verticalAlign: styleGet(style, 'verticalAlign', section ? 'top' : 'middle'),
    labelPosition: styleGet(style, 'labelPosition', 'center'),
    verticalLabelPosition: styleGet(style, 'verticalLabelPosition', 'middle'),
  }
}

function swimlaneStartSize(node) {
  const n = styleNumber(styleOf(node), 'startSize', 23)
  return n > 0 ? n : 23
}

function labelTextWidth(node, w) {
  const insets = labelInsetsOf(node)
  const shape = shapeOf(node)
  const inner = Math.max(12, w - insets.left - insets.right)
  if (shape === 'diamond') return Math.max(12, inner * 0.6)
  if (shape === 'ellipse') return Math.max(12, inner * 0.72)
  return inner
}

function imageContentRect(node, geo) {
  const label = typeof node.label === 'string' ? node.label : ''
  const insets = labelInsetsOf(node)
  const pos = insets.labelPosition
  const vpos = insets.verticalLabelPosition
  if (label.length === 0 || (pos === 'center' && vpos === 'middle')) {
    return { x: geo.x, y: geo.y, w: geo.w, h: geo.h }
  }
  if (pos === 'center' && (vpos === 'top' || vpos === 'bottom')) {
    const band = Math.max(labelLineHeight(FSIZE), Math.min(geo.h * 0.35, 28))
    if (band > 0) {
      return { x: geo.x, y: vpos === 'top' ? geo.y + band : geo.y, w: geo.w, h: Math.max(1, geo.h - band) }
    }
    return { x: geo.x, y: geo.y, w: geo.w, h: geo.h }
  }
  if (pos === 'right' || pos === 'left') {
    const split = Math.max(Math.min(geo.h, geo.w * 0.45), Math.min(geo.w * 0.5, 28))
    if (pos === 'right') return { x: geo.x, y: geo.y, w: split, h: geo.h }
    return { x: geo.x + geo.w - split, y: geo.y, w: split, h: geo.h }
  }
  if (pos === 'bottom' || pos === 'top') {
    const split = Math.max(Math.min(geo.w, geo.h * 0.45), Math.min(geo.h * 0.5, 28))
    if (pos === 'bottom') return { x: geo.x, y: geo.y, w: geo.w, h: split }
    return { x: geo.x, y: geo.y + geo.h - split, w: geo.w, h: split }
  }
  return { x: geo.x, y: geo.y, w: geo.w, h: geo.h }
}

function labelTextBox(box) {
  const geo = box.geo
  const node = box.node
  const style = styleOf(node)
  const insets = labelInsetsOf(node)
  const fontSize = numberOr(box.fontSize, styleNumber(style, 'fontSize', FSIZE))
  const lineHeight = labelLineHeight(fontSize)
  const text = typeof box.text === 'string' ? box.text : typeof node.label === 'string' ? node.label : ''
  const shape = shapeOf(node)

  let areaX = geo.x
  let areaY = geo.y
  let areaW = geo.w
  let areaH = geo.h
  if (shape === 'swimlane') {
    areaH = Math.min(geo.h, swimlaneStartSize(node))
  } else if ((shape === 'image' || shape === 'svg') && text.length > 0) {
    const pos = insets.labelPosition
    const vpos = insets.verticalLabelPosition
    if (pos === 'right' || pos === 'left') {
      const img = imageContentRect(node, geo)
      if (pos === 'right') {
        areaX = img.x + img.w
        areaW = Math.max(12, geo.w - img.w)
      } else {
        areaW = Math.max(12, geo.w - img.w)
      }
    } else if (pos === 'bottom' || pos === 'top') {
      const img = imageContentRect(node, geo)
      if (pos === 'bottom') {
        areaY = img.y + img.h
        areaH = Math.max(lineHeight, geo.h - img.h)
      } else {
        areaH = Math.max(lineHeight, geo.h - img.h)
      }
    } else if (vpos === 'top' || vpos === 'bottom') {
      const band = Math.max(lineHeight + insets.top + insets.bottom, Math.min(geo.h * 0.35, 28))
      if (vpos === 'top') areaH = band
      else {
        areaY = geo.y + geo.h - band
        areaH = band
      }
    }
  }

  const w = Math.max(12, labelTextWidth(Object.assign({}, node, { w: areaW, h: areaH }), areaW))
  const cols = labelWraps(node) ? wrapLabel(text, w, fontSize).length : String(text).split('\n').length
  const h = Math.max(lineHeight * cols, lineHeight)

  const innerX = areaX + insets.left
  const innerRight = areaX + areaW - insets.right
  const innerY = areaY + insets.top
  const innerBottom = areaY + areaH - insets.bottom
  let x
  if (insets.align === 'left') x = innerX
  else if (insets.align === 'right') x = innerRight - w
  else x = (innerX + innerRight - w) / 2
  let y
  if (insets.verticalAlign === 'top') y = innerY
  else if (insets.verticalAlign === 'bottom') y = innerBottom - h
  else y = (innerY + innerBottom - h) / 2

  return { x: x, y: y, w: w, h: h, fontSize: fontSize, lineHeight: lineHeight, align: insets.align, verticalAlign: insets.verticalAlign }
}

/** 标签文字实际占的框（换行后最宽一行 + 行数），用于导出包围盒。 */
function labelPaintBounds(node, geo) {
  const label = typeof node.label === 'string' ? node.label : ''
  if (label.length === 0) return null
  if (isVideoNode(node)) return null
  const style = styleOf(node)
  const fontSize = styleNumber(style, 'fontSize', FSIZE)
  const lineHeight = labelLineHeight(fontSize)
  const box = labelTextBox({ node: node, geo: geo, fontSize: fontSize })
  const lines = labelWraps(node) ? wrapLabel(label, box.w, fontSize) : label.split('\n')
  let widest = 0
  for (let i = 0; i < lines.length; i += 1) {
    const w = textWidth(lines[i], fontSize)
    if (w > widest) widest = w
  }
  const align = box.align === 'left' || box.align === 'right' ? box.align : 'center'
  const cx = align === 'left' ? box.x : align === 'right' ? box.x + box.w : box.x + box.w / 2
  const first = box.y + lineHeight / 2
  return {
    minX: align === 'left' ? cx : align === 'right' ? cx - widest : cx - widest / 2,
    maxX: align === 'left' ? cx + widest : align === 'right' ? cx : cx + widest / 2,
    minY: first - lineHeight / 2,
    maxY: first + (lines.length - 1) * lineHeight + lineHeight / 2,
  }
}

/**
 * 节点"装得下自己的文字"需要多高（src/client.js:1272）。
 *
 * 与客户端同一个口径，是为了让导出里被文字撑高的节点**也**按撑高后的高度画，
 * 否则多行标签的下半截会落到框外。
 */
function nodeTextFitHeight(node) {
  if (!labelWraps(node)) return 0
  const shape = shapeOf(node)
  if (shape === 'image') return 0
  if (shape === 'text' || shape === 'section' || shape === 'swimlane' || shape === 'svg' || shape === 'video') return 0
  const w = numberOr(node.w, FALLBACK_NODE_W)
  const label = typeof node.label === 'string' ? node.label : ''
  if (label.length === 0) return 0
  const fontSize = styleNumber(styleOf(node), 'fontSize', FSIZE)
  const lines = wrapLabel(label, labelTextWidth(node, w), fontSize).length
  if (lines <= 1) return 0
  return (lines + 1) * labelLineHeight(fontSize)
}

function nodeBoxOf(node) {
  const w = numberOr(node.w, FALLBACK_NODE_W)
  const stored = numberOr(node.h, FALLBACK_NODE_H)
  const need = nodeTextFitHeight(node)
  if (need > stored) return { x: numberOr(node.x, 0), y: numberOr(node.y, 0), w: w, h: snapTo(need, GRID) }
  return { x: numberOr(node.x, 0), y: numberOr(node.y, 0), w: w, h: stored }
}

/** 视频节点由客户端组件画（帧序列/播放器），导出只给通用形状 —— 也不吃标签。 */
function isVideoNode(node) {
  const data = node !== null && typeof node === 'object' ? node.data : null
  return data !== null && typeof data === 'object' && (typeof data.videoClip === 'string' || typeof data.motion === 'object')
}

// ── 路径序列化（src/client.js:2469-2507）───────────────────────────────

function dedupePoints(points) {
  const out = []
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]
    if (out.length > 0) {
      const prev = out[out.length - 1]
      if (Math.abs(prev.x - p.x) < 0.01 && Math.abs(prev.y - p.y) < 0.01) continue
    }
    out.push({ x: p.x, y: p.y })
  }
  return out
}

function pathOf(rawPoints, radius, curved) {
  const pts = dedupePoints(rawPoints)
  if (pts.length < 2) return ''
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  if (curved === true) {
    if (pts.length === 2) return 'M ' + fmt(pts[0].x) + ' ' + fmt(pts[0].y) + ' L ' + fmt(pts[1].x) + ' ' + fmt(pts[1].y)
    let d = 'M ' + fmt(pts[0].x) + ' ' + fmt(pts[0].y)
    for (let i = 1; i < pts.length - 1; i += 1) {
      const end = i === pts.length - 2 ? pts[pts.length - 1] : mid(pts[i], pts[i + 1])
      d += ' Q ' + fmt(pts[i].x) + ' ' + fmt(pts[i].y) + ' ' + fmt(end.x) + ' ' + fmt(end.y)
    }
    return d
  }
  const r = Math.max(0, numberOr(radius, 0))
  let d = 'M ' + fmt(pts[0].x) + ' ' + fmt(pts[0].y)
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    if (r <= 0) {
      d += ' L ' + fmt(cur.x) + ' ' + fmt(cur.y)
      continue
    }
    const d1 = Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y)
    const d2 = Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y)
    const rr = Math.min(r, d1 / 2, d2 / 2)
    if (rr <= 0.01) {
      d += ' L ' + fmt(cur.x) + ' ' + fmt(cur.y)
      continue
    }
    const len1 = Math.hypot(cur.x - prev.x, cur.y - prev.y) || 1
    const len2 = Math.hypot(next.x - cur.x, next.y - cur.y) || 1
    const a = { x: cur.x - ((cur.x - prev.x) / len1) * rr, y: cur.y - ((cur.y - prev.y) / len1) * rr }
    const b = { x: cur.x + ((next.x - cur.x) / len2) * rr, y: cur.y + ((next.y - cur.y) / len2) * rr }
    d += ' L ' + fmt(a.x) + ' ' + fmt(a.y) + ' Q ' + fmt(cur.x) + ' ' + fmt(cur.y) + ' ' + fmt(b.x) + ' ' + fmt(b.y)
  }
  const last = pts[pts.length - 1]
  d += ' L ' + fmt(last.x) + ' ' + fmt(last.y)
  return d
}

// ── 连线上文字的落点与"给字让路"（src/client.js:5924-6196）──────────────

function arcLengths(pts) {
  const segs = []
  let total = 0
  for (let i = 1; i < pts.length; i += 1) {
    const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
    segs.push(len)
    total += len
  }
  return { segs: segs, total: total }
}

function pointAtArc(pts, segs, d) {
  let acc = 0
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i]
    if (d <= acc + seg || i === segs.length - 1) {
      const t = seg === 0 ? 0 : Math.max(0, Math.min(1, (d - acc) / seg))
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }
    }
    acc += seg
  }
  return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y }
}

/** drawio 的边标签落点：沿弧长的中点，拖过就按 labelX/labelY 的相对量。 */
function edgeLabelPointAt(pts, x, y, offsetX, offsetY) {
  if (Array.isArray(pts) === false || pts.length < 2) return null
  const segs = []
  let total = 0
  for (let i = 1; i < pts.length; i += 1) {
    const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
    segs.push(len)
    total += len
  }
  if (total <= 0) return null
  const gx = (Number.isFinite(Number(x)) ? Number(x) : 0) / 2
  let dist = Math.round((gx + 0.5) * total)
  if (dist < 0) dist = 0
  if (dist > total) dist = total
  let acc = 0
  let index = 0
  while (index < segs.length - 1 && dist >= Math.round(acc + segs[index])) {
    acc += segs[index]
    index += 1
  }
  const seg = segs[index]
  const factor = seg === 0 ? 0 : (dist - acc) / seg
  const p0 = pts[index]
  const pe = pts[index + 1]
  if (p0 === undefined || pe === undefined) return null
  const dx = pe.x - p0.x
  const dy = pe.y - p0.y
  const nx = seg === 0 ? 0 : dy / seg
  const ny = seg === 0 ? 0 : dx / seg
  const perp = Number.isFinite(Number(y)) ? Number(y) : 0
  const ox = Number.isFinite(Number(offsetX)) ? Number(offsetX) : 0
  const oy = Number.isFinite(Number(offsetY)) ? Number(offsetY) : 0
  return { x: p0.x + dx * factor + (nx * perp + ox), y: p0.y + dy * factor - (ny * perp - oy) }
}

function labelBox(pos, text, fontSize) {
  if (pos === null || pos === undefined) return null
  const lines = String(text || '').split('\n')
  let widest = 0
  for (let i = 0; i < lines.length; i += 1) widest = Math.max(widest, textWidth(lines[i], fontSize))
  const w = widest + 6
  const h = labelLineHeight(fontSize) * lines.length + 2
  return { x: pos.x - w / 2, y: pos.y + 1 - h / 2, w: w, h: h }
}

const growBox = (box, pad) => ({ x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 })

/** 标签压在线上时，线要在它这块区域里断开 —— drawio 的观感：字的位置不画线。 */
function labelGapsOnPath(pts, box) {
  if (Array.isArray(pts) === false || pts.length < 2) return []
  if (box === null || box === undefined) return []
  const segs = arcLengths(pts).segs
  const gaps = []
  let acc = 0
  for (let i = 0; i < segs.length; i += 1) {
    const a = pts[i]
    const b = pts[i + 1]
    const seg = segs[i]
    if (seg > 0) {
      if (Math.abs(a.y - b.y) < 0.5) {
        if (a.y >= box.y && a.y <= box.y + box.h) {
          const from = Math.max(Math.min(a.x, b.x), box.x)
          const to = Math.min(Math.max(a.x, b.x), box.x + box.w)
          if (to > from) {
            const s0 = a.x <= b.x ? acc + (from - a.x) : acc + (a.x - from)
            const s1 = a.x <= b.x ? acc + (to - a.x) : acc + (a.x - to)
            gaps.push({ from: Math.min(s0, s1), to: Math.max(s0, s1) })
          }
        }
      } else if (Math.abs(a.x - b.x) < 0.5) {
        if (a.x >= box.x && a.x <= box.x + box.w) {
          const from = Math.max(Math.min(a.y, b.y), box.y)
          const to = Math.min(Math.max(a.y, b.y), box.y + box.h)
          if (to > from) {
            const s0 = a.y <= b.y ? acc + (from - a.y) : acc + (a.y - from)
            const s1 = a.y <= b.y ? acc + (to - a.y) : acc + (a.y - to)
            gaps.push({ from: Math.min(s0, s1), to: Math.max(s0, s1) })
          }
        }
      }
    }
    acc += seg
  }
  gaps.sort((x, y) => x.from - y.from)
  const merged = []
  for (let i = 0; i < gaps.length; i += 1) {
    const last = merged[merged.length - 1]
    if (last !== undefined && gaps[i].from <= last.to) last.to = Math.max(last.to, gaps[i].to)
    else merged.push({ from: gaps[i].from, to: gaps[i].to })
  }
  return merged
}

/** 按弧长区间把折线挖空；两端各留一小截，免得长标签把整条线（连箭头）吃掉。 */
function cutPathByGaps(pts, gaps) {
  if (Array.isArray(gaps) === false || gaps.length === 0) return [pts]
  const lengths = arcLengths(pts)
  const segs = lengths.segs
  const total = lengths.total
  if (total <= 0) return [pts]
  const keep = Math.min(8, total * 0.2)
  const kept = []
  let cursor = 0
  for (let i = 0; i < gaps.length; i += 1) {
    const from = Math.max(keep, gaps[i].from)
    const to = Math.min(total - keep, gaps[i].to)
    if (to <= from) continue
    if (from > cursor) kept.push([cursor, from])
    cursor = Math.max(cursor, to)
  }
  if (cursor < total) kept.push([cursor, total])
  const out = []
  for (let k = 0; k < kept.length; k += 1) {
    const a = kept[k][0]
    const b = kept[k][1]
    if (b - a <= 0.01) continue
    const sub = [pointAtArc(pts, segs, a)]
    let acc = 0
    for (let i = 0; i < segs.length; i += 1) {
      acc += segs[i]
      if (acc > a + 0.01 && acc < b - 0.01) sub.push({ x: pts[i + 1].x, y: pts[i + 1].y })
    }
    sub.push(pointAtArc(pts, segs, b))
    out.push(sub)
  }
  return out.length > 0 ? out : [pts]
}

// ── 形状（src/client.js:2509-2731）──────────────────────────────────────

function shapeSvg(node, geo, palette, warnings) {
  const style = styleOf(node)
  const shape = shapeOf(node)
  const colors = colorOf(node, palette)
  const common = {
    fill: colors.fill,
    stroke: colors.stroke,
    'stroke-width': fmt(styleNumber(style, 'strokeWidth', 1)),
  }
  const fillOpacity = Math.max(0, Math.min(100, styleNumber(style, 'fillOpacity', 100))) / 100
  const strokeOpacity = Math.max(0, Math.min(100, styleNumber(style, 'strokeOpacity', 100))) / 100
  if (fillOpacity < 1) common['fill-opacity'] = fmt(fillOpacity)
  if (strokeOpacity < 1) common['stroke-opacity'] = fmt(strokeOpacity)
  const dash = dashPatternFromStyle(style)
  if (dash !== null) common['stroke-dasharray'] = dash

  const x = geo.x
  const y = geo.y
  const w = geo.w
  const h = geo.h

  if (shape === 'text') {
    return ''
  }
  if (shape === 'section') {
    const section = Object.assign({}, common, { x: fmt(x), y: fmt(y), width: fmt(w), height: fmt(h), rx: 4, ry: 4 })
    if (styleGet(style, 'fillColor', null) === null) section.fill = '#f5f5f5'
    if (dash === null) section['stroke-dasharray'] = '6 3'
    return '<rect' + attrs(section) + '/>'
  }
  if (shape === 'swimlane') {
    const startSize = swimlaneStartSize(node)
    const header = Math.min(h, startSize)
    const body = Object.assign({}, common, { x: fmt(x), y: fmt(y), width: fmt(w), height: fmt(h) })
    if (styleGet(style, 'fillColor', null) === null) body.fill = '#ffffff'
    const headFill = styleGet(style, 'swimlaneFillColor', null)
    const parts = ['<rect' + attrs(body) + '/>']
    parts.push('<rect' + attrs({
      x: fmt(x), y: fmt(y), width: fmt(w), height: fmt(header),
      fill: headFill !== null ? headFill : body.fill, stroke: 'none',
    }) + '/>')
    parts.push('<line' + attrs({
      x1: fmt(x), y1: fmt(y + header), x2: fmt(x + w), y2: fmt(y + header),
      stroke: colors.stroke, 'stroke-width': fmt(styleNumber(style, 'strokeWidth', 1)),
    }) + '/>')
    return parts.join('')
  }
  if (shape === 'svg' || shape === 'image') {
    const href = imageValueFromStyle(style)
    const rect = imageContentRect(node, geo)
    const usable = typeof href === 'string' && /^data:image\//i.test(href)
    if (usable === false) {
      warnings.push('图片/SVG 节点 "' + String(node.id) + '" 的 image= 不可解析，导出为虚线占位框')
      return '<rect' + attrs({
        x: fmt(rect.x + 0.5), y: fmt(rect.y + 0.5), width: fmt(Math.max(1, rect.w - 1)), height: fmt(Math.max(1, rect.h - 1)),
        fill: 'none', stroke: colors.stroke, 'stroke-width': 1, 'stroke-dasharray': '3 3',
      }) + '/>'
    }
    // imageAspect=1 等比居中、0/缺省拉伸铺满（drawio 语义）；位图缺省 1、svg 缺省 0。
    const fit = styleGet(style, 'imageAspect', shape === 'image' ? '1' : '0') === '1'
    return '<image' + attrs({
      x: fmt(rect.x), y: fmt(rect.y), width: fmt(rect.w), height: fmt(rect.h),
      href: href, 'preserveAspectRatio': fit ? 'xMidYMid meet' : 'none',
    }) + '/>'
  }
  if (shape === 'ellipse') {
    return '<ellipse' + attrs(Object.assign({}, common, {
      cx: fmt(x + w / 2), cy: fmt(y + h / 2), rx: fmt(w / 2), ry: fmt(h / 2),
    })) + '/>'
  }
  if (shape === 'diamond') {
    return '<polygon' + attrs(Object.assign({}, common, {
      points: [x + w / 2, y, x + w, y + h / 2, x + w / 2, y + h, x, y + h / 2].map(fmt).join(' '),
    })) + '/>'
  }
  if (shape === 'parallelogram') {
    const s = Math.min(w * 0.2, 24)
    return '<polygon' + attrs(Object.assign({}, common, {
      points: [x + s, y, x + w, y, x + w - s, y + h, x, y + h].map(fmt).join(' '),
    })) + '/>'
  }
  if (shape === 'hexagon') {
    const s = Math.min(w * 0.15, 20)
    return '<polygon' + attrs(Object.assign({}, common, {
      points: [x + s, y, x + w - s, y, x + w, y + h / 2, x + w - s, y + h, x + s, y + h, x, y + h / 2].map(fmt).join(' '),
    })) + '/>'
  }
  if (shape === 'cylinder') {
    const ry = Math.min(h * 0.18, 14)
    const body = ['M', fmt(x), fmt(y + ry), 'A', fmt(w / 2), fmt(ry), '0', '0', '1', fmt(x + w), fmt(y + ry),
      'L', fmt(x + w), fmt(y + h - ry), 'A', fmt(w / 2), fmt(ry), '0', '0', '1', fmt(x), fmt(y + h - ry), 'Z'].join(' ')
    const lid = ['M', fmt(x), fmt(y + ry), 'A', fmt(w / 2), fmt(ry), '0', '0', '0', fmt(x + w), fmt(y + ry)].join(' ')
    return '<path' + attrs(Object.assign({}, common, { d: body })) + '/>' +
      '<path' + attrs(Object.assign({}, common, { d: lid, fill: 'none' })) + '/>'
  }
  if (shape === 'document') {
    const d = ['M', fmt(x), fmt(y), 'L', fmt(x + w), fmt(y), 'L', fmt(x + w), fmt(y + h * 0.82),
      'C', fmt(x + w * 0.75), fmt(y + h * 1.06), fmt(x + w * 0.25), fmt(y + h * 0.58), fmt(x), fmt(y + h * 0.86), 'Z'].join(' ')
    return '<path' + attrs(Object.assign({}, common, { d: d })) + '/>'
  }
  // 其余（rect / rounded / stadium）：drawio 的圆角是 rounded=1 + arcSize（百分比，缺省 15%）。
  let rx = 0
  if (shape === 'rounded' || shape === 'stadium') {
    const arc = styleNumber(style, 'arcSize', null)
    rx = shape === 'stadium' ? h / 2 : Math.min(w, h) * (arc === null ? 0.15 : arc / 100)
  }
  const rect = Object.assign({}, common, { x: fmt(x), y: fmt(y), width: fmt(w), height: fmt(h) })
  if (rx > 0) {
    rect.rx = fmt(rx)
    rect.ry = fmt(rx)
  }
  return '<rect' + attrs(rect) + '/>'
}

// ── 文字 ────────────────────────────────────────────────────────────────

/**
 * 一行文字 → `<text>` + 每行一个 `<tspan>`。
 *
 * 基线偏移手算（`top + lineHeight/2 + 0.35em`）而不用 `dominant-baseline="middle"`：
 * 浏览器、resvg、Inkscape 对那个属性各有各的解释，手算的版本在哪都一样。
 */
function textSvg(spec) {
  const lines = Array.isArray(spec.lines) ? spec.lines : ['']
  const fontSize = numberOr(spec.fontSize, FSIZE)
  const lineHeight = numberOr(spec.lineHeight, labelLineHeight(fontSize))
  const baseline = numberOr(spec.top, 0) + lineHeight / 2 + fontSize * 0.35
  const spans = lines.map((line, i) => '<tspan' + attrs({ x: fmt(spec.x), dy: i === 0 ? 0 : fmt(lineHeight) }) + '>' +
    escapeXml(line) + '</tspan>').join('')
  const opacity = numberOr(spec.opacity, 1)
  return '<text' + attrs({
    x: fmt(spec.x),
    y: fmt(baseline),
    'text-anchor': spec.anchor === 'start' || spec.anchor === 'end' ? spec.anchor : 'middle',
    'font-family': spec.family || SVG_FONT,
    'font-size': fmt(fontSize),
    fill: spec.fill,
    'fill-opacity': opacity < 1 ? fmt(opacity) : null,
    'xml:space': 'preserve',
  }) + '>' + spans + '</text>'
}

function nodeLabelSvg(node, geo, palette) {
  const label = typeof node.label === 'string' ? node.label : ''
  if (label.length === 0) return ''
  if (isVideoNode(node)) return ''
  const style = styleOf(node)
  const shape = shapeOf(node)
  if (shape === 'text') {
    // 独立文字：没有框，直接按标签盒居中画（与客户端同一套 labelTextBox）。
    const box = labelTextBox({ node: node, geo: geo, fontSize: styleNumber(style, 'fontSize', FSIZE) })
    const lines = labelWraps(node) ? wrapLabel(label, box.w, box.fontSize) : label.split('\n')
    const align = box.align === 'left' || box.align === 'right' ? box.align : 'center'
    const x = align === 'left' ? box.x : align === 'right' ? box.x + box.w : box.x + box.w / 2
    return textSvg({
      x: x, top: box.y, lines: lines, fontSize: box.fontSize, lineHeight: box.lineHeight,
      anchor: align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle',
      fill: colorOf(node, palette).font,
      opacity: Math.max(0, Math.min(100, styleNumber(style, 'textOpacity', 100))) / 100,
    })
  }
  const fontSize = styleNumber(style, 'fontSize', FSIZE)
  const box = labelTextBox({ node: node, geo: geo, fontSize: fontSize })
  const lines = labelWraps(node) ? wrapLabel(label, box.w, fontSize) : String(label).split('\n')
  const align = box.align === 'left' || box.align === 'right' ? box.align : 'center'
  const x = align === 'left' ? box.x : align === 'right' ? box.x + box.w : box.x + box.w / 2
  return textSvg({
    x: x, top: box.y, lines: lines, fontSize: fontSize, lineHeight: box.lineHeight,
    anchor: align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle',
    fill: colorOf(node, palette).font,
    opacity: Math.max(0, Math.min(100, styleNumber(style, 'textOpacity', 100))) / 100,
  })
}

// ── 连线 ────────────────────────────────────────────────────────────────

function hiddenLayerIds(doc) {
  const set = new Set()
  const layers = Array.isArray(doc.layers) ? doc.layers : []
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i]
    if (layer !== null && typeof layer === 'object' && layer.visible === false) set.add(String(layer.id))
  }
  return set
}

function isHiddenCell(hidden, cell) {
  return cell.layer !== undefined && cell.layer !== null && hidden.has(String(cell.layer))
}

/** 节点几何：文档里的宽高 + 被文字撑高的那一份（客户端 nodeBoxOf 的宿主版）。 */
export function exportBoxes(doc) {
  const hidden = hiddenLayerIds(doc)
  const boxes = []
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node === null || typeof node !== 'object') continue
    if (isHiddenCell(hidden, node)) continue
    boxes.push({ id: String(node.id), node: node, geo: nodeBoxOf(node) })
  }
  return boxes
}

/**
 * 把一条带用户折点的连线**掰成直角**（客户端 `routeThroughWaypoints` 的简化版）。
 *
 * 为什么需要：`routeEdgeStyled` 对"手动/普通正交"的边不直接画存下来的折点，而是
 * 逐个折点补拐角 —— 上一段横就先横后竖、上一段竖就先竖后横，最后一段垂直于落点所在的边。
 * 导出若照抄折点，中间会多出斜线段（demo.drawio 里三条边都这样），与画布上看到的不是一个东西。
 *
 * 只处理"斜的"那一段：已经是横/竖的段原样保留，用户折点一个不丢、顺序也不变。
 */
function orthogonalizeRoute(points, style) {
  if (Array.isArray(points) === false || points.length < 2) return points
  const sourceSide = sideFromStyle(style, 'source')
  const targetSide = sideFromStyle(style, 'target')
  const sideIsHorizontal = (side) => side === 'e' || side === 'w'
  const sideIsVertical = (side) => side === 'n' || side === 's'
  const out = [{ x: points[0].x, y: points[0].y }]
  for (let i = 1; i < points.length; i += 1) {
    const prev = out[out.length - 1]
    const next = { x: points[i].x, y: points[i].y }
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    if (Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01) {
      out.push(next)
      continue
    }
    // 拐弯方向跟着行进方向走：上一段是横的 → 先横后竖；是竖的 → 先竖后横。
    let horizontalFirst
    const last = out.length > 1 ? out[out.length - 2] : null
    if (last !== null && Math.abs(prev.y - last.y) < 0.01) horizontalFirst = true
    else if (last !== null && Math.abs(prev.x - last.x) < 0.01) horizontalFirst = false
    else if (i === 1 && sideIsHorizontal(sourceSide)) horizontalFirst = true
    else if (i === 1 && sideIsVertical(sourceSide)) horizontalFirst = false
    else horizontalFirst = Math.abs(dx) >= Math.abs(dy)
    // 最后一段必须垂直于落点所在的边：从左边进就横着进，从上面进就竖着进。
    if (i === points.length - 1) {
      if (sideIsHorizontal(targetSide)) horizontalFirst = false
      else if (sideIsVertical(targetSide)) horizontalFirst = true
    }
    out.push(horizontalFirst ? { x: next.x, y: prev.y } : { x: prev.x, y: next.y })
    out.push(next)
  }
  // 相邻重复点（折返时可能出现）去掉，否则 pathOf 的圆角会算出一段零长。
  const dedup = [out[0]]
  for (let i = 1; i < out.length; i += 1) {
    const prev = dedup[dedup.length - 1]
    if (Math.abs(out[i].x - prev.x) > 0.01 || Math.abs(out[i].y - prev.y) > 0.01) dedup.push(out[i])
  }
  return dedup
}

const EDGE_SIDE_ORDER = ['e', 's', 'w', 'n']

function nextSideOf(side) {
  const at = EDGE_SIDE_ORDER.indexOf(side)
  return EDGE_SIDE_ORDER[(at < 0 ? 0 : at + 1) % EDGE_SIDE_ORDER.length]
}

/** 盒子某一侧中心落在边框上的点（自环的起止点，与客户端 sideBorderPoint:2191 同一口径）。 */
function sideCenterOf(geo, side) {
  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  if (side === 'n') return { x: cx, y: geo.y }
  if (side === 's') return { x: cx, y: geo.y + geo.h }
  if (side === 'w') return { x: geo.x, y: cy }
  return { x: geo.x + geo.w, y: cy }
}

/** 从某一侧往外推 `inset` 的桩点：它决定首/末段所在的那条线（客户端 stubPointFor:1807）。 */
function stubPointOf(geo, side, inset) {
  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  if (side === 'n') return { x: cx, y: geo.y - inset }
  if (side === 's') return { x: cx, y: geo.y + geo.h + inset }
  if (side === 'w') return { x: geo.x - inset, y: cy }
  return { x: geo.x + geo.w + inset, y: cy }
}

/**
 * 自环：`from === to` 的边，绕回同一个盒子（客户端 `selfLoopPath`，src/client.js:2218）。
 *
 * 为什么不能走 storedRoute：两端在同一个盒子上，裁出来的边框点是同一个点，
 * 折线只剩一个点 —— 整条边被丢掉，还会顺手报一句"两端都落不到任何节点上"，
 * 而画布上它明明画得好好的。
 *
 * 形状规则与客户端一致：一侧横、一侧竖（e → s）时，唯一拐点取"横那侧的 x + 竖那侧的 y"；
 * 两侧相对（e → w 走盒子上下、n → s 走盒子左右）时绕出去一圈。用户摆过折点的按折点穿过去。
 */
function selfLoopRoute(geo, style, waypoints) {
  const horizontalSide = (side) => side === 'e' || side === 'w'
  const source = sideFromStyle(style, 'source') || 'e'
  let target = sideFromStyle(style, 'target') || nextSideOf(source)
  if (target === source) target = nextSideOf(source)
  const jetty = styleNumber(style, 'jettySize', 0)
  const inset = Number.isFinite(jetty) && jetty > 0 ? jetty : 35
  const p0 = sideCenterOf(geo, source)
  const p1 = sideCenterOf(geo, target)
  const s = stubPointOf(geo, source, inset)
  const t = stubPointOf(geo, target, inset)
  const pts = [p0, s]
  const chain = Array.isArray(waypoints) ? waypoints : []
  if (chain.length > 0) {
    for (let i = 0; i < chain.length; i += 1) {
      const point = chain[i]
      if (point === null || typeof point !== 'object') continue
      const x = Number(point.x)
      const y = Number(point.y)
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x: x, y: y })
    }
  } else if (horizontalSide(source) !== horizontalSide(target)) {
    const horizontal = horizontalSide(source) ? s : t
    const vertical = horizontalSide(source) ? t : s
    pts.push({ x: horizontal.x, y: vertical.y })
  } else if (horizontalSide(source)) {
    // 相对的左右两侧：从盒子上/下绕过去（e → w 走上边，w → e 走下边）。
    const viaY = source === 'e' ? geo.y - inset : geo.y + geo.h + inset
    pts.push({ x: s.x, y: viaY }, { x: t.x, y: viaY })
  } else {
    // 相对的上下两侧：从盒子左/右绕过去（n → s 走右边，s → n 走左边）。
    const viaX = source === 'n' ? geo.x + geo.w + inset : geo.x - inset
    pts.push({ x: viaX, y: s.y }, { x: viaX, y: t.y })
  }
  // 桩点 t 始终保留：末段要从 target 那侧的法线方向回到边框，少了它最后一段会斜着插进盒子。
  pts.push(t, p1)
  const orthogonal = isOrthogonalEdgeStyle(style) === true && curvedFromStyle(style) !== true
  return orthogonal ? orthogonalizeRoute(dedupePoints(pts), style) : dedupePoints(pts)
}

function routeForEdge(edge, boxes, state) {
  const own = Array.isArray(edge.points) ? edge.points : []
  // storedRoute 用严格相等找端点，文档里 id 可能是数字也可能是字符串 —— 这里统一成字符串。
  const probe = Object.assign({}, edge, {
    from: edge.from === undefined || edge.from === null ? edge.from : String(edge.from),
    to: edge.to === undefined || edge.to === null ? edge.to : String(edge.to),
  })
  const style = styleOf(edge)
  // 自环：两端在同一个盒子上。storedRoute 会把两端裁到同一条边上、剩下的点不足两个，
  // 整条边会静默消失；这里照客户端 selfLoopPath 的形状单独画（用户的折点照样穿过）。
  if (probe.from !== undefined && probe.from !== null && String(probe.from) === String(probe.to)) {
    const box = state.byId instanceof Map ? state.byId.get(String(probe.from)) : undefined
    if (box === undefined) return null
    return selfLoopRoute(box.geo, style, own)
  }
  // 没有折点的正交边：先用宿主路由器算出来的走线，再交给 storedRoute 裁两端的边框交点。
  // 只要有一个折点就用它（引擎常常只给一个拐点），空数组 = 这次没算出来。
  const solved = own.length === 0 ? state.routed.get(String(edge.id)) : null
  const usedSolved = Array.isArray(solved) && solved.length >= 1
  if (usedSolved) probe.points = solved
  const routed = storedRoute(probe, boxes)
  if (routed === null || routed.length < 2) return null
  const orthogonal = isOrthogonalEdgeStyle(style) === true && curvedFromStyle(style) !== true
  if (own.length > 0 || usedSolved) {
    // 存下来的折点只当"必经点"，拐角要自己补 —— 否则会画出斜线段。
    return orthogonal ? orthogonalizeRoute(routed, style) : routed
  }
  // 引擎没接上（或不是正交边）时，退化成一条 Z 线，并在 warnings 里说清楚这次是估算。
  if (curvedFromStyle(style) === true) return routed
  const a = routed[0]
  const b = routed[routed.length - 1]
  if (Math.abs(b.x - a.x) < 0.5 || Math.abs(b.y - a.y) < 0.5) return routed
  state.warnings.push('连线 "' + String(edge.id) + '" 没有折点，正交走线按 Z 形近似')
  if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) {
    const mx = (a.x + b.x) / 2
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]
  }
  const my = (a.y + b.y) / 2
  return [a, { x: a.x, y: my }, { x: b.x, y: my }, b]
}

function markerIdFor(color, state) {
  if (state.markers.has(color)) return state.markers.get(color)
  const id = 'drawai-export-arrow-' + state.markers.size
  state.markers.set(color, id)
  return id
}

function edgeSvg(edge, boxes, palette, state) {
  const style = styleOf(edge)
  const pts = routeForEdge(edge, boxes, state)
  if (pts === null) {
    state.warnings.push('连线 "' + String(edge.id) + '" 的两端都落不到任何节点上，已跳过')
    return null
  }
  const stroke = styleGet(style, 'strokeColor', null)
  const lineStroke = stroke !== null ? stroke : palette.line
  const curved = curvedFromStyle(style) === true
  // drawio 的圆角半径：arcSize（缺省 20）再除以 2 → 缺省 10px。
  const cornerRadius = styleGet(style, 'rounded', '0') === '1' ? Math.max(0, styleNumber(style, 'arcSize', 20) / 2) : 0

  const labelFontSize = styleNumber(style, 'fontSize', 10)
  const hasLabel = typeof edge.label === 'string' && edge.label.length > 0
  let ownPos = hasLabel ? edgeLabelPointAt(pts, edge.labelX, edge.labelY, edge.labelOffsetX, edge.labelOffsetY) : null
  if (ownPos === null && hasLabel) ownPos = { x: pts[0].x, y: pts[0].y }
  const ownBox = ownPos === null ? null : labelBox(ownPos, edge.label, labelFontSize)

  const gaps = []
  if (ownBox !== null) gaps.push.apply(gaps, labelGapsOnPath(pts, growBox(ownBox, 2)))
  const attached = Array.isArray(state.labels) ? state.labels : []
  for (let L = 0; L < attached.length; L += 1) {
    const item = attached[L]
    if (item === null || typeof item !== 'object' || String(item.edgeId) !== String(edge.id)) continue
    const text = typeof item.text === 'string' ? item.text : ''
    if (text.length === 0) continue
    const pos = edgeLabelPointAt(pts, item.x, item.y, item.offsetX, item.offsetY)
    if (pos === null) continue
    gaps.push.apply(gaps, labelGapsOnPath(pts, growBox(labelBox(pos, text, styleNumber(item.style, 'fontSize', 10)), 2)))
  }

  const subPaths = gaps.length > 0 ? cutPathByGaps(pts, gaps) : [pts]
  const d = subPaths.map((sub) => pathOf(sub, cornerRadius, curved)).filter((text) => text.length > 0).join(' ')
  if (d.length === 0) return null

  const arrow = arrowFromStyle(style)
  const dash = dashPatternFromStyle(style)
  const strokeOpacity = Math.max(0, Math.min(100, styleNumber(style, 'strokeOpacity', 100))) / 100
  const parts = []
  parts.push('<path' + attrs({
    d: d,
    fill: 'none',
    stroke: lineStroke,
    'stroke-width': fmt(styleNumber(style, 'strokeWidth', 1)),
    'stroke-opacity': strokeOpacity < 1 ? fmt(strokeOpacity) : null,
    'stroke-dasharray': dash,
    'stroke-linejoin': curved ? 'round' : null,
    'marker-end': arrow === 'none' || arrow === 'start' ? null : 'url(#' + markerIdFor(lineStroke, state) + '-end)',
    'marker-start': arrow === 'both' || arrow === 'start' ? 'url(#' + markerIdFor(lineStroke, state) + '-start)' : null,
  }) + '/>')

  if (ownBox !== null) {
    const ownBg = styleGet(style, 'labelBackgroundColor', null)
    if (ownBg !== null) {
      const bg = parseCssColor(ownBg, palette.labelBg)
      parts.push('<rect' + attrs({
        x: fmt(ownBox.x), y: fmt(ownBox.y), width: fmt(ownBox.w), height: fmt(ownBox.h), rx: 2,
        fill: bg.color, 'fill-opacity': bg.opacity < 1 ? fmt(bg.opacity) : null,
      }) + '/>')
    }
    const fontColor = styleGet(style, 'fontColor', null)
    parts.push(textSvg({
      x: ownPos.x,
      top: ownPos.y + 1 - (labelLineHeight(labelFontSize) * String(edge.label).split('\n').length) / 2,
      lines: String(edge.label).split('\n'),
      fontSize: labelFontSize,
      lineHeight: labelLineHeight(labelFontSize),
      anchor: 'middle',
      fill: fontColor !== null ? fontColor : palette.text,
      opacity: Math.max(0, Math.min(100, styleNumber(style, 'textOpacity', 100))) / 100,
    }))
  }

  for (let L = 0; L < attached.length; L += 1) {
    const item = attached[L]
    if (item === null || typeof item !== 'object' || String(item.edgeId) !== String(edge.id)) continue
    const text = typeof item.text === 'string' ? item.text : ''
    if (text.length === 0) continue
    const pos = edgeLabelPointAt(pts, item.x, item.y, item.offsetX, item.offsetY)
    if (pos === null) continue
    const fontSize = styleNumber(item.style, 'fontSize', 10)
    const box = labelBox(pos, text, fontSize)
    parts.push('<rect' + attrs({
      x: fmt(box.x), y: fmt(box.y), width: fmt(box.w), height: fmt(box.h), rx: 2,
      fill: palette.labelBg, 'fill-opacity': 0.85,
    }) + '/>')
    parts.push(textSvg({
      x: pos.x,
      top: pos.y + 1 - (labelLineHeight(fontSize) * text.split('\n').length) / 2,
      lines: text.split('\n'),
      fontSize: fontSize,
      lineHeight: labelLineHeight(fontSize),
      anchor: 'middle',
      fill: styleGet(item.style, 'fontColor', null) || palette.text,
      opacity: 1,
    }))
  }

  return { svg: parts.join(''), points: pts, labelBox: ownBox }
}

// ── 组装 ────────────────────────────────────────────────────────────────

function normalizeOptions(options) {
  const raw = options !== null && typeof options === 'object' ? options : {}
  const padding = Number.isFinite(Number(raw.padding)) ? Math.max(0, Number(raw.padding)) : DEFAULT_PADDING
  // `background:'transparent'` 要能压过主题缺省那层白纸 —— 只写 `background:null` 分不清
  // "没给" 与 "明确要透明"，缺省分支会把白底又铺回来。
  const transparent = raw.background === 'transparent' || raw.background === null
  return {
    padding: padding,
    theme: raw.theme === 'dark' ? 'dark' : 'light',
    transparent: transparent,
    background:
      typeof raw.background === 'string' && raw.background.length > 0 && raw.background !== 'transparent'
        ? raw.background
        : null,
    fontFamily: typeof raw.fontFamily === 'string' && raw.fontFamily.length > 0 ? raw.fontFamily : SVG_FONT,
    title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : '',
  }
}

/**
 * 文档对象 → SVG 文本。
 *
 * @returns {{ svg: string, width: number, height: number, viewBox: object, warnings: string[], stats: object }}
 */
export function buildExportSvg(doc, options) {
  const opts = normalizeOptions(options)
  const palette = opts.theme === 'dark' ? DARK : LIGHT
  const warnings = []
  const boxes = exportBoxes(doc)
  const byId = new Map()
  for (let i = 0; i < boxes.length; i += 1) byId.set(boxes[i].id, boxes[i])

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const put = (x, y) => {
    const px = Number(x)
    const py = Number(y)
    if (Number.isFinite(px) === false || Number.isFinite(py) === false) return
    if (px < minX) minX = px
    if (py < minY) minY = py
    if (px > maxX) maxX = px
    if (py > maxY) maxY = py
  }
  const putRect = (rect) => {
    if (rect === null || rect === undefined) return
    put(rect.x, rect.y)
    put(rect.x + rect.w, rect.y + rect.h)
  }
  const putBounds = (bounds) => {
    if (bounds === null || bounds === undefined) return
    put(bounds.minX, bounds.minY)
    put(bounds.maxX, bounds.maxY)
  }

  const body = []
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i]
    const shape = shapeSvg(box.node, box.geo, palette, warnings)
    // 标签必须与形状同组：跨节点叠放时，后画的节点矩形不能盖住前一个节点的字
    // （客户端每个节点就是一个 <g>，形状与标签都在里面）。
    const text = nodeLabelSvg(box.node, box.geo, palette)
    if (shape.length > 0 || text.length > 0) {
      body.push('<g' + attrs({ 'data-node-id': box.id }) + '>' + shape + text + '</g>')
    }
    putRect(box.geo)
    putBounds(labelPaintBounds(box.node, box.geo))
  }

  const hidden = hiddenLayerIds(doc)
  const edges = Array.isArray(doc.edges) ? doc.edges : []
  const state = {
    warnings: warnings,
    labels: Array.isArray(doc.labels) ? doc.labels : [],
    markers: new Map(),
    byId: byId,
    routed: solveMissingRoutes(edges, boxes, warnings),
  }
  // 只数"真的画出来"的边：隐藏图层里的、两端都找不到节点的都不算 —— 否则 stats 会虚高，
  // exportTool 的"画布是空的"判定也会被一张实际只有隐藏单元的图骗过去。
  let paintedEdges = 0
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]
    if (edge === null || typeof edge !== 'object') continue
    if (isHiddenCell(hidden, edge)) continue
    const painted = edgeSvg(edge, boxes, palette, state)
    if (painted === null) continue
    body.push('<g' + attrs({ 'data-edge-id': String(edge.id) }) + '>' + painted.svg + '</g>')
    for (let k = 0; k < painted.points.length; k += 1) put(painted.points[k].x, painted.points[k].y)
    putRect(painted.labelBox)
    paintedEdges += 1
  }

  if (Number.isFinite(minX) === false) {
    minX = 0
    minY = 0
    maxX = 1
    maxY = 1
  }
  const width = Math.max(1, maxX - minX + opts.padding * 2)
  const height = Math.max(1, maxY - minY + opts.padding * 2)
  const viewX = minX - opts.padding
  const viewY = minY - opts.padding

  // 箭头 marker：每种线色一份（客户端用同一个 skin 色，彩色的线会配一个黑箭头，
  // 静态图里看着像画错了 —— 这里按线自己的颜色出）。
  const markers = []
  for (const color of state.markers.keys()) {
    const id = state.markers.get(color)
    markers.push('<marker' + attrs({
      id: id + '-end', viewBox: '0 0 10 10', refX: 9.5, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto',
    }) + '><path' + attrs({ d: 'M 0 0 L 10 5 L 0 10 z', fill: color }) + '/></marker>')
    markers.push('<marker' + attrs({
      id: id + '-start', viewBox: '0 0 10 10', refX: 0.5, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto',
    }) + '><path' + attrs({ d: 'M 10 0 L 0 5 L 10 10 z', fill: color }) + '/></marker>')
  }

  const background = opts.background !== null ? opts.background : opts.transparent === true || opts.theme === 'dark' ? null : palette.page
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' + attrs({
      width: fmt(Math.round(width * 100) / 100),
      height: fmt(Math.round(height * 100) / 100),
      viewBox: [viewX, viewY, width, height].map(fmt).join(' '),
    }) + '>',
  ]
  if (opts.title.length > 0) head.push('<title>' + escapeXml(opts.title) + '</title>')
  if (markers.length > 0) head.push('<defs>' + markers.join('') + '</defs>')
  if (background !== null) {
    head.push('<rect' + attrs({ x: fmt(viewX), y: fmt(viewY), width: fmt(width), height: fmt(height), fill: background }) + '/>')
  }
  const svg = head.join('\n') + '\n' + body.join('\n') + '\n</svg>\n'

  return {
    svg: svg,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    viewBox: { x: viewX, y: viewY, width: width, height: height },
    warnings: warnings,
    stats: { nodes: boxes.length, edges: paintedEdges },
  }
}

/** 倍数的兜底（与客户端 exportOutputSize 同一组阈值）：没给/不是数字 → 2，0 与负数 → 0.1。 */
export function exportScaleFor(scale) {
  return Number.isFinite(Number(scale)) ? Math.max(0.1, Number(scale)) : 2
}

/** 从 `<svg …>` 头里读基准尺寸（buildExportSvg 一定会写 width/height）。 */
function svgBaseSize(svg) {
  const head = String(svg === undefined || svg === null ? '' : svg)
  const end = head.indexOf('>')
  const open = end > 0 ? head.slice(0, end) : head
  const width = /\bwidth="([0-9.]+)"/.exec(open)
  const height = /\bheight="([0-9.]+)"/.exec(open)
  if (width === null || height === null) return null
  const w = Number(width[1])
  const h = Number(height[1])
  if (Number.isFinite(w) === false || Number.isFinite(h) === false || w <= 0 || h <= 0) return null
  return { width: w, height: h }
}

/** 尺寸上限（单边 MAX_SIDE、总量 MAX_PIXELS），超了直接给一句能读懂的话。 */
function assertRasterFits(width, height) {
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('PNG 尺寸过大（' + width + '×' + height + '，上限 ' + MAX_SIDE + 'px/边、' +
      Math.round(MAX_PIXELS / 1000000) + 'MP）；请调小 scale')
  }
}

/**
 * SVG → PNG。resvg 是可选的原生依赖（装不上时 SVG 那条路照走），所以按需动态 import。
 *
 * @returns {Promise<{ png: Buffer, width: number, height: number, scale: number }>}
 */
export async function rasterizeSvgToPng(svg, options) {
  const raw = options !== null && typeof options === 'object' ? options : {}
  let Resvg = null
  try {
    const mod = await import('@resvg/resvg-js')
    Resvg = mod.Resvg || (mod.default && mod.default.Resvg) || null
  } catch (error) {
    throw new Error('PNG 导出需要 @resvg/resvg-js（' + String(error && error.message ? error.message : error) + '）；也可以用 format:"svg" 直接拿到矢量图')
  }
  if (typeof Resvg !== 'function') throw new Error('@resvg/resvg-js 的 Resvg 不可用')

  const scale = exportScaleFor(raw.scale)
  // 先按基准尺寸算一遍像素数再栅格化：resvg 一次性分配整张位图，先 render 再检查等于让
  // 宿主进程先顶着内存跑一遍 —— 超大 scale 下那是 OOM，不是一句能读懂的错误。
  const base = svgBaseSize(svg)
  if (base !== null) {
    assertRasterFits(Math.max(1, Math.round(base.width * scale)), Math.max(1, Math.round(base.height * scale)))
  }
  const probe = new Resvg(svg, { fitTo: { mode: 'zoom', value: scale }, font: { loadSystemFonts: true } })
  const size = probe.render()
  // 兜底：resvg 自己的取整可能与上面的估算差一像素。
  assertRasterFits(size.width, size.height)
  const png = size.asPng()
  return { png: png, width: size.width, height: size.height, scale: scale }
}
