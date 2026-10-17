/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/** Offline export: frame index, not wall-clock time, determines each timestamp. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, appendFileSync, writeFileSync, renameSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipDirFor, readManifest, findSourceFile, sanitizeClipId } from './media.js'
import { createPerformanceLog } from './performance-log.js'

function runFfmpeg(binary, args, signal, progress) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let errorText = '', line = ''
    const abort = () => child.kill()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', (bytes) => {
      line += bytes.toString()
      const lines = line.split(/\r?\n/); line = lines.pop()
      for (const entry of lines) if (entry.startsWith('frame=')) progress?.(Number(entry.slice(6)))
    })
    child.stderr.on('data', (bytes) => { errorText = (errorText + bytes.toString()).slice(-8000) })
    child.on('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(new Error(error.code === 'ENOENT' ? '未找到 FFmpeg，请安装到 PATH，或设置 DRAWAI_FFMPEG_PATH 为可执行文件路径' : error.message))
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(new Error('已取消视频导出'))
      else if (code !== 0) reject(new Error('FFmpeg 编码失败：' + errorText.trim()))
      else resolve()
    })
  })
}

function ffmpegBinary() {
  if (process.env.DRAWAI_FFMPEG_PATH) return process.env.DRAWAI_FFMPEG_PATH
  // Development checkout only; published packages use the configured binary or PATH.
  const local = fileURLToPath(new URL('../_local/bin/' + (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), import.meta.url))
  return existsSync(local) ? local : 'ffmpeg'
}

export function createVideoExportManager(options = {}) {
  const jobs = new Map()
  let closed = false
  const binary = options.ffmpegPath || ffmpegBinary()
  const framePath = (job, index) => join(job.temp, 'frame-' + String(index).padStart(8, '0') + '.png')
  function view(job) {
    return { token: job.token, status: job.status, count: job.count, received: job.next, encoded: job.encoded,
      fps: job.fps, w: job.w, h: job.h, bytes: job.bytes || 0, error: job.error || '', format: job.format,
      performanceEnabled: job.perf.enabled, performanceId: job.perf.id }
  }
  function owned(scope, token) {
    const job = jobs.get(token)
    if (!job || job.sessionId !== scope.sessionId || job.drawioAbs !== scope.drawioAbs || job.clip !== scope.clip) throw new Error('视频导出任务已失效或不属于当前画布')
    job.time = Date.now()
    return job
  }
  async function remove(job) {
    jobs.delete(job.token)
    job.control.abort()
    if (job.preflight) await job.preflight.catch(() => {})
    if (job.promise) await job.promise.catch(() => {})
    job.perf.finish(job.status === 'done' ? 'done' : job.status === 'error' ? 'failed' : 'cancelled')
    rmSync(job.temp, { recursive: true, force: true })
  }
  async function encode(job) {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
    if (job.kind === 'svg') args.push('-framerate', String(job.fps), '-start_number', '0', '-i', join(job.temp, 'frame-%08d.png'))
    else args.push('-protocol_whitelist', 'file,pipe', '-i', job.source)
    if (job.kind === 'svg' && job.source) args.push('-ss', String(job.offset), '-protocol_whitelist', 'file,pipe', '-i', job.source)
    args.push('-map', '0:v:0')
    if (job.source) args.push('-map', job.kind === 'svg' ? '1:a:0?' : '0:a:0?')
    // PNGs are painted over white by the client. Pad odd dimensions for yuv420p.
    args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=white,format=yuv420p', '-fps_mode', 'cfr')
    if (job.kind === 'svg') {
      args.push('-r', String(job.fps), '-t', String(job.count / job.fps))
      if (job.source) args.push('-af', 'apad')
    }
    if (job.format === 'mp4') args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart')
    else args.push('-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k')
    args.push('-threads', '4', '-progress', 'pipe:1', job.output)
    try {
      const encodeDone = job.perf.start('ffmpegEncode')
      try { await runFfmpeg(binary, args, job.control.signal, (frame) => { job.encoded = frame }) }
      finally { encodeDone() }
      if (job.kind === 'svg' && job.encoded !== job.count) throw new Error('输出帧数不完整：预期 ' + job.count + '，实际 ' + job.encoded)
      job.bytes = statSync(job.output).size
      if (!job.bytes) throw new Error('视频编码结果为空')
      job.status = 'done'
      job.perf.peak('tempTotalBytes', (job.tempBytes || (job.source ? statSync(job.source).size : 0)) + job.bytes);
      job.perf.count('outputBytes', job.bytes); job.perf.count('encodedFrames', job.encoded)
    } catch (error) { job.status = 'error'; job.error = error.message || String(error) }
  }
  return {
    async start(scope, format) {
      if (closed) throw new Error('视频导出服务已关闭')
      if (!sanitizeClipId(scope.clip) || !['mp4', 'webm'].includes(format)) throw new Error('无效视频导出参数')
      for (const job of jobs.values()) if (job.status !== 'encoding' && Date.now() - job.time > 30 * 60 * 1000) await remove(job)
      if (jobs.size >= 4) throw new Error('视频导出任务过多，请稍后重试')
      const dir = clipDirFor(scope.drawioAbs, scope.clip), manifest = readManifest(dir)
      if (manifest.kind !== 'raster' && !manifest.frames.length) throw new Error('没有 SVG 帧可编码')
      if (manifest.width * manifest.height > 16000000 || Math.max(manifest.width, manifest.height) > 16384 || !(manifest.fps > 0)) throw new Error('视频尺寸或帧率无效')
      const original = findSourceFile(dir, manifest)
      if (manifest.kind === 'raster' && !original) throw new Error('源视频缺失')
      if (manifest.source && !original) throw new Error('原片段音频来源缺失，无法保留音频')
      if (original) {
        const rel = relative(realpathSync(dir), realpathSync(original.abs))
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('音频或视频来源不在媒体包内')
      }
      // Child processes may lack write access to the OS temp directory on Windows.
      // Keep transient files beside the writable canvas, outside its media package.
      const cache = options.tempRoot || join(dirname(scope.drawioAbs), '.drawai-cache', 'video-exports')
      mkdirSync(cache, { recursive: true })
      const temp = mkdtempSync(join(cache, 'export-'))
      const perf = createPerformanceLog(dirname(scope.drawioAbs), 'video-export', { ...options.metadata, format, kind: manifest.kind, fps: manifest.fps,
        width: manifest.width, height: manifest.height, count: manifest.frames.length, encoderThreads: 4 }, { enabled: options.profile })
      let job
      try {
        const sourceDone = perf.start('sourceSnapshot')
        const source = original ? join(temp, 'source' + extname(original.abs)) : null
        if (source) copyFileSync(original.abs, source)
        sourceDone()
        job = { ...scope, perf, token: randomUUID(), temp, source, format, kind: manifest.kind, fps: manifest.fps,
          w: manifest.width, h: manifest.height, count: manifest.kind === 'raster' ? 0 : manifest.frames.length, offset: manifest.sourceOffset || 0,
          next: 0, received: 0, encoded: 0, status: 'rendering', time: Date.now(), control: new AbortController(), output: join(temp, 'output.' + format) }
        jobs.set(job.token, job)
        // Probe the actual output path and encoder before uploading any large frames.
        job.preflight = runFfmpeg(binary, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=white:s=2x2:r=1',
          '-frames:v', '1', '-c:v', format === 'mp4' ? 'libx264' : 'libvpx-vp9', '-threads', '1', job.output], job.control.signal)
        const probeDone = perf.start('encoderPreflight')
        try { await job.preflight }
        catch (error) { throw new Error('导出预检查失败（目录：' + temp + '）：' + error.message) }
        finally { probeDone() }
        if (closed || job.control.signal.aborted) throw new Error('视频导出服务已关闭')
        return view(job)
      } catch (error) {
        perf.finish('failed')
        if (job) jobs.delete(job.token)
        rmSync(temp, { recursive: true, force: true })
        throw error
      }
    },
    chunk(scope, body) {
      const job = owned(scope, body.token)
      if (job.kind !== 'svg' || job.status !== 'rendering' || body.index !== job.next || job.next >= job.count || body.offset !== job.received) throw new Error('导出帧分块位置无效')
      const chunkDone = job.perf.start('base64DecodeAndDiskWrite')
      const bytes = Buffer.from(typeof body.base64 === 'string' ? body.base64 : '', 'base64')
      if (!bytes.length || bytes.length > 1024 * 1024 || job.received + bytes.length > 68 * 1024 * 1024) throw new Error('导出帧分块大小无效')
      const part = join(job.temp, 'frame.upload')
      if (!job.received) writeFileSync(part, bytes)
      else appendFileSync(part, bytes)
      job.received += bytes.length
      chunkDone(); job.perf.count('uploadedPngBytes', bytes.length)
      // Monotonic footprint: input PNGs + source snapshot + encoded output.
      job.tempBytes = (job.tempBytes || (job.source ? statSync(job.source).size : 0)) + bytes.length
      job.perf.peak('tempInputBytes', job.tempBytes)
      return { ok: true, received: job.received }
    },
    frame(scope, body) {
      const job = owned(scope, body.token)
      if (job.status !== 'rendering' || body.index !== job.next || job.next >= job.count || !job.received) throw new Error('导出帧序号不连续或数据缺失')
      const part = join(job.temp, 'frame.upload'), head = Buffer.alloc(24), fd = openSync(part, 'r')
      const frameDone = job.perf.start('frameValidateAndCommit')
      try { readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
      if (head.length !== 24 || head.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || head.toString('ascii', 12, 16) !== 'IHDR' || head.readUInt32BE(16) !== job.w || head.readUInt32BE(20) !== job.h) throw new Error('导出帧不是符合媒体尺寸的 PNG')
      renameSync(part, framePath(job, job.next))
      job.next++; job.received = 0
      frameDone(); job.perf.count('receivedFrames')
      return { ok: true, received: job.next }
    },
    finish(scope, token) {
      const job = owned(scope, token)
      if (job.kind === 'svg' && (job.next !== job.count || job.received)) throw new Error('导出帧尚未全部提交')
      if (!job.promise) { job.status = 'encoding'; job.promise = encode(job) }
      return view(job)
    },
    status(scope, token) { return view(owned(scope, token)) },
    read(scope, token, offset) {
      const job = owned(scope, token)
      if (job.status !== 'done' || !Number.isSafeInteger(offset) || offset < 0 || offset >= job.bytes) throw new Error('导出文件未完成或读取位置无效')
      const bytes = Buffer.alloc(Math.min(1024 * 1024, job.bytes - offset)), fd = openSync(job.output, 'r')
      const readDone = job.perf.start('outputReadAndBase64Encode')
      try { readSync(fd, bytes, 0, bytes.length, offset) } finally { closeSync(fd) }
      const base64 = bytes.toString('base64')
      readDone(); job.perf.count('downloadedBytes', bytes.length)
      return { ok: true, offset, bytes: bytes.length, base64, total: job.bytes }
    },
    async discard(scope, token, performance) { const job = owned(scope, token); job.perf.merge('browser.', performance); await remove(job); return { ok: true } },
    async dispose() { closed = true; await Promise.all(Array.from(jobs.values(), remove)) },
  }
}
