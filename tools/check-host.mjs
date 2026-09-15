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
import { DEFAULT_EDGE_STYLE, edgeFreePoint, formatStyle, parseStyle, styleGet, styleWithSide } from '../src/style-kernel.js'
// 夹具与断言都用**源文件**的编解码：check-host 打的是 lib/index.js（产物），两边必须同源。
import { buildMxfile, contentHash, parseMxfile } from '../src/mxfile.js'

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
    for (const field of ['id', 'from', 'to', 'label', 'style', 'dash', 'arrow', 'color', 'exit', 'entry', 'points', 'sourcePoint', 'targetPoint']) {
      ok(edgeProps[field] !== undefined, 'edges schema 声明了 ' + field)
    }
    const nodeProps = readSchema.properties.nodes.items.properties
    for (const field of ['id', 'label', 'shape', 'style']) {
      ok(nodeProps[field] !== undefined, 'nodes schema 声明了 ' + field)
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


{
  seed(baseDoc())
  const beforeLayout = current().nodes.map((n) => n.x)
  await apply([{ op: 'addNode', label: '新' }])
  const doc = current()
  ok(doc.nodes.map((n) => n.x).join(',') !== beforeLayout.join(','), '未 pinned 的文档：默认自动布局（坐标被重排）')
  ok(doc.meta.pinned === false, '未 pinned 的文档不会被凭空打上 pinned')
}

console.log('\n连线的画法：dash / arrow / color 落成 drawio 的 style 键')
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

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
