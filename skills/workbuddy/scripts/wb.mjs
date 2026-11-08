#!/usr/bin/env node
// 技能市场的入口：`node scripts/wb.mjs <命令>`。
//
// 市场上传的 zip 只允许「根目录/二级目录/文件」两层，放不下 engine/ 这种深目录树，
// 所以引擎被打成 scripts/engine.tar.gz，第一次运行时解到 scripts/.runtime/，再装依赖。
// 仓库里开发时 scripts/bin/wb.mjs 就在旁边，直接转发，不做解包。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const devEntry = join(here, 'bin', 'wb.mjs')
const runtime = join(here, '.runtime')
const runtimeEntry = join(runtime, 'bin', 'wb.mjs')

function readString(buf, start, length) {
  const slice = buf.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function readOctal(buf, start, length) {
  const text = readString(buf, start, length).trim()
  return text ? parseInt(text, 8) : 0
}

// 只处理我们自己打的包：ustar + GNU 长文件名（'L'）。
function extractTarGz(archive, target) {
  const tar = gunzipSync(archive)
  let offset = 0
  let longName = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) break
    const name = longName || readString(header, 0, 100)
    longName = null
    const prefix = readString(header, 345, 155)
    const full = prefix ? prefix + '/' + name : name
    const size = readOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48)
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (type === 'L') { longName = readString(body, 0, body.length); continue }
    if (type !== '0' && type !== '\0') continue // 目录（'5'）不用建，写文件时 mkdir 会补
    const dest = join(target, ...full.split('/').filter(Boolean))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, body)
  }
}

if (!existsSync(devEntry)) {
  if (!existsSync(runtimeEntry)) {
    const archive = join(here, 'engine.tar.gz')
    if (!existsSync(archive)) {
      console.error('✗ 技能包不完整：缺 scripts/engine.tar.gz，请重新下载技能')
      process.exit(1)
    }
    console.error('首次运行：解包引擎…')
    extractTarGz(readFileSync(archive), runtime)
    writeFileSync(join(runtime, '.ready'), new Date().toISOString() + '\n', 'utf8')
  }
  if (!existsSync(join(runtime, 'node_modules', '@babel', 'parser'))) {
    console.error('首次运行：安装依赖（@babel/parser / @babel/traverse / npm，约 21MB，需要网络）…')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const install = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: runtime,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (install.status !== 0) {
      console.error('✗ 依赖没装上：到 ' + runtime + ' 里手动跑 `npm install --omit=dev`（需要网络）')
      process.exit(install.status ?? 1)
    }
  }
}

const entry = existsSync(devEntry) ? devEntry : runtimeEntry
const child = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' })
if (child.error) {
  console.error('✗ 启动失败：' + child.error.message)
  process.exit(1)
}
process.exit(child.status ?? 1)
