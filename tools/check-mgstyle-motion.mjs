#!/usr/bin/env node
/**
 * 动效画像与效果配方回归：风格索引必须带 motion；创建工程时 STYLE.md 必须写出
 * 「效果配方」，并且不再把上游源码说成"只作阅读参考"。
 * 用法：node tools/check-mgstyle-motion.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const catalog = JSON.parse(readFileSync(join(root, 'src/motion/mgstyles/catalog.json'), 'utf8'))
const { resolveMgStyle } = await import('../src/mgstyle-core.js')
const { createProject } = await import('../src/motion/project.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ✓ ' + name) }

// 1. 每种风格都有动效画像
assert.equal(catalog.styles.length, 14)
for (const style of catalog.styles) {
  assert.ok(style.motion && typeof style.motion === 'object', style.slug + ' 缺 motion')
  assert.ok(['wipe', 'cut'].includes(style.motion.transitions), style.slug + ' 的 transitions 不合法')
  if (style.motion.motionBlur) {
    assert.ok(Number.isInteger(style.motion.motionBlur.samples) && style.motion.motionBlur.samples >= 1, style.slug + ' motionBlur.samples 不合法')
    assert.ok(style.motion.motionBlur.shutter > 0, style.slug + ' motionBlur.shutter 不合法')
  }
}
ok('14 种风格都带 motion（transitions / impact / camera / motionBlur / grain / secondary）')

// 2. 形变这支的具体值（catches 正则跑偏）
const morph = resolveMgStyle(catalog, '08-morph').motion
assert.equal(morph.transitions, 'wipe')
assert.equal(morph.impact, true)
assert.equal(morph.camera, true)
assert.equal(morph.motionBlur.samples, 4)
assert.equal(morph.motionBlur.shutter, 0.5)
assert.equal(morph.grain.size, 256)
assert.equal(morph.feather, true)
assert.ok(morph.secondary.includes('steam') && morph.secondary.includes('flap'), '08-morph 应识别出蒸汽/拍翼')
ok('08-morph 的动效画像：wipe + impact + camera + 4x blur + 256² 颗粒 + 软边 + 二次运动')

// 3. 建工程 → STYLE.md 有「效果配方」与逐项要求
const dir = mkdtempSync(join(tmpdir(), 'drawai-motion-'))
try {
  const style = resolveMgStyle(catalog, '08-morph')
  const created = createProject(dir, { spec: { width: 1920, height: 1080, fps: 30, duration: 10 }, style, segments: 2 })
  const md = readFileSync(join(dir, 'STYLE.md'), 'utf8')
  assert.ok(md.includes('## 效果配方（必做，逐项对照参考帧）'), 'STYLE.md 缺效果配方段')
  assert.ok(md.includes('field wipe'), '效果配方没写转场做法')
  assert.ok(md.includes('motionBlur samples 4 / shutter 0.5'), '效果配方没写运动模糊参数')
  assert.ok(md.includes('逐像素颗粒 256²'), '效果配方没写颗粒规格')
  assert.ok(md.includes('mg_style {action:"frames", slug:"08-morph"}'), '效果配方没给取帧命令')
  assert.ok(!md.includes('上游源码只作阅读参考'), 'STYLE.md 仍把上游源码说成只作阅读参考')
  assert.equal(created.timeline.style.motion.transitions, 'wipe', 'timeline 没记住 motion')
  assert.ok(md.includes('## 引擎契约（硬规定）'), '引擎契约段被覆盖掉了')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
ok('createProject 写出效果配方 + 取帧命令，timeline 记住 motion')

console.log('\ncheck-mgstyle-motion: ' + passed + ' 组通过')
