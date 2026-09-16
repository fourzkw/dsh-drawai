/**
 * 宿主半边的行为自测 —— 不需要 DSH 在跑，也不碰真实文件。
 *
 * 为什么必须有：宿主半边没有热重载，改完要重启 `dsh web` 才生效 ——
 * 而"重启之后才发现改错了"是最贵的反馈回路。这里用**内存文件系统**跑完整的
 * diagram_apply / diagram_read 流程，把反馈压到一秒内。
 *
 * 重点覆盖那些"静默出错"的路径 —— 不报错、但结果不对：
 *   · meta.pinned 在 AI 改图后是否还在（丢了会导致人手工摆的版面被整张重排）
 *   · 非法 ops 是否**在写盘之前**失败（不能留下半张烂图）
 *   · revision 是否每次 +1（客户端的乐观锁靠它）
 *   · 连线的 dash / arrow / color 是否真的落到文档里
 *
 * 用法：node tools/check-host.mjs
 */
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
// 自测直接引用样式内核：文档格式的"真相"只有一份，测试跟着它走，而不是把键名再抄一遍。
import { DEFAULT_EDGE_STYLE, edgeFreePoint, formatStyle, lineKindFromStyle, nodeShapeFromStyle, parseStyle, styleGet, styleWithSide,
  styleWithTextColorName } from '../src/style-kernel.js'
// 夹具与断言都用**源文件**的编解码：check-host 打的是 lib/index.js（产物），两边必须同源。
import { buildMxfile, contentHash, parseMxfile } from '../src/mxfile.js'
// 写回路径也要能直接断言（"纸张尺寸不参与写回"这类"原样保留"的性质不看产物看不出来）。
import { applyDocToMxfile } from '../src/mxfile.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

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

/** @deepseek-ai/dsh-tools 必须在 profile 里可解析；工作区自测先建 junction（见 README）。 */
const require = createRequire(import.meta.url)
try {
  require.resolve('@deepseek-ai/dsh-tools')
} catch (error) {
  console.log('无法解析 @deepseek-ai/dsh-tools —— 宿主半边 import 不了，本自测无法运行。')
  console.log('')
  console.log('在工作区里先建 junction：')
  console.log('  New-Item -ItemType Directory -Force -Path node_modules\\@deepseek-ai | Out-Null')
  console.log('  New-Item -ItemType Junction -Path node_modules\\@deepseek-ai\\dsh-tools `')
  console.log('    -Target "$env:APPDATA\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-tools"')
  process.exit(1)
}

const mod = await import('../lib/index.js')

/** 内存文件系统：只需实现宿主半边用到的那些面。 */
const store = new Map()
const WORKSPACE = 'D:\\fake-workspace'
const SESSION = { header: { cwd: WORKSPACE } }
/** 第二个会话：工作区指向一个**真实**目录（list 用 node:readdir，内存桩骗不过它）。 */
const SESSION2 = { header: { cwd: '' } }

/**
 * 真实 DSH 的 ctx.fs 里，resolve() 返回的是一个**目标句柄**（绝对路径是它的一部分），
 * 而后续的 stat/readText/writeText 都吃这个句柄。第一版桩把 resolve 写成了
 * `{ path: 入参 }`（相对路径原样返回），于是写落在相对 key、读命中绝对 key —— 表现是
 * "工具好像没写盘"。那是桩的错，不是工具的错：真实 fs 两者必然一致。
 * 这里让 resolve/processPath 统一产出同一个绝对路径，才是对的建模。
 */
function targetOf(p) {
  // resolve() 的产物是**句柄**，processPath(句柄) 在真实 fs 里回的是它自己的绝对路径。
  // 少了这一支，processPath(句柄) 会退化成 "[object Object]" —— 两个不同文件于是算出
  // **同一个** absolute，任何"按文件配对"的逻辑在自测里都会假绿（实测：选区串了文件）。
  if (p !== null && typeof p === 'object' && typeof p.path === 'string') return p
  return { path: WORKSPACE + '\\' + String(p).replace(/^[\\/]+/, '') }
}

const fs = {
  processPath(p) {
    return targetOf(p).path
  },
  async resolve(p) {
    return targetOf(p)
  },
  async stat(target) {
    const text = store.get(target.path)
    return text === undefined ? undefined : { size: text.length }
  },
  async readText(target) {
    return store.get(target.path)
  },
  async writeText(target, text) {
    store.set(target.path, text)
  },
  contains() {
    return true
  },
}

const tools = new Map()
/** 写回路由：捕获下来，好在自测里直接打它（它是"导入/导出"的唯一入口）。 */
const routes = []
const ctx = {
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => {}
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  fs: fs,
  sessions: {
    get(id) {
      if (id === 's1') return SESSION
      if (id === 's2') return SESSION2
      return undefined
    },
  },
  sandboxPolicy: {
    // 忠实建模：真实 DSH 的 resolve({ session }) 以**会话的 cwd** 作为可写根。
    resolve(options) {
      const session = options !== undefined && options !== null ? options.session : undefined
      const cwd = session !== undefined && session !== null && session.header !== undefined ? session.header.cwd : undefined
      const root = typeof cwd === 'string' && cwd.length > 0 ? cwd : WORKSPACE
      return { mode: 'workspace-write', workspaceRoot: root }
    },
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

mod.apply(ctx)

const applyTool = tools.get('diagram_apply')
const readTool = tools.get('diagram_read')
const exec = { agent: { id: 's1' } }

/** 调一次 diagram_apply。 */
async function apply(ops, extra) {
  const args = Object.assign({ path: 'doc.drawio', ops: ops }, extra === undefined ? {} : extra)
  return await applyTool.execute(args, exec)
}

/** 直接放一份文档进内存文件系统（**写成真正的 mxfile** —— 载体就是 .drawio）。 */
function seed(doc) {
  store.set(WORKSPACE + '\\doc.drawio', buildMxfile(doc).text)
}

/** 读回盘上那份 = 解析 mxfile（测试看到的必须与工具、界面看到的是同一套解析）。 */
function current() {
  return parseMxfile(store.get(WORKSPACE + '\\doc.drawio')).doc
}

// ---- 打写回路由的小工具（导入 / 导出 / 列表都挂在它上面）----------------------
//
// readBody 用 req.on('data'/'end') 读整段 body；这里造一个把 body 一次性喂进去的假 req。
// 事件要等 handler 挂上监听之后再发，所以放进微任务里，而不是构造时就同步发。
function fakeReq(bodyObject) {
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { 'x-drawai-save': '1' },
    on(name, fn) {
      listeners[name] = fn
      return req
    },
  }
  const text = JSON.stringify(bodyObject)
  queueMicrotask(() => {
    if (listeners.data !== undefined) listeners.data(Buffer.from(text, 'utf8'))
    if (listeners.end !== undefined) listeners.end()
  })
  return req
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text
    },
  }
}

/** POST 一次写回路由，返回 { status, payload }。 */
async function api(bodyObject) {
  const res = fakeRes()
  await route().handler(fakeReq(bodyObject), res)
  let payload = null
  try {
    payload = JSON.parse(res.body)
  } catch (error) {
    payload = null
  }
  return { status: res.status, payload: payload, raw: res.body }
}

function route() {
  const found = routes.filter((r) => r.path === '/drawai/api/save')[0]
  if (found === undefined) throw new Error('写回路由没注册上')
  return found
}

/** 调色板名的落盘形态（等价于 UI 里点了蓝/绿之后写进文档的东西）。 */
const BLUE = 'fillColor=#dae8fc;strokeColor=#6c8ebf;'
const GREEN = 'fillColor=#d5e8d4;strokeColor=#82b366;'

/** v2 的规范夹具：形状/配色/画法全部只在 style 键里，没有 shape/dash/arrow/color 字段。 */
function baseDoc(meta) {
  return {
    version: 2,
    revision: '',
    meta: meta === undefined ? { engine: 'drawio-svg' } : meta,
    nodes: [
      { id: 'n1', label: '一', style: BLUE, x: 37, y: 211, w: 130, h: 56 },
      { id: 'n2', label: '二', style: GREEN, x: 411, y: 88, w: 130, h: 56 },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', label: '手工连的', style: DEFAULT_EDGE_STYLE }],
  }
}

/**
 * v1（语义枚举那一代）文档：只用于验证"读时升级"。
 *
 * 注意 e1 的 points 第一个点 (167,239) 正好贴在 n1（37,211,130×56）的东边框上 ——
 * 这就是 v1 把"从哪一侧进出"的桩点混进折点的历史包袱，迁移应当把它摘成 exitX/exitY。
 */
function legacyDoc(meta) {
  return {
    version: 1,
    revision: '',
    meta: meta === undefined ? { engine: 'drawio-svg' } : meta,
    nodes: [
      { id: 'n1', shape: 'rect', style: 'blue', x: 37, y: 211, w: 130, h: 56, label: '一' },
      { id: 'n2', shape: 'diamond', style: 'yellow', x: 411, y: 88, w: 130, h: 56, label: '二' },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: '手工连的', dash: 'dashed', arrow: 'both', color: '#b85450', points: [{ x: 167, y: 239 }, { x: 300, y: 239 }] },
    ],
  }
}

/** 只有两个节点、没有连线的 v2 文档（几何相关断言用）。 */
function pairDoc(extra) {
  return Object.assign(
    {
      version: 2,
      revision: 1,
      meta: { engine: 'drawio-svg', pinned: true },
      nodes: [
        { id: 'a', label: 'A', style: '', x: 0, y: 0, w: 120, h: 60 },
        { id: 'b', label: 'B', style: '', x: 300, y: 200, w: 120, h: 60 },
      ],
      edges: [],
    },
    extra === undefined ? {} : extra,
  )
}

console.log('meta.pinned：人手工摆过的版面不能被 AI 改图冲掉')
{
  seed(baseDoc({ engine: 'drawio-svg', pinned: true }))
  const before = current()
  const n1Before = { x: before.nodes[0].x, y: before.nodes[0].y }

  // 第一次改动：加一个节点。pinned 生效 → layout 默认 none → 坐标不动。
  await apply([{ op: 'addNode', label: '第三个' }])
  const after1 = current()
  ok(after1.meta.pinned === true, '第一次 AI 改图后 meta.pinned 仍然是 true（回归点）')
  ok(after1.nodes[0].x === n1Before.x && after1.nodes[0].y === n1Before.y, '第一次改图手坐标未被移动')
  ok(after1.nodes.length === 3, '新节点加上了')

  // 第二次改动：这才是原来会炸的那一步 —— pinned 若已丢失，mode 会回落到 dagre-tb。
  await apply([{ op: 'setLabel', id: 'n1', label: '只改个标签' }])
  const after2 = current()
  ok(after2.meta.pinned === true, '第二次 AI 改图后 meta.pinned 仍在')
  ok(after2.nodes[0].x === n1Before.x && after2.nodes[0].y === n1Before.y, '第二次改图手坐标仍然未被移动（回归点）')
  ok(after2.nodes[0].label === '只改个标签', '标签确实改掉了')

  // 显式要求重排时，pinned 不该拦着。
  await apply([{ op: 'setLabel', id: 'n1', label: 'x' }], { layout: 'dagre-tb' })
  const after3 = current()
  ok(after3.meta.pinned === true, '重排之后 pinned 依然保留')
  ok(after3.nodes[0].x !== n1Before.x || after3.nodes[0].y !== n1Before.y, '显式指定 layout 时 pinned 不拦（显式重排确实移动了坐标）')
}

console.log('\n没有 pinned 的文档：默认自动布局')

console.log('\ndiagram_read 的输出 schema 必须声明返回体里所有字段')
{
  // 实测踩过：给返回的边加了 dash/arrow 方便 AI 看到现状，却漏改 output schema。
  // schema 是 additionalProperties:false，于是只要某条边带 dash/arrow，
  // **整个 diagram_read 调用被判为非法输出**、直接报错 —— 连读都读不出来。
  // 这里做静态检查：execute 里可能填的每个字段，schema 里都得有。
  const readSchema = readTool.output && readTool.output.schema ? readTool.output.schema : null
  ok(readSchema !== null, 'diagram_read 声明了 output schema')
  if (readSchema !== null) {
    const edgeProps = readSchema.properties.edges.items.properties
    for (const field of ['id', 'from', 'to', 'label', 'style', 'dash', 'arrow', 'color', 'exit', 'entry', 'points', 'sourcePoint', 'targetPoint', 'layer']) {
      ok(edgeProps[field] !== undefined, 'edges schema 声明了 ' + field)
    }
    const nodeProps = readSchema.properties.nodes.items.properties
    for (const field of ['id', 'label', 'shape', 'style', 'layer']) {
      ok(nodeProps[field] !== undefined, 'nodes schema 声明了 ' + field)
    }
    const layerProps = readSchema.properties.layers.items.properties
    for (const field of ['id', 'name', 'visible', 'locked']) {
      ok(layerProps[field] !== undefined, 'layers schema 声明了 ' + field)
    }
  }
  // 反向：**拿真实返回值去对 schema** —— 比读源码可靠。
  // （defineTool 用一层 validate shim 包住 execute，真正的实现读不到文本；
  //   而"执行一次、检查字段是否都在 schema 里"能直接复现那个崩溃。）
  seed(baseDoc())
  await apply([{ op: 'setStyle', id: 'e1', dash: 'dashed', arrow: 'both', color: '#b85450' }])
  const out = await readTool.execute({ path: 'doc.drawio' }, exec)
  const schemaProps = readSchema.properties
  const declaredEdge = schemaProps.edges.items.properties
  const declaredNode = schemaProps.nodes.items.properties
  let undeclared = []
  for (const e of out.edges) for (const k of Object.keys(e)) if (declaredEdge[k] === undefined) undeclared.push('edges[].' + k)
  for (const n of out.nodes) for (const k of Object.keys(n)) if (declaredNode[k] === undefined) undeclared.push('nodes[].' + k)
  ok(undeclared.length === 0, '真实返回值的字段全部在 schema 里（未声明的会被判非法输出：' + (undeclared.join(', ') || '无') + '）')
  ok(typeof out.revision === 'string' && out.revision.length === 12, 'revision 是 12 位内容指纹（不再是自增计数）')
  ok(Array.isArray(out.notes), 'notes 也在 schema 里（多页/图层/图片这类"画布表示不了但原样保留"的说明）')
  ok(out.edges[0].dash === 'dashed' && out.edges[0].arrow === 'both' && out.edges[0].color === '#b85450', '带回的边画法确实是设过的值')
  // 派生字段只是给人/模型看的名字，文档的真相在 style 串里 —— 两者必须同时给得出来。
  ok(styleGet(out.edges[0].style, 'dashed', null) === '1' && styleGet(out.edges[0].style, 'startArrow', null) === 'classic', 'read 的 style 串里能直接看到 drawio 键')
}

console.log('\n图层：AI 至少要知道"东西在哪几层、哪一层用户看不见"')
{
  // 这份文档有 2 层，第二层是隐藏的。AI 读回来必须看到：层表、每层的可见性、
  // 以及每个单元属于哪一层 —— 否则它会以为隐藏层里的节点"没了"（其实文件里好好的）。
  seed({
    version: 2,
    meta: { pinned: true },
    layers: [
      { id: '1', name: '主流程', visible: true, locked: false },
      { id: 'L2', name: '草稿', visible: false, locked: false },
    ],
    nodes: [
      { id: 'n1', label: '正式', style: '', x: 0, y: 0, w: 120, h: 60, layer: '1' },
      { id: 'n2', label: '草稿节点', style: '', x: 200, y: 0, w: 120, h: 60, layer: 'L2' },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', layer: '1' }],
  })
  const out = await readTool.execute({ path: 'doc.drawio' }, exec)
  ok(Array.isArray(out.layers) && out.layers.length === 2, 'read 带回图层表（实际 ' + (Array.isArray(out.layers) ? out.layers.length : 'null') + '）')
  ok(out.layers[0].id === '1' && out.layers[0].name === '主流程' && out.layers[0].visible === true && out.layers[0].locked === false, '第一层：id/名字/可见/未锁都对')
  ok(out.layers[1].visible === false, '隐藏层如实报 visible:false（不是"这层不存在"）')
  const byId = new Map(out.nodes.map((n) => [n.id, n]))
  ok(byId.get('n1').layer === '1' && byId.get('n2').layer === 'L2', '每个节点带自己的 layer')
  ok(out.edges[0].layer === '1', '边也带 layer')
  // 隐藏层里的单元**照旧读得到** —— 隐藏是显示状态，不是删除。
  ok(byId.has('n2'), '隐藏层里的节点仍然读得到（隐藏 ≠ 删除）')
  // 渲染文本里得看得见层，否则模型只会看文本。
  const text = readTool.output.render({ path: 'doc.drawio' }, out)
    .map((r) => r.text)
    .join('\n')
  ok(text.includes('主流程') && text.includes('草稿'), '渲染文本里有图层名')
  ok(text.includes('🚫'), '渲染文本把隐藏层标出来了')
  ok(text.includes('⟨草稿⟩'), '渲染文本里单元带上它所在的层')

  // 真正的回归点：AI 改一笔之后，图层绝不能掉。
  // （normalizeDoc 曾经漏传 doc.layers —— 表现是"AI 一改图，所有单元被挂回缺省层、
  //   用户的图层全没了"，而且不报错。）
  await apply([{ op: 'setLabel', id: 'n1', label: '改过' }])
  const after = current()
  ok(after.layers.length === 2, 'AI 改图之后图层还在（实际 ' + after.layers.length + '）')
  ok(after.nodes.filter((n) => n.id === 'n2')[0].layer === 'L2', 'AI 改图之后单元的层归属还在')
  ok(after.nodes.filter((n) => n.id === 'n1')[0].label === '改过', '这一笔改动本身生效了')
  const raw = store.get(WORKSPACE + '\\doc.drawio')
  ok(raw.includes('visible="0"'), '隐藏状态仍然写在文件里（改图没把它抹平）')
  const reread = await readTool.execute({ path: 'doc.drawio' }, exec)
  ok(reread.layers.length === 2 && reread.nodes.filter((n) => n.id === 'n2')[0].layer === 'L2', '改图之后 read 照样看得到层')

  // 还不存在（= 刚「新建画布」）的文档也要有缺省图层：否则图层面板在这张画布上
  // 一直说"没有图层信息"，保存一次再打开又有了 —— 同一个画布两种样子。
  const blank = await readTool.execute({ path: 'fresh.drawio' }, exec)
  ok(Array.isArray(blank.layers) && blank.layers.length === 1, '还不存在的画布：read 报一个缺省图层（实际 ' + JSON.stringify(blank.layers) + '）')
  ok(blank.layers[0].id === '1' && blank.layers[0].visible === true && blank.layers[0].locked === false, '缺省图层就是 drawio 那个 `<mxCell id="1" parent="0" />`')
}


console.log('\n独立文字：AI 也能放（shape:"text"），换色落到字色上')
{
  seed(baseDoc())
  await apply([{ op: 'addNode', shape: 'text', label: '标题', x: 40, y: 40 }])
  const added = current().nodes.filter((n) => n.label === '标题')[0]
  ok(added !== undefined, '文字元素加上了')
  ok(nodeShapeFromStyle(added.style) === 'text', 'read 会把它报成 shape text（实际 ' + nodeShapeFromStyle(added.style) + '）')
  ok(
    styleGet(added.style, 'strokeColor', null) === 'none' && styleGet(added.style, 'fillColor', null) === 'none',
    '写进去的就是 drawio 的 text 样式（无边框无底色）：' + added.style,
  )
  ok(added.x === 40 && added.y === 40, '给的 x/y 就是最终位置（自带几何 → 不重排）')

  // 文字元素没有填充与描边：style:'red' 必须落到 fontColor，否则屏幕上一点变化都没有
  await apply([{ op: 'setStyle', id: added.id, style: 'red' }])
  const recolored = current().nodes.filter((n) => n.id === added.id)[0]
  ok(styleGet(recolored.style, 'fontColor', null) === '#b85450', 'style:"red" 落到 fontColor：' + styleGet(recolored.style, 'fontColor', null))
  ok(styleGet(recolored.style, 'fillColor', null) === 'none' && styleGet(recolored.style, 'strokeColor', null) === 'none', '不会顺手给它加填充/描边')
  ok(styleGet(recolored.style, 'text', null) !== null, '还是文字形状（换色不该把它变回矩形）')

  const out = await readTool.execute({ path: 'doc.drawio' }, exec)
  const item = out.nodes.filter((n) => n.id === added.id)[0]
  ok(item !== undefined && item.shape === 'text', 'diagram_read 报 shape:text（AI 下次读得出来这是个文字元素）')
}


{
  seed(baseDoc())
  const beforeLayout = current().nodes.map((n) => n.x)
  await apply([{ op: 'addNode', label: '新' }])
  const doc = current()
  ok(doc.nodes.map((n) => n.x).join(',') !== beforeLayout.join(','), '未 pinned 的文档：默认自动布局（坐标被重排）')
  ok(doc.meta.pinned === false, '未 pinned 的文档不会被凭空打上 pinned')
}

console.log('\n线型与字号：AI 也能改（直线 / 曲线 / fontSize）')
{
  seed(baseDoc())
  // 直线：edgeStyle=none，且**不许留折点**（留着折点就不是直线了）
  await apply([{ op: 'addEdge', from: 'n1', to: 'n2', line: 'straight' }])
  const straight = current().edges.filter((e) => e.id === 'e2')[0]
  ok(straight !== undefined && styleGet(straight.style, 'edgeStyle', null) === 'none', 'line:"straight" 落成 edgeStyle=none：' + (straight === undefined ? '没有边' : straight.style))
  ok(straight.points === undefined, '直线不带折点')

  // 曲线：curved=1，并且**补一个弓形中点** —— 两点直连的曲线在 drawio 里退化成直线，
  // 不补中点的话用户/AI 说"画条弧线"屏幕上什么都不会发生。
  await apply([{ op: 'addEdge', from: 'n1', to: 'n2', line: 'curved' }])
  const curved = current().edges.filter((e) => e.id === 'e3')[0]
  ok(curved !== undefined && styleGet(curved.style, 'curved', null) === '1', 'line:"curved" 落成 curved=1：' + (curved === undefined ? '没有边' : curved.style))
  ok(Array.isArray(curved.points) && curved.points.length === 1, '弧线补了一个中点（实际 ' + JSON.stringify(curved.points) + '）')
  // 中点必须**离开**两端中心的连线（否则还是直线）
  const n1 = current().nodes.filter((n) => n.id === 'n1')[0]
  const n2 = current().nodes.filter((n) => n.id === 'n2')[0]
  const mid = { x: (n1.x + n1.w / 2 + n2.x + n2.w / 2) / 2, y: (n1.y + n1.h / 2 + n2.y + n2.h / 2) / 2 }
  const bowDist = Math.round(Math.sqrt((curved.points[0].x - mid.x) ** 2 + (curved.points[0].y - mid.y) ** 2))
  ok(bowDist > 10, '中点在连线旁边（弓起来了，离中点 ' + bowDist + 'px）')

  // 别名：arc / 曲线 / curve 都能认
  await apply([{ op: 'setStyle', id: 'e2', line: 'arc' }])
  ok(styleGet(current().edges.filter((e) => e.id === 'e2')[0].style, 'curved', null) === '1', 'line:"arc" 当成曲线（口语别名）')
  // 圆角折线：只在折点处倒角（rounded=1），路由仍是正交
  await apply([{ op: 'setStyle', id: 'e2', line: '圆角折线' }])
  const roundedEdge = current().edges.filter((e) => e.id === 'e2')[0]
  ok(styleGet(roundedEdge.style, 'rounded', null) === '1', 'line:"圆角折线" 落成 rounded=1：' + roundedEdge.style)
  ok(styleGet(roundedEdge.style, 'curved', null) === null && styleGet(roundedEdge.style, 'edgeStyle', null) === 'orthogonalEdgeStyle', '圆角折线与曲线互斥，且仍在正交路由上')
  ok(lineKindFromStyle(roundedEdge.style) === 'rounded', 'read/再改时认得出它是圆角折线')
  await apply([{ op: 'setStyle', id: 'e2', line: 'rounded' }])
  ok(styleGet(current().edges.filter((e) => e.id === 'e2')[0].style, 'rounded', null) === '1', 'line:"rounded" 是同一个意思')
  // 换回折线：curved 与 rounded 都删掉
  await apply([{ op: 'setStyle', id: 'e2', line: 'orthogonal' }])
  ok(styleGet(current().edges.filter((e) => e.id === 'e2')[0].style, 'curved', null) === null, '换回折线把 curved 删掉')
  ok(styleGet(current().edges.filter((e) => e.id === 'e2')[0].style, 'rounded', null) === null, '换回折线也把 rounded 删掉（不留 rounded=0 噪音）')
  // 直线：清折点
  await apply([{ op: 'setStyle', id: 'e3', line: 'straight' }])
  ok(current().edges.filter((e) => e.id === 'e3')[0].points === undefined, 'setStyle line:"straight" 也会清掉折点')

  // 不认识的线型：写盘前失败
  const before = store.get(WORKSPACE + '\\doc.drawio')
  let rejected = false
  try {
    await apply([{ op: 'setStyle', id: 'e1', line: 'wavy' }])
  } catch (error) {
    rejected = /unknown line/.test(String(error && error.message))
  }
  ok(rejected, '认不出的线型被拒（并说明可用值）')
  ok(store.get(WORKSPACE + '\\doc.drawio') === before, '被拒之后文件一个字节都没变')

  // 字号：节点、独立文字、连线都吃 fontSize（null = 删键）
  await apply([{ op: 'setStyle', id: 'n1', fontSize: 18 }])
  ok(styleGet(current().nodes.filter((n) => n.id === 'n1')[0].style, 'fontSize', null) === '18', 'setStyle fontSize:18 落到节点样式上')
  await apply([{ op: 'setStyle', id: 'n1', fontSize: null }])
  ok(styleGet(current().nodes.filter((n) => n.id === 'n1')[0].style, 'fontSize', null) === null, 'fontSize:null 删键回缺省')
  await apply([{ op: 'setStyle', id: 'e1', fontSize: 14 }])
  ok(styleGet(current().edges.filter((e) => e.id === 'e1')[0].style, 'fontSize', null) === '14', '连线上的文字也能改字号')
  await apply([{ op: 'addNode', shape: 'text', label: '大字', x: 60, y: 300, fontSize: 24 }])
  const bigText = current().nodes.filter((n) => n.label === '大字')[0]
  ok(bigText !== undefined && styleGet(bigText.style, 'fontSize', null) === '24', '独立文字的字号也能给（addNode fontSize）')
  ok(bigText !== undefined && nodeShapeFromStyle(bigText.style) === 'text', '字号不会把文字元素变成别的形状')
}


{
  seed(baseDoc())
  await apply([{ op: 'addEdge', from: 'n2', to: 'n1', label: '异步', dash: 'dashed', arrow: 'both' }])
  const e2s = parseStyle(current().edges[1].style)
  ok(e2s.dashed === '1', 'addEdge 直接带上 dashed=1')
  ok(e2s.endArrow === 'classic' && e2s.startArrow === 'classic', 'addEdge 直接带上双向箭头（endArrow + startArrow）')
  ok(parseStyle(current().edges[0].style).dashed === undefined, '未指定的边不会凭空多出 dashed（默认省略）')

  await apply([{ op: 'setStyle', id: 'e1', dash: 'dotted', color: '#b85450' }])
  const e1 = parseStyle(current().edges[0].style)
  ok(e1.dashed === '1' && e1.dashPattern === '1 2', 'setStyle 能改连线线型（dashed=1 + dashPattern=1 2）')
  ok(e1.strokeColor === '#b85450', 'setStyle 能改连线颜色（strokeColor）')

  // 归一化：口语说法要能接受，但落盘必须是 drawio 的键值。
  await apply([{ op: 'setStyle', id: 'e1', dash: '虚线', arrow: '双向' }])
  const e1b = parseStyle(current().edges[0].style)
  ok(e1b.dashed === '1', '"虚线" 归一成 dashed=1')
  ok(e1b.endArrow === 'classic' && e1b.startArrow === 'classic', '"双向" 归一成 endArrow + startArrow')

  // 回到默认 = 删键，而不是写 dashed=0 / 空值（文档里不留冗余）。
  await apply([{ op: 'setStyle', id: 'e1', dash: 'solid', arrow: 'end', color: '' }])
  const e1c = parseStyle(current().edges[0].style)
  ok(e1c.dashed === undefined && e1c.dashPattern === undefined && e1c.startArrow === undefined, '设回默认会删掉虚线相关键，不留 "dashed=0" 垃圾')
  ok(e1c.strokeColor === undefined, 'color:"" 会删掉 strokeColor（回到 drawio 缺省颜色）')
  ok(e1c.endArrow === 'classic', 'arrow:end 落成 endArrow=classic（与 drawio 新建连线的写法一致）')

  // 节点与连线共用 setStyle：节点该走 style 键那条路。
  await apply([{ op: 'setStyle', id: 'n1', shape: 'diamond', style: 'orange' }])
  const n1 = current().nodes[0]
  const n1s = parseStyle(n1.style)
  ok(n1s.rhombus === '1', '节点换形状落成 rhombus=1（diamond 只是工具语言的叫法）')
  ok(n1s.fillColor === '#ffe6cc' && n1s.strokeColor === '#d79b00', 'style:"orange" 落成 orange 的 fillColor/strokeColor')
  ok(n1.shape === undefined && n1.style !== undefined, '文档里不再有 shape 字段（形状只存在于 style 键里）')

  // rect = 没有形状键：drawio 的 defaultVertexStyle 就是 {}。
  await apply([{ op: 'setStyle', id: 'n1', shape: 'rect' }])
  const n1r = parseStyle(current().nodes[0].style)
  ok(n1r.rhombus === undefined && n1r.shape === undefined && n1r.rounded === undefined && n1r.ellipse === undefined, 'rect 落成"没有形状键"（默认省略）')
  ok(n1r.fillColor === '#ffe6cc', '换形状不会顺手动配色的键')
}

console.log('\n非法输入必须在写盘之前失败')
{
  seed(baseDoc())
  const before = store.get(WORKSPACE + '\\doc.drawio')

  const cases = [
    [{ op: 'addEdge', from: 'n1', to: 'n99' }, 'unknown "to" node'],
    [{ op: 'addEdge', from: 'nope', to: 'n1' }, 'unknown "from" node'],
    [{ op: 'setStyle', id: 'ghost', style: 'blue' }, 'unknown node or edge'],
    [{ op: 'setStyle', id: 'e1', dash: 'wavy' }, 'unknown dash'],
    [{ op: 'setStyle', id: 'e1', arrow: 'sideways' }, 'unknown arrow'],
    [{ op: 'setLabel', id: 'ghost', label: 'x' }, 'unknown id'],
    [{ op: 'remove', id: 'ghost' }, 'unknown id'],
    [{ op: 'explode' }, 'unknown op'],
    [{ op: 'addNode', id: 'n1', label: '撞 id' }, 'already exists'],
  ]
  for (const [op, label] of cases) {
    let threw = false
    let message = ''
    try {
      await apply([op])
    } catch (error) {
      threw = true
      message = error && error.message ? error.message : String(error)
    }
    const stated = message.indexOf(label) >= 0
    ok(threw && stated, '拒绝 ' + JSON.stringify(op.op) + '（' + label + '）' + (threw ? '' : ' —— 竟然没抛错'))
  }
  ok(store.get(WORKSPACE + '\\doc.drawio') === before, '以上全部失败之后，文件一个字节都没变')
  ok(contentHash(store.get(WORKSPACE + '\\doc.drawio')) === contentHash(before), '指纹也没变（失败不留痕）')

  let emptyThrew = false
  try {
    await apply([])
  } catch (error) {
    emptyThrew = true
  }
  ok(emptyThrew, '空 ops 被拒')
}

console.log('\nrevision：文件内容指纹 + 原子性')
{
  seed(baseDoc())
  const fingerprint0 = contentHash(store.get(WORKSPACE + '\\doc.drawio'))
  ok(current().revision === fingerprint0, '起始 revision 就是文件内容指纹')
  await apply([{ op: 'setLabel', id: 'n1', label: 'a' }])
  const fingerprint1 = contentHash(store.get(WORKSPACE + '\\doc.drawio'))
  ok(current().revision === fingerprint1 && fingerprint1 !== fingerprint0, '改一次之后指纹变了')
  await apply([{ op: 'setLabel', id: 'n1', label: 'b' }, { op: 'setLabel', id: 'n2', label: 'c' }])
  const fingerprint2 = contentHash(store.get(WORKSPACE + '\\doc.drawio'))
  ok(current().revision === fingerprint2 && fingerprint2 !== fingerprint1, '一次调用里改多个单元 → 一次写回，指纹与文件内容一致')
  // 一批 ops 里前几条合法、后面一条非法：整批都不该落盘。
  const snapshot = store.get(WORKSPACE + '\\doc.drawio')
  let threw = false
  try {
    await apply([{ op: 'setLabel', id: 'n1', label: 'zzz' }, { op: 'remove', id: 'ghost' }])
  } catch (error) {
    threw = true
  }
  ok(threw && store.get(WORKSPACE + '\\doc.drawio') === snapshot, '同一批里后面的 op 失败 → 前面已改的也不落盘（全或无）')
  ok(current().nodes[0].label !== 'zzz', '内存里也没有留下半成品')
}

console.log('\n文件不存在时：当作空文档，不报错')
{
  store.clear()
  const result = await apply([{ op: 'addNode', label: '从零开始' }], { path: 'brand-new.drawio' })
  ok(result.nodeCount === 1 && typeof result.revision === 'string' && result.revision.length === 12, '文件不存在时从零生成并给出指纹')
  const text = store.get(WORKSPACE + '\\brand-new.drawio')
  ok(typeof text === 'string' && text.indexOf('<mxfile') === 0, '新建的是一份 mxfile（不是 JSON）')
  const doc = parseMxfile(text).doc
  ok(doc.nodes.length === 1 && doc.nodes[0].id === 'n1', 'id 从 n1 开始')
}

console.log('\ndiagram_read 回读')
{
  seed(baseDoc())
  await apply([{ op: 'setStyle', id: 'e1', dash: 'dashed', arrow: 'both', color: '#333' }])
  const read = await readTool.execute({ path: 'doc.drawio' }, exec)
  ok(read.revision === contentHash(store.get(WORKSPACE + '\\doc.drawio')), 'read 报出的 revision 与文件指纹一致')
  ok(read.nodes.length === 2 && read.edges.length === 1, 'read 报出节点/边数量')
  const e = read.edges[0]
  ok(e.dash === 'dashed' && e.arrow === 'both' && e.color === '#333', 'read 把边画法一起报出来（AI 改之前看得到现状）')
  ok(parseStyle(e.style).strokeColor === '#333', 'read 同时给出 style 串原文（派生字段只是便于阅读的名字）')
  ok(Array.isArray(read.notes), 'read 也带回 notes（画布表示不了但会原样保留的东西）')
}

console.log('\n格式逻辑：默认省略 / 开放集合 / 折点与端点分离')
{
  // ── 默认省略：不给画法，就一个默认键都不写 ──
  store.clear()
  await apply([{ op: 'addNode', label: '素节点' }], { path: 'fresh.drawio' })
  const fresh = parseMxfile(store.get(WORKSPACE + '\\fresh.drawio')).doc
  ok(fresh.version === 2, '新文档落盘就是 version 2')
  ok(fresh.nodes[0].style === '', '未指定画法的节点 style 是空串（= drawio 的 defaultVertexStyle {}）')

  // ── style 串往返无损 + 未识别键保留（开放集合）──
  const exotic = 'shape=cylinder3;fillColor=#ffeeee;strokeColor=#aa0000;customKey=7;whiteSpace=wrap;html=1;'
  seed({
    version: 2,
    revision: 3,
    meta: { engine: 'drawio-svg', pinned: true },
    nodes: [
      { id: 'n1', label: '异形', style: exotic, x: 0, y: 0, w: 120, h: 60 },
      { id: 'n2', label: '普通', style: '', x: 300, y: 0, w: 120, h: 60 },
    ],
    edges: [],
  })
  await apply([{ op: 'setLabel', id: 'n2', label: '改别人的标签' }])
  ok(current().nodes[0].style === exotic, '一次无关的编辑之后，节点 style 串逐字未变（含未识别的 customKey，连键序都没被规范化）')

  // ── 键级合并：只动点到的键 ──
  await apply([{ op: 'setStyle', id: 'n1', keys: { fillColor: '#eeeeee' } }])
  const merged = parseStyle(current().nodes[0].style)
  ok(merged.fillColor === '#eeeeee' && merged.customKey === '7' && merged.shape === 'cylinder3', 'keys 只改指到的键，其余（含未知键）原样保留')

  // ── 折点归 points、进出侧归 exit*/entry*：两套模型互不牵连 ──
  seed(
    pairDoc({
      edges: [
        { id: 'e1', from: 'a', to: 'b', style: styleWithSide(DEFAULT_EDGE_STYLE, 'source', 'e'), points: [{ x: 200, y: 30 }, { x: 200, y: 200 }] },
      ],
    }),
  )
  await apply([{ op: 'setStyle', id: 'e1', exit: 'w' }])
  let edge = current().edges[0]
  ok(Array.isArray(edge.points) && edge.points.length === 2, '改进出侧不动折点')
  ok(parseStyle(edge.style).exitX === '0' && parseStyle(edge.style).exitY === '0.5', 'exit:"w" 落成 exitX=0;exitY=0.5')

  await apply([{ op: 'setStyle', id: 'e1', clearPoints: true }])
  edge = current().edges[0]
  ok(edge.points === undefined, 'clearPoints 清掉折点')
  ok(parseStyle(edge.style).exitX === '0', 'clearPoints 不动进出侧约束（折点与端点是两套模型）')

  // ── 显式重排 → 端点动了 → 过期折点必须被清掉（v1 的真实缺口：宿主当时不知道 points 存在）──
  seed(pairDoc({ edges: [{ id: 'e1', from: 'a', to: 'b', style: DEFAULT_EDGE_STYLE, points: [{ x: 200, y: 30 }] }] }))
  await apply([{ op: 'setLabel', id: 'a', label: '重排' }], { layout: 'dagre-tb' })
  ok(current().edges[0].points === undefined, '显式重排且端点移动 → 过期折点被清掉（否则会飘在旧坐标上）')

  // ── sourcePoint / targetPoint：drawio 语义是"该端**没有**真实顶点时的自由点" ──
  // 有这个规则，才谈得上"端点与折点是两套模型"：连着顶点时端点由 exit*/entry* 约束，
  // 悬空时才用绝对坐标点。宿主与客户端共用内核，所以这里直接对内核断言。
  ok(edgeFreePoint({ from: 'a', to: 'b', sourcePoint: { x: 1, y: 2 } }, 'source') === null, '端点连着真实顶点时 sourcePoint 被忽略（drawio 语义）')
  const freePoint = edgeFreePoint({ to: 'b', sourcePoint: { x: 1, y: 2 } }, 'source')
  ok(freePoint !== null && freePoint.x === 1 && freePoint.y === 2, '端点没有真实顶点时 sourcePoint 生效')
  ok(edgeFreePoint({ from: 'a', to: 'b', targetPoint: { x: 3, y: 4 } }, 'target') === null, 'targetPoint 同理（有顶点就忽略）')
}

console.log('\n新建节点的尺寸也是整格（与画布 10px 的移动单位一致）')
{
  // 尺寸不整格 → 节点中心落在半像素上 → 连线动不动多出"差一像素"的台阶。
  // 宿主这边有两个来源：估宽（estimateWidth）与缺省高度（DEFAULT_H）。
  store.clear()
  const longLabel = '很长很长很长很长很长很长很长很长很长的标签'
  const created = await apply([{ op: 'addNode', label: longLabel }], { path: 'size.drawio' })
  const sizeDoc = parseMxfile(store.get(WORKSPACE + '\\size.drawio')).doc
  ok(created.nodeCount === 1 && sizeDoc.nodes.length === 1, '新建了一个节点')
  ok(sizeDoc.nodes[0].w % 10 === 0, '估宽向上取整到整格（' + sizeDoc.nodes[0].w + '）')
  ok(sizeDoc.nodes[0].h === 60, '缺省高度是整格 60（原来 56）')

  // 估宽不随标签长度失控，也不越界
  await apply([{ op: 'addNode', label: '短' }], { path: 'size.drawio' })
  const two = parseMxfile(store.get(WORKSPACE + '\\size.drawio')).doc
  const widths = two.nodes.map((n) => n.w)
  ok(widths.every((w) => w % 10 === 0 && w >= 130 && w <= 300), '每个宽度都是整格且在 [130, 300] 内：' + widths.join(', '))
}

console.log('\n自环：允许（与 drawio 一致），自动布局忽略它')
{
  seed(baseDoc())
  await apply([{ op: 'addEdge', from: 'n1', to: 'n1', label: '自己连自己' }])
  const loop = current().edges.filter((e) => e.from === 'n1' && e.to === 'n1')[0]
  ok(loop !== undefined && loop.label === '自己连自己', 'from === to 的边能写进文件')
  const fileText = store.get(WORKSPACE + '\\doc.drawio')
  ok(/source="n1"/.test(fileText) && /target="n1"/.test(fileText), '两端都写成同一个节点（mxfile 里就是 source === target）')

  // 自动布局：自环必须被忽略而不是把分层搞崩（含环图的分层本来就麻烦，自环更敏感）。
  await apply([{ op: 'addNode', label: 'x' }], { layout: 'dagre-tb' })
  const after = current()
  ok(
    after.edges.some((e) => e.from === e.to),
    '重排之后自环还在',
  )
  ok(
    after.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
    '重排后坐标都是有限数（自环没把布局搞崩）',
  )
  const read = await readTool.execute({ path: 'doc.drawio' }, exec)
  ok(
    read.edges.some((e) => e.from === e.to),
    'diagram_read 也能把这条件自环读回来',
  )
}

console.log('\n写回路由：list / read / save / create 都只认 .drawio')
{
  // 夹具：一份**两页**的 drawio 文件（第 2 页会被如实报成"只显示第 1 页"，但保存时原样保留）。
  const drawio = [
    '<mxfile host="test" compressed="false" type="device">',
    '  <diagram id="p1" name="Page-1">',
    '    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" pageWidth="827" pageHeight="1169"><root>',
    '      <mxCell id="0" /><mxCell id="1" parent="0" />',
    '      <mxCell id="a" value="起点" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">',
    '        <mxGeometry x="40" y="40" width="140" height="60" as="geometry" />',
    '      </mxCell>',
    '      <mxCell id="b" value="终点" style="rhombus;fillColor=#d5e8d4;" vertex="1" parent="1">',
    '        <mxGeometry x="300" y="220" width="160" height="80" as="geometry" />',
    '      </mxCell>',
    '      <mxCell id="e1" value="走这里" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=classic;exitX=1;exitY=0.5;" edge="1" parent="1" source="a" target="b">',
    '        <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="240" y="70" /></Array></mxGeometry>',
    '      </mxCell>',
    '    </root></mxGraphModel>',
    '  </diagram>',
    '  <diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram>',
    '</mxfile>',
    '',
  ].join('\n')

  store.clear()
  store.set(WORKSPACE + '\\flow.drawio', drawio)

  // ── list：列出来的每一个都能直接打开（不再有"先导入成别的格式"这一步）──
  //
  // list 走的是**真实目录**（宿主用 node:readdir 列目录，不是 ctx.fs），
  // 所以这里真的在工作区里建一个小目录当"会话工作区"，用完删掉。
  const listDir = resolve(root, '.tmp-check-host-list')
  rmSync(listDir, { recursive: true, force: true })
  mkdirSync(listDir, { recursive: true })
  SESSION2.header.cwd = listDir
  try {
    writeFileSync(resolve(listDir, 'one.drawio'), drawio)
    writeFileSync(resolve(listDir, 'notes.txt'), '无关文件')
    const listed = await api({ action: 'list', sessionId: 's2' })
    ok(listed.status === 200 && listed.payload.ok === true, 'list 正常返回')
    ok(listed.payload.files.indexOf('one.drawio') >= 0, 'list 列出 .drawio：' + JSON.stringify(listed.payload.files))
    ok(listed.payload.files.indexOf('notes.txt') < 0, '其它文件不会被当成画布')
    ok(Array.isArray(listed.payload.absolute) && listed.payload.absolute.length === listed.payload.files.length, '同时给出绝对路径（客户端拿它当身份）')
  } finally {
    rmSync(listDir, { recursive: true, force: true })
  }

  // ── read：宿主解析 mxfile，交给界面 ──
  const read = await api({ action: 'read', sessionId: 's1', path: 'flow.drawio' })
  ok(read.status === 200 && read.payload.ok === true, 'read 成功（' + read.status + ' ' + String(read.payload && read.payload.error) + '）')
  ok(read.payload.exists === true && read.payload.doc.nodes.length === 2 && read.payload.doc.edges.length === 1, 'read 回出 2 个节点 / 1 条边')
  ok(read.payload.doc.nodes[0].style === 'rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;', 'style 串原样带过来')
  ok(read.payload.doc.edges[0].from === 'a' && read.payload.doc.edges[0].to === 'b' && read.payload.doc.edges[0].label === '走这里', '端点与标签都对')
  ok(read.payload.doc.edges[0].points.length === 1 && read.payload.doc.edges[0].points[0].x === 240, '折点也带过来')
  ok(read.payload.notes.join(' | ').indexOf('2 页') >= 0, 'notes 回传给界面：' + read.payload.notes.join(' | '))
  ok(read.payload.revision === contentHash(drawio), 'read 给出的 revision 就是文件内容指纹')
  ok(typeof read.payload.doc.revision === 'string' && read.payload.doc.revision.length === 12, '文档里的 revision 也是那个指纹')

  // ── 第一次人工保存：只添上 pinned 元数据单元 ──
  //
  // "人手工摆过版面"这件事画布表示不了，只能存进文件（drawio 的 <object> 自定义属性）。
  // 所以第一次保存**必然**多一个元数据单元 —— 除此之外一个字节都不该动。
  const noop = await api({ sessionId: 's1', path: 'flow.drawio', revision: read.payload.revision, doc: read.payload.doc })
  ok(noop.status === 200 && noop.payload.ok === true, 'save 成功（' + noop.status + ' ' + String(noop.payload && noop.payload.error) + '）')
  const pinnedText = store.get(WORKSPACE + '\\flow.drawio')
  const withoutMeta = pinnedText.replace(/\n\s*<object label="" drawaiMeta="1" drawaiPinned="1" id="drawai-meta">[\s\S]*?<\/object>/, '')
  if (withoutMeta !== drawio) {
    let at = 0
    while (at < Math.max(withoutMeta.length, drawio.length) && withoutMeta.charAt(at) === drawio.charAt(at)) at += 1
    console.log('    首个差异 @' + at + '\n    原文: ' + JSON.stringify(drawio.slice(Math.max(0, at - 70), at + 70)) + '\n    写回: ' + JSON.stringify(withoutMeta.slice(Math.max(0, at - 70), at + 70)))
  }
  ok(withoutMeta === drawio, '除追加的 pinned 元数据单元外，文件**逐字节不变**')
  ok(noop.payload.revision !== read.payload.revision, '文件变了，指纹也跟着变')

  // ── 第二次保存：真的没有改动 → 文件逐字节不变（载体的硬要求）──
  const read2 = await api({ action: 'read', sessionId: 's1', path: 'flow.drawio' })
  ok(read2.payload.doc.meta.pinned === true, 'pinned 读得回来')
  const noop2 = await api({ sessionId: 's1', path: 'flow.drawio', revision: read2.payload.revision, doc: read2.payload.doc })
  ok(noop2.payload.ok === true && store.get(WORKSPACE + '\\flow.drawio') === pinnedText, '**打开后原样保存 ⇒ 文件逐字节不变**')
  ok(noop2.payload.revision === read2.payload.revision, '没改动时指纹不变')

  // ── save：改一个坐标 → 只改那一处，其余（第 2 页等）逐字节保留 ──
  const moved = JSON.parse(JSON.stringify(read2.payload.doc))
  moved.nodes[0].x = 140
  const saved = await api({ sessionId: 's1', path: 'flow.drawio', revision: read2.payload.revision, doc: moved })
  ok(saved.status === 200 && saved.payload.ok === true, 'save 变更成功（' + saved.status + ' ' + String(saved.payload && saved.payload.error) + '）')
  ok(saved.payload.revision !== read2.payload.revision, '改过之后指纹变了')
  const afterText = store.get(WORKSPACE + '\\flow.drawio')
  ok(afterText.indexOf('<diagram id="p2" name="Page-2">') > 0, '第 2 页原样保留')
  const after = parseMxfile(afterText).doc
  ok(after.nodes.filter((n) => n.id === 'a')[0].x === 140, '坐标改到了')
  ok(after.nodes.filter((n) => n.id === 'b')[0].style === 'rhombus;fillColor=#d5e8d4;', '没动过的单元连 style 都逐字未变')
  ok(after.edges[0].points.length === 1, '没动过的边折点仍在')
  ok(after.meta.pinned === true, '人工保存过的画布带 pinned（AI 不该再自动重排）')

  // ── 指纹乐观锁：基线对不上就 409，绝不覆盖别处的改动 ──
  const stale = await api({ sessionId: 's1', path: 'flow.drawio', revision: read2.payload.revision, doc: moved })
  ok(stale.status === 409 && stale.payload.error === 'revision conflict', '基线指纹过时 → 409：' + stale.status + ' ' + String(stale.payload && stale.payload.error))
  ok(store.get(WORKSPACE + '\\flow.drawio') === afterText, '409 之后文件没被碰过')

  // ── createOnly（「另存为」）：目标已存在就拒绝，绝不覆盖 ──
  const saveAs = await api({ sessionId: 's1', path: 'flow.drawio', createOnly: true, doc: moved })
  ok(saveAs.status === 409 && saveAs.payload.error === 'already exists', '另存为到已存在的文件 → 409 already exists：' + saveAs.status + ' ' + String(saveAs.payload && saveAs.payload.error))
  const saveAsNew = await api({ sessionId: 's1', path: 'copy.drawio', createOnly: true, doc: moved })
  ok(saveAsNew.status === 200 && saveAsNew.payload.ok === true, '另存为到新名字 → 成功')
  ok(parseMxfile(store.get(WORKSPACE + '\\copy.drawio')).doc.nodes.length === 2, '新文件里是当前这份文档（2 个节点）')
  ok(store.get(WORKSPACE + '\\flow.drawio') === afterText, '另存为不会顺手改原文件')

  // ── 拒绝非 .drawio ──
  const notDrawio = await api({ sessionId: 's1', path: 'doc.json', revision: '', doc: moved })
  ok(notDrawio.status === 403 && notDrawio.payload.ok !== true, '拒绝写非 .drawio：' + notDrawio.payload.error)

  // ── 坏文件：读要报错，而不是给半张图 ──
  store.set(WORKSPACE + '\\broken.drawio', '<mxfile><diagram></diagram></mxfile>')
  const broken = await api({ action: 'read', sessionId: 's1', path: 'broken.drawio' })
  ok(broken.status === 400 && /mxGraphModel|mxfile/.test(String(broken.payload.error)), '读不出 mxfile 的文件报错而不是给半张图：' + broken.payload.error)

  // ── create：新建就落一份真正的 .drawio ──
  const created = await api({ action: 'create', sessionId: 's1', name: 'brand-new' })
  ok(created.status === 200 && created.payload.ok === true && created.payload.path === 'brand-new.drawio', 'create 落的是 .drawio：' + String(created.payload && created.payload.path))
  const createdText = store.get(WORKSPACE + '\\brand-new.drawio')
  ok(typeof createdText === 'string' && createdText.indexOf('<mxfile') === 0, '新建出来的是一份 mxfile')
  ok(parseMxfile(createdText).doc.meta.pinned === true, '新建的画布带 pinned（人手工建的，AI 别重排）')
  // 新建的文件必须有那个缺省图层单元 —— 否则图层面板在这张画布上说"没有图层信息"，
  // 而 drawio 打开同一份文件却有"背景"那一层（同一张画布两种样子）。
  ok(parseMxfile(createdText).doc.layers.length === 1, '新建的文件带一个缺省图层（实际 ' + JSON.stringify(parseMxfile(createdText).doc.layers) + '）')
  ok(createdText.indexOf('<mxCell id="1" parent="0" />') >= 0, '缺省图层单元的写法与 drawio 一致')
  // 再读一遍（客户端新建完就是这么做的）：图层表要能从盘上读回来
  const createdRead = await api({ action: 'read', sessionId: 's1', path: 'brand-new.drawio' })
  ok(createdRead.payload.ok === true && createdRead.payload.doc.layers.length === 1, '新建后回读：图层表在（这才是图层面板看到的那份文档）')
  ok(created.payload.revision === contentHash(createdText), 'create 返回的 revision 也是内容指纹')
  const created2 = await api({ action: 'create', sessionId: 's1', name: 'brand-new.drawio' })
  ok(created2.payload.ok !== true && created2.payload.exists === true, '同名文件已存在时不覆盖')

  // ── suggest：默认名也补 .drawio ──
  const suggested = await api({ action: 'suggest', sessionId: 's1', base: 'untitled' })
  ok(suggested.payload.ok === true && suggested.payload.name === 'untitled.drawio', 'suggest 预填的名字带 .drawio：' + String(suggested.payload && suggested.payload.name))

  // ── focus：记录"用户在看哪张"，AI 不传 path 时改它 ──
  const focus = await api({ action: 'focus', sessionId: 's1', path: 'flow.drawio' })
  ok(focus.payload.ok === true && focus.payload.focused === 'flow.drawio', 'focus 记下当前画布')
}

console.log('\n切换画布 → 主动告诉模型"当前是哪一张"（Agent.inject）')
{
  // 工具不传 path 时本来就落到"用户当前打开的那张"，但模型此前**只能先探一次**（调一次
  // diagram_read 看返回里的 path）才知道是哪张。这里验证：切画布时宿主往那个会话注入一条
  // 环境事实，于是模型下一步直接看得到。
  //
  // 这一节用**第二个实例**（自己的 ctx）来测：注入要 agents 服务，而主 ctx 故意没有它 ——
  // 那正好也是"没装 agents 的部署照常能用"的验证（主 ctx 那一节已经跑过了）。
  const injected = []
  const ctx2 = Object.assign({}, ctx, {
    get(name) {
      if (name !== 'agents') return undefined
      return {
        get(id) {
          if (id !== 's1') return undefined
          return {
            inject(message) {
              injected.push(message)
            },
          }
        },
      }
    },
  })
  mod.apply(ctx2)
  const route2 = routes[routes.length - 1]
  const api2 = async (bodyObject) => {
    const res = fakeRes()
    await route2.handler(fakeReq(bodyObject), res)
    return JSON.parse(res.body)
  }

  const first = await api2({ action: 'focus', sessionId: 's1', path: 'flow.drawio' })
  ok(first.ok === true && first.focused === 'flow.drawio', '第二个实例照常记下聚焦画布')
  ok(injected.length === 1, '切到一张画布时注入了一条上下文（实际 ' + injected.length + '）')
  const message = injected[0] === undefined ? {} : injected[0]
  const text = message.content !== undefined && message.content[0] !== undefined ? message.content[0].text : ''
  ok(
    message.role === 'user' && message.source !== undefined && message.source.kind === 'plugin' && message.source.plugin === 'drawai',
    '注入形状 = user + plugin source：' + JSON.stringify(message.source),
  )
  ok(text.indexOf('flow.drawio') >= 0 && text.indexOf('不传 path') >= 0, '点名了当前画布并说明不传 path 的默认行为：' + text)

  // 客户端每次挂载都会报一次同一张：不能每次都去打扰模型
  await api2({ action: 'focus', sessionId: 's1', path: 'flow.drawio' })
  ok(injected.length === 1, '同一张重复上报不再注入')
  await api2({ action: 'focus', sessionId: 's1', path: 'other.drawio' })
  ok(injected.length === 2 && injected[1].content[0].text.indexOf('other.drawio') >= 0, '换一张才再注入一次')
  await api2({ action: 'focus', sessionId: 's1', path: '' })
  ok(injected.length === 3 && injected[2].content[0].text.indexOf('关掉') >= 0, '画布关掉时也说一声（否则模型还以为是那张）')
  // 会话对不上（agent 还没起来）时不能炸，也不能乱注入
  const stranger = await api2({ action: 'focus', sessionId: 's1', path: 'flow.drawio' })
  ok(stranger.ok === true && injected.length === 4, '切回原来那张会再注入一次（路径确实变了）')
}

console.log('\n二叉树：父节点居中于两个孩子之间（树/森林专用摆法）')
{
  // 用户实测：让 AI"画一个二叉树"，排出来是 B 压在 E 正上方、D 甩在左边 ——
  // 因为逐层居中只保证"每一层整体居中"，不保证"父节点在两个孩子中间"。
  // 教科书（也是人的直觉）是后者，所以树/森林再补一遍自下而上的居中。
  store.clear()
  const treeOps = []
  const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
  for (let i = 0; i < labels.length; i += 1) treeOps.push({ op: 'addNode', label: labels[i], shape: 'ellipse', w: 60, h: 60 })
  const links = [['n1', 'n2'], ['n1', 'n3'], ['n2', 'n4'], ['n2', 'n5'], ['n3', 'n6'], ['n3', 'n7']]
  for (let i = 0; i < links.length; i += 1) treeOps.push({ op: 'addEdge', from: links[i][0], to: links[i][1] })
  await apply(treeOps, { path: 'tree.drawio', layout: 'dagre-tb' })
  const tree = parseMxfile(store.get(WORKSPACE + '\\tree.drawio')).doc
  const at = (id) => tree.nodes.filter((n) => n.id === id)[0]
  ok(tree.nodes.length === 7 && tree.edges.length === 6, '七节点六边的完整二叉树')
  ok(
    at('n1').x === 150 && at('n2').x === 50 && at('n3').x === 250,
    '父节点居中于两个孩子之间：A=150 / B=50 / C=250（实际 ' + [at('n1').x, at('n2').x, at('n3').x].join(' / ') + '）',
  )
  ok(
    [at('n4').x, at('n5').x, at('n6').x, at('n7').x].join(',') === '0,100,200,300',
    '叶子均匀铺开：0 / 100 / 200 / 300（实际 ' + [at('n4').x, at('n5').x, at('n6').x, at('n7').x].join(' / ') + '）',
  )
  ok(at('n1').y === 0 && at('n2').y === 150 && at('n4').y === 300, '层间距照旧：0 / 150 / 300')
  const centerOf = (n) => n.x + 30
  ok(Math.abs(centerOf(at('n2')) - (centerOf(at('n4')) + centerOf(at('n5'))) / 2) < 0.5, 'B 的中心 = D/E 中心的中点')
  ok(Math.abs(centerOf(at('n1')) - (centerOf(at('n2')) + centerOf(at('n3'))) / 2) < 0.5, 'A 的中心 = B/C 中心的中点')

  // 多父的 DAG 不做这个居中：那里"居中于父"没有唯一答案，保持原来的逐层居中。
  // 宽度故意不等（60 + 40 + 200），这样两种摆法的结果不同，断言才有区分度。
  store.clear()
  await apply(
    [
      { op: 'addNode', label: 'a', w: 60, h: 60 },
      { op: 'addNode', label: 'b', w: 200, h: 60 },
      { op: 'addNode', label: 'c', w: 60, h: 60 },
      { op: 'addEdge', from: 'n1', to: 'n3' },
      { op: 'addEdge', from: 'n2', to: 'n3' },
    ],
    { path: 'dag.drawio', layout: 'dagre-tb' },
  )
  const dag = parseMxfile(store.get(WORKSPACE + '\\dag.drawio')).doc
  const dagAt = (id) => dag.nodes.filter((n) => n.id === id)[0]
  ok(dagAt('n3').x === 120, '多父节点仍然逐层居中（若误用"居中于父"会是 85）：c.x=' + dagAt('n3').x)
  ok(dagAt('n1').x === 0 && dagAt('n2').x === 100, '同层按宽度铺开：a=0 / b=100')
}

console.log('\nAI 侧补齐：读得到坐标、move、独立线、highlight、撤销 AI 改动')
{
  store.clear()
  // ① 读回节点坐标（以前只有 id/label/shape/style —— AI 看不见位置，判断不了重叠/对齐）
  await apply([{ op: 'addNode', label: '甲', w: 60, h: 60, x: 10, y: 20 }], { path: 'ai.drawio' })
  const read1 = await readTool.execute({ path: 'ai.drawio' }, exec)
  const a1 = read1.nodes.filter((n) => n.id === 'n1')[0]
  ok(a1 !== undefined && a1.x === 10 && a1.y === 20 && a1.w === 60 && a1.h === 60, 'diagram_read 回了坐标与尺寸：' + JSON.stringify(a1 === undefined ? null : [a1.x, a1.y, a1.w, a1.h]))

  // ② move：相对位移 / 绝对坐标 / 连线（平移它自己的几何）
  await apply([{ op: 'move', id: 'n1', dx: 40, dy: -20 }], { path: 'ai.drawio' })
  let moving = parseMxfile(store.get(WORKSPACE + '\\ai.drawio')).doc
  ok(moving.nodes[0].x === 50 && moving.nodes[0].y === 0, 'move dx/dy 挪节点：50,0（实际 ' + moving.nodes[0].x + ',' + moving.nodes[0].y + '）')
  await apply([{ op: 'move', id: 'n1', x: 200, y: 100 }], { path: 'ai.drawio' })
  moving = parseMxfile(store.get(WORKSPACE + '\\ai.drawio')).doc
  ok(moving.nodes[0].x === 200 && moving.nodes[0].y === 100, 'move x/y 绝对定位：200,100')

  // 独立线：两端都是自由点，之后还能用 move 整体平移它
  await apply([{ op: 'addNode', label: '乙' }, { op: 'addEdge', fromPoint: { x: 0, y: 0 }, toPoint: { x: 100, y: 0 } }], { path: 'ai.drawio' })
  moving = parseMxfile(store.get(WORKSPACE + '\\ai.drawio')).doc
  const free = moving.edges.filter((e) => e.sourcePoint !== undefined)[0]
  ok(free !== undefined && free.from === undefined && free.to === undefined, '独立线：两端都是自由点，不接任何节点')
  await apply([{ op: 'move', id: free.id, dx: 15, dy: 5 }], { path: 'ai.drawio' })
  moving = parseMxfile(store.get(WORKSPACE + '\\ai.drawio')).doc
  const movedFree = moving.edges.filter((e) => e.id === free.id)[0]
  ok(movedFree.sourcePoint.x === 15 && movedFree.targetPoint.y === 5, 'move 平移独立线自己的几何：' + JSON.stringify([movedFree.sourcePoint, movedFree.targetPoint]))

  // 错误也要说清楚（都是"写盘之前"失败）
  let moveErr = null
  try {
    await apply([{ op: 'move', id: 'n1' }], { path: 'ai.drawio' })
  } catch (error) {
    moveErr = error && error.message ? error.message : String(error)
  }
  ok(moveErr !== null && moveErr.indexOf('dx') >= 0, 'move 不给位移参数时明确报错：' + String(moveErr).slice(0, 70))
  let edgeMoveErr = null
  try {
    await apply([{ op: 'move', id: movedFree.id, x: 5 }], { path: 'ai.drawio' })
  } catch (error) {
    edgeMoveErr = error && error.message ? error.message : String(error)
  }
  ok(edgeMoveErr !== null && edgeMoveErr.indexOf('dx') >= 0, '连线只能用 dx/dy 平移（绝对坐标没有意义）：' + String(edgeMoveErr).slice(0, 70))

  // ③ highlight：只请求高亮 → **不写盘**（尤其不能顺手重排），并挂在下次 read 上一次性取走
  const beforeText = store.get(WORKSPACE + '\\ai.drawio')
  const beforeRevision = contentHash(beforeText)
  const highlighted = await applyTool.execute({ path: 'ai.drawio', ops: [{ op: 'highlight', ids: ['n1', 'n2'] }] }, exec)
  ok(highlighted.revision === beforeRevision, 'highlight-only 调用没有改文件（revision 不变）：' + highlighted.revision + ' vs ' + beforeRevision)
  ok(store.get(WORKSPACE + '\\ai.drawio') === beforeText, 'highlight-only 调用逐字节没动文件')
  ok(highlighted.layout === 'none', '也没顺手重排（layout 强制 none）')
  const read2 = await readTool.execute({ path: 'ai.drawio' }, exec)
  ok(Array.isArray(read2.highlight) && read2.highlight.join(',') === 'n1,n2', '高亮挂在下次 read 上：' + JSON.stringify(read2.highlight))
  const read3 = await readTool.execute({ path: 'ai.drawio' }, exec)
  ok(Array.isArray(read3.highlight) && read3.highlight.length === 0, '取走即清（第二次 read 没有高亮）')

  // ④ 撤销 AI 改动：read 里能看到 canRevert（现在是个**栈**，能连着退几步）
  const stage1 = store.get(WORKSPACE + '\\ai.drawio')
  await apply([{ op: 'setLabel', id: 'n1', label: '改过的甲' }], { path: 'ai.drawio' })
  const stage2 = store.get(WORKSPACE + '\\ai.drawio')
  ok(stage1 !== stage2, 'AI 改动前后文件确实不同')
  const readCan = await readTool.execute({ path: 'ai.drawio' }, exec)
  ok(readCan.canRevert === true && readCan.revertSteps > 0, 'read 里带 canRevert=true 与剩余步数：' + readCan.revertSteps)
  const reverted = await api({ action: 'revert', sessionId: 's1', path: 'ai.drawio' })
  const stage1Revision = parseMxfile(stage1).doc.revision
  ok(reverted.payload.ok === true && reverted.payload.revision === stage1Revision, 'revert 端点把文件写回上一版：' + String(reverted.payload.revision))
  ok(store.get(WORKSPACE + '\\ai.drawio') === stage1, 'revert 之后逐字节等于改动前')
  // 多步：接着退（一次退一层，不是一次跳回最开始），直到退不动
  let extraSteps = 0
  for (let i = 0; i < 20; i += 1) {
    const one = await api({ action: 'revert', sessionId: 's1', path: 'ai.drawio' })
    if (one.payload.ok !== true) {
      ok(typeof one.payload.error === 'string' && one.payload.error.length > 0, '没有可退回的改动时明确说一句：' + String(one.payload.error))
      break
    }
    extraSteps += 1
  }
  ok(extraSteps >= 1, '这一轮里不止一步可退（接着退了 ' + extraSteps + ' 步）')
  const readAfter = await readTool.execute({ path: 'ai.drawio' }, exec)
  ok(readAfter.canRevert === false && readAfter.revertSteps === 0, '退干净之后 canRevert=false、revertSteps=0')
}

console.log('\nAI 侧 P0：用户选区、结构化 id、批量 ids、expectRevision 乐观锁')
{
  store.clear()
  await apply([{ op: 'addNode', label: '甲' }, { op: 'addNode', label: '乙' }, { op: 'addNode', label: '丙' }], { path: 'ai-p0.drawio' })

  // ① 选区：客户端上报 → diagram_read 带回。
  // 以前 AI 完全看不见"这几个"是哪几个（画布只说过"在看哪一张"，从没说过"选中了谁"）。
  const noSel = await readTool.execute({ path: 'ai-p0.drawio' }, exec)
  ok(Array.isArray(noSel.selection) && noSel.selection.length === 0, '没人选时 selection 是空数组')
  const posted = await api({ action: 'selection', sessionId: 's1', path: 'ai-p0.drawio', ids: ['n1', 'n3'] })
  ok(posted.payload.ok === true && posted.payload.count === 2, 'selection 端点记下选区：' + JSON.stringify(posted.payload))
  const withSel = await readTool.execute({ path: 'ai-p0.drawio' }, exec)
  ok(withSel.selection.join(',') === 'n1,n3', 'diagram_read 把用户选区带回来：' + JSON.stringify(withSel.selection))

  // 按**文件**配对：另一个文件里也可以有叫 n1 的节点，但那不是这张图的选区
  await apply([{ op: 'addNode', label: '别的图' }], { path: 'ai-p0-other.drawio' })
  const otherSel = await readTool.execute({ path: 'ai-p0-other.drawio' }, exec)
  ok(otherSel.selection.length === 0, '别的文件读不到这张图的选区（两个文件里都叫 n1 很常见）')

  // 空选区上报 = 清掉（用户点空白处取消选择）
  await api({ action: 'selection', sessionId: 's1', path: 'ai-p0.drawio', ids: [] })
  const selCleared = await readTool.execute({ path: 'ai-p0.drawio' }, exec)
  ok(selCleared.selection.length === 0, '空选区上报 = 清掉记录')

  // 换画布（focus 变更）→ 旧选区作废
  await api({ action: 'selection', sessionId: 's1', path: 'ai-p0.drawio', ids: ['n1', 'n3'] })
  await api({ action: 'focus', sessionId: 's1', path: 'ai-p0-other.drawio' })
  const afterSwitch = await readTool.execute({ path: 'ai-p0.drawio' }, exec)
  ok(afterSwitch.selection.length === 0, '切换画布之后旧选区作废')

  // 删掉的单元从选区里划掉（读时的存在性过滤 + 改图时主动划掉，见 forgetSelection）
  await api({ action: 'selection', sessionId: 's1', path: 'ai-p0.drawio', ids: ['n1', 'n3'] })
  await apply([{ op: 'remove', id: 'n3' }], { path: 'ai-p0.drawio' })
  const afterRemove = await readTool.execute({ path: 'ai-p0.drawio' }, exec)
  ok(afterRemove.selection.join(',') === 'n1', '被删掉的单元从选区里划掉：' + JSON.stringify(afterRemove.selection))

  // ② 结构化 id：自动分配的 id 直接从返回值里拿（以前只能去解析 summary 文本）
  const made = await applyTool.execute(
    { path: 'ai-p0.drawio', ops: [{ op: 'addNode', label: '丁' }, { op: 'addEdge', from: 'n1', to: 'n2' }] },
    exec,
  )
  ok(
    Array.isArray(made.created) && made.created.length === 2 && made.created[0].type === 'node' && made.created[1].type === 'edge',
    '返回值里带 created（id + type）：' + JSON.stringify(made.created),
  )
  const newNodeId = made.created[0].id
  ok(newNodeId !== 'n1' && typeof made.created[1].id === 'string', '自动分配的 id 就在返回值里（不必猜 n 几）：' + newNodeId + ' / ' + made.created[1].id)
  // 前提 + 一条容易漏的连带：id 是**会复用**的（腾出来的 n3 又被用了），
  // 而复用的新节点绝不能继承"用户之前选中过 n3"。
  ok(newNodeId === 'n3', '（前提）id 复用：删掉 n3 之后新建的又叫 ' + newNodeId)
  const afterReuse = await readTool.execute({ path: 'ai-p0.drawio' }, exec)
  ok(afterReuse.selection.indexOf('n3') < 0, '复用同一个 id 的新节点不继承旧选区：' + JSON.stringify(afterReuse.selection))

  // 别名：同一个 ops 数组里引用"刚建的那个"，不必猜编号
  const aliased = await applyTool.execute(
    {
      path: 'ai-p0.drawio',
      ops: [
        { op: 'addNode', label: '起点', as: 'start' },
        { op: 'addNode', label: '终点', as: 'end' },
        { op: 'addEdge', from: 'start', to: 'end', label: '走' },
      ],
    },
    exec,
  )
  const aliasNodes = aliased.created.filter((c) => c.type === 'node').map((c) => c.id)
  const aliasEdge = aliased.created.filter((c) => c.type === 'edge')[0]
  const aliasDoc = parseMxfile(store.get(WORKSPACE + '\\ai-p0.drawio')).doc
  const aliasInDoc = aliasDoc.edges.filter((e) => e.id === aliasEdge.id)[0]
  ok(
    aliasInDoc.from === aliasNodes[0] && aliasInDoc.to === aliasNodes[1],
    '别名把 addEdge 接到了刚建的两个节点上：' + aliasInDoc.from + ' -> ' + aliasInDoc.to,
  )
  let aliasErr = null
  try {
    await applyTool.execute({ path: 'ai-p0.drawio', ops: [{ op: 'addNode', label: 'x', as: 'n1' }] }, exec)
  } catch (error) {
    aliasErr = String(error && error.message)
  }
  ok(aliasErr !== null && aliasErr.indexOf('collides') >= 0, '别名撞已有 id 直接报错（含糊地"谁赢"更难查）：' + aliasErr.slice(0, 70))

  // ③ 批量 ids：用户说"把这几个换成绿色"时一次改一组，不必逐个发 op
  const batch = await applyTool.execute(
    {
      path: 'ai-p0.drawio',
      ops: [
        { op: 'setStyle', ids: ['n1', 'n2', newNodeId], style: 'green' },
        { op: 'move', ids: ['n1', 'n2'], dx: 10, dy: 0 },
      ],
    },
    exec,
  )
  ok(batch.changed.length === 3, 'setStyle/move 的 ids 批量都记进了 changed（去重）：' + JSON.stringify(batch.changed))
  const batchDoc = parseMxfile(store.get(WORKSPACE + '\\ai-p0.drawio')).doc
  const greenOnes = batchDoc.nodes.filter((n) => String(n.style).indexOf('fillColor=#d5e8d4') >= 0).length
  ok(greenOnes === 3, '一次 setStyle 真的改了 3 个节点的配色：' + greenOnes)
  let batchErr = null
  try {
    await apply([{ op: 'move', ids: ['n1', 'n2'], x: 100 }], { path: 'ai-p0.drawio' })
  } catch (error) {
    batchErr = String(error && error.message)
  }
  ok(batchErr !== null && batchErr.indexOf('dx') >= 0, '批量 move 只收相对位移（一个绝对 x/y 会把它们叠成一摞）：' + batchErr.slice(0, 70))
  let bothErr = null
  try {
    await apply([{ op: 'setLabel', id: 'n1', ids: ['n2'], label: 'x' }], { path: 'ai-p0.drawio' })
  } catch (error) {
    bothErr = String(error && error.message)
  }
  ok(bothErr !== null && bothErr.indexOf('not both') >= 0, '同时给 id 和 ids 直接报错（不猜谁赢）')

  // ④ expectRevision：read 拿到的指纹当基线，对不上就**一个字节都不写**
  const revNow = store.get(WORKSPACE + '\\ai-p0.drawio')
  const revRead = (await readTool.execute({ path: 'ai-p0.drawio' }, exec)).revision
  const goodApply = await applyTool.execute(
    { path: 'ai-p0.drawio', ops: [{ op: 'setLabel', id: 'n1', label: '对得上' }], expectRevision: revRead },
    exec,
  )
  ok(goodApply.revision !== revRead, 'expectRevision 对得上 → 照常写盘（revision 前进）')
  const afterGood = store.get(WORKSPACE + '\\ai-p0.drawio')
  ok(afterGood !== revNow, '文件确实改了')
  let conflict = null
  try {
    await applyTool.execute({ path: 'ai-p0.drawio', ops: [{ op: 'setLabel', id: 'n1', label: '不该写进去' }], expectRevision: revRead }, exec)
  } catch (error) {
    conflict = String(error && error.message)
  }
  ok(conflict !== null && conflict.indexOf('revision conflict') >= 0, '指纹过时 → 报错并让人重读：' + conflict.slice(0, 80))
  ok(store.get(WORKSPACE + '\\ai-p0.drawio') === afterGood, '冲突时一个字节都没写（别人的改动不会被静默覆盖）')
  // 不传 = 不检查（向后兼容：老的调用方式照旧能用）
  const noExpect = await applyTool.execute({ path: 'ai-p0.drawio', ops: [{ op: 'setLabel', id: 'n1', label: '不检查' }] }, exec)
  ok(typeof noExpect.revision === 'string' && noExpect.revision.length > 0, '不传 expectRevision 时不做检查（老调用不受影响）')
}

console.log('\nAI 侧 P1：setEdge 重接（不丢折点/标签）、setLabelPos（线上文字的位置）')
{
  store.clear()
  // 三个节点 + 一条带折点、带标签、带端点约束的边：改接之后这些**一个都不许丢**。
  await apply(
    [
      { op: 'addNode', label: 'A', x: 0, y: 0 },
      { op: 'addNode', label: 'B', x: 300, y: 0 },
      { op: 'addNode', label: 'C', x: 0, y: 300 },
      { op: 'addEdge', from: 'n1', to: 'n2', label: '主路径', exit: 'e', entry: 'w' },
      { op: 'setStyle', id: 'e1', keys: { rounded: 1 } },
    ],
    { path: 'p1.drawio' },
  )
  // 手工给它加两个折点（模拟人摆过的走线）
  const seededEdge = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc.edges[0]
  await applyTool.execute(
    { path: 'p1.drawio', ops: [{ op: 'setEdge', id: 'e1', to: 'n3' }] },
    exec,
  )
  const reconnected = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc
  const rcEdge = reconnected.edges[0]
  ok(rcEdge.id === 'e1', 'setEdge 保留 id（不是删了重画）：' + rcEdge.id)
  ok(rcEdge.from === 'n1' && rcEdge.to === 'n3', 'setEdge 改了目标端：' + rcEdge.from + ' -> ' + rcEdge.to)
  ok(rcEdge.label === '主路径', '改接保留线上文字：' + String(rcEdge.label))
  ok(String(rcEdge.style).indexOf('exitX=1') >= 0 && String(rcEdge.style).indexOf('entryX=0') >= 0, '改接保留端点约束（exit/entry）：' + String(rcEdge.style))
  ok(String(rcEdge.style).indexOf('rounded=1') >= 0, '改接保留其它 style 键（rounded）：' + String(rcEdge.style))
  ok(seededEdge.points === undefined || rcEdge.points === undefined || JSON.stringify(seededEdge.points) === JSON.stringify(rcEdge.points), '改接不动折点字段')

  // 折点确实留着（先造一条真带折点的边再改接）
  await apply([{ op: 'addEdge', from: 'n1', to: 'n2', as: 'e2alias' }], { path: 'p1.drawio' })
  const beforePoints = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc.edges.map((e) => e.id)
  ok(beforePoints.indexOf('e2') >= 0, '第二条边建出来了：' + JSON.stringify(beforePoints))

  // 脱开节点 = 给绝对点（drawio 的自由端）
  await apply([{ op: 'setEdge', id: 'e2', to: null, toPoint: { x: 500, y: 400 } }], { path: 'p1.drawio' })
  const freed = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc.edges.filter((e) => e.id === 'e2')[0]
  ok(freed.to === undefined && freed.targetPoint.x === 500 && freed.targetPoint.y === 400, 'setEdge + toPoint：那一端脱开节点变成自由点')
  // 再拖回节点上：自由点必须被删掉（drawio 里"有真实顶点时忽略自由点"，留着是脏数据）
  await apply([{ op: 'setEdge', id: 'e2', to: 'n3' }], { path: 'p1.drawio' })
  const reattached = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc.edges.filter((e) => e.id === 'e2')[0]
  ok(reattached.to === 'n3' && reattached.targetPoint === undefined, '接回节点时把过期的自由点删掉：' + JSON.stringify(reattached.targetPoint))

  // 报错也要说清楚
  let noEnd = null
  try {
    await apply([{ op: 'setEdge', id: 'e1' }], { path: 'p1.drawio' })
  } catch (error) {
    noEnd = String(error && error.message)
  }
  ok(noEnd !== null && noEnd.indexOf('from') >= 0, 'setEdge 没给任何一端 → 报错：' + String(noEnd).slice(0, 70))
  let bothEnd = null
  try {
    await apply([{ op: 'setEdge', id: 'e1', from: 'n1', fromPoint: { x: 1, y: 1 } }], { path: 'p1.drawio' })
  } catch (error) {
    bothEnd = String(error && error.message)
  }
  ok(bothEnd !== null && bothEnd.indexOf('只能给一个') >= 0, '同一端同时给节点与点 → 报错（不猜谁赢）')
  let nodeAsEdge = null
  try {
    await apply([{ op: 'setEdge', id: 'n1', to: 'n2' }], { path: 'p1.drawio' })
  } catch (error) {
    nodeAsEdge = String(error && error.message)
  }
  ok(nodeAsEdge !== null && nodeAsEdge.indexOf('Known edges') >= 0, '把节点 id 当边改接 → 报错并列出已知边：' + String(nodeAsEdge).slice(0, 70))
  let unknownNode = null
  try {
    await apply([{ op: 'setEdge', id: 'e1', from: 'nope' }], { path: 'p1.drawio' })
  } catch (error) {
    unknownNode = String(error && error.message)
  }
  ok(unknownNode !== null && unknownNode.indexOf('Known nodes') >= 0, '改接到不存在的节点 → 报错并列出已知节点')

  // ② setLabelPos：线上的文字位置（拖过才有；read 要看得见）
  const noPos = await readTool.execute({ path: 'p1.drawio' }, exec)
  const e1View = noPos.edges.filter((e) => e.id === 'e1')[0]
  ok(e1View.labelX === undefined, '没拖过的标签不回位置（它就在弧长中点）')
  await apply([{ op: 'setLabelPos', id: 'e1', dy: 12 }], { path: 'p1.drawio' })
  const movedLabel = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc.edges.filter((e) => e.id === 'e1')[0]
  ok(movedLabel.labelX === 0 && movedLabel.labelY === 12, 'setLabelPos dy 挪 12px（x 仍是中点 0）：' + JSON.stringify([movedLabel.labelX, movedLabel.labelY]))
  const readPos = await readTool.execute({ path: 'p1.drawio' }, exec)
  const e1After = readPos.edges.filter((e) => e.id === 'e1')[0]
  ok(e1After.labelX === 0 && e1After.labelY === 12, 'diagram_read 回 labelX/labelY：' + JSON.stringify([e1After.labelX, e1After.labelY]))
  // 文件里真的写进了边几何的 x/y（drawio 的存法）。属性顺序不固定：无损写回是"往已有的
  // 属性上改/补"，所以不能按固定前缀匹配。
  ok(/<mxGeometry[^>]*\sx="0"\sy="12"/.test(store.get(WORKSPACE + '\\p1.drawio')), '位置按 drawio 的存法落进边几何的 x/y')
  await apply([{ op: 'setLabelPos', id: 'e1', x: 0.25, y: 0 }], { path: 'p1.drawio' })
  const along = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc.edges.filter((e) => e.id === 'e1')[0]
  ok(along.labelX === 0.25 && along.labelY === 0, 'setLabelPos 能给沿边比例（0.25 = 四分之一处）：' + JSON.stringify([along.labelX, along.labelY]))
  await apply([{ op: 'setLabelPos', id: 'e1', center: true }], { path: 'p1.drawio' })
  const centered = parseMxfile(store.get(WORKSPACE + '\\p1.drawio')).doc.edges.filter((e) => e.id === 'e1')[0]
  ok(centered.labelX === undefined && centered.labelY === undefined, 'center:true 删掉位置（回到弧长中点）')
  ok(/<mxGeometry relative="1"/.test(store.get(WORKSPACE + '\\p1.drawio')), '居中之后边几何上没有 x/y 残留（不是写 x=0 y=0）')
  let posErr = null
  try {
    await apply([{ op: 'setLabelPos', id: 'e1', x: 3 }], { path: 'p1.drawio' })
  } catch (error) {
    posErr = String(error && error.message)
  }
  ok(posErr !== null && posErr.indexOf('比例') >= 0, '沿边比例超出 -1..1 → 报错并说该用 dy：' + String(posErr).slice(0, 70))
  let posNode = null
  try {
    await apply([{ op: 'setLabelPos', id: 'n1', dy: 1 }], { path: 'p1.drawio' })
  } catch (error) {
    posNode = String(error && error.message)
  }
  ok(posNode !== null && posNode.indexOf('Known edges') >= 0, '节点没有"线上文字位置"→ 报错并列出已知边')
}

console.log('\nAI 侧 P1：order（z-order，写回要真的改文件里单元的先后）')
{
  store.clear()
  await apply(
    [
      { op: 'addNode', label: '底', x: 0, y: 0 },
      { op: 'addNode', label: '中', x: 0, y: 100 },
      { op: 'addNode', label: '上', x: 0, y: 200 },
      { op: 'addEdge', from: 'n1', to: 'n2' },
      { op: 'addEdge', from: 'n2', to: 'n3' },
    ],
    { path: 'z.drawio' },
  )
  const idsOf = () => parseMxfile(store.get(WORKSPACE + '\\z.drawio')).doc
  ok(idsOf().nodes.map((n) => n.id).join(',') === 'n1,n2,n3', '起始顺序 n1,n2,n3')
  await apply([{ op: 'order', id: 'n1', to: 'front' }], { path: 'z.drawio' })
  ok(idsOf().nodes.map((n) => n.id).join(',') === 'n2,n3,n1', 'order front 把 n1 放到最后（= 画在最上面）：' + idsOf().nodes.map((n) => n.id).join(','))
  // 关键：不只是内存里的顺序，**文件里单元的先后**也得跟着变（否则重新打开就变回原样）
  const rawText = store.get(WORKSPACE + '\\z.drawio')
  const cellAt = (id) => rawText.indexOf('id="' + id + '"')
  ok(cellAt('n1') > cellAt('n3') && cellAt('n3') > cellAt('n2'), '写回把文件里 n1 的单元挪到了 n2/n3 之后（实际 n1@' + cellAt('n1') + ' n2@' + cellAt('n2') + ' n3@' + cellAt('n3') + '）')
  await apply([{ op: 'order', id: 'n1', to: 'back' }], { path: 'z.drawio' })
  ok(idsOf().nodes.map((n) => n.id).join(',') === 'n1,n2,n3', 'order back 放回最前（= 压在最下面）')
  await apply([{ op: 'order', id: 'n1', to: 'up' }], { path: 'z.drawio' })
  ok(idsOf().nodes.map((n) => n.id).join(',') === 'n2,n1,n3', 'order up 上移一层')
  await apply([{ op: 'order', id: 'n1', to: 'down' }], { path: 'z.drawio' })
  ok(idsOf().nodes.map((n) => n.id).join(',') === 'n1,n2,n3', 'order down 下移一层')
  // 一组：整体置顶，组内相对顺序不变
  await apply([{ op: 'order', ids: ['n2', 'n1'], to: 'front' }], { path: 'z.drawio' })
  ok(idsOf().nodes.map((n) => n.id).join(',') === 'n3,n1,n2', '一组 front 按原相对顺序整体置顶：' + idsOf().nodes.map((n) => n.id).join(','))
  // 连线是另一条序列
  await apply([{ op: 'order', id: 'e1', to: 'front' }], { path: 'z.drawio' })
  ok(idsOf().edges.map((e) => e.id).join(',') === 'e2,e1', '连线按自己的序列排：' + idsOf().edges.map((e) => e.id).join(','))
  // 顺序没真的变 → 文件一个字节都不动（无损的第一条不变量）
  const beforeNoop = store.get(WORKSPACE + '\\z.drawio')
  await apply([{ op: 'order', id: 'e1', to: 'front' }], { path: 'z.drawio' })
  ok(store.get(WORKSPACE + '\\z.drawio') === beforeNoop, '置顶一个已经在顶上的 → 文件逐字节不变')

  let badTo = null
  try {
    await apply([{ op: 'order', id: 'n1', to: 'top' }], { path: 'z.drawio' })
  } catch (error) {
    badTo = String(error && error.message)
  }
  ok(badTo !== null && badTo.indexOf('front') >= 0, 'order 的 to 不认识时列出可选值：' + String(badTo).slice(0, 70))
  let groupUp = null
  try {
    await apply([{ op: 'order', ids: ['n1', 'n2'], to: 'up' }], { path: 'z.drawio' })
  } catch (error) {
    groupUp = String(error && error.message)
  }
  ok(groupUp !== null && groupUp.indexOf('front/back') >= 0, '一组做 up/down 直接拒绝（谁先谁后说不清）')
  let mixed = null
  try {
    await apply([{ op: 'order', ids: ['n1', 'e1'], to: 'front' }], { path: 'z.drawio' })
  } catch (error) {
    mixed = String(error && error.message)
  }
  ok(mixed !== null && mixed.indexOf('两条序列') >= 0, '节点与连线混在一组 → 报错（它们是两条序列）')
  let unknown = null
  try {
    await apply([{ op: 'order', id: 'zzz', to: 'front' }], { path: 'z.drawio' })
  } catch (error) {
    unknown = String(error && error.message)
  }
  ok(unknown !== null && unknown.indexOf('Known nodes') >= 0, 'order 未知 id → 报错并列出已知节点')
}

console.log('\nAI 侧 P1：duplicate（复制一组，折点/端点约束/标签位置都带过去）')
{
  store.clear()
  // 一次调用里全部建好：**只要这一批里有 addNode 带 x/y，整批就不重排**（自带的几何要保住）。
  await applyTool.execute(
    {
      path: 'dup.drawio',
      ops: [
        { op: 'addNode', label: '网关', x: 100, y: 100, style: 'blue' },
        { op: 'addNode', label: '服务', x: 100, y: 300, style: 'green' },
        { op: 'addEdge', from: 'n1', to: 'n2', label: '调用', exit: 's', entry: 'n' },
        { op: 'setLabelPos', id: 'e1', dy: 8 },
        { op: 'addEdge', fromPoint: { x: 600, y: 600 }, toPoint: { x: 700, y: 600 }, label: '说明线' },
      ],
    },
    exec,
  )

  const dupResult = await applyTool.execute({ path: 'dup.drawio', ops: [{ op: 'duplicate', ids: ['n1', 'n2'] }] }, exec)
  const dupNodeIds = dupResult.created.filter((c) => c.type === 'node').map((c) => c.id)
  const dupEdgeIds = dupResult.created.filter((c) => c.type === 'edge').map((c) => c.id)
  ok(dupNodeIds.length === 2 && dupEdgeIds.length === 1, 'duplicate 建了 2 个节点 + 1 条内部边：' + JSON.stringify(dupResult.created))
  const dupDoc = parseMxfile(store.get(WORKSPACE + '\\dup.drawio')).doc
  const cloneA = dupDoc.nodes.filter((n) => n.id === dupNodeIds[0])[0]
  ok(cloneA.x === 120 && cloneA.y === 120, '默认位移两格（+20/+20）：' + cloneA.x + ',' + cloneA.y)
  ok(cloneA.id !== 'n1' && cloneA.label === '网关' && String(cloneA.style).indexOf('fillColor=#dae8fc') >= 0, '复制保留标签与样式')
  const cloneEdge = dupDoc.edges.filter((e) => e.id === dupEdgeIds[0])[0]
  ok(cloneEdge.from === dupNodeIds[0] && cloneEdge.to === dupNodeIds[1], '新边接在**新节点**上（不是原来的）：' + cloneEdge.from + ' -> ' + cloneEdge.to)
  ok(cloneEdge.label === '调用', '新边保留线上文字：' + String(cloneEdge.label))
  ok(cloneEdge.labelX === 0 && cloneEdge.labelY === 8, '新边保留标签位置（相对位置照旧）：' + JSON.stringify([cloneEdge.labelX, cloneEdge.labelY]))
  ok(String(cloneEdge.style).indexOf('exitX=0.5') >= 0 && String(cloneEdge.style).indexOf('entryX=0.5') >= 0, '新边保留端点约束')
  // 深拷：改新边的折点不该动到原边
  await apply([{ op: 'setStyle', id: dupEdgeIds[0], clearPoints: true }], { path: 'dup.drawio' })
  const afterClear = parseMxfile(store.get(WORKSPACE + '\\dup.drawio')).doc
  ok(afterClear.edges.filter((e) => e.id === 'e1')[0].points === undefined || Array.isArray(afterClear.edges.filter((e) => e.id === 'e1')[0].points), '清折点只作用于被改的那条边')

  // 独立线：单条复制 + 位移
  const freeDup = await applyTool.execute({ path: 'dup.drawio', ops: [{ op: 'duplicate', id: 'e2' }] }, exec)
  const freeCloneId = freeDup.created[0].id
  const freeClone = parseMxfile(store.get(WORKSPACE + '\\dup.drawio')).doc.edges.filter((e) => e.id === freeCloneId)[0]
  ok(freeClone.sourcePoint.x === 620 && freeClone.targetPoint.x === 720, '独立线复制后两端自由点一起位移：' + JSON.stringify([freeClone.sourcePoint, freeClone.targetPoint]))
  ok(freeClone.label === '说明线', '独立线复制保留标签')

  // withEdges:false —— 只要节点
  const nodesOnly = await applyTool.execute({ path: 'dup.drawio', ops: [{ op: 'duplicate', id: 'n1', withEdges: false }] }, exec)
  ok(nodesOnly.created.length === 1 && nodesOnly.created[0].type === 'node', 'withEdges:false 只复制节点：' + JSON.stringify(nodesOnly.created))

  // as：别名指向**复制出来的那个**
  const aliased = await applyTool.execute(
    {
      path: 'dup.drawio',
      ops: [
        { op: 'duplicate', id: 'n1', withEdges: false, as: 'copy1' },
        { op: 'setLabel', id: 'copy1', label: '副本' },
      ],
    },
    exec,
  )
  const copyId = aliased.created[0].id
  const copyNode = parseMxfile(store.get(WORKSPACE + '\\dup.drawio')).doc.nodes.filter((n) => n.id === copyId)[0]
  ok(copyNode.label === '副本', 'as 别名指向复制出来的那个（setLabel 改的是副本）：' + copyNode.label)
  ok(parseMxfile(store.get(WORKSPACE + '\\dup.drawio')).doc.nodes.filter((n) => n.id === 'n1')[0].label === '网关', '原节点没被改到')

  // 错误路径
  let replayErr = null
  try {
    await apply([{ op: 'duplicate', id: 'e1' }], { path: 'dup.drawio' })
  } catch (error) {
    replayErr = String(error && error.message)
  }
  ok(replayErr !== null && replayErr.indexOf('两端') >= 0, '只复制一条接在节点上的边 → 明确要求把两端一起复制：' + String(replayErr).slice(0, 80))
  let asErr = null
  try {
    await apply([{ op: 'duplicate', ids: ['n1', 'n2'], as: 'x' }], { path: 'dup.drawio' })
  } catch (error) {
    asErr = String(error && error.message)
  }
  ok(asErr !== null && asErr.indexOf('单个节点') >= 0, '一组复制不给 as → 报错（没有唯一的新 id 可指）')
  let unknown = null
  try {
    await apply([{ op: 'duplicate', id: 'zzz' }], { path: 'dup.drawio' })
  } catch (error) {
    unknown = String(error && error.message)
  }
  ok(unknown !== null && unknown.indexOf('Known nodes') >= 0, 'duplicate 未知 id → 报错并列出已知节点')
}

console.log('\nAI 侧 P1：按层操作（addLayer / addNode.layer / setLayer / setLayerProps）')
{
  store.clear()
  await apply([{ op: 'addNode', label: '甲', x: 0, y: 0 }], { path: 'ly.drawio' })
  // ① 新建一层 + 新单元直接落进去（AI 原来只能"新东西一律进第一层"）。
  // 别名只在**同一次调用**里有效，所以建层与用它要在同一个 ops 数组里（跨调用按层名引用）。
  const madeLayer = await applyTool.execute(
    {
      path: 'ly.drawio',
      ops: [
        { op: 'addLayer', name: '标注', as: 'note' },
        { op: 'addNode', label: '说明文字', shape: 'text', layer: 'note' },
      ],
    },
    exec,
  )
  const layerId = madeLayer.created[0].id
  ok(madeLayer.created[0].type === 'layer' && layerId !== '1', 'addLayer 返回新层的 id（避开已用的 1）：' + JSON.stringify(madeLayer.created[0]))
  let lyDoc = parseMxfile(store.get(WORKSPACE + '\\ly.drawio')).doc
  ok(lyDoc.layers.length === 2 && lyDoc.layers[1].name === '标注', '层表里多了一层「标注」：' + JSON.stringify(lyDoc.layers))
  ok(lyDoc.nodes.filter((n) => n.id === 'n2')[0].layer === layerId, 'addNode 的 layer 收别名，单元落在新层：' + String(lyDoc.nodes.filter((n) => n.id === 'n2')[0].layer))
  ok(lyDoc.nodes.filter((n) => n.id === 'n1')[0].layer === '1', '没写 layer 的单元还在原来的层')
  // 文件里 parent 真的指到那一层（drawio 打开也是这个层级）
  ok(new RegExp('id="n2"[^>]*parent="' + layerId + '"').test(store.get(WORKSPACE + '\\ly.drawio')), '写回时单元的 parent 指向新层')
  const readLy = await readTool.execute({ path: 'ly.drawio' }, exec)
  ok(readLy.layers.length === 2 && readLy.nodes.filter((n) => n.id === 'n2')[0].layer === layerId, 'diagram_read 回新层表与单元的 layer')

  // ② 移到别的层（层名也认）+ 连线一起搬
  await apply(
    [
      { op: 'addNode', label: '乙', x: 200, y: 0, layer: layerId },
      { op: 'addEdge', from: 'n1', to: 'n2', layer: layerId },
    ],
    { path: 'ly.drawio' },
  )
  lyDoc = parseMxfile(store.get(WORKSPACE + '\\ly.drawio')).doc
  ok(lyDoc.edges.filter((e) => e.id === 'e1')[0].layer === layerId, 'addEdge 的 layer 也生效（连线在同一层）')
  await apply([{ op: 'setLayer', ids: ['n1', 'e1'], layer: '标注' }], { path: 'ly.drawio' })
  lyDoc = parseMxfile(store.get(WORKSPACE + '\\ly.drawio')).doc
  ok(lyDoc.nodes.filter((n) => n.id === 'n1')[0].layer === layerId, 'setLayer 按**层名**把节点移过去（实际 ' + String(lyDoc.nodes.filter((n) => n.id === 'n1')[0].layer) + ' 目标 ' + layerId + '）')
  ok(lyDoc.edges.filter((e) => e.id === 'e1')[0].layer === layerId, 'setLayer 也能搬连线（一起写 ids）')
  ok(lyDoc.layers.filter((l) => l.id === '1')[0] !== undefined && lyDoc.nodes.filter((n) => n.layer === '1').length === 0, '原来的层还在，只是空了（实际还挂着 ' + lyDoc.nodes.filter((n) => n.layer === '1').map((n) => n.id).join(',') + '）')

  // ③ 层的显示/隐藏/改名/锁定（纯文档状态，隐藏 ≠ 删除）
  const beforeHide = store.get(WORKSPACE + '\\ly.drawio')
  await apply([{ op: 'setLayerProps', layer: layerId, visible: false }], { path: 'ly.drawio' })
  lyDoc = parseMxfile(store.get(WORKSPACE + '\\ly.drawio')).doc
  ok(lyDoc.layers.filter((l) => l.id === layerId)[0].visible === false, 'setLayerProps 隐藏一层')
  ok(lyDoc.nodes.length === 3 && lyDoc.edges.length === 1, '隐藏不等于删除：层里的单元一个都没少')
  ok(store.get(WORKSPACE + '\\ly.drawio') !== beforeHide, '隐藏是**写进文件**的（drawio 打开也是隐藏的）')
  ok(/visible="0"/.test(store.get(WORKSPACE + '\\ly.drawio')), '隐藏写成 visible="0"')
  await apply([{ op: 'setLayerProps', layer: '标注', visible: true, name: '批注', locked: true }], { path: 'ly.drawio' })
  lyDoc = parseMxfile(store.get(WORKSPACE + '\\ly.drawio')).doc
  const renamed = lyDoc.layers.filter((l) => l.id === layerId)[0]
  ok(renamed.visible === true && renamed.name === '批注' && renamed.locked === true, '显示回来 + 改名 + 锁定：' + JSON.stringify(renamed))
  ok(/locked="1"/.test(store.get(WORKSPACE + '\\ly.drawio')), '锁定写成 locked="1"')
  ok(/visible="1"/.test(store.get(WORKSPACE + '\\ly.drawio')) === false, '显示回来是**删掉** visible 属性（不写 visible="1" 这种噪音）')

  // ④ 错误路径
  let badLayer = null
  try {
    await apply([{ op: 'setLayer', id: 'n1', layer: '不存在的层' }], { path: 'ly.drawio' })
  } catch (error) {
    badLayer = String(error && error.message)
  }
  ok(badLayer !== null && badLayer.indexOf('Layers:') >= 0, '移到不存在的层 → 报错并列出层表：' + String(badLayer).slice(0, 80))
  let addNodeBadLayer = null
  try {
    await apply([{ op: 'addNode', label: 'x', layer: 'nope' }], { path: 'ly.drawio' })
  } catch (error) {
    addNodeBadLayer = String(error && error.message)
  }
  ok(addNodeBadLayer !== null && addNodeBadLayer.indexOf('unknown layer') >= 0, 'addNode 给了不存在的层 → 写盘之前报错')
  let dupLayerId = null
  try {
    await apply([{ op: 'addLayer', name: '再来一层', id: layerId }], { path: 'ly.drawio' })
  } catch (error) {
    dupLayerId = String(error && error.message)
  }
  ok(dupLayerId !== null && dupLayerId.indexOf('already exists') >= 0, 'addLayer 撞已有层 id → 报错')
  let noProps = null
  try {
    await apply([{ op: 'setLayerProps', layer: layerId }], { path: 'ly.drawio' })
  } catch (error) {
    noProps = String(error && error.message)
  }
  ok(noProps !== null && noProps.indexOf('at least one') >= 0, 'setLayerProps 什么都不给 → 报错（而不是静默成功）')
  let aliasClash = null
  try {
    await apply([{ op: 'addLayer', name: '同名', as: '批注' }], { path: 'ly.drawio' })
  } catch (error) {
    aliasClash = String(error && error.message)
  }
  ok(aliasClash !== null && aliasClash.indexOf('collides with a layer') >= 0, '别名撞层名 → 报错（否则层名与别名谁赢说不清）')
}

console.log('\nAI 侧 P1：容器层级可读（把"移容器不带走子单元"从暗坑变成已知）')
{
  store.clear()
  // 一份 drawio 真实形状的文件：容器 cont + 子单元 child（相对坐标）
  const containerFile =
    '<mxfile host="app.diagrams.net">\n' +
    '  <diagram id="p1" name="Page-1">\n' +
    '    <mxGraphModel dx="0" dy="0"><root>\n' +
    '      <mxCell id="0" />\n' +
    '      <mxCell id="1" parent="0" />\n' +
    '      <mxCell id="cont" value="分组" style="container=1;fillColor=#EDF5FF;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="400" height="300" as="geometry" /></mxCell>\n' +
    '      <mxCell id="child" value="里面那个" style="rounded=1;" vertex="1" parent="cont"><mxGeometry x="20" y="30" width="80" height="40" as="geometry" /></mxCell>\n' +
    '    </root></mxGraphModel>\n' +
    '  </diagram>\n' +
    '</mxfile>\n'
  store.set(WORKSPACE + '\\grp.drawio', containerFile)
  const grpRead = await readTool.execute({ path: 'grp.drawio' }, exec)
  const childView = grpRead.nodes.filter((n) => n.id === 'child')[0]
  const contView = grpRead.nodes.filter((n) => n.id === 'cont')[0]
  ok(childView.parent === 'cont', 'diagram_read 告诉 AI 它在哪个容器里：' + String(childView.parent))
  ok(contView.parent === undefined, '普通单元没有 parent（图层不算容器）')
  ok(childView.x === 120 && childView.y === 130, '容器子单元读到的是**绝对**坐标（画布按绝对位置显示）：' + childView.x + ',' + childView.y)
  // 画布语义如此：移动容器**不会**带走子单元 —— 这条要显式钉住（AI 得靠 ids 一起搬）
  await apply([{ op: 'move', id: 'cont', dx: 200, dy: 0 }], { path: 'grp.drawio' })
  const afterMove = parseMxfile(store.get(WORKSPACE + '\\grp.drawio')).doc
  ok(afterMove.nodes.filter((n) => n.id === 'cont')[0].x === 300, '容器被挪了：cont.x=300')
  ok(
    afterMove.nodes.filter((n) => n.id === 'child')[0].x === 120 && afterMove.nodes.filter((n) => n.id === 'child')[0].y === 130,
    '子单元**留在原地**（与画布所见一致）—— 要一起动就把它们一起写进 ids',
  )
  // 一起搬：move 的批量正是为此（这就是 P0 的 ids 与容器信息的配合）
  await apply([{ op: 'move', ids: ['child', 'cont'], dx: 0, dy: 50 }], { path: 'grp.drawio' })
  const afterBoth = parseMxfile(store.get(WORKSPACE + '\\grp.drawio')).doc
  ok(afterBoth.nodes.filter((n) => n.id === 'child')[0].y === 180 && afterBoth.nodes.filter((n) => n.id === 'cont')[0].y === 150, '一组一起搬：容器与子单元的相对位置不变')
  // 层级没被写坏
  ok(/id="child"[^>]*parent="cont"/.test(store.get(WORKSPACE + '\\grp.drawio')), '搬完之后容器层级照旧（parent 还是 cont）')
}

console.log('\nAI 侧 P1：导出通道（请求 → 浏览器渲染 → 回执落盘）')
{
  store.clear()
  await apply([{ op: 'addNode', label: '导出的图', x: 0, y: 0 }], { path: 'exp.drawio' })
  const beforeExport = store.get(WORKSPACE + '\\exp.drawio')

  // ① 请求导出：**不改文档、不写盘**（渲染在浏览器那一半），返回 pending
  const asked = await applyTool.execute({ path: 'exp.drawio', ops: [{ op: 'export', format: 'svg' }] }, exec)
  ok(asked.export !== undefined && asked.export.status === 'pending' && asked.export.format === 'svg', '导出请求返回 pending：' + JSON.stringify(asked.export))
  ok(store.get(WORKSPACE + '\\exp.drawio') === beforeExport, '请求导出没有改动 .drawio（一个字节都没动）')
  ok(asked.layout === 'none', '纯导出的调用也没顺手重排')

  // ② 客户端从 read 里取走请求（宿主挂在回执上）
  const readForExport = await api({ action: 'read', sessionId: 's1', path: 'exp.drawio' })
  const req = readForExport.payload.export
  ok(req !== null && typeof req.requestId === 'string' && req.format === 'svg', 'read 把导出请求带给客户端：' + JSON.stringify(req))

  // ③ 客户端渲染完回执 → 宿主把 svg 写在 .drawio 旁边
  const svgText = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
  const posted = await api({ action: 'export-result', sessionId: 's1', path: 'exp.drawio', requestId: req.requestId, format: 'svg', ok: true, svg: svgText })
  ok(posted.payload.ok === true && typeof posted.payload.path === 'string' && posted.payload.path.endsWith('.svg'), '回执之后写出 .svg：' + String(posted.payload.path))
  ok(store.get(WORKSPACE + '\\exp.svg') === svgText, 'svg 落在 .drawio 旁边（同名 .svg）：' + String(store.get(WORKSPACE + '\\exp.svg')).slice(0, 40))
  ok(store.get(WORKSPACE + '\\exp.drawio') === beforeExport, '导出过程仍然没碰 .drawio')
  const readDone = await readTool.execute({ path: 'exp.drawio' }, exec)
  ok(readDone.export !== undefined && readDone.export.status === 'done' && String(readDone.export.path).endsWith('.svg'), 'diagram_read 报 done + 文件路径：' + JSON.stringify(readDone.export))

  // ④ png：浏览器直接下载，宿主只记一笔（不写二进制文件）
  const askedPng = await applyTool.execute({ path: 'exp.drawio', ops: [{ op: 'export', format: 'png', name: '架构图' }] }, exec)
  ok(askedPng.export.status === 'pending' && askedPng.export.format === 'png', 'png 导出也是 pending：' + JSON.stringify(askedPng.export))
  const readPng = await api({ action: 'read', sessionId: 's1', path: 'exp.drawio' })
  ok(readPng.payload.export.name === '架构图', '自定义基名带到客户端：' + JSON.stringify(readPng.payload.export))
  await api({ action: 'export-result', sessionId: 's1', path: 'exp.drawio', requestId: readPng.payload.export.requestId, format: 'png', ok: true, downloaded: true })
  const readPngDone = await readTool.execute({ path: 'exp.drawio' }, exec)
  ok(readPngDone.export.status === 'downloaded' && readPngDone.export.format === 'png', 'png 报 downloaded（浏览器下载，不落盘）：' + JSON.stringify(readPngDone.export))
  ok(store.get(WORKSPACE + '\\架构图.png') === undefined && store.get(WORKSPACE + '\\exp.png') === undefined, '宿主没有写 png 文件（二进制走浏览器下载）')

  // ⑤ 渲染失败也要如实报（模型得能告诉用户"这张图没出来"）
  await applyTool.execute({ path: 'exp.drawio', ops: [{ op: 'export', format: 'svg' }] }, exec)
  const readFail = await api({ action: 'read', sessionId: 's1', path: 'exp.drawio' })
  await api({ action: 'export-result', sessionId: 's1', path: 'exp.drawio', requestId: readFail.payload.export.requestId, format: 'svg', ok: false, error: 'canvas 还没准备好' })
  const readFailed = await readTool.execute({ path: 'exp.drawio' }, exec)
  ok(readFailed.export.status === 'failed' && readFailed.export.error.indexOf('canvas') >= 0, '渲染失败如实报 failed + 原因：' + JSON.stringify(readFailed.export))

  // ⑥ 护栏：没有请求时不许写文件；requestId 对不上不许写；空 svg / 带路径的 name 都拒收
  const noPending = await api({ action: 'export-result', sessionId: 's1', path: 'exp.drawio', requestId: 'x', format: 'svg', ok: true, svg: svgText })
  ok(noPending.status === 409, '没有挂着的请求时回执被拒（否则谁都能往工作区写文件）：' + noPending.status)
  await applyTool.execute({ path: 'exp.drawio', ops: [{ op: 'export', format: 'svg' }] }, exec)
  const readStale = await api({ action: 'read', sessionId: 's1', path: 'exp.drawio' })
  const stale = await api({ action: 'export-result', sessionId: 's1', path: 'exp.drawio', requestId: 'nope', format: 'svg', ok: true, svg: svgText })
  ok(stale.status === 409, 'requestId 对不上 → 409（不认旧客户端/乱发的 POST）')
  const emptySvg = await api({ action: 'export-result', sessionId: 's1', path: 'exp.drawio', requestId: readStale.payload.export.requestId, format: 'svg', ok: true, svg: '   ' })
  ok(emptySvg.status === 400, '空 svg → 400')
  let badName = null
  try {
    await apply([{ op: 'export', format: 'svg', name: '../逃逸' }], { path: 'exp.drawio' })
  } catch (error) {
    badName = String(error && error.message)
  }
  ok(badName !== null && badName.indexOf('基名') >= 0, 'name 带路径分隔符 → 报错（导出只落在 .drawio 旁边）：' + String(badName).slice(0, 70))
  let badFormat = null
  try {
    await apply([{ op: 'export', format: 'pdf' }], { path: 'exp.drawio' })
  } catch (error) {
    badFormat = String(error && error.message)
  }
  ok(badFormat !== null && badFormat.indexOf('svg') >= 0, '不支持的格式 → 报错并说明只有 svg/png：' + String(badFormat).slice(0, 70))
}

console.log('\nAI 侧 P2：多步回退、纸张尺寸、按层/按 id 读')
{
  store.clear()
  // ① 多步回退：三次改动 → 退三次，每次退**一层**（不是一次跳回最开始）
  await apply([{ op: 'addNode', label: 'L0', x: 0, y: 0 }], { path: 'rev.drawio' })
  await apply([{ op: 'setLabel', id: 'n1', label: 'L1' }], { path: 'rev.drawio' })
  await apply([{ op: 'setLabel', id: 'n1', label: 'L2' }], { path: 'rev.drawio' })
  await apply([{ op: 'setLabel', id: 'n1', label: 'L3' }], { path: 'rev.drawio' })
  const labelOf = () => parseMxfile(store.get(WORKSPACE + '\\rev.drawio')).doc.nodes[0].label
  const readRev = await readTool.execute({ path: 'rev.drawio' }, exec)
  ok(readRev.revertSteps === 3, '三次改动 → read 报 3 步可退：' + readRev.revertSteps)
  const back1 = await api({ action: 'revert', sessionId: 's1', path: 'rev.drawio' })
  ok(back1.payload.ok === true && back1.payload.stepsLeft === 2, '退一步之后剩两步：' + String(back1.payload.stepsLeft))
  ok(labelOf() === 'L2', '退回的是**上一步**（L2），不是最开始：' + labelOf())
  await api({ action: 'revert', sessionId: 's1', path: 'rev.drawio' })
  ok(labelOf() === 'L1', '再退一步 → L1：' + labelOf())
  await api({ action: 'revert', sessionId: 's1', path: 'rev.drawio' })
  ok(labelOf() === 'L0', '再退一步 → L0（新建时的样子）：' + labelOf())
  const readRevEnd = await readTool.execute({ path: 'rev.drawio' }, exec)
  ok(readRevEnd.canRevert === false && readRevEnd.revertSteps === 0, '退干净之后没有可退的了')
  ok(store.get(WORKSPACE + '\\rev.drawio') === buildMxfile(parseMxfile(store.get(WORKSPACE + '\\rev.drawio')).doc).text, '退回去的文件本身是干净的（能被重新生成）')

  // ② 纸张尺寸：文件里写了就报出来（AI 做布局/导出建议要看它）
  const autoPage = await readTool.execute({ path: 'rev.drawio' }, exec)
  ok(autoPage.page !== undefined && autoPage.page.w === 850 && autoPage.page.h === 1100, '新建的画布报 drawio 缺省纸张：' + JSON.stringify(autoPage.page))
  const wideFile =
    '<mxfile host="app.diagrams.net">\n' +
    '  <diagram id="p1" name="Page-1">\n' +
    '    <mxGraphModel dx="0" dy="0" pageWidth="1200" pageHeight="800"><root>\n' +
    '      <mxCell id="0" />\n' +
    '      <mxCell id="1" parent="0" />\n' +
    '      <mxCell id="n1" value="A" style="" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry" /></mxCell>\n' +
    '    </root></mxGraphModel>\n' +
    '  </diagram>\n' +
    '</mxfile>\n'
  store.set(WORKSPACE + '\\wide.drawio', wideFile)
  const wideRead = await readTool.execute({ path: 'wide.drawio' }, exec)
  ok(wideRead.page !== undefined && wideRead.page.w === 1200 && wideRead.page.h === 800, '横版纸张如实报（1200×800）：' + JSON.stringify(wideRead.page))
  ok(applyDocToMxfile(wideFile, parseMxfile(wideFile).doc).text === wideFile, '纸张尺寸不参与写回（原样保存逐字节不变）')

  // ③ 按层 / 按 id 读：大图省上下文，但整张的计数与层表照旧
  await apply(
    [
      { op: 'addLayer', name: '批注', as: 'notes' },
      { op: 'addNode', label: '主体', x: 0, y: 0 },
      { op: 'addNode', label: '备注', x: 0, y: 200, layer: 'notes' },
      { op: 'addEdge', from: 'n1', to: 'n1' },
    ],
    { path: 'big.drawio' },
  )
  const allRead = await readTool.execute({ path: 'big.drawio' }, exec)
  ok(allRead.filtered === undefined && allRead.nodes.length === 2, '不传 layer/ids 时照旧全量（也不带 filtered 标记）')
  const layerRead = await readTool.execute({ path: 'big.drawio', layer: '批注' }, exec)
  ok(layerRead.filtered === true && layerRead.nodes.length === 1 && layerRead.nodes[0].label === '备注', '按层名过滤只看那一层：' + JSON.stringify(layerRead.nodes.map((n) => n.id)))
  ok(layerRead.totalNodes === 2 && layerRead.totalEdges === 1, '过滤时同时报"整张有多少"：' + layerRead.totalNodes + '/' + layerRead.totalEdges)
  ok(layerRead.layers.length === 2, '层表照旧整份回（不然过滤之后不知道自己漏了哪层）')
  const layerById = await readTool.execute({ path: 'big.drawio', layer: allRead.layers[1].id }, exec)
  ok(layerById.nodes.length === 1 && layerById.nodes[0].label === '备注', '按层 id 过滤也一样')
  const idsRead = await readTool.execute({ path: 'big.drawio', ids: ['n1', 'e1'] }, exec)
  ok(idsRead.nodes.length === 1 && idsRead.edges.length === 1 && idsRead.filtered === true, '按 ids 只回那几个单元')
  let badLayer = null
  try {
    await readTool.execute({ path: 'big.drawio', layer: '不存在' }, exec)
  } catch (error) {
    badLayer = String(error && error.message)
  }
  ok(badLayer !== null && badLayer.indexOf('Layers:') >= 0, '读不存在的层 → 报错并列出层表：' + String(badLayer).slice(0, 70))
}

console.log('\nAI 侧：字色（fontColor）—— 节点标签与连线文字都能改')
{
  store.clear()
  await apply(
    [
      { op: 'addNode', label: '甲', x: 0, y: 0 },
      { op: 'addNode', label: '乙', x: 200, y: 0 },
      { op: 'addEdge', from: 'n1', to: 'n2', label: '连起来' },
    ],
    { path: 'fc.drawio' },
  )
  const styleOf = (kind, id) => {
    const d = parseMxfile(store.get(WORKSPACE + '\\fc.drawio')).doc
    const list = kind === 'node' ? d.nodes : d.edges
    return String(list.filter((it) => it.id === id)[0].style)
  }
  // ① 建的时候就带字色（不必先建再补一次 setStyle）
  await apply([{ op: 'addNode', label: '丙', fontColor: '#b85450', x: 0, y: 200 }], { path: 'fc.drawio' })
  ok(styleGet(styleOf('node', 'n3'), 'fontColor', null) === '#b85450', 'addNode 的 fontColor 落到 fontColor 键：' + styleOf('node', 'n3'))
  // ② 调色板名：与画布上"文字换色"取同一支（红 = #b85450），不是填充色 #f8cecc
  await apply([{ op: 'setStyle', id: 'n1', fontColor: 'red' }], { path: 'fc.drawio' })
  ok(styleGet(styleOf('node', 'n1'), 'fontColor', null) === '#b85450', '调色板名按文字色那一支取色（红 → #b85450）：' + styleOf('node', 'n1'))
  ok(styleGet(styleOf('node', 'n1'), 'fillColor', null) === null, '换字色不动填充（两类互不串）')
  // ③ 一次改一组（用户说"这几个字都换成灰的"）
  await apply([{ op: 'setStyle', ids: ['n1', 'n2'], fontColor: '#123456' }], { path: 'fc.drawio' })
  ok(
    styleGet(styleOf('node', 'n1'), 'fontColor', null) === '#123456' && styleGet(styleOf('node', 'n2'), 'fontColor', null) === '#123456',
    'ids 批量换字色：' + styleOf('node', 'n2'),
  )
  // ④ 连线上的文字也吃它（边自己的 value）
  await apply([{ op: 'addEdge', from: 'n2', to: 'n3', label: '虚线', fontColor: '#82b366' }], { path: 'fc.drawio' })
  await apply([{ op: 'setStyle', id: 'e1', fontColor: 'blue' }], { path: 'fc.drawio' })
  ok(styleGet(styleOf('edge', 'e2'), 'fontColor', null) === '#82b366', 'addEdge 的 fontColor：' + styleOf('edge', 'e2'))
  ok(styleGet(styleOf('edge', 'e1'), 'fontColor', null) === '#6c8ebf', '连线的调色板名也按文字色取（蓝 → #6c8ebf）：' + styleOf('edge', 'e1'))
  ok(styleGet(styleOf('edge', 'e1'), 'strokeColor', null) === null, '换连线字色不动线本身颜色')
  // ⑤ null / 'plain' = 删键回缺省（不留 fontColor=#000000 这种噪音）
  await apply([{ op: 'setStyle', id: 'n1', fontColor: null }], { path: 'fc.drawio' })
  await apply([{ op: 'setStyle', id: 'e1', fontColor: 'plain' }], { path: 'fc.drawio' })
  ok(styleGet(styleOf('node', 'n1'), 'fontColor', null) === null, 'fontColor:null 删键（回缺省黑字）')
  ok(styleGet(styleOf('edge', 'e1'), 'fontColor', null) === null, "'plain' 同样是删键")
  // 读回来能看见（AI 自查"现在字是什么颜色"）
  const fcRead = await readTool.execute({ path: 'fc.drawio' }, exec)
  ok(
    String(fcRead.nodes.filter((n) => n.id === 'n3')[0].style).indexOf('fontColor=#b85450') >= 0,
    'diagram_read 回得到字色（style 原样）：' + fcRead.nodes.filter((n) => n.id === 'n3')[0].style,
  )
  ok(fcRead.nodes.filter((n) => n.id === 'n3')[0].fontColor === 'red', '派生的 fontColor 给**调色板名**（AI 能原样回喂）：' + String(fcRead.nodes.filter((n) => n.id === 'n3')[0].fontColor))
  ok(fcRead.nodes.filter((n) => n.id === 'n2')[0].fontColor === '#123456', '认不出的字色给十六进制：' + String(fcRead.nodes.filter((n) => n.id === 'n2')[0].fontColor))
  ok(fcRead.nodes.filter((n) => n.id === 'n1')[0].fontColor === undefined, '缺省黑字不报（与派生 color 的规矩一致）')
  ok(fcRead.edges.filter((e) => e.id === 'e2')[0].fontColor === 'green', '连线的字色也派生出来（#82b366 = 调色板的绿）：' + String(fcRead.edges.filter((e) => e.id === 'e2')[0].fontColor))
  // ⑥ 写错颜色名要报错，而不是静默写一个 drawio 不认的字面值
  let badColor = null
  try {
    await apply([{ op: 'setStyle', id: 'n1', fontColor: 'gren' }], { path: 'fc.drawio' })
  } catch (error) {
    badColor = String(error && error.message)
  }
  ok(badColor !== null && badColor.indexOf('palette name') >= 0, '认不出的颜色名 → 报错并提示可用写法：' + String(badColor).slice(0, 80))
  let badColorAtCreate = null
  try {
    await apply([{ op: 'addNode', label: 'x', fontColor: 'nope' }], { path: 'fc.drawio' })
  } catch (error) {
    badColorAtCreate = String(error && error.message)
  }
  ok(badColorAtCreate !== null && badColorAtCreate.indexOf('font color') >= 0, 'addNode 上写错也一样在写盘之前报错')
  // ⑦ 两边同一个名字必须是同一个颜色：画布上的「字色」走内核 styleWithTextColorName，
  //    AI 走宿主糖 fontColorValue —— 两处若各取一支（fill 还是 stroke），同一个"红"会是两种颜色。
  const uiRed = styleGet(styleWithTextColorName('', 'red'), 'fontColor', null)
  const uiPlain = styleGet(styleWithTextColorName('fontColor=#b85450', 'plain'), 'fontColor', null)
  ok(uiRed === '#b85450' && uiPlain === null, '（前提）画布那一侧：红 = #b85450、默认 = 删键')
  await apply([{ op: 'setStyle', id: 'n1', fontColor: 'red' }], { path: 'fc.drawio' })
  ok(styleGet(styleOf('node', 'n1'), 'fontColor', null) === uiRed, 'AI 的 fontColor:"red" 与画布上「字色：红」写的是同一个值：' + uiRed)
}

console.log('\nAI 侧：「看一眼」画布效果图（图片走附件通道，工作区零文件）')
{
  // 这一节要附件服务与 llm 服务，而主 ctx 故意没有它们。两种 ctx 都测：
  //   · 没有附件服务 → 明确说"看不了图"，其余功能照旧（不抛错）；
  //   · 有附件服务 → 请求 → 回执 → 下一次 read 带 image 块，且**工作区一个文件都不多**。
  const savedShots = []
  const baseServices = {
    attachments: {
      imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 4000000, maxMessageImageBytes: 4000000, maxImageDimension: 4000, maxImagePixels: 16000000 },
      async saveImage(input) {
        savedShots.push(input)
        return { attachmentId: 'sha256:shot', mediaType: input.mediaType, bytes: input.data.length, width: 800, height: 600, name: input.name }
      },
    },
    llm: {
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] }
      },
    },
  }
  /** 造一个带假附件/llm 服务的实例：返回它的工具与它的 api（注册表按名字覆盖，所以取最新的那个）。 */
  function lookInstance(overrides) {
    const services = Object.assign({}, baseServices, overrides === undefined ? {} : overrides)
    const instanceCtx = Object.assign({}, ctx, {
      get(name) {
        return services[name]
      },
    })
    mod.apply(instanceCtx)
    const instanceRoute = routes[routes.length - 1]
    const apiN = async (bodyObject) => {
      const res = fakeRes()
      await instanceRoute.handler(fakeReq(bodyObject), res)
      return JSON.parse(res.body)
    }
    return { api: apiN, read: tools.get('diagram_read') }
  }
  const execLook = { agent: { id: 's1', options: { provider: 'deepseek', model: 'vision' } } }
  const pngBase64 = Buffer.from('fake-png-bytes-for-test').toString('base64')

  store.clear()
  await apply([{ op: 'addNode', label: '看一眼', x: 0, y: 0 }], { path: 'look.drawio' })
  const beforeLook = store.get(WORKSPACE + '\\look.drawio')
  const filesBefore = Array.from(store.keys()).sort().join('|')

  // ① 没有附件服务的部署：给一句人话，不抛错、也不写文件
  const bare = lookInstance({ attachments: undefined, llm: undefined })
  const bareRead = await bare.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(bareRead.look !== undefined && bareRead.look.status === 'unsupported', '没装附件服务 → look.status=unsupported：' + JSON.stringify(bareRead.look))
  ok(bareRead.image === undefined, '看不了图时不塞 image 字段')
  ok(Array.from(store.keys()).sort().join('|') === filesBefore, '看不了图也不写任何文件')

  // ② 模型不声明图片输入：同样明说（而不是发一张它读不了的图）
  const textOnly = lookInstance({ llm: { async resolveModelInfo() { return { inputModalities: ['text'] } } } })
  const textOnlyRead = await textOnly.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(
    textOnlyRead.look.status === 'unsupported' && String(textOnlyRead.look.error).indexOf('图片输入') >= 0,
    '模型不支持图片 → 明确说清：' + JSON.stringify(textOnlyRead.look),
  )

  // ③ 正常路径：第一次 read 挂请求（pending），画布渲染回执之后第二次 read 带图
  const live = lookInstance()
  const asked = await live.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(asked.look !== undefined && asked.look.status === 'pending', '第一次 render:true → pending（渲染在画布那一半做）：' + JSON.stringify(asked.look))
  ok(asked.image === undefined, 'pending 时没有图')
  ok(store.get(WORKSPACE + '\\look.drawio') === beforeLook && Array.from(store.keys()).sort().join('|') === filesBefore, '请求看图**不动文件、不建文件**')
  const readPayload = await live.api({ action: 'read', sessionId: 's1', path: 'look.drawio' })
  const renderReq = readPayload.render
  ok(renderReq !== null && typeof renderReq.requestId === 'string', 'read 回执把渲染请求带给客户端：' + JSON.stringify(renderReq))
  ok(readPayload.export === null, '看图请求与导出请求是两条通道（export 仍为 null）')

  const posted = await live.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: renderReq.requestId, ok: true, png: pngBase64, width: 800, height: 600 })
  ok(posted.ok === true && posted.bytes === Buffer.from(pngBase64, 'base64').length, '回执收下并交给附件服务：' + JSON.stringify(posted))
  ok(savedShots.length === 1 && savedShots[0].mediaType === 'image/png' && savedShots[0].data.length > 0, '图片存进了附件库（不是工作区）：' + savedShots.length + ' 张，' + savedShots[0].data.length + ' 字节')
  ok(String(savedShots[0].name).endsWith('.png'), '附件名字给了个像样的基名：' + String(savedShots[0].name))
  ok(
    store.get(WORKSPACE + '\\look.drawio') === beforeLook && Array.from(store.keys()).sort().join('|') === filesBefore,
    '**工作区零文件**：回执之后 store 里还是原来那些 key（没有 .png/.svg）',
  )

  const looked = await live.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(looked.look.status === 'ready' && looked.look.stale === undefined, '第二次 render:true → ready（且不是过期图）：' + JSON.stringify(looked.look))
  ok(looked.image !== undefined && looked.image.attachmentId === 'sha256:shot', 'image 字段带回附件引用：' + JSON.stringify(looked.image))
  // 真正给模型看的东西是 **render 的输出块**：这里直接调它，确认第二块是 image
  const blocks = live.read.output.render({ path: 'look.drawio', render: true }, looked)
  ok(Array.isArray(blocks) && blocks.length === 2 && blocks[0].type === 'text', 'render 输出：一段文字 + 一张图')
  ok(blocks[1].type === 'image' && blocks[1].attachment.attachmentId === 'sha256:shot', '第二块是 image 内容块（模型就是这么"看见"的）：' + JSON.stringify(blocks[1].attachment))

  // ④ 取走即清：模型看过就不再重复塞给它
  const again = await live.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(again.image === undefined && again.look.status === 'pending', '图取走即清：再要一次要重新渲染（不会反复塞同一张）')

  // ⑤ 渲染期间文件被改过 → 仍然给图，但**如实标注**它可能过期
  const req2 = (await live.api({ action: 'read', sessionId: 's1', path: 'look.drawio' })).render
  await live.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: req2.requestId, ok: true, png: pngBase64, width: 800, height: 600 })
  await apply([{ op: 'setLabel', id: 'n1', label: '改过了' }], { path: 'look.drawio' })
  const staleRead = await live.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(staleRead.look.status === 'ready' && staleRead.look.stale === true, '渲染之后文件又被改过 → look.stale=true（不假装是最新的）')
  ok(staleRead.image !== undefined, '过期图仍然给（附了说明，比不给更有用）')

  // ⑥ 渲染失败要如实回给模型（否则永远 pending）
  await live.read.execute({ path: 'look.drawio', render: true }, execLook)
  const req3 = (await live.api({ action: 'read', sessionId: 's1', path: 'look.drawio' })).render
  await live.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: req3.requestId, ok: false, error: '画布还没渲染' })
  const failedRead = await live.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(failedRead.look.status === 'failed' && String(failedRead.look.error).indexOf('画布') >= 0, '渲染失败 → look.status=failed + 原因：' + JSON.stringify(failedRead.look))
  ok(failedRead.image === undefined, '失败时不带图')

  // ⑦ 护栏：没挂请求不许回执；requestId 对不上不许回执；空图 / 超大图 / 不接受的类型都拒收
  const noPending = await live.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: 'x', ok: true, png: pngBase64 })
  ok(noPending.ok !== true, '没有挂着的请求 → 拒收（否则谁都能往附件库里塞图）：' + JSON.stringify(noPending))
  await live.read.execute({ path: 'look.drawio', render: true }, execLook)
  const liveReq = (await live.api({ action: 'read', sessionId: 's1', path: 'look.drawio' })).render
  const stale = await live.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: 'nope', ok: true, png: pngBase64 })
  ok(stale.ok !== true, 'requestId 对不上 → 拒收')
  const emptyPng = await live.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: liveReq.requestId, ok: true, png: '   ' })
  ok(emptyPng.ok !== true, '空图 → 拒收：' + JSON.stringify(emptyPng))

  const tinyLimits = lookInstance({ attachments: Object.assign({}, baseServices.attachments, { imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 8 } }) })
  await tinyLimits.read.execute({ path: 'look.drawio', render: true }, execLook)
  const tinyReq = (await tinyLimits.api({ action: 'read', sessionId: 's1', path: 'look.drawio' })).render
  const tooBig = await tinyLimits.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: tinyReq.requestId, ok: true, png: pngBase64 })
  ok(tooBig.ok !== true && String(tooBig.error).indexOf('too large') >= 0, '超过部署图片上限 → 拒收并说明：' + String(tooBig.error))
  const afterTooBig = await tinyLimits.read.execute({ path: 'look.drawio', render: true }, execLook)
  ok(afterTooBig.look.status === 'failed', '超限之后是 failed（模型知道这条路走不通，而不是永远 pending）')

  const noPng = lookInstance({ attachments: Object.assign({}, baseServices.attachments, { imageLimits: { mediaTypes: ['image/jpeg'], maxImageBytes: 4000000 } }) })
  await noPng.read.execute({ path: 'look.drawio', render: true }, execLook)
  const jpegReq = (await noPng.api({ action: 'read', sessionId: 's1', path: 'look.drawio' })).render
  const wrongType = await noPng.api({ action: 'render-result', sessionId: 's1', path: 'look.drawio', requestId: jpegReq.requestId, ok: true, png: pngBase64 })
  ok(wrongType.ok !== true && String(wrongType.error).indexOf('not accepted') >= 0, '部署不接受 png → 提前拒收：' + String(wrongType.error))
}

console.log('\nclearPoints 不许把"悬空端的落点"一起删掉（独立线会整条消失）')
{
  // 真实事故：给一条"两端都是自由点"的独立线（画好的猫尾巴）发 setStyle{clearPoints:true}，
  // 自由端点被删 → 这条边一个落点都不剩 → 写回按"两端都没有落点的边"整条跳过 → 线上就没了。
  store.clear()
  await apply(
    [
      { op: 'addNode', label: 'A', x: 0, y: 0 },
      { op: 'addNode', label: 'B', x: 300, y: 0 },
      { op: 'addEdge', fromPoint: { x: 600, y: 600 }, toPoint: { x: 700, y: 600 }, line: 'curved' },
    ],
    { path: 'clr.drawio' },
  )
  const freeId = parseMxfile(store.get(WORKSPACE + '\\clr.drawio')).doc.edges[0].id
  const cleared = await apply([{ op: 'setStyle', id: freeId, clearPoints: true }], { path: 'clr.drawio' })
  const afterClear = parseMxfile(store.get(WORKSPACE + '\\clr.drawio')).doc
  ok(afterClear.edges.length === 1 && afterClear.edges[0].id === freeId, '独立线清折点之后**还在**（不再整条消失）：' + afterClear.edges.length + ' 条边')
  ok(
    afterClear.edges[0].sourcePoint !== undefined && afterClear.edges[0].targetPoint !== undefined,
    '两端的自由点被保住（它们不是折点，是落点）：' + JSON.stringify([afterClear.edges[0].sourcePoint, afterClear.edges[0].targetPoint]),
  )
  ok(afterClear.edges[0].points === undefined, '折点（那根弓形的中点）确实清掉了')
  ok(String(cleared.summary).indexOf('已略过') < 0, '也没有"已略过"那种损失提示')

  // 有真实顶点的那一端：自由点是过期数据，照旧该删；另一端悬空的照旧保住
  await apply([{ op: 'setEdge', id: freeId, from: 'n1' }], { path: 'clr.drawio' })
  await apply([{ op: 'setStyle', id: freeId, clearPoints: true }], { path: 'clr.drawio' })
  const mixed = parseMxfile(store.get(WORKSPACE + '\\clr.drawio')).doc.edges.filter((e) => e.id === freeId)[0]
  ok(mixed !== undefined && mixed.from === 'n1' && mixed.sourcePoint === undefined, '一端接节点、一端悬空：接节点那端的自由点被清掉')
  ok(mixed.targetPoint !== undefined, '悬空端的自由点照旧留着（否则这一端就没了）')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
