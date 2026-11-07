#!/usr/bin/env node
/**
 * 把 motion 素材（字体 + 素材库）打成一个 tar.gz，供 GitHub Release 托管。
 *
 * 为什么不再放进 npm 包：`.gitignore` 管不到 npm，`files: ["lib"]` 会把 200MB
 * 一起塞进 tarball（0.4.0 时实测 147.6MB / 704 文件）。改成发布到 Release，
 * 插件首次使用时下载一次、校验、落地到用户目录。
 *
 * 用法：
 *   node tools/build-assets-pack.mjs            # 打包 + 写 asset-pack-lock.js
 *   node tools/build-assets-pack.mjs --no-lock  # 只打包，不改源码
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src', 'motion')
const OUT_DIR = join(ROOT, 'dist')
const VERSION = 'v1'
const PACK = `drawai-assets-${VERSION}.tar.gz`
const SOURCES = ['fonts', 'media-library']

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push({ full, rel: relative(base, full).split(/[\\/]/).join('/') })
  }
  return out
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
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

function appendEntry(chunks, name, buf) {
  chunks.push(tarHeader(name, buf.length, Math.floor(Date.now() / 1000)))
  chunks.push(buf)
  const pad = (512 - (buf.length % 512)) % 512
  if (pad) chunks.push(Buffer.alloc(pad, 0))
}

function main() {
  const noLock = process.argv.includes('--no-lock')
  const files = []
  for (const source of SOURCES) {
    const dir = join(SRC, source)
    if (!existsSync(dir)) throw new Error('缺少素材目录：' + dir)
    for (const item of walk(dir)) {
      const buf = readFileSync(item.full)
      files.push({ path: source + '/' + item.rel, bytes: buf.length, sha256: sha256(buf), buf })
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))

  const manifest = {
    name: 'dsh-drawai motion assets',
    version: VERSION,
    createdAt: new Date().toISOString(),
    counts: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
    files: files.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash })),
  }

  const chunks = []
  appendEntry(chunks, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'))
  for (const file of files) appendEntry(chunks, file.path, file.buf)
  chunks.push(Buffer.alloc(1024, 0))
  const tar = Buffer.concat(chunks)
  const gz = gzipSync(tar, { level: 9 })

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, PACK)
  writeFileSync(out, gz)
  const digest = sha256(gz)
  writeFileSync(out + '.sha256', `${digest}  ${PACK}\n`, 'utf8')

  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB'
  console.log(`${PACK}  ${mb(gz.length)}  (raw ${mb(tar.length)})  ${files.length} files`)
  console.log(`sha256 ${digest}`)

  if (!noLock) {
    const lockPath = join(SRC, 'asset-pack-lock.js')
    const lock = '// 由 tools/build-assets-pack.mjs 生成，勿手改。\n'
      + 'export const ASSETS_LOCK = ' + JSON.stringify({
        version: VERSION,
        file: PACK,
        bytes: gz.length,
        sha256: digest,
        files: files.length,
        rawBytes: tar.length,
        builtAt: new Date().toISOString(),
      }, null, 2) + '\n'
    writeFileSync(lockPath, lock, 'utf8')
    console.log('wrote ' + relative(ROOT, lockPath))
  }
}

main()
