// 渲染执行体：`wb __render` 就是跑这个。
// 单独一个进程是因为渲染会跑十几分钟——CLI 立刻返回 job id，进度写进 .out/jobs/<id>.json，
// 人来 `wb status` 看，或者干脆等 `--wait`。
//
// 取消走文件标记：`wb render cancel <job>` 写 <id>.cancel，这里轮询到就调 renderProject 的 cancel。

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function runRenderJob({ dir, jobId, kind, operation, output, frames, range, onProgress }) {
  const jobsDir = join(dir, '.out', 'jobs')
  mkdirSync(jobsDir, { recursive: true })
  const jobPath = join(jobsDir, jobId + '.json')
  const cancelFlag = join(jobsDir, jobId + '.cancel')
  const startedAt = Date.now()
  const readJob = () => { try { return JSON.parse(readFileSync(jobPath, 'utf8')) } catch { return null } }
  let lastWrite = 0
  let lastPhase = ''
  const patch = (fields) => {
    const job = readJob() || { id: jobId, kind, dir, output }
    writeFileSync(jobPath, JSON.stringify({ ...job, ...fields, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  }
  const progress = (message) => {
    const now = Date.now()
    const phase = message.phase || ''
    if (phase !== lastPhase || now - lastWrite > 700) {
      lastWrite = now
      lastPhase = phase
      patch({ phase, progress: typeof message.progress === 'number' ? message.progress : 0, ...(message.frames ? { frames: message.frames } : {}) })
    }
    onProgress?.(message)
  }
  const { renderProject } = await import('../../engine/motion/render.js')
  let handle
  let cancelled = false
  const timer = setInterval(() => {
    if (!existsSync(cancelFlag)) return
    cancelled = true
    clearInterval(timer)
    patch({ phase: 'cancelling' })
    handle?.cancel?.()
  }, 400)
  try {
    handle = renderProject(dir, {
      operation,
      frames: operation === 'still' ? frames : undefined,
      frameRange: range || undefined,
      output,
      onProgress: progress,
    })
    // 立刻标成 running：不然 `wb status` 会一直显示 queued，看不出到底是排队还是已经在渲。
    patch({ status: 'running', pid: process.pid })
    const result = await handle.promise
    clearInterval(timer)
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10
    if (operation === 'still') {
      const stills = []
      const targetDir = join(dir, '.out', 'still')
      mkdirSync(targetDir, { recursive: true })
      for (const frame of result.frames || []) {
        const from = join(dir, '.out', 'qa', frame.filename)
        if (!existsSync(from)) continue
        const to = join(targetDir, 'frame-' + String(frame.frame).padStart(4, '0') + '.png')
        copyFileSync(from, to)
        stills.push(to)
      }
      patch({ status: 'done', progress: 1, phase: 'done', seconds, stills, qa: result.qa || null, finishedAt: new Date().toISOString() })
      return { ok: true, output: null, stills, seconds, bytes: 0, renderSummary: result.renderSummary, qa: result.qa || null }
    }
    const bytes = existsSync(output) ? statSync(output).size : 0
    patch({
      status: 'done', progress: 1, phase: 'done', seconds, bytes,
      finishedAt: new Date().toISOString(),
      renderSummary: result.renderSummary || null,
      qa: result.qa || null,
      ...(result.mix ? { mix: result.mix } : {}),
      ...(result.mixError ? { mixError: result.mixError } : {}),
    })
    return { ok: true, output, bytes, seconds, renderSummary: result.renderSummary, mix: result.mix, mixError: result.mixError, qa: result.qa || null }
  } catch (error) {
    clearInterval(timer)
    const cancelledNow = cancelled || existsSync(cancelFlag)
    patch({
      status: cancelledNow ? 'cancelled' : 'error',
      phase: cancelledNow ? 'cancelled' : 'error',
      error: cancelledNow ? undefined : (error?.message || String(error)),
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      finishedAt: new Date().toISOString(),
    })
    throw error
  }
}
