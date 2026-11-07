// 素材收集：打开页面，把「这张片子里可能要用到的素材」自动扫出来并落地。
//
// 为什么不是"让模型自己想需要什么图"：真实项目里素材散在页面各处——favicon、og:image、
// 产品截图、主视觉、品牌色、字体名。逐个猜 URL 又慢又容易 404，截整页又拿不到原图。
// 这里做的是：一次无头浏览器访问，DOM 里把候选全找出来（带尺寸和位置），
// 然后把值得要的原图按优先级下载进 assets/，最后补一张 2 倍视口截图当"界面底图"。
//
// 两种粒度：
//   collect —— 一个页面，收干净（默认 8 张）。
//   gather  —— 一个站点：首页 + 导航里挑出的几个内页，加上品牌 logo 服务（Simple Icons /
//              Clearbit / 高清 favicon），把配色与字体在多个页面间做聚合，一次凑齐一套素材。
//
// 抓下来的每一条都带 source URL，交付时能说清"这张图哪来的"。

import { openBrowser } from '@remotion/renderer'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assetsDirectory, fetchAsset, readAssets, writeAssets } from './assets.js'
import { browserExecutable, capturePage } from './capture.js'

const PAGE_LIMIT = 6
const NAV_PRIORITY = ['/docs', '/documentation', '/product', '/features', '/platform', '/solutions', '/pricing', '/about', '/developers', '/enterprise']

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.max(min, Math.min(max, Math.round(number)))
}

function pickName(src, fallback) {
  try {
    const path = new URL(src).pathname
    const base = path.split('/').filter(Boolean).pop() || fallback
    return base.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || fallback
  } catch {
    return fallback
  }
}

function slugify(value, fallback) {
  return String(value || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || fallback
}

function toHttpUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error('需要一个 http(s) 网址：' + raw)
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只接受 http(s) 网址：' + raw)
  return url
}

// 内联 <svg> 是品牌字标最常见的形态（GitHub 的 octocat 就是这个），页面上没有可下载的
// URL，只能把 DOM 里的标记原样存下来。带 viewBox 的才要：写死 width/height 的挪走就崩。
function saveInlineSvg(projectDir, markup, meta) {
  if (!/viewBox\s*=/i.test(markup)) return null
  const dir = assetsDirectory(projectDir)
  mkdirSync(dir, { recursive: true })
  const base = slugify(meta.name, 'inline-logo')
  const taken = new Set(readAssets(projectDir).items.map((item) => item.file))
  let file = base + '.svg'
  let index = 1
  while (taken.has(file)) file = base + '-' + (++index) + '.svg'
  writeFileSync(join(dir, file), markup)
  const manifest = readAssets(projectDir)
  const entry = {
    id: file.replace(/\.svg$/i, ''), file, bytes: Buffer.byteLength(markup),
    sha256: createHash('sha256').update(markup).digest('hex'),
    kind: 'vector', width: meta.width, height: meta.height, source: meta.source,
    ...(meta.caption ? { caption: String(meta.caption).slice(0, 400) } : {}),
    at: new Date().toISOString(),
  }
  manifest.items.push(entry)
  writeAssets(projectDir, manifest)
  return entry
}

// 在页面里跑：一次把图标、社交图、大图、内联 svg、配色、字体、导航链接全扫出来。
// 注意它是被序列化后丢进浏览器的函数，只能用页面里存在的全局对象。
function scanDocument({ minWidth }) {
  const abs = (value) => {
    try { return new URL(value, location.href).href } catch { return null }
  }
  const isHttp = (value) => typeof value === 'string' && /^https?:/i.test(value)
  const icons = [...document.querySelectorAll('link[rel]')]
    .filter((link) => /icon/i.test(link.rel))
    .map((link) => abs(link.getAttribute('href')))
    .filter(isHttp)
  const metas = [...document.querySelectorAll('meta[property],meta[name]')]
    .map((meta) => ({ key: String(meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase(), value: meta.getAttribute('content') }))
    .filter((meta) => /^(og:image|twitter:image|og:logo|msapplication-tileimage)/.test(meta.key))
    .map((meta) => abs(meta.value))
    .filter(isHttp)
  const images = [...document.images]
    .map((img) => {
      const box = img.getBoundingClientRect()
      return { src: abs(img.currentSrc || img.src), w: Math.round(img.naturalWidth || box.width), h: Math.round(img.naturalHeight || box.height), top: Math.round(box.top + window.scrollY), left: Math.round(box.left + window.scrollX), alt: String(img.alt || '').slice(0, 80) }
    })
    .filter((img) => isHttp(img.src) && img.w >= minWidth && img.h >= 120 && img.top < 6000)
    .sort((a, b) => (b.w * b.h) - (a.w * a.h))
    .slice(0, 24)
  const inlineSvgs = [...document.querySelectorAll('svg')]
    .map((svg) => {
      const box = svg.getBoundingClientRect()
      const link = svg.closest('a,header')
      const title = svg.querySelector('title')
      return {
        w: Math.round(box.width), h: Math.round(box.height),
        top: Math.round(box.top + window.scrollY),
        label: String(svg.getAttribute('aria-label') || (title ? title.textContent : '') || (link && link.getAttribute('aria-label')) || '').slice(0, 40),
        markup: svg.outerHTML.length < 24000 ? svg.outerHTML : '',
      }
    })
    .filter((svg) => svg.markup && /viewBox/i.test(svg.markup) && svg.w >= 28 && svg.h >= 20 && svg.top < 700)
    .sort((a, b) => (b.w * b.h) - (a.w * a.h))
  // 小尺寸的是字标/图标（真正要复用的），大尺寸的多是首屏装饰插画：分开排，
  // 否则一张 1440×840 的背景图会把 logo 挤到 limit 之外。
  const marks = inlineSvgs.filter((svg) => svg.w <= 420 && svg.h <= 420).slice(0, 3)
  const artwork = inlineSvgs.filter((svg) => svg.w > 420 || svg.h > 420).slice(0, 1)
  const backgrounds = [...document.querySelectorAll('body,header,main,section,div,button,a')]
    .slice(0, 400)
    .map((el) => {
      const style = getComputedStyle(el)
      return { bg: style.backgroundColor, fg: style.color }
    })
    .flatMap((item) => [item.bg, item.fg])
    .filter((value) => value && !/rgba\(0, 0, 0, 0\)|transparent/i.test(value))
  const toHex = (value) => {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || '')
    if (!match) return null
    return '#' + [1, 2, 3].map((i) => Number(match[i]).toString(16).padStart(2, '0')).join('')
  }
  const counts = new Map()
  for (const color of backgrounds) {
    const hex = toHex(color)
    if (!hex) continue
    counts.set(hex, (counts.get(hex) || 0) + 1)
  }
  const colors = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hex, count]) => ({ hex, count }))
  const links = [...document.querySelectorAll('header a[href], nav a[href]')]
    .map((anchor) => abs(anchor.getAttribute('href')))
    .filter(isHttp)
  return {
    title: document.title,
    href: location.href,
    pageHeight: Math.round(Math.max(document.documentElement.scrollHeight, innerHeight)),
    icons: [...new Set(icons)].slice(0, 4),
    social: [...new Set(metas)].slice(0, 4),
    images,
    svgs: marks,
    artwork,
    links: [...new Set(links)].slice(0, 40),
    colors,
    fonts: {
      body: getComputedStyle(document.body).fontFamily.slice(0, 160),
      heading: (document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).fontFamily : '').slice(0, 160),
    },
    inlineSvg: document.querySelectorAll('svg').length,
  }
}

async function scanPage(browser, href, { width, minWidth, pageIndex }) {
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex, onBrowserLog: null, onLog: () => {} })
  try {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 })
    await page.goto({ url: href, timeout: 30000 })
    await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 4000))])
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    return await page.evaluate(scanDocument, { minWidth })
  } finally {
    await page.close().catch(() => {})
  }
}

// 优先级：品牌 logo 服务 → 内联字标 → 图标 → og/社交图 → 大图（首屏优先）。
function buildQueue(scans, logos) {
  const queue = []
  const seen = new Set()
  const push = (src, why, meta) => {
    if (!src || seen.has(src) || !/^https?:/i.test(src)) return
    seen.add(src)
    queue.push({ src, why, ...meta })
  }
  for (const logo of logos) push(logo.src, logo.why, { page: 'brand' })
  const iconRank = (src) => {
    if (/fluidicon|apple-touch|icon-192|icon-512|logo/i.test(src)) return 0
    if (/favicon/i.test(src)) return 2
    return 1
  }
  for (const entry of scans) {
    for (const src of [...entry.scan.icons].sort((a, b) => iconRank(a) - iconRank(b))) push(src, 'icon', { page: entry.scan.href })
    for (const src of entry.scan.social) push(src, 'social', { page: entry.scan.href })
    for (const image of entry.scan.images) {
      push(image.src, image.top < 1200 ? 'hero' : 'body', { page: entry.scan.href, width: image.w, height: image.h, alt: image.alt })
    }
  }
  return queue
}

function mergeColors(scans) {
  const counts = new Map()
  for (const entry of scans) {
    for (const color of entry.scan.colors || []) counts.set(color.hex, (counts.get(color.hex) || 0) + color.count)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hex, count]) => ({ hex, count }))
}

function mergeFonts(scans) {
  const families = []
  for (const entry of scans) {
    for (const value of [entry.scan.fonts.body, entry.scan.fonts.heading]) {
      const first = String(value || '').split(',')[0].replace(/["']/g, '').trim()
      if (first && !families.includes(first)) families.push(first)
    }
  }
  return families.slice(0, 4)
}

// 品牌 logo 三条兜底：Simple Icons（单色矢量，最干净）、Clearbit（彩色 512px）、
// Google favicon 服务（128px，兜底）。目标站自己有官方图时它们会被排在前面优先用。
function brandLogoSources(brand) {
  const raw = String(brand || '').trim().toLowerCase()
  if (!raw) return []
  const domain = raw.includes('.') ? raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null
  const slug = raw.replace(/\.(com|io|org|net|dev|ai|co)$/i, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[^a-z0-9]+/g, '')
  const sources = []
  if (slug) sources.push({ src: 'https://cdn.simpleicons.org/' + slug, why: 'brand-svg', brand: slug })
  if (domain) {
    sources.push({ src: 'https://logo.clearbit.com/' + domain, why: 'brand-logo', brand: domain })
    sources.push({ src: 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=128', why: 'favicon-128', brand: domain })
  }
  return sources
}

// 字体能不能直接拿到：探一下 Google Fonts 有没有同名家族（有就能 fetch 到 ttf/woff2）。
async function probeFonts(families) {
  const results = []
  for (const family of families.slice(0, 4)) {
    const cssUrl = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family).replace(/%20/g, '+') + '&display=swap'
    try {
      const response = await fetch(cssUrl, { signal: AbortSignal.timeout(6000) })
      results.push({ family, googleFonts: response.ok, cssUrl })
    } catch {
      results.push({ family, googleFonts: null, cssUrl })
    }
  }
  return results
}

async function downloadAll(projectDir, marks, queue, limit, pageLabel) {
  const downloaded = []
  const skipped = []
  const seenFiles = new Set()
  const seenMarks = new Set()
  const note = (entry, why, source) => {
    if (seenFiles.has(entry.file)) return
    seenFiles.add(entry.file)
    // 32px 的 favicon 放进 1080p 画面只会糊：标出来，别当主视觉用。
    const tiny = entry.kind === 'image' && entry.width && entry.height && entry.width < 96 && entry.height < 96
    downloaded.push({ file: entry.file, kind: entry.kind, width: entry.width, height: entry.height, why, source, ...(tiny ? { tiny: true } : {}) })
  }
  for (const mark of marks) {
    // 同一个字标在每页头部都会出现一次：按标记内容去重，别存成 brand.svg / docs.svg 两份。
    const hash = createHash('sha256').update(mark.markup).digest('hex')
    if (seenMarks.has(hash)) continue
    seenMarks.add(hash)
    try {
      const entry = saveInlineSvg(projectDir, mark.markup, {
        name: pickName(mark.page, 'brand') + '-' + (mark.label || 'mark'),
        width: mark.w, height: mark.h, source: mark.page + ' (inline svg)',
        caption: (mark.label ? mark.label + ' · ' : '') + 'inline-svg @ ' + mark.page,
      })
      if (entry) note(entry, mark.why || 'inline-svg', entry.source)
    } catch (error) {
      skipped.push({ src: mark.page + '#inline-svg', why: 'inline-svg', reason: String(error && error.message ? error.message : error).slice(0, 160) })
    }
  }
  for (const item of queue) {
    if (downloaded.length >= limit) break
    try {
      const entry = await fetchAsset(projectDir, item.src, { name: pickName(item.src, item.why), caption: (item.alt ? item.alt + ' · ' : '') + item.why + ' @ ' + item.page })
      note(entry, item.why, item.src)
    } catch (error) {
      skipped.push({ src: item.src, why: item.why, reason: String(error && error.message ? error.message : error).slice(0, 160) })
    }
  }
  return { downloaded, skipped }
}

export async function collectPageAssets(projectDir, rawUrl, options = {}) {
  const url = toHttpUrl(rawUrl)
  const width = clamp(options.width || 1440, 320, 2560)
  const limit = clamp(options.limit || 8, 1, 20)
  const minWidth = clamp(options.minWidth || 240, 40, 2000)

  mkdirSync(join(projectDir, '.out'), { recursive: true })
  const browser = await openBrowser('chrome', { browserExecutable: browserExecutable(), logLevel: 'error' })
  let scan
  try {
    scan = await scanPage(browser, url.href, { width, minWidth, pageIndex: 0 })
  } finally {
    await browser.close({ silent: true }).catch(() => {})
  }

  const queue = buildQueue([{ scan }], [])
  const marks = [
    ...(scan.svgs || []).map((mark) => ({ ...mark, why: 'inline-svg', page: scan.href })),
    ...(scan.artwork || []).map((mark) => ({ ...mark, why: 'artwork', page: scan.href })),
  ]

  if (options.dryRun) {
    return {
      dryRun: true, title: scan.title, url: scan.href, pageHeight: scan.pageHeight,
      colors: scan.colors, fonts: scan.fonts, inlineSvg: scan.inlineSvg,
      inlineMarks: marks.map(({ w, h, label, top }) => ({ width: w, height: h, label, top })),
      candidates: queue.map(({ src, why, width: w, height: h, alt }) => ({ src, why, width: w, height: h, alt })),
      next: '这是扫描结果（没有下载）。挑需要的再 collect（去掉 dryRun），或直接 fetch 某一条 src。带 inlineMarks 的会随正式收集一起存成 .svg。要整个站点就换 gather。',
    }
  }

  const { downloaded, skipped } = await downloadAll(projectDir, marks, queue.slice(0, limit), limit, scan.href)

  // 截图单独走 capturePage：它用 Chrome 的 --screenshot，2 倍图、稳定；
  // 上面的浏览器会话只负责扫 DOM，两条路各做各的事，互不影响。
  let shot = null
  try {
    shot = await capturePage(projectDir, { url: scan.href, width, height: 900, scale: 2, name: pickName(scan.href, 'page') + '-viewport', caption: 'collect 视口截图 @ ' + scan.href })
  } catch (error) {
    skipped.push({ src: scan.href, why: 'screenshot', reason: String(error && error.message ? error.message : error).slice(0, 160) })
  }

  return {
    title: scan.title, url: scan.href, pageHeight: scan.pageHeight,
    colors: scan.colors, fonts: scan.fonts, inlineSvg: scan.inlineSvg,
    downloaded, skipped, screenshot: shot ? { file: shot.file, width: shot.width, height: shot.height } : null,
    candidates: queue.length,
    next: '下载到的用 staticFile("文件名") 引用；颜色/字体是页面实测值，配色与排版对齐它们最像。缺哪一类（比如产品另一屏的界面）就对这个页面再来一次 collect（换 width，或直接 page 截指定区域）；要整站的素材用 gather。',
  }
}

// gather：一个站点一次凑齐。首页导航里挑几个内页一起扫，配色与字体跨页聚合，
// 再补上品牌 logo 服务；重复内容按 SHA-256 去重（fetchAsset 自己会去）。
export async function gatherAssets(projectDir, options = {}) {
  const rawUrls = [...(Array.isArray(options.urls) ? options.urls : []), options.url].filter(Boolean)
  if (!rawUrls.length && !options.brand) throw new Error('gather 需要 url / urls，或者只给一个 brand（用它去品牌 logo 服务取）')
  const width = clamp(options.width || 1440, 320, 2560)
  const limit = clamp(options.limit || 12, 1, 24)
  const minWidth = clamp(options.minWidth || 240, 40, 2000)
  const pageBudget = clamp(options.pages || 4, 1, PAGE_LIMIT)
  const logos = brandLogoSources(options.brand)

  const targets = []
  for (const raw of rawUrls) {
    const url = toHttpUrl(raw)
    if (!targets.includes(url.href)) targets.push(url.href)
  }

  mkdirSync(join(projectDir, '.out'), { recursive: true })
  const scans = []
  const failedPages = []
  const browser = await openBrowser('chrome', { browserExecutable: browserExecutable(), logLevel: 'error' })
  try {
    let index = 0
    while (index < targets.length && index < pageBudget) {
      const href = targets[index++]
      try {
        const scan = await scanPage(browser, href, { width, minWidth, pageIndex: index - 1 })
        scans.push({ scan })
        // 首页扫完，把导航里的内页排进来（同源、去重、按常见的产品页优先级）。
        if (index === 1) {
          const origin = new URL(href).origin
          const candidates = scan.links
            .filter((link) => link.startsWith(origin) && !/[?#]/.test(link) && !/\.(png|jpe?g|svg|webp|pdf|zip|mp4)$/i.test(link))
            .map((link) => link.replace(/\/$/, ''))
            .filter((link) => link !== href.replace(/\/$/, ''))
          const ranked = [
            ...candidates.filter((link) => NAV_PRIORITY.some((key) => new URL(link).pathname.toLowerCase().startsWith(key))),
            ...candidates,
          ]
          for (const link of ranked) {
            if (targets.includes(link) || targets.length >= pageBudget) continue
            targets.push(link)
          }
        }
      } catch (error) {
        failedPages.push({ url: href, reason: String(error && error.message ? error.message : error).slice(0, 160) })
      }
    }
  } finally {
    await browser.close({ silent: true }).catch(() => {})
  }
  if (!scans.length) throw new Error('gather 一页都没打开成功：' + failedPages.map((item) => item.url + ' (' + item.reason + ')').join('；'))

  const queue = buildQueue(scans, logos)
  const marks = []
  for (const entry of scans) {
    for (const mark of entry.scan.svgs || []) marks.push({ ...mark, why: 'inline-svg', page: entry.scan.href })
    for (const mark of entry.scan.artwork || []) marks.push({ ...mark, why: 'artwork', page: entry.scan.href })
  }
  const colors = mergeColors(scans)
  const families = mergeFonts(scans)

  if (options.dryRun) {
    return {
      dryRun: true, pages: scans.map((entry) => entry.scan.href), failedPages,
      colors, fonts: families, inlineMarks: marks.map(({ w, h, label, page }) => ({ width: w, height: h, label, page })),
      candidates: queue.map(({ src, why, width: w, height: h, alt, page }) => ({ src, why, width: w, height: h, alt, page })),
      next: '这是扫描结果（没有下载）。确认清单够用就去掉 dryRun 正式收；缺某类素材就补 urls（另一个页面），或对某个页面单独 collect。',
    }
  }

  const { downloaded, skipped } = await downloadAll(projectDir, marks, queue.slice(0, limit), limit, scans[0].scan.href)
  const fontSources = await probeFonts(families)

  // 每个页面一张视口截图，最多两张：首页那张最常用，产品页那张用来做"界面在屏幕上"。
  const screenshots = []
  for (const entry of scans.slice(0, 2)) {
    try {
      const shot = await capturePage(projectDir, { url: entry.scan.href, width, height: 900, scale: 2, name: pickName(entry.scan.href, 'page') + '-viewport', caption: 'gather 视口截图 @ ' + entry.scan.href })
      screenshots.push({ file: shot.file, width: shot.width, height: shot.height, page: entry.scan.href })
    } catch (error) {
      skipped.push({ src: entry.scan.href, why: 'screenshot', reason: String(error && error.message ? error.message : error).slice(0, 160) })
    }
  }

  return {
    pages: scans.map((entry) => entry.scan.href),
    failedPages,
    colors,
    fonts: families,
    fontSources,
    downloaded,
    skipped,
    screenshots,
    candidates: queue.length,
    next: '素材都在 assets/manifest.json 里（带 source URL）。配色用 colors（多页聚合的实测值）对进 theme.ts；字体看 fontSources 里 googleFonts 为 true 的，可以 fetch 它的 cssUrl 拿真字体，其余退回系统字并在 BRIEF 写"字体非官方"。',
  }
}
