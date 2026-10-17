import { readFileSync } from 'node:fs'
import { fixturePng } from './performance-fixtures.mjs'
import { decodeRaster } from '../src/raster.js'

export async function traceEquivalenceCases() {
  const cases = []
  for (const pattern of ['static', 'motion', 'cuts', 'complex', 'transparent']) {
    const raster = await decodeRaster(fixturePng({ width: 48, height: 32, pattern }, 3))
    for (const preset of ['default', 'lineart', 'photo', 'simple']) for (const removeBg of [false, true]) {
      cases.push({ id: pattern + '-' + preset + '-' + removeBg, raster, options: { preset, removeBg, colors: 6, grid: 48, includeDrawing: true, includeLabels: true } })
    }
  }
  // Deterministic noisy RGB, repeated colors, gradients, transparent/partial-alpha edges.
  let seed = 23
  const raster = { width: 37, height: 29, data: Buffer.alloc(37 * 29 * 4) }
  for (let i = 0; i < raster.data.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; raster.data[i] = seed >>> 24 }
  for (const colors of [2, 12, 24]) for (const contrast of [0, 40, 255]) cases.push({ id: 'noise-' + colors + '-' + contrast, raster,
    options: { colors, removeBg: false, majorityContrast: contrast, includeDrawing: true, includeLabels: true, maxBytes: 6000 } })
  for (const name of ['image-trace-reference', 'image-trace-small-reference']) cases.push({ id: name, toolbar: true,
    raster: await decodeRaster(readFileSync(new URL('./fixtures/' + name + '.png', import.meta.url))),
    options: { preset: 'default', level: 'medium', colors: 6, removeBg: false, includeDrawing: true } })
  return cases
}
