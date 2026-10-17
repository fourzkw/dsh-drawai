import assert from 'node:assert/strict'
import { traceRasterToSvg, traceRasterForToolbar } from '../src/trace-image.js'

const darks = [[8, 8, 12], [28, 22, 20], [60, 35, 24], [83, 57, 39],
  [20, 28, 65], [30, 45, 96], [42, 62, 120], [50, 78, 145]]
const lights = [[140, 115, 80], [160, 135, 100], [180, 155, 120], [200, 175, 140],
  [220, 195, 160], [240, 215, 180], [255, 240, 220], [245, 245, 245]]
function patches(darkColors, lightColors) {
  const data = Buffer.alloc(128 * 64 * 4)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
    const colors = x < 64 ? darkColors : lightColors
    data.set([...colors[Math.floor(y / 8) % colors.length], 255], (y * 128 + x) * 4)
  }
  return { width: 128, height: 64, data }
}
const options = { colors: 12, removeBg: false, grid: 128, gridH: 64, scale: 1, minArea: 0, minRegionArea: 0 }
const raster = patches(darks, lights)
const rich = traceRasterToSvg(raster, options)
const flat = traceRasterToSvg(patches([darks[0]], lights), options)
assert.ok(rich.metrics.colorsDark > flat.metrics.colorsDark, 'richer dark hues receive more slots at identical dark area')
assert.equal(flat.metrics.colorsDark, 1, 'large flat black regions do not consume extra slots')
assert.equal(rich.metrics.colorsDark + rich.metrics.colorsFill, 12)
const fixed = traceRasterToSvg(raster, { ...options, colorsDark: 3 })
assert.equal(fixed.metrics.colorsDark, 3, 'explicit allocation remains supported')
assert.equal(traceRasterToSvg(raster, { ...options, colorsDark: 0 }).metrics.colorsDark, 0)
const nearestError = (result, color) => Math.min(...result.metrics.palette.map((hex) =>
  [1, 3, 5].reduce((sum, offset, i) => sum + (parseInt(hex.slice(offset, offset + 2), 16) - color[i]) ** 2, 0)))
assert.ok(nearestError(rich, darks[5]) < nearestError(fixed, darks[5]), 'dark blue survives instead of being merged into brown/black')
for (const preset of ['default', 'photo', 'lineart', 'simple']) {
  const toolbar = traceRasterForToolbar(raster, { colors: 12, level: 'high', preset, removeBg: false })
  assert.equal(toolbar.metrics.colorsDark + toolbar.metrics.colorsFill, 12)
}
assert.equal(traceRasterToSvg(patches(darks, darks), options).metrics.colorsDark, 12)
assert.equal(traceRasterToSvg(patches(lights, lights), options).metrics.colorsDark, 0)
assert.equal(traceRasterToSvg(raster, options).svg, rich.svg, 'allocation is deterministic')
console.log('check-adaptive-palette: OK (dark richness, blue fidelity, fixed budget, explicit overrides, presets and extremes)')
