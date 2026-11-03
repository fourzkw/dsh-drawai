/* Included in the client factory. A native dialog lives in the browser top layer. */
function ShotCardLibrary(props) {
  const ref = React.useRef(null)
  const [query, setQuery] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [selected, setSelected] = React.useState([])
  const [active, setActive] = React.useState(() => props.initialSelection ? motionCore.searchShotCards(motionCore.shotCatalog).find((item) => item.cardId === props.initialSelection.cardId && item.styleKey === props.initialSelection.styleKey) : null)
  const [error, setError] = React.useState('')
  const catalog = motionCore.shotCatalog
  const results = motionCore.searchShotCards(catalog, query, category)
  const current = active || results[0]
  React.useEffect(() => { const dialog = ref.current; if (!dialog.open) dialog.showModal(); return () => dialog.close() }, [])
  const keyOf = (item) => item.cardId + ':' + item.styleKey
  const button = (label, onClick, disabled) => React.createElement('button', { type: 'button', className: 'drawai-btn', onClick, disabled, style: { padding: '9px 14px', borderRadius: 8, border: '1px solid #8885', background: 'transparent', color: 'inherit', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1 } }, label)
  return React.createElement('dialog', { ref, className: 'drawai-shot-library', 'aria-label': '镜头卡库', onCancel: props.onClose,
    onPointerDown: (event) => event.stopPropagation(), onKeyDown: (event) => event.stopPropagation(),
    style: { width: 'min(1040px,92vw)', maxWidth: '92vw', height: 'min(760px,88vh)', maxHeight: '88vh', padding: 0, border: '1px solid #8885', borderRadius: 18,
      background: props.mode === 'dark' ? '#202124' : '#fafafa', color: props.mode === 'dark' ? '#eee' : '#25272b', boxShadow: '0 24px 100px #0006', fontFamily: 'inherit' } },
    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
      React.createElement('header', { style: { padding: '20px 24px', borderBottom: '1px solid #8883', display: 'flex', justifyContent: 'space-between', gap: 16 } },
        React.createElement('div', null, React.createElement('strong', { style: { fontSize: 20 } }, props.replaceId ? '替换镜头样式' : '镜头卡库'),
          React.createElement('div', { style: { fontSize: 12, opacity: .65, marginTop: 6 } }, '124 张镜头卡 · 150 个样式 · 选择运动方式，将你的素材放进镜头')),
        button('关闭', props.onClose)),
      React.createElement('div', { style: { display: 'flex', padding: '16px 24px', gap: 12 } },
        React.createElement('input', { autoFocus: true, 'aria-label': '搜索镜头卡', placeholder: '搜索卡名、样式、用途，例如：卡片、转场、甩镜', value: query,
          onChange: (event) => setQuery(event.target.value), style: { flex: 1, minWidth: 0, padding: 10, border: '1px solid #8885', borderRadius: 8, background: 'transparent', color: 'inherit' } }),
        React.createElement('select', { 'aria-label': '镜头分类', value: category, onChange: (event) => setCategory(event.target.value), style: { padding: 8 } },
          React.createElement('option', { value: '' }, '全部分类'), Object.entries(catalog.categories).map(([id, labels]) => React.createElement('option', { key: id, value: id }, labels.zh)))),
      React.createElement('div', { style: { padding: '0 24px 10px', fontSize: 12, opacity: .65 }, role: 'status' }, results.length + ' 个样式' + (props.targetId ? ' · 添加后自动连接到视频节点' : ' · 可多选后一起放入画布')),
      React.createElement('div', { style: { display: 'flex', flex: 1, minHeight: 0, borderTop: '1px solid #8883' } },
        React.createElement('div', { style: { flex: 1, minWidth: 0, overflow: 'auto', padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', alignContent: 'start', gap: 12 } },
          results.length ? results.map((item) => {
            const checked = selected.some((entry) => keyOf(entry) === keyOf(item))
            return React.createElement('article', { key: keyOf(item), style: { padding: 14, borderRadius: 12, border: '1px solid ' + (current && keyOf(current) === keyOf(item) ? '#8675ed' : '#8884'), background: checked ? '#8675ed18' : 'transparent' } },
              React.createElement('button', { type: 'button', onClick: () => { setActive(item); setError('') }, style: { display: 'block', width: '100%', border: 0, background: 'transparent', color: 'inherit', padding: 0, textAlign: 'left', cursor: 'pointer' } },
                React.createElement('small', { style: { opacity: .6 } }, catalog.categories[item.category]?.zh),
                React.createElement('strong', { style: { display: 'block', margin: '8px 0', overflowWrap: 'anywhere', fontSize: 13 } }, item.label),
                React.createElement('div', { style: { fontSize: 12, lineHeight: 1.6, maxHeight: 58, overflow: 'hidden', opacity: .75 } }, item.summary)),
              React.createElement('label', { style: { display: 'block', marginTop: 12, fontSize: 12 } }, React.createElement('input', { type: 'checkbox', checked,
                'aria-label': '选择 ' + item.label, onChange: () => setSelected((items) => items.some((entry) => keyOf(entry) === keyOf(item)) ? items.filter((entry) => keyOf(entry) !== keyOf(item)) : props.replaceId ? [item] : [...items, item]) }), ' ', checked ? '已选择' : '选择此样式'))
          }) : React.createElement('p', null, '没有找到匹配的镜头，试试其他关键词。')),
        current ? React.createElement('aside', { style: { width: '35%', minWidth: 220, maxWidth: 360, overflow: 'auto', padding: 20, borderLeft: '1px solid #8883' } },
          React.createElement('video', { key: current.previewUrl, src: current.previewUrl, controls: true, muted: true, loop: true, playsInline: true, preload: 'metadata',
            'aria-label': '镜头样片预览', onError: () => setError('样片暂时无法加载；可稍后重试或打开原始样片。'), style: { width: '100%', aspectRatio: '16/9', background: '#111', borderRadius: 10 } }),
          React.createElement('h3', { style: { overflowWrap: 'anywhere', fontSize: 15 } }, current.label),
          React.createElement('p', { style: { fontSize: 12, lineHeight: 1.8 } }, current.summary),
          React.createElement('p', { style: { fontSize: 12, opacity: .7 } }, current.use),
          React.createElement('p', { style: { fontSize: 12 } }, current.duration),
          React.createElement('a', { href: current.previewUrl, target: '_blank', rel: 'noreferrer', style: { color: '#8e7ded', fontSize: 12 } }, '打开原始样片')) : null),
      React.createElement('footer', { style: { padding: '16px 24px', borderTop: '1px solid #8883', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' } },
        React.createElement('span', { style: { fontSize: 12 }, role: error ? 'alert' : 'status' }, error || ('已选 ' + selected.length + ' 个样式。镜头卡作为运动参考，不作为成片素材。')),
        button(props.replaceId ? '替换样式' : '添加到画布' + (props.targetId ? '并连接' : ''), () => {
          try { props.onAdd(selected); props.onClose() } catch (failure) { setError(failure.message) }
        }, !selected.length))))
}
