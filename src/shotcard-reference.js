import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureFfmpeg } from './ffmpeg-manager.js'
import { motionCardContract } from './motion-library.js'
const exec = promisify(execFile)

// Only canonical catalog URLs are fetched; no model-provided URLs or executable paths.
export async function prepareReferenceFrames(composition, directory, options = {}) {
  mkdirSync(directory, { recursive: true })
  const result = []
  const selections = [...new Map(composition.shots.flatMap((shot) => shot.motionCards || []).map((item) => [item.cardId + ':' + item.styleKey, item])).values()]
  for (const selection of selections) {
    const contract = motionCardContract(selection)
    const prefix = 'reference-' + contract.styleKey
    try {
      const video = join(directory, prefix + '.mp4')
      if (!existsSync(video)) {
        const response = await (options.fetch || fetch)(contract.previewUrl, { signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(20000)]), redirect: 'error' })
        if (!response.ok) throw new Error('参考样片 HTTP ' + response.status)
        if (Number(response.headers.get('content-length')) > 32 * 1024 * 1024) throw new Error('参考样片超过 32MB')
        const chunks = []; let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 32 * 1024 * 1024) { await response.body.cancel?.().catch(() => {}); throw new Error('参考样片超过 32MB') }
          chunks.push(chunk)
        }
        writeFileSync(video + '.tmp', Buffer.concat(chunks)); renameSync(video + '.tmp', video)
      }
      const binary = options.ffmpegPath || await ensureFfmpeg({ signal: options.signal })
      let info = ''
      try { const probe = await exec(binary, ['-hide_banner', '-i', video], { windowsHide: true, timeout: 15000, signal: options.signal }); info = probe.stderr }
      catch (error) { info = error.stderr || ''; if (!info) throw error }
      const match = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(info)
      const duration = match && Number(match[1]) * 3600 + Number(match?.[2]) * 60 + Number(match?.[3])
      if (!duration || duration > 120) throw new Error('无法读取参考样片时长')
      const frames = []
      for (const fraction of [0, .25, .5, .75, .98]) {
        const filename = prefix + '-' + Math.round(fraction * 100) + '.png'
        const timestamp = Math.min(Math.max(0, duration - .25), duration * fraction)
        await exec(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(timestamp), '-i', video,
          '-frames:v', '1', '-vf', 'scale=960:-2', join(directory, filename)], { windowsHide: true, timeout: 20000, signal: options.signal })
        frames.push({ filename, requestedFraction: fraction, fraction: timestamp / duration, timestamp, sha256: createHash('sha256').update(readFileSync(join(directory, filename))).digest('hex') })
      }
      result.push({ cardId: contract.cardId, styleKey: contract.styleKey, demo: contract.demo, demoSha256: contract.demoSha256,
        previewUrl: contract.previewUrl, videoFilename:prefix+'.mp4',videoSha256: createHash('sha256').update(readFileSync(video)).digest('hex'), duration, status: 'ready', frames })
    } catch (error) {
      if (options.signal?.aborted) throw error
      result.push({ cardId: contract.cardId, styleKey: contract.styleKey, status: 'unavailable', reason: error.message, frames: [] })
    }
  }
  return result
}
