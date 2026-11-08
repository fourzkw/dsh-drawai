// 音效搜索与下载；来源信息保存在单一素材索引，不做许可证审批。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decodePcm } from './beats.js'
import { parseProjectJson } from './json.js'

const SITE = 'https://freesound.org'
const MANIFEST = 'audio-manifest.json'
const MAX_BYTES = 32 * 1024 * 1024
const UA = 'dsh-drawai/1.0 (Freesound SFX sourcing)'

function decodeAttr(value) {
  return String(value || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function attr(chunk, name) {
  const match = new RegExp('\\b' + name + '="([^"]*)"').exec(chunk)
  return match ? decodeAttr(match[1]) : ''
}

export function licenseCode(url) {
  if (!url) return null
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (!/^(www\.)?creativecommons\.org$/.test(parsed.hostname)) return null
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path === '/publicdomain/zero/1.0') return 'CC0-1.0'
  const by = /^\/licenses\/by\/(1\.0|2\.0|2\.5|3\.0|4\.0)$/.exec(path)
  return by ? 'CC-BY-' + by[1] : null
}

async function fetchText(url, signal) {
  const response = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal })
  if (!response.ok) throw new Error('Freesound 请求失败：HTTP ' + response.status)
  const type = response.headers.get('content-type') || ''
  if (!type.includes('text/html')) throw new Error('Freesound 返回的不是网页：' + type)
  return { text: await response.text(), url: response.url }
}

async function fetchBytes(url, signal) {
  const response = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal })
  if (!response.ok) throw new Error('下载失败：HTTP ' + response.status)
  const type = response.headers.get('content-type') || ''
  if (!/audio\/mpeg|audio\/mp3|octet-stream/.test(type)) throw new Error('下载到的不是 mp3：' + type)
  const length = Number(response.headers.get('content-length') || 0)
  if (length > MAX_BYTES) throw new Error('音效超过 32MB，换一个更短的')
  return { bytes: Buffer.from(await response.arrayBuffer()), url: response.url }
}

// Freesound 搜索结果页：每个结果块里有一个 data-player，带着 id/标题/时长/预览地址。
export function parseSearch(html) {
  const rows = []
  const chunks = String(html).split(/class="[^"]*\bbw-search__result\b/)
  for (const chunk of chunks.slice(1)) {
    const id = attr(chunk, 'data-sound-id')
    const preview = attr(chunk, 'data-mp3')
    const duration = Number(attr(chunk, 'data-duration'))
    if (!id || !preview || !Number.isFinite(duration) || duration <= 0) continue
    const licenseLabel = (/(?:title="License: )([^"]+)/.exec(chunk) || [])[1] || 'unknown'
    const page = new RegExp('href="([^"]*?/people/[^"]*?/sounds/' + id + '/)"').exec(chunk)
    rows.push({
      id: 'fs:' + id,
      title: attr(chunk, 'data-title') || 'untitled',
      author: attr(chunk, 'data-username') || 'unknown',
      seconds: duration,
      preview: preview.replace('-lq.mp3', '-hq.mp3'),
      pageUrl: page ? new URL(decodeAttr(page[1]), SITE).href : SITE + '/s/' + id + '/',
      licenseLabel,
    })
  }
  return rows
}

export async function searchSfx(options = {}) {
  const query = String(options.query || '').trim()
  if (!query) throw new Error('query 必填，例如 "paper whoosh"')
  const min = Math.max(0, Number(options.minDuration) || 0)
  const max = options.maxDuration === undefined || options.maxDuration === null || options.maxDuration === ''
    ? null : Number(options.maxDuration)
  if (max !== null && (!Number.isFinite(max) || max <= min)) throw new Error('maxDuration 要大于 minDuration')
  const limit = Math.max(1, Math.min(20, Math.round(Number(options.limit) || 8)))
  const filter = 'duration:[' + min + ' TO ' + (max === null ? '*' : max) + ']'
  const url = SITE + '/search/?' + new URLSearchParams({ q: query, f: filter, page: '1', s: 'Automatic by relevance' })
  const { text } = await fetchText(url, options.signal)
  const rows = parseSearch(text).filter((row) => {
    if (row.seconds < min) return false
    if (max !== null && row.seconds > max) return false
    return true
  })
  if (!rows.length && /no (?:sounds|results)|0 sounds|couldn't find|did not match/i.test(text)) {
    return { query, results: [], note: 'Freesound 没有匹配结果，换个更短的查询词' }
  }
  if (!rows.length) throw new Error('没解析出结果：Freesound 页面结构可能变了')
  return { query, results: rows.slice(0, limit) }
}

export async function fetchSound(id, signal) {
  const sid = String(id).replace(/^fs:/, '')
  if (!/^[1-9][0-9]*$/.test(sid)) throw new Error('音效 id 形如 fs:12345')
  const { text, url } = await fetchText(SITE + '/s/' + sid + '/', signal)
  const chunk = String(text).split('data-sound-id="' + sid + '"')
  if (chunk.length < 2) throw new Error('详情页没有这个音效：fs:' + sid)
  const body = chunk[1].slice(0, 8000)
  const preview = attr(body, 'data-mp3')
  const duration = Number(attr(body, 'data-duration'))
  if (!preview || !Number.isFinite(duration) || duration <= 0) throw new Error('详情页缺少预览或时长：fs:' + sid)
  const canonical = /\/people\/([^/]+)\/sounds\/[0-9]+\//.exec(new URL(url).pathname)
  if (!canonical) throw new Error('详情页不是规范的音效页：fs:' + sid)
  const licenses = new Set()
  for (const match of String(text).matchAll(/href="(https?:\/\/(?:www\.)?creativecommons\.org\/[^"]+)"/g)) licenses.add(match[1])
  const licenseUrl = [...licenses][0] || null
  const license = licenseCode(licenseUrl) || 'unknown'
  return {
    id: 'fs:' + sid,
    title: attr(body, 'data-title') || 'untitled',
    author: decodeURIComponent(canonical[1]),
    seconds: duration,
    preview: preview.replace('-lq.mp3', '-hq.mp3'),
    pageUrl: url,
    license,
    licenseUrl,
  }
}

// 10ms 窗的 RMS / 峰值 / 有效起止，跟上游 analyze 的口径一致（不是 LUFS）
async function measure(file) {
  const { pcm, sampleRate } = await decodePcm(file)
  const samples = pcm.length / 2
  if (!samples) throw new Error('音效是空的')
  const block = Math.max(1, Math.round(sampleRate * 0.01))
  const energies = []
  let peak = 0
  let squares = 0
  let sum = 0
  let count = 0
  for (let index = 0; index < samples; index++) {
    const value = pcm.readInt16LE(index * 2) / 32768
    const energy = value * value
    squares += energy
    sum += energy
    count += 1
    if (Math.abs(value) > peak) peak = Math.abs(value)
    if (count === block || index === samples - 1) {
      energies.push(Math.sqrt(sum / count))
      sum = 0
      count = 0
    }
  }
  const loudest = Math.max(...energies)
  const active = energies.map((value, index) => ({ value, index })).filter((item) => item.value >= loudest * 0.01)
  const seconds = samples / sampleRate
  const rmsDb = Math.round(20 * Math.log10(Math.max(Math.sqrt(squares / samples), 1e-6)) * 100) / 100
  const peakDb = Math.round(20 * Math.log10(Math.max(peak, 1e-6)) * 100) / 100
  return {
    sampleRate, channels: 1, seconds: Math.round(seconds * 1000) / 1000,
    peakDb, rmsDb,
    suggestedGainDb: Math.max(-6, Math.min(24, Math.round(-16 - rmsDb))),
    energyWindowSeconds: 0.01,
    energyPeakSeconds: Math.round((energies.indexOf(loudest) + 0.5) * 0.01 * 1000) / 1000,
    activeStartSeconds: Math.round(active[0].index * 0.01 * 1000) / 1000,
    activeEndSeconds: Math.round((active[active.length - 1].index + 1) * 0.01 * 1000) / 1000,
  }
}

export function readManifest(dir) {
  const file = join(dir, 'assets', MANIFEST)
  if (!existsSync(file)) return { version: 1, assets: [] }
  const raw = parseProjectJson(readFileSync(file, 'utf8'))
  if (raw.version !== 1 || !Array.isArray(raw.assets)) throw new Error('audio-manifest.json 结构不支持，换一个工程目录')
  return raw
}

function writeManifest(dir, manifest) {
  writeFileSync(join(dir, 'assets', MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

export async function getSfx(dir, ids, options = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id)).filter(Boolean)
  if (!list.length) throw new Error('ids 必填，形如 ["fs:12345"]')
  const sfxDir = join(dir, 'assets', 'sfx')
  mkdirSync(sfxDir, { recursive: true })
  const manifest = options.persist === false ? { version: 1, assets: [] } : readManifest(dir)
  const results = []
  for (const id of list) {
    try {
      const sound = await fetchSound(id, options.signal)
      const file = 'fs-' + sound.id.replace(/^fs:/, '') + '.mp3'
      const target = join(sfxDir, file)
      if (!existsSync(target)) {
        const { bytes } = await fetchBytes(sound.preview, options.signal)
        writeFileSync(target, bytes)
      }
      const analysis = await measure(target)
      const row = {
        ...sound,
        provider: 'freesound',
        file: 'sfx/' + file,
        bytes: statSync(target).size,
        sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
        downloadKind: 'mp3-preview-hq',
        isPreview: true,
        downloadedAt: new Date().toISOString(),
        changes: [],
        analysis,
      }
      manifest.assets = manifest.assets.filter((item) => item.id !== row.id).concat(row)
      if (options.persist !== false) writeManifest(dir, manifest)
      results.push({ ok: true, asset: row })
    } catch (error) {
      results.push({ ok: false, id, error: String(error.message || error) })
    }
  }
  return { dir: sfxDir, results }
}

export function listSfx(dir) {
  const manifest = readManifest(dir)
  return manifest.assets.map((asset) => {
    const gain = asset.analysis?.suggestedGainDb
      ?? (typeof asset.analysis?.rmsDb === 'number' ? Math.max(-6, Math.min(24, Math.round(-16 - asset.analysis.rmsDb))) : 0)
    return {
      id: asset.id, file: asset.file, title: asset.title, author: asset.author,
      license: asset.license, seconds: asset.analysis?.seconds, peakDb: asset.analysis?.peakDb,
      suggestedGainDb: gain,
      use: 'wb audio add --file "' + asset.file + '" --role sfx --gain ' + gain,
    }
  })
}
