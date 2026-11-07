import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { buildCanvas, parseCanvas } from '../src/canvas-format.js'
import { motionNodeData } from '../src/motion-core.js'
import { ffmpegBinary } from '../src/video-export.js'
import { createProject } from '../lib/motion/project.js'
import { clipDirFor } from '../lib/media.js'
import { apply } from '../lib/index.js'

mkdirSync('.tmp', { recursive: true })
const root = mkdtempSync(resolve('.tmp/pilot-host-'))
try {
  const canvas = join(root, 'test.drawai')
  const makeNode = id => ({ id, label: id, x: 0, y: 0, w: 320, h: 180, style: '', data: motionNodeData() })
  const first = makeNode('first'), second = makeNode('second'), sample = makeNode('sample')
  first.data.motion.project = '.drawai-motion/first'
  second.data.motion.project = '.drawai-motion/second'
  for (const id of ['first', 'second']) createProject(join(root, '.drawai-motion', id))
  writeFileSync(canvas, buildCanvas({ meta: {}, nodes: [first, second, sample], edges: [], layers: [{ id: '1' }] }, { format: 'drawai' }).text)
  const tools = [], session = { header: { cwd: root } }
  const ctx = { tools: { register(tool) { tools.push(tool); return () => {} } }, webServer: { register() { return () => {} } },
    fs: { resolve: async (p, o) => typeof p === 'object' ? p : { path: resolve(o?.cwd || root, p) },
      processPath: target => typeof target === 'string' ? target : target.path,
      contains: (a, b) => { const p = relative(a.path, b.path); return !isAbsolute(p) && p !== '..' && !/^[.][.][\\/]/.test(p) },
      stat: async target => existsSync(target.path) ? { size: readFileSync(target.path).length } : undefined,
      readText: async target => readFileSync(target.path, 'utf8'), writeText: async (target, text) => writeFileSync(target.path, text) },
    sessions: { get: id => id === 's' ? session : undefined }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
    get() { return undefined }, effect(fn) { return fn() } }
  apply(ctx)
  const call = (name, args) => tools.find(tool => tool.name === name).execute({ path: 'test.drawai', ...args }, { agent: { id: 's' } })
  const firstDir = JSON.parse((await call('motion_project', { action: 'open', nodeId: 'first' })).details).dir
  const secondDir = JSON.parse((await call('motion_project', { action: 'open', nodeId: 'second' })).details).dir
  assert.notEqual(firstDir, secondDir)
  mkdirSync(join(secondDir, '.out'), { recursive: true })
  const film = join(secondDir, '.out', 'pilot.mp4')
  execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', film], { windowsHide: true })
  writeFileSync(join(secondDir, '.out', 'jobs.json'), '\ufeff' + JSON.stringify([{ id: 'second-pilot', kind: 'pilot', status: 'done', dir: secondDir, nodeId: 'second', output: film }]))
  await assert.rejects(call('motion_render', { action: 'apply', nodeId: 'sample', source: 'pilot' }), /多个视频工程/)
  const result = JSON.parse((await call('motion_render', { action: 'apply', nodeId: 'sample', jobId: 'second-pilot', source: 'pilot' })).details)
  assert.equal(result.kind, 'pilot')
  assert.equal(result.nodeId, 'sample')
  const nodes = parseCanvas(readFileSync(canvas, 'utf8')).doc.nodes
  assert.equal(nodes.find(item => item.id === 'sample').data.mediaClip, result.clip)
  assert.equal(nodes.find(item => item.id === 'first').data.mediaClip, undefined)
  assert.equal(nodes.find(item => item.id === 'second').data.mediaClip, undefined)
  assert.deepEqual(readFileSync(join(clipDirFor(canvas, result.clip), 'source.mp4')), readFileSync(film))
  console.log('Pilot host: a BOM-prefixed job is applied to the sample node from the selected project, without modifying either main node.')
} finally { rmSync(root, { recursive: true, force: true }) }
