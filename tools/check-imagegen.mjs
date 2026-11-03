/**
 * src/imagegen.mjs 的自测（挂在 npm test 里跑）。
 *
 * 不连真机、不要显卡、不要 API Key —— 整条生成链路用两个假服务跑通：
 *
 *   · 假 ComfyUI：/system_stats、/object_info/<type>、/prompt、/queue、/history/<id>、/view
 *   · 假 OpenAI：/v1/images/generations、/v1/models
 *
 * 覆盖：
 *   1. 合成 UI 工作流 → UI→API 转换 → 注入提示词/尺寸/步数/种子 → 提交 → 轮询 → 取图 → data URI
 *   2. 提交给 ComfyUI 的 prompt 里**没有悬空引用**（引用都能解析到真实节点）
 *   3. 探测「检测连接」的两个 provider（在线结果与字段）
 *   4. OpenAI 兼容分支的 b64_json 解析
 *   5. （可选）若 _local/comfyui/object-info.json 存在 —— 真机抓的节点定义快照，
 *      离线把内置的 Qwen-Image 2.1 UI 工作流转一遍，断言转换结果可用。
 *      没有快照就跳过（真机节点定义不该进仓库，机器间也不保证一致）。
 */
import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import {
  convertWorkflow,
  defaultWorkflow,
  generateImage,
  imagegenStatus,
  parseWorkflow,
} from '../src/imagegen.mjs'

let failures = 0
function expect(condition, label, detail) {
  if (condition) {
    console.log('  ✓ ' + label)
    return
  }
  failures += 1
  console.log('  ✗ ' + label + (detail === undefined ? '' : '（' + detail + '）'))
}

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ -1) >>> 0
}

/** 手搓一张纯色 PNG：假服务要返回"真图片字节"，好让 imageInfoOf 读得出尺寸。 */
function makePng(width, height, rgb = [32, 160, 96]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const TEST_PNG = makePng(64, 64)

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** 合成 UI 工作流的对象定义：只写转换器需要的那几个字段（跟真机 /object_info 同构）。 */
const MOCK_OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors'], {}] } },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    output: ['CONDITIONING'],
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ['INT', { default: 512, min: 16, max: 4096, step: 8 }],
        height: ['INT', { default: 512, min: 16, max: 4096, step: 8 }],
        batch_size: ['INT', { default: 1, min: 1, max: 64 }],
      },
    },
    output: ['LATENT'],
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, min: 0, max: 0xffffffffffff, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8, min: 0, max: 100 }],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['normal', 'karras'], {}],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1 }],
      },
    },
    output: ['LATENT'],
  },
  VAEDecode: {
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
    output: ['IMAGE'],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } },
    output: [],
  },
}

/** 一份极小的 UI 格式工作流（没子图、没自定义节点）—— 专门用来验证转换器契约。 */
function syntheticUiWorkflow() {
  return {
    version: 0.4,
    nodes: [
      {
        id: 1, type: 'CheckpointLoaderSimple', mode: 0, inputs: [],
        outputs: [
          { name: 'MODEL', type: 'MODEL', links: [1] },
          { name: 'CLIP', type: 'CLIP', links: [2, 3] },
          { name: 'VAE', type: 'VAE', links: [4] },
        ],
        widgets_values: ['sd_xl_base_1.0.safetensors'],
      },
      {
        id: 2, type: 'CLIPTextEncode', mode: 0,
        inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }],
        widgets_values: ['旧的正向提示词'],
      },
      {
        id: 3, type: 'CLIPTextEncode', mode: 0,
        inputs: [{ name: 'clip', type: 'CLIP', link: 3 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }],
        widgets_values: ['旧的负向提示词'],
      },
      {
        id: 4, type: 'EmptyLatentImage', mode: 0, inputs: [],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }],
        widgets_values: [512, 512, 1],
      },
      {
        id: 5, type: 'KSampler', mode: 0,
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'positive', type: 'CONDITIONING', link: 5 },
          { name: 'negative', type: 'CONDITIONING', link: 6 },
          { name: 'latent_image', type: 'LATENT', link: 7 },
        ],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }],
        widgets_values: [0, 'fixed', 20, 8, 'euler', 'normal', 1],
      },
      {
        id: 6, type: 'VAEDecode', mode: 0,
        inputs: [{ name: 'samples', type: 'LATENT', link: 8 }, { name: 'vae', type: 'VAE', link: 4 }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }],
        widgets_values: [],
      },
      {
        id: 7, type: 'SaveImage', mode: 0,
        inputs: [{ name: 'images', type: 'IMAGE', link: 9 }],
        outputs: [],
        widgets_values: ['ComfyUI'],
      },
    ],
    links: [
      [1, 1, 0, 5, 0, 'MODEL'],
      [2, 1, 1, 2, 0, 'CLIP'],
      [3, 1, 1, 3, 0, 'CLIP'],
      [4, 1, 2, 6, 1, 'VAE'],
      [5, 2, 0, 5, 1, 'CONDITIONING'],
      [6, 3, 0, 5, 2, 'CONDITIONING'],
      [7, 4, 0, 5, 3, 'LATENT'],
      [8, 5, 0, 6, 0, 'LATENT'],
      [9, 6, 0, 7, 0, 'IMAGE'],
    ],
    groups: [],
    config: {},
    extra: {},
    definitions: {},
  }
}

async function startMockComfy() {
  const state = { historyCalls: 0, prompts: [], viewQueries: [] }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock')
    if (url.pathname === '/system_stats') {
      return json(res, 200, {
        system: { comfyui_version: '0.3.99-test', python_version: '3.12.0' },
        devices: [{ name: 'Mock GPU', type: 'cuda', vram_total: 8589934592, vram_free: 4294967296 }],
      })
    }
    if (url.pathname.startsWith('/object_info/')) {
      const type = decodeURIComponent(url.pathname.slice('/object_info/'.length))
      const info = MOCK_OBJECT_INFO[type]
      if (info === undefined) return json(res, 404, { error: 'no such node' })
      return json(res, 200, { [type]: info })
    }
    if (url.pathname === '/queue') {
      return json(res, 200, { queue_running: [[0, 'mock-prompt-1', {}, {}, []]], queue_pending: [] })
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      state.prompts.push(await readJsonBody(req))
      return json(res, 200, { prompt_id: 'mock-prompt-1', number: 1, node_errors: {} })
    }
    if (url.pathname.startsWith('/history/')) {
      state.historyCalls += 1
      if (state.historyCalls < 2) return json(res, 200, {})
      return json(res, 200, {
        'mock-prompt-1': {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { 7: { images: [{ filename: 'gen_00001_.png', subfolder: 'drawai', type: 'output' }] } },
        },
      })
    }
    if (url.pathname === '/view') {
      state.viewQueries.push(Object.fromEntries(url.searchParams))
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(TEST_PNG)
    }
    return json(res, 404, { error: 'unexpected ' + url.pathname })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function startMockOpenai() {
  const state = { generateCalls: [], authHeaders: [] }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock')
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      state.authHeaders.push(req.headers.authorization)
      return json(res, 200, { object: 'list', data: [{ id: 'gpt-image-1', object: 'model' }] })
    }
    if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
      const body = await readJsonBody(req)
      state.generateCalls.push(body)
      state.authHeaders.push(req.headers.authorization)
      return json(res, 200, { created: 1, data: [{ b64_json: TEST_PNG.toString('base64') }] })
    }
    return json(res, 404, { error: { message: 'unexpected ' + url.pathname } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function assertNoDanglingRefs(prompt, label) {
  const dangling = []
  for (const [nodeId, node] of Object.entries(prompt)) {
    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (!Array.isArray(value) || value.length !== 2) continue
      if (typeof value[0] !== 'string') continue
      if (prompt[value[0]] === undefined) dangling.push(nodeId + '.' + key + ' → ' + value[0])
    }
  }
  expect(dangling.length === 0, label, dangling.slice(0, 4).join('、'))
}

async function main() {
  console.log('imagegen: 假 ComfyUI 全链路')
  const comfy = await startMockComfy()
  try {
    const result = await generateImage({
      provider: 'comfyui',
      comfyUrl: comfy.base,
      workflow: syntheticUiWorkflow(),
      prompt: '一只戴墨镜的猫',
      negativePrompt: '模糊、低清',
      width: 768,
      height: 512,
      steps: 12,
      seed: 1234,
    })
    expect(typeof result.dataUri === 'string' && result.dataUri.startsWith('data:image/png;base64,'), '返回 PNG data URI')
    expect(result.width === 64 && result.height === 64, '尺寸取图片头里的真实值', result.width + '×' + result.height)
    expect(result.provider === 'comfyui' && result.seed === 1234, 'seed 透传回来')
    const submitted = comfy.state.prompts[0]
    expect(submitted !== undefined, '确实提交到了 /prompt')
    const prompt = submitted.prompt
    const encodeNodes = Object.values(prompt).filter((node) => node.class_type === 'CLIPTextEncode')
    const texts = encodeNodes.map((node) => node.inputs.text)
    expect(texts.includes('一只戴墨镜的猫'), '正向提示词写进 CLIPTextEncode', JSON.stringify(texts))
    expect(texts.includes('模糊、低清'), '负向提示词写进另一个 CLIPTextEncode')
    const latent = Object.values(prompt).find((node) => node.class_type === 'EmptyLatentImage')
    expect(latent.inputs.width === 768 && latent.inputs.height === 512, '尺寸写进 EmptyLatentImage')
    const sampler = Object.values(prompt).find((node) => node.class_type === 'KSampler')
    expect(sampler.inputs.seed === 1234 && sampler.inputs.steps === 12, 'seed / steps 写进 KSampler')
    const save = Object.values(prompt).find((node) => node.class_type === 'SaveImage')
    expect(save.inputs.filename_prefix === 'drawai/gen', '出图统一落在 drawai/gen 子目录')
    assertNoDanglingRefs(prompt, '提交的 prompt 没有悬空引用')
    expect(comfy.state.historyCalls >= 2, '轮询 /history 至少两轮', String(comfy.state.historyCalls))
    expect(comfy.state.viewQueries.length === 1 && comfy.state.viewQueries[0].subfolder === 'drawai', '/view 带对了 subfolder')

    const status = await imagegenStatus({ provider: 'comfyui', comfyUrl: comfy.base })
    expect(status.online === true && status.version === '0.3.99-test', '检测连接：ComfyUI 在线', status.error)
    expect(Array.isArray(status.devices) && status.devices[0].name === 'Mock GPU', '检测连接：带回显卡信息')

    const offline = await imagegenStatus({ provider: 'comfyui', comfyUrl: 'http://127.0.0.1:1' })
    expect(offline.online === false && typeof offline.error === 'string', '检测连接：连不上给 online:false 而不是抛错')
  } finally {
    await comfy.close()
  }

  console.log('imagegen: 参数校验')
  let threw = false
  try {
    await generateImage({ provider: 'comfyui', prompt: '   ' })
  } catch (error) {
    threw = true
  }
  expect(threw, '空提示词直接报错')
  threw = false
  try {
    await generateImage({ provider: 'comfyui', comfyUrl: 'file:///etc/passwd', prompt: 'x' })
  } catch (error) {
    threw = true
  }
  expect(threw, '非 http(s) 地址被拒')

  console.log('imagegen: 假 OpenAI 兼容 API')
  const openai = await startMockOpenai()
  try {
    const result = await generateImage({
      provider: 'openai',
      apiUrl: openai.base + '/v1',
      apiKey: 'sk-test-key',
      model: 'gpt-image-1',
      prompt: '一只戴墨镜的猫',
      width: 1024,
      height: 1024,
    })
    expect(typeof result.dataUri === 'string' && result.dataUri.startsWith('data:image/png;base64,'), 'b64_json 解析成 data URI')
    const sent = openai.state.generateCalls[0]
    expect(sent.model === 'gpt-image-1' && sent.size === '1024x1024' && sent.response_format === 'b64_json', '请求体字段正确')
    expect(openai.state.authHeaders[0] === 'Bearer sk-test-key', '带 Authorization 头')
    const status = await imagegenStatus({ provider: 'openai', apiUrl: openai.base + '/v1', apiKey: 'sk-test-key' })
    expect(status.online === true && status.models.includes('gpt-image-1'), '检测连接：OpenAI 兼容 API 在线')
  } finally {
    await openai.close()
  }

  console.log('imagegen: 内置默认工作流')
  const builtin = parseWorkflow(defaultWorkflow())
  expect(builtin !== null && typeof builtin === 'object' && Array.isArray(builtin.nodes), '默认工作流是 UI 格式且能解析')
  const fixturePath = '_local/comfyui/object-info.json'
  if (!existsSync(fixturePath)) {
    console.log('  · 跳过真机工作流离线转换：没有 ' + fixturePath + '（真机节点定义快照，不入库）')
  } else {
    const objectInfo = JSON.parse(readFileSync(fixturePath, 'utf8'))
    const fetchImpl = async (url) => {
      const match = /\/object_info\/([^/?]+)$/.exec(String(url))
      const type = match === null ? '' : decodeURIComponent(match[1])
      const info = objectInfo[type]
      if (info === undefined) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ [type]: info }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const converted = await convertWorkflow(builtin, 'http://fixture', fetchImpl)
    const prompt = converted.prompt
    expect(converted.converted === true && converted.warnings.length === 0, 'Qwen-Image 2.1 工作流离线转换成功（0 警告）', converted.warnings.slice(0, 3).join('；'))
    expect(converted.roles.positive !== undefined && converted.roles.sampler !== undefined && converted.roles.latent !== undefined, '角色表齐全（提示词/采样/尺寸）')
    const encodes = Object.values(prompt).filter((node) => node.class_type === 'TextEncodeQwenImage21')
    expect(encodes.length === 1 && typeof encodes[0].inputs.prompt === 'string', '提示词是字符串常量（改写链已被开关剪掉）')
    const saves = Object.values(prompt).filter((node) => node.class_type === 'SaveImage')
    expect(saves.length === 1 && saves[0].inputs.images !== undefined, 'SaveImageAdvanced 换成了内置 SaveImage')
    assertNoDanglingRefs(prompt, '转换结果没有悬空引用')
    expect(Object.values(prompt).filter((node) => node.class_type === 'KSampler').length === 1, '只剩一个 KSampler')
  }

  if (failures > 0) {
    console.log('check-imagegen: ' + failures + ' 项失败')
    process.exitCode = 1
    return
  }
  console.log('check-imagegen: 全部通过')
}

await main()
