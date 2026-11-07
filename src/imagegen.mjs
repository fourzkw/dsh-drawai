/**
 * 文生图 provider 层（宿主半边·源文件）。
 *
 * 一次生成请求的完整链路都在这里，客户端只拿最后那张图的 data URI：
 *
 *   comfyui：工作流（内置 / 用户粘的 UI 或 API 格式）→ 需要时现场转 API → 注入提示词与参数
 *            → POST /prompt → 轮询 /history → GET /view 取 PNG
 *   openai ：POST <base>/images/generations（b64_json）→ base64 直接回来
 *
 * 三条设计约束：
 *   1. **不碰画布、不写文件**：结果只以 data URI 返回，落节点由客户端走它唯一的 applyLocal 通道 ——
 *      否则宿主写盘 + 客户端写盘会撞 .drawio 的 revision 乐观锁。
 *   2. **不缓存图片**：ComfyUI 自己的 output 目录就是缓存，插件不再存一份；
 *      `*.media/` 是画布旁的媒体包，只给需要"重开还能看"的东西用（P2 参考图再议）。
 *   3. **不带密钥落盘**：API Key 由客户端每次随请求 body 传（存哪、存不存由设置页决定），宿主不持久化。
 */

import { randomInt, randomUUID } from 'node:crypto'
import { FRONTEND_ONLY, convertToApi, detectRoles } from './comfyui-workflow.mjs'
import { DEFAULT_T2I_WORKFLOW, DEFAULT_T2I_WORKFLOW_NAME } from './comfyui-default-workflow.mjs'

export { DEFAULT_T2I_WORKFLOW_NAME }

/** 没配置时默认连本地 ComfyUI。 */
export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'
/** 没配置时的默认生图 API（OpenAI 兼容）。 */
export const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1'
/** 生成尺寸/步数的默认值：1024×1024、20 步 —— 实测 8 步偏糊、40 步以上对 8G 显存太慢。 */
export const DEFAULT_IMAGE_SIZE = 1024
export const DEFAULT_IMAGE_STEPS = 20
export const DEFAULT_IMAGE_CFG = undefined
/** 一次生成的等待上限。ComfyUI 首次加载 Qwen-Image 2.1 的量化权重约 40–60 秒，8G 显存 20 步约 1 分钟。 */
export const IMAGE_GEN_TIMEOUT_MS = 5 * 60 * 1000
/** 连不上 / 探活超时：设置页点「检测连接」要立刻给结论，不能陪着等模型。 */
const PROBE_TIMEOUT_MS = 6000
const SUBMIT_TIMEOUT_MS = 60 * 1000
const OBJECT_INFO_TIMEOUT_MS = 20000
/** /object_info 按进程缓存：节点定义基本不变，转换一次工作流要问十几个类型，不缓存会把启动拖慢。 */
const OBJECT_INFO_TTL_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 1000
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MIN_IMAGE_SIDE = 64
const MAX_IMAGE_SIDE = 4096
const MIN_STEPS = 1
const MAX_STEPS = 150
const MAX_PROMPT_CHARS = 8000
/** 出图统一放 ComfyUI output 下的这个子目录，方便用户自己去找/清理。 */
const OUTPUT_PREFIX = 'drawai/gen'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 内置默认工作流（设置页可「载入默认」）。 */
export function defaultWorkflow() {
  return DEFAULT_T2I_WORKFLOW
}

function withTimeout(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (timer !== null && typeof timer.unref === 'function') timer.unref()
  return controller.signal
}

/** 校验并规范化 http(s) 地址 —— 宿主会替客户端去请求这个地址，协议必须收窄。 */
export function normalizeHttpUrl(value, fallback, label) {
  const raw = (typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback).replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new Error(label + '不是合法的 URL：' + raw)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(label + '只支持 http / https：' + raw)
  return raw
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function timeoutOf(body, fallback) {
  const value = clampInt(body.timeoutMs, fallback, 10000, 10 * 60 * 1000)
  return value
}

function randomSeed() {
  return randomInt(0, 2 ** 32 - 1)
}

async function request(url, init, timeoutMs, label) {
  try {
    return await fetch(url, { ...(init || {}), signal: withTimeout(timeoutMs) })
  } catch (error) {
    if (error !== null && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(label + '超时（' + Math.round(timeoutMs / 1000) + ' 秒）')
    }
    const cause = error !== null && typeof error === 'object' && error.cause !== undefined && error.cause !== null && error.cause.code !== undefined
      ? '（' + error.cause.code + '）'
      : ''
    throw new Error(label + '失败' + cause + '：' + messageOf(error))
  }
}

async function readPayload(res) {
  const text = await res.text()
  let payload = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch (error) {
      payload = null
    }
  }
  return { payload, text }
}

function describeHttpError(res, payload, text) {
  const detail = payload !== null && typeof payload === 'object'
    ? (typeof payload.error === 'string' ? payload.error : payload.message !== undefined ? String(payload.message) : '')
    : ''
  return 'HTTP ' + res.status + (detail.length > 0 ? '：' + detail.slice(0, 400) : text.length > 0 ? '：' + text.slice(0, 300) : '')
}

async function requestJson(url, init, timeoutMs, label) {
  const res = await request(url, init, timeoutMs, label)
  const { payload, text } = await readPayload(res)
  if (!res.ok) throw new Error(label + '失败（' + describeHttpError(res, payload, text) + '）')
  if (payload === null && text.length > 0) throw new Error(label + '返回的不是 JSON：' + text.slice(0, 200))
  return payload
}

async function requestBuffer(url, init, timeoutMs, label) {
  const res = await request(url, init, timeoutMs, label)
  if (!res.ok) {
    const { payload, text } = await readPayload(res)
    throw new Error(label + '失败（' + describeHttpError(res, payload, text) + '）')
  }
  return Buffer.from(await res.arrayBuffer())
}

/** /object_info 的按类型缓存（键 = 服务地址 + 类型，避免换了 ComfyUI 端口还吃旧定义）。 */
const objectInfoCache = new Map()

async function fetchObjectInfo(base, type, fetchImpl) {
  const key = base + '\n' + type
  const hit = objectInfoCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < OBJECT_INFO_TTL_MS) return hit.value
  const payload = await fetchImpl
    ? await requestJsonWith(fetchImpl, base + '/object_info/' + encodeURIComponent(type), undefined, OBJECT_INFO_TIMEOUT_MS, '读取 ComfyUI 节点定义（' + type + '）')
    : await requestJson(base + '/object_info/' + encodeURIComponent(type), undefined, OBJECT_INFO_TIMEOUT_MS, '读取 ComfyUI 节点定义（' + type + '）')
  const value = payload !== null && typeof payload === 'object' ? payload[type] : undefined
  if (value !== undefined) objectInfoCache.set(key, { at: Date.now(), value })
  return value
}

/** 测试注入用：给定 fetchImpl 时走它，其余逻辑与 requestJson 一致。 */
async function requestJsonWith(fetchImpl, url, init, timeoutMs, label) {
  const res = await fetchImpl(url, { ...(init || {}), signal: withTimeout(timeoutMs) })
  const { payload, text } = await readPayload(res)
  if (!res.ok) throw new Error(label + '失败（' + describeHttpError(res, payload, text) + '）')
  if (payload === null && text.length > 0) throw new Error(label + '返回的不是 JSON：' + text.slice(0, 200))
  return payload
}

/** 递归收集工作流里用到的 class_type（含子图内部；子图节点自身不算）。 */
export function collectWorkflowTypes(workflow) {
  const types = new Set()
  const subgraphs = new Map(((workflow.definitions && workflow.definitions.subgraphs) || []).map((sub) => [sub.id, sub]))
  const walk = (scope, depth) => {
    if (depth > 8) return
    const nodes = Array.isArray(scope.nodes) ? scope.nodes : []
    for (const node of nodes) {
      if (subgraphs.has(node.type)) walk(subgraphs.get(node.type), depth + 1)
      else types.add(node.type)
    }
  }
  walk(workflow, 0)
  return types
}

/** 'ui' | 'api' | 'unknown' —— UI 格式是画布形态，API 格式是 `{ id: { class_type, inputs } }`。 */
export function workflowFormat(workflow) {
  if (workflow === null || typeof workflow !== 'object') return 'unknown'
  if (Array.isArray(workflow.nodes) && workflow.definitions !== undefined) return 'ui'
  const keys = Object.keys(workflow)
  if (keys.length === 0) return 'unknown'
  const first = workflow[keys[0]]
  if (first !== null && typeof first === 'object' && typeof first.class_type === 'string') return 'api'
  return 'unknown'
}

/** 把内置默认工作流或用户粘贴的工作流统一成「可提交的 API prompt + 参数角色表」。 */
export async function convertWorkflow(workflow, comfyUrl, fetchImpl) {
  const format = workflowFormat(workflow)
  if (format === 'api') {
    return { prompt: JSON.parse(JSON.stringify(workflow)), roles: detectRoles(workflow), warnings: [], converted: false }
  }
  if (format !== 'ui') {
    throw new Error('工作流格式认不出来：既不是 ComfyUI 的 UI 格式（含 nodes / links），也不是 API 格式（含 class_type）')
  }
  const base = comfyUrl
  const types = [...collectWorkflowTypes(workflow)]
  const objectInfo = {}
  const missing = []
  for (const type of types) {
    // 显示用节点（MarkdownNote / Note / Reroute / PrimitiveNode）在后端没有定义，转换时本就会跳过。
    if (FRONTEND_ONLY.has(type)) continue
    const wanted = [type]
    // 转换时 SaveImageAdvanced 会被换成内置 SaveImage，所以两份定义都要取。
    if (type === 'SaveImageAdvanced') wanted.push('SaveImage')
    for (const wantedType of wanted) {
      if (objectInfo[wantedType] !== undefined) continue
      let info
      try {
        info = await fetchObjectInfo(base, wantedType, fetchImpl)
      } catch (error) {
        if (wantedType === type) missing.push(type + '（' + messageOf(error) + '）')
        continue
      }
      if (info !== undefined) objectInfo[wantedType] = info
      else if (wantedType === type) missing.push(type)
    }
  }
  if (missing.length > 0) throw new Error('这个 ComfyUI 里没有这些节点类型（自定义节点没装？）：' + missing.join('、'))
  const { prompt, roles, warnings } = convertToApi(workflow, objectInfo)
  return { prompt, roles, warnings, converted: true }
}

/** 解析用户粘贴的工作流文本（空 = 用内置默认工作流）。 */
export function parseWorkflow(value) {
  if (value === undefined || value === null) return DEFAULT_T2I_WORKFLOW
  if (typeof value === 'object') return value
  if (typeof value !== 'string') throw new Error('工作流必须是 JSON 对象或字符串')
  const text = value.trim()
  if (text.length === 0) return DEFAULT_T2I_WORKFLOW
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error('工作流 JSON 解析失败：' + messageOf(error))
  }
}

/**
 * 把提示词与参数写回 API prompt。
 * 没找到对应角色时：提示词/尺寸这种「必须生效」的报错，可选参数静默跳过并记进 applied。
 */
export function applyImageParameters(prompt, roles, params) {
  const applied = {}
  const put = (nodeId, key, value) => {
    const node = prompt[nodeId]
    if (node === undefined || node === null) return false
    if (node.inputs === undefined || node.inputs === null) node.inputs = {}
    node.inputs[key] = value
    return true
  }
  if (typeof params.prompt === 'string' && params.prompt.length > 0) {
    if (roles.positive === undefined) throw new Error('这个工作流里没找到提示词输入（需要 TextEncodeQwenImage21.prompt 或 CLIPTextEncode.text）')
    put(roles.positive.node, roles.positive.key, params.prompt)
    applied.prompt = params.prompt
  }
  if (typeof params.negativePrompt === 'string' && params.negativePrompt.length > 0 && roles.negative !== undefined) {
    put(roles.negative.node, roles.negative.key, params.negativePrompt)
    applied.negativePrompt = params.negativePrompt
  }
  if (roles.sampler !== undefined) {
    const keys = roles.sampler.keys
    if (params.seed !== undefined && params.seed !== null) {
      put(roles.sampler.node, keys.seed, params.seed)
      applied.seed = params.seed
    }
    if (params.steps !== undefined && params.steps !== null) {
      put(roles.sampler.node, keys.steps, params.steps)
      applied.steps = params.steps
    }
    if (params.cfg !== undefined && params.cfg !== null) {
      put(roles.sampler.node, keys.cfg, params.cfg)
      applied.cfg = params.cfg
    }
    if (typeof params.sampler === 'string' && params.sampler.length > 0) put(roles.sampler.node, keys.sampler, params.sampler)
    if (typeof params.scheduler === 'string' && params.scheduler.length > 0) put(roles.sampler.node, keys.scheduler, params.scheduler)
  }
  if (roles.latent !== undefined) {
    const keys = roles.latent.keys
    if (params.width !== undefined && params.width !== null) {
      put(roles.latent.node, keys.width, params.width)
      applied.width = params.width
    }
    if (params.height !== undefined && params.height !== null) {
      put(roles.latent.node, keys.height, params.height)
      applied.height = params.height
    }
  }
  if (roles.output !== undefined) put(roles.output.node, roles.output.key, OUTPUT_PREFIX)
  return applied
}

/** 从图片头里读真实尺寸与 MIME（ComfyUI 出图可能被自定义节点改过尺寸，不能信请求参数）。 */
export function imageInfoOf(buffer) {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      if (length <= 0) break
      offset += 2 + length
    }
    return { mime: 'image/jpeg', width: 0, height: 0 }
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', width: 0, height: 0 }
  }
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { mime: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  return { mime: '', width: 0, height: 0 }
}

/** 图片字节 → data URI（客户端 styleWithImageDataUri 只认 raster data URI）。 */
export function toImageDataUri(buffer, fallbackWidth, fallbackHeight) {
  const info = imageInfoOf(buffer)
  if (info.mime.length === 0) throw new Error('生成结果不是可识别的图片（PNG / JPEG / WebP / GIF）')
  return {
    dataUri: 'data:' + info.mime + ';base64,' + buffer.toString('base64'),
    mime: info.mime,
    width: info.width > 0 ? info.width : fallbackWidth,
    height: info.height > 0 ? info.height : fallbackHeight,
  }
}

function collectOutputImages(entry) {
  const found = []
  const outputs = (entry && entry.outputs) || {}
  for (const [nodeId, output] of Object.entries(outputs)) {
    const images = (output && output.images) || []
    for (const image of images) {
      if (image !== null && typeof image === 'object' && typeof image.filename === 'string') found.push({ ...image, nodeId })
    }
  }
  return found
}

async function downloadComfyImage(base, image, fetchImpl) {
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' })
  const url = base + '/view?' + query.toString()
  const buffer = fetchImpl
    ? Buffer.from(await (async () => {
      const res = await fetchImpl(url, { signal: withTimeout(60000) })
      if (!res.ok) throw new Error('取回 ComfyUI 出图失败（HTTP ' + res.status + '）')
      return res.arrayBuffer()
    })())
    : await requestBuffer(url, undefined, 60000, '取回 ComfyUI 出图')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('出图超过 ' + Math.round(MAX_IMAGE_BYTES / 1024 / 1024) + 'MB，无法内嵌到画布')
  return buffer
}

/** 轮询 /history 直到任务完成；顺便用 /queue 判断当前是「排队」「生成中」还是「加载模型」。 */
async function waitForComfyHistory(base, promptId, timeoutMs, fetchImpl, onProgress) {
  const started = Date.now()
  let lastNote = ''
  const getJson = async (path, label) => (fetchImpl
    ? requestJsonWith(fetchImpl, base + path, undefined, 15000, label)
    : requestJson(base + path, undefined, 15000, label))
  while (Date.now() - started < timeoutMs) {
    const history = await getJson('/history/' + encodeURIComponent(promptId), '查询 ComfyUI 任务状态')
    const entry = history !== null && typeof history === 'object' ? history[promptId] : undefined
    if (entry !== undefined && entry !== null) {
      const status = entry.status || {}
      if (status.status_str === 'error') throw new Error('ComfyUI 执行失败：' + JSON.stringify(status.messages || status).slice(0, 800))
      if (status.completed === true || (entry.outputs !== undefined && Object.keys(entry.outputs).length > 0)) return entry
    }
    let note = '正在生成'
    try {
      const queue = await getJson('/queue', '查询 ComfyUI 队列')
      const running = ((queue && queue.queue_running) || []).map((item) => item[1])
      const pending = ((queue && queue.queue_pending) || []).map((item) => item[1])
      if (pending.includes(promptId)) note = '排队中（前面 ' + pending.indexOf(promptId) + ' 个任务）'
      else if (!running.includes(promptId)) note = '正在加载模型'
    } catch (error) {
      // 队列查询失败不致命：history 才是权威，继续等。
    }
    if (note !== lastNote && typeof onProgress === 'function') onProgress({ state: note, elapsedMs: Date.now() - started })
    lastNote = note
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('等 ComfyUI 出图超时（' + Math.round(timeoutMs / 1000) + ' 秒）。可能是模型还在加载、队列在排队，或显卡太慢 —— 稍后重试即可。')
}

async function generateWithComfy(body, options) {
  const fetchImpl = options.fetchImpl
  const base = normalizeHttpUrl(body.comfyUrl, DEFAULT_COMFY_URL, 'ComfyUI 地址')
  const workflow = parseWorkflow(body.workflow)
  const { prompt, roles, warnings, converted } = await convertWorkflow(workflow, base, fetchImpl)
  if (roles.sampler === undefined) throw new Error('这个工作流里没有 KSampler，插件不知道该怎么改采样参数')
  if (roles.positive === undefined) throw new Error('这个工作流里没找到提示词输入（需要 TextEncodeQwenImage21.prompt 或 CLIPTextEncode.text）')
  const width = clampInt(body.width, DEFAULT_IMAGE_SIZE, MIN_IMAGE_SIDE, MAX_IMAGE_SIDE)
  const height = clampInt(body.height, DEFAULT_IMAGE_SIZE, MIN_IMAGE_SIDE, MAX_IMAGE_SIDE)
  const steps = clampInt(body.steps, DEFAULT_IMAGE_STEPS, MIN_STEPS, MAX_STEPS)
  const seed = Number.isInteger(Number(body.seed)) && Number(body.seed) >= 0 ? Number(body.seed) : randomSeed()
  const params = {
    prompt: body.prompt,
    negativePrompt: body.negativePrompt,
    seed, steps, width, height,
    cfg: body.cfg === undefined || body.cfg === null ? DEFAULT_IMAGE_CFG : Number(body.cfg),
    sampler: body.sampler,
    scheduler: body.scheduler,
  }
  const applied = applyImageParameters(prompt, roles, params)
  const started = Date.now()
  const clientId = 'drawai-' + randomUUID()
  const submit = await (fetchImpl
    ? requestJsonWith(fetchImpl, base + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
    }, SUBMIT_TIMEOUT_MS, '提交 ComfyUI 任务')
    : requestJson(base + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
    }, SUBMIT_TIMEOUT_MS, '提交 ComfyUI 任务'))
  const promptId = submit !== null && typeof submit === 'object' ? submit.prompt_id : undefined
  if (typeof promptId !== 'string' || promptId.length === 0) throw new Error('ComfyUI 没有返回 prompt_id：' + JSON.stringify(submit).slice(0, 400))
  const entry = await waitForComfyHistory(base, promptId, timeoutOf(body, IMAGE_GEN_TIMEOUT_MS), fetchImpl, options.onProgress)
  const images = collectOutputImages(entry)
  if (images.length === 0) throw new Error('ComfyUI 跑完了但没有出图：' + JSON.stringify(entry.outputs || {}).slice(0, 600))
  const buffer = await downloadComfyImage(base, images[0], fetchImpl)
  const image = toImageDataUri(buffer, width, height)
  return {
    dataUri: image.dataUri,
    mime: image.mime,
    width: image.width,
    height: image.height,
    provider: 'comfyui',
    seed: applied.seed !== undefined ? applied.seed : seed,
    steps: applied.steps !== undefined ? applied.steps : steps,
    prompt: body.prompt,
    converted,
    warnings,
    fileName: images[0].filename,
    elapsedMs: Date.now() - started,
  }
}

/** OpenAI 兼容的图片接口：base 可给到 /v1、给到 /images/generations，或只给域名。 */
export function openaiImagesEndpoint(value) {
  let base = normalizeHttpUrl(value, DEFAULT_OPENAI_URL, '生图 API 地址')
  if (/\/images\/generations$/.test(base)) return base
  if (!/\/v\d+$/.test(base)) base += '/v1'
  return base + '/images/generations'
}

function openaiModelsEndpoint(value) {
  let base = normalizeHttpUrl(value, DEFAULT_OPENAI_URL, '生图 API 地址')
  if (/\/images\/generations$/.test(base)) base = base.slice(0, -'/images/generations'.length)
  if (!/\/v\d+$/.test(base)) base += '/v1'
  return base + '/models'
}

function authHeaders(body) {
  const headers = {}
  if (typeof body.apiKey === 'string' && body.apiKey.length > 0) headers.authorization = 'Bearer ' + body.apiKey
  return headers
}

async function generateWithOpenai(body, options) {
  const fetchImpl = options.fetchImpl
  const endpoint = openaiImagesEndpoint(body.apiUrl)
  const model = typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : 'gpt-image-1'
  const width = clampInt(body.width, DEFAULT_IMAGE_SIZE, MIN_IMAGE_SIDE, MAX_IMAGE_SIDE)
  const height = clampInt(body.height, DEFAULT_IMAGE_SIZE, MIN_IMAGE_SIDE, MAX_IMAGE_SIDE)
  const started = Date.now()
  const requestBody = JSON.stringify({ model, prompt: body.prompt, n: 1, size: width + 'x' + height, response_format: 'b64_json' })
  const payload = fetchImpl
    ? await requestJsonWith(fetchImpl, endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(body) }, body: requestBody }, timeoutOf(body, IMAGE_GEN_TIMEOUT_MS), '调用生图 API')
    : await requestJson(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(body) }, body: requestBody }, timeoutOf(body, IMAGE_GEN_TIMEOUT_MS), '调用生图 API')
  const first = payload !== null && payload !== undefined && Array.isArray(payload.data) ? payload.data[0] : undefined
  if (first === undefined || first === null) throw new Error('生图 API 没有返回图片：' + JSON.stringify(payload).slice(0, 400))
  let buffer
  if (typeof first.b64_json === 'string' && first.b64_json.length > 0) {
    buffer = Buffer.from(first.b64_json, 'base64')
  } else if (typeof first.url === 'string' && first.url.length > 0) {
    buffer = fetchImpl
      ? Buffer.from(await (async () => {
        const res = await fetchImpl(first.url, { signal: withTimeout(120000) })
        if (!res.ok) throw new Error('下载生图结果失败（HTTP ' + res.status + '）')
        return res.arrayBuffer()
      })())
      : await requestBuffer(first.url, undefined, 120000, '下载生图结果')
  } else {
    throw new Error('生图 API 返回里既没有 b64_json 也没有 url：' + JSON.stringify(first).slice(0, 300))
  }
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('出图超过 ' + Math.round(MAX_IMAGE_BYTES / 1024 / 1024) + 'MB，无法内嵌到画布')
  const image = toImageDataUri(buffer, width, height)
  return {
    dataUri: image.dataUri,
    mime: image.mime,
    width: image.width,
    height: image.height,
    provider: 'openai',
    model,
    seed: null,
    prompt: body.prompt,
    converted: false,
    warnings: [],
    elapsedMs: Date.now() - started,
  }
}

/**
 * 一次文生图请求（客户端 action: 'imagegen-generate' 调它）。
 * 返回 { dataUri, mime, width, height, provider, seed, … }；失败抛 Error（调用方统一 sendJson 400）。
 */
export async function generateImage(body, options = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('先在节点里写提示词，再点生成')
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('提示词太长（上限 ' + MAX_PROMPT_CHARS + ' 字），建议写成一段具体描述')
  const request = { ...body, prompt }
  const provider = body.provider === 'openai' ? 'openai' : 'comfyui'
  if (provider === 'openai') {
    if (typeof request.apiUrl !== 'string' || request.apiUrl.trim().length === 0) request.apiUrl = DEFAULT_OPENAI_URL
    return generateWithOpenai(request, options)
  }
  return generateWithComfy(request, options)
}

async function probeComfy(body, options) {
  const fetchImpl = options.fetchImpl
  const base = normalizeHttpUrl(body.comfyUrl, DEFAULT_COMFY_URL, 'ComfyUI 地址')
  const started = Date.now()
  try {
    const stats = fetchImpl
      ? await requestJsonWith(fetchImpl, base + '/system_stats', undefined, PROBE_TIMEOUT_MS, '连接 ComfyUI')
      : await requestJson(base + '/system_stats', undefined, PROBE_TIMEOUT_MS, '连接 ComfyUI')
    const system = (stats && stats.system) || {}
    const devices = ((stats && stats.devices) || []).map((device) => ({
      name: device.name,
      type: device.type,
      vramTotal: device.vram_total,
      vramFree: device.vram_free,
    }))
    return {
      provider: 'comfyui',
      online: true,
      url: base,
      version: typeof system.comfyui_version === 'string' ? system.comfyui_version : '',
      python: typeof system.python_version === 'string' ? system.python_version : '',
      devices,
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    return { provider: 'comfyui', online: false, url: base, error: messageOf(error), elapsedMs: Date.now() - started }
  }
}

async function probeOpenai(body, options) {
  const fetchImpl = options.fetchImpl
  const endpoint = openaiModelsEndpoint(body.apiUrl)
  const started = Date.now()
  try {
    const payload = fetchImpl
      ? await requestJsonWith(fetchImpl, endpoint, { headers: authHeaders(body) }, PROBE_TIMEOUT_MS, '连接生图 API')
      : await requestJson(endpoint, { headers: authHeaders(body) }, PROBE_TIMEOUT_MS, '连接生图 API')
    const models = payload !== null && payload !== undefined && Array.isArray(payload.data)
      ? payload.data.map((item) => item && item.id).filter((id) => typeof id === 'string')
      : []
    return { provider: 'openai', online: true, url: endpoint, models, elapsedMs: Date.now() - started }
  } catch (error) {
    return { provider: 'openai', online: false, url: endpoint, error: messageOf(error), elapsedMs: Date.now() - started }
  }
}

/** 设置页「检测连接」（客户端 action: 'imagegen-status' 调它）。失败不抛错，用 online:false 报告。 */
export async function imagegenStatus(body = {}, options = {}) {
  if (body === null || typeof body !== 'object') return { online: false, error: '请求体必须是 JSON 对象' }
  if (body.provider === 'openai') return probeOpenai(body, options)
  return probeComfy(body, options)
}
