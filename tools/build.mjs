/**
 * dsh-drawai 构建器 —— 零依赖。
 *
 * 职责只有两件：
 *   src/index.js  → lib/index.js   加生成标记，其余原样（宿主半边本来就是可直接运行的 ESM）
 *   src/client.js → lib/client.js  套上 window.__ModuleLoader__.load 外壳并缩进
 *
 * 不做：语法转换、模块打包、压缩、加时间戳。
 * 前三个不需要（源文件本就是可运行的纯 JS）；时间戳绝不能加 ——
 * dsh-client-hmr 按内容变化判定 rebuilt，时间戳会让每次构建都被当成变更。
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

const CLIENT_HEAD_MARK = INDENT + "const React = require('react')"
const CLIENT_TAIL_MARK = INDENT + 'return module.exports'

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

/** 从一份 lib/client.js 里取回 factory 的 body（未去缩进）。 */
export function extractBody(bundle) {
  const start = bundle.indexOf(CLIENT_HEAD_MARK)
  const end = bundle.lastIndexOf(CLIENT_TAIL_MARK)
  if (start < 0 || end <= start) throw new Error('lib/client.js 里找不到 body 边界，无法校验')
  return bundle.slice(start, end).replace(/\s+$/, '')
}

export function buildAll() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  const host = readFileSync('src/index.js', 'utf8')
  writeFileSync('lib/index.js', GENERATED + host, 'utf8')

  const body = readFileSync('src/client.js', 'utf8').replace(/\s+$/, '')
  for (const [index, line] of body.split('\n').entries()) {
    if (!line.includes('`')) continue
    const trimmed = line.trim()
    const isComment = trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')
    if (!isComment) throw new Error('src/client.js 第 ' + (index + 1) + ' 行代码里有反引号，缩进不安全：' + trimmed)
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

  console.log('构建完成  host ' + digest(host) + '  client-body ' + digest(body))
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) buildAll()
