# 10-synthwave · 复古系（80s Synthwave / VHS / Y2K）

> 移植说明书。上游：`demos/10-synthwave/index.html`（82KB，单文件，three.js 全 3D 场景 + 后处理链）、
> `demos/10-synthwave/cues.json`（100BPM，drop 4.2s）、`prompts/10-synthwave.md`。
> 上游渲染契约是 `window.renderAt(t)` 画 t 秒那一帧；这里是 Remotion 版：`useCurrentFrame()` 就是 t×fps。

## 1. 一眼认出

- **一张透视网格贯穿全片**：地平线固定，网格线从地平线往镜头冲，滚动靠 `z 偏移取模`，不是整体平移。`floorMat` 里
  网格线宽 1.5px、远处自动收敛成一条亮带。
- **日落是分层剪纸**：太阳不是渐变球，是同一个圆按 5–7 条横带切开，切口随高度变宽（`sunMat` 的 `vP.y` 阶梯），
  色从洋红 `#FF2FB8` 经橙 `#EF933D` 到黄 `#E6C465`。
- **双辉光**：紧的 4px 高亮 + 宽的 30px 低透明，霓虹字与网格共用同一套（`bloom` pass + `neonLevel`）。
- **VHS 是整条链**：RGB split（红蓝各偏 1–2px）→ 2px 扫描线（10% 黑）→ 随机 glitch 抽帧（`glitches: [0.37,0.63,1.53,2.47,
  3.23,6.07,7.77,9.37]`）→ 4:3 圆角遮罩 + 桶形畸变 → 结尾 CRT 关机（`crt_off: [9.833,9.967]`）。
- **镀铬字带星芒**：多段金属渐变（`#F4F4FF` 高光 → 深紫 → 反光条），bevel 高光 + 4 角星芒 `star4` 扫过（`glint: [4.95,5.55]`）。
- **节拍就是分镜**：100BPM（0.6s 一拍）。0–1s VHS 雪花 + `PLAY ▶` OSD 落定；1–4.2s 镜头压低贴着网格飞、太阳升起、
  棕榈一根根掠过；4.2s slam（镀铬标题砸进来 + 车冲出 + 音乐 gap 0.18s）；5.8–6.6s 霓虹手写体点亮并闪烁
  （`neon_strike` 8 段明暗）；7.2–8.1s 副标浮现；9.667s 定格，9.833s CRT 收成一条线。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 夜空（page） | `#120A2A` | 天顶到地平线的深紫，占 55% 以上 |
| 天幕过渡（surface） | `#2A1055` | 地平线上方 300px 的紫红过渡带 |
| 雾（field） | `#3A1A4E` | 山脚与网格交界处的 `HAZE`，压住接缝 |
| 高光白（text） | `#F4F4FF` | 镀铬字高光段、OSD 白字、扫描环 |
| 洋红（accent） | `#FF2FB8` | 网格、太阳上半、霓虹手写体 |
| 青（accent2） | `#8FF9FF` | 太阳下沿的补色反光、玻璃小字、信号点 |
| 太阳橙/黄 | `#EF933D` / `#E6C465` | 日落的中间带与最亮带 |

`theme.ts`：`page`→`#120A2A`，`text`→`#F4F4FF`，`accent`→`#FF2FB8`，`field`→`#3A1A4E`；青与橙只进 `material.color`。

**禁止色**：绿色（任何色相 90–160 都破坏这套配色）、纯黑 `#000`（最暗是 `#120A2A`）、纯白 `#FFF`（最亮 `#F4F4FF`）；
不要用蓝紫以外的冷色做大面积背景，会变成科幻而不是 synthwave。

## 3. 字体与字排

**当前优先使用插件内置字体：** 英文标签用 Michroma，霓虹手写用 Mr Dafoe，中文可用 Douyin Sans；Alimama ShuHeiTi 尚未内置。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片三族：`Michroma`（OSD `PLAY ▶`、tagline，字距拉满）、`Mr Dafoe`（霓虹手写 "Midnight"，用 SVG 轮廓描管）、
`Archivo italic 900 / font-stretch 125%`（V5 中文版的标题字）。中文变体 `V5` 用 `Alimama ShuHeiTi` + `Douyin Sans`。

DrawAI 替代（Windows 自带优先）：
- 拉丁窄体标签 → `'"Bahnschrift SemiCondensed","Arial Narrow",sans-serif'`，大写，`letterSpacing:'0.22em'`。
- 镀铬标题 → `'"Arial Black","Impact",sans-serif'`，`letterSpacing:'-0.01em'`；镀铬质感靠渐变填充，不靠字体。
- 霓虹手写 → `'"Segoe Script","Brush Script MT",cursive'`，`fontStyle:'italic'`；或直接走第 5 节的轮廓描线。
- 中文 → `'"Microsoft YaHei","PingFang SC",sans-serif'` 700。
- 损失：Michroma 的方正宽字面与 Bahnschrift 差 8–10%，`0.22em` 的字距会让 1700px 的行宽撑破，改 `0.18em`；
  Segoe Script 没有 Mr Dafoe 的单线管径，做霓虹管要靠 `-webkit-text-stroke:2px` + 两层 `text-shadow` 补。

## 4. 动效语法

| 动作 | 时间 | 参数 |
| --- | --- | --- |
| OSD 落定 | 0.1s | `PLAY ▶` 从雪花里浮出，透明度 0→1 用 6 帧，`y` 从 -14 落到 0（`eOutCubic`） |
| 太阳升起 | 1.1–3.9s | `sunPx` 从地平线 -60 线性升到 360；同时 `skyMat` 的 `uSun` 跟着亮，**不是单独动太阳** |
| 镜头压低下潜 | 1.0–2.6s | `camY` 3.2→1.1，`tilt` 4°→-9°，`fov` 42→52（广角让网格更快） |
| 网格冲刺 | 全片 | `zOff = (t * 0.9) % 1`，每帧 ≥0 且 &lt;1，网格线 z 取 `i - zOff` |
| 加速段 | 2.6–3.85s | `speed` 0.9→2.6（`eInQuad`），叠 5 个脉冲 `build_pulses`，每个让 `bloom` 抬 0.35–0.55 |
| 磁带倒带 | 3.867–3.933s | 2 帧：画面纵向撕开 18px + 色偏翻倍 + 亮度压到 0.8，然后 `tape_hold` 静 0.27s |
| slam | 4.2s | 镀铬标题从 1.9 倍缩到 1.0（`eOutExpo` 7 帧），落地一帧白闪（`#F4F4FF`，alpha 0.9→0） |
| 星芒扫过 | 4.95–5.55s | `star4` 沿标题对角线扫，5.4s 峰值，长度 620px |
| 霓虹描管 | 5.8–6.6s | 按 SVG 路径长度 `strokeRange` 0→1 逐段点亮（`eInOutSine`），点亮后 1 帧 `neonLevel` 抖动 |
| 霓虹闪烁 | 6.6–6.833s | `neon_strike` 8 段 `[1, 0.15, 1, 1, 0.08, 0.5, 0.85, 1]`，每段 1–2 帧 |
| 结尾推镜 | 7.2–9.6s | `camZ` 从 8.0 缓推到 7.2（`eInOutSine`），9.667s 停 |
| CRT 关机 | 9.833–9.967s | 纵向压成一条 2px 亮线，再收缩到中心点 |

节奏：`cues.json` 里 100BPM = 0.6s/拍 = 18 帧/拍。所有硬切点落在拍上或拍的后半拍（`0.3s`）。

## 5. Remotion 落地配方

三条路线，按工程量从小到大：

1. **纯 Canvas2D 伪 3D（推荐，可控且确定性最好）**：自己做一点透视投影，网格、太阳、山、棕榈全部画在 2D 上，
   镀铬字用 `createLinearGradient` 多段色标，VHS 用第二个 canvas 做通道偏移 + 扫描线。无需 three。
2. **`@remotion/three` + `<ThreeCanvas>`**：工程已带 `three@0.183.2` 与 `@remotion/three`。场景按 `useThree()` 拿
   renderer，每帧在 `useCurrentFrame()` 变化时手动 `render()` 一次（关掉 `frameloop`），后处理不要用
   `EffectComposer`（帧时钟不可控），改在 ThreeCanvas 上盖一层 SVG/Canvas 做辉光与 VHS。
3. **上游 three.js 场景直接搬**：`index.html` 里的 `skyMat/sunMat/floorMat/palms/car` 都是标准 `THREE.ShaderMaterial`，
   可以整段搬进 `<ThreeCanvas>`，只需把 `renderAt(t)` 换成 `useCurrentFrame()/fps`，并把 `Clock`/`requestAnimationFrame` 全部删掉。

**必须改写的三处**（照抄会出错）：
- 上游用 `document.getAnimations()` 与 `THREE.Clock`；Remotion 里一切时间来自 `frame / fps`，不许有 `Date.now()`。
- 上游字体靠 `await document.fonts.load(...)`；Remotion 里用 `delayRender/continueRender` 或
  `@remotion/fonts` 的 `loadFont()`，否则首帧字宽会是 fallback。
- 上游后处理是 `EffectComposer` + `UnrealBloomPass`（HUD 也用），Remotion 下不可靠；用
  `filter:'blur(30px) brightness(1.4)'` 的 `screen` 叠层做宽辉光，`text-shadow` 做紧辉光。

15 帧骨架（Canvas2D 路线，可直接放 `scene-0.tsx`）：

```tsx
const W = 1920, H = 1080, HZ = 620;            // 地平线 y
const proj = (x: number, y: number, z: number) => { const k = 900 / z; return [W / 2 + x * k, HZ - y * k] }
const scene = (t: number, speed: number) => {
  const zOff = (t * 0.9 * speed) % 1
  for (let i = 1; i <= 26; i++) {                // 横向网格线：越近越疏
    const z = i - zOff; if (z <= 0.05) continue
    const [, y] = proj(0, 0, z)
    ctx.globalAlpha = Math.min(1, 0.15 + 0.85 / z); ctx.strokeStyle = '#FF2FB8'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
  }
  for (let k = -14; k <= 14; k++) {              // 纵向：全部收束到消失点
    const [x1, y1] = proj(k * 9, 0, 2), [x2, y2] = proj(k * 9, 0, 60)
    ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  }
  ctx.globalAlpha = 1
}
```

## 6. 镜头结构模板

10 秒 / 4 段，对应 cues 的真实切点（可直接当 storyboard）：

| 段 | 帧 | 画面 | 硬事件 |
| --- | --- | --- | --- |
| 0 | 0–126（0–4.2s） | 夜空 → 雪花落定 → 镜头压低贴网格飞 → 太阳升起 → 棕榈掠过 → 加速脉冲 | 3.867s 磁带倒带 2 帧 |
| 1 | 126–198（4.2–6.6s） | slam：镀铬标题砸入 + 白闪 + 车冲出画面 → 星芒扫过 → 霓虹手写体逐段点亮 + 闪烁 | 4.2s 音乐 gap 0.18s |
| 2 | 198–252（6.6–8.4s） | 霓虹字稳态 + 轻微管径呼吸 → tagline 浮现（7.2–8.1s）→ 第二颗星芒（8.4s） | — |
| 3 | 252–300（8.4–10s） | 收束推镜 → 9.667s 定格 → 9.833s CRT 关机 | 9.967s 全黑 |

**样片建议**：先只做 4.2–6.6s（slam + 星芒 + 霓虹点亮），这一段决定像不像；网格与天际线可以先用纯色占位。

## 7. 坑

1. **网格线会闪（shimmer）**：`z` 连续插值的线宽在缩放时跳变；每条线用整数 `z` 阶梯 + `snap()` 到 1/30s，
   并给线宽加 `lineWidth = Math.max(1, 1.5 * (12 / z))` 的钳制。
2. **辉光在浅色底上消失**：`screen` 混合只在深底上有效；纸色底要改用 `lighter` + 提高不透明度，或者干脆给
   整片套一层 `mixBlendMode:'multiply'` 的深紫底。
3. **VHS 通道偏移必须整像素**：`filter` 或 `transform: translate(0.7px)` 会产生亚像素插值，扫描线就糊了；
   用离屏 canvas `drawImage(src, -1, 0)` 或 `translate(1px)`。
4. **slam 的白闪会吃掉一帧字**：白闪必须画在标题**下面**（先闪后字），并且只持续 1 帧；2 帧以上会被看成丢帧。
5. **镀铬渐变要有硬停**：多段色标必须 `addColorStop` 相邻两个位置几乎相同（如 0.48/0.52）才有金属硬边；
   均匀过渡只会像塑料。
6. **霓虹描管的长度要用实际路径长**：`path.getTotalLength()` 在 SSR/无 DOM 时拿不到；Remotion 里改用
   预先量好的常量表（上游 `strokeRange` 是写死的数组）。
7. **结尾 CRT 关机不要用 scale(1,0)**：那会让亮线消失得太快；正确是高度 1080→2（3 帧）→ 宽度 1920→2（4 帧）
   → 亮度衰减到 0（2 帧）。

## 8. 版权与素材

上游 `demos/10-synthwave/` 是 MIT（见仓库 `LICENSE`），可以照搬数值与配方。但：
- 字体 `Michroma`、`Mr Dafoe` 与 `Archivo` 已随 DrawAI 内置；只有内置字体不适用时才考虑第 3 节的历史替代栈，
  并在 `BRIEF.md` 里写明「字体非原版」。
- 片名 `NEON DRIVE · Midnight`、`OUTRUN 1986`、`SUMMER 1986 · IN HI-FI STEREO` 都是虚构品牌，**可以改，不要用真实商标**
  （Ferrari、Lamborghini、MTV、VHS 厂牌）。
- 上游的车型是自建低模（`car()` 里 loft 出来的），不是贴图；照搬几何没问题，但别用真车厂的轮廓做「像某某跑车」的营销物料。
- 纹理由 shader 生成，没有外部图片依赖；若加纸张/金属纹理，用 CC0 源并记来源。
