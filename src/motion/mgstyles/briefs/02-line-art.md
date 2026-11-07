上游：`demos/02-line-art/film.js`（47.0KB，Canvas2D 一笔画 + 一组隐藏 SVG 只为 `getTotalLength()` 采样）+ `demos/02-line-art/cues.json`（72BPM，1/8=0.4167s，fill:7.5，poster:7.8）。1920×1080 / 30fps / 10.000s。提示词原文用 `mg_style {action:"read",slug:"02-line-art"}` 取。

## 1. 一眼认出
1. 全片只有一根线，从地平线一路画到屋顶、浪、环、拱，中间不抬笔（`PIECES` 的 23 段首尾相接）。
2. 线宽在屏幕上恒定 4.5px（`?lw=4.5`，默认 3）、圆头圆角；越新越亮，新墨 `#FFF6DC`，旧线退到 40% 并偏成 `#967D50`。
3. 背景是 `#0B1320` 的深蓝夜，只有一层很淡的径向光晕、44 颗尘点，没有第二个光源。
4. 笔尖永远带一团暖白光晕，停顿那一下还会鼓一下。
5. 7.5s 时那根圆环从中心「胀」成金币，线转成面，表面有一道 1.5px 的斜高光。

## 2. 色板
| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 纸 / 夜 | `#0B1320` | `NAVY`，整幅 `fillRect` |
| 墨线 | `#E9D7A5` | `GOLD`，主线常态 |
| 旧线 | `#967D50` | `AGED`，`lineColor(b)` 在 b=0.4 时的端点 |
| 新墨 | `#FFF6DC` | `HOT`，刚画过 1.5s 内（b>1）向这里插值 |
| 币面 | `#F2E0AE` → `#DDC284`(42%) → `#CCAB6C`(70%) → `#A8874E` | 135° 线性渐变 |
| 斜面 | `#FFF6DC` / `#6E5428` | 1.5px 高光弧 + 1px 暗边 |

禁止色：任何高饱和色（红/品红/荧光绿）与纯白 `#FFFFFF`；最亮只到 `#FFF6DC`。

## 3. 字体与字排

**当前优先使用插件内置字体：** 拉丁标题使用 Cormorant Garamond，中文使用 Noto Serif SC；保留细字重与宽字距。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。
- 上游：`Cormorant Garamond` 500（`ATELIER LINEA`，50px，字距 0.46em）与 `Noto Serif SC` 300（「始于一线」26px，字距 0.5em）。两者都不在 Windows。
- 替代：display 用 `"Constantia","Cambria","Georgia",serif`；中文用 `"Source Han Serif SC","Noto Serif SC","SimSun",serif`；等宽 `"Consolas","JetBrains Mono",monospace`（片中未用）。
- 损失：Cormorant 的高对比 hairline 在 Windows 上没有等价物，Constantia 小写更宽更厚，要字号 -8%、字距加到 0.52em 才不散；`SimSun` 只有 Regular，300 的细衬线中文在 26px 以下会糊成一团。
- 字排：全大写 + 宽字距是这套的记号；逐字母从「散开」收拢（`spread=(1-e)*0.22*size*(i-mid)`，`stagger=0.045`），中轴对齐 (925,868)。

## 4. 动效语法
- 72 BPM，一拍 25 帧，1/8 = 12.5 帧；27 个 draw marker 都落在 0.4167s 的网格附近。
- 缓动：`easeIO = bezier(0.65,0,0.35,1)` 是签名（转角略减速）；`easeOut = (0.16,1,0.3,1)`；`easeSwell = (0.24,0.3,0.2,1)` 线转面；`easePulse = (0.45,0,0.2,1)` 回流脉冲。
- 禁用：back / elastic / spring —— 线不能过冲、笔尖不能倒退；也不能用 linear 画长段，会匀速得像机器。
- 签名动作：
 1. **连续落笔**：`headS(t)` 把时间经 `monotone()` 单调三次样条映射到弧长，笔头永远单调前进；采样步长 `STEP=0.5` 世界 px，`TOTAL` 是总弧长。
 2. **停顿标点**：重复 marker（roof 2.083→2.233、tower2 3.5→3.65、sky2 4.75→4.9）让笔停 0.15s；停顿前 0.133s 相机先刹车。
 3. **旧线衰减**：`b = FLOOR+(1-FLOOR)*(1-smooth(0.2,1.5,age))`，地景 `FLOOR=0.4`、logo 段 0.96；颜色随 b 从 `#E9D7A5` 移到 `#967D50`。
 4. **线转面**（7.5s）：evenodd 双圆，内圆 `ri = MR*(1-easeSwell(u))` 从 0 扩到 MR，0.367s 由环带填满成金币；`destination-out` 挖门洞。
 5. **相机追笔**：33 点高斯加权（σ=0.3、lead 0.08s）；zoom 5.8→1.1（对数样条），浪段有 `-0.016 rad` 侧倾。
- 网格：线宽 4.5px；起笔 taper 前 130 世界 px；字距 0.46em；构图围绕 (925,540)，标题 (925,868)，logo 中心 (925,392)。

## 5. Remotion 落地配方
必须换掉：
- `getTotalLength()/getPointAtLength()`：渲染时没有 SVG DOM 度量。用 `pathLength={1}` 归一化，`strokeDasharray="1 1"` + `strokeDashoffset={1-p}` 画进度；笔尖坐标改为构建期采样好的点表（`tools/dump_timing.mjs` 那套）。
- `ctx.filter='blur(16px)'` 三层离屏合成：改成三条同 `d` 的 path，`strokeWidth` 12/6/3、`opacity` 0.10/0.18/1。损失是没有真正高斯 bloom，叠加偏「贴纸」。
- `createConicGradient` 的币面光泽：用两条相交线性渐变 + 一条 `mix-blend-mode:screen` 的窄白条模拟 18° glint。
- 逐帧 `mulberry(f*7919+13)` 噪声：改成一张 `staticFile("grain.png")`，每帧 `translate` 由 `f` 决定。
- Canvas 2D 逐帧重绘整条线：换成静态 `<path>` + 只改 `strokeDashoffset`，不每帧重建 `d`；上游的 `renderAt(t)` 本身就是纯函数，没有 `requestAnimationFrame`/`Date.now()`，别加回去，CSS `transition/animation` 也不要用。
- `ctx.measureText` 排版：改成逐字母 `<span>` + `letterSpacing`，宽度不反算。

```tsx
const D = "M-160 740 L272 740 …";                 // 23 段拼成的单条 path，构建期生成
export const LineArt: React.FC = () => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const t = f / fps;
  const p = Math.min(1, t / 7.5);                  // draw 阶段：0→7.5s 画完
  const zoom = interpolate(t, [0, 0.22, 1.116, 2.533, 3.85, 5.135, 7.5, 10],
                              [5.8, 3.49, 2.8, 1.45, 1.3, 1.16, 1.46, 1.1]); // cues.zoom
  const tip = SAMPLE[Math.floor(p * (SAMPLE.length - 1))];   // 构建期采样的 [x,y]
  return (
    <AbsoluteFill style={{ background: "#0B1320" }}>
      <svg viewBox="0 0 1920 1080"
           style={{ transform: `scale(${zoom})`, transformOrigin: `${tip[0]}px ${tip[1]}px` }}>
        <path d={D} fill="none" stroke="#E9D7A5" strokeLinecap="round" pathLength={1}
              strokeWidth={4.5 / zoom} strokeDasharray="1 1" strokeDashoffset={1 - p} />
        <circle cx={tip[0]} cy={tip[1]} r={9 / zoom} fill="#FFF6DC" opacity={t < 7.5 ? 1 : 0} />
      </svg>
    </AbsoluteFill>
  );
};
```
（`p` 是这一镜唯一的进度；线宽写了 `/zoom`，所以镜头推拉不改变屏幕线宽。）

## 6. 镜头结构模板
| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0.0–0.7 | 0–21 | 一笔从左侧画进地平线，镜头贴到 5.8 倍，笔尖点亮 |
| 0.7–2.08 | 21–62 | 芽 → 三节枝 → 檐口，roof 处停 0.15s |
| 2.08–3.85 | 62–116 | 亭 → 塔 → 天际线，镜头退到 1.3 倍；建筑线直、植物线抖 |
| 3.85–5.14 | 116–154 | 地平线向右拉满 1600px，起浪的第一笔 |
| 5.14–6.46 | 154–194 | 浪 → 卷 → 抬升，镜头上摇并侧倾 -0.016 rad |
| 6.46–7.5 | 194–225 | 环 → 足 → 拱，镜头收紧到 1.46 倍，为填金预备 |
| 7.5–8.33 | 225–250 | 圆环胀成金币（0.367s），反向脉冲扫回起点，门洞挖出 |
| 8.33–9.25 | 250–278 | 字标逐字母收拢（0.045s），副标跟上 |
| 9.25–10.0 | 278–300 | 两侧各一条 24px 金线，暗角 + 噪点上满，末段 +3% 微推 |

## 7. 坑
- `getTotalLength()` 在 Remotion 的渲染环境里不存在，任何「运行时量路径」的写法都会直接抛错。
- 线宽不除 `zoom`，5.8 倍时是 26px 粗带，退到 1.1 倍又细成发丝。
- 旧线用 `opacity` 降会在 `#0B1320` 上变脏灰，必须换色到 `#967D50`（demo 的 `lineColor`）。
- 三层 blur 每帧跑三次全屏高斯，渲染会慢 3–5 倍，能用描边就别上 filter。
- 停顿用普通 `interpolate` 会回弹一下，必须保证「时间→弧长」单调（`monotone()` 的斜率限制）。

## 8. 版权与素材
上游 `mg-styles-15` 为 MIT；`ATELIER LINEA` 是虚构时装屋名，文案「始于一线」也不要照抄。Cormorant Garamond 与 Noto Serif SC 已随 DrawAI 内置（见第 3 节）。噪点图 `grain_fine_2048.png` 可通过 `motion_assets library` 搜索并导入，其上游许可尚未逐项明确；也可用工程自带 `builtin/grain.svg`。音乐按 72BPM 铺一条极简钢琴/弦乐，乐器采样是单音，需要自行编排。
