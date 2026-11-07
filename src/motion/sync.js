// One source of truth: source-music seconds -> edit events -> source SFX peaks.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { decodePcm } from './beats.js'
import { runFfmpeg } from './ffmpeg.js'
import { parseProjectJson } from './json.js'

const number = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(name + ' 必须是有限数字')
  return value
}
export function assetPath(dir, file) {
  const root = resolve(dir, 'assets'), path = resolve(root, file || '')
  const rel = relative(root, path)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('同步音频必须位于工程 assets 内')
  return path
}
export const syncKey = (timeline) => createHash('sha256').update(JSON.stringify(timeline)).digest('hex')
export function syncRevision(dir, timeline) {
  const music = timeline.audio?.find((cue) => cue.id === timeline.sync?.musicCueId)
  if (timeline.sync?.analysisSourceHash && (!music || timeline.sync.analysisSourceHash !== filmHash(assetPath(dir, music.file)))) throw new Error('音乐文件已变更，请重新 motion_sync bind 分析后绑定')
  const hash = createHash('sha256').update(syncKey(timeline))
  for (const shot of timeline.shots) {
    const file = join(dir, shot.file || '')
    if (shot.file && existsSync(file)) hash.update(readFileSync(file))
  }
  for (const cue of timeline.audio || []) hash.update(readFileSync(assetPath(dir, cue.file)))
  const walk = (path) => {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) hash.update(entry.name).update(readFileSync(file))
    }
  }
  walk(join(dir, 'components'))
  walk(join(dir, 'assets'))
  for (const entry of readdirSync(dir).sort()) if (/\.(tsx?|jsx?)$/.test(entry) && !/^index\./.test(entry)) hash.update(entry).update(readFileSync(join(dir, entry)))
  return hash.digest('hex')
}
export const filmHash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

export function resolveSync(input) {
  const timeline = structuredClone(input), sync = timeline.sync
  if (!sync) return timeline
  const fps = number(timeline.fps, 'fps')
  if (sync.toleranceFrames !== undefined && (number(sync.toleranceFrames, 'toleranceFrames') < 0 || sync.toleranceFrames > 3)) throw new Error('toleranceFrames 必须在0–3内')
  if (fps <= 0 || !Array.isArray(sync.anchors) || !sync.anchors.length || sync.anchors.length > 200) throw new Error('sync 需要 1–200 个 anchors')
  const music = timeline.audio?.find((cue) => cue.id === sync.musicCueId)
  if (!music || music.loop) throw new Error('sync.musicCueId 必须指向不循环的音乐轨')
  const offset = sync.outputOffsetSeconds === undefined ? 0 : number(sync.outputOffsetSeconds, 'outputOffsetSeconds')
  if (Math.abs(offset) > 1) throw new Error('输出偏移超出 ±1 秒')
  const ids = new Set(), targets = new Set(), cueIds = new Set()
  const rows = sync.anchors.map((anchor) => {
    if (typeof anchor.id !== 'string' || !anchor.id || ids.has(anchor.id)) throw new Error('anchor.id 必须唯一')
    ids.add(anchor.id)
    if (anchor.visual) visualPeak(Buffer.alloc(0), 1, 1, 0, anchor.visual)
    if (anchor.sfx !== undefined && !Array.isArray(anchor.sfx)) throw new Error('sfx 必须是绑定数组')
    if (!['cut', 'action'].includes(anchor.type)) throw new Error('anchor.type 必须是 cut/action')
    const shot = timeline.shots.find((item) => item.id === anchor.shotId)
    if (!shot) throw new Error('锚点引用了不存在的镜头：' + anchor.shotId)
    const targetKey = anchor.type + ':' + anchor.shotId + ':' + (anchor.type === 'action' ? anchor.name : '')
    if (targets.has(targetKey)) throw new Error('同一个切镜或动作不能重复绑定')
    targets.add(targetKey)
    if (anchor.type === 'action' && (typeof anchor.name !== 'string' || !anchor.name)) throw new Error('动作锚点需要 name')
    if ((anchor.at === undefined) === (anchor.beat === undefined)) throw new Error('锚点必须且只能给 at（源音乐秒）或 beat（0 起拍号）')
    let sourceSeconds
    if (anchor.at !== undefined) sourceSeconds = number(anchor.at, 'at')
    else {
      const grid = sync.analysis?.grid
      if (!grid || ![grid.t0, grid.periodMs, grid.residualMs, grid.coverage].every(Number.isFinite) || grid.periodMs <= 0 || grid.residualMs > 15 || grid.coverage < 0.45) throw new Error('按拍号绑定需要通过验收的音乐网格；否则使用 at 实测瞬态')
      const beat = number(anchor.beat, 'beat')
      if (beat < 0) throw new Error('beat 必须从0起')
      sourceSeconds = grid.t0 + beat * grid.periodMs / 1000
    }
    const musicLocal = sourceSeconds - (music.trimStart || 0)
    if (musicLocal < 0 || musicLocal * fps >= music.durationInFrames) throw new Error('拍点超出音乐播放窗口：' + anchor.id)
    const seconds = music.from / fps + musicLocal + offset
    const frame = Math.round(seconds * fps)
    if (frame < 0 || frame >= timeline.durationInFrames) throw new Error('锚点超出影片范围：' + anchor.id)
    if (anchor.type === 'cut') shot.startFrame = frame
    return { ...anchor, sourceSeconds, seconds, frame, quantizationMs: (frame / fps - seconds) * 1000 }
  })
  for (let i = 0; i < timeline.shots.length; i++) {
    const shot = timeline.shots[i], end = timeline.shots[i + 1]?.startFrame ?? timeline.durationInFrames
    if (shot.startFrame < 0 || end <= shot.startFrame) throw new Error('切镜绑定导致镜头倒序或长度为零')
    shot.durationFrames = end - shot.startFrame
    shot.anchors = Object.create(null)
  }
  for (const row of rows) {
    const shot = timeline.shots.find((item) => item.id === row.shotId)
    if (row.frame < shot.startFrame || row.frame >= shot.startFrame + shot.durationFrames) throw new Error('动作锚点不在所属镜头内：' + row.id)
    if (row.type === 'action') shot.anchors[row.name] = row.frame - shot.startFrame
    for (const sfx of row.sfx || []) {
      if (cueIds.has(sfx.cueId) || sfx.cueId === music.id) throw new Error('音效轨不能重复绑定或绑定音乐自身')
      cueIds.add(sfx.cueId)
      const cue = timeline.audio.find((item) => item.id === sfx.cueId)
      if (!cue || cue.loop) throw new Error('音效绑定需要存在且不循环的 cueId')
      const lag = number(sfx.peakSeconds, 'peakSeconds') - (cue.trimStart || 0)
      if (lag < 0 || lag * fps >= cue.durationInFrames) throw new Error('音效峰值超出裁剪窗口')
      const from = Math.round(row.frame - (lag + offset) * fps)
      if (from < 0 || from + cue.durationInFrames > timeline.durationInFrames) throw new Error('音效绑定超出影片范围，不会静默截断')
      cue.from = from
    }
  }
  sync.resolved = rows
  return timeline
}

// Normalized waveform matching around an expected transient. Low/ambiguous
// matches remain unverified; absence of evidence must never become a pass.
export function matchTransient(source, output, sourceAt, expectedAt, sampleRate, searchSeconds = 0.2) {
  const radius = Math.round(sampleRate * 0.025), center = Math.round(sourceAt * sampleRate)
  const step = 4, template = []
  for (let i = -radius; i <= radius; i += step) template.push(source[center + i] || 0)
  const norm = Math.sqrt(template.reduce((sum, x) => sum + x * x, 0))
  if (!norm) return null
  let best = { score: -1, at: 0 }, second = -1
  const scores = []
  const start = Math.max(radius, Math.round((expectedAt - searchSeconds) * sampleRate)), end = Math.min(output.length - radius - 1, Math.round((expectedAt + searchSeconds) * sampleRate))
  for (let at = start; at <= end; at++) {
    let dot = 0, energy = 0
    for (let i = 0; i < template.length; i++) { const x = output[at - radius + i * step]; dot += template[i] * x; energy += x * x }
    const score = energy ? dot / (norm * Math.sqrt(energy)) : 0
    scores.push({ at, score })
    if (score > best.score) best = { at, score }
  }
  for (const candidate of scores) if (Math.abs(candidate.at - best.at) > sampleRate * 0.01) second = Math.max(second, candidate.score)
  return best.score >= 0.45 && best.score - second >= 0.05 ? { at: best.at / sampleRate, confidence: best.score } : null
}
function samples(decoded) {
  return Float64Array.from({ length: decoded.pcm.length / 2 }, (_, i) => decoded.pcm.readInt16LE(i * 2) / 32768)
}

export function visualPeak(bytes, width, height, firstFrame, visual = {}) {
  if (visual.metric !== undefined && !['change', 'brightness'].includes(visual.metric)) throw new Error('visual.metric 必须为 change/brightness')
  if (visual.minSignal !== undefined && (number(visual.minSignal, 'minSignal') <= 0 || visual.minSignal > 255)) throw new Error('minSignal 必须在0–255内')
  const size = width * height, count = Math.floor(bytes.length / size), scores = []
  const roi = visual.roi || { x: 0, y: 0, w: 1, h: 1 }
  for (const key of ['x', 'y', 'w', 'h']) number(roi[key], 'visual.roi.' + key)
  if (roi.x < 0 || roi.y < 0 || roi.w <= 0 || roi.h <= 0 || roi.x + roi.w > 1 || roi.y + roi.h > 1) throw new Error('ROI 必须在 0–1 内')
  for (let f = 1; f < count; f++) {
    let sum = 0, n = 0
    for (let y = Math.floor(roi.y * height); y < Math.ceil((roi.y + roi.h) * height); y++) for (let x = Math.floor(roi.x * width); x < Math.ceil((roi.x + roi.w) * width); x++) {
      const i = y * width + x
      sum += visual.metric === 'brightness' ? bytes[f * size + i] : Math.abs(bytes[f * size + i] - bytes[(f - 1) * size + i]); n++
    }
    scores.push({ frame: firstFrame + f, score: sum / n })
  }
  scores.sort((a, b) => b.score - a.score)
  const best = scores[0], other = scores.find((item) => Math.abs(item.frame - best?.frame) > 1)
  return best && best.score >= (visual.minSignal ?? 8) && (!other || best.score > other.score * 1.15) ? best : null
}

export async function verifySync(dir, film, input) {
  const timeline = resolveSync(input), sync = timeline.sync
  if (!sync?.resolved?.length) throw new Error('尚未绑定锚点，先 motion_sync bind')
  const revision = syncRevision(dir, timeline)
  const receiptPath = film + '.sync.json'
  const receipt = existsSync(receiptPath) ? parseProjectJson(readFileSync(receiptPath, 'utf8')) : null
  if (receipt && receipt.revision !== revision) throw new Error('成片与当前绑定或场景版本不一致，请重新渲染后验收')
  if (receipt && receipt.filmHash !== filmHash(film)) throw new Error('成片文件与渲染回执不一致，请重新渲染')
  const out = join(dir, '.out', 'qa', 'sync'); mkdirSync(out, { recursive: true })
  const decoded = await decodePcm(film), output = samples(decoded), rate = decoded.sampleRate
  const cache = new Map()
  const load = async (cue) => {
    const path = assetPath(dir, cue.file)
    if (!cache.has(path)) cache.set(path, samples(await decodePcm(path)))
    return cache.get(path)
  }
  const music = timeline.audio.find((cue) => cue.id === sync.musicCueId), musicSource = await load(music)
  const rows = [], offsets = []
  for (const [index, anchor] of sync.resolved.entries()) {
    const heard = matchTransient(musicSource, output, anchor.sourceSeconds, anchor.seconds, rate)
    if (heard) offsets.push(heard.at - (music.from / timeline.fps + anchor.sourceSeconds - (music.trimStart || 0)))
    let visual = null
    // A cut is an observable frame difference. Continuous actions need an
    // explicitly selected metric/ROI; do not infer their semantic peak.
    if (anchor.type === 'cut' || anchor.visual) {
      const first = Math.max(0, anchor.frame - 6), last = Math.min(timeline.durationInFrames - 1, anchor.frame + 6)
      const path = join(out, 'anchor-' + index + '.gray')
      try {
        await runFfmpeg(['-loglevel', 'error', '-i', film, '-vf', 'select=between(n\\,' + first + '\\,' + last + '),scale=96:54,format=gray', '-vsync', '0', '-f', 'rawvideo', path], { cwd: dir, log: join(out, 'visual.log') })
        visual = visualPeak(readFileSync(path), 96, 54, first, anchor.visual)
        unlinkSync(join(out, 'visual.log'))
      } finally {
        if (existsSync(path)) unlinkSync(path)
      }
    }
    const sfxRows = []
    for (const binding of anchor.sfx || []) {
      const cue = timeline.audio.find((item) => item.id === binding.cueId)
      const match = await load(cue).then((source) => matchTransient(source, output, binding.peakSeconds, anchor.frame / timeline.fps, rate))
      sfxRows.push({ cueId: cue.id, measuredSeconds: match?.at ?? null, confidence: match?.confidence ?? null,
        errorFrames: match && heard ? (match.at - heard.at) * timeline.fps : null })
    }
    const error = heard && visual ? visual.frame - heard.at * timeline.fps : null
    const tolerance = sync.toleranceFrames ?? 2
    const status = error === null || sfxRows.some((item) => item.errorFrames === null) ? 'unverified'
      : Math.abs(error) > tolerance || sfxRows.some((item) => Math.abs(item.errorFrames) > tolerance) ? 'fail' : 'pass'
    rows.push({ id: anchor.id, type: anchor.type, plannedFrame: anchor.frame, quantizationMs: anchor.quantizationMs,
      measuredMusicSeconds: heard?.at ?? null, musicConfidence: heard?.confidence ?? null, measuredVisualFrame: visual?.frame ?? null,
      audiovisualErrorFrames: error, sfx: sfxRows, status })
  }
  offsets.sort((a, b) => a - b)
  const report = { version: 1, film, timelineKey: revision, renderReceipt: !!receipt, fps: timeline.fps, generatedAt: new Date().toISOString(),
    status: rows.some((row) => row.status === 'fail') ? 'fail' : rows.some((row) => row.status === 'unverified') ? 'unverified' : 'pass',
    measuredOutputOffsetSeconds: offsets.length >= 3 && offsets.at(-1) - offsets[0] < 0.015 ? offsets[Math.floor(offsets.length / 2)] : null,
    rows }
  if (!receipt) report.status = report.status === 'fail' ? 'fail' : 'unverified'
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  return report
}
