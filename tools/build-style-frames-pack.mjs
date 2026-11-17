#!/usr/bin/env node
/**
 * 把本地收集好的「整片风格参考帧」集合打成一个 tar.gz，供 GitHub Release 托管。
 *
 * 为什么单独一个包：参考帧是可选素材（40.2MB / 149 文件），塞进 145MB 的字体/素材库包
 * 会让不用参考帧的人也陪它下 40MB；进 git 或 npm 包同样不合适。所以第三个包，
 * tag 形如 `style-frames-20261116`，谁要用 `mg_style {action:"install"}` 谁下载。
 *
 * 包里是**集合目录的内容**（index.json 在包根），安装时落到
 * `~/.dsh/drawai-style-reference-frames/collection-<version>/`；
 * 多出来的 `manifest.json` 是安装校验用的，不属于集合本身。
 *
 * 用法：
 *   node tools/build-style-frames-pack.mjs                       # 自动找最新的 collection-*
 *   node tools/build-style-frames-pack.mjs --from <collection>   # 指定集合目录
 *   node tools/build-style-frames-pack.mjs --no-lock             # 只打包，不改源码
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTarGz, sha256, walkFiles } from './lib/ustar.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src', 'motion')
const OUT_DIR = join(ROOT, 'dist')
const COLLECTION_NAME = /^collection-[a-z0-9][a-z0-9_-]*$/i
/** 安装/打包时都不该进来的系统垃圾与安装标记。 */
const IGNORED = new Set(['.ready.json', '.DS_Store', 'Thumbs.db', 'desktop.ini'])

function parentDir() {
  return process.env.DRAWAI_STYLE_FRAMES_DIR || join(homedir(), '.dsh', 'drawai-style-reference-frames')
}

/** 和 src/motion/asset-pack.js 的 styleFramesParent() 保持一致：最新且带 index.json 的集合。 */
function latestCollection(parent) {
  if (!existsSync(parent)) return null
  const names = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && COLLECTION_NAME.test(entry.name))
    .map((entry) => entry.name).sort().reverse()
  for (const name of names) {
    const dir = join(parent, name)
    if (existsSync(join(dir, 'index.json'))) return dir
  }
  return null
}

function sourceDir() {
  const at = process.argv.indexOf('--from')
  if (at > -1) {
    const value = process.argv[at + 1]
    if (!value || value.startsWith('--')) throw new Error('--from 需要一个集合目录')
    return resolve(value)
  }
  if (process.env.DRAWAI_STYLE_REFERENCE_DIR) return resolve(process.env.DRAWAI_STYLE_REFERENCE_DIR)
  const found = latestCollection(parentDir())
  if (!found) throw new Error('没有找到参考帧集合（' + parentDir() + ' 下没有 collection-*/index.json）；用 --from 指定')
  return found
}

function main() {
  const noLock = process.argv.includes('--no-lock')
  const source = sourceDir()
  if (!statSync(source).isDirectory()) throw new Error('参考帧集合不是目录：' + source)
  const name = basename(source)
  if (!COLLECTION_NAME.test(name)) throw new Error('集合目录名要形如 collection-<版本>：' + name)
  if (!existsSync(join(source, 'index.json'))) throw new Error('集合缺少 index.json：' + source)
  const version = name.slice('collection-'.length)
  const collection = 'collection-' + version
  const pack = `drawai-style-frames-${version}.tar.gz`

  const files = []
  for (const item of walkFiles(source)) {
    if (IGNORED.has(basename(item.rel))) continue
    const buf = readFileSync(item.full)
    files.push({ path: item.rel, bytes: buf.length, sha256: sha256(buf), buf })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (!files.length) throw new Error('集合是空的：' + source)

  const manifest = {
    name: 'dsh-drawai style reference frames',
    collection,
    version,
    createdAt: new Date().toISOString(),
    counts: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
    files: files.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash })),
  }

  const { gz, tarBytes } = createTarGz([
    { path: 'manifest.json', buf: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    ...files.map((file) => ({ path: file.path, buf: file.buf })),
  ])

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, pack)
  writeFileSync(out, gz)
  const digest = sha256(gz)
  writeFileSync(out + '.sha256', `${digest}  ${pack}\n`, 'utf8')

  const byExt = new Map()
  for (const file of files) {
    const ext = (file.path.match(/\.[a-z0-9]+$/i) || ['(无)'])[0].toLowerCase()
    byExt.set(ext, (byExt.get(ext) || 0) + 1)
  }
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB'
  console.log(`${pack}  ${mb(gz.length)}  (raw ${mb(tarBytes)})  ${files.length} files  from ${relative(ROOT, source) || source}`)
  console.log('组成 ' + [...byExt].sort((a, b) => b[1] - a[1]).map(([ext, n]) => ext + '×' + n).join(' '))
  console.log(`sha256 ${digest}`)

  if (!noLock) {
    const lockPath = join(SRC, 'style-frames-lock.js')
    const lock = '// 由 tools/build-style-frames-pack.mjs 生成，勿手改。\n'
      + 'export const STYLE_FRAMES_LOCK = ' + JSON.stringify({
        version,
        collection,
        file: pack,
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
