上游：`demos/03-isometric/js/`（`world.js` 80.5KB 场景与纯时间更新、`render.js` 9.2KB 累积采样器、`anim.js` 4.0KB 纯函数、`title.js` 8.5KB 地面挤出字）+ `cues.json`（120BPM，drop:6.0，pullback:7.75–8.75）。1920×1080 / 30fps / 10.000s，three.js + 正交相机 + 累积采样（SPP 16）。提示词原文用 `mg_style {action:"read",slug:"03-isometric"}` 取。

## 1. 一眼认出
1. 真等轴：`OrthographicCamera` 沿 `DIR=(1,1,1)` 看，立方体三条可见棱在屏幕上呈 2:1 斜率，没有一处透视收缩。
2. 12×12 的瓦片岛，瓦片顶面是奶白陶土 `#F1EEFA`，侧面才是彩色；空瓦片在冲击波经过时翻面。
3. 光很软：暖白主光 `#FFF3E6` + 淡紫半球光 `#C9BFF0`，阴影没有硬边（16 次子采样抖动出的面积光）。
4. 所有生长都是「底座先落 → 墙长 → 屋顶晚 0.375s 掉下来」，没有一处均匀缩放；收尾一定拉远成浮岛，标题平躺在等轴地面上。

## 2. 色板
| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 纸（背景） | `#EEEAFC` / `#DAD3F7` / `#C4BAEF` | `bgTop/bgMid/bgLow` 竖向渐变 |
| 地面点阵 | `#A79EE2` | `PAL.dot`，等轴地板的圆点 |
| 草 | `#94DFBD` `#8CDBB6` `#9DE3C4` `#86D6B0`，深 `#74CBA3` | 瓦片草坪 |
| 广场 / 路 | `#F4F1FD` `#ECE8FB` / `#8781D0`，标线 `#FBFAFF` | 环路与虚线 |
| 水/陶土 | `#8CC6FF` / `#F1EEFA` `#D0D4EE` | 水面瓦片与生长中的素模 |
| 点缀 | `#FFC4AC` `#A8D2FF` `#B7ECD6` `#D9D1FA` | 浮块与楼体 |
| 窗 | 灭 `#98ACEE`、亮 `#FFF0C8` | `winOff/winOn` |
| 数据青 | `#62F0F2` | 冲击波、数据流、ping |
| 墨 | `#2C2960` | 标注文字、CORE 主体 |
| 土层 | `#FFFFFF` → `#CBC3F3` → `#B2A8EC` → `#9F95E1` | `soil1–4` strata |

禁止色：纯黑 `#000000` 与高饱和红（最暖只到 `#FF9E86`）；阴影不要压到 20% 亮度以下，会失去棚拍感。

## 3. 字体与字排

**当前优先使用插件内置字体：** 英文标题使用 Unbounded，中文用 HarmonyOS Sans SC，数字和单位用 JetBrains Mono。参考帧中的 Unbounded 可变字体不一定与上游 800 静态实例完全一致。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。
- 上游：`Unbounded` 800（`ISOPOLIS`、数字）、`HarmonyOS Sans SC` 700/500（中文标签与标注卡）、`JetBrains Mono` 500（`CITY OS`、单位、EN 小标）。标题用 opentype.js 把 `assets/fonts/Unbounded-800-static.ttf` 读成 glyph 路径再挤出 3D。
- 替代：display `"Arial Black","Impact",sans-serif`；中文 `"Microsoft YaHei","PingFang SC",sans-serif`；等宽 `"Consolas","JetBrains Mono",monospace`。
- 损失：Unbounded 是超宽几何无衬线，Arial Black 窄约 12%、圆弧更钝，要 `letter-spacing:0.04em` 并 +8% 字号；HarmonyOS 700 比雅黑 700 更匀，中文标签会略挤；挤出字换字体就换了字面宽度，tracking 要重调。
- 字排：`ISOPOLIS` size 2.2、depth 0.36、bevel 0.035、tracking 0.035（世界单位）；副标走 canvas decal（4096×720）；mono 字距 0.12em。

## 4. 动效语法
- 120 BPM = 15 帧/拍；cues 走 1/16 秒网格（0.0625s = 1.875 帧），不要按整帧对齐。
- 缓动：`smoother` 是默认（`track()` 不传 ease 就用它）；道路 `easeOutCubic`；墙 `WALL = spring(tau,14.8,0.61)`（8 帧到峰、9% 过冲）；落体 `drop()`；pop `spring(tau,22,.42,v0=19)`。
- 禁用：linear 生长、任何 fov/透视变化、back 曲线用在墙高上（会穿模）。
- 签名动作：
 1. **瓦片波浪落下**（0.25–1.5s，6 个环）：`drop(tau,0.3,h0=2.2,rot0≈-1.4,bounce=.075)` —— 0.3s 下落、`y=h0(1-u²)`、旋转 `rot0(1-u)^2.2` 触地归零；落地 `sy=1-0.3*exp(-tau/.05)*cos(40tau)`，再两次微弹 0.16/0.10s。
 2. **楼房生长**（2.25–4.44s）：底板 0.1s 内 `scaleXZ 0.12→1` 落地，墙 `WALL(tau-1/30)` 弹到 1.09 再回，屋顶延 `roof_lag=0.375s` 用 `drop()` 扣上。
 3. **冲击波**（drop 6.0）：`PULSE_T=drop-0.015`，从 CORE 足迹 `r=1` 以 `pulse_speed=15` 向外；物体在 `hopPatch` 顶点着色器里抬一下，窗色与描边按 `flashDelay(x,z)` 延迟点亮、0.4s 后消失。
 4. **相机 Hermite**：三通道 `[t,value,'e']` 关键帧（`CAM.x/y/z`），x 0→-3.2→3.0→0.45→2.2→-5.75，z 3.1→1.72→1.0；drop 前 2% 反向预备、之后 `+6%` punch 两帧、12 帧 `easeOutExpo` 落回。
 5. **收尾拉远**（7.75–8.75s）：正交 zoom 1.8→1.0 露出浮岛；8.5s 标题板从地面长起，8.5625s 起字母每 0.0625s 一个，9.0s 定格。
- 网格：tile 0.955×0.34×0.955、间距 1.0、12×12；iso 面 `Scale(1,.866)` → `Shear(±30°)` → `Rotate(∓30°)`；z 序按画面 y；正交视高 VH=18，岛占 12。

## 5. Remotion 落地配方
这三条是**能力**，不是损失——用 `scene-kit/` 与 `render.samples` 实现；降级必须写进 STYLE.md（`偏离：累积 1×`）：
- `Accumulator` 的 16 次子渲染：改成同帧内 N 次 draw + 亚像素抖动（`render.samples`，等轴斜边建议 4–8），jitter 用 `det.ts` 的 Halton(2,3)，禁 `Math.random()`；累积缓冲用 `HalfFloatType`。判据：1:1 裁切里竖窗边阶梯 ≤2 级。
- `SSAOPass` / `UnrealBloomPass`：`three/addons` 后处理在场景里是**允许**的（`style-engine.js` 的 three 指引原文如此）。SSAO `kernelRadius` 8–12 世界单位；bloom `(resolution, 0.35–0.6, 0.4, 0.85)`；发光值 ≤0.9，禁纯白。
- grain + vignette：用 `look.tsx` 的 `<Grain>` / `<Vignette>`（feTurbulence 是确定性噪声，不消耗逐帧随机数）。
这些确实没法照搬，要换掉：
- `URLSearchParams` 的 v5/night 分支：全部变成 props（`variant: "day" | "night"`）。
- `document.fonts.load` + opentype.js 挤字：改用 OFL 字体直接排版（Unbounded 比 Arial Black 宽 12%，按这个调字号），或把标题预渲成 PNG 贴平面。
- `world.js` 80KB 手摆坐标：只留 `MAP` 的 12 行字符表与 `tx(i)=i-5.5 / tz(j)=j-5.5`，其余程序生成。
- 时间源：上游 `window.renderAt(t)` 是纯函数，没有 `requestAnimationFrame`/`Date.now()`；R3F 的 `useFrame` 也不能用（它不跟 Remotion 帧走），CSS `transition/animation` 不用，一切由 `useCurrentFrame()` 推。

```tsx
const FPS = 30;
const drop = (tau: number, h0 = 2.2, fall = 0.3) => {   // 上游 drop()：下落 + 落地压扁
  if (tau < 0) { const u = (tau + fall) / fall;
    return { y: h0 * (1 - u * u), rot: -1.4 * Math.pow(1 - u, 2.2), sy: 1, sxz: 1 }; }
  const sq = Math.exp(-tau / 0.05);
  return { y: 0.075 * Math.sin(Math.PI * Math.min(1, tau / 0.16)), rot: 0,
           sy: 1 - 0.3 * sq * Math.cos(tau * 40), sxz: 1 + 0.12 * sq * Math.cos(tau * 40) };
};

export const Isopolis: React.FC = () => {
  const f = useCurrentFrame(); const { fps, width, height } = useVideoConfig();
  const t = f / fps;
  const tiles = useMemo(() => TILES, []);                 // 12×12，tl 由 cues.sweep 铺开
  return (
    <ThreeCanvas width={width} height={height} orthographic
                 camera={{ position: [120, 120, 120], zoom: 100, near: 1, far: 400 }}>
      <color attach="background" args={["#EEEAFC"]} />
      <hemisphereLight args={["#F6F3FF", "#C9BFF0", 0.75]} />
      <directionalLight position={[-0.42, 1, 0.62]} intensity={2.25} color="#FFF3E6" castShadow />
      {tiles.map((tl) => { const d = drop(t - tl.tl);
        return <mesh key={tl.k} position={[tl.x, 0.17 + d.y, tl.z]} rotation={[0, 0, d.rot]}
                     scale={[d.sxz, d.sy, d.sxz]} castShadow receiveShadow>
          <boxGeometry args={[0.955, 0.34, 0.955]} />
          <meshStandardMaterial color={tl.col} roughness={0.82} />
        </mesh>; })}
    </ThreeCanvas>
  );
};
```
（`drop()` 同时给出高度、翻转、压扁；瓦片、楼、树、车共用它，全片手感都在这。）

## 6. 镜头结构模板
| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0.0–0.9 | 0–27 | 青色蓝图网格画出，相机 3.1 倍贴近 |
| 0.25–1.5 | 7–45 | 6 圈瓦片按 0.25s 间隔波浪落下，落地压扁 |
| 1.62–1.75 | 48–52 | 土层挤出 strata，道路 loop 画出 |
| 2.25–4.44 | 67–133 | 14 栋房、4 台风机、轻轨、市中心 12 栋生长，屋顶延后 0.375s |
| 4.625–5.75 | 139–172 | 车流出现、塔楼分段拔高、天线与光环 |
| 6.0–7.0 | 180–210 | drop：CORE 冲击波、6% punch、曝光 -0.15EV 预备 / +0.3EV 命中 || 6.25–7.7 | 187–231 | 4 架无人机、数据流、3 张标注卡 ENERGY/COMMUTE/DATA |
| 7.75–8.75 | 232–262 | 拉远 1.8→1.0，浮岛露出，青色 ping 追到岛影 |
| 8.5–10.0 | 255–300 | 标题板长起，字母每 0.0625s 一个，9.0 定格后 hold |

## 7. 坑
- 正交相机的 `zoom` 和 shadow camera 是两套：拉远时阴影相机仍按 ±20 裁剪，岛边会突然没影子。
- 等轴下不能靠 z 排序：透明瓦片/水面必须 `depthWrite:false` + 显式 `renderOrder`。
- `spring(tau,14.8,.61)` 有 9% 过冲，屋顶不等 `roof_lag=0.375s` 就扣会穿出墙顶。
- cues 是 1/16 秒网格（0.0625s=1.875 帧），用 `Math.round(t*30)` 取帧会让最后几个字母挤在一起。
## 8. 版权与素材
上游 `mg-styles-15` 为 MIT；`ISOPOLIS`、`CITY OS · 144 TILES · ONLINE` 都是虚构品牌，换掉再用。Unbounded、HarmonyOS Sans SC 与 JetBrains Mono 已随 DrawAI 内置；上游 800 静态字重与内置可变字体并非完全相同。背景渐变、点阵地板、浮岛阴影全是 shader 生成，没有位图。
