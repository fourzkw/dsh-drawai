/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
// Bounded aggregates shared by browser, host and Workers. Durations may overlap.
export function createPerformanceMetrics(clock = () => performance.now()) {
  const started = clock(), stages = Object.create(null), counters = Object.create(null), peaks = Object.create(null)
  function add(name, ms, count = 1, max = ms) {
    if (!/^[a-zA-Z][\w.-]{0,79}$/.test(name) || !Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(count) || count < 1 || !Number.isFinite(max) || max < 0) return
    if (!stages[name] && Object.keys(stages).length >= 96) return
    const stage = stages[name] || (stages[name] = { count: 0, totalMs: 0, maxMs: 0 })
    stage.count += count; stage.totalMs += ms; stage.maxMs = Math.max(stage.maxMs, max)
  }
  return {
    add,
    start(name) { const at = clock(); let ended = false; return () => { if (!ended) { ended = true; add(name, clock() - at) } } },
    count(name, value = 1) { if (/^[a-zA-Z][\w.-]{0,79}$/.test(name) && Number.isFinite(value) && value >= 0 && (name in counters || Object.keys(counters).length < 96)) counters[name] = (counters[name] || 0) + value },
    peak(name, value) { if (/^[a-zA-Z][\w.-]{0,79}$/.test(name) && Number.isFinite(value) && value >= 0 && (name in peaks || Object.keys(peaks).length < 32)) peaks[name] = Math.max(peaks[name] || 0, value) },
    merge(prefix, report) {
      // Only numeric, bounded aggregates cross the trust boundary; never copy raw objects/paths.
      for (const [name, stage] of Object.entries(report?.stages || {}).slice(0, 96)) {
        if (stage && typeof stage === 'object') add(prefix + name, stage.totalMs, stage.count, stage.maxMs)
      }
      for (const [name, value] of Object.entries(report?.counters || {}).slice(0, 96)) this.count(prefix + name, value)
      for (const [name, value] of Object.entries(report?.peaks || {}).slice(0, 32)) this.peak(prefix + name, value)
    },
    snapshot() { return JSON.parse(JSON.stringify({ wallMs: Math.max(0, clock() - started), stages, counters, peaks })) },
  }
}

export function createMediaPerformance() {
  const metrics = createPerformanceMetrics()
  let observer
  function accept(entries) {
    for (const entry of entries) { metrics.add('longTask', entry.duration); metrics.count('longTasks') }
  }
  return {
    ...metrics,
    enable(enabled) {
      if (!enabled || observer || typeof PerformanceObserver === 'undefined') return
      try { observer = new PerformanceObserver((list) => accept(list.getEntries())); observer.observe({ entryTypes: ['longtask'] }) }
      catch { observer?.disconnect(); observer = null }
    },
    async measure(name, action) { const done = metrics.start(name); try { return await action() } finally { done() } },
    report() {
      if (observer) { accept(observer.takeRecords()); observer.disconnect(); observer = null }
      return metrics.snapshot()
    },
  }
}
