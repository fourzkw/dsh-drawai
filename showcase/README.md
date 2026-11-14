# DrawAI 风格放映室

独立静态站，展示 DrawAI 的 15 种整片风格：样片位、完整提示词、移植说明、上游源码和调用方式。它不嵌入插件，只从 `src/motion/mgstyles/` 读取数据，构建后发布到 GitHub Pages。

**样片位当前全部留空**，不引入 mg-styles-15 的参考片；页面只渲染规格卡。以后只放 DrawAI 自己生成的样片。

- 线上地址：<https://fourzkw.github.io/dsh-drawai/styles/>
- 页面入口：`showcase/template.html`
- 生成结果：`showcase/index.html`、`showcase/demos/`（都不进 git）

## 本地

```powershell
npm install
npm run showcase:build   # 生成 index.html 和 demos/
npm run showcase:dev     # http://127.0.0.1:4173/
npm run showcase:check   # 结构、深链、提示词与源码检查
```

## 数据从哪来

| 内容 | 来源 |
| --- | --- |
| 风格清单、色板、字体、节奏 | `src/motion/mgstyles/catalog.json` |
| 提示词 | `src/motion/mgstyles/upstream/prompts/<slug>.md` |
| 移植说明 | `src/motion/mgstyles/briefs/<slug>.md` |
| 上游源码 | `src/motion/mgstyles/upstream/demos/<slug>/` |
| 样片与封面 | 暂未提供；`showcase/media/` 留给后续 DrawAI 样片 |

`04-3d-render` 不在插件支持范围内，不展示；`23-ink-wash` 没有样片，只展示配方、提示词和源码（来源 huashu-art-motion）。素材许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建与部署

- `tools/showcase-build.mjs`：把 catalog、brief、prompt、demo 文本渲染成静态 HTML；不依赖浏览器运行时。没有样片 manifest 时，15 个样片位全部渲染成规格卡。
- `tools/showcase-media.mjs`：已移除；不再下载或转码 mg-styles-15 的参考片。
- `tools/check-showcase.mjs`：15 个 section、60 个 tab、深链、本地引用和提示词展示块；不会要求样片存在。
- `.github/workflows/pages.yml`：推 `develop` 或手动触发，构建后发布到 Pages 的 `/styles/`。仓库已在 **Settings → Pages → Build and deployment → Source** 启用 **GitHub Actions**（2026-11-14）；若 `configure-pages` 报 `Resource not accessible by integration`，先确认这里仍是 GitHub Actions，再重跑工作流。

新增风格时只改 `src/motion/mgstyles/catalog.json` 和对应的 brief/prompt/demo，不需要改展示站代码；以后有 DrawAI 样片时，放到 `showcase/media/` 并写 `manifest.json` 即可被构建读取。

## 许可

站点生成脚本和 DrawAI 代码遵循仓库的 MIT 许可。提示词与 demo 源码来自 mg-styles-15（MIT）；23 的配方来自 huashu-art-motion（MIT）。站点不分发任何上游参考片或字体文件。
