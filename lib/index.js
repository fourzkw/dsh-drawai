/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/**
 * dsh-drawai —— 宿主半边（Host half）· 源文件
 *
 * 这是**源文件**，不要改 lib/index.js —— 那个由 tools/build.mjs 生成。
 *
 * 不需要语法转换：本文件是可直接运行的 ESM。构建器只加一行生成标记，
 * 所以宿主半边改完只要 `npm run build` + 重启 dsh web 就生效
 * （客户端半边有热重载，宿主半边没有 —— 宿主只在启动时加载一次）。
 *
 * 导出形式与 DSH 全部参考包一致：{ name, inject, apply }。
 * 注册的工具：
 *   - diagram_read  读回画布文档（节点/边/形状/配色）
 *   - diagram_apply 施加结构化编辑 → 分层自动布局 → 原子写回
 *   - motion_task 主会话查询、修改和管理 Shotcraft 视频任务
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseFragment as parseHtmlFragment, serialize as serializeHtml } from 'parse5'
import postcss from 'postcss'
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync, appendFileSync, renameSync, realpathSync, mkdirSync, cpSync, lstatSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createDocumentCoordinator, createMediaWorkSlots } from './task-coordinator.js'
import { createDrawingTaskManager } from './drawing-tasks.js'
import { applyDrawingResult } from './drawing-results.js'
import { createTaskPatchJournal, applyTaskPatches } from './task-patches.js'
import { isAbsolute, resolve as resolvePath, join as joinPath, dirname as dirnamePath, basename as basenamePath, relative as relativePath } from 'node:path'
import { createVideoTracePool } from './video-trace-pool.js'
import { videoTraceOptions, exactVideoFrameKey } from './video-trace-reuse.js'
import { createPerformanceLog } from './performance-log.js'
import { createVideoExportManager } from './video-export.js'
import { contentHash } from './mxfile.js'
import { parseCanvas as parseMxfile, applyCanvas as applyDocToMxfile, buildCanvas as buildMxfile, isCanvasPath, isNativeCanvasPath, nativeCanvasPath, migrateCanvasFile, exportCanvasToMxfile, migrateMxfile, forkNativeCanvas } from './canvas-format.js'
import { emptyDocument, normalizeDocument } from './document-core.js'
import { createDocumentCommands } from './document-commands.js'
import { createOrthogonalRouter } from './routing/router.js'
import { buildExportSvg, rasterizeSvgToPng } from './svg-export.js'
import { getRoutingRuntime } from './routing/node-runtime.js'
import { motionInput, motionInputKey, assertMotionEditable, applyMotionResult, isMotionNode, motionNodeData, motionSettings, mergeMotionSettings, isAudioNode, audioNodeData, audioNodeSettings, motionReferenceEdges, motionReferenceRole, unlinkedShotCards } from './motion-core.js'
import { createAudioService } from './audio-service.js'
import { frozenAudioFile, importAudioFile } from './audio-media.js'
import { ffmpegState } from './ffmpeg-manager.js'
import { shotCardCatalog, enforceMotionCards, motionCardContract, mgStyleCatalog, mgStyleKit, mgStyleSources, mgStyleFile, mgStyleFileSize } from './motion-library.js'
import { searchShotCards, resolveShotStyle, shotCardData, isShotCardNode } from './shotcard-core.js'
import { searchMgStyles, resolveMgStyle, mgStyleData, isMgStyleNode } from './mgstyle-core.js'
import { captureStyleFrames } from './motion/style-frames.js'
import { assertEngineFidelity, assertQualityEvidence, ENGINE_LABEL, GATED_ENGINES } from './motion/style-engine.js'
import { prepareReferenceFrames } from './shotcard-reference.js'
import { inspectMotionFilm,motionSequenceReviewer } from './motion-film-review.js'
import { createMotionTaskManager } from './motion-tasks.js'
import { readSpec, validateSpec } from './motion/spec.js'
import { createProject, readTimeline, writeTimeline, listFiles, registerProject } from './motion/project.js'
import { renderProject, outputPath, outputInfo } from './motion/render.js'
import { describeRenderSettings } from './motion/render-settings.js'
import { previewProject } from './motion/preview.js'
import { RenderJobs, applyJobKind } from './motion/jobs.js'
import { assetsDirectory, captureAsset, cropAsset, fetchAsset, listAssets, colorsOf, probeAudio } from './motion/assets.js'
import { listMediaLibrary, importMediaLibrary } from './motion/media-catalog.js'
import { assetsSummary, ensureAssets, requireAssets } from './motion/asset-pack.js'
import { parseProjectJson } from './motion/json.js'
import { analyzeBeats, snapFrame } from './motion/beats.js'
import { resolveSync, verifySync, assetPath, filmHash } from './motion/sync.js'
import { addCue, cuePinnedAt, describeTrack, readTrack, removeCue } from './motion/audio.js'
import { applyFilm, extractAudio } from './motion/apply.js'
import { readCanvasSpec, validateCanvasSpec, scaffoldOps, findSpecNodes, storyboardTable, styleTemplate, SPEC_MARKERS } from './motion/canvas-spec.js'
import { capturePage } from './motion/capture.js'
import { collectPageAssets, gatherAssets } from './motion/collect.js'
import { getSfx, listSfx, searchSfx, readManifest as readAudioManifest } from './motion/sfx.js'
import { cueLevel, describeLevel, resolveGainDb, suggestedGainOf } from './motion/audiolevel.js'
import { describeMix } from './motion/audiomix.js'
import { runFrameQa, readQaReport, qaDir } from './motion/qa.js'
import { exportPackage, listExports } from './motion/export.js'
import { listThemes, resolveTheme, writeTheme, readTheme } from './motion/theme.js'
import { VOICE_CHOICES, VOICE_DEFAULTS, alignNarration, checkNarration, describeNarration, edgeAvailable, parseScript, planNarration, readScript, sayNarration, totalSpeechSeconds } from './motion/voice.js'
import { motionSessionNotice } from './motion-session.js'
import { decodeRaster } from './raster.js'
import {
  TRACE_DEFAULTS,
  TRACE_PRESET_NAMES,
  resolveTraceOptions,
  summarizeTraceForAi,
  toLosslessJson,
  traceRasterForToolbar,
} from './trace-image.js'
import {
  DEFAULT_MEDIA_FPS,
  DEFAULT_MEDIA_H,
  DEFAULT_MEDIA_W,
  MAX_FRAME_SVG_CHARS,
  allocateClipId,
  appendFrameSvgs,
  cleanupUnreferencedClips,
  clipDirFor,
  copyMediaBeside,
  ensureClipPack,
  findSourceFile,
  importSourceFile,
  listFrameEntries,
  listStillIndices,
  mediaRootFor,
  packCanvasBundle,
  packSvgVideoZip,
  readFrameSvg,
  readManifest,
  readStillPng,
  sanitizeClipId,
  unpackCanvasBundle,
  unpackSvgVideoZip,
  videoDataAttrs,
  videoMetaFromData,
  writeFrameSvg,
  writeManifest,
  writeStillPng,
} from './media.js'
import {
  ARROW_KINDS,
  DASH_KINDS,
  DEFAULT_EDGE_STYLE,
  DEFAULT_FONT,
  DEFAULT_NODE_STYLE,
  DEFAULT_STROKE,
  DEFAULT_VIDEO_POSTER,
  NODE_SHAPES,
  NODE_SHAPE_STYLE,
  PALETTE,
  SIDES,
  SVG_IMAGE_VALUE_PREFIX_B64,
  arrowFromStyle,
  avoidFromStyle,
  routingModeOf,
  styleWithRoutingMode,
  colorNameFromStyle,
  colorsFromStyle,
  dashFromStyle,
  edgeStyleValueFromStyle,
  formatStyle,
  imageValueFromStyle,
  isRasterDataUri,
  isSvgDataUri,
  isSvgMarkup,
  isVideoNodeData,
  jettyFromStyle,
  lineKindFromStyle,
  nodeShapeFromStyle,
  normalizeDrawioDoc,
  normalizePoints,
  parseStyle,
  reportNodeShape,
  sideFromStyle,
  styleWithArrow,
  styleWithAvoid,
  styleWithColorName,
  styleWithDash,
  styleWithJetty,
  styleWithLineKind,
  styleWithNodeShape,
  styleWithSide,
  styleWithSvgMarkup,
  styleWithMediaMarkup,
  styleWithTextColorName,
  styleWithoutSvgMarkup,
  svgMarkupFromImageValue,
  svgMarkupFromStyle,
  textColorNameFromStyle,
  stylePatch,
  styleGet,
} from './style-kernel.js'

/**
 * 列目录走 Node 标准库。
 *
 * 为什么不用 ctx.fs：实测这个 DSH 版本的 ctx.fs **既没有 list 也没有 readRelated**
 * （诊断原话："ctx.fs 没有 list 方法 / ctx.fs 没有 readRelated 方法"）——
 * 我先后猜过这两个 API，都错了。插件本来就跑在宿主进程里，stdlib 一定可用。
 *
 * 沙箱围栏不受影响：**写盘**仍然全部走 ctx.fs.writeText（带策略），
 * 这里只做"列目录"这一件读操作。
 */
const nodeReaddir = readdir

/** 把可能相对的路径归一成绝对路径（宿主工作目录兜底）。 */
function toAbsolute(p, cwd) {
  const s = String(p === undefined || p === null ? '' : p)
  if (isAbsolute(s)) return s
  return joinPath(cwd === undefined || cwd === null || cwd.length === 0 ? process.cwd() : cwd, s)
}

const DEFAULT_PATH = 'demo.drawai'
const DEFAULT_W = 170
/** 缺省高度取**整格**（10px 的倍数）：否则节点中心会落在半像素上，连线容易出现"差一像素"的台阶。 */
const DEFAULT_H = 60
const GAP_PRIMARY = 90
const GAP_CROSS = 40
const documentRouter = createOrthogonalRouter(getRoutingRuntime)
const LAYOUTS = ['dagre-lr', 'dagre-tb', 'grid', 'none']
/** `order` 的四种去向（与画布右键的顺序菜单同一套：后面的在上面）。 */
const ORDER_MODES = ['front', 'back', 'up', 'down']
/** `duplicate` 的默认位移：两格 —— 与画布上 Ctrl+V 同一套（不然复制出来的正好压在原图上）。 */
const DUPLICATE_OFFSET = 20

/**
 * 工具语言 vs 文档语言 —— 这是本次改造最容易被误读的一条界线。
 *
 * **文档里存的是 drawio 的 style 键**（`dashed=1`、`dashPattern=8 8`、`edgeStyle=orthogonalEdgeStyle`、
 * `jettySize=auto`、`libavoidRouting=1`、`exitX/exitY/entryX/entryY`、`endArrow/startArrow`、
 * `fillColor/strokeColor`、`shape=`/`rounded=`/`arcSize=`…），默认值一律省略，
 * 认不出的键原样保留（开放集合）。这一切由 ../src/style-kernel.js 负责，宿主与客户端共用。
 *
 * **下面这几个枚举只是工具语言**（给模型用的糖）：AI 说"改成虚线""双向箭头""黄色"
 * 不该被迫拼 style 串。它们**绝不落盘**——由本文件翻译成上面的键。
 * drawio 自己也是这个分工：面板上给的是名字，文档里只有 fillColor/strokeColor。
 *
 * 旧的立场（"存语义、渲染参数属于客户端"）已按需求废弃：现在渲染参数就是文档的一部分，
 * 换主题/调间距会改文档 —— 与 drawio 一致。
 */
const DASHES = DASH_KINDS
const ARROWS = ARROW_KINDS

/** 容忍模型的口语说法：只为降低"op 被拒"的概率，落盘前一律归一成上面那几个枚举值。 */
function normalizeDash(value) {
  const v = String(value).toLowerCase().trim()
  if (v === 'solid' || v === 'line' || v === 'normal' || v === '实线') return 'solid'
  if (v === 'dashed' || v === 'dash' || v === '虚线') return 'dashed'
  if (v === 'dotted' || v === 'dot' || v === '点线' || v === '点状') return 'dotted'
  return null
}

function normalizeArrow(value) {
  const v = String(value).toLowerCase().trim()
  if (v === 'end' || v === 'forward' || v === 'target' || v === '单向') return 'end'
  if (v === 'both' || v === 'bidirectional' || v === '双向' || v === 'double') return 'both'
  if (v === 'none' || v === 'false' || v === '无') return 'none'
  if (v === 'start' || v === 'backward' || v === 'source' || v === '反向') return 'start'
  return null
}

/**
 * 线型四选一：直线 / 直角折线 / 圆角折线 / 曲线。
 *
 * 模型可能说 "elbow"/"orthogonal"/"折线"（= 直角折线）或 "rounded"/"圆角"/"圆角折线"
 * （= 只在折点处倒角），都归一到内核的 `styleWithLineKind` 认得的那四个值上。
 */
function normalizeLineKind(value, where) {
  const v = String(value).toLowerCase().trim()
  if (v === 'straight' || v === 'line' || v === 'direct' || v === '直线') return 'straight'
  if (v === 'sharp' || v === 'orthogonal' || v === 'elbow' || v === '折线' || v === '正交' || v === '直角折线') return 'sharp'
  if (v === 'rounded' || v === 'round' || v === '圆角' || v === '圆角折线') return 'rounded'
  if (v === 'curved' || v === 'curve' || v === 'arc' || v === '曲线' || v === '弧线') return 'curved'
  throw new Error(where + ': unknown line "' + value + '"; use straight, sharp, rounded, curved')
}

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

// json 参数在工具 schema 里编译成 `{}`（没有类型约束），有的模型/宿主会把它当成字符串送进来，
// 比如 frames 收到的是 "[0, 120]"。这里统一还原一次：看起来像 JSON 且解析成功就用解析结果，
// 否则原样返回。不这么做的话，Array.isArray(字符串) 恒为假，参数会被静默忽略、退回默认值。
function jsonValue(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || !'[{"]-0123456789ntf'.includes(text[0])) return value
  try { return JSON.parse(text) } catch { return value }
}

function jsonObject(value) {
  const parsed = jsonValue(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function jsonArray(value) {
  const parsed = jsonValue(value)
  return Array.isArray(parsed) ? parsed : []
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** 单字符显示宽度：CJK / 全角按一倍字宽，其余按 0.55 倍（近似 Helvetica）。 */
function charWidth(ch, size) {
  const code = ch.codePointAt(0)
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  return wide ? size : size * 0.55
}

/**
 * 按标签估算节点宽度并夹在 [130, 300]，避免模型手算尺寸。
 *
 * 结果**向上取整到整格（10px）**：与画布的移动/缩放单位一致。宽度不是整格时，
 * 节点中心会落在半像素上，连线就会多出"差一像素"的台阶。
 */
function estimateWidth(label) {
  const chars = Array.from(String(label))
  let w = 34
  for (let i = 0; i < chars.length; i += 1) w += charWidth(chars[i], 12)
  if (w < 130) return 130
  if (w > 300) return 300
  return Math.ceil(w / 10) * 10
}

/** 读一个"绝对点"参数（addEdge 的自由端点）。缺省 null；给了但形状不对直接报错。 */
function edgePointFromOp(value, where) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(where + ' must be {x, y}')
  const x = Number(value.x)
  const y = Number(value.y)
  if (Number.isFinite(x) === false || Number.isFinite(y) === false) throw new Error(where + ' needs finite x and y')
  return { x: x, y: y }
}

/** 精确折点严格校验；不做取整、吸附或静默过滤。 */
function edgeWaypointsFromOp(value, where) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error(where + ' points must be an array of at most 1000 {x, y} points')
  return value.map((point, index) => {
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' ||
      !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(where + ' points[' + index + '] needs finite numeric x and y')
    return { x: point.x, y: point.y }
  })
}

function setExplicitWaypoints(edge, value, where) {
  edge.points = edgeWaypointsFromOp(value, where)
  edge.style = stylePatch(styleWithRoutingMode(edge.style || DEFAULT_EDGE_STYLE, 'manual'), { drawaiRouteStatus: null })
}

/** 扫描 `<prefix><n>` 形式的 id，返回 max+1。 */
function nextId(list, prefix) {
  let max = 0
  const re = new RegExp('^' + prefix + '(\\d+)$')
  for (let i = 0; i < list.length; i += 1) {
    const m = re.exec(String(list[i].id))
    if (m !== null) {
      const n = parseInt(m[1], 10)
      if (n > max) max = n
    }
  }
  return prefix + (max + 1)
}

function emptyDoc() { return emptyDocument() }
function normalizeDoc(raw) { return normalizeDocument(raw) }

/** 节点位置快照，用于判断一次布局到底动没动端点。 */
function nodePositions(doc) {
  const map = Object.create(null)
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    map[n.id] = { x: numberOr(n.x, 0), y: numberOr(n.y, 0), w: numberOr(n.w, 0), h: numberOr(n.h, 0) }
  }
  return map
}

/**
 * 布局改变端点后，只失效引擎拥有的自动路线。
 *
 * 这是 v1 的一个真实缺口：宿主半边当时**完全不知道 `points` 存在**（零读写），
 * 于是 AI 一重排，盘上就留下一堆飘在旧位置上的折点，而没有任何清理或标记。
 * 自动折点属于路由缓存；手动折点和悬空端落点始终属于用户，不在此处清除。
 *
 * @returns 被清理的边数
 */
function invalidateStalePoints(doc, before) {
  const now = nodePositions(doc)
  let dropped = 0
  for (let i = 0; i < doc.edges.length; i += 1) {
    const edge = doc.edges[i]
    if (routingModeOf(edge) !== 'auto') continue
    if (edge.points === undefined && edge.sourcePoint === undefined && edge.targetPoint === undefined) continue
    const moved = function (id) {
      const prev = before[id]
      const cur = now[id]
      if (prev === undefined || cur === undefined) return prev !== cur
      return prev.x !== cur.x || prev.y !== cur.y || prev.w !== cur.w || prev.h !== cur.h
    }
    if (!moved(edge.from) && !moved(edge.to)) continue
    delete edge.points
    edge.style = stylePatch(edge.style || '', { drawaiRouteStatus: null })
    dropped += 1
  }
  return dropped
}

/** 调色板名清单（错误文案用）。 */
function paletteNames() {
  const names = []
  for (let i = 0; i < PALETTE.length; i += 1) names.push(PALETTE[i].name)
  return names
}

/** 工具语言的 `keys`：值给 null 表示**删键**（回到 drawio 缺省）。 */
function styleKeysFromOp(keys, where) {
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error(where + ': "keys" must be an object like { fillColor: "#fff2cc", dashed: null }')
  }
  return keys
}

/**
 * 节点/边的 `style` 这个糖：既收调色板名（'yellow'），也收**一段 drawio style 串**
 * （`fillColor=#fff2cc;strokeColor=#d6b656`）。判据是"有没有 '=' 或 ';'"，
 * 两者都不像就报错 —— 绝不把垃圾写进文档。
 */
function styleValueFromOp(style, value, where) {
  if (value.indexOf('=') >= 0 || value.indexOf(';') >= 0) {
    return formatStyle(Object.assign(parseStyle(style), parseStyle(value)))
  }
  const named = styleWithColorName(style, value)
  if (named === style && colorNameFromStyle(style) !== value) {
    throw new Error(
      where + ': unknown style "' + value + '"; use a palette name (' + paletteNames().join(', ') +
        ') or a drawio style string like "fillColor=#fff2cc;strokeColor=#d6b656"',
    )
  }
  return named
}

/** 边上的 `style` 糖：调色板名 → `strokeColor`（drawio 里连线的颜色就是 strokeColor）。 */
function edgeStyleValueFromOp(style, value, where) {
  if (value.indexOf('=') >= 0 || value.indexOf(';') >= 0) {
    return formatStyle(Object.assign(parseStyle(style), parseStyle(value)))
  }
  for (let i = 0; i < PALETTE.length; i += 1) {
    if (PALETTE[i].name !== value) continue
    return stylePatch(style, { strokeColor: value === 'plain' ? null : PALETTE[i].stroke })
  }
  throw new Error(
    where + ': unknown style "' + value + '"; use a palette name (' + paletteNames().join(', ') +
      ') or a drawio style string like "dashed=1;dashPattern=8 8"',
  )
}

/** 进出侧：'n'/'e'/'s'/'w'（也容忍 north/east/… 与中文），空值 = 清掉约束。 */
function normalizeSide(value, where) {
  if (value === null || value === undefined || value === '') return null
  const v = String(value).toLowerCase().trim()
  if (v === 'n' || v === 'north' || v === 'top' || v === '上') return 'n'
  if (v === 'e' || v === 'east' || v === 'right' || v === '右') return 'e'
  if (v === 's' || v === 'south' || v === 'bottom' || v === '下') return 's'
  if (v === 'w' || v === 'west' || v === 'left' || v === '左') return 'w'
  throw new Error(where + ': unknown side "' + value + '"; use ' + SIDES.join(', '))
}

/**
 * `fontColor` 糖 → drawio 的 `fontColor` 键值。
 *
 * 三种写法都收（与画布上"文字换色"那一套对齐）：
 *   · 调色板名（plain/blue/red…）→ 取**文字色**那一支（`styleWithTextColorName`，与独立文字的
 *     配色落点是同一个值，否则同一个名字在菜单里和 AI 手里会是两种颜色）；
 *   · 任何别的非空字符串（`#b85450`、`rgb(...)`、CSS 名）→ 原样写（drawio 也是原样存）；
 *   · `null` / 空串 → 删键回缺省（drawio 缺省是黑字）。
 */
function fontColorValue(raw, where) {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (text.length === 0) return null
  const names = paletteNames()
  if (names.indexOf(text) >= 0) {
    const probe = styleWithTextColorName(DEFAULT_NODE_STYLE, text)
    const hex = styleGet(probe, 'fontColor', null)
    // 'plain' 就是"回缺省字色" = 删键。
    return hex === null ? null : hex
  }
  if (where !== undefined && /^[a-z]+$/i.test(text)) {
    // 纯字母但不在调色板里：多半是把颜色名写错了（'gren'）。报错比静默写一个 drawio 不认的字面值好。
    throw new Error(where + ': unknown font color "' + text + '"; use a palette name (' + names.join(', ') + ') or a hex value like #b85450')
  }
  return text
}

/**
 * 派生给模型看的**字色**：命中调色板就给名字（AI 好读），认不出的十六进制给原值。
 * 缺省黑字（没写键、或写的就是缺省）返回 undefined —— 与派生 color 的规矩一致（缺省不报）。
 */
function fontColorFieldOf(style) {
  const name = textColorNameFromStyle(style)
  if (name !== null && name !== 'plain') return name
  const raw = styleGet(style, 'fontColor', null)
  if (raw !== null && raw !== DEFAULT_FONT) return raw
  return undefined
}

/**
 * SVG 节点的缺省尺寸：**正方形**。
 *
 * 为什么不用 estimateWidth：那个是按标签文字估的，而 svg 节点的内容是图不是字
 * （标签通常是空的），照文字估出来会是 130×60 这种横长条，任何图标放进去都被压扁。
 */
const DEFAULT_SVG_W = 80
const DEFAULT_SVG_H = 80
const DEFAULT_VIDEO_W = DEFAULT_MEDIA_W
const DEFAULT_VIDEO_H = DEFAULT_MEDIA_H

/** 只碰旁路媒体、不改 .drawio 的 ops（单独出现时不写盘、不重排）。 */
const MEDIA_SIDE_OPS = {
  listFrames: true,
  getFrame: true,
  setFrame: true,
  appendFrames: true,
  extractFrames: true,
  traceFrame: true,
  exportSvgVideo: true,
  exportMediaSource: true,
}

function resolveVideoNode(doc, id, where) {
  for (let i = 0; i < doc.nodes.length; i += 1) {
    if (String(doc.nodes[i].id) !== String(id)) continue
    const meta = videoMetaFromData(doc.nodes[i].data)
    if (meta === null || meta.clip === null) {
      throw new Error(where + ': node "' + id + '" is not a video node (missing drawaiMedia/mediaClip)')
    }
    return { node: doc.nodes[i], meta: meta, index: i }
  }
  throw new Error(where + ': unknown node "' + id + '"')
}

/**
 * 一段内嵌 SVG 标记的长度上限。超了直接拒：一个单元格几十万字符会把文件和上下文一起撑爆。
 *
 * 为什么是 250000：**这是整图矢量化精细度的直接瓶颈**。实测一张 1024×1536 的立绘，
 * grid 800 的原始产出就要 249630 字符 —— 卡在 60000 时管线只能压掉 5.4 倍（eps 抬到 3.2、
 * 小环大量丢弃，环保留从 10235 掉到 2049），于是"脸和细节糊"就成了必然。
 * 放到 250000：同一张图 grid 1000 只压 2 次、环保留 5455（翻 2.7 倍）。
 * 再往上（不压缩约 327000 字符）文件会到 440KB/节点、读回时上下文开销约 8~9 万 token，
 * 收益递减，所以停在 250000。要更细请用 cropX/cropY/cropW/cropH 做局部（那不受这个上限的边际影响）。
 */
const SVG_MARKUP_LIMIT = 250000
/** traceImage 能读的图片字节上限（够任何截图，又不至于让一次调用把宿主内存吃干）。 */
const TRACE_IMAGE_MAX_BYTES = 32 * 1024 * 1024
/** diagram_read 里回显 svg 的长度上限（超了截断并注明总长）。 */
const SVG_REPORT_LIMIT = 4000

/** 报告里"被省略的 image= 值"的标记。带这个标记的 style 写回来会被拦下。 */
const SVG_STYLE_ELISION = '«svg '
const IMAGE_STYLE_ELISION = '«image '

/**
 * 从 style 里取出内嵌的 SVG 标记（读取用）：百分号编码的直接解，
 * base64 形态的用 Buffer 解（内核不许碰环境全局，所以这一步只能在宿主这边做）。
 */
function svgMarkupForReport(style) {
  const direct = svgMarkupFromStyle(style)
  if (direct !== null) return direct
  const value = imageValueFromStyle(style)
  if (value === null || value.indexOf(SVG_IMAGE_VALUE_PREFIX_B64) !== 0) return undefined
  try {
    return Buffer.from(value.slice(SVG_IMAGE_VALUE_PREFIX_B64.length), 'base64').toString('utf8')
  } catch (error) {
    return undefined
  }
}

/**
 * 报告里的 style 串：内嵌的 SVG / 位图 data URI **不重复回显**。
 *
 * 为什么要省：data URI 动辄几千到几百万字符，一张画布上几张图就能把一次 diagram_read
 * 撑爆；SVG 的内容在 svg 字段里，位图只报 shape:"image"（不把 base64 塞进上下文）。
 * 只做**字符串级替换**（不重新拼 style），其余键一个字节都不动。
 */
function styleForReport(style) {
  const value = imageValueFromStyle(style)
  if (value === null) return style
  const literal = 'image=' + value
  if (style.indexOf(literal) < 0) return style
  if (isSvgDataUri(value)) {
    const markup = svgMarkupForReport(style)
    const size = markup === undefined ? value.length : markup.length
    return style.split(literal).join('image=' + SVG_STYLE_ELISION + size + ' 字符»')
  }
  if (isRasterDataUri(value)) {
    return style.split(literal).join('image=' + IMAGE_STYLE_ELISION + value.length + ' 字符»')
  }
  return style
}

/**
 * 护栏：报告里被省略过的 style 不许原样写回。
 *
 * 模型看到的是 `image=«svg 312 字符»` / `«image …»`，照抄回来就会把那个占位串写进文件 ——
 * 那一格从"有图"变成"什么都没有"，而且**不报任何错**。所以在入口就拦下来。
 */
function assertNoStyleElision(text, where) {
  if (typeof text === 'string' && (text.indexOf(SVG_STYLE_ELISION) >= 0 || text.indexOf(IMAGE_STYLE_ELISION) >= 0)) {
    throw new Error(
      where + ': 这段 style 里的 image= 是 diagram_read **省略过**的，不能原样写回。' +
        '改 SVG 内容用 "svg" 参数（整段标记）；位图请在画布里粘贴/拖入；改配色/字号用 style 的调色板名或 keys。',
    )
  }
}

/**
 * 节点样式：`shape` / `style` / `keys` 三种糖统一落成 drawio style 键。
 * rect 落成**空串** —— drawio 的 `defaultVertexStyle = {}`，普通矩形就是"没有 shape 键"。
 */
function nodeStyleFromOp(style, op, where) {
  let out = style === undefined || style === null ? DEFAULT_NODE_STYLE : String(style)
  assertNoStyleElision(op.style, where)
  assertNoStyleElision(op.keys === undefined || op.keys === null ? '' : JSON.stringify(op.keys), where)
  if (typeof op.shape === 'string') {
    if (!Object.prototype.hasOwnProperty.call(NODE_SHAPE_STYLE, op.shape)) {
      throw new Error(where + ': unknown shape "' + op.shape + '"; use ' + NODE_SHAPES.join(', '))
    }
    out = styleWithNodeShape(out, op.shape)
  }
  // 内嵌 SVG 内容（形状枚举里的 `svg`）：内容与形状一起落成 image 形态。
  // `svg: null` = 清掉内容、回到矩形（与"把图片删掉"同一件事）。
  if (has(op, 'svg')) {
    if (op.svg === null) out = styleWithoutSvgMarkup(out)
    else if (typeof op.svg !== 'string' || isSvgMarkup(op.svg) === false) {
      throw new Error(where + ': "svg" 要是一段 SVG 标记文本（必须含 <svg …>），例如 "<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'><circle cx=\'12\' cy=\'12\' r=\'9\'/></svg>"')
    } else if (op.svg.length > SVG_MARKUP_LIMIT) {
      throw new Error(where + ': "svg" 太长了（' + op.svg.length + ' 字符 > ' + SVG_MARKUP_LIMIT + '）：请精简图形，或改用形状 + 标签拼')
    } else {
      // 已经显式设过 imageAspect 就尊重它（等比/拉伸是画法，不该被内容覆盖）。
      out = styleWithSvgMarkup(out, op.svg, styleGet(out, 'imageAspect', '0'))
    }
  }
  // 只给 shape:"svg" 却没有任何内容 —— 那会得到一个看不见的空框。直接说清楚要什么。
  if (op.shape === 'svg' && nodeShapeFromStyle(out) !== 'svg') {
    throw new Error(where + ': shape "svg" 还要一起给内容 —— "svg": "<svg …>…</svg>"（形状本身决定不了画什么）')
  }
  // video：style 层是海报 SVG；没给 svg 时塞缺省播放按钮海报。
  if (op.shape === 'video' && nodeShapeFromStyle(out) !== 'svg') {
    out = styleWithSvgMarkup(out, DEFAULT_VIDEO_POSTER, '0')
  }
  if (typeof op.style === 'string' && op.style.length > 0) {
    // 文字元素（独立文字）没有填充与描边：给它调色板名要落到 **fontColor** 上，
    // 否则 AI 说 style:"red"、屏幕上一个像素都不变（而且文件里还多两个没用的键）。
    if (nodeShapeFromStyle(out) === 'text' && op.style.indexOf('=') < 0 && op.style.indexOf(';') < 0) {
      const named = styleWithTextColorName(out, op.style)
      if (named === out && textColorNameFromStyle(out) !== op.style) {
        throw new Error(
          where + ': unknown style "' + op.style + '"; use a palette name (' + paletteNames().join(', ') + ') for the text color',
        )
      }
      out = named
    } else {
      out = styleValueFromOp(out, op.style, where)
    }
  }
  // 字号：`fontSize` 是 drawio 的键，节点标签与独立文字都吃它（null = 删键回缺省）。
  if (has(op, 'fontSize')) out = stylePatch(out, { fontSize: op.fontSize === null ? null : String(op.fontSize) })
  // 字色：`fontColor`（节点标签、独立文字都吃它）。调色板名按"文字换色"那一套取色。
  if (has(op, 'fontColor')) out = stylePatch(out, { fontColor: fontColorValue(op.fontColor, where + ' fontColor') })
  if (has(op, 'keys')) out = stylePatch(out, styleKeysFromOp(op.keys, where))
  return out
}

/** Remove only the inline properties overridden by a whole-node text change. */
export function clearRichTextOverrides(html, options = {}) {
  if (typeof html !== 'string' || (!options.color && !options.size)) return html
  const fragment = parseHtmlFragment(html)
  let changed = false
  const visit = node => {
    if (Array.isArray(node.attrs)) {
      if (node.tagName === 'font') {
        const before = node.attrs.length
        node.attrs = node.attrs.filter(attr => !(options.color && attr.name === 'color') && !(options.size && attr.name === 'size'))
        changed ||= node.attrs.length !== before
      }
      const attr = node.attrs.find(item => item.name === 'style')
      if (attr) {
        let rule
        try {
          const parsed = postcss.parse('x{' + attr.value + '}')
          if (parsed.nodes.length !== 1 || parsed.first.type !== 'rule' || parsed.first.nodes.some(item => item.type !== 'decl' && item.type !== 'comment')) throw new Error('unsupported style')
          rule = parsed.first
        } catch { throw new Error('无法安全修改富文本中的 CSS 样式，请先在画布中编辑文字') }
        // CSS font shorthand also controls family/weight and cannot be dropped
        // without changing unrelated formatting. Do not silently destroy it.
        if (options.size && rule.nodes.some(item => item.type === 'decl' && item.prop.toLowerCase() === 'font')) {
          throw new Error('无法安全统一含 font 简写的富文本字号，请先在画布中编辑文字')
        }
        let cssChanged = false
        rule.walkDecls(decl => {
          const name = decl.prop.toLowerCase()
          if ((options.color && name === 'color') || (options.size && name === 'font-size')) { decl.remove(); cssChanged = true }
        })
        if (cssChanged) {
          changed = true
          attr.value = rule.nodes.map(item => item.toString()).join(';')
          if (!attr.value.trim()) node.attrs = node.attrs.filter(item => item !== attr)
        }
      }
    }
    for (const child of node.childNodes || []) visit(child)
    if (node.content) visit(node.content)
  }
  visit(fragment)
  return changed ? serializeHtml(fragment) : html
}

/**
 * 连线的"曲线"要看得见，就得有一个中点。
 *
 * drawio 的曲线是把**现有走线**抹圆（mxPolyline.paintCurvedLine）；两点直连时控制点落在起点上，
 * 于是退化成直线 —— 屏幕上什么都看不出来。所以给这种边补一个**垂直弓形的中点**，
 * 与人在画布上手动拖一个中点出来是同一件事（文件里就是普通的折点，drawio 打开一样）。
 *
 * 取两端落点：连着节点用节点中心，悬空端用自由点。弓高 = 长度的 12%，至少 20px，吸附到半格。
 */
function arcWaypointFor(doc, edge) {
  const endOf = (which) => {
    const nodeId = which === 'source' ? edge.from : edge.to
    const free = which === 'source' ? edge.sourcePoint : edge.targetPoint
    if (typeof nodeId === 'string') {
      for (let i = 0; i < doc.nodes.length; i += 1) {
        const n = doc.nodes[i]
        if (String(n.id) !== nodeId) continue
        return { x: numberOr(n.x, 0) + numberOr(n.w, DEFAULT_W) / 2, y: numberOr(n.y, 0) + numberOr(n.h, DEFAULT_H) / 2 }
      }
    }
    if (free !== null && free !== undefined && Number.isFinite(Number(free.x)) && Number.isFinite(Number(free.y))) {
      return { x: Number(free.x), y: Number(free.y) }
    }
    return null
  }
  const a = endOf('source')
  const b = endOf('target')
  if (a === null || b === null) return null
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (!(len > 1)) return null
  const unit = 5 // 与画布一致：折点的最小单位是半格
  const bow = Math.max(20, Math.round((len * 0.12) / unit) * unit)
  return {
    x: Math.round(((a.x + b.x) / 2 - (dy / len) * bow) / unit) * unit,
    y: Math.round(((a.y + b.y) / 2 + (dx / len) * bow) / unit) * unit,
  }
}

/**
 * 边的画法糖：线型 / 箭头 / 颜色 / 进出侧 / 桩点长度 / 路由方式 / 避让，
 * 全部翻成 drawio 的 style 键（`dashed`、`dashPattern`、`endArrow`、`strokeColor`、
 * `exitX/exitY/entryX/entryY`、`jettySize`、`edgeStyle`、`libavoidRouting`）。
 */
function edgeStyleFromOp(style, op, where) {
  let out = style === undefined || style === null ? DEFAULT_EDGE_STYLE : String(style)
  assertNoStyleElision(op.style, where)
  assertNoStyleElision(op.keys === undefined || op.keys === null ? '' : JSON.stringify(op.keys), where)
  if (typeof op.dash === 'string') {
    const dash = normalizeDash(op.dash)
    if (dash === null) throw new Error(where + ': unknown dash "' + op.dash + '"; use ' + DASHES.join(', '))
    out = styleWithDash(out, dash)
  }
  if (typeof op.arrow === 'string') {
    const arrow = normalizeArrow(op.arrow)
    if (arrow === null) throw new Error(where + ': unknown arrow "' + op.arrow + '"; use ' + ARROWS.join(', '))
    out = styleWithArrow(out, arrow)
  }
  if (typeof op.color === 'string') out = stylePatch(out, { strokeColor: op.color.length === 0 ? null : op.color })
  if (has(op, 'exit')) out = styleWithSide(out, 'source', normalizeSide(op.exit, where + ' exit'))
  if (has(op, 'entry')) out = styleWithSide(out, 'target', normalizeSide(op.entry, where + ' entry'))
  if (has(op, 'jettySize')) out = styleWithJetty(out, op.jettySize === null ? null : String(op.jettySize))
  // 线型糖：直线 / 折线 / 曲线（drawio 的 Straight / Orthogonal / Curved 三个键组合）。
  // `edgeStyle`（orthogonalEdgeStyle|none）仍然保留 —— 它是键级的写法，line 是它的语义写法。
  if (has(op, 'line')) out = styleWithLineKind(out, normalizeLineKind(op.line, where))
  if (typeof op.edgeStyle === 'string') out = stylePatch(out, { edgeStyle: op.edgeStyle })
  if (has(op, 'avoid')) out = styleWithAvoid(out, op.avoid === true)
  // 字号：连线的文字（边自己的 value 与挂在边上的标签单元）都是 `fontSize`。
  if (has(op, 'fontSize')) out = stylePatch(out, { fontSize: op.fontSize === null ? null : String(op.fontSize) })
  // 字色：连线上的文字（边自己的 value、以及挂在边上的标签单元）都吃 `fontColor`。
  if (has(op, 'fontColor')) out = stylePatch(out, { fontColor: fontColorValue(op.fontColor, where + ' fontColor') })
  if (typeof op.style === 'string' && op.style.length > 0) out = edgeStyleValueFromOp(out, op.style, where)
  if (has(op, 'keys')) out = stylePatch(out, styleKeysFromOp(op.keys, where))
  return out
}

/** 一行摘要：把 style 串翻成人话，给 notes / render 用（只报与缺省不同的部分）。 */
function styleNote(style) {
  const bits = []
  const dash = dashFromStyle(style)
  if (dash !== 'solid') bits.push(dash)
  const arrow = arrowFromStyle(style)
  if (arrow === 'both') bits.push('both arrows')
  else if (arrow === 'none') bits.push('no arrow')
  else if (arrow === 'start') bits.push('reverse arrow')
  const name = colorNameFromStyle(style)
  if (name !== null && name !== 'plain') bits.push(name)
  const exit = sideFromStyle(style, 'source')
  const entry = sideFromStyle(style, 'target')
  if (exit !== null || entry !== null) bits.push((exit === null ? '?' : exit) + '->' + (entry === null ? '?' : entry))
  const jetty = jettyFromStyle(style)
  if (jetty !== null) bits.push('jetty ' + jetty)
  if (edgeStyleValueFromStyle(style) === 'none') bits.push('straight')
  if (avoidFromStyle(style)) bits.push('avoid')
  return bits.length === 0 ? '' : ' [' + bits.join(', ') + ']'
}

/**
 * 解析 traceImage 的裁剪矩形（cropX / cropY / cropW / cropH，都相对原图像素坐标）。
 *
 * 为什么要裁剪：矢量化的工作分辨率上限由 grid（默认 499px 宽）决定 —— 整张图画进去时，
 * 一张 1024 宽的立绘里"脸"只有约 38px 宽、眼睛 3~4px，量化后五官必然消失。
 * 裁出局部再描，同一块区域就占满工作图宽度，脸能有 190px —— 这是唯一能真正改善
 * "面部特征缺失"的手段（调 colors / protectLuma 都无效：已经实测扫过参数）。
 *
 * 只写 cropW/cropH 时默认从左上角裁；一个字段都不给 = 整图（返回 null）。
 * 裁剪后的 SVG viewBox 会平移回原图像素系，所以节点位置仍与原图对齐。
 */
function traceCropRect(op, where) {
  const given = ['cropX', 'cropY', 'cropW', 'cropH'].filter((key) => has(op, key))
  if (given.length === 0) return null
  const box = {
    x: Math.round(numberOr(op.cropX, 0)),
    y: Math.round(numberOr(op.cropY, 0)),
    w: Math.round(numberOr(op.cropW, 0)),
    h: Math.round(numberOr(op.cropH, 0)),
  }
  if (box.w <= 0 || box.h <= 0) {
    throw new Error(
      where + ': 裁剪区域要给出正数 cropW / cropH（当前 ' + box.w + '×' + box.h +
        '）；cropX / cropY 缺省为 0（左上角）。只给 cropX/cropY 不是裁剪，给全 cropX/cropY/cropW/cropH。',
    )
  }
  if (box.x < 0 || box.y < 0) {
    throw new Error(where + ': cropX / cropY 不能是负数（当前 ' + box.x + ',' + box.y + '）')
  }
  return box
}

/** 裁出 raster 的 [x, x+w) × [y, y+h) 一块（RGBA8，逐行拷）。越界会报错，不静默补白。 */
function cropRaster(raster, box, where) {
  if (box.x + box.w > raster.width || box.y + box.h > raster.height) {
    throw new Error(
      where + ': 裁剪区域超出图片范围（图片 ' + raster.width + '×' + raster.height +
        '，要裁 x=' + box.x + ' y=' + box.y + ' ' + box.w + '×' + box.h + '）',
    )
  }
  const out = new Uint8Array(box.w * box.h * 4)
  for (let row = 0; row < box.h; row += 1) {
    const from = ((box.y + row) * raster.width + box.x) * 4
    out.set(raster.data.subarray(from, from + box.w * 4), row * box.w * 4)
  }
  return { width: box.w, height: box.h, data: out }
}

/**
 * 施加 ops。语义校验在这里：任何指向不存在节点的边、任何未知 id，都直接抛错并列出已知节点，
 * 于是失败发生在写盘之前 —— 不会画出半张烂图。
 */
const documentCommands = createDocumentCommands({ ops: (draft, command) => executeOps(draft, command.ops, command.out, command.opctx) })

async function applyOps(doc, ops, out, opctx) {
  const transaction = await documentCommands.execute(doc, { type: 'ops', ops, out, opctx })
  for (const key of Object.keys(doc)) delete doc[key]
  Object.assign(doc, transaction.doc)
  return transaction.result
}

async function executeOps(doc, ops, out, opctx) {
  const notes = []
  /**
   * 本次调用里的**别名**（`addNode`/`addEdge` 的 `as`）。
   *
   * 为什么要有：id 省略时是自动分配的（n7、e3…），模型在**同一个 ops 数组**里没法引用
   * "刚建的那个" —— 只能猜下一个编号；画布上已经有 n1..n5 时就猜错，只能等报错再重试。
   * 有了别名，`{op:'addNode', label:'开始', as:'start'}` 之后就能直接 `{op:'addEdge', from:'start'}`。
   */
  const aliases = new Map()
  /**
   * 本次调用真的建了/改了/删了哪些 id。
   *
   * 以前只有 summary 文本（"+ node n7 ..."）—— 模型要用这个 id 就得去解析自然语言。
   * 现在结构化回给它（`diagram_apply` 的 output schema 里有 created/changed/removed）。
   */
  const created = []
  const changed = []
  const removed = []
  function recordCreated(id, type, label) {
    for (let i = 0; i < created.length; i += 1) if (created[i].id === id) return
    created.push(typeof label === 'string' && label.length > 0 ? { id: id, type: type, label: label } : { id: id, type: type })
  }
  function recordChanged(id) {
    if (changed.indexOf(id) < 0) changed.push(id)
  }
  function findNode(id) {
    for (let i = 0; i < doc.nodes.length; i += 1) if (doc.nodes[i].id === id) return i
    return -1
  }
  function findEdge(id) {
    for (let i = 0; i < doc.edges.length; i += 1) if (doc.edges[i].id === id) return i
    return -1
  }
  /** 别名先解析成真 id（别名指"这次调用里刚建的那个"，不指别的东西）。 */
  function resolveId(raw) {
    return typeof raw === 'string' && aliases.has(raw) ? aliases.get(raw) : raw
  }
  function known() {
    const ids = []
    for (let i = 0; i < doc.nodes.length; i += 1) ids.push(doc.nodes[i].id)
    const base = ids.length === 0 ? '(none)' : ids.join(', ')
    if (aliases.size === 0) return base
    const pairs = []
    aliases.forEach((id, name) => pairs.push(name + '→' + id))
    return base + '（本次调用里的别名：' + pairs.join(', ') + '）'
  }
  /** 只涉及连线的 op 报错时列边不列节点（拿节点 id 去重接边时，看节点列表没有帮助）。 */
  function knownEdges() {
    const ids = []
    for (let i = 0; i < doc.edges.length; i += 1) ids.push(doc.edges[i].id)
    return ids.length === 0 ? '(none)' : ids.join(', ')
  }
  /**
   * `ids: [...]` 与 `id` 两种写法归一成一个数组（批量改样式/改标签/移动/删除都要）。
   *
   * 为什么值得有：用户说"把这几个换成绿色"时，AI 看到的是 12 个 id —— 逐个发 op 只是
   * 让模型多写 11 遍同样的参数，多一份写错的机会。
   */
  function idList(op, index, what) {    if (Array.isArray(op.ids) && op.ids.length > 0) {
      const ids = []
      for (let k = 0; k < op.ids.length; k += 1) {
        const v = op.ids[k]
        if (typeof v !== 'string' || v.length === 0) throw new Error('ops[' + index + '] ' + what + ': "ids" must be non-empty strings')
        ids.push(resolveId(v))
      }
      if (op.id !== undefined) throw new Error('ops[' + index + '] ' + what + ': give either "id" or "ids", not both')
      return ids
    }
    const one = typeof op.id === 'string' && op.id.length > 0 ? resolveId(op.id) : undefined
    if (one === undefined) throw new Error('ops[' + index + '] ' + what + ' needs string "id" or string array "ids"')
    return [one]
  }

  function layerList() {
    return Array.isArray(doc.layers) ? doc.layers : []
  }
  /** 报错时把可选项列出来（层名可能为空，那就报 id）。 */
  function layerDescription() {
    const list = layerList()
    if (list.length === 0) return '(没有图层信息)'
    const parts = []
    for (let i = 0; i < list.length; i += 1) {
      const l = list[i]
      const name = typeof l.name === 'string' && l.name.length > 0 ? l.name : '(无名)'
      parts.push(name + '#' + String(l.id) + (l.visible === false ? ' 🚫' : ''))
    }
    return parts.join(', ')
  }
  /**
   * 把"层 id 或层名"解析成层 id。
   *
   * 为什么两种都收：`diagram_read` 回的是层表（名字 + id），用户说"放到'标注'层"时模型手里
   * 只有名字，而文件里挂单元用的是 id。别名（`addLayer … as:"x"`）也在这里解析。
   */
  function resolveLayerRef(raw, where) {
    const ref = typeof raw === 'string' && aliases.has(raw) ? aliases.get(raw) : raw
    const list = layerList()
    if (list.length === 0) throw new Error(where + ': 这份文档没有图层信息（layers 为空）')
    for (let i = 0; i < list.length; i += 1) if (String(list[i].id) === ref) return String(list[i].id)
    for (let i = 0; i < list.length; i += 1) {
      const name = typeof list[i].name === 'string' ? list[i].name : ''
      if (name.length > 0 && name === ref) return String(list[i].id)
    }
    throw new Error(where + ': unknown layer "' + ref + '". Layers: ' + layerDescription())
  }
  /** 别名注册（addNode/addEdge/addLayer/duplicate 共用）：撞已有 id、已有层名、已用别名都直接报错。 */
  function registerAlias(name, id, where) {
    if (typeof name !== 'string' || name.length === 0) return
    if (aliases.has(name)) throw new Error(where + ': alias "' + name + '" is already used by ' + aliases.get(name))
    if (findNode(name) >= 0 || findEdge(name) >= 0) throw new Error(where + ': alias "' + name + '" collides with an existing id')
    const list = layerList()
    for (let i = 0; i < list.length; i += 1) {
      const layerName = typeof list[i].name === 'string' ? list[i].name : ''
      if (String(list[i].id) === name || (layerName.length > 0 && layerName === name)) {
        throw new Error(where + ': alias "' + name + '" collides with a layer')
      }
    }
    aliases.set(name, id)
  }

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new Error('ops[' + i + '] must be an object like { op: "addNode", label: "..." }')
    }
    const kind = op.op

    if (kind === 'traceImage') {
      // 在画布上"照着一张位图描一张矢量图"：把工作区里的图片逐像素矢量化，建成 svg 内容节点。
      //
      // 这一步要读像素（I/O），所以整条 applyOps 是 async 的 —— 别把它当成同步 op 来加。
      const where = 'ops[' + i + '] traceImage'
      const traceCrop = traceCropRect(op, where)
      if (opctx === undefined || opctx === null) throw new Error(where + ': 这个上下文不支持读图片（内部错误）')
      const rawImage = typeof op.image === 'string' && op.image.length > 0 ? op.image : undefined
      if (rawImage === undefined) {
        throw new Error(where + ' needs a non-empty string "image"（工作区里那张位图的路径，png/jpg/webp/gif）')
      }
      if (has(op, 'removeBg') === false) {
        throw new Error(
          where +
            ' 必须显式传 removeBg:true（抠背景）或 removeBg:false（保留背景）；不再支持 auto / 省略',
        )
      }
      const bytes = await opctx.readBytes(rawImage, where)
      let raster
      try {
        raster = await decodeRaster(bytes)
      } catch (error) {
        throw new Error(where + ': ' + messageOf(error))
      }
      // 裁剪：只把这一块交给矢量化，于是这块区域能占满整个工作分辨率（见 traceCropRect 的说明）。
      let tracedFrom = raster
      if (traceCrop !== null) {
        try {
          tracedFrom = cropRaster(raster, traceCrop, where)
        } catch (error) {
          throw new Error(where + ': ' + messageOf(error))
        }
      }
      // 显式字段覆盖预设：没写的键用 undefined，让 resolveTraceOptions / 默认值接手
      // 没给 maxBytes 时按上限走：细则由这个预算决定（预算越小，管线越要抬 epsilon、丢小环）
      const rawTraceBudget = has(op, 'maxBytes')
        ? numberOr(op.maxBytes, TRACE_DEFAULTS.maxBytes)
        : SVG_MARKUP_LIMIT - 2000
      const rawTrace = {
        preset: typeof op.preset === 'string' ? op.preset : TRACE_DEFAULTS.preset,
        colors: has(op, 'colors') ? op.colors : undefined,
        colorsDark: has(op, 'colorsDark') ? op.colorsDark : undefined,
        colorsFill: has(op, 'colorsFill') ? op.colorsFill : undefined,
        grid: has(op, 'grid') ? op.grid : undefined,
        gridH: has(op, 'gridH') ? op.gridH : undefined,
        scale: has(op, 'scale') ? op.scale : undefined,
        epsilon: has(op, 'epsilon') ? op.epsilon : undefined,
        precision: has(op, 'precision') ? op.precision : undefined,
        minArea: has(op, 'minArea') ? op.minArea : undefined,
        minRegionArea: has(op, 'minRegionArea') ? op.minRegionArea : undefined,
        protectLuma: has(op, 'protectLuma') ? op.protectLuma : undefined,
        majorityContrast: has(op, 'majorityContrast') ? op.majorityContrast : undefined,
        bgBright: has(op, 'bgBright') ? op.bgBright : undefined,
        bgTol: has(op, 'bgTol') ? op.bgTol : undefined,
        bgColor: has(op, 'bgColor') ? op.bgColor : undefined,
        removeBg: has(op, 'removeBg') ? op.removeBg : undefined,
        bgSolidTol: has(op, 'bgSolidTol') ? op.bgSolidTol : undefined,
        bgSolidBorderRatio: has(op, 'bgSolidBorderRatio') ? op.bgSolidBorderRatio : undefined,
        seeds: has(op, 'seeds') ? op.seeds : undefined,
        maxBytes: Math.min(rawTraceBudget, SVG_MARKUP_LIMIT - 2000),
      }
      // 清掉 undefined，避免 Object.assign 把预设盖成 undefined
      for (const key of Object.keys(rawTrace)) {
        if (rawTrace[key] === undefined) delete rawTrace[key]
      }
      let resolved
      try {
        resolved = resolveTraceOptions(rawTrace)
      } catch (error) {
        throw new Error(where + ': ' + messageOf(error))
      }
      const traced = await opctx.traceRaster(tracedFrom, resolved.options)
      const metrics = traced.metrics
      if (traced.svg.length > SVG_MARKUP_LIMIT) {
        throw new Error(
          where + ': 描出来的 SVG 太长（' + traced.svg.length + ' 字符，上限 ' + SVG_MARKUP_LIMIT +
            '）。调小 grid（当前 ' + metrics.work.width + '）、调大 epsilon、减少 colors，或 preset:"simple"。' +
            (metrics.tuneHint ? ' 建议：' + metrics.tuneHint : ''),
        )
      }
      // 尺寸：默认 1:1（画布坐标 = 原图像素坐标），w/h 显式给了就用给的。
      //
      // 裁剪块的 SVG 里路径坐标是**裁剪局部**的（viewBox = 0 0 cropW cropH）—— 别去平移 viewBox：
      // 路径不会跟着走，内容会整体跑出可视区。默认节点框使用裁剪块原始尺寸，
      // 与 cropX/cropY 配合按原图像素 1:1 放置；显式 w/h 表示裁剪块的目标尺寸。
      const w = numberOr(op.w, tracedFrom.width)
      const h = numberOr(op.h, tracedFrom.height)
      const synthetic = {
        op: 'addNode',
        svg: traced.svg,
        w: w,
        h: h,
        keys: { imageAspect: 0 }, // 拉伸铺满：局部 viewBox 按节点框等比铺开
      }
      if (typeof op.id === 'string') synthetic.id = op.id
      if (typeof op.as === 'string') synthetic.as = op.as
      if (typeof op.layer === 'string') synthetic.layer = op.layer
      if (typeof op.label === 'string') synthetic.label = op.label
      if (has(op, 'x')) synthetic.x = op.x
      if (has(op, 'y')) synthetic.y = op.y
      // 裁剪块没给坐标时，落在原图里它该在的位置（否则会堆到原点压住整图）
      if (traceCrop !== null && has(op, 'x') === false) synthetic.x = traceCrop.x
      if (traceCrop !== null && has(op, 'y') === false) synthetic.y = traceCrop.y
      // 就地插一条 addNode 紧随其后（读像素是 async 的，所以这条 op 不能在解析参数时先展开）。
      // 注意：这里改的必须是**我们自己那份** ops —— 调用方（execute）已经 slice 过，
      // 因为宿主给的 arguments 是深冻结的，直接 splice 会抛 "object is not extensible"。
      ops.splice(i + 1, 0, synthetic)
      // 节点 id：显式 id / as 别名会在下一条 addNode 里落地；这里先记 as 或 id 方便回执
      const nodeRef = typeof op.id === 'string' ? op.id : typeof op.as === 'string' ? op.as : undefined
      if (traceCrop !== null) metrics.crop = { x: traceCrop.x, y: traceCrop.y, w: traceCrop.w, h: traceCrop.h }
      if (out !== undefined && out !== null) {
        if (!Array.isArray(out.trace)) out.trace = []
        out.trace.push(summarizeTraceForAi(metrics, { image: rawImage, nodeId: nodeRef }))
      }
      notes.push(
        '🖼 ' + rawImage +
          (traceCrop === null ? '' : ' 裁剪 ' + traceCrop.w + '×' + traceCrop.h + '@' + traceCrop.x + ',' + traceCrop.y) +
          ' → 逐像素矢量化 preset=' + metrics.preset + '：' +
          metrics.palette.length + ' 色 / ' + metrics.paths + ' 条 path / ' +
          metrics.loopsKept + ' 个轮廓环 / ' + metrics.svgChars + ' 字符' +
          '（工作图 ' + metrics.work.width + '×' + metrics.work.height +
          ', scale ' + metrics.scaleApplied +
          (metrics.sizeNotes ? '; ' + metrics.sizeNotes : '') +
          '，量化图轮廓' +
          (metrics.exactPixelCoverage === true ? '无损' : '已简化/删减') +
          '，丢弃 ' + metrics.loopsDropped + ' 个环' +
          (metrics.attempts > 1 ? '，预算降级 epsilon=' + metrics.appliedEpsilon : '') +
          (metrics.budgetExceeded ? '，仍超请求预算' : '') +
          '）' +
          (metrics.tuneHint ? '\n   调参：' + metrics.tuneHint : ''),
      )
      continue
    }

    if (kind === 'addNode') {
      // 标签在 drawio 里是可选的（`value=""` = 没有文字的单元）。装饰面板 / 底框 /
      // 内嵌 SVG 都可以省 label 或给 ""；没给就当空串。给了就必须是 string。
      let label = ''
      if (has(op, 'label') && op.label !== null && op.label !== undefined) {
        if (typeof op.label !== 'string') {
          throw new Error('ops[' + i + '] addNode "label" must be a string（装饰面板可省或给 ""）')
        }
        label = op.label
      }
      let id = typeof op.id === 'string' && op.id.length > 0 ? op.id : undefined
      if (id !== undefined && findNode(id) >= 0) {
        throw new Error('ops[' + i + '] addNode: node "' + id + '" already exists. Use setLabel to change it, or omit "id" to auto-allocate one.')
      }
      if (id === undefined) id = nextId(doc.nodes, 'n')
      // 别名：给这个名字之后就能在同一个 ops 数组里引用它（见 applyOps 开头的注释）。
      registerAlias(op.as, id, 'ops[' + i + '] addNode')
      const shotSelection = op.shape === 'shotcard' ? resolveShotStyle(shotCardCatalog, op.cardId, op.styleKey) : null
      if (shotSelection && !label) label = '镜头参考\n' + shotSelection.label
      const mgSelection = op.shape === 'mgstyle' ? resolveMgStyle(mgStyleCatalog, op.slug) : null
      if (mgSelection && !label) label = '整片风格\n' + mgSelection.name
      const style = op.shape === 'audio' ? 'rounded=1;fillColor=#e1f3ee;strokeColor=#5a9e8a;whiteSpace=wrap;fontSize=14;' : shotSelection ? 'rounded=1;arcSize=12;fillColor=#eeeafa;strokeColor=#9482dc;fontColor=#44336b;whiteSpace=wrap;fontSize=14;' : mgSelection ? 'rounded=1;arcSize=10;fillColor=#fdf6e3;strokeColor=#c9a227;fontColor=#5a4a1a;whiteSpace=wrap;fontSize=14;' : nodeStyleFromOp(DEFAULT_NODE_STYLE, op, 'ops[' + i + '] addNode')
      const videoNode = op.shape === 'video'
      const svgNode = videoNode === false && nodeShapeFromStyle(style) === 'svg'
      const node = {
        id: id,
        label: label,
        // 形状/配色是糖，落盘只有 style 键；不给就是 drawio 缺省（空串 = 普通矩形 + 缺省配色）。
        style: style,
        // svg 节点缺省是**正方形**：按标签文字估宽（estimateWidth）对图没有意义。
        // 空 label 的装饰面板也请显式给 w/h，否则会落到最短标签估宽（130）。
        // video 缺省 320×180（16:9 播放器框）。
        w: numberOr(op.w, shotSelection ? 320 : mgSelection ? 300 : videoNode ? DEFAULT_VIDEO_W : svgNode ? DEFAULT_SVG_W : estimateWidth(label)),
        h: numberOr(op.h, shotSelection ? 210 : mgSelection ? 120 : videoNode ? DEFAULT_VIDEO_H : svgNode ? DEFAULT_SVG_H : DEFAULT_H),
      }
      if (shotSelection) node.data = shotCardData(shotCardCatalog, shotSelection.cardId, shotSelection.styleKey)
      if (mgSelection) node.data = mgStyleData(mgStyleCatalog, mgSelection.slug)
      if (op.shape === 'audio') {
        node.data = audioNodeData(op.audioRole || 'sfx')
        if (op.audioClip) {
          if (!opctx?.drawioPath) throw new Error('导入音频需要画布路径')
          const {manifest} = frozenAudioFile(opctx.drawioPath, op.audioClip)
          Object.assign(node.data, {audioClip:op.audioClip,audioName:manifest.name,audioDuration:String(manifest.duration),audioSha256:manifest.sha256})
        }
        if (!label) node.label = node.data.audioName || '音频'
        node.w = numberOr(op.w,280); node.h = numberOr(op.h,110)
      }
      if (videoNode && !op.mediaClip && !op.mediaKind) {
        node.data = motionNodeData()
      } else if (videoNode) {
        const existingClips = []
        for (let vi = 0; vi < doc.nodes.length; vi += 1) {
          const vm = videoMetaFromData(doc.nodes[vi].data)
          if (vm !== null && vm.clip !== null) existingClips.push(vm.clip)
        }
        const clip =
          sanitizeClipId(op.mediaClip) ||
          allocateClipId(existingClips)
        node.data = videoDataAttrs({
          clip: clip,
          kind: op.mediaKind === 'raster' ? 'raster' : 'svg',
          fps: numberOr(op.fps, numberOr(op.mediaFps, DEFAULT_MEDIA_FPS)),
          w: node.w,
          h: node.h,
          posterFrame: numberOr(op.posterFrame, 0),
        })
        if (opctx !== undefined && opctx !== null) {
          if (Array.isArray(opctx.ensureClips) === false) opctx.ensureClips = []
          opctx.ensureClips.push({
            clip: clip,
            kind: node.data.mediaKind,
            fps: Number(node.data.mediaFps),
            w: node.w,
            h: node.h,
          })
        }
      }
      // Additional canvas data must survive both native JSON and draw.io XML.
      // Reject invalid XML attribute names and never overwrite built-in metadata.
      if (has(op, 'data')) {
        if (!op.data || typeof op.data !== 'object' || Array.isArray(op.data)) throw new Error('ops[' + i + '] addNode data must be an object of string values')
        const additions = {}
        for (const [key, value] of Object.entries(op.data)) {
          if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || ['id', 'label', '__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'string') {
            throw new Error('ops[' + i + '] addNode data requires valid, non-reserved names and string values')
          }
          if (node.data && has(node.data, key)) throw new Error('ops[' + i + '] addNode data cannot override built-in field "' + key + '"')
          additions[key] = value
        }
        node.data = Object.assign({}, node.data || {}, additions)
      }
      if (typeof op.layer === 'string' && op.layer.length > 0) node.layer = resolveLayerRef(op.layer, 'ops[' + i + '] addNode layer')
      // 位置：只有显式给了坐标才写入。缺省写 (0,0) 会让 placeMissing 以为"坐标齐全"而不补位，
      // 新节点就会堆在原点压住别人。
      if (has(op, 'x')) node.x = numberOr(op.x, 0)
      if (has(op, 'y')) node.y = numberOr(op.y, 0)
      doc.nodes.push(node)
      recordCreated(id, 'node', label)
      notes.push(
        '+ node ' + id +
          (videoNode ? ' [video clip=' + node.data.mediaClip + ']' : svgNode ? ' [svg]' : label.length > 0 ? ' "' + label + '"' : ' (empty label)') +
          (has(op, 'x') || has(op, 'y') ? ' at explicit coords' : ' (position pending)'),
      )
      continue
    }

    if (kind === 'addEdge') {
      const from = typeof op.from === 'string' ? resolveId(op.from) : undefined
      const to = typeof op.to === 'string' ? resolveId(op.to) : undefined
      // **独立线**：drawio 允许一条边的两端都是自由点（几何里的 sourcePoint/targetPoint），
      // 于是"先画一条线、再决定接哪儿"是合法形态 —— 线可以完全独立于节点存在。
      // 糖名用 fromPoint/toPoint（跟 from/to 对齐），模型名 sourcePoint/targetPoint 也认。
      const fromPoint = edgePointFromOp(op.fromPoint !== undefined ? op.fromPoint : op.sourcePoint, 'ops[' + i + '] addEdge fromPoint')
      const toPoint = edgePointFromOp(op.toPoint !== undefined ? op.toPoint : op.targetPoint, 'ops[' + i + '] addEdge toPoint')
      if (from === undefined && fromPoint === null) throw new Error('ops[' + i + '] addEdge needs "from" (node id) or "fromPoint" (absolute point)')
      if (to === undefined && toPoint === null) throw new Error('ops[' + i + '] addEdge needs "to" (node id) or "toPoint" (absolute point)')
      if (from !== undefined && findNode(from) < 0) throw new Error('ops[' + i + '] addEdge: unknown "from" node "' + from + '". Known nodes: ' + known())
      if (to !== undefined && findNode(to) < 0) throw new Error('ops[' + i + '] addEdge: unknown "to" node "' + to + '". Known nodes: ' + known())
      let id = typeof op.id === 'string' && op.id.length > 0 ? op.id : undefined
      if (id !== undefined && findEdge(id) >= 0) throw new Error('ops[' + i + '] addEdge: edge "' + id + '" already exists')
      if (id === undefined) id = nextId(doc.edges, 'e')
      if (typeof op.as === 'string' && op.as.length > 0) {
        registerAlias(op.as, id, 'ops[' + i + '] addEdge')
      }
      const edge = { id: id }
      // 新单元进哪一层：不给就由写回按缺省层处理（宿主看不到客户端的"当前层"，
      // 所以 AI 想让它进某一层必须显式说 —— 层 id 或层名都收）。
      if (typeof op.layer === 'string' && op.layer.length > 0) edge.layer = resolveLayerRef(op.layer, 'ops[' + i + '] addEdge layer')
      if (from !== undefined) edge.from = from
      if (to !== undefined) edge.to = to
      // 自由点只在那一端**没有真实顶点**时生效（drawio 语义，与内核的 edgeFreePoint 一致）。
      if (from === undefined && fromPoint !== null) edge.sourcePoint = fromPoint
      if (to === undefined && toPoint !== null) edge.targetPoint = toPoint
      if (typeof op.label === 'string' && op.label.length > 0) edge.label = op.label
      // 建边时就能带上画法：AI 想表达"这是一条异步/可选依赖"时，
      // 不该被迫先 addEdge 再补一次 setStyle（两次写盘、两次往返）。
      // 工作流节点之间默认使用圆角正交线；调用方指定的线型仍有优先权。
      const defaultStyle = from !== undefined && to !== undefined ? styleWithLineKind(DEFAULT_EDGE_STYLE, 'rounded') : DEFAULT_EDGE_STYLE
      edge.style = edgeStyleFromOp(styleWithRoutingMode(defaultStyle, 'manual'), op, 'ops[' + i + '] addEdge')
      // 线型是"语义 + 几何"两件事：直线不带折点（新边本来就没有）；曲线要看得见就得有个中点
      // （见 arcWaypointFor —— 两点直连的曲线在 drawio 里会退化成一条直线）。
      if (has(op, 'line') && normalizeLineKind(op.line, 'ops[' + i + '] addEdge') === 'curved') {
        const bow = arcWaypointFor(doc, edge)
        if (bow !== null) edge.points = [bow]
        edge.style = styleWithRoutingMode(edge.style, 'manual')
      }
      if (has(op, 'points')) {
        if (op.avoid === true) throw new Error('addEdge: points and avoid:true conflict; use manual points or automatic routing')
        setExplicitWaypoints(edge, op.points, 'ops[' + i + '] addEdge')
      }
      doc.edges.push(edge)
      recordCreated(id, 'edge', typeof edge.label === 'string' ? edge.label : undefined)
      const head = from !== undefined ? from : '(free ' + fromPoint.x + ',' + fromPoint.y + ')'
      const tail = to !== undefined ? to : '(free ' + toPoint.x + ',' + toPoint.y + ')'
      notes.push('+ edge ' + id + ' ' + head + ' -> ' + tail + styleNote(edge.style))
      if (from !== undefined && to !== undefined && !has(op, 'points') && !Array.isArray(edge.points) && edgeStyleValueFromStyle(edge.style) !== 'none' && routingModeOf(edge) !== 'auto') {
        notes.push('~ 连线 ' + id + ' 尚未明确指定折点：读回节点坐标后自行规划通道，用 setEdge {id:"' + id + '",points:[...]} 写入；对齐且无需拐弯可传空数组。')
      }
      continue
    }

    if (kind === 'duplicate') {
      // 复制一组单元（Ctrl+C/V 的工具版）：**新 id、整体平移**，而折点、端点约束、标签位置、
      // 自定义数据全都照旧带过去。
      //
      // 以前 AI 想"再来一份"只能重新 addNode + addEdge —— 折点、端点约束、label 位置全丢，
      // 而且新边还得自己重连一遍。
      const ids = idList(op, i, 'duplicate')
      // 与画布上的 Ctrl+V 同一套位移：两格（2 × 10px），不然复制出来的会正好压在原图上。
      const dx = Number.isFinite(Number(op.dx)) ? Number(op.dx) : DUPLICATE_OFFSET
      const dy = Number.isFinite(Number(op.dy)) ? Number(op.dy) : DUPLICATE_OFFSET
      // 默认把"两端都在被复制节点之间"的边一起复制 —— 用户说"复制这个子图"时指的就是它；
      // withEdges:false 只要节点。
      const withEdges = op.withEdges !== false
      const layer = typeof op.layer === 'string' && op.layer.length > 0 ? resolveLayerRef(op.layer, 'ops[' + i + '] duplicate layer') : undefined
      const srcNodes = []
      const srcEdges = []
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          srcNodes.push(doc.nodes[ni])
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          srcEdges.push(doc.edges[ei])
          continue
        }
        throw new Error('ops[' + i + '] duplicate: unknown id "' + id + '". Known nodes: ' + known())
      }
      if (typeof op.as === 'string' && op.as.length > 0 && srcNodes.length !== 1) {
        throw new Error('ops[' + i + '] duplicate: "as" 只在复制**单个节点**时可用（一组没有唯一的新 id 可指）')
      }
      if (srcNodes.length === 0) {
        // 只复制连线：接在节点上的边不行 —— 新边会继续指着**原来的**节点，那不是"复制"。
        for (let k = 0; k < srcEdges.length; k += 1) {
          const e = srcEdges[k]
          if (typeof e.from === 'string' && typeof e.to === 'string') {
            throw new Error(
              'ops[' + i + '] duplicate: edge "' + e.id + '" 两端都接在节点上 —— 把它的两端节点一起写进 ids（否则新边还指着原来的节点）',
            )
          }
        }
      }
      const remap = {}
      for (let k = 0; k < srcNodes.length; k += 1) {
        const src = srcNodes[k]
        const id = nextId(doc.nodes, 'n')
        remap[String(src.id)] = id
        // 整份浅拷 + 改写 id 与新位置：label/style/w/h/data/layer 都在里面。
        const copy = Object.assign({}, src, {
          id: id,
          x: Math.round(numberOr(src.x, 0) + dx),
          y: Math.round(numberOr(src.y, 0) + dy),
        })
        if (layer !== undefined) copy.layer = layer
        doc.nodes.push(copy)
        recordCreated(id, 'node', typeof copy.label === 'string' ? copy.label : undefined)
        notes.push('+ node ' + id + '（复制自 ' + src.id + '）')
      }
      const wantEdges = srcEdges.slice()
      if (withEdges && srcNodes.length > 0) {
        for (let k = 0; k < doc.edges.length; k += 1) {
          const e = doc.edges[k]
          // 两端都在新节点里就带上（自环 from === to 也自然算在内）
          if (remap[String(e.from)] === undefined || remap[String(e.to)] === undefined) continue
          let already = false
          for (let j = 0; j < wantEdges.length; j += 1) if (wantEdges[j].id === e.id) already = true
          if (already === false) wantEdges.push(e)
        }
      }
      for (let k = 0; k < wantEdges.length; k += 1) {
        const src = wantEdges[k]
        const from = src.from === undefined ? undefined : remap[String(src.from)]
        const to = src.to === undefined ? undefined : remap[String(src.to)]
        if (src.from !== undefined && from === undefined) {
          throw new Error('ops[' + i + '] duplicate: edge "' + src.id + '" 的起点 ' + src.from + ' 不在被复制的节点里（把两端一起复制）')
        }
        if (src.to !== undefined && to === undefined) {
          throw new Error('ops[' + i + '] duplicate: edge "' + src.id + '" 的终点 ' + src.to + ' 不在被复制的节点里（把两端一起复制）')
        }
        const id = nextId(doc.edges, 'e')
        const copy = Object.assign({}, src, { id: id })
        if (from !== undefined) copy.from = from
        if (to !== undefined) copy.to = to
        if (layer !== undefined) copy.layer = layer
        // 折点与自由端点**深拷**并跟着位移：共用数组是这类复制最经典的坑
        //（改一份另一份跟着变，客户端 pasteInto 里也专门盯着它）。
        if (Array.isArray(src.points)) copy.points = src.points.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }))
        if (src.sourcePoint !== undefined && src.sourcePoint !== null) {
          copy.sourcePoint = { x: Math.round(src.sourcePoint.x + dx), y: Math.round(src.sourcePoint.y + dy) }
        }
        if (src.targetPoint !== undefined && src.targetPoint !== null) {
          copy.targetPoint = { x: Math.round(src.targetPoint.x + dx), y: Math.round(src.targetPoint.y + dy) }
        }
        doc.edges.push(copy)
        recordCreated(id, 'edge', typeof copy.label === 'string' ? copy.label : undefined)
        notes.push('+ edge ' + id + '（复制自 ' + src.id + '）')
      }
      if (typeof op.as === 'string' && op.as.length > 0 && srcNodes.length === 1) {
        registerAlias(op.as, remap[String(srcNodes[0].id)], 'ops[' + i + '] duplicate')
      }
      continue
    }

    if (kind === 'move') {
      const ids = idList(op, i, 'move')
      const hasX = Number.isFinite(Number(op.x))
      const hasY = Number.isFinite(Number(op.y))
      const dx = Number.isFinite(Number(op.dx)) ? Number(op.dx) : 0
      const dy = Number.isFinite(Number(op.dy)) ? Number(op.dy) : 0
      if (hasX === false && hasY === false && dx === 0 && dy === 0) {
        throw new Error('ops[' + i + '] move needs "x"/"y" (absolute) or a non-zero "dx"/"dy"')
      }
      // 批量移动只认相对位移：给一组 id + 一个绝对 x/y 等于"把它们全叠到同一个点上"，
      // 几乎不可能是本意（那是 N 个节点压成一摞），所以直接拒绝而不是猜。
      if (ids.length > 1 && (hasX || hasY)) {
        throw new Error('ops[' + i + '] move: with "ids" use "dx"/"dy" (one absolute x/y would stack them all on the same point)')
      }
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        // 节点：绝对坐标（给 x/y）或相对位移（给 dx/dy）都行。
        // 以前只能"删掉重画"来改位置 —— 那会丢 id、丢边上的端点约束与折点，是实打实的损失。
        const ni = findNode(id)
        if (ni >= 0) {
          const n = doc.nodes[ni]
          n.x = Math.round(hasX ? Number(op.x) : numberOr(n.x, 0) + dx)
          n.y = Math.round(hasY ? Number(op.y) : numberOr(n.y, 0) + dy)
          recordChanged(id)
          notes.push('~ node ' + id + ' @' + n.x + ',' + n.y)
          continue
        }
        // 连线：整体平移它**自己的**几何（折点 + 悬空端的自由点），
        // 与画布上"拖整组"完全同一套语义（端点接在节点上时由节点决定，不受影响）。
        const ei = findEdge(id)
        if (ei < 0) throw new Error('ops[' + i + '] move: unknown node or edge "' + id + '". Known nodes: ' + known())
        if (hasX || hasY) throw new Error('ops[' + i + '] move: an edge can only be moved by "dx"/"dy" (its geometry is relative)')
        const edge = doc.edges[ei]
        let touched = 0
        if (Array.isArray(edge.points)) {
          edge.points = edge.points.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }))
          touched += 1
        }
        if (edge.sourcePoint !== undefined && edge.sourcePoint !== null) {
          edge.sourcePoint = { x: Math.round(edge.sourcePoint.x + dx), y: Math.round(edge.sourcePoint.y + dy) }
          touched += 1
        }
        if (edge.targetPoint !== undefined && edge.targetPoint !== null) {
          edge.targetPoint = { x: Math.round(edge.targetPoint.x + dx), y: Math.round(edge.targetPoint.y + dy) }
          touched += 1
        }
        recordChanged(id)
        notes.push('~ edge ' + id + ' moved by ' + dx + ',' + dy + (touched === 0 ? '（它两端都接在节点上、也没有折点，等于没有可平移的几何）' : ''))
      }
      continue
    }

    if (kind === 'order') {
      // 顺序（z-order）：模型数组里的先后 = 画布上的覆盖顺序 = 文件里单元的先后。
      // 与画布右键的「置顶/上移/下移/置底」完全同一套语义（见客户端 reorderItem）。
      //
      // 为什么 AI 需要它：**所有边都画在所有节点下面**（画布目前的层叠限制），
      // "让这条边压在那几个节点上面"只能靠图层，而图层 ops 还没有 —— 至少先把
      // 同一类之间的顺序（谁压谁）交给 AI。
      const ids = idList(op, i, 'order')
      const to = typeof op.to === 'string' ? op.to : undefined
      if (ORDER_MODES.indexOf(to) < 0) {
        throw new Error('ops[' + i + '] order needs "to": ' + ORDER_MODES.join('|') + '（后面的在上面）')
      }
      if (ids.length > 1 && to !== 'front' && to !== 'back') {
        throw new Error('ops[' + i + '] order: 一组只能用 front/back（up/down 是"挪一层"，一组里谁先谁后说不清）')
      }
      // 节点与连线是**两条**序列（文件里它们可能交错，但模型与画布都按各自的序列层叠）。
      let target = null
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        const ei = findEdge(id)
        if (ni < 0 && ei < 0) throw new Error('ops[' + i + '] order: unknown id "' + id + '". Known nodes: ' + known())
        const which = ni >= 0 ? 'node' : 'edge'
        if (target === null) target = which
        else if (target !== which) throw new Error('ops[' + i + '] order: 一次只能排同一类单元（节点和连线是两条序列）')
      }
      const list = target === 'node' ? doc.nodes : doc.edges
      if (to === 'up' || to === 'down') {
        const id = ids[0]
        let at = -1
        for (let k = 0; k < list.length; k += 1) {
          if (list[k].id === id) {
            at = k
            break
          }
        }
        const item = list.splice(at, 1)[0]
        // 与客户端同一套：at 是"拔出来之前"的位置，插回时按它 +1 / -1 并夹在范围内。
        if (to === 'up') list.splice(Math.min(at + 1, list.length), 0, item)
        else list.splice(Math.max(at - 1, 0), 0, item)
      } else {
        // 一组：先按它们在序列里的原顺序取出来，再整体放到头/尾 —— 组内相对顺序不变
        //（"把这三条边置顶"不该顺手把它们互换个位置）。
        const picked = []
        for (let k = list.length - 1; k >= 0; k -= 1) if (ids.indexOf(list[k].id) >= 0) picked.unshift(list.splice(k, 1)[0])
        if (to === 'front') for (let k = 0; k < picked.length; k += 1) list.push(picked[k])
        else for (let k = picked.length - 1; k >= 0; k -= 1) list.unshift(picked[k])
        for (let k = 0; k < ids.length; k += 1) recordChanged(ids[k])
        notes.push('~ order: ' + ids.join(', ') + ' → ' + to + '（' + (target === 'node' ? '节点' : '连线') + '共 ' + list.length + ' 个）')
        continue
      }
      recordChanged(ids[0])
      notes.push('~ order: ' + ids[0] + ' → ' + to)
      continue
    }

    if (kind === 'setEdge') {
      // 重接或编辑折点；未显式指定的几何与样式保持原样。
      // id、标签、标签位置、折点、端点约束（exitX/entryX）都留着。
      // 以前只能 remove + addEdge 重画，那会把这些全丢掉。
      const ids = idList(op, i, 'setEdge')
      if (ids.length !== 1) throw new Error('ops[' + i + '] setEdge: 一次改一条边，给单个 "id"')
      const id = ids[0]
      const ei = findEdge(id)
      if (ei < 0) throw new Error('ops[' + i + '] setEdge: unknown edge "' + id + '". Known edges: ' + knownEdges())
      const edge = doc.edges[ei]
      let touched = 0
      // 两端各处理一次：`from`（节点 id）/`fromPoint`（绝对点）二选一，`to`/`toPoint` 同理。
      for (let end = 0; end < 2; end += 1) {
        const isSource = end === 0
        const nodeKey = isSource ? 'from' : 'to'
        const pointKey = isSource ? 'fromPoint' : 'toPoint'
        const pointAlias = isSource ? 'sourcePoint' : 'targetPoint'
        const freeKey = isSource ? 'sourcePoint' : 'targetPoint'
        const rawPoint = op[pointKey] !== undefined ? op[pointKey] : op[pointAlias]
        const nodeDeclared = has(op, nodeKey)
        const rawNode = op[nodeKey]
        // 明确写 `from: null` / `to: null` = "这一端不接节点"（模型表达"脱开"的自然写法）。
        const hasNode = nodeDeclared && rawNode !== null
        const hasPoint = rawPoint !== undefined && rawPoint !== null
        if (nodeDeclared === true && rawNode === null && hasPoint === false) {
          throw new Error(
            'ops[' + i + '] setEdge: ' + nodeKey + ' 给 null 表示"这一端不接节点"，那就要一起给 ' + pointKey + '（自由端得有坐标）',
          )
        }
        if (hasNode === false && hasPoint === false) continue
        if (hasNode === true && hasPoint === true) {
          throw new Error('ops[' + i + '] setEdge: ' + nodeKey + ' 与 ' + pointKey + ' 只能给一个（接节点还是接一个自由点）')
        }
        if (hasNode === true) {
          const ref = rawNode
          if (typeof ref !== 'string' || ref.length === 0) {
            throw new Error('ops[' + i + '] setEdge: ' + nodeKey + ' 要么是节点 id，要么给 null + ' + pointKey + '（脱开节点需要有坐标）')
          }
          const nodeId = resolveId(ref)
          if (findNode(nodeId) < 0) throw new Error('ops[' + i + '] setEdge: unknown "' + nodeKey + '" node "' + nodeId + '". Known nodes: ' + known())
          if (isSource) edge.from = nodeId
          else edge.to = nodeId
          // 那一端接上节点之后，旧的自由点必须删掉：drawio 的规矩是"有真实顶点时忽略自由点"，
          // 留着不会显示，但会在文件里留一条过期几何，下次换个工具打开就是脏数据。
          delete edge[freeKey]
          touched += 1
          continue
        }
        const point = edgePointFromOp(rawPoint, 'ops[' + i + '] setEdge ' + pointKey)
        if (point === null) throw new Error('ops[' + i + '] setEdge: ' + pointKey + ' 需要 {x, y}')
        delete edge[nodeKey]
        edge[freeKey] = point
        touched += 1
      }
      if (has(op, 'points')) {
        if (op.avoid === true) throw new Error('setEdge: points and avoid:true conflict; use manual points or automatic routing')
        setExplicitWaypoints(edge, op.points, 'ops[' + i + '] setEdge')
        touched += 1
      }
      if (touched === 0) throw new Error('ops[' + i + '] setEdge needs "from"/"to", "fromPoint"/"toPoint", or "points"')
      const head = typeof edge.from === 'string' ? edge.from : '(free ' + edge.sourcePoint.x + ',' + edge.sourcePoint.y + ')'
      const tail = typeof edge.to === 'string' ? edge.to : '(free ' + edge.targetPoint.x + ',' + edge.targetPoint.y + ')'
      const kept = []
      if (!has(op, 'points') && Array.isArray(edge.points) && edge.points.length > 0) kept.push(edge.points.length + ' 个折点')
      if (typeof edge.label === 'string' && edge.label.length > 0) kept.push('标签')
      recordChanged(id)
      notes.push('~ edge ' + id + ' ' + head + ' -> ' + tail + (has(op, 'points') ? '，手动折点 ' + edge.points.length + ' 个' : '') + (kept.length > 0 ? '（' + kept.join('、') + '照旧）' : ''))
      continue
    }

    if (kind === 'setLabelPos') {
      // 边上的文字在**画布上的位置**。drawio 存法：边几何的 x = 沿边比例（-1..1，0 = 弧长中点）、
      // y = 垂直偏移 px、`<mxPoint as="offset">` = 取整剩下的零头（见 mxfile 的 relativeLabelPos）。
      //
      // 客户端能按住线上的字拖，AI 却既看不见位置、也改不了 —— "文字压住线"这种小毛病
      // 原来只能让用户自己动手。现在：read 回 x/y，改给 setLabelPos。
      const id = typeof op.id === 'string' && op.id.length > 0 ? resolveId(op.id) : undefined
      if (id === undefined) throw new Error('ops[' + i + '] setLabelPos needs string "id"')
      const ei = findEdge(id)
      if (ei < 0) throw new Error('ops[' + i + '] setLabelPos: unknown edge "' + id + '". Known edges: ' + knownEdges())
      const edge = doc.edges[ei]
      // center：放回弧长中点（= 删掉位置，与画布右键「标签居中」同一件事）。
      if (op.center === true) {
        delete edge.labelX
        delete edge.labelY
        delete edge.labelOffsetX
        delete edge.labelOffsetY
        recordChanged(id)
        notes.push('~ edge ' + id + ' 标签放回弧长中点')
        continue
      }
      const hasX = Number.isFinite(Number(op.x))
      const hasY = Number.isFinite(Number(op.y))
      const dx = Number.isFinite(Number(op.dx)) ? Number(op.dx) : 0
      const dy = Number.isFinite(Number(op.dy)) ? Number(op.dy) : 0
      const hasOffX = Number.isFinite(Number(op.offsetX))
      const hasOffY = Number.isFinite(Number(op.offsetY))
      if (hasX === false && hasY === false && dx === 0 && dy === 0 && hasOffX === false && hasOffY === false) {
        throw new Error('ops[' + i + '] setLabelPos needs "x"/"y" (absolute, relative to the path) or "dx"/"dy" (nudge) or center:true')
      }
      const curX = Number.isFinite(Number(edge.labelX)) ? Number(edge.labelX) : 0
      const curY = Number.isFinite(Number(edge.labelY)) ? Number(edge.labelY) : 0
      const nextX = hasX ? Number(op.x) : curX + dx
      if (nextX < -1 || nextX > 1) {
        throw new Error('ops[' + i + '] setLabelPos: "x" 是**沿边比例**（-1..1，0 = 中点），要按像素挪动请用 dy')
      }
      // x 收四位小数（与客户端拖动时同一套存法）；y 取整。
      edge.labelX = Math.round(nextX * 10000) / 10000
      edge.labelY = Math.round(hasY ? Number(op.y) : curY + dy)
      // 零头只在显式给的时候写：它是"客户端拖到某个像素后取整剩下的那点偏移"，
      // 我们按 x/y 设定位置时留着它会把落点带偏（真实位置 = x/y + offset）。
      if (hasOffX || hasOffY) {
        const offX = hasOffX ? Math.round(Number(op.offsetX)) : numberOr(edge.labelOffsetX, 0)
        const offY = hasOffY ? Math.round(Number(op.offsetY)) : numberOr(edge.labelOffsetY, 0)
        if (offX === 0) delete edge.labelOffsetX
        else edge.labelOffsetX = offX
        if (offY === 0) delete edge.labelOffsetY
        else edge.labelOffsetY = offY
      } else {
        delete edge.labelOffsetX
        delete edge.labelOffsetY
      }
      recordChanged(id)
      notes.push('~ edge ' + id + ' 标签位置 x=' + edge.labelX + '（沿边比例）y=' + edge.labelY + 'px')
      continue
    }

    if (kind === 'addLayer') {
      // 新建一层（加在最上面）。有了它 + setLayer，"把这一组放到新图层"才做得到 ——
      // 以前 AI 看得到层表却一层都加不了。
      const list = layerList()
      const used = {}
      for (let k = 0; k < list.length; k += 1) used[String(list[k].id)] = true
      let id = undefined
      if (typeof op.id === 'string' && op.id.length > 0) {
        if (used[op.id] === true) throw new Error('ops[' + i + '] addLayer: layer id "' + op.id + '" already exists')
        id = op.id
      } else {
        // 与 drawio 一致地挑一个数字串 id（最小的空缺），避开已用的。
        let n = 1
        while (used[String(n)] === true) n += 1
        id = String(n)
      }
      const name = typeof op.name === 'string' ? op.name : ''
      doc.layers = list.concat([{ id: id, name: name, visible: op.visible !== false, locked: op.locked === true }])
      registerAlias(op.as, id, 'ops[' + i + '] addLayer')
      recordCreated(id, 'layer', name)
      notes.push('+ layer ' + id + (name.length > 0 ? ' "' + name + '"' : '') + '（加在最上面；新单元要显式写 layer 才进这一层）')
      continue
    }

    if (kind === 'setLayer') {
      // 把已有单元**移到**另一层（层 id 或层名）。客户端 v2 的"把选中移到别的层"，
      // AI 侧就是这一条 —— 隐藏/锁定别的层与它配合才能"只看一部分"。
      const ids = idList(op, i, 'setLayer')
      const ref = typeof op.layer === 'string' && op.layer.length > 0 ? op.layer : undefined
      if (ref === undefined) throw new Error('ops[' + i + '] setLayer needs string "layer"（层 id 或层名）')
      const layerId = resolveLayerRef(ref, 'ops[' + i + '] setLayer')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          doc.nodes[ni].layer = layerId
          recordChanged(id)
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          doc.edges[ei].layer = layerId
          recordChanged(id)
          continue
        }
        throw new Error('ops[' + i + '] setLayer: unknown node or edge "' + id + '". Known nodes: ' + known())
      }
      notes.push('~ ' + ids.length + ' 个单元移到图层 ' + layerId)
      continue
    }

    if (kind === 'setLayerProps') {
      // 层的名字 / 显示 / 锁定 —— 纯文档状态（隐藏是写进文件的显示状态，不是删除）。
      const ref = typeof op.layer === 'string' && op.layer.length > 0 ? op.layer : undefined
      if (ref === undefined) throw new Error('ops[' + i + '] setLayerProps needs string "layer"（层 id 或层名）')
      const layerId = resolveLayerRef(ref, 'ops[' + i + '] setLayerProps')
      const list = layerList()
      let target = null
      for (let k = 0; k < list.length; k += 1) if (String(list[k].id) === layerId) target = list[k]
      if (target === null) throw new Error('ops[' + i + '] setLayerProps: 找不到层 ' + layerId)
      const changedKeys = []
      if (has(op, 'name')) {
        target.name = typeof op.name === 'string' ? op.name : ''
        changedKeys.push('name="' + target.name + '"')
      }
      if (has(op, 'visible')) {
        target.visible = op.visible !== false
        changedKeys.push(target.visible === false ? '隐藏' : '显示')
      }
      if (has(op, 'locked')) {
        target.locked = op.locked === true
        changedKeys.push(target.locked === true ? '锁定' : '解锁')
      }
      if (changedKeys.length === 0) throw new Error('ops[' + i + '] setLayerProps needs at least one of "name"/"visible"/"locked"')
      notes.push('~ layer ' + layerId + ' ' + changedKeys.join(' '))
      continue
    }

    if (kind === 'export') {
      // 导出这张画布（svg 落成文件、png 走浏览器下载）。
      //
      // 为什么是"请求"而不是当场生成：渲染器在浏览器那一半（正交路由、避让、圆角、断线），
      // 宿主这边只有文档。所以这里只登记意图，真正的渲染由画布在下一次轮询时完成。
      const format = typeof op.format === 'string' ? op.format.toLowerCase() : 'svg'
      if (format !== 'svg' && format !== 'png') {
        throw new Error('ops[' + i + '] export: "format" 只能是 svg 或 png（默认 svg）')
      }
      let name = typeof op.name === 'string' ? op.name.trim() : ''
      if (name.length > 0) {
        name = name.replace(/\.(svg|png)$/i, '')
        // 只收**基名**：导出永远落在 .drawio 旁边，不收路径（想放别处请先让用户另存到那儿）。
        if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
          throw new Error('ops[' + i + '] export: "name" 只能是文件基名（不含路径分隔符与非法字符）')
        }
      }
      if (out !== undefined && out !== null) out.export = { format: format, name: name }
      notes.push('⤓ 已请求导出 ' + format.toUpperCase() + (name.length > 0 ? '（' + name + '）' : '') + '：画布下一次刷新时渲染')
      continue
    }

    if (kind === 'highlight') {
      // **只提示、不改文档**：把几个 id 记成"下次客户端来取时选中它们"，
      // 于是 AI 能说"你看这几个节点"而不用让用户自己找。
      const ids = Array.isArray(op.ids) ? op.ids.filter((v) => typeof v === 'string' && v.length > 0) : []
      if (ids.length === 0) throw new Error('ops[' + i + '] highlight needs non-empty string array "ids"')
      if (out !== undefined && out !== null) out.highlight = ids.slice()
      notes.push('👁 已请求高亮 ' + ids.length + ' 项（客户端下次刷新时会选中它们）')
      continue
    }

    if (kind === 'setLabel') {
      const label = typeof op.label === 'string' ? op.label : undefined
      if (label === undefined) throw new Error('ops[' + i + '] setLabel needs string "label"')
      const ids = idList(op, i, 'setLabel')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          if (doc.nodes[ni].label !== label) {
            delete doc.nodes[ni].labelHtml
            if (doc.nodes[ni].data) delete doc.nodes[ni].data.drawaiTableEscaped
          }
          doc.nodes[ni].label = label
          recordChanged(id)
          notes.push('~ node ' + id + ' label = "' + label + '"')
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          if (doc.edges[ei].label !== label) delete doc.edges[ei].labelHtml
          doc.edges[ei].label = label
          recordChanged(id)
          notes.push('~ edge ' + id + ' label = "' + label + '"')
          continue
        }
        throw new Error('ops[' + i + '] setLabel: unknown id "' + id + '". Known nodes: ' + known())
      }
      continue
    }

    if (kind === 'setStyle') {
      const ids = idList(op, i, 'setStyle')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni < 0) {
          // 连线也归 setStyle 管 —— 节点的"画法"是 shape/style，连线的"画法"是线型/箭头/颜色。
          // 分成两个 op 只是多一条要记的规则，对模型和人都没有好处。
          const ei = findEdge(id)
          if (ei < 0) throw new Error('ops[' + i + '] setStyle: unknown node or edge "' + id + '". Known nodes: ' + known())
          const edge = doc.edges[ei]
          const where = 'ops[' + i + '] setStyle'
          // 键级合并：只改点到的键，其余（含认不出的键）原样留着 —— 开放集合的代价与好处都在这。
          const base = edge.style === undefined ? DEFAULT_EDGE_STYLE : edge.style
          const next = edgeStyleFromOp(base, op, where)
          if (next !== base) edge.style = next
          // 显式清折点（右键"自动路由"与 AI 都能用同一件事）。
          //
          // **自由端点不是折点**：一端没有真实顶点时，那个自由点就是这条线的落点。无条件删它，
          // "两端都自由"的独立线就一个落点都不剩 —— 写回会把它当成"两端都没有落点的边"整条跳过
          //（实测：画好的一条尾巴就这么没了，notes 里那句"已略过"没人会去看）。
          // 所以只在那一端**有真实顶点**时才删（那种情况下 drawio 本来就忽略自由点）。
          if (op.clearPoints === true) {
            delete edge.points
            if (typeof edge.from === 'string') delete edge.sourcePoint
            if (typeof edge.to === 'string') delete edge.targetPoint
          }
          // 线型带来的几何后果（与画布右键菜单同一套语义，见客户端的 applyLineKind）：
          //   直线 = 无折点：留着折点就不是直线了；
          //   曲线 = 把现有折线抹圆，而**两点直连的边**在 drawio 里曲线会退化成直线
          //   （mxPolyline.paintCurvedLine 两点时控制点落在起点上），所以补一个弓形中点。
          if (has(op, 'line')) {
            const kind = normalizeLineKind(op.line, where)
            if (kind === 'curved') edge.style = styleWithRoutingMode(edge.style || next, 'manual')
            if (kind === 'straight') delete edge.points
            else if (kind === 'curved' && (Array.isArray(edge.points) === false || edge.points.length === 0)) {
              const bow = arcWaypointFor(doc, edge)
              if (bow !== null) edge.points = [bow]
            }
          }
          recordChanged(id)
          notes.push('~ edge ' + id + ' style' + styleNote(edge.style === undefined ? base : edge.style))
          continue
        }
        const node = doc.nodes[ni]
        const nodeBase = node.style === undefined ? DEFAULT_NODE_STYLE : node.style
        const nextStyle = nodeStyleFromOp(nodeBase, op, 'ops[' + i + '] setStyle')
        const keys = op.keys && typeof op.keys === 'object' && !Array.isArray(op.keys) ? op.keys : {}
        const styleText = typeof op.style === 'string' ? op.style : ''
        const colorChanged = has(op, 'fontColor') || has(keys, 'fontColor') || /(?:^|;)\s*fontColor\s*=/.test(styleText) ||
          (nodeShapeFromStyle(nextStyle) === 'text' && styleText.length > 0 && !/[=;]/.test(styleText))
        const sizeChanged = has(op, 'fontSize') || has(keys, 'fontSize') || /(?:^|;)\s*fontSize\s*=/.test(styleText)
        if (typeof node.labelHtml === 'string' && (colorChanged || sizeChanged)) {
          node.labelHtml = clearRichTextOverrides(node.labelHtml, { color: colorChanged, size: sizeChanged })
        }
        if (nextStyle !== nodeBase) node.style = nextStyle
        if (has(op, 'w')) node.w = numberOr(op.w, node.w)
        if (has(op, 'h')) node.h = numberOr(op.h, node.h)
        recordChanged(id)
        notes.push('~ node ' + id + ' [' + nodeShapeFromStyle(nextStyle) + ']' + (nextStyle.length === 0 ? ' (默认样式)' : ''))
      }
      continue
    }

    if (kind === 'remove') {
      const ids = idList(op, i, 'remove')
      for (let k = 0; k < ids.length; k += 1) {
        const id = ids[k]
        const ni = findNode(id)
        if (ni >= 0) {
          doc.nodes.splice(ni, 1)
          const kept = []
          let dropped = 0
          for (let j = 0; j < doc.edges.length; j += 1) {
            const e = doc.edges[j]
            if (e.from === id || e.to === id) dropped += 1
            else kept.push(e)
          }
          doc.edges = kept
          if (removed.indexOf(id) < 0) removed.push(id)
          notes.push('- node ' + id + (dropped > 0 ? ' (and ' + dropped + ' edge(s))' : ''))
          continue
        }
        const ei = findEdge(id)
        if (ei >= 0) {
          doc.edges.splice(ei, 1)
          if (removed.indexOf(id) < 0) removed.push(id)
          notes.push('- edge ' + id)
          continue
        }
        throw new Error('ops[' + i + '] remove: unknown id "' + id + '". Known nodes: ' + known())
      }
      continue
    }

    // ── 视频媒体 ops（旁路 *.media/<clip>/；多数不改 .drawio）────────────────
    if (
      kind === 'listFrames' ||
      kind === 'getFrame' ||
      kind === 'setFrame' ||
      kind === 'appendFrames' ||
      kind === 'setMediaMeta' ||
      kind === 'importMedia' ||
      kind === 'extractFrames' ||
      kind === 'traceFrame' ||
      kind === 'exportSvgVideo' ||
      kind === 'exportMediaSource'
    ) {
      const drawioPath = opctx !== undefined && opctx !== null ? opctx.drawioPath : null
      if (typeof drawioPath !== 'string' || drawioPath.length === 0) {
        throw new Error('ops[' + i + '] ' + kind + ': 需要已绑定的画布路径（旁路媒体包跟 .drawio 走）')
      }
      const where = 'ops[' + i + '] ' + kind
      const id = typeof op.id === 'string' ? op.id : ''
      if (id.length === 0) throw new Error(where + ': "id" is required')
      const resolved = resolveVideoNode(doc, id, where)
      const clipDir = clipDirFor(drawioPath, resolved.meta.clip)
      ensureClipPack(drawioPath, resolved.meta.clip, {
        kind: resolved.meta.kind,
        fps: resolved.meta.fps,
        w: resolved.meta.w,
        h: resolved.meta.h,
      })
      let manifest = readManifest(clipDir)

      if (kind === 'listFrames') {
        const listed = listFrameEntries(manifest, op.from, op.to)
        if (out !== undefined && out !== null) {
          if (Array.isArray(out.media) === false) out.media = []
          out.media.push({ op: kind, id: id, clip: resolved.meta.clip, ...listed })
        }
        notes.push('listFrames ' + id + ' → ' + listed.total + ' frame(s)')
        continue
      }

      if (kind === 'getFrame') {
        const index = Math.floor(Number(op.index))
        const svg = readFrameSvg(clipDir, manifest, index)
        if (out !== undefined && out !== null) {
          if (Array.isArray(out.media) === false) out.media = []
          out.media.push({
            op: kind,
            id: id,
            clip: resolved.meta.clip,
            index: index,
            svg: svg.length > SVG_REPORT_LIMIT ? svg.slice(0, SVG_REPORT_LIMIT) + '…«truncated ' + svg.length + '»' : svg,
            svgChars: svg.length,
          })
        }
        notes.push('getFrame ' + id + '[' + index + '] ' + svg.length + ' chars')
        continue
      }

      if (kind === 'setFrame') {
        if (typeof op.svg !== 'string') throw new Error(where + ': "svg" markup required')
        const index = Math.floor(Number(op.index))
        manifest = writeFrameSvg(clipDir, manifest, index, op.svg)
        if (resolved.meta.posterFrame === index) {
          resolved.node.style = styleWithSvgMarkup(resolved.node.style || '', op.svg, '0')
          recordChanged(id)
        }
        notes.push('setFrame ' + id + '[' + index + '] → ' + manifest.frames.length + ' frame(s)')
        continue
      }

      if (kind === 'appendFrames') {
        if (Array.isArray(op.svgs) === false) throw new Error(where + ': "svgs" array required')
        const before = manifest.frames.length
        manifest = appendFrameSvgs(clipDir, manifest, op.svgs)
        notes.push('appendFrames ' + id + ' +' + (manifest.frames.length - before) + ' → ' + manifest.frames.length)
        continue
      }

      if (kind === 'setMediaMeta') {
        const next = Object.assign({}, resolved.meta)
        if (has(op, 'fps') || has(op, 'mediaFps')) next.fps = numberOr(op.fps, numberOr(op.mediaFps, next.fps))
        if (has(op, 'kind') || has(op, 'mediaKind')) {
          const k = op.kind !== undefined ? op.kind : op.mediaKind
          next.kind = k === 'raster' ? 'raster' : 'svg'
        }
        if (has(op, 'posterFrame') || has(op, 'mediaPosterFrame')) {
          next.posterFrame = Math.floor(numberOr(op.posterFrame, numberOr(op.mediaPosterFrame, next.posterFrame)))
        }
        if (has(op, 'w') || has(op, 'mediaW')) next.w = numberOr(op.w, numberOr(op.mediaW, next.w))
        if (has(op, 'h') || has(op, 'mediaH')) next.h = numberOr(op.h, numberOr(op.mediaH, next.h))
        resolved.node.data = Object.assign({}, resolved.node.data, videoDataAttrs(next))
        manifest.kind = next.kind
        manifest.fps = next.fps
        manifest.width = next.w
        manifest.height = next.h
        writeManifest(clipDir, manifest)
        if (next.posterFrame >= 0 && next.posterFrame < manifest.frames.length) {
          try {
            const posterSvg = readFrameSvg(clipDir, manifest, next.posterFrame)
            resolved.node.style = styleWithSvgMarkup(resolved.node.style || '', posterSvg, '0')
          } catch (error) {
            // 海报帧暂不可读时保留原海报
          }
        }
        recordChanged(id)
        notes.push('setMediaMeta ' + id + ' kind=' + next.kind + ' fps=' + next.fps)
        continue
      }

      if (kind === 'importMedia') {
        const file = typeof op.file === 'string' ? op.file : ''
        if (file.length === 0) throw new Error(where + ': "file" workspace path required')
        if (typeof opctx.readAbsolutePath !== 'function') {
          throw new Error(where + ': host cannot resolve workspace files')
        }
        const abs = await opctx.readAbsolutePath(file, where)
        const lower = abs.toLowerCase()
        if (/\.(webm|mp4|mov|mkv)$/.test(lower)) {
          const imported = importSourceFile(clipDir, abs)
          manifest = imported.manifest
          resolved.node.data = Object.assign({}, resolved.node.data, videoDataAttrs(Object.assign({}, resolved.meta, { kind: 'raster' })))
          recordChanged(id)
          notes.push('importMedia ' + id + ' ← ' + imported.rel + ' (raster)')
        } else if (/\.zip$/i.test(lower)) {
          const buf = await readFile(abs)
          manifest = unpackSvgVideoZip(buf, clipDir)
          resolved.node.data = Object.assign({}, resolved.node.data, videoDataAttrs(Object.assign({}, resolved.meta, { kind: 'svg' })))
          if (manifest.frames.length > 0) {
            try {
              const posterSvg = readFrameSvg(clipDir, manifest, 0)
              resolved.node.style = styleWithSvgMarkup(resolved.node.style || '', posterSvg, '0')
            } catch (error) {
              // ignore
            }
          }
          recordChanged(id)
          notes.push('importMedia ' + id + ' ← svg-video zip (' + manifest.frames.length + ' frames)')
        } else {
          throw new Error(where + ': unsupported media file (use .webm/.mp4/.mov/.mkv or .zip)')
        }
        continue
      }

      if (kind === 'extractFrames') {
        // 宿主侧解不了视频：真实抽帧由客户端（<video> + canvas）写 stills/。
        // 两种用法：
        //   1) 只回报 —— `{op:'extractFrames', id}`：回执照抄 stills 数量（模型拿它看进度）。
        //   2) 下计划 —— 带上 seconds/fps/width，宿主把计划挂给画布，浏览器按计划抽帧。
        const every = Math.max(1, Math.floor(numberOr(op.every, 1)))
        const max = Math.max(1, Math.floor(numberOr(op.max, 24)))
        const source = findSourceFile(clipDir, manifest)
        const stills = listStillIndices(clipDir)
        const wantsPlan = has(op, 'seconds') || has(op, 'fps') || has(op, 'width') || has(op, 'from')
        const plan =
          wantsPlan === true
            ? {
                from: Math.max(0, numberOr(op.from, 0)),
                seconds: Math.max(0.1, Math.min(3600, numberOr(op.seconds, 5))),
                fps: Math.max(0.1, Math.min(60, numberOr(op.fps, manifest.fps))),
                width: Math.max(16, Math.min(2048, Math.round(numberOr(op.width, manifest.width)))),
                max: Math.max(1, Math.min(1200, Math.floor(numberOr(op.max, 360)))),
              }
            : null
        if (out !== undefined && out !== null) {
          if (Array.isArray(out.media) === false) out.media = []
          out.media.push({
            op: kind,
            id: id,
            clip: resolved.meta.clip,
            hasSource: source !== null,
            ...(source !== null ? { source: source.rel } : {}),
            stills: stills.length,
            plan:
              plan !== null
                ? Object.assign({}, plan, { note: '已交给宿主后台抽帧，完成后写入 stills/' })
                : { every: every, max: max, note: '带上 seconds/fps/width 提交宿主抽帧任务' },
          })
          // 计划由 applyOps 收集、由外层挂到画布轮询上（见 diagram_apply 尾部）。
          if (plan !== null) out.extract = Object.assign({ clip: resolved.meta.clip }, plan)
        }
        notes.push(
          'extractFrames ' + id + ': source=' + (source !== null ? source.rel : 'none') +
            ', stills=' + stills.length + (plan !== null ? ', plan=' + plan.seconds + 's@' + plan.fps + 'fps ' + plan.width + 'w' : ' (report only)'),
        )
        continue
      }

      if (kind === 'traceFrame') {
        const index = Math.floor(Number(op.index))
        if (has(op, 'removeBg') === false) {
          throw new Error(
            where +
              ' 必须显式传 removeBg:true（抠背景）或 removeBg:false（保留背景）；不再支持 auto / 省略',
          )
        }
        if (typeof opctx.readBytes !== 'function' && existsSync(joinPath(clipDir, 'stills', String(index + 1).padStart(4, '0') + '.png')) === false) {
          // still 在 clip 内，直接读盘即可
        }
        let png
        try {
          png = readStillPng(clipDir, index)
        } catch (error) {
          throw new Error(where + ': ' + messageOf(error) + ' —— 先 extractFrames 下发抽帧计划并等待 stills/ 写出')
        }
        const raster = await decodeRaster(png)
        const traced = await opctx.traceRaster(raster, op)
        if (traced.svg.length > MAX_FRAME_SVG_CHARS) {
          throw new Error(where + ': traced svg too long (' + traced.svg.length + ' > ' + MAX_FRAME_SVG_CHARS + ')')
        }
        manifest = writeFrameSvg(clipDir, manifest, index, traced.svg)
        if (resolved.meta.posterFrame === index) {
          resolved.node.style = styleWithSvgMarkup(resolved.node.style || '', traced.svg, '0')
          recordChanged(id)
        }
        if (out !== undefined && out !== null) {
          if (Array.isArray(out.trace) === false) out.trace = []
          out.trace.push(Object.assign({ frame: index, id: id }, summarizeTraceForAi(traced.metrics)))
        }
        notes.push('traceFrame ' + id + '[' + index + '] → ' + traced.svg.length + ' chars')
        continue
      }

      if (kind === 'exportSvgVideo') {
        const zip = packSvgVideoZip(clipDir)
        const outName =
          typeof op.out === 'string' && op.out.length > 0
            ? op.out
            : basenamePath(drawioPath).replace(/\.(?:drawio|drawai)$/i, '') + '-' + resolved.meta.clip + '.svgvideo.zip'
        if (typeof opctx.writeWorkspaceFile !== 'function') {
          throw new Error(where + ': cannot write export file')
        }
        const written = await opctx.writeWorkspaceFile(outName, zip, where)
        if (out !== undefined && out !== null) {
          if (Array.isArray(out.media) === false) out.media = []
          out.media.push({ op: kind, id: id, path: written, bytes: zip.length })
        }
        notes.push('exportSvgVideo ' + id + ' → ' + written)
        continue
      }

      if (kind === 'exportMediaSource') {
        const source = findSourceFile(clipDir, manifest)
        if (source === null) throw new Error(where + ': no source.* video in clip')
        const outName =
          typeof op.out === 'string' && op.out.length > 0
            ? op.out
            : basenamePath(drawioPath).replace(/\.(?:drawio|drawai)$/i, '') + '-' + resolved.meta.clip + '-' + source.rel
        if (typeof opctx.writeWorkspaceFile !== 'function') {
          throw new Error(where + ': cannot write export file')
        }
        const buf = await readFile(source.abs)
        const written = await opctx.writeWorkspaceFile(outName, buf, where)
        if (out !== undefined && out !== null) {
          if (Array.isArray(out.media) === false) out.media = []
          out.media.push({ op: kind, id: id, path: written, bytes: buf.length })
        }
        notes.push('exportMediaSource ' + id + ' → ' + written)
        continue
      }
    }

    throw new Error(
      'ops[' + i + '] unknown op ' + JSON.stringify(kind) +
        '. Supported: addNode, addEdge, setLabel, setLabelPos, setStyle, setEdge, order, duplicate, addLayer, setLayer, setLayerProps, move, remove, highlight, ' +
        'listFrames, getFrame, setFrame, appendFrames, setMediaMeta, importMedia, extractFrames, traceFrame, exportSvgVideo, exportMediaSource',
    )
  }
  // 结构化返回"这次到底动了什么"：模型要用新建的 id（或确认改到了谁）时不必解析 summary 文本。
  if (out !== undefined && out !== null) {
    out.created = created
    out.changed = changed
    out.removed = removed
  }
  return notes
}

/** 分层自动布局：DFS 去回边 → 最长路径分层 → 重心排序减交叉 → 逐层居中定位
 *  （树/森林再补一遍"父节点居中于孩子"，见末尾那一段）。 */
function autoLayout(doc, mode) {
  const nodes = doc.nodes
  if (nodes.length === 0) return

  if (mode === 'grid') {
    const cols = Math.max(1, Math.round(Math.sqrt(nodes.length)))
    const rows = Math.ceil(nodes.length / cols)
    const colW = []
    for (let c = 0; c < cols; c += 1) colW.push(0)
    const rowH = []
    for (let r = 0; r < rows; r += 1) rowH.push(0)
    for (let i = 0; i < nodes.length; i += 1) {
      const c = i % cols
      const r = Math.floor(i / cols)
      const w = numberOr(nodes[i].w, DEFAULT_W)
      const h = numberOr(nodes[i].h, DEFAULT_H)
      if (w > colW[c]) colW[c] = w
      if (h > rowH[r]) rowH[r] = h
    }
    const colX = []
    let px = 0
    for (let c = 0; c < cols; c += 1) {
      colX.push(px)
      px += colW[c] + GAP_CROSS
    }
    const rowY = []
    let py = 0
    for (let r = 0; r < rows; r += 1) {
      rowY.push(py)
      py += rowH[r] + GAP_CROSS
    }
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].x = colX[i % cols]
      nodes[i].y = rowY[Math.floor(i / cols)]
    }
    return
  }

  const index = {}
  for (let i = 0; i < nodes.length; i += 1) index[nodes[i].id] = i

  const outgoing = {}
  for (let i = 0; i < doc.edges.length; i += 1) {
    const e = doc.edges[i]
    if (index[e.from] === undefined || index[e.to] === undefined) continue
    if (e.from === e.to) continue
    const key = typeof e.id === 'string' ? e.id : '#' + i
    if (outgoing[e.from] === undefined) outgoing[e.from] = []
    outgoing[e.from].push({ to: e.to, key: key })
  }

  // 去掉回边，保证分层在含环图上收敛（否则层号会一轮轮涨到爆）。
  const color = {}
  const isBack = {}
  function visit(id) {
    color[id] = 1
    const list = outgoing[id] === undefined ? [] : outgoing[id]
    for (let i = 0; i < list.length; i += 1) {
      const target = list[i].to
      if (color[target] === 1) {
        isBack[list[i].key] = true
        continue
      }
      if (color[target] === undefined) visit(target)
    }
    color[id] = 2
  }
  for (let i = 0; i < nodes.length; i += 1) if (color[nodes[i].id] === undefined) visit(nodes[i].id)

  const usedEdges = []
  for (let i = 0; i < doc.edges.length; i += 1) {
    const e = doc.edges[i]
    if (index[e.from] === undefined || index[e.to] === undefined) continue
    if (e.from === e.to) continue
    const key = typeof e.id === 'string' ? e.id : '#' + i
    if (isBack[key] === true) continue
    usedEdges.push(e)
  }

  const layer = {}
  for (let i = 0; i < nodes.length; i += 1) layer[nodes[i].id] = 0
  for (let iter = 0; iter < nodes.length; iter += 1) {
    let changed = false
    for (let i = 0; i < usedEdges.length; i += 1) {
      const e = usedEdges[i]
      if (layer[e.to] < layer[e.from] + 1) {
        layer[e.to] = layer[e.from] + 1
        changed = true
      }
    }
    if (!changed) break
  }

  let top = 0
  for (let i = 0; i < nodes.length; i += 1) if (layer[nodes[i].id] > top) top = layer[nodes[i].id]
  const buckets = []
  for (let L = 0; L <= top; L += 1) buckets.push([])
  for (let i = 0; i < nodes.length; i += 1) buckets[layer[nodes[i].id]].push(nodes[i])

  const pos = {}
  for (let L = 0; L <= top; L += 1) for (let i = 0; i < buckets[L].length; i += 1) pos[buckets[L][i].id] = i
  const preds = {}
  for (let i = 0; i < usedEdges.length; i += 1) {
    const e = usedEdges[i]
    if (preds[e.to] === undefined) preds[e.to] = []
    preds[e.to].push(e.from)
  }
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let L = 1; L <= top; L += 1) {
      const row = buckets[L]
      if (row.length < 2) continue
      const score = {}
      for (let i = 0; i < row.length; i += 1) {
        const id = row[i].id
        const list = preds[id]
        let sum = 0
        let count = 0
        if (list !== undefined) {
          for (let k = 0; k < list.length; k += 1) {
            const p = pos[list[k]]
            if (p !== undefined) {
              sum += p
              count += 1
            }
          }
        }
        score[id] = count > 0 ? sum / count : pos[id]
      }
      row.sort(function (a, b) {
        const d = score[a.id] - score[b.id]
        if (d !== 0) return d
        return pos[a.id] - pos[b.id]
      })
      for (let i = 0; i < row.length; i += 1) pos[row[i].id] = i
    }
  }

  const horizontal = mode !== 'dagre-tb'
  const thick = []
  const cross = []
  for (let L = 0; L <= top; L += 1) {
    let t = 0
    let c = 0
    for (let i = 0; i < buckets[L].length; i += 1) {
      const n = buckets[L][i]
      const w = numberOr(n.w, DEFAULT_W)
      const h = numberOr(n.h, DEFAULT_H)
      const primary = horizontal ? w : h
      const secondary = horizontal ? h : w
      if (primary > t) t = primary
      c += secondary + (i > 0 ? GAP_CROSS : 0)
    }
    thick.push(t)
    cross.push(c)
  }
  let maxCross = 0
  for (let L = 0; L <= top; L += 1) if (cross[L] > maxCross) maxCross = cross[L]

  let along = 0
  for (let L = 0; L <= top; L += 1) {
    let offset = (maxCross - cross[L]) / 2
    for (let i = 0; i < buckets[L].length; i += 1) {
      const n = buckets[L][i]
      const w = numberOr(n.w, DEFAULT_W)
      const h = numberOr(n.h, DEFAULT_H)
      if (horizontal) {
        n.x = Math.round(along)
        n.y = Math.round(offset)
      } else {
        n.y = Math.round(along)
        n.x = Math.round(offset)
      }
      offset += (horizontal ? h : w) + GAP_CROSS
    }
    along += thick[L] + GAP_PRIMARY
  }

  // ── 树/森林：改用"父节点居中于孩子"的摆法 ────────────────────────────────────
  //
  // 上面的逐层居中是"整层一起居中"，于是**父节点会正好压在某个孩子头上**：
  // 实测一棵完整的二叉树（A；B/C；D/E/F/G）排出来是
  //     A(180)  B(130)  C(230)  D(30) E(130) F(230) G(330)
  // —— B 落在 E 的正上方、D 甩在左边；而教科书（也是人的直觉）是父节点在两个孩子**中间**。
  //
  // 这一个 pass 只对**每个节点至多一个父**的图生效：二叉树、组织架构图、决策树都是这种。
  // 多父的 DAG（依赖图那种）保持原样 —— 那里"居中于父"本来就没有唯一答案。
  //
  // 两步，都只动**交叉轴**（tb 是 x、lr 是 y）：
  //   1. 自下而上：有孩子的节点摆到"最左孩子中心 … 最右孩子中心"的中点；
  //   2. 每一层从左往右：谁离左邻居太近就往右让（只让本节点，不搬子树）
  //      —— 对称的树（绝大多数）根本不会触发，只有真挤在一起时才牺牲一点居中换不重叠。
  const parentOf = {}
  const childrenOf = {}
  let forest = true
  for (let i = 0; i < usedEdges.length; i += 1) {
    const e = usedEdges[i]
    if (parentOf[e.to] !== undefined && parentOf[e.to] !== e.from) {
      forest = false
      break
    }
    parentOf[e.to] = e.from
    if (childrenOf[e.from] === undefined) childrenOf[e.from] = []
    childrenOf[e.from].push(e.to)
  }
  if (forest) {
    const byId = {}
    for (let i = 0; i < nodes.length; i += 1) byId[nodes[i].id] = nodes[i]
    const sizeOf = (n) => (horizontal ? numberOr(n.h, DEFAULT_H) : numberOr(n.w, DEFAULT_W))
    const crossOf = (n) => (horizontal ? n.y : n.x)
    const setCross = (n, value) => {
      if (horizontal) n.y = Math.round(value)
      else n.x = Math.round(value)
    }
    for (let L = top - 1; L >= 0; L -= 1) {
      const row = buckets[L]
      for (let i = 0; i < row.length; i += 1) {
        const kids = childrenOf[row[i].id]
        if (kids === undefined || kids.length === 0) continue
        let lo = Infinity
        let hi = -Infinity
        for (let k = 0; k < kids.length; k += 1) {
          const kid = byId[kids[k]]
          if (kid === undefined) continue
          const c = crossOf(kid)
          if (c < lo) lo = c
          if (c > hi) hi = c
        }
        if (lo <= hi) setCross(row[i], (lo + hi) / 2)
      }
      for (let i = 1; i < row.length; i += 1) {
        const prev = row[i - 1]
        const cur = row[i]
        const minGap = sizeOf(prev) / 2 + GAP_CROSS + sizeOf(cur) / 2
        const gap = crossOf(cur) - crossOf(prev)
        if (gap < minGap) setCross(cur, crossOf(prev) + minGap)
      }
    }
  }
}

/** `layout:'none'` 时的补位：只补缺失的那一轴，不覆盖已给的坐标。 */
function placeMissing(doc) {
  let maxY = 0
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    if (Number.isFinite(Number(n.y))) {
      const bottom = Number(n.y) + numberOr(n.h, DEFAULT_H)
      if (bottom > maxY) maxY = bottom
    }
  }
  let slot = 0
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const n = doc.nodes[i]
    const hasX = Number.isFinite(Number(n.x))
    const hasY = Number.isFinite(Number(n.y))
    if (hasX && hasY) continue
    if (!hasX) n.x = slot * (DEFAULT_W + GAP_CROSS)
    if (!hasY) n.y = maxY + 80
    slot += 1
  }
}

/** 画布写回端点：人工编辑唯一的落盘通道。 */
export const SAVE_PATH = '/drawai/api/save'
/**
 * 只读诊断端点：把"这次到底注册了哪几个 host 工具"直接摆出来。
 * 起因是 issue #8 —— 画布能用、apply 也确实跑过，但模型侧一个工具都没有；
 * 现场只有一张截图，缺的正是这条数据（没注册 / 注册报错 / 注册完又被回收）。
 */
export const DIAGNOSTICS_PATH = '/drawai/api/diagnostics'
/** 「打开」菜单最多下钻几个子目录 —— 不做全盘递归，避免撞上 node_modules 这类大目录。 */
const MAX_SCAN_DIRS = 12
/** 自定义请求头 —— 跨站表单设不了它，跨域 fetch 会被预检拦住（CSRF 围栏）。 */
export const SAVE_HEADER = 'x-drawai-save'
/** 普通写回（存盘 / list / export-result 等）的请求体上限，防止一次误发把内存打满。 */
const SAVE_MAX_BYTES = 4 * 1024 * 1024
/** 画布包含原图 data URI 与复刻 SVG，使用独立的有界预算。 */
const CANVAS_SAVE_MAX_BYTES = 128 * 1024 * 1024
const IMAGE_TRACE_MAX_BYTES = 96 * 1024 * 1024
/**
 * 「看一眼」PNG 回执（action: render-result）单独放开：base64 比原图大约大 1/3，
 * 大图按 2× 渲很容易超过 4MB。控制请求、原图绘制和画布写回分别限制。
 */
const RENDER_RESULT_MAX_BYTES = 32 * 1024 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body exceeds ' + limitBytes + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export const name = 'drawai'
export const inject = ['tools', 'fs', 'sessions', 'sandboxPolicy', 'webServer']

/**
 * 插件**自带**的使用说明，以"内嵌技能"注册给 DSH 的 skill 注册表
 * （`ctx.skills.register()`，见 apply() 末尾）。
 *
 * 为什么要有它：工具名/描述/schema 本来就随 `lib/index.js` 一起装到任何机器上，模型一定看得到；
 * 但 README、源码、tools/ 都不会跟着插件走（`package.json.files` 只有 lib 与 cordis.patch.yml）。
 * 换了电脑、只装了插件时，模型能依仗的就只剩那段工具描述。技能是 DSH 为此准备的**正规通道**：
 * 它出现在会话的技能目录里，模型需要时按需取全文 —— 于是"怎么在这张画布上操作"这件事
 * 跟着插件走，而不是跟着这份仓库走。
 *
 * **拆成两份**（drawai-canvas / drawai-video），因为这是两种任务、两套工具族：画布那份讲
 * diagram_read / diagram_apply 的全部 op 与几何规则，视频那份讲十步制作流程与 motion_* 那组工具。
 * 合成一份时正文近三万字，而技能目录里只显示 description 那一句 —— 用户说"做个宣传片"会先被
 * "读写画布"这句挡住；分开后两条简介各自对口，画图的人也不必每次为视频流程付上下文。
 * 视频那份自带一段"画布最小集"（见下），单独加载也不会写错 op；画布那份末尾指向视频技能。
 *
 * 写成模板串但**不用反引号**（markdown 里要写示例，反引号会破坏模板串）：代码块用四空格缩进。
 * 两份各自是独立模板串；`tools/build.mjs` 的反引号配平检查按整份文件数，照样管得住。
 */

/** 技能 1/2：视频。位置保持原样（正文接在原来的地方），改动只剩标题与开头那段最小集。 */
const SKILL_BODY_VIDEO = `# DrawAI 画布做视频：从问到出片

这个技能只讲**怎么把一条片子做出来**。画布怎么读、怎么改（diagram_read / diagram_apply 的完整签名、
折点与端点、图层与顺序、traceImage 位图矢量化）在技能 drawai-canvas 里 —— 视频流程真正用到的那几个 op
下面列全了，不够用时再加载那个技能。

## 画布最小集（视频只用到这些 op）

    // 1) 先读回当前那张画布：用户说"这张"就别猜路径，不传 path 读一次
    diagram_read()                       // → { path, absolute, nodes, edges, ... }，path 拿去给 apply
    // 2) 一次写完：建节点、连卡、放分镜表；几何已经规划好就 layout:"none"
    diagram_apply({ path, layout:"none", ops:[
      {op:"addNode", label:"分镜表", shape:"text", x:40, y:40, w:520, h:360, as:"board"},
      {op:"addNode", label:"主片", shape:"video", x:600, y:40, w:480, h:270, as:"film"},
      {op:"addEdge", from:"shot-card", to:"film"}   // shot-card 是画布上已存在的镜头卡 id
    ]})

- **path 必填**：diagram_apply 永远要显式传 path；diagram_read 不传时返回当前聚焦的那张。
- **from / to 必须是已存在的节点 id**（写错在写盘前就报错）；as 起的别名只在同一次 ops 数组里有效。
- **建了镜头卡就必须连**：断连的卡既没进 assets、也不排期，motion_project create 会直接报错。
- 连线用圆角折线，折点自己规划（points 只放中间转折，不放源/目标连接点），不要启用自动避障。
- 挪位置用 move，改文字用 setLabel，换样式用 setStyle；改一组就传 ids:[...]。改接边用 setEdge，
  不要 remove + addEdge 重画 —— 那会丢掉端点约束和折点。

## 视频节点与工作流编排

画一条视频分十步，执行者就是你自己。**第 0 步（问人）、品牌素材、定卡并连卡、分镜表、样片，这五步不能跳**。

0. 先问人，再动手 — **没问过风格就开工是最贵的错**。用 ask_user_question 一次问齐这四件事（不要每步都打断）：
   - 风格与气质：暗底开发感 / 明亮克制 / 高饱和冲击 / 复古纸质 / 电影感黑金……有没有参考片、参考站；
   - 主题与受众：给谁看（开发者、客户、投资人），最想让人记住的一件事是什么；
   - 规格：时长、画幅（16:9 横屏 / 9:16 竖屏）、要不要旁白与字幕、要不要真声音乐；
   - 品牌资产从哪来：官方 logo/字标、图标、产品界面截图 —— 用户直接给文件，还是授权你去官方站取。
   能推断的先推断，写成默认项一起问（"我按 16:9 / 30s / 不要旁白来做，除非你说别的"）。用户回"你定"就自己定，然后明确说你定了什么。**风格没定之前不要 create 工程**；答案要落进 BRIEF.md 与分镜表。
   问完不要直接开工：先给 **2–3 个风格方向**（每个 6 行以内：一句话概念 / 参考质感 / 运镜语汇 / 适合什么内容 / 不适合什么），让他选一个。给"暗底开发感 / 明亮克制"这种空词没有用，要给看得见的画面。

1. 素材与品牌（先收集，再动笔）— 片子里会出现的一切"真东西"都先收齐，不许凭印象画：
   - **要整个站点就用 gather**：motion_assets {action:"gather", url, brand, pages, limit, dryRun} 扫首页 + 导航里挑出的内页（默认 4 页），把 favicon、og:image、主视觉、产品截图、内联字标一次收齐，跨页聚合**实测配色**（hex + 出现次数）与字体，再补三条品牌 logo 兜底（Simple Icons 矢量 / Clearbit 512 / 高清 favicon），并给每页一张 2 倍视口截图。先 dryRun:true 看清单，再正式收（默认 12 张）。品牌名与域名都写不准时，只给 brand 也能先拿到 logo。
   - **只关心一个页面就用 collect**：{action:"collect", url}，同样的扫描，只扫这一页（默认 8 张）。
   - **官方品牌资产**：web_search 找「<品牌> brand guidelines / press kit / logo svg」→ read_page 读规范（最小留白、禁止变形、标准色、黑白版规则）→ logo 具体直链用 {action:"fetch", url} 取原始矢量（别截图、别重画）。
   - **用户能给文件就用用户的**（{action:"capture", path}）；界面要分层或只截一块，用 {action:"page", url} 再 {action:"crop"}。
   - 找不到官方素材就直说，把"用纯文字占位"当成待确认提案问用户 —— 不要默默换成一个"看起来像"的字体（一眼假，最掉价）；
   - 截图里影响版面的水印、乱码，用 crop 裁掉或换素材。
   收完先把返回的 colors 与 fonts 对进 theme.ts：**页面实测值**比凭感觉调色更像；fontSources 里 googleFonts 为 true 的可以照 cssUrl 去取真字体，其余退回系统字（在 BRIEF.md 里写明"字体非官方"）。素材不止图片：图标、纹理、产品界面、波形、色板都算，缺哪类就补哪一个 url。
   规矩：不改比例、不改描边、不重上色（官方允许的黑白版除外）；字标的大小写、字重、字距按官方来。

2. 定镜头表（设计，不写代码）— 先用 shotcraft_search 按关键词/分类找准确的卡名与样式；**对选中的卡再用 cardId+styleKey 搜一次**，把它的配方（recipe：参数表、动效核心、已知坑）和 demo 源码读回来。跳过这一步，卡就只是个标签。然后用 diagram_apply addNode {shape:"shotcard",cardId,styleKey,x,y,as:"shot"} 建卡、addEdge 从卡连到视频节点，连线顺序就是镜头顺序。**建了卡就必须连**：没连的卡不会进 assets、不参与排期，create 会直接报错——断连不是"只作参考"，是三样一起丢。
   如果这条片子要的是**整片视觉语言**（扁平矢量、线条、等轴、拼贴、包豪斯、像素、HUD…），先用 mg_style {action:"list"} 挑一种，{action:"read", slug} 读它的施工包（判据/色板/节奏/移植 brief），再 diagram_apply addNode {shape:"mgstyle", slug} 连到视频节点。两者分工：风格管整片（色板、字体、节奏、动效语法），镜头卡管单镜运动方式，可以同时用；一条片子只用一种整片风格。
   **引擎是硬约束**：read 返回里的 engines 就是上游真用的引擎（three / webgl2 / webgl / canvas2d / dom），engineFiles 是证据文件。上游用 three.js 或 WebGL2 的，移植必须真的跑同一套引擎——three 或 @remotion/three 在 canvas 上渲染，或原生 WebGL2 + GLSL；**不许用 CSS 3D、div 层叠、Canvas2D 渐变模糊「简化」替代**。STYLE.md 的「引擎契约」写了上游证据与逐引擎做法；motion_render 启动前会扫工程源码，重引擎缺失直接拒绝渲染。
   **动效也是硬约束**：read 返回里的 motion 是从上游源码抽出来的动效画像（转场是 wipe 还是切、有没有 impact/冲击环、相机漂移、motion blur 几采样、颗粒多粗、有哪些二次运动）。**写场景前先 mg_style {action:"frames", slug} 取 8 张参考帧，用 read_image 逐张看**——brief 只写「是什么」，帧才写「怎么动」。STYLE.md 的「效果配方」是必做项：只把形状做对、转场用淡入淡出、落地不压不抖、颗粒几百个点，出来的就是「形似而动不像」，这是最常见也最贵的返工。
3. 写分镜表（画布上是**一张表**，不是一镜一个节点）— motion_spec {action:"scaffold", nodeId, storyboard:[{intent 这一镜要做什么, onScreen 屏幕上出现什么, copy 配什么字, card 镜头卡}], style, narration} 返回把【分镜表】/【风格】/【旁白】摆到视频附近空位的 diagram_apply ops，ops 原样交给 diagram_apply（layout:"none"）。表是 Markdown 六列（镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音），**每一镜写成表里的一行**；帧区间写 \`0–35f\` 或 \`1.5s\`，各镜之和必须等于视频节点时长。
   **绝对不要一镜建一个文本节点**——那样 motion_project 读不到分镜，画布上也不再是一张表（motion_spec {action:"validate"} 会把这件事故直接报出来）。**没有分镜表不要开写场景**；功能点对不上镜头就先改表。
4. 建工程 — motion_project {action:"create", nodeId, spec:{width,height,fps,duration}, prompt}。没显式给 storyboard 时它**直接读画布上的【分镜表】**（所以上一步那张表就是真相源），按镜头卡排 timeline.json，段数=卡数；没挂卡时返回里会明确写「均分，未挂镜头卡」并给 warning。**想控制总时长不用断连**：显式给 spec.duration 时，卡片按相对时长等比缩放到总长，不会被卡的总和改短。
5. 样片（pilot）— 除非用户明确要求跳过，先做可在画布播放的样片，便于及时检查：
   - 先只写 scene-0，motion_preview {nodeId} 看一帧定调，把纸色、字重、留白、动效气质定住；不对就改 scene-0 重看，别写完四段再回头返工；
   - 挑能代表整片风格的 3–6 秒：对主视频节点调用 motion_render {action:"start", nodeId:"主视频节点", range:[起,止]}，记下返回的 pilot jobId；需要时用同一主视频节点和 jobId 调 status，确认 done。文件 .out/pilot.mp4 出现或静帧预览成功都不代表已展示给用户；
   - **样片渲染完成后必须主动回填**：在同一画布、同一页用 diagram_apply addNode {shape:"video", label:"样片", x, y, w:480, h:270} 新建节点并记住其 ID（已有合适样片节点时复用）；再调用 motion_render {action:"apply", nodeId:"样片节点 ID", jobId:"pilot jobId", source:"pilot"}。核对返回 kind=pilot、nodeId 和画布节点，向用户指出样片位置；失败则说明错误和文件路径。不要把样片写进主视频节点，主节点留给整片；
   - 样片要有真实排版、真实字重、真实配色、至少一处动效，**不是静态海报**；发给用户的是**渲染出来的 mp4**（回填到节点），不是静帧拼图——拼图会把 1920 缩到 650 宽，细线全糊，双方都会误判；
   - 用户要求先看样片再继续时，展示后等待反馈；用户已要求直接完成时可继续制作，不额外设置确认关卡。用户明确要求跳过样片时按其要求执行。
6. 写画面 — 用 read/edit 直接改 scene-<n>.tsx，对照读回来的 demo 源码复刻动作顺序、缓动、错峰。一场景一文件，单文件不超过 120 行；共享原语放 components/，上游组件可直接 import（别名 @shotcraft/lib/DigitRoll、@shotcraft/demos/<路径>）。场景里写相对本段的帧号，时间轴只改 timeline.json 的 startFrame/durationFrames。
7. 看图与补素材 — 改完必看，不要凭想象交付：motion_preview {nodeId, frames:[...]} 同一轮返回拼图，第一次要打包（10–30 秒），之后复用缓存只要几秒。**每镜写完做一次"同段对照"**：把 mg_style frames 的参考帧与 motion_preview 的成片帧并排看，按 STYLE.md「效果配方」逐项打勾（转场/冲击/相机/运动模糊/颗粒/二次运动），对不上就改，别等整片。缺真图时用 motion_assets：action:"capture" 把原始字节搬进 assets/（同时给尺寸与色板），action:"crop" 取局部，**action:"page" 用无头 Chrome 把一段 HTML 模板或网址截成 2 倍图**（写产品界面镜头用它，别自己先截图）。场景里 staticFile("文件名") 取。画布快照会被缩放重绘，精度要求高就走这一步。
8. 配声音与踩点 — 音频和画面同一条时间轴（timeline.json 的 audio[]），渲染时由 entry 统一挂 <Audio>，不是成片后再混。motion_audio {action:"add", nodeId, file 或 audioNodeId, role:"bgm"|"voice"|"sfx", at:秒, gainDb, fadeIn, fadeOut, duck} 放置音轨（素材没进工程会自动捕获）；role:"bgm" 默认 -10dB 且旁白自动避让。音效优先检查用户素材和本地库；不合适时再用 motion_sfx：search 按声音需求搜索，get 下载并保存音频索引，返回里的 suggestedGainDb 直接当 gainDb 用。踩点用 motion_audio {action:"analyze"} 量 BPM/网格残差/重音三分类/音源峰值滞后，bpm 为 null 就别硬对；action:"apply" 把切点吸到拍子上，带 cueId 可把某条音轨钉到某一帧（自动扣音源滞后与 1.29 帧输出偏移）。
9. 出片 — motion_render {action:"start"} 立刻返回 jobId，绝不等待；用 action:"status" 查进度。只渲几帧用 frames；range 渲出来的是**样片（pilot）**，不要拿它当整片。出片后 action:"apply" 把 film.mp4 回填成节点上的 clip pack（画布上直接能播）。
   **成片必须自己写回**：motion_qa 一过就立刻 motion_render {action:"apply", nodeId:"主视频节点 id"} 回填到主视频节点——apply 找的是最近一次**整片** film 任务，不会拿样片顶替；不要等用户开口要，他看不到工作区里的 mp4，只看得见画布上的节点。回填后海报取片长 35% 处（深色片子 0.4s 是黑帧，缩略图会像空节点）。

**最常翻车的六件事**：① 没问风格就开工，整片气质跑偏，返工最贵；② 拿系统字体假装品牌字标（用户一眼看出不是官方 logo）；③ 只有一张静帧就说"定调好了"，没出样片就让人看整片；④ 镜头卡建了却没连线——参考、顺序、段长一起丢，画布上看着"有卡"，工程里却没排期；⑤ 重引擎风格（three / WebGL2）用 CSS 或 Canvas2D 简化替代——静帧能骗、一动就露，render 会直接拦；⑥ 只做"形"不做"动"——形变过圆、转场靠淡入淡出、落地不压不抖、颗粒像噪点，没看参考帧就写场景，成品和上游差一个档。

素材工作流：用户提供的素材和品牌资源优先；需要纸纹、颗粒、胶带、敲击或乐器单音时，先用 motion_assets {action:"list",nodeId} 看工程素材，再用 {action:"library",nodeId,query:"纸张"} 或 query:"钢琴" / "颗粒" 按需查插件素材库；选中后调用 {action:"use",nodeId,assetId:"返回条目的 id"} 导入，只能用返回的 file。图片在场景里用 staticFile(file)，声音再用 motion_audio {action:"add",nodeId,file,role:"sfx",at:秒} 上时间轴，仅导入不会自动出现在画面或声音里。VCSL 乐器采样是短单音，不是完整背景音乐；检查电平并在样片中试听。现有素材不合适时再找其他来源。素材来源和许可见返回信息，不要将未逐项列明的许可描述为已确认。
插件素材随安装包提供，路径由 motion_assets 管理；上游路径只是素材 id，不是工作区中的磁盘路径。不要猜测插件或上游目录、从其他工程复制同名文件，也不要手写 assets/manifest.json。使用 library 返回的 id 调 use，由工具校验原文件并登记哈希和许可；导入失败时报告具体错误，排查插件安装或环境，不要静默绕过。
以上素材工程配合 motion_project / motion_render；motion_task 使用单独的画布引用素材快照，不会自动读取此工程的 assets。要给 motion_task 使用，需将对应素材导入画布节点并连接视频节点，或使用 motion_project / motion_render 完成制作。

音频素材：audio_asset search/get/import 添加音效、音乐或旁白节点；motion_audio add 也接受 file（本地 mp3/wav/m4a）或画布上的音频节点。生成音乐、TTS 与文本生成音效服务尚未接入。
镜头卡是设计参考，**不进成片画面**；但必须连到视频节点——连线决定它进不进 assets、排第几镜、这一镜多长。想换顺序改连线（或同时改 timeline.json），不要改场景文件里的绝对帧号。
**引擎保真**：选了带引擎的风格，顺序是 读 engines/engineFiles → 用 mg_style action:"source" 读上游那套引擎的实现文件 → 在 scene-*.tsx 里真跑这套引擎（three/@remotion/three、原生 WebGL2+GLSL、或该风格本来就用的 Canvas2D/DOM）→ motion_preview 看帧 → 再出样片。brief 是移植说明，不是换实现的许可；确实要换，先在 STYLE.md 写「偏离：引擎 X 改为 Y，因为 Z」，render 会带 warning 通过。用 CSS/div/静态图冒充实 3D 或 shader，等于把这个风格的判据扔掉。
**画布布局与连线**：先用 diagram_read 查看已有节点、画布尺寸和连线，保留用户已有的位置；按阅读方向分组，同类节点对齐、留出节点和文字间距，并为连线预留清晰通道。视频规格、视频/样片与镜头卡可分区，空间不足时选择另一侧或下方的空位。工作流用圆角折线，**不要使用自动避障**：AI 先确定节点实际 x/y/w/h，再选择合适的 exit/entry，根据画布坐标亲自规划水平/垂直通道和中间折点，以 addEdge {line:"rounded", points:[{x,y},...]} 写入；折点不包含端点。节点或参考的实际位置尚未确定时，先完成布局、diagram_read 读回坐标，再用 setEdge {id,points:[...]} 写入折点。必要时扩大间距，主动检查折线不穿节点或文字、不产生多余折返、交叉或重叠；对齐而不需要转弯时 points 可为空。使用 layout:"none" 保留已规划几何；用户要求自动布局时可先布局再重新规划连线。调整已有自动线时先 setStyle {avoid:false}，再 setEdge 指定折点；保留其他用户明确自定义的线型和未要求修改的手工路径。
**折点与端点分开**：exit/entry 决定节点连接侧，插件会补端点及引出段；points 只填确实需要的中间转折，绝不放源/目标连接点或重复折点。例：A=(60,60,240,140) 右侧中点为 (300,130)，B=(400,40,480,270) 左侧中点为 (400,175)；从 A 右侧到 B 左侧可用 exit:"e",entry:"w",points:[{x:340,y:175}]，不要再加 {x:400,y:175}。若起终点沿进出方向对齐且通道畅通，使用 points:[]。连线后先读回坐标和折点，具备图像通道时用 diagram_read {render:true} 查看实际画布；出现折返、穿线或覆盖文字时用 setEdge 修正，再复查。预览不可用时如实说明未做视觉校验。
参考图：diagram_apply 连接图片节点后会把画布快照冻结进工程 assets/，场景里通过 props.assets 取用。视频参数（宽高/fps/duration）在 motion_project create 时写入节点；用户指定时长必须显式传 duration（支持 9.3 等小数秒），不能只写在 prompt 里。
旧任务记录用 motion_task list/status/cancel/apply/focus/remove 管理，不要再指望它 start。多页或多个视频时明确指定 page/nodeId。
不要把这条流程想成"提交一个任务等结果"：你是在一个普通工程里写代码、看图、渲染，每一步都由本次对话直接完成。
`

/** 技能 2/2：画布。正文从原来的位置原样接上，只多了标题下的一条"做视频去那边"。 */
const SKILL_BODY_CANVAS = `# DrawAI 画布：怎么读、怎么改

## 一句话
工作区里任何一个 .drawio 文件**就是**一张 DrawAI 画布 —— 它是 drawio 自己的 mxfile 格式。
用户在 DSH 右栏画布面板里看到的、以及用 drawio 桌面版打开的，是同一份文件；
没有"导入/导出"这一步，你直接读写这个文件就是读写那张画布。

视频节点、镜头卡、分镜表也都是这张画布上的对象，但**做视频**（选卡、写分镜表、出样片与成片）
是另一套流程：加载技能 drawai-video。这里只讲怎么读写它们。

## 两个工具怎么配合
1. **diagram_read(path?, layer?, ids?)** —— 先读。返回节点（id/label/shape/style/**x·y·w·h 坐标尺寸**）、
   边（id/from/to/label/style/dash/arrow/折点/悬空端的自由点/标签位置 labelX·labelY）、
   revision（**文件内容指纹**，不是版本号）、page（**纸张尺寸**：文件里写了才有）、
   layers（**图层表**：顺序 = 叠放顺序，含 name/visible/locked）、每个单元的 layer（它在哪一层）、
   notes（画布表示不了但会原样保留的东西：多页、分组、图片、HTML 标签）、
   **selection（用户此刻选中的单元 id）**、highlight（AI 自己请求的高亮，见下）、
   canRevert / revertSteps（AI 的改动还能退回几步，见下）、export（导出状态）。
   fontColor（设过才有）是**字色**的派生名：命中调色板给名字（red/grey…），否则给十六进制。
   visible:false 的层在画布上不画，但里面的单元**照旧读得到** —— 隐藏是显示状态，不是删除；
   想让人看见就提醒用户去「图层」菜单打开。
   **大图先过滤**：layer（层 id 或层名）只看一层、ids 只看几个单元 —— 过滤时返回体会带
   filtered 与 totalNodes/totalEdges（整张有多少），层表照旧整份回。别一上来就把几百个单元读完。
2. **diagram_apply(path, ops, layout?, expectRevision?)** —— 再改。给一组结构化编辑，宿主**无损写回**：只改我们拥有的单元，
   文件其余部分（别的页、未知单元、自定义属性）逐字节保留。打开后原样保存 = 文件一个字节都不变。

写入必须显式传 path。用户说"这张图"时，先用 diagram_read 读取当前聚焦画布，再把返回的 path 传给 diagram_apply；无法确认目标时先打开画布。改完可以再 read 一次自查。

**当前是哪一张，有两个来源**：用户在画布面板里切换标签页时，宿主会把"当前画布 = <路径>"
**注入到会话里**（你会看到一条 plugin 来源的上下文）；不放心时也不带 path 调一次
diagram_read —— 返回里的 path 就是它（这两条是一致的，同一个记录）。

**"这几个"是哪几个**：用户在画布上选中的单元会随 diagram_read 一起回来（selection）。
用户说"把这几个挪一下/换个颜色"时就用那些 id —— 别靠坐标猜。选中的是连线也一样能用
（setStyle/move/remove 都收边 id）。没人选时它是空数组。

**读到的 revision 别扔**：下次改这张图时把它当 expectRevision 传进来。对不上（用户在 drawio 里
改过、或另一个会话动过）调用会**直接失败、一个字节都不写** —— 重新 read 一次拿新指纹再改。
不传就是不检查（并发编辑时可能覆盖别人的改动，所以"读过再改"的流程里最好都传）。

手动布线：先读取或确定节点位置，按画布实际 x/y/w/h 为每条工作流边设计避开节点和文字的水平/垂直通道；addEdge / setEdge 用 points:[{x,y},...] 按源端到目标端顺序指定中间折点（不含端点），绝对画布坐标、保留小数、不吸附网格，最多1000个。显式 points 切入手动模式；不要同时给 avoid:true。points:[] 清空并保持手动，省略 points 保留原折点。仅用户明确要求自动避障时使用 setStyle{avoid:true,clearPoints:true}；仅用户明确要求非正交逐段连线时使用 line:"straight"。先确定节点位置，再用 layout:"none" 写入并复查。

## ops 速查
    {op:"addNode", label?, as?, shape?, svg?, style?, keys?, data?, w?, h?, x?, y?, fontColor?}
    {op:"addEdge", from?, to?, fromPoint?, toPoint?, as?, label?, points?, style?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, keys?}
    {op:"setLabel", id|ids, label}
    {op:"setLabelPos", id, x?, y?, dx?, dy?, center?}
    {op:"setStyle", id|ids, shape?, svg?, style?, keys?, w?, h?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, clearPoints?}
    {op:"setEdge", id, from?, to?, fromPoint?, toPoint?, points?}
    {op:"order", id|ids, to:"front"|"back"|"up"|"down"}
    {op:"duplicate", id|ids, dx?, dy?, withEdges?, layer?, as?}
    {op:"addLayer", name?, id?, visible?, as?}
    {op:"setLayer", id|ids, layer}
    {op:"setLayerProps", layer, name?, visible?, locked?}
    {op:"export", format?:"svg"|"png", name?}
    {op:"traceImage", image, removeBg, preset?, w?, h?, x?, y?, colors?, colorsDark?, colorsFill?, grid?, gridH?, scale?, epsilon?, minArea?, minRegionArea?, protectLuma?, majorityContrast?, bgColor?, bgSolidTol?, bgSolidBorderRatio?, cropX?, cropY?, cropW?, cropH?, as?, layer?}
    {op:"move", id|ids, dx?, dy?, x?, y?}
    {op:"remove", id|ids}
    {op:"highlight", ids:["n1","n2"]}

- **改接一条边用 setEdge，别 remove + addEdge 重画**：setEdge 只换 source/target（from/to 给节点 id，
  或 fromPoint/toPoint 给绝对点 = 脱开节点变成自由端），边的 **id、标签、标签位置、折点、
  端点约束（exitX/entryX）全都留着** —— 重画会把这些丢掉，还会让别的引用它的地方失效。
- **边上的文字压住线**：diagram_read 回 labelX/labelY（拖过才有；x = 沿边比例 -1..1，0 = 弧长中点、
  y = 垂直偏移 px）。{op:"setLabelPos", id, center:true} 放回中点（= 画布右键「标签居中」）；
  {op:"setLabelPos", id, dy:12} 往上/下挪 12px（dx 是比例，一般别用）。
- **顺序（谁压谁）用 order**：to 是 front（到最上面）/back/up/down，与画布右键的顺序菜单同一套。
  它改的是**文件里单元的先后**（drawio 打开也是这个层叠）。注意"所有边都画在所有节点下面"
  是画布目前的层叠限制，所以"让边压住节点"要放到更上面的**图层**里，不是 order 能解决的。
- **再来一份用 duplicate**：新 id + 整体平移（默认两格 20px，与画布 Ctrl+V 一样），
  折点、端点约束、标签位置、自定义数据都带过去。默认会把"两端都在被复制节点之间"的边一起复制
  （withEdges:false 只要节点）；只列一条接在节点上的边会被拒 —— 把两端节点一起写进 ids。
- **图层**：addLayer 新建一层（加在最上面，返回它的 id）、addNode/addEdge/duplicate 可以带 layer
  （层 id 或层名）、setLayer 把已有单元移到别的层、setLayerProps 改层的名字/显示/锁定。
  隐藏一层是**文档状态**（写进文件，drawio 打开也是隐藏的），不是删除 —— 隐藏层里的单元照旧读得到。
- **导出**：{op:"export", format:"svg"} 会让画布渲染一张 SVG 落在 .drawio 旁边（同名的 .svg，
  可以用 name 指定基名）；format:"png" 则是**浏览器下载**一张 PNG（用户下载目录里）。
  渲染在画布那一半做，所以这一步是"请求"：返回值/下一次 read 里的 export 状态
  pending → done（带文件路径）/ downloaded / failed。看到 pending 说明画布还没刷新 ——
  别反复请求，等下一次 read 再看（或提醒用户打开那张画布）。
- **把一张位图"描"成矢量图用 traceImage**：{op:"traceImage", image:"ref.png", removeBg:false, x:40, y:40}。
  它**真的读那张图的像素**，建成一个 svg 内容节点。
  **不要用"手写一段近似的 svg"冒充复刻** —— 形状词汇表表达不了的照片/插画就直接用这个 op。
  · 默认 **w/h = 原图像素尺寸**、viewBox = 原图像素坐标系（1:1 铺满）。
  · **先选 preset，再按需覆盖单字段**（合并：默认 ← preset ← 显式字段）：
    - preset:"lineart" 插画/线稿（多暗色配额、严保细线）
    - preset:"photo" 照片/渐变
    - preset:"simple" 图标/简单图（少色+降采样，省字符）
    - 不写 = "default"
  · **removeBg 必填**（无 auto）：true = 抠背景（先识纯色底，否则近白泛洪）；false = 整图保留。
    白底/纯色底图标、透明 PNG 通常 true；风景/照片/带场景背景通常 false。回执看 bgRemoved / bgDetect。
  · 调参闭环：看返回值里的 **trace[]**（结构化指标 + hint），不满意就 **remove 旧节点再 traceImage**（改 preset/字段）。
    常见：字符紧 → scale:2 / 加大 epsilon / preset:"simple"；线糊断 → preset:"lineart" 或提高 protectLuma/colorsDark。
  · 单次上限：SVG 标记 250000 字符（整图的精细度主要由它决定：预算紧时管线会抬 epsilon、丢小环，
    把细节压掉——想要更细也可以给 maxBytes 顶到上限，或干脆用下面的裁剪只描局部）；
    输入 PNG（零依赖）与 JPEG/GIF/WebP（需 sharp）。
  · **五官/小物件糊成一团时，别只调参 —— 用 cropX/cropY/cropW/cropH 裁出那一块单独描**：
    工作分辨率上限是 grid（默认 499px 宽），整张立绘塞进去时"脸"只占三四十像素，眼睛只有 3~4px，
    量化后五官必然消失（实测把 colors 拉满 24、protectLuma 提到 235 也救不回来）。
    裁出头部再描，同一块就占满工作图宽度 —— 脸能有一两百像素，五官才留得住。
    裁剪块的 SVG 使用**裁剪局部系**，节点框负责缩放和放置。
    默认 w/h 为裁剪块原始尺寸，x/y 为裁剪原点；显式 w/h 是裁剪块目标尺寸。
    原图若已缩放，x/y 与 w/h 都需按同一比例换算，可与整图那块叠着放（顺序在后 = 画在上面）。

- **改一组用 ids**：{op:"setStyle", ids:["n1","n2","n5"], style:"green"} —— setStyle / setLabel /
  move / remove 都收 ids，不要为了"把这几个改成绿色"发 12 个 op。批量 move 只收 dx/dy
  （给一个绝对 x/y 等于把它们叠成一摞，宿主会直接拒绝）。
- **addNode 的 label 可省或给 ""**：装饰面板 / 底框 / 纯色块不需要字时直接省掉；空 label 时请显式给 w/h
  （否则按最短标签估宽 130）。有字的节点照常写 label。
- **引用刚建的那个用 as**：{op:"addNode", label:"开始", as:"start"} 之后，同一个 ops 数组里
  from/to/id 可以直接写 "start"。id 省略时是自动分配的（n 几/e 几），猜编号在非空画布上必错。
- **返回值里看 created/changed/removed**：新建单元的 id（含自动分配的）在这里，接着引用它们
  不必再 read 一次、也不用去解析 summary 文本。
- id 省略会自动分配（n1/n2…、e1/e2…）；addEdge 的 from/to 必须是**已存在的节点 id**，
  引用了不存在的节点会**在写盘之前**直接报错并列出已知 id。
- **线的两端可以给绝对点**（fromPoint/toPoint）而不是节点：两端都给点就是一条**独立线** ——
  drawio 里边的两端都可以是自由点，线可以完全不接节点（先画线、之后再拖端点接到节点上也行）。
  只有一端给点就是**悬空端**（另一半接在节点上）。
- **move**：改已有元素的位置。节点给 dx/dy（相对）或 x/y（绝对）；连线只能给 dx/dy
  （平移它自己的折点与自由端点；两端接在节点上时端点由节点决定）。
  一整组一起挪就写 ids:[...] + dx/dy —— 与画布上拖选区是同一套语义（相对位置一点不变）。
  以前没有 move，想把某个节点挪一下就只好删掉重画 —— 那会丢 id、丢边上的端点约束与折点。
- **line**（连线线型，四选一）：straight（直线，不带折点）| sharp（直角折线，缺省）|
  rounded（**圆角折线**：只在折点处倒圆角，rounded=1）| curved（曲线，curved=1）。
  line:"straight" 会**清掉折点**；line:"rounded" 只改样式（折点就是折线的拐角，照旧有用）；
  line:"curved" 在边本来就是两点直连时会补一个弓形中点 ——
  因为 drawio 的曲线是把**现有折线**抹圆，两点时它退化成直线（屏幕上什么都看不出来）。
  与它等价的键级写法是 edgeStyle:"none"（直线）、keys:{rounded:1}（圆角）、keys:{curved:1}（曲线）。
- **fontSize**（字号）：节点标签、独立文字、连线上的文字都吃它（drawio 的 fontSize 键）；
  给 null 就是删键回缺省。例：{op:"setStyle", id:"n1", fontSize:18}。
- **fontColor**（**字色**）：节点标签、独立文字、连线上的文字都吃它（drawio 的 fontColor 键）。
  给调色板名（plain|blue|green|orange|yellow|red|purple|grey）就按画布上"文字换色"那一支取色
  （红 = #b85450，不是填充色），给 #b85450 这类色值就原样写，给 null 删键回缺省黑字。
  例：{op:"setStyle", ids:["n1","n2"], fontColor:"#666666"}；连线上的字同理
  （color 是**线本身**的颜色，fontColor 是**字**的颜色 —— 两件事，别混）。
- **highlight** 只是"让画布选中这几个"给你看，不改文档、也不重排。
- **图层现在已经能操作了**（见上面的 addLayer/setLayer/setLayerProps）：新建一层、
  让新单元进指定层、把已有单元移到别的层、改名/显示/隐藏/锁定。
  隐藏层里的单元照旧读得到 —— 隐藏是**显示状态**，不是删除；用户想看见就提醒他去「图层」菜单打开。
- **容器/分组**：单元带 parent 就说明它在某个容器（分组）里。画布按**绝对位置**显示，
  所以 move 一个容器**不会**带走它的子单元、remove 容器则会把子单元接到还活着的祖先上 ——
  要"整组一起动"就把容器和子单元一起写进 move 的 ids 里。分组本身 AI 还不能新建。
- 糖（shape/style/dash/arrow/color/exit/entry/jettySize/edgeStyle/avoid）由宿主翻译成 drawio 的 style 键，
  **绝不落盘**；keys 用来写任意 drawio 键，值给 null = 删键回默认。
- shape：rect | rounded | **text**（独立文字：无边框无底色的一段字）| stadium | ellipse | diamond | parallelogram | cylinder | document | hexagon | **svg**
  **节点标签与无边框节点**：图片、SVG 内容、视频与独立文字不提供无效描边工具，混合选区描边只作用于有边框的图形和连线。
  用户可独立拖动节点文字到节点内部或外部，双击文字编辑（视频标签也一样）。独立文字节点仍整体拖动。
  节点标签偏移以 labelOffsetX/labelOffsetY（像素）回报，写入原生 mxGeometry 的 mxPoint offset；不要与边标签 labelX/labelY 的相对量混淆。
  偏移随保存、复制、撤销保留；移动节点时文字跟随，导出与适应内容包含节点外的文字。
  **视频节点（旁路媒体包）**：
  - **用户导入入口**：右侧「视频」先选本地文件，再点击画布放置；也可拖入视频或 Ctrl+V 粘贴剪贴板中的视频文件。
    仅支持浏览器可解码的 MP4/WebM/MOV/MKV；视频分块上传。画布须先保存，完整上传后才创建有封面的原视频节点，不创建空占位。
  - addNode {shape:"video", fps?, w?, h?, mediaKind?, mediaClip?, x, y} → 海报 + \`*.media/<clip>/\`
  - listFrames / getFrame / setFrame / appendFrames / setMediaMeta / importMedia
  - extractFrames（看 stills 计划）/ traceFrame（stills → SVG 帧）
  - exportSvgVideo / exportMediaSource
  - diagram_read 对视频只回 mediaKind/mediaClip/fps/frameCount/duration/hasSource，帧内容用 getFrame
  - **视频复刻交互**：用户选中已导入的普通视频，悬停或点击工具条「绘制复刻」展开设置浮窗。图片绘制同样使用悬停设置卡片。
    复刻结果保留原视频音频与片段起点，播放可静音，SVG 视频包及 WebM 导出携带对应音频。
    开始后视频在后台静默复刻，画布角落显示可收起的进度卡片，不占全屏、不抢焦点，可继续编辑画布、取消任务或失败后按原参数重试；切换画布/页面会取消任务。
    视频工具条复用其他节点的图标在上、文字在下的样式及悬停反馈；绘制与导出使用同一个悬停卡片组件。
    悬浮条保留绘制复刻、预览、抽帧、导出；SVG 节点隐藏绘制入口，导出菜单只展示当前媒体适用的格式。抽帧把当前画面放到右侧：源视频为 PNG，SVG 视频保留当前帧矢量。
    悬停视频节点表面时显示进度条与播放/暂停；停止、逐帧、时间轴、循环和适配等完整控件集中在预览窗口，选区悬浮条不再提供设置封面按钮。
    用户决定完整视频或起止时间范围、任意正数帧率（支持 25/29.97/30/60fps 等）、480/887/1440px 长边、原始尺寸或自定义长边。
    碎片数量可选低/中/高，内部自动匹配每帧 60000/120000/248000 字符预算；保留画风、颜色数和去背景选项。
    不再按 30 秒、360 帧或 640px 截断。面板估算帧数；源视频末尾自动截短，小视频不放大。
    单帧保留 1600 万像素及 16384px 长边的处理边界，超过时明确提示用户选择较小尺寸，不静默降采样。
    浏览器负责解码和分块传输高清 PNG；抽帧与常驻 Worker 池描边流水线重叠，帧按序落盘，仅计算选中碎片档位。图片原有的 887px 校准上限不应用于视频。
    面板显示实际进度和最近完成帧，长 SVG 序列按需预取并最多缓存 48 帧内容。
    原视频保留，全部成功后在右侧新建 SVG 视频节点；取消、失败、切换画布会停止任务，取消/失败清理本次临时媒体。
    失败可重新复刻（从头开始）。完成后可播放、逐帧查看、撤销新增节点，以及导出 SVG 视频包。
    SVG 视频包为 .svgvideo.zip（manifest + SVG 帧 + 封面），不是单文件动态 SVG，不含音轨。逐帧绘制暂不做跨帧稳定处理。
  - **AI 分步处理视频**：先 importMedia，再 extractFrames {from,seconds,fps,width,max} 下发计划；
    返回计划不等于完成，须再次查询 extractFrames 确认 stills 数量及回执，再按实际帧数逐个 traceFrame {id,index,removeBg,…}。
    全部写出后 setMediaMeta {id,kind:"svg",fps,w,h,posterFrame:0}，用 listFrames 核对帧数后 exportSvgVideo。

  要"一段不带框的说明/标题文字"就用 addNode {shape:"text", label:"…", x, y} —— 它就是 drawio 的
  text 形状（样式原样写 text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;rounded=0）。
  文字元素想换颜色要写 **fontColor**（setStyle {id, keys:{fontColor:"#b85450"}}）：
  它没有填充与描边，往它身上写 fillColor/strokeColor 屏幕上不会有任何变化。
- **svg：节点内容是一段内嵌 SVG 图形**（不是标签文字）。想画流程图词汇表里没有的东西
  （图标、logo、示意图、示意图标、进度环…）就用它 —— 传一段完整的 SVG 标记，节点框里就画它。
  落盘是 drawio 原生的图片形状（shape=image;imageAspect=0;image=data:image/svg+xml,<百分号编码>），
  **drawio 桌面版打开同样能看见这张图**（不是本画布私有的写法）。
  两个用法：
      {op:"addNode", shape:"svg", svg:"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/></svg>", w:60, h:60, as:"icon"}
      {op:"setStyle", id:"icon", svg:"<svg …>…</svg>"}        // 换一张图（内容整段替换）
      {op:"setStyle", id:"icon", svg:null}                     // 清掉内容 → 回到矩形
  规矩（照做基本不会出错）：
    · **必须同时给 viewBox**（图形按 0 0 W H 的坐标系画，节点框是它的画布）：没有 viewBox 时
      SVG 的坐标系是"像素"，节点放大缩小时图形不会跟着变。缺 xmlns 宿主会自动补（不补的话
      浏览器按 XML 解析会直接丢弃这份图 —— 屏幕上什么都没有，也不报错）。
    · 默认 **imageAspect=0 = 拉伸铺满**节点框；想让图形等比缩放居中就加 keys:{imageAspect:1}
      （那就把 w/h 设成图形的比例，否则四周会留白）。
    · svg 节点通常不带 label（画图不带字）；要图上叠字就照常给 label。普通矩形/面板同样可以省 label。
    · 颜色写在 SVG 自己身上（fill/stroke）—— 配色参数对它是无效的（图片不受 fillColor/strokeColor 影响）。
    · 内容上限 250000 字符；**别放位图/base64**（那是图片不是图形，本画布画不出来）。
    · 改内容只能整段替换（没有"改某一根线"的 op）：先 read 拿回当前 svg，改完整段写回。
- style：调色板名 plain|blue|green|orange|yellow|red|purple|grey，或直接给一段 style 串
- dash：solid|dashed|dotted；arrow：end（单向）|both（双向）|none（无）|start（反向）
- exit/entry：进出侧 n|e|s|w；edgeStyle：orthogonalEdgeStyle|none（none = 直线）
- 自环写成 from === to（与 drawio 一致）；自动布局忽略自环，只摆节点。

## 一段完整的例子
用户说"画一个登录流程，失败回到登录页"：

    diagram_apply({ ops: [
      {op:"addNode", label:"开始",   shape:"stadium", style:"green",  as:"start"},
      {op:"addNode", label:"输入账号", shape:"rect",  style:"blue",   as:"input"},
      {op:"addNode", label:"校验",   shape:"diamond", style:"yellow", as:"check"},
      {op:"addNode", label:"进入首页", shape:"rect",  style:"blue",   as:"home"},
      {op:"addEdge", from:"start", to:"input"},
      {op:"addEdge", from:"input", to:"check"},
      {op:"addEdge", from:"check", to:"home", label:"通过"},
      {op:"addEdge", from:"check", to:"input", label:"失败", dash:"dashed", color:"red"}
    ], layout:"dagre-tb" })

写 as 别名而不是 n1/n2：画布上已经有节点时，自动分配的编号猜不准（错一次就白跑一轮）。

用户说"把这几个（他在画布上选中的）换成绿色"：

    diagram_read()          // 返回里的 selection 就是"这几个"
    diagram_apply({ ops: [{op:"setStyle", ids:[...selection], style:"green"}],
                    expectRevision:"<上一步 read 回来的 revision>" })

## 布局与坐标
- 工作流使用圆角折线；AI 自行根据节点坐标确定水平/垂直通道和 points 折点，不启用自动避障。按流程方向分层、同类对齐、间距一致，检查连线不穿节点或文字。保持用户明确指定的其他线型。
- 简单流程优先使用自动布局：layout 选 dagre-tb（默认，贴合右栏窄高的形状）、dagre-lr（左到右）、
  grid（网格）、none（保留现有坐标，只给没有坐标的新节点补位）。
- 只有"必须摆在某个位置"时才传 x/y（宿主仍会把它吸附到网格）。
- 画布的吸附单位：**节点 10px，连线的折点/自由端点 5px**。手工摆过的画布带 meta.pinned，
  这时**不加 layout 就不会重排**（否则你一改图，人手工排好的版面就被冲掉）；想重排必须显式给 layout。
- **ops 里自带几何时（addNode 给了 x/y、或者有 move）也不会重排** ——
  否则"把 n1 往右挪 40"会被布局立刻冲掉，看起来像工具坏了。
- 显式重排会重算已启用自动避障的旧连线，手动折点和固定连接点保留；节点位置改变后由 AI 复核并按需更新手动折点。新建连线默认手动模式。
- AI 改完的改动**不在用户本地的撤销历史里**（服务端推新版本时客户端会清空它，免得一次 Ctrl+Z
  把 AI 的改动悄悄顶掉）。宿主留了一个**回退栈**（最多 8 步），用户界面「编辑 → 撤销 AI 改动」
  每按一次退一步；read 返回里的 revertSteps 就是"还剩几步"，canRevert 是"还有没有"。
  所以：改了别慌，也别自己"改回去"—— 告诉用户可以连按几次撤销就行。
- **纸张尺寸**（page）：文件里写了就报出来（例如 850 × 1100 = drawio 的 A4 竖版缺省）。
  布局取舍与"要不要给用户导出建议"都该看它 —— 内容远比纸张宽时提醒一句比闷头画更好。

## 想看效果图的时候（diagram_read 带 render:true）
- 传 render:true 就是"让我看一眼这张画布"：正交路由、避让、圆角、文字断线这些
  **只有看图才知道**的东西，几何数据里没有（宿主也不算走线，那是画布算的）。
- 渲染在**浏览器那一半**做，所以只有用户在右侧栏**打开着这张画布**时才有人接活：
  · 画布没打开（宿主知道你打开的是别的文件）→ look.status="not-open"，附原因，别重试；
  · 打开了 → 第一次返回 look.status="pending"（已请求，带 waitedMs），**等几秒再调一次**
    diagram_read（render:true），图就作为图片内容块跟回来了；
  · 挂了请求却一直没人接（25 秒）→ look.status="timeout"，带已等待秒数 —— 这时别再
    傻等，要么请用户先打开画布，要么直接用几何数据。
- **不会在用户的工作区里生成任何文件**：图片存在宿主那边的附件库里（与用户上传图片同一套存储，
  在工作区之外），看完即取走 —— 要再看就再要一次（图不会被反复塞给你）。
- **纯改图不需要它**：几何、样式、图层、纸张从普通 diagram_read 里就有。
  只在判断"这样摆好不好看/线有没有压住节点/别人看不看得懂"时用。
- 看不了的情况会明说：这个部署没挂附件服务、或当前模型没声明图片输入 —— 那时
  look.status 是 unsupported（附原因），照常用几何数据干活即可。
- 那张图是"你请求渲染那一刻"的画面：回执之后你又改过图的话 look.stale 会是 true，
  想看新的就再 render:true 一次。

## style 键与 drawio 同构
文档里存的就是 drawio 的 style 键：fillColor / strokeColor / shape= / rounded= / arcSize= /
dashed / dashPattern / strokeWidth / fontSize / fontColor / edgeStyle / jettySize / orthogonalLoop /
endArrow / startArrow / exitX·exitY·entryX·entryY / libavoidRouting …
**默认值一律省略**（写出来等于多一份噪音），认不出的键原样保留。
边自己的文字存在边的 value 上（diagram_read 里是 label），可以写成多行；
拖动过的边标签位置存在边几何的 x/y/offset 里（沿边比例 + 垂距 + 残余），read 会作为
labelX/labelY 报出来，要改就用 setLabelPos（见上）。

## 画布表示不了、但会原样保留的东西（notes 里会列出来）
多页只显示第 1 页、分组/容器按绝对位置显示、位图/外链图片按矩形显示（内嵌 SVG 会真的画出来）、
HTML 标签按纯文本显示、图层结构原样保留（画布把它们叠在一起显示）、drawio 的独立边标签单元（edgeLabel）只读显示。
**看到 notes 要如实告诉用户**：这份文件在 drawio 里打开时会和这里看到的略有差别。

## 别做这些
- 别直接改 .drawio 文件的文本（用 diagram_apply）：手改会破坏"没动的地方逐字节不变"这条保证。
- 新建优先使用 .drawai；别造其他后缀（.json/.xml/.svg）：画布支持 .drawai 原生 JSON 和 .drawio；其他后缀会"看起来成功、其实没人能打开"。
- 别把图重画一遍来表达"挪一下"：用户手工摆过的位置是有意义的。

## 用户可以这样操作（他问"怎么做"时照这个答）
- 双击节点改文字；双击线段、线段上的文字、或线上的把手，改**线上的文字**
- 按住线上的文字拖动 = 挪文字（有半格吸附，靠近线会贴回线上）；右键「标签居中」放回中点
- 选中连线后：绿/红端点拖到别的节点 = 改接；橙色空心把手拖 = 整段平移；右键有「自动路由」清掉折点
- 空白处左键拖 = 框选（框到节点或线段都算）；Shift 框选是加选；拖选区整体移动（连线形状一起走）
- Ctrl+C/X/V 复制剪切粘贴、Ctrl+Z/Y 撤销重做、Delete 删除；中键拖动平移、滚轮缩放
- 「文件 → 新建画布…/打开…/另存为…」；「视图 → 适应内容」；「整理几何（吸附到格线）」把整张图对齐
- 右键还能改线型/箭头/颜色/顺序（置顶置底）、编辑数据（drawio 用户对象的自定义属性）、删除
`

/**
 * 技能目录里那两条（模型先看到简介，需要时才取全文）。
 * 名字用 kebab-case —— DSH 的注册表按名字寻址并要求这个形状。
 *
 * description 是**唯一的检索入口**：会话的技能目录只渲染 name + description（whenToUse 不出现在
 * 目录里），所以两边各写各的任务词，互不侵占 —— 这正是拆分的主要收益。
 */
const SKILL_DEFINITIONS = [
  {
    name: 'drawai-canvas',
    description:
      '读写 DrawAI 画布（.drawio）：diagram_read 看现状、diagram_apply 结构化改图；支持图像复刻、视频分段复刻及 SVG 帧序列导出。',
    whenToUse:
      '用户让你画流程图/架构图/泳道图、复刻图片或视频、将视频转为 SVG 帧动画，或让你读/改某张 .drawio 画布，或问"这张图里有什么""画布上怎么操作"时。',
    content: SKILL_BODY_CANVAS,
  },
  {
    name: 'drawai-video',
    description:
      '用 DrawAI 画布做视频：定镜头卡与整片风格、写分镜表、生成工程、出样片与成片；含品牌素材收集、配音与踩点。',
    whenToUse:
      '用户让你做视频/宣传片/产品片/MG 动画、给已有视频改镜头或配音、把画布上的流程做成片子，或问"样片怎么出""镜头卡怎么连""配乐怎么踩点"时。',
    content: SKILL_BODY_VIDEO,
  },
]

/**
 * 列出工作区里的画布文档（非递归进子目录，最多扫 MAX_SCAN_DIRS 个）。
 *
 * **列目录的 API 是 `list`，不是 `readRelated`**。之前用 readRelated 是错的：
 * dsh-api-workspace-files 的类型注释写得很明确 ——
 *   read / readBytes / stat / changes 用**绝对路径**；
 *   `list` speaks workspace paths，因为它的消费者是"以工作区根为根的树"。
 * 而且旧实现把异常整个吞掉（catch → null），于是"读不到目录"只表现为**空列表**，
 * 界面上就是"找不到文件"，看不出任何原因。现在：优先 list、失败退回 readRelated、
 * 两者都失败就把错误带回调用方显示。
 *
 * 只扫一层子目录：画布文档按惯例都在根目录或一层子目录下；递归全盘扫描既慢，
 * 又可能撞上 node_modules 这类大目录。
 */
async function listCanvases(root, cwd, dir) {
  const found = []
  const seen = {}
  const dirs = []
  const notes = []

  async function readDir(absPath) {
    try {
      const entries = await nodeReaddir(absPath, { withFileTypes: true })
      return { entries: entries, error: '' }
    } catch (error) {
      return { entries: null, error: messageOf(error) }
    }
  }

  function collect(entries, prefix) {
    if (!Array.isArray(entries)) return
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? entry.name : null
      if (typeof name !== 'string' || name.length === 0) continue
      const isDir =
        entry !== null && typeof entry === 'object'
          ? typeof entry.isDirectory === 'function'
            ? entry.isDirectory()
            : entry.kind === 'directory' || entry.type === 'directory' || entry.isDirectory === true
          : false
      const rel = prefix.length === 0 ? name : prefix + '/' + name
      // 载体就是 .drawio —— 列出来的每一个都能直接打开（不再有「先导入成别的东西」这一步）。
      if (!isDir && isCanvasPath(name)) {
        if (seen[rel] !== true) {
          seen[rel] = true
          found.push(rel)
        }
        continue
      }
      // 只下钻一层，并跳过明显的重目录（node_modules / .git）—— 扫它们又慢又没意义。
      if (isDir && prefix.length === 0 && name !== 'node_modules' && name !== '.git' && dirs.length < MAX_SCAN_DIRS) dirs.push(rel)
    }
  }

  const startAbs = toAbsolute(typeof dir === 'string' && dir.length > 0 ? dir : root, cwd)
  const first = await readDir(startAbs)
  if (first.entries === null) notes.push('无法列出 ' + startAbs + '：' + first.error)
  else collect(first.entries, '')
  for (let d = 0; d < dirs.length; d += 1) {
    const subAbs = toAbsolute(dirs[d], startAbs)
    const sub = await readDir(subAbs)
    if (sub.entries === null) {
      notes.push('无法列出 ' + subAbs + '：' + sub.error)
      continue
    }
    collect(sub.entries, dirs[d])
  }
  found.sort()
  return { files: found, notes: notes }
}


export function apply(ctx) {
  const documents = createDocumentCoordinator(), mediaSlots = createMediaWorkSlots(2), taskPatches = createTaskPatchJournal()

  // ── host 工具注册的可观测化（issue #8）────────────────────────────────────
  // 现场是"画布全好、apply 也执行了、模型侧一个工具都没有，而且哪儿都不报错"。
  // 三种机制必须能被区分开，光凭"apply 进去了"证明不了什么：
  //   ① apply 期间 tools 服务还没 ACTIVE —— 注册等于扔进空处；
  //   ② 某个注册抛错，把同一段里后面的注册和收尾一起带走；
  //   ③ 注册成功了，之后整个 effect scope 被回收 —— 只有"注册了 N 个"这条日志能反推。
  // 所以每个工具逐项记名、逐项兜错，结果同时挂到 DIAGNOSTICS_PATH 上供远端取证。
  const toolRegistrations = []
  const pendingToolRegistrations = []
  let pendingFlushRequested = false, toolReportLogged = false

  /** 取工具登记表本身；取不到返回 undefined（不抛），调用方据此走挂起路径。 */
  function toolsService() {
    const usable = (value) => value !== null && value !== undefined && typeof value.register === 'function'
    // 两条路都要试：真实 Cordis 走 service 解析（ctx.get），而宿主注入的 ctx 上
    // tools 也可能是普通属性 —— 只看其中一条会把"可用"误判成"没就绪"。
    try {
      if (typeof ctx.get === 'function' && usable(ctx.get('tools'))) return ctx.get('tools')
    } catch (error) {
      // 解析本身失败（服务未 ACTIVE）不该中断：接着看直接属性。
    }
    try {
      return usable(ctx.tools) ? ctx.tools : undefined
    } catch (error) {
      return undefined
    }
  }

  function registerHostTool(tool) {
    const named = tool !== null && tool !== undefined && typeof tool.name === 'string' && tool.name.length > 0
    const entry = { name: named ? tool.name : '(unnamed)', ok: false, deferred: false, error: '', disposer: undefined }
    toolRegistrations.push(entry)
    const attempt = () => {
      const tools = toolsService()
      if (tools === undefined) return false
      try {
        const disposer = tools.register(tool)
        entry.disposer = disposer
        entry.ok = typeof disposer === 'function'
        entry.error = entry.ok ? '' : 'register() 没有返回 disposer（tools 服务可能未 ACTIVE）'
      } catch (error) {
        entry.ok = false
        entry.error = messageOf(error)
      }
      if (!entry.ok) console.error('[drawai] 工具注册失败 ' + entry.name + '：' + entry.error)
      return true
    }
    if (!attempt()) {
      // tools 还没就绪：挂起，等它 ACTIVE 再补注册。这里绝不能抛 —— 抛出去会把 apply
      // 后半段（包括其余 17 个工具）一起带走，那正是 issue #8 里"全没了"的样子。
      entry.deferred = true
      pendingToolRegistrations.push({ entry: entry, attempt: attempt })
      schedulePendingFlush()
    }
    return () => {
      const index = pendingToolRegistrations.findIndex((item) => item.entry === entry)
      if (index >= 0) pendingToolRegistrations.splice(index, 1)
      if (typeof entry.disposer === 'function') entry.disposer()
    }
  }

  /** 只申请一次；ctx.inject 的回调在 tools ACTIVE 后立刻跑（本来就 ACTIVE 就当场跑）。 */
  function schedulePendingFlush() {
    if (pendingFlushRequested) return
    pendingFlushRequested = true
    try {
      ctx.inject(['tools'], () => {
        for (const item of pendingToolRegistrations.splice(0)) item.attempt()
        reportToolRegistrations(true)
      })
    } catch (error) {
      console.error('[drawai] 等待 tools 服务就绪失败：' + messageOf(error))
    }
  }

  function reportToolRegistrations(final) {
    const registered = toolRegistrations.filter((item) => item.ok).map((item) => item.name)
    const failed = toolRegistrations.filter((item) => !item.ok && !item.deferred)
    const waiting = toolRegistrations.filter((item) => item.deferred).length
    if (waiting > 0 && final !== true) {
      console.error('[drawai] ' + registered.length + ' 个 host 工具已注册，' + waiting + ' 个等待 tools 服务就绪')
      return
    }
    if (toolReportLogged) return
    toolReportLogged = true
    if (failed.length === 0) console.error('[drawai] 已注册 ' + registered.length + ' 个 host 工具：' + registered.join('、'))
    else console.error('[drawai] host 工具注册 ' + registered.length + '/' + toolRegistrations.length + ' 成功，失败 ' + failed.length + ' 个：' + failed.map((item) => item.name + '（' + item.error + '）').join('；'))
  }

  // 注册成功、模型侧却看不见时，这条日志是"插件被卸载 / 上下文被回收"唯一的线索。
  ctx.effect(() => () => {
    const registered = toolRegistrations.filter((item) => item.ok).length
    if (registered > 0) console.error('[drawai] 插件上下文释放：' + registered + ' 个已注册 host 工具随之注销')
  })

  function sessionOf(sessionId) {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const session = ctx.sessions.get(sessionId)
      return session === undefined || session === null ? undefined : session
    } catch (error) {
      return undefined
    }
  }

  /**
   * 按**调用会话**解析沙箱策略。
   * 不带 request 的 resolve() 是"无会话"回退，workspaceRoot 会落到部署默认（process.cwd()），
   * 那样工作区文件不在可写根内，writeText 会被 FS_SANDBOX_DENIED 拒掉。
   * 带上 session 后，会话的不可变 cwd 成为可写边界 —— 这不是提权，部署设成 read-only 时照样会拒。
   */
  function policyFor(sessionId) {
    try {
      const session = sessionOf(sessionId)
      return session === undefined ? ctx.sandboxPolicy.resolve() : ctx.sandboxPolicy.resolve({ session: session })
    } catch (error) {
      return undefined
    }
  }

  function workspaceRootOf(sessionId) {
    try {
      const policy = policyFor(sessionId)
      if (policy !== undefined && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
        return policy.workspaceRoot
      }
      const session = sessionOf(sessionId)
      if (session === undefined) return undefined
      const header = session.header
      if (header === undefined || header === null) return undefined
      return typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
    } catch (error) {
      return undefined
    }
  }

  function sessionIdOf(exec) {
    try {
      if (exec === null || exec === undefined) return undefined
      const agent = exec.agent
      if (agent === null || agent === undefined) return undefined
      return typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : undefined
    } catch (error) {
      return undefined
    }
  }

  function absoluteHint(target, fallback) {
    try {
      return ctx.fs.processPath(target)
    } catch (error) {
      return fallback
    }
  }

  async function resolveTarget(path, sessionId) {
    const root = workspaceRootOf(sessionId)
    const target = root === undefined ? await ctx.fs.resolve(path) : await ctx.fs.resolve(path, { cwd: root })
    // A retained legacy path continues to address its migrated document for tools
    // and queued tasks, including after a host restart. Never adopt an unrelated sibling.
    if (root !== undefined && typeof ctx.fs.stat === 'function' && /\.drawio$/i.test(String(path))) {
      const native = await ctx.fs.resolve(nativeCanvasPath(path), { cwd: root })
      const rootTarget = await ctx.fs.resolve(root)
      if (ctx.fs.contains(rootTarget, target) && ctx.fs.contains(rootTarget, native) && await ctx.fs.stat(native)) {
        let project
        try { project = JSON.parse(await ctx.fs.readText(native)) } catch {}
        if (project?.format === 'dsh-drawai' && project.migration?.sourcePath === absoluteHint(target, path)) {
          if (await ctx.fs.stat(target) && contentHash(await ctx.fs.readText(target)) !== project.migration.sourceHash) throw new Error('旧画布已在迁移后更改，请处理两个版本')
          return native
        }
      }
    }
    return target
  }

  /**
   * 读一份画布：**文件是真相**，读的就是 `.drawio`（mxfile）本身。
   *
   * revision 用文件内容指纹（`contentHash`），不落盘 —— 这样 drawio 或别的编辑器改过文件，
   * 指纹自然变，乐观锁不会因为"属性被 drawio 丢掉"而假冲突。
   */
  async function loadDoc(path, sessionId, page) {
    const target = await resolveTarget(path, sessionId)
    const absolute = absoluteHint(target, path)
    const info = await ctx.fs.stat(target)
    if (info === undefined) {
      return { target: target, absolute: absolute, doc: emptyDoc(), notes: [], exists: false, pageCount: 1, pageIndex: 0, pageNames: ['第 1 页'] }
    }
    const text = await ctx.fs.readText(target)
    const parsed = parseMxfile(text, { page: page })
    return {
      target: target,
      absolute: absolute,
      doc: normalizeDoc(parsed.doc),
      notes: parsed.notes,
      exists: true,
      text: text,
      pageCount: parsed.pageCount,
      pageIndex: parsed.pageIndex,
      pageNames: parsed.pageNames,
      pageId: parsed.pageId,
      pageIds: parsed.pageIds,
    }
  }

  /**
   * 写一份画布：**在原文件上做无损写回**（只改我们拥有的单元，其余原文逐字节保留）。
   *
   * 文件不存在（或为空）时才从零生成 —— 那是"新建"，没有原稿可保护。
   *
   * @returns { text, dropped, revision }
   */
  function renderDocText(originalText, doc, options) {
    const doc2 = normalizeDoc(doc)
    if (typeof originalText === 'string' && originalText.trim()) {
      if (options?.format === 'drawio' && originalText.trimStart().startsWith('{')) originalText = exportCanvasToMxfile(originalText)
      else if (options?.format === 'drawai' && !originalText.trimStart().startsWith('{')) originalText = migrateMxfile(originalText)
    }
    if (typeof originalText !== 'string' || originalText.trim().length === 0) {
      const built = buildMxfile(doc2, options)
      return { text: built.text, dropped: built.dropped, revision: contentHash(built.text) }
    }
    const applied = applyDocToMxfile(originalText, doc2, options)
    return { text: applied.text, dropped: applied.dropped, revision: contentHash(applied.text) }
  }

  /**
   * 工具的路径护栏：只认 `.drawio`。
   *
   * 载体只有一种格式 —— 放开后缀就等于允许 AI 在工作区里造出第二种画布文件，
   * 而那些文件没有画布认领、也不会被「打开」列出来，属于"看起来成功、其实没人能看见"。
   */
  function assertCanvasPath(path) {
    if (typeof path !== 'string' || !isCanvasPath(path)) {
      throw new Error('画布路径必须以 .drawio 结尾（drawio 的 mxfile 就是画布文件）：' + String(path))
    }
  }

  const readTool = defineTool({
    name: 'diagram_read',
    description:
      '读回工作区里的 DrawAI 画布（.drawio，就是 drawio 自己的 mxfile 格式）：节点 id/标签/形状/style 键，边 id/起点/终点/标签/画法/折点。做任何修改前先用它确认当前图。' +
      '文档存的是 drawio 的 style 键（dashed/dashPattern/edgeStyle/jettySize/libavoidRouting/exitX…/endArrow/strokeColor/shape=…），默认值省略；' +
      '返回体的 shape/dash/arrow/color/exit/entry/fontColor 是**从 style 串推导出来的便于阅读的名字**，改图请改 style 或对应 op 参数；' +
      'shape 为 svg 的节点（内容是一段内嵌 SVG 图形）额外带 svg 字段 = 那段标记，' +
      '而它 style 里的 image= 被省略成 «svg N 字符»（**别把省略后的 style 原样写回**，会被拦下；改内容用 diagram_apply 的 svg 参数）。' +
      'shape 为 image 的节点是用户粘贴/拖入的位图（png/jpeg/gif/webp），带 image:true，style 里的 image= 省略成 «image N 字符»。' +
      'notes 是这个文件里画布表示不了、但会原样保留的东西（多页、分组层级、外链图片…）。' +
      'layers 是图层表（顺序 = 叠放顺序；visible:false 的层在画布上不画，但里面的单元照旧读得到它们带 layer 字段）；加层/移层/改名/显示隐藏用 addLayer、setLayer、setLayerProps。' +
      '节点带 parent 说明它在某个容器（分组）里 —— 画布按绝对位置显示，所以移动容器不会带走子单元，要整组动就把它们一起写进 ids。' +
      'selection 是**用户此刻在画布上选中的单元 id**（按文件配对、按存在过滤；没人选就是空数组）—— 用户说"把这几个挪一下/换个颜色"时，"这几个"就是它们，别靠坐标猜。' +
      '返回的 revision 可以直接当 diagram_apply 的 expectRevision 用（读→改之间被别人动过就会被拦下）。' +
      '不传 path 时读的是**用户当前打开的那张画布**（返回里的 path 就是它）。' +
      '多页文件用 page（0 起）指定页；不传 = 用户正在看的那一页（没上报过则 0）。' +
      '返回里的 pageIndex / pageCount / pageNames 说明当前读到哪一页；page 字段仍是纸张尺寸 {w,h}（有写才有）。',
    parameters: {
      path: {
        type: 'string',
        description:
          '工作区相对路径或绝对路径。不传时读取当前会话明确聚焦的画布；没有焦点时请指定 path。',
      },
      page: {
        type: 'number',
        description:
          '多页文件里要读的页下标（从 0 起）。不传 = 用户画布当前页（聚焦上报）；越界会夹到合法范围。单页文件忽略。',
      },
      layer: {
        type: 'string',
        description:
          '只看某一层（层 id 或层名）：大图上先看一层能省掉一大段上下文。层表照旧整份回。不传 = 全部层。',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: '只看这几个单元（节点/连线 id）：想确认"刚改的那几个现在什么样"时用它，别把整张图再读一遍。',
      },
      render: {
        type: 'boolean',
        description:
          '**看一眼这张画布的渲染结果**（正交路由、避让、圆角、文字断线这些只有看图才知道的东西）。' +
          '渲染在浏览器那一半做，只有用户**在右侧栏打开着这张画布**时才有人接：没打开会回 look.status="not-open"（别重试）；' +
          '打开了第一次调用回 look.status="pending"（已请求，带 waitedMs），**等几秒再调一次**就会带上图片块；' +
          '挂着的请求 25 秒没人接就变成 look.status="timeout"（带已等待秒数），别傻等。' +
          '图片经附件通道直接进上下文 —— **不会在你的工作区里生成任何文件**。' +
          '只在确实需要"看"的时候用（判断重叠/压线/观感），纯粹改图不需要它。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          // revision = 文件内容指纹（改由文件决定，不再是我们自己 +1 的计数器）
          revision: { type: 'string', required: true },
          // 纸张尺寸（文件里写了才有）：布局与导出建议要看它。
          page: {
            type: 'object',
            additionalProperties: false,
            properties: {
              w: { type: 'number', required: true },
              h: { type: 'number', required: true },
            },
          },
          pageIndex: { type: 'number' },
          pageCount: { type: 'number' },
          pageNames: { type: 'array', items: { type: 'string' } },
          // 这次是不是被 layer/ids 过滤过（过滤时上面那些计数只是"看到的部分"）。
          filtered: { type: 'boolean' },
          totalNodes: { type: 'number' },
          totalEdges: { type: 'number' },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          // AI 的高亮请求（取走即清）与"有没有可退回的 AI 改动"。
          highlight: { type: 'array', items: { type: 'string' } },
          canRevert: { type: 'boolean' },
          // AI 改动的回退栈还剩几步（可以连着退；0 = 没有可退的了）。
          revertSteps: { type: 'number' },
          // 用户此刻在画布上选中的单元 id（按**文件**配对、按**存在**过滤）。
          // 用户说"把这几个挪一下"时，"这几个"就是它 —— 以前只能靠坐标猜。
          selection: { type: 'array', items: { type: 'string' } },
          // 导出状态（只有用过 `{op:'export'}` 才有）：pending（画布还没渲染）/ done（文件已写出，
          // 带 path）/ downloaded（png 已由浏览器下载）/ failed（error 是原因）。
          export: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              format: { type: 'string', required: true },
              path: { type: 'string' },
              error: { type: 'string' },
            },
          },
          // 「看一眼」的状态（只有传了 render:true 才有）：
          // pending / ready / unsupported / failed / not-open / timeout。
          // 图片本身不走 schema，而是走 render 的输出块（见下面的 render()）。
          look: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              stale: { type: 'boolean' },
              error: { type: 'string' },
              // 已经等了多久（毫秒）：pending 时是"已挂请求多久"，timeout 时是"没人接多久"。
              waitedMs: { type: 'number' },
            },
          },
          // 这张图的附件引用（有图才有）。render() 用它拼出 `{type:'image', attachment}` 块。
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              name: { type: 'string' },
            },
          },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                shape: { type: 'string', required: true },
                audio: { type: 'string' }, cardId: { type: 'string' }, styleKey: { type: 'string' }, shotCommit: { type: 'string' },
                // 整片风格节点（shape=mgstyle）才会带这两项。漏声明一次，含风格节点的画布
                // diagram_read 整次失败 —— 与 video 那组字段同一个坑。
                slug: { type: 'string' }, mgStyleCommit: { type: 'string' },
                style: { type: 'string', required: true },
                // 内嵌 SVG 内容（shape 为 svg 的节点才有）：节点**画什么**就写在这里。
                // 上面 style 里的 image= 被省略成 «svg N 字符» —— 别把它写回来（会被拦下），
                // 改内容用 diagram_apply 的 "svg" 参数。
                svg: { type: 'string' },
                // 内嵌位图（shape 为 image）：只表示"这里有图"，不回显 base64。
                image: { type: 'boolean' },
                x: { type: 'number', required: true },
                y: { type: 'number', required: true },
                w: { type: 'number', required: true },
                h: { type: 'number', required: true },
                labelOffsetX: { type: 'number' },
                labelOffsetY: { type: 'number' },
                // 这个单元在哪一层（图层 id）。多于一层的文档才带。
                layer: { type: 'string' },
                // 字色（设过且不是缺省黑字才有）：命中调色板给名字，否则给十六进制。
                fontColor: { type: 'string' },
                // 容器父级（**只读信息**）：单元挂在某个容器/分组里时才有。
                // 画布按绝对位置显示，所以"移动容器"不会带走它 —— 要一起动就把它们一起写进 ids。
                parent: { type: 'string' },
                // 视频节点摘要（shape=video 才有）。帧内容不塞进 read —— 用 getFrame / listFrames。
                // 漏声明会踩 additionalProperties:false：画布里一旦有视频节点，diagram_read 整次失败。
                mediaKind: { type: 'string' },
                mediaClip: { type: 'string' },
                fps: { type: 'number' },
                posterFrame: { type: 'number' },
                frameCount: { type: 'number' },
                duration: { type: 'number' },
                hasSource: { type: 'boolean' },
                mediaMissing: { type: 'boolean' },
              },
            },
          },
          // 图层列表（顺序 = 叠放顺序，后面的在上面）。加层/移层/改名看 diagram_apply 的
          // addLayer / setLayer / setLayerProps。
          layers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                visible: { type: 'boolean', required: true },
                locked: { type: 'boolean', required: true },
              },
            },
          },
          edges: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                label: { type: 'string' },
                style: { type: 'string', required: true },
                dash: { type: 'string', required: true },
                arrow: { type: 'string', required: true },
                color: { type: 'string' },
                exit: { type: 'string' },
                entry: { type: 'string' },
                // 这几个是返回体里**确实会带**的字段（execute 里按需填）。
                // 漏声明的后果实测过：schema 是 additionalProperties:false，
                // 于是只要某条边带折点，diagram_read 整个调用被判为非法输出、
                // 直接报错 —— 连读都读不出来。新增返回字段时必须同步这里。
                points: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      x: { type: 'number', required: true },
                      y: { type: 'number', required: true },
                    },
                  },
                },
                sourcePoint: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                  },
                },
                targetPoint: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                  },
                },
                // 边上文字的位置（拖过才有）：x = 沿边比例（-1..1，0 = 中点）、y = 垂直偏移 px。
                // 客户端能拖，AI 原来既看不见也改不了 —— 见 setLabelPos。
                labelX: { type: 'number' },
                labelY: { type: 'number' },
                labelOffsetX: { type: 'number' },
                labelOffsetY: { type: 'number' },
                // 线上文字的字色（设过且不是缺省黑字才有）。
                fontColor: { type: 'string' },
                layer: { type: 'string' },
              },
            },
          },
        },
      },
      render: function (args, value) {
        const layers = Array.isArray(value.layers) ? value.layers : []
        const layerNameOf = function (id) {
          for (let i = 0; i < layers.length; i += 1) if (layers[i].id === id) return layers[i].name
          return id
        }
        const inLayer = function (item) {
          return layers.length > 1 && typeof item.layer === 'string' && item.layer.length > 0 ? '  ⟨' + layerNameOf(item.layer) + '⟩' : ''
        }
        const lines = [
          '画布 ' + value.path + '（revision ' + value.revision + '，' + value.nodes.length + ' 节点 / ' + value.edges.length + ' 边' +
            (value.filtered === true ? '（**过滤后**；整张是 ' + value.totalNodes + ' 节点 / ' + value.totalEdges + ' 边）' : '') + '）',
        ]
        if (value.page !== undefined && value.page !== null) {
          lines.push('  📄 纸张 ' + value.page.w + ' × ' + value.page.h)
        }
        for (let i = 0; i < value.nodes.length; i += 1) {
          const n = value.nodes[i]
          lines.push(
            '  节点 ' + n.id + ' [' + n.shape + '] ' + n.label + '  @' + n.x + ',' + n.y + ' ' + n.w + '×' + n.h +
              (n.style.length === 0 ? '（默认样式）' : '  style: ' + n.style) + inLayer(n) +
              (typeof n.parent === 'string' ? '  ⌂在 ' + n.parent + ' 里' : ''),
          )
          // svg 节点的内容是图不是字：**整段标记打在下面一行**（换行压成空格，方便读也方便复制）。
          // 太长就截断并注明总长 —— 模型要改它就整段重写，比看半截去猜更靠谱。
          if (typeof n.svg === 'string') {
            const flat = n.svg.replace(/\s+/g, ' ').trim()
            lines.push(
              '      └ svg: ' +
                (flat.length <= SVG_REPORT_LIMIT ? flat : flat.slice(0, SVG_REPORT_LIMIT) + ' …（已截断：全文 ' + flat.length + ' 字符）'),
            )
          }
        }
        for (let i = 0; i < value.edges.length; i += 1) {
          const e = value.edges[i]
          const bits = [e.dash, e.arrow + ' arrow']
          if (e.color !== undefined) bits.push(e.color)
          // 线上文字的字色（与"线的颜色"是两件事，所以分开报）。
          if (e.fontColor !== undefined) bits.push('font ' + e.fontColor)
          if (e.exit !== undefined || e.entry !== undefined) bits.push((e.exit === undefined ? '?' : e.exit) + '->' + (e.entry === undefined ? '?' : e.entry))
          if (Array.isArray(e.points)) bits.push(e.points.length + ' waypoint(s)')
          // 边标签被拖过（不是弧长中点了）：位置一起报出来，改它用 setLabelPos。
          if (e.labelX !== undefined) {
            const off = (e.labelOffsetX || e.labelOffsetY) ? '+off(' + numberOr(e.labelOffsetX, 0) + ',' + numberOr(e.labelOffsetY, 0) + ')' : ''
            bits.push('label@' + e.labelX + ',' + e.labelY + off)
          }
          lines.push(
            '  边 ' + e.id + ' ' + e.from + ' -> ' + e.to + (typeof e.label === 'string' && e.label.length > 0 ? ' "' + e.label + '"' : '') +
              ' [' + bits.join(', ') + ']' + inLayer(e),
          )
        }
        for (let i = 0; i < value.notes.length; i += 1) lines.push('  ⚠ ' + value.notes[i])
        // 导出状态：请求过才有一行（让 AI 知道"那张 SVG 到底写出来了没有"）。
        if (value.export !== undefined && value.export !== null && typeof value.export.status === 'string') {
          const ex = value.export
          lines.push(
            '  ⤓ 导出：' + ex.status + '（' + ex.format + '）' +
              (typeof ex.path === 'string' ? ' → ' + ex.path : '') +
              (typeof ex.error === 'string' ? ' ← ' + ex.error : ''),
          )
        }
        // 用户当前的选区：AI 说"这几个"时指的就是它们（不传 path 读的就是用户眼前那张）。
        if (Array.isArray(value.selection) && value.selection.length > 0) {
          lines.push('  🔵 用户当前选中 ' + value.selection.length + ' 项：' + value.selection.join(', '))
        }
        // 图层表：v1 只读。名字 + 可见性（隐藏层里的东西 AI 也照读，但它得知道"用户现在看不见"）。
        if (layers.length > 0) {
          lines.push('  图层（顺序 = 叠放顺序，后面的在上面）：')
          for (let i = 0; i < layers.length; i += 1) {
            const l = layers[i]
            lines.push('    ' + (l.visible === false ? '🚫' : '👁') + ' ' + l.name + ' (id ' + l.id + ')' + (l.locked === true ? ' 🔒' : ''))
          }
        }
        // 「看一眼」的状态：请求过才有 —— 模型要知道"图还没渲好"还是"这个部署/模型看不了图"。
        if (value.look !== undefined && value.look !== null && typeof value.look.status === 'string') {
          const look = value.look
          if (look.status === 'pending') {
            const waited = Number(look.waitedMs)
            lines.push(
              '  👁 已请求渲染这张画布' + (Number.isFinite(waited) && waited > 0 ? '（已等 ' + Math.round(waited / 1000) + ' 秒）' : '') +
                '：画布几秒内渲好，**再调一次 diagram_read（render:true）**就能看到图',
            )
          } else if (look.status === 'ready') {
            lines.push('  👁 渲染结果在图块里' + (look.stale === true ? '（**注意：这是你请求渲染时的样子，之后文件又被改过**）' : ''))
          } else if (look.status === 'unsupported') {
            lines.push('  👁 看不了图：' + String(look.error === undefined ? '这个部署没有可用的图片通道' : look.error))
          } else if (look.status === 'not-open' || look.status === 'timeout') {
            // 这两种都不是"渲坏了"，而是"根本没人在渲"：别让模型以为再等等就好了。
            lines.push(
              '  👁 ' + (look.status === 'not-open' ? '画布没打开，图不会渲出来：' : '渲染请求没人接（超时）：') +
                String(look.error === undefined ? '请先在右侧栏打开这张画布' : look.error),
            )
          } else {
            lines.push('  👁 渲染失败：' + String(look.error === undefined ? '未知原因' : look.error))
          }
        }
        const textBlock = { type: 'text', text: lines.join('\n') }
        // 有图就带上 **image 内容块**：图片走附件通道（DSH 的附件库，工作区零文件），
        // 与 `read_image` 返回的是同一种块，模型直接"看见"。
        if (value.image !== undefined && value.image !== null && typeof value.image.attachmentId === 'string') {
          return [textBlock, { type: 'image', attachment: Object.assign({}, value.image) }]
        }
        return [textBlock]
      },
    },
    async execute(args, exec) {
      // 读写都只接受显式路径或当前会话的焦点；未知目标时不猜 demo。
      const focus = focusedPathFor(sessionIdOf(exec))
      const path =
        typeof args.path === 'string' && args.path.trim().length > 0 ? args.path : focus
      if (!path) throw new Error('未指定画布路径且当前会话没有聚焦画布，请传入 path 或先打开目标画布')
      assertCanvasPath(path)
      const pageArg =
        Number.isFinite(Number(args.page)) ? Number(args.page) : focusedPageFor(sessionIdOf(exec))
      const loaded = await loadDoc(path, sessionIdOf(exec), pageArg)
      const doc = loaded.doc
      // 过滤（大图省上下文）：`layer` 只看一层、`ids` 只看几个单元。
      // 计数与"整张有多少"分开报 —— 只报过滤后的数字会让模型以为图变小了。
      const wantLayer = typeof args.layer === 'string' && args.layer.length > 0 ? args.layer : undefined
      const wantIds = Array.isArray(args.ids) ? args.ids.filter((v) => typeof v === 'string' && v.length > 0) : []
      let layerFilter = null
      if (wantLayer !== undefined) {
        const list = Array.isArray(doc.layers) ? doc.layers : []
        for (let i = 0; i < list.length; i += 1) {
          if (String(list[i].id) === wantLayer) layerFilter = String(list[i].id)
        }
        if (layerFilter === null) {
          for (let i = 0; i < list.length; i += 1) {
            const name = typeof list[i].name === 'string' ? list[i].name : ''
            if (name.length > 0 && name === wantLayer) layerFilter = String(list[i].id)
          }
        }
        if (layerFilter === null) {
          throw new Error('没有叫 "' + wantLayer + '" 的图层。Layers: ' + list.map((l) => (l.name || '(无名)') + '#' + l.id).join(', '))
        }
      }
      const keepNode = (n) => {
        if (wantIds.length > 0 && wantIds.indexOf(String(n.id)) < 0) return false
        if (layerFilter !== null && String(n.layer) !== layerFilter) return false
        return true
      }
      const keepEdge = (e) => {
        if (wantIds.length > 0 && wantIds.indexOf(String(e.id)) < 0) return false
        if (layerFilter !== null && String(e.layer) !== layerFilter) return false
        return true
      }
      const filtered = layerFilter !== null || wantIds.length > 0
      const nodes = []
      for (let i = 0; i < doc.nodes.length; i += 1) {
        const n = doc.nodes[i]
        if (keepNode(n) === false) continue
        const style = typeof n.style === 'string' ? n.style : ''
        const svgMarkup = svgMarkupForReport(style)
        const shapeName = reportNodeShape(n)
        const videoMeta = videoMetaFromData(n.data)
        const mediaSummary =
          videoMeta !== null && videoMeta.clip !== null
            ? (function () {
                const summary = {
                  mediaKind: videoMeta.kind,
                  mediaClip: videoMeta.clip,
                  fps: videoMeta.fps,
                  posterFrame: videoMeta.posterFrame,
                }
                try {
                  const m = readManifest(clipDirFor(loaded.absolute, videoMeta.clip))
                  summary.frameCount = Array.isArray(m.frames) ? m.frames.length : 0
                  summary.duration = Number(m.duration) || 0
                  summary.hasSource = findSourceFile(clipDirFor(loaded.absolute, videoMeta.clip), m) !== null
                  summary.mediaMissing = false
                } catch (error) {
                  summary.frameCount = 0
                  summary.duration = 0
                  summary.hasSource = false
                  summary.mediaMissing = true
                }
                return summary
              })()
            : null
        nodes.push({
          id: String(n.id),
          label: typeof n.label === 'string' ? n.label : String(n.id),
          shape: isAudioNode(n) ? 'audio' : isShotCardNode(n) ? 'shotcard' : isMgStyleNode(n) ? 'mgstyle' : shapeName,
          ...(isAudioNode(n) ? {audio:JSON.stringify({data:n.data,settings:audioNodeSettings(n.data)})} : {}),
          ...(isShotCardNode(n) ? { cardId: n.data.shotCardId, styleKey: n.data.shotStyleKey, shotCommit: n.data.shotCommit } : {}),
          ...(isMgStyleNode(n) ? { slug: n.data.mgStyleSlug, mgStyleCommit: n.data.mgStyleCommit } : {}),
          // 报告里把内嵌的 SVG / 位图 data URI 从 style 里省略，免得一次读取被撑爆；
          // 写回时带这个标记会被拦住（assertNoStyleElision）。
          style: styleForReport(style),
          // 坐标与尺寸：**AI 也要看得见位置**。不给的话它判断不了"会不会重叠""有没有对齐"
          // （实测：想让它把某几个节点往右挪一点，它只能靠猜或者干脆删掉重画）。
          x: numberOr(n.x, 0),
          y: numberOr(n.y, 0),
          w: numberOr(n.w, DEFAULT_W),
          h: numberOr(n.h, DEFAULT_H),
          ...(Number.isFinite(n.labelOffsetX) ? { labelOffsetX: n.labelOffsetX } : {}),
          ...(Number.isFinite(n.labelOffsetY) ? { labelOffsetY: n.labelOffsetY } : {}),
          // 视频节点不回整段海报 svg（用 media 摘要）；普通 svg 节点照旧回 svg 字段。
          ...(shapeName !== 'video' && typeof svgMarkup === 'string' ? { svg: svgMarkup } : {}),
          // 位图节点：只报有图，不把 base64 塞进上下文（用户侧粘贴/拖入）。
          ...(shapeName === 'image' ? { image: true } : {}),
          ...(mediaSummary !== null ? mediaSummary : {}),
          ...(typeof n.layer === 'string' && n.layer.length > 0 ? { layer: n.layer } : {}),
          // 容器父级：AI 得知道"这东西在哪个分组里"，否则把容器挪走/删掉时它不知道会连带什么。
          ...(typeof n.parent === 'string' && n.parent.length > 0 ? { parent: n.parent } : {}),
          ...(fontColorFieldOf(style) !== undefined ? { fontColor: fontColorFieldOf(style) } : {}),
        })
      }
      const edges = []
      for (let i = 0; i < doc.edges.length; i += 1) {
        const e = doc.edges[i]
        if (keepEdge(e) === false) continue
        const style = typeof e.style === 'string' ? e.style : DEFAULT_EDGE_STYLE
        const item = {
          id: String(e.id),
          // 悬空端的这一端**没有真实顶点**：如实报空串，并把自由点一起给出
          // （报成 String(undefined) 会让模型以为那里真有个叫 "undefined" 的节点）。
          from: typeof e.from === 'string' ? e.from : '',
          to: typeof e.to === 'string' ? e.to : '',
          style: style,
          dash: dashFromStyle(style),
          arrow: arrowFromStyle(style),
        }
        if (typeof e.label === 'string' && e.label.length > 0) item.label = e.label
        // 派生 color：正好命中调色板就给名字（AI 好读），否则给原始 strokeColor ——
        // 不能因为"名字认不出"就让 AI 看不见颜色（drawio 的文档里本来就只有十六进制）。
        const name = colorNameFromStyle(style)
        if (name !== null && name !== 'plain') item.color = name
        else {
          const stroke = styleGet(style, 'strokeColor', null)
          if (stroke !== null && stroke !== DEFAULT_STROKE) item.color = stroke
        }
        const exit = sideFromStyle(style, 'source')
        const entry = sideFromStyle(style, 'target')
        if (exit !== null) item.exit = exit
        if (entry !== null) item.entry = entry
        const points = normalizePoints(e.points)
        if (points !== null) item.points = points
        if (e.sourcePoint !== undefined) item.sourcePoint = e.sourcePoint
        if (e.targetPoint !== undefined) item.targetPoint = e.targetPoint
        // 标签位置（拖过才有）：给了 x/y 就一起回，改它用 setLabelPos。
        if (Number.isFinite(Number(e.labelX)) && Number.isFinite(Number(e.labelY))) {
          item.labelX = Number(e.labelX)
          item.labelY = Number(e.labelY)
          if (Number.isFinite(Number(e.labelOffsetX))) item.labelOffsetX = Number(e.labelOffsetX)
          if (Number.isFinite(Number(e.labelOffsetY))) item.labelOffsetY = Number(e.labelOffsetY)
        }
        if (typeof e.layer === 'string' && e.layer.length > 0) item.layer = e.layer
        const edgeFont = fontColorFieldOf(style)
        if (edgeFont !== undefined) item.fontColor = edgeFont
        edges.push(item)
      }
      // 顺路带两件事（都要在 output.schema 里声明 —— additionalProperties:false 会把
      // 没声明的字段整个判为非法输出，这条踩过一次）：
      //   highlight —— AI 用 `{op:'highlight'}` 请求的高亮，取走即清；
      //   canRevert —— 这张画布上有没有可退回的 AI 改动。
      const pendingHighlight = highlightFor.get(sessionIdOf(exec))
      if (pendingHighlight !== undefined) highlightFor.delete(sessionIdOf(exec))
      const exportState = exportStateFor(sessionIdOf(exec), loaded.absolute)
      // 「看一眼」（render:true）：交图，或挂一个渲染请求。
      //
      // 四道门依次过：附件服务在不在（图片的落脚处）→ 模型声明不声明图片输入 → 手上有没有渲好的图
      // → 画布是不是真开着（渲染在浏览器里做，没打开就没人接请求）。
      // 过不去时**给一句人话**（而不是抛错）—— AI 还能照常读几何、改图，只是看不到图。
      let lookState = undefined
      let imageValue = undefined
      if (args.render === true) {
        const attachments = attachmentsService()
        if (attachments === undefined || attachments === null) {
          lookState = { status: 'unsupported', error: '这个部署没有挂附件服务（attachments），图片进不了模型上下文' }
        } else {
          const capable = await imageInputSupported(exec)
          if (capable === false) {
            lookState = { status: 'unsupported', error: '当前模型没有声明图片输入能力；换一个支持图片的模型再看' }
          } else {
            const state = renderStateFor(sessionIdOf(exec), loaded.absolute, doc.revision)
            if (state !== undefined && state.status === 'failed') {
              lookState = { status: 'failed', error: state.error }
              renderedImages.delete(sessionIdOf(exec))
            } else if (state !== undefined && state.status === 'ready') {
              const taken = takeRenderedImage(sessionIdOf(exec))
              if (taken !== undefined) {
                lookState = taken.revision === doc.revision ? { status: 'ready' } : { status: 'ready', stale: true }
                imageValue = taken.image
              }
            } else {
              // 渲染在**浏览器**里做：只有用户正打开着这张画布时客户端才会接这个请求。
              // 宿主知道用户看的是**别的**画布时就直接说清楚（not-open）—— 否则会挂一个
              // 永远等不到回执的请求，模型只能反复重试（issue #12）。聚焦未知时仍按老规矩挂
              // pending：刚打开的画布可能还没来得及上报，误判成"没开"会更让人困惑。
              const focusedAbsolute = await focusedAbsoluteOf(sessionIdOf(exec))
              if (focusedAbsolute !== undefined && samePath(focusedAbsolute, loaded.absolute) === false) {
                lookState = {
                  status: 'not-open',
                  error:
                    '看不了这张画布的渲染图：右侧栏现在打开的是 ' + focusedAbsolute +
                    '，渲染请求没有画布接。先把这张画布打开再调一次；只要几何数据的话去掉 render:true。',
                }
              } else if (state !== undefined && state.status === 'timeout') {
                lookState = {
                  status: 'timeout',
                  waitedMs: state.waitedMs,
                  error:
                    '渲染请求挂了 ' + Math.round(state.waitedMs / 1000) + ' 秒没人接：多半是右侧栏没打开这张画布（或画布与宿主的连接断了）。' +
                    '先打开它再调一次；只想要几何数据的话去掉 render:true。',
                }
              } else {
                // 同一张画布已有请求就沿用（客户端按 requestId 去重，换 id 会让它再渲一遍）。
                const existing = renderRequests.get(sessionIdOf(exec))
                if (existing === undefined || existing.absolute !== loaded.absolute) {
                  // 换了画布：上一张渲好的图作废（否则会把 A 图的画面当 B 图交给模型）。
                  renderedImages.delete(sessionIdOf(exec))
                  renderRequests.set(sessionIdOf(exec), {
                    requestId: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                    absolute: loaded.absolute,
                    revision: doc.revision,
                    // 请求挂上的时刻：UI 那半边一直不回执时，靠它算"已经等了多久"（见 renderStateFor 的超时）。
                    at: Date.now(),
                  })
                }
                lookState = {
                  status: 'pending',
                  waitedMs: state !== undefined && state.status === 'pending' ? state.waitedMs : 0,
                }
              }
            }
          }
        }
      }
      return {
        path: loaded.absolute,
        revision: doc.revision,
        ...(doc.page !== undefined && doc.page !== null ? { page: { w: Number(doc.page.w), h: Number(doc.page.h) } } : {}),
        pageIndex: loaded.pageIndex,
        pageCount: loaded.pageCount,
        pageNames: Array.isArray(loaded.pageNames) ? loaded.pageNames : [],
        ...(filtered ? { filtered: true, totalNodes: doc.nodes.length, totalEdges: doc.edges.length } : {}),
        ...(lookState !== undefined ? { look: lookState } : {}),
        ...(imageValue !== undefined ? { image: imageValue } : {}),
        notes: loaded.notes,
        nodes: nodes,
        edges: edges,
        ...(exportState !== undefined ? { export: exportState } : {}),
        highlight: Array.isArray(pendingHighlight) ? pendingHighlight : [],
        canRevert: revertDepth(snapshotKey(sessionIdOf(exec), loaded.absolute)) > 0,
        // 还能退回几步（栈深）：模型据此告诉用户"可以连按几次撤销"。
        revertSteps: revertDepth(snapshotKey(sessionIdOf(exec), loaded.absolute)),
        // 用户当前的选区（按文件配对、按存在过滤）：用户说"把这几个…"时指的就是它们。
        // 过滤过也要照旧回 —— "用户选中的那几个"正是最该看的东西。
        selection: selectionForCanvas(sessionIdOf(exec), loaded.absolute, doc),
        // 图层表（顺序 = 叠放顺序）：加层/移层/改名看 diagram_apply 的 addLayer/setLayer/setLayerProps。
        layers: (Array.isArray(doc.layers) ? doc.layers : []).map((l) => ({
          id: String(l.id),
          name: typeof l.name === 'string' ? l.name : '',
          visible: l.visible !== false,
          locked: l.locked === true,
        })),
      }
    },
  })

  const applyTool = defineTool({
    name: 'diagram_apply',
    description:
      '对工作区里的 DrawAI 画布文档施加一组结构化编辑（加节点/连边/改标签/改样式/移动/删除/高亮），然后自动布局并写回文件。布局默认由这里算；ops 里一旦自带几何（addNode 给了 x/y，或有 move）就不再重排，想重排请显式给 layout。' +
      'ops 的每一项形如 {op:"addNode", label?, as?, shape?, svg?, style?, keys?, data?, w?, h?, x?, y?, fontColor?} / ' +
      '{op:"addEdge", from?, to?, fromPoint?, toPoint?, as?, label?, points?, style?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, keys?} / ' +
      '{op:"setLabel", id|ids, label} / {op:"setLabelPos", id, x?, y?, dx?, dy?, center?} / {op:"setStyle", id|ids, shape?, svg?, style?, keys?, w?, h?, dash?, arrow?, color?, exit?, entry?, jettySize?, edgeStyle?, line?, avoid?, fontSize?, fontColor?, clearPoints?} / ' +
      '{op:"setEdge", id, from?, to?, fromPoint?, toPoint?, points?} / {op:"order", id|ids, to:"front"|"back"|"up"|"down"} / ' +
      '{op:"duplicate", id|ids, dx?, dy?, withEdges?, layer?, as?} / {op:"addLayer", name?, as?} / {op:"setLayer", id|ids, layer} / {op:"setLayerProps", layer, name?, visible?, locked?} / ' +
      '{op:"export", format?:"svg"|"png", name?} / ' +
      '{op:"traceImage", image, removeBg, preset?, w?, h?, x?, y?, colors?, colorsDark?, colorsFill?, grid?, gridH?, scale?, epsilon?, minArea?, minRegionArea?, protectLuma?, majorityContrast?, bgColor?, as?, layer?} / ' +
      '{op:"move", id|ids, dx?, dy?, x?, y?} / {op:"remove", id|ids} / {op:"highlight", ids:[...]}；节点 id 省略时自动分配。' +
      '**改接一条边**用 setEdge（换 from/to 或某一端改成自由点）—— id、标签、标签位置、折点、端点约束全都留着；' +
      '不要 remove + addEdge 重画（那会把这些丢掉）。' +
      '**边上的文字压住线**时用 setLabelPos {id, center:true} 放回弧长中点，或用 {id, dy:12} 把它往上/下挪 12px' +
      '（x 是沿边比例 -1..1，0 = 中点；diagram_read 回 labelX/labelY 告诉你它现在在哪）。' +
      '**顺序**用 order（front 到最上面 / back / up / down，与画布右键同一套；它改的是文件里单元的先后）。' +
      '**再复制一份**用 duplicate（新 id + 整体平移两格，折点/端点约束/标签位置都带过去；默认连"两端都在复制范围内的边"一起复制）。' +
      '**图层**用 addLayer/setLayer/setLayerProps（加层、把单元移到别的层、改名/显示/隐藏/锁定；隐藏≠删除）。' +
      '**导出**用 export：format:"svg" 会让画布渲染一张 SVG 落在 .drawio 旁边、format:"png" 是浏览器下载；' +
      '这一步由画布执行，返回值里的 export.status 是 pending/done/downloaded/failed（pending = 画布还没刷新）。' +
      '**照着一张位图描矢量图**用 traceImage：{op:"traceImage", image:"ref.png", removeBg:false, x, y} 会真的读像素建成 svg 节点，' +
      '**不是凭印象重画**。默认 w/h = 原图像素尺寸（1:1）。' +
      '**removeBg 必填**（无 auto）：true=抠背景（先识纯色底，否则近白泛洪）；false=整图保留。' +
      '白底/纯色底图标通常 true；风景/照片/场景背景通常 false。' +
      '**调参**：先选 preset（' + TRACE_PRESET_NAMES.join('|') + '；lineart=插画线稿、photo=照片、simple=省字符、default=默认），' +
      '再按需覆盖 colors/colorsDark/scale/epsilon/grid/gridH/minArea/minRegionArea/protectLuma/majorityContrast/bgColor 等。' +
      '合并顺序：默认 ← preset ← 显式字段。' +
      '返回值里的 **trace[]** 是结构化指标（svgChars/bgRemoved/bgDetect/options/hint 等）；' +
      '质量不够就根据 hint remove 旧节点再 trace（改 preset 或字段）。' +
      '字符紧→scale:2/加大epsilon/preset:simple；线糊断→preset:lineart 或提高 protectLuma/colorsDark。' +
      '**一次改一组**就写 ids:[...]（setStyle/setLabel/move/remove 都收，move 的批量只收 dx/dy 相对位移）—— 用户说"把这几个换成绿色"时不要逐个发 op。' +
      '**引用刚建的那个**用 as:"名字"：{op:"addNode", label:"开始", as:"start"} 之后同一个 ops 数组里 from/to/id 可以直接写 "start"，不必猜自动分配的 n7。' +
      '镜头参考节点：先用 shotcraft_search 搜索，再 addNode {shape:"shotcard",cardId:"准确卡名",styleKey:"准确样式key",x,y,as:"ref"}；用 addEdge 从该节点连到视频，支持多卡。' +
   '整片风格节点：先用 mg_style {action:"list"} 选好风格，再 addNode {shape:"mgstyle",slug:"09-bauhaus",x,y,as:"style"} 连到视频；一条片子只用一种，建工程时它的色板会写成 theme.ts、施工说明写成 STYLE.md。' +
      '**画图形（图标/logo/示意图）用 svg**：addNode {shape:"svg", svg:"<svg viewBox=…>…</svg>", w, h} 让节点的内容就是那段 SVG 标记' +
      '（不带字时可以不给 label）；setStyle {id, svg:"<svg…>"} 换图、{id, svg:null} 清掉回到矩形。' +
      '标记**必须带 viewBox**（否则放大缩小时图形不跟着变）、默认拉伸铺满节点框（要等比就用 keys:{imageAspect:1}）。' +
      '落盘是 drawio 原生的图片形状（shape=image + data:image/svg+xml），drawio 桌面版打开同样看得见图。' +
      '返回值里的 created/changed/removed 是结构化 id（含自动分配的那些），不用去解析 summary 文本。' +
      'expectRevision：把上一次 diagram_read 返回的 revision 传进来当乐观锁 —— 对不上（用户同时在 drawio 里改过）就**直接报错、一个字节都不写**，重读一次再改。' +
      'addEdge 的两端各自可以给**节点 id** 或**绝对点**（fromPoint/toPoint）—— 两端都给点就是一条**独立线**' +
      '（drawio 里边的两端都可以是自由点，线可以完全不接节点）。' +
      'move 改已有元素的位置：节点可以给 dx/dy（相对）或 x/y（绝对），连线只能给 dx/dy（平移它自己的折点与自由端点）。' +
      '以前没有 move，只能删掉重画 —— 那会丢 id、丢边上的端点约束与折点。' +
      'highlight 只让客户端选中那几个（不改文档，也不重排）。' +
      '文档里存的是 **drawio 的 style 键**（dashed/dashPattern/edgeStyle/jettySize/libavoidRouting/exitX·exitY·entryX·entryY/endArrow·startArrow/strokeColor/fillColor/shape=/rounded=/arcSize=…），默认值一律省略、认不出的键原样保留；' +
      '上面这些 shape/style/dash/arrow/color/exit/entry 是给模型用的**糖**，由宿主翻译成 style 键，绝不落盘。' +
      'style 既可以是调色板名（plain/blue/green/orange/yellow/red/purple/grey），也可以直接是一段 style 串；keys 用来写任意 drawio 键（值给 null = 删键回默认）。' +
      '精确布线：addEdge / setEdge 支持 points:[{x,y},...]，按源端到目标端顺序指定中间折点（不含端点），绝对画布坐标、保留小数、不吸附网格，最多1000个。显式 points 切入手动模式，自动路由不会覆盖；不能同时给 avoid:true。points:[] 清空并保持手动，省略 points 保留原折点。仅在用户明确要求自动避障时使用 setStyle{avoid:true,clearPoints:true}。正交模式自行规划水平/垂直通道；仅在用户明确要求非正交逐段连线时使用 line:"straight"。先确定节点位置，再用 layout:"none" 写入。' +
      '端点由连接侧决定，插件自行补引出段；points 不得包含起点、终点或重复点，直接对齐且通道畅通时用 points:[]。例如 A 的右侧连接点为 (300,130)、B 的左侧连接点为 (400,175)，指定 exit:"e",entry:"w",points:[{x:340,y:175}]；不要将 (400,175) 加为折点，否则可能折返。操作后读回坐标与折点，并在图像通道可用时用 diagram_read render:true 查看实际路径，必要时用 setEdge 调整；无法看图时如实说明。' +
      'setStyle 的 id 可以是节点也可以是连线：节点用 shape/style/keys/w/h/fontColor，连线用 dash（solid|dashed|dotted）、arrow（end 单向|both 双向|none 无箭头|start 反向）、color（**线本身**的颜色）、exit/entry（n|e|s|w 进出侧）、jettySize（引出段长度，数字或 auto）、edgeStyle（orthogonalEdgeStyle|none）、line（straight 直线|sharp 直角折线|rounded 圆角折线|curved 曲线）、avoid（是否参与避让路由）、fontSize（字号）、fontColor（**文字**颜色）、clearPoints（清掉折点）。' +
      'fontColor 给调色板名（plain/blue/green/orange/yellow/red/purple/grey）就按画布上"文字换色"那一支取色，给 #b85450 这类色值就原样写；fontColor:null 删键回缺省（黑字）。' +
      '工作流新建节点连接默认圆角折线、手动模式。AI 先确定或读回节点坐标，自己规划水平/垂直通道，用 addEdge 的 points 传中间折点；先布局后连线，检查不穿节点、文字，不交叉或重叠。不要启用自动避障。文档若带 meta.pinned（人手工摆过位置），不加 layout 就不会重排；显式重排保留手动折点，移动节点后需复核并按需更新。' +      '边引用了不存在的节点会直接报错，且失败发生在写盘之前。自环写成 from === to（与 drawio 一致）；自动布局会忽略自环，只摆节点。' +
      '写入必须显式传 path；不确定目标时先用 diagram_read 读取当前聚焦画布，使用其返回的 path。' +
      '多页文件用 page（0 起）指定要改哪一页；不传 = 用户正在看的那一页。其它页字节原样保留。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description:
          '必填：目标画布的工作区相对路径或绝对路径；先用 diagram_read 确定当前画布。',
      },
      page: {
        type: 'number',
        description:
          '多页文件里要改的页下标（从 0 起）。不传 = 用户画布当前页；写回只动这一页，其它页原样保留。',
      },
      ops: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description: '结构化编辑数组，见工具描述里的 ops 语法',
      },
      layout: {
        type: 'string',
        enum: ['dagre-lr', 'dagre-tb', 'grid', 'none'],
        description: '自动布局：dagre-tb 上到下（默认，贴合右栏窄高形状）、dagre-lr 左到右、grid 网格、none 保留现有坐标（只给无坐标的新节点补位）',
      },
      expectRevision: {
        type: 'string',
        description:
          '乐观锁：上一次 diagram_read 返回的 revision（文件内容指纹）。对不上说明这份文件在你会话中途被别人改过（用户同时在 drawio 里编辑），本次调用**直接失败且不写盘**，重新读一次再改。不传 = 不检查。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          revision: { type: 'string', required: true },
          nodeCount: { type: 'number', required: true },
          edgeCount: { type: 'number', required: true },
          layout: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          // 这次调用真的建了哪些单元（含自动分配的 id 与别名指向的那个）——
          // 模型要接着引用它们时不必再读一次、也不必解析 summary 文本。
          created: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                label: { type: 'string' },
              },
            },
          },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          removed: { type: 'array', required: true, items: { type: 'string' } },
          // 导出状态（只有请求过导出才有）：pending = 画布还没渲染，done = 文件已写出（path），
          // downloaded = png 已由浏览器下载，failed = 渲染失败（error 是原因）。
          export: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              format: { type: 'string', required: true },
              path: { type: 'string' },
              error: { type: 'string' },
            },
          },
          // 抽帧状态（只有下过抽帧计划才有）：pending = 计划挂在画布上、还没抽；done = stills 已写出
          // （written 是张数）；failed = 抽帧时报错（error 是原因）。报告一次即清（取走即清）。
          extract: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              clip: { type: 'string' },
              seconds: { type: 'number' },
              fps: { type: 'number' },
              width: { type: 'number' },
              max: { type: 'number' },
              written: { type: 'number' },
              error: { type: 'string' },
            },
          },
          // 本次调用里每次 traceImage / traceFrame 一条：给模型读指标再调参（additionalProperties:false 必须声明）
          trace: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                preset: { type: 'string' },
                image: { type: 'string' },
                nodeId: { type: 'string' },
                // traceFrame 才有：视频节点 id 与帧下标
                id: { type: 'string' },
                frame: { type: 'number' },
                // 只描了原图的一块时才有：那块在原图里的位置与尺寸（像素）
                crop: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' },
                  },
                },
                source: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    width: { type: 'number' },
                    height: { type: 'number' },
                  },
                },
                work: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    width: { type: 'number' },
                    height: { type: 'number' },
                    scale: { type: 'number' },
                  },
                },
                scaleApplied: { type: 'number' },
                sizeNotes: { type: 'string' },
                colors: { type: 'number' },
                colorsDark: { type: 'number' },
                colorsFill: { type: 'number' },
                protectPixels: { type: 'number' },
                majoritySkipped: { type: 'number' },
                paths: { type: 'number' },
                loopsKept: { type: 'number' },
                loopsProtectedKept: { type: 'number' },
                regionsProtected: { type: 'number' },
                svgChars: { type: 'number' },
                budget: { type: 'number' },
                attempts: { type: 'number' },
                exactPixelCoverage: { type: 'boolean' },
                labelPartitionComplete: { type: 'boolean' },
                coverageBasis: { type: 'string' },
                loopsDropped: { type: 'number' },
                budgetExceeded: { type: 'boolean' },
                appliedEpsilon: { type: 'number' },
                bgRemoved: { type: 'boolean' },
                bgDetect: { type: 'json' },
                options: { type: 'json' },
                hint: { type: 'string' },
              },
            },
          },
          // listFrames / getFrame / extractFrames / export* 的结构化回执（heterogeneous —— 用 json）
          media: {
            type: 'array',
            items: { type: 'json' },
          },
        },
      },
      render: function (args, value) {
        const created = Array.isArray(value.created) ? value.created : []
        const bits = []
        if (created.length > 0) {
          bits.push('新建 ' + created.map((c) => c.id + '(' + c.type + ')').join(', '))
        }
        if (Array.isArray(value.changed) && value.changed.length > 0) bits.push('改动 ' + value.changed.join(', '))
        if (Array.isArray(value.removed) && value.removed.length > 0) bits.push('删除 ' + value.removed.join(', '))
        if (Array.isArray(value.trace) && value.trace.length > 0) {
          bits.push(
            '矢量化 ' +
              value.trace
                .map(function (t) {
                  return (
                    (t.image || (typeof t.frame === 'number' ? 'frame[' + t.frame + ']' : '?')) +
                    ' preset=' +
                    (t.preset || 'default') +
                    ' ' +
                    t.svgChars +
                    '字' +
                    (t.hint ? ' | ' + t.hint : '')
                  )
                })
                .join('；'),
          )
        }
        return [
          {
            type: 'text',
            text:
              '已更新 ' + value.path + '：revision ' + value.revision + '，' + value.nodeCount + ' 节点 / ' + value.edgeCount +
              ' 边，布局 ' + value.layout + (bits.length > 0 ? '\n' + bits.join('；') : '') + '\n' + value.summary,
          },
        ]
      },
    },
    async execute(args, exec) {
      // 写入必须显式给路径，避免聚焦上报延迟或缺失时误改另一张画布。
      const path = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path : ''
      if (!path) throw new Error('未指定画布路径：请先用 diagram_read 确认目标画布，再显式传入 path')
      // **入参是宿主深冻结的**：dsh-tools 在 execute 之前把整份 arguments 深冻结
      // （`arguments: deepFreeze(snapshotJsonValue(exec.arguments))`，见 dsh-tools 的 tool 执行器），
      // 数组和里面的 op 对象都是 non-extensible。所以这里必须**复制成一份可扩展的数组**再用：
      // traceImage 会往 ops 里插一条合成的 addNode（见下面 applyOps 里的 `ops.splice`），
      // 就地改冻结数组会抛 `Cannot add property N, object is not extensible`。
      // op 落盘语义不受影响 —— 复制出来的数组里元素仍是原来那些（本文件只读它们，从不写回）。
      const ops = Array.isArray(args.ops) ? args.ops.slice() : []
      if (ops.length === 0) throw new Error('ops must contain at least one operation')

      const sessionId = sessionIdOf(exec)
      assertCanvasPath(path)
      const pageArg = Number.isFinite(Number(args.page)) ? Number(args.page) : focusedPageFor(sessionId)
      const loaded = await loadDoc(path, sessionId, pageArg)
      const doc = loaded.doc

      // 乐观锁：`revision` 是**文件内容指纹**（见 loadDoc），把它传给 expectRevision 就能保证
      // "我读到的那一版"和"我现在要改的那一版"是同一份。
      //
      // 为什么需要：read 返回的 revision 原来在 AI 侧**没有任何用处**（409 只存在于画布保存那条
      // 路由上），于是"AI 读 → 用户在 drawio 里改 → AI 写"这条时序会把用户的改动**静默**覆盖掉。
      // 现在基线对不上就直接报错、**一个字节都不写**，让模型重读一次再改。
      const expect = typeof args.expectRevision === 'string' && args.expectRevision.length > 0 ? args.expectRevision : undefined
      if (expect !== undefined && expect !== doc.revision) {
        throw new Error(
          'revision conflict：你给的是 ' + expect + '，"' + loaded.absolute + '" 现在是 ' +
            (loaded.exists === true ? doc.revision : '(文件不存在)') +
            ' —— 别覆盖别人的改动。重新 diagram_read 一次，拿新的 revision 再改。',
        )
      }

      // 人工摆过的文档（meta.pinned）默认不再自动重排 —— 否则 AI 一改图，
      // 人手工调好的位置就被 dagre 全冲掉了。想重排必须显式指定 layout。
      const pinned = doc.meta !== null && typeof doc.meta === 'object' && doc.meta.pinned === true
      // `highlight` 只是"让客户端选中这几个"、`export` 只是"让画布渲染一张图"—— 都不改文档：
      //   · 一次全是这类 op 的调用**不写盘**（也不会顺手重排，那条特别危险）；
      //   · 混着编辑时，它们跟着一起生效。
      const edits = ops.filter((op) => {
        if (op === null || typeof op !== 'object') return true
        if (op.op === 'highlight' || op.op === 'export') return false
        // 旁路媒体 ops 默认不改 .drawio；setMediaMeta / importMedia / setFrame(海报) 可能改，
        // 下面用 out.changed 再判定是否真要写盘。
        if (MEDIA_SIDE_OPS[op.op] === true) return false
        return true
      })
      const noDocEdit = edits.length === 0
      // 默认布局：pinned、纯 highlight、以及**ops 里自带几何**（addNode 给了 x/y、有 move、
      // 或有 duplicate —— 复制出来的位置是相对原件的）时都不重排 —— 否则"把 n1 往右挪 40"
      // 会被 dagre 立刻冲掉（实测：move 完坐标原样回来，看起来像工具坏了），
      // 复制也一样（刚贴出来的那份会连同原件一起被重排走）。
      const explicitGeometry = ops.some(
        (op) =>
          op !== null &&
          typeof op === 'object' &&
          (op.op === 'move' ||
            op.op === 'duplicate' ||
            (op.op === 'addNode' && (Number.isFinite(Number(op.x)) || Number.isFinite(Number(op.y))))),
      )
      const mode = typeof args.layout === 'string' ? args.layout : pinned || noDocEdit || explicitGeometry ? 'none' : 'dagre-tb'
      if (LAYOUTS.indexOf(mode) < 0) throw new Error('unknown layout "' + mode + '"; use one of ' + LAYOUTS.join(', '))

      const routingBefore = JSON.parse(JSON.stringify(doc))

      const out = {}
      const opctx = {
        drawioPath: loaded.absolute,
        traceRaster: (raster, options) => videoTracePool.runRaster(raster, { ...options, mode: 'raw-image' }),
        ensureClips: [],
        /**
         * traceImage 的图片读取：走**同一个工作区解析器**（相对路径按会话根解析），
         * 于是"AI 能描哪张图"和"画布能打开哪些文件"是同一套围栏。
         * 上限给得比 SVG 上限宽：一张 499×847 的 PNG 才 0.4MB，32MB 足够任何贴进来的截图，
         * 又不至于让一次调用把宿主内存吃干。
         */
        readBytes: async function (imagePath, where) {
          let target
          try {
            target = await resolveTarget(imagePath, sessionId)
          } catch (error) {
            throw new Error(where + ': 读不到 "' + imagePath + '"（' + messageOf(error) + '）')
          }
          const info = await ctx.fs.stat(target)
          if (info === undefined) {
            throw new Error(where + ': 工作区里没有 "' + imagePath + '"（路径相对会话工作区，或用绝对路径）')
          }
          try {
            return await ctx.fs.readBytes(target, undefined, TRACE_IMAGE_MAX_BYTES)
          } catch (error) {
            throw new Error(where + ': 读 "' + imagePath + '" 失败（' + messageOf(error) + '）')
          }
        },
        readAbsolutePath: async function (filePath, where) {
          const target = await resolveTarget(filePath, sessionId)
          const abs = absoluteHint(target, filePath)
          const info = await ctx.fs.stat(target)
          if (info === undefined) throw new Error(where + ': 工作区里没有 "' + filePath + '"')
          return abs
        },
        writeWorkspaceFile: async function (relPath, buffer, where) {
          const root = workspaceRootOf(sessionId)
          if (root === undefined) throw new Error(where + ': no workspace root')
          const safe = String(relPath).replace(/^[\\/]+/, '')
          if (safe.indexOf('..') >= 0) throw new Error(where + ': path must stay in workspace')
          const abs = joinPath(root, safe)
          await mkdir(dirnamePath(abs), { recursive: true })
          await writeFile(abs, buffer)
          return safe.replace(/\\/g, '/')
        },
      }
      const notes = await applyOps(doc, ops, out, opctx)
      // 新建 / 已有视频节点：确保旁路 `*.media/<clip>/` 存在。
      {
        const seen = new Set()
        const queue = Array.isArray(opctx.ensureClips) ? opctx.ensureClips.slice() : []
        for (let ni = 0; ni < doc.nodes.length; ni += 1) {
          const meta = videoMetaFromData(doc.nodes[ni].data)
          if (meta === null || meta.clip === null) continue
          queue.push({ clip: meta.clip, kind: meta.kind, fps: meta.fps, w: meta.w, h: meta.h })
        }
        for (let qi = 0; qi < queue.length; qi += 1) {
          const item = queue[qi]
          if (seen.has(item.clip)) continue
          seen.add(item.clip)
          ensureClipPack(loaded.absolute, item.clip, item)
        }
      }
      if (Array.isArray(out.highlight)) highlightFor.set(sessionId, out.highlight)
      // 删掉的东西不该还挂在"用户选中"里（id 会被复用，见 forgetSelection）。
      if (Array.isArray(out.removed) && out.removed.length > 0) forgetSelection(sessionId, loaded.absolute, out.removed)
      // 导出请求：登记下来（画布下一次轮询时取走并渲染），并把上一次的结果清掉，免得模型看到旧的。
      if (out.export !== undefined && out.export !== null) {
        const requestId = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        exportRequests.set(sessionId, { requestId: requestId, absolute: loaded.absolute, format: out.export.format, name: out.export.name })
        exportResults.delete(sessionId)
      }
      // The host owns extraction; the browser receives status only.
      if (out.extract !== undefined && out.extract !== null) {
        const requestId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        extractRequests.set(sessionId, {
          requestId: requestId,
          absolute: loaded.absolute,
          clip: out.extract.clip,
          from: out.extract.from,
          seconds: out.extract.seconds,
          fps: out.extract.fps,
          width: out.extract.width,
          max: out.extract.max,
          host: true,
        })
        extractResults.delete(sessionId)
      }
      // 抽帧状态：pending 得留着（模型据此看进度）；done / failed **只报一次就清掉** ——
      // 否则这条回执会永远粘在之后每一次 diagram_apply 上（与 highlight「取走即清」同一套）。
      const extractState = extractStateFor(sessionId, loaded.absolute)
      if (extractState !== undefined && extractState.status !== 'pending') extractResults.delete(sessionId)
      const mediaChangedDoc =
        Array.isArray(out.changed) && out.changed.length > 0 &&
        ops.some((op) => op !== null && typeof op === 'object' && (op.op === 'setMediaMeta' || op.op === 'importMedia' || op.op === 'setFrame' || op.op === 'traceFrame'))
      if (noDocEdit && mediaChangedDoc === false) {
        if (out.extract) await startHostExtraction(sessionId, loaded, out.extract)
        // toLosslessJson：宿主对工具输出做 isJsonValue，自有属性值为 undefined / -0 会整次打回
        // （表现为 `returned invalid output: value is not lossless JSON`）。
        return toLosslessJson({
          path: loaded.absolute,
          revision: doc.revision,
          nodeCount: doc.nodes.length,
          edgeCount: doc.edges.length,
          layout: 'none',
          created: [],
          changed: [],
          removed: [],
          ...(Array.isArray(out.trace) && out.trace.length > 0 ? { trace: out.trace } : {}),
          ...(Array.isArray(out.media) && out.media.length > 0 ? { media: out.media } : {}),
          ...(exportStateFor(sessionId, loaded.absolute) !== undefined ? { export: exportStateFor(sessionId, loaded.absolute) } : {}),
          ...(extractState !== undefined ? { extract: extractState } : {}),
          summary: notes.length === 0 ? '(no change)' : notes.join('\n'),
        })
      }
      if (mode === 'none') placeMissing(doc)
      else {
        const before = nodePositions(doc)
        autoLayout(doc, mode)
        const dropped = invalidateStalePoints(doc, before)
        if (dropped > 0) notes.push('~ 重排后端点位置变了，将重算 ' + dropped + ' 条自动路线')
      }
      // 写回：**在原文件上做无损写回**（只改我们拥有的单元，其余原文逐字节保留）。
      // revision 由文件内容算出来，不再是"我们自己 +1"—— 载体即真相，没有第二个计数器。
      // meta.pinned 的合并规则见下面那句注释。
      //
      // 这里曾经写的是 doc.meta = { engine, layout }，于是**第一次 AI 改图就把 pinned 擦掉了**：
      // 那一次没事（mode 已经是 'none'，人不人的位置都保住了），但从第二次起 pinned 读不到，
      // mode 回落到 'dagre-tb'，人手工摆好的版面被整张重排 —— 正是上面那个判断要防的事。
      // 教训：用整体赋值覆盖 meta 时，"没被显式处理"的字段会静默消失；新增 meta 字段时先看这里。
      const routingResult = documentRouter.update(routingBefore, doc)
      if (routingResult.unavailable !== undefined) {
        // 引擎整体不可用（最常见：从 git 装的包少了 lib/routing/vendor/*）时，写回照常进行，
        // 只是这次没有自动路线。回执里必须说清楚，否则模型会以为"改完就是没走线"。
        notes.push('~ 自动避障不可用（' + routingResult.unavailable + '）：这次保留现有折点，新画的边按直线写回')
      } else if (routingResult.failed.length) notes.push('~ 自动避障暂无可用通道：' + routingResult.failed.join(', '))
      doc.meta = Object.assign({}, doc.meta, { layout: mode }, pinned ? { pinned: true } : {})
      const rendered = renderDocText(loaded.text, doc, { page: loaded.pageIndex, format: isNativeCanvasPath(loaded.absolute) ? 'drawai' : 'drawio' })
      doc.revision = rendered.revision
      if (rendered.dropped.length > 0) notes.push('~ ' + rendered.dropped.length + ' 条边的两端都没有落点，已略过：' + rendered.dropped.join(', '))
      const policy = policyFor(sessionId)
      // 落盘前留一份"上一版"：AI 的改动**不在客户端的撤销历史里**（服务端推新版本时
      // 客户端会清空本地历史，免得一次 Ctrl+Z 把 AI 的改动悄悄顶掉），
      // 所以这边给一个一层的回退点，界面上对应「编辑 → 撤销 AI 改动」。
      if (loaded.exists === true && typeof loaded.text === 'string') {
        pushRevertSnapshot(snapshotKey(sessionId, loaded.absolute), { text: loaded.text, revision: doc.revision })
      }
      try {
        if (policy === undefined) await ctx.fs.writeText(loaded.target, rendered.text)
        else await ctx.fs.writeText(loaded.target, rendered.text, undefined, undefined, policy)
      } catch (error) {
        const scope = policy === undefined ? 'unresolved policy' : policy.mode + ' @ ' + String(policy.workspaceRoot)
        throw new Error('write "' + loaded.absolute + '" failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']')
      }
      if (revertDepth(snapshotKey(sessionId, loaded.absolute)) > 0) {
        notes.push('↩ 这次改动可以退回（还能退 ' + revertDepth(snapshotKey(sessionId, loaded.absolute)) + ' 步）：界面上「编辑 → 撤销 AI 改动」')
      }
      if (out.extract) await startHostExtraction(sessionId, loaded, out.extract)
      return toLosslessJson({
        path: loaded.absolute,
        revision: doc.revision,
        nodeCount: doc.nodes.length,
        edgeCount: doc.edges.length,
        layout: mode,
        // 结构化"这次动了什么"：新建的 id（含自动分配的）与别名解析结果都在这里，
        // 模型不必再从 summary 文本里认 id。改完的 revision 也可以直接当 expectRevision 用。
        created: Array.isArray(out.created) ? out.created : [],
        changed: Array.isArray(out.changed) ? out.changed : [],
        removed: Array.isArray(out.removed) ? out.removed : [],
        ...(Array.isArray(out.trace) && out.trace.length > 0 ? { trace: out.trace } : {}),
        ...(Array.isArray(out.media) && out.media.length > 0 ? { media: out.media } : {}),
        ...(exportStateFor(sessionId, loaded.absolute) !== undefined ? { export: exportStateFor(sessionId, loaded.absolute) } : {}),
        ...(extractState !== undefined ? { extract: extractState } : {}),
        summary: notes.length === 0 ? '(no change)' : notes.join('\n'),
      })
    },
  })

/**
 * 校验"新建画布"的文件名。
 *
 * 只允许**单个文件名**（不含路径分隔符），且必须以 .drawio 结尾。
 * 这样即使用户在界面上输入 `..\\..\\x` 也进不来 —— 新建永远落在工作区根目录，
 * 不存在"写到哪里去了"的空间。想放到子目录请自己先建好再打开。
 */
function sanitizeNewName(raw) {
  const name = String(raw === undefined || raw === null ? '' : raw).trim()
  if (name.length === 0) return { ok: false, error: '请输入文件名' }
  if (/[\\/]/.test(name)) return { ok: false, error: '文件名不能包含路径分隔符（新建只落在工作区根目录）' }
  if (name === '.' || name === '..') return { ok: false, error: '文件名非法' }
  // 禁止 Windows 非法字符，省得写盘才失败
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return { ok: false, error: '文件名包含非法字符' }
  const withExt = isCanvasPath(name) ? name : name + '.drawai'
  if (withExt.length > 120) return { ok: false, error: '文件名过长' }
  return { ok: true, name: withExt }
}

  /**
   * `diagram_export`：宿主侧把画布直接导成 SVG / PNG —— **不需要浏览器那一半**。
   *
   * 为什么单独开一个工具，而不是给 `diagram_read {render:true}` 加 fallback：
   * `look` 状态里的 "ready" 含义是"浏览器真渲染过"，它的用途是看压线/重叠/观感；
   * 把宿主这条简化渲染混进同一个状态，模型会拿它当"看过图了"的依据去下结论。
   * issue #23 也说得很清楚：不改现有"画布优先"的行为，只补一条没有画布时的交付路径。
   *
   * 所以两条路分开：能开画布 → `render:true`；开不了（QQ/CLI）→ 这个工具出成品图。
   */
  const exportTool = defineTool({
    name: 'diagram_export',
    description:
      '把画布**在宿主侧**导出成成品图：SVG（矢量、零依赖）或 PNG（`@resvg/resvg-js` 栅格化）——' +
      '**不需要浏览器、不需要用户打开画布**。QQ / CLI 这类没有右侧栏的通道里，想要"把图发给用户"就用它。' +
      '与 `diagram_read {render:true}` 的分工：render 由浏览器真渲染、保真度最高（判断压线/重叠/观感靠它）；' +
      '这个工具是宿主按文档**重画的近似版本**（返回 fidelity="approximate"），用来交付成品图，别拿它判断像素级观感。' +
      '几何照同一套规则算：形状/圆角/虚线/箭头、标签换行与"文字撑高节点"、正交走线（用文档里存的折点）、' +
      '连线标签的落点与"字的位置不画线"；但文字量宽是按字符估算的（中文 1em、其余 0.55em），长标签可能差一行；' +
      '视频/卡片/音频节点只画通用形状（它们的内容在浏览器组件里）。所有降级项都在 warnings 里列出。' +
      '缺省写到画布旁边（同名，只换扩展名 .svg/.png），可用 out 指定；PNG 的 scale 缺省 2。',
    parameters: {
      path: {
        type: 'string',
        description: '画布路径（.drawio / .drawai）。不传 = 当前会话聚焦的画布。',
      },
      page: {
        type: 'number',
        description: '多页画布导哪一页（0 起）。不传 = 用户画布当前页（没上报过则第 1 页）。',
      },
      format: {
        type: 'string',
        enum: ['svg', 'png'],
        description:
          'svg = 矢量（零依赖、可再编辑、放大不糊）；png = 位图（发给用户 / 贴进文档 / 进PPT）。缺省 svg。',
      },
      scale: {
        type: 'number',
        description: 'PNG 的缩放倍数（缺省 2，1 = 1:1）。SVG 忽略这个参数。',
      },
      out: {
        type: 'string',
        description:
          '输出文件路径（必须在工作区内；相对路径按**画布所在目录**解析）。缺省 = 与画布同名、只换扩展名。',
      },
      theme: {
        type: 'string',
        enum: ['light', 'dark'],
        description: '配色：light 白纸黑线（缺省，适合交付）；dark 透明底 + 浅色字线。',
      },
      background: {
        type: 'string',
        description: '背景色：缺省 light 主题白底、dark 主题透明；也可给 #rrggbb 或 "transparent"。',
      },
      padding: {
        type: 'number',
        description: '内容四周留白（像素，缺省 24）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          details: { type: 'string', required: true },
          path: { type: 'string', required: true },
          absolute: { type: 'string' },
          format: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          bytes: { type: 'number' },
          fidelity: { type: 'string', required: true },
          nodes: { type: 'number' },
          edges: { type: 'number' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const path =
        typeof args.path === 'string' && args.path.trim().length > 0 ? args.path : focusedPathFor(sessionId)
      if (!path) throw new Error('未指定画布路径且当前会话没有聚焦画布，请传入 path 或先打开目标画布')
      assertCanvasPath(path)
      // 导出会往工作区写文件：只读会话里不放行（与其它会写盘的工具同一道闸）。
      if (policyFor(sessionId)?.mode === 'read-only') throw new Error('当前会话为只读，不能导出文件')
      const pageArg = Number.isFinite(Number(args.page)) ? Number(args.page) : focusedPageFor(sessionId)
      const loaded = await loadDoc(path, sessionId, pageArg)
      if (!loaded.exists) throw new Error('画布不存在：' + loaded.absolute)
      const format = String(args.format || 'svg').toLowerCase() === 'png' ? 'png' : 'svg'

      const built = buildExportSvg(loaded.doc, {
        theme: args.theme,
        background: args.background,
        padding: args.padding,
      })
      if (built.stats.nodes === 0 && built.stats.edges === 0) {
        throw new Error('画布是空的（0 个节点、0 条连线），没有可导出的内容')
      }

      // 输出位置：缺省落在画布旁边、同名换扩展名 —— 用户找得到，也不污染工作区根目录。
      const dir = dirnamePath(loaded.absolute)
      const base = basenamePath(loaded.absolute).replace(/\.(drawio|drawai)$/i, '')
      const outArg = typeof args.out === 'string' && args.out.trim().length > 0 ? args.out.trim() : ''
      const target =
        outArg.length === 0 ? joinPath(dir, base + '.' + format) : isAbsolute(outArg) ? outArg : resolvePath(dir, outArg)
      // 导出写的是成品图：out 指到画布文件上等于把图覆盖掉（svg 覆盖 .drawio 之后画布就打不开了）。
      if (/\.(drawio|drawai)$/i.test(target)) {
        throw new Error('导出不能覆盖画布文件：' + target + '；out 请用 .svg / .png 结尾')
      }
      const root = await ctx.fs.resolve(workspaceRootOf(sessionId))
      if (!ctx.fs.contains(root, target)) throw new Error('导出路径超出工作区：' + target)
      await mkdir(dirnamePath(target), { recursive: true })

      let width = built.width
      let height = built.height
      let bytes = 0
      if (format === 'svg') {
        await writeFile(target, built.svg, 'utf8')
        bytes = Buffer.byteLength(built.svg, 'utf8')
      } else {
        const raster = await rasterizeSvgToPng(built.svg, { scale: args.scale })
        await writeFile(target, raster.png)
        width = raster.width
        height = raster.height
        bytes = raster.png.length
      }

      const rel = relativePath(root, target)
      const warnings = built.warnings.slice(0, 20)
      const warningCount = built.warnings.length
      return {
        summary:
          '已导出 ' + format.toUpperCase() + '：' + rel + '（' + Math.round(width) + '×' + Math.round(height) + '）' +
          (warningCount > 0
            ? '，' + warningCount + ' 条降级提示见 details' + (warningCount > warnings.length ? '（只列前 ' + warnings.length + ' 条）' : '')
            : ''),
        details: JSON.stringify({
          path: rel,
          absolute: target,
          format: format,
          width: Math.round(width),
          height: Math.round(height),
          bytes: bytes,
          fidelity: 'approximate',
          nodes: built.stats.nodes,
          edges: built.stats.edges,
          warnings: warnings,
        }),
        path: rel,
        absolute: target,
        format: format,
        width: Math.round(width),
        height: Math.round(height),
        bytes: bytes,
        fidelity: 'approximate',
        nodes: built.stats.nodes,
        edges: built.stats.edges,
        warnings: warnings,
      }
    },
  })

  /**
   * 「画布聚焦」：记录每个会话当前**打开着**的画布路径。
   *
   * 为什么需要：AI 改图只认路径。不传 path 时原来会落到 demo.drawio ——
   * 于是"帮我在这张画布上画"会画到别的文件里，用户屏幕上毫无反应（实测踩过）。
   * 有了聚焦记录，不传 path 就改"用户正看着的那张"。
   *
   * 只存路径、不读内容：画布内容始终以文件为唯一真相源，这里记的只是"在看哪一张"。
   */
  const focusedCanvas = new Map()
  /** sessionId → 用户画布当前页下标（0 起）；配合 focusedCanvas。 */
  const focusedPage = new Map()
  /** 每个会话最近**注入过**的聚焦路径（同一张不重复打扰模型）。 */
  const injectedCanvas = new Map()
  /**
   * AI 改动前的"上一版"文本（按 会话+路径 存，**一个栈**，最多 `REVERT_STEPS` 层）。
   *
   * 客户端的撤销历史在服务端推来新版本时会被清空（故意的：否则一次 Ctrl+Z
   * 会把 AI 刚写的改动悄悄顶掉），所以 AI 的改动要能退，就得宿主自己留回退点。
   *
   * 为什么是栈而不是一层：一轮会话里 AI 往往连改好几次（"再挪一点""这两条也换颜色"），
   * 只留一层的话，用户按一下「撤销 AI 改动」就直接跳回最开始 —— 中间那几步无从恢复。
   * 现在每按一次退一步（界面上的菜单项可以连按），read 的 `revertSteps` 告诉模型还剩几步。
   */
  const revertSnapshots = new Map()
  /** 回退栈深度上限：够用（一轮对话的改图次数）又不至于把内存堆起来（每个快照就是一份文件全文）。 */
  const REVERT_STEPS = 8
  function pushRevertSnapshot(key, entry) {
    const stack = revertSnapshots.get(key)
    if (stack === undefined) revertSnapshots.set(key, [entry])
    else {
      stack.push(entry)
      while (stack.length > REVERT_STEPS) stack.shift()
    }
  }
  function revertDepth(key) {
    const stack = revertSnapshots.get(key)
    return stack === undefined ? 0 : stack.length
  }
  /** AI 请求的"高亮这些"（按会话，客户端下次来读时取走并清空）。 */
  const highlightFor = new Map()
  /**
   * 「看一眼这张画布」：把画布渲染成一张 PNG，经**附件的通道**直接进模型。
   *
   * 为什么不是落一个文件在工作区：用户的诉求是"AI 看图，但别在我的项目里留东西"。
   * 所以这条路**一个字节都不写工作区** —— 渲染好的 PNG 交给 DSH 的附件服务
   * （`attachments.saveImage`，内容寻址、在工作区之外，与用户上传图片是同一套存储），
   * 工具结果里带一个 `{type:'image', attachment}` 内容块，模型就"看见"了。
   *
   * 渲染仍然在浏览器那一半（正交路由、避让、圆角、断线都在那儿），所以这是一条
   * **请求/回执**通道：宿主挂请求 → 客户端轮询取走 → canvas 渲成 PNG → base64 回执
   * → 宿主存成附件 → 下一次 `diagram_read {render:true}` 把图带回去。
   */
  const renderRequests = new Map()
  /** 渲染好的图（按会话）：`{ absolute, revision, image, at }` —— 取走即清，超时作废。 */
  const renderedImages = new Map()
  /** 渲染结果的保鲜期：超过它就不再交付（要新的请重新请求一次，免得给模型看一张老图）。 */
  const RENDER_TTL_MS = 5 * 60 * 1000
  /**
   * 挂着的渲染请求多久没人接就算超时。
   *
   * 渲染在浏览器里做：用户没打开画布时这条请求**根本没人接**，而旧代码只会一直回 pending
   * （issue #12：请求没有过期，模型分不清"正在渲"和"没人渲"）。25 秒足够大画布渲完，
   * 超过它就该如实说"没人接"而不是让模型反复重试。
   */
  const RENDER_PENDING_TTL_MS = 25 * 1000

  /** 附件服务（可选依赖）：这个部署没装它就没法"看图"，但插件其余功能照旧。 */
  function attachmentsService() {
    if (typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get('attachments')
    } catch (error) {
      return undefined
    }
  }

  /**
   * 当前路由的模型是否声明了**图片输入**。
   *
   * 与 `read_image` 同一套判据（provider/model 取会话的路由配置，回落到 agent options，
   * 再问 llm 服务的 `resolveModelInfo`）。**判不出来时不算失败**：DSH 自己会把图片降级成
   * 一句文字占位符（text-only 模型），所以这里只用来提前给一句人话，而不是拦死。
   */
  async function imageInputSupported(exec) {
    if (typeof ctx.get !== 'function') return undefined
    let llm
    try {
      llm = ctx.get('llm')
    } catch (error) {
      return undefined
    }
    if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') return undefined
    const agent = exec === undefined || exec === null ? undefined : exec.agent
    let provider
    let model
    try {
      const header = agent !== undefined && agent.session !== undefined && typeof agent.session.requestHeader === 'function' ? agent.session.requestHeader() : undefined
      const routed = header === undefined || header === null ? undefined : header.config
      provider = routed === undefined || routed === null ? undefined : routed.provider
      model = routed === undefined || routed === null ? undefined : routed.model
      if (provider === undefined && agent !== undefined && agent.options !== undefined) provider = agent.options.provider
      if (model === undefined && agent !== undefined && agent.options !== undefined) model = agent.options.model
    } catch (error) {
      return undefined
    }
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    try {
      const info = await llm.resolveModelInfo(provider, model, exec === undefined ? undefined : exec.signal)
      if (info === undefined || info === null || Array.isArray(info.inputModalities) === false) return undefined
      return info.inputModalities.indexOf('image') >= 0
    } catch (error) {
      return undefined
    }
  }

  /**
   * 「看图」这条路当前的可用性 + 待交付的图。
   *
   * 状态：`pending`（已请求，等画布渲染，带 waitedMs）/ `ready`（有图，这一次带回模型）/
   * `timeout`（挂了超过 RENDER_PENDING_TTL_MS 没人接，带 waitedMs —— 多半是画布没打开）/
   * `unsupported`（这个部署/模型看不了图，附一句为什么）/ `failed`（渲染回执说失败了）。
   */
  function renderStateFor(sessionId, absolute, revision) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const pending = renderRequests.get(sessionId)
    if (pending !== undefined && samePath(pending.absolute, absolute)) {
      const since = Number(pending.at)
      const waitedMs = Number.isFinite(since) ? Math.max(0, Date.now() - since) : 0
      // 不删这条请求：迟到一步的回执还要按 requestId 配回来（删了就永远配不上）。
      // 只是不再说"pending"——模型至少知道"没人接"，而不是"正在渲"。
      if (waitedMs > RENDER_PENDING_TTL_MS) return { status: 'timeout', waitedMs: waitedMs }
      return { status: 'pending', waitedMs: waitedMs }
    }
    const done = renderedImages.get(sessionId)
    if (done === undefined || done.absolute !== absolute) return undefined
    if (Date.now() - done.at > RENDER_TTL_MS) {
      renderedImages.delete(sessionId)
      return undefined
    }
    if (done.status === 'failed') return { status: 'failed', error: String(done.error) }
    return { status: 'ready', stale: done.revision !== revision, image: done.image }
  }

  /** 取走那张图（一次性）：模型看过就不再重复塞给它，要再看就再请求一次。 */
  function takeRenderedImage(sessionId) {
    const done = renderedImages.get(sessionId)
    if (done === undefined || done.status !== 'ready') return undefined
    renderedImages.delete(sessionId)
    return done
  }

  /**
   * 用户当前**选中**了哪几个单元（按会话）：`{ absolute, ids }`。
   *
   * 为什么需要：用户说"把这几个换成绿色""把它们挪右边一点"时，AI 原来只能靠坐标猜
   * （README 的 D 节第一条）。客户端本来就有选区状态，只是从来没告诉宿主。
   *
   * 两条设计约束：
   *   · **认文件**：记录里带绝对路径，只有读的正是那一张时才回 —— 否则"在 A 图选中的 n1"
   *     会被当成 B 图里的 n1（两个文件里都叫 n1 太常见了）；
   *   · **认存在**：回给模型前按**当前文档**过滤一遍（见 selectionForCanvas）—— 用户或 AI
   *     刚删掉的东西不该还在"选中"里。
   * 选区只是"用户在看什么"的提示，不是文档状态：**不进文件**，关掉画布就清。
   */
  const canvasSelection = new Map()
  /**
   * AI 请求的导出（按会话）：`{ requestId, absolute, format, name }`。
   *
   * 渲染只在浏览器里（路由、避让、圆角都在画布那一半），所以导出是一条**请求/回执**通道：
   * 宿主挂上请求 → 客户端下次轮询的 `read` 里取走 → 渲染完 POST 回 `export-result`
   * → 宿主写文件（svg）或记一笔"已下载"（png 走浏览器下载，与菜单导出同一条路）。
   */
  const exportRequests = new Map()
  /** 最近一次导出的结果（`diagram_read` 把它带回给模型）。 */
  const exportResults = new Map()

  /**
   * AI 请求的抽帧计划（按会话）：`{ requestId, absolute, clip, from, seconds, fps, width, max }`。
   *
   * 视频解码在浏览器里（宿主没有解码器），所以真实抽帧也是一条**请求/回执**通道：
   * AI 用 `extractFrames {seconds,fps,width}` 写计划 → 客户端轮询的 `read` 里取走 →
   * 浏览器解码视频写 `stills/NNNN.png` → POST 回 `media-extract-result` → 宿主清掉请求。
   * 模型侧想看进度就再调一次 `extractFrames`（回执里带 stills 数量）。
   */
  const extractRequests = new Map()
  /** 最近一次抽帧回执（`extractFrames` 把它带回给模型）。 */
  const extractResults = new Map()

  /** 路径小工具：导出文件落在 `.drawio` 旁边，所以只需要在同级拼名字。 */
  function dirOf(absolute) {
    const text = String(absolute)
    const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
    return at > 0 ? text.slice(0, at) : ''
  }
  function baseNameOf(absolute) {
    const text = String(absolute)
    const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
    return (at >= 0 ? text.slice(at + 1) : text).replace(/\.(?:drawio|drawai)$/i, '')
  }

  /**
   * 这张画布上的导出状态：还挂着请求 = pending；已经回过结果就报结果；什么都没发生过 = undefined。
   *
   * 路径必须对得上 —— 导出是"这张画布"的事，换了标签之后不该把上一张的结果报成这一张的。
   */
  function exportStateFor(sessionId, absolute) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const pending = exportRequests.get(sessionId)
    if (pending !== undefined && pending.absolute === absolute) {
      return { status: 'pending', format: pending.format }
    }
    const done = exportResults.get(sessionId)
    if (done === undefined || done.absolute !== absolute) return undefined
    if (done.status === 'done') return { status: 'done', format: done.format, path: done.path }
    if (done.status === 'downloaded') return { status: 'downloaded', format: done.format }
    return { status: 'failed', format: done.format, error: String(done.error) }
  }

  /**
   * 这张画布上的抽帧状态：挂着计划 = pending；画布回过执 = done / failed；什么都没发生过 = undefined。
   * 与导出同一条护栏：路径不对就是别人的事，不报。
   */
  function extractStateFor(sessionId, absolute) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const pending = extractRequests.get(sessionId)
    if (pending !== undefined && pending.absolute === absolute) {
      return {
        status: 'pending',
        clip: pending.clip,
        seconds: pending.seconds,
        fps: pending.fps,
        width: pending.width,
        max: pending.max,
      }
    }
    const done = extractResults.get(sessionId)
    if (done === undefined || done.absolute !== absolute) return undefined
    if (done.error?.length > 0) return { status: 'failed', clip: done.clip, written: done.written, error: done.error }
    return { status: 'done', clip: done.clip, written: done.written }
  }

  /**
   * 把"这次被删掉的单元"从选区记录里划掉。
   *
   * 光靠读时的存在性过滤不够：id 是**会被复用的**（删掉 n3 再建一个，下一个还是 n3），
   * 于是"用户之前选中的 n3"会凭空变成刚新建的那个节点 —— 删除时就划掉才干净。
   */
  function forgetSelection(sessionId, absolute, ids) {
    const entry = canvasSelection.get(sessionId)
    if (entry === undefined || entry.absolute !== absolute) return
    entry.ids = entry.ids.filter((id) => ids.indexOf(id) < 0)
    if (entry.ids.length === 0) canvasSelection.delete(sessionId)
  }

  function snapshotKey(sessionId, absolute) {
    return String(sessionId) + '\n' + String(absolute)
  }

  /**
   * 把选区记录过滤成"这张文档里真的还存在"的 id 列表。
   *
   * 路径对不上就返回空数组（切了标签、或 AI 读的是另一张图）。
   * 过滤而不是原样回：`remove` 之后残留的 id 会让模型以为东西还在。
   */
  function selectionForCanvas(sessionId, absolute, doc) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    const entry = canvasSelection.get(sessionId)
    if (entry === undefined || entry.absolute !== absolute) return []
    const alive = {}
    for (let i = 0; i < doc.nodes.length; i += 1) alive[String(doc.nodes[i].id)] = true
    for (let i = 0; i < doc.edges.length; i += 1) alive[String(doc.edges[i].id)] = true
    const out = []
    for (let i = 0; i < entry.ids.length; i += 1) if (alive[entry.ids[i]] === true) out.push(entry.ids[i])
    return out
  }

  function focusedPathFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return focusedCanvas.get(sessionId)
  }

  /** 两个绝对路径是不是同一个文件（Windows 大小写不敏感、斜杠两种都认）。 */
  function samePath(a, b) {
    if (a === b) return true
    if (typeof a !== 'string' || typeof b !== 'string') return false
    if (process.platform !== 'win32') return false
    return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
  }

  /**
   * 用户此刻打开的那张画布的**绝对路径**（归一后）；没上报过 / 解析不出来 → undefined。
   *
   * 只给「看图」的门禁用（diagram_read 的 render:true 分支）：渲染发生在浏览器里，只有**用户正打开着**
   * 这张画布时客户端才接请求，否则请求永远挂着（issue #12）。聚焦路径是客户端上报的、
   * 可能是相对工作区的，所以这里统一 resolve + processPath 成与 `loaded.absolute` 同一套形状。
   */
  async function focusedAbsoluteOf(sessionId) {
    const raw = focusedPathFor(sessionId)
    if (raw === undefined || raw.length === 0) return undefined
    const root = workspaceRootOf(sessionId)
    if (root === undefined) return undefined
    try {
      return ctx.fs.processPath(await ctx.fs.resolve(raw, { cwd: root }))
    } catch (error) {
      return undefined
    }
  }

  /** 用户画布当前页（0 起）；没上报过则 0。 */
  function focusedPageFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
    const n = focusedPage.get(sessionId)
    return Number.isFinite(Number(n)) ? Number(n) : 0
  }

  /**
   * 用户切换画布时，把"当前打开的是哪一张"**注入**到那个会话（Agent 的 model-facing context）。
   *
   * 为什么值得主动说一句：工具不传 path 时本来就落到"用户当前打开的那张"，
   * 但模型在此之前**只能靠先调一次 diagram_read、看返回里的 path** 才知道是哪张 ——
   * 用户问"我现在看的是哪张图""在这张图上加个节点"时，它得先探一次才敢动。
   * 注入之后，模型在下一步就能直接看到，不用探。
   *
   * `agents` 是**可选**服务（走 ctx.get）：没有它的部署、或注入形状对不上老版本时，
   * 都只是少了这条提示 —— 工具仍然要求显式 path 或当前会话聚焦画布。
   */
  function notifyFocusedCanvas(sessionId, path) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return
    let agent
    try {
      agent = agents.get(sessionId)
    } catch (error) {
      return
    }
    if (agent === undefined || agent === null || typeof agent.inject !== 'function') return
    // 只记"注入过哪一张"，同一张反复报（客户端每次挂载都会报一次）就不再打扰模型。
    if (injectedCanvas.get(sessionId) === path) return
    injectedCanvas.set(sessionId, path)
    const text =
      path.length > 0
        ? 'DrawAI 画布：用户现在打开的是 ' + path + '。diagram_read 不传 path 可读取当前焦点；diagram_apply 写入时必须显式传 path。'
        : 'DrawAI 画布：用户关掉了画布（此刻没有打开任何一张）。请先打开画布或明确指定 path。'
    try {
      // Session V4 要求 producer-owned source kind：字面量 `'plugin'` 会被拒
      // （format v4 message requires a producer-owned source kind）。
      // 目标形是 `{ kind: 'plugin:<名>' }`（V3→V4 迁移对旧 wrapper 也写成这样），
      // 对 user/message 注入在 V3/V4 都可过；不带 form —— 它只是"环境事实"。
      // 消息 id 会落到 user/message 的 data.id；缺失会导致持久化后的会话读取校验失败。
      agent.inject({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin:' + name } })
    } catch (error) {
      // 注入失败不该影响画布本身：工具那条回退链还在。
    }
  }

  /**
   * 人工编辑的写回端点。
   *
   * 为什么必须自带：客户端能用的 Remote 面**只有读方法**（workspaceFiles 的
   * read/readBytes/readAll/readRelated/stat/list/changes），整个 DSH 没有通用的
   * "写文件" Remote。人拖完节点要落盘，只能自己开一条通道 —— dsh-better-sidebar
   * 的编辑器 tab 保存文件走的也是这个办法（/sidebar/api）。
   *
   * 信任围栏（方案 §6.4 明确警告：开任意路径路由会绕过围栏，所以这里逐条校验）：
   *   1. 只接受 POST，且必须带自定义头 —— 跨站表单设不了它，跨域 fetch 会触发预检被浏览器拦掉
   *   2. 带 Origin 时必须同源
   *   3. 只写会话工作区根内的 .drawio（用 fs.contains 做真实路径包含判断，不是字符串前缀）
   *   4. revision 乐观锁：对不上就 409，绝不覆盖别人的改动
   *
   * 顺带把 meta.pinned 打成 true —— 从此这个文档被人手工摆过，
   * diagram_apply 不该再默认自动重排把它冲掉。
   */
  // 临时复刻包只由持有本次令牌的会话管理，取消不触及已有媒体。
  const videoTraceJobs = new Map()
  const videoUploadJobs = new Map()
  const videoReadTickets = new Map()
  const videoExports = createVideoExportManager({ slots: mediaSlots })
  const motionFocus = new Map()
  const audioService = createAudioService()
  const motionTasks = createMotionTaskManager({ slots: mediaSlots,
    inspectFilm:async(job,composition,previous,final=false)=>{
      const agent=ctx.get?.('agents')?.get?.(job.scope.sessionId),session=sessionOf(job.scope.sessionId)
      const config=agent?.session?.requestHeader?.()?.config||session?.requestHeader?.()?.config||agent?.options
      const llm=ctx.get?.('llm'),attachments=ctx.get?.('attachments')
      let info
      try{info=config&&llm?.resolveModelInfo?await llm.resolveModelInfo(config.provider,config.model,job.control.signal):null}
      catch(error){if(job.control.signal.aborted)throw error}
      const reviewSequence=info?.inputModalities?.includes('image')&&attachments?.saveImage?motionSequenceReviewer({llm,config,attachments,sessionId:job.scope.sessionId,signal:job.control.signal}):undefined
      return inspectMotionFilm({packDir:job.packDir,composition,signal:job.control.signal,reviewSequence,previousMotion:previous?.motion,expectedAudio:final&&!!composition.audio?.cues?.length})
    },
    notify: async (job, event) => {
      const content = [{ type: 'text', text: motionSessionNotice(job, event) }]
      const agent = ctx.get?.('agents')?.get?.(job.scope.sessionId)
      if (agent?.followup) { agent.followup({ id: randomUUID(), role: 'user', content, source: { kind: 'plugin:' + name } }); return }
      const controller = ctx.get?.('sessionController')
      if (!controller?.prompt) throw new Error('主会话服务不可用')
      await controller.prompt({ requestId: randomUUID(), sessionId: job.scope.sessionId, mode: 'queue', content }, new AbortController().signal)
    },
    commit: (job, output) => documents.run(job.scope.drawioAbs, async () => {
      const loaded = await loadTaskDocument(job)
      const current = loaded.doc.nodes.find((node) => node.id === job.nodeId)
      if (!current) throw new Error('目标已删除，成片保留在任务历史')
      const before = { data: JSON.parse(JSON.stringify(current.data)), style: current.style }
      applyMotionResult(loaded.doc, job, { ...output, style: stylePatch(current.style || '', {
        image: output.poster, imageAspect: '1', shape: 'image',
      }) })
      await writeMotionDocument(loaded, job.scope.sessionId, current.id, before)
    }),
  })
  async function remixMotion(scope,taskId,settings,prompt) {
    return documents.run(scope.drawioAbs,async()=>{
      const original=motionTasks.details(scope,taskId),loaded=await loadTaskDocument({scope:original.scope})
      const source=motionTasks.result(scope,taskId).job
      if(!['done','retained'].includes(source.status))throw new Error('请先完成视频制作，再修改声音')
      const node=assertMotionEditable(loaded.doc,source.nodeId)
      const before={data:JSON.parse(JSON.stringify(node.data)),style:node.style}
      if(settings)node.data.motion=mergeMotionSettings(node.data.motion,settings)
      if(prompt!==undefined)node.data.motion.audioPrompt=String(prompt).slice(0,5000)
      const input=motionInput(loaded.doc,node.id),nextScope={...original.scope,page:loaded.pageIndex}
      const job=await motionTasks.start(nextScope,node.id,input,{},undefined,async next=>{
        node.data.motion.requestId=next.id;node.data.motion.session={sessionId:scope.sessionId,requestId:next.session.requestId,taskId:next.id}
        await writeMotionDocument(loaded,scope.sessionId,node.id,before)
      },source.composition,{reuseJobId:taskId,audioOnly:true,requestId:randomUUID(),defer:true,silent:true})
      return motionTasks.accepted(nextScope,job.id)
    })
  }

  async function writeMotionDocument(loaded, sessionId, id, before) {
    const policy = policyFor(sessionId)
    if (policy?.mode === 'read-only') throw new Error('当前会话为只读')
    const rendered = renderDocText(loaded.text, loaded.doc, { page: loaded.pageIndex, format: 'drawai' })
    if (contentHash(await ctx.fs.readText(loaded.target)) !== contentHash(loaded.text)) throw new Error('画布已被其他编辑器修改，请重试')
    await ctx.fs.writeText(loaded.target, rendered.text, undefined, undefined, policy)
    const node = loaded.doc.nodes.find((item) => item.id === id)
    taskPatches.record(loaded.absolute, contentHash(loaded.text), rendered.revision, loaded.pageIndex, [], [], [],
      [{ id, before, after: { data: node.data, style: node.style } }])
  }
  async function resumeMotionTask(scope, id) {
    if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
    return documents.run(scope.drawioAbs, () => motionTasks.resume(scope, id, async (job) => {
      const loaded = await loadTaskDocument(job)
      const node = assertMotionEditable(loaded.doc, job.nodeId)
      if (!isMotionNode(node)) throw new Error('请选择动效视频节点')
      if (motionInputKey(motionInput(loaded.doc, node.id)) !== job.inputKey) throw new Error('描述、参数或参考素材已变化，请恢复原设置后继续，或开始新任务')
      const before = { data: JSON.parse(JSON.stringify(node.data)), style: node.style }
      node.data.motion.requestId = job.id
      if (job.session) node.data.motion.session = { sessionId: scope.sessionId, requestId: job.session.requestId, taskId: job.id }
      await writeMotionDocument(loaded, scope.sessionId, node.id, before)
    }))
  }
  const videoTracePool = createVideoTracePool()
  const drawingTasks = createDrawingTaskManager({ pool: videoTracePool, slots: mediaSlots,
    commit: commitDrawingTask, undo: undoDrawingTask,
    publishExtraction: (job, action) => documents.run(job.scope.drawioAbs, async () => {
      const loaded = await loadTaskDocument(job)
      const source = loaded.doc.nodes.find((node) => node.id === job.source.id)
      if (videoMetaFromData(source?.data)?.clip !== job.source.clip) throw new Error('抽帧来源已更改，结果已保留在任务目录')
      await checkVideoInput(job)
      return action()
    }),
    extracted: (job, output) => {
      extractRequests.delete(job.scope.sessionId)
      extractResults.set(job.scope.sessionId, { absolute: job.scope.drawioAbs, clip: job.source.clip, written: output.written, taskId: job.id })
    },
    failed: (job) => {
      if (job.kind === 'extract') {
        extractRequests.delete(job.scope.sessionId)
        extractResults.set(job.scope.sessionId, { absolute: job.scope.drawioAbs, clip: job.source.clip, written: job.done, error: job.error || '抽帧已取消' })
      }
    },
  })
  const signature = (value) => createHash('sha256').update(value).digest('hex')
  const stableValue = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
  async function loadTaskDocument(job) {
    let loaded = await loadDoc(job.scope.drawioAbs, job.scope.sessionId, job.scope.page)
    if (!loaded.exists) throw new Error('原画布已删除，结果已保留')
    if (job.scope.pageId) {
      const page = loaded.pageIds.indexOf(job.scope.pageId)
      if (page < 0 || loaded.pageIds.filter((id) => id === job.scope.pageId).length !== 1) throw new Error('原页面已删除或身份冲突，结果已保留')
      if (page !== loaded.pageIndex) loaded = await loadDoc(job.scope.drawioAbs, job.scope.sessionId, page)
    } else if (JSON.stringify(loaded.pageNames) !== JSON.stringify(job.scope.pageNames)) throw new Error('页面身份已改变，结果已保留')
    return loaded
  }
  async function writeTaskDocument(job, loaded, node, removed = []) {
    const policy = policyFor(job.scope.sessionId)
    if (policy?.mode === 'read-only') throw new Error('当前会话为只读，绘制结果已保留')
    const rendered = renderDocText(loaded.text, loaded.doc, { page: loaded.pageIndex, format: isNativeCanvasPath(loaded.absolute) ? 'drawai' : 'drawio' })
    // The coordinator serializes plugin writers; a fresh check also detects
    // external edits which happened while an asynchronous source check ran.
    if (contentHash(await ctx.fs.readText(loaded.target)) !== contentHash(loaded.text)) throw new Error('文件已被其他编辑器修改，请重试加入结果')
    const savedNode = node ? normalizeDoc(parseMxfile(rendered.text, { page: loaded.pageIndex }).doc).nodes.find((item) => item.id === node.id) : null
    if (savedNode) drawingTasks.recordCommit(job, savedNode)
    await ctx.fs.writeText(loaded.target, rendered.text, undefined, undefined, policy)
    taskPatches.record(loaded.absolute, contentHash(loaded.text), rendered.revision, loaded.pageIndex, savedNode ? [savedNode] : [], removed, removed.length && job.createdNode ? [job.createdNode] : [])
    return { nodeId: savedNode?.id, node: savedNode, page: loaded.pageIndex }
  }
  async function commitDrawingTask(job, output) {
    return documents.run(job.scope.drawioAbs, async () => {
      const loaded = await loadTaskDocument(job)
      const existing = loaded.doc.nodes.find((node) => node.data?.drawaiTaskId === job.id)
      if (existing) return { nodeId: existing.id, node: job.createdNode, page: loaded.pageIndex }
      const source = loaded.doc.nodes.find((node) => node.id === job.source.id)
      if (!source) throw new Error('来源节点已删除，结果已保留')
      const image = job.kind === 'image' ? imageValueFromStyle(source.style || '') : ''
      if (job.kind === 'image' && signature(image) !== job.source.signature) throw new Error('原图已更改，结果已保留')
      if (job.kind === 'video') {
        await checkVideoInput(job)
      }
      const node = applyDrawingResult(loaded.doc, { ...job, source: { ...job.source, image } }, output)
      loaded.doc.meta = { ...loaded.doc.meta, pinned: true }
      return writeTaskDocument(job, loaded, node)
    })
  }
  async function checkVideoInput(job) {
    const dir = clipDirFor(job.scope.drawioAbs, job.source.clip), original = findSourceFile(dir, readManifest(dir))
    if (!original) throw new Error('原视频已删除，结果已保留')
    const rel = relativePath(realpathSync(dir), realpathSync(original.abs))
    if (isAbsolute(rel) || rel.startsWith('..') || signature(await readFile(original.abs)) !== job.inputHash) throw new Error('原视频内容或路径已更改，结果已保留')
  }
  async function undoDrawingTask(job) {
    return documents.run(job.scope.drawioAbs, async () => {
      const loaded = await loadTaskDocument(job)
      const node = loaded.doc.nodes.find((item) => item.data?.drawaiTaskId === job.id)
      if (!node) return
      if (stableValue(node) !== stableValue(job.createdNode)) throw new Error('生成节点已被修改，请在画布中撤销或删除，避免丢失后续编辑')
      if (loaded.doc.edges.some((edge) => edge.from === node.id || edge.to === node.id)) throw new Error('生成节点已连接新连线，请在画布中处理')
      loaded.doc.nodes = loaded.doc.nodes.filter((item) => item.id !== node.id)
      loaded.doc.drawOrder = (loaded.doc.drawOrder || []).filter((id) => id !== node.id)
      await writeTaskDocument(job, loaded, null, [node.id])
    })
  }
  async function enqueueDrawing(scope, body) {
    return documents.run(scope.drawioAbs, async () => {
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读，无法创建绘制任务')
      if (!Number.isInteger(body.page ?? 0) || (body.page ?? 0) < 0) throw new Error('页面位置无效')
      const loaded = await loadDoc(scope.drawioAbs, scope.sessionId, body.page || 0)
      if (loaded.pageIndex !== (body.page || 0)) throw new Error('页面已不存在')
      if (!loaded.exists) throw new Error('请先创建画布')
      if (body.revision && body.revision !== loaded.doc.revision) throw new Error('画布版本已更新，请等待同步后重试')
      const kind = body.kind
      if (!['image', 'video', 'extract'].includes(kind)) throw new Error('未知绘制类型')
      const source = loaded.doc.nodes.find((node) => node.id === body.sourceId)
      if (!source) throw new Error('来源节点不存在')
      const options = { level: 'medium', preset: 'default', colors: 12, removeBg: false, ...(body.options || {}) }
      if (!['low', 'medium', 'high'].includes(options.level) || !TRACE_PRESET_NAMES.includes(options.preset) ||
          !Number.isInteger(Number(options.colors)) || options.colors < 2 || options.colors > 24 || typeof options.removeBg !== 'boolean') throw new Error('绘制参数无效')
      const taskScope = { ...scope, page: loaded.pageIndex, pageId: loaded.pageId, pageNames: loaded.pageNames,
        pageName: loaded.pageNames[loaded.pageIndex] }
      let input, taskSource
      if (kind === 'image') {
        const image = imageValueFromStyle(source.style || '')
        if (!isRasterDataUri(image)) throw new Error('请选择位图来源')
        input = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64')
        taskSource = { id: source.id, signature: signature(image) }
      } else {
        const meta = videoMetaFromData(source.data)
        if (meta?.kind !== 'raster') throw new Error('请选择原视频来源')
        const dir = clipDirFor(scope.drawioAbs, meta.clip), original = findSourceFile(dir, readManifest(dir))
        if (!original) throw new Error('原视频文件缺失')
        const mediaRel = relativePath(realpathSync(scope.workspaceRoot), realpathSync(dir))
        if (isAbsolute(mediaRel) || mediaRel.startsWith('..')) throw new Error('视频媒体目录超出工作区')
        const file = realpathSync(original.abs), rel = relativePath(realpathSync(dir), file)
        if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('原视频路径超出媒体包')
        input = file
        taskSource = { id: source.id, clip: meta.clip, extension: /\.[a-z0-9]+$/i.exec(file)?.[0] || '.mp4', signature: meta.clip + ':' + signature(await readFile(file)) }
      }
      return drawingTasks.enqueue(taskScope, { kind, options, source: taskSource, label: source.label || (kind === 'image' ? '图片' : '视频') + ' · ' + source.id }, input)
    })
  }
  async function startHostExtraction(sessionId, loaded, plan) {
    const current = await loadDoc(loaded.absolute, sessionId, loaded.pageIndex)
    const source = current.doc.nodes.find((node) => videoMetaFromData(node.data)?.clip === plan.clip)
    if (!source) throw new Error('抽帧来源节点已不存在')
    const job = await enqueueDrawing({ sessionId, path: loaded.absolute, drawioAbs: loaded.absolute, workspaceRoot: workspaceRootOf(sessionId) },
      { kind: 'extract', sourceId: source.id, page: current.pageIndex, options: { ...plan, range: 'segment' } })
    const pending = extractRequests.get(sessionId)
    if (pending) pending.taskId = job.id
  }
  const wakeVideoTrace = (job) => {
    const waiters = job.waiters || []
    job.waiters = []
    for (const wake of waiters) wake()
  }
  const waitVideoTraceTurn = (job, index) => new Promise((resolve, reject) => {
    const check = () => {
      if (job.cancelled || job.failure || videoTraceJobs.get(job.token) !== job) {
        reject(new Error(job.failure || '复刻任务已取消'))
        return true
      }
      try {
        if (readManifest(job.dir).frames.length === index) {
          resolve()
          return true
        }
      } catch (error) {
        reject(error)
        return true
      }
      return false
    }
    if (check()) return
    const wake = () => { if (check()) return; job.waiters.push(wake) }
    job.waiters.push(wake)
  })
  ctx.effect(() => () => {
    for (const job of videoTraceJobs.values()) {
      job.perf.finish('interrupted')
      job.cancelled = true
      wakeVideoTrace(job)
    }
    videoTraceJobs.clear(); videoUploadJobs.clear(); videoReadTickets.clear()
    return Promise.all([drawingTasks.close(), videoExports.dispose(), motionTasks.close()]).finally(() => videoTracePool.close())
  })
  async function handleSave(req, res) {
    if (req.method === 'GET') {
      const origin = req.headers.origin
      if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && (() => { try { return new URL(origin).host !== req.headers.host } catch { return true } })())) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return
      }
      let token
      try { token = new URL(req.url, 'http://localhost').searchParams.get('video') } catch { token = null }
      const ticket = videoReadTickets.get(token)
      if (!ticket || Date.now() - ticket.time > 3600000 || !sessionOf(ticket.sessionId)) {
        if (token) videoReadTickets.delete(token)
        sendJson(res, 403, { ok: false, error: 'video access expired' }); return
      }
      try {
        workspacePath({ sessionId: ticket.sessionId }, ticket.source)
        const info = await stat(ticket.source)
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1) throw new Error('video source unavailable')
        const total = info.size, range = req.headers.range
        let start = 0, end = total - 1
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return }
          if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, total - suffix) }
          else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end) }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return
          }
        }
        ticket.time = Date.now()
        const headers = { 'Content-Type': ticket.mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
        res.writeHead(range ? 206 : 200, headers)
        const stream = createReadStream(ticket.source, { start, end })
        stream.on('error', () => res.destroy())
        res.on('close', () => stream.destroy())
        stream.pipe(res)
      } catch (error) { sendJson(res, 404, { ok: false, error: 'video source unavailable' }) }
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (req.headers[SAVE_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing ' + SAVE_HEADER + ' header' })
      return
    }
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === req.headers.host
      } catch (error) {
        sameOrigin = false
      }
      if (!sameOrigin) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
    }

    let text
    try {
      // 解析前不知道 action，先受最大画布预算约束，再按 action 收紧。
      text = await readBody(req, CANVAS_SAVE_MAX_BYTES)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: messageOf(error) })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'request body is not JSON' })
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
      return
    }
    const bodyLimit = body.action === 'render-result' ? RENDER_RESULT_MAX_BYTES
      : body.action === 'trace-node-image' ? IMAGE_TRACE_MAX_BYTES
        : (body.action === undefined || body.action === 'create' || body.action === 'motion-task-start') ? CANVAS_SAVE_MAX_BYTES : SAVE_MAX_BYTES
    if (Buffer.byteLength(text, 'utf8') > bodyLimit) {
      sendJson(res, 413, { ok: false, error: 'request body exceeds ' + bodyLimit + ' bytes' })
      return
    }

    try {
      const lockAction = body.action === undefined || ['create', 'revert', 'media-cleanup', 'media-video-export-start', 'drawing-task-start', 'motion-task-start'].includes(body.action)
      if (lockAction && typeof (body.path || body.name) === 'string' && workspaceRootOf(body.sessionId)) {
        const target = await resolveTarget(body.path || body.name, body.sessionId)
        return await documents.run(absoluteHint(target, body.path || body.name), () => dispatchSave(body, res))
      }
      return await dispatchSave(body, res)
    } catch (error) { sendJson(res, 400, { ok: false, error: messageOf(error) }) }
  }

  async function dispatchSave(body, res) {

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
    const rawPath = typeof body.path === 'string' ? body.path : undefined

    if (typeof body.action === 'string' && body.action.startsWith('motion-task-')) {
      if (!sessionOf(sessionId) || !workspaceRootOf(sessionId) || !isNativeCanvasPath(rawPath)) throw new Error('动效生成需要当前工作区的 .drawai 画布')
      const target = await resolveTarget(rawPath, sessionId), root = workspaceRootOf(sessionId)
      if (!ctx.fs.contains(await ctx.fs.resolve(root), target)) throw new Error('画布路径超出工作区')
      const scope = { sessionId, drawioAbs: absoluteHint(target, rawPath), path: rawPath }
      let result
      if (body.action === 'motion-task-start') {
        if (policyFor(sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        if (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)) throw new Error('视频请求缺少有效的请求 ID')
        const previous = motionTasks.findRequest(scope, body.requestId)
        if (previous) {
          if (previous.nodeId !== body.nodeId) throw new Error('请求 ID 已被另一个视频请求使用')
          sendJson(res, 200, { ok: true, job: previous }); return
        }
        const loaded = await loadDoc(rawPath, sessionId, body.page)
        if (!loaded.exists || loaded.doc.revision !== body.revision) throw new Error('画布已更新，请等待同步后重新生成')
        const node = loaded.doc.nodes.find((item) => item.id === body.nodeId)
        if (!isMotionNode(node)) throw new Error('请选择动效视频节点')
        const input = motionInput(loaded.doc, node.id)
        // Lock checks are also repeated at delivery, after potentially long renders.
        assertMotionEditable(loaded.doc, node.id)
        const before = { data: JSON.parse(JSON.stringify(node.data)), style: node.style }
        Object.assign(scope, { page: loaded.pageIndex, pageId: loaded.pageId, pageNames: loaded.pageNames })
        const job = await motionTasks.start(scope, node.id, input, body.previews || {}, body.composition, async (job) => {
          node.data.motion.requestId = job.id
          node.data.motion.session = { sessionId, requestId: job.session.requestId, taskId: job.id }
          await writeMotionDocument(loaded, sessionId, node.id, before)
        }, node.data.motion.composition, { defer: true, requestId: body.requestId, silent: true, projectFromJobId:node.data.motion.lastJobId })
        result = { job: await motionTasks.accepted(scope, job.id) }
      } else if(body.action==='motion-task-remix') {
        if(policyFor(sessionId)?.mode==='read-only')throw new Error('当前会话为只读')
        result={job:await remixMotion(scope,body.taskId)}
      } else if (body.action === 'motion-task-list') result = { jobs: motionTasks.list(scope), focus: motionFocus.get(sessionId + '\n' + scope.drawioAbs) || null }
      else if (body.action === 'motion-task-result') result = motionTasks.result(scope, body.taskId)
      else if (body.action === 'motion-task-review-film') {
        if(policyFor(sessionId)?.mode==='read-only')throw new Error('当前会话为只读')
        result={job:motionTasks.reviewFilm(scope,body.taskId,body.review||{})}
      }
      else if (body.action === 'motion-task-cancel') result = { job: await motionTasks.cancel(scope, body.taskId) }
      else if (body.action === 'motion-task-resume') result = { job: await resumeMotionTask(scope, body.taskId) }
      else if (body.action === 'motion-task-remove') {
        if (policyFor(sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        result = { job: motionTasks.remove(scope, body.taskId) }
      }
      else if (body.action === 'motion-task-apply') {
        if (policyFor(sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        result = { job: await motionTasks.apply(scope, body.taskId) }
      } else throw new Error('未知动效任务操作')
      sendJson(res, 200, { ok: true, ...result }); return
    }

    if (typeof body.action === 'string' && body.action.startsWith('audio-')) {
      if(!sessionOf(sessionId)||!workspaceRootOf(sessionId)||!isNativeCanvasPath(rawPath))throw new Error('音频操作需要当前工作区画布')
      const target=await resolveTarget(rawPath,sessionId)
      if(!ctx.fs.contains(await ctx.fs.resolve(workspaceRootOf(sessionId)),target))throw new Error('画布路径超出工作区')
      const scope={sessionId,drawioAbs:absoluteHint(target,rawPath),path:rawPath}
      if(body.action!=='audio-read'&&policyFor(sessionId)?.mode==='read-only')throw new Error('当前会话为只读')
      const methods={'audio-search':'search','audio-get':'get','audio-upload-start':'start','audio-upload-chunk':'chunk','audio-upload-finish':'finish','audio-upload-release':'release'}
      let result
      if(body.action==='audio-read')result=audioService.read(scope,body.clip)
      else {const method=methods[body.action];if(!method)throw new Error('未知音频操作');result=await audioService[method](scope,body)}
      sendJson(res,200,{ok:true,...result});return
    }

    if (typeof body.action === 'string' && body.action.startsWith('drawing-task-')) {
      if (!sessionOf(sessionId) || !workspaceRootOf(sessionId) || !isCanvasPath(rawPath)) throw new Error('绘制任务需要当前工作区画布')
      const target = await resolveTarget(rawPath, sessionId), root = workspaceRootOf(sessionId)
      if (!ctx.fs.contains(await ctx.fs.resolve(root), target)) throw new Error('画布路径超出工作区')
      const scope = { sessionId, path: rawPath, drawioAbs: absoluteHint(target, rawPath), workspaceRoot: root }
      let result
      if (body.action === 'drawing-task-start') result = { job: await enqueueDrawing(scope, body) }
      else if (body.action === 'drawing-task-list') result = { jobs: drawingTasks.list(scope) }
      else if (body.action === 'drawing-task-result') result = drawingTasks.result(scope, body.taskId)
      else if (body.action === 'drawing-task-command') result = { job: await drawingTasks.command(scope, body.taskId, body.command, body.value) }
      else throw new Error('未知绘制任务操作')
      sendJson(res, 200, { ok: true, ...result }); return
    }

    // 仅计算图像节点的 SVG；由客户端通过同一历史/保存通道应用结果。
    if (body.action === 'trace-node-image') {
      if (sessionId === undefined || sessionOf(sessionId) === undefined || workspaceRootOf(sessionId) === undefined) {
        sendJson(res, 403, { ok: false, error: '无法确定当前会话工作区' })
        return
      }
      if (typeof body.image !== 'string' || !isRasterDataUri(body.image)) {
        sendJson(res, 400, { ok: false, error: '请选择已导入的 PNG/JPEG/GIF/WebP 图片节点' })
        return
      }
      const imagePerf = createPerformanceLog(workspaceRootOf(sessionId), 'image-trace', { level: body.level, preset: body.preset, colors: body.colors, removeBg: body.removeBg })
      try {
        const decodeDone = imagePerf.start('sourceReadAndDecode')
        const bytes = Buffer.from(body.image.slice(body.image.indexOf(',') + 1), 'base64')
        if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16000000) throw new Error('图片超过 1600 万像素，请先缩小图片')
        }
        decodeDone()
        const traceDone = imagePerf.start('workerRequest')
        const traced = await videoTracePool.run(bytes, {
          mode: 'image', profile: imagePerf.enabled,
          level: body.level, preset: body.preset, colors: body.colors, removeBg: body.removeBg,
          includeDrawing: true,
        })
        traceDone()
        imagePerf.add('workerQueueWait', traced.queueWaitMs)
        imagePerf.merge('worker.', traced.performance)
        imagePerf.count('sourceBytes', bytes.length); imagePerf.count('svgBytes', Buffer.byteLength(traced.svg))
        imagePerf.finish('done', traced.rasterSize)
        sendJson(res, 200, { ok: true, svg: traced.svg, drawing: traced.drawing, metrics: {
          fragments: traced.metrics.fragments, colors: traced.metrics.colors,
          svgChars: traced.metrics.svgChars, budget: traced.metrics.budget,
          level: traced.metrics.fragmentLevel, attempts: traced.metrics.attempts,
          detailReduced: traced.metrics.detailReduced,
          targetFragments: traced.metrics.targetFragments,
          fragmentThresholds: traced.metrics.fragmentThresholds,
          targetReached: traced.metrics.targetReached,
          imageAnalysis: traced.metrics.imageAnalysis,
          resolutionRetries: traced.metrics.resolutionRetries, work: traced.metrics.work,
        } })
      } catch (error) {
        imagePerf.finish('failed')
        sendJson(res, 400, { ok: false, error: messageOf(error) })
      }
      return
    }

    // 文生图暂时关闭：旧客户端也不能发起生成、探测或工作流请求。
    if (['imagegen-generate', 'imagegen-status', 'imagegen-default-workflow'].includes(body.action)) {
      sendJson(res, 503, { ok: false, error: '文生图功能暂未开放' })
      return
    }

    // action: 'list' —— 列出工作区里可打开的 .drawio，供「打开」菜单用。
    // 复用同一条路由而不是另开一个：信任围栏（POST + 自定义头 + 同源）只写一次，
    // 少一个口子就少一处可能忘记校验的地方。
    if (body.action === 'list') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const root = workspaceRootOf(sessionId)
      if (root === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      // dir：只列出**这一个目录**（不递归下钻）。给"用文件管理器挑了一个目录"用 ——
      // 用户从系统选择器选中的目录可能在别处，所以这里必须做工作区包含校验，
      // 否则它就成了"列任意目录"的口子（信任围栏的意义就在这）。
      const dir = typeof body.dir === 'string' && body.dir.length > 0 ? body.dir : null
      if (dir !== null) {
        let dirTarget
        try {
          dirTarget = await ctx.fs.resolve(dir)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
          return
        }
        // rootTarget 两个 try 都要用（包含校验 + 响应里的 root 字段），声明放到 if 块这一层。
        let rootTarget
        try {
          rootTarget = await ctx.fs.resolve(root)
          if (!ctx.fs.contains(rootTarget, dirTarget)) {
            sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(dirTarget, dir) })
            return
          }
        } catch (error) {
          sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
          return
        }
        try {
          const listed = await listCanvases(root, root, dir)
          // 同时给出**绝对路径**：客户端按路径去重（同一个文件不该开出两个标签），
          // 而标签上的路径可能来自 tab 的资源地址（绝对），与列表里的相对路径不相等。
          // 让客户端用绝对路径当"身份"，就不会重复开标签。
          // listed.files 里的相对路径是**相对 dir** 的，必须拼回 dir —— 拼到工作区根会指到
          // 一个不存在的同名文件（issue #19：子目录里的画布「列得出、打不开」）。
          const dirAbs = absoluteHint(dirTarget, dir)
          const abs = []
          for (let i = 0; i < listed.files.length; i += 1) abs.push(toAbsolute(listed.files[i], dirAbs))
          sendJson(res, 200, {
            ok: true,
            files: listed.files,
            absolute: abs,
            notes: listed.notes,
            root: absoluteHint(rootTarget, root),
            dir: dirAbs,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: 'list failed: ' + messageOf(error) })
        }
        return
      }
      try {
        const listed = await listCanvases(root, root, root)
        const abs = []
        for (let i = 0; i < listed.files.length; i += 1) abs.push(toAbsolute(listed.files[i], root))
        sendJson(res, 200, {
          ok: true,
          files: listed.files,
          absolute: abs,
          notes: listed.notes,
          root: absoluteHint(await ctx.fs.resolve(root), root),
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'list failed: ' + messageOf(error) })
      }
      return
    }

    // action: 'read' —— 把 .drawio 读成语义文档交给界面。
    //
    // **为什么读也走宿主**：drawio 默认把页体压成 base64(raw deflate(xml))，而浏览器没有 zlib
    // （DecompressionStream 是异步的，塞不进同步渲染路径）。与其把解析器抄一份到客户端，
    // 不如让唯一的解析器待在它本来就在的地方：宿主。客户端只认文档，不认 mxfile。
    if (body.action === 'read') {
      if (sessionId === undefined || rawPath === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
        return
      }
      const readRoot = workspaceRootOf(sessionId)
      if (readRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      let readTarget
      try {
        readTarget = await ctx.fs.resolve(rawPath, { cwd: readRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(readRoot)
        if (!ctx.fs.contains(rootTarget, readTarget)) {
          sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absoluteHint(readTarget, rawPath) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      try {
        const info = await ctx.fs.stat(readTarget)
        if (info === undefined) {
          sendJson(res, 200, { ok: true, exists: false, path: rawPath, absolute: absoluteHint(readTarget, rawPath), revision: '', doc: emptyDoc(), notes: [] })
          return
        }
        let openPath = rawPath
        let migratedTo
        if (body.autoMigrate === true && policyFor(sessionId)?.mode !== 'read-only' && /\.drawio$/i.test(rawPath)) {
          const sourceAbsolute = absoluteHint(readTarget, rawPath)
          const destination = await resolveTarget(nativeCanvasPath(rawPath), sessionId)
          const rootTarget = await ctx.fs.resolve(readRoot)
          if (!ctx.fs.contains(rootTarget, destination)) throw new Error('迁移目标超出工作区')
          const destinationAbsolute = absoluteHint(destination, nativeCanvasPath(rawPath))
          const scope = { sessionId, workspaceRoot: readRoot, path: rawPath, drawioAbs: sourceAbsolute }
          await documents.run(sourceAbsolute, () => documents.run(destinationAbsolute, async () => {
            if (existsSync(sourceAbsolute)) {
              if (!drawingTasks.canMigrateCanvas(scope, sourceAbsolute) || !videoExports.canMigrateCanvas(scope)) {
                return
              }
            }
            await migrateCanvasFile({ fs: ctx.fs, source: readTarget, destination,
              sourcePath: sourceAbsolute, destinationPath: destinationAbsolute, policy: policyFor(sessionId) })
            if (existsSync(sourceAbsolute)) {
              drawingTasks.migrateCanvas(scope, sourceAbsolute, destinationAbsolute)
              videoExports.migrateCanvas(scope, destinationAbsolute)
            }
            openPath = nativeCanvasPath(rawPath)
            migratedTo = destinationAbsolute
          }))
        }
        const loaded = await loadDoc(openPath, sessionId, body.page)
        if (body.autoMigrate && /\.drawio$/i.test(openPath)) loaded.notes.push('本次因只读模式或后台任务继续使用旧格式；任务结束后重新打开可迁移')
        // 两件"顺路带给客户端"的东西：
        //   highlight —— AI 用 `{op:'highlight', ids}` 请求的高亮，**取走即清**（一次性）；
        //   canRevert —— 这张画布上有没有可退回的 AI 改动（菜单项据此启用）。
        const pendingHighlight = highlightFor.get(sessionId)
        if (pendingHighlight !== undefined) highlightFor.delete(sessionId)
        // 导出请求顺路带给客户端：它渲染完再 POST 回 export-result（渲染器在浏览器那一半）。
        const pendingExport = exportRequests.get(sessionId)
        const exportForThis =
          pendingExport !== undefined && pendingExport.absolute === loaded.absolute
            ? { requestId: pendingExport.requestId, format: pendingExport.format, name: pendingExport.name }
            : null
        // 「看一眼」的渲染请求同理：客户端渲成 PNG 回执给 render-result，宿主存成**附件**
        // （工作区零文件），下一次 diagram_read 把 image 块交给模型。
        const pendingRender = renderRequests.get(sessionId)
        const renderForThis =
          pendingRender !== undefined && pendingRender.absolute === loaded.absolute ? { requestId: pendingRender.requestId } : null
        // AI 下发的抽帧计划同理：画布取走后用浏览器解码视频、写 stills/，完成后 POST 回 media-extract-result。
        const pendingExtract = extractRequests.get(sessionId)
        const extractForThis =
          pendingExtract !== undefined && !pendingExtract.host && pendingExtract.absolute === loaded.absolute
            ? {
                requestId: pendingExtract.requestId,
                clip: pendingExtract.clip,
                from: pendingExtract.from,
                seconds: pendingExtract.seconds,
                fps: pendingExtract.fps,
                width: pendingExtract.width,
                max: pendingExtract.max,
              }
            : null
        sendJson(res, 200, {
          ok: true,
          exists: true,
          path: rawPath,
          absolute: loaded.absolute,
          ...(migratedTo ? { migratedTo } : {}),
          revision: loaded.doc.revision,
          doc: loaded.doc,
          notes: loaded.notes,
          pageCount: loaded.pageCount,
          pageIndex: loaded.pageIndex,
          pageNames: loaded.pageNames,
          backgroundPatch: typeof body.revision === 'string' && body.revision !== loaded.doc.revision
            ? taskPatches.between(loaded.absolute, body.revision, loaded.doc.revision, loaded.pageIndex) : null,
          highlight: Array.isArray(pendingHighlight) ? pendingHighlight : [],
          canRevert: revertDepth(snapshotKey(sessionId, loaded.absolute)) > 0,
          // 用户当前的选区（客户端可选地用来做提示；AI 侧由工具读回）。
          selection: selectionForCanvas(sessionId, loaded.absolute, loaded.doc),
          export: exportForThis,
          render: renderForThis,
          media: extractForThis,
        })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: '这个文件读不出画布：' + messageOf(error) })
      }
      return
    }

    // action: 'render-result' —— 客户端把画布渲成 PNG 回执给宿主（AI 的 `diagram_read {render:true}` 走这条）。
    //
    // **这条路的产物不进工作区**：图片交给附件服务存（内容寻址，在工作区之外，与用户上传图片同一套），
    // 下一次 read 用一个 `{type:'image', attachment}` 内容块把它交给模型。
    // 与 export-result 同一条护栏：只有"这个会话此刻真的挂着一个请求"才收。
    if (body.action === 'render-result') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const pending = renderRequests.get(sessionId)
      if (pending === undefined) {
        sendJson(res, 409, { ok: false, error: 'no pending render request' })
        return
      }
      if (typeof body.requestId === 'string' && body.requestId !== pending.requestId) {
        sendJson(res, 409, { ok: false, error: 'stale render request' })
        return
      }
      const noteFailure = (message) => {
        renderRequests.delete(sessionId)
        renderedImages.set(sessionId, {
          absolute: pending.absolute,
          revision: pending.revision,
          status: 'failed',
          error: message,
          at: Date.now(),
        })
      }
      // 失败回执也要收下：否则请求一直挂着，模型永远看到 pending。
      if (body.ok === false) {
        noteFailure(typeof body.error === 'string' && body.error.length > 0 ? body.error : '画布没能渲染出这张图')
        sendJson(res, 200, { ok: true })
        return
      }
      const attachments = attachmentsService()
      if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
        noteFailure('这个部署没有可用的附件服务（attachments），图片存不下来')
        sendJson(res, 409, { ok: false, error: 'no attachment service' })
        return
      }
      const base64 = typeof body.png === 'string' ? body.png : ''
      const bytes = base64.trim().length === 0 ? Buffer.alloc(0) : Buffer.from(base64, 'base64')
      if (bytes.length === 0) {
        sendJson(res, 400, { ok: false, error: 'png is empty' })
        return
      }
      const limits = attachments.imageLimits === undefined || attachments.imageLimits === null ? {} : attachments.imageLimits
      if (Number.isFinite(Number(limits.maxImageBytes)) && bytes.length > Number(limits.maxImageBytes)) {
        noteFailure('这张图 ' + bytes.length + ' 字节，超过这个部署的图片上限 ' + Number(limits.maxImageBytes) + ' 字节')
        sendJson(res, 413, { ok: false, error: 'image too large: ' + bytes.length + ' > ' + Number(limits.maxImageBytes) })
        return
      }
      if (Array.isArray(limits.mediaTypes) && limits.mediaTypes.indexOf('image/png') < 0) {
        noteFailure('这个部署不接受 image/png')
        sendJson(res, 415, { ok: false, error: 'image/png is not accepted by this deployment' })
        return
      }
      const fallbackName = baseNameOf(pending.absolute) + '.png'
      let ref = null
      try {
        ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name: fallbackName })
      } catch (error) {
        noteFailure(messageOf(error))
        sendJson(res, 500, { ok: false, error: 'save failed: ' + messageOf(error) })
        return
      }
      if (ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') {
        noteFailure('附件服务没有返回可用的图片引用')
        sendJson(res, 500, { ok: false, error: 'attachment service returned no usable reference' })
        return
      }
      renderRequests.delete(sessionId)
      const width = Number.isFinite(Number(ref.width)) ? Number(ref.width) : Number(body.width)
      const height = Number.isFinite(Number(ref.height)) ? Number(ref.height) : Number(body.height)
      renderedImages.set(sessionId, {
        absolute: pending.absolute,
        revision: pending.revision,
        status: 'ready',
        at: Date.now(),
        image: {
          attachmentId: String(ref.attachmentId),
          mediaType: typeof ref.mediaType === 'string' && ref.mediaType.length > 0 ? ref.mediaType : 'image/png',
          bytes: Number.isFinite(Number(ref.bytes)) ? Number(ref.bytes) : bytes.length,
          width: Number.isFinite(width) ? width : 0,
          height: Number.isFinite(height) ? height : 0,
          name: typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : fallbackName,
        },
      })
      sendJson(res, 200, { ok: true, bytes: bytes.length })
      return
    }

    // action: 'revert' —— 退回**上一次 AI 改动**（就一层）。
    //
    // 为什么需要这条：客户端的撤销历史在服务端推来新版本时会被清空，
    // 所以 AI 改完以后用户按 Ctrl+Z 是退不回去的。宿主留一份改动前的文本，这里把它写回去。
    if (body.action === 'revert') {
      if (sessionId === undefined || rawPath === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
        return
      }
      let revertTarget
      let revertAbsolute
      let revertCurrent
      try {
        const loaded = await loadDoc(rawPath, sessionId)
        revertTarget = loaded.target
        revertAbsolute = loaded.absolute
        revertCurrent = loaded.text
      } catch (error) {
        sendJson(res, 400, { ok: false, error: '这个文件读不出画布：' + messageOf(error) })
        return
      }
      const key = snapshotKey(sessionId, revertAbsolute)
      const stack = revertSnapshots.get(key)
      const snapshot = stack === undefined || stack.length === 0 ? undefined : stack[stack.length - 1]
      if (snapshot === undefined) {
        sendJson(res, 200, { ok: false, error: '这张画布没有可退回的 AI 改动了' })
        return
      }
      if (contentHash(revertCurrent) !== snapshot.revision) {
        const taskNodes = (text) => {
          const first = parseMxfile(text), nodes = []
          for (let page = 0; page < first.pageCount; page++) nodes.push(...parseMxfile(text, { page }).doc.nodes.filter((node) => node.data?.drawaiTaskId))
          return nodes
        }
        if (stableValue(taskNodes(revertCurrent)) !== stableValue(taskNodes(snapshot.text))) {
          sendJson(res, 409, { ok: false, error: 'AI 改动后已有后台生成或编辑的结果，请先在任务队列中撤销生成，避免整页回退丢失结果' }); return
        }
      }
      const policy = policyFor(sessionId)
      try {
        if (policy === undefined) await ctx.fs.writeText(revertTarget, snapshot.text)
        else await ctx.fs.writeText(revertTarget, snapshot.text, undefined, undefined, policy)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) })
        return
      }
      // 退一步：把这一层弹掉（界面上的「撤销 AI 改动」可以接着按，read 的 revertSteps 是剩余步数）。
      stack.pop()
      if (stack.length === 0) revertSnapshots.delete(key)
      sendJson(res, 200, { ok: true, revision: contentHash(snapshot.text), path: revertAbsolute, stepsLeft: revertDepth(key) })
      return
    }

    // action: 'export-result' —— 客户端把渲染好的图回执给宿主（AI 的 `{op:'export'}` 走这条）。
    //
    // 只有"这个会话此刻真的挂着一个请求"才收：否则任何能发这个 POST 的东西都能往工作区里写文件。
    // svg → 落在 `.drawio` 旁边（同名，可用请求里的 name 改基名）；png 在浏览器里直接下载，
    // 这里只记一笔"已下载"（宿主写二进制要另开通道，而用户点一次就有的东西不值得为它搬 base64）。
    if (body.action === 'export-result') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const pending = exportRequests.get(sessionId)
      if (pending === undefined) {
        sendJson(res, 409, { ok: false, error: 'no pending export request' })
        return
      }
      if (typeof body.requestId === 'string' && body.requestId !== pending.requestId) {
        sendJson(res, 409, { ok: false, error: 'stale export request' })
        return
      }
      if (body.ok === false) {
        exportRequests.delete(sessionId)
        exportResults.set(sessionId, {
          absolute: pending.absolute,
          status: 'failed',
          format: pending.format,
          error: typeof body.error === 'string' && body.error.length > 0 ? body.error : '客户端没能渲染出这张图',
        })
        sendJson(res, 200, { ok: true })
        return
      }
      if (pending.format === 'png') {
        exportRequests.delete(sessionId)
        exportResults.set(sessionId, { absolute: pending.absolute, status: 'downloaded', format: 'png' })
        sendJson(res, 200, { ok: true, downloaded: true })
        return
      }
      const svg = typeof body.svg === 'string' ? body.svg : ''
      if (svg.trim().length === 0) {
        sendJson(res, 400, { ok: false, error: 'svg is empty' })
        return
      }
      if (Buffer.byteLength(svg, 'utf8') > SAVE_MAX_BYTES) {
        sendJson(res, 413, { ok: false, error: 'svg exceeds ' + SAVE_MAX_BYTES + ' bytes' })
        return
      }
      const base = pending.name !== undefined && pending.name.length > 0 ? pending.name : baseNameOf(pending.absolute)
      const dir = dirOf(pending.absolute)
      let exportTarget = null
      try {
        exportTarget = dir.length > 0 ? await ctx.fs.resolve(base + '.svg', { cwd: dir }) : await ctx.fs.resolve(base + '.svg')
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      const exportPolicy = policyFor(sessionId)
      try {
        if (exportPolicy === undefined) await ctx.fs.writeText(exportTarget, svg)
        else await ctx.fs.writeText(exportTarget, svg, undefined, undefined, exportPolicy)
      } catch (error) {
        exportRequests.delete(sessionId)
        exportResults.set(sessionId, { absolute: pending.absolute, status: 'failed', format: 'svg', error: messageOf(error) })
        sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) })
        return
      }
      exportRequests.delete(sessionId)
      exportResults.set(sessionId, {
        absolute: pending.absolute,
        status: 'done',
        format: 'svg',
        path: absoluteHint(exportTarget, base + '.svg'),
      })
      sendJson(res, 200, { ok: true, path: absoluteHint(exportTarget, base + '.svg') })
      return
    }

    // action: 'media-extract-result' —— 画布抽完帧的回执（AI 的 `extractFrames {seconds,fps,width}` 走这条）。
    // 与 export-result 同一条护栏：只有"这个会话此刻真的挂着一份抽帧计划"才收。
    if (body.action === 'media-extract-result') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const pending = extractRequests.get(sessionId)
      if (pending === undefined) {
        sendJson(res, 409, { ok: false, error: 'no pending extract request' })
        return
      }
      if (typeof body.requestId === 'string' && body.requestId !== pending.requestId) {
        sendJson(res, 409, { ok: false, error: 'stale extract request' })
        return
      }
      const written = Math.max(0, Math.floor(Number(body.written) || 0))
      extractRequests.delete(sessionId)
      extractResults.set(sessionId, {
        absolute: pending.absolute,
        clip: pending.clip,
        written: written,
        error: typeof body.error === 'string' ? body.error : '',
      })
      sendJson(res, 200, { ok: true, written: written })
      return
    }

    // action: 'focus' —— 画布告诉宿主"用户现在打开的是哪一张"。
    // 之后 diagram_apply 不传 path 时就改它（见下面的 execute）。
    // 校验后**只存相对工作区的路径**：绝对路径能存但会让日志/提示变长，
    // 而且工作区被移动后相对路径仍然有效。
    if (body.action === 'focus') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const focusRoot = workspaceRootOf(sessionId)
      if (focusRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const raw = typeof body.path === 'string' ? body.path : ''
      const before = focusedCanvas.get(sessionId)
      const pageNum = Number.isFinite(Number(body.page)) ? Math.max(0, Math.floor(Number(body.page))) : 0
      // 空路径 = 清掉聚焦（画布未绑定文件时）
      if (raw.length === 0) {
        focusedCanvas.delete(sessionId)
        focusedPage.delete(sessionId)
        // 画布都关了，选区当然也不算数了
        canvasSelection.delete(sessionId)
        if (before !== undefined) notifyFocusedCanvas(sessionId, '')
        sendJson(res, 200, { ok: true, focused: null })
        return
      }
      let focusTarget
      try {
        focusTarget = await ctx.fs.resolve(raw, { cwd: focusRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(focusRoot)
        if (!ctx.fs.contains(rootTarget, focusTarget)) {
          sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(focusTarget, raw) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      focusedCanvas.set(sessionId, raw)
      focusedPage.set(sessionId, pageNum)
      // 换了一张画布 = 上一张的选区作废（否则"在 A 图选中的 n1"会变成 B 图里的 n1 ——
      // 两个文件里都叫 n1 太常见了）。客户端切换标签后会重新上报新选区。
      if (before !== raw) canvasSelection.delete(sessionId)
      if (before !== raw) notifyFocusedCanvas(sessionId, raw)
      sendJson(res, 200, { ok: true, focused: raw, page: pageNum })
      return
    }

    // action: 'selection' —— 画布告诉宿主"用户现在选中了哪几个单元"。
    //
    // 为什么需要：用户说"把这几个换成绿色""把它们往右挪一点"时，AI 原来只能靠坐标猜
    // （"这几个"是哪几个它看不见）。客户端本来就有选区状态，只是从来没告诉宿主。
    //
    // 与聚焦同一条规矩：**只存路径与 id，不读内容、也不进文件** —— 选区是"用户在看什么"
    // 的提示，不是文档状态。存的是**解析后的绝对路径**，读的时候按它配对（见 selectionForCanvas）。
    if (body.action === 'selection') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const selRoot = workspaceRootOf(sessionId)
      if (selRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const selRaw = typeof body.path === 'string' ? body.path : ''
      const selIds = []
      if (Array.isArray(body.ids)) {
        // 上限只是护栏：一次点击不可能选到 500 个，写进来的是别的客户端时别把内存撑爆。
        for (let i = 0; i < body.ids.length && selIds.length < 500; i += 1) {
          const v = body.ids[i]
          if (typeof v === 'string' && v.length > 0) selIds.push(v)
        }
      }
      // 空路径（画布没绑定文件）或空选区 = 清掉记录：别让上一次的选区继续跟着走。
      if (selRaw.length === 0 || selIds.length === 0 || !isCanvasPath(selRaw)) {
        canvasSelection.delete(sessionId)
        sendJson(res, 200, { ok: true, count: 0 })
        return
      }
      let selTarget
      try {
        selTarget = await ctx.fs.resolve(selRaw, { cwd: selRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(selRoot)
        if (!ctx.fs.contains(rootTarget, selTarget)) {
          sendJson(res, 403, { ok: false, error: '目录不在工作区内：' + absoluteHint(selTarget, selRaw) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      canvasSelection.set(sessionId, { absolute: absoluteHint(selTarget, selRaw), ids: selIds })
      sendJson(res, 200, { ok: true, count: selIds.length })
      return
    }

    // action: 'suggest' —— 只**探**一个还没被占用的默认文件名，不建任何文件。
    //
    // 给界面上"新建"对话框预填用：用户要自己输名字，但默认值应该是
    // 当前可用的下一个（untitled / untitled-2 / untitled-3 …），而不是让人从空白开始想。
    // 刻意不落盘：预填只是提示，用户可能改主意取消 —— 不该留下空文件。
    if (body.action === 'suggest') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const suggestRoot = workspaceRootOf(sessionId)
      if (suggestRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      const base = typeof body.base === 'string' && body.base.trim().length > 0 ? body.base.trim() : 'untitled'
      let name = base
      for (let n = 2; n <= 999; n += 1) {
        const candidate = sanitizeNewName(name)
        if (!candidate.ok) break
        let taken = true
        try {
          const target = await ctx.fs.resolve(candidate.name, { cwd: suggestRoot })
          taken = (await ctx.fs.stat(target)) !== undefined
        } catch (error) {
          taken = false
        }
        if (!taken) {
          sendJson(res, 200, { ok: true, name: candidate.name })
          return
        }
        name = base + '-' + n
      }
      sendJson(res, 200, { ok: true, name: base })
      return
    }

    // action: 'media-*' —— 旁路媒体包（*.media/<clip>/）的读写。不改 mxfile 时也不碰 revision。
    if (typeof body.action === 'string' && body.action.indexOf('media-') === 0) {
      if (sessionId === undefined || rawPath === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
        return
      }
      if (!isCanvasPath(rawPath)) {
        sendJson(res, 403, { ok: false, error: 'media actions require a .drawio path' })
        return
      }
      const mediaRoot = workspaceRootOf(sessionId)
      if (mediaRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      let mediaTarget
      try {
        mediaTarget = await ctx.fs.resolve(rawPath, { cwd: mediaRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(mediaRoot)
        if (!ctx.fs.contains(rootTarget, mediaTarget)) {
          sendJson(res, 403, { ok: false, error: 'path escapes the workspace root' })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      const drawioAbs = absoluteHint(mediaTarget, rawPath)
      const clip = sanitizeClipId(body.clip)
      try {
        if (body.action === 'media-ffmpeg-status') {
          sendJson(res, 200, { ok: true, ...ffmpegState() }); return
        }
        if (body.action.startsWith('media-video-export-')) {
          const scope = { sessionId, drawioAbs, clip }
          let result
          switch (body.action) {
            case 'media-video-export-start': result = await videoExports.start(scope, body.format); break
            case 'media-video-export-list': result = { jobs: videoExports.list(scope) }; break
            case 'media-video-export-finish': result = videoExports.finish(scope, body.token); break
            case 'media-video-export-status': result = videoExports.status(scope, body.token); break
            case 'media-video-export-read': result = videoExports.read(scope, body.token, body.offset); break
            case 'media-video-export-discard': result = await videoExports.discard(scope, body.token, body.performance); break
            default: throw new Error('未知视频导出操作')
          }
          sendJson(res, 200, { ...result, ok: true }); return
        }
        if (body.action === 'media-upload-start') {
          const size = Number(body.size), w = Number(body.w), h = Number(body.h)
          if (!['mp4', 'webm', 'mov', 'mkv'].includes(body.extension) || !Number.isSafeInteger(size) || size <= 0 ||
              !Number.isInteger(w) || !Number.isInteger(h) || Math.min(w, h) <= 0 || Math.max(w, h) > 16384) throw new Error('无效视频文件：须为非空的 MP4/WebM/MOV/MKV')
          for (const [key, job] of videoUploadJobs) if (Date.now() - job.time > 3600000) videoUploadJobs.delete(key)
          if (videoUploadJobs.size >= 16) throw new Error('导入任务过多，请稍后重试')
          const token = randomUUID(), newClip = 'video-' + randomUUID()
          ensureClipPack(drawioAbs, newClip, { kind: 'raster', w, h })
          const dir = clipDirFor(drawioAbs, newClip), part = joinPath(dir, 'source.upload')
          writeFileSync(part, Buffer.alloc(0))
          videoUploadJobs.set(token, { sessionId, drawioAbs, clip: newClip, dir, part, source: 'source.' + body.extension, size, received: 0, time: Date.now(), finished: false })
          sendJson(res, 200, { ok: true, clip: newClip, token })
          return
        }
        if (body.action.indexOf('media-upload-') === 0) {
          const job = videoUploadJobs.get(body.token)
          if (!job || job.sessionId !== sessionId || job.drawioAbs !== drawioAbs || job.clip !== clip) throw new Error('视频导入任务已失效')
          job.time = Date.now()
          if (body.action === 'media-upload-discard') {
            rmSync(job.dir, { recursive: true, force: true }); videoUploadJobs.delete(body.token)
            sendJson(res, 200, { ok: true }); return
          }
          if (body.action === 'media-upload-chunk') {
            const bytes = Buffer.from(typeof body.base64 === 'string' ? body.base64 : '', 'base64')
            if (job.finished || body.offset !== job.received || bytes.length < 1 || bytes.length > 1024 * 1024 || job.received + bytes.length > job.size) throw new Error('视频分块位置或大小无效')
            appendFileSync(job.part, bytes); job.received += bytes.length
            sendJson(res, 200, { ok: true, received: job.received }); return
          }
          if (body.action === 'media-upload-finish') {
            if (job.received !== job.size) throw new Error('视频尚未上传完整')
            if (!job.finished) {
              renameSync(job.part, joinPath(job.dir, job.source))
              const manifest = readManifest(job.dir); manifest.source = job.source
              writeManifest(job.dir, manifest); job.finished = true
            }
            sendJson(res, 200, { ok: true, manifest: readManifest(job.dir) }); return
          }
          if (body.action === 'media-upload-release' && job.finished) {
            videoUploadJobs.delete(body.token); sendJson(res, 200, { ok: true }); return
          }
          throw new Error('未知视频导入操作')
        }
        if (body.action === 'media-trace-start') {
          const fps = Number(body.fps), w = Number(body.w), h = Number(body.h), count = Number(body.count)
          const maxBytes = body.maxBytes === undefined ? 60000 : Number(body.maxBytes)
          if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(fps) || fps <= 0) throw new Error('无效帧数或帧率')
          if (!Number.isInteger(w) || !Number.isInteger(h) || Math.min(w, h) < 1 || Math.max(w, h) > 16384 || w * h > 16000000) throw new Error('单帧处理上限为 1600 万像素、长边 16384px')
          if (!Number.isInteger(maxBytes) || maxBytes < 2000 || maxBytes > 248000) throw new Error('无效细节预算')
          for (const [key, job] of videoTraceJobs) {
            // 过期仅释放令牌；网络中断时结果可能已被画布引用，不能擅自删文件。
            if (!job.inFlight && Date.now() - job.time > 3600000) { job.perf.finish('expired'); videoTraceJobs.delete(key) }
          }
          if (videoTraceJobs.size >= 16) throw new Error('复刻任务过多，请稍后重试')
          const token = randomUUID(), newClip = 'trace-' + randomUUID()
          let originalSource = null
          if (body.sourceClip !== undefined) {
            const sourceDir = clipDirFor(drawioAbs, body.sourceClip)
            originalSource = findSourceFile(sourceDir, readManifest(sourceDir))
            if (!originalSource) throw new Error('原视频文件缺失，无法保留音频')
            if (!Number.isFinite(Number(body.sourceOffset)) || Number(body.sourceOffset) < 0) throw new Error('无效音频起始时间')
          }
          const pack = ensureClipPack(drawioAbs, newClip, { kind: 'svg', fps, w, h })
          const tracePerf = createPerformanceLog(dirnamePath(drawioAbs), 'video-trace', { fps, width: w, height: h, count, maxBytes, poolSize: videoTracePool.size })
          const sourceDone = tracePerf.start('sourceSnapshot')
          if (originalSource) {
            try {
              importSourceFile(pack.dir, originalSource.abs)
              const manifest = readManifest(pack.dir)
              manifest.kind = 'svg'; manifest.sourceOffset = Number(body.sourceOffset)
              writeManifest(pack.dir, manifest)
              pack.manifest = readManifest(pack.dir)
            } catch (error) { tracePerf.finish('failed'); rmSync(pack.dir, { recursive: true, force: true }); throw error }
          }
          sourceDone()
          videoTraceJobs.set(token, {
            token, sessionId, drawioAbs, clip: newClip, dir: clipDirFor(drawioAbs, newClip),
            count, maxBytes, time: Date.now(), nextSubmit: 0, inFlight: 0, uploads: new Map(), waiters: [], cancelled: false,
            lastFrame: null, palette: null, paletteKey: null, paletteIndex: -1,
            perf: tracePerf,
          })
          sendJson(res, 200, { ok: true, token, clip: newClip, manifest: pack.manifest, poolSize: videoTracePool.size,
            performanceEnabled: videoTraceJobs.get(token).perf.enabled, performanceId: videoTraceJobs.get(token).perf.id })
          return
        }
        if (body.action.indexOf('media-trace-') === 0) {
          const job = videoTraceJobs.get(body.token)
          if (!job || job.sessionId !== sessionId || job.drawioAbs !== drawioAbs || job.clip !== clip) throw new Error('复刻任务已失效')
          job.time = Date.now()
          if (body.action === 'media-trace-heartbeat') {
            sendJson(res, 200, { ok: true }); return
          }
          if (body.action === 'media-trace-discard') {
            job.perf.merge('browser.', body.performance); job.perf.finish('cancelled')
            job.cancelled = true
            wakeVideoTrace(job)
            videoTracePool.cancelToken(body.token)
            rmSync(job.dir, { recursive: true, force: true })
            videoTraceJobs.delete(body.token)
            sendJson(res, 200, { ok: true })
            return
          }
          let manifest = readManifest(job.dir)
          if (body.action === 'media-trace-frame-chunk') {
            const uploadDone = job.perf.start('frameChunkDecodeAndWrite')
            const index = Number(body.index)
            if (!Number.isInteger(index) || index !== job.nextSubmit || index >= job.count) throw new Error('帧分块位置无效')
            const upload = job.uploads.get(index) || { received: 0 }
            if (body.offset !== upload.received) throw new Error('帧分块位置无效')
            const bytes = Buffer.from(typeof body.base64 === 'string' ? body.base64 : '', 'base64')
            if (!bytes.length || bytes.length > 1024 * 1024 || upload.received + bytes.length > 68 * 1024 * 1024) throw new Error('帧分块大小无效')
            const part = joinPath(job.dir, 'frame.' + index + '.upload')
            if (body.offset === 0) writeFileSync(part, bytes)
            else appendFileSync(part, bytes)
            job.uploads.set(index, { received: upload.received + bytes.length })
            uploadDone(); job.perf.peak('frameUploadBytes', upload.received + bytes.length)
            sendJson(res, 200, { ok: true, received: upload.received + bytes.length })
            return
          }
          if (body.action === 'media-trace-frame') {
            const index = Number(body.index)
            if (job.cancelled || job.failure || !Number.isInteger(index) || index !== job.nextSubmit || index >= job.count) throw new Error(job.failure || '帧序号不连续或任务已取消')
            job.nextSubmit += 1
            job.inFlight += 1
            const part = joinPath(job.dir, 'frame.' + index + '.upload')
            let resolveFrame, rejectFrame, resolveKey, rejectKey
            const previous = job.lastFrame
            const promise = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject })
            const keyReady = new Promise((resolve, reject) => { resolveKey = resolve; rejectKey = reject })
            // Reserve in submission order, before asynchronous upload-file reads.
            // Metadata can finish out of order without making frame 0 await frame 1.
            promise.catch(() => {}); keyReady.catch(() => {})
            job.lastFrame = { keyReady, promise }
            try {
              const readDone = job.perf.start('frameReadAndBase64Decode')
              const png = typeof body.pngBase64 === 'string' ? Buffer.from(body.pngBase64, 'base64') : await readFile(part)
              readDone(); job.perf.count('uploadedPngBytes', png.length)
              if (job.cancelled || videoTraceJobs.get(body.token) !== job) throw new Error('复刻任务已取消')
              if (png.length < 24 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
                  png.readUInt32BE(16) !== manifest.width || png.readUInt32BE(20) !== manifest.height) throw new Error('PNG 帧尺寸与任务不一致')
              const traceOptions = videoTraceOptions(body, manifest, job.maxBytes)
              const optionsKey = JSON.stringify(traceOptions)
              const keyDone = job.perf.start('exactFrameHash')
              const key = exactVideoFrameKey(png, optionsKey)
              keyDone()
              resolveKey(key)
              const reuse = previous && await previous.keyReady === key
              let result
              if (reuse) {
                const reuseDone = job.perf.start('reuseWait')
                const cached = await previous.promise
                reuseDone()
                result = { svg: cached.svg, detailReduced: cached.detailReduced, work: cached.work, reused: true, paletteShared: false }
              } else {
                traceOptions.profile = job.perf.enabled
                // Age is measured from actual palette generation, never the previous
                // frame. Shared palettes cannot reset the clock or roll back a new one.
                const maxPaletteAge = Math.max(1, Math.min(120, Math.round(manifest.fps * 2)))
                if (job.palette && job.paletteKey === optionsKey && index - job.paletteIndex < maxPaletteAge) traceOptions.paletteOverride = job.palette
                result = await videoTracePool.run(png, traceOptions, { token: body.token })
                job.perf.add('workerQueueWait', result.queueWaitMs)
                job.perf.add('workerRoundTrip', result.workerRoundTripMs)
                job.perf.merge('worker.', result.performance)
              }
              const turnDone = job.perf.start('orderedCommitWait')
              await waitVideoTraceTurn(job, index)
              turnDone()
              if (job.cancelled || job.failure || videoTraceJobs.get(body.token) !== job) throw new Error(job.failure || '复刻任务已取消')
              const writeDone = job.perf.start('svgWrite')
              manifest = writeFrameSvg(job.dir, readManifest(job.dir), index, result.svg)
              writeDone()
              job.perf.count('frames'); job.perf.count('reusedFrames', result.reused ? 1 : 0)
              job.perf.count('paletteSharedFrames', result.paletteShared === true ? 1 : 0)
              job.perf.count('paletteRefreshFrames', !result.reused && !result.paletteShared ? 1 : 0)
              job.perf.count('paletteRejectedFrames', result.paletteReuseReason?.endsWith('-mismatch') ? 1 : 0)
              job.perf.count('svgBytes', Buffer.byteLength(result.svg)); job.perf.peak('inFlightFrames', job.inFlight)
              job.profileOptions = { level: traceOptions.level, preset: traceOptions.preset, colors: traceOptions.colors, removeBg: traceOptions.removeBg }
              if (!result.reused && !result.paletteShared) {
                job.palette = Array.isArray(result.palette) && result.palette.length >= 2 ? result.palette : null
                job.paletteKey = optionsKey; job.paletteIndex = index
              }
              job.uploads.delete(index)
              rmSync(part, { force: true })
              resolveFrame(result)
              wakeVideoTrace(job)
              sendJson(res, 200, {
                ok: true, svg: result.svg, count: manifest.frames.length, detailReduced: result.detailReduced, work: result.work,
                reused: result.reused === true, paletteShared: result.paletteShared === true,
                paletteReuseReason: result.reused ? 'exact-frame' : result.paletteReuseReason,
              })
            } catch (error) {
              job.failure = job.failure || String(error.message || error)
              rejectKey(error)
              rejectFrame?.(error)
              videoTracePool.cancelToken(body.token)
              wakeVideoTrace(job)
              job.perf.finish('failed', job.profileOptions); throw error
            } finally {
              job.inFlight = Math.max(0, job.inFlight - 1)
            }
            return
          }
          if (body.action === 'media-trace-finish' || body.action === 'media-trace-release') {
            if (manifest.frames.length !== job.count) throw new Error('复刻帧尚未全部完成')
            if (body.action === 'media-trace-finish') {
              job.perf.merge('browser.', body.performance); job.perf.finish('done', job.profileOptions)
            }
            if (body.action === 'media-trace-release') { job.perf.finish('done', job.profileOptions); videoTraceJobs.delete(body.token) }
            sendJson(res, 200, { ok: true, manifest })
            return
          }
          throw new Error('未知复刻操作')
        }
        if (body.action === 'media-ensure') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const pack = ensureClipPack(drawioAbs, clip, {
            kind: body.kind === 'raster' ? 'raster' : 'svg',
            fps: Number(body.fps),
            w: Number(body.w),
            h: Number(body.h),
          })
          sendJson(res, 200, { ok: true, clip: pack.clip, manifest: pack.manifest, mediaRoot: mediaRootFor(drawioAbs) })
          return
        }
        if (body.action === 'media-manifest') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const dir = clipDirFor(drawioAbs, clip)
          if (existsSync(dir) === false) {
            sendJson(res, 200, { ok: true, missing: true, manifest: null })
            return
          }
          const manifest = readManifest(dir)
          const source = findSourceFile(dir, manifest)
          sendJson(res, 200, {
            ok: true,
            missing: false,
            manifest: manifest,
            hasSource: source !== null,
            source: source !== null ? source.rel : null,
          })
          return
        }
        if (body.action === 'media-frame') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const dir = clipDirFor(drawioAbs, clip)
          const manifest = readManifest(dir)
          const index = Math.floor(Number(body.index))
          const svg = readFrameSvg(dir, manifest, index)
          sendJson(res, 200, { ok: true, index: index, svg: svg })
          return
        }
        if (body.action === 'media-write-frame') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const dir = clipDirFor(drawioAbs, clip)
          ensureClipPack(drawioAbs, clip, {})
          let manifest = readManifest(dir)
          if (Array.isArray(body.svgs)) {
            manifest = appendFrameSvgs(dir, manifest, body.svgs)
          } else if (typeof body.svg === 'string') {
            manifest = writeFrameSvg(dir, manifest, Number(body.index), body.svg)
          } else {
            sendJson(res, 400, { ok: false, error: 'svg or svgs required' })
            return
          }
          sendJson(res, 200, { ok: true, manifest: manifest })
          return
        }
        if (body.action === 'media-write-still') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const dir = clipDirFor(drawioAbs, clip)
          ensureClipPack(drawioAbs, clip, {})
          const index = Math.floor(Number(body.index))
          const b64 = typeof body.pngBase64 === 'string' ? body.pngBase64 : ''
          if (b64.length === 0) {
            sendJson(res, 400, { ok: false, error: 'pngBase64 required' })
            return
          }
          const file = writeStillPng(dir, index, Buffer.from(b64, 'base64'))
          sendJson(res, 200, { ok: true, file: file, index: index })
          return
        }
        if (body.action === 'media-import-source') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const file = typeof body.file === 'string' ? body.file : ''
          if (file.length === 0) {
            sendJson(res, 400, { ok: false, error: 'file required' })
            return
          }
          const srcTarget = await resolveTarget(file, sessionId)
          const srcAbs = absoluteHint(srcTarget, file)
          const dir = clipDirFor(drawioAbs, clip)
          ensureClipPack(drawioAbs, clip, { kind: 'raster' })
          const imported = importSourceFile(dir, srcAbs)
          sendJson(res, 200, { ok: true, source: imported.rel, manifest: imported.manifest })
          return
        }
        if (body.action === 'media-source-url' || body.action === 'media-source-bytes') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const dir = clipDirFor(drawioAbs, clip)
          const manifest = readManifest(dir)
          const source = findSourceFile(dir, manifest)
          if (source === null) {
            sendJson(res, 404, { ok: false, error: 'no source video in clip' })
            return
          }
          const ext = source.rel.toLowerCase().split('.').pop()
          const mime =
            ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'application/octet-stream'
          if (body.action === 'media-source-url') {
            workspacePath({ sessionId }, source.abs)
            for (const [key, ticket] of videoReadTickets) if (Date.now() - ticket.time > 3600000) videoReadTickets.delete(key)
            const token = randomUUID() + randomUUID()
            videoReadTickets.set(token, { sessionId, source: source.abs, mime, time: Date.now() })
            sendJson(res, 200, { ok: true, url: SAVE_PATH + '?video=' + token, mime })
          } else {
            // 兼容旧客户端；新客户端使用可分段读取的 URL，不再整片转 base64。
            const buf = await readFile(source.abs)
            sendJson(res, 200, { ok: true, rel: source.rel, mime, base64: buf.toString('base64') })
          }
          return
        }
        if (body.action === 'media-pack-bundle') {
          const zip = packCanvasBundle(drawioAbs)
          const outName =
            typeof body.out === 'string' && body.out.length > 0
              ? body.out
              : basenamePath(drawioAbs).replace(/\.(?:drawio|drawai)$/i, '') + '.drawai.zip'
          const safe = String(outName).replace(/^[\\/]+/, '')
          if (safe.indexOf('..') >= 0) {
            sendJson(res, 400, { ok: false, error: 'invalid out path' })
            return
          }
          const abs = joinPath(mediaRoot, safe)
          await mkdir(dirnamePath(abs), { recursive: true })
          await writeFile(abs, zip)
          sendJson(res, 200, { ok: true, path: safe.replace(/\\/g, '/'), bytes: zip.length })
          return
        }
        if (body.action === 'media-unpack-bundle') {
          const file = typeof body.file === 'string' ? body.file : ''
          if (file.length === 0) {
            sendJson(res, 400, { ok: false, error: 'file required' })
            return
          }
          const zipTarget = await resolveTarget(file, sessionId)
          const zipAbs = absoluteHint(zipTarget, file)
          const buf = await readFile(zipAbs)
          const stem = typeof body.stem === 'string' && body.stem.length > 0 ? body.stem : undefined
          const destDir = dirnamePath(drawioAbs)
          const result = unpackCanvasBundle(buf, destDir, stem)
          sendJson(res, 200, { ok: true, path: result.path })
          return
        }
        if (body.action === 'media-pack-svgvideo') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const zip = packSvgVideoZip(clipDirFor(drawioAbs, clip))
          const outName =
            typeof body.out === 'string' && body.out.length > 0
              ? body.out
              : basenamePath(drawioAbs).replace(/\.(?:drawio|drawai)$/i, '') + '-' + clip + '.svgvideo.zip'
          const safe = String(outName).replace(/^[\\/]+/, '')
          if (safe.indexOf('..') >= 0) {
            sendJson(res, 400, { ok: false, error: 'invalid out path' })
            return
          }
          const abs = joinPath(mediaRoot, safe)
          await mkdir(dirnamePath(abs), { recursive: true })
          await writeFile(abs, zip)
          sendJson(res, 200, { ok: true, path: safe.replace(/\\/g, '/'), bytes: zip.length })
          return
        }
        if (body.action === 'media-unpack-svgvideo') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const file = typeof body.file === 'string' ? body.file : ''
          if (file.length === 0) {
            sendJson(res, 400, { ok: false, error: 'file required' })
            return
          }
          const zipTarget = await resolveTarget(file, sessionId)
          const buf = await readFile(absoluteHint(zipTarget, file))
          ensureClipPack(drawioAbs, clip, { kind: 'svg' })
          const manifest = unpackSvgVideoZip(buf, clipDirFor(drawioAbs, clip))
          sendJson(res, 200, { ok: true, manifest: manifest })
          return
        }
        if (body.action === 'media-copy-beside') {
          const from = typeof body.fromPath === 'string' ? body.fromPath : ''
          if (from.length === 0) {
            sendJson(res, 400, { ok: false, error: 'fromPath required' })
            return
          }
          const fromTarget = await resolveTarget(from, sessionId)
          const result = copyMediaBeside(absoluteHint(fromTarget, from), drawioAbs)
          sendJson(res, 200, { ok: true, copied: result.copied, from: result.from, to: result.to })
          return
        }
        if (body.action === 'media-cleanup') {
          const current = await loadDoc(drawioAbs, sessionId, 0)
          const nodes = [...(body.doc?.nodes || [])]
          for (let page = 0; page < current.pageNames.length; page++) {
            const parsed = page === 0 ? current : await loadDoc(drawioAbs, sessionId, page)
            nodes.push(...parsed.doc.nodes)
          }
          const leases = new Set([...drawingTasks.leases(drawioAbs, { workspaceRoot: mediaRoot }), ...videoExports.leases(drawioAbs), ...motionTasks.leases({ sessionId, drawioAbs })])
          for (const job of videoTraceJobs.values()) if (job.drawioAbs === drawioAbs) leases.add(job.clip)
          for (const clip of audioService.leases({drawioAbs})) leases.add(clip)
          const removed = cleanupUnreferencedClips(drawioAbs, { nodes }, leases)
          sendJson(res, 200, { ok: true, removed: removed })
          return
        }
        if (body.action === 'media-export-source') {
          if (clip === null) {
            sendJson(res, 400, { ok: false, error: 'clip is required' })
            return
          }
          const dir = clipDirFor(drawioAbs, clip)
          const manifest = readManifest(dir)
          const source = body.variant && body.variant !== 'full' ? (()=>{const name={picture:'picture.mp4',noBgm:'no-bgm.mp4'}[body.variant];if(!name||!existsSync(joinPath(dir,name)))throw new Error('此版本不存在');return {rel:name,abs:joinPath(dir,name)}})() : findSourceFile(dir, manifest)
          if (source === null) {
            sendJson(res, 404, { ok: false, error: 'no source video' })
            return
          }
          const outName =
            typeof body.out === 'string' && body.out.length > 0
              ? body.out
              : basenamePath(drawioAbs).replace(/\.(?:drawio|drawai)$/i, '') + '-' + clip + '-' + source.rel
          const safe = String(outName).replace(/^[\\/]+/, '')
          if (safe.indexOf('..') >= 0) {
            sendJson(res, 400, { ok: false, error: 'invalid out path' })
            return
          }
          const abs = joinPath(mediaRoot, safe)
          await mkdir(dirnamePath(abs), { recursive: true })
          await writeFile(abs, await readFile(source.abs))
          sendJson(res, 200, { ok: true, path: safe.replace(/\\/g, '/') })
          return
        }
        sendJson(res, 400, { ok: false, error: 'unknown media action: ' + body.action })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      }
      return
    }

    // action: 'create' —— 新建一张**真实存在**的空画布并绑定到它。
    //
    // 为什么不"留着以后再说"：画布一旦没有文件，AI 对话就够不到它
    // （diagram_apply 只按路径工作，不传 path 会落到 demo.drawio —— 实测过）。
    // 与其让用户对着"未命名画布"说"画一张图"却改到别的文件，不如新建时就落一个空文件。
    // 同名文件已存在时**不覆盖**，返回 exists 让界面提示改名。
    if (body.action === 'create') {
      if (sessionId === undefined) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const nameCheck = sanitizeNewName(body.name)
      if (!nameCheck.ok) {
        sendJson(res, 400, { ok: false, error: nameCheck.error })
        return
      }
      const createRoot = workspaceRootOf(sessionId)
      if (createRoot === undefined) {
        sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
        return
      }
      let createTarget
      try {
        createTarget = await ctx.fs.resolve(nameCheck.name, { cwd: createRoot })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
        return
      }
      try {
        const rootTarget = await ctx.fs.resolve(createRoot)
        if (!ctx.fs.contains(rootTarget, createTarget)) {
          sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absoluteHint(createTarget, nameCheck.name) })
          return
        }
      } catch (error) {
        sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
        return
      }
      try {
        const info = await ctx.fs.stat(createTarget)
        if (info !== undefined) {
          sendJson(res, 200, { ok: false, exists: true, error: 'already exists', path: nameCheck.name })
          return
        }
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'stat failed: ' + messageOf(error) })
        return
      }
      // 空画布也打 meta.pinned：它是人手工建的，不该被 AI 的自动布局重排。
      // 文档形状直接用 emptyDoc()（**含那个缺省图层**）—— 别再手搭一份
      // `{version, meta, nodes, edges}`：这就是同一个"逐个字段抄"的毛病，
      // 抄漏 layers 之后内存里的画布与盘上的文件对不上。
      const blankDoc = Object.assign({}, emptyDoc(), { meta: { pinned: true } })
      const blankBuilt = buildMxfile(blankDoc, { name: nameCheck.name.replace(/\.(?:drawio|drawai)$/i, ''), format: isNativeCanvasPath(nameCheck.name) ? 'drawai' : 'drawio' })
      const createPolicy = policyFor(sessionId)
      try {
        if (createPolicy === undefined) await ctx.fs.writeText(createTarget, blankBuilt.text)
        else await ctx.fs.writeText(createTarget, blankBuilt.text, undefined, undefined, createPolicy)
      } catch (error) {
        const scope = createPolicy === undefined ? 'unresolved policy' : createPolicy.mode + ' @ ' + String(createPolicy.workspaceRoot)
        sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        path: nameCheck.name,
        absolute: absoluteHint(createTarget, nameCheck.name),
        revision: contentHash(blankBuilt.text),
      })
      return
    }

    if (sessionId === undefined || rawPath === undefined) {
      sendJson(res, 400, { ok: false, error: 'sessionId and path are required' })
      return
    }
    if (!isCanvasPath(rawPath)) {
      sendJson(res, 403, { ok: false, error: 'only .drawio documents may be written' })
      return
    }
    const doc = body.doc
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      sendJson(res, 400, { ok: false, error: 'doc must be a JSON object' })
      return
    }

    const root = workspaceRootOf(sessionId)
    if (root === undefined) {
      sendJson(res, 403, { ok: false, error: 'no workspace root resolved for this session' })
      return
    }

    let target
    try {
      target = await ctx.fs.resolve(rawPath, { cwd: root })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'resolve failed: ' + messageOf(error) })
      return
    }
    const absolute = absoluteHint(target, rawPath)

    try {
      const rootTarget = await ctx.fs.resolve(root)
      if (!ctx.fs.contains(rootTarget, target)) {
        sendJson(res, 403, { ok: false, error: 'path escapes the workspace root: ' + absolute })
        return
      }
    } catch (error) {
      sendJson(res, 403, { ok: false, error: 'containment check failed: ' + messageOf(error) })
      return
    }

    // 乐观锁：基线是**文件内容指纹**（客户端打开时拿到的那个 revision）。
    // 不用"我们自己的计数器 +1"：载体是唯一真相，drawio 或别的编辑器改过文件之后，
    // 计数器无从得知；而指纹天然会变，冲突判定才是真的。
    let originalText
    let exists = false
    try {
      const info = await ctx.fs.stat(target)
      if (info !== undefined) {
        exists = true
        originalText = await ctx.fs.readText(target)
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'read current failed: ' + messageOf(error) })
      return
    }
    const baseRevision = typeof body.revision === 'string' && body.revision.length > 0 ? body.revision : undefined
    // createOnly（「另存为」）：目标**不该已存在**。已存在就直接拒绝，绝不静默覆盖。
    if (body.createOnly === true && exists) {
      sendJson(res, 409, { ok: false, error: 'already exists', path: absolute })
      return
    }
    let backgroundPatch = null
    if (baseRevision !== undefined && exists && contentHash(originalText) !== baseRevision) {
      backgroundPatch = taskPatches.between(absolute, baseRevision, contentHash(originalText), Number(body.page) || 0)
      if (!backgroundPatch) {
        sendJson(res, 409, { ok: false, error: 'revision conflict', currentRevision: contentHash(originalText) }); return
      }
    }

    // 人工编辑一律打 pinned：从此这张画布是人摆过版面的，AI 的自动布局不该再冲掉它。
    // （空文件 → 从零生成；已有文件 → 无损写回，见 renderDocText。）
    const next = normalizeDoc(doc)
    if (backgroundPatch) applyTaskPatches(next, backgroundPatch, true)
    next.meta = Object.assign({}, next.meta, { pinned: true })
    let rendered
    try {
      let template = exists ? originalText : undefined
      if (!exists && body.createOnly === true && typeof body.fromPath === 'string') {
        const source = await loadDoc(body.fromPath, sessionId, body.page)
        if (source.exists) template = source.text
      }
      rendered = renderDocText(template, next, {
        page: Number.isFinite(Number(body.page)) ? Number(body.page) : 0,
        format: isNativeCanvasPath(rawPath) ? 'drawai' : 'drawio',
      })
      if (body.createOnly === true && body.fromPath && isNativeCanvasPath(rawPath)) {
        rendered.text = forkNativeCanvas(rendered.text)
        rendered.revision = contentHash(rendered.text)
      }
    } catch (error) {
      sendJson(res, 400, { ok: false, error: '写入前解析原文件失败：' + messageOf(error) })
      return
    }
    const policy = policyFor(sessionId)
    try {
      if (policy === undefined) await ctx.fs.writeText(target, rendered.text)
      else await ctx.fs.writeText(target, rendered.text, undefined, undefined, policy)
    } catch (error) {
      const scope = policy === undefined ? 'unresolved policy' : policy.mode + ' @ ' + String(policy.workspaceRoot)
      sendJson(res, 500, { ok: false, error: 'write failed: ' + messageOf(error) + ' [sandbox: ' + scope + ']' })
      return
    }
    // 另存为：把源画布旁的 *.media 成对复制到新主名（节点只存 mediaClip，不必改 XML）。
    if (body.createOnly === true && typeof body.fromPath === 'string' && body.fromPath.length > 0) {
      try {
        const fromTarget = await resolveTarget(body.fromPath, sessionId)
        copyMediaBeside(absoluteHint(fromTarget, body.fromPath), absolute)
      } catch (error) {
        // 媒体复制失败不回滚画布写入：海报仍在；播放时会报媒体包缺失。
      }
    }
    sendJson(res, 200, { ok: true, revision: rendered.revision, path: absolute, dropped: rendered.dropped, ...(backgroundPatch ? { backgroundPatch } : {}) })
  }

  /**
   * 只读诊断：不碰画布、不改文件，只回答"这个进程里到底注册上了哪几个 host 工具"。
   * issue #8 那种"画布能用、工具全没"的现场，把这个 URL 的 JSON 贴回来就够了。
   */
  function handleDiagnostics(_req, res) {
    sendJson(res, 200, {
      ok: true,
      plugin: 'dsh-drawai',
      toolsService: toolsService() !== undefined,
      registered: toolRegistrations.filter((item) => item.ok).map((item) => item.name),
      pending: toolRegistrations.filter((item) => item.deferred).map((item) => item.name),
      failed: toolRegistrations.filter((item) => !item.ok && !item.deferred).map((item) => ({ name: item.name, error: item.error })),
    })
  }

  // 诊断路由排在写回路由之前：自测按 routes[last] 取写回路由，这个顺序不能反过来。
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DIAGNOSTICS_PATH, handler: handleDiagnostics }), 'drawai: ' + DIAGNOSTICS_PATH)

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SAVE_PATH, handler: handleSave }), 'drawai: ' + SAVE_PATH)

  ctx.effect(() => registerHostTool(defineTool({
    name: 'shotcraft_search',
    description: '搜索 DrawAI 内置的 124 张 Shotcraft 镜头卡 / 150 个准确样式。按关键词（中英文卡名、样式、用途）和分类检索；返回唯一 demo、样片及可用于 diagram_apply 的节点参数。先搜索再添加 shape:shotcard 节点并连到视频节点，支持同时参考多卡。',
    parameters: { query: { type: 'string' }, category: { type: 'string' }, cardId: { type: 'string', description: '精确卡名，查看该卡所有样式；配合 styleKey 会直接返回这张卡的配方与 demo 源码' },
      styleKey: { type: 'string', description: '精确样式 key（与 cardId 一起用，等于"读这张卡"）' },
      offset: { type: 'number' }, limit: { type: 'number', description: '每页 1–30，默认 12' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args) {
      const matches = searchShotCards(shotCardCatalog, args.query, args.category).filter((item) => !args.cardId || item.cardId === args.cardId)
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), limit = Math.min(30, Math.max(1, Math.floor(Number(args.limit) || 12)))
      // 读一张卡：配方（怎么实现、参数、坑）+ demo 源码（照着改）。
      // 这是"按卡做"和"按卡名做"的分水岭——不读这一步，卡就只是个标签。
      if (args.cardId && args.styleKey) {
        const match = matches.find((item) => item.styleKey === args.styleKey)
        if (!match) throw new Error('没有这个样式：' + args.cardId + ' / ' + args.styleKey)
        const contract = motionCardContract({ cardId: match.cardId, styleKey: match.styleKey })
        return { summary: '已读镜头卡 ' + match.label,
          details: JSON.stringify({ cardId: contract.cardId, styleKey: contract.styleKey, recipePath: contract.cardSource, demoPath: match.demo,
            duration: match.duration, energy: match.energy, recipe: contract.recipe, demoSource: contract.source, preservation: contract.preservation }) }
      }
      const withPath = (item) => ({ ...item, recipe: shotCardCatalog.cards.find((card) => card.id === item.cardId)?.source })
      return { summary: '找到 ' + matches.length + ' 个镜头样式', details: JSON.stringify({ total: matches.length, offset, categories: shotCardCatalog.categories,
        hint: '写场景前先用 cardId+styleKey 再搜一次，把配方和 demo 源码读回来',
        styles: matches.slice(offset, offset + limit).map((item) => ({ ...withPath(item), node: { op: 'addNode', shape: 'shotcard', cardId: item.cardId, styleKey: item.styleKey } })) }) }
    },
  })))
  ctx.effect(() => registerHostTool(defineTool({
    name: 'mg_style',
    description: 'DrawAI 内置的 14 种整片 MG 动效风格（mg-styles 库）：扁平矢量 / 线条动画 / 等轴 2.5D / 逐帧手绘 / 拼贴 / 液态 / 形变 / 包豪斯 / 80s 复古 / 玻璃拟态 / 综艺花字 / 粗描边贴纸科普 / 像素 / 赛博 HUD。上游那支 04-3d-render（C4D/Blender 质感的 CGI 软着陆）没有收录：画面是 Blender 离线渲的，插件里没有同等质感的等价物——用 CSS 滤镜凑出来的 CGI 只会更假，需要那种质感就外部渲好当素材回灌（motion_assets capture / 参考段）。这是「整片风格」（一种片子的整体视觉语言），与 shotcraft_search 的「单镜动效卡」互补、可同时用。action:"list" 列出全部；"search" 按关键词检索；"read" 读某个风格的施工包（可检验判据 + 色板 + 字体 + 节奏 + 效果配方 + 上游提示词 + Remotion 移植 brief）；"source" 读上游成片源码正文；**"frames" 从上游 demo 按 cue 时间点抽参考帧**——动态、转场、冲击、颗粒这些只有看帧才知道，写场景前先取。选中后 diagram_apply 加 shape:"mgstyle" 节点并连到视频节点，motion_project 会把风格写进工程主题与 STYLE.md。',
    parameters: { action: { type: 'string', enum: ['list', 'search', 'read', 'source', 'frames'], required: true },
      slug: { type: 'string', description: '风格 slug，如 09-bauhaus' },
      query: { type: 'string', description: 'search：关键词（中英文风格名、用途、视觉特征）' },
      limit: { type: 'number', description: 'list/search 返回条数，默认 15/8' },
      files: { type: 'array', items: { type: 'string' }, description: 'source：上游源码相对路径（如 demos/09-bauhaus/film.js）；不传则列出该风格全部文件' },
      times: { type: 'array', items: { type: 'number' }, description: 'frames：指定时间点（秒），不传则按 cues.json 均匀抽 8 帧' },
      count: { type: 'number', description: 'frames：默认抽几帧，8' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args) {
      const action = args.action || 'list'
      const pack = (style) => ({ slug: style.slug, name: style.name, en: style.en, oneLiner: style.oneLiner,
        tags: style.tags, signature: style.signature, palette: style.palette, fonts: style.fonts, rhythm: style.rhythm,
        engine: style.engine, engines: style.engines || [], engineNote: style.engineNote || '',
        motion: style.motion || null,
        aspect: style.rhythm?.aspect || '16:9', bpm: style.rhythm?.bpm ?? null,
        node: { op: 'addNode', shape: 'mgstyle', slug: style.slug } })
      if (action === 'list' || action === 'search') {
        const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || (action === 'list' ? 15 : 8))))
        const matches = action === 'list' ? mgStyleCatalog.styles.map(pack) : searchMgStyles(mgStyleCatalog, args.query).map(pack)
        return { summary: action === 'list' ? '共 ' + matches.length + ' 种整片风格（' + mgStyleCatalog.commit.slice(0, 8) + '）'
            : '找到 ' + matches.length + ' 种风格',
          details: JSON.stringify({ total: matches.length, commit: mgStyleCatalog.commit, license: mgStyleCatalog.license,
            hint: '选一个 slug 用 action:"read" 读施工包（brief 是移植说明书）；再 diagram_apply 加 shape:"mgstyle" 节点连到视频节点。一条片子只能选一种整片风格。',
            styles: matches.slice(0, limit) }) }
      }
      if (!args.slug) throw new Error('read/source/frames 需要 slug；可以先用 action:"list" 看全部')
      const style = resolveMgStyle(mgStyleCatalog, args.slug)
      if (action === 'frames') {
        await ensureMotionAssets('抽风格参考帧')
        const captured = await captureStyleFrames({ slug: style.slug, times: args.times, count: args.count })
        return { summary: '已取 ' + captured.files.length + ' 张参考帧：' + captured.slug + '（' + captured.width + '×' + captured.height + ' @' + captured.fps + 'fps）',
          details: JSON.stringify({ ...captured,
            hint: '用 read_image 逐张看，再按 STYLE.md 的「效果配方」逐项对照写场景：转场是擦还是切、落地有没有冲击环/相机抖、运动模糊几采样、颗粒多粗、有没有二次运动。参考帧是拿来看效果的，不是逐像素复刻。' }) }
      }
      if (action === 'read') {
        const kit = mgStyleKit({ slug: style.slug })
        return { summary: '已读风格 ' + kit.name + '（' + kit.slug + '）',
          details: JSON.stringify({ slug: kit.slug, name: kit.name, en: kit.en, oneLiner: kit.oneLiner,
            signature: kit.signature, palette: kit.palette, colors: kit.colors, fonts: kit.fonts, rhythm: kit.rhythm,
            engine: kit.engine, engines: kit.engines, engineNote: kit.engineNote, engineFiles: kit.engineFiles,
            motion: kit.motion,
            promptPath: kit.prompt, briefPath: kit.brief, briefSha256: kit.briefSha256,
            sources: mgStyleSources(kit.slug).map((doc) => ({ path: doc.path, chars: doc.chars })),
            frames: { action: 'frames', slug: kit.slug, hint: '按 cue 抽 8 帧参考图：动态/转场/冲击/颗粒看这套，比读 brief 准' },
            hint: '要更细的实现细节用 action:"source" files:["…"] 读上游正文；brief 已经提炼过，先信 brief。引擎按 engines 里的来：three/webgl2 不许用 CSS 或 Canvas2D 简化替代，渲染前会扫工程源码拦截。**写场景前先 action:"frames" 取参考帧看动态**，只读 brief 会做成"形似而动不像"。',
            brief: kit.brief, prompt: kit.promptSource, preservation: kit.preservation }) }
      }
      if (action === 'source') {
        const files = Array.isArray(args.files) ? args.files.filter((item) => typeof item === 'string' && item) : []
        const available = style.demos.map((path) => ({ path, bytes: mgStyleFileSize(path) }))
        if (!files.length) return { summary: style.slug + ' 有 ' + available.length + ' 个上游文件', details: JSON.stringify({ slug: style.slug, files: available }) }
        const documents = files.map((path) => {
          if (!path.startsWith('demos/' + style.slug + '/') && path !== style.prompt) throw new Error('这个文件不属于 ' + style.slug + '：' + path)
          const source = mgStyleFile(path)
          return { path, chars: source.length, source: source.length > 120000 ? source.slice(0, 120000) + '\n/* …截断 ' + (source.length - 120000) + ' 字符… */' : source }
        })
        return { summary: '已读 ' + documents.length + ' 个上游文件', details: JSON.stringify({ slug: style.slug, documents }) }
      }
      throw new Error('未知 action：' + action)
    },
  })))
  ctx.effect(() => registerHostTool(defineTool({
    name:'audio_asset',
    description:'为画布搜索和导入音频。search 从 Freesound 搜索；get 按 fs:数字 下载并创建音频节点；import 从当前工作区导入 mp3/wav/m4a/aac/ogg/flac/webm，32MB/10分钟以内；targetId 可自动连接视频。configure 修改音频节点的 audioRole(sfx/bgm/voice)、audioGainDb、audioTrimStart/End(秒，End=0至末尾)、audioAt(全片秒)、audioFadeIn/Out(秒)、audioLoop(字符串0/1)。inspect 返回素材来源、哈希和检测结果。音频需要连接到视频；motion_task settings.audioMode=auto让AI安排镜头声音，manual使用节点参数或audioPlan，off静音；remix只重混已有成片。没有真实试听不得宣称听感通过。',
    parameters:{action:{type:'string',enum:['search','get','import','configure','inspect'],required:true},path:{type:'string'},page:{type:'number'},query:{type:'string'},limit:{type:'number'},id:{type:'string'},file:{type:'string'},nodeId:{type:'string'},targetId:{type:'string'},role:{type:'string',enum:['sfx','bgm','voice']},settings:{type:'object',additionalProperties:false,properties:{audioRole:{type:'string',enum:['sfx','bgm','voice']},audioGainDb:{type:'number'},audioTrimStart:{type:'number'},audioTrimEnd:{type:'number'},audioAt:{type:'number'},audioFadeIn:{type:'number'},audioFadeOut:{type:'number'},audioLoop:{type:'string',enum:['0','1']}},description:'configure：要改的音频设置，键名就是节点 data 里的名字（audioRole / audioGainDb / audioTrimStart…）'},x:{type:'number'},y:{type:'number'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{summary:{type:'string',required:true},details:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.summary+'\n'+value.details}]},
    async execute(args,exec){
      const sessionId=sessionIdOf(exec),path=args.path||focusedPathFor(sessionId)
      if(!sessionOf(sessionId)||!workspaceRootOf(sessionId)||!isNativeCanvasPath(path))throw new Error('请选择当前工作区画布')
      const root=await ctx.fs.resolve(workspaceRootOf(sessionId)),target=await resolveTarget(path,sessionId)
      if(!ctx.fs.contains(root,target))throw new Error('画布路径超出工作区')
      const scope={sessionId,path,drawioAbs:absoluteHint(target,path)}
      if(!['search','inspect'].includes(args.action)&&policyFor(sessionId)?.mode==='read-only')throw new Error('当前会话为只读')
      if(args.action==='search')return {summary:'音效搜索结果',details:JSON.stringify(await audioService.search(scope,args))}
      if(args.action==='inspect'||args.action==='configure')return documents.run(scope.drawioAbs,async()=>{
        const loaded=await loadDoc(path,sessionId,args.page),node=loaded.doc.nodes.find(n=>n.id===args.nodeId)
        if(!isAudioNode(node))throw new Error('请选择音频节点')
        if(args.action==='configure'){
          assertMotionEditable(loaded.doc,node.id)
          const before={data:JSON.parse(JSON.stringify(node.data)),style:node.style},patch=args.settings||{}
          const allowed=Object.keys(audioNodeData()) .filter(key=>key!=='drawaiAudio')
          if(Object.keys(patch).some(key=>!allowed.includes(key)))throw new Error('未知音频设置字段')
          node.data={...node.data,...Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,String(v)]))}
          audioNodeSettings(node.data)
          await writeMotionDocument(loaded,sessionId,node.id,before)
        }
        const manifest=node.data.audioClip?frozenAudioFile(scope.drawioAbs,node.data.audioClip).manifest:null
        return {summary:'音频节点 '+node.id,details:JSON.stringify({nodeId:node.id,data:node.data,settings:audioNodeSettings(node.data),manifest})}
      })
      let asset
      if(args.action==='get')asset=await audioService.get(scope,args)
      else {
        if(!/\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(args.file||''))throw new Error('请选择支持的音频文件')
        const source=await resolveTarget(args.file,sessionId)
        if(!ctx.fs.contains(root,source))throw new Error('音频路径超出工作区')
        const absolute=absoluteHint(source,args.file),relative=relativePath(realpathSync(absoluteHint(root,workspaceRootOf(sessionId))),realpathSync(absolute))
        if(isAbsolute(relative)||relative.startsWith('..'))throw new Error('音频真实路径超出工作区')
        asset=await importAudioFile(scope.drawioAbs,absolute,{role:args.role||'sfx'})
      }
      return documents.run(scope.drawioAbs,async()=>{
        const ops=[{op:'addNode',shape:'audio',audioRole:args.role||'sfx',audioClip:asset.clip,label:asset.manifest.name,x:args.x??80,y:args.y??80,as:'audio'}]
        if(args.targetId)ops.push({op:'addEdge',from:'audio',to:args.targetId})
        // 宿主要求无损 JSON 入参；未指定页码时必须省略，不能传 undefined。
        const result=await applyTool.execute({path,...(args.page!==undefined?{page:args.page}:{}),layout:'none',ops},exec)
        return {summary:'已添加音频节点',details:JSON.stringify({result,clip:asset.clip,manifest:asset.manifest})}
      })
    }
  })))
  ctx.effect(() => registerHostTool(readTool))
  // 宿主侧导出：没有画布侧栏的通道（QQ/CLI）里，成品图只能这么拿。与 render:true 两条路。
  ctx.effect(() => registerHostTool(exportTool))
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_task',
    description: '画布视频节点的任务记录：list 列出任务、status 查某个任务、cancel 取消、focus 在面板定位、remove 移除记录。开始制作请走 motion_project → 改 scene-*.tsx → motion_preview → motion_render；成片回填节点用 motion_render apply。',
    parameters: {
      action: { type: 'string', enum: ['list', 'status', 'cancel', 'focus', 'remove'], required: true },
      path: { type: 'string', description: '画布路径，省略时使用当前画布' },
      taskId: { type: 'string', description: '视频任务 ID' },
      nodeId: { type: 'string', description: '未指定 taskId 时，定位此视频节点的最新任务' },
      page: { type: 'number' },
      includeSource: { type: 'boolean', description: '需要检查或讨论场景代码时才开启' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      summary: { type: 'string', required: true }, details: { type: 'string', required: true },
    } }, render: (args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec), path = args.path || focusedPathFor(sessionId)
      if (!sessionOf(sessionId) || !workspaceRootOf(sessionId) || !isNativeCanvasPath(path)) throw new Error('请选择当前会话工作区中的 .drawai 画布')
      const target = await resolveTarget(path, sessionId)
      if (!ctx.fs.contains(await ctx.fs.resolve(workspaceRootOf(sessionId)), target)) throw new Error('画布路径超出工作区')
      const scope = { sessionId, path, drawioAbs: absoluteHint(target, path) }
      const compact = (job) => ({ ...job, composition: job.composition ? { ...job.composition,
        shots: job.composition.shots.map(({ sceneSource, sceneComponents, ...shot }) => ({ ...shot, ...(args.includeSource ? { sceneSource } : {}),
          ...(sceneComponents ? { sceneComponents: sceneComponents.map(({ source, ...component }) => ({ ...component, ...(args.includeSource ? { source } : {}) })) } : {}) })) } : null })
      const candidates = motionTasks.list(scope).filter((job) => !args.nodeId || job.nodeId === args.nodeId)
      if (args.action === 'list') return { summary: '当前画布视频任务', details: JSON.stringify(candidates.map(({ composition: _composition, ...job }) => job)) }
      const ids = new Set(candidates.map((job) => job.nodeId))
      if (!args.taskId && ids.size > 1) throw new Error('有多个视频节点，请指定 nodeId 或 taskId')
      let job = args.taskId ? motionTasks.result(scope, args.taskId).job : candidates[0]
      if (!job || args.nodeId && job.nodeId !== args.nodeId) throw new Error('找不到此视频任务')
      if (['apply', 'cancel', 'remove'].includes(args.action) && policyFor(sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      if (args.action === 'remove') job = motionTasks.remove(scope, job.id)
      else if (args.action === 'cancel') job = await motionTasks.cancel(scope, job.id)
      else if (args.action === 'focus') {
        const original = motionTasks.details(scope, job.id), loaded = await loadTaskDocument({ scope: original.scope })
        if (!loaded.doc.nodes.some((node) => node.id === job.nodeId)) throw new Error('视频节点已删除')
        motionFocus.set(sessionId + '\n' + scope.drawioAbs, { id: randomUUID(), nodeId: job.nodeId, page: loaded.pageIndex })
      }
      const result = motionTasks.result(scope, job.id)
      return { summary: '视频任务：' + job.status, details: JSON.stringify({ ...compact(job),
        outputPath: result.output ? joinPath(clipDirFor(scope.drawioAbs, result.output.data.mediaClip), 'source.mp4') : undefined }) }
    },
  })))
  // ── 新工具面：三个动词，没有内层 agent ────────────────────────────────
  //
  //   motion_project  建/读工程（只写文件，不启动 LLM）
  //   motion_preview  渲几帧 → 直接回图（同回合能判断画面）
  //   motion_render   起异步 job（绝不 await 到结束）
  //
  // 执行者是当前对话的主 agent：它有 read/grep/edit/pwsh，改的是普通 .tsx 小文件。
  const motionJobs = new RenderJobs()
  const motionProjectPath = (scope, nodeId) => {
    const canvas = process.platform === 'win32' ? scope.drawioAbs.toLowerCase() : scope.drawioAbs
    const key = createHash('sha256').update(JSON.stringify([canvas, scope.pageId, nodeId])).digest('hex')
    return joinPath(dirnamePath(scope.drawioAbs), '.drawai-motion', 'v2', key)
  }
  const motionScope = async (args, exec) => {
    const sessionId = sessionIdOf(exec)
    const path = args.path || focusedPathFor(sessionId)
    if (!sessionOf(sessionId) || !workspaceRootOf(sessionId) || !isNativeCanvasPath(path)) throw new Error('请选择当前会话工作区中的 .drawai 画布')
    const target = await resolveTarget(path, sessionId)
    if (!ctx.fs.contains(await ctx.fs.resolve(workspaceRootOf(sessionId)), target)) throw new Error('画布路径超出工作区')
    const loaded = await loadDoc(path, sessionId, args.page)
    return { sessionId, path, drawioAbs: absoluteHint(target, path), pageId: loaded.pageId || 'page-0' }
  }
  const workspacePath = (scope, file, mustExist = true) => {
    const root = resolvePath(workspaceRootOf(scope.sessionId)), realRoot = realpathSync(root), target = resolvePath(file)
    const within = (base, value) => { const rel = relativePath(base, value); return !isAbsolute(rel) && rel !== '..' && !/^\.\.[\\/]/.test(rel) }
    if (!within(root, target)) throw new Error('路径超出工作区')
    let existing = target
    while (!existsSync(existing)) {
      const parent = dirnamePath(existing)
      if (parent === existing) throw new Error('无法验证路径')
      existing = parent
    }
    if (!within(realRoot, realpathSync(existing))) throw new Error('真实路径超出工作区')
    if (mustExist && !existsSync(target)) throw new Error('文件不存在：' + file)
    return target
  }
  const projectDirOf = (node, scope) => {
    const stored = node.data?.motion?.project
    const target = workspacePath(scope, motionProjectPath(scope, node.id), false)
    if (existsSync(target)) return target
    if (typeof stored !== 'string' || !stored) return target
    const legacy = workspacePath(scope, resolvePath(dirnamePath(scope.drawioAbs), stored), false)
    if (!existsSync(legacy) || legacy === target) return target
    // Existing projects are copied once; keep the old directory untouched, including its outputs.
    if (policyFor(scope.sessionId)?.mode === 'read-only') return legacy
    mkdirSync(dirnamePath(target), { recursive: true })
    const stage = workspacePath(scope, target + '.migrate-' + randomUUID(), false)
    try {
      cpSync(legacy, stage, { recursive: true, force: false, errorOnExist: true, filter: source => {
        if (lstatSync(source).isSymbolicLink()) throw new Error('旧工程包含链接，请先检查后手动迁移：' + source)
        return !relativePath(legacy, source).split(/[\\/]/).some(part => part === 'node_modules' || part === 'bundle')
      } })
      const jobFile = joinPath(stage, '.out', 'jobs.json')
      if (existsSync(jobFile)) {
        const records = parseProjectJson(readFileSync(jobFile, 'utf8'))
        if (Array.isArray(records)) {
          for (const job of records) {
            if (!job || typeof job !== 'object') continue
            job.dir = target
            if (typeof job.output === 'string' && isAbsolute(job.output)) {
              const rel = relativePath(legacy, job.output)
              job.output = !isAbsolute(rel) && rel !== '..' && !/^\.\.[\\/]/.test(rel) ? joinPath(target, rel) : null
            }
          }
          writeFileSync(jobFile, JSON.stringify(records, null, 2) + '\n', 'utf8')
        }
      }
      if (existsSync(target)) throw new Error('工程迁移期间目标已出现，请重试')
      renameSync(stage, target)
    } catch (error) { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); throw error }
    return target
  }
  // 连到这个视频节点的镜头卡，顺序 = 画布上的连线顺序。
  const shotCardsOf = (doc, nodeId) => {
    const out = []
    for (const edge of motionReferenceEdges(doc, nodeId)) {
      if (motionReferenceRole(doc, edge) !== 'shotcard') continue
      const source = doc.nodes.find((item) => item.id === edge.from)
      if (!isShotCardNode(source)) continue
      const meta = shotCardCatalog.cards.find((item) => item.id === source.data.shotCardId)
      out.push({ nodeId: source.id, cardId: source.data.shotCardId, styleKey: source.data.shotStyleKey, duration: meta?.duration })
    }
    return out
  }
  // 连到这个视频节点的整片风格（一条片子一种；挂多个由 mgStyleSelection 报错）。
  const mgStyleOf = (doc, nodeId) => {
    for (const edge of motionReferenceEdges(doc, nodeId)) {
      if (motionReferenceRole(doc, edge) !== 'mgstyle') continue
      const source = doc.nodes.find((item) => item.id === edge.from)
      if (!isMgStyleNode(source)) continue
      return resolveMgStyle(mgStyleCatalog, source.data.mgStyleSlug)
    }
    return null
  }
  // 风格的节奏（fps / 时长 / 画幅）当规格缺省：选了一个风格，片子本来就该是这个节奏。
  const rhythmSpec = (rhythm) => {
    if (!rhythm) return {}
    const out = {}
    if (Number(rhythm.fps) >= 12 && Number(rhythm.fps) <= 30) out.fps = Number(rhythm.fps)
    if (Number(rhythm.duration) >= 2 && Number(rhythm.duration) <= 60) out.duration = Number(rhythm.duration)
    const aspect = String(rhythm.aspect || '')
    if (aspect === '9:16') { out.width = 1080; out.height = 1920 }
    else if (aspect === '4:5') { out.width = 1080; out.height = 1350 }
    else if (aspect === '1:1') { out.width = 1080; out.height = 1080 }
    else if (aspect === '16:9') { out.width = 1920; out.height = 1080 }
    return out
  }

  /**
   * 动效素材包（字体 + 素材库，约 145MB）不在 npm 包里：第一次用到时下载一次，
   * 之后从 `~/.dsh/drawai-assets/` 直接读。下载失败就把「怎么自己解决」抛给用户，
   * 而不是让渲染在缺字体的地方以更难看的方式炸掉。
   */
  async function ensureMotionAssets(reason) {
    if (assetsSummary().ready) return
    let lastPct = -1
    try {
      await requireAssets({
        onProgress: (got, total) => {
          const pct = total ? Math.floor((got / total) * 100) : -1
          if (pct !== lastPct) {
            lastPct = pct
            console.error('[drawai] 正在下载动效素材包 ' + (pct >= 0 ? pct + '%' : (got / 1048576).toFixed(1) + 'MB'))
          }
        },
      })
      console.error('[drawai] 动效素材包就绪')
    } catch (err) {
      throw new Error('（' + reason + '）' + (err?.message || err))
    }
  }

  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_project',
    description: '视频工程：把画布里的一个视频节点落成磁盘上的小文件工程（timeline.json + scene-<n>.tsx + assets/ + theme.ts）。create 建工程并返回文件清单与分镜表，之后用 read/edit/write 直接改场景文件；open 重新读时间轴、文件清单和主题；theme 换配色（重写 theme.ts，场景里用它的常量就一起变）。这里不启动任何模型，也不渲染。按用户要求确定风格和素材；除非用户要求跳过，先制作 3–6 秒样片并回填到独立的样片视频节点，用户要求先审样时等待反馈。create 前镜头卡必须 addEdge 连到视频节点：连线同时是参考、镜头顺序和段长，画布上有断连的卡会直接报错。',
    parameters: {
      action: { type: 'string', enum: ['create', 'open', 'theme'], required: true },
      path: { type: 'string', description: '画布路径，省略时使用当前画布' },
      nodeId: { type: 'string', required: true, description: '视频节点 id' },
      page: { type: 'number' },
      spec: {
        type: 'object',
        additionalProperties: true,
        properties: { width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' }, duration: { type: 'number' } },
        description: '视频规格 {width,height,fps,duration}（像素与秒），省略时沿用节点设置',
      },
      prompt: { type: 'string', description: '这条视频要什么，会写进 BRIEF.md' },
      segments: { type: 'number', description: '初始分几段，默认 4' },
      storyboard: {
        type: 'array',
        items: { type: 'json' },
        description: '分镜表：[{intent:"这一镜要做什么", onScreen:"画面上出现什么", copy:"配字"}]，按镜头顺序；也可以给 ["一句话"] 简写。会写成 storyboard.md。',
      },
      theme: { type: 'string', description: '配色主题名：vintage-kraft / deep-ocean / obsidian-violet / modern-light / midnight / solar-pop / coral-burst / color-play / paper-ink。给了就在工程里生成 theme.ts，场景用 {{PAPER, INK, DUST, STAMP}} 引用。' },
      themeTokens: {
        type: 'object',
        additionalProperties: true,
        properties: {
          page: { type: 'string' }, text: { type: 'string' }, muted: { type: 'string' }, accent: { type: 'string' },
          surface: { type: 'string' }, field: { type: 'string' }, border: { type: 'string' },
        },
        description: '直接给一套色 {page,text,muted,accent,surface,field,border}（#RRGGBB，优先于 theme；也认 paper/card/ink 这些别名）。',
      },
      style: { type: 'string', description: '整片风格 slug（mg_style list 里的 slug，如 09-bauhaus）。给了就用这个风格：色板当主题、节奏当规格缺省、施工说明与引擎契约写进 STYLE.md。也可以不传，改为在画布上连一个「整片风格」节点。' },
      allowUnlinkedCards: { type: 'boolean', description: 'create 时允许画布上存在没连线的镜头卡（当作灵感，不进 assets/timeline）。默认不允许：断连的卡会同时漏掉参考与排期，所以直接报错，让你补 addEdge。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const scope = await motionScope(args, exec)
      if (args.action === 'create' && policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      return documents.run(scope.drawioAbs, async () => {
        const loaded = await loadDoc(scope.path, scope.sessionId, args.page)
        const node = loaded.doc.nodes.find((item) => item.id === args.nodeId)
        if (!node) throw new Error('找不到视频节点 ' + args.nodeId)
        const dir = projectDirOf(node, scope)
        // json 参数有可能是字符串（见 jsonValue 注释），先统一还原，后面只读这几个局部量。
        const specArg = jsonObject(args.spec)
        const styleArg = jsonValue(args.style)
        const storyboardArg = jsonValue(args.storyboard)
        const themeTokensArg = jsonValue(args.themeTokens)
        if (args.action === 'theme') {
          if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
          if (!existsSync(dir)) throw new Error('工程还没建：先 action:"create"')
          const resolved = resolveTheme(themeTokensArg || args.theme)
          if (!resolved) throw new Error('请给 theme（主题名）或 themeTokens（一套色）。可选主题：' + listThemes().map((item) => item.name).join('、'))
          const written = writeTheme(dir, resolved)
          return { summary: '已换主题：' + written.name, details: JSON.stringify({ dir, theme: written, themes: listThemes() }) }
        }
        if (args.action === 'open') {
          const timeline = readTimeline(dir)
          return { summary: '视频工程 ' + dir, details: JSON.stringify({ dir, timeline, files: listFiles(dir),
            theme: readTheme(dir), output: outputInfo(outputPath(dir, 'film.mp4')) }) }
        }
        if (!isMotionNode(node)) throw new Error('请选择空视频或绘制视频节点')
        const before = { data: JSON.parse(JSON.stringify(node.data)), style: node.style }
        const style = styleArg ? resolveMgStyle(mgStyleCatalog, styleArg) : mgStyleOf(loaded.doc, node.id)
        const kit = style ? mgStyleKit({ slug: style.slug }) : null
        // 规格优先级：风格节奏（最弱）< 节点上存的 < 这次显式给的
        const spec = readSpec({ ...rhythmSpec(style?.rhythm), ...(node.data.motion || {}), ...specArg })
        const errors = validateSpec(spec)
        if (errors.length) throw new Error('视频规格不合法：' + errors.join('；'))
        const cards = shotCardsOf(loaded.doc, node.id)
        // 镜头卡不连线 = 参考、顺序、段长三样一起丢。这里不靠"提示"，直接拦。
        const unlinked = unlinkedShotCards(loaded.doc)
        if (unlinked.length > 0 && !args.allowUnlinkedCards) {
          throw new Error('有 ' + unlinked.length + ' 张镜头卡没连到视频节点（' + unlinked.map((item) => item.nodeId).join(', ') + '）：'
            + '连线同时决定「进 assets 当参考」「镜头顺序」「每段时长」，断连的卡三样都不算。'
            + '先读回节点坐标，自行规划正交折点，再 diagram_apply addEdge{from:"卡 id", to:"' + node.id + '", line:"rounded", points:[折点坐标]} 把它们连上；'
            + '如果这些卡只是灵感、不参与排期，删掉它们，或传 allowUnlinkedCards:true 并在 BRIEF.md 里注明。')
        }
        // 分镜表的真相源在画布上：没显式给 storyboard 时读【分镜表】节点（一张表、每镜一行）。
        // 这也是"分镜被拆成八条文本节点"能被发现的地方 —— readCanvasSpec 会把它们列出来。
        const canvasSpec = readCanvasSpec(loaded.doc, { fps: spec.fps })
        const storyboardInput = args.storyboard !== undefined
          ? storyboardArg
          : canvasSpec.storyboard.length > 0 ? canvasSpec.storyboard : undefined
        // 显式给了时长就以时长为总长：卡片之间按相对时长等比拉伸，不再被卡片总和改短。
        const durationGiven = Number(specArg.duration) > 0
        // 建工程要往 assets/fonts 里拷字体：先确保素材包在（首次会下载一次）。
        await ensureMotionAssets('建视频工程')
        const created = createProject(dir, { spec, prompt: args.prompt ?? node.data.motion?.prompt, segments: args.segments, cards, storyboard: storyboardInput,
          theme: themeTokensArg || args.theme, style: kit, fitFrames: durationGiven ? spec.totalFrames : 0 })
        registerProject(dir)
        const seconds = created.timeline.durationInFrames / created.timeline.fps
        node.data.motion = { ...(node.data.motion || {}), mode: spec.mode, width: created.timeline.width, height: created.timeline.height, fps: created.timeline.fps, duration: Math.round(seconds * 100) / 100,
          prompt: String(args.prompt ?? node.data.motion?.prompt ?? '').slice(0, 12000),
          project: relativePath(dirnamePath(scope.drawioAbs), dir) }
        await writeMotionDocument(loaded, scope.sessionId, node.id, before)
        const warnings = [...(created.warnings || [])]
        if (cards.length === 0) warnings.push(created.storyboard.length >= 2
          ? '没有连镜头卡：段数按分镜表的 ' + created.storyboard.length + ' 行开，时长取表里的帧区间（没写就均分）；画面参考不来自画布。'
          : '没有连镜头卡：时间轴按 segments 均分，镜头顺序与段长都不来自画布。要按卡排布就先 addEdge（见 next）。')
        if (unlinked.length > 0) warnings.push('有 ' + unlinked.length + ' 张镜头卡未连线（' + unlinked.map((item) => item.nodeId).join(', ') + '）：按灵感处理，不进 assets、不进 timeline。')
        return { summary: '已建视频工程，' + created.timeline.shots.length + ' 段 / ' + seconds.toFixed(2) + ' 秒'
          + (cards.length
            ? '（' + (durationGiven ? '按 ' + cards.length + ' 张镜头卡等比拉到指定时长' : '按 ' + cards.length + ' 张镜头卡排布') + '）'
            : '（均分，未挂镜头卡 ⚠）')
          + (unlinked.length ? '，' + unlinked.length + ' 张卡未连线' : '')
          + (created.storyboard.length ? '，分镜表 ' + created.storyboard.length + ' 行' : '，还没有分镜表')
          + (created.theme ? '，主题 ' + created.theme : '')
          + (style ? '，风格 ' + style.name + (style.engines?.length ? '（引擎 ' + style.engines.map((engine) => ENGINE_LABEL[engine] || engine).join(' + ') + '）' : '') + '，施工说明见 STYLE.md' : ''), details: JSON.stringify({
          dir, files: created.files, timeline: created.timeline, cards, storyboard: created.storyboard,
          ...(canvasSpec.nodes.storyboard ? { canvasSpec: { storyboardNode: canvasSpec.nodes.storyboard, rows: canvasSpec.storyboard.length } } : {}),
          ...(canvasSpec.problems.length ? { canvasSpecProblems: canvasSpec.problems } : {}),
          ...(style ? { style: { slug: style.slug, name: style.name, commit: style.commit, signature: style.signature, engine: style.engine, engines: style.engines, engineNote: style.engineNote } } : {}),
          ...(warnings.length ? { warnings } : {}),
          next: [
            ...(warnings.length ? warnings : []),
            ...(style ? ['动手前先读工程里的 STYLE.md：判据、色板、节奏、引擎契约、要避的坑都在里面，凭风格名自由发挥就不像了。'] : []),
            ...(style?.engines?.some((engine) => GATED_ENGINES.has(engine))
              ? ['这个风格的上游是 ' + style.engines.map((engine) => ENGINE_LABEL[engine] || engine).join(' + ') + '：先把引擎骨架跑通（canvas + 真渲染器 + 后处理），再往里排内容；用 CSS 3D 或 Canvas2D 简化会在 motion_render 被拒绝。']
              : []),
            created.storyboard.length
              ? '分镜表已写进 storyboard.md。'
              : '还没分镜表：先 motion_spec{action:"scaffold"} 在画布空位建一张【分镜表】节点，把每一镜写成表里的一行，再 create 一次（分镜表只能有一张，不要一镜一个节点）。',
            ...(canvasSpec.problems.length ? ['画布规格要先修：' + canvasSpec.problems.join('；') + '（motion_spec{action:"validate"} 会逐条报）'] : []),
            '开工前自检两件事：风格与色调是问过用户（或他明说你定）的吗？品牌 logo/字标是用户给的、或按官方规范取的原图吗？——没确认就回去补，这两件错了整片要重做。',
            '先出定调帧：只写 scene-0 → motion_preview{frames:[首段中点]} 看一张静帧，确认纸色/字重/留白/动效气质。',
            '做 3–6 秒样片：主节点 motion_render start + range，记下 pilot jobId → status 确认 done → diagram_apply 建或复用独立「样片」视频节点 → motion_render apply {nodeId:"样片节点 id",jobId:"pilot jobId",source:"pilot"}，确认回填并告知用户。用户明确跳过时除外；用户要求先审样时再等待反馈。',
            cards.length
              ? '顺序已按镜头卡时长排好：用 read 打开 scene-0.tsx 开始写第一段。'
              : '这个节点没有连镜头卡，时间轴按段数均分。要按卡排布：先 shotcraft_search 选卡 → diagram_apply addNode{shape:"shotcard"} + addEdge 连到本节点 → 删掉 timeline.json 后重新 create。',
          ].join(' ') }) }
      })
    },
  })))

  // 画布规格三块：【分镜表】/【风格】/【旁白】。
  //
  // 以前这三块只活在对话里（或 storyboard.md 里），于是"分镜表"在画布上就变成
  // **一镜一个文本节点**——八镜八条，谁也不觉得那是一张表，motion_project 也读不到。
  // 这里给一个工具：建（scaffold）、读（read）、验（validate）。
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_spec',
    description: '画布上的视频规格三块，用**一个节点**写清楚：\n【分镜表】一张 Markdown 六列表（镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音），每一镜一行——**不要一镜建一个节点**；\n【风格】一行一个键（page #F7F3EA / serif "Noto Serif SC" / materials: kraft）；\n【旁白】`## shot-N` 分节，一句一行。\naction:"scaffold" 返回把缺的块摆到视频附近空位的 diagram_apply ops（已有一张【分镜表】就不再建第二张）；"read" 读回来；"validate" 逐条报错（分镜被拆成多条、帧数之和对不上节点时长、镜号不连号…）。motion_project create 不给 storyboard 时会直接读这张表。',
    parameters: {
      action: { type: 'string', enum: ['scaffold', 'read', 'validate'], required: true },
      path: { type: 'string', description: '画布路径，省略时使用当前画布' },
      nodeId: { type: 'string', description: '视频节点 id（规格块的锚点）' },
      page: { type: 'number' },
      storyboard: {
        oneOf: [{ type: 'array', items: { type: 'json' } }, { type: 'string' }],
        description: '分镜行 [{intent,onScreen,copy,card,durationFrames}]，或一段 markdown 表；省略时 scaffold 只出表头',
      },
      style: {
        oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
        description: '风格：一段文本，或 {palette,fonts,materials}',
      },
      narration: { type: 'string', description: '旁白脚本（## shot-N 分节，一句一行）' },
      spec: {
        type: 'object',
        additionalProperties: true,
        properties: { width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' }, duration: { type: 'number' } },
        description: '视频规格 {width,height,fps,duration}（像素与秒），省略时读节点上的',
      },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const scope = await motionScope(args, exec)
      const loaded = await loadDoc(scope.path, scope.sessionId, args.page)
      const node = args.nodeId ? loaded.doc.nodes.find((item) => item.id === args.nodeId) : loaded.doc.nodes.find(isMotionNode)
      if (!node) throw new Error('找不到视频节点' + (args.nodeId ? ' ' + args.nodeId : ''))
      const spec = readSpec({ ...(node.data?.motion || {}), ...jsonObject(args.spec) })
      if (args.action === 'scaffold') {
        if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        const built = scaffoldOps(loaded.doc, { videoNode: node, storyboard: jsonValue(args.storyboard), style: jsonValue(args.style),
          narration: args.narration, fps: spec.fps, totalFrames: spec.totalFrames })
        if (built.ops.length === 0) {
          return { summary: '规格块已经齐了（' + built.already.join('、') + '），不必再建',
            details: JSON.stringify({ already: built.already, next: '直接 read / validate；要改就用 diagram_apply 的 setLabel' }) }
        }
        return { summary: '已生成 ' + built.ops.length + ' 个规格节点的 ops（' + built.created.join('、') + '）',
          details: JSON.stringify({ ops: built.ops, created: built.created,
            next: '把 ops 原样传给 diagram_apply（layout:"none"），然后 motion_spec{action:"validate"} 验一遍；分镜表只有这一张，每镜写成表里的一行。' }) }
      }
      if (args.action === 'validate') {
        const result = validateCanvasSpec(loaded.doc, { spec })
        const unlinked = unlinkedShotCards(loaded.doc)
        if (unlinked.length > 0) {
          result.errors.push('有 ' + unlinked.length + ' 张镜头卡没连到视频节点（' + unlinked.map((item) => item.nodeId).join(', ')
            + '）：连线同时决定参考、镜头顺序和段长，断连等于三样都丢。addEdge 连上，或删掉这些卡')
        }
        return { summary: result.errors.length === 0
            ? '规格没问题' + (result.warnings.length ? '（' + result.warnings.length + ' 条提醒）' : '')
            : '规格有 ' + result.errors.length + ' 个问题要先修',
          details: JSON.stringify({ errors: result.errors, warnings: result.warnings,
            nodes: result.read.nodes, rows: result.read.storyboard.length,
            next: result.errors.length ? '先 motion_spec{action:"scaffold"} 补一张【分镜表】/修掉重复节点，再用 diagram_apply setLabel 改表内容' : '' }) }
      }
      const read = readCanvasSpec(loaded.doc, { fps: spec.fps })
      return { summary: '画布规格：分镜 ' + read.storyboard.length + ' 行'
          + (read.nodes.style ? ' · 风格 ' + Object.keys(read.style.tokens).length + ' 个色' : '')
          + (read.nodes.narration ? ' · 旁白 ' + read.narration.sections.length + ' 节' : '')
          + (read.problems.length ? ' · ' + read.problems.length + ' 个问题' : ''),
        details: JSON.stringify({ storyboard: read.storyboard, style: read.style, narration: read.narration,
          nodes: read.nodes, problems: read.problems }) }
    },
  })))

  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_preview',
    description: '渲染工程里的几帧并**直接返回拼图**（同一轮就能看见画面）。第一次调用要打包（约 10–30 秒），之后同一份源码复用缓存只要几秒。frames 是绝对帧号，例如 [0,60,120,180]；省略时取每段的中点（最多 6 帧），定调阶段只写 scene-0 时用它看一张定妆帧。**要看画质（锯齿、色带、字重）就传 crop：只出 1:1 原尺寸局部**，拼图是缩过的，缩过的图看不出这些毛病。',
    parameters: {
      path: { type: 'string' }, page: { type: 'number' }, nodeId: { type: 'string', required: true },
      frames: { type: 'array', items: { type: 'number' }, description: '绝对帧号数组，最多 9 帧；省略 = 每段中点' },
      cols: { type: 'number', description: '拼图列数，默认 3' },
      crop: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
          cx: { type: 'number' }, cy: { type: 'number' },
        },
        description: '只出局部：{x,y,w,h} 或 {cx,cy,w,h}，像素。传了就按 1:1 原尺寸返回（不缩放），用来判断 AA / 色带 / 字体',
      },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      summary: { type: 'string', required: true },
      details: { type: 'string', required: true },
      image: { type: 'object', additionalProperties: false, properties: {
        attachmentId: { type: 'string', required: true }, mediaType: { type: 'string' }, bytes: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' } } } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }, ...(value.image ? [{ type: 'image', attachment: value.image }] : [])] },
    async execute(args, exec) {
      const scope = await motionScope(args, exec)
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      const loaded = await loadDoc(scope.path, scope.sessionId, args.page)
      const node = loaded.doc.nodes.find((item) => item.id === args.nodeId)
      if (!node) throw new Error('找不到视频节点 ' + args.nodeId)
      const dir = projectDirOf(node, scope)
      const requestedFrames = jsonArray(args.frames)
      const requested = requestedFrames.length ? requestedFrames.map(Number).filter((n) => Number.isFinite(n)).slice(0, 9) : []
      const frames = requested.length ? requested : (() => {
        const timeline = readTimeline(dir)
        return timeline.shots.slice(0, 6).map((shot) => shot.startFrame + Math.floor(shot.durationFrames * 0.6))
      })()
      const preview = await previewProject(dir, { frames, cols: args.cols, crop: jsonValue(args.crop), attachments: ctx.get?.('attachments') })
      const payload = { summary: '已渲染 ' + frames.length + ' 帧并拼图' + (preview.crop ? '（1:1 局部 ' + preview.crop.w + '×' + preview.crop.h + '）' : ''), details: JSON.stringify({ frames: preview.frames, sheet: preview.sheet, crop: preview.crop }) }
      const ref = preview.attachment
      if (ref && typeof ref.attachmentId === 'string') {
        const image = { attachmentId: String(ref.attachmentId) }
        if (typeof ref.mediaType === 'string') image.mediaType = ref.mediaType
        if (Number.isFinite(Number(ref.bytes))) image.bytes = Number(ref.bytes)
        if (Number.isFinite(Number(ref.width))) image.width = Number(ref.width)
        if (Number.isFinite(Number(ref.height))) image.height = Number(ref.height)
        if (typeof ref.name === 'string') image.name = ref.name
        payload.image = image
      }
      return payload
    },
  })))

  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_render',
    description: '渲染工程。start 立即返回 jobId（后台跑，不要等）；**start 前会按 STYLE.md 的引擎契约扫工程源码，three / webgl2 风格缺真引擎会直接拒绝渲染**（样片也拦；确实要换实现先在 STYLE.md 写「偏离：引擎 …」）；range 渲的是**样片**（写 .out/pilot.mp4，任务 kind=pilot），不传就是整片（.out/film.mp4）；status 查进度；list 列最近任务；cancel 取消；apply 把渲好的片子回填到视频节点——**nodeId 决定回填到哪个节点**（样片回填到另建的「样片」节点，成片回填到主视频节点），不给 jobId 时主视频节点取整片、样片节点取样片。frames 只渲染指定帧。',
    parameters: {
      action: { type: 'string', enum: ['start', 'status', 'list', 'cancel', 'apply'], required: true },
      path: { type: 'string' }, page: { type: 'number' }, nodeId: { type: 'string', description: 'start：从哪个视频节点对应的工程渲；apply：回填到哪个节点（省略时：主视频节点回填整片、另建的样片节点回填样片）' }, jobId: { type: 'string' },
      source: { type: 'string', enum: ['film', 'pilot'], description: 'apply 时回填哪一种：film=整片（主视频节点）、pilot=样片（样片节点）' },
      frames: { type: 'array', items: { type: 'number' }, description: '只渲染这些帧' },
      range: { type: 'array', items: { type: 'number' }, description: '帧区间 [from,to]：渲样片（写 pilot.mp4）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const scope = await motionScope(args, exec)
      if (args.action === 'list') {
        const listed = await loadDoc(scope.path, scope.sessionId, args.page)
        const listedNode = args.nodeId ? listed.doc.nodes.find(item => item.id === args.nodeId) : listed.doc.nodes.find(isMotionNode)
        const jobs = listedNode ? motionJobs.list(projectDirOf(listedNode, scope)) : []
        return { summary: '最近渲染任务', details: JSON.stringify(jobs.slice(0, 10)) }
      }
      const loaded = await loadDoc(scope.path, scope.sessionId, args.page)
      const node = args.nodeId ? loaded.doc.nodes.find((item) => item.id === args.nodeId) : loaded.doc.nodes.find(isMotionNode)
      if (!node) throw new Error('找不到视频节点')
      let dir = projectDirOf(node, scope)
      if (args.action === 'status') {
        const job = motionJobs.get(args.jobId)
        if (!job || job.dir !== dir) throw new Error('找不到当前工程的任务 ' + args.jobId)
        const mix = job.mix ? describeMix(job.mix) : (job.mixError ? '响度归一失败：' + job.mixError : '')
        const next = job.kind === 'pilot' && job.status === 'done'
          ? '样片文件不会自动显示在画布：在当前画布页创建或复用独立「样片」视频节点，记下其 ID，然后调用 motion_render {action:"apply",nodeId:"样片节点 ID",jobId:"' + job.id + '",source:"pilot"}；核对结果并告知用户。'
          : undefined
        return { summary: '渲染任务：' + job.status + (job.message ? ' · ' + job.message : '') + (mix ? ' · ' + mix : ''), details: JSON.stringify({ ...job, ...(next ? { next } : {}) }) }
      }
      if (args.action === 'cancel') {
        if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        const job = motionJobs.get(args.jobId)
        if (!job || job.dir !== dir) throw new Error('找不到当前工程的任务 ' + args.jobId)
        motionJobs.cancel(args.jobId); return { summary: '已请求取消', details: JSON.stringify({ jobId: args.jobId }) }
      }
      if (args.action === 'apply') {
        // 目标节点可能是个没建过工程的「样片」节点：工程目录得从**主视频节点**取。
        const targetId = args.nodeId || (args.jobId ? (motionJobs.get(args.jobId)?.nodeId || node.id) : node.id)
        const targetNode = loaded.doc.nodes.find((item) => item.id === targetId)
        const hasProject = (item) => typeof item?.data?.motion?.project === 'string' && !!item.data.motion.project
        const candidates = loaded.doc.nodes.filter(item => isMotionNode(item) && hasProject(item))
        let projectNode = hasProject(targetNode) ? targetNode : null
        if (!projectNode && args.jobId) {
          const matching = candidates.filter(item => {
            const candidateDir = projectDirOf(item, scope)
            return motionJobs.list(candidateDir).some(item => item.id === args.jobId && item.dir === candidateDir)
          })
          if (matching.length > 1) throw new Error('任务属于多个工程，请指定正确的源工程')
          projectNode = matching[0] || null
        }
        if (!projectNode && candidates.length === 1) projectNode = candidates[0]
        if (!projectNode && candidates.length > 1) throw new Error('画布有多个视频工程，回填样片时请提供对应的 jobId')
        projectNode ||= node
        dir = projectDirOf(projectNode, scope)
        const jobs = motionJobs.list(dir).filter((item) => item.kind === 'film' || item.kind === 'pilot')
        const finished = jobs.filter((item) => item.status === 'done' || item.output)
        let job = args.jobId ? (motionJobs.get(args.jobId) || jobs.find((item) => item.id === args.jobId)) : null
        if (args.jobId && (!job || job.dir !== dir)) throw new Error('找不到当前工程的任务 ' + args.jobId)
        if (job && job.kind === 'still') throw new Error('任务 ' + job.id + ' 是静帧预览（still），不能当片子回填')
        // 回填到哪个节点：**调用方说了算**（以前只要 job 带 nodeId 就忽略 args.nodeId，
        // 于是"把样片 apply 到另建的样片节点"永远写回主节点 —— 实测出过这个事故）。
        if (!job) {
          // 主视频节点（motion_project 建过工程）等的是成片；另建的「样片」节点等的是样片。
          // 以前两者都取"最新 done film"，而样片 range 渲染写的也是 film.mp4 —— 4 秒样片会被当成整片写进主节点。
          const sampleTarget = targetNode !== undefined && !hasProject(targetNode)
          const preferred = applyJobKind({ source: args.source, targetHasProject: !sampleTarget })
          job = finished.find((item) => item.kind === preferred)
          if (!job && preferred === 'pilot') {
            throw new Error('这个节点还没有样片：先 motion_render{action:"start", range:[起,止]}（样片渲成 .out/pilot.mp4，任务 kind=pilot）')
          }
          if (!job) job = finished.find((item) => item.kind === 'film') || finished.find((item) => item.kind === 'pilot')
        }
        if (!job) throw new Error('没有可回填的成片：先 motion_render start 出一版')
        const film = workspacePath(scope, job.output || outputPath(dir, job.kind === 'pilot' ? 'pilot.mp4' : 'film.mp4'))
        if (!existsSync(film)) throw new Error('成片文件不在了：' + film + '（重新 motion_render start）')
        if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        return documents.run(scope.drawioAbs, async () => {
          const live = await loadDoc(scope.path, scope.sessionId, args.page)
          const target = live.doc.nodes.find((item) => item.id === targetId)
          if (!target) throw new Error('要回填的节点已被删除（' + targetId + '）')
          const before = { data: JSON.parse(JSON.stringify(target.data)), style: target.style }
          const result = await applyFilm({ drawioAbs: scope.drawioAbs, doc: live.doc, node: target, film })
          target.data = { ...target.data, ...result.attrs }
          // 海报是 PNG data URI：按型别分派（以前一律当 SVG 包一层，节点上就是空图）。
          if (result.poster) target.style = styleWithMediaMarkup(target.style || '', result.poster, '0')
          if (!target.label) target.label = job.kind === 'pilot' ? '样片' : '成片'
          await writeMotionDocument(live, scope.sessionId, target.id, before)
          const seconds = result.seconds > 0 ? result.seconds.toFixed(2) : '?'
          return { summary: (job.kind === 'pilot' ? '样片' : '成片') + '已回填到节点 ' + target.id + '（' + result.width + '×' + result.height + ' · ' + seconds + 's · ' + (result.bytes / 1024 / 1024).toFixed(2) + 'MB）',
            details: JSON.stringify({ jobId: job.id, kind: job.kind, nodeId: target.id, clip: result.clip, dir: result.dir, source: result.source,
              width: result.width, height: result.height, fps: result.fps, seconds: result.seconds, frames: result.frames, bytes: result.bytes,
              next: '画布上点播放就能看；要再改就去改 scene-*.tsx 再渲染一次，apply 会覆盖同一个 clip' }) }
        })
      }
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      const renderFrames = jsonArray(args.frames)
      const renderRange = jsonArray(args.range)
      const operation = renderFrames.length ? 'still' : 'full'
      const ranged = renderRange.length === 2
      // 样片的输出必须跟整片分开：以前 range 渲染也写 film.mp4，下一次 apply 就会把 4 秒样片当整片塞进主节点。
      const kind = operation === 'still' ? 'still' : ranged ? 'pilot' : 'film'
      const outputName = kind === 'still' ? 'still.mp4' : kind === 'pilot' ? 'pilot.mp4' : 'film.mp4'
      // 缺素材时渲染会在「字体没注册」那里炸，说不清原因；先确保素材包，报错才说得明白。
      await ensureMotionAssets('渲染视频')
      // 引擎保真：样片和成片都要用风格上游那一套引擎，不许「简化实现」骗过静帧。
      const styleForGate = (() => {
        const saved = readTimeline(dir).style
        if (!saved) return null
        const entry = mgStyleCatalog.styles.find((item) => item.slug === saved.slug)
        return { ...saved,
          engine: saved.engine || entry?.engine || null,
          engines: saved.engines?.length ? saved.engines : (entry?.engines || []),
          engineNote: saved.engineNote || entry?.engineNote || '',
          engineFiles: saved.engineFiles?.length ? saved.engineFiles : (entry?.engineFiles || []) }
      })()
      const engineGate = kind === 'still' ? null : assertEngineFidelity(dir, styleForGate)
      // 质量证据门：字体没注册直接拒渲；后处理/累积缺席带 warning 一起报出来。
      const qualityGate = kind === 'still' ? null : assertQualityEvidence(dir, styleForGate)
      const gateWarnings = [engineGate?.warning, ...(qualityGate?.warnings || [])].filter(Boolean)
      const job = motionJobs.create({ kind, dir, nodeId: node.id })
      const handle = renderProject(dir, { operation, frames: renderFrames.length ? renderFrames : undefined, frameRange: ranged ? renderRange : undefined,
        output: outputPath(dir, outputName),
        onProgress: (message) => motionJobs.progress(job, message.phase, message.progress, message.message) })
      motionJobs.attach(job, handle)
      const renderLine = handle.render ? describeRenderSettings(handle.render) : ''
      return { summary: '已开始渲染' + (kind === 'pilot' ? '样片' : '') + '（' + job.id + '）' + (renderLine ? ' · ' + renderLine : '')
          + gateWarnings.map((warning) => ' ⚠ ' + warning).join('') + '，用 motion_render status 查进度',
        details: JSON.stringify({ jobId: job.id, kind, output: outputPath(dir, outputName),
          ...(handle.render ? { render: handle.render } : {}),
          ...(engineGate ? { engine: { required: engineGate.required, detected: engineGate.detected, missing: engineGate.missing, deviation: engineGate.deviation } } : {}),
          ...(qualityGate ? { quality: { fonts: qualityGate.fonts, warnings: qualityGate.warnings } } : {}),
          next: kind === 'pilot' ? '用主节点和 jobId 查 status；完成后在同一画布页创建或复用独立样片视频节点，再 motion_render {action:"apply",nodeId:"样片节点 ID",jobId:"' + job.id + '",source:"pilot"} 回填并告知用户。' : '渲完 apply 到主视频节点' }) }
    },
  })))

  // 帧检：把"片子有没有毛病"变成一张带帧号的清单，而不是靠眼睛。
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_qa',
    description: '成片帧检：不靠眼睛，靠像素和响度。inspect 立刻检一遍（默认检工程里的 .out/film.mp4，也可以指定 file）：帧数对不对、有没有黑场、有没有静止太久、有没有单帧闪烁、有没有空白帧、画面有没有顶到边、音轨有没有削波。report 读上次的结果。每条问题都带帧号和镜头号，能直接回去改对应场景。',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'report'], required: true },
      path: { type: 'string' }, nodeId: { type: 'string' }, page: { type: 'number' },
      file: { type: 'string', description: '要检的片子：绝对路径，或工程目录里的相对路径（默认 .out/film.mp4）' },
      freezeSeconds: { type: 'number', description: '静止多久算一笔记账，默认 1.2 秒' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const scope = await motionScope(args, exec)
      const loaded = await loadDoc(scope.path, scope.sessionId, args.page)
      const node = args.nodeId ? loaded.doc.nodes.find((item) => item.id === args.nodeId) : loaded.doc.nodes.find(isMotionNode)
      if (!node) throw new Error('找不到视频节点')
      const dir = projectDirOf(node, scope)
      if (!existsSync(dir)) throw new Error('工程还没建：先 motion_project create')
      if (args.action === 'report') {
        const saved = readQaReport(dir)
        if (!saved) throw new Error('还没有帧检结果：先用 motion_qa {action:"inspect"} 跑一遍')
        return { summary: '帧检 ' + saved.verdict + '（' + saved.summary.fail + ' fail / ' + saved.summary.warn + ' warn）',
          details: JSON.stringify(saved) }
      }
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      const film = args.file ? workspacePath(scope, isAbsolute(args.file) ? args.file : joinPath(dir, args.file)) : workspacePath(scope, outputPath(dir, 'film.mp4'))
      if (!existsSync(film)) throw new Error('没有可检的片子：' + film + '（先 motion_render start 出一版）')
      const timeline = readTimeline(dir)
      const report = await runFrameQa({ dir, file: film, timeline, options: { freezeSeconds: args.freezeSeconds } })
      const problems = report.checks.filter((check) => check.level === 'fail' || check.level === 'warn')
      const head = problems.length
        ? problems.slice(0, 4).map((check) => check.level + '：' + check.message).join('；')
        : '没发现问题'
      return { summary: '帧检 ' + report.verdict + '（' + report.frames + ' 帧 / ' + report.durationSeconds + 's）—— ' + head,
        details: JSON.stringify(report) }
    },
  })))

  // 剪映导出：把成片拆成"还能继续剪"的素材包。
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_export',
    description: '把工程导出成剪映可继续剪的素材包：逐镜头无声音轨 clips/、原音轨 audio/（BGM 与音效分开）、shots.json / audio.json / README.md，有字幕数据时再给 subtitles.srt，draft:true 另写一份 draft_content.json 草稿。run 导出，list 看导出过哪些。镜头按时间轴精确切（重编码，不靠关键帧），cut 点不会偏。',
    parameters: {
      action: { type: 'string', enum: ['run', 'list'], required: true },
      path: { type: 'string' }, nodeId: { type: 'string' }, page: { type: 'number' },
      name: { type: 'string', description: '导出目录名，默认 jianying' },
      draft: { type: 'boolean', description: '另写一份 draft_content.json（剪映草稿结构，未在剪映里实测过）' },
      subtitles: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: { startFrame: { type: 'number' }, endFrame: { type: 'number' }, text: { type: 'string' } },
        },
        description: '字幕数组 [{startFrame,endFrame,text}]；工程 timeline 里有 subtitles 就不用传',
      },
      file: { type: 'string', description: '当成片对照的 mp4，默认 .out/film.mp4' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const scope = await motionScope(args, exec)
      const loaded = await loadDoc(scope.path, scope.sessionId, args.page)
      const node = args.nodeId ? loaded.doc.nodes.find((item) => item.id === args.nodeId) : loaded.doc.nodes.find(isMotionNode)
      if (!node) throw new Error('找不到视频节点')
      const dir = projectDirOf(node, scope)
      if (!existsSync(dir)) throw new Error('工程还没建：先 motion_project create')
      if (args.action === 'list') {
        return { summary: '导出过的素材包', details: JSON.stringify(listExports(dir)) }
      }
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      const timeline = readTimeline(dir)
      const result = await exportPackage({ dir, timeline, name: args.name || 'jianying', draft: Boolean(args.draft),
        subtitles: jsonValue(args.subtitles), film: args.file ? workspacePath(scope, isAbsolute(args.file) ? args.file : joinPath(dir, args.file)) : undefined })
      return { summary: '已导出 ' + result.shots.length + ' 镜 / ' + result.stems.length + ' 条音轨到 ' + result.folder
        + (result.subtitles ? '（含字幕 ' + result.subtitles + ' 条）' : '')
        + (result.missing.length ? '，缺 ' + result.missing.length + ' 个音频文件' : ''),
        details: JSON.stringify(result) }
    },
  })))

  const motionProjectOf = async (args, exec) => {
    const scope = await motionScope(args, exec)
    const loaded = await loadDoc(scope.path, scope.sessionId, args.page)
    const node = loaded.doc.nodes.find((item) => item.id === args.nodeId)
    if (!node) throw new Error('找不到视频节点 ' + args.nodeId)
    return { scope, loaded, node, dir: projectDirOf(node, scope) }
  }
  const motionSourceFile = (args, scope, doc) => {
    if (typeof args.file === 'string' && args.file)
      return workspacePath(scope, isAbsolute(args.file) ? args.file : joinPath(dirnamePath(scope.drawioAbs), args.file))
    const node = doc.nodes.find((item) => item.id === args.sourceNodeId)
    if (!node) throw new Error('请给 file（工作区里的图片路径）或 sourceNodeId（画布上的素材节点）')
    if (!node.data?.drawaiMedia || node.data.mediaKind !== 'raster') throw new Error('这个节点不是位图素材')
    const clipDir = clipDirFor(scope.drawioAbs, node.data.mediaClip)
    const found = findSourceFile(clipDir, readManifest(clipDir))
    if (!found) throw new Error('这个素材节点没有源文件，请重新导入')
    return workspacePath(scope, found.abs)
  }

  //   motion_assets   真素材进工程（原字节 + 尺寸 + 色板），场景用 staticFile 取
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_assets',
    description: '视频工程素材：list 查看工程素材；library 按 query（如 纸张、颗粒、钢琴）或 category 搜索插件自带纹理及乐器采样；use 用 assetId 按需导入，返回 file，图片用 staticFile(file)，音频须另用 motion_audio add 上时间轴。素材库是可选来源，用户自带素材优先，采样是单音而非完整配乐；使用前查看许可。gather 按站点收集品牌素材、配色与字体，collect 扫单页；capture 收本地素材；fetch 下载原图；crop 裁切；page 截网页；palette 读色板。',
    parameters: {
      action: { type: 'string', enum: ['list', 'library', 'use', 'capture', 'gather', 'collect', 'fetch', 'crop', 'palette', 'page'], required: true, description: 'library 浏览插件自带纹理与乐器采样；use 按 assetId 将选定素材导入工程；list 查看工程内素材' },
      path: { type: 'string', description: '画布路径，省略时用当前画布' }, nodeId: { type: 'string', required: true, description: '视频节点 id（决定哪个工程）' },
      page: { type: 'number' },
      file: { type: 'string', description: '工作区里的图片路径（相对画布目录）' },
      sourceNodeId: { type: 'string', description: '画布上的位图素材节点 id（与 file 二选一）' },
      name: { type: 'string', description: '落地文件名（不含扩展名）' },
      caption: { type: 'string', description: '这条素材是什么，写进 manifest 供后续参考' },
      assetId: { type: 'string', description: 'use：从 library 返回结果中选择的素材 id' },
      query: { type: 'string', description: 'library：按文件名或中英文类别筛选' },
      category: { type: 'string', description: 'library：精确类别（如 piano、paper、audio、image）' },
      x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number', description: 'crop 的区域（像素）' },
      html: { type: 'string', description: 'page：直接给 HTML 源文本（推荐，里面就是待截的界面）' },
      url: { type: 'string', description: 'gather：站点首页网址（会顺带扫导航里的内页）；collect：要收集素材的页面网址（http(s)）；fetch：要下载的素材地址（官方 logo 的 .svg/.png 直链）；page：要截的网址，http(s) 或 file:' },
      urls: { type: 'array', items: { type: 'string' }, description: 'gather：直接指定要扫的多个页面（产品页/文档页/定价页各一张，最多 6 页）' },
      brand: { type: 'string', description: 'gather：品牌名或域名（如 "github" / "github.com"），用来补 Simple Icons / Clearbit / 高清 favicon 三条 logo 来源' },
      pages: { type: 'number', description: 'gather：最多扫几个页面，默认 4（上限 6）' },
      limit: { type: 'number', description: 'gather 默认 12、collect 默认 8：最多下载几张' },
      minWidth: { type: 'number', description: '候选图片的最小宽度，默认 240' },
      dryRun: { type: 'boolean', description: 'gather/collect：只扫描不下载，先看候选清单' },
      width: { type: 'number', description: 'page：视口宽，默认 1440' },
      height: { type: 'number', description: 'page：视口高，默认 900' },
      scale: { type: 'number', description: 'page：像素比，默认 2（截出来是 2 倍图）' },
      wait: { type: 'number', description: 'page：等页面稳定的毫秒数，默认 1200' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const { scope, loaded, dir } = await motionProjectOf(args, exec)
      if (args.action === 'list')
        return { summary: '工程素材 ' + listAssets(dir).length + ' 个', details: JSON.stringify(listAssets(dir).map(({ path: _path, ...rest }) => rest)) }
      if (args.action === 'library') {
        await ensureMotionAssets('查插件素材库')
        const items = listMediaLibrary({ query: args.query, category: args.category })
        return { summary: '插件素材库 ' + items.length + ' 个', details: JSON.stringify(items) }
      }
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      if (args.action === 'use') {
        await ensureMotionAssets('导入插件素材')
        const entry = await importMediaLibrary(dir, args.assetId)
        return { summary: '已导入插件素材 ' + entry.file + (entry.integrity?.warnings?.length ? '（素材校验有提示，详见返回信息）' : ''), details: JSON.stringify({ ...entry,
          use: entry.kind === 'audio' ? 'motion_audio ' + JSON.stringify({ action: 'add', nodeId: args.nodeId, file: entry.file, role: 'sfx', at: 0 }) : 'staticFile(' + JSON.stringify(entry.file) + ')' }) }
      }
      if (args.action === 'page') {
        if (typeof args.url === 'string' && /^file:/i.test(args.url)) workspacePath(scope, fileURLToPath(args.url))
        const entry = await capturePage(dir, { html: args.html, url: args.url, name: args.name, caption: args.caption,
          width: args.width, height: args.height, scale: args.scale, wait: args.wait })
        return { summary: '已截屏 ' + entry.file + '（' + entry.width + '×' + entry.height + '）',
          details: JSON.stringify({ ...entry, use: 'staticFile("' + entry.file + '")', next: '场景里 <Img src={staticFile("' + entry.file + '")} />；截歪了就调 width/height/scale 再截一次' }) }
      }
      if (args.action === 'gather') {
        const gathered = await gatherAssets(dir, { url: args.url, urls: args.urls, brand: args.brand, pages: args.pages,
          limit: args.limit, minWidth: args.minWidth, width: args.width, dryRun: args.dryRun })
        const count = gathered.dryRun ? (gathered.candidates || []).length : (gathered.downloaded || []).length
        return { summary: (gathered.dryRun ? '扫到 ' : '已收集 ') + count + (gathered.dryRun ? ' 个候选' : ' 张素材')
            + ' · ' + (gathered.pages || []).length + ' 页 · 配色 ' + (gathered.colors || []).length + ' 个 · 字体 ' + (gathered.fonts || []).length + ' 个',
          details: JSON.stringify(gathered) }
      }
      if (args.action === 'collect') {
        if (!args.url) throw new Error('collect 需要 url')
        const collected = await collectPageAssets(dir, args.url, { limit: args.limit, minWidth: args.minWidth, width: args.width, dryRun: args.dryRun })
        return { summary: (collected.dryRun ? '扫描到 ' : '已收集 ') + (collected.downloaded || collected.candidates || []).length
            + (collected.dryRun ? ' 个候选' : ' 张素材') + (collected.screenshot ? ' + 视口截图' : '') + '：' + String(collected.title || args.url).slice(0, 60),
          details: JSON.stringify(collected) }
      }
      if (args.action === 'fetch') {
        if (!args.url) throw new Error('fetch 需要 url')
        const entry = await fetchAsset(dir, args.url, { name: args.name, caption: args.caption })
        return { summary: '已下载素材 ' + entry.file + (entry.kind === 'vector' ? '（矢量）' : ''),
          details: JSON.stringify({ ...entry, use: 'staticFile("' + entry.file + '")',
            next: entry.kind === 'vector'
              ? '矢量素材放进 <Img src={staticFile("' + entry.file + '")} /> 即可，放大不糊；比例、配色、留白按品牌规范来，别改'
              : '场景里 <Img src={staticFile("' + entry.file + '")} />；改完 motion_preview 看图' }) }
      }
      const source = motionSourceFile(args, scope, loaded.doc)
      if (args.action === 'palette') {
        const colors = await colorsOf(source)
        return { summary: '色板：' + (colors.average || '未知'), details: JSON.stringify({ file: source, ...colors }) }
      }
      if (args.action === 'crop') {
        const entry = await cropAsset(dir, source, { name: args.name, caption: args.caption, x: args.x, y: args.y, w: args.w, h: args.h })
        return { summary: '已裁切素材 ' + entry.file, details: JSON.stringify({ ...entry, use: 'staticFile("' + entry.file + '")' }) }
      }
      const entry = await captureAsset(dir, source, { name: args.name, caption: args.caption })
      return { summary: '已捕获素材 ' + entry.file + '（' + entry.width + '×' + entry.height + '）',
        details: JSON.stringify({ ...entry, use: 'staticFile("' + entry.file + '")', next: '场景里 import { staticFile } from "remotion"，再用 staticFile 引用；改完 motion_preview 看图' }) }
    },
  })))

  //   motion_sfx      音效采购：Freesound 搜索/下载与素材索引
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_sfx',
    description: '音效采购（Freesound）。search 按英文关键词搜，返回时长与作者；get 按 id 下载 HQ mp3 预览到 <工程>/assets/sfx/，量峰值与有效区间，维护一份 assets/audio-manifest.json；list 看已下载的音效。下载完用 motion_audio {action:"add", file:"sfx/xxx.mp3", role:"sfx"} 挂到轴上。',
    parameters: {
      action: { type: 'string', enum: ['search', 'get', 'list'], required: true },
      path: { type: 'string' }, nodeId: { type: 'string', required: true, description: '视频节点 id' },
      page: { type: 'number' },
      query: { type: 'string', description: 'search：英文查询词，短而具体更好（"paper whoosh"、"ui click"）' },
      minDuration: { type: 'number', description: 'search：最短秒数，默认 0' },
      maxDuration: { type: 'number', description: 'search：最长秒数' },
      limit: { type: 'number', description: 'search：最多返回几条，默认 8' },
      ids: { type: 'array', items: { type: 'string' }, description: 'get：音效 id 数组，例如 ["fs:12345"]' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const { scope, dir } = await motionProjectOf(args, exec)
      if (args.action === 'list') {
        const items = listSfx(dir)
        return { summary: '工程里已有 ' + items.length + ' 条音效', details: JSON.stringify(items) }
      }
      if (args.action === 'search') {
        const found = await searchSfx({ query: args.query, minDuration: args.minDuration, maxDuration: args.maxDuration, limit: args.limit })
        return { summary: '找到 ' + found.results.length + ' 条',
          details: JSON.stringify({ ...found, next: '挑一条再 motion_sfx {action:"get", ids:["fs:xxxx"]}；想先听可以按 pageUrl 打开' }) }
      }
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      const result = await getSfx(dir, jsonArray(args.ids))
      const ok = result.results.filter((item) => item.ok)
      const bad = result.results.filter((item) => !item.ok)
      return { summary: '下载 ' + ok.length + ' 条' + (bad.length ? '，失败 ' + bad.length + ' 条' : ''),
        details: JSON.stringify({
          ok: ok.map((item) => ({ id: item.asset.id, file: item.asset.file, title: item.asset.title, license: item.asset.license,
            seconds: item.asset.analysis.seconds, peakDb: item.asset.analysis.peakDb, rmsDb: item.asset.analysis.rmsDb,
            suggestedGainDb: item.asset.analysis.suggestedGainDb,
            use: 'motion_audio {action:"add", file:"' + item.asset.file + '", role:"sfx", gainDb:' + item.asset.analysis.suggestedGainDb + '}' })),
          failed: bad,
        }) }
    },
  })))

  //   motion_audio    音频轴：加/删/列音轨，量节拍，把切镜和目标音钉到拍子上
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_audio',
    description: '音频轴工具。list 列出时间轴上的音轨；add 把一条音频放到指定秒（默认写进 <工程>/assets/，素材没进工程会自动捕获）；remove 按 cueId 删；analyze 量 BPM/网格/重音（返回 bpm、grid 残差、hits 三分类、peakLag）；apply 写 beats.json 并把切点吸到拍子上，给 cueId 时改把这条音轨钉到拍子（自动扣掉音源峰值滞后与输出偏移）。bpm 为 null 说明量不出稳定网格——不要硬对。',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'analyze', 'apply'], required: true },
      path: { type: 'string' }, nodeId: { type: 'string', required: true, description: '视频节点 id' },
      page: { type: 'number' },
      file: { type: 'string', description: '音频文件（绝对路径，或相对画布目录）；也可以直接写 <工程>/assets/ 下的文件名' },
      audioNodeId: { type: 'string', description: '画布上的音频节点 id（与 file 二选一）' },
      at: { type: 'number', description: 'add：放到第几秒（默认 0）' },
      duration: { type: 'number', description: 'add：播放多少秒（默认取素材时长）' },
      role: { type: 'string', enum: ['bgm', 'voice', 'sfx'], description: 'add：音轨角色，默认 sfx' },
      gainDb: { type: 'number', description: 'add：增益 dB（bgm 默认 -10）' },
      fadeIn: { type: 'number', description: 'add：淡入秒数' },
      fadeOut: { type: 'number', description: 'add：淡出秒数' },
      loop: { type: 'boolean', description: 'add：循环' },
      duck: { type: 'boolean', description: 'add：旁白区间自动压低（bgm 默认 true）' },
      cueId: { type: 'string', description: 'apply：把这条音轨钉到最近的拍子' },
      snap: { type: 'boolean', description: 'apply 时是否改时间轴，默认 true' },
      tolerance: { type: 'number', description: '吸附容差（帧），默认 4' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const { scope, loaded, dir } = await motionProjectOf(args, exec)
      const timeline = readTimeline(dir)
      const fps = timeline.fps

      if (timeline.sync && args.action === 'apply') throw new Error('该工程已统一绑定，请通过 motion_sync bind 更新，避免旧吸附流程覆盖锚点')
      if (args.action === 'list') {
        const cues = readTrack(timeline)
        return { summary: cues.length ? '音频轨 ' + cues.length + ' 条' : '时间轴上还没有音频', details: describeTrack(cues, fps) }
      }

      if (args.action === 'add') {
        if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        let name = ''
        if (typeof args.file === 'string' && args.file) {
          const candidate = isAbsolute(args.file) ? args.file : joinPath(dirnamePath(scope.drawioAbs), args.file)
          if (existsSync(candidate)) {
            const entry = await captureAsset(dir, workspacePath(scope, candidate), { caption: args.file })
            name = entry.file
          } else name = args.file.replace(/\\/g, '/')
        } else {
          const audioNode = loaded.doc.nodes.find((item) => item.id === args.audioNodeId)
          if (!audioNode?.data?.audioClip) throw new Error('请给 file（音频文件），或 audioNodeId 指向一个已用 audio_asset 导入的音频节点')
          const entry = await captureAsset(dir, frozenAudioFile(scope.drawioAbs, audioNode.data.audioClip).file, { caption: 'audio node ' + audioNode.id })
          name = entry.file
        }
        const assetFile = workspacePath(scope, assetPath(dir, name))
        if (!existsSync(assetFile)) throw new Error('工程 assets/ 里没有这个音频：' + name)
        const probe = await probeAudio(assetFile)
        const seconds = Number(args.duration) || probe.seconds
        const at = Math.max(0, Number(args.at) || 0)
        const fromFrame = Math.round(at * fps)
        const role = args.role || 'sfx'
        // 增益的口径：显式给的最优先；没给就吃 motion_sfx get 量出来的建议值；再没有才用角色默认。
        const gain = resolveGainDb({ explicitGain: args.gainDb, manifestGain: suggestedGainOf(readAudioManifest(dir), name), role, peakDb: probe.samplePeakDb })
        const level = cueLevel({ peakDb: probe.samplePeakDb, gainDb: gain.gainDb })
        const span = Math.round(seconds * fps)
        const overlaps = readTrack(timeline).filter((item) => item.from < fromFrame + span && item.from + item.durationInFrames > fromFrame).length
        const next = addCue(timeline, {
          file: name, role, from: fromFrame,
          durationInFrames: span, gainDb: gain.gainDb,
          fadeIn: Math.round((Number(args.fadeIn) || 0) * fps), fadeOut: Math.round((Number(args.fadeOut) || 0) * fps),
          loop: args.loop, duck: args.duck,
        })
        writeTimeline(dir, next)
        const cues = readTrack(next)
        const cue = cues.find((item) => item.file === name && item.role === (args.role || 'sfx') && item.from === fromFrame) || cues[cues.length - 1]
        const copies = cues.filter((item) => item.file === name).length
        return { summary: '已加音轨 ' + name + ' @ ' + at.toFixed(2) + 's（' + seconds.toFixed(2) + 's），' + cue.gainDb + 'dB'
          + (copies > 1 ? '，这个文件在轴上有 ' + copies + ' 条' : ''),
          details: describeLevel({ cue, gain, level, overlaps }) + '\n' + JSON.stringify({ cue, track: cues, fps }) }
      }

      if (args.action === 'remove') {
        if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
        const next = removeCue(timeline, args.cueId)
        writeTimeline(dir, next)
        return { summary: '已删除音轨 ' + args.cueId, details: describeTrack(readTrack(next), fps) }
      }

      let file
      if (typeof args.file === 'string' && args.file) file = workspacePath(scope, isAbsolute(args.file) ? args.file : joinPath(dirnamePath(scope.drawioAbs), args.file))
      else {
        const audioNode = loaded.doc.nodes.find((item) => item.id === args.audioNodeId)
        if (!audioNode?.data?.audioClip) throw new Error('请给 file（音频文件路径），或 audioNodeId 指向一个已用 audio_asset 导入的音频节点')
        file = frozenAudioFile(scope.drawioAbs, audioNode.data.audioClip).file
      }
      const beats = await analyzeBeats(file)
      const beatFrames = beats.beats.map((beat) => Math.round(beat.at * fps))
      const peakLagFrames = Math.round((beats.peakLag || 0) * fps)
      if (args.action === 'analyze')
        return { summary: beats.grid
            ? '约 ' + beats.bpm + ' BPM，网格残差 ' + beats.grid.residualMs + 'ms，' + beats.beats.length + ' 个重音'
            : (beats.bpm ? '约 ' + beats.bpm + ' BPM 但没拟合出稳定网格（' + (beats.note || '重音不在等距网格上') + '）' : '没量到稳定节拍'),
          details: JSON.stringify({ file, ...beats, fps, beatFrames, peakLagFrames }) }
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      writeFileSync(joinPath(dir, 'beats.json'), JSON.stringify({ ...beats, fps, beatFrames, peakLagFrames }, null, 2))
      const moved = []
      const pinned = []
      if (args.cueId) {
        const cue = readTrack(timeline).find((item) => item.id === args.cueId)
        if (!cue) throw new Error('没有这条音轨：' + args.cueId)
        const target = snapFrame(cue.from, beats.beats.map((beat) => ({ at: beat.at, strength: beat.strength })), fps, Number(args.tolerance) || 4)
        const pinnedFrom = cuePinnedAt(target, peakLagFrames)
        if (pinnedFrom !== cue.from) pinned.push({ cue: cue.id, from: cue.from, to: pinnedFrom, target, peakLagFrames })
        timeline.audio = readTrack(timeline).map((item) => item.id === cue.id ? { ...item, from: pinnedFrom } : item)
      }
      if (args.snap !== false && beats.beats.length) {
        const tolerance = Number(args.tolerance) || 4
        let previous = 0
        for (let index = 1; index < timeline.shots.length; index++) {
          const shot = timeline.shots[index]
          const limit = timeline.durationInFrames - (timeline.shots.length - index) * 6
          const target = Math.max(previous + 6, Math.min(limit, snapFrame(shot.startFrame, beats.beats, fps, tolerance)))
          if (target !== shot.startFrame) moved.push({ shot: shot.id, from: shot.startFrame, to: target })
          previous = target
          shot.startFrame = target
        }
        for (let index = 0; index < timeline.shots.length; index++) {
          const end = index + 1 < timeline.shots.length ? timeline.shots[index + 1].startFrame : timeline.durationInFrames
          timeline.shots[index].durationFrames = end - timeline.shots[index].startFrame
        }
      }
      if (moved.length || pinned.length) writeTimeline(dir, timeline)
      return { summary: '已写入 beats.json' + (moved.length ? '，' + moved.length + ' 个切点吸到拍子上' : '') + (pinned.length ? '，音轨钉到第 ' + pinned[0].target + ' 帧' : ''),
        details: JSON.stringify({ bpm: beats.bpm, grid: beats.grid, confidence: beats.confidence, beats: beats.beats.length, moved, pinned, timeline: moved.length || pinned.length ? timeline : undefined }) }
    },
  })))

  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_sync',
    description: '音乐拍点→切镜/动作→音效峰值统一绑定。bind 替换绑定表并分析音乐；list 查看解析结果；clear 解除绑定、保留当前排期。anchors:[{id,type:"cut"|"action",shotId,beat?:0起拍号,at?:源音乐秒,name?:动作名,visual?:{metric:"change"|"brightness",roi:{x,y,w,h}},sfx?:[{cueId,peakSeconds:素材源峰值秒}]}]。beat/at 二选一；动作场景接收 anchors，使用 anchors.<name> 本镜局部帧写关键帧。动作验收要选 ROI/metric，切镜默认测帧差。绑定后 motion_audio_verify 对照成片。音乐需要非循环音轨，音乐 from/trimStart 参与换算。',
    parameters: {
      action: {type:'string',enum:['bind','list','clear'],required:true},
      nodeId: {type:'string',required:true}, path:{type:'string'},page:{type:'number'},
      musicCueId:{type:'string'},
      anchors:{
        type:'array',
        items:{
          type:'object',
          additionalProperties:true,
          properties:{
            id:{type:'string'},
            type:{type:'string',enum:['cut','action']},
            shotId:{type:'string'},
            beat:{type:'number'},
            at:{type:'number'},
            name:{type:'string'},
            visual:{
              type:'object',
              additionalProperties:true,
              properties:{
                metric:{type:'string',enum:['change','brightness']},
                roi:{type:'object',additionalProperties:false,properties:{x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'}}},
              },
            },
            sfx:{type:'array',items:{type:'object',additionalProperties:true,properties:{cueId:{type:'string'},peakSeconds:{type:'number'}}}},
          },
        },
      },
      outputOffsetSeconds:{type:'number',description:'具体渲染管线实测音轨延迟（秒），默认0；验收报告给出多点测得的偏移参考'},
      toleranceFrames:{type:'number',description:'音画及音效误差容差，默认2帧，最大3帧'},
    },
    output: {schema:{type:'object',additionalProperties:false,properties:{summary:{type:'string',required:true},details:{type:'string',required:true}}},
      render:(_args,value)=>[{type:'text',text:value.summary+'\n'+value.details}]},
    async execute(args, exec) {
      const {scope,dir}=await motionProjectOf(args,exec)
      let timeline=readTimeline(dir)
      if(args.action==='list') return {summary:'音乐同步绑定',details:JSON.stringify(timeline.sync||null)}
      if(policyFor(scope.sessionId)?.mode==='read-only')throw new Error('当前会话为只读')
      if(args.action==='clear') {
        delete timeline.sync
        for(const shot of timeline.shots)delete shot.anchors
      } else {
        const cue=timeline.audio.find(item=>item.id===args.musicCueId)
        if(!cue)throw new Error('musicCueId 不存在；先 motion_audio add/list')
        const analysis=await analyzeBeats(assetPath(dir,cue.file))
        const tolerance=args.toleranceFrames??2
        if(!Number.isFinite(tolerance)||tolerance<0||tolerance>3)throw new Error('toleranceFrames 必须在0–3内')
        timeline.sync={version:1,musicCueId:cue.id,analysis,analysisSourceHash:filmHash(assetPath(dir,cue.file)),anchors:jsonArray(args.anchors),outputOffsetSeconds:args.outputOffsetSeconds??0,toleranceFrames:tolerance}
        timeline=resolveSync(timeline)
      }
      writeTimeline(dir,timeline)
      return {summary:args.action==='clear'?'已解除音乐绑定':'已绑定音乐、画面与音效；场景用 anchors.<name> 驱动动作关键帧',details:JSON.stringify(timeline.sync||{})}
    },
  })))

  //   motion_audio verify    渲后回测：成片里的声音到底偏了多少帧
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_audio_verify',
    description: '音画对照验收：按 motion_sync 锚点，从成片匹配源音乐和音效波形、测切镜或动作ROI的实际变化帧，逐项报告音画及音效误差。无证据标 unverified，超容差 fail。报告写入 .out/qa/sync/report.json。',
    parameters: {
      path: { type: 'string' }, nodeId: { type: 'string', required: true, description: '视频节点 id' },
      page: { type: 'number' },

    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const { scope, dir } = await motionProjectOf(args, exec)
      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('当前会话为只读')
      const timeline = readTimeline(dir)
      const jobs = motionJobs.list(dir).filter((job) => job.kind === 'film' && job.status === 'done')
      const film = jobs.sort((a, b) => String(b.endedAt || b.createdAt).localeCompare(String(a.endedAt || a.createdAt)))[0]
      if (!film) throw new Error('还没有渲染完成的成片，先 motion_render start')
      const output = film.output || outputPath(dir, 'film.mp4')
      if (!existsSync(output)) throw new Error('成片文件不见了：' + output)
      const report = await verifySync(dir, output, timeline)
      return { summary: '成片音画对照：' + report.status + '（' + report.rows.length + ' 个锚点）',
        details: JSON.stringify(report) }
    },
  })))

  //   motion_voice           旁白：脚本 → 估时长 → 重排镜头 → 合成 → 字幕
  //
  //     为什么时长由旁白说了算：旁白是"内容的长度"，画面是"内容的形状"。
  //     先按字速估、合成后用真实时长再重排一次，镜头跟着句子走 —— 反过来做
  //     （先定死镜头再塞旁白）只能靠变速或砍句，两个都难看。
  ctx.effect(() => registerHostTool(defineTool({
    name: 'motion_voice',
    description: '旁白（TTS）：把 voice.script.md（## shot-N 分节、一句一行）变成 voice 音轨 + 字幕，并让镜头时长跟着句子走。action=list 看现状/音色；plan 只估算与重排（不合成，先看排期是否合理）；say 真合成（edge-tts，拿不到就退 SAPI）+ 用真实时长重排；align 已有音频只按真实时长重排。合成结果按台词哈希缓存，改一句只重合成一句。字幕写进 timeline.subtitles，导出 SRT / 剪映字幕轨零改动。',
    parameters: {
      path: { type: 'string' }, nodeId: { type: 'string', required: true, description: '视频节点 id' },
      page: { type: 'number' },
      action: { type: 'string', required: true, description: 'list | plan | say | align' },
      script: { type: 'string', description: '脚本正文（以 # 开头）或文件路径；默认 <工程>/voice.script.md' },
      voice: { type: 'string', description: '音色，默认 zh-CN-XiaoxiaoNeural（list 看全部）' },
      rate: { type: 'string', description: '语速，默认 +0%（+8% 更紧凑）' },
      pitch: { type: 'string', description: '音高，默认 +0Hz' },
      cps: { type: 'number', description: '估算用的字/秒，中文默认 4.8' },
      fit: { type: 'string', description: 'grow（默认，镜头只增不减）| exact（按旁白收紧）| none（不动时长）' },
      gainDb: { type: 'number', description: '旁白增益，默认 0（BGM 侧有 duck 让路）' },
      force: { type: 'boolean', description: '忽略缓存重新合成' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true }, details: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary + '\n' + value.details }] },
    async execute(args, exec) {
      const { scope, dir } = await motionProjectOf(args, exec)
      const action = String(args.action || 'list')
      const timeline = readTimeline(dir)
      const fps = Number(timeline.fps) || 30

      if (action === 'list') {
        const cues = (Array.isArray(timeline.audio) ? timeline.audio : []).filter((cue) => cue && cue.role === 'voice')
        const rows = cues.map((cue) => '- ' + (cue.from / fps).toFixed(2) + 's · ' + (cue.durationInFrames / fps).toFixed(2) + 's · ' + cue.file)
        const subtitles = Array.isArray(timeline.subtitles) ? timeline.subtitles.length : 0
        const hasEdge = await edgeAvailable()
        return {
          summary: '旁白：' + cues.length + ' 条音轨 / ' + subtitles + ' 条字幕 · 合成器 ' + (hasEdge ? 'edge-tts 可用' : 'edge 不可用（会退回 SAPI）'),
          details: [
            rows.length ? rows.join('\n') : '（还没有旁白：先写 ' + joinPath(dir, 'voice.script.md') + '，再 motion_voice action=plan）',
            '',
            '音色（' + VOICE_DEFAULTS.voice + ' 是默认）：',
            ...VOICE_CHOICES.map((item) => '- ' + item.name + ' · ' + item.gender + ' · ' + item.tags + ' — ' + item.note),
            '',
            '脚本格式：## shot-1 一节，一句一行；> 开头的行当备注。',
          ].join('\n'),
        }
      }

      if (policyFor(scope.sessionId)?.mode === 'read-only') throw new Error('这条画布是只读的，改不了旁白')

      if (typeof args.script === 'string' && args.script.trim() && !args.script.trim().startsWith('#'))
        workspacePath(scope, isAbsolute(args.script) ? args.script : joinPath(dir, args.script.trim()))
      const { markdown, source } = readScript(dir, args.script)
      const script = parseScript(markdown)
      if (!script.length) throw new Error('脚本里没解析出句子：需要 ## shot-1 这样的分节 + 一句一行')
      const options = { voice: args.voice || VOICE_DEFAULTS.voice, rate: args.rate || VOICE_DEFAULTS.rate, pitch: args.pitch || VOICE_DEFAULTS.pitch, cps: Number(args.cps) || VOICE_DEFAULTS.cps, fit: args.fit || 'grow', gainDb: Number.isFinite(Number(args.gainDb)) ? Number(args.gainDb) : VOICE_DEFAULTS.gainDb, force: args.force === true }

      let planned
      if (action === 'plan') planned = planNarration(timeline, script, options)
      else if (action === 'say') planned = await sayNarration(dir, timeline, script, options)
      else if (action === 'align') planned = await alignNarration(dir, timeline, script, options)
      else throw new Error('action 只能是 list / plan / say / align')

      const next = planned.timeline
      writeTimeline(dir, next)
      const checks = checkNarration(next, planned.lines)
      const before = timeline.durationInFrames / fps
      const after = next.durationInFrames / fps
      const grew = next.shots.filter((shot, index) => shot.durationFrames !== timeline.shots[index].durationFrames).length
      const speech = totalSpeechSeconds(planned.lines, fps)
      return {
        summary: '旁白 ' + planned.lines.length + ' 句 / ' + speech.toFixed(1) + 's · 片长 ' + before.toFixed(1) + 's → ' + after.toFixed(1) + 's'
          + (grew ? '（' + grew + ' 镜被重排）' : '（时长没变）') + ' · 检查 ' + checks.verdict,
        details: [
          '脚本：' + source + ' · 音色 ' + options.voice + ' · 语速 ' + options.rate + ' · 模式 ' + options.fit,
          action === 'say' ? '已合成 ' + planned.lines.filter((line) => line.measured).length + ' 句（命中的走缓存，不重复调网）' : '',
          '',
          describeNarration(planned.lines, next.shots, fps),
          '',
          '检查：',
          ...checks.checks.map((check) => '- [' + check.level + '] ' + check.message),
        ].filter(Boolean).join('\n'),
      }
    },
  })))

  ctx.effect(() => registerHostTool({ ...applyTool, execute: async (args, exec) => {
    const sessionId = sessionIdOf(exec)
    const path = typeof args.path === 'string' && args.path ? args.path : focusedPathFor(sessionId) || DEFAULT_PATH
    const target = await resolveTarget(path, sessionId)
    return documents.run(absoluteHint(target, path), async () => {
      const current = await resolveTarget(path, sessionId)
      return documents.run(absoluteHint(current, path), () => applyTool.execute(args, exec))
    })
  } }))

  // 注册段收尾：一行汇总（成功几个、失败哪几个）。远端出问题时先看这条，
  // 再看 DIAGNOSTICS_PATH 的 JSON —— 两者对不上就说明注册完又被回收了。
  reportToolRegistrations()

  // 把"怎么用这张画布"注册成**内嵌技能**（见 SKILL_DEFINITIONS 的注释）：
  // 换了电脑、只装了插件（没有源码/README/tools）时，模型依然知道该怎么操作。
  //
  // `skills` 是**可选**依赖：没装 skill 注册表的部署里照样能用（工具描述本身已经够启动），
  // 所以走 ctx.get 而不是写进 inject —— 缺它不该让整个插件停在等待态。
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills !== undefined && skills !== null && typeof skills.register === 'function') {
    ctx.effect(() => {
      const disposers = SKILL_DEFINITIONS.map((definition) =>
        skills.register({
          name: definition.name,
          description: definition.description,
          whenToUse: definition.whenToUse,
          // `source: 'runtime'` 不能省：注册时只校验 name/description/invocation，
          // 但**取全文**时注册表会再跑一次 validateDefinition，那里要求 source 是字符串
          // （少了它，目录里看得见、一 load 就抛 "source must be a string"）。
          source: 'runtime',
          content: definition.content,
        }),
      )
      // 两条注册各返回一个 disposer；合成一个交回 Cordis，卸载时一并撤掉。
      return () => {
        for (const dispose of disposers) if (typeof dispose === 'function') dispose()
      }
    })
  }
}
