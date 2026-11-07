# 09-bauhaus · 几何构成 / 包豪斯

上游：`demos/09-bauhaus/film.js`（44.8KB，Canvas2D 四块印版 + 一遍 WebGL2 套印合成）+
`demos/09-bauhaus/cues.json`（120BPM，`drop:6.0`，`freeze:8.0`）。1920×1080 / 30fps / 10.000s。
提示词原文用 `mg_style {action:"read",slug:"09-bauhaus"}` 取。

## 1. 一眼认出

- **落点都在网格上**：`M = 120` 是唯一模数，中央八格 = 960×960，从 `x=480,y=60` 开始铺满 1020px 高。
- **只有三原色 + 纸 + 墨**：画面里出现第四种彩色，风格立刻不成立。
- **几何体只有直角**：正方形、四分之一圆、半圆、等边三角；没有圆角矩形、没有渐变填充。
- **节拍可见**：每 15 帧（120BPM 一拍）发生一次「状态切换」，两次切换之间画面**完全静止**，不是持续缓动。
- **印刷感**：套印偏移（misregistration）2–4px、纸纹、边缘有墨的厚度；不是干净的矢量渲染。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 纸（page） | `#F1E9DA` | 全片底，占 60% 以上面积 |
| 红（accent） | `#E03C31` | 圆、强调块、套印最抢的一色 |
| 黄（accent2） | `#F2B705` | 次级形、级的底色 |
| 蓝（accent3） | `#1E4FA3` | 深色形、与红对位 |
| 墨（text） | `#111111` | 字、细刻线、套准十字 |

`theme.ts` 映射：`page`→PAPER，`text`→INK，`accent`→STAMP。黄与蓝不走 theme，在场景里
直接写常量（`const Y='#F2B705', B='#1E4FA3'`）—— 它们不是"主题色"，是这个风格的固定颜料。

**禁止色**：任何低饱和中间色（灰蓝、米灰之外的暖褐）、任何渐变、任何透明度低于 0.85 的色块。

## 3. 字体与字排

**当前优先使用插件内置字体：** 中文标题优先 HarmonyOS Sans SC 或 Noto Sans SC，拉丁大字用 Anton，副标可用 Inter。Alimama ShuHeiTi 与 Alibaba PuHuiTi 尚未内置。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片：`'700 180px "Alimama ShuHeiTi"'`（阿里妈妈数黑体，仓库里没有这个字体）。上游另有
`/assets/fonts/fonts.css` 里的 Archivo / Inter 用于拉丁副标。

DrawAI 替代：
- 中文标题：`fontFamily: '"Alibaba PuHuiTi","HarmonyOS Sans SC","Noto Sans SC",sans-serif'` +
  `fontWeight: 700` + `letterSpacing: '-0.02em'`。
- 拉丁大写：`'"Archivo Black","Anton","Arial Black",sans-serif'`，`letterSpacing: '0.14em'`，
  字号 = 网格的 1/2（60px）或整格（120px）取整。
- **竖排标题**（`BAUHAUS` 九字母）：每字单独一个 `<div>`，`writingMode` 不用，直接纵向堆叠，
  行高 = 字号的 0.86，末字与首字各让出半格。
- 损失：数黑体的"圆头方身"没有了，替代字体更方，字面更宽 —— 竖排要在**次字母间距**上补回来
  （`letterSpacing: '-0.06em'`）。

## 4. 动效语法

- 节拍：120BPM = 0.5s = **15 帧/拍**，1 小节 60 帧。所有切换落在 `frame % 15 === 0`。
- 缓动：`io2`（power2.inOut）= `Easing.bezier(0.455,0.03,0.515,0.955)`；
  `in2`（power2.in）= `Easing.in(Easing.poly(2))`，用于"砸下来"的落点。
  **禁用**：`Easing.elastic`、`spring` 的一切过冲 —— 包豪斯的形不弹。
- 时长：入场 9–12 帧（0.3–0.4 拍），切换级联 2 帧错峰。
- 签名动作：
  1. **红圆落地**（0.5s 起，每拍一个）：从 `scale 0` → `1`，`in2`，11 帧，落点永远在网格交点。
  2. **印版转位**（2–6s）：整组绕 `(960,540)` 以 90° 为步长的 `groupAngle(t)` 离散转动，
     每拍 +22.5°，用 `io2` 在 8 帧内完成，其余时间静止 → 看起来是"印刷滚筒咔哒一声"。
  3. **海报拼合**（2–6s）：八个色块按对角顺序 `(i+j)` 从中心向外插入，每个错峰 3 帧。
  4. **下落级联**（6–8s）：8×8 方格按到中心的曼哈顿距离做符号距离场翻转，每格 2 帧错峰、
     翻 180° 绕自身底边，`in2`。
  5. **定格**（8–10s，`freeze`）：60 帧内**零运动**，只有纸纹在极缓地"呼吸"（噪点种子每 3 帧换一次，
     opacity 0.04→0.06），最后 12 帧竖排标题从下往上压印出现（`clipPath` 从 100% 收到 0）。
- 组成规则：所有元素对齐 `x ∈ {480, 600, ..., 1440}`、`y ∈ {60, 180, ..., 1020}`；安全边距 = 1 格。

## 5. Remotion 落地配方

上游的三处写法**必须**换掉：

1. `renderAt(t)` + `requestAnimationFrame` → 每帧都是 `useCurrentFrame()` 的函数，禁止任何
   时间累积状态（`let x = 0; x += ...` 这种在 Remotion 里等于无状态丢失）。
2. `Math.random()` 的纸纹/抖动 → `random('grain-' + Math.floor(frame / 3))`（`remotion` 的种子随机），
   保证同一帧多次渲染结果一致。
3. 四块印版 + WebGL press pass → **不照抄**。用 DOM 分层做近似：
   ```tsx
   // 套印：同一形状画两遍，一色偏移 3px，用 multiply 叠回去
   <div style={{ position:'absolute', inset:0, mixBlendMode:'multiply' }}>
     <Plate color="#E03C31" dx={0} />
     <Plate color="#1E4FA3" dx={3} dy={-2} />
   </div>
   ```
   纸纹用一层 SVG `feTurbulence`（`baseFrequency 0.8`，`numOctaves 4`）铺满，
   `opacity: 0.05`，`mixBlendMode: 'multiply'`；再加一层 `radial-gradient` 暗角。
   **近似损失**：没有真正的"墨在纸上洇开"的柔边和高光偏移；靠 `filter: contrast(1.02)` 找补。
4. 运动模糊：上游用 8 采样。这里在 `renderMedia` 开 `motionBlur` 只在**转位与级联**两镜有意义；
   定格镜必须关掉（否则纸纹会被糊成一片）。也可用 `@remotion/motion-blur` 的 `CameraMotionBlur`
   包住单个 `<Sequence>`。

骨架（真实可跑，一镜的核心结构）：

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from 'remotion'
const M = 120, X0 = 480, Y0 = 60
const io2 = Easing.bezier(0.455, 0.03, 0.515, 0.955)
const in2 = Easing.in(Easing.poly(2))
const beat = 15
export default function Scene() {
  const f = useCurrentFrame()
  const p = (t0: number, t1: number) => interpolate(f, [t0, t1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: io2 })
  const dots = [[0, 0], [3, 0], [0, 3], [3, 3], [1, 1], [2, 2]]   // 网格坐标
  return (
    <AbsoluteFill style={{ background: '#F1E9DA' }}>
      {dots.map(([cx, cy], i) => {
        const start = 15 + i * beat                       // 每拍一个
        const s = interpolate(f, [start, start + 11], [0, 1], { extrapolateRight: 'clamp', easing: in2 })
        return <div key={i} style={{
          position: 'absolute', width: M * 2, height: M * 2, borderRadius: '50%',
          left: X0 + cx * M - M, top: Y0 + cy * M - M,
          background: '#E03C31', transform: `scale(${s})`,
        }} />
      })}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.05, mixBlendMode: 'multiply',
        backgroundImage: 'url(/noise.svg)', backgroundSize: '512px 512px' }} />
    </AbsoluteFill>
  )
}
```

（`p(t0,t1)` 是这一镜唯一的进度函数；上游 `prog`/`lerp` 的语义完全对应。）

## 6. 镜头结构模板

| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0–0.5 | 0–15 | 空网格闪一下，先建立"规则"，让观众看见栅格 |
| 0.5–2.0 | 15–60 | 三原色形依次落位，每拍一个，落在交点上 |
| 2.0–6.0 | 60–180 | 转位：整组离散旋转 + 色块拼合，节奏最密 |
| 6.0–8.0 | 180–240 | 级联翻牌，动作量最大，`in2` 落点砸实 |
| 8.0–10.0 | 240–300 | 定格 + 竖排标题压印，留白收尾 |

替换内容时保留这五段的**功能**（建立规则 → 元件入场 → 结构变换 → 高潮 → 定格），
换掉具体的形与字。

## 7. 坑

- 细刻线（1–2px）在 1080p 下会 shimmer：线宽给 `1.5` 且**不要**给它做位移动画。
- `mixBlendMode: 'multiply'` 在深色底上会把颜色压死 —— 底必须是纸色，不能是透明。
- 纸纹 SVG 用 `background-image: url(/noise.svg)` 需要文件进 `publicDir`；否则用内联
  `data:image/svg+xml;utf8,...`（Remotion 的 CSP 允许 `data:`）。
- 分层多的镜（级联 64 格）会拖慢渲染：格子用纯 `div`，别每格一个 SVG。
- `Easing.elastic` 一旦混进来，风格立刻变成"弹跳卡通"，不接受"稍微弹一点点"。
- 竖排标题的 `letterSpacing` 是负值时，最后一个字母的下沿会溢出安全区，容器要留 20px 余量。

## 8. 版权与素材

上游 MIT（`upstream/LICENSE`），可商用可改。三原色、正方形、四分之一圆属通用几何，自由使用。
**品牌名必须虚构**：不要写"Bauhaus""包豪斯"作为客户品牌，也不要复刻真实厂牌标志；
标题用虚构词（如 `KONSTRUKTION`、`FORM & MASS`）。上游 `cues.json` 里的音乐是程序合成的，
DrawAI 侧用 `motion_audio` + `motion_sfx` 另配。
