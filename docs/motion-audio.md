# 声音制作

声音现在有**两条路**，别再混着理解：

- **画布音频节点** = 素材库。放一个音频节点、上传或联网搜一段，它负责「这段音频存在哪、叫什么、许可是什么」。
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

## 节拍与钉帧

`motion_audio {action:"analyze"}` 对音频做：

- **采样级 onset**：包络峰天然早半个窗（20–40ms），所以细化到第一个越过 35% 局部峰值的采样点。
- **分频段**：kick 40–160Hz / snare 1.2–3kHz / hihat 6–12kHz，每条拍点带 `kind`。
- **等距网格拟合**：对候选 BPM 的 0.5×/1×/2× 各做一轮最小二乘（内点按 `|t−t0−kT| ≤ 20ms` 迭代筛选），取残差与覆盖率最好的那个。
- **不给假数据**：拍点不足、覆盖率 < 45% 或残差过大时 `bpm` 返回 `null` + `note`，而不是报一个看起来像真的数字。氛围铺底这类素材就该是 `null`。

`apply` 会把切镜边界吸到最近的拍子上（容差默认 4 帧）；带 `cueId` 时把那条音轨钉到指定拍点。

**输出偏移**是已知的硬约束：AAC 编码有 priming 延迟，本管线实测 43ms = `OUTPUT_AUDIO_OFFSET_F = 1.29` 帧（30fps）。钉帧时的换算：

```
from = round(目标帧 − 素材自身峰值滞后 − 1.29)
```

实测：目标第 120 帧 → 落位 `from=119`，成片量到 4.010s（目标 4.000s），误差 0.3 帧。旁白避让实测压低 12.1dB（目标 12）。

`motion_audio_verify` 从**成片音轨**反向重算拍点，逐拍报残差帧数，`worst > 2` 直接判「对不上拍」——不依赖「我看着差不多」。

## 音效搜索与署名

两条入口，底层是同一套东西：

- **对话里**：`motion_sfx {action:"search", nodeId, query:"paper whoosh", maxDuration:2}` → 挑一条 → `motion_sfx {action:"get", nodeId, ids:["fs:730078"]}`。搜索**不按许可过滤**，每条结果带 `licenseLabel`，用哪条由人决定。
- **画布上**：选中音频节点，展开「搜索 Freesound 音效」（`audio_asset {action:"search"}`）。

`get` 做的事：

1. 打开详情页复核许可（必须恰好一个 Creative Commons 链接），把许可标签记进清单——**用不用、要不要署名，人自己看标签决定**；
2. 下载上游 HQ MP3 预览（不是原始无损文件），落到 `<工程>/assets/sfx/fs-<id>.mp3`；
3. 量 10ms 窗 RMS / 峰值 / 有效起止，算出 `suggestedGainDb`（把这条音效拉到 −16dB RMS 附近），挂到轴上时直接当 `gainDb` 用；
4. 写 `assets/audio-manifest.json`（含 sha256、许可、作者、原始链接、下载时间、分析结果）与 `assets/FREESOUND-CREDITS.md`——**许可各不相同：CC BY 与 NC 类素材用之前先看一眼，该署名的写进片尾**。

网络：只访问 `freesound.org` 与 `cdn.freesound.org`；不需要 API key（读公开搜索页与预览地址）。没有网络时 `search` 会直接报错，不会静默返回空列表。

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
- 混音后级只有 `loudnorm` + `alimiter` 这一级：没有总线 EQ、压缩、多段动态；要 −14 LUFS 的交付标准，改 `timeline.audioMix.lufs` 就行，别在成片上再跑一遍。
- 不支持「只重混声音、复用画面」的独立版本（旧版的 `remix` 已随内层 agent 一起删除）；现在改声音就是改 `timeline.audio` 再渲染一遍，画面部分命中 bundle 缓存，只付渲染的钱。
- 旧的 `audioMode`（auto / manual / off）、`audioPlan` JSON、`no-bgm.mp4` 与 `film-review` 响度报告都不再产出。

## 验证

- `node tools/build.mjs` 后再重启插件，`motion_audio` 的 `list/add/remove`、`motion_audio_verify`、`motion_voice` 才会出现在工具面上。
- `node tools/check-motion-voice.mjs` 跑旁白自检（脚本解析、估时长、重排数学、字幕与音轨对齐、检查项）；加 `--say` 再真合成一句并核时长与词边界。
- `npm test` 覆盖画布与媒体，**不**覆盖音频轴；音频链路目前靠 `motion_audio_verify` 与帧检的实测报告验收。
