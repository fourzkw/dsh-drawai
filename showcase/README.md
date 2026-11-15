# DrawAI 风格放映室

独立静态站，展示 DrawAI 的 15 种整片风格索引：移植说明、调用方式，以及九节的本地提示词和样片。它不嵌入插件，风格目录从 `src/motion/mgstyles/` 读取，构建后发布到 GitHub Pages。

页面编号按展示顺序编为 01–15；URL 深链仍使用风格库原始 slug（如 `#05-cel-boil`），所以页面编号和提示词文件名里的编号可能不同。

英雄区之后是「通用制作模板」（`#template`），说明“一条片子怎么交”：左边是七项填空提示，右边是模板正文，默认只露出开头，可展开，可整段复制或只复制【本次内容】。每个带提示词的风格节还有一个「套用模板」，会把该节的风格名、画幅与帧率、时长填进模板后再复制，省掉手抄。顶栏、英雄区和页脚都有指向它的入口。

**当前有九支本地样片和九段本地提示词**：`22-hud`（10 秒）、`20-pixel`（12.1 秒）、`07-liquid`（10.05 秒）、`09-bauhaus`（10.1 秒）、`10-synthwave`（10.1 秒）、`23-ink-wash`（12.1 秒）、`12-aurora-glass`（10.6 秒）、`18-hanazi`（10.1 秒，竖屏）、`19-paperclip`（12.05 秒）；其余风格不展示提示词，样片位为空。样片按作品实际长度播放，不强制 10 秒。

水墨样片保留已知不足：制作时参考帧接口不可用，改按施工包与源码推进；自动化质检 `energy-ppt` 未通过（多个镜头整体动能量偏低），声音未人工试听。它的提示词已合并首次主题、12 秒时间线与后续制作约束，要求先看关键帧、避免规则数字椭圆叶形、伞状辐射叶脉和透明矩形叠块，并在同一审美细节调整两轮仍不理想时保留可审阅版本。

- 线上地址：<https://fourzkw.github.io/dsh-drawai/styles/>
- 页面入口：`showcase/template.html`
- 生成结果：`showcase/index.html`（不进 git）

## 本地

```powershell
npm install
npm run showcase:build   # 生成 index.html
npm run showcase:dev     # http://127.0.0.1:4173/
npm run showcase:check   # 结构、深链、提示词与移植说明检查
```

## 数据从哪来

| 内容 | 来源 |
| --- | --- |
| 风格清单、色板、字体、节奏 | `src/motion/mgstyles/catalog.json`；`22-hud`、`20-pixel` 的本地参数用 `showcase/native/styles.json` 覆盖 |
| 提示词 | `showcase/native/prompts/<slug>.md`（`22-hud`、`20-pixel`、`07-liquid`、`09-bauhaus`、`10-synthwave`、`23-ink-wash`、`12-aurora-glass`、`18-hanazi`、`19-paperclip`） |
| 通用制作模板 | `showcase/native/prompt-template.md`；`## 提示词全文` 之后才是复制给 DrawAI 的正文，前面的说明只在仓库里看 |
| 移植说明 | `src/motion/mgstyles/briefs/<slug>.md` |
| 样片与封面 | `showcase/media/`（`manifest.json` + 九支 DrawAI 样片与同尺寸封面） |

`04-3d-render` 不在插件支持范围内，不展示；其余未附本地提示词的风格只展示移植说明。素材许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建与部署

- `tools/showcase-build.mjs`：把 catalog、brief、本地提示词和通用制作模板渲染成静态 HTML；不依赖浏览器运行时。只有 `showcase/native/prompts/` 里有文件的风格才显示提示词 tab，其余不显示提示词 tab。模板正文取 `## 提示词全文` 之后的部分，填空项和每节「套用模板」的数据（风格名、画幅帧率、时长）也在这里生成。
- `tools/check-showcase.mjs`：15 个 section、39 个 tab（九支提示词风格各 3 个，其余各 2 个）、深链、本地引用、9 个提示词展示块；未提供提示词的风格不显示提示词 tab；校验九支样片与 manifest 一致，并要求有本地提示词的风格都有对应样片。还会检查通用制作模板：`#template`、正文、7 个填空项、复制入口、`promptCount` 个「套用模板」按钮，以及指向它的入口链接。
- `.github/workflows/pages.yml`：推 `develop` 或手动触发，构建后发布到 Pages 的 `/styles/`。仓库已在 **Settings → Pages → Build and deployment → Source** 启用 **GitHub Actions**（2026-11-14）；若 `configure-pages` 报 `Resource not accessible by integration`，先确认这里仍是 GitHub Actions，再重跑工作流。

新增风格时只改 `src/motion/mgstyles/catalog.json` 和对应的 brief；需要提示词时把本地中文提示词放到 `showcase/native/prompts/<slug>.md`，并在 `showcase/native/styles.json` 里写本地色板/字体/节奏（可选）。以后有 DrawAI 样片时，把完整源片转成 H.264 MP4 放到 `showcase/media/`，按视频同尺寸生成 JPEG 封面，并在 `manifest.json` 里写实际宽高、容器时长、来源与 sha256；媒体文件随站点一起提交。

## 许可

站点生成脚本和 DrawAI 代码遵循仓库的 MIT 许可。页面使用的风格目录与移植说明参考了 MIT 许可的第三方资料；提示词和样片为本地创作。样片中的音乐与音效来源、作者和许可逐项见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。站点不分发任何第三方参考片、提示词或字体文件。
