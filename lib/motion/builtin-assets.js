// Small original, deterministic assets for common motion-graphics treatments.
// Generated locally; the project owns its copy and users can edit it freely.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAssets, writeAssets } from './assets.js'
import { parseProjectJson } from './json.js'

const paper = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="4" seed="11" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="512" height="512" fill="#eee5d3"/><rect width="512" height="512" filter="url(#n)" opacity=".16" style="mix-blend-mode:multiply"/></svg>`
const grain = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="23" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="256" height="256" filter="url(#n)"/></svg>`
const grid = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><path d="M0 0H128 M0 0V128 M32 0V128 M64 0V128 M96 0V128 M0 32H128 M0 64H128 M0 96H128" fill="none" stroke="#ffffff" stroke-opacity=".22" stroke-width="1"/></svg>`

// 16-bit mono PCM; deterministic oscillator/noise with short fades at both ends.
function wave(seconds, sample) {
  const rate = 44100, count = Math.floor(rate * seconds), data = Buffer.alloc(44 + count * 2)
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(count * 2, 40)
  let state = 20261106, smooth = 0
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const noise = state / 2147483648 - 1
    smooth += (noise - smooth) * .15
    const t = i / rate, envelope = Math.min(1, t / .012, (seconds - t) / .06)
    const value = Math.max(-1, Math.min(1, sample(t, seconds, smooth) * envelope))
    data.writeInt16LE(Math.round(value * 32767), 44 + i * 2)
  }
  return data
}

const ASSETS = [
  { file: 'builtin/paper.svg', caption: '暖色纸张纹理，可平铺', kind: 'vector', data: () => Buffer.from(paper) },
  { file: 'builtin/grain.svg', caption: '灰度颗粒叠层，建议低不透明度混合', kind: 'vector', data: () => Buffer.from(grain) },
  { file: 'builtin/grid.svg', caption: '透明白色网格，可平铺', kind: 'vector', data: () => Buffer.from(grid) },
  { file: 'builtin/whoosh.wav', caption: '合成的短扫过声', kind: 'audio', seconds: .6, data: () => wave(.6, (t, d, n) => n * .75 * Math.sin(Math.PI * t / d)) },
  { file: 'builtin/impact.wav', caption: '合成的短低频落点声', kind: 'audio', seconds: .4, data: () => wave(.4, (t, d, n) => (Math.sin(2 * Math.PI * (115 * t - 70 * t * t)) * .55 + n * .18) * Math.exp(-10 * t)) },
]

export function writeBuiltinAssets(projectDir) {
  const dir = join(projectDir, 'assets'), index = join(dir, 'manifest.json'), added = []
  // Never repair a damaged user manifest by overwriting it with an empty one.
  if (existsSync(index)) {
    try { if (!Array.isArray(parseProjectJson(readFileSync(index, 'utf8')).items)) return added } catch { return added }
  }
  const manifest = readAssets(projectDir)
  for (const item of ASSETS) {
    const target = join(dir, item.file), data = item.data()
    const sha256 = createHash('sha256').update(data).digest('hex')
    mkdirSync(join(dir, 'builtin'), { recursive: true })
    if (!existsSync(target)) writeFileSync(target, data)
    // Do not replace or mislabel a user-edited file on a repeated create.
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256) continue
    if (manifest.items.some((entry) => entry.file === item.file)) continue
    manifest.items.push({ id: 'drawai-' + item.file.slice(8).replace(/\.[^.]+$/, ''), file: item.file,
      bytes: data.length, sha256, kind: item.kind, caption: item.caption,
      source: 'DrawAI 原创程序生成（MIT）', ...(item.seconds ? { seconds: item.seconds } : {}) })
    added.push(item.file)
  }
  if (added.length) writeAssets(projectDir, manifest)
  return added
}
