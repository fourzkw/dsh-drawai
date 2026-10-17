// Paired same-process comparison avoids treating yesterday's CPU power state as a speedup.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import { fixturePng } from './performance-fixtures.mjs'
import { decodeRaster } from '../src/raster.js'
import * as current from '../src/trace-image.js'

const args = process.argv.slice(2), at = args.indexOf('--baseline')
if (at < 0 || !args[at + 1]) throw new Error('Provide --baseline <saved trace-image module>')
const baselinePath = resolve(args[at + 1]), baseline = await import(pathToFileURL(baselinePath).href)
const cases = []
for (const [pattern, width, height] of [['static', 854, 480], ['motion', 1920, 1080], ['complex', 854, 480], ['transparent', 854, 480]]) {
  cases.push({ id: pattern + '-' + height + 'p', raster: await decodeRaster(fixturePng({ pattern, width, height }, 3)),
    options: { preset: 'default', level: 'medium', colors: 6, removeBg: false, onlySelectedLevel: true, allowEmpty: true, maxLongSide: Math.max(width, height), maxBytes: 60000 } })
}
for (const name of ['image-trace-reference', 'image-trace-small-reference']) cases.push({ id: name,
  raster: await decodeRaster(readFileSync(new URL('./fixtures/' + name + '.png', import.meta.url))),
  options: { preset: 'default', level: 'medium', colors: 6, removeBg: false, includeDrawing: true } })
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summary = []
for (const item of cases) {
  console.log('paired comparison: ' + item.id)
  const hash = digest(baseline.traceRasterForToolbar(item.raster, item.options))
  assert.equal(digest(current.traceRasterForToolbar(item.raster, item.options)), hash, item.id + ' output changed')
  const times = { before: [], after: [] }
  for (let repeat = 0; repeat < 3; repeat++) for (const key of repeat % 2 ? ['after', 'before'] : ['before', 'after']) {
    globalThis.gc?.()
    const start = performance.now()
    const output = (key === 'before' ? baseline : current).traceRasterForToolbar(item.raster, item.options)
    times[key].push(performance.now() - start)
    assert.equal(digest(output), hash, 'paired output must remain exact')
  }
  const beforeMs = median(times.before), afterMs = median(times.after)
  summary.push({ case: item.id, beforeMs, afterMs, savedPercent: (1 - afterMs / beforeMs) * 100, samples: times, outputSha256: hash })
}
const root = resolve('.drawai-cache/trace-comparisons', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'summary.json'), JSON.stringify({ scope: 'paired sequential host algorithm; excludes browser, Worker transport and export',
  node: process.version, cpu: cpus()[0]?.model, explicitGcBetweenSamples: typeof globalThis.gc === 'function',
  beforeSourceSha256: digest(readFileSync(baselinePath, 'utf8')), afterSourceSha256: digest(readFileSync(new URL('../src/trace-image.js', import.meta.url), 'utf8')), summary }, null, 2))
console.table(summary.map((row) => ({ case: row.case, beforeMs: Math.round(row.beforeMs), afterMs: Math.round(row.afterMs), savedPercent: row.savedPercent.toFixed(1) })))
console.log('Report: ' + join(root, 'summary.json'))
