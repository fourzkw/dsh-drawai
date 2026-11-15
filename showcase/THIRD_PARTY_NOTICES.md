# 第三方素材与许可

这个展示页使用第三方风格目录的元数据（名称、色板、字体、节奏、动效），并放入九支 DrawAI 本地样片（赛博 HUD、像素风、液态、包豪斯、合成器浪潮、水墨、玻璃拟态、综艺花字、贴纸科普）和九段本地中文提示词。页面不包含、也不引用第三方提示词、参考片或源码。

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

九支样片的画面均为 DrawAI 本地渲染，不包含第三方参考片画面。以下记录各支样片实际使用的声音来源与许可；`22-hud`、`20-pixel` 的声音记录见各自工程。

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

`09-bauhaus` 与 `23-ink-wash` 使用的 Freesound 文件为 22.05 kHz 单声道 HQ 预览 MP3，工程重采样到 48 kHz；音质上限受预览文件限制。

## 字体

展示页只列出风格使用的字体名，不下载、不分发字体文件。风格元数据里的字体各自遵循其原始许可；复用到成片前请替换为可用字体或取得授权。

## 生成物

`showcase/media/` 只放 DrawAI 本地样片和封面。`showcase/native/prompts/` 只放本地中文提示词；两者都不包含第三方影片、提示词或源码。
