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
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

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
const ctx = {
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => {}
    },
  },
  webServer: { register: () => () => {} },
  fs: fs,
  sessions: {
    get(id) {
      return id === 's1' ? SESSION : undefined
    },
  },
  sandboxPolicy: {
    resolve() {
      return { mode: 'workspace-write', workspaceRoot: WORKSPACE }
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
  const args = Object.assign({ path: 'doc.dshd.json', ops: ops }, extra === undefined ? {} : extra)
  return await applyTool.execute(args, exec)
}

/** 直接放一份文档进内存文件系统。 */
function seed(doc) {
  store.set(WORKSPACE + '\\doc.dshd.json', JSON.stringify(doc, null, 2) + '\n')
}

function current() {
  return JSON.parse(store.get(WORKSPACE + '\\doc.dshd.json'))
}

function baseDoc(meta) {
  return {
    version: 1,
    revision: 7,
    meta: meta === undefined ? { engine: 'drawio-svg' } : meta,
    nodes: [
      { id: 'n1', shape: 'rect', style: 'blue', x: 37, y: 211, w: 130, h: 56, label: '一' },
      { id: 'n2', shape: 'rect', style: 'green', x: 411, y: 88, w: 130, h: 56, label: '二' },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', label: '手工连的' }],
  }
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
  ok(after1.meta.layout === 'none', '第一次改图按 pinned 走了 layout=none')
  ok(after1.nodes[0].x === n1Before.x && after1.nodes[0].y === n1Before.y, '第一次改图手坐标未被移动')
  ok(after1.nodes.length === 3, '新节点加上了')

  // 第二次改动：这才是原来会炸的那一步 —— pinned 若已丢失，mode 会回落到 dagre-tb。
  await apply([{ op: 'setLabel', id: 'n1', label: '只改个标签' }])
  const after2 = current()
  ok(after2.meta.pinned === true, '第二次 AI 改图后 meta.pinned 仍在')
  ok(after2.meta.layout === 'none', '第二次改图仍然 layout=none（没被重排）')
  ok(after2.nodes[0].x === n1Before.x && after2.nodes[0].y === n1Before.y, '第二次改图手坐标仍然未被移动（回归点）')
  ok(after2.nodes[0].label === '只改个标签', '标签确实改掉了')

  // 显式要求重排时，pinned 不该拦着。
  await apply([{ op: 'setLabel', id: 'n1', label: 'x' }], { layout: 'dagre-tb' })
  const after3 = current()
  ok(after3.meta.layout === 'dagre-tb', '显式指定 layout 时 pinned 不拦（人想要重排就得重排）')
  ok(after3.meta.pinned === true, '重排之后 pinned 依然保留')
  ok(after3.nodes[0].x !== n1Before.x || after3.nodes[0].y !== n1Before.y, '显式重排确实移动了坐标')
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
    for (const field of ['id', 'from', 'to', 'label', 'dash', 'arrow', 'color']) {
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
  const out = await readTool.execute({ path: 'doc.dshd.json' }, exec)
  const schemaProps = readSchema.properties
  const declaredEdge = schemaProps.edges.items.properties
  const declaredNode = schemaProps.nodes.items.properties
  let undeclared = []
  for (const e of out.edges) for (const k of Object.keys(e)) if (declaredEdge[k] === undefined) undeclared.push('edges[].' + k)
  for (const n of out.nodes) for (const k of Object.keys(n)) if (declaredNode[k] === undefined) undeclared.push('nodes[].' + k)
  ok(undeclared.length === 0, '真实返回值的字段全部在 schema 里（未声明的会被判非法输出：' + (undeclared.join(', ') || '无') + '）')
  ok(out.edges[0].dash === 'dashed' && out.edges[0].arrow === 'both' && out.edges[0].color === '#b85450', '带回的边样式确实是设过的值')
}


{
  seed(baseDoc())
  await apply([{ op: 'addNode', label: '新' }])
  const doc = current()
  ok(doc.meta.layout === 'dagre-tb', '未 pinned 的文档默认 dagre-tb')
  ok(doc.meta.pinned === undefined, '未 pinned 的文档不会被凭空打上 pinned')
}

console.log('\n连线的画法：dash / arrow / color')
{
  seed(baseDoc())
  await apply([{ op: 'addEdge', from: 'n2', to: 'n1', label: '异步', dash: 'dashed', arrow: 'both' }])
  const e2 = current().edges[1]
  ok(e2.dash === 'dashed', 'addEdge 直接带上 dash')
  ok(e2.arrow === 'both', 'addEdge 直接带上 arrow')
  ok(current().edges[0].dash === undefined, '未指定的边不会凭空多出 dash（默认不写冗余字段）')

  await apply([{ op: 'setStyle', id: 'e1', dash: 'dotted', color: '#b85450' }])
  const e1 = current().edges[0]
  ok(e1.dash === 'dotted', 'setStyle 能改连线的 dash')
  ok(e1.color === '#b85450', 'setStyle 能改连线的 color')

  // 归一化：口语说法要能接受，但落盘必须是规范值。
  await apply([{ op: 'setStyle', id: 'e1', dash: '虚线', arrow: '双向' }])
  const e1b = current().edges[0]
  ok(e1b.dash === 'dashed', '"虚线" 归一成 dashed')
  ok(e1b.arrow === 'both', '"双向" 归一成 both')

  // 回到默认 = 删字段，而不是写 'solid'/'end'（文档里不留冗余）。
  await apply([{ op: 'setStyle', id: 'e1', dash: 'solid', arrow: 'end', color: '' }])
  const e1c = current().edges[0]
  ok(e1c.dash === undefined && e1c.arrow === undefined && e1c.color === undefined, '设回默认会删掉这些字段，不留 "solid"/"end" 垃圾')

  // 节点与连线共用 setStyle：节点该走 shape/style 那条路。
  await apply([{ op: 'setStyle', id: 'n1', shape: 'diamond', style: 'orange' }])
  const n1 = current().nodes[0]
  ok(n1.shape === 'diamond' && n1.style === 'orange', 'setStyle 对节点仍然管 shape/style')
}

console.log('\n非法输入必须在写盘之前失败')
{
  seed(baseDoc())
  const before = store.get(WORKSPACE + '\\doc.dshd.json')

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
  ok(store.get(WORKSPACE + '\\doc.dshd.json') === before, '以上全部失败之后，文件一个字节都没变')
  ok(current().revision === 7, 'revision 未被失败的操作推高')

  let emptyThrew = false
  try {
    await apply([])
  } catch (error) {
    emptyThrew = true
  }
  ok(emptyThrew, '空 ops 被拒')
}

console.log('\nrevision 与原子性')
{
  seed(baseDoc())
  ok(current().revision === 7, '起始 revision = 7')
  await apply([{ op: 'setLabel', id: 'n1', label: 'a' }])
  ok(current().revision === 8, '一次成功改图 revision = 8')
  await apply([{ op: 'setLabel', id: 'n1', label: 'b' }, { op: 'setLabel', id: 'n2', label: 'c' }])
  ok(current().revision === 9, '一次调用里多个 ops 只 +1（客户端乐观锁语义）')
  // 一批 ops 里前几条合法、后面一条非法：整批都不该落盘。
  const snapshot = store.get(WORKSPACE + '\\doc.dshd.json')
  let threw = false
  try {
    await apply([{ op: 'setLabel', id: 'n1', label: 'zzz' }, { op: 'remove', id: 'ghost' }])
  } catch (error) {
    threw = true
  }
  ok(threw && store.get(WORKSPACE + '\\doc.dshd.json') === snapshot, '同一批里后面的 op 失败 → 前面已改的也不落盘（全或无）')
  ok(current().nodes[0].label !== 'zzz', '内存里也没有留下半成品')
}

console.log('\n文件不存在时：当作空文档，不报错')
{
  store.clear()
  const result = await apply([{ op: 'addNode', label: '从零开始' }], { path: 'brand-new.dshd.json' })
  ok(result.nodeCount === 1 && result.revision === 1, '空文档上第一个节点 → revision 1')
  const doc = JSON.parse(store.get(WORKSPACE + '\\brand-new.dshd.json'))
  ok(doc.nodes.length === 1 && doc.nodes[0].id === 'n1', 'id 从 n1 开始')
}

console.log('\ndiagram_read 回读')
{
  seed(baseDoc())
  await apply([{ op: 'setStyle', id: 'e1', dash: 'dashed', arrow: 'both', color: '#333' }])
  const read = await readTool.execute({ path: 'doc.dshd.json' }, exec)
  ok(read.revision === 8, 'read 报出正确 revision')
  ok(read.nodes.length === 2 && read.edges.length === 1, 'read 报出节点/边数量')
  const e = read.edges[0]
  ok(e.dash === 'dashed' && e.arrow === 'both' && e.color === '#333', 'read 把边样式一起报出来（AI 改之前看得到现状）')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '（共 ' + checks + ' 项）')
process.exitCode = failures === 0 ? 0 : 1
