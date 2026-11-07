/* Table nodes use Markdown labels as their single source of truth. */
function parseCanvasTable(node) {
  if (!node || typeof node.label !== 'string') return null
  const lines = node.label.replace(/\r\n?/g, '\n').split('\n')
  const heading = lines[0] && !/^\s*\|/.test(lines[0]) ? lines.shift() : ''
  if (lines.length < 2 || !/^\s*\|/.test(lines[0])) return null
  const escaped = !!(node.data && node.data.drawaiTableEscaped === '1')
  const split = (line) => {
    const input = line.trim()
    if (!input.startsWith('|') || !input.endsWith('|')) return null
    const cells = []; let value = ''
    for (let i = 1; i < input.length - 1; i++) {
      const ch = input[i]
      if (escaped && ch === '\\' && i + 1 < input.length - 1) {
        const next = input[++i]
        value += next === 'n' ? '\n' : next === '|' || next === '\\' ? next : '\\' + next
      } else if (ch === '|') { cells.push(value.trim()); value = '' }
      else value += ch
    }
    cells.push(value.trim())
    return cells
  }
  const header = split(lines[0]), separator = split(lines[1])
  if (!header || header.length < 2 || !separator || separator.length !== header.length ||
      !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return null
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
