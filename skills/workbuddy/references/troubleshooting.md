# 排障对照

先跑 `wb doctor`。四行里哪行是 ✗ 就先修那一行，别急着看别的。

```
node / babel   技能根有没有装依赖
素材           字体与内置素材库（~/.dsh/drawai-assets/v1，约 210MB）
运行时         Remotion + React + three（隔离目录，不进技能包）
ffmpeg         拼图、贴片、混音、帧检都靠它
```

---

## 卡在 "bundling 10%" 不动

**不是打包慢，是在下载浏览器。**

Remotion 的 `ensureBrowser` 只认 `browserExecutable`：不传就去 `storage.googleapis.com` 拉 chrome-headless-shell（约 150MB）。没网时表现成一条命令永远不返回。

- 技能包已经在 `motion-render-worker.js` 里给 `selectComposition` / `renderStill` / `renderMedia` 都传了 `browserExecutable`（`tools/build-skill.mjs` 的 PATCHES），正常情况下不会触发。
- 还是卡住：确认机器上有 Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`）或 Edge，或者显式指定：

```powershell
$env:WORKBUDDY_CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:DRAWAI_CHROME_PATH    = $env:WORKBUDDY_CHROME_PATH
```

- 另一个隐藏触发点：Remotion 的浏览器缓存目录是从 **cwd 向上找第一个含 `package.json` 的目录**再拼 `node_modules/.remotion`。在技能根目录里跑命令时那个目录可能不存在；`wb` 已通过传 `browserExecutable` 绕过这条路径，但**手写一次性节点脚本**（直接 import 引擎）时要注意这一点。

## 命令卡住 / 磁盘上出现 0 字节的 download.zip

引擎在找不到 FFmpeg 时会**自动下载**（gyan.dev / BtbN，约 100MB），没网就一直等。

```powershell
wb doctor                      # 看 ffmpeg 那行
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
# 或
scoop install ffmpeg
choco install ffmpeg
```

装完如果 `wb doctor` 还是 ✗，用手动路径指过去（winget 的 Links 目录有时是空的，`wb` 会去 `LOCALAPPDATA\Microsoft\WinGet\Packages\*ffmpeg*\bin\ffmpeg.exe` 里找，找不到就靠这个变量）：

```powershell
$env:WORKBUDDY_FFMPEG_PATH = "C:\Users\<你>\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_...\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe"
```

`wb` 自己**从不下载 FFmpeg**（下载会挂死，而且用户看不见）；只有 `wb setup --install` 会尝试。

## 首次渲染要装 230MB 运行时

视频运行时（Remotion 4 + React 19 + three）装在 `~/.dsh/drawai-video-runtime/<key>`，`key` 里含平台/架构/**node 主版本**。第一次 `preview` / `render` 会从 npm 装（约 230MB，几分钟）。

- 换 node 大版本会再装一份；`wb doctor` 里的"期望目录"就是当前 node 对应的那份。
- 想复用已有的：`$env:WORKBUDDY_VIDEO_RUNTIME_DIR = "C:\Users\<你>\.dsh\drawai-video-runtime\<已有key>"`（跨 node 主版本复用有原生模块不兼容的风险，装不动时再试）。
- 完全离线：在另一台机器装好后整目录拷过来。

## 素材没就位

`~/.dsh/drawai-assets/v1` 里应有 164 个文件（字体 + 内置素材库）。缺了 `wb setup --install` 会从 GitHub Release 下载；也可以 `$env:WORKBUDDY_ASSETS_DIR` 指向一份已有的。

素材只影响"字体解析"和 `wb assets library`；工程里已经拷进 `assets/fonts/` 的字体不依赖它。

## 「字体没注册，拒绝渲染」

工程声明的字体族在源码里找不到 `@font-face` / `loadFont` / 字体文件。浏览器不会报错，只会静默退回系统字体，字宽全变——所以这是硬拦。

- 用 `theme.ts` 里已有的族（`SANS` / `SERIF` / `MONO`），或把字体文件放进 `assets/` 后 `loadFont()`。
- 真要用系统字体：在 `STYLE.md` 写一行 `偏离：字体 <族名> 用系统字体，因为 <原因>`。

## 「引擎不符合风格要求，拒绝渲染」

你选了 three / WebGL2 的风格，但工程源码里没有真的用那个引擎。

- 按 `STYLE.md` 的引擎契约写（`<canvas>` + `getContext("webgl2")` / `three` 的 `WebGLRenderer`）。
- 或者写偏离行：`偏离：引擎 webgl2 改为 Canvas2D，因为 …`，渲染带 warning 通过。

## 「场景组件缺失：shot-3」

`index.jsx` 里没有 `shot-3` 的注册，或 `timeline.shots[i].file` 指向的文件不存在。

- 正常情况 `wb preview` / `wb render` 会自动重写 `index.jsx`；如果报这个，先看 `wb open` 有没有列出缺文件。
- 手改过 `index.jsx` 的话，删掉它再跑一次 `wb preview`（会重新生成）。

## 拼图只有一格 / 拼图和上次一样

- **只有一格**：早期版本的 bug（同批帧 rgba 与 rgb24 混排时 ffmpeg 只解第一格），现在每帧先各自转 `format=rgba` 再拼；如果还遇到，先 `wb doctor` 确认 ffmpeg 是完整版（Gyan full build / BtbN），不是 Remotion 自带的精简版。
- **和上次一样**：拼图缓存在 `.out/qa/.sheet-<hash>/sheet.png`，目录名由帧路径列表决定，帧没变就复用。看文件的 mtime。

## 「帧数 61 与时间轴 96 不一致」

检**样片**时必然出现。`wb qa` 默认按整片时间轴核对帧数；样片是片段，用 `--file .out/pilot.mp4` 时忽略这一条即可，别的检查（黑场、闪烁、响度）照常有效。

## 渲染任务不见了 / 不知道跑到哪

```bash
wb render list
wb render status            # 最近一条
wb render status --job job-20261108-041530-ab12
```

任务记录在 `<工程>/.out/jobs/<id>.json`，`status` 是 `running|done|error|cancelled`，`phase` 是 `bundling|rendering|encoding|mixing`。取消：`wb render cancel --job <id>`（写 `.cancel` 标记 + 杀进程）。

## `fork EPERM` / 渲染进程起不来

引擎用 `fork()` 起渲染子进程。在受限沙箱（只允许写工作区、禁止创建子进程管道）里会 `EPERM`。渲染需要在**非受限环境**里跑；如果这个会话是受限的，就换一个全权限会话，或让用户在本机终端里直接跑 `wb render`。

## 其它

| 现象 | 处理 |
| --- | --- |
| `Cannot find module '@babel/parser'` | 技能根没装依赖：`cd <技能根> && npm install`（或 `wb setup --install`） |
| `npm` 找不到 | 视频运行时要用 npm 安装依赖；把 node 自带的 npm 放进 PATH |
| 改了引擎想重新生成 | `node tools/build-skill.mjs`（会覆盖 `engine/`，不动 `lib/`、`bin/`、`SKILL.md`） |
| 引擎补丁失效报错 | 插件升级改了被补丁的代码；去 `tools/build-skill.mjs` 的 `PATCHES` 里对一下新代码 |
| `Invoke-WebRequest` 报「非交互模式」 | 这个环境的 PowerShell 不能交互式联网；用 `wb` 自己的命令或 `curl.exe` |
| 音量忽大忽小 | 检查是不是叠了响度归一：样片不归一（正常），整片才归一到 −16 LUFS |
