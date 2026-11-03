/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/* Browser-safe, shared identity and search for the pinned motion library. */
export function resolveShotStyle(catalog, cardId, styleKey) {
  const card = catalog.cards.find((item) => item.id === cardId)
  if (!card) throw new Error('未知镜头卡：' + cardId)
  if (!styleKey && card.styles.length !== 1) throw new Error('请指定镜头卡的具体样式：' + cardId)
  const style = styleKey ? card.styles.find((item) => item.key === styleKey) : card.styles[0]
  if (!style) throw new Error('镜头卡与样式不匹配：' + cardId + ' / ' + styleKey)
  return { cardId: card.id, styleKey: style.key, demo: style.demo, commit: catalog.commit,
    label: card.id + ' · ' + style.label, previewUrl: style.previewUrl }
}

export function searchShotCards(catalog, query = '', category = '') {
  const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean)
  return catalog.cards.filter((card) => !category || card.category === category).flatMap((card) => card.styles
    .filter((style) => terms.every((term) => [card.id, card.summary, card.use, card.category,
      catalog.categories[card.category]?.zh, style.key, style.label, style.description].join(' ').toLowerCase().includes(term)))
    .map((style) => ({ ...resolveShotStyle(catalog, card.id, style.key), category: card.category,
      summary: style.description || card.summary, use: card.use, duration: card.duration, energy: card.energy })))
    .sort((a, b) => {
      const score = (item) => terms.reduce((sum, term) => sum + (item.cardId === term || item.styleKey === term ? 100 : item.label.toLowerCase().includes(term) ? 20 : 0), 0)
      return score(b) - score(a)
    })
}

export function isShotCardNode(node) { return node?.data?.drawaiShotCard === '1' }
export function shotCardData(catalog, cardId, styleKey) {
  const selection = resolveShotStyle(catalog, cardId, styleKey)
  return { drawaiShotCard: '1', shotCardId: selection.cardId, shotStyleKey: selection.styleKey, shotCommit: selection.commit }
}

export function shotCardSelections(catalog, input) {
  return input.refs.filter((ref) => ref.role === 'shotcard').map((ref) => {
    const node = ref.nodes.find((item) => item.id === ref.id)
    if (!isShotCardNode(node)) throw new Error('镜头参考必须来自镜头卡节点')
    if (node.data.shotCommit !== catalog.commit) throw new Error('镜头卡库版本已变化，请重新选择样式')
    return { ...resolveShotStyle(catalog, node.data.shotCardId, node.data.shotStyleKey), nodeId: ref.id }
  }).filter((item, index, all) => all.findIndex((other) => other.cardId === item.cardId && other.styleKey === item.styleKey) === index)
}
