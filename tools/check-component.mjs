/**
 * 整组件渲染自测 —— 拿**形状不对的状态**去渲染画布组件，看它会不会整块降级。
 *
 * 为什么需要它：CanvasView 有一圈 CanvasBoundary，任何渲染期异常都会
 * 把整张画布换成一个红底错误页 —— "画布未渲染"，用户什么都干不了。
 * 而 check-render.mjs 只测 renderDiagram（纯函数），**测不到组件渲染期**，
 * 所以这类崩溃以前只能靠用户在页面上撞见。
 *
 * 真实事故（就是本脚本的由来）：
 *   DrawAI 渲染异常（已降级，画布未渲染）
 *   Cannot read properties of null (reading 'length')  at renderDocMenu
 * —— `fileList` 的某个 setState 少了一个字段，renderDocMenu 直接读 `.error.length` 就炸了。
 *
 * 做法：用带 hooks 的最小 React 桩把组件真跑一遍（useState 存值、useEffect 收集后手跑），
 * 然后逐个畸形状态渲染，只要抛错就失败。
 *
 * 用法：node tools/check-component.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { composeClientBody } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// 与产物同款的组合 body（内联的样式内核 + src/client.js）：组件里会用到内核函数，
// 裸的 src/client.js 在这里会 ReferenceError。
const src = composeClientBody()

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

/** 带 hooks 的最小 React 桩：足以让组件跑完一次渲染。 */
function makeReact() {
  const store = []
  const effects = []
  let cursor = 0
  return {
    Component: class {
      constructor(p) {
        this.props = p
        this.state = {}
      }
      setState(s) {
        this.state = Object.assign({}, this.state, s)
      }
    },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = cursor++
      if (!(i in store)) store[i] = typeof init === 'function' ? init() : init
      return [
        store[i],
        (v) => {
          store[i] = typeof v === 'function' ? v(store[i]) : v
        },
      ]
    },
    useRef: () => ({ current: null }),
    useEffect: (fn) => {
      effects.push(fn)
    },
    Fragment: 'Fragment',
    __reset() {
      cursor = 0
    },
    __runEffects() {
      for (const fn of effects) {
        try {
          fn()
        } catch (error) {
          /* 桩里不关心 effect 内部失败 */
        }
      }
      effects.length = 0
    },
    __store: store,
  }
}

const fakeDocument = {
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, removeChild() {}, parentNode: null, textContent: '' }),
  createElementNS: () => ({ setAttribute() {} }),
  getElementById: () => null,
  body: { appendChild() {}, removeChild() {} },
}

/** 渲染一次；返回 { error } 表示渲染期抛了错。 */
function renderOnce(seed) {
  const React = makeReact()
  const mod = { exports: {} }
  // 注意：别把 React 当形参传进去 —— 源码里有 `const React = require('react')`，同名形参会撞。
  new Function('module', 'exports', 'require', 'window', 'document', src)(
    mod,
    mod.exports,
    (s) => {
      if (s === 'react') return React
      throw new Error('unexpected require ' + s)
    },
    { addEventListener() {}, removeEventListener() {} },
    fakeDocument,
  )
  const slots = []
  mod.exports.apply({
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (opts, comp) => {
        slots.push(comp)
        return () => {}
      },
    },
    sidebarRightTabs: { register: () => () => {} },
    timeout: () => () => {},
    interval: () => () => {},
    get: () => undefined,
  })
  const Comp = slots[0]
  if (typeof Comp !== 'function') return { error: '没拿到画布组件（slot 注册形状变了？）' }
  if (seed !== undefined) for (const [i, v] of Object.entries(seed)) React.__store[i] = v
  React.__reset()
  try {
    Comp({ sessionId: 's1' })
    React.__runEffects()
    Comp({ sessionId: 's1' })
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) }
  }
  return {}
}

/**
 * 按**大括号配平**截出某个函数的函数体。
 *
 * 不用正则：正则很容易跨到下一个函数去（我自己就写错过一次，得出了错误的"通过"）。
 * 多个小节都要用它，所以放在顶层共享。
 */
function bodyOf(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) return null
  const braceOpen = src.indexOf('{', start)
  let depth = 0
  for (let i = braceOpen; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(braceOpen, i + 1)
    }
  }
  return null
}

console.log('整组件渲染：状态形状不对时也不能整块降级\n')
{
  const cases = [
    ['正常（初始状态）', undefined],
    ['fileList = null（未拉取）', { 2: 'open', 4: null }],
    ['{ files: null, error: "" }（读取中）', { 2: 'open', 4: { files: null, error: '' } }],
    ['{ files: [], error: "" }（空列表）', { 2: 'open', 4: { files: [], error: '' } }],
    ['{ files: ["a.dshd.json"], error: "" }', { 2: 'open', 4: { files: ['a.dshd.json'], error: '' } }],
    ['缺 error 字段 ← 真实事故就是这种', { 2: 'open', 4: { files: ['a.dshd.json'] } }],
    ['缺 files 字段', { 2: 'open', 4: { error: 'boom' } }],
    ['fileList = 字符串（形状完全错）', { 2: 'open', 4: 'oops' }],
    ['{ files: [1,2], error: 5 }（字段类型也不对）', { 2: 'open', 4: { files: [1, 2], error: 5 } }],
  ]
  for (const [label, seed] of cases) {
    const r = renderOnce(seed)
    ok(r.error === undefined, label + (r.error === undefined ? '' : ' —— 抛错：' + r.error))
  }

  // 面板的各种打开状态都不能炸
  for (const mode of ['open', 'saveAs']) {
    const r = renderOnce({ 2: mode, 4: { files: [], error: '' } })
    ok(r.error === undefined, '面板 docMenu=' + mode + ' 渲染正常')
  }
}

console.log('\n「打开」与「选择目录…」职责必须分开')
{
  // 曾经每次点「打开」都弹一次系统文件管理器 —— 多数时候用户只是想切到另一个画布。
  // 现在：「打开」直接列上次用过的目录；只有点「选择目录…」才弹选择器。
  // 用大括号配平截函数体，避免正则跨到下一个函数（这一点我自己就写错过一次）。
  const bodyOf = (name) => {
    const start = src.indexOf('async function ' + name + '(')
    if (start < 0) return null
    const open = src.indexOf('{', start)
    let depth = 0
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) return src.slice(open, i + 1)
      }
    }
    return null
  }
  const openFn = bodyOf('openFilePicker')
  const pickFn = bodyOf('pickDirectoryAndList')
  ok(openFn !== null && !/pickDirectory\s*\(/.test(openFn), '「打开」不再调 pickDirectory()')
  ok(openFn !== null && /fetchFileList\(lastPickedDirRef\.current\)/.test(openFn), '「打开」只列上次用过的目录')
  ok(pickFn !== null && /pickDirectory\s*\(/.test(pickFn), '「选择目录…」才调 pickDirectory()')
  ok(pickFn !== null && /lastPickedDirRef\.current = picked/.test(pickFn), '选中后记住该目录')
}

console.log('\n「打开」一个文件 = 多出它的标签页（不是改名替换当前标签）')
{
  // 之前 switchTo 走的是 onRebind —— 那会把**当前标签改名并替换**，
  // 于是"打开"完看不到新文件的标签，用户正在编辑的那张也丢了位置。
  // 现在走 onOpenTab：已开过就切过去，没开过就新增一个标签。
  const bodyOf = (name) => {
    const start = src.indexOf('async function ' + name + '(')
    if (start < 0) return null
    const open = src.indexOf('{', start)
    let depth = 0
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) return src.slice(open, i + 1)
      }
    }
    return null
  }
  const sw = bodyOf('switchTo')
  ok(sw !== null && /onOpenTab\(relPath\)/.test(sw), 'switchTo 通过 onOpenTab 打开（新增/切换标签）')
  ok(sw !== null && !/onRebind\(/.test(sw), 'switchTo 不再用 onRebind（那是改名替换）')
  ok(sw !== null && !/saveNow\(/.test(sw), '不必先保存：当前标签只是被留在后面，内容没丢')
  // 另存为仍然要用 onRebind（它确实是"把当前标签改名"）
  const saveAs = bodyOf('saveAs')
  ok(saveAs !== null && /onRebind\(/.test(saveAs), 'saveAs 仍然用 onRebind（改名绑定到新文件）')

  // 文件列表项必须带"身份"（绝对路径）——否则同一文件会开出两个标签
  ok(/isArray\(payload\.absolute\)/.test(src), '客户端读取宿主给的 absolute 数组')
  ok(/entries\.push\(\{ path: identity, display: rel\[i\] \}\)/.test(src), '列表项形如 { path: identity, display }')
}

console.log('\n工具条：按类型合并为下拉菜单')
{
  // 直接从源码里抽出 toolbarMenus 的**函数体**执行它 —— 比把整个组件树跑起来可靠得多：
  // 组件需要一堆 hook / 边界配合（我在这上面浪费过好几轮），而菜单定义是纯数据，
  // 验它才是真正要验的东西。
  const start = src.indexOf('  function toolbarMenus() {')
  ok(start >= 0, '源码里有 toolbarMenus')
  if (start >= 0) {
    const braceOpen = src.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = braceOpen; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    const sandbox = {
      // toolbarMenus 引用到的自由变量必须**全部**列在这里，
      // 否则 new Function 求值时直接 ReferenceError —— 这也是一种接线检查：
      // 名字对不上会立刻炸出来（比"跑起来才发现菜单点不动"早得多）。
      openNewCanvasPanel: () => {},
      openFilePicker: () => {},
      saveNow: () => {},
      openSaveAsPanel: () => {},
      pickDirectoryAndList: () => {},
      undo: () => {},
      redo: () => {},
      setViewOverride: () => {},
      setMode: () => {},
      setNonce: () => {},
      setSelectedIds: () => {},
      setExportRequest: () => {},
      hasPath: true,
      canSave: true,
      canUndo: true,
      canRedo: true,
      modeTag: 'draw.io 外观',
    }
    const names = Object.keys(sandbox)
    let menus = null
    try {
      menus = new Function(...names, src.slice(start, end) + '\n  return toolbarMenus()')(...names.map((n) => sandbox[n]))
    } catch (error) {
      ok(false, 'toolbarMenus 求值失败（引用了未提供的自由变量？）：' + (error && error.message ? error.message : String(error)))
    }
    if (menus !== null) {
    ok(menus.map((m) => m.key).join(',') === 'file,edit,view,export', '恰好 4 类：文件 / 编辑 / 视图 / 导出')
    const total = menus.reduce((n, m) => n + m.items.length, 0)
    ok(total === 12, '所有旧操作都有归处（实际 ' + total + ' 项）')
    ok(menus.every((m) => typeof m.title === 'string' && m.title.length > 0), '每个菜单都有悬停说明（title）')
    ok(menus.every((m) => m.items.every((i) => typeof i.label === 'string' && i.label.length > 0)), '每一项都有 label')
    ok(menus.every((m) => m.items.every((i) => typeof i.onClick === 'function')), '每一项都有 onClick')
    const labels = menus.reduce((a, m) => a.concat(m.items.map((i) => i.label)), [])
    for (const gone of ['新建画布…', '打开…', '撤销', '重做', '适应内容', '导出 SVG', '导出 PNG（2×）']) {
      ok(labels.indexOf(gone) >= 0, '旧按钮「' + gone + '」已收进菜单')
    }
    // 工具条本身只应渲染菜单入口
    const headStart = src.indexOf('const head = React.createElement(')
    const headEnd = src.indexOf('  let body', headStart)
    const headSrc = headEnd > headStart ? src.slice(headStart, headEnd) : ''
    ok(/toolbarMenus\(\)\.map/.test(headSrc), '工具条通过 toolbarMenus().map 渲染入口')
    ok(!/'撤销'|'重做'|'适应'|'SVG'|'PNG'|'刷新'/.test(headSrc), '工具条不再逐个写旧按钮')
    // 菜单要贴在**触发它的按钮**下方，而不是统一跑到左上角
    ok(/onClick: \(\) => toggleToolbarMenu\(m\.key\)/.test(headSrc), '每个入口把自己的 key 交给 toggleToolbarMenu')
    ok(/toolBtnRefs\.current\[m\.key\] = el/.test(headSrc), '每个入口把 DOM 交给 toolBtnRefs（要量位置）')
    const posFn = bodyOf('menuPosFor') || ''
    ok(/canvasRef\.current/.test(posFn), 'menuPosFor 以**画布**为参照系（菜单的定位上下文）')
    ok(!/toolsRef/.test(src), '不再用 .drawai-tools 当参照（它没有 position:relative，会横着跑偏）')
    const toggle = bodyOf('toggleToolbarMenu') || ''
    ok(/setDocMenuPos\(menuPosFor\(m?key\)\)/.test(toggle) || /setDocMenuPos\(menuPosFor\(/.test(toggle), '开菜单时记下按钮位置')
    ok(/setDocMenuPos\(null\)/.test(toggle), '收起菜单时清掉位置')
    const styleFn = bodyOf('panelStyle') || ''
    ok(/Math\.min/.test(styleFn) && /maxLeft/.test(styleFn), 'panelStyle 把面板夹在画布范围内（右栏窄，不夹会跑到看不见）')
    ok((src.match(/panelStyle\(docMenuPos\)/g) || []).length === 2, '两个面板（菜单 / 打开面板）都用同一套定位')
    }
  }
  }

console.log('\n初始不加载"未绑定"空画布')
{
  // 走过两版：
  //   第一版 初始无条件开一个 (未绑定) 标签 → 一进来就是空画布；
  //   第二版 改成 provisional 占位再"认领" → 用户仍会先看到空画布闪一下。
  // 现在是：**初始零标签**。地址到了才开真文件的标签；只有"地址给不出且确实出错"才给空画布。
  ok(/const \[tabs, setTabs\] = React\.useState\(\[\]\)/.test(src), '初始 tabs 是空数组（零标签）')
  ok(!/provisional/.test(src), '不再有"占位标签"这一套（那是上一版的补丁）')
  ok(/const bootstrappedRef = React\.useRef\(false\)/.test(src), '只做一次"开哪个标签"的决定')
  const boot = src.slice(src.indexOf('if (bootstrappedRef.current) return'), src.indexOf('}, [tabPath, tabError]'))
  ok(boot.length > 0, 'CanvasTabs 里有 bootstrap effect')
  ok(/setTabs\(\[\{ key: key, path: tabPath, untitled: false, unbound: false \}\]\)/.test(boot), '地址到了 → 开真文件的标签')
  ok(/tabError\.length > 0[\s\S]{0,300}unbound: true/.test(boot), '地址给不出且出错 → 才给空画布（让用户能自救）')
  const afterError = boot.slice(boot.indexOf("if (tabError.length > 0)"))
  const noBranch = afterError.slice(afterError.indexOf("// 两者都没有"))
  ok(!/setTabs\(/.test(noBranch), '地址还在路上时不开任何标签（不凭空冒空画布）')
  ok(/正在打开画布…/.test(src), '零标签时显示"正在打开画布…"')
  const emptyView = src.slice(src.indexOf('if (tabs.length === 0)'), src.indexOf('const tabBar = React.createElement'))
  ok(!/CanvasView/.test(emptyView) && !/drawai-head/.test(emptyView), '零标签时不渲染画布与工具条')
}


console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
