#!/usr/bin/env node
// 打 WorkBuddy 技能市场的上传包。
//
// 市场规则（https://open.workbuddy.cn/docs/skill#技能市场）：
//   · 只收 .zip，≤ 3MB；
//   · 顶层是 {skill-name}/，里面必须有 SKILL.md；
//   · 只支持「根目录/二级目录/文件」两层 —— engine/ 那种深目录树不能直接放，
//     所以引擎打成 scripts/engine.tar.gz，由 scripts/wb.mjs 首次运行时解包。
//
//   node tools/build-market-zip.mjs            # → dist/workbuddy.zip
//   node tools/build-market-zip.mjs --out X.zip

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillDir = join(root, 'skills', 'workbuddy')
const scriptsDir = join(skillDir, 'scripts')
// 市场上传包的顶层目录名必须等于 SKILL.md 里的 name（平台按它生成技能 ID、判重名）。
const skillText = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/)
const skillName = (frontmatter?.[1].match(/^name:\s*(\S+)\s*$/m) || [])[1]
if (!skillName) throw new Error('SKILL.md 的 frontmatter 里没有 name')
const outIndex = process.argv.indexOf('--out')
const outFile = outIndex > -1 ? process.argv[outIndex + 1] : join(root, 'dist', skillName + '.zip')

const SKIP = new Set(['node_modules', '.out', '.cache', '__pycache__', '.runtime', '.git'])
const RUNTIME = ['bin', 'lib', 'engine', 'package.json', 'package-lock.json']

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

// —— 最小 tar 写入（ustar + GNU 'L' 长文件名），配 scripts/wb.mjs 的解包器 ——
function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii') // 校验和先占位
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

const tarParts = []
for (const item of RUNTIME) {
  const full = join(scriptsDir, item)
  const files = statSync(full).isDirectory() ? walk(full) : [full]
  for (const file of files) {
    const name = relative(scriptsDir, file).split('\\').join('/')
    const data = readFileSync(file)
    const mtime = statSync(file).mtimeMs
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(name + '\0', 'utf8')
      tarParts.push(tarHeader('././@LongLink', long.length, mtime), long, Buffer.alloc((512 - (long.length % 512)) % 512))
    }
    tarParts.push(tarHeader(name, data.length, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
}
tarParts.push(Buffer.alloc(1024)) // 两个空块收尾
const engineTarGz = gzipSync(Buffer.concat(tarParts), { level: 9 })

// —— 上传包的条目：只允许两层 ——
const entries = []
entries.push(['SKILL.md', readFileSync(join(skillDir, 'SKILL.md'))])
entries.push(['LICENSE', readFileSync(join(skillDir, 'LICENSE'))])
for (const file of walk(join(skillDir, 'references'))) {
  entries.push([relative(skillDir, file).split('\\').join('/'), readFileSync(file)])
}
entries.push(['scripts/wb.mjs', readFileSync(join(scriptsDir, 'wb.mjs'))])
entries.push(['scripts/engine.tar.gz', engineTarGz])

const deep = entries.filter(([name]) => name.split('/').length > 2)
if (deep.length) throw new Error('目录层级超限（只允许两层）：' + deep.map(([name]) => name).join(', '))

// —— 最小 zip 写入器（deflate + CRC32） ——
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
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

const chunks = []
const central = []
let offset = 0

for (const [relPath, data] of entries) {
  const name = Buffer.from(skillName + '/' + relPath, 'utf8')
  const packed = deflateRawSync(data, { level: 9 })
  const useDeflate = packed.length < data.length
  const body = useDeflate ? packed : data
  const method = useDeflate ? 8 : 0
  const { time, day } = dosTime(new Date())

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(day, 12)
  local.writeUInt32LE(crc32(data), 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  chunks.push(local, name, body)

  const dir = Buffer.alloc(46)
  dir.writeUInt32LE(0x02014b50, 0)
  dir.writeUInt16LE(0x0314, 4)
  dir.writeUInt16LE(20, 6)
  dir.writeUInt16LE(0x0800, 8)
  dir.writeUInt16LE(method, 10)
  dir.writeUInt16LE(time, 12)
  dir.writeUInt16LE(day, 14)
  dir.writeUInt32LE(crc32(data), 16)
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
end.writeUInt16LE(entries.length, 8)
end.writeUInt16LE(entries.length, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]))

const bytes = statSync(outFile).size
console.log('技能市场包：' + outFile)
console.log('  ' + entries.length + ' 个条目（' + entries.map(([name]) => name).join('、') + '）')
console.log('  ' + (bytes / 1024 / 1024).toFixed(2) + 'MB（上限 3MB）' + (bytes <= 3 * 1024 * 1024 ? '' : ' ✗ 超限'))
