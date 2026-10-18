/** Offline export: frame index, not wall-clock time, determines each timestamp. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { copyFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, rmSync, renameSync, statSync, openSync, readSync, closeSync, realpathSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, relative, isAbsolute, extname, dirname, basename } from 'node:path'
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

export function ffmpegBinary() {
  if (process.env.DRAWAI_FFMPEG_PATH) return process.env.DRAWAI_FFMPEG_PATH
  // Development checkout only; published packages use the configured binary or PATH.
  const local = fileURLToPath(new URL('../_local/bin/' + (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), import.meta.url))
  return existsSync(local) ? local : 'ffmpeg'
}

export function createVideoExportManager(options = {}) {
  const jobs = new Map()
  let closed = false
  const binary = options.ffmpegPath || ffmpegBinary()
  const historyRoot = (path) => join(dirname(path), '.drawai-cache', 'video-export-history')
  const ended = (job) => ['done', 'error', 'interrupted'].includes(job.status)
  function persist(job) {
    const root = historyRoot(job.drawioAbs); mkdirSync(root, { recursive: true })
    const record = Object.fromEntries(['sessionId', 'drawioAbs', 'clip', 'token', 'status', 'time', 'next', 'encoded', 'format', 'kind', 'w', 'h', 'fps', 'count', 'bytes', 'savedPath', 'error'].map((key) => [key, job[key]]))
    const file = join(root, job.token + '.json')
    writeFileSync(file + '.tmp', JSON.stringify(record)); renameSync(file + '.tmp', file)
  }
  function load(scope) {
    const root = historyRoot(scope.drawioAbs)
    if (!existsSync(root)) return
    for (const name of readdirSync(root)) if (/^[a-f0-9-]{36}\.json$/.test(name) && !jobs.has(name.slice(0, -5))) {
      try {
        const data = JSON.parse(readFileSync(join(root, name), 'utf8'))
        if (data.token + '.json' !== name || data.sessionId !== scope.sessionId || data.drawioAbs !== scope.drawioAbs || !sanitizeClipId(data.clip) || !['mp4', 'webm', 'gif'].includes(data.format)) continue
        const expected = join(dirname(scope.drawioAbs), basename(scope.drawioAbs).replace(/\.drawio$/i, '') + '-' + data.clip + '-' + data.token + '.' + data.format)
        if (data.status === 'done' && (data.savedPath !== expected || !existsSync(expected) ||
            isAbsolute(relative(realpathSync(dirname(scope.drawioAbs)), realpathSync(expected))) || relative(realpathSync(dirname(scope.drawioAbs)), realpathSync(expected)).startsWith('..'))) {
          data.status = 'error'; data.error = '已导出的文件已移动或删除'; data.savedPath = null
        }
        if (!ended(data)) { data.status = 'interrupted'; data.error = '宿主曾停止，可选择重新导出；编码进度不能直接续传' }
        const job = { ...data, output: data.savedPath, control: new AbortController(),
          temp: join(dirname(scope.drawioAbs), '.drawai-cache', 'video-exports', 'restored-' + data.token),
          perf: createPerformanceLog(dirname(scope.drawioAbs), 'video-export', {}, { enabled: false }) }
        jobs.set(job.token, job); persist(job)
      } catch { /* Ignore damaged history without hiding healthy tasks. */ }
    }
  }
  function view(job) {
    return { token: job.token, status: job.status, count: job.count, received: job.next, encoded: job.encoded,
      clip: job.clip, fps: job.fps, w: job.w, h: job.h, bytes: job.bytes || 0, error: job.error || '', format: job.format,
      background: true, path: job.savedPath || null,
      performanceEnabled: job.perf.enabled, performanceId: job.perf.id }
  }
  function owned(scope, token) {
    load(scope)
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
    rmSync(join(historyRoot(job.drawioAbs), job.token + '.json'), { force: true })
  }
  function renderFrames(job) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(options.workerUrl || new URL('./video-export-worker.js', import.meta.url), {
        workerData: { dir: job.dir, frames: job.frames, temp: job.temp, w: job.w, h: job.h },
      })
      let settled = false
      const abort = () => finish(new Error('已取消视频导出'))
      const finish = (error) => {
        if (settled) return
        settled = true; job.control.signal.removeEventListener('abort', abort)
        // Wait for native rendering to exit before removing its directory.
        worker.terminate().then(() => error ? reject(error) : resolve(), reject)
      }
      worker.on('message', (message) => {
        if (settled) return
        if (message.type === 'timing') job.perf.add('hostSvgRender', message.ms)
        if (message.type === 'progress' || message.type === 'done') {
          job.next = message.rendered; job.tempBytes = (job.source ? statSync(job.source).size : 0) + message.bytes
          job.perf.peak('tempInputBytes', job.tempBytes)
        }
        if (message.type === 'done') finish()
        if (message.type === 'error') finish(new Error(message.error))
      })
      worker.on('error', finish)
      worker.on('exit', (code) => { if (!settled) finish(new Error('导出渲染线程意外退出（' + code + '）')) })
      job.control.signal.addEventListener('abort', abort, { once: true })
      if (job.control.signal.aborted) abort()
    })
  }
  async function runJob(job) {
    let release
    try {
      release = await options.slots?.acquire(job.control.signal)
      job.status = 'rendering'
      persist(job)
      if (job.kind === 'svg') {
        await renderFrames(job)
        job.perf.count('renderedFrames', job.next)
      }
      if (job.control.signal.aborted) throw new Error('已取消视频导出')
      job.status = 'encoding'
      persist(job)
      await encode(job)
      if (job.status === 'error') throw new Error(job.error)
      if (job.control.signal.aborted) throw new Error('已取消视频导出')
      // Persist independently of the browser's progress polling or download.
      const name = basename(job.drawioAbs).replace(/\.drawio$/i, '') + '-' + job.clip + '-' + job.token + '.' + job.format
      const path = join(dirname(job.drawioAbs), name)
      renameSync(job.output, path)
      job.output = path; job.savedPath = path; job.status = 'done'; job.time = Date.now()
      persist(job)
      job.perf.finish('done')
    } catch (error) {
      job.status = closed ? 'interrupted' : 'error'; job.error = String(error.message || error); job.time = Date.now()
      persist(job)
      job.perf.finish(job.control.signal.aborted ? 'cancelled' : 'failed')
    } finally { release?.(); rmSync(job.temp, { recursive: true, force: true }) }
  }
  async function encode(job) {
    const gifWhite = '[0:v:0]split[foreground][background];[background]lutrgb=r=255:g=255:b=255,format=rgb24[white];' +
      '[white][foreground]overlay=shortest=1:format=rgb[opaque];'
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
    if (job.kind === 'svg') args.push('-framerate', String(job.fps), '-start_number', '0', '-i', join(job.temp, 'frame-%08d.png'))
    else args.push('-protocol_whitelist', 'file,pipe', '-i', job.source)
    if (job.kind === 'svg' && job.source) args.push('-ss', String(job.offset), '-protocol_whitelist', 'file,pipe', '-i', job.source)
    if (job.format === 'gif') {
      args.push('-i', join(job.temp, 'palette.png'), '-filter_complex',
        gifWhite + '[opaque][1:v:0]paletteuse=dither=sierra2_4a:diff_mode=rectangle[gif]',
        '-map', '[gif]', '-an', '-fps_mode', 'cfr', '-r', String(job.fps))
    } else {
      args.push('-map', '0:v:0')
      if (job.source) args.push('-map', job.kind === 'svg' ? '1:a:0?' : '0:a:0?')
      // PNGs are painted over white by the client. Pad odd dimensions for yuv420p.
      args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=white,format=yuv420p', '-fps_mode', 'cfr')
    }
    if (job.kind === 'svg') {
      args.push('-r', String(job.fps), '-t', String(job.count / job.fps))
      if (job.source) args.push('-af', 'apad')
    }
    if (job.format === 'mp4') args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart')
    else if (job.format === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k')
    else args.push('-c:v', 'gif', '-loop', '0')
    args.push('-threads', '4', '-progress', 'pipe:1', job.output)
    try {
      if (job.format === 'gif') {
        // Two passes keep a single stable palette without buffering the full
        // video in a split/framesync filter graph. Input frames already live on disk.
        const paletteArgs = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
        if (job.kind === 'svg') paletteArgs.push('-framerate', String(job.fps), '-start_number', '0', '-i', join(job.temp, 'frame-%08d.png'))
        else paletteArgs.push('-protocol_whitelist', 'file,pipe', '-i', job.source)
        paletteArgs.push('-filter_complex', gifWhite + '[opaque]palettegen=max_colors=256:reserve_transparent=0:stats_mode=full[palette]', '-map', '[palette]',
          '-frames:v', '1', '-threads', '1', '-update', '1', join(job.temp, 'palette.png'))
        const paletteDone = job.perf.start('gifPaletteGenerate')
        try { await runFfmpeg(binary, paletteArgs, job.control.signal) }
        finally { paletteDone() }
      }
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
      load(scope)
      if (!sanitizeClipId(scope.clip) || !['mp4', 'webm', 'gif'].includes(format)) throw new Error('无效视频导出参数')
      for (const job of jobs.values()) if (['done', 'error'].includes(job.status) && Date.now() - job.time > 24 * 60 * 60 * 1000) await remove(job)
      if ([...jobs.values()].filter((job) => !ended(job)).length >= 4) throw new Error('视频导出任务过多，请稍后重试')
      const history = [...jobs.values()].filter(ended)
      while (history.length >= 16) await remove(history.shift())
      const dir = clipDirFor(scope.drawioAbs, scope.clip), manifest = readManifest(dir)
      if (manifest.kind !== 'raster' && !manifest.frames.length) throw new Error('没有 SVG 帧可编码')
      if (manifest.width * manifest.height > 16000000 || Math.max(manifest.width, manifest.height) > 16384 || !(manifest.fps > 0)) throw new Error('视频尺寸或帧率无效')
      // GIF has no audio. SVG exports only need their rendered frames, even
      // when the original audio source has since been removed.
      const original = manifest.kind === 'raster' || format !== 'gif' ? findSourceFile(dir, manifest) : null
      if (manifest.kind === 'raster' && !original) throw new Error('源视频缺失')
      if (format !== 'gif' && manifest.source && !original) throw new Error('原片段音频来源缺失，无法保留音频')
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
        if (source) await copyFile(original.abs, source)
        let inputDir = dir, frames = manifest.frames
        if (manifest.kind === 'svg') {
          inputDir = join(temp, 'input'); mkdirSync(inputDir)
          frames = []
          for (let index = 0; index < manifest.frames.length; index++) {
            const frame = manifest.frames[index], file = join(dir, frame.file)
            const rel = relative(realpathSync(dir), realpathSync(file))
            if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('SVG 帧路径超出媒体包')
            const name = index + '.svg'; await copyFile(file, join(inputDir, name))
            frames.push({ ...frame, file: name })
          }
        }
        sourceDone()
        if (closed) throw new Error('视频导出服务已关闭')
        job = { ...scope, dir: inputDir, frames, perf, token: randomUUID(), temp, source, format, kind: manifest.kind, fps: manifest.fps,
          w: manifest.width, h: manifest.height, count: manifest.kind === 'raster' ? 0 : manifest.frames.length, offset: manifest.sourceOffset || 0,
          next: 0, received: 0, encoded: 0, status: 'queued', time: Date.now(), control: new AbortController(), output: join(temp, 'output.' + format) }
        jobs.set(job.token, job)
        persist(job)
        // Probe the actual output path and encoder before uploading any large frames.
        job.preflight = runFfmpeg(binary, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=white:s=2x2:r=1',
          '-frames:v', '1', '-c:v', format === 'mp4' ? 'libx264' : format === 'gif' ? 'gif' : 'libvpx-vp9', '-threads', '1', job.output], job.control.signal)
        const probeDone = perf.start('encoderPreflight')
        try { await job.preflight }
        catch (error) { throw new Error('导出预检查失败（目录：' + temp + '）：' + error.message) }
        finally { probeDone() }
        if (closed || job.control.signal.aborted) throw new Error('视频导出服务已关闭')
        job.promise = runJob(job)
        return view(job)
      } catch (error) {
        perf.finish('failed')
        if (job) jobs.delete(job.token)
        if (job) rmSync(join(historyRoot(job.drawioAbs), job.token + '.json'), { force: true })
        rmSync(temp, { recursive: true, force: true })
        throw error
      }
    },
    // Compatibility endpoint: the task already runs after start, without a client finish call.
    finish(scope, token) { return view(owned(scope, token)) },
    list(scope) { load(scope); return [...jobs.values()].filter((job) => job.sessionId === scope.sessionId && job.drawioAbs === scope.drawioAbs).map(view) },
    status(scope, token) { return view(owned(scope, token)) },
    read(scope, token, offset) {
      const job = owned(scope, token)
      if (job.status !== 'done' || !Number.isSafeInteger(offset) || offset < 0 || offset >= job.bytes) throw new Error('导出文件未完成或读取位置无效')
      if (statSync(job.output).size !== job.bytes) throw new Error('导出文件已被修改，请重新导出')
      const bytes = Buffer.alloc(Math.min(1024 * 1024, job.bytes - offset)), fd = openSync(job.output, 'r')
      const readDone = job.perf.start('outputReadAndBase64Encode')
      try { readSync(fd, bytes, 0, bytes.length, offset) } finally { closeSync(fd) }
      const base64 = bytes.toString('base64')
      readDone(); job.perf.count('downloadedBytes', bytes.length)
      return { ok: true, offset, bytes: bytes.length, base64, total: job.bytes }
    },
    async discard(scope, token, performance) { const job = owned(scope, token); job.perf.merge('browser.', performance); await remove(job); return { ok: true } },
    leases(drawioAbs) { return [...jobs.values()].filter((job) => job.drawioAbs === drawioAbs && !['done', 'error'].includes(job.status)).map((job) => job.clip) },
    async dispose() {
      closed = true
      for (const job of jobs.values()) job.control.abort()
      await Promise.allSettled([...jobs.values()].flatMap((job) => [job.preflight, job.promise]))
      for (const job of jobs.values()) {
        if (!ended(job)) { job.status = 'interrupted'; persist(job) }
        rmSync(job.temp, { recursive: true, force: true })
      }
    },
  }
}
