import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVideoTracePool } from '../src/video-trace-pool.js'
import { createVideoExportManager } from '../src/video-export.js'
import { createPerformanceLog } from '../src/performance-log.js'
import { ensureClipPack, writeManifest } from '../src/media.js'
import { fixtureCases, fixturePng } from './performance-fixtures.mjs'
import { decodeRaster } from '../src/raster.js'
import { traceRasterForToolbar } from '../src/trace-image.js'

const args = process.argv.slice(2)
function option(name, fallback) { const at = args.indexOf('--' + name); return at < 0 ? fallback : args[at + 1] }
const child = option('child', null)
function runNode(config) {
  return new Promise((resolveDone, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(config)], { windowsHide: true, stdio: 'inherit' })
    proc.on('error', reject); proc.on('close', (code) => code === 0 ? resolveDone() : reject(new Error('benchmark child exited ' + code)))
  })
}
if (child) {
  const config = JSON.parse(child), pool = createVideoTracePool()
  try {
    for (let repeat = 0; repeat < config.repeats; repeat++) {
      const root = join(config.root, config.mode + '-' + repeat), drawioAbs = join(root, 'benchmark.drawio')
      mkdirSync(root, { recursive: true })
      const frameCount = config.spec.count
      const identity = { caseId: config.spec.id, mode: config.mode, repeat, sourceSha256: config.digest,
        width: config.spec.width, height: config.spec.height, fps: config.spec.fps, count: frameCount,
        level: 'medium', colors: 6, preset: 'default', removeBg: false, poolSize: pool.size,
        scope: config.spec.image ? 'host full image analysis with drawing steps' : 'host worker PNG input, no browser seek/frame or palette reuse; export uses fixture PNGs, no SVG rasterization' }
      const perf = createPerformanceLog(root, config.spec.image ? 'benchmark-image' : 'benchmark-trace', identity, { enabled: true })
      try {
        if (config.spec.image) {
          const decodeDone = perf.start('sourceReadAndDecode')
          const raster = await decodeRaster(readFileSync(join(config.fixtureDir, '0.png')))
          decodeDone()
          const traceDone = perf.start('traceTotal')
          const result = traceRasterForToolbar(raster, { level: 'medium', preset: 'default', colors: 6, removeBg: false, includeDrawing: true,
            onTiming: (name, ms) => perf.add(name, ms) })
          traceDone(); perf.count('svgBytes', Buffer.byteLength(result.svg))
        } else {
        // Bounded in-flight window, matching the current browser's maximum depth.
        for (let first = 0; first < frameCount; first += pool.size) {
          await Promise.all(Array.from({ length: Math.min(pool.size, frameCount - first) }, async (_, at) => {
            const png = readFileSync(join(config.fixtureDir, (first + at) + '.png'))
            const result = await pool.run(png, { width: config.spec.width, height: config.spec.height,
              level: 'medium', preset: 'default', colors: 6, removeBg: false, maxBytes: 60000, profile: true })
            perf.add('workerQueueWait', result.queueWaitMs); perf.add('workerRoundTrip', result.workerRoundTripMs)
            perf.merge('worker.', result.performance); perf.count('frames'); perf.count('svgBytes', Buffer.byteLength(result.svg))
          }))
        }
        }
        perf.finish('done')
      } catch (error) { perf.finish('failed'); throw error }
      if (!config.traceOnly && !config.spec.image) {
        const pack = ensureClipPack(drawioAbs, 'fixture', { kind: 'svg', w: config.spec.width, h: config.spec.height, fps: config.spec.fps })
        writeManifest(pack.dir, { ...pack.manifest, frames: Array.from({ length: frameCount }, (_, i) => ({ file: 'frames/' + i + '.svg' })) })
        const manager = createVideoExportManager({ profile: true, metadata: identity }), scope = { sessionId: 'benchmark', drawioAbs, clip: 'fixture' }
        try {
          const job = await manager.start(scope, 'mp4')
          for (let index = 0; index < frameCount; index++) {
            const png = readFileSync(join(config.fixtureDir, index + '.png'))
            for (let offset = 0; offset < png.length; offset += 1024 * 1024) manager.chunk(scope, { token: job.token, index, offset, base64: png.subarray(offset, offset + 1024 * 1024).toString('base64') })
            manager.frame(scope, { token: job.token, index })
          }
          let state = manager.finish(scope, job.token)
          while (state.status === 'encoding') { await new Promise((done) => setTimeout(done, 25)); state = manager.status(scope, job.token) }
          if (state.status !== 'done') throw new Error(state.error)
          for (let offset = 0; offset < state.bytes;) offset += manager.read(scope, job.token, offset).bytes
          await manager.discard(scope, job.token)
        } finally { await manager.dispose() }
      }
      rmSync(join(root, 'benchmark.media'), { force: true, recursive: true })
    }
  } finally { pool.close() }
} else {
  const suite = option('suite', 'smoke'), repeats = Number(option('repeats', '3'))
  if (!Number.isSafeInteger(repeats) || repeats < 3 || repeats > 20) throw new Error('repeats must be 3–20')
  const root = resolve('.drawai-cache', 'benchmarks', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(root, { recursive: true })
  const selected = option('case', '').split(',').filter(Boolean)
  const images = []
  for (const name of ['image-trace-reference', 'image-trace-small-reference']) {
    const fixturePath = resolve('tools/fixtures', name + '.png'), raster = await decodeRaster(readFileSync(fixturePath))
    images.push({ id: name, fixturePath, image: true, width: raster.width, height: raster.height, count: 1 })
  }
  const cases = [...fixtureCases(suite), ...images].filter((spec) => !selected.length || selected.includes(spec.id)), traceOnly = args.includes('--trace-only')
  if (!cases.length) throw new Error('No matching fixture cases')
  const local = resolve('_local/bin/' + (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  const binary = process.env.DRAWAI_FFMPEG_PATH || (existsSync(local) ? local : 'ffmpeg')
  const version = spawnSync(binary, ['-version'], { windowsHide: true, encoding: 'utf8' })
  if ((!traceOnly || args.includes('--videos')) && version.status !== 0) throw new Error('FFmpeg unavailable; configure DRAWAI_FFMPEG_PATH or use --trace-only')
  const environment = { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), suite, repeats,
    ffmpeg: version.stdout?.split(/\r?\n/)[0] || null,
    sourceRevision: createHash('sha256').update(['src/trace-image.js', 'src/video-trace-worker.js', 'src/video-trace-pool.js', 'src/video-trace-reuse.js', 'src/video-export.js'].map((path) => readFileSync(path)).join('')).digest('hex') }
  writeFileSync(join(root, 'environment.json'), JSON.stringify(environment, null, 2))
  for (const spec of cases) {
    console.log('benchmark: ' + spec.id)
    const fixtureDir = join(root, 'fixtures', spec.id), hash = createHash('sha256')
    mkdirSync(fixtureDir, { recursive: true })
    for (let i = 0; i < spec.count; i++) { const png = spec.fixturePath ? readFileSync(spec.fixturePath) : fixturePng(spec, i); hash.update(png); writeFileSync(join(fixtureDir, i + '.png'), png) }
    const digest = hash.digest('hex'), base = { spec, fixtureDir, digest, traceOnly }
    writeFileSync(join(fixtureDir, 'manifest.json'), JSON.stringify({ ...spec, sha256: digest }, null, 2))
    if (args.includes('--videos') && !spec.image) {
      // These sources are for browser end-to-end measurements, outside host timing.
      const transparent = spec.pattern === 'transparent'
      const video = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(spec.fps), '-i', join(fixtureDir, '%d.png'),
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(spec.count / spec.fps),
        '-c:v', transparent ? 'libvpx-vp9' : 'libx264', '-pix_fmt', transparent ? 'yuva420p' : 'yuv420p',
        '-threads', '4', '-c:a', transparent ? 'libopus' : 'aac', join(fixtureDir, 'source.' + (transparent ? 'webm' : 'mp4'))], { windowsHide: true, encoding: 'utf8' })
      if (video.status !== 0) throw new Error(video.stderr || 'fixture encoding failed')
    }
    if (args.includes('--prepare-only')) continue
    for (let i = 0; i < repeats; i++) await runNode({ ...base, root: join(root, spec.id, 'cold-' + i), mode: 'cold', repeats: 1 })
    await runNode({ ...base, root: join(root, spec.id, 'warm'), mode: 'warm', repeats: repeats + 1 })
    // First warm run primes the pool; it is excluded from the comparison below.
  }
  const reports = []
  function scan(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) scan(path)
    else if (/\.json$/.test(entry.name) && dir.endsWith('performance')) reports.push(JSON.parse(readFileSync(path, 'utf8')))
  } }
  scan(root)
  const groups = new Map()
  for (const report of reports.filter((r) => r.status === 'done' && !(r.metadata.mode === 'warm' && r.metadata.repeat === 0))) {
    const key = [report.metadata.caseId, report.kind, report.metadata.mode].join(' / ')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(report)
  }
  const summary = [...groups].map(([key, runs]) => {
    function median(values) { const sorted = values.sort((a, b) => a - b), at = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2 }
    const times = runs.map((r) => r.wallMs).sort((a, b) => a - b), middle = Math.floor(times.length / 2)
    const medianMs = times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2
    return { key, runs: runs.length, medianMs, minMs: times[0], maxMs: times.at(-1),
      framesPerSecond: runs[0].metadata.count / (medianMs / 1000), sampledHostPeakRssBytes: Math.max(...runs.map((r) => r.peaks.hostRssBytes || 0)),
      stages: Object.fromEntries([...new Set(runs.flatMap((r) => Object.keys(r.stages)))].map((stage) => [stage, {
        medianTotalMs: median(runs.map((r) => r.stages[stage]?.totalMs || 0)), maxSampleMs: Math.max(...runs.map((r) => r.stages[stage]?.maxMs || 0)),
      }])) }
  })
  writeFileSync(join(root, 'summary.json'), JSON.stringify({ environment, summary }, null, 2))
  console.table(summary.map((row) => ({ case: row.key, runs: row.runs, medianMs: Math.round(row.medianMs), minMs: Math.round(row.minMs), maxMs: Math.round(row.maxMs), fps: row.framesPerSecond.toFixed(1) })))
  console.log('Report: ' + join(root, 'summary.json'))
}
