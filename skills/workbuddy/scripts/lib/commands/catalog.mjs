// 配方库：镜头卡（124 张单镜动效卡）与整片风格（14 种）。
// 这两样是这个技能包"不靠想象做动效"的全部依据——先读卡/风格的施工包，再写场景。

import { emit, line, table } from '../cli.mjs'

const truncate = (text, limit) => (text.length > limit ? text.slice(0, limit) + '\n\n…（已截断，剩 ' + (text.length - limit) + ' 字符；要全文用 --full）' : text)

// ── card ────────────────────────────────────────────────────────────
export async function card(flags, positional) {
  const action = positional[0] || flags.action || 'list'
  const { shotCardCatalog, motionCardContract } = await import('../../engine/motion-library.js')
  const { searchShotCards } = await import('../../engine/shotcard-core.js')

  if (action === 'list') {
    const cards = shotCardCatalog.cards.filter((item) => !flags.category || item.category === flags.category)
    if (flags.json) return emit('', { cards: cards.map((item) => ({ id: item.id, category: item.category, duration: item.duration, styles: item.styles.map((style) => style.key) })) })
    const rows = cards.flatMap((item) => item.styles.map((style) => [item.id + ':' + style.key, style.label, item.duration || '', item.category]))
    return line(table(['卡:样式', '名称', '时长', '类别'], rows)) + '\n共 ' + cards.length + ' 张卡 / ' + rows.length + ' 种样式。用法：`wb card show --card <卡名> --style <样式>`。'
  }

  if (action === 'search') {
    const results = searchShotCards(shotCardCatalog, String(flags.query || ''), flags.category ? String(flags.category) : '')
    if (flags.json) return emit('', { results })
    if (!results.length) return line('没有匹配的镜头卡。换个说法再搜（卡是按"动作 + 对象"描述的，比如 "数字 计数"、"标题 打字"）。')
    return line(table(['卡:样式', '名称', '时长', '这一镜干什么'], results.slice(0, 30).map((item) => [item.cardId + ':' + item.styleKey, item.label.split(' · ')[1] || '', item.duration || '', String(item.summary || '').slice(0, 46)])))
      + '\n挑中后用 `wb card show --card ' + results[0].cardId + ' --style ' + results[0].styleKey + '` 拿施工包。'
  }

  if (action === 'show') {
    const cardId = flags.card || positional[1]
    if (!cardId) throw new Error('show 需要 --card <卡名>（`wb card search 关键词` 找），多样式卡还要 --style')
    const contract = motionCardContract({ cardId: String(cardId), styleKey: flags.style ? String(flags.style) : undefined })
    if (flags.json) return emit('', contract)
    line(contract.cardId + ':' + contract.styleKey + '  ' + (contract.label.split(' · ')[1] || ''))
    line('  时长 ' + (contract.duration || '?') + ' · 能量 ' + (contract.energy || '?') + ' · 源码 ' + contract.cardSource)
    line('  保护段：' + contract.protectedParameters.map((section) => section.split('\n')[0].replace(/^##\s*/, '')).join(' / '))
    line('  参数指纹 ' + contract.parametersSha256.slice(0, 16) + ' · 玩法：' + contract.preservation)
    line('')
    line(truncate(contract.recipe, flags.full ? Infinity : 24000))
    return
  }

  throw new Error('card 没有这个动作：' + action + '（list / search / show）')
}

// ── style ───────────────────────────────────────────────────────────
export async function style(flags, positional) {
  const action = positional[0] || flags.action || 'list'
  const library = await import('../../engine/motion-library.js')
  const { mgStyleCatalog } = library
  const { searchMgStyles } = await import('../../engine/mgstyle-core.js')

  if (action === 'list') {
    const styles = mgStyleCatalog.styles
    if (flags.json) return emit('', { styles })
    return line(table(['slug', '名字', '引擎', '节奏', '一句话'], styles.map((item) => [item.slug, item.name, (item.engines || [item.engine]).filter(Boolean).join('/'), item.rhythm ? (item.rhythm.fps || '') + 'fps/' + (item.rhythm.duration || '') + 's' : '', String(item.oneLiner || '').slice(0, 40)])))
      + '\n选一个：`wb style read --slug <slug>` 读施工包。整片只用一种。'
  }

  if (action === 'search') {
    const results = searchMgStyles(mgStyleCatalog, String(flags.query || ''))
    if (flags.json) return emit('', { results })
    if (!results.length) return line('没有匹配的整片风格。`wb style list` 看全部 14 种。')
    return line(table(['slug', '名字', '一句话'], results.map((item) => [item.slug, item.name, String(item.oneLiner || '').slice(0, 46)])))
  }

  if (action === 'read') {
    const slug = flags.slug || positional[1]
    if (!slug) throw new Error('read 需要 --slug（`wb style list` 看全部）')
    const kit = library.mgStyleKit({ slug: String(slug) })
    if (flags.json) return emit('', kit)
    line(kit.slug + '  ' + kit.name + '（' + (kit.en || '') + '）')
    line('  ' + kit.oneLiner)
    line('  引擎 ' + (kit.engines || [kit.engine]).filter(Boolean).join(' / ') + (kit.engineNote ? ' · ' + kit.engineNote : ''))
    line('  色板 ' + Object.entries(kit.palette || {}).map(([key, value]) => key + ' ' + value).join(' · '))
    line('  字体 ' + Object.entries(kit.fonts || {}).map(([key, value]) => key + ' ' + String(value).split(',')[0]).join(' · '))
    line('  节奏 ' + JSON.stringify(kit.rhythm || {}))
    line('  判据（做不到就不算这个风格）：')
    for (const item of kit.signature || []) line('    · ' + item)
    line('')
    line(truncate(kit.brief, flags.full ? Infinity : 30000))
    line('\n上游成片源码：`wb style source --slug ' + kit.slug + '`；参考帧：`wb style frames --slug ' + kit.slug + '`。')
    return
  }

  if (action === 'source') {
    const slug = flags.slug || positional[1]
    if (!slug) throw new Error('source 需要 --slug')
    const files = flags.files ? String(flags.files).split(',') : null
    if (files) {
      const documents = files.map((path) => ({ path, source: library.mgStyleFile(path) }))
      if (flags.json) return emit('', { slug, documents })
      for (const document of documents) { line('── ' + document.path + ' ──'); line(truncate(document.source, flags.full ? Infinity : 60000)); line('') }
      return
    }
    const documents = library.mgStyleSources(String(slug))
    if (flags.json) return emit('', { slug, documents })
    for (const document of documents) { line('── ' + document.path + '（' + document.chars + ' 字符）──'); line(truncate(document.source, flags.full ? Infinity : 20000)); line('') }
    return
  }

  if (action === 'frames') {
    const slug = flags.slug || positional[1]
    if (!slug) throw new Error('frames 需要 --slug')
    const { ensureAssets } = await import('../../engine/motion/asset-pack.js')
    await ensureAssets({})
    const { captureStyleFrames } = await import('../../engine/motion/style-frames.js')
    const times = flags.times ? String(flags.times).split(',').map(Number) : undefined
    const result = await captureStyleFrames({ slug: String(slug), times, count: Number(flags.count) || 8, directory: flags.dir ? String(flags.dir) : undefined })
    if (flags.json) return emit('', { ok: true, ...result })
    line('参考帧 ' + result.times.length + ' 张（' + result.width + '×' + result.height + ' @' + result.fps + 'fps · ' + result.duration + 's）')
    for (const file of result.files) line('  ' + file.time.toFixed(2) + 's  ' + file.path)
    if (result.notes?.length) line('\n' + result.notes.join('\n'))
    return
  }

  throw new Error('style 没有这个动作：' + action + '（list / search / read / source / frames）')
}
