// 视觉规范守卫：色彩只有一处来源，控件外观只有一套配方。
//
// 背景：2026-11 的视觉审计里，UI CSS 有 95 个色值、6 个"品牌色"并存、13 套输入框配方。
// P0/P1 把它们收进 :root 的 --drawai-* token 和两组 primitive。这组断言是为了防止回潮：
//  1) 每个 var(--drawai-*) 都要在 :root 里定义 —— 少一个，运行时就是无效声明，元素直接掉样式；
//  2) 裸品牌色不许再出现 —— 换肤/换强调色时它们不会跟着变；
//  3) 单行输入框必须走字段 primitive —— 否则 13 套描边/圆角/内边距又会各写一份。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

let checks = 0
let failures = 0
function ok(condition, label) {
  checks += 1
  if (condition) {
    console.log('  ✓ ' + label)
    return
  }
  failures += 1
  console.log('  ✗ ' + label)
}

// CSS 全在一个数组字面量里（const CSS = [...]），抽出来单独查。
const start = source.indexOf('const CSS = [')
const end = source.indexOf("].join('\\n')", start)
ok(start >= 0 && end > start, 'CSS 数组还在')
const css = start >= 0 && end > start ? source.slice(start, end) : ''

// 1) token 层自洽
const rootMatch = /:root\{([^}]*)\}/.exec(css)
ok(rootMatch !== null, '有 :root token 层')
const rootBody = rootMatch === null ? '' : rootMatch[1]
const defined = new Set([...rootBody.matchAll(/(--drawai-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
const used = new Set([...css.matchAll(/var\((--drawai-[a-z0-9-]+)/g)].map((m) => m[1]))
const missing = [...used].filter((token) => !defined.has(token))
ok(missing.length === 0, 'CSS 引用的 --drawai-* 都有定义' + (missing.length ? '（缺 ' + missing.join(', ') + '）' : ''))
ok(defined.size >= 12, 'token 层不是摆设（定义了 ' + defined.size + ' 个）')

// 2) 画布强调色与 UI 强调色同源
const accentInJs = /const ACCENT = '([^']+)'/.exec(source)
const accentInCss = /--drawai-accent:([^;]+);/.exec(rootBody)
ok(
  accentInJs !== null && accentInCss !== null && accentInJs[1] === accentInCss[1],
  '画布 ACCENT 与 CSS --drawai-accent 同值（' + (accentInJs === null ? '缺常量' : accentInJs[1]) + ' / ' + (accentInCss === null ? '缺 token' : accentInCss[1]) + '）',
)

// 3) 旧品牌色不许回来（历史上并存过 6 个蓝/紫）
const BANNED = ['#386bff', '#3370ff', '#4c8dff', '#2355ed', '#7c6df2', '#6956de']
const lowered = source.toLowerCase()
const leftovers = BANNED.filter((color) => lowered.includes(color))
ok(leftovers.length === 0, '没有残留的旧品牌色' + (leftovers.length ? '（还有 ' + leftovers.join(', ') + '）' : ''))

// 4) 字段 primitive 在，且没有规则绕过它给输入框另写裸色描边
ok(css.includes('height:var(--drawai-field-height)'), '单行输入框统一走 --drawai-field-height')
ok(css.includes('border:1px solid var(--drawai-border)'), '字段描边走 --drawai-border')
const offenders = [...css.matchAll(/([^{}]*?(?:input|select)[^{}]*)\{([^}]*)\}/g)]
  .filter(([, selector, body]) => /border(?:-color)?:\s*1px solid #[0-9a-f]{3,6}/i.test(body) && !/type=(?:range|checkbox|color|radio)/.test(selector))
  .map(([, selector]) => selector.trim().slice(-60))
ok(offenders.length === 0, '没有规则绕过 primitive 给输入框写裸色描边' + (offenders.length ? '：' + offenders.join(' ｜ ') : ''))

console.log('')
if (failures === 0) {
  console.log('check-design-tokens: 全部通过（共 ' + checks + ' 项）')
} else {
  console.log('check-design-tokens: ' + failures + ' 项失败')
  process.exitCode = 1
}
