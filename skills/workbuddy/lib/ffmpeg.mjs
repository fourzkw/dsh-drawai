// FFmpeg：预览拼图、帧检（黑场/静止/削波）、导出混音都靠它。
//
// 引擎里那份 ffmpeg-manager 会在找不到时**自动下载**（约 100MB）。在没网或有代理的机器上，
// 这表现为「命令卡住不动」——排查一次要花掉半小时。所以 CLI 这一层先自己找：
// 找得到就把路径喂给引擎（DRAWAI_FFMPEG_PATH），找不到就立刻说清楚怎么装。
// 只有 `wb setup --install` 才允许触发引擎的下载。

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

function usable(path) {
  if (!path) return false
  try { return isAbsolute(path) && statSync(path).isFile() } catch { return false }
}

function versionOf(path) {
  try {
    const result = spawnSync(path, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    const text = String(result.stdout || '') + String(result.stderr || '')
    if (result.status !== 0) return null
    const match = text.match(/ffmpeg version (\S+)/)
    if (!match) return null
    return match[1]
  } catch { return null }
}

// winget 装完常见于 LOCALAPPDATA/Microsoft/WinGet/Packages/<包名>/<版本>/bin/ffmpeg.exe，
// 它的 Links 目录有时是空的（别名装到 WindowsApps 里），所以这里直接翻包目录。
function wingetCandidates() {
  const root = join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages')
  if (!existsSync(root)) return []
  const found = []
  let packages = []
  try { packages = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  for (const entry of packages) {
    if (!entry.isDirectory() || !/ffmpeg/i.test(entry.name)) continue
    const packageRoot = join(root, entry.name)
    const queue = [{ directory: packageRoot, depth: 0 }]
    while (queue.length) {
      const { directory, depth } = queue.shift()
      const candidate = join(directory, 'bin', EXE)
      if (usable(candidate)) { found.push(candidate); continue }
      if (depth >= 3) continue
      try {
        for (const child of readdirSync(directory, { withFileTypes: true })) {
          if (child.isDirectory()) queue.push({ directory: join(directory, child.name), depth: depth + 1 })
        }
      } catch { /* 没权限就算了 */ }
    }
  }
  return found
}

// 返回 {path, version, source}；没有就是 null。绝不下载。
export function locateFfmpeg() {
  const explicit = String(process.env.WORKBUDDY_FFMPEG_PATH || process.env.DRAWAI_FFMPEG_PATH || '').trim()
  if (usable(explicit)) {
    const version = versionOf(explicit)
    if (version) return { path: explicit, version, source: 'env' }
    return { path: explicit, version: null, source: 'env-invalid' }
  }
  for (const directory of String(process.env.PATH || '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, EXE)
    if (!usable(candidate)) continue
    const version = versionOf(candidate)
    if (version) return { path: candidate, version, source: 'path' }
  }
  // 开发机常见位置（Windows）：winget / chocolatey 装完不一定立刻进当前终端的 PATH
  if (process.platform === 'win32') {
    const guesses = [
      'C:/ffmpeg/bin/ffmpeg.exe',
      join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffmpeg.exe'),
      'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
      join(process.env.USERPROFILE || '', 'scoop/shims/ffmpeg.exe'),
      ...wingetCandidates(),
    ]
    for (const candidate of guesses) {
      if (!usable(candidate)) continue
      const version = versionOf(candidate)
      if (version) return { path: candidate, version, source: 'known-dir' }
    }
  }
  return null
}

// 找到就写进环境：引擎（ensureFfmpeg）会优先用显式路径，子进程也会继承。
export function applyFfmpegEnv(found = locateFfmpeg()) {
  if (!found || !found.version) return found
  if (!String(process.env.DRAWAI_FFMPEG_PATH || '').trim()) process.env.DRAWAI_FFMPEG_PATH = found.path
  return found
}

const HOW_TO_INSTALL = [
  '装一个（任选其一，装完重开终端）：',
  '  winget install --id Gyan.FFmpeg -e',
  '  scoop install ffmpeg',
  '  choco install ffmpeg',
  '已经有 FFmpeg 但不在 PATH 上，就把路径指过来：',
  "  $env:WORKBUDDY_FFMPEG_PATH = 'C:\\ffmpeg\\bin\\ffmpeg.exe'",
].join('\n')

export function requireFfmpeg(feature = '这个功能') {
  const found = locateFfmpeg()
  if (found && found.version) { applyFfmpegEnv(found); return found.path }
  if (found && found.source === 'env-invalid') {
    throw new Error(feature + '需要 FFmpeg，但 WORKBUDDY_FFMPEG_PATH 指向的文件不可用：' + found.path + '\n修正路径，或删掉这个环境变量。')
  }
  throw new Error(feature + '需要 FFmpeg，这台机器上没找到。\n' + HOW_TO_INSTALL + '\n也可以让 wb 自己装：`wb setup --install`（约 100MB，走 gyan.dev / BtbN）。')
}

export { HOW_TO_INSTALL }
