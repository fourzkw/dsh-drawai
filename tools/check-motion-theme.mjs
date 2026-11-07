// 主题自检：解析 → 生成 theme.ts → 读回。
//   node tools/check-motion-theme.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listThemes, resolveTheme, writeTheme, readTheme, themeSource } from '../src/motion/theme.js'

const assert = (condition, message) => { if (!condition) { console.error('FAIL: ' + message); process.exitCode = 1 } }

const themes = listThemes()
assert(themes.length >= 8, '应能列出上游 8 套 palettes，实际 ' + themes.length)
assert(themes.some((theme) => theme.name === 'vintage-kraft'), '应包含 vintage-kraft')

const kraft = resolveTheme('vintage-kraft')
assert(kraft.tokens.page === '#c8aa7d', 'vintage-kraft 的 page 应为 #c8aa7d')
assert(kraft.tokens.accent === '#8b4937', 'vintage-kraft 的 accent 应为 #8b4937')

const custom = resolveTheme({ name: 'paper-ink-custom', paper: '#EDE8DE', ink: '#2A2724', accent: '#B23A2E' })
assert(custom.tokens.page === '#EDE8DE' && custom.tokens.text === '#2A2724' && custom.tokens.accent === '#B23A2E', '应该接受直接给色的对象')
assert(custom.name === 'paper-ink-custom', '自定义主题应该保留名字')

let threw = false
try { resolveTheme('没有这套') } catch { threw = true }
assert(threw, '未知主题应该报错并列出可选')

const dir = mkdtempSync(join(tmpdir(), 'drawai-theme-'))
try {
  writeTheme(dir, kraft)
  assert(existsSync(join(dir, 'theme.ts')), '应写出 theme.ts')
  const source = readFileSync(join(dir, 'theme.ts'), 'utf8')
  assert(source.includes("export const PAPER = '#c8aa7d'"), 'theme.ts 里 PAPER 应指向 page')
  assert(source.includes("export const STAMP = '#8b4937'"), 'theme.ts 里 STAMP 应指向 accent')
  assert(source.includes('export const SERIF'), 'theme.ts 应给字体')
  const back = readTheme(dir)
  assert(back && back.name === 'vintage-kraft', 'theme.json 应能读回')
  assert(themeSource(custom).includes("'#EDE8DE'"), '自定义色应写进源码')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (process.exitCode) process.exit(process.exitCode)
console.log('主题自检通过（' + themes.map((theme) => theme.name).join(' / ') + '）')
