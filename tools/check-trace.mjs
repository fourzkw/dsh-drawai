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
import { TRACE_DEFAULTS, svgToImageValue, traceRasterToSvg } from '../src/trace-image.js'
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
  check('每色一条 path', m.paths === m.palette.length, m.paths + ' 条 / ' + m.palette.length + ' 色')
  check('含 nonzero 填色规则', out.svg.includes("fill-rule='nonzero'"))
  check('带 viewBox 且等于工作图尺寸', out.svg.includes("viewBox='0 0 " + m.work.width + ' ' + m.work.height + "'"))
  check('在字符预算内', out.svg.length <= TRACE_DEFAULTS.maxBytes, out.svg.length + ' 字符')
  check('image= 值是可解析的 data URI', svgToImageValue(out.svg).startsWith('data:image/svg+xml,'))

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
    { path: CANVAS, ops: [{ op: 'traceImage', image: 'ref.png', x: 40, y: 40, epsilon: 2.5 }], layout: 'none' },
    { agent: { id: SESSION_ID } },
  )
  const text = readFileSync(CANVAS, 'utf8')
  check('建出了一个节点', result.created.length === 1, JSON.stringify(result.created))
  check('写回了 svg data URI', text.includes('image=data:image/svg+xml,'))
  check('summary 报告了矢量化指标', result.summary.includes('逐像素矢量化') && result.summary.includes('像素覆盖'), '')
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

  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures === 0 ? 'check-trace: OK' : 'check-trace: ' + failures + ' 处失败')
process.exit(failures === 0 ? 0 : 1)
