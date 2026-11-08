// 导出：把一条成片拆成"能在剪映里继续剪"的素材包。
//
// 上游 references/jianying-export.md 讲的就是这件事（逐镜头 clip + 独立
// 字幕轨 + 独立的 SFX/BGM 轨），但仓库里没有实现。这里按文件落地的版本：
//
//   clips/shot-N.mp4      逐镜头、无声、按时间轴精确切
//   audio/bgm-1.mp3       原音轨原文件（带 cue 时间点与增益记录）
//   subtitles.srt         有字幕数据时写出，剪映可直接导入
//   shots.json            顺序、进出点、帧号 —— 重建时间轴靠它
//   README.md             怎么在剪映里拼回去
//   draft_content.json    draft:true 时的剪映草稿（结构草案，未在剪映里验证）
//
// 切镜头用"输入侧 -ss + 重编码"，不是 -c copy：copy 只能从关键帧切，
// 边界会偏 1–2 秒，而这里必须帧对帧。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runFfmpeg } from './ffmpeg.js'

export function exportRoot(dir) {
  return join(dir, '.out', 'export')
}

export function exportFolder(dir, name = 'jianying') {
  return join(exportRoot(dir), name)
}

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits

function srtTime(seconds) {
  const total = Math.max(0, seconds)
  const pad = (value, size = 2) => String(Math.floor(value)).padStart(size, '0')
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), secs = Math.floor(total % 60)
  const ms = Math.round((total - Math.floor(total)) * 1000)
  return pad(hours) + ':' + pad(minutes) + ':' + pad(secs) + ',' + pad(ms, 3)
}

function subtitleRows(timeline, extra) {
  const list = Array.isArray(extra) ? extra : Array.isArray(timeline.subtitles) ? timeline.subtitles : []
  const fps = Number(timeline.fps) || 30
  return list.map((row, index) => {
    const fromFrame = Number(row.startFrame ?? row.from ?? 0)
    const toFrame = Number(row.endFrame ?? row.to ?? fromFrame + Math.round(fps * 2.5))
    return { index: index + 1, from: fromFrame / fps, to: toFrame / fps, text: String(row.text ?? row.copy ?? '').trim() }
  }).filter((row) => row.text && row.to > row.from)
}

function srtSource(rows) {
  return rows.map((row) => row.index + '\n' + srtTime(row.from) + ' --> ' + srtTime(row.to) + '\n' + row.text + '\n').join('\n')
}

// 剪映草稿：按 360000 这一版的结构摆出视频/音频/文本三条轨。
// 只保证结构自洽（材料 id 对得上、时长对得上），不保证剪映各版本都认。
function jianyingDraft({ timeline, shots, stems, subtitles, folder }) {
  const fps = Number(timeline.fps) || 30
  const us = (seconds) => Math.round(seconds * 1e6)
  const videoMaterials = shots.map((shot) => ({
    id: randomUUID().toUpperCase(), type: 'video', path: join(folder, 'clips', shot.id + '.mp4'),
    width: timeline.width, height: timeline.height, duration: us(shot.seconds), has_audio: false, reverse: false,
  }))
  const audioMaterials = stems.map((stem) => ({
    id: randomUUID().toUpperCase(), type: 'extract_music', path: join(folder, stem.source),
    duration: us(stem.seconds), name: basename(stem.source),
  }))
  const textMaterials = subtitles.map((row) => ({
    id: randomUUID().toUpperCase(), type: 'subtitle', content: row.text, alignment: 1,
    font_size: 6, text_color: '#2A2724',
  }))
  const videoSegments = shots.map((shot, index) => ({
    id: randomUUID().toUpperCase(), material_id: videoMaterials[index].id, volume: 1, speed: 1,
    source_timerange: { start: 0, duration: us(shot.seconds) },
    target_timerange: { start: us(shot.from), duration: us(shot.seconds) },
  }))
  const audioSegments = stems.map((stem, index) => ({
    id: randomUUID().toUpperCase(), material_id: audioMaterials[index].id,
    volume: round(10 ** (Number(stem.gainDb || 0) / 20), 3), speed: 1,
    source_timerange: { start: 0, duration: us(stem.seconds) },
    target_timerange: { start: us(stem.at), duration: us(stem.seconds) },
  }))
  const textSegments = subtitles.map((row, index) => ({
    id: randomUUID().toUpperCase(), material_id: textMaterials[index].id,
    target_timerange: { start: us(row.from), duration: us(row.to - row.from) },
  }))
  return {
    id: randomUUID().toUpperCase(),
    version: 360000,
    fps,
    duration: us(Number(timeline.durationInFrames) / fps),
    canvas_config: { width: timeline.width, height: timeline.height, ratio: 'original' },
    materials: { videos: videoMaterials, audios: audioMaterials, texts: textMaterials },
    tracks: [
      { id: randomUUID().toUpperCase(), type: 'video', attribute: 0, segments: videoSegments },
      { id: randomUUID().toUpperCase(), type: 'audio', attribute: 0, segments: audioSegments },
      { id: randomUUID().toUpperCase(), type: 'text', attribute: 0, segments: textSegments },
    ],
  }
}

function readmeOf({ timeline, shots, stems, subtitles, missing }) {
  const fps = Number(timeline.fps) || 30
  const total = Number(timeline.durationInFrames) / fps
  const lines = [
    '# 剪映素材包',
    '',
    '这条片子是 ' + timeline.width + '×' + timeline.height + ' / ' + fps + 'fps / ' + total.toFixed(2) + ' 秒，拆成了 '
      + shots.length + ' 个镜头 + ' + stems.length + ' 条音轨。',
    '',
    '## 里面有什么',
    '',
    '- `clips/` 逐镜头画面，无声，按时间轴精确切（首尾帧与时间轴一致）。',
    '- `audio/` 原音轨文件（BGM 与音效分开），时间点与增益见 `audio.json`。',
    '- `shots.json` 镜头顺序、进出点、帧号。',
    '- `film.mp4` 完整成片，用来对照。',
    subtitles ? '- `subtitles.srt` 字幕，剪映里可直接导入为字幕轨。' : '- 没有字幕数据（时间轴里没有 subtitles）。',
    '',
    '## 在剪映里拼回去',
    '',
    '1. 新建项目，画布设为 ' + timeline.width + '×' + timeline.height + '、' + fps + 'fps。',
    '2. 按 `shots.json` 的顺序把 `clips/` 拖上主轨，首尾相接——它们是按顺序切好的，中间不要留空。',
    '3. 按 `audio.json` 的 `at` 秒把 `audio/` 里的文件放到对应位置；BGM 那条是整条铺满的，音效是点。',
    subtitles
      ? '4. 字幕：拖入 `subtitles.srt`，剪映会按时间码落到字幕轨。'
      : '4. 这条片子没有字幕数据；要字幕就回工程里补 subtitles 再导出一次。',
    '5. 需要改节奏就拖 clip 边界；画面内容要改，回工程里改场景代码重新导出，不要在这边抠图。',
    '',
    '## 来源',
    '',
    '',
  ]
  if (missing.length) lines.splice(lines.indexOf('## 来源'), 0, '## 缺失', '', '这些音轨文件在工程里找不到：' + missing.join('、'), '')
  return lines.join('\n')
}

export async function exportPackage({ dir, timeline, name, draft = false, subtitles, film, onProgress }) {
  if (!timeline || !Array.isArray(timeline.shots) || !timeline.shots.length) throw new Error('时间轴里没有镜头')
  const source = film || join(dir, '.out', 'film.mp4')
  if (!existsSync(source)) throw new Error('没有成片可导出：先 wb render 出一版（' + source + '）')
  const fps = Number(timeline.fps) || 30
  const folder = exportFolder(dir, name)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(join(folder, 'clips'), { recursive: true })
  mkdirSync(join(folder, 'audio'), { recursive: true })

  const shots = []
  for (const [index, shot] of timeline.shots.entries()) {
    const from = shot.startFrame / fps, to = (shot.startFrame + shot.durationFrames) / fps
    const clip = join(folder, 'clips', shot.id + '.mp4')
    await runFfmpeg(['-ss', from.toFixed(3), '-to', to.toFixed(3), '-i', source, '-an',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip],
      { cwd: folder, timeoutMs: 300000, log: join(exportRoot(dir), 'ff.log') })
    if (!existsSync(clip)) throw new Error('第 ' + (index + 1) + ' 镜切失败：' + shot.id)
    shots.push({ id: shot.id, card: shot.card || null, from: round(from), to: round(to), seconds: round(to - from),
      startFrame: shot.startFrame, durationFrames: shot.durationFrames, clip: 'clips/' + shot.id + '.mp4' })
    onProgress?.({ stage: 'clips', index: index + 1, total: timeline.shots.length })
  }

  const stems = []
  const missing = []
  for (const cue of (Array.isArray(timeline.audio) ? timeline.audio : [])) {
    if (!cue.file) continue
    const from = join(dir, 'assets', cue.file)
    if (!existsSync(from)) { missing.push(cue.file); continue }
    const target = join(folder, 'audio', cue.role + '-' + (stems.length + 1) + (extname(cue.file) || '.mp3'))
    copyFileSync(from, target)
    stems.push({
      role: cue.role || 'sfx', source: 'audio/' + basename(target), at: round(Number(cue.from || 0) / fps),
      seconds: round(Number(cue.durationInFrames || 0) / fps), gainDb: Number(cue.gainDb || 0),
      fadeIn: round(Number(cue.fadeIn || 0) / fps), fadeOut: round(Number(cue.fadeOut || 0) / fps),
      loop: Boolean(cue.loop), duck: Boolean(cue.duck),
    })
  }

  const rows = subtitleRows(timeline, subtitles)
  if (rows.length) writeFileSync(join(folder, 'subtitles.srt'), srtSource(rows), 'utf8')
  copyFileSync(source, join(folder, 'film.mp4'))
  writeFileSync(join(folder, 'shots.json'), JSON.stringify({
    width: timeline.width, height: timeline.height, fps,
    durationInFrames: timeline.durationInFrames, seconds: round(Number(timeline.durationInFrames) / fps), shots,
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(folder, 'audio.json'), JSON.stringify({ fps, cues: stems, missing }, null, 2) + '\n', 'utf8')

  let draftFile = null
  if (draft) {
    const content = jianyingDraft({ timeline, shots, stems, subtitles: rows, folder })
    draftFile = join(folder, 'draft_content.json')
    writeFileSync(draftFile, JSON.stringify(content, null, 2) + '\n', 'utf8')
  }
  writeFileSync(join(folder, 'README.md'), readmeOf({ timeline, shots, stems, subtitles: rows.length, missing }), 'utf8')
  rmSync(join(folder, 'ff.log'), { force: true })
  return { folder, shots, stems, subtitles: rows.length, draft: draftFile, missing,
    seconds: round(Number(timeline.durationInFrames) / fps), files: 2 + shots.length + stems.length + (rows.length ? 1 : 0) + (draftFile ? 1 : 0) }
}

export function listExports(dir) {
  const root = exportRoot(dir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, folder: join(root, entry.name), at: statSync(join(root, entry.name)).mtime.toISOString() }))
}
