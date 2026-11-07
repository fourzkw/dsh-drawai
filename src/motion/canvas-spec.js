/**
 * 画布上的「视频规格三块」：分镜表 / 风格 / 旁白。
 *
 * 为什么要有这个模块：分镜表以前只活在对话里（或 storyboard.md 里），
 * 于是模型很容易把"每一镜"写成画布上的**一个文本节点**——八镜就是八条，
 * 排版一散，人看不出这是一张表；`motion_project create` 也无从读它。
 *
 * 这里的约定（与 docs/motion-video-playbook.md §4.1 对齐，实现以本文件为准）：
 *
 *   【分镜表】  一张 Markdown 六列表：镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 |
 *               屏幕上出现什么 | 文案 / 声音。时长写成 `172f`（帧）或 `7.2s`。
 *   【风格】    一行一个键值：page #F7F3EA / serif "Noto Serif SC" / materials: kraft
 *   【旁白】    `## shot-N` 分节，一句一行（交给 motion_voice 合成）
 *
 * **一张就是一张**：同一张画布上出现第二个【分镜表】、或者一堆"一镜一个节点"，
 * 都在 validate 里报错 —— 这是这个流程最容易走偏的地方。
 */
export const SPEC_MARKERS = {
  storyboard: '【分镜表】',
  style: '【风格】',
  narration: '【旁白】',
}

const SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/
const TIME_PREFIX = /^\d+(?:\.\d+)?\s*(?:–|—|-|~|至)\s*\d+(?:\.\d+)?\s*s?\b/

export function specNodeOf(doc, marker) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
  for (const node of nodes) {
    const label = typeof node.label === 'string' ? node.label : ''
    if (firstLine(label) === marker) return node
  }
  return null
}

function firstLine(label) {
  return String(label || '').trim().split('\n')[0].trim()
}

function cellText(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

// Cells are stored in the Markdown label so the canvas, AI and video project
// share one source of truth. Escape backslashes first, then pipes and newlines;
// a cell can therefore be edited without creating a new row or column.
export function escapeStoryboardCell(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\\n')
}

// 行尾不带 `|` 也认：手写的表经常漏最后一竖。反斜杠只解码表格约定的
// 三种转义，其他反斜杠保留，以兼容已有文档中的路径等普通文本。
function rowCells(line, escaped = false) {
  let text = String(line || '').trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (!escaped) {
    if (text.endsWith('|')) text = text.slice(0, -1)
    return text.split('|').map(cellText)
  }
  const cells = []
  let cell = ''
  let lastWasSeparator = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1]
      if (next === '\\' || next === '|' || next === 'n') {
        cell += next === 'n' ? '\n' : next
        index += 1
        lastWasSeparator = false
        continue
      }
    }
    if (char === '|') {
      cells.push(cellText(cell))
      cell = ''
      lastWasSeparator = true
    } else {
      cell += char
      if (!/\s/.test(char)) lastWasSeparator = false
    }
  }
  if (!lastWasSeparator || cell.trim().length > 0) cells.push(cellText(cell))
  return cells
}

/**
 * 找出三块规格节点，并顺手诊断"分镜被拆成多条"这件事。
 * @returns {{storyboard: object|null, style: object|null, narration: object|null, split: object[], extras: object[]}}
 */
export function findSpecNodes(doc) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
  const out = { storyboard: null, style: null, narration: null, split: [], extras: [] }
  for (const node of nodes) {
    const label = typeof node.label === 'string' ? node.label : ''
    const head = firstLine(label)
    if (head === SPEC_MARKERS.storyboard) {
      if (out.storyboard === null) out.storyboard = node
      else out.extras.push(node)
      continue
    }
    if (head === SPEC_MARKERS.style) {
      if (out.style === null) out.style = node
      else out.extras.push(node)
      continue
    }
    if (head === SPEC_MARKERS.narration) {
      if (out.narration === null) out.narration = node
      else out.extras.push(node)
      continue
    }
    // 一镜一节点的痕迹：以时间区间开头、带「｜」的一行字（"0.0–0.5s 静物｜…"）。
    if (TIME_PREFIX.test(head) && /[｜|]/.test(label)) out.split.push(node)
  }
  return out
}

/** 把 `172f` / `7.2s` / `0–35f` / `0.0–0.5s` 解析成帧。 */
export function parseFrames(raw, fps = 30) {
  const text = String(raw || '').replace(/\s+/g, '').replace(/帧/g, 'f')
  const rate = Number(fps) > 0 ? Number(fps) : 30
  const single = text.match(/^(\d+(?:\.\d+)?)(f|s)?$/)
  if (single) {
    const value = Number(single[1])
    const unit = single[2] || 'f'
    return { startFrame: null, endFrame: null, durationFrames: Math.max(1, Math.round(unit === 's' ? value * rate : value)) }
  }
  const span = text.match(/^(\d+(?:\.\d+)?)(f|s)?(?:–|—|-|~|至)(\d+(?:\.\d+)?)(f|s)?$/)
  if (!span) return null
  const unit = span[4] || span[2] || 'f'
  const toFrames = (value) => Math.round(unit === 's' ? Number(value) * rate : Number(value))
  // "0.0–0.5s"：区间是**端点**（0 到 0.5 秒），不是"从 0 开始持续 0.5 秒"。
  const a = toFrames(span[1])
  const b = toFrames(span[3])
  return { startFrame: Math.min(a, b), endFrame: Math.max(a, b), durationFrames: Math.abs(b - a) + (unit === 's' ? 0 : 1) }
}

function shotIdOf(raw, index) {
  const text = cellText(raw)
  const num = text.match(/(\d+)/)
  return num ? 'shot-' + String(Number(num[1])) : 'shot-' + (index + 1)
}

/**
 * 解析【分镜表】节点里的那张 Markdown 表。
 * @returns {{rows: object[], problems: string[]}}
 */
export function parseStoryboard(label, options = {}) {
  const fps = Number(options.fps) > 0 ? Number(options.fps) : 30
  const escaped = options.escaped === true
  const lines = String(label || '').split('\n')
  const tableLines = lines.filter((line) => line.trim().startsWith('|'))
  const problems = []
  const rows = []
  if (tableLines.length === 0) {
    problems.push('【分镜表】里没有 Markdown 表格（每行以 | 开头）')
    return { rows, problems }
  }
  const body = tableLines.filter((line) => SEPARATOR.test(line.trim()) === false)
  const header = body.shift()
  const headerCells = rowCells(header, escaped)
  if (headerCells.length !== 6) problems.push('表头应该是六列（镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音），现在是 ' + headerCells.length + ' 列')
  let cursor = 0
  for (const line of body) {
    const cells = rowCells(line, escaped)
    if (cells.length === 0) continue
    if (cells.length !== 6) {
      problems.push('第 ' + (rows.length + 1) + ' 行有 ' + cells.length + ' 列（应为 6 列）：' + line.trim().slice(0, 40))
    }
    const shot = shotIdOf(cells[0], rows.length)
    const frames = parseFrames(cells[1], fps)
    const durationFrames = frames === null ? 0 : frames.durationFrames
    const startFrame = frames === null || frames.startFrame === null ? cursor : frames.startFrame
    if (frames === null) problems.push(shot + ' 的帧区间读不出来（"' + cells[1] + '"）：写成 `0–35f` 或 `1.5s`')
    rows.push({
      shot,
      startFrame,
      durationFrames,
      endFrame: startFrame + Math.max(0, durationFrames) - 1,
      card: cells[2] === '—' || cells[2] === '-' ? '' : cells[2],
      intent: cells[3] === '—' ? '' : cells[3],
      onScreen: cells[4] === '—' ? '' : cells[4],
      copy: cells[5] === '—' ? '' : cells[5],
    })
    cursor = startFrame + Math.max(1, durationFrames)
  }
  return { rows, problems }
}

/** 【风格】节点：`page #F7F3EA`、`serif "Noto Serif SC"`、`materials: kraft, ink`。 */
export function parseStyle(label) {
  const tokens = {}
  const fonts = {}
  const materials = []
  const problems = []
  for (const raw of String(label || '').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line === SPEC_MARKERS.style) continue
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*[:=]?\s+(.+)$/)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    const value = pair[2].trim().replace(/^["'「]|["'」]$/g, '')
    if (key === 'materials') {
      materials.push(...value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))
      continue
    }
    if (key === 'serif' || key === 'sans' || key === 'mono' || key === 'font') {
      fonts[key === 'font' ? 'sans' : key] = value
      continue
    }
    // 一行里塞了多个键（`page #F7F3EA accent #C0FF00`）非常常见，而且解析起来没有歧义：
    // 直接全收下。旧版把这种行判成"不是颜色"，错误信息指向完全错误的地方。
    const pairs = [...line.matchAll(/([A-Za-z][A-Za-z0-9_-]*)\s*[:=]?\s*(#[0-9a-f]{3,8})\b/gi)]
    if (pairs.length > 0) {
      for (const match of pairs) tokens[match[1].toLowerCase()] = match[2]
      continue
    }
    problems.push('【风格】里 "' + line.slice(0, 40) + '" 没认出颜色或字体（写成 `page #F7F3EA` 或 `serif "Noto Serif SC"`）')
  }
  return { tokens, fonts, materials, problems }
}

/** 【旁白】节点：`## shot-1` 分节，每句一行。 */
export function parseNarration(label) {
  const sections = []
  const problems = []
  let current = null
  for (const raw of String(label || '').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line === SPEC_MARKERS.narration) continue
    const heading = line.match(/^#{1,3}\s*(shot[-\s]?\d+)\s*$/i)
    if (heading) {
      current = { shot: 'shot-' + String(Number(heading[1].match(/\d+/)[0])), lines: [] }
      sections.push(current)
      continue
    }
    if (current === null) {
      problems.push('【旁白】里 "' + line.slice(0, 24) + '" 前面没有 ## shot-N 分节')
      continue
    }
    current.lines.push(line)
  }
  return { sections, problems }
}

/**
 * 读画布上的规格三块。`fps` 用来把 `0.5s` 换算成帧（优先用视频节点上存的值）。
 */
export function readCanvasSpec(doc, options = {}) {
  const found = findSpecNodes(doc)
  const fps = Number(options.fps) > 0 ? Number(options.fps) : 30
  const storyboard = found.storyboard ? parseStoryboard(found.storyboard.label, {
    fps, escaped: found.storyboard.data?.drawaiTableEscaped === '1',
  }) : { rows: [], problems: [] }
  const style = found.style ? parseStyle(found.style.label) : { tokens: {}, fonts: {}, materials: [], problems: [] }
  const narration = found.narration ? parseNarration(found.narration.label) : { sections: [], problems: [] }
  const problems = [
    ...(found.storyboard ? [] : ['画布上还没有【分镜表】节点：先 motion_spec{action:"scaffold"} 建一张，再往里填各镜']),
    ...storyboard.problems,
    ...style.problems,
    ...narration.problems,
  ]
  if (found.split.length > 0) {
    problems.push('分镜被拆成了 ' + found.split.length + ' 个节点（' + found.split.map((node) => node.id).join(', ')
      + '）：分镜表只能有一张，用一张表把每一镜写成一行')
  }
  if (found.extras.length > 0) {
    problems.push('有多余的规格节点（' + found.extras.map((node) => node.id).join(', ') + '）：【分镜表】/【风格】/【旁白】各只该有一个')
  }
  return { storyboard: storyboard.rows, style, narration, problems, nodes: { storyboard: found.storyboard?.id ?? null, style: found.style?.id ?? null, narration: found.narration?.id ?? null } }
}

/**
 * 校验画布规格跟视频节点对不对得上（motion_spec{action:"validate"} 的结果）。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateCanvasSpec(doc, options = {}) {
  const spec = options.spec || {}
  const fps = Number(spec.fps) > 0 ? Number(spec.fps) : 30
  const totalFrames = Number(spec.totalFrames) > 0 ? Number(spec.totalFrames) : (Number(spec.duration) > 0 ? Math.round(Number(spec.duration) * fps) : 0)
  const read = readCanvasSpec(doc, { fps })
  const errors = []
  const warnings = []
  const found = findSpecNodes(doc)
  if (found.split.length > 0) errors.push('分镜表被拆成了 ' + found.split.length + ' 条：' + found.split.map((node) => node.id).join(', ') + '（只留一张【分镜表】）')
  if (found.extras.length > 0) errors.push('重复的规格节点：' + found.extras.map((node) => node.id).join(', '))
  if (found.storyboard === null) errors.push('缺【分镜表】节点')
  const rows = read.storyboard
  if (found.storyboard !== null) {
    if (rows.length === 0) errors.push('【分镜表】里没有数据行')
    let cursor = 0
    for (const [index, row] of rows.entries()) {
      if (row.shot !== 'shot-' + (index + 1)) errors.push('镜号要连号：第 ' + (index + 1) + ' 行是 ' + row.shot)
      if (row.durationFrames <= 0) errors.push(row.shot + ' 没有有效时长')
      if (row.startFrame !== cursor) warnings.push(row.shot + ' 从第 ' + row.startFrame + ' 帧开始，但上一镜结束在 ' + (cursor - 1) + ' 帧（表里的帧区间要连续）')
      cursor = row.startFrame + Math.max(1, row.durationFrames)
      if (!row.intent) warnings.push(row.shot + ' 没写"这一镜要做什么"')
      if (!row.onScreen) warnings.push(row.shot + ' 没写"屏幕上出现什么"')
    }
    if (totalFrames > 0 && cursor !== totalFrames) {
      const delta = totalFrames - cursor
      errors.push('各镜加起来是 ' + cursor + ' 帧，视频节点是 ' + totalFrames + ' 帧（' + (delta > 0 ? '少 ' : '多 ') + Math.abs(delta) + ' 帧）：'
        + '两者必须相等。两种改法任选：把' + (delta > 0 ? '最后一镜延长 ' + delta + ' 帧' : '镜头删减/缩短共 ' + (-delta) + ' 帧')
        + '，或把视频节点时长改成 ' + (cursor / fps) + ' 秒（motion_project create 的 spec.duration，现有工程改 timeline.json 的 durationInFrames）')
    }
  }
  if (read.style.tokens && Object.keys(read.style.tokens).length === 0 && found.style !== null) {
    warnings.push('【风格】里没有认出任何颜色（写成 `page #F7F3EA`）')
  }
  return { errors, warnings, read }
}

/** 一行分镜 → 表格行（帧区间写成 `0–35f`）。 */
export function storyboardRowLine(row) {
  const start = Number(row.startFrame) || 0
  const duration = Math.max(1, Number(row.durationFrames) || 1)
  return '| ' + [row.shot, start + '–' + (start + duration - 1) + 'f', row.card || '—', row.intent || '—', row.onScreen || '—', row.copy || '—']
    .map(escapeStoryboardCell).join(' | ') + ' |'
}

export const STORYBOARD_HEADER = '| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音 |\n| --- | --- | --- | --- | --- | --- |'

/**
 * 把外部给的分镜（数组或 markdown）排成一张表。
 * 数组项的 frames / duration 优先；否则在 totalFrames 里均分。
 */
export function storyboardTable(input, options = {}) {
  const fps = Number(options.fps) > 0 ? Number(options.fps) : 30
  if (typeof input === 'string') {
    const text = input.trim().replace(/^【分镜表】\s*\n/, '')
    if (text.startsWith('|')) {
      const lines = text.split('\n')
      // A complete Markdown table already contains its header and separator.
      // Row-only input still receives the canonical header as before.
      if (lines.length > 1 && SEPARATOR.test(lines[1].trim())) return text
      return STORYBOARD_HEADER + '\n' + text
    }
  }
  const list = Array.isArray(input) ? input : []
  const total = Number(options.totalFrames) > 0 ? Number(options.totalFrames) : 0
  const per = list.length > 0 && total > 0 ? Math.floor(total / list.length) : Math.round(fps * 2)
  const rows = []
  let cursor = 0
  list.forEach((item, index) => {
    const row = typeof item === 'string' ? { intent: item } : (item || {})
    const own = Number(row.durationFrames) > 0 ? Number(row.durationFrames) : (Number(row.frames) > 0 ? Number(row.frames) : per)
    const duration = index === list.length - 1 && total > 0 ? Math.max(1, total - cursor) : Math.max(1, own)
    rows.push({
      shot: 'shot-' + (index + 1),
      startFrame: cursor,
      durationFrames: duration,
      card: row.card || '',
      intent: row.intent || row.what || row.beats || '',
      onScreen: row.onScreen || row.screen || '',
      copy: row.copy || '',
    })
    cursor += duration
  })
  return STORYBOARD_HEADER + '\n' + rows.map(storyboardRowLine).join('\n')
}

export function styleTemplate(style) {
  if (typeof style === 'string' && style.trim().length > 0) return SPEC_MARKERS.style + '\n' + style.trim()
  const palette = (style && style.palette) || {}
  const fonts = (style && style.fonts) || {}
  const lines = [SPEC_MARKERS.style]
  for (const key of ['page', 'text', 'muted', 'accent', 'surface', 'field', 'border']) {
    if (palette[key]) lines.push(key + ' ' + palette[key])
  }
  if (fonts.display) lines.push('serif "' + fonts.display + '"')
  if (fonts.text) lines.push('sans "' + fonts.text + '"')
  if (fonts.mono) lines.push('mono "' + fonts.mono + '"')
  if (style && Array.isArray(style.materials) && style.materials.length) lines.push('materials: ' + style.materials.join(', '))
  if (lines.length === 1) {
    lines.push('page #F7F3EA', 'text #2B2B2B', 'muted #8A8578', 'accent #C0392B', 'border #D9D3C3')
  }
  return lines.join('\n')
}

const SPEC_WIDTH = { storyboard: 700, style: 440, narration: 440 }

/**
 * 生成规格区的 diagram_apply ops：优先放视频左侧，空间不足时择优放到右侧。
 *
 * 只在缺的时候建：已经有【分镜表】就不再建第二张（那正是要避免的事）。
 */
export function scaffoldOps(doc, options = {}) {
  const found = findSpecNodes(doc)
  const video = options.videoNode || null
  const pending = []
  const push = (marker, label, width, data) => {
    // Estimate wrapped monospace lines as well as explicit newlines, including wide CJK characters.
    const capacity = Math.max(1, Math.floor((width - 24) / 7.2))
    const lines = label.split('\n').reduce((sum, line) => {
      const cells = Array.from(line).reduce((n, char) => n + (char.codePointAt(0) >= 0x2e80 ? 2 : 1), 0)
      return sum + Math.max(1, Math.ceil(cells / capacity))
    }, 0)
    pending.push({ marker, label, width, data, height: Math.max(80, Math.min(2000, 28 + lines * 18)) })
  }
  if (found.storyboard === null) push(SPEC_MARKERS.storyboard, SPEC_MARKERS.storyboard + '\n' + storyboardTable(options.storyboard || [], options), SPEC_WIDTH.storyboard,
    typeof options.storyboard === 'string' ? undefined : { drawaiTableEscaped: '1' })
  if (found.style === null) push(SPEC_MARKERS.style, options.style === undefined ? styleTemplate(options.styleKit || null) : styleTemplate(options.style), SPEC_WIDTH.style)
  if (found.narration === null && options.narration !== undefined) {
    push(SPEC_MARKERS.narration, SPEC_MARKERS.narration + '\n' + String(options.narration).trim(), SPEC_WIDTH.narration)
  }
  const validVideo = video && Number.isFinite(Number(video.x)) && Number.isFinite(Number(video.y))
  const baseY = validVideo ? Math.max(40, Number(video.y) - 380) : 170
  const width = Math.max(0, ...pending.map(item => item.width))
  const height = pending.reduce((sum, item) => sum + item.height, 0) + Math.max(0, pending.length - 1) * 56
  const candidates = validVideo
    ? [Number(video.x) - width - 140, Number(video.x) + Math.max(0, Number(video.w) || 0) + 140].filter(x => x >= 40)
    : [60]
  const obstacles = (Array.isArray(doc?.nodes) ? doc.nodes : []).filter(node =>
    Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y)) && Number(node.w) > 0 && Number(node.h) > 0)
  const placement = candidates.map((x, index) => {
    let y = baseY
    // Keep the entire column clear of existing nodes; shift past any blocking rectangles.
    for (let attempt = 0; attempt <= obstacles.length; attempt++) {
      const hits = obstacles.filter(node => x < Number(node.x) + Number(node.w) + 50 && x + width + 50 > Number(node.x)
        && y < Number(node.y) + Number(node.h) + 50 && y + height + 50 > Number(node.y))
      if (!hits.length) break
      y = Math.max(...hits.map(node => Number(node.y) + Number(node.h) + 50))
    }
    return { x, y, score: y - baseY + index * 10 }
  }).sort((a, b) => a.score - b.score)[0] || { x: 60, y: baseY }
  let y = placement.y
  const ops = pending.map(item => {
    const op = { op: 'addNode', shape: 'text', label: item.label, x: placement.x, y, w: item.width, h: item.height,
      style: 'rounded=0;whiteSpace=wrap;html=1;fontSize=12;align=left;verticalAlign=top;fontFamily=monospace;fillColor=none;strokeColor=#c8c2b4;' }
    if (item.data) op.data = item.data
    y += item.height + 56
    return op
  })
  return { ops, created: pending.map(item => item.marker), already: [found.storyboard ? SPEC_MARKERS.storyboard : '', found.style ? SPEC_MARKERS.style : '', found.narration ? SPEC_MARKERS.narration : ''].filter(Boolean) }
}
