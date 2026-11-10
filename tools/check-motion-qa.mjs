// 帧检里"动能量"和"空画面"两条新检查的回归：判据能抓住幻灯片，又不误伤真运动。
//
// 这几条都是 freezedetect / 空白帧抓不到的：
//   缓慢推镜     每帧都在动，freeze 永远不触发，但整镜没有节奏
//   渐变空画面   亮度极差很大，blank 认为"有内容"，其实只有底色
// 所以这里的重点是两个方向都测：故意做的 PPT 片要被抓，真正在动的片子不许报。

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { runFfmpeg } from '../src/motion/ffmpeg.js'
import { runFrameQa } from '../src/motion/qa.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name) }
mkdirSync('.tmp', { recursive: true })
const root = mkdtempSync(join(process.cwd(), '.tmp', 'drawai-qa-'))
const ff = (dir, args) => runFfmpeg(args, { cwd: dir })
const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']

async function still(dir) {
  await ff(dir, ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-frames:v', '1', 'still.png'])
}
async function zoom(dir, step, seconds) {
  await ff(dir, ['-loop', '1', '-i', 'still.png', '-vf',
    "zoompan=z='1+" + step + "*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=640x360:fps=30",
    '-t', String(seconds), ...h264, 'film.mp4'])
}

async function make(name, build) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  await build(dir)
  return dir
}

// 90 帧 = 3 秒；整段一镜，够看出一镜有没有节奏。
const whole = (frames = 90, fps = 30) => ({ fps, durationInFrames: frames, shots: [{ id: 's1', startFrame: 0, durationFrames: frames }] })
const run = async (dir, timeline) => runFrameQa({ dir, file: join(dir, 'film.mp4'), timeline, options: { pixels: false } })
const findings = (report, id) => report.checks.filter((item) => item.id === id && item.level !== 'pass')

// 1. 整镜静止：必然命中，但只该是 warn，不该升级成 fail。
const staticDir = await make('static', async (dir) => {
  await still(dir)
  await ff(dir, ['-loop', '1', '-i', 'still.png', '-t', '3', '-r', '30', ...h264, 'film.mp4'])
})
const staticReport = await run(staticDir, whole())
check('静止片：报动能量偏低', () => assert.equal(findings(staticReport, 'energy').length, 1))
check('静止片：单镜不升级成 fail', () => assert.equal(staticReport.verdict, 'warn'))

// 2. 缓慢推镜：3 秒推 5%，每帧只差一点点——freezedetect 抓不到，动能量必须抓到。
const slowDir = await make('slow', async (dir) => { await still(dir); await zoom(dir, '0.0007', 3) })
const slowReport = await run(slowDir, whole())
check('缓慢推镜：报动能量偏低（freeze 抓不到的那一类）', () => assert.equal(findings(slowReport, 'energy').length, 1))
check('缓慢推镜：freeze 确实没报', () => assert.equal(findings(slowReport, 'freeze').length, 0))
check('缓慢推镜：中位低但确实每帧都在动', () => {
  const energy = slowReport.shots[0].energy
  assert.ok(energy.median < 1.2)
  assert.ok(energy.p90 > energy.median)
})

// 3. 快速推镜：同样的构图，每帧变化都过线——这是真运动，不许报。
const fastDir = await make('fast', async (dir) => { await still(dir); await zoom(dir, '0.0025', 3) })
const fastReport = await run(fastDir, whole())
check('快速推镜：不报动能量（阈值不误伤真运动）', () => assert.equal(findings(fastReport, 'energy').length, 0))

// 4. 满屏动画：更极端的对照，中位应该明显高于静止片。
const motionDir = await make('motion', async (dir) => {
  await ff(dir, ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', ...h264, 'film.mp4'])
})
const motionReport = await run(motionDir, whole())
check('满屏动画：不报动能量', () => assert.equal(findings(motionReport, 'energy').length, 0))
check('动能量能拉开静止与运动的量级', () => assert.ok(motionReport.shots[0].energy.median > Math.max(0.5, staticReport.shots[0].energy.median * 3)))

// 5. 渐变空画面：亮度极差很大（blank 不报），但没有任何结构（边密度该报）。
// 颜色写死而不是用 gradients 的随机配色：随机配色偶尔会落在低对比区间，
// 那时它是"真空白"，blank 会先报、content 按去重规则不重复报——测试就飘了。
const emptyDir = await make('empty', async (dir) => {
  await ff(dir, ['-f', 'lavfi', '-i', 'gradients=c0=0x1a2430:c1=0x8090a0:s=640x360:r=30:d=3:speed=0:n=2:seed=7', ...h264, 'film.mp4'])
})
const emptyReport = await run(emptyDir, whole())
check('渐变空画面：报有底没内容', () => assert.equal(findings(emptyReport, 'content').length, 1))
check('渐变空画面：blank 恰好抓不到（说明这条检查补的是真空白）', () => assert.equal(findings(emptyReport, 'blank').length, 0))

// 6. 连续两镜都静止：从"某一镜的问题"升级成全片 fail。
const twoDir = await make('two', async (dir) => {
  await still(dir)
  await ff(dir, ['-loop', '1', '-i', 'still.png', '-t', '3', '-r', '30', ...h264, 'half.mp4'])
  await ff(dir, ['-i', 'half.mp4', '-i', 'half.mp4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', ...h264, 'film.mp4'])
})
const twoReport = await run(twoDir, { fps: 30, durationInFrames: 180,
  shots: [{ id: 's1', startFrame: 0, durationFrames: 90 }, { id: 's2', startFrame: 90, durationFrames: 90 }] })
check('连续两镜静止：升级成 fail', () => assert.equal(findings(twoReport, 'energy-ppt').length, 1))
check('连续两镜静止：逐镜都记了账', () => assert.equal(twoReport.shots.filter((shot) => shot.energy.median === 0).length, 2))

// 7. 纯黑片：黑场该报，空画面不该重复报同一段（同一次失败只报一次）。
const blackDir = await make('black', async (dir) => {
  await ff(dir, ['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=2', ...h264, 'film.mp4'])
})
const blackReport = await run(blackDir, whole(60))
check('纯黑片：黑场报 fail', () => assert.equal(findings(blackReport, 'black').length, 1))
check('纯黑片：空画面不重复报', () => assert.equal(findings(blackReport, 'content').length, 0))

// 8. 真实成片：仓库里这份宣传片是正常做的，两条新检查都不该有话说。
const real = join(process.cwd(), 'docs', 'media', 'motion-showcase.mp4')
if (existsSync(real)) {
  const realDir = join(root, 'real')
  mkdirSync(realDir, { recursive: true })
  const realReport = await runFrameQa({ dir: realDir, file: real,
    timeline: { fps: 30, durationInFrames: 300, shots: [{ id: 'whole', startFrame: 0, durationFrames: 300 }] },
    options: { pixels: false } })
  check('真实成片：动能量与空画面都不误报', () => {
    assert.equal(findings(realReport, 'energy').length, 0)
    assert.equal(findings(realReport, 'content').length, 0)
  })
}

// 9. 报告里要能看出量纲，否则读 JSON 的人没法判断 2.3 是好是坏。
check('报告写明量纲与统计帧数', () => {
  assert.match(staticReport.motion.unit, /0–255/)
  assert.equal(staticReport.motion.diffFrames, 90)
  assert.equal(staticReport.motion.edgeFrames, 90)
  for (const shot of twoReport.shots) {
    assert.ok(Number.isFinite(shot.energy.median))
    assert.ok(Number.isFinite(shot.energy.low))
  }
})

console.log('\n' + passed + ' checks passed')
