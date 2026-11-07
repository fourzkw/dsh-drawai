# 06-collage · 拼贴剪贴 / NOGGIN

上游：`demos/06-collage/index.html`（66.5KB，889 行，**全部内联 Canvas2D**）+ `assets/gen/layout.json`（16 张抠图的
尺寸与铰链点）+ `cues.json`（90BPM，`pop:4.0`，`tear:7.5`）。1920×1080 / **30fps 渲染但只走 12fps 网格** / 10.000s。
片子专用 `assets/gen/*.png`（16 张）、`page_kraft.jpg`、`page_red.jpg` 未收录；共享的
`grain/washi/dust` 纹理可在 `motion_assets library` 搜索并导入；来源信息记录于素材清单。提示词原文用 `mg_style {action:"read",slug:"06-collage"}` 取。

## 1. 一眼认出

- **运动是 12fps 的，不是 30**：`K(t)=Math.floor(t*12+1e-4)`，所有位移/角度先落到 `Q(t)=K/12` 再取整；
  30/12=2.5 帧一步，所以实际是 2 帧、3 帧交替。
- **每个元素自己会抖**：`jit(id,t,amp=2)` 给 x/y ±2px、rot ±0.4°；不动的元素 `boil(false)` 降到 6fps、±1.1px。
- **白描边是「剪」出来的**：`rimmed(img,r)` 沿半径 3.5px 的圆画 28 遍再 `source-in` 填 `#F4EFE4`，不是 stroke。
- **要么拍上去要么贴上去**：`slap(t,t0,pre=3)` 前 3 步放大到 1.38 且 `lift` 到 1，落点过冲 0.972，再回弹 1.01。
- **影子是纸的影子**：`shadow(c,lift)` 的 blur `5+34*lift`、offset `3+24*lift`、alpha `0.36+0.08*lift`。

## 2. 色板

| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 纸（page） | `#F2ECDF` | 剪贴块的纸白、`cutQuad` 的底 |
| 版心纸（surface） | `#EFE8DA` | `tornStrip(900,250,53,16)` 的刊头、圆章 |
| 牛皮（field） | `#E3CFAE` | `page_kraft.jpg` 的底色，整张底 |
| 墨（text） | `#16130F` | 所有字、撕边、胶带下的暗部 |
| 脏金（muted） | `#7A5516` | 旧报纸的泛黄区、半调暗部 |
| 印刷红（accent） | `#D2261C` | 红圆盘、`PAT.red`、NOGGIN 的 A |
| 撕口（border） | `#C4A077` | 卷边背面的纸芯 |

`theme.ts`：`page`→`#F2ECDF`，`text`→`#16130F`，`accent`→`#D2261C`，`field`→`#E3CFAE`；`#3F6FA8` 只给太空楔形的地球边缘。

**禁止色**：任何高饱和的冷光/霓虹（青、品红、荧光绿）—— 这套片子只有油墨四色 + 纸。

## 3. 字体与字排

**当前优先使用插件内置字体：** 英文大标题用 Anton，章印小字可用 Bebas Neue，中文使用 Noto Serif SC；Alimama ShuHeiTi 未内置，需粗黑时可选 Noto Sans SC。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。

原片：`'400 124px "Anton"'`（构成主义斜带）、`'400 238px "Anton"'`（NOGGIN 刊头）、`'900 132px "Noto Serif SC"'`
（脑洞季刊）、`'700 190px "Alimama ShuHeiTi"'`（四个 212×212 的字块）、`'500 19px "IBM Plex Mono"'` 加
`letterSpacing 3px`（kicker）、`'400 22px "Bebas Neue"'`（圆章小字）。
DrawAI 替代：
- Anton → `'"Arial Black","Impact",sans-serif'`；Bebas → `'"Impact","Arial Narrow",sans-serif'`。
- 中文重黑 → `'"Microsoft YaHei","PingFang SC",sans-serif'` 700；宋体 → `'"SimSun","STSong",serif'` 900。
- mono → `'"Consolas","JetBrains Mono",monospace'`。
- 损失：Arial Black 比 Anton 宽 ~8%，124px 的长句要收到 108px 才不撞边；Impact 没有 Bebas 的几何骨架；
  雅还没有 Alimama 的字面厚度，190px 会显空；SimSun 没有 900 字重，合成粗体把笔画糊死。
  `letterSpacing` 3px 在 Consolas 上要减到 2px。

## 4. 动效语法

- **节拍**：90BPM，一拍 = 20 帧，16 分 = 5 帧；视觉网格 12fps（2.5 帧/step）。两套网格只在 0.5s 公倍，
  `cues.json` 的事件都是两边同时对齐的（`hero:[6.667,6.833,7.0,7.167]` 就是每 1/6s 一块字）。
- **缓动**：`eOut = 1-(1-x)^3`、`eIO` 三次；但多数动作不是缓动，是**阶跃** —— 12fps 上只有 3–4 个姿态。
- 签名动作：
  1. **大手把肖像拍上来**（`slap_portrait:0.333`、`slap_circle:0.667`、`slap_news:1.0`）：`IN` 四档
     `[1100,-100]→[560,-50]→[200,-18]→[40,-4]`，每档一个 1/12s；落定那一步 `sqx 1.02 / sqy 0.96 / y+=14`。
  2. **颌骨分段**（`jaw:[1.333,1.667,2.0]`）：`jaw` 取 `[0.5,1,0.5,0]` 的最大值 → 下颌骨绕
     `jaw_hinge:[372.75,470.5]` 转 `-1.6°`，嘴用 2–3 张替换帧（不是变形）。
  3. **开盖**（`pop:4.0`）：`LIDF` 四档 `[-70,10,-230]`、`[-200,-30,-660]`、`[-300,-70,-700]`、`[-385,-40,-300]`
     （角度/位移/抬起），静止角 `-95°`；`lid_land:4.333` 后有 5% 回弹（`1+0.05*(1-eOut(...))`）。
  4. **一件件拍进画面**（`rocket:4.333`、`earth:4.667`、`birds:5.0`、`roses:5.333`、`butterflies:5.5`、
     `manicules:6.0`）：每件都走 `slap`，间隔 1–3 个 step，`lift` 制造「手还没走」的悬空感。
  5. **撕 + 卷**（`tear:[7.5,7.667,8.167]`）：90 点撕裂线 `x` 从 1190 移到 770，叠
     `sin(u*9.1+1.3)*22 + sin(u*31+0.4)*8`；`fmap(d,R)= d<=πR ? R*sin(d/R) : πR-d` 把弧长换成卷边高度，
     `R` 四档 70/110/130/130。
- **组成规则**：`cam` 基准 `z=1, px=845, py=560`，pop 冲拳 `z 1.11→1.075→1.056→1.05`、`cx [12,-8,3,0]`；
  图层固定为 纸纹 → 大色块/红圆盘 → 照片剪影 → 胶带/涂鸦 → 颗粒；版心 90px，但刊头故意让印刷头像
  出血 120px（`RX=1490, RS=0.60`）。

## 5. Remotion 落地配方

必须换掉的六处：
1. `c.drawImage` 逐帧 → `<Img src={staticFile('portrait.png')}>` + 每帧算 `transform`；白描边用 8 向偏移复制
   再叠一层同色 `filter: drop-shadow` 四向，**不要**真的画 28 遍。
2. `requestAnimationFrame` → `frame`；`hash()` 是 imul 确定性哈希，可原样保留；`Math.random()` 一律换掉。
3. CSS `transition`/`animation` 禁；静态 `filter` 可以留。
4. 12fps 阶梯：`K(f)=Math.floor(f*12/30+1e-4)`，**别用 `Math.round`**（2.5 帧的交替会被抹成 15fps）。
5. 按许可选择内置颗粒/胶带纹理，或用 `feTurbulence` + `feColorMatrix` 做 256px tile，`mixBlendMode:'overlay'` opacity 0.26，
   每 2 个 step 换偏移 `-hash(k,1)*120, -hash(k,2)*900`（`finish()` 就是这么干的）；半调网点用
   `radial-gradient(circle, #16130F 1.4px, transparent 1.6px)` 4px tile。损失：真半调的网点半径随亮度变，
   平铺网点不会，暗部是「发灰」而不是「发黑」。
6. 翻页/卷边没有便宜的 CSS 3D 替代 → SVG `<path>` 打 4 档形变 + 6px `#EFE7D6` 亮边 + `#C4A077` 背面；
   损失：没有真正的透视缩短，大角度会「软」。

```tsx
const hash = (a: number, b = 0) => {           // 上游同款，可确定性复现
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15; return (h >>> 0) / 4294967296;
};
const K = (f: number) => Math.floor((f * 12) / 30 + 1e-4);        // 12fps 网格
const ks = (f: number, t0: number) => K(f) - Math.round(t0 * 12);
const jit = (id: number, f: number, amp = 2, fps = 12) => {
  const k = Math.floor((f * fps) / 30);
  return {x: (hash(id, k) * 2 - 1) * amp, y: (hash(id + 71, k) * 2 - 1) * amp,
          rot: (hash(id + 913, k) * 2 - 1) * amp * 0.2};
};
const slap = (f: number, t0: number, pre = 3) => {
  const k = ks(f, t0);
  if (k < -pre) return null;
  if (k < 0) { const u = -k / pre; return {s: 1 + 0.38 * u * u + 0.05 * u, lift: u, sqy: 1}; }
  if (k === 0) return {s: 0.972, lift: 0, sqy: 0.96};
  return k === 1 ? {s: 1.01, lift: 0.03, sqy: 1} : {s: 1, lift: 0, sqy: 1};
};
export const Collage = () => {
  const f = useCurrentFrame();
  const p = slap(f, 0.3333);                     // 大手把肖像拍上来
  if (!p) return null;
  const j = jit(7, f);
  return <AbsoluteFill style={{background: '#E3CFAE'}}>
    <Img src={staticFile('portrait.png')} style={{position: 'absolute', left: 845, top: 554, width: 802,
      transform: `translate(-50%,-50%) translate(${j.x}px, ${j.y + (1 - p.lift) * -40}px)`
        + ` rotate(${j.rot}deg) scale(${p.s}, ${p.s * p.sqy})`,
      filter: `drop-shadow(0 ${3 + p.lift * 24}px ${5 + p.lift * 34}px rgba(34,20,8,${0.36 + 0.08 * p.lift}))`}} />
  </AbsoluteFill>;
};
```

## 6. 镜头结构模板

| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0.333–1.0 | 10–30 | 三下：肖像、红圆盘、报纸，各隔 1/3s |
| 1.333–2.0 | 40–60 | 下颌三段开合，配 3 张嘴 |
| 2.333–3.333 | 70–100 | 盖章 + 期号，剪刀五下 `snips`，纸屑落下 |
| 3.333–4.0 | 100–120 | 抖动蓄力，最后 1/3s **留白**，只有纸在抖 |
| 4.0–4.333 | 120–130 | `pop` 开盖，深海楔形翻开，`lid_land` 回弹 |
| 4.333–6.0 | 130–180 | 火箭/地球/鸟/玫瑰/蝴蝶逐件拍入 |
| 6.0–6.667 | 180–200 | 两只手指标志 `manicules` 敲两下，构成主义斜带压上 |
| 6.667–7.167 | 200–215 | 「脑洞大开」四块字每 1/6s 拍一块 |
| 7.5–8.167 | 225–245 | 撕纸 + 卷边，右缘翻过去 |
| 8.333–10.0 | 250–300 | 封底：NOGGIN 刊头、脑洞季刊、圆章、剪刀合上 |

## 7. 坑

- `K` 必须 `+1e-4` 再 floor，否则 `f=0` 与 `f=30` 会跨到同一格，撕纸的第一帧对不上 `7.5`。
- `jit` 的 rot 是 `amp*0.2` 弧度再转度，直接写 2° 会抖成帕金森。
- 白描边是 alpha 里填色（`source-in`），CSS `drop-shadow` 只会往外发光，做不出「剪刀沿」的厚度；
  四个方向的 `drop-shadow` 叠起来接近，但拐角会圆。
- `slap` 的 `pre=3` 是 3 个 step（0.25s），不是 3 帧；按帧数写会变成 0.1s 的抽搐。
- 90BPM 的 16 分是 5 帧、12fps 网格是 2.5 帧，事件表里两者必须同时落在整数格上，否则「拍」和「抖」错半格。

## 8. 版权与素材

上游 MIT。16 张抠图 PNG（`assets/gen/*`）是 rembg 从新闻/NASA 公共领域图切的，**不在仓库**，要用得自己
重做；`page_kraft.jpg`、`page_red.jpg` 未收录，共享 `grain/washi/dust` 已在插件素材库，来源信息见素材清单。字体 Anton、Bebas Neue、
Noto Serif SC 与 IBM Plex Mono 已内置，Alimama ShuHeiTi 尚未内置。`NOGGIN` 与
`THE MIND IS A COLLAGE` 是上游虚构的刊名与标语，客户项目必须换掉；维多利亚肖像、火箭、地球、手指标志
是通用公共领域图形，可以重画，别直接抓某本杂志的封面版式。
