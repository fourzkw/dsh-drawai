import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as motionCore from '../src/motion-core.js'
import { composeClientBody } from './build.mjs'

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
assert.equal(button(tree, '开始绘制视频'), undefined, '新视频走对话工程流程')
assert.ok(all(tree).some(item => item.children.includes('在对话中描述想制作的视频')))
byLabel(tree, '视频描述').props.onChange({ target: { value: '修改标题' } })
assert.equal(node.data.motion.prompt, '修改标题')
byLabel(tree, '视频比例').props.onChange({ target: { value: 'tall' } })
assert.equal(node.data.motion.width, 720); assert.equal(node.data.motion.height, 1280)
byLabel(tree, '视频帧率').props.onChange({ target: { value: '24' } })
assert.equal(node.data.motion.fps, 24)
assert.ok(byLabel(tree, '添加参考内容'))
doc.edges.push({ id:'ref', from:'copy', to:'movie' })
tree=render(); assert.ok(all(tree).some(item=>item.children.includes('产品标题')))
props.jobs=[{id:'job',nodeId:'movie',page:0,status:'rendering',progress:.5}]
tree=render(); assert.ok(byLabel(tree,'绘制视频进度'))
await button(tree,'取消').props.onClick();assert.deepEqual(events.at(-1),['task','cancel','job'])
assert.equal(button(tree,'移除记录'),undefined)
props.jobs=[{id:'job',nodeId:'movie',page:0,status:'error',error:'失败'}]
tree=render();await button(tree,'移除记录').props.onClick();assert.deepEqual(events.at(-1),['task','remove','job'])
props.jobs=[{id:'other',nodeId:'movie',page:1,status:'rendering',progress:.5}]
tree=render();assert.equal(byLabel(tree,'绘制视频进度'),undefined,'不同页面的任务不应显示在当前页')
props.jobs=[];node.data.motion.composition={shots:[{id:'shot-1',recipeId:'scene',sceneSource:'export default ()=>null'}]}
tree=render();byLabel(tree,'场景源码 shot-1').props.onChange({target:{value:'export default ()=> <div>新场景</div>'}})
tree=render();await button(tree,'渲染修改后的场景').props.onClick();assert.equal(events.at(-1)[1].shots[0].sceneSource,'export default ()=> <div>新场景</div>')
node.data.motion.composition.shots[0].sceneComponents=[{id:'Smoke',description:'烟雾',source:'export default ()=> <svg/>'}]
tree=render();byLabel(tree,'组件源码 shot-1 Smoke').props.onChange({target:{value:'export default ()=> <svg><circle r="10"/></svg>'}})
tree=render();await button(tree,'渲染修改后的场景').props.onClick();assert.match(events.at(-1)[1].shots[0].sceneComponents[0].source,/circle/)
const VideoNodeToolbar = new Function('React','motionCore',readFileSync('src/motion-panel.js','utf8')+'\nreturn VideoNodeToolbar')(React,motionCore)
state.length=0;cursor=0
const toolbarProps={node:{...node,w:320,h:180},onDelete:()=>events.push(['delete']),onEdit:()=>events.push(['edit']),onUpload:()=>events.push(['upload'])}
tree=VideoNodeToolbar(toolbarProps)
for(const [label,action] of [['删除','delete'],['编辑','edit'],['上传视频','upload']]){byLabel(tree,label).props.onClick();assert.equal(events.at(-1)[0],action)}
assert.equal(byLabel(tree,'信息').props['aria-expanded'],false)
byLabel(tree,'信息').props.onClick();cursor=0;tree=VideoNodeToolbar(toolbarProps)
assert.equal(byLabel(tree,'信息').props['aria-expanded'],true)
assert.ok(all(tree).some(item=>item.props.role==='status'))
assert.ok(all(tree).some(item=>item.children.includes('空视频节点')))
// ── issue #39：视频参数浮层必须锚在整条 footer 上、左右贴边 ──────────────────
// 以前浮层挂在 chip 那一格（footer 的 auto 列，约 150px 宽）上，右锚 + 固定 200px 宽
// 且没有 box-sizing，实际 226px 必然向左越出 composer 边框，被侧栏裁掉一半（标签全丢）。
const css = composeClientBody()
function effectiveDecls(selector) {
  const decls = new Map()
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let hit = rule.exec(css); hit !== null; hit = rule.exec(css)) {
    if (!hit[1].split(',').some((item) => item.trim() === selector)) continue
    for (const part of hit[2].split(';')) {
      const index = part.indexOf(':')
      if (index > 0) decls.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
    }
  }
  return decls
}
const menu = effectiveDecls('.drawai-video-settings-menu')
assert.equal(menu.get('left'), '0', '浮层左沿要贴住容器，不能再挂在窄格子上向右锚')
assert.equal(menu.get('right'), '0', '浮层右沿要贴住容器')
assert.equal(menu.get('width'), 'auto', '浮层宽度不能再写死成 200px')
assert.equal(menu.get('box-sizing'), 'border-box', '12px padding 不能把浮层再撑宽 26px')
assert.match(menu.get('bottom') || '', /100%/, '浮层仍然贴着触发 chip 向上开')
assert.match(menu.get('max-height') || '', /min\(/, '矮侧栏里浮层高度要有上限')
assert.notEqual(effectiveDecls('.drawai-video-settings').get('position'), 'relative', '定位上下文要交给 footer，不能是 chip 那一格')
assert.equal(effectiveDecls('.drawai-video-composer-footer').get('position'), 'relative', 'footer 必须是浮层的定位上下文')
assert.equal(effectiveDecls('.drawai-video-settings-menu>label').get('flex-wrap'), 'wrap', '窄宽度下标签与控件要能换行')
console.log('Motion UI: description, settings, references, task ownership, cancellation and scene editing passed.')
