import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, truncateSync } from 'node:fs'
import { createServer } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { openBrowser } from '@remotion/renderer'
import { ffmpegBinary } from '../src/video-export.js'
import { ensureClipPack, importSourceFile } from '../src/media.js'
import * as plugin from '../lib/index.js'

mkdirSync('artifacts', { recursive: true })
const root = mkdtempSync(resolve('artifacts/large-video-playback-'))
let server, browser
try {
  const canvas = join(root, 'demo.drawai'), input = join(root, 'input.mp4')
  execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', input], { windowsHide: true })
  truncateSync(input, 54 * 1024 * 1024 + 17)
  const clip = 'movie', { dir } = ensureClipPack(canvas, clip, { kind: 'raster', w: 320, h: 180 })
  importSourceFile(dir, input)
  let route
  plugin.apply({ tools: { register() { return () => {} } }, webServer: { register(value) { route = value; return () => {} } },
    fs: { async resolve(p, options) { return { path: resolve(options?.cwd || root, p) } }, processPath(t) { return t.path },
      contains(a, b) { const r = relative(a.path, b.path); return !isAbsolute(r) && r !== '..' && !/^[.][.][\\/]/.test(r) } },
    sessions: { get(id) { return id === 's' ? { header: { cwd: root } } : undefined } },
    sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: root } } }, effect(fn) { return fn() } })
  const ranges = []
  server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><video muted playsinline></video>'); return }
    if (req.method === 'GET') ranges.push(req.headers.range || '')
    route.handler(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const reply = await fetch(origin + '/drawai/api/save', { method: 'POST', headers: { 'content-type': 'application/json', 'x-drawai-save': '1' },
    body: JSON.stringify({ action: 'media-source-url', sessionId: 's', path: 'demo.drawai', clip }) })
  const ticket = await reply.json(); assert.equal(ticket.ok, true)
  browser = await openBrowser('chrome', { browserExecutable: process.env.DRAWAI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', logLevel: 'error' })
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} })
  await page.goto({ url: origin, timeout: 30000 })
  const result = await page.evaluate(async (url) => {
    const video = document.querySelector('video')
    const wait = (event) => new Promise((resolveEvent, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), 15000)
      video.addEventListener(event, () => { clearTimeout(timer); resolveEvent() }, { once: true })
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video decode failed')) }, { once: true })
    })
    const metadata = wait('loadedmetadata'); video.src = url; video.load(); await metadata
    const seek = wait('seeked'); video.currentTime = 1.5; await seek
    await video.play()
    const played = wait('timeupdate'); await played
    return { duration: video.duration, time: video.currentTime, width: video.videoWidth }
  }, ticket.url)
  assert.ok(result.duration >= 2.9 && result.time >= 1.5 && result.width === 320)
  assert.ok(ranges.some(Boolean), 'browser requests byte ranges')
  console.log('Large playback: browser decoded, sought, and played a 54 MiB MP4 from the actual range-streaming endpoint.')
} finally {
  await browser?.close({ silent: true }).catch(() => {})
  if (server) await new Promise((resolveClose) => server.close(resolveClose))
  rmSync(root, { recursive: true, force: true })
}
