import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ensureVideoRuntime, videoRuntimeState, loadVideoModule } from '../src/motion/video-runtime.js'

mkdirSync('.tmp', { recursive: true })
const root = mkdtempSync(resolve('.tmp/runtime-check-'))
const originalDir = process.env.DRAWAI_VIDEO_RUNTIME_DIR, originalRegistry = process.env.DRAWAI_RUNTIME_REGISTRY
const restore = (name, value) => value === undefined ? delete process.env[name] : process.env[name] = value
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const name of Object.keys(pkg.dependencies)) assert.ok(!/^(?:@remotion\/|@react-three\/|remotion$|react(?:-dom)?$|three$|esbuild$)/.test(name))
  process.env.DRAWAI_VIDEO_RUNTIME_DIR = join(root, 'runtime')
  assert.equal(videoRuntimeState().ready, false, 'import and state inspection do not install anything')
  assert.deepEqual(readdirSync(root), [])
  const controller = new AbortController(); controller.abort(new Error('test cancellation'))
  await assert.rejects(ensureVideoRuntime({ signal: controller.signal }), /test cancellation/)
  assert.deepEqual(readdirSync(root), [])
  await assert.rejects(loadVideoModule('unapproved-module'), /不支持/)
  process.env.DRAWAI_RUNTIME_REGISTRY = 'file:///not-a-registry'
  await assert.rejects(ensureVideoRuntime(), /registry 地址无效/)
  assert.deepEqual(readdirSync(root), [], 'failed initialization cleans staging and lock for retry')
  await assert.rejects(ensureVideoRuntime(), /registry 地址无效/, 'later operations attempt initialization again')
  mkdirSync(join(root, 'runtime'))
  writeFileSync(join(root, 'runtime', 'package.json'), JSON.stringify({ name: 'unrelated-user-data' }))
  await assert.rejects(ensureVideoRuntime(), /包含其他文件/)
  assert.equal(JSON.parse(readFileSync(join(root, 'runtime', 'package.json'))).name, 'unrelated-user-data')
  if (process.argv.includes('--live')) {
    process.env.DRAWAI_VIDEO_RUNTIME_DIR = join(root, 'live')
    restore('DRAWAI_RUNTIME_REGISTRY', originalRegistry)
    const phases = []
    const firstWork = ensureVideoRuntime({ onProgress: event => phases.push(event.phase) })
    const waiterAbort = new AbortController()
    const cancelledWaiter = ensureVideoRuntime({ signal: waiterAbort.signal })
    waiterAbort.abort(new Error('cancel shared waiter'))
    await assert.rejects(cancelledWaiter, /cancel shared waiter/)
    const [first, second] = await Promise.all([firstWork, ensureVideoRuntime()])
    assert.equal(first, second, 'concurrent callers reuse one initialization')
    assert.equal(phases.filter(phase => phase === 'runtime-ready').length, 1)
    assert.equal(videoRuntimeState().ready, true)
    process.env.DRAWAI_RUNTIME_REGISTRY = 'file:///not-a-registry'
    assert.equal(await ensureVideoRuntime(), first, 'ready cache is reused offline')
    const renderer = await loadVideoModule('@remotion/renderer')
    assert.equal(typeof renderer.renderStill, 'function')
    // Do not import native modules in this process before cleanup on Windows.
    console.log('Live runtime: script-free install, native validation, concurrency and offline reuse passed')
  }
  console.log('Video runtime: lazy startup, dependency separation, cancellation, failed-install retry and directory protection passed')
} finally {
  restore('DRAWAI_VIDEO_RUNTIME_DIR', originalDir)
  restore('DRAWAI_RUNTIME_REGISTRY', originalRegistry)
  rmSync(root, { recursive: true, force: true })
}
