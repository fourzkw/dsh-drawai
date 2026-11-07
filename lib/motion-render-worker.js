/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { ensureVideoRuntime, videoRuntimeRequire } from './motion/video-runtime.js'
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareMotionProject } from './motion-project.js'
import { runFfmpeg } from './motion/ffmpeg.js'

let cancelled = false, running = false
const runtimeAbort = new AbortController()
let cancel = () => {}
const send = (message) => { if (process.connected) process.send(message) }
process.on('message', async (request) => {
  if (request.type === 'cancel') { cancelled = true; runtimeAbort.abort(new Error('已取消动效生成')); cancel(); return }
  if (running) return
  running = true
  let browser
  const outDir = request.bundleDir || join(dirname(request.output), 'bundle')
  const cacheFile = join(outDir, '.drawai-bundle-key')
  try {
    const runtimeDirectory = await ensureVideoRuntime({signal:runtimeAbort.signal, onProgress:message => send({type:'progress', ...message, progress:0})})
    if (cancelled) throw new Error('已取消动效生成')
    const require = videoRuntimeRequire(runtimeDirectory)
    const { bundle } = require('@remotion/bundler')
    const { openBrowser, selectComposition, renderMedia, renderStill, makeCancelSignal } = require('@remotion/renderer')
    const cancellation = makeCancelSignal()
    const cancelSignal = cancellation.cancelSignal
    cancel = cancellation.cancel
    // 同一个工程连续预览/渲染时复用上次的 bundle：预览从 30 秒降到 3 秒，
    // 改一个场景文件只会让 key 变化一次。request.bundleKey 由调用方按源码计算。
    const reuse = request.reuseBundle === true && request.bundleKey && existsSync(join(outDir, 'index.html'))
      && existsSync(cacheFile) && readFileSync(cacheFile, 'utf8').trim() === request.bundleKey
    let serveUrl
    if (reuse) {
      serveUrl = outDir
      send({ type: 'progress', phase: 'bundling', progress: .1 })
    } else {
      const project = prepareMotionProject(request.composition, request.projectDirectory || join(dirname(request.output), 'project'), {preserveSources:request.preserveSources===true, runtimeDirectory})
      serveUrl = await bundle({ ...project, outDir, ignoreRegisterRootWarning: true,
        publicDir: request.publicDir, onProgress: (progress) => send({ type: 'progress', phase: 'bundling', progress: progress / 100 * .1 }) })
      const index = join(outDir, 'index.html')
      writeFileSync(index, readFileSync(index, 'utf8').replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data:; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\'; img-src \'self\' blob: data:; media-src \'self\' blob:; frame-src \'none\'; object-src \'none\'">'))
      if (request.bundleKey) writeFileSync(cacheFile, request.bundleKey)
    }
    if (cancelled) throw new Error('已取消动效生成')
    // Use a configured browser, or a local Windows browser before downloading Chromium.
    const candidates = [request.browserExecutable, process.env.DRAWAI_CHROME_PATH,
      'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    const browserExecutable = candidates.find((path) => path && existsSync(path))
    browser = await openBrowser('chrome', { browserExecutable, logLevel: 'error' })
    if (cancelled) throw new Error('已取消动效生成')
    const inputProps = { plan: request.composition, assets: request.assets }
    const composition = await selectComposition({ serveUrl, id: 'DrawAiMotion', inputProps, browserInstance: browser })
    if(request.operation==='compile'){send({type:'done',compiled:true});return}
    send({ type: 'progress', phase: 'reviewing', progress: .1 })
    const qaDirectory = request.qaDirectory || join(dirname(request.output), 'qa'); mkdirSync(qaDirectory, { recursive: true })
    const audioCues = Array.isArray(request.composition?.audio) ? request.composition.audio : []
    const qa = { status: 'render-checks-passed', visualReview: 'manual-required', audio: audioCues.length ? 'mixed:' + audioCues.length : 'silent', frames: [], warnings: [] }
    if(request.operation==='still'){
      const frames=[]
      for(const frame of request.frames){
        if(!Number.isInteger(frame)||frame<0||frame>=composition.durationInFrames)throw new Error('截图帧超出成片')
        const filename='agent-frame-'+frame+'.png'
        await renderStill({serveUrl,composition,inputProps,output:join(qaDirectory,filename),frame,browserInstance:browser,cancelSignal,logLevel:'error'})
        frames.push({frame,filename,sha256:createHash('sha256').update(readFileSync(join(qaDirectory,filename))).digest('hex')})
      }
      send({type:'done',frames});return
    }
    for (const shot of request.composition.shots) {
      const hashes = []
      for (const fraction of (shot.motionCards?.length ? [0, .25, .5, .75, .98] : [.25, .7])) {
        const frame = shot.startFrame + Math.min(shot.durationFrames - 1, Math.floor(shot.durationFrames * fraction))
        const filename = shot.id + '-' + frame + '.png'
        await renderStill({ serveUrl, composition, inputProps, output: join(qaDirectory, filename), frame, browserInstance: browser, cancelSignal, logLevel: 'error', timeoutInMilliseconds: 30000 })
        const bytes = readFileSync(join(qaDirectory, filename))
        const hash = createHash('sha256').update(bytes).digest('hex'); hashes.push(hash)
        qa.frames.push({ shotId: shot.id, frame, filename, fraction, sha256: hash })
      }
      if (hashes[0] === hashes[1]) qa.warnings.push(shot.id + ': 两张采样帧相同，请检查主运动或停留段')
    }
    // 渲染规格随请求进来（由 render.js 的 resolveRenderSettings 解析过）：
    // 编码参数、色彩标签、超采样倍数、并发都在这里唯一地落到 renderMedia 上。
    const settings = request.render || {}
    qa.render = settings
    writeFileSync(join(qaDirectory, 'report.json'), JSON.stringify(qa, null, 2))
    const scale = Number(settings.scale) > 1 ? Math.round(Number(settings.scale)) : 1
    const finalOutput = request.output
    // 超采样：Remotion 的 scale 是「渲成更大」，不会替你缩回来。
    // 所以大图先落到临时文件，再用一次 lanczos + bt709 的母版编码缩回目标尺寸。
    const rawOutput = scale > 1 ? join(dirname(finalOutput), '.supersample.mp4') : finalOutput
    const startedAt = Date.now()
    let seenFrames = 0
    const totalFrames = request.frameRange
      ? request.frameRange[1] - request.frameRange[0] + 1
      : composition.durationInFrames
    await renderMedia({ serveUrl, composition, inputProps, outputLocation: rawOutput,
      codec: settings.codec || 'h264',
      ...(settings.crf ? { crf: settings.crf } : {}),
      ...(settings.preset ? { x264Preset: settings.preset } : {}),
      ...(settings.pixelFormat ? { pixelFormat: settings.pixelFormat } : {}),
      ...(settings.colorSpace ? { colorSpace: settings.colorSpace } : {}),
      ...(settings.audioBitrate ? { audioBitrate: settings.audioBitrate } : {}),
      scale,
      concurrency: settings.concurrency || 2,
      ...(request.frameRange?{frameRange:request.frameRange}:{}),
      browserInstance: browser, cancelSignal, logLevel: 'error',
      onProgress: ({ progress, renderedFrames }) => {
        const done = Number(renderedFrames) || 0
        if (done > seenFrames) seenFrames = done
        const elapsed = (Date.now() - startedAt) / 1000
        const perFrame = seenFrames > 0 ? elapsed / seenFrames : null
        // 单帧耗时是「样本数该开多大」的唯一依据：没有它，超采样只能靠猜。
        send({ type: 'progress', phase: 'rendering', progress: .1 + progress * .85,
          frames: { done: seenFrames, total: totalFrames,
            perFrameSeconds: perFrame ? Math.round(perFrame * 1000) / 1000 : null,
            etaSeconds: perFrame ? Math.round(perFrame * Math.max(totalFrames - seenFrames, 0)) : null } })
      } })
    if (scale > 1) {
      send({ type: 'progress', phase: 'encoding', progress: .96 })
      // 这一趟本来就是重编码，顺手把 bt709 三标签补全。
      // 注意：这个 ffmpeg 构建里 -color_primaries / -color_trc 当**输出选项**不生效
      // （连续实测：只剩 colorspace 标签，primaries/trc 仍是 unknown），必须走 setparams 滤镜改帧元数据。
      const colorFilter = settings.colorSpace === 'bt709'
        ? ',setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709' : ''
      await runFfmpeg(['-i', rawOutput,
        '-vf', 'scale=' + composition.width + ':' + composition.height + ':flags=lanczos+accurate_rnd+full_chroma_int' + colorFilter,
        '-c:v', 'libx264', '-crf', String(settings.crf || 14), '-preset', String(settings.preset || 'slow'),
        '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'copy', '-movflags', '+faststart', finalOutput],
        { cwd: dirname(finalOutput), log: join(dirname(finalOutput), 'encode.log'), timeoutMs: 900000 })
      rmSync(rawOutput, { force: true })
      qa.supersample = { from: composition.width * scale + 'x' + composition.height * scale, to: composition.width + 'x' + composition.height }
      qa.colorTags = settings.colorSpace === 'bt709' ? 'bt709（三标签齐全）' : '未标注'
    } else if (settings.colorSpace === 'bt709') {
      // Remotion 只写 colorspace，primaries/trc 留 unknown；要齐全只能再重编一次，
      // 而重编会让画质掉一代——所以 1× 下宁可把这件事说清楚，不偷偷多编一遍。
      qa.colorTags = '仅 colorspace=bt709（primaries/trc 为 unknown；母版级标签请设 render.scale=2）'
      qa.warnings.push('色彩标签只写了 colorspace：要 primaries/trc 齐全（严格 QC）请用 render.scale=2，那一趟重编码会一并补齐')
    }
    const posterShot = request.composition.shots.find((shot) => shot.referenceIds.length) || request.composition.shots[0]
    await renderStill({ serveUrl, composition, inputProps, output: request.poster,
      frame: posterShot.startFrame + Math.floor(posterShot.durationFrames / 2), browserInstance: browser, cancelSignal, logLevel: 'error' })
    writeFileSync(join(qaDirectory, 'report.json'), JSON.stringify(qa, null, 2))
    send({ type: 'done', qa })
  } catch (error) { send({ type: 'error', error: error.message || String(error) }); process.exitCode = 1 }
  finally {
    await browser?.close({ silent: true }).catch(() => {})
    const cleanup = relative(resolve(dirname(request.output)), resolve(outDir))
    if (request.keepBundle !== true && cleanup === 'bundle' && !isAbsolute(cleanup)) rmSync(outDir, { recursive: true, force: true })
    process.disconnect()
  }
})
