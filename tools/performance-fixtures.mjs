// Deterministic, redistributable synthetic corpus. Never downloads user media.
import { deflateSync } from 'node:zlib'

export function fixtureCases(suite = 'smoke') {
  if (suite === 'smoke') return ['static', 'motion', 'cuts', 'complex', 'transparent'].map((pattern, i) => ({ id: 'smoke-' + pattern, pattern, width: 160, height: 90, fps: i % 2 ? 29.97 : 30, count: 4 }))
  if (suite === 'standard') return [480, 1080].flatMap((height) => [30, 29.97].flatMap((fps) => ['static', 'motion', 'cuts', 'complex', 'transparent'].map((pattern) => ({
    id: pattern + '-' + height + 'p-' + fps, pattern, width: height === 480 ? 854 : 1920, height, fps, count: 30,
  }))))
  if (suite === 'stress') return [
    { id: 'complex-4k', pattern: 'complex', width: 3840, height: 2160, fps: 30, count: 30 },
    { id: 'motion-long', pattern: 'motion', width: 854, height: 480, fps: 30, count: 1800 },
  ]
  throw new Error('suite must be smoke, standard or stress')
}

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, -4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
export function fixturePng(spec, index) {
  const { width: w, height: h, pattern } = spec, rows = Buffer.alloc(h * (w * 4 + 1), 255)
  const frame = pattern === 'static' ? 0 : index
  for (let y = 0; y < h; y++) {
    rows[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const at = y * (w * 4 + 1) + 1 + x * 4
      const moving = ((x - frame * 3 + w) % w) < w / 3 && y > h / 4 && y < h * 3 / 4
      if (pattern === 'complex') {
        rows[at] = (x * 3 + y + frame * 7) % 256; rows[at + 1] = (x + y * 5) % 256; rows[at + 2] = (x ^ y ^ frame * 9) % 256
      } else if (pattern === 'cuts') {
        rows[at] = frame % 2 ? 30 : 230; rows[at + 1] = frame % 2 ? 170 : 40; rows[at + 2] = 90
      } else if (moving) { rows[at] = 25; rows[at + 1] = 85; rows[at + 2] = 190 }
      if (pattern === 'transparent') rows[at + 3] = moving ? 180 : 0
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
