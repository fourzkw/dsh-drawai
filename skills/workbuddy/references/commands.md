# wb 命令参考

`wb` 是 `node bin/wb.mjs` 的简写。所有命令都接受：

| 全局参数 | 作用 |
| --- | --- |
| `--dir D` | 工程目录（默认当前目录；大多数命令也可把目录写在第一个位置参数） |
| `--json` | 输出机器可读 JSON（同一条命令不打印给人看的排版） |

退出码：0 成功，1 失败（stderr 给一句话原因 + 下一步该敲什么）。

---

## 开工

### `wb setup [--install]`

检查 node / @babel / npm / 素材 / 视频运行时 / FFmpeg。`--install` 会：技能根 `npm install`、下载素材、安装视频运行时、尝试安装 FFmpeg。

### `wb doctor`

同一次检查，但只报告，不装任何东西。缺什么给安装命令。**排障第一步永远是这条。**

### `wb create [--dir D]`

建工程（目录已存在 `timeline.json` 时拒绝，除非 `--force`）。

| 参数 | 说明 |
| --- | --- |
| `--spec 1920x1080@30` | 画幅 + 帧率；也认 `9:16`、`1080x1920@24/12s` |
| `--duration 12` | 秒数；不给就看分镜表帧总和，再不然用风格节奏，最后 15s |
| `--storyboard 表.md` | 六列分镜表；不给就读 `<dir>/storyboard.md` |
| `--segments 4` | 没有分镜表时均分几段 |
| `--cards "卡名:样式,卡名:样式"` | 用镜头卡开段（时长取卡/样式的 `duration`） |
| `--style 09-bauhaus` | 整片风格：色板写进 `theme.ts`，施工说明写进 `STYLE.md` |
| `--theme vintage-kraft` / `--tokens '{"page":"#F7F3EA",...}'` | 主题；`--tokens` 优先 |
| `--prompt "…"` | 写进 `BRIEF.md` 的一句话 |
| `--force` | 覆盖已有工程 |

产出：`timeline.json`、`BRIEF.md`、`storyboard.md`、`STYLE.md`（有风格时）、`theme.ts`（有主题/风格时）、`scene-N.tsx` 骨架、`scene-kit/`、`assets/`（内置素材 + 字体）、`index.jsx`。

### `wb open [--dir D]`

看工程：规格、每段帧区间与文件、音轨、字幕、已有产出、缺哪些场景文件。

### `wb theme [--list | --name 名字 | --tokens JSON]`

列主题 / 看当前主题 / 换主题（重写 `theme.ts`）。内置主题：`vintage-kraft`、`deep-ocean`、`obsidian-violet`、`modern-light`、`midnight`、`solar-pop`、`coral-burst`、`color-play`、`paper-ink`。

### `wb spec [read|validate|scaffold]`

- `read`（默认）：打印规格与时间轴，检查逐段是否首尾相接。
- `validate`：只做连贯性检查，有问题列出来。
- `scaffold`：写一张六列分镜表骨架到 `<dir>/storyboard.md`（已存在时需 `--force`）。参数：`--rows N`。

---

## 写与看

### `wb preview [--dir D] [--frames 0,60] [--at 1.5,3] [--crop x,y,w,h] [--cols 3]`

渲几帧拼成一张图（默认取每段 60% 处的帧，最多 6 帧）。`--crop` 出 1:1 局部（不缩放，用来看锯齿/色带）。需要 FFmpeg。

### `wb render [--frame N... | --frames N,... | --range from,to] [--wait]`

| 用法 | 产出 | 说明 |
| --- | --- | --- |
| `--frames 0,60` | `.out/still/frame-0060.png` | 静帧；不产 mp4 |
| `--range 0,90` | `.out/pilot.mp4` | 样片；不做响度归一 |
| 无参数 | `.out/film.mp4` | 整片；有音轨时做混音与归一 |
| `--wait` | — | 前台跑并打进度；默认是后台任务 |

整片渲染前会跑两道闸：`assertEngineFidelity`（风格声明的 three/webgl2 是否真用了）+ `assertQualityEvidence`（`STYLE.md` 的画质配方是否落实）。

### `wb render status|list|cancel|apply`

- `status [--job id]`：任务进度（不给 id 就取最近一条）。
- `list`：任务表。
- `cancel --job id`：写取消标记并杀进程。
- `apply --job id`：把成片拷到工程根目录 `out-<kind>.mp4`。

任务记录在 `<dir>/.out/jobs/<id>.json`，字段：`id,kind,dir,output,status,progress,phase,frames,range,startedAt,finishedAt,error,bytes,seconds`。

### `wb status [--dir D]`

工程概览 + 最近 5 个任务。

### `wb qa [--file 片子] [--freeze 1.2]`

帧检（默认检 `.out/film.mp4`）：帧数、纯黑段、静止段、单帧闪烁、连续空白、四边安全区、色带、斜边过渡、字体、响度。需要 FFmpeg。检样片（`pilot.mp4` 或 `--file` 指定的片段）时，「帧数不一致」按 warn 处理并注明这是样片；整片仍然按 fail 算。

### `wb export [--draft] [--subtitles] [--name jianying] [--list]`

导出剪映素材包：逐镜切好的 `clips/`、音轨 `audio/`、`shots.json`、`audio.json`、`README.md`，有字幕时给 `subtitles.srt`；`--draft` 再写一份 `draft_content.json`。`--list` 看导出历史。需要 FFmpeg。

---

## 声音

### `wb voice [list|plan|say|align]`

| 参数 | 说明 |
| --- | --- |
| `--script 文件` | 默认 `<dir>/voice.script.md`；以 `#` 开头的字符串按正文处理 |
| `--voice zh-CN-XiaoxiaoNeural` | 音色 |
| `--rate +8%` / `--pitch +0Hz` | 语速 / 音高 |
| `--cps 4.8` | 估算字/秒（plan 时用） |
| `--fit grow|exact|none` | 镜头只增不减 / 按旁白收紧 / 不动时长 |
| `--gain 0` | 旁白增益 dB |
| `--force` | 忽略缓存重新合成 |

`plan` 只给排期预览、**不写时间轴**（这一步音频还没合成，写进去会让下一次 render 找不到文件）；`say` 会真合成（edge-tts，拿不到退 Windows SAPI），按真实时长重排镜头，字幕写进 `timeline.subtitles`；`align` 用已有音频按真实时长对齐。

### `wb sfx [search|get|list]`

- `search "paper whoosh" [--min 0 --max 3 --limit 8]`：**短词最灵**；返回 id/时长/许可/预览地址。
- `get --id fs:12345`（或 `wb sfx get fs:12345 fs:678` 一次多个）：下载到 `assets/sfx/`，并量峰值写进 `assets/audio-manifest.json`。
- `list`：已下载的音效。

### `wb audio [add|list|remove|analyze|apply]`

| 动作 | 参数 |
| --- | --- |
| `add` | `--file X`（本机路径或 assets 内文件名）、`--role bgm|sfx|voice`、`--at 秒`、`--gain dB`、`--duration 秒`、`--fade-in 秒`、`--fade-out 秒`、`--loop`、`--no-duck` |
| `list` | — |
| `remove` | `--id <cueId>` |
| `analyze` | `--file 音乐`：量 BPM/拍点，写 `beats.json` |
| `apply` | `--tolerance 4`：把每段起点吸到最近拍点（有 `--beats` 也用同一份） |

增益口径：显式 `--gain` > 音频清单建议值 > 角色默认（bgm −10dB、sfx 0、voice 0）。已绑拍点（`timeline.sync`）的工程里 `audio apply` 会拒绝，改用 `wb sync bind`。

### `wb sync [bind|list|clear]`

- `bind --music <cueId> --anchors <JSON 文件|JSON 文本> [--tolerance 2] [--offset 秒]`：分析音乐写 `timeline.sync`（切镜/动作/音效统一对拍点）。容差 0–3 帧，锚点 1–200 个（必填）。
  - 锚点格式：`[{"id":"a1","type":"cut","shotId":"shot-1","at":0.5}]`；`shotId` 是 `shot-1` 这种 id（不是序号），按拍号写 `"beat":2`，动作再写 `"name"`、`"visual":{"metric":"change"}`、`"sfx":[{"cueId":"cue-…","peakSeconds":0.02}]`。
  - 文件带 BOM（记事本 / PowerShell 5 默认）也能读；按 `beat` 绑定要求音乐有稳定网格，量不出来就改用 `at` 的实测秒数。
- `list` / `clear`。

### `wb verify [--file 成片]`

按 `timeline.sync` 的锚点做音画对照验收，输出每项误差（>容差算 fail）。需要 FFmpeg。

---

## 素材与配方

### `wb assets [list|library|use|page|gather|collect|fetch|palette|crop|capture]`

| 动作 | 参数 | 说明 |
| --- | --- | --- |
| `list` | — | 工程内素材 |
| `library [关键词] [--category paper]` | 内置素材库（111 项：102 音效 + 9 纹理） |
| `use --id <assetId>` | 导入内置素材 |
| `page --url https://… [--html 文件] [--width 1440 --height 900 --scale 2 --wait 1200 --name X]` | 截整页 |
| `gather --url … [--brand …] [--pages 4 --limit 12 --min-width 240 --dry-run]` | 整站收 logo/配色/字体/主视觉/截图 |
| `collect --url …` | 单页收素材 |
| `fetch --url 直链 [--name X]` | 下载原图/官方 SVG |
| `palette --file 图` | 读色板 |
| `crop --file 图 --x 0 --y 0 --w 800 --h 400 [--name X]` | 裁切 |
| `capture --file 本机图` | 引进工程（sha256 去重） |

`--file` 三种写法都认：绝对路径、工程内相对路径（`.out/poster.png`）、`assets/` 里的文件名（`builtin/impact.wav`）。

### `wb card [list|search|show]`

- `list [--category …]`：124 张镜头卡的目录。
- `search 纸张`：按名字/用途/分类搜。
- `show --card <卡名> --style <样式key>`：这张卡的正确用法、受保护参数、参数指纹、demo 源码（`--full` 全给）。

### `wb style [list|search|read|source|frames]`

- `list` / `search 包豪斯`：14 种整片风格。
- `read --slug 09-bauhaus`：色板、字体、节奏、引擎、施工说明（`--full` 给全文）。
- `source --slug 09-bauhaus [--files demos/09-bauhaus/film.js]`：上游实现正文。
- `frames --slug 09-bauhaus [--times 0,1.5,3] [--count 8] [--dir 输出目录]`：从上游 demo 抽参考帧（需要素材 + 浏览器）。

---

## 隐藏命令

`wb __render …` 是 `render` 自己 spawn 的后台入口（带 `--job`），不要手敲。
