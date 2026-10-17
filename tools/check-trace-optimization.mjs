import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { traceRasterForToolbar, traceRasterToSvg } from '../src/trace-image.js'
import { traceEquivalenceCases } from './trace-equivalence-cases.mjs'

// Golden hashes were captured from the P0 implementation before optimization.
const golden = JSON.parse(readFileSync(new URL('./fixtures/trace-before-p1.json', import.meta.url), 'utf8'))
let count = 0
for (const item of await traceEquivalenceCases()) {
  let output
  // Fixed allocation remains byte-for-byte compatible; adaptive allocation has
  // its own quality regressions because changing these palettes is intentional.
  try { output = (item.toolbar ? traceRasterForToolbar : traceRasterToSvg)(item.raster, { ...item.options, adaptiveDarkColors: false }) }
  catch (error) { output = { error: error.message, code: error.code } }
  const hash = createHash('sha256').update(JSON.stringify(output)).digest('hex')
  assert.equal(hash, golden[item.id], item.id + ': SVG, palette, labels, drawing steps and metrics must match P0 exactly')
  count++
}
assert.equal(count, Object.keys(golden).length)
console.log('check-trace-optimization: OK (' + count + ' P0 golden outputs, exact geometry/palette/labels/metrics)')
