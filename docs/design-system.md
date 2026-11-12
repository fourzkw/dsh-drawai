# 视觉规范（UI 设计系统）

这份文档只讲**插件界面自己**的视觉规范：右侧栏、面板、菜单、工具条、弹层。
画布里的东西（节点填充色、连线颜色、字体大小）属于**文档内容**，不在这里——它们会随
`.drawai` 文件导出、跟着用户走，见 `docs/design.md`。

## 为什么要有它

2026-11 的视觉审计里，UI CSS 有 95 个色值、6 个"品牌色"并存（`#386bff`、`#1a73e8`、
`#4c8dff`、`#3370ff`、`#2355ed`、`#7c6df2`）、13 套单行输入框配方（边框灰 6 种、圆角
5/6/7、内边距 4~7px）、15 种互不相同的阴影。问题不是"难看"，而是**换一处不知道要改几个地方**：
宿主切暗色时，写死的浅色面就半亮半暗；想调主色，得在两百条规则里找。

现在所有颜色、圆角、字号、阴影、动效都只有一个来源：CSS 数组末尾的 `:root` token 块
（`src/client.js` 的 `const CSS = [...]`）。

## Token 表

语义色优先吃宿主变量 `--dsw-*`，括号里是没有宿主时的兜底值。宿主（DSH / 飞书侧边栏）
提供变量时会自动跟随明暗主题。

| token | 值 | 用在哪 |
| --- | --- | --- |
| `--drawai-accent` | `#1a73e8` | 强调色：选中态、焦点环、主按钮、进度条、开关。**与画布 `ACCENT` 常量同值**，改色两处一起改 |
| `--drawai-accent-soft` | `rgba(26,115,232,.14)` | 强调色的浅底（选中 chip、`.on` 按钮底） |
| `--drawai-focus-ring` | `0 0 0 3px rgba(26,115,232,.22)` | 键盘焦点的外环，只给 `:focus-visible` |
| `--drawai-surface` | `var(--dsw-alias-bg-overlay, #ffffff)` | 浮层/输入框底 |
| `--drawai-surface-sunken` | `var(--dsw-alias-bg-layer-1, #ffffff)` | 凹陷底（按钮、工具条） |
| `--drawai-hover` | `var(--dsw-alias-bg-hover, #f2f1f5)` | 悬停/按下底 |
| `--drawai-border` | `var(--dsw-alias-border-l2, #e1e3e8)` | 控件描边、分隔线 |
| `--drawai-text` | `var(--dsw-alias-label-primary, #282c35)` | 主文字 |
| `--drawai-text-muted` | `var(--dsw-alias-label-secondary, #737a86)` | 次要文字、说明 |
| `--drawai-radius-sm` | `4px` | 小控件（重命名框、搜索框） |
| `--drawai-radius-md` | `6px` | 默认：输入框、按钮、chip |
| `--drawai-radius-lg` | `12px` | 卡片、面板、菜单、弹层 |
| `--drawai-radius-pill` | `999px` | 药丸/圆：圆形按钮、分段控件 |
| `--drawai-text-xs` ~ `xl` | `11 / 12 / 13 / 16 / 24px` | 字号阶梯，见下 |
| `--drawai-field-height` | `30px` | 单行输入框/下拉的高度 |
| `--drawai-field-padding` | `4px 8px` | 单行输入框内边距（compact 变体用 `4px 8px` + `radius-sm`） |
| `--drawai-font-size` | `var(--drawai-text-sm)` | 控件正文（=12px），新规则优先用它 |
| `--drawai-elevation-1/2/3` | 三档阴影 | 1=轻浮起（气泡、内联卡片）2=浮层（菜单、弹层、工具条）3=遮罩上的模态 |
| `--drawai-duration-fast/base` | `120ms / 160ms` | 过渡时长 |
| `--drawai-ease` | `cubic-bezier(.2,.8,.2,1)` | 过渡缓动 |
| `--drawai-disabled-opacity` | `.45` | 禁用态唯一透明度 |

## 尺度

**字号**只有五档：`11`（微标/注脚）、`12`（正文/控件）、`13`（小标题、视频工作台的按钮）、
`16`（面板标题）、`24`（大号图标字形，如调色板「+」）。不允许 9/10/14/15/18/20px。

**圆角**只有四档：`4`（小控件）、`6`（默认）、`12`（卡片/面板/菜单）、`999`（药丸与圆）。
`50%` 只用于正方形图标按钮。

**间距**（padding / margin / gap）只允许落在 `2 / 4 / 6 / 8 / 10 / 12 / 16 / 24`。
间距不设 token——阶梯值本身就是规范，`check-design-tokens` 会直接拦掉越界值。

**阴影**只允许三档 elevation（+ `none` + `--drawai-focus-ring` + 描边式的 `inset 0 0 0 1px`）。
不允许自己调 `0 6px 24px #20273820` 这种一次性配方。

**动效**只允许两个时长 + 一条缓动。`@keyframes` 的循环动画（`drawai-flow` / `drawai-pulse` /
`drawai-spin`）是内容语义的一部分，时长可以单独定。

## 控件只有两套配方

- **单行输入框 / 下拉**：`.drawai-audio-panel input`、`.drawai-imagegen-field input`、
  `.drawai-motion-panel input`、`.drawai-style-control input`、`.drawai-palette-add input`、
  `.drawai-font-custom input`、`.drawai-page-picker select`、`.drawai-layer-move select`、
  `.drawai-export-field input`、`.drawai-export-dimension input`、
  `.drawai-video-settings-menu input` 等共用一条 primitive；焦点态也共用一条。
  新面板加了输入框，**把它加进这两条选择器列表**，不要另写描边/圆角/内边距。
- **按钮**：`.drawai-btn`、`.drawai-audio-panel button`、`.drawai-video-controls button/select`、
  `.drawai-video-more summary` 共用外观；高度和内边距由各家族自己定（工具条比面板按钮矮得多）。
- 内嵌在面板行里的小输入框（`.drawai-layer-name-input`、`.drawai-panel-input`）用 compact 变体。
- 勾选框/单选框不属于字段 primitive，有专门的复位规则。

## 交互态

| 状态 | 约定 |
| --- | --- |
| `:hover` | 底色 → `--drawai-hover`；描边要变就 → `--drawai-accent` |
| `:active` | 统一 `transform:translateY(1px)`，可点元素再叠一层 `--drawai-hover`（transform 不影响布局） |
| `:disabled` | 只有一种写法：`opacity:var(--drawai-disabled-opacity)`；光标按语义给 `default` / `wait` |
| `:focus-visible` | 键盘可达的控件必须有：`box-shadow:var(--drawai-focus-ring)`（输入框额外把描边换成 accent） |
| `prefers-reduced-motion` | 已有全局降级块：动画/过渡压到 1ms，只作用于 `.drawai-root` 子树，不影响宿主 GUI |

## 校验

`npm test` 里的 `tools/check-design-tokens.mjs` 会拦这些：

1. 用了 `var(--drawai-*)` 但 `:root` 里没定义（运行时是无效声明，元素直接掉样式）；
2. 6 个旧品牌色回潮；
3. 画布 `ACCENT` 与 `--drawai-accent` 不同值；
4. 单行输入框绕过 primitive 自己写裸色描边；
5. 字号 / 圆角 / 间距 / 阴影 出现阶梯外的值。

要加新值，先问「现有五档/四档够不够」。真的不够就改这条规矩本身（加一档 → 同时改
`:root`、这份文档、`check-design-tokens.mjs` 的白名单），不要某个面板偷偷写个 `13px`。

## 已知的例外（不该 token 化）

- **画布内容色**：`LINK_BLUE`（drawio 超链接默认蓝）、`src/style-kernel.js` 的 `PALETTE`、
  `LIGHT`/`DARK` 两套画布皮肤。它们属于文档内容，会进导出、随着文件走，不跟 UI 主题变。
- **深色遮罩上的白色**：视频播放器 `play` / `chrome` / `message` 叠在 `rgba(0,0,0,.75)` 上，
  明暗主题下都该是白的。
- **状态色**：错误/警告用宿主 `--dsw-alias-state-error-primary`，没有兜底成品牌色。
