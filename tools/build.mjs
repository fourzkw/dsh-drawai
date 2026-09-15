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
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const GENERATED = '/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */\n'

/** body 在 factory 里的基础缩进（与抽取时去掉的层级一致）。 */
const INDENT = '    '

const CLIENT_TAIL_MARK = INDENT + 'return module.exports'

/** 样式内核的源路径：宿主 import 它，客户端由本构建器内联它。 */
const KERNEL_PATH = 'src/style-kernel.js'

/** mxfile（`.drawio`）编解码的源路径：只给宿主半边用（要 node:zlib）。 */
const MXFILE_PATH = 'src/mxfile.js'

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
  const source = readFileSync('src/client.js', 'utf8').replace(/\s+$/, '')
  const cut = source.indexOf(CLIENT_SOURCE_START)
  const body = cut < 0 ? source : source.slice(cut)
  return kernelInline() + '\n\n' + body
}

/** 从内核尾部的 `export { ... }` 列表里取出符号名（单源：符号表不用手抄第二遍）。 */
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

export function buildAll() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  const host = readFileSync('src/index.js', 'utf8')
  assertBackticksBalanced('src/index.js（宿主半边）', host)
  writeFileSync('lib/index.js', GENERATED + host, 'utf8')

  // 宿主半边 import 的样式内核：原样拷（保留 export），加生成横幅。
  writeFileSync('lib/style-kernel.js', GENERATED + readFileSync(KERNEL_PATH, 'utf8'), 'utf8')

  // 宿主半边的 mxfile 编解码（读/写 .drawio）：同样原样拷。
  // 只有宿主半边用它（浏览器没有 zlib，解不开 drawio 压过的 diagram），所以不进客户端 bundle。
  writeFileSync('lib/mxfile.js', GENERATED + readFileSync(MXFILE_PATH, 'utf8'), 'utf8')

  const body = composeClientBody()
  for (const [index, line] of body.split('\n').entries()) {
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

  console.log('构建完成  host ' + digest(host) + '  client-body ' + digest(body) + '  kernel ' + digest(kernelBody()))
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) buildAll()
