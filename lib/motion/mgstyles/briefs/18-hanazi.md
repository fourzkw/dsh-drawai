# 18-hanazi · 综艺花字（竖屏）

上游：`demos/18-hanazi/index.html`（51.4KB，**逻辑全内联**：CSS + 花字组件 `HZ` + 四个分镜的
`renderAt`）+ `cues.json`（1116B，120BPM，`drop:6.0`、`freeze:7.5`）。1080×1920 / 30fps / 10.000s。
`/assets/white_dof.jpg` 等 15 个素材**不在仓库**，只有引用路径。
提示词原文用 `mg_style {action:"read",slug:"18-hanazi"}` 取。

## 1. 一眼认出

- **每个字三层描边**：标题的 `HZ` 参数 `size:172, white:13, outer:12, ext:16`（`index.html:238`）——
  相对字高 **7.6% / 7.0% / 9.3%**，三层几乎等宽。只有一层描边的字就不是这个风格。
- **字永远歪着**：每字 `rot [-7,4,-3,6,-5]`、`y +[6,-16,10,-12,4]`（`index.html:237-240`）。全片没有正着放的花字。
- **入场是弹簧不是缓动**：`spring(t,.517,22)`，源码注释写明 "peak 1.15 at frame 5, ~1.01 at frame 8"。
- **竖屏一行 5 字是极限**：`x=[196,368,540,712,884]` 等距 172，左右各留 196。第 6 字必胀出安全区。
- **装饰是手绘几何**：四角星 `sparkleD`、爆炸框 `burstD`（2n 顶点交替内外半径抖动）、放射线 `focusD`、汗滴 `DROP_D`；没有 emoji、没有渐变图标。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| text | `#FFFFFF` | 白描边、说明字 |
| ink | `#1E2A78` | 主描边、标签字（25 次，最高频） |
| shade | `#1A1030` | 最外描边、硬阴影、警条底（15 次） |
| accent | `#FFE14D` | 亮黄强调、斜纹（15 次） |
| accent2 | `#FF3D7F` | 玫红爆炸框、外描边（8 次） |
| deep | `#0E1440` | 深蓝底、电池壳（8 次） |
| cool | `#2CCBF2` | 天蓝，糖纸 wipe 底色 |
| warn | `#FF2E4D` | 警告条内条、「爆表」 |
| page | `#1B1B22` | 舞台底（照片没盖满时露的缝） |

另有 `#FF9A1F`/`#A3124F`（暖渐变与挤出）、`#7BE35A`、`#8EE8FF`（汗滴）、`#B04CFF`、`#A9C4E0`。
**禁止色**：莫兰迪/灰粉、金属渐变、纯黑 `#000`（阴影一律 `#1A1030`）、任何没描边的字。

## 3. 字体与字排

**当前优先使用插件内置字体：** 主花字用 Resource Han Rounded，副标用 Douyin Sans，手写吐槽用 LXGW Marker Gothic；英文可用 Luckiest Guy 或 ZCOOL KuaiLe。Alimama ShuHeiTi 尚未内置。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片 6 种字体（`/assets/fonts/fonts.css`，上游仓库不带字体文件，DrawAI 已内置其中可用的字体）：`'Resource Han Rounded'` 900（标题）、
`'Douyin Sans'` 700（副标）、`'Alimama ShuHeiTi'` 700（震惊）、`'LXGW Marker Gothic'`（手写吐槽）、
`'ZCOOL KuaiLe'`、`'Luckiest Guy'`（EP.07）。

- 圆胖体 `'"YouYuan","Microsoft YaHei UI","Microsoft YaHei",sans-serif'`。幼圆是 Win10/11 唯一自带圆体，
  只有 400 —— **加粗靠描边**：`strokeWidth = 2*(white+outer) = 50px` 的圆头描边把字面撑胖，等价 700–800。
- 副标 `'"Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",sans-serif'` 700；手写吐槽
  `'"KaiTi","Microsoft YaHei",sans-serif'` + `skewX(-7deg)`（上游 `quiet` 的 `skew:-7`）；
  英文 `'"Arial Black","Impact",sans-serif'`。

**损失**：① 幼圆没 900，中宫比 Resource Han Rounded 瘦，靠描边补仍偏"幼"；② 楷体太书法，只有 ≤66px
的小字能骗过去；③ 抖音体/Alimama 是平台授权，替代后「震惊！！」的窄字面没了，250px 会显宽，缩到 236px。

字号：主花字 172px（屏宽 16%）；爆炸大字 250px（23%）；副标 92px；标签 40–54px，**最小 40px**。
字距：**不用 `letter-spacing`** —— 每字要独立旋转，必须逐字绝对定位，`x = 起点 + i × 字号`。
安全区：左右 96px；主花字底边 ≤1560（给抖音 UI 留 360）；顶部 ≥240。标题基线 1515 + 上浮 16 = 1531。

## 4. 动效语法

- 节拍：120BPM = 0.5s = **15 帧/拍**，20 拍。事件几乎都落在半拍（0.267s = 8 帧）上。
- 缓动：`spring(t,z=.517,w=22)` 主曲线；`E.outCubic` 退场、`E.outExpo` punch-in、`E.inCubic` 下沉。
  **禁用**线性 —— 全片没有匀速运动。
- 签名动作：
  1. **逐字弹入**（`title` 0.2 起，错峰 `0.0667s` = **2 帧**）：`scale 0→1.15→1`、`y` 从 -90 落回、
     `rot` ±16° 回正，8 帧到位；0.22s 后叠 `1.8° wiggle + 3px bob`，`wf=1.15Hz`（`charXf:97`）。
  2. **quarter-beat 蹦跳**（`title_beats [1.0,1.5,2.0]`）：每字再错 2 帧，`hy=40*4k(1-k)`，squash `+0.11/-0.07`。
  3. **pop-out**（0.17s = 5 帧）：先 `1.12` 再 `inCubic` 到 0，换镜前清场（`popOut`）。
  4. **拍上去**（`punch2:3.0` `kick(...,10,10,13)`、`drop:6.0` `kick(...,26,7,11)`）：整镜 translate ±26px，
     `exp(-7u)` 衰减 —— 位移不是缩放。
  5. **糖纸 wipe**（`wipe:4.0`）：0.46s = 14 帧，128px `pattern` 斜条从 `x=2400` 横移到 `-2400`（`inOutSine`）并 `rotate(-20°)`。
- 组成：照片满屏（Ken Burns 1.0→1.08）；花字锚在 `y 1230–1720`；装饰在四周 120–260px 环带；图层
  自下而上 = 照片 → 暗角/日光 → 花字（ext→outer→white→fill→gloss）→ 装饰 → flash → grain。

## 5. Remotion 落地配方

1. `renderAt(t)` 里逐帧 `setAttribute`/`style.display` → 每帧重算 style，`show()/disp()` → `return null`。
2. 自写 `spring()` → `spring({frame, fps, config:{damping:22.75, stiffness:484, mass:1}})`：zeta .517 ×
   omega 22 等价 `damping=2ζω=22.75`、`stiffness=ω²=484`，第 5 帧峰值 1.15 与原片一致。
3. `Math.random()` 的爆炸框抖动 → `random('burst-'+seed)`；`hand(t,seed)` 是确定性值噪（`vn`/`h1`），
   可原样搬，但 `t` 必须是 `frame/fps`。
4. CSS `filter:url(#soft)`（feGaussianBlur 8px）→ `drop-shadow(0 6px 18px rgba(26,16,48,.45))`。
   **损失**：SVG 模糊是各向同性"墨水晕"，drop-shadow 只有偏移，边缘更干净也更数字。
5. 五层叠字必须用 SVG：`-webkit-text-stroke` 只能叠一层，且不吃 `paintOrder`。
6. Ken Burns 用 `<Img src={staticFile(...)}>` + `scale(1+0.08p)`。**素材缺失时**用 `linear-gradient` 色块 +
   `feTurbulence` 顶替，但"综艺截图感"是内容的一半 —— 这个风格应该让用户提供素材。

```tsx
import { useCurrentFrame, useVideoConfig, spring } from 'remotion'
const FONT = '"Resource Han Rounded","Noto Sans SC",sans-serif'
const OUTER = '#FF3D7F', EXT = '#A3124F'
export const HanaziChar = ({ ch, x, y, rot, t0, size }:
  { ch: string; x: number; y: number; rot: number; t0: number; size: number }) => {
  const f = useCurrentFrame(), { fps } = useVideoConfig(), u = f - t0 * fps
  if (u < 0) return null
  const pop = spring({ frame: u, fps, config: { damping: 22.75, stiffness: 484, mass: 1 } })  // ζ.517 ω22
  const drop = spring({ frame: u, fps, config: { damping: 22, stiffness: 400, mass: 1 } })    // ζ.55  ω20
  const turn = spring({ frame: u, fps, config: { damping: 18, stiffness: 324, mass: 1 } })    // ζ.45  ω18
  const hold = Math.min(1, Math.max(0, (u / fps - 0.22) / 0.35))
  const r = rot * (1 - turn) + hold * 2.2 * Math.sin(2 * Math.PI * 1.15 * (f / fps))
  const s = pop * (1 + hold * 0.012 * Math.sin(2 * Math.PI * 2.3 * (f / fps)))
  const t = { fontFamily: FONT, fontWeight: 700, fontSize: size, textAnchor: 'middle' as const,
    dominantBaseline: 'central' as const, strokeLinejoin: 'round' as const }
  return (
    <g transform={`translate(${x} ${y - 90 * (1 - drop)}) rotate(${r}) scale(${s})`}>
      <text {...t} y={16} fill={EXT} stroke={EXT} strokeWidth={50}>{ch}</text>
      <text {...t} y={8} fill={EXT} stroke={EXT} strokeWidth={50}>{ch}</text>
      <text {...t} fill={OUTER} stroke={OUTER} strokeWidth={50}>{ch}</text>
      <text {...t} fill="#fff" stroke="#fff" strokeWidth={26}>{ch}</text>
      <text {...t} fill="url(#gz)">{ch}</text>
    </g>
  )
}
```

运动模糊：上游 `window.DEMO.motionBlur={samples:1, shutter:0.5}`（`index.html:40`）只开 1 采样。这里用
`CameraMotionBlur` 只包 punch/drop 两镜（±26px 位移要糊）；花字本体不包，描边会糊成双层边。

## 6. 镜头结构模板

| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0–2.5 | 0–75 | 逆光起手 + 标题逐字（0.2 起，5 字 10 帧铺完），1.0/1.5/2.0 三次蹦跳 |
| 2.5–4.0 | 75–120 | 划痕转场 `scratch` + 三个问号 + 手写吐槽「空气突然安静」逐行扫出 |
| 4.0–7.5 | 120–225 | 糖纸 wipe 进二段：嘉宾条 4.2、警告条 4.9、**drop 6.0「震惊！！」**、副标 6.6、检测表 7.0 |
| 7.5–8.5 | 225–255 | freeze：画面拍成白边卡（`freeze_hold` 0.267s），只留 `zoom 1.03` 呼吸 |
| 8.5–10.0 | 255–300 | 爆炸框 + 「绝绝子」逐字（8.1/8.167/8.233）+ stamp 8.5 + EP.07 收尾 |

## 7. 坑

- 172px × 5 字 = 860px，两层描边外扩后 ~886px，左右只剩 97px。换 6 字先量再排。
- 五层 `<text>` 用同一个 `dominantBaseline`，别混用 `dy` 和 `y` —— 两套度量差 0.02–0.05em。
- 三层描边都要 `strokeLinejoin:'round'`，否则「？」的尖角会炸开。
- 「冻结半帧」用 `<Freeze frame={225}>` 包画面、外层单独做 zoom，不要在场景里插值时间。
- grain 层必须 `inset:0` + `pointerEvents:'none'`；尺寸小于画布时 `overlay` 会留暗带。

## 8. 版权与素材

上游 MIT（`upstream/LICENSE`）。贴纸照片标称 CC0 但**不在仓库**，需自备。「喵呜日记」是虚构节目名，
`EP.07` 可用。`Resource Han Rounded`/`Douyin Sans`/`Alimama ShuHeiTi`/`LXGW Marker Gothic`/
`ZCOOL KuaiLe`/`Luckiest Guy` 各有授权，**不能随片分发**。四角星、爆炸框、汗滴是可自由重画的通用
图形。音效用 `motion_sfx`（120BPM，boing + 玻璃叮 + 拍击）。
