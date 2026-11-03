// 混音后级 + 音轨电平的自检。
//
//   node tools/check-motion-mix.mjs [工程目录]
//
// 工程目录默认 .drawai-motion/n8（那条片的响度是 -24.6 LUFS，正好当靶子）。
// 会把成片复制到临时目录再归一化，不动工程里的 film.mp4。

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { measureLoudness, normalizeMix, parseLoudnormJson, describeMix } from '../src/motion/audiomix.js'
import { cueLevel, mixPeakDb, resolveGainDb, suggestedGainOf } from '../src/motion/audiolevel.js'
import { runFfmpeg } from '../src/motion/ffmpeg.js'

const project = resolve(process.argv[2] || '.drawai-motion/n8')
const film = join(project, '.out', 'film.mp4')
if (!existsSync(film)) {
  console.error('没有成片可测：' + film)
  process.exit(2)
}

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (error) {
    failures += 1
    console.log('  FAIL ' + name + ' —— ' + error.message)
  }
}

console.log('纯函数校验')
check('显式增益优先于清单建议', () => {
  const result = resolveGainDb({ explicitGain: -3, manifestGain: -7, role: 'sfx' })
  assert.equal(result.gainDb, -3)
  assert.equal(result.source, 'explicit')
})
check('没给增益时吃清单建议', () => {
  const result = resolveGainDb({ manifestGain: -7, role: 'sfx' })
  assert.equal(result.gainDb, -7)
  assert.equal(result.source, 'manifest')
})
check('都没有时按角色默认（bgm -10）', () => {
  assert.deepEqual(resolveGainDb({ role: 'bgm' }), { gainDb: -10, source: 'role' })
  assert.deepEqual(resolveGainDb({ role: 'sfx' }), { gainDb: 0, source: 'role' })
})
check('清单建议把峰值推过天花板时会被夹住', () => {
  // 实测：fs:615308 的清单建议是 +8dB，但它自己的峰值是 -2.7，加完是 +5.3 dBFS。
  const capped = resolveGainDb({ manifestGain: 8, role: 'sfx', peakDb: -2.7 })
  assert.equal(capped.gainDb, 1.7)
  assert.equal(capped.capped, 8)
  assert.equal(capped.source, 'manifest')
})
check('BGM 的 -10dB 不会被夹（离天花板还远）', () => {
  assert.deepEqual(resolveGainDb({ role: 'bgm', peakDb: -5.2 }), { gainDb: -10, source: 'role' })
})
check('显式增益不被夹（人说了算）', () => {
  assert.deepEqual(resolveGainDb({ explicitGain: 9, manifestGain: 2, role: 'sfx', peakDb: -3 }), { gainDb: 9, source: 'explicit' })
})
check('峰值 + 增益算出来会顶天花板时要报', () => {
  const level = cueLevel({ peakDb: -6, gainDb: 6 })
  assert.equal(level.peakDb, 0)
  assert.equal(level.clips, true)
  const safe = cueLevel({ peakDb: -12, gainDb: 0 })
  assert.equal(safe.clips, false)
  assert.equal(safe.headroomDb, 11)
})
check('量不出峰值就不假装知道', () => {
  assert.deepEqual(cueLevel({ peakDb: null, gainDb: 4 }), { peakDb: null, headroomDb: null, clips: false })
})
check('两条 -6dB 叠起来约 0dB', () => {
  assert.equal(mixPeakDb([-6, -6]), 0)
  assert.equal(mixPeakDb([]), null)
})
check('从音频清单里取 suggestedGainDb', () => {
  const manifest = { assets: [{ file: 'sfx/a.mp3', analysis: { suggestedGainDb: 4 } }] }
  assert.equal(suggestedGainOf(manifest, 'sfx/a.mp3'), 4)
  assert.equal(suggestedGainOf(manifest, 'sfx/b.mp3'), null)
})
check('loudnorm 的 JSON 能从日志里挑出来', () => {
  const parsed = parseLoudnormJson('noise\n{ "input_i" : "-24.60", "input_tp" : "-1.90" }\nnoise')
  assert.equal(parsed.input_i, '-24.60')
  assert.equal(parseLoudnormJson('nothing here'), null)
})

// 临时文件放在工程 .out 里：ffmpeg 在系统临时目录写过一次 I/O error，工程目录里一直正常。
const work = join(project, '.out', 'mix-check')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const copy = join(work, 'film.mp4')
copyFileSync(film, copy)

async function frameHash(file, at) {
  const png = join(work, 'frame-' + at + '.png')
  await runFfmpeg(['-ss', String(at), '-i', file, '-frames:v', '1', '-update', '1', '-y', png], { cwd: work, log: join(work, 'frame.log') })
  return createHash('sha256').update(readFileSync(png)).digest('hex')
}

console.log('\n真跑一遍（复制件，不动工程）')
const beforeHash = await frameHash(copy, 5)
const beforeBytes = statSync(copy).size
const before = await measureLoudness(copy, { cwd: work, log: join(work, 'ebur.log') })
console.log('  归一化前：' + before.integratedLufs + ' LUFS / 真峰值 ' + before.truePeakDb + ' dBFS')
const mix = await normalizeMix(copy, { cwd: work, log: join(work, 'mix.log') })
console.log('  ' + describeMix(mix))

check('确实做了归一化', () => assert.equal(mix.applied, true, mix.reason || '没标记为已处理'))
check('响度落到 -16 LUFS 附近（±1）', () => {
  assert.ok(mix.after.integratedLufs !== null, '没量到响度')
  assert.ok(Math.abs(mix.after.integratedLufs - (-16)) <= 1, '归一化后是 ' + mix.after.integratedLufs + ' LUFS')
})
check('真峰值压到 -1.0 dBFS 以下', () => {
  assert.ok(mix.after.truePeakDb !== null, '没量到真峰值')
  assert.ok(mix.after.truePeakDb <= -1.0, '真峰值 ' + mix.after.truePeakDb + ' dBFS')
})
const afterHash = await frameHash(copy, 5)
console.log((afterHash === beforeHash ? '  ok   ' : '  FAIL ') + '第 5 秒那一帧逐字节一致')
if (afterHash !== beforeHash) failures += 1

check('文件还在、大小没有离谱变化', () => {
  const afterBytes = statSync(copy).size
  assert.ok(afterBytes > beforeBytes * 0.5 && afterBytes < beforeBytes * 1.6, beforeBytes + ' → ' + afterBytes)
})

const again = await normalizeMix(copy, { cwd: work, log: join(work, 'mix2.log') })
check('再跑一遍会跳过（已经在目标附近）', () => assert.equal(again.applied, false))

rmSync(work, { recursive: true, force: true })
console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'))
process.exit(failures ? 1 : 0)
