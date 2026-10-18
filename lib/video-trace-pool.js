/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/**
 * 视频复刻常驻 Worker 池：复用线程，按任务令牌取消排队/在算任务。
 */
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'

export function createVideoTracePool(options = {}) {
  const size = options.size ?? Math.max(1, Math.min(4, Math.max(1, (cpus()?.length || 2) - 1)))
  const workerUrl = options.workerUrl ?? new URL('./video-trace-worker.js', import.meta.url)
  let nextId = 1
  let closed = false
  const idle = []
  const queue = []
  const busy = new Map()

  function spawn() {
    const worker = new Worker(workerUrl)
    worker.on('message', (message) => finish(worker, message))
    worker.on('error', (error) => fail(worker, error))
    worker.on('exit', (code) => {
      if (busy.has(worker)) fail(worker, new Error('复刻线程已停止（' + code + '）'))
      const at = idle.indexOf(worker)
      if (at >= 0) idle.splice(at, 1)
    })
    // 空闲时不拖住进程退出（测试与短命脚本）；接任务时再 ref。
    if (typeof worker.unref === 'function') worker.unref()
    return worker
  }

  function ensure() {
    while (!closed && idle.length + busy.size < size) idle.push(spawn())
  }

  function pump() {
    if (closed) return
    ensure()
    while (idle.length && queue.length) {
      const worker = idle.pop()
      const item = queue.shift()
      const id = nextId++
      const dispatched = performance.now()
      if (typeof worker.ref === 'function') worker.ref()
      busy.set(worker, { id, item, dispatched, queueWaitMs: dispatched - item.queuedAt })
      try {
        worker.postMessage({ id, png: item.png, raster: item.raster, options: item.options }, item.transfer || [])
      } catch (error) {
        busy.delete(worker)
        if (typeof worker.unref === 'function') worker.unref()
        idle.push(worker)
        item.reject(error)
      }
    }
  }

  function finish(worker, message) {
    const active = busy.get(worker)
    if (!active) return
    if (message && message.id !== active.id) return
    busy.delete(worker)
    if (!closed) {
      if (typeof worker.unref === 'function') worker.unref()
      idle.push(worker)
    } else worker.terminate().catch(() => {})
    if (!message || message.ok !== true) active.item.reject(new Error((message && message.error) || '复刻失败'))
    else active.item.resolve({ ...message, queueWaitMs: active.queueWaitMs, workerRoundTripMs: performance.now() - active.dispatched })
    pump()
  }

  function fail(worker, error) {
    const active = busy.get(worker)
    busy.delete(worker)
    if (active) active.item.reject(error instanceof Error ? error : new Error(String(error)))
    worker.terminate().catch(() => {})
    if (!closed) pump()
  }

  function run(png, traceOptions, meta = {}) {
    if (closed) return Promise.reject(new Error('复刻线程池已关闭'))
    return new Promise((resolve, reject) => {
      queue.push({ png, options: traceOptions, resolve, reject, token: meta.token, queuedAt: performance.now() })
      pump()
    })
  }

  function cancelToken(token) {
    if (token === undefined || token === null) return
    const kept = []
    for (const item of queue) {
      if (item.token === token) item.reject(new Error('已取消复刻'))
      else kept.push(item)
    }
    queue.length = 0
    for (const item of kept) queue.push(item)
    for (const [worker, active] of Array.from(busy.entries())) {
      if (active.item.token !== token) continue
      busy.delete(worker)
      active.item.reject(new Error('已取消复刻'))
      worker.terminate().catch(() => {})
    }
    if (!closed) pump()
  }

  function close() {
    if (closed) return
    closed = true
    for (const item of queue) item.reject(new Error('复刻线程池已关闭'))
    queue.length = 0
    for (const [worker, active] of busy) {
      active.item.reject(new Error('复刻线程池已关闭'))
      worker.terminate().catch(() => {})
    }
    busy.clear()
    for (const worker of idle) worker.terminate().catch(() => {})
    idle.length = 0
  }

  function runRaster(raster, traceOptions, meta = {}) {
    if (closed) return Promise.reject(new Error('复刻线程池已关闭'))
    // Copy into an owned allocation; never transfer a Node Buffer pool slab.
    const pixels = new Uint8Array(raster.data.length); pixels.set(raster.data)
    return new Promise((resolve, reject) => {
      queue.push({ raster: { width: raster.width, height: raster.height, data: pixels }, transfer: [pixels.buffer], options: traceOptions,
        resolve, reject, token: meta.token, queuedAt: performance.now() })
      pump()
    })
  }
  return { run, runRaster, cancelToken, close, get size() { return size } }
}
