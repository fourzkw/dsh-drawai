/**
 * dsh-drawai 构建监视器 —— 零依赖。
 *
 * 监听 src/，变化后重建 lib/。这是 dsh-client-hmr 需要的那一环：
 * 它的 Node 半边每 500ms 轮询 graph bundle 的时间戳，发现 lib/client.js 内容变了
 * 就通过 SSE /plugins/events 通知浏览器 invalidate → prefetch → 重挂载。
 * **它不关心是谁写的文件** —— 只要有进程在写就行，不需要 tsdown。
 *
 * 关键：不 spawn 子进程，直接 import build.mjs。
 * （本机沙箱下 Node 的 piped stdio 会被拒，spawn 一条 `node tools/build.mjs` 会 EPERM。）
 *
 * 用法：node tools/watch.mjs        （建议作为后台任务常驻）
 */
import { watch } from 'node:fs'
import { buildAll } from './build.mjs'

buildAll()

let timer = null
let building = false
let pending = false

function run() {
  timer = null
  if (building) {
    pending = true
    return
  }
  building = true
  try {
    buildAll()
  } catch (error) {
    console.error('构建失败：' + (error && error.message ? error.message : String(error)))
  } finally {
    building = false
    if (pending) {
      pending = false
      schedule()
    }
  }
}

function schedule() {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(run, 120)
}

watch('src', { recursive: true }, schedule)
console.log('监视 src/ 中…… 改动会自动重建 lib/（客户端半边经 dsh-client-hmr 免刷新重载）')
