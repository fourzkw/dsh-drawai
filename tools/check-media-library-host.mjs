import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { buildCanvas } from '../src/canvas-format.js'
import { motionNodeData } from '../src/motion-core.js'
import { buildComposition, createProject, readTimeline } from '../lib/motion/project.js'
import { apply } from '../lib/index.js'

const root = mkdtempSync(resolve('.tmp/media-host-'))
const canvas = join(root, 'test.drawai'), project = join(root, '.drawai-motion', 'movie')
const node = { id: 'movie', label: '', x: 0, y: 0, w: 320, h: 180, style: '', data: motionNodeData() }
node.data.motion.project = '.drawai-motion/movie'
writeFileSync(canvas, buildCanvas({ meta: {}, nodes: [node], edges: [], layers: [{ id: '1' }] }, { format: 'drawai' }).text)
createProject(project)
mkdirSync(join(project, '.out'), { recursive: true })
writeFileSync(join(project, '.out', 'film.mp4'), 'legacy film')
writeFileSync(join(project, '.out', 'jobs.json'), '\ufeff' + JSON.stringify([{id:'old-film',kind:'film',status:'done',dir:project,output:join(project,'.out','film.mp4')}]))
const registered = [], skills = [], session = { header: { cwd: root } }
const ctx = { tools: { register(tool) { registered.push(tool); return () => {} } }, webServer: { register() { return () => {} } },
  fs: { resolve: async (p, o) => typeof p === 'object' ? p : { path: resolve(o?.cwd || root, p) },
    processPath: target => typeof target === 'string' ? target : target.path,
    contains: (a,b) => { const p = relative(a.path,b.path); return !isAbsolute(p) && !p.startsWith('..') },
    stat: async target => existsSync(target.path) ? { size: readFileSync(target.path).length } : undefined,
    readText: async target => readFileSync(target.path,'utf8'),
    writeText: async (target,text) => writeFileSync(target.path,text) },
  sessions: { get: id => id === 's' ? session : undefined },
  sandboxPolicy: { resolve: () => ({mode:'workspace-write',workspaceRoot:root}) },
  get(name) { return name === 'skills' ? {register(skill) { skills.push(skill); return () => {} }} : undefined },
  effect(fn) { return fn() } }
try {
  apply(ctx)
  // 素材库与素材边界的指引写在**视频**技能里，所以按名字找，别再按注册顺序摸 skills[0]。
  const videoSkill = skills.find((skill) => skill.name === 'drawai-video')
  assert.ok(videoSkill !== undefined, '插件应注册 drawai-video（素材工作流写在它里面）')
  assert.ok(videoSkill.content.includes('action:"library",nodeId'), '内嵌技能应指引 AI 搜索本地素材')
  assert.ok(videoSkill.content.includes('不要猜测插件或上游目录、从其他工程复制同名文件'), '内嵌技能应要求从插件素材库导入')
  assert.ok(videoSkill.content.includes('motion_task 使用单独的画布引用素材快照'), '内嵌技能应解释不同制作流程的素材边界')
  const tool = registered.find(x => x.name === 'motion_assets'), args = {path:'test.drawai',nodeId:'movie'}
  const list = await tool.execute({...args,action:'library',query:'钢琴'}, {agent:{id:'s'}})
  const opened = await registered.find(x => x.name === 'motion_project').execute({...args,action:'open'}, {agent:{id:'s'}})
  const currentProject = JSON.parse(opened.details).dir
  assert.notEqual(currentProject, project, '旧工程应隔离复制且保留原工程')
  assert.ok(existsSync(join(project,'timeline.json')))
  const migratedJob = JSON.parse(readFileSync(join(currentProject,'.out','jobs.json'),'utf8'))[0]
  assert.equal(migratedJob.dir, currentProject)
  assert.equal(migratedJob.output, join(currentProject,'.out','film.mp4'))
  assert.equal(readFileSync(migratedJob.output,'utf8'), 'legacy film')
  assert.equal(JSON.parse(readFileSync(join(project,'.out','jobs.json'),'utf8').replace(/^\ufeff/,''))[0].dir, project)
  writeFileSync(join(currentProject,'.out','jobs.json'), JSON.stringify([migratedJob, {id:'foreign',kind:'film',status:'done',dir:project,output:join(project,'.out','film.mp4')}]))
  await assert.rejects(registered.find(x => x.name === 'motion_render').execute({...args,action:'apply',jobId:'foreign'}, {agent:{id:'s'}}), /找不到当前工程的任务/)
  const id = JSON.parse(list.details)[0].id
  const imported = await tool.execute({...args,action:'use',assetId:id}, {agent:{id:'s'}})
  const result = JSON.parse(imported.details)
  assert.equal(result.kind, 'audio')
  assert.ok(existsSync(join(currentProject,'assets',result.file)))
  assert.match(result.use,/"nodeId":"movie"/)
  const audio = registered.find(x => x.name === 'motion_audio')
  await audio.execute({...args,action:'add',file:result.file,role:'sfx',at:0}, {agent:{id:'s'}})
  assert.equal(readTimeline(currentProject).audio[0].file, result.file)
  assert.equal(buildComposition(currentProject).audio[0].file, result.file)
  const paperList = await tool.execute({...args,action:'library',query:'纸张'}, {agent:{id:'s'}})
  const paper = await tool.execute({...args,action:'use',assetId:JSON.parse(paperList.details)[0].id}, {agent:{id:'s'}})
  const image = JSON.parse(paper.details)
  assert.equal(image.kind, 'image')
  assert.equal(image.use, 'staticFile(' + JSON.stringify(image.file) + ')')
  assert.ok(existsSync(join(currentProject,'assets',image.file)))
  const listed = await tool.execute({...args,action:'list'}, {agent:{id:'s'}})
  assert.ok(JSON.parse(listed.details).some(item => item.file === result.file))
  console.log('真实宿主工具：检索、图片与音频导入、工程列表和音频时间轴通过')
} finally { rmSync(root,{recursive:true,force:true}) }
