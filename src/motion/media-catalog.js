// Bundled upstream media. Only requested files are copied into a project.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureAsset, readAssets, writeAssets } from './assets.js'

const root = fileURLToPath(new URL('./media-library/', import.meta.url))
const indexPath = join(root, 'upstream-files.json')
const checksumPath = join(root, 'checksums.sha256.json')
const commit = '49052d80bfaf9fa8412cc9710530e5e95a3b8d8c'
const labels = { paper:'纸张', grain:'颗粒', dust:'灰尘', washi:'胶带', piano:'钢琴', harp:'竖琴', glock:'钟琴', marimba:'马林巴', kalimba:'拇指琴', vibraphone:'颤音琴', timpani:'定音鼓', woodblock:'木鱼', crash:'镲', suscymbal:'吊镲', cabasa:'卡巴萨', guiro:'刮胡', slapstick:'拍板', vibraslap:'颤响器', wineglass:'酒杯' }

export function listMediaLibrary({ query = '', category = '' } = {}) {
  if (!existsSync(indexPath)) return []
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  if (index.commit !== commit || !Array.isArray(index.files)) throw new Error('内置素材库索引无效')
  const q = String(query).trim().toLowerCase(), cat = String(category).trim().toLowerCase()
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
  }).filter(item => existsSync(join(root, ...item.id.split('/'))))
    .filter(item => (!cat || [item.category, item.categoryName, item.kind].some(v => v.toLowerCase() === cat))
    && (!q || [item.name, item.category, item.categoryName, item.id].some(v => v.toLowerCase().includes(q))))
}

export async function importMediaLibrary(projectDir, id) {
  const item = listMediaLibrary().find(entry => entry.id === id)
  if (!item) throw new Error('未找到内置素材，请先使用 motion_assets library 获取 id')
  const file = join(root, ...item.id.split('/'))
  if (!existsSync(file)) throw new Error('插件素材文件缺失：' + item.id)
  const data = readFileSync(file)
  const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
  const sha256 = createHash('sha256').update(data).digest('hex')
  const upstreamMatches = data.length === item.bytes && hash === item.gitSha
  let expectedSha256 = null
  try { expectedSha256 = JSON.parse(readFileSync(checksumPath, 'utf8')).files[item.id]?.sha256 || null } catch { /* optional diagnostic manifest */ }
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
