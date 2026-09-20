# 登录流程 · 各画法渲染成品

同一张流程图，七种画法的对照。**源文件已按要求删除，这里只留渲染出来的图**（外加唯一保留的 DrawAI 源文件）。

内容完全相同：`开始 → 输入账号 → 校验 →（通过）进入首页 /（失败）回到输入账号`。
配色统一用 drawio 缺省调色板（绿 `#d5e8d4` / 蓝 `#dae8fc` / 黄 `#fff2cc`），截图并排摆不会因为配色差异显得不公平。

| 图 | 位图尺寸 | 这是哪一档 | 拍摄用途 |
|---|---|---|---|
| `rendered/01-mermaid.png` / `.svg` | 140×447 | 文本 DSL · Mermaid | 主流对照组 |
| `rendered/02-plantuml.png` / `.svg` | 221×367 | 文本 DSL · PlantUML 活动图 | 企业向对照组 |
| `rendered/03-graphviz.png` / `.svg` | 129×440 | 文本 DSL · Graphviz（**刻意无样式**） | **"AI 画的一坨"痛点画面** |
| `rendered/04-d2.svg` | 矢量 | 文本 DSL · D2 | 观感最好的对照组 |
| `README-mermaid.md` | 矢量（浏览器渲染） | **Markdown 文档 · ```mermaid 围栏块** | "图就长在文档里"这一档 |
| `08-ascii.md` | 纯文本 | **横杠 + 竖杠手画（`+ -` / `┌ ─ │`）** | **零依赖、源文件即成品** |
| `07-drawai.drawio` | 4 节点 / 4 边 | **DrawAI（唯一保留的源文件）** | 主角 |

**PNG 都只有一两百像素宽** —— 这不是失误，放大就糊，正好是"位图不可编辑"的素材。
要高分辨率就用同名的 `.svg`（矢量，随便放大）。

**最该给的一个镜头**：对着 01 / 03 里任意一张，想改个节点名字 —— 鼠标拖不动、点不进去，只能滚回去改源码。这就是"死板、无法编辑调整"的具体含义。

## 怎么渲的

走到服务端渲染是被逼的：这台机器上 `dot` / `d2` / `mmdc` 一个都没装；`npm install` 会 `EIDLETIMEOUT`；
Maven Central 直接超时；**本机 Chrome 也被沙箱拦住了**（`mojo platform_channel: 拒绝访问` —— Chrome 的 IPC 要开命名管道）。
所以最后用 [Kroki](https://kroki.io) 公共渲染服务：源文件 deflate + base64url 编码后请求它的 `/svg` 与 `/png`。

> ⚠️ 代价：这几张图的**内容发到了 Kroki 的公共服务器**。示例图无所谓，换成真实架构图就别这么走。

## 还差三样

| 缺什么 | 为什么 | 怎么补 |
|---|---|---|
| `rendered/04-d2.png` | Kroki 的 D2 位图输出返回 400（服务端没实现 D2 → 位图） | 装好 D2 后：`d2 04-d2.d2 04-d2.png` |
| `rendered/07-drawai.svg` | 只有 DrawAI 画布自己能导出 | 在右栏画布里打开 `07-drawai.drawio`，导出请求已排队，刷新即渲染 |
| 手写 SVG 一档 | 源文件本身就是成品，随源文件一起删了 | 需要的话可以按原样重建；**ASCII 那档已补**（见 `08-ascii.md`） |

---

*`07-drawai.drawio` 由 DrawAI 的 `diagram_apply` 生成（`layout: dagre-tb`）。*
