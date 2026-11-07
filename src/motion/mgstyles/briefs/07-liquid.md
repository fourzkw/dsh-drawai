# 07-liquid · 液态流动

上游：`index.html` 6.4KB + `js/scene.js` 56.7KB + `js/shaders.js` 31.7KB + `js/engine.js` 9.8KB + `js/{type,textsdf,links,lookdev}.js`；`cues.json` bpm 150（12 帧/拍）D major：pour 0 / rain 0.4 / fuse 2.0 / leap 3.2 / flood 4.0 / immersed 4.42 / reveal 4.85 / gather 5.75 / gap 6.2 / drop 6.4 / glint 7.1 / drip 7.6 / ripple 8.4 / end 10.0；1920×1080 / 30fps / 10s，WebGL2 + RGBA16F + bloom。

## 1. 一眼认出

- 只有一种材质：**稠液体**。球缘 1–2px 高光唇线（`palThin`），内部按厚度 u 混合橙→粉→紫（`palMid`，`js/shaders.js:284-302`），不是玻璃也不是水。
- 落地先压扁再回弹：静止水洼 `SV_PUD = 0.5` + `svLand()` 的 `spring(tl, 6, d.z)`（`js/scene.js:128-130`），接触点留 splat 与 5–7 条 tendril。
- 棚拍暗紫棚：`backdrop()` 顶 `lin(0.070,0.018,0.090)` → 地平线 `lin(0.205,0.058,0.235)`；地平线 786px（`uHorizon`）、接触线 872px（`floorY`）、key light `{x:-0.78,y:-0.95}`。
- 4.0s 三层洪流面压上来（`uOv[3]`，`sheets_in 4.035/4.105/4.175` 各错 2 帧），4.42s 沉进液体（immersed），只剩涡流 `uSw` 与气泡 `uBub`；6.4s 液滴拉成 4 个字形（`uTex`+`uL[4]`+`uLM[4]` 椭圆中介形），7.2s glint 扫过，8.4s 一滴落下、`uRip` 收尾。

## 2. 色板

着色器里全是线性值（`lin(c)=pow(c,2.2)`，`js/shaders.js:10`）；下表按 `c^(1/2.2)` 反算，`js/links.js:6` 另有官方 sRGB 近似（`PM`/`PT`），取色以后者为准（差 10–15%）。

| 角色 | hex | 用在哪 |
|---|---|---|
| 液体主体 | `#FF5C0F` → `#FF1A70` → `#8F1FFF` | `palMid`，随 u 三段插值 |
| 高光唇线 | `#FFBD4D` → `#FF80A8` → `#D685FF` | `palThin`，球缘 1–2px |
| 深部 | `#E65A3B` → `#CD2B94` → `#853BCA` | `palDeep`，厚处与接触阴影 |
| 背景顶 / 地平线 | `#4C2955` / `#7C4684` | `backdrop()`，786px |
| 地面近 / 远 | `#371E3E` / `#703F77` | `floorCol()` |
| 主字 / 副标 / 高光 | `#FFE8F0` / `#FFC8E0` / `#FFF7F0` | `js/type.js`、`links.js:39` |

禁止色：**纯黑 #000 / 纯白 #FFF 都不进液体**（暗部 `#371E3E`、高光 `#FFF7F0`）；**不加青/蓝绿**，色谱里没有。

## 3. 字体与字排

**当前优先使用插件内置字体：** 英文标题用 Fraunces，中文可用 Resource Han Rounded 或 Noto Serif SC，界面副标用 Inter；上游指定的 Fraunces 可变轴实例可能与默认值不同。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片：`Fraunces Liquid` 900，'drop' 400px / tracking 10 / pad 170 / sigma 10（`js/textsdf.js`）；v5 换成 `Resource Han Rounded` 900 / 300px。副标 `Noto Serif SC` 600 44px、y958、tracking 14、`rgb(255,232,240)` α.96；次行 `Inter` 600 20px、y999、tracking 5.5、`rgb(255,200,224)` α.70，右对齐到 `word.letters[3].bbox[2]-4`（`js/type.js`）。

Windows 栈：display `"Constantia","Georgia",serif` 700 + `-webkit-text-stroke:0.4px`；中文 `"SimSun","宋体",serif` 600；西文 `"Segoe UI",sans-serif` 600。损失：Fraunces 的柔楔衬线 / 光学尺寸 / 圆 terminal 全丢，Constantia 更硬、x-height 更小，400px 下 tracking 要 10→14；宋体 300px 露点阵边，大字号中文改 `"Microsoft YaHei"` 700；两族都无 900，硬给会被 Chrome 合成加粗并横向撑开。

## 4. 动效语法

150 BPM → 12 帧/拍、6 帧/半拍，cue 全落 0.4 网格。缓动（`js/scene.js:28-31`）：`inOut=(0.65,0,0.35,1)`、`easeIn=(0.5,0,0.9,0.4)`、`frontEase=(0.28,0.55,0.42,1)`；回弹用 `spring(t,f=4,z=0.3)` / `wob(t,f,decay)`（`scene.js:33-38`）。禁用 CSS `ease` 与 `bounce/elastic` 预设；`linear` 只给洪流前沿与 glint。

1. **落滴**（0→0.167）：四滴 0.4/0.8/1.2/1.6 落地（x 640/1250/405/960，尺寸 1.0/0.85/0.8/1.35）；`easeIn` 下落，落地前 2 帧缩到 0.94，落地后 12 帧 squash 到 0.62 再回 0.5。
2. **融合**（merges 2.0/2.4/2.8）：三对球按 `mergeK` 的 smoothstep 收拢，靠 `k=0.1` 的 smooth-union（`uK`）不是布尔；每对 0.18s、错峰 0.4s，接 hop 1.66/2.06/2.46。
3. **洪流**（4.0→4.42，一拍）：前沿是 `uFlA`(amp/freq/lean) 行波，三层 `uOv` 各错 2 帧；immersed 时相机 zoom 降、画面转 `uSw`+`uBub`。
4. **标志与收尾**：6.4 `logo_snap` / 6.417 `letter_bridge_snap`，液滴被 `frontEase` 拉成 4 字形 0.32s，字间走 `uLM` 椭圆、不淡入；8.4 `drip_land`→8.567 `drip_snap`，`uRip` 一圈 0.55s 衰到 0。

构图：落点 x 固定，地平线 786、接触线 872、副标基线 958/999，安全边距 96px。图层：backdrop → floor → 主体 → 唇线 → sheets → SDF 字 → bloom → tonemap → grain。

## 5. Remotion 落地配方

API：`useCurrentFrame` / `useVideoConfig` / `interpolate` / `Easing.bezier` / `AbsoluteFill`；保真路线加 `three` + `@react-three/fiber` 的 `<shaderMaterial>`；运动模糊用 `@remotion/motion-blur` 的 `<MotionBlurTrail>`。

必须换掉：

1. `requestAnimationFrame` / `renderAt(t)` 主循环（`js/engine.js`）→ 全由 `frame` 派生，`t = frame/fps`；`js/scene.js:51` 的 `camAt(t)` 可原样搬。
2. `Date.now()` / 自增 `uFrame` → 唯一时钟是 `frame`，glint 与气泡相位都按 t 算。
3. `Math.random()` → 上游已是固定种子 `rng(20260927)`（`scene.js:39`），照抄 LCG，否则每帧噪点都在跳。
4. CSS `transition/animation`、远程 `@font-face` → 静态 style，字体走上面的栈。
5. WebGL 逐帧重绘 → **A 保真**：fragment shader 原样塞 `<shaderMaterial>`，每帧上传 `uB[72]/uS[20]/uBub[32]/uFl/uOv[3]/uCam/uT`，代价是 bloom mip chain 自写 + 确认 `EXT_color_buffer_float`。**B 降级**：双层 SVG 椭圆（`palMid` 渐变 + `palThin` 高光弧）+ `blur(6px)`，bloom 靠复制层 `blur(24px) saturate(1.4)`，损失 smooth-union / 折射 / 唇线，球数超 5 个露馅。**A 更保真**，B 只适合 <3s 或液体非主角。
6. 运动模糊：上游是页内时间超采样（FAST 段 16/20/24 采样、shutter 0.5，`index.html:24` 只声明 `samples:1`）；Remotion 用 `<MotionBlurTrail samples={6} shutter={0.5}>` 只包下落/洪流层，或按 `uOvV`（px/frame）在 shader 里对前沿一维多采样。

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
const B = { front: Easing.bezier(0.28, 0.55, 0.42, 1), fall: Easing.bezier(0.5, 0, 0.9, 0.4) };
const springS = (t: number, f = 6, z = 0.38) => t <= 0 ? 0 : Math.exp(-z * 2 * Math.PI * f * t) * Math.cos(2 * Math.PI * f * Math.sqrt(1 - z * z) * t);
const DROPS = [[0.4, 640, 1], [0.8, 1250, 0.85], [1.2, 405, 0.8], [1.6, 960, 1.35]];

export const Liquid: React.FC = () => {
  const t = useCurrentFrame() / useVideoConfig().fps;
  const flood = interpolate(t, [4.035, 4.42], [0, 1], { easing: B.front, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(#4C2955 0%, #7C4684 72.8%, #703F77 72.9%, #371E3E 100%)' }}>
      {DROPS.map(([t0, x, s], i) => {
        const fall = interpolate(t, [t0 - 0.167, t0], [0, 1], { easing: B.fall, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const r = interpolate(fall, [0, 1], [10, 62 * s]);
        const sy = 1 + 0.38 * springS(t - t0, 6, 0.38);
        return <div key={i} style={{ position: 'absolute', left: x - r, top: 872 - r * 2 * sy, width: r * 2, height: r * 2 * sy, borderRadius: '50%',
          boxShadow: 'inset 0 2px 5px #FFF7F0, 0 0 40px #FF1A7066',
          background: 'radial-gradient(circle at 34% 26%, #FFBD4D, #FF80A8 30%, #FF5C0F 58%, #8F1FFF)' }} />;
      })}
      <AbsoluteFill style={{ transform: `translateY(${(1 - flood) * 1080}px)`, background: 'linear-gradient(#FF80A8, #8F1FFF)' }} />
    </AbsoluteFill>
  );
};
```

## 6. 镜头结构模板

- **0–2.0** 空棚 + 786px 地平线起手，第一滴 0.4 落，splat / tendril 长出，1.66 起腾跃。
- **2.0–4.0** fuse / leap：三对融合成"水母"，hop 2.06/2.46 + 3.433 `thread_snap` 细丝。
- **4.0–4.42** flood：三层 sheet 压满，4.0 impact 相机抖一帧。
- **4.42–6.4** immersed→gap：全屏液体只剩涡流气泡，5.75 收成一条液线。
- **6.4–8.4** drop→glint：6.4 落成、6.417 桥接，7.2 扫光 0.55s。
- **8.4–10** 8.4 滴落、8.567 涟漪，8.8 后只剩微颤。


## 7. 坑

1. 无头 Chrome 拿不到 `EXT_color_buffer_float` 时 bloom 全黑——先探测，退回 8bit 并把阈值降 0.2。
2. uniform 数组定长（`NB 72` / `NS 20` / `NBUB 32`），`uNB` 只控有效个数，超了静默截断。
3. squash 支点是**接触点**（`makeM` 的 `piv`）不是质心，CSS `transform-origin` 放错会像气球。
4. sRGB 里 lerp 会发灰：`#FF1A70 → #8F1FFF` 中间补 `#FF3E9F`、`#C63BFF`。
5. `uMbw` 是"帧间快门比例"不是模糊半径，搬过来换成 `shutter/fps`。

## 8. 版权与素材

上游 mg-styles-15 为 MIT。Fraunces、Instrument Serif、Inter 与 Noto Serif SC 已随 DrawAI 内置；`js/textsdf.js` 的字形图集不要复用。'drop' / 'LIQUID MOTION' / 「液态流动」是占位词。
