/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { parse } from '@babel/parser'
import { resolveShotStyle, shotCardSelections } from './shotcard-core.js'
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
