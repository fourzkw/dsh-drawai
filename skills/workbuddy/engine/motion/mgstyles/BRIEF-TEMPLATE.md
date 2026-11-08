# mg-styles brief 模板

每份 brief 是「一个风格如何**在 Workbuddy 的 Remotion 工程里**被做出来」的可执行说明书。
它不是上游提示词的翻译，而是**换了一套渲染栈之后的落地手册**：上游用 HTML 页 +
`renderAt(t)` + puppeteer 截帧，Workbuddy 用 React 场景 + Remotion 逐帧渲染。同一个
"每帧是 t 的纯函数"的心智模型，但 API、约束、可用的近似手段全都变了。

## 硬性要求

- 8 节，顺序固定，标题一字不差（`wb style` 工具和校验脚本按标题取内容）。
- 全文 6–11KB（超过 12KB 就砍第 6 节的措辞，不要砍第 5 节和判据）。宁可少写，不要把上游提示词整段抄过来 —— 提示词原文由 `wb style read`
  另外返回，brief 只写"换到 Remotion 之后要注意什么"。
- 每个技术判断都要能在 `demos/<slug>/` 的源码里找到依据（写文件名/函数名），
  或者明确标注"这是近似手段"。
- 颜色一律给 hex，并注明角色（纸/墨/主色/副色）。不要写"暖色调"这种没法执行的描述。
- 动效参数要可检验：帧数、角度、缓动函数名、错峰帧数、网格模数。

## 八节

### 1. 一眼认出
3–5 条**判据**，不是形容词。反例：「有节奏感」；正例：「所有落点都在 240px 网格线上」。

### 2. 色板
表格：角色 / hex / 用在哪。再给一句"禁止色"（这个风格里绝对不能出现的颜色倾向）。

### 3. 字体与字排
原片用什么字体（查 `assets/fonts/fonts.css` 与 demo 源码里的 font-family）；
Workbuddy 里没有这个字体时用什么替代（给具体 font-family 栈）；字号/字重/字距/竖排/
中英混排的规则。替代会损失什么，直说。

### 4. 动效语法
- 节拍：BPM、每拍几帧（30fps 下 120BPM = 15 帧/拍）。
- 缓动：曲线名 + 参数；明确禁用哪些（比如包豪斯禁 overshoot）。
- 签名动作 3–5 个，每个给：做什么、多少帧、什么缓动、错峰多少帧。
- 组成规则：网格模数、安全边距、图层顺序。

### 5. Remotion 落地配方
这一节最重要。写清楚：
- 用哪些 API（`useCurrentFrame` / `interpolate` / `Easing` / `spring` /
  `@remotion/motion-blur` / `@remotion/three` / `random(seed)`）。
- 上游哪些写法**必须换掉**：`requestAnimationFrame` → 帧函数；`Date.now()` /
  `Math.random()` → 种子随机；CSS transition/animation → 每帧算出的样式；
  Canvas 2D 逐帧绘制 → 可以用，但要在 `useEffect` 里按 `frame` 重绘（给骨架代码）。
- WebGL/着色器后处理（纸纹、套印、发光）：`three/addons` 的后处理链在场景里是
  **允许**的（EffectComposer + SSAOPass / UnrealBloomPass），不要再默认写成 CSS 假发光。
  确实要换近似方案（CSS filter、SVG feTurbulence、mix-blend-mode）时必须写清
  「损失是什么、在哪一帧看得出来」，并在 `STYLE.md` 落一条 `偏离：` 行。
- 累积采样：`render.samples`（场景从 `props.render` 读）+ `scene-kit/det.ts` 的
  `jitter()`（Halton(2,3)，禁 `Math.random()`）；写明这一镜要几个样本、为什么。
- 运动模糊：`render.shutter` 的多快门采样，或 `@remotion/motion-blur` 的
  `CameraMotionBlur`；说明适用/不适用的镜头。
- 给一段 15–30 行的骨架代码（真实可跑，不是伪代码），展示这一镜的核心结构。

### 6. 镜头结构模板
按秒给意图（不是内容）：0–0.5s 钩子、…、结尾定格多少秒。写"这一镜要完成什么"，
让 agent 能替换成自己的内容。

### 7. 坑
3–6 条，每条一句话，都是会在渲染时真的出问题的事：字体回落、细线 shimmer、
渐变 banding、`staticFile` 路径、粒子/物理不确定、跨镜状态泄漏、超大 DOM 节点。

### 8. 版权与素材
上游 MIT；可用素材的范围；品牌名必须虚构；哪些图形是"通用几何"可以自由用。
