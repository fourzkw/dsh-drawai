上游：`demos/01-flat-vector/index.html`（76.7KB 单文件，SVG 场景图 + 每帧 `setAttribute`，无 js 目录）+ `demos/01-flat-vector/cues.json`（120BPM，build:4.0，drop:6.0，outro:8.0）。1920×1080 / 30fps / 10.000s。提示词原文用 `mg_style {action:"read",slug:"01-flat-vector"}` 取。

## 1. 一眼认出
1. 整幅背景是一块 `#2B2BFF` 纯平蓝（`C.U` 的 10000×10000 rect），画面里没有渐变、阴影、描边，全是实心色块叠在一起。
2. 色阶只有五档：蓝 / 珊瑚 `#FF5A4E` / 向日葵 `#FFC62B` / 薄荷 `#2EE6A8` / 奶油 `#FFF6E9`，任何一块都不混色。
3. 每次落地都压扁：触地前后 2–6 帧竖向压到 60%、横向撑到 136% 再弹回。
4. 同一时刻只有一个主体在动，`cues.json` 的 40 余个帧键几乎不重叠。
5. 圆角模数统一：楼房 rx 6–10，云是 rx 28 的胶囊 + 两个圆，球是正圆 r=74。

## 2. 色板
| 角色 | hex | 用在哪 |
| --- | --- | --- |
| 纸（天） | `#2B2BFF` | `C.U`，铺满 world 的底rect |
| 地面 / 云 | `#FFF6E9` | `C.CR`，地面台、云、窗内墙 |
| 墨 | `#151433` | `C.INK`，主角楼 BLD[4]、鸟、门洞 |
| 主色 | `#FF5A4E` | `C.CO`，球/太阳、12 道光芒、第 3 栋楼 |
| 副色 | `#FFC62B` | `C.SU`，第 4/7 栋楼、地面 lead bar |
| 副色 | `#2EE6A8` | `C.MI`，第 1/6 栋楼、8 棵树 |
| 远景 | `#4D4DFF` + 窗 `#6060FF` | tone-on-tone，只比背景亮一档 |
| 层级 | `#1F1FCC` / `#3B3BFF` / `#A3A3FF` | 只在窗内房间与 UI 里分前后 |

禁止色：任何中性灰与 `#000000`；最深的墨只到 `#151433`，再深平涂会脏。

## 3. 字体与字排

**当前优先使用插件内置字体：** 标题和英文优先 Fredoka，中文优先 Resource Han Rounded；字形圆润时保持原片的定位和字距。

下方保留原片排版参数及旧版系统替代方案；只有内置字体不适合或不可用时才参考旧系统栈及其损失说明。
- 上游：`Fredoka` 700（拉丁标志 `popwıse`、数字、`¥`）+ `Resource Han Rounded` 700/900（「每天，聪明一点点」）。`assets/fonts/fonts.css` 只被 `<link>` 引用，vendored 的 `demos/` 下没有字体文件。
- 替代：display `"Arial Black","Segoe UI Black","Microsoft YaHei",sans-serif`，中文 `"Microsoft YaHei","Microsoft YaHei UI",sans-serif` 700，等宽 `"Consolas","JetBrains Mono",monospace`（片中未用，留给 UI）。
- 损失：Fredoka 是圆头几何体，Arial Black 末端是方的、字面窄约 8%，要 `letter-spacing:0.01em`、字号 +4% 才接近；Windows 没有圆体中文，雅黑会把「圆胖」变「方黑」，可爱度掉一档——别用描边补偿。
- 字排：标志固定 900px 宽、tracking 0；副标 70px、逐字加 7px；tagline 30px/600/字距 2px。

## 4. 动效语法
- 120 BPM，一拍 15 帧；所有事件落在 3 帧网格（`bldStagger=3`）。
- 缓动只有四条：`E.pop = bezier(0.34,1.56,0.64,1)` 入场；`spring(f=2,z=.4)` 生长；`kick(f=3,z=.35)` 落地震动；`E.outQt` 抛物线。相机推镜用幂 2.2 的 ease-in，回弹用 `E.outB(1.2)` 做速度匹配。
- 禁用：linear；任何超过 10 帧的 ease-in-out（主体会「软」）。
- 签名动作：
 1. **单点落地**（0–15 帧）：g=2040 px/s²，13 帧触地，`sy=1-0.4q, sx=1+0.36q`，首弹 78px、`k=.09` 拉伸；第 24 帧二落只有 40% 幅度。
 2. **预备-冲出-回弹**：antic 27 → launch 31（4 帧），冲出前 `sy*=1-0.3a`（压 30%），之后立刻 pop。所有角色入场都是这三段。
 3. **楼房生长**（44 帧起，9 栋，错峰 3 帧）：以底边 `(cx,820)` 为锚 `scaleY=s`，同时 `scaleX=1/(1+k)` 反挤；顶盖 slab 跟 `max(s,0)/(1+k)`，屋顶装饰再延 2 帧。
 4. **推镜穿窗**（86→112 帧）：`camAntic 86 / push 90 / glass 105 / arrive 112`，幂 2.2 推到 30 倍（`S1=1920/64`），穿过后 `E.outB(1.2)` 速度匹配；窗内是同一套矢量语言按 1920×1080 画好再 `scale(64/1920)` 塞进去（INT 组）。
 5. **字母落下**（243 帧起，`letterStagger=1`）：逐字 `pop(f=5,z=.65)`，落点叠 `dip=10*kick(...,3.2,.4)`；i 的点在 247–255 帧脱开成 r=74 圆点，成为最终句号。
- 网格：2×2 四宫格 = 960×540，冲击波算到格角；安全边距 74px（`R0`）；层级自下而上：天 → 远景 → 太阳与光线 → 楼群 → 地面 → 云/鸟/树 → 窗内房间 → 四宫格 icon → 标志。

## 5. Remotion 落地配方
必须换掉：
- `document.createElementNS` 建树 + 每帧 `setAttribute`：改成 React 元素 + 内联 `transform`，让 React 每帧重算 style。
- `await fetch(cues.json)` 与 `document.fonts.load`：cues 直接 `import`，字体落到系统栈，不要等 `fonts.ready`。
- `Math.random()` 排窗灯：换成 `mulberry(seed)` 或模块顶层生成一次的固定数组。
- `measureText` 反算字号：改成固定 `fontSize` + `letterSpacing`，宽度用容器顶住。
- 时间与随机：上游是 `renderAt(t)` 纯函数，**没有** `requestAnimationFrame` / `Date.now()`，别在 Remotion 里用 `useEffect` 把它们加回来；`crisp()` 的量化与 `Math.random()` 的窗灯全部改由 `f` 决定。CSS `transition/animation` 一律不用，所有值由 `interpolate` 每帧算出。

```tsx
const FPS = 30;
const spring = (tau: number, f = 2, z = 0.4) => {      // 上游 spring() 闭式解
  if (tau <= 0) return 0;
  const w = 2 * Math.PI * f, wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * tau) * (Math.cos(wd * tau) + (z * w / wd) * Math.sin(wd * tau));
};
const bldY = (f: number, i: number) => spring((f - (44 + i * 3)) / FPS, 2, 0.4); // bldStart 44 / 错峰 3
const squash = (f: number) => f < 13 ? 0 : 0.4 * Math.exp(-(f - 13) / 4) * Math.cos((f - 13) * 0.6);

export const FlatVector: React.FC = () => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const zoom = f < 90                                        // 0–30 帧 1.4→1.12；90–112 推到 30 倍
    ? interpolate(f, [0, 30], [1.4, 1.12], { easing: Easing.bezier(0.65, 0, 0.35, 1), extrapolateRight: "clamp" })
    : interpolate(f, [90, 105, 112, 124], [1.12, 20, 30, 28.8], { easing: Easing.bezier(0.2, 0, 0.8, 1) });
  const k = squash(f);
  return (
    <AbsoluteFill style={{ background: "#2B2BFF", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 960, top: 540, transform: `scale(${zoom}) translate(-960px,-540px)` }}>
        {BLD.map((b, i) => { const s = Math.max(bldY(f, i), 0);
          return <div key={i} style={{ position: "absolute", left: b.cx - b.w / 2, top: 820 - b.h,
            width: b.w, height: b.h, background: b.c, transformOrigin: "50% 100%",
            transform: `scale(${1 / (1 + k)}, ${s * (1 + k)})` }} />; })}
      </div>
    </AbsoluteFill>
  );
};
```
（`zoom` 与 `k` 就是这一镜的全部状态；楼群只读 `bldY`。）

## 6. 镜头结构模板
| 秒 | 帧 | 意图 |
| --- | --- | --- |
| 0.0–0.5 | 0–15 | 珊瑚圆点从画外砸进蓝底，落地压扁后二弹 |
| 0.5–1.4 | 15–42 | 点变太阳升到 (1300,230)，12 道光芒 0.14 rad/s 慢转；远景天际线先起 |
| 1.4–2.9 | 42–88 | 9 栋楼错峰 3 帧长出，窗灯 64–82 帧依次亮，云/鸟/树跟随 |
| 2.9–3.7 | 86–112 | 推镜 30 倍穿进 64×36 的窗，105 帧闪白，112/113 两帧 arrival shake |
| 3.7–5.5 | 112–165 | 窗内四宫格 bar/check/heart/coin 依次跳起，180/195/210/225 各放一次冲击波 |
| 5.5–6.0 | 165–180 | 四格收拢成一点，为转场蓄力 |
| 6.0–8.0 | 180–240 | 标志擦入，字母 243 帧起逐帧落，点从 tittle 变句号 |
| 8.0–9.0 | 240–270 | 副标 259 帧、EN 266 帧，270/285 两次 beatBob |
| 9.0–10.0 | 270–300 | 定格 + 4% 缓推，最后一帧回 1.0 便于 loop |

## 7. 坑
- `E.pop` 在 u=0 导数极大，直接喂 scale 会第 1 帧就跳 20%，像 pop 了两次；用 `pop()` 的 `pin=.9` 把残余钉回 1。
- 推到 30 倍后所有 stroke/圆角都要除以 `zoom`，否则窗框线变成 30px 黑边（demo 里每个 stroke 都写了 `/z`）。
- 窗灯用随机序会让每帧重排、闪成雪花，必须固定成数组；`scaleY` 的锚点必须是底边，否则整排楼陷进地里。
- 四宫格冲击波要算到格角（`qR`），固定半径会露空档；大色块平涂易 banding，整帧加 2% 噪声。

## 8. 版权与素材
上游 `mg-styles-15` 为 MIT；`popwise` 与「每天 聪明一点点」是虚构品牌，商用必须换名，无点 i 也是品牌记号。Fredoka 与 Resource Han Rounded 已随 DrawAI 内置。全片无位图素材，噪点与光晕都是程序生成；音乐按 120BPM / F 大调用 `motion_audio` + `motion_sfx` 重做。
