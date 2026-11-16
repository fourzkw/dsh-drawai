# DrawAI 风格放映室

独立静态站，展示 DrawAI 的 15 种整片风格索引：移植说明、调用方式，以及十二节的本地提示词和样片。它不嵌入插件，风格目录从 `src/motion/mgstyles/` 读取，构建后发布到 GitHub Pages。

页面编号按展示顺序编为 01–15；URL 深链仍使用风格库原始 slug（如 `#05-cel-boil`），所以页面编号和提示词文件名里的编号可能不同。

英雄区之后是「通用制作模板」（`#template`），说明“一条片子怎么交”：左边是七项填空提示，右边是模板正文，默认只露出开头，可展开，可整段复制或只复制【本次内容】。每个带提示词的风格节还有一个「套用模板」，会把该节的风格名、画幅与帧率、时长填进模板后再复制，省掉手抄。顶栏、英雄区和页脚都有指向它的入口。

**当前有十二支本地样片和十二段本地提示词**：`01-flat-vector`（11 秒，声音修订版）、`03-isometric`（12.05 秒，无闪修订版）、`06-collage`（12 秒）、`22-hud`（10 秒）、`20-pixel`（12.1 秒）、`07-liquid`（10.05 秒）、`09-bauhaus`（10.1 秒）、`10-synthwave`（10.1 秒）、`23-ink-wash`（12.1 秒）、`12-aurora-glass`（10.6 秒）、`18-hanazi`（10.1 秒，竖屏）、`19-paperclip`（12.05 秒）。`02-line-art` 保持空槽位，没有视频、封面、提示词或清单记录。`05-cel-boil`（小猫与红毛线）本轮暂不进展示页：成片与提示词留在本地，不写进清单、不出现在页面上。样片按作品实际长度播放，不强制 10 秒。

新增三支的来源与取舍：

- `01-flat-vector` 使用 `seed-garden.drawai.media/clip-3`（与新版主节点 `clip-1` 相同），不是旧声音版 `clip-2`。原始创作提示词从 DSH 会话中按 `type=user/message`、`seq=9` 取出；后续声音修订单独成段。用户说的“高频率”后来明确指音效**出现次数**太频繁，不是音频频谱的高频；最终修订把 31 条玻璃/钟琴 cue 降到 5 条，保留 11 秒画面。
- `03-isometric` 使用 `coast-cafe-isometric-remake.drawai.media/clip-3`（无闪修订版），不是旧版 `clip-2`。提示词按实际顺序分为原始创作与无闪修订两次；原片在 135–136、285–286 等镜头边界的整屏暗跳已修订，旧版媒体与备份仍保留在工程中，未被覆盖。
- `06-collage` 使用 `collage-weekend-walk.drawai.media/clip-2`，是完整 12 秒成片，不是 pilot。制作时上游私有抠图与纸张素材缺失，`mg_style frames` 无法生成参考帧，只能按施工包与源码以原创 Canvas2D 素材完成；自动化视觉 QA 的 `energy-ppt` 为 fail（12 fps 阶梯与静止贴纸带来的结构性低动能），属于已知不足，不是无动作。

三支新增样片都**没有经过人工试听**；声音结论仅来自电平、峰值、频谱、同步与容器检查，不能当作听感通过。

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
| 风格清单、色板、字体、节奏 | `src/motion/mgstyles/catalog.json`；`22-hud`、`20-pixel`、`01-flat-vector`、`03-isometric`、`06-collage` 的本地参数用 `showcase/native/styles.json` 覆盖 |
| 提示词 | `showcase/native/prompts/<slug>.md`（`01-flat-vector`、`03-isometric`、`06-collage`、`07-liquid`、`09-bauhaus`、`10-synthwave`、`12-aurora-glass`、`18-hanazi`、`19-paperclip`、`20-pixel`、`22-hud`、`23-ink-wash`） |
| 通用制作模板 | `showcase/native/prompt-template.md`；`## 提示词全文` 之后才是复制给 DrawAI 的正文，前面的说明只在仓库里看 |
| 移植说明 | `src/motion/mgstyles/briefs/<slug>.md` |
| 样片与封面 | `showcase/media/`（`manifest.json` + 十二支 DrawAI 样片与同尺寸封面） |

`04-3d-render` 不在插件支持范围内，不展示；其余未附本地提示词的风格只展示移植说明。素材许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建与部署

- `tools/showcase-build.mjs`：把 catalog、brief、本地提示词和通用制作模板渲染成静态 HTML；不依赖浏览器运行时。只有 `showcase/native/prompts/` 里有文件的风格才显示提示词 tab，其余不显示提示词 tab。模板正文取 `## 提示词全文` 之后的部分，填空项和每节「套用模板」的数据（风格名、画幅帧率、时长）也在这里生成。
- `tools/check-showcase.mjs`：15 个 section、深链、本地引用；按实际提示词数量计算 tab（当前 42 个）与提示词展示块（当前 12 个），并校验通用制作模板：`#template`、正文、7 个填空项、复制入口、`promptCount` 个「套用模板」按钮，以及指向它的入口链接。它要求当前列出的 12 段提示词和 12 支样片都存在，但不把“恰好 12 条”或“永久禁止 `02-line-art`”写成固定规则；本次清单中 `02-line-art` 与 `05-cel-boil` 都没有提示词、媒体记录或渲染样片。
- `.github/workflows/pages.yml`：推 `develop` 或手动触发，构建后发布到 Pages 的 `/styles/`。仓库已在 **Settings → Pages → Build and deployment → Source** 启用 **GitHub Actions**（2026-11-14）；若 `configure-pages` 报 `Resource not accessible by integration`，先确认这里仍是 GitHub Actions，再重跑工作流。

新增风格时只改 `src/motion/mgstyles/catalog.json` 和对应的 brief；需要提示词时把本地中文提示词放到 `showcase/native/prompts/<slug>.md`，并在 `showcase/native/styles.json` 里写本地色板/字体/节奏（可选）。以后有 DrawAI 样片时，把完整源片转成 H.264 MP4 放到 `showcase/media/`，按视频同尺寸生成 JPEG 封面，并在 `manifest.json` 里写实际宽高、容器时长、来源与 sha256；媒体文件随站点一起提交。

## 许可

站点生成脚本和 DrawAI 代码遵循仓库的 MIT 许可。页面使用的风格目录与移植说明参考了 MIT 许可的第三方资料；提示词和样片为本地创作。样片中的音乐与音效来源、作者和许可逐项见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。`06-collage` 的参考帧限制与低动能 QA 见上文。站点不分发任何第三方参考片、提示词或字体文件。
