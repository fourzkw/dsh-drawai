// Bundled upstream media. Only requested files are copied into a project.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { mediaLibraryRoot } from './asset-pack.js'
import { captureAsset, readAssets, writeAssets } from './assets.js'
import { listStyleReferenceFrames } from './style-reference-store.js'

// 素材库不在 npm 包里，位置由 asset-pack 解析；没装好时这些查询返回空。
const root = () => mediaLibraryRoot()
const indexPath = () => join(root() || '', 'upstream-files.json')
const checksumPath = () => join(root() || '', 'checksums.sha256.json')
const commit = '49052d80bfaf9fa8412cc9710530e5e95a3b8d8c'
const labels = { paper:'纸张', grain:'颗粒', dust:'灰尘', washi:'胶带', piano:'钢琴', harp:'竖琴', glock:'钟琴', marimba:'马林巴', kalimba:'拇指琴', vibraphone:'颤音琴', timpani:'定音鼓', woodblock:'木鱼', crash:'镲', suscymbal:'吊镲', cabasa:'卡巴萨', guiro:'刮胡', slapstick:'拍板', vibraslap:'颤响器', wineglass:'酒杯' }

function upstreamMedia() {
  if (!root() || !existsSync(indexPath())) return []
  const index = JSON.parse(readFileSync(indexPath(), 'utf8'))
  if (index.commit !== commit || !Array.isArray(index.files)) throw new Error('内置素材库索引无效')
  return index.files.map(item => {
    if (typeof item.path !== 'string' || item.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('内置素材库路径无效')
    const image = item.path.startsWith('assets/textures/')
    const audio = item.path.startsWith('lib/audio/samples/') && item.path.endsWith('.flac')
    if (!image && !audio) throw new Error('内置素材库路径无效')
    const group = item.path.split('/')[image ? 2 : 3], name = item.path.split('/').at(-1)
    return { id: item.path, name, category: group, categoryName: labels[group] || group,
      kind: image ? 'image' : 'audio', bytes: item.size, gitSha: item.sha,
      license: audio || name === 'Paper001_4K_color.jpg' ? 'CC0-1.0' : '上游未逐项列明',
      source: 'https://github.com/Vincentwei1021/mg-styles-15/blob/' + commit + '/' + item.path.split('/').map(encodeURIComponent).join('/') }
  }).filter(item => existsSync(join(root() || '', ...item.id.split('/'))))
}

function referenceMedia(slug, required = false, warnings = []) {
  try {
    return listStyleReferenceFrames(slug ? { slug } : {})
  } catch (err) {
    // 风格参考帧为独立素材包，未安装时不应影响已有纹理/音频库。
    if (!required && err?.code === 'STYLE_REFERENCE_UNAVAILABLE') return []
    if (required) throw err
    if (slug) {
      warnings.push('风格参考帧不可用（' + slug + '）：' + (err?.message || String(err)))
      return []
    }
    // 普通全库/图片浏览应保留既有素材和其他可用风格；按风格隔离损坏清单。
    warnings.push('部分风格参考帧不可用：' + (err?.message || String(err)))
    const styles = JSON.parse(readFileSync(new URL('./mgstyles/catalog.json', import.meta.url), 'utf8')).styles
    return styles.flatMap(style => referenceMedia(style.slug, false, []))
  }
}

const matches = (value, expected, exact = false) => {
  const actual = String(value || '').toLowerCase()
  return exact ? actual === expected : actual.includes(expected)
}

function referenceMatches(query) {
  if (!query) return null
  if (query.startsWith('style-reference/')) {
    const slug = query.split('/')[1]
    return /^[a-z0-9][a-z0-9-]*$/.test(slug || '') ? [slug] : []
  }
  // 与参考帧通用名称匹配时需遍历全部风格；具体风格查询仅检查其对应图片。
  if (query.startsWith('frame') ||
      ['style-reference', '风格参考帧', '参考帧', 'frame-'].some(name => name.includes(query))) return null
  const styles = JSON.parse(readFileSync(new URL('./mgstyles/catalog.json', import.meta.url), 'utf8')).styles
  return styles.filter(style => [style.slug, style.name, style.en].some(value => matches(value, query))).map(style => style.slug)
}

export function listMediaLibrary({ query = '', category = '' } = {}) {
  const q = String(query).trim().toLowerCase(), cat = String(category).trim().toLowerCase()
  const warnings = []
  // “拼贴参考帧”与“拼贴 参考帧”都属于按风格查询；保留完整 ID 的斜线以便精确查找。
  const refQuery = q.startsWith('style-reference/') ? q : q.replace(/风格参考帧|参考帧|style-reference/g, '').trim()
  // 只查询纹理或声音类别时不访问独立参考帧库。
  const includeRefs = !cat || ['style-reference', '风格参考帧', 'image'].includes(cat)
  const matchedSlugs = includeRefs ? referenceMatches(refQuery) : []
  const required = ['style-reference', '风格参考帧'].includes(cat) || q.includes('参考帧') || q.includes('style-reference')
  const refs = matchedSlugs === null ? referenceMedia(undefined, required, warnings) : matchedSlugs.flatMap(slug => referenceMedia(slug, required, warnings))
  const publicRefs = refs.map(({ path: _path, ...item }) => item).filter(item =>
    (!refQuery || [item.name, item.category, item.categoryName, item.id, item.slug, item.styleName].some(v => matches(v, refQuery))))
  // 独立参考帧查询不依赖旧版纹理/音频索引。
  const upstream = ['style-reference', '风格参考帧'].includes(cat) ? [] : upstreamMedia()
  const matchingUpstream = upstream.filter(item => !q || [item.name, item.category, item.categoryName, item.id].some(v => matches(v, q)))
  const results = [...matchingUpstream, ...publicRefs].filter(item =>
    !cat || [item.category, item.categoryName, item.kind].some(v => matches(v, cat, true)))
  if (warnings.length) {
    // Array return stays backward compatible; the host may surface diagnostics even for zero results.
    Object.defineProperty(results, 'libraryWarnings', { value: warnings })
    if (results.length) results[0] = { ...results[0], libraryWarnings: warnings }
  }
  return results
}

export async function importMediaLibrary(projectDir, id) {
  if (typeof id === 'string' && id.startsWith('style-reference/')) {
    if (!/^style-reference\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error('风格参考帧素材 id 无效')
    const slug = id.split('/')[1]
    const item = referenceMedia(slug, true).find(entry => entry.id === id)
    if (!item) throw new Error('未找到风格参考帧，请先使用 motion_assets library 获取 id')
    const data = readFileSync(item.path)
    const sha256 = createHash('sha256').update(data).digest('hex')
    if (!/^[0-9a-f]{64}$/.test(item.sha256 || '') || sha256 !== item.sha256 || data.length !== item.bytes) {
      throw new Error('风格参考帧校验失败：' + id)
    }
    // 导入已校验的字节快照，避免源文件在校验与复制之间被替换。
    const snapshot = join(tmpdir(), 'drawai-style-reference-' + randomUUID() + extname(item.path))
    writeFileSync(snapshot, data, { flag: 'wx' })
    let entry
    try {
      entry = await captureAsset(projectDir, snapshot, { name: basename(item.path), source: item.source, license: item.license,
        caption: `${item.categoryName}: ${item.name}（${item.license}）` })
    } finally {
      try { unlinkSync(snapshot) } catch { /* 临时快照可能已被清理 */ }
    }
    if (entry.sha256 !== sha256) throw new Error('风格参考帧在导入期间发生变化：' + id)
    const integrity = { sha256, expectedSha256: item.sha256, warnings: [] }
    const manifest = readAssets(projectDir)
    const saved = manifest.items.find(value => value.file === entry.file)
    if (saved) { saved.libraryId = id; saved.integrity = integrity; saved.source = item.source; saved.license = item.license; writeAssets(projectDir, manifest) }
    return { ...entry, source: item.source, libraryId: id, license: item.license, integrity }
  }
  const item = upstreamMedia().find(entry => entry.id === id)
  if (!item) throw new Error('未找到内置素材，请先使用 motion_assets library 获取 id')
  const file = join(root() || '', ...item.id.split('/'))
  if (!existsSync(file)) throw new Error('插件素材文件缺失：' + item.id)
  const data = readFileSync(file)
  const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
  const sha256 = createHash('sha256').update(data).digest('hex')
  const upstreamMatches = data.length === item.bytes && hash === item.gitSha
  let expectedSha256 = null
  try { expectedSha256 = JSON.parse(readFileSync(checksumPath(), 'utf8')).files[item.id]?.sha256 || null } catch { /* optional diagnostic manifest */ }
  const warnings = []
  if (!upstreamMatches) warnings.push('素材与上游 Git SHA-1 或大小不一致，已按本地实际文件导入')
  if (expectedSha256 && expectedSha256 !== sha256) warnings.push('素材与插件 SHA-256 校验清单不一致，已按本地实际文件导入')
  if (!expectedSha256) warnings.push('插件 SHA-256 校验清单缺少该素材')
  const license = upstreamMatches ? item.license : '未确认（本地内容与上游记录不一致）'
  const source = upstreamMatches ? item.source : '插件内置文件（上游参考：' + item.source + '）'
  const entry = await captureAsset(projectDir, file, { source, license,
    caption: `${item.categoryName}: ${item.name}（${license}）` })
  const integrity = { sha256, expectedSha256, gitSha1: hash, expectedGitSha1: item.gitSha, warnings }
  const manifest = readAssets(projectDir)
  const saved = manifest.items.find(value => value.file === entry.file)
  if (saved) { saved.libraryId = item.id; saved.integrity = integrity; saved.source = source; saved.license = license; writeAssets(projectDir, manifest) }
  return { ...entry, source, libraryId: item.id, license, integrity }
}
