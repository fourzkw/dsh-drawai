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
    ['{ files: ["a.drawio"], error: "" }', { 2: 'open', 4: { files: ['a.drawio'], error: '' } }],
    ['缺 error 字段 ← 真实事故就是这种', { 2: 'open', 4: { files: ['a.drawio'] } }],
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
      // 空舞台（一张画布都没打开）时菜单项要禁用 —— 它也是 toolbarMenus 的自由变量。
      empty: false,
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
    ok(total === 12, '所有操作都有归处（实际 ' + total + ' 项）')
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
    ok(/rootRef\.current/.test(posFn), 'menuPosFor 以**本视图根元素**为参照系（菜单挂在 root 上）')
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

console.log('\n启动行为：空舞台（没有"未绑定画布"那一套）')
{
  // 需求：打开 drawai 画布后**应该为空**，而不是直接冒出一张未绑定画布；
  // 要画布就自己「新建画布…」或「打开…」—— 两个入口都在工作栏里，而工作栏在标签页之上。
  ok(/const \[tabs, setTabs\] = React\.useState\(\[\]\)/.test(src), '初始 tabs 是空数组（零标签）')
  ok(!/provisional/.test(src), '不再有"占位标签"这一套（那是上一版的补丁）')
  ok(/const bootstrappedRef = React\.useRef\(false\)/.test(src), '只做一次"开哪个标签"的决定')
  const boot = src.slice(src.indexOf('if (bootstrappedRef.current) return'), src.indexOf('}, [tabPath])'))
  ok(boot.length > 0, 'CanvasTabs 里有 bootstrap effect')
  ok(/setTabs\(\[\{ key: key, path: tabPath \}\]\)/.test(boot), '地址到了 → 开真文件的标签')
  ok(/if \(tabPath === null\) return/.test(boot), '地址给不出 → 什么都不开（保持空舞台）')
  const setTabsCalls = boot.match(/setTabs\(/g) || []
  ok(setTabsCalls.length === 1 && /setTabs\(\[\{ key: key, path: tabPath \}\]\)/.test(boot), 'bootstrap 里只有一次 setTabs，且只开真文件的标签（没有任何空画布兜底）')

  // "未绑定画布"那一整套代码必须消失（注释里提历史可以，用户可见的字符串与标识符不行）
  ok(!/unbound/.test(src), '源码里不再有 unbound（未绑定画布）')
  ok(!/UNTITLED/.test(src), '源码里不再有 UNTITLED 哨兵')
  ok(!/'(\(未绑定\)|未绑定文件|未绑定画布)'/.test(src) && !/AI 对话改不到它/.test(src), '不再有"未绑定"的用户可见文案')
  ok(!/const blank = \{ version: 2/.test(src), '空舞台不再就地造一份"幽灵空文档"')

  // 空舞台仍然要有工作栏（否则一张画布都没有时连新建/打开都点不到）
  const emptyStart = src.indexOf('if (tabs.length === 0) {')
  const emptyBranch = emptyStart >= 0 ? src.slice(emptyStart, src.indexOf('} else {', emptyStart)) : ''
  ok(/CanvasView/.test(emptyBranch) && /empty: true/.test(emptyBranch), '零标签时渲染 empty 模式的 CanvasView（它带来工作栏）')
  ok(/tabStrip: null/.test(emptyBranch), '空舞台没有标签条')
  ok(/还没有打开画布/.test(src), '空舞台给出"还没有打开画布"的提示')
  ok(/next\.length === 0 \? '' : /.test(bodyOf('closeTab') || ''), '关掉最后一个标签会回到空舞台（不再强制"至少留一个"）')
}

console.log('\n层级：工作栏在标签页之上')
{
  // 工作栏（文件/编辑/视图/导出）要排在标签条**前面**渲染 —— 右栏窄，
  // "对当前画布做什么"应该一直在最上面，而"现在看哪张"在它下面。
  const rootStart = src.indexOf("className: 'drawai-root'")
  const rootEnd = src.indexOf("className: 'drawai-note'", rootStart)
  const block = rootStart >= 0 && rootEnd > rootStart ? src.slice(rootStart, rootEnd) : ''
  const iHead = block.indexOf('head,')
  const iStrip = block.indexOf('props.tabStrip')
  const iBody = block.indexOf('body,')
  ok(iHead >= 0 && iStrip > iHead && iBody > iStrip, 'root 的渲染顺序是 工作栏 → 标签条 → 画布（实际 ' + iHead + ' / ' + iStrip + ' / ' + iBody + '）')
  ok(/tabStrip: isActive \? tabBar : null/.test(src), '标签条只交给活动窗格（DOM 里只有一份）')
  ok((src.match(/className: 'drawai-tabs'/g) || []).length === 1, '标签条只在一处构造')
  ok(/const rootRef = React\.useRef\(null\)/.test(src), 'root 上有 ref，供菜单定位')
}


console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
