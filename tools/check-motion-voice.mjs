// 旁白自检：脚本解析 / 估时长 / 重排数学 / 字幕与音轨对齐 / 真合成一句。
//
//   node tools/check-motion-voice.mjs            纯函数部分
//   node tools/check-motion-voice.mjs --say      额外真合成一句（要 edge-tts + 网）

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  VOICE_DEFAULTS,
  cacheKeyOf,
  checkNarration,
  edgeAvailable,
  estimateFrames,
  parseScript,
  planNarration,
  sayNarration,
  synthesizeLine,
  totalSpeechSeconds,
} from '../src/motion/voice.js'

const root = process.cwd()
const scratch = join(root, '.voice-check')
let passed = 0

function ok(name, condition) {
  assert.ok(condition, name)
  passed += 1
  console.log('  ✓ ' + name)
}

// ---- 脚本解析 ----
const script = parseScript([
  '# 你的一年，被切成多少块',
  '',
  '## shot-1',
  '> 这里写备注，不念。',
  '一年有八千七百六十个小时。',
  '这是账本的第一行。',
  '',
  '## shot-2',
  '先扣掉睡觉的两千九百二十小时。',
  '',
  '## shot-3',
  '时间不会变多。',
].join('\n'))
ok('解析出 3 个有台词的镜', script.length === 3)
ok('shot-1 两句', script[0].shotId === 'shot-1' && script[0].lines.length === 2)
ok('备注行被丢掉', script[0].lines.every((line) => !line.text.startsWith('>')))
ok('顺序按脚本走', script.map((shot) => shot.shotId).join(',') === 'shot-1,shot-2,shot-3')

// ---- 估时长 ----
const short = estimateFrames('时间不会变多。', { fps: 30 })
ok('6 字 + 一个句号 ≈ 1.5s', short.seconds > 1.2 && short.seconds < 1.9)
const long = estimateFrames('一年有八千七百六十个小时。', { fps: 30 })
ok('长句比短句长', long.seconds > short.seconds)
const tiny = estimateFrames('好。', { fps: 30 })
ok('极短句被抬到下限', tiny.seconds >= VOICE_DEFAULTS.minSeconds)

// ---- 重排数学 ----
const timeline = {
  fps: 30,
  durationInFrames: 360,
  shots: [
    { id: 'shot-1', index: 0, startFrame: 0, durationFrames: 120 },
    { id: 'shot-2', index: 1, startFrame: 120, durationFrames: 90 },
    { id: 'shot-3', index: 2, startFrame: 210, durationFrames: 90 },
    { id: 'shot-4', index: 3, startFrame: 300, durationFrames: 60 },
  ],
  audio: [{ id: 'bgm-1', file: 'sfx/bgm.mp3', role: 'bgm', from: 0, durationInFrames: 360, gainDb: -8 }],
}
const plan = planNarration(timeline, script, { fit: 'grow' })
const next = plan.timeline
ok('不改原对象', timeline.shots[0].durationFrames === 120 && next.shots[0].durationFrames >= 120)
ok('镜头首尾相接', next.shots.every((shot, index) => shot.startFrame === (index ? next.shots[index - 1].startFrame + next.shots[index - 1].durationFrames : 0)))
ok('片长 = 各镜之和', next.durationInFrames === next.shots.reduce((sum, shot) => sum + shot.durationFrames, 0))
ok('有台词的镜被撑长', next.shots[0].durationFrames > 120)
ok('没台词的镜不动', next.shots[3].durationFrames === 60)
const voiceCues = next.audio.filter((cue) => cue.role === 'voice')
ok('每句一条 voice 音轨', voiceCues.length === plan.lines.length && voiceCues.length === 4)
ok('音轨 id 唯一', new Set(voiceCues.map((cue) => cue.id)).size === voiceCues.length)
ok('BGM 还在', next.audio.some((cue) => cue.role === 'bgm'))
ok('字幕条数 = 台词数', next.subtitles.length === plan.lines.length)
ok('字幕时间码与音轨一致', next.subtitles.every((row, index) => row.startFrame === voiceCues[index].from && row.endFrame === voiceCues[index].from + voiceCues[index].durationInFrames))
ok('字幕按时间排好', next.subtitles.every((row, index) => !index || row.startFrame >= next.subtitles[index - 1].startFrame))
ok('每句都落在自己的镜头里', plan.lines.every((line) => {
  const shot = next.shots.find((item) => item.id === line.shotId)
  return line.from >= shot.startFrame && line.from + line.frames <= shot.startFrame + shot.durationFrames
}))
ok('台词里带得回原始文本', plan.lines[0].text === '一年有八千七百六十个小时。')

const brief = parseScript('## shot-1\n时间不会变多。')
const exact = planNarration(timeline, brief, { fit: 'exact' }).timeline
const grow = planNarration(timeline, brief, { fit: 'grow' }).timeline
ok('fit=exact 会把镜头收紧到刚够', exact.shots[0].durationFrames < 120 && grow.shots[0].durationFrames === 120)
ok('exact 不碰没台词的镜', exact.shots[3].durationFrames === 60)
const frozen = planNarration(timeline, script, { fit: 'none' }).timeline
ok('fit=none 完全不动时长', frozen.durationInFrames === 360)

const orphan = parseScript('## shot-9\n这句话没有对应的镜头。')
let threw = false
try { planNarration(timeline, orphan, { fit: 'grow' }) } catch { threw = true }
ok('脚本写了不存在的镜头会直接报错（不静默丢句）', threw)

// ---- 检查项 ----
const good = checkNarration(next, plan.lines)
ok('正常排期检查通过', good.verdict === 'pass' && good.checks.every((check) => check.level !== 'fail'))
const broken = checkNarration({ ...next, subtitles: [] }, plan.lines)
ok('字幕丢了会被判 fail', broken.verdict === 'fail' && broken.checks.some((check) => check.id === 'voice-subtitle' && check.level === 'fail'))
const overflowed = checkNarration(next, plan.lines.map((line, index) => (index === 0 ? { ...line, from: 10, frames: 4000 } : line)))
ok('句子超出镜头会被判 fail', overflowed.checks.some((check) => check.id === 'voice-overflow' && check.level === 'fail'))

ok('总时长按 fps 折算', Math.abs(totalSpeechSeconds(plan.lines, 30) - plan.lines.reduce((sum, line) => sum + line.frames, 0) / 30) < 0.06)
ok('缓存 key 对文本敏感', cacheKeyOf({ voice: 'a', rate: '+0%', pitch: '+0Hz', text: 'x' }) !== cacheKeyOf({ voice: 'a', rate: '+0%', pitch: '+0Hz', text: 'y' }))

// ---- 真合成（可选）----
if (process.argv.includes('--say')) {
  if (!(await edgeAvailable())) {
    console.log('  · 跳过真合成：本机拿不到 edge-tts')
  } else {
    mkdirSync(join(scratch, 'assets'), { recursive: true })
    rmSync(join(scratch, 'assets', 'voice'), { recursive: true, force: true }) // 上次中断留下的缓存会让"没词边界"这个 bug 藏起来
    const line = '咖啡因的半衰期大约是五小时。'
    const first = await synthesizeLine(line, { dir: scratch })
    const file = join(scratch, 'assets', first.file)
    ok('合成出 mp3', existsSync(file) && statSync(file).size > 4000)
    ok('时长在合理区间', first.seconds > 1 && first.seconds < 8)
    ok('拿到词级时间戳', Array.isArray(first.words) && first.words.length > 3 && first.words[0].offsetMs >= 0)
    const stamp = statSync(file).mtimeMs
    const second = await synthesizeLine(line, { dir: scratch })
    ok('第二次走缓存（不重调网）', second.key === first.key && statSync(file).mtimeMs === stamp)
    await synthesizeLine(line, { dir: scratch, force: true })
    ok('force 会重合成', statSync(file).mtimeMs >= stamp)
    console.log('  · 样音：' + file + '（' + first.seconds.toFixed(2) + 's，' + first.words.length + ' 个词边界）')

    // 整条链路：sayNarration 会不会把真实时长写回音轨与字幕
    const smallTimeline = {
      fps: 30,
      durationInFrames: 90,
      shots: [{ id: 'shot-1', index: 0, startFrame: 0, durationFrames: 90 }],
      audio: [],
    }
    const smallScript = parseScript('## shot-1\n这一句用来验证重排。\n第二句也得有自己的位置。')
    const said = await sayNarration(scratch, smallTimeline, smallScript, {})
    const produced = said.timeline
    ok('sayNarration 产出两条音轨', produced.audio.filter((cue) => cue.role === 'voice').length === 2)
    ok('音轨文件真的存在', produced.audio.filter((cue) => cue.role === 'voice').every((cue) => existsSync(join(scratch, 'assets', cue.file))))
    ok('字幕跟着台词走', produced.subtitles.length === 2 && produced.subtitles.every((row) => row.text.length > 0))
    ok('镜头被真实时长撑开', produced.durationInFrames > 90)
    ok('台词标记为实测', said.lines.every((line) => line.measured === true))
    const check = checkNarration(produced, said.lines)
    ok('整条链路检查通过', check.verdict !== 'fail')

    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n旁白自检通过（' + passed + ' 项）')
