# 05-cel-boil · 逐帧手绘 / 线条沸腾

上游：`demos/05-cel-boil/js/scene.js`（117KB，2036 行 Canvas2D）+ `js/engine.js`（13.8KB，笔刷与 boil 引擎）+
`cues.json`（120BPM，`strike_start:0.333`，`burst:6.5`，`title_settle:8.5`）。1920×1080 / **24fps** / 10.000s。
`index.html` 只有一块 canvas；**`assets/` 整个不在仓库**：`scene.js:1327` 要 `paper_base.jpg`、
`paper_tooth.png`、`dust_ink_01..04.png`。提示词原文用 `mg_style {action:"read",slug:"05-cel-boil"}` 取。

## 1. 一眼认出

- **是一叠纸，不是一个背景**：`drawPaper` 把纸放大 1.045 铺满，`drawTooth` 再叠一层 multiply 的纸齿，
  位置按画号换：`ox=hs(v,51)*470`、`oy=hs(v,52)*310`。
- **线条每张画重抖一次**：`boil(pts, seed, amp=2.4, scale=70)` 用 simplex 噪声平移中线，seed 跟 drawing id
  走；`step===3` 时只循环 3 张（`bv(D)=D.id%3`），其余 4 张。
- **一拍二**：`SCHED` 11 段，开场 `[0,8,2]` 只有 4 张画，`[108,120,3]` 的 ta-da 是 3 帧一张。
- **手涂没对准**：`REG = {dx:-5, dy:4}`，填色层偏左 5px、偏下 4px，墨线压在上面。
- **可变宽墨线**：`outline(pts, wfn)` 把中线往两侧各推半个宽度；撇从 `W0*1.12` 收到 `W0*0.5`。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 纸（page） | `#f4e9d0` | `body` 底与 `PAL.cream`，占 60% 以上 |
| 纸白（surface） | `#fff6e2` | `PAL.hi`，高光与撕口 |
| 墨（text） | `#1c1613` | 所有线条、标题、落款 |
| 番茄（accent） | `#e5402b` | 火柴头、外焰、红圈、箭头 |
| 阳光（accent2） | `#ffc425` | 填色层主色（比墨线偏 5px） |
| 铅笔红（muted） | `#d9573f` | `PAL.pencil`，辅助线、阴影边缘 |

`theme.ts`：`page`→`#f4e9d0`，`text`→`#1c1613`，`accent`→`#e5402b`；另两色是这套画具的固定颜料。

**禁止色**：任何冷色（蓝/青/紫），连阴影都不许用蓝灰；纯白 `#fff` 也不行，最亮只到 `#fff6e2`。

## 3. 字体与字排

**当前优先使用插件内置字体：** 中文用 LXGW Marker Gothic 或 Long Cang，英文手写用 Caveat；原片中手绘路径标题仍应按路径实现，不用字体冒充。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

**标题「手作」不是字体**：`CHAR_SHOU` 4 笔 + `CHAR_ZUO` 7 笔，每笔是中线的点列（unit 空间 0..1，y 向下），
分 `h` 横 / `v` 竖 / `p` 撇 / `g` 竖钩；`TITLE = {cx:960, cy:440, S:352, gap:18}`，两字转 `-0.045` / `+0.035`
rad、错 ±8px。宽度由 `strokeWidth(k,u,W0)` 给：撇 `W0*(1.12-0.62u^1.4)`，钩在 `u>0.8` 后收到 0.5 倍。
**这条必须照搬**，换成字体就变成字幕。

字幕用 `'64px "LXGW Marker Gothic"'`、`'600 42px "Caveat"'`、`'400 86px "Long Cang"'`。替代：
拉丁 `'"Ink Free","Segoe Script",cursive'`；中文 `'"KaiTi","STKaiti","Microsoft YaHei",serif'`。
损失：Ink Free 是等宽单线，没有 Caveat 的笔压与连笔；楷体是印刷楷，等粗、有顿笔，字面还小一号（字号 +6%）。

## 4. 动效语法

- **节拍**：一拍 = 12 帧，16 分 = 3 帧，`bar_anchor:0.5`。`exposure` 表把每段标成 on 1s / 2s / 3s ——
  先定「每张画几帧」，再谈运动。
- **缓动只在一张画内部**：`E.out2` 管镜头推拉与贴纸滑入；线条 boil 是**阶跃**，没有插值。
- 签名动作：
  1. **擦火柴**（`strike_start:0.333`）：`strike_scrape:[0.333,0.458]` 只有 3 帧，线拉长 150–300% 只留 1 帧；
     `ignite:0.5` 火焰出现，`match_land:1.0` 才落稳。
  2. **醒**（1.0–2.0，on 2s）：`eyes_open:1.25`、`blink:1.417`、`look_left:1.5`、`look_right:1.667` 全在
     16 分上，每 3 帧换视线；`crouch:1.75` 是起跳前的 squash。
  3. **跳**（`jump:2.0`→`land:2.5`）：12 帧，离地 3 帧到顶，落地 2 帧压到 `sy 0.92`，下一张弹回 1.04。
  4. **舞**（2.5–4.5）：`hops:[3.0,3.5,4.0]` 每拍一跳，`twirl:[3.75,4.0]` 半圈，`shimmy:[4.083,4.25,4.417]`
     在 16 分上左右摆 6px；`tada:4.5` 定格成 on 3s。
  5. **爆 + 重组成字**（6.25–8.5）：`squash:6.25` → `burst:6.5` → `impact_frames:[6.5,6.542]` 两帧反白 →
     `box_blown:6.583` → 11 段 `strokes`（7.25 起每 3 帧一笔）→ `title_settle:8.5`。
- **组成规则**：舞台 `STAGE={s:1.4, X:960, Y:1002}`；相机切点 f12/30/48/60/108/132（`CLOSE 2.6` →
  `WAKE 1.75` → `STAGE` → `LOW 1.5` → `MED 2.05`）；安全边距 60px；图层：纸 → 大形色块 → 墨线 →
  填色（-5,+4）→ 高光 → tooth/dust 顶层。

## 5. Remotion 落地配方

**引擎与上游一致：Canvas2D 逐帧重画。** 上游 `js/engine.js` 就是 `getContext("2d")` 每帧清屏重画
（`drawPaper` / `drawTooth` / `outline` 全在 2D 画布上）；移植也走同一条路，**不要换成 SVG `<path>` 或
DOM 拼贴**——那不是逐帧绘制，`stroke-width` 沿路径不能变，可变宽墨线会退化成等粗描线。
确实要换，在 `STYLE.md` 写一行「偏离：引擎 canvas2d 改为 …，因为 …」，渲染会带 warning 通过。

必须换掉的六处：
1. `requestAnimationFrame` → `frame`；`Math.random()` → `hs()` / `mulberry32(seed)`；`Date.now()` 删掉。
2. **驱动用 `drawing(f).fq`，不是 `f`**：一拍二要求每帧回到「这张画的起始帧」重画，拿 `f` 会一帧画两遍、
   hold 段变成 24fps 抖。
3. **CSS `transition`/`animation` 全禁**：会在 24fps 之间插出平滑假帧，一拍二立刻消失。
4. 纸纹/尘土（不在仓库）→ 256px 噪声 tile + `mixBlendMode:'multiply'`、opacity 0.12；`scene-kit/look.tsx`
   的 `<Grain seed={D.id} />` 就是这块，seed 随画号换。损失：没有真实纤维的断续走向，特写会「太干净」。
5. 线宽：Canvas 的 `lineWidth` 也不能沿路径插值 → 按上游 `outline(pts, wfn)` 的意思**逐段**改宽度
   （撇 `W0*(1.12-0.62u^1.4)`），圆头圆角接起来；偷懒叠两遍 stroke（0.9 粗 + 0.6 细）收笔处会露馅。
6. `motionBlur.samples:1` 等于没有；smear 是手画的一帧拉伸，不是后期模糊。

```tsx
const SCHED: [number, number, number][] = [[0,8,2],[8,24,1],[24,48,2],[48,60,1],[60,108,2],
  [108,120,3],[120,132,2],[132,168,1],[168,224,2],[224,230,1],[230,240,3]];
const drawing = (f: number) => { let id = 0;
  for (const [a, b, s] of SCHED) {
    if (f >= b) { id += Math.ceil((b - a) / s); continue; }
    const k = Math.floor((f - a) / s); return {fq: a + k * s, id: id + k, step: s};
  } return {fq: 239, id, step: 3};
};
const wob = (pts: [number, number][], seed: number, amp = 2.4) => pts.map(([x, y]) => [
  x + amp * Math.sin(x * 0.014 + y * 0.006 + seed * 2.1) * Math.cos(y * 0.011 - seed * 1.3),
  y + amp * Math.cos(x * 0.009 - y * 0.013 + seed * 1.7),
]);
// 一笔：中线点列 → 逐段收窄的墨线（上游 outline 的意思）；ctx 已经按舞台平移过
const ink = (ctx: CanvasRenderingContext2D, pts: [number, number][], seed: number, w: number, color: string) => {
  const P = wob(pts, seed);
  ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 1; i < P.length; i++) {
    const u = i / (P.length - 1);
    ctx.lineWidth = w * (1.12 - 0.62 * Math.pow(u, 1.4));   // 撇：1.12 → 0.5
    ctx.beginPath(); ctx.moveTo(P[i - 1][0], P[i - 1][1]); ctx.lineTo(P[i][0], P[i][1]); ctx.stroke();
  }
};
export const HandMade = () => {
  const f = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const D = drawing(f);                     // 真正的时间是 D.fq，不是 f
    const seed = D.id * 0.37 + 1;             // 同一张画内所有笔画共用一个 boil seed
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#f4e9d0'; ctx.fillRect(0, 0, 1920, 1080);
    ctx.translate(960, 440);                  // 舞台
    ctx.save(); ctx.translate(-5, 4);         // 填色层先画、偏 (-5,+4)
    ink(ctx, [[-330, 0], [0, -40], [330, 0]], seed, 58, '#ffc425');
    ctx.restore();
    ink(ctx, [[-330, 0], [0, -40], [330, 0]], seed, 58, '#1c1613');
    ink(ctx, [[0, -300], [0, 300]], seed + 1, 46, '#1c1613');
  }, [f]);
  return <>
    <canvas ref={ref} width={1920} height={1080}
      style={{ position: 'absolute', inset: 0, width: 1920, height: 1080 }} />
    <Grain seed={drawing(f).id} opacity={0.12} />   {/* 纸齿：按画号换 seed，别按 f */}
  </>;
};
```

`useRef` / `useLayoutEffect` 从 `react` 取，`Grain` 从 `./scene-kit/look` 取。`useLayoutEffect` 在浏览器 paint 之前就画完，Remotion 截帧才拿得到；写在 `useEffect` 里可能截到空画布。

填色层：同一组笔画再画一遍，`#ffc425`、`translate(-5, 4)`、压在墨线下面（`REG = {dx:-5, dy:4}`）。

## 6. 镜头结构模板

| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0.0–0.333 | 0–8 | 火柴躺在盒侧，2 帧一张，只有呼吸 |
| 0.333–1.0 | 8–24 | 擦：3 帧 smear + 翻转，on 1s |
| 1.0–2.0 | 24–48 | 睁眼、眨眼、左右看、下蹲，全在 16 分上 |
| 2.0–2.5 | 48–60 | 跳：一拍一，12 帧一个起落 |
| 2.5–4.5 | 60–108 | 跳舞，每拍一个 hop；LOW 机位压到 1.5 |
| 4.5–5.0 | 108–120 | ta-da 定格，on 3s |
| 5.0–6.5 | 120–156 | 二次弹跳 → 蓄力旋转 → 压扁 |
| 6.5–7.25 | 156–174 | 两帧反白 + 冲击框，然后烟团/火星/速度线 |
| 7.25–8.5 | 174–204 | 11 段笔画重组成「手作」 |
| 8.5–10.0 | 204–240 | 落款 → 回拉到 84% → 翻纸 → 眨眼，on 3s |

## 7. 坑

- 一拍二不是「每 2 帧取整」，是 `drawing(f).fq` 回到这张画的起始帧；镜头仍按 `f` 算，混用才抖得对。
- 拿 `f` 而不是 `D.id` 当 boil seed，hold 段会变成 24fps 抖，节奏全散。
- 填色偏移是**屏幕**像素：特写 `s=2.6` 时不除 scale 会错位 13px（`GLOBAL.amp`/`GLOBAL.ink` 管这个）。
- 纸纹每张画换位置，否则看起来是「一张纸」而不是「一叠纸」。
- 拿 SVG `<path>` 代替 canvas = 换成 DOM 描线：hold 段虽说不抖（`d` 由 `D.id` 决定），但等粗墨线一眼就假，
  而且 `motion_render` 的引擎扫描会点名「canvas2d 缺席」（warning）。要保引擎保真就用 `<canvas>`。
- `strokes` 落在 `7.25 + 0.125k`，正好 3 帧一笔；一帧一笔会糊成一坨。
- 标题换成字体 = 放弃这个风格；`CHAR_*` 的笔画顺序与粗细剖面是这份片子的身份证。

## 8. 版权与素材

上游 MIT。`LXGW Marker Gothic`、`Caveat`、`Long Cang` 已随 DrawAI 内置；火柴盒、火焰精灵、
「手作」字样是这个 demo 自己的角色与文案，客户项目里要换；星爆、烟团、速度线、反白冲击框是通用漫画
语汇。纸纹自己拍/扫或用 `feTurbulence` 生成，别抓别人的扫描件。
