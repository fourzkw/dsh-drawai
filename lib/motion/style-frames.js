/* Read pre-collected reference images; never run a demo or fetch assets. */
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { listStyleReferenceFrames } from './style-reference-store.js'

function selectEvenly(frames, count) {
  if (count >= frames.length) return frames.map((entry) => ({ entry }))
  if (count === 1) return [{ entry: frames[0] }]
  return Array.from({ length: count }, (_, index) => ({ entry: frames[Math.round(index * (frames.length - 1) / (count - 1))] }))
}

function selectNearest(frames, times, duration) {
  const selected = [], seen = new Set()
  for (const input of times.slice(0, 24)) {
    const time = Number(input)
    if (!Number.isFinite(time) || time < 0 || (duration !== null && time > duration)) continue
    const entry = frames.reduce((best, next) => Math.abs(next.time - time) < Math.abs(best.time - time) ? next : best)
    if (!seen.has(entry.id)) { seen.add(entry.id); selected.push({ entry, requestedTime: time }) }
  }
  return selected
}

function copyToDirectory(frame, dir) {
  const destination = join(dir, basename(frame.path))
  if (destination === frame.path) return destination
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) throw new Error('参考帧输出目标不能是符号链接：' + destination)
    const hash = createHash('sha256').update(readFileSync(destination)).digest('hex')
    if (hash !== frame.sha256) throw new Error('参考帧输出文件已存在且内容不同，请换目录：' + destination)
  } else {
    copyFileSync(frame.path, destination, constants.COPYFILE_EXCL)
  }
  return destination
}

/** Return existing images and their source-video times, maintaining the frames tool's output shape. */
export async function captureStyleFrames({ slug, times: explicitTimes, count = 8, directory, signal } = {}) {
  signal?.throwIfAborted()
  if (typeof slug !== 'string' || !slug) throw new Error('获取风格参考帧需要 slug')
  const frames = listStyleReferenceFrames({ slug }).sort((a, b) => a.time - b.time)
  if (!frames.length) throw new Error('本地没有可用参考帧：' + slug)
  const first = frames[0], duration = first.sourceDuration
  const wanted = Math.max(1, Math.min(24, Math.floor(Number(count) || 8)))
  const byTime = Array.isArray(explicitTimes) && explicitTimes.length > 0
  const selected = byTime ? selectNearest(frames, explicitTimes, duration) : selectEvenly(frames, wanted)
  if (!selected.length) throw new Error('没有有效的参考帧时间点：' + slug + '；时间使用来源视频的秒数。')
  let dir = dirname(first.path)
  if (directory !== undefined) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('参考帧输出目录无效')
    mkdirSync(resolve(directory), { recursive: true })
    dir = realpathSync(resolve(directory))
  }
  const files = selected.map(({ entry, requestedTime }) => {
    signal?.throwIfAborted()
    return {
      time: entry.time, frame: entry.frame, path: directory === undefined ? entry.path : copyToDirectory(entry, dir), bytes: entry.bytes,
      id: entry.id, sha256: entry.sha256, ...(requestedTime === undefined ? {} : { requestedTime }),
    }
  })
  const notes = ['参考帧来自本地静态素材，未运行上游演示；所列时间为来源视频时间。']
  if (first.timeNote) notes.push(first.timeNote + '素材只覆盖水墨场景的短片段，不代表完整风格片。')
  if (byTime) notes.push('指定时间返回最近的预置帧并去重，time 是素材实际时间，requestedTime 是请求时间。')
  else if (wanted > frames.length) notes.push('请求 ' + wanted + ' 张，本地仅有 ' + frames.length + ' 张，已返回全部实际素材。')
  return {
    slug: first.slug, width: first.width, height: first.height, fps: first.fps, duration,
    times: files.map((file) => file.time), directory: dir, files, notes,
    source: first.source, license: first.license, timeBasis: first.timeBasis,
  }
}
