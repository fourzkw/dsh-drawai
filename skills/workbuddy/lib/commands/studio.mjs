// 工程命令：建工程、看工程、定主题、出预览、渲片、帧检、导出。
// 这里只做「参数 → 引擎调用」的翻译，判断逻辑一律留在 engine/ 里（和插件共用同一份）。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { asArray, bool, emit, formatSeconds, line, num, projectDir, requireProjectDir, resolveInput, table } from '../cli.mjs'
import { parseSpec, projectSummary, readablePalette, readStoryboard, resolveCards, resolveSpec, resolveStyle } from '../project.mjs'
import { HOW_TO_INSTALL, locateFfmpeg, requireFfmpeg } from '../ffmpeg.mjs'

const WB_BIN = fileURLToPath(new URL('../../bin/wb.mjs', import.meta.url))
// 命令行里的列表统一写逗号：--frames 40,220 / --range 0,90 / --crop 100,200,400,300
const numbers = (value) => asArray(value).flatMap((item) => String(item).split(',')).map(Number).filter(Number.isFinite)
const STORYBOARD_HEADER = '| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音 |\n| --- | --- | --- | --- | --- | --- |'

const outDir = (dir) => join(dir, '.out')
const jobsDir = (dir) => join(outDir(dir), 'jobs')

// 工程里的 index.jsx 记的是引 entry.jsx 的**绝对路径**。技能目录被挪过、或工程从别的机器
// 拷来时那条路径就失效了；preview / render 前按当前位置重写一次（引擎里叫 refreshEntry）。
async function refreshEntry(dir) {
  const { registerProject } = await import('../../engine/motion/project.js')
  try {
    registerProject(dir)
  } catch (error) {
    throw new Error('工程入口刷新失败（' + dir + '）：' + error.message)
  }
}

function jobFile(dir, id) { return join(jobsDir(dir), id + '.json') }
function writeJob(dir, job) {
  mkdirSync(jobsDir(dir), { recursive: true })
  writeFileSync(jobFile(dir, job.id), JSON.stringify(job, null, 2) + '\n', 'utf8')
}
function readJob(dir, id) {
  const file = jobFile(dir, id)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
function listJobs(dir) {
  if (!existsSync(jobsDir(dir))) return []
  return readdirSync(jobsDir(dir)).filter((name) => name.endsWith('.json'))
    .map((name) => { try { return JSON.parse(readFileSync(join(jobsDir(dir), name), 'utf8')) } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
}

const newJobId = () => 'job-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6)

// 素材缓存有时只留 manifest 不记体量（files/bytes 为 null），这儿实测一遍，别让 doctor 显示 "? 文件"。
function measureAssets(root) {
  let files = 0
  let bytes = 0
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) { files += 1; try { bytes += statSync(full).size } catch { /* 读不到的跳过 */ } }
    }
  }
  walk(root, 0)
  return { files, bytes }
}

// ── setup / doctor ──────────────────────────────────────────────────
async function inspect() {
  const { assetsState, assetsSummary } = await import('../../engine/motion/asset-pack.js')
  const { videoRuntimeState } = await import('../../engine/motion/video-runtime.js')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  let babel = null
  try { babel = require.resolve('@babel/parser') } catch { babel = null }
  let npm = null
  try { npm = require.resolve('npm/package.json') } catch { npm = null }
  const assets = assetsState()
  const runtime = videoRuntimeState()
  const found = locateFfmpeg()
  const ffmpeg = found && found.version ? found : { missing: found ? '路径不可用：' + found.path : '没找到 ffmpeg' }
  const summary = assetsSummary()
  const root = assets.root || assets.dir
  if (assets.ready && root && (summary.files == null || summary.bytes == null)) Object.assign(summary, measureAssets(root))
  return {
    node: process.version,
    platform: process.platform + '-' + process.arch,
    babel,
    npm,
    assets: { ready: assets.ready, source: assets.source, dir: assets.dir, root, summary },
    runtime: { ready: runtime.ready, dir: runtime.directory },
    ffmpeg,
  }
}

export async function setup(flags) {
  const install = bool(flags.install) || bool(flags.download)
  const report = await inspect()
  const steps = []
  if (!report.babel) {
    steps.push('缺少 @babel/parser：在技能目录运行 `npm install --omit=dev`（只需两个小包，约 2MB）')
    if (install) {
      const { execFileSync } = await import('node:child_process')
      const skillRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
      try { execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: skillRoot, stdio: 'inherit' }) } catch (error) { steps.push('npm install 失败：' + error.message) }
    }
  }
  if (!report.assets.ready) {
    steps.push('内置素材（字体 / 素材库 / 材质）还没准备好：`wb setup --download` 下载一次（约 150MB）')
    if (install) {
      const { ensureAssets } = await import('../../engine/motion/asset-pack.js')
      await ensureAssets({ onProgress: (event) => line('  下载素材 ' + Math.round((event.progress || 0) * 100) + '% · ' + (event.phase || '')) })
    }
  }
  if (!report.runtime.ready) {
    steps.push('视频运行时（remotion / react / three）没装好：第一次渲染会自动装（约 100MB），也可以现在 `wb setup --download`')
    if (install) {
      const { ensureVideoRuntime } = await import('../../engine/motion/video-runtime.js')
      await ensureVideoRuntime({ onProgress: (event) => line('  安装运行时 ' + Math.round((event.progress || 0) * 100) + '% · ' + (event.message || event.phase || '')) })
    }
  }
  if (report.ffmpeg?.missing) {
    steps.push('没有可用的 FFmpeg（预览拼图 / 帧检 / 导出要用）：\n' + HOW_TO_INSTALL)
    if (install) {
      // 只有显式 --install 才允许引擎去下载；这台机器没网时它会一直等，所以写清在干什么。
      line('  下载 FFmpeg（约 100MB；没网会一直等，Ctrl+C 中止）…')
      try {
        const { ensureFfmpeg } = await import('../../engine/ffmpeg-manager.js')
        line('  FFmpeg 就绪：' + (await ensureFfmpeg({})))
      } catch (error) {
        steps.push('FFmpeg 准备失败：' + error.message)
      }
    }
  }
  const after = await inspect()
  const ready = !!(after.babel && after.assets.ready && after.runtime.ready && !after.ffmpeg?.missing)
  if (flags.json) return emit('', { ready, steps, ...after })
  line('运行环境 ' + after.node + ' · ' + after.platform)
  line('  babel    ' + (after.babel ? '✓ ' + after.babel : '✗ 缺 @babel/parser'))
  line('  素材     ' + (after.assets.ready
    ? '✓ ' + after.assets.source + ' · ' + (after.assets.summary.files ?? '?') + ' 文件 · ' + Math.round((after.assets.summary.bytes || 0) / 1024 / 1024) + 'MB\n              ' + (after.assets.root || after.assets.dir)
    : '✗ 未就绪'))
  line('  运行时   ' + (after.runtime.ready ? '✓ ' + after.runtime.dir : '✗ 未安装（首次渲染自动装）\n              ' + after.runtime.dir))
  line('  ffmpeg   ' + (after.ffmpeg?.missing ? '✗ ' + after.ffmpeg.missing : '✓ ' + after.ffmpeg.version + ' · ' + after.ffmpeg.source + ' · ' + after.ffmpeg.path))
  if (steps.length) line('\n还需要：\n' + steps.map((step) => '  · ' + step).join('\n'))
  else line('\n可以开拍了。')
}

export async function doctor(flags) {
  const report = await inspect()
  const ready = !!(report.babel && report.assets.ready && report.runtime.ready && !report.ffmpeg?.missing)
  if (flags.json) return emit('', { ready, ...report })
  line('运行环境 ' + report.node + ' · ' + report.platform)
  line('  babel     ' + (report.babel ? '✓ ' + report.babel : '✗ 缺 @babel/parser（场景源码校验要用）'))
  line('  素材      ' + (report.assets.ready
    ? '✓ ' + report.assets.source + ' · ' + (report.assets.summary.files ?? '?') + ' 文件 · ' + Math.round((report.assets.summary.bytes || 0) / 1024 / 1024) + 'MB\n              ' + (report.assets.root || report.assets.dir)
    : '✗ 未就绪（`wb setup --download`，或把 WORKBUDDY_ASSETS_DIR 指到已有的素材目录）'))
  line('  运行时    ' + (report.runtime.ready ? '✓ ' + report.runtime.dir : '✗ 未安装（首次渲染自动装）\n              ' + report.runtime.dir))
  line('  ffmpeg    ' + (report.ffmpeg?.missing
    ? '✗ ' + report.ffmpeg.missing + '\n' + HOW_TO_INSTALL.replace(/^/gm, '            ')
    : '✓ ' + report.ffmpeg.version + ' · ' + report.ffmpeg.source + ' · ' + report.ffmpeg.path))
  if (!ready) line('\n缺的项可以用 `wb setup --install` 一次补齐（素材/运行时/FFmpeg 都要下载，约 350MB）。')
}

// ── create ──────────────────────────────────────────────────────────
export async function create(flags, positional) {
  const dir = projectDir(flags, positional)
  if (existsSync(join(dir, 'timeline.json')) && !bool(flags.force)) {
    throw new Error('这个目录已经是视频工程：' + dir + '\n要重建就加 --force。')
  }
  const style = await resolveStyle(flags.style)
  const provisionalFps = parseSpec(flags.spec).fps || style?.rhythm?.fps || 30
  let storyboard = await readStoryboard(flags, { dir, fps: provisionalFps })
  if (storyboard && storyboard.problems.length) {
    throw new Error('分镜表有问题（先改表，再建工程）：\n' + storyboard.problems.map((problem) => '  · ' + problem).join('\n'))
  }
  const spec = resolveSpec(flags, { storyboard, style })
  if (storyboard && spec.fps !== provisionalFps) storyboard = await readStoryboard(flags, { dir, fps: spec.fps })
  const cards = await resolveCards(flags.cards)
  const { createProject, registerProject } = await import('../../engine/motion/project.js')
  let theme
  let themeNote = null
  if (flags.tokens) theme = JSON.parse(String(flags.tokens))
  else if (flags.theme) theme = String(flags.theme)
  else if (style?.palette) {
    const readable = readablePalette(style.palette)
    theme = { ...readable.palette }
    themeNote = readable.note
  }
  mkdirSync(dir, { recursive: true })
  const result = createProject(dir, {
    spec,
    prompt: flags.prompt ? String(flags.prompt) : '（未写 brief；把这条片子要什么写进 BRIEF.md）',
    segments: num(flags.segments, 4),
    cards,
    storyboard: storyboard ? storyboard.rows : undefined,
    theme,
    style,
    fitFrames: spec.fitFrames,
  })
  registerProject(dir)
  const summary = await projectSummary(dir)
  if (flags.json) return emit('', { ok: true, ...summary, files: result.files, warnings: result.warnings })
  line('已建工程：' + dir)
  line('  规格 ' + summary.width + '×' + summary.height + ' @' + summary.fps + 'fps · ' + summary.seconds + 's（' + summary.durationInFrames + ' 帧）· ' + summary.shots.length + ' 段')
  if (summary.style) line('  风格 ' + summary.style + (result.theme ? ' · 主题 ' + result.theme : ''))
  if (themeNote) line('  ! ' + themeNote)
  line('')
  line(table(['#', '镜头', '帧', '时长', '卡片'], summary.shots.map((shot) => [shot.index, shot.id, shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1), formatSeconds(shot.durationFrames, summary.fps), shot.card || '—'])))
  if (result.warnings.length) line('\n注意：\n' + result.warnings.map((warning) => '  · ' + warning).join('\n'))
  line('\n下一步：')
  line('  1) 读 STYLE.md / BRIEF.md / storyboard.md，把每一镜要做什么定下来')
  line('  2) 写 scene-0.tsx …；先 `wb preview --at 1,3` 看定调帧')
  line('  3) 出 3–6 秒样片：`wb render --range 0,90`；看过再渲整片 `wb render`')
}

// ── open ────────────────────────────────────────────────────────────
export async function open(flags, positional) {
  const dir = requireProjectDir(flags, positional)
  const summary = await projectSummary(dir)
  const files = ['timeline.json', 'BRIEF.md', 'storyboard.md', 'STYLE.md', 'theme.ts', ...summary.shots.map((shot) => shot.file)]
    .filter((file) => existsSync(join(dir, file)))
  const missingScenes = summary.shots.map((shot) => shot.file).filter((file) => !existsSync(join(dir, file)))
  if (flags.json) return emit('', { ok: true, ...summary, files, missingScenes })
  line(basename(dir) + '  ·  ' + summary.width + '×' + summary.height + ' @' + summary.fps + 'fps · ' + summary.seconds + 's · ' + summary.shots.length + ' 段')
  if (summary.style) line('风格：' + summary.style)
  line('')
  line(table(['#', '起始', '帧', '时长', '卡片', '文件'], summary.shots.map((shot) => [shot.index, shot.startSeconds + 's', shot.startFrame + '+' + shot.durationFrames, shot.seconds + 's', shot.card || '—', shot.file])))
  if (summary.audio.length) line('\n音轨：' + summary.audio.map((cue) => cue.role + ' ' + cue.file + ' @' + cue.at + 's ' + cue.gainDb + 'dB').join('  '))
  if (summary.subtitles) line('字幕：' + summary.subtitles + ' 条')
  if (missingScenes.length) line('缺场景文件：' + missingScenes.join('、'))
  const outputs = ['film.mp4', 'pilot.mp4'].map((name) => join(outDir(dir), name)).filter((file) => existsSync(file))
  if (outputs.length) line('产出：' + outputs.map((file) => basename(file) + '（' + (statSync(file).size / 1024 / 1024).toFixed(1) + 'MB）').join('、'))
}

// ── theme ───────────────────────────────────────────────────────────
export async function theme(flags, positional) {
  const dir = requireProjectDir(flags, positional)
  const { listThemes, resolveTheme, writeTheme, readTheme } = await import('../../engine/motion/theme.js')
  const themes = listThemes()
  if (flags.name) {
    const resolved = resolveTheme(String(flags.name))
    const written = writeTheme(dir, resolved, resolved.fonts)
    if (flags.json) return emit('', { ok: true, ...written })
    return line('主题已换：' + written.name + ' · page ' + written.tokens.page + ' · ink ' + written.tokens.text + ' · stamp ' + written.tokens.accent + '\n  写在 ' + written.file)
  }
  const current = readTheme(dir)
  if (flags.json) return emit('', { current, themes })
  line('当前主题：' + (current?.name || '（未设）') + (current?.tokens ? '\n  page ' + current.tokens.page + ' · ink ' + current.tokens.text + ' · stamp ' + current.tokens.accent : ''))
  line('')
  line(table(['名字', '底色', '强调'], themes.map((item) => [item.name, item.page, item.accent])))
  line('\n换主题：`wb theme --name <名字>`')
}

// ── spec ────────────────────────────────────────────────────────────
export async function spec(flags, positional) {
  const dir = requireProjectDir(flags, positional)
  const summary = await projectSummary(dir)
  const { STORYBOARD_HEADER: header } = await import('../../engine/motion/canvas-spec.js')
  const action = String(flags.action || 'read')
  if (action === 'read') {
    if (flags.json) return emit('', summary)
    line('规格 ' + summary.width + '×' + summary.height + ' @' + summary.fps + 'fps · ' + summary.durationInFrames + ' 帧 · ' + summary.seconds + 's · ' + summary.shots.length + ' 段')
    line('')
    line(table(['#', '镜头', '帧区间', '时长', '卡片'], summary.shots.map((shot) => [shot.index, shot.id, shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1), formatSeconds(shot.durationFrames, summary.fps), shot.card || '—'])))
    return
  }
  if (action === 'validate') {
    const storyboard = await readStoryboard({ storyboard: flags.storyboard }, { dir, fps: summary.fps })
    const problems = [...(storyboard?.problems || [])]
    if (storyboard) {
      if (storyboard.rows.length !== summary.shots.length) {
        problems.push('分镜表 ' + storyboard.rows.length + ' 行，时间轴 ' + summary.shots.length + ' 段（要么改表，要么用 --force 重建工程）')
      }
      storyboard.rows.forEach((row, index) => {
        const shot = summary.shots[index]
        if (!shot) return
        if (row.startFrame !== undefined && row.startFrame !== shot.startFrame) problems.push('第 ' + (index + 1) + ' 行从 ' + row.startFrame + ' 帧开始，时间轴是 ' + shot.startFrame + ' 帧')
      })
      const total = storyboard.rows.reduce((sum, row) => sum + (row.durationFrames || 0), 0)
      if (total && total !== summary.durationInFrames) problems.push('分镜表合计 ' + total + ' 帧，时间轴是 ' + summary.durationInFrames + ' 帧')
    }
    if (flags.json) return emit('', { ok: !problems.length, problems, rows: storyboard?.rows?.length || 0 })
    if (problems.length) throw new Error('规格有问题：\n' + problems.map((problem) => '  · ' + problem).join('\n'))
    return line('规格与时间轴一致：' + summary.shots.length + ' 段 · ' + summary.durationInFrames + ' 帧。')
  }
  if (action === 'scaffold') {
    const file = join(dir, 'storyboard.md')
    if (existsSync(file) && !bool(flags.force)) throw new Error('storyboard.md 已存在：' + file + '\n要覆盖就加 --force。')
    const body = summary.shots.map((shot) => '| ' + shot.id + ' | ' + shot.startFrame + '–' + (shot.startFrame + shot.durationFrames - 1) + 'f | ' + (shot.card || '') + ' |  |  |  |')
    const text = '# 分镜表\n\n每条视频先在表里写清「这一镜讲什么、屏幕上出现什么、配什么字」，再写场景代码。\n帧区间写 `0–35f` 或 `1.5s`；每行都写清楚时长，时间轴就按表开段。\n\n' + (header || STORYBOARD_HEADER) + '\n' + body.join('\n') + '\n'
    writeFileSync(file, text, 'utf8')
    if (flags.json) return emit('', { ok: true, file, rows: body.length })
    return line('已写分镜表：' + file + '（' + body.length + ' 行；改完用 `wb spec validate` 检查）')
  }
  throw new Error('未知的 spec 动作：' + action + '（可用：read / validate / scaffold）')
}

// ── preview ─────────────────────────────────────────────────────────
export async function preview(flags, positional) {
  const dir = requireProjectDir(flags, positional)
  const summary = await projectSummary(dir)
  requireFfmpeg('预览拼图')
  await refreshEntry(dir)
  const explicit = numbers(flags.frames)
  const at = numbers(flags.at)
  const frames = explicit.length ? explicit
    : at.length ? at.map((seconds) => Math.round(seconds * summary.fps))
      : summary.shots.slice(0, 6).map((shot) => shot.startFrame + Math.floor(shot.durationFrames * 0.6))
  if (frames.some((frame) => !Number.isFinite(frame) || frame < 0 || frame >= summary.durationInFrames)) {
    throw new Error('帧号要在 0–' + (summary.durationInFrames - 1) + ' 之间：' + frames.join(','))
  }
  const { previewProject, normalizeCrop } = await import('../../engine/motion/preview.js')
  const crop = numbers(flags.crop).length ? normalizeCrop(numbers(flags.crop), summary) : null
  const result = await previewProject(dir, { frames, cols: num(flags.cols, 0) || undefined, crop })
  if (flags.json) return emit('', { ok: true, sheet: result.sheet, frames: result.frames.map((item) => ({ frame: item.frame, file: item.file })) })
  line('预览帧：' + result.frames.map((item) => item.frame + 'f').join(' · '))
  line('拼图：' + result.sheet)
  line('看这张图判断构图、字号、留白；画质（锯齿 / 色带）用 `--crop x,y,w,h` 出 1:1 局部。')
}

// ── render ──────────────────────────────────────────────────────────
function renderPlan(flags, summary) {
  const frames = numbers(flags.frames)
  if (frames.length) return { operation: 'still', kind: 'still', output: 'still.mp4', frames }
  const range = numbers(flags.range)
  if (range.length === 2) return { operation: 'full', kind: 'pilot', output: 'pilot.mp4', range }
  return { operation: 'full', kind: 'film', output: 'film.mp4' }
}

export async function render(flags, positional) {
  const action = String(flags.action || 'start')
  if (['status', 'list', 'cancel', 'apply'].includes(action)) return renderControl(action, flags, positional)

  const dir = requireProjectDir(flags, positional)
  const summary = await projectSummary(dir)
  const plan = renderPlan(flags, summary)
  if (plan.operation === 'still') {
    const bad = plan.frames.filter((frame) => frame < 0 || frame >= summary.durationInFrames)
    if (bad.length) throw new Error('--frames 超出 0–' + (summary.durationInFrames - 1) + '：' + bad.join(','))
  } else if (plan.range) {
    const [from, to] = plan.range
    if (from < 0 || to <= from || to > summary.durationInFrames) throw new Error('--range 要在 0–' + summary.durationInFrames + ' 之间，且 to > from')
  }
  // 有音轨时整片要过一遍响度归一（mixing），那一步走 FFmpeg；没有音轨就完全不碰它。
  if (plan.operation === 'full' && summary.audio.length) requireFfmpeg('渲染（混音与响度归一）')

  if (plan.operation === 'full') {
    const { assertEngineFidelity, assertQualityEvidence } = await import('../../engine/motion/style-engine.js')
    const style = summary.style ? await resolveStyle(summary.style) : null
    if (style) {
      const fidelity = assertEngineFidelity(dir, style)
      const quality = assertQualityEvidence(dir, style)
      if (fidelity?.warning) line('  ! ' + fidelity.warning)
      for (const warning of quality?.warnings || []) line('  ! ' + warning)
    }
  }
  await refreshEntry(dir)

  const jobId = newJobId()
  const job = {
    id: jobId,
    dir,
    kind: plan.kind,
    operation: plan.operation,
    output: join(outDir(dir), plan.output),
    frames: plan.frames || null,
    range: plan.range || null,
    status: 'queued',
    progress: 0,
    startedAt: new Date().toISOString(),
  }
  writeJob(dir, job)

  if (bool(flags.wait)) {
    const { runRenderJob } = await import('./render-job.mjs')
    const last = { phase: '', percent: -1 }
    const result = await runRenderJob({
      dir, jobId, kind: plan.kind, operation: plan.operation, output: job.output, frames: plan.frames, range: plan.range,
      onProgress: (event) => {
        const percent = Math.round((event.progress || 0) * 100)
        if (event.phase === last.phase && percent === last.percent) return
        last.phase = event.phase
        last.percent = percent
        line('  ' + String(event.phase || '').padEnd(10) + percent + '%' + (event.frames?.etaSeconds ? ' · 还剩 ' + Math.round(event.frames.etaSeconds) + 's' : ''))
      },
    })
    if (flags.json) return emit('', { ok: true, jobId, ...result })
    if (result.output) return line('完成：' + result.output + '（' + (result.bytes / 1024 / 1024).toFixed(1) + 'MB · ' + result.seconds.toFixed(1) + 's）')
    return line('静帧完成：' + result.stills.join('、'))
  }

  const args = [WB_BIN, '__render', '--dir', dir, '--job', jobId, '--kind', plan.kind, '--operation', plan.operation, '--output', job.output]
  if (plan.frames) args.push('--frames', plan.frames.join(','))
  if (plan.range) args.push('--range', plan.range.join(','))
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  if (flags.json) return emit('', { ok: true, jobId, kind: plan.kind, output: job.output, background: true })
  line('已开始渲染（' + plan.kind + '）：' + jobId)
  line('  产出 ' + job.output)
  line('  `wb status` 看进度；渲完用 `wb qa` 再决定要不要交付。')
}

async function renderControl(action, flags, positional) {
  const dir = requireProjectDir(flags, positional)
  if (action === 'list') {
    const jobs = listJobs(dir)
    if (flags.json) return emit('', { jobs })
    if (!jobs.length) return line('这个工程还没有渲染任务。先 `wb render`。')
    return line(table(['job', '类型', '状态', '进度', '产出'], jobs.map((job) => [job.id, job.kind, job.status, Math.round((job.progress || 0) * 100) + '%', job.output ? basename(job.output) : '—'])))
  }
  const id = flags.job ? String(flags.job) : listJobs(dir)[0]?.id
  const job = id ? readJob(dir, id) : null
  if (!job) throw new Error('找不到任务：' + (id || '（该工程没有任务）'))
  if (action === 'status') {
    if (flags.json) return emit('', job)
    line(job.id + ' · ' + job.kind + ' · ' + job.status + ' · ' + Math.round((job.progress || 0) * 100) + '%' + (job.phase ? ' · ' + job.phase : ''))
    if (job.error) line('错误：' + job.error)
    if (job.status === 'done') line('产出：' + (job.output || (job.stills || []).join('、')) + '\n下一步：`wb qa` 检一遍，通过再交付。')
    return
  }
  if (action === 'cancel') {
    if (job.status !== 'running' && job.status !== 'queued') throw new Error('任务已经' + job.status + '，不用取消：' + job.id)
    writeFileSync(join(jobsDir(dir), job.id + '.cancel'), '1', 'utf8')
    if (job.pid) { try { process.kill(job.pid) } catch { /* 已经退出 */ } }
    if (flags.json) return emit('', { ok: true, jobId: job.id, cancelled: true })
    return line('已取消：' + job.id)
  }
  if (action === 'apply') {
    const source = job.output
    if (!source || !existsSync(source)) throw new Error('成片还没生成：' + source)
    const target = join(dir, 'out-' + job.kind + '.mp4')
    copyFileSync(source, target)
    if (flags.json) return emit('', { ok: true, jobId: job.id, source, target })
    return line('成片：' + target)
  }
  throw new Error('未知的 render 动作：' + action)
}

// ── status ──────────────────────────────────────────────────────────
export async function status(flags, positional) {
  const dir = projectDir(flags, positional)
  if (!existsSync(join(dir, 'timeline.json'))) {
    if (flags.json) return emit('', { ok: false, dir })
    return line('（' + dir + ' 还不是视频工程）')
  }
  const summary = await projectSummary(dir)
  const jobs = listJobs(dir)
  if (flags.json) return emit('', { ...summary, jobs })
  line(basename(dir) + ' · ' + summary.seconds + 's · ' + summary.shots.length + ' 段 · ' + (summary.style || '无整片风格'))
  line('最近任务：' + (jobs.length ? jobs.map((job) => job.kind + '/' + job.status + '/' + Math.round((job.progress || 0) * 100) + '%').join('  ') : '（无）'))
}

// ── qa ──────────────────────────────────────────────────────────────
export async function qa(flags, positional) {
  const dir = requireProjectDir(flags, positional)
  const summary = await projectSummary(dir)
  requireFfmpeg('帧检')
  const file = flags.file ? resolveInput(dir, String(flags.file)) : join(outDir(dir), 'film.mp4')
  if (!existsSync(file)) throw new Error('没有这个文件：' + file + '\n先 `wb render`（整片），或用 --file 指定要检的片子。')
  const { readTimeline } = await import('../../engine/motion/project.js')
  const { runFrameQa } = await import('../../engine/motion/qa.js')
  let report = await runFrameQa({ dir, file, timeline: readTimeline(dir), options: { freezeSeconds: num(flags.freeze, undefined) } })
  // 样片（pilot / --file 指定的片段）本来就不等于整片帧数，这条不该判 fail。
  if (basename(file) !== 'film.mp4') {
    report = {
      ...report,
      checks: report.checks.map((check) => (check.message.startsWith('成片帧数')
        ? { ...check, level: 'warn', message: check.message + '（这是样片，帧数只算样片区间）' }
        : check)),
    }
    report.verdict = report.checks.some((check) => check.level === 'fail') ? 'fail'
      : report.checks.some((check) => check.level === 'warn') ? 'warn' : 'pass'
  }
  if (flags.json) return emit('', report)
  line('帧检 ' + basename(file) + ' · ' + report.verdict + ' · ' + report.frames + ' 帧 · ' + report.durationSeconds + 's')
  if (!report.checks.length) return line('  没有异常。')
  for (const check of report.checks) line('  ' + (check.level === 'fail' ? '✗' : check.level === 'warn' ? '!' : '·') + ' ' + check.message)
  if (report.verdict !== 'pass') line('\n按上面的行号/帧号回场景里改；`wb qa` 只看画面，节奏与文案要自己看。')
}

// ── export ──────────────────────────────────────────────────────────
export async function exportPackageCommand(flags, positional) {
  const dir = requireProjectDir(flags, positional)
  const summary = await projectSummary(dir)
  requireFfmpeg('导出（切镜头 / 混音）')
  const { exportPackage, listExports } = await import('../../engine/motion/export.js')
  if (bool(flags.list)) {
    const list = listExports(dir)
    if (flags.json) return emit('', { exports: list })
    return line(list.length ? list.map((item) => item.name + '  ' + new Date(item.at).toLocaleString() + '\n  ' + item.folder).join('\n') : '还没导出过。')
  }
  const { readTimeline } = await import('../../engine/motion/project.js')
  const film = flags.film ? resolveInput(dir, String(flags.film)) : undefined
  const result = await exportPackage({
    dir,
    timeline: readTimeline(dir),
    name: flags.name ? String(flags.name) : 'jianying',
    draft: bool(flags.draft),
    subtitles: flags.subtitles ? JSON.parse(String(flags.subtitles)) : undefined,
    film,
  })
  if (flags.json) return emit('', result)
  line('剪映素材包：' + result.folder)
  line('  ' + result.shots.length + ' 段镜头' + (result.stems.length ? ' · ' + result.stems.length + ' 条音轨' : '') + (result.subtitles ? ' · ' + result.subtitles + ' 条字幕（subtitles.srt）' : '') + (result.draft ? ' · 含草稿 draft_content.json' : ''))
  if (result.missing?.length) line('  缺：' + result.missing.join('、'))
  line('  整个文件夹拖进剪映就能接着剪；镜头已按时间轴精确切好。')
}
