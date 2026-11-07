# 画质改造完整规划（渲染器 · 门禁 · 边界）

> 目标：让插件出的片子从「模板级」推到「agency 级」，办法是把**该进代码的进代码、该进场景的进场景、该进外部的进外部**，并且让每一次降级都**留下证据、能被测出来**。
> 状态：待批准。工作量见第 5 节，全部改完约 3 个工作日。

---

## 1. 三条判据（先定边界，再谈实现）

| 判据 | 含义 | 归属 |
|---|---|---|
| **A** | 改变「第 t 帧包含哪些样本 / 哪些光照 / 哪些后处理」 | **场景层**（skill + 固定 harness，不进插件代码） |
| **B** | 改变「这一帧怎么变成文件」（编码、色彩、像素格式、超采样、超时） | **插件代码**（场景代码物理上改不到 `renderMedia`） |
| **C** | 让「降级、缺失、超预算」变成**可见、可拦**的东西 | **插件**（门禁 + QA）。没有执行点的文本规格，模型一遇报错就退回默认值——这是最主要的质量流失渠道 |
| **D** | 一次性生成物（字体子集、噪声图、位图纹理、外部渲染的 CGI 段） | **外部 / 工程产物**，插件只读取与校验 |

判据 C 是这份计划的核心。现状的问题主要出在**「写了但没发生」**：brief 里写着 16× 累积，实际每帧只渲一次，而没有任何东西会告诉你这件事。

---

## 2. 缺口清单与归属

| # | 缺口 | 现状证据 | 后果 | 归属 |
|---|---|---|---|---|
| 1 | 无累积采样 | `src/motion-render-worker.js#L72-L75` 只调一次 `renderMedia`；上游 `.../03-isometric/js/render.js#L1` 是 N 次子渲染 + 亚像素抖动 | 斜边锯齿、接触阴影发硬 | **A** 场景层（GPU 内累积） |
| 2 | 无后处理 pass | `src/motion/mgstyles/briefs/03-isometric.md#L45-L46` 明写「损失是…」 | hit 帧没有辉光溢出，画面像贴纸 | **A** 场景层（`three/addons` 本来就允许，见 `src/motion/style-engine.js#L23`） |
| 3 | 编码参数不可控 | `renderMedia({codec:'h264', concurrency:2})`，未传 crf/preset/pixelFormat/色彩标签；上游 `harness/render.mjs#L305-L308` 是 `-crf 14 -preset slow --x264-params aq-mode=3` + bt709 三标签 | 淡紫底 `#EEEAFC` 出色带、整体偏色 | **B** 插件 |
| 4 | 超采样不可表达 | `src/motion/spec.js` 自述「只描述是什么，不描述怎么渲染」，且 width/height 上限 1920 | 想渲 3840 再缩 1920 表达不出来 | **B** 插件 |
| 5 | 超时写死 10 分钟 | `src/motion/render.js#L84` `options.timeoutMs \|\| 600000` | 16× 累积必爆 → 模型自动降级 → 回到缺口 1 | **B** 插件 |
| 6 | 粗看没法验 | `motion_preview` 只出 48px 拼图；`motion_qa` 只查黑场/静止/闪烁/空白/顶边/削波 | 看不出锯齿与色带 → 看不见就修不了 | **B** 插件 |
| 7 | 降级无痕 | brief 里「损失是…」是散文，不是断言 | 降级可以静默发生 | **B** 插件（门禁） |

缺 1、2 不进插件，缺 3–7 必须进。这条分界决定了下面四层怎么排。

---

## 3. 四层改造

### L0 · 冻结渲染规格（零场景改动，肉眼立刻可见）

**做什么**：把散落在默认值里的「怎么变成像素」收成一个可校验对象。

- 新增 `src/motion/render-settings.js`：

  ```js
  export const RENDER_DEFAULTS = {
    scale: 1,              // 1 | 2（渲 2× 再缩，超采样）
    codec: 'h264', crf: 14, preset: 'slow', profile: 'high',
    pixFmt: 'yuv420p', colorSpace: 'bt709',
    x264: 'aq-mode=3',
    concurrency: 2,
    timeoutMs: 30 * 60 * 1000,
  }
  ```

  读取优先级：`timeline.json.render` → 调用参数 → `RENDER_DEFAULTS`；带范围校验（`scale∈{1,2}`、`crf∈[10,18]`、`timeoutMs≥60000`）。

- `src/motion-render-worker.js#L72-L75`：`renderMedia` 全部参数从这里取，并显式传 `-colorspace/-color_primaries/-color_trc bt709`。
- `src/motion/render.js#L84`：`timeoutMs` 从 settings 来；进度里带上「已渲帧数 × 实测单帧耗时 → 预计总时长」，超预算提前 warning，而不是等到被杀。
- **不改 `spec.js` 的语义**：spec 说「是什么」，渲染参数进 `timeline.json.render`。两者分开，是为了让 spec 仍然可以被产品/客户读懂。

**验收**
1. 同一场景渲两次，`ffprobe` 三条色彩标签均为 `bt709`；
2. `crf` 改 14→18，码率下降 ≥25%（证明参数真的生效）；
3. `scale:2` 时输出仍是 1920×1080（证明是超采样，不是改画幅）。

### L1 · 让「看不见」变成「看得见」（门禁的另一半）

- `motion_preview` 增加 `crop:{x,y,w,h}` 与 `scale:1`：出**原尺寸局部**。48px 拼图看不出 1px 阶梯，这一条是 L2 能否被验证的前提。
- `src/motion/qa.js` 增加三项像素检测：

  | 检测 | 做法 | 判定 |
  |---|---|---|
  | 色带 | 平滑区做 8-bit 直方图，统计「平台段」数量与最宽平台 | 宽平台 > 阈值 → warn（大色面必报） |
  | AA | 沿已知 30°/60° 斜边取梯度剖面，统计 1px 阶梯长度 | 平均阶梯 > 1.5px → warn |
  | 字体 | 扫场景源码 `fontFamily` + 工程 `assets/fonts` 清单 | 未注册 → **拒渲**（tofu 是硬错，不是风格问题） |

- 统一落 `.out/qa/report.json`：`{checks:[{id, level, value, threshold, frame, shot}]}`，供后续「打分」读取。**打分本身不进插件**（见第 4 节）。

**验收**：故意注入一次 1.5× 降采样 + 8-bit 色带，三项必须报警；正常片必须全绿。

### L2 · 场景层：一份 harness，所有片子共用

**做什么**：`motion_project create` 时把三个脚手架文件拷进工程（**拷文件，不做包 import**——Remotion 的 bundle 只认工程目录，跨包 import 会解析失败）。

- `<工程>/scene-kit/accumulate.tsx`：`<Accumulate samples={8} shutter={0.5}>`
  - 同一 `useLayoutEffect` 内渲 N 次到 `HalfFloatType` 目标后平均；
  - 抖动序列由**帧号索引**的 Halton(2,3) 生成（禁 `Math.random()`，否则不确定）；
  - 可选快门子时刻：`shutter` 秒内取 K 个时刻一起平均 → 运动模糊，不再需要 N× 编码。
- `<工程>/scene-kit/post.tsx`：EffectComposer 装配 —— `SSAOPass`（kernelRadius 8–12 世界单位）、`UnrealBloomPass(res, 0.35–0.6, 0.4, 0.85)`、可选 DoF / 暗角 / 颗粒；发光值压在 ≤0.9，否则淡彩糊成白。
- `<工程>/scene-kit/det.ts`：`useDet(frame, salt)` 把确定性随机收成一个函数。

每个场景只写 5 行接入。**关键价值不是省几行，而是「只有一份实现」**——否则 14 种风格会长出 14 种错法（抖动没居中 → 整体偏移；平均写错 → 亮度掉一半）。

**文本同步改**：
- `docs/motion-video.md` + `skills/mg-code-video/SKILL.md`：加「画质默认规格」一节（样本数、快门、SSAO/bloom 参数、scale）。
- `src/motion/mgstyles/briefs/03-isometric.md#L45-L46`：把散文「损失是…」改成**断言**：「未接累积时，AA 检测必然 warn；若必须降级，在 `STYLE.md` 写一行 `偏离：累积 1×`，否则拒渲」。降级可以，但必须留痕且可测。

**验收**：同一帧 1× vs 8× 累积，`qa` 的 AA 指标改善 ≥30%，单帧耗时增长倍数记录在报告里。

### L3 · 交付级（外部，不进插件）

- `<工程>/tools/polish.mjs`（脚手架，不是插件）：ProRes/DNxHR 母版、平台变体、SRT 烧字幕。插件只负责出**出厂即合格的 H.264**。
- 音频：现有 loudnorm（两遍 + `linear=true`）+ alimiter 已正确；只改默认值 `lufs: -16 → -14`、`truePeak: -1.5 → -1.0`，并在报告里**打印实测 LUFS / TP**（不是只打印配置）。

---

## 4. 不放进插件的九件事（各自去哪）

| 事项 | 谁做 | 插件只做 |
|---|---|---|
| 交付级母版 / ProRes / 平台变体 | `<工程>/tools/polish.mjs` + 外部 ffmpeg | 出合格的 H.264（L0） |
| 音乐创作 | 外部（Freesound/CC0 或用户导入） | 摆放、duck、loudnorm、打印实测响度 |
| 字体挤字与子集化 | 构建期 `pyftsubset` | **校验**：字体未注册即拒渲（L1） |
| 位图纹理 / 贴图 | `motion_assets` 收进 `assets/` | 尺寸/色板/来源记录 |
| 逐帧程序噪声 | 一张 `grain.png`（确定性、0 成本） | 无 |
| CPU 像素读回做平均 | GPU 内累积（L2） | 无 |
| Blender/Cycles 离线渲染 | 外部渲 → `reference-media` 回灌 | `motion_assets capture` 导入 |
| 评审打分 | 模型 / 人 | 只出证据：`report.json` + 原尺寸裁切 |
| 逐帧截图 harness | Remotion 已替代 | 无 |

第 6 条与第 1 条是同一条判据的两面：**「怎么平均」放 GPU，「平均几次」放场景，「编码几次」放插件**。三者混在一起就是现在的时间陷阱。

---

## 5. 顺序与工作量

| 批次 | 内容 | 行数 | 工时 | 为什么排这里 |
|---|---|---|---|---|
| **B1** | L0 编码 + 色彩标签 + 可配超时 | ~30 | 2h | 零场景改动，全片受益；并解锁「单帧耗时」实测 |
| **B2** | L1 1:1 裁切 + 三项检测 | ~80 | 4h | 后面所有验收都靠它 |
| **B3** | L2 三件脚手架 + 文本改断言 | ~200（含模板） | 6h | 依赖 B2 才看得出差别 |
| **B4** | L0 超采样 + L3 音频默认值 + polish 脚本 | ~60 | 3h | 超采样会让耗时 ×4，要有 B1 的实测才敢开 |

先做 B1 + B2 的理由：它们不引入任何新抽象，只是把「已经发生的事」参数化和**测量化**；而 B3 一旦开做，就必须先有办法看见效果，否则等于给瞎子配眼镜。

---

## 6. 风险与取舍（含我改主意的三处）

1. **编码从「外部 ffmpeg」改成「插件内设参数」** —— 上一版计划把母版编码划到外部，理由是「插件不该管这一帧怎么落成文件」。现在改判：`renderMedia` 参数**只有一个地方能设**，划到外部等于没人会做；而设对默认值（14 行）与「做一套编码管线」（外部脚本）是两件事。交付级变体仍然出插件（L3）。
2. **累积从「worker 层 N× renderStill + CPU 平均」改成「GPU 内累积」** —— 前者要 300×16=4800 帧 PNG 的 IO 与编码，10 分钟必爆；后者同一视觉结果、成本低一个量级。
3. **后处理从「必须换掉」改成「允许并要求」** —— `style-engine.js#L23` 本来就写了「后处理用 three/addons」；brief 里那句「必须换掉」是移植配方的取舍，被误读成插件限制，这条在 03-isometric 上已经造成实际损失。

其余风险：
- **预算互斥**：`scale=2` 与 `samples=16` 叠加 ≈ 64× 像素工作量。render-settings 要提供总预算（像素 × 样本）校验，超了 warn 并给建议值，而不是跑到超时。
- **GPU 争用**：`concurrency:2` 在同一张卡上做重累积会互相抢；累积时自动降 `concurrency:1` 并重算超时。
- **`aq-mode=3` 与 AA 指标互相拉扯**：aq 会轻微抹细线，AA 检测可能因此更「好看」，但边缘发软。两项指标必须一起看，不能各自优化。
- **默认 `-14 LUFS` 是破坏性变更**：已有成片会显得响 2dB。一次性迁移 + 写进 CHANGELOG，不做兼容开关。
- **`@remotion/motion-blur` 的 `<Trail>` 不能假设可用**：它是「前几帧叠图层」，对单个全屏 canvas 未必能累加。先验证再依赖，L2 的积累路径不依赖它。

---

## 7. 完成定义（DoD）

一条 03-isometric 的 10 秒片子，全流程跑通并**留下证据**：

- `ffprobe`：1920×1080 / 30.000 fps / 300 帧 / h264 high / bt709 三标签 / AAC 48kHz 立体声；
- `report.json`：实测 −14±0.5 LUFS、TP ≤ −1 dBTP、色带/AA/字体三项全绿；
- `.out/qa/` 内有两张 1:1 裁切（累积前 / 累积后），AA 指标改善 ≥30%；
- `timeline.json.render` 记录本次实际参数（可复现）；
- `STYLE.md` 无「偏离」行，或偏离行与门禁结果一致（**声明与实际相符**）。

第 5 条是整份计划真正的落点：**片子可以有取舍，但取舍必须被写下来，并且被机器验证过。**

## 8. 实施状态（2026-11-05，B1–B4 已落）

- **L0 渲染规格**：`src/motion/render-settings.js` 提供口径与夹取；`render.js` 解析并分配超时；worker 把 crf/preset/pixelFormat/colorSpace/audioBitrate/scale/concurrency 传进 `renderMedia`，scale>1 时先渲再 lanczos 缩回并打 bt709 三标签。
- **L1 看得见**：`motion_preview` 支持 `crop`（1:1 原尺寸）；`pixelqa.js` 出三项像素证据（色带阶梯、斜边过渡占比、字体注册），并入 `.out/qa/report.json` 的 `base.frameQa`。
- **L2 场景层**：`createProject` 写 `scene-kit/{det,grow,look}`，场景从 `props.render` 读 samples/shutter；`assertQualityEvidence` 在 `motion_render start` 拒渲未注册字体，并对缺后处理/缺累积声明的 three 场景报警（写了 `偏离：` 才降级）。
- **L3 交付级**：`createProject` 写 `tools/polish.mjs`（--master / --web / --vertical / --loudness）。
- **音频默认值**：−14 LUFS / 真峰值 −1 dBTP；限幅器按实测收敛（两轮上限），实测 −24.6 → −14.3 LUFS / −2.4 dBTP。
- **验证**：check-mgstyle-engine 8/8、check-mgstyle-motion 3 组、check-render 629、check-motion-fixes 8、check-motion-qa、check-motion-mix 全过。
- **未做**：真实 10 秒片子的「开累积前后两张 1:1 裁切」对比（DoD 第 3 条，属片子级验收）；`@remotion/motion-blur` 的 `<Trail>` 对全屏 canvas 是否可累加，尚未验证。
- **环境性失败（与本轮无关）**：`@deepseek-ai/dsh-tools` 的 junction 目标为空 → `check-motion-host` / `check-motion-ui` 无法 import `lib/index.js`；`check-motion-export` 的断言期望 ≥5 条音轨，而本机 fixture `.drawai-motion/n1` 只剩 1 条 bgm。
