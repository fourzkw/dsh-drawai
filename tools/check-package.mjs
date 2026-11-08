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

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { composeClientBody, dedentBody, extractBody } from './build.mjs'

const EXPECTED_INJECT = ['tools', 'fs', 'sessions', 'sandboxPolicy', 'webServer']
const EXPECTED_TOOLS = ['shotcraft_search', 'mg_style', 'audio_asset', 'diagram_read', 'motion_task', 'motion_project', 'motion_spec', 'motion_preview', 'motion_render', 'motion_qa', 'motion_export', 'motion_assets', 'motion_sfx', 'motion_audio', 'motion_sync', 'motion_audio_verify', 'motion_voice', 'diagram_apply']
const EXPECTED_ROUTE = '/drawai/api/save'
const EXPECTED_DIAGNOSTICS = '/drawai/api/diagnostics'

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
  for (const name of ['video-export', 'video-export-worker', 'drawing-tasks', 'drawing-runner', 'drawing-results', 'task-coordinator', 'task-patches']) {
    const source = readFileSync(new URL('../src/' + name + '.js', import.meta.url), 'utf8')
    const built = readFileSync(new URL('../lib/' + name + '.js', import.meta.url), 'utf8')
    check('lib/' + name + '.js 与宿主源码一致', built.includes(source))
  }
  check('SVG 宿主渲染器没有混进浏览器 bundle', !bundle.includes('@resvg/resvg-js'))
  for (const name of ['router.js', 'node-runtime.js', 'NOTICE.md', 'vendor/libavoid.min.js', 'vendor/libavoid-routing.js', 'vendor/LICENSE', 'vendor/DRAWIO-LICENSE']) {
    const source = readFileSync(new URL('../src/routing/' + name, import.meta.url))
    const built = readFileSync(new URL('../lib/routing/' + name, import.meta.url))
    check('路由引擎及许可已打包：' + name, source.equals(built))
  }
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
check('注册工具集合与声明一致', registered.length === EXPECTED_TOOLS.length && names.every(name => EXPECTED_TOOLS.includes(name)), names.join(', '))
for (const expected of EXPECTED_TOOLS) {
  check('注册了 ' + expected, names.includes(expected))
}
// execute() alone never exercises defineTool's captured userRender callback.
try {
  const tool = registered.find((item) => item.name === 'motion_task')
  const blocks = tool.output.render({ action: 'status' }, { summary: '视频任务：error', details: '{"error":"max-tokens"}' })
  check('motion_task 状态输出能经过真实 SDK render', blocks[0]?.type === 'text' && blocks[0].text.includes('max-tokens'))
} catch (error) {
  check('motion_task 状态输出能经过真实 SDK render', false, error.message)
}

// 写回路由是人工编辑的唯一落盘通道，注册不上就等于 M1 白做。
check('注册了写回路由', routes.some((route) => route.kind === 'exact' && route.path === EXPECTED_ROUTE), routes.map((route) => route.kind + ' ' + route.path).join(', '))
check('路由是 ' + EXPECTED_ROUTE, routes.some((route) => route.path === EXPECTED_ROUTE))
check('路由 handler 是函数', routes.every((route) => typeof route.handler === 'function'))

// 诊断路由是 issue #8 的取证通道：工具全没时，它必须能自己说出"注册上了哪几个"。
const diagnostics = routes.find((route) => route.path === EXPECTED_DIAGNOSTICS)
check('注册了诊断路由', diagnostics !== undefined && diagnostics.kind === 'exact')
if (diagnostics !== undefined) {
  let body = null
  diagnostics.handler({ method: 'GET', headers: {}, url: EXPECTED_DIAGNOSTICS }, { writeHead() {}, end(chunk) { body = chunk } })
  let payload = null
  try { payload = JSON.parse(body) } catch (error) { payload = null }
  const detail = payload === null ? String(body).slice(0, 160) : JSON.stringify(payload.registered)
  check('诊断路由报出全部已注册工具', payload !== null && Array.isArray(payload.registered)
    && payload.registered.length === EXPECTED_TOOLS.length
    && EXPECTED_TOOLS.every((name) => payload.registered.includes(name)), detail)
  check('诊断路由报出 tools 服务可用', payload !== null && payload.toolsService === true, payload === null ? 'no body' : String(payload.toolsService))
  check('诊断路由报出无失败/无挂起', payload !== null && Array.isArray(payload.failed) && Array.isArray(payload.pending)
    && payload.failed.length === 0 && payload.pending.length === 0, payload === null ? 'no body' : JSON.stringify({ failed: payload.failed, pending: payload.pending }))
}

console.log('\n[3] 编译后的参数 schema')
for (const tool of registered) {
  const schema = tool.parameters
  const props = schema && schema.properties ? Object.keys(schema.properties) : []
  check(tool.name + ' 有 properties', props.length > 0, props.join(', '))
  // 参数必须带真实类型：`type: 'json'` 在 DSL 里只是注解，编译后连 `type` 都没有，
  // 模型就不知道 `frames` 该传数组（issue #14）。这里守住"每个参数不是 type 就是 oneOf"。
  const untyped = props.filter((name) => {
    const spec = schema.properties[name]
    return spec === null || typeof spec !== 'object' || (spec.type === undefined && spec.oneOf === undefined)
  })
  check(tool.name + ' 的参数都声明了类型（type 或 oneOf）', untyped.length === 0, untyped.join(', ') || 'ok')
  if (tool.name === 'diagram_apply') {
    const required = Array.isArray(schema.required) ? schema.required : []
    check('diagram_apply 的 ops 是必填', required.includes('ops'), 'required=' + JSON.stringify(required))
    check('diagram_apply 的 path 是必填', required.includes('path'), 'required=' + JSON.stringify(required))
    const layout = schema.properties.layout
    check('diagram_apply 的 layout 有 enum', layout !== undefined && Array.isArray(layout.enum), layout === undefined ? 'missing' : JSON.stringify(layout.enum))
  }
}

console.log('\n[4] 内嵌技能：换了电脑、只装了插件时模型怎么知道该怎么做')
{
  // 工具描述会随 lib/index.js 一起装到任何机器上，但 README / 源码 / tools 都不会跟着走
  // （package.json.files 只有 lib 与 cordis.patch.yml）。所以"怎么用"必须**注册成技能**：
  // 技能目录里出现一条简介，模型需要时取全文。
  //
  // 上面那个假 ctx 故意**没有** get()，为的是验证"没有 skill 注册表时照样能用"（没抛错）。
  const skills = []
  let disposed = 0
  const withSkills = Object.assign({}, ctx, {
    get(name) {
      if (name !== 'skills') return undefined
      return {
        register(skill) {
          skills.push(skill)
          return () => {
            disposed += 1
          }
        },
      }
    },
  })
  let threw = null
  try {
    mod.apply(withSkills)
  } catch (error) {
    threw = error && error.message ? error.message : String(error)
  }
  check('装了 skill 注册表时 apply 不抛错', threw === null, String(threw))
  check('注册了恰好一个技能', skills.length === 1, '实际 ' + skills.length)
  const skill = skills[0] || {}
  check('技能名是 kebab-case', typeof skill.name === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.name), String(skill.name))
  check('技能有简介（目录里显示这一段）', typeof skill.description === 'string' && skill.description.length > 20, String(skill.description).slice(0, 40))
  check('技能有 whenToUse（什么时候该取它）', typeof skill.whenToUse === 'string' && skill.whenToUse.length > 10, String(skill.whenToUse).slice(0, 40))
  // source 不能省：注册表在**取全文**时会再跑一次 validateDefinition，那里要求 source 是字符串。
  check('技能带 source: runtime（少了它取全文时会抛 source must be a string）', skill.source === 'runtime', String(skill.source))
  check('技能带 content（正文就是它）', typeof skill.content === 'string', typeof skill.content)
  const body = typeof skill.content === 'string' ? skill.content : ''
  check('正文够长（是一份说明，不是一行）', body.length > 1500, body.length + ' 字符')
  // 关键字是"这份说明有没有随插件一起发出去"的最低保证：换了电脑、只装了 lib/ 时，
  // 模型能依仗的就只有它。新增能力（比如选区、乐观锁）必须在这里留一条，否则删掉了也没人发现。
  for (const needle of ['.drawio', 'diagram_read', 'diagram_apply', 'addNode', 'addEdge', 'setStyle', 'remove', 'move', 'highlight', 'fromPoint', 'canRevert', 'layout', 'pinned', 'from === to', 'layers', '无损', '别直接改', 'selection', 'expectRevision', 'created', 'as', 'setEdge', 'setLabelPos', 'order', 'duplicate', 'addLayer', 'setLayer', 'export', 'revertSteps', '纸张', 'filtered', 'fontColor', 'render:true']) {
    check('正文讲了 ' + needle, body.indexOf(needle) >= 0)
  }
  check('注册走的是 Cordis effect（能被卸载）', disposed === 0 && skills.length === 1, 'disposer 还没被调用')
}

console.log('\n[5] tools 服务晚于 apply 就绪（issue #8 的现场：apply 跑了、工具全没）')
{
  // 真实 DSH 里 tools 未必在 apply 那一刻就 ACTIVE；那时 register 会被静默丢掉。
  // 所以要挂起、等 ctx.inject(['tools']) 的回调再补注册 —— 这条路不测就等于没修。
  const lateRegistered = []
  let flushTools = null
  const lateCtx = Object.assign({}, ctx)
  delete lateCtx.tools
  lateCtx.inject = function (deps, callback) {
    check('等的是 tools 服务', JSON.stringify(deps) === JSON.stringify(['tools']), JSON.stringify(deps))
    flushTools = callback
    return () => {}
  }
  let threw = null
  try {
    mod.apply(lateCtx)
  } catch (error) {
    threw = error && error.message ? error.message : String(error)
  }
  check('tools 未就绪时 apply 不抛错（抛了会连累后半段）', threw === null, String(threw))
  check('tools 未就绪时先挂起', lateRegistered.length === 0 && typeof flushTools === 'function', '注册 ' + lateRegistered.length + ' / flush ' + typeof flushTools)
  // 模拟服务 ACTIVE：把 tools 装回去再跑回调。
  lateCtx.tools = {
    register(tool) {
      lateRegistered.push(tool)
      return () => {}
    },
  }
  if (typeof flushTools === 'function') flushTools()
  check('tools 就绪后补注册满全部工具', lateRegistered.length === EXPECTED_TOOLS.length, '实际 ' + lateRegistered.length)
  check('补注册的工具名与声明一致', lateRegistered.every((tool) => EXPECTED_TOOLS.includes(tool.name)), lateRegistered.map((tool) => tool.name).join(','))
}

console.log('\n[6] 渲染 worker 传给 Remotion 的浏览器参数名（issue #9）')
{
  // @remotion/renderer 4.x 只认 puppeteerInstance；写成 browserInstance 会被静默忽略，
  // 然后它自己去下载 chrome-headless-shell——内网/无外网机器上必然失败。
  const worker = readFileSync('lib/motion-render-worker.js', 'utf8')
  const wrong = worker.match(/browserInstance\s*:/g) || []
  check('不再用 Remotion 不认的 browserInstance 传浏览器', wrong.length === 0, wrong.length + ' 处')
  const right = worker.match(/puppeteerInstance\s*:/g) || []
  check('五处调用都改用 puppeteerInstance', right.length === 5, right.length + ' 处')
  const fallback = worker.match(/browserExecutable,\s*cancelSignal/g) || []
  check('每次渲染都兜底带 browserExecutable（实例失效也不去联网下载）', fallback.length >= 4, fallback.length + ' 处')
  // issue #22：Mac 上既没有 Windows 那两条候选，也没有 /usr/bin/*，只能干等 Remotion 下载。
  check('浏览器候选覆盖 macOS', /\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome/.test(worker))
  check('浏览器候选覆盖 Linux', /\/usr\/bin\/google-chrome/.test(worker))
  check('没有本机浏览器时先给出提示再下载（不让它看起来像卡死）', /正在下载内置浏览器/.test(worker))
  // issue #26：`.dsh` 带 Low 完整性标签时，里面的 ffmpeg 继承 Low IL，写不了 Medium 的系统
  // %TEMP%；renderMedia 的 pre-encode.mp4 正好写在 os.tmpdir()，正片渲到一半就 Permission denied。
  // 修法只有一条：fork 时把子进程的 TEMP/TMP 指到工程目录。
  const render = readFileSync('lib/motion/render.js', 'utf8')
  check('渲染 worker 的临时目录指到工程里（issue #26）', /TEMP:\s*tempDirectory/.test(render) && /TMP:\s*tempDirectory/.test(render))
  check('工程里的 .out/tmp 会先建好再 fork', /mkdirSync\(tempDirectory,\s*\{\s*recursive:\s*true\s*\}\)/.test(render))
}

console.log('\n[7] json 参数兼容（宿主可能把 json 参数按字符串送进来）')
{
  // json 参数编译成 JSON Schema `{}`（没有类型），有的模型/宿主会送 "[0, 120]" 这样的字符串。
  // 不做还原的话 Array.isArray(字符串) 恒假，参数会被静默忽略、退回默认值。
  const host = readFileSync('lib/index.js', 'utf8')
  check('有统一的还原函数', /function jsonValue\(value\)/.test(host) && /function jsonObject\(value\)/.test(host) && /function jsonArray\(value\)/.test(host))
  check('预览的 frames 走 jsonArray', /jsonArray\(args\.frames\)/.test(host))
  check('预览的 crop 走 jsonValue', /jsonValue\(args\.crop\)/.test(host))
  check('渲染的 frames/range 走 jsonArray', /jsonArray\(args\.frames\)/.test(host) && /jsonArray\(args\.range\)/.test(host))
  check('视频规格走 jsonObject', /jsonObject\(args\.spec\)/.test(host))
}

console.log('\n[8] 从 git 克隆能不能构建：routing vendor 必须进版本库（issue #13）')
{
  // `.gitignore` 里的裸 `vendor/` 会在任意层级匹配，把 src/routing/vendor 一起忽略掉；
  // 于是克隆下来第一步构建就 ENOENT（tools/build.mjs:124 要读这两个文件）。
  const ignore = readFileSync('.gitignore', 'utf8')
  check('.gitignore 的 vendor 规则锚定在仓库根', /^\/vendor\/$/m.test(ignore))
  check('没有会连带忽略 src/routing/vendor 的裸 vendor/ 规则', !/^vendor\/$/m.test(ignore))
  const vendorFiles = ['libavoid.min.js', 'libavoid-routing.js']
  for (const file of vendorFiles) {
    const path = 'src/routing/vendor/' + file
    check('构建需要的 ' + path + ' 在磁盘上', readFileSync(path, 'utf8').length > 1000)
  }
  // 磁盘上有还不够：必须在 git 索引里，否则克隆出来仍然没有（npm 包另说，它走 .npmignore）。
  if (existsSync('.git')) {
    const tracked = execFileSync('git', ['ls-files', 'src/routing/vendor', 'lib/routing/vendor'], { encoding: 'utf8' })
    for (const file of vendorFiles) {
      check('git 跟踪了 src/routing/vendor/' + file, tracked.includes('src/routing/vendor/' + file))
    }
  } else {
    console.log('  [SKIP] 这里不是 git 工作区（npm 包安装目录），跳过索引检查')
  }
}

console.log('\n[9] 打包入口落在工程目录里（issue #21/#22）')
{
  // Remotion 的 webpack 只给 .tsx? 挂了 esbuild-loader，.jsx? 那条规则 exclude
  // /node_modules/ —— 插件装在 profile 的 node_modules 下时，入口 JSX 会被当普通
  // 文本解析（"Unexpected token (<AbsoluteFill>)"）。所以入口与 @drawai/motion
  // 都要复制到工程目录再引用。
  const project = readFileSync('lib/motion-project.js', 'utf8')
  check('入口从工程目录里的 entry.gen.jsx 引入', /from '\.\/entry\.gen\.jsx'/.test(project))
  check('@drawai/motion 指向工程目录里的副本', /reference-media\.gen\.jsx/.test(project))
  check('入口不再用插件自己的绝对路径', !/registerMotionRoot.*from \$\{JSON\.stringify\(runtime\)/.test(project))
}


console.log('\n[10] 整片风格 demo 的依赖随包 vendored（issue #27）')
{
  // 上游 demo 的 importmap 指向 /node_modules/*，装到用户机器上时插件根目录没有这些包；
  // 没有 vendored 副本就会直接报「依赖没装在本机」，frames 拿不到参考帧。
  const vendor = 'lib/motion/mgstyles/vendor/modules/'
  const files = [
    'd3/dist/d3.min.js',
    'topojson-client/dist/topojson-client.min.js',
    'opentype.js/dist/opentype.mjs',
    'simplex-noise/dist/esm/simplex-noise.js',
  ]
  for (const file of files) check('随包带了 ' + file, existsSync(vendor + file) && readFileSync(vendor + file).length > 1000)
  const frames = readFileSync('lib/motion/style-frames.js', 'utf8')
  check('缺模块时同时查运行时与 vendored 副本', /VENDOR_MODULES/.test(frames) && /join\(VENDOR_MODULES, relative\)/.test(frames))
  check('静态服务回落到 vendored 副本', /roots\.bundled/.test(frames))
  check('不再把 source 说成等价退路', !/多数情况够用/.test(frames) && /有损降级/.test(frames))
}

console.log('\n' + (failures === 0 ? '全部通过。' : failures + ' 项失败。'))
process.exit(failures === 0 ? 0 : 1)
