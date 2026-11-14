# 第三方素材与许可

这个展示页把 **mg-styles-15** 的提示词和 demo 源码作为「上游参考」陈列，用来对照 DrawAI 的移植说明。页面本身不是 DrawAI 的成片，也不是上游项目的官方页面。**所有样片位当前留空，页面不包含、也不引用上游参考片。**

## mg-styles-15

- 来源：<https://github.com/Vincentwei1021/mg-styles-15>
- 固定提交：`49052d80bfaf9fa8412cc9710530e5e95a3b8d8c`
- 许可：MIT
- 使用范围：`prompts/` 提示词、`demos/` 文本源码。**未使用 `videos/` 下的参考片与封面**。`04-3d-render` 不在 DrawAI 的支持范围内，未收录。
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
- 使用范围：`23-ink-wash` 的风格配方、提示词与节选源码；`brush.js` 为逐字收录，`film.js` 依赖上游全局 `U` / `KIT` / `PAINT`，只作阅读参考。

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

## 字体

展示页只列出风格使用的字体名，不下载、不分发字体文件。demo 源码里出现的字体各自遵循其原始许可；复用到成片前请替换为可用字体或取得授权。

## 生成物

`showcase/demos/` 下的文本源码从上述固定提交复制而来，不进入 git，由 Pages 构建重新生成。`showcase/media/` 当前不存在；它只是后续放置 DrawAI 自产样片的目录，不包含任何上游影片或封面。
