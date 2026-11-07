# 动效视频

在 `.drawai` 画布上放一个视频节点，挂几张 Shotcraft 镜头卡，然后在对话里说一句要做什么。**从建工程到出片，全部由对话里的那个 agent 直接完成**：插件只提供动词（建工程、看帧、渲染、回填），不内嵌第二个 agent，也不需要在面板上点「开始」等后台跑完。

旧版本的「后台制作 Agent」已经整体移除（连同 `.agent/state.json`、receipts、resume / revise / remix、页面采集与 film-review）。相关差异见文末。

> 干活前先读 [`motion-video-playbook.md`](./motion-video-playbook.md)：那里规定了一支片子要过哪几道闸门（内容 / 方向 / 分镜 / 打样 / 量产 / 声音 / 质检）、每道闸门的产出与验收标准。这份文档只讲工具怎么调。

## 工作流

| 步骤 | 调用 | 产出 |
|---|---|---|
| ① 定镜头 | `shotcraft_search` → `diagram_apply`（`addNode{shape:"shotcard"}` + `addEdge`） | 卡片连到视频节点，**连线顺序就是时间轴顺序** |
| ② 写分镜表 | `motion_project {action:"create", storyboard}` | `storyboard.md`：每镜做什么 / 屏幕上出现什么 / 配什么字 |
| ③ 建工程 | `motion_project {action:"create"}` | `timeline.json`、`BRIEF.md`、`scene-<n>.tsx` 桩 |
| ④ 定调帧 | 只写 `scene-0` → `motion_preview`（`frames` 省略=每段中点） | 一张 styleframe，把纸色/字重/留白/动效气质定住再往下写 |
| ④a 可播放样片 | 主节点 `motion_render start` + `range` → `status` 确认完成 → 新建或复用独立样片节点 → `apply` 到样片节点 | 样片节点显示海报并可播放；`pilot.mp4` 文件和静帧拼图不会自动出现在画布上 |
| ⑤ 写画面 | 直接 `read` / `edit` 场景文件 | 一段一文件，每段 ≤120 行 |
| ⑥ 备素材 | `motion_assets {action:"gather"}`（整站） / `collect`（单页） / `fetch`（官方 logo） / `capture` / `crop` / `page` | 一次收齐：favicon、og 图、主视觉、内联字标、跨页聚合的配色与字体、2 倍视口截图；`page` 用无头 Chrome 截 HTML 模板或指定网址 |
| ⑦ 看画面 | `motion_preview {frames:[...]}` | 同一回合拿到拼图，首次打包 10–30 秒，之后复用缓存 |
| ⑧ 配声音 | `motion_audio {action:"add"}`、`motion_sfx search/get` | `timeline.audio[]` 多一条轨；音效与元数据保存在单一素材索引 |
| ⑨ 踩点 | `motion_sync bind` / `motion_audio_verify` | `timeline.sync`，切镜/动作/音效同源绑定与成片验收 |
| ⑩ 出片 | `motion_render start` → `status` → `apply` | `.out/film.mp4`，回填成画布上能播的 clip pack |

②③ 可以一次调用完成（`create` 同时吃掉 `storyboard`）。**先分镜表、后定调帧、再铺开写**，是因为这两步各能省掉一整轮返工：表不对就改表，风格不对就只改 `scene-0`。

`motion_render start` 立刻返回 `jobId`，渲染在宿主后台进程里跑——**不要用睡眠轮询**，中间继续做别的事，需要时 `status` 看一眼。

样片必须主动展示：用主节点和返回的 pilot `jobId` 查到 `status: done` 后，在同一画布页创建独立的「样片」视频节点，然后调用 `motion_render {action:"apply",nodeId:"样片节点 ID",jobId:"pilot jobId",source:"pilot"}`。检查返回的任务类型和节点并告知用户；失败时报告错误和样片文件路径。主节点留给完整成片。用户明确要求跳过样片时按其要求执行；用户要求先审样时，再等待反馈。

## 工程目录

每个视频节点一个工程，放在画布旁边：

```
<画布目录>/.drawai-motion/v2/<画布、页面和节点的标识>/
  BRIEF.md            这段片子要什么（人和模型都读）
  storyboard.md       分镜表：每镜做什么 / 屏幕上出现什么 / 配什么字
  timeline.json       画面轴：规格 + 每段的起止帧 + 音频轨
  scene-0.tsx …       一段一个 Remotion 组件（0 起，与时间轴一一对应）
  assets/             manifest.json + 素材文件（场景里用 staticFile('文件') 引用）
  beats.json          踩点结果（可选）
  .out/
    film.mp4          成片
    bundle/           Remotion 打包产物（按 bundleKey 复用）
    qa/               预览帧、拼图、报告
    jobs.json         渲染任务记录
```

画布记录了旧路径的 `<画布目录>/.drawai-motion/<节点 ID>/` 工程在首次可写访问时复制到隔离目录，原目录保留，历史渲染记录会指向复制后的成片。不同画布或页面即使节点 ID 相同也不再共享工程。

`timeline.json`：

```json
{
  "version": 1,
  "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 475,
  "shots": [
    { "id": "shot-1", "file": "scene-0.tsx", "startFrame": 0,   "durationFrames": 83,  "card": "brand-ink-open" },
    { "id": "shot-2", "file": "scene-1.tsx", "startFrame": 83,  "durationFrames": 192, "card": "chart-live-moves" }
  ],
  "audio": [
    { "id": "a1", "file": "bgm-archive.wav", "role": "bgm", "from": 0, "durationInFrames": 475,
      "gainDb": -7, "fadeIn": 24, "fadeOut": 60, "trimStart": 0, "loop": true, "duck": false }
  ]
}
```

- `motion_project create` 有镜头卡时按**卡片的时长**排时间轴（`83f@30fps` 取帧数，`5.6s` 乘 fps），没有卡才按 `segments` 均分，并在返回里说清楚是哪种。
- **镜头卡必须连到视频节点**：画布上有断连的卡时 `create` 直接报错（`allowUnlinkedCards:true` 才放行，并在 `warnings` 里记账）。连线同时是「进 assets 当参考」「镜头顺序」「段长」三件事，断连不是"只作参考"。
- 想控制总时长不用断连：显式传 `spec.duration` 时，卡片按相对时长**等比缩放**到总长，不会被卡的总和改短。
- 改时间轴只改 `timeline.json`，不要改文件里的帧号；场景里用 `useCurrentFrame()` 相对自己的段计时。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `motion_project` | `action: create\|open\|theme`、`path`、`nodeId`、`page`、`spec{width,height,fps,duration}`、`prompt`、`segments`、`storyboard`、`theme`、`themeTokens` | `create` 会写工程目录（含 `storyboard.md`、可选 `theme.ts`）并把 `data.motion` 挂到节点上；`theme` 换配色 |
| `motion_preview` | `path`、`nodeId`、`frames[]`（省略=每段中点）、`cols` | 渲染指定帧 → 拼一张图 → **作为附件直接回给对话** |
| `motion_render` | `action: start\|status\|list\|cancel\|apply`、`jobId`、`frames`、`range` | `start` 立即返回；`apply` 把成片回填成 clip pack |
| `motion_assets` | `action: list\|library\|use\|capture\|gather\|collect\|fetch\|crop\|palette\|page`、`nodeId`、`query`/`category`、`assetId`、`file`、`url` 等 | `library` 搜索插件素材，`use` 导入指定 `assetId`，`list` 查看工程素材；`gather` 扫站点，`capture` 捕获素材，`page` 截屏 |
| `motion_audio` | `action: list\|add\|remove\|analyze\|apply`、`file` 或 `audioNodeId`、`at`、`duration`、`role`、`gainDb`、`fadeIn`、`fadeOut`、`loop`、`duck` | 见[声音制作](motion-audio.md) |
| `motion_sfx` | `action: search\|get\|list`、`query`、`minDuration`、`maxDuration`、`limit`、`ids` | 搜索和下载 Freesound 音效，不做许可证审批；来源与分析写入单一素材索引 |
| `motion_audio_verify` | 无必填 | 从最近成片的音轨回测对拍误差 |
| `motion_qa` | `action: inspect\|report`、`file`、`freezeSeconds` | 成片帧检：帧数/黑场/静止/闪烁/空白/越界/削波，带帧号与镜头号 |
| `motion_export` | `action: run\|list`、`name`、`draft`、`subtitles[]`、`file` | 导出剪映素材包：逐镜 clips + 分轨 audio + SRT + README（可选草稿） |
| `shotcraft_search` | `query`、`category`、`cardId`、`styleKey`、`limit`、`offset` | 列表里带 `recipe` 路径；给 `cardId` + `styleKey` 直接返回**配方全文 + demo 源码** |
| `motion_task` | `action: list\|status\|cancel\|focus\|remove` | 只剩旧任务记录的管理，不再开工 |

## 渲染

- `src/motion/render.js` fork 出 `src/motion-render-worker.js`，交给 Remotion 打包 + 无头浏览器逐帧渲染，独立进程崩溃不影响宿主。
- 打包缓存键 `bundleKey` 覆盖：画面规格、每段源码、`assets/` 内容哈希、`src/motion/entry.jsx` 自身哈希。任何一项变了就重打包；没变直接复用 `bundle/`，所以改一行代码只付渲染的钱。
- 三种 operation：`compile`（只验证能编译）、`still`（只出指定帧）、`media`（整片 MP4）。10 分钟超时，`cancel` 会先让 worker 自杀式退出再兜底 kill。
- 输出 H.264 + AAC。音频由画面侧一起播，不再走「渲完再用 ffmpeg 混音」。

### 画质默认规格（L0）

编码参数以前写死在 worker 里（`renderMedia({codec:'h264',concurrency:2})`，等于 x264 的 crf 23 默认值），工程无从置喙。现在由 `src/motion/render-settings.js` 统一决定，读取优先级 **timeline.json 的 `render` → 调用参数 → 默认值**，越界会被夹取并在返回值 `warnings` 里报出来：

```json
{ "render": { "crf": 14, "preset": "slow", "scale": 1, "samples": 1, "shutter": 0.5, "concurrency": 2 } }
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `crf` / `preset` | 14 / slow | 母版质量。10–18，低于 10 只是变大 |
| `pixelFormat` / `colorSpace` | yuv420p / bt709 | 输出**打 bt709 三标签**；不打的片子淡紫、薄荷底会整体偏色 |
| `scale` | 1 | 超采样：`2` = 渲 2× 再 lanczos 缩回（等轴斜边锯齿的解药） |
| `samples` / `shutter` | 1 / 0.5 | 逐帧累积样本数与快门占空比，场景通过 `props.render` 读 |
| `timeoutMs` | 30 分钟 | 原为写死 10 分钟；`timeoutFor()` 还会按帧数缩放（0.25×–4×） |

三个约束：`estimatedCost = scale² × samples` **预算 8**，超了返回建议值（超采样与累积吃的是同一份预算）；预览永远按 1× 渲（`motion_preview` 要看构图，不要锯齿）；整片渲完自动过一遍 loudnorm + 限幅，默认 **−14 LUFS / −1 dBTP**（原 −16/−1.5）。

降级要留痕：不为编码质量做上述选择的，在 `STYLE.md` 写 `偏离：累积 1×，因为 …`，否则视为未做。

## 回填

`motion_render apply {nodeId}` 把 `.out/film.mp4` 落成画布上的 clip pack：

```
<画布>.media/<clipId>/
  manifest.json   { kind:"raster", fps, width, height, source:"source.mp4", sourceOffset:0 }
  source.mp4      成片本体
  poster.svg      首帧海报（节点缩略图）
  frames/ stills/ 预留（raster 模式不抽帧）
```

节点 `data` 写入 `mediaClip / mediaKind=raster / mediaW / mediaH / mediaFps`，`style` 换成 `shape=image` + 海报 SVG，画布上直接 `<video>` 播放。单个文件上限 512MB；`manifest.duration` 在 raster 模式下恒为 0，播放器读视频自身 metadata，不影响播放。

## 素材

- `motion_assets capture` 认图片（png/jpg/webp/gif/avif，24MB）、音频（mp3/wav/m4a/aac/ogg/flac，24MB）、视频（mp4/webm/mov/mkv，256MB）；复制进 `assets/` 并**按 SHA-256 去重**。
- `motion_project create` 将 DrawAI 原创程序生成的基础素材写进工程 `assets/builtin/`，通过 `motion_assets list` 可发现：`paper.svg` 暖纸、`grain.svg` 颗粒、`grid.svg` 白色网格，以及 `whoosh.wav` 和 `impact.wav` 两个合成音效。SVG 用 `staticFile('builtin/paper.svg')` 等引用；音效用 `motion_audio add` 的 `file: 'builtin/whoosh.wav'` 等引用。素材随插件代码生成，无需下载，按插件 MIT 许可分发；它们是通用素材，不是上游示例原素材。重复 create 不覆盖已修改文件；已有工程重新 create 可补入缺失素材。
- 插件素材库包含 9 张纹理和 102 个 FLAC 乐器采样，随发布包提供。其中 8 张灰尘、颗粒和胶带纹理的来源与许可未逐项明确，见 `src/motion/media-library/NOTICE.md`。`motion_assets {action:"library", query:"钢琴"}` 可按中英文、类别或文件名检索实际存在的素材；`{action:"use", assetId:"<返回的 id>"}` 才把所选文件拷贝进工程并登记哈希、来源和许可。图片用返回的 `staticFile(...)`，采样可用 `motion_audio add` 加到时间轴；采样是单个乐器音，不会自动编曲。素材库不会整套复制到每个工程。
- 示例（以下调用均需传当前视频节点的 `nodeId`）：先 `motion_assets {action:"library", nodeId, query:"纸张"}`，再用返回条目的 `id` 调 `motion_assets {action:"use", nodeId, assetId:id}`。图片使用返回的 `file` 写 `staticFile(file)`；音频另外执行 `motion_audio {action:"add", nodeId, file, role:"sfx", at:0}`。导入只准备文件，不会自动进入画面或音轨；素材不适合时可继续使用用户素材或其他来源。
- 这些操作作用于 `motion_project` / `motion_render` 的工程。`motion_task` 走独立的画布素材快照，不会自动读取该工程的 `assets/`；使用 `motion_task` 时需将素材导入画布节点并连接视频节点。
- `motion_assets gather` 给一个站点（`url`，或只给 `brand`）：扫首页 + 导航里挑出的内页（`pages` 默认 4，上限 6），把 favicon、og:image、主视觉、产品截图、内联 `<svg>` 字标一次收齐，**跨页聚合**实测配色与字体，再补三条品牌 logo 来源（Simple Icons 矢量 / Clearbit 512 / 高清 favicon），每页给一张 2 倍视口截图。先 `dryRun:true` 看清单。
- `motion_assets collect` 只扫一个页面（同一套扫描，默认 8 张），适合"就这一屏"的场合。
- `motion_assets fetch` 直接把一个 http(s) 地址的原图或官方 SVG 下载进 `assets/`（品牌 logo 用它，别截图、别重画）；`svg` 记 `kind: "vector"`，跳过 ffprobe 量尺寸，`source` 记 URL。上限 24MB。
- `motion_assets page` 起一次无头 Chrome（`DRAWAI_CHROME_PATH` 或系统 Chrome/Edge），把传进来的 `html` 文本写进 `.out/capture/` 再截图，`scale` 默认 2 即 2 倍图。写「产品界面在屏幕上」的镜头用它，比手动截图再拖进来省一步，也不受画布缩放影响。
- `assets/manifest.json` 记 `id / file / bytes / sha256 / width / height / average / colors / source / caption / kind`；音频额外给 `seconds` 与 `samplePeakDb`。
- 音效用 `motion_sfx search → get`，下载到 `assets/sfx/`，只维护一份 `assets/audio-manifest.json`；不生成额外署名文件。返回的 `suggestedGainDb` 可用于 `motion_audio add`。
- 复制后统一 `chmod 644`——从资源管理器或 `Copy-Item` 拖进来的图片常带只读位，Remotion 打包复制 `public/` 时会直接 `EPERM`。
- 场景里用 `staticFile('文件名')` 引用，`publicDir` 就是 `<工程>/assets`；不要写绝对路径，也不要用外链图床。

## 镜头卡

- 卡片只是**设计参考**，不进成片：`shotcraft_search` 搜到卡 → `diagram_apply` 建 `shotcard` 节点 → `addEdge` 连到视频节点，连线编号就是镜头顺序。
- `shotcraft_search {cardId, styleKey}` 返回 `recipe`（卡片配方全文，含参数表：入场帧、保持区间、退场位移）、`demoSource`（上游示例 TSX）、`preservation`（哪些参数不能改）。**动手写场景前先读配方**，照着改比凭印象写快得多。
- 依赖用别名：`@shotcraft/lib/*` 指向共享组件（DigitRoll、PageCam、Caption、FlashCut…），`@shotcraft/demos/*` 指向上游示例；本地文件优先。
- 换卡会改变时间轴长度（卡片时长即段长），换完要重新 `create` 或手动改 `timeline.json`。

## 帧检

`motion_qa {action:"inspect"}` 把"片子有没有毛病"变成一张带帧号的清单，不靠眼睛：

- 降到 480 宽再扫：`signalstats` 取逐帧 YMIN/YAVG/YMAX（黑场、空白帧、单帧闪烁），四边各裁一条再取 YAVG（画面顶到边的安息角），`blackdetect` / `freezedetect`（静止段），有音轨时 `ebur128` + `silencedetect`（响度、削波、整段静音）。
- 每条检查带 `level`（pass / info / warn / fail）与镜头号，`verdict` 取最差一级；报告落在 `<工程>/.out/qa/framecq/report.json`，`action:"report"` 读上次结果。
- 判读约定：静止段 ≥2×`freezeSeconds`（默认 1.2s）记 warn，1.2–2.4s 记 info（"像是设计停留"，不拦）；真峰值 > −0.1 dBFS 记 warn —— 这一档抓到过真实缺陷。

## 剪映导出

`motion_export {action:"run"}` 把工程拆成还能继续剪的素材（`<工程>/.out/export/<name>/`）：

```
clips/shot-N.mp4     逐镜头画面，无声，按时间轴精确切（重编码，不靠关键帧 → 切点不偏）
audio/bgm-1.mp3 …    原音轨分轨：BGM 一条、音效各一条
shots.json           镜序、进出点、帧号
audio.json           每条音轨的 at / seconds / gainDb / fade / loop / duck / 缺文件
subtitles.srt        时间轴里有 subtitles 或调用时给 subtitles[] 才生成
film.mp4             完整成片，对照用
README.md            在剪映里怎么拼回去
draft_content.json   draft:true 时额外写一份草稿（结构按剪映 360000 版本，未在剪映本体实测）
```

切镜用 `-ss/-to` + libx264 crf18 而不是 `-c copy`：copy 只能从关键帧起切，会偏 1–2 秒。`--draft` 时材料 id、三条轨道（video/audio/text）、视频轨总长与微秒时间码都自洽，但剪映能否原样导入没有验证过，交付时要如实说明。

## 整片风格（mg-styles-15）

14 种 MG 视觉语言，来源 [Vincentwei1021/mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15)（MIT，commit `49052d8`）：上游是 15 份结构化提示词 + 15 支手写 `renderAt(t)` 成片（Canvas2D / WebGL / three.js），这里把它们编译成能在 Remotion 里施工的风格包。

**上游的 04-3d-render（C4D/Blender 质感的 CGI 软着陆）没有收进来。** 理由不是「品味」，是工具边界：那支的画面是 Blender 离线渲出来的（物体的接触阴影、次表面散射、景深虚化都在渲染器里），插件里没有任何等价物——拿 DOM 的 `backdrop-filter` 或 CSS 假光去凑，只会得到「假 3D」，那正是这条风格的反面。要那种质感，正确做法是外部渲好当素材回灌：`motion_assets capture` 收进来，或作为参考段进 `reference-media`。风格库不再列它，也不要再手写一个「看起来像 CGI」的替代品。

- 发现：`mg_style {action:"list"}` 给 14 条的判据、色板、字体、节奏；`{action:"search", query}` 按关键词找；`{action:"read", slug}` 返回施工包（8 节 brief + 上游提示词全文 + 源码清单）。
- 阅读：`{action:"source", slug}` 不带 `files` 列上游文件与大小，带 `files:["demos/09-bauhaus/film.js"]` 读正文（单文件截 120k）。**brief 是移植说明书，源码是细节参考**——不要把 44KB 的 `film.js` 整份搬进场景。
- 画布：`diagram_apply addNode {shape:"mgstyle", slug:"09-bauhaus"}` 建「整片风格」节点，`addEdge` 连到视频节点；rail 上的风格库（三块色卡图标）与双击节点都能换风格。**一条片子只用一种整片风格**，多连会报错；它和镜头卡分工不同——风格管整片（色板/字体/网格/节奏/动效语法），卡管单镜运动。
- 建工程：挂了风格节点（或 `motion_project {action:"create", style:"09-bauhaus"}`）时，`palette` 写成风格化的 `theme.ts`、brief 全文写成 `STYLE.md`、`fonts` 合进主题，风格的 `rhythm`（fps / 时长 / 画幅）成为 spec 缺省值；`timeline.json` 顶部记 `style`，`STYLE.md` 进 `BRIEF.md` 的约定段。`design.json` 的 `production.mgStyle` 记住 slug / commit / 判据 / brief 哈希，便于追溯像不像。
- 引擎契约（硬规定）：每种风格的 `catalog.json` 都记了 `engine / engines / engineNote / engineFiles`，由 `tools/mgstyles-catalog.mjs` **扫描上游源码自动检测并校验**（声明与实测不符会让生成直接失败）。three.js 的风格（03 等轴 / 10 复古霓虹 / 22 HUD）必须用 `three` 或 `@remotion/three` 真渲染；WebGL2 的风格（07 液态 / 12 极光 / 09 包豪斯印刷 pass / 20 像素 CRT）必须起 `getContext("webgl2")` 编译上游 GLSL；Canvas2D / DOM 风格同样按 `engines` 来。**不许用 CSS 3D、div 层叠、Canvas2D 渐变模糊「简化」替代**——那正是这些风格的判据。
- 引擎门禁：`STYLE.md` 写入「引擎契约」段（上游证据文件 + 逐引擎做法）；`motion_render start`（样片与成片）渲染前扫工程源码（不含 `.out`/`node_modules`），重引擎 `three / webgl2 / webgl` 缺失直接报错拒绝渲染。确实要换实现，先在 `STYLE.md` 写一行「偏离：引擎 X 改为 Y，因为 Z」，渲染会带 warning 通过（偏离记录在 `summary` 与 `details.engine` 里）。
- 动效画像与参考帧：`catalog.json` 的 `motion` 是从上游源码扫出来的（`transitions: wipe|cut`、`impact`、`camera`、`motionBlur:{samples,shutter}`、`grain:{size}`、`secondary`、`feather`）。`mg_style {action:"frames", slug}` 会起本地静态服务 + Chrome 打开上游 demo，按 `cues.json` 的时间点调 `renderAt(t)` 截 8 张 PNG 到临时目录（缺字体/纸纹用占位兜底，`notes` 里写明）。写场景前逐张看，再按 `STYLE.md`「效果配方」逐项做；只做形不做动，就是「形似而动不像」。
- 效果配方：建工程时 `STYLE.md` 会写「## 效果配方（必做，逐项对照参考帧）」表——转场 / 冲击 / 相机 / 运动模糊 / 颗粒 / 二次运动 / 软边，每项都有「上游怎么做」与「这里必须做到」，并附取帧命令；`timeline.style.motion` 同时留档，便于事后核对。
- 字体是最大损失：上游 46 个字体文件不在仓库里，brief 第 3 节给的是 Windows 自带替代栈与字距补偿；需要在 `BRIEF.md` 里如实写「字体非原版」。
- 索引与源码库用 `manifest.json` 的 commit 对齐：`mg 风格索引与源码库版本不匹配` 就重跑 `node tools/mgstyles-catalog.mjs`。新增/修改风格 brief 后也要重跑它（fragment 在 `src/motion/mgstyles/catalog.d/<slug>.json`）。

## 主题

`motion_project` 的 `theme` / `themeTokens` 会在工程里生成 `theme.ts`：`PAPER / SURFACE / FIELD / INK / DUST / STAMP / BORDER` 加三套字体常量，场景 `import { PAPER, INK } from './theme'` 即可。色板来自上游 `template/src/themes/palettes.json` 的 8 套（vintage-kraft / deep-ocean / obsidian-violet / modern-light / midnight / solar-pop / coral-burst / color-play），另加内置 `paper-ink`；`themeTokens` 可以直接给一套色（别名 `paper/ink/dust/stamp` 会映射到 `page/text/muted/accent`）。已有的手写十六进制不会被改写 —— 换主题只影响用了 `theme.ts` 常量的画面。

## 规格与环境

- 2–60 秒、12–30 fps、边长 256–1920；默认 1920×1080 / 30fps。
- 渲染需要浏览器：优先 `DRAWAI_CHROME_PATH`，Windows 上依次找 Chrome / Edge，都没有时由 Remotion 下载 Chromium。
- 探针、拼图、抽音轨需要 FFmpeg（`_local/bin/ffmpeg.exe` 或 PATH 里的）。
- 暂不支持：扩散式图生视频、shadcn/MotionWorkbench 式可视化时间线、上游演示依赖的字体与视频素材（需用自己的素材适配）。

### 离线环境（无网络）怎么办

实测过一整轮全离线制作，能走通，但有几件事必须提前知道：

- **字体**：`fonts.googleapis.com` 用不了，字体只能预先放进工程 `assets/` 并在场景里用 `@font-face` 注册（或 `staticFile` 引用）。字体门禁会拦"声明了但没注册"的 family —— 这是有意的：静默退回系统字体在成片里很难看，也很难事后发现。
- **npm 包**：装不了新依赖。`three` / `@react-three/fiber` 已在插件里；要用别的库得事先 vendor。
- **音效**：`motion_sfx` 需要网络，离线时只能用工程里已有的素材或自己导入。
- **`mg_style frames`**：上游 demo 的 importmap 指向 `/node_modules/*`，缺包时页面根本加载不起来。报错会直接列出缺哪个包 —— 这时别反复重试，改 `action:"source"` 读 `demos/<slug>/js/*.js` + `cue.json` 反推动效。目前 `three` 在，`opentype.js / simplex-noise / topojson-client` 不在，所以少数 demo（如 03-isometric 的标题挤出字）取不了帧。

### 常见报错对照

| 报错 | 真正的原因 |
|---|---|
| `上游 demo 没有就绪（45 秒），缺资源：…` | 页面依赖的资源没服务出来，看列出的路径 |
| `这个 demo 的依赖没装在本机（…）` | importmap 指向的 npm 包不在插件 `node_modules` 里 |
| `各镜加起来是 X 帧，视频节点是 Y 帧` | 分镜表帧区间之和 ≠ 节点时长；报错里给了两种改法 |
| `字体没注册，拒绝渲染` | 场景里用了没 `@font-face` / 没放进 assets 的 family |
| `分镜表 N 行，时间轴是 M 段` | 分镜表行数与镜头卡排布不一致；多出的行不会自动开段 |

## 与旧版差异

| 旧 | 现在 |
|---|---|
| 点「开始绘制视频」→ 后台制作 Agent 跑 80 轮 | 对话里同一个 agent 直接读写 `scene-*.tsx` |
| `.agent/state.json` + receipts + resume/revise/remix | 工程目录即状态，改完重新渲染即可 |
| `.drawai.media/motion-<任务 ID>/project/` | `<画布目录>/.drawai-motion/v2/<画布、页面和节点的标识>/` |
| 十个内层工具（project_files / project_render / image_view / finish_production …） | 五个动词工具 + 宿主原生 `read`/`edit`/`pwsh` |
| 成片后 ffmpeg 混音 | 渲染时画面侧播放音轨 |
| 页面采集、film-review 全片验收 | 未迁移；`motion_preview` 看帧是现在的验收手段 |

## 验证

- `node tools/build.mjs`：构建宿主与客户端 bundle。
- `npm test`：画布、文档、媒体、导出、后台队列等回归（不含视频创作）。
- `npm run test:motion-film-ui`：真实浏览器里的视频卡片与预览交互。
- 旧的 `test:motion-agent`、`test:motion-vision`、`test:motion-capture-film`、`check-motion.mjs`、`check-shotcraft.mjs` 已随内层 agent 一起删除。

`src/motion/shotcraft/` 包含上游 ClipCard 的 Apache-2.0 许可证与来源声明；Remotion 的许可独立适用。
