# 在 DSH 中实现「drawio 式画布 + AI 自动绘制」插件 —— 方案

> 目标：做一个 DSH 插件，提供类似 drawio 的图形编辑画布，并且能让 AI 直接绘制/修改图。
> 本文回答三个问题：**窗口放在什么地方**、**入口放在什么地方**、**如何与 DSH 兼容**。
>
> 所有结论都基于对本机 DSH 安装（`@deepseek-ai/dsh@0.1.5-rc.1`）和已装第三方插件的实际勘察，证据路径在文中标注。
>
> 📎 配套文档：`附录-DSH客户端插件API速查.md` —— 61 个 slot 的完整清单、`SidebarRightTabDefinition` / `useTabInfo()` / `ctx.sidebarRight` 的逐字段契约、静态模块表、HMR 链路。本文引用它而不重复它。

---

## 0. 结论速览（TL;DR）

| 问题 | 答案 |
|---|---|
| **窗口放在哪** | 注册成一个 **DSH 原生右侧栏的 tab type**（`ctx.sidebarRightTabs.register`）。这是 0.1.5 起的官方扩展点，自带 dock / 分屏 / 浮动 / 每会话持久化。需要"独立窗口"时用 `ctx.sidebarRight.float(tabId, rect)`，**不要自己画右侧栏或开自由窗口**——上游生态已经明确废弃了那条路。 |
| **人类入口放哪** | 三处，都来自同一个 tab type 定义：① 右侧栏 guide 页的一个入口卡片（`guide: [{order,title,description,icon}]`）；② 用 `patterns: ['**/*.drawio','**/*.dshd.json']` 认领文件地址，点文件树里的图就进画布；③ 设置页一个 section（开关/引擎/主题）。 |
| **AI 入口放哪** | host 侧用 `ctx.tools.register(defineTool({...}))` 注册 `diagram_*` 工具集，插件行插在 profile 的 `cordis.patch.yml`（宿主平面 = 全局层，所有 agent 继承）或某个 agent preset 里。另有一个**零安装**的临时路：用现成的 `cordis_define`/`cordis_run` 让 AI 在会话里动态注册 UI。**最小可行路线根本不需要自定义工具**——AI 直接用 fs 工具改图文件即可。 |
| **如何与 DSH 兼容** | 走"**文件即真相源 + change feed 驱动重绘**"，而不是自建 host→client 推送。AI 用 fs 工具（或 `diagram_apply`）写文件 → DSH 自带的 workspace 文件变更流通知画布 → 画布重读重绘。人和 AI 走同一条路径，天然协作、天然进 session log。 |
| **最容易踩的坑** | ① `lib/client.js` 必须预先构建，client-modules 只服务构建产物；② 不要打包第二份 React（shell 冻结表已提供）；③ React 18 + tsdown；④ 版本按 rc 对齐。 |

---

## 1. 勘察到的事实基线

这些是我在机器上实际读到的，不是推测。

### 1.1 DSH 的扩展点总览

DSH 的宿主框架是 **Cordis**（`@deepseek-ai/cordis`）：一切能力都是 `cordis.yml` 里的一行插件，插件导出 `apply(ctx, config)`。

| 层 | 包 | 作用 |
|---|---|---|
| 工具注册表 | `@deepseek-ai/dsh-tools` | `ctx.tools.register(defineTool({...}))`，注册模型可调用的工具 |
| 右侧栏 | `@deepseek-ai/dsh-client-ui-sidebar-right` | `ctx.sidebarRightTabs`（注册 tab 类型）、`ctx.sidebarRight`（打开/浮动/分屏） |
| 槽位 | `@deepseek-ai/dsh-client-ui-slots` | `ctx.slots.register({name,key}, Component)`，**共 61 个 slot**（见附录） |
| 客户端模块 | `@deepseek-ai/dsh-client-modules` | 把 `package.json` 的 `dsh.client` 声明编译成 boot graph，通过 `/plugins` 提供 bundle |
| 客户端 HMR | `@deepseek-ai/dsh-client-hmr` | 500ms 轮询 bundle 时间戳 → SSE `/plugins/events` → 浏览器重挂载 |
| 工作区文件 | `@deepseek-ai/dsh-api-workspace-files` | `workspaceFiles.list/stat/read` + **agent 写入变更流** `workspaceFiles.changes` |
| 宿主 HTTP | `@deepseek-ai/dsh-host-webserver` | `webServer.register({kind,path,handler})` / `registerUpgrade`（WebSocket） |
| 交付物 | `@deepseek-ai/dsh-tool-present` | 把产物发布到 UI（deliverables 卡片） |
| 动态插件 | `@deepseek-ai/dsh-tool-cordis` + `dsh-cordis-host-runner` | 让**模型**在会话内定义临时插件（含 browser half） |

证据：`node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` 第 201–350 行是完整的浏览器插件名册；slot 目录数据在 `dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API`。

### 1.2 关键：右侧栏是原生 API（0.1.5-rc.1+）

`dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`：

```ts
export interface SidebarRightTabDefinition {
  readonly id: string;                              // 实现标识，也是 slot 的 key
  readonly kind: string;                            // 类型判别式，openTab 用它
  readonly patterns?: readonly string[];            // 认领的资源地址 glob
  readonly priority?: 'extension' | 'builtin' | 'fallback';  // 默认 extension（最高）
  readonly canOpen?: (address: string) => boolean;  // 一票否决
  readonly title: (address: string) => string;      // tab chip 初始文案
  readonly guide?: readonly SidebarRightGuideEntry[];  // guide 页入口卡片
}

class SidebarRightTabRegistry {
  register(definition: SidebarRightTabDefinition): () => void;   // 幂等 disposer
}
```

`.../client/service.d.ts` 的控制器面（`ctx.sidebarRight`）：

```ts
openResource(address, options?)   // 按 dsh-resource:// 地址认领并打开（会自动展开右栏）
openTab(kind, options?)           // 按 kind 打开一个"页"类型
close(tabId) / active() / isExpanded() / toggleExpanded() / focus(tabId)
split(paneId?)                    // 分屏，返回新 paneId
float(tabId, rect?)               // ★ 把 tab 变成浮动面板 = "独立窗口"
dock(paneId)                      // 收回
```

两个 slot 承载界面，key 就是定义里的 `id`：

- `sidebar.right.pane.tab` —— tab 主体
- `sidebar.right.pane.tab.title` —— chip 标题内容

> 生态佐证：`dsh-better-sidebar` v0.19 的 README 明说 *"Own right panel and free windows retired"*——它把自绘右栏拆掉，改成注册进 DSH 原生右栏。**跟着走，别逆着走。**

### 1.3 现成的最佳模板

| 模板 | 位置 | 学它什么 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-sidebar-files` | DSH 安装目录 | **最小完整的右栏 tab 类型**：`ctx.sidebarRightTabs.register({kind:'files',...})` + 两个 slot，7 个源文件 |
| `dsh-better-sidebar` | `C:\Users\86476\.dsh\profiles\web\node_modules\dsh-better-sidebar` | 第三方 bundle 的完整形态：`dsh.bundle.patch` + `dsh.client` + host half + 懒加载重依赖 + 自带 `/sidebar/api` 路由 |
| `dsh-cost-meter` | 同目录 | `dsh.compatibility` 字段声明、双语、typert 路由 |

### 1.4 本机 profile 现状

`C:\Users\86476\.dsh\profiles\web\package.json`：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "dshmarket", "dsh-better-sidebar", "dsh-context",
  "dsh-dream-skin", "dsh-cost-meter", "@liustack/modsearch"
], "patchReload": "live" } }
```

- `ui-sidebar-right` / `ui-cordis` / `cordis-host-runner` / `cordis-client-runner` / `client-hmr` **都已挂载**。
- `agent-presets` 默认 `standard`；`cordis` preset 里已经有 `@deepseek-ai/dsh-tool-cordis`。

---

## 2. 总体架构

```
┌──────────────────────── 浏览器 (browser half) ─────────────────────────┐
│                                                                        │
│  右侧栏 (DSH 原生)                                                      │
│  ┌──────────────────────────┐   tab type: kind='diagram'                │
│  │ [图标] flow.dshd         │   ← sidebar.right.pane.tab.title          │
│  ├──────────────────────────┤                                          │
│  │                          │                                          │
│  │    画布（mxGraph /       │   ← sidebar.right.pane.tab  (懒加载引擎)  │
│  │    react-flow / mermaid) │                                          │
│  │                          │   可 float() 变浮动面板，可 split() 分屏   │
│  └──────────────────────────┘                                          │
│           ▲                        │                                   │
│           │ ChangeFeed.follow      │ 拖拽编辑 → 写回文件                 │
│           │ (agent 写入通知)        ▼                                   │
└───────────┼────────────────────────┼───────────────────────────────────┘
            │                        │  Typert Remote (client→host)
┌───────────┼────────────────────────┼───────────────────────────────────┐
│           │      宿主 (host half, Node / Cordis)                        │
│           │                        │                                   │
│   workspaceFiles 变更流 ◄───────────┘                                   │
│           ▲                                                            │
│           │ 文件写入                                                    │
│   ┌───────┴────────┐        ┌──────────────────┐                       │
│   │  <name>.dshd   │◄───────│ AI: fs 工具       │  零成本路径            │
│   │  (JSON/XML)    │◄───────│ AI: diagram_*    │  语义化路径            │
│   └────────────────┘        └──────────────────┘                       │
│                                                                        │
│   注册: ctx.tools.register()  → 模型工具面板                            │
└────────────────────────────────────────────────────────────────────────┘
```

**一句话**：图的真相源是工作区里的一个文件；AI 和人都改这个文件；右栏画布订阅变更流自动重绘。

---

## 3. 窗口放在哪里（详细）

### 3.1 选择：DSH 原生右侧栏的 tab type

注册一个 `kind: 'diagram'` 的类型，作为一个**页类型 + 资源认领者**双身份存在：

```tsx
// src/client/definition.tsx
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DiagramIcon } from './icons.tsx'

export const ID = 'drawai:diagram'

export const definition: SidebarRightTabDefinition = {
  id: ID,
  kind: 'diagram',

  // ① 文件认领：点文件树里的 .dshd / .drawio 直接进画布
  patterns: ['**/*.dshd.json', '**/*.drawio'],
  priority: 'extension',            // 默认值，声明出来更明确：比内置文本预览优先
  canOpen: (address) => address.startsWith('dsh-resource://file/'),

  // ② tab chip 文案
  title: (address) => basename(address),

  // ③ guide 页入口卡片（人类入口之一）
  guide: [{
    order: 30,
    title: () => t('diagramGuideTitle'),
    description: () => t('diagramGuideDesc'),
    icon: DiagramIcon,
  }],
}
```

```tsx
// src/client/index.tsx
const name = 'drawai'
const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'workspaceFiles', 'locale']
export { name, inject, apply }
// （本地包用 export const Config = ... 声明配置；无配置可省）

function apply(ctx: Context) {
  // ① 注册 tab 类型；ctx.effect 保证插件卸载时自动回收
  ctx.effect(() => ctx.sidebarRightTabs.register(definition))

  // ② 主体：keyed slot，key = definition.id
  //    必须包在 slots.inject 里：该 seat 只在 rightbar.session 挂载时才存在
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ID },
    CanvasBody,
  )))

  // ③ chip 标题。不注册也行 —— 此时 chip 显示 registration 的
  //    title(address) 在打开时捕获的文案。
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: ID },
    CanvasTitle,
  )))
}
```

> 上面这个 `ctx.effect(() => ctx.slots.inject(key, () => ctx.slots.register(...)))` 形状不是我编的——`dsh-client-ui-sidebar-documentpreview/lib/client.js:1361` 就是这个写法，照抄即可。

**slot 契约**（从 DSH 自动生成的 client slot 目录读到的原文）：

| 属性 | 值 |
|---|---|
| `sidebar.right.pane.tab` | `keyed` / `session` 作用域；register 必传 `key`；同 key 重注册会**替换**占位者 |
| 已占位者 | `TextPreview`(documentpreview)、`FilesBody`(sidebar-files)、`GuideBody`(sidebar-right) |
| replaceRisk | `none`（纯增量，不覆盖内置 UI） |
| `standardProps`（组件能拿到的） | `useSessions`、`useSession`、`sessionId: SessionId`、`useResource`、`usePanelInfo`、`useChat`、`useConversation`、`useProjection`、`useTrajectory`、`useInput`、`inputActions` |
| `hookContext` | `TabHookContext` |
| `slotInject` | `SidebarRightTabInjected` |
| `declaredBy` | `rightbar.session` 的一个 entry（即右侧栏挂载时才有这个 seat） |

> 注意：**没有** `ownerProps` —— body 不通过 props 直接收 tab 对象。运行时信息由框架注入的 **`useTabInfo()`** 给（`contract/slots.d.ts:117-139`）：
>
> ```ts
> const { sidebar, panel, tab } = useTabInfo()
> // sidebar: { expanded, fullscreen }
> // panel:   { id: PaneId }
> // tab: TabRecord & {
> //   visible: boolean
> //   navigation: { address, params, revision }
> //   signal: AbortSignal                      // ← 用它做生命周期收尾（store 分桶、取消订阅）
> //   actions: { openResource(address, opts?), openTab<K>(kind, opts?), close() }
> // }
> ```
>
> `tab.actions.*` 永远指向 **tab 自己所属的会话**，所以用户切了会话之后回调也不会打错地方。这就是"每个 tab 一份状态、绑 `tab.signal`"的落点。

### 3.2 "独立窗口"怎么办

不要开新浏览器窗口/自绘浮层。DSH 原生支持**浮动面板**：

```ts
ctx.sidebarRight.float(tabId, { x, y, width, height })  // 把画布 tab 拎成浮动面板
ctx.sidebarRight.split(paneId)                          // 或者右侧栏内分成两栏
ctx.sidebarRight.dock(paneId)                           // 收回去
```

好处全白拿：位置记在每会话的 layout store 里、会话切换自动恢复、拖拽/缩放/层级都由 dockkit 管。

**如果确实要真正的浏览器级独立窗口**（多显示器、可移出主窗口），那属于 Electron/desktop 路线，DSH 把 `desktop` profile 名保留给了 Electron。建议 v1 不做。

### 3.3 也可以顺带做文件预览器（可选增强）

如果用户装了 `dsh-better-sidebar`，它还提供 `ctx.betterSidebar.registerFileViewer({ id, exts, fetchStrategy, load, component })`——可以在它的底部工作台里再加一个 `.dshd` 预览器。但这属于**可选适配层**，不是主路径，别把架构依赖压在第三方插件上。

---

## 4. 入口放在哪里（详细）

### 4.1 人类入口（三条，都零额外代码成本）

| 入口 | 机制 | 用户动作 |
|---|---|---|
| guide 页卡片 | `definition.guide[]` | 右栏空态点"画布"图标 |
| 文件认领 | `definition.patterns[]` | 在文件树/对话里的文件引用上点 `flow.dshd.json` |
| 设置页 | `dsh-client-ui-settings` 注册 section | 设置 → 插件 → DrawAI：引擎、主题、是否让模型开画布 |

另外，AI 的 `present` 工具产出的文件卡片如果指向 `.dshd.json`，点击也会经 `openResource` 落到画布 tab（因为地址认领是全局的）。

### 4.2 AI 入口：host 侧工具集

**注册位置**：host half 的 `apply(ctx)` 里调 `ctx.tools.register(...)`。

```ts
// src/tool/apply.ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export const diagramApply = defineTool({
  name: 'diagram_apply',
  description: '对会话工作区里的画布文档施加一组结构化编辑（加节点/连边/改标签/删除/自动布局），返回新版本号。',

  // 注意：这不是裸 JSON Schema，是 DSH 的 ParameterSchemaSpec DSL
  // 类型只有 string|number|integer|boolean|null|array|object|json|oneOf
  // object 节点【必须】写 additionalProperties
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', required: true, description: '工作区相对路径，如 docs/flow.dshd.json' },
      ops:  { type: 'array', required: true, items: { type: 'json' },
              description: 'addNode | addEdge | setLabel | remove 的数组' },
      layout: { type: 'string', enum: ['dagre-lr', 'dagre-tb', 'grid', 'none'], description: '自动布局，默认 dagre-lr' },
    },
  },

  output: {
    // 返回值必须严格匹配这个 schema
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { revision: { type: 'number' }, nodeCount: { type: 'number' } },
    },
    // render 把规范值投影成模型看到的内容
    render: (args, value) => [{ type: 'text', text: `已更新 ${args.path}，revision=${value.revision}，节点 ${value.nodeCount} 个` }],
  },

  // 声明式超时（由 dsh-tool-call-timeout-policy 强制；要求实现真的转发 exec.signal）
  timeoutMs: 30_000,

  async execute(args, exec) {
    // args 是冻结的、lossless 快照过的模型参数
    // exec: { callId, rootCallId, name, arguments, agent?, parent?, signal, token, ... }
    const doc = await readDoc(ctx, args.path)          // ctx.fs.readText
    const next = applyOps(doc, args.ops)               // 语义校验：边引用了不存在的节点 → 抛错
    const laid = args.layout === 'none' ? next : autoLayout(next, args.layout)
    await writeDoc(ctx, args.path, laid)               // ctx.fs.writeText（原子写）
    return { revision: laid.revision, nodeCount: laid.nodes.length }
  },

  presentCall: (args) => ({ card: 'generic', title: `绘制 ${args.path}` }),
})
```

```ts
// src/index.ts（host half 出口）
import z from '@deepseek-ai/schemastery'

const name = 'drawai'
const inject = ['tools', 'fs', 'systemPrompt']   // 硬依赖，缺一个就不激活
const Config = z.object({
  maxNodes: z.number().default(500),
  defaultLayout: z.string().default('dagre-lr'),
})

function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register(diagramApply))
  ctx.systemPrompt.section({ name: 'tool:diagram', order: 120, text: '...' })
}

export { name, inject, Config, apply }   // ← 所有参考包都用这个精确形式
```

**返回值/错误契约**：`execute` 只返回匹配 `output.schema` 的规范 JSON 值，`render` 负责投影给模型。抛错会被规范化成 `{ content:[{type:'text',text:'Error: ...'}], isError:true }`；只有 `HarnessError` 子类才会带上 `error.info`。

建议的工具集（**先窄后宽**）：

| 工具 | 作用 | 优先级 |
|---|---|---|
| `diagram_apply` | 结构化增删改 + 自动布局。**比让模型直接吐 JSON 稳得多**（自动布局兜底，模型不用算坐标） | P0 |
| `diagram_read` | 读回当前图（节点 id / 边 / 标签），供多轮迭代 | P0 |
| `diagram_open` | 让 AI 主动把画布推到用户眼前（对标 `dsh-better-sidebar` 的 `sidebar_open`） | P1 |
| `diagram_export` | 导出 SVG / PNG / `.drawio` | P2 |

**关键设计点**：`diagram_apply` 的价值不在"能写文件"（fs 工具也能），而在①**自动布局**（模型不算坐标）、②**语义校验**（边引用了不存在的节点直接报错，而不是画出一张烂图）、③**稳定的 id 分配**（多轮迭代不会打乱图）。

### 4.3 工具行挂在哪个平面

Web profile 把**模型可见的工具行**从宿主平面移走了（见 `dsh-web-app/cordis.patch.yml` 第 351–471 行：`tool-fs`、`tool-pwsh`、`tool-todo`、`tool-web`… 全部 `disabled: true`），改由每会话的 agent preset 重新挂载。看到这个很容易误以为"第三方工具必须写进 preset"——**不是的，两条路都通**：

| 路线 | 怎么写 | 效果 |
|---|---|---|
| **宿主平面（推荐，最省事）** | `$DSH_HOME/profiles/web/cordis.patch.yml` 里 `insert:` 一行 | `ToolRuntime.register` 按调用作用域分层，宿主 ctx 没有 agent 作用域 ⇒ 落进**全局层**，**每个 agent 都继承** |
| **preset 平面** | `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` 加一行 | 只有用这个 preset 的会话看得见；`standard` / `cordis` 都行 |

```yaml
# 路线 A：$DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: tool-diagram
      name: 'dsh-drawai'        # dsh plugin --profile web add 之后
      config:
        maxNodes: 500
```

```yaml
# 路线 B：~/.dsh/.agent-presets/<你的preset>/agent.cordis.yml
- id: tool-diagram
  name: 'dsh-drawai'
```

⚠️ preset 是**只允许复制**的（copy-only authoring）：从 `standard` 或 `cordis` 复制一份再改，别改官方目录——升级会覆盖它，改坏 `cordis` preset 会让你连自救模式都进不去。

⚠️ 设置页的 Plugins 页**只列宿主平面、且不能增删启停**（`dsh-client-ui-settings-plugins` README 明说 "cannot enable, disable, add, or remove plugins"）。安装只能靠 `dsh plugin` + patch 文件。

**第三条路（M0 最小可行）**：根本不用自定义工具——让 AI 直接用现成的 `read`/`write`/`edit` 工具改 `.dshd.json`。**一行工具代码都不用写**，只要画布能订阅变更流。建议从这里起步。

### 4.4 零安装的动态入口（原型/临时图）

本机 `cordis` preset 已经挂了 `@deepseek-ai/dsh-tool-cordis`。切到这个 preset，AI 就能用：

- `cordis_inspect_query` —— 查 slot / service 的真实契约
- `cordis_define` —— 定义一个含 **browser half** 的临时包
- `cordis_run` —— 激活（浏览器半边需要用户点同意）

**能力**：browser half 可以注册 slot（含右栏）。
**限制**（README 明写）：纯 JavaScript，**没有 TypeScript / JSX / import**；沙箱不给 `require`/`setTimeout`/`fetch`；会话级、进程内，重启即消失。

**结论**：适合做 M0 的可行性验证和"这个会话临时画一张图"，**不适合**当产品形态。产品还是走持久化插件包。

---

## 5. AI 自动绘制的数据流（兼容性的核心）

### 5.1 不要自建 host→client 推送

DSH 已经有现成通道：

| 方向 | 机制 |
|---|---|
| client → host | Typert Remote（`@deepseek-ai/dsh-api-remotes` + 包内 `<name>/typert` 导出） |
| host → client（文件） | `workspaceFiles.changes` 流；客户端 `ChangeFeed.follow(sessionId, signal)` 拿到 `AsyncIterable<WorkspaceFileNotice>` |
| host → client（自定义） | `ctx.webServer.register(...)` + `registerUpgrade(...)`（WS），像 `dsh-better-sidebar` 的 `/sidebar/api` |

`change-feed.d.ts` 原文：*"The Host reports every agent write in a session on one stream; each open file wants only its own."*

### 5.2 推荐数据流

```
AI 调 diagram_apply(ops)
   └─ host: 读 .dshd.json → 应用 ops → 自动布局 → 原子写回
        └─ DSH 自动广播 workspaceFile notice
             └─ 画布 tab 的 follower 醒来 → 重读 → 重绘
                  （同一路径也覆盖：AI 直接用 write 工具、人在终端改文件）

人拖拽节点
   └─ 画布本地乐观更新（立即反馈）
        └─ 防抖 300ms → typert remote 写回文件
             └─ change feed 也会通知自己 → 用 revision/内容哈希去重，避免回环
```

**为什么这样最好**：
1. 人和 AI 完全对称，没有"AI 专用通道"。
2. 每次改动都进 session log（因为走的是文件写入），可回放、可审计、可撤销。
3. 天然支持多会话：另一个会话改同一个文件，你的画布也会刷新。
4. 不需要为"AI 画图"发明任何新协议。

### 5.3 文档格式

内部格式自己定，建议 JSON：

```jsonc
{
  "version": 1,
  "revision": 42,
  "nodes": [{ "id": "n1", "x": 0, "y": 0, "w": 120, "h": 48, "label": "接入层", "style": "rounded" }],
  "edges": [{ "id": "e1", "from": "n1", "to": "n2", "label": "HTTP" }],
  "meta": { "engine": "maxgraph", "layout": "dagre-lr" }
}
```

`.drawio` / `.mmd` 作为**导入导出格式**，不要当内部真相源——免得被 mxfile 的 XML 细节拖住。

---

## 6. 如何与 DSH 兼容（硬规则清单）

### 6.1 包契约

```jsonc
// package.json
{
  "name": "dsh-drawai",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",            // host half，ESM
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":         { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client":  { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./typert":  { "default": "./lib/typert.host.js" },     // 可选：自定义 Remote
    "./src/*":   "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib", "src", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ← 安装时自动挂载
    "client": {
      "platform": "web",
      "inject": [                                   // ← boot graph 排序依据
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-api-workspace-files",
        "@deepseek-ai/dsh-client-modules"
      ]
    },
    "compatibility": { "dsh": ">=0.1.5-rc.1" }      // 可选，对标 dsh-cost-meter
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-client-locale": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-client-ui-sidebar-right": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-client-ui-slots": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-api-workspace-files": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.1",
    "react": "^18.2.0", "react-dom": "^18.2.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && tsdown",
    "bundle": "tsdown",
    "watch": "tsdown --watch"
  }
}
```

```yaml
# cordis.patch.yml（bundle patch，安装时由 dsh plugin add 自动并入）
- insert:
    - id: drawai
      name: 'dsh-drawai'
```

> 注意 `dsh-better-sidebar` 的 patch 里有一个**聚合包双重挂载守卫**（用 `!!js` 检查 loader entries）。如果你预计被聚合包收录，照抄那个模式；聚合 bundle 必须排在你前面。

### 6.2 必须遵守的七条

1. **`lib/client.js` 必须预先构建**。`dsh-client-modules` *只* 服务构建产物；缺了会在激活时大声失败。用 `tsdown` 打包（生态通用）。开发用 `tsdown --watch`。
2. **不要打包第二份 React**。shell 在 boot 前烘进一张 **9 项冻结模块表**（`dsh-web-frontend/dist/assets/index-*.js` 里的 `staticModules`），每个动态 bundle 都拿它解析 external：

   ```js
   { react, "react/jsx-runtime", "react-dom", "react-dom/client",
     "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store",
     "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives",
     "@deepseek-ai/dsh-client-ui-dockkit" }
   ```

   这 9 个在 tsdown 里**全部标 external**（`sidebar-right/lib/client.js` 就 require 了其中 6 个，且**没有**声明任何 `dsh.client.external`——因为它们都是基线）。只有**非基线**依赖才写进 `dsh.client.external`；组合期会拒绝格式错误、找不到供给方、自引用、同步循环的请求。
   顺带：`@deepseek-ai/dsh-client-ui-primitives` 提供 `FileTypeIcon` 等官方图标，画布的节点图标可以直接用，不用自己画一套。
3. **React 18**。生态（`ui-sidebar-files`、`dsh-better-sidebar`）都是 `react@^18.2.0`。
4. **host half 必须是 ESM**（Cordis 是 ESM-first，CJS 不可选），并严格按参考包的形式导出：

   ```ts
   const name = 'drawai'
   const inject = ['tools', 'fs', 'systemPrompt']   // 硬依赖服务；缺一个就不激活
   const Config = z.object({ /* schemastery */ })   // 配置；无配置可省
   function apply(ctx, config) { /* ... */ }
   export { name, inject, Config, apply }           // ← dsh-tool-fs/-present/-pwsh 全是这个精确形式
   ```

   `inject` 是硬依赖，写在里面的服务在激活前一定存在；可选依赖用 `ctx.get('x')` 或 `ctx.inject(['x'], cb)`。
5. **`dsh` 字段不是纯 host 插件的必需品**。只有两种情况需要：`dsh.bundle.patch`（声明自己是 profile 的一个 patch 层）和 `dsh.client`（声明有浏览器半边）。本方案两者都要，所以都写。另外 **没有任何参考包使用 `cordis` 字段**——别发明它。
6. **所有注册都用 `ctx.effect(() => ...)` 包起来**，保证插件卸载时自动回收（`register()` 返回幂等 disposer）。
7. **重型渲染内核必须懒加载**。`dsh-better-sidebar` 的做法：core ~325KB，terminal / editor / mermaid 全部按需 chunk。你的 mxGraph / dagre 也照做，否则右栏一开就卡。

### 6.2b 客户端半边怎么写

| 事项 | 做法 |
|---|---|
| **源码形态** | 写 TypeScript / TSX，由 `tsdown` **提前编译**成 `lib/client.js`。产物形式是 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`（lazy-CJS：执行只注册 factory，模块体副作用——包括 CSS 注入——在 materialization 时才跑） |
| **导出** | 浏览器半边同样导出 `inject: string[]` + `apply(ctx)` |
| **组件取数** | 纯 React 组件，通过**类型化注入的 props** 拿数据，**自己不做订阅接线**。公共类型从 `@deepseek-ai/dsh-client-ui-slots` 来：`PropsRuntime<'slot'>`、`InjectFace<F>`、`PropsLocale<'ns'>`、`PropsRenderSlots`、`PropsStore`、`SlotHookFactory`、`SnapshotSelectorHook`、`HostObservable`、`BoundActions` |
| **样式** | 用 **CSS Modules**，tsdown 会内联；注入成 `style[data-plugin="<pkg>"][data-plugin-css="<pkg>/<file>.module.css"]`，类名哈希化。HMR 卸载时会按 `data-plugin` 移除自己拥有的 style 标签 |
| **i18n** | `ctx.locale.register(ns, { zh, en })` + `ctx.locale.bind(ns)`，或用 slot 注入的 `t`。命名空间类型靠增补 `LocaleNamespaceMap`。**`zh` 是 key 集合的真相源**，`en` 按它校验（有 `verify-client-ui-i18n` 门禁） |

> 参考组件形状（`CordisPanel.d.ts:5-7`）：
> ```ts
> type CanvasBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<CanvasFace> & PropsLocale<'drawai'>
> ```

### 6.2c 可用槽位不止右栏

DSH 自动生成的 client slot 目录里有 **61 个 slot**（`CLIENT_SLOT_API`）。和本方案相关的：

- **右栏**：`rightbar.session`、`sidebar.right.pane.tab`(keyed)、`sidebar.right.pane.tab.title`(keyed)、`sidebar.right.tab.guide`(chain)、`sidebar.right.tab.menu.item`(list)
- **聊天流**（想给图加个卡片时用）：`conversation.chat.node`(keyed)、`conversation.chat.turnTail`(chain)、`tool.call.toolview`(keyed)
- **设置**：`settings.section`、`settings.plugin.item`
- **浮层**：`shell.overlay`(list)

⚠️ **没有状态栏 slot** —— 最近的是 `shell.overlay`、`conversation.session.header.utilities`、`sidebar.footer.action`。
⚠️ 61 个里 **20 个是 `shadows-shipped-ui`**（注册进去会替换官方 UI）。`sidebar.right.pane.tab` 是 `replaceRisk: none`，纯增量，放心用。
⚠️ 每个 slot **只在其声明者挂载时才存在**（看 `declaredBy`）——所以必须用 `ctx.slots.inject(...)` 包住注册，不能裸注册。

### 6.3 版本与安装

```sh
# 安装（会 append 到 profile 的 dsh.profile.bundles 并应用 bundle patch）
dsh plugin --profile web add dsh-drawai@latest

# 若 pnpm 拦了构建脚本
cd ~/.dsh/profiles/web && pnpm approve-builds --all
dsh plugin --profile web add dsh-drawai@latest

# 热重载：
#   客户端改动 → 需要有一个 tsdown watch 在写你的 lib/client.js
#                （dsh-client-hmr 的 node 半边以 500ms 轮询 bundle 时间戳，
#                 变了就走 SSE /plugins/events 通知浏览器 invalidate→prefetch→重挂载）
#                没有 watcher，这条链就是空转的。
#   宿主改动   → 必须重启 dsh web
#   没有兜底   → 重载失败会把该 entry 留在 FAILED，等下一次 rebuild 才重试
```

`dsh-client-hmr` 在 web profile 里已经挂载（`dsh-web-app/cordis.patch.yml:167-168`），你只要在自己仓库里跑 `pnpm watch`（即 `tsdown --watch`）即可。注意：**重载会丢该插件的 React state**（数据层不受影响），且会连带重载依赖它的插件。

开发期也可以直接 `"dsh-drawai": "link:D:\\_Project\\drawAi"` 写进 profile 的 `package.json`，`pnpm install` 后重启。

### 6.4 文件读写与安全边界

**`ctx.fs`（`@deepseek-ai/dsh-fs`）的能力面**——用这些，不要自己 `node:fs`：

```
resolve  processPath  fileUrl  contains  stat  lstat
readText  streamText  readBytes  readByteRange
listDir  writeText  editText        get sandboxMode
```

⚠️ **没有 delete / rename / copy**。"删除一个节点"要在文档内部表达（从 `nodes` 数组移除），不是删文件。

其他边界：

- 工具调用会经过 `tools/pre-execute` 策略管线；文件写入受 `dsh-fs-observation-policy` + sandbox 约束（本机是 `workspace-write` / `ask`）。`dsh-fs` 还会发 `fs/observed` 事件、过 `fs/write-intent` / `fs/edit-intent` waterfall——想拦截或记账可以挂这里。
- 画布写文件要落在**会话工作区根**内，用 `@deepseek-ai/dsh-util-workspace-path` 的地址语法（`dsh-resource://file/session/<sessionId>/<rel>`）与 `fileAddressFor` / `pathPartsOf`。
- 宿主 HTTP 扩展点是 `ctx.webServer.register({kind:'exact'|'prefix', path, handler})` 和 `registerUpgrade({pathname, handler})`（WS）。匹配顺序：精确表 → 最长前缀 → fallback。
- **不要**为了加载图片/字体开一个任意路径的 HTTP 路由——那会绕过信任围栏。要开就开**受控前缀**并自己校验（`dsh-better-sidebar` 有 `trust-fence.ts` / `path-security.ts` 可参考）。
- ⚠️ **`@deepseek-ai/dsh-http-proxy` 不是路由扩展点**——它是 Node `fetch` 的**出站**代理策略，"nothing to mount, and nothing to configure"。别在这上面浪费时间。
- 沙箱是"对诚实代码的约束"，不是安全边界。动态 cordis 包等同于给 bash 权限。

### 6.5 patch 文件的两个坑

- **一个 patch 会整体替换目标行的 `config`，不是合并**。要改某行的配置，必须把它拥有的每个键都重写一遍。
- **空的 / 只有注释的 patch 文件会让启动失败**——要留空就写 `[]`。
- 层序：`dsh.profile.bundles` 顺序里的各 bundle patch → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。后者覆盖前者（整行 config 替换）。
- `patchReload: live`（web 默认）：两个用户 patch 文件都被 watch，改对了不用重启就重组；改错了保留上一份能跑的，不会把服务弄挂。

---

## 7. 仓库结构与代码骨架

```
D:\_Project\drawAi\
├─ package.json                 # 见 6.1
├─ cordis.patch.yml
├─ tsconfig.json
├─ tsconfig.build.json
├─ tsdown.config.ts             # host: src/index.ts -> lib/index.js
│                               # client: src/client/index.tsx -> lib/client.js (React external)
├─ src/
│  ├─ index.ts                  # host: Config / apply(ctx) / 注册工具 / typert 路由
│  ├─ config.ts                 # schemastery Config
│  ├─ tool/
│  │  ├─ apply.ts               # diagram_apply
│  │  ├─ read.ts                # diagram_read
│  │  ├─ open.ts                # diagram_open（推给浏览器）
│  │  └─ export.ts              # diagram_export
│  ├─ doc/
│  │  ├─ model.ts               # 图模型 + JSON Schema 校验
│  │  ├─ patch.ts               # 施加 ops
│  │  ├─ layout.ts              # dagre / grid 自动布局
│  │  └─ drawio.ts              # .drawio 导入导出
│  └─ client/
│     ├─ index.tsx              # browser: inject + apply(ctx)
│     ├─ definition.tsx         # SidebarRightTabDefinition
│     ├─ CanvasBody.tsx         # slot: sidebar.right.pane.tab
│     ├─ CanvasTitle.tsx        # slot: sidebar.right.pane.tab.title
│     ├─ store.ts               # 每 tab 状态，绑 owner signal
│     ├─ engine/
│     │  ├─ load.ts             # 引擎懒加载
│     │  └─ maxgraph.tsx        # maxGraph 适配
│     ├─ locales.ts             # zh / en
│     └─ settings.tsx           # 设置页 section
└─ docs/
   └─ DSH-drawio-插件方案.md     # 本文件
```

### 渲染引擎选型

| 方案 | 像 drawio | 体积 | 建议 |
|---|---|---|---|
| **maxGraph**（mxGraph 的 TS 继任者，Apache-2.0） | ★★★★★ | 大（必须懒加载） | **v2 目标**；真正的 drawio 血统 |
| **React Flow** | ★★★ | 中 | **v1 推荐**：React 原生、上手快、AI 友好（节点/边就是 JSON） |
| **Mermaid** | ★★（只读语义图） | 中小 | **M0 兜底**：AI 写 mermaid 源码直接渲染，改造成本最低 |
| 内嵌 drawio `viewer.min.js`（只读） | ★★★★ | 中 | 只想"AI 画、人看"时的轻量方案 |
| iframe 嵌自托管 drawio editor | ★★★★★ | 额外静态路由 + 跨帧通信 | 最像但要处理沙箱/信任，v3 再说 |

**建议路径**：M0 用 Mermaid（一天出效果）→ v1 换 React Flow（可编辑）→ v2 上 maxGraph（真 drawio 体验）+ `.drawio` 导入导出。

---

## 8. 里程碑

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **M0 只读渲染** | 右栏 tab 类型 + `patterns` 认领 `.dshd.json`/`.mmd` + 读文件 + Mermaid 渲染 + 订阅 `ChangeFeed` 自动刷新。**不写任何自定义工具**——AI 用现成 fs 工具改文件即可 | "AI 画我就能看见" | 0.5–1 天 |
| **M1 交互编辑** | React Flow 画布 + 拖拽/连线/改标签 + 防抖写回 + revision 去重 + guide 入口卡片 + 设置页 | 可当 drawio 用 | 2–3 天 |
| **M2 语义工具** | `diagram_apply` / `diagram_read` / `diagram_open` + preset 行 + 自动布局 + 校验报错 | AI 画得又对又稳 | 2–3 天 |
| **M3 打磨** | maxGraph 引擎 + `.drawio` 导入导出 + 导出 SVG/PNG + 懒加载分包 + 双语 + `dsh.compatibility` | 可发布 | 3–5 天 |

**建议先做 M0 验证**：它能在一天内证明"窗口位置 + 变更流驱动"这条主线是对的，且完全不碰工具平面/preset 的复杂度。

---

## 9. 验证状态与已知空白

**已在源码/契约层面确认**（不是推测）：

- ✅ `ctx.sidebarRightTabs.register(def)` 与 `ctx.sidebarRight.*` 的完整签名 —— 读自 `dsh-client-ui-sidebar-right/lib/types/client/{tab-registry,service}.d.ts`。
- ✅ 两个 slot 的注册签名与组件可用 props —— 读自 DSH 自动生成的 client slot 目录（`dsh-cordis-client-runner/lib/client.js` 内嵌的 `CLIENT_SLOT_API` 数据，`packages/client/ui-sidebar-right/src/client/contract/slots.ts:50,64`）。这就是 §3.1 表格的来源。
- ✅ 工具注册契约 —— `dsh-tools/lib/types/schema.d.ts` 的 `defineTool` + `ParameterSchemaSpec`，以及四个参考包的导出形式。
- ✅ 变更流 —— `dsh-api-workspace-files/lib/types/client/change-feed.d.ts` 的 `ChangeFeed.follow(sessionId, signal)`。
- ✅ 宿主 HTTP/WS 路由 —— `dsh-host-webserver/lib/types/index.d.ts` 的 `register` / `registerUpgrade`，先例 `dsh-webhook-github`。

**已定论（原本的未决项）**：

- ✅ **DSH 没有内建的 host→client 打开通道**。全仓库 grep `openResource(` / `openTab(`，调用点**只出现在浏览器半边**（`ui-chat/lib/client.js:8322-8323`、`ui-sidebar-files/lib/client.js:451`、`ui-sidebar-right/lib/client.js:181,3697`）。没有任何 tool / remote / host service 暴露它。
  ⇒ **`diagram_open` 必须自带推送通道**：`ctx.webServer.registerUpgrade({ pathname, handler })` 开一条 per-session WS，宿主侧工具把"打开 X"投递进去，浏览器半边收到后调 `ctx.sidebarRight.openTab('diagram', ...)`。`dsh-better-sidebar` 的 `src/agent-opens.ts`（投递注册表）+ `src/client/sidebar/use-host-feeds.ts`（订阅）+ `/sidebar/api` 就是这条路的完整参考实现，**可以直接照抄那套结构**。
  **这不阻塞 M0/M1**——它们靠文件变更流就够了，`diagram_open` 是 M2 的锦上添花。

**两个诚实标注的空白**（不影响动手，但别指望从本机源码里抄到）：

- `@deepseek-ai/dsh-client-ui-slots`、`-ui-primitives`、`-ui-dockkit`、`dsh-client-store` 这几个包**没装进本机 checkout**（是 devDependencies），所以 `TabRecord` / `PaneId` / `TabId` / `IconProps` 的字段形状无法从源码引用——只能靠 import 推断和在已烘进 shell bundle 的实例里找。
- `CLIENT_NOTES`（"适用于所有 browser-half 贡献的规则"）在 `slot-catalog.d.ts` 里声明了，但被 tree-shake 出了构建产物，**取不到正文**。要读它得去上游仓库 `packages/client/.../slot-catalog` 的生成脚本。

---

## 10. 参考实现索引（照抄清单）

动手时按这个清单逐个读，比读文档快。**第一站先读配套的 `附录-DSH客户端插件API速查.md`**——里面有 61 个 slot 的完整清单和逐字段契约。

| 想抄什么 | 读哪个文件 |
|---|---|
| **右栏 tab 类型的最小完整实现** | `<P>\@deepseek-ai\dsh-client-ui-sidebar-files\src\client\{definition.tsx,index.ts,FilesBody.tsx,FilesTitle.tsx}`（7 个源文件） |
| **它的 package.json**（`dsh.client` 声明范式） | `<P>\@deepseek-ai\dsh-client-ui-sidebar-files\package.json` |
| **tab 注册 + 控制器契约** | `<P>\@deepseek-ai\dsh-client-ui-sidebar-right\lib\types\client\{tab-registry,service}.d.ts` |
| **全部 slot 目录**（含最小示例） | `<P>\@deepseek-ai\dsh-cordis-client-runner\lib\client.js` 搜 `CLIENT_SLOT_API` / `sidebar.right.pane.tab` |
| **一条最简单的工具** | `<P>\@deepseek-ai\dsh-tool-present\lib\index.js`（定义在 23–109 行，导出在 123 行） |
| **一个完整的工具（含 fs/沙箱）** | `<P>\@deepseek-ai\dsh-tool-fs\lib\index.js`（`read` 在 331–435，`inject`/`Config`/`apply`/导出在 1240–1278） |
| **工具 schema DSL** | `<P>\@deepseek-ai\dsh-tools\lib\types\schema.d.ts` |
| **`ctx.fs` 能力面** | `<P>\@deepseek-ai\dsh-fs\lib\types\index.d.ts` |
| **变更流** | `<P>\@deepseek-ai\dsh-api-workspace-files\lib\types\client\change-feed.d.ts` |
| **宿主路由注册** | `<P>\@deepseek-ai\dsh-webhook-github\lib\index.js:179-191` |
| **浏览器插件名册**（哪些已挂载） | `<P>\@deepseek-ai\dsh-web-app\cordis.patch.yml:201-350` |
| **第三方 bundle 的完整形态** | `C:\Users\86476\.dsh\profiles\web\node_modules\dsh-better-sidebar\`（`package.json` 的 `dsh` 字段、`cordis.patch.yml` 的双挂载守卫、`src/agent-opens.ts` 的 `sidebar_open` 工具 + push 通道、`src/client/native/surface.ts` 的原生适配层） |
| **`dsh.compatibility` 字段范式** | `C:\Users\86476\.dsh\profiles\web\node_modules\dsh-cost-meter\package.json` |
| **agent preset 怎么写** | `<P>\@deepseek-ai\dsh-agent-presets\presets\cordis\agent.cordis.yml` |

（`<P>` = `C:\Users\86476\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules`）

---

## 11. 一句话总结

> **窗口**：注册成 DSH 原生右栏的 tab type（`ctx.sidebarRightTabs.register`），需要浮窗用 `ctx.sidebarRight.float()`。
> **入口**：人类走 guide 卡片 + 文件地址认领 + 设置页；AI 走 `ctx.tools.register` 的 `diagram_*` 工具，工具行写进 agent preset；原型阶段用 `cordis_define`/`cordis_run` 零安装试水。
> **兼容**：图 = 工作区里的一个文件，改文件 → DSH 自带的 workspace 变更流 → 画布重绘。不自建推送、不自绘右栏、不打包第二份 React、客户端产物必须预构建。
