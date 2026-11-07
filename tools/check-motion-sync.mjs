import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSync, matchTransient, visualPeak, verifySync, syncRevision, filmHash } from '../src/motion/sync.js'
import { runFfmpeg } from '../src/motion/ffmpeg.js'
import { buildComposition, readTimeline, writeTimeline } from '../src/motion/project.js'
import { renderProject } from '../src/motion/render.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name) }
mkdirSync('.tmp', { recursive: true })
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'drawai-sync-'))
mkdirSync(join(dir, 'assets'))
const base = { fps: 30, width: 160, height: 90, durationInFrames: 120,
  shots: [{ id: 's1', file: 'scene-0.tsx', startFrame: 0, durationFrames: 30 }, { id: 's2', file: 'scene-1.tsx', startFrame: 30, durationFrames: 90 }],
  audio: [{ id: 'bgm', file: 'music.wav', from: 0, durationInFrames: 120, trimStart: 0 }, { id: 'hit', file: 'hit.wav', from: 0, durationInFrames: 9, trimStart: 0 }],
  sync: { musicCueId: 'bgm', toleranceFrames: 2, analysis: { grid: { t0: 0, periodMs: 500, residualMs: 2, coverage: 1 } },
    anchors: [{ id: 'cut', type: 'cut', shotId: 's2', beat: 2 }, { id: 'flash', type: 'action', shotId: 's2', name: 'slam', at: 2, visual: { metric: 'brightness' }, sfx: [{ cueId: 'hit', peakSeconds: 0.1 }] }] } }
const timeline = resolveSync(base)
check('拍号和实测瞬态共用换算；动作得到镜内局部帧', () => { assert.equal(timeline.shots[1].startFrame, 30); assert.equal(timeline.shots[1].anchors.slam, 30); assert.equal(timeline.audio[1].from, 57) })
check('解析不修改调用方，重复读取不累积偏移', () => { assert.equal(base.audio[1].from, 0); assert.deepEqual(resolveSync(timeline), timeline) })
check('音乐裁剪与摆放偏移参与换算', () => { const t = structuredClone(base); t.audio[0].from = 15; t.audio[0].trimStart = 0.5; assert.equal(resolveSync(t).sync.resolved[0].frame, 30) })
check('输出偏移按秒应用，60fps不沿用30fps的帧常数', () => { const t = structuredClone(base); t.fps = 60; t.durationInFrames = 300; t.audio[0].durationInFrames = 300; t.sync.outputOffsetSeconds = 0.04; assert.equal(resolveSync(t).sync.resolved[0].frame, 62) })
check('低质量网格拒绝拍号绑定', () => { const t = structuredClone(base); t.sync.analysis.grid.coverage = 0.1; assert.throws(() => resolveSync(t)) })
check('拒绝未知镜头和重复动作绑定', () => { const t = structuredClone(base); t.sync.anchors[0].shotId = 'missing'; assert.throws(() => resolveSync(t)); t.sync.anchors = [base.sync.anchors[1], { ...base.sync.anchors[1], id: 'duplicate' }]; assert.throws(() => resolveSync(t)) })
check('无画面变化不能通过动作验收', () => assert.equal(visualPeak(Buffer.alloc(16 * 13), 4, 4, 0), null))
check('无音频证据不能通过匹配', () => assert.equal(matchTransient(new Float64Array(5000), new Float64Array(5000), 0.1, 0.1, 22050), null))

const rate = 22050, music = new Float64Array(rate * 4), hit = new Float64Array(Math.round(rate * 0.3))
let seed = 123456
const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return seed / 2147483648 }
for (const time of [0.5, 1, 1.5, 2, 2.5, 3]) for (let i = 0; i < 900; i++) music[Math.round(time * rate) + i] = noise() * 0.35 * Math.exp(-i / 230)
for (let i = 0; i < 650; i++) hit[Math.round(rate * 0.1) + i] = noise() * 0.25 * Math.exp(-i / 170)
function wav(file, data) {
  const bytes = Buffer.alloc(44 + data.length * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(data.length * 2, 40)
  data.forEach((x, i) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), 44 + i * 2)); writeFileSync(file, bytes)
}
try {
  wav(join(dir, 'assets', 'music.wav'), music); wav(join(dir, 'assets', 'hit.wav'), hit)
  if (process.argv.includes('--host')) {
    const { apply } = await import('../lib/index.js')
    const { buildCanvas } = await import('../src/canvas-format.js')
    const { readFileSync, existsSync } = await import('node:fs')
    const { resolve, relative, isAbsolute } = await import('node:path')
    const tools = new Map(); let readonly = false
    const canvas = join(dir, 'canvas.drawai')
    writeFileSync(canvas, buildCanvas({ version: 2, nodes: [{ id: 'movie', x: 0, y: 0, w: 320, h: 180, data: { motion: { project: '.' } } }], edges: [] }, { format: 'drawai' }).text)
    writeTimeline(dir, { ...base, sync: undefined })
    apply({ tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } }, webServer: { register: () => () => {} },
      fs: { resolve: async (p) => typeof p === 'object' ? p : { path: resolve(dir, p) }, processPath: (p) => p.path,
        contains: (a, b) => { const rel = relative(a.path, b.path); return !isAbsolute(rel) && !rel.startsWith('..') },
        stat: async (p) => existsSync(p.path) ? { size: readFileSync(p.path).length } : undefined,
        readText: async (p) => readFileSync(p.path, 'utf8'), writeText: async (p, text) => writeFileSync(p.path, text) },
      sessions: { get: () => ({ header: { cwd: dir } }) }, sandboxPolicy: { resolve: () => ({ mode: readonly ? 'read-only' : 'workspace-write', workspaceRoot: dir }) },
      effect: (fn) => fn(), get: () => undefined })
    const tool = tools.get('motion_sync'), exec = { agent: { id: 's1' } }, common = { path: canvas, nodeId: 'movie' }
    const anchors = base.sync.anchors.map((a) => a.beat === undefined ? a : { ...a, beat: undefined, at: 1 })
    // Match the real JSON transport, which cannot contain undefined properties.
    const bind = JSON.parse(JSON.stringify({ ...common, action: 'bind', musicCueId: 'bgm', anchors }))
    await tool.execute(bind, exec)
    const listed = await tool.execute({ ...common, action: 'list' }, exec)
    check('真实注册的motion_sync工具写盘并返回统一解析结果', () => assert.equal(JSON.parse(listed.details).resolved[1].frame, 60))
    const snapshot = readFileSync(join(dir, 'timeline.json'), 'utf8')
    await assert.rejects(() => tool.execute({ ...bind, anchors: [{ ...bind.anchors[0], shotId: 'missing' }] }, exec))
    check('工具无效绑定不写盘', () => assert.equal(readFileSync(join(dir, 'timeline.json'), 'utf8'), snapshot))
    readonly = true
    await assert.rejects(() => tool.execute({ ...common, action: 'clear' }, exec), /只读/)
    readonly = false
    await tool.execute({ ...common, action: 'clear' }, exec)
    check('解除绑定保留排期并受只读策略保护', () => assert.equal(readTimeline(dir).sync, undefined))
  }
  const mixed = Float64Array.from(music)
  hit.forEach((x, i) => { mixed[Math.round(1.9 * rate) + i] += x })
  wav(join(dir, 'mix.wav'), mixed)
  for (let i = 0; i < 2; i++) writeFileSync(join(dir, 'scene-' + i + '.tsx'), 'export default function Scene(){return null}')
  writeTimeline(dir, timeline)
  check('场景合成入口保留动作锚点', () => assert.equal(buildComposition(dir).shots[1].anchors.slam, 30))
  const render = async (file, shift = 0) => {
    await runFfmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=4', '-i', join(dir, 'mix.wav'), '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(n," + (30 + shift) + ")',drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n," + (60 + shift) + ")'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', file], { cwd: dir })
    writeFileSync(file + '.sync.json', JSON.stringify({ revision: syncRevision(dir, timeline), filmHash: filmHash(file) }))
  }
  const film = join(dir, 'correct.mkv'); await render(film)
  const good = await verifySync(dir, film, timeline)
  check('验收仅留最终报告，临时帧和成功日志已清理', () => assert.deepEqual(readdirSync(join(dir, '.out', 'qa', 'sync')), ['report.json']))
  check('真实成片：音乐/切镜/动作/音效峰值一致通过', () => assert.equal(good.status, 'pass'))
  const delayed = join(dir, 'delayed.mkv'); await render(delayed, 4)
  const bad = await verifySync(dir, delayed, timeline)
  check('真实成片：画面晚4帧会失败，不能因音乐自身稳定而通过', () => assert.equal(bad.status, 'fail'))
  const delayedMix = Float64Array.from(music)
  hit.forEach((x, i) => { delayedMix[Math.round((1.9 + 4 / 30) * rate) + i] += x })
  wav(join(dir, 'mix.wav'), delayedMix)
  const lateSfx = join(dir, 'late-sfx.mkv'); await render(lateSfx)
  const sfxReport = await verifySync(dir, lateSfx, timeline)
  check('真实成片：音效晚4帧独立判失败', () => { assert.equal(sfxReport.status, 'fail'); assert.ok(sfxReport.rows[1].sfx[0].errorFrames > 3) })
  wav(join(dir, 'mix.wav'), mixed)
  const changed = structuredClone(timeline); changed.sync.outputOffsetSeconds = 0.03
  await assert.rejects(() => verifySync(dir, film, changed), /不一致/); passed++; console.log('PASS 旧成片不能验收新绑定')
  const noVisual = structuredClone(base); delete noVisual.sync.anchors[1].visual
  const unresolved = join(dir, 'unknown.mkv'); await render(unresolved)
  rmSync(unresolved + '.sync.json')
  const report = await verifySync(dir, unresolved, noVisual)
  check('未配置动作观测与缺渲染回执明确未验证', () => assert.equal(report.status, 'unverified'))
  if (process.argv.includes('--remotion')) {
    writeFileSync(join(dir, 'scene-0.tsx'), "import React from 'react';import {AbsoluteFill} from 'remotion';export default function Scene(){return <AbsoluteFill style={{background:'black'}}/>}")
    writeFileSync(join(dir, 'scene-1.tsx'), "import React from 'react';import {AbsoluteFill,useCurrentFrame} from 'remotion';export default function Scene({anchors}){const f=useCurrentFrame();return <AbsoluteFill style={{background:f===anchors.slam?'white':'blue'}}/>}")
    const plan = { ...timeline, audioMix: { normalize: false } }
    writeTimeline(dir, plan)
    const film = join(dir, 'remotion.mp4')
    await renderProject(dir, { operation: 'full', output: film }).promise
    const report = await verifySync(dir, film, readTimeline(dir))
    console.log(JSON.stringify(report.rows))
    check('真实Remotion渲染接收动作锚点并通过成片音画验收', () => assert.equal(report.status, 'pass'))
  }
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('Motion sync checks passed: ' + passed)
