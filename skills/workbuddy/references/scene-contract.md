# 工程契约（scene / timeline / theme）

`wb create` 建出来的目录，每一层都有约定。**时间轴的单一真相是 `timeline.json`**，场景文件只负责画面。

```
<工程>/
  timeline.json        规格 + 镜头排期 + 音轨 + 字幕（唯一真相）
  storyboard.md        六列分镜表（人手写 / wb spec scaffold 生成）
  BRIEF.md             这条片的制作说明（给下一个 Agent 看）
  STYLE.md             整片风格：判据、引擎契约、画质配方、色板、字体、节奏
  theme.ts             颜色与字体常量（有主题/风格时才生成）
  index.jsx            把 scene-N.tsx 注册进 Remotion 的入口（wb 会自动重写绝对路径）
  scene-0.tsx …        每段一个场景组件
  scene-kit/           det.ts / grow.ts / look.tsx（确定性随机、缓动、AA 与颗粒）
  assets/
    manifest.json      素材清单
    builtin/           内置纸纹、网格、颗粒、两个音效
    fonts/             Inter + Noto Sans/Serif SC（约 42MB，每个工程一份）
  tools/polish.mjs     工程自带的收尾脚本（可选）
  .out/                渲染产物、任务记录、质检报告
```

---

## timeline.json

```json
{
  "version": 1,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "durationInFrames": 450,
  "shots": [
    { "id": "shot-1", "file": "scene-0.tsx", "startFrame": 0, "durationFrames": 110, "card": "纸张展开", "style": "paper-unfold" }
  ],
  "audio": { "version": 1, "cues": [], "notes": [] },
  "subtitles": [{ "startFrame": 16, "endFrame": 103, "text": "一句话" }],
  "sync": { "version": 1, "musicCueId": "cue-1", "anchors": [], "toleranceFrames": 2 },
  "style": { "slug": "09-bauhaus", "name": "几何构成·包豪斯", "palette": {}, "fonts": {}, "rhythm": {} }
}
```

| 字段 | 说明 |
| --- | --- |
| `width/height/fps/durationInFrames` | 规格；帧率 12–30，时长 2–60s |
| `shots[]` | 顺序即播放顺序；`startFrame` 必须首尾相接（`wb spec validate` 会查） |
| `shots[].file` | 场景文件名，**不要改**（`index.jsx` 与渲染都按它找） |
| `shots[].card` / `.style` | 用的镜头卡与样式 key，只作记录，不影响渲染 |
| `audio.cues[]` | `{id,file,role,from,durationInFrames,gainDb,fadeIn,fadeOut,trimStart,loop,duck}`；`role` 是 `bgm/sfx/voice`；`file` 相对 `assets/` |
| `subtitles[]` | `{startFrame,endFrame,text}`；`wb voice say` 自己写，`wb export` 出 SRT |
| `sync` | 拍点绑定；存在时 `wb audio apply` 会拒绝（用 `wb sync bind` 更新） |

**改时长只改 `startFrame` / `durationFrames`**，不要动场景里的常量——场景用 `useVideoConfig().durationInFrames`，镜头一变它自己跟着变。

---

## 场景文件

```tsx
import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'
import { INK, PAPER, STAMP } from './theme'        // 只有 theme.ts 存在时才有

export default function Scene({ anchors = {} }) {
  const frame = useCurrentFrame()                   // 本镜内从 0 开始
  const { durationInFrames, fps } = useVideoConfig()
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' })
  return <AbsoluteFill style={{ background: PAPER, opacity }}>…</AbsoluteFill>
}
```

组件签名（引擎按这个顺序传参）：

| prop | 内容 |
| --- | --- |
| `shot` | 本镜的时间轴条目：`{id,startFrame,durationFrames,card,style,anchors,referenceIds,recipeId}` |
| `anchors` | 拍点绑定后的**本镜局部帧**，形如 `{impact: 18, title: 42}`，用来给动效定关键帧 |
| `assets` | 允许本镜引用的素材，按 `referenceIds` 过滤后的 `{id: [entry…]}` |
| `render` | 渲染规格 `{samples, shutter, scale}`；累积采样数、快门时长从这儿读，不要自己写死 |

`shot.recipeId` 必须是 `'scene'`（`wb create` 生成的就是），否则引擎直接报「场景组件缺失」。

### 能 import 什么

- `react`、`remotion`（`AbsoluteFill` / `Sequence` / `staticFile` / `useCurrentFrame` / `useVideoConfig` / `interpolate` / `Easing` / `random` / `delayRender`）
- `three`、`@react-three/fiber`、`@remotion/three`、`@remotion/motion-blur`（走隔离运行时，不要自己 `npm install`）
- `./theme`、`./scene-kit/*`
- 素材一律 `staticFile('builtin/paper.svg')`、`staticFile('fonts/NotoSansSC-VF.ttf')` —— **`staticFile` 的根是工程的 `assets/`**

不要 import 工程外的相对路径（那会让工程不可搬迁）。

### theme.ts

```ts
export const PAPER, SURFACE, FIELD, INK, DUST, STAMP, BORDER   // 颜色
export const SERIF, SANS, MONO                                // 字体栈
export const TOKENS, THEME_NAME
```

`PAPER` 底、`INK` 正文、`DUST` 次级文字、`STAMP` 唯一强调色。有 `STYLE.md` 时色板来自风格；`wb theme --name …` 可随时换。

### scene-kit

| 文件 | 导出 | 用途 |
| --- | --- | --- |
| `det.ts` | `hash32(seed)`、`det(frame,salt,index)`、`detBetween(frame,salt,index,min,max)`、`halton(index,base)`、`jitter(sample,index)` | 确定性随机。**禁 `Math.random()`**：并行渲染时同一帧会给两种画面 |
| `grow.ts` | `clamp01`、`easeOutCubic`、`easeInOutCubic`、`easeOutBack`、`spring(t,duration=0.6,zeta=0.61)`、`drop(t,duration=0.3)→{y,sy,landed}`、`wallScale`、`roofAt`、`stagger(index,0.04)`、`pulseRadius` | 闭式解缓动：没有状态、不依赖帧序 |
| `look.tsx` | `<Look ssaa shadow exposure toneMapping />`、`<Grain opacity seed />`、`<Vignette strength />` | three 的抗锯齿/软阴影/ACES、防色带颗粒、暗角 |

### 场景写多少行

单文件 **≤ 120 行**。超了就把部件拆成同目录的 `shot-3-parts.tsx`，别在一个文件里堆五层三元。

---

## 声音

音轨不写在场景里，全部走 `timeline.audio.cues`（`wb audio add` / `wb voice say` / `wb sfx get`）。`entry.jsx` 负责：

- 按 `from` + `durationInFrames` 摆 `<Audio>`，`trimStart` 秒换成帧偏移；
- 增益 = `gainDb` → 线性，再叠 `fadeIn`/`fadeOut`；
- `role: "voice"` 的区间会自动给其他轨**压 −12dB**（两端各 6 帧斜坡），这就是 `duck`；
- `loop` 的 cue 在区间内循环。

所以 BGM 不需要手写淡入淡出，`--fade-in 1` 就够；旁白避让也不用自己算。

---

## 字体

`assets/fonts/` 有 Inter（正体/斜体）与 Noto Sans SC / Noto Serif SC 可变字体，`plan.bundledFonts` 时引擎会用 `delayRender` 等它们加载完再出帧。**用别的字体族名会被门禁拦下**（浏览器会静默退回系统字体，字宽全变）：要么把字体文件放进 `assets/` 并 `loadFont()`，要么只用 `theme.ts` 里已注册的族，要么在 `STYLE.md` 写一行「偏离：字体 …，因为 …」。

---

## index.jsx

```jsx
import { registerMotionRoot } from "<技能目录>/engine/motion/entry.jsx";
import Scene0 from './scene-0.tsx';
registerMotionRoot({ "shot-1": Scene0 });
```

`wb preview` / `wb render` 每次都会按当前位置重写这个文件（`registerProject`），所以技能目录搬家、工程拷到别的机器都不用管。
