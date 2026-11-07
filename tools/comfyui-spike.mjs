/**
 * ComfyUI 转换 + 真机跑通的一次性探路脚本（开发用，不进 lib）。
 *
 * 用法：
 *   node tools/comfyui-spike.mjs --file <UI工作流.json> [--out _local/comfyui] [--run]
 *        [--prompt "…"] [--width 1024] [--height 1024] [--seed 123] [--steps 8] [--timeout 600]
 *
 * 做三件事：
 *   1. 取 /object_info（只取用到的类），把 UI 工作流转成 API prompt；
 *   2. 打印转换摘要 / 警告，写出 `<out>/<名字>.api.json`；
 *   3. 加 --run 时真提交，轮询 /history，把出图下载到 `<out>/<名字>-<时间>.png`，
 *      并打印每一段耗时（排队 / 采样 / 取图），用来定插件的超时与进度文案。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { convertToApi, flattenWorkflow, summarizeApi } from '../src/comfyui-workflow.mjs'

const BASE = process.env.COMFYUI_URL || 'http://127.0.0.1:8188'
const WORKDIR = process.cwd()

function parseArgs(argv) {
  const args = { out: '_local/comfyui', timeout: 600, steps: undefined, width: undefined, height: undefined, seed: undefined, prompt: undefined, run: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--run') args.run = true
    else if (key === '--file') args.file = argv[++i]
    else if (key === '--out') args.out = argv[++i]
    else if (key === '--prompt') args.prompt = argv[++i]
    else if (key === '--width') args.width = Number(argv[++i])
    else if (key === '--height') args.height = Number(argv[++i])
    else if (key === '--seed') args.seed = Number(argv[++i])
    else if (key === '--steps') args.steps = Number(argv[++i])
    else if (key === '--timeout') args.timeout = Number(argv[++i])
    else throw new Error('未知参数 ' + key)
  }
  if (!args.file) throw new Error('必须给 --file <UI工作流.json>')
  return args
}

async function getJson(path, timeoutMs = 30000) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  if (!res.ok) throw new Error('GET ' + path + ' → ' + res.status + ' ' + text.slice(0, 400))
  return JSON.parse(text)
}

/** 递归收集工作流里用到的 class_type（含子图内部）。 */
function collectTypes(ui) {
  const types = new Set()
  const subgraphs = new Map(((ui.definitions && ui.definitions.subgraphs) || []).map((sub) => [sub.id, sub]))
  const walk = (scope, depth) => {
    if (depth > 8) return
    for (const node of scope.nodes || []) {
      if (subgraphs.has(node.type)) walk(subgraphs.get(node.type), depth + 1)
      else types.add(node.type)
    }
  }
  walk(ui, 0)
  return types
}

async function fetchObjectInfo(types) {
  const info = {}
  for (const type of types) {
    try {
      const one = await getJson('/object_info/' + encodeURIComponent(type), 15000)
      if (one && typeof one === 'object' && Object.keys(one).length > 0) info[type] = one[type]
    } catch (error) {
      console.warn('[info] ' + type + ' 取不到：' + error.message)
    }
  }
  return info
}

/** 把角色表里的参数写回 API prompt。 */
function applyParams(prompt, roles, args) {
  const set = (role, key, value) => {
    if (role === undefined) return
    prompt[role.node].inputs[key] = value
  }
  if (args.prompt !== undefined && roles.positive !== undefined) set(roles.positive, roles.positive.key, args.prompt)
  if (roles.sampler !== undefined) {
    const keys = roles.sampler.keys
    if (args.seed !== undefined) prompt[roles.sampler.node].inputs[keys.seed] = args.seed
    if (args.steps !== undefined) prompt[roles.sampler.node].inputs[keys.steps] = args.steps
  }
  if (roles.latent !== undefined) {
    const keys = roles.latent.keys
    if (args.width !== undefined) prompt[roles.latent.node].inputs[keys.width] = args.width
    if (args.height !== undefined) prompt[roles.latent.node].inputs[keys.height] = args.height
  }
  if (roles.output !== undefined) prompt[roles.output.node].inputs[roles.output.key] = 'drawai-spike/gen'
}

async function submit(prompt) {
  const clientId = 'drawai-spike-' + Date.now().toString(36)
  const res = await fetch(BASE + '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  if (!res.ok || payload.error) {
    const error = new Error('POST /prompt 被拒：' + JSON.stringify(payload.node_errors || payload.error || payload).slice(0, 4000))
    error.payload = payload
    throw error
  }
  return { promptId: payload.prompt_id, clientId, queued: payload.number }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForImage(promptId, timeoutMs) {
  const started = Date.now()
  let lastNote = ''
  while (Date.now() - started < timeoutMs) {
    const queue = await getJson('/queue', 10000)
    const running = (queue.queue_running || []).map((item) => item[1])
    const pending = (queue.queue_pending || []).map((item) => item[1])
    const history = await getJson('/history/' + promptId, 10000)
    if (history[promptId]) {
      return { entry: history[promptId], waitedMs: Date.now() - started }
    }
    const note = running.includes(promptId) ? '采样中' : pending.includes(promptId) ? '排队中（前面 ' + pending.indexOf(promptId) + ' 个）' : '未在队列（可能在加载模型）'
    if (note !== lastNote) {
      console.log('[wait] ' + Math.round((Date.now() - started) / 1000) + 's ' + note)
      lastNote = note
    }
    await sleep(1000)
  }
  throw new Error('等待出图超时（' + Math.round(timeoutMs / 1000) + 's）')
}

async function downloadImage(image) {
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' })
  const res = await fetch(BASE + '/view?' + query.toString(), { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error('GET /view → ' + res.status)
  return Buffer.from(await res.arrayBuffer())
}

function collectImages(entry) {
  const found = []
  for (const output of Object.values(entry.outputs || {})) {
    for (const image of (output && output.images) || []) found.push(image)
  }
  return found
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const text = readFileSync(args.file, 'utf8')
  const ui = JSON.parse(text)
  const name = basename(args.file).replace(/\.json$/i, '')
  const outDir = join(WORKDIR, args.out)
  mkdirSync(outDir, { recursive: true })

  const types = collectTypes(ui)
  console.log('[info] 工作流用到 ' + types.size + ' 个节点类型：' + [...types].join(', '))
  const objectInfo = await fetchObjectInfo(types)
  const { prompt, roles, warnings } = convertToApi(ui, objectInfo)
  console.log('\n=== 转换警告（' + warnings.length + '）===')
  for (const warning of warnings) console.log('  · ' + warning)
  console.log('\n=== API prompt（' + Object.keys(prompt).length + ' 节点）===')
  console.log(summarizeApi(prompt))
  console.log('\n=== 参数角色 ===')
  console.log(JSON.stringify(roles, null, 2))

  applyParams(prompt, roles, args)
  const apiPath = join(outDir, name + '.api.json')
  writeFileSync(apiPath, JSON.stringify(prompt, null, 2), 'utf8')
  console.log('\n[out] ' + apiPath)

  if (!args.run) return
  const submittedAt = Date.now()
  const { promptId, queued } = await submit(prompt)
  console.log('\n[run] 已提交 prompt_id=' + promptId + (queued !== undefined ? ' 队列前有 ' + queued + ' 个' : ''))
  const { entry, waitedMs } = await waitForImage(promptId, args.timeout * 1000)
  const images = collectImages(entry)
  if (images.length === 0) throw new Error('history 里没有图片：' + JSON.stringify(entry).slice(0, 1200))
  console.log('[run] 出图用时 ' + (waitedMs / 1000).toFixed(1) + 's，共 ' + images.length + ' 张；服务端 status=' + JSON.stringify(entry.status || {}))
  for (const [index, image] of images.entries()) {
    const buffer = await downloadImage(image)
    const file = join(outDir, name + '-' + Date.now() + '-' + index + '.png')
    writeFileSync(file, buffer)
    console.log('[out] ' + file + '  ' + image.filename + '  ' + (buffer.length / 1024).toFixed(0) + 'KB  总耗时 ' + ((Date.now() - submittedAt) / 1000).toFixed(1) + 's')
  }
}

main().catch((error) => {
  if (error.payload) console.error('payload:', JSON.stringify(error.payload, null, 2).slice(0, 8000))
  console.error('[spike] 失败：' + error.message)
  process.exitCode = 1
})
