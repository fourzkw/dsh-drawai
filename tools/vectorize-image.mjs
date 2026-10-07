/**
 * 命令行入口：把一张位图矢量化成 SVG。
 *
 * 这个脚本**不再自己实现管线** —— 它只是 `src/trace-image.js` 的一层壳。
 * 为什么要这样：这里曾经有一份独立实现，于是"命令行跑出来的"和"插件跑出来的"
 * 是两份会各自漂移的代码（真实教训：一份把连接性写成了 4 连通、另一份 8 连通，
 * 同一张图给出两种调色板，排查花了很久）。现在核心只有一份，两处共用。
 *
 * 用法:
 *   node tools/vectorize-image.mjs --in <图片> --out-svg <输出.svg> [--out-preview <预览.png>]
 *        [--colors 12] [--grid 499] [--scale 1] [--epsilon 2] [--precision 1]
 *        [--min-area 10] [--bg-bright 238] [--bg-tol 10] [--seeds 3] [--budget 50000]
 *        [--out-style <输出.style.txt>] [--out-labels <标签图.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { decodeRaster } from '../src/raster.js'
import { TRACE_DEFAULTS, traceRasterToSvg, svgToImageValue } from '../src/trace-image.js'

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const IN = arg('in', null)
const OUT_SVG = arg('out-svg', null)
const OUT_PREVIEW = arg('out-preview', null)
const OUT_STYLE = arg('out-style', null)
const OUT_LABELS = arg('out-labels', null)
if (!IN || !OUT_SVG) {
  console.error('用法: node tools/vectorize-image.mjs --in <图片> --out-svg <输出.svg> [--out-preview <预览.png>]')
  process.exit(2)
}

const bytes = readFileSync(IN)
const t0 = Date.now()
const raster = await decodeRaster(bytes)
const decodeMs = Date.now() - t0
const t1 = Date.now()
const out = traceRasterToSvg(raster, {
  colors: Number(arg('colors', TRACE_DEFAULTS.colors)),
  grid: Number(arg('grid', TRACE_DEFAULTS.grid)),
  scale: Number(arg('scale', TRACE_DEFAULTS.scale)),
  epsilon: Number(arg('epsilon', TRACE_DEFAULTS.epsilon)),
  precision: Number(arg('precision', TRACE_DEFAULTS.precision)),
  minArea: Number(arg('min-area', TRACE_DEFAULTS.minArea)),
  bgBright: Number(arg('bg-bright', TRACE_DEFAULTS.bgBright)),
  bgTol: Number(arg('bg-tol', TRACE_DEFAULTS.bgTol)),
  seeds: Number(arg('seeds', TRACE_DEFAULTS.seeds)),
  maxBytes: Number(arg('budget', TRACE_DEFAULTS.maxBytes)),
  includeLabels: OUT_LABELS !== null,})
const traceMs = Date.now() - t1

const m = out.metrics
console.log(JSON.stringify({
  step: 'load', file: IN, source: m.source, work: m.work, decodeMs: decodeMs,
}))
console.log(JSON.stringify({
  step: 'trace', colors: m.palette.length, palette: m.palette, paths: m.paths, loops: m.loops,
  loopsKept: m.loopsKept, regions: m.regions, backgroundPixels: m.backgroundPixels,
  foregroundPixels: m.foregroundPixels, despeckle: m.despeckle, traceMs: traceMs,
}))
console.log(JSON.stringify({
  step: 'svg', chars: m.svgChars, budget: m.budget, attempts: m.attempts,
  drawnPixels: m.drawnPixels, totalPixels: m.totalPixels, exactPixelCoverage: m.exactPixelCoverage,
}))

writeFileSync(OUT_SVG, out.svg, 'utf8')
if (OUT_STYLE !== null) writeFileSync(OUT_STYLE, 'shape=image;imageAspect=0;image=' + svgToImageValue(out.svg), 'utf8')
if (OUT_LABELS !== null && out.labels !== null) writeFileSync(OUT_LABELS, JSON.stringify(out.labels), 'utf8')

// 自检：把 SVG 栅格化回原尺寸，跟原图逐像素比（需要工作区的 @resvg/resvg-js；没装就跳过）
if (OUT_PREVIEW !== null) {
  try {
    const req = createRequire(import.meta.url)
    const { Resvg } = req('@resvg/resvg-js')
    let sharp = null
    for (const spec of ['sharp', 'C:/Users/86476/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp']) {
      try {
        sharp = req(spec)
        break
      } catch (error) {
        sharp = null
      }
    }
    const png = new Resvg(out.svg, { fitTo: { mode: 'width', value: m.source.width } }).render().asPng()
    writeFileSync(OUT_PREVIEW, png)
    if (sharp !== null) {
      const got = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const ref = await sharp(IN, { failOn: 'none' }).ensureAlpha().raw().toBuffer()
      const n = Math.min(got.info.width * got.info.height, raster.width * raster.height)
      let sum = 0
      let far = 0
      for (let i = 0; i < n; i += 1) {
        const dr = got.data[i * 4] - ref[i * 4]
        const dg = got.data[i * 4 + 1] - ref[i * 4 + 1]
        const db = got.data[i * 4 + 2] - ref[i * 4 + 2]
        const d = Math.sqrt(dr * dr + dg * dg + db * db)
        sum += d
        if (d > 60) far += 1
      }
      console.log(JSON.stringify({
        step: 'selfcheck', previewPng: OUT_PREVIEW, size: [got.info.width, got.info.height],
        meanRgbDist: +(sum / n).toFixed(2), pctFarPixels: +((100 * far) / n).toFixed(2),
      }))
    } else {
      console.log(JSON.stringify({ step: 'selfcheck', previewPng: OUT_PREVIEW, note: '没装 sharp，只写出预览图、不算误差' }))
    }
  } catch (error) {
    console.log(JSON.stringify({ step: 'selfcheck', error: String((error && error.message) || error) }))
  }
}

console.log('OK ' + OUT_SVG)
