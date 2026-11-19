// Isolated video dependencies: no Remotion/esbuild is loaded or installed at plugin startup.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

function validate(directory) {
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
}

const NATIVE_PROBE = "const r=require('node:module').createRequire(process.argv[1]);const b=r('@remotion/bundler');r('@remotion/renderer');if(!b.BundlerInternals.esbuild.transformSync('const n: number = 1',{loader:'ts'}).code)process.exit(1)"

/**
 * 原生依赖校验放在子进程里：Windows 上 DLL 句柄不能钉住待 rename 的 staging。
 * 必须异步 —— 以前 spawnSync(timeout: 90000) 会卡住宿主事件循环，连取消都进不来（issue #57）。
 */
function validateNative(directory, { signal } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['-e', NATIVE_PROBE, join(directory, 'package.json')], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stderr = '', settled = false, timer = null
    function finish(error) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) fail(error); else done()
    }
    function abort() { killTree(child); finish(new Error('已取消视频环境初始化')) }
    timer = setTimeout(() => { killTree(child); finish(new Error('视频二进制验证失败：90 秒内没有完成')) }, 90000)
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', finish)
    child.on('close', (code) => finish(code === 0 ? null : new Error('视频二进制验证失败：' + stderr)))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
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
      cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', npm_config_ignore_scripts: 'true' },
    })
    let stderr = '', settled = false
    // npm 会再拉起孙进程：只 kill 这一层在 Windows 上会留下它们（issue #57）。
    const abort = () => killTree(child)
    const timer = setTimeout(() => killTree(child), 10 * 60000)
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

/** Windows 上 child.kill() 只杀进程本身；npm 拉起的孙进程要 taskkill /T 才会一起退出。 */
function killTree(child) {
  const pid = child?.pid
  if (!pid) { try { child?.kill() } catch { /* ignore */ } return }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { try { child.kill() } catch { /* ignore */ } }
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* ignore */ } }
}

function delay(ms) { return new Promise((done) => setTimeout(done, ms)) }

/** 上次失败留下的 staging 里依赖完整且已通过校验 → 直接复用，不再 259MB 重装。 */
function stagedRuntimeReady(staging) {
  try {
    const ready = JSON.parse(readFileSync(join(staging, '.ready.json'), 'utf8'))
    if (ready.fingerprint !== fingerprint || ready.key !== key) return false
    validate(staging)
    return true
  } catch { return false }
}

/**
 * 把校验通过的 staging 移进缓存。Windows 上 rename 会因杀软/索引服务占用目录报 EPERM，
 * 这里重试、最后一次退化成复制 —— 以前 rename 一次就失败、finally 又把 259MB 删掉（issue #57）。
 */
async function promote(source, target) {
  if (existsSync(target)) {
    const previous = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    if (previous.name !== spec.name) throw new Error('缓存位置包含其他文件，请指定独立目录')
    rmSync(target, { recursive: true, force: true })
  }
  let lastError = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try { renameSync(source, target); return } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
      await delay(150 * (attempt + 1))
    }
  }
  try {
    cpSync(source, target, { recursive: true, errorOnExist: false })
    rmSync(source, { recursive: true, force: true })
  } catch (error) {
    throw new Error('视频运行环境已就绪但无法移入缓存（' + (lastError?.code || lastError?.message || 'unknown') + '）：' + error.message)
  }
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
  // 5 分钟拿不到锁就放弃：11 分钟对一次工具调用来说等于"卡死"（issue #57）。
  const deadline = Date.now() + 5 * 60000
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
      await delay(500)
    }
  }
  // 固定名字的 staging：上次失败留下的可以复用，不用每次从零重装。
  const staging = directory + '.staging'
  let keepStaging = false
  try {
    if (videoRuntimeState().ready) return directory
    signal?.throwIfAborted()
    if (stagedRuntimeReady(staging)) {
      onProgress?.({ phase: 'runtime-checking', message: '复用上次已校验的视频依赖，直接写入缓存' })
      signal?.throwIfAborted()
      await promote(staging, directory)
      onProgress?.({ phase: 'runtime-ready', message: '视频运行环境已就绪，后续离线复用' })
      return directory
    }
    rmSync(staging, { recursive: true, force: true })
    onProgress?.({ phase: 'runtime-installing', message: '首次使用：正在初始化独立视频运行环境' })
    mkdirSync(staging)
    writeFileSync(join(staging, 'package.json'), readFileSync(MANIFEST))
    writeFileSync(join(staging, 'package-lock.json'), readFileSync(LOCK))
    await install(staging, { signal, onProgress })
    signal?.throwIfAborted()
    onProgress?.({ phase: 'runtime-checking', message: '正在验证视频运行环境' })
    validate(staging)
    await validateNative(staging, { signal })
    signal?.throwIfAborted()
    writeFileSync(join(staging, '.ready.json'), JSON.stringify({ fingerprint, key }))
    // Only replace this cache after installation and native-binary validation succeed.
    await promote(staging, directory)
    onProgress?.({ phase: 'runtime-ready', message: '视频运行环境已就绪，后续离线复用' })
    return directory
  } catch (error) {
    // 依赖已装好、只差移入缓存：保留 staging，下次直接 promote，不再重装 259MB。
    if (!existsSync(directory) && existsSync(join(staging, '.ready.json'))) keepStaging = true
    throw error
  } finally {
    if (!keepStaging) rmSync(staging, { recursive: true, force: true })
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
