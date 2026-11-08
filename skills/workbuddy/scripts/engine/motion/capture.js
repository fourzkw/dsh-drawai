// 页面截屏：把一段 HTML 模板（或一个网址）在无头浏览器里渲染成 PNG，再进工程 assets/。
//
// 为什么要它：写产品界面镜头时，最费时间的不是动画，是"图从哪来"。
// 上游 skill 用一个 Playwright 脚本截模板；这里不引入 Playwright，
// 直接复用 Remotion 已经在用的 Chrome/Edge 二进制做一次性截屏。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { captureAsset } from './assets.js'

const exec = promisify(execFile)

const POSIX = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

const WINDOWS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

export function browserExecutable() {
  const explicit = process.env.DRAWAI_CHROME_PATH
  const list = [explicit, ...(process.platform === 'win32' ? WINDOWS : POSIX)].filter(Boolean)
  for (const candidate of list) if (existsSync(candidate)) return candidate
  throw new Error('找不到 Chrome / Edge：设 DRAWAI_CHROME_PATH 指向可执行文件后再试')
}

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.max(min, Math.min(max, Math.round(number)))
}

function tail(error) {
  const text = String(error?.stderr || error?.message || error)
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  return lines.slice(-2).join(' ') || '未知错误'
}

// 返回 assets/ 里的条目（与 wb assets capture 同一种形状）。
export async function capturePage(dir, options = {}) {
  const width = clamp(options.width || 1440, 320, 2560)
  const height = clamp(options.height || 900, 240, 2560)
  const scale = clamp(options.scale || 2, 1, 3)
  const wait = clamp(options.wait ?? 1200, 0, 20000)
  const name = String(options.name || 'page-' + Date.now()).replace(/[\\/:*?"<>|]/g, '-')
  const work = join(dir, '.out', 'capture')
  mkdirSync(work, { recursive: true })

  let target
  if (options.url) {
    target = String(options.url)
    if (!/^https?:|^file:/i.test(target)) throw new Error('url 必须是 http(s) 或 file: 开头')
  } else if (options.html) {
    const file = join(work, name + '.html')
    writeFileSync(file, String(options.html), 'utf8')
    target = pathToFileURL(file).href
  } else {
    throw new Error('page 需要 url 或 html（直接给 HTML 源文本更常见）')
  }

  const png = join(work, name + '.png')
  const base = ['--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=' + scale, '--window-size=' + width + ',' + height,
    '--virtual-time-budget=' + wait, '--screenshot=' + png]
  const attempts = [['--headless=new', ...base, target], ['--headless', ...base, target]]
  let failure
  for (const args of attempts) {
    try {
      await exec(browserExecutable(), args, { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
      failure = undefined
      break
    } catch (error) {
      failure = error
    }
  }
  if (failure) throw new Error('截屏失败：' + tail(failure))
  if (!existsSync(png) || statSync(png).size < 1024) throw new Error('截屏没有产生图片（页面可能是空白或加载失败）')

  const asset = await captureAsset(dir, png, {
    name,
    caption: options.caption || (options.url ? '页面截图 ' + target : 'HTML 模板截图'),
    source: options.url ? 'page:' + target : 'page:html',
  })
  return { ...asset, viewport: { width, height, scale }, url: target }
}
