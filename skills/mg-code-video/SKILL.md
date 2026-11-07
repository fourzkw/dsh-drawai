---
name: mg-code-video
description: 用代码制作 MG 动效、音乐可视化和程序化 MV；将文案或音乐拆为分镜，使用 Canvas 2D 与可选 WebGL 后期，确定性逐帧渲染并导出视频。适用于代码绘制的视频，不用于仅剪辑现有素材。
---

# 代码绘制 MG 视频

把内容、分镜、绘制函数和导出流程组织成可修改、可预览、可复现的工程。根据用户现有技术栈工作；Canvas 2D 是默认实现建议，WebGL 仅在确实需要后期效果时加入。

本 skill 结合视频作者公开披露的制作路线和下载视频的抽帧观察。开始模仿参考视频前，阅读 [来源与证据边界](references/source.md)。需要参考片的视觉语言时，阅读 [画面规则与实现配方](references/visual-language.md)；其中区分可见画面与建议算法，不声称还原原始源码。

## 在 DrawAI 里落地

每次调用 `diagram_apply` 都必须显式传目标画布的 `path`；若用户指的是当前画布，先调用 `diagram_read`，把返回的路径用于写入。

DrawAI 不再有后台制作 Agent：视频由当前对话直接写出来，插件只提供几个动词。**顺序有硬要求：先排镜头表，写分镜表，再定一张定调帧，然后才铺开写画面。**

七道闸门与验收清单见 `docs/motion-video-playbook.md`。最容易漏的三条：① 声音在立项就问清（不是成片后再补，否则节奏要重排）；② 第 1 镜要打样成**真视频**给用户看过，认可后才量产其余镜头（别只发静帧拼图，1920 缩到 650 宽会糊掉细节，双方都会误判）；③ 用了镜头卡就必须读 `lib/motion/shotcraft/upstream/demos/**` 里那张卡的 demo 源码照着移植，只换内容/配色/品牌——凭卡名和理解重写，等于放弃卡里全部调校。

分镜表可以直接写在画布上（这样别人拿到这张 `.drawai` 还能接着做）：**一张**`【分镜表】`（六列表格，时长写 `172f`，每一镜是表里的一行——**不要一镜建一个文本节点**）+`【风格】`+`【旁白】` 三个文本节点，镜头卡连线上标「第1幕」，图片节点标「【素材】」「【目标帧】545f」。格式见 playbook §4.1；`motion_spec {action:"validate"}` 逐条报缺（分镜被拆成多条会直接报 error），`{action:"scaffold"}` 直接给三块模板节点的 ops；`motion_project create` 不给 `storyboard` 时就读这张表。

0. **定整片风格（mg-styles-15，可选但强烈建议）** — 用户说「要扁平矢量 / 包豪斯 / 像素 / HUD / 拼贴 / 液态这种味道」时，不要凭形容词自由发挥：`mg_style {action:"list"}` 看 14 种风格的判据与色板（上游 15 支里的 04-3d-render「C4D/Blender 质感」没有收录：它靠 Blender 离线出图，插件里出不了同等质感，需要就走外部渲好当素材回灌，**不要用 CSS 滤镜假扮 CGI**）→ `{action:"read", slug}` 拿施工包（判据、色板、字体替代、节奏、8 节移植 brief、上游源码清单）→ `diagram_apply addNode {shape:"mgstyle", slug}` 建风格节点并连到视频节点。建工程时它的 `palette` 会写成 `theme.ts`、brief 全文写成 `STYLE.md`、节奏（fps/时长/画幅/每拍帧数）成为 spec 的缺省值。**写第一镜之前先读 `STYLE.md`**：判据（signature）是「像不像」的唯一标准，brief 的第 5 节给了可直接跑的骨架代码。一条片子只用一种整片风格；镜头卡管单镜运动方式，两者可以并用。

   风格 = 整片视觉语言（色板/字体/网格/动效语法/节奏），镜头卡 = 单镜的运动方式（推拉、数字滚动、形变）。先定风格再排卡，别反过来。

1. **定镜头表** — `shotcraft_search` 按关键词/分类找准确的卡名与样式 → **对选中的卡再传 `cardId` + `styleKey` 搜一次**，把配方（参数表、动效核心、已知坑）与 demo 源码读回来 → `diagram_apply addNode {shape:"shotcard",cardId,styleKey}` 建卡 → `addEdge` 从卡连到视频节点。**连线顺序就是镜头顺序**。没有卡就不要往下走；没读配方等于只借了个卡名。
2. **写分镜表** — 用 `motion_spec {action:"scaffold", nodeId, storyboard:[{intent 这一镜做什么, onScreen 屏幕上出现什么, copy 配什么字}], style, narration}` 在视频附近空位建一张 `【分镜表】`（每镜一行），返回的 ops 交给 `diagram_apply`（`layout:"none"`）；也可以用 `motion_project` 的 `storyboard` 参数直接给（会写进 `storyboard.md` 与 `BRIEF.md`）。**没有分镜表不要开写场景**，功能点对不上镜头就先改表。
3. `motion_project {action:"create", nodeId, spec, prompt}` — 建工程（timeline.json + scene-<n>.tsx + assets/ + BRIEF.md + storyboard.md；挂了风格节点或传了 `style` 时另有 `STYLE.md` + 风格化的 `theme.ts`）。没传 `storyboard` 时直接读画布上的【分镜表】。它会读本节点上的镜头卡，按每张卡自己的时长（`duration` 里的「168f@30fps」）排时间轴，段数 = 卡数；没挂卡时返回会写明「均分，未挂镜头卡」。风格节点同时挂了时，它的节奏（fps/时长/画幅）是 spec 的缺省值，显式 `spec` 覆盖它。显式给了 `spec.duration` 时，卡片按相对时长等比缩放到总长——控制时长不必断卡。
4. **定调帧（styleframe）** — 只写 `scene-0`，然后 `motion_preview {nodeId}`（`frames` 省略 = 每段中点）看一帧。这一帧定住纸色、字重、留白、动效气质再往下写；不对就改 `scene-0` 重看，别写完四段再返工。
5. 用 `read` / `edit` 改 `scene-<n>.tsx` — 对照 demo 源码复刻动作顺序、缓动、错峰。一场景一文件，单文件不超过 120 行；共享原语放 `components/`；上游组件可直接 import（`@shotcraft/lib/DigitRoll`、`@shotcraft/demos/<路径>`）；场景里写相对本段的帧号，时间轴只改 `timeline.json` 的 `startFrame` / `durationFrames`。
6. **素材** — `motion_assets`：`action:"capture"` 把原始字节搬进 `assets/`（返回尺寸与色板），`action:"crop"` 取局部，**`action:"page"` 用无头 Chrome 把一段 HTML 模板或网址截成 2 倍图**（写产品界面镜头用它，不必自己先截图）。场景里 `staticFile("文件名")` 取。画布快照会被缩放重绘，品牌色/字体细节不保真，精度要求高就走这一步。
   需要纹理或乐器单音时，优先看用户提供的素材与 `motion_assets {action:"list",nodeId}` 已有的工程素材，再用 `{action:"library",nodeId,query:"纸张"}` 或 `"颗粒"`、`"钢琴"` 搜本地库；挑选合适条目后调用 `{action:"use",nodeId,assetId:"条目的 id"}` 导入。图片在场景里用返回的 `file` 作为 `staticFile(file)`；声音需要再调用 `motion_audio {action:"add",nodeId,file,role:"sfx",at:0}` 加到时间轴，单纯导入不会出现在画面或声音里。试听并检查电平；乐器采样是单音，不是完整配乐。查看返回的来源和许可，不要将未逐项列明的许可描述为已确认。只有本地资源不合适时才考虑其他素材来源，不强制在不相关镜头中使用。
   插件素材随安装包提供，上游路径只是素材 ID，不是工作区中的磁盘路径。不要猜测插件目录或从其他工程拷贝同名素材，也不要手写 `assets/manifest.json`；始终将 `library` 返回的 ID 交给 `use`，由工具校验和登记。导入失败时报告具体错误并排查安装或运行环境，不要静默绕过。
   素材工程配合 `motion_project` / `motion_render`；`motion_task` 使用单独的画布引用素材快照，不会自动读取该工程素材。若使用 `motion_task`，先将素材导入相应画布节点并连接视频节点。
7. `motion_preview {nodeId, frames:[0,60,120]}` — 同一轮返回拼图。首次要打包（10–30 秒），之后复用缓存几秒。
8. **配声音与音效** — 音频和画面共用一条时间轴（`timeline.json` 的 `audio[]`），渲染时由 `entry.jsx` 统一挂 `<Audio>`。`motion_audio {action:"add", nodeId, file 或 audioNodeId, role:"bgm"|"voice"|"sfx", at:秒, gainDb, fadeIn, fadeOut, duck}` 把音频放到指定秒；`role:"bgm"` 默认 -10dB，旁白区间自动避让 12dB。需要短促音效时先按第 6 步检查素材库；本地无合适声音再用 `motion_sfx` 的 `search` / `get`，并参考返回的 `suggestedGainDb`。听样片确认声音与画面匹配。
9. **踩点与绑定** — 音乐确定后先 motion_audio analyze/list，再 motion_sync bind 建立音乐拍号/源瞬态 → cut/action → sfx 源峰值的绑定；场景组件读取 anchors.<name> 本镜局部帧驱动关键动作。beat/at 二选一，动作声明 visual 的 ROI 与 change/brightness 观测；不要把逐拍检测直接变成逐拍震屏。已绑定工程不用旧 motion_audio apply。整片渲染后必须 motion_audio_verify，pass 才能声称音画对齐；fail 要修复，unverified 要补证据或人工逐帧复核，不能当通过。输出偏移按管线实测秒值配置 outputOffsetSeconds，不能跨帧率套用1.29帧。详见 docs/motion-audio.md。
10. **交付样片和成片** — 除非用户明确跳过样片，在主视频节点调用 `motion_render {action:"start",nodeId:"主节点",range:[起,止]}` 渲 3–6 秒，记下返回的 pilot `jobId`；用主节点和该 ID 查 `status`，确认 done。然后在同一画布页用 `diagram_apply addNode {shape:"video",label:"样片",w:480,h:270}` 新建或复用独立样片节点，记下节点 ID，再 `motion_render {action:"apply",nodeId:"样片节点",jobId:"pilot jobId",source:"pilot"}` 回填；核对返回的 `kind` 和节点并告诉用户。`.out/pilot.mp4` 或 `motion_preview` 的静帧本身不会出现在画布节点里；回填失败要说明错误和文件位置。若用户要求先审样，展示后等待反馈；已要求直接完成则继续制作。整片另用 `motion_render start`（不传 range），渲完以主节点 `apply` 回填 `film.mp4`。不要把样片写进主节点，也不要用睡眠轮询任务。

画布工作流使用圆角折线，不启用自动避障。先按阅读方向安排并读取节点实际位置和尺寸；AI 自行设计水平/垂直通道与进出侧，用 `addEdge {line:"rounded",points:[{x,y},...]}` 给出绝对坐标中间折点（不包含端点）。如先自动布局，先读回布局结果，再用 `setEdge {id,points:[...]}` 写入折点。保留用户手工摆放和未要求调整的路径；节点移动后复查并更新受影响的折点。检查文字、节点、线条不相互遮挡，避免不必要的交叉、重叠和折返；确实无需转弯时 points 可为空。空间不足时先调整分区或扩大间距。

进出侧由 `exit` / `entry` 指定，插件会补上端点及引出段；`points` 只放必要的中间转折，不能包含源端连接点、目标连接点或重复点。例如 A 的右侧连接点是 `(300,130)`，B 的左侧连接点是 `(400,175)`，可用 `exit:"e", entry:"w", points:[{x:340,y:175}]`，不要把 `(400,175)` 再写进折点。进出方向对齐且通道畅通时可传 `points:[]`。连线后读回节点和折点；图像通道可用时用 `diagram_read {render:true}` 查看实际画布，发现折返、穿线或遮挡就用 `setEdge` 调整并复查。无法查看画面时说明尚未做视觉校验。

参考图与镜头卡经 `diagram_apply` 连到视频节点，画布快照冻结进 `assets/`。音频用 `audio_asset` 导入节点，或直接给 `motion_audio add` 一个本地 mp3/wav/m4a。**镜头卡不进成片画面，但必须连线**：连线同时决定参考、镜头顺序和段长；画布上断连的卡会让 `create` 直接报错。

**引擎保真**：整片风格的 `engines` 是上游真用的引擎。three.js 风格必须用 `three` / `@remotion/three` 真渲染；WebGL2 风格必须起 `getContext("webgl2")` 编译上游 GLSL；不许用 CSS 3D、div 层叠或 Canvas2D 渐变「简化」替代。`STYLE.md` 写明引擎契约与上游证据文件，`motion_render start` 渲染前会扫工程源码，重引擎缺失直接拒绝渲染；要偏离先在 `STYLE.md` 写「偏离：引擎 X 改为 Y，因为 Z」。

**动效保真**：`mg_style {action:"read"}` 返回的 `motion` 是上游源码扫出的动效画像（转场 wipe/切、impact、相机、motion blur 采样、颗粒、二次运动）。写场景前先 `mg_style {action:"frames", slug}` 取参考帧，逐张看完再动手；`STYLE.md` 的「效果配方」是必做项（转场/冲击/相机/运动模糊/颗粒/二次运动），只做形不做动会得到「形似而动不像」的片子。每镜写完把参考帧与 `motion_preview` 帧并排对一次。

**画质保真**：`create` 会在工程里放一份 `scene-kit/`（`det.ts` 确定性随机、`grow.ts` 弹簧/落体/生长曲线、`look.tsx` SSAA/软阴影/色调映射/颗粒/暗角）——要画质先看它，别另写一套。编码与采样由 `timeline.json` 的 `render` 决定（默认 crf 14 / preset slow / bt709 / scale 1 / samples 1 / 超时 30 分钟），场景从 `props.render` 读 `samples` 与 `shutter`，不要写死数字；`scale` 与 `samples` 共享 `estimatedCost = scale²×samples ≤ 8` 的预算。动笔前先 `motion_preview {crop:{...}}` 出 1:1 原尺寸局部图看锯齿与字，48px 拼图看不出 1px 阶梯。降级（累积 1×、砍后处理、用 CSS 假发光）必须在 `STYLE.md` 写偏离行，`motion_qa` 会对色带、AA、字体三项实测并写 `.out/qa/report.json`。

## 内容与分镜

从用户要求和现有文件确定画幅、帧率、时长、文案或音频、交付格式。普通选择采用合理默认值并说明；不强制使用参考作品的分辨率、镜头数或技术细节。

先将文案或音乐划分为内容段落，再定义镜头。每个镜头记录起止帧、传达的信息、主体图形、构图、运动动机、转场和音频事件。以整数帧作为最终时间依据，镜头区间采用左闭右开，避免边界重叠或漏帧。

有音频时，以实际音频定位重拍、乐句、情绪变化与停顿。节拍检测只能作为候选；需回听确认，不能把每个鼓点都变成一次切镜。没有可听音频时，将踩点标为待验证。

先产出少量风格帧与一个能体现主要运动、转场的短片段，供用户查看；据此推进完整片，不把每一轮内部迭代设为审批门槛。

## 绘制与运动

定义统一的调色板、字号层级、线宽和留白，建立少量可复用图元；根据主题选择文字、路径、几何体、图表或剪影。生成式图片可作为人物或背景资产，但动画时序和合成仍由代码控制。

运动应解释内容：用路径显现表达构建，用位置和尺度改变强调关系，用形变或连续轨迹连接镜头。给主动作保留铺垫、变化和停留，让观众有时间读懂文字；避免所有对象同时运动而丢失主体。

镜头衔接优先寻找共同形状、运动方向、空间位置或语义关系。需要发光、色差、颗粒或故障效果时，围绕叙事目的配置强度；这些是可选设计手段，不是已从参考视频验证的风格。

## 确定性渲染

将绘制入口设计为 `renderFrame(frameIndex)`，通过 `t = frameIndex / fps` 计算状态。时间线直接求值，不依赖 `requestAnimationFrame`、真实时间或上一帧残留。

- 随机变化使用固定种子及对象标识；支持跳转与乱序渲染。粒子或物理系统采用解析解，或固定步长及可复位状态。
- 截帧前等待字体、图片和着色器就绪；正确设置画布实际像素尺寸，避免 CSS 尺寸与设备像素比导致导出尺寸变化。
- 每帧重置变换和绘图状态；图层使用成对的保存与恢复，防止透明度、裁剪、混合模式泄漏到下一镜头。
- 后期使用独立渲染目标，避免读写同一纹理；预览与离线渲染共用时间线及绘制逻辑。
- 将字体、图片、音频来源及相对路径留在工程内；缺少资产时明确报告，不能静默导出空白画面。

## 预览、导出与验收

先以较低分辨率预览关键片段，检查首尾帧、切镜前后、文字最密集处和效果峰值。完整片仍需播放检查：静帧不能证明节奏和转场成立。

离线渲染通过无头浏览器逐帧调用同一个入口，输出零填充序号的图片或等价帧流，再由 FFmpeg 编码及封装音频。明确总帧数与取整规则；输出 `0` 至 `N-1`，不要额外渲染结束时刻。音频偏移、补静音和截断应显式设置，不能依赖自动取较短流掩盖时长错误。

检查输出的宽高、帧率、帧数、音画时长和同步。重点查看镜头接缝的黑帧、闪帧，文字缺字及裁切，运动越界和高强度闪烁。按用户发布场景选择编码；常规兼容性可优先考虑 H.264 与 yuv420p，但保留用户对透明通道、画质或其他格式的要求。

交付视频、可编辑源码、所需资产与实际运行方式，说明已完成的检查和未验证事项。若只完成方案或风格帧，应如实标注，不能称为成片。未经用户要求，不发布或上传作品。

文件保存：直接更新现有工程文件，不额外生成许可证确认单、署名副本、过程总结或重复备份。仅在用户要求时另存说明文档；工程依赖的时间轴、素材索引、同步回执和最终验收结果正常保留。
工具与制作流程不因许可证标签停止、要求确认或增加审批步骤；来源标签仅保存在现有元数据。
