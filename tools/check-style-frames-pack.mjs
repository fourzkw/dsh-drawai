import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// 参考帧素材包：lock 与 Release 地址的对应关系、安装位置必须是集合子目录、
// 指定目录或用户自己放的集合都不许被覆盖。全程离线（这三条路径都在下载前就返回）。
const testParent = resolve('.tmp')
mkdirSync(testParent, { recursive: true })
const root = mkdtempSync(join(testParent, 'drawai-frames-pack-'))
const saved = {
  frames: process.env.DRAWAI_STYLE_FRAMES_DIR,
  refs: process.env.DRAWAI_STYLE_REFERENCE_DIR,
  url: process.env.DRAWAI_STYLE_FRAMES_URL,
}
const framesRoot = join(root, 'frames')
process.env.DRAWAI_STYLE_FRAMES_DIR = framesRoot
delete process.env.DRAWAI_STYLE_REFERENCE_DIR

try {
  const lockPath = resolve('lib/motion/style-frames-lock.js')
  assert.ok(existsSync(lockPath), '构建产物缺少 lib/motion/style-frames-lock.js，先跑 node tools/build.mjs')
  const load = (file) => import(pathToFileURL(resolve('lib/motion', file)).href)
  const { STYLE_FRAMES_LOCK } = await load('style-frames-lock.js')
  const pack = await load('asset-pack.js')

  // lock 描述的就是一个可定位的 Release 资源。
  assert.match(STYLE_FRAMES_LOCK.version, /^[a-z0-9][a-z0-9_-]*$/i)
  assert.equal(STYLE_FRAMES_LOCK.collection, 'collection-' + STYLE_FRAMES_LOCK.version)
  assert.equal(STYLE_FRAMES_LOCK.file, 'drawai-style-frames-' + STYLE_FRAMES_LOCK.version + '.tar.gz')
  assert.ok(Number.isInteger(STYLE_FRAMES_LOCK.bytes) && STYLE_FRAMES_LOCK.bytes > 1048576, 'lock 里要有包体大小')
  assert.match(STYLE_FRAMES_LOCK.sha256, /^[0-9a-f]{64}$/)
  assert.ok(STYLE_FRAMES_LOCK.files > 100, 'lock 里要有文件数')
  assert.equal(pack.STYLE_FRAMES_TAG, 'style-frames-' + STYLE_FRAMES_LOCK.version)
  assert.equal(pack.STYLE_FRAMES_URL,
    'https://github.com/fourzkw/dsh-drawai/releases/download/' + pack.STYLE_FRAMES_TAG + '/' + STYLE_FRAMES_LOCK.file)

  // 装进集合子目录，而不是父目录：installPack 会先 rmSync 再改名，装到父目录会
  // 连用户自己放的其他 collection-* 一起删掉。
  const dir = pack.styleFramesDir()
  assert.equal(basename(dir), STYLE_FRAMES_LOCK.collection)
  assert.equal(resolve(dirname(dir)), resolve(framesRoot))
  assert.equal(pack.styleFramesParent(), framesRoot)

  let state = pack.styleFramesState()
  assert.equal(state.ready, false, '空目录下不该报告参考帧就绪')
  assert.equal(state.dir, dir)
  assert.equal(state.url, pack.STYLE_FRAMES_URL)
  assert.equal(state.page, pack.STYLE_FRAMES_PAGE)
  const summary = pack.styleFramesSummary()
  assert.equal(summary.ready, false)
  assert.equal(summary.collection, STYLE_FRAMES_LOCK.collection)

  // 用户自己准备了一份 collection-*：直接用，不下载、不覆盖。
  const manual = join(framesRoot, 'collection-20250101')
  mkdirSync(manual, { recursive: true })
  writeFileSync(join(manual, 'index.json'), '{"styles":[]}\n')
  state = pack.styleFramesState()
  assert.equal(state.ready, true)
  assert.equal(resolve(state.root).toLowerCase(), resolve(manual).toLowerCase())
  assert.equal(state.source, 'local')
  const existing = await pack.ensureStyleFrames()
  assert.equal(existing.downloaded, false)
  assert.equal(resolve(existing.root).toLowerCase(), resolve(manual).toLowerCase())

  // 指定了目录就只认那个目录：缺失时报错，不偷偷往默认位置下载。
  process.env.DRAWAI_STYLE_REFERENCE_DIR = join(root, 'mine')
  state = pack.styleFramesState()
  assert.equal(state.ready, false)
  assert.equal(state.envOverride, true)
  await assert.rejects(pack.ensureStyleFrames(), /DRAWAI_STYLE_REFERENCE_DIR/)
  await assert.rejects(pack.requireStyleFrames(), /DRAWAI_STYLE_REFERENCE_DIR/)
  delete process.env.DRAWAI_STYLE_REFERENCE_DIR

  // 目标位置有同名目录、但不是素材包装出来的：拒绝覆盖（会删掉用户自己整理的那份）。
  rmSync(manual, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), '我自己的参考帧\n')
  state = pack.styleFramesState()
  assert.equal(state.ready, false, '没有 index.json 的同名目录不该算就绪')
  await assert.rejects(pack.ensureStyleFrames(), /不是素材包安装/)
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /我自己的参考帧/, '拒绝安装时不能动已有文件')

  // 本地安装：给 file 就完全不联网，大小 / sha256 / manifest 逐文件校验与下载路径一致。
  // 覆盖率依赖 dist 里的真实包；没有包时只验证「找不到文件 / 格式不对」这两条提前返回。
  rmSync(dir, { recursive: true, force: true })
  const archive = resolve('dist', STYLE_FRAMES_LOCK.file)
  if (existsSync(archive)) {
    const installed = await pack.installStyleFramesFromFile(archive)
    assert.equal(installed.source, 'file')
    assert.equal(installed.downloaded, false)
    assert.equal(installed.files, STYLE_FRAMES_LOCK.files)
    state = pack.styleFramesState()
    assert.equal(state.ready, true, '装了本地包之后应当就绪')
    assert.equal(state.source, 'file', '本地安装要能和自动下载区分开')
    assert.equal(state.collection, STYLE_FRAMES_LOCK.collection)
    assert.ok(existsSync(join(pack.styleFramesDir(), 'manifest.json')), '装好的集合要留下 manifest，方便再校验')

    // 同一个集合以目录形态再装一次：目标是自己装的，允许覆盖。
    const fromDir = await pack.installStyleFramesFromFile(pack.styleFramesDir())
    assert.equal(fromDir.files, STYLE_FRAMES_LOCK.files)
    assert.equal(fromDir.source, 'file')

    // 大小 / 哈希对不上就拒收，且不能把已装好的那份弄坏。
    const bad = join(root, 'bad.tar.gz')
    const bytes = readFileSync(archive)
    const corrupted = Buffer.from(bytes)
    corrupted[corrupted.length - 1] ^= 0xff
    writeFileSync(bad, corrupted)
    await assert.rejects(pack.installStyleFramesFromFile(bad), /sha256|大小不对/)
    assert.equal(pack.styleFramesState().ready, true, '拒收坏包时不能动已装好的集合')
  } else {
    assert.ok(true, 'dist 里还没有 ' + STYLE_FRAMES_LOCK.file + '，跳过本地包安装的端到端校验')
  }

  // 提前返回的两条：路径不存在、扩展名不对。都不联网、不动目标目录。
  await assert.rejects(pack.installStyleFramesFromFile(join(root, 'nope.tar.gz')), /找不到这个素材包/)
  const zip = join(root, 'pack.zip')
  writeFileSync(zip, 'x')
  await assert.rejects(pack.installStyleFramesFromFile(zip), /只认 \.tar\.gz/)
  const emptyDir = join(root, 'extracted')
  mkdirSync(emptyDir, { recursive: true })
  writeFileSync(join(emptyDir, 'index.json'), '{"styles":[]}\n')
  await assert.rejects(pack.installStyleFramesFromFile(emptyDir), /没有 manifest\.json/)

  // dist 里如果已经打好了包，它必须和 lock 一致（否则就是发了包却忘了重新打包）。
  if (existsSync(archive)) {
    assert.equal(statSync(archive).size, STYLE_FRAMES_LOCK.bytes, 'dist 里的参考帧包与 lock 大小不一致，重新打包')
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    assert.equal(digest, STYLE_FRAMES_LOCK.sha256, 'dist 里的参考帧包与 lock 的 sha256 不一致，重新打包')
    console.log('参考帧素材包：lock、Release 地址、安装位置与拒绝覆盖通过（dist 包体 sha256 一致）')
  } else {
    console.log('参考帧素材包：lock、Release 地址、安装位置与拒绝覆盖通过（dist 里还没有 ' + STYLE_FRAMES_LOCK.file + '，跳过包体校验）')
  }
} finally {
  for (const [name, value] of [
    ['DRAWAI_STYLE_FRAMES_DIR', saved.frames],
    ['DRAWAI_STYLE_REFERENCE_DIR', saved.refs],
    ['DRAWAI_STYLE_FRAMES_URL', saved.url],
  ]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const cleanup = relative(testParent, resolve(root))
  if (!cleanup || isAbsolute(cleanup) || cleanup.startsWith('..')) throw new Error('测试清理路径超出临时目录：' + root)
  rmSync(root, { recursive: true, force: true })
}
