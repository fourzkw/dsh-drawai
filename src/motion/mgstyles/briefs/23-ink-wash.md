# 水墨写意 · 23-ink-wash

> 上游 `huashu-art-motion`（MIT）17_ink 的移植说明。上游是「HTML 页 + renderAt(t) + Playwright 截帧」，
> 这里是「Remotion 场景逐帧渲染」。同构点只有一个：每一帧都是 t 的纯函数。其余全要换。

## 1. 一眼认出

- **纸接着画**：整幅只有一种底 —— `#EFE6D0` 宣纸，叠 2600 根纸纤维短弧（褐 α.05–.13 / 亮 α.12–.27）+ 四角暗角 α.22。画面里不出现纯白卡片、不出现纯黑。
- **每一笔都是毛笔**：控制点先 Catmull-Rom 加密，再按 **4px 等弧长重采样**（`demos/23-ink-wash/brush.js` 的 `P.brush`）。宽度按 `prof(q)=ss(0,head,q)·(1−0.7·ss(1−tail,1,q))·(0.85+0.15·noise)`，笔尾比笔头细 30–50%，笔毛按噪声断开露出纸。
- **墨只有一个颜色**：`[16,14,12]`，靠 `tone` 分五色（焦 .9 / 浓 .8 / 重 .6 / 淡 .35 / 清 .15）。全片第二个「黑」一旦出现，立刻不像水墨。
- **晕染是两遍 multiply**：外晕 `blur(halo·(0.4+grow))`、α `haloA·grow`；本体 `blur(blur·(1.6−0.6·grow))`、α `ss(0,0.6,grow)`。`grow` 0→1 是「墨在纸上洇开」，不是透明度淡入。
- **留白是挖出来的**：白色部分（猫的口鼻胸爪、交领内衫）用 `destination-out` 从色层里挖掉露出纸色，不是画白色。
- **收尾有一方印**：0.3–0.4s 内从 1.5 倍压到 1 倍，`multiply` 盖上，印面随机挖 40 个 1–4px 的斑驳。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 纸 `PAPER` | `#EFE6D0` | 整幅底；雾带用小一号的 `#F2EAD6` |
| 留白 `SURFACE` | `#F7F1E2` | 面部、白瓷、内衫（挖出来的地方偏亮一点） |
| 墨 `INK` | `#14120F` | 所有线；按 tone 分五色，不新增墨色 |
| 次色 `FIELD` | `#6F8AA0` | 花青：衣、远山冷部 |
| 灰 `DUST` | `#8A7C64` | 淡墨字、纸边、题款 |
| 朱 `STAMP` | `#C4281E` | **只三处**：钤印、腰带、点唇 |
| 暖点 | `#D8553F` / `#C47A3C` / `#E2AA34` | 朱日 / 赭石（猫） / 藤黄（发、光） |

**禁止色**：`#FFFFFF`、`#000000`、任何饱和度 > 0.6 的蓝紫。要让一块区域「亮」就用纸色，不要提亮到白。
**禁止手法**：给笔画加 `box-shadow`、`text-shadow`、CSS 渐变描边；那是排版，不是墨。

## 3. 字体与字排

上游用 `LXGWWenKai-500`（霞鹜文楷）。**当前优先使用插件内置字体**，替代栈：

- 标题 / 题款：`"Long Cang","Noto Serif SC",serif` —— 龙藏体是行草连笔，起收有粗细变化，接近毛笔题字。
  损失：龙藏体骨架偏软，写「永」「之」这类字时折笔没有楷书的骨力；要更端正就用 Noto Serif SC。
- 正文 / 旁白：`"Noto Serif SC","HarmonyOS Sans SC",serif` —— 宋体本身就是刻本的骨架，和宣纸同源。
- 数字 / 年份：`"IBM Plex Mono",monospace`，字距 +0.04em。

字排规则：标题 72–96px、字距 6px；副题 28–32px、`DUST` 色；**标题允许竖排**（`writing-mode: vertical-rl`，从上到下、从右到左），竖排时右起第一列就是主标题。
小字别用 Long Cang：它的细笔画在 4K 下会断成虚线，18px 以下一律 Noto Serif SC。
中英混排时英文降到 0.92 倍字号、基线对齐，不要用斜体（行草里没有假斜体）。

## 4. 动效语法

- **节拍**：60 BPM，30fps 下 **30 帧/拍**。水墨没有硬切，全片是一镜到底的呼吸，`cutFrames` 只用来对齐段落。
- **缓动**：只用 `smoothstep`（`ss(a,b,x)`）与 `easeOutCubic`。**禁用** `spring` / `back` / 任何 overshoot —— 墨落在纸上不会回弹。
- **签名动作**（帧数按 30fps）：
  1. **写出**：`reveal = ss(d, d+l, lt/0.45)`，每笔自带起点 `d` 与时长 `l`（0.08–0.18s），按「窗 → 案 → 竹 → 鸟 → 猫 → 人」的顺序错峰；开场先把 `lt` 加 0.12，**第 0 帧就要有前几笔**。
  2. **洇开**：`grow = ss(0, 1.15, lt)`；外晕跟着 grow 变宽，本体跟着收紧 —— 一个变宽一个变实，缺一个就读成「模糊一遍就完事」。
  3. **摇曳**：竹绕基点摆 `sin(2.9t)·0.11`，越往梢越大（系数 `k = 节点序 / 4`）；叶翻 `sin(7t+g)·0.2`。
  4. **雾带**：4 条纸色椭圆，`blur(14px)`、α.72，以 150–270px/s 横移，绕一圈回来 —— 远山靠它「时隐时现」。
  5. **压印**：`s = 1.5 − 0.5·easeOutCubic(q)`，`q = ss(0.3, 0.4, lt)`；同时 `globalCompositeOperation='multiply'`。
- **组成规则**：纸满幅；图层顺序固定为 纸 → 远山/朱日 → 雾带 → 静态笔触 → 竹 → 挂轴 → 动物 → 人物 → 热气 → 题款/印；四周留 6% 白边；**一屏只画一个「房间」**，水墨的空间感靠留白不靠透视。

## 5. Remotion 落地配方

**组件形态**：一个 `<canvas>` 铺满 `AbsoluteFill`，`useLayoutEffect` 里按 `frame` 重画。Remotion 会为每一帧重新执行 effect，函数必须幂等：不读时钟、不留上一帧状态、不累加。

**必须换掉的上游写法**

| 上游 | 这里 |
| --- | --- |
| `requestAnimationFrame` / `draw(c, lt, t)` 主循环 | `const frame = useCurrentFrame()`；`t = frame / fps`、`lt = t / duration` |
| `U.rng(seed)` 种子随机 | `det(frame, salt, i)`（`scene-kit/det.ts`），或本文件里的 `hash()` |
| `P.cached(key, w, h, fn)` | 模块级 `Map<string, HTMLCanvasElement>`；key 带分辨率 |
| `P.texture('xuan', …)` 外部贴图 | 程序化纸：`feTurbulence` 转图，或直接画 2600 根短弧（推荐，路径可控） |
| `ctx.filter='blur()'` 循环调用 | 可用（Chromium 支持），但每帧多次 blur 很贵：晕染层做成 offscreen，只有 `grow` 变化的量重画 |
| CSS transition / animation | 一律算出每帧的数值，写进 canvas |
| `Math.random()` | 禁；用 `det`，否则 motion_qa 的「同一帧两次渲染不一致」会抓到你 |

**性能预算**：纸 2600 根弧 ≈ 12–18ms，只画一次；静态笔触 15 笔 × 8 根笔毛 × ~120 采样点 ≈ 每帧 2 万次 `lineTo`，**必须缓存**成 `ink_static` 位图（写出阶段才逐帧画）；剩下每帧真正动的只有竹、雾带、虾、猫的呼吸、热气 —— 控制在 8ms 内。

**骨架**（可跑；`inkBrush` 就是 `demos/23-ink-wash/brush.js` 的 `P.brush`，把 `rng`→`det`、`ss`→上面的 smoothstep 即可）：

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { useLayoutEffect, useRef } from 'react'
import { PAPER, INK, STAMP } from './theme'
import { inkBrush, inkLeaf, inkWash } from './ink'

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export default function Scene({ shot }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { width, height, fps, durationInFrames } = useVideoConfig()
  const frame = useCurrentFrame()
  useLayoutEffect(() => {
    const c = ref.current!.getContext('2d')!
    const t = frame / fps, lt = frame / durationInFrames + 0.12
    const grow = ss(0, 1.15, lt), rev = Math.min(1, lt / 0.45)
    c.clearRect(0, 0, width, height)
    c.drawImage(paper(width, height), 0, 0)                                   // 宣纸：模块级缓存
    inkWash(c, 'mtn', ss(0, 0.3, lt) * (0.6 + 0.4 * grow), g => mountains(g, width), { blur: 3, halo: 14, haloA: 0.3 })
    if (rev < 1) staticStrokes(c, width, rev) else c.drawImage(staticCache(width), 0, 0)
    bamboo(c, width, height, t, rev)
    inkLeaf(c, width * 0.31, height * 0.21, -0.5 + Math.sin(t * 7) * 0.2, 104, 15, 0.86)   // 一片竹叶也要走毛笔
  }, [frame, width, height, fps, durationInFrames])
  return <AbsoluteFill style={{ background: PAPER }}><canvas ref={ref} width={width} height={height} /></AbsoluteFill>
}

// 笔毛：每根一条连续折线，按噪声断开 —— 飞白就是断口露出的纸
function bristles(c: CanvasRenderingContext2D, d: Pt[], n: number, w: number, dry: number, salt: number) {
  for (let k = 0; k < n; k++) {
    c.beginPath(); let on = false
    const off = (k / (n - 1) - 0.5) * 0.95 * w
    for (let i = 0; i < d.length; i++) {
      const q = i / (d.length - 1)
      const vis = hash(salt * 31 + k * 7919 + i * 0.09) > dry * Math.pow(q, 1.2) * 0.95 + 0.05
      const x = d[i][0] + off, y = d[i][1]
      if (vis) { on ? c.lineTo(x, y) : c.moveTo(x, y); on = true } else on = false
    }
    c.stroke()
  }
}
```

`ink.ts` 里放纯函数（无 React、无 DOM 查询），这样 `motion_preview` 失败时能单独在 Node 里跑那 30 行算法定位。

## 6. 镜头结构模板

| 时间 | 意图 |
| --- | --- |
| 0–0.1s | **有东西可看**：第 0 帧已有窗框两笔 + 一片竹叶（白纸首帧不能当封面） |
| 0.1–0.45s | 写出主体：按窗 → 案 → 竹 → 主体的顺序，每笔 0.08–0.18s，错峰 0.02–0.04s |
| 0.45–1.2s | 墨继续洇开（grow 走完），雾带开始横移，主体第一次呼吸 |
| 1.2–2.4s | 主体的小动作（动物眨眼/尾巴、衣带摆 3.4s 周期），竹持续摇曳 |
| 2.4–3.2s | 需要的话补第二层：热气、飘落物、第二只动物；**不换机位** |
| 3.2–3.8s | 题款 + 钤印压下去（1.5→1 倍），画面其余部分开始安静 |
| 3.8–4.0s | 定格 0.2s 收尾；最后 6 帧不要再加新笔（观众要看清那方印） |

要 10 秒就把 1.2–3.2s 拉长，别加镜头；要 6 秒就砍到「写出 + 洇开 + 印」。

## 7. 坑

- **multiply 透底**：晕染是透明叠加，背后的窗台墨线会透过猫的耳朵、桌腿会透过衣裙，读成「层级错了」。上色前先在剪影里 `clip` 后 `drawImage(纸)` 补一层纸色 —— 等于「先为它留出这块地方」。
- **笔毛接头**：按小段单独 `stroke` + `round` cap，接头处会叠出一节节深点，像竹节或麻绳。每根笔毛必须一条连续 path、`butt` cap。
- **低动画面**：全片都是缓慢晕染时，`motion_qa` 的「整镜动能量」会报 warn（它抓的正是翻页感）。解法是保证每 2 秒有一次可见变化：雾带过境、竹梢一摆、虾游一段 —— 不是加特效。
- **缓存泄漏**：纸和静态笔触的缓存 key 必须带分辨率；换竖版 1080×1920 时复用横版位图会整片糊。
- **字体回落**：Long Cang 没有的简体字会回落到 Noto Serif SC，同一行里两种骨力会看得出来；标题先试排一遍，缺字就整句改用 Noto Serif SC。
- **细线 shimmer**：1px 笔毛在缩放/编码后闪烁，`det` 抖动控制在 ±0.4px 以内，别用亚像素随机。

## 8. 版权与素材

- 上游 `huashu-art-motion` 为 MIT；本风格的提示词整理、场景源码节选与笔刷库均随插件分发，保留出处即可。
- 笔法（飞白、没骨、晕染、钤印）、墨分五色、母题动法（写出、洇开、摇曳）是公共技法，可自由用。
- **不要复刻具体作品**：齐白石的虾、八大山人的白眼鸟是具体画面，可以借「六节虾身 + 焦墨头胸甲」的画法，不要连构图和姿态一起搬。
- 字体 Long Cang / Noto Serif SC 均为 SIL OFL，可随包分发；品牌名、印章文字必须虚构（别写真人的名号）。
