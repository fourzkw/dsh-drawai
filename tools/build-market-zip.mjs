#!/usr/bin/env node
// 打技能市场的上传包：<zip>/workbuddy/{SKILL.md, references/, scripts/, LICENSE}
// 规则来自 https://open.workbuddy.cn/docs/skill#技能市场 —— 只收 .zip、≤3MB、顶层是 {skill-name}/、必须有 SKILL.md。
//
//   node tools/build-market-zip.mjs            # 产出 dist/workbuddy.zip 并打印体积
//   node tools/build-market-zip.mjs --out X.zip
//
// 不打包 node_modules（21MB）：装完技能后按 SKILL.md 的 `npm --prefix scripts install --omit=dev` 装。

import { createWriteStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillDir = join(root, 'skills', 'workbuddy')
const outIndex = process.argv.indexOf('--out')
const outFile = outIndex > -1 ? process.argv[outIndex + 1] : join(root, 'dist', 'workbuddy.zip')

const SKIP = new Set(['node_modules', '.out', '.cache', '__pycache__', '.git'])
// README.md 是仓库里的开发说明（讲 tools/verify-skill.mjs 这类仓库内路径），不上市场。
const ROOT_FILES = ['SKILL.md', 'LICENSE']

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, base, out)
    else out.push(full)
  }
  return out
}

const files = []
for (const name of ROOT_FILES) files.push(join(skillDir, name))
files.push(...walk(join(skillDir, 'references')))
files.push(...walk(join(skillDir, 'scripts')))

// —— 最小 zip 写入器（deflate + CRC32），不引第三方依赖 ——
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

const chunks = []
const central = []
let offset = 0

for (const file of files) {
  const data = readFileSync(file)
  const name = Buffer.from('workbuddy/' + relative(skillDir, file).split('\\').join('/'), 'utf8')
  const packed = deflateRawSync(data, { level: 9 })
  const useDeflate = packed.length < data.length
  const body = useDeflate ? packed : data
  const method = useDeflate ? 8 : 0
  const crc = crc32(data)
  const { time, day } = dosTime(statSync(file).mtime)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(day, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  chunks.push(local, name, body)

  const dir = Buffer.alloc(46)
  dir.writeUInt32LE(0x02014b50, 0)
  dir.writeUInt16LE(0x0314, 4) // made by: unix
  dir.writeUInt16LE(20, 6)
  dir.writeUInt16LE(0x0800, 8)
  dir.writeUInt16LE(method, 10)
  dir.writeUInt16LE(time, 12)
  dir.writeUInt16LE(day, 14)
  dir.writeUInt32LE(crc, 16)
  dir.writeUInt32LE(body.length, 20)
  dir.writeUInt32LE(data.length, 24)
  dir.writeUInt16LE(name.length, 28)
  dir.writeUInt16LE(0, 30)
  dir.writeUInt16LE(0, 32)
  dir.writeUInt16LE(0, 34)
  dir.writeUInt16LE(0, 36)
  dir.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  dir.writeUInt32LE(offset, 42)
  central.push(dir, name)

  offset += local.length + name.length + body.length
}

const centralSize = central.reduce((sum, buf) => sum + buf.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

mkdirSync(dirname(outFile), { recursive: true })
const sink = createWriteStream(outFile)
for (const buf of [...chunks, ...central, end]) sink.write(buf)
await new Promise((resolve) => sink.end(resolve))

const bytes = statSync(outFile).size
console.log('技能市场包：' + outFile)
console.log('  ' + files.length + ' 个文件 · ' + (bytes / 1024 / 1024).toFixed(2) + 'MB（上限 3MB）' + (bytes <= 3 * 1024 * 1024 ? '' : ' ✗ 超限'))
