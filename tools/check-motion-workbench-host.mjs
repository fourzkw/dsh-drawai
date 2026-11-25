// 剪辑工作台的宿主接线：一次性 token、工程定位、保存冲突、静态资源围栏。
//
// 不启动 Remotion 打包（环境未就绪时 open 必须优雅降级并给出原因），
// 但会真实走 webServer 路由、canvas 读取和 timeline 原子写盘。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { apply } from '../lib/index.js'
import { buildCanvas, parseCanvas } from '../src/canvas-format.js'
import { motionNodeData } from '../src/motion-core.js'

const root = mkdtempSync(join(tmpdir(), 'drawai-workbench-'))
const canvasPath = join(root, 'canvas.drawai')
const legacy = join(root, 'legacy')
mkdirSync(join(legacy, 'assets'), { recursive: true })
writeFileSync(join(legacy, 'scene-0.tsx'), 'export default function Scene(){return null}')
writeFileSync(join(legacy, 'scene-1.tsx'), 'export default function Scene(){return null}')
writeFileSync(join(legacy, 'assets', 'note.txt'), 'workbench asset')
writeFileSync(join(legacy, 'timeline.json'), JSON.stringify({
  version: 1, width: 640, height: 360, fps: 30, durationInFrames: 120,
  shots: [
    { id: 'shot-1', file: 'scene-0.tsx', startFrame: 0, durationFrames: 60, anchors: {} },
    { id: 'shot-2', file: 'scene-1.tsx', startFrame: 60, durationFrames: 60, anchors: {} },
  ],
  audio: [],
}, null, 2) + '\n')

const data = motionNodeData()
data.motion = { ...data.motion, mode: 'scene', prompt: '工作台测试', duration: 4, fps: 30, width: 640, height: 360, project: 'legacy' }
const doc = { meta: {}, nodes: [{ id: 'movie', label: '工作台视频', x: 0, y: 0, w: 320, h: 180, style: '', data }], edges: [], layers: [{ id: '1' }] }
writeFileSync(canvasPath, buildCanvas(doc, { format: 'drawai' }).text)

const routes = [], tools = []
const session = { header: { cwd: root }, requestHeader: () => ({ config: {} }) }
apply({
  tools: { register(tool) { tools.push(tool); return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  fs: {
    resolve: async (p, options) => typeof p === 'object' ? p : { path: resolve(options?.cwd || root, p) },
    processPath: (target) => typeof target === 'string' ? target : target.path,
    contains: (a, b) => { const rel = relative(a.path, b.path); return !isAbsolute(rel) && !rel.startsWith('..') },
    stat: async (target) => existsSync(target.path) ? { size: readFileSync(target.path).length } : undefined,
    readText: async (target) => readFileSync(target.path, 'utf8'),
    writeText: async (target, text) => writeFileSync(target.path, text),
  },
  sessions: { get: (id) => id === 's' ? session : undefined },
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
  effect(fn) { const cleanup = fn(); return cleanup },
  get() { return undefined },
})

const routeOf = (kind, path) => routes.find((route) => route.kind === kind && route.path === path)
const exactPage = routeOf('exact', '/drawai/workbench')
const api = routeOf('prefix', '/drawai/workbench/api')
const media = routeOf('prefix', '/drawai/workbench/media')
assert.ok(exactPage && api && media, '工作台 page/api/media 路由都要注册')
assert.equal(routes[routes.length - 1].path, '/drawai/api/save', '写回路由必须最后注册（现有测试按 routes[last] 取）')

async function call(route, { method = 'POST', body, url = route.path, headers = {} } = {}) {
  const listeners = {}
  const req = { method, url, headers: { host: '127.0.0.1:3000', ...headers }, on(event, fn) { listeners[event] = fn; return this } }
  let status, payload, text
  const res = {
    writeHead(code) { status = code },
    on() { return this }, once() { return this }, emit() { return false }, removeListener() { return this },
    destroy() {},
    write(chunk) { text = (text || '') + String(chunk) },
    end(value) { if (value !== undefined) text = value; try { payload = JSON.parse(String(text)) } catch { payload = null } },
  }
  if (method === 'POST') queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body || {}))); listeners.end?.() })
  await route.handler(req, res)
  return { status, payload, text: text === undefined ? '' : String(text) }
}

try {
  const page = await call(exactPage, { method: 'GET' })
  assert.equal(page.status, 200)
  assert.ok(page.text.includes('DrawAI 剪辑工作台'), '页面要能显示工作台标题')
  assert.ok(page.text.includes('/drawai/workbench/api'), '页面要调用工作台 API')
  assert.ok(page.text.includes('<div id="root"></div>'), 'bundle 挂载点必须存在')

  const denied = await call(api, { body: { action: 'open', token: 'nope' } })
  assert.equal(denied.status, 403)
  assert.match(denied.payload.error, /不存在|过期/)

  const created = await call(routes[routes.length - 1], { headers: { 'x-drawai-save': '1' }, body: { action: 'workbench-session', sessionId: 's', path: 'canvas.drawai', nodeId: 'movie' } })
  assert.equal(created.status, 200, created.payload?.error)
  assert.ok(created.payload.url.startsWith('/drawai/workbench?token='), '工作台 URL 只带一次性 token')
  const token = new URL('http://x' + created.payload.url).searchParams.get('token')
  const projectDir = created.payload.dir
  assert.ok(existsSync(join(projectDir, 'timeline.json')), '工程要迁移/定位到节点自己的目录')

  // open：环境未就绪也必须返回可编辑 timeline；预览错误要显式带回来。
  const opened = await call(api, { body: { action: 'open', token } })
  assert.equal(opened.status, 200, opened.payload?.error)
  assert.equal(opened.payload.timeline.version, 2)
  assert.equal(opened.payload.timeline.tracks[0].clips.length, 2)
  assert.equal(opened.payload.revision.length, 16)
  assert.equal(opened.payload.project.nodeId, 'movie')
  assert.ok(opened.payload.mediaBase.includes(token))
  assert.equal(opened.payload.bundleUrl, '')
  assert.match(opened.payload.bundleError, /视频运行时|打包/)

  // 静态资源围栏：只能读工程 assets；越界路径 404。
  assert.ok(existsSync(join(projectDir, 'assets', 'note.txt')), '迁移后的工程要带 assets')
  const asset = await call(media, { method: 'GET', url: '/drawai/workbench/media/' + token + '/note.txt', headers: { range: 'bytes=0-8' } })
  assert.equal(asset.status, 206)
  assert.equal(asset.text, 'workbench')
  const escape = await call(media, { method: 'GET', url: '/drawai/workbench/media/' + token + '/../../../timeline.json' })
  assert.equal(escape.status, 404)

  // 保存：baseRevision 正确时升级 v2；过期 revision 冲突且不写盘。
  const draft = structuredClone(opened.payload.timeline)
  draft.tracks[1].clips.push({ id: 'overlay-1', shotId: 'shot-2', startFrame: 12, durationFrames: 24, inOffset: 0, opacity: 0.5 })
  const saved = await call(api, { body: { action: 'save', token, timeline: draft, baseRevision: opened.payload.revision } })
  assert.equal(saved.status, 200, saved.payload?.error)
  assert.equal(saved.payload.ok, true)
  assert.notEqual(saved.payload.revision, opened.payload.revision)
  const disk = JSON.parse(readFileSync(join(projectDir, 'timeline.json'), 'utf8'))
  assert.equal(disk.version, 2)
  assert.equal(disk.tracks[1].clips.length, 1)

  const staleDraft = structuredClone(saved.payload.timeline)
  staleDraft.tracks[1].clips[0].startFrame = 48
  const snapshot = readFileSync(join(projectDir, 'timeline.json'), 'utf8')
  const conflict = await call(api, { body: { action: 'save', token, timeline: staleDraft, baseRevision: opened.payload.revision } })
  assert.equal(conflict.payload.ok, false)
  assert.equal(conflict.payload.conflict, true)
  assert.equal(conflict.payload.revision, saved.payload.revision)
  assert.equal(readFileSync(join(projectDir, 'timeline.json'), 'utf8'), snapshot, '冲突不能写盘')

  const reloaded = await call(api, { body: { action: 'reload', token } })
  assert.equal(reloaded.payload.revision, saved.payload.revision)
  assert.equal(reloaded.payload.timeline.tracks[1].clips[0].startFrame, 12)

  // 回填不存在的任务要明确失败，而不是写坏画布。
  const missing = await call(api, { body: { action: 'apply', token, jobId: 'job-missing' } })
  assert.equal(missing.status, 400)
  assert.match(missing.payload.error, /找不到渲染任务/)
  assert.equal(parseCanvas(readFileSync(canvasPath, 'utf8')).doc.nodes[0].data.mediaClip || '', '')

  console.log('Motion workbench host checks passed')
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 文件占用不影响断言 */ }
}
