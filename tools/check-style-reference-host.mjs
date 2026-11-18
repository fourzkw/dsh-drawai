import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the real registered host tools with a small local-only collection.
const testParent = resolve('.tmp')
mkdirSync(testParent, { recursive: true })
const root = mkdtempSync(join(testParent, 'drawai-ref-host-'))
const oldRef = process.env.DRAWAI_STYLE_REFERENCE_DIR
const oldAssets = process.env.DRAWAI_ASSETS_DIR
const oldUrl = process.env.DRAWAI_ASSETS_URL
process.env.DRAWAI_STYLE_REFERENCE_DIR = join(root, 'references')
process.env.DRAWAI_ASSETS_DIR = join(root, 'missing-assets')
process.env.DRAWAI_ASSETS_URL = 'http://127.0.0.1:9/unavailable'

try {
  const refDir = join(process.env.DRAWAI_STYLE_REFERENCE_DIR, '06-collage')
  mkdirSync(refDir, { recursive: true })
  const image = join(refDir, 'frame-01.png')
  copyFileSync(resolve('tools/fixtures/image-trace-small-reference.png'), image)
  const bytes = readFileSync(image)
  writeFileSync(join(refDir, 'manifest.json'), JSON.stringify({
    slug: '06-collage', source_url: 'https://example.test/source.mp4', source_license: 'test-only',
    source_video_duration_seconds: 10, source_video_frame_rate: '30/1',
    frames: [{ file: 'frame-01.png', frame_index: 30, time_seconds: 1, sha256: createHash('sha256').update(bytes).digest('hex') }],
  }))

  // A clean installed plugin has no bundled fonts/media; isolate the compiled copy
  // so the test remains offline even on developer machines with local assets.
  const sourceLib = resolve('lib'), isolatedLib = join(root, 'lib')
  cpSync(sourceLib, isolatedLib, { recursive: true, filter: source => {
    const parts = relative(sourceLib, source).split(/[\\/]/)
    return !(parts[0] === 'motion' && ['fonts', 'media-library'].includes(parts[1]))
  } })
  const load = file => import(pathToFileURL(join(isolatedLib, file)).href)
  const { buildCanvas } = await load('canvas-format.js')
  const { motionNodeData } = await load('motion-core.js')
  const { assetsSummary } = await load('motion/asset-pack.js')
  const { apply } = await load('index.js')
  assert.equal(assetsSummary().ready, false, '测试必须没有已安装的旧素材包')
  const canvas = join(root, 'test.drawai'), project = join(root, '.drawai-motion', 'movie')
  const node = { id: 'movie', label: '', x: 0, y: 0, w: 320, h: 180, style: '', data: motionNodeData() }
  node.data.motion.project = '.drawai-motion/movie'
  writeFileSync(canvas, buildCanvas({ meta: {}, nodes: [node], edges: [], layers: [{ id: '1' }] }, { format: 'drawai' }).text)
  mkdirSync(project, { recursive: true })
  const registered = [], session = { header: { cwd: root } }
  const ctx = {
    tools: { register(tool) { registered.push(tool); return () => {} } },
    webServer: { register() { return () => {} } },
    fs: { resolve: async (p, o) => typeof p === 'object' ? p : { path: resolve(o?.cwd || root, p) },
      processPath: target => typeof target === 'string' ? target : target.path,
      contains: (a, b) => { const p = relative(a.path, b.path); return !isAbsolute(p) && !p.startsWith('..') },
      stat: async target => existsSync(target.path) ? { size: readFileSync(target.path).length } : undefined,
      readText: async target => readFileSync(target.path, 'utf8'),
      writeText: async (target, text) => writeFileSync(target.path, text) },
    sessions: { get: id => id === 's' ? session : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
    get() { return undefined }, effect(fn) { return fn() },
  }
  apply(ctx)
  const style = registered.find(tool => tool.name === 'mg_style')
  const assets = registered.find(tool => tool.name === 'motion_assets')
  assert.ok(style && assets)
  const frames = JSON.parse((await style.execute({ action: 'frames', slug: '06-collage', times: [0.9] })).details)
  assert.equal(frames.files.length, 1)
  assert.equal(frames.files[0].time, 1)
  assert.equal(frames.files[0].requestedTime, 0.9)
  assert.equal(frames.files[0].path, image)
  const args = { path: 'test.drawai', nodeId: 'movie' }
  const found = JSON.parse((await assets.execute({ ...args, action: 'library', query: '拼贴', category: 'style-reference' }, { agent: { id: 's' } })).details)
  assert.equal(found.length, 1)
  assert.equal(found[0].id, 'style-reference/06-collage/frame-01.png')
  for (const query of ['拼贴', '拼贴参考帧', '06-collage', 'collage', found[0].id]) {
    const result = JSON.parse((await assets.execute({ ...args, action: 'library', query }, { agent: { id: 's' } })).details)
    assert.equal(result.length, 1, `离线风格查询 ${query} 应返回参考帧`)
  }
  const images = JSON.parse((await assets.execute({ ...args, action: 'library', category: 'image', query: '拼贴' }, { agent: { id: 's' } })).details)
  assert.equal(images.length, 1, '按图片类别搜索风格时不应要求旧素材包')
  const imported = JSON.parse((await assets.execute({ ...args, action: 'use', assetId: found[0].id }, { agent: { id: 's' } })).details)
  assert.equal(imported.kind, 'image')
  assert.equal(imported.source, 'https://example.test/source.mp4')
  assert.equal(imported.license, 'test-only')
  assert.match(imported.use, /^staticFile\(/)
  const migratedRoot = join(root, '.drawai-motion', 'v2')
  const [migrated] = readdirSync(migratedRoot)
  assert.ok(migrated, '素材应导入当前工程')
  assert.equal(readFileSync(join(migratedRoot, migrated, 'assets', imported.file)).compare(bytes), 0)
  assert.equal(assetsSummary().ready, false, '读取参考帧不应下载旧素材包')
  writeFileSync(image, 'damaged')
  const damaged = await assets.execute({ ...args, action: 'library', query: '拼贴' }, { agent: { id: 's' } })
  assert.match(damaged.summary, /SHA-256|不可用/, '参考帧损坏时应向调用方显示原因')
  await assert.rejects(style.execute({ action: 'frames', slug: '06-collage' }), /SHA-256|校验/)
  await assert.rejects(assets.execute({ ...args, action: 'use', assetId: found[0].id }, { agent: { id: 's' } }), /SHA-256|校验/)
  console.log('真实宿主工具：离线查询、获取和导入静态参考帧通过')
} finally {
  for (const [name, value] of [['DRAWAI_STYLE_REFERENCE_DIR', oldRef], ['DRAWAI_ASSETS_DIR', oldAssets], ['DRAWAI_ASSETS_URL', oldUrl]]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const cleanup = relative(testParent, resolve(root))
  if (!cleanup || isAbsolute(cleanup) || cleanup.startsWith('..')) throw new Error('测试清理路径超出临时目录：' + root)
  rmSync(root, { recursive: true, force: true })
}
