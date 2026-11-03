// 动效视频的契约回归：这四个曾经出过错的地方，必须一直是对的。
//
//   1. 时长允许小数（9.3 秒不能变成 9 秒）
//   2. 显式时长优先于镜头卡总和（卡片只决定相对比例）
//   3. 卡片 duration 里的帧数按卡自己的 fps 换算到工程 fps（168f@30fps ≠ 168 帧）
//   4. 同一个音效可以放在不同时间点（只有同文件+同角色+同位置才替换）
//
// 这些是纯模块测试，不需要重启插件；跑 `node tools/check-motion-fixes.mjs`。

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { readSpec } from '../src/motion/spec.js'
import { cardFrames, timelineFromCards } from '../src/motion/cards.js'
import { addCue, readTrack } from '../src/motion/audio.js'
import { createProject, readTimeline } from '../src/motion/project.js'

const root = 'tmp/check-motion-fixes'
let passed = 0
const ok = (label, value) => {
  passed += 1
  console.log('  ✓ ' + label + (value === undefined ? '' : '：' + value))
}

console.log('1) 小数时长')
{
  const spec = readSpec({ duration: 9.3 })
  assert.equal(spec.duration, 9.3, '9.3 秒被取整了')
  assert.equal(spec.totalFrames, 279, '9.3 秒 @30fps 应为 279 帧')
  assert.equal(readSpec({ duration: 15 }).duration, 15)
  ok('readSpec 保留小数', spec.duration + 's / ' + spec.totalFrames + ' 帧')
}

console.log('2) 显式时长 vs 镜头卡总和')
{
  const spec = readSpec({ fps: 30, duration: 15 })
  const cards = [
    { cardId: 'a', styleKey: 'a', duration: '129f@30fps' },
    { cardId: 'b', styleKey: 'b', duration: '129f@30fps' },
  ]
  const byCards = timelineFromCards(spec, cards)
  assert.equal(byCards.durationInFrames, 258, '没给时长时应按卡片总和')
  const fitted = timelineFromCards(spec, cards, { fitFrames: spec.totalFrames })
  assert.equal(fitted.durationInFrames, 450, '显式 15 秒应压过卡片总和')
  const sum = fitted.shots.reduce((acc, shot) => acc + shot.durationFrames, 0)
  assert.equal(sum, 450, '各段之和必须精确等于总帧数')
  assert.deepEqual(fitted.shots.map((shot) => shot.durationFrames), [225, 225], '应按相对时长等比拉伸')
  ok('258 帧卡片 + 显式 15s', fitted.shots.map((shot) => shot.durationFrames).join(' + '))
  ok('不给时长', byCards.durationInFrames + ' 帧（8.60s）')
}

console.log('3) 卡片帧数按 fps 换算')
{
  assert.equal(cardFrames('168f@30fps', 30), 168)
  assert.equal(cardFrames('168f@30fps', 25), 140)
  assert.equal(cardFrames('168f@30fps', 15), 84)
  assert.equal(cardFrames('约5.6s（168f@30fps）', 15), 84, '优先级应是帧数+自身 fps')
  assert.equal(cardFrames('5.6s', 15), 84)
  const spec15 = readSpec({ fps: 15, duration: 10 })
  const tl = timelineFromCards(spec15, [{ cardId: 'x', styleKey: 'x', duration: '168f@30fps' }])
  assert.equal(tl.durationInFrames, 84, '15fps 工程里 168f@30fps 应是 84 帧')
  ok('168f@30fps', '30fps→168 / 25fps→140 / 15fps→84')
}

console.log('4) 同一音效放两次')
{
  let timeline = { version: 1, fps: 30, durationInFrames: 450, shots: [], audio: [] }
  const cue = (from) => ({ file: 'sfx/click.mp3', role: 'sfx', from, durationInFrames: 15 })
  timeline = addCue(timeline, cue(30))
  timeline = addCue(timeline, cue(120))
  assert.equal(readTrack(timeline).length, 2, '不同时间点应并存')
  timeline = addCue(timeline, cue(120))
  assert.equal(readTrack(timeline).length, 2, '同位置重复添加应幂等')
  timeline = addCue(timeline, { file: 'sfx/click.mp3', role: 'bgm', from: 120, durationInFrames: 15 })
  assert.equal(readTrack(timeline).length, 3, '不同角色应并存')
  ok('position 30/120 + 幂等', readTrack(timeline).map((item) => item.role + '@' + item.from).join(', '))
}

console.log('5) 建工程与分镜表')
{
  rmSync(root, { recursive: true, force: true })
  const created = createProject(root, {
    spec: { width: 1080, height: 1920, fps: 30, duration: 9.3 },
    segments: 3,
    storyboard: ['开场定调', { intent: '数字铺开', onScreen: '点阵', copy: '30,000' }, '收束'],
  })
  assert.equal(created.timeline.durationInFrames, 279)
  assert.equal(created.timeline.shots.length, 3)
  const last = created.timeline.shots[2]
  assert.equal(last.startFrame + last.durationFrames, 279, '末段必须刚好铺满时长')
  assert.ok(existsSync(join(root, 'storyboard.md')), '缺少 storyboard.md')
  assert.ok(readFileSync(join(root, 'BRIEF.md'), 'utf8').includes('## 分镜表'), 'BRIEF 缺少分镜表')
  const again = readTimeline(root)
  assert.equal(again.durationInFrames, 279, '重新读取应保持 279 帧')
  ok('9.3 秒 3 段', '末段结束于 ' + (last.startFrame + last.durationFrames) + ' 帧')
  ok('storyboard.md', created.storyboard.length + ' 行')
}

rmSync(root, { recursive: true, force: true })
console.log('\n通过 ' + passed + ' 项')
