#!/usr/bin/env node
/**
 * 引擎契约回归：风格索引必须带引擎，且渲染前的门禁真的会拦「简化替代」。
 * 用法：node tools/check-mgstyle-engine.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const catalog = JSON.parse(readFileSync(join(root, 'src/motion/mgstyles/catalog.json'), 'utf8'))
const { assertEngineFidelity, enginesOfText, scanProjectEngines } = await import('../src/motion/style-engine.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ✓ ' + name) }

// 1. 索引完整性
assert.equal(catalog.styles.length, 15, '应有 15 种风格')
for (const style of catalog.styles) {
  assert.ok(style.engine, style.slug + ' 缺 engine')
  assert.ok(Array.isArray(style.engines) && style.engines.length, style.slug + ' 缺 engines')
  assert.ok(style.engines.includes(style.engine), style.slug + ' 的 engine 不在 engines 里')
  assert.ok(style.engineNote && style.engineNote.length > 8, style.slug + ' 缺 engineNote')
  assert.ok(Array.isArray(style.engineFiles) && style.engineFiles.length, style.slug + ' 缺 engineFiles')
}
ok('15 种风格都带 engine / engines / engineNote / engineFiles')

// 2. 文本信号
assert.deepEqual(enginesOfText('import * as THREE from "three"'), ['three'])
assert.deepEqual(enginesOfText('const gl = canvas.getContext("webgl2")'), ['webgl2'])
assert.deepEqual(enginesOfText('const ctx = canvas.getContext("2d")'), ['canvas2d'])
assert.deepEqual(enginesOfText('div { backdrop-filter: blur(20px) }'), ['dom'])
ok('引擎信号识别（three / webgl2 / canvas2d / dom）')

const threeStyle = catalog.styles.find((item) => item.slug === '03-isometric')
const glStyle = catalog.styles.find((item) => item.slug === '12-aurora-glass')

// 3. 简化替代 → 拒绝渲染
const dir = mkdtempSync(join(tmpdir(), 'drawai-engine-'))
try {
  mkdirSync(join(dir, 'components'), { recursive: true })
  writeFileSync(join(dir, 'scene-0.tsx'), [
    'export const Scene = () => (',
    '  <div style={{ transform: "perspective(800px) rotateX(55deg)" }}>',
    '    <div className="cube" />',
    '  </div>',
    ')',
  ].join('\n'))
  assert.throws(() => assertEngineFidelity(dir, threeStyle), /拒绝渲染/)
  ok('three 风格只有 CSS 3D → 拒绝渲染')

  // 4. 显式偏离 → 带 warning 通过
  writeFileSync(join(dir, 'STYLE.md'), '# 风格\n\n偏离：引擎 three 改为 CSS 3D，因为客户要求纯 DOM\n')
  const deviation = assertEngineFidelity(dir, threeStyle)
  assert.match(deviation.warning, /偏离/)
  ok('STYLE.md 记录偏离 → 带 warning 通过')

  // 5. 真引擎 → 通过，且 .out 里的代码不算数
  rmSync(join(dir, 'STYLE.md'))
  mkdirSync(join(dir, '.out'), { recursive: true })
  writeFileSync(join(dir, '.out', 'fake.tsx'), 'import * as THREE from "three"\n')
  assert.throws(() => assertEngineFidelity(dir, threeStyle), /拒绝渲染/)
  ok('.out 里的代码不算工程实现')

  writeFileSync(join(dir, 'scene-0.tsx'), 'import { ThreeCanvas } from "@remotion/three"\n')
  const real = assertEngineFidelity(dir, threeStyle)
  assert.equal(real.missing.length, 0)
  ok('@remotion/three → 通过')

  // 6. WebGL2
  writeFileSync(join(dir, 'scene-1.tsx'), 'const gl = canvas.getContext("webgl2")\n')
  writeFileSync(join(dir, 'shaders.glsl'), 'void main() {}\n')
  assert.equal(assertEngineFidelity(dir, glStyle).missing.length, 0)
  assert.deepEqual(scanProjectEngines(dir).engines.includes('three'), true)
  ok('WebGL2 风格 + webgl2 上下文 → 通过')

  // 7. Canvas2D 风格：缺了不拒渲，但要点名（软门禁）
  const flat = catalog.styles.find((item) => item.slug === '01-flat-vector')
  const noCanvas = assertEngineFidelity(dir, flat)
  assert.equal(noCanvas.gated, false)
  assert.deepEqual(noCanvas.missing, ['canvas2d'])
  assert.match(noCanvas.warning, /Canvas2D/)
  ok('Canvas2D 风格缺 canvas → warning、不拒绝渲染')

  // 8. 拿 SVG <path> 逐帧顶替 → 同样被点名（逐帧手绘 05 的老问题）
  const cel = catalog.styles.find((item) => item.slug === '05-cel-boil')
  writeFileSync(join(dir, 'scene-2.tsx'), [
    'export const Scene = () => <svg viewBox="0 0 1920 1080">',
    '  <path d="M0 0 L100 100" stroke="#1c1613" />',
    '</svg>',
  ].join('\n'))
  const svgOnly = assertEngineFidelity(dir, cel)
  assert.deepEqual(svgOnly.missing, ['canvas2d'])
  assert.match(svgOnly.warning, /SVG/)
  ok('SVG <path> 顶替 canvas → warning 点名')

  // 9. 真的起了 2D 上下文 → 干净通过；偏离行同样能放行
  writeFileSync(join(dir, 'scene-2.tsx'), 'const ctx = canvas.getContext("2d")\n')
  const canvasOk = assertEngineFidelity(dir, cel)
  assert.deepEqual(canvasOk.missing, [])
  assert.equal(canvasOk.warning, '')
  ok('getContext("2d") → 通过')

  writeFileSync(join(dir, 'scene-2.tsx'), 'export const Scene = () => null\n')
  writeFileSync(join(dir, 'STYLE.md'), '# 风格\n\n偏离：引擎 canvas2d 改为 SVG path，因为逐条路径便于编辑\n')
  assert.match(assertEngineFidelity(dir, cel).warning, /偏离/)
  ok('Canvas2D 的偏离行 → 带 warning 通过')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n引擎契约检查：' + passed + ' 项全过')
