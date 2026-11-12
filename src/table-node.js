/* Table nodes use Markdown labels as their single source of truth. */
function parseCanvasTable(node) {
  if (!node || typeof node.label !== 'string') return null
  const lines = node.label.replace(/\r\n?/g, '\n').split('\n')
  const heading = lines[0] && !/^\s*\|/.test(lines[0]) ? lines.shift() : ''
  if (lines.length < 2 || !/^\s*\|/.test(lines[0])) return null
  const escaped = !!(node.data && node.data.drawaiTableEscaped === '1')
  const split = (line) => {
    const input = line.trim()
    if (!input.startsWith('|')) return null
    const cells = []; let value = ''; let lastSeparator = false
    for (let i = 1; i < input.length; i++) {
      const ch = input[i]
      if (escaped && ch === '\\' && i + 1 < input.length) {
        const next = input[++i]
        value += next === 'n' ? '\n' : next === '|' || next === '\\' ? next : '\\' + next
        lastSeparator = false
      } else if (ch === '|') { cells.push(value.trim()); value = ''; lastSeparator = true }
      else { value += ch; if (!/\s/.test(ch)) lastSeparator = false }
    }
    if (!lastSeparator || value.trim()) cells.push(value.trim())
    return cells
  }
  const header = split(lines[0]), separator = split(lines[1])
  if (!header || header.length < 2 || !separator || separator.length !== header.length ||
      !separator.every(cell => /^:?-{2,}:?$/.test(cell))) return null
  const rows = [header]
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue
    const row = split(line)
    if (!row || row.length !== header.length) return null
    rows.push(row)
  }
  return { heading, rows, storyboard: heading.trim() === '【分镜表】' }
}

function isTableNode(node) { return !!parseCanvasTable(node) }

function serializeCanvasTable(model) {
  const encode = value => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n')
  const row = cells => '| ' + cells.map(encode).join(' | ') + ' |'
  const lines = [row(model.rows[0]), row(model.rows[0].map(() => '---'))]
  for (const cells of model.rows.slice(1)) lines.push(row(cells))
  return (model.heading ? model.heading + '\n' : '') + lines.join('\n')
}

function tableNodeLayout(node, model) {
  const width = Math.max(1, Number(node.w) || 1)
  const fs = Math.max(10, Math.min(20, styleNumber(node.style || '', 'fontSize', FSIZE)))
  const weights = model.storyboard && model.rows[0].length === 6 ? [0.10, 0.10, 0.18, 0.20, 0.27, 0.15] : model.rows[0].map(() => 1 / model.rows[0].length)
  const widths = weights.map(weight => width * weight)
  const lineHeight = labelLineHeight(fs)
  const rows = model.rows.map((cells) => {
    const wrapped = cells.map((cell, i) => wrapLabel(cell, Math.max(1, widths[i] - 12), fs))
    return { wrapped, height: Math.max(28, Math.max(...wrapped.map(lines => lines.length)) * lineHeight + 12) }
  })
  const titleHeight = model.heading ? 30 : 0
  return { width, widths, fs, lineHeight, titleHeight, rows, height: titleHeight + rows.reduce((n, row) => n + row.height, 0) }
}

/**
 * 每个单元格在**画布坐标系**里的矩形（行 → 列）。
 *
 * 表格从节点左上角起画，有标题时先占一条，所以 cell 的 y 要从 titleHeight 之后算 ——
 * 就地编辑框、点选命中、右键菜单都靠它对齐，和画出来的格子必须逐像素一致。
 */
function tableCellRects(node, model) {
  const layout = tableNodeLayout(node, model)
  const left = numberOr(node.x, 0)
  let y = numberOr(node.y, 0) + layout.titleHeight
  const rects = []
  for (const row of layout.rows) {
    let x = left
    const cells = []
    for (let i = 0; i < row.wrapped.length; i += 1) {
      const w = layout.widths[i]
      cells.push({ x: x, y: y, w: w, h: row.height })
      x += w
    }
    rects.push(cells)
    y += row.height
  }
  return rects
}

/** 画布坐标里的点落在哪个单元格（0 起，行 0 = 表头）；不在表格上返回 null。 */
function tableCellAt(node, model, point) {
  if (!node || !model || !point) return null
  const rects = tableCellRects(node, model)
  for (let r = 0; r < rects.length; r += 1) {
    for (let c = 0; c < rects[r].length; c += 1) {
      const cell = rects[r][c]
      if (point.x >= cell.x && point.x <= cell.x + cell.w && point.y >= cell.y && point.y <= cell.y + cell.h) return { row: r, col: c }
    }
  }
  return null
}

function tableNodeSvg(node, geo, model) {
  const layout = tableNodeLayout(node, model), children = []
  let y = geo.y
  if (model.heading) {
    children.push(React.createElement('text', { key: 'title', x: geo.x + 8, y: y + 20, fill: '#263143', fontSize: layout.fs + 1, fontWeight: 'bold', fontFamily: FONT }, model.heading))
    y += layout.titleHeight
  }
  model.rows.forEach((cells, rowIndex) => {
    const row = layout.rows[rowIndex]; let x = geo.x
    cells.forEach((cell, columnIndex) => {
      const w = layout.widths[columnIndex]
      children.push(React.createElement('rect', { key: 'cell-' + rowIndex + '-' + columnIndex, x, y, width: w, height: row.height,
        fill: rowIndex === 0 ? '#eef2f8' : '#ffffff', stroke: '#cbd2dd', strokeWidth: 1 }))
      children.push(React.createElement('text', { key: 'text-' + rowIndex + '-' + columnIndex, x: x + 6, y: y + 7 + layout.lineHeight / 2,
        fill: '#263143', fontSize: layout.fs, fontWeight: rowIndex === 0 ? 'bold' : 'normal', fontFamily: FONT, dominantBaseline: 'middle', pointerEvents: 'none' },
      row.wrapped[columnIndex].map((line, n) => React.createElement('tspan', { key: n, x: x + 6, dy: n ? layout.lineHeight : 0 }, line))))
      x += w
    })
    y += row.height
  })
  return children
}
