/* Included in the client factory. 整片风格库：一条片子选一种 MG 视觉语言。 */
function MgStyleLibrary(props) {
  const ref = React.useRef(null)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(() => {
    const styles = motionCore.mgCatalog.styles
    return (props.initialSelection && styles.find((item) => item.slug === props.initialSelection.slug)) || styles[0]
  })
  React.useEffect(() => { const dialog = ref.current; if (!dialog.open) dialog.showModal(); return () => dialog.close() }, [])
  const styles = motionCore.mgCatalog.styles
  const words = String(query).trim().toLowerCase().split(/[\s,，、]+/).filter(Boolean)
  const results = words.length
    ? styles.filter((item) => { const hay = [item.slug, item.name, item.en, item.oneLiner, ...(item.tags || [])].join(' ').toLowerCase(); return words.every((word) => hay.includes(word)) })
    : styles
  const button = (label, onClick, disabled) => React.createElement('button', { type: 'button', className: 'drawai-btn', onClick, disabled, style: { padding: '9px 14px', borderRadius: 8, border: '1px solid #8885', background: 'transparent', color: 'inherit', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1 } }, label)
  const swatch = (hex, label) => React.createElement('span', { key: label + hex, title: label + ' ' + hex, style: { display: 'inline-block', width: 22, height: 22, borderRadius: 5, background: hex, border: '1px solid #8884' } })
  return React.createElement('dialog', { ref, className: 'drawai-mgstyles', 'aria-label': '整片风格库', onCancel: props.onClose,
    onPointerDown: (event) => event.stopPropagation(), onKeyDown: (event) => event.stopPropagation(),
    style: { width: 'min(1100px,92vw)', maxWidth: '92vw', height: 'min(780px,88vh)', maxHeight: '88vh', padding: 0, border: '1px solid #8885', borderRadius: 18,
      background: props.mode === 'dark' ? '#202124' : '#fafafa', color: props.mode === 'dark' ? '#eee' : '#25272b', boxShadow: '0 24px 100px #0006', fontFamily: 'inherit' } },
    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
      React.createElement('header', { style: { padding: '20px 24px', borderBottom: '1px solid #8883', display: 'flex', justifyContent: 'space-between', gap: 16 } },
        React.createElement('div', null, React.createElement('strong', { style: { fontSize: 20 } }, props.replaceId ? '换一种整片风格' : '整片风格库'),
          React.createElement('div', { style: { fontSize: 12, opacity: .65, marginTop: 6 } }, '15 种 MG 视觉语言 · 一种风格管一条片子的色板、字体、节奏与动效语法 · 不是单镜动效')),
        button('关闭', props.onClose)),
      React.createElement('div', { style: { display: 'flex', padding: '16px 24px', gap: 12 } },
        React.createElement('input', { autoFocus: true, 'aria-label': '搜索风格', placeholder: '搜索风格，例如：包豪斯、像素、HUD、拼贴', value: query,
          onChange: (event) => setQuery(event.target.value), style: { flex: 1, minWidth: 0, padding: 10, border: '1px solid #8885', borderRadius: 8, background: 'transparent', color: 'inherit' } })),
      React.createElement('div', { style: { padding: '0 24px 10px', fontSize: 12, opacity: .65 }, role: 'status' }, results.length + ' 种风格' + (props.targetId ? ' · 添加后自动连接到视频节点' : ' · 选一种放入画布')),
      React.createElement('div', { style: { display: 'flex', flex: 1, minHeight: 0, borderTop: '1px solid #8883' } },
        React.createElement('div', { style: { flex: 1, minWidth: 0, overflow: 'auto', padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', alignContent: 'start', gap: 12 } },
          results.length ? results.map((item) => React.createElement('article', { key: item.slug,
            style: { padding: 14, borderRadius: 12, border: '1px solid ' + (active && active.slug === item.slug ? '#c9a227' : '#8884'), background: active && active.slug === item.slug ? '#c9a22718' : 'transparent' } },
            React.createElement('button', { type: 'button', onClick: () => setActive(item), style: { display: 'block', width: '100%', border: 0, background: 'transparent', color: 'inherit', padding: 0, textAlign: 'left', cursor: 'pointer' } },
              React.createElement('small', { style: { opacity: .6 } }, item.en),
              React.createElement('strong', { style: { display: 'block', margin: '8px 0', overflowWrap: 'anywhere', fontSize: 14 } }, item.name),
              React.createElement('div', { style: { fontSize: 12, lineHeight: 1.6, maxHeight: 54, overflow: 'hidden', opacity: .75 } }, item.oneLiner)),
            React.createElement('div', { style: { display: 'flex', gap: 4, marginTop: 10 } }, ['page', 'text', 'accent', 'surface'].map((role) => item.palette?.[role] ? swatch(item.palette[role], role) : null)))) : React.createElement('p', null, '没有匹配的风格，换个词试试。')),
        active ? React.createElement('aside', { style: { width: '36%', minWidth: 240, maxWidth: 380, overflow: 'auto', padding: 20, borderLeft: '1px solid #8883' } },
          React.createElement('div', { style: { height: 120, borderRadius: 12, background: active.palette?.page || '#eee', border: '1px solid #8884', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 } },
            ['text', 'accent', 'field', 'surface'].map((role) => active.palette?.[role] ? swatch(active.palette[role], role) : null)),
          React.createElement('h3', { style: { fontSize: 16, marginBottom: 4 } }, active.name),
          React.createElement('p', { style: { fontSize: 12, opacity: .7, marginTop: 0 } }, active.slug + (active.rhythm?.aspect ? ' · ' + active.rhythm.aspect : '') + (active.rhythm?.fps ? ' · ' + active.rhythm.fps + 'fps' : '')),
          React.createElement('p', { style: { fontSize: 12, lineHeight: 1.8 } }, active.oneLiner),
          React.createElement('h4', { style: { fontSize: 12, marginBottom: 6, opacity: .7 } }, '判据'),
          active.signature && active.signature.length
            ? React.createElement('ul', { style: { paddingLeft: 18, margin: 0, fontSize: 12, lineHeight: 1.8 } }, active.signature.slice(0, 6).map((line, index) => React.createElement('li', { key: index }, line)))
            : React.createElement('p', { style: { fontSize: 12, opacity: .7 } }, '（这份风格的判据还在整理，先看 STYLE.md 里的移植说明。）'),
          active.fonts ? React.createElement('p', { style: { fontSize: 12, opacity: .7, marginTop: 10 } }, '字体：' + (active.fonts.display || active.fonts.text || '')) : null,
          React.createElement('p', { style: { fontSize: 11, opacity: .55, marginTop: 12 } }, '加了风格节点之后，create 会把色板写进 theme.ts、把施工说明写进 STYLE.md。')) : null),
      React.createElement('footer', { style: { padding: '16px 24px', borderTop: '1px solid #8883', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' } },
        React.createElement('span', { style: { fontSize: 12 } }, props.replaceId ? '换风格会重写 theme.ts；场景里手写的十六进制不会自动改。' : '一个视频节点只接一种整片风格；添加后连线到视频节点。'),
        button(props.replaceId ? '换成这个风格' : '添加到画布' + (props.targetId ? '并连接' : ''), () => { props.onAdd(active); props.onClose() }, !active))))
}
