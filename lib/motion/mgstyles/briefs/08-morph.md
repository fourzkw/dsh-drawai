# 08-morph · 形变动画

上游：`index.html` 81.3KB（全部逻辑内联）+ `glyphs.json` 24.5KB（`upm:1000`，`glyphs[ch].contours` 为整数点，只有 m/o/r/p/h/e 六个 Outfit SemiBold 轮廓）；`cues.json` bpm 150（12 帧/拍）；land cup 0.4 / sun 2.0 / sunset 3.2 / gull 4.4 / plane 5.4 / pin 6.4 / heart 7.6 / m 8.6；build 4.8 / drop 6.4 / outro 8.8；1920×1080 / 30fps / 10s，Canvas2D + 一张离屏 canvas。

## 1. 一眼认出

- **一形万象**：始终只有一个实心剪影，8 个图标同一套 fill 轮换，没有描边、渐变、阴影（暗面是 `shade` 单独画的形，不是 opacity）。
- 变形不是交叉淡化：轮廓先重采样成**等点数**（body 240 / 洞 72 / 描边 24 / shade 60），`lerpP` 逐点插值；`via` 段经过中介圆或胶囊（`P.Ca/Cb`），所以中间必过"圆"。
- 每次落地都压扁再弹：`IMP` 表 + `impact()` 的 `A*sin(2πτ/0.28)*exp(-τ*7.5)`，`τ` 从 `im.t-2*FR` 起算。
- 背景是 5 色色块按 cue 依次 wipe（cream→mari→verm→ultra→cream→verm→ink），带软边，不是渐变。
- 最后一定落在印刷质感上：纸纹 + 512² 颗粒（每帧偏移）+ 暗角，像丝网印。

## 2. 色板

`index.html:25` `const C = { ink:'#16151B', cream:'#F4EEE3', mari:'#FFB627', verm:'#FF4F2B', ultra:'#2438E8' }`；pin 的暗面单独 `shadeC:'#D93A1C'`。

| 角色 | hex | 用在哪 |
|---|---|---|
| 纸底 / 主字 | `#F4EEE3` cream | 常驻底色、gull / plane / heart / m 的 fill |
| 墨 | `#16151B` ink | cup 的 fill、8.02s 的终场色块 |
| 黄 | `#FFB627` mari | sun 的 fill、1.62s 色块、字标圆点 |
| 橙红 | `#FF4F2B` verm | sunset / pin / heart 的 highlight、2.453s 色块 |
| 群青 | `#2438E8` ultra | 地平线/海面 flood 色块、plane 的 shade 30% |
| 暗面 | `#D93A1C` | 只给 pin 的 shade |

`surface/field/border/muted` 由 cream 与 ink 混出：`#E7E1D7`(6%) / `#DED8CF`(10%) / `#D0CBC3`(16%) / `#908C89`(45%)。禁止色：**不许渐变、发光、纯白 #FFF**；暗面只用 `mixC` 调暗，不用透明度。

## 3. 字体与字排

**当前优先使用插件内置字体：** 字标优先 Outfit，中文副标优先 HarmonyOS Sans SC，编号用 IBM Plex Mono；原片轮廓形变仍要使用对应的轮廓路径。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片：字标 `Outfit SemiBold` 250px（`FS=250`、`s=FS/1000`、`track=-5`、`yB=566`、词 `'morphe'`），轮廓来自 `glyphs.json`。副标 `HarmonyOS Sans SC` 500 34px / tracking 4 + `IBM Plex Mono` 500 19px 编号、14px 英文 / tracking 2.5，基线 y1002，x96。片尾 `HarmonyOS Sans SC` 500 40px、tracking 11、`GAP=30`、yb702；英文 `ONE SHAPE · EVERY STORY` 17px IBM Plex Mono、tracking 4、α.65、y758。

Windows 栈：字标 `"Segoe UI Semibold","Segoe UI",sans-serif` + `letter-spacing:-0.05em`；中文 `"Microsoft YaHei","Segoe UI",sans-serif` 500；等宽 `"Consolas","Courier New",monospace`。损失：Outfit 的几何正圆 o/e、单层 a 全丢，Segoe 的 o 略扁、字腔更大，250px 下要手动把 tracking 收紧到 -3；字重 500 在雅黑上偏粗，scaleX 0.98 压一点；Consolas 的 0 有斜杠、IBM Plex Mono 的 `1` 有底座，编号 01/07 观感会变。

## 4. 动效语法

150 BPM → 12 帧/拍，morph 窗多为 0.6–0.8s。缓动（`index.html` 顶部 `bez`）：`EM=bez(0.7,0,0.3,1)`（变形主曲线）、`EO=bez(0.16,1,0.3,1)`、`EIO=bez(0.45,0,0.55,1)`、`EB=bez(0.42,0,0.12,1)`（色块 bloom）、`EXI` expo-in。禁用 `bounce/elastic` 与 CSS 默认 `ease`；位移与形变都用同一条 `EM`，只有入场用 `EO`。

1. **落杯**（0→0.4 land，morph 0→0.62）：drop 形从上方 0.5 处压下，`EM` 到杯形；落地那一帧杯底压 6%，0.3s 回。
2. **变形链**（8 段，全部 `EM`）：cup>sun 1.3→2.0（via 圆 r116）；sun>sunset 2.4→3.2；sunset>gull 3.6→4.4（via 圆 r118）；gull>plane 4.8→5.4；plane>pin 6.3→6.4（via 胶囊，只 0.1s，硬切感）；pin>heart 7.0→7.6（via 圆 r120，`rot 18`）；heart>m 8.0→8.6。每段前半 `gA=EM(u/0.5)` 走到中介形、后半 `gB=EM((u-0.5)/0.5)` 张开到目标。
3. **飞行**（5.4–6.4）：plane 沿 `loop cx1215 cy387 r255` 绕，flight 节点 5.6/6.04/6.14 各错一次拍翼/侧倾，position 走 `qbez` 二次贝塞尔。
4. **心跳**（7.8 / 7.93）：heart 两次 `A.14` 的 squash，间隔 0.13s，第二次幅度 60%。
5. **字标**（8.32 起）：5 个字母 `t0 + i*0.075`，`travel 0.42` 先平移、`fly 0.32` 再落位，`EO`；字标圆点在 e 右侧 `dotGap=9`、半径 22。

网格：画布中心 960，安全边距 96，地面 642，色块圆心取图标 `pos`。图层：色块 fields（逐个 wipe）→ 图标 shade → body → 洞（evenodd）→ 描边 → UI → 颗粒/暗角。

## 5. Remotion 落地配方

API：`useCurrentFrame` / `useVideoConfig` / `interpolate` / `Easing.bezier` / `AbsoluteFill` / `<svg>` + `<path>`；运动模糊 `@remotion/motion-blur` 的 `<MotionBlurTrail samples={4} shutter={0.5}>`；离线采样用 `@resvg/resvg-js`，或干脆在 build 阶段把轮廓算成点数组存 JSON。

必须换掉：

1. `requestAnimationFrame` / `renderAt(t)` → 一切由 `frame` 派生；`sceneTime` 一类积分（若有）改成对 t 的解析式。
2. `Date.now()` / 自增帧计数 → 唯一时钟 `frame`，颗粒偏移用 `frame` 整数取模。
3. `Math.random()` → 上游颗粒是固定序列，搬成 `(f*197)%512` / `(f*331)%512` 的确定性偏移。
4. Canvas2D 逐帧 `draw` + `<path>.getPointAtLength`（`sampleD`/`resamplePoly`）→ **双轨**：A）离线把每个图标的 body/hole/stroke/shade 采样成点数组写进 JSON，运行时只做 `lerpP`，再用 `<path d=…>` 渲染（保真，推荐）；B）运行时用 `@resvg/resvg-js` 把 SVG path 栅格化成 PNG 再 `lerp` 两张图（会糊，且 morph 中间态是双影，只能当占位）。A 的损失几乎为零，前提是点数与首顶点对齐（见坑 1、2）。
5. CSS `transition/animation`、`clip-path` 动画 → 色块 wipe 用 SVG `<mask>` 的圆/矩形半径按 `EB` 插值，别用 CSS。
6. 4 采样运动模糊（`index.html:15`）→ `<MotionBlurTrail samples={4} shutter={0.5}>` 只包飞行与字标层；squash 帧不要加，会糊掉冲击。

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
const EM = Easing.bezier(0.7, 0, 0.3, 1);
const C = { ink: '#16151B', cream: '#F4EEE3', mari: '#FFB627', verm: '#FF4F2B', ultra: '#2438E8' };
const ring = (n: number, cx: number, cy: number, r: number) =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)] as const);
const P = { circle: ring(64, 960, 480, 120), square: ring(64, 960, 480, 120).map(([x, y]) => [960 + (x - 960) * 0.9, 480 + (y - 480) * 0.9] as const) };
const d = (pts: readonly (readonly [number, number])[], u: number) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(x + (P.square[i][0] - x) * u).toFixed(1)} ${(y + (P.square[i][1] - y) * u).toFixed(1)}`).join('') + 'Z';

export const Morph: React.FC = () => {
  const t = useCurrentFrame() / useVideoConfig().fps;
  const u = interpolate(t, [7.0, 7.6], [0, 1], { easing: EM, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const wipe = interpolate(t, [6.4, 6.85], [0, 1], { easing: Easing.bezier(0.42, 0, 0.12, 1), extrapolateRight: 'clamp' });
  const sx = 1 + 0.14 * Math.sin(Math.PI * u); // 变形中段轻微拉伸
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      <AbsoluteFill style={{ background: C.cream, clipPath: `circle(${wipe * 120}% at 960px 540px)` }} />
      <svg width={1920} height={1080} viewBox="0 0 1920 1080">
        <path d={d(P.circle, u)} fill={C.verm} transform={`translate(960 480) scale(${sx} 1) translate(-960 -480)`} />
      </svg>
    </AbsoluteFill>
  );
};
```

## 6. 镜头结构模板

- **0–1.3** 落杯：0→0.62 变形，落地压 6%，0.8 后 cup 静置，1.0 起副标 `早安 / GOOD MORNING`。
- **1.3–2.4** cup→sun：1.62 mari 圆从 sun 位置涨开；2.0 sun 落定，`IMP` A.07。
- **2.4–3.6** sun→sunset：2.453 sky 色块、2.6 sea 色块；sunset 3.2 到。
- **3.6–4.8** sunset→gull：3.98 flood 把海面推到 -80；gull 4.4，副标 `海风 / SEA BREEZE`。
- **4.8–6.4** gull→plane→pin：5.4 起飞绕 loop，6.3 起 0.1s 极快变 pin，6.367 shock。
- **6.4–7.6** 全屏 cream 闪一帧→verm 圆 7.233 涨开→pin→heart。
- **7.6–8.6** 心跳 7.8/7.93，8.02 ink 色块压满，8.0 起 heart→m。
- **8.6–10** 字标 8.32 起 5 字母落位，8.95 tagline，9.14–9.38 进度点收满。

## 7. 坑

1. 点数必须与上游一致（240/200/72/24/60），少一个点就抖；两形点数不同时先 `resamplePoly` 到同 N，别用 `interpolate` 硬插两串不等长数组。
2. 首顶点与绕向要对齐（`orient` 按有符号面积、`bestShift` 找最小位移），否则变形会拧成麻花——这是这份 demo 最容易被做坏的地方。
3. `getPointAtLength` 依赖 DOM，Server 端渲染直接崩；必须预采样或只在 `<svg>` 里用 `getTotalLength` 的浏览器路径。
4. 色块 wipe 软边是 `FEATHER = 0.4*0.5/FPS` 个像素，硬边会有锯齿，太大则像雾。
5. 颗粒每帧整数偏移，subpixel 抖动会把纸纹糊平。
6. 洞用 `fill-rule:evenodd` 一次画，别用两个 path 叠，变形时会露缝。

## 8. 版权与素材

上游 mg-styles-15 为 MIT。`glyphs.json` 是 Outfit SemiBold 的轮廓子集（SIL OFL），可作字标参考但别当品牌字体；纸纹 `Paper001_4K_color.jpg` 已在插件素材库，可通过 `motion_assets library` 搜索并导入，来源 ambientCG、许可 CC0；也可用工程自带 SVG 近似（损失细纤维）。7 个中文副标与 `ONE SHAPE · EVERY STORY` 是文案占位，成品换客户词。
