# DrawAI 风格放映室

独立静态站，展示 DrawAI 的 15 种整片风格：参考片、完整提示词、移植说明、上游源码和调用方式。它不嵌入插件，只从 `src/motion/mgstyles/` 读取数据，构建后发布到 GitHub Pages。

- 线上地址：<https://fourzkw.github.io/dsh-drawai/styles/>
- 页面入口：`showcase/template.html`
- 生成结果：`showcase/index.html`、`showcase/demos/`、`showcase/media/`（都不进 git）

## 本地

```powershell
npm install
npm run showcase:media   # 首次：下载 14 支上游参考片并转码 720p（约 420MB 源片）
npm run showcase:build   # 生成 index.html 和 demos/
npm run showcase:dev     # http://127.0.0.1:4173/
npm run showcase:check   # 结构、深链、媒体 manifest 检查
```

没有参考片也可以先构建：`showcase:build` 会为缺片风格渲染规格卡，`showcase:check -- --allow-missing-media` 会跳过媒体检查。

## 数据从哪来

| 内容 | 来源 |
| --- | --- |
| 风格清单、色板、字体、节奏 | `src/motion/mgstyles/catalog.json` |
| 提示词 | `src/motion/mgstyles/upstream/prompts/<slug>.md` |
| 移植说明 | `src/motion/mgstyles/briefs/<slug>.md` |
| 上游源码 | `src/motion/mgstyles/upstream/demos/<slug>/` |
| 参考片与封面 | mg-styles-15 固定 commit 的 `videos/`，转码后写入 `showcase/media/` |

`04-3d-render` 不在插件支持范围内，不展示；`23-ink-wash` 没有上游参考片，只展示配方、提示词和源码（来源 huashu-art-motion）。素材许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建与部署

- `tools/showcase-build.mjs`：把 catalog、brief、prompt、demo 文本渲染成静态 HTML；不依赖浏览器运行时。
- `tools/showcase-media.mjs`：用 `curl` 下载源片、`ffmpeg` 转 1280×720（18 为 720×1280）H.264，写 `media/manifest.json` 和 sha256。源片缓存在 `.cache/showcase/<commit>/`。
- `tools/check-showcase.mjs`：15 个 section、60 个 tab、深链、本地引用、14 条参考片和 manifest commit。
- `.github/workflows/pages.yml`：推 `develop` 或手动触发，构建后发布到 Pages 的 `/styles/`。首次使用需在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。

新增风格时只改 `src/motion/mgstyles/catalog.json` 和对应的 brief/prompt/demo，不需要改展示站代码；有参考片时在 `showcase-media.mjs` 的排除列表之外即可自动纳入。

## 许可

站点生成脚本和 DrawAI 代码遵循仓库的 MIT 许可。参考片、提示词与 demo 源码来自 mg-styles-15（MIT）；23 的配方来自 huashu-art-motion（MIT）。字体文件不随站点分发。
