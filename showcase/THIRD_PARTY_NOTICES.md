# 第三方素材与许可

这个展示页使用第三方风格目录的元数据（名称、色板、字体、节奏、动效），并放入十二支 DrawAI 本地样片（扁平矢量、等轴 2.5D、拼贴、液态、包豪斯、合成器浪潮、玻璃拟态、综艺花字、贴纸科普、像素、赛博 HUD、水墨）和十二段本地中文提示词。页面不包含、也不引用第三方提示词、参考片或源码。`05-cel-boil`（小猫与红毛线）本轮未进展示页，其素材与许可记录也不在此列。

## mg-styles-15

- 来源：<https://github.com/Vincentwei1021/mg-styles-15>
- 固定提交：`49052d80bfaf9fa8412cc9710530e5e95a3b8d8c`
- 许可：MIT
- 使用范围：风格目录元数据（名称、色板、字体、节奏、动效签名）与移植说明的参考。**未使用 `prompts/` 提示词、`demos/` 源码或 `videos/` 参考片**。`04-3d-render` 不在 DrawAI 的支持范围内，未收录。
- 上游说明：项目代码、提示词、文档和影片为 MIT；VCSL 乐器采样、HDRI、纸张纹理、照片与 Natural Earth 地图数据为 CC0 / 公共领域；`site/vendor/highlight.min.js` 为 BSD-3；字形轮廓与 `demos/08-morph/glyphs.json` 为 OFL；字体文件不随上游仓库分发，使用前需自行确认字体许可。

MIT License

Copyright (c) 2026 Vincentwei1021

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## huashu-art-motion（23-ink-wash）

- 来源：<https://github.com/alchaincyf/huashu-art-motion>
- 许可：MIT
- 使用范围：`23-ink-wash` 的风格目录元数据。**未使用其提示词、配方或源码**。

MIT License

Copyright (c) 2026 alchaincyf (花叔 · 花生)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 本地样片的声音素材

十二支样片的画面均为 DrawAI 本地渲染，不包含第三方参考片画面。以下记录各支样片实际使用的声音来源与许可；`22-hud`、`20-pixel` 的声音记录见各自工程。新增三支均未经过人工试听。

### 07-liquid「IDEA BLOOM · 一滴灵感」

- 钢琴采样：VCSL Grand Piano `GPiano_sus_*`，**CC0-1.0**。
- 合成器 pad 与高光 chime：工程内合成，无第三方素材。
- 水滴/气泡 SFX，均为 Freesound **CC0-1.0**：
  - [fs:533146](https://freesound.org/people/mattfinarelli/sounds/533146/) *Drop - Water* / mattfinarelli
  - [fs:868281](https://freesound.org/people/Mihacappy/sounds/868281/) *droplet.wav* / Mihacappy
  - [fs:776443](https://freesound.org/people/chaferwitt/sounds/776443/) *pop out, bubble, soft bursting* / chaferwitt

### 09-bauhaus「PLAY THE DAY」

- BGM：[fs:636366](https://freesound.org/people/josefpres/sounds/636366/) *Piano loops 001 soft version short loop 120 bpm* / josefpres，**CC0-1.0**。
- SFX：
  - [fs:150382](https://freesound.org/people/orginaljun/sounds/150382/) *soft sound plastic button click* / orginaljun，[**CC-BY-3.0**](https://creativecommons.org/licenses/by/3.0/)
  - [fs:871926](https://freesound.org/people/heyheytheree/sounds/871926/) *Pop (Soft UI SFX Free)* / heyheytheree，[**CC-BY-4.0**](https://creativecommons.org/licenses/by/4.0/)
  - [fs:73263](https://freesound.org/people/junggle/sounds/73263/) *whoosh.soft.wav* / junggle，[**CC-BY-4.0**](https://creativecommons.org/licenses/by/4.0/)
  - [fs:876010](https://freesound.org/people/SignatureSoundsOrg/sounds/876010/) *Starry_UI_Click_63* / SignatureSoundsOrg，**CC0-1.0**
- CC-BY 素材要求署名；本段即署名记录，发布时请保留。

### 10-synthwave「NEON GROOVE · 让旋律点亮夜晚」

- 100 BPM 合成器流行 cue 由工程内 Node 脚本合成，48 kHz 立体声，无第三方音频素材。

### 23-ink-wash「雨过荷香」

- BGM：[fs:180239](https://freesound.org/people/iluppai/sounds/180239/) *Chinese flute Hulusi* / iluppai，**CC0-1.0**。
- SFX：[fs:273870](https://freesound.org/people/beskhu/sounds/273870/) *water drop 1.aif* / beskhu，**CC0-1.0**。

### 12-aurora-glass「NIGHT NOTE · 夜空电台」

- 环境铺底：[fs:620302](https://freesound.org/people/nlux/sounds/620302/) *Swirly Synth Chord Loop* / nlux，[**CC-BY-4.0**](https://creativecommons.org/licenses/by/4.0/)。
- 卡片出现：[fs:878621](https://freesound.org/people/Qvantor/sounds/878621/) *Heal Restore* / Qvantor，**CC0-1.0**。
- 字标出现：[fs:878433](https://freesound.org/people/zenosounds/sounds/878433/) *Crystal Notification Ping* / zenosounds，[**CC-BY-4.0**](https://creativecommons.org/licenses/by/4.0/)；工程内做过高通、低通与淡出处理。
- CC-BY 素材要求署名；本段即署名记录，发布时请保留。

### 18-hanazi「今天的小确幸」

- BGM：*Piano Happy Solo Sunset Loop Mastered* / szegvari，Freesound **CC0-1.0**。
- Pop：*The Best Bubble Pop Sound For Game and UI* / el_boss，Freesound **CC0-1.0**。
- Bubble：*Bubble Pop* / TheBuilder15，Freesound **CC0-1.0**。
- Chime：*Fantasy_ui_Button_6* / ZenithInfinitiveStudios，Freesound **CC0-1.0**。

### 19-paperclip「水滴的旅行」

- 100 BPM 轻拨弦与合成垫由工程内合成，48 kHz 立体声；水滴、蒸发、凝结、雨、循环五组音效也由工程内合成，无第三方音频素材。

### 01-flat-vector「GROW DAY · 一颗种子的奇妙生长」

声音修订版移除原时间轴的 31 条玻璃/钟琴提示音，改为 1 条配乐铺底 + 5 条音效 cue。以下为实际使用的第三方来源：

- BGM：[fs:830500](https://freesound.org/people/shaunhillyard/sounds/830500/) *A Ukulele Tune* / shaunhillyard，**CC0-1.0**；截取 0–11 秒并做高通、低通、轻度压缩与淡入淡出。
- 字标单音：[fs:218459](https://freesound.org/people/thomasjaunism/sounds/218459/) *Music box note* / thomasjaunism，**CC0-1.0**。
- 收尾钟音：[fs:10464](https://freesound.org/people/batchku/sounds/10464/) *gbell_9-2_pp.aif* / batchku，**CC0-1.0**。
- 落地、破土、绽放音效：工程内合成，无外部采样。
- 声音未经过人工试听；只做了响度、真峰值、频谱、音效数量与音画同步检查。

### 03-isometric「COAST CAFÉ · 漂浮的海边咖啡馆」

无闪修订版保留原音轨。声音均来自 Freesound，**CC0-1.0**：

- BGM：[fs:826622](https://freesound.org/people/xkeril/sounds/826622/) *Memories of a sweet summer (music) (loop)* / xkeril。
- 海浪：[fs:852826](https://freesound.org/people/kkenny101/sounds/852826/) *Gentle Ocean Waves Loop* / kkenny101。
- 杯碟：[fs:568758](https://freesound.org/people/bowlingballout/sounds/568758/) *Cup and Saucer 2.wav* / bowlingballout。
- 小船落水：[fs:853279](https://freesound.org/people/el_boss/sounds/853279/) *Fishing Lure Plop Water - Game SFX (2 or 2)* / el_boss。
- 工程内曾下载但未进入时间轴的候选：fs:478705、fs:842165、fs:189504；不作为本片声音来源。
- 声音未经过人工试听；修订只验证了原音轨逐样本一致、响度与解码。

### 06-collage「周末散步提案」

- 音乐：工程内程序合成，90 BPM、12 秒，软 FM 电钢/拨弦、暖垫、轻旋律与极轻底噪；无第三方音乐采样。
- 纸声：Freesound 两条 **CC0-1.0** 素材，经剪辑、低通与淡入淡出后作为拍入、滑动、撕纸与盖章音效：
  - [fs:642770](https://freesound.org/people/meeser9/sounds/642770/) *Paper shuffling.mp3* / meeser9
  - [fs:461694](https://freesound.org/people/leonelmail/sounds/461694/) *Paper crumpling and wadding into a ball softly 2* / leonelmail
- 制作限制：上游私有抠图与纸张素材缺失，参考帧接口不可用，本片以原创 Canvas2D 素材完成；自动化视觉 QA 的 `energy-ppt` 为 fail（12 fps 阶梯 + 静止贴纸的结构性低动能）。声音未经过人工试听。

`09-bauhaus` 与 `23-ink-wash` 使用的 Freesound 文件为 22.05 kHz 单声道 HQ 预览 MP3，工程重采样到 48 kHz；音质上限受预览文件限制。

## 字体

展示页只列出风格使用的字体名，不下载、不分发字体文件。风格元数据里的字体各自遵循其原始许可；复用到成片前请替换为可用字体或取得授权。

## 生成物

`showcase/media/` 只放 DrawAI 本地样片和封面。`showcase/native/prompts/` 只放本地中文提示词；两者都不包含第三方影片、提示词或源码。
