/**
 * ComfyUI 工作流「UI 格式 → API 格式」转换。
 *
 * 为什么需要它：ComfyUI 前端「保存 / 导出」默认写的是 UI 格式（节点摆在画布上的样子，
 * 带 links / widgets_values / definitions.subgraphs），而 `POST /prompt` 只认 API 格式
 * （`{ nodeId: { class_type, inputs } }`）。用户从 ComfyUI 拿到的模板天然是前者。
 *
 * 这个模块只做纯数据变换，不碰网络也不碰文件：
 *   flattenWorkflow(ui)                → 展开子图后的节点表 / 连线表
 *   convertToApi(ui, objectInfo, opt)  → { prompt, roles, warnings }
 *
 * 三条关键语义（对着 ComfyUI 0.38 / 前端 1.53 的真实数据验过）：
 *   1. 子图（definitions.subgraphs）必须内联：节点 id 加 `子图节点id:` 前缀，
 *      子图输入（origin_id = -10 / origin_slot = k）换成外层来源或子图节点上的 widget 常量，
 *      子图输出（target_id = -20）换成内部真实来源。
 *   2. `ComfySwitchNode` 是 lazy 开关：按 switch 的值只保留被选中的那一支，
 *      另一支（例如 Qwen 的 TextGenerate 改写链、9B PE 模型）整支剪掉 —— 不然后端会白白加载模型。
 *   3. widget 值的消费顺序必须按 object_info 的 required → optional 顺序逐项走，
 *      并为 `control_after_generate`（KSampler.seed 后面那个 "fixed"/"randomize"）与
 *      `COMFY_DYNAMICCOMBO_V3`（SaveImageAdvanced.format、TextGenerate.sampling_mode）留下的
 *      隐藏 widget 各让出一格，否则后面所有参数整体错一位。
 */

/** 这些 class_type 在 UI 里只是「显示用」的节点，不进 API prompt（也不需要问 /object_info）。 */
export const FRONTEND_ONLY = new Set(['MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode'])

/** 视为「出图终点」的节点 —— 从它们反向遍历决定哪些节点真的需要留。 */
const SINK_TYPES = new Set(['SaveImage', 'SaveImageAdvanced', 'PreviewImage'])

/** 子图输入里哪些类型会变成 widget（其余是连线型输入，如 IMAGE / LATENT）。 */
function isWidgetType(type) {
  if (Array.isArray(type)) return true
  const t = String(type)
  return t === 'INT' || t === 'FLOAT' || t === 'STRING' || t === 'BOOLEAN' || t === 'COMBO'
}

function specType(spec) {
  if (!Array.isArray(spec)) return typeof spec === 'string' ? spec : ''
  if (Array.isArray(spec[0])) return 'COMBO'
  return String(spec[0])
}

function isWidgetSpec(spec) {
  if (!Array.isArray(spec)) return false
  if (Array.isArray(spec[0])) return true
  const t = String(spec[0])
  return t === 'INT' || t === 'FLOAT' || t === 'STRING' || t === 'BOOLEAN' || t === 'COMBO' || t === 'COMFY_DYNAMICCOMBO_V3'
}

/** object_info 里一个 widget 实际占几格 widgets_values（动态 combo、随机种子会多占）。 */
function widgetSpan(spec) {
  if (!isWidgetSpec(spec)) return 0
  let span = 1
  const opts = Array.isArray(spec) ? spec[1] || {} : {}
  if (opts.control_after_generate === true) span += 1
  if (specType(spec) === 'COMFY_DYNAMICCOMBO_V3') {
    const first = (opts.options || [])[0]
    const sub = first && first.inputs ? [...Object.keys(first.inputs.required || {}), ...Object.keys(first.inputs.optional || {})] : []
    span += sub.length
  }
  return span
}

/**
 * 把 UI 工作流（含任意层子图）摊平成一张节点表 + 一张连线表。
 *
 * 节点 key 是字符串（子图内部节点带 `外层id:` 前缀），这样 API prompt 里 id 稳定又唯一。
 * 连线的 origin 有两种形态：`{ node, slot }`（连到某个节点输出）或 `{ const }`（字面量）。
 */
export function flattenWorkflow(ui) {
  const warnings = []
  const nodes = new Map()
  const links = new Map()
  const subgraphs = new Map()
  for (const sub of (ui.definitions && ui.definitions.subgraphs) || []) subgraphs.set(sub.id, sub)

  /**
   * @param {object} scope 当前层 { nodes, links }
   * @param {string} prefix 当前层的 id 前缀
   * @param {Array|null} outerInputs 子图输入槽 → 外层来源；顶层为 null
   * @returns {Map<number, object>} 子图输出槽 → 内部来源
   */
  function expandScope(scope, prefix, outerInputs) {
    const outputs = new Map()
    const scopeLinks = scope.links || []

    // 先登记连线：子图内部的 -10（输入）在这里就被换成外层来源或常量。
    // 注意两种落盘形态并存：顶层 links 是数组 [id, origin_id, origin_slot, target_id, target_slot, type]，
    // 而 definitions.subgraphs[].links 是对象 { id, origin_id, origin_slot, target_id, target_slot, type }。
    for (const raw of scopeLinks) {
      const link = Array.isArray(raw)
        ? { id: raw[0], originNode: raw[1], originSlot: raw[2], targetNode: raw[3], targetSlot: raw[4] }
        : {
            id: raw.id,
            originNode: raw.origin_id !== undefined ? raw.origin_id : raw.originNode,
            originSlot: raw.origin_slot !== undefined ? raw.origin_slot : raw.originSlot,
            targetNode: raw.target_id !== undefined ? raw.target_id : raw.targetNode,
            targetSlot: raw.target_slot !== undefined ? raw.target_slot : raw.targetSlot,
          }
      const key = prefix + link.id
      let origin
      if (outerInputs !== null && link.originNode === -10) {
        origin = outerInputs[link.originSlot] || { const: undefined }
      } else {
        origin = { node: prefix + link.originNode, slot: link.originSlot }
      }
      links.set(key, { id: key, origin, target: null })
      if (outerInputs !== null && link.targetNode === -20) {
        outputs.set(link.targetSlot, origin)
      } else {
        links.get(key).target = { node: prefix + link.targetNode, slot: link.targetSlot }
      }
    }

    // 再展开节点：子图节点递归进去，普通节点进节点表。
    for (const node of scope.nodes || []) {
      const id = prefix + node.id
      const sub = subgraphs.get(node.type)
      if (sub) {
        // 子图节点有两种「输入顺序」：
        //   1. 节点自己的 inputs 数组 —— 只列被提升成插槽的输入，外层连线里的 target_slot 指的是它；
        //   2. definitions.subgraphs[].inputs —— 全部子图输入，内部 -10 连线的 slot 与 widgets_values 指的都是它。
        // 两者顺序不同（例如 promote 后 steps 从第 5 个跑到第 4 个），必须按 name 对齐。
        const defInputs = sub.inputs || []
        const socketInputs = Array.isArray(node.inputs) ? node.inputs : []
        const defIndexByName = new Map()
        defInputs.forEach((input, index) => {
          if (!defIndexByName.has(input.name)) defIndexByName.set(input.name, [])
          defIndexByName.get(input.name).push(index)
        })
        const incomingByDefIndex = new Map()
        for (const link of links.values()) {
          if (!link.target || link.target.node !== id) continue
          const socket = socketInputs[link.target.slot]
          const candidates = socket ? defIndexByName.get(socket.name) : undefined
          const defIndex = candidates && candidates.length > 0 ? candidates.shift() : link.target.slot
          incomingByDefIndex.set(defIndex, link.origin)
        }
        // widgets_values 的顺序 = defInputs 顺序，只给 widget 类输入；被外层接线的那些在 widgets_values 里
        // 同样占一格，所以无论有没有外层来源都要先吃格，否则后面的子图参数会整体错位。
        const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
        let widgetIndex = 0
        const outerForInner = defInputs.map((input, index) => {
          const widget = isWidgetType(input && input.type)
          let value
          if (widget) {
            value = widgetIndex < widgets.length ? { const: widgets[widgetIndex] } : { const: undefined }
            widgetIndex += 1
          }
          if (incomingByDefIndex.has(index)) return incomingByDefIndex.get(index)
          return widget ? value : undefined
        })
        const innerOutputs = expandScope(sub, id + ':', outerForInner)
        // 外层引用「这个子图节点的第 k 个输出」的连线，改指向子图内部真实来源。
        for (const link of links.values()) {
          if (link.origin && link.origin.node === id) {
            link.origin = innerOutputs.get(link.origin.slot) || { const: undefined }
          }
        }
        continue
      }
      if (node.mode !== undefined && node.mode !== 0) {
        warnings.push('节点 ' + id + '（' + node.type + '）处于 mode=' + node.mode + '（mute/bypass），已按停用处理')
      }
      nodes.set(id, {
        id,
        type: node.type,
        mode: node.mode === undefined ? 0 : node.mode,
        inputs: Array.isArray(node.inputs) ? node.inputs : [],
        widgets: Array.isArray(node.widgets_values) ? node.widgets_values : [],
        raw: node,
      })
    }
    return outputs
  }

  expandScope({ nodes: ui.nodes, links: ui.links }, '', null)
  return { nodes, links, warnings }
}

/** 把一条连线的 origin 变成 API prompt 里能直接写的形态。 */
function toRef(origin) {
  if (!origin) return undefined
  if ('const' in origin) return origin.const
  return [origin.node, origin.slot]
}

/** 收集每个节点「输入槽 → 连线来源」，名字取节点自己 inputs 数组里的 name。 */
function collectIncoming(nodes, links) {
  const incoming = new Map()
  for (const link of links.values()) {
    if (!link.target) continue
    const node = nodes.get(link.target.node)
    const entry = node ? node.inputs[link.target.slot] : undefined
    if (!entry) continue
    const byName = incoming.get(link.target.node) || new Map()
    byName.set(entry.name, link.origin)
    incoming.set(link.target.node, byName)
  }
  return incoming
}

/**
 * UI 工作流 → API prompt。
 *
 * @param {object} ui ComfyUI 导出的 UI 格式工作流
 * @param {Record<string, object>} objectInfo `/object_info` 的节点定义表（可以只给用到的类）
 * @param {object} [options]
 * @param {(node: object) => string} [options.classAlias] 换掉某个节点的 class_type（默认把 SaveImageAdvanced 换成内置 SaveImage，绕开动态 combo 编码）
 * @param {boolean} [options.keepAll] true 时不做可达性剪枝
 */
export function convertToApi(ui, objectInfo, options = {}) {
  const warnings = []
  const { nodes, links, warnings: flatWarnings } = flattenWorkflow(ui)
  warnings.push(...flatWarnings)
  const incoming = collectIncoming(nodes, links)

  /** 按节点收集的警告：剪枝之后只报留下来的节点，避免「没被选中的改写链」在诊断里刷屏。 */
  const nodeWarnings = new Map()
  const warnNode = (id, message) => {
    const list = nodeWarnings.get(id)
    if (list === undefined) nodeWarnings.set(id, [message])
    else list.push(message)
  }

  const classOf = (node) => {
    if (node.type === 'SaveImageAdvanced') return 'SaveImage'
    return node.type
  }

  /** 追一条 origin：穿过 PurePreview / 开关 / 字面量节点，直到落到真实节点输出或常量。 */
  function resolveOrigin(origin, seen) {
    if (!origin) return origin
    if ('const' in origin) return origin
    const key = origin.node + ':' + origin.slot
    if (seen.has(key)) {
      warnings.push('连线成环：' + key)
      return origin
    }
    seen.add(key)
    const node = nodes.get(origin.node)
    if (!node) return origin
    const byName = incoming.get(origin.node) || new Map()
    if (node.type === 'ComfySwitchNode') {
      const chosen = node.widgets[0] ? 'on_true' : 'on_false'
      const next = byName.get(chosen)
      if (next === undefined) {
        warnings.push('开关 ' + origin.node + ' 的 ' + chosen + ' 没有连线')
        return origin
      }
      return resolveOrigin(next, seen)
    }
    if (node.type === 'PreviewAny') {
      const next = byName.get('source')
      return next === undefined ? origin : resolveOrigin(next, seen)
    }
    if (/^Primitive/.test(node.type) && node.inputs.every((entry) => entry.link === null || entry.link === undefined)) {
      return { const: node.widgets[0] }
    }
    return origin
  }

  // 第一步：按 object_info 的字段顺序把每个节点变成 { class_type, inputs }。
  const prompt = {}
  for (const node of nodes.values()) {
    if (node.mode !== 0) continue
    if (FRONTEND_ONLY.has(node.type)) continue
    const classType = classOf(node)
    const spec = objectInfo[classType] || objectInfo[node.type]
    if (!spec || !spec.input) {
      warnings.push('跳过节点 ' + node.id + '（' + node.type + '）：/object_info 里没有这个类型（前端专用节点）')
      continue
    }
    const byName = incoming.get(node.id) || new Map()
    const required = (spec.input && spec.input.required) || {}
    const optional = (spec.input && spec.input.optional) || {}
    const ordered = [...Object.keys(required), ...Object.keys(optional)]
    const inputs = {}
    let widgetIndex = 0
    for (const name of ordered) {
      const inputSpec = required[name] !== undefined ? required[name] : optional[name]
      const type = specType(inputSpec)

      // 动态增长输入（COMFY_AUTOGROW_V3）：UI 里是 `images.image_1` 这种子输入，API 里是一个对象。
      if (type === 'COMFY_AUTOGROW_V3') {
        const children = {}
        for (const [entryName, origin] of byName) {
          if (entryName !== name && !entryName.startsWith(name + '.')) continue
          const childKey = entryName === name ? 'image_1' : entryName.slice(name.length + 1)
          const ref = toRef(resolveOrigin(origin, new Set()))
          if (ref !== undefined) children[childKey] = ref
        }
        if (Object.keys(children).length > 0) inputs[name] = children
        continue
      }

      // widget 输入即使被提升成插槽接了线，widgets_values 里仍占一格（值是旧的），所以先按 span 吃格，
      // 再看要不要用连线覆盖 —— 否则后面的 widget 会整体错一位（UNETLoader.weight_dtype、KSampler.denoise 都会错）。
      const widget = isWidgetSpec(inputSpec)
      let value
      if (widget) {
        value = node.widgets[widgetIndex]
        widgetIndex += widgetSpan(inputSpec)
      }

      if (byName.has(name)) {
        const ref = toRef(resolveOrigin(byName.get(name), new Set()))
        if (ref !== undefined) inputs[name] = ref
        continue
      }

      if (widget) {
        inputs[name] = value
        if (Array.isArray(inputSpec) && inputSpec[1] && inputSpec[1].options && specType(inputSpec) === 'COMFY_DYNAMICCOMBO_V3') {
          const matched = (inputSpec[1].options || []).some((option) => option.key === value)
          if (!matched) warnings.push('动态 combo ' + node.type + '.' + name + ' 的值 ' + JSON.stringify(value) + ' 不在可选项里')
        }
        continue
      }

      // 可选输入没连线是常态（TextEncodeQwenImage21 的 vae、ResolutionSelector 的 preview 预览、
      // 自定义节点给前端留的预览口）；只有必填输入缺了才值得让用户看见。
      if (required[name] !== undefined) warnNode(node.id, '节点 ' + node.id + '（' + node.type + '）的输入 ' + name + ' 既没连线也不是 widget')
    }
    prompt[node.id] = { class_type: classType, inputs }
  }

  // 第二步：只保留从「出图终点」走得到的节点 —— 开关没选中的改写链、预览节点就此消失。
  if (!options.keepAll) {
    const sinks = Object.keys(prompt).filter((id) => SINK_TYPES.has(prompt[id].class_type))
    if (sinks.length === 0) warnings.push('转换结果里没有任何出图节点（SaveImage / SaveImageAdvanced / PreviewImage）')
    const keep = new Set()
    const stack = [...sinks]
    while (stack.length > 0) {
      const id = stack.pop()
      if (keep.has(id)) continue
      keep.add(id)
      const inputs = prompt[id].inputs
      for (const value of Object.values(inputs)) {
        if (Array.isArray(value) && typeof value[0] === 'string' && prompt[value[0]] !== undefined) stack.push(value[0])
        else if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const child of Object.values(value)) {
            if (Array.isArray(child) && typeof child[0] === 'string' && prompt[child[0]] !== undefined) stack.push(child[0])
          }
        }
      }
    }
    for (const id of Object.keys(prompt)) if (!keep.has(id)) delete prompt[id]
  }

  // 剪枝之后再报节点级警告：被开关剪掉的节点（例如 Qwen 的 TextGenerate 改写链）不该出现在诊断里。
  for (const [id, list] of nodeWarnings) if (prompt[id] !== undefined) warnings.push(...list)

  // 第三步：标出调用方真正要改的参数位置。
  return { prompt, roles: detectRoles(prompt), warnings }
}

/**
 * 标出调用方真正要改的参数位置（提示词 / 尺寸 / 采样 / 源图 / 输出前缀）。
 *
 * 转换流程在剪枝后调用它；用户直接给 API 格式工作流时也用它 —— 两条路径共用同一套角色判定，
 * 这样「内置/自贴的工作流」与「用户自己粘贴的 API 工作流」在插件眼里没有区别。
 */
export function detectRoles(prompt) {
  const roles = { sources: [] }
  for (const [id, node] of Object.entries(prompt)) {
    const inputs = node.inputs || {}
    if (node.class_type === 'TextEncodeQwenImage21' || node.class_type === 'CLIPTextEncode') {
      if (roles.encoder === undefined) roles.encoder = { node: id }
      if (typeof inputs.prompt === 'string' && roles.positive === undefined) roles.positive = { node: id, key: 'prompt' }
      else if (typeof inputs.text === 'string' && roles.positive === undefined) roles.positive = { node: id, key: 'text' }
      if (typeof inputs.negative_prompt === 'string' && roles.negative === undefined) roles.negative = { node: id, key: 'negative_prompt' }
      if (typeof inputs.resolution === 'number' && roles.resolution === undefined) roles.resolution = { node: id, key: 'resolution' }
    }
    if (node.class_type === 'KSampler' && roles.sampler === undefined) {
      roles.sampler = { node: id, keys: { seed: 'seed', steps: 'steps', cfg: 'cfg', sampler: 'sampler_name', scheduler: 'scheduler', denoise: 'denoise' } }
    }
    // 尺寸节点：width/height 可能已经被接线成「分辨率选择器」的引用，插件照样会把它换成字面量。
    if (roles.latent === undefined && /^Empty/.test(String(node.class_type)) && 'width' in inputs && 'height' in inputs) {
      roles.latent = { node: id, keys: { width: 'width', height: 'height' } }
    }
    if (SINK_TYPES.has(node.class_type) && roles.output === undefined && typeof inputs.filename_prefix === 'string') {
      roles.output = { node: id, key: 'filename_prefix' }
    }
    if (node.class_type === 'LoadImage') roles.sources.push({ node: id, key: 'image' })
  }
  // CLIPTextEncode 风格的负向提示词：采样器的 negative 输入指向的那个编码节点。
  if (roles.negative === undefined && roles.sampler !== undefined) {
    const negativeRef = prompt[roles.sampler.node].inputs.negative
    if (Array.isArray(negativeRef)) {
      const negativeNode = prompt[negativeRef[0]]
      if (negativeNode !== undefined && negativeNode.class_type === 'CLIPTextEncode' && typeof negativeNode.inputs.text === 'string') {
        roles.negative = { node: negativeRef[0], key: 'text' }
      }
    }
  }
  // 编辑工作流：encoder 的第一张参考图就是被编辑的原图。
  if (roles.encoder !== undefined) {
    const images = prompt[roles.encoder.node].inputs.images
    if (images && typeof images === 'object' && Array.isArray(images.image_1)) {
      const id = images.image_1[0]
      if (prompt[id] && prompt[id].class_type === 'LoadImage') roles.sourceImage = { node: id, key: 'image' }
    }
  }
  return roles
}

/** 把转换结果写成一份便于人看的摘要（spike / 设置面板诊断都用它）。 */
export function summarizeApi(prompt) {
  const lines = []
  for (const [id, node] of Object.entries(prompt)) {
    const inputs = node.inputs
    const parts = []
    for (const [key, value] of Object.entries(inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string') parts.push(key + ' ← ' + value[0] + ':' + value[1])
      else if (value && typeof value === 'object') parts.push(key + ' ← {' + Object.keys(value).length + ' 项}')
      else {
        const text = typeof value === 'string' ? JSON.stringify(value.length > 60 ? value.slice(0, 60) + '…' : value) : JSON.stringify(value)
        parts.push(key + ' = ' + text)
      }
    }
    lines.push(id + ' ' + node.class_type + (parts.length > 0 ? '  ' + parts.join(', ') : ''))
  }
  return lines.join('\n')
}
