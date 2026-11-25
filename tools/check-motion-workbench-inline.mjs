// 画布内剪辑视图的回归：会话身份、双挂载、返回/暂停、主题同步、窄栏属性面板与快捷键边界。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync('src/client.js', 'utf8')
const panel = readFileSync('src/motion-panel.js', 'utf8')
const runtime = readFileSync('src/motion/workbench-runtime.jsx', 'utf8')
const host = readFileSync('src/index.js', 'utf8')

function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, '找不到函数 ' + name)
  let depth = 0
  let began = false
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') { depth += 1; began = true }
    else if (source[index] === '}') {
      depth -= 1
      if (began && depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('函数没有闭合：' + name)
}

const sessionKey = new Function(functionSource(client, 'motionWorkbenchSessionKey') + '\nreturn motionWorkbenchSessionKey')()
assert.equal(sessionKey('s', 'a.drawai', 0, 'movie'), 's\na.drawai\n0\nmovie')
assert.notEqual(sessionKey('s', 'a.drawai', 0, 'movie'), sessionKey('s', 'a.drawai', 1, 'movie'), '换页必须换会话')
assert.notEqual(sessionKey('s', 'a.drawai', 0, 'movie'), sessionKey('s', 'a.drawai', 0, 'other'), '换节点必须换会话')
assert.notEqual(sessionKey('s', 'a.drawai', 0, 'movie'), sessionKey('s', 'b.drawai', 0, 'movie'), '换画布必须换会话')
assert.notEqual(sessionKey('s1', 'a.drawai', 0, 'movie'), sessionKey('s2', 'a.drawai', 0, 'movie'), '换 DSH 会话必须换会话')

const themeVars = {}
const themeStyle = { getPropertyValue(name) { return themeVars[name] || '' } }
globalThis.window = {
  location: { origin: 'http://drawai.test' },
  getComputedStyle: () => themeStyle,
  matchMedia: () => ({ matches: false }),
}
globalThis.document = { documentElement: {}, body: {} }
const helpers = new Function('React', 'motionCore', panel + '\nreturn { workbenchUrlWithTheme, hostWorkbenchTheme, workbenchToneOfHost }')(
  { useState() {}, useEffect() {}, useRef() {}, useCallback() {}, createElement() {} }, {},
)
assert.equal(helpers.workbenchUrlWithTheme('/drawai/workbench?token=abc', 'light'), '/drawai/workbench?token=abc&theme=light')
assert.equal(helpers.workbenchUrlWithTheme('/drawai/workbench', 'dark'), '/drawai/workbench?theme=dark')
Object.assign(themeVars, {
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-bg-overlay': '#fbfcfd',
  '--dsw-alias-border-l2': '#d8dde5',
  '--dsw-alias-label-primary': '#20242b',
  '--dsw-alias-label-secondary': '#6b7280',
  '--dsw-alias-brand-primary': '#2f6fed',
})
const light = helpers.hostWorkbenchTheme()
assert.equal(light.tone, 'light')
assert.equal(light.panel, '#fbfcfd')
assert.equal(light.accent, '#2f6fed')
Object.assign(themeVars, {
  '--dsw-alias-bg-base': 'rgb(20, 21, 25)',
  '--dsw-alias-bg-overlay': '#202126',
  '--dsw-alias-border-l2': '#353842',
  '--dsw-alias-label-primary': '#eceef2',
  '--dsw-alias-label-secondary': '#a4a8b0',
  '--dsw-alias-brand-primary': '#8b7cff',
})
const dark = helpers.hostWorkbenchTheme()
assert.equal(dark.tone, 'dark', '宿主底色为深色时加载页/剪辑页要切深色')
assert.equal(dark.border, '#353842')

// 同一 CanvasView 里画布与剪辑 iframe 始终挂载，返回只是隐藏。
assert.match(client, /const \[motionWorkbenchVisible, setMotionWorkbenchVisible\] = React\.useState\(false\)/)
assert.match(client, /if \(motionWorkbench && motionWorkbench\.key === key\) \{[\s\S]{0,160}setMotionWorkbenchVisible\(true\)/, '同一节点再次进入要复用现有 iframe，不再申请新会话')
assert.match(client, /motionWorkbench \? React\.createElement\(MotionWorkbenchInline/)
assert.match(client, /frameRef: motionWorkbenchFrameRef, visible: motionWorkbenchVisible/)
assert.match(client, /onDirtyChange: \(dirty\) => \{ motionWorkbenchDirtyRef\.current = dirty === true \}/)
assert.match(panel, /'data-visible': visible \? 'true' : 'false'/)
assert.match(panel, /display: visible \? 'flex' : 'none'/)
assert.match(panel, /data-drawai-workbench-frame/)
assert.match(panel, /drawai-workbench-back/)
assert.match(panel, /drawai-workbench-theme/)
assert.match(panel, /drawai-workbench-suspend/)
assert.match(panel, /drawai-workbench-resume/)
assert.match(client, /\.drawai-workbench-inline\{position:absolute;inset:0;/, '剪辑页必须铺满 DrawAI 标签内容区')
const railReturn = client.slice(client.indexOf("className: 'drawai-rail-wrap'"), client.indexOf('function fontSizeRow'))
assert.doesNotMatch(railReturn, /MotionWorkbenchInline/, '剪辑页不能挂在 48px 宽的右侧元素条容器里')
assert.match(client, /const motionWorkbenchLayer = motionWorkbench \? React\.createElement\(MotionWorkbenchInline/)
assert.match(client, /className: 'drawai-root',[\s\S]{0,2200}motionWorkbenchLayer,/, '剪辑页要挂在 .drawai-root 下，才能覆盖整个标签内容区')
assert.match(client, /function renderSelectionToolbar\(\) \{[\s\S]{0,180}motionWorkbenchVisible/, '剪辑页打开时必须卸载画布浮动工具条，否则 Popover 顶层会盖住 iframe')
const backSource = functionSource(client, 'backToCanvasFromWorkbench')
assert.match(backSource, /setMotionWorkbenchVisible\(false\)/)
assert.doesNotMatch(backSource, /setMotionWorkbench\(null\)/, '返回画布不能卸载剪辑 iframe')

// 切换页、换节点和关闭内部画布标签都走未保存保护；取消时原草稿继续。
const switchSource = functionSource(client, 'switchPage')
assert.match(switchSource, /if \(motionWorkbench\) \{[\s\S]{0,120}confirmCloseMotionWorkbench\(\)/)
assert.match(client, /const guard = closeGuardsRef\.current\.get\(key\)[\s\S]{0,420}typeof verdict\.then === 'function'/, '内部标签关闭要等异步确认')
assert.match(client, /onCloseGuard/)
assert.doesNotMatch(client, /window\.confirm\(/, 'DSH 插件 iframe 会忽略 window.confirm，未保存确认必须用画布内对话框')
assert.match(client, /function askMotionWorkbenchDiscard\(/, '未保存确认要返回 Promise')
assert.match(client, /className: 'drawai-motion-discard'/)
assert.match(client, /放弃修改并关闭/)
assert.match(client, /继续编辑/)

// DSH 外层标签关闭也必须按 tab.id / tab.contentId 找到当前画布的守卫。
const tabGuard = new Function(
  functionSource(client, 'motionWorkbenchHostGuardKey') + '\n' +
  functionSource(client, 'motionWorkbenchCloseGuardForTab') + '\n' +
  functionSource(client, 'pathFromAddress') + '\n' +
  'return { key: motionWorkbenchHostGuardKey, find: motionWorkbenchCloseGuardForTab }',
)()
const guards = new Map()
const dirtyGuard = () => false
guards.set(tabGuard.key('s1', 'tab:outer-tab'), new Set([dirtyGuard]))
const byTabId = tabGuard.find('s1', { id: 'outer-tab', contentId: 'sidebar://diagram' }, guards)
assert.equal(typeof byTabId, 'function', '页类型外层 tab 的 contentId 解析不出路径，必须仍能按 tab.id 找回守卫')
assert.equal(byTabId(), false, '外层关闭时未保存守卫必须拒绝关闭')
assert.equal(tabGuard.find('s2', { id: 'outer-tab', contentId: 'sidebar://diagram' }, guards), null, '守卫必须按会话隔离')

const pathGuards = new Map()
pathGuards.set(tabGuard.key('s1', 'path:D:/Work/A.drawai'), new Set([dirtyGuard]))
const byPath = tabGuard.find('s1', { contentId: 'dsh-resource://file/session/s1/D:/Work/A.drawai' }, pathGuards)
assert.equal(byPath(), false, '资源页仍要能按 contentId 找回守卫')
assert.equal(
  tabGuard.find('s1', { navigation: { address: 'dsh-resource://file/D:\\Work\\a.drawai' } }, pathGuards)(),
  false,
  '地址大小写/反斜杠差异不能绕过守卫',
)
assert.equal(tabGuard.find('s1', { contentId: 'D:/Work/B.drawai' }, pathGuards), null, '守卫必须按画布隔离')

const cleanGuard = () => true
const bothGuards = new Map()
bothGuards.set(tabGuard.key('s1', 'tab:outer-tab'), new Set([cleanGuard, dirtyGuard]))
assert.equal(tabGuard.find('s1', { id: 'outer-tab' }, bothGuards)(), false, '同一外层标签内的任一画布未保存都必须阻止关闭')

assert.match(client, /return registerMotionWorkbenchHostGuard\(sessionId, hostTabId, target, guardMotionWorkbenchHostClose\)/)
assert.match(client, /sidebarRight\.closeIn\(sessionId, hostTabId\)/, '外层标签确认放弃后要显式关闭宿主标签')
assert.match(client, /ctx\.sidebarRight\.registerCloseHandler\(KIND, \(sessionId, tab\) => \{[\s\S]{0,260}guard\(\) === false[\s\S]{0,160}throw new Error/)

// 工作台自己的单条主工具栏、属性抽屉、主题和快捷键边界。
assert.match(runtime, /aria-label="返回画布"/)
assert.match(runtime, /第 \{BOOT\.project\.page\} 页/)
assert.match(runtime, /drawai-workbench-dirty/)
assert.match(runtime, /drawai-workbench-applied/)
assert.match(runtime, /data-drawai-theme=light/)
assert.match(runtime, /\.wb-inspector\{position:absolute/)
assert.match(runtime, /\.wb-inspector\.open/)
assert.doesNotMatch(runtime, /if \(narrow\) setInspectorOpen\(true\)/, '窄栏选中片段不能自动展开属性抽屉，必须由用户按需打开')
assert.match(runtime, /max-height:46vh/)
const escapeAt = runtime.indexOf("if (event.key === 'Escape')")
const typingAt = runtime.indexOf('if (typing) return')
assert.ok(escapeAt >= 0 && typingAt > escapeAt, 'Esc 在剪辑区返回画布，但输入框内先失焦，不触发全局删除/撤销')
assert.match(runtime, /backToCanvas\(\); return/)
const windowKeyHandler = runtime.slice(runtime.indexOf('const onKey = (event) =>'), runtime.indexOf('window.addEventListener(\'keydown\', onKey)'))
assert.match(windowKeyHandler, /if \(typing\) return[\s\S]*ctrlKey[\s\S]*event\.code === 'Space'[\s\S]*Delete/)
assert.match(runtime, /onPointerDownCapture=\{focusWorkbench\}/, '时间轴 pointerdown 会 preventDefault，必须显式把键盘焦点收回剪辑区')
assert.match(runtime, /onPointerUpCapture=\{focusWorkbench\}/, '拖拽结束后也要把焦点收回剪辑区')
assert.match(runtime, /window\.focus\(\)/, '只 focus 元素不够，必须聚焦 iframe 的 browsing context')
assert.match(runtime, /tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'/, '聚焦剪辑区时不能抢输入框焦点')

// 宿主外壳：初始主题来自 URL，后续主题切换显式转发；加载页也能返回画布。
assert.match(host, /params\.get\("theme"\)/)
assert.match(host, /drawai-workbench-theme/)
assert.match(host, /drawai-workbench-back/)
assert.match(host, /page: session\.page \+ 1, canvas: session\.path/)

console.log('Motion inline workbench: keyed persistence, background export, dirty guards, theme and keyboard scoping passed.')
