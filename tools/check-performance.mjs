import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createPerformanceMetrics, createMediaPerformance } from '../src/performance-metrics.js'
import { createPerformanceLog } from '../src/performance-log.js'
import { createVideoTracePool } from '../src/video-trace-pool.js'
import { traceRasterForToolbar } from '../src/trace-image.js'
import { decodeRaster } from '../src/raster.js'
import { fixtureCases, fixturePng } from './performance-fixtures.mjs'

let time = 0
const metrics = createPerformanceMetrics(() => time)
const end = metrics.start('decode'); time = 7; end(); time = 20; end()
metrics.add('decode', 3); metrics.count('frames', 2); metrics.peak('rss', 100); metrics.peak('rss', 50)
assert.deepEqual(metrics.snapshot().stages.decode, { count: 2, totalMs: 10, maxMs: 7 })
assert.equal(metrics.snapshot().wallMs, 20)
metrics.merge('browser.', { stages: { draw: { totalMs: 5, count: 2, maxMs: 3 }, bad: { totalMs: NaN, count: 1, maxMs: 1 } }, counters: { frames: 2 }, peaks: { rss: 20 } })
assert.deepEqual(metrics.snapshot().stages['browser.draw'], { count: 2, totalMs: 5, maxMs: 3 })
assert.equal(metrics.snapshot().stages['browser.bad'], undefined)
for (let i = 0; i < 1000; i++) metrics.add('test' + i, 1)
assert.equal(Object.keys(metrics.snapshot().stages).length, 96, 'memory does not grow per frame')
const snapshot = metrics.snapshot(); snapshot.stages.decode.totalMs = 999
assert.equal(metrics.snapshot().stages.decode.totalMs, 10)

const oldObserver = globalThis.PerformanceObserver
let disconnected = 0
globalThis.PerformanceObserver = class {
  observe() {} takeRecords() { return [{ duration: 60 }] } disconnect() { disconnected++ }
}
try {
  const browser = createMediaPerformance(); browser.enable(true)
  await assert.rejects(browser.measure('failedDecode', async () => { throw new Error('expected') }), /expected/)
  const report = browser.report(); browser.report()
  assert.equal(report.stages.failedDecode.count, 1)
  assert.equal(report.counters.longTasks, 1); assert.equal(disconnected, 1)
} finally { if (oldObserver === undefined) delete globalThis.PerformanceObserver; else globalThis.PerformanceObserver = oldObserver }

const root = mkdtempSync(resolve('_local/performance-test-'))
const pool = createVideoTracePool({ size: 1 })
try {
  const disabled = createPerformanceLog(root, 'disabled', {}, { enabled: false })
  disabled.start('work')(); disabled.finish('done')
  assert.equal(existsSync(join(root, '.drawai-cache')), false)
  const enabled = createPerformanceLog(root, 'test', { count: 2 }, { enabled: true })
  enabled.add('work', 7); enabled.merge('browser.', { stages: { draw: { totalMs: 9, count: 1, maxMs: 9 } } })
  const report = enabled.finish('done'); assert.equal(enabled.finish('failed'), report)
  const dir = join(root, '.drawai-cache', 'performance'), files = readdirSync(dir)
  assert.equal(files.length, 1)
  const saved = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
  assert.equal(saved.stages['browser.draw'].totalMs, 9)
  assert.ok(saved.peaks.hostRssBytes > 0)
  assert.equal(saved.resources.ffmpegPeakRssBytes, null)
  writeFileSync(join(root, 'blocked'), 'file')
  assert.doesNotThrow(() => createPerformanceLog(join(root, 'blocked'), 'test', {}, { enabled: true }).finish('failed'))
  const spec = fixtureCases()[3], png = fixturePng(spec, 0)
  assert.deepEqual(png, fixturePng(spec, 0), 'corpus generation is deterministic')
  assert.notDeepEqual(png, fixturePng(spec, 1), 'motion corpus changes between frames')
  const raster = await decodeRaster(png), options = { level: 'medium', colors: 6, removeBg: false, onlySelectedLevel: true }
  const stages = [], a = traceRasterForToolbar(raster, options), b = traceRasterForToolbar(raster, { ...options, onTiming: (name, ms) => { assert.ok(ms >= 0); stages.push(name) } })
  assert.equal(a.svg, b.svg, 'instrumentation preserves SVG output exactly')
  assert.deepEqual(stages.slice(0, 6), ['pixelProcessing', 'paletteQuantization', 'labelProcessing', 'contours', 'svgSerialization', 'metrics'])
  const jobs = Array.from({ length: 3 }, () => pool.run(png, { ...options, width: spec.width, height: spec.height, profile: true }))
  const results = await Promise.all(jobs)
  assert.ok(results[2].queueWaitMs > 0)
  assert.ok(results.every((result) => result.workerRoundTripMs > 0 && result.performance.stages.pngDecode.count === 1))
  assert.ok(results.every((result) => result.svg === a.svg))
  const image = await pool.run(png, { mode: 'image', profile: true, level: 'medium', colors: 6, removeBg: false })
  const fullImage = traceRasterForToolbar(raster, { level: 'medium', colors: 6, removeBg: false, includeDrawing: true })
  assert.equal(image.svg, fullImage.svg)
  assert.deepEqual(image.drawing, fullImage.drawing, 'image Workers preserve the complete analysis and drawing steps')
  assert.ok(image.performance.stages.pngDecode.count === 1, 'profiled image results cross the Worker boundary safely')
} finally { pool.close(); rmSync(root, { recursive: true, force: true }) }
console.log('check-performance: OK (bounded timing, browser cleanup, persistence, disabled/failure isolation, real Worker queue, identical SVG)')
