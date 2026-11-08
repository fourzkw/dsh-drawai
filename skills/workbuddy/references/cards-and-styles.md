# 镜头卡与整片风格

两套东西，解决两个不同的问题：

- **镜头卡**（124 张，150 个样式）：**一镜**怎么动。有受保护参数、有 demo、有参考帧。
- **整片风格**（14 种）：**整支片**的视觉语言。有色板、字体、节奏、引擎契约、效果配方。

一支片通常两个都要。只挂风格，每镜都像一个模子；只挑卡，片子没有统一的语言。

---

## 整片风格

| slug | 名字 | 引擎 | 节奏 |
| --- | --- | --- | --- |
| `01-flat-vector` | 扁平矢量·一点成城 | Canvas2D | 30fps / 10s |
| `02-line-art` | 一笔画·金线 | Canvas2D | 30fps / 10s |
| `03-isometric` | 等轴 2.5D·浮岛城市 | three.js | 30fps / 10s |
| `05-cel-boil` | 逐帧手绘·线条沸腾 | Canvas2D | 24fps / 10s |
| `06-collage` | 拼贴剪贴·撕纸印刷 | Canvas2D | 30fps / 10s |
| `07-liquid` | 液态流动·棚拍稠液 | WebGL2 | 30fps / 10s |
| `08-morph` | 一形万象·形变 | Canvas2D | 30fps / 10s |
| `09-bauhaus` | 几何构成·包豪斯 | WebGL2 | 30fps / 10s |
| `10-synthwave` | 复古霓虹·合成器浪潮 | three.js | 30fps / 10s |
| `12-aurora-glass` | 弥散渐变·玻璃拟态 | WebGL2 | 30fps / 10s |
| `18-hanazi` | 综艺花字 | Canvas2D | 30fps / 10s |
| `19-paperclip` | 粗描边贴纸科普 | Canvas2D | 30fps / 10s |
| `20-pixel` | 像素 8-bit·横版卷轴 | WebGL2 | 30fps / 10s |
| `22-hud` | 赛博 HUD·FUI | three.js | 30fps / 10s |

三条命令：

```bash
wb style list                                  # 名字 + 引擎 + 节奏 + 一句话
wb style read --slug 09-bauhaus                # 判据 / 引擎契约 / 效果配方 / 色板 / 字体
wb style source --slug 09-bauhaus --files demos/09-bauhaus/film.js   # 上游实现正文
wb style frames --slug 09-bauhaus --count 8    # 抽参考帧，逐张 read_image
```

### 用风格开工程

```bash
wb create --dir D --style 09-bauhaus --spec 1080x1920@30 --duration 12
```

会多做三件事：

1. `theme.ts` 用风格的色板生成（红黄蓝 + 纸色 + 墨色）；
2. `STYLE.md` 写进判据、引擎契约、效果配方表、色板、字体、节奏、移植说明；
3. `timeline.style` 记住 slug/commit/色板/字体/节奏/判据——渲染前按它查门禁。

### 色板可读性

建工程时会量一次 `page` / `text` 的 WCAG 对比度。低于 3:1 的色板会把 `theme.ts` 的 `page` 换成 `surface`，并在命令行打一行说明（STYLE.md 里仍是上游原色板）。目前只有 `19-paperclip` 会触发：它的 brief 里 `page` 是屏内纸色 `#E9EEF2`，但编进目录时被写成了屏外舞台底色 `#1D2731`，与 `text #25313D` 只有 1.14:1。要用原色板就 `--tokens` 覆盖；写场景时也记住 `PAPER` 不一定都是浅色，深色风格要用 `SURFACE` / `FIELD` 当纸、按对比度挑字色。

### 引擎契约（硬规定）

风格上游用 three.js / WebGL2 的，工程源码里**必须真的出现**那个引擎：`wb render` 前会扫全部源码，缺了直接拒绝渲染。理由写在 `STYLE.md` 里：CSS 3D 摆 div、Canvas2D 画渐变，静帧能骗过，一动就露。

确实要换实现：在 `STYLE.md` 写一行 `偏离：引擎 <原引擎> 改为 <新方案>，因为 <原因>`，渲染带 warning 通过。同一套写法也用于 `偏离：后处理 …`、`偏离：字体 …`。

### 画质门禁

`wb render`（整片）还会检查：

- **字体**：工程里声明的字体族有没有真的注册（`@font-face` / `loadFont` / 字体文件）。没有 → 拒绝渲染，因为浏览器会静默退回系统字体。
- **后处理**：three 风格里有没有 `EffectComposer` / `SSAOPass` / `UnrealBloomPass` 之类的证据；没有 → warning。
- **累积采样**：源码里有没有 `samples` / `shutter` / `jitter(` / `halton(`；没有 → warning（等轴斜边在 1× 下必然有阶梯）。

---

## 镜头卡

10 个分类：开场与品牌 11、文字与字卡 22、界面登场 21、运镜与空间 10、数据与指标 5、交互演示 11、转场 15、节奏蒙太奇 8、光效强调 15、收尾 6。

```bash
wb card list --category typography
wb card search 纸张
wb card show --card 纸张展开 --style paper-unfold
```

`card show` 给出五件东西：

| 输出 | 怎么用 |
| --- | --- |
| **配方**（recipe） | 逐条的动效步骤，照着写；`--full` 看全文 |
| **受保护参数** | 这些值是这个卡成立的原因，改了就"不像"了。优先调时长/配色，别动它们 |
| **参数指纹**（sha256） | 和卡对不上的改动会在评审时被看出来 |
| **保留项**（preservation） | 必须保留的特征（比如"落点都在网格交点"） |
| **demo 源码** | 上游实现，抄结构不抄死数字 |

### 用卡开段

```bash
wb create --dir D --spec 1920x1080@30 \
  --cards "纸张展开:paper-unfold,数字滚动:counter-roll,结尾大字:type-slam"
```

每张卡的时长从卡的 `duration` 读（形如「约 5.6s（168f@30fps）」），总时长 = 各段之和。卡与样式会记进 `timeline.shots[i].card / .style`，只作记录，不影响渲染——**真正做出来的是你写的 scene**。

### 卡和风格一起用

```bash
wb create --dir D --style 19-paperclip --cards "纸张展开:paper-unfold,数字滚动:counter-roll"
```

这时卡提供"这一镜的动作"，风格提供"这一镜的配色、字体、颗粒、印刷质感"。两者冲突时（卡说用发光、风格说禁渐变）以风格判据为准——风格是整片语言。

---

## 别做的事

- **别用卡名当风格名**：`--style paper-unfold` 会报错并列出 14 个可选 slug。
- **别改受保护参数**：改了就不算这张卡；要新做就换一张，或在 `STYLE.md` 记偏离。
- **别照抄 demo 的时长**：卡上是"约 5.6s"，你的片子可能只有 3s；动效要压缩，不能截断。
- **别跳过参考帧**：配方是下限不是上限，判据和参考帧才是验收标准。
- **别在没看 `STYLE.md` 的情况下写场景**：色板、字体、禁用项都在里面，重写一遍要返工。
