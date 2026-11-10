/**
 * dsh-drawai 构建器 —— 零依赖。
 *
 * 职责：
 *   src/index.js        → lib/index.js          加生成标记，其余原样（宿主半边本就是可直接运行的 ESM）
 *   src/style-kernel.js → lib/style-kernel.js   原样拷贝（宿主半边 import 它）
 *   src/style-kernel.js + src/client.js
 *                       → lib/client.js         内核**去掉 export 后内联**进 factory，再套外壳并缩进
 *
 * 为什么内核要内联：客户端 bundle 是单文件 factory，只有一份冻结的 require 表，
 * 不能 import 相对路径的兄弟文件；而宿主半边又必须 import 同一份逻辑。
 * 于是"源只有一份、产物各取所需"，并由 check-package 断言两边确实同源。
 *
 * 不做：语法转换、模块打包、压缩、加时间戳。
 * 时间戳绝不能加 —— dsh-client-hmr 按内容变化判定 rebuilt，时间戳会让每次构建都被当成变更。
 *
 * 用法：node tools/build.mjs     （watch 时由 tools/watch.mjs 直接 import buildAll，不 spawn）
 */
import { readFileSync, writeFileSync, cpSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const GENERATED = '/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */\n'

/** body 在 factory 里的基础缩进（与抽取时去掉的层级一致）。 */
const INDENT = '    '

const CLIENT_TAIL_MARK = INDENT + 'return module.exports'

/** 样式内核的源路径：宿主 import 它，客户端由本构建器内联它。 */
const KERNEL_PATH = 'src/style-kernel.js'

/** mxfile（`.drawio`）编解码的源路径：只给宿主半边用（要 node:zlib）。 */
const MXFILE_PATH = 'src/mxfile.js'

/**
 * 其余**只给宿主半边**的模块：原样拷贝 + 生成横幅。
 *
 * 为什么要有这张表而不是逐个手写：宿主 `lib/index.js` 是**直接 import 相对路径**的
 * （`./raster.js`、`./trace-image.js`），构建器漏拷一个，宿主就会在加载时
 * 抛 MODULE_NOT_FOUND —— 而那一刻插件已经"装好了"，报错在启动期，很难联想到构建。
 * 所以新增这类模块时：源文件放 src/、在这里登记一行，构建器同时做存在性校验。
 */
const HOST_ONLY_MODULES = ['src/ffmpeg-manager.js', 'src/shotcard-core.js', 'src/mgstyle-core.js', 'src/shotcard-reference.js', 'src/motion-session.js', 'src/motion-library.js', 'src/motion-source.js', 'src/motion-project.js', 'src/motion-core.js', 'src/motion-tasks.js', 'src/motion-render-worker.js', 'src/document-core.js', 'src/document-commands.js', 'src/canvas-format.js', 'src/raster.js', 'src/trace-image.js', 'src/media.js', 'src/video-trace-worker.js', 'src/video-trace-pool.js', 'src/video-export.js', 'src/video-export-worker.js', 'src/performance-log.js', 'src/performance-metrics.js', 'src/video-trace-reuse.js', 'src/task-coordinator.js', 'src/task-patches.js', 'src/drawing-tasks.js', 'src/drawing-runner.js', 'src/drawing-results.js', 'src/comfyui-workflow.mjs', 'src/comfyui-default-workflow.mjs', 'src/imagegen.mjs']
HOST_ONLY_MODULES.push('src/motion-capture.js', 'src/motion-film-review.js', 'src/motion-agent-protocol.js', 'src/motion-agent-files.js', 'src/motion-vision.js', 'src/audio-media.js', 'src/audio-service.js')
// 宿主侧导出（diagram_export）：要 node:fs 与 @resvg/resvg-js，绝不能进客户端 bundle。
HOST_ONLY_MODULES.push('src/svg-export.js')


/**
 * 客户端 bundle body 的起点：**内核的第一行**（哨兵）。
 * 内联之后 body 不再是"从 React 那行开始"，校验必须按同一个起点取回。
 */
export const CLIENT_BODY_START = '/* drawai-style-kernel'

/**
 * src/client.js 里 body 的起点。它上面的说明注释是给人看的文档，
 * 不进 bundle（bundle 自带 GENERATED 横幅），所以比对时必须从这一行起算。
 */
export const CLIENT_SOURCE_START = "const React = require('react')"

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/**
 * 客户端 body 一律按 LF 归一。
 *
 * 为什么：本仓库的 `lib/client.js` 是在 LF 工作区里生成的，而 Windows 上
 * `core.autocrlf=true` 会让检出/编辑出来的源文件变成 CRLF。内联时按 `'\n'` 切分，
 * CRLF 的每行都会拖一个 `\r`：非空行缩进后是 `    code\r`，提交时被 git 归一化，
 * 看不出差异；但**空行**会变成 `    \r`，归一化后剩下一行尾随空格，于是
 * `check-package` 会报"客户端 bundle 的 body 与 src 不一致"，而人肉 diff 只看到
 * 一堆"空行多了 4 个空格"。归一化放在这里（而不是要求每个人改工作区换行符），
 * 构建产物就与操作系统无关。
 */
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n')
}

/** 去掉 factory 的 4 空格基础缩进，得到干净的源形态。 */
export function dedentBody(body) {
  return body
    .split('\n')
    .map((line) => (line.startsWith(INDENT) ? line.slice(INDENT.length) : line))
    .join('\n')
}

/**
 * 样式内核的正文：去掉末尾的 `export { ... }`（可能跨多行）。
 *
 * 内联进 factory 之后 export 是语法错误，而宿主半边那份要保留 export 才能被 import ——
 * 所以只在这里剥离，源文件本身仍是合法的 ESM。
 */
export function kernelBody() {
  const text = readFileSync(KERNEL_PATH, 'utf8').replace(/\s+$/, '')
  const kept = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (!skipping && line.startsWith('export')) {
      skipping = !line.trimEnd().endsWith('}')
      continue
    }
    if (skipping) {
      if (line.trimEnd().endsWith('}')) skipping = false
      continue
    }
    kept.push(line)
  }
  return kept.join('\n').replace(/\s+$/, '')
}

/** 客户端 bundle 的完整 body（内核 + src/client.js 的 body）。构建与校验共用同一个函数。 */
export function composeClientBody() {
  return normalizeNewlines(composeClientBodyRaw())
}

function composeClientBodyRaw() {
  const source = readFileSync('src/client.js', 'utf8').replace(/\s+$/, '')
  const cut = source.indexOf(CLIENT_SOURCE_START)
  const body = cut < 0 ? source : source.slice(cut)
  const player = readFileSync('src/video-player.js', 'utf8').replace(/^export \{[^\n]+\}\s*$/m, '')
  const sessions = readFileSync('src/canvas-sessions.js', 'utf8').replace(/^export \{[^\n]+\}\s*$/m, '')
  const timing = readFileSync('src/performance-metrics.js', 'utf8').replace(/^export /gm, '')
  const queue = readFileSync('src/drawing-queue.js', 'utf8').replace(/^export /gm, '')
  const patches = readFileSync('src/task-patches.js', 'utf8').split('export function applyTaskPatches')[1]
  const documentCore = readFileSync('src/document-core.js', 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const commands = readFileSync('src/document-commands.js', 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const shotCatalog = JSON.parse(readFileSync('src/motion/shotcraft/catalog.json', 'utf8'))
  const catalog = shotCatalog.cards.map(({ id, category, summary }) => ({ id, category, summary }))
  const shotCore = readFileSync('src/shotcard-core.js', 'utf8').replace(/^export /gm, '')
  const mgCore = readFileSync('src/mgstyle-core.js', 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const mgCatalogJson = readFileSync('src/motion/mgstyles/catalog.json', 'utf8')
  const motion = 'const catalog = ' + JSON.stringify(catalog).replaceAll('`', '\\u0060') + ';\n' + 'const shotCatalog = ' + JSON.stringify(shotCatalog).replaceAll(String.fromCharCode(96), '\\u0060') + ';\n' + shotCore + '\n'
    + 'const mgCatalog = ' + mgCatalogJson.replaceAll('`', '\\u0060') + ';\n' + mgCore + '\n' + readFileSync('src/motion-core.js', 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  return kernelInline() + routingInline() + '\nconst motionCore = (() => {\n' + motion + '\nreturn { catalog, shotCatalog, mgCatalog, resolveShotStyle, searchShotCards, isShotCardNode, shotCardData, shotCardSelections, resolveMgStyle, searchMgStyles, isMgStyleNode, mgStyleData, mgStyleSelection, MOTION_ROLES, isAudioNode, audioNodeData, audioNodeSettings, validateAudioTimeline, motionSettings, isMotionNode, motionNodeData, bindMotionReference, motionReferenceEdges, motionReferenceRole, motionInput, motionInputKey, assertMotionEditable, validateMotionPlan, applyMotionResult }\n})()\n' + '\nconst documentCore = (() => {\nconst normalizeDrawioDoc = styleKernel.normalizeDrawioDoc\n' + documentCore + '\nreturn { cloneDocument, emptyDocument, normalizeDocument, documentTransaction }\n})()\n' + commands.replaceAll('documentTransaction(current,', 'documentCore.documentTransaction(current,') + '\nconst documentCommands = createDocumentCommands({ mutate: (draft, command) => command.mutate(draft) })\n' + '\n\nfunction applyTaskPatches' + patches + '\n\n' + timing + '\n\n' + queue + '\nconst drawingQueue = createDrawingQueue()\n\nconst canvasSessions = (() => {\n' + sessions +
    '\nreturn createCanvasSessionStore({ onClose: (sessionId, path) => drawingQueue.closeScope(sessionId, path), onDispose: () => drawingQueue.dispose(), onApplied: (id) => drawingQueue.applied(id), onSaved: (id) => drawingQueue.saved(id), onRestore: (id) => drawingQueue.restore(id) })\n})()\n\nconst videoPlayer = (() => {\n' + player +
    '\nreturn { createVideoController, VideoSurface, VideoControls, VideoPreview }\n})()\n\n' + readFileSync('src/background-task-panel.js', 'utf8') + '\n' + readFileSync('src/audio-panel.js', 'utf8') + '\n' + readFileSync('src/motion-panel.js', 'utf8') + '\n' + readFileSync('src/shotcard-panel.js', 'utf8') + '\n' + readFileSync('src/mgstyle-panel.js', 'utf8') + '\n' + readFileSync('src/table-node.js', 'utf8') + '\n\n' + body
}

/** 从内核尾部的 `export { ... }` 列表里取出符号名（单源：符号表不用手抄第二遍）。 */
function routingInline() {
  const vendor = ['libavoid.min.js', 'libavoid-routing.js'].map((file) => readFileSync('src/routing/vendor/' + file, 'utf8')).join('\n')
  const adapter = readFileSync('src/routing/router.js', 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  return '\nconst routingCore = (() => {\nconst routingKernel = styleKernel\nconst {routingModeOf, styleGet, stylePatch, jettyFromStyle} = routingKernel\n' + adapter +
    '\nreturn {createOrthogonalRouter, routingBoxes, storedRoute, validRoute, affectedRoutes}\n})()\n' +
    'let privateRoutingRuntime\nfunction getRoutingRuntime() {\nif (!privateRoutingRuntime) {\nconst globalThis = {}\n// drawai-routing-vendor-start\n' + vendor +
    '\n// drawai-routing-vendor-end\nprivateRoutingRuntime = globalThis\n}\nreturn privateRoutingRuntime\n}\n' +
    'const routingEngine = routingCore.createOrthogonalRouter(getRoutingRuntime)\n'
}

function kernelExports() {
  // 必须锚定行首：内核的说明注释里也出现过字面量 `export { ... }`，
  // 不加锚点会匹配到那句注释，生成出 `return { ... }` 这种语法错误。
  const matches = readFileSync(KERNEL_PATH, 'utf8').match(/^export\s*\{([\s\S]*?)\}/gm)
  if (matches === null) throw new Error('src/style-kernel.js 末尾缺少 export { ... } 列表')
  const match = /^export\s*\{([\s\S]*?)\}/m.exec(matches[matches.length - 1])
  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

/**
 * 内核的内联形态。
 *
 * 为什么包一层 IIFE 命名空间：客户端与内核有同名符号（例如两边都有 `SIDES`），
 * 平铺进同一个作用域会直接 SyntaxError（重复 const 声明）。
 * 包起来之后客户端按需解构，只取自己用得到的名字，冲突面归零。
 */
export function kernelInline() {
  const body = kernelBody()
    .split('\n')
    .map((line) => (line.length > 0 ? '  ' + line : line))
    .join('\n')
  return [
    CLIENT_BODY_START + ' — 构建时从 src/style-kernel.js 内联；包成命名空间以免与本地同名冲突。 */',
    'const styleKernel = (function () {',
    body,
    '  return { ' + kernelExports().join(', ') + ' }',
    '})()',
  ].join('\n')
}

/** 从一份 lib/client.js 里取回 factory 的 body（未去缩进）。 */
export function extractBody(bundle) {
  const start = bundle.indexOf(INDENT + CLIENT_BODY_START)
  const end = bundle.lastIndexOf(CLIENT_TAIL_MARK)
  if (start < 0 || end <= start) throw new Error('lib/client.js 里找不到 body 边界，无法校验')
  return bundle.slice(start, end).replace(/\s+$/, '')
}

/**
 * 反引号配平检查。
 *
 * 为什么必须有：宿主半边的 `SKILL_BODY` 是一整段模板字符串，**在它里面写一个反引号**
 * （比如给 `rounded=1` 这种键名加行内代码标记）就会把模板字符串提前截断，
 * 于是整份 lib/index.js 语法错误 —— 而构建器照样"成功"写出产物，直到有人 import 它才发现。
 * 这个坑已经踩了三次（每次都靠 npm test 里的 SyntaxError 才暴露）。
 *
 * 判据是**每份源码里反引号总数必须是偶数**（模板字符串成对出现）。不完美，但足以
 * 在构建这一步就把"多写了一个反引号"钉住，并指出是哪一行。
 */
function assertBackticksBalanced(file, text) {
  const lines = text.split('\n')
  const marks = []
  for (const [index, line] of lines.entries()) {
    for (let i = 0; i < line.length; i += 1) if (line[i] === '`') marks.push({ line: index + 1, text: line.trim() })
  }
  if (marks.length % 2 === 0) return
  const last = marks[marks.length - 1]
  throw new Error(
    file + ' 里的反引号是奇数个（' + marks.length + '）：模板字符串很可能被截断了。' +
      '最后一个在第 ' + last.line + ' 行：' + last.text + '\n' +
      '（提示：模板字符串里不要写行内代码反引号 —— 用引号或直接写键名。）',
  )
}

/**
 * 语法/绑定体检：对产物逐个跑 `node --check`。
 *
 * 为什么必须有：反引号配平只管"模板字符串被截断"，管不到别的语法错，
 * 更管不到**同一个模块里重复声明同一个名字**（例如从两个文件各 import 一个
 * `readManifest`）。那种错构建器照样写出产物、`构建完成` 照样打印，插件却在
 * 宿主启动时整片加载失败 —— 用户看到的是"插件没装上"，不是"少了个分号"。
 * `--check` 只解析不执行，不联网、不加载宿主依赖，几毫秒一个文件。
 */
function assertParses(files) {
  const bad = []
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      const message = String(result.stderr || '').split('\n').filter((line) => line && !line.startsWith('    at ')).slice(0, 4).join('\n')
      bad.push(file + '\n' + message)
    }
  }
  if (bad.length) {
    throw new Error('产物的语法/绑定检查没过（宿主加载会直接失败）：\n\n' + bad.join('\n\n'))
  }
}

/** lib/motion 下所有 .js（递归）—— 拷贝过去的那批也得体检。 */
function motionOutputs(dir = 'lib/motion') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...motionOutputs(path))
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(path)
  }
  return files
}

export function buildAll() {
  mkdirSync('lib/routing', { recursive: true })
  cpSync('src/routing', 'lib/routing', { recursive: true })
  mkdirSync('lib/motion', { recursive: true })
  cpSync('src/motion', 'lib/motion', { recursive: true })
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  const host = readFileSync('src/index.js', 'utf8')
  assertBackticksBalanced('src/index.js（宿主半边）', host)
  writeFileSync('lib/index.js', GENERATED + host, 'utf8')

  // 宿主半边 import 的样式内核：原样拷（保留 export），加生成横幅。
  writeFileSync('lib/style-kernel.js', GENERATED + readFileSync(KERNEL_PATH, 'utf8'), 'utf8')

  // 宿主半边的 mxfile 编解码（读/写 .drawio）：同样原样拷。
  // 只有宿主半边用它（浏览器没有 zlib，解不开 drawio 压过的 diagram），所以不进客户端 bundle。
  writeFileSync('lib/mxfile.js', GENERATED + readFileSync(MXFILE_PATH, 'utf8'), 'utf8')

  // 其余宿主专用模块（逐像素矢量化那套）：原样拷贝。
  // 顺手对每份源做一次语法体检（反引号配平）——这几份都进不了客户端 bundle，
  // 客户端那条校验管不到它们，等宿主 import 才发现就太晚了。
  for (const source of HOST_ONLY_MODULES) {
    const text = readFileSync(source, 'utf8')
    assertBackticksBalanced(source, text)
    const out = source.replace(/^src\//, 'lib/')
    writeFileSync(out, GENERATED + text, 'utf8')
  }

  const body = composeClientBody()
  let inRoutingVendor = false
  for (const [index, line] of body.split('\n').entries()) {
    if (line === '// drawai-routing-vendor-start') inRoutingVendor = true
    if (line === '// drawai-routing-vendor-end') inRoutingVendor = false
    if (inRoutingVendor) continue
    if (!line.includes('`')) continue
    const trimmed = line.trim()
    const isComment = trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')
    if (!isComment) throw new Error('客户端 body 第 ' + (index + 1) + ' 行代码里有反引号，缩进不安全：' + trimmed)
  }

  const indented = body
    .split('\n')
    .map((line) => (line.length > 0 ? INDENT + line : line))
    .join('\n')

  const head = [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(pkg.name) + ',',
    '  factory: (require) => {',
    '    var module = { exports: {} }',
    '    var exports = module.exports',
    "    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })",
    '',
  ].join('\n')
  const tail = ['', '    return module.exports', '  },', '})', ''].join('\n')

  writeFileSync('lib/client.js', GENERATED + head + indented + tail, 'utf8')

  assertParses([
    'lib/index.js',
    'lib/client.js',
    'lib/style-kernel.js',
    'lib/mxfile.js',
    ...HOST_ONLY_MODULES.map((source) => source.replace(/^src\//, 'lib/')),
    ...motionOutputs(),
  ])

  console.log('构建完成  host ' + digest(host) + '  client-body ' + digest(body) + '  kernel ' + digest(kernelBody()))
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) buildAll()
