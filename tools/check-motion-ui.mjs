import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as motionCore from '../src/motion-core.js'

const state = []; let cursor = 0
const React = {
  useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next }] },
  createElement(type, props, ...children) { return { type, props: props || {}, children } },
}
const MotionPanel = new Function('React', 'motionCore', readFileSync('src/motion-panel.js', 'utf8') + '\nreturn MotionPanel')(React, { ...motionCore,
  catalog: [{ id: 'basic-3d-scene', category: 'camera', summary: '空间运镜与卡片' }] })
const node = { id: 'movie', data: motionCore.motionNodeData() }
const doc = { nodes: [node, { id: 'copy', label: '产品标题', style: 'text;' }], edges: [] }
node.data.motion.prompt = '制作一个产品介绍'
const events = []
const props = { node, doc, jobs: [], page: 0,
  onChange: (patch) => { Object.assign(node.data.motion, patch); events.push(['change', patch]) },
  onGenerate: async (composition) => events.push(['generate', composition]),
  onReference: (source, role) => events.push(['reference', source, role]), onRemoveReference: (id) => events.push(['remove', id]),
  onTask: async (...args) => events.push(['task', ...args]), onExport: async (clip) => events.push(['export', clip]),
  onUseVersion: async (id) => events.push(['version', id]), onImport: () => events.push(['import']),
  onOpenSession:()=>events.push(['open-session']),
}
const render = () => { cursor = 0; return MotionPanel(props) }
const all = (tree) => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flat(Infinity).flatMap(all)]
const byLabel = (tree, label) => all(tree).find((item) => item.props['aria-label'] === label)
const button = (tree, text) => all(tree).find((item) => item.type === 'button' && item.children.includes(text))
let tree = render()
assert.equal(button(tree, '打开主会话'), undefined)
assert.equal(byLabel(tree, '视频生成方式').props.value, 'scene')
assert.ok(all(tree).some((item) => item.type === 'option' && item.props.value === 'api' && item.props.disabled))
assert.ok(all(tree).some((item) => item.type === 'option' && item.children.includes('绘制动画视频')))
assert.equal(button(tree, '开始绘制视频').props.disabled, false)
await button(tree, '开始绘制视频').props.onClick()
assert.equal(events.at(-1)[0], 'generate')
byLabel(tree, '视频描述').props.onChange({ target: { value: '修改标题' } })
assert.equal(node.data.motion.prompt, '修改标题')
byLabel(tree, '视频比例').props.onChange({ target: { value: 'tall' } })
assert.equal(node.data.motion.width, 720); assert.equal(node.data.motion.height, 1280)
assert.equal(byLabel(tree, '添加参考元素'), undefined)
assert.equal(button(tree, '连接'), undefined)
assert.ok(byLabel(tree, '画布参考节点').children.includes('暂无参考节点，将画布元素用箭头连接到此视频即可自动引用。'))
doc.edges.push({ id: 'ref', from: 'copy', to: 'movie', style: 'endArrow=classic;' })
tree = render()
assert.ok(byLabel(tree, '画布参考节点').children.includes('已识别 1 个参考节点'))
assert.ok(all(tree).some((item) => item.children.includes('产品标题')))
assert.ok(all(tree).some((item) => item.children.includes('文案')))
assert.equal(byLabel(tree, '参考用途 copy'), undefined)
assert.equal(byLabel(tree, '移除参考 copy'), undefined)
doc.edges = [{ id: 'outgoing', from: 'movie', to: 'copy' }]
tree = render()
assert.ok(byLabel(tree, '画布参考节点').children.includes('暂无参考节点，将画布元素用箭头连接到此视频即可自动引用。'))
doc.edges = [{ id: 'ref', from: 'copy', to: 'movie' }]
node.data.motion.inputKey = motionCore.motionInputKey(motionCore.motionInput(doc, 'movie'))
node.data.motion.prompt = '换一个风格'
tree = render()
assert.ok(all(tree).some((item) => item.children.includes('描述或参考已变化，当前播放的是上一版视频。')))
props.jobs = [{ id: 'job', nodeId: 'movie', page: 0, status: 'rendering', progress: .5 }]
tree = render()
assert.equal(button(tree, '渲染中').props.disabled, true)
await button(tree, '取消').props.onClick()
assert.deepEqual(events.at(-1), ['task', 'cancel', 'job'])
assert.equal(button(tree, '移除记录'), undefined, 'active tasks cannot be dismissed')
for (const status of ['error', 'interrupted', 'cancelled']) {
  props.jobs[0] = { ...props.jobs[0], status }
  tree = render()
  await button(tree, '继续生成').props.onClick()
  assert.deepEqual(events.at(-1), ['task', 'resume', 'job'])
  await button(tree, '移除记录').props.onClick()
  assert.deepEqual(events.at(-1), ['task', 'remove', 'job'])
}
props.jobs[0] = { ...props.jobs[0], status: 'retained', error: '素材已变化', clip: 'motion-job' }
tree = render()
await button(tree, '导出此版本').props.onClick(); assert.deepEqual(events.at(-1), ['export', 'motion-job'])
await button(tree, '使用此版本').props.onClick(); assert.deepEqual(events.at(-1), ['version', 'job'])
await button(tree, '尝试回填').props.onClick(); assert.deepEqual(events.at(-1), ['task', 'apply', 'job'])
assert.equal(button(tree, '导入视频'), undefined)
props.jobs = [{ id: 'wrong-page', nodeId: 'movie', page: 1, status: 'rendering' }]
tree = render(); assert.equal(button(tree, '开始绘制视频').props.disabled, false, 'other pages cannot block this node')
assert.equal(byLabel(tree, '视频制作模式'),undefined)
tree=render()
assert.equal(byLabel(tree,'镜头卡 basic-3d-scene'), undefined)
assert.equal(byLabel(tree,'搜索镜头库'), undefined)
props.jobs=[]
node.data.motion.composition={shots:[{id:'shot-1',recipeId:'scene',sceneSource:'export default ()=>null'}]}
tree=render()
byLabel(tree,'场景源码 shot-1').props.onChange({target:{value:'export default ()=> <div>新场景</div>'}})
tree=render()
await button(tree,'渲染修改后的场景').props.onClick()
assert.equal(events.at(-1)[1].shots[0].sceneSource,'export default ()=> <div>新场景</div>')
node.data.motion.composition.shots[0].sceneComponents = [{ id: 'Smoke', description: '烟雾', source: 'export default ()=> <svg/>' }]
tree = render()
byLabel(tree, '组件源码 shot-1 Smoke').props.onChange({ target: { value: 'export default ()=> <svg><circle r="10"/></svg>' } })
tree = render()
await button(tree, '渲染修改后的场景').props.onClick()
assert.equal(events.at(-1)[1].shots[0].sceneComponents[0].source, 'export default ()=> <svg><circle r="10"/></svg>')
props.jobs=[{id:'coding',nodeId:'movie',page:0,status:'coding',stageDetail:{shotId:'shot-1'}}]
tree=render();assert.equal(button(tree,'编写场景动画').props.disabled,true)
byLabel(tree, '视频帧率').props.onChange({ target: { value: '24' } })
assert.equal(node.data.motion.fps, 24)
byLabel(tree, '视频生成方式').props.onChange({ target: { value: 'scene' } })
assert.equal(node.data.motion.mode, 'scene')
assert.ok(all(tree).some((item) => item.type === 'summary' && item.children.includes('工程与版本')))
const VideoNodeToolbar = new Function('React', 'motionCore', readFileSync('src/motion-panel.js', 'utf8') + '\nreturn VideoNodeToolbar')(React, motionCore)
state.length = 0; cursor = 0
const toolbarProps = { node: { ...node, w: 320, h: 180 }, onDelete: () => events.push(['delete']), onEdit: () => events.push(['edit']), onUpload: () => events.push(['upload']) }
tree = VideoNodeToolbar(toolbarProps)
for (const [label, action] of [['删除', 'delete'], ['编辑', 'edit'], ['上传视频', 'upload']]) {
  button(tree, label).props.onClick(); assert.equal(events.at(-1)[0], action)
}
button(tree, '信息').props.onClick(); cursor = 0; tree = VideoNodeToolbar(toolbarProps)
assert.ok(all(tree).some((item) => item.props.role === 'status' && item.props.className === 'drawai-video-info'))
console.log('Motion UI: description, aspect, automatic incoming arrow references, generate/cancel, stale results, version restore/export and page isolation passed.')
