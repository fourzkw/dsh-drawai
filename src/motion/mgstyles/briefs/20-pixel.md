# 20-pixel · 像素冒险 / 8-bit

上游：`src/motion/mgstyles/upstream/demos/20-pixel/film.js`（70 973 B / 914 行）、`cues.json`（888 B）。内部分辨率写死 `const W = 320, H = 180`，输出 1920×1080 正好 ×6；150 BPM / 30fps / 10.000s（一拍 12 帧）。`window.DEMO.motionBlur` 只 `samples:1`，味道全来自 CRT 后期。提示词原文用 `mg_style {action:"read",slug:"20-pixel"}` 取。

## 1. 一眼认出

- **每个像素是 6×6 输出方块**：1px 描边在成片里是 6px 实心块，没有抗锯齿，没有亚像素位移。
- **同屏 ≤32 色**，全部来自 `film.js:17` 的 `HEX`（QUEST-32）；渐变只有 4×4 Bayer（`BAY` / `bay(x,y)`），天空 5 级色阶。
- **动作是阶梯的**：跑步 `Math.floor(f/3)`（10fps）、星星 `Math.floor(f/4)`、金币 `Math.floor(f/2)`（15fps）。
- **横向卷轴**：`GROUND = 150`，主角屏幕 x 钉在 96（`cam(f) = hx(f) - 96`），相机停在 `CAM_END = 260`；视差 ×0.125 / ×0.3 / ×0.55 / ×1.4。
- **CRT 包住一切**：桶形 `k = 0.03`、按源像素行扫描线（6 输出 px 一条）、8 方向辉光、四角暗角。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 描边紫黑 | `#0d0b1a` | 精灵 1px 描边（slot 0）、夜间最暗部 |
| 夜蓝 | `#1b1a33` | 天空底、对话框最外层 |
| 天蓝 | `#5b9bea` | 正午天空、水面高光（远山 `#2a2f5a`、云 `#8cc8f5`） |
| 暖黄 | `#ffd166` | 金币、LOGO 立体面、光池 |
| 白 | `#ffffff` | 高光点、白闪、`PRESS START` |
| 品牌红 | `#d23c3c` | 主角围巾、丝带、UI 强调 |

机制两级间接：`IB` 是 slot 索引（非 RGB），`SM` 每 slot 存 DAY/AFT/GOLD/SUNS/DUSK/NIGHT 六列索引，`makeLUT(f)` 每帧展开成 `HEX` 的最终色号；换 stage 就是换 LUT（`stageOf(f)` 选列，转场 4 帧用 `mixIdx` 两级混合）。`theme.ts` 只放 6–8 个常量，其余留 `PALETTE: string[]` 按下标取。

**禁止色**：任何不在 `HEX` 里的颜色。尤其 `#808080` 灰、`#000000`（描边是带紫的 `#0d0b1a`）、任何高饱和紫——一出现就不像 8-bit。

## 3. 字体与字排

**当前优先使用插件内置字体：** 英文 HUD 使用 Press Start 2P，中文使用 Fusion Pixel 12；仍需在低分辨率网格上排版并用最近邻放大。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片写 `'Press Start 2P'`（HUD 数字 8px）和 `'Fusion Pixel 12'`（中文 12px），但**字体不是关键**：`glyph(ch, fam, size)` 先把字画进离屏 canvas，再按 alpha 阈值二值化成 1-bit mask（`gcache` 缓存），`text()` 用 1px 偏移补描边。像素感来自字被量化到源像素栅格。

旧版没有内置字体时使用的系统替代栈：等宽 `"Consolas","JetBrains Mono",monospace`；中文 `"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif`；粗标题 `"Arial Black","Impact",sans-serif`。

**损失**：Consolas 是矢量字，12px 中文会糊成灰块，直接 `fillText` 就破了 1-bit。必须照抄 `glyph()`：按 1× 画到 320×180 离屏 canvas，`getImageData` 后 alpha > 0.5 记 1，再 ×6 放大。字号只取 8/12/16，字距按整数源 px。

## 4. 动效语法

- **150 BPM = 12 帧/拍**；`beat 0.4 / bar 1.6`。
- **缓动只有两种**：物理用**整数关键帧表**——落地挤压 `SQT = {0:[6,6],1:[3,3],2:[-4,-2],3:[-4,-2]}`、回弹 `BOUNCE = {0:0,1:-5,2:-2,3:0}`、震屏 `logoShake(f)` 6 帧 `[3,-3,2,-1,1,0]`；位移用抛物线 `dy = Math.round(-128*(1-(i/12)**2))`。**没有** `Easing.bezier`，也不该有。
- **禁用**：`spring()`、作用在像素坐标上的连续缓动（必出半像素）、超过 2 帧的 opacity 渐变、`<CameraMotionBlur>`。
- 签名动作：
  1. **跑跳**（`jumps 0.3 / 2.0`，落地 `lands 0.9 / 2.8`）：12 帧抛物线 + 4 帧挤压，落地同帧 4 粒 `bay` 扬尘。
  2. **金币三连**（`coins 0.4/0.5/0.6`）：12×12 精灵 4 帧旋转，每枚隔 3 帧，`Math.floor(f/2)`。
  3. **开箱打字**（`box_open 4.6` → `type 4.8–5.6` → `box_close 5.8`）：`n = min(9, floor((f - fType)/3) + 1)`，3 帧一字，头像每 3 帧张嘴。
  4. **LOGO 砸落**（`logo 7.2`，`shine 7.6`）：12 帧自由落体 + 4 帧挤压 + 2 帧白闪 `M(8)/M(15)`，扫光每帧 18px、沿 `u = i + j*0.7` 判定。
  5. **入夜**（`night 8.0`，`night_wave 8.0–8.3`）：`waveR(f)` 按 `[150,110,70,36]` 四档收光池。
- **网格**：320×180 硬栅格；对话框 176×30 @ (72,99)，安全边距 8px。图层自下而上：`drawSky` → 远山 ×0.125 → `MID` ×0.3 → `HILLS` ×0.55 → 地面 → 主角 → `drawFG` ×1.4 → 对话框/HUD → CRT。

## 5. Remotion 落地配方

必须换掉：

1. `window.renderAt(t)` / `requestAnimationFrame` → `useCurrentFrame()`，`t = frame/30`。
2. `Date.now()` / `performance.now()` → 不需要。`rng(seed)` 在模块级只建一次（`const R = rng(7)`）。
3. `Math.random()` → 用 `hash(x, y)` / `rng()`（mulberry32）。别用 Remotion 的 `random()`：它按 seed 全局推进，重排会串。
4. **Canvas 2D 逐帧**：保留，改成 `useEffect(() => paint(ctx, frame), [frame])` 同步画；canvas 固定 `width={320} height={180}`，CSS 放大 6 倍 + `imageRendering:'pixelated'`。
5. CSS `transition` / `animation` → 全删，只留静态叠加层。
6. 运动模糊：上游 `samples:1`，**不加**。

**CRT 近似与损失**：`film.js:760` 的 `fs` 逐像素做 `sharp()` 像素中心重采样、桶形、扫描线（`sy = fract(uc.y*uSrc.y)`，每源像素行一条）、8 方向 glow。Remotion 拆静态层：`repeating-linear-gradient` 6px 周期 `rgba(0,0,0,.30)`、canvas 副本 `filter: blur(6px)` + `mixBlendMode:'screen'` 当辉光、`radial-gradient` 暗角、两条 1px 红/青偏移层 `screen` 当色偏。**损失**：无桶形（直边不弯）、无像素中心重采样（扫描线与像素格拍频出摩尔纹）、辉光是均匀高斯而非随亮度加权的 8 tap（暗部被抬灰）。

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { useEffect, useRef } from 'react';

const W = 320, H = 180, Z = 6;                 // 1920/320，必须整除

export const PixelScene: React.FC = () => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1b1a33'; ctx.fillRect(0, 0, W, H);
    // 12 帧坠落：先在源像素里取整，再画
    const dy = Math.round(interpolate(frame, [216, 228], [-128, 0],
      { extrapolateRight: 'clamp', easing: Easing.in(Easing.quad) }));
    ctx.fillStyle = '#ffd166'; ctx.fillRect(132, 60 + dy, 56, 28);
    ctx.fillStyle = '#0d0b1a'; ctx.fillRect(132, 60 + dy, 56, 2);
  }, [frame]);
  return (
    <AbsoluteFill style={{ background: '#0d0b1a' }}>
      <canvas ref={ref} width={W} height={H}
        style={{ width: W * Z, height: H * Z, imageRendering: 'pixelated' }} />
      <AbsoluteFill style={{ background:
        'repeating-linear-gradient(to bottom, rgba(0,0,0,.30) 0 2px, transparent 2px 6px)' }} />
    </AbsoluteFill>
  );
};
```

## 6. 镜头结构模板

| 时间 | 意图 | 画面 |
| --- | --- | --- |
| 0.0–0.9 | CRT 开机 | 点→线→张开（`PWR.on` 11 帧） |
| 0.9–3.2 | 跑跳 | 跳 0.3/2.0、落 0.9/2.8、6 金币、踩敌 2.4 |
| 3.2–4.4 | 减速 | `skid 4.0` 扬尘、`stop 4.4` 相机停，转 sunset |
| 4.6–5.8 | 开箱对话 | 箱开 4.6、打字 4.8–5.6、箱关 5.8 |
| 6.0–6.47 | 抖动→爆光 | `chest_open 6.4`、1 帧白闪、推镜 8→12 |
| 7.2–8.0 | LOGO 落地 | 12 帧坠落 + 4 帧挤压 + 扫光 7.6 + 震屏 |
| 8.0–10 | 入夜收尾 | 光池收拢、萤火虫、丝带、`PRESS START` 闪 |

## 7. 坑

1. 一处漏 `Math.floor` 就糊：`cam(f)`、`cx*0.125`、精灵 x/y 全要取整。
2. canvas 的 CSS 尺寸只能是 6 的整数倍，别套带小数的 `transform: scale()`。
3. `IB` 是 slot 索引不是 RGB，直接当颜色画会得一片噪点，必须先过 `makeLUT`。
4. 文字别交给 `<span>`：DOM 抗锯齿毁 1-bit，必须走 canvas 二值化。
5. 扫描线周期要整除 1080（2/3/6px），否则出摩尔纹。

## 8. 版权与素材

上游 mg-styles-15 为 MIT。本风格无外部图片/视频：精灵、6×7 字模 `LG`、地形、云全由代码生成。`SCORE`、`PRESS START` 类文案可替换；别用任天堂的角色名与商标。
