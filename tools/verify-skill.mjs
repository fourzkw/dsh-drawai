// 技能包自检：拿仓库里一个真实工程样本，走一遍 preview → render --range → qa → export。
//
//   node tools/verify-skill.mjs                      # 默认样本：.drawai-motion/n1-旧-人生三万天
//   node tools/verify-skill.mjs --sample <工程目录>  # 换样本
//   node tools/verify-skill.mjs --keep               # 留下临时工程，方便看产出
//
// 只验证「引擎 + CLI 能真的渲出片子」，不验证内容好坏。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WB = join(ROOT, 'skills', 'workbuddy', 'bin', 'wb.mjs')
const DEFAULT_SAMPLE = join(ROOT, '.drawai-motion', 'n1-旧-人生三万天')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const value = (name) => {
  const index = argv.indexOf('--' + name)
  return index >= 0 ? argv[index + 1] : undefined
}

const sample = resolve(value('sample') || DEFAULT_SAMPLE)
if (!existsSync(join(sample, 'timeline.json'))) {
  console.error('没有这个工程样本（缺 timeline.json）：' + sample)
  process.exit(1)
}

const timeline = JSON.parse(readFileSync(join(sample, 'timeline.json'), 'utf8'))
const fps = Number(timeline.fps) || 30
const total = Number(timeline.durationInFrames) || fps * 5
const shots = Array.isArray(timeline.shots) ? timeline.shots.length : 0
const mid = Math.max(0, Math.floor(total * 0.55))
const pilotFrames = Math.min(40, total)

const work = mkdtempSync(join(tmpdir(), 'workbuddy-verify-'))
const project = join(work, 'project')
console.log(`样本 ${sample}`)
console.log(`  ${timeline.width}×${timeline.height}@${fps} · ${total} 帧 · ${shots} 段 · audio ${(timeline.audio || []).length}`)
console.log(`临时工程 ${project}\n`)
mkdirSync(project, { recursive: true })
// 不用 fs.cpSync：这台机器的 node 22.19 上，它对带 png 的目录会直接 0xC0000005 崩掉。
const copyTree = (from, to) => {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) copyTree(join(from, entry), join(to, entry))
    return
  }
  copyFileSync(from, to)
}
// 不拷 .out / node_modules：从干净状态开始，不然会误用样本里旧的 film.mp4 与 bundle 缓存。
for (const entry of readdirSync(sample)) {
  if (entry === '.out' || entry === 'node_modules' || entry === '.git') continue
  copyTree(join(sample, entry), join(project, entry))
}

const steps = []
const run = (label, args) => {
  const started = Date.now()
  const result = spawnSync(process.execPath, [WB, ...args], { cwd: ROOT, encoding: 'utf8' })
  const seconds = Math.round((Date.now() - started) / 100) / 10
  const output = (result.stdout || '') + (result.stderr || '')
  const line = output.split(/\r?\n/).find((text) => /完成：|预览帧：|帧检|剪映素材包|✗/.test(text)) || ''
  const ok = result.status === 0 && !/✗/.test(output)
  steps.push({ label, ok, seconds, line: line.trim() })
  console.log(`${ok ? '✓' : '✗'} ${label} · ${seconds}s\n    ${line.trim() || '(无输出)'}`)
  if (!ok) {
    console.log(output.split(/\r?\n/).filter(Boolean).slice(-8).join('\n'))
    finish(false)
  }
  return output
}

function finish(ok) {
  if (!flag('keep')) rmSync(work, { recursive: true, force: true })
  else console.log('\n临时工程保留在 ' + work)
  console.log('\n' + (ok ? '通过：技能包能从这个样本渲出帧、样片、帧检报告与剪映包。' : '失败：见上面最后一段输出。'))
  process.exit(ok ? 0 : 1)
}

run('preview（定调帧）', ['preview', '--dir', project, '--frames', String(mid)])
// preview 的静帧落在 .out/qa/agent-frame-<n>.png（render --frames 才会另存 .out/still/）。
const still = join(project, '.out', 'qa', `agent-frame-${mid}.png`)
if (!existsSync(still)) {
  console.log('✗ preview 没留下静帧：' + still)
  finish(false)
}

run('render --range（样片）', ['render', '--dir', project, '--range', '0,' + String(pilotFrames), '--wait'])
const pilot = join(project, '.out', 'pilot.mp4')
if (!existsSync(pilot) || statSync(pilot).size < 1024) {
  console.log('✗ 样片没写出来：' + pilot)
  finish(false)
}

run('qa（样片）', ['qa', '--dir', project, '--file', '.out/pilot.mp4'])
if (flag('full')) {
  run('render（整片）', ['render', '--dir', project, '--wait'])
  run('export（剪映包）', ['export', '--dir', project])
} else {
  // 默认只验管线：把样片当成片导出，省掉整片那 1 分多钟；--full 才渲整片。
  run('export（剪映包）', ['export', '--dir', project, '--film', '.out/pilot.mp4'])
}

const seconds = steps.reduce((sum, step) => sum + step.seconds, 0)
console.log(`\n合计 ${Math.round(seconds)}s · ${steps.length} 步`)
finish(steps.every((step) => step.ok))
