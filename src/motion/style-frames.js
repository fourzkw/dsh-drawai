/*
 * 取「整片风格」上游 demo 的参考帧。
 *
 * brief 能写清色板与判据，但写不清动效：转场怎么擦、冲击有没有环、相机有没有抖、
 * 颗粒是逐像素还是几百个点 —— 这些只有看帧才知道。这里用上游自带的服务端 + Chrome
 * 打开 demos/<slug>/index.html，按 cues.json 的时间点调 renderAt(t) 截帧，交给模型当
 * 对照物。缺字体/纸纹时用占位资源兜底，并记在 notes 里，不假装素材齐全。
 */
import { loadVideoModule, ensureVideoRuntime } from './video-runtime.js'
import {existsSync,mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {extname,join,normalize,resolve,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {demoAssetsFile, ensureDemoAssets, fontsDir, mediaLibraryRoot} from './asset-pack.js'
import {fontFaces} from './fonts.js'

const UPSTREAM = fileURLToPath(new URL('./mgstyles/upstream', import.meta.url))
// 上游 demo 的 importmap 指向 /node_modules/*：three 由视频运行时提供，d3 / topojson-client /
// opentype.js / simplex-noise 不在运行时依赖里，随插件一起 vendored（见 mgstyles/vendor/README.md）。
// 目录叫 modules 而不是 node_modules：npm 打包会无条件跳过任何 node_modules 目录。
const VENDOR_MODULES = fileURLToPath(new URL('./mgstyles/vendor/modules', import.meta.url))
const DEMO_FONT_ALIASES = {
  '/demos/03-isometric/assets/fonts/Unbounded-800-static.ttf': 'Unbounded',
  '/demos/07-liquid/assets/Fraunces-Liquid-72-900-Soft.ttf': 'Fraunces',
  '/demos/08-morph/assets/fonts/Outfit-SemiBold.ttf': 'Outfit',
  '/demos/10-synthwave/assets/fonts/MrDafoe-Regular.ttf': 'Mr Dafoe',
}
// 上游 demo 自带的数据文件（如 22-hud 的 land-50m.json）不在仓库里：随包的只有代码，
// 数据单独发布到 Release（约 530KB），第一次请求时下载一次并缓存到 ~/.dsh/drawai-assets/。
// 只对 .json 兜这一层：贴图/字体缺了照旧走占位，别为了缺一张图去拉包（issue #27 的取舍）。
const DEMO_DATA_PATTERN = /^\/demos\/[a-z0-9][a-z0-9-]*\/assets\/[^/]+\.json$/i

async function demoDataFile(pathname) {
  const rel = pathname.slice(1)
  const have = demoAssetsFile(rel)
  if (have) return have
  try {
    await ensureDemoAssets()
  } catch {
    return null
  }
  return demoAssetsFile(rel)
}
// 上游 demo 的 importmap 指向 /node_modules/three/...、/node_modules/opentype.js/...，
// 这些包不在 upstream 目录里，得单独挂载。旧版只服务 upstream 目录，于是模块 404、
// window.__ready 永不置真，最后报了句"没有在 120 秒内就绪"——错误信息指向了完全错误的地方。
// 现在 /node_modules/* 先查视频运行时，再回落到随包 vendored 的那一份（issue #27）。


const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
}

// 1×1 透明 PNG：纸纹/贴图没 vendored 时先让页面能 decode 通过，画面里那块会是平的，notes 会写明。
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// 字体没 vendored 时用系统字体顶上：document.fonts.load() 才不会 reject（字形本来就从 glyphs.json 来，
// 参考帧里字的形状可能略有出入，但不会整页 init 失败）。
const SYSTEM_FONT = [
  ...(fontsDir() ? [join(fontsDir(), 'NotoSansSC-VF.ttf')] : []),
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/msyh.ttc',
].find((path) => existsSync(path))

/** 素材库贴图目录：素材包没装好时返回 null。 */
function texturesDir() {
  const root = mediaLibraryRoot()
  return root ? join(root, 'assets', 'textures') : null
}

function flattenNumbers(value, out) {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
  else if (Array.isArray(value)) for (const item of value) flattenNumbers(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenNumbers(item, out)
}

function cueTimes(slug, duration) {
  const file = join(UPSTREAM, 'demos', slug, 'cues.json')
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const out = []
    // bpm/fps 是参数不是时间点；loop 是几何；它们混进来会截到片尾之外的空帧。
    for (const [key, value] of Object.entries(raw)) {
      if (/^(bpm|fps|loop)$/i.test(key)) continue
      flattenNumbers(value, out)
    }
    const limit = Number.isFinite(duration) && duration > 0 ? duration - 0.04 : 60
    return [...new Set(out.filter((t) => t >= 0.05 && t <= limit).map((t) => Math.round(t * 100) / 100))].sort((a, b) => a - b)
  } catch {
    return []
  }
}

function pickTimes(slug, count, explicit, duration) {
  if (Array.isArray(explicit) && explicit.length) {
    const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity
    return explicit.map(Number).filter((t) => Number.isFinite(t) && t >= 0 && t <= limit).slice(0, 24)
  }
  const cues = cueTimes(slug, duration)
  const wanted = Math.max(1, Math.min(24, Math.floor(Number(count) || 8)))
  if (cues.length >= wanted) {
    // 均匀覆盖全片，同时尽量落在 cue 上（动作发生的那几帧信息量最大）
    const min = cues[0], max = cues[cues.length - 1]
    return Array.from({ length: wanted }, (_, i) => {
      const target = min + ((max - min) * i) / Math.max(1, wanted - 1)
      return cues.reduce((best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best), cues[0])
    })
  }
  const max = Number.isFinite(duration) && duration > 0 ? duration : 10
  return Array.from({ length: wanted }, (_, i) => Math.round(((max * i) / Math.max(1, wanted - 1)) * 1000) / 1000)
}

// demo 的 importmap 指向 /node_modules/*：运行时里有的（three）直接用，没有的回落到随包 vendored 的副本。
// 两边都没有说明打包缺文件，提前查出来，几十毫秒就报清缺什么，不必等页面静默卡到超时。
function missingModules(slug, modules) {
  const html = join(UPSTREAM, 'demos', slug, 'index.html')
  let text = ''
  try { text = readFileSync(html, 'utf8') } catch { return [] }
  const refs = [...text.matchAll(/["'](\/node_modules\/[^"']+)["']/g)].map((match) => match[1])
  return [...new Set(refs)].filter((ref) => {
    const relative = ref.slice('/node_modules/'.length)
    return !existsSync(join(modules, relative)) && !existsSync(join(VENDOR_MODULES, relative))
  })
}

function startStaticServer(misses, modules) {
  const roots = {vendor: resolve(modules), bundled: resolve(VENDOR_MODULES), upstream: resolve(UPSTREAM)}
  return new Promise((done) => {
    const server = createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        if (pathname === '/assets/fonts/fonts.css') {
          misses.push('/assets/fonts/fonts.css（使用 DrawAI 内置字体，部分上游字体或字重可能不同）')
          res.writeHead(200, {'Content-Type': 'text/css; charset=utf-8'})
          return res.end(fontFaces().map(face => '@font-face{font-family:' + JSON.stringify(face.family) + ';src:url(' + JSON.stringify('/__drawai-fonts/' + face.file) + ');font-weight:' + face.weight + ';font-style:' + face.style + ';font-display:block}').join('\n'))
        }
        if (pathname.startsWith('/__drawai-fonts/') && fontFaces().some(face => pathname === '/__drawai-fonts/' + face.file)) {
          const file = join(fontsDir() || '', pathname.split('/').at(-1))
          if (!existsSync(file)) { res.writeHead(404); return res.end('missing bundled font') }
          res.writeHead(200, {'Content-Type': 'font/ttf'})
          return res.end(readFileSync(file))
        }
        if (DEMO_FONT_ALIASES[pathname]) {
          const face = fontFaces().find(item => item.family === DEMO_FONT_ALIASES[pathname] && item.style === 'normal')
          if (face && existsSync(join(fontsDir() || '', face.file))) {
            if (face.weight.includes(' ')) misses.push(pathname + '（使用同字体族可变字体，字重或轴值可能不同）')
            res.writeHead(200, {'Content-Type': 'font/ttf'})
            return res.end(readFileSync(join(fontsDir() || '', face.file)))
          }
        }
        const vendor = pathname.startsWith('/node_modules/')
        // 两条挂载点：/node_modules/* → 视频运行时（缺则随包 vendored 的副本）；其余 → upstream。
        // 各自限制在自己目录内。
        const root = vendor ? roots.vendor : roots.upstream
        const relative = vendor ? pathname.slice('/node_modules'.length) : pathname
        let file = resolve(join(root, normalize(relative)))
        if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); return res.end('403') }
        if (vendor && !existsSync(file)) {
          const bundled = resolve(join(roots.bundled, normalize(relative)))
          if (bundled === roots.bundled || bundled.startsWith(roots.bundled + sep)) file = bundled
        }
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
        // Shared upstream textures are packaged separately from the text-only demo tree.
        if (!vendor && !existsSync(file) && pathname.startsWith('/assets/textures/')) {
          const tdir = texturesDir()
          const texture = tdir ? resolve(tdir, pathname.slice('/assets/textures/'.length)) : ''
          if (tdir && texture.startsWith(resolve(tdir) + sep) && existsSync(texture)) file = texture
        }
        // Demo 自带的数据文件（land-50m.json 之类）不在仓库里，走单独的小素材包。
        if (!vendor && !existsSync(file) && DEMO_DATA_PATTERN.test(pathname)) {
          const data = await demoDataFile(pathname)
          if (data) file = data
        }
        if (!existsSync(file)) {
          misses.push(pathname)
          // 模块缺失不能给占位：给个假的 three.module.js 只会让页面以更难懂的方式失败。
          if (vendor) { res.writeHead(404); return res.end('404 ' + pathname) }
          // 字体/纸纹/贴图没 vendor：CSS 给空表，图片给 1px 占位，其余 404（页面会走 fallback）
          if (/\.css$/i.test(pathname)) { res.writeHead(200, {'Content-Type': 'text/css'}); return res.end('/* placeholder */') }
          if (/\.(png|jpe?g|webp)$/i.test(pathname)) { res.writeHead(200, {'Content-Type': MIME[extname(file).toLowerCase()] || 'image/png'}); return res.end(PLACEHOLDER_PNG) }
          if (/\.(ttf|otf|woff2?)$/i.test(pathname) && SYSTEM_FONT) {
            res.writeHead(200, {'Content-Type': 'font/ttf'})
            return res.end(readFileSync(SYSTEM_FONT))
          }
          res.writeHead(404); return res.end('404 ' + pathname)
        }
        res.writeHead(200, {'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store'})
        res.end(readFileSync(file))
      } catch (error) {
        res.writeHead(500); res.end(String(error))
      }
    })
    server.listen(0, '127.0.0.1', () => done(server))
  })
}

function findChrome(browserExecutable) {
  return [browserExecutable, process.env.DRAWAI_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((path) => path && existsSync(path))
}

export async function captureStyleFrames({slug, times: explicitTimes, count = 8, browserExecutable, directory, signal} = {}) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('slug 无效：' + slug)
  const demo = join(UPSTREAM, 'demos', slug)
  if (!existsSync(join(demo, 'index.html'))) throw new Error('这个风格没有可截帧的上游 demo：' + slug + '（只有说明、没有 index.html）')
  const runtime = await ensureVideoRuntime({signal})
  const modules = join(runtime, 'node_modules')
  const { openBrowser } = await loadVideoModule('@remotion/renderer', {signal})
  const missing = missingModules(slug, modules)
  if (missing.length) {
    throw new Error('这个 demo 的依赖没装在本机（' + missing.join(', ') + '），页面加载不到模块，截不了帧。'
      + '这不是配置问题：three 由视频运行时提供，d3 / topojson-client / opentype.js / simplex-noise 随插件 vendored；'
      + '缺这几个说明打包不完整，请把这条错误原样反馈给插件作者。'
      + '临时退路只有 action:"source" 读 demos/' + slug + '/ 下的源码与 cues.json —— 那是有损降级，'
      + '只有文字与时间点，看不到转场怎么擦、冲击有没有环、相机抖不抖、颗粒多粗。')
  }

  const misses = []
  const server = await startStaticServer(misses, modules)
  const port = server.address().port
  const executable = findChrome(browserExecutable)
  signal?.throwIfAborted()
  const browser = await openBrowser('chrome', {browserExecutable: executable, logLevel: 'error'})
  try {
    const page = await browser.newPage({context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {}})
    await page.setViewport({width: 1920, height: 1080, deviceScaleFactor: 1})
    await page.goto({url: 'http://127.0.0.1:' + port + '/demos/' + slug + '/index.html', timeout: 60000})
    // 就绪等待 30 秒：实测最慢的能截的 demo 8.4 秒就绪；真出问题的页面不会在第 31 秒突然变好。
    // 超时要把"缺了哪些资源"一起报出来，并分清是缺 npm 包还是上游素材没 vendored——两者的处理办法不一样。
    try {
      await page.evaluate(() => new Promise((resolve, reject) => {
        const started = Date.now()
        const tick = () => {
          if (window.__ready === true) return resolve(true)
          if (Date.now() - started > 30000) return reject(new Error('__timeout__'))
          setTimeout(tick, 100)
        }
        tick()
      }))
    } catch {
      const lost = [...new Set(misses)]
      const modules = lost.filter((path) => path.startsWith('/node_modules/')).slice(0, 4)
      const assets = lost.filter((path) => !path.startsWith('/node_modules/') && !/favicon|fonts\.css/.test(path)).slice(0, 4)
      throw new Error('上游 demo 没有就绪（30 秒）'
        + (modules.length ? '；缺 npm 包：' + modules.join(', ') : '')
        + (assets.length ? '；缺上游素材：' + assets.join(', ') + '（这些没有 vendored，不是配置问题）' : '')
        + (modules.length || assets.length ? '' : '；模块可能抛错')
        + '。只能退到 action:"source" 读源码与 cues.json，但那是有损降级（看得到参数，看不到真实动态）。')
    }
    const meta = await page.evaluate(() => ({
      width: window.DEMO?.width || 1920,
      height: window.DEMO?.height || 1080,
      fps: window.DEMO?.fps || 30,
      duration: window.DEMO?.duration || 10,
      hasRenderAt: typeof window.renderAt === 'function',
    }))
    if (!meta.hasRenderAt) throw new Error('这个 demo 没有 window.renderAt(t)，无法按时间取帧；改用 action:"source" 读源码')
    const width = Math.max(320, Math.min(2560, Math.round(meta.width)))
    const height = Math.max(240, Math.min(1440, Math.round(meta.height)))
    const fps = Math.max(1, Math.round(meta.fps || 30))
    await page.setViewport({width, height, deviceScaleFactor: 1})
    const times = pickTimes(slug, count, explicitTimes, Number(meta.duration) || 10)
    if (!times.length) throw new Error('没有可用的时间点（cues.json 里的时间都超出片长）')

    const dir = directory || join(tmpdir(), 'dsh-drawai', 'style-frames', slug)
    mkdirSync(dir, {recursive: true})
    const files = []
    for (const [index, t] of times.entries()) {
      signal?.throwIfAborted()
      await page.evaluate(async (time, fpsValue) => {
        await window.renderAt?.(time)
        // 两帧 rAF：让画面里基于 frame 的绘制与 CSS/WAAPI 都落到同一时刻
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))))
        void fpsValue
      }, t, fps)
      const result = await page._client().send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
        clip: {x: 0, y: 0, width, height, scale: 1},
      })
      const data = Buffer.from((result.value || result).data, 'base64')
      if (data.length > 12 * 1024 * 1024) throw new Error('参考帧体积过大：' + t + 's')
      const file = join(dir, 'frame-' + String(index).padStart(2, '0') + '-' + t.toFixed(2) + 's.png')
      writeFileSync(file, data)
      files.push({time: t, frame: Math.round(t * fps), path: file, bytes: data.length})
    }
    const notes = []
    if (misses.length) notes.push('缺上游资源（已用占位兜底，画面里的字体/纸纹可能与原片不同）：' + [...new Set(misses)].slice(0, 8).join(', '))
    notes.push('这些是参考帧：写场景前逐张看，按 STYLE.md 的效果配方逐项对照（转场/冲击/相机/颗粒/二次运动），别只对"形"。')
    return {slug, width, height, fps, duration: meta.duration, times, directory: dir, files, notes}
  } finally {
    await browser.close({silent: true}).catch(() => {})
    await new Promise((done) => server.close(done))
  }
}
