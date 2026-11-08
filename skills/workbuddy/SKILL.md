---
name: workbuddy
display_name: 代码视频工作台
display_name_en: Code Video Studio
description: 用代码（Remotion + React + three/WebGL）做视频：建工程、写场景、出定调帧、渲样片与整片、做声音、帧检、导出剪映。用于"把一段内容做成能播的片子"，不依赖 DrawAI 插件，也不需要画布。
description_zh: 把文案做成能播的视频：写 React/TSX 场景，渲样片与整片，配音轨、做帧检、导出剪映包。
description_en: Turn copy into a playable video by writing React/TSX scenes, rendering pilot and final cuts, with voice, QA and Jianying export.
version: 0.4.2
author: DrawAI
examples_zh:
  - "把这段产品介绍做成 15 秒竖屏视频，节奏快点"
  - "给我做一个数据可视化的开场，1920x1080，30fps"
  - "这条片子加个旁白和背景音乐，导出剪映工程"
examples_en:
  - "Turn this product copy into a 15-second vertical video"
  - "Make a data-visualisation opening at 1920x1080, 30fps"
  - "Add narration and BGM to this film and export a Jianying project"
---

# Workbuddy

一句话：`wb` 是一个命令行工具——**你把画面写成 React/TSX 场景，它渲成 mp4**。时间轴、字体、主题、音轨、帧检、剪映导出都在里面。

**什么时候用**：要做一条 5 秒到 1 分钟、画面精确可控（排版、数据、界面、3D）的片子；用户给的是内容与调性，不是素材。
**什么时候不用**：把现成素材剪一剪（用剪辑软件）、做真人拍摄、做需要模型生成画面的镜头。

---

## 0. 第一次用：先跑环境检查

```bash
node --version                             # 需要 ≥ 20
npm --prefix scripts install --omit=dev    # 只装 @babel/parser / @babel/traverse / npm（约 21MB）
node scripts/bin/wb.mjs doctor             # 四件事：babel / 素材 / 运行时 / FFmpeg
```

`doctor` 会报四件事：

| 项 | 缺失时怎么补 |
| --- | --- |
| 素材（字体 + 内置纹理/音效，约 150MB） | `node scripts/bin/wb.mjs setup --install`（下载到 `~/.dsh/drawai-assets`），或把 `WORKBUDDY_ASSETS_DIR` 指到已有素材根 |
| 视频运行时（remotion/react/three，约 300MB） | **首次渲染会自动装**，装到 `~/.dsh/drawai-video-runtime/<指纹>`；也可 `setup --install` 提前装 |
| FFmpeg | 拼图/帧检/导出/混音要用。`winget install --id Gyan.FFmpeg -e`，或 scoop/choco，或设 `WORKBUDDY_FFMPEG_PATH` |
| 浏览器 | 默认用本机 Chrome/Edge；没有就设 `WORKBUDDY_CHROME_PATH` |

设了 `WORKBUDDY_*` 的值会镜像成引擎认的 `DRAWAI_*`，两种名字都能用。

> 没网也能干：素材与运行时可以从另一台机器整个目录拷过来（`~/.dsh/drawai-assets`、`~/.dsh/drawai-video-runtime`），FFmpeg 用本地安装包。**引擎不会替你下载 FFmpeg**，缺了只会立刻报错并给安装命令。

---

## 1. 最短闭环

```bash
# 1) 建工程：给规格、分镜表（可先 scaffold 一份骨架）
node scripts/bin/wb.mjs create --dir ./my-film --spec 1920x1080@30 --duration 12 --prompt "一句话说清这条片子要什么"
node scripts/bin/wb.mjs spec scaffold --dir ./my-film        # 写出一张六列分镜表骨架
#    改 storyboard.md 后：
node scripts/bin/wb.mjs spec --dir ./my-film                  # 检查时间轴连贯

# 2) 写场景：改 scene-0.tsx …（见 §3）

# 3) 看定调帧（拼图，一眼看构图）
node scripts/bin/wb.mjs preview --dir ./my-film --at 1,3,6

# 4) 出样片（3 秒左右），看过再往下
node scripts/bin/wb.mjs render --dir ./my-film --range 0,90 --wait

# 5) 整片 + 质检 + 交付
node scripts/bin/wb.mjs render --dir ./my-film --wait
node scripts/bin/wb.mjs qa     --dir ./my-film
node scripts/bin/wb.mjs export --dir ./my-film               # 剪映素材包
```

`create` 会生成：`timeline.json`（时间轴）、`BRIEF.md`（施工说明）、`storyboard.md`、`STYLE.md`（用了整片风格时）、`theme.ts`、`scene-N.tsx`（骨架）、`scene-kit/`（公共原语）、`assets/`（内置素材 + 字体拷贝）。

**字体拷贝进每个工程约 42MB**，这是故意的：工程要能单独拷走。嫌占地方就删掉不用的字体文件（`index.jsx` 里会声明要加载哪些）。

---

## 2. 分镜表：一张表，不是一镜一个节点

`storyboard.md` 用六列表，每镜一行：

| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音 |
| --- | --- | --- | --- | --- | --- |
| shot-1 | 0–90f | — | 用一张档案卡说明"人生只有三万天" | 米色登记表、档号 0001、卷页 30,000 | 无 |
| shot-2 | 90–218f | — | 数字开始滚动，制造进度感 | 四位计数器从 0 跳到 30,000 | 纸响 |

要求：

- **帧区间写死**，和 `timeline.json` 完全一致；改时长两边一起改（`wb spec` 会报空隙/重叠）。
- "屏幕上出现什么"必须是**看得见的名词**，不能写"很有质感"。
- "文案/声音"在写代码前就填（哪怕只写"落锤"），做声音时只实现、不重设计。
- 镜号连号；每行时长的写法认 `90f`、`3s`、`0–90f`。

`create` 会按表里的帧数开段；不写表就按 `--duration` 均分成 `--segments` 段。

---

## 3. 写场景：一个文件一镜

```tsx
// scene-0.tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from 'remotion'
import { PAPER, INK, DUST, STAMP } from './theme'

const FONT = '"Noto Serif SC", serif'

export default function Scene() {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const grow = spring({ frame, fps, config: { damping: 18, mass: 0.6 } })

  return (
    <AbsoluteFill style={{ background: PAPER, color: INK, fontFamily: FONT }}>
      {/* 这里才是活 */}
    </AbsoluteFill>
  )
}
```

规则（前四条违反会返工）：

1. **时间轴单一真相**：只读 `useCurrentFrame()` / `useVideoConfig().durationInFrames`，不写死 `DUR`、不按绝对秒数硬编码。
2. **颜色与字体从 `theme.ts` 取**（`PAPER / INK / DUST / STAMP / SURFACE / FIELD / BORDER`、`SERIF / SANS / MONO`），不手写十六进制。换主题才一处生效。
3. **改共享组件要递增 rev**：改了 `components/**` 或 `scene-kit/**`，在用到它的 `scene-*.tsx` 顶部把 `// rev N` 加一。`bundle` 缓存只 hash 场景源码，不递增会读到旧产物（症状：改完输出字节完全一样）。
4. **单场景 ≤120 行**：公共原语抽到 `components/`。
5. 随机数用 `scene-kit/det.ts` 的确定性随机器，**禁止 `Math.random()`**（同一帧两次渲染必须一样）。
6. 动画优先用闭式解（弹簧、落体、缓动），不要靠逐帧累积状态。
7. three/WebGL 场景必须真用 `three` / `@remotion/three` / `webgl2` —— 渲染前会扫源码，重引擎缺失直接拒绝渲染。

`scene-kit/look.tsx` 提供 `<Look ssaa shadow exposure />`、`<Grain />`、`<Vignette />`；3D 片一定要挂 `<Look>`，否则锯齿和色带会很显眼。

细节见 [references/scene-contract.md](references/scene-contract.md)。

---

## 4. 看片：拼图看构图，单帧看画质

```bash
wb preview --dir D --at 1,3            # 秒 → 帧
wb preview --dir D --frames 0,60,120   # 直接给帧号
wb preview --dir D --at 3 --crop 600,300,400,300   # 1:1 局部，看锯齿/色带
```

- 拼图会被缩到 640 宽，**只能判断构图、字号、节奏**；判断细节、曝光、锯齿必须看单帧或 `--crop` 局部。
- 拿不准就把 `--json` 打开，返回帧文件路径，用 `read_image` 逐张看。

---

## 5. 渲片：样片先行，整片别急

```bash
wb render --dir D --range 0,90     # 样片 → .out/pilot.mp4（3 秒量级）
wb render --dir D --wait           # 整片 → .out/film.mp4
wb render --dir D --frames 120     # 静帧 → .out/still/frame-0120.png
wb status --dir D                  # 进度
wb render status --dir D           # 最近任务表
wb render apply --dir D            # 成片落到工程根目录 out-<kind>.mp4
```

- **默认后台跑**（`spawn` 出去，立即返回 job id）；需要同步等就 `--wait`。
- 646 帧 1080p 大约 5–6 分钟；**不要睡眠轮询**，先干别的，需要时 `wb status`。
- 样片与整片输出分开（`pilot.mp4` / `film.mp4`），别拿样片当交付。
- 整片且**有音轨**时才走 FFmpeg 做响度归一；没音轨完全不碰 FFmpeg。
- 用了整片风格（`--style`）时渲染前会查两道闸：引擎保真（three/webgl2 真用了吗）+ 画质证据（有没有按 STYLE.md 的配方做）。

---

## 6. 声音：先定要不要，再定放什么

```bash
wb voice list --dir D
wb voice say  --dir D            # 合成旁白 + 字幕 + 镜头跟着句子重排（读 voice.script.md）
wb sfx search "paper whoosh"     # 15 秒短词最灵
wb sfx get --dir D --id fs:12345
wb audio add --dir D --file assets/sfx/pop.mp3 --role sfx --at 2.4
wb audio analyze --dir D --file assets/bgm.mp3      # 量 BPM / 拍点
wb audio apply --dir D --beats                     # 把切点吸到拍子上
wb sync bind --dir D --music <cueId> --tolerance 2 # 切镜/动作/音效统一绑拍点
wb verify --dir D                                  # 成片音画对照验收
```

规范：

- **要不要声音在立项时定**，不是收尾时补。
- 超过 ~8 个音效就别一条条加，先离线混成一条 `assets/sfx/mix.wav` 再挂一条轨（48kHz、末尾留 0.6s 淡出、每条 cue 有 fade-in/out、峰值 ≤0.9）。
- 留一条约 −26dB 的底噪铺满全片——**无声的空档比有声的空档更露怯**。
- 交付响度 −16 LUFS / 真峰 −1.5 dBTP，`wb qa` 复核。

---

## 7. 素材、镜头卡、整片风格

```bash
wb assets list --dir D                    # 工程里已有的
wb assets library 纸张                     # 内置素材库（111 项：102 音效 + 9 纹理）
wb assets use --dir D --id paper-01       # 拷进工程 assets/
wb assets gather --dir D --url https://example.com   # 整站收 logo/配色/字体/截图
wb assets page   --dir D --url ...        # 单页 2 倍截图
wb assets capture --dir D --file ./ui.png # 本机图片进工程
wb card list / wb card search 纸张         # 124 张镜头卡
wb card show --card <卡名> --style <样式>   # 卡的正确用法 + demo 源码路径
wb style list                             # 14 种整片风格
wb style read --slug 09-bauhaus            # 色板/字体/节奏/引擎 + 施工说明
wb style frames --slug 09-bauhaus          # 从上游 demo 抽参考帧（要先有素材）
```

用卡与用风格的硬规定见 [references/cards-and-styles.md](references/cards-and-styles.md)。

---

## 8. 质检与交付

```bash
wb qa --dir D                  # 默认检 .out/film.mp4，可 --file 指定
wb qa --dir D --file .out/pilot.mp4
wb export --dir D --draft      # 剪映素材包（逐镜切好 + 音轨 + 字幕 + 草稿）
```

`qa` 必须满足：帧数与时间轴一致；无纯黑段、无单帧闪烁、无连续空白帧；静止段 <2.4s；四边安全区 warn 逐条看过；有声音时响度 pass。

> 检 **样片** 时"帧数与时间轴不一致"是必然的，只看画面那些项。

交付时给用户：**一段话说清这版改了什么** + 一张 6–9 帧拼图（或成片）+ 需要他决定的问题。不要只说"做好了"。

---

## 9. 硬规则（背下来）

1. 内容没定不写代码；分镜表没过不量产。
2. 先静帧、再 3 秒样片、再整片。样片被否，改这一镜；整片被否，改全部。
3. 一镜一文件，`scene-N.tsx` 与 `timeline.json` 的 `shots[N]` 一一对应。
4. 时间轴改动只改 `timeline.json` 的 `startFrame` / `durationFrames`，不要改场景里的绝对帧号。
5. 用镜头卡就读它的 demo 源码，移植不是重写；确实要偏离，写一行「偏离：X 改为 Y，因为 Z」。
6. 用了整片风格就真跑它的引擎，别用 CSS 3D / 静态图位移糊弄。
7. 所有产出在工程目录里（`.out/`），别把中间文件丢到别处。

---

## 10. 出问题

先 `wb doctor`，再看 [references/troubleshooting.md](references/troubleshooting.md)。最常见的四个：

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `bundling 10%` 停住不动 | Remotion 在下载 chrome-headless-shell（没网） | 设 `WORKBUDDY_CHROME_PATH` 指向本机 Chrome/Edge（技能已默认传 browserExecutable） |
| `需要 FFmpeg` / 拼图出不来 | 没装 FFmpeg | 装 FFmpeg 或设 `WORKBUDDY_FFMPEG_PATH`；引擎不会自动下载 |
| 改完代码输出没变 | `bundle` 缓存命中 | 递增场景顶部 `// rev N` |
| 渲染被拒：引擎保真 | 声明的风格要 three/webgl2，源码里没有 | 真用该引擎；或按提示在 `STYLE.md` 写「偏离：…」 |

---

## 参考

- `@references/commands.md` — 全部子命令、参数、JSON 输出
- `@references/scene-contract.md` — 场景 API、`timeline.json`、`theme.ts`、`index.jsx`、`scene-kit`
- `@references/workflow.md` — 七道闸门、立项 7 问、打样标准、声音与质检清单、返工原因
- `@references/cards-and-styles.md` — 镜头卡与整片风格的用法与硬规定
- `@references/troubleshooting.md` — 环境、运行时、FFmpeg、浏览器、离线、常见报错

引擎是 DrawAI 插件视频引擎的 vendor 副本（`scripts/engine/VENDOR.json` 记录来源 commit），CLI 是插件 16 个 motion 工具的命令行版。
