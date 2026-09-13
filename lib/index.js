/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/**
 * dsh-drawai —— 宿主半边（Host half）· 源文件
 *
 * 这是**源文件**，不要改 lib/index.js —— 那个由 tools/build.mjs 生成。
 *
 * 不需要语法转换：本文件是可直接运行的 ESM。构建器只加一行生成标记，
 * 所以宿主半边改完只要 `npm run build` + 重启 dsh web 就生效
 * （客户端半边有热重载，宿主半边没有 —— 宿主只在启动时加载一次）。
 *
 * 导出形式与 DSH 全部参考包一致：{ name, inject, apply }。
 * 注册的工具：
 *   - diagram_read  读回画布文档（节点/边/形状/配色）
 *   - diagram_apply 施加结构化编辑 → 分层自动布局 → 原子写回
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath, join as joinPath } from 'node:path'

/**
 * 列目录走 Node 标准库。
 *
 * 为什么不用 ctx.fs：实测这个 DSH 版本的 ctx.fs **既没有 list 也没有 readRelated**
 * （诊断原话："ctx.fs 没有 list 方法 / ctx.fs 没有 readRelated 方法"）——
 * 我先后猜过这两个 API，都错了。插件本来就跑在宿主进程里，stdlib 一定可用。
 *
 * 沙箱围栏不受影响：**写盘**仍然全部走 ctx.fs.writeText（带策略），
 * 这里只做"列目录"这一件读操作。
 */
const nodeReaddir = readdir

/** 把可能相对的路径归一成绝对路径（宿主工作目录兜底）。 */
function toAbsolute(p, cwd) {
  const s = String(p === undefined || p === null ? '' : p)
  if (isAbsolute(s)) return s
  return joinPath(cwd === undefined || cwd === null || cwd.length === 0 ? process.cwd() : cwd, s)
}

const DEFAULT_PATH = 'demo.dshd.json'
const DEFAULT_W = 170
const DEFAULT_H = 56
const GAP_PRIMARY = 90
const GAP_CROSS = 40
const LAYOUTS = ['dagre-lr', 'dagre-tb', 'grid', 'none']

/**
 * 连线的线型与箭头。
 *
 * 存在文档里的是**语义**（dashed / both），不是 SVG 属性（stroke-dasharray="6 4"）。
 * 渲染参数属于客户端：换个主题、调个间距不该改动文档，而且 AI 说"这条改成虚线"
 * 也不该需要知道虚线是 6 还是 8 个像素。
 */
const DASHES = ['solid', 'dashed', 'dotted']
const ARROWS = ['end', 'both', 'none', 'start']

/** 容忍模型的口语说法：只为降低"op 被拒"的概率，落盘一律归一成上面那几个值。 */
function normalizeDash(value) {
  const v = String(value).toLowerCase().trim()
  if (v === 'solid' || v === 'line' || v === 'normal' || v === '实线') return 'solid'
  if (v === 'dashed' || v === 'dash' || v === '虚线') return 'dashed'
  if (v === 'dotted' || v === 'dot' || v === '点线' || v === '点状') return 'dotted'
  return null
}

function normalizeArrow(value) {
  const v = String(value).toLowerCase().trim()
  if (v === 'end' || v === 'forward' || v === 'target' || v === '单向') return 'end'
  if (v === 'both' || v === 'bidirectional' || v === '双向' || v === 'double') return 'both'
  if (v === 'none' || v === 'false' || v === '无') return 'none'
  if (v === 'start' || v === 'backward' || v === 'source' || v === '反向') return 'start'
  return null
}

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** 单字符显示宽度：CJK / 全角按一倍字宽，其余按 0.55 倍（近似 Helvetica）。 */
function charWidth(ch, size) {
  const code = ch.codePointAt(0)
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  return wide ? size : size * 0.55
}

/** 按标签估算节点宽度并夹在 [130, 300]，避免模型手算尺寸。 */
function estimateWidth(label) {
  const chars = Array.from(String(label))
  let w = 34
  for (let i = 0; i < chars.length; i += 1) w += charWidth(chars[i], 12)
  if (w < 130) return 130
  if (w > 300) return 300
  return Math.round(w)
}

/** 扫描 `<prefix><n>` 形式的 id，返回 max+1 —— 多轮迭代不会打乱已有编号。 */
function nextId(list, prefix) {
  let max = 0
  const re = new RegExp('^' + prefix + '(\\d+)$')
  for (let i = 0; i < list.length; i += 1) {
    const m = re.exec(String(list[i].id))
    if (m !== null) {
      const n = parseInt(m[1], 10)
      if (n > max) max = n
    }
  }
  return prefix + (max + 1)
}

function emptyDoc() {
  return { version: 1, revision: 0, meta: { engine: 'drawio-svg', layout: 'dagre-tb' }, nodes: [], edges: [] }
}

function normalizeDoc(raw) {
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    meta: raw.meta !== null && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : { engine: 'drawio-svg' },
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
  }
}

/**
 * 施加 ops。语义校验在这里：任何指向不存在节点的边、任何未知 id，都直接抛错并列出已知节点，
 * 于是失败发生在写盘之前 —— 不会画出半张烂图。
 */
function applyOps(doc, ops) {
  const notes = []
  function findNode(id) {
    for (let i = 0; i < doc.nodes.length; i += 1) if (doc.nodes[i].id === id) return i
    return -1
  }
  function findEdge(id) {
    for (let i = 0; i < doc.edges.length; i += 1) if (doc.edges[i].id === id) return i
    return -1
  }
  function known() {
    const ids = []
    for (let i = 0; i < doc.nodes.length; i += 1) ids.push(doc.nodes[i].id)
    return ids.length === 0 ? '(none)' : ids.join(', ')
  }

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new Error('ops[' + i + '] must be an object like { op: "addNode", label: "..." }')
    }
    const kind = op.op

    if (kind === 'addNode') {
      const label = typeof op.label === 'string' && op.label.length > 0 ? op.label : undefined
      if (label === undefined) throw new Error('ops[' + i + '] addNode needs a non-empty string "label"')
      let id = typeof op.id === 'string' && op.id.length > 0 ? op.id : undefined
      if (id !== undefined && findNode(id) >= 0) {
        throw new Error('ops[' + i + '] addNode: node "' + id + '" already exists. Use setLabel to change it, or omit "id" to auto-allocate one.')
      }
      if (id === undefined) id = nextId(doc.nodes, 'n')
      const node = {
        id: id,
        shape: typeof op.shape === 'string' ? op.shape : 'rect',
        style: typeof op.style === 'string' ? op.style : 'blue',
        w: numberOr(op.w, estimateWidth(label)),
        h: numberOr(op.h, DEFAULT_H),
        label: label,
      }
      // 关键：只有显式给了坐标才写入。缺省写 (0,0) 会让 placeMissing 以为"坐标齐全"而不补位，
      // 新节点就会堆在原点压住别人。
      if (has(op, 'x')) node.x = numberOr(op.x, 0)
      if (has(op, 'y')) node.y = numberOr(op.y, 0)
      doc.nodes.push(node)
      notes.push('+ node ' + id + ' "' + label + '"' + (has(op, 'x') || has(op, 'y') ? ' at explicit coords' : ' (position pending)'))
      continue
    }

    if (kind === 'addEdge') {
      const from = typeof op.from === 'string' ? op.from : undefined
      const to = typeof op.to === 'string' ? op.to : undefined
      if (from === undefined || to === undefined) throw new Error('ops[' + i + '] addEdge needs string "from" and "to"')
      if (findNode(from) < 0) throw new Error('ops[' + i + '] addEdge: unknown "from" node "' + from + '". Known nodes: ' + known())
      if (findNode(to) < 0) throw new Error('ops[' + i + '] addEdge: unknown "to" node "' + to + '". Known nodes: ' + known())
      let id = typeof op.id === 'string' && op.id.length > 0 ? op.id : undefined
      if (id !== undefined && findEdge(id) >= 0) throw new Error('ops[' + i + '] addEdge: edge "' + id + '" already exists')
      if (id === undefined) id = nextId(doc.edges, 'e')
      const edge = { id: id, from: from, to: to }
      if (typeof op.label === 'string' && op.label.length > 0) edge.label = op.label
      // 建边时就能带上画法：AI 想表达"这是一条异步/可选依赖"时，
      // 不该被迫先 addEdge 再补一次 setStyle（两次写盘、两次往返）。
      if (typeof op.dash === 'string') {
        const dash = normalizeDash(op.dash)
        if (dash === null) throw new Error('ops[' + i + '] addEdge: unknown dash "' + op.dash + '"; use ' + DASHES.join(', '))
        if (dash !== 'solid') edge.dash = dash
      }
      if (typeof op.arrow === 'string') {
        const arrow = normalizeArrow(op.arrow)
        if (arrow === null) throw new Error('ops[' + i + '] addEdge: unknown arrow "' + op.arrow + '"; use ' + ARROWS.join(', '))
        if (arrow !== 'end') edge.arrow = arrow
      }
      if (typeof op.color === 'string' && op.color.length > 0) edge.color = op.color
      doc.edges.push(edge)
      notes.push('+ edge ' + id + ' ' + from + ' -> ' + to + (edge.dash !== undefined ? ' [' + edge.dash + ']' : '') + (edge.arrow !== undefined ? ' [' + edge.arrow + ']' : ''))
      continue
    }

    if (kind === 'setLabel') {
      const id = typeof op.id === 'string' ? op.id : undefined
      const label = typeof op.label === 'string' ? op.label : undefined
      if (id === undefined || label === undefined) throw new Error('ops[' + i + '] setLabel needs string "id" and "label"')
      const ni = findNode(id)
      if (ni >= 0) {
        doc.nodes[ni].label = label
        notes.push('~ node ' + id + ' label = "' + label + '"')
        continue
      }
      const ei = findEdge(id)
      if (ei >= 0) {
        doc.edges[ei].label = label
        notes.push('~ edge ' + id + ' label = "' + label + '"')
        continue
      }
      throw new Error('ops[' + i + '] setLabel: unknown id "' + id + '". Known nodes: ' + known())
    }

    if (kind === 'setStyle') {
      const id = typeof op.id === 'string' ? op.id : undefined
      if (id === undefined) throw new Error('ops[' + i + '] setStyle needs string "id"')
      const ni = findNode(id)
      if (ni < 0) {
        // 连线也归 setStyle 管 —— 节点的"画法"是 shape/style，连线的"画法"是线型/箭头/颜色。
        // 分成两个 op 只是多一条要记的规则，对模型和人都没有好处。
        const ei = findEdge(id)
        if (ei < 0) throw new Error('ops[' + i + '] setStyle: unknown node or edge "' + id + '". Known nodes: ' + known())
        const edge = doc.edges[ei]
        if (typeof op.dash === 'string') {
          const dash = normalizeDash(op.dash)
          if (dash === null) throw new Error('ops[' + i + '] setStyle: unknown dash "' + op.dash + '"; use ' + DASHES.join(', '))
          if (dash === 'solid') delete edge.dash
          else edge.dash = dash
        }
        if (typeof op.arrow === 'string') {
          const arrow = normalizeArrow(op.arrow)
          if (arrow === null) throw new Error('ops[' + i + '] setStyle: unknown arrow "' + op.arrow + '"; use ' + ARROWS.join(', '))
          if (arrow === 'end') delete edge.arrow
          else edge.arrow = arrow
        }
        if (typeof op.color === 'string') {
          if (op.color.length === 0) delete edge.color
          else edge.color = op.color
        }
        notes.push('~ edge ' + id + ' style')
        continue
      }
      const node = doc.nodes[ni]
      if (typeof op.shape === 'string') node.shape = op.shape
      if (typeof op.style === 'string') node.style = op.style
      if (has(op, 'w')) node.w = numberOr(op.w, node.w)
      if (has(op, 'h')) node.h = numberOr(op.h, node.h)
      notes.push('~ node ' + id + ' style')
      continue
    }

    if (kind === 'remove') {
      const id = typeof op.id === 'string' ? op.id : undefined
      if (id === undefined) throw new Error('ops[' + i + '] remove needs string "id"')
      const ni = findNode(id)
      if (ni >= 0) {
        doc.nodes.splice(ni, 1)
        const kept = []
        let dropped = 0
        for (let k = 0; k < doc.edges.length; k += 1) {
          const e = doc.edges[k]
          if (e.from === id || e.to === id) dropped += 1
          else kept.push(e)
        }
        doc.edges = kept
        notes.push('- node ' + id + (dropped > 0 ? ' (and ' + dropped + ' edge(s))' : ''))
        continue
      }
      const ei = findEdge(id)
      if (ei >= 0) {
        doc.edges.splice(ei, 1)
        notes.push('- edge ' + id)
        continue
      }
      throw new Error('ops[' + i + '] remove: unknown id "' + id + '". Known nodes: ' + known())
    }

    throw new Error('ops[' + i + '] unknown op ' + JSON.stringify(kind) + '. Supported: addNode, addEdge, setLabel, setStyle, remove')
  }
  return notes
}

/** 分层自动布局：DFS 去回边 → 最长路径分层 → 重心排序减交叉 → 逐层居中定位。 */
function autoLayout(doc, mode) {
  const nodes = doc.nodes
  if (nodes.length === 0) return

  if (mode === 'grid') {
    const cols = Math.max(1, Math.round(Math.sqrt(nodes.length)))
    const rows = Math.ceil(nodes.length / cols)
    const colW = []
    for (let c = 0; c < cols; c += 1) colW.push(0)
    const rowH = []
    for (let r = 0; r < rows; r += 1) rowH.push(0)
    for (let i = 0; i < nodes.length; i += 1) {
      const c = i % cols
      const r = Math.floor(i / cols)
      const w = numberOr(nodes[i].w, DEFAULT_W)
      const h = numberOr(nodes[i].h, DEFAULT_H)
      if (w > colW[c]) colW[c] = w
      if (h > rowH[r]) rowH[r] = h
    }
    const colX = []
    let px = 0
    for (let c = 0; c < cols; c += 1) {
      colX.push(px)
      px += colW[c] + GAP_CROSS
    }
    const rowY = []
    let py = 0
    for (let r = 0; r < rows; r += 1) {
      rowY.push(py)
      py += rowH[r] + GAP_CROSS
    }
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].x = colX[i % cols]
      nodes[i].y = rowY[Math.floor(i / cols)]
    }
    return
  }

  const index = {}
  for (let i = 0; i < nodes.length; i += 1) index[nodes[i].id] = i

  const outgoing = {}
  for (let i = 0; i < doc.edges.length; i += 1) {
    const e = doc.edges[i]
    if (index[e.from] === undefined || index[e.to] === undefined) continue
    if (e.from === e.to) continue
    const key = typeof e.id === 'string' ? e.id : '#' + i
    if (outgoing[e.from] === undefined) outgoing[e.from] = []
    outgoing[e.from].push({ to: e.to, key: key })
  }

  // 去掉回边，保证分层在含环图上收敛（否则层号会一轮轮涨到爆）。
  const color = {}
  const isBack = {}
  function visit(id) {
    color[id] = 1
    const list = outgoing[id] === undefined ? [] : outgoing[id]
    for (let i = 0; i < list.length; i += 1) {
      const target = list[i].to
      if (color[target] === 1) {
        isBack[list[i].key] = true
        continue
      }
      if (color[target] === undefined) visit(target)
    }
    color[id] = 2
  }
  for (let i = 0; i < nodes.length; i += 1) if (color[nodes[i].id] === undefined) visit(nodes[i].id)

  const usedEdges = []
  for (let i = 0; i < doc.edges.length; i += 1) {
    const e = doc.edges[i]
    if (index[e.from] === undefined || index[e.to] === undefined) continue
    if (e.from === e.to) continue
    const key = typeof e.id === 'string' ? e.id : '#' + i
    if (isBack[key] === true) continue
    usedEdges.push(e)
  }

  const layer = {}
  for (let i = 0; i < nodes.length; i += 1) layer[nodes[i].id] = 0
  for (let iter = 0; iter < nodes.length; iter += 1) {
    let changed = false
    for (let i = 0; i < usedEdges.length; i += 1) {
      const e = usedEdges[i]
      if (layer[e.to] < layer[e.from] + 1) {
        layer[e.to] = layer[e.from] + 1
        changed = true
      }
    }
    if (!changed) break
  }

  let top = 0
  for (let i = 0; i < nodes.length; i += 1) if (layer[nodes[i].id] > top) top = layer[nodes[i].id]
  const buckets = []
  for (let L = 0; L <= top; L += 1) buckets.push([])
  for (let i = 0; i < nodes.length; i += 1) buckets[layer[nodes[i].id]].push(nodes[i])

  const pos = {}
  for (let L = 0; L <= top; L += 1) for (let i = 0; i < buckets[L].length; i += 1) pos[buckets[L][i].id] = i
  const preds = {}
  for (let i = 0; i < usedEdges.length; i += 1) {
    const e = usedEdges[i]
    if (preds[e.to] === undefined) preds[e.to] = []
    preds[e.to].push(e.from)
  }
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let L = 1; L <= top; L += 1) {
      const row = buckets[L]
      if (row.length < 2) continue
      const score = {}
      for (let i = 0; i < row.length; i += 1) {
        const id = row[i].id
        const list = preds[id]
        let sum = 0
        let count = 0
        if (list !== undefined) {
          for (let k = 0; k < list.length; k += 1) {
            const p = pos[list[k]]
            if (p !== undefined) {
              sum += p
              count += 1
            }
          }
        }
        score[id] = count > 0 ? sum / count : pos[id]
      }
      row.sort(function (a, b) {
        const d = score[a.id] - score[b.id]
        if (d !== 0) return d
        return pos[a.id] - pos[b.id]
      })
      for (let i = 0; i < row.length; i += 1) pos[row[i].id] = i
    }
  }

  const horizontal = mode !== 'dagre-tb'
  const thick = []
  const cross = []
  for (let L = 0; L <= top; L += 1) {
    let t = 0
    let c = 0
    for (let i = 0; i < buckets[L].length; i += 1) {
      const n = buckets[L][i]
      const w = numberOr(n.w, DEFAULT_W)
      const h = numberOr(n.h, DEFAULT_H)
      const primary = horizontal ? w : h
      const secondary = horizontal ? h : w
      if (primary > t) t = primary
      c += secondary + (i > 0 ? GAP_CROSS : 0)
    }
    thick.push(t)
    cross.push(c)
  }
  let maxCross = 0
  for (let L = 0; L <= top; L += 1) if (cross[L] > maxCross) maxCross = cross[L]

  let along = 0
  for (let L = 0; L <= top; L += 1) {
    let offset = (maxCross - cross[L]) / 2
    for (let i = 0; i < buckets[L].length; i += 1) {
      const n = buckets[L][i]
      const w = numberOr(n.w, DEFAULT_W)
      const h = numberOr(n.h, DEFAULT_H)
      if (horizontal) {
        n.x = Math.round(along)
        n.y = Math.round(offset)
      } else {
        n.y = Math.round(along)
        n.x = Math.round(offset)
      }
      offset += (horizontal ? h : w) + GAP_CROSS
    }
    along += thick[L] + GAP_PRIMARY
  }
}

/** `layout:'none'` 时的补位：只补缺失的那一轴，不覆盖已给的坐标。 */
function placeMissing(doc) {
  let maxY = 0
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    if (Number.isFinite(Number(n.y))) {
      const bottom = Number(n.y) + numberOr(n.h, DEFAULT_H)
      if (bottom > maxY) maxY = bottom
    }
  }
  let slot = 0
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    const hasX = Number.isFinite(Number(n.x))
    const hasY = Number.isFinite(Number(n.y))
    if (hasX && hasY) continue
    if (!hasX) n.x = slot * (DEFAULT_W + GAP_CROSS)
    if (!hasY) n.y = maxY + 80
    slot += 1
  }
}

/** 画布写回端点：人工编辑唯一的落盘通道。 */
export const SAVE_PATH = '/drawai/api/save'
/** 「打开」菜单最多下钻几个子目录 —— 不做全盘递归，避免撞上 node_modules 这类大目录。 */
const MAX_SCAN_DIRS = 12
/** 自定义请求头 —— 跨站表单设不了它，跨域 fetch 会被预检拦住（CSRF 围栏）。 */
export const SAVE_HEADER = 'x-drawai-save'
/** 请求体上限，防止一次误发把内存打满。 */
const SAVE_MAX_BYTES = 4 * 1024 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body exceeds ' + limitBytes + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export const name = 'drawai'
export const inject = ['tools', 'fs', 'sessions', 'sandboxPolicy', 'webServer']

/**
 * 列出工作区里的画布文档（非递归进子目录，最多扫 MAX_SCAN_DIRS 个）。
 *
 * **列目录的 API 是 `list`，不是 `readRelated`**。之前用 readRelated 是错的：
 * dsh-api-workspace-files 的类型注释写得很明确 ——
 *   read / readBytes / stat / changes 用**绝对路径**；
 *   `list` speaks workspace paths，因为它的消费者是"以工作区根为根的树"。
 * 而且旧实现把异常整个吞掉（catch → null），于是"读不到目录"只表现为**空列表**，
 * 界面上就是"找不到文件"，看不出任何原因。现在：优先 list、失败退回 readRelated、
 * 两者都失败就把错误带回调用方显示。
 *
 * 只扫一层子目录：画布文档按惯例都在根目录或一层子目录下；递归全盘扫描既慢，
 * 又可能撞上 node_modules 这类大目录。
 */
async function listCanvases(root, cwd, dir) {
  const found = []
  const seen = {}
  const dirs = []
  const notes = []

  async function readDir(absPath) {
    try {
      const entries = await nodeReaddir(absPath, { withFileTypes: true })
      return { entries: entries, error: '' }
    } catch (error) {
      return { entries: null, error: messageOf(error) }
    }
  }

  function collect(entries, prefix) {
    if (!Array.isArray(entries)) return
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? entry.name : null
      if (typeof name !== 'string' || name.length === 0) continue
      const isDir =
        entry !== null && typeof entry === 'object'
          ? typeof entry.isDirectory === 'function'
            ? entry.isDirectory()
            : entry.kind === 'directory' || entry.type === 'directory' || entry.isDirectory === true
          : false
      const rel = prefix.length === 0 ? name : prefix + '/' + name
      if (!isDir && name.toLowerCase().endsWith('.dshd.json')) {
        if (seen[rel] !== true) {
          seen[rel] = true
          found.push(rel)
        }
        continue
      }
      // 只下钻一层，并跳过明显的重目录（node_modules / .git）—— 扫它们又慢又没意义。
      if (isDir && prefix.length === 0 && name !== 'node_modules' && name !== '.git' && dirs.length < MAX_SCAN_DIRS) dirs.push(rel)
    }
  }

  const startAbs = toAbsolute(typeof dir === 'string' && dir.length > 0 ? dir : root, cwd)
  const first = await readDir(startAbs)
  if (first.entries === null) notes.push('无法列出 ' + startAbs + '：' + first.error)
  else collect(first.entries, '')
  for (let d = 0; d < dirs.length; d += 1) {
    const subAbs = toAbsolute(dirs[d], cwd)
    const sub = await readDir(subAbs)
    if (sub.entries === null) {
      notes.push('无法列出 ' + subAbs + '：' + sub.error)
      continue
    }
    collect(sub.entries, dirs[d])
  }
  found.sort()
  return { files: found, notes: notes }
}


export function apply(ctx) {
  function sessionOf(sessionId) {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const session = ctx.sessions.get(sessionId)
      return session === undefined || session === null ? undefined : session
    } catch (error) {
      return undefined
    }
  }

  /**
   * 按**调用会话**解析沙箱策略。
   * 不带 request 的 resolve() 是"无会话"回退，workspaceRoot 会落到部署默认（process.cwd()），
   * 那样工作区文件不在可写根内，writeText 会被 FS_SANDBOX_DENIED 拒掉。
   * 带上 session 后，会话的不可变 cwd 成为可写边界 —— 这不是提权，部署设成 read-only 时照样会拒。
   */
  function policyFor(sessionId) {
    try {
      const session = sessionOf(sessionId)
      return session === undefined ? ctx.sandboxPolicy.resolve() : ctx.sandboxPolicy.resolve({ session: session })
    } catch (error) {
      return undefined
    }
  }

  function workspaceRootOf(sessionId) {
    try {
      const policy = policyFor(sessionId)
      if (policy !== undefined && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
        return policy.workspaceRoot
      }
      const session = sessionOf(sessionId)
      if (session === undefined) return undefined
      const header = session.header
      if (header === undefined || header === null) return undefined
      return typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
    } catch (error) {
      return undefined
    }
  }

  function sessionIdOf(exec) {
    try {
      if (exec === null || exec === undefined) return undefined
      const agent = exec.agent
      if (agent === null || agent === undefined) return undefined
      return typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : undefined
    } catch (error) {
      return undefined
    }
  }

  function absoluteHint(target, fallback) {
    try {
      return ctx.fs.processPath(target)
    } catch (error) {
      return fallback
    }
  }

  async function resolveTarget(path, sessionId) {
    const root = workspaceRootOf(sessionId)
    return root === undefined ? await ctx.fs.resolve(path) : await ctx.fs.resolve(path, { cwd: root })
  }

  async function loadDoc(path, sessionId) {
    const target = await resolveTarget(path, sessionId)
    const absolute = absoluteHint(target, path)
    const info = await ctx.fs.stat(target)
    if (info === undefined) return { target: target, absolute: absolute, doc: emptyDoc() }
    const text = await ctx.fs.readText(target)
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(absolute + ' is not valid JSON: ' + messageOf(error))
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(absolute + ' must contain a JSON object')
    return { target: target, absolute: absolute, doc: normalizeDoc(raw) }
  }

  const readTool = defineTool({
    name: 'diagram_read',
    description:
      '读回工作区里的 DrawAI 画布文档（.dshd.json）：节点 id/标签/形状/配色，边 id/起点/终点/标签。做任何修改前先用它确认当前图。',
    parameters: {
      path: { type: 'string', description: '工作区相对路径或绝对路径，默认 ' + DEFAULT_PATH },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                shape: { type: 'string' },
                style: { type: 'string' },
              },
            },
          },
          edges: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                label: { type: 'string' },
                // 这三个是返回体里**确实会带**的字段（execute 里按需填）。
                // 漏声明的后果实测过：schema 是 additionalProperties:false，
                // 于是只要某条边带 dash/arrow，diagram_read 整个调用被判为非法输出、
                // 直接报错 —— 连读都读不出来。新增返回字段时必须同步这里。
                dash: { type: 'string' },
                arrow: { type: 'string' },
                color: { type: 'string' },
              },
            },
          },
        },
      },
      render: function (args, value) {
        const lines = ['画布文档 ' + value.path + '（revision ' + value.revision + '，' + value.nodes.length + ' 节点 / ' + value.edges.length + ' 边）']
        for (let i = 0; i < value.nodes.length; i += 1) {
          const n = value.nodes[i]
          lines.push('  节点 ' + n.id + ' [' + String(n.shape) + '/' + String(n.style) + '] ' + n.label)
        }
        for (let i = 0; i < value.edges.length; i += 1) {
          const e = value.edges[i]
          const style = (e.dash !== undefined ? ' ' + e.dash : '') + (e.arrow !== undefined ? ' ' + e.arrow : '') + (e.color !== undefined ? ' ' + e.color : '')
          lines.push(
            '  边 ' + e.id + ' ' + e.from + ' -> ' + e.to + (typeof e.label === 'string' && e.label.length > 0 ? ' "' + e.label + '"' : '') + style,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      // 与 diagram_apply 同一条回退链：显式 path > 用户当前打开的画布 > DEFAULT_PATH。
      // 两处必须一致 —— 否则 AI 会"读 A、写 B"。
      const focus = focusedPathFor(sessionIdOf(exec))
      const path =
        typeof args.path === 'string' && args.path.length > 0 ? args.path : focus !== undefined && focus.length > 0 ? focus : DEFAULT_PATH
      const loaded = await loadDoc(path, sessionIdOf(exec))
      const doc = loaded.doc
      const nodes = []
      for (let i = 0; i < doc.nodes.length; i += 1) {
        const n = doc.nodes[i]
        nodes.push({
          id: String(n.id),
          label: typeof n.label === 'string' ? n.label : String(n.id),
          shape: typeof n.shape === 'string' ? n.shape : 'rect',
          style: typeof n.style === 'string' ? n.style : 'blue',
        })
      }
      const edges = []
      for (let i = 0; i < doc.edges.length; i += 1) {
        const e = doc.edges[i]
        const item = { id: String(e.id), from: String(e.from), to: String(e.to) }
        if (typeof e.label === 'string' && e.label.length > 0) item.label = e.label
        if (typeof e.dash === 'string' && e.dash.length > 0) item.dash = e.dash
        if (typeof e.arrow === 'string' && e.arrow.length > 0) item.arrow = e.arrow
        if (typeof e.color === 'string' && e.color.length > 0) item.color = e.color
        edges.push(item)
      }
      return { path: loaded.absolute, revision: doc.revision, nodes: nodes, edges: edges }
    },
  })

  const applyTool = defineTool({
    name: 'diagram_apply',
    description:
      '对工作区里的 DrawAI 画布文档施加一组结构化编辑（加节点/连边/改标签/改样式/删除），然后自动布局并写回文件。你不需要也不应该自己计算坐标——布局由这里算。ops 的每一项形如 {op:"addNode", label:"...", shape?, style?} / {op:"addEdge", from, to, label?, dash?, arrow?, color?} / {op:"setLabel", id, label} / {op:"setStyle", id, shape?, style?, w?, h?, dash?, arrow?, color?} / {op:"remove", id}；节点 id 省略时自动分配。' +
      'setStyle 的 id 可以是节点也可以是连线：节点用 shape/style/w/h，连线用 dash（solid|dashed|dotted）、arrow（end 单向|both 双向|none 无箭头|start 反向）、color（CSS 颜色，省略=跟随主题）。' +
      '文档若带 meta.pinned（人手工摆过位置），不加 layout 就不会重排。边引用了不存在的节点会直接报错，且失败发生在写盘之前。',
    parameters: {
      path: { type: 'string', description: '工作区相对路径或绝对路径，默认 ' + DEFAULT_PATH },
      ops: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description: '结构化编辑数组，见工具描述里的 ops 语法',
      },
      layout: {
        type: 'string',
        enum: ['dagre-lr', 'dagre-tb', 'grid', 'none'],
        description: '自动布局：dagre-tb 上到下（默认，贴合右栏窄高形状）、dagre-lr 左到右、grid 网格、none 保留现有坐标（只给无坐标的新节点补位）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          nodeCount: { type: 'number', required: true },
          edgeCount: { type: 'number', required: true },
          layout: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: function (args, value) {
        return [
          {
            type: 'text',
            text:
              '已更新 ' + value.path + '：revision ' + value.revision + '，' + value.nodeCount + ' 节点 / ' + value.edgeCount +
              ' 边，布局 ' + value.layout + '\n' + value.summary,
          },
        ]
      },
    },
    async execute(args, exec) {
      // 没有显式 path 时，优先用"用户当前打开的那张画布"（客户端上报的聚焦路径），
      // 最后才退回 DEFAULT_PATH。这样"帮我在这张画布上画"改的就是屏幕上那张，
      // 而不是工作区里的 demo.dshd.json（那个坑实测踩过）。
      const focused = focusedPathFor(sessionIdOf(exec))
      const path =
        typeof args.path === 'string' && args.path.length > 0 ? args.path : focused !== undefined && focused.length > 0 ? focused : DEFAULT_PATH
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Error('ops must contain at least one operation')

      const sessionId = sessionIdOf(exec)
      const loaded = await loadDoc(path, sessionId)
      const doc = loaded.doc

      // 人工摆过的文档（meta.pinned）默认不再自动重排 —— 否则 AI 一改图，
      // 人手工调好的位置就被 dagre 全冲掉了。想重排必须显式指定 layout。
      const pinned = doc.meta !== null && typeof doc.meta === 'object' && doc.meta.pinned === true
      const mode = typeof args.layout === 'string' ? args.layout : pinned ? 'none' : 'dagre-tb'
      if (LAYOUTS.indexOf(mode) < 0) throw new Error('unknown layout "' + mode + '"; use one of ' + LAYOUTS.join(', '))

      const notes = applyOps(doc, ops)
      if (mode === 'none') placeMissing(doc)
      else autoLayout(doc, mode)
      doc.revision = (typeof doc.revision === 'number' ? doc.revision : 0) + 1
      // pinned 必须原样带回去！
      //
      // 这里曾经写的是 doc.meta = { engine, layout }，于是**第一次 AI 改图就把 pinned 擦掉了**：
      // 那一次没事（mode 已经是 'none'，人不人的位置都保住了），但从第二次起 pinned 读不到，
      // mode 回落到 'dagre-tb'，人手工摆好的版面被整张重排 —— 正是上面那个判断要防的事。
      // 教训：用整体赋值覆盖 meta 时，"没被显式处理"的字段会静默消失；新增 meta 字段时先看这里。
      doc.meta = pinned ? { engine: 'drawio-svg', layout: mode, pinned: true } : { engine: 'drawio-svg', layout: mode }
      const text = JSON.stringify(doc, null, 2) + '\n'
      const policy = policyFor(sessionId)
      try {
        if (policy === undefined) await ctx.fs.writeText(loaded.target, text)
        else await ctx.fs.writeText(loaded.target, text, undefined, undefined, policy)
      } catch (error) {
        const scope = policy === undefined ? 'unresolved policy' : policy.mode + ' @ ' + String(policy.workspaceRoot)
        throw new Error('write "' + loaded.absolute + '" failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']')
      }
      return {
        path: loaded.absolute,
        revision: doc.revision,
        nodeCount: doc.nodes.length,
        edgeCount: doc.edges.length,
        layout: mode,
        summary: notes.length === 0 ? '(no change)' : notes.join('\n'),
      }
    },
  })

/**
 * 校验"新建画布"的文件名。
 *
 * 只允许**单个文件名**（不含路径分隔符），且必须以 .dshd.json 结尾。
 * 这样即使用户在界面上输入 `..\\..\\x` 也进不来 —— 新建永远落在工作区根目录，
 * 不存在"写到哪里去了"的空间。想放到子目录请自己先建好再打开。
 */
function sanitizeNewName(raw) {
  const name = String(raw === undefined || raw === null ? '' : raw).trim()
  if (name.length === 0) return { ok: false, error: '请输入文件名' }
  if (/[\\/]/.test(name)) return { ok: false, error: '文件名不能包含路径分隔符（新建只落在工作区根目录）' }
  if (name === '.' || name === '..') return { ok: false, error: '文件名非法' }
  // 禁止 Windows 非法字符，省得写盘才失败
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return { ok: false, error: '文件名包含非法字符' }
  const withExt = name.toLowerCase().endsWith('.dshd.json') ? name : name + '.dshd.json'
  if (withExt.length > 120) return { ok: false, error: '文件名过长' }
  return { ok: true, name: withExt }
}

  /**
   * 「画布聚焦」：记录每个会话当前**打开着**的画布路径。
   *
   * 为什么需要：AI 改图只认路径。不传 path 时原来会落到 demo.dshd.json ——
   * 于是"帮我在这张画布上画"会画到别的文件里，用户屏幕上毫无反应（实测踩过）。
   * 有了聚焦记录，不传 path 就改"用户正看着的那张"。
   *
   * 只存路径、不读内容：画布内容始终以文件为唯一真相源，这里记的只是"在看哪一张"。
   */
  const focusedCanvas = new Map()

  function focusedPathFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return focusedCanvas.get(sessionId)
  }

  /**
   * 人工编辑的写回端点。
   *
   * 为什么必须自带：客户端能用的 Remote 面**只有读方法**（workspaceFiles 的
   * read/readBytes/readAll/readRelated/stat/list/changes），整个 DSH 没有通用的
   * "写文件" Remote。人拖完节点要落盘，只能自己开一条通道 —— dsh-better-sidebar
   * 的编辑器 tab 保存文件走的也是这个办法（/sidebar/api）。
   *
   * 信任围栏（方案 §6.4 明确警告：开任意路径路由会绕过围栏，所以这里逐条校验）：
   *   1. 只接受 POST，且必须带自定义头 —— 跨站表单设不了它，跨域 fetch 会触发预检被浏览器拦掉
   *   2. 带 Origin 时必须同源
   *   3. 只写会话工作区根内的 .shd.json（用 fs.contains 做真实路径包含判断，不是字符串前缀）
   *   4. revision 乐观锁：对不上就 409，绝不覆盖别人的改动
   *
   * 顺带把 meta.pinned 打成 true —— 从此这个文档被人手工摆过，
   * diagram_apply 不该再默认自动重排把它冲掉。
   */
  async function handleSave(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (req.headers[SAVE_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing ' + SAVE_HEADER + ' header' })
      return
    }
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === req.headers.host
      } catch (error) {
        sameOrigin = false
      }
      if (!sameOrigin) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
    }

    let text
    try {
      text = await readBody(req, SAVE_MAX_BYTES)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: messageOf(error) })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'request body is not JSON' })
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
      return
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
    const rawPath = typeof body.path === 'string' ? body.path : undefined

    // action: 'list' —— 列出工作区里可打开的 .dshd.json，供"打开"菜单用。
    // 复用同一条路由而不是另开一个：信任围栏（POST + 自定义头 + 同源）只写一次，
    // 少一个口子就少一处可能忘记校验的地方。
    if (body.action === 'list') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const root = workspaceRootOf(sessionId)
      if (root === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      // dir：只列出**这一个目录**（不递归下钻）。给"用文件管理器挑了一个目录"用 ——
      // 用户从系统选择器选中的目录可能在别处，所以这里必须做工作区包含校验，
      // 否则它就成了"列任意目录"的口子（信任围栏的意义就在这）。
      const dir = typeof body.dir === 'string' && body.dir.length > 0 ? body.dir : null
      if (dir !== null) {
        let dirTarget
        try {
          dirTarget = await ctx.fs.resolve(dir)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
          return
        }
        try {
          const rootTarget = await ctx.fs.resolve(root)
          if (!ctx.fs.contains(rootTarget, dirTarget)) {
            sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(dirTarget, dir) })
            return
          }
        } catch (error) {
          sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
          return
        }
        try {
          const listed = await listCanvases(root, root, dir)
          // 同时给出**绝对路径**：客户端按路径去重（同一个文件不该开出两个标签），
          // 而标签上的路径可能来自 tab 的资源地址（绝对），与列表里的相对路径不相等。
          // 让客户端用绝对路径当"身份"，就不会重复开标签。
          const abs = []
          for (let i = 0; i < listed.files.length; i += 1) abs.push(toAbsolute(listed.files[i], root))
          sendJson(res, 200, {
            ok: true,
            files: listed.files,
            absolute: abs,
            notes: listed.notes,
            root: absoluteHint(root, root),
            dir: absoluteHint(dirTarget, dir),
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: 'list failed: ' + messageOf(error) })
        }
        return
      }
      try {
        const listed = await listCanvases(root, root, root)
        const abs = []
        for (let i = 0; i < listed.files.length; i += 1) abs.push(toAbsolute(listed.files[i], root))
        sendJson(res, 200, { ok: true, files: listed.files, absolute: abs, notes: listed.notes, root: absoluteHint(root, root) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'list failed: ' + messageOf(error) })
      }
      return
    }

    // action: 'focus' —— 画布告诉宿主"用户现在打开的是哪一张"。
    // 之后 diagram_apply 不传 path 时就改它（见下面的 execute）。
    // 校验后**只存相对工作区的路径**：绝对路径能存但会让日志/提示变长，
    // 而且工作区被移动后相对路径仍然有效。
    if (body.action === 'focus') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const focusRoot = workspaceRootOf(sessionId)
      if (focusRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const raw = typeof body.path === 'string' ? body.path : ''
      // 空路径 = 清掉聚焦（画布未绑定文件时）
      if (raw.length === 0) {
        focusedCanvas.delete(sessionId)
        sendJson(res, 200, { ok: true, focused: null })
        return
      }
      let focusTarget
      try {
        focusTarget = await ctx.fs.resolve(raw, { cwd: focusRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(focusRoot)
        if (!ctx.fs.contains(rootTarget, focusTarget)) {
          sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(focusTarget, raw) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      focusedCanvas.set(sessionId, raw)
      sendJson(res, 200, { ok: true, focused: raw })
      return
    }

    // action: 'suggest' —— 只**探**一个还没被占用的默认文件名，不建任何文件。
    //
    // 给界面上"新建"对话框预填用：用户要自己输名字，但默认值应该是
    // 当前可用的下一个（untitled / untitled-2 / untitled-3 …），而不是让人从空白开始想。
    // 刻意不落盘：预填只是提示，用户可能改主意取消 —— 不该留下空文件。
    if (body.action === 'suggest') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const suggestRoot = workspaceRootOf(sessionId)
      if (suggestRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const base = typeof body.base === 'string' && body.base.trim().length > 0 ? body.base.trim() : 'untitled'
      let name = base
      for (let n = 2; n <= 999; n += 1) {
        const candidate = sanitizeNewName(name)
        if (!candidate.ok) break
        let taken = true
        try {
          const target = await ctx.fs.resolve(candidate.name, { cwd: suggestRoot })
          taken = (await ctx.fs.stat(target)) !== undefined
        } catch (error) {
          taken = false
        }
        if (!taken) {
          sendJson(res, 200, { ok: true, name: candidate.name })
          return
        }
        name = base + '-' + n
      }
      sendJson(res, 200, { ok: true, name: base })
      return
    }

    // action: 'create' —— 新建一张**真实存在**的空画布并绑定到它。
    //
    // 为什么不"留着以后再说"：画布一旦没有文件，AI 对话就够不到它
    // （diagram_apply 只按路径工作，不传 path 会落到 demo.dshd.json —— 实测过）。
    // 与其让用户对着"未命名画布"说"画一张图"却改到别的文件，不如新建时就落一个空文件。
    // 同名文件已存在时**不覆盖**，返回 exists 让界面提示改名。
    if (body.action === 'create') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const nameCheck = sanitizeNewName(body.name)
      if (!nameCheck.ok) {
        sendJson(res, 400, { ok: false, error: nameCheck.error })
        return
      }
      const createRoot = workspaceRootOf(sessionId)
      if (createRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      let createTarget
      try {
        createTarget = await ctx.fs.resolve(nameCheck.name, { cwd: createRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(createRoot)
        if (!ctx.fs.contains(rootTarget, createTarget)) {
          sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absoluteHint(createTarget, nameCheck.name) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      try {
        const info = await ctx.fs.stat(createTarget)
        if (info !== undefined) {
          sendJson(res, 200, { ok: false, exists: true, error: 'already exists', path: nameCheck.name })
          return
        }
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'stat failed: ' + messageOf(error) })
        return
      }
      // 空画布也打 meta.pinned：它是人手工建的，不该被 AI 的自动布局重排。
      const blank = { version: 1, revision: 1, meta: { engine: 'drawio-svg', pinned: true }, nodes: [], edges: [] }
      const createPolicy = policyFor(sessionId)
      const blankText = JSON.stringify(blank, null, 2) + '\n'
      try {
        if (createPolicy === undefined) await ctx.fs.writeText(createTarget, blankText)
        else await ctx.fs.writeText(createTarget, blankText, undefined, undefined, createPolicy)
      } catch (error) {
        const scope = createPolicy === undefined ? 'unresolved policy' : createPolicy.mode + ' @ ' + String(createPolicy.workspaceRoot)
        sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']' })
        return
      }
      sendJson(res, 200, { ok: true, path: nameCheck.name, absolute: absoluteHint(createTarget, nameCheck.name), revision: 1 })
      return
    }

    if (sessionId === undefined || rawPath === undefined) {
      sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
      return
    }
    if (!rawPath.toLowerCase().endsWith('.dshd.json')) {
      sendJson(res, 403, { ok: false, error: 'only .dshd.json documents may be written' })
      return
    }
    const doc = body.doc
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      sendJson(res, 400, { ok: false, error: 'doc must be a JSON object' })
      return
    }

    const root = workspaceRootOf(sessionId)
    if (root === undefined) {
      sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
      return
    }

    let target
    try {
      target = await ctx.fs.resolve(rawPath, { cwd: root })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
      return
    }
    const absolute = absoluteHint(target, rawPath)

    try {
      const rootTarget = await ctx.fs.resolve(root)
      if (!ctx.fs.contains(rootTarget, target)) {
        sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absolute })
        return
      }
    } catch (error) {
      sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
      return
    }

    let current = emptyDoc()
    let exists = false
    try {
      const info = await ctx.fs.stat(target)
      if (info !== undefined) {
        exists = true
        current = normalizeDoc(JSON.parse(await ctx.fs.readText(target)))
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'read current failed: ' + messageOf(error) })
      return
    }
    const baseRevision = Number.isFinite(Number(body.revision)) ? Number(body.revision) : undefined
    if (baseRevision !== undefined && exists && current.revision !== baseRevision) {
      sendJson(res, 409, { ok: false, error: 'revision conflict', currentRevision: current.revision })
      return
    }

    const next = normalizeDoc(doc)
    next.revision = current.revision + 1
    next.meta = { engine: 'drawio-svg', pinned: true }
    const out = JSON.stringify(next, null, 2) + '\n'
    const policy = policyFor(sessionId)
    try {
      if (policy === undefined) await ctx.fs.writeText(target, out)
      else await ctx.fs.writeText(target, out, undefined, undefined, policy)
    } catch (error) {
      const scope = policy === undefined ? 'unresolved policy' : policy.mode + ' @ ' + String(policy.workspaceRoot)
      sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']' })
      return
    }
    sendJson(res, 200, { ok: true, revision: next.revision, path: absolute })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SAVE_PATH, handler: handleSave }), 'drawai: ' + SAVE_PATH)

  ctx.effect(() => ctx.tools.register(readTool))
  ctx.effect(() => ctx.tools.register(applyTool))
}
