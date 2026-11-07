# 12-aurora-glass · 弥散渐变 / 玻璃拟态

上游：`demos/12-aurora-glass/main.js`（64.7KB：7 个漂移色斑 + 3 张透视玻璃卡 + 3D 相机）
+ `shaders.js`（27.4KB：`FS_AURORA`/`FS_CARD`/`FS_LENS`/`FS_FINAL` 共 9 个全屏 pass）
+ `cues.json`（881B，80BPM，`drop:6.0`）。1920×1080 / 30fps / 10.000s。
提示词原文用 `mg_style {action:"read",slug:"12-aurora-glass"}` 取。

## 1. 一眼认出

- **底是近黑深紫**：`PAL.base='#040312'`（`main.js:117-119`），body 是 `#05041a`。亮部全靠色斑加色叠，没有提亮的灰。
- **7 块无边界的斑**：`BLOBS`（`main.js:136`）每块 `rx 240–560 / ry 170–380 / 强度 0.32–1.15`，沿 `loopBezier` 四锚点闭环走 24–40s。唯一的硬边是玻璃卡轮廓。
- **玻璃 = 五层叠加**：模糊 30px（`TAPS_FROST = gaussTaps(30*DPR/4)`）、`saturate(170%)`（`shaders.js:179`）、+7% 白、近边 13px 内折射偏移 24px（`rim = 1-smoothstep(0,13,inside)`）、1px 白描边（alpha 0.14→0.7 随朝向）。缺一层就成了贴纸。
- **节奏 0.75s 一格**：`bpm:80`，最短错峰 `word_letters:0.075`（2–3 帧）。
- **文字只做 opacity + 8px 上浮**：`riseA(t,t0,dur=0.75)` → `{a:eSine(k), dy:8*(1-eOutCubic(k))}`，无缩放无旋转。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| page | `#040312` | 全片底，占 70% 面积 |
| accent | `#7050FF` | `PAL.violet`，主色斑、字标高光 |
| accent2 | `#2F46F2` | `PAL.blue`，第二块斑、卡片投影色偏 |
| accent3 | `#34CFF0` | `PAL.cyan`，冷侧斑、镜头边缘 |
| accent4 | `#B653F0` | `PAL.magenta`，与 violet 混出洋红带 |
| deep | `#3320A8` | `PAL.indigo`，玻璃卡内部折射 |
| muted | `#8C8CFF` | `PAL.periwinkle`，副标、tagline |
| text | `#FFFFFF` | 只做 1px 描边与 5–10% 白填充 |

`theme.ts`：`page`→PAGE，`text`→INK，`accent`→ACCENT。`surface #171043` / `field #0B0726` 是 base
提亮 4%/2% 的**推导值**（源码无此 hex），只用于不透明卡面兜底。

**禁止色**：纯灰（光会变雾霾）、硬边渐变、拉满饱和度的大色块、纯白填充。

## 3. 字体与字排

**当前优先使用插件内置字体：** 中文标题优先 HarmonyOS Sans SC，英文标题用 Sora，界面标签和正文用 Inter。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片（`main.js:205`）：`FONT_CN="'HarmonyOS Sans SC'"`（标题 900 / 216px / `track:10`）、
`FONT_WORD="'Sora'"`（`Aurora` 178px）、`FONT_UI="'Inter', 'HarmonyOS Sans SC'"`。字体由
`/assets/fonts/fonts.css` 指向；DrawAI 已内置这三族字体。

- 中文标题 `'"Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",sans-serif'`，`900`，`letterSpacing:'0.046em'`（=216px 下的 10px）。
- 拉丁字标 `'"Segoe UI Variable Display","Segoe UI",sans-serif'`，`200`，`letterSpacing:'0.32em'`。
- 小标签 `'"Consolas","JetBrains Mono",monospace'`。

**损失**：① YaHei 只有 400/700，900 会合成或回退成 Bold，216px 的「玻璃拟态」薄一档；用
`-webkit-text-stroke:0.5px currentColor` 补（≤32px 禁用，会糊）。② Sora 是宽字面几何体，Segoe 更窄，
`Aurora` 全小写宽字距会失衡，靠 0.32em 补。③ 圆润中宫没了 —— 一句只写 4–6 字。

字排：标题锁 `base:580`、`w:900`、216px 单行；副标 54px `track:6`；英文标 32px 大写 `0.28em`。

## 4. 动效语法

- 节拍：80BPM = 0.75s = **22.5 帧/拍**，1 小节 90 帧。`cues.json` 注明 bar 0 从 `drop`（6.0s）
  起算，前 6 秒是钩子段，不按小节走。
- 缓动：`eSine(t)=-(cos(πt)-1)/2`（主）、`eOutQuint`（卡入场）、`eOutCubic`（8px 位移）、
  `seg`/`hermite`（相机）。**禁用** `spring`/`elastic`/`back` —— 过冲会变成弹跳 UI。
- 签名动作：
  1. **卡片入场**（`cardA_in:-0.8`→1.1s）：1.9s `eOutQuint`，`y` 抬 70px、`z` 抬 560（等价
     scale 0.86→1）；同时 `tilt = 20*Math.exp(-3.2*tau)*Math.cos(3.6*tau)`（`cardState`，
     `main.js:464`）—— 全片唯一过冲，只作用在角度上。
  2. **色斑漂移**：每块走自己的闭环，10 秒只走完 1/3，没有"进入/离开"这一帧。
  3. **drop 6.0**：`uGain` 抬亮 + `uRipple` 径向光 + 三卡沿 `drift` 炸散（A 是 `[920,-30,-560]`）。
  4. **字标逐字**（`word:6.9`）：2.25 帧错峰，只做 opacity+8px；`wordScale=1+0.022*eSine` 是唯一缩放。
  5. **wave 9.0**：`FS_LENS` 的折射环把穿过的地面弯 ~2.5px，不是发光圆。
- 组成：卡 A 660×470 r42、B 400×200 r38、C 440×250 r40；边距 ≥120px；图层自下而上 = 色斑 →
  卡片（投影 `uSH`）→ 卡内容 → 镜头 → bloom → grain → vignette。

## 5. Remotion 落地配方

1. **9 个 pass 的 GLSL 不照抄**。每帧 8 次 render-target 切换（`FS_AURORA`→`FS_DOWN`→`FS_BLUR`×2
   →`FS_CARD`→`FS_LENS`→`FS_FINAL`）。`@remotion/three` 理论上可 1:1，但 300 帧 GPU 渲染不可控 ——
   走 DOM/CSS。
2. `requestAnimationFrame` + 累积 `t` → `useCurrentFrame()`；`uFrame` 的 grain 种子 →
   `random('grain-'+frame)`。
3. `document.fonts.load` 预热（`main.js:217-226`）→ 系统栈免预热。

近似与损失：
- **色斑**：7 个 `div` + `blur(120px)` + `mixBlendMode:'screen'`。上游是解析高斯 + `uWarp` 噪声扭曲；
  CSS 版斑重叠处会发灰，`opacity .45–.6` 压。
- **玻璃卡**：`backdropFilter:'blur(30px) saturate(170%)'` + `rgba(255,255,255,.07)` +
  `inset 0 0 0 1.2px rgba(255,255,255,.30)`。损失：① 没有近边折射（那层变形才是"厚度"）；
  ② 不随 `tilt` 变；③ 嵌套 `backdrop-filter` 只取最近一层。
- **调色**：bloom .22 用 `screen` 径向渐变；vignette .18 用
  `radial-gradient(ellipse at 50% 52%, transparent 58%, rgba(4,3,18,.6))`；grain .14 用内联
  `feTurbulence` + `opacity .06`，**每帧换 seed**。dither 做不了，8bit 下大 blur 必现 banding。
- **运动模糊**：只有 `glide`（5.95–6.9）要，用 `CameraMotionBlur` 包那段；其余 <2px/帧。

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'
const BLOBS = [
  { c: '#7050FF', x: 0.42, y: 0.55, r: 520, ax: 120, ay: 60, p: 0.0 },
  { c: '#2F46F2', x: 0.66, y: 0.40, r: 420, ax: 90, ay: 80, p: 1.7 },
  { c: '#B653F0', x: 0.30, y: 0.36, r: 300, ax: 70, ay: 50, p: 3.1 },
]  // 上游是 7 块 + loopBezier 24–40s 闭环，这里用两个频率的 sin 近似同一条路径
const eOutQuint = Easing.out(Easing.poly(5))
export default function AuroraGlass() {
  const f = useCurrentFrame(), { fps } = useVideoConfig(), t = f / fps
  // cardA_in=-0.8，1.9s 到位；y 抬 70px、z 抬 560 在屏幕空间等价于 scale 0.86→1
  const e = interpolate(t, [-0.8, 1.1], [0, 1], { easing: eOutQuint, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ background: '#040312', overflow: 'hidden' }}>
      {BLOBS.map((b, i) => {
        const cx = (b.x + (b.ax / 1920) * Math.sin(t * 0.42 + b.p)) * 1920
        const cy = (b.y + (b.ay / 1080) * Math.cos(t * 0.31 + b.p)) * 1080
        return <div key={i} style={{ position: 'absolute', left: cx - b.r, top: cy - b.r,
          width: b.r * 2, height: b.r * 2, borderRadius: '50%', background: b.c,
          filter: 'blur(120px)', opacity: 0.55, mixBlendMode: 'screen' }} />
      })}
      <div style={{ position: 'absolute', left: 760, top: 280 + 70 * (1 - e), width: 660, height: 470,
        borderRadius: 42, transform: `scale(${0.86 + 0.14 * e})`, background: 'rgba(255,255,255,0.07)',
        backdropFilter: 'blur(30px) saturate(170%)',
        boxShadow: 'inset 0 0 0 1.2px rgba(255,255,255,0.30), 0 60px 120px rgba(4,3,18,0.55)' }} />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 52%, transparent 58%, rgba(4,3,18,0.6) 100%)' }} />
    </AbsoluteFill>
  )
}
```

## 6. 镜头结构模板

| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0–0.75 | 0–23 | 暗场起：只亮 2 块斑，卡 A 已在浮入路上 |
| 0.75–3.0 | 23–90 | 三卡到齐（`cardB_in:-0.3`、`cardC_in:0.05`），建立"玻璃悬在光里" |
| 3.0–6.0 | 90–180 | UI 演示：chips 3.0、toggle 3.75、slider 3.95/4.85、镜头进画 5.95 |
| 6.0–7.5 | 180–225 | drop：光爆 + 卡片炸散（`part 6.72/6.95`），亮度峰值 |
| 7.5–10.0 | 225–300 | 字标逐字 → tagline 8.5 → 定格，只留色斑在动 |

保留五段的**功能**（建光场 → 元件入场 → 交互演示 → 光爆 → 字标收尾），换掉内容。

## 7. 坑

- `backdrop-filter` 对 `blur(>40px)` 在 headless Chromium 会降采样成块状，30px 是安全上沿。
- 7 层 4000px 宽的 `blur(120px)` 每帧重新栅格化，慢 3–5× 且吃 GPU 内存。
- `mixBlendMode:'screen'` 需要实底，`AbsoluteFill` 透明会和视频背景混出白边。
- 1px `inset` 描边在非整数 DPR 下会消失或变 2px，写 `1.2px`。
- 逐字错峰用浮点秒（`0.075`）算，取整成 2 帧会让最后一个字母晚 1 帧。

## 8. 版权与素材

上游 MIT（`upstream/LICENSE`）。弥散色斑、玻璃卡、大圆角属通用视觉语言。`HarmonyOS Sans SC` /
`Sora` / `Inter` 是厂商字体，**不能随片分发**。「Aurora / 极光」是虚构产品名，客户品牌必须替换；
`UI.reply` 的四句日程文案原创可用。音乐用 `motion_audio` + `motion_sfx` 另配（80BPM，
ambient pad + 玻璃轻击）。
