import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { createProject, registerProject, buildComposition } from '../lib/motion/project.js'

const tempRoot = tmpdir()
const dir = mkdtempSync(join(tempRoot, 'drawai-font-selection-'))
try {
  createProject(dir, { spec: { width: 256, height: 256, fps: 12, duration: 2 }, segments: 1 })
  const fonts = join(dir, 'assets', 'fonts')
  assert.ok(existsSync(join(fonts, 'NotoSansSC-VF.ttf')))
  assert.ok(existsSync(join(fonts, 'NotoSerifSC-VF.ttf')))
  assert.ok(existsSync(join(fonts, 'DRAWAI-NOTICES.txt')))
  assert.ok(!existsSync(join(fonts, 'HarmonyOS_Sans_SC_Bold.ttf')), '未使用的字体不应复制到新工程')
  writeFileSync(join(dir, 'scene-0.tsx'), 'import React from "react"\nexport default function Scene(){return <div style={{fontFamily:"HarmonyOS Sans SC"}}>字</div>}\n')
  registerProject(dir)
  assert.ok(existsSync(join(fonts, 'HarmonyOS_Sans_SC_Bold.ttf')), '引用的字体应复制到工程')
  assert.ok(!existsSync(join(fonts, 'fusion-pixel-12px-proportional-zh_hans.ttf')), '其他未使用的字体不应复制')
  assert.ok(buildComposition(dir).fontFaces.some(face => face.family === 'HarmonyOS Sans SC'))
  console.log('内置字体：默认字体、按需复制、项目说明和渲染字体列表均通过')
} finally {
  const rel = relative(tempRoot, dir)
  if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) rmSync(dir, { recursive: true, force: true })
}
