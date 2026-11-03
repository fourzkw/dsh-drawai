// Refresh the pinned, source-only Shotcraft library from an existing checkout.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const checkout = resolve(process.argv[2] || '_local/shotcraft-upstream')
const destination = resolve('src/motion/shotcraft/upstream')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim().split('\n')
const files = paths.filter((path) => ((/^(references\/|demos\/|assets\/lib\/|assets\/scripts\/|template\/)/.test(path)
  && /\.(md|tsx?|jsx?|mjs|json|py)$/.test(path) && !/(_legacy\/|__tests__\/|package-lock\.json)/.test(path))
  || ['LICENSE', 'SKILL.md', 'gallery/api/library.json'].includes(path)))
const checksums = {}
for (const path of files) {
  const content = readFileSync(resolve(checkout, path))
  mkdirSync(dirname(resolve(destination, path)), { recursive: true })
  copyFileSync(resolve(checkout, path), resolve(destination, path))
  checksums[path] = createHash('sha256').update(content).digest('hex')
}
const library = JSON.parse(readFileSync(resolve(checkout, 'gallery/api/library.json'), 'utf8'))
const cards = library.cards.map((card) => {
  const document = readFileSync(resolve(checkout, card.source), 'utf8')
  const directories = [...document.matchAll(/demos\/[a-z0-9_\-/]+\//g)].map((match) => match[0])
  const demos = files.filter((file) => file.startsWith('demos/') && file.endsWith('.tsx') && directories.some((dir) => file.startsWith(dir)))
  return { id: card.name, category: card.category, summary: card.summary, use: card.use, duration: card.duration,
    energy: card.energy, source: card.source, styles: card.styles.map(({ key, label }) => ({ key, label })), demos }
})
writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify({ source: 'https://github.com/Vincentwei1021/video-shotcraft',
  commit, license: 'Apache-2.0', cards, files: checksums }, null, 2) + '\n')
console.log(`Shotcraft ${commit}: ${cards.length} cards, ${cards.reduce((sum, card) => sum + card.styles.length, 0)} styles, ${files.length} source files`)
