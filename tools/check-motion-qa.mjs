// 帧检自检：拿一个真实工程跑一遍 runFrameQa，校验报告结构。
//   node tools/check-motion-qa.mjs [工程目录]
// 不给目录时用 .drawai-motion/n1；没有成片就跳过（不算失败）。

import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { runFrameQa, renderMarkdown } from '../src/motion/qa.js'

const projectDir = resolve(process.argv[2] || '.drawai-motion/n1')
const assert = (condition, message) => { if (!condition) { console.error('FAIL: ' + message); process.exitCode = 1 } }

if (!existsSync(join(projectDir, 'timeline.json'))) {
  console.log('skip: 没有工程 ' + projectDir)
  process.exit(0)
}
if (!existsSync(join(projectDir, '.out', 'film.mp4'))) {
  console.log('skip: 工程里还没有成片 film.mp4')
  process.exit(0)
}

const timeline = JSON.parse(readFileSync(join(projectDir, 'timeline.json'), 'utf8'))
const started = Date.now()
const report = await runFrameQa({ dir: projectDir, timeline })
const cost = ((Date.now() - started) / 1000).toFixed(1)

assert(['pass', 'warn', 'fail'].includes(report.verdict), 'verdict 应该是 pass/warn/fail')
assert(report.shots.length === timeline.shots.length, '逐镜数量应与 timeline 一致')
assert(Array.isArray(report.checks) && report.checks.length > 0, '报告里应有 checks')
assert(report.checks.some((check) => check.id === 'frames' && check.level === 'pass'), '帧数检查应通过')
assert(typeof report.durationSeconds === 'number' && report.durationSeconds > 0, '应量出时长')
assert(existsSync(join(projectDir, '.out', 'qa', 'framecq', 'report.json')), '应写出 report.json')
assert(!existsSync(join(projectDir, '.out', 'qa', 'framecq', 'stats.txt')), '中间文件应清理掉')
assert(renderMarkdown(report).includes('帧检报告'), 'markdown 可渲染')

const notable = report.checks.filter((check) => check.level !== 'pass')
console.log('verdict=' + report.verdict + ' (' + report.frames + ' 帧 / ' + report.durationSeconds + 's / ' + cost + 's 跑完)')
for (const check of notable) console.log('  [' + check.level + '] ' + check.message + (typeof check.detail === 'string' ? '  → ' + check.detail : ''))
console.log('shots: ' + report.shots.map((shot) => shot.id + ' ' + shot.seconds + 's 静止' + shot.freeze + 's').join(' | '))
if (process.exitCode) process.exit(process.exitCode)
console.log('帧检自检通过')
