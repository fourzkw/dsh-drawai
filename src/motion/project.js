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
import { resolveSync } from './sync.js'
import { ENGINE_GUIDANCE, ENGINE_LABEL } from './style-engine.js'
import { writeSceneKit } from './scene-kit.js'
import { writeDelivery } from './delivery.js'
import { writeBuiltinAssets } from './builtin-assets.js'
import { writeBundledFonts, hasBundledFonts, availableBundledFontFaces } from './fonts.js'
import { parseProjectJson } from './json.js'

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
    '// anchors.<动作名> 是音乐绑定后的本镜局部帧，用作动效关键帧。',
    'export default function Scene({ anchors = {} }) {',
    '  const frame = useCurrentFrame()',
    '  const { durationInFrames } = useVideoConfig()',
    '  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: \'clamp\' })',
    '  const settle = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0.97], { extrapolateLeft: \'clamp\' })',
    '  return (',
    '    <AbsoluteFill style={{ background: ' + (theme ? 'PAPER' : "'#111'") + ', opacity: opacity * settle }}>',
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
  const raw = parseProjectJson(readFileSync(file, 'utf8'))
  if (!Array.isArray(raw.shots) || !raw.shots.length) throw new Error('timeline.json 缺少 shots')
  raw.audio = readTrack(raw)
  return resolveSync(raw)
}

export function writeTimeline(dir, timeline) {
  const resolved = resolveSync(timeline)
  writeFileSync(join(dir, TIMELINE), JSON.stringify(resolved, null, 2) + '\n', 'utf8')
  return resolved
}

// 风格只把"片子需要记住的那点"写进时间轴：slug/名/版本 + 色板/字体/节奏/判据。
// brief 全文进 STYLE.md，不进 timeline.json —— 时间轴是给程序读的，不是给人读的。
function withStyle(timeline, style) {
  if (!style) return timeline
  return { ...timeline, style: { slug: style.slug, name: style.name, commit: style.commit,
    palette: style.palette, fonts: style.fonts, rhythm: style.rhythm, signature: style.signature,
    engine: style.engine || null, engines: style.engines || [], engineNote: style.engineNote || '', engineFiles: style.engineFiles || [],
    motion: style.motion || null } }
}

/** 效果配方：brief 只写「是什么」，这里写「怎么动」。每一项都要求对着参考帧做，不许用「差不多」糊过去。 */
function motionMarkdown(style) {
  const motion = style.motion
  if (!motion) return []
  const rows = []
  rows.push('| 项 | 上游怎么做 | 这里必须做到 |')
  rows.push('| --- | --- | --- |')
  rows.push('| 转场 | ' + (motion.transitions === 'wipe' ? '色块 field wipe（按解析软边擦入/擦出，不是硬切）' : '硬切，切点落在 cue 上')
    + ' | ' + (motion.transitions === 'wipe' ? '至少一次带软边的擦除转场；没有 wipe 的段落不许用淡入淡出冒充' : '切点跟拍点对齐；不许用滑动/缩放转场代替') + ' |')
  rows.push('| 冲击 | ' + (motion.impact ? '接触瞬间 impact：形变挤压 + 地面环/波纹 + 机位抖' : '没有独立 impact 函数')
    + ' | ' + (motion.impact ? '每一次落地/接触都要有：挤压、环、抖动三件里至少两件' : '接触帧仍要有明显 scale 挤压') + ' |')
  rows.push('| 相机 | ' + (motion.camera ? 'world drift / hero push / whip / 冲击 shake，机位一直在动' : '机位基本固定')
    + ' | ' + (motion.camera ? '整片至少三处镜头运动（漂移/推近/甩/抖），不能全片静止机位' : '不要用大幅推拉冒充动效') + ' |')
  rows.push('| 运动模糊 | ' + (motion.motionBlur ? `motionBlur samples ${motion.motionBlur.samples} / shutter ${motion.motionBlur.shutter}` : '未开 motion blur')
    + ' | ' + (motion.motionBlur ? '快速位移的帧要有拖影（MotionBlurTrail / shutter 采样），不能是干净单帧' : '快动作靠形变本身，不加拖影') + ' |')
  rows.push('| 颗粒/纹理 | ' + (motion.grain ? `逐像素颗粒 ${motion.grain.size ? motion.grain.size + '²' : ''}（随帧位移 + 柔化），不是几百个点` : '没有颗粒层')
    + ' | ' + (motion.grain ? '颗粒要"看得见但不起脏"：逐像素生成、每帧换位置；几百个 1px 点不算' : '不要加通用噪点') + ' |')
  rows.push('| 二次运动 | ' + (motion.secondary?.length ? '上游还有：' + motion.secondary.join(' / ') : '未检测到二级动作')
    + ' | ' + (motion.secondary?.length ? '这些"让画面活着"的小动作至少保留两样，别只留主形变' : '画面靠主形变推进') + ' |')
  if (motion.feather) rows.push('| 软边 | 色块边缘有 FEATHER 解析软边 | 边缘不许是硬 polygon；按距离场/遮罩做柔边 |')
  return [
    '## 效果配方（必做，逐项对照参考帧）',
    '',
    ...rows,
    '',
    '取得参考帧：`mg_style {action:"frames", slug:"' + style.slug + '"}` → 返回 8 张 PNG，用 `read_image` 逐张看。',
    '**上游未检测到 ≠ 可省**：配方是下限，不是上限；判据（signature）与参考帧才是验收标准。',
    '做完每个镜头，把参考帧和 `motion_preview` 的成片帧并排放一次，逐行对上面的表——对不上的项要么改，要么在下面写一行「偏离：X 改为 Y，因为 Z」。',
    '',
  ]
}

function styleMarkdown(style) {
  const palette = Object.entries(style.palette || {}).map(([role, hex]) => '| ' + role + ' | `' + hex + '` |')
  // 风格不一定都来自 mg-styles-15：23-ink-wash 来自 huashu-art-motion。署名要跟着出处走，别张冠李戴。
  const origin = style.origin && style.origin.source
    ? style.origin.source.replace(/^https?:\/\/(github\.com\/)?/, '') + '（' + (style.origin.license || '见仓库') + (style.origin.commit ? '，commit ' + String(style.origin.commit).slice(0, 8) : '') + '）'
    : 'mg-styles-15（MIT，commit ' + String(style.commit || '').slice(0, 8) + '）'
  return [
    '# 整片风格：' + style.name + '（' + style.slug + '）',
    '',
    style.oneLiner || '',
    '',
    '来源：' + origin + '。上游是「HTML 页 + renderAt(t) + 截帧」，',
    '这里不是逐行搬运（整份 HTML 搬进场景会跟 Remotion 的帧模型打架），但动效、转场、冲击、',
    '相机与质感必须按下面的「效果配方」对齐——对不上就写偏离行，别静默省掉。',
    '',
    '## 判据（做不出这些就不算这个风格）',
    '',
    ...(style.signature || []).map((line) => '- ' + line),
    '',
    ...(style.engines?.length ? [
      '## 引擎契约（硬规定）',
      '',
      '- 上游引擎：' + style.engines.map((engine) => '`' + (ENGINE_LABEL[engine] || engine) + '`').join(' + ') + (style.engines.length > 1 ? '（都要在，缺一个就不像）' : ''),
      style.engineNote ? '- ' + style.engineNote : '',
      '',
      ...(style.engineFiles?.length ? ['上游证据：', ...style.engineFiles.slice(0, 6).map((path) => '  - `' + path + '`'), ''] : []),
      ...style.engines.map((engine) => '- ' + (ENGINE_LABEL[engine] || engine) + '：' + (ENGINE_GUIDANCE[engine] || '')),
      '',
      '**不要用更省事的方式替代**（CSS 3D、div 层叠、纯 Canvas2D 渐变、静态图位移都不算）。`motion_render start` 会扫工程源码：重引擎（three / webgl2 / webgl）缺了直接拒绝渲染，不会静默降级。确实要换实现，先在这里写一行「偏离：引擎 ' + style.engines[0] + ' 改为 …，因为 …」，渲染会带 warning 通过。',
      '',
    ] : []),
    ...motionMarkdown(style),
    '## 色板',
    '',
    '| 角色 | 值 |',
    '| --- | --- |',
    ...palette,
    '',
    style.colors?.length ? '片子里还会用到：' + style.colors.map((hex) => '`' + hex + '`').join(' / ') + '（这些不是 theme 常量，场景里直接写）。' : '',
    '',
    '## 字体',
    '',
    style.fonts ? '- display：`' + style.fonts.display + '`\n- text：`' + style.fonts.text + '`\n- mono：`' + style.fonts.mono + '`' : '-（这个风格没记字体栈，用 theme.ts 的默认值）',
    '',
    style.rhythm ? '## 节奏\n\n' + Object.entries(style.rhythm).map(([key, value]) => '- ' + key + '：' + value).join('\n') + '\n' : '',
    '## 移植说明',
    '',
    style.brief || '（这个风格还没有移植 brief）',
    '',
    '## 上游源码',
    '',
    ...(style.demos || []).map((path) => '- `' + path + '`'),
    '',
    '## 版权',
    '',
    '上游 MIT。品牌名必须虚构；通用几何与三原色可自由使用。',
    '',
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')
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

/**
 * 按分镜表开段：表里每行都给了有效时长且总和对得上总帧数，就照表的来；
 * 否则按行数均分。分镜表是"每一镜要干什么"的真相源，段数不该由卡片或默认值偷偷决定。
 */
export function timelineFromStoryboard(spec, rows) {
  const durations = rows.map((row) => Math.max(0, Math.round(Number(row.durationFrames) || 0)))
  const specified = durations.every((value) => value > 0)
  const total = durations.reduce((acc, value) => acc + value, 0)
  const count = Math.max(1, rows.length)
  // 表里每行都写了时长就照表走（表是真相源），没写才退回节点时长按行数均分。
  const frames = specified ? total : (Number(spec.totalFrames) || 0)
  const per = Math.round(frames / count)
  let cursor = 0
  const shots = []
  for (let index = 0; index < count; index += 1) {
    const durationFrames = specified ? durations[index] : (index === count - 1 ? frames - cursor : per)
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
  writeBuiltinAssets(dir)
  writeBundledFonts(dir)
  // 场景层脚手架：确定性随机 / 生长曲线 / 画面质感。拷进工程而不是 import 插件包，
  // 因为 Remotion 的 bundle 只解析工程目录里的相对路径。只在文件缺失时写。
  writeSceneKit(dir)
  // 交付级派生脚本（dist/ 下的母版与平台版）：平台规则会变，所以放在工程里。
  writeDelivery(dir)
  // 整片风格（mg-styles）：一是带上它的色板/字体当主题，二是把施工说明书落成 STYLE.md。
  // 显式给的主题优先于风格自带色板 —— 用户说"就要这个色"时不该被风格覆盖。
  const style = options.style && typeof options.style === 'object' ? options.style : null
  const theme = options.theme ? resolveTheme(options.theme) : style?.palette ? resolveTheme({ ...style.palette, name: style.name }) : null
  const fonts = { ...(style?.fonts ? { serif: style.fonts.display || style.fonts.text, sans: style.fonts.text || style.fonts.display, mono: style.fonts.mono } : {}), ...(options.fonts || {}) }
  if (theme) {
    writeTheme(dir, theme, fonts)
    options.themeName = theme.name
  }
  if (style) writeFileSync(join(dir, 'STYLE.md'), styleMarkdown(style), 'utf8')
  const cards = Array.isArray(options.cards) ? options.cards : []
  const storyRows = Array.isArray(options.storyboard) ? options.storyboard : []
  const warnings = []
  // 段数由谁决定，这里必须排个先后：给了分镜表就按表开段（这是"每一镜要干什么"的真相源），
  // 没给表才看卡片，都没有才用默认均分。旧版不看表，6 行分镜照样按 3 张卡开 4 段且不报错。
  const planned = cards.length
    ? timelineFromCards(spec, cards, { fitFrames: Number(options.fitFrames) || 0 })
    : storyRows.length >= 2
      ? timelineFromStoryboard(spec, storyRows)
      : defaultTimeline(spec, Number(options.segments) || 4)
  let timeline = existsSync(join(dir, TIMELINE))
    ? readTimeline(dir)
    : writeTimeline(dir, withStyle(planned, style))
  if (storyRows.length > 0 && timeline.shots.length !== storyRows.length) {    warnings.push('分镜表 ' + storyRows.length + ' 行，时间轴是 ' + timeline.shots.length + ' 段'
      + (cards.length ? '（按 ' + cards.length + ' 张镜头卡排布）' : '')
      + '：多出的分镜行不会自动开段。要么把表收敛到 ' + timeline.shots.length + ' 行，'
      + '要么把段数改到一致（加镜头卡 / 传 segments / 删掉已有 timeline.json 重建）')
  }
  if (storyRows.length >= 2 && !cards.length && timeline.durationInFrames !== spec.totalFrames) {
    warnings.push('分镜表共 ' + timeline.durationInFrames + ' 帧，视频节点是 ' + spec.totalFrames + ' 帧：时间轴按表走（'
      + (timeline.durationInFrames / spec.fps).toFixed(2) + ' 秒）。要按节点时长，就把表里的帧区间改到 ' + spec.totalFrames + ' 帧')
  }
  // 老工程后来才挂上风格节点：把风格补进时间轴，不改已排好的分镜。
  if (style && !timeline.style?.slug) timeline = writeTimeline(dir, withStyle(timeline, style))
  for (const shot of timeline.shots) {
    const file = join(dir, shot.file)
    if (!existsSync(file)) writeFileSync(file, sceneStub(shot, spec, theme), 'utf8')
  }
  // 分镜表：先把"每一镜要干什么"写成表，再动笔。表在工程里，不在对话里。
  const storyboard = normalizeStoryboard(options.storyboard, timeline)
  if (storyboard.length) writeFileSync(join(dir, 'storyboard.md'), storyboardMarkdown(timeline, storyboard), 'utf8')
  writeFileSync(join(dir, 'BRIEF.md'), brief(timeline, options, storyboard), 'utf8')
  // 主题与场景已经写出后，再按其中实际引用的字体补齐项目资源。
  writeBundledFonts(dir)
  return { dir, timeline, storyboard, theme: theme ? theme.name : null, files: listFiles(dir), warnings }
}

// 接受 [{card,intent,onScreen,copy}]，也接受 ["一句话"] 这种简写。
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
    }
  }).filter((row) => row.intent || row.onScreen || row.copy)
}

// 分镜表只在提供实际分镜内容时保存。
function storyboardMarkdown(timeline, storyboard) {
  const lines = [
    '# 分镜表',
    '',
    '每条视频先在表里写清"这一镜讲什么、屏幕上出现什么、配什么字"，再写场景代码。',
    '',
    '| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现 | 文案 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const [index, shot] of timeline.shots.entries()) {
    const row = storyboard.find((item) => item.shot === shot.id) || {}
    lines.push('| ' + shot.id + ' | ' + shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1) + ' | '
      + (row.card || shot.card || '—') + ' | ' + (row.intent || '—') + ' | ' + (row.onScreen || '—') + ' | ' + (row.copy || '—') + ' |')
  }
  return lines.join('\n') + '\n'
}

function brief(timeline, options, storyboard = []) {
  const lines = [
    '# 视频工程',
    '',
    '规格：' + timeline.width + '×' + timeline.height + ' / ' + timeline.fps + 'fps / ' + timeline.durationInFrames + ' 帧（' + (timeline.durationInFrames / timeline.fps).toFixed(2) + ' 秒）',
    '',
    '## 分镜',
    '',
    ...timeline.shots.map((shot) => '- ' + shot.id + '：第 ' + shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1) + ' 帧，文件 ' + shot.file
      + (shot.card ? '（镜头卡 ' + shot.card + (shot.style && shot.style !== shot.card ? ' · ' + shot.style : '') + '）' : '')),
    '',
    ...(storyboard.length ? ['## 分镜表', '', ...storyboard.map((row) => '- ' + row.shot + '：' + [row.intent, row.onScreen && '画面 ' + row.onScreen, row.copy && '文案 ' + row.copy].filter(Boolean).join('；')), ''] : []),
    '## 音频',
    '',
    describeTrack(readTrack(timeline), timeline.fps),
    '',
    '## 约定',
    '',
    '- 内置素材可用 motion_assets list 查看：builtin/paper.svg、builtin/grain.svg、builtin/grid.svg 可用 staticFile 引用；builtin/whoosh.wav、builtin/impact.wav 可通过 motion_audio add 加入时间轴。素材是 DrawAI 程序生成的通用素材，不是上游原片素材。',
    '- 工程内置 Noto Sans SC、Noto Serif SC 及常用上游字体，场景可按字体名使用；个别字体与上游特定字重可能仍需补充。',
    '- 需要纹理或乐器单音时，先看用户素材和 motion_assets {action:"list",nodeId}，再用 {action:"library",nodeId,query:"纸张"} 或 query:"钢琴" 搜索插件库；{action:"use",nodeId,assetId:id} 导入所选条目。图片用返回的 file 调 staticFile，声音须另用 motion_audio {action:"add",nodeId,file,role:"sfx",at:秒} 放入时间轴；先查看来源和许可，试听确认电平。单音不是完整配乐。',
    '- 插件素材随安装包提供，素材 ID 不是工作区路径。不要猜路径、从其他工程拷贝素材或手写 manifest.json；使用 library 返回的 ID 调 use，失败时报告具体错误。',
    '- 一场景一文件，单文件不超过 120 行；共享元素放 components/。',
    '- 场景组件 default export，签名 ({ shot, anchors, assets, render }) => ReactNode；时间用 useCurrentFrame()，相对本段起点。',
    '- scene-kit/ 是场景层脚手架：det.ts（确定性随机 + Halton 抖动，禁 Math.random）、grow.ts（弹簧/落体/生长曲线闭式解）、look.tsx（SSAA/软阴影/色调映射/颗粒/暗角）。要画质就先看这三件，别在场景里另写一套。',
    '- 累积采样数与快门时长从 render.samples / render.shutter 读，不要写死数字。',
    '- 改完先渲染 3 帧看图（motion_preview），确认后再跑全片（motion_render）。',
    options.themeName ? '- 配色主题：' + options.themeName + '（颜色/字体从 theme.ts 取，别手写十六进制）。' : '',
    timeline.style ? '- 整片风格：' + timeline.style.name + '（' + timeline.style.slug + '）—— 施工说明见 STYLE.md，写每一镜之前先读它。' : '',
    '- 时间轴改动只改 timeline.json 的 startFrame / durationFrames，不要改场景文件里的绝对帧号。',
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
      anchors: shot.anchors || {},
      sceneSource: readFileSync(file, 'utf8'),
    }
  })
  return {
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    bundledFonts: hasBundledFonts(dir),
    fontFaces: availableBundledFontFaces(dir),
    durationFrames: timeline.durationInFrames,
    shots,
    audio: readTrack(timeline),
    sync: timeline.sync,
    // 渲染规格随 composition 走：worker 拿它设编码参数，场景通过 props.render 拿采样数与快门。
    // 这里只透传时间轴上的值，默认值与夹取由 render-settings.js 统一决定。
    ...(timeline.render ? { render: timeline.render } : {}),
    // 风格跟着工程走：design.json 里能查到这条片子按哪份配方做的、色板与节奏是什么。
    ...(timeline.style ? { production: { mgStyle: timeline.style } } : {}),
  }
}

// 让 Remotion 认这个工程：入口 index.jsx + shotcraft 别名。
export function registerProject(dir) {
  writeBundledFonts(dir)
  const composition = buildComposition(dir)
  return prepareMotionProject(composition, dir, { preserveSources: true, refreshEntry: true })
}
