/* Local, pre-collected style references. No network, browser, or upstream demo. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const SLUG = /^[a-z0-9][a-z0-9-]*$/
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$/i
const styles = JSON.parse(readFileSync(new URL('./mgstyles/catalog.json', import.meta.url), 'utf8')).styles
const styleNames = new Map(styles.map((style) => [style.slug, style.name]))

function unavailable(message) {
  const error = new Error(message)
  error.code = 'STYLE_REFERENCE_UNAVAILABLE'
  return error
}

function within(root, target) {
  const part = relative(root, target)
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}

/** Find the newest named collection which has its own index. No implicit download. */
export function findStyleReferenceCollection(parent) {
  if (!existsSync(parent)) return null
  if (!statSync(parent).isDirectory()) throw new Error('风格参考帧集合路径不是目录：' + parent)
  const names = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^collection-[a-z0-9][a-z0-9_-]*$/i.test(entry.name))
    .map((entry) => entry.name).sort().reverse()
  for (const name of names) {
    const collection = join(parent, name)
    const index = join(collection, 'index.json')
    if (existsSync(index) && statSync(index).isFile()) return collection
  }
  return null
}

/**
 * 集合所在的父目录。默认 `~/.dsh/drawai-style-reference-frames`；DRAWAI_STYLE_FRAMES_DIR
 * 可以在不碰用户目录的情况下换一个（测试、镜像、自定义安装）。
 * 注意区分：DRAWAI_STYLE_REFERENCE_DIR 指的是**集合本身**，优先级更高。
 */
export function styleReferenceParent() {
  // 环境变量给相对路径时也归一成绝对路径：安装和读帧报出来的目录要能直接复制粘贴。
  return resolve(process.env.DRAWAI_STYLE_FRAMES_DIR || join(homedir(), '.dsh', 'drawai-style-reference-frames'))
}

/** An explicit override names the collection itself, not its parent. */
export function styleReferenceRoot() {
  const configured = process.env.DRAWAI_STYLE_REFERENCE_DIR
  const parent = styleReferenceParent()
  const found = configured ? resolve(configured) : findStyleReferenceCollection(parent)
  if (!found || !existsSync(found)) throw unavailable('未找到本地风格参考帧集合：' + (found || parent) + '。请先准备带 index.json 的 collection-* 目录，或设置 DRAWAI_STYLE_REFERENCE_DIR 指向参考帧目录；也可以用 mg_style {action:"install"} 下载官方参考帧素材包（约 40MB）。这个模块只读本地文件，不会运行上游演示。')
  const root = resolve(found)
  if (!statSync(root).isDirectory()) throw new Error('风格参考帧路径不是目录：' + root)
  return realpathSync(root)
}

function safeExistingFile(root, path, label) {
  // Resolve symlinks before checking containment; only a real regular file is accepted.
  let actual
  try { actual = realpathSync(path) } catch { throw new Error('风格参考帧缺少' + label + '：' + path) }
  if (!within(root, actual)) throw new Error('风格参考帧' + label + '超出素材目录：' + path)
  if (!statSync(actual).isFile()) throw new Error('风格参考帧' + label + '不是文件：' + path)
  return actual
}

function finite(value, fallback = null) {
  const number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : NaN)
  return Number.isFinite(number) ? number : fallback
}

function frameRate(value) {
  if (typeof value === 'string' && /^\d+\/\d+$/.test(value)) {
    const [a, b] = value.split('/').map(Number)
    return b > 0 && a > 0 ? a / b : null
  }
  const fps = finite(value)
  return fps > 0 ? fps : null
}

function readStyle(root, slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error('风格 slug 无效：' + String(slug))
  const dir = join(root, slug)
  if (!existsSync(dir)) throw unavailable('本地参考帧未收录风格：' + slug + '；请检查素材目录或设置 DRAWAI_STYLE_REFERENCE_DIR。')
  // Do not let a slug directory point outside the selected collection.
  const resolvedDir = realpathSync(dir)
  if (!within(root, resolvedDir) || !statSync(resolvedDir).isDirectory()) throw new Error('风格参考帧目录无效或超出素材目录：' + slug)
  const file = safeExistingFile(root, join(resolvedDir, 'manifest.json'), '清单')
  let manifest
  try { manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
    throw new Error('风格参考帧清单无法解析：' + slug + '（' + error.message + '）')
  }
  if (!manifest || manifest.slug !== slug || !Array.isArray(manifest.frames) || !manifest.frames.length) {
    throw new Error('风格参考帧清单无效或与风格不匹配：' + slug)
  }
  const source = manifest.source_url || manifest.source_video_url || manifest.sourceUrl || manifest.source_repository || ''
  const recordedLicense = manifest.source_license || manifest.upstream_project_license || manifest.license || '未记录许可'
  const license = /Vincentwei1021\/mg-styles-15/i.test(source)
    ? recordedLicense + '；上游作品许可，画面中的第三方内容、字体等可能另有许可。'
    : recordedLicense
  const fps = frameRate(manifest.source_video_frame_rate ?? manifest.video_fps ?? manifest.sourceFps)
  const width = finite(manifest.source_video_width ?? manifest.width ?? manifest.sourceWidth)
  const height = finite(manifest.source_video_height ?? manifest.height ?? manifest.sourceHeight)
  const duration = finite(manifest.source_video_duration_seconds ?? manifest.sourceDurationSeconds)
  const isCompilation = !!manifest.sourceRelease && !!manifest.sourceTitle
  const styleName = styleNames.get(slug) || slug
  const seen = new Set()
  return manifest.frames.map((frame, index) => {
    const name = frame?.file
    if (typeof name !== 'string' || basename(name) !== name || !IMAGE.test(name)) throw new Error('风格参考帧文件名无效：' + slug + '/' + String(name))
    if (seen.has(name)) throw new Error('风格参考帧清单存在重复文件：' + slug + '/' + name)
    seen.add(name)
    const expected = frame.sha256
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('风格参考帧缺少有效 SHA-256：' + slug + '/' + name)
    const path = safeExistingFile(root, join(resolvedDir, name), '图片')
    // A symlink to a different style under the root is also not a member of this style.
    if (!within(resolvedDir, path)) throw new Error('风格参考帧不在该风格目录内：' + slug + '/' + name)
    const bytes = readFileSync(path)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected.toLowerCase()) throw new Error('风格参考帧 SHA-256 不匹配：' + slug + '/' + name)
    const time = finite(frame.time_seconds ?? frame.seconds ?? frame.timeSeconds)
    const frameIndex = finite(frame.frame_index ?? frame.sourceFrame)
    if (time === null || time < 0) throw new Error('风格参考帧缺少有效来源时间：' + slug + '/' + name)
    return {
      id: 'style-reference/' + slug + '/' + name,
      slug, styleName, name: styleName + ' · 参考帧 ' + (index + 1), category: 'style-reference', categoryName: '风格参考帧', kind: 'image',
      path, bytes: bytes.length, sha256: actual, source, license,
      time, frame: frameIndex, width: finite(frame.width, width), height: finite(frame.height, height), fps,
      sourceDuration: duration, timeBasis: isCompilation ? 'source-compilation' : 'source-video',
      ...(isCompilation ? { timeNote: '时间点位于来源合集视频，不是独立风格片段的相对时间。' } : {}),
    }
  })
}

/** List and integrity-check existing frames. Unknown/missing data is an explicit error. */
export function listStyleReferenceFrames({ slug } = {}) {
  const root = styleReferenceRoot()
  if (slug !== undefined && slug !== null && slug !== '') return readStyle(root, slug)
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => SLUG.test(entry.name) && /^\d{2}-/.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name).sort()
  return dirs.flatMap((name) => readStyle(root, name))
}
