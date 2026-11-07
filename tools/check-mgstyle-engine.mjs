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
assert.equal(catalog.styles.length, 14, '应有 14 种风格')
for (const style of catalog.styles) {
  assert.ok(style.engine, style.slug + ' 缺 engine')
  assert.ok(Array.isArray(style.engines) && style.engines.length, style.slug + ' 缺 engines')
  assert.ok(style.engines.includes(style.engine), style.slug + ' 的 engine 不在 engines 里')
  assert.ok(style.engineNote && style.engineNote.length > 8, style.slug + ' 缺 engineNote')
  assert.ok(Array.isArray(style.engineFiles) && style.engineFiles.length, style.slug + ' 缺 engineFiles')
}
ok('14 种风格都带 engine / engines / engineNote / engineFiles')

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

  // 7. Canvas2D 风格不硬拦（不制造误报）
  const flat = catalog.styles.find((item) => item.slug === '01-flat-vector')
  assert.equal(assertEngineFidelity(dir, flat).gated, false)
  ok('Canvas2D 风格不做重引擎门禁')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n引擎契约检查：' + passed + ' 项全过')
