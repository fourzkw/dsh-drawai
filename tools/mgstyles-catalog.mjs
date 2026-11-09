#!/usr/bin/env node
/**
 * 从 vendor 下来的 upstream（manifest.json + prompts/*.md）生成 catalog.json。
 *
 * catalog.json 是 mg_style 工具的检索索引：15 种整片风格，每种带展示名、一句话、
 * 关键词、色板（从提示词的 Creative seed 里抓真实 hex，不手写以免编造）、以及
 * upstream 里的提示词与 demo 路径。
 *
 * 用法：node tools/mgstyles-catalog.mjs
 * 输入：src/motion/mgstyles/upstream/{manifest.json,prompts/*.md}
 * 输出：src/motion/mgstyles/catalog.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const upstream = join(root, 'src', 'motion', 'mgstyles', 'upstream')

/** 展示名、关键词、一句话。色板不在这里写死 —— 从提示词里抓，避免编造颜色。 */
const META = {
  '01-flat-vector': {
    name: '扁平矢量',
    en: 'Flat / Vector 2D',
    oneLiner: '纯色块 + 几何图标 + 无描边的扁平 2D，企业解释片和产品介绍的主流语言。',
    tags: ['扁平', '矢量', '广告', '解释片', '插画', '企业', 'flat', 'vector', 'explainer', 'icon'],
  },
  '02-line-art': {
    name: '线条动画',
    en: 'Line Art',
    oneLiner: '单线描边逐笔生长，白底墨线，极简、克制、编辑感强。',
    tags: ['线条', '描边', '生长', '极简', '白场', '线稿', 'line', 'outline', 'stroke', 'draw-on'],
  },
  '03-isometric': {
    name: '等轴 2.5D',
    en: 'Isometric 2.5D',
    oneLiner: '30° 等轴测的场景与建筑体块，2.5D 空间里做流程与系统解释。',
    tags: ['等轴', '轴测', '2.5D', '场景', '建筑', '流程', 'isometric', 'axonometric', 'city', 'blockout'],
  },
  '05-cel-boil': {
    name: '逐帧手绘·线条沸腾',
    en: 'Cel / Line Boil',
    oneLiner: '手绘逐帧的不稳定线条与色块跳动，动画片的手作感。',
    tags: ['手绘', '逐帧', '线条沸腾', '抖动', '动画片', 'cel', 'boil', 'hand-drawn', 'frame-by-frame'],
  },
  '06-collage': {
    name: '拼贴剪贴',
    en: 'Collage / Cutout',
    oneLiner: '纸张、剪报、胶带、撕边拼贴，杂志编辑部的粗粝手感。',
    tags: ['拼贴', '剪纸', '剪报', '纸张', '胶带', '编辑', 'collage', 'cutout', 'zine', 'paper'],
  },
  '07-liquid': {
    name: '液态流动',
    en: 'Liquid Motion',
    oneLiner: '流体形变、金属液与粘稠拉伸，适合能量、声音、抽象的转换。',
    tags: ['液态', '流体', '形变', '金属', '粘稠', '抽象', 'liquid', 'fluid', 'gooey', 'metaball'],
  },
  '08-morph': {
    name: '形变动画',
    en: 'Morph',
    oneLiner: '一个形状连续变形成另一个，图标之间无缝过渡的转场语言。',
    tags: ['形变', '变形', '转场', '图标', '无缝', 'morph', 'shape', 'transition', 'icon'],
  },
  '09-bauhaus': {
    name: '几何构成·包豪斯',
    en: 'Bauhaus / Geometric',
    oneLiner: '红黄蓝三原色 + 基础几何 + 严格网格，节拍驱动的构成主义排版。',
    tags: ['包豪斯', '几何', '构成', '网格', '三原色', '印刷', '节拍', 'bauhaus', 'grid', 'swiss'],
  },
  '10-synthwave': {
    name: '80s 复古 / Y2K',
    en: 'Synthwave / Y2K',
    oneLiner: '霓虹网格、扫描线、铬金属字，80 年代与千禧年两套复古滤镜。',
    tags: ['复古', 'Synthwave', 'Y2K', '霓虹', '扫描线', '铬字', '蒸汽波', 'retro', 'vhs', 'chrome'],
  },
  '12-aurora-glass': {
    name: '弥散渐变·玻璃拟态',
    en: 'Aurora / Glassmorphism',
    oneLiner: '大面积弥散光晕 + 毛玻璃卡片，界面类与 AI 产品片的首选质感。',
    tags: ['渐变', '极光', '玻璃', '毛玻璃', '弥散', '光晕', 'UI', 'aurora', 'glass', 'gradient', 'blur'],
  },
  '18-hanazi': {
    name: '综艺花字',
    en: 'Variety Kinetic Captions',
    oneLiner: '综艺节目式的花字、描边、贴纸、弹跳强调，中文短视频的通用语法。',
    tags: ['综艺', '花字', '字幕', '贴纸', '描边', '弹跳', '短视频', 'variety', 'caption', 'kinetic-type'],
  },
  '19-paperclip': {
    name: '粗描边贴纸人科普',
    en: 'Sticker Explainer MG',
    oneLiner: '回形针/林超式的粗描边小人 + 大色块 + 手写字，中文科普 MG 的标准型。',
    tags: ['科普', '贴纸', '粗描边', '小人', '手写', '口播', 'paperclip', 'sticker', 'explainer'],
  },
  '20-pixel': {
    name: '像素风',
    en: 'Pixel Art / 8-bit',
    oneLiner: '低分辨率像素网格、限定色板、逐格动画，游戏与复古科技的语汇。',
    tags: ['像素', '8-bit', '游戏', '复古', '网格', 'pixel', 'retro-game', 'sprite'],
  },
  '22-hud': {
    name: '赛博 HUD / FUI',
    en: 'Cyberpunk HUD / FUI',
    oneLiner: '科幻界面式的刻线、数据流、扫描圈，虚构 UI 的信息密度。',
    tags: ['HUD', 'FUI', '科幻', '界面', '数据', '赛博', '扫描', 'cyberpunk', 'fictional-ui', 'telemetry'],
  },
  '23-ink-wash': {
    name: '水墨写意',
    en: 'Chinese Ink Wash / Xieyi',
    oneLiner: '宣纸为底、墨只加不铺：笔毛飞白写出窗竹猫人，墨分五色，留白靠挖，钤印收尾。',
    tags: ['水墨', '写意', '国风', '宣纸', '毛笔', '墨分五色', '留白', '八大山人', '齐白石', 'ink-wash', 'xieyi', 'chinese-ink'],
  },
}

/**
 * 每种风格的上游用的是哪个引擎 —— 这不是装饰信息，是移植的硬约束：
 * three.js 的片子不能拿 CSS 3D 假装，WebGL2 shader 不能拿 Canvas2D 渐变糊过去。
 * 声明在这里，generate 时用源码自动检测校验（声明与实测不符直接让构建失败）。
 */
const ENGINE = {
  '01-flat-vector': { engines: ['canvas2d'], note: '纯 Canvas2D 逐帧绘制：色块、图标、网点都在 2D 画布里画，没有 DOM 合成。' },
  '02-line-art': { engines: ['canvas2d'], note: 'Canvas2D 逐笔描边：线条按帧生长，纸面留白直接画在画布上。' },
  '03-isometric': { engines: ['three'], note: 'three.js WebGLRenderer + three/addons 后处理（UnrealBloom 辉光、阴影贴图），等轴场景是真 3D。' },
  '05-cel-boil': { engines: ['canvas2d'], note: 'Canvas2D 多缓冲逐帧重绘：线条抖动与曝光跳变靠每帧重画，不是滤镜。' },
  '06-collage': { engines: ['canvas2d'], note: 'Canvas2D 拼贴：纸张纹理、撕边、胶带都在 2D 画布里合成。' },
  '07-liquid': { engines: ['webgl2', 'canvas2d'], note: '原生 WebGL2 + GLSL 流体（engine.js 编译 shader、shaders.js 是片元源），文字用 Canvas2D 做 SDF。' },
  '08-morph': { engines: ['canvas2d'], note: 'Canvas2D 路径重采样：等点数轮廓逐点 lerp，中点必经圆形；变形是几何计算，不是形状补间滤镜。' },
  '09-bauhaus': { engines: ['webgl2', 'canvas2d'], note: 'Canvas2D 出分色版（knockout plates），再进 WebGL2 做印刷套色 pass —— 两段都要在。' },
  '10-synthwave': { engines: ['three'], note: 'three.js + EffectComposer 后处理（bloom、扫描线、色差），霓虹网格与铬字是真 3D 场景。' },
  '12-aurora-glass': { engines: ['webgl2'], note: '原生 WebGL2 极光 shader（preserveDrawingBuffer），弥散光晕是片元着色器算出来的。' },
  '18-hanazi': { engines: ['canvas2d'], note: 'Canvas2D 花字与贴纸：描边、弹跳、逐字错峰都在画布里画。' },
  '19-paperclip': { engines: ['canvas2d'], note: 'Canvas2D 粗描边小人：手写感靠逐帧画路径，不是字体排版。' },
  '20-pixel': { engines: ['webgl2', 'canvas2d'], note: 'Canvas2D 低分辨率索引帧（320×180 语义槽 → LUT）再进 WebGL2 做 CRT 扫描线/色差 pass；像素颗粒来自真实低分辨率，不是后加滤镜。' },
  '22-hud': { engines: ['three', 'canvas2d'], note: 'three.js 全息线框地球（holo.js）+ Canvas2D HUD 面板与数据流，3D 与 2D 两层叠加。' },
  '23-ink-wash': { engines: ['canvas2d'], note: '纯 Canvas2D：宣纸纤维、笔毛飞白、墨晕两遍 multiply 全在 2D 画布上画，没有 shader，也没有 DOM 或贴图合成。' },
}

/** 引擎检测：源码里真的出现才算，别信提示词自述。优先级 = 越"重"越靠前。 */
const ENGINE_SIGNALS = [
  ['three', /(?:from\s*|require\(\s*)['"]three(?:\/addons[^'"]*)?['"]|@remotion\/three/],
  ['webgl2', /getContext\(\s*['"]webgl2['"]|WebGL2RenderingContext/],
  ['webgl', /getContext\(\s*['"]webgl['"]/],
  ['canvas2d', /getContext\(\s*['"]2d['"]/],
  ['dom', /backdrop-filter|filter:\s*blur\(/],
]
const ENGINE_PRIORITY = ENGINE_SIGNALS.map(([engine]) => engine)

function detectEngines(style, upstream) {
  const hits = new Map()
  for (const demo of style.demos) {
    if (!/\.(m?js|html|css)$/i.test(demo)) continue
    const file = join(upstream, demo)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (text.length > 900000) continue
    for (const [engine, pattern] of ENGINE_SIGNALS) {
      if (!pattern.test(text)) continue
      if (!hits.has(engine)) hits.set(engine, [])
      const files = hits.get(engine)
      if (!files.includes(demo)) files.push(demo)
    }
  }
  return { engines: ENGINE_PRIORITY.filter((engine) => hits.has(engine)), files: hits }
}

/**
 * 动效画像：brief 能写清色板和判据，但写不清「怎么动」—— 转场是擦入还是硬切、
 * 落地有没有冲击环和相机抖、运动模糊几采样、颗粒是逐像素还是几百个点。
 * 这些从上游源码里抓，连同参考帧一起给模型，才有得对照。
 */
const MOTION_SIGNALS = [
  ['wipe', /cues\.wipes|function\s+drawFields|drawFields\s*\(|\bwipe\b/i],
  ['impact', /function\s+impact\b|impact\s*\(|\bhitStop\b/i],
  ['camera', /\bcamera\b|\bwhip\b|\bdolly\b|\bpushIn\b|\bshake\b/i],
  ['grain', /createImageData|\bgrain\b/i],
  ['secondary', /\bsteam\b|\bflap\b|heartbeat|\bpulse\b|\bsmear\b|\btrail\b|\bripple\b|\bbounce\b/i],
  ['feather', /\bFEATHER\b|\bfeather\b/i],
]

function detectMotion(style, upstream) {
  const hits = new Map()
  const files = new Set()
  let motionBlur = null
  let grainSize = null
  for (const demo of style.demos) {
    if (!/\.(m?js|html|css)$/i.test(demo)) continue
    const file = join(upstream, demo)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (text.length > 900000) continue
    const blur = text.match(/motionBlur\s*:\s*\{\s*samples\s*:\s*(\d+)\s*,\s*shutter\s*:\s*([\d.]+)/)
    if (blur && !motionBlur) motionBlur = { samples: Number(blur[1]), shutter: Number(blur[2]) }
    const grain = text.match(/grain\.width\s*=\s*grain\.height\s*=\s*(\d+)/)
    if (grain && !grainSize) grainSize = Number(grain[1])
    for (const [key, pattern] of MOTION_SIGNALS) {
      if (!pattern.test(text)) continue
      if (!hits.has(key)) hits.set(key, [])
      const list = hits.get(key)
      if (!list.includes(demo)) list.push(demo)
      files.add(demo)
    }
  }
  return {
    motionBlur,
    transitions: hits.has('wipe') ? 'wipe' : 'cut',
    impact: hits.has('impact'),
    camera: hits.has('camera'),
    grain: hits.has('grain') ? { size: grainSize } : null,
    secondary: ['steam', 'flap', 'heartbeat', 'pulse', 'smear', 'trail', 'ripple', 'bounce'].filter((key) => hits.has('secondary') && new RegExp(key, 'i').test(
      [...hits.get('secondary')].map((demo) => readFileSync(join(upstream, demo), 'utf8')).join('\n'),
    )),
    feather: hits.has('feather'),
    files: [...files].slice(0, 6),
  }
}

const hexLuma = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const hexSat = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  return mx === 0 ? 0 : (mx - mn) / mx
}

const mix = (a, b, u) => {
  const na = parseInt(a.slice(1), 16), nb = parseInt(b.slice(1), 16)
  const ch = (k) => Math.round((((na >> k) & 255) * (1 - u)) + (((nb >> k) & 255) * u))
  return '#' + [16, 8, 0].map((k) => ch(k).toString(16).padStart(2, '0')).join('')
}

/**
 * 色板不是手写的，是从「提示词 + demo 源码」里按出现频次统计出来的：
 * 用得最多的浅色当纸、最多的深色当墨、最饱和的那个当主色。这样至少不会编造颜色，
 * 而且大致反映了那一支片子的真实色彩密度。brief 里的色板表才是权威（有人校对过），
 * catalog 里的只作默认主题与检索提示。
 */
function paletteFrom(freq) {
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  const top = ranked.slice(0, 40)
  const paper = top.filter((c) => hexLuma(c) > 190).sort((a, b) => freq.get(b) - freq.get(a))[0] || ranked[0]
  const ink = top.filter((c) => hexLuma(c) < 80).sort((a, b) => freq.get(b) - freq.get(a))[0] || ranked[ranked.length - 1]
  const accent = top
    .filter((c) => c !== paper && c !== ink && hexSat(c) > 0.45 && hexLuma(c) > 36 && hexLuma(c) < 235)
    .sort((a, b) => freq.get(b) - freq.get(a))[0] || top.find((c) => c !== paper && c !== ink) || ink
  if (paper === ink) throw new Error('色板只统计出一个颜色')
  return {
    page: paper,
    surface: mix(paper, ink, 0.06),
    field: mix(paper, ink, 0.1),
    text: ink,
    muted: mix(ink, paper, 0.45),
    accent,
    border: mix(paper, ink, 0.22),
  }
}

const manifest = JSON.parse(readFileSync(join(upstream, 'manifest.json'), 'utf8'))
const styles = []

const collectHex = (text, freq) => {
  for (const m of text.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const c = m[0].toLowerCase()
    freq.set(c, (freq.get(c) || 0) + 1)
  }
}

for (const style of manifest.styles) {
  const meta = META[style.slug]
  if (!meta) throw new Error('catalog 缺展示名：' + style.slug)
  const prompt = readFileSync(join(upstream, style.prompt), 'utf8')

  // 颜色真身大多不在提示词里，在 demo 源码里；两边都统计，源码权重更高（出现多次即多计）。
  const freq = new Map()
  collectHex(prompt, freq)
  for (const demo of style.demos) {
    if (!/\.(m?js|json|html|css)$/i.test(demo)) continue
    const file = join(upstream, demo)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (text.length > 900000) continue
    collectHex(text, freq)
    collectHex(text, freq)
  }
  if (!freq.size) throw new Error('没找到任何颜色：' + style.slug)

  const palette = paletteFrom(freq)
  const colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) => c)

  // brief 作者校对过的色板/字体/节拍放在 catalog.d/<slug>.json 里，优先于统计值。
  const fragmentFile = join(root, 'src', 'motion', 'mgstyles', 'catalog.d', style.slug + '.json')
  const fragment = existsSync(fragmentFile) ? JSON.parse(readFileSync(fragmentFile, 'utf8')) : null
  if (fragment && fragment.slug && fragment.slug !== style.slug) throw new Error('fragment slug 不匹配：' + fragmentFile)

  // 一句话之外，再给一句「上游那一支在做什么」，取原片行
  const shot = (style.shot || '').replace(/\s+/g, ' ').trim()

  // 引擎声明 vs 源码实测：主引擎必须一致，声明的每个引擎都得在源码里找到证据。
  const engineSpec = ENGINE[style.slug]
  if (!engineSpec) throw new Error('catalog 缺引擎声明：' + style.slug)
  const detected = detectEngines(style, upstream)
  if (!detected.engines.length) throw new Error('没检测到任何引擎：' + style.slug)
  if (detected.engines[0] !== engineSpec.engines[0]) {
    throw new Error('引擎声明与源码不符：' + style.slug + ' 声明 ' + engineSpec.engines.join('/') + '，实测主引擎 ' + detected.engines[0])
  }
  for (const engine of engineSpec.engines) {
    if (!detected.engines.includes(engine)) throw new Error('引擎声明与源码不符：' + style.slug + ' 声明了 ' + engine + '，但源码里没有')
  }

  styles.push({
    slug: style.slug,
    name: (fragment && fragment.name) || meta.name,
    en: meta.en,
    heading: style.heading,
    oneLiner: (fragment && fragment.oneLiner) || meta.oneLiner,
    shot,
    tags: meta.tags,
    signature: (fragment && fragment.signature) || [],
    palette: (fragment && fragment.palette) || palette,
    paletteSource: fragment && fragment.palette ? 'brief' : 'auto',
    colors: (fragment && fragment.colors) || colors,
    fonts: (fragment && fragment.fonts) || null,
    rhythm: (fragment && fragment.rhythm) || null,
    prompt: 'prompts/' + style.slug + '.md',
    demos: style.demos.slice(),
    brief: 'briefs/' + style.slug + '.md',
    engine: engineSpec.engines[0],
    engines: engineSpec.engines.slice(),
    engineNote: engineSpec.note,
    engineFiles: [...new Set([...detected.files.values()].flat())].slice(0, 10),
    motion: detectMotion(style, upstream),
    // 不是从 mg-styles-15 来的（目前只有 23-ink-wash），署名另记，STYLE.md 会照着它写来源。
    origin: (manifest.origins && manifest.origins[style.slug]) || null,
  })
}

const total = (p) => (existsSync(join(upstream, p)) ? readFileSync(join(upstream, p), 'utf8').length : 0)

const catalog = {
  source: manifest.source,
  commit: manifest.commit,
  license: manifest.license,
  note: '整片风格库：15 种 MG 视觉语言，每种由一份上游提示词 + 一支上游成片源码 + 一份 Remotion 移植 brief 组成。上游的 04-3d-render（Blender 离线渲的 CGI 质感）没有收录，需要那种质感请走外部渲染回灌。',
  promptChars: total('template.md'),
  styles,
}

writeFileSync(join(root, 'src', 'motion', 'mgstyles', 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
console.log('catalog: ' + styles.length + ' styles, ' + (JSON.stringify(catalog).length / 1024).toFixed(1) + ' KB')
for (const s of styles) console.log('  ' + s.slug.padEnd(16) + s.name + '  ' + s.palette.accent + ' on ' + s.palette.page + '  colors=' + s.colors.length + '  engine=' + s.engines.join('+') + '  motion=' + [s.motion.transitions, s.motion.impact ? 'impact' : '', s.motion.camera ? 'camera' : '', s.motion.motionBlur ? s.motion.motionBlur.samples + 'x blur' : '', s.motion.grain ? 'grain' : ''].filter(Boolean).join(','))
