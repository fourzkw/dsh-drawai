// Vendor the mg-styles-15 style bible (prompts + demo source, no media) into the plugin.
//
// 上游是 15 支「写死代码的成片」+ 15 份提示词；这里只收文本：提示词是风格本体，
// demo 源码是参考实现。视频、纹理、字体一律不收 —— 它们体积大、授权各异，
// 而且逐像素复刻本来就不是这条接入路线的目标。
//
// 收录 14 支：04-3d-render 不收（见 EXCLUDED）。排除要写在这里，否则重新 vendor
// 会把它连同 manifest 条目一起带回来，而 catalog 生成器那边已经没有它的 META 了。
//
// 用法：node tools/vendor-mgstyles.mjs <checkout> <commit>
//   checkout  上游仓库的本地 checkout（或解包目录）
//   commit    记录进 manifest 的 commit sha
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join, relative, basename } from 'node:path'

const checkout = resolve(process.argv[2] || '.tmp/mg-styles-15')
const commit = process.argv[3] || ''
const destination = resolve('src/motion/mgstyles/upstream')

const ROOT_FILES = ['LICENSE', 'README.md', 'README.zh-CN.md', 'rubric.md', 'template.md']
const DEMO_TEXT = /\.(m?js|html|css|json|md|txt)$/i
const SKIP = /(^|\/)(out|node_modules)\//
const MAX_BYTES = 512 * 1024

/** 不收的风格：slug → 理由（写进 manifest 的 removedStyles，留痕）。 */
const EXCLUDED = {
  '04-3d-render': '画面是 Blender 离线渲出来的 CGI 质感（接触阴影、散射、景深都在渲染器里），插件里没有能出同等质感的等价物；拿 CSS 滤镜凑只会更假，需要就走外部渲染回灌。',
}

function walk(base, prefix, out = []) {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name
    if (SKIP.test(rel + '/')) continue
    if (entry.isDirectory()) walk(join(base, entry.name), rel, out)
    else out.push(rel)
  }
  return out
}

const styles = readdirSync(join(checkout, 'prompts')).filter((name) => name.endsWith('.md') && !Object.hasOwn(EXCLUDED, basename(name, '.md'))).sort().map((name) => {
  const slug = basename(name, '.md')
  const prompt = readFileSync(join(checkout, 'prompts', name), 'utf8')
  // 标题原样保留：「# 几何构成 / 包豪斯 Geometric / Bauhaus Motion」。中文名/英文名
  // 的切分各家不一样，交给 catalog.json 里手写的展示名，这里不猜。
  const heading = (prompt.match(/^#\s+(.+)$/m) || [])[1] || slug
  const shot = (prompt.match(/\*\*原片\*\*[：:]\s*(.+)/) || [])[1] || ''
  const demoDir = join(checkout, 'demos', slug)
  const demos = statSync(demoDir, { throwIfNoEntry: false })?.isDirectory()
    ? walk(demoDir, 'demos/' + slug).filter((path) => DEMO_TEXT.test(path) && statSync(join(checkout, path)).size <= MAX_BYTES)
    : []
  return { slug, heading: heading.trim(), shot: shot.trim(), prompt: 'prompts/' + name, demos }
})

const files = [...ROOT_FILES, 'harness/render.mjs', ...styles.flatMap((style) => [style.prompt, ...style.demos])]
  .filter((path, index, all) => all.indexOf(path) === index)
  .filter((path) => statSync(join(checkout, path), { throwIfNoEntry: false })?.isFile())

const checksums = {}
for (const path of files) {
  const content = readFileSync(join(checkout, path))
  const target = join(destination, path)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(checkout, path), target)
  checksums[path] = createHash('sha256').update(content).digest('hex')
}

writeFileSync(join(destination, 'manifest.json'), JSON.stringify({
  source: 'https://github.com/Vincentwei1021/mg-styles-15',
  commit,
  license: 'MIT',
  vendoredAt: '2026-10-05',
  note: '只收文本：提示词 + demo 源码。视频/纹理/字体不在仓库里，也没有 vendor 进来。',
  styles: styles.map(({ slug, heading, shot, prompt, demos }) => ({ slug, heading, shot, prompt, demos })),
  removedStyles: Object.entries(EXCLUDED).map(([slug, reason]) => ({ slug, reason })),
  files: checksums,
}, null, 2) + '\n')

const bytes = files.reduce((sum, path) => sum + statSync(join(checkout, path)).size, 0)
console.log('vendored ' + styles.length + ' styles, ' + files.length + ' files, ' + (bytes / 1048576).toFixed(1) + ' MB')
for (const style of styles) console.log('  ' + style.slug + '  ' + style.heading + '  demos=' + style.demos.length)
