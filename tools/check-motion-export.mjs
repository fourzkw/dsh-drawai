// 导出自检：切镜头 → 音轨 → 字幕 → 草稿，逐个文件校验。
//   node tools/check-motion-export.mjs [工程目录] [--draft]

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { exportPackage, listExports } from '../src/motion/export.js'
import { runFfmpeg } from '../src/motion/ffmpeg.js'

const projectDir = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.drawai-motion/n1')
const withDraft = process.argv.includes('--draft')
const assert = (condition, message) => { if (!condition) { console.error('FAIL: ' + message); process.exitCode = 1 } }

if (!existsSync(join(projectDir, 'timeline.json'))) { console.log('skip: 没有工程 ' + projectDir); process.exit(0) }
if (!existsSync(join(projectDir, '.out', 'film.mp4'))) { console.log('skip: 还没有成片'); process.exit(0) }

const timeline = JSON.parse(readFileSync(join(projectDir, 'timeline.json'), 'utf8'))
const started = Date.now()
// 顺带验一条字幕轨：SRT 的时间码、序号、换行都得对。
const subtitles = [{ startFrame: 0, endFrame: 75, text: '晚上十点' }, { startFrame: 80, endFrame: 150, text: '今天最后一杯' }]
const result = await exportPackage({ dir: projectDir, timeline, name: 'selftest', draft: withDraft, subtitles })
const cost = ((Date.now() - started) / 1000).toFixed(1)

assert(result.shots.length === timeline.shots.length, '镜头数应等于时间轴')
assert(existsSync(join(result.folder, 'README.md')), '应写 README')
assert(existsSync(join(result.folder, 'shots.json')), '应写 shots.json')
assert(existsSync(join(result.folder, 'audio.json')), '应写 audio.json')
assert(existsSync(join(result.folder, 'film.mp4')), '应带完整成片')

const shots = JSON.parse(readFileSync(join(result.folder, 'shots.json'), 'utf8'))
assert(Math.abs(shots.seconds - timeline.durationInFrames / timeline.fps) < 0.05, '总时长应与时间轴一致')
const sum = shots.shots.reduce((total, shot) => total + shot.seconds, 0)
assert(Math.abs(sum - shots.seconds) < 0.05, '逐镜时长之和应等于总时长，实际 ' + sum.toFixed(2))

// 每个 clip 都要存在、非空、且时长真的对得上（用 ffmpeg 量，不信文件名）。
for (const shot of shots.shots) {
  const file = join(result.folder, shot.clip)
  assert(existsSync(file) && statSync(file).size > 1000, shot.id + ' 的 clip 应存在且非空')
  const log = await runFfmpeg(['-i', file, '-f', 'null', '-'], { cwd: result.folder, allowFail: true, log: join(tmpdir(), 'drawai-clip-probe.log') })
  const found = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(log)
  assert(found, shot.id + ' 的 clip 应能被 ffmpeg 读出时长')
  if (found) {
    const measured = Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])
    assert(Math.abs(measured - shot.seconds) < 0.12, shot.id + ' 实测 ' + measured.toFixed(2) + 's 与时间轴 ' + shot.seconds + 's 不符')
  }
  assert(!/Stream #\S+.*: Audio:/.test(log), shot.id + ' 的 clip 应该无声（音轨在 audio/ 里）')
}

assert(result.stems.filter((stem) => stem.role === 'bgm').length === 1, '应该有且只有一条 BGM')
assert(result.stems.length >= 5, '音效应该都导出，实际 ' + result.stems.length)
assert(result.missing.length === 0, '不该有找不到的音轨文件：' + result.missing.join('、'))
for (const stem of result.stems) assert(existsSync(join(result.folder, stem.source)), stem.source + ' 应复制到包内')

assert(listExports(projectDir).some((item) => item.name === 'selftest'), 'listExports 应能看到这次导出')

const srt = readFileSync(join(result.folder, 'subtitles.srt'), 'utf8')
assert(srt.startsWith('1\n00:00:00,000 --> 00:00:02,500\n晚上十点'), 'SRT 第一条应带序号与时间码，实际：' + JSON.stringify(srt.slice(0, 60)))
assert(srt.includes('00:00:02,667 --> 00:00:05,000'), 'SRT 第二条应落在 80–150 帧（2.667–5.000s）')
assert(srt.trimEnd().split('\n').length === 7, '两条字幕应有 7 行，实际 ' + srt.trimEnd().split('\n').length)
assert(!existsSync(join(result.folder, 'ff.log')), '包里不应留下 ff.log')

if (withDraft) {
  const draft = JSON.parse(readFileSync(join(result.folder, 'draft_content.json'), 'utf8'))
  assert(draft.version === 360000, '草稿版本号')
  assert(draft.tracks.length === 3, '应有视频/音频/文本三条轨')
  const ids = new Set([...draft.materials.videos, ...draft.materials.audios, ...draft.materials.texts].map((material) => material.id))
  for (const track of draft.tracks) for (const segment of track.segments) assert(ids.has(segment.material_id), '段引用的材料必须存在：' + segment.material_id)
  const videoTotal = draft.tracks[0].segments.reduce((total, segment) => total + segment.target_timerange.duration, 0)
  assert(Math.abs(videoTotal - draft.duration) < 20000, '视频轨总长应接近成片时长（us）')
}

console.log('导出到 ' + result.folder + '（' + result.shots.length + ' 镜 / ' + result.stems.length + ' 音轨 / ' + result.seconds + 's，' + cost + 's）')
if (process.exitCode) process.exit(process.exitCode)
console.log('导出自检通过')
