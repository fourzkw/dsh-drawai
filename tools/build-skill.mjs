#!/usr/bin/env node
// 把 DrawAI 的视频引擎搬进 skills/workbuddy/engine/，产出不依赖 dsh 插件的自包含副本。
//
// 三条规则：
//   1. 引擎源码**逐字节复制**（除了下面那张工具名替换表），这样插件升级后重新跑一次就能对齐，
//      不需要维护第二份实现；
//   2. 大素材（fonts / media-library）不进仓库，走 asset-pack 的缓存或首次下载；
//   3. 复制完做一次自检：引擎里不许再出现 @deepseek-ai/*，也不许出现画布专用的 import。
//
// 用法：node tools/build-skill.mjs [--check]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = join(root, 'skills', 'workbuddy', 'scripts')
const engineDir = join(outDir, 'engine')
const checkOnly = process.argv.includes('--check')

// 引擎根模块：和 motion/ 同级，靠 ../ 互相引用，所以布局不能改。
const ROOT_MODULES = [
  'motion-render-worker.js',
  'motion-project.js',
  'motion-source.js',
  'motion-library.js',
  'motion-core.js',
  'shotcard-core.js',
  'mgstyle-core.js',
  'style-kernel.js',
  'media.js',
  'ffmpeg-manager.js',
]

// motion/ 下不进包的重目录：字体与素材库共 200MB，走 asset-pack。
const MOTION_SKIP = new Set(['fonts', 'media-library', 'node_modules', '.out'])

// 工具名 → CLI 命令。引擎的错误消息会直接教人"下一步做什么"，
// 换不到 CLI 名字的话，模型会去调一个不存在的工具。
const RENAME = [
  ['motion_audio_verify', 'wb verify'],
  ['motion_project', 'wb create'],
  ['motion_preview', 'wb preview'],
  ['motion_render', 'wb render'],
  ['motion_export', 'wb export'],
  ['motion_assets', 'wb assets'],
  ['motion_sync', 'wb sync'],
  ['motion_voice', 'wb voice'],
  ['motion_audio', 'wb audio'],
  ['motion_spec', 'wb spec'],
  ['motion_task', 'wb status'],
  ['motion_sfx', 'wb sfx'],
  ['motion_qa', 'wb qa'],
  ['shotcraft_search', 'wb card search'],
  ['diagram_apply', 'wb create'],
  ['mg_style', 'wb style'],
  ['DrawAI', 'Workbuddy'],
]

function walk(dir, list = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, list)
    else list.push(abs)
  }
  return list
}

function copyMotion(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (MOTION_SKIP.has(entry.name)) continue
    if (entry.name.endsWith('.tgz')) continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) copyMotion(from, to)
    else if (entry.isFile()) cpSync(from, to)
  }
}

function rename(text) {
  let out = text
  for (const [from, to] of RENAME) {
    out = out.replace(new RegExp('\\b' + from + '\\b', 'g'), to)
  }
  return out
}

// 工具名替换之后还没变成 CLI 写法的句子。引擎里很多提示是"教人下一步敲什么"，
// 光换工具名会留下 `wb assets {action:"list",nodeId}` 这种调不通的写法——
// 这份清单把它们改成真的能跑的 wb 命令（BRIEF.md 会原样抄给下一个 Agent 看）。
const GLOBAL_TEXT = [
  ['wb create create', 'wb create'],
  ['wb render start', 'wb render'],
  ['wb style action:"source"', 'wb style source --slug <slug>'],
]

// 定点补丁：只在 skill 里成立、不该改回插件的差异。
// 每条都写成幂等的「from → to」，重复跑不会叠，源文件里找不到 from 就直接报错——
// 插件升级把这段代码改掉时必须有人来看一眼，不能静默跳过。
const PATCHES = [
  {
    file: 'motion-render-worker.js',
    why: 'Remotion 的 ensureBrowser 只认 browserExecutable，不认 browserInstance；不传就会去 storage.googleapis.com 下载 chrome-headless-shell，没网时表现成「bundling 10% 永远不动」',
    replacements: [
      [
        "await selectComposition({ serveUrl, id: 'DrawAiMotion', inputProps, browserInstance: browser })",
        "await selectComposition({ serveUrl, id: 'DrawAiMotion', inputProps, browserInstance: browser, browserExecutable })",
      ],
      ['browserInstance:browser,cancelSignal', 'browserInstance:browser,browserExecutable,cancelSignal'],
      ['browserInstance: browser, cancelSignal', 'browserInstance: browser, browserExecutable, cancelSignal'],
      [
        'await renderMedia({ serveUrl, composition, inputProps, outputLocation: rawOutput,',
        'await renderMedia({ serveUrl, composition, inputProps, browserExecutable, outputLocation: rawOutput,',
      ],
    ],
  },
  {
    file: 'motion/project.js',
    why: 'BRIEF.md 是写给下一个 Agent 的施工说明，里面照抄插件的工具调用写法（{action:"…",nodeId}）会让它敲不存在的参数',
    replacements: [
      ['wb style {action:"frames", slug:"', 'wb style frames --slug '],
      ["+ style.slug + '\"}", "+ style.slug + '"],
      [
        'wb assets {action:"list",nodeId}，再用 {action:"library",nodeId,query:"纸张"} 或 query:"钢琴" 搜索插件库；{action:"use",nodeId,assetId:id} 导入所选条目。',
        'wb assets list，再用 `wb assets library 纸张`（或 `钢琴`）搜内置库；`wb assets use --id <assetId>` 导入所选条目。',
      ],
      [
        'wb audio {action:"add",nodeId,file,role:"sfx",at:秒}',
        'wb audio add --file <file> --role sfx --at <秒>',
      ],
    ],
  },
  {
    file: 'motion/sfx.js',
    why: 'list sfx 时给出的"用法"提示要能直接复制粘贴',
    replacements: [
      ["use: 'wb audio {action:\"add\", file:\"", "use: 'wb audio add --file \""],
      ["\", role:\"sfx\", gainDb:'", "\" --role sfx --gain '"],
      ["+ gain + '}'", '+ gain'],
    ],
  },
  {
    file: 'motion/preview.js',
    why: '两个帧也按 3 列拼，第三格永远是空的（2 帧拼图右边一大块黑）；列数不能超过帧数',
    replacements: [
      [
        'const cols = Math.max(1, Math.min(4, Math.round(Number(options.cols) || 3)))',
        'const cols = Math.max(1, Math.min(4, images.length, Math.round(Number(options.cols) || 3)))',
      ],
    ],
  },
  {
    file: 'motion/style-engine.js',
    why: 'STYLE.md 的模板里自带一句「先在这里写一行『偏离：引擎 …』」的说明文字，原来的 /偏离：引擎/ 会把这句说明当成真偏离，等于每个风格工程都能绕过引擎门禁；只认行首的「偏离：」',
    replacements: [
      [
        "const line = readFileSync(file, 'utf8').split('\\n').find((text) => /偏离：引擎/.test(text))",
        "const line = readFileSync(file, 'utf8').split('\\n').map((text) => text.trim().replace(/^[-*\\s]+/, '')).find((text) => /^偏离：引擎/.test(text))",
      ],
      [
        "const line = readFileSync(file, 'utf8').split('\\n').find((text) => pattern.test(text))",
        "const line = readFileSync(file, 'utf8').split('\\n').map((text) => text.trim().replace(/^[-*\\s]+/, '')).find((text) => pattern.test(text))",
      ],
    ],
  },
]

// 风格 brief（mgstyles/briefs/*.md）会被原样拼进 STYLE.md 交给下一个 Agent。
// 它们里面写的是插件调用，换掉工具名之后还要把 {action:"…"} 改回真命令行；
// LICENSE / NOTICE 是法律文本，不做品牌替换（"DrawAI modification" 这句本身是事实）。
const MD_TEXT = [
  [/wb style \{action:"read",\s*slug:"([^"]+)"\}/g, 'wb style read --slug $1'],
  [/wb style \{action:"frames",\s*slug:"([^"]+)"\}/g, 'wb style frames --slug $1'],
]
const MD_SKIP = new Set(['LICENSE', 'NOTICE.md'])

function rewriteMarkdown() {
  let hits = 0
  for (const file of walk(engineDir).filter((item) => item.endsWith('.md'))) {
    if (MD_SKIP.has(file.split(/[\\/]/).pop())) continue
    const before = readFileSync(file, 'utf8')
    let after = rename(before)
    for (const [pattern, to] of MD_TEXT) after = after.replace(pattern, to)
    if (after === before) continue
    hits += 1
    writeFileSync(file, after, 'utf8')
  }
  return hits
}

function patch(file) {
  const relativePath = relative(engineDir, file).split('\\').join('/')
  const spec = PATCHES.find((entry) => entry.file === relativePath)
  if (!spec) return false
  let text = readFileSync(file, 'utf8')
  for (const [from, to] of spec.replacements) {
    // 幂等判断以 from 为准：to 往往是很短、别处也有的片段（比如 "+ style.slug + '"），
    // 只看 to 会把没打过的补丁误判成"已经打过"。
    if (!text.includes(from)) {
      if (text.includes(to)) continue
      throw new Error('补丁失效：' + relativePath + ' 里找不到\n  ' + from + '\n（原因：' + spec.why + '）')
    }
    text = text.split(from).join(to)
  }
  writeFileSync(file, text, 'utf8')
  return true
}

function main() {
  if (!existsSync(join(root, 'src', 'motion'))) throw new Error('找不到 src/motion，请在仓库根目录运行')
  if (!checkOnly && existsSync(engineDir)) rmSync(engineDir, { recursive: true, force: true })
  mkdirSync(engineDir, { recursive: true })

  // 1) 复制：motion/ + 根模块
  copyMotion(join(root, 'src', 'motion'), join(engineDir, 'motion'))
  for (const file of ROOT_MODULES) {
    const from = join(root, 'src', file)
    if (!existsSync(from)) throw new Error('缺少引擎模块：src/' + file)
    cpSync(from, join(engineDir, file))
  }

  // 2) 换名字（只动 .js / .jsx，且都是字符串与注释里的工具名），再做定点补丁
  const sources = walk(engineDir).filter((file) => /\.(m?js|jsx)$/.test(file))
  for (const file of sources) {
    const before = readFileSync(file, 'utf8')
    const after = rename(before)
    if (after !== before) writeFileSync(file, after, 'utf8')
  }
  let patched = 0
  for (const file of sources) if (patch(file)) patched += 1
  if (patched !== PATCHES.length) throw new Error('补丁数量不符：应用了 ' + patched + ' 个，预期 ' + PATCHES.length)

  // 2b) 全局文字替换：插件时代的调用写法 → 真的能跑的 wb 命令
  for (const [from, to] of GLOBAL_TEXT) {
    let hits = 0
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(from)) continue
      hits += text.split(from).length - 1
      writeFileSync(file, text.split(from).join(to), 'utf8')
    }
    if (!hits) throw new Error('文字替换失效：引擎里找不到「' + from + '」')
  }

  // 2c) markdown（风格 brief）里同样有插件调用写法，STYLE.md 会把它原样交给下一个 Agent
  const mdHits = rewriteMarkdown()
  if (!mdHits) throw new Error('markdown 改写失效：engine 里没有需要改写的 brief')

  // 3) 自检：不许有插件依赖，也不许引用画布侧模块
  const problems = []
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      const spec = match[1]
      if (spec.startsWith('@deepseek-ai/')) problems.push(relative(outDir, file) + ' → ' + spec)
      if (spec.startsWith('@resvg/')) problems.push(relative(outDir, file) + ' → ' + spec)
      if (/^\.\.\/(?:raster|mxfile|document-core|client)\.js$/.test(spec)) problems.push(relative(outDir, file) + ' → ' + spec)
    }
  }
  if (problems.length) throw new Error('引擎自检失败，仍依赖插件侧模块：\n' + problems.join('\n'))

  // 4) 清单：来源 commit + 文件数，方便以后核对"这份 vendor 是哪一版"
  let commit = ''
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch { commit = 'unknown' }
  const files = walk(engineDir)
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'engine', 'VENDOR.json'), JSON.stringify({
    source: 'dsh-drawai (src/)',
    commit,
    builtAt: new Date().toISOString(),
    files: files.length,
    bytes,
    note: '由 tools/build-skill.mjs 生成；工具名已替换为 wb 子命令，引擎逻辑与插件逐字节一致。',
  }, null, 2) + '\n', 'utf8')

  console.log('engine 就绪：' + files.length + ' 个文件 · ' + (bytes / 1024).toFixed(0) + ' KB · ' + relative(root, engineDir))
}

main()
