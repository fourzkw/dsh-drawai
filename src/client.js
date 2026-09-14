/**
 * dsh-drawai —— 浏览器半边（Client half）· 源文件
 *
 * 这是**源文件**，不要改 lib/client.js —— 那个由 tools/build.mjs 生成。
 *
 * 本文件是 bundle factory 的函数体，运行在下面的作用域里：
 *   factory: (require) => { var module = { exports: {} }; var exports = module.exports; <本文件> }
 * 因此可以：使用 `require`（只能拿冻结静态模块表里的 9 个 + 已声明的 external）、
 * 给 `exports` 赋值、以及在结尾 `return module.exports`（由 build 补上）。
 *
 * 数据通道走宿主生成的 Remote：ctx.remote.workspaceFiles（官方文件查看器同款），
 * 不再有动态包专有的 host.call。
 */

const React = require('react')

/**
 * 样式内核（drawio 的 style 键语义）—— 构建时从 src/style-kernel.js 内联进本 bundle，
 * 宿主半边 import 的是同一份源文件，所以两边的格式判据不可能漂移。
 *
 * 这里**按需解构**：内核里与本文件同名的符号（例如 SIDES）不取，继续用本地的，
 * 于是不会出现"重复 const 声明"那种直接炸掉整棵子树的错误。
 */
const {
  DEFAULT_EDGE_STYLE,
  NODE_SHAPES,
  PALETTE,
  arrowFromStyle,
  colorNameFromStyle,
  colorsFromStyle,
  dashFromStyle,
  dashPatternFromStyle,
  edgeFreePoint,
  formatStyle,
  isOrthogonalEdgeStyle,
  jettyFromStyle,
  nodeShapeFromStyle,
  normalizeDrawioDoc,
  parseStyle,
  sideFromStyle,
  styleGet,
  styleNumber,
  stylePatch,
  styleWithArrow,
  styleWithColorName,
  styleWithDash,
  styleWithNodeShape,
  styleWithSide,
} = styleKernel

const ID = 'drawai:diagram'
const KIND = 'diagram'
const DEFAULT_PATH = 'demo.dshd.json'

/**
 * 「未命名画布」的哨兵值：新建出来的标签**还没有绑定任何文件**。
 *
 * 为什么不复用 null：外层用 null 表示"这个标签来自 tab 的地址但解析不出路径"（未绑定），
 * 而"新建但还没起名"是另一种状态 —— 它有画布、有内容，只是没有落盘位置。
 * 两者都要区分，否则"新建"会被解读成"回到 tab 的文件"。
 */
const UNTITLED = '\u0000untitled'

/**
 * 标签列表的**纯逻辑**：算"打开 path 之后，标签列表与活动标签变成什么"。
 *
 * 抽出来是为了能被命令行自测直接断言 —— 这段规则有两条容易写错：
 *   · 同一个文件重复打开必须**切过去**，不能再开一个（否则标签栏会堆满同一个文件）；
 *   · 每张"未命名"必须各自独立（key 带序号），否则两次「新建」会共用同一个标签。
 * 返回值 { tabs, active }；path 非法时原样返回。
 */
function openTabIn(list, path, counter) {
  if (path === UNTITLED) {
    const key = 'untitled:' + counter
    return { tabs: list.concat([{ key: key, path: UNTITLED, untitled: true, unbound: false }]), active: key, counter: counter + 1 }
  }
  if (typeof path !== 'string' || path.length === 0) return { tabs: list, active: null, counter: counter }
  // 去重要**大小写不敏感**，并把分隔符归一：Windows 上 D:\ws\a 与 D:/WS/A 是同一个文件，
  // 按字面比会开出第二个标签（探针实测到过）。归一后仍用**先打开的那个**路径当身份，
  // 免得同一个文件在标签上显示成两种写法。
  const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
  for (let i = 0; i < list.length; i += 1) {
    if (samePath(list[i].path, path)) return { tabs: list, active: list[i].key, counter: counter }
  }
  const key = 'tab:' + path
  return { tabs: list.concat([{ key: key, path: path, untitled: false, unbound: false }]), active: key, counter: counter }
}

function tabLabelOf(path, index) {
  if (path === UNTITLED) return '未命名 ' + index
  if (typeof path !== 'string' || path.length === 0) return '(未绑定)'
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1]
}

const POLL_MS = 3000
/** 人工编辑的写回端点（宿主半边注册，见 src/index.js）。 */
const SAVE_ENDPOINT = '/drawai/api/save'
/** 自定义请求头，宿主用它做 CSRF 围栏。 */
const SAVE_HEADER = 'x-drawai-save'
/** 拖拽吸附网格（px）。 */
const GRID = 10

/** 连线拖拽：指针离目标节点边框多近就算"落在它身上"（吸附容差，用户坐标单位）。 */
const HOT_PAD = 18
/** 落盘防抖窗口（ms）：拖拽过程中不写盘，停手后落一次。 */
const SAVE_DEBOUNCE_MS = 300
const FONT = 'Helvetica, Arial, sans-serif'
const FSIZE = 12
const LHEIGHT = 14

// draw.io 经典调色板（mxGraph 默认色对）。
//
// 注意这里**只有"缺省"一套色**：v1.1 起颜色是文档的一部分（style 键 fillColor/strokeColor），
// 主题只在文档没写颜色时补缺省 —— 这与 drawio 一致（换主题不改文档里的颜色，只改画布与网格）。
const LIGHT = {
  page: '#ffffff',
  text: '#000000',
  line: '#000000',
  gridMinor: '#f2f2f2',
  gridMajor: '#e2e2e2',
  labelBg: '#ffffff',
  default: { fill: '#ffffff', stroke: '#000000' },
}

const DARK = {
  page: 'transparent',
  text: '#e8e8e8',
  line: '#c9c9c9',
  gridMinor: 'rgba(255,255,255,0.05)',
  gridMajor: 'rgba(255,255,255,0.10)',
  labelBg: '#1c1c1c',
  default: { fill: '#2a2a2a', stroke: '#c9c9c9' },
}


/**
 * 浏览器根 ctx，由 apply 在激活时绑定。
 *
 * 为什么需要它：组件定义在**模块级**（不在 apply 内部），所以拿不到 apply 的参数。
 * 而动态 Cordis 插件版之所以没这个问题，是因为那时所有组件都定义在 `apply(ctx)` 里、
 * `ctx` 是闭包变量。拆成静态包时组件被提到了模块级 —— 于是 effect 里的 `ctx.remote`
 * 变成了 ReferenceError，React 卸载整棵子树，tab 主体一片空白。
 *
 * 这个绑定就是模块级组件的入口。apply 一定先于任何组件渲染执行，所以运行时它必然已就绪；
 * 组件里仍会判空，以免将来重构把顺序弄反时又变成一次无声的空白。
 */
let client = null

const CSS = [
  // 用绝对定位铺满宿主给的那一格，**不用 height:100%**。
  //
  // 这里连续出过两次"画布没高度"（先是一条，后来整块消失）：根因都是
  // `height:100%` 要求父级有**确定高度**，而宿主给的容器不保证这一点。
  // inset:0 只要求父级是定位元素，而 .drawai-pane 已经是（我们自己的 CSS），
  // 所以这条链子只依赖我们自己，不再依赖宿主怎么排。
  '.drawai-root{display:flex;flex-direction:column;position:absolute;top:0;left:0;right:0;bottom:0;min-height:0;font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6)}',
  '.drawai-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#333)}',
  // 多画布标签条。放在工具条**下面**一行：工具条是"对这张画布做什么"，
  // 标签条是"现在看哪张画布"，两者职责不同，混在一行会挤成一团（右栏本来就窄）。
  '.drawai-tabs{display:flex;gap:4px;padding:4px 6px 0;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1,#333);flex:0 0 auto}',
  '.drawai-tab{display:flex;align-items:center;gap:2px;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2,#444);border-bottom:none;border-radius:6px 6px 0 0;background:transparent;padding:1px 4px 1px 8px}',
  '.drawai-tab.on{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.drawai-tab-name{border:none;background:transparent;color:inherit;font-size:12px;cursor:pointer;padding:2px 2px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis}',
  '.drawai-tab-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);cursor:pointer;font-size:13px;line-height:1;padding:0 3px;border-radius:3px}',
  '.drawai-tab-x:hover{background:rgba(255,120,120,.25);color:inherit}',
  // 标签区外壳 = 整个组件根，**用绝对定位铺满宿主给的位置**。
  //
  // 这里修过两次，记清楚原因：靠 `flex:1` + `height:100%` 这条链子太脆 ——
  // 只要宿主给的那一层不是 flex、或者不是"确定高度"，链子就断，
  // 里面的 flex:1 画布直接塌成 0 高（两次症状：先"只占上方一小条"，后"完全没有了"）。
  // 绝对定位 + inset:0 只依赖"宿主 tab 面板是定位元素"这一个前提。
  '.drawai-tabs-wrap{display:flex;flex-direction:column;position:absolute;top:0;left:0;right:0;bottom:0}',
  '.drawai-panes{position:relative;flex:1;min-height:0}',
  '.drawai-pane{position:absolute;top:0;left:0;right:0;bottom:0;flex-direction:column;min-height:0}',
  '.drawai-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,#9aa0a6)}',
  '.drawai-btn{border:1px solid var(--dsw-alias-border-l2,#444);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer;white-space:nowrap}',
  '.drawai-btn:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  // 视口由我们自己管（viewBox），所以不再让容器滚动 —— 否则滚轮会同时滚动和缩放。
  // user-select:none —— 拖动平移时不能把图里的文字一起选中（观感很差）。
  // touch-action:none —— 我们自己处理 pointer 事件，别让浏览器再做触摸滚动/缩放。
  '.drawai-canvas{flex:1;min-height:0;overflow:hidden;position:relative;user-select:none;-webkit-user-select:none;touch-action:none}',  '.drawai-note{padding:4px 8px;color:var(--dsw-alias-label-secondary,#9aa0a6);border-top:1px solid var(--dsw-alias-border-l1,#333)}',
  '.drawai-err{padding:8px;color:var(--dsw-alias-state-error-primary,#ff6b6b);white-space:pre-wrap}',
  // 交互态
  '.drawai-node{cursor:move}',
  '.drawai-node-hit{cursor:pointer}',
  '.drawai-edge-hit{cursor:pointer;stroke:transparent;stroke-width:12;fill:none}',
  '.drawai-sel{stroke:#1a73e8 !important;stroke-width:2 !important}',
  '.drawai-handle{cursor:crosshair}',
  '.drawai-link{cursor:crosshair}',
  // 连线拖拽的实时预览（路由后的正交预览线 + 落点提示）。
  // 这两条路径都是纯视觉件，绝不能挡住命中测试 —— .drawai-edge-hit 的 12px 透明带子、
  // 节点自己的 <g> 都靠 pointer-events 工作，预览一旦可命中就会把落点判断弄坏。
  '.drawai-preview{pointer-events:none}',
  // 从**预览线终点**滑到落点的那一小段收尾线。实线、带箭头 —— 它表示"这条边会这样接过去"，
  // 和虚线（预览轨迹）区分开。dashoffset 动画让它看起来是从终点流向落点。
  '.drawai-preview-tip{pointer-events:none;animation:drawai-flow 1.1s linear infinite}',
  '@keyframes drawai-flow{to{stroke-dashoffset:-18}}',
  '.drawai-hot-ring{pointer-events:none;animation:drawai-pulse 1.2s ease-in-out infinite}',
  // 可连接的端点标记。纯提示件，绝不能参与命中测试 —— 否则指针一旦滑过某个端点，
  // 命中目标就会从"节点"变成"这个圆点"，落点判定跟着乱。
  '.drawai-anchor{pointer-events:none}',
  '@keyframes drawai-pulse{0%,100%{opacity:.9}50%{opacity:.4}}',
  '.drawai-node-hot{cursor:copy}',
  '.drawai-rs-nw{cursor:nwse-resize}.drawai-rs-se{cursor:nwse-resize}',
  '.drawai-rs-ne{cursor:nesw-resize}.drawai-rs-sw{cursor:nesw-resize}',
  '.drawai-rs-n{cursor:ns-resize}.drawai-rs-s{cursor:ns-resize}',
  '.drawai-rs-e{cursor:ew-resize}.drawai-rs-w{cursor:ew-resize}',
  // 就地编辑框是画布里唯一需要能选中文字的元素 —— 必须把 user-select 放开回来。
  '.drawai-edit{position:absolute;z-index:5;box-sizing:border-box;border:2px solid #1a73e8;border-radius:4px;background:#fff;color:#000;font:12px Helvetica,Arial,sans-serif;text-align:center;padding:0 4px;outline:none;user-select:text;-webkit-user-select:text}',
  '.drawai-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
  // 右键菜单 / 元素库
  '.drawai-menu{position:absolute;z-index:20;min-width:196px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#555);background:var(--dsw-alias-bg-overlay,#1e1e1e);box-shadow:0 10px 28px rgba(0,0,0,.4);color:var(--dsw-alias-label-primary,#e6e6e6)}',
  '.drawai-menu-title{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6);margin:0 0 6px}',
  '.drawai-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}',
  '.drawai-chip{display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:6px;background:transparent;padding:1px;cursor:pointer}',
  '.drawai-chip:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff);background:rgba(76,141,255,.14)}',
  '.drawai-swatches{display:flex;gap:6px;margin-top:8px}',
  '.drawai-swatch{width:18px;height:18px;border-radius:4px;border:1px solid rgba(0,0,0,.3);cursor:pointer;padding:0}',
  '.drawai-swatch.on{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}',
  // 当前生效的选项（线型/箭头方向）—— 和色板用同一套"被选中"语言。
  '.drawai-btn.on{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}',
  '.drawai-menu-row{display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#3a3a3a)}',
  // 新建/打开面板：固定在工具条下方左侧，盖在画布上（和右键菜单同一层）。
  // 下拉面板：left/top 由**触发它的按钮**算出来（inline style），这里只给宽度与兜底位置。
  // 兜底 left:8px;top:38px 用于"量不到按钮位置"的情形（首帧 ref 还没挂）。
  '.drawai-docmenu{left:8px;top:38px;min-width:220px;max-width:min(320px,90%)}',
  // 下拉菜单项：整行可点，右侧/下方带一句说明。按钮默认是 inline 且 nowrap，
  // 这里要改成块级 + 允许换行，否则说明文字会把面板撑爆。
  '.drawai-menu-item{display:block;width:100%;text-align:left;margin-bottom:3px;white-space:normal}',
  '.drawai-menu-hint{display:block;font-size:11px;opacity:.65;margin-top:1px}',
  // 这一格复用 .drawai-edit 的输入框外观，但它是**静态**的（不盖在节点上），
  // 所以要清掉绝对定位与居中，改成整行宽。
  '.drawai-docmenu .doc-menu-input{position:static;width:100%;box-sizing:border-box;text-align:left;margin-bottom:2px}',
].join('\n')

function numberOr(value, fallback) {
  // null / undefined / 空串一律回落 **不能靠 Number() 判断**：`Number(null) === 0` 而 0 是有限数，
  // 于是"没给值就用缺省"会静默变成 0。实测过：节点的 fontSize / strokeWidth 变成 0，
  // 表现是"节点没有文字、连线完全看不见"，而且不报错。
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function fmt(n) {
  return Math.round(n * 100) / 100
}

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

function wrapLabel(label, maxWidth) {
  const lines = []
  const paras = String(label).split('\n')
  for (let p = 0; p < paras.length; p += 1) {
    const chars = Array.from(paras[p])
    let current = ''
    let width = 0
    for (let i = 0; i < chars.length; i += 1) {
      const cw = charWidth(chars[i], FSIZE)
      if (width + cw > maxWidth && current.length > 0) {
        lines.push(current)
        current = ''
        width = 0
      }
      current += chars[i]
      width += cw
    }
    lines.push(current)
  }
  return lines.length > 0 ? lines : ['']
}

/**
 * 节点的配色：**文档的 style 键说了算**，主题只在"没写"时补缺省。
 *
 * 这与 v1 相反 —— v1 把 node.style 当颜色名去查主题表，于是暗色主题会改写文档颜色，
 * 而颜色名之外的值（真十六进制）根本没法表达。drawio 的语义是：颜色本来就存在文档里。
 */
function colorOf(node, mode) {
  const skin = mode === 'dark' ? DARK : LIGHT
  const style = typeof node.style === 'string' ? node.style : ''
  const fill = styleGet(style, 'fillColor', null)
  const stroke = styleGet(style, 'strokeColor', null)
  const font = styleGet(style, 'fontColor', null)
  return {
    fill: fill !== null ? fill : skin.default.fill,
    stroke: stroke !== null ? stroke : skin.default.stroke,
    font: font !== null ? font : skin.text,
  }
}

/** 形状：从 style 键推导 —— drawio 里没有 shape 字段，普通矩形就是"没有形状键"。 */
function shapeOf(node) {
  return nodeShapeFromStyle(typeof node.style === 'string' ? node.style : '')
}

// ---- 正交折线路由：6 个候选 + 包围盒避让 ----

function orthoH(from, to) {
  const fcy = from.y + from.h / 2
  const tcy = to.y + to.h / 2
  const east = to.x + to.w / 2 >= from.x + from.w / 2
  const sx = east ? from.x + from.w : from.x
  const ex = east ? to.x : to.x + to.w
  const midX = (sx + ex) / 2
  return [{ x: sx, y: fcy }, { x: midX, y: fcy }, { x: midX, y: tcy }, { x: ex, y: tcy }]
}

function orthoV(from, to) {
  const fcx = from.x + from.w / 2
  const tcx = to.x + to.w / 2
  const south = to.y + to.h / 2 >= from.y + from.h / 2
  const sy = south ? from.y + from.h : from.y
  const ey = south ? to.y : to.y + to.h
  const midY = (sy + ey) / 2
  return [{ x: fcx, y: sy }, { x: fcx, y: midY }, { x: tcx, y: midY }, { x: tcx, y: ey }]
}

function viaY(from, to, yc) {
  const fcx = from.x + from.w / 2
  const tcx = to.x + to.w / 2
  const sy = yc < from.y + from.h / 2 ? from.y : from.y + from.h
  const ty = yc < to.y + to.h / 2 ? to.y : to.y + to.h
  return [{ x: fcx, y: sy }, { x: fcx, y: yc }, { x: tcx, y: yc }, { x: tcx, y: ty }]
}

function viaX(from, to, xc) {
  const fcy = from.y + from.h / 2
  const tcy = to.y + to.h / 2
  const sx = xc < from.x + from.w / 2 ? from.x : from.x + from.w
  const tx = xc < to.x + to.w / 2 ? to.x : to.x + to.w
  return [{ x: sx, y: fcy }, { x: xc, y: fcy }, { x: xc, y: tcy }, { x: tx, y: tcy }]
}

function segmentHitsBox(a, b, box, margin) {
  const x1 = Math.min(a.x, b.x)
  const x2 = Math.max(a.x, b.x)
  const y1 = Math.min(a.y, b.y)
  const y2 = Math.max(a.y, b.y)
  return x1 < box.x + box.w + margin && x2 > box.x - margin && y1 < box.y + box.h + margin && y2 > box.y - margin
}

/**
 * 一条候选路径的代价：先比穿模数，再比拐弯数，最后比长度。
 *
 * 加入拐弯数是有原因的：只比长度的话，一条"短但扭三下"的路径会赢过
 * "略长但干净"的路径。draw.io 的观感来自**少拐弯**，不是最短。
 */
function pathCost(points, boxes, skip) {
  let hits = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let k = 0; k < boxes.length; k += 1) {
      const box = boxes[k]
      if (skip[box.id] === true) continue
      if (segmentHitsBox(points[i], points[i + 1], box.geo, 8)) {
        hits += 1
        break
      }
    }
  }
  let length = 0
  let bends = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    length += Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y)
    if (i > 0) {
      const prevHorizontal = Math.abs(points[i].x - points[i - 1].x) > 0.5
      const curHorizontal = Math.abs(points[i + 1].x - points[i].x) > 0.5
      if (prevHorizontal !== curHorizontal) bends += 1
    }
  }
  return { hits: hits, bends: bends, length: length }
}

function pathCostBetter(cost, best) {
  if (cost.hits !== best.hits) return cost.hits < best.hits
  if (cost.bends !== best.bends) return cost.bends < best.bends
  return cost.length < best.length
}

/**
 * 去掉连续重复点。
 *
 * 刻意**不做共线点消除** —— 折点必须原样留在路径顶点上。
 * 之前的实现会把共线折点吃掉，于是 points[] 和路径顶点对不上，
 * "在第几段插入"只能靠弧长投影去猜，整套折点逻辑就是从这里开始乱的。
 */
function dedupePoints(points) {
  const out = []
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]
    if (p === null || p === undefined || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const last = out[out.length - 1]
    if (last !== undefined && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue
    out.push({ x: p.x, y: p.y })
  }
  return out
}

/**
 * 两个中心差多少以内就视为"其实对齐"。
 *
 * 取 4（不到半个网格）：节点宽 130~300px，没有人会把两个节点"故意"对齐到 4px 精度的错位上；
 * 反过来，差 1~3px 在前端就是**看得见的斜台阶**。实测 demo 里 doc/fs 差 1.5、fs/check 差 3.5，
 * 都是自动布局取整留下的零头，两种都得并掉。
 */
const AXIS_EPS = 4

/**
 * 把两个盒子的**中心**对齐：当它们差得极小时视为同一个值。
 *
 * 为什么必须在**路由之前**做，而不是事后清理折线：
 * 竖直连接（orthoV）在"起点中心 x"和"终点中心 x"之间会**主动**走一步台阶 ——
 * doc 中心 153、fs 中心 151.5 时它生成
 * `(153,476) (153,528) (151.5,528) (151.5,580)`：视觉上是一条竖线，实际是两条错开 1.5px 的线段，
 * 于是各自长出一个段把手，叠起来看就是「一条线段上有两个点」。
 *
 * 事后清理是错的方向：把 (151.5,528) 并到 (153,528) 会凭空造出一条"水平线"，
 * 再被共线消除吃掉，路径就断成半截（试过，e5 会退化成从 y=528 起的 2 点线）。
 * 在**输入端**统一中心值，台阶根本不会产生，后续所有几何推理都还按原来的精确比较走。
 *
 * 容差取 2px：比它大就是有意为之的错位，不该吞掉。
 */
function snapNearAxis(fromGeo, toGeo) {
  const dx = Math.abs(fromGeo.x + fromGeo.w / 2 - (toGeo.x + toGeo.w / 2))
  const dy = Math.abs(fromGeo.y + fromGeo.h / 2 - (toGeo.y + toGeo.h / 2))
  if (dx >= AXIS_EPS || dx === 0) return { from: fromGeo, to: toGeo }
  // 用较长那个节点的中心当基准：它更可能是"作者本意"的位置，短的那个挪过去不容易看出来。
  const anchor = fromGeo.w >= toGeo.w ? fromGeo.x + fromGeo.w / 2 : toGeo.x + toGeo.w / 2
  return {
    from: { x: anchor - fromGeo.w / 2, y: fromGeo.y, w: fromGeo.w, h: fromGeo.h },
    to: { x: anchor - toGeo.w / 2, y: toGeo.y, w: toGeo.w, h: toGeo.h },
  }
}

/**
 * 消除折线里"一两像素的台阶"。
 *
 * 判据：相邻两点**严格**垂直（x 相等）却又有 <2px 的 y 差（或反之）——
 * 那种 ±90° 折返不可能是人有意的弯，只可能是两个节点中心差了 1.5px 带出来的。
 *
 * `preserve` 里的点一律不动：端点和用户折点是**人的意图**，宁可留一点错位也不能改。
 * 只收拾夹在它们中间的那些中间顶点。参考点用"上一次输出的点 + 两个位置之后的点"，
 * 因为被跳过的点可能还会被后面的判断修剪（simplifyCollinear 会再收一次）。
 */
function snapNearAxisInPath(points, preserve) {
  const out = []
  for (let i = 0; i < points.length; i += 1) {
    const p = { x: points[i].x, y: points[i].y }
    const locked = i === 0 || i === points.length - 1 || (preserve !== undefined && preserve !== null && preserve.has(points[i]))
    if (!locked && i >= 1) {
      const prev = out[out.length - 1]
      const next = points[i + 1]
      if (prev !== undefined && next !== undefined) {
        const toPrevX = Math.abs(prev.x - p.x)
        const toPrevY = Math.abs(prev.y - p.y)
        const toNextX = Math.abs(next.x - points[i].x)
        const toNextY = Math.abs(next.y - points[i].y)
        // 出入这点的两段几乎同向，且这一小段几乎是纯垂直/纯水平 → 把横/纵坐标对齐过去。
        if (toNextY < 0.5 && toPrevX < AXIS_EPS && toPrevY > 0.5) p.x = prev.x
        else if (toNextX < 0.5 && toPrevY < AXIS_EPS && toPrevX > 0.5) p.y = prev.y
      }
    }
    out.push(p)
  }
  return out
}

/**
 * 去掉共线冗余顶点（**保首尾**）。
 *
 * **只能用在自动路径上** —— 手动路径里的折点必须原样保留，
 * 消除它们会让 points[] 与路径顶点失去一一对应。
 *
 * 这个函数写过两版都是错的，记在这里免得再踩：
 *  - 用 `points[i+1]` 当 next：连续三个共线点时会因下标错位漏掉一个，路径上多出一段；
 *  - 从后往前扫、用 `out` 里最后两个当邻居：**首点永远凑不齐两个邻居，于是被判成共线删掉** ——
 *    表现是 l 型或 z 型路径整段少掉一截（起笔点凭空移到中间）。
 *
 * 现在的写法：先反复删"正好夹在两邻居中间"的点（这个判据只看输入、不受删除影响），
 * 再跑一次栈式清理处理级联。首尾由 i>0 / i<len-1 明确排除。
 */
function simplifyCollinear(points) {
  let cur = points
  for (;;) {
    const kept = []
    for (let i = 0; i < cur.length; i += 1) {
      const prev = cur[i - 1]
      const next = cur[i + 1]
      if (i > 0 && i < cur.length - 1 && prev !== undefined && next !== undefined) {
        const sameX = Math.abs(prev.x - cur[i].x) < 0.5 && Math.abs(cur[i].x - next.x) < 0.5
        const sameY = Math.abs(prev.y - cur[i].y) < 0.5 && Math.abs(cur[i].y - next.y) < 0.5
        if (sameX || sameY) continue
      }
      kept.push(cur[i])
    }
    if (kept.length === cur.length) break
    cur = kept
  }
  const out = []
  for (let i = 0; i < cur.length; i += 1) {
    const current = cur[i]
    if (i > 0 && i < cur.length - 1) {
      const prev = out[out.length - 1]
      if (prev !== undefined) {
        const sameX = Math.abs(prev.x - current.x) < 0.5 && Math.abs(current.x - cur[i + 1].x) < 0.5
        const sameY = Math.abs(prev.y - current.y) < 0.5 && Math.abs(current.y - cur[i + 1].y) < 0.5
        if (sameX || sameY) continue
      }
    }
    out.push(current)
  }
  return out
}

/**
 * 两条路径在**几何上**是否一致。
 *
 * 必须先消掉共线冗余再比 —— 这是"一条线段上挂了两个把手"的直接原因：
 * 少一个共线顶点时顶点数不同，逐点比较就判成"路径变了"，
 * 于是那个共线折点被当成有用的东西留下来，一条直线永远被切成两段。
 * 几何上它们本来就是同一条线。
 */
function samePath(a, b) {
  if (a === null || b === null) return false
  const sa = simplifyCollinear(a)
  const sb = simplifyCollinear(b)
  if (sa.length !== sb.length) return false
  for (let i = 0; i < sa.length; i += 1) {
    if (Math.abs(sa[i].x - sb[i].x) > 0.5 || Math.abs(sa[i].y - sb[i].y) > 0.5) return false
  }
  return true
}

/**
 * 回收"删掉也不改变路径"的折点。
 *
 * 拖动线段时会把该段两端就地钉成折点（那是让段可移动的手段），
 * 但这些内部记录会越积越多 —— 每多一个就多切出一段、多一个段把手。
 * 这里逐个试删：删完路径不变就丢掉。于是界面上永远只看到必要的段。
 *
 * 判定用"重新路由后逐点比对"，而不是去推理拐角规则 —— 规则会变，比对不会骗人。
 */
function prunePoints(doc, edge) {
  const points = Array.isArray(edge.points) ? edge.points : null
  if (points === null || points.length === 0) return null
  const before = edgeRoutePoints(doc, edge)
  if (before === null) return null
  let current = points.slice()
  for (let i = 0; i < points.length; i += 1) {
    if (current.indexOf(points[i]) < 0) continue
    const trial = current.filter((p) => p !== points[i])
    const after = edgeRoutePoints(doc, Object.assign({}, edge, { points: trial }))
    if (samePath(before, after)) current = trial
  }
  return current
}

/** 形状边框上朝向 target 的落点，连同它落在哪条边（n/s/e/w）。 */
function borderPointToward(geo, target) {
  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) return { x: geo.x + geo.w, y: cy, side: 'e' }
    return { x: geo.x, y: cy, side: 'w' }
  }
  if (dy >= 0) return { x: cx, y: geo.y + geo.h, side: 's' }
  return { x: cx, y: geo.y, side: 'n' }
}

/**
 * 从 a 直角走到 b，把需要的新顶点推进 points，返回抵达 b 后所在的轴。
 * `axis` 是"进来时的方向"：上一段是横的就先横后竖，是竖的就先竖后横。
 *
 * 两条 L 的曼哈顿长度永远是同一个数（|dx|+|dy|），差别只在**先走哪一轴**，
 * 而这一顺序决定了会不会先往反方向折返 —— 见下面的判据。
 */
function connectOrtho(points, a, b, axis) {
  const sameX = Math.abs(a.x - b.x) < 0.5
  const sameY = Math.abs(a.y - b.y) < 0.5
  if (sameX && sameY) return axis
  if (sameX) {
    points.push({ x: b.x, y: b.y })
    return 'v'
  }
  if (sameY) {
    points.push({ x: b.x, y: b.y })
    return 'h'
  }
  // 两条 L 都能连到 b，取**短的那条**。
  //
  // 这里原本是"上一段是横的就先横后竖"，即无条件沿用 axis。它会画出这种线：
  // 起点在 (246,433)、目标折点在 (153,366) 时先往右跑到 x=466 再折回左边 ——
  // 视觉上就是"绕出去一大圈再回来"，而不是最简洁路径。
  //
  // 判据：**先走跨度更大的那一轴**。
  //
  // 两条 L 的曼哈顿总长完全一样（走的是同样的 dx、dy），差别只在于拐点落在哪个角：
  //   · 先横后竖 → 拐点 (b.x, a.y)，与 a 同高、与 b 同列；
  //   · 先竖后横 → 拐点 (a.x, b.y)。
  // 取"同高"那个（先横）等价于让**较长的那一段先走完**，于是短的那一段最后走，
  // 路径不会在拐点处先出去再折回来。反过来先走短的那一轴，就会多一个来回 ——
  // 实测：起点 (60,433)、折点 (100,460) 时先竖（27px）会让路径从 595 涨到 649，
  // 因为那 27px 走到 y=460 后，下一段又得往北回到 y=178。
  //
  // 这里相等时取"先横"，即 `<=`：平手时两种拐点对称，任选一个总长一样，
  // 但 x 方向先走完更符合"从西侧出来"的直觉（且与旧的 axis 行为在多数情况下一致）。
  const useHorizontalFirst = Math.abs(b.x - a.x) <= Math.abs(b.y - a.y)
  if (useHorizontalFirst) {
    points.push({ x: b.x, y: a.y })
    points.push({ x: b.x, y: b.y })
    return 'v'
  }
  points.push({ x: a.x, y: b.y })
  points.push({ x: b.x, y: b.y })
  return 'h'
}

/** 形状中心指向 target 的主轴 —— 决定连线第一段先横还是先竖。 */
function axisToward(geo, target) {
  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  return Math.abs(target.x - cx) >= Math.abs(target.y - cy) ? 'h' : 'v'
}

/**
 * 从某一侧引出连线时，先在那一侧外面放一个折点。
 *
 * 这是"从哪边出来"的**几何表达**：桩点位于那一侧的正外方，borderPointToward 就会选中那条边。
 *
 * v1 把桩点直接写进 edge.points（于是"端点约束"和"折点"混成了一锅，AI 一重排就散架）；
 * v1.1 起端点约束存在 style 的 `exitX/exitY`、`entryX/entryY` 里，桩点只活在路由内部。
 */
function stubPointFor(geo, side, jetty) {
  // 长度取文档里的 `jettySize`（drawio 的键），没写就用缺省 24px。
  const inset = Number.isFinite(jetty) && jetty > 0 ? jetty : 24
  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  if (side === 'n') return { x: cx, y: geo.y - inset }
  if (side === 's') return { x: cx, y: geo.y + geo.h + inset }
  if (side === 'w') return { x: geo.x - inset, y: cy }
  return { x: geo.x + geo.w + inset, y: cy }
}

/**
 * 从一条边的 style 串读出两端约束与桩点长度。
 *
 * 「从哪一侧进出」在 v1.1 起就是文档里的 `exitX/exitY`（源端）与 `entryX/entryY`（目标端）——
 * 不再是把一个贴在边框外的桩点混进 edge.points（v1 的老办法）。缺省样式 = 两端都不钉。
 */
function sidesFromStyle(style) {
  const text = typeof style === 'string' ? style : DEFAULT_EDGE_STYLE
  return {
    source: sideFromStyle(text, 'source'),
    target: sideFromStyle(text, 'target'),
    jetty: jettyFromStyle(text, undefined),
  }
}

/** 某一端在文档里钉住的侧（没有约束返回 null = 由路由器自己挑）。 */
function pinnedSideOf(edge, end) {
  return sideFromStyle(typeof edge.style === 'string' ? edge.style : DEFAULT_EDGE_STYLE, end)
}

/**
 * 把「两端约束 + 用户折点」拼成 routeThroughWaypoints 的必经点链。
 *
 * 顺序就是边的真实方向（fromBox → toBox）：源端桩点、用户折点、目标端桩点。
 * **预览与落盘都走这一个函数** —— 于是"看到接哪边"和"存下来接哪边"是同一件事，
 * 不会出现"松手瞬间整条线跳掉"。
 */
function chainForRoute(fromBox, toBox, waypoints, sides) {
  const chain = []
  const source = sides === undefined || sides === null ? null : sides.source
  const target = sides === undefined || sides === null ? null : sides.target
  const jetty = sides === undefined || sides === null ? null : sides.jetty
  if (typeof source === 'string' && source.length > 0) chain.push(stubPointFor(fromBox.geo, source, jetty))
  if (Array.isArray(waypoints)) {
    for (let i = 0; i < waypoints.length; i += 1) chain.push({ x: waypoints[i].x, y: waypoints[i].y })
  }
  if (typeof target === 'string' && target.length > 0) chain.push(stubPointFor(toBox.geo, target, jetty))
  return chain
}

/**
 * 手动路径：必须逐个经过用户摆下的折点。
 *
 * 三条约定，这套折点逻辑之所以不再乱就靠它们：
 *
 *  1. **折点原样成为路径顶点，绝不被消除。** 于是 points[i] ↔ 路径顶点一一对应，
 *     "在第几段插入"可以精确算出，不需要弧长近似。
 *
 *  2. **拐弯方向跟着行进方向走，不是隔一段翻一次。** 之前用 horizontalFirst = !horizontalFirst
 *     交替，拖动一个折点会让整条线忽然翻面 —— 那正是"混乱"的来源。
 *     现在：上一段是横的 → 先横后竖；上一段是竖的 → 先竖后横。形状连续变化。
 *
 *  3. **进出形状的最后一段垂直于落点所在的边**（从左边进就横着进）。
 *     否则线会贴着边框斜切进去，看起来像画错了。
 */
function routeThroughWaypoints(fromBox, toBox, waypoints, obstacleBoxes) {
  // 折点可能落在某个节点**内部**（用户拖到节点上、或节点移动后把它吞进去了）。
  // 照直连过去线就穿进节点里，所以先推到外面 —— 只改路由用的副本，不动用户数据。
  const safe = []
  for (let i = 0; i < waypoints.length; i += 1) {
    const toward = i + 1 < waypoints.length ? waypoints[i + 1] : { x: toBox.geo.x + toBox.geo.w / 2, y: toBox.geo.y + toBox.geo.h / 2 }
    const holder = boxContaining(obstacleBoxes, waypoints[i], null)
    safe.push(holder === null ? waypoints[i] : pushOutOfBox(waypoints[i], holder.geo, toward))
  }

  /** 从起点出发，依次穿过折点、进入目标——返回折线。 */
  function build(start) {
    const pts = [{ x: start.x, y: start.y }]
    let axis = axisToward(fromBox.geo, safe[0])
    let prev = start
    for (let i = 0; i < safe.length; i += 1) {
      axis = connectOrtho(pts, prev, safe[i], axis)
      prev = safe[i]
    }
    const end = borderPointToward(toBox.geo, prev)
    // 落点在左右边 → 最后一段要横着进 → 先竖后横，所以传 'v'；上下边反之。
    const approach = end.side === 'e' || end.side === 'w' ? 'v' : 'h'
    connectOrtho(pts, prev, end, approach)
    return pts
  }

  const start = borderPointToward(fromBox.geo, safe[0])
  return finalizePath(build(start), safe)
}

/** 收尾：保折点与两端落点、消 1.5px 台阶、去共线冗余。 */
function finalizePath(pts, waypoints) {
  const preserve = new Set()
  preserve.add(pts[0])
  preserve.add(pts[pts.length - 1])
  for (let i = 0; i < waypoints.length; i += 1) preserve.add(waypoints[i])
  // 最后收一次共线冗余：路径里的折点常常是共线的
  // （比如"+24px 的引出桩点"和"真正落点"在同一竖直线上）。
  // 不收的话，路径上会多出不在 points[] 里的顶点 ——
  //   · 渲染出来的段比预览多，同一条线上又能挂两个把手；
  //   · ensurePinned 用 pathIndexOf 在 points 里找路径顶点，找不到就返回 -1，
  //     拖动那一段会直接没反应（"点了段把手不动"）。
  return simplifyCollinear(dedupePoints(snapNearAxisInPath(pts, preserve)))
}

/** 折点是路径上的精确顶点（见上面的约定 1），直接找下标即可。 */
function pathIndexOf(pts, point) {
  for (let i = 0; i < pts.length; i += 1) {
    if (Math.abs(pts[i].x - point.x) < 0.5 && Math.abs(pts[i].y - point.y) < 0.5) return i
  }
  return -1
}

/** 在第 segmentIndex 段上插新折点时，它排在 points[] 的第几位：数该段起点之前有几个折点。 */
function insertIndexForPath(pts, waypoints, segmentIndex) {
  let count = 0
  for (let i = 0; i < waypoints.length; i += 1) {
    const at = pathIndexOf(pts, waypoints[i])
    if (at >= 0 && at <= segmentIndex) count += 1
  }
  return count
}

/**
 * 把路径顶点 vertexIndex 就地钉成折点，返回它在 points 里的下标；已经是折点就直接复用。
 *
 * 在**原有位置**补折点不会改变路径（它本来就是路径顶点），
 * 所以"拖动某一段"可以在不产生任何跳变的前提下，把这一段的两个端点变成可移动的。
 */
function ensurePinned(pts, points, vertexIndex) {
  const target = pts[vertexIndex]
  if (target === undefined) return -1
  const existing = pathIndexOf(points, target)
  if (existing >= 0) return existing
  const at = insertIndexForPath(pts, points, vertexIndex - 1)
  points.splice(at, 0, { x: target.x, y: target.y })
  return at
}

/**
 * 连线路径的唯一入口。
 *
 * 两种模式：
 *   有折点 → 手动：逐个穿过折点，人摆的优先级高于算法
 *   没折点 → 自动：从候选里挑一条（不穿节点 → 拐弯少 → 尽量短）
 *
 * `bounds` 不再参与绕行 —— 那是之前"边绕整个画布一圈"的来源。
 */
function routeEdge(fromBox, toBox, boxes, bounds, waypoints, sides, straight) {
  // 入参是 box（{ id, node, geo, label }），几何在 .geo 上。
  // 这里曾经直接读 from.x / from.y —— box 上没有这些字段，于是 NaN 一路传染：
  // 连线 d="M NaN NaN" 被浏览器丢弃（边全部消失），边标签 x="NaN" 被忽略（全部塌到原点重叠）。
  // pathCost 用的是 box.geo（对的），所以这个函数一半对一半错，看着像没问题。
  const from = fromBox.geo
  const to = toBox.geo
  if (fromBox.id === toBox.id) {
    const x = from.x + from.w
    const cy = from.y + from.h / 2
    const r = 36
    return [{ x: x, y: cy - 12 }, { x: x + r, y: cy - 12 }, { x: x + r, y: cy + 12 }, { x: x, y: cy + 12 }]
  }
  // 有端点约束或有用户折点 → 手动：逐个穿过必经点，人摆的优先级高于算法。
  const chain = chainForRoute(fromBox, toBox, waypoints, sides)
  if (chain.length > 0) {
    return routeThroughWaypoints(fromBox, toBox, chain, boxes)
  }
  // edgeStyle=none = 直线（drawio 的语义）：两端各取朝向对方的边框点，中间一条直线。
  if (straight === true) {
    const a = borderPointToward(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 })
    const b = borderPointToward(to, { x: a.x, y: a.y })
    return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]
  }
  void bounds
  // 中心几乎对齐时先统一（见 snapNearAxis）：否则 orthoV/viaY 会在两者之间走一个
  // 一两像素的台阶，视觉上是同一条线、几何上是两条，一段就长出两个段把手。
  const axis = snapNearAxis(from, to)
  const candFrom = axis.from
  const candTo = axis.to
  const skip = {}
  skip[fromBox.id] = true
  skip[toBox.id] = true
  // 绕行走廊贴着**这两个端点**，不是贴着整张图。
  // 贴着整张图时，一条需要避让的边会绕到画布最外圈再回来，看上去就是"线乱跑"。
  const top = Math.min(candFrom.y, candTo.y) - 60
  const bottom = Math.max(candFrom.y + candFrom.h, candTo.y + candTo.h) + 60
  const left = Math.min(candFrom.x, candTo.x) - 60
  const right = Math.max(candFrom.x + candFrom.w, candTo.x + candTo.w) + 60
  const candidates = [
    orthoH(candFrom, candTo),
    orthoV(candFrom, candTo),
    viaY(candFrom, candTo, top),
    viaY(candFrom, candTo, bottom),
    viaX(candFrom, candTo, left),
    viaX(candFrom, candTo, right),
  ]
  let best = candidates[0]
  let bestCost = pathCost(candidates[0], boxes, skip)
  for (let i = 1; i < candidates.length; i += 1) {
    const cost = pathCost(candidates[i], boxes, skip)
    if (pathCostBetter(cost, bestCost)) {
      best = candidates[i]
      bestCost = cost
    }
  }
  return simplifyCollinear(dedupePoints(best))
}


/**
 * 以 anchor 为锚点缩放视野：**锚点在缩放前后必须停在同一位置**（这是滚轮手感的关键）。
 *
 * 抽成纯函数是为了能被断言 —— 这段数学错一点，表现就是"缩放时图往一边跑"，
 * 而这种毛病在浏览器里只能靠手感发现，命令行验不了。
 * 注意 h 必须**按同一个 k 缩放**，不能另算 —— 否则宽高比变化会让画面整体位移。
 */
function zoomViewAt(current, anchor, factor) {
  const w = Math.max(VIEW_MIN_W, Math.min(VIEW_MAX_W, current.w * factor))
  const k = w / current.w
  return { x: anchor.x - (anchor.x - current.x) * k, y: anchor.y - (anchor.y - current.y) * k, w: w, h: current.h * k }
}

function pathOf(rawPoints, radius) {
  const pts = []
  for (let i = 0; i < rawPoints.length; i += 1) {
    const p = rawPoints[i]
    const last = pts[pts.length - 1]
    if (last !== undefined && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue
    pts.push(p)
  }
  if (pts.length < 2) return ''
  const parts = ['M ' + fmt(pts[0].x) + ' ' + fmt(pts[0].y)]
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const d1 = Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y)
    const d2 = Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y)
    if (d1 < 0.01 || d2 < 0.01) continue
    const r = Math.min(radius, d1 / 2, d2 / 2)
    const a = { x: cur.x - ((cur.x - prev.x) / d1) * r, y: cur.y - ((cur.y - prev.y) / d1) * r }
    const b = { x: cur.x + ((next.x - cur.x) / d2) * r, y: cur.y + ((next.y - cur.y) / d2) * r }
    parts.push('L ' + fmt(a.x) + ' ' + fmt(a.y))
    parts.push('Q ' + fmt(cur.x) + ' ' + fmt(cur.y) + ' ' + fmt(b.x) + ' ' + fmt(b.y))
  }
  const last = pts[pts.length - 1]
  parts.push('L ' + fmt(last.x) + ' ' + fmt(last.y))
  return parts.join(' ')
}

function shapeElement(node, geo, palette, mode) {
  const x = geo.x
  const y = geo.y
  const w = geo.w
  const h = geo.h
  const style = typeof node.style === 'string' ? node.style : ''
  const stroke = palette.stroke
  const shape = shapeOf(node)
  const fill = palette.fill
  // 顶点也吃 drawio 的描边参数：strokeWidth / dashed / dashPattern 都在文档里。
  const strokeWidth = styleNumber(style, 'strokeWidth', 1)
  const pattern = dashPatternFromStyle(style)
  const common = { fill: fill, stroke: stroke, strokeWidth: strokeWidth }
  if (pattern !== null) common.strokeDasharray = pattern
  if (shape === 'ellipse') {
    return React.createElement('ellipse', Object.assign({}, common, { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 }))
  }
  if (shape === 'diamond') {
    return React.createElement('polygon', Object.assign({}, common, { points: [x + w / 2, y, x + w, y + h / 2, x + w / 2, y + h, x, y + h / 2].join(' ') }))
  }
  if (shape === 'parallelogram') {
    const s = Math.min(w * 0.2, 24)
    return React.createElement('polygon', Object.assign({}, common, { points: [x + s, y, x + w, y, x + w - s, y + h, x, y + h].join(' ') }))
  }
  if (shape === 'hexagon') {
    const s = Math.min(w * 0.15, 20)
    return React.createElement(
      'polygon',
      Object.assign({}, common, { points: [x + s, y, x + w - s, y, x + w, y + h / 2, x + w - s, y + h, x + s, y + h, x, y + h / 2].join(' ') }),
    )
  }
  if (shape === 'cylinder') {
    const ry = Math.min(h * 0.18, 14)
    return React.createElement(
      'g',
      null,
      React.createElement(
        'path',
        Object.assign({}, common, {
          d: ['M', fmt(x), fmt(y + ry), 'A', fmt(w / 2), fmt(ry), 0, 0, 1, fmt(x + w), fmt(y + ry), 'L', fmt(x + w), fmt(y + h - ry), 'A', fmt(w / 2), fmt(ry), 0, 0, 1, fmt(x), fmt(y + h - ry), 'Z'].join(' '),
        }),
      ),
      React.createElement(
        'path',
        Object.assign({}, common, {
          d: ['M', fmt(x), fmt(y + ry), 'A', fmt(w / 2), fmt(ry), 0, 0, 0, fmt(x + w), fmt(y + ry)].join(' '),
          fill: 'none',
        }),
      ),
    )
  }
  if (shape === 'document') {
    const d = ['M', fmt(x), fmt(y), 'L', fmt(x + w), fmt(y), 'L', fmt(x + w), fmt(y + h * 0.82), 'C', fmt(x + w * 0.75), fmt(y + h * 1.06), fmt(x + w * 0.25), fmt(y + h * 0.58), fmt(x), fmt(y + h * 0.86), 'Z'].join(' ')
    return React.createElement('path', Object.assign({}, common, { d: d }))
  }
  // 圆角：drawio 是 `rounded=1` + `arcSize`（百分比，缺省 15%）；stadium 就是 arcSize=50。
  let rx = 0
  if (shape === 'rounded' || shape === 'stadium') {
    // arcSize 缺省 = 15%（drawio 的矩形圆角比例）。**不能**写成 Number(styleGet(...)) —— 缺省时
    // 那会得到 0，于是 rounded=1 被画成直角（同一个 null→0 陷阱）。
    const arc = styleNumber(style, 'arcSize', null)
    rx = shape === 'stadium' ? h / 2 : Math.min(w, h) * (arc === null ? 0.15 : arc / 100)
  }
  return React.createElement('rect', Object.assign({}, common, { x: x, y: y, width: w, height: h, rx: rx, ry: rx }))
}

function clampNumber(value, lo, hi) {
  if (!Number.isFinite(value)) return lo
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}

/** 文档内容的包围盒（不含留白）。 */
function contentBounds(doc) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    const x = numberOr(n.x, 0)
    const y = numberOr(n.y, 0)
    const w = numberOr(n.w, 150)
    const h = numberOr(n.h, 56)
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x + w > maxX) maxX = x + w
    if (y + h > maxY) maxY = y + h
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY }
}

/**
 * 把内容装进一个宽高比等于容器的视口。
 *
 * 宽高比必须一致：SVG 的 preserveAspectRatio 默认是 meet，视口比例与容器不符时会被
 * letterbox（画面留黑边，指针坐标也跟着偏）。所以先按宽度试，装不下再按高度试。
 */
function computeFitView(bounds, aspect) {
  const pad = 40
  const cw = Math.max(1, bounds.maxX - bounds.minX)
  const ch = Math.max(1, bounds.maxY - bounds.minY)
  // 空画布：没有任何节点 → 外接框是 1×1 的退化值，按它算出来的视口只有几十单位宽，
  // 于是状态栏显示"缩放 185%"这种荒唐数字（实测过），而且一点滚轮就飞出可视区。
  // 空画布给一个固定的、合理的初始视口（约 900×900 用户单位，大致等于一屏）。
  if (cw <= 1 && ch <= 1) return { x: -450, y: -450, w: 900, h: 900 * aspect }
  let w = cw + pad * 2
  let h = w * aspect
  if (h < ch + pad * 2) {
    h = ch + pad * 2
    w = h / aspect
  }
  const cx = bounds.minX + cw / 2
  const cy = bounds.minY + ch / 2
  // 一并把高返回：调用方不必再拿 w * aspect 推一遍 ——
  // "视野矩形"只在这一处算出来，居中才永远是同一个中心。
  return { x: cx - w / 2, y: cy - h / 2, w: w, h: h }
}

/** 视口宽度范围（用户单位）：太小看不见，太大没意义。 */
const VIEW_MIN_W = 80
const VIEW_MAX_W = 40000

/** 元素库：draw.io 那套形状词汇的可用子集。 */
const SHAPE_LIBRARY = [
  { shape: 'rect', label: '矩形' },
  { shape: 'rounded', label: '圆角矩形' },
  { shape: 'stadium', label: '胶囊 / 起止' },
  { shape: 'ellipse', label: '椭圆' },
  { shape: 'diamond', label: '判定' },
  { shape: 'parallelogram', label: '数据' },
  { shape: 'cylinder', label: '数据库' },
  { shape: 'document', label: '文档' },
  { shape: 'hexagon', label: '六边形' },
]

// 调色板（8 个经典色）由样式内核的 PALETTE 提供，见文件顶部从 styleKernel 的解构 ——
// 这里不再留第二份"颜色名 → 十六进制"的表，否则两边迟早会漂移。

/** 从节点集合算出 box / 索引 / 包围盒。渲染与命中都走它，避免两处算法漂移。 */
function buildGeometry(doc) {
  const boxes = []
  const byId = {}
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    const geo = { x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, 150), h: numberOr(n.h, 56) }
    const box = { id: n.id, node: n, geo: geo, label: typeof n.label === 'string' ? n.label : n.id }
    boxes.push(box)
    byId[n.id] = box
    if (geo.x < minX) minX = geo.x
    if (geo.y < minY) minY = geo.y
    if (geo.x + geo.w > maxX) maxX = geo.x + geo.w
    if (geo.y + geo.h > maxY) maxY = geo.y + geo.h
  }
  if (!Number.isFinite(minX)) return { boxes: boxes, byId: byId, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }
  return { boxes: boxes, byId: byId, bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } }
}

/**
 * 批量对齐 / 分布的**纯计算**部分：只算出"谁该挪到哪"，不碰文档、不碰 React。
 *
 * 刻意抽成纯函数：这段是"差两个像素也说得过去、但错了很难看出来"的类型，
 * 放在组件里就只能靠肉眼验；抽出来之后 tools/check-render.mjs 能直接断言坐标。
 *
 * kind ∈ left | centerX | right | top | centerY | bottom | distributeX | distributeY
 * 返回 { id: 新坐标 }，没参与的直接不在表里。
 *
 * 两个刻意的决定：
 *  - 基准取**选中集合整体的外接框**（左对齐 = 都贴到最左那个的左边缘），
 *    而不是"第一个选中的节点" —— 后者在 Shift 加选时顺序不直观，用户猜不到基准是谁。
 *  - 结果统一过 snap()：画布把拖动吸附到 10px 网格，对齐若落在网格外，
 *    下一次拖动会把它吸回去，看起来就像"对齐完又自己跑了两像素"。
 */
function computeAlignMoves(doc, ids, kind, grid) {
  const targets = []
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    if (ids.indexOf(n.id) < 0) continue
    targets.push({ id: n.id, x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, 150), h: numberOr(n.h, 56) })
  }
  if (targets.length < 2) return {}
  const snapTo = (v) => Math.round(v / grid) * grid
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i]
    if (t.x < minX) minX = t.x
    if (t.x + t.w > maxX) maxX = t.x + t.w
    if (t.y < minY) minY = t.y
    if (t.y + t.h > maxY) maxY = t.y + t.h
  }
  const moves = {}
  if (kind === 'distributeX' || kind === 'distributeY') {
    if (targets.length < 3) return {} // 两个节点之间没有"间距"可均分
    const horizontal = kind === 'distributeX'
    const sorted = targets.slice().sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))
    const first = horizontal ? sorted[0].x : sorted[0].y
    const last = horizontal ? sorted[sorted.length - 1].x : sorted[sorted.length - 1].y
    const step = (last - first) / (sorted.length - 1)
    // 首尾钉住不动，只摊开中间那些 —— 这才是"分布"的语义。
    for (let i = 1; i < sorted.length - 1; i += 1) moves[sorted[i].id] = { axis: horizontal ? 'x' : 'y', value: snapTo(first + step * i) }
    return moves
  }
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i]
    let axis = 'x'
    let value = 0
    if (kind === 'left') value = minX
    else if (kind === 'right') value = maxX - t.w
    else if (kind === 'centerX') value = (minX + maxX) / 2 - t.w / 2
    else if (kind === 'top') {
      axis = 'y'
      value = minY
    } else if (kind === 'bottom') {
      axis = 'y'
      value = maxY - t.h
    } else if (kind === 'centerY') {
      axis = 'y'
      value = (minY + maxY) / 2 - t.h / 2
    } else return {}
    moves[t.id] = { axis: axis, value: snapTo(value) }
  }
  return moves
}

/** 四面引出端点：n/e/s/w。顺序固定，便于稳定比较。 */
const SIDES = ['n', 'e', 's', 'w']

/**
 * 一个节点四个**可连接的端点**（贴着边框）以及各自的引出桩点（边框外 24px）。
 *
 * 桩点就是 stubPointFor 的产物，也是落盘时写进 edge.points 的那个点 ——
 * 所以"预览从哪个端点进出"和"松手后从哪个端点进出"用的是同一份坐标。
 */
function anchorSidesOf(geo) {
  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  return {
    n: { side: 'n', x: cx, y: geo.y, sx: cx, sy: geo.y - 24 },
    e: { side: 'e', x: geo.x + geo.w, y: cy, sx: geo.x + geo.w + 24, sy: cy },
    s: { side: 's', x: cx, y: geo.y + geo.h, sx: cx, sy: geo.y + geo.h + 24 },
    w: { side: 'w', x: geo.x, y: cy, sx: geo.x - 24, sy: cy },
  }
}

/**
 * 按指针位置挑一个端点。
 *
 * 与"算法自己挑"的区别在于：这个选择是**看得见的** —— 四个端点会画出来，选中的那个高亮，
 * 预览线也从它进出。用户想换一个，把指针往那个端点挪近一点即可（判定就是距离最近）。
 * 平手时先用"进线方向对着源节点"的那个，避免指针落在节点中心时随机挑一边。
 */
function pickSides(geo, cursor, toward) {
  const anchors = anchorSidesOf(geo)
  let best = anchors.s
  let bestScore = Infinity
  for (let i = 0; i < SIDES.length; i += 1) {
    const a = anchors[SIDES[i]]
    const d = Math.abs(a.x - cursor.x) + Math.abs(a.y - cursor.y)
    // 只有"距离完全平手"时才看朝向（指针落在节点正中时四个端点里有两对等距）。
    // 注意 toward 要取自**源节点的真实中心**，不能用对齐过的中心 ——
    // 对齐后源中心正好落在目标中心上，朝向判据就永远为真、也就等于没有。
    const facing = Math.abs(a.x - toward.x) + Math.abs(a.y - toward.y)
    const score = d * 1000 + facing
    if (score < bestScore) {
      bestScore = score
      best = a
    }
  }
  return best
}

/**
 * （已退役）v1 的 `waypointsForRetarget` 在这里：它把"被拖端/固定端的端点约束"折算成
 * 贴在该侧外面的**桩点**，再混进 edge.points 一起落盘。
 *
 * v1.1 起这个函数不需要了：端点约束存在 style 的 `exitX/exitY`、`entryX/entryY` 里，
 * 由 `chainForRoute` 在**路由时**把桩点拼进必经点链。于是预览与落盘共用同一份拼装，
 * 而 edge.points 只剩用户真正摆下的折点 —— 两套模型不再互相污染。
 */

/**
 * 把一个落在节点内部的点推到该节点外面（推最短的一侧）。
 *
 * 为什么必须有：折点、锚点、端点桩点都可能落在某个节点内部（用户把线拖到节点上、
 * 或者节点移动后原本在外的折点被"吞"进去了）。这时若照直连过去，线就会**穿进节点内部**，
 * 看起来像画错了。实测过这些:
 *   · 折点在源节点内部   → 路径从东边出去又折回节点里 80px
 *   · 折点在目标边框上   → 最后一段沿着边框往下走 30px（贴着内部）
 *   · 拖线预览的锚点     → 回穿源节点 160px
 *
 * 方向 peference：优先沿"这个点相对节点的方位"往外推（哪边距离短走哪边），
 * 落在正中时按 toward（通常是另一端）决定，避免随便挑一边。
 * 推出去以后**不动**用户的折点数据 —— 只改路由用的副本。
 */
function pushOutOfBox(point, geo, toward) {
  const pad = 1
  const inside = point.x > geo.x && point.x < geo.x + geo.w && point.y > geo.y && point.y < geo.y + geo.h
  if (!inside) return point
  const left = point.x - geo.x
  const right = geo.x + geo.w - point.x
  const top = point.y - geo.y
  const bottom = geo.y + geo.h - point.y
  const d = toward === undefined || toward === null ? null : { x: toward.x - point.x, y: toward.y - point.y }
  // 四个候选出口（各带"这个出口是否朝 toward"的偏好）
  const options = [
    { side: 'w', dist: left, toward: d !== null && d.x < 0 },
    { side: 'e', dist: right, toward: d !== null && d.x > 0 },
    { side: 'n', dist: top, toward: d !== null && d.y < 0 },
    { side: 's', dist: bottom, toward: d !== null && d.y > 0 },
  ]
  const facing = options.filter((o) => o.toward)
  const pool = facing.length > 0 ? facing : options
  let best = pool[0]
  for (let i = 1; i < pool.length; i += 1) if (pool[i].dist < best.dist) best = pool[i]
  if (best.side === 'w') return { x: geo.x - pad, y: point.y }
  if (best.side === 'e') return { x: geo.x + geo.w + pad, y: point.y }
  if (best.side === 'n') return { x: point.x, y: geo.y - pad }
  return { x: point.x, y: geo.y + geo.h + pad }
}

/**
 * 从一批节点盒里找出 point 落在哪个盒子内部（返回第一个命中的）。
 */
function boxContaining(boxes, point, skip) {
  if (boxes === undefined || boxes === null) return null
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i]
    if (skip !== undefined && skip !== null && skip[box.id] === true) continue
    const geo = box.geo
    if (point.x > geo.x && point.x < geo.x + geo.w && point.y > geo.y && point.y < geo.y + geo.h) return box
  }
  return null
}

/** 一条边的某一端是否"有着落"：连着真实节点，或者有自由点（drawio 的悬空端）。 */
function edgeHasEnd(edge, end) {
  const id = end === 'source' ? edge.from : edge.to
  if (typeof id === 'string' && id.length > 0) return true
  return edgeFreePoint(edge, end) !== null
}

/**
 * 把一条边的一端解析成"盒子"：连着节点就用节点盒，悬空端用**自由点**合成一个零尺寸盒。
 *
 * 零尺寸盒正是预览给"空白处光标"用的那个技巧 —— 于是悬空端的路由与预览走同一条通路。
 * 优先顶点、自由点次之，正是 drawio 的规则（`sourcePoint`/`targetPoint` 只在该端
 * **没有**真实顶点时才生效，见 mxGeometry 的说明）。
 *
 * @returns 盒子，或 null（这一端既没顶点也没自由点 —— 这条边画不出来）
 */
function endpointBoxOf(byId, edge, end) {
  const id = end === 'source' ? edge.from : edge.to
  if (typeof id === 'string' && byId[id] !== undefined) return byId[id]
  const point = edgeFreePoint(edge, end)
  if (point === null) return null
  return { id: '__free-' + end, geo: { x: point.x, y: point.y, w: 0, h: 0 } }
}

/** 一条边当前的折线路径（命中与定位都要用，和渲染同一套逻辑）。 */
function edgeRoutePoints(doc, edge) {
  const geometry = buildGeometry(doc)
  const from = endpointBoxOf(geometry.byId, edge, 'source')
  const to = endpointBoxOf(geometry.byId, edge, 'target')
  if (from === null || to === null) return null
  return routeEdgeStyled(from, to, geometry.boxes, geometry.bounds, edge)
}

/**
 * 按一条边的 style 路由：折点、端点约束（`exitX/exitY` 与 `entryX/entryY`）、以及"是不是直线"
 * （`edgeStyle=none`）统统从文档的 style 键读。渲染、命中、标签定位、预览全走它 ——
 * 一条边在哪儿只有一个答案。
 */
function routeEdgeStyled(fromBox, toBox, boxes, bounds, edge) {
  const style = typeof edge.style === 'string' ? edge.style : DEFAULT_EDGE_STYLE
  return routeEdge(fromBox, toBox, boxes, bounds, edge.points, sidesFromStyle(style), !isOrthogonalEdgeStyle(style))
}

/**
 * 松手落点：**DOM 命中优先，没有 DOM 命中就回落到"最后一帧预览高亮的那个节点"**。
 *
 * 为什么必须有回落：预览是按**几何容差**（HOT_PAD）判"会连上"的，而节点组的 pointerup
 * 只有在指针**真的压在节点上**时才触发。于是松手落在容差里时，节点组收不到事件 ——
 * 表现就是"预览亮着环、松手什么也没有"（实测报过：从节点上方往目标下方/右方拖，连不上）。
 * 既然预览已经把它高亮成落点，落盘就该认它：预览高亮谁，就连谁。
 *
 * 放在模块级（而不是组件里）是为了能被自测直接断言。
 */
function dropTargetOf(domId, preview) {
  if (typeof domId === 'string' && domId.length > 0) return domId
  if (preview === null || preview === undefined) return null
  if (preview.hot === null || preview.hot === undefined) return null
  return typeof preview.hot.id === 'string' && preview.hot.id.length > 0 ? preview.hot.id : null
}

/** 节点的几何（渲染与路由共用同一套默认值）。 */
function nodeGeoOf(node) {
  return { x: numberOr(node.x, 0), y: numberOr(node.y, 0), w: numberOr(node.w, 150), h: numberOr(node.h, 56) }
}

/**
 * 指针落点下的节点 —— 按**几何**判定，不是 elementFromPoint。
 *
 * 两个原因：
 *  - 拖拽的最后一帧里，指针不一定还在节点上（稍稍滑出边界就不认了），而 draw.io 的语义是"靠近即接"；
 *  - 预览要提前知道落点，而 DOM 命中测试只有在松手那一刻才有意义。
 *
 * padding 是"靠近"的容差：指针落在形状外这么多像素里，也算落在它身上。
 * 倒序遍历 —— 后画的节点压在先画的上面，命中要按可见顺序取最上面那个。
 * excludeId：连线拖拽时排除起点自己（自环不在这里支持），改接端点时排除被钉住的那一端。
 */
function hitNodeAt(doc, geometry, x, y, padding, excludeId) {
  if (doc === null || geometry === undefined || geometry === null) return null
  for (let i = geometry.boxes.length - 1; i >= 0; i -= 1) {
    const box = geometry.boxes[i]
    if (excludeId !== null && excludeId !== undefined && box.id === excludeId) continue
    const g = box.geo
    if (x >= g.x - padding && x <= g.x + g.w + padding && y >= g.y - padding && y <= g.y + g.h + padding) return box
  }
  return null
}

/**
 * 实时预览的折线 —— **和真正落盘时走同一套路由**（routeEdge / connectOrtho / stubPointFor）。
 *
 * 这里曾经是一条从起点直接拉到指针的直线：能看出"在连线"，但看不出"这条线会怎么走"，
 * 松手那一刻路径会整段跳变成正交折线。既然路由函数本来就在手上，预览就该用同一套算法，
 * 让预览与结果一致（WYSIWYG）。
 *
 * 三种目标形态：
 *  - seed 非空：用户指定的引出边（和 onNodePointerUp 落盘时一样）——先把该侧的 stub 钉住，
 *    再从这个 stub 路由过去，否则算法会另挑一边，预览和结果就对不上；
 *  - 目标是一个真实节点（吸附命中）：用它的 geo，但 id 换掉 —— routeEdge 用 id 做过障碍排除和
 *    自环判定，沿用真 id 会把"预览的落点"和"图上的那个节点"混为一谈（比如 from === to 被判成自环）；
 *    用独立 id 还能保证目标节点被当成障碍物参与避让，预览更接近真实走线。
 *  - 目标是空白处的指针：造一个零尺寸的虚拟盒，于是 routeEdge 会从它现有的 6 个候选里挑一个
 *    L 形/绕行走法 —— 预览在空白处也是折线，而不是斜线。
 */
/**
 * 预览用的路由：把"这一帧选中的两端"当**约束**喂给 routeEdge。
 *
 * seed = { source, target, jetty }（侧名或 null）。与落盘写进 style 的 exitX/exitY、
 * entryX/entryY 是同一批值 —— 这是"预览即结果"的根据。
 */
function routePreview(fromBox, target, seed) {
  if (fromBox === undefined || fromBox === null || target === null || target === undefined) return null
  if (fromBox.id === target.id) return null
  const toBox = { id: '__preview', geo: target.geo }
  const boxes = []
  for (let i = 0; i < target.boxes.length; i += 1) boxes.push(target.boxes[i])
  boxes.push(toBox)
  const sides =
    seed === null || seed === undefined ? null : { source: seed.source, target: seed.target, jetty: seed.jetty }
  const raw = routeEdge(fromBox, toBox, boxes, target.bounds, null, sides)
  const pts = simplifyCollinear(dedupePoints(raw))
  for (let i = 0; i < pts.length; i += 1) {
    if (!Number.isFinite(pts[i].x) || !Number.isFinite(pts[i].y)) return null
  }
  if (pts.length < 2) return null
  return pts
}

/**
 * 把路由结果打包成预览数据。
 *
 * 返回 { points, hot, sides }：
 *  - hot 非空 = 指针落在了某个节点身上；
 *  - sides = { from, to } 是**这一帧选中的两个端点**（贴边框的那个 side 名或 null）。
 *    调用方在松手时把同一对 side 转成桩点写进文档，预览才不是"仅供参考"。
 *
 * 两端都钉住桩点来路由（而不是让 routeThroughWaypoints 自己再挑一次落点边），
 * 因为那一步会重新推导出边，用户看到的"接在右边"和实际落盘的边可能对不上。
 */
function routePreviewFor(doc, geometry, cursor, fromId, fromGeo, seed, padding, excludeId) {
  const hot = hitNodeAt(doc, geometry, cursor.x, cursor.y, padding, excludeId)
  const fromAnchors = anchorSidesOf(fromGeo)
  const seedSide = seed !== null && seed !== undefined && typeof seed.side === 'string' && seed.side.length > 0 ? seed.side : null
  const seedAnchor = seedSide === null ? null : fromAnchors[seedSide]
  if (seedSide !== null && seedAnchor === undefined) return null

  let toSide = null
  if (hot !== null) {
    // 指针落在节点上：按"离哪个端点近"选边 —— 目标侧也由用户选，不由算法猜。
    const toward = { x: fromGeo.x + fromGeo.w / 2, y: fromGeo.y + fromGeo.h / 2 }
    toSide = pickSides(hot.geo, cursor, toward).side
  }

  const fromBox = { id: fromId, geo: fromGeo, label: fromId }
  const targetGeo = hot === null ? { x: cursor.x, y: cursor.y, w: 0, h: 0 } : hot.geo
  const targetBox = { id: hot === null ? '__cursor' : hot.id, geo: targetGeo, boxes: geometry.boxes, bounds: geometry.bounds }
  // 两侧选中的端点作为**约束**喂给同一条路由：预览与落盘共用 chainForRoute，不存在两套判据。
  const clean = routePreview(fromBox, targetBox, { source: seedSide, target: toSide, jetty: null })
  if (clean === null) return null
  return {
    points: clean,
    hot: hot === null ? null : { id: hot.id, x: hot.geo.x, y: hot.geo.y, w: hot.geo.w, h: hot.geo.h },
    sides: { from: seedSide, to: toSide },
  }
}

/**
 * 改接端点（拖绿/红手柄）时的预览路由。
 *
 * 与连线拖拽的差别只有一处：**固定的那一端**在文档里，被拖的那一端跟着指针。
 * routeEdge 是从 from 路由到 to 的，所以拖 from 时要把两者交换再反转折线顺序。
 * 除锚点外的节点全算障碍物 —— 预览要尽量给出"松手后的样子"。
 *
 * excludeId 排除的是**固定那一端**（拖 to 时是 edge.from，拖 from 时是 edge.to）：
 * 指针滑回它身上时不该高亮它 —— 松手后那条边等于原地不动，把它标成"落点"是在骗人。
 */
function edgePreviewRoute(doc, geometry, edge, kind, cursor, padding) {
  const fromBox = geometry.byId[edge.from]
  const toBox = geometry.byId[edge.to]
  if (fromBox === undefined || toBox === undefined) return null
  const fixedId = kind === 'from' ? edge.to : edge.from
  const hot = hitNodeAt(doc, geometry, cursor.x, cursor.y, padding, fixedId)

  // 两个端点各自的盒：固定端来自文档，被拖端是指针所在处。
  const fixedBox = kind === 'from' ? toBox : fromBox
  const anchoredBox = kind === 'from' ? fromBox : toBox
  const cursorGeo = { x: cursor.x, y: cursor.y, w: 0, h: 0 }
  const movedBox = hot === null ? { id: anchoredBox.id, geo: cursorGeo } : { id: hot.id, geo: hot.geo }

  // 被拖这一端：吸附到节点就按"离哪个端点近"选边，和新建连线同一套判定。
  let movedSide = null
  if (hot !== null) {
    const toward = { x: fixedBox.geo.x + fixedBox.geo.w / 2, y: fixedBox.geo.y + fixedBox.geo.h / 2 }
    movedSide = pickSides(hot.geo, cursor, toward).side
  }
  // 固定端保持文档里现有的约束 —— **只读不猜**。
  // （v1 这里是"从 edge.points 反推它现在贴哪一侧"再补一个桩点；v1.1 起约束本来就在 style 里。）
  const fixedEnd = kind === 'from' ? 'target' : 'source'
  const fixedSide = pinnedSideOf(edge, fixedEnd)
  const sides = kind === 'from' ? { source: movedSide, target: fixedSide } : { source: fixedSide, target: movedSide }

  // 与落盘共用 routeEdge + chainForRoute —— 预览和结果是同一条线的保证就在这里。
  // 折点表始终按边的真实方向（fromBox → toBox）排列，所以**不反转**折线：
  // 拖 from 端时被拖的那个盒本来就是 fromBox，出来的顺序就是对的。
  const boxes = []
  for (let i = 0; i < geometry.boxes.length; i += 1) boxes.push(geometry.boxes[i])
  boxes.push(movedBox)
  const straight = !isOrthogonalEdgeStyle(typeof edge.style === 'string' ? edge.style : DEFAULT_EDGE_STYLE)
  const pts = kind === 'from'
    ? routeEdge(movedBox, fixedBox, boxes, geometry.bounds, edge.points, sides, straight)
    : routeEdge(fixedBox, movedBox, boxes, geometry.bounds, edge.points, sides, straight)
  const out = simplifyCollinear(dedupePoints(pts))
  for (let i = 0; i < out.length; i += 1) {
    if (!Number.isFinite(out[i].x) || !Number.isFinite(out[i].y)) return null
  }
  if (out.length < 2) return null
  return {
    points: out,
    hot: hot === null ? null : { id: hot.id, x: hot.geo.x, y: hot.geo.y, w: hot.geo.w, h: hot.geo.h },
    side: movedSide,
  }
}

/** 边标签落在哪：最长那一段的中点（与渲染保持一致）。 */
function edgeLabelPosition(pts) {
  if (pts === null || pts.length < 2) return null
  const a = pts.length >= 3 ? pts[1] : pts[0]
  const b = pts.length >= 3 ? pts[2] : pts[1]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function renderDiagram(doc, mode, uid, svgRef, ui, view) {
  const skin = mode === 'dark' ? DARK : LIGHT
  // 和 buildGeometry 用同一套几何：路由预览（局部命中/预览线）读的是 buildGeometry 的产物，
  // 两边各算一遍的话，只要默认值有一点差别，预览的落点就会和真正渲染的形状差几个像素。
  const geometry = buildGeometry(doc)
  const boxes = geometry.boxes
  const byId = geometry.byId
  const bounds = geometry.bounds
  const minX = bounds.minX
  const minY = bounds.minY
  const maxX = bounds.maxX
  const maxY = bounds.maxY
  const pad = 40
  // 视口：显式给了就用它（平移缩放），否则按内容自适应。
  const vx = view !== undefined && view !== null ? view.x : minX - pad
  const vy = view !== undefined && view !== null ? view.y : minY - pad
  const vw = view !== undefined && view !== null ? view.w : maxX - minX + pad * 2
  const vh = view !== undefined && view !== null ? view.h : maxY - minY + pad * 2
  const viewBox = [vx, vy, vw, vh].join(' ')
  const gridId = 'drawai-grid-' + uid
  const majorId = 'drawai-grid-major-' + uid
  const arrowId = 'drawai-arrow-' + uid
  const arrowStartId = 'drawai-arrow-start-' + uid

  const children = []
  children.push(
    React.createElement(
      'defs',
      { key: 'defs' },
      React.createElement(
        'pattern',
        { key: 'p1', id: gridId, width: 10, height: 10, patternUnits: 'userSpaceOnUse' },
        React.createElement('path', { d: 'M 10 0 L 0 0 0 10', fill: 'none', stroke: skin.gridMinor, strokeWidth: 1 }),
      ),
      React.createElement(
        'pattern',
        { key: 'p2', id: majorId, width: 50, height: 50, patternUnits: 'userSpaceOnUse' },
        React.createElement('rect', { width: 50, height: 50, fill: 'url(#' + gridId + ')' }),
        React.createElement('path', { d: 'M 50 0 L 0 0 0 50', fill: 'none', stroke: skin.gridMajor, strokeWidth: 1 }),
      ),
      React.createElement(
        'marker',
        { key: 'm', id: arrowId, viewBox: '0 0 10 10', refX: 9.5, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
        React.createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: skin.line }),
      ),
      // 起点箭头用**同一个**向右的三角形 + orient="auto-start-reverse"：
      // 这个 orient 值会让贴在线条起点上的 marker 自动反向，所以不必再画一个朝左的路径。
      React.createElement(
        'marker',
        { key: 'ms', id: arrowStartId, viewBox: '0 0 10 10', refX: 9.5, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
        React.createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: skin.line }),
      ),
    ),
  )

  // 网格纸铺满**整个视口**（不是只铺内容范围）—— 平移到内容之外时，底下仍然是格纸，
  // 而不是一片透明露出容器背景。
  const bgProps = {
    key: 'bg',
    x: vx,
    y: vy,
    width: vw,
    height: vh,
    fill: 'url(#' + majorId + ')',
  }
  // 点空白处 = 取消选中（bg 是垫在所有元素下面的那张纸）。
  if (ui !== undefined && ui !== null && typeof ui.onBackgroundPointerDown === 'function') {
    bgProps.onPointerDown = (event) => ui.onBackgroundPointerDown(event)
  }
  children.push(React.createElement('rect', bgProps))

  for (let i = 0; i < doc.edges.length; i += 1) {
    const edge = doc.edges[i]
    const from = endpointBoxOf(byId, edge, 'source')
    const to = endpointBoxOf(byId, edge, 'target')
    if (from === null || to === null) continue
    let pts = routeEdgeStyled(from, to, boxes, bounds, edge)
    // 安全网：路由若产出非有限坐标，退化成"中心直线"。
    // 宁可画得难看，也不要让边无声消失 —— 浏览器会静默丢弃 d="M NaN NaN" 的路径，
    // 这正是上面那个 box/geo 混用 bug 能藏这么久的原因。
    let degenerate = false
    for (let k = 0; k < pts.length; k += 1) {
      if (!Number.isFinite(pts[k].x) || !Number.isFinite(pts[k].y)) {
        degenerate = true
        break
      }
    }
    if (degenerate) {
      pts = [
        { x: from.geo.x + from.geo.w / 2, y: from.geo.y + from.geo.h / 2 },
        { x: to.geo.x + to.geo.w / 2, y: to.geo.y + to.geo.h / 2 },
      ]
    }
    const selected = ui !== undefined && ui !== null && Array.isArray(ui.selectedIds) && ui.selectedIds.indexOf(edge.id) >= 0
    // 命中层：连线本身只有 1px，直接点很难点中。先铺一条透明的宽带子承接触击。
    const hitProps = {
      key: 'edge-hit-' + i,
      className: 'drawai-edge-hit',
      d: pathOf(pts, 6),
      onPointerDown: (event) => {
        if (ui !== undefined && ui !== null && typeof ui.onSelectEdge === 'function') ui.onSelectEdge(edge.id, event)
      },
    }
    if (ui !== undefined && ui !== null) {
      if (typeof ui.onEdgeDoubleClick === 'function') {
        hitProps.onDoubleClick = (event) => ui.onEdgeDoubleClick(edge.id, event)
      }
      if (typeof ui.onEdgeContextMenu === 'function') {
        hitProps.onContextMenu = (event) => ui.onEdgeContextMenu(edge.id, event)
      }
    }
    children.push(React.createElement('path', hitProps))
    // 连线的画法全部存在文档的 style 键里：dashed/dashPattern 决定线型、endArrow/startArrow
    // 决定箭头、strokeColor 决定颜色、rounded 决定拐角是否圆滑 —— 与 drawio 一致，缺省即"不画"。
    // v1 只存语义（dash:'dashed'）而把像素值留在客户端；v1.1 起渲染参数就是文档的一部分。
    const edgeStyle = typeof edge.style === 'string' ? edge.style : ''
    const strokeColor = styleGet(edgeStyle, 'strokeColor', null)
    const arrow = arrowFromStyle(edgeStyle)
    const pattern = dashPatternFromStyle(edgeStyle)
    const cornerRadius = styleGet(edgeStyle, 'rounded', '0') === '1' ? 6 : 0
    const lineStroke = selected ? '#1a73e8' : strokeColor !== null ? strokeColor : skin.line
    const edgeProps = {
      key: 'edge-' + i,
      d: pathOf(pts, cornerRadius),
      fill: 'none',
      stroke: lineStroke,
      strokeWidth: selected ? 2 : styleNumber(edgeStyle, 'strokeWidth', 1),
      markerEnd: arrow === 'none' || arrow === 'start' ? undefined : 'url(#' + arrowId + ')',
      markerStart: arrow === 'both' || arrow === 'start' ? 'url(#' + arrowStartId + ')' : undefined,
      pointerEvents: 'none',
    }
    if (pattern !== null) edgeProps.strokeDasharray = pattern
    children.push(React.createElement('path', edgeProps))
    if (typeof edge.label === 'string' && edge.label.length > 0) {
      const a = pts.length >= 3 ? pts[1] : pts[0]
      const b = pts.length >= 3 ? pts[2] : pts[1]
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      // 边标签的画法同样来自文档：fontSize / fontColor。
      const edgeFontSize = styleNumber(edgeStyle, 'fontSize', 10)
      const edgeFontColor = styleGet(edgeStyle, 'fontColor', null)
      const edgeFontFill = edgeFontColor !== null ? edgeFontColor : skin.text
      const lw = textWidth(edge.label, edgeFontSize) + 6
      children.push(React.createElement('rect', { key: 'edge-bg-' + i, x: mx - lw / 2, y: my - 8, width: lw, height: 13, rx: 2, fill: skin.labelBg, opacity: 0.92 }))
      children.push(
        React.createElement(
          'text',
          {
            key: 'edge-text-' + i,
            x: mx,
            y: my + 1,
            textAnchor: 'middle',
            dominantBaseline: 'middle',
            fontSize: edgeFontSize,
            fontFamily: FONT,
            fill: edgeFontFill,
            // inline style：CSS 规则优先级高于 SVG presentation attribute，
            // 万一 shell 有 svg text{...} 之类的全局规则，只有 inline style 能压住。
            style: { fill: edgeFontFill, fontFamily: FONT, fontSize: edgeFontSize + 'px', dominantBaseline: 'middle' },
          },
          edge.label,
        ),
      )
    }
    // 选中时的可拖手柄。只保留两种，都是"用户能理解的东西"：
    //   实心 绿/红 = 端点（拖到别的节点 = 改接）
    //   空心 橙   = 段把手，每段一个（拖 = 整段平移）
    //
    // 刻意不再显示折点：它是"段平移"这套语义的内部记录，暴露出来只会让人多学一个概念。
    // 想撤销一条折弯用 Ctrl+Z；想全部回到自动，右键连线选「自动路由」。
    if (selected && ui !== undefined && ui !== null) {
      const handleCircle = (key, pos, onDown, fill, radius, stroke) =>
        React.createElement('circle', {
          key: key,
          className: 'drawai-handle',
          cx: pos.x,
          cy: pos.y,
          r: radius,
          fill: fill,
          stroke: stroke,
          strokeWidth: 2,
          onPointerDown: onDown,
        })
      const downAt = (kind, index) => (event) => {
        if (typeof ui.onEdgeHandlePointerDown === 'function') ui.onEdgeHandlePointerDown(edge.id, kind, index, event)
      }
      if (pts.length >= 2) {
        children.push(handleCircle('edge-from-' + i, pts[0], downAt('from', -1), '#0a7d32', 5, '#ffffff'))
        children.push(handleCircle('edge-to-' + i, pts[pts.length - 1], downAt('to', -1), '#b85450', 5, '#ffffff'))
      }
      for (let s = 0; s < pts.length - 1; s += 1) {
        const a = pts[s]
        const b = pts[s + 1]
        const segLen = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
        if (segLen < 26) continue // 太短的段不放，否则手柄会挤成一堆
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        children.push(handleCircle('edge-seg-' + i + '-' + s, mid, downAt('segment', s), '#ffffff', 4, '#f2a900'))
      }
    }
    // 改接端点时的预览：同样走真实路由（edgePreviewRoute），从固定那一端画到指针/目标节点。
    const preview = ui === undefined || ui === null ? null : ui.edgePreview
    if (preview !== null && preview !== undefined && preview.edgeId === edge.id && pts.length >= 2) {
      const anchor = preview.kind === 'from' ? pts[pts.length - 1] : pts[0]
      const routed = Array.isArray(preview.points) && preview.points.length >= 2 ? preview.points : null
      const sequence = routed === null ? [anchor, { x: preview.x, y: preview.y }] : routed
      const d = pathOf(sequence, 6)
      if (d.length > 0) {
        children.push(
          React.createElement('path', {
            key: 'edge-preview-' + i,
            className: 'drawai-preview',
            d: d,
            fill: 'none',
            stroke: '#1a73e8',
            strokeWidth: 2,
            strokeDasharray: '6 4',
          }),
        )
        const end = sequence[sequence.length - 1]
        if (Math.abs(end.x - preview.x) > 0.5 || Math.abs(end.y - preview.y) > 0.5) {
          children.push(
            React.createElement('line', {
              key: 'edge-preview-tip-' + i,
              className: 'drawai-preview-tip',
              x1: end.x,
              y1: end.y,
              x2: preview.x,
              y2: preview.y,
              stroke: '#1a73e8',
              strokeWidth: 2,
              strokeDasharray: '6 6',
              markerEnd: 'url(#' + arrowId + ')',
            }),
          )
        }
      } else {
        // 退化兜底：路由算不出有效折线时，至少还有一条直线跟着指针（宁可难看，不要消失）。
        children.push(
          React.createElement('line', {
            key: 'edge-preview-' + i,
            className: 'drawai-preview',
            x1: anchor.x,
            y1: anchor.y,
            x2: preview.x,
            y2: preview.y,
            stroke: '#1a73e8',
            strokeWidth: 2,
            strokeDasharray: '6 4',
          }),
        )
      }
    }
  }

  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i]
    const geo = box.geo
    const node = box.node
    const shape = shapeOf(node)
    const selected = ui !== undefined && ui !== null && Array.isArray(ui.selectedIds) && ui.selectedIds.indexOf(node.id) >= 0
    // 形状 + 标签放在同一个 <g> 里承载指针事件 —— 让浏览器做命中测试，
    // 比自己算"点是否落在菱形内"可靠得多。
    // 注意 connectPreview.hot 与 edgePreview.hot 都是**对象**（{id,x,y,w,h}），不是 id 字符串；
    // 这里曾经直接拿它和 node.id 比，于是改接端点时环永远不亮（字符串 !== 对象）。
    const hotspot =
      ui !== undefined &&
      ui !== null &&
      (ui.connectHover === node.id ||
        (ui.edgePreview !== null && ui.edgePreview !== undefined && ui.edgePreview.hot !== null && ui.edgePreview.hot !== undefined && ui.edgePreview.hot.id === node.id))
    const groupProps = { key: 'node-' + i, className: hotspot ? 'drawai-node drawai-node-hot' : 'drawai-node', 'data-node-id': node.id }
    if (ui !== undefined && ui !== null) {
      if (typeof ui.onNodePointerDown === 'function') {
        groupProps.onPointerDown = (event) => ui.onNodePointerDown(node.id, event)
      }
      if (typeof ui.onNodeDoubleClick === 'function') {
        groupProps.onDoubleClick = (event) => ui.onNodeDoubleClick(node.id, event)
      }
      if (typeof ui.onNodePointerUp === 'function') {
        groupProps.onPointerUp = () => ui.onNodePointerUp(node.id)
      }
      if (typeof ui.onNodeContextMenu === 'function') {
        groupProps.onContextMenu = (event) => ui.onNodeContextMenu(node.id, event)
      }
    }
    const groupChildren = [shapeElement(node, geo, colorOf(node, mode), mode)]
    // 单选一个节点时给 8 个方向的缩放手柄。
    if (selected && ui !== undefined && ui !== null && ui.singleSelectedNodeId === node.id && typeof ui.onResizePointerDown === 'function') {
      const dirs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      for (let d = 0; d < dirs.length; d += 1) {
        const dir = dirs[d]
        const hx = dir.indexOf('w') >= 0 ? geo.x : dir.indexOf('e') >= 0 ? geo.x + geo.w : geo.x + geo.w / 2
        const hy = dir.indexOf('n') >= 0 ? geo.y : dir.indexOf('s') >= 0 ? geo.y + geo.h : geo.y + geo.h / 2
        groupChildren.push(
          React.createElement('rect', {
            key: 'rs-' + dir,
            className: 'drawai-handle drawai-rs-' + dir,
            x: hx - 4,
            y: hy - 4,
            width: 8,
            height: 8,
            fill: '#ffffff',
            stroke: '#1a73e8',
            strokeWidth: 1.5,
            onPointerDown: (event) => ui.onResizePointerDown(node.id, dir, event),
          }),
        )
      }
    }
    if (selected) {
      groupChildren.push(
        React.createElement('rect', {
          key: 'sel',
          x: geo.x - 3,
          y: geo.y - 3,
          width: geo.w + 6,
          height: geo.h + 6,
          rx: 4,
          fill: 'none',
          className: 'drawai-sel',
          pointerEvents: 'none',
        }),
      )
    }
    // 标签的画法也在文档里：fontSize / fontColor / whiteSpace。
    // whiteSpace=nowrap 不换行（drawio 的语义就是这个），其余（含缺省）按宽度换行。
    const labelStyle = typeof node.style === 'string' ? node.style : ''
    const labelFontSize = styleNumber(labelStyle, 'fontSize', FSIZE)
    const labelFill = colorOf(node, mode).font
    const wrap = styleGet(labelStyle, 'whiteSpace', 'wrap') !== 'nowrap'
    let maxText = geo.w - 12
    if (shape === 'diamond') maxText = geo.w * 0.6
    if (shape === 'ellipse') maxText = geo.w * 0.72
    const lines = wrap ? wrapLabel(box.label, maxText) : [String(box.label)]
    const cx = geo.x + geo.w / 2
    const lineHeight = LHEIGHT * (labelFontSize / FSIZE)
    const first = geo.y + geo.h / 2 - ((lines.length - 1) * lineHeight) / 2
    const spans = []
    for (let li = 0; li < lines.length; li += 1) {
      spans.push(React.createElement('tspan', { key: 'l' + li, x: cx, dy: li === 0 ? 0 : lineHeight }, lines[li]))
    }
    groupChildren.push(
      React.createElement(
        'text',
        {
          key: 'label-' + i,
          x: cx,
          y: first,
          textAnchor: 'middle',
          dominantBaseline: 'middle',
          fontSize: labelFontSize,
          fontFamily: FONT,
          fill: labelFill,
          pointerEvents: 'none',
          style: { fill: labelFill, fontFamily: FONT, fontSize: labelFontSize + 'px', dominantBaseline: 'middle' },
        },
        spans,
      ),
    )
    // 四面引出端点：上下左右各一个，从这里拖到另一个节点 = 连一条边，
    // 并且**记住是从哪一边引出的**（拖出来的线从那一边出来，不会按算法另挑一边）。
    // 位置推在边框外 16px —— 边框上有 8 个缩放手柄，挤在一起会点错。
    if (selected && ui !== undefined && ui !== null && typeof ui.onHandlePointerDown === 'function') {
      const sides = ['n', 'e', 's', 'w']
      for (let d = 0; d < sides.length; d += 1) {
        const side = sides[d]
        const hx = side === 'e' || side === 'w' ? geo.x + (side === 'e' ? geo.w + 16 : -16) : geo.x + geo.w / 2
        const hy = side === 'n' || side === 's' ? geo.y + (side === 's' ? geo.h + 16 : -16) : geo.y + geo.h / 2
        groupChildren.push(
          React.createElement('circle', {
            key: 'link-' + side,
            className: 'drawai-handle drawai-link',
            cx: hx,
            cy: hy,
            r: 5,
            fill: '#0a7d32',
            stroke: '#ffffff',
            strokeWidth: 2,
            onPointerDown: (event) => ui.onHandlePointerDown(node.id, side, event),
          }),
        )
      }
    }
    // 拖线时的实时预览：
    //   1) 正交折线 —— 与松手后落盘的走线**同一套路由**（routePreview），所以预览即结果；
    //   2) 收尾小段 —— 从折线终点画到落点，让"线跟着指针"这件事始终可见（折线可能停在
    //      落点侧面/上方，没有这一段会像断掉了）。dashoffset 动画让它有流向感。
    // 曾经这里是一条从起点直连指针的直线：能看出在连线，但看不出会怎么绕，松手瞬间整条跳变。
    if (ui !== undefined && ui !== null && ui.connectFrom === node.id && ui.connectTo !== null && ui.connectTo !== undefined) {
      const preview = ui.connectPreview
      const to = ui.connectTo
      const straight = () => {
        const side = typeof ui.connectSide === 'string' ? ui.connectSide : 'e'
        const x = side === 'e' || side === 'w' ? geo.x + (side === 'e' ? geo.w + 16 : -16) : geo.x + geo.w / 2
        const y = side === 'n' || side === 's' ? geo.y + (side === 's' ? geo.h + 16 : -16) : geo.y + geo.h / 2
        return [{ x: x, y: y }, { x: to.x, y: to.y }]
      }
      const pts = preview !== null && preview !== undefined && Array.isArray(preview.points) && preview.points.length >= 2 ? preview.points : straight()
      const d = pathOf(pts, 6)
      if (d.length > 0) {
        groupChildren.push(
          React.createElement('path', {
            key: 'preview',
            className: 'drawai-preview',
            d: d,
            fill: 'none',
            stroke: '#1a73e8',
            strokeWidth: 2,
            strokeDasharray: '6 4',
          }),
        )
        const anchor = pts[0]
        const end = pts[pts.length - 1]
        // 收尾段接到**指针**而不是折线终点：吸附时折线终点在目标边框上，指针还在边框外的
        // 容差范围里，接指针能让"线头跟着手"保持连续。
        if (Math.abs(end.x - to.x) > 0.5 || Math.abs(end.y - to.y) > 0.5) {
          groupChildren.push(
            React.createElement('line', {
              key: 'preview-tip',
              className: 'drawai-preview-tip',
              x1: end.x,
              y1: end.y,
              x2: to.x,
              y2: to.y,
              stroke: '#1a73e8',
              strokeWidth: 2,
              strokeDasharray: '6 6',
              markerEnd: 'url(#' + arrowId + ')',
            }),
          )
        }
        // 起点圆点：让"这条线从这里引出"明确可见（引出端点本身在边框外 16px 处，两者不重合）。
        groupChildren.push(
          React.createElement('circle', {
            key: 'preview-dot',
            className: 'drawai-preview',
            cx: anchor.x,
            cy: anchor.y,
            r: 3.5,
            fill: '#1a73e8',
            stroke: '#ffffff',
            strokeWidth: 1.5,
          }),
        )
      }
    }
    // 吸附命中：目标节点本身的提示环（画在该节点自己的 <g> 里，于是天然贴着形状，
    // 也不用关心它在文档里排在前面还是后面）。连线拖拽与改接端点共用这一套。
    // connectHover 是 id 字符串；edgePreview.hot 是对象 —— 两者的取值方式不同，别写混。
    if (
      ui !== undefined &&
      ui !== null &&
      (ui.connectHover === node.id ||
        (ui.edgePreview !== null && ui.edgePreview !== undefined && ui.edgePreview.hot !== null && ui.edgePreview.hot !== undefined && ui.edgePreview.hot.id === node.id))
    ) {
      groupChildren.push(
        React.createElement('rect', {
          key: 'hot-ring',
          className: 'drawai-hot-ring',
          x: geo.x - 6,
          y: geo.y - 6,
          width: geo.w + 12,
          height: geo.h + 12,
          rx: 8,
          fill: 'none',
          stroke: '#1a73e8',
          strokeWidth: 2.5,
        }),
      )

      // 四个可连接的端点。连线拖到附近时把它们画出来，**选中的那个放大高亮** ——
      // 这样"会接在哪一边"是看得见的判断，而不是算法背地里决定的。
      // 想换一边：把指针往那个端点挪近一点（判定就是距离最近）。
      const anchorSource = ui.connectHover === node.id ? ui.connectPreview : ui.edgePreview
      const activeSide = anchorSource !== null && anchorSource !== undefined && anchorSource.sides !== undefined ? anchorSource.sides.to : null
      const activeSideFallback = anchorSource !== null && anchorSource !== undefined && typeof anchorSource.side === 'string' ? anchorSource.side : null
      const chosenSide = activeSide !== null && activeSide !== undefined ? activeSide : activeSideFallback
      const anchors = anchorSidesOf(geo)
      for (let d = 0; d < SIDES.length; d += 1) {
        const a = anchors[SIDES[d]]
        const on = chosenSide === a.side
        groupChildren.push(
          React.createElement('circle', {
            key: 'anchor-' + a.side,
            className: on ? 'drawai-anchor drawai-anchor-on' : 'drawai-anchor',
            cx: a.x,
            cy: a.y,
            r: on ? 6 : 4,
            fill: on ? '#1a73e8' : '#ffffff',
            stroke: on ? '#ffffff' : '#1a73e8',
            strokeWidth: 2,
          }),
        )
      }
    }
    children.push(React.createElement('g', groupProps, groupChildren))
  }

  // 框选矩形：铺在所有元素之上。
  const box = ui === undefined || ui === null ? null : ui.marquee
  if (box !== null && box !== undefined) {
    const bx = Math.min(box.x0, box.x1)
    const by = Math.min(box.y0, box.y1)
    const bw = Math.abs(box.x1 - box.x0)
    const bh = Math.abs(box.y1 - box.y0)
    children.push(
      React.createElement('rect', {
        key: 'marquee',
        x: bx,
        y: by,
        width: bw,
        height: bh,
        fill: 'rgba(26,115,232,0.12)',
        stroke: '#1a73e8',
        strokeWidth: 1,
        strokeDasharray: '4 3',
        pointerEvents: 'none',
      }),
    )
  }

  return React.createElement('svg', { ref: svgRef, viewBox: viewBox, width: '100%', height: '100%', preserveAspectRatio: 'none', style: { display: 'block', background: skin.page } }, children)
}

/**
 * 把一个 Remote 返回值描述成可读的一行，用于诊断 —— 不猜结构，直接看。
 * 只做浅层枚举 + 截断的 JSON，避免把大对象灌进界面。
 */
function describeValue(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value !== 'object') return typeof value + ' ' + String(value)
  let keys = ''
  try {
    keys = Object.keys(value).join(', ')
  } catch (error) {
    keys = '(取键失败)'
  }
  let json = ''
  try {
    const text = JSON.stringify(value)
    json = typeof text === 'string' ? (text.length > 500 ? text.slice(0, 500) + '…' : text) : '(不可序列化)'
  } catch (error) {
    json = '(stringify 抛错：' + (error && error.message ? error.message : String(error)) + ')'
  }
  return '键 = [' + keys + ']\nJSON = ' + json
}

function parseDocument(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { error: 'JSON 解析失败：' + (error && error.message ? error.message : String(error)) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: '文档根节点必须是一个 JSON 对象' }
  // 读时升级与宿主共用同一份逻辑（style-kernel 的 normalizeDrawioDoc）：
  // v1 的 shape/style(颜色名)/dash/arrow 与折点里的桩点，都在这里翻成 v2 的 style 键与进出侧约束。
  // 两边**必须**用同一个函数 —— 否则同一份文件在画布上和 AI 眼里会是两张不同的图。
  const doc = normalizeDrawioDoc(raw)
  const nodes = doc.nodes.filter((n) => n !== null && typeof n === 'object' && typeof n.id === 'string')
  // 两端各自"有着落"就收：连着节点，或带自由点（drawio 的悬空端）。
  // v1 这里要求两端都是真实节点，于是 drawio 导出的**悬空边**会被整条丢掉。
  const edges = doc.edges.filter((e) => e !== null && typeof e === 'object' && edgeHasEnd(e, 'source') && edgeHasEnd(e, 'target'))
  // **0 个节点不是错误** —— 空画布是完全合法的状态（刚「新建」出来就是这样，
  // 用户还要靠右键往里面加节点）。这里曾经返回 error，于是新建出来的画布一进去就是红字，
  // 连右键都点不了 —— 等于「新建」功能废掉。
  // 真正该报错的是"文件不是画布文档"，而不是"画布还是空的"。
  return { doc: { version: doc.version, revision: doc.revision, meta: doc.meta, nodes: nodes, edges: edges }, migrated: doc.migrated }
}

function basename(address) {
  if (typeof address !== 'string') return ''
  const clean = address.split('?')[0].split('#')[0]
  const parts = clean.split('/')
  return parts[parts.length - 1] || ''
}

/**
 * 把 tab 的地址解析成"能交给宿主 fs.resolve 的路径"。认不出就返回 undefined。
 *
 * 原来只认 `dsh-resource://file/session/<id>/<rel>` 一种形式，其余一律 undefined ——
 * 而地址**实际**还可能是别的样子（实测用户的 tab 就解析不出来，于是永久停在"(未绑定)"，
 * 屏幕空白、AI 却会去改 demo.dshd.json）。所以这里按"形式"逐个处理，而不是只认一种：
 *
 *   dsh-resource://file/session/<id>/<rel>   → <rel>（相对工作区）
 *   dsh-resource://file/<rel>                → <rel>
 *   file:///D:/x/y.dshd.json                 → 绝对路径
 *   /D:/x/y.dshd.json                        → 去掉前导斜杠（Windows 上多一个 / 就认不出）
 *   D:\x\y.dshd.json 或 D:/x/y.dshd.json     → 绝对路径
 *
 * 绝对路径也是**合法输入**：宿主的 fs.resolve 收相对路径（带 cwd）也收绝对路径，
 * 而且写入前会做 contains(工作区根) 校验，所以这里放宽不会开出口子。
 */
function pathFromAddress(address) {
  if (typeof address !== 'string') return undefined
  const raw = address.split('?')[0].split('#')[0].trim()
  if (raw.length === 0) return undefined

  let candidate = null
  if (raw.indexOf('dsh-resource://') === 0) {
    const parts = raw.slice('dsh-resource://'.length).split('/')
    if (parts.length === 0) return undefined
    let tail = parts
    if (parts[0] === 'file') {
      if (parts[1] === 'session' && parts.length > 3) tail = parts.slice(3)
      else tail = parts.slice(1)
    }
    const joined = tail.join('/')
    candidate = joined.length === 0 ? null : joined
  } else if (raw.indexOf('file://') === 0) {
    let rest = raw.slice('file://'.length)
    // file://host/path 里的 host 段（本地文件通常是空或 localhost）
    if (rest.indexOf('/') > 0) rest = rest.slice(rest.indexOf('/'))
    candidate = rest
  } else {
    // 只接受**看起来像文件路径**的串。
    //
    // 这里翻过车：为了让绝对路径（D:\x\y.dshd.json）能解析，一度写成"其余一律原样返回"，
    // 结果 tab 自己的地址 `sidebar://diagram` 也被当成相对路径交给宿主去读 ——
    // 宿主报 workspace-file/not-found，界面上显示一串 RemoteError JSON。
    // 判据：带 scheme 的（`x://…`）不是文件路径。
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(raw)) return undefined
    candidate = raw
  }
  if (candidate === null) return undefined

  let out = candidate.replace(/\\/g, '/').trim()
  // Windows 绝对路径被写成 /D:/... 时去掉多余的前导斜杠
  if (/^\/[A-Za-z]:\//.test(out)) out = out.slice(1)
  // 纯网络路径（//host/share）不是工作区文件，交回去也解析不了
  if (out.indexOf('//') === 0) return undefined
  return out.length === 0 ? undefined : out
}

function CanvasView(props) {
  const sessionId = props.sessionId
  const path = props.path
  const infoError = typeof props.infoError === 'string' ? props.infoError : ''
  // 路径由**外层标签页**管（CanvasTabs）：这里只读，不再自己持有。
  // 三种状态在 CanvasTabs 里判定好，传下来的是干净的 path / untitled / unbound。
  const untitled = props.untitled === true
  const unbound = props.unbound === true
  const target = typeof props.path === 'string' ? props.path : ''
  const hasPath = props.hasPath === true
  /** 请求外层开一个新标签（或切到已打开的那个）。「打开」用。 */
  const onOpenTab = typeof props.onOpenTab === 'function' ? props.onOpenTab : () => {}
  /** 通知外层"本标签现在绑定到哪了"（另存为 / 切换文件后）。 */
  const onRebind = typeof props.onRebind === 'function' ? props.onRebind : () => {}
  const uidState = React.useState(() => 'u' + Math.random().toString(36).slice(2, 8))
  const uid = uidState[0]
  const active = props.active !== false
  const svgRef = React.useRef(null)
  const modeState = React.useState('light')
  const mode = modeState[0]
  const setMode = modeState[1]
  const docState = React.useState(null)
  const doc = docState[0]
  const setDoc = docState[1]
  const statusState = React.useState({ kind: 'loading', path: target, error: '', absolute: '' })
  const status = statusState[0]
  const setStatus = statusState[1]
  const nonceState = React.useState(0)
  const nonce = nonceState[0]
  const setNonce = nonceState[1]

  // ---- 交互状态 ------------------------------------------------------------
  // 选中（集合，支持框选与 Shift 加选）/ 就地改标签 / 连线 / 保存提示
  const selectionState = React.useState([])
  const selectedIds = selectionState[0]
  const setSelectedIds = selectionState[1]
  const editingState = React.useState(null)
  const editing = editingState[0]
  const setEditing = editingState[1]
  const connectFromState = React.useState(null)
  const connectFrom = connectFromState[0]
  const setConnectFrom = connectFromState[1]
  const connectToState = React.useState(null)
  const connectTo = connectToState[0]
  const setConnectTo = connectToState[1]
  const connectSideState = React.useState('e')
  const connectSide = connectSideState[0]
  const setConnectSide = connectSideState[1]
  const connectHoverState = React.useState(null) // 拖线时指针吸附到的目标节点 id（仅用于渲染提示环）
  const connectHover = connectHoverState[0]
  const setConnectHover = connectHoverState[1]
  const connectPreviewState = React.useState(null) // { points, hot, sides }：与落盘同一套路由算出的预览折线
  const connectPreview = connectPreviewState[0]
  const setConnectPreview = connectPreviewState[1]
  const saveState = React.useState('')
  const saveNote = saveState[0]
  const setSaveNote = saveState[1]
  // 下拉菜单展开在**哪个按钮下面**：{ key, left, top }。
  // 之前只记了 key，面板一律画在画布左上角 —— 于是点「导出」菜单会跑到「文件」按钮下面，
  // 用户根本看不出它是从哪儿开出来的。
  const [docMenuPos, setDocMenuPos] = React.useState(null)
  // 工具条按钮的 DOM 引用：key → button 元素，用于算出按钮在**画布**里的位置。
  const toolBtnRefs = React.useRef({})

  // 工作副本放在 ref 里：指针事件回调是渲染期创建的闭包，读 state 会拿到旧值。
  const docRef = React.useRef(null)
  const revisionRef = React.useRef(0)
  const dirtyRef = React.useRef(false)
  const dragRef = React.useRef(null)
  const linkRef = React.useRef(null)
  const saveTimerRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  // pointerup 时要落盘的是"用户最后看到的那一帧选中的端点"，所以预览数据也留一份在 ref 里。
  const connectPreviewRef = React.useRef(null)
  const edgePreviewRef = React.useRef(null)
  /** 上一次用文件管理器选中的目录：用于面板里的「重新选择目录」与「重新读取」。 */
  const lastPickedDirRef = React.useRef('')
  /** 上一次上报给宿主的聚焦路径：避免每帧都打一次网络。 */
  const focusReportedRef = React.useRef(null)

  // ---- 视口（平移 / 缩放）--------------------------------------------------
  const sizeState = React.useState({ w: 0, h: 0 })
  const size = sizeState[0]
  const setSize = sizeState[1]
  const viewState = React.useState(null) // null = 自适应内容；对象 = 用户平移缩放后的视口
  const viewOverride = viewState[0]
  const setViewOverride = viewState[1]
  const viewRef = React.useRef(null)
  const panRef = React.useRef(null)

  // ---- 右键菜单 / 连线拖拽 ------------------------------------------------
  const menuState = React.useState(null) // { kind: 'canvas'|'node'|'edge', id, left, top, userX, userY }
  const menu = menuState[0]
  const setMenu = menuState[1]
  const menuStyleState = React.useState('blue')
  const menuStyle = menuStyleState[0]
  const setMenuStyle = menuStyleState[1]
  const edgeDragRef = React.useRef(null) // { edgeId, kind: 'segment'|'from'|'to', ... }
  const marqueeRef = React.useRef(null) // 框选拖拽 { x0, y0, x1, y1, additive, moved }
  const marqueeState = React.useState(null) // 同上，供渲染
  const marquee = marqueeState[0]
  const setMarquee = marqueeState[1]
  const resizeRef = React.useRef(null) // 缩放拖拽 { id, dir, originX, originY, x, y, w, h }
  const exportState = React.useState(null) // null | 'svg' | 'png'
  const exportRequest = exportState[0]
  const setExportRequest = exportState[1]
  // 文档三件套的弹出面板：null | 'new'（输入文件名） | 'open'（选择已有文件）
  const docMenuState = React.useState(null)
  const docMenu = docMenuState[0]
  const setDocMenu = docMenuState[1]
  const fileListState = React.useState(null) // null=未拉取 | { files, error }
  const fileList = fileListState[0]
  const setFileList = fileListState[1]
  const newNameState = React.useState('')
  const newName = newNameState[0]
  const setNewName = newNameState[1]
  /** 新建/另存为输入框的 DOM 引用：打开时要**全选**，用户直接输入即替换默认名。 */
  const nameInputRef = React.useRef(null)
  // 撤销/重做：快照栈。文档只有几十 KB，压快照比逐条写 undo/redo 逻辑可靠得多，也不会漏项。
  const historyRef = React.useRef({ past: [], future: [] })
  const lastCoalesceRef = React.useRef(null) // 同一次手势内的连续改动只记一个快照
  const previewState = React.useState(null) // 改接端点时的预览线终点 { edgeId, kind, x, y }
  const edgePreview = previewState[0]
  const setEdgePreview = previewState[1]

  function nodeById(id) {
    const current = docRef.current
    if (current === null) return null
    for (let i = 0; i < current.nodes.length; i += 1) if (current.nodes[i].id === id) return current.nodes[i]
    return null
  }

  // ---- 撤销 / 重做（快照栈）------------------------------------------------
  const HISTORY_LIMIT = 60

  /**
   * 深一层拷贝：nodes/edges 是数组，edge.points / sourcePoint / targetPoint 是嵌套对象，
   * 快照必须互不影响（否则撤销会写坏工作副本，而且是静默的）。
   *
   * v1.1 顺带修掉一个真实缺口：这里以前只留 {revision, nodes, edges}，
   * **version 与 meta 被丢掉** —— 于是人一保存，盘上的 version 与 meta 就没了。
   */
  function cloneDoc(source) {
    return {
      version: source.version,
      revision: source.revision,
      meta: source.meta === undefined || source.meta === null ? source.meta : Object.assign({}, source.meta),
      nodes: source.nodes.map((n) => Object.assign({}, n)),
      edges: source.edges.map((e) => {
        const copy = Object.assign({}, e)
        if (Array.isArray(e.points)) copy.points = e.points.map((p) => ({ x: p.x, y: p.y }))
        if (e.sourcePoint !== undefined) copy.sourcePoint = { x: e.sourcePoint.x, y: e.sourcePoint.y }
        if (e.targetPoint !== undefined) copy.targetPoint = { x: e.targetPoint.x, y: e.targetPoint.y }
        return copy
      }),
    }
  }

  /** 落一份文档：更新工作副本、标脏、排一次防抖保存。撤销/重做也走这里。 */
  function commitDoc(next) {
    docRef.current = next
    dirtyRef.current = true
    setDoc(next)
    scheduleSave()
  }

  function undo() {
    const history = historyRef.current
    const current = docRef.current
    if (history.past.length === 0 || current === null) return
    history.future.push(cloneDoc(current))
    commitDoc(cloneDoc(history.past.pop()))
    lastCoalesceRef.current = null
    setSelectedIds([])
    setEditing(null)
    setMenu(null)
  }

  function redo() {
    const history = historyRef.current
    const current = docRef.current
    if (history.future.length === 0 || current === null) return
    history.past.push(cloneDoc(current))
    commitDoc(cloneDoc(history.future.pop()))
    lastCoalesceRef.current = null
    setSelectedIds([])
    setEditing(null)
    setMenu(null)
  }

  /** 服务端推来新版本时清空历史 —— 否则一次撤销会把别人（或 AI）刚写的改动悄悄顶掉。 */
  function resetHistory() {
    historyRef.current.past.length = 0
    historyRef.current.future.length = 0
    lastCoalesceRef.current = null
  }

  /** 本地乐观改动：先压快照，再改，立刻反映到界面并排一次防抖落盘。 */
  function applyLocal(mutate, coalesceKey) {
    const current = docRef.current
    if (current === null) return
    const key = coalesceKey === undefined ? null : coalesceKey
    if (key === null || lastCoalesceRef.current !== key) {
      const past = historyRef.current.past
      past.push(cloneDoc(current))
      if (past.length > HISTORY_LIMIT) past.shift()
      historyRef.current.future.length = 0
      lastCoalesceRef.current = key
    }
    const next = cloneDoc(current)
    mutate(next)
    commitDoc(next)
  }

  function scheduleSave() {
    if (client === null) return
    if (saveTimerRef.current !== null) {
      saveTimerRef.current()
      saveTimerRef.current = null
    }
    // 用 cordis 定时器而不是 setTimeout：它是 fiber effect，插件卸载时自动清掉。
    saveTimerRef.current = client.timeout(() => {
      saveTimerRef.current = null
      saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * 向宿主要一次文件清单（「打开」菜单用）。
   *
   * 复用保存那条路由的 `action: 'list'`：客户端没有列目录的读权限通道，
   * 而宿主那边已经有带信任围栏（POST + 自定义头 + 同源）的入口，少开一个口子。
   */
  async function fetchFileList(dir) {
    setFileList({ files: null, error: '' })
    const body = { action: 'list', sessionId: sessionId }
    if (typeof dir === 'string' && dir.length > 0) body.dir = dir
    let raw = null
    try {
      raw = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      setFileList({ files: null, error: '请求失败：' + (error && error.message ? error.message : String(error)) })
      return
    }
    let payload = null
    try {
      payload = await raw.json()
    } catch (error) {
      setFileList({ files: null, error: '返回不是 JSON（HTTP ' + raw.status + '）' })
      return
    }
    if (payload === null || payload.ok !== true) {
      setFileList({ files: null, error: String(payload !== null && payload.error ? payload.error : 'HTTP ' + raw.status) })
      return
    }
    // 宿主同时给了相对路径（给人看）与绝对路径（当身份）。
    // 用绝对路径去重：标签上的路径可能来自 tab 的资源地址（绝对），
    // 与列表里的相对路径不相等 —— 直接比就会给同一个文件开出两个标签。
    const rel = Array.isArray(payload.files) ? payload.files : []
    const abs = Array.isArray(payload.absolute) ? payload.absolute : []
    const entries = []
    for (let i = 0; i < rel.length; i += 1) {
      const identity = typeof abs[i] === 'string' && abs[i].length > 0 ? abs[i] : rel[i]
      entries.push({ path: identity, display: rel[i] })
    }
    setFileList({
      files: entries,
      error: '',
      notes: Array.isArray(payload.notes) ? payload.notes : [],
      dir: typeof payload.dir === 'string' ? payload.dir : '',
    })
  }

  /**
   * 「打开」：先弹**系统文件管理器**选一个目录，再列出该目录下的画布。
   *
   * 为什么是选目录而不是选文件：DSH 的 uiWorkspace 只提供 `pickDirectory()`
   * （没有选单个文件的接口）。所以流程是"选目录 → 列该目录下的 .dshd.json"，
   * 比原来只能在"工作区根目录 + 一层子目录"里挑要灵活得多。
   *
   * uiWorkspace 用 ctx.get 取（可选依赖）：拿不到就退回原来的"列工作区"，
   * 不让整个「打开」按钮失效。
   */
  async function openFilePicker() {
    if (docMenu === 'open') {
      setDocMenu(null)
      return
    }
    setDocMenu('open')
    // **不弹系统选择器**：直接列出"上次用过的目录"（没选过就是工作区）。
    // 每次点「打开」都弹一次文件管理器很烦 —— 多数时候用户只是想切到另一个画布。
    // 只有点面板里的「选择目录…」才真的弹选择器。
    fetchFileList(lastPickedDirRef.current)
  }

  /**
   * 「选择目录…」：弹**系统文件管理器**选一个目录，然后列出该目录下的画布。
   *
   * 为什么是选目录而不是选文件：DSH 的 uiWorkspace 只提供 `pickDirectory()`
   * （没有选单个文件的接口）。所以流程是"选目录 → 列该目录下的 .dshd.json"。
   *
   * uiWorkspace 用 ctx.get 取（可选依赖）：拿不到就退回列工作区，不让功能失效。
   */
  async function pickDirectoryAndList() {
    const ws = client === null || typeof client.get !== 'function' ? undefined : client.get('uiWorkspace')
    if (ws === undefined || ws === null || typeof ws.pickDirectory !== 'function') {
      setFileList({ files: null, error: '当前环境没有可用的文件管理器，已列出工作区目录' })
      fetchFileList(lastPickedDirRef.current)
      return
    }
    setFileList({ files: null, error: '' })
    let picked = null
    try {
      picked = await ws.pickDirectory()
    } catch (error) {
      setFileList({ files: null, error: '打开文件管理器失败：' + (error && error.message ? error.message : String(error)) })
      return
    }
    if (picked === null || typeof picked !== 'string' || picked.length === 0) {
      // 用户取消了：保留原列表，别把面板清空得像"出错了"。
      fetchFileList(lastPickedDirRef.current)
      return
    }
    lastPickedDirRef.current = picked
    fetchFileList(picked)
  }

  /**
   * 切到另一个文件。先把手上没落盘的改动写完，再切换 ——
   * 否则"打开另一个文件"会静默丢掉当前画布的编辑。
   */
  /**
   * 「打开」某个文件。
   *
   * **走 onOpenTab 而不是 onRebind**：打开一个文件应该是"多出一个它的标签页并切过去"，
   * 而不是把当前标签改名替换掉 —— 后者会让用户丢掉正在编辑的那张画布的位置。
   * 外层 openTabIn 会去重：该文件已经开着就直接切过去，不会开出第二个标签。
   *
   * 因为当前标签只是"被留在后面"（没被替换、没被关掉），这里有未落盘的改动**也不必先保存**，
   * 更不用弹警告 —— 它的内容仍留在自己那个标签里。
   */
  async function switchTo(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) return
    setDocMenu(null)
    setFileList(null)
    onOpenTab(relPath)
  }


  /**
   * 另存为（也是未命名画布的第一次保存）：写入给定文件名，并把画布**改为绑定**到它。
   *
   * 复用保存通道的同一套宿主校验（只收单个文件名、只落工作区根目录），
   * 所以这里只做两件事：把当前 doc 写过去、把 target 换过去。
   */
  async function saveAs(name) {
    const trimmed = String(name === undefined || name === null ? '' : name).trim()
    if (trimmed.length === 0) {
      setFileList({ files: null, error: '请填一个文件名' })
      return
    }
    if (/[\\/]/.test(trimmed)) {
      setFileList({ files: null, error: '文件名不能包含路径分隔符' })
      return
    }
    const withExt = trimmed.toLowerCase().endsWith('.dshd.json') ? trimmed : trimmed + '.dshd.json'
    const snapshot = docRef.current
    if (client === null || snapshot === null) return
    setSaveNote('另存为 ' + withExt + ' …')
    let raw = null
    try {
      raw = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        // revision 传 0：另存为的目标**不该已存在**。若已存在，宿主的乐观锁返回 409，
        // 于是不会被静默覆盖 —— 想改那个文件请用「打开」进去。
        body: JSON.stringify({ sessionId: sessionId, path: withExt, revision: 0, doc: snapshot }),
      })
    } catch (error) {
      setFileList({ files: null, error: '保存请求失败：' + (error && error.message ? error.message : String(error)) })
      return
    }
    let payload = null
    try {
      payload = await raw.json()
    } catch (error) {
      setFileList({ files: null, error: '返回不是 JSON（HTTP ' + raw.status + '）' })
      return
    }
    if (payload === null || payload.ok !== true) {
      const message = String(payload !== null && payload.error ? payload.error : 'HTTP ' + raw.status)
      setFileList({ files: null, error: message === 'revision conflict' ? '已存在同名文件：用「打开」进去改，或换个名字' : message })
      return
    }
    revisionRef.current = payload.revision
    dirtyRef.current = false
    onRebind(withExt)
    setDocMenu(null)
    setNewName('')
    setFileList(null)
    setSaveNote('已另存为 ' + withExt + '（revision ' + payload.revision + '）')
  }

  /**
   * 上报"用户现在正在看哪张画布"给宿主。
   *
   * 目的：让 AI 不传 path 时改的是屏幕上这张，而不是工作区里的 demo.dshd.json。
   * 只有**活动标签**才上报（隐藏标签不该抢焦点）；未绑定文件则上报空串清掉聚焦。
   * 失败不打扰用户 —— 这是尽力而为的优化，没有它 AI 仍可用显式 path 工作。
   */
  async function reportFocus() {
    if (client === null || !active) return
    if (focusReportedRef.current === target) return
    focusReportedRef.current = target
    try {
      await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        body: JSON.stringify({ action: 'focus', sessionId: sessionId, path: hasPath ? target : '' }),
      })
    } catch (error) {
      // 不打扰用户：下次 target 变化时会再试
    }
  }

  async function saveNow() {
    if (client === null || dirtyRef.current !== true) return
    // 未命名画布还没有落盘位置：自动保存**不能**替用户挑一个文件名（那就是原来"悄悄写 demo"的老毛病）。
    // 改为提示去命名；用户点了「保存」再由调用方打开命名面板。
    if (!hasPath) {
      setSaveNote('未命名画布：请先「另存为」给它一个文件名')
      return
    }
    const snapshot = docRef.current
    if (snapshot === null) return
    const baseRevision = revisionRef.current
    dirtyRef.current = false
    setSaveNote('保存中…')
    let response = null
    try {
      const raw = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        body: JSON.stringify({ sessionId: sessionId, path: target, revision: baseRevision, doc: snapshot }),
      })
      response = await raw.json()
    } catch (error) {
      dirtyRef.current = true
      setSaveNote('保存失败：' + (error && error.message ? error.message : String(error)))
      return
    }
    if (response === null || response.ok !== true) {
      const message = String(response !== null && response.error ? response.error : 'unknown')
      if (message === 'revision conflict') {
        // 别人改了这份文档：不重试、不覆盖，接受服务端版本（下一次轮询就会拉回来）。
        setSaveNote('保存被拒：文档已被他处修改，稍后会重新载入')
        return
      }
      dirtyRef.current = true
      setSaveNote('保存被拒：' + message)
      return
    }
    revisionRef.current = response.revision
    setSaveNote('已保存 revision ' + response.revision)
  }

  function snap(value) {
    return Math.round(value / GRID) * GRID
  }

  /** 屏幕坐标 → SVG 用户坐标。用 CTM 逆矩阵，比自己算缩放平移可靠。 */
  function toUserSpace(event) {
    const svg = svgRef.current
    if (svg === null) return null
    try {
      const ctm = svg.getScreenCTM()
      if (ctm === null) return null
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null
    } catch (error) {
      return null
    }
  }

  function onNodePointerDown(id, event) {
    if (event.button !== 0) return
    setMenu(null)
    event.preventDefault()
    event.stopPropagation()
    if (editing !== null && editing.id !== id) setEditing(null)

    // Shift 加选/减选；否则若点的不在选区里就改成只选它，在选区里则保留整组（准备整体拖动）。
    const additive = event.shiftKey === true
    let ids = selectedIds
    if (additive) {
      ids = ids.indexOf(id) >= 0 ? ids.filter((x) => x !== id) : ids.concat([id])
    } else if (ids.indexOf(id) < 0) {
      ids = [id]
    }
    setSelectedIds(ids)

    const current = docRef.current
    const point = toUserSpace(event)
    if (current === null || point === null) return
    // 被 Shift 减掉的节点不再参与拖动。
    const starts = []
    for (let i = 0; i < current.nodes.length; i += 1) {
      const n = current.nodes[i]
      if (ids.indexOf(n.id) < 0) continue
      starts.push({ id: n.id, x: numberOr(n.x, 0), y: numberOr(n.y, 0) })
    }
    if (starts.length === 0) return
    dragRef.current = { originX: point.x, originY: point.y, starts: starts }
    const element = event.currentTarget
    if (element !== null && element !== undefined && typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId)
      } catch (error) {
        // 捕获失败不影响拖动本身，pointermove 仍会冒泡到画布
      }
    }
  }

  function onNodePointerUp(id) {
    const linking = linkRef.current
    if (linking === null) return
    // 拖拽过程中每一帧算出的预览里，已经记着"这一帧选中了目标哪一边"；
    // 松手就用它落盘 —— 屏幕上刚高亮的那个端点，就是这条边真正接上的那个。
    // （不要在这里重新算一次：重算的输入是指针位置，可能和最后一帧渲染用的不是同一个点。）
    const preview = connectPreviewRef.current
    const chosenTo = preview !== null && preview !== undefined && preview.sides !== undefined && typeof preview.sides.to === 'string' ? preview.sides.to : null
    clearConnect()
    if (linking.from === id) return
    // 这里曾经有一条"同向边已存在就直接 return"的守卫 —— 它会**无声**吞掉整个手势：
    // 实测过（demo 里已有 n1→canvas 时，从 n1 往 canvas 拖永远没反应）。
    // drawio 允许同一条两端之间有多条边（各自带自己的连接点与画法），所以这里不再拦。
    // 自环仍然拦住（见上一行）：本画布不支持自环。
    // 用户选中的两个端点写进 style 的 exitX/exitY 与 entryX/entryY（drawio 的固定连接点）。
    // v1 是把桩点塞进 edge.points —— 那等于把"接在哪一侧"伪装成一个折点，
    // 端点一动它就成了过期坐标（宿主重排时只能清掉，约束也就丢了）。
    let style = DEFAULT_EDGE_STYLE
    if (typeof linking.side === 'string' && linking.side.length > 0) style = styleWithSide(style, 'source', linking.side)
    if (typeof chosenTo === 'string' && chosenTo.length > 0) style = styleWithSide(style, 'target', chosenTo)

    applyLocal((next) => {
      let max = 0
      const re = /^e(\d+)$/
      for (let i = 0; i < next.edges.length; i += 1) {
        const m = re.exec(String(next.edges[i].id))
        if (m !== null) {
          const n = parseInt(m[1], 10)
          if (n > max) max = n
        }
      }
      next.edges.push({ id: 'e' + (max + 1), from: linking.from, to: id, style: style })
    })
  }

  /** 打开节点的就地编辑框。双击与右键菜单共用同一套定位。 */
  function openNodeEditor(id) {
    const node = nodeById(id)
    const svg = svgRef.current
    const canvas = canvasRef.current
    if (node === null || svg === null || canvas === null) return
    const ctm = svg.getScreenCTM()
    if (ctm === null) return
    // CTM 只有缩放与平移（没有旋转），屏幕位置 = 用户坐标 × scale + 平移。
    const rect = canvas.getBoundingClientRect()
    const scale = ctm.a
    setSelectedIds([id])
    setMenu(null)
    setEditing({
      kind: 'node',
      id: id,
      text: typeof node.label === 'string' ? node.label : '',
      left: numberOr(node.x, 0) * scale + ctm.e - rect.left,
      top: numberOr(node.y, 0) * scale + ctm.f - rect.top,
      width: numberOr(node.w, 170) * scale,
      height: numberOr(node.h, 56) * scale,
    })
  }

  function onNodeDoubleClick(id, event) {
    event.preventDefault()
    event.stopPropagation()
    openNodeEditor(id)
  }

  /** side ∈ n/e/s/w：从这一侧引出的线，落点会固定在这一边。 */
  function onHandlePointerDown(id, side, event) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const current = docRef.current
    const node = current === null ? null : nodeById(id)
    if (current === null || node === null) return
    // 引出侧是**手势真值**，记在 ref 里而不是只记在 state 里：
    // 指针回调都是渲染期创建的闭包，读 state 会拿到上一帧的值；而预览路由和松手落线
    // 必须用同一份边（否则预览从 E 边引出、落盘却按 S 边）。
    const seed = { from: id, side: typeof side === 'string' ? side : 'e' }
    linkRef.current = seed
    setConnectFrom(id)
    setConnectSide(seed.side)
    setConnectHover(null)
    setConnectPreview(null)
    // 按下即出预览：不等第一次 pointermove，用户一握上手柄就能看到吸附环与折线。
    setConnectCursor(event.clientX, event.clientY)
  }

  /**
   * 拖线过程中的每一帧：算吸附目标 + 用真实路由算预览折线。
   * 两者必须一起更新 —— 吸附目标就是路由的目标，分开算会出现"环亮了但线还指着空白处"。
   */
  function setConnectCursor(clientX, clientY) {
    const current = docRef.current
    const link = linkRef.current
    const svg = svgRef.current
    if (current === null || link === null || svg === null) return
    let point = null
    try {
      const ctm = svg.getScreenCTM()
      if (ctm !== null) {
        const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) point = { x: p.x, y: p.y }
      }
    } catch (error) {
      point = null
    }
    if (point === null) return
    const geometry = buildGeometry(current)
    const fromBox = geometry.byId[link.from]
    if (fromBox === undefined) return
    const route = routePreviewFor(current, geometry, point, link.from, fromBox.geo, link, HOT_PAD, link.from)
    setConnectTo(point)
    setConnectHover(route === null || route.hot === null ? null : route.hot.id)
    setConnectPreview(route)
    connectPreviewRef.current = route
  }

  /** 一次拖线结束：三份状态一起清，避免"环还亮着但已经没在连线"。 */
  function clearConnect() {
    linkRef.current = null
    setConnectFrom(null)
    setConnectTo(null)
    setConnectHover(null)
    setConnectPreview(null)
    connectPreviewRef.current = null
  }

  /**
   * 开始一次可能的平移。button 记在 ref 里：松手时只有**左键**的空拖才算"点击空白"
   * （中键平移不应该顺手把选中也清掉）。
   *
   * 位移一律在**屏幕像素**里算，缩放系数在按下时锁定。
   * 曾经用 getScreenCTM() 把每帧的屏幕坐标换算成用户坐标再求差 —— 那是错的：
   * 视口正在被这次拖动改写，坐标系跟着动，算出的位移又反馈回视口，形成自激振荡，
   * 表现就是画面剧烈抖动。
   */
  function startPan(event, button) {
    const current = viewRef.current
    if (current === null) return false
    const element = canvasRef.current
    const scale = element !== null && element.clientWidth > 0 ? element.clientWidth / current.w : 0
    if (!(scale > 0)) return false
    panRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      viewX: current.x,
      viewY: current.y,
      w: current.w,
      h: current.h,
      scale: scale,
      moved: false,
      button: button,
    }
    if (element !== null && typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId)
      } catch (error) {
        // 捕获失败不影响平移：指针仍在画布内时会继续派发 pointermove
      }
    }
    return true
  }

  /** 空白处左键按下 = 开始框选（没拖动就是一次点击 → 松手取消选中）。平移让给中键。 */
  function onBackgroundPointerDown(event) {
    if (event.button !== 0) return
    setMenu(null)
    // CSS 的 user-select:none 是治本，这里再拦一次默认行为兜底：
    // 有些浏览器仍会从 pointerdown 起启动选择拖拽。
    event.preventDefault()
    const point = toUserSpace(event)
    if (point === null) return
    marqueeRef.current = { x0: point.x, y0: point.y, x1: point.x, y1: point.y, additive: event.shiftKey === true, moved: false }
    setMarquee({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
    const element = canvasRef.current
    if (element !== null && typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId)
      } catch (error) {
        // 捕获失败不影响框选：指针在画布内时仍会派发 pointermove
      }
    }
  }

  /** 中键按下（在任何位置都生效，包括压在节点上）：拖动画布。 */
  function onCanvasPointerDown(event) {
    if (event.button !== 1) return
    event.preventDefault()
    startPan(event, 1)
  }

  function onCanvasPointerMove(event) {
    const pan = panRef.current
    if (pan !== null) {
      const dxPx = event.clientX - pan.startClientX
      const dyPx = event.clientY - pan.startClientY
      if (Math.abs(dxPx) > 1 || Math.abs(dyPx) > 1) pan.moved = true
      setViewOverride({ x: pan.viewX - dxPx / pan.scale, y: pan.viewY - dyPx / pan.scale, w: pan.w, h: pan.h })
      return
    }
    const drag = dragRef.current
    if (drag !== null) {
      const point = toUserSpace(event)
      if (point === null) return
      const dx = point.x - drag.originX
      const dy = point.y - drag.originY
      // 整组一起移动；同一次拖动只记一个撤销快照（coalesceKey 相同就不再压栈）。
      const key = 'drag:' + drag.starts.map((s) => s.id).join(',')
      applyLocal((next) => {
        for (let i = 0; i < next.nodes.length; i += 1) {
          const n = next.nodes[i]
          for (let k = 0; k < drag.starts.length; k += 1) {
            if (drag.starts[k].id !== n.id) continue
            n.x = snap(drag.starts[k].x + dx)
            n.y = snap(drag.starts[k].y + dy)
            break
          }
        }
      }, key)
      return
    }
    const resize = resizeRef.current
    if (resize !== null) {
      const point = toUserSpace(event)
      if (point === null) return
      const dx = snap(point.x - resize.originX)
      const dy = snap(point.y - resize.originY)
      const minW = 60
      const minH = 36
      let x = resize.x
      let y = resize.y
      let w = resize.w
      let h = resize.h
      if (resize.dir.indexOf('e') >= 0) w = Math.max(minW, resize.w + dx)
      if (resize.dir.indexOf('s') >= 0) h = Math.max(minH, resize.h + dy)
      if (resize.dir.indexOf('w') >= 0) {
        w = Math.max(minW, resize.w - dx)
        x = resize.x + (resize.w - w)
      }
      if (resize.dir.indexOf('n') >= 0) {
        h = Math.max(minH, resize.h - dy)
        y = resize.y + (resize.h - h)
      }
      applyLocal((next) => {
        for (let i = 0; i < next.nodes.length; i += 1) {
          if (next.nodes[i].id !== resize.id) continue
          next.nodes[i].x = x
          next.nodes[i].y = y
          next.nodes[i].w = w
          next.nodes[i].h = h
          break
        }
      }, 'resize:' + resize.id + ':' + resize.dir)
      return
    }
    const marqueeDrag = marqueeRef.current
    if (marqueeDrag !== null) {
      const point = toUserSpace(event)
      if (point === null) return
      if (Math.abs(point.x - marqueeDrag.x0) > 2 || Math.abs(point.y - marqueeDrag.y0) > 2) marqueeDrag.moved = true
      marqueeDrag.x1 = point.x
      marqueeDrag.y1 = point.y
      setMarquee({ x0: marqueeDrag.x0, y0: marqueeDrag.y0, x1: point.x, y1: point.y })
      return
    }
    if (linkRef.current !== null) {
      // 预览要跟着指针走：这里不能只更新 connectTo —— 吸附目标与路由折线都要同一帧算出来。
      setConnectCursor(event.clientX, event.clientY)
      return
    }
    const edgeDrag = edgeDragRef.current
    if (edgeDrag !== null) {
      const current = docRef.current
      if (current === null) return
      const point = toUserSpace(event)
      if (point === null) return
      if (edgeDrag.kind === 'segment') {
        // 整段平移：两个端点折点一起动，位移只在**垂直于该段**的方向上生效。
        // 用按下时存的 base 做绝对定位（而不是累加），避免逐帧误差滚雪球。
        const moveX = edgeDrag.horizontal ? 0 : snap(point.x - edgeDrag.originX)
        const moveY = edgeDrag.horizontal ? snap(point.y - edgeDrag.originY) : 0
        applyLocal((next) => {
          for (let i = 0; i < next.edges.length; i += 1) {
            const e = next.edges[i]
            if (e.id !== edgeDrag.edgeId) continue
            const points = edgeDrag.base.map((p) => ({ x: p.x, y: p.y }))
            if (edgeDrag.a < points.length) {
              points[edgeDrag.a].x += moveX
              points[edgeDrag.a].y += moveY
            }
            if (edgeDrag.b < points.length) {
              points[edgeDrag.b].x += moveX
              points[edgeDrag.b].y += moveY
            }
            e.points = points
            break
          }
        }, 'segment:' + edgeDrag.edgeId + ':' + edgeDrag.a + ':' + edgeDrag.b)
        return
      }
      // 改接端点：同样用真实路由算出预览折线，并吸附到指针附近的节点。
      // 落点判定仍然交给松手时的 elementFromPoint（那是最终裁决），这里只负责"看起来会接成什么样"。
      const dragged = edgeById(edgeDrag.edgeId)
      const geometry = buildGeometry(current)
      const routed =
        dragged === null
          ? null
          : edgePreviewRoute(current, geometry, dragged, edgeDrag.kind, point, HOT_PAD)
      const payload = Object.assign({ edgeId: edgeDrag.edgeId, kind: edgeDrag.kind, x: point.x, y: point.y }, routed)
      edgePreviewRef.current = routed
      setEdgePreview(payload)
      return
    }
  }

  function onCanvasPointerUp(event) {
    const pan = panRef.current
    if (pan !== null) {
      panRef.current = null
      // 中键平移不该顺手清掉选中。
      if (pan.moved !== true && pan.button === 0) setSelectedIds([])
    }
    // 先记下这一轮有哪些手势结束过 —— 它们都会改变几何，之后要清一次冗余折点。
    const geometryChanged = dragRef.current !== null || resizeRef.current !== null || edgeDragRef.current !== null
    dragRef.current = null
    resizeRef.current = null
    finishEdgeDrag(event)
    finishMarquee()
    // 手势结束必须清掉合并键：否则下一次拖同一个节点会命中同一个 key，
    // 不再压快照 —— 表现为"第二次拖动撤销不了"。
    lastCoalesceRef.current = null
    // 拖线松手落在吸附容差里时，节点组收不到 pointerup（事件挂在节点上）——用最后一帧预览
    // 高亮的那个节点兜底，否则"预览亮着、松手什么都没有"。压在节点上时节点组已经处理过，
    // 那时 linkRef 已被它清空，这里不会重复建边。
    if (linkRef.current !== null) {
      const fallback = dropTargetOf(null, connectPreviewRef.current)
      if (fallback !== null) onNodePointerUp(fallback)
      else clearConnect()
    }
    // 收尾清理：让"一条线段只有一个把手"这个不变量在每次手势后都重新成立。
    if (geometryChanged) pruneAllEdges()
  }

  /** 开始缩放一个节点。dir ∈ n/s/e/w/ne/nw/se/sw。 */
  function onResizePointerDown(id, dir, event) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    setMenu(null)
    const node = nodeById(id)
    const point = toUserSpace(event)
    if (node === null || point === null) return
    resizeRef.current = {
      id: id,
      dir: dir,
      originX: point.x,
      originY: point.y,
      x: numberOr(node.x, 0),
      y: numberOr(node.y, 0),
      w: numberOr(node.w, 130),
      h: numberOr(node.h, 56),
    }
    const element = canvasRef.current
    if (element !== null && typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId)
      } catch (error) {
        // 捕获失败不影响缩放
      }
    }
  }

  /** 导出前把实时 SVG 克隆一份、摘掉交互件 —— 手柄和选中框不该出现在产物里。 */
  function buildExportSvg() {
    const svg = svgRef.current
    const current = docRef.current
    if (svg === null || current === null) return null
    const clone = svg.cloneNode(true)
    const junk = clone.querySelectorAll('.drawai-handle, .drawai-sel, .drawai-edge-hit')
    for (let i = 0; i < junk.length; i += 1) {
      if (junk[i].parentNode !== null) junk[i].parentNode.removeChild(junk[i])
    }
    const bounds = contentBounds(current)
    const pad = 24
    const w = Math.max(1, bounds.maxX - bounds.minX + pad * 2)
    const h = Math.max(1, bounds.maxY - bounds.minY + pad * 2)
    clone.setAttribute('viewBox', [bounds.minX - pad, bounds.minY - pad, w, h].join(' '))
    clone.setAttribute('width', String(Math.round(w)))
    clone.setAttribute('height', String(Math.round(h)))
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.removeAttribute('style')
    // 网格纸在实时视图里只铺满"当前视口"；导出要铺满整图，否则缩放状态下网格会断掉。
    const grid = clone.querySelector('rect[fill^="url(#drawai-grid-major"]')
    if (grid !== null) {
      grid.setAttribute('x', String(bounds.minX - pad))
      grid.setAttribute('y', String(bounds.minY - pad))
      grid.setAttribute('width', String(w))
      grid.setAttribute('height', String(h))
    }
    // 网格图案是半透明的：不加一层底色的话，PNG 出来是透明背景。
    const paper = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    paper.setAttribute('x', String(bounds.minX - pad))
    paper.setAttribute('y', String(bounds.minY - pad))
    paper.setAttribute('width', String(w))
    paper.setAttribute('height', String(h))
    paper.setAttribute('fill', mode === 'dark' ? '#1b1b1b' : '#ffffff')
    clone.insertBefore(paper, clone.firstChild)
    return { node: clone, width: w, height: h }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  function downloadPng(node, width, height, filename) {
    const markup = new XMLSerializer().serializeToString(node)
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
    const image = new Image()
    image.onload = () => {
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const context = canvas.getContext('2d')
      if (context === null) {
        URL.revokeObjectURL(url)
        return
      }
      context.fillStyle = mode === 'dark' ? '#1b1b1b' : '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      canvas.toBlob((blob) => {
        if (blob !== null) downloadBlob(blob, filename)
      }, 'image/png')
    }
    image.onerror = () => URL.revokeObjectURL(url)
    image.src = url
  }

  /** 收尾框选：没拖动过就是一次"点空白"（取消选中），否则按矩形相交挑节点。 */  function finishMarquee() {
    const drag = marqueeRef.current
    if (drag === null) return
    marqueeRef.current = null
    setMarquee(null)
    if (drag.moved !== true) {
      if (drag.additive !== true) setSelectedIds([])
      return
    }
    const current = docRef.current
    if (current === null) return
    const minX = Math.min(drag.x0, drag.x1)
    const maxX = Math.max(drag.x0, drag.x1)
    const minY = Math.min(drag.y0, drag.y1)
    const maxY = Math.max(drag.y0, drag.y1)
    const hits = []
    for (let i = 0; i < current.nodes.length; i += 1) {
      const n = current.nodes[i]
      const x = numberOr(n.x, 0)
      const y = numberOr(n.y, 0)
      const w = numberOr(n.w, 150)
      const h = numberOr(n.h, 56)
      const overlaps = x < maxX && x + w > minX && y < maxY && y + h > minY
      if (overlaps) hits.push(n.id)
    }
    if (drag.additive === true) {
      const merged = selectedIds.slice()
      for (let i = 0; i < hits.length; i += 1) if (merged.indexOf(hits[i]) < 0) merged.push(hits[i])
      setSelectedIds(merged)
      return
    }
    setSelectedIds(hits)
  }

  // ---- 右键菜单 / 元素库 ---------------------------------------------------
  function openMenu(kind, id, event, withPoint, extra) {
    event.preventDefault()
    event.stopPropagation()
    const canvas = canvasRef.current
    if (canvas === null) return
    const rect = canvas.getBoundingClientRect()
    const point = withPoint === true ? toUserSpace(event) : null
    const base = {
      kind: kind,
      id: id,
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
      userX: point === null ? 0 : point.x,
      userY: point === null ? 0 : point.y,
    }
    setMenu(extra === undefined ? base : Object.assign(base, extra))
  }

  function onCanvasContextMenu(event) {
    setSelectedIds([])
    openMenu('canvas', null, event, true)
  }

  function onNodeContextMenu(id, event) {
    // 右键的节点**已经在选区里**且选区不止一个 → 用户想收拾的是这一整批（对齐/分布），
    // 而不是要把选区缩成这一个。选单个时保持原行为（形状/配色/改标签/删除）。
    if (selectedIds.length > 1 && selectedIds.indexOf(id) >= 0) {
      openMenu('multi', id, event, false)
      return
    }
    setSelectedIds([id])
    openMenu('node', id, event, false)
  }

  function onEdgeContextMenu(id, event) {
    setSelectedIds([id])
    openMenu('edge', id, event, false)
  }

  function nextNodeId(doc) {
    let max = 0
    const re = /^n(\d+)$/
    for (let i = 0; i < doc.nodes.length; i += 1) {
      const m = re.exec(String(doc.nodes[i].id))
      if (m !== null) {
        const n = parseInt(m[1], 10)
        if (n > max) max = n
      }
    }
    return 'n' + (max + 1)
  }

  function createNodeAt(shape, styleName, userX, userY) {
    const current = docRef.current
    if (current === null) return
    const id = nextNodeId(current)
    // 形状与配色都落成 drawio 的 style 键：rect/plain 落成空串（= drawio 的 defaultVertexStyle）。
    const style = styleWithColorName(styleWithNodeShape('', shape), styleName)
    applyLocal((next) => {
      next.nodes.push({ id: id, label: '新节点', style: style, x: snap(userX - 65), y: snap(userY - 28), w: 130, h: 56 })
    })
    setSelectedIds([id])
    setMenu(null)
  }

  /**
   * 批量对齐 / 分布。算法在 computeAlignMoves（纯函数，可被命令行自测直接断言），
   * 这里只负责取选区、落盘一次、记一格撤销历史。
   */
  function alignSelection(kind) {
    const current = docRef.current
    if (current === null) return
    const moves = computeAlignMoves(current, selectedIds, kind, GRID)
    if (Object.keys(moves).length === 0) return
    applyLocal((next) => {
      for (let i = 0; i < next.nodes.length; i += 1) {
        const move = moves[next.nodes[i].id]
        if (move === undefined) continue
        if (move.axis === 'x') next.nodes[i].x = move.value
        else next.nodes[i].y = move.value
      }
    })
  }


  function updateNode(id, patch) {
    // 故意不关菜单：改形状/换配色是可以连点几次试的，弹一次关一次很难用。
    applyLocal((next) => {
      for (let i = 0; i < next.nodes.length; i += 1) {
        if (next.nodes[i].id !== id) continue
        const keys = Object.keys(patch)
        for (let k = 0; k < keys.length; k += 1) next.nodes[i][keys[k]] = patch[keys[k]]
        break
      }
    })
  }

  /**
   * 改连线的画法：全部落成 style 键（dashed/dashPattern/endArrow/startArrow/strokeColor）。
   * 回到默认 = **删键**，不写 `dashed=0` 之类的冗余 —— 与宿主 edgeStyleFromOp 同一套语义。
   */
  function updateEdge(id, patch) {
    applyLocal((next) => {
      for (let i = 0; i < next.edges.length; i += 1) {
        const e = next.edges[i]
        if (e.id !== id) continue
        let style = typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE
        if (has(patch, 'dash')) style = styleWithDash(style, patch.dash)
        if (has(patch, 'arrow')) style = styleWithArrow(style, patch.arrow)
        if (has(patch, 'color')) {
          style = stylePatch(style, { strokeColor: typeof patch.color === 'string' && patch.color.length > 0 ? patch.color : null })
        }
        e.style = style
        break
      }
    })
  }

  /** 清掉一条连线的全部折点**与进出侧约束**，回到自动路由（= drawio 的「自动路由」）。 */
  function clearEdgeWaypoints(id) {
    applyLocal((next) => {
      for (let i = 0; i < next.edges.length; i += 1) {
        const e = next.edges[i]
        if (e.id !== id) continue
        delete e.points
        delete e.sourcePoint
        delete e.targetPoint
        let style = typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE
        style = styleWithSide(style, 'source', null)
        style = styleWithSide(style, 'target', null)
        e.style = style
        break
      }
    })
    setMenu(null)
  }

  /**
   * 清理所有连线上的共线冗余折点。
   *
   * 不只线段拖动会产生冗余 —— **移动/缩放节点也会**：形状边框落点变了，
   * 原本必要的折点可能就和邻点共线了，于是那条边凭空多出一个段把手。
   * 所以任何改变几何的手势结束后都跑一次。
   *
   * 用 commitDoc 而不是 applyLocal：这一步**不改变画面**（只是把等价表示换成更短的），
   * 不该占一格撤销历史。
   */
  function pruneAllEdges() {
    const current = docRef.current
    if (current === null) return
    let changed = false
    const edges = current.edges.map((edge) => {
      if (!Array.isArray(edge.points) || edge.points.length === 0) return edge
      const pruned = prunePoints(current, edge)
      if (pruned === null || pruned.length === edge.points.length) return edge
      changed = true
      const copy = Object.assign({}, edge)
      if (pruned.length === 0) delete copy.points
      else copy.points = pruned
      return copy
    })
    if (!changed) return
    commitDoc({ revision: current.revision, nodes: current.nodes.map((n) => Object.assign({}, n)), edges: edges })
  }

  function deleteById(id) {
    setEditing(null)
    setSelectedIds([])
    setMenu(null)
    applyLocal((next) => {
      next.nodes = next.nodes.filter((n) => n.id !== id)
      next.edges = next.edges.filter((e) => e.id !== id && e.from !== id && e.to !== id)
    })
  }

  // ---- 连线的自由修改 ------------------------------------------------------
  function edgeById(id) {
    const current = docRef.current
    if (current === null) return null
    for (let i = 0; i < current.edges.length; i += 1) if (current.edges[i].id === id) return current.edges[i]
    return null
  }

  function onEdgeHandlePointerDown(edgeId, kind, index, event) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const current = docRef.current
    if (current === null) return
    const edge = edgeById(edgeId)
    if (edge === null) return
    setSelectedIds([edgeId])
    setMenu(null)

    if (kind === 'from' || kind === 'to') {
      edgeDragRef.current = { edgeId: edgeId, kind: kind, index: -1 }
      const canvas = canvasRef.current
      if (canvas !== null && typeof canvas.setPointerCapture === 'function') {
        try {
          canvas.setPointerCapture(event.pointerId)
        } catch (error) {
          // 捕获失败不影响：指针在画布内时仍会派发 pointermove
        }
      }
      return
    }

    const points = Array.isArray(edge.points) ? edge.points.slice() : []
    if (kind === 'segment') {
      // 拖动某一段 = **整段平移**（draw.io 的段把手语义），而不是插入一个自由折点。
      //
      // 做法：先把这一段的两个端点就地钉成折点（在原位补折点不改变路径，所以这一刻画面不动），
      // 之后同时平移这两个折点，这一段就整体挪走了。
      //
      // 端点落在起点/终点一侧时同样成立：那个顶点被钉住之后，形状的落点会朝它重新计算，
      // 于是自动多出一小段连接 —— 也就是"相当于新建一条线段"。
      const pts = edgeRoutePoints(current, edge)
      if (pts === null || index < 0 || index >= pts.length - 1) return
      const a = pts[index]
      const b = pts[index + 1]
      const pinA = ensurePinned(pts, points, index)
      const pinB = ensurePinned(pts, points, index + 1)
      if (pinA < 0 || pinB < 0 || pinA === pinB) return
      const saved = points.map((p) => ({ x: p.x, y: p.y }))
      applyLocal((next) => {
        for (let i = 0; i < next.edges.length; i += 1) {
          if (next.edges[i].id !== edgeId) continue
          next.edges[i].points = saved.map((p) => ({ x: p.x, y: p.y }))
          break
        }
      })
      const origin = toUserSpace(event)
      if (origin === null) return
      edgeDragRef.current = {
        edgeId: edgeId,
        kind: 'segment',
        a: pinA,
        b: pinB,
        horizontal: Math.abs(a.y - b.y) < 0.5,
        base: saved,
        originX: origin.x,
        originY: origin.y,
      }
      const canvas = canvasRef.current
      if (canvas !== null && typeof canvas.setPointerCapture === 'function') {
        try {
          canvas.setPointerCapture(event.pointerId)
        } catch (error) {
          // 捕获失败不影响拖动
        }
      }
      return
    }
    // 只剩下 from/to/segment 三种；走到这里说明参数不对，不启动拖拽。
  }

  /** 用 document.elementFromPoint 做命中测试 —— 让浏览器告诉我们指针下是哪个节点。 */
  function nodeIdAtPoint(clientX, clientY) {
    let element = null
    try {
      element = document.elementFromPoint(clientX, clientY)
    } catch (error) {
      element = null
    }
    if (element === null || element === undefined || typeof element.closest !== 'function') return null
    const group = element.closest('[data-node-id]')
    return group === null ? null : group.getAttribute('data-node-id')
  }

  function finishEdgeDrag(event) {
    const drag = edgeDragRef.current
    if (drag === null) return
    edgeDragRef.current = null
    setEdgePreview(null)
    if (drag.kind === 'segment') {
      // 冗余折点的回收统一交给 onCanvasPointerUp 里的 pruneAllEdges()，
      // 这里不再单独处理 —— 否则"节点拖动后变共线"那条路径会被漏掉。
      return
    }
    if (event === null || event === undefined) return
    // 改接端点同理：落在容差里也算连上（预览已经把目标高亮了）。
    const targetId = dropTargetOf(nodeIdAtPoint(event.clientX, event.clientY), edgePreviewRef.current)
    if (targetId === null) return
    const current = docRef.current
    if (current === null) return
    const movedNode = nodeById(targetId)
    const dragged = edgeById(drag.edgeId)
    if (movedNode === null || dragged === null) return
    const fixedNode = nodeById(drag.kind === 'from' ? dragged.to : dragged.from)
    if (fixedNode === null) return
    const fixedBox = { id: fixedNode.id, geo: nodeGeoOf(fixedNode) }
    const fixedEnd = drag.kind === 'from' ? 'target' : 'source'
    // 固定端保持文档里既有的约束（没有约束就继续不钉）—— 与预览用同一个读法。
    const fixedSide = pinnedSideOf(dragged, fixedEnd)
    // 被拖那一端选中的端点：就是最后一帧预览记下来的那个。
    const preview = edgePreviewRef.current
    const movedSide = preview === null || preview === undefined || typeof preview.side !== 'string' ? null : preview.side

    applyLocal((next) => {
      for (let i = 0; i < next.edges.length; i += 1) {
        const e = next.edges[i]
        if (e.id !== drag.edgeId) continue
        if (drag.kind === 'from') e.from = targetId
        else e.to = targetId
        // 两端约束写回 style；用户原有折点原样保留（它们是折点，不是端点表示）。
        let style = typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE
        style = styleWithSide(style, 'source', drag.kind === 'from' ? movedSide : fixedSide)
        style = styleWithSide(style, 'target', drag.kind === 'from' ? fixedSide : movedSide)
        e.style = style
        break
      }
    })
  }

  /** 打开连线的就地标签编辑框。双击与右键菜单共用。 */
  function openEdgeEditor(edgeId) {
    const current = docRef.current
    const svg = svgRef.current
    const canvas = canvasRef.current
    if (current === null || svg === null || canvas === null) return
    const edge = edgeById(edgeId)
    if (edge === null) return
    const pts = edgeRoutePoints(current, edge)
    const label = pts === null ? null : edgeLabelPosition(pts)
    if (label === null) return
    const ctm = svg.getScreenCTM()
    if (ctm === null) return
    const rect = canvas.getBoundingClientRect()
    const scale = ctm.a
    setSelectedIds([edgeId])
    setMenu(null)
    setEditing({
      kind: 'edge',
      id: edgeId,
      text: typeof edge.label === 'string' ? edge.label : '',
      left: label.x * scale + ctm.e - rect.left - 60,
      top: label.y * scale + ctm.f - rect.top - 12,
      width: 120,
      height: 24,
    })
  }

  /**
   * 就地编辑框跟着视图走。
   *
   * 实测过的毛病：双击节点开始改字，然后拖动画布 —— 节点跟着画布走了，输入框**原地不动**，
   * 看上去就是"文字和节点分家了"。根因是 left/top 只在打开那一刻用当时的 CTM 算了一次。
   * 这里每次渲染后按当前 CTM 重算（值没变就不 setState，避免自激循环），
   * 于是平移、缩放、拖节点、AI 改坐标，输入框都跟着走。
   */
  React.useEffect(() => {
    if (editing === null) return
    const svg = svgRef.current
    const canvas = canvasRef.current
    const current = docRef.current
    if (svg === null || canvas === null || current === null) return
    const ctm = svg.getScreenCTM()
    if (ctm === null) return
    const rect = canvas.getBoundingClientRect()
    const scale = ctm.a
    let next = null
    if (editing.kind === 'node') {
      const node = nodeById(editing.id)
      if (node === null) {
        setEditing(null)
        return
      }
      next = {
        left: numberOr(node.x, 0) * scale + ctm.e - rect.left,
        top: numberOr(node.y, 0) * scale + ctm.f - rect.top,
        width: numberOr(node.w, 170) * scale,
        height: numberOr(node.h, 56) * scale,
      }
    } else {
      const edge = edgeById(editing.id)
      if (edge === null) {
        setEditing(null)
        return
      }
      const pts = edgeRoutePoints(current, edge)
      const label = pts === null ? null : edgeLabelPosition(pts)
      if (label === null) return
      next = { left: label.x * scale + ctm.e - rect.left - 60, top: label.y * scale + ctm.f - rect.top - 12, width: 120, height: 24 }
    }
    const moved =
      Math.abs(next.left - editing.left) > 0.5 ||
      Math.abs(next.top - editing.top) > 0.5 ||
      Math.abs(next.width - editing.width) > 0.5 ||
      Math.abs(next.height - editing.height) > 0.5
    if (moved) setEditing(Object.assign({}, editing, next))
  })

  function onEdgeDoubleClick(edgeId, event) {
    event.preventDefault()
    event.stopPropagation()
    openEdgeEditor(edgeId)
  }

  function commitEdit() {
    const current = editing
    if (current === null) return
    const label = String(current.text)
    setEditing(null)
    if (current.kind === 'edge') {
      applyLocal((next) => {
        for (let i = 0; i < next.edges.length; i += 1) {
          if (next.edges[i].id !== current.id) continue
          next.edges[i].label = label
          break
        }
      })
      return
    }
    applyLocal((next) => {
      for (let i = 0; i < next.nodes.length; i += 1) {
        if (next.nodes[i].id !== current.id) continue
        next.nodes[i].label = label
        break
      }
    })
  }

  function deleteSelected() {
    const ids = selectedIds
    if (ids.length === 0) return
    setEditing(null)
    setSelectedIds([])
    setMenu(null)
    applyLocal((next) => {
      next.nodes = next.nodes.filter((n) => ids.indexOf(n.id) < 0)
      next.edges = next.edges.filter((e) => ids.indexOf(e.id) < 0 && ids.indexOf(e.from) < 0 && ids.indexOf(e.to) < 0)
    })
  }

  React.useEffect(() => {
    function onKey(event) {
      const tag = event.target !== null && event.target !== undefined && event.target.tagName ? String(event.target.tagName).toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea') return
      const accel = event.ctrlKey === true || event.metaKey === true
      if (accel && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault()
        if (event.shiftKey === true) redo()
        else undo()
        return
      }
      if (accel && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault()
        redo()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
      } else if (event.key === 'Escape') {
        setSelectedIds([])
        setEditing(null)
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, editing, menu])

  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        saveTimerRef.current()
        saveTimerRef.current = null
      }
    }
  }, [])

  // 画布 div 只在读取成功后才存在。这两个 effect 必须跟着它重新挂 ——
  // 依赖写死 [] 的话，首帧 doc === null、ref 还是 null，effect 直接 return 就再也不跑了：
  // 滚轮监听挂不上（滚轮没反应）、ResizeObserver 挂不上（size 恒为 0，视口算错）。
  const canvasReady = status.kind !== 'error' && doc !== null

  // 量容器尺寸：视口宽高比必须与容器一致，否则 SVG 会 letterbox（留黑边 + 指针坐标偏）。
  React.useEffect(() => {
    if (!canvasReady) return undefined
    const element = canvasRef.current
    if (element === null) return undefined
    function measure() {
      setSize({ w: element.clientWidth, h: element.clientHeight })
    }
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [canvasReady])

  // 滚轮：直接缩放，以指针为锚点（指针下的那个点在缩放前后保持不动 —— 这是手感的关键）。
  // 必须用原生监听并显式 passive:false —— React 在根容器上挂的 wheel 是被动的，
  // 在那里 preventDefault() 不生效，页面会跟着一起滚。
  React.useEffect(() => {
    if (!canvasReady) return undefined
    const element = canvasRef.current
    if (element === null) return undefined
    function onWheel(event) {
      const current = viewRef.current
      if (current === null) return
      event.preventDefault()
      const point = toUserSpace(event)
      if (point === null) return
      const factor = Math.exp(clampNumber(event.deltaY, -240, 240) * 0.002)
      // 锚点缩放的数学在 zoomViewAt 里（纯函数，可断言）：锚点前后必须停在同一位置。
      setViewOverride(zoomViewAt(current, point, factor))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [canvasReady])

  // 导出。刻意放在 effect 里跑：按钮先清掉选中，等这一帧渲染完（DOM 里没有手柄和选中框了）
  // 再序列化，产物才干净。若在点击回调里直接导，会把手柄一起拍进去。
  React.useEffect(() => {
    if (exportRequest === null) return
    const request = exportRequest
    setExportRequest(null)
    const built = buildExportSvg()
    if (built === null) return
    // 导出文件名：绑定文件就用它的名字；未命名/未绑定就给 'diagram'，别去借 demo 的名字。
    const source = typeof status.path === 'string' && status.path.length > 0 && status.path[0] !== '(' ? status.path : 'diagram'
    const name = String(source).split(/[\\/]/).pop().replace(/\.dshd\.json$/i, '')
    if (request === 'svg') {
      const markup = new XMLSerializer().serializeToString(built.node)
      downloadBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), name + '.svg')
      return
    }
    downloadPng(built.node, built.width, built.height, name + '.png')
  }, [exportRequest])

  React.useEffect(() => {
    if (client === null) {
      setStatus({ kind: 'error', path: target, error: '客户端根 ctx 尚未绑定（apply 还没跑）', absolute: '' })
      return undefined
    }

    // 告诉宿主"用户在看哪张画布" —— AI 不传 path 时就改它。
    // 放在这里而不是渲染期：渲染期发网络请求会在每次重渲染都打一次。
    reportFocus()

    // 没有绑定文件（未命名画布 / tab 地址认不出路径）→ **本地空文档，不读也不建任何文件**。
    // 这里曾经兜底成 demo.dshd.json：地址认不出时画布会悄悄去读写它、屏幕上毫无提示 ——
    // 用户以为在编辑 A，实际在改 B。现在落成显式状态，由 UI 提示"还没有绑定文件"。
    if (!hasPath) {
      // 未命名的空画布也是 v2：它由人手创建，保存时该带上 pinned（不被 AI 自动布局重排）。
      const blank = { version: 2, revision: 0, meta: { engine: 'drawio-svg', pinned: true }, nodes: [], edges: [] }
      docRef.current = blank
      revisionRef.current = 0
      dirtyRef.current = false
      resetHistory()
      setDoc(blank)
      setStatus({
        kind: 'ready',
        path: untitled ? '(未命名画布)' : '(未绑定文件)',
        error: '',
        absolute: '',
      })
      return undefined
    }

    let alive = true
    // 非活动标签不轮询：它只是被 display:none 藏着，没必要继续打宿主。
    // （但内容仍在内存里 —— 这正是"切换回来还是原样"的代价与收益。）
    if (!active) return undefined
    let lastText = null
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const signal = controller === null ? undefined : controller.signal

    async function pull() {
      let result = null
      try {
        result = await client.remote.workspaceFiles.read(sessionId, target, {}, signal)
      } catch (error) {
        if (!alive) return
        const message = error && error.message ? error.message : String(error)
        setStatus((prev) => (prev.kind === 'error' && prev.error === message ? prev : { kind: 'error', path: target, error: message, absolute: prev.absolute }))
        return
      }
      if (!alive) return

      // 宿主 Remote 统一把结果包在 RemoteResult 信封里：{ ok: true, value } / { ok: false, error }。
      // 这一点是从真实返回值确认的，不是推的 —— 拆开信封后才轮到判断载荷本身。
      let payload = result
      if (payload !== null && payload !== undefined && typeof payload === 'object' && typeof payload.ok === 'boolean') {
        if (payload.ok !== true) {
          setStatus({ kind: 'error', path: target, error: 'read 失败：' + describeValue(payload.error), absolute: '' })
          return
        }
        payload = payload.value
      }

      let text = null
      let absolute = target
      if (typeof payload === 'string') {
        text = payload
      } else if (payload !== null && payload !== undefined && typeof payload.text === 'string') {
        text = payload.text
        if (typeof payload.absolutePath === 'string') absolute = payload.absolutePath
      } else {
        setStatus({ kind: 'error', path: target, error: 'read 的载荷结构无法识别：\n' + describeValue(result), absolute: '' })
        return
      }
      const parsed = parseDocument(text)
      if (parsed.error) {
        setStatus({ kind: 'error', path: absolute, error: parsed.error, absolute: absolute })
        return
      }
      // 去重与防回环：revision 是这里唯一可靠的身份。
      //  - 本地有未落盘的改动 → 不要用服务端版本盖掉工作副本（否则用户正拖着的节点会被弹回去）
      //  - revision 与我们手上那份相同 → 这就是我们自己刚写出去的文件回声，忽略
      if (dirtyRef.current === true) {
        setStatus((prev) => (prev.kind === 'ready' ? prev : { kind: 'ready', path: absolute, error: '', absolute: absolute }))
        return
      }
      if (parsed.doc.revision === revisionRef.current && docRef.current !== null) {
        setStatus((prev) => (prev.kind === 'ready' && prev.absolute === absolute ? prev : { kind: 'ready', path: absolute, error: '', absolute: absolute }))
        return
      }
      docRef.current = parsed.doc
      revisionRef.current = parsed.doc.revision
      resetHistory()
      setDoc(parsed.doc)
      setStatus({ kind: 'ready', path: absolute, error: '', absolute: absolute })
    }

    pull()

    // 主通道：宿主变更流（只报告经 ctx.fs 的"被观测"写入）。
    // 失败不致命 —— 下面的兜底轮询继续工作。
    if (client.remote !== undefined && client.remote.workspaceFiles !== undefined && typeof client.remote.workspaceFiles.changes === 'function') {
      ;(async () => {
        try {
          for await (const rawFrame of client.remote.workspaceFiles.changes(sessionId, signal)) {
            if (!alive) break
            // 变更流的帧同样可能被信封包着，防御性拆一次。
            let frame = rawFrame
            if (frame !== null && frame !== undefined && typeof frame === 'object' && typeof frame.ok === 'boolean') frame = frame.value
            if (frame !== null && frame !== undefined && frame.kind === 'change') pull()
          }
        } catch (error) {
          // 变更流不可用时静默降级到轮询
        }
      })()
    }

    const dispose = client.interval(pull, POLL_MS)
    return () => {
      alive = false
      if (controller !== null) controller.abort()
      if (typeof dispose === 'function') dispose()
    }
  }, [target, sessionId, nonce, active])

  // 切换活动标签时重新上报聚焦：reportFocus 内部只在 target 变化时真的发请求，
  // 所以这里跟着 active 一起依赖即可（隐藏标签调用会被 !active 挡掉）。
  React.useEffect(() => {
    reportFocus()
  }, [active, target])

  // 视口：宽高比跟着容器走（h 由 aspect 推出），所以容器尺寸变化时不会变形。
  const aspect = size.w > 0 && size.h > 0 ? size.h / size.w : 1
  const fitView = doc === null ? null : computeFitView(contentBounds(doc), aspect)
  // 视口**必须把高也存下来**，不能每帧按容器宽高比现算：
  // h = w * aspect 时，只要容器宽高比变了（右栏被拖宽、面板高度变化），
  // x/y/w 不变而 h 变 —— 视野中心跟着偏，用户看到的就是"缩放/移动后元素突变位置"。
  // 存下来的 h 是"这一帧用户看到的那个视口"，缩放与平移都基于它算，视野才稳定。
  const view =
    viewOverride === null
      ? fitView
      : { x: viewOverride.x, y: viewOverride.y, w: viewOverride.w, h: viewOverride.h }
  // 在渲染期写入 ref：指针事件回调是渲染期创建的闭包，读 state 会拿到上一帧的视口，
  // 平移/缩放会因此"慢半拍"。
  viewRef.current = view
  const zoomPercent = view === null || size.w <= 0 ? 100 : Math.round((size.w / view.w) * 100)

  const singleSelectedNodeId = selectedIds.length === 1 && nodeById(selectedIds[0]) !== null ? selectedIds[0] : null

  const ui = {
    selectedIds: selectedIds,
    marquee: marquee,
    singleSelectedNodeId: singleSelectedNodeId,
    connectFrom: connectFrom,
    connectTo: connectTo,
    connectSide: connectSide,
    connectHover: connectHover,
    connectPreview: connectPreview,
    edgePreview: edgePreview,
    onNodePointerDown: onNodePointerDown,
    onNodePointerUp: onNodePointerUp,
    onNodeDoubleClick: onNodeDoubleClick,
    onNodeContextMenu: onNodeContextMenu,
    onHandlePointerDown: onHandlePointerDown,
    onSelectEdge: (id) => setSelectedIds([id]),
    onBackgroundPointerDown: onBackgroundPointerDown,
    onEdgeContextMenu: onEdgeContextMenu,
    onEdgeDoubleClick: onEdgeDoubleClick,
    onEdgeHandlePointerDown: onEdgeHandlePointerDown,
    onResizePointerDown: onResizePointerDown,
  }

  function menuTitle(text) {
    return React.createElement('div', { className: 'drawai-menu-title' }, text)
  }

  function swatchRow(onPick, activeColor) {
    const buttons = []
    // 调色板来自样式内核（PALETTE）：这里的"名字"只是 UI 的叫法，点下去生成 fillColor/strokeColor 键。
    for (let i = 0; i < PALETTE.length; i += 1) {
      const entry = PALETTE[i]
      buttons.push(
        React.createElement('button', {
          key: 'swatch-' + entry.name,
          className: activeColor === entry.name ? 'drawai-swatch on' : 'drawai-swatch',
          title: entry.name,
          style: { background: entry.fill, borderColor: entry.stroke },
          onClick: () => onPick(entry.name),
        }),
      )
    }
    return React.createElement('div', { className: 'drawai-swatches' }, buttons)
  }

  /** 元素库用 shapeElement 自己画缩略图 —— 库里的预览和画布上的形状永远一致。 */
  function shapeGrid(onPick) {
    const buttons = []
    for (let i = 0; i < SHAPE_LIBRARY.length; i += 1) {
      const entry = SHAPE_LIBRARY[i]
      // node 与 palette 必须来自同一个 colorOf —— shapeElement 的描边取自 style，填充取自 palette，
      // 只传 palette 不传 style 的话，缩略图会变成"默认填充 + 主题描边"。
      const chipNode = { style: styleWithColorName(styleWithNodeShape('', entry.shape), menuStyle) }
      const palette = colorOf(chipNode, 'light')
      buttons.push(
        React.createElement(
          'button',
          { key: 'shape-' + entry.shape, className: 'drawai-chip', title: entry.label, onClick: () => onPick(entry.shape) },
          React.createElement(
            'svg',
            { width: 44, height: 30, viewBox: '0 0 44 30' },
            shapeElement(chipNode, { x: 3, y: 3, w: 38, h: 24 }, palette, 'light'),
          ),
        ),
      )
    }
    return React.createElement('div', { className: 'drawai-grid' }, buttons)
  }

  function renderMenu() {
    if (menu === null) return null
    const rows = []

    if (menu.kind === 'canvas') {
      rows.push(menuTitle('元素库 —— 选一个放到这里'))
      rows.push(shapeGrid((shape) => createNodeAt(shape, menuStyle, menu.userX, menu.userY)))
      rows.push(swatchRow((style) => setMenuStyle(style), menuStyle))
      // 工具条的「＋ 节点」去掉之后，这里补一格"不挑形状、就放一个"的快捷入口：
      // 和上面点某个形状等价（同一个 createNodeAt、同一套新 id 规则），
      // 但不是每个人都记得九宫格里哪个是自己要的方框。
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => createNodeAt('rect', menuStyle, menu.userX, menu.userY) }, '＋ 新增节点'),
        ),
      )
    } else if (menu.kind === 'multi') {
      // 多选右键：对齐 / 分布。放在菜单而不是常驻工具条，是为了不挤压右栏宽度 ——
      // 这两个操作是"偶尔批量收拾一下"，不是常驻动作。
      const count = selectedIds.length
      rows.push(menuTitle('已选 ' + count + ' 个节点 —— 对齐 / 分布'))
      const alignRow = (items) =>
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          items.map((it) => React.createElement('button', { key: it[0], className: 'drawai-btn', onClick: () => alignSelection(it[0]) }, it[1])),
        )
      rows.push(alignRow([['left', '左对齐'], ['centerX', '水平居中'], ['right', '右对齐']]))
      rows.push(alignRow([['top', '顶对齐'], ['centerY', '垂直居中'], ['bottom', '底对齐']]))
      // 分布至少需要 3 个节点（两个之间没有"间距"可均分），不够就给禁用态而不是点了没反应。
      const canDistribute = count >= 3
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => alignSelection('distributeX'), disabled: !canDistribute, title: canDistribute ? '水平等距' : '需要选中至少 3 个节点' }, '水平等距'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => alignSelection('distributeY'), disabled: !canDistribute, title: canDistribute ? '垂直等距' : '需要选中至少 3 个节点' }, '垂直等距'),
        ),
      )
    } else if (menu.kind === 'node') {
      const node = nodeById(menu.id)
      const label = node !== null && typeof node.label === 'string' ? node.label : menu.id
      const nodeStyle = node === null || typeof node.style !== 'string' ? '' : node.style
      rows.push(menuTitle('节点：' + label))
      // 形状与配色都改成**键级改写**：不再往文档里写 shape 字段，也不再用颜色名当 style。
      rows.push(shapeGrid((shape) => updateNode(menu.id, { style: styleWithNodeShape(nodeStyle, shape) })))
      rows.push(swatchRow((color) => updateNode(menu.id, { style: styleWithColorName(nodeStyle, color) }), colorNameFromStyle(nodeStyle)))
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => openNodeEditor(menu.id) }, '改标签'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => deleteById(menu.id) }, '删除'),
        ),
      )
    } else {
      const edge = edgeById(menu.id)
      const hasLabel = edge !== null && typeof edge.label === 'string' && edge.label.length > 0
      // 「自动路由」的显示条件：有折点**或**两端被钉住了侧（两者都属于"人工干预过"）。
      const edgeStyleText = edge !== null && typeof edge.style === 'string' ? edge.style : ''
      const hasWaypoints =
        edge !== null &&
        ((Array.isArray(edge.points) && edge.points.length > 0) ||
          sideFromStyle(edgeStyleText, 'source') !== null ||
          sideFromStyle(edgeStyleText, 'target') !== null)
      rows.push(menuTitle('连线' + (hasLabel ? '：' + edge.label : '')))
      const actions = [React.createElement('button', { key: 'edit', className: 'drawai-btn', onClick: () => openEdgeEditor(menu.id) }, '改标签')]
      if (hasWaypoints) {
        actions.push(React.createElement('button', { key: 'auto', className: 'drawai-btn', onClick: () => clearEdgeWaypoints(menu.id) }, '自动路由'))
      }
      actions.push(React.createElement('button', { key: 'del', className: 'drawai-btn', onClick: () => deleteById(menu.id) }, '删除'))
      rows.push(React.createElement('div', { className: 'drawai-menu-row' }, actions))

      // 连线的画法。落盘是 style 键（dashed/dashPattern/endArrow/startArrow/strokeColor），
      // 这里只是它的手工入口 —— AI 侧走同一个 setStyle（dash/arrow/color 是糖），两边改的是同一批键。
      const edgeBaseStyle = edge === null || typeof edge.style !== 'string' ? DEFAULT_EDGE_STYLE : edge.style
      const edgeDashNow = edge === null ? 'solid' : dashFromStyle(edgeBaseStyle)
      const edgeArrowNow = edge === null ? 'end' : arrowFromStyle(edgeBaseStyle)
      const dashRow = (items) =>
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          items.map((it) =>
            React.createElement(
              'button',
              { key: it[0], className: 'drawai-btn' + (edgeDashNow === it[0] ? ' on' : ''), onClick: () => updateEdge(menu.id, { dash: it[0] }) },
              it[1],
            ),
          ),
        )
      rows.push(dashRow([['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']]))
      const arrowRow = (items) =>
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          items.map((it) =>
            React.createElement(
              'button',
              { key: it[0], className: 'drawai-btn' + (edgeArrowNow === it[0] ? ' on' : ''), onClick: () => updateEdge(menu.id, { arrow: it[0] }) },
              it[1],
            ),
          ),
        )
      rows.push(arrowRow([['end', '→ 单向'], ['both', '↔ 双向'], ['none', '— 无箭头'], ['start', '← 反向']]))
    }

    // 夹在画布内：容器是 overflow:hidden，菜单贴边弹出会被裁掉。
    const left = Math.max(0, Math.min(menu.left, size.w - 214))
    const top = Math.max(0, Math.min(menu.top, size.h - 8))
    return React.createElement('div', { className: 'drawai-menu', style: { left: left + 'px', top: top + 'px' } }, rows)
  }

  /** 新建 / 打开 的弹出面板。复用 drawai-menu 的样式，位置固定在画布左上角下面。 */
  function renderDocMenu() {
    if (docMenu === null) return null
    // **先把状态归一化**，后面的代码才敢直接读 .error / .files。
    //
    // 这里崩过一次，报错就长这样：
    //   DrawAI 渲染异常（已降级，画布未渲染）Cannot read properties of null (reading 'length')
    // 原因是 fileList 有三个字段（files / error）却被当成"一定有"来读，
    // 只要任何一处 setState 传进来的形状差一点（null、缺字段），整个画布就直接降级成红底错误页。
    // 渲染函数不该假设状态形状 —— 拿不准的就当场兜住。
    const list = fileList !== null && typeof fileList === 'object' ? fileList : null
    const listError = list !== null && typeof list.error === 'string' ? list.error : ''
    const listFiles = list !== null && Array.isArray(list.files) ? list.files : null

    // 工具条下拉菜单（文件 / 编辑 / 视图 / 导出）：docMenu 的值就是菜单的 key。
    const toolbarMenu = toolbarMenus().filter((m) => m.key === docMenu)[0]
    if (toolbarMenu !== undefined) {
      const rows = [menuTitle(toolbarMenu.title)]
      for (let i = 0; i < toolbarMenu.items.length; i += 1) {
        const entry = toolbarMenu.items[i]
        rows.push(
          React.createElement(
            'button',
            {
              key: 'mi' + i,
              className: 'drawai-btn drawai-menu-item',
              disabled: entry.disabled === true,
              onClick: () => {
                setDocMenu(null)
                setDocMenuPos(null)
                entry.onClick()
              },
            },
            entry.label,
            entry.hint.length > 0 ? React.createElement('span', { className: 'drawai-menu-hint' }, entry.hint) : null,
          ),
        )
      }
      return React.createElement('div', { className: 'drawai-menu drawai-docmenu', style: panelStyle(docMenuPos) }, rows)
    }
    // 宿主把"列不出来"的原因也带回来了 —— 必须显示，否则用户只看到"找不到文件"，无从判断。
    const listNotes = list !== null && Array.isArray(list.notes) ? list.notes : []
    const rows = []
    if (docMenu === 'open') {
      rows.push(menuTitle('打开画布 —— 用文件管理器选一个目录'))
      if (list === null) {
        rows.push(React.createElement('div', { className: 'drawai-note' }, '读取中…'))
      } else if (listError.length > 0) {
        rows.push(React.createElement('div', { className: 'drawai-err' }, listError))
      } else if (listFiles === null) {
        rows.push(React.createElement('div', { className: 'drawai-note' }, '读取中…'))
      } else if (listFiles.length === 0) {
        rows.push(React.createElement('div', { className: 'drawai-note' }, '这个目录里没有 .dshd.json —— 换一个目录，或用「新建」建一张'))
      } else {
        const items = []
        for (let i = 0; i < listFiles.length; i += 1) {
          const item = listFiles[i]
          // 每一项形如 { path, display }：path 是身份（绝对路径，用于去重和绑定），
          // display 是给人看/点的名字。宿主若没给 absolute，path 就是相对路径，照样能用。
          const identity = item !== null && typeof item === 'object' && typeof item.path === 'string' ? item.path : null
          const label = item !== null && typeof item === 'object' && typeof item.display === 'string' ? item.display : identity
          if (identity === null || identity.length === 0 || label === null) continue
          const current = identity === target
          items.push(
            React.createElement(
              'button',
              {
                key: identity,
                className: 'drawai-btn' + (current ? ' on' : ''),
                style: { display: 'block', width: '100%', textAlign: 'left', marginBottom: '3px' },
                onClick: () => switchTo(identity),
              },
              label + (current ? '  ← 当前' : ''),
            ),
          )
        }
        rows.push(React.createElement('div', null, items))
      }
      for (let i = 0; i < listNotes.length; i += 1) {
        rows.push(React.createElement('div', { className: 'drawai-note', key: 'note' + i }, '⚠ ' + listNotes[i]))
      }
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: pickDirectoryAndList, title: '打开系统文件管理器，另选一个目录' }, '选择目录…'),
          React.createElement(
            'button',
            {
              className: 'drawai-btn',
              onClick: () => fetchFileList(lastPickedDirRef.current),
              title: '重新读取当前目录',
            },
            '重新读取',
          ),
          React.createElement('button', { className: 'drawai-btn', onClick: () => setDocMenu(null) }, '关闭'),
        ),
      )
    } else {
      // 需要输入名字的两种情形：新建 / 另存为。**共用同一个输入框**，
      // 差别只在确认时调哪个函数、以及默认值从哪来。
      const isNew = docMenu === 'new'
      rows.push(menuTitle(isNew ? '新建画布' : hasPath ? '另存为' : '给这张未命名画布一个文件名'))
      rows.push(
        React.createElement('input', {
          className: 'drawai-edit doc-menu-input',
          autoFocus: true,
          // onFocus 里全选：默认名是"建议值"，用户直接打字即替换 —— 否则还得先手动删掉
          onFocus: (event) => {
            try {
              event.target.select()
            } catch (error) {
              /* 某些环境不支持 select()，忽略即可 */
            }
          },
          ref: (el) => {
            nameInputRef.current = el
          },
          value: newName,
          placeholder: '文件名，例如 my-flow',
          onChange: (event) => {
            setNewName(event.target.value)
            setFileList(null)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              if (isNew) createCanvasNamed(newName)
              else saveAs(newName)
            } else if (event.key === 'Escape') {
              setDocMenu(null)
            }
          },
        }),
      )
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-note' },
          isNew
            ? '不填扩展名会自动补 .dshd.json；只落在工作区根目录。同名会提示换名，不会覆盖。'
            : '不填扩展名会自动补 .dshd.json；只落在工作区根目录。同名文件不会被覆盖。',
        ),
      )
      if (listError.length > 0) {
        rows.push(React.createElement('div', { className: 'drawai-err' }, listError))
      }
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement(
            'button',
            { className: 'drawai-btn', onClick: () => (isNew ? createCanvasNamed(newName) : saveAs(newName)) },
            isNew ? '创建并打开' : '保存',
          ),
          React.createElement('button', { className: 'drawai-btn', onClick: () => setDocMenu(null) }, '取消'),
        ),
      )
    }
    return React.createElement('div', { className: 'drawai-menu drawai-docmenu', style: panelStyle(docMenuPos) }, rows)
  }

  const modeTag = mode === 'light' ? 'draw.io 外观' : '暗色外观'
  const canUndo = historyRef.current.past.length > 0
  const canRedo = historyRef.current.future.length > 0
  const canSave = hasPath && dirtyRef.current === true

  /** 打开「另存为」面板。 */
  function openSaveAsPanel() {
    setDocMenu('saveAs')
    setNewName('')
    setFileList(null)
    setDocMenuPos(null)
  }

  /**
   * 打开「新建」面板：先向宿主**探**一个没被占用的默认名（untitled / untitled-2 …），
   * 预填进输入框并全选 —— 用户直接打字即替换，不改就直接回车。
   *
   * 探名不落盘（宿主 action:'suggest'）：用户可能取消，不该留下空文件。
   */
  async function openNewCanvasPanel() {
    setDocMenu('new')
    setFileList(null)
    setNewName('untitled')
    setNameInputRef.current = null
    // 拉一个更准确的默认名（可能是 untitled-3 之类）
    if (client === null) return
    let suggested = null
    try {
      const raw = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        body: JSON.stringify({ action: 'suggest', sessionId: sessionId, base: 'untitled' }),
      })
      const payload = await raw.json()
      if (payload !== null && payload.ok === true && typeof payload.name === 'string') suggested = payload.name
    } catch (error) {
      suggested = null
    }
    if (suggested === null) return
    // 用户可能已经开始打字了 —— 那就不覆盖他输入的内容。
    if (nameInputRef.current !== null && nameInputRef.current.value !== 'untitled') return
    setNewName(suggested)
  }

  /** 用给定名字新建并打开。名字由用户在面板里确认。 */
  async function createCanvasNamed(name) {
    const trimmed = String(name === undefined || name === null ? '' : name).trim()
    if (trimmed.length === 0) {
      setFileList({ files: null, error: '请填一个文件名' })
      return
    }
    if (/[\\/]/.test(trimmed)) {
      setFileList({ files: null, error: '文件名不能包含路径分隔符' })
      return
    }
    const withExt = trimmed.toLowerCase().endsWith('.dshd.json') ? trimmed : trimmed + '.dshd.json'
    if (client === null) return
    setSaveNote('新建 ' + withExt + ' …')
    let raw = null
    try {
      raw = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        body: JSON.stringify({ action: 'create', sessionId: sessionId, name: withExt }),
      })
    } catch (error) {
      setFileList({ files: null, error: '新建失败：' + (error && error.message ? error.message : String(error)) })
      return
    }
    let payload = null
    try {
      payload = await raw.json()
    } catch (error) {
      setFileList({ files: null, error: '新建失败：返回不是 JSON（HTTP ' + raw.status + '）' })
      return
    }
    if (payload === null || payload.ok !== true) {
      const message = String(payload !== null && payload.error ? payload.error : 'HTTP ' + raw.status)
      const exists = payload !== null && payload.exists === true
      setFileList({ files: null, error: exists ? '已存在同名文件：换个名字，或用「打开…」' : message })
      return
    }
    setDocMenu(null)
    setNewName('')
    setFileList(null)
    onOpenTab(String(payload.path))
    setSaveNote('已新建 ' + String(payload.path))
  }

  /**
   * 算出某个工具条按钮在**画布里**的位置，好把菜单展开在它正下方。
   *
   * 参照系必须是**画布**（.drawai-canvas）：菜单是它的绝对定位子元素。
   * 曾经拿 `.drawai-tools` 当参照，可那个容器没有 position:relative ——
   * 偏移量与实际定位上下文不一致，菜单会横着跑偏。
   *
   * 用 DOM 量而不是自己攒坐标：按钮宽度随文案变（"导出 ▾" 比 "文件 ▾" 宽），
   * 右栏也随时可能被拖动改宽，量当下这一帧最省事也最准。
   * 量不到（首帧 ref 还没挂）就返回 null，调用方退回固定位置。
   */
  function menuPosFor(key) {
    const canvas = canvasRef.current
    const btn = toolBtnRefs.current[key]
    if (canvas === null || canvas === undefined || btn === null || btn === undefined) return null
    try {
      const a = btn.getBoundingClientRect()
      const c = canvas.getBoundingClientRect()
      // 用按钮**左边缘**对齐菜单左边缘（不居中）：右栏窄，居中更容易被右侧夹取挤回去。
      return { left: Math.round(a.left - c.left), top: Math.round(a.bottom - c.top) + 2 }
    } catch (error) {
      return null
    }
  }

  /** 从工具条开一个下拉菜单（点同一个按钮则收起）。 */
  function toggleToolbarMenu(key) {
    if (docMenu === key) {
      setDocMenu(null)
      setDocMenuPos(null)
      return
    }
    setDocMenu(key)
    setDocMenuPos(menuPosFor(key))
  }

  /**
   * 面板的定位样式：贴在触发它的按钮下方，并夹在画布范围内。
   *
   * 为什么用 inline style 而不是 CSS 类：位置随按钮宽度和右栏宽度变，属于运行期数据。
   * 夹取用画布的当前尺寸（size）—— 右栏很窄，靠右的菜单（「导出」）不夹会伸到面板外面看不见。
   */
  function panelStyle(pos) {
    if (pos === null || pos === undefined) return undefined
    const width = 240
    const maxLeft = Math.max(0, (size.w > 0 ? size.w : width) - width - 4)
    const maxTop = Math.max(0, (size.h > 0 ? size.h : 200) - 60)
    return { left: Math.min(Math.max(0, pos.left), maxLeft) + 'px', top: Math.min(Math.max(0, pos.top), maxTop) + 'px' }
  }

  /**
   * 工具条的**下拉菜单**：同类型的操作收进一个入口。
   *
   * 为什么改：右栏本来就窄，11 个按钮排成两行既挤又难扫。按"文件 / 编辑 / 视图 / 导出"
   * 分类后工具条只剩 4 个入口，而且每项都能带一句说明（按钮上放不下）。
   *
   * 面板沿用 docMenu 那套绝对定位（在画布左上角展开），而不是 CSS hover 弹出 ——
   * 这里是窄栏，hover 弹出很难点，鼠标一移开就收起。
   */
  function toolbarMenus() {
    const item = (label, onClick, opts) => ({
      label: label,
      onClick: onClick,
      hint: opts !== undefined && opts.hint !== undefined ? opts.hint : '',
      disabled: opts !== undefined && opts.disabled === true,
    })
    return [
      {
        key: 'file',
        label: '文件',
        title: '新建 / 打开 / 保存',
        items: [
          item('新建画布…', openNewCanvasPanel, { hint: '自己起个名字（默认预填下一个可用的 untitled*）' }),
          item('打开…', openFilePicker, { hint: '列出上次用过的目录里已有的画布' }),
          item(hasPath ? '保存' : '另存为…', () => (hasPath ? saveNow() : openSaveAsPanel()), {
            hint: hasPath ? '立刻落盘（平时会自动保存）' : '给这张未命名画布一个文件名',
            disabled: hasPath && !canSave,
          }),
          item('另存为…', openSaveAsPanel, { hint: '换个文件名保存一份' }),
          item('选择目录…', pickDirectoryAndList, { hint: '打开系统文件管理器另选一个目录' }),
        ],
      },
      {
        key: 'edit',
        label: '编辑',
        title: '撤销 / 重做',
        items: [
          item('撤销', undo, { hint: 'Ctrl+Z', disabled: !canUndo }),
          item('重做', redo, { hint: 'Ctrl+Shift+Z', disabled: !canRedo }),
        ],
      },
      {
        key: 'view',
        label: '视图',
        title: '缩放与外观',
        items: [
          item('适应内容', () => setViewOverride(null), { hint: '把图缩放到刚好铺满面板' }),
          item(modeTag, () => setMode(mode === 'light' ? 'dark' : 'light'), { hint: '切换明暗配色' }),
          item('重新读取文件', () => setNonce((n) => n + 1), { hint: '从磁盘重新载入这张画布' }),
        ],
      },
      {
        key: 'export',
        label: '导出',
        title: '导出为图片或矢量',
        items: [
          item(
            '导出 SVG',
            () => {
              setSelectedIds([])
              setExportRequest('svg')
            },
            { hint: '矢量，可再编辑' },
          ),
          item(
            '导出 PNG（2×）',
            () => {
              setSelectedIds([])
              setExportRequest('png')
            },
            { hint: '位图，适合贴到文档里' },
          ),
        ],
      },
    ]
  }

  const head = React.createElement(
    'div',
    { className: 'drawai-head' },
    React.createElement('span', { className: 'drawai-path', title: status.path }, status.path),
    React.createElement(
      'div',
      { className: 'drawai-tools' },
      // 四个分类入口（菜单在**各自按钮正下方**展开，见 renderDocMenu）。
      toolbarMenus().map((m) =>
        React.createElement(
          'button',
          {
            key: m.key,
            ref: (el) => {
              toolBtnRefs.current[m.key] = el
            },
            className: 'drawai-btn' + (docMenu === m.key ? ' on' : ''),
            onClick: () => toggleToolbarMenu(m.key),
            title: m.title,
          },
          m.label + ' ▾',
        ),
      ),
    ),
  )


  let body
  if (status.kind === 'error') {
    body = React.createElement('div', { className: 'drawai-err' }, status.error)
  } else if (doc === null) {
    body = React.createElement('div', { className: 'drawai-note' }, '读取中…')
  } else {
    const canvasChildren = [renderDiagram(doc, mode, uid, svgRef, ui, view)]
    const menuNode = renderMenu()
    if (menuNode !== null) canvasChildren.push(menuNode)
    const docMenuNode = renderDocMenu()
    if (docMenuNode !== null) canvasChildren.push(docMenuNode)
    if (editing !== null) {
      // 就地改标签：用 HTML input 绝对定位盖在节点上。
      // 不用 SVG foreignObject —— React 会把 <svg> 后代一律建成 SVG 命名空间元素，
      // 里面的 <input> 不会按 HTML 渲染。
      canvasChildren.push(
        React.createElement('input', {
          key: 'label-editor',
          className: 'drawai-edit',
          autoFocus: true,
          value: editing.text,
          style: {
            left: editing.left + 'px',
            top: editing.top + 'px',
            width: Math.max(60, editing.width) + 'px',
            height: Math.max(24, editing.height) + 'px',
          },
          // 保留 kind 等全部字段：这里曾经重建对象时漏了 kind，于是"编辑过再平移"会走错分支。
          onChange: (event) => setEditing(Object.assign({}, editing, { text: event.target.value })),
          onBlur: commitEdit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitEdit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(null)
            }
          },
        }),
      )
    }
    body = React.createElement(
      'div',
      {
        className: 'drawai-canvas',
        ref: canvasRef,
        title: '滚轮缩放 · 中键拖动平移 · 空白左键拖框选 · 双击改标签 · 右键元素库\n连线：点选后 绿/红端点拖到别的节点=改接，橙色空心点=段把手（拖=整段平移，撤销用 Ctrl+Z）',
        onContextMenu: onCanvasContextMenu,
        onPointerDown: onCanvasPointerDown,
        onPointerMove: onCanvasPointerMove,
        onPointerUp: onCanvasPointerUp,
        onPointerLeave: onCanvasPointerUp,
        // 中键在 Chrome 上默认触发自动滚动（那个四向圆盘），必须拦掉它的默认行为。
        // pointerdown 的 preventDefault 管不住它，要在 mousedown 上拦。
        onMouseDown: (event) => {
          if (event.button === 1) event.preventDefault()
        },
        onAuxClick: (event) => {
          if (event.button === 1) event.preventDefault()
        },
      },
      canvasChildren,
    )
  }

  const note =
    (untitled || unbound
      ? // 未绑定文件时，**AI 对话改不到这张画布**：diagram_apply 只按文件路径工作，
        // 不传 path 它会落到工作区里的 demo.dshd.json（实测），而你屏幕上这张根本没有文件。
        // 这件事必须在界面上说清：否则用户对着未命名画布说"画一张流程图"，
        // 图会出现在另一个文件里（或把 demo 覆盖掉），而屏幕毫无反应。
        (untitled ? '✋ 未命名画布：AI 对话暂时改不到它 —— 先「另存为」给它一个文件名' : '✋ 未绑定文件：AI 对话改不到它 —— 用「打开」或「另存为」绑定一个文件')
      : '') +
    (status.kind === 'ready' && doc !== null
      ? (untitled || unbound ? ' ｜ ' : '') +
        '节点 ' + doc.nodes.length + ' · 边 ' + doc.edges.length + ' · revision ' + doc.revision + ' · 缩放 ' + zoomPercent + '%'
      : '数据源：' + (target.length > 0 ? target : '（未绑定）')) +
    (saveNote.length > 0 ? ' ｜ ' + saveNote : '') +
    (infoError.length > 0 ? ' ｜ ⚠ ' + infoError : '')

  return React.createElement(
    'div',
    { className: 'drawai-root' },
    head,
    body,
    React.createElement('div', { className: 'drawai-note' }, note),
  )
}

/**
 * 渲染边界。
 *
 * 教训：这个画布前后出现过两次"tab 主体完全空白"。空白是最不可诊断的失败形态 ——
 * 它和"插件没加载"、"座位没派发到我的 key"、"组件自己抛异常"长得**一模一样**，
 * 光看屏幕无法区分，只能靠额外探针一轮轮排除。
 *
 * 所以从此以后：任何渲染期异常都必须变成一块**看得见的错误面板**，
 * 而不是静默的空白。这也是之前的排查走错两次方向的根本原因。
 */
class CanvasBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error: error }
  }

  render() {
    const error = this.state.error
    if (error !== null) {
      const message = error && error.message ? error.message : String(error)
      const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 8).join('\n') : '(无 stack)'
      return React.createElement(
        'div',
        {
          style: {
            background: '#7a1f1f',
            color: '#ffffff',
            padding: '12px',
            font: '12px/1.6 monospace',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            height: '100%',
            boxSizing: 'border-box',
          },
        },
        'DrawAI 渲染异常（已降级，画布未渲染）\n\n' + message + '\n\n' + stack,
      )
    }
    return this.props.children
  }
}

/**
 * 真正调用 useTabInfo 的地方，故意不加 try/catch：
 * 钩子函数抛错时若被就地吞掉，React 的钩子指针会失配，后续渲染会以更难懂的方式失败。
 * 交给边界干净地卸载这一棵子树，才是 React 认得的做法。
 */
function CanvasStage(props) {
  const hook = props.useTabInfo
  const info = typeof hook === 'function' ? hook() : null
  const address = info && info.tab && info.tab.navigation ? info.tab.navigation.address : undefined
  // 诊断：把"画布实际拿到的地址"显示出来。
  //
  // 为什么留着：tab 的地址来源有两处 —— `tab.contentId`（资源 tab 的真实地址）
  // 与 `tab.navigation.address`（最后一次导航的地址）。两者在"页面 tab"下都是
  // `sidebar://<kind>`，只有在资源 tab 下才是 `dsh-resource://...`。
  // 到底是哪一个，只能在真实页面上看 —— 拿不到就无从判断，而这个值直接决定
  // 画布"绑没绑上文件"。显示出来比反复猜测便宜得多。
  const contentId = info && info.tab && typeof info.tab.contentId === 'string' ? info.tab.contentId : ''
  const shown = address !== undefined && address !== null && String(address).length > 0 ? String(address) : contentId
  return React.createElement(CanvasTabs, {
    sessionId: props.sessionId,
    tabPath: pathFromAddress(shown),
    infoError: shown.length > 0 && pathFromAddress(shown) === undefined ? 'tab 地址无法解析为文件：' + shown : '',
  })
}

/**
 * 多画布标签页。
 *
 * 设计取舍（值得写下来，否则很容易改坏）：
 *  - **所有标签都保持挂载**，非活动的用 `display:none` 藏起来。这样每个画布的
 *    视口、选中、撤销历史都留在各自的 CanvasView 里 —— 切换回来还是原来的样子。
 *    换成"只渲染活动标签"的话，每次切换都会重建组件，撤销历史和视口全丢。
 *  - 代价是非活动标签的组件仍然存在（会记住 doc 副本），但**不会轮询**：
 *    加载 effect 里判断 !active 就直接返回。
 *  - 标签只存"路径"（或 UNTITLED），文档内容归各自的 CanvasView 管 ——
 *    这里不做第二份文档状态，否则两边会不一致。
 */
function CanvasTabs(props) {
  const tabPath = typeof props.tabPath === 'string' && props.tabPath.length > 0 ? props.tabPath : null
  const tabError = typeof props.infoError === 'string' ? props.infoError : ''
  /**
   * 初始**没有任何标签**。
   *
   * 之前这里会先放一个"占位"标签，结果用户一进来就看到一个 (未绑定) 空画布 ——
   * 那正是要避免的：地址要么会到（开真文件的标签），要么根本给不出（那才轮到空画布）。
   * 现在初始是真正的空视图，由下面的 effect 在两种情况里各给出一个标签。
   */
  const [tabs, setTabs] = React.useState([])
  const [activeKey, setActiveKey] = React.useState('')
  const [counter, setCounter] = React.useState(1)
  /** 只做一次"开哪个标签"的决定；之后标签的增减交给用户操作。 */
  const bootstrappedRef = React.useRef(false)

  React.useEffect(() => {
    if (bootstrappedRef.current) return
    if (tabPath !== null) {
      // 地址到了 → 开**真文件**的标签
      bootstrappedRef.current = true
      const key = 'tab:' + tabPath
      setTabs([{ key: key, path: tabPath, untitled: false, unbound: false }])
      setActiveKey(key)
      return
    }
    if (tabError.length > 0) {
      // 地址给不出**而且确实出错了** → 给一个空画布让用户能自救（新建/打开都在菜单里），
      // 状态栏同时说明为什么解析不出来。
      bootstrappedRef.current = true
      setTabs([{ key: 'unbound', path: null, untitled: false, unbound: true }])
      setActiveKey('unbound')
      return
    }
    // 两者都没有 —— 地址还在路上（tab 尚未提交）。**什么都不开**，继续等。
    // 刻意不设超时兜底：宁可多空白一小会儿，也不要凭空冒出一个空画布。
  }, [tabPath, tabError])


  /** 打开一个路径：已经在标签里就切过去，否则新开一个。规则在 openTabIn（可自测）。 */
  function openPath(path) {
    const next = openTabIn(tabs, path, counter)
    if (next.active === null) return
    if (next.tabs !== tabs) setTabs(next.tabs)
    if (next.counter !== counter) setCounter(next.counter)
    setActiveKey(next.active)
  }

  /** 某个标签改名了（另存为 / 切文件）——只更新它自己那条记录。 */
  function rebind(key, path) {
    setTabs((list) => list.map((t) => (t.key === key ? Object.assign({}, t, { path: path, untitled: false, unbound: false }) : t)))
    setActiveKey('tab:' + path)
  }

  function closeTab(key) {
    setTabs((list) => {
      const next = list.filter((t) => t.key !== key)
      if (next.length === 0) return list // 至少留一个，否则整个面板空了
      if (key === activeKey) setActiveKey(next[next.length - 1].key)
      return next
    })
  }

  const children = []
  // **一个标签都还没有**：地址还在路上（tab 尚未提交）。这时候什么都不开 ——
  // 既不显示工具条、也不显示空画布，只给一句"正在打开"，避免凭空冒出一个未绑定画布。
  if (tabs.length === 0) {
    return React.createElement(
      'div',
      { className: 'drawai-tabs-wrap' },
      React.createElement('div', { className: 'drawai-note' }, '正在打开画布…'),
    )
  }
  const tabBar = React.createElement(
    'div',
    { className: 'drawai-tabs', key: 'tabbar' },
    tabs.map((t, i) =>
      React.createElement(
        'span',
        { key: t.key, className: 'drawai-tab' + (t.key === activeKey ? ' on' : '') },
        React.createElement('button', { className: 'drawai-tab-name', title: t.untitled ? '未命名画布（还没有文件）' : String(t.path), onClick: () => setActiveKey(t.key) }, tabLabelOf(t.path, i + 1)),
        tabs.length > 1
          ? React.createElement('button', { className: 'drawai-tab-x', title: '关闭这个标签', onClick: () => closeTab(t.key) }, '×')
          : null,
      ),
    ),
  )
  for (let i = 0; i < tabs.length; i += 1) {
    const t = tabs[i]
    const isActive = t.key === activeKey
    children.push(
      React.createElement(
        'div',
        {
          key: 'pane:' + t.key,
          className: 'drawai-pane',
          // display:none 而不是不渲染 —— 保住各标签的视口与撤销历史。
          style: { display: isActive ? 'flex' : 'none' },
        },
        React.createElement(CanvasBoundary, null,
          React.createElement(CanvasView, {
            sessionId: props.sessionId,
            path: t.untitled || t.unbound ? '' : t.path,
            untitled: t.untitled,
            unbound: t.unbound,
            hasPath: !t.untitled && !t.unbound && typeof t.path === 'string' && t.path.length > 0,
            active: isActive,
            infoError: '',
            onOpenTab: openPath,
            onRebind: (path) => rebind(t.key, path),
          }),
        ),
      ),
    )
  }
  return React.createElement('div', { className: 'drawai-tabs-wrap' }, tabBar, React.createElement('div', { className: 'drawai-panes' }, children))
}

function CanvasBody(props) {
  const sessionId = props ? props.sessionId : undefined
  const hook = props ? props.useTabInfo : undefined
  return React.createElement(CanvasTabsStage, { sessionId: sessionId, useTabInfo: hook })
}

/** 包一层边界：useTabInfo 抛错时由 CanvasBoundary 接住，不静默空白。 */
function CanvasTabsStage(props) {
  return React.createElement(
    CanvasBoundary,
    null,
    React.createElement(CanvasStage, { sessionId: props.sessionId, useTabInfo: props.useTabInfo }),
  )
}

function TitleWithTab(props) {
  let info = null
  try {
    info = props.useTabInfo()
  } catch (error) {
    info = null
  }
  const address = info && info.tab && info.tab.navigation ? info.tab.navigation.address : undefined
  const name = basename(address)
  return React.createElement('span', null, '📐 ' + (name.length > 0 && name !== KIND ? name : 'DrawAI 画布'))
}

function CanvasTitle(props) {
  const hook = props ? props.useTabInfo : undefined
  if (typeof hook === 'function') return React.createElement(TitleWithTab, { useTabInfo: hook })
  return React.createElement('span', null, '📐 DrawAI 画布')
}

const STYLE_ID = 'dsh-drawai/client.css'

function apply(ctx) {
  client = ctx

  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-plugin', 'dsh-drawai')
  styleEl.setAttribute('data-plugin-css', STYLE_ID)
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)
  ctx.effect(() => () => {
    if (styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl)
  })

  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id: ID,
      kind: KIND,
      patterns: ['**/*.dshd.json'],
      title: (address) => {
        const name = basename(address)
        return name.length > 0 && name !== KIND ? name : 'DrawAI 画布'
      },
      guide: [
        {
          order: 30,
          title: () => 'DrawAI 画布',
          description: () => '把工作区里的 .dshd.json 渲染成 draw.io 风格的图；AI 改文件，画布自动重绘',
        },
      ],
    }),
  )

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, CanvasBody)))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, CanvasTitle)))
}

exports.name = 'drawai'
exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'timer', 'remote', 'remote.workspaceFiles']
exports.apply = apply

/**
 * 路由内核的只读出口，仅供 tools/check-route-preview.mjs 做无浏览器自测。
 * 这些是纯函数（输入文档 → 输出折点），导出去不增加任何运行时耦合。
 */
exports.__routeInternals = {
  buildGeometry: buildGeometry,
  routePreview: routePreview,
  routePreviewFor: routePreviewFor,
  edgePreviewRoute: edgePreviewRoute,
  hitNodeAt: hitNodeAt,
  pathOf: pathOf,
  pathCost: pathCost,
  renderDiagram: renderDiagram,
  computeAlignMoves: computeAlignMoves,
  parseDocument: parseDocument,
  pathFromAddress: pathFromAddress,
  computeFitView: computeFitView,
  zoomViewAt: zoomViewAt,
  contentBounds: contentBounds,
  openTabIn: openTabIn,
  tabLabelOf: tabLabelOf,
  UNTITLED: UNTITLED,
  edgeRoutePoints: edgeRoutePoints,
  prunePoints: prunePoints,
  samePath: samePath,
  simplifyCollinear: simplifyCollinear,
  snapNearAxis: snapNearAxis,
  anchorSidesOf: anchorSidesOf,
  pickSides: pickSides,
  stubPointFor: stubPointFor,
  borderPointToward: borderPointToward,
  sidesFromStyle: sidesFromStyle,
  pinnedSideOf: pinnedSideOf,
  chainForRoute: chainForRoute,
  dropTargetOf: dropTargetOf,
  routeThroughWaypoints: routeThroughWaypoints,
  routeEdge: routeEdge,
  ensurePinned: ensurePinned,
  SIDES: SIDES,
  HOT_PAD: HOT_PAD,
  GRID: GRID,
}
