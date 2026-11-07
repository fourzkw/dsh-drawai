import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { mgStyleKit } from '../lib/motion-library.js'
import { createProject, buildComposition } from '../lib/motion/project.js'
import { BUNDLED_FONT_FACES } from '../lib/motion/fonts.js'

const catalog = JSON.parse(readFileSync('lib/motion/mgstyles/catalog.json', 'utf8'))
const available = new Set(BUNDLED_FONT_FACES.map(face => face.family))
assert.equal(catalog.styles.length, 14)
for (const style of catalog.styles) {
  const fragment = JSON.parse(readFileSync(`src/motion/mgstyles/catalog.d/${style.slug}.json`, 'utf8'))
  assert.deepEqual(style.fonts, fragment.fonts, style.slug + ' 风格索引与源配置不一致')
  for (const role of ['display', 'text', 'mono']) {
    const names = [...style.fonts[role].matchAll(/"([^"]+)"/g)].map(match => match[1])
    assert.ok(names.length, style.slug + ' 缺字体 ' + role)
    for (const name of names) assert.ok(available.has(name), `${style.slug} 的 ${name} 未内置`)
  }
  const brief = readFileSync(`lib/motion/mgstyles/${style.brief}`, 'utf8')
  assert.ok(brief.includes('当前优先使用插件内置字体'), style.slug + ' 施工说明未更新')
}

for (const [slug, expected] of [
  ['05-cel-boil', ['Caveat', 'LXGW Marker Gothic', 'Long Cang']],
  ['20-pixel', ['Press Start 2P', 'Fusion Pixel 12']],
]) {
  const tempRoot = tmpdir(), dir = mkdtempSync(join(tempRoot, 'drawai-style-font-'))
  try {
    const style = mgStyleKit({ slug })
    createProject(dir, { style, spec: { width: 256, height: 256, fps: 12, duration: 2 }, segments: 1 })
    const theme = readFileSync(join(dir, 'theme.ts'), 'utf8')
    const plan = buildComposition(dir)
    for (const name of expected) {
      assert.ok(theme.includes(name), `${slug} 主题缺少 ${name}`)
      const face = plan.fontFaces.find(item => item.family === name)
      assert.ok(face && existsSync(join(dir, 'assets/fonts', face.file)), `${slug} 工程未复制 ${name}`)
    }
    assert.ok(readFileSync(join(dir, 'STYLE.md'), 'utf8').includes('当前优先使用插件内置字体'))
  } finally {
    const rel = relative(tempRoot, dir)
    if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) rmSync(dir, { recursive: true, force: true })
  }
}
console.log('14 种风格的推荐字体与内置字体一致；手绘和像素工程的主题、说明与字体文件均通过')
