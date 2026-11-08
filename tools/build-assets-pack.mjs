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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTarGz, sha256, walkFiles } from './lib/ustar.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src', 'motion')
const OUT_DIR = join(ROOT, 'dist')
const VERSION = 'v1'
const PACK = `drawai-assets-${VERSION}.tar.gz`
const SOURCES = ['fonts', 'media-library']

function main() {
  const noLock = process.argv.includes('--no-lock')
  const files = []
  for (const source of SOURCES) {
    const dir = join(SRC, source)
    if (!existsSync(dir)) throw new Error('缺少素材目录：' + dir)
    for (const item of walkFiles(dir)) {
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

  const { gz, tarBytes } = createTarGz([
    { path: 'manifest.json', buf: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    ...files.map((file) => ({ path: file.path, buf: file.buf })),
  ])

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, PACK)
  writeFileSync(out, gz)
  const digest = sha256(gz)
  writeFileSync(out + '.sha256', `${digest}  ${PACK}\n`, 'utf8')

  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB'
  console.log(`${PACK}  ${mb(gz.length)}  (raw ${mb(tarBytes)})  ${files.length} files`)
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
        rawBytes: tarBytes,
        builtAt: new Date().toISOString(),
      }, null, 2) + '\n'
    writeFileSync(lockPath, lock, 'utf8')
    console.log('wrote ' + relative(ROOT, lockPath))
  }
}

main()
