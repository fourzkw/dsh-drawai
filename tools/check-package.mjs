/**
 * 安装前烟测 —— 不需要 DSH 在跑，也不修改任何东西。
 *
 * 验证两件在"装进 profile 之后才发现"会很贵的事：
 *   1. 宿主半边能否被 Node 真正 import（ESM 形式、依赖是否可解析）
 *   2. defineTool 是否接受本包声明的参数/输出 schema（DSH 的 schema DSL 很严格）
 *
 * 依赖 @deepseek-ai/dsh-tools 可解析：在 profile 里安装后天然满足；
 * 在工作区里跑需要先把它链进来，例如：
 *   New-Item -ItemType Junction -Path node_modules\@deepseek-ai\dsh-tools `
 *     -Target <DSH>\node_modules\@deepseek-ai\dsh-tools
 *
 * 用法：node tools/check-package.mjs
 */

import { readFileSync } from 'node:fs'
import { composeClientBody, dedentBody, extractBody } from './build.mjs'

const EXPECTED_INJECT = ['tools', 'fs', 'sessions', 'sandboxPolicy', 'webServer']
const EXPECTED_TOOLS = ['diagram_read', 'diagram_apply']
const EXPECTED_ROUTE = '/drawai/api/save'

let failures = 0

function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  console.log(`  [${mark}] ${label}${detail === undefined ? '' : ' — ' + detail}`)
}

console.log('dsh-drawai 安装前烟测\n')

console.log('[0] lib/ 是否与 src/ 同步（防止改了源文件忘了构建）')
try {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  check('客户端 bundle 的 body 与 src（样式内核 + client.js）一致', dedentBody(extractBody(bundle)) === composeClientBody())
  // 内核单源两用：客户端那份必须是内联进去的，不是另抄了一份。
  check('样式内核确实内联进了客户端 bundle', bundle.includes('function parseStyle') && bundle.includes('function normalizeDrawioDoc'))
  const kernelLib = readFileSync(new URL('../lib/style-kernel.js', import.meta.url), 'utf8')
  const kernelSrc = readFileSync(new URL('../src/style-kernel.js', import.meta.url), 'utf8')
  check('lib/style-kernel.js 含 src/style-kernel.js', kernelLib.includes(kernelSrc))
  const mxLib = readFileSync(new URL('../lib/mxfile.js', import.meta.url), 'utf8')
  const mxSrc = readFileSync(new URL('../src/mxfile.js', import.meta.url), 'utf8')
  check('lib/mxfile.js 含 src/mxfile.js', mxLib.includes(mxSrc))
  // mxfile 只在宿主半边用（要 node:zlib）：漏拷会让 lib/index.js 直接 import 失败。
  check('mxfile 没有混进客户端 bundle（浏览器没有 zlib）', bundle.includes('deflateRawSync') === false)
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const hostSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  check('lib/index.js 含 src/index.js', host.includes(hostSource))
} catch (error) {
  check('可读取 lib/ 与 src/', false, error && error.message ? error.message : String(error))
}

let mod
try {
  mod = await import('../lib/index.js')
} catch (error) {
  console.log('  [FAIL] 无法 import lib/index.js')
  console.log('         ' + (error && error.message ? error.message : String(error)))
  console.log('\n  提示：本机若未安装本包，@deepseek-ai/dsh-tools 不可解析。')
  console.log('        工作区内自测请先建 node_modules/@deepseek-ai/dsh-tools junction。')
  process.exit(1)
}

console.log('[1] 宿主半边导出形状')
check('export name', mod.name === 'drawai', String(mod.name))
check('export apply 是函数', typeof mod.apply === 'function')
check('export inject 与预期一致', JSON.stringify(mod.inject) === JSON.stringify(EXPECTED_INJECT), JSON.stringify(mod.inject))

console.log('\n[2] apply() 能否注册工具与写回路由（假 ctx，无副作用）')
const registered = []
const routes = []
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  fs: {},
  sessions: {},
  sandboxPolicy: {},
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

try {
  mod.apply(ctx)
} catch (error) {
  check('apply 未抛错', false, error && error.message ? error.message : String(error))
}

const names = registered.map((tool) => tool.name)
check('注册了两个工具', registered.length === 2, names.join(', '))
for (const expected of EXPECTED_TOOLS) {
  check('注册了 ' + expected, names.includes(expected))
}

// 写回路由是人工编辑的唯一落盘通道，注册不上就等于 M1 白做。
check('注册了写回路由', routes.length === 1, routes.map((route) => route.kind + ' ' + route.path).join(', '))
check('路由是 ' + EXPECTED_ROUTE, routes.some((route) => route.path === EXPECTED_ROUTE))
check('路由 handler 是函数', routes.every((route) => typeof route.handler === 'function'))

console.log('\n[3] 编译后的参数 schema')
for (const tool of registered) {
  const schema = tool.parameters
  const props = schema && schema.properties ? Object.keys(schema.properties) : []
  check(tool.name + ' 有 properties', props.length > 0, props.join(', '))
  if (tool.name === 'diagram_apply') {
    const required = Array.isArray(schema.required) ? schema.required : []
    check('diagram_apply 的 ops 是必填', required.includes('ops'), 'required=' + JSON.stringify(required))
    const layout = schema.properties.layout
    check('diagram_apply 的 layout 有 enum', layout !== undefined && Array.isArray(layout.enum), layout === undefined ? 'missing' : JSON.stringify(layout.enum))
  }
}

console.log('\n' + (failures === 0 ? '全部通过。' : failures + ' 项失败。'))
process.exit(failures === 0 ? 0 : 1)
