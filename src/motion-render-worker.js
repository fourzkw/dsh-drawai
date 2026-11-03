import { bundle } from '@remotion/bundler'
import { openBrowser, selectComposition, renderMedia, renderStill, makeCancelSignal } from '@remotion/renderer'
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareMotionProject } from './motion-project.js'

let cancelled = false, running = false
const { cancelSignal, cancel } = makeCancelSignal()
const send = (message) => { if (process.connected) process.send(message) }
process.on('message', async (request) => {
  if (request.type === 'cancel') { cancelled = true; cancel(); return }
  if (running) return
  running = true
  let browser
  const outDir = request.bundleDir || join(dirname(request.output), 'bundle')
  const cacheFile = join(outDir, '.drawai-bundle-key')
  try {
    // 同一个工程连续预览/渲染时复用上次的 bundle：预览从 30 秒降到 3 秒，
    // 改一个场景文件只会让 key 变化一次。request.bundleKey 由调用方按源码计算。
    const reuse = request.reuseBundle === true && request.bundleKey && existsSync(join(outDir, 'index.html'))
      && existsSync(cacheFile) && readFileSync(cacheFile, 'utf8').trim() === request.bundleKey
    let serveUrl
    if (reuse) {
      serveUrl = outDir
      send({ type: 'progress', phase: 'bundling', progress: .1 })
    } else {
      const project = prepareMotionProject(request.composition, request.projectDirectory || join(dirname(request.output), 'project'), {preserveSources:request.preserveSources===true})
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
    writeFileSync(join(qaDirectory, 'report.json'), JSON.stringify(qa, null, 2))
    await renderMedia({ serveUrl, composition, inputProps, codec: 'h264', outputLocation: request.output,
      ...(request.frameRange?{frameRange:request.frameRange}:{}),
      browserInstance: browser, cancelSignal, concurrency: 2, logLevel: 'error',
      onProgress: ({ progress }) => send({ type: 'progress', phase: 'rendering', progress: .1 + progress * .85 }) })
    const posterShot = request.composition.shots.find((shot) => shot.referenceIds.length) || request.composition.shots[0]
    await renderStill({ serveUrl, composition, inputProps, output: request.poster,
      frame: posterShot.startFrame + Math.floor(posterShot.durationFrames / 2), browserInstance: browser, cancelSignal, logLevel: 'error' })
    send({ type: 'done', qa })
  } catch (error) { send({ type: 'error', error: error.message || String(error) }); process.exitCode = 1 }
  finally {
    await browser?.close({ silent: true }).catch(() => {})
    const cleanup = relative(resolve(dirname(request.output)), resolve(outDir))
    if (request.keepBundle !== true && cleanup === 'bundle' && !isAbsolute(cleanup)) rmSync(outDir, { recursive: true, force: true })
    process.disconnect()
  }
})
