# 19-paperclip · 粗描边贴纸人科普 MG

上游：`demos/19-paperclip/index.html`（69.8KB，**逻辑全内联**：一块 2400×5900 的世界 + 相机 + 周期表
+ 地图）+ `cues.json`（3076B：`world {w:2400,h:5900}`、16 个相机关键帧、`ev` 40+ 事件、`chapters`）
+ `assets/stickers/meta.json`（8 张 PNG 的尺寸，**本体不在仓库**）+ `assets/countries-110m.json`（TopoJSON）。
1920×1080 / 30fps / 10.000s，120BPM。提示词原文用 `mg_style {action:"read",slug:"19-paperclip"}` 取。

## 1. 一眼认出

- **世界是一块竖长的手机屏**：`2400×5900`（`#world`），`border-radius:210`，底 `#E9EEF2` 铺 48px 网点（`#C5CFD8` 2.3px）；外套 `#0E141A` 机身 + 46px 白圈（`#bezel` 的 `box-shadow 0 0 0 46px #F7F9FB`）。
- **没有切镜，只有相机**：`cues.json` 的 `cam` 是 16 个 `{t,x,y,z}`，`z` 从 1.06 压到 0.2；每段标了 `move:"drift"|"fly"|"track"|"pullA"|"pullB"|"hold"`。10 秒是同一张画布上的六次运镜。
- **一切素材都是白描边贴纸**：`phone` 435×888、`battery` 448×331（`meta.json`），白边约长边的 2.3%（10px/435）；SVG 图标是显式的 `stroke="#F7F9FB" stroke-width="26"` + `paint-order:"stroke"`（`magnetSVG`，26/240 ≈ 11%）。
- **章节头是同一个模子**：20×20 橙色方块 + `02 对照元素周期表`（30px 700）+ `PERIODIC TABLE`（Inter 20px / `.18em` / `#8C9AA8`）。全片 4 个章节头一字不差。
- **数字是主角**：计数器 236px Inter 900 `-0.045em`（`cNum`），结尾 400px（`eNum`）；`tnum` 保证滚动不抖。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| text | `#25313D` | 所有中文正文与标题（35 次，最高频） |
| accent | `#FF5A36` | 唯一强调色：章节小方块、稀土、结尾大数字（29 次） |
| page | `#E9EEF2` | 手机屏内的纸色（第二高频底色） |
| surface | `#F7F9FB` | 卡片、tile、白描边、机身白圈（22 次） |
| muted | `#8C9AA8` | 英文小标、`/118`、单位（17 次） |
| sub | `#5E6D7B` | 注释、产地副名（4 次） |
| line | `#CDD6DE` | tile 内描边、未点亮格 |
| dot | `#C5CFD8` | 48px 网点 |
| stage | `#1D2731` | 屏外底，径向渐变到 `#27333F`/`#161E26` |
| bezel | `#0E141A` | 机身 |

**禁止色**：除 `#FF5A36` 之外的第二个彩色（绿/黄/紫一出现就散）、任何渐变填充（只有最外层底是
径向渐变）、纯黑 `#000`（墨是 `#25313D`）、任何 8px 以上的柔光。

## 3. 字体与字排

**当前优先使用插件内置字体：** 中文用 Noto Sans SC，英文和数字用 Inter；Alibaba PuHuiTi 尚未内置，必要时在取得后再替换。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片（`index.html:19-20`）：`.zh{font-family:'Alibaba PuHuiTi'}`、`.in{font-family:'Inter';
font-feature-settings:'tnum' 1,'case' 1}`。两个都不是系统字体。

- 中文 `'"Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",sans-serif'`，标题 700–900。
  **损失**：Alibaba PuHuiTi 字面更紧凑、900 更硬，YaHei 会松一圈，124px 的两行标题要多留 30px 宽。
- 拉丁/数字 `'"Segoe UI Black","Segoe UI","Inter",sans-serif'`（Win10 自带 Segoe UI Black 顶 900），
  并保留 `fontFeatureSettings:'tnum','case'`。**损失**：Inter 的开源几何形在 Segoe 上偏圆，236px 的
  `70` 会瘦一点，把 `letterSpacing` 收到 `-0.05em` 补。
- 等宽（`.iso` 编号、`TWN 0K8F2A`）`'"Consolas","JetBrains Mono",monospace'`。

字号阶梯（世界坐标，随相机缩放）：标题 124px/1.15；章节头 30px + 20px 英文；栏目名 34px；大数字
236px；分类数字 64px/72px；标签 34–50px；正文 28px/1.5。屏内最小 24px（`z=0.84` 时等效 20px）。

网格：`TX=196, TP=112, TS=104, TY=2620, FG=36`（`tXY`）—— 18 列 × 112 = 1904px，
`196+17*112=2100 < 2400`；镧系/锕系在第 7 行下断开 36px。所有章节间距是 112 的整数倍。

## 4. 动效语法

- 节拍：120BPM = 0.5s = **15 帧/拍**；但运镜不按拍走，按 `chapters [0, 2.7, 4.35, 5.62, 7.0]` 分五段。
- 缓动：`eFly = bez(.62,0,.22,1)`、`ePull = bez(.5,0,.08,1)`、`pullA = bez(.3,0,.1,1)`、
  `pullB = bez(.42,0,.22,1)`、`hold = u*u*(3-u)/2`（`EASE`，`index.html:79`）。z 在**对数空间**插值：
  `Math.exp(lerp(log(a.z), log(b.z), e))`。**禁用** `spring`/`back`：没有任何元素会弹过头。
- 签名动作：
  1. **相机 fly**（1.25–1.9、3.32–3.34、6.1–7.0）：0.6–1.0s，`eFly`，位移 1200–1600px 世界坐标；同时
     `r` 从 0 微调到 -3.5°。这是全片的"转场"。
  2. **贴纸 slap**（`slap(t,land,dur=.2,amp=.3)`）：0.2s 内 `s:1.3→1`、`r:6°→0`、`lift:1→0`，
     落地后 `wob(t-land,4.5,10)` 衰减抖动 —— 所有贴纸/角标落地都走这一个函数。
  3. **badge 剥离飞行**（`badge_peel 2.74` 起，`k` 错峰 0.012s）：62→104px 的方块沿弧线飞到周期表
     对应格子，落地序列 `badge_land` 10 个点（3.3→3.5，每 0.0222s 一个）驱动计数器 0→70。
  4. **路径描边生长**（`route_dur:.4`）：`stroke-dasharray:'1 1'` + `pathLength:1`，`stroke-dashoffset`
     从 1 到 0，`oC` 缓动；同一招用于年代轴、引线、地图国界。
  5. **计数器滚动**：数字直接 `textContent = lit`，但每次 +1 时 `scale(1.16)` 弹一下再 `oC` 收回；
     70 那一刻叠 `.06` 的 `wob(t,4,9)`。
- 组成：世界 2400 宽；章节头永远在 `x=196` 或 `x=300`；所有贴纸的白边 10px；投影
  `drop-shadow(0 ${6+34*lift}px ${10+34*lift}px rgba(22,34,46,${.26-.08*lift}))`。

## 5. Remotion 落地配方

1. `el()` 建 DOM + 逐帧改 `style` → React 组件；`fetch(ROOT+'cues.json')` → `import cues from './cues.json'`，
   `fetch(ROOT+'assets/stickers/...')` → `staticFile()`。
2. **相机数学可以 1:1 搬**（`projC` / `cam` / `worldM`，`index.html:76-96` 是纯函数）：
   `[a,b] = rot((wx-C.x)*C.z, (wy-C.y)*C.z, C.r)`，屏幕点 = `(960+a, 540+b)`。CSS 等价写法：
   `transform: translate(960px,540px) rotate(${C.r}deg) scale(${C.z}) translate(${-C.x}px,${-C.y}px)`
   （`transformOrigin:'0 0'`，顺序不能换）。
3. **`d3` + `topojson` 不可用**。`countries-110m.json` 已在仓库：自己解 TopoJSON —— `arcs` 是增量
   编码，先按 `transform {scale,translate}` 还原成 `[x,y]` 数组，再按几何的 `arcs` 索引拼接
   （负数表示反向并翻转）。投影退化成等距圆柱（`x=MB0+(lon+180)/360*w`）代替
   `d3.geoNaturalEarth1`。**损失**：高纬大陆会被横向拉宽，南极洲本来就被跳过。
4. `filter:#mbf`（4 个 `feDisplacementMap` 的 4-tap 运动模糊）+ `#pblur`（落地时 `stdDeviation` 0→12）
   → `@remotion/motion-blur` 的 `CameraMotionBlur` 只包 fly/pull 两段；手机落地那一镜用
   `blur(${12*(1-p)}px)` 的普通 CSS blur 近似纵向残影。
5. **贴纸素材缺失时自造**：SVG `<filter>` 里 `feMorphology operator="dilate" radius="5"` + `feFlood
   floodColor="#F7F9FB"` + `feComposite operator="over"` 得到 10px 白边（radius 5 = 两侧各 5px），
   再加 `feDropShadow dx=0 dy=10 stdDeviation=14`。比 `filter: drop-shadow()` 叠 8 层更硬、更像真的
   描边。没有照片就用**扁平色块 + 网点**自造图标（`radial-gradient` 48px 网格 + `#CDD6DE` 内描边），
   代价是失去"实物照片 × 精密图表"的对照感 —— 这是这个风格的一半，能拿素材就拿。

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import cues from './cues.json'
const CAM = cues.cam
const cam = (t: number) => {                       // 上游 cam()：分段 + 对数 z 插值
  const i = Math.max(0, CAM.findLastIndex((c) => c.t <= t))
  const a = CAM[i], b = CAM[Math.min(i + 1, CAM.length - 1)]
  const u = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t || 1)))
  const e = u * u * (3 - 2 * u)                    // 各段真实曲线见 EASE[move]
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e,
    z: Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * e), r: (b.r ?? 0) * e }
}
export default function PaperclipWorld() {
  const f = useCurrentFrame(), { fps } = useVideoConfig()
  const C = cam(f / fps)
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(120% 90% at 35% 50%,#27333F 0%,#1D2731 55%,#161E26 100%)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0',
        transform: `translate(960px,540px) rotate(${C.r}deg) scale(${C.z}) translate(${-C.x}px,${-C.y}px)` }}>
        <div style={{ position: 'relative', width: 2400, height: 5900, borderRadius: 210, overflow: 'hidden',
          background: '#E9EEF2', backgroundImage: 'radial-gradient(circle,#C5CFD8 2.3px,transparent 2.9px)',
          backgroundSize: '48px 48px' }}>
          {/* 章节内容放在世界坐标里，位置不随帧变 */}
        </div>
      </div>
    </AbsoluteFill>
  )
}
```

## 6. 镜头结构模板

| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0–1.25 | 0–38 | 手机落屏（`phone_land 0.16`，`slap` 落地）+ 两行标题 mask 上浮 + 英文小标 + 细线 |
| 1.25–2.8 | 38–84 | 向下飞 1220px，手机缩到 1 号位，5 个部件依次打标签（`parts 1.62–2.02`） |
| 2.86–4.35 | 86–131 | 周期表铺开（`table_in`）+ 计数器（`counter_in 3.24`）+ 角标剥离落格（3.3–3.5） |
| 4.42–5.62 | 133–169 | 按类别的条形/芯片起飞（`chips 4.48–5.2`），地球轴 + `/118` 出现 |
| 5.66–7.0 | 170–210 | 世界地图：4 张产地贴纸 + 4 条弧线路径生长 + 深圳 pin（6.45） |
| 7.0–8.14 | 210–244 | 拉远（`pullA` z 0.42 → `pullB` z 0.2），屏内 `70` 撕下变成贴纸飞向结尾 |
| 8.14–10.0 | 244–300 | slam 落定 + 斜线 `/118` + 标题 62px + 说明 28px + 来源脚注 |

## 7. 坑

- 2400×5900 的 DOM 世界 ≈ 1416 万 px²，Chromium 会切 tile 渲染，`overflow:hidden` + `borderRadius`
  的角上会出接缝；把圆角放在内层、外层不裁。
- 相机 `scale` 会把所有 `stroke-width`、`boxShadow`、`fontSize` 一起缩放 —— 想要"恒定的 10px 白边"
  就得在贴纸上写世界单位，不要写屏幕单位。
- `filter` 嵌套在 `transform: scale()` 的层里会让文字发虚，文字层别和贴纸共用 filter 容器。
- TopoJSON 的 `arcs` 忘了 `transform.scale/translate` 会得到 0–1 的坐标，整张地图缩成一个点。
- 大数字用 fallback 字体时 `tnum` 不一定生效（Segoe UI 支持，很多中文黑体不支持），数字容器给
  固定 `width` + `fontVariantNumeric:'tabular-nums'` 双保险。
- `findLastIndex` 需要 Node 18+/ES2023 —— Remotion 的打包目标如果是 ES2020，换成手写 `for` 循环。

## 8. 版权与素材

上游 MIT（`upstream/LICENSE`）。`countries-110m.json` 来自 world-atlas / Natural Earth（public domain）。
`Alibaba PuHuiTi` / `Inter` 是厂商字体，**不能随片分发**。贴纸 PNG 不在仓库，需自备或按第 5 节自造；
若用图库照片，选 CC0/Pexels 并裁成白边贴纸。品牌 `NEXA / N9 PRO` 是虚构的，客户品牌必须替换；
周期表元素数据是公共事实。音效用 `motion_sfx`（120BPM，纸张拍击 + 低频 whoosh + 单音 beep）。
