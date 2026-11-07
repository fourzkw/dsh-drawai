import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { parse } from '@babel/parser'
import { resolveShotStyle, shotCardSelections } from './shotcard-core.js'
import { mgStyleSelection, resolveMgStyle } from './mgstyle-core.js'
export const shotCardCatalog = JSON.parse(readFileSync(new URL('./motion/shotcraft/catalog.json', import.meta.url), 'utf8'))
const base = new URL('./motion/shotcraft/upstream/', import.meta.url)
export const shotcraftLibrary = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'))
export function shotcraftFile(path) {
  if (!Object.hasOwn(shotcraftLibrary.files, path)) throw new Error('未知 Shotcraft 源文件：' + path)
  return readFileSync(new URL(path, base), 'utf8')
}
export function shotcraftCatalog() {
  return shotCardCatalog.cards.map((card) => ({ ...card, demos: [...new Set(card.styles.map((style) => style.demo))] }))
}
export function shotcraftContext(shots) {
  const chosen = new Set(), documents = []
  function include(path) {
    if (chosen.has(path)) return
    chosen.add(path)
    const source = shotcraftFile(path)
    documents.push({ path, source })
    if (!/\.(tsx?|jsx?)$/.test(path)) return
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    for (const node of ast.program.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source?.value.startsWith('.')) continue
      const stem = posix.normalize(posix.join(posix.dirname(path), node.source.value))
      const dependency = [stem, stem + '.tsx', stem + '.ts', stem + '.jsx', stem + '.js', stem + '/index.tsx', stem + '/index.ts'].find((candidate) => Object.hasOwn(shotcraftLibrary.files, candidate))
      if (dependency) include(dependency)
    }
  }
  for (const shot of shots) {
    if (shot.motionCards?.length) {
      for (const selection of shot.motionCards) {
        const resolved = resolveShotStyle(shotCardCatalog, selection.cardId, selection.styleKey)
        include(shotCardCatalog.cards.find((card) => card.id === resolved.cardId).source); include(resolved.demo)
      }
      continue
    }
    if (!shot.cardId) continue
    const card = shotcraftLibrary.cards.find((card) => card.id === shot.cardId)
    if (!card) throw new Error('未知镜头卡：' + shot.cardId)
    if (shot.demo && !card.demos.includes(shot.demo)) throw new Error('镜头卡与参考源码不匹配')
    for (const path of [card.source, ...(shot.demo ? [shot.demo] : card.demos.slice(0, 1))]) {
      include(path)
    }
  }
  const context = JSON.stringify(documents)
  if (context.length > 300000) throw new Error('参考源码过多，请减少镜头或参考变体')
  return documents
}
export function shotcraftModuleMap() {
  return Object.fromEntries(Object.keys(shotcraftLibrary.files).filter((path) => /^(assets\/lib|demos)\/.+\.(tsx?|jsx?)$/.test(path))
    .map((path) => ['@shotcraft/' + path.replace(/^assets\/lib\//, 'lib/').replace(/\.(tsx?|jsx?)$/, ''), new URL(path, base)]))
}

export function motionCardContract(selection) {
  const resolved = resolveShotStyle(shotCardCatalog, selection.cardId, selection.styleKey)
  const card = shotCardCatalog.cards.find((item) => item.id === resolved.cardId)
  const recipe = shotcraftFile(card.source)
  const protectedParameters = recipe.split(/(?=^## )/m).filter((section) => /^## (参数表|已知坑|动效核心)/.test(section))
  return { ...resolved, protectedParameters, parametersSha256: createHash('sha256').update(protectedParameters.join('\n')).digest('hex'), cardSource: card.source, demoSha256: shotcraftLibrary.files[resolved.demo],
    recipe, source: shotcraftFile(resolved.demo),
    preservation: '参考准确 demo 的动作顺序、缓动、运镜、遮罩时机、错峰与停留，按需求自由适配源码与内容。30fps 时值按实际 fps 换算；改完用 motion_preview 看帧确认效果。' }
}
export function enforceMotionCards(composition, input) {
  if (shotCardCatalog.commit !== shotcraftLibrary.commit) throw new Error('镜头样式索引与源码库版本不匹配')
  const required = shotCardSelections(shotCardCatalog, input)
  const used = new Set()
  for (const shot of composition.shots) {
    let selections = shot.motionCards || []
    if (!selections.length && shot.cardId) {
      const card = shotCardCatalog.cards.find((item) => item.id === shot.cardId)
      if (!card) throw new Error('未知镜头卡：' + shot.cardId)
      const candidates = card.styles.filter((style) => !shot.demo || style.demo === shot.demo)
      if (candidates.length !== 1) throw new Error('镜头卡有多个样式，请指定 motionCards 的 styleKey：' + shot.cardId)
      selections = [{ cardId: card.id, styleKey: candidates[0].key }]
    }
    if (selections.length > 8) throw new Error('单镜最多参考 8 个镜头样式')
    const keys = new Set()
    shot.motionCards = selections.map((item) => {
      const resolved = resolveShotStyle(shotCardCatalog, item.cardId, item.styleKey)
      if (item.demo && item.demo !== resolved.demo) throw new Error('样式与 demo 不匹配')
      const key = resolved.cardId + ':' + resolved.styleKey
      if (keys.has(key)) throw new Error('镜头内重复引用样式：' + key)
      keys.add(key); used.add(key)
      return resolved
    })
    if (shot.motionCards.length) { shot.cardId = shot.motionCards[0].cardId; shot.demo = shot.motionCards[0].demo }
  }
  for (const item of required) if (!used.has(item.cardId + ':' + item.styleKey)) throw new Error('分镜遗漏指定的镜头参考：' + item.label)
  if (used.size) composition.production = { ...composition.production, motionContracts: [...new Map(composition.shots.flatMap((shot) => shot.motionCards)
    .map((item) => [item.cardId + ':' + item.styleKey, motionCardContract(item)])).values()].map(({ source, recipe, protectedParameters, ...item }) => item) }
  return composition
}

// ── mg-styles：14 种整片风格（不是单镜卡；上游 15 支里的 04-3d-render 已移除） ──
// 上游是「HTML 页 + renderAt(t) + puppeteer 截帧」，这里是「提示词 + 移植 brief + 成片源码」，
// 供 agent 在 Remotion 里照着写场景。源码只作阅读参考，不进 webpack（和镜头卡不同）。

const mgRoot = new URL('./motion/mgstyles/', import.meta.url)
const mgUpstream = new URL('upstream/', mgRoot)
const mgReadCache = new Map()

export const mgStyleCatalog = JSON.parse(readFileSync(new URL('catalog.json', mgRoot), 'utf8'))
export const mgStyleLibrary = JSON.parse(readFileSync(new URL('manifest.json', mgUpstream), 'utf8'))

function readMg(relative, base = mgUpstream) {
  if (mgReadCache.has(relative)) return mgReadCache.get(relative)
  const source = readFileSync(new URL(relative, base), 'utf8')
  mgReadCache.set(relative, source)
  return source
}

export function mgStyleFile(path) {
  if (!Object.hasOwn(mgStyleLibrary.files, path)) throw new Error('未知 mg 风格源文件：' + path)
  return readMg(path)
}

export function mgStyleFileSize(path) {
  if (!Object.hasOwn(mgStyleLibrary.files, path)) throw new Error('未知 mg 风格源文件：' + path)
  return statSync(new URL(path, mgUpstream)).size
}

export function mgStyleBrief(slug) {
  const style = resolveMgStyle(mgStyleCatalog, slug)
  let source
  try { source = readMg(style.brief, mgRoot) } catch {
    throw new Error('风格 ' + slug + ' 还没有移植 brief（' + style.brief + '），先读提示词与上游源码：' + style.prompt)
  }
  return { slug: style.slug, path: style.brief, source, sha256: createHash('sha256').update(source).digest('hex') }
}

export function mgStylePrompt(slug) {
  const style = resolveMgStyle(mgStyleCatalog, slug)
  const source = mgStyleFile(style.prompt)
  return { slug: style.slug, path: style.prompt, source, sha256: createHash('sha256').update(source).digest('hex') }
}

/**
 * 上游成片源码，按「最可能被抄的优先」排序：film.js / main.js / scene.js / index.html 先来，
 * 其余 js 其次，json 最后。单文件截断 60k 字符，总量截断 200k —— brief 已经提炼过，
 * 源码是补充细节用的，不该把上下文吃光。
 */
export function mgStyleSources(slug, { limit = 200000 } = {}) {
  const style = resolveMgStyle(mgStyleCatalog, slug)
  const rank = (path) => {
    const name = posix.basename(path)
    if (/^(film|main|scene|index)\.(m?js|html)$/.test(name)) return 0
    if (/\.(m?js|html)$/.test(name)) return 1
    if (/\.css$/.test(name)) return 2
    return 3
  }
  const paths = Object.keys(mgStyleLibrary.files).filter((path) => path.startsWith('demos/' + slug + '/')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const documents = []
  let total = 0
  for (const path of paths) {
    if (total >= limit) break
    const source = readMg(path)
    const slice = source.length > 60000 ? source.slice(0, 60000) + '\n/* …截断：' + (source.length - 60000) + ' 字符未显示，需要时用 mg_style action:"read" files:["' + path + '"]… */' : source
    documents.push({ path, chars: source.length, source: slice })
    total += slice.length
  }
  return documents
}

/** 一个风格的完整「施工包」：判据 + 色板 + 字体 + 节奏 + 提示词 + brief。 */
export function mgStyleKit(selection) {
  const style = resolveMgStyle(mgStyleCatalog, selection.slug)
  const brief = mgStyleBrief(selection.slug)
  const prompt = mgStylePrompt(selection.slug)
  return {
    ...style,
    brief: brief.source,
    briefSha256: brief.sha256,
    promptSource: prompt.source,
    promptSha256: prompt.sha256,
    demos: style.demos,
    preservation: 'brief 是这个风格的移植说明书；引擎以 engines 为准 —— three.js / WebGL2 必须真跑同一套引擎，不许用 CSS 3D、div 层叠或 Canvas2D 渐变简化替代（motion_render 启动前会扫工程源码拦截）。判据（signature）比形容词重要：做不出判据就不算这个风格。',
  }
}

/** 把选中的风格织进 composition：固定 palette/字体/节奏，并把 brief 摘要留在 production 里备查。 */
export function enforceMgStyle(composition, input) {
  if (mgStyleCatalog.commit !== mgStyleLibrary.commit) throw new Error('mg 风格索引与源码库版本不匹配')
  const selection = mgStyleSelection(mgStyleCatalog, input)
  if (!selection) return composition
  const kit = mgStyleKit(selection)
  composition.production = {
    ...composition.production,
    mgStyle: {
      slug: kit.slug,
      name: kit.name,
      commit: kit.commit,
      nodeId: selection.nodeId,
      palette: kit.palette,
      fonts: kit.fonts,
      rhythm: kit.rhythm,
      signature: kit.signature,
      brief: kit.brief,
      briefSha256: kit.briefSha256,
      promptSha256: kit.promptSha256,
      demos: kit.demos,
      preservation: kit.preservation,
    },
  }
  return composition
}
