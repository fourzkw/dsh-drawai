import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, crc32Fallback, ensureFfmpeg, resetFfmpegCache } from '../src/ffmpeg-manager.js'

// 这些测试不碰真实网络，也不碰用户的 FFmpeg 缓存：所有 cacheDir 都是本测试临时目录，
// 清理只用 resetFfmpegCache({ cacheDir, platform, arch }) 删除本平台子目录。

const REQUIRED = {
  encoders: ['libx264', 'libvpx-vp9', 'aac', 'libopus', 'gif', 'png', 'mjpeg', 'prores_ks', 'ffv1', 'pcm_s16le', 'pcm_s24le', 'rawvideo'],
  decoders: ['h264', 'hevc', 'vp9', 'png', 'mjpeg', 'gif', 'aac', 'opus', 'mp3', 'flac', 'vorbis', 'pcm_s16le', 'pcm_s24le'],
  filters: ['scale', 'crop', 'pad', 'overlay', 'split', 'lutrgb', 'palettegen', 'paletteuse', 'tile', 'fps', 'format', 'tpad', 'trim', 'setpts', 'setsar', 'select', 'signalstats', 'metadata', 'gblur', 'color', 'amix', 'alimiter', 'afade', 'apad', 'atrim', 'adelay', 'loudnorm', 'ebur128', 'volumedetect', 'blackdetect', 'freezedetect', 'silencedetect', 'volume', 'aloop', 'asetpts'],
  muxers: ['mp4', 'mov', 'webm', 'gif', 'matroska', 'image2', 'image2pipe', 'wav', 'null', 'rawvideo', 's16le', 'ipod'],
  demuxers: ['mp4', 'mov', 'm4a', 'matroska', 'webm', 'ogg', 'wav', 'mp3', 'flac', 'aac', 'gif', 'image2', 'lavfi'],
}
const FEATURES = Object.fromEntries(Object.entries(REQUIRED).map(([key, names]) => [key, new Set(names)]))
const probe = async (binary) => existsSync(binary) ? { ok: true, version: 'test-1' } : { ok: false, reason: '文件不存在' }
const fullFeatures = async () => FEATURES
const withoutFeature = (key, name) => async () => ({ ...FEATURES, [key]: new Set([...FEATURES[key]].filter((item) => item !== name)) })

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 最小 ZIP 写入器（store 方式），够验证中央目录/本地头/CRC 的读取。 */
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc32(data) >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(10, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc32(data) >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

const archive = zip([
  { name: 'ffmpeg', data: Buffer.from('decoy-root-binary') },
  { name: 'ffmpeg-test/bin/ffmpeg', data: Buffer.from('real-bundled-binary') },
])
const digest = sha256(archive)
const root = mkdtempSync(join(tmpdir(), 'drawai-ffmpeg-test-'))
const savedPath = process.env.PATH
const savedExplicit = process.env.DRAWAI_FFMPEG_PATH
const savedMirror = process.env.DRAWAI_FFMPEG_MIRROR
let requests = 0
let lastUrl = ''
let server
const sockets = new Set()

function registry(port, overrides = {}) {
  return {
    'linux-x64': {
      version: 'test-1',
      archive: 'zip',
      url: `http://127.0.0.1:${port}/ffmpeg.zip`,
      size: archive.length,
      sha256: digest,
      license: 'test-only',
      credit: 'test',
      homepage: 'http://127.0.0.1/',
      ...overrides,
    },
  }
}

function options(cacheDir, port, extra = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    cacheDir,
    registry: registry(port, extra.entry),
    probe,
    readFeatures: extra.readFeatures || fullFeatures,
    smoke: extra.smoke || (async () => ({ ok: true })),
    allowDevelopment: false,
    ...extra.options,
  }
}

function leftovers(cacheDir) {
  return existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.startsWith('.staging-') || name.startsWith('.lock-')) : []
}

async function waitFor(predicate, timeout = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

try {
  server = createServer((req, res) => {
    requests += 1
    lastUrl = req.url
    if (req.url === '/ffmpeg.zip' || req.url === '/mirror/ffmpeg.zip') {
      res.writeHead(200, { 'content-length': archive.length, 'content-type': 'application/zip' })
      res.end(archive)
      return
    }
    if (req.url === '/stream.zip') {
      res.writeHead(200, { 'content-length': archive.length, 'content-type': 'application/zip' })
      res.write(archive.subarray(0, 16))
      // 留出足够窗口让第二个调用者加入，并测试各自取消。
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return
        res.write(archive.subarray(16))
        res.end()
      }, 120)
      return
    }
    if (req.url === '/slow.zip') {
      res.writeHead(200, { 'content-length': archive.length + 1024 })
      res.write(Buffer.alloc(64))
      // 不结束响应：让 AbortSignal 在下载中途取消。
      return
    }
    res.writeHead(404).end()
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  delete process.env.DRAWAI_FFMPEG_PATH
  delete process.env.DRAWAI_FFMPEG_MIRROR
  process.env.PATH = ''

  // 0) CRC32 在 Node 20 上也要可用（zlib.crc32 从 Node 22.2 才有）。
  {
    assert.equal(crc32Fallback(Buffer.from('123456789')), 0xcbf43926)
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
    console.log('  crc32 fallback: OK')
  }

  // 1) 下载 → 校验 → 解压 → 功能检查 → 缓存；优先取 bin/ 下的二进制。
  {
    const cacheDir = join(root, 'install')
    const phases = []
    const installed = await ensureFfmpeg(options(cacheDir, port, { options: { onProgress: (event) => phases.push(event.phase) } }))
    assert.equal(installed, join(cacheDir, 'linux-x64', 'ffmpeg'))
    assert.equal(readFileSync(installed, 'utf8'), 'real-bundled-binary', '归档里的 bin/ffmpeg 优先于根目录同名诱饵')
    assert.ok(existsSync(join(cacheDir, 'linux-x64', '.ready.json')), '安装完成后写入 ready 标记')
    const ready = JSON.parse(readFileSync(join(cacheDir, 'linux-x64', '.ready.json'), 'utf8'))
    assert.equal(ready.schema, 1)
    assert.equal(ready.version, 'test-1')
    assert.equal(ready.source.sha256, digest)
    assert.equal(ready.binarySize, Buffer.byteLength('real-bundled-binary'))
    for (const phase of ['download', 'verify', 'extract', 'check', 'ready']) assert.ok(phases.includes(phase), '缺少进度阶段 ' + phase)
    assert.deepEqual(leftovers(cacheDir), [], '安装成功后不留下 staging 或锁目录')

    const before = requests
    const cached = await ensureFfmpeg(options(cacheDir, port, { options: { refresh: true } }))
    assert.equal(cached, installed)
    assert.equal(requests, before, '已安装的缓存不应再次联网')
    console.log('  install + cache reuse: OK')
  }

  // 2) 哈希错误要拒绝、清理临时文件；改正后可以重试。
  {
    const cacheDir = join(root, 'checksum')
    await assert.rejects(ensureFfmpeg(options(cacheDir, port, { entry: { sha256: '0'.repeat(64) } })), /下载校验失败/)
    assert.deepEqual(leftovers(cacheDir), [], '校验失败后清理 staging 与锁')
    assert.equal(existsSync(join(cacheDir, 'linux-x64')), false, '校验失败不能留下半成品')
    const installed = await ensureFfmpeg(options(cacheDir, port))
    assert.ok(existsSync(installed), '修正哈希后重试成功')
    console.log('  checksum rejection + retry: OK')
  }

  // 3) 大小不符也拒绝。
  {
    const cacheDir = join(root, 'size')
    await assert.rejects(ensureFfmpeg(options(cacheDir, port, { entry: { size: archive.length + 1 } })), /下载不完整/)
    assert.deepEqual(leftovers(cacheDir), [], '大小不符后也要清理')
    console.log('  size rejection: OK')
  }

  // 4) 显式路径无效：直接说明问题，不回退到下载。
  {
    const cacheDir = join(root, 'explicit')
    process.env.DRAWAI_FFMPEG_PATH = join(root, 'missing-ffmpeg')
    const before = requests
    await assert.rejects(ensureFfmpeg(options(cacheDir, port, { options: { refresh: true } })), /不可用/)
    assert.equal(requests, before, '显式路径无效时不应偷偷下载')
    assert.equal(existsSync(join(cacheDir, 'linux-x64')), false)
    delete process.env.DRAWAI_FFMPEG_PATH
    console.log('  invalid explicit path: OK')
  }

  // 5) 显式路径能跑但缺功能：列出缺失项，不静默替换。
  {
    const bin = join(root, 'pathbin-feature', 'ffmpeg')
    mkdirSync(join(root, 'pathbin-feature'), { recursive: true })
    writeFileSync(bin, 'fake')
    chmodSync(bin, 0o755)
    process.env.DRAWAI_FFMPEG_PATH = bin
    const cacheDir = join(root, 'explicit-feature')
    const before = requests
    await assert.rejects(
      ensureFfmpeg(options(cacheDir, port, { readFeatures: withoutFeature('filters', 'overlay'), options: { refresh: true } })),
      (error) => /缺少项目需要的组件/.test(error.message) && /overlay/.test(error.message) && /不会被自动替换/.test(error.message),
    )
    assert.equal(requests, before, '显式路径缺功能时不能改去下载')
    assert.equal(existsSync(join(cacheDir, 'linux-x64')), false)
    delete process.env.DRAWAI_FFMPEG_PATH
    console.log('  explicit path missing features: OK')
  }

  // 5b) 显式路径版本过旧：给出明确版本要求，不回退。
  {
    const bin = join(root, 'pathbin-old', 'ffmpeg')
    mkdirSync(join(root, 'pathbin-old'), { recursive: true })
    writeFileSync(bin, 'fake')
    chmodSync(bin, 0o755)
    process.env.DRAWAI_FFMPEG_PATH = bin
    const cacheDir = join(root, 'explicit-old')
    const before = requests
    await assert.rejects(
      ensureFfmpeg(options(cacheDir, port, { options: { refresh: true, probe: async () => ({ ok: true, version: '4.1.2' }) } })),
      (error) => /版本过旧/.test(error.message) && /5\.1/.test(error.message) && /不会被自动替换/.test(error.message),
    )
    assert.equal(requests, before, '显式路径版本过旧时不能改去下载')
    delete process.env.DRAWAI_FFMPEG_PATH
    console.log('  explicit old version: OK')
  }

  // 5c) 清单齐全但实际选项不兼容（例如 FFmpeg 4.x 没有 -fps_mode）：编码自检拦下。
  {
    const bin = join(root, 'pathbin-smoke', 'ffmpeg')
    mkdirSync(join(root, 'pathbin-smoke'), { recursive: true })
    writeFileSync(bin, 'fake')
    chmodSync(bin, 0o755)
    process.env.DRAWAI_FFMPEG_PATH = bin
    const cacheDir = join(root, 'explicit-smoke')
    const before = requests
    await assert.rejects(
      ensureFfmpeg(options(cacheDir, port, { options: { refresh: true, smoke: async () => ({ ok: false, reason: "Unrecognized option 'fps_mode'" }) } })),
      (error) => /实际编码自检失败/.test(error.message) && /fps_mode/.test(error.message) && /不会被自动替换/.test(error.message),
    )
    assert.equal(requests, before, '编码自检失败时不能改去下载')
    delete process.env.DRAWAI_FFMPEG_PATH
    console.log('  explicit smoke failure: OK')
  }

  // 6) PATH 里的 FFmpeg 也要校验功能；缺功能时跳到下一个来源。
  {
    const binDir = join(root, 'pathbin')
    const bin = join(binDir, 'ffmpeg')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(bin, 'fake')
    chmodSync(bin, 0o755)
    process.env.PATH = binDir

    const brokenCache = join(root, 'path-broken')
    const before = requests
    const pathBroken = async (binary) => binary.includes('pathbin') ? { ...FEATURES, filters: new Set([...FEATURES.filters].filter((item) => item !== 'signalstats')) } : FEATURES
    const installed = await ensureFfmpeg(options(brokenCache, port, { readFeatures: pathBroken, options: { refresh: true } }))
    assert.equal(installed, join(brokenCache, 'linux-x64', 'ffmpeg'), 'PATH 缺功能时应回退到下载')
    assert.equal(requests - before, 1)

    const healthyCache = join(root, 'path-healthy')
    const fromPath = await ensureFfmpeg(options(healthyCache, port, { options: { refresh: true } }))
    assert.equal(fromPath, bin, 'PATH 中的完整版本优先于下载')
    assert.equal(existsSync(join(healthyCache, 'linux-x64')), false, 'PATH 可用时不应创建缓存')
    process.env.PATH = ''
    console.log('  path feature validation + fallback: OK')
  }

  // 7) 缓存版本/哈希损坏：重新下载，而不是继续复用。
  {
    const cacheDir = join(root, 'corrupt')
    const installed = await ensureFfmpeg(options(cacheDir, port))
    const readyFile = join(cacheDir, 'linux-x64', '.ready.json')
    const ready = JSON.parse(readFileSync(readyFile, 'utf8'))
    writeFileSync(readyFile, JSON.stringify({ ...ready, version: '9.9.9' }))
    const beforeVersion = requests
    assert.equal(await ensureFfmpeg(options(cacheDir, port, { options: { refresh: true } })), installed)
    assert.equal(requests - beforeVersion, 1, '版本不符应重新下载')

    writeFileSync(installed, 'tampered-binary')
    const beforeHash = requests
    assert.equal(await ensureFfmpeg(options(cacheDir, port, { options: { refresh: true } })), installed)
    assert.equal(requests - beforeHash, 1, '二进制哈希不符应重新下载')
    assert.equal(readFileSync(installed, 'utf8'), 'real-bundled-binary')
    console.log('  cache corruption detection: OK')
  }

  // 8) 并发调用：共享下载，但第二个调用者取消不影响第一个。
  {
    const cacheDir = join(root, 'concurrent-abort-second')
    const first = new AbortController()
    const second = new AbortController()
    const firstPromise = ensureFfmpeg(options(cacheDir, port, {
      entry: { url: `http://127.0.0.1:${port}/stream.zip` },
      options: { signal: first.signal },
    }))
    const secondPhases = []
    let secondPromise
    await waitFor(() => requests > 0)
    secondPromise = ensureFfmpeg(options(cacheDir, port, {
      entry: { url: `http://127.0.0.1:${port}/stream.zip` },
      options: { signal: second.signal, onProgress: (event) => secondPhases.push(event.phase) },
    }))
    assert.notEqual(firstPromise, secondPromise, '每个调用者应有独立的 Promise')
    await new Promise((resolve) => setTimeout(resolve, 40))
    second.abort()
    await assert.rejects(secondPromise, (error) => error.name === 'AbortError' || error.code === 'FFMPEG_CANCELLED')
    const installed = await firstPromise
    assert.ok(existsSync(installed), '第二个调用者取消后第一个仍能完成')
    assert.ok(secondPhases.includes('download'), '第二个调用者收到自己的进度快照')
    console.log('  concurrent independent cancellation (second): OK')
  }

  // 9) 第一个调用者取消，其余调用者仍能完成。
  {
    const cacheDir = join(root, 'concurrent-abort-first')
    const first = new AbortController()
    const firstPromise = ensureFfmpeg(options(cacheDir, port, {
      entry: { url: `http://127.0.0.1:${port}/stream.zip` },
      options: { signal: first.signal },
    }))
    await waitFor(() => requests > 0)
    const secondPromise = ensureFfmpeg(options(cacheDir, port, { entry: { url: `http://127.0.0.1:${port}/stream.zip` } }))
    first.abort()
    await assert.rejects(firstPromise, (error) => error.name === 'AbortError' || error.code === 'FFMPEG_CANCELLED')
    assert.ok(existsSync(await secondPromise), '第一个取消不影响第二个')
    console.log('  concurrent independent cancellation (first): OK')
  }

  // 10) 全部取消才中止下载；之后可以重试。
  {
    const cacheDir = join(root, 'cancel')
    const a = new AbortController()
    const b = new AbortController()
    const aPromise = ensureFfmpeg(options(cacheDir, port, { entry: { url: `http://127.0.0.1:${port}/slow.zip` }, options: { signal: a.signal } }))
    await waitFor(() => requests > 0)
    const bPromise = ensureFfmpeg(options(cacheDir, port, { entry: { url: `http://127.0.0.1:${port}/slow.zip` }, options: { signal: b.signal } }))
    a.abort(); b.abort()
    await assert.rejects(aPromise)
    await assert.rejects(bPromise)
    await waitFor(() => leftovers(cacheDir).length === 0)
    const retried = await ensureFfmpeg(options(cacheDir, port, { options: { refresh: true } }))
    assert.ok(existsSync(retried), '全部取消后再次调用可以重新安装')
    console.log('  all-cancel cleanup + retry: OK')
  }

  // 11) 镜像：只替换下载地址，哈希仍按注册表校验。
  {
    const cacheDir = join(root, 'mirror')
    process.env.DRAWAI_FFMPEG_MIRROR = `http://127.0.0.1:${port}/mirror`
    const installed = await ensureFfmpeg(options(cacheDir, port, { options: { refresh: true } }))
    assert.ok(existsSync(installed))
    assert.equal(lastUrl, '/mirror/ffmpeg.zip')
    delete process.env.DRAWAI_FFMPEG_MIRROR
    console.log('  mirror download: OK')
  }

  // 12) 清理缓存只删本平台目录，不碰用户自己放的文件或其他平台。
  {
    const cacheDir = join(root, 'safety')
    mkdirSync(join(cacheDir, 'linux-x64'), { recursive: true })
    mkdirSync(join(cacheDir, 'darwin-arm64'), { recursive: true })
    mkdirSync(join(cacheDir, '.staging-linux-x64-abc'), { recursive: true })
    mkdirSync(join(cacheDir, '.staging-darwin-arm64-keep'), { recursive: true })
    mkdirSync(join(cacheDir, '.lock-linux-x64'), { recursive: true })
    writeFileSync(join(cacheDir, 'user-notes.txt'), 'keep me')
    writeFileSync(join(cacheDir, 'linux-x64', 'old.txt'), 'remove me')
    writeFileSync(join(cacheDir, 'darwin-arm64', 'keep.txt'), 'keep me too')
    await resetFfmpegCache({ cacheDir, platform: 'linux', arch: 'x64' })
    assert.equal(existsSync(join(cacheDir, 'user-notes.txt')), true, '用户自己的文件不能被删')
    assert.equal(existsSync(join(cacheDir, 'darwin-arm64', 'keep.txt')), true, '其他平台的缓存不能被删')
    assert.equal(existsSync(join(cacheDir, '.staging-darwin-arm64-keep')), true, '其他平台的 staging 不能被删')
    assert.equal(existsSync(join(cacheDir, 'linux-x64')), false, '本平台缓存应删除')
    assert.equal(existsSync(join(cacheDir, '.staging-linux-x64-abc')), false, '本平台 staging 应删除')
    assert.equal(existsSync(join(cacheDir, '.lock-linux-x64')), false, '本平台锁应删除')
    console.log('  cache cleanup is scoped: OK')
  }

  // 13) 不支持的平台：给手动配置提示。
  {
    const cacheDir = join(root, 'unsupported')
    await assert.rejects(ensureFfmpeg({ platform: 'plan9', arch: 'x64', cacheDir, registry: {}, allowDevelopment: false }), /没有可自动下载/)
    console.log('  unsupported platform: OK')
  }

  console.log('check-ffmpeg-manager: OK (features, cache scope, checksum, zip, cancellation, concurrency, mirror, crc32 fallback)')
} finally {
  if (server) {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
  process.env.PATH = savedPath
  if (savedExplicit === undefined) delete process.env.DRAWAI_FFMPEG_PATH
  else process.env.DRAWAI_FFMPEG_PATH = savedExplicit
  if (savedMirror === undefined) delete process.env.DRAWAI_FFMPEG_MIRROR
  else process.env.DRAWAI_FFMPEG_MIRROR = savedMirror
  rmSync(root, { recursive: true, force: true })
}
