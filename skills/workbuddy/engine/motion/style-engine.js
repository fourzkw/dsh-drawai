/**
 * 整片风格的「引擎契约」：上游那支片用什么引擎，移植就得用什么引擎。
 *
 * 为什么要有这个模块：风格最容易糊弄的地方不是配色，是「像不像那个引擎」——
 * three.js 的等轴城市用 CSS 3D 摆几个 div 也能骗过静帧，WebGL2 的流体用
 * Canvas2D 画几个渐变圆也能骗过一帧，但一动就露。所以：
 *   1. 建工程时把引擎写进 STYLE.md（硬规定 + 上游证据文件）；
 *   2. 渲染前扫工程源码，重引擎（three / webgl2 / webgl）缺了直接拒绝渲染；
 *   3. 确实要换实现，必须在 STYLE.md 留一行「偏离：引擎 …」，渲染照过但带 warning。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { checkFonts, sourceText } from './pixelqa.js'

export const ENGINE_LABEL = {
  three: 'three.js（WebGL）',
  webgl2: '原生 WebGL2',
  webgl: '原生 WebGL',
  canvas2d: 'Canvas 2D',
  dom: 'DOM / CSS',
}

export const ENGINE_GUIDANCE = {
  three: '在 <canvas> 里用 three 或 @remotion/three 真渲染：自建 WebGLRenderer、场景与相机，按 useCurrentFrame() 驱动 renderAt，后处理用 three/addons（UnrealBloomPass 等）。',
  webgl2: '起 canvas.getContext("webgl2")，把上游 GLSL（如 js/shaders.js）原样编译，按帧传 uniform；不要用 Canvas2D 渐变/模糊替代。',
  webgl: '起 canvas.getContext("webgl")，把上游 shader 原样编译，按帧传 uniform；不要用 Canvas2D 替代。',
  canvas2d: '用 canvas 2D 逐帧绘制（路径 / 贴图 / 像素读写），不要用 DOM 拼贴替代逐帧绘制。',
  dom: '用真实 DOM/CSS 合成（如多层 backdrop-filter 景深），不要用画布贴图或纯色块替代。',
}

/** 只在渲染前硬拦这三类：它们是「一眼能假、一动就露」的重引擎。 */
export const GATED_ENGINES = new Set(['three', 'webgl2', 'webgl'])

const SIGNALS = [
  ['three', /(?:from\s*|require\(\s*)['"]three(?:\/addons[^'"]*)?['"]|@remotion\/three/],
  ['webgl2', /getContext\(\s*['"]webgl2['"]|WebGL2RenderingContext/],
  ['webgl', /getContext\(\s*['"]webgl['"]/],
  ['canvas2d', /getContext\(\s*['"]2d['"]/],
  ['dom', /backdrop-filter|filter:\s*blur\(/],
]
const PRIORITY = SIGNALS.map(([engine]) => engine)
const TEXT_EXT = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.css', '.html', '.glsl', '.vert', '.frag', '.wgsl'])
const SKIP_DIR = new Set(['.out', 'node_modules', '.git'])

/** 单个文件文本里出现的引擎（按优先级）。 */
export function enginesOfText(text) {
  return PRIORITY.filter((engine) => SIGNALS.find(([name]) => name === engine)[1].test(text))
}

/** 扫整个工程（不含 .out / node_modules），返回用到的引擎与证据文件。 */
export function scanProjectEngines(dir) {
  const files = new Map()
  const walk = (base, prefix) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (SKIP_DIR.has(entry.name)) continue
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      const full = join(base, entry.name)
      if (entry.isDirectory()) { walk(full, rel); continue }
      if (!TEXT_EXT.has(extname(entry.name).toLowerCase())) continue
      if (statSync(full).size > 512 * 1024) continue
      const found = enginesOfText(readFileSync(full, 'utf8'))
      for (const engine of found) {
        if (!files.has(engine)) files.set(engine, [])
        if (!files.get(engine).includes(rel)) files.get(engine).push(rel)
      }
    }
  }
  walk(dir, '')
  return { engines: PRIORITY.filter((engine) => files.has(engine)), files }
}

/** STYLE.md 里显式记录的偏离行（playbook 的「偏离：X 改为 Y，因为 Z」同一套写法）。 */
export function engineDeviation(dir) {
  const file = join(dir, 'STYLE.md')
  if (!existsSync(file)) return null
  const line = readFileSync(file, 'utf8').split('\n').map((text) => text.trim().replace(/^[-*\s]+/, '')).find((text) => /^偏离：引擎/.test(text))
  return line ? line.trim().replace(/^[-*\s]+/, '') : null
}

function deviationLine(dir, pattern) {
  const file = join(dir, 'STYLE.md')
  if (!existsSync(file)) return null
  const line = readFileSync(file, 'utf8').split('\n').map((text) => text.trim().replace(/^[-*\s]+/, '')).find((text) => pattern.test(text))
  return line ? line.trim().replace(/^[-*\s]+/, '') : null
}

// 「有没有真的做」而不是「有没有写」：字体没注册、three 风格没有后处理链，
// 这两件事在源码里是有证据的，所以这里可以直接查，而不是再写一遍散文要求。
const POST_EVIDENCE = /SSAOPass|UnrealBloomPass|EffectComposer|@react-three\/postprocessing|BloomPass|GTAOPass|N8AO/
const ACCUM_EVIDENCE = /samples|shutter|jitter\(|halton\(|HalfFloatType/

/**
 * 渲染前的质量门禁：能拦的拦（字体），该喊的喊（后处理/累积缺席）。
 * 返回 {fonts, warnings}；字体缺失且没有偏离行 → 抛错。
 */
export function assertQualityEvidence(dir, style, options = {}) {
  const warnings = []
  const details = { warnings }
  const fonts = checkFonts(dir)
  details.fonts = { families: fonts.families, missing: fonts.missing, files: fonts.fontFiles }
  if (fonts.missing.length && options.fonts !== false) {
    const deviation = deviationLine(dir, /偏离：字体/)
    const preview = fonts.missing.slice(0, 6).map((item) => '  - ' + item.family + '（' + item.file + '）').join('\n')
    if (!deviation) {
      throw new Error('字体没注册，拒绝渲染：工程里声明了 ' + fonts.missing.length + ' 个字体，但没有对应的 @font-face / loadFont / 字体文件，\n'
        + '浏览器会悄悄退回系统字体，排版和字宽全变（这是最贵的降级，且不报错）。\n' + preview + '\n'
        + '修：把 OFL 字体放进 assets/ 并在场景里 loadFont()，或用 theme.ts 里已经注册的字体。\n'
        + '确实要用系统字体：在 STYLE.md 写一行「偏离：字体 …，因为 …」。')
    }
    warnings.push('字体未注册：' + fonts.missing.map((item) => item.family).join('、') + '；STYLE.md 已记录偏离：' + deviation.replace(/^偏离：/, ''))
  }
  const required = style && (Array.isArray(style.engines) && style.engines.length ? style.engines : [style.engine]).filter(Boolean)
  if (required && required.includes('three') && options.evidence !== false) {
    const text = sourceText(dir)
    if (!POST_EVIDENCE.test(text)) {
      const deviation = deviationLine(dir, /偏离：后处理/)
      if (deviation) warnings.push('three 风格没有后处理链；STYLE.md 已记录偏离：' + deviation.replace(/^偏离：/, ''))
      else warnings.push('three 风格里没检测到后处理（EffectComposer / SSAOPass / UnrealBloomPass）：斜边与接触阴影只能靠几何自带的明暗，'
        + '上游的 SSAO 与 bloom 溢出会缺席。要么接上，要么在 STYLE.md 写「偏离：后处理 …」')
    }
    if (!ACCUM_EVIDENCE.test(text)) {
      warnings.push('场景里没读到 samples / shutter / jitter：等轴斜边在 1× 下必然有阶梯，先按 render.samples 做同帧累积（scene-kit/look.tsx 里已有 SSAA）')
    }
  }
  return details
}

/**
 * 渲染前调用。返回 {gated, required, detected, missing, deviation, warning}；
 * 重引擎缺失且没有偏离记录 → 直接抛错（不渲染）。
 */
export function assertEngineFidelity(dir, style) {
  const required = style && (Array.isArray(style.engines) && style.engines.length ? style.engines : [style.engine]).filter(Boolean)
  if (!required || !required.length) return { gated: false, required: [], detected: [], missing: [], deviation: null, warning: '' }
  const heavy = required.filter((engine) => GATED_ENGINES.has(engine))
  if (!heavy.length) return { gated: false, required, detected: [], missing: [], deviation: null, warning: '' }
  const scan = scanProjectEngines(dir)
  const missing = heavy.filter((engine) => !scan.engines.includes(engine))
  const label = (engine) => ENGINE_LABEL[engine] || engine
  if (!missing.length) return { gated: true, required, detected: scan.engines, missing, deviation: null, warning: '' }
  const deviation = engineDeviation(dir)
  if (deviation) {
    return { gated: true, required, detected: scan.engines, missing,
      warning: '这个风格上游用 ' + heavy.map(label).join(' + ') + '，工程里没检测到 ' + missing.map(label).join(' + ') + '；STYLE.md 已记录偏离：' + deviation.replace(/^偏离：/, '') }
  }
  const evidence = (style.engineFiles || []).slice(0, 5).map((path) => '  - ' + path).join('\n')
  throw new Error('引擎不符合风格要求，拒绝渲染：' + (style.name || style.slug || '') + '（' + (style.slug || '?') + '）上游用 '
    + heavy.map(label).join(' + ') + '，但工程源码里没检测到 ' + missing.map(label).join(' + ') + '。\n'
    + '不要用 CSS 3D / div 层叠 / Canvas2D 渐变「简化」重引擎 —— 那正是这个风格的判据。\n'
    + heavy.map((engine) => '- ' + label(engine) + '：' + ENGINE_GUIDANCE[engine]).join('\n') + '\n'
    + (evidence ? '上游实现（用 wb style source --slug <slug> 读正文）：\n' + evidence + '\n' : '')
    + '确实要换实现：先在 STYLE.md 写一行「偏离：引擎 ' + heavy[0] + ' 改为 …，因为 …」，再渲染（会带 warning 通过）。')
}
