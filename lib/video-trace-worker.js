/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
// 单帧复刻在独立线程计算；支持常驻消息循环（池）与一次性 workerData（兼容）。
import { parentPort, workerData } from 'node:worker_threads'
import { decodeRaster } from './raster.js'
import { traceRasterForToolbar, traceRasterToSvg } from './trace-image.js'
import { createPerformanceMetrics } from './performance-metrics.js'
import { checkVideoPalette } from './video-trace-reuse.js'

async function tracePng(png, rawOptions, rawRaster) {
  const timing = rawOptions.profile === true ? createPerformanceMetrics() : null
  const decodeDone = timing?.start('pngDecode')
  const raster = rawRaster || await decodeRaster(Buffer.from(png))
  decodeDone?.()
  if (raster.width * raster.height > 16000000) throw new Error('图片超过 1600 万像素，请先缩小图片')
  if (raster.data.length !== raster.width * raster.height * 4) throw new Error('原始像素长度无效')
  if (rawOptions.mode === 'raw-image') return { ok: true, ...traceRasterToSvg(raster, rawOptions) }
  if (rawOptions.mode === 'image') {
    const result = traceRasterForToolbar(raster, { ...rawOptions, includeDrawing: true,
      onTiming: timing ? (name, ms) => timing.add(name, ms) : undefined })
    return { ok: true, ...result, rasterSize: { width: raster.width, height: raster.height },
      ...(timing ? { performance: timing.snapshot() } : {}) }
  }
  const { width, height, ...options } = rawOptions
  if (raster.width !== width || raster.height !== height) throw new Error('帧尺寸与任务不一致')
  let paletteCheck = null
  const result = traceRasterForToolbar(raster, { ...options, allowEmpty: true, onlySelectedLevel: true,
    paletteValidator: (work, foreground, palette) => {
      const checked = timing?.start('paletteValidation')
      paletteCheck = checkVideoPalette(work, foreground, palette)
      checked?.()
      return paletteCheck.accepted
    },
    onTiming: timing ? (name, ms) => timing.add(name, ms) : undefined,
    maxLongSide: Math.max(width, height) })
  const hexes = Array.isArray(result.metrics.palette) ? result.metrics.palette : []
  const used = options.removeBg ? hexes.slice(1) : hexes
  const palette = used.map((hex) => {
    const h = String(hex).replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }).filter((rgb) => rgb.length === 3 && rgb.every((n) => Number.isInteger(n)))
  return { ok: true, svg: result.svg, detailReduced: result.metrics.detailReduced, work: result.metrics.work, palette,
    paletteShared: paletteCheck?.accepted === true, paletteReuseReason: paletteCheck?.reason || 'fresh-palette',
    ...(timing ? { performance: timing.snapshot() } : {}) }
}

async function handle(message) {
  try {
    const result = await tracePng(message.png, message.options, message.raster)
    parentPort.postMessage(Object.assign({ id: message.id }, result))
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error.message || String(error) })
  }
}

if (workerData && workerData.png) {
  handle({ id: 0, png: workerData.png, options: workerData.options }).catch((error) => {
    parentPort.postMessage({ id: 0, ok: false, error: error.message || String(error) })
  })
} else {
  parentPort.on('message', (message) => { handle(message) })
}
