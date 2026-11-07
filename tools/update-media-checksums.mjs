// Record checksums of the actual bundled bytes without changing upstream provenance.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = 'src/motion/media-library'
const index = JSON.parse(readFileSync(join(root, 'upstream-files.json'), 'utf8'))
const files = {}
for (const item of index.files) {
  const bytes = readFileSync(join(root, ...item.path.split('/')))
  files[item.path] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
writeFileSync(join(root, 'checksums.sha256.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n')
console.log('已记录 ' + Object.keys(files).length + ' 项素材的 SHA-256')
