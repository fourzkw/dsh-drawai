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

function TableNodeEditor(props) {
  const [model, setModel] = React.useState(() => ({ ...props.model, rows: props.model.rows.map(row => row.slice()) }))
  const [activeRow, setActiveRow] = React.useState(1)
  const [activeColumn, setActiveColumn] = React.useState(0)
  const update = (r, c, value) => setModel(prev => ({ ...prev, rows: prev.rows.map((row, i) => i === r ? row.map((v, j) => j === c ? value : v) : row) }))
  const addRow = () => setModel(prev => ({ ...prev, rows: prev.rows.concat([prev.rows[0].map(() => '')]) }))
  const deleteRow = () => { if (activeRow < 1) return; setModel(prev => ({ ...prev, rows: prev.rows.filter((_, i) => i !== activeRow) })); setActiveRow(0) }
  const addColumn = () => setModel(prev => ({ ...prev, rows: prev.rows.map(row => row.concat('')) }))
  const deleteColumn = () => { if (model.rows[0].length <= 2) return; setModel(prev => ({ ...prev, rows: prev.rows.map(row => row.filter((_, i) => i !== activeColumn)) })); setActiveColumn(0) }
  return React.createElement('div', { className: 'drawai-table-editor', role: 'dialog', 'aria-label': '编辑表格',
    onPointerDown: e => e.stopPropagation(), onDoubleClick: e => e.stopPropagation(), onKeyDown: e => { e.stopPropagation(); if (e.key === 'Escape') props.onCancel(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); props.onSave(model) } } },
    React.createElement('div', { className: 'drawai-table-editor-bar' },
      React.createElement('strong', null, model.heading || '编辑表格'),
      React.createElement('button', { type: 'button', onClick: addRow }, '添加行'),
      React.createElement('button', { type: 'button', onClick: deleteRow, disabled: activeRow < 1 }, '删除当前行'),
      !model.storyboard && React.createElement('button', { type: 'button', onClick: addColumn }, '添加列'),
      !model.storyboard && React.createElement('button', { type: 'button', onClick: deleteColumn, disabled: model.rows[0].length <= 2 }, '删除当前列'),
      React.createElement('button', { type: 'button', onClick: props.onCancel }, '取消'),
      React.createElement('button', { type: 'button', onClick: () => props.onSave(model) }, '保存')),
    props.hasFormatting && React.createElement('p', { className: 'drawai-table-note' }, '修改单元格会清除原文字的局部样式。'),
    React.createElement('div', { className: 'drawai-table-scroll' },
      React.createElement('table', null, React.createElement('tbody', null,
        model.rows.map((row, r) => React.createElement('tr', { key: r }, row.map((value, c) => React.createElement(r ? 'td' : 'th', { key: c },
          React.createElement('textarea', { 'aria-label': (r ? '第' + r + '行' : '表头') + '第' + (c + 1) + '列', value, rows: 3,
            onFocus: () => { setActiveRow(r); setActiveColumn(c) }, onChange: e => update(r, c, e.target.value) })))))))))
}
