# 发布与收录流程 / Release & listing

## 0.4.4 发布内容（2026-11-10）

- 新增 `diagram_export`：在宿主侧把 `.drawai` / `.drawio` 直接导成 SVG 或 PNG，不需要打开画布侧栏。QQ、CLI 这类没有画布的通道里，成品图终于拿得到；`diagram_read {render:true}` 与 `diagram_apply {op:"export"}` 保持原样——能开画布时仍走浏览器那一半，保真度更高（#23）。
- `diagram_export` 把保真度写在返回值里：`fidelity:"approximate"`，视频/卡片/音频节点只画通用形状，文字量宽按字符宽度估算（CJK 1em、其余 0.55em），降级项逐条进 `warnings`。
- 导出走宿主自己的渲染器：正交连线跑仓库里的避障路由器，标签处按线段挖空，`out` 可指定输出路径（限工作区内），PNG 由 `@resvg/resvg-js` 栅格化并带 CJK 字体回退。
- 修 `diagram_export` 的自环绘制、边计数与尺寸预检：自环以前整条静默消失，统计把隐藏图层与悬空边也算进去，超大 scale 先渲染再报错（#23）。
- 修：拐弯的连线在预览里糊成黑块。`<path>` 的内联 paint 没有跟着渲染树走，SVG-as-image 里缺省 fill 是黑的（#32）。
- `motion_qa` 帧检补上「整镜动能量」与「有底没内容」两条：freezedetect 只看完全不动、空白帧只看亮度极差，两者都会漏掉缓慢推镜与渐变底。
- 整片风格新增「水墨写意」，从 14 种增至 15 种。

## 0.4.3 发布内容（2026-11-09）

- 内嵌技能拆成 `drawai-canvas` 与 `drawai-video` 两条：一份三万字的正文同时背着画布的 op 速查和视频的十步流程，而技能目录只显示 description 那句，用户说「做个宣传片」会先被「读写画布」挡住。拆开后 `motion_*` / `shotcraft_search` / `mg_style` 只进视频正文，`diagram_*` 那套只进画布正文。
- 视频正文补一段「画布最小集」（path 必填、`as` 别名、from/to 必须是已存在的 id、建了镜头卡必须连），单独加载也不会写错 op；画布正文反过来指向视频技能。
- 两条技能在同一个 `ctx.effect` 里注册，返回组合 disposer，插件卸载时一起撤掉。
- `check-package` 从「恰好一个技能」改成「恰好两个、名字对得上、关键字分两组」，并新增「画布技能里没有 motion_*」；`check-media-library-host` 按名字找 `drawai-video`，不再按注册顺序摸 `skills[0]`。
- `docs/design.md` 的三通道一节同步成两条技能，并写明拆分理由。

## 0.4.2 发布内容（2026-11-09）

- 画布工具注册加固：18 个 host 工具逐个兜错，`tools` 服务未就绪时改延迟注册；新增只读端点 `/drawai/api/diagnostics` 用于现场取证（#8）。
- `diagram_read render:true` 不再永远停在 `pending`：画布没打开回 `not-open`，25 秒没人接回 `timeout`，都带已等待秒数（#12）。
- `setStyle {arrow:"none"}` 显式写 `endArrow=none`；drawio 的缺省边样式自带 classic 箭头，以前删键反而画出箭头（#15）。
- 12 个输入参数（`frames`/`spec`/`crop`/`ids`/`anchors` 等）改用真实 JSON Schema 类型，模型知道该传数组还是对象；字符串写法仍兼容（#14）。
- 子目录里的画布可以正常「打开画布」，`list` 的绝对路径按所选目录拼（#19）。
- 视频预览/渲染的打包入口复制进工程目录，装在 `node_modules` 下的 `.jsx` 不再被 Remotion 的 loader 跳过；浏览器候选覆盖 macOS/Linux，找不到浏览器时先给进度提示（#21、#22）。
- 渲染 worker 的临时目录改到工程内，`.dsh` 进程带 Low 完整性标签时 ffmpeg 不再写不了 `%TEMP%`（#26）。
- 整片风格 demo：`d3`/`topojson-client`/`opentype.js`/`simplex-noise` 四个依赖随包 vendored，`mg_style frames` 不再报缺模块；22-hud 的世界地图数据改由 `demo-assets-v1` 小包按需下载（18-hanazi 的贴图仍用 1px 占位）（#27）。
- `.gitignore` 的 `vendor/` 锚定到仓库根，routing vendor 纳入版本库，克隆后可直接构建；避障引擎不可用时降级写回而不是整次失败（#13）。
- 构建：客户端内联按 LF 归一，Windows 检出的换行差异不再误报 bundle 不一致。

## 0.4.1 发布内容（2026-11-08）：独立视频运行环境

- Remotion、React、Three.js 从插件生产依赖移出；插件安装不再触发 esbuild 安装脚本授权。
- 首次渲染、网页采集或参考帧截取时，用随包提供的 npm 按锁文件初始化独立环境，强制禁用生命周期脚本、保留平台可选二进制，并实际验证 esbuild 转换和 Remotion 加载。
- 缓存按依赖锁、平台、架构和 Node 主版本区分；初始化使用临时目录和跨进程互斥，验证通过后启用。失败清理临时目录、下次重试；支持取消和离线复用。
- 渲染任务状态显示初始化与验证进度。配置：`DRAWAI_VIDEO_RUNTIME_DIR` 设置独立缓存位置，`DRAWAI_RUNTIME_REGISTRY` 设置 registry 镜像。
- 验证使用未授权 esbuild 的全新测试 profile，开启 pnpm 严格依赖构建检查，另验首次初始化、并发复用、离线缓存与真实音视频渲染。

## 0.4.0 发布内容（2026-11-07）

- 暂停文生图：移除元素条、选区工具栏与偏好设置中的入口，宿主拒绝生成、连接检测和默认工作流请求；已有图片内容与节点数据保留。
- 字体与素材库独立为 GitHub Release 素材包，首次使用动效时下载并校验，后续使用本地缓存；npm 包仅包含代码与下载校验信息。
- 音频宿主测试迁移至 `motion_project`、`motion_audio`、`motion_render`，覆盖音轨增删、权限、真实渲染与回填及修改增益后重新渲染。

发布前需确认 `assets-v1` Release 中的素材包与安装包内的 lock 一致，并在无缓存环境验证首次下载。生成 npm 安装包不代表已发布到 registry。

## 发布素材包（npm 包不再带字体与素材库）

动效要用 46 个字体 + 116 个素材，解压后 201MB。它们**不进 git、也不进 npm 包**，改由 GitHub Release 托管，插件首次用到时自己下载。

```powershell
# 1. 打包（生成 dist/drawai-assets-v1.tar.gz 与 src/motion/asset-pack-lock.js）
node tools/build-assets-pack.mjs

# 2. 传到 GitHub Release（tag = assets-v1，需要能访问 github.com）
node tools/publish-assets.mjs --dry-run   # 只看大小与 tag
node tools/publish-assets.mjs
```

打包结果记在 `src/motion/asset-pack-lock.js`（`file` / `bytes` / `sha256` / `files`），插件用它校验下载物；**换素材就要重跑打包并重新发布**，否则哈希对不上会被拒绝。

用户侧：

- 下载缓存 `~/.dsh/drawai-assets/v1/`，校验通过写 `.ready.json`，之后离线可用。
- 仓库里如果自带 `lib/motion/fonts`（开发态 / 源码安装），直接用它，不下载。
- 下载失败或素材缺失时，动效工具会返回一段中文指引（重试 / 手动下载解压 / 设代理），并说明画布与图片功能不受影响。
- 环境变量：`DRAWAI_ASSETS_DIR` 改缓存位置，`DRAWAI_ASSETS_URL` 指到镜像或内网地址。

npm 包体积：`package.json` 的 `files` 用否定项排除 `lib/motion/fonts`、`lib/motion/media-library`，`npm pack` 从 704 文件 / 147.6MB 降到 545 文件 / 3.0MB（注意：单靠 `.npmignore` 无效，`files` 白名单优先）。

## 发布 demo 数据包（只有演示用得上的数据）

上游 demo 里有少量「只有这一个 demo 用得到」的数据文件，例如 22-hud 的世界地图拓扑 `land-50m.json`（约 530KB）。它们不进 npm 包（让每个用户为看一个 demo 多下 530KB 不值得），也不进 git（仓库只留构建脚本），单独打一个小包发 Release。

```powershell
# 1. 打包（生成 dist/drawai-demo-assets-v1.tar.gz 与 src/motion/demo-assets-lock.js）
node tools/build-demo-assets-pack.mjs

# 2. 传到 GitHub Release（tag = demo-assets-v1）
node tools/publish-assets.mjs --demo --dry-run
node tools/publish-assets.mjs --demo
```

- 源文件在打包时从 unpkg 下载（`world-atlas@2.0.2`，数据源 Natural Earth 公有领域，包本身 ISC），缓存在 `dist/demo-assets-src/`，之后离线可重复打包；`--refresh` 强制重下。
- 用户侧缓存 `~/.dsh/drawai-assets/demo-v1/`；环境变量 `DRAWAI_DEMO_ASSETS_DIR` 改位置、`DRAWAI_DEMO_ASSETS_URL` 指镜像。
- 只有 `/demos/<slug>/assets/*.json` 会触发这个包；**贴图与字体不触发**（缺了照旧走 1px 占位与内置字体）——18-hanazi 的贴图就是「太专一、不收录」的例子。

## FFmpeg 自动获取完善（0.4.1，2026-11-08）

- 首次真正用到 FFmpeg 时自动准备：`DRAWAI_FFMPEG_PATH` → 系统 `PATH` → 开发目录 → 已验证缓存 → 下载；显式路径或 PATH 中的版本不满足要求时列出缺失项并直接报错，不再静默换一个。
- 环境变量、PATH、缓存和下载得到的二进制都检查 FFmpeg 5.1+、项目所需的编码器/解码器/滤镜/封装器/解封装器，并实际跑一次含 `-fps_mode` 的短编码；缓存复用时同时核对版本、二进制 SHA-256 与功能。
- 下载共享、取消独立：多个任务同时首次使用时只下载一次，但每个调用者的取消与进度互不影响；进度写入导出任务与后台任务面板。
- 缓存清理只删当前平台的子目录；`DRAWAI_FFMPEG_MIRROR` 可指向镜像（大小与 SHA-256 仍按注册表校验）；内置下载不自动读取系统代理，代理环境给出镜像/手动配置提示。
- 生成的 `tools/polish.mjs` 也会查找 DrawAI 缓存与 `DRAWAI_FFMPEG_DIR`，错误提示说明下一步。
- 新增 `tools/check-ffmpeg-manager.mjs` 覆盖缓存范围、哈希/大小、ZIP 解压、显式路径与 PATH 回退、缓存损坏、并发取消、进度、镜像和 Node 20 CRC32 回退。

验证：干净环境真实安装/离线复用/损坏修复，官方 BtbN 8.1.3 Windows 构建经镜像完整下载并跑通音频导入、素材探测、响度分析、帧检和 MP4/WebM/GIF/剪映导出；构建、完整测试与安装烟测通过。

## 未发布：去掉内层制作 Agent（2026-11-03）

- 删除 `src/motion-agent.js`、`src/motion-agent-tools.js`、`src/motion-planner.js`（约 50KB）与它们写出的 `.agent/state.json` / 192 份 receipts；`motion-tasks.js` 只保留任务记录与旧的遗留管线。
- 工具面换成动词：`motion_project`（建工程）、`motion_preview`（同一轮回图的帧拼图）、`motion_render`（异步 job，支持 `frames`/`range`/`apply` 回填 clip pack）、`motion_assets`（素材进 `assets/`）、`motion_audio`（挂音轨、分析节拍、钉拍）、`motion_audio_verify`（渲后回测）。`motion_task` 收缩为旧任务记录（list/status/cancel/focus/remove）。
- 时间轴改为工程内的 `timeline.json`：镜头卡连线顺序与卡片时长决定分段，音轨 `audio[]` 与画面同用帧坐标；渲染时 `src/motion/entry.jsx` 统一挂 `<Audio>`，旁白窗口自动压 BGM。
- 镜头卡接入配方：`shotcraft_search` 返回 `recipe` / `demoSource`，`@shotcraft/lib/*` 与 `@shotcraft/demos/*` 可被场景直接 import；SKILL 改成八步硬顺序（定镜头 → 建工程 → 写画面 → 备素材 → 看画面 → 配声音 → 踩点 → 出片）。
- 成片回填：`motion_render apply` 把 `film.mp4` 落成 raster clip pack（`source.mp4` + `poster.svg` + 节点 `mediaClip`），画布卡片直接可播。
- 实测：15 秒片从 32 分钟 / 166 轮降到 45 秒 / 0 轮；音频输出偏移 1.29 帧、钉拍误差 0.3 帧、避让 12.1dB。

## 0.3.4 发布内容（2026-10-26）

- 修复拖动线段时共线折点插入顺序错误、段内折点未随整段移动而产生折返重叠的问题。
- 修复首末段平移时把节点连接点误当成可移动折点，导致节点边框附近出现密集小弯的问题；连接点和引出段保持固定。
- 为带折点或端点约束的路径增加避障与方向检查，并在自动路由的固定候选均受阻时补充正交寻路。
- 补充四方向首末段平移、连续往返拖动及节点移动的回归检查，同步 npm 预构建产物。

验证：构建、安装前检查、完整测试及 npm 打包检查通过。Windows 测试使用工作区临时目录。

## 0.3.3 发布内容（2026-10-22）

- 修复视频分段复刻加入绘制队列时，提交中尚未生成 job 导致进度条读取失败、面板崩溃的问题；此时显示不确定进度。
- 修复排队提交期间按 Esc 调用缺失的取消回调而报错的问题。
- 补充排队提交、进度反馈、控件禁用及提交完成后恢复的回归测试，并同步 npm 预构建产物。

验证：构建、安装前检查、完整测试及 npm 打包检查通过。Windows 测试使用工作区临时目录。

## 0.3.1 发布内容（2026-10-18）

- 图片、视频绘制及 AI 抽帧迁移到宿主持久队列；支持检查点、暂停续绘、重启恢复和安全写回原页面。
- 统一后台任务面板，支持筛选、排序、重试、结果回放及单项生成撤销。列表默认隐藏，从右侧工具栏展开，并记住显示偏好。
- 视频导出由宿主完成 SVG 渲染、MP4/WebM/GIF 编码及保存；记录可恢复，保留白底、帧率及适用格式的片段音频。
- 导出前固定素材，媒体清理保护所有页面和任务引用，版本冲突保留产物及本地编辑。
- 使用 FFmpeg 的功能会在首次真正调用时自动准备：优先 `DRAWAI_FFMPEG_PATH`，其次系统 PATH、已验证缓存，最后下载校验并缓存到 `~/.dsh/drawai-ffmpeg/<平台>-<架构>/`；不再要求用户预先安装。显式路径或 PATH 中的版本缺功能时会列出缺失项，不会静默替换；下载可用 `DRAWAI_FFMPEG_MIRROR` 指向镜像。宿主代码更新后须重启 DSH。整画布导出与 AI 看图仍使用前台渲染。

验证：构建、安装前检查、完整测试及 npm 打包检查通过。

两件事要分开看：

1. **让仓库本身合格** —— 收录条件是对**你的 GitHub 仓库**提的（manifest、年龄、topic…）。
2. **去精选列表提一个文件** —— 市场与站点读的是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
   投稿就是在那里加 `data/plugins/fourzkw__dsh-drawai.yml`。

收录要求以 [contributing.md 原文](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 为准，
本文只记**我们这边的状态与动作**。

---

## 一、现在的状态（2026-09-16 23:26 实测，对着 API、registry 与仓库核过）

| 项 | 状态 | 证据 |
|---|---|---|
| `dsh.bundle.patch` + 根 `cordis.patch.yml` | ✅ | `package.json` 的 `dsh.bundle`；patch 里 `insert: id: drawai` |
| 真实可用的代码 | ✅ | `lib/` 已提交、没有 `prepare`/`postinstall`、`npm pack` = 8 个文件 / 245.2 kB |
| 许可证 | ✅ MIT | `LICENSE`（版权行 `fourzkw`）+ `"license": "MIT"`，都已在默认分支上 |
| `repository` / `author` | ✅ | `git+https://github.com/fourzkw/dsh-drawai.git` / `fourzkw` —— npm 包与条目的关联依据 |
| **npm 包** | ✅ **已发布** | [`dsh-drawai@0.1.0`](https://www.npmjs.com/package/dsh-drawai)（2026-09-16，`latest`）—— 市场按 `repository` 自动关联下载量，条目里不用写 `npm:` |
| `@deepseek-ai/*` 用 `peerDependencies` 且带预发布分支 | ✅ | 见第四节 |
| 仓库公开、有内容 | ✅ | [fourzkw/dsh-drawai](https://github.com/fourzkw/dsh-drawai) |
| 默认分支 = 本地最新 | ✅ | 提交都已推送，工作区干净 |
| **仓库创建满 1 天** | ⏳ **2026-09-17 00:30:49 (+08:00) 才满**（实测 22.9 h，还差约 1.1 h） | API `created_at = 2026-09-15T16:30:49Z` |
| **`dsh-plugin` topic** | ❌ **空** | `GET /repos/fourzkw/dsh-drawai/topics` → `{"names":[]}` |
| **`data/plugins/fourzkw__dsh-drawai.yml`** | ❌ 还没提 | 见第 7 步与第三节 |
| 描述属实 | ⚠️ 写的时候注意 | 真实工具**只有 2 个**：`diagram_read` / `diagram_apply` |
| 与已有条目不重复 | ⚠️ 同一种文件格式，不是同一件事 | 在册的 `jean3690/dsh-drawio` 也读写 `.drawio`，见第五节 |

> 到这里**仓库侧的硬条件全部满足**，只剩两件事：加 `dsh-plugin` topic（第 2 步）、提那个 yml（第 7 步）；
> 外加等过 00:30:49 的 1 天年龄门槛（第 4 步）。npm 已发布，第 6 步完成。

---

## 二、要做的步骤

### 1. 提交 + 推送（已完成）

仓库与工作区当前是一致且干净的；之后每次改文档，照常提交推送即可：

```sh
git add -A && git commit -m "docs: …" && git push github master
```

- ⚠️ 本机 `git` 配了 `http.proxy = 127.0.0.1:7892`（那个端口默认是关的）；去掉代理直连时 Schannel 会报
  `SEC_E_NO_CREDENTIALS`。这组覆盖参数实测可以推：

  ```sh
  git -c http.sslBackend=openssl -c http.proxy= -c https.proxy= push github master
  ```

### 2. 加 `dsh-plugin` topic（硬要求）

现在 `GET /repos/fourzkw/dsh-drawai/topics` 回的是 `{"names":[]}`，三个办法任选：

**A. 网页（推荐，不需要 token）** —— 打开 <https://github.com/fourzkw/dsh-drawai>，
右侧栏 **About** 那一块点 ⚙️（齿轮）→ 在 **Topics** 输入框里打 `dsh-plugin` → 回车（或点 Add topic）→
对话框底部 **Save changes**。顺手把 **Description** 也填一句（现在 `description` 是 `null`）。
验证：刷新后 About 下面出现蓝色 `dsh-plugin`，点进去就是 <https://github.com/topics/dsh-plugin>。

**B. gh CLI**（本机没装）：

```sh
gh repo edit fourzkw/dsh-drawai \
  --add-topic dsh-plugin,deepseek-harness,drawio,diagram,canvas
```

**C. REST API** —— `PUT /repos/{owner}/{repo}/topics`，**它是整体替换**，每次都要把想要的写全：

```powershell
# classic PAT 用 public_repo 就够；fine-grained PAT 要 Administration = Read and write
$env:GH_TOKEN = '<your-token>'          # 别把 token 贴进聊天/提交进仓库
$headers = @{
  Authorization            = "Bearer $env:GH_TOKEN"
  Accept                   = 'application/vnd.github+json'
  'X-GitHub-Api-Version'   = '2022-11-28'
}
$body = @{ names = @('dsh-plugin', 'deepseek-harness', 'drawio', 'diagram', 'canvas') } | ConvertTo-Json
Invoke-RestMethod -Method Put -ContentType 'application/json' -Headers $headers `
  -Uri 'https://api.github.com/repos/fourzkw/dsh-drawai/topics' -Body $body
```

> ⚠️ Windows PowerShell 里 `curl` 是 `Invoke-WebRequest` 的**别名**，要用真 curl 得写 `curl.exe`
> （而且 JSON 的引号在 5.1 里很难转义，所以上面用 `Invoke-RestMethod`）。
> topic 只能是小写字母 / 数字 / 连字符，一个仓库最多 20 个。

### 3. `repository` / `author`（已补）

包的 `repository` 必须指回被收录的那个仓库，否则两者不会关联（映射自动采集，条目里手写 `npm:` 会被拒）。
`package.json` 里已经补上，`LICENSE` 的版权行也已改成 `fourzkw`：

```jsonc
"author": "fourzkw",
"repository": { "type": "git", "url": "git+https://github.com/fourzkw/dsh-drawai.git" }
```

### 4. 等过 1 天门槛

`2026-09-17 00:30:49 (+08:00)` 之后提交最稳。这条由 CI 自动查，不是对插件质量的判断；
万一卡住了，把功能做完再提一次即可，重新提交没有任何影响。

### 5. 截图（可选、推荐）

现在 README 里一张图都没有，市场卡片会没有配图。在你的仓库里放 `screenshots.json`
（与 `package.json` 同级）+ 1-8 张图，然后在 README 里也引用同一批：

- README 顶部留了一行**注释掉的社交预览图**占位（`docs/social-preview.png`，1280×640）——
  图放好后把那两行注释去掉即可，仓库的 Social preview 也用同一张（Settings → General → Social preview）。
- 画布那几节（`## 🗂️ 画布面板`、`## 🤖 两个工具`）现在没有配图，放图时建议按参考插件
  [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) 的做法，一节一张、紧跟在小节标题下面。

```jsonc
// screenshots.json（路径相对本文件；也接受 {"screenshots": [...]} 写法）
[
  "assets/screenshot-1.png",
  "assets/screenshot-2.png"
]
```

规则：1-8 张；相对路径不能跳出插件目录（不能以 `/` 开头、不能有 `..`）；写绝对 URL 的话必须是
**GitHub 托管的 https**（第三方图床会被拒）。不声明也能过 —— 市场会退回从 README 抽图。

### 6. 发到 npm（已完成）

`dsh-drawai@0.1.0` 已在 registry 上（2026-09-16 发布，`npm view dsh-drawai` 可查，tarball shasum `a341ff5f…`）。
发了的好处是预构建安装跳过 `allowBuilds` 构建授权那一步 —— **发不发都不影响收录**。后续发版：

```sh
npm version patch                                  # 改版本号 + 打 tag
git push --follow-tags
npm publish                                        # 同版本号重复发会 E403
```

> **发布时踩的坑（记下来省得再撞）**：`npm login`（`auth-type=web`）留下的是一枚 **session token**，
> registry 不接受它发布，报
> `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
> —— 即使账号**没有开 2FA** 也一样（[npm/cli#9268](https://github.com/npm/cli/issues/9268)，至今 open）。
> 解法（issue 里多人验证有效）：去 <https://www.npmjs.com/settings/fourzkw/tokens> 建一枚
> **Granular Access Token** —— 权限 `Read and write`、包选 `All packages`（新包还不存在，选不到具体包）、
> **勾上 Bypass 2FA**、IP 范围留空 —— 然后：
>
> ```sh
> npm config set //registry.npmjs.org/:_authToken=npm_…   # 写进用户级 ~/.npmrc，别写进仓库
> npm publish
> ```
>
> 关键是**显式写进 `.npmrc`**：`npm token list` 里那枚 bypass-2fa token 不会被自动使用，
> npm 会继续用 session token（这就是为什么"建了 token 还是 403"）。发布完可以
> `npm config delete //registry.npmjs.org/:_authToken` 收回本地，再去网页 Revoke。

### 7. 提 PR

```sh
# fork awesome-dsh-plugin，然后
git clone https://github.com/<你>/awesome-dsh-plugin && cd awesome-dsh-plugin
# 新增一个文件，文件名 = owner__repo
#   data/plugins/fourzkw__dsh-drawai.yml
git checkout -b add-dsh-drawai && git add data/plugins/fourzkw__dsh-drawai.yml
git commit -m "Add fourzkw/dsh-drawai" && git push origin add-dsh-drawai
```

**不要手工改两个 README**（它们由 `data/plugins/*.yml` 生成），也**不要**动别人的条目 ——
PR 里只该有你这一个文件。一个 PR 最多 3 条，我们 1 条。

---

## 三、那份 yml 写什么（可直接粘）

```yaml
url: https://github.com/fourzkw/dsh-drawai
name: fourzkw/dsh-drawai
category: tools
description:
  en: 'An editable diagram canvas in the DSH sidebar plus two agent tools (diagram_read, diagram_apply) that read and edit the workspace in place, using native .drawio files: the canvas opens and saves them losslessly — cells it does not understand are preserved byte-for-byte — and a file-fingerprint revision powers optimistic locking against concurrent edits.'
  zh: 'DSH 侧边栏的可编辑画布，加两个模型工具（diagram_read、diagram_apply），直接读写工作区、载体是原生 .drawio 文件：无损写回让画布读不懂的单元逐字节保留，文件指纹 revision 支撑起对并发编辑的乐观锁。'
```

三条注意：

- **含 `: `（冒号加空格）必须加引号**，否则 YAML 会当成嵌套键 —— 上面 `en` 已经加了。
- **别写营销词，别报数字**：写"两个工具"就真的是两个；描述里的命令与 API 会被逐个对着代码核。
- `category`：`tools` 最贴合（带来的是两个模型工具 + 一块可编辑画布）。若维护者觉得更像界面增强，
  会直接改成 `ui`，**不会因此打回**。

---

## 四、peer 范围为什么长这样

```jsonc
"peerDependencies": {
  "@deepseek-ai/dsh-tools": ">=0.1.0-rc.1 <0.1.0 || >=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0"
}
```

node-semver 只有当范围里**某个比较符与该版本的 `major.minor.patch` 元组完全一致、且自身带预发布标签**时，
才放行预发布版本。本机用真实 semver 对着下列版本跑过：

| peer 范围 | `0.1.0-rc.6` | `0.1.5-rc.2` | `0.1.5` | `0.2.0-rc.2` |
|---|---|---|---|---|
| `>=0.0.1-rc.1 <0.2.0`（看着宽） | ✗ | ✗ | ✓ | ✗ |
| `>=0.0.0-0 <0.2.0-0`（"匹配一切"） | ✗ | ✗ | ✓ | ✗ |
| `>=0.1.0-rc.1 <0.2.0-0` | ✓ | ✗ | ✓ | ✗ |
| `>=0.1.0-rc.1 <0.1.0 \|\| >=0.1.5-rc.1 <0.2.0-0`（旧） | ✓ | ✓ | ✓ | ✗ |
| **`… \|\| >=0.2.0-rc.1 <0.3.0-0`**（采用） | ✓ | ✓ | ✓ | ✓ |

不这么写的后果是用户 `npm install` / `dsh plugin add` 时撞不兼容门禁还得手工绕 —— 而这个范围用户根本看不见原因。

客户端变更流也按代兼容：DSH 0.1 的 `workspaceFiles.changes(sessionId, signal)` 与 0.2 的
`changes(sessionId, path, signal)` 在 `src/client.js` 的 `openWorkspaceFileChanges` 里按 arity 分支
（失败再退回两参 / 轮询兜底）。

---

## 五、合并前维护者会看什么（对着原文）

CI 通过只是**前置条件**。评审逐条看的是：

| # | 看什么 | 我们这边的答案 |
|---|---|---|
| 1 | 代码是否与条目声明一致（含数字与 API 名） | 两个工具、ops 名与 `lib/index.js` 一致；描述里没有数字 |
| 2 | 分类是否合理 | `tools`；不贴切会被直接改，不打回 |
| 3 | 是不是真代码 | `src/` 13.3k 行 + 五份自测（`npm test` 1472 项断言全绿），`lib/` 是可运行产物 |
| 4 | **是否已被现有条目覆盖** | ⚠️ 见下 |
| 5 | 源码有没有可疑行为 | 无网络请求、无凭据、无安装期脚本；只读写工作区 `.drawio` |
| 6 | PR 有没有动别人的条目 | 只加一个文件 |
| 7 | 是不是纯聚合包 | 不是：自带渲染器 + 工具 + 布局 |
| 8 | 依赖是否指向原作者 | 没有第三方依赖 |

### 关于第 4 条（要正面回答的一点）

`jean3690/dsh-drawio` 已经在 `tools` 类里，它与我们**共用同一种文件格式**（`.drawio`），但那不是同一件事：
那边是一个 drawio 工具集 + 嵌官方编辑器的画板，我们是一块**自己实现的画布**，`.drawio` 只是它的原生载体
（所以画布存出来的文件能直接被 drawio 打开）。原文的规矩是 *"规则不是先来后到，规则是谁更好"*，
只要"确实做了新东西"就会被收录，但描述里要让人一眼看出差别。

**所以这一条的正确姿势是：按"一块画布 + 两个工具"来写，把 `.drawio` 写成一个能力
（读写原生文件、不用导入导出），而不是身份（"又一个 drawio 插件"）。**

| 差异点 | dsh-drawai 的做法 |
|---|---|
| 画布 | 自己实现的渲染器与编辑器（纯 SVG + DOM，无 iframe、无外部编辑器资源） |
| 模型能看见什么 | 工具 + 文件 + **用户此刻的选区**、每个单元的 layer/parent、`revision`、页面尺寸 |
| 写回 | **逐单元外科手术式**（读不懂的单元逐字节保留，有断言；原样保存 = 文件一个字节不变） |
| 并发编辑 | 文件指纹 `expectRevision`，对不上就报错且不写盘 |
| 互操作 | 文件就是原生 `.drawio`，用 drawio / diagrams.net 直接打开继续编辑，不需要导入导出 |

`category` 也可以考虑 `ui`（它带来的是一整块右栏画布 + 两个模型工具），不贴切维护者会直接改，不打回。

---

## 六、PR 之后

- CI 会依次查：条目数（≤3）→ 从仓库 `package.json` 读 `dsh.bundle` → 仓库年龄 → `awesome-lint` 与站点构建。
- 失败会在 PR 上写明要改什么；**在同一分支推送修复即可，不用重开 PR**。
- 反馈以 PR 评论给出（常因描述不准确被打回 —— 改那一行就收录，不是否定插件）。
- 合并后站点与市场**自动重建**，通常一天内生效。
- 收录**不是**安全审查：README 顶部的警告对所有条目一视同仁。
