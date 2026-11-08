// Fonts copied into a video project's public assets.
//
// 字体不在 npm 包里（约 135MB），由 asset-pack.js 解析：开发目录里直接用，安装版从
// `~/.dsh/drawai-assets/` 读（首次使用自动下载）。所以这里**不能在模块导入期读文件**，
// 一律走 fontFaces() 之类的函数，缺素材时由调用方 catch 并提示用户。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fontsDir } from './asset-pack.js'

const BASIC_FAMILIES = new Set(['Noto Sans SC', 'Noto Serif SC'])
let cachedFaces = null

/** 内置字体清单（font-faces.json）。素材没装好时返回空数组。 */
export function fontFaces() {
  if (cachedFaces) return cachedFaces
  const dir = fontsDir()
  if (!dir) return []
  const file = join(dir, 'font-faces.json')
  if (!existsSync(file)) return []
  cachedFaces = JSON.parse(readFileSync(file, 'utf8')).faces || []
  return cachedFaces
}

/** 字体文件名列表（缺素材时为空）。 */
export function bundledFontNames() {
  return fontFaces().map(face => face.file)
}

function referencedFamilies(projectDir) {
  let text = ''
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['assets', '.out', 'node_modules', '.git'].includes(entry.name)) visit(join(dir, entry.name))
      } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|css)$/i.test(entry.name)) {
        text += '\n' + readFileSync(join(dir, entry.name), 'utf8')
      }
    }
  }
  visit(projectDir)
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '')
  return new Set(fontFaces().filter(face => normalized.includes(face.family.toLowerCase().replace(/[^a-z0-9]/g, ''))).map(face => face.family))
}

export function writeBundledFonts(projectDir) {
  const root = fontsDir()
  if (!root) throw new Error('动效素材包还没就绪（缺字体目录）：请先让插件下载素材包')
  const dest = join(projectDir, 'assets', 'fonts')
  mkdirSync(dest, { recursive: true })
  const needed = referencedFamilies(projectDir)
  for (const face of fontFaces()) {
    if (!BASIC_FAMILIES.has(face.family) && !needed.has(face.family)) continue
    const name = face.file
    const source = join(root, name), target = join(dest, name)
    if (!existsSync(source)) throw new Error('插件缺少内置字体：' + name)
    if (!existsSync(target)) copyFileSync(source, target)
  }
  const notices = fileURLToPath(new URL('../../LICENSE', import.meta.url))
  const targetNotice = join(dest, 'DRAWAI-NOTICES.txt')
  if (existsSync(notices) && !existsSync(targetNotice)) copyFileSync(notices, targetNotice)
}

export function hasBundledFonts(projectDir) {
  return fontFaces().filter(face => BASIC_FAMILIES.has(face.family)).every(face => existsSync(join(projectDir, 'assets', 'fonts', face.file)))
}

export function availableBundledFontFaces(projectDir) {
  return fontFaces().filter(face => existsSync(join(projectDir, 'assets', 'fonts', face.file)))
}
