// Isolated video dependencies: no Remotion/esbuild is loaded or installed at plugin startup.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

const localRequire = createRequire(import.meta.url)
const MANIFEST = fileURLToPath(new URL('./runtime/package.json', import.meta.url))
const LOCK = fileURLToPath(new URL('./runtime/package-lock.json', import.meta.url))
const fingerprint = createHash('sha256').update(readFileSync(LOCK)).digest('hex')
const spec = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const key = `v1-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}-${fingerprint.slice(0, 12)}`
const pending = new Map()

function waitForInitialization(work, signal) {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise((done, fail) => {
    const abort = () => fail(signal.reason || new Error('已取消视频环境初始化'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(done, fail).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function videoRuntimeDirectory() {
  const directory = resolve(process.env.DRAWAI_VIDEO_RUNTIME_DIR || join(homedir(), '.dsh', 'drawai-video-runtime', key))
  if ([parse(directory).root, resolve(homedir()), resolve(process.cwd())].includes(directory))
    throw new Error('视频运行环境必须使用独立子目录')
  return directory
}

export function videoRuntimeRequire(directory = videoRuntimeDirectory()) {
  return createRequire(join(directory, 'package.json'))
}

function validate(directory, native = false) {
  const require = videoRuntimeRequire(directory)
  for (const [name, version] of Object.entries(spec.dependencies)) {
    let file
    try { file = require.resolve(name + '/package.json') } catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
      let parent = dirname(require.resolve(name))
      while (dirname(parent) !== parent) {
        const candidate = join(parent, 'package.json')
        if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === name) { file = candidate; break }
        parent = dirname(parent)
      }
      if (!file) throw new Error('缺少视频依赖清单：' + name)
    }
    const rel = relative(realpathSync(join(directory, 'node_modules')), realpathSync(file))
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
      throw new Error('视频依赖未安装在独立目录：' + name)
    if (JSON.parse(readFileSync(file, 'utf8')).version !== version) throw new Error('视频依赖版本不匹配：' + name)
  }
  if (!native) return
  // Validate in a child so Windows DLL handles and cached module paths don't
  // pin the staging directory while it is atomically renamed into the cache.
  const checked = spawnSync(process.execPath, ['-e',
    "const r=require('node:module').createRequire(process.argv[1]);const b=r('@remotion/bundler');r('@remotion/renderer');if(!b.BundlerInternals.esbuild.transformSync('const n: number = 1',{loader:'ts'}).code)process.exit(1)",
    join(directory, 'package.json')], { windowsHide: true, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  if (checked.status !== 0) throw new Error('视频二进制验证失败：' + (checked.error?.message || checked.stderr))
}

export function videoRuntimeState() {
  const directory = videoRuntimeDirectory()
  try {
    const ready = JSON.parse(readFileSync(join(directory, '.ready.json'), 'utf8'))
    if (ready.fingerprint !== fingerprint || ready.key !== key) return { ready: false, directory }
    validate(directory)
    return { ready: true, directory }
  } catch { return { ready: false, directory } }
}

function install(directory, { signal, onProgress }) {
  const cli = join(dirname(localRequire.resolve('npm/package.json')), 'bin', 'npm-cli.js')
  const registry = process.env.DRAWAI_RUNTIME_REGISTRY || 'https://registry.npmjs.org'
  const url = new URL(registry)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('视频依赖 registry 地址无效')
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, 'ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund',
      '--registry=' + url.href, '--fetch-retries=1', '--fetch-timeout=30000', '--loglevel=error'], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', npm_config_ignore_scripts: 'true' },
    })
    let stderr = '', settled = false
    const abort = () => child.kill()
    const timer = setTimeout(() => child.kill(), 10 * 60000)
    const progress = setInterval(() => onProgress?.({ phase: 'runtime-installing', message: '正在下载和校验视频依赖，首次初始化可能需要数分钟' }), 5000)
    const finish = error => {
      if (settled) return
      settled = true; clearTimeout(timer); clearInterval(progress); signal?.removeEventListener('abort', abort)
      if (signal?.aborted) fail(signal.reason || new Error('已取消视频环境初始化'))
      else if (error) fail(error)
      else done()
    }
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
    child.on('error', finish)
    child.on('close', code => finish(code === 0 ? null : new Error('视频依赖安装失败（' + code + '）：' + stderr)))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

async function initialize({ signal, onProgress }) {
  const directory = videoRuntimeDirectory(), lock = directory + '.lock'
  if (existsSync(directory)) {
    const previous = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (previous.name !== spec.name) throw new Error('缓存位置包含其他文件，请指定独立目录')
  }
  mkdirSync(dirname(directory), { recursive: true })
  // Coordinate independent render workers. A dead owner's lock is recoverable.
  let ownsLock = false
  const deadline = Date.now() + 11 * 60000
  while (!ownsLock) {
    signal?.throwIfAborted()
    try {
      mkdirSync(lock)
      ownsLock = true
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    } catch (error) {
      if (ownsLock || error.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('invalid lock owner')
        try { process.kill(owner.pid, 0) } catch (e) {
          if (e.code === 'ESRCH') { rmSync(lock, { recursive: true, force: true }); continue }
        }
      } catch {
        // Recover if the installer crashed between mkdir and writing its owner.
        if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30000) {
          rmSync(lock, { recursive: true, force: true }); continue
        }
      }
      if (Date.now() > deadline) throw new Error('等待其他视频环境初始化超时，请重试')
      onProgress?.({ phase: 'runtime-installing', message: '正在等待共享视频运行环境就绪' })
      await new Promise(done => setTimeout(done, 500))
    }
  }
  const staging = directory + '.tmp-' + randomUUID()
  try {
    if (videoRuntimeState().ready) return directory
    onProgress?.({ phase: 'runtime-installing', message: '首次使用：正在初始化独立视频运行环境' })
    signal?.throwIfAborted()
    mkdirSync(staging)
    writeFileSync(join(staging, 'package.json'), readFileSync(MANIFEST))
    writeFileSync(join(staging, 'package-lock.json'), readFileSync(LOCK))
    await install(staging, { signal, onProgress })
    signal?.throwIfAborted()
    onProgress?.({ phase: 'runtime-checking', message: '正在验证视频运行环境' })
    validate(staging, true)
    writeFileSync(join(staging, '.ready.json'), JSON.stringify({ fingerprint, key }))
    // Only replace this cache after installation and native-binary validation succeed.
    if (existsSync(directory)) {
      const previous = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (previous.name !== spec.name) throw new Error('缓存位置包含其他文件，请指定独立目录')
      rmSync(directory, { recursive: true, force: true })
    }
    renameSync(staging, directory)
    onProgress?.({ phase: 'runtime-ready', message: '视频运行环境已就绪，后续离线复用' })
    return directory
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(lock, { recursive: true, force: true })
  }
}

export async function ensureVideoRuntime(options = {}) {
  options.signal?.throwIfAborted()
  const state = videoRuntimeState()
  if (state.ready) return state.directory
  // A caller's cancellation must not cancel another caller's shared initialization.
  if (pending.has(state.directory)) {
    try { await waitForInitialization(pending.get(state.directory), options.signal) } catch { /* Another caller may have cancelled. */ }
    options.signal?.throwIfAborted()
    return ensureVideoRuntime(options)
  }
  const work = initialize({ ...options, onProgress: options.onProgress || (event => console.error('[drawai] ' + event.message)) }).catch(error => {
    throw new Error('视频运行环境未就绪：' + error.message + '\n联网后重试当前操作即可重新初始化。可用 DRAWAI_RUNTIME_REGISTRY 设置镜像，DRAWAI_VIDEO_RUNTIME_DIR 设置缓存目录。', { cause: error })
  }).finally(() => pending.delete(state.directory))
  pending.set(state.directory, work)
  return work
}

export async function loadVideoModule(name, options = {}) {
  if (!Object.hasOwn(spec.dependencies, name)) throw new Error('不支持的视频模块：' + name)
  const directory = await ensureVideoRuntime(options)
  return videoRuntimeRequire(directory)(name)
}
