// 工程模板：把"一条视频"落成磁盘上的小文件工程。
//
// 目录约定（作用域 = 画布里一个视频节点）：
//   timeline.json      总谱：尺寸、帧率、时长、每段的起止帧与文件
//   scene-<n>.tsx      一场景一文件，default export React 组件，≤120 行
//   components/        共享原语，单文件同样 ≤120 行
//   assets/            旁白、配乐、截图（渲染时作为 public 目录）
//   BRIEF.md           写给模型的一次性规格摘要
//
// 这里不启动任何 LLM：模板只是文件，写代码的是主对话 agent。

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { prepareMotionProject } from '../motion-project.js'
import { DEFAULT_SPEC, readSpec, validateSpec } from './spec.js'
import { timelineFromCards } from './cards.js'
import { describeTrack, readTrack } from './audio.js'
import { resolveTheme, writeTheme } from './theme.js'

const TIMELINE = 'timeline.json'

function sceneFile(index) {
  return 'scene-' + index + '.tsx'
}

function sceneStub(shot, spec, theme) {
  const lines = [
    "import React from 'react'",
    "import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'",
    ...(theme ? ["import { PAPER, INK, SERIF } from './theme'"] : []),
    '',
    '// ' + shot.id + ': ' + shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1) + ' 帧',
    '// 占位：换成这一镜真正的版面。颜色/字体从 theme.ts 取，不要手写十六进制。',
    '// 时长一律用 useVideoConfig()：旁白重排或改时间轴之后，收尾动作会自动跟着挪；',
    '// 写死一个 DUR 常量的话，镜头一变长，最后那段就是静止的（旁白接上就会踩到）。',
    'export default function Scene() {',
    '  const frame = useCurrentFrame()',
    '  const { durationInFrames } = useVideoConfig()',
    '  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: \'clamp\' })',
    '  const settle = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0.97], { extrapolateLeft: \'clamp\' })',
    '  return (',
    '    <AbsoluteFill style={{ background: ' + (theme ? 'PAPER' : "'#111'") + ', opacity, opacity: opacity * settle }}>',
    '      <AbsoluteFill style={{ alignItems: \'center\', justifyContent: \'center\' }}>',
    '        <div style={{ color: ' + (theme ? 'INK' : "'#eee'") + ', fontSize: ' + (theme ? 40 : 64) + ', fontFamily: ' + (theme ? 'SERIF' : "'sans-serif'") + ' }}>' + shot.id + '</div>',
    '      </AbsoluteFill>',
    '    </AbsoluteFill>',
    '  )',
    '}',
    '',
  ]
  return lines.join('\n')
}

export function readTimeline(dir) {
  const file = join(dir, TIMELINE)
  if (!existsSync(file)) throw new Error('工程缺少 timeline.json，请先运行 motion_project create')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(raw.shots) || !raw.shots.length) throw new Error('timeline.json 缺少 shots')
  raw.audio = readTrack(raw)
  return raw
}

export function writeTimeline(dir, timeline) {
  writeFileSync(join(dir, TIMELINE), JSON.stringify(timeline, null, 2) + '\n', 'utf8')
  return timeline
}

export function defaultTimeline(spec, segmentCount = 4) {
  const frames = spec.totalFrames
  const per = Math.round(frames / segmentCount)
  let cursor = 0
  const shots = []
  for (let index = 0; index < segmentCount; index += 1) {
    const durationFrames = index === segmentCount - 1 ? frames - cursor : per
    shots.push({ id: 'shot-' + (index + 1), file: sceneFile(index), startFrame: cursor, durationFrames })
    cursor += durationFrames
  }
  return { version: 1, width: spec.width, height: spec.height, fps: spec.fps, durationInFrames: frames, shots }
}

export function createProject(dir, options = {}) {
  const spec = readSpec({ ...DEFAULT_SPEC, ...options.spec })
  const errors = validateSpec(spec)
  if (errors.length) throw new Error('视频规格不合法：' + errors.join('；'))
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'components'), { recursive: true })
  const theme = options.theme ? resolveTheme(options.theme) : null
  if (theme) {
    writeTheme(dir, theme, options.fonts)
    options.themeName = theme.name
  }
  const cards = Array.isArray(options.cards) ? options.cards : []
  const timeline = existsSync(join(dir, TIMELINE))
    ? readTimeline(dir)
    : writeTimeline(dir, cards.length
      ? timelineFromCards(spec, cards, { fitFrames: Number(options.fitFrames) || 0 })
      : defaultTimeline(spec, Number(options.segments) || 4))
  for (const shot of timeline.shots) {
    const file = join(dir, shot.file)
    if (!existsSync(file)) writeFileSync(file, sceneStub(shot, spec, theme), 'utf8')
  }
  // 分镜表：先把"每一镜要干什么"写成表，再动笔。表在工程里，不在对话里。
  const storyboard = normalizeStoryboard(options.storyboard, timeline)
  if (storyboard.length) writeFileSync(join(dir, 'storyboard.md'), storyboardMarkdown(timeline, storyboard), 'utf8')
  writeFileSync(join(dir, 'BRIEF.md'), brief(timeline, options, storyboard), 'utf8')
  // 旁白脚本的骨架：空模板比"格式写在哪"更省事，motion_voice 直接读它。
  const voiceScript = join(dir, 'voice.script.md')
  if (!existsSync(voiceScript)) writeFileSync(voiceScript, voiceScriptStub(timeline), 'utf8')
  return { dir, timeline, storyboard, theme: theme ? theme.name : null, files: listFiles(dir) }
}

// 接受 [{card,intent,onScreen,copy,sound}]，也接受 ["一句话"] 这种简写。
export function normalizeStoryboard(input, timeline) {  if (!Array.isArray(input) || !input.length) return []
  return input.slice(0, timeline.shots.length).map((item, index) => {
    if (typeof item === 'string') return { shot: timeline.shots[index].id, intent: item.trim() }
    const pick = (key) => (item && typeof item[key] === 'string' ? item[key].trim() : '')
    return {
      shot: timeline.shots[index].id,
      card: pick('card') || timeline.shots[index].card || '',
      intent: pick('intent') || pick('beats') || pick('what'),
      onScreen: pick('onScreen') || pick('screen'),
      copy: pick('copy'),
      sound: pick('sound') || pick('audio'),
    }
  }).filter((row) => row.intent || row.onScreen || row.copy || row.sound)
}

// 旁白脚本骨架：一节一镜、一句一行。旁白决定镜头多长，所以先写话再写画面。
function voiceScriptStub(timeline) {
  const lines = [
    '# 旁白脚本',
    '',
    '每个 ## shot-N 对应时间轴上的一镜，一句一行；`>` 开头的行是给自己看的备注，不念。',
    '写完跑 motion_voice {action:"plan"} 看排期，满意了再 {action:"say"} 合成。',
    '',
  ]
  for (const shot of timeline.shots) {
    lines.push('## ' + shot.id, '', '> ' + (shot.card || '这一镜要说什么'), '', '')
  }
  return lines.join('\n')
}

function storyboardMarkdown(timeline, storyboard) {
  const lines = [
    '# 分镜表',
    '',
    '每条视频先在表里写清"这一镜讲什么、屏幕上出现什么、配什么字、响什么"，再写场景代码。',
    '规范见 `docs/motion-video-playbook.md`：分镜表过了才许开写（P2 闸门），第一镜打样过了才许铺其余镜头（P4 闸门）。',
    '',
    '| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现 | 文案 | 声音 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const [index, shot] of timeline.shots.entries()) {
    const row = storyboard.find((item) => item.shot === shot.id) || {}
    lines.push('| ' + shot.id + ' | ' + shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1) + ' | '
      + (row.card || shot.card || '—') + ' | ' + (row.intent || '—') + ' | ' + (row.onScreen || '—') + ' | ' + (row.copy || '—') + ' | ' + (row.sound || '—') + ' |')
  }
  lines.push('', '## 镜间转场', '', '（逐条写清上一镜怎么交棒给下一镜：收灯 / 开灯 / 切 / 推 / 同轴延续。没写就是硬切，硬切是本片的选择而不是疏忽。）', '')
  return lines.join('\n') + '\n'
}

function brief(timeline, options, storyboard = []) {
  const lines = [
    '# 视频工程',
    '',
    '按 `docs/motion-video-playbook.md` §2 的 7 项填空，缺项先标「假设」再往下做。',
    '',
    '| # | 立项项 | 结论 |',
    '| --- | --- | --- |',
    '| 1 | 给谁看 / 在哪播 | 假设：产品介绍页 |',
    '| 2 | 只让人记住哪一句 | 假设：见下方「描述」 |',
    '| 3 | 时长 / 画幅 / 帧率 | ' + timeline.width + '×' + timeline.height + ' / ' + timeline.fps + 'fps / ' + timeline.durationInFrames + ' 帧（' + (timeline.durationInFrames / timeline.fps).toFixed(2) + ' 秒） |',
    '| 4 | 要不要声音（音效 / 音效+底噪 / 音乐 / 配音） | **待定：先问用户**，定了写进「音频」段 |',
    '| 5 | 素材边界（真实截图 / 品牌色 / 字体） | 假设：界面用自建 HTML mock 截 2 倍图 |',
    '| 6 | 必须出现 / 必须避开的说法 | 假设：无 |',
    '| 7 | 什么样算过 | 假设：用户能指着某镜说「这就是那张卡」 |',
    '',
    '## 分镜',
    '',
    ...timeline.shots.map((shot) => '- ' + shot.id + '：第 ' + shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1) + ' 帧，文件 ' + shot.file
      + (shot.card ? '（镜头卡 ' + shot.card + (shot.style && shot.style !== shot.card ? ' · ' + shot.style : '') + '）' : '')),
    '',
    ...(storyboard.length ? ['## 分镜表', '', ...storyboard.map((row) => '- ' + row.shot + '：' + [row.intent, row.onScreen && '画面 ' + row.onScreen, row.copy && '文案 ' + row.copy, row.sound && '声音 ' + row.sound].filter(Boolean).join('；')), ''] : []),
    '## 音频',
    '',
    describeTrack(readTrack(timeline), timeline.fps),
    '',
    '## 约定',
    '',
    '- 用了镜头卡就必须读 `lib/motion/shotcraft/upstream/demos/**` 里那张卡的 demo 源码再移植，只换内容/配色/品牌；凭卡名重写等于放弃全部调校。',
    '- 一场景一文件，单文件不超过 120 行；共享元素放 components/。',
    '- 场景组件 default export，签名 () => ReactNode；时间用 useCurrentFrame()，相对本段起点。',
    '- 改完先渲染 3 帧看图（motion_preview），确认后再跑全片（motion_render）。',
    '- 改过 components/ 或 theme.ts 之后，要把对应 scene 顶栏的 `// rev N` 递增一次，否则 bundle 缓存不重建。',
    options.themeName ? '- 配色主题：' + options.themeName + '（颜色/字体从 theme.ts 取，别手写十六进制）。' : '',
    '- 时间轴改动只改 timeline.json 的 startFrame / durationFrames，不要改场景文件里的绝对帧号。',
    '- 交付前跑 motion_qa；有声音时目标 −16 LUFS / 真峰 −1.5 dBTP。',
    '',
    options.prompt ? '## 描述\n\n' + String(options.prompt).slice(0, 4000) + '\n' : '',
    options.refs?.length ? '## 参考\n\n' + options.refs.map((ref) => '- ' + ref.role + '：' + (ref.assetId || ref.cardId || ref.id)).join('\n') + '\n' : '',
  ]
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')
}

export function listFiles(dir) {
  const out = []
  const walk = (base, prefix) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name === '.out' || entry.name === 'node_modules') continue
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(join(base, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

// 把磁盘上的工程读成 Remotion 需要的 composition：
// sceneSource 现读现取，所以 agent 改完文件后不用重新登记。
export function buildComposition(dir) {
  const timeline = readTimeline(dir)
  const shots = timeline.shots.map((shot) => {
    const file = join(dir, shot.file)
    if (!existsSync(file)) throw new Error('缺少场景文件：' + shot.file)
    return {
      id: shot.id,
      recipeId: 'scene',
      startFrame: shot.startFrame,
      durationFrames: shot.durationFrames,
      referenceIds: Array.isArray(shot.referenceIds) ? shot.referenceIds : [],
      sceneSource: readFileSync(file, 'utf8'),
    }
  })
  return {
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    durationFrames: timeline.durationInFrames,
    shots,
    audio: readTrack(timeline),
  }
}

// 让 Remotion 认这个工程：入口 index.jsx + shotcraft 别名。
export function registerProject(dir) {
  const composition = buildComposition(dir)
  return prepareMotionProject(composition, dir, { preserveSources: true, refreshEntry: true })
}
