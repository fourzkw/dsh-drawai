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
| ⑤ 写画面 | 直接 `read` / `edit` 场景文件 | 一段一文件，每段 ≤120 行 |
| ⑥ 备素材 | `motion_assets {action:"capture"}` / `crop` / **`page`** | 图片/音频/视频进 `assets/`（附尺寸与主色板）；`page` 用无头 Chrome 截 HTML 模板或网址 |
| ⑦ 看画面 | `motion_preview {frames:[...]}` | 同一回合拿到拼图，首次打包 10–30 秒，之后复用缓存 |
| ⑧ 配声音 | `motion_audio {action:"add"}`、`motion_sfx search/get` | `timeline.audio[]` 多一条轨；音效带许可与 `FREESOUND-CREDITS.md` |
| ⑨ 踩点 | `motion_audio analyze` / `apply` | `beats.json`，切镜吸附到拍子 |
| ⑩ 出片 | `motion_render start` → `status` → `apply` | `.out/film.mp4`，回填成画布上能播的 clip pack |

②③ 可以一次调用完成（`create` 同时吃掉 `storyboard`）。**先分镜表、后定调帧、再铺开写**，是因为这两步各能省掉一整轮返工：表不对就改表，风格不对就只改 `scene-0`。

`motion_render start` 立刻返回 `jobId`，渲染在宿主后台进程里跑——**不要用睡眠轮询**，中间继续做别的事，需要时 `status` 看一眼。

## 工程目录

每个视频节点一个工程，放在画布旁边：

```
<画布目录>/.drawai-motion/<节点 ID>/
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
- 改时间轴只改 `timeline.json`，不要改文件里的帧号；场景里用 `useCurrentFrame()` 相对自己的段计时。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `motion_project` | `action: create\|open\|theme`、`path`、`nodeId`、`page`、`spec{width,height,fps,duration}`、`prompt`、`segments`、`storyboard`、`theme`、`themeTokens` | `create` 会写工程目录（含 `storyboard.md`、可选 `theme.ts`）并把 `data.motion` 挂到节点上；`theme` 换配色 |
| `motion_preview` | `path`、`nodeId`、`frames[]`（省略=每段中点）、`cols` | 渲染指定帧 → 拼一张图 → **作为附件直接回给对话** |
| `motion_render` | `action: start\|status\|list\|cancel\|apply`、`jobId`、`frames`、`range` | `start` 立即返回；`apply` 把成片回填成 clip pack |
| `motion_assets` | `action: list\|capture\|crop\|palette\|page`、`file` 或 `sourceNodeId`、`name`、`caption`、`x/y/w/h`、`html`/`url`/`width`/`height`/`scale`/`wait` | 素材进工程；`capture` 返回可直接粘进场景的 `staticFile(...)` 写法；`page` 用无头 Chrome 截屏 |
| `motion_audio` | `action: list\|add\|remove\|analyze\|apply`、`file` 或 `audioNodeId`、`at`、`duration`、`role`、`gainDb`、`fadeIn`、`fadeOut`、`loop`、`duck` | 见[声音制作](motion-audio.md) |
| `motion_sfx` | `action: search\|get\|list`、`query`、`minDuration`、`maxDuration`、`limit`、`ids` | Freesound 音效：搜索**不按许可过滤**（结果带许可，用哪条由人决定），下载时复核详情页许可并写署名清单 |
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
- `motion_assets page` 起一次无头 Chrome（`DRAWAI_CHROME_PATH` 或系统 Chrome/Edge），把传进来的 `html` 文本写进 `.out/capture/` 再截图，`scale` 默认 2 即 2 倍图。写「产品界面在屏幕上」的镜头用它，比手动截图再拖进来省一步，也不受画布缩放影响。
- `assets/manifest.json` 记 `id / file / bytes / sha256 / width / height / average / colors / source / caption / kind`；音频额外给 `seconds` 与 `samplePeakDb`。
- 音效不在 `motion_assets` 里：用 `motion_sfx search → get`，下载到 `assets/sfx/`，同时生成 `assets/audio-manifest.json` 与 `assets/FREESOUND-CREDITS.md`。搜索**不按许可过滤**——结果里带每条的音效许可，用不用、怎么署名由人决定；`get` 仍会在详情页再核一遍许可并记进清单。返回里的 `suggestedGainDb` 是「让这条音效落在 −16dB RMS 附近」的增益，直接给 `motion_audio add` 的 `gainDb`。
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

## 主题

`motion_project` 的 `theme` / `themeTokens` 会在工程里生成 `theme.ts`：`PAPER / SURFACE / FIELD / INK / DUST / STAMP / BORDER` 加三套字体常量，场景 `import { PAPER, INK } from './theme'` 即可。色板来自上游 `template/src/themes/palettes.json` 的 8 套（vintage-kraft / deep-ocean / obsidian-violet / modern-light / midnight / solar-pop / coral-burst / color-play），另加内置 `paper-ink`；`themeTokens` 可以直接给一套色（别名 `paper/ink/dust/stamp` 会映射到 `page/text/muted/accent`）。已有的手写十六进制不会被改写 —— 换主题只影响用了 `theme.ts` 常量的画面。

## 规格与环境

- 2–60 秒、12–30 fps、边长 256–1920；默认 1920×1080 / 30fps。
- 渲染需要浏览器：优先 `DRAWAI_CHROME_PATH`，Windows 上依次找 Chrome / Edge，都没有时由 Remotion 下载 Chromium。
- 探针、拼图、抽音轨需要 FFmpeg（`_local/bin/ffmpeg.exe` 或 PATH 里的）。
- 暂不支持：扩散式图生视频、shadcn/MotionWorkbench 式可视化时间线、上游演示依赖的字体与视频素材（需用自己的素材适配）。

## 与旧版差异

| 旧 | 现在 |
|---|---|
| 点「开始绘制视频」→ 后台制作 Agent 跑 80 轮 | 对话里同一个 agent 直接读写 `scene-*.tsx` |
| `.agent/state.json` + receipts + resume/revise/remix | 工程目录即状态，改完重新渲染即可 |
| `.drawai.media/motion-<任务 ID>/project/` | `<画布目录>/.drawai-motion/<节点 ID>/` |
| 十个内层工具（project_files / project_render / image_view / finish_production …） | 五个动词工具 + 宿主原生 `read`/`edit`/`pwsh` |
| 成片后 ffmpeg 混音 | 渲染时画面侧播放音轨 |
| 页面采集、film-review 全片验收 | 未迁移；`motion_preview` 看帧是现在的验收手段 |

## 验证

- `node tools/build.mjs`：构建宿主与客户端 bundle。
- `npm test`：画布、文档、媒体、导出、后台队列等回归（不含视频创作）。
- `npm run test:motion-film-ui`：真实浏览器里的视频卡片与预览交互。
- 旧的 `test:motion-agent`、`test:motion-vision`、`test:motion-capture-film`、`check-motion.mjs`、`check-shotcraft.mjs` 已随内层 agent 一起删除。

`src/motion/shotcraft/` 包含上游 ClipCard 的 Apache-2.0 许可证与来源声明；Remotion 的许可独立适用。
