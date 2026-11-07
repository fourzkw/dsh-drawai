// Fonts distributed with the plugin and copied into a video project's public assets.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./fonts/', import.meta.url))
export const BUNDLED_FONT_FACES = JSON.parse(readFileSync(join(root, 'font-faces.json'), 'utf8')).faces
export const BUNDLED_FONTS = BUNDLED_FONT_FACES.map(face => face.file)
const BASIC_FAMILIES = new Set(['Noto Sans SC', 'Noto Serif SC'])

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
  return new Set(BUNDLED_FONT_FACES.filter(face => normalized.includes(face.family.toLowerCase().replace(/[^a-z0-9]/g, ''))).map(face => face.family))
}

export function writeBundledFonts(projectDir) {
  const dest = join(projectDir, 'assets', 'fonts')
  mkdirSync(dest, { recursive: true })
  const needed = referencedFamilies(projectDir)
  for (const face of BUNDLED_FONT_FACES) {
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
  return BUNDLED_FONT_FACES.filter(face => BASIC_FAMILIES.has(face.family)).every(face => existsSync(join(projectDir, 'assets', 'fonts', face.file)))
}

export function availableBundledFontFaces(projectDir) {
  return BUNDLED_FONT_FACES.filter(face => existsSync(join(projectDir, 'assets', 'fonts', face.file)))
}
