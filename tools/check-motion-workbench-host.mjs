// 剪辑工作台的宿主接线：一次性 token、工程定位、保存冲突、静态资源围栏。
//
// 不启动 Remotion 打包（环境未就绪时 open 必须优雅降级并给出原因），
// 但会真实走 webServer 路由、canvas 读取和 timeline 原子写盘。
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { apply } from '../lib/index.js'
import { buildCanvas, parseCanvas } from '../src/canvas-format.js'
import { motionNodeData } from '../src/motion-core.js'
import { clipDirFor } from '../src/media.js'
import { runFfmpeg } from '../src/motion/ffmpeg.js'
import { splitClipAt } from '../src/motion/timeline.js'
import { videoRuntimeCacheKey, videoRuntimeFingerprint } from '../src/motion/video-runtime.js'

const root = mkdtempSync(join(tmpdir(), 'drawai-workbench-'))
const runtimeRoot = join(root, 'runtime')
process.env.DRAWAI_VIDEO_RUNTIME_DIR = join(runtimeRoot, 'not-installed')
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

const legacy24 = join(root, 'legacy24')
mkdirSync(join(legacy24, 'assets'), { recursive: true })
writeFileSync(join(legacy24, 'scene-0.tsx'), 'export default function Scene(){return null}')
writeFileSync(join(legacy24, 'scene-1.tsx'), 'export default function Scene(){return null}')
writeFileSync(join(legacy24, 'timeline.json'), JSON.stringify({
  version: 1, width: 640, height: 360, fps: 24, durationInFrames: 96,
  shots: [
    { id: 'shot-1', file: 'scene-0.tsx', startFrame: 0, durationFrames: 48, anchors: {} },
    { id: 'shot-2', file: 'scene-1.tsx', startFrame: 48, durationFrames: 48, anchors: {} },
  ],
  audio: [],
}, null, 2) + '\n')

const data = motionNodeData()
data.motion = { ...data.motion, mode: 'scene', prompt: '工作台测试', duration: 4, fps: 30, width: 640, height: 360, project: 'legacy' }
const data24 = motionNodeData()
data24.motion = { ...data24.motion, mode: 'scene', prompt: '工作台 24fps 测试', duration: 4, fps: 24, width: 640, height: 360, project: 'legacy24' }
const doc = { meta: {}, nodes: [
  { id: 'movie', label: '工作台视频', x: 0, y: 0, w: 320, h: 180, style: '', data },
  { id: 'movie24', label: '工作台视频 24', x: 0, y: 220, w: 320, h: 180, style: '', data: data24 },
], edges: [], layers: [{ id: '1' }] }
writeFileSync(canvasPath, buildCanvas(doc, { format: 'drawai' }).text)

const routes = [], tools = []
const session = { header: { cwd: root }, requestHeader: () => ({ config: {} }) }
const workbenchHooks = {}
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
  get(name) { return name === 'drawai.motion-workbench' ? workbenchHooks : undefined },
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

async function openWorkbench(nodeId, path = 'canvas.drawai') {
  const created = await call(routes[routes.length - 1], { headers: { 'x-drawai-save': '1' },
    body: { action: 'workbench-session', sessionId: 's', path, nodeId } })
  assert.equal(created.status, 200, created.payload?.error)
  const token = new URL('http://x' + created.payload.url).searchParams.get('token')
  const opened = await call(api, { body: { action: 'open', token } })
  assert.equal(opened.status, 200, opened.payload?.error)
  return { token, opened: opened.payload, dir: created.payload.dir }
}

function installFakeRuntime() {
  const directory = join(runtimeRoot, 'ready')
  const manifest = JSON.parse(readFileSync('src/motion/runtime/package.json', 'utf8'))
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const packageDir = join(directory, 'node_modules', ...name.split('/'))
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
    writeFileSync(join(packageDir, 'index.js'), name === '@remotion/bundler'
      ? "const fs=require('node:fs'),path=require('node:path');exports.bundle=async({outDir,onProgress})=>{fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(path.join(outDir,'bundle.js'),'window.__DRAWAI_TEST_BUNDLE__=true;');onProgress?.(100)}"
      : 'module.exports={}')
  }
  writeFileSync(join(directory, '.ready.json'), JSON.stringify({ fingerprint: videoRuntimeFingerprint(), key: videoRuntimeCacheKey() }))
  process.env.DRAWAI_VIDEO_RUNTIME_DIR = directory
  return directory
}

async function waitJob(token, jobId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await call(api, { body: { action: 'job', token, jobId } })
    assert.equal(result.status, 200, result.payload?.error)
    if (!['queued', 'running'].includes(result.payload.job.status)) return result.payload.job
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('渲染任务没有在测试预算内结束：' + jobId)
}

async function makeVideo(file, color, fps) {
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=' + color + ':s=160x90:r=' + fps + ':d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { cwd: root, log: file + '.log' })
}

try {
  const page = await call(exactPage, { method: 'GET' })
  assert.equal(page.status, 200)
  assert.ok(page.text.includes('DrawAI 剪辑工作台'), '页面要能显示工作台标题')
  assert.ok(page.text.includes('/drawai/workbench/api'), '页面要调用工作台 API')
  assert.ok(page.text.includes('<div id="root"></div>'), 'bundle 挂载点必须存在')
  assert.ok(page.text.includes('drawai-workbench-request-close'), '外层关闭要先请求工作台确认')
  assert.ok(page.text.includes('__DRAWAI_WORKBENCH_RUNTIME_READY__'), '外壳要按同窗标记判断运行时是否已接管，避免确认前抢先关闭')
  const runtimeSource = readFileSync('src/motion/workbench-runtime.jsx', 'utf8')
  assert.ok(runtimeSource.includes('__DRAWAI_WORKBENCH_RUNTIME_READY__ = true'), '运行时挂载后要设置同窗 ready 标记')
  assert.ok(runtimeSource.includes('drawai-workbench-ready'), '运行时仍要通知外层 ready，供父页面切换状态')

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

  // 运行时安装态：用隔离的假运行时验证打包/静态加载，不依赖开发机 ~/.dsh 的状态。
  installFakeRuntime()
  const installed = await call(api, { body: { action: 'open', token } })
  assert.equal(installed.status, 200, installed.payload?.error)
  assert.equal(installed.payload.bundleError, '')
  assert.ok(installed.payload.bundleUrl.includes(token), '安装态必须返回可加载的预览 bundle')
  const bundle = await call(routeOf('prefix', '/drawai/workbench/bundle'), {
    method: 'GET', url: '/drawai/workbench/bundle/' + token + '/bundle.js',
  })
  assert.equal(bundle.status, 200, bundle.text)
  assert.match(bundle.text, /__DRAWAI_TEST_BUNDLE__/)

  const missingVersion = await call(api, { body: { action: 'render', token } })
  assert.equal(missingVersion.status, 400)
  assert.match(missingVersion.payload.error, /缺少已保存的时间轴版本/)

  // 旧任务的共享 film.mp4 无法证明归属，必须明确拒绝。
  const oldFilm = join(projectDir, '.out', 'film.mp4')
  writeFileSync(oldFilm, 'old-shared-film')
  const jobsFile = join(projectDir, '.out', 'jobs.json')
  const jobRecords = existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, 'utf8')) : []
  jobRecords.push({ id: 'job-old-shared', kind: 'film', dir: projectDir, nodeId: 'movie', status: 'done', output: oldFilm })
  writeFileSync(jobsFile, JSON.stringify(jobRecords, null, 2))
  const oldApply = await call(api, { body: { action: 'apply', token, jobId: 'job-old-shared' } })
  assert.equal(oldApply.status, 400)
  assert.match(oldApply.payload.error, /没有独立成片文件|无法确认文件归属/)

  const fixtureA = join(root, 'fixture-a.mp4')
  const fixtureB = join(root, 'fixture-b.mp4')
  await makeVideo(fixtureA, '0x1b6cff', 30)
  await makeVideo(fixtureB, '0xff6a2a', 30)
  workbenchHooks.renderProject = (dir, options) => {
    const variant = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')).testVariant
    copyFileSync(variant === 'B' ? fixtureB : fixtureA, options.output)
    return { promise: Promise.resolve({ frames: 30 }), cancel() {}, output: options.output }
  }

  for (const fpsCase of [
    { fps: 30, nodeId: 'movie', token, opened: installed.payload },
    { fps: 24, nodeId: 'movie24', ...(await openWorkbench('movie24', 'canvas.drawai')) },
  ]) {
    const { fps, nodeId } = fpsCase
    const caseOpen = await call(api, { body: { action: 'open', token: fpsCase.token } })
    assert.equal(caseOpen.status, 200, caseOpen.payload?.error)
    const base = structuredClone(caseOpen.payload.timeline)
    const first = base.tracks[0].clips[0]
    const splitAt = first.startFrame + Math.floor(first.durationFrames / 2)
    let draftA = splitClipAt(base, first.id, splitAt)
    assert.ok(draftA, fps + 'fps 旧工程应能在镜头内部分割')
    draftA.testVariant = 'A'
    const overlayA = draftA.tracks.find((track) => track.role === 'overlay').clips[0] || {
      id: 'overlay-test-' + fps, shotId: 'shot-2', durationFrames: 12, inOffset: 0, opacity: 0.5,
    }
    overlayA.startFrame = 8
    draftA.tracks.find((track) => track.role === 'overlay').clips = [overlayA]
    const savedA = await call(api, { body: { action: 'save', token: fpsCase.token, timeline: draftA, baseRevision: caseOpen.payload.revision } })
    assert.equal(savedA.payload.ok, true, savedA.payload?.error)
    const renderA = await call(api, { body: { action: 'render', token: fpsCase.token, baseRevision: savedA.payload.revision } })
    assert.equal(renderA.status, 200, renderA.payload?.error)
    const jobA = await waitJob(fpsCase.token, renderA.payload.job.id)
    assert.equal(jobA.status, 'done')
    assert.equal(jobA.outputOwned, true)

    const draftB = structuredClone(savedA.payload.timeline)
    draftB.testVariant = 'B'
    draftB.tracks.find((track) => track.role === 'overlay').clips[0].startFrame = 24
    const savedB = await call(api, { body: { action: 'save', token: fpsCase.token, timeline: draftB, baseRevision: savedA.payload.revision } })
    assert.equal(savedB.payload.ok, true, savedB.payload?.error)
    const staleRender = await call(api, { body: { action: 'render', token: fpsCase.token, baseRevision: savedA.payload.revision } })
    assert.equal(staleRender.payload.conflict, true, '导出必须按已保存版本校验冲突')
    const renderB = await call(api, { body: { action: 'render', token: fpsCase.token, baseRevision: savedB.payload.revision } })
    assert.equal(renderB.status, 200, renderB.payload?.error)
    const jobB = await waitJob(fpsCase.token, renderB.payload.job.id)
    assert.equal(jobB.status, 'done')
    assert.notEqual(jobA.output, jobB.output, fps + 'fps 两版必须保留独立 MP4')
    assert.ok(existsSync(jobA.output) && existsSync(jobB.output))
    assert.equal(readFileSync(jobA.output).equals(readFileSync(jobB.output)), false, 'A、B 成片不应相同')

    for (const [job, expected] of [[jobA, fixtureA], [jobB, fixtureB]]) {
      const applied = await call(api, { body: { action: 'apply', token: fpsCase.token, jobId: job.id } })
      assert.equal(applied.status, 200, applied.payload?.error)
      const node = parseCanvas(readFileSync(canvasPath, 'utf8')).doc.nodes.find((item) => item.id === nodeId)
      assert.ok(node?.data.mediaClip, fps + 'fps 回填后节点要有 clip')
      const source = readFileSync(join(clipDirFor(canvasPath, node.data.mediaClip), 'source.mp4'))
      assert.ok(source.equals(readFileSync(expected)), fps + 'fps 回填 ' + job.id + ' 时必须读该任务自己的 MP4')
    }

    const reopened = await call(api, { body: { action: 'open', token: fpsCase.token } })
    assert.equal(reopened.status, 200, reopened.payload?.error)
    assert.equal(reopened.payload.timeline.testVariant, 'B')
    assert.equal(reopened.payload.timeline.tracks[0].clips.length, 3, '重开后分割结果仍在')
    assert.equal(reopened.payload.timeline.tracks.find((track) => track.role === 'overlay').clips[0].startFrame, 24)
  }

  console.log('Motion workbench host checks passed (runtime missing/installed, 24/30fps A/B export ownership)')
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 文件占用不影响断言 */ }
}
