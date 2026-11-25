// 多轨时间轴的剪辑语义与旧工程兼容。
//
// 这些断言固定首版规则：主镜头轨同轨不重叠、分割连续、左裁改源偏移、右裁缩短、
// 重排从 0 帧连续排布、裁剪不 ripple、叠加轨独立。另一个重点是旧 timeline 只映射
// 不改写，保存后才升级成 version 2。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  normalizeTimeline, splitClipAt, trimClipAt, reorderMainClip, addOverlayClip,
  removeClip, moveClipAt, updateClipAt, editShotsOf, timelineRevision, serializeTimeline,
  mainClipsOf, overlayTracksOf, cueBindingsOf, workbenchPlanOf,
} from '../src/motion/timeline.js'
import { readTimeline, writeTimeline, saveTimelineChecked, buildComposition } from '../src/motion/project.js'
import { resolveSync } from '../src/motion/sync.js'
import { prepareMotionProject } from '../src/motion-project.js'
import { prepareWorkbenchEntry, prepareWorkbenchSources, workbenchBundleKey } from '../src/motion/workbench.js'
import { planNarration } from '../src/motion/voice.js'
import { addCue } from '../src/motion/audio.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log('PASS ' + name) }
  catch (error) { console.error('FAIL ' + name); throw error }
}
mkdirSync('.tmp', { recursive: true })
const root = mkdtempSync(resolve('.tmp/motion-timeline-'))
try {
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'scene-0.tsx'), 'export default function Scene(){return null}')
  writeFileSync(join(root, 'scene-1.tsx'), 'export default function Scene(){return null}')
  writeFileSync(join(root, 'scene-2.tsx'), 'export default function Scene(){return null}')
  const legacy = {
    version: 1, width: 1280, height: 720, fps: 30, durationInFrames: 180,
    shots: [
      { id: 'shot-1', file: 'scene-0.tsx', startFrame: 0, durationFrames: 90, anchors: { hit: 20 } },
      { id: 'shot-2', file: 'scene-1.tsx', startFrame: 90, durationFrames: 90, anchors: {} },
    ],
    audio: [{ id: 'bgm', file: 'music.mp3', role: 'bgm', from: 0, durationInFrames: 180, gainDb: -10 }],
  }
  const normalized = normalizeTimeline(legacy)
  check('旧工程映射成主镜头轨 + 空叠加轨，不动来源时长', () => {
    assert.equal(normalized.version, 2)
    assert.equal(normalized.tracks.length, 2)
    assert.equal(normalized.tracks[0].role, 'main')
    assert.equal(normalized.tracks[0].clips.length, 2)
    assert.equal(normalized.tracks[1].role, 'overlay')
    assert.equal(normalized.shots[0].sourceDurationFrames, 90)
    assert.equal(normalized.shots[0].anchors.hit, 20)
  })

  const split = splitClipAt(normalized, 'clip-shot-1', 30)
  check('90 帧场景在第 30 帧分割，右段从源第 30 帧接着播', () => {
    const clips = mainClipsOf(split)
    assert.equal(clips.length, 3)
    assert.equal(clips[0].durationFrames, 30)
    assert.equal(clips[1].startFrame, 30)
    assert.equal(clips[1].durationFrames, 60)
    assert.equal(clips[1].inOffset, 30)
  })
  check('分割不改变场景来源，两段仍指向同一个 shot/file', () => {
    const [left, right] = mainClipsOf(split)
    assert.equal(left.shotId, 'shot-1')
    assert.equal(right.shotId, 'shot-1')
    assert.notEqual(left.id, right.id)
    const composition = buildCompositionIn(root, split)
    assert.equal(composition.shots[0].sceneFile, 'scene-0.tsx')
    assert.equal(composition.shots[1].sceneFile, 'scene-0.tsx')
    assert.equal(composition.shots[1].sourceId, 'shot-1')
    assert.equal(composition.shots[0].sceneDurationFrames, 90)
    assert.equal(composition.shots[1].sceneDurationFrames, 90)
  })
  const rightTrimmed = trimClipAt(split, mainClipsOf(split)[1].id, 'right', 70)
  check('右裁后场景仍按源时长计算收尾动画', () => {
    const composition = buildCompositionIn(root, rightTrimmed)
    assert.equal(composition.shots[1].durationFrames, 40)
    assert.equal(composition.shots[1].sceneDurationFrames, 90)
  })

  const leftTrim = trimClipAt(split, mainClipsOf(split)[1].id, 'left', 45)
  check('左裁改变源帧偏移，右端保持不变', () => {
    const clip = mainClipsOf(leftTrim)[1]
    assert.equal(clip.startFrame, 45)
    assert.equal(clip.inOffset, 45)
    assert.equal(clip.startFrame + clip.durationFrames, 90)
  })
  const rightTrim = trimClipAt(split, mainClipsOf(split)[1].id, 'right', 70)
  check('右裁缩短片段，左端与源偏移不动', () => {
    const clip = mainClipsOf(rightTrim)[1]
    assert.equal(clip.startFrame, 30)
    assert.equal(clip.inOffset, 30)
    assert.equal(clip.durationFrames, 40)
  })
  check('右裁遇到下一片段边界会夹住，不允许同轨重叠', () => {
    const clipped = trimClipAt(split, mainClipsOf(split)[0].id, 'right', 45)
    const clips = mainClipsOf(clipped)
    assert.equal(clips[0].durationFrames, 30)
    assert.ok(clips[0].startFrame + clips[0].durationFrames <= clips[1].startFrame)
  })

  const reordered = reorderMainClip(split, mainClipsOf(split)[2].id, 0)
  check('重排后主镜头从 0 帧连续排布，总长不变', () => {
    const clips = mainClipsOf(reordered)
    assert.deepEqual(clips.map((clip) => clip.shotId), ['shot-2', 'shot-1', 'shot-1'])
    assert.deepEqual(clips.map((clip) => clip.startFrame), [0, 90, 120])
    assert.equal(clips.reduce((sum, clip) => sum + clip.durationFrames, 0), 180)
  })

  const withOverlay = addOverlayClip(normalized, { shotId: 'shot-2', startFrame: 15, durationFrames: 30, opacity: 0.5 })
  check('叠加片段独立落点、时长和透明度', () => {
    const overlay = overlayTracksOf(withOverlay)[0]
    assert.equal(overlay.clips.length, 1)
    assert.equal(overlay.clips[0].startFrame, 15)
    assert.equal(overlay.clips[0].durationFrames, 30)
    assert.equal(overlay.clips[0].opacity, 0.5)
    assert.equal(moveClipAt(withOverlay, overlay.clips[0].id, 60).tracks[1].clips[0].startFrame, 60)
    assert.equal(updateClipAt(withOverlay, overlay.clips[0].id, { opacity: 0.25 }).tracks[1].clips[0].opacity, 0.25)
  })
  check('删除片段与 editShots 视图', () => {
    const id = mainClipsOf(split)[1].id
    assert.equal(mainClipsOf(removeClip(split, id)).length, 2)
    assert.deepEqual(editShotsOf(normalized).map((shot) => [shot.id, shot.startFrame, shot.durationFrames]),
      [['clip-shot-1', 0, 90], ['clip-shot-2', 90, 90]])
  })

  // 落盘：旧工程打开不改写；保存升级到 v2；再次打开保持多轨。
  writeFileSync(join(root, 'timeline.json'), JSON.stringify(legacy, null, 2) + '\n')
  const before = readFileSync(join(root, 'timeline.json'), 'utf8')
  const opened = readTimeline(root)
  check('旧工程打开本身不写盘', () => {
    assert.equal(readFileSync(join(root, 'timeline.json'), 'utf8'), before)
    assert.equal(opened.tracks[0].clips.length, 2)
  })
  const saved = writeTimeline(root, withOverlay)
  check('保存写入 version 2、tracks 与 revision', () => {
    const disk = JSON.parse(readFileSync(join(root, 'timeline.json'), 'utf8'))
    assert.equal(disk.version, 2)
    assert.equal(disk.tracks[0].clips.length, 2)
    assert.equal(disk.tracks[1].clips.length, 1)
    assert.equal(typeof disk.revision, 'string')
    assert.equal(disk.revision, timelineRevision(saved))
    assert.equal(timelineRevision(JSON.parse(readFileSync(join(root, 'timeline.json'), 'utf8'))), disk.revision)
  })
  check('重新打开仍回到同一个多轨工程', () => {
    const again = readTimeline(root)
    assert.equal(again.tracks[1].clips[0].startFrame, 15)
    assert.equal(again.tracks[1].clips[0].opacity, 0.5)
  })

  const currentRevision = timelineRevision(readTimeline(root))
  const draft = readTimeline(root)
  draft.tracks[1].clips[0].startFrame = 40
  const snapshot = readFileSync(join(root, 'timeline.json'), 'utf8')
  const conflict = saveTimelineChecked(root, draft, 'stale-revision')
  check('版本冲突不写盘，草稿由调用方保留', () => {
    assert.equal(conflict.conflict, true)
    assert.equal(conflict.revision, currentRevision)
    assert.equal(readFileSync(join(root, 'timeline.json'), 'utf8'), snapshot)
  })
  const forced = saveTimelineChecked(root, draft, 'stale-revision', { force: true })
  check('显式覆盖保存成功并更新 revision', () => {
    assert.equal(forced.conflict, false)
    assert.notEqual(forced.revision, currentRevision)
    assert.equal(readTimeline(root).tracks[1].clips[0].startFrame, 40)
  })

  // 卡点：切点绑定只移动绑定片段及相邻边界，未绑定的裁剪保持。
  const bound = normalizeTimeline({
    width: 640, height: 360, fps: 30, durationInFrames: 180, audio: [
      { id: 'music', file: 'music.mp3', role: 'bgm', from: 0, durationInFrames: 180, trimStart: 0 },
      { id: 'hit', file: 'hit.wav', role: 'sfx', from: 0, durationInFrames: 9, trimStart: 0 },
    ],
    shots: [
      { id: 'shot-1', file: 'scene-0.tsx', startFrame: 0, durationFrames: 60, anchors: {} },
      { id: 'shot-2', file: 'scene-1.tsx', startFrame: 60, durationFrames: 60, anchors: {} },
      { id: 'shot-3', file: 'scene-2.tsx', startFrame: 120, durationFrames: 60, anchors: {} },
    ],
    sync: { musicCueId: 'music', anchors: [{ id: 'cut-2', type: 'cut', shotId: 'shot-2', at: 1.5 }] },
  })
  bound.tracks[0].clips[2].durationFrames = 30 // 未绑定的右裁（留空隙）
  const boundWithOverlay = addOverlayClip(bound, { shotId: 'shot-1', startFrame: 7, durationFrames: 20, opacity: 0.6 })
  const resolved = resolveSync(boundWithOverlay)
  check('切点绑定落在片段边界，未绑定裁剪保留', () => {
    const clips = mainClipsOf(resolved)
    assert.equal(clips[1].startFrame, 45)
    assert.equal(clips[0].durationFrames, 45)
    assert.equal(clips[2].durationFrames, 30)
    assert.equal(resolved.sync.resolved[0].frame, 45)
    assert.equal(resolved.tracks[1].clips[0].startFrame, 7)
    assert.equal(resolved.tracks[1].clips[0].opacity, 0.6)
  })
  check('工作台绑定回执是 Map/Set，画面和音效绑定都能直接查', () => {
    const index = cueBindingsOf({
      cuts: [{ id: 'cut-2', frame: 45, shotId: 'shot-2', clipId: 'clip-shot-2' }],
      sfxCueIds: ['hit'], musicCueId: 'music',
    })
    assert.ok(index.cuts instanceof Map)
    assert.equal(index.cuts.get(45).id, 'cut-2')
    assert.deepEqual([...index.cuts.values()].map((cut) => cut.frame), [45])
    assert.ok(index.sfx instanceof Set)
    assert.equal(index.sfx.has('hit'), true)
    assert.equal(index.musicCueId, 'music')
  })
  check('工作台预览计划与成片 composition 的轨道、裁点和音轨一致', () => {
    const plan = workbenchPlanOf(resolved, [])
    const composition = buildCompositionIn(root, resolved)
    const contract = (shot) => ({
      id: shot.id, sourceId: shot.sourceId, file: shot.sceneFile || shot.file,
      startFrame: shot.startFrame, durationFrames: shot.durationFrames,
      sourceDurationFrames: shot.sourceDurationFrames, sceneDurationFrames: shot.sceneDurationFrames,
      inOffset: shot.inOffset, opacity: shot.opacity ?? 1, trackRole: shot.trackRole, layer: shot.layer,
    })
    assert.deepEqual(plan.shots.map(contract), composition.shots.map(contract))
    assert.deepEqual(plan.audio.map((cue) => [cue.id, cue.from, cue.durationInFrames, cue.gainDb]),
      composition.audio.map((cue) => [cue.id, cue.from, cue.durationInFrames, cue.gainDb]))
    assert.equal(plan.shots.find((shot) => shot.trackRole === 'overlay').opacity, 0.6)
  })

  // 24fps：同样的整数帧规则，不出现秒转帧的累计误差。
  const palette = normalizeTimeline({ ...legacy, fps: 24, durationInFrames: 144, shots: [
    { id: 'shot-1', file: 'scene-0.tsx', startFrame: 0, durationFrames: 72, anchors: {} },
    { id: 'shot-2', file: 'scene-1.tsx', startFrame: 72, durationFrames: 72, anchors: {} },
  ] })
  const split24 = splitClipAt(palette, 'clip-shot-1', 17)
  check('24fps 分割点仍是整数帧，源偏移一致', () => {
    const clips = mainClipsOf(split24)
    assert.equal(clips[0].durationFrames, 17)
    assert.equal(clips[1].startFrame, 17)
    assert.equal(clips[1].inOffset, 17)
  })
  check('24fps 分割前后按源局部帧连续推进，收尾动画长度不变', () => {
    const plan = workbenchPlanOf(split24)
    const [left, right] = plan.shots.filter((shot) => shot.sourceId === 'shot-1')
    const local = (frame, shot) => frame - shot.startFrame + shot.inOffset
    assert.equal(local(16, left), 16)
    assert.equal(local(17, right), 17)
    assert.equal(left.sceneDurationFrames, 72)
    assert.equal(right.sceneDurationFrames, 72)
  })

  // prepareMotionProject：同一场景出现多次时只 import 一次，入口按片段 id 映射。
  const duplicate = buildCompositionIn(root, split)
  const prepared = prepareMotionProject(duplicate, root, { preserveSources: true })
  const entry = readFileSync(prepared.entryPoint, 'utf8')
  check('重排/分割后场景入口按稳定来源去重，不按下标导错文件', () => {
    assert.equal((entry.match(/from '\.\/scene-0\.tsx'/g) || []).length, 1)
    assert.ok(entry.includes('"shot-1":Scene0'))
    assert.ok(entry.includes('"shot-2":Scene1'))
    assert.ok(!entry.includes('scene-1.tsx') || entry.includes('Scene1'))
    const workbenchEntry = readFileSync(prepareWorkbenchEntry(root, duplicate), 'utf8')
    assert.equal((workbenchEntry.match(/from '\.\/scene-0\.tsx'/g) || []).length, 1)
    assert.ok(workbenchEntry.includes('"shot-1":Scene0'))
    assert.ok(workbenchEntry.includes('"shot-2":Scene1'))
    prepareWorkbenchSources(root, duplicate)
    assert.ok(existsSync(join(root, 'workbench-runtime.gen.jsx')))
    assert.ok(existsSync(join(root, 'timeline-ops.gen.js')))
    assert.ok(existsSync(join(root, 'workbench-entry.gen.jsx')))
    assert.ok(readFileSync(join(root, 'workbench-entry.gen.jsx'), 'utf8').includes('registerWorkbenchRoot'))
  })

  // 预览 bundle key：片段时序无关，场景源码变化必须触发重打包。
  const previewTimeline = readTimeline(root)
  const previewKey = workbenchBundleKey(root, previewTimeline)
  const firstPreview = mainClipsOf(previewTimeline)[0]
  const splitPreview = splitClipAt(previewTimeline, firstPreview.id, firstPreview.startFrame + Math.floor(firstPreview.durationFrames / 2))
  check('预览 bundle key 不包含片段时序', () => assert.equal(workbenchBundleKey(root, splitPreview), previewKey))
  const sceneBefore = readFileSync(join(root, 'scene-0.tsx'), 'utf8')
  writeFileSync(join(root, 'scene-0.tsx'), sceneBefore + '\n// changed')
  check('场景源码变化会触发预览重打包', () => assert.notEqual(workbenchBundleKey(root, previewTimeline), previewKey))
  writeFileSync(join(root, 'scene-0.tsx'), sceneBefore)

  // AI 修改音频 / 旁白时保留工作台新增的轨道与字段。
  const withOverlayForAi = addOverlayClip(normalized, { shotId: 'shot-2', startFrame: 20, durationFrames: 24, opacity: 0.4 })
  const withCueAgain = addCue(withOverlayForAi, { file: 'hit.wav', role: 'sfx', from: 12, durationInFrames: 9 })
  check('motion_audio 加音轨保留主轨与叠加轨', () => {
    assert.equal(withCueAgain.tracks[0].clips.length, 2)
    assert.equal(withCueAgain.tracks[1].clips[0].opacity, 0.4)
  })
  const narrated = planNarration(withCueAgain, [{ shotId: 'shot-1', lines: [{ index: 0, text: '这是一句旁白。' }] }], { fit: 'grow' }).timeline
  check('motion_voice 重排主轨时保留叠加轨、透明度与音效', () => {
    assert.equal(narrated.tracks[1].clips[0].shotId, 'shot-2')
    assert.equal(narrated.tracks[1].clips[0].startFrame, 20)
    assert.equal(narrated.tracks[1].clips[0].opacity, 0.4)
    assert.ok(narrated.audio.some((cue) => cue.id === 'bgm'))
    assert.ok(narrated.audio.some((cue) => cue.role === 'voice'))
  })

  // 序列化剔除派生字段：工作台回传的 timeline 不带 sync.resolved。
  const bareSync = { ...normalized, sync: { musicCueId: 'bgm' } }
  const withResolved = { ...normalized, sync: { musicCueId: 'bgm', resolved: [{ id: 'x' }] } }
  check('serializeTimeline 去掉 sync.resolved，revision 不受派生字段影响', () => {
    assert.equal(serializeTimeline(withResolved).sync.resolved, undefined)
    assert.equal(timelineRevision(withResolved), timelineRevision(bareSync))
  })
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 上偶发占用，测试结果不依赖清理 */ }
}
console.log('Motion timeline checks passed: ' + passed)

function buildCompositionIn(dir, timeline) {
  // buildComposition 读磁盘 timeline；这里先写一份临时文件，再读回 composition。
  writeTimeline(dir, timeline)
  return buildComposition(dir)
}
