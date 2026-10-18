/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { ffmpegBinary } from './video-export.js'
import { ensureClipPack, writeManifest, clipDirFor, mediaRootFor, frameFileName, STILLS_DIR, stillFileName } from './media.js'

function checkMediaDirectory(job, path) {
  const rel = relative(realpathSync(job.scope.workspaceRoot), realpathSync(path))
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('媒体目录超出工作区')
}

export async function runMediaCommand(args, signal, onProgress, binary = ffmpegBinary()) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-nostdin', '-nostats', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    child.stdout.on('data', (bytes) => {
      stdout = (stdout + bytes.toString()).slice(-65536)
      const matches = [...stdout.matchAll(/frame=(\d+)/g)]; if (matches.length) onProgress?.(Number(matches.at(-1)[1]))
    })
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-32768) })
    child.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(new Error(error.code === 'ENOENT' ? '未找到 FFmpeg，请安装或设置 DRAWAI_FFMPEG_PATH' : error.message)) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('已取消任务'))
      else if (code !== 0) reject(new Error('FFmpeg 处理失败：' + stderr.trim()))
      else resolve({ stdout, stderr })
    })
  })
}

const inputArgs = (file) => ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', file]

export async function probeDrawingVideo(file, signal, binary) {
  // Only FFmpeg is required. The null pass reports the actual decoded endpoint
  // (including fractional duration), unlike the rounded "Duration:" header.
  const result = await runMediaCommand([...inputArgs(file), '-map', '0:v:0', '-an', '-sn', '-fps_mode', 'passthrough',
    '-progress', 'pipe:1', '-f', 'null', '-'], signal, null, binary)
  const times = [...result.stdout.matchAll(/out_time_us=(\d+)/g)]
  const videos = [...result.stderr.matchAll(/Video:[^\r\n]*?\b(\d{1,5})x(\d{1,5})\b([^\r\n]*)/g)]
  const video = videos.at(-1)
  if (!video || !times.length) throw new Error('无法探测视频尺寸或时长')
  const sar = /SAR (\d+):(\d+)/.exec(video[3])
  const w = Math.round(Number(video[1]) * (sar ? Number(sar[1]) / Number(sar[2]) : 1))
  const h = Number(video[2]), duration = Number(times.at(-1)[1]) / 1000000
  if (!(w > 0 && h > 0 && duration > 0)) throw new Error('视频尺寸或时长无效')
  return { w, h, duration }
}

export function planDrawingVideo(options, info, extract = false) {
  const from = options.range === 'all' ? 0 : Number(options.from || 0)
  const end = options.range === 'all' || options.end === '' ? info.duration : options.end !== undefined ? Number(options.end) : from + Number(options.seconds)
  const fps = Number(options.fps)
  const width = options.resolution === undefined || options.resolution === 'custom' ? Number(options.width) : Number(options.resolution)
  if (!Number.isFinite(from) || from < 0 || from >= info.duration || !Number.isFinite(end) || end <= from) throw new Error('绘制时间范围无效')
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(width) || width < 0 || width > 16384 || (options.resolution === 'custom' && !width)) throw new Error('帧率或采样尺寸无效')
  const raw = (Math.min(end, info.duration) - from) * fps
  let count = Math.max(1, Math.ceil(raw - Math.min(1e-7, raw * Number.EPSILON * 4)))
  if (extract) {
    const max = options.max ?? 1200
    if (!Number.isInteger(max) || max < 1 || max > 1200) throw new Error('抽帧数量上限必须为 1 至 1200')
    count = Math.min(count, max)
  }
  if (!Number.isSafeInteger(count) || count > 1000000) throw new Error('预计帧数超出 100 万帧上限')
  const scale = width === 0 ? 1 : extract ? width / info.w : Math.min(1, width / Math.max(info.w, info.h))
  const w = Math.max(1, Math.round(info.w * scale)), h = Math.max(1, Math.round(info.h * scale))
  if (w * h > 16000000 || Math.max(w, h) > 16384) throw new Error('单帧处理上限为 1600 万像素、长边 16384px')
  return { from, fps, count, w, h, maxBytes: options.level === 'low' ? 60000 : options.level === 'high' ? 248000 : 120000 }
}

async function* rawVideoFrames(job, signal, binary, perf) {
  const decodeDone = perf?.start('decodePipelineWall')
  const { plan } = job, offset = job.done || 0
  const child = spawn(binary || ffmpegBinary(), ['-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', String(plan.from), ...inputArgs(job.input), '-map', '0:v:0', '-an', '-sn',
    '-filter_threads', '1', '-vf', 'tpad=stop_mode=clone:stop_duration=' + (1 / plan.fps) + ',fps=fps=' + plan.fps + ':start_time=0:round=near,scale=' + plan.w + ':' + plan.h + ':flags=bicubic,setsar=1,format=rgba,trim=start_frame=' + offset + ',setpts=PTS-STARTPTS',
    '-frames:v', String(plan.count - offset), '-fps_mode', 'passthrough', '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = '', error
  const abort = () => child.kill()
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-8000) })
  const completed = new Promise((resolve) => {
    child.on('error', (value) => { error = value; resolve(-1) }); child.on('close', resolve)
  })
  const size = plan.w * plan.h * 4
  let frame = Buffer.alloc(size), filled = 0
  try {
    for await (const chunk of child.stdout) {
      for (let offset = 0; offset < chunk.length;) {
        const take = Math.min(size - filled, chunk.length - offset)
        chunk.copy(frame, filled, offset, offset + take); offset += take; filled += take
        if (filled === size) { yield frame; frame = Buffer.alloc(size); filled = 0 }
      }
    }
    const code = await completed
    if (signal.aborted) throw new Error('已取消任务')
    if (code !== 0 || filled) throw new Error(error?.message || '视频解码失败或像素帧不完整：' + stderr)
  } finally { signal.removeEventListener('abort', abort); child.kill(); await completed; decodeDone?.() }
}

export async function executeDrawing(job, context) {
  const { pool, signal, update, checkpoint, perf } = context
  if (job.kind === 'image') {
    update({ phase: 'tracing', total: 1, message: '正在分析图片与生成色块' })
    const output = await pool.run(readFileSync(job.input), { ...job.options, mode: 'image', profile: perf?.enabled }, { token: job.id })
    perf?.merge('worker.', output.performance); perf?.add('workerQueueWait', output.queueWaitMs)
    job.done = 1; checkpoint(); return output
  }
  if (!job.info) {
    update({ phase: 'probing', message: '正在探测视频与采样范围' })
    const probeDone = perf?.start('videoProbe')
    job.info = await probeDrawingVideo(job.input, signal, context.ffmpegPath)
    probeDone?.()
    job.plan = planDrawingVideo(job.options, job.info, job.kind === 'extract'); checkpoint()
  }
  const plan = job.plan
  update({ phase: 'decoding', total: plan.count, message: '正在抽帧并绘制' })
  if (job.kind === 'extract') {
    const out = join(job.directory, 'stills'); mkdirSync(out, { recursive: true })
    await runMediaCommand(['-y', '-ss', String(plan.from), ...inputArgs(job.input), '-map', '0:v:0', '-an', '-filter_threads', '1',
      '-vf', 'tpad=stop_mode=clone:stop_duration=' + (1 / plan.fps) + ',fps=fps=' + plan.fps + ':start_time=0,scale=' + plan.w + ':' + plan.h + ',setsar=1',
      '-frames:v', String(plan.count), '-threads', '1', '-start_number', '1', '-progress', 'pipe:1', join(out, '%04d.png')],
    signal, (done) => update({ done, total: plan.count }), context.ffmpegPath)
    for (let i = 0; i < plan.count; i++) if (!existsSync(join(out, stillFileName(i)))) throw new Error('抽帧结果不完整')
    await (context.publishExtraction || (async (action) => action()))(() => {
      const clipDir = clipDirFor(job.scope.drawioAbs, job.source.clip)
      checkMediaDirectory(job, clipDir)
      const target = join(clipDir, STILLS_DIR), stage = mkdtempSync(join(clipDir, '.stills-')), backup = stage + '.previous'
      try {
        for (let i = 0; i < plan.count; i++) {
          if (signal.aborted) throw new Error('已取消抽帧')
          copyFileSync(join(out, stillFileName(i)), join(stage, stillFileName(i)))
        }
        if (existsSync(target)) renameSync(target, backup)
        try { renameSync(stage, target) }
        catch (error) { if (existsSync(backup) && !existsSync(target)) renameSync(backup, target); throw error }
        rmSync(backup, { recursive: true, force: true })
      } finally { rmSync(stage, { recursive: true, force: true }) }
    })
    job.done = plan.count; checkpoint(); return { written: plan.count, clip: job.source.clip }
  }
  const clip = job.outputClip || ('trace-' + job.id)
  const mediaRoot = mediaRootFor(job.scope.drawioAbs)
  if (existsSync(mediaRoot)) checkMediaDirectory(job, mediaRoot)
  const pack = ensureClipPack(job.scope.drawioAbs, clip, { kind: 'svg', w: plan.w, h: plan.h, fps: plan.fps })
  checkMediaDirectory(job, pack.dir)
  if (!job.outputClip) { job.outputClip = clip; checkpoint() }
  // Audio is immutable input owned by this task, not a live reference to the browser.
  const sourceName = 'source' + (job.source.extension || '.mp4')
  if (!existsSync(join(pack.dir, sourceName))) copyFileSync(job.input, join(pack.dir, sourceName))
  let manifest = { ...pack.manifest, source: sourceName, sourceOffset: plan.from, frames: pack.manifest.frames.slice(0, job.done || 0) }
  if (manifest.frames.length !== (job.done || 0)) throw new Error('绘制检查点缺少连续帧，请重新开始')
  let chain = ''
  for (let i = 0; i < manifest.frames.length; i++) {
    if (manifest.frames[i].file !== 'frames/' + frameFileName(i)) throw new Error('检查点帧顺序无效，请重新开始')
    const svg = readFileSync(join(pack.dir, manifest.frames[i].file), 'utf8')
    chain = createHash('sha256').update(chain).update(svg).digest('hex')
  }
  if (job.done && chain !== job.frameChain) throw new Error('检查点帧已变化，请重新开始')
  let previous = job.lastFrame ? Promise.resolve({ svg: readFileSync(join(pack.dir, 'frames', frameFileName(job.done - 1)), 'utf8'), paletteShared: false }) : null
  let previousHash = job.lastFrame || '', index = job.done || 0
  const pending = []
  const inFlight = Math.max(1, Math.min(pool.size, Math.floor(64 * 1024 * 1024 / (plan.w * plan.h * 8))))
  let checkpointAt = Date.now(), checkpointFrame = job.done || 0
  const flush = () => {
    writeManifest(pack.dir, manifest); checkpoint()
    checkpointAt = Date.now(); checkpointFrame = job.done
  }
  const commit = async () => {
    const item = pending.shift(), result = await item.promise
    if (signal.aborted) throw new Error('已取消任务')
    if (!item.reused) { perf?.merge('worker.', result.performance); perf?.add('workerQueueWait', result.queueWaitMs) }
    const commitDone = perf?.start('frameCommit')
    const file = join(pack.dir, 'frames', frameFileName(item.index))
    writeFileSync(file + '.tmp', result.svg); renameSync(file + '.tmp', file)
    manifest.frames.push({ file: 'frames/' + frameFileName(item.index), t: item.index / plan.fps })
    job.frameChain = createHash('sha256').update(job.frameChain || '').update(result.svg).digest('hex')
    if (!result.paletteShared && result.palette && !item.reused) { job.palette = result.palette; job.paletteIndex = item.index }
    job.done = item.index + 1; job.lastFrame = item.hash
    if (result.detailReduced) job.reducedFrames = (job.reducedFrames || 0) + 1
    if (!item.index) { job.poster = result.svg; writeFileSync(join(pack.dir, 'poster.svg'), result.svg) }
    update({ phase: 'tracing', done: job.done, total: plan.count, message: '已绘制 ' + job.done + '/' + plan.count + ' 帧' })
    if (!item.index || job.done === plan.count || job.done - checkpointFrame >= 30 || Date.now() - checkpointAt >= 500) flush()
    commitDone?.()
  }
  try {
    if (index < plan.count) for await (const rgba of rawVideoFrames(job, signal, context.ffmpegPath, perf)) {
      if (signal.aborted) throw new Error('已取消任务')
      if (context.pauseRequested()) break
      const hash = createHash('sha256').update(rgba).digest('hex')
      const shared = previous && hash === previousHash
      const options = { ...job.options, width: plan.w, height: plan.h, maxBytes: plan.maxBytes, profile: perf?.enabled }
      if (job.palette && index - job.paletteIndex < Math.max(1, Math.min(120, Math.round(plan.fps * 2)))) options.paletteOverride = job.palette
      const promise = shared ? previous : pool.runRaster({ width: plan.w, height: plan.h, data: rgba }, options, { token: job.id })
      // Attach immediately: a later frame can fail before an earlier one is awaited.
      promise.catch(() => {})
      pending.push({ index, promise, hash, reused: !!shared }); previous = promise; previousHash = hash; index++
      if (pending.length >= inFlight) await commit()
      if (index >= plan.count) break
    }
    while (pending.length) await commit()
    if (context.pauseRequested()) return null
    if (job.done !== plan.count) throw new Error('输出帧数不完整：预期 ' + plan.count + '，实际 ' + job.done)
    return { clip, ...plan, reducedFrames: job.reducedFrames || 0, poster: job.poster || readFileSync(join(pack.dir, 'poster.svg'), 'utf8') }
  } finally {
    await Promise.allSettled(pending.map((item) => item.promise))
    if (job.done !== checkpointFrame) flush()
  }
}
