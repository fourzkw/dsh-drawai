# dsh-drawai

DSH 右侧栏的 **draw.io 风格画布** + 让 AI 直接绘图的**语义工具**。

图 = 工作区里的一个 `.drawio` 文件（drawio 自己的格式）。人、AI、drawio 改的都是同一个文件，画布订阅变更流自动重绘。

---

## 能力现状

**已实现**

| 半边 | 能力 |
|---|---|
| 宿主 | `diagram_apply`：结构化 ops（`addNode`/`addEdge`/`setLabel`/`setStyle`/`remove`）→ 分层自动布局 → 原子写回 |
| 宿主 | `diagram_read`：读回节点/边/标签/**style 键**（并给出派生的形状/线型/箭头/颜色名便于阅读） |
| 宿主 | 语义校验：边指向不存在的节点直接报错并列出已知 id，**写盘之前**失败 |
| 宿主 | 稳定 id 分配（`n1…` / `e1…`）、按字符宽度估算节点尺寸 |
| 宿主 | 自动布局四种：`dagre-tb`（默认，贴合右栏窄高形状）/ `dagre-lr` / `grid` / `none`；显式重排会清掉端点已移动的边上的**过期折点** |
| 宿主 | **载体就是 `.drawio`**：读写 drawio 的 mxfile 本身（含压缩形态）。`revision` 是**文件内容指纹**，所以 drawio 或别的编辑器改过文件，乐观锁照样准 |
| 宿主 | **无损写回**（见下一节）：只在原文件上改我们拥有的单元，其余原文逐字节保留；打开后原样保存 = 文件一个字节都不变 |
| 客户端 | 右栏 tab 类型 `drawai:diagram`（`kind: diagram`），认领 `**/*.drawio` |
| 客户端 | **文档由宿主读**（`action: 'read'`）：浏览器没有 zlib，drawio 压过的 mxfile 客户端解不开，所以解析器只有宿主那一份 |
| 客户端 | **工作栏在标签页之上**：`文件 / 编辑 / 视图 / 导出` 常驻在面板最上方，下面才是多画布标签条，再下面是画布。一张画布都没有时它也在（否则「新建/打开」就点不到了） |
| 客户端 | **打开后为空**：进入面板时不预先开任何画布（没有"未绑定画布"这种中间态），用「文件 → 新建画布…」或「文件 → 打开…」开始；关掉最后一个标签就回到这个空舞台 |
| 客户端 | 「打开…」列出的每一个 `.drawio` 都能直接打开；文件里"画布表示不了、但会原样保留"的东西（多页、图层、图片、HTML 标签）在工作栏上一句句说明 |
| 客户端 | draw.io 经典外观：9 种形状（由 `shape=`/`ellipse`/`rhombus`/`rounded=`/`arcSize=` 驱动）、8 色 mxGraph 调色板（`fillColor`/`strokeColor`）、白纸 + 网格、正交折线 + 障碍避让、边标签衬底、自动换行、明暗切换 |
| 客户端 | **拖拽连线预览**：从四面的引出端点拖出线时，实时显示**与落盘同一套路由**算出的正交折线（不是直线）；靠近目标节点时列出它的**四个端点**并高亮将连接的那个（可挪指针改选），折线终点贴到该端点 |
| 客户端 | **多选对齐 / 分布**：Shift 加选后右键 → 左/中/右、顶/中/底对齐，水平/垂直等距 |
| 双方 | **连线画法**：线型（实线/虚线/点线，含 `dashPattern` 间距）× 箭头（单向/双向/无/反向）× 颜色 × 折角圆滑 × 引出段长度（`jettySize`）—— 全部是**文档里的 drawio style 键**，与 drawio 同构 |
| 客户端 | 刷新：宿主变更流 `remote.workspaceFiles.changes()` 为主 + 5s 低频轮询兜底 |
| 客户端 | **视口不随容器尺寸变化**：拖右栏改宽度时保持缩放比例、只改变可见范围（`resizeViewFor`）—— 否则右栏一拖画面就跟着缩放，且视口宽高比与容器失配后会被 `preserveAspectRatio="none"` 拉扁 |
| 客户端 | **自环**：把线拖回起点节点自己即可（进出口自动错开，同侧会原路折回、看不见）；复制 / 粘贴 / 剪切（`Ctrl+C/X/V`，剪贴板跨标签页，只搬两端都在选区内的边） |
| 客户端 | **拖到空白处 = 悬空端**：新建连线落在空白处会连出一条"还没接上"的线；端点拖到空处就**脱离形状**（数据层用 `targetPoint`/`sourcePoint`，与 drawio 一致），再拖回节点上就重新接上 |
| 客户端 | **顺序**：节点/边的右键菜单有「置顶 / 上移 / 下移 / 置底」；模型顺序决定覆盖顺序，写回会真的改动文件里单元的先后 |
| 客户端 | **编辑数据**：右键「编辑数据…」按 `key=value` 一行一项改 drawio 用户对象的自定义属性；裸单元第一次加数据会自动包成 `<object>`（不包的话 drawio 保存时会把属性丢掉） |
| 客户端 | 读 drawio 的**独立边标签单元**（`edgeLabel`）：按 `mxGraphView.getPoint` 的规则算位置（沿边比例 + 垂直偏移 + 残余偏移）并只读显示 |
| 客户端 | 走线里**不会出现折返段**（出去又原路描回来）：选 L 时避开折返，残余的（目标侧桩点与折点分居拐点两侧时）由 `removeRetraces` 消掉 —— 人摆的折点当尖点时不动 |
| 客户端 | **快捷键有归属判定**：焦点在输入框（DSH 的输入框是 Lexical 的 `contenteditable`，事件目标常常还是它内部的 span）、或别的面板的控件上时，画布一个键都不碰 —— 否则在输入框里按退格会删掉画布里的选中内容，`Ctrl+C/V` 也会被 `preventDefault` 吞掉 |
| 客户端 | **一次性几何迁移**：菜单「整理几何（吸附到格线）」把这张画布对齐到格线；`node tools/snap-geometry.mjs [--write]` 面向盘上已有文件做一次性迁移 |

**未实现**：设置页、**图层**（新建/隐藏/锁定/切换：文件里的图层结构目前原样保留，
但画布把它们叠在一起显示、新建的单元都落在第一个图层）、分组/子图的**画布内编辑**
（层级在文件里保留，但画布按绝对位置显示）、多页的切换与新建、
`.drawio.svg`/`.png`/`.html` 内嵌载体；另外**所有边都画在所有节点下面**
（drawio 是按单元顺序混合层叠），所以"让某条边压在某节点上"还不成立。

---

## 载体：`.drawio` 就是真相

画布文件是 **drawio 自己的 mxfile**（`.drawio`）。没有"我们自己的格式 + 导入导出"这一层：
drawio 打开它、画布打开它、AI 改它，改的都是同一份文件。

**难点不在读，在写。** drawio 的能力比本画布大（多页、图层、分组层级、图片、HTML 标签、
UserObject 自定义属性、旋转翻转、页面设置…），而本画布只理解其中一个子集。如果写回是
"按模型重新生成整份 XML"，用户稿子里那些我们不理解的部分会在保存时**被悄悄删掉** ——
"悄悄"是最糟的失败方式（用户以为在编辑，其实在删）。所以写回是**外科手术**：

| 规则 | 说明 |
|---|---|
| 页 1 的 `<root>` 之外 | 其他页、mxfile 属性、空白 —— **逐字节保留** |
| 我们拥有的单元（节点/边） | 只重写 `value`/`style`/几何/端点这几处属性；`<object>` 包装上的自定义属性、`<mxRectangle as="alternateBounds">` 原样留着 |
| 我们不认识的单元 | 原样留着（例如两端都没落点的边），不因为不认识就删 |
| 只有"我们导入过、模型里又没有了"的单元 | 才删 —— 那才是用户真的删了它 |
| 压缩形态 | 原本压缩的页体，写回后仍然压缩 |
| 容器子单元 | 坐标在文件里是**相对父级**的：读出来累加、写回去减掉。容器被删时，子单元被接到还活着的祖先上并补回坐标差（不留悬空 `parent`） |
| 元数据 | `meta.pinned`（人摆过版面，AI 别重排）存成文件里一个隐藏的 `<object drawaiMeta drawaiPinned>` 单元；`revision` **不落盘**，直接用文件内容的指纹 |

由此得到一条可断言的性质：**打开后原样保存，文件逐字节不变**（`check-mxfile` 里 30 多条断言盯着它）。

**有损的地方一律如实报。** 多页只显示第 1 页、分组按绝对位置显示、图片按矩形显示、HTML 标签
按纯文本显示、边标签单元（drawio 的 `edgeLabel`：样式带 `edgeLabel`、几何 `relative="1"`，
它是个 vertex 但既不是形状也不是容器）不显示 —— 这些都会作为 `notes` 出现在工作栏和
`diagram_read` 的返回里，因为用户会拿这份文件继续在 drawio 里编辑，不说明就等于骗人。

> 边标签单元这一条同时是**安全**问题：把它当成普通节点读进来，画布上会多一个鬼影框，
> 一旦被拖动，写回就会把**绝对坐标**写进一个"相对"几何里，把 drawio 里的标签偏移弄歪。
> 所以这类单元一律**不导入、不拥有、原样保留** —— 不拥有，才不会在"模型里没有它"时
> 被当成用户删除而抹掉（见 `ownershipOf` 与 check-mxfile 的「边标签单元」一节）。

**旧格式（`.dshd.json`）已经彻底退场。** 仓库里不再有这种文件，也不再有迁移脚本 ——
需要从旧版本升上来的话，用 git 历史里的那一版：
`git show 873a835:tools/migrate-dshd.mjs > migrate.mjs && node migrate.mjs`（它不删旧文件、
不覆盖已有目标）。

---

## 数据格式：文档层仍按 drawio 的语义组织

宿主与客户端在内存里交换的是一份**语义文档**（不是文件本身），字段按 drawio 的语义组织：
形状、配色、线型、箭头、端点约束都是 drawio 的 style 键，没有自己的一套封闭枚举。键名逐个对着
drawio 源码核实过（`mxConstants.js`、`Graph.js`、`mxConnector.js`、`docs/claude/libavoid-routing.md`），
所以同一个文件在 `drawio → 本插件 → drawio` 之间往返不会丢东西。

```jsonc
{
  "version": 2,
  "revision": "9f2c1a4b7e03",           // = 文件内容指纹，不落盘
  "meta": { "pinned": true },
  "nodes": [
    { "id": "doc", "label": "真相源", "style": "shape=document;fillColor=#fff2cc;strokeColor=#d6b656;",
      "x": 60, "y": 60, "w": 186, "h": 86 }
  ],
  "edges": [
    { "id": "e2", "from": "doc", "to": "canvas", "label": "变更流",
      "style": "edgeStyle=orthogonalEdgeStyle;rounded=0;jettySize=auto;orthogonalLoop=1;html=1;endArrow=classic;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" }
  ]
}
```

三条规则，与 drawio 一致：

1. **默认值一律省略。** `Graph.prototype.defaultVertexStyle = {}` —— 普通矩形就是**空样式**
   （"rect = 没有 shape 键"）。`endArrow` 缺省 = 不画箭头（`mxConnector` 拿 `NONE` 当缺省）。
2. **开放键值集合。** 认不出的键**原样保留、原样写回**，只是不认识就不渲染 —— 于是 drawio 导出的
   文件在这里编辑一轮再拿回去，陌生键不会消失（v1 的"认不出的只能丢"就是这么修掉的）。
3. **折点与端点是两套模型。** `points` 只放人摆的折点；"从哪一侧进出"是 `exitX/exitY`（源端）与
   `entryX/entryY`（目标端）的**比例约束**（0 / 0.5 / 1 = 左·中·右、上·中·下）；悬空端的自由点才是
   `sourcePoint`/`targetPoint`，且仅在该端**没有**真实顶点时生效（`mxGeometry` 的原话）——
   悬空边照常渲染（v1 会把它整条丢掉），两端都悬空也能画。

| 用途 | 键（drawio 名） |
|---|---|
| 形状 | `shape=`、`ellipse`、`rhombus`、`rounded=`、`arcSize=` |
| 配色 | `fillColor`、`strokeColor`、`fontColor`、`strokeWidth` |
| 线型 | `dashed=1`、`dashPattern`（画布缺省 `3 3`） |
| 箭头 | `endArrow`、`startArrow`（`classic` / `none` / …） |
| 路由 | `edgeStyle=orthogonalEdgeStyle`（`none` = 直线）、`rounded=`（折角是否圆滑） |
| 端点 | `exitX`/`exitY`、`entryX`/`entryY`、`jettySize`（引出段长度，数字或 `auto`） |
| 避让 | `libavoidRouting=1`（drawio 里它就是一个 per-edge 键） |
| 文本 | `html=1`、`whiteSpace=wrap`、`fontSize`、`fontColor` |

> **哪些键真的驱动渲染**：形状 / 配色 / 线型（含 `dashPattern` 间距）/ 箭头 / 路由（`edgeStyle=orthogonalEdgeStyle`
> 与 `none` 直线）/ 折角（`rounded`）/ 端点约束（`exitX·exitY`、`entryX·entryY`）/ `jettySize` /
> `fontSize`·`fontColor`·`whiteSpace` 都**真正生效**；而 `html=1`（本画布始终按纯文本渲染标签）、
> `endSize`·`startSize`·`endFill` 这类箭头几何、`libavoidRouting`（本画布的路由本来就带避让惩罚）
> 以及任何陌生键，只是**原样保留**、不影响画面 —— 这不影响往返：它们不会丢。

**工具语言 ≠ 文档语言。** AI 侧的 ops 仍然收 `shape:'diamond'`、`dash:'虚线'`、`arrow:'双向'`、
`style:'yellow'`、`exit:'e'` 这些**糖**，宿主翻成上面的键再落盘；`keys:{…}` 用来写任意 drawio 键
（值给 `null` = 删键回缺省）。drawio 自己也是这个分工：面板上给名字，文档里只有十六进制。

**只有一种格式。** `.dshd.json` 那套语义枚举（`shape:'rect'`、`style:'blue'`、`dash:'dashed'`、
把进出侧混在 `points` 里的桩点）随载体切换一起退场了 —— 连同它的读时升级代码。留着一份
"另一种格式的迁移"只会让人以为还有第二种真相。

## mxfile 读写细节

drawio 的文件就是 mxfile：`<mxfile><diagram><mxGraphModel><root>` 里一堆
`<mxCell id value style parent source target vertex edge>` + `<mxGeometry>`。文档层已经
按同样的语义组织（见上一节），所以**style 串是原样搬运的** —— 颜色、虚线、箭头、
`exitX/exitY` 到了 drawio 里还是那些键，不需要翻译；真正要翻译的只有**几何与结构**：

| 结构 | 读进来 | 写回去 |
|---|---|---|
| 顶点 | `mxGeometry@x/y/width/height`；**容器子单元的坐标是相对父级的**，沿 `parent` 链累加成绝对坐标 | 按"画布上的绝对坐标 − 父链偏移"反算回相对坐标 |
| 单元 id | `id` 一般在 `mxCell` 上，但 `<object label id>` 包装的单元 **id/label 在外层** | 标签写回外层 `label`，包装上的自定义属性原样留着 |
| 标签 | `value`（或 `object@label`）；`<br>` 折成空格、其余标签去掉，实体解码 | 纯文本 + XML 转义（改过标签的单元会丢掉原来的 HTML 标签，已在 notes 里说明） |
| 折点 | `<Array as="points"><mxPoint/></Array>` | 语义没变就一个字节都不动 |
| 悬空端 | `as="sourcePoint"` / `as="targetPoint"` —— **只在该端没有真实顶点时才生效**（有顶点时忽略，与 drawio 一致） | 同左 |
| 边端点 | `source` / `target` | 同左 |
| 新单元 | —— | 插到最后一个单元之后，parent 用第一个图层；**缩进跟着这个文件走**（硬编码会顺带改动别处的字节） |

**压缩**：drawio 默认把 `<diagram>` 的内容压成 `base64(raw deflate(URI 编码的 XML))`
（`Graph.compress`）。解压靠宿主（Node 有 `node:zlib`，浏览器没有），而且判形态是**看内容**
而不是看 `compressed` 属性 —— 属性标错的文件照样读得开。原有文件是压缩的，写回后仍压缩。

**编码**：UTF-8 首部的 BOM 会被摘掉（有的编辑器会加）；若文件其实是 UTF-16（记事本的"Unicode"
另存），按 UTF-8 读进来会在字节之间夹满空字符 —— 这时**报一句明确的编码错**（请用 UTF-8 另存），
而不是硬按 UTF-16 重解释：那会把中日韩标签变成乱码，而乱码是看不见的损失。

代码只有一份：`src/mxfile.js`（`parseMxfile` / `buildMxfile`），由构建器原样拷成
`lib/mxfile.js` 供宿主半边 import；它**不进客户端 bundle**（浏览器没有 zlib，放进去只会白占体积）。

## 画布单位与吸附

| 手势 | 最小单位 | 说明 |
|---|---|---|
| 节点移动 | **一格 = 10px** | 位置按 `GRID` **绝对**吸附：指针再细，节点也落在格线上 |
| 节点缩放 | **一格 = 10px** | 吸附的是**尺寸**（不是增量）：186 + 30 → 220，而不是 216。对边原地不动，下限也取整格（60 × 40） |
| 连线折点 / 线段 | **半格 = 5px** | `EDGE_GRID = GRID / 2`。连线比节点需要更细的手感；两个端点用**同一个位移**，段不会被吸附弄歪 |
| 对齐 / 分布 | 一格 = 10px | `computeAlignMoves(…, GRID)` |
| 自动路由的线段 | **半格 = 5px** | 路由器自己选出来的坐标（端点接入位置、走廊、拐角）一律吸附到 5px；**贴着节点边框的那一轴保持精确**，不为了对齐把线从边框上挪开 |
| 新建节点尺寸 | **130 × 60**（整格） | 文档里缺 `w`/`h` 时按 **150 × 60** 兜底；AI 侧按标签估宽也会**向上取整到 10**（`estimateWidth`） |

> **默认尺寸为什么要整格**：旧的默认高是 56 —— 不是 10 的倍数，于是节点中心落在 `y + 28` 上，
> 只要两个节点的中心差一两像素，连线就会多出"差一像素、合不成一条"的台阶。
> 现在新建节点是 130 × 60、兜底 150 × 60、AI 估宽向上取整到 10，中心永远是 5 的倍数。
>
> **自动路由为什么要吸附**：线段的位置来自"节点中心"与候选走廊中点。节点尺寸非整格时
> （56 高 → 中心 `y+28`、186 宽 → 中心 `x+93`），线段就会落在既不在整格也不在半格的坐标上。
> 所以路由器自己选的坐标一律吸附到 5px；而**用户手摆的折点是用户数据，一律不动** ——
> 拖动时按半格吸附，已有文档里的坐标保持原样。
> 这两条都有断言：`check-route-preview.mjs` 的"移动单位"与"自动路由：每条线段都落在整格/半格线上"两节。

> **为什么缩放吸附"尺寸"而不是"增量"**：文档里的宽度可能是 186 这种非整格值（估宽 / 导入 / 手写），
> 只吸附增量会一直把那个零头带着走（186 → 196 → 206…），中心也就永远落在半像素上 ——
> 那正是"两条线段差一像素、合不成一条"的上游来源。
> 这三条规则都有断言盯着：`check-route-preview.mjs` 的"移动单位"一节直接断言
> `snapTo` / `resizeBox` / `segmentMoveOf` 三个纯函数。

### meta.pinned：人手工摆过的版面不会被 AI 冲掉

文档带 `meta.pinned: true`（浏览器里存过盘就会打上）时，`diagram_apply` 默认 `layout: 'none'`，
只给新节点补位，不动已有坐标；想重排必须显式传 `layout`。

> 这里踩过一个坑，值得记下来：`diagram_apply` 原本用整体赋值写 `doc.meta = { engine, layout }`，
> 于是**第一次 AI 改图就把 `pinned` 擦掉了** —— 那一次没事（mode 已经是 `none`），
> 但第二次起读不到 `pinned`，mode 回落 `dagre-tb`，人摆好的版面被整张重排。
> 现在有回归测试盯着（`tools/check-host.mjs` 的 "meta.pinned" 一节）。
> **教训：用整体赋值覆盖 meta 时，没被显式处理的字段会静默消失。**

### 「一条线段上有两个点」是怎么来的

现象：某个节点上看起来一条直线上挂了两个段把手。

根因不在把手，在**路径**：两个节点的中心差几像素（自动布局取整的零头）时，
`orthoV` 会在"起点中心 x"和"终点中心 x"之间**主动**走一个台阶 ——
doc 中心 153、fs 中心 151.5 时生成

```
(153,476) (153,528) (151.5,528) (151.5,580)
```

视觉上是一条竖线，几何上是两条互相错开 1.5px 的线段，于是**各长一个段把手**。

修法是在**路由的输入端**对齐中心（`snapNearAxis`，容差 4px = 不到半个网格）：
台阶根本不会产生，后续所有几何推理仍按原来的精确比较走。

> 走过两条弯路，都记在 `simplifyCollinear` 的注释里：
> 1. 事后去清理折线（把 1.5px 的台阶并掉）会**凭空造出一条水平线**，
>    再被共线消除吃掉，路径就断成半截（e5 会退化成从 y=528 起的 2 点线）；
> 2. 改 `simplifyCollinear` 时用 `out` 里最后两个点当邻居，会让**首点永远凑不齐两个邻居**
>    而被判成共线删掉 —— 表现是 Z 形路径整段少掉一截。
>
> 现在这两条都有断言守着：`tools/check-route-preview.mjs` 的"共线化简：必须保首尾"
> 与"中心对齐"两节，外加一节直接读 `demo.drawio`、断言**真图上没有碎段、没有挨在一起的把手**。

### 每段都有一个段把手（短段也不例外）

选中一条连线时，**每一段**都有个橙色空心把手，拖它就是整段平移。这里曾经写着
`if (segLen < 26) continue`（"太短的段不放，否则手柄会挤成一堆"）—— 代价是**短段整段挪不动**，
而差几像素的台阶、贴边的引出段、两个节点挨得近时那一小截，恰恰都是短段（实测报过：
"短线段没有可移动的段点"）。现在：

- 每段都给把手，半径随段长收（4 → 3）；
- 首/末段的中点若离端点把手太近（两个圈会叠住，段和端点都抓不准），
  把手挪到这一段的**另一端**（那个折点）—— 仍在这一段上，但离端点够远；
- 整条边只有一段时（首即末）不挪 —— 挪到哪一端都会正好压在端点把手上，留在中点反而最清楚。

`tools/check-render.mjs` 的"短线段也要有可拖的段把手"一节盯着它：段数 == 把手数、
每个把手落在它那一段上、按下去报到正确的段号。

### 线不能穿进节点内部

判定要把盒子**内缩 ε**：贴着边框走不算"进去"（很多正常路径就走在边框上）。

折点可能落在某个节点内部 —— 用户把线拖到节点上，或者节点移动后把原本在外的折点"吞"了进去。
照直连过去线就扎进节点里，实测过：

```
折点在源节点内部 → (160,30) (80,30) (80,330) ...   从东边出去又折回节点里 80px
```

`pushOutOfBox` / `boxContaining` 在路由前把这类折点推到盒子外面（推最近的一侧，
优先沿"朝向另一端"的方向），**只改路由用的副本，不动用户的折点数据**。
回归测试见 `check-route-preview.mjs` 的"线不能穿进节点内部"一节。

> **已知未修**：两个节点**重叠**或一个被另一个**完全包住**时，线仍会穿过被包住那个的内部 ——
> 那种几何下"不穿进去"本身就不可能（端点就在对方肚子里）。
>
> **已知未修**：拖线预览在"指针靠近源节点那一侧的目标端点"时，会**回穿源节点**：
> `stubPointFor(src,'e')` 在 (184,30)，而目标端点在下方，于是路径沿 x=184 往下走，
> 而 x=184 落在源盒的 x 区间内 —— 线段擦过源盒内部。根因是**引出侧只看指针方向**、
> 没有对整条路径做长度评估。修法是联合搜索两端（试过一次，见上一节，收益不抵复杂度）。

### 折点链的绕行：`connectOrtho` 该怎么选 L

`routeThroughWaypoints` 逐步穿过用户摆的折点，每一步都是"两条 L 连过去"。
这两条的**曼哈顿总长完全相同**（走的都是同样的 dx、dy），差别只在拐点落在哪个角：

| 走法 | 拐点 | 结果 |
|---|---|---|
| 先横后竖 | `(b.x, a.y)` —— 与 a 同高 | 长的那一段先走完，短的收尾 |
| 先竖后横 | `(a.x, b.y)` | 短的那一段先走，后面多半要折回来 |

判据是 `|dx| <= |dy|` 时先横（即"先走跨度更大的一轴"），但**它只知道 dx/dy 谁大**：
"我们从哪儿来""接下来去哪"它都看不见，于是会挑出一条原路折返的 L（出去再回来 = 两段重合的线）。
两条 L 一样长，所以 `connectOrtho` 最后按**重合段最短**挑，完全平手才用默认判据。
重合有两处来源，两处都要看：

| 判据 | 看谁 | 病 |
|---|---|---|
| `firstOverlap` | **上一段**的方向（从 `points` 末两点读） | 第一步就压着上一段走回去（横着进来又横着往回走） |
| `arrivalOverlap` | **下一站**（`connectOrtho` 的第 5 个参数 `next`） | 到站方向被下一段立刻顶回来 —— 下一段是"直的"时必然折返 |

`next` 由 `routeThroughWaypoints` / `selfLoopPath` 在循环里传（最后一个折点的"下一站"是落点
`borderPointToward`），不传就只有第一条判据。

> 两条判据都用**长度**而不是"有没有"：两边都躲不开时（用户折点自己摆成了来回），
> 重合 24px 总好过 44px。真机第二条截图正是这个岔口 —— 44px 的重合压在**用户折点**上
> （`removeRetraces` 不许动它，于是重合留在画面上），24px 那条压在目标侧桩点上，
> 顺手就被消干净了。改成按长度选之后，那一整段拖动（7 个采样位置）都是零折返。
>
> 原先的实现是"上一段是横的就先横后竖"，**完全不管目标在哪边**。于是出现截图里那种线：
> 起点 (246,433) 先往右跑到 x=466，再折回左边 x=153 —— 实测 1341px 的路径，
> 改判据后降到 1073px；两折点那条 741 → 409。
>
> 试过两种更激进的做法，都**回退了**，记在这里免得再试：
> 1. "平手时改成先竖" —— 595 → 649（起点在南侧时先竖着出去，下一段又得往北折回）；
> 2. "四条边各算一遍、取整条路径最短的起点" —— 只在部分场景有效，同样会把 595 弄成 649，
>    因为它先挑起点再算末段，末段那条 L 的方向没跟着一起优化。要做就得两端联合搜索。
>
> 剩下的绕行（截图那条 1073px 仍比自动路由的 323px 长）是**折点本身摆成了往返**：
> 466 → 153 → 466。路由器不该擅自重排用户的折点；想回到简洁路径，右键连线选「自动路由」即可
> （`clearEdgeWaypoints` 会清掉全部折点）。

### 折返（头发夹）必须消掉：`removeRetraces`

选 L 的前瞻能防住绝大多数折返，但防不住**被数据逼出来的**：
目标侧的桩点（`stubPointFor`，边框外 24px）与用户折点分居拐点两侧时，
无论先横还是先竖都要走一段回程。真机第一条截图就是这样来的 ——
把右侧节点从右往左拖，右下角那条线变成"往右走 44px 再原路描回来"：

```
旧： (75,340) (75,445) (380,445) (336,445) (336,260) (360,260)
                              └── 这一段和上一段完全重合 ──┘   ← 用户看到"两条线"
新： (75,340) (75,445) (380,445) (380,260) (360,260)
```

`pathOf` 还会在每个顶点处画 6px 的圆角，于是尖点那里再鼓出一个小包 ——
"本来只有一条线段，现在像画了两条"就是这么来的。

去法很直接：`a → b → c` 而 `b` 是折返尖点（三点共线、方向在 b 处调头）时，
丢掉 `b`，等价于 `a → c`。新走线与 drawio 的 `mxEdgeStyle.SegmentConnector`
（`OrthConnector` 在有折点时就是回落到它）**逐点一致**：先竖着上去、最后一段横着进西侧，
中间那段压在节点底下看不见 —— drawio 的段连接器本来就不做障碍避让。

两条边界：

- **尖点若是人摆的折点就不动。** 那是用户数据，动了会让 `points[]` 与路径顶点失去一一对应
  （段把手 `pathIndexOf` 找不到折点，拖不动）。路由器自己加的桩点/拐点才是这里要收拾的对象。
- **共线化简那遍故意不吃保护名单。** 折返消掉之后，用户折点可能正好落进一条长直线**中间**：
  线照样经过它、画面完全一样，硬留成顶点反而在同一条线上多挂一个段把手。
  下一次手势的 `prunePoints` 会把这条已经没有几何意义的折点从文档里清掉。

回归断言：`isFoldApex` 的四种情形、`removeRetraces`（非折点尖点被消 / 折点尖点不动 / Z 形不误伤）、
上面那条真机走线的**逐点期望值**、"同一判据在旧走线上能认出 1 段折返"（防假绿），
以及第二条真机截图那组（出口/入口同在东侧 + 折点在外侧）：逐点期望值 +
**拖动下方节点 7 个位置全程零折返** + 折点仍是路径顶点。

### 改接端点：预览与落盘必须共用同一个折点拼装函数

"预览"和"松手后真正画出来的线"是两套代码算的，只要判据有一点不同就会分叉 ——
用户看到的就是**松手瞬间整条线跳掉**。这里踩过两个具体的坑：

1. **判据不同**：预览按"被拖那一端选中的端点"决定要不要钉桩点，落盘却按
   `borderPointToward` 重算一次，还把固定端也算成了"现在不在自然侧"。于是把 `to` 端拖到目标
   **左边**时，预览从左边接进去、落盘按"算法本来会选下边"处理 —— 两条完全不同的线。
2. **方向反了**：折点表按"被拖端 → 固定端"拼，`routeThroughWaypoints` 就倒着走；
   拖 `from` 端时预览与落盘一正一反（渲染时反转折线只影响显示，救不了路径本身）。

现在两边都调用**同一个 `waypointsForRetarget`**，折点表一律按边的真实方向（`fromBox → toBox`）排列，
预览**不再反转**折线。回归测试覆盖两个方向 × 四个端点 × 有无折点共 12 种组合，逐点比对。


**未验证**（诚实标注）：客户端半边是本仓库手写的，尚未在真实 DSH 里加载过；
`remote.workspaceFiles.read/changes` 的调用签名是从官方文件查看器
`dsh-client-ui-sidebar-files` 的用法推定的，首次安装可能要调一次。

---

## 拖拽连线的实时预览是怎么做的

要点只有一个：**预览和落盘必须走同一条路由函数**，否则松手那一刻整条线会跳变。

```
拖拽中（每一帧 pointermove）
  toUserSpace(指针)            → 用户坐标
  hitNodeAt(…, HOT_PAD)        → 指针下/附近是不是某个节点（按几何判定，容差 18px）
  routePreviewFor(…)           → 用 routeEdge / routeThroughWaypoints / stubPointFor 算正交折线
  → 渲染：虚拟预览折线（虚线） + 从折线终点到指针的收尾段（带箭头） + 起点圆点
          命中目标时：目标节点外扩 6px 的脉动提示环 + 光标变 copy
松手时（onNodePointerUp）
  同一套 stub 规则 → 写进 edge.points → 下一帧真实路由 = 刚才的预览
```

三个刻意如此的选择：

- **空白处也是折线，不是斜线。** 目标位置用一个零尺寸虚拟盒喂给 `routeEdge`，
  于是它照常从 6 个候选里挑一条正交走法 —— 预览里看到的绕行，就是松手后的绕行。
- **端点由用户选，不由算法猜。** 拖线靠近某个节点时，该节点四个端点（上/右/下/左）会画出来，
  **选中的那个放大高亮**，预览线就接在它上面；想换一边，把指针往那个端点挪近一点即可。
  选中的两个端点会写成 style 里的 `exitX/exitY` 与 `entryX/entryY`（drawio 的固定连接点），
  **不写进 `edge.points`** —— 折点只放人真摆的折点，所以"看到接哪边"和"存下来接哪边"是同一件事，
  而 AI 重排图形也不会把端点约束当成过期折点清掉。这条有一组断言盯着
  （`check-route-preview.mjs` 的"端点选择"与"改接端点"两节：四个方向 × 两个方向逐点比对预览与落盘）。
- **吸附判定用几何，不用 `elementFromPoint`。** 预览要提前知道落点，而 DOM 命中测试
  只在松手那一刻才成立；顺带也就有了"靠近即接"的容差（draw.io 的语义）。
  松手落点仍然由 `elementFromPoint` 最终裁决。
- **钉住引出侧时预览可以穿过障碍。** 用户按住某一侧的端点拖出来 = 指定了必经点，
  路由必须照它走。这时预览的职责是**如实预告**，不是比落盘更聪明 ——
  预览一旦自己绕开，落盘却照旧穿过，松手就又跳了。

这套几何逻辑可以在命令行里自测，不需要浏览器：

```sh
npm test        # 120 项 mxfile 编解码/写回（含顺序/数据/标签单元）+ 174 项路由/自环/迟滞/折返 + 134 项宿主 + 234 项渲染/剪贴板/把手 + 85 项组件（合计 747）
```

- `tools/check-mxfile.mjs` —— mxfile ↔ 文档：拿**真实产物形状**的夹具读（`<object>` 包装、
  root/layer 的 id 带前缀、容器子单元的相对坐标、多页），压缩形态**在测试里现压**（与
  `Graph.compress` 同一套算法）再读回，文档 → `.drawio` → 文档的往返逐字段比对，
  坏输入必须报错而不是给半张图；
- `tools/check-route-preview.mjs` —— 折线正交性、吸附容差边界、**预览与落盘逐点一致**（含改接端点
  两个方向、带折点的边）、**拖动线段松手不跳变**、避让、共线化简保首尾、中心对齐容差、
  **折返段（出去又原路描回来）必须被消掉**且人摆的折点尖点不许动，
  以及直接读 `demo.drawio` 的**真图连线不变量**（最短段 ≥5px、段把手不重叠、零折返 ——
  就是「一条线上两个点」和「本来只有一条线却画了两次」那类毛病）；
- `tools/check-host.mjs` —— 用**内存文件系统**跑完整的 `diagram_apply` / `diagram_read`，
  并直接打写回路由验证 `.drawio` 的**读 / 写 / 新建 / 另存为**（打开后原样保存逐字节不变、
  改一处不动别处、指纹过时 409、另存为不覆盖、非 .drawio 拒收），以及
  `meta.pinned` 是否被保住、非法 ops 是否在写盘前失败（全或无）、边样式落盘；
  宿主半边没有热重载（改完要重启 `dsh web`），这个自测把反馈压到一秒内；
- `tools/check-render.mjs` —— 用极简 React 桩驱动 `renderDiagram`：预览折线/收尾线/提示环
  **确实被画进了 SVG**、连线画法（线型/箭头/marker 是否真的在 defs 里）、
  以及 `computeAlignMoves` 的对齐/分布坐标与幂等性；
- `tools/check-component.mjs` —— 用带 hooks 的 React 桩把整个面板组件跑起来（状态形状不对时不能整块降级），
  另有一节**键盘归属**：喂假 DOM 节点断言"输入框 / 别的面板里按键时画布一个键都不碰"，
  以及 window 上那个 keydown 确实**先问归属再动手**。

---

## 为什么构建器仍然很小

本机**没有** typescript / tsdown / esbuild / react，无法跑构建链。
而本项目不需要代码转换：客户端半边全部用 `React.createElement`（无 JSX），
宿主半边是普通 ESM（无 TS 类型）。

`src/` → `lib/` 只做三件事：拷宿主半边、拷样式内核、把内核**内联**进客户端 bundle 再套外壳加缩进 ——
仍是**零依赖 Node**，不需要 tsdown / typescript / esbuild（**本机也一个都没装**）。

> **样式内核为什么要内联。** `src/style-kernel.js` 是宿主与客户端共用的格式判据（解析 style 串、
> 默认省略、v1 读时升级…）。宿主是 ESM，直接 `import` 它；客户端的 bundle 是一个单文件 factory，
> 只有一份冻结的 `require` 表，不能 import 兄弟文件。于是构建器把它去掉 `export`、包成
> **IIFE 命名空间**（`const styleKernel = (function(){…})()`）再内联 —— 包一层是因为两边有同名符号
> （都有 `SIDES`），平铺进同一作用域会直接 SyntaxError。源码只有一份，`check-package` 会断言
> 客户端里那份确实是内联进去的。

`lib/client.js` 的包装格式逐字对照官方产物
（`dsh-client-ui-sidebar-right/lib/client.js`）确认：

```js
window.__ModuleLoader__.load({ id: 'dsh-drawai', factory: (require) => module.exports })
```

> ⚠️ **绝不改 `lib/` 下的文件** —— 它们是构建产物，会被覆盖。改 `src/`。
> 构建器刻意**不加时间戳**：`dsh-client-hmr` 按内容变化判定 rebuilt，
> 时间戳会让每次构建都被当成变更，页面就会无谓重载。

将来若要用 TSX / TS 类型：补上 typescript + tsdown 即可，`src/` 结构不用动。

---

## 开发回路

```sh
npm run watch     # 常驻：监听 src/，变化即重建 lib/
npm run build     # 一次性构建
npm run check     # 安装前烟测（含 lib 与 src 是否同步）
```

| 改什么 | 怎么生效 | 要多久 |
|---|---|---|
| `src/client.js` | watch 重建 `lib/client.js` → `dsh-client-hmr` 轮询到内容变化 → SSE → 浏览器**自动重挂载插件** | 约 1 秒，**不用刷页面** |
| `src/index.js` | `npm run build` 后**重启 `dsh web`**（宿主半边只在启动时加载） | 一次重启 |
| `src/style-kernel.js` | 两半都受影响：客户端那份走上面的热重载；宿主那份要**重启 `dsh web`** | 两者都要 |
| `package.json` / `cordis.patch.yml` | 这两个文件被 watch，多数情况实时重组 | 立即 |

`dsh-client-hmr` 的要求只是"有进程在写 `lib/client.js`"——不限定是 tsdown。
`tools/watch.mjs` 直接 `import` 构建函数而**不 spawn 子进程**：
本机沙箱下 Node 的 piped stdio 会被拒，`spawn('node', …)` 会 EPERM。

---

## 目录

```
package.json            # dsh.bundle.patch + dsh.client 声明 + scripts
cordis.patch.yml        # bundle patch：insert 一行 drawai
src/style-kernel.js     # ← 源：格式判据（style 键解析/默认省略/v1 读时升级），两半共用
src/mxfile.js           # ← 源：mxfile（.drawio）编解码，**只给宿主**（要 node:zlib）
src/index.js            # ← 源：宿主半边（工具 + 布局 + 读写路由）
src/client.js           # ← 源：浏览器半边（画布 + tab 类型）
lib/style-kernel.js     # 产物（勿改）
lib/mxfile.js           # 产物（勿改）
lib/index.js            # 产物（勿改）
lib/client.js           # 产物（勿改）
tools/build.mjs         # 零依赖构建器（含内核内联）
tools/watch.mjs         # 构建监视器（HMR 的那一环）
tools/check-package.mjs # 安装前烟测（含 lib 与 src 是否同步）
tools/check-mxfile.mjs  # mxfile 编解码 + 无损写回自测（真实夹具 + 现压的压缩形态 + 逐字节不变）
tools/snap-geometry.mjs # 一次性几何迁移（对齐整格/半格；默认 --dry）
tools/migrate-dshd.mjs  # 旧 .dshd.json → .drawio 的一次性迁移（不删旧文件、不覆盖目标）
tools/check-route-preview.mjs # 连线预览的路由自测（纯几何，无需浏览器）
tools/check-host.mjs    # 宿主半边行为自测（内存文件系统，无需 DSH）
tools/check-render.mjs  # 渲染 + 对齐/连线画法自测（React 桩驱动 renderDiagram）
demo.drawio             # 示例图（画布默认读它）
```

---

## 安装

### 路线 A：本地 link（开发期推荐）

在 `$DSH_HOME/profiles/<profile>/package.json` 的 `dependencies` 里加：

```json
"dsh-drawai": "link:D:\\_Project\\drawAi"
```

然后：

```sh
cd $DSH_HOME/profiles/<profile>
pnpm install
```

### 路线 B：bundle 通道

`package.json` 已声明 `dsh.bundle.patch`，用官方 CLI 安装即可自动挂载：

```sh
dsh plugin --profile <profile> add dsh-drawai
```

（发布到 npm 之前，路线 B 只能对已发布的包使用；本地开发用路线 A。）

### 手动挂载（两条路线的兜底）

把这一行加进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: drawai
      name: 'dsh-drawai'
```

> ⚠️ patch 文件不能为空或只有注释，否则 loader 启动失败。要留空请写 `[]`。
> ⚠️ 该文件被 watch，`patchReload: live` 时改对即重组——**但新增一个 bundle 通常仍需重启 `dsh web`**。

### 重启

**宿主半边必须重启 `dsh web` 才会加载。** 客户端半边是独立 bundle，页面刷新即可。

---

## 烟测

不需要 DSH 在跑，也不需要安装。先让它能解析 `@deepseek-ai/dsh-tools`：

```powershell
New-Item -ItemType Directory -Force -Path node_modules\@deepseek-ai | Out-Null
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\dsh-tools `
  -Target "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools"
```

然后：

```sh
node tools/check-package.mjs
```

它会验证宿主半边能否 import、`apply` 能否注册工具、以及 DSH 那套严格的 schema DSL 是否接受本包声明。

> 这个 junction 只是本机自测用的**机器相关**路径，不要提交，也不要在安装后保留：
> 装进 profile 后应当让包走部署自己的模块解析（同 `dsh-better-sidebar` 的做法）。
