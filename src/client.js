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
  curvedFromStyle,
  dashFromStyle,
  dashPatternFromStyle,
  edgeFreePoint,
  formatStyle,
  isOrthogonalEdgeStyle,
  jettyFromStyle,
  lineKindFromStyle,
  nodeShapeFromStyle,
  normalizeDrawioDoc,
  snapDocGeometry,
  parseStyle,
  sideFromStyle,
  styleGet,
  styleNumber,
  stylePatch,
  styleWithArrow,
  styleWithColorName,
  styleWithTextColorName,
  textColorNameFromStyle,
  styleWithDash,
  styleWithLineKind,
  styleWithNodeShape,
  styleWithSide,
} = styleKernel

const ID = 'drawai:diagram'
const KIND = 'diagram'
const DEFAULT_PATH = 'demo.drawio'

/**
 * 标签列表的**纯逻辑**：算"打开 path 之后，标签列表与活动标签变成什么"。
 *
 * 抽出来是为了能被命令行自测直接断言 —— 这段规则有一条容易写错：
 * 同一个文件重复打开必须**切过去**，不能再开一个（否则标签栏会堆满同一个文件）。
 * 去重要**大小写不敏感**，并把分隔符归一：Windows 上 D:\ws\a 与 D:/WS/A 是同一个文件，
 * 按字面比会开出第二个标签（探针实测到过）。归一后仍用**先打开的那个**路径当身份，
 * 免得同一个文件在标签上显示成两种写法。
 *
 * 标签**只表示一个已绑定的文件**：没有文件就没有标签（空舞台由 CanvasTabs 直接渲染），
 * 不再有"(未绑定)"/"未命名"这种幽灵标签 —— 那两套代码已经删掉了。
 *
 * 返回值 { tabs, active }；path 非法时原样返回。
 */
function openTabIn(list, path) {
  if (typeof path !== 'string' || path.length === 0) return { tabs: list, active: null }
  const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
  for (let i = 0; i < list.length; i += 1) {
    if (samePath(list[i].path, path)) return { tabs: list, active: list[i].key }
  }
  const key = 'tab:' + path
  return { tabs: list.concat([{ key: key, path: path }]), active: key }
}

/** 标签标题：文件名。 */
function tabLabelOf(path) {
  if (typeof path !== 'string' || path.length === 0) return '画布'
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

const POLL_MS = 3000
/** 人工编辑的写回端点（宿主半边注册，见 src/index.js）。 */
const SAVE_ENDPOINT = '/drawai/api/save'
/** 自定义请求头，宿主用它做 CSRF 围栏。 */
const SAVE_HEADER = 'x-drawai-save'
/** 节点移动/缩放的吸附网格（px）：**一格 = 10px**。 */
const GRID = 10
/** 连线（折点/线段）的最小移动单位：**半格 = 5px**。连线比节点需要更细的手感。 */
const EDGE_GRID = GRID / 2

/**
 * 指针移动多少像素之后才抢 pointer capture（见 `requestCapture`）。
 *
 * 取 3 是跟着"越 3px 才算拖"那套手感走的：手抖一两像素的点击不该被当成拖动，
 * 更不该因此抢掉捕获 —— 抢了 click/dblclick 就落到画布容器上，双击改标签直接失灵。
 */
const CAPTURE_MOVE_PX = 3

/**
 * 新建节点的默认尺寸：**都取整格**。
 *
 * 为什么：尺寸不整格，节点中心就会落在半像素上（旧的 130×56 默认值，中心 y 偏移 28），
 * 连线于是动不动多出"差一像素"的台阶。默认 60 与 GRID 对齐后，只要坐标在格线上，
 * 中心就永远是 5 的倍数。
 */
const NEW_NODE_W = 130
const NEW_NODE_H = 60

/** 文档里没写 w/h 时的兜底尺寸（同样整格）。 */
const FALLBACK_NODE_W = 150
const FALLBACK_NODE_H = NEW_NODE_H

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
  // 空舞台：一张画布都没打开时的提示（工作栏在它上面，仍然可用）。
  '.drawai-empty{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:16px;text-align:center}',
  '.drawai-empty-title{font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6)}',
  '.drawai-empty-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6)}',
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
  // 「编辑数据」面板里的多行输入：等宽字体、跟着菜单宽度走。
  '.drawai-data{width:100%;box-sizing:border-box;font:12px/1.5 ui-monospace,Consolas,monospace;color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;padding:4px;resize:vertical}',
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
  // 「一类一个下拉」：平时只显示当前值（形状：矩形 ▾），点开才铺开这一类的全部选项。
  // 整行可点、左对齐、右侧一个 caret；展开体缩进一格，看起来是它的"子面板"。
  '.drawai-menu-select{display:flex;align-items:center;justify-content:space-between;width:100%;text-align:left;margin-top:8px;white-space:nowrap}',
  '.drawai-menu-select-label{overflow:hidden;text-overflow:ellipsis}',
  '.drawai-menu-caret{opacity:.7;margin-left:8px}',
  '.drawai-menu-select-body{margin:4px 0 0 10px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l1,#3a3a3a)}',
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
//
// 单位规则：**路由器自己选出来的坐标一律吸附到半格（EDGE_GRID = 5px）**，而贴着节点边框的
// 那一轴保持精确（不能为了对齐把线从边框上挪开）。于是每条线段所在的线都落在整格或半格上，
// 而不是"某个节点的中心"（56 高的节点中心在 y+28 —— 那正是自动路由线段不在格线上的来源）。
// 用户手摆的折点不碰：那是用户数据，改它就等于擅自重排别人的图。

/** 半格吸附（路由专用别名，读起来更清楚）。 */
function snapFree(value) {
  return snapTo(value, EDGE_GRID)
}

function orthoH(from, to) {
  const fcy = snapFree(from.y + from.h / 2)
  const tcy = snapFree(to.y + to.h / 2)
  const east = to.x + to.w / 2 >= from.x + from.w / 2
  const sx = east ? from.x + from.w : from.x
  const ex = east ? to.x : to.x + to.w
  const midX = snapFree((sx + ex) / 2)
  return [{ x: sx, y: fcy }, { x: midX, y: fcy }, { x: midX, y: tcy }, { x: ex, y: tcy }]
}

function orthoV(from, to) {
  const fcx = snapFree(from.x + from.w / 2)
  const tcx = snapFree(to.x + to.w / 2)
  const south = to.y + to.h / 2 >= from.y + from.h / 2
  const sy = south ? from.y + from.h : from.y
  const ey = south ? to.y : to.y + to.h
  const midY = snapFree((sy + ey) / 2)
  return [{ x: fcx, y: sy }, { x: fcx, y: midY }, { x: tcx, y: midY }, { x: tcx, y: ey }]
}

function viaY(from, to, yc) {
  const fcx = snapFree(from.x + from.w / 2)
  const tcx = snapFree(to.x + to.w / 2)
  const sy = yc < from.y + from.h / 2 ? from.y : from.y + from.h
  const ty = yc < to.y + to.h / 2 ? to.y : to.y + to.h
  return [{ x: fcx, y: sy }, { x: fcx, y: yc }, { x: tcx, y: yc }, { x: tcx, y: ty }]
}

function viaX(from, to, xc) {
  const fcy = snapFree(from.y + from.h / 2)
  const tcy = snapFree(to.y + to.h / 2)
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
 * 近似平手时允许的长度差（用户单位）。
 *
 * 为什么需要它：代价是 `{hits, bends, length}` 的字典序，而"走上面"和"走下面"两条绕行
 * 候选常常 **hits 与 bends 完全相同、长度只差几像素**。拖动节点时这两条长度每挪一步就
 * 互相反超一次 —— 于是端点每帧都在 n↔s 之间跳（实测：斜向拖 120 步，端点切换 49 次，
 * 用户看到的就是"连线自己在换端点"）。
 *
 * 有了这个容差，落在这个范围内的候选一律按**固定优先级**取（正交 → 上 → 下 → 左 → 右），
 * 于是近似平手的结果是稳定的；只有另一条**明显**更优时才会换。
 */
const ROUTE_LENGTH_SLACK = 24

/** 这条候选是否"不比最优差多少"（同一档 hits / bends，长度差在容差内）。 */
function withinSlack(cost, bestCost) {
  if (cost.hits > bestCost.hits) return false
  if (cost.bends > bestCost.bends) return false
  return cost.length <= bestCost.length + ROUTE_LENGTH_SLACK
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
/**
 * 这个点是不是"人的意图"（首尾端点或用户折点），收尾时一律不许动/不许消。
 *
 * 按**坐标**比而不是按对象身份：路由过程中会给折点生成新的点对象
 * （connectOrtho 推的是 `{x: b.x, y: b.y}`），身份比较会全部落空。
 */
function isPreservedPoint(point, preserve) {
  if (preserve === undefined || preserve === null || point === undefined || point === null) return false
  const list = preserve instanceof Set ? [...preserve] : preserve
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i]
    if (p !== null && p !== undefined && Math.abs(p.x - point.x) < 0.5 && Math.abs(p.y - point.y) < 0.5) return true
  }
  return false
}

function snapNearAxisInPath(points, preserve) {
  const out = []
  for (let i = 0; i < points.length; i += 1) {
    const p = { x: points[i].x, y: points[i].y }
    const locked = i === 0 || i === points.length - 1 || isPreservedPoint(points[i], preserve)
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
 *
 * `preserve`（用户折点）**一个都不许消**：折点会让路径"折出去又折回来"，
 * 三个点落在同一条线上，消掉中间那个等于把用户摆的那个来回整个吃掉 ——
 * 实测踩过：自环里摆一个折点，路径直接少一段，看起来像没生效。
 */
function simplifyCollinear(points) {
  /** 中间那个点能不能消：共线**且夹在两邻居之间**。
   *
   * "夹在中间"这一条是关键：折出去再折回来的那个点同样共线，但它在两邻居之外，
   * 消掉它就等于把用户摆的那个来回整段吃掉（实测：自环里摆折点，路径直接少一段）。
   * 反过来，真的落在直线中间的点必须消 —— 留着它会在同一条线上挂两个段把手；
   * 而"这条线经过用户折点"这件事并没有丢：折点仍然落在那一段**里面**。
   * （用户折点若被消，只可能是这种情况；消掉折返尖点的那一关由 removeRetraces 把关，
   * 那里对用户折点有名单保护。） */
  const isRemovable = (prev, current, next) => {
    if (prev === undefined || next === undefined) return false
    const sameX = Math.abs(prev.x - current.x) < 0.5 && Math.abs(current.x - next.x) < 0.5
    const sameY = Math.abs(prev.y - current.y) < 0.5 && Math.abs(current.y - next.y) < 0.5
    if (sameX && (current.y - prev.y) * (current.y - next.y) <= 0) return true
    if (sameY && (current.x - prev.x) * (current.x - next.x) <= 0) return true
    return false
  }
  let cur = points
  for (;;) {
    const kept = []
    for (let i = 0; i < cur.length; i += 1) {
      if (i > 0 && i < cur.length - 1 && isRemovable(cur[i - 1], cur[i], cur[i + 1])) continue
      kept.push(cur[i])
    }
    if (kept.length === cur.length) break
    cur = kept
  }
  const out = []
  for (let i = 0; i < cur.length; i += 1) {
    const current = cur[i]
    if (i > 0 && i < cur.length - 1 && isRemovable(out[out.length - 1], current, cur[i + 1])) continue
    out.push(current)
  }
  return out
}

/** 三点共线、且**方向在中间那一点掉头**（两侧方向相反）= 折返的发夹尖。
 *
 * 和 `simplifyCollinear` 的判据正好互补：那里消的是"夹在两邻居之间"的多余点，
 * 这里处理的是"伸到两邻居之外"的那个尖 —— 路径先走出去、再原路描回来。 */
function isFoldApex(a, b, c) {
  const sameX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5
  if (sameX) return (b.y - a.y) * (c.y - b.y) < 0
  const sameY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5
  if (sameY) return (b.x - a.x) * (c.x - b.x) < 0
  return false
}

/**
 * 消掉路径里的**折返段**（先折出去、再原路描回来，也就是头发夹形状）。
 *
 * 起因是真机截图：把右侧节点从右往左拖，右下角那条线变成"出去 44px 再原路回来"——
 * 同一个 y 上两段重合，`pathOf` 还会在尖点处画出一个 6px 的小鼓包，
 * 用户看到的就是"本来只有一条线段，现在画了两条"。
 *
 * 为什么该消：折返段在**可见像素上是零信息**（回程完全压在去程上，同色同宽看不出来），
 * 它带来的只有两样东西 —— 重合的线段和那个小鼓包。消法是丢掉尖点本身：
 * `a → b → c`（b 是尖点）等价于 `a → c`，去程伸出去的那一截随之不见。
 *
 * 尖点若是**人摆的折点**就绝不动（`preserve`）——那和"折点原样成为路径顶点"的约定冲突，
 * 会连带把 points[] 与路径顶点的一一对应关系弄丢（段把手会找不到折点、拖不动）。
 * 路由器自己加的桩点/拐点不在 preserve 里，正是这里要收拾的对象。
 */
function removeRetraces(points, preserve) {
  let cur = points
  for (;;) {
    const out = []
    let changed = false
    for (let i = 0; i < cur.length; i += 1) {
      const point = cur[i]
      const prev = out[out.length - 1]
      const next = cur[i + 1]
      if (prev !== undefined && next !== undefined && isFoldApex(prev, point, next) && !isPreservedPoint(point, preserve)) {
        changed = true
        continue
      }
      // 丢掉尖点后可能出现重复点（例如 a=(0,0) b=(10,0) c=(0,0)）：顺手去重。
      if (prev !== undefined && Math.abs(prev.x - point.x) < 0.5 && Math.abs(prev.y - point.y) < 0.5) continue
      out.push(point)
    }
    if (!changed) return out
    cur = out
  }
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

/**
 * 形状边框上朝向 target 的落点，连同它落在哪条边（n/s/e/w）。
 *
 * 侧的选择按 |dx| 与 |dy| 比大小；落点**原则上仍取该侧中点**（v1 的行为，别顺手改）——
 * 但有一个例外：当 target 几乎正对该侧中点（偏差 ≤ AXIS_EPS，不到半个网格）时，把落点
 * **投影**过去。
 *
 * 为什么要这个例外：真机报过"两条线段差一像素、合不成一条"。用户拖出的折点在 x=244，
 * 而侧中点算出来是 x=245，于是最后一跳凭空多出 `244→245` 的 1px 横跳，竖线上就出现一个小台阶。
 * 自动分支有中心对齐（snapNearAxis）兜着，手动分支里折点是**用户数据不许动**，这 1px 便一直留着。
 * 偏差大时不投影：那种情况下"接在侧中点"是 v1 有意的几何，改了会连带挪动几十像素。
 */
function borderPointToward(geo, target) {
  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (Math.abs(dx) >= Math.abs(dy)) {
    // 贴边那一轴（x）保持精确；垂直方向默认取侧中点，但**吸附到半格** ——
    // 否则线段会落在"节点中心"这种非格线坐标上（56 高的节点中心 = y+28）。
    const y = Math.abs(target.y - cy) <= AXIS_EPS ? target.y : snapFree(cy)
    if (dx >= 0) return { x: geo.x + geo.w, y: y, side: 'e' }
    return { x: geo.x, y: y, side: 'w' }
  }
  const x = Math.abs(target.x - cx) <= AXIS_EPS ? target.x : snapFree(cx)
  if (dy >= 0) return { x: x, y: geo.y + geo.h, side: 's' }
  return { x: x, y: geo.y, side: 'n' }
}

/**
 * 从 a 直角走到 b，把需要的新顶点推进 points，返回抵达 b 后所在的轴。
 * `axis` 是"进来时的方向"：上一段是横的就先横后竖，是竖的就先竖后横。
 *
 * 两条 L 的曼哈顿长度永远是同一个数（|dx|+|dy|），差别只在**先走哪一轴**，
 * 而这一顺序决定了会不会出现"原路折返"—— 见下面的判据。
 *
 * `next`（可选）是**这一步之后还要去的点**：用来看出另一头的折返。不传就少一条判据。
 */
function connectOrtho(points, a, b, axis, next) {
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
  const dx = b.x - a.x
  const dy = b.y - a.y
  const defaultH = Math.abs(dx) <= Math.abs(dy)

  // 但"先走长的那一轴"只知道 dx/dy 谁大，两点它都看不见：**我们从哪儿来**、**接下来去哪**。
  // 于是它会挑出一条原路折返的 L —— 出去再回来，画面上就是两段重合的线（真机报过两次）。
  // 两条 L 一样长，所以这里按"哪条的**重合段最短**"挑，完全平手才用上面的默认判据：
  const last = points.length > 0 ? points[points.length - 1] : null
  const before = points.length > 1 ? points[points.length - 2] : null
  const atLast = last !== null && Math.abs(last.x - a.x) < 0.5 && Math.abs(last.y - a.y) < 0.5
  const inHorizontal = atLast && before !== null && Math.abs(before.y - a.y) < 0.5 && Math.abs(before.x - a.x) > 0.5
  const inVertical = atLast && before !== null && Math.abs(before.x - a.x) < 0.5 && Math.abs(before.y - a.y) > 0.5

  /** 第一步压着**上一段**走回去的长度（先横先竖决定第一步走哪一轴）。 */
  const firstOverlap = (horizontalFirst) => {
    if (inHorizontal && horizontalFirst === true && dx * (a.x - before.x) < 0) {
      return Math.min(Math.abs(dx), Math.abs(a.x - before.x))
    }
    if (inVertical && horizontalFirst === false && dy * (a.y - before.y) < 0) {
      return Math.min(Math.abs(dy), Math.abs(a.y - before.y))
    }
    return 0
  }
  /** 到站方向被**下一段**立刻顶回来的长度：先横后竖时到站是竖的，先竖后横时到站是横的。
   *  只有下一段是"直的"（同轴）时才必然折返 —— 不直的时候下一段自己会按 firstOverlap 避开。 */
  const arrivalOverlap = (horizontalFirst) => {
    if (next === null || next === undefined) return 0
    const departH = Math.abs(next.y - b.y) < 0.5 && Math.abs(next.x - b.x) > 0.5
    const departV = Math.abs(next.x - b.x) < 0.5 && Math.abs(next.y - b.y) > 0.5
    if (horizontalFirst === true && departV && (next.y - b.y) * dy < 0) {
      return Math.min(Math.abs(dy), Math.abs(next.y - b.y))
    }
    if (horizontalFirst === false && departH && (next.x - b.x) * dx < 0) {
      return Math.min(Math.abs(dx), Math.abs(next.x - b.x))
    }
    return 0
  }
  // 用**长度**而不是"有没有"：两边都躲不开时，重合 24px 总好过 44px
  // （真机那条正是如此：44px 的重合压在**用户折点**上，removeRetraces 不许动它，
  //   而 24px 那条压在目标侧桩点上，顺手就被消干净了）。
  const overlapOf = (horizontalFirst) => firstOverlap(horizontalFirst) + arrivalOverlap(horizontalFirst)
  const useHorizontalFirst = overlapOf(!defaultH) < overlapOf(defaultH) ? !defaultH : defaultH
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
  // 垂直方向吸附到半格：桩点是路由的必经点，它决定首/末段所在的那条线。
  const cx = snapFree(geo.x + geo.w / 2)
  const cy = snapFree(geo.y + geo.h / 2)
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
function routeThroughWaypoints(fromBox, toBox, waypoints, obstacleBoxes, userWaypoints) {
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
    // 最后的落点先算出来（它只取决于最后一个折点）：它也是最后一个折点的"下一站"，
    // 传给 connectOrtho 用于判断"到站方向会不会被下一段顶回来"。
    const end = borderPointToward(toBox.geo, safe[safe.length - 1])
    for (let i = 0; i < safe.length; i += 1) {
      const next = i + 1 < safe.length ? safe[i + 1] : end
      axis = connectOrtho(pts, prev, safe[i], axis, next)
      prev = safe[i]
    }
    // 落点在左右边 → 最后一段要横着进 → 先竖后横，所以传 'v'；上下边反之。
    const approach = end.side === 'e' || end.side === 'w' ? 'v' : 'h'
    connectOrtho(pts, prev, end, approach)
    return pts
  }

  const start = borderPointToward(fromBox.geo, safe[0])
  // `keep` 只装**人摆的折点**（不含路由器加的桩点）：折返的发夹尖要能消，
  // 但尖点若是用户折点就必须留着 —— 见 removeRetraces 的注释。
  const keep = Array.isArray(userWaypoints) ? keepOf(safe, userWaypoints) : safe
  return finalizePath(build(start), safe, keep)
}

/** 从 safe（已推出的折点序列，含桩点）里挑出"对应人摆的那些点"。
 *
 * 按**坐标**配对而不是按下标：桩点与折点在 chain 里混在一起，下标要另算一遍首尾桩点个数，
 * 而坐标配对在 chainForRoute 把用户折点原样搬进 chain 之后是精确的。 */
function keepOf(safe, userWaypoints) {
  const keep = []
  for (let i = 0; i < safe.length; i += 1) {
    for (let j = 0; j < userWaypoints.length; j += 1) {
      if (Math.abs(safe[i].x - userWaypoints[j].x) < 0.5 && Math.abs(safe[i].y - userWaypoints[j].y) < 0.5) {
        keep.push(safe[i])
        break
      }
    }
  }
  return keep
}

/**
 * 收尾：保折点与两端落点、消 1.5px 台阶、消折返、去共线冗余。
 *
 * `snapWaypoints`（含引出桩点）只用于**防吸附**：桩点是路由的必经点，不该被对齐挪走。
 * `keepPoints` 是**折返消不掉**的保护名单（人摆的折点），不传就退回 snapWaypoints。
 */
function finalizePath(pts, snapWaypoints, keepPoints) {
  const snapList = Array.isArray(snapWaypoints) ? snapWaypoints : []
  const keepList = keepPoints === undefined || keepPoints === null ? snapList : keepPoints
  const forSnap = new Set()
  forSnap.add(pts[0])
  forSnap.add(pts[pts.length - 1])
  for (let i = 0; i < snapList.length; i += 1) forSnap.add(snapList[i])
  // 最后收一次共线冗余：路径里的桩点常常是共线的
  // （比如"+24px 的引出桩点"和"真正落点"在同一竖直线上）。
  // 不收的话，路径上会多出不在 points[] 里的顶点 ——
  //   · 渲染出来的段比预览多，同一条线上又能挂两个把手；
  //   · ensurePinned 用 pathIndexOf 在 points 里找路径顶点，找不到就返回 -1，
  //     拖动那一段会直接没反应（"点了段把手不动"）。
  // 折返要在共线化简**之前**消：消掉发夹尖之后，旁边那两点往往就共线了。
  // keepList 只喂给 removeRetraces —— 共线化简那遍**故意不吃保护名单**：
  // 用户折点若变成"夹在一条直线中间"的点，消掉它不改变画面（线照样经过它），
  // 而且下一次手势的 prunePoints 会把这条已经没有几何意义的折点从文档里清掉；
  // 反过来留着它，就会在一条直线上多挂一个段把手（见 simplifyCollinear 的注释）。
  return simplifyCollinear(removeRetraces(dedupePoints(snapNearAxisInPath(pts, forSnap)), keepList))
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
/**
 * 顺时针的下一个侧。
 *
 * 自环的进出口**不能是同一个侧**：从一边出去又原路回来，线会原地折返、看起来什么都没有
 * （drawio 也不允许同侧自环，它会自动换一个侧）。
 */
function nextSideOf(side) {
  const order = ['e', 's', 'w', 'n']
  const at = order.indexOf(side)
  return order[(at < 0 ? 0 : at + 1) % order.length]
}

/** 盒子某一侧**边框上**的接入点：切向坐标吸附半格，贴边那一轴保持精确。 */
function sideBorderPoint(geo, side) {
  const cx = snapFree(geo.x + geo.w / 2)
  const cy = snapFree(geo.y + geo.h / 2)
  if (side === 'n') return { x: cx, y: geo.y }
  if (side === 's') return { x: cx, y: geo.y + geo.h }
  if (side === 'w') return { x: geo.x, y: cy }
  return { x: geo.x + geo.w, y: cy }
}

/** 侧的法线是横的还是竖的（决定它外推出来的那个坐标能不能当拐点用）。*/
function sideIsHorizontal(side) {
  return side === 'e' || side === 'w'
}

/**
 * 自环：从 source 侧出去、绕到 target 侧回来。
 *
 * 与普通边的区别只在**中间怎么绕**：两个端点桩点都在同一个盒子外面，
 * 所以拐点必须取"两个外推坐标"的组合 —— 直接连 s.x/t.y 会在某些侧对上穿进盒子里
 * （例如 n → e 时 s.x 还在盒子宽度以内）。判据：
 *   · 一个侧的法线是横的（e/w）→ 它的桩点 x 在盒子外，可以当拐点的 x；
 *   · 另一个侧的法线是竖的（n/s）→ 它的桩点 y 在盒子外，可以当拐点的 y。
 * 两侧相对（e/w 或 n/s）时没有这种组合，就从盒子上下（或左右）绕一圈过去。
 *
 * 用户摆过折点（`waypoints`）时不走这条固定形状：老老实实穿过去 —— 与普通边同一套规则，
 * 人摆的永远优先。
 */
function selfLoopPath(geo, sourceSide, targetSide, jetty, waypoints) {
  const source = typeof sourceSide === 'string' && sourceSide.length > 0 ? sourceSide : 'e'
  let target = typeof targetSide === 'string' && targetSide.length > 0 ? targetSide : nextSideOf(source)
  if (target === source) target = nextSideOf(source)
  // 环的"外扩"距离：文档里的 jettySize，缺省 35（配合半格吸附）。
  const inset = snapFree(Number.isFinite(jetty) && jetty > 0 ? jetty : 35)
  const p0 = sideBorderPoint(geo, source)
  const p1 = sideBorderPoint(geo, target)
  const s = stubPointFor(geo, source, inset)
  const t = stubPointFor(geo, target, inset)
  const chain = Array.isArray(waypoints) ? waypoints : []
  const pts = [p0, s]

  if (chain.length > 0) {
    let prev = s
    let axis = axisToward(geo, chain[0])
    for (let i = 0; i < chain.length; i += 1) {
      const next = i + 1 < chain.length ? chain[i + 1] : t
      axis = connectOrtho(pts, prev, chain[i], axis, next)
      prev = chain[i]
    }
    connectOrtho(pts, prev, t, axis)
  } else if (sideIsHorizontal(source) !== sideIsHorizontal(target)) {
    // 垂直的一对（例如 e → s）：拐点 = 横向那个侧的桩点 x + 纵向那个侧的桩点 y。
    const horizontal = sideIsHorizontal(source) ? s : t
    const vertical = sideIsHorizontal(source) ? t : s
    pts.push({ x: horizontal.x, y: vertical.y })
  } else if (sideIsHorizontal(source)) {
    // 相对的左右两侧：从盒子上下绕过去（e → w 走上边，w → e 走下边）。
    const viaY = source === 'e' ? geo.y - inset : geo.y + geo.h + inset
    pts.push({ x: s.x, y: viaY })
    pts.push({ x: t.x, y: viaY })
  } else {
    // 相对的上下两侧：从盒子左右绕过去（n → s 走右边，s → n 走左边）。
    const viaX = source === 'n' ? geo.x + geo.w + inset : geo.x - inset
    pts.push({ x: viaX, y: s.y })
    pts.push({ x: viaX, y: t.y })
  }
  pts.push(t)
  pts.push(p1)
  // 折点、两个接入点都要保住（finalizePath 只做去共线、消台阶与消折返）。
  // 自环的桩点不在 chain 里，所以折返那一遍可以收拾到它、却动不了用户的折点。
  return finalizePath(pts, chain, chain)
}

/** 某个点是否正好落在盒子某一侧的**中点**上（容差 0.6）。 */
function isSideMidpoint(geo, point) {
  for (let i = 0; i < SIDES.length; i += 1) {
    const mid = sideBorderPoint(geo, SIDES[i])
    if (Math.abs(mid.x - point.x) < 0.6 && Math.abs(mid.y - point.y) < 0.6) return true
  }
  return false
}

/** 一条路径的两端是否都落在**侧的中点**上。 */
function hasMidpointEnds(points, fromGeo, toGeo) {
  if (points.length < 2) return false
  return isSideMidpoint(fromGeo, points[0]) && isSideMidpoint(toGeo, points[points.length - 1])
}

/**
 * 自动路由的候选集合（手动路径与自环不走这里）。
 *
 * 抽出来是为了**能被断言与调试**：端点抖动到底是哪两条候选在抢，看候选表最直接
 * （之前只能靠猜，猜错过两次）。
 */
function routeCandidates(fromBox, toBox) {
  const axis = snapNearAxis(fromBox.geo, toBox.geo)
  const candFrom = axis.from
  const candTo = axis.to
  const top = snapFree(Math.min(candFrom.y, candTo.y) - 60)
  const bottom = snapFree(Math.max(candFrom.y + candFrom.h, candTo.y + candTo.h) + 60)
  const left = snapFree(Math.min(candFrom.x, candTo.x) - 60)
  const right = snapFree(Math.max(candFrom.x + candFrom.w, candTo.x + candTo.w) + 60)
  return [
    { name: 'orthoH', points: orthoH(candFrom, candTo) },
    { name: 'orthoV', points: orthoV(candFrom, candTo) },
    { name: 'above', points: viaY(candFrom, candTo, top) },
    { name: 'below', points: viaY(candFrom, candTo, bottom) },
    { name: 'left', points: viaX(candFrom, candTo, left) },
    { name: 'right', points: viaX(candFrom, candTo, right) },
  ]
}

/**
 * 从候选里挑一条。纯函数 —— 抽出来是为了能断言"这一步为什么换侧"，
 * 也因为这段判据连续踩过两次坑（近似平手来回抢、落点风格不一致）。
 *
 * 顺序：
 *   1. 先按代价找出最优（hits → bends → length）；
 *   2. 在"不比最优差多少"（withinSlack）的候选里，优先**两端都落在侧中点**的那条 ——
 *      我们的四个端点圆点、exitX/exitY 的语义都指中点；滑动的落点与它们不一致时，
 *      两者代价接近就会来回抢；
 *   3. 仍没有就退回按优先级取第一条 withinSlack 的（固定优先级 = 稳定）。
 *
 * @returns { index, bestIndex, costs }
 */
function pickCandidate(candidates, boxes, skip, fromGeo, toGeo) {
  const costs = candidates.map((pts) => pathCost(pts, boxes, skip))
  let bestIndex = 0
  for (let i = 1; i < costs.length; i += 1) if (pathCostBetter(costs[i], costs[bestIndex])) bestIndex = i
  const bestCost = costs[bestIndex]
  let pick = -1
  for (let i = 0; i < candidates.length; i += 1) {
    if (!withinSlack(costs[i], bestCost)) continue
    if (!hasMidpointEnds(candidates[i], fromGeo, toGeo)) continue
    pick = i
    break
  }
  if (pick < 0) {
    for (let i = 0; i < candidates.length; i += 1) {
      if (!withinSlack(costs[i], bestCost)) continue
      pick = i
      break
    }
  }
  return { index: pick < 0 ? bestIndex : pick, bestIndex: bestIndex, costs: costs }
}

/**
 * 新选择要**连续稳定**这么多帧才被采纳（见 applyRouteHysteresis）。
 *
 * 取 3：一次拖动每帧挪几个像素，3 帧 ≈ 几十毫秒 —— 用户察觉不到延迟，
 * 而避让边界上那种"一两帧的合法窗口"会被它滤掉。
 */
const ROUTE_SETTLE_FRAMES = 3

/**
 * 路由迟滞：**端点侧不能一帧一变**。
 *
 * 实测的病：拖动节点时，直连路线的合法性会在避让边界（8px 余量）上反复翻转 ——
 * 穿过一个节点 → 干净 → 又穿过另一个 → 又干净。于是路由在"绕上面"和"直连"之间来回切，
 * 端点侧跟着 `n→n` ↔ `e→w` 跳，用户看到的就是"连线自己换端点"（120 步里跳 4 次）。
 *
 * 这类抖动只有迟滞能治：
 *   · 记着的那条**只要还合法**（不穿模、拐弯数不比最优多）就先用它；
 *   · 想换，必须新选择连续 `ROUTE_SETTLE_FRAMES` 帧都是最优 —— 一两帧的窗口换不动它；
 *   · 记着的那条一旦**不合法**（开始穿模），立刻换，安全优先。
 *
 * 没有 memory 时（自测、一次性路由）行为与以前完全一致。
 *
 * @param hint { memory, key } —— memory 是 Map，key 是边 id
 */
function applyRouteHysteresis(candidates, picked, hint) {
  const memory = hint === undefined || hint === null ? undefined : hint.memory
  const key = hint === undefined || hint === null || typeof hint.key !== 'string' ? null : hint.key
  if (memory === undefined || memory === null || key === null) return picked.index
  const bestCost = picked.costs[picked.bestIndex]
  const remembered = memory.get(key)
  let keepIndex = -1
  if (remembered !== undefined && remembered !== null && typeof remembered.pick === 'string') {
    for (let i = 0; i < candidates.length; i += 1) {
      if (candidates[i].name === remembered.pick) {
        keepIndex = i
        break
      }
    }
  }
  if (keepIndex >= 0) {
    const cost = picked.costs[keepIndex]
    const legal = cost.hits <= bestCost.hits && cost.bends <= bestCost.bends
    if (!legal) keepIndex = -1
  }
  const desiredName = candidates[picked.index].name
  if (keepIndex >= 0 && keepIndex !== picked.index) {
    const pending = remembered.pending === desiredName ? remembered.pendingCount + 1 : 1
    if (pending < ROUTE_SETTLE_FRAMES) {
      memory.set(key, { pick: remembered.pick, pending: desiredName, pendingCount: pending })
      return keepIndex
    }
    memory.set(key, { pick: desiredName, pending: null, pendingCount: 0 })
    return picked.index
  }
  memory.set(key, { pick: desiredName, pending: null, pendingCount: 0 })
  return picked.index
}

function routeEdge(fromBox, toBox, boxes, bounds, waypoints, sides, straight, hint) {
  // 入参是 box（{ id, node, geo, label }），几何在 .geo 上。
  // 这里曾经直接读 from.x / from.y —— box 上没有这些字段，于是 NaN 一路传染：
  // 连线 d="M NaN NaN" 被浏览器丢弃（边全部消失），边标签 x="NaN" 被忽略（全部塌到原点重叠）。
  // pathCost 用的是 box.geo（对的），所以这个函数一半对一半错，看着像没问题。
  const from = fromBox.geo
  const to = toBox.geo
  if (fromBox.id === toBox.id) {
    // 自环：出边/回边的侧来自文档（exitX/exitY 与 entryX/entryY），没写就东出南下。
    const seed = sides === undefined || sides === null ? null : sides
    return selfLoopPath(from, seed === null ? null : seed.source, seed === null ? null : seed.target, seed === null ? null : seed.jetty, waypoints)
  }
  // 有端点约束或有用户折点 → 手动：逐个穿过必经点，人摆的优先级高于算法。
  const chain = chainForRoute(fromBox, toBox, waypoints, sides)
  if (chain.length > 0) {
    return routeThroughWaypoints(fromBox, toBox, chain, boxes, Array.isArray(waypoints) ? waypoints : [])
  }
  // edgeStyle=none = 直线（drawio 的语义）：两端各取朝向对方的边框点，中间一条直线。
  if (straight === true) {
    const a = borderPointToward(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 })
    const b = borderPointToward(to, { x: a.x, y: a.y })
    return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]
  }
  void bounds
  const skip = {}
  skip[fromBox.id] = true
  skip[toBox.id] = true
  const raw = routeCandidates(fromBox, toBox)
  const picked = pickCandidate(
    raw.map((c) => c.points),
    boxes,
    skip,
    fromBox.geo,
    toBox.geo,
  )
  const index = applyRouteHysteresis(raw, picked, hint)
  // 自动候选理论上不会折返，这里照样过一遍：折返在画面上只有坏处（重合线 + 尖点鼓包），
  // 而"每条边上都没有折返"是能在自测里断言的硬不变量。
  return simplifyCollinear(removeRetraces(dedupePoints(raw[index].points)))
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

/**
 * 折线 → SVG path。
 *
 * `curved` 走 drawio 的 `mxPolyline.paintCurvedLine`（curved=1）：从起点出发，每个中间点
 * 作为**二次曲线的控制点**、收在下一点与它的中点，最后一段收在终点上 —— 于是整条线是平滑
 * 的曲线而不是硬拐角。注意 drawio 里 curved 与 rounded 是**互斥**的（painCurvedLine 优先），
 * 所以这里 curved 时不带圆角半径。
 * 两点 + curved：控制点落在起点上 → 退化成直线（与 drawio 完全一致，不会凭空鼓起来）。
 */
function pathOf(rawPoints, radius, curved) {
  const pts = []
  for (let i = 0; i < rawPoints.length; i += 1) {
    const p = rawPoints[i]
    const last = pts[pts.length - 1]
    if (last !== undefined && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue
    pts.push(p)
  }
  if (pts.length < 2) return ''
  if (curved === true) {
    const parts = ['M ' + fmt(pts[0].x) + ' ' + fmt(pts[0].y)]
    for (let i = 1; i < pts.length - 2; i += 1) {
      const p0 = pts[i]
      const p1 = pts[i + 1]
      parts.push('Q ' + fmt(p0.x) + ' ' + fmt(p0.y) + ' ' + fmt((p0.x + p1.x) / 2) + ' ' + fmt((p0.y + p1.y) / 2))
    }
    const p0 = pts[pts.length - 2]
    const p1 = pts[pts.length - 1]
    parts.push('Q ' + fmt(p0.x) + ' ' + fmt(p0.y) + ' ' + fmt(p1.x) + ' ' + fmt(p1.y))
    return parts.join(' ')
  }
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
  // 独立文字：**不画任何边框/底色**，只留一个透明命中框。
  // 为什么还要那个 rect：节点组靠子元素的命中测试接收指针事件（形状 + 标签同组），
  // 而标签是 pointerEvents:none 的 —— 少了它，文字元素点不到、拖不动、也双击不了。
  // `fill="transparent"` 在 SVG 里是"有填充但全透明"，照样参与命中测试；
  // 导出 SVG 时它也是不可见的（不是 `fill="none"` —— 那个不参与命中测试）。
  if (shape === 'text') {
    return React.createElement('rect', { x: x, y: y, width: w, height: h, fill: 'transparent', stroke: 'none', pointerEvents: 'all' })
  }
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
    const w = numberOr(n.w, FALLBACK_NODE_W)
    const h = numberOr(n.h, FALLBACK_NODE_H)
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

/**
 * 字号档位（菜单里可点的那几个；「默认」不在表里，它等于删掉 fontSize 键）。
 * 落盘是 drawio 的 `fontSize`，所以档位只是 UI 的便利值，不限制用户/AI 写别的数。
 */
const FONT_SIZE_PRESETS = [10, 12, 14, 18, 24]

/** 元素库：draw.io 那套形状词汇的可用子集。 */
const SHAPE_LIBRARY = [
  { shape: 'rect', label: '矩形' },
  { shape: 'rounded', label: '圆角矩形' },
  { shape: 'text', label: '文字' },
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

/**
 * 菜单里"当前值"要用到的几个中文名。与选项行用的是**同一份表**（下面那些 row 也读它），
 * 所以"当前值显示什么"和"下拉里有什么"不会各说一套。
 */
const PALETTE_LABELS = { plain: '默认', blue: '蓝', green: '绿', orange: '橙', yellow: '黄', red: '红', purple: '紫', grey: '灰' }
const LINE_KIND_LABELS = { straight: '直线', sharp: '直角折线', rounded: '圆角折线', curved: '曲线' }
const DASH_LABELS = { solid: '实线', dashed: '虚线', dotted: '点线' }
const ARROW_LABELS = { end: '→ 单向', both: '↔ 双向', none: '— 无箭头', start: '← 反向' }

/**
 * 右键菜单里每一类的**当前值**文字。
 *
 * 菜单不再把每一类的全部选项铺出来（形状 10 个缩略图 + 配色 8 个色块 + 字号 6 个 +
 * 线型 4 个 + 样式 3 个 + 箭头 4 个 —— 一屏全是按钮），改成"一类一行、只显示当前值 ▾"，
 * 点开才铺选项。这里只负责算那行文字：纯函数，能被命令行自测直接断言。
 *
 * @param {string} style 节点的或连线的 style 串
 * @param {string} kind 'shape' | 'color' | 'fontSize' | 'line' | 'dash' | 'arrow'
 */
function styleSummary(style, kind) {
  const s = typeof style === 'string' ? style : ''
  if (kind === 'shape') {
    const shape = nodeShapeFromStyle(s)
    for (let i = 0; i < SHAPE_LIBRARY.length; i += 1) if (SHAPE_LIBRARY[i].shape === shape) return SHAPE_LIBRARY[i].label
    return shape
  }
  if (kind === 'color') {
    // 独立文字没有填充/描边：它的"配色"就是字色（见 styleWithTextColorName）。
    const isText = nodeShapeFromStyle(s) === 'text'
    const name = isText ? textColorNameFromStyle(s) : colorNameFromStyle(s)
    if (name !== null) return PALETTE_LABELS[name] === undefined ? name : PALETTE_LABELS[name]
    // 认不出的颜色（drawio 文件里本来就只有十六进制）：把那个值原样给人看，别显示"未知"。
    const hex = isText ? styleGet(s, 'fontColor', null) : styleGet(s, 'fillColor', null) !== null ? styleGet(s, 'fillColor', null) : styleGet(s, 'strokeColor', null)
    return hex === null ? '默认' : String(hex)
  }
  if (kind === 'fontSize') {
    const n = styleNumber(s, 'fontSize', null)
    return n === null ? '默认' : String(n)
  }
  if (kind === 'line') return LINE_KIND_LABELS[lineKindFromStyle(s)]
  if (kind === 'dash') return DASH_LABELS[dashFromStyle(s)]
  if (kind === 'arrow') return ARROW_LABELS[arrowFromStyle(s)]
  return ''
}

/**
 * 从节点集合算出 box / 索引 / 包围盒。渲染与命中都走它，避免两处算法漂移。
 *
 * **隐藏图层的节点不进来** —— 这里是"什么可见"的唯一咽喉：渲染、命中（`hitNodeAt`）、
 * 框选、路由障碍全都读它，于是"隐藏一层"在这些地方自动一致（不会出现
 * "看不见却能点到/线还绕着它走"）。 */
function buildGeometry(doc) {
  const hidden = hiddenLayerIds(doc)
  const boxes = []
  const byId = {}
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    if (isHiddenCell(hidden, n)) continue
    const geo = { x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, FALLBACK_NODE_W), h: numberOr(n.h, FALLBACK_NODE_H) }
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
 * 隐藏的图层 id 集合：**渲染、命中、框选、对齐候选**都拿它判断"这一层现在看不见"。
 *
 * 隐藏是**文档里的属性**（drawio 就写在图层单元上：`visible="0"`），不是客户端本地开关 ——
 * 于是它会被保存、能被 drawio 看见、也进撤销历史。这里只把它翻成便于查的集合。
 */
function hiddenLayerIds(doc) {
  const set = new Set()
  const layers = doc === null || doc === undefined || Array.isArray(doc.layers) === false ? [] : doc.layers
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i]
    if (layer !== null && layer !== undefined && typeof layer.id === 'string' && layer.visible === false) set.add(layer.id)
  }
  return set
}

/** 这个单元属于的层是不是隐藏的（没有层信息 = 可见）。 */
function isHiddenCell(hidden, cell) {
  return cell !== null && cell !== undefined && typeof cell.layer === 'string' && hidden.has(cell.layer)
}

/** 图层名（没名字的用"第 N 层"兜底，与 drawio 的面板一致：它也只显示空名字）。 */
function layerLabelOf(layer, index) {
  if (layer === null || layer === undefined) return ''
  const name = typeof layer.name === 'string' ? layer.name : ''
  return name.length > 0 ? name : '第 ' + (index + 1) + ' 层'
}

/** 新的图层 id：`L<n>`，避开文档里已经用掉的 id（节点/连线/图层都算）。 */
function nextLayerIdOf(doc) {
  const used = new Set()
  const layers = doc !== null && doc !== undefined && Array.isArray(doc.layers) ? doc.layers : []
  const nodes = doc !== null && doc !== undefined && Array.isArray(doc.nodes) ? doc.nodes : []
  const edges = doc !== null && doc !== undefined && Array.isArray(doc.edges) ? doc.edges : []
  for (const l of layers) if (l !== null && l !== undefined) used.add(String(l.id))
  for (const n of nodes) if (n !== null && n !== undefined) used.add(String(n.id))
  for (const e of edges) if (e !== null && e !== undefined) used.add(String(e.id))
  let n = layers.length + 1
  while (used.has('L' + n)) n += 1
  return 'L' + n
}

/**
 * 选区拖动的**统一位移**：整个选区用同一个 (dx, dy)，相对位置就完全不变。
 *
 * 吸附只做一次 —— 拿"抓起来的那个节点"当基准：它的落点吸到整格，其余成员跟着同一个位移
 * （所以第二、第三个节点保持它们之间原有的错位，不会被各自吸到同一格上叠起来；
 * 以前正是逐点各自 snap，实测"两个差 3px 的节点一拖就重合"）。
 * 选区里没有节点时（只拖连线）按半格吸附 —— 与折点、自由端点同一套单位。
 */
/**
 * 右键菜单里的"样式类"操作该作用于谁：**右键点中的那个若在选区里，就整组生效**。
 *
 * 以前无条件只改 `menu.id` —— 于是框选一片之后想统一换色只能一个个点。
 * 删除、拖动、复制、对齐早就是整组生效的，样式没跟上很不一致。
 * 只挑**同类型**的（节点菜单不动连线，反之亦然）。
 */
function styleTargets(selectedIds, clickedId, isNode) {
  const ids = Array.isArray(selectedIds) ? selectedIds : []
  if (ids.indexOf(clickedId) < 0) return [clickedId]
  const out = []
  for (let i = 0; i < ids.length; i += 1) if (isNode(ids[i]) === true) out.push(ids[i])
  return out.length > 0 ? out : [clickedId]
}

/**
 * 全选（Ctrl+A，也是「编辑 → 全选」）：节点与连线都选上 —— 与框选同一套语义
 * （框到线也算选中），所以"全选"之后能整体拖动、整体换样式、Delete 一把清掉。
 */
function allIdsOf(doc) {
  const out = []
  if (doc === null || doc === undefined) return out
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  const edges = Array.isArray(doc.edges) ? doc.edges : []
  for (let i = 0; i < nodes.length; i += 1) out.push(nodes[i].id)
  for (let i = 0; i < edges.length; i += 1) out.push(edges[i].id)
  return out
}

/**
 * 拖动时的**对齐辅助线**（drawio 的 guides）：与其它节点的 左/中/右、上/中/下 六条线比，
 * 差在容差内就吸过去，并把那条线画出来。
 *
 * @param boxes 其它节点（**不含正在拖的那些**）的 {id,x,y,w,h}
 * @param box   正在拖的**选区外接框**（不是单个节点：整组拖动时以组为准，与 drawio 一致）
 * @returns { dx, dy, guides: [{ axis:'x'|'y', at, from, to }] }
 */
function alignGuidesFor(boxes, box, tolerance) {
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 6
  const mine = {
    x: [box.x, box.x + box.w / 2, box.x + box.w],
    y: [box.y, box.y + box.h / 2, box.y + box.h],
  }
  const best = { x: null, y: null }
  for (let i = 0; i < boxes.length; i += 1) {
    const other = boxes[i]
    const theirs = {
      x: [other.x, other.x + other.w / 2, other.x + other.w],
      y: [other.y, other.y + other.h / 2, other.y + other.h],
    }
    const axisKeys = ['x', 'y']
    for (let a = 0; a < axisKeys.length; a += 1) {
      const axis = axisKeys[a]
      for (let m = 0; m < 3; m += 1) {
        for (let t = 0; t < 3; t += 1) {
          const delta = theirs[axis][t] - mine[axis][m]
          if (Math.abs(delta) > tol) continue
          const current = best[axis]
          if (current === null || Math.abs(delta) < Math.abs(current.delta)) {
            best[axis] = { delta: delta, at: theirs[axis][t], other: other }
          }
        }
      }
    }
  }
  const guides = []
  const dx = best.x === null ? 0 : best.x.delta
  const dy = best.y === null ? 0 : best.y.delta
  if (best.x !== null) {
    const other = best.x.other
    guides.push({
      axis: 'x',
      at: best.x.at,
      from: Math.min(box.y + dy, other.y),
      to: Math.max(box.y + box.h + dy, other.y + other.h),
    })
  }
  if (best.y !== null) {
    const other = best.y.other
    guides.push({
      axis: 'y',
      at: best.y.at,
      from: Math.min(box.x + dx, other.x),
      to: Math.max(box.x + box.w + dx, other.x + other.w),
    })
  }
  return { dx: dx, dy: dy, guides: guides }
}

/** 一组节点的外接框（整组拖动时对齐辅助线以组为准；空集合返回 null）。 */
function boxOfBoxes(items) {
  if (Array.isArray(items) === false || items.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]
    if (it.x < minX) minX = it.x
    if (it.y < minY) minY = it.y
    if (it.x + it.w > maxX) maxX = it.x + it.w
    if (it.y + it.h > maxY) maxY = it.y + it.h
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function dragMoveOf(drag, point) {
  const dx = point.x - drag.originX
  const dy = point.y - drag.originY
  const unit = drag.hasNodes === true ? GRID : EDGE_GRID
  if (drag.ref === undefined || drag.ref === null) return { x: snapTo(dx, unit), y: snapTo(dy, unit) }
  return { x: snapTo(drag.ref.x + dx, unit) - drag.ref.x, y: snapTo(drag.ref.y + dy, unit) - drag.ref.y }
}

/** 选中集合位移后的几何：节点坐标 + 连线自己的那部分几何（折点、自由端点）。
 *
 * 纯函数：组件只负责把它写回文档，自测可以直接断言"相对位置没变"。
 */
function draggedGeometry(drag, move) {
  const nodes = drag.starts.map((s) => ({ id: s.id, x: s.x + move.x, y: s.y + move.y }))
  const edges = []
  for (let i = 0; i < drag.edgeStarts.length; i += 1) {
    const e = drag.edgeStarts[i]
    edges.push({
      id: e.id,
      points: e.points === null || e.points === undefined ? null : e.points.map((p) => ({ x: p.x + move.x, y: p.y + move.y })),
      sourcePoint: e.sourcePoint === null || e.sourcePoint === undefined ? null : { x: e.sourcePoint.x + move.x, y: e.sourcePoint.y + move.y },
      targetPoint: e.targetPoint === null || e.targetPoint === undefined ? null : { x: e.targetPoint.x + move.x, y: e.targetPoint.y + move.y },
    })
  }
  return { nodes: nodes, edges: edges }
}

/**
 * 框选命中：与矩形相交的**节点** + 与矩形相交的**连线**。
 *
 * 连线按**段**判定（不是拿整条边的外接矩形去比）：我们的路径每段都是横/竖的，
 * 段的外接矩形就是它自己，所以"框到线才算选中"是精确的 —— 用整条边的外接框会把
 * 绕了大弯的边在离得很远的地方也选中（drawio 用的 cell state 外接框正是这个毛病）。
 *
 * 抽成纯函数是为了能被断言：之前它只收节点，框住一排线时**一条都不亮**，
 * 用户报的"批量框选时线段也应该有被选中的提示"就是这个。
 */
function marqueeHits(doc, rect, memory) {
  const hits = []
  if (doc === null || doc === undefined) return hits
  const hidden = hiddenLayerIds(doc)
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]
    if (isHiddenCell(hidden, n)) continue
    const x = numberOr(n.x, 0)
    const y = numberOr(n.y, 0)
    const w = numberOr(n.w, FALLBACK_NODE_W)
    const h = numberOr(n.h, FALLBACK_NODE_H)
    if (x < rect.x + rect.w && x + w > rect.x && y < rect.y + rect.h && y + h > rect.y) hits.push(n.id)
  }
  const edges = Array.isArray(doc.edges) ? doc.edges : []
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]
    if (isHiddenCell(hidden, edge)) continue
    const pts = edgeRoutePoints(doc, edge, memory)
    if (pts === null || pts.length < 2) continue
    for (let s = 0; s < pts.length - 1; s += 1) {
      if (segmentHitsBox(pts[s], pts[s + 1], rect, 0)) {
        hits.push(edge.id)
        break
      }
    }
  }
  return hits
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
    targets.push({ id: n.id, x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, FALLBACK_NODE_W), h: numberOr(n.h, FALLBACK_NODE_H) })
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
  // 垂直方向取半格：端点圆点要与路由实际接入的位置重合（否则会看到"线接在圆点旁边"）。
  const cx = snapFree(geo.x + geo.w / 2)
  const cy = snapFree(geo.y + geo.h / 2)
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

/** 渲染期构造路由迟滞的 hint（memory 挂在 ui 上，同一次渲染里所有边共用一份）。 */
function edgeRouteHint(ui, edge) {
  const memory = ui === undefined || ui === null ? undefined : ui.routeMemory
  if (memory === undefined || memory === null) return undefined
  return { memory: memory, key: String(edge.id) }
}

/**
 * 一条边当前的折线路径（渲染、命中、定位、段把手都用它）。
 *
 * `memory`（可选）是路由迟滞用的 Map：同一张画布上，**渲染与命中必须传同一个** ——
 * 否则迟滞期间"画出来的线"和"点得到的线"会是两条不同的路。
 */
function edgeRoutePoints(doc, edge, memory) {
  const geometry = buildGeometry(doc)
  const from = endpointBoxOf(geometry.byId, edge, 'source')
  const to = endpointBoxOf(geometry.byId, edge, 'target')
  if (from === null || to === null) return null
  const hint = memory === undefined || memory === null ? undefined : { memory: memory, key: String(edge.id) }
  return routeEdgeStyled(from, to, geometry.boxes, geometry.bounds, edge, hint)
}

/**
 * 按一条边的 style 路由：折点、端点约束（`exitX/exitY` 与 `entryX/entryY`）、以及"是不是直线"
 * （`edgeStyle=none`）统统从文档的 style 键读。渲染、命中、标签定位、预览全走它 ——
 * 一条边在哪儿只有一个答案。
 */
function routeEdgeStyled(fromBox, toBox, boxes, bounds, edge, hint) {
  const style = typeof edge.style === 'string' ? edge.style : DEFAULT_EDGE_STYLE
  return routeEdge(fromBox, toBox, boxes, bounds, edge.points, sidesFromStyle(style), !isOrthogonalEdgeStyle(style), hint)
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

/** 以 unit 为单位的吸附（节点用 GRID = 整格，连线用 EDGE_GRID = 半格）。 */
function snapTo(value, unit) {
  return Math.round(value / unit) * unit
}

/** 节点尺寸下限：都取**整格**（60 = 6 格、40 = 4 格）。原来的 minH=36 不是整格，
 *  一旦撞上下限就会把"尺寸是整格"这条不变量破坏掉。 */
const MIN_NODE_W = GRID * 6
const MIN_NODE_H = GRID * 4

/**
 * 缩放的结果盒子：**最小单位是一格**，被拖的那条边按 GRID 吸附，对边原地不动。
 *
 * 为什么吸附"尺寸"而不是"增量"：文档里的宽度可能是 186 这种非整格值（估宽 / 导入 / 手写），
 * 只吸附增量会永远把那个零头带着走（186 → 196 → 206…），中心也就永远落在半像素上 ——
 * 那正是"两条线段差一像素合不成一条"的上游来源。尺寸吸附之后，只要对边在格线上，
 * 四条边与长宽就都是整格。
 *
 * 抽成模块级纯函数是为了能被命令行自测直接断言：吸附规则很容易被后续改动悄悄破坏。
 */
function resizeBox(base, dir, rawDx, rawDy) {
  const east = base.x + base.w
  const south = base.y + base.h
  let x = base.x
  let y = base.y
  let w = base.w
  let h = base.h
  if (dir.indexOf('e') >= 0) w = Math.max(MIN_NODE_W, snapTo(base.w + rawDx, GRID))
  if (dir.indexOf('s') >= 0) h = Math.max(MIN_NODE_H, snapTo(base.h + rawDy, GRID))
  if (dir.indexOf('w') >= 0) {
    w = Math.max(MIN_NODE_W, snapTo(base.w - rawDx, GRID))
    x = east - w
  }
  if (dir.indexOf('n') >= 0) {
    h = Math.max(MIN_NODE_H, snapTo(base.h - rawDy, GRID))
    y = south - h
  }
  return { x: x, y: y, w: w, h: h }
}

/**
 * 拖折点段时的**统一位移**：只在垂直于线段的那一轴上生效，且让**参考点落在半格上**。
 *
 * 为什么是"统一位移"而不是"逐点各自吸附"：几乎水平的段（两端 y 差 0.5px 以内）如果逐点吸附，
 * 两点可能落到不同的 5px 刻度上 —— 段就凭空多出一个 5px 的倾斜。
 * 用同一个位移，段的形状原样保留，只是整体按半格挪动。
 *
 * 抽成纯函数是为了能被自测直接钉住：单位规则最容易在后续改动里被悄悄破坏。
 */
function segmentMoveOf(refPoint, horizontal, rawX, rawY) {
  if (horizontal) return { x: 0, y: snapTo(refPoint.y + rawY, EDGE_GRID) - refPoint.y }
  return { x: snapTo(refPoint.x + rawX, EDGE_GRID) - refPoint.x, y: 0 }
}

/** 节点的几何（渲染与路由共用同一套默认值）。 */
function nodeGeoOf(node) {
  return { x: numberOr(node.x, 0), y: numberOr(node.y, 0), w: numberOr(node.w, FALLBACK_NODE_W), h: numberOr(node.h, FALLBACK_NODE_H) }
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
 * excludeId：改接端点时排除被钉住的那一端（指针滑回它身上不该高亮它）。
 * 新建连线**不排除起点** —— 把线放回起点节点自己就是自环，得让它能被命中。
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
 *  - 目标是一个真实节点（吸附命中）：用它的 geo，但 id 换成 '__preview' —— routeEdge 用 id 做过
 *    障碍排除，沿用真 id 会把"预览的落点"和"图上的那个节点"混为一谈；
 *    用独立 id 还能保证目标节点被当成障碍物参与避让，预览更接近真实走线。
 *    **例外：目标就是起点自己**（自环）—— 这时必须沿用真 id，才能走进自环分支。
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
  // 自环（指针回到起点节点上）：**沿用真实 id**，让 routeEdge 走它的自环分支。
  // 普通情况用 '__preview' 这个独立 id：routeEdge 拿 id 做障碍排除，沿用真 id 会把
  // "预览的落点"和"图上的那个节点"混为一谈。
  const selfLoop = fromBox.id === target.id
  const toBox = { id: selfLoop ? fromBox.id : '__preview', geo: target.geo }
  const boxes = []
  for (let i = 0; i < target.boxes.length; i += 1) boxes.push(target.boxes[i])
  boxes.push(toBox)
  const sides =
    seed === null || seed === undefined ? null : { source: seed.source, target: seed.target, jetty: seed.jetty }
  const raw = routeEdge(fromBox, toBox, boxes, target.bounds, null, sides)
  // routeEdge 自己已经收过尾（去共线、消台阶）：这里**不再收第二次**。
  // 收第二次会用一个"不保折点"的简化，于是预览比落盘少一个点 ——
  // 表现就是"拖的时候线是这样，松手就变样"。
  const pts = raw
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
    // 自环：进出口不能同侧（同侧会原地折回、屏幕上什么都看不见）。
    // 这条纠正必须在这里做 —— 预览显示的侧就是落盘写进 style 的侧，两处不一致就等于骗人。
    if (hot.id === fromId && toSide === seedSide) toSide = nextSideOf(seedSide)
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
  // 两端都用 endpointBoxOf 解析：**悬空端**是零尺寸盒（自由点），不是 geometry.byId 里的节点。
  // 之前直接查 byId，于是悬空端既没有预览、也拖不回来（"拖到空处变悬空"没法反向操作）。
  const fromBox = endpointBoxOf(geometry.byId, edge, 'source')
  const toBox = endpointBoxOf(geometry.byId, edge, 'target')
  if (fromBox === null || toBox === null) return null
  const fixedId = kind === 'from' ? (typeof edge.to === 'string' ? edge.to : null) : typeof edge.from === 'string' ? edge.from : null
  const hot = hitNodeAt(doc, geometry, cursor.x, cursor.y, padding, fixedId === null ? undefined : fixedId)

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
  // routeEdge 自己已经收过尾（去共线、消台阶），这里**不再收第二次**：
  // 第二次收尾不保折点，会把用户摆的折点消掉 —— 于是"拖的时候线是这样，松手就变样"。
  const out = pts
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

/**
 * drawio 独立边标签单元的落点 —— 与 `mxGraphView.getPoint` **同一套算法**。
 *
 * 相对几何的三个量各有含义（对着 drawio 源码核实过，不是猜的）：
 *   · `x` ∈ [-1,1] 是**沿边的比例**：0 = 中点，-1 = 源端，+1 = 目标端
 *     （源码里 `dist = (x/2 + 0.5) * 总长`）；
 *   · `y` 是**垂直偏移**（px），正数在行进方向的左侧 —— 横线左→右时就是"线上方"；
 *   · `offset`（`<mxPoint as="offset"/>`）是残余偏移，drawio 生成标签时用它把标签对准鼠标。
 *
 * 法线用 mxGraph 的约定：横/竖段上 `nx = dy/seg`、`ny = dx/seg`，
 * 落点 `x = p.x + dx*factor + (nx*y + offsetX)`、`y = p.y + dy*factor - (ny*y - offsetY)`。
 *
 * @returns { x, y } 或 null（路径不可用时）
 */
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

/**
 * `edgeLabelPointAt` 的反函数：**把标签拖到的那个点**换算成 drawio 的相对位置。
 *
 * 与 `mxGraphView.getRelativePoint` 同一套算法：找最近的一段 → 在段上投影 →
 * 沿边的弧长 `d` 换成比例 `x = 2d/总长 - 1`，垂距换成 `y`（正负号与 getPoint 的法线一致）。
 * 拖标签时用它把指针位置写成 x/y/offset —— 与 drawio 的 `mxEdgeHandler.moveLabel` 同一套存储。
 *
 * @returns { x, y } 或 null（路径不可用）
 */
function relativePointOnPath(pts, x, y) {
  if (Array.isArray(pts) === false || pts.length < 2) return null
  const segs = []
  let total = 0
  for (let i = 1; i < pts.length; i += 1) {
    const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
    segs.push(len)
    total += len
  }
  if (total <= 0) return null
  // 最近的一段（含它之前的弧长）—— 鼠标离哪一段近，就按那一段换算。
  let index = 0
  let bestDist = Infinity
  let before = 0
  let acc = 0
  for (let i = 0; i < segs.length; i += 1) {
    const a = pts[i]
    const b = pts[i + 1]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const seg = segs[i]
    let t = seg === 0 ? 0 : ((x - a.x) * vx + (y - a.y) * vy) / seg
    if (t < 0) t = 0
    if (t > seg) t = seg
    const px = a.x + (seg === 0 ? 0 : (vx / seg) * t)
    const py = a.y + (seg === 0 ? 0 : (vy / seg) * t)
    const dist = (x - px) * (x - px) + (y - py) * (y - py)
    if (dist < bestDist) {
      bestDist = dist
      index = i
      before = acc
    }
    acc += seg
  }
  const p0 = pts[index]
  const pe = pts[index + 1]
  const seg = segs[index]
  const dx = pe.x - p0.x
  const dy = pe.y - p0.y
  let proj = seg === 0 ? 0 : ((x - p0.x) * dx + (y - p0.y) * dy) / seg
  if (proj < 0) proj = 0
  if (proj > seg) proj = seg
  const dist = before + proj
  const nx = seg === 0 ? 0 : dy / seg
  const ny = seg === 0 ? 0 : dx / seg
  // 法线是 (nx, -ny)；沿它投影就是"垂直于边、偏离多少"（(dx,dy) 在这个方向上没有分量）。
  const perp = (x - p0.x) * nx - (y - p0.y) * ny
  return { x: (2 * dist) / total - 1, y: perp }
}

/**
 * 拖标签落到哪儿：和 drawio 的 `mxEdgeHandler.moveLabel` 一样，
 * `x` 取 4 位小数、`y` 取整，再把**取整剩下的零头**记进 `offset` —— 于是标签正好落在指针下，
 * 而文件里那两个数是干净的数（drawio 读回来也一样）。
 */
function labelPosFor(pts, point) {
  const rel = relativePointOnPath(pts, point.x, point.y)
  if (rel === null) return null
  const x = Math.round(rel.x * 10000) / 10000
  const y = Math.round(rel.y)
  const at = edgeLabelPointAt(pts, x, y, 0, 0)
  const offsetX = at === null ? 0 : Math.round(point.x - at.x)
  const offsetY = at === null ? 0 : Math.round(point.y - at.y)
  return { labelX: x, labelY: y, labelOffsetX: offsetX, labelOffsetY: offsetY }
}

/** 折线的分段长度与总长（标签挖空按弧长定位，与 edgeLabelPointAt 同一套弧长）。 */
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

/** 弧长 d 处的点（把"挖空的边界"落成折线上的点）。 */
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

/** 标签的框：文字宽度 + 左右各 3px 内边距、高 13px（与就地编辑框同一套数字）。 */
function labelBox(pos, text, fontSize) {
  if (pos === null || pos === undefined) return null
  const w = textWidth(typeof text === 'string' ? text : '', fontSize) + 6
  return { x: pos.x - w / 2, y: pos.y - 8, w: w, h: 13 }
}

/**
 * drawio 的 `labelBackgroundColor` 可能是 `#rrggbbaa`（8 位带透明度，例如它给拖出来的
 * 标签单元写 `#ffffffe0`）—— SVG 的 fill 不认 8 位十六进制，得拆成颜色 + `fill-opacity`。
 */
function parseCssColor(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  const eight = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(text)
  if (eight !== null) {
    return { color: '#' + eight[1], opacity: Math.round((parseInt(eight[2], 16) / 255) * 1000) / 1000 }
  }
  return { color: text.length > 0 ? text : fallback, opacity: 1 }
}

/** 框外扩一圈（挖空的余量：让字的两侧不留线头）。 */
function growBox(box, pad) {
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }
}

/**
 * 标签压在线上时，线要在**它这块区域里断开** —— 就是 drawio 的观感：字的位置不画线。
 *
 * 以前是"在字后面盖一个白色矩形"，两个毛病：把网格也盖掉了（一块白斑）；
 * 深色主题下那块白尤其突兀；虚线与彩色底上更是穿帮。这里改成真的把线挖掉。
 *
 * 返回要挖掉的**弧长区间**（可能多段：框跨过折返的路径时）。正交路径每段只有横/竖两种，
 * 所以"框与段相交"就是两个一维区间求交。
 */
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

/** 按弧长区间把折线挖空：返回剩下的若干段子折线（被挖掉的部分自然断开）。
 *
 * 两端**各留一小截**（`min(8px, 总长的 20%)`）：文字比这条线还长时（长标签压在短边上），
 * 不这么护一下整条线会连箭头一起消失 —— 那时读者连方向都看不出来。
 * 挖空的位置在中间时这条护法不生效（断口本来就离两端很远）。 */
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
    // 挖空的区间被夹在 [keep, 总长-keep] 里：两端那两小截永远留着。
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

/**
 * 拖标签时的**吸附**（与画布其余部分同一套单位：连线的几何量走半格 = 5px）。
 *
 * 两条，正好覆盖两种情形：
 *   · 指针先吸到半格 —— 线本身就落在格线上时，标签自动落在线上（垂距 0）；
 *   · 线不在格线上时（贴节点边框的那一轴是精确值，例如 x=455），补一条**贴线吸附**：
 *     垂距在 3px 以内就并回线上。没有它，"把字放回线上"只能靠手抖得正好。
 */
function snapLabelPoint(pts, point) {
  const snapped = { x: snapTo(point.x, EDGE_GRID), y: snapTo(point.y, EDGE_GRID) }
  const rel = relativePointOnPath(pts, snapped.x, snapped.y)
  if (rel === null) return snapped
  if (Math.abs(rel.y) <= 3) {
    const onLine = edgeLabelPointAt(pts, rel.x, 0, 0, 0)
    if (onLine !== null) return { x: onLine.x, y: onLine.y }
  }
  return snapped
}

/** 边自己的文字落在哪：**drawio 的规则** —— 沿折线的弧长中点，拖过就按拖到的位置。
 *
 * drawio 的边标签落点由 `mxGraphView.updateEdgeLabelOffset` 决定：边自己的 `mxGeometry` 是
 * `relative="1"`（我们写出来的正是这个）时走 `getPoint()` —— `x/y/offset` 缺省（从没拖过）
 * 就是 `x = 0` → `dist = 0.5 × 总长` = **整条折线的中点**；拖过就是 `x` 比例 + `y` 垂距 + 残余。
 * `x`/`y`/`offset` 由 `relativePointOnPath` 反解得到（见那里的注释）。
 *
 * 这里以前取的是"第 2 段的中点"（pts[1]→pts[2]），于是同一份文件我们和 drawio 画在不同地方：
 * 折线一拐，我们那段可能只是 24px 的引出段，文字就贴在节点边上。
 */
function edgeLabelPosition(pts, edge) {
  const labelX = edge === undefined || edge === null ? undefined : edge.labelX
  const labelY = edge === undefined || edge === null ? undefined : edge.labelY
  const offX = edge === undefined || edge === null ? undefined : edge.labelOffsetX
  const offY = edge === undefined || edge === null ? undefined : edge.labelOffsetY
  return edgeLabelPointAt(pts, labelX, labelY, offX, offY)
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

  /** 边的路径：独立边标签要按它算落点（与上面渲染用的是同一次路由结果）。 */
  const edgePts = {}
  // 隐藏图层的连线整条不画（它的边标签也跟着藏 —— 标签的 layer 会沿 parent 找到这条边）。
  const hiddenCells = hiddenLayerIds(doc)

  for (let i = 0; i < doc.edges.length; i += 1) {
    const edge = doc.edges[i]
    if (isHiddenCell(hiddenCells, edge)) continue
    const from = endpointBoxOf(byId, edge, 'source')
    const to = endpointBoxOf(byId, edge, 'target')
    if (from === null || to === null) continue
    let pts = routeEdgeStyled(from, to, boxes, bounds, edge, edgeRouteHint(ui, edge))
    edgePts[String(edge.id)] = pts
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
    // 连线的画法全部存在文档的 style 键里：dashed/dashPattern 决定线型、endArrow/startArrow
    // 决定箭头、strokeColor 决定颜色、rounded 决定拐角是否圆滑、curved=1 把折线抹成曲线
    // —— 与 drawio 一致，缺省即"不画"。命中带与可见线**用同一个 curved 判据**，否则
    // "看着是曲线、点起来按折线算"，两端拐弯处会点不中。
    const edgeStyle = typeof edge.style === 'string' ? edge.style : ''
    const edgeCurved = curvedFromStyle(edgeStyle)
    // 命中层：连线本身只有 1px，直接点很难点中。先铺一条透明的宽带子承接触击。
    /** 连线的交互面：命中带、标签底衬、标签文字**共用同一套**处理。
     *
     * 点 = 选中这条线；双击 = 改标签；右键 = 连线菜单。
     *
     * 标签为什么必须挂：标签的底衬（白色 rect）与文字画在命中带**上面**，
     * 而它们默认是能命中指针的 —— 不挂的话一次点击被它们吃掉，
     * 于是"点线上的文字"既不选中也不改标签（用户报的"无法在线段上添加文字"就是这个）。
     */
    const edgeFace = (extra) => {
      const props = Object.assign({}, extra)
      if (ui !== undefined && ui !== null) {
        // 按在线段上：选中它（或保留整组）并准备整体拖动；没有 onEdgePointerDown 时退回"只选中"。
        if (typeof ui.onEdgePointerDown === 'function') props.onPointerDown = (event) => ui.onEdgePointerDown(edge.id, event)
        else if (typeof ui.onSelectEdge === 'function') props.onPointerDown = (event) => ui.onSelectEdge(edge.id, event)
        if (typeof ui.onEdgeDoubleClick === 'function') props.onDoubleClick = (event) => ui.onEdgeDoubleClick(edge.id, event)
        if (typeof ui.onEdgeContextMenu === 'function') props.onContextMenu = (event) => ui.onEdgeContextMenu(edge.id, event)
      }
      return props
    }
    /** 标签自己的交互面：在连线那套之上，**按住就能拖**（drawio 的标签手柄行为）。
     *
     * 为什么标签能拖、而命中带不能：命中带是整条线，按住它是"选中这条线"，
     * 拖起来会和"拖段把手"打架；标签是一小块，按住它拖 = 挪这个标签，语义不冲突。
     * 没有文字的边没有这块，也就没有"拖空标签"这回事 —— drawio 同样只在有文字时给标签手柄。 */
    const edgeLabelFace = (extra) => {
      const props = edgeFace(extra)
      if (ui !== undefined && ui !== null && typeof ui.onEdgeLabelPointerDown === 'function') {
        props.onPointerDown = (event) => ui.onEdgeLabelPointerDown(edge.id, event)
      }
      return props
    }
    const hitProps = edgeFace({ key: 'edge-hit-' + i, className: 'drawai-edge-hit', d: pathOf(pts, 6, edgeCurved) })
    children.push(React.createElement('path', hitProps))
    // 连线的画法全部存在文档的 style 键里：dashed/dashPattern 决定线型、endArrow/startArrow
    // 决定箭头、strokeColor 决定颜色、rounded 决定拐角是否圆滑 —— 与 drawio 一致，缺省即"不画"。
    // v1 只存语义（dash:'dashed'）而把像素值留在客户端；v1.1 起渲染参数就是文档的一部分。
    const strokeColor = styleGet(edgeStyle, 'strokeColor', null)
    const arrow = arrowFromStyle(edgeStyle)
    const pattern = dashPatternFromStyle(edgeStyle)
    // drawio 的圆角半径：mxPolyline.paintLine 取 arcSize（缺省 mxConstants.LINE_ARCSIZE = 20）
    // 再 **除以 2**（那个 x2 是 addPoints 的内部约定，我们不打算复刻）→ 缺省 10px。
    const cornerRadius = styleGet(edgeStyle, 'rounded', '0') === '1' ? Math.max(0, styleNumber(edgeStyle, 'arcSize', 20) / 2) : 0
    const lineStroke = selected ? '#1a73e8' : strokeColor !== null ? strokeColor : skin.line
    // 线上的文字：先算出**文字框**（渲染与"给线挖空"要用同一个框），
    // 再把落在框里的那几段线挖掉 —— 于是字的位置不画线，而不是盖一层白底。
    const labelFontSize = styleNumber(edgeStyle, 'fontSize', 10)
    const hasOwnLabel = typeof edge.label === 'string' && edge.label.length > 0
    let ownPos = hasOwnLabel ? edgeLabelPosition(pts, edge) : null
    // 路径退化成零长（两端落在同一点）时落点算不出来：退回起点，别让文字掉到原点 (0,0) 去。
    if (ownPos === null && hasOwnLabel && pts.length > 0) ownPos = { x: pts[0].x, y: pts[0].y }
    const ownBox = ownPos === null ? null : labelBox(ownPos, edge.label, labelFontSize)
    const gaps = []
    if (ownBox !== null) gaps.push.apply(gaps, labelGapsOnPath(pts, growBox(ownBox, 2)))
    // 挂在边上的独立标签单元（drawio 的 edgeLabel）同样"占位不画线"。位置用与下面渲染
    // 那一段**同一个函数**算，否则框和文字会差几像素、挖空的位置就对不上了。
    const attached = Array.isArray(doc.labels) ? doc.labels : []
    for (let L = 0; L < attached.length; L += 1) {
      const item = attached[L]
      if (item === null || item === undefined || item.edgeId !== edge.id) continue
      const itemText = typeof item.text === 'string' ? item.text : ''
      if (itemText.length === 0) continue
      const itemPos = edgeLabelPointAt(pts, item.x, item.y, item.offsetX, item.offsetY)
      if (itemPos === null) continue
      gaps.push.apply(gaps, labelGapsOnPath(pts, growBox(labelBox(itemPos, itemText, styleNumber(item.style, 'fontSize', 10)), 2)))
    }
    const subPaths = gaps.length > 0 ? cutPathByGaps(pts, gaps) : [pts]
    const edgeProps = {
      key: 'edge-' + i,
      d: subPaths
        .map((sub) => pathOf(sub, cornerRadius, edgeCurved))
        .filter((text) => text.length > 0)
        .join(' '),
      fill: 'none',
      stroke: lineStroke,
      strokeWidth: selected ? 2 : styleNumber(edgeStyle, 'strokeWidth', 1),
      markerEnd: arrow === 'none' || arrow === 'start' ? undefined : 'url(#' + arrowId + ')',
      markerStart: arrow === 'both' || arrow === 'start' ? 'url(#' + arrowStartId + ')' : undefined,
      pointerEvents: 'none',
    }
    if (pattern !== null) edgeProps.strokeDasharray = pattern
    children.push(React.createElement('path', edgeProps))
    if (ownBox !== null) {
      // 底衬只在**样式明确要求**时画（drawio 的 `labelBackgroundColor`）——
      // 默认不画：线已经在字的位置断开，再盖一层白只会把网格也盖掉。
      const ownBg = styleGet(edgeStyle, 'labelBackgroundColor', null)
      if (ownBg !== null) {
        const bg = parseCssColor(ownBg, skin.labelBg)
        children.push(
          React.createElement('rect', edgeLabelFace({ key: 'edge-bg-' + i, x: ownBox.x, y: ownBox.y, width: ownBox.w, height: ownBox.h, rx: 2, fill: bg.color, fillOpacity: bg.opacity })),
        )
      }
      const edgeFontColor = styleGet(edgeStyle, 'fontColor', null)
      const edgeFontFill = edgeFontColor !== null ? edgeFontColor : skin.text
      children.push(
        React.createElement(
          'text',
          edgeLabelFace({
            key: 'edge-text-' + i,
            x: ownPos.x,
            y: ownPos.y + 1,
            textAnchor: 'middle',
            dominantBaseline: 'middle',
            fontSize: labelFontSize,
            fontFamily: FONT,
            fill: edgeFontFill,
            // inline style：CSS 规则优先级高于 SVG presentation attribute，
            // 万一 shell 有 svg text{...} 之类的全局规则，只有 inline style 能压住。
            style: { fill: edgeFontFill, fontFamily: FONT, fontSize: labelFontSize + 'px', dominantBaseline: 'middle' },
          }),
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
      const HANDLE_R = 4
      const ENDPOINT_R = 5
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
          // 双击把手 = 双击这条线。把手正压在**段的中点**上，而中点恰恰是"给线加文字"
          // 最自然会去双击的地方：单击选中（把手随即出现）→ 第二下打在把手上 →
          // dblclick 的 target 变成把手、不再回到下面的命中带，于是编辑器永远打不开。
          onDoubleClick: (event) => {
            if (ui !== undefined && ui !== null && typeof ui.onEdgeDoubleClick === 'function') ui.onEdgeDoubleClick(edge.id, event)
          },
        })
      const downAt = (kind, index) => (event) => {
        if (typeof ui.onEdgeHandlePointerDown === 'function') ui.onEdgeHandlePointerDown(edge.id, kind, index, event)
      }
      if (pts.length >= 2) {
        children.push(handleCircle('edge-from-' + i, pts[0], downAt('from', -1), '#0a7d32', ENDPOINT_R, '#ffffff'))
        children.push(handleCircle('edge-to-' + i, pts[pts.length - 1], downAt('to', -1), '#b85450', ENDPOINT_R, '#ffffff'))
      }
      for (let s = 0; s < pts.length - 1; s += 1) {
        const a = pts[s]
        const b = pts[s + 1]
        const segLen = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
        // **每一段都要有把手，短段也不例外。**
        //
        // 这里原来是 `if (segLen < 26) continue`（"太短的段不放，否则手柄会挤成一堆"）——
        // 代价是短段**整段挪不动**，而那恰恰是最常见需要挪一下的段：差几像素的台阶、
        // 贴边的引出段、两个节点挨得近时的那一小截（实测报过："短线段没有可移动的段点"）。
        //
        // 挤的问题用两个小办法缓解：
        //   · 半径随段长收（4 → 3），短段的手把小一点；
        //   · 首/末段的中点若离端点把手太近（两个圈会叠住，段和端点都抓不准），
        //     就把手挪到这一段的**另一端**（那个折点）—— 仍在这一段上，但离端点够远。
        //     例外：整条边只有一段（首即末）时不能挪 —— 挪到哪一端都会正好压在端点把手上，
        //     这时留在中点反而最清楚。
        const atStart = s === 0
        const atEnd = s === pts.length - 2
        let pos = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        if ((atStart || atEnd) && !(atStart && atEnd) && segLen < (HANDLE_R + ENDPOINT_R) * 2) pos = atStart ? b : a
        const radius = Math.max(3, Math.min(HANDLE_R, segLen / 2))
        children.push(handleCircle('edge-seg-' + i + '-' + s, pos, downAt('segment', s), '#ffffff', radius, '#f2a900'))
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

  // drawio 的**独立边标签单元**：只读显示（画布不改它们，保存时原样带回）。
  // 位置按 mxGraphView.getPoint 那套算法算 —— 挂在边上的用"沿边比例 + 垂直偏移 + 残余偏移"，
  // 没挂在边上的（从别处粘过来的那种）按它自己的坐标画。
  const labels = Array.isArray(doc.labels) ? doc.labels : []
  const hiddenForLabels = hiddenLayerIds(doc)
  for (let i = 0; i < labels.length; i += 1) {
    const item = labels[i]
    if (isHiddenCell(hiddenForLabels, item)) continue
    const text = item === null || item === undefined || typeof item.text !== 'string' ? '' : item.text
    if (text.length === 0) continue
    let pos = null
    if (typeof item.edgeId === 'string' && edgePts[item.edgeId] !== undefined) {
      pos = edgeLabelPointAt(edgePts[item.edgeId], item.x, item.y, item.offsetX, item.offsetY)
    } else if (Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y))) {
      pos = { x: Number(item.x), y: Number(item.y) }
    }
    if (pos === null) continue
    const size = styleNumber(item.style, 'fontSize', 10)
    const color = styleGet(item.style, 'fontColor', null)
    const fill = color !== null ? color : skin.text
    // 底衬同样只在样式明确要求时画：线已经在它的位置断开了，默认不再盖一层。
    const itemBg = styleGet(item.style, 'labelBackgroundColor', null)
    if (itemBg !== null) {
      const box = labelBox(pos, text, size)
      const bg = parseCssColor(itemBg, skin.labelBg)
      children.push(React.createElement('rect', { key: 'elabel-bg-' + i, x: box.x, y: box.y, width: box.w, height: box.h, rx: 2, fill: bg.color, fillOpacity: bg.opacity }))
    }
    children.push(
      React.createElement(
        'text',
        {
          key: 'elabel-' + i,
          className: 'drawai-elabel',
          x: pos.x,
          y: pos.y + 1,
          textAnchor: 'middle',
          dominantBaseline: 'middle',
          fontSize: size,
          fontFamily: FONT,
          fill: fill,
          style: { fill: fill, fontFamily: FONT, fontSize: size + 'px', dominantBaseline: 'middle' },
        },
        text,
      ),
    )
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

  // 对齐辅助线画在**最上面**（drawio 的 guides 也压在单元之上）：拖动时那几条蓝虚线。
  const guideLines = ui === undefined || ui === null || Array.isArray(ui.guides) === false ? [] : ui.guides
  for (let i = 0; i < guideLines.length; i += 1) {
    const g = guideLines[i]
    const geom =
      g.axis === 'x'
        ? { x1: g.at, y1: g.from, x2: g.at, y2: g.to }
        : { x1: g.from, y1: g.at, x2: g.to, y2: g.at }
    children.push(
      React.createElement(
        'line',
        Object.assign({ key: 'guide-' + i, stroke: '#1a73e8', strokeWidth: 1, strokeDasharray: '4 3', pointerEvents: 'none' }, geom),
      ),
    )
  }

  return React.createElement('svg', { ref: svgRef, viewBox: viewBox, width: '100%', height: '100%', preserveAspectRatio: 'none', style: { display: 'block', background: skin.page } }, children)
}

/**
 * 从宿主 `action: 'read'` 的响应里取出**可以直接画**的文档。
 *
 * 为什么客户端不再自己解析文件：载体是 `.drawio`（drawio 的 mxfile），而 drawio 默认把
 * 页体压成 `base64(raw deflate(xml))` —— **浏览器没有 zlib**（DecompressionStream 是异步的，
 * 塞不进同步渲染路径）。与其把解析器抄一份到浏览器，不如让唯一的解析器待在宿主，
 * 客户端只认"文档"这一层。
 *
 * 这里仍然做防御性校验：宿主与客户端虽然同一份代码，但渲染函数不该假设状态形状 ——
 * 之前就因为"把读到的东西当成一定有"而让整个画布降级成红底错误页。
 */
function docFromPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { error: '宿主返回的不是一个对象' }
  if (payload.ok !== true) return { error: String(payload.error === undefined ? '读取失败' : payload.error) }
  if (payload.exists === false) {
    // 文件还不存在（比如从地址栏直接开了一个新路径）：当作空画布，保存时才落盘。
    // 空画布**带一个缺省图层** —— 与"新建后落盘、再打开"的形状一致（盘上那个缺省图层单元
    // 写出来就是 `<mxCell id="1" parent="0" />`，所以文件字节没变），/图层面板/也就有东西可显示。
    return { doc: { version: 2, revision: '', meta: {}, nodes: [], edges: [], layers: [defaultLayer()] }, notes: [], created: true }
  }
  const raw = payload.doc
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: '文档不是一个对象' }
  if (Array.isArray(raw.nodes) === false || Array.isArray(raw.edges) === false) return { error: '文档缺少 nodes / edges' }
  const doc = normalizeDrawioDoc(raw)
  const nodes = doc.nodes.filter((n) => n !== null && typeof n === 'object' && typeof n.id === 'string')
  // 两端各自"有着落"就收：连着节点，或带自由点（drawio 的悬空端）。
  const edges = doc.edges.filter((e) => e !== null && typeof e === 'object' && edgeHasEnd(e, 'source') && edgeHasEnd(e, 'target'))
  // **0 个节点不是错误** —— 空画布是完全合法的状态（刚「新建」出来就是这样，
  // 用户还要靠右键往里面加节点）。真正该报错的是"文件不是画布"。
  //
  // 这里用"摊开再覆盖"而不是逐个字段抄：逐个抄漏过 version/meta、漏过 labels、又漏过
  // layers（症状是"图层菜单说这张画布没有图层信息"，而文件里明明有）。摊开之后，
  // 文档以后多什么字段都自动跟着走。
  return {
    doc: Object.assign({}, doc, {
      revision: typeof doc.revision === 'string' ? doc.revision : '',
      nodes: nodes,
      edges: edges,
    }),
    notes: Array.isArray(payload.notes) ? payload.notes : [],
    absolute: typeof payload.absolute === 'string' ? payload.absolute : undefined,
  }
}

/** 缺省图层（与 drawio/我们写文件时那个 `<mxCell id="1" parent="0" />` 对应）。 */
function defaultLayer() {
  return { id: '1', name: '', visible: true, locked: false }
}

/**
 * 文档的深一层拷贝。
 *
 * nodes/edges 是数组，edge.points / sourcePoint / targetPoint / labels / layers 是嵌套对象/数组，
 * 快照必须**互不影响** —— 否则撤销会写坏工作副本，而且是静默的
 * （图层的显示/隐藏就是原地改 `layers[i].visible`，快照共享同一个对象就会一起被改掉）。
 *
 * **先把 source 整份摊开、再覆盖需要深拷的那几个数组**，不逐个字段抄。
 * 逐个抄已经付过三次代价：version/meta 丢过一次、labels 丢过一次、layers 又丢了一次
 * （layers 一丢，"显示/隐藏"直接变成空操作：mutate 拿到的 next.layers 是 undefined）。
 * 摊开之后，以后再加任何文档级字段都自动跟着走。
 */
function cloneDoc(source) {
  const copy = Object.assign({}, source)
  copy.meta = source.meta === undefined || source.meta === null ? source.meta : Object.assign({}, source.meta)
  copy.labels = Array.isArray(source.labels) ? source.labels.map((l) => Object.assign({}, l)) : []
  copy.layers = Array.isArray(source.layers) ? source.layers.map((l) => Object.assign({}, l)) : source.layers
  copy.nodes = source.nodes.map((n) => Object.assign({}, n))
  copy.edges = source.edges.map((e) => {
    const edge = Object.assign({}, e)
    if (Array.isArray(e.points)) edge.points = e.points.map((p) => ({ x: p.x, y: p.y }))
    if (e.sourcePoint !== undefined) edge.sourcePoint = { x: e.sourcePoint.x, y: e.sourcePoint.y }
    if (e.targetPoint !== undefined) edge.targetPoint = { x: e.targetPoint.x, y: e.targetPoint.y }
    return edge
  })
  return copy
}

/**
 * 编辑数据面板里用的两个纯函数：数据对象 ↔ 多行文本（每行 `key=value`）。
 *
 * 为什么用文本而不是表格：数据就是"drawio 用户对象上的自定义属性"，键名随人定、
 * 值都是字符串 —— 表格反而挡路。空行与 `#` 开头的行忽略；没有 `=` 的行也忽略（不猜）。
 */
function formatDataLines(data) {
  if (data === null || data === undefined || typeof data !== 'object') return ''
  const keys = Object.keys(data)
  const lines = []
  for (let i = 0; i < keys.length; i += 1) lines.push(keys[i] + '=' + String(data[keys[i]]))
  return lines.join('\n')
}

function parseDataLines(text) {
  const out = {}
  const lines = String(text === undefined || text === null ? '' : text).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed.length === 0 || trimmed.charAt(0) === '#') continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    if (key.length === 0 || key === 'id' || key === 'label') continue
    out[key] = trimmed.slice(at + 1).trim()
  }
  return out
}

/**
 * 这个 DOM 节点是不是"正在编辑文本"的地方（按键该归它，不该归画布）。
 *
 * `input/textarea/select` 只覆盖了一半的输入场景：**DSH 的输入框是 Lexical 的
 * contenteditable div**，而事件目标常常是它内部的 span —— 只看 tagName 会认不出来，
 * 于是"在输入框里按退格"变成"删掉画布里的选中内容"，`Ctrl+C/V` 也被 preventDefault 掉，
 * 输入框里既删不了字也复制粘贴不了（用户实测报的两条）。
 *
 * 三种信号都要认：
 *   · `isContentEditable` —— 宿主与它内部的子节点都是 true（浏览器算好的）；
 *   · 往上找 `[contenteditable]` —— 覆盖 `contenteditable="false"` 的子块（它自己 false，
 *     但仍然长在输入框里）以及老浏览器不实现 isContentEditable 的情况；
 *   · `role="textbox"` —— 富文本编辑器常给自己挂这个角色。
 */
function isTextEntry(node) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (node.isContentEditable === true) return true
  if (typeof node.tagName === 'string') {
    const tag = node.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  }
  if (typeof node.closest === 'function') {
    if (node.closest('[contenteditable=""],[contenteditable="true"],[role="textbox"]') !== null) return true
  }
  return false
}

/**
 * 画布该不该处理这次按键。
 *
 * 画布的快捷键挂在 `window` 上（这样"点过画布之后"不用先把焦点放进某个元素里），
 * 代价是**别的面板里的按键也会经过这里** —— 而 DSH 的输入框就在同一个页面里。
 * 两条判据，任何一条成立就放手：
 *
 *   1. 事件目标或当前焦点是**输入宿主**（见 isTextEntry）→ 那是人家在打字；
 *   2. 焦点已经落在**别的控件**上（另一个面板的按钮、链接、树节点…）→ 也不抢。
 *      只有"焦点没了"（刚点过画布空白，焦点回到 body）或"焦点就在本面板里"才算画布的。
 *
 * 第 2 条是为了防同类毛病：焦点在侧边栏某个按钮上时按退格，同样不该删画布里的东西。
 */
function canvasOwnsKeyboard(event, root, active) {
  const target = event === null || event === undefined ? null : event.target
  if (isTextEntry(target)) return false
  if (isTextEntry(active)) return false
  if (active === null || active === undefined) return true
  if (typeof active.tagName === 'string') {
    const tag = active.tagName.toUpperCase()
    if (tag === 'BODY' || tag === 'HTML') return true
  }
  if (root === null || root === undefined || typeof root.contains !== 'function') return true
  return root.contains(active) === true
}

/**
 * 剪贴板：**模块级**（不属于某个标签页）—— 在一个标签页里复制、切到另一个标签页粘贴，
 * 是画布的常规用法，做成每个标签页一份反而奇怪。
 *
 * 里面只存**普通数据的深拷贝**，不存文档对象：粘贴时那份文档可能已经被撤销/重载过。
 */
let clipboard = null

/** 节点深拷贝（标签/样式都是字符串，几何是数字 —— 浅拷就够，但要显式列出来）。 */
function cloneClipNode(node) {
  const copy = { id: node.id, label: node.label, style: node.style, x: node.x, y: node.y, w: node.w, h: node.h }
  // 图层与自定义数据也要跟着复制 —— 否则"复制到一个新图层"或"复制带数据的节点"会丢东西
  // （数据是 drawio 用户对象上的属性，丢了 drawio 那边就查不到了）。
  if (typeof node.layer === 'string' && node.layer.length > 0) copy.layer = node.layer
  if (node.data !== undefined && node.data !== null) copy.data = copyData(node.data)
  return copy
}

/** 边深拷贝：折点与两个自由端点都要**各拷一份**，否则粘贴出来的两条边会共享同一组点。 */
function cloneClipEdge(edge) {
  const copy = { id: edge.id, from: edge.from, to: edge.to }
  if (typeof edge.label === 'string') copy.label = edge.label
  if (typeof edge.style === 'string') copy.style = edge.style
  if (Array.isArray(edge.points)) copy.points = edge.points.map((p) => ({ x: p.x, y: p.y }))
  if (edge.sourcePoint !== undefined && edge.sourcePoint !== null) copy.sourcePoint = { x: edge.sourcePoint.x, y: edge.sourcePoint.y }
  if (edge.targetPoint !== undefined && edge.targetPoint !== null) copy.targetPoint = { x: edge.targetPoint.x, y: edge.targetPoint.y }
  if (typeof edge.layer === 'string' && edge.layer.length > 0) copy.layer = edge.layer
  if (edge.data !== undefined && edge.data !== null) copy.data = copyData(edge.data)
  if (Number.isFinite(Number(edge.labelX)) && Number.isFinite(Number(edge.labelY))) {
    copy.labelX = Number(edge.labelX)
    copy.labelY = Number(edge.labelY)
    if (Number.isFinite(Number(edge.labelOffsetX))) copy.labelOffsetX = Number(edge.labelOffsetX)
    if (Number.isFinite(Number(edge.labelOffsetY))) copy.labelOffsetY = Number(edge.labelOffsetY)
  }
  return copy
}

/**
 * 把选中的东西收进剪贴板。
 *
 * 边只收**两端都在选区内**的那些 —— 只选中一个节点时把它的所有边一起搬走，
 * 粘贴出来的边会指向没被粘贴的节点（悬空），那不是用户想要的。
 *
 * @returns { nodes, edges } 或 null（没选中任何节点）
 */
function collectClipboard(doc, ids) {
  if (doc === null || doc === undefined || Array.isArray(ids) === false || ids.length === 0) return null
  const picked = {}
  for (let i = 0; i < ids.length; i += 1) picked[ids[i]] = true
  const nodes = []
  for (let i = 0; i < doc.nodes.length; i += 1) if (picked[doc.nodes[i].id] === true) nodes.push(cloneClipNode(doc.nodes[i]))
  if (nodes.length === 0) return null
  const edges = []
  for (let i = 0; i < doc.edges.length; i += 1) {
    const e = doc.edges[i]
    if (picked[e.from] === true && picked[e.to] === true) edges.push(cloneClipEdge(e))
  }
  return { nodes: nodes, edges: edges }
}

/** 下一个可用的 `n<数字>` / `e<数字>` 编号（只在文档里已有的 id 上算，不猜别的形式）。 */
function idCounters(doc) {
  let maxNode = 0
  let maxEdge = 0
  const nre = /^n(\d+)$/
  const ere = /^e(\d+)$/
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const m = nre.exec(String(doc.nodes[i].id))
    if (m !== null && parseInt(m[1], 10) > maxNode) maxNode = parseInt(m[1], 10)
  }
  for (let i = 0; i < doc.edges.length; i += 1) {
    const m = ere.exec(String(doc.edges[i].id))
    if (m !== null && parseInt(m[1], 10) > maxEdge) maxEdge = parseInt(m[1], 10)
  }
  return { node: maxNode, edge: maxEdge }
}

/**
 * 粘贴：把剪贴板里的东西拷进文档，整体平移 `offset`，并给每个单元**重新分配 id**。
 *
 * 纯函数（返回新文档与新选中集）—— 剪贴板最容易错的两处（id 撞车、共享折点数组）
 * 都能在命令行里直接断言，不必靠手点。
 */
function pasteInto(doc, clip, offsetX, offsetY, layer) {
  if (doc === null || doc === undefined || clip === null || clip === undefined) return null
  if (Array.isArray(clip.nodes) === false || clip.nodes.length === 0) return null
  const counters = idCounters(doc)
  const remap = {}
  const nodes = doc.nodes.map((n) => Object.assign({}, n))
  const edges = doc.edges.map(cloneClipEdge)
  const ids = []
  const targetLayer = typeof layer === 'string' && layer.length > 0 ? layer : null
  for (let i = 0; i < clip.nodes.length; i += 1) {
    const src = clip.nodes[i]
    counters.node += 1
    const id = 'n' + counters.node
    remap[String(src.id)] = id
    ids.push(id)
    // 先整份拷（label/style/w/h/data/layer 都在里面），再改写 id 与新位置。
    const copy = Object.assign({}, src, { id: id, x: numberOr(src.x, 0) + offsetX, y: numberOr(src.y, 0) + offsetY })
    // 粘贴进**当前图层**（drawio 也是这个行为）；没设当前层就沿用原件那一层（copy.layer 已经在）。
    if (targetLayer !== null) copy.layer = targetLayer
    nodes.push(copy)
  }
  for (let i = 0; i < clip.edges.length; i += 1) {
    const src = clip.edges[i]
    const from = remap[String(src.from)]
    const to = remap[String(src.to)]
    if (from === undefined || to === undefined) continue
    counters.edge += 1
    const copy = cloneClipEdge(src)
    copy.id = 'e' + counters.edge
    copy.from = from
    copy.to = to
    if (targetLayer !== null) copy.layer = targetLayer
    if (Array.isArray(copy.points)) copy.points = copy.points.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY }))
    if (copy.sourcePoint !== undefined) copy.sourcePoint = { x: copy.sourcePoint.x + offsetX, y: copy.sourcePoint.y + offsetY }
    if (copy.targetPoint !== undefined) copy.targetPoint = { x: copy.targetPoint.x + offsetX, y: copy.targetPoint.y + offsetY }
    edges.push(copy)
    ids.push(copy.id)
  }
  return {
    // 摊开整份文档再覆盖 nodes/edges：labels（只读的独立边标签）、layers（图层表）
    // 与其他文档级字段都原样带上 —— 粘贴一次不该把图层结构弄丢。
    doc: Object.assign({}, doc, { nodes: nodes, edges: edges }),
    ids: ids,
  }
}

/**
 * 容器尺寸变化后，把视口按**同一个缩放比例**折算到新尺寸。
 *
 * 抽成纯函数是为了能被断言：这段数学错一点，表现就是"拖侧边栏时画面跟着缩放/被拉扁"，
 * 而在浏览器里只能靠手感发现。
 *
 * 两条硬要求：
 *   · `next.w / 结果.w` 必须等于 `prev.w / current.w`（缩放比例不变 → 内容不变大也不变小）；
 *   · `结果.h / 结果.w` 必须等于 `next.h / next.w`（视口宽高比 = 容器宽高比 →
 *     `preserveAspectRatio="none"` 不会把画面拉伸）。
 *
 * @returns 新的视口，或 null（尺寸/视口不可用时调用方保持原样）
 */
function resizeViewFor(current, prevSize, nextSize) {
  if (current === null || current === undefined) return null
  if (prevSize === null || prevSize === undefined || nextSize === null || nextSize === undefined) return null
  if (!(prevSize.w > 0) || !(current.w > 0) || !(nextSize.w > 0) || !(nextSize.h > 0)) return null
  const scale = prevSize.w / current.w
  return { x: current.x, y: current.y, w: nextSize.w / scale, h: nextSize.h / scale }
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
 * 而地址**实际**还可能是别的样子（实测用户的 tab 就解析不出来 —— 那时面板只会停在空舞台，
 * 屏幕空白、AI 却会去改 demo.drawio）。所以这里按"形式"逐个处理，而不是只认一种：
 *
 *   dsh-resource://file/session/<id>/<rel>   → <rel>（相对工作区）
 *   dsh-resource://file/<rel>                → <rel>
 *   file:///D:/x/y.drawio                 → 绝对路径
 *   /D:/x/y.drawio                        → 去掉前导斜杠（Windows 上多一个 / 就认不出）
 *   D:\x\y.drawio 或 D:/x/y.drawio     → 绝对路径
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
    // 这里翻过车：为了让绝对路径（D:\x\y.drawio）能解析，一度写成"其余一律原样返回"，
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
  // 只有两种状态：**绑定了文件的画布**（path 非空）与**空舞台**（empty：一张画布都还没打开）。
  // 没有"未绑定画布"这种中间态 —— 那套代码已按需求删除。
  const empty = props.empty === true
  const target = typeof props.path === 'string' ? props.path : ''
  const hasPath = !empty && target.length > 0
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
  const revisionRef = React.useRef('')
  const dirtyRef = React.useRef(false)
  const dragRef = React.useRef(null)
  const linkRef = React.useRef(null)
  const saveTimerRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  /** 本视图的根元素：工作栏下拉 / 文件面板的定位参照系（它 position:absolute，是定位上下文）。 */
  const rootRef = React.useRef(null)
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
  /** 上一次量到的容器尺寸：容器一变就要把视口按**同一个缩放比例**折算过去（见 measure）。 */
  const measuredRef = React.useRef({ w: 0, h: 0 })
  /**
   * 路由迟滞的记忆：边 id → 上一次用的候选。
   *
   * 为什么要有它：拖动节点时，直连路线的合法性会在避让边界上反复翻转，
   * 于是路由在"绕上面"和"直连"之间一帧一变、端点侧跟着跳（详见 applyRouteHysteresis）。
   * **渲染与命中共用这一份** —— 否则迟滞期间"画出来的线"和"点得到的线"会是两条路。
   */
  const routeMemoryRef = React.useRef(new Map())

  // ---- 右键菜单 / 连线拖拽 ------------------------------------------------
  const menuState = React.useState(null) // { kind: 'canvas'|'node'|'edge', id, left, top, userX, userY }
  const menu = menuState[0]
  const setMenu = menuState[1]
  const menuStyleState = React.useState('blue')
  const menuStyle = menuStyleState[0]
  const setMenuStyle = menuStyleState[1]
  // 空白处右键"元素库"里选中的形状：菜单只显示它的名字，选中的那个就是「＋ 新增节点」放的东西。
  const menuShapeState = React.useState('rect')
  const menuShape = menuShapeState[0]
  const setMenuShape = menuShapeState[1]
  const edgeDragRef = React.useRef(null) // { edgeId, kind: 'segment'|'from'|'to', ... }
  const labelDragRef = React.useRef(null) // 拖边标签 { edgeId, originX, originY, moved }
  const guidesState = React.useState([]) // 拖动时的对齐辅助线 [{axis,at,from,to}]
  const guides = guidesState[0]
  const setGuides = guidesState[1]
  const canRevertState = React.useState(false) // 宿主那边有没有可退回的 AI 改动
  const canRevert = canRevertState[0]
  const setCanRevert = canRevertState[1]
  // 当前图层（新建的节点/连线/粘贴进这一层）：**客户端状态**，不进文件 ——
  // drawio 也是这样（图层面板里的选中项不落盘）。
  const currentLayerState = React.useState(null)
  const currentLayerId = currentLayerState[0]
  const setCurrentLayerId = currentLayerState[1]
  /**
   * 「当前图层」的解析结果与图层表。
   *
   * **就地算在这里，不放到菜单那段去算**：新建节点/连线、从空白处拉线、粘贴都要盖"当前层"的章，
   * 而那几个函数在组件体里出现得更早。以前把这两个常量写在菜单附近，功能上能用
   * （事件都在组件体跑完之后才触发），但那是一个**TDZ 地雷**：哪天有人把其中任何一个
   * 挪进渲染期（useMemo / 直接调用），就会得到 `Cannot access 'activeLayerId'
   * before initialization` —— 和刚修掉的 `item is not defined` 一样，整张画布降级。
   */
  const layerList = doc !== null && doc !== undefined && Array.isArray(doc.layers) ? doc.layers : []
  const activeLayerId =
    currentLayerId !== null && layerList.some((l) => l !== null && l !== undefined && l.id === currentLayerId)
      ? currentLayerId
      : layerList.length > 0 && layerList[0] !== null && layerList[0] !== undefined
        ? layerList[0].id
        : null
  const marqueeRef = React.useRef(null) // 框选拖拽 { x0, y0, x1, y1, additive, moved }
  // 待抢的 pointer capture：按下时登记 { pointerId, x, y }，真的动起来（> CAPTURE_MOVE_PX）
  // 才在 pointermove 里抢下来。按下就抢会让 click/dblclick 落到画布容器上（双击改标签失灵）。
  const pendingCaptureRef = React.useRef(null)
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

  // cloneDoc 在模块作用域（纯函数，且自测要能直接调它 —— 它曾经在这里静默吃掉 layers）。

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

  /**
   * 卸载前把还在防抖窗口里的改动冲出去。
   *
   * 现在**可以关掉最后一个标签**（回到空舞台），而防抖窗口是 300ms ——
   * 少了这一条，手快的人在窗口内点 × 就会丢掉刚才那一笔。尽力而为：不 await、不提示。
   */
  React.useEffect(() => () => {
    if (dirtyRef.current === true && hasPath && docRef.current !== null && client !== null) saveNow()
  }, [])

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
    // .drawio：**不是**画布，点它要先导入。所以单独一列，界面上也分区显示 ——
    // 混在画布列表里会让"打开"去按 JSON 读一个 XML 文件。
    const relDrawio = Array.isArray(payload.drawio) ? payload.drawio : []
    const absDrawio = Array.isArray(payload.drawioAbsolute) ? payload.drawioAbsolute : []
    const drawioEntries = []
    for (let i = 0; i < relDrawio.length; i += 1) {
      const identity = typeof absDrawio[i] === 'string' && absDrawio[i].length > 0 ? absDrawio[i] : relDrawio[i]
      drawioEntries.push({ path: identity, display: relDrawio[i] })
    }
    setFileList({
      files: entries,
      drawio: drawioEntries,
      error: '',
      notes: Array.isArray(payload.notes) ? payload.notes : [],
      dir: typeof payload.dir === 'string' ? payload.dir : '',
    })
  }

  /**
   * 「打开」：先弹**系统文件管理器**选一个目录，再列出该目录下的画布。
   *
   * 为什么是选目录而不是选文件：DSH 的 uiWorkspace 只提供 `pickDirectory()`
   * （没有选单个文件的接口）。所以流程是"选目录 → 列该目录下的 .drawio"，
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
   * （没有选单个文件的接口）。所以流程是"选目录 → 列该目录下的 .drawio"。
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
   * 另存为：写入给定文件名，并把本标签**改为绑定**到它。
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
    const withExt = trimmed.toLowerCase().endsWith('.drawio') ? trimmed : trimmed + '.drawio'
    const snapshot = docRef.current
    if (client === null || snapshot === null) return
    setSaveNote('另存为 ' + withExt + ' …')
    let raw = null
    try {
      raw = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        // createOnly：另存为的目标**不该已存在**，已存在就让宿主返回 409，
        // 绝不静默覆盖别人的文件 —— 想改那个文件请用「打开」进去。
        body: JSON.stringify({ sessionId: sessionId, path: withExt, createOnly: true, doc: snapshot }),
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
      setFileList({ files: null, error: message === 'already exists' ? '已存在同名文件：用「打开」进去改，或换个名字' : message })
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

  /**
   * 「撤销 AI 改动」：把宿主留的那一份"AI 写盘前的文本"写回去（只有一层）。
   *
   * 为什么需要：服务端推来新版本时客户端会清空本地撤销历史（见 resetHistory 的注释），
   * 所以 AI 改完按 Ctrl+Z 是退不回去的。这里走宿主的 revert 端点。
   * 本地有没落盘的改动时拒绝 —— 否则那点改动会被撤回操作压掉（300ms 自动保存，等一下就好）。
   */
  async function revertAiChange() {
    if (client === null || !hasPath || client === null) return
    if (dirtyRef.current === true) {
      setSaveNote('有还没落盘的改动，稍等一下再撤回')
      return
    }
    try {
      const raw = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
        body: JSON.stringify({ action: 'revert', sessionId: sessionId, path: target }),
      })
      const payload = await raw.json()
      if (payload.ok !== true) {
        setSaveNote(typeof payload.error === 'string' && payload.error.length > 0 ? payload.error : '撤回失败')
        return
      }
      setCanRevert(false)
      setSaveNote('已退回上一次 AI 改动（revision ' + payload.revision + '）')
      setNonce((n) => n + 1)
    } catch (error) {
      setSaveNote('撤回失败：' + (error && error.message ? error.message : String(error)))
    }
  }

  /**
   * 显示/隐藏一个图层 —— 写的是**文档里的属性**（drawio 的 `visible="0"`），不是本地开关：
   * 于是它会被保存、能被 drawio 看见、也进撤销历史（Ctrl+Z 能撤回一次误点）。
   */
  function toggleLayerVisible(id) {
    applyLocal((next) => {
      const layers = Array.isArray(next.layers) ? next.layers : null
      if (layers === null) return
      for (let i = 0; i < layers.length; i += 1) {
        if (layers[i].id !== id) continue
        layers[i].visible = layers[i].visible === false
      }
    }, 'layer-visible:' + id)
  }

  /** 新建图层：自动命名"图层 N"（重命名/锁定/删除留到 v2，所以 v1 不给输入框）。 */
  function createLayer() {
    const current = docRef.current
    if (current === null) return
    const id = nextLayerIdOf(current)
    const index = Array.isArray(current.layers) ? current.layers.length : 0
    applyLocal((next) => {
      if (Array.isArray(next.layers) === false) next.layers = []
      next.layers.push({ id: id, name: '图层 ' + (index + 1), visible: true, locked: false })
    })
    setCurrentLayerId(id)
    setSaveNote('已新建图层「图层 ' + (index + 1) + '」并设为当前图层')
  }

  async function saveNow() {
    if (client === null || dirtyRef.current !== true) return
    // 没有绑定文件（空舞台）时不该有脏数据；真出现就说明状态串了 —— 提示而不是猜一个文件名
    // （替用户挑文件名正是原来"悄悄写 demo"的老毛病）。
    if (!hasPath) {
      setSaveNote('还没有画布可保存：先「新建画布…」或「打开…」')
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
        // 别人改了这份文件（drawio、AI、别的编辑器都算）：不重试、不覆盖，
        // 下一次轮询就会把新版本拉回来。
        setSaveNote('保存被拒：文件已被他处修改，稍后会重新载入')
        return
      }
      dirtyRef.current = true
      setSaveNote('保存被拒：' + message)
      return
    }
    revisionRef.current = response.revision
    // 有边被略过就如实说（两端都没有落点的边写不进文件），别让用户以为"全保存了"。
    const dropped = Array.isArray(response.dropped) ? response.dropped : []
    setSaveNote('已保存（revision ' + response.revision + '）' + (dropped.length > 0 ? ' ｜ ' + dropped.length + ' 条边没有落点，未写入：' + dropped.join(', ') : ''))
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

  /**
   * 开始拖动**整个选区**：节点、连线的折点、连线的自由端点一起动。
   *
   * 以前只挪节点 —— 连线的折点留在原地，于是"框选全部再拖"时线只是重新自动路由，
   * 形状全变了（用户报的"线段没有被拖动，只是保持着自动路由"）。
   * 现在同一个位移同时作用在三者上，相对位置**完全不变**。
   *
   * `ref` 是抓起来的那一点（节点的起始坐标）；位移由它算出来并被吸附一次：
   * 逐点各自吸附会把相对位置弄歪（两个节点差 3px 时会被吸到同一格上叠起来）。
   */
  function startSelectionDrag(ids, point, reference) {
    const current = docRef.current
    if (current === null || point === null) return
    const starts = []
    for (let i = 0; i < current.nodes.length; i += 1) {
      const n = current.nodes[i]
      if (ids.indexOf(n.id) < 0) continue
      // w/h 也记下来：对齐辅助线要用**整组的外接框**比（与 drawio 一致）。
      starts.push({ id: n.id, x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, FALLBACK_NODE_W), h: numberOr(n.h, FALLBACK_NODE_H) })
    }
    // 连线上"不是节点算出来的"那部分几何：折点与悬空端的自由点。
    const edgeStarts = []
    for (let i = 0; i < current.edges.length; i += 1) {
      const e = current.edges[i]
      if (ids.indexOf(e.id) < 0) continue
      const points = Array.isArray(e.points) ? e.points.map((p) => ({ x: p.x, y: p.y })) : null
      const sourcePoint = e.sourcePoint === undefined || e.sourcePoint === null ? null : { x: e.sourcePoint.x, y: e.sourcePoint.y }
      const targetPoint = e.targetPoint === undefined || e.targetPoint === null ? null : { x: e.targetPoint.x, y: e.targetPoint.y }
      if (points === null && sourcePoint === null && targetPoint === null) continue
      edgeStarts.push({ id: e.id, points: points, sourcePoint: sourcePoint, targetPoint: targetPoint })
    }
    if (starts.length === 0 && edgeStarts.length === 0) return
    dragRef.current = {
      originX: point.x,
      originY: point.y,
      starts: starts,
      edgeStarts: edgeStarts,
      ref: reference === undefined || reference === null ? null : reference,
      hasNodes: starts.length > 0,
    }
  }

  /**
   * 指针按下时**只登记**，等真的拖动起来再抢 pointer capture。
   *
   * 为什么不能按下就抢（这是一个真实事故）：pointer capture 会把随后的 **click / dblclick
   * 的目标改成捕获元素**。规范里 click 取"按下与松开两个目标的公共祖先"，而被捕获的
   * `pointerup` 目标是捕获元素，于是 click 就落到画布容器上 —— 按在节点上双击时，
   * 节点那个 `<g>` 根本不在事件路径里，`onDoubleClick` 永远不触发
   * （Chrome 把这种行为判为 working as intended，见 w3c/pointerevents#356）。
   * 症状就是用户报的"双击节点无法更改节点内容"。
   *
   * 我们抢捕获的唯一理由是"拖动过程中指针离开画布也别丢事件"，而那只在**真的动了**之后才有意义：
   * 所以按下先记一笔，在 pointermove 里移动超过阈值（3px，与"越 3px 才算拖"同一套手感）时才抢。
   * 一次"按下-松开没动"的点击因此完全不抢捕获，click/dblclick 仍由浏览器按命中测试派发。
   */
  function requestCapture(event) {
    pendingCaptureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  /** pointermove 里的第一件事：动得够远了就把登记过的捕获真正抢下来。 */
  function takePendingCapture(event) {
    const pending = pendingCaptureRef.current
    if (pending === null || pending.pointerId !== event.pointerId) return
    if (Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y) <= CAPTURE_MOVE_PX) return
    pendingCaptureRef.current = null
    const element = canvasRef.current
    if (element === null || typeof element.setPointerCapture !== 'function') return
    try {
      element.setPointerCapture(event.pointerId)
    } catch (error) {
      // 捕获失败不影响拖动：指针仍在画布内时会继续派发 pointermove
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
    // 位移的基准取**抓起来的这个节点**：它的落点会被吸到格线上，其余成员跟同一个位移。
    const node = nodeById(id)
    const reference = node === null ? null : { x: numberOr(node.x, 0), y: numberOr(node.y, 0) }
    startSelectionDrag(ids, point, reference)
    requestCapture(event)
  }

  /**
   * 按在**连线**上：选中它（或保留整组），并准备好拖动整组。
   *
   * 这样"框选全部之后随手抓住一条线拖"也能整体移动 —— 只抓节点拖的话，
   * 用户会以为线不能被拖。折点/自由端点都没有的边（纯自动路由）拖不动：
   * 它没有"自己的几何"可以平移，改形状要用段把手（拖动某一段）。
   */
  function onEdgePointerDown(edgeId, event) {
    if (event.button !== 0) return
    setMenu(null)
    const additive = event.shiftKey === true
    let ids = selectedIds
    if (additive) {
      ids = ids.indexOf(edgeId) >= 0 ? ids.filter((x) => x !== edgeId) : ids.concat([edgeId])
    } else if (ids.indexOf(edgeId) < 0) {
      ids = [edgeId]
    }
    setSelectedIds(ids)
    const point = toUserSpace(event)
    if (point === null) return
    // 抓的是连线：位移基准取选区里的第一个节点（有节点就跟它对齐格线），没有就按半格吸附。
    const current = docRef.current
    let reference = null
    if (current !== null) {
      for (let i = 0; i < current.nodes.length; i += 1) {
        if (ids.indexOf(current.nodes[i].id) < 0) continue
        reference = { x: numberOr(current.nodes[i].x, 0), y: numberOr(current.nodes[i].y, 0) }
        break
      }
    }
    startSelectionDrag(ids, point, reference)
    requestCapture(event)
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
    // 这里曾经有一条"同向边已存在就直接 return"的守卫 —— 它会**无声**吞掉整个手势：
    // 实测过（demo 里已有 n1→canvas 时，从 n1 往 canvas 拖永远没反应）。
    // drawio 允许同一条两端之间有多条边（各自带自己的连接点与画法），所以这里不再拦。
    //
    // 自环（把线放回起点节点自己）：**允许** —— drawio 就是这么做的。
    // 只要进出口不是同一个侧：同侧会从原路折回，屏幕上什么都看不见。
    const selfLoop = linking.from === id
    let entrySide = chosenTo
    if (selfLoop) entrySide = chosenTo !== null && chosenTo !== linking.side ? chosenTo : nextSideOf(linking.side)
    // 用户选中的两个端点写进 style 的 exitX/exitY 与 entryX/entryY（drawio 的固定连接点）。
    // v1 是把桩点塞进 edge.points —— 那等于把"接在哪一侧"伪装成一个折点，
    // 端点一动它就成了过期坐标（宿主重排时只能清掉，约束也就丢了）。
    let style = DEFAULT_EDGE_STYLE
    if (typeof linking.side === 'string' && linking.side.length > 0) style = styleWithSide(style, 'source', linking.side)
    if (typeof entrySide === 'string' && entrySide.length > 0) style = styleWithSide(style, 'target', entrySide)

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
      const fresh = { id: 'e' + (max + 1), from: linking.from, to: id, style: style }
      if (activeLayerId !== null && activeLayerId !== undefined) fresh.layer = activeLayerId
      next.edges.push(fresh)
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
      width: numberOr(node.w, FALLBACK_NODE_W) * scale,
      height: numberOr(node.h, FALLBACK_NODE_H) * scale,
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
    const route = routePreviewFor(current, geometry, point, link.from, fromBox.geo, link, HOT_PAD, null)
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
   * 拖线落在**空白处**：建一条一端悬空的边（drawio 里拖到空白就是画一条"还没接上"的线）。
   *
   * 文档里那一端不写 `to`，只写 `targetPoint` —— 与 drawio 一致：
   * `sourcePoint`/`targetPoint` 只在该端**没有**真实顶点时才生效。
   */
  function finishDanglingEdge(point) {
    const link = linkRef.current
    const current = docRef.current
    clearConnect()
    if (link === null || current === null || point === null) return
    if (nodeById(link.from) === null) return
    let style = DEFAULT_EDGE_STYLE
    if (typeof link.side === 'string' && link.side.length > 0) style = styleWithSide(style, 'source', link.side)
    applyLocal((next) => {
      let max = 0
      const re = /^e(\d+)$/
      for (let i = 0; i < next.edges.length; i += 1) {
        const m = re.exec(String(next.edges[i].id))
        if (m !== null && parseInt(m[1], 10) > max) max = parseInt(m[1], 10)
      }
      next.edges.push({ id: 'e' + (max + 1), from: link.from, targetPoint: { x: point.x, y: point.y }, style: style })
    })
    setSaveNote('连出一条悬空端：把它的端点拖到节点上就接上了')
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
    requestCapture(event)
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
    requestCapture(event)
  }

  /** 中键按下（在任何位置都生效，包括压在节点上）：拖动画布。 */
  function onCanvasPointerDown(event) {
    if (event.button !== 1) return
    event.preventDefault()
    startPan(event, 1)
  }

  function onCanvasPointerMove(event) {
    // 第一件事：真的动起来了才把 pointer capture 抢下来（见 requestCapture 的注释 ——
    // 按下就抢会让 click/dblclick 的目标变成画布容器，节点双击改标签会失灵）。
    takePendingCapture(event)
    const pan = panRef.current
    if (pan !== null) {
      const dxPx = event.clientX - pan.startClientX
      const dyPx = event.clientY - pan.startClientY
      if (Math.abs(dxPx) > 1 || Math.abs(dyPx) > 1) pan.moved = true
      setViewOverride({ x: pan.viewX - dxPx / pan.scale, y: pan.viewY - dyPx / pan.scale, w: pan.w, h: pan.h })
      return
    }
    // 拖边标签：越过 3px 才算"拖"（否则按住不放也点选一下，不该改文档）。
    const labelDrag = labelDragRef.current
    if (labelDrag !== null) {
      const at = toUserSpace(event)
      if (at === null) return
      if (labelDrag.moved === false && Math.abs(at.x - labelDrag.originX) + Math.abs(at.y - labelDrag.originY) > 3) labelDrag.moved = true
      if (labelDrag.moved) moveEdgeLabel(labelDrag.edgeId, at)
      return
    }
    const drag = dragRef.current
    if (drag !== null) {
      const point = toUserSpace(event)
      if (point === null) return
      // 整组一起移动：**同一个位移**作用在节点、折点、自由端点上，相对位置不变。
      // 吸附只做一次（在 dragMoveOf 里），逐点各自吸附会把相对位置弄歪。
      let move = dragMoveOf(drag, point)
      // 对齐辅助线（drawio 的 guides）：与**没在拖的**节点比 左/中/右、上/中/下 六条线，
      // 差在 6px 内就再吸过去，并把那条线画出来。以**整组的外接框**为准。
      const live = docRef.current
      let guideLines = []
      if (live !== null && drag.starts.length > 0) {
        const movedIds = drag.starts.map((s) => s.id)
        const box = boxOfBoxes(drag.starts.map((s) => ({ x: s.x + move.x, y: s.y + move.y, w: s.w, h: s.h })))
        const others = []
        const hiddenForGuides = hiddenLayerIds(live)
        for (let i = 0; i < live.nodes.length; i += 1) {
          const n = live.nodes[i]
          if (movedIds.indexOf(n.id) >= 0) continue
          if (isHiddenCell(hiddenForGuides, n)) continue
          others.push({ x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, FALLBACK_NODE_W), h: numberOr(n.h, FALLBACK_NODE_H) })
        }
        if (box !== null && others.length > 0) {
          const snapped = alignGuidesFor(others, box, 6)
          if (snapped.dx !== 0 || snapped.dy !== 0) move = { x: move.x + snapped.dx, y: move.y + snapped.dy }
          guideLines = snapped.guides
        }
      }
      setGuides(guideLines)
      const moved = draggedGeometry(drag, move)
      const key = 'drag:' + drag.starts.map((s) => s.id).join(',') + '|' + drag.edgeStarts.map((e) => e.id).join(',')
      applyLocal((next) => {
        for (let i = 0; i < moved.nodes.length; i += 1) {
          for (let k = 0; k < next.nodes.length; k += 1) {
            if (next.nodes[k].id !== moved.nodes[i].id) continue
            next.nodes[k].x = moved.nodes[i].x
            next.nodes[k].y = moved.nodes[i].y
            break
          }
        }
        for (let i = 0; i < moved.edges.length; i += 1) {
          const item = moved.edges[i]
          for (let k = 0; k < next.edges.length; k += 1) {
            const e = next.edges[k]
            if (e.id !== item.id) continue
            if (item.points !== null) e.points = item.points.map((p) => ({ x: p.x, y: p.y }))
            if (item.sourcePoint !== null) e.sourcePoint = { x: item.sourcePoint.x, y: item.sourcePoint.y }
            if (item.targetPoint !== null) e.targetPoint = { x: item.targetPoint.x, y: item.targetPoint.y }
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
      // 缩放的最小单位是**一格**：交给 resizeBox（尺寸按 GRID 吸附、对边原地不动、下限也取整格）。
      const box = resizeBox(
        { x: resize.x, y: resize.y, w: resize.w, h: resize.h },
        resize.dir,
        point.x - resize.originX,
        point.y - resize.originY,
      )
      const x = box.x
      const y = box.y
      const w = box.w
      const h = box.h
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
        //
        // 最小移动单位是**半格**（EDGE_GRID = 5px）：连线比节点需要更细的手感。
        // 做法是把**参考点**（被拖那一段的一个端点）的目标坐标吸附到 5px，再换算成统一位移 ——
        // 两个端点用同一个位移，段本身的形状不会被吸附弄歪（逐点各自吸附会让"几乎水平"的段产生倾斜）。
        const refPoint = edgeDrag.a < edgeDrag.base.length ? edgeDrag.base[edgeDrag.a] : edgeDrag.base[0]
        const move = segmentMoveOf(refPoint, edgeDrag.horizontal, point.x - edgeDrag.originX, point.y - edgeDrag.originY)
        const moveX = move.x
        const moveY = move.y
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
    // 手势结束：还没抢下来的捕获登记也一起作废（这一轮没拖动 = 就是一次点击，
    // 不该在后面的某次 move 里突然抢捕获）。
    pendingCaptureRef.current = null
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
    labelDragRef.current = null
    setGuides([])
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
      else {
        // 落在空白处：把这一端留成**悬空端**（drawio 里拖到空白就是画一条"还没接上"的线）。
        // 目标端点用松手时的指针位置（吸附到半格）—— 与折点同一套单位。
        const at = event === null || event === undefined ? null : toUserSpace(event)
        const target = at === null ? connectTo : at
        finishDanglingEdge(target === null ? null : { x: snap(target.x, EDGE_GRID), y: snap(target.y, EDGE_GRID) })
      }
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
      w: numberOr(node.w, FALLBACK_NODE_W),
      h: numberOr(node.h, FALLBACK_NODE_H),
    }
    requestCapture(event)
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

  /** 收尾框选：没拖动过就是一次"点空白"（取消选中），否则按矩形相交挑节点与连线。 */
  function finishMarquee() {
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
    const hits = marqueeHits(current, { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, routeMemoryRef.current)
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

  /** 连线的 id 分配（与宿主 nextId 同一套规则：扫 e<n> 取 max+1）。 */
  function nextEdgeId(doc) {
    let max = 0
    const re = /^e(\d+)$/
    for (let i = 0; i < doc.edges.length; i += 1) {
      const m = re.exec(String(doc.edges[i].id))
      if (m !== null) {
        const n = parseInt(m[1], 10)
        if (n > max) max = n
      }
    }
    return 'e' + (max + 1)
  }

  function createNodeAt(shape, styleName, userX, userY) {
    const current = docRef.current
    if (current === null) return
    const id = nextNodeId(current)
    const isText = shape === 'text'
    // 形状与配色都落成 drawio 的 style 键：rect/plain 落成空串（= drawio 的 defaultVertexStyle）。
    // 文字**不吃配色**：它的样式就是 drawio 的 defaultTextStyle（无边框无底色），
    // 往上盖 fillColor/strokeColor 只会让文件与 drawio 不一致，画面上也什么都看不出来。
    const style = isText ? styleWithNodeShape('', shape) : styleWithColorName(styleWithNodeShape('', shape), styleName)
    applyLocal((next) => {
      const node = {
        id: id,
        label: isText ? '文字' : '新节点',
        style: style,
        x: snap(userX - NEW_NODE_W / 2),
        y: snap(userY - NEW_NODE_H / 2),
        w: NEW_NODE_W,
        h: NEW_NODE_H,
      }
      // 新节点进**当前图层**（没设过就是第一层）—— drawio 的"当前图层"就是这个意思。
      if (activeLayerId !== null) node.layer = activeLayerId
      next.nodes.push(node)
    })
    setSelectedIds([id])
    setMenu(null)
    // 文字放下来就直接进编辑态（drawio 的 insertText 也是放完立刻 startEditing）：
    // 否则用户还得再双击一次，而屏幕上只是一小块淡淡的选择框。
    if (isText) openNodeEditor(id)
  }

  /**
   * 在空白处新建一条**独立连线**（两端都不接节点）。
   *
   * drawio 的模型里这是合法形态：边的两端都可以是自由点（几何里的 sourcePoint/targetPoint），
   * `edgeFreePoint` / `endpointBoxOf` 早就按这套语义实现了（两端各给一个零尺寸虚拟盒去路由）。
   * 缺的只是"从零画一条"的入口 —— 原来只能从节点手柄拖出来，于是至少有一端是节点。
   * 画完之后照样能拖端点接到节点上（改接端点那套手势对自由端点同样有效）。
   */
  function createFreeEdgeAt(userX, userY, kind) {
    const current = docRef.current
    if (current === null) return
    const id = nextEdgeId(current)
    const from = { x: snap(userX, EDGE_GRID), y: snap(userY, EDGE_GRID) }
    const to = { x: from.x + 200, y: from.y }
    const straight = kind === 'straight'
    applyLocal((next) => {
      const edge = { id: id, style: straight ? styleWithLineKind(DEFAULT_EDGE_STYLE, 'straight') : DEFAULT_EDGE_STYLE, sourcePoint: from, targetPoint: to }
      if (activeLayerId !== null) edge.layer = activeLayerId
      next.edges.push(edge)
    })
    setSelectedIds([id])
    setMenu(null)
    setSaveNote(straight ? '已放一条直线（两端都没接节点、没有折点）' : '已放一条独立连线（两端都没接节点）—— 拖它的端点即可接到节点上')
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


  /** 改节点样式：`ids` 可以是整组（见 styleTargets）——选区里点一个，整组一起换。 */
  function updateNode(ids, patch) {
    const list = Array.isArray(ids) ? ids : [ids]
    // 故意不关菜单：改形状/换配色是可以连点几次试的，弹一次关一次很难用。
    applyLocal((next) => {
      for (let i = 0; i < next.nodes.length; i += 1) {
        if (list.indexOf(next.nodes[i].id) < 0) continue
        const keys = Object.keys(patch)
        for (let k = 0; k < keys.length; k += 1) next.nodes[i][keys[k]] = patch[keys[k]]
      }
    })
  }

  /**
   * 按住**线上的文字**：选中这条线，并准备拖动它（drawio 的标签手柄行为）。
   *
   * 只是"按住"还不算拖：指针真的移动了才开始写位置（否则一次普通的点选也会改文档）。
   * 不 preventDefault —— 双击改标签要靠浏览器把 dblclick 送到这个元素上。
   */
  function onEdgeLabelPointerDown(edgeId, event) {
    if (event.button !== 0) return
    setSelectedIds([edgeId])
    setMenu(null)
    const point = toUserSpace(event)
    if (point === null) return
    labelDragRef.current = { edgeId: edgeId, originX: point.x, originY: point.y, moved: false }
    // 同上：按下不抢捕获（抢了 dblclick 就落到画布容器上，"双击改线上的字"会失灵）。
    requestCapture(event)
  }

  /** 拖标签的每一帧：指针先**吸附**（半格 + 贴线），再反解成 drawio 的相对位置。 */
  function moveEdgeLabel(edgeId, point) {
    const current = docRef.current
    if (current === null) return
    const edge = edgeById(edgeId)
    if (edge === null) return
    const pts = edgeRoutePoints(current, edge, routeMemoryRef.current)
    if (pts === null) return
    const pos = labelPosFor(pts, snapLabelPoint(pts, point))
    if (pos === null) return
    // 合并键：一次拖动只压一格撤销历史（与拖节点同一套）。
    applyLocal((next) => {
      for (let i = 0; i < next.edges.length; i += 1) {
        if (next.edges[i].id !== edgeId) continue
        next.edges[i].labelX = pos.labelX
        next.edges[i].labelY = pos.labelY
        next.edges[i].labelOffsetX = pos.labelOffsetX
        next.edges[i].labelOffsetY = pos.labelOffsetY
        break
      }
    }, 'label:' + edgeId)
  }

  /** 标签回到弧长中点（drawio 里把标签拖回去 / 重置位置的效果）。 */
  function centerEdgeLabel(id) {
    applyLocal((next) => {
      for (let i = 0; i < next.edges.length; i += 1) {
        if (next.edges[i].id !== id) continue
        delete next.edges[i].labelX
        delete next.edges[i].labelY
        delete next.edges[i].labelOffsetX
        delete next.edges[i].labelOffsetY
        break
      }
    })
    setMenu(null)
  }

  /**
   * 改连线的画法：全部落成 style 键（dashed/dashPattern/endArrow/startArrow/strokeColor）。
   * 回到默认 = **删键**，不写 `dashed=0` 之类的冗余 —— 与宿主 edgeStyleFromOp 同一套语义。
   */
  function updateEdge(ids, patch) {
    const list = Array.isArray(ids) ? ids : [ids]
    applyLocal((next) => {
      for (let i = 0; i < next.edges.length; i += 1) {
        const e = next.edges[i]
        if (list.indexOf(e.id) < 0) continue
        let style = typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE
        if (has(patch, 'dash')) style = styleWithDash(style, patch.dash)
        if (has(patch, 'arrow')) style = styleWithArrow(style, patch.arrow)
        if (has(patch, 'line')) style = styleWithLineKind(style, patch.line)
        if (has(patch, 'fontSize')) style = stylePatch(style, { fontSize: patch.fontSize === null ? null : String(patch.fontSize) })
        if (has(patch, 'color')) {
          style = stylePatch(style, { strokeColor: typeof patch.color === 'string' && patch.color.length > 0 ? patch.color : null })
        }
        e.style = style
      }
    })
  }

  /**
   * 换连线的**线型**（直线 / 直角折线 / 圆角折线 / 曲线）—— 比 updateEdge 多做一件几何上的事。
   *
   * - 直线（无折点）：必须把折点清掉。留着折点 + `edgeStyle=none` 在 drawio 里会画成
   *   "穿过折点的折线"，不是用户按「直线」时想要的东西。
   * - 直角/圆角折线：折点照旧有意义（就是折线的拐角），什么都不动，只改 style 键。
   * - 曲线：`curved=1` 是把**现有走线**抹圆。走线本来就带拐角（自动路由的 L 形、或人摆的折点）时
   *   直接就能看见弧度；但如果这条边是两点直连（完全共线），drawio 的曲线会退化成直线
   *   （mxPolyline.paintCurvedLine 在两点时控制点落在起点上）—— 那时补一个**垂直弓形的中点**，
   *   弧才真的看得见。这跟人在 drawio 里手动拖一个中点出来是同一件事。
   */
  function applyLineKind(ids, kind) {
    const current = docRef.current
    if (current === null) return
    const list = Array.isArray(ids) ? ids : [ids]
    applyLocal((next) => {
      for (let i = 0; i < next.edges.length; i += 1) {
        const e = next.edges[i]
        if (list.indexOf(e.id) < 0) continue
        const style = typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE
        e.style = styleWithLineKind(style, kind)
        if (kind === 'straight') {
          delete e.points
          continue
        }
        if (kind !== 'curved') continue
        const hasPoints = Array.isArray(e.points) && e.points.length > 0
        if (hasPoints) continue
        const pts = edgeRoutePoints(next, e, routeMemoryRef.current)
        if (pts === null || pts.length < 2) continue
        let turns = false
        for (let k = 1; k < pts.length - 1; k += 1) {
          const a = pts[k - 1]
          const b = pts[k]
          const c = pts[k + 1]
          if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 0.5) {
            turns = true
            break
          }
        }
        if (turns) continue
        const ax = pts[0].x
        const ay = pts[0].y
        const bx = pts[pts.length - 1].x
        const by = pts[pts.length - 1].y
        const dx = bx - ax
        const dy = by - ay
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len < 1) continue
        // 弓高：取长度的 12%，至少 20px、至多半格对齐后的整数（折点单位就是半格）
        const bow = Math.max(20, Math.round((len * 0.12) / EDGE_GRID) * EDGE_GRID)
        e.points = [{ x: snap((ax + bx) / 2 - (dy / len) * bow, EDGE_GRID), y: snap((ay + by) / 2 + (dx / len) * bow, EDGE_GRID) }]
      }
    })
  }

  /** 全选：节点与连线都进选区（Ctrl+A / 「编辑 → 全选」）。 */
  function selectAll() {
    const current = docRef.current
    if (current === null) return
    const ids = allIdsOf(current)
    setMenu(null)
    setSelectedIds(ids)
    setSaveNote(ids.length === 0 ? '这张画布还是空的' : '已全选 ' + ids.length + ' 项')
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
      requestCapture(event)
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
      const pts = edgeRoutePoints(current, edge, routeMemoryRef.current)
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
      requestCapture(event)
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
    const current = docRef.current
    if (current === null) return
    const dragged = edgeById(drag.edgeId)
    if (dragged === null) return

    // ── 松手落在空白处：这一端**脱离形状**，变成悬空端（drawio 里也是这么做的）──
    // 文档里就用 sourcePoint/targetPoint 表示：那一端没有真实顶点时它才生效。
    if (targetId === null) {
      const at = toUserSpace(event)
      if (at === null) return
      const free = { x: snap(at.x, EDGE_GRID), y: snap(at.y, EDGE_GRID) }
      applyLocal((next) => {
        for (let i = 0; i < next.edges.length; i += 1) {
          const e = next.edges[i]
          if (e.id !== drag.edgeId) continue
          if (drag.kind === 'from') {
            delete e.from
            e.sourcePoint = { x: free.x, y: free.y }
            e.style = styleWithSide(typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE, 'source', null)
          } else {
            delete e.to
            e.targetPoint = { x: free.x, y: free.y }
            e.style = styleWithSide(typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE, 'target', null)
          }
          break
        }
      })
      setSaveNote('这一端已脱离形状（悬空端）；再拖回去就能重新连上')
      return
    }

    const movedNode = nodeById(targetId)
    if (movedNode === null) return
    const fixedNode = nodeById(drag.kind === 'from' ? dragged.to : dragged.from)
    // 固定端也可能是悬空端（另一端拖回来时）：它的坐标从自由点来，不再是节点。
    const fixedBox =
      fixedNode !== null
        ? { id: fixedNode.id, geo: nodeGeoOf(fixedNode) }
        : endpointBoxOf(buildGeometry(current).byId, dragged, drag.kind === 'from' ? 'target' : 'source')
    if (fixedBox === null) return
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
    const pts = edgeRoutePoints(current, edge, routeMemoryRef.current)
    const label = pts === null ? null : edgeLabelPosition(pts, edge)
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
        width: numberOr(node.w, FALLBACK_NODE_W) * scale,
        height: numberOr(node.h, FALLBACK_NODE_H) * scale,
      }
    } else {
      const edge = edgeById(editing.id)
      if (edge === null) {
        setEditing(null)
        return
      }
      const pts = edgeRoutePoints(current, edge, routeMemoryRef.current)
      const label = pts === null ? null : edgeLabelPosition(pts, edge)
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
    // 文字没改就**不要写**：不然"点开编辑框、又点空白处关掉"会平白多一步撤销历史
    // （用户按 Ctrl+Z 时屏幕毫无变化，看起来像撤销坏了）。
    const before = current.kind === 'edge' ? edgeById(current.id) : nodeById(current.id)
    const beforeLabel = before === null || before === undefined ? null : typeof before.label === 'string' ? before.label : ''
    if (beforeLabel === label) return
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

  /**
   * 一次性几何迁移：把这张画布上的几何对齐到格线（节点整格、折点与自由端点半格）。
   *
   * 为什么值得有一个手动入口：画布自己的手势是吸附的，但从 drawio 手画来的图、
   * AI 早期写下的坐标、旧版本估宽留下的 186/56 这种尺寸都不会自己变整齐 ——
   * 而"差几像素的台阶"正是"同一条线上两个段把手""连线抖动"那类毛病的温床。
   * 只动几何，style / 标签 / 两端约束 / 层级一律不碰。
   */
  function normalizeGeometry() {
    const current = docRef.current
    if (current === null) return
    const result = snapDocGeometry(current, { grid: GRID, edgeGrid: EDGE_GRID, minW: MIN_NODE_W, minH: MIN_NODE_H })
    setMenu(null)
    if (result.changes === 0) {
      setSaveNote('几何已经都在格线上，不用整理')
      return
    }
    applyLocal((next) => {
      next.nodes = result.doc.nodes
      next.edges = result.doc.edges
    })
    setSaveNote('已整理 ' + result.changes + ' 处几何（节点对齐整格、折点对齐半格；可 Ctrl+Z 撤销）')
  }

  /**
   * 顺序（z-order）：节点的先后 = 画布上的覆盖顺序，也是 drawio 里"谁在上面"。
   *
   * 只改模型数组顺序；**文件那边的先后由写回负责**（`planReorder`），
   * 不写回去的话重新载入就变回原样，用户会觉得"置顶没生效"。
   */
  function reorderItem(kind, id, mode) {
    const current = docRef.current
    if (current === null) return
    applyLocal((next) => {
      const list = kind === 'edge' ? next.edges : next.nodes
      let at = -1
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].id === id) {
          at = i
          break
        }
      }
      if (at < 0) return
      const item = list.splice(at, 1)[0]
      if (mode === 'front') list.push(item)
      else if (mode === 'back') list.unshift(item)
      else if (mode === 'up') list.splice(Math.min(at + 1, list.length), 0, item)
      else list.splice(Math.max(at - 1, 0), 0, item)
    })
    setMenu(null)
  }

  /**
   * 「编辑数据…」：把 drawio 用户对象上的自定义属性摊成 `key=value` 几行来改。
   *
   * 数据最终写在 `<object>` 包装上（mxCell 上的陌生属性会被 drawio 保存时丢掉），
   * 所以这里只管"键值对"，包装的事交给写回；裸单元第一次加数据时写回会自动包一层。
   */
  function openDataEditor(kind, id) {
    const item = kind === 'edge' ? edgeById(id) : nodeById(id)
    if (item === null) return
    setSelectedIds([id])
    setMenu(Object.assign({}, menu, { kind: 'data', dataKind: kind, id: id, text: formatDataLines(item.data) }))
  }

  function commitDataEditor(kind, id, text) {
    const data = parseDataLines(text)
    applyLocal((next) => {
      const list = kind === 'edge' ? next.edges : next.nodes
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].id !== id) continue
        if (Object.keys(data).length === 0) delete list[i].data
        else list[i].data = data
        break
      }
    })
    setMenu(null)
    const count = Object.keys(data).length
    setSaveNote(count === 0 ? '已清空这条单元的数据' : '已保存 ' + count + ' 项数据（写在 <object> 上，drawio 也认）')
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

  /** 复制选区（节点 + 两端都在选区内的边）。剪贴板是模块级的，跨标签页粘贴也成立。 */
  function copySelection() {
    const current = docRef.current
    const clip = collectClipboard(current, selectedIds)
    if (clip === null) {
      setSaveNote('没有可复制的东西：先选中节点（Shift 加选）')
      return
    }
    clipboard = clip
    setMenu(null)
    setSaveNote('已复制 ' + clip.nodes.length + ' 个节点' + (clip.edges.length > 0 ? ' / ' + clip.edges.length + ' 条连线' : ''))
  }

  /** 剪切 = 复制 + 删除（一次撤销能退回：删除走的是 applyLocal 的历史）。 */
  function cutSelection() {
    const current = docRef.current
    const clip = collectClipboard(current, selectedIds)
    if (clip === null) {
      setSaveNote('没有可剪切的东西：先选中节点（Shift 加选）')
      return
    }
    clipboard = clip
    setSaveNote('已剪切 ' + clip.nodes.length + ' 个节点' + (clip.edges.length > 0 ? ' / ' + clip.edges.length + ' 条连线' : ''))
    deleteSelected()
  }

  /**
   * 粘贴：整体平移两格（20px）——与原件错开，一眼能看出哪一份是新贴的；
   * 新单元重新分配 id，拼完选中它们，方便接着拖。
   */
  function pasteClipboard() {
    const current = docRef.current
    if (current === null) return
    if (clipboard === null) {
      setSaveNote('剪贴板是空的：先复制或剪切点什么')
      return
    }
    let pasted = null
    applyLocal((next) => {
      const result = pasteInto(next, clipboard, GRID * 2, GRID * 2, activeLayerId)
      if (result === null) return
      pasted = result
      next.nodes = result.doc.nodes
      next.edges = result.doc.edges
    })
    setMenu(null)
    if (pasted !== null) {
      setSelectedIds(pasted.ids)
      setSaveNote('已粘贴 ' + pasted.ids.length + ' 项')
    }
  }

  React.useEffect(() => {
    function onKey(event) {
      // 归属判定见 canvasOwnsKeyboard：**在别处打字时这里一律不动手**。
      // 之前只挡了 input/textarea，而 DSH 的输入框是 contenteditable，
      // 于是输入框里按退格会删掉画布里的选中内容、Ctrl+C/V 也被吞掉。
      if (!canvasOwnsKeyboard(event, rootRef.current, document.activeElement)) return
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
      // 复制 / 剪切 / 粘贴：与 drawio 同一套快捷键（Ctrl+C / Ctrl+X / Ctrl+V）。
      // 必须挡在输入框之外 —— 上面的归属判定已经保证在改标签时不会走到这里。
      if (accel && (event.key === 'c' || event.key === 'C')) {
        event.preventDefault()
        copySelection()
        return
      }
      if (accel && (event.key === 'x' || event.key === 'X')) {
        event.preventDefault()
        cutSelection()
        return
      }
      if (accel && (event.key === 'v' || event.key === 'V')) {
        event.preventDefault()
        pasteClipboard()
        return
      }
      // 全选：与框选同一套语义（节点与连线都选上），于是能整体拖动/换样式/一把删掉。
      if (accel && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault()
        selectAll()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
      } else if (event.key === 'Escape') {
        setSelectedIds([])
        setEditing(null)
        setMenu(null)
        // 下拉菜单与「打开/新建/另存为」面板也一起收掉：Esc 是"退出当前这层"，
        // 菜单开着却按 Esc 没反应会让人以为键盘坏了（与外面点一下同一个语义）。
        setDocMenu(null)
        setDocMenuPos(null)
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

  /**
   * 量容器尺寸。
   *
   * **容器尺寸变了要"保持缩放比例"，只改变可见范围** —— 这一个动作同时修掉两个症状
   * （用户实测报过："拖侧边栏，画布跟着缩放、内容还畸形"）：
   *
   *   1. 保持 scale（screen px / 用户单位）→ 内容不会被重新缩放；
   *   2. 新的 w/h 由**同一个 scale** 推出来 → 视口宽高比恒等于容器。SVG 用的是
   *      `preserveAspectRatio="none"`（1:1 贴像素），比例一旦不一致就会把画面拉伸变形。
   *
   * 旧的写法是"每次渲染都按当前容器宽高比重算 fitView"：右栏一被拖宽，缩放就跟着变；
   * 而一旦用户自己缩放过（viewOverride 非空），冻结的 h 与新容器的宽高比对不上 ——
   * 于是画面被横向拉扁，正是"内容畸形"。
   *
   * 两个 setState 在同一个回调里，React 会合成一次渲染 —— 不会先按新尺寸自适应一帧
   * 再被纠正回来（那会看见闪一下）。
   *
   * 副作用：调整之后视口就是显式的了，不再跟着内容自动变化；要重新贴合按「视图 → 适应内容」。
   */
  React.useEffect(() => {
    if (!canvasReady) return undefined
    const element = canvasRef.current
    if (element === null) return undefined
    function measure() {
      const w = element.clientWidth
      const h = element.clientHeight
      if (w <= 0 || h <= 0) return
      const prev = measuredRef.current
      const current = viewRef.current
      const known = prev.w > 0 && prev.h > 0
      if (known && (prev.w !== w || prev.h !== h)) {
        const resized = resizeViewFor(current, prev, { w: w, h: h })
        if (resized !== null) setViewOverride(resized)
      }
      measuredRef.current = { w: w, h: h }
      setSize({ w: w, h: h })
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
    // 导出文件名：绑定文件就用它的名字；没有绑定就叫 'diagram'，别去借 demo 的名字。
    const source = typeof status.path === 'string' && status.path.length > 0 && status.path[0] !== '(' ? status.path : 'diagram'
    const name = String(source).split(/[\\/]/).pop().replace(/\.drawio$/i, '')
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

    // 空舞台：一张画布都还没打开 —— **不造任何文档、不读也不写任何文件**，由 UI 给出提示。
    // 这里曾经造一份"未命名/未绑定"的本地空文档让用户"自救"，结果面板一打开就是个幽灵画布：
    // 屏幕上有一张空白图、却没有任何文件，用户以为在编辑什么、其实什么都没绑定。
    // 现在改成真正的空：要画布就自己「新建画布…」或「打开…」（两个入口都在工作栏里）。
    if (!hasPath) {
      docRef.current = null
      revisionRef.current = 0
      dirtyRef.current = false
      resetHistory()
      setDoc(null)
      setStatus({ kind: 'empty', path: '', error: '', absolute: '' })
      return undefined
    }

    let alive = true
    // 非活动标签不轮询：它只是被 display:none 藏着，没必要继续打宿主。
    // （但内容仍在内存里 —— 这正是"切换回来还是原样"的代价与收益。）
    if (!active) return undefined
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const signal = controller === null ? undefined : controller.signal

    /**
     * 拉取当前文档：**经宿主读**（`action: 'read'`），客户端不碰 mxfile。
     *
     * 走写回路由而不是 workspaceFiles Remote，是因为 `.drawio` 可能被 drawio 压过
     * （base64 + raw deflate），浏览器解不开；而这条路由本来就有信任围栏（POST + 自定义头 + 同源）。
     */
    async function pull() {
      let payload = null
      try {
        const raw = await fetch(SAVE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SAVE_HEADER]: '1' },
          body: JSON.stringify({ action: 'read', sessionId: sessionId, path: target }),
          signal: signal,
        })
        payload = await raw.json()
      } catch (error) {
        if (!alive) return
        const message = error && error.message ? error.message : String(error)
        setStatus((prev) => (prev.kind === 'error' && prev.error === message ? prev : { kind: 'error', path: target, error: message, absolute: prev.absolute }))
        return
      }
      if (!alive) return

      const parsed = docFromPayload(payload)
      const absolute = parsed.absolute !== undefined && parsed.absolute.length > 0 ? parsed.absolute : target
      // AI 的两件事顺路带回来（在 revision 去重之前处理 —— 它们和文件变没变无关）：
      //   highlight —— AI 用 `{op:'highlight', ids}` 请求"你来看这几个"，取到就选中；
      //   canRevert —— 宿主那边有没有可退回的 AI 改动，编辑菜单据此启用。
      const wantHighlight = Array.isArray(payload.highlight) ? payload.highlight : []
      if (wantHighlight.length > 0) {
        setSelectedIds(wantHighlight)
        setSaveNote('AI 选中了 ' + wantHighlight.length + ' 项')
      }
      setCanRevert(payload.canRevert === true)
      if (parsed.error !== undefined) {
        setStatus({ kind: 'error', path: absolute, error: parsed.error, absolute: absolute })
        return
      }
      // 去重与防回环：revision（文件内容指纹）是这里唯一可靠的身份。
      //  - 本地有未落盘的改动 → 不要用服务端版本盖掉工作副本（否则用户正拖着的节点会被弹回去）
      //  - 指纹与我们手上那份相同 → 这就是我们自己刚写出去的文件回声，忽略
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
      // 文件里"画布表示不了、但会原样保留"的东西（多页、图层、图片、HTML 标签…）
      // 必须在工作栏上说清楚 —— 不然用户以为画布就是全部，导出/分享时才发现在别处。
      const notes = Array.isArray(parsed.notes) ? parsed.notes : []
      setSaveNote(notes.length === 0 ? '' : '⚠ ' + notes.join('；'))
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
    guides: guides,
    routeMemory: routeMemoryRef.current,
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
    onEdgePointerDown: onEdgePointerDown,
    onEdgeLabelPointerDown: onEdgeLabelPointerDown,
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

  /**
   * 字号行：节点标签、边标签、独立文字**共用**这一个控件（"文字的字号均可修改"）。
   *
   * 落盘还是 drawio 的 `fontSize` 键（缺省不写键）。「默认」= 删键回到各自缺省
   * （节点/文字 12、连线 10），其余是常用档位。
   */
  function fontSizeRow(style, apply) {
    const current = styleNumber(style, 'fontSize', null)
    const items = [[null, '默认']].concat(FONT_SIZE_PRESETS.map((n) => [n, String(n)]))
    return React.createElement(
      'div',
      { className: 'drawai-menu-row' },
      items.map((it) =>
        React.createElement(
          'button',
          {
            key: 'fs-' + String(it[0]),
            className: 'drawai-btn' + (String(current) === String(it[0]) ? ' on' : ''),
            title: it[0] === null ? '回到缺省字号' : '字号 ' + it[0] + 'px',
            onClick: () => apply(it[0]),
          },
          it[1],
        ),
      ),
    )
  }

  /**
   * 右键菜单里的**一类一个下拉**。
   *
   * 以前每一类都把全部选项铺在菜单里（形状 10 个缩略图 + 配色 8 个色块 + 字号 6 个 +
   * 线型 4 个 + 样式 3 个 + 箭头 4 个），右栏又窄，一屏全是按钮、看不出"现在是什么"。
   * 现在一类只占一行：`形状：矩形 ▾`，点开才铺这一类的选项。展开状态记在 menu 对象上
   * （`menu.openKey`）—— 换一个元素右键时 menu 是新对象，下拉自然收起；同一个菜单里
   * 点另一类会把上一类收起来。
   *
   * @returns 要 push 进 rows 的元素数组（未展开时只有一个行按钮）
   */
  /** 选完一个值就把下拉收起来（菜单回到"一类一行"的样子）。 */
  function closeSelect() {
    setMenu(Object.assign({}, menu, { openKey: null }))
  }

  function menuSelect(rowKey, label, currentText, body, hint) {
    const open = menu.openKey === rowKey
    const out = [
      React.createElement(
        'button',
        {
          key: 'sel-' + rowKey,
          className: 'drawai-btn drawai-menu-select' + (open ? ' on' : ''),
          title: hint === undefined ? '展开这一类的可选值' : hint,
          onClick: () => setMenu(Object.assign({}, menu, { openKey: open ? null : rowKey })),
        },
        React.createElement('span', { className: 'drawai-menu-select-label' }, label + '：' + currentText),
        React.createElement('span', { className: 'drawai-menu-caret' }, open ? '▴' : '▾'),
      ),
    ]
    if (open) out.push(React.createElement('div', { key: 'body-' + rowKey, className: 'drawai-menu-select-body' }, body))
    return out
  }

  function renderMenu() {
    if (menu === null) return null
    const rows = []

    // 「编辑数据…」面板：数据就是 drawio 用户对象上的自定义属性，摊成 key=value 几行来改。
    if (menu.kind === 'data') {
      const dataKind = menu.dataKind === 'edge' ? 'edge' : 'node'
      rows.push(menuTitle(dataKind === 'edge' ? '连线的数据' : '节点的数据'))
      rows.push(
        React.createElement('textarea', {
          key: 'data-text',
          className: 'drawai-data',
          autoFocus: true,
          rows: 6,
          value: typeof menu.text === 'string' ? menu.text : '',
          placeholder: '每行一项，形如：\nsubnet=192.168.0\nowner=我',
          onChange: (event) => setMenu(Object.assign({}, menu, { text: event.target.value })),
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setMenu(null)
            }
          },
        }),
      )
      rows.push(React.createElement('div', { className: 'drawai-note' }, '空行与 # 开头的行忽略；没有 = 的行也忽略。这些属性写在 <object> 上，drawio 同样认。'))
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => commitDataEditor(dataKind, menu.id, menu.text) }, '保存'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => setMenu(null) }, '取消'),
        ),
      )
      const leftD = Math.max(0, Math.min(menu.left, size.w - 214))
      const topD = Math.max(0, Math.min(menu.top, size.h - 8))
      return React.createElement('div', { className: 'drawai-menu', style: { left: leftD + 'px', top: topD + 'px' } }, rows)
    }

    if (menu.kind === 'canvas') {
      rows.push(menuTitle('元素库 —— 选一个放到这里'))
      // 形状/配色也只显示"当前值"，选项在下拉里；「＋ 新增节点」放的就是当前形状 + 当前配色。
      rows.push.apply(
        rows,
        menuSelect(
          'shape',
          '形状',
          styleSummary(styleWithNodeShape('', menuShape), 'shape'),
          shapeGrid((shape) => {
            setMenuShape(shape)
            closeSelect()
          }),
          '换一个形状（「＋ 新增节点」用的就是它）',
        ),
      )
      rows.push.apply(
        rows,
        menuSelect(
          'color',
          '配色',
          PALETTE_LABELS[menuStyle] === undefined ? styleSummary(menuStyle, 'color') : PALETTE_LABELS[menuStyle],
          swatchRow((style) => {
            setMenuStyle(style)
            closeSelect()
          }, menuStyle),
          '新建节点用的配色',
        ),
      )
      // 工具条的「＋ 节点」去掉之后，这里补一格"不挑形状、就放一个"的快捷入口：
      // 和上面点某个形状等价（同一个 createNodeAt、同一套新 id 规则），
      // 但不是每个人都记得九宫格里哪个是自己要的方框。
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => createNodeAt(menuShape, menuStyle, menu.userX, menu.userY) }, '＋ 新增节点'),
          // 独立文字：一个只有文字、没有边框底色的元素（drawio 的 text 形状）。
          // 放在这里的原因是"要在哪就放哪"：它不接节点、也不接边，位置就是点的地方。
          React.createElement(
            'button',
            { className: 'drawai-btn', onClick: () => createNodeAt('text', menuStyle, menu.userX, menu.userY), title: '放一段独立文字（无边框无底色，可拖动/改字/改字色）' },
            'T 文字',
          ),
          // 独立线：两端都不接节点（drawio 里的自由形态），之后拖端点就能接到节点上。
          React.createElement(
            'button',
            { className: 'drawai-btn', onClick: () => createFreeEdgeAt(menu.userX, menu.userY), title: '画一条两端都没接节点的线，之后拖它的端点可以接到节点上' },
            '／ 独立连线',
          ),
          // 同一条独立线，但**线型是直线**（`edgeStyle=none`，不带折点）：斜着量一段距离、
          // 拉一条指示线时用得上。之后在连线的右键菜单里可以随时换成折线/曲线。
          React.createElement(
            'button',
            { className: 'drawai-btn', onClick: () => createFreeEdgeAt(menu.userX, menu.userY, 'straight'), title: '画一条两端都不接节点、也不带折点的直线' },
            '╱ 直线',
          ),
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
      // 点中的节点在选区里 → 形状/配色对**整组节点**生效（与删除/拖动/对齐一致）。
      const nodeTargets = styleTargets(selectedIds, menu.id, (id) => nodeById(id) !== null)
      rows.push(menuTitle('节点：' + label + (nodeTargets.length > 1 ? '（共 ' + nodeTargets.length + ' 个）' : '')))
      // 形状与配色都改成**键级改写**：不再往文档里写 shape 字段，也不再用颜色名当 style。
      // 整组改色时以**点中的那个**的当前样式为基准（把它的配色推广给其它成员）。
      // 菜单只显示当前值（形状：矩形 ▾ / 配色：蓝 ▾ / 字号：默认 ▾），选项在下拉里。
      rows.push.apply(
        rows,
        menuSelect(
          'shape',
          '形状',
          styleSummary(nodeStyle, 'shape'),
          shapeGrid((shape) => {
            updateNode(nodeTargets, { style: styleWithNodeShape(nodeStyle, shape) })
            closeSelect()
          }),
        ),
      )
      // 配色：文字元素能换的只有**字色**（它没有填充与描边）—— 否则点了一圈颜色屏幕上毫无变化。
      const isTextNode = nodeShapeFromStyle(nodeStyle) === 'text'
      rows.push.apply(
        rows,
        menuSelect(
          'color',
          '配色',
          styleSummary(nodeStyle, 'color'),
          swatchRow(
            (color) => {
              updateNode(nodeTargets, { style: isTextNode ? styleWithTextColorName(nodeStyle, color) : styleWithColorName(nodeStyle, color) })
              closeSelect()
            },
            isTextNode ? textColorNameFromStyle(nodeStyle) : colorNameFromStyle(nodeStyle),
          ),
          isTextNode ? '独立文字换的是字色' : '填充与描边',
        ),
      )
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => openNodeEditor(menu.id) }, '改标签'),
          React.createElement('button', { className: 'drawai-btn', onClick: copySelection, title: 'Ctrl+C' }, '复制'),
          React.createElement('button', { className: 'drawai-btn', onClick: cutSelection, title: 'Ctrl+X' }, '剪切'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => deleteById(menu.id) }, '删除'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => openDataEditor('node', menu.id) }, '编辑数据…'),
        ),
      )
      // 字号：节点标签与独立文字共用这套控件（文字元素没有填充描边，字号是它少数能改的东西）。
      rows.push.apply(
        rows,
        menuSelect(
          'fontSize',
          '字号',
          styleSummary(nodeStyle, 'fontSize'),
          fontSizeRow(nodeStyle, (v) => {
            updateNode(nodeTargets, { style: stylePatch(nodeStyle, { fontSize: v === null ? null : String(v) }) })
            closeSelect()
          }),
        ),
      )
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('node', menu.id, 'front'), title: '置顶（压在其它节点上面）' }, '置顶'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('node', menu.id, 'up'), title: '上移一层' }, '上移'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('node', menu.id, 'down'), title: '下移一层' }, '下移'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('node', menu.id, 'back'), title: '置底（压到其它节点下面）' }, '置底'),
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
      // 连线菜单同理：点中的连线在选区里 → 线型/箭头/颜色对**整组连线**生效。
      const edgeTargets = styleTargets(selectedIds, menu.id, (id) => edgeById(id) !== null)
      rows.push(menuTitle('连线' + (hasLabel ? '：' + edge.label : '') + (edgeTargets.length > 1 ? '（共 ' + edgeTargets.length + ' 条）' : '')))
      const actions = [React.createElement('button', { key: 'edit', className: 'drawai-btn', onClick: () => openEdgeEditor(menu.id) }, '改标签')]
      // 拖过标签才会出现：把它放回弧长中点（drawio 里是"把标签拖回去"）。
      if (edge !== null && Number.isFinite(Number(edge.labelX)) && Number.isFinite(Number(edge.labelY))) {
        actions.push(React.createElement('button', { key: 'center', className: 'drawai-btn', onClick: () => centerEdgeLabel(menu.id), title: '标签回到线段中点' }, '标签居中'))
      }
      if (hasWaypoints) {
        actions.push(React.createElement('button', { key: 'auto', className: 'drawai-btn', onClick: () => clearEdgeWaypoints(menu.id) }, '自动路由'))
      }
      actions.push(React.createElement('button', { key: 'del', className: 'drawai-btn', onClick: () => deleteById(menu.id) }, '删除'))
      rows.push(React.createElement('div', { className: 'drawai-menu-row' }, actions))

      // 连线的画法。落盘是 style 键（dashed/dashPattern/endArrow/startArrow/strokeColor），
      // 这里只是它的手工入口 —— AI 侧走同一个 setStyle（dash/arrow/color 是糖），两边改的是同一批键。
      // 四类各占一行、**只显示当前值**（线型：直角折线 ▾ / 样式：实线 ▾ / 箭头：→ 单向 ▾ / 字号：默认 ▾），
      // 选项在各自的下拉里 —— 以前一屏铺 3+4+4+6 个按钮，看不出"现在是什么"。
      const edgeBaseStyle = edge === null || typeof edge.style !== 'string' ? DEFAULT_EDGE_STYLE : edge.style
      const edgeDashNow = edge === null ? 'solid' : dashFromStyle(edgeBaseStyle)
      const edgeArrowNow = edge === null ? 'end' : arrowFromStyle(edgeBaseStyle)
      const dashRow = (items) =>
        React.createElement(
          'div',
          { className: 'drawai-menu-row', style: { marginTop: 0, paddingTop: 0, borderTop: 'none' } },
          items.map((it) =>
            React.createElement(
              'button',
              {
                key: it[0],
                className: 'drawai-btn' + (edgeDashNow === it[0] ? ' on' : ''),
                onClick: () => {
                  updateEdge(edgeTargets, { dash: it[0] })
                  closeSelect()
                },
              },
              it[1],
            ),
          ),
        )
      rows.push.apply(rows, menuSelect('dash', '样式', DASH_LABELS[edgeDashNow], dashRow([['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']])))
      // 线型（drawio 的两组键压平成四选一，见内核 styleWithLineKind）：
      //   直线 / 直角折线 / 圆角折线（只在折点处倒角，rounded=1）/ 曲线（curved=1）。
      // 直线会顺手清掉折点，曲线会给"本来就笔直"的那种边补一个弓形中点 —— 理由见 applyLineKind。
      const edgeLineNow = edge === null ? 'sharp' : lineKindFromStyle(edgeBaseStyle)
      const lineRow = (items) =>
        React.createElement(
          'div',
          { className: 'drawai-menu-row', style: { marginTop: 0, paddingTop: 0, borderTop: 'none' } },
          items.map((it) =>
            React.createElement(
              'button',
              {
                key: it[0],
                className: 'drawai-btn' + (edgeLineNow === it[0] ? ' on' : ''),
                title: it[2],
                onClick: () => {
                  applyLineKind(edgeTargets, it[0])
                  closeSelect()
                },
              },
              it[1],
            ),
          ),
        )
      rows.push.apply(
        rows,
        menuSelect(
          'line',
          '线型',
          LINE_KIND_LABELS[edgeLineNow],
          lineRow([
            ['straight', '直线', '两点之间一条直线，不带折点'],
            ['sharp', '直角折线', '正交折线，折点是尖角（drawio 的 Sharp）'],
            ['rounded', '圆角折线', '正交折线，只在折点处倒圆角（rounded=1；半径跟 drawio 一样，缺省 10px）'],
            ['curved', '曲线', '把整条折线抹成平滑曲线；本来笔直的那种会补一个弓形中点，弧才看得见'],
          ]),
        ),
      )
      const arrowRow = (items) =>
        React.createElement(
          'div',
          { className: 'drawai-menu-row', style: { marginTop: 0, paddingTop: 0, borderTop: 'none' } },
          items.map((it) =>
            React.createElement(
              'button',
              {
                key: it[0],
                className: 'drawai-btn' + (edgeArrowNow === it[0] ? ' on' : ''),
                onClick: () => {
                  updateEdge(edgeTargets, { arrow: it[0] })
                  closeSelect()
                },
              },
              it[1],
            ),
          ),
        )
      rows.push.apply(rows, menuSelect('arrow', '箭头', ARROW_LABELS[edgeArrowNow], arrowRow([['end', '→ 单向'], ['both', '↔ 双向'], ['none', '— 无箭头'], ['start', '← 反向']])))
      // 字号：线上的文字（边自己的 value）与挂在边上的独立标签都吃 fontSize。
      rows.push.apply(
        rows,
        menuSelect(
          'fontSize',
          '字号',
          styleSummary(edgeBaseStyle, 'fontSize'),
          fontSizeRow(edgeBaseStyle, (v) => {
            updateEdge(edgeTargets, { fontSize: v })
            closeSelect()
          }),
        ),
      )
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('edge', menu.id, 'front'), title: '置顶（压在其它连线上面）' }, '置顶'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('edge', menu.id, 'up'), title: '上移一层' }, '上移'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('edge', menu.id, 'down'), title: '下移一层' }, '下移'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => reorderItem('edge', menu.id, 'back'), title: '置底' }, '置底'),
        ),
      )
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: () => openDataEditor('edge', menu.id) }, '编辑数据…'),
          React.createElement('button', { className: 'drawai-btn', onClick: () => deleteById(menu.id) }, '删除连线'),
        ),
      )
    }

    // 画布空白处右键：元素库 + 粘贴（drawio 也是这么放的）。
    if (menu.kind === 'canvas') {
      rows.push(
        React.createElement(
          'div',
          { className: 'drawai-menu-row' },
          React.createElement('button', { className: 'drawai-btn', onClick: pasteClipboard, title: 'Ctrl+V' }, '粘贴'),
        ),
      )
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
                // keepOpen：图层的显示/隐藏、切换当前层要能连点几下（drawio 的图层面板也不关）。
                if (entry.keepOpen !== true) {
                  setDocMenu(null)
                  setDocMenuPos(null)
                }
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
        rows.push(React.createElement('div', { className: 'drawai-note' }, '这个目录里没有 .drawio —— 换一个目录，或用「新建」建一张'))
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
      rows.push(menuTitle(isNew ? '新建画布' : '另存为'))
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
            ? '不填扩展名会自动补 .drawio；只落在工作区根目录。同名会提示换名，不会覆盖。'
            : '不填扩展名会自动补 .drawio；只落在工作区根目录。同名文件不会被覆盖。',
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
    const withExt = trimmed.toLowerCase().endsWith('.drawio') ? trimmed : trimmed + '.drawio'
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
   * 算出某个工作栏按钮在**本视图根元素**里的位置，好把菜单展开在它正下方。
   *
   * 参照系必须是 `.drawai-root`（position:absolute，是定位上下文），而菜单就是它的绝对定位子元素。
   * 曾经拿 `.drawai-canvas` 当参照 —— 那时菜单也挂在画布里。现在工作栏在上面、标签条在中间，
   * 若还按画布算，top 会变成负数（跑到画布上方）、被画布的 overflow:hidden 裁掉。
   * 也曾经拿 `.drawai-tools` 当参照：那个容器没有 position:relative，偏移量与定位上下文不一致，菜单会横着跑偏。
   *
   * 用 DOM 量而不是自己攒坐标：按钮宽度随文案变（"导出 ▾" 比 "文件 ▾" 宽），
   * 右栏也随时可能被拖动改宽，量当下这一帧最省事也最准。
   * 量不到（首帧 ref 还没挂）就返回 null，调用方退回固定位置。
   */
  function menuPosFor(key) {
    const root = rootRef.current
    const btn = toolBtnRefs.current[key]
    if (root === null || root === undefined || btn === null || btn === undefined) return null
    try {
      const a = btn.getBoundingClientRect()
      const c = root.getBoundingClientRect()
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
   * root 上的**捕获阶段**按下处理：管两件"点到外面就收"的事。
   *
   * ① **输入框外面按一下 → 提交并退出**（节点文字与线上的文字共用同一个输入框）。
   *    不能指望 `onBlur`：画布的按下处理里普遍有 `preventDefault()`（框选、拖动、右键），
   *    而 preventDefault 会挡掉**焦点变化**，于是输入框根本不 blur ——
   *    用户点空白处，编辑框还杵在那里，而且那一下点击也被输入框"吃掉"了。
   *    所以在捕获阶段自己判：目标不在输入框里就提交（提交=把改好的文字落盘，与失焦一致）。
   * ② **下拉菜单/面板外面按一下 → 收掉**（理由见下）。
   *
   * 挂在 root 的捕获阶段：画布、标签条、工作栏都在 root 里，捕获能保证在任何子元素的
   * 按下处理（画布框选、右键菜单、拖动）之前先判完，不必给每个区域各挂一遍。
   *
   * 菜单那部分，两种"不算外面"的地方：
   *   · 菜单/面板自己（点选项、点输入框、点按钮 —— 关了就没法用了）；
   *   · 工作栏那些**开菜单的按钮**（`.drawai-menu-trigger`）—— 它们自己有 toggle 语义
   *     （点同一个是关、点另一个是换），交给它们判断；否则捕获阶段先关一次、按钮的 onClick
   *     又开一次，点同一个按钮就永远关不掉。
   *     这里只放过"开菜单的按钮"而不是整个工作栏：点在按钮之间的缝里、或者点标签条，
   *     都应该算"外面"（用户眼里那都是画布/别的东西，不是菜单）。
   */
  function onRootPointerDown(event) {
    const target = event === null || event === undefined ? null : event.target
    const closest = target !== null && target !== undefined && typeof target.closest === 'function' ? target.closest.bind(target) : null
    if (editing !== null && (closest === null || closest('.drawai-edit') === null)) commitEdit()
    if (docMenu === null) return
    if (closest !== null && closest('.drawai-menu') !== null) return
    if (closest !== null && closest('.drawai-menu-trigger') !== null) return
    setDocMenu(null)
    setDocMenuPos(null)
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
   * 菜单项的构造器。
   *
   * **必须放在 `layerMenuItems` 与 `toolbarMenus` 的公共外层**：它原来定义在 toolbarMenus
   * 肚子里，而 layerMenuItems 是外层函数 —— 于是「图层」菜单一被调用就
   * `ReferenceError: item is not defined`，整个画布降级成"未渲染"（用户看到的就是这一句）。
   * 自测没抓到是因为 harness 当时把 layerMenuItems 整个桩成了 `() => []`：真实函数体
   * 一次都没跑过。现在 harness 把这段作用域整体抽出来真跑一遍，这类"自由变量对不上"会立刻炸。
   */
  const item = (label, onClick, opts) => ({
    label: label,
    onClick: onClick,
    hint: opts !== undefined && opts.hint !== undefined ? opts.hint : '',
    disabled: opts !== undefined && opts.disabled === true,
    keepOpen: opts !== undefined && opts.keepOpen === true,
  })

  /**
   * 「图层」菜单的内容。
   *
   * 菜单原语只有"一项一个动作"，而一层有两个动作（显示/隐藏、设为当前），所以分两段列：
   * 上半段点一下切换显示，下半段点一下切换"当前图层"。两段都 keepOpen —— 连点几层不用重开菜单。
   */
  function layerMenuItems() {
    const out = []
    if (layerList.length === 0) {
      out.push(item('（这张画布没有图层信息）', () => {}, { disabled: true, hint: '打开一张 drawio 文件或新建画布后就有' }))
      return out
    }
    for (let i = 0; i < layerList.length; i += 1) {
      const layer = layerList[i]
      const name = layerLabelOf(layer, i)
      const eye = layer.visible === false ? '🚫' : '👁'
      out.push(
        item(eye + ' ' + name, () => toggleLayerVisible(layer.id), {
          hint: layer.visible === false ? '现在是隐藏的，点一下显示（写进文件）' : '现在是显示的，点一下隐藏（写进文件）',
          keepOpen: true,
        }),
      )
    }
    for (let i = 0; i < layerList.length; i += 1) {
      const layer = layerList[i]
      const name = layerLabelOf(layer, i)
      const on = layer.id === activeLayerId
      out.push(
        item((on ? '● ' : '○ ') + '当前：' + name, () => setCurrentLayerId(layer.id), {
          hint: '新建的节点/连线/粘贴会落进「当前图层」',
          keepOpen: true,
        }),
      )
    }
    out.push(item('＋ 新建图层', createLayer, { hint: '自动命名「图层 N」；重命名 / 锁定 / 删除见 v2' }))
    return out
  }

  /**
   * 工具条的**下拉菜单**：同类型的操作收进一个入口。
   *
   * 为什么改：右栏本来就窄，11 个按钮排成两行既挤又难扫。按"文件 / 编辑 / 图层 / 视图 / 导出"
   * 分类后工具条只剩 5 个入口，而且每项都能带一句说明（按钮上放不下）。
   *
   * 面板沿用 docMenu 那套绝对定位（在画布左上角展开），而不是 CSS hover 弹出 ——
   * 这里是窄栏，hover 弹出很难点，鼠标一移开就收起。
   */
  function toolbarMenus() {
    return [
      {
        key: 'file',
        label: '文件',
        title: '新建 / 打开 / 保存',
        items: [
          item('新建画布…', openNewCanvasPanel, { hint: '自己起个名字（默认预填下一个可用的 untitled*）' }),
          item('打开…', openFilePicker, { hint: '列出上次用过的目录里已有的画布' }),
          item(hasPath ? '保存' : '另存为…', () => (hasPath ? saveNow() : openSaveAsPanel()), {
            hint: empty ? '还没有画布可保存' : hasPath ? '立刻落盘（平时会自动保存）' : '给这张画布一个文件名',
            disabled: empty || (hasPath && !canSave),
          }),
          item('另存为…', openSaveAsPanel, { hint: '换个文件名保存一份', disabled: empty }),
          item('选择目录…', pickDirectoryAndList, { hint: '打开系统文件管理器另选一个目录' }),
        ],
      },
      {
        key: 'edit',
        label: '编辑',
        title: '撤销 / 重做 / 复制粘贴',
        items: [
          item('撤销', undo, { hint: 'Ctrl+Z', disabled: empty || !canUndo }),
          item('重做', redo, { hint: 'Ctrl+Shift+Z', disabled: empty || !canRedo }),
          item('复制', copySelection, { hint: 'Ctrl+C', disabled: empty || selectedIds.length === 0 }),
          item('剪切', cutSelection, { hint: 'Ctrl+X', disabled: empty || selectedIds.length === 0 }),
          item('粘贴', pasteClipboard, { hint: 'Ctrl+V（跨标签页也能贴）', disabled: empty }),
          item('全选', selectAll, { hint: 'Ctrl+A（节点与连线都选上，可整体拖动/换样式/删除）', disabled: empty }),
          item('撤销 AI 改动', revertAiChange, {
            hint: '退回最近一次 AI 写盘前的版本（只保留一层；AI 的改动不在本地撤销历史里）',
            disabled: empty || !canRevert,
          }),
          item('整理几何（吸附到格线）', normalizeGeometry, { hint: '节点对齐整格、折点对齐半格；从 drawio 手画来的图常用', disabled: empty }),
        ],
      },
      {
        key: 'layers',
        label: '图层',
        title: '显示 / 隐藏，以及新建单元进哪一层',
        items: layerMenuItems(),
      },
      {
        key: 'view',
        label: '视图',
        title: '缩放与外观',
        items: [
          item('适应内容', () => setViewOverride(null), { hint: '把图缩放到刚好铺满面板', disabled: empty }),
          item(modeTag, () => setMode(mode === 'light' ? 'dark' : 'light'), { hint: '切换明暗配色' }),
          item('重新读取文件', () => setNonce((n) => n + 1), { hint: '从磁盘重新载入这张画布', disabled: empty }),
        ],
      },
      {
        key: 'export',
        label: '导出',
        title: '导出为图片、矢量或 drawio 文件',
        items: [
          item(
            '导出 SVG',
            () => {
              setSelectedIds([])
              setExportRequest('svg')
            },
            { hint: '矢量，可再编辑', disabled: empty },
          ),
          item(
            '导出 PNG（2×）',
            () => {
              setSelectedIds([])
              setExportRequest('png')
            },
            { hint: '位图，适合贴到文档里', disabled: empty },
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
            className: 'drawai-btn drawai-menu-trigger' + (docMenu === m.key ? ' on' : ''),
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
  } else if (empty) {
    // 空舞台：一张画布都没打开。这里**不画任何画布**，只给出两条出路 ——
    // 新建/打开都在上面那条工作栏的「文件」菜单里（工作栏在标签页之上，空舞台也有它）。
    body = React.createElement(
      'div',
      { className: 'drawai-empty' },
      React.createElement('div', { className: 'drawai-empty-title' }, '还没有打开画布'),
      React.createElement('div', { className: 'drawai-empty-hint' }, '用工作栏的「文件 → 新建画布…」创建一个新画布'),
      React.createElement('div', { className: 'drawai-empty-hint' }, '或用「文件 → 打开…」挑一个已有的 .drawio（drawio 自己也能打开同一份文件）'),
    )
  } else if (doc === null) {
    body = React.createElement('div', { className: 'drawai-note' }, '读取中…')
  } else {
    const canvasChildren = [renderDiagram(doc, mode, uid, svgRef, ui, view)]
    const menuNode = renderMenu()
    if (menuNode !== null) canvasChildren.push(menuNode)
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
    (empty ? '还没有打开画布 —— 用「文件 → 新建画布…」或「文件 → 打开…」开始' : '') +
    (status.kind === 'ready' && doc !== null
      ? '节点 ' + doc.nodes.length + ' · 边 ' + doc.edges.length + ' · revision ' + doc.revision + ' · 缩放 ' + zoomPercent + '%'
      : empty ? '' : '数据源：' + (target.length > 0 ? target : '(未知)')) +
    (saveNote.length > 0 ? ' ｜ ' + saveNote : '') +
    (infoError.length > 0 ? ' ｜ ⚠ ' + infoError : '')

  return React.createElement(
    'div',
    { className: 'drawai-root', ref: rootRef, onPointerDownCapture: onRootPointerDown },
    // 1) 工作栏（文件/编辑/视图/导出）—— 层级在标签页**之上**
    head,
    // 2) 标签页：由 CanvasTabs 构造、只在活动窗格里渲染（保证 DOM 里只有一份）
    active && props.tabStrip !== null && props.tabStrip !== undefined ? props.tabStrip : null,
    // 3) 画布 / 空舞台
    body,
    // 4) 工作栏的下拉与「打开/新建/另存为」面板：挂在 root 上（不在画布里），
    //    否则插进标签条之后它们的参照系会算成画布上方的负坐标，被 overflow:hidden 裁掉。
    renderDocMenu(),
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
 *  - 标签只存"路径"（一个标签 = 一个已绑定的文件），文档内容归各自的 CanvasView 管 ——
 *    这里不做第二份文档状态，否则两边会不一致。
 *  - **标签条由活动窗格渲染**（工作栏之下、画布之上）：工作栏在层级上要高于标签条，
 *    而标签条又必须只有一份 —— 交给活动窗格渲染一次正好同时满足这两条。
 *  - **一张标签都没有 = 空舞台**：不造任何画布，用户自己「新建画布…」或「打开…」。
 *    没有"未绑定画布"这种中间态（那套代码已按需求删除）。
 */
function CanvasTabs(props) {
  const tabPath = typeof props.tabPath === 'string' && props.tabPath.length > 0 ? props.tabPath : null
  const tabError = typeof props.infoError === 'string' ? props.infoError : ''
  const [tabs, setTabs] = React.useState([])
  const [activeKey, setActiveKey] = React.useState('')
  /** 只做一次"开哪个标签"的决定；之后标签的增减交给用户操作。 */
  const bootstrappedRef = React.useRef(false)

  React.useEffect(() => {
    if (bootstrappedRef.current) return
    // 地址给不出（页面 tab / 解析不出路径）→ **保持空舞台**，什么都不开。
    // 这里刻意不再造"占位/自救"的幽灵画布：屏幕上凭空多一张空白图、却没有对应文件，
    // 用户根本分不清自己在编辑什么。要画布就自己新建或打开。
    if (tabPath === null) return
    bootstrappedRef.current = true
    const key = 'tab:' + tabPath
    setTabs([{ key: key, path: tabPath }])
    setActiveKey(key)
  }, [tabPath])

  /** 打开一个路径：已经在标签里就切过去，否则新开一个。规则在 openTabIn（可自测）。 */
  function openPath(path) {
    const next = openTabIn(tabs, path)
    if (next.active === null) return
    if (next.tabs !== tabs) setTabs(next.tabs)
    setActiveKey(next.active)
  }

  /** 某个标签改名了（另存为 / 切文件）——只更新它自己那条记录。 */
  function rebind(key, path) {
    setTabs((list) => list.map((t) => (t.key === key ? Object.assign({}, t, { path: path }) : t)))
    setActiveKey('tab:' + path)
  }

  /** 关一个标签。**允许关到 0 个**：那就回到空舞台（再要画布就自己新建/打开）。 */
  function closeTab(key) {
    const next = tabs.filter((t) => t.key !== key)
    if (key === activeKey) setActiveKey(next.length === 0 ? '' : next[next.length - 1].key)
    setTabs(next)
  }

  // 标签条：源码里**只有这一处**构造它（自测盯着这条），渲染则由活动窗格代劳。
  const tabBar =
    tabs.length === 0
      ? null
      : React.createElement(
          'div',
          { className: 'drawai-tabs', key: 'tabbar' },
          tabs.map((t) =>
            React.createElement(
              'span',
              { key: t.key, className: 'drawai-tab' + (t.key === activeKey ? ' on' : '') },
              React.createElement('button', { className: 'drawai-tab-name', title: String(t.path), onClick: () => setActiveKey(t.key) }, tabLabelOf(t.path)),
              tabs.length > 1 ? React.createElement('button', { className: 'drawai-tab-x', title: '关闭这个标签', onClick: () => closeTab(t.key) }, '×') : null,
            ),
          ),
        )

  const children = []
  if (tabs.length === 0) {
    // 空舞台：没有任何标签，也**没有任何画布**。仍然渲染一个 empty 模式的 CanvasView ——
    // 工作栏（文件/编辑/视图/导出）住在它的 head 里，而「新建画布…／打开…」就在那个菜单里。
    children.push(
      React.createElement(
        'div',
        { key: 'pane:empty', className: 'drawai-pane', style: { display: 'flex' } },
        React.createElement(
          CanvasBoundary,
          null,
          React.createElement(CanvasView, {
            sessionId: props.sessionId,
            empty: true,
            active: true,
            infoError: tabError,
            onOpenTab: openPath,
            onRebind: () => {},
            tabStrip: null,
          }),
        ),
      ),
    )
  } else {
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
          React.createElement(
            CanvasBoundary,
            null,
            React.createElement(CanvasView, {
              sessionId: props.sessionId,
              path: t.path,
              active: isActive,
              infoError: '',
              onOpenTab: openPath,
              onRebind: (path) => rebind(t.key, path),
              // 标签条只给活动窗格：DOM 里永远只有一份。
              tabStrip: isActive ? tabBar : null,
            }),
          ),
        ),
      )
    }
  }
  return React.createElement('div', { className: 'drawai-tabs-wrap' }, React.createElement('div', { className: 'drawai-panes' }, children))
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
      patterns: ['**/*.drawio'],
      title: (address) => {
        const name = basename(address)
        return name.length > 0 && name !== KIND ? name : 'DrawAI 画布'
      },
      guide: [
        {
          order: 30,
          title: () => 'DrawAI 画布',
          description: () => '把工作区里的 .drawio 渲染成 draw.io 风格的图；AI 改文件，画布自动重绘',
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
  marqueeHits: marqueeHits,
  dragMoveOf: dragMoveOf,
  draggedGeometry: draggedGeometry,
  styleTargets: styleTargets,
  allIdsOf: allIdsOf,
  alignGuidesFor: alignGuidesFor,
  boxOfBoxes: boxOfBoxes,
  // 图层（v1）
  hiddenLayerIds: hiddenLayerIds,
  isHiddenCell: isHiddenCell,
  layerLabelOf: layerLabelOf,
  nextLayerIdOf: nextLayerIdOf,
  docFromPayload: docFromPayload,
  cloneDoc: cloneDoc,
  defaultLayer: defaultLayer,
  styleSummary: styleSummary,
  pathFromAddress: pathFromAddress,
  computeFitView: computeFitView,
  resizeViewFor: resizeViewFor,
  zoomViewAt: zoomViewAt,
  contentBounds: contentBounds,
  edgeLabelPointAt: edgeLabelPointAt,
  edgeLabelPosition: edgeLabelPosition,
  relativePointOnPath: relativePointOnPath,
  labelPosFor: labelPosFor,
  labelBox: labelBox,
  labelGapsOnPath: labelGapsOnPath,
  cutPathByGaps: cutPathByGaps,
  snapLabelPoint: snapLabelPoint,
  parseCssColor: parseCssColor,
  formatDataLines: formatDataLines,
  parseDataLines: parseDataLines,
  snapDocGeometry: snapDocGeometry,
  openTabIn: openTabIn,
  tabLabelOf: tabLabelOf,
  edgeRoutePoints: edgeRoutePoints,
  prunePoints: prunePoints,
  samePath: samePath,
  simplifyCollinear: simplifyCollinear,
  removeRetraces: removeRetraces,
  isFoldApex: isFoldApex,
  snapNearAxis: snapNearAxis,
  anchorSidesOf: anchorSidesOf,
  pickSides: pickSides,
  stubPointFor: stubPointFor,
  borderPointToward: borderPointToward,
  sidesFromStyle: sidesFromStyle,
  pinnedSideOf: pinnedSideOf,
  chainForRoute: chainForRoute,
  dropTargetOf: dropTargetOf,
  // 移动单位（节点整格 / 连线半格）：自测直接断言这几个纯函数，规则被改坏就会红。
  snapTo: snapTo,
  resizeBox: resizeBox,
  segmentMoveOf: segmentMoveOf,
  GRID: GRID,
  EDGE_GRID: EDGE_GRID,
  MIN_NODE_W: MIN_NODE_W,
  MIN_NODE_H: MIN_NODE_H,
  NEW_NODE_W: NEW_NODE_W,
  NEW_NODE_H: NEW_NODE_H,
  FALLBACK_NODE_W: FALLBACK_NODE_W,
  FALLBACK_NODE_H: FALLBACK_NODE_H,
  routeThroughWaypoints: routeThroughWaypoints,
  routeEdge: routeEdge,
  routeCandidates: routeCandidates,
  pickCandidate: pickCandidate,
  applyRouteHysteresis: applyRouteHysteresis,
  ROUTE_SETTLE_FRAMES: ROUTE_SETTLE_FRAMES,
  buildGeometry: buildGeometry,
  pathCost: pathCost,
  withinSlack: withinSlack,
  hasMidpointEnds: hasMidpointEnds,
  ROUTE_LENGTH_SLACK: ROUTE_LENGTH_SLACK,
  selfLoopPath: selfLoopPath,
  nextSideOf: nextSideOf,
  collectClipboard: collectClipboard,
  pasteInto: pasteInto,
  // 按键归属：谁在打字、这次按键算不算画布的 —— 纯函数，自测直接喂假 DOM 节点。
  isTextEntry: isTextEntry,
  canvasOwnsKeyboard: canvasOwnsKeyboard,
  ensurePinned: ensurePinned,
  SIDES: SIDES,
  HOT_PAD: HOT_PAD,
  GRID: GRID,
}
