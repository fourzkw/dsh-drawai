import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject } from '../src/motion/project.js'
import { listAssets } from '../src/motion/assets.js'

const dir = mkdtempSync(join(tmpdir(), 'drawai-builtin-'))
try {
  createProject(dir)
  const items = listAssets(dir)
  assert.deepEqual(items.map((item) => item.file).sort(), [
    'builtin/grain.svg', 'builtin/grid.svg', 'builtin/impact.wav', 'builtin/paper.svg', 'builtin/whoosh.wav',
  ])
  for (const item of items) {
    const data = readFileSync(item.path)
    if (item.kind === 'audio') {
      assert.equal(data.toString('ascii', 0, 4), 'RIFF')
      assert.equal(data.toString('ascii', 8, 12), 'WAVE')
      assert.equal(data.readUInt32LE(40), data.length - 44)
      assert.ok(data.subarray(44).some((byte) => byte !== 0))
    } else assert.match(data.toString(), /<svg/)
  }
  const paper = join(dir, 'assets', 'builtin', 'paper.svg')
  writeFileSync(paper, 'user edited paper')
  createProject(dir)
  assert.equal(readFileSync(paper, 'utf8'), 'user edited paper')
  assert.equal(listAssets(dir).length, 5)
  console.log('内置素材创建、索引与重复创建保护通过')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
