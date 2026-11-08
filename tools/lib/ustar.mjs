/**
 * 打素材包用的最小 ustar 写入器（不依赖 tar 命令，Windows / macOS / Linux 行为一致）。
 *
 * 读回端在 `src/motion/asset-pack.js` 的 `readTar()`：只认普通文件的 ustar 头，
 * 长路径走 prefix 字段。改这里的字节布局要同步改那边。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 递归列出目录里的文件，返回 { full, rel }（rel 一律用 / 分隔）。 */
export function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, base, out)
    else if (entry.isFile()) out.push({ full, rel: relative(base, full).split(/[\\/]/).join('/') })
  }
  return out
}

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(512, 0)
  let short = name
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const parts = name.split('/')
    while (parts.length > 1 && Buffer.byteLength(parts.join('/')) > 100) prefix = parts.shift() + '/' + prefix
    prefix = prefix.replace(/\/$/, '')
    short = parts.join('/')
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(short) > 100) throw new Error('路径太长，装不进 ustar：' + name)
  }
  header.write(short, 0, 100, 'utf8')
  header.write(octal(0o644, 8), 100, 8, 'ascii')
  header.write(octal(0, 8), 108, 8, 'ascii')
  header.write(octal(0, 8), 116, 8, 'ascii')
  header.write(octal(size, 12), 124, 12, 'ascii')
  header.write(octal(mtime, 12), 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  if (prefix) header.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

function appendEntry(chunks, name, buf, mtime) {
  chunks.push(tarHeader(name, buf.length, mtime))
  chunks.push(buf)
  const pad = (512 - (buf.length % 512)) % 512
  if (pad) chunks.push(Buffer.alloc(pad, 0))
}

/**
 * 把 [{ path, buf }] 打成 gzip 的 tar。
 * path 排序后再写，同样的输入总得到同样的顺序（mtime 仍会让字节不同）。
 * @returns {{ gz: Buffer, tarBytes: number }}
 */
export function createTarGz(entries, { mtime = Math.floor(Date.now() / 1000) } = {}) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const chunks = []
  for (const entry of sorted) appendEntry(chunks, entry.path, entry.buf, mtime)
  chunks.push(Buffer.alloc(1024, 0))
  const tar = Buffer.concat(chunks)
  return { gz: gzipSync(tar, { level: 9 }), tarBytes: tar.length }
}

/** 读一个文件成 { path, buf }，省掉每个脚本各自拼。 */
export function entryOf(full, path) {
  return { path, buf: readFileSync(full) }
}
