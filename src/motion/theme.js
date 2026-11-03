// 主题：把"一套配色"变成一个可以 import 的 theme.ts。
//
// 上游 template/src/themes 里有 8 套 palettes（page/surface/field/text/muted/
// accent/border），但工程模板从来不引用它们——每条片子都从素骨架开始，配色
// 只能靠场景代码里手写十六进制。这里把那条线接上：
//
//   createProject(dir, { theme: 'vintage-kraft' })  → 生成 theme.ts
//   scene-*.tsx 里 import { PAPER, INK, STAMP } from './theme'
//
// theme.ts 是普通源码，agent 照样可以改；theme.json 只记"这条片子用的哪套"。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PALETTES = new URL('./shotcraft/upstream/template/src/themes/palettes.json', import.meta.url)

// 兜底：注册表读不到时也能建工程。这套就是本片用的纸墨色。
const FALLBACK = {
  'paper-ink': { page: '#EDE8DE', surface: '#F5F1E8', field: '#E4DED2', text: '#2A2724', muted: '#8C8375', accent: '#B23A2E', border: '#CFC7B8' },
}

export function paletteTable() {
  try {
    const table = JSON.parse(readFileSync(PALETTES, 'utf8'))
    if (table && typeof table === 'object' && !Array.isArray(table)) return { ...FALLBACK, ...table }
  } catch {
    /* 读不到就用兜底 */
  }
  return { ...FALLBACK }
}

export function listThemes() {
  return Object.entries(paletteTable()).map(([name, tokens]) => ({ name, page: tokens.page, accent: tokens.accent }))
}

const HEX = /^#[0-9a-fA-F]{3,8}$/

// 也接受直接给一套色（对象），方便"这条片子就想要这个纸色"的一次性需求。
export function resolveTheme(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const tokens = normalizeTokens(input)
    return { name: String(input.name || 'custom'), tokens, custom: true }
  }
  const name = String(input || '').trim()
  if (!name) return null
  const table = paletteTable()
  const tokens = table[name]
  if (!tokens) throw new Error('没有这套主题：' + name + '。可选：' + Object.keys(table).join('、'))
  return { name, tokens: normalizeTokens(tokens) }
}

function normalizeTokens(input) {
  const pick = (keys, fallback) => {
    for (const key of keys) if (typeof input[key] === 'string' && HEX.test(input[key].trim())) return input[key].trim()
    return fallback
  }
  return {
    page: pick(['page', 'paper', 'background', 'bg'], FALLBACK['paper-ink'].page),
    surface: pick(['surface', 'card'], FALLBACK['paper-ink'].surface),
    field: pick(['field', 'panel'], FALLBACK['paper-ink'].field),
    text: pick(['text', 'ink', 'foreground', 'fg'], FALLBACK['paper-ink'].text),
    muted: pick(['muted', 'dust', 'secondary'], FALLBACK['paper-ink'].muted),
    accent: pick(['accent', 'stamp', 'highlight'], FALLBACK['paper-ink'].accent),
    border: pick(['border', 'rule', 'line'], FALLBACK['paper-ink'].border),
  }
}

export const DEFAULT_FONTS = {
  serif: '"Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", serif',
  sans: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  mono: '"SF Mono", "JetBrains Mono", "Cascadia Mono", monospace',
}

// 场景文件只认这几个名字：PAPER / INK / DUST / STAMP / SURFACE / FIELD / BORDER。
export function themeSource(theme, fonts = {}) {
  const t = theme.tokens
  const f = { ...DEFAULT_FONTS, ...fonts }
  const q = (value) => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
  return [
    '// 主题：' + theme.name + '（由 motion_project 的 theme 参数生成，可以手改）',
    'export const THEME_NAME = ' + q(theme.name),
    'export const PAPER = ' + q(t.page) + '   // 纸',
    'export const SURFACE = ' + q(t.surface),
    'export const FIELD = ' + q(t.field),
    'export const INK = ' + q(t.text) + '     // 墨',
    'export const DUST = ' + q(t.muted) + '    // 次级文字',
    'export const STAMP = ' + q(t.accent) + '   // 唯一的强调色',
    'export const BORDER = ' + q(t.border),
    '',
    'export const SERIF = ' + q(f.serif),
    'export const SANS = ' + q(f.sans),
    'export const MONO = ' + q(f.mono),
    '',
    'export const TOKENS = ' + JSON.stringify(t, null, 2) + ' as const',
    '',
  ].join('\n')
}

export function writeTheme(dir, theme, fonts) {
  writeFileSync(join(dir, 'theme.ts'), themeSource(theme, fonts), 'utf8')
  writeFileSync(join(dir, 'theme.json'), JSON.stringify({ name: theme.name, tokens: theme.tokens, at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  return { file: join(dir, 'theme.ts'), name: theme.name, tokens: theme.tokens }
}

export function readTheme(dir) {
  const file = join(dir, 'theme.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
