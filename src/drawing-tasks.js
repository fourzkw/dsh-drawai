import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync, realpathSync } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { executeDrawing } from './drawing-runner.js'
import { createPerformanceLog } from './performance-log.js'

const algorithm = createHash('sha256').update(Buffer.concat(['trace-image.js', 'video-trace-reuse.js', 'drawing-runner.js', 'video-trace-worker.js', 'style-kernel.js', 'raster.js']
  .map((name) => readFileSync(new URL(name, import.meta.url))))).digest('hex')
const terminal = (job) => ['succeeded', 'failed', 'cancelled', 'interrupted', 'paused'].includes(job.status)
const digest = (value) => createHash('sha256').update(value).digest('hex')
const fileIdentity = (path) => {
  let value = resolve(path)
  try { value = realpathSync(value) } catch {}
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function atomic(path, value) { writeFileSync(path + '.tmp', JSON.stringify(value)); renameSync(path + '.tmp', path) }

export function createDrawingTaskManager(options) {
  const jobs = new Map(), loaded = new Set(), paused = new Map()
  let active, closed = false, pumping = false, sequence = Date.now()
  const nextOrder = () => (sequence = Math.max(Date.now(), sequence + 1))
  const contained = (root, path) => { const rel = relative(realpathSync(root), realpathSync(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') }
  const rootOf = (scope) => {
    const path = join(scope.workspaceRoot, '.drawai-cache', 'drawing-tasks')
    mkdirSync(path, { recursive: true })
    if (!contained(scope.workspaceRoot, path)) throw new Error('任务目录超出工作区')
    return path
  }
  const ownerKey = (scope) => fileIdentity(scope.workspaceRoot) + '\0' + scope.sessionId
  const policyPath = (scope) => join(rootOf(scope), 'queue-' + digest(scope.sessionId).slice(0, 24) + '.json')
  function persist(job) {
    const { control, promise, deliveryPromise, poster, ...data } = job
    atomic(join(job.directory, 'job.json'), data)
  }
  function view(job) {
    return { id: job.id, kind: job.kind, label: job.label, scope: { path: job.scope.path, page: job.scope.page,
      pageId: job.scope.pageId, pageName: job.scope.pageName }, options: job.options, status: job.status, delivery: job.delivery,
    phase: job.phase, done: job.done || 0, total: job.total || job.plan?.count || 1, reducedFrames: job.reducedFrames || 0, createdAt: job.createdAt,
    startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error || '', message: job.message || '',
    pauseRequested: !!job.pauseRequested, outputClip: job.outputClip, nodeId: job.nodeId, resultPath: job.resultPath,
    queuePaused: !!paused.get(ownerKey(job.scope)), sourceId: job.source.id }
  }
  function load(scope) {
    const key = ownerKey(scope)
    if (loaded.has(key)) return
    const root = rootOf(scope); mkdirSync(root, { recursive: true })
    const names = readdirSync(root)
    loaded.add(key)
    try { paused.set(key, JSON.parse(readFileSync(policyPath(scope))).paused === true) } catch {}
    for (const name of names) {
      if (!/^[a-f0-9-]{36}$/.test(name) || jobs.has(name)) continue
      try {
        const directory = join(root, name), data = JSON.parse(readFileSync(join(directory, 'job.json'), 'utf8'))
        if (data.id !== name || !contained(root, directory) || !contained(directory, join(directory, 'job.json'))) continue
        const rel = relative(resolve(scope.workspaceRoot), resolve(data.scope.drawioAbs))
        if (data.scope.sessionId !== scope.sessionId || fileIdentity(data.scope.workspaceRoot) !== fileIdentity(scope.workspaceRoot) ||
            isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) continue
        const job = { ...data, directory, input: join(directory, 'input.bin'), control: new AbortController() }
        if (job.status !== 'succeeded' && !contained(directory, job.input)) continue
        if (job.status === 'succeeded' && job.delivery === 'pending') {
          job.delivery = 'conflict'; job.error = '绘制产物已保存，宿主曾停止，请重试加入原画布'
        }
        if (job.resultPath) job.resultPath = join(directory, 'result.json')
        if (['running', 'queued', 'cancelling'].includes(job.status)) {
          job.status = 'interrupted'; job.message = '宿主曾停止，可继续检查点或重新开始'
        }
        sequence = Math.max(sequence, Number(job.order) || 0)
        jobs.set(job.id, job); persist(job)
      } catch { /* A damaged record must not prevent other tasks from loading. */ }
    }
  }
  function owned(scope, id) {
    load(scope)
    const job = jobs.get(id)
    if (!job || ownerKey(job.scope) !== ownerKey(scope)) throw new Error('任务不存在或不属于当前会话')
    return job
  }
  async function deliver(job) {
    if (job.status !== 'succeeded' || job.kind === 'extract') return
    try {
      const output = JSON.parse(readFileSync(job.resultPath, 'utf8'))
      const result = await options.commit(job, output)
      job.delivery = 'applied'; job.nodeId = result.nodeId; job.createdNode = result.node; job.error = ''
      if (result.page !== undefined) job.scope.page = result.page
    } catch (error) { job.delivery = 'conflict'; job.error = String(error.message || error) }
    persist(job)
  }
  async function run(job) {
    let release
    const perf = createPerformanceLog(job.scope.workspaceRoot, job.kind + '-background', { ...job.options, workerCount: options.pool.size, algorithm })
    perf.add('queueWait', Date.now() - job.createdAt)
    job.control = new AbortController(); job.pauseRequested = false
    job.status = 'running'; job.startedAt ||= Date.now(); job.phase = 'preparing'; job.error = ''; persist(job)
    const checkpoint = () => { job.updatedAt = Date.now(); persist(job) }
    try {
      release = await options.slots?.acquire(job.control.signal)
      const verifyDone = perf.start('inputVerification')
      if (digest(await readFile(job.input)) !== job.inputHash) throw new Error('任务素材摘要已变化，请重新提交')
      verifyDone()
      job.control.signal.throwIfAborted()
      const output = await executeDrawing(job, { pool: options.pool, signal: job.control.signal, ffmpegPath: options.ffmpegPath, perf,
        publishExtraction: (action) => options.publishExtraction ? options.publishExtraction(job, action) : action(),
        pauseRequested: () => job.pauseRequested, checkpoint,
        update: (patch) => { Object.assign(job, patch); job.updatedAt = Date.now() },
      })
      if (job.control.signal.aborted) throw new Error('已取消任务')
      if (!output) { job.status = 'paused'; job.message = '已在完整帧边界暂停'; checkpoint(); return }
      job.resultPath = join(job.directory, 'result.json'); atomic(job.resultPath, output)
      if (output.svg) writeFileSync(join(job.directory, 'result.svg'), output.svg)
      job.status = 'succeeded'; job.delivery = job.kind === 'extract' ? 'applied' : 'pending'; job.finishedAt = Date.now()
      job.phase = 'finished'; job.message = '绘制产物已保存'; checkpoint()
      rmSync(job.input, { force: true })
      release?.(); release = null
      if (job.kind === 'extract') await options.extracted?.(job, output)
      else job.deliveryPromise = deliver(job).catch((error) => { job.delivery = 'conflict'; job.error = String(error.message || error) })
    } catch (error) {
      job.status = closed ? 'interrupted' : job.control.signal.aborted ? 'cancelled' : 'failed'
      job.error = job.status === 'cancelled' ? '' : String(error.message || error)
      job.finishedAt = Date.now(); checkpoint()
      await options.failed?.(job)
    } finally { release?.(); perf.count('committedFrames', job.done || 0); perf.finish(job.status, { count: job.total, width: job.plan?.w, height: job.plan?.h }) }
  }
  function pump() {
    if (closed || active || pumping) return
    pumping = true
    queueMicrotask(() => {
      pumping = false
      if (closed || active) return
      const job = [...jobs.values()].filter((item) => item.status === 'queued' && !paused.get(ownerKey(item.scope)))
        .sort((a, b) => a.order - b.order)[0]
      if (!job) return
      active = job; job.promise = run(job).finally(() => { active = null; pump() })
    })
  }
  async function enqueue(scope, data, input) {
    if (closed) throw new Error('绘制服务已关闭')
    load(scope)
    const history = [...jobs.values()].filter((job) => ownerKey(job.scope) === ownerKey(scope) &&
      ['succeeded', 'failed', 'cancelled'].includes(job.status) && job.delivery !== 'conflict' && !(job.status === 'succeeded' && job.delivery === 'pending')).sort((a, b) => a.order - b.order)
    for (const job of history.slice(0, Math.max(0, history.length - 63))) {
      jobs.delete(job.id); rmSync(job.directory, { recursive: true, force: true })
    }
    const optionsKey = JSON.stringify(data.options)
    const same = [...jobs.values()].find((job) => ownerKey(job.scope) === ownerKey(scope) &&
      fileIdentity(job.scope.drawioAbs) === fileIdentity(scope.drawioAbs) && (scope.pageId ? job.scope.pageId === scope.pageId : job.scope.page === scope.page) &&
      job.source.signature === data.source.signature && job.source.id === data.source.id && job.kind === data.kind &&
      JSON.stringify(job.options) === optionsKey && ['queued', 'running', 'paused'].includes(job.status))
    if (same) return view(same)
    const pending = [...jobs.values()].filter((job) => !['succeeded', 'failed', 'cancelled'].includes(job.status))
    if (pending.length >= 16) throw new Error('队列已满（最多 16 个未完成任务）')
    const bytes = Buffer.isBuffer(input) ? input.length : statSync(input).size
    const retainedBytes = [...jobs.values()].filter((job) => job.status !== 'succeeded' && existsSync(job.input)).reduce((sum, job) => sum + job.inputBytes, 0)
    if (bytes > 64 * 1024 * 1024) throw new Error('单个绘制素材不能超过 64MiB')
    if (retainedBytes + bytes > 256 * 1024 * 1024) throw new Error('任务素材缓存超出 256MiB 预算，请移除已结束记录或完成部分任务')
    const id = randomUUID(), directory = join(rootOf(scope), id); mkdirSync(directory)
    const job = { id, scope: { ...scope }, ...data, algorithm, directory, input: join(directory, 'input.bin'), inputBytes: bytes,
      createdAt: Date.now(), order: nextOrder(), status: 'queued', delivery: 'pending', phase: 'queued', done: 0, total: 1, control: new AbortController() }
    try {
      if (Buffer.isBuffer(input)) writeFileSync(job.input, input)
      else await copyFile(input, job.input)
      job.inputHash = digest(await readFile(job.input)); persist(job); jobs.set(id, job); pump(); return view(job)
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
  }
  return {
    enqueue,
    recordCommit(job, node) { job.createdNode = node; persist(job) },
    list(scope) { load(scope); return [...jobs.values()].filter((job) => ownerKey(job.scope) === ownerKey(scope)).sort((a, b) => a.order - b.order).map(view) },
    result(scope, id) { const job = owned(scope, id); if (!job.resultPath || !existsSync(job.resultPath)) throw new Error('结果尚未生成'); return { job: view(job), output: JSON.parse(readFileSync(job.resultPath, 'utf8')) } },
    async command(scope, id, action, value) {
      load(scope)
      if (action === 'pause-queue') {
        paused.set(ownerKey(scope), value === true); atomic(policyPath(scope), { paused: value === true }); pump(); return { queuePaused: value === true }
      }
      const job = owned(scope, id)
      if (action === 'pause') {
        if (job.status === 'queued') job.status = 'paused'
        else if (job.status === 'running') { job.pauseRequested = true; job.message = '等待在途帧完成后暂停' }
      } else if (action === 'resume' || action === 'retry') {
        if (!['paused', 'failed', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('当前任务不可继续')
        if (job.algorithm !== algorithm) throw new Error('算法已更新，请选择重新开始')
        job.status = 'queued'; job.error = ''; job.pauseRequested = false; job.order = nextOrder()
      } else if (action === 'restart') {
        if (!terminal(job) || job.status === 'succeeded') throw new Error('请先停止当前任务')
        job.status = 'cancelled'; persist(job)
        return enqueue(job.scope, { kind: job.kind, label: job.label, source: job.source, options: job.options }, job.input)
      } else if (action === 'cancel') {
        if (job.status === 'running') { job.status = 'cancelling'; job.control.abort(); options.pool.cancelToken(job.id) }
        else if (!['succeeded', 'failed'].includes(job.status)) job.status = 'cancelled'
      } else if (action === 'apply') { await job.deliveryPromise; await deliver(job) }
      else if (action === 'undo') {
        await job.deliveryPromise
        if (job.delivery !== 'applied' || job.kind === 'extract') throw new Error('此任务没有可撤销的生成节点')
        await options.undo(job); job.delivery = 'undone'; job.error = ''
      } else if (action === 'remove') {
        if (!terminal(job)) throw new Error('请先取消运行中的任务')
        await job.deliveryPromise
        jobs.delete(job.id); rmSync(job.directory, { recursive: true, force: true }); return { removed: true }
      } else if (action === 'move') {
        if (job.status !== 'queued') throw new Error('只有等待中的任务可以排序')
        const waiting = [...jobs.values()].filter((item) => ownerKey(item.scope) === ownerKey(scope) && item.status === 'queued').sort((a, b) => a.order - b.order)
        const next = waiting[waiting.indexOf(job) + (value < 0 ? -1 : 1)]
        if (next) { const order = job.order; job.order = next.order; next.order = order; persist(next) }
      } else throw new Error('未知队列操作')
      persist(job); pump(); return view(job)
    },
    leases(drawioAbs, scope) {
      const clips = [...jobs.values()].filter((job) => fileIdentity(job.scope.drawioAbs) === fileIdentity(drawioAbs)).flatMap((job) => [job.source.clip, job.outputClip])
      if (scope) {
        const root = rootOf(scope)
        for (const name of readdirSync(root)) if (/^[a-f0-9-]{36}$/.test(name)) {
          try {
            const directory = join(root, name)
            if (!contained(root, directory)) continue
            const job = JSON.parse(readFileSync(join(directory, 'job.json'), 'utf8'))
            if (fileIdentity(job.scope.drawioAbs) === fileIdentity(drawioAbs)) clips.push(job.source.clip, job.outputClip)
          } catch {}
        }
      }
      return new Set(clips.filter(Boolean))
    },
    async close() {
      closed = true
      if (active) { active.control.abort(); options.pool.cancelToken(active.id); await active.promise }
      await Promise.allSettled([...jobs.values()].map((job) => job.deliveryPromise))
      for (const job of jobs.values()) if (job.status === 'queued') { job.status = 'interrupted'; persist(job) }
    },
  }
}
