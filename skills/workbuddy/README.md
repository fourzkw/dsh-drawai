# workbuddy

用代码做视频的独立技能包：`wb` 命令 + 一份 vendor 的渲染引擎（Remotion + React + three/WebGL）。
不依赖 DrawAI 插件，也不需要画布。工程就是磁盘上的一个目录：

```
<工程>/
  timeline.json     画面轴：规格 + 每段起止帧 + 音轨
  scene-0.tsx …    一段一个 Remotion 组件
  storyboard.md    分镜表（六列）
  assets/          素材与字体
  .out/            film.mp4 / pilot.mp4 / 预览帧 / 任务记录
```

## 安装

```bash
cd skills/workbuddy
npm --prefix scripts install --omit=dev   # @babel/parser + @babel/traverse + npm（约 21MB）
node scripts/bin/wb.mjs doctor            # 看四件事：babel / 素材 / 视频运行时 / FFmpeg
```

布局按 WorkBuddy 技能市场的要求：根目录只有 `SKILL.md`（含 frontmatter）、`references/` 与 `scripts/`，可执行代码与依赖都在 `scripts/` 里。

渲染会在 `scripts/node_modules/.cache/webpack/` 里留打包缓存（约 100MB）；随时可删，下一次渲染会重建，不属于包的内容。

- **素材**（字体 / 素材库 / 材质，约 150MB 下载、解压后约 200MB）：`wb setup --install` 下载到 `~/.dsh/drawai-assets/v1`；已有就跳过。
- **视频运行时**（remotion / react / three，约 230MB）：第一次渲染自动装到 `~/.dsh/drawai-video-runtime/`，也可以 `wb setup --install` 提前装。
- **FFmpeg**（预览拼图 / 帧检 / 导出 / 混音要用）：`winget install --id Gyan.FFmpeg -e`（或 `scoop install ffmpeg`、`choco install ffmpeg`），也可以 `$env:WORKBUDDY_FFMPEG_PATH = "…\ffmpeg.exe"` 指一个现成的。
- **浏览器**：默认用系统 Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`），没有就退回 Edge；也可以用 `$env:WORKBUDDY_CHROME_PATH` 指定。引擎不会去下载 chrome-headless-shell。

`WORKBUDDY_*` 会被镜像成引擎认识的 `DRAWAI_*`（素材目录、运行时目录、FFmpeg、Python、浏览器），所以两套变量名都能用。

## 最短闭环

```bash
wb create --dir D:\work\demo --style 09-bauhaus --spec 1080x1920@30 --duration 12
wb preview --dir D:\work\demo --at 1,3        # 定调帧
wb render  --dir D:\work\demo --range 0,90    # 3 秒样片 → .out/pilot.mp4
wb render  --dir D:\work\demo                 # 整片 → .out/film.mp4
wb qa      --dir D:\work\demo                 # 帧检 + 响度
wb export  --dir D:\work\demo                 # 剪映素材包
```

详细说明在 [`SKILL.md`](./SKILL.md)，逐条命令在 [`references/commands.md`](./references/commands.md)。

要发到 WorkBuddy 技能市场时，打上传包（只含 `SKILL.md` + `references/` + `scripts/`，不含 `node_modules`，约 2.6MB）：

```bash
node tools/build-market-zip.mjs   # → dist/workbuddy.zip
```

在仓库里可以一条命令自检（拿 `.drawai-motion/n1-旧-人生三万天` 这个真实工程跑 preview → 样片 → 帧检 → 整片 → 剪映包）：

```bash
node tools/verify-skill.mjs --full
```

## 目录

- `scripts/bin/wb.mjs` — 命令入口（`wb help` 看全部）
- `scripts/lib/` — CLI 逻辑：`cli.mjs` 参数与环境、`project.mjs` 规格/分镜表/色板守卫、`ffmpeg.mjs` 找 FFmpeg、`commands/` 各命令实现
- `scripts/engine/` — vendor 的引擎（由仓库根 `node tools/build-skill.mjs` 生成，勿手改）
- `references/` — 命令手册、场景契约、工作流闸门、镜头卡与风格、故障排查
