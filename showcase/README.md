# DrawAI 风格放映室

独立静态站，展示 DrawAI 的 15 种整片风格：样片、完整提示词、移植说明和调用方式。它不嵌入插件，只从 `src/motion/mgstyles/` 读取数据，构建后发布到 GitHub Pages。

页面编号按展示顺序编为 01–15；URL 深链仍使用风格库原始 slug（如 `#05-cel-boil`），所以页面编号和提示词文件名里的编号可能不同。

**已放入两支 DrawAI 自产样片**：`22-hud`（10 秒）和 `20-pixel`（12.1 秒）；其余样片位留空。样片按作品实际长度播放，不强制 10 秒。

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
| 风格清单、色板、字体、节奏 | `src/motion/mgstyles/catalog.json` |
| 提示词 | `src/motion/mgstyles/upstream/prompts/<slug>.md` |
| 移植说明 | `src/motion/mgstyles/briefs/<slug>.md` |
| 样片与封面 | `showcase/media/`（`manifest.json` + 两支 DrawAI 样片） |

`04-3d-render` 不在插件支持范围内，不展示；`23-ink-wash` 没有样片，只展示配方和移植说明。素材许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建与部署

- `tools/showcase-build.mjs`：把 catalog、brief、prompt 渲染成静态 HTML；不依赖浏览器运行时。有样片 manifest 时渲染已配置的样片，其余样片位留空。
- `tools/check-showcase.mjs`：15 个 section、45 个 tab、深链、本地引用和提示词展示块；校验已配置的两支样片与 manifest 一致。
- `.github/workflows/pages.yml`：推 `develop` 或手动触发，构建后发布到 Pages 的 `/styles/`。仓库已在 **Settings → Pages → Build and deployment → Source** 启用 **GitHub Actions**（2026-11-14）；若 `configure-pages` 报 `Resource not accessible by integration`，先确认这里仍是 GitHub Actions，再重跑工作流。

新增风格时只改 `src/motion/mgstyles/catalog.json` 和对应的 brief/prompt，不需要改展示站代码；以后有 DrawAI 样片时，放到 `showcase/media/` 并更新 `manifest.json`，媒体文件随站点一起提交。

## 许可

站点生成脚本和 DrawAI 代码遵循仓库的 MIT 许可。页面使用的提示词与配方基于 MIT 许可的第三方资料整理，版权与许可全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。站点不分发任何第三方参考片或字体文件。
