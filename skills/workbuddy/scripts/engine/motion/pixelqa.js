// 像素级画质检查：色带、抗锯齿、字体注册。
//
// 为什么要有：帧检（qa.js）看的是「有没有黑场 / 静止 / 越界」，回答不了
// 「这张脸是不是糊的」。而画质退化的两种最典型形态恰好都在像素层面：
//   1. 柔和渐变在 8bit 量化后裂成一级级的色带（淡紫底最容易中招）；
//   2. 斜边没有抗锯齿，等轴场景的 30°/60° 边全成了台阶。
// 两者都要 1:1 的像素才能判，所以这里直接从成片里抠原始灰度字节来算，
// 不引入 sharp/jimp 之类的依赖（插件只有 ffmpeg）。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { runFfmpeg } from './ffmpeg.js'

const clampInt = (value, low, high) => Math.min(Math.max(Math.round(Number(value) || 0), low), high)

async function rawGray({ source, work, time, crop, name, timeoutMs }) {
  const out = join(work, name + '.raw')
  const filter = 'crop=' + crop.w + ':' + crop.h + ':' + crop.x + ':' + crop.y + ',format=gray'
  await runFfmpeg(['-ss', String(Math.max(0, time)), '-i', source, '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', out],
    { cwd: work, log: name + '.log', timeoutMs: timeoutMs || 120000 })
  if (!existsSync(out)) throw new Error('取不到像素：' + name)
  return readFileSync(out)
}

// 色带：把一行像素切成「等值段」，再看是否出现连续多段、每段都不短、
// 且相邻段只差 1–2 级的「阶梯」。平涂色块是单段，真实渐变是长段少级差
// （有抖动时会被打碎），只有量化后的渐变才会长成 8px 以上、连十几段的梯子。
function staircase(row) {
  const runs = []
  for (let i = 0; i < row.length;) {
    let end = i + 1
    while (end < row.length && row[end] === row[i]) end += 1
    runs.push({ value: row[i], length: end - i })
    i = end
  }
  let longest = 0
  let steps = 0
  let current = 0
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]
    const here = runs[index]
    const delta = Math.abs(here.value - previous.value)
    const flatEnough = previous.length >= 6 && previous.length <= 400 && here.length >= 6 && here.length <= 400
    if (delta >= 1 && delta <= 2 && flatEnough) {
      current = current ? current + 1 : 2
      longest = Math.max(longest, current)
      steps += 1
    } else current = 0
  }
  return { longest, steps, runs: runs.length }
}

function sobelRatio(bytes, width, height) {
  let mid = 0
  let strong = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const gx = -bytes[i - width - 1] - 2 * bytes[i - 1] - bytes[i + width - 1]
        + bytes[i - width + 1] + 2 * bytes[i + 1] + bytes[i + width + 1]
      const gy = -bytes[i - width - 1] - 2 * bytes[i - width] - bytes[i - width + 1]
        + bytes[i + width - 1] + 2 * bytes[i + width] + bytes[i + width + 1]
      const magnitude = (Math.abs(gx) + Math.abs(gy)) / 4
      if (magnitude > 60) strong += 1
      else if (magnitude > 8) mid += 1
    }
  }
  const edge = mid + strong
  return edge ? mid / edge : null
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'cursive', 'fantasy', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', 'revert'])
const SOURCE_EXT = new Set(['.tsx', '.ts', '.jsx', '.js', '.css'])

function readSources(dir, depth = 0) {
  const out = []
  if (depth > 3) return out
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.out' || entry.name === 'assets') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...readSources(full, depth + 1)); continue }
    if (!SOURCE_EXT.has(extname(entry.name))) continue
    try {
      const text = readFileSync(full, 'utf8')
      if (text.length < 400000) out.push({ file: full, text })
    } catch { /* 读不了就跳过 */ }
  }
  return out
}

// 字体：场景里 declare 了一个字体，但工程没有 @font-face / loadFont / 字体文件，
// 浏览器就悄悄退回系统字体 —— 排版、字宽、甚至换行全变，这是最贵的降级。
// 给风格门禁用：把工程源码拼成一段文本，扫「有没有真的做后处理/累积」。
export function sourceText(dir, limit = 800000) {
  let text = ''
  for (const source of readSources(dir)) {
    text += '\n/* ' + source.file + ' */\n' + source.text
    if (text.length > limit) break
  }
  return text
}

export function checkFonts(dir) {
  const sources = readSources(dir)
  const familyPattern = /(?:fontFamily|font-family)\s*[:=]\s*['"`]([^'"`]+)['"`]|(?:loadFont|FontFace)\(\s*['"`]([^'"`]+)['"`]/g
  const declared = new Set()
  const registered = new Set()
  const facePattern = /@font-face\s*\{([\s\S]*?)\}/g
  const faceFamily = /font-family\s*:\s*['"]?([^'";}]+)/i
  for (const { text } of sources) {
    for (const match of text.matchAll(facePattern)) {
      const family = faceFamily.exec(match[1])
      if (family) registered.add(family[1].trim().toLowerCase())
    }
    for (const match of text.matchAll(/(?:loadFont|FontFace)\(\s*['"`]([^'"`]+)['"`]/g)) registered.add(match[1].trim().toLowerCase())
  }
  // 字体文件也可以直接说明「这个 family 是有的」：按去符号后的名字做包含匹配。
  let fontFiles = []
  const walk = (base, depth) => {
    if (depth > 2) return
    let entries = []
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(base, entry.name)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(entry.name)) fontFiles.push(entry.name.toLowerCase())
    }
  }
  walk(join(dir, 'assets'), 0)
  walk(dir, 0)
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

  for (const { file, text } of sources) {
    for (const match of text.matchAll(familyPattern)) {
      const family = (match[1] || match[2] || '').trim()
      if (!family) continue
      for (const single of family.split(',')) {
        const name = single.trim().replace(/^['"`]|['"`]$/g, '').trim()
        if (!name) continue
        // 模板字面量（`${FAMILY}`）、CSS 变量、继承关键字都不是字体名：
        // 把它们当"没注册的字体"会让字体门禁误拒，实测踩过。
        if (/[${}()]/.test(name) || /^(?:inherit|initial|unset|revert|var|ui-)\b/i.test(name)) continue
        const lower = name.toLowerCase()
        if (GENERIC_FAMILIES.has(lower)) continue
        declared.add(JSON.stringify({ name, file }))
      }
    }
  }
  const missing = []
  const families = []
  for (const entry of declared) {
    const { name, file } = JSON.parse(entry)
    const lower = name.toLowerCase()
    if (families.includes(lower)) continue
    families.push(lower)
    const known = registered.has(lower) || fontFiles.some((font) => normalize(font).includes(normalize(name)) || normalize(name).includes(normalize(font.replace(/\.[a-z0-9]+$/, ''))))
    if (!known) missing.push({ family: name, file })
  }
  return { families, missing, fontFiles, registered: [...registered] }
}

export async function pixelQuality({ source, work, timeline, dir, samples = 3, timeoutMs }) {
  const width = Number(timeline?.width) || 1920
  const height = Number(timeline?.height) || 1080
  const fps = Number(timeline?.fps) || 30
  const total = Number(timeline?.durationInFrames) || 300
  const points = []
  for (let index = 0; index < Math.max(1, samples); index += 1) {
    const fraction = samples <= 1 ? 0.5 : 0.2 + (0.65 * index) / (samples - 1)
    points.push(Math.min(total - 1, Math.max(0, Math.floor(total * fraction))) / fps)
  }
  const banding = []
  for (const [index, time] of points.entries()) {
    for (const fraction of [0.18, 0.5, 0.82]) {
      const y = clampInt(height * fraction, 0, height - 1)
      const row = await rawGray({ source, work, time, crop: { x: 0, y, w: width, h: 1 }, name: 'band-' + index + '-' + Math.round(fraction * 100), timeoutMs })
      banding.push({ time: Math.round(time * 100) / 100, y, ...staircase(row) })
    }
  }
  const bandingWorst = banding.reduce((worst, item) => (item.longest > (worst?.longest || 0) ? item : worst), null)
  const aa = []
  for (const [index, time] of points.entries()) {
    const size = Math.min(480, width, height)
    const crop = { x: clampInt((width - size) / 2, 0, width - size), y: clampInt((height - size) / 2, 0, height - size), w: size, h: size }
    const bytes = await rawGray({ source, work, time, crop, name: 'aa-' + index, timeoutMs })
    aa.push({ time: Math.round(time * 100) / 100, midRatio: sobelRatio(bytes, crop.w, crop.h) })
  }
  const ratios = aa.map((item) => item.midRatio).filter((value) => value !== null)
  const aaAverage = ratios.length ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : null
  return {
    banding: { samples: banding, worst: bandingWorst },
    aa: { samples: aa, average: aaAverage === null ? null : Math.round(aaAverage * 1000) / 1000 },
    fonts: dir ? checkFonts(dir) : { families: [], missing: [], fontFiles: [] },
  }
}
