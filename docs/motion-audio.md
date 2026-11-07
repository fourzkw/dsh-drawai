# 声音制作

声音现在有**两条路**，别再混着理解：

- **画布音频节点** = 素材库。放一个音频节点、上传或联网搜一段，它负责「这段音频存在哪、叫什么、如何播放」。
- **工程时间轴** = 播放轴。`timeline.json` 的 `audio[]` 决定「哪一秒响、多大声、怎么淡、旁白时压到多低」，渲染时由画面侧一起播出去。

换句话说：节点给素材，时间轴给编排。渲染不再走「渲完画面再用 ffmpeg 混音」那条路。

## 加一条声音

```json
{"action":"add","nodeId":"n6","file":"D:/audio/bgm.wav","role":"bgm","at":0,"duration":18,"gainDb":-7,"fadeIn":0.8,"fadeOut":2,"loop":true}
```

- `file` 可以是绝对路径或相对画布目录的路径，会自动 `capture` 进工程 `assets/`（SHA-256 去重）。
- 也可以给 `audioNodeId`，直接用画布上已经导入过的音频节点。
- `at` 是**秒**，写进 `timeline.audio[].from` 时换算成帧；`duration` 省略时取素材长度（`loop` 时可取到段尾）。

| 字段 | 含义 |
|---|---|
| `role` | `bgm` / `voice` / `sfx`；`bgm` 默认 `duck:true` 且 −10dB |
| `from` | 起点帧（全片坐标，不是镜头坐标） |
| `durationInFrames` | 长度帧数 |
| `gainDb` | 增益；渲染时换算成线性音量 |
| `fadeIn` / `fadeOut` | 淡入淡出帧数 |
| `trimStart` | 从素材的第几秒开始取（帧数换算后进 `Audio startFrom`） |
| `loop` | 循环填满 `durationInFrames` |
| `duck` | 旁白区间自动压低（默认 −12dB，两端 6 帧斜坡） |

## 渲染时怎么响

`src/motion/entry.jsx` 按 `plan.audio` 逐条挂 `<Sequence><Audio>`，音量是帧的函数：

```
volume(f) = gainOf(cue, f) × (cue.duck ? duckFactor(f, 旁白窗口) : 1)
```

所以淡入淡出、旁白避让、循环都不用后期处理，全部在 React 侧算准。`audio:verify` 之类的事情发生在渲染之后，见下一节。

## 渲完之后的响度归一

React 侧只管"每条音轨在每一帧该多响"，它**不做限幅**——各条相加之后是什么样，得渲完才知道。所以整片渲完会自动走一遍混音后级（`src/motion/audiomix.js`）：

1. `ebur128` 量一遍（综合响度 + 真峰值）；
2. 已经在目标附近（±0.5 LU 且峰值没顶）就跳过，不反复折腾；
3. 否则 `loudnorm` 两遍法：先量（`print_format=json`），再把 `measured_*` 喂回去、`linear=true`；
4. 最后挂一级 `alimiter`，比目标再低 1dB —— AAC 编码会在取样间造出新的过冲，不留余量的话量回来还是会顶。

画面用 `-c:v copy` 直接搬，不重编；只有 AAC 音频流被重编一遍。

目标默认 **−16 LUFS / 真峰值 −1.5 dBFS**，可以在 `timeline.json` 里改：

```json
{"audioMix": {"lufs": -18, "truePeak": -2}}
```

`{"normalize": false}` 关掉这一步。切片渲染（`range`）不做归一化——拿片段当整条量会算错。

渲染任务的 `status` 会带上这次的结论：

```
渲染任务：done · 响度：-24.6 LUFS → -16.2 LUFS，真峰值 -1.9 dBFS → -1.7 dBFS
```

## 加音轨时的增益从哪来

`motion_audio {action:"add"}` 没给 `gainDb` 时按这个顺序决定：

1. **显式 `gainDb`** —— 写了就照写，不再夹；
2. **音频清单的 `suggestedGainDb`** —— `motion_sfx get` 下载时量出来的（把 RMS 拉到 −16dB 的那个值）；
3. **角色默认** —— `bgm` 是 −10dB，其余 0dB。

第 2、3 条会**再按峰值夹一道**：峰值不许过 −1 dBFS。这一步是必须的，因为 `suggestedGainDb` 只看 RMS，对短促的打击音效是错的——实测 `fs:615308` 的清单建议是 +8dB，而它自己的峰值是 −2.7 dBFS，照抄就是 +5.3 dBFS。

返回值里会直接说清楚：

```
增益 1.7dB —— 音频清单的 suggestedGainDb（原文建议 8dB，按峰值夹到 1.7dB，否则会削波）
这一条加完峰值约 -1 dBFS，余量 0dB
这个时间段已经有 1 条音轨，叠加后峰值只会更高
```

## 音乐、画面与音效的统一绑定

先用 motion_audio add 将音乐和音效放入工程，再用 list 取得 cueId。
motion_sync bind 替换 timeline.sync 的绑定表；不再用 motion_audio apply 覆盖已绑定工程。
拍号从 0 开始，来自音乐源文件的分析网格；at 是音乐源文件的秒值，不是成片秒值。
音乐的 from、trimStart 和显式 outputOffsetSeconds 共同决定全片帧；最后一步才取整。

    {
      "action":"bind", "nodeId":"n8", "musicCueId":"bgm-1",
      "anchors":[
        {"id":"cut-2","type":"cut","shotId":"shot-2","beat":8},
        {"id":"title-hit","type":"action","shotId":"shot-2","name":"titleLand","beat":10,
         "visual":{"metric":"change","roi":{"x":0.2,"y":0.2,"w":0.6,"h":0.6}},
         "sfx":[{"cueId":"impact-1","peakSeconds":0.12}]}
      ]
    }

beat 和 at 二选一。低质量网格拒绝拍号绑定，可改用真实瞬态 at。
所有位置使用同一个解析器：切镜改变 shot 起点/时长，动作生成 shot.anchors，
音效按源文件 peakSeconds（含 trimStart）反推 cue.from。越界、未知引用、
重复绑定直接拒绝，不静默截断。音乐/音效暂不支持循环绑定。
motion_sync list 读解析结果；clear 解除绑定并保留最后排期。
切镜、旁白排期、修改音轨后重新解析；与绑定冲突的改动需要先解除或调整绑定。

场景组件接收本镜局部帧 anchors：

    export default function Scene({ anchors }) {
      const frame = useCurrentFrame()
      const land = anchors.titleLand
      const y = interpolate(frame, [land - 8, land], [100, 0], {
        extrapolateLeft:'clamp', extrapolateRight:'clamp'
      })
      // 用 y 绘制标题；每个需要跟音乐走的关键动作都读取对应 anchors。
    }

动作必须实际使用 anchors；声明名字不会自动改写已有 TSX。
硬切默认测整画面的相邻帧差；动作显式选择 ROI：
metric:"change" 测局部变化峰，metric:"brightness" 测亮度峰。
平滑位移的语义落地时刻不能仅凭变化峰判定；应设计可观测的落点，
或交给人工逐帧验收。相似镜头、持续运动或声音被掩盖会返回 unverified。

### 成片音画对照

motion_audio_verify 逐锚点做三件事：

1. 将源音乐瞬态附近的波形与成片混音做局部归一化相关匹配。
2. 解码成片画面，在计划帧前后 6 帧找选定 ROI 的实际变化/亮度峰。
3. 对每个已绑定音效独立匹配源峰值，分别计算画面-音乐、音效-音乐的帧误差。

默认容差 2 帧，可配置 0–3 帧。低相关、歧义峰、无画面变化或未声明动作观测
均标记 unverified；超容差 fail；所有锚点有证据且达标才 pass。
不再拿成片音频与自己拟合出的网格比较来宣称音画合格。
报告保存在 .out/qa/sync/report.json，含实测帧、音频时刻、相关度及帧量化误差。

全片渲染生成 film.mp4.sync.json，记录绑定/场景/素材版本与成片哈希。
变更后拿旧片验收会拒绝；没有回执的历史成片最多是 unverified。
预览、局部渲染不会产生完整成片验收回执。

输出音轨偏移按秒保存，不沿用固定 1.29 帧。默认 0 表示尚未加校准补偿；
报告在至少 3 个可靠音乐匹配且偏移散布小于 15ms 时给出 measuredOutputOffsetSeconds。
确认管线后把它传给 motion_sync bind 的 outputOffsetSeconds，再渲染验收。
改 FPS、编码器或容器后重新量；源音乐的分析 t0 不改写。
旧 motion_audio apply 仅供未绑定工程使用，保留兼容的旧吸附行为。

### 验证

npm run test:motion-sync 检查绑定、真实 FFmpeg 成片正例、画面延后 4 帧反例与未验证状态。
node tools/check-motion-sync.mjs --remotion 额外跑真实 Remotion 渲染及成片回测。

## 音效搜索与保存

motion_sfx search/get 与画布 audio_asset 共用同一个 JS 下载器，无 Python 运行时依赖。
搜索与下载不做许可证筛选或审批，缺少或出现多个许可链接不会阻止下载。
页面提供的来源与标签仅作为普通元数据保留，不触发确认。

工程音效下载到 assets/sfx/，音频分析与来源合并在一份 audio-manifest.json 中。
画布音频导入只保留 audio.wav、preview.m4a 和 audio.json 等播放所需文件；
不再另存 original 音频副本、CREDITS.md 或 analysis.log。
中转下载不生成清单，导入后整个中转目录清理。

不再自动生成 FREESOUND-CREDITS.md、AUDIO-CREDITS.md、重复 Markdown 验收报告、
空白旁白脚本；同步验收临时灰度帧与成功日志处理后清理，只保留最终 JSON 报告。
时间轴、素材索引、渲染回执和工程场景文件仍用于运行与验收。
已有工程的附加文件不会批量删除。

## 旁白

旁白不是「再叠一条音轨」，而是**让镜头跟着句子走**：先按字速估，合成后用真实时长再重排一次，每句一条 `role:"voice"` 音轨 + 一条字幕。

```
motion_voice {action:"plan",  nodeId:"n8"}   // 只估算与重排，先看排期合不合理
motion_voice {action:"say",   nodeId:"n8"}   // 真合成（edge-tts，拿不到就退 SAPI）
motion_voice {action:"align", nodeId:"n8"}   // 音频已经有了，只按真实时长重排
motion_voice {action:"list",  nodeId:"n8"}   // 现状 + 可用音色
```

脚本写在 `<工程>/voice.script.md`（也可以直接把正文当 `script` 传，以 `#` 开头）：

```md
## shot-1
晚上十点，今天最后一杯。
## shot-2
先扣掉睡觉的两千九百二十小时。
```

规则：`## shot-N` 分节、一句一行、`>` 开头的行当备注不念。**脚本里写了时间轴上没有的镜头会直接报错**——静默丢句是最难发现的那种错。

排期：`逐句时长 = 字数/cps + 标点停顿`（中文默认 4.8 字/秒，夹在 0.9–9 秒）；`镜头时长 = max(原时长, 本镜台词 + 气口)`，`fit:"exact"` 改成按旁白**收紧**，`fit:"none"` 只写字幕不动时长。合成之后用 `probeAudio` 量的真实秒数替换估算值再重排一次。

音色：默认 `zh-CN-XiaoxiaoNeural`（女/温），`YunxiNeural`（男/更亮）、`YunjianNeural`（男/有力量）适合「数字很吓人」的段落；`--list-voices` 还有方言款。

两点要知道的：

- **合成走 Python 桥**（`src/motion/edge-speech.py`）。原因是词级时间戳只存在于 `edge_tts.Communicate.stream()` 的边界事件里，CLI 没有这个开关；而且 `boundary` 默认是 `SentenceBoundary`，要显式传 `WordBoundary` 才拿得到词。参数与结果都走文件，不开管道（受限环境里 `spawn` + pipe 会 EPERM）。
- **按台词哈希缓存**：`cacheKeyOf(voice|rate|pitch|text)` 前 16 位，改一句只重合成一句；`force:true` 强制重来。命中缓存不联网。

字幕写进 `timeline.subtitles`，导出 `subtitles.srt` 与剪映字幕轨都不用改——它们本来就先读这个字段。BGM 侧不用手动压：`voice` 窗口已经被 `duckFactor` 用来让路（−12dB）。

### 场景那边要配合的一件事

镜头时长会变，所以场景**不能写死自己的帧数**：

```tsx
const { durationInFrames } = useVideoConfig()   // 这一镜现在有多长
const settle = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0.97], { extrapolateLeft: 'clamp' })
```

写死一个 `const DUR = 140` 的话，旁白一拉长镜头，收尾动作会提前演完，剩下的是**静止画面**（帧检会把它记成 freeze warn）。`motion_project create` 生成的占位场景已经是这种写法。

## 限制

- 未接入：生成音乐、文本生成音效。TTS 有了（`motion_voice`），但只有 edge-tts 与 Windows SAPI 两个后端，没有云厂商 voice、没有情感/风格参数、不做 ASR 对齐（`align` 是「按已有音频的时长重排」，不是「听写」）。
- 混音后级只有 `loudnorm` + `alimiter` 这一级：没有总线 EQ、压缩、多段动态。默认目标就是交付值 −14 LUFS / 真峰值 ≤ −1 dBTP；要改只写 `timeline.audioMix.lufs`，别在成片上再跑一遍。
- 限幅器余量按实测收敛：第一轮 `loudnorm(linear) + alimiter(truePeak − 1dB)`，量回来的真峰值仍高于目标就**只挂限幅器再压一轮**（不再跑 loudnorm，否则会拿旧测量值多加一次增益）。实测 −24.6 LUFS 的素材 → −14.3 LUFS / −2.4 dBTP。
- 不支持「只重混声音、复用画面」的独立版本（旧版的 `remix` 已随内层 agent 一起删除）；现在改声音就是改 `timeline.audio` 再渲染一遍，画面部分命中 bundle 缓存，只付渲染的钱。
- 旧的 `audioMode`（auto / manual / off）、`audioPlan` JSON、`no-bgm.mp4` 与 `film-review` 响度报告都不再产出。

## 验证

- `node tools/build.mjs` 后再重启插件，`motion_audio` 的 `list/add/remove`、`motion_audio_verify`、`motion_voice` 才会出现在工具面上。
- `node tools/check-motion-voice.mjs` 跑旁白自检（脚本解析、估时长、重排数学、字幕与音轨对齐、检查项）；加 `--say` 再真合成一句并核时长与词边界。
- `npm test` 覆盖画布与媒体，**不**覆盖音频轴；音频链路目前靠 `motion_audio_verify` 与帧检的实测报告验收。
