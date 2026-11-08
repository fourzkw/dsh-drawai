// 素材与声音：assets / sfx / audio / sync / verify / voice。
// 这些在插件里都挂在画布节点上（素材来自画布位图节点、音轨挂在视频节点的工程里）；
// 命令行版一律以工程目录为锚，--file 指本机文件，其余行为照搬。

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { asArray, bool, emit, line, num, requireProjectDir, table } from '../cli.mjs'
import { requireFfmpeg } from '../ffmpeg.mjs'

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + 'MB'

/** `--file` 可以是本机路径、工程内相对路径（.out/poster.png），也可以是工程 assets/ 里的文件名。 */
function sourceFile(flags, dir, field = 'file') {
  const raw = flags[field]
  if (!raw || raw === true) throw new Error('要给 --' + field.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase()) + '（本机文件路径、工程内相对路径，或工程 assets/ 里的文件名）')
  const candidates = isAbsolute(String(raw))
    ? [String(raw)]
    : [resolve(process.cwd(), String(raw)), resolve(dir, String(raw)), join(dir, 'assets', String(raw))]
  const hit = candidates.find((path) => existsSync(path))
  if (!hit) throw new Error('找不到文件：' + raw)
  return hit
}

// ── assets ──────────────────────────────────────────────────────────
export async function assets(flags, positional) {
  const action = positional[0] || flags.action || 'list'
  if (['palette', 'crop', 'capture'].includes(action)) requireFfmpeg('素材处理')
  const dir = requireProjectDir(flags, positional.slice(1))
  const engine = await import('../../engine/motion/assets.js')

  if (action === 'list') {
    const items = engine.listAssets(dir)
    if (flags.json) return emit('', { assets: items })
    if (!items.length) return line('工程里还没有素材。`wb assets library 纸张` 看内置素材，`wb assets capture --file X` 引本机文件。')
    return line(table(['文件', '类型', '大小', '尺寸/时长'], items.map((item) => [item.file, item.kind, mb(item.bytes), item.kind === 'audio' ? item.seconds + 's' : item.kind === 'image' ? item.width + '×' + item.height : (item.seconds || '') + 's'])))
  }

  if (action === 'library') {
    const { listMediaLibrary, importMediaLibrary } = await import('../../engine/motion/media-catalog.js')
    if (flags.id) {
      const entry = await importMediaLibrary(dir, String(flags.id))
      if (flags.json) return emit('', { ok: true, asset: entry })
      return line('已引入内置素材：' + entry.file + '（' + (entry.license || '许可未知') + '）\n场景里 staticFile("' + basename(entry.file) + '") 引用。')
    }
    const list = listMediaLibrary({ query: flags.query, category: flags.category })
    if (flags.json) return emit('', { assets: list })
    if (!list.length) return line('没有匹配的内置素材。去掉 --query 再试，或 `wb assets gather --url <站点>` 去站点上收。')
    return line(table(['id', '类别', '类型', '大小'], list.map((item) => [item.id, item.categoryName, item.kind, mb(item.bytes)])))
      + '\n用 `wb assets library --id <id>` 引到工程里。'
  }

  if (action === 'use') {
    const { importMediaLibrary } = await import('../../engine/motion/media-catalog.js')
    const id = positional[1] || flags.id
    const entry = await importMediaLibrary(dir, String(id))
    if (flags.json) return emit('', { ok: true, asset: entry })
    return line('已引入：' + entry.file)
  }

  if (action === 'page') {
    const { capturePage } = await import('../../engine/motion/capture.js')
    if (!flags.html && !flags.url) throw new Error('page 需要 --url（网页地址）或 --html（直接给 HTML 源文本）')
    const shot = await capturePage(dir, {
      url: flags.url, html: flags.html, name: flags.name, caption: flags.caption,
      width: num(flags.width, 1440), height: num(flags.height, 900), scale: num(flags.scale, 2), wait: num(flags.wait, 1200),
    })
    if (flags.json) return emit('', { ok: true, asset: shot })
    return line('截图：' + shot.file + '（' + shot.width + '×' + shot.height + '）')
  }

  if (action === 'gather' || action === 'collect') {
    const { gatherAssets, collectPageAssets } = await import('../../engine/motion/collect.js')
    const options = {
      url: flags.url, urls: asArray(flags.urls), brand: flags.brand,
      pages: num(flags.pages, 4), limit: num(flags.limit, flags.brand ? 12 : 8),
      minWidth: num(flags.minWidth, 240), width: num(flags.width, 1440), dryRun: bool(flags.dryRun),
    }
    const result = action === 'gather' ? await gatherAssets(dir, options) : await collectPageAssets(dir, flags.url, options)
    if (flags.json) return emit('', { ok: true, ...result })
    line((result.title ? result.title + ' · ' : '') + (result.url || '') + (result.dryRun ? '（只扫不下载）' : ''))
    if (result.colors?.length) line('  实测配色：' + result.colors.slice(0, 8).map((color) => color.hex || color).join(' '))
    if (result.fonts?.length) line('  字体：' + result.fonts.slice(0, 5).join('、'))
    if (result.candidates?.length) line('  候选：' + result.candidates.length + ' 条' + (result.dryRun ? '（去掉 --dry-run 才下载）' : ''))
    if (result.downloaded?.length) line('  已下载：' + result.downloaded.map((item) => item.file).join('、'))
    if (result.skipped?.length) line('  跳过 ' + result.skipped.length + ' 条：' + result.skipped.slice(0, 3).map((item) => item.reason).join('；'))
    if (result.next) line('\n' + result.next)
    return
  }

  if (action === 'fetch') {
    if (!flags.url) throw new Error('fetch 需要 --url（素材直链，比如官方 logo 的 .svg/.png）')
    const entry = await engine.fetchAsset(dir, String(flags.url), { name: flags.name, caption: flags.caption })
    if (flags.json) return emit('', { ok: true, asset: entry })
    return line('已下载：' + entry.file + '（' + mb(entry.bytes) + '）')
  }

  if (action === 'palette') {
    const file = sourceFile(flags, dir)
    const result = await engine.colorsOf(file, num(flags.colors, 8))
    if (flags.json) return emit('', { ok: true, ...result })
    line('平均色 ' + (result.average || '—'))
    return line('色板 ' + result.colors.join('  '))
  }

  if (action === 'crop') {
    const file = sourceFile(flags, dir)
    const x = num(flags.x), y = num(flags.y), w = num(flags.w, num(flags.width)), h = num(flags.h, num(flags.height))
    if ([x, y, w, h].some((value) => typeof value !== 'number')) throw new Error('crop 需要 --x --y --w --h（像素）')
    const entry = await engine.cropAsset(dir, file, { name: flags.name, caption: flags.caption, x, y, w, h })
    if (flags.json) return emit('', { ok: true, asset: entry })
    return line('已裁切：' + entry.file + '（' + entry.width + '×' + entry.height + '）')
  }

  if (action === 'capture') {
    const file = sourceFile(flags, dir)
    const entry = await engine.captureAsset(dir, file, { name: flags.name, caption: flags.caption })
    if (flags.json) return emit('', { ok: true, asset: entry })
    return line('已引入：' + entry.file + '（' + entry.kind + ' · ' + mb(entry.bytes) + '）')
  }

  throw new Error('assets 没有这个动作：' + action + '（list / library / use / page / gather / collect / fetch / palette / crop / capture）')
}

// ── sfx ─────────────────────────────────────────────────────────────
export async function sfx(flags, positional) {
  const action = positional[0] || flags.action || 'search'
  if (action === 'get') requireFfmpeg('音效分析（时长 / 峰值）')
  const dir = requireProjectDir(flags, positional.slice(1))
  const engine = await import('../../engine/motion/sfx.js')

  if (action === 'search') {
    if (!flags.query) throw new Error('search 需要 --query，英文短词更好用（"paper whoosh"、"ui click"）')
    const result = await engine.searchSfx({
      query: String(flags.query), minDuration: num(flags.minDuration, 0),
      maxDuration: num(flags.maxDuration), limit: num(flags.limit, 8),
    })
    if (flags.json) return emit('', result)
    if (!result.results.length) return line(result.note || '没搜到。换个更短的英文词再试。')
    return line(table(['id', '秒', '标题', '作者'], result.results.map((item) => [item.id, item.seconds, String(item.title || item.name || '').slice(0, 40), item.author || ''])))
      + '\n用 `wb sfx get fs:12345` 下载（会量峰值并建议增益）。'
  }

  if (action === 'get') {
    const ids = [...positional.slice(1), ...asArray(flags.id)].filter(Boolean)
    if (!ids.length) throw new Error('get 需要 id：`wb sfx get fs:12345`（可多个）')
    const result = await engine.getSfx(dir, ids)
    const ok = result.results.filter((item) => item.ok)
    if (flags.json) return emit('', { ok: ok.length > 0, ...result })
    for (const row of result.results) {
      if (!row.ok) { line('✗ ' + row.id + '：' + row.error); continue }
      const asset = row.asset
      line('✓ ' + asset.file + ' · ' + asset.title + ' · ' + asset.analysis.seconds + 's · 峰值 ' + asset.analysis.peakDb + 'dB · 建议增益 ' + asset.analysis.suggestedGainDb + 'dB')
      line('  wb audio add --file "' + asset.file + '" --role sfx --at <秒>')
    }
    return
  }

  if (action === 'list') {
    const items = engine.listSfx(dir)
    if (flags.json) return emit('', { assets: items })
    if (!items.length) return line('还没下载过音效。`wb sfx search --query "paper whoosh"` 开始。')
    return line(table(['文件', '秒', '增益', '标题'], items.map((item) => [item.file, item.seconds, (item.suggestedGainDb > 0 ? '+' : '') + item.suggestedGainDb + 'dB', String(item.title || '').slice(0, 40)])))
  }

  throw new Error('sfx 没有这个动作：' + action + '（search / get / list）')
}

// ── audio ───────────────────────────────────────────────────────────
export async function audio(flags, positional) {
  const action = positional[0] || flags.action || 'list'
  if (['add', 'analyze'].includes(action)) requireFfmpeg('音轨（量时长 / 拍点）')
  const dir = requireProjectDir(flags, positional.slice(1))
  const { readTimeline, writeTimeline } = await import('../../engine/motion/project.js')
  const { addCue, removeCue, readTrack, describeTrack } = await import('../../engine/motion/audio.js')
  const { resolveGainDb, suggestedGainOf } = await import('../../engine/motion/audiolevel.js')
  const { readManifest } = await import('../../engine/motion/sfx.js')
  const { probeAudio } = await import('../../engine/motion/assets.js')
  let timeline = readTimeline(dir)
  const fps = Number(timeline.fps) || 30

  if (action === 'list') {
    const cues = readTrack(timeline)
    if (flags.json) return emit('', { audio: cues })
    if (!cues.length) return line('还没有音轨。`wb audio add --file bgm.mp3 --role bgm`；或 `wb voice say` 让旁白进来。')
    return line(table(['id', '角色', '文件', '起点', '时长', '增益'], cues.map((cue) => [cue.id, cue.role, cue.file, (cue.from / fps).toFixed(2) + 's', (cue.durationInFrames / fps).toFixed(2) + 's', (cue.gainDb > 0 ? '+' : '') + cue.gainDb + 'dB'])))
      + '\n' + describeTrack(cues, fps)
  }

  if (action === 'add') {
    if (timeline.sync) throw new Error('这个工程已经统一绑过拍点（timeline.sync），加/改音轨请先 `wb sync clear`，再重新 bind。')
    const file = sourceFile(flags, dir)
    const role = String(flags.role || 'sfx')
    const captured = await (await import('../../engine/motion/assets.js')).captureAsset(dir, file, { name: flags.name })
    const assetPath = join(dir, 'assets', captured.file)
    const probe = await probeAudio(assetPath)
    const gain = resolveGainDb({
      explicitGain: num(flags.gain), manifestGain: suggestedGainOf(readManifest(dir), captured.file),
      role, peakDb: probe.samplePeakDb,
    })
    const at = num(flags.at, 0)
    const seconds = num(flags.duration, probe.seconds)
    const cue = {
      file: captured.file, role,
      from: Math.round(at * fps),
      durationInFrames: Math.max(1, Math.round(seconds * fps)),
      gainDb: gain.gainDb,
      fadeIn: num(flags.fadeIn, 0), fadeOut: num(flags.fadeOut, 0),
      loop: bool(flags.loop), duck: role === 'bgm' ? !bool(flags.noDuck) : false,
    }
    timeline = addCue(timeline, cue)
    writeTimeline(dir, timeline)
    if (flags.json) return emit('', { ok: true, cue, gain, seconds: probe.seconds, asset: captured.file })
    line('已加音轨 ' + role + '：' + captured.file + ' @' + at + 's · ' + seconds.toFixed(2) + 's · ' + (gain.gainDb > 0 ? '+' : '') + gain.gainDb + 'dB（' + gain.source + '）')
    if (role === 'bgm') line('  BGM 默认 -10dB 并对旁白自动让路；改音量用 --gain。')
  }

  if (action === 'remove') {
    if (!flags.id) throw new Error('remove 需要 --id（`wb audio list` 里有）')
    timeline = removeCue(timeline, String(flags.id))
    writeTimeline(dir, timeline)
    if (flags.json) return emit('', { ok: true, removed: String(flags.id) })
    line('已删除音轨：' + flags.id)
  }

  if (action === 'analyze') {
    const file = sourceFile(flags, dir)
    const { analyzeBeats } = await import('../../engine/motion/beats.js')
    const analysis = await analyzeBeats(resolve(file))
    const payload = { file: basename(file), fps, beatFrames: analysis.beats.map((beat) => Math.round(beat * fps)), peakLagFrames: Math.round((analysis.peakLag || 0) * fps), ...analysis }
    writeFileSync(join(dir, 'beats.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8')
    if (flags.json) return emit('', { ok: true, analysis: payload })
    line('拍点：' + (analysis.bpm ? analysis.bpm.toFixed(1) + ' BPM' : '量不出稳定网格') + ' · ' + analysis.beats.length + ' 拍 · 网格残差 ' + (analysis.grid?.residualMs ?? '?') + 'ms')
    if (analysis.note) line('  ' + analysis.note)
    line('  已写 beats.json（切点吸附用它）。')
  }

  if (action === 'apply') {
    const beatsFile = join(dir, 'beats.json')
    if (!existsSync(beatsFile)) throw new Error('没有 beats.json：先 `wb audio analyze --file 音乐.mp3`')
    const beats = JSON.parse(readFileSync(beatsFile, 'utf8'))
    const { snapFrame } = await import('../../engine/motion/beats.js')
    const tolerance = num(flags.tolerance, 4)
    const shots = timeline.shots
    const starts = shots.map((shot) => shot.startFrame)
    let moved = 0
    for (let index = 1; index < starts.length; index += 1) {
      const snapped = snapFrame(starts[index], beats.beats, fps, tolerance)
      const floorFrame = starts[index - 1] + 6
      const ceiling = (timeline.durationInFrames || starts[index]) - (starts.length - index)
      const next = Math.min(Math.max(snapped, floorFrame), Math.max(floorFrame, ceiling))
      if (next !== starts[index]) moved += 1
      starts[index] = next
    }
    for (let index = 0; index < shots.length; index += 1) {
      const end = index + 1 < shots.length ? starts[index + 1] : (timeline.durationInFrames || starts[index] + shots[index].durationFrames)
      shots[index] = { ...shots[index], startFrame: starts[index], durationFrames: Math.max(1, end - starts[index]) }
    }
    timeline = { ...timeline, shots, durationInFrames: Math.max(timeline.durationInFrames || 0, starts[starts.length - 1] + shots[shots.length - 1].durationFrames) }
    writeTimeline(dir, timeline)
    if (flags.json) return emit('', { ok: true, moved, bpm: beats.bpm, tolerance })
    line('切点已吸到拍子上：动了 ' + moved + ' 处（容差 ' + tolerance + ' 帧' + (beats.bpm ? ' · ' + beats.bpm.toFixed(1) + ' BPM' : '') + '）')
    line('  改完记得 `wb preview` 看一遍切点落在哪。')
  }

  if (!['list', 'add', 'remove', 'analyze', 'apply'].includes(action)) throw new Error('audio 没有这个动作：' + action + '（add / list / remove / analyze / apply）')
}

// ── sync ────────────────────────────────────────────────────────────
export async function sync(flags, positional) {
  const action = positional[0] || flags.action || 'list'
  if (action === 'bind') requireFfmpeg('拍点分析')
  const dir = requireProjectDir(flags, positional.slice(1))
  const { readTimeline, writeTimeline } = await import('../../engine/motion/project.js')
  let timeline = readTimeline(dir)

  if (action === 'list') {
    if (flags.json) return emit('', { sync: timeline.sync || null })
    if (!timeline.sync) return line('还没绑拍点。`wb sync bind --music <cueId>`（cueId 从 `wb audio list` 拿）。')
    const sync = timeline.sync
    line('绑的是 ' + sync.musicCueId + ' · ' + (sync.analysis?.bpm ? sync.analysis.bpm.toFixed(1) + ' BPM' : '无稳定网格') + ' · 容差 ' + sync.toleranceFrames + ' 帧')
    return line('锚点 ' + (sync.anchors || []).length + ' 个：' + (sync.anchors || []).map((anchor) => anchor.type + '/' + (anchor.shotId || '')).join('  '))
  }

  if (action === 'clear') {
    delete timeline.sync
    for (const shot of timeline.shots) delete shot.anchors
    writeTimeline(dir, timeline)
    if (flags.json) return emit('', { ok: true })
    return line('已解除绑定（时间轴排期没动）。')
  }

  if (action === 'bind') {
    const cueId = flags.music || flags.cue
    if (!cueId) throw new Error('bind 需要 --music <cueId>（要绑的那条音乐，`wb audio list` 里有）')
    const cue = (readTimeline(dir).audio || []).find((item) => item.id === cueId)
    if (!cue) throw new Error('时间轴里没有这条音轨：' + cueId + '\n先 `wb audio add --file 音乐.mp3 --role bgm`。')
    const tolerance = num(flags.tolerance, 2)
    if (tolerance < 0 || tolerance > 3) throw new Error('容差只能是 0–3 帧')
    const rawAnchors = flags.anchors ? String(flags.anchors).trim() : ''
    if (!rawAnchors) throw new Error('bind 需要 --anchors（1–200 个锚点；给 JSON 文件，或直接给 JSON 文本）\n格式：`[{"id":"a1","type":"cut","shotId":"shot-1","at":0.5}]`；按拍号就写 "beat"，动作再写 "name" 与 "visual"')
    const text = rawAnchors.startsWith('[') || rawAnchors.startsWith('{')
      ? rawAnchors
      : readFileSync(resolve(String(flags.anchors)), 'utf8')
    // Windows 记事本 / PowerShell 5 写出的 JSON 带 BOM，直接 JSON.parse 会报 Unexpected token。
    const anchors = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!Array.isArray(anchors) || !anchors.length) throw new Error('anchors 必须是非空数组（1–200 个）')
    const { analyzeBeats } = await import('../../engine/motion/beats.js')
    const { assetPath, resolveSync, filmHash } = await import('../../engine/motion/sync.js')
    const file = assetPath(dir, cue.file)
    const analysis = await analyzeBeats(file)
    timeline.sync = {
      version: 1, musicCueId: cue.id, analysis, analysisSourceHash: filmHash(file),
      anchors, outputOffsetSeconds: num(flags.offset, 0), toleranceFrames: tolerance,
    }
    timeline = resolveSync(timeline)
    writeTimeline(dir, timeline)
    if (flags.json) return emit('', { ok: true, sync: timeline.sync })
    line('已绑定 ' + cue.file + '：' + (analysis.bpm ? analysis.bpm.toFixed(1) + ' BPM · ' : '') + analysis.beats.length + ' 拍 · 锚点 ' + anchors.length + ' 个 · 容差 ' + tolerance + ' 帧')
    line('  成片后用 `wb verify` 量实际偏差。')
    return
  }

  throw new Error('sync 没有这个动作：' + action + '（bind / list / clear）')
}

// ── verify ──────────────────────────────────────────────────────────
export async function verify(flags, positional) {
  const dir = requireProjectDir(flags, positional)
  requireFfmpeg('音画对照验收')
  const { readTimeline } = await import('../../engine/motion/project.js')
  const { verifySync } = await import('../../engine/motion/sync.js')
  const timeline = readTimeline(dir)
  if (!timeline.sync) throw new Error('还没绑拍点：先 `wb sync bind --music <cueId>`，再渲整片，再 `wb verify`。')
  // --file 也认工程内相对路径（.out/film.mp4），和别的命令保持一致。
  const rawFilm = flags.file ? String(flags.file) : ''
  let film = rawFilm
    ? (isAbsolute(rawFilm) ? [rawFilm] : [resolve(process.cwd(), rawFilm), resolve(dir, rawFilm)]).find((path) => existsSync(path)) || null
    : null
  if (!film) {
    const out = join(dir, '.out', 'film.mp4')
    if (existsSync(out)) film = out
  }
  if (!film || !existsSync(film)) throw new Error('没有整片可对照：先 `wb render`，或用 --file 指向成片。')
  const report = await verifySync(dir, film, timeline)
  if (flags.json) return emit('', { ok: report.status !== 'fail', ...report })
  line('音画对照：' + report.status)
  for (const row of report.rows) {
    const mark = row.status === 'pass' ? '✓' : row.status === 'fail' ? '✗' : '?'
    const error = row.audiovisualErrorFrames
    const measured = error === null || error === undefined ? '未测到' : '实测偏差 ' + Math.round(error) + ' 帧'
    const sfx = (row.sfx || []).map((item) => item.errorFrames === null || item.errorFrames === undefined
      ? '未测到'
      : '偏差 ' + Math.round(item.errorFrames) + ' 帧')
    line('  ' + mark + ' ' + row.type + '/' + row.id + ' · 计划 ' + row.plannedFrame + 'f · ' + measured
      + (row.quantizationMs !== undefined ? ' · 吸附 ' + Math.round(row.quantizationMs) + 'ms' : '')
      + (sfx.length ? ' · 音效 ' + sfx.join(' / ') : ''))
  }
  if (report.measuredOutputOffsetSeconds !== null && report.measuredOutputOffsetSeconds !== undefined) {
    line('  实测输出偏移 ' + (report.measuredOutputOffsetSeconds * 1000).toFixed(0) + 'ms（`--offset` 可补偿）')
  }
  if (report.status === 'unverified') line('  没测到波形：确认成片里有这条音乐/音效，或用整片（切片渲染的音轨对不上）。')
}

// ── voice ───────────────────────────────────────────────────────────
export async function voice(flags, positional) {
  const action = positional[0] || flags.action || 'list'
  if (['plan', 'say', 'align'].includes(action)) requireFfmpeg('旁白（量时长 / 重排）')
  const dir = requireProjectDir(flags, positional.slice(1))
  const engine = await import('../../engine/motion/voice.js')
  const { readTimeline, writeTimeline } = await import('../../engine/motion/project.js')
  let timeline = readTimeline(dir)
  const fps = Number(timeline.fps) || 30

  if (action === 'list') {
    const cues = (timeline.audio || []).filter((cue) => cue.role === 'voice')
    const available = await engine.edgeAvailable()
    if (flags.json) return emit('', { cues, subtitles: (timeline.subtitles || []).length, edgeAvailable: available, choices: engine.VOICE_CHOICES })
    line('音色：' + (timeline.narration?.voice || engine.VOICE_DEFAULTS.voice) + (available ? '（edge-tts 可用）' : '（edge-tts 不可用，只能退系统语音）'))
    line('旁白 ' + cues.length + ' 条 · 字幕 ' + (timeline.subtitles || []).length + ' 条')
    return line('可选音色：' + engine.VOICE_CHOICES.slice(0, 12).map((item) => item.name + '（' + item.gender + '，' + item.note + '）').join('、'))
  }

  const script = engine.readScript(dir, flags.script)
  const scriptShots = engine.parseScript(script.markdown)
  if (!scriptShots.length) throw new Error('旁白脚本里没有有效台词：每个 `## shot-N` 下面一句一行（`>` 开头的当备注丢掉）')
  const options = {
    voice: flags.voice ? String(flags.voice) : undefined,
    rate: flags.rate ? String(flags.rate) : undefined,
    pitch: flags.pitch ? String(flags.pitch) : undefined,
    cps: num(flags.cps), fit: flags.fit ? String(flags.fit) : undefined,
    gainDb: num(flags.gain), force: bool(flags.force), fps,
  }
  for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key]

  let planned
  if (action === 'plan') {
    planned = engine.planNarration(timeline, scriptShots, options)
  } else if (action === 'say') {
    const available = await engine.edgeAvailable()
    if (!available) line('注意：edge-tts 不可用，会退到系统语音（音色与停顿不如在线版）。')
    planned = await engine.sayNarration(dir, timeline, scriptShots, options, (done, total, text) => {
      if (process.stderr.isTTY) process.stderr.write('\r  合成 ' + done + '/' + total + '  ' + String(text).slice(0, 18) + '          ')
    })
    if (process.stderr.isTTY) process.stderr.write('\n')
  } else if (action === 'align') {
    planned = await engine.alignNarration(dir, timeline, scriptShots, options)
  } else {
    throw new Error('voice 没有这个动作：' + action + '（list / plan / say / align）')
  }

  const checks = engine.checkNarration(planned.timeline, planned.lines, options)
  const seconds = engine.totalSpeechSeconds(planned.lines, fps)
  // plan 只给排期预览，不落盘：这时候 voice/*.mp3 还没合成，写进 timeline 的话
  // 下一次 render 会在打包阶段去取一个不存在的文件（实测 404，渲到一半才崩）。
  const persisted = action !== 'plan'
  if (persisted) {
    writeTimeline(dir, planned.timeline)
    timeline = planned.timeline
  }
  const summary = engine.describeNarration(planned.lines, planned.timeline.shots, fps)
  if (flags.json) return emit('', { ok: true, action, persisted, lines: planned.lines, checks, seconds, summary })
  line('旁白 ' + planned.lines.length + ' 句 · ' + seconds + 's · ' + checks.verdict)
  for (const check of checks.checks) if (check.level !== 'pass') line('  [' + check.level + '] ' + check.message)
  line('')
  line(summary)
  if (!persisted) line('\n（预览：没写进时间轴。排期认可后再跑 `wb voice say`，它才会合成音频并写盘。）')
  if (persisted && timeline.subtitles?.length) line('\n字幕 ' + timeline.subtitles.length + ' 条已写进时间轴（`wb export` 会出 subtitles.srt）。')
}
