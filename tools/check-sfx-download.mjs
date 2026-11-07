import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSfx } from '../src/motion/sfx.js'
import { sourceFreesound, importAudioFile } from '../src/audio-media.js'
import { runFfmpeg } from '../src/motion/ffmpeg.js'

mkdirSync('.tmp', { recursive: true })
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'sfx-check-')), originalFetch = globalThis.fetch
let links = '', calls = []
try {
  const mp3 = join(dir, 'sound.mp3')
  await runFfmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=0.3', mp3], { cwd: dir })
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('cdn.freesound.org')) return new Response(readFileSync(mp3), { headers: { 'content-type': 'audio/mpeg' } })
    const response = new Response('<div data-sound-id="123" data-mp3="https://cdn.freesound.org/sound-hq.mp3" data-duration="0.3" data-title="Test"></div>' + links, { headers: { 'content-type': 'text/html' } })
    Object.defineProperty(response, 'url', { value: 'https://freesound.org/people/test/sounds/123/' })
    return response
  }
  const project = join(dir, 'project')
  let result = await getSfx(project, ['fs:123'])
  assert.equal(result.results[0].ok, true, '缺少许可仍可下载')
  assert.ok(existsSync(join(project, 'assets', 'audio-manifest.json')))
  assert.ok(!existsSync(join(project, 'assets', 'FREESOUND-CREDITS.md')))
  links = '<a href="https://creativecommons.org/licenses/by-nc/4.0/">NC</a><a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>'
  const staging = join(dir, 'staging')
  result = await sourceFreesound('get', { id: 'fs:123', license: 'cc0' }, staging)
  assert.equal(result.results[0].ok, true, '多个或不匹配许可均不拦截；旧筛选参数不再生效')
  assert.deepEqual(readdirSync(join(staging, 'assets')), ['sfx'], '中转目录只下载素材，不产生清单副本')
  const imported = await importAudioFile(join(dir, 'canvas.drawai'), join(staging, result.results[0].asset.file))
  // Use the public result to locate metadata without assuming media-root naming.
  const { clipDirFor } = await import('../src/media.js')
  const files = readdirSync(clipDirFor(join(dir, 'canvas.drawai'), imported.clip))
  assert.ok(files.includes('audio.wav') && files.includes('audio.json') && files.includes('preview.m4a'))
  assert.ok(!files.some((name) => /CREDITS|analysis\.log|^original/.test(name)), '导入不再保存重复署名、分析日志和原始副本')
  console.log('SFX checks passed: missing/ambiguous licenses, no policy gate, single metadata index, minimal imported files')
} finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) }
