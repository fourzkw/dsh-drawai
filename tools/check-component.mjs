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
  // 从源码里抽出**同一段作用域的真实代码**执行它：
  //   item  →  layerMenuItems  →  toolbarMenus
  //
  // 为什么不把 layerMenuItems 桩成 `() => []`（曾经就是这么写的）：
  // 真实事故 —— `item`（菜单项构造器）原来定义在 toolbarMenus 肚子里，而 layerMenuItems
  // 是外层函数，于是「图层」菜单一被调用就 `ReferenceError: item is not defined`，
  // 整张画布降级成"画布未渲染"。桩掉之后真实函数体一次都没跑过，全绿到底。
  // 现在把这段作用域整体求值并**真的调用两个函数**：自由变量对不上会立刻炸出来。
  const regionStart = src.indexOf('  const item = (label, onClick, opts) => ({')
  const tbStart = src.indexOf('  function toolbarMenus() {')
  ok(regionStart >= 0, '源码里有菜单项构造器 item')
  ok(tbStart > regionStart, 'layerMenuItems 与 toolbarMenus 在同一段作用域里（能一起抽出来跑）')
  // layerList / activeLayerId 是**菜单之外**也要用的派生状态（新单元盖章），
  // 所以它必须定义在组件体靠前的位置 —— 与最早用它的那一行比一比。
  const layerListDecl = src.indexOf('  const layerList = doc !== null')
  const firstUse = src.indexOf('if (activeLayerId !== null')
  ok(layerListDecl >= 0 && firstUse > layerListDecl, 'layerList / activeLayerId 定义在**最早用到它之前**（否则就是 TDZ 地雷）')

  let end = -1
  if (tbStart >= 0) {
    const braceOpen = src.indexOf('{', tbStart)
    let depth = 0
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
  }
  const region = end > regionStart ? src.slice(regionStart, end) : ''
  const itemDecl = src.indexOf('const item = (label, onClick, opts) => ({')
  ok(itemDecl >= 0, '源码里有菜单项构造器 item（只此一处）')
  ok(itemDecl >= 0 && tbStart >= 0 && itemDecl < tbStart, 'item 定义在 toolbarMenus **之外**（否则外层函数看不见它 —— 真实事故）')
  ok((region.match(/const item = \(label, onClick, opts\)/g) || []).length === 1, '这段作用域里 item 只有一份（两边共用，不各写一份）')

  /** 在沙箱里跑一遍这段真实代码，返回 { menus, items }（失败返回 { error }）。 */
  const evalMenus = (over) => {
    const sandbox = {
      // toolbarMenus / layerMenuItems 引用到的自由变量必须**全部**列在这里，
      // 否则 new Function 求值或调用时直接 ReferenceError —— 这本身就是一种接线检查。
      // layerList / activeLayerId 就是组件体里那两个派生常量（这里喂数据当值）。
      layerList: [
        { id: '1', name: '主流程', visible: true, locked: false },
        { id: 'L2', name: '草稿', visible: false, locked: false },
      ],
      activeLayerId: '1',
      layerLabelOf: (layer, i) => (typeof layer.name === 'string' && layer.name.length > 0 ? layer.name : '第 ' + (i + 1) + ' 层'),
      toggleLayerVisible: () => {},
      setCurrentLayerId: () => {},
      createLayer: () => {},
      openNewCanvasPanel: () => {},
      openFilePicker: () => {},
      copySelection: () => {},
      cutSelection: () => {},
      pasteClipboard: () => {},
      selectAll: () => {},
      revertAiChange: () => {},
      canRevert: true,
      normalizeGeometry: () => {},
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
      // 复制/剪切要在有选区时可用 —— 它也是 toolbarMenus 的自由变量。
      selectedIds: ['n1'],
      modeTag: 'draw.io 外观',
      // 空舞台（一张画布都没打开）时菜单项要禁用 —— 它也是 toolbarMenus 的自由变量。
      empty: false,
    }
    Object.assign(sandbox, over === undefined ? {} : over)
    const names = Object.keys(sandbox)
    try {
      const out = new Function(...names, region + '\n  return { menus: toolbarMenus(), items: layerMenuItems() }')(
        ...names.map((n) => sandbox[n]),
      )
      return out
    } catch (error) {
      return { error: error && error.message ? error.message : String(error) }
    }
  }

  const ran = evalMenus()
  ok(ran.error === undefined, '这一段真实代码能求值并调用（自由变量对不上会在这里炸）：' + (ran.error === undefined ? 'ok' : ran.error))
  const menus = ran.error === undefined ? ran.menus : null
  const layerItems = ran.error === undefined ? ran.items : null

  if (layerItems !== null) {
    ok(layerItems.length === 5, '两层的图层菜单 = 2 显示项 + 2 当前项 + 1 新建（实际 ' + layerItems.length + '）')
    ok(layerItems[0].label === '👁 主流程' && layerItems[1].label === '🚫 草稿', '显示/隐藏项：眼睛 + 层名（隐藏的画 🚫）')
    ok(layerItems[2].label === '● 当前：主流程' && layerItems[3].label === '○ 当前：草稿', '当前图层项标出哪一层是当前层（没设过就第一层）')
    ok(layerItems[4].label === '＋ 新建图层', '有「新建图层」入口')
    ok(layerItems[0].keepOpen === true && layerItems[2].keepOpen === true, '层内的两项都 keepOpen（连点几层不用重开菜单）')
    ok(layerItems[4].keepOpen !== true, '「新建图层」点完收起菜单')

    // 点下去要打给**对的**函数、带上**对的**层 id（只断言"有 onClick"是不够的）
    const hits = []
    const clicked = evalMenus({
      toggleLayerVisible: (id) => hits.push('显示:' + id),
      setCurrentLayerId: (id) => hits.push('当前:' + id),
      createLayer: () => hits.push('新建'),
    })
    ok(clicked.error === undefined, '带记录桩求值成功')
    if (clicked.error === undefined) {
      clicked.items[0].onClick()
      clicked.items[1].onClick()
      clicked.items[3].onClick()
      clicked.items[4].onClick()
      ok(
        hits.join('|') === '显示:1|显示:L2|当前:L2|新建',
        '点每一项都打给对的函数与层 id（实际 ' + hits.join('|') + '）',
      )
    }

    // 空舞台（还没有图层）= 一句禁用说明，不能炸、也不能给出点了没用的项
    const blank = evalMenus({ layerList: [], activeLayerId: null })
    ok(blank.error === undefined, '没有图层列表（空舞台）时图层菜单照样算得出来')
    if (blank.error === undefined) {
      ok(blank.items.length === 1 && blank.items[0].disabled === true, '没有图层信息时只给一项禁用的说明')
    }
  }

  if (menus !== null) {
    ok(menus.map((m) => m.key).join(',') === 'file,edit,layers,view,export', '恰好 5 类：文件 / 编辑 / 图层 / 视图 / 导出（实际 ' + menus.map((m) => m.key).join(',') + '）')
    const total = menus.reduce((n, m) => n + m.items.length, 0)
    ok(
      total === 18 + (layerItems === null ? 0 : layerItems.length),
      '所有操作都有归处（实际 ' + total + ' 项 = 18 个固定项 + ' + (layerItems === null ? 0 : layerItems.length) + ' 个图层项）',
    )
    const layersMenu = menus.filter((m) => m.key === 'layers')[0]
    ok(
      layersMenu !== undefined && layersMenu.items.length === (layerItems === null ? -1 : layerItems.length),
      '「图层」菜单里就是 layerMenuItems() 那几项（实际 ' + (layersMenu === undefined ? '没有这个菜单' : layersMenu.items.length) + '）',
    )
    ok(menus.every((m) => typeof m.title === 'string' && m.title.length > 0), '每个菜单都有悬停说明（title）')
    ok(menus.every((m) => m.items.every((i) => typeof i.label === 'string' && i.label.length > 0)), '每一项都有 label')
    ok(menus.every((m) => m.items.every((i) => typeof i.onClick === 'function')), '每一项都有 onClick')
    const labels = menus.reduce((a, m) => a.concat(m.items.map((i) => i.label)), [])
    for (const gone of ['新建画布…', '打开…', '撤销', '重做', '适应内容', '导出 SVG', '导出 PNG（2×）']) {
      ok(labels.indexOf(gone) >= 0, '旧按钮「' + gone + '」已收进菜单')
    }
    ok(labels.indexOf('全选') >= 0, '「全选」在编辑菜单里（Ctrl+A 之外的入口）')
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


console.log('\n点到外面：收掉下拉菜单，并提交/退出文字输入框')
{
  // ① 需求：下拉栏（文件/编辑/图层/视图/导出）与「打开/新建/另存为」面板，
  //    在**外面**点一下就收掉 —— 不关的话它一直挂在画布上方挡着，而且下次点同一个按钮
  //    会变成"关掉"而不是"打开"（用户以为按钮坏了）。
  // ② 需求：点输入框外面就提交并退出（节点文字与线上的文字共用同一个输入框）。
  //    不能指望 onBlur —— 画布的按下处理里普遍 preventDefault()（框选/拖动/右键），
  //    而它会挡掉**焦点变化**，输入框根本不 blur。
  //
  // 这里把 onRootPointerDown 的**真实函数体**抽出来、喂假事件真的调用一遍
  // （不是只 grep 源码：这个函数的分支正是"算不算外面"，只能靠跑）。
  const body = bodyOf('onRootPointerDown')
  ok(body !== null, '源码里有 onRootPointerDown')

  /** 跑一次：editingValue 是当时的编辑框状态，docMenuValue 是菜单状态，target 是事件目标。 */
  const runPointer = (docMenuValue, target, editingValue) => {
    const calls = []
    const fn = new Function(
      'docMenu',
      'setDocMenu',
      'setDocMenuPos',
      'editing',
      'commitEdit',
      'return function onRootPointerDown(event) ' + body,
    )(
      docMenuValue,
      (v) => calls.push('menu:' + String(v)),
      (v) => calls.push('pos:' + String(v)),
      editingValue === undefined ? null : editingValue,
      () => calls.push('commit'),
    )
    fn({ target: target })
    return calls
  }

  // 假事件目标：closest(sel) 命中给定选择器时就返回一个元素，否则 null。
  const targetInside = (sel) => ({ closest: (s) => (s === sel ? { className: sel } : null) })
  const targetOutside = { closest: () => null }

  ok(runPointer(null, targetOutside).length === 0, '菜单没开、也没在编辑时什么都不做')
  ok(runPointer('file', targetOutside).join(',') === 'menu:null,pos:null', '点画布/标签条（外面）→ 关掉菜单与位置：' + runPointer('file', targetOutside).join(','))
  ok(runPointer('file', targetInside('.drawai-menu')).length === 0, '点菜单自己（选项/输入框/按钮）→ 不关')
  ok(runPointer('file', targetInside('.drawai-menu-trigger')).length === 0, '点开菜单的那个按钮 → 不在这里关（交给它自己的 toggle：点同一个是关、点另一个是换）')
  ok(runPointer('file', targetInside('.drawai-tools')).join(',') === 'menu:null,pos:null', '只放过"开菜单的按钮"，不是整个工作栏（点按钮之间的缝 = 外面 → 关）')
  ok(runPointer('open', targetOutside).join(',') === 'menu:null,pos:null', '「打开/新建/另存为」面板同样点外面就关')
  // 目标没有 closest（例如事件落在 document 上）时，它一定不在菜单里 → 该关
  ok(runPointer('file', {}).join(',') === 'menu:null,pos:null', '事件目标没有 closest（document 之类）→ 关掉')

  // 文字输入框：外面按一下 → 提交（画布的 preventDefault 挡掉了 blur，只能自己判）
  const EDIT = { kind: 'node', id: 'n1', text: 'x' }
  ok(runPointer(null, targetOutside, EDIT).join(',') === 'commit', '编辑中点到画布空白 → 提交并退出：' + runPointer(null, targetOutside, EDIT).join(','))
  ok(runPointer(null, targetInside('.drawai-edit'), EDIT).length === 0, '点输入框自己（选字/移动光标）→ 不提交')
  ok(runPointer(null, targetOutside, null).length === 0, '没在编辑时不会平白提交一次')
  ok(runPointer('file', targetOutside, EDIT).join(',') === 'commit,menu:null,pos:null', '两件事可以同时发生：提交文字 + 收掉菜单')
  // 输入框的 blur 仍然是兜底（点浏览器外、Tab 走焦都会走它）
  ok(/onBlur: commitEdit/.test(src), '输入框保留 onBlur 兜底（点击浏览器外/Tab 走焦也要提交）')

  // 接线：root 上必须真的挂了这个捕获处理器，否则函数写得再对也没人调
  ok(/onPointerDownCapture: onRootPointerDown/.test(src), 'root 上挂了 onPointerDownCapture（捕获阶段，早于画布自己的按下处理）')
  const rootStart = src.indexOf("{ className: 'drawai-root'")
  ok(rootStart >= 0 && src.slice(rootStart, rootStart + 160).indexOf('onPointerDownCapture') >= 0, '挂的就是 root（画布、标签条、工作栏都在它里面）')
  // 放过的那一类按钮必须真的带这个类名，否则"点同一个按钮关不掉"
  ok(/className: 'drawai-btn drawai-menu-trigger'/.test(src), '开菜单的按钮带 drawai-menu-trigger 类（与处理器里的选择器对得上）')
  // 编辑框也要真的带那个类名（否则"点输入框自己"会被判成外面）
  ok(/className: 'drawai-edit'/.test(src), '输入框带 drawai-edit 类（与处理器里的选择器对得上）')
  // Esc 同一套语义：菜单开着按 Esc 也该收掉
  const escStart = src.indexOf("event.key === 'Escape'", src.indexOf('function onKey(event)'))
  const escBranch = escStart >= 0 ? src.slice(escStart, escStart + 400) : ''
  ok(/setDocMenu\(null\)/.test(escBranch), 'Esc 也收掉下拉菜单/面板（"退出这一层"的语义要一致）')
}

console.log('\n双击改标签：按下时不许抢 pointer capture')
{
  // 真实事故：`onNodePointerDown` 里按下就 setPointerCapture(画布) —— pointer capture 会把
  // 随后的 click / dblclick 目标改成**捕获元素**（click 取按下/松开两个目标的公共祖先，
  // 而被捕获的 pointerup 目标是画布容器），于是节点那个 <g> 不在事件路径里，
  // "双击节点改内容"彻底失灵（Chrome 判为 working as intended，见 w3c/pointerevents#356）。
  // 修法：按下只登记，等真的动了（>3px）才在 pointermove 里抢 —— 一次点击完全不抢捕获。
  const capBody = bodyOf('takePendingCapture')
  ok(capBody !== null, '源码里有 takePendingCapture')

  // 结构性守卫：全文件里 setPointerCapture 只允许有**一处**调用，并且它在 takePendingCapture 里。
  // （以前它在 6 个 pointerdown 路径里各抄了一遍，所以双击改标签是全坏的。）
  const capCalls = src.match(/setPointerCapture\(event\.pointerId\)/g) || []
  ok(capCalls.length === 1, 'setPointerCapture 全文件只有一处调用（实际 ' + capCalls.length + ' 处）')
  ok(capBody !== null && capBody.indexOf('setPointerCapture(event.pointerId)') >= 0, '那一处就在 takePendingCapture 里')
  ok(/function requestCapture\(event\)/.test(src), '按下时走的是 requestCapture（只登记坐标，不抢捕获）')
  ok((src.match(/requestCapture\(event\)/g) || []).length >= 6, '每个拖动入口都登记（节点/连线/框选/平移/缩放/改接…）：实际 ' + (src.match(/requestCapture\(event\)/g) || []).length + ' 处')
  ok(/takePendingCapture\(event\)/.test(bodyOf('onCanvasPointerMove') || ''), 'pointermove 里才真正抢捕获')
  ok(/pendingCaptureRef\.current = null/.test(bodyOf('onCanvasPointerUp') || ''), '手势结束清掉登记（这一轮没拖 = 就是点击，不能在后面的 move 里突然抢）')

  // 行为：喂假事件真的跑一遍
  const runTake = (pending, move) => {
    const captured = []
    const ref = { current: pending }
    const canvas = { current: { setPointerCapture: (id) => captured.push(id) } }
    const fn = new Function(
      'pendingCaptureRef',
      'canvasRef',
      'CAPTURE_MOVE_PX',
      'return function takePendingCapture(event) ' + capBody,
    )(ref, canvas, 3)
    fn(move)
    return { captured: captured, pending: ref.current }
  }

  const idle = runTake(null, { pointerId: 1, clientX: 10, clientY: 10 })
  ok(idle.captured.length === 0, '没有登记时什么都不做')

  // 手抖 1px 的点击：不许抢捕获（抢了 dblclick 就落到画布上）
  const jitter = runTake({ pointerId: 1, x: 100, y: 100 }, { pointerId: 1, clientX: 101, clientY: 100 })
  ok(jitter.captured.length === 0, '移动 1px（手抖）不抢捕获')
  ok(jitter.pending !== null, '不抢时登记还留着（后面动得更远再抢）')

  const moved = runTake({ pointerId: 1, x: 100, y: 100 }, { pointerId: 1, clientX: 104, clientY: 100 })
  ok(moved.captured.join(',') === '1', '移动 4px（真的在拖）才抢捕获：' + moved.captured.join(','))
  ok(moved.pending === null, '抢过之后登记清掉（不重复抢）')

  const other = runTake({ pointerId: 1, x: 100, y: 100 }, { pointerId: 7, clientX: 200, clientY: 200 })
  ok(other.captured.length === 0 && other.pending !== null, '别的 pointer 的移动不会替这一路抢捕获（多指/多设备）')

  // 3px 判据与"越 3px 才算拖"同一套手感
  const exactly = runTake({ pointerId: 1, x: 100, y: 100 }, { pointerId: 1, clientX: 103, clientY: 100 })
  ok(exactly.captured.length === 0, '正好 3px 还不算拖（判据是 >3）')
}

console.log('\n线型与字号的手工入口')
{
  // 需求："添加直线（无折点），圆弧线等" + "文字的字号均可修改"。
  // 线型是"语义 + 几何"两件事（直线要清折点、曲线要补弓形中点），所以走 applyLineKind，
  // 不是普通 updateEdge；字号是三个地方共用同一个控件。
  ok(/function applyLineKind\(/.test(src), '有 applyLineKind（线型连带几何一起改）')
  ok(
    /\['straight', '直线'/.test(src) && /\['sharp', '直角折线'/.test(src) && /\['rounded', '圆角折线'/.test(src) && /\['curved', '曲线'/.test(src),
    '连线菜单里有 直线 / 直角折线 / 圆角折线 / 曲线 四个入口',
  )
  ok(/rounded', '圆角折线', '正交折线，只在折点处倒圆角/.test(src), '圆角折线的说明写清了"只在折点处"（rounded=1）')
  ok(/applyLineKind\(edgeTargets, it\[0\]\)/.test(src), '点线型对整组连线生效（与改色/箭头一致）')
  ok(/kind === 'straight'\) \{\s*\n\s*delete e\.points/.test(src) || /if \(kind === 'straight'\) \{\n\s+delete e\.points/.test(src), '选直线会清掉折点')
  ok(/e\.points = \[\{ x: snap\(/.test(src), '选曲线会给"本来就笔直"的边补一个弓形中点（否则弧看不见）')
  // 空白处右键：一条**直线**（无折点）
  ok(/'╱ 直线'/.test(src), '空白处右键有「╱ 直线」入口')
  ok(/createFreeEdgeAt\(menu\.userX, menu\.userY, 'straight'\)/.test(src), '它建的是直线（createFreeEdgeAt 的第三个参数）')
  ok(/straight \? styleWithLineKind\(DEFAULT_EDGE_STYLE, 'straight'\) : DEFAULT_EDGE_STYLE/.test(src), '那条线的样式真的是直线')
  // 字号：节点/文字与连线共用同一个控件
  ok(/function fontSizeRow\(/.test(src), '有 fontSizeRow（三个地方共用）')
  ok(/const FONT_SIZE_PRESETS = \[/.test(src), '字号有档位表（不写死在 UI 里）')
  ok(/key: 'fontSize',\s*\n\s*label: '字号',\s*\n\s*value: styleSummary\(nodeStyle, 'fontSize'\)/.test(src), '节点菜单（含独立文字）有字号行')
  ok(/key: 'fontSize',\s*\n\s*label: '字号',\s*\n\s*value: styleSummary\(edgeBaseStyle, 'fontSize'\)/.test(src), '连线菜单有字号行（改的是线上的字）')
  ok(/fontSize: v === null \? null : String\(v\)/.test(src), '「默认」= 删掉 fontSize 键（不留 fontSize=0 之类噪音）')
}

console.log('\n右键菜单：几类只显示当前值，并排成一行')
{
  // 需求："右键时不要把所有元素的所有类型都展示出来……仅展示每一类的当前值，每一类可通过下拉列表切换"，
  // 随后确认："三个「类：当前值」并排成一行"。
  // 以前一屏铺着 形状 10 个缩略图 + 配色 8 个色块 + 字号 6 个 + 线型 4 个 + 样式 3 个 + 箭头 4 个。
  ok(/function menuSelectRow\(cats\)/.test(src), '有 menuSelectRow（一次给出若干类）')
  ok(/menu\.openKey === cat\.key/.test(src), '展开状态记在 menu.openKey 上（换元素右键自动收起、点另一类收起上一类）')
  ok(/className: 'drawai-btn drawai-select-chip'/.test(src), '每一类是一个 chip 按钮（不是整行）')
  ok(/cat\.label \+ '：' \+ cat\.value/.test(src), 'chip 上显示的就是「类名：当前值」')
  ok(/if \(menu\.openKey !== cats\[i\]\.key\) continue/.test(src), '选项体只在展开的那一类下面渲染（收起时一个按钮都不多）')
  ok(/function closeSelect\(\)/.test(src), '选完一个值就收起来')

  // 三个菜单各自**一次**menuSelectRow 调用里给出全部类 —— 这才是"并排成一行"
  const callSites = src.match(/menuSelectRow\(\[/g) || []
  ok(callSites.length === 3, '三处右键菜单各调用一次 menuSelectRow（画布 / 节点 / 连线），实际 ' + callSites.length + ' 处')
  const categories = ['shape', 'color', 'fontSize', 'line', 'dash', 'arrow', 'fontColor']
  for (const key of categories) {
    ok(new RegExp("key: '" + key + "'").test(src), '「' + key + '」这一类在 menuSelectRow 的 cats 里')
  }
  ok(!/rows\.push\(shapeGrid\(/.test(src), '形状不再把 10 个缩略图直接铺在菜单里')
  ok(!/rows\.push\(swatchRow\(/.test(src), '配色不再把 8 个色块直接铺在菜单里')
  ok(!/rows\.push\(fontSizeRow\(/.test(src), '字号不再把 6 个档位直接铺在菜单里')
  ok(
    !/rows\.push\(dashRow\(/.test(src) && !/rows\.push\(arrowRow\(/.test(src) && !/rows\.push\(\s*\n\s*lineRow\(/.test(src),
    '样式/箭头/线型也不再直接铺开',
  )

  // 并排：chips 横排 + 每个 chip 不换行；菜单再夹一道最大宽度（否则宽出来的部分会被 overflow:hidden 裁掉）
  ok(/\.drawai-select-chips\{display:flex;flex-wrap:wrap/.test(src), 'chips 是横向 flex（右栏放不下才折行）')
  ok(/\.drawai-select-chip\{display:inline-flex;align-items:center;gap:2px;white-space:nowrap\}/.test(src), '单个 chip 是 inline-flex 且不换行（"形状：矩形 ▾"不会被拆成两行）')
  ok(/const maxWidth = size\.w > 0 \? Math\.max\(180, size\.w - left - 8\)/.test(src), '菜单夹了一道最大宽度（chips 横排后可能比 214px 宽）')
  ok(/maxWidth: maxWidth === undefined \? undefined : maxWidth \+ 'px'/.test(src), '这个最大宽度真的落到菜单的 style 上')

  // 当前值必须来自纯函数（能被命令行自测直接断言），而不是在 JSX 里现拼
  ok(/styleSummary: styleSummary,/.test(src), 'styleSummary 挂进 internals（自测能直接调）')
  ok(/PALETTE_LABELS\[menuStyle\] === undefined \? styleSummary\(menuStyle, 'color'\)/.test(src), '空白处右键的「配色」显示当前选中的那个（而不是颜色名表里查不到就空着）')
  ok(/createNodeAt\(menuShape, menuStyle, menu\.userX, menu\.userY\)/.test(src), '「＋ 新增节点」放的就是下拉里选中的形状（当前值语义）')
  // 动作类（改标签/删除/顺序…）仍然是一排按钮：它们没有"当前值"，收进下拉反而多一次点击
  ok(/reorderItem\('node', menu\.id, 'front'\)/.test(src) && /openNodeEditor\(menu\.id\)/.test(src), '动作类仍然是按钮（顺序 / 改标签 / 删除…）')
  // 展开体的样式：缩进 + 左侧竖线，看起来是那排 chips 的下拉面板
  ok(/\.drawai-menu-select-body\{/.test(src), '展开体有对应样式（缩进 + 左侧竖线）')
}

console.log('\n下拉里的选项横着排 + 字号可手动调节')
{
  // 需求："下拉列表横向排布，字号需要可以手动调节大小"。
  const body = bodyOf('fontSizeRow') || ''
  ok(body.length > 0, '有 fontSizeRow')
  // 横向排布：选项条一律 flex + 允许换行，形状缩略图按原尺寸自动填充（不被挤扁）
  ok(/\.drawai-menu-select-body>\.drawai-menu-row,\.drawai-menu-select-body>\.drawai-fontrow\{[^}]*display:flex;flex-wrap:wrap/.test(src), '下拉里的选项条是横向 flex（放不下才换行）')
  ok(/\.drawai-fontrow\{display:flex;flex-wrap:wrap/.test(src), '字号那一行也是横向 flex')
  ok(/\.drawai-menu-select-body>\.drawai-grid\{grid-template-columns:repeat\(auto-fill,minmax\(42px,1fr\)\)\}/.test(src), '形状缩略图按 42px 自动填充（5 列 1fr 会把 44px 的缩略图挤扁）')
  ok(/\.drawai-menu-select-body>\.drawai-swatches\{margin-top:0;flex-wrap:wrap\}/.test(src), '色板也横排并允许换行')

  // 字号手动调节：− [输入框] ＋
  ok(/function clampFontSize\(value\)/.test(src), '有 clampFontSize（纯函数，边界自测在 check-render）')
  ok(/const FONT_SIZE_MIN = 8/.test(src) && /const FONT_SIZE_MAX = 72/.test(src), '手动输入有范围常量（8–72）')
  ok(/type: 'number'/.test(body) && /min: FONT_SIZE_MIN/.test(body) && /max: FONT_SIZE_MAX/.test(body), '输入框是 number 且带 min/max')
  ok(/className: 'drawai-fontsize'/.test(body), '输入框有自己的样式类')
  ok(/if \(event\.key === 'Enter'\)/.test(body) && /commit\(event\.target\.value, true\)/.test(body), '回车生效并收起')
  ok(/onBlur: \(event\) => commit\(event\.target\.value, false\)/.test(body), '失焦也生效（且不收起，方便接着点 ＋/−）')
  ok(!/onChange:/.test(body), '打字过程中不写文档（回车/失焦才落盘 —— 与"双击改标签"同一套节奏）')
  ok(/key: 'fs-minus'/.test(body) && /key: 'fs-plus'/.test(body), '有 − / ＋ 两个步进按钮')
  ok(/const next = clampFontSize\(raw\)/.test(body) && /if \(next !== current\) apply\(next\)/.test(body), '输入值先夹取、与当前值相同就不写（不制造无意义的撤销步）')
  ok(/const next = Math\.min\(FONT_SIZE_MAX, Math\.max\(FONT_SIZE_MIN, base \+ delta\)\)/.test(body), '步进同样受范围限制')
  ok(/if \(String\(current\) !== String\(it\[0\]\)\) apply\(it\[0\]\)/.test(body), '点档位时值没变也不写文档（以前每次点击都会压一步撤销历史）')
  ok(/key: 'fs-input-' \+ String\(current\)/.test(body), '输入框非受控但随当前值重挂（步进之后显示的仍是新值）')
}

console.log('\n独立文字：右键空白处能放一段字（不接节点、也不接边）')
{
  // 需求："添加可独立放置的文字"。实现上它是**一个节点**，只是形状是 drawio 的 text
  // （没有边框、没有底色），于是拖动/缩放/改字/进图层/复制粘贴全都免费复用节点那一套。
  ok(/'T 文字'/.test(src), '空白处的右键菜单里有「T 文字」入口')
  ok(/createNodeAt\('text', menuStyle, menu\.userX, menu\.userY\)/.test(src), "它调用 createNodeAt('text', …) —— 位置就是点的地方")
  ok(/label: isText \? '文字' : '新节点'/.test(src), '文字元素的默认文字是「文字」')
  // 文字不吃配色：它的样式就是 drawio 的 defaultTextStyle，盖上 fillColor/strokeColor
  // 只会让文件与 drawio 不一致，屏幕上还什么都看不出来。
  ok(
    /isText \? styleWithNodeShape\('', shape\) : styleWithColorName/.test(src),
    'createNodeAt 对文字不套配色（保持 drawio 的 defaultTextStyle）',
  )
  ok(/if \(isText\) openNodeEditor\(id\)/.test(src), '放下来直接进编辑态（drawio 的 insertText 也是这样）')
  ok(/\{ shape: 'text', label: '文字' \}/.test(src), '形状面板里有「文字」（普通节点也能换成文字）')
  ok(
    /isTextNode \? styleWithTextColorName\(nodeStyle, color\) : styleWithColorName/.test(src),
    '文字元素的调色板改 fontColor 而不是填充/描边（否则点一圈颜色毫无变化）',
  )
}

console.log('\n自环与复制粘贴的接线（手势与快捷键必须真的连上）')
{
  // 用与产物同款的组合 body 当"源码"：这里断言的是文本接线，不是运行行为。
  const source = src
  // 自环：手势不能再被挡住，且预览与落盘共用"进出口不同侧"的纠正。
  ok(!/if \(linking\.from === id\) return/.test(source), '连线拖回起点不再被直接 return 掉（自环手势通了）')
  ok(/selfLoopPath/.test(source) && /nextSideOf/.test(source), '自环路由与"换一个侧"的纠正都在')
  ok(/toSide === seedSide\) toSide = nextSideOf/.test(source), '预览里也做同侧纠正（预览即结果）')
  // 剪贴板：快捷键与菜单项都接上了。
  ok(/event\.key === 'c'/.test(source) && /copySelection\(\)/.test(source), 'Ctrl+C → copySelection')
  ok(/event\.key === 'x'/.test(source) && /cutSelection\(\)/.test(source), 'Ctrl+X → cutSelection')
  ok(/event\.key === 'v'/.test(source) && /pasteClipboard\(\)/.test(source), 'Ctrl+V → pasteClipboard')
  ok(
    /item\('复制', copySelection/.test(source) && /item\('剪切', cutSelection/.test(source) && /item\('粘贴', pasteClipboard/.test(source),
    '编辑菜单里有复制 / 剪切 / 粘贴',
  )
  ok(/let clipboard = null/.test(source), '剪贴板是模块级的（跨标签页也能贴）')
}

console.log('\n键盘归属：在别处打字时画布一个键都不许碰')
{
  // 用户实测报过两条：
  //   · 在输入框里按退格 → 删掉的是**画布里的选中内容**；
  //   · 画布打开时，输入框里的 Ctrl+C/V 不管用。
  // 根因是画布的快捷键挂在 window 上，而**DSH 的输入框是 Lexical 的 contenteditable**：
  // 之前只挡 input/textarea，事件目标又常常是输入框内部的 span，于是全部漏过去。
  //
  // 这一节喂假 DOM 节点给那个纯函数，把判据钉住。
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', 'window', 'document', src)(
    mod,
    mod.exports,
    (s) => {
      if (s === 'react') return makeReact()
      throw new Error('unexpected require ' + s)
    },
    { addEventListener() {}, removeEventListener() {} },
    fakeDocument,
  )
  const internals = mod.exports.__routeInternals
  const owns = internals.canvasOwnsKeyboard
  const isText = internals.isTextEntry

  const el = (tag, extra) => Object.assign({ tagName: tag, closest: () => null }, extra || {})
  /** 输入框**里面**的 span：closest 能找到外面的 contenteditable。 */
  const innerOf = (host) => el('SPAN', { closest: (sel) => (String(sel).indexOf('contenteditable') >= 0 ? host : null) })
  const root = { contains: (node) => node === root || node.inRoot === true }
  const key = (target, active) => owns({ target: target }, root, active)

  ok(isText(el('TEXTAREA')) && isText(el('INPUT')) && isText(el('SELECT')), 'isTextEntry：input / textarea / select 都算')
  ok(isText(el('DIV', { isContentEditable: true })) === true, 'isTextEntry：contenteditable 宿主算（DSH 的输入框就是它）')
  const lexicalHost = el('DIV', { isContentEditable: true })
  ok(isText(innerOf(lexicalHost)) === true, 'isTextEntry：输入框里的 span 也算（事件目标就是它）')
  ok(isText(el('DIV', { isContentEditable: false })) === false, 'isTextEntry：普通 div 不算')

  ok(key(el('TEXTAREA'), el('TEXTAREA')) === false, '<textarea> 里按键 → 画布放手')
  ok(key(innerOf(lexicalHost), lexicalHost) === false, 'Lexical 输入框里按键 → 画布放手（退格不再删画布内容）')
  ok(key(el('DIV', { isContentEditable: true }), el('BODY')) === false, '目标就是输入宿主 → 放手')
  ok(key(el('BODY'), el('BODY')) === true, '焦点在 body（刚点过画布）→ 画布处理')
  ok(key(el('BODY'), undefined) === true, '什么都没有聚焦 → 画布处理')
  ok(key(el('BUTTON', { inRoot: true }), el('BUTTON', { inRoot: true })) === true, '焦点在本面板的按钮上 → 画布处理')
  ok(key(el('BUTTON'), el('BUTTON')) === false, '焦点在别的面板的按钮上 → 画布放手')
  ok(key(el('BODY'), null) === true, '焦点是 null → 画布处理')

  // 接线：window 上的那个 keydown 必须**先问归属**再动任何东西（否则上面这些判据白搭）。
  const onKeyStart = src.indexOf('function onKey(event) {')
  const onKeyBody = onKeyStart >= 0 ? src.slice(onKeyStart, src.indexOf('window.addEventListener(', onKeyStart)) : ''
  ok(/canvasOwnsKeyboard\(event, rootRef\.current, document\.activeElement\)/.test(onKeyBody), 'onKey 第一件事就是问 canvasOwnsKeyboard')
  const guardAt = onKeyBody.indexOf('canvasOwnsKeyboard(')
  const firstAction = Math.min(
    ...[onKeyBody.indexOf('preventDefault()'), onKeyBody.indexOf('deleteSelected()'), onKeyBody.indexOf('copySelection()')].filter((i) => i >= 0),
  )
  ok(guardAt >= 0 && guardAt < firstAction, '归属判定排在 preventDefault / 删除 / 复制之前')
}

console.log('\n选区上报：客户端把"用户选中了什么"告诉宿主（AI 侧才读得到）')
{
  // 为什么单列一节：这一条**只在客户端成立**（宿主那一半 check-host 已经测了：selection 端点
  // 存下来、diagram_read 带回去、按文件配对、删掉就划掉）。客户端这边最容易犯的错是
  // "每次 setSelectedIds 就发一次请求"（框选时等于按帧打宿主）或者"藏着不发"（AI 又看不见了）。
  const at = src.indexOf("action: 'selection'")
  ok(at > 0, "客户端有选区上报（action: 'selection'）")
  // 以上报点为中心取一段窗口做结构性守卫（跨到别的函数去就会假绿，所以窗口刻意收窄）。
  const around = at > 0 ? src.slice(Math.max(0, at - 1200), at + 700) : ''
  ok(/React\.useEffect\(/.test(around), '上报挂在 effect 里（渲染期发请求会每帧打一次）')
  ok(/setTimeout\(/.test(around) && /clearTimeout\(handle\)/.test(around), '有防抖：setTimeout + 清理 clearTimeout（框选时选区每动一下就变）')
  ok(around.indexOf('SELECTION_REPORT_MS') >= 0, '防抖时长走 SELECTION_REPORT_MS 常量，不是就地写个魔数')
  ok(/\[selectedIds, target, sessionId, active, hasPath\]/.test(around), '依赖里有 selectedIds（选区变了才重发）与 target/hasPath（带路径给宿主按文件配对）')
  ok(/path: hasPath \? target : ''/.test(around), "上报带着当前画布路径（不带路径的旧选区会串到别的文件上）")
  ok(/client === null \|\| !active/.test(around), '隐藏标签、或根 ctx 还没绑定时不上报')
  ok(/\.catch\(\(\) => \{\}\)/.test(around), '上报失败静默（老宿主没这条路由时不该在界面上冒错）')
}

console.log('\n导出通道：客户端接住 AI 的导出请求、渲染、回执')
{
  // 渲染器只在客户端，所以 AI 的 `{op:'export'}` 是"宿主挂请求 → 客户端轮询取走 → 渲染 → 回执"。
  // 这半边最容易犯的两个错：**不去重**（每 3 秒下载一次 PNG）与**把 svg 也下载**（AI 要的是
  // 工作区里的一个文件，不是用户下载目录里的一份）。
  ok(src.indexOf("action: 'export-result'") > 0, "客户端会回执导出结果（action: 'export-result'）")
  ok(/function reportExportResult\(requestId, format, payload\)/.test(src), '有 reportExportResult（唯一的上报出口）')
  ok(/payload\.export/.test(src), '轮询回执里读 payload.export（宿主把请求挂在那儿）')
  ok(/exportHandledRef\.current !== wantExport\.requestId/.test(src), '按 requestId 去重（不去重就是每 3 秒下载一次）')
  ok(/format: wantExport\.format === 'png' \? 'png' : 'svg'/.test(src), 'AI 的请求走对象形态（带 requestId 与 format）')
  const pick = src.indexOf('const wantExport = payload.export')
  const pickBody = pick >= 0 ? src.slice(pick, pick + 900) : ''
  ok(/setSelectedIds\(\[\]\)/.test(pickBody) && /setExportRequest\(/.test(pickBody), '导出前先清掉选中（不然手柄会被拍进产物）')
  const effectAt = src.indexOf("reportExportResult(requestId, 'svg'")
  ok(effectAt > 0, 'AI 的 svg 回执给宿主落盘（不是浏览器下载）')
  ok(/reportExportResult\(requestId, 'png', \{ ok: true, downloaded: true \}\)/.test(src), 'png 走浏览器下载，只回执"已下载"')
  ok(/reportExportResult\(requestId, format, \{ ok: false, error:/.test(src), '渲染不出来时也要回执失败（AI 才能如实告诉用户）')
}

console.log('\n字色：节点与连线的标签颜色都能改（fontColor）')
{
  // 以前只有「独立文字」的配色会落到 fontColor —— 普通节点/连线的**字色**在画布上根本没有入口
  //（节点菜单里的"配色"改的是填充+描边，连线菜单里连颜色都只有 strokeColor）。
  // 这一节盯的是"接线"：两类各有一行字色、写的是同一个键、色板预览的是文字色。
  const labelHits = src.match(/label: '字色'/g) || []
  ok(labelHits.length === 2, '节点菜单与连线菜单各有一类「字色」（实际 ' + labelHits.length + ' 处）')
  const keyHits = src.match(/key: 'fontColor'/g) || []
  ok(keyHits.length === 2, '两类的 key 都是 fontColor（实际 ' + keyHits.length + ' 处）')
  ok(/label: isTextNode \? '字色' : '配色'/.test(src), '独立文字的那一类直接叫「字色」（它没有填充描边，配色就是字色）')
  ok(/\.\.\.\(isTextNode\s*\n\s*\? \[\]/.test(src), '独立文字不再多出一类重复的「字色」（同一件事两个入口只会让人犹豫）')
  // 写入路径：节点走内核的 styleWithTextColorName（'plain' = 删键回缺省字色），连线走 updateEdge 的 fontColor
  ok(
    /updateNode\(nodeTargets, \{ style: styleWithTextColorName\(nodeStyle, color\) \}\)/.test(src),
    '节点字色写进 fontColor（与独立文字同一套内核函数）',
  )
  ok(/updateEdge\(edgeTargets, \{ fontColor: color \}\)/.test(src), '连线字色走 updateEdge 的 fontColor')
  ok(
    /if \(has\(patch, 'fontColor'\)\) style = styleWithTextColorName\(style, patch\.fontColor\)/.test(src),
    'updateEdge 真的把 fontColor 落成 style 键（不是记在别处）',
  )
  // 色板预览：字色那一行必须显示**文字色**（调色板的 stroke 那一支），否则点"黄"得到的字色看着像点错了
  ok(/forFont \? '字色：' : ''/.test(src), '字色色板的 title 标明是字色')
  ok(/background: isPlain \? '#000000' : entry\.stroke/.test(src), '字色色板用 stroke 那一支预览（与 styleWithTextColorName 同源）')
  const fontKind = src.match(/,\s*\n\s*'font',\s*\n/g) || []
  ok(fontKind.length === 2, '两类字色都用了 kind="font" 的色板（实际 ' + fontKind.length + ' 处）')
}

console.log('\n「看一眼」：客户端渲成 PNG 回执给宿主（不下载、不落工作区）')
{
  // AI 的 `diagram_read {render:true}` 靠这半边把画布变成图：渲成 PNG → base64 回执 →
  // 宿主存进附件库（工作区零文件）。最容易犯的两个错：**去下载**（那就跑到用户下载目录去了）、
  // **不设体量上限**（base64 比原图大 1/3，超了写回路由会直接拒，模型只能看到失败）。
  ok(src.indexOf("action: 'render-result'") > 0, "客户端会回执渲染结果（action: 'render-result'）")
  ok(/function reportRenderResult\(requestId, payload\)/.test(src), '有 reportRenderResult（这条路上唯一的上报出口）')
  ok(/function renderPngPayload\(node, width, height, scale\)/.test(src), '有 renderPngPayload（渲成 base64，不触发下载）')
  const payloadAt = src.indexOf('function renderPngPayload(')
  const payloadSrc = payloadAt >= 0 ? src.slice(payloadAt, payloadAt + 1600) : ''
  ok(/toDataURL\('image\/png'\)/.test(payloadSrc), '用 canvas 的 toDataURL 取 PNG（不落文件）')
  ok(/downloadBlob|downloadPng/.test(payloadSrc) === false, '这条路上**没有任何下载**（下载 = 跑到用户的下载目录里去了）')
  ok(/context\.fillStyle = mode === 'dark'/.test(payloadSrc), '底色跟随主题（深色模式下别给模型一张纯白底图）')
  ok(/payload\.render/.test(src), '轮询回执里读 payload.render（宿主把请求挂在那儿）')
  ok(/lookHandledRef\.current !== wantLook\.requestId/.test(src), '按 requestId 去重（不去重就是每 3 秒渲一遍）')
  ok(/LOOK_MAX_BASE64/.test(src), '有回执体量上限（base64 比原图大 1/3，超了会被写回路由拒掉）')
  ok(/renderPngPayload\(built\.node, built\.width, built\.height, 1\)/.test(src), '超限时降到 1× 重渲（而不是直接失败）')
  ok(/reportRenderResult\(requestId, \{ ok: false, error: message \}\)/.test(src), '渲染失败也要回执 ok:false（否则宿主永远 pending）')
  ok(/function renderPngPayload/.test(src) && /function downloadPng/.test(src), '「给模型看」与「给用户导出」各走各的（但共用同一套取图路径）')
}

console.log('\n「自动路由」不许把悬空端的落点一起删掉（独立线会整条消失）')
{
  // 真实事故（AI 那条 op 上先踩到的）：给一条"两端都是自由点"的独立线清折点，
  // 自由端点被无条件删掉 → 这条边一个落点都不剩 → 写回整条跳过 → 画布上那条线就没了。
  // AI 侧已修（check-host 里盯着），这里是画布这一侧的同一处。
  const body = bodyOf('clearEdgeWaypoints')
  ok(body !== null, '源码里有 clearEdgeWaypoints')
  const clearSrc = body === null ? '' : body
  ok(/delete e\.points/.test(clearSrc), '折点照旧无条件清掉（它本来就是折点）')
  ok(/if \(typeof e\.from === 'string'\) delete e\.sourcePoint/.test(clearSrc), '自由端点只在那一端**有真实顶点**时才删（起点）')
  ok(/if \(typeof e\.to === 'string'\) delete e\.targetPoint/.test(clearSrc), '自由端点只在那一端**有真实顶点**时才删（终点）')
  ok(
    /^\s*delete e\.sourcePoint\s*$/m.test(clearSrc) === false && /^\s*delete e\.targetPoint\s*$/m.test(clearSrc) === false,
    '没有"无条件删自由端点"那种写法（那正是上面那个事故）',
  )
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
