// 帧检：把"片子到底有没有毛病"变成一份带帧号的报告，而不是靠人眼逐帧看。
//
// 上游 template 里有一份 final-review.md 讲怎么验片，但没有脚本；这里把它
// 落成可执行的四类检查（全部基于 ffmpeg，不引入新依赖）：
//
//   1. 结构   帧数 / 时长与 timeline 是否一致（硬错误）
//   2. 黑场   整段纯黑（blackdetect）——通常是某镜没渲染出来
//   3. 呆帧   画面静止多久（freezedetect）——设计留白还是漏了动画
//   4. 闪烁   单帧亮度突变又立刻复原（手算 Y 均值序列）
//   5. 空白   近乎纯色的帧（内容是"忘了放东西"）
//   6. 越界   四边安全区里出现了墨色（文字压边）
//   7. 响度   综合响度 / 真峰值 / 静音段（ebur128）
//   8. 动能量 相邻帧差的平均幅度（blend=difference）——抓"缓慢缩放平移"的翻页感，
//            这一条 freezedetect 抓不到：Ken Burns 幻灯片每帧都在动，却整镜没节奏
//   9. 空画面 边密度（edgedetect 的 Y 均值）——抓"有渐变底、什么都没放"，
//            这一条空白帧抓不到：底色渐变会让 ymax-ymin 很大
//
// 报告落 .out/qa/framecq/report.json，同时给一份能直接读的 markdown 摘要。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { runFfmpeg } from './ffmpeg.js'
import { pixelQuality } from './pixelqa.js'
import { parseProjectJson } from './json.js'

const DEFAULTS = {
  freezeSeconds: 1.2,     // 静止超过这个时长就记一笔
  flashDelta: 18,         // 单帧亮度突变阈值（0–255）
  emptyDelta: 18,         // 亮度极差小于它就当空白帧
  emptyFrames: 8,         // 连续多少帧算"一段空白"
  marginRatio: 0.035,     // 四边安全区宽度（占画面宽/高）
  marginDark: 170,        // 安全区里出现比这更暗的像素＝内容压边
  blackPixThreshold: 0.10,
  // 以下五个是量纲统一的：都在 480 宽缩略图上算，与成片分辨率无关。
  lowDiff: 0.6,           // 相邻帧平均绝对差低于它＝"这一帧没动"（0–255）
  slideDiff: 1.2,         // 镜头中位动能量低于它、且低动帧占比过线＝翻页感
  slideLowRatio: 0.7,
  edgeMin: 1.5,           // 边密度（edgedetect 的 Y 均值）低于它＝有底没内容
  edgeFrames: 8,          // 连续多少帧边密度不足才算一段空画面
}

export function qaDir(dir) {
  return join(dir, '.out', 'qa', 'framecq')
}

function parseStats(text) {
  const rows = []
  let row = null
  for (const line of text.split(/\r?\n/)) {
    const head = /^frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)/.exec(line)
    if (head) { row = { frame: Number(head[1]), t: Number(head[2]) }; rows.push(row); continue }
    const kv = /^lavfi\.signalstats\.(\w+)=(-?[\d.]+)/.exec(line)
    if (kv && row) row[kv[1].toLowerCase()] = Number(kv[2])
  }
  return rows
}

function runs(flags) {
  const out = []
  let start = -1
  for (let i = 0; i <= flags.length; i += 1) {
    if (i < flags.length && flags[i]) { if (start < 0) start = i; continue }
    if (start >= 0) { out.push({ from: start, to: i - 1, length: i - start }); start = -1 }
  }
  return out
}

const second = (value) => Math.round(value * 100) / 100

function percentile(sorted, p) {
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index]
}

// 中位看"整镜到底动没动"，p90/中位看"有没有节奏峰"：匀速推镜的两头几乎相等。
function profile(values) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  return { count: sorted.length, median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) }
}

// 最长连续命中：连续两个镜头都像翻页，就不是"某一镜的问题"，是全片的问题。
function longestRun(flags) {
  let longest = 0
  let open = 0
  for (const flag of flags) { open = flag ? open + 1 : 0; if (open > longest) longest = open }
  return longest
}

export async function runFrameQa({ dir, file, timeline, options = {} }) {
  // 工具层会把没传的参数也写成 undefined 传进来，展开时会把默认值顶掉（freezeSeconds 变 undefined，
  // 静止判定就整段失效）—— 所以先剔掉 undefined 再合。
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  const settings = { ...DEFAULTS, ...given }
  const source = resolvePath(file || join(dir, '.out', 'film.mp4'))
  if (!existsSync(source)) throw new Error('没有成片可检：先 motion_render start 出一版（' + source + '）')
  if (!timeline || !Array.isArray(timeline.shots)) throw new Error('缺少 timeline，无法把发现问题归到镜头')
  const fps = Number(timeline.fps) || 30
  const work = qaDir(dir)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const call = (args, extra = {}) => runFfmpeg(args, { cwd: work, ...extra })
  const read = (name) => existsSync(join(work, name)) ? readFileSync(join(work, name), 'utf8') : ''

  // 缩成 480 宽再做统计：统计量对分辨率不敏感，解码却快一个量级。
  await call(['-i', source, '-an', '-vf', 'scale=480:-2', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', 'scaled.mp4'])
  await call(['-i', 'scaled.mp4', '-an', '-vf', 'signalstats,metadata=print:file=stats.txt', '-f', 'null', '-'])
  const stats = parseStats(read('stats.txt'))
  if (!stats.length) throw new Error('ffmpeg 没有输出逐帧统计，成片可能无法解码')

  // 两份额外统计，都在同一条 480 宽缩略片上跑：
  //   动能量 = 把两条流错开一帧再 blend=difference，得到的逐帧均值就是 |f(t+1)-f(t)|；
  //   边密度 = edgedetect 把边缘画成白点，Y 均值就是"画面里还有多少结构"。
  // 任一步失败都不该让整份帧检作废，所以单独兜住，报告里标成"未验证"。
  let diffs = []
  let edges = []
  let motionError = null
  try {
    await call(['-i', 'scaled.mp4', '-an', '-filter_complex',
      '[0:v]split=2[s0][s1];[s0]trim=start_frame=0,setpts=PTS-STARTPTS[a];'
      + '[s1]trim=start_frame=1,setpts=PTS-STARTPTS[b];'
      + '[a][b]blend=all_mode=difference,signalstats,metadata=print:file=diff.txt[out]',
      '-map', '[out]', '-f', 'null', '-'])
    await call(['-i', 'scaled.mp4', '-an', '-vf',
      'edgedetect=low=0.08:high=0.2,signalstats,metadata=print:file=edge.txt', '-f', 'null', '-'])
    diffs = parseStats(read('diff.txt')).map((row) => row.yavg)
    edges = parseStats(read('edge.txt')).map((row) => row.yavg)
    if (!diffs.length) motionError = '差帧统计为空'
  } catch (error) {
    motionError = (error.message || String(error)).split('\n')[0]
  }


  const bands = { left: '0:0', right: 'iw-iw*R:0', top: '0:0', bottom: '0:ih-ih*R' }
  const cropOf = {
    left: 'crop=iw*R:ih:0:0', right: 'crop=iw*R:ih:iw-iw*R:0',
    top: 'crop=iw:ih*R:0:0', bottom: 'crop=iw:ih*R:0:ih-ih*R',
  }
  const margins = {}
  for (const band of Object.keys(cropOf)) {
    const filter = cropOf[band].replace(/R/g, String(settings.marginRatio)) + ',signalstats,metadata=print:file=m-' + band + '.txt'
    await call(['-i', 'scaled.mp4', '-an', '-vf', filter, '-f', 'null', '-'])
    margins[band] = parseStats(read('m-' + band + '.txt'))
  }

  const detected = await call(['-i', source, '-an', '-vf',
    'blackdetect=d=0.10:pix_th=' + settings.blackPixThreshold + ',freezedetect=n=-55dB:d=' + Math.max(0.3, settings.freezeSeconds) / 2, '-f', 'null', '-'], { allowFail: true })
    .catch((error) => String(error.stderr || error.message || ''))
  const blacks = [...detected.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
    .map((match) => ({ from: Number(match[1]), to: Number(match[2]), seconds: Number(match[3]) }))
  // freezedetect 三行分开打：start → duration → end。按出现顺序串起来。
  const freezes = []
  let open = null
  for (const line of detected.split(/\r?\n/)) {
    let match
    if ((match = /freeze_start:\s*([\d.]+)/.exec(line))) { open = { from: Number(match[1]) }; freezes.push(open); continue }
    if (open && (match = /freeze_duration:\s*([\d.]+)/.exec(line))) { open.seconds = Number(match[1]); continue }
    if (open && (match = /freeze_end:\s*([\d.]+)/.exec(line))) { open.to = Number(match[1]); open = null }
  }

  const shotAt = (time) => {
    const frame = Math.round(time * fps)
    const shot = timeline.shots.find((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames)
    return shot ? shot.id : '(镜头之间)'
  }

  // 逐镜动能量。差帧流比原片少一帧，所以按帧号切片时尾巴会短一个——不影响中位。
  const energies = timeline.shots.map((shot) => {
    const values = diffs.slice(shot.startFrame, shot.startFrame + shot.durationFrames)
    const { median, p90 } = profile(values)
    if (median === null) return null
    const low = values.filter((value) => value < settings.lowDiff).length / values.length
    return { median: second(median), p90: second(p90), low: second(low) }
  })
  const slides = energies.map((energy) => !!energy && energy.median < settings.slideDiff && energy.low > settings.slideLowRatio)

  // 单帧突变：比前后两帧都跳、而前后两帧彼此接近 —— 那是闪，不是运动。
  const flashes = []
  for (let i = 1; i < stats.length - 1; i += 1) {
    const before = stats[i - 1].yavg, here = stats[i].yavg, after = stats[i + 1].yavg
    if (before === undefined || here === undefined || after === undefined) continue
    if (Math.abs(here - before) > settings.flashDelta && Math.abs(here - after) > settings.flashDelta && Math.abs(before - after) < 8)
      flashes.push({ frame: stats[i].frame, t: stats[i].t, yavg: here })
  }

  // 空白帧：亮度极差极小（既没有字也没有图）。
  const flat = stats.map((row) => (row.ymax ?? 0) - (row.ymin ?? 0) < settings.emptyDelta)
  const blanks = runs(flat).filter((run) => run.length >= settings.emptyFrames)
    .map((run) => ({ from: stats[run.from].t, to: stats[run.to].t, frames: run.length }))

  const marginHits = {}
  for (const band of Object.keys(margins)) {
    const rows = margins[band]
    const dark = rows.map((row) => (row.ymin ?? 255) < settings.marginDark)
    marginHits[band] = runs(dark).filter((run) => run.length >= 3)
      .map((run) => ({ from: second(rows[run.from]?.t ?? 0), to: second(rows[run.to]?.t ?? 0), frames: run.length }))
  }

  // 像素级三项：色带、抗锯齿、字体。走原始灰度字节，所以能看见「这帧糊不糊」。
  // 关掉它的方式：options.pixels === false（例如只想快速看结构问题）。
  let pixels = null
  if (settings.pixels !== false) {
    try {
      pixels = await pixelQuality({ source, work, timeline, dir, samples: settings.pixelSamples || 3 })
    } catch (error) {
      pixels = { error: error.message || String(error) }
    }
  }

  const hasAudio = /Stream #\S+.*: Audio:/.test(await call(['-i', source], { allowFail: true }).catch(() => ''))
  let audio = { hasAudio, checked: false }
  if (hasAudio) {
    const measured = await call(['-i', source, '-vn', '-af', 'ebur128=peak=true,silencedetect=noise=-50dB:d=0.5', '-f', 'null', '-'])
      .catch((error) => String(error.stderr || ''))
    const summary = measured.slice(measured.lastIndexOf('Summary:'))
    const grab = (pattern) => { const found = pattern.exec(summary); return found ? Number(found[1]) : null }
    audio = {
      hasAudio, checked: true,
      integratedLufs: grab(/I:\s*(-?[\d.]+) LUFS/), truePeakDb: grab(/Peak:\s*(-?[\d.]+) dBFS/),
      silence: [...measured.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1])).slice(0, 12),
    }
  }

  const durationSeconds = stats.length / fps
  const expectedFrames = Number(timeline.durationInFrames)
  const checks = []
  const add = (level, id, message, detail) => checks.push({ level, id, message, ...(detail === undefined ? {} : { detail }) })

  if (Math.abs(stats.length - expectedFrames) > 1)
    add('fail', 'frames', '成片帧数 ' + stats.length + ' 与时间轴 ' + expectedFrames + ' 不一致（差 ' + (stats.length - expectedFrames) + ' 帧）')
  else add('pass', 'frames', '帧数 ' + stats.length + ' 与时间轴一致')

  for (const black of blacks) add('fail', 'black', '纯黑段 ' + second(black.from) + 's–' + second(black.to) + 's（' + second(black.seconds) + 's）', shotAt(black.from))
  if (!blacks.length) add('pass', 'black', '没有纯黑段')

  const longFreezes = freezes.filter((item) => item.seconds >= settings.freezeSeconds)
  for (const freeze of longFreezes) {
    const heavy = freeze.seconds >= settings.freezeSeconds * 2
    add(heavy ? 'warn' : 'info', 'freeze',
      '画面静止 ' + second(freeze.seconds) + 's（' + second(freeze.from) + 's–' + second(freeze.to ?? freeze.from + freeze.seconds) + 's）'
      + (heavy ? '' : '，像是设计停留'), shotAt(freeze.from))
  }
  if (!longFreezes.length) add('pass', 'freeze', '没有超过 ' + settings.freezeSeconds + 's 的静止段')
  else if (!longFreezes.some((item) => item.seconds >= settings.freezeSeconds * 2)) add('pass', 'freeze', '静止段都在设计停留的量级（<' + settings.freezeSeconds * 2 + 's）')

  // 动能量：这一条和 freeze 是两回事。freeze 只看"完全不动"，Ken Burns 式缓慢缩放
  // 每帧都在动、永远触发不了 freeze，但整镜没有一次加速——那正是翻页感的来源。
  for (const [index, energy] of energies.entries()) {
    if (!slides[index]) continue
    add('warn', 'energy', '第 ' + (index + 1) + ' 镜 ' + timeline.shots[index].id + ' 整镜动能量偏低：中位 '
      + energy.median + '、低动帧占 ' + Math.round(energy.low * 100) + '% —— 像翻页，不像动画', timeline.shots[index].id)
  }
  const slideRun = longestRun(slides)
  if (slideRun >= 2)
    add('fail', 'energy-ppt', '连续 ' + slideRun + ' 个镜头几乎没有运动（中位 < ' + settings.slideDiff
      + '、低动帧 > ' + Math.round(settings.slideLowRatio * 100) + '%）—— 整体观感是幻灯片')
  else if (energies.some(Boolean) && !slides.some(Boolean)) {
    const lowest = energies.filter(Boolean).reduce((min, item) => (min === null || item.median < min ? item.median : min), null)
    add('pass', 'energy', '镜头动能量正常（最低一镜中位 ' + lowest + '）')
  }
  if (motionError) add('info', 'energy', '动能量与边密度没测成：' + motionError + '（这两项未验证）')


  for (const flash of flashes.slice(0, 8)) add('warn', 'flash', '第 ' + flash.frame + ' 帧亮度突变（' + second(flash.t) + 's，Y≈' + second(flash.yavg) + '）', shotAt(flash.t))
  if (!flashes.length) add('pass', 'flash', '没有单帧闪烁')

  for (const blank of blanks) add('warn', 'blank', '近乎空白 ' + second(blank.from) + 's–' + second(blank.to) + 's（' + blank.frames + ' 帧）', shotAt(blank.from))
  if (!blanks.length) add('pass', 'blank', '没有连续空白帧')

  // 空画面：blank 判的是"亮度极差小"，只能抓近乎纯色。底色是渐变时极差很大，
  // 但画面里其实什么都没有——那种要靠边密度才看得见。
  const thin = edges.map((value) => Number.isFinite(value) && value < settings.edgeMin)
  const emptyRuns = runs(thin).filter((run) => run.length >= settings.edgeFrames)
    .map((run) => ({
      from: second(stats[run.from]?.t ?? 0), to: second(stats[run.to]?.t ?? 0), frames: run.length,
      edge: second(Math.min(...edges.slice(run.from, run.to + 1))),
    }))
  // 同一次失败只报一次：已经在 black / blank 里记过的段落不再重复记。
  const already = (range) => blacks.some((item) => item.to >= range.from - 0.02 && item.from <= range.to + 0.02)
    || blanks.some((item) => item.to >= range.from - 0.02 && item.from <= range.to + 0.02)
  const emptyContent = emptyRuns.filter((range) => !already(range))
  for (const range of emptyContent)
    add('warn', 'content', '有底没内容 ' + range.from + 's–' + range.to + 's（' + range.frames + ' 帧，边密度 ' + range.edge + '）—— 只剩底色，没放东西', shotAt(range.from))
  if (edges.length && !emptyContent.length) add('pass', 'content', '没有只有底色、没内容的段落')


  let marginCount = 0
  for (const [band, hits] of Object.entries(marginHits)) {
    if (!hits.length) continue
    marginCount += hits.length
    add('warn', 'margin-' + band, band + ' 侧安全区有内容 ' + hits.length + ' 段，最长起于 ' + hits[0].from + 's', hits.slice(0, 4))
  }
  if (!marginCount) add('pass', 'margin', '四边安全区干净')

  if (pixels && !pixels.error) {
    const worst = pixels.banding && pixels.banding.worst
    const bandingSteps = settings.bandingSteps || 10
    if (worst && worst.longest >= bandingSteps)
      add('warn', 'banding', '渐变出现阶梯色带（最长 ' + worst.longest + ' 段、共 ' + worst.steps + ' 级，' + worst.time + 's 第 ' + worst.y + ' 行）—— 多半是 8bit 量化没配抖动', shotAt(worst.time))
    else add('pass', 'banding', '没有检出色带阶梯' + (worst ? '（最长 ' + worst.longest + ' 段）' : ''))

    const aaValue = pixels.aa ? pixels.aa.average : null
    if (aaValue !== null) {
      const aaMin = settings.aaMin === undefined ? 0.3 : settings.aaMin
      if (aaValue < aaMin) add('warn', 'aa', '斜边过渡像素占比 ' + aaValue + '（低于 ' + aaMin + '）—— 边缘像台阶，考虑开累积或超采样')
      else add('pass', 'aa', '斜边过渡像素占比 ' + aaValue)
    } else {
      // 测不出不等于没问题：整帧近乎单色时 Sobel 找不到过渡像素。
      // 这时候报 pass 会让「平涂深色底 + 细线」这种最该检查的片子悄悄过关。
      add('info', 'aa', '量不出斜边过渡（画面近乎单色或对比过低），AA 未验证；等有内容的帧再检一次')
    }

    const missing = (pixels.fonts && pixels.fonts.missing) || []
    if (missing.length) add('fail', 'font', '场景声明了 ' + missing.length + ' 个没注册的字体（会静默退回系统字体）：' + missing.map((item) => item.family).join('、'), missing.map((item) => item.file))
    else add('pass', 'font', '字体都有注册或字体文件' + (pixels.fonts && pixels.fonts.families && pixels.fonts.families.length ? '（' + pixels.fonts.families.join(' / ') + '）' : ''))
  } else if (pixels && pixels.error) add('info', 'pixels', '像素级检查没跑成：' + pixels.error)

  if (audio.checked) {
    if (audio.truePeakDb !== null && audio.truePeakDb > -0.1) add('warn', 'audio-peak', '真峰值 ' + audio.truePeakDb + ' dBFS，已贴顶')
    else if (audio.truePeakDb !== null) add('pass', 'audio-peak', '真峰值 ' + audio.truePeakDb + ' dBFS')
    if (audio.integratedLufs !== null && audio.integratedLufs < -45) add('warn', 'audio-level', '综合响度 ' + audio.integratedLufs + ' LUFS，整片近乎无声')
    else if (audio.integratedLufs !== null) add('pass', 'audio-level', '综合响度 ' + audio.integratedLufs + ' LUFS')
    if (audio.silence.length > 2) add('info', 'audio-silence', '有 ' + audio.silence.length + ' 处静音起点（设计上的空拍请忽略）', audio.silence)
  } else add('info', 'audio', '成片没有音轨')

  const byShot = timeline.shots.map((shot, index) => {
    const from = shot.startFrame / fps, to = (shot.startFrame + shot.durationFrames) / fps
    const inside = (time) => time >= from - 0.02 && time < to - 0.02
    return {
      id: shot.id, from, to, seconds: second(shot.durationFrames / fps),
      freeze: second(Math.max(0, ...freezes.filter((item) => inside(item.from)).map((item) => item.seconds || 0))),
      black: blacks.filter((item) => inside(item.from)).length,
      blank: blanks.filter((item) => inside(item.from)).length,
      content: emptyContent.filter((item) => inside(item.from)).length,
      flash: flashes.filter((item) => inside(item.t)).length,
      margin: Object.values(marginHits).flat().filter((item) => inside(item.from)).length,
      energy: energies[index] || null,
    }
  })

  const fails = checks.filter((item) => item.level === 'fail').length
  const warns = checks.filter((item) => item.level === 'warn').length
  const report = {
    generatedAt: new Date().toISOString(), file: source, fps, frames: stats.length, durationSeconds: second(durationSeconds),
    verdict: fails ? 'fail' : warns ? 'warn' : 'pass', summary: { fail: fails, warn: warns, pass: checks.length - fails - warns },
    shots: byShot, checks, audio, pixels,
    // 量纲写进报告：换个片子看这份 JSON 的人不该猜"2.3 是什么单位"。
    motion: {
      unit: '相邻帧平均绝对差（480 宽灰度 0–255）',
      diffFrames: diffs.length, edgeFrames: edges.length, error: motionError,
    },
    freezeSegments: freezes.map((item) => ({ from: second(item.from), to: item.to === undefined ? null : second(item.to), seconds: second(item.seconds || 0) })).filter((item) => item.seconds >= settings.freezeSeconds),
    settings,
  }
  writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
  // 统一入口：渲染期的 report（worker 写的渲染规格/采样帧）与帧检结论合成一份，
  // 读报告的人不需要知道有两个目录。
  try {
    const merged = join(dir, '.out', 'qa', 'report.json')
    const base = existsSync(merged) ? parseProjectJson(readFileSync(merged, 'utf8')) : {}
    base.frameQa = { generatedAt: report.generatedAt, verdict: report.verdict, summary: report.summary, checks, audio, pixels, motion: report.motion }
    writeFileSync(merged, JSON.stringify(base, null, 2) + '\n', 'utf8')
  } catch { /* 合并失败不该影响帧检结论 */ }
  for (const name of readdirSync(work)) if (/\.(raw|log)$/.test(name)) rmSync(join(work, name), { force: true })
  for (const name of ['stats.txt', 'diff.txt', 'edge.txt', 'm-left.txt', 'm-right.txt', 'm-top.txt', 'm-bottom.txt', 'scaled.mp4', 'ff.log'])
    rmSync(join(work, name), { force: true })
  return report
}

export function readQaReport(dir) {
  const file = join(qaDir(dir), 'report.json')
  if (!existsSync(file)) return null
  return parseProjectJson(readFileSync(file, 'utf8'))
}

export function renderMarkdown(report) {
  const line = (item) => '- [' + item.level + '] ' + item.message + (typeof item.detail === 'string' ? '　→ ' + item.detail : '')
  return [
    '# 帧检报告',
    '',
    '结论：**' + report.verdict + '**　（fail ' + report.summary.fail + ' / warn ' + report.summary.warn + ' / pass ' + report.summary.pass + '）',
    '成片：' + report.frames + ' 帧 · ' + report.durationSeconds + 's · ' + report.fps + 'fps',
    '',
    '## 逐镜',
    '',
    '| 镜头 | 时长 | 最长静止 | 动能量 | 黑场 | 空白 | 空画面 | 闪烁 | 越界 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.shots.map((shot) => '| ' + shot.id + ' | ' + shot.seconds + 's | ' + shot.freeze + 's | '
      + (shot.energy ? shot.energy.median : '—') + ' | ' + shot.black + ' | ' + shot.blank + ' | '
      + (shot.content || 0) + ' | ' + shot.flash + ' | ' + shot.margin + ' |'),
    '',
    '动能量 = 相邻帧平均绝对差（480 宽灰度 0–255）：中位偏低且低动帧多，就是翻页感；'
    + 'p90/中位 偏低，说明整镜匀速、没有加速段。',
    '',
    '## 发现',
    '',
    ...report.checks.map(line),
    '',
  ].join('\n')
}
