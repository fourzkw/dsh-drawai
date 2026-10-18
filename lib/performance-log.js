/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { cpus, totalmem } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createPerformanceMetrics } from './performance-metrics.js'

let environment
function environmentInfo() {
  if (!environment) {
    const cpu = cpus()
    let sourceSha256 = null
    try { sourceSha256 = createHash('sha256').update(['trace-image.js', 'raster.js', 'video-trace-worker.js', 'video-trace-pool.js', 'video-trace-reuse.js', 'video-export.js', 'video-export-worker.js']
      .map((file) => readFileSync(new URL(file, import.meta.url))).join('')).digest('hex') } catch {}
    environment = { node: process.version, platform: process.platform, arch: process.arch, cpu: cpu[0]?.model,
      logicalCpus: cpu.length, totalMemoryBytes: totalmem(), sourceSha256 }
  }
  return environment
}

// Diagnostics must never change the outcome of a drawing/export task.
export function createPerformanceLog(root, kind, metadata = {}, options = {}) {
  const enabled = options.enabled ?? process.env.DRAWAI_PERF === '1'
  const metrics = createPerformanceMetrics(), id = randomUUID(), startedAt = new Date().toISOString()
  const cpuStart = enabled ? process.cpuUsage() : null
  let finished = false, report = null, timer, delay
  function sample() {
    if (!enabled) return
    const memory = process.memoryUsage()
    metrics.peak('hostRssBytes', memory.rss); metrics.peak('hostHeapUsedBytes', memory.heapUsed)
  }
  if (enabled) {
    sample(); timer = setInterval(sample, 250); timer.unref?.()
    delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable()
  }
  return {
    enabled, id,
    start(name) { return enabled ? metrics.start(name) : () => {} },
    add(name, ms) { if (enabled) metrics.add(name, ms) },
    count(name, value) { if (enabled) metrics.count(name, value) },
    peak(name, value) { if (enabled) metrics.peak(name, value) },
    merge(prefix, value) { if (enabled) metrics.merge(prefix, value) },
    snapshot() { sample(); return enabled ? metrics.snapshot() : undefined },
    finish(status, extra = {}) {
      if (!enabled || finished) return report
      finished = true; clearInterval(timer); sample(); delay.disable()
      const cpu = process.cpuUsage(cpuStart)
      metrics.count('hostCpuUserMs', cpu.user / 1000); metrics.count('hostCpuSystemMs', cpu.system / 1000)
      if (Number.isFinite(delay.max)) metrics.peak('hostEventLoopDelayMaxMs', delay.max / 1e6)
      report = { schemaVersion: 1, id, kind, status, startedAt, environment: environmentInfo(), metadata: { ...metadata, ...extra }, ...metrics.snapshot(),
        resources: { intervalMs: 250, rssScope: 'sampled host process including Workers; excludes FFmpeg/browser',
          ffmpegPeakRssBytes: null, browserPeakRssBytes: null } }
      try {
        const dir = join(root, '.drawai-cache', 'performance')
        mkdirSync(dir, { recursive: true })
        const name = startedAt.replace(/[:.]/g, '-') + '-' + id + '.json', dest = join(dir, name)
        writeFileSync(dest + '.tmp', JSON.stringify(report, null, 2)); renameSync(dest + '.tmp', dest)
        // Keep at most 100 reports, never traverse media directories or retain source data.
        const names = readdirSync(dir).filter((entry) => /^\d{4}-.*-[0-9a-f-]{36}\.json$/.test(entry)).sort()
        for (const entry of names.slice(0, Math.max(0, names.length - 100))) rmSync(join(dir, entry), { force: true })
      } catch { /* Unwritable diagnostics are non-fatal. */ }
      return report
    },
  }
}
