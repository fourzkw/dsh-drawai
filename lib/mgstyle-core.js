/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/* Browser-safe, shared identity and search for the mg-styles library (整片风格，不是单镜卡). */
export function resolveMgStyle(catalog, slug) {
  const style = catalog.styles.find((item) => item.slug === slug)
  if (!style) {
    throw new Error('未知 mg 风格：' + slug + '（可用：' + catalog.styles.map((item) => item.slug).join(' / ') + '）')
  }
  return {
    slug: style.slug,
    name: style.name,
    en: style.en,
    oneLiner: style.oneLiner,
    signature: style.signature || [],
    palette: style.palette,
    colors: style.colors || [],
    fonts: style.fonts || null,
    rhythm: style.rhythm || null,
    prompt: style.prompt,
    demos: style.demos,
    brief: style.brief,
    engine: style.engine || null,
    engines: style.engines || [],
    engineNote: style.engineNote || '',
    engineFiles: style.engineFiles || [],
    motion: style.motion || null,
    commit: catalog.commit,
    label: style.name + ' · ' + style.slug,
  }
}

/** 按词打分：命中的词越多分越高；slug 精确命中、中文名命中权重最高。中文按字包含即可。 */
export function searchMgStyles(catalog, query = '') {
  const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean)
  return catalog.styles
    .map((style) => {
      const haystack = [style.slug, style.name, style.en, style.heading, style.oneLiner,
        (style.tags || []).join(' '), (style.signature || []).join(' ')].join(' ').toLowerCase()
      const hit = terms.filter((term) => haystack.includes(term)).length
      if (terms.length && hit === 0) return null
      const exact = terms.includes(style.slug) || terms.includes(style.name.toLowerCase())
      return { style, score: (exact ? 100 : 0) + hit * 10 + (terms.length && hit === terms.length ? 5 : 0) }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map(({ style }) => ({
      slug: style.slug,
      name: style.name,
      en: style.en,
      oneLiner: style.oneLiner,
      tags: style.tags || [],
      palette: style.palette,
      rhythm: style.rhythm || null,
      shot: style.shot || '',
    }))
}

export function isMgStyleNode(node) { return node?.data?.drawaiMgStyle === '1' }

export function mgStyleData(catalog, slug) {
  const selection = resolveMgStyle(catalog, slug)
  return { drawaiMgStyle: '1', mgStyleSlug: selection.slug, mgStyleCommit: selection.commit }
}

/** 一条片子只允许一种整片风格；重复引用同一个风格不算错，去重即可。 */
export function mgStyleSelection(catalog, input) {
  const picks = input.refs.filter((ref) => ref.role === 'mgstyle').map((ref) => {
    const node = ref.nodes.find((item) => item.id === ref.id)
    if (!isMgStyleNode(node)) throw new Error('风格参考必须来自 mg 风格节点')
    if (node.data.mgStyleCommit !== catalog.commit) throw new Error('mg 风格库版本已变化，请重新选择风格')
    return { ...resolveMgStyle(catalog, node.data.mgStyleSlug), nodeId: ref.id }
  })
  const unique = picks.filter((item, index, all) => all.findIndex((other) => other.slug === item.slug) === index)
  if (unique.length > 1) throw new Error('一条片子只能选一种整片风格，当前有：' + unique.map((item) => item.slug).join(' / '))
  return unique[0] || null
}
