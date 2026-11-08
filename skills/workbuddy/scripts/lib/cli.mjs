// wb 的命令行骨架：环境变量映射、参数解析、输出与错误处理。
//
// 为什么先做环境映射：引擎里所有可配置路径都读 DRAWAI_*（那是插件的名字）。
// 与其改引擎源码（以后升级要重新打补丁），不如在入口处把 WORKBUDDY_* 镜像过去。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, isAbsolute } from 'node:path'

const ENV_ALIASES = {
  WORKBUDDY_ASSETS_DIR: 'DRAWAI_ASSETS_DIR',
  WORKBUDDY_ASSETS_URL: 'DRAWAI_ASSETS_URL',
  WORKBUDDY_VIDEO_RUNTIME_DIR: 'DRAWAI_VIDEO_RUNTIME_DIR',
  WORKBUDDY_RUNTIME_REGISTRY: 'DRAWAI_RUNTIME_REGISTRY',
  WORKBUDDY_FFMPEG_PATH: 'DRAWAI_FFMPEG_PATH',
  WORKBUDDY_FFMPEG_DIR: 'DRAWAI_FFMPEG_DIR',
  WORKBUDDY_FFMPEG_MIRROR: 'DRAWAI_FFMPEG_MIRROR',
  WORKBUDDY_PYTHON: 'DRAWAI_PYTHON',
  WORKBUDDY_CHROME_PATH: 'DRAWAI_CHROME_PATH',
}

export function mirrorEnv() {
  for (const [alias, target] of Object.entries(ENV_ALIASES)) {
    if (process.env[alias] && !process.env[target]) process.env[target] = process.env[alias]
  }
}

/** 把 `--key value` / `--key=value` / `--flag` 解析成对象；没给值的重复参数收成数组。 */
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) { positional.push(token); continue }
    const [rawKey, inline] = token.slice(2).split(/=(.*)/s)
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    if (inline !== undefined) { assign(flags, key, inline); continue }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) { assign(flags, key, next); index += 1 }
    else assign(flags, key, true)
  }
  return { flags, positional }
}

function assign(flags, key, value) {
  if (!(key in flags)) { flags[key] = value; return }
  const list = Array.isArray(flags[key]) ? flags[key] : [flags[key]]
  list.push(value)
  flags[key] = list
}

export const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])

export const num = (value, fallback = undefined) => {
  if (value === undefined || value === null || value === '' || value === true) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const bool = (value) => value === true || value === '1' || value === 'true' || value === 'yes'

/** `--dir` 相对 cwd 解析；给了 positional 时它当目录。 */
export function projectDir(flags, positional = []) {
  const raw = flags.dir || positional[0] || '.'
  return resolve(process.cwd(), String(raw))
}

export function requireProjectDir(flags, positional = []) {
  const dir = projectDir(flags, positional)
  if (!existsSync(dir)) throw new Error('工程目录不存在：' + dir + '\n先 `wb create` 建工程，或把 --dir 指到已有工程。')
  if (!existsSync(resolve(dir, 'timeline.json'))) {
    throw new Error('这个目录不是视频工程（缺 timeline.json）：' + dir + '\n`wb open` 能看工程结构，`wb create` 会新建一个。')
  }
  return dir
}

// 命令里的文件参数（--file 成片、--film 交付片）可能是绝对路径、cwd 相对路径，
// 也可能是相对工程目录的（`.out/pilot.mp4` 这种）。按这个顺序找，找到第一个存在的。
export function resolveInput(dir, file) {
  const raw = String(file)
  const candidates = isAbsolute(raw) ? [raw] : [resolve(process.cwd(), raw), resolve(dir, raw)]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error('没有这个文件：' + candidates[0])
}

// ── 输出 ──────────────────────────────────────────────────────────────
const state = { json: false }

export function setJson(on) { state.json = on }
export const isJson = () => state.json

export function line(text = '') { process.stdout.write(text + '\n') }

export function emit(title, data) {
  if (state.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return }
  if (title) line(title)
}

/** 统一的失败出口：--json 时也给一份可解析的错误，别让调用方猜。 */
export function fail(error) {
  const message = error && error.message ? error.message : String(error)
  if (state.json) process.stdout.write(JSON.stringify({ ok: false, error: message, code: error?.code }, null, 2) + '\n')
  else process.stderr.write('✗ ' + message + '\n')
  process.exitCode = 1
}

export const formatSeconds = (frames, fps) => (frames / (fps || 30)).toFixed(2) + 's'

export const homeRelative = (path) => {
  const home = homedir()
  return path && path.startsWith(home) ? '~' + path.slice(home.length) : path
}

export function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? '').length)))
  const format = (row) => '  ' + row.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd()
  const lines = [format(headers), '  ' + widths.map((width) => '─'.repeat(width)).join('  ')]
  for (const row of rows) lines.push(format(row))
  return lines.join('\n')
}
