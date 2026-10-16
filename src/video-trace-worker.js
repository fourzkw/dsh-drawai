// 单帧复刻在独立线程计算；支持常驻消息循环（池）与一次性 workerData（兼容）。
import { parentPort, workerData } from 'node:worker_threads'
import { decodeRaster } from './raster.js'
import { traceRasterForToolbar } from './trace-image.js'

async function tracePng(png, rawOptions) {
  const raster = await decodeRaster(Buffer.from(png))
  const { width, height, ...options } = rawOptions
  if (raster.width !== width || raster.height !== height) throw new Error('帧尺寸与任务不一致')
  const result = traceRasterForToolbar(raster, { ...options, allowEmpty: true, onlySelectedLevel: true,
    maxLongSide: Math.max(width, height) })
  const hexes = Array.isArray(result.metrics.palette) ? result.metrics.palette : []
  const used = options.removeBg ? hexes.slice(1) : hexes
  const palette = used.map((hex) => {
    const h = String(hex).replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }).filter((rgb) => rgb.length === 3 && rgb.every((n) => Number.isInteger(n)))
  return { ok: true, svg: result.svg, detailReduced: result.metrics.detailReduced, work: result.metrics.work, palette }
}

async function handle(message) {
  try {
    const result = await tracePng(message.png, message.options)
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
