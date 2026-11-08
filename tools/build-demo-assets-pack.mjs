#!/usr/bin/env node
/**
 * 把上游 demo 里「只演示用得着、体积又不值得进 npm 包」的数据文件打成一个小的
 * tar.gz，供 GitHub Release 托管（和 200MB 的字体/素材库包分开，互不拖累）。
 *
 * 现在只有一个文件：22-hud 的世界地图拓扑 `land-50m.json`（约 530KB）。
 * 它来自 world-atlas@2.0.2（数据源 Natural Earth，公有领域；包本身 ISC），
 * 打包时从 unpkg 下载一次，缓存到 dist/demo-assets-src/，之后离线可重复打包。
 *
 * 为什么不进 npm 包：它是 demo 专用的数据，不是插件功能的一部分，放包里等于
 * 让每个用户为看一个 demo 多下 530KB。也不做成仓库文件：仓库只留构建脚本。
 *
 * 用法：
 *   node tools/build-demo-assets-pack.mjs            # 打包 + 写 demo-assets-lock.js
 *   node tools/build-demo-assets-pack.mjs --refresh  # 忽略缓存，重新下载源文件
 *   node tools/build-demo-assets-pack.mjs --no-lock  # 只打包，不改源码
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTarGz, sha256 } from './lib/ustar.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src', 'motion')
const OUT_DIR = join(ROOT, 'dist')
const CACHE_DIR = join(OUT_DIR, 'demo-assets-src')
const VERSION = 'v1'
const PACK = `drawai-demo-assets-${VERSION}.tar.gz`

/** packPath 是解压后在素材根目录下的相对路径（静态服务按 URL 直接拼）。 */
const SOURCES = [
  {
    packPath: 'demos/22-hud/assets/land-50m.json',
    cache: 'land-50m.json',
    url: 'https://unpkg.com/world-atlas@2.0.2/land-50m.json',
    note: 'world-atlas@2.0.2（Natural Earth 公有领域数据，ISC 许可）',
  },
]

const NOTICE = [
  '# Demo assets',
  '',
  '这些文件只被「整片风格」的上游 demo 使用，随插件主包发布太重，单独打包到 Release。',
  '',
  ...SOURCES.map((item) => `- \`${item.packPath}\`：${item.note}\n  来源 ${item.url}`),
  '',
  '插件在 demo 第一次请求这些文件时下载一次，校验 sha256 后落到',
  '`~/.dsh/drawai-assets/demo-v1/`，之后离线可用。',
  '',
].join('\n')

async function fetchSource(item, refresh) {
  const target = join(CACHE_DIR, item.cache)
  if (!refresh && existsSync(target)) return readFileSync(target)
  mkdirSync(CACHE_DIR, { recursive: true })
  const res = await fetch(item.url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（${item.url}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(target, buf)
  return buf
}

async function main() {
  const noLock = process.argv.includes('--no-lock')
  const refresh = process.argv.includes('--refresh')
  const files = []
  for (const item of SOURCES) {
    const buf = await fetchSource(item, refresh)
    if (item.packPath.endsWith('.json')) JSON.parse(buf.toString('utf8'))
    files.push({ path: item.packPath, buf, bytes: buf.length, sha256: sha256(buf), note: item.note })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const manifest = {
    name: 'dsh-drawai demo assets',
    version: VERSION,
    createdAt: new Date().toISOString(),
    counts: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
    files: files.map(({ path, bytes, sha256: hash, note }) => ({ path, bytes, sha256: hash, note })),
  }

  const { gz, tarBytes } = createTarGz([
    { path: 'manifest.json', buf: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    { path: 'NOTICE.md', buf: Buffer.from(NOTICE, 'utf8') },
    ...files.map((file) => ({ path: file.path, buf: file.buf })),
  ])

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, PACK)
  writeFileSync(out, gz)
  const digest = sha256(gz)
  writeFileSync(out + '.sha256', `${digest}  ${PACK}\n`, 'utf8')

  const kb = (n) => (n / 1024).toFixed(1) + 'KB'
  console.log(`${PACK}  ${kb(gz.length)}  (raw ${kb(tarBytes)})  ${files.length} files`)
  console.log(`sha256 ${digest}`)

  if (!noLock) {
    const lockPath = join(SRC, 'demo-assets-lock.js')
    const lock = '// 由 tools/build-demo-assets-pack.mjs 生成，勿手改。\n'
      + 'export const DEMO_ASSETS_LOCK = ' + JSON.stringify({
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

await main()
