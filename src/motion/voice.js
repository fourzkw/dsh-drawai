// 旁白（TTS）：一句台词 → 一条音轨 + 一条字幕。
//
// 为什么不内置合成器：旁白是这条片子自己的话，只能合成；而 edge-tts 的鉴权
// （Sec-MS-GEC）是社区逆向维护的，JS 里重写一遍等于自己扛一份维护债。pip 包
// 由上游跟着微软改，我们只负责调它 —— 拿不到 edge 就退回 Windows SAPI。
//
// 为什么要 Python 桥：词级时间戳只存在于 edge_tts 的 WordBoundary 事件里
// （CLI 没有这个开关），所以走 edge-speech.py；参数与结果都走文件，不开管道。
//
// 时长从哪来：合成前按字速估（中文 cps≈4.8），合成后用真实字节数校正
// （edge 输出 48kbps CBR，字节数 / 6000 = 秒），再重排一次镜头。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { probeAudio } from './assets.js'
import { parseProjectJson } from './json.js'

export const VOICE_DEFAULTS = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  pitch: '+0Hz',
  cps: 4.8, // 中文字/秒（+0% 语速的实测区间 4.2–5.4，取中位）
  leadFrames: 8, // 每镜第一句之前的气口
  gapFrames: 8, // 句与句之间
  tailFrames: 12, // 最后一镜留一点呼吸
  minSeconds: 0.9,
  maxSeconds: 9,
  gainDb: 0, // 混音里旁白要比 BGM 高 10–14dB，BGM 侧压
}

// 下拉里的候选（--list-voices 的 zh-CN 实测结果，留一份离线兜底）
export const VOICE_CHOICES = [
  { name: 'zh-CN-XiaoxiaoNeural', gender: '女', tags: 'News/Novel/Warm', note: '科普叙述默认，最稳' },
  { name: 'zh-CN-YunxiNeural', gender: '男', tags: 'Novel/Sunshine', note: '更亮更年轻' },
  { name: 'zh-CN-YunjianNeural', gender: '男', tags: 'Sports/Passion', note: '有力量，适合"数字很吓人"的段落' },
  { name: 'zh-CN-YunyangNeural', gender: '男', tags: 'News/Professional', note: '新闻播报腔，权威但略板' },
  { name: 'zh-CN-XiaoyiNeural', gender: '女', tags: 'Cartoon/Lively', note: '轻松向' },
  { name: 'zh-CN-YunxiaNeural', gender: '男', tags: 'Cartoon/Cute', note: '轻松向' },
]

const HELPER = fileURLToPath(new URL('./edge-speech.py', import.meta.url))
let pythonCache
let edgeCache

/** 找一个能用的 Python 3；DRAWAI_PYTHON 可强制指定。只认退出码，不开管道。 */
export function pythonCommand() {
  if (pythonCache !== undefined) return pythonCache
  const candidates = []
  if (process.env.DRAWAI_PYTHON) candidates.push([process.env.DRAWAI_PYTHON])
  candidates.push(['py', '-3'], ['python3'], ['python'])
  pythonCache = null
  for (const candidate of candidates) {
    if (spawnSyncOk(candidate[0], [...candidate.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'])) {
      pythonCache = candidate
      break
    }
  }
  return pythonCache
}

// 探测用它而不是 spawn：stdio 全忽略，不建管道（受限环境里 pipe 会 EPERM），
// 也不占事件循环 —— 探测必须同步出结果，后面的分支才知道走 edge 还是 sapi。
function spawnSyncOk(command, args, timeoutMs = 8000) {
  try {
    return spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: timeoutMs }).status === 0
  } catch {
    return false
  }
}

/** edge-tts 是否可用（导入一次就算数）。 */
export async function edgeAvailable() {
  if (edgeCache !== undefined) return edgeCache
  const python = pythonCommand()
  if (!python) {
    edgeCache = false
    return false
  }
  edgeCache = await run(python[0], [...python.slice(1), '-c', 'import edge_tts'], 15000) === 0
  return edgeCache
}

function run(command, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let done = false
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill() } catch { /* 已退出 */ }
      resolve(-1)
    }, timeoutMs)
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(-1) } })
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve(code) } })
  })
}

export function cacheKeyOf({ voice, rate, pitch, text }) {
  return createHash('sha1').update([voice, rate, pitch, text].join('|'), 'utf8').digest('hex').slice(0, 16)
}

export function voiceDirOf(dir) {
  return join(dir, 'assets', 'voice')
}

function readMeta(dir, key) {
  const file = join(voiceDirOf(dir), key + '.json')
  if (!existsSync(file)) return null
  try {
    return parseProjectJson(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 合成一句（有缓存就直接用）。返回 {file, seconds, words, voice, provider}，file 相对 assets/。 */
export async function synthesizeLine(text, options = {}) {
  const dir = options.dir
  const cfg = { ...VOICE_DEFAULTS, ...options }
  const key = cacheKeyOf({ voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch, text })
  const cached = readMeta(dir, key)
  if (cached && existsSync(join(dir, 'assets', cached.file)) && !options.force) return { ...cached, key, provider: cached.provider || 'edge' }

  mkdirSync(voiceDirOf(dir), { recursive: true })
  const provider = (await edgeAvailable()) ? 'edge' : 'sapi'
  const result = provider === 'edge'
    ? await edgeSay(dir, key, text, cfg)
    : await sapiSay(dir, key, text)
  const meta = { ...result, key, voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch, text, provider }
  writeFileSync(join(voiceDirOf(dir), key + '.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return meta
}

async function edgeSay(dir, key, text, cfg) {
  const python = pythonCommand()
  if (!python) throw new Error('找不到 Python 3：旁白合成需要本机 Python + edge-tts')
  const tmpDir = join(dir, '.out', 'voice')
  mkdirSync(tmpDir, { recursive: true })
  const jobPath = join(tmpDir, key + '.json')
  const mp3 = join(voiceDirOf(dir), key + '.mp3')
  writeFileSync(jobPath, JSON.stringify({ text, voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch, out: mp3 }, null, 2), 'utf8')
  const code = await run(python[0], [...python.slice(1), HELPER, jobPath], 120000)
  const resultPath = join(tmpDir, key + '.result.json')
  let payload = null
  try { payload = parseProjectJson(readFileSync(resultPath, 'utf8')) } catch { payload = null }
  rmSync(jobPath, { force: true })
  rmSync(resultPath, { force: true })
  if (code !== 0 || !payload || !payload.ok) {
    throw new Error('edge-tts 合成失败：' + (payload && payload.error ? payload.error : '退出码 ' + code))
  }
  return { file: 'voice/' + key + '.mp3', seconds: payload.seconds, words: payload.words || [] }
}

// SAPI 兜底：零安装，音色是老式播音腔，只用来把链路跑通。
async function sapiSay(dir, key, text) {
  const wav = join(voiceDirOf(dir), key + '.sapi.wav')
  const txt = join(dir, '.out', 'voice', key + '.txt')
  const ps1 = join(dir, '.out', 'voice', key + '.ps1')
  mkdirSync(join(dir, '.out', 'voice'), { recursive: true })
  writeFileSync(txt, text, 'utf8')
  writeFileSync(ps1, [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$s.SetOutputToWaveFile('" + wav.replace(/'/g, "''") + "')",
    "$s.Speak([IO.File]::ReadAllText('" + txt.replace(/'/g, "''") + "', [Text.Encoding]::UTF8))",
    '$s.Dispose()',
  ].join('\n'), 'utf8')
  const code = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], 120000)
  rmSync(txt, { force: true })
  rmSync(ps1, { force: true })
  if (code !== 0 || !existsSync(wav)) throw new Error('SAPI 合成失败（退出码 ' + code + '）')
  const probe = await probeAudio(wav)
  return { file: 'voice/' + key + '.sapi.wav', seconds: probe.seconds, words: [] }
}

// ---- 脚本 ----

const HEADING = /^#{1,6}\s*(?:shot[- ]?)?(\d+)\s*$/i

/**
 * 解析 voice.script.md：
 *   ## shot-1
 *   晚上十点，今天最后一杯。
 *   ## shot-2
 *   ...
 * 一句一行；`>` 开头的行当备注丢掉。
 */
export function parseScript(markdown) {
  const shots = []
  let current = null
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trim()
    const heading = HEADING.exec(line)
    if (heading) {
      current = { shotId: 'shot-' + Number(heading[1]), lines: [] }
      shots.push(current)
      continue
    }
    if (!line || line.startsWith('>') || line.startsWith('//')) continue
    if (!current) continue
    current.lines.push({ index: current.lines.length, text: line })
  }
  return shots.filter((shot) => shot.lines.length > 0)
}

/** 读脚本：inline（以 # 开头）或文件路径（相对工程目录 / 绝对路径）。 */
export function readScript(dir, script) {
  const inline = String(script || '')
  if (inline.trim().startsWith('#')) return { markdown: inline, source: '(inline)' }
  const fallback = join(dir, 'voice.script.md')
  const path = inline.trim() ? (isAbsolute(inline) ? inline : join(dir, inline.trim())) : fallback
  if (!existsSync(path)) {
    if (!inline.trim() && !existsSync(fallback)) throw new Error('没有旁白脚本：写在 <工程>/voice.script.md，或直接传脚本正文（以 # 开头）')
    throw new Error('读不到旁白脚本：' + path)
  }
  return { markdown: readFileSync(path, 'utf8'), source: path }
}

/** 估时长：按字速 + 标点停顿；标点（。！？；）每处多算 0.25 秒。 */
export function estimateFrames(text, options = {}) {
  const cfg = { ...VOICE_DEFAULTS, ...options }
  const fps = Number(cfg.fps) || 30
  const body = String(text).replace(/\s+/g, '')
  const chars = body.length
  const stops = (body.match(/[。！？；!?;]/g) || []).length
  const commas = (body.match(/[，、,]/g) || []).length
  const seconds = Math.min(cfg.maxSeconds, Math.max(cfg.minSeconds, chars / cfg.cps + stops * 0.25 + commas * 0.12))
  return { seconds: Math.round(seconds * 1000) / 1000, frames: Math.max(1, Math.ceil(seconds * fps)) }
}

/**
 * 重排：旁白决定镜头有多长。
 *
 * fit = 'grow'（默认，镜头只增不减）| 'exact'（按旁白收紧）| 'none'（只写字幕不动时长）
 * 返回新 timeline（不改原对象），voice 轨与 subtitles 一起重算。
 */
export function planNarration(timeline, scriptShots, options = {}) {
  const cfg = { ...VOICE_DEFAULTS, ...options }
  const fps = Number(timeline.fps) || 30
  const fit = options.fit || 'grow'
  const byShot = new Map(scriptShots.map((shot) => [shot.shotId, shot.lines]))
  const known = new Set(timeline.shots.map((shot) => shot.id))
  const unknown = [...byShot.keys()].filter((id) => !known.has(id))
  if (unknown.length) {
    // 静默丢掉是最坏的结果：脚本里写了、片子里没有，谁也不会发现少了一句。
    throw new Error('脚本里的 ' + unknown.join('、') + ' 不在时间轴上（现有：' + [...known].join('、') + '）')
  }
  const shots = []
  const lines = []
  let cursor = 0

  for (const shot of timeline.shots) {
    const script = byShot.get(shot.id) || []
    let t = cursor + cfg.leadFrames
    let lastEnd = t
    const planned = script.map((line, index) => {
      const frames = Number(line.frames) || estimateFrames(line.text, { ...cfg, fps }).frames
      const entry = {
        shotId: shot.id,
        index,
        text: line.text,
        from: t,
        frames,
        seconds: Math.round((frames / fps) * 1000) / 1000,
        measured: line.measured === true,
      }
      t += frames + cfg.gapFrames
      lastEnd = entry.from + entry.frames
      return entry
    })
    const needed = planned.length ? lastEnd + cfg.tailFrames - cursor : shot.durationFrames
    const duration = fit === 'none' ? shot.durationFrames
      : fit === 'exact' && planned.length ? Math.max(1, needed)
        : Math.max(shot.durationFrames, needed)
    shots.push({ ...shot, startFrame: cursor, durationFrames: duration })
    for (const entry of planned) {
      lines.push(entry)
      if (entry.from + entry.frames > cursor + duration) entry.overflow = true
    }
    cursor += duration
  }

  const next = { ...timeline, shots, durationInFrames: cursor }
  const keep = (Array.isArray(timeline.audio) ? timeline.audio : []).filter((cue) => cue && cue.role !== 'voice')
  next.audio = [
    ...keep,
    ...lines.map((line) => ({
      id: 'voice-' + line.shotId + '-' + (line.index + 1),
      file: line.file || voiceFileFor(line, cfg),
      role: 'voice',
      from: line.from,
      durationInFrames: line.frames,
      gainDb: Number(line.gainDb ?? cfg.gainDb),
      fadeIn: 0,
      fadeOut: 0,
      trimStart: 0,
      loop: false,
      duck: false,
    })),
  ].sort((a, b) => a.from - b.from)
  next.subtitles = lines.map((line) => ({ startFrame: line.from, endFrame: line.from + line.frames, text: line.text, shot: line.shotId }))
  next.narration = { voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch, cps: cfg.cps, fit }
  return { timeline: next, lines }
}

function voiceFileFor(line, cfg) {
  return 'voice/' + cacheKeyOf({ voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch, text: line.text }) + '.mp3'
}

/** 合成整片旁白：逐句合成 → 用真实时长重排。已合成的句子不会再调一次网。 */
export async function sayNarration(dir, timeline, scriptShots, options = {}, onProgress) {
  const cfg = { ...VOICE_DEFAULTS, ...options }
  const fps = Number(timeline.fps) || 30
  const total = scriptShots.reduce((sum, shot) => sum + shot.lines.length, 0)
  const enriched = []
  let done = 0
  for (const shot of scriptShots) {
    const lines = []
    for (const line of shot.lines) {
      const result = await synthesizeLine(line.text, { ...cfg, dir, force: options.force })
      done += 1
      if (onProgress) onProgress(done, total, line.text)
      lines.push({ ...line, file: result.file, frames: Math.ceil(result.seconds * fps), measured: true, words: result.words })
    }
    enriched.push({ ...shot, lines })
  }
  const planned = planNarration(timeline, enriched, cfg)
  const words = enriched.flatMap((shot) => shot.lines.flatMap((line) => line.words || []))
  return { ...planned, words, synthesized: total }
}

/** 已有音频（手录或早先合成过）：只按真实时长重排，不再合成。 */
export async function alignNarration(dir, timeline, scriptShots, options = {}) {
  const cfg = { ...VOICE_DEFAULTS, ...options }
  const fps = Number(timeline.fps) || 30
  const enriched = []
  for (const shot of scriptShots) {
    const lines = []
    for (const line of shot.lines) {
      const key = cacheKeyOf({ voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch, text: line.text })
      const meta = readMeta(dir, key)
      const relative = line.file || (meta && meta.file) || 'voice/' + key + '.mp3'
      const absolute = join(dir, 'assets', relative)
      if (!existsSync(absolute)) throw new Error('没有音频文件，先跑 motion_voice say：' + relative)
      const probe = await probeAudio(absolute)
      lines.push({ ...line, file: relative, frames: Math.ceil(probe.seconds * fps), measured: true })
    }
    enriched.push({ ...shot, lines })
  }
  return planNarration(timeline, enriched, cfg)
}

/** 交付前检查：句子超镜、气口过短、字幕与音轨对不上、旁白占满整镜。 */
export function checkNarration(timeline, lines, options = {}) {
  const cfg = { ...VOICE_DEFAULTS, ...options }
  const fps = Number(timeline.fps) || 30
  const checks = []
  const byShot = new Map(timeline.shots.map((shot) => [shot.id, shot]))
  let overflow = 0
  for (const line of lines) {
    const shot = byShot.get(line.shotId)
    if (!shot) continue
    if (line.from + line.frames > shot.startFrame + shot.durationFrames) overflow += 1
  }
  checks.push(overflow
    ? { level: 'fail', id: 'voice-overflow', message: overflow + ' 句旁白超出所属镜头' }
    : { level: 'pass', id: 'voice-overflow', message: '每句旁白都在自己的镜头里' })

  const tight = lines.filter((line, index) => index > 0 && line.shotId === lines[index - 1].shotId && line.from - (lines[index - 1].from + lines[index - 1].frames) < 4)
  checks.push(tight.length
    ? { level: 'warn', id: 'voice-gap', message: tight.length + ' 处句间气口 < 4 帧' }
    : { level: 'pass', id: 'voice-gap', message: '句间气口够' })

  const voiceCues = (timeline.audio || []).filter((cue) => cue.role === 'voice')
  const subtitleRows = Array.isArray(timeline.subtitles) ? timeline.subtitles : []
  checks.push(voiceCues.length === subtitleRows.length && voiceCues.length === lines.length
    ? { level: 'pass', id: 'voice-subtitle', message: '字幕 ' + subtitleRows.length + ' 条，与旁白一一对应' }
    : { level: 'fail', id: 'voice-subtitle', message: '字幕 ' + subtitleRows.length + ' 条 / 音轨 ' + voiceCues.length + ' 条 / 台词 ' + lines.length + ' 句，对不上' })

  const heavy = []
  for (const shot of timeline.shots) {
    const own = lines.filter((line) => line.shotId === shot.id)
    if (!own.length) continue
    const used = own.reduce((sum, line) => sum + line.frames, 0)
    if (used > shot.durationFrames * 0.85) heavy.push(shot.id + ' 旁白占 ' + Math.round((used / shot.durationFrames) * 100) + '%')
  }
  checks.push(heavy.length
    ? { level: 'warn', id: 'voice-density', message: '旁白太挤（留白不足）：' + heavy.join('、') }
    : { level: 'pass', id: 'voice-density', message: '每镜都留了画面呼吸的余地' })

  const verdict = checks.some((check) => check.level === 'fail') ? 'fail' : checks.some((check) => check.level === 'warn') ? 'warn' : 'pass'
  return { verdict, checks, fps, lines: lines.length }
}

export function describeNarration(lines, shots, fps) {
  if (!lines.length) return '（还没有旁白）'
  const byShot = new Map(shots.map((shot) => [shot.id, shot]))
  const rows = []
  let current = null
  for (const line of lines) {
    if (line.shotId !== current) {
      current = line.shotId
      const shot = byShot.get(current)
      rows.push('', current + '（' + (shot ? (shot.durationFrames / fps).toFixed(2) + 's' : '?') + '）')
    }
    rows.push('  ' + (line.from / fps).toFixed(2) + 's · ' + line.seconds.toFixed(2) + 's · ' + line.text)
  }
  return rows.join('\n').trim()
}

export function totalSpeechSeconds(lines, fps = 30) {
  return Math.round(lines.reduce((sum, line) => sum + line.frames, 0) / (Number(fps) || 30) * 10) / 10
}
