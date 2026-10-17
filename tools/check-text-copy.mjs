import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { composeClientBody } from './build.mjs'

const code = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const root = { contains() { return true }, focus() { document.activeElement = this } }
const window = { getSelection: () => selection }
let selection = null, systemText = '', copiedLabel = '', input, activeCalls = 0
const navigator = { clipboard: { async writeText(text) { systemText = text } } }
const document = {
  activeElement: root,
  createElement() {
    input = { tagName: 'TEXTAREA', style: {}, focus() { document.activeElement = this }, select() {}, remove() { this.removed = true } }
    return input
  },
  body: { appendChild() {} },
  execCommand(command) { assert.equal(command, 'copy'); systemText = input.value; return true },
}
const React = { Component: class {}, createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useState(initial) { return [initial, (value) => { copiedLabel = value }] }, useEffect() {} }
const mod = { exports: {} }
const api = new Function('module', 'exports', 'require', 'window', 'document', 'navigator', composeClientBody() +
  '\nreturn { ...module.exports.__routeInternals, writeClipboardText, CopyableStatus }')(mod, mod.exports, () => React, window, document, navigator)
const noteElement = { closest(selector) { return selector.includes('drawai-note') ? this : selector === '.drawai-root' ? root : null } }
const noteText = { nodeType: 3, parentNode: noteElement }
selection = { anchorNode: noteText, toString: () => 'FFmpeg 编码失败：Permission denied\n完整报错' }
assert.equal(api.hasTextSelectionInPane(root), true)
assert.equal(api.canvasOwnsKeyboard({ target: root }, root, root), false, 'selected status text is not replaced by object shortcuts')
assert.equal(api.canvasOwnsKeyboard({ target: noteElement }, root, root), false)
api.claimCanvasKeyboard({ focus() { activeCalls++ } }, noteElement)
assert.equal(activeCalls, 0, 'selecting a status message never steals focus')
selection = null
assert.equal(api.canvasOwnsKeyboard({ target: root }, root, root), true, 'object shortcuts resume after text selection is cleared')
const error = '节点 9 · 媒体操作失败：FFmpeg 编码失败\nC:\\Temp\\output.mp4: Permission denied'
const status = api.CopyableStatus({ text: error })
await status.children.find((child) => child.type === 'button').props.onClick()
assert.equal(systemText, error, 'one-click copy contains the entire error including newlines and paths')
assert.equal(copiedLabel, '已复制')
navigator.clipboard.writeText = async () => { throw new Error('not a secure context') }
await api.writeClipboardText('HTTP 环境也能复制')
assert.equal(systemText, 'HTTP 环境也能复制')
assert.equal(input.removed, true)
assert.equal(document.activeElement, root)
document.execCommand = () => false
await status.children.find((child) => child.type === 'button').props.onClick()
assert.match(copiedLabel, /复制失败/, 'copy button reports clipboard denial without replacing the original error')
assert.equal(input.removed, true)
assert.equal(status.children[0].children[0], error)
const doc = { nodes: [{ id: 'a', label: '第一段\n第二段', style: '' }], edges: [], layers: [] }
assert.equal(api.clipboardLabelText({ nodes: [...doc.nodes, { label: '视频隐藏标题', data: { drawaiMedia: '1', mediaKind: 'raster', mediaClip: 'clip' } }], edges: [{ label: '连接说明' }] }), '第一段\n第二段\n连接说明')
const copyRegion = code.slice(code.indexOf('    function ownsCopyCut(event) {'), code.indexOf("    document.addEventListener('copy', onCopy"))
const context = { active: true, canvasOwnsKeyboard: api.canvasOwnsKeyboard, rootRef: { current: root }, document,
  selectedIds: ['a'], docRef: { current: doc }, collectClipboard: api.collectClipboard, clipboardLabelText: api.clipboardLabelText,
  setMenu() {}, setSaveNote() {}, deleteSelected() {} }
const handlers = new Function(...Object.keys(context), 'let clipboard = null;\n' + copyRegion + '\nreturn { onCopy, onCut, clipboard: () => clipboard }')(...Object.values(context))
let prevented = false, plainText = null
const event = { target: root, clipboardData: { setData(type, value) { assert.equal(type, 'text/plain'); plainText = value } },
  preventDefault() { prevented = true }, stopPropagation() {} }
handlers.onCopy(event)
assert.equal(plainText, '第一段\n第二段', 'object copy places actual labels on the system clipboard')
assert.equal(handlers.clipboard().nodes[0].id, 'a', 'copy retains structured objects for canvas paste')
assert.equal(prevented, true)
selection = { anchorNode: noteText, toString: () => '选中的报错' }
prevented = false; plainText = null
handlers.onCopy(event)
assert.equal(prevented, false, 'native text copy is not intercepted even when canvas nodes are selected')
assert.equal(plainText, null)
selection = null
const hiddenContext = { ...context, active: false }
const hiddenHandlers = new Function(...Object.keys(hiddenContext), 'let clipboard = null;\n' + copyRegion + '\nreturn { onCopy, onCut }')(...Object.values(hiddenContext))
hiddenHandlers.onCopy(event)
assert.equal(prevented, false, 'hidden canvases cannot overwrite the active pane clipboard')
assert.equal(plainText, null)
console.log('check-text-copy: OK (native text selection, status copy button, Clipboard API fallback, real label text and structured canvas clipboard)')
