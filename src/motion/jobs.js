// 异步任务表：让"开始渲染"立刻返回，把等待交给下一次工具调用。
//
// 之前 58 分钟里有 24.8 分钟是一次次 `Start-Sleep 100` 睡出来的。
// 规矩很简单：任何超过 5 秒的动作都返回 jobId，绝不 await 到结束。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let sequence = 0

export class RenderJobs {
  constructor() {
    this.jobs = new Map()
  }

  file(dir) {
    return join(dir, '.out', 'jobs.json')
  }

  load(dir) {
    try {
      if (!existsSync(this.file(dir))) return []
      const raw = JSON.parse(readFileSync(this.file(dir), 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch { return [] }
  }

  save(job) {
    const dir = job.dir
    if (!dir) return
    mkdirSync(join(dir, '.out'), { recursive: true })
    const list = this.load(dir).filter((item) => item.id !== job.id)
    list.push(job)
    writeFileSync(this.file(dir), JSON.stringify(list.slice(-40), null, 2) + '\n', 'utf8')
  }

  create(init) {
    sequence += 1
    const job = {
      id: 'job-' + Date.now().toString(36) + '-' + sequence,
      kind: init.kind || 'render',
      dir: init.dir,
      nodeId: init.nodeId,
      status: 'queued',
      phase: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      endedAt: null,
      output: null,
      error: null,
    }
    this.jobs.set(job.id, job)
    this.save(job)
    return job
  }

  update(job, patch) {
    Object.assign(job, patch)
    this.save(job)
    return job
  }

  // 进度只在内存里刷：每 1% 写一次盘既慢又没意义。
  progress(job, phase, value) {
    if (phase) job.phase = phase
    if (Number.isFinite(value)) job.progress = value
    return job
  }

  // 把一次 renderProject 的句柄挂到 job 上，状态变化全部写回表。
  attach(job, handle) {
    job._cancel = handle.cancel
    this.update(job, { status: 'running', phase: 'bundling' })
    handle.promise.then(
      (result) => this.update(job, { status: 'done', phase: 'done', progress: 1, endedAt: new Date().toISOString(), output: handle.output, frames: result.frames || null,
        mix: result.mix || null, mixError: result.mixError || null }),
      (error) => this.update(job, { status: 'failed', phase: 'failed', endedAt: new Date().toISOString(), error: error.message || String(error) }),
    )
    return job
  }

  get(id) {
    return this.jobs.get(id) || null
  }

  list(dir) {
    const fromDisk = this.load(dir)
    const height = new Map(fromDisk.map((item) => [item.id, item]))
    for (const job of this.jobs.values()) if (job.dir === dir) height.set(job.id, { ...job, _cancel: undefined })
    return [...height.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  cancel(id) {
    const job = this.jobs.get(id)
    if (!job) return false
    job._cancel?.()
    this.update(job, { status: 'canceled', phase: 'canceled', endedAt: new Date().toISOString() })
    return true
  }
}
