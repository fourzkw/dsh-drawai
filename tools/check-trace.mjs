// tools/check-trace.mjs —— 逐像素矢量化的自测（npm test 会跑）。
//
// 覆盖三件事：
//   1. PNG 解码器与 sharp **逐字节一致**（有 sharp 才比；没有就只验自洽）
//   2. 管线的不变量：每色轮廓面积之和 == 图像总像素（格边轮廓下必须精确相等）
//   3. diagram_apply 的 traceImage op 端到端能跑：真的读像素、写出 svg 内容节点
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { decodeRaster, decodePng, looksLikeRaster } from '../src/raster.js'
import { TRACE_DEFAULTS, TRACE_PRESET_NAMES, svgToImageValue, traceRasterToSvg } from '../src/trace-image.js'
import * as plugin from '../lib/index.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log('  ✓ ' + label + (detail === undefined ? '' : '  ' + detail))
  else {
    failures += 1
    console.log('  ✗ ' + label + (detail === undefined ? '' : '  ' + detail))
  }
}

const SAMPLE = '.vectorize/input.png'
const hasSample = existsSync(SAMPLE)

console.log('check-trace: 位图解码')
if (!hasSample) {
  console.log('  – 跳过（.vectorize/input.png 不在；这个目录是本地验证素材，不入库）')
} else {
  const bytes = readFileSync(SAMPLE)
  check('looksLikeRaster 认得出 PNG', looksLikeRaster(bytes) === true)
  const mine = decodePng(bytes)
  check('解码尺寸', mine.width > 0 && mine.height > 0, mine.width + '×' + mine.height)
  check('输出是 RGBA8', mine.data.length === mine.width * mine.height * 4)

  // 与 sharp 对照（sharp 是可选依赖：装了才比，没装不算失败）
  let sharp = null
  for (const spec of ['sharp', 'C:/Users/86476/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp']) {
    try {
      sharp = createRequire(import.meta.url)(spec)
      break
    } catch (error) {
      sharp = null
    }
  }
  if (sharp === null) {
    console.log('  – 跳过 sharp 对照（没装 sharp）')
  } else {
    const ref = await sharp(SAMPLE).ensureAlpha().raw().toBuffer()
    let diff = 0
    for (let i = 0; i < mine.data.length; i += 1) if (mine.data[i] !== ref[i]) diff += 1
    check('与 sharp 逐字节一致', diff === 0, diff === 0 ? '' : diff + ' 字节不同')
  }

  console.log('check-trace: 矢量化不变量')
  const raster = await decodeRaster(bytes)
  const out = traceRasterToSvg(raster, { epsilon: 2.5 })
  const m = out.metrics
  check('像素覆盖精确（各色轮廓面积之和 == 总像素）', m.exactPixelCoverage === true, m.drawnPixels + ' / ' + m.totalPixels)
  // 背景色（palette[0]）不落 path，前景每色一条
  check('前景每色一条 path', m.paths === m.palette.length - 1, m.paths + ' 条 / 前景 ' + (m.palette.length - 1) + ' 色')
  check('SVG 不含背景填充色', m.palette.length > 0 && !out.svg.includes("fill='" + m.palette[0] + "'"), m.palette[0])
  check('含 nonzero 填色规则', out.svg.includes("fill-rule='nonzero'"))
  check('带 viewBox 且等于工作图尺寸', out.svg.includes("viewBox='0 0 " + m.work.width + ' ' + m.work.height + "'"))
  check('在字符预算内', out.svg.length <= TRACE_DEFAULTS.maxBytes, out.svg.length + ' 字符')
  check('image= 值是可解析的 data URI', svgToImageValue(out.svg).startsWith('data:image/svg+xml,'))
  check('默认 scaleApplied=1', m.scaleApplied === 1, String(m.scaleApplied))
  check('metrics 带 sizeNotes 字段', typeof m.sizeNotes === 'string')

  console.log('check-trace: P0 scale / gridH / alpha')
  {
    const w = 40
    const h = 40
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = 200
      data[i * 4 + 1] = 40
      data[i * 4 + 2] = 40
      data[i * 4 + 3] = 255
    }
    const scaled = traceRasterToSvg({ width: w, height: h, data: data }, { scale: 2, grid: 999, colors: 4, epsilon: 1, minArea: 1 })
    check('scale:2 → scaleApplied=2', scaled.metrics.scaleApplied === 2, String(scaled.metrics.scaleApplied))
    check('scale:2 → work ≈ 20×20', scaled.metrics.work.width === 20 && scaled.metrics.work.height === 20,
      scaled.metrics.work.width + '×' + scaled.metrics.work.height)
    check('scale:2 sizeNotes 提到 scaleApplied', scaled.metrics.sizeNotes.includes('scaleApplied 2'), scaled.metrics.sizeNotes)

    const clamped = traceRasterToSvg({ width: w, height: h, data: data }, { scale: 0, grid: 999, colors: 4, epsilon: 1, minArea: 1 })
    check('scale:0 被夹到 1', clamped.metrics.scaleApplied === 1, String(clamped.metrics.scaleApplied))
    check('scale 被忽略时 sizeNotes 说出来', clamped.metrics.sizeNotes.includes('clamped'), clamped.metrics.sizeNotes)

    const tall = new Uint8Array(40 * 80 * 4)
    for (let i = 0; i < 40 * 80; i += 1) {
      tall[i * 4] = 40
      tall[i * 4 + 1] = 40
      tall[i * 4 + 2] = 200
      tall[i * 4 + 3] = 255
    }
    const capped = traceRasterToSvg({ width: 40, height: 80, data: tall }, { scale: 1, grid: 100, gridH: 40, colors: 4, epsilon: 1, minArea: 1 })
    check('gridH 压住长图高度', capped.metrics.work.height === 40, capped.metrics.work.width + '×' + capped.metrics.work.height)
    check('gridH sizeNotes 提到 height', capped.metrics.sizeNotes.includes('height'), capped.metrics.sizeNotes)
  }
  {
    // 透明底 + 半透明红块：合成到白后应接近 #ff8080，且不能整幅被当背景
    const w = 32
    const h = 32
    const data = new Uint8Array(w * h * 4) // alpha 0
    for (let y = 8; y < 24; y += 1) {
      for (let x = 8; x < 24; x += 1) {
        const o = (y * w + x) * 4
        data[o] = 255
        data[o + 1] = 0
        data[o + 2] = 0
        data[o + 3] = 128
      }
    }
    const alphaOut = traceRasterToSvg(
      { width: w, height: h, data: data },
      { scale: 1, grid: 999, colors: 4, epsilon: 1, minArea: 1, bgBright: 238, bgTol: 10 },
    )
    check('半透明前景有前景像素', alphaOut.metrics.foregroundPixels > 0, String(alphaOut.metrics.foregroundPixels))
    check('半透明前景未整幅当背景', alphaOut.metrics.backgroundPixels < w * h, String(alphaOut.metrics.backgroundPixels))
    const hasPink = alphaOut.metrics.palette.some(function (hex) {
      if (hex === undefined || hex[0] !== '#') return false
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      // 白底上 50% 红 ≈ #ff7f7f；允许量化误差
      return r >= 200 && g >= 90 && g <= 170 && b >= 90 && b <= 170
    })
    check('调色板含白底合成后的粉红', hasPink === true, JSON.stringify(alphaOut.metrics.palette))
  }

  console.log('check-trace: P1 protect / majority / dark palette / minRegionArea')
  {
    const w = 48
    const h = 48
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = 255
      data[i * 4 + 1] = 255
      data[i * 4 + 2] = 255
      data[i * 4 + 3] = 255
    }
    for (let y = 10; y < 38; y += 1) {
      for (let x = 10; x < 38; x += 1) {
        const o = (y * w + x) * 4
        data[o] = 210
        data[o + 1] = 170
        data[o + 2] = 170
      }
    }
    for (let x = 12; x < 36; x += 1) {
      const o = (24 * w + x) * 4
      data[o] = 20
      data[o + 1] = 20
      data[o + 2] = 20
    }
    const prot = traceRasterToSvg(
      { width: w, height: h, data: data },
      {
        scale: 1, grid: 999, colors: 6, colorsDark: 2, colorsFill: 0,
        epsilon: 1, minArea: 80, protectLuma: 110, majorityContrast: 40,
      },
    )
    check('暗线产生 protectPixels', prot.metrics.protectPixels > 0, String(prot.metrics.protectPixels))
    check('暗色配额生效', prot.metrics.colorsDark >= 1, String(prot.metrics.colorsDark))
    check('暗样本被分到 darkSamples', prot.metrics.darkSamples > 0, String(prot.metrics.darkSamples))
    check('众数在高对比处跳过', prot.metrics.majoritySkipped > 0, String(prot.metrics.majoritySkipped))
    check(
      '保护区挡住 despeckle 或标了保护区域',
      prot.metrics.despeckle.protectedSkipped > 0 || prot.metrics.regionsProtected > 0,
      'skipped=' + prot.metrics.despeckle.protectedSkipped + ' regions=' + prot.metrics.regionsProtected,
    )

    const off = traceRasterToSvg(
      { width: w, height: h, data: data },
      {
        scale: 1, grid: 999, colors: 6, colorsDark: 0,
        epsilon: 1, minArea: 80, protectLuma: 0, majorityContrast: 0,
      },
    )
    check('protectLuma:0 → 无保护像素', off.metrics.protectPixels === 0, String(off.metrics.protectPixels))
    check('colorsDark:0 → 不分层', off.metrics.colorsDark === 0, String(off.metrics.colorsDark))
    check('majorityContrast:0 → 不跳过', off.metrics.majoritySkipped === 0, String(off.metrics.majoritySkipped))

    const onlyRegion = traceRasterToSvg(
      { width: w, height: h, data: data },
      {
        scale: 1, grid: 999, colors: 6, colorsDark: 0,
        epsilon: 1, minArea: 0, minRegionArea: 40,
        protectLuma: 0, majorityContrast: 0,
      },
    )
    check('minArea:0 → despeckle 关闭', onlyRegion.metrics.despeckle.mergedPixels === 0, JSON.stringify(onlyRegion.metrics.despeckle))
    check('minRegionArea 独立可开', onlyRegion.metrics.regionMerge.blocks > 0, JSON.stringify(onlyRegion.metrics.regionMerge))
  }

  console.log('check-trace: 白衣白底不抠内部白')
  {
    // 白底 + 黑环 + 白心：内部白不得变透明（不得停在 label 0）
    const w = 48
    const h = 48
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = 255
      data[i * 4 + 1] = 255
      data[i * 4 + 2] = 255
      data[i * 4 + 3] = 255
    }
    const cx = 24
    const cy = 24
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = x - cx
        const dy = y - cy
        const r2 = dx * dx + dy * dy
        if (r2 >= 10 * 10 && r2 <= 12 * 12) {
          const o = (y * w + x) * 4
          data[o] = 20
          data[o + 1] = 20
          data[o + 2] = 20
        }
      }
    }
    const ring = traceRasterToSvg(
      { width: w, height: h, data: data },
      { scale: 1, grid: 999, colors: 4, colorsDark: 1, epsilon: 1, minArea: 1, includeLabels: true },
    )
    const lab = Buffer.from(ring.labels.labels, 'base64')
    const center = lab[cy * w + cx]
    check('白心不是 label 0', center !== 0, 'label=' + center)
    check('有把内部白从 bg 色改回前景', ring.metrics.fgRelabeledFromBg > 0, String(ring.metrics.fgRelabeledFromBg))
    check('至少画出前景 path（含白心）', ring.metrics.paths >= 1, String(ring.metrics.paths))
  }

  console.log('check-trace: AI 调参 preset / hint')
  {
    const w = 24
    const h = 24
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = 240
      data[i * 4 + 1] = 240
      data[i * 4 + 2] = 240
      data[i * 4 + 3] = 255
    }
    for (let y = 6; y < 18; y += 1) {
      for (let x = 6; x < 18; x += 1) {
        const o = (y * w + x) * 4
        data[o] = 30
        data[o + 1] = 30
        data[o + 2] = 30
      }
    }
    const lineart = traceRasterToSvg(
      { width: w, height: h, data: data },
      { preset: 'lineart', grid: 999, colors: 6 },
    )
    check('preset:lineart 写入 metrics', lineart.metrics.preset === 'lineart', lineart.metrics.preset)
    check('lineart 提高 precision', lineart.metrics.optionsApplied.precision === 2, JSON.stringify(lineart.metrics.optionsApplied))
    check('metrics 带 tuneHint', typeof lineart.metrics.tuneHint === 'string' && lineart.metrics.tuneHint.length > 0, lineart.metrics.tuneHint)
    const simple = traceRasterToSvg(
      { width: w, height: h, data: data },
      { preset: 'simple', grid: 999 },
    )
    check('preset:simple 启用 scale', simple.metrics.scaleApplied === 2, String(simple.metrics.scaleApplied))
    let threw = false
    try {
      traceRasterToSvg({ width: w, height: h, data: data }, { preset: 'nope' })
    } catch (error) {
      threw = String(error.message || error).includes('未知 trace preset')
    }
    check('未知 preset 报错', threw === true)
    check('TRACE_PRESET_NAMES 含 lineart', TRACE_PRESET_NAMES.indexOf('lineart') >= 0, TRACE_PRESET_NAMES.join(','))
  }

  console.log('check-trace: traceImage op 端到端')
  const ROOT = resolvePath('.vectorize/itest-check')
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  copyFileSync(SAMPLE, resolvePath(ROOT, 'ref.png'))
  const CANVAS = resolvePath(ROOT, 'canvas.drawio')
  writeFileSync(
    CANVAS,
    '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="dsh-drawai" agent="dsh-drawai" type="device">\n' +
      '  <diagram id="p1" name="Page-1">\n' +
      '    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">\n' +
      '      <root><mxCell id="0" /><mxCell id="1" parent="0" /></root>\n' +
      '    </mxGraphModel>\n  </diagram>\n</mxfile>\n',
    'utf8',
  )
  const SESSION_ID = 's-check-trace'
  const tools = new Map()
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    webServer: { register() { return () => {} } },
    fs: {
      processPath(t) { return typeof t === 'string' ? t : t.path },
      async resolve(p, opts) {
        const cwd = opts !== undefined && opts !== null && typeof opts.cwd === 'string' ? opts.cwd : ROOT
        return { path: resolvePath(cwd, p) }
      },
      async stat(target) { const p = typeof target === 'string' ? target : target.path; return existsSync(p) ? { size: readFileSync(p).length } : undefined },
      async readText(target) { return readFileSync(typeof target === 'string' ? target : target.path, 'utf8') },
      async readBytes(target) { return new Uint8Array(readFileSync(typeof target === 'string' ? target : target.path)) },
      async writeText(target, text) { writeFileSync(typeof target === 'string' ? target : target.path, text, 'utf8') },
      contains() { return true },
    },
    sessions: { get(id) { return id === SESSION_ID ? { header: { cwd: ROOT } } : undefined } },
    sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: ROOT } } },
    effect(fn) { if (typeof fn === 'function') fn(); return () => {} },
    get(name) { return name === 'skills' ? { register() { return () => {} } } : undefined },
  }
  plugin.apply(ctx)
  const apply = tools.get('diagram_apply')
  const result = await apply.execute(
    { path: CANVAS, ops: [{ op: 'traceImage', image: 'ref.png', x: 40, y: 40, preset: 'lineart', as: 'traced' }], layout: 'none' },
    { agent: { id: SESSION_ID } },
  )
  const text = readFileSync(CANVAS, 'utf8')
  check('建出了一个节点', result.created.length === 1, JSON.stringify(result.created))
  check('写回了 svg data URI', text.includes('image=data:image/svg+xml,'))
  check('summary 报告了矢量化指标', result.summary.includes('逐像素矢量化') && result.summary.includes('像素覆盖'), '')
  check('返回结构化 trace[]', Array.isArray(result.trace) && result.trace.length === 1, JSON.stringify(result.trace))
  check('trace.preset=lineart', result.trace[0].preset === 'lineart', result.trace[0] && result.trace[0].preset)
  check('trace 带 hint', typeof result.trace[0].hint === 'string' && result.trace[0].hint.length > 0, result.trace[0] && result.trace[0].hint)
  check('trace.nodeId 记下 as', result.trace[0].nodeId === 'traced', result.trace[0] && result.trace[0].nodeId)
  check('summary 含调参建议', result.summary.includes('调参：'), '')
  const geo = /<mxGeometry x="40" y="40" width="(\d+)" height="(\d+)"/.exec(text)
  const read = await tools.get('diagram_read').execute({ path: CANVAS }, { agent: { id: SESSION_ID } })
  const readText = JSON.stringify(read)
  check('diagram_read 能读回这个 svg 节点', readText.includes('image=data:image/svg+xml') || readText.includes('«svg '), '')
  check('节点几何 = 图像像素尺寸', geo !== null, geo === null ? '(没找到 geometry)' : geo[1] + '×' + geo[2])

  // 回归：宿主交给插件的是**深冻结**的 arguments（dsh-tools 在 execute 前 deepFreeze 整份参数，
  // 见 tool 执行器里的 `arguments: deepFreeze(snapshotJsonValue(exec.arguments))`）。
  // traceImage 曾经在这里崩：它往调用方的 ops 里 splice 一条合成的 addNode，
  // 而冻结数组不可扩展 → "Cannot add property 1, object is not extensible"。
  console.log('check-trace: 冻结的 arguments（宿主真实形态）')
  const frozenOps = Object.freeze([Object.freeze({ op: 'traceImage', image: 'ref.png', x: 400, y: 40, epsilon: 2.5 })])
  const frozenResult = await apply.execute(
    Object.freeze({ path: CANVAS, ops: frozenOps, layout: 'none' }),
    { agent: { id: SESSION_ID } },
  )
  check('深冻结 ops 也能跑通 traceImage', frozenResult.created.length === 1, JSON.stringify(frozenResult.created))
  const frozenText = readFileSync(CANVAS, 'utf8')
  check('冻结那次也真的写进了画布', (frozenText.match(/image=data:image\/svg\+xml,/g) || []).length === 2, '')
  check('原始 ops 数组没被就地改动', frozenOps.length === 1 && frozenOps[0].op === 'traceImage', '长度 ' + frozenOps.length)

  // 裁剪：整张立绘里的"脸"只有几十像素，量化后五官必丢 —— 裁出局部单独描是唯一的解法。
  console.log('check-trace: 裁剪 crop*（局部提升有效分辨率）')
  const beforeCrop = readFileSync(CANVAS, 'utf8')
  const cropResult = await apply.execute(
    {
      path: CANVAS,
      ops: [{ op: 'traceImage', image: 'ref.png', cropX: 20, cropY: 30, cropW: 120, cropH: 90, as: 'face' }],
      layout: 'none',
    },
    { agent: { id: SESSION_ID } },
  )
  const afterCrop = readFileSync(CANVAS, 'utf8')
  check('裁剪也建出了节点', cropResult.created.length === 1, JSON.stringify(cropResult.created))
  check('裁剪回执带 crop', cropResult.trace[0].crop !== undefined && cropResult.trace[0].crop.w === 120,
    JSON.stringify(cropResult.trace[0].crop))
  check('裁剪的 source = 裁剪块尺寸', cropResult.trace[0].source.width === 120 && cropResult.trace[0].source.height === 90,
    JSON.stringify(cropResult.trace[0].source))
  check('裁剪真的改了画布', afterCrop !== beforeCrop, '')
  // 按 id 读回那个节点，而不是在整份文件里正则抓第一个 SVG（第一个是前面描的整图）。
  const cropRead = await tools.get('diagram_read').execute({ path: CANVAS, ids: ['n3'] }, { agent: { id: SESSION_ID } })
  const cropNode = (cropRead.nodes || []).find((n) => n.id === 'n3')
  const cropSvg = cropNode !== undefined && typeof cropNode.svg === 'string' ? cropNode.svg : ''
  // 关键回归：裁剪块的路径坐标是**裁剪局部**系，viewBox 必须留在 0 0 cropW cropH。
  // （曾把它平移成绝对坐标 "20 30 120 90"：路径不跟着走，内容整体跑出可视区 → 渲染出空白。）
  check('viewBox 保持裁剪局部坐标', cropSvg.indexOf("viewBox='0 0 120 90'") >= 0, cropSvg.slice(0, 56))
  // 局部系的实证：路径坐标受裁剪块尺寸约束（≤ max(cropW, cropH)，也必然远小于整图 499）。
  // 若哪天又被平移成绝对坐标，坐标里会冒出整图量级的数，这条立刻变红。
  // 注意：裁剪块有可能整块是背景（无路径），所以只在有路径时判定上限。
  const cropCoords = (cropSvg.match(/d='[^']+'/g) || []).join(' ').match(/-?\d+/g) || []
  const maxCoord = cropCoords.reduce((m, v) => Math.max(m, Math.abs(Number(v))), 0)
  check('路径坐标不超过裁剪块尺寸', maxCoord <= Math.max(120, 90), 'max=' + maxCoord + ' (路径数 ' + cropCoords.length + ')')
  // 几何按比例：整图 499 宽 / 裁剪块 120 宽 → 节点宽 ≈ 499（这样局部坐标正好铺到原图那一块）
  check('裁剪节点坐标 = 裁剪原点', afterCrop.includes('<mxGeometry x="20" y="30"'), '')
  // 默认 w/h 仍按整张图（1:1），于是局部坐标铺开后正好是"原图里那一块"的比例
  check('裁剪节点 w/h 仍按整张图', afterCrop.includes('width="499" height="847"'), '')

  const expectThrow = async (label, op, expectText) => {
    let message = ''
    try {
      await apply.execute({ path: CANVAS, ops: [op], layout: 'none' }, { agent: { id: SESSION_ID } })
    } catch (error) {
      message = String(error.message || error)
    }
    check(label, message.includes(expectText), message.slice(0, 90))
  }
  await expectThrow('只给 cropX/cropY 报错（不是裁剪）',
    { op: 'traceImage', image: 'ref.png', cropX: 10, cropY: 10 }, '裁剪区域要给出正数')
  await expectThrow('裁剪超出图片范围报错',
    { op: 'traceImage', image: 'ref.png', cropX: 9999, cropY: 0, cropW: 50, cropH: 50 }, '超出图片范围')
  const afterBad = readFileSync(CANVAS, 'utf8')
  check('裁剪参数报错发生在写盘之前', afterBad === afterCrop, '')

  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures === 0 ? 'check-trace: OK' : 'check-trace: ' + failures + ' 处失败')
process.exit(failures === 0 ? 0 : 1)
