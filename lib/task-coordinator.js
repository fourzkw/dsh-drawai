/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'

export function createDocumentCoordinator() {
  const tails = new Map(), local = new AsyncLocalStorage()
  const keyOf = (path) => {
    let key = resolve(path)
    try { key = realpathSync(key) } catch {}
    return process.platform === 'win32' ? key.toLowerCase() : key
  }
  return { keyOf, async run(path, action) {
    const key = keyOf(path)
    if (local.getStore() === key) return action()
    const previous = tails.get(key) || Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    tails.set(key, tail)
    await previous.catch(() => {})
    try { return await local.run(key, action) }
    finally { release(); if (tails.get(key) === tail) tails.delete(key) }
  } }
}

// A shared, abortable budget for user-level drawing and export jobs. Individual
// drawing tasks reuse the existing bounded frame Worker pool.
export function createMediaWorkSlots(limit = 2) {
  let active = 0
  const queue = []
  function pump() {
    while (active < limit && queue.length) {
      const item = queue.shift()
      item.signal?.removeEventListener('abort', item.abort)
      if (item.signal?.aborted) { item.reject(new Error('已取消任务')); continue }
      active++
      let released = false
      item.resolve(() => { if (!released) { released = true; active--; pump() } })
    }
  }
  return { acquire(signal) {
    return new Promise((resolve, reject) => {
      const item = { signal, resolve, reject, abort: () => {
        const index = queue.indexOf(item)
        if (index >= 0) queue.splice(index, 1)
        reject(new Error('已取消任务'))
      } }
      if (signal?.aborted) { reject(new Error('已取消任务')); return }
      signal?.addEventListener('abort', item.abort, { once: true })
      queue.push(item); pump()
    })
  } }
}
