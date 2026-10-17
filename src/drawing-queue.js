// Application-lifetime scheduler. A paused video yields only after in-flight frames drain.
export function createDrawingQueue(options = {}) {
  const jobs = [], listeners = new Set(), pausedSessions = new Set()
  let sequence = 0
  const id = options.id || (() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return 'draw-' + Date.now().toString(36) + '-' + (++sequence).toString(36) + '-' + Math.random().toString(36).slice(2)
  })
  let active = null, disposed = false, scheduled = false, progressTimer = null, lastProgress = 0
  const scopeKey = (scope) => JSON.stringify([scope.sessionId || '', scope.path, scope.page])
  const terminal = (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status)
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const view = (job) => ({ id: job.id, scope: job.scope, kind: job.kind, label: job.label, options: job.options,
    sourceId: job.source.id, status: job.status, done: job.done, total: job.total, message: job.message, error: job.error,
    pauseRequested: job.pauseRequested, createdAt: job.createdAt })
  function notify() { for (const fn of listeners) { try { fn() } catch {} } }
  function emit(immediate = true) {
    if (immediate || Date.now() - lastProgress >= 250) {
      clearTimeout(progressTimer); progressTimer = null; lastProgress = Date.now(); notify()
    } else if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = null; lastProgress = Date.now(); notify() }, 250)
  }
  function blocked(job) {
    return jobs.some((other) => other !== job && scopeKey(other.scope) === scopeKey(job.scope) &&
      (['ready_to_apply', 'applied'].includes(other.status) || (other.started && !other.settled)))
  }
  function schedule() {
    if (disposed || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; pump() })
  }
  function check(job) { if (disposed || job.control.signal.aborted) throw new Error('已取消绘制') }
  async function checkpoint(job) {
    check(job)
    if (!job.pauseRequested) return
    job.pauseRequested = false; job.status = 'paused'
    if (active === job) active = null
    emit(); schedule()
    await new Promise((resolve, reject) => {
      const cancelled = () => { job.resumeRun = null; reject(new Error('已取消绘制')) }
      job.control.signal.addEventListener('abort', cancelled, { once: true })
      job.resumeRun = () => { job.control.signal.removeEventListener('abort', cancelled); job.resumeRun = null; resolve() }
      if (job.control.signal.aborted) cancelled()
    })
    check(job)
  }
  function pump() {
    if (disposed || active) return
    const job = jobs.find((item) => item.status === 'queued' && !pausedSessions.has(item.scope.sessionId || '') && !blocked(item))
    if (!job) return
    active = job; job.status = 'running'; job.started = true; emit()
    if (job.resumeRun) { job.resumeRun(); return }
    const context = {
      id: job.id, signal: job.control.signal,
      get pauseRequested() { return job.pauseRequested },
      checkpoint: () => checkpoint(job),
      update(patch) { if (job.control.signal.aborted) return; for (const key of ['done', 'total', 'message']) if (key in patch) job[key] = patch[key]; emit(false) },
      ready() { check(job); job.status = 'ready_to_apply'; emit() },
    }
    Promise.resolve().then(() => { check(job); return job.run(context, job.source, job.options) }).then(() => {
      if (job.control.signal.aborted) job.status = 'cancelled'
      else if (job.status === 'running') job.status = 'succeeded'
    }, (error) => {
      job.status = job.control.signal.aborted ? 'cancelled' : 'failed'
      job.error = job.status === 'failed' ? String(error.message || error) : ''
    }).finally(() => { job.settled = true; if (active === job) active = null; emit(); schedule() })
  }
  function enqueue(input, run) {
    if (disposed) throw new Error('绘制队列已关闭')
    const data = clone(input)
    data.scope.sessionId = data.scope.sessionId || ''
    const key = JSON.stringify(data)
    const duplicate = jobs.find((job) => job.key === key && !terminal(job))
    if (duplicate) return view(duplicate)
    if (jobs.filter((job) => !terminal(job)).length >= 16) throw new Error('绘制队列已满（最多 16 个未完成任务）')
    const bytes = JSON.stringify(data.source).length
    if (jobs.reduce((sum, job) => sum + job.sourceBytes, bytes) > 64 * 1024 * 1024) throw new Error('排队素材占用过大，请先完成或移除部分任务')
    const job = { ...data, scope: Object.freeze(data.scope), source: Object.freeze(data.source), options: Object.freeze(data.options),
      id: id(), key, run, sourceBytes: bytes, control: new AbortController(), status: 'queued', done: 0, total: 1, message: '等待绘制', error: '', createdAt: Date.now(), pauseRequested: false }
    jobs.push(job)
    for (const old of jobs.filter(terminal).slice(0, Math.max(0, jobs.filter(terminal).length - 12))) jobs.splice(jobs.indexOf(old), 1)
    emit(); schedule(); return view(job)
  }
  return {
    enqueue,
    list(sessionId) { return jobs.filter((job) => sessionId === undefined || job.scope.sessionId === (sessionId || '')).map(view) },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    isPaused(sessionId) { return pausedSessions.has(sessionId || '') },
    pauseQueue(sessionId, paused) { if (paused) pausedSessions.add(sessionId || ''); else pausedSessions.delete(sessionId || ''); emit(); schedule() },
    pause(jobId) { const job = jobs.find((job) => job.id === jobId); if (!job) return
      if (job.status === 'queued') job.status = 'paused'
      else if (job.status === 'running' && job.kind === 'video') job.pauseRequested = true
      emit() },
    resume(jobId) { const job = jobs.find((job) => job.id === jobId); if (job?.status === 'paused') { job.status = 'queued'; emit(); schedule() } },
    cancel(jobId) { const job = jobs.find((job) => job.id === jobId); if (!job || terminal(job) || ['ready_to_apply', 'applied'].includes(job.status)) return
      job.status = active === job ? 'cancelling' : 'cancelled'; job.control.abort(); emit(); schedule() },
    move(jobId, direction) { const at = jobs.findIndex((job) => job.id === jobId); if (at < 0 || jobs[at].status !== 'queued') return
      const job = jobs[at], waiting = jobs.filter((item) => item.status === 'queued' && item.scope.sessionId === job.scope.sessionId), target = waiting[waiting.indexOf(job) + direction]
      if (!target) return
      const to = jobs.indexOf(target); jobs.splice(at, 1); jobs.splice(to, 0, job); emit(); schedule() },
    retry(jobId) { const job = jobs.find((job) => job.id === jobId); if (!job || !['failed', 'cancelled'].includes(job.status)) return
      return enqueue({ scope: job.scope, kind: job.kind, label: job.label, source: job.source, options: job.options }, job.run) },
    applied(jobId) { const job = jobs.find((job) => job.id === jobId); if (job?.status === 'ready_to_apply') { job.status = 'applied'; job.error = ''; emit() } },
    restore(jobId) { const job = jobs.find((job) => job.id === jobId); if (job?.status === 'applied') { job.status = 'ready_to_apply'; emit() } },
    resultError(jobId, error) { const job = jobs.find((job) => job.id === jobId); if (job && ['ready_to_apply', 'applied'].includes(job.status)) { job.error = String(error.message || error); emit() } },
    discardReady(jobId) { const job = jobs.find((job) => job.id === jobId); if (job?.status === 'ready_to_apply') { job.status = 'cancelled'; emit(); schedule() } },
    saved(jobId) { const job = jobs.find((job) => job.id === jobId); if (job && ['ready_to_apply', 'applied'].includes(job.status)) { job.status = 'succeeded'; job.error = ''; emit(); schedule() } },
    remove(jobId) { const at = jobs.findIndex((job) => job.id === jobId); if (at >= 0 && terminal(jobs[at])) { jobs.splice(at, 1); emit() } },
    closeScope(sessionId, path) { for (const job of jobs) if (job.scope.sessionId === (sessionId || '') && job.scope.path === path && !terminal(job)) {
      job.control.abort(); job.status = active === job ? 'cancelling' : 'cancelled'
    } emit(); schedule() },
    dispose() { disposed = true; clearTimeout(progressTimer); for (const job of jobs) job.control.abort(); jobs.length = 0; listeners.clear() },
  }
}
