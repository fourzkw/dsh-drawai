// ffmpeg 调用：stderr 写文件，不走管道。
//
// 受限环境下 spawn + pipe 会直接 EPERM（拿不到匿名管道），而文件描述符不受
// 影响；顺带也绕开了 execFile 的 maxBuffer 上限。帧检和导出都走这一个入口。

import { existsSync, openSync, closeSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { ensureFfmpeg, ffmpegPathSync } from '../ffmpeg-manager.js'

export async function runFfmpeg(args, options = {}) {
  const cwd = options.cwd || process.cwd()
  const logPath = isAbsolute(options.log || '') ? options.log : join(cwd, options.log || 'ff.log')
  const binary = options.binary || await ensureFfmpeg({ signal: options.signal, onProgress: options.onProgress })
  return new Promise((resolve, reject) => {
    let fd
    try {
      fd = openSync(logPath, 'w')
    } catch (error) {
      reject(error)
      return
    }
    const child = spawn(binary, ['-hide_banner', '-nostdin', '-y', ...args], {
      cwd, windowsHide: true, stdio: ['ignore', 'ignore', fd],
    })
    const timer = setTimeout(() => child.kill(), options.timeoutMs || 300000)
    // 取消要能打断正在跑的 ffmpeg，而不是等它自己结束（issue #57）。
    const onAbort = () => { try { child.kill() } catch { /* 已经退出了 */ } }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    const finish = (code, error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      try { closeSync(fd) } catch { /* 已关 */ }
      let stderr = ''
      try { stderr = readFileSync(logPath, 'utf8') } catch { /* 没有日志 */ }
      if (!error && options.signal?.aborted) error = options.signal.reason instanceof Error ? options.signal.reason : new Error('已取消')
      if (error) reject(Object.assign(error, { stderr }))
      else if (code === 0 || options.allowFail) resolve(stderr)
      else reject(Object.assign(new Error('ffmpeg 退出码 ' + code + '：' + stderr.trim().split('\n').slice(-2).join(' ')), { stderr }))
    }
    child.on('error', (error) => finish(-1, error))
    child.on('close', (code) => finish(code))
  })
}

export function ffmpegAvailable() {
  return existsSync(ffmpegPathSync())
}
