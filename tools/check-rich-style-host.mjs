import assert from 'node:assert/strict'
import { clearRichTextOverrides } from '../src/index.js'

const html = '<div class="keep"><font color="red" size="5"><b>咖啡</b></font><span style="color: blue; font-size: 18px; font-weight: bold">时光</span></div>'
const color = clearRichTextOverrides(html, { color: true })
assert.doesNotMatch(color, /color\s*[:=]/i)
assert.match(color, /size="5"/)
assert.match(color, /font-size:\s*18px/)
assert.match(color, /<b>咖啡<\/b>/)
const size = clearRichTextOverrides(html, { size: true })
assert.doesNotMatch(size, /font-size|size="5"/i)
assert.match(size, /color="red"/)
assert.match(size, /color:\s*blue/)
assert.equal(clearRichTextOverrides('<b>unchanged</b>', { color: true }), '<b>unchanged</b>')
assert.throws(() => clearRichTextOverrides('<span style="font: italic 18px Arial">x</span>', { size: true }), /font 简写/)
assert.throws(() => clearRichTextOverrides('<span style="color:red;broken">x</span>', { color: true }), /无法安全/)
console.log('Rich host formatting: color and size are cleared independently; other formatting is retained')
