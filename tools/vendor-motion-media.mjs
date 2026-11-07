// Import selected public upstream media at a pinned commit; verify Git blob hashes.
// Usage: node tools/vendor-motion-media.mjs <GitHub tree JSON> [proxy URL]
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const commit = '49052d80bfaf9fa8412cc9710530e5e95a3b8d8c'
const tree = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (tree.sha !== commit || tree.truncated) throw new Error('上游清单版本错误或不完整')
const paths = tree.tree.filter(x => x.type === 'blob' && (x.path.startsWith('assets/textures/') || (x.path.startsWith('lib/audio/samples/') && x.path.endsWith('.flac'))))
if (paths.length !== 111) throw new Error('上游文件数量不符合固定版本: ' + paths.length)
const root = resolve('src/motion/media-library'), proxy = process.argv[3]
function digest(data) { return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') }
let cursor = 0, completed = 0
async function worker() {
  while (cursor < paths.length) {
    const item = paths[cursor++]
    const target = join(root, item.path), part = target + '.part'
    mkdirSync(dirname(target), { recursive: true })
    if (!existsSync(target) || digest(readFileSync(target)) !== item.sha) {
      const url = `https://raw.githubusercontent.com/Vincentwei1021/mg-styles-15/${commit}/` + item.path.split('/').map(encodeURIComponent).join('/')
      await exec('curl.exe', [...(proxy ? ['--proxy', proxy] : []), '--fail', '--silent', '--show-error', '--location', '--retry', '3', '--connect-timeout', '15', '--max-time', '120', '--output', part, url], { windowsHide: true })
      const data = readFileSync(part)
      if (data.length !== item.size || digest(data) !== item.sha) throw new Error('校验失败: ' + item.path)
      renameSync(part, target)
    }
    if (++completed % 15 === 0 || completed === paths.length) console.log(`已校验 ${completed}/${paths.length}`)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
writeFileSync(join(root, 'upstream-files.json'), JSON.stringify({ commit, files: paths.map(({path,sha,size}) => ({path,sha,size})) }, null, 2) + '\n')
console.log('已完成，字节数 ' + paths.reduce((n, x) => n + x.size, 0))
