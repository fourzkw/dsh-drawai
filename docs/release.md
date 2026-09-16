# 发布与收录流程 / Release & listing

两件事要分开看：

1. **让仓库本身合格** —— 收录条件是对**你的 GitHub 仓库**提的（manifest、年龄、topic…）。
2. **去精选列表提一个文件** —— 市场与站点读的是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
   投稿就是在那里加 `data/plugins/fourzkw__dsh-drawai.yml`。

收录要求以 [contributing.md 原文](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 为准，
本文只记**我们这边的状态与动作**。

---

## 一、现在的状态（2026-09-16 23:26 实测，对着 API、registry 与仓库核过）

| 项 | 状态 | 证据 |
|---|---|---|
| `dsh.bundle.patch` + 根 `cordis.patch.yml` | ✅ | `package.json` 的 `dsh.bundle`；patch 里 `insert: id: drawai` |
| 真实可用的代码 | ✅ | `lib/` 已提交、没有 `prepare`/`postinstall`、`npm pack` = 8 个文件 / 245.2 kB |
| 许可证 | ✅ MIT | `LICENSE`（版权行 `fourzkw`）+ `"license": "MIT"`，都已在默认分支上 |
| `repository` / `author` | ✅ | `git+https://github.com/fourzkw/dsh-drawai.git` / `fourzkw` —— npm 包与条目的关联依据 |
| **npm 包** | ✅ **已发布** | [`dsh-drawai@0.1.0`](https://www.npmjs.com/package/dsh-drawai)（2026-09-16，`latest`）—— 市场按 `repository` 自动关联下载量，条目里不用写 `npm:` |
| `@deepseek-ai/*` 用 `peerDependencies` 且带预发布分支 | ✅ | 见第四节 |
| 仓库公开、有内容 | ✅ | [fourzkw/dsh-drawai](https://github.com/fourzkw/dsh-drawai) |
| 默认分支 = 本地最新 | ✅ | 提交都已推送，工作区干净 |
| **仓库创建满 1 天** | ⏳ **2026-09-17 00:30:49 (+08:00) 才满**（实测 22.9 h，还差约 1.1 h） | API `created_at = 2026-09-15T16:30:49Z` |
| **`dsh-plugin` topic** | ❌ **空** | `GET /repos/fourzkw/dsh-drawai/topics` → `{"names":[]}` |
| **`data/plugins/fourzkw__dsh-drawai.yml`** | ❌ 还没提 | 见第 7 步与第三节 |
| 描述属实 | ⚠️ 写的时候注意 | 真实工具**只有 2 个**：`diagram_read` / `diagram_apply` |
| 与已有条目不重复 | ⚠️ 同一种文件格式，不是同一件事 | 在册的 `jean3690/dsh-drawio` 也读写 `.drawio`，见第五节 |

> 到这里**仓库侧的硬条件全部满足**，只剩两件事：加 `dsh-plugin` topic（第 2 步）、提那个 yml（第 7 步）；
> 外加等过 00:30:49 的 1 天年龄门槛（第 4 步）。npm 已发布，第 6 步完成。

---

## 二、要做的步骤

### 1. 提交 + 推送（已完成）

仓库与工作区当前是一致且干净的；之后每次改文档，照常提交推送即可：

```sh
git add -A && git commit -m "docs: …" && git push github master
```

- ⚠️ 本机 `git` 配了 `http.proxy = 127.0.0.1:7892`（那个端口默认是关的）；去掉代理直连时 Schannel 会报
  `SEC_E_NO_CREDENTIALS`。这组覆盖参数实测可以推：

  ```sh
  git -c http.sslBackend=openssl -c http.proxy= -c https.proxy= push github master
  ```

### 2. 加 `dsh-plugin` topic（硬要求）

现在 `GET /repos/fourzkw/dsh-drawai/topics` 回的是 `{"names":[]}`，三个办法任选：

**A. 网页（推荐，不需要 token）** —— 打开 <https://github.com/fourzkw/dsh-drawai>，
右侧栏 **About** 那一块点 ⚙️（齿轮）→ 在 **Topics** 输入框里打 `dsh-plugin` → 回车（或点 Add topic）→
对话框底部 **Save changes**。顺手把 **Description** 也填一句（现在 `description` 是 `null`）。
验证：刷新后 About 下面出现蓝色 `dsh-plugin`，点进去就是 <https://github.com/topics/dsh-plugin>。

**B. gh CLI**（本机没装）：

```sh
gh repo edit fourzkw/dsh-drawai \
  --add-topic dsh-plugin,deepseek-harness,drawio,diagram,canvas
```

**C. REST API** —— `PUT /repos/{owner}/{repo}/topics`，**它是整体替换**，每次都要把想要的写全：

```powershell
# classic PAT 用 public_repo 就够；fine-grained PAT 要 Administration = Read and write
$env:GH_TOKEN = '<your-token>'          # 别把 token 贴进聊天/提交进仓库
$headers = @{
  Authorization            = "Bearer $env:GH_TOKEN"
  Accept                   = 'application/vnd.github+json'
  'X-GitHub-Api-Version'   = '2022-11-28'
}
$body = @{ names = @('dsh-plugin', 'deepseek-harness', 'drawio', 'diagram', 'canvas') } | ConvertTo-Json
Invoke-RestMethod -Method Put -ContentType 'application/json' -Headers $headers `
  -Uri 'https://api.github.com/repos/fourzkw/dsh-drawai/topics' -Body $body
```

> ⚠️ Windows PowerShell 里 `curl` 是 `Invoke-WebRequest` 的**别名**，要用真 curl 得写 `curl.exe`
> （而且 JSON 的引号在 5.1 里很难转义，所以上面用 `Invoke-RestMethod`）。
> topic 只能是小写字母 / 数字 / 连字符，一个仓库最多 20 个。

### 3. `repository` / `author`（已补）

包的 `repository` 必须指回被收录的那个仓库，否则两者不会关联（映射自动采集，条目里手写 `npm:` 会被拒）。
`package.json` 里已经补上，`LICENSE` 的版权行也已改成 `fourzkw`：

```jsonc
"author": "fourzkw",
"repository": { "type": "git", "url": "git+https://github.com/fourzkw/dsh-drawai.git" }
```

### 4. 等过 1 天门槛

`2026-09-17 00:30:49 (+08:00)` 之后提交最稳。这条由 CI 自动查，不是对插件质量的判断；
万一卡住了，把功能做完再提一次即可，重新提交没有任何影响。

### 5. 截图（可选、推荐）

现在 README 里一张图都没有，市场卡片会没有配图。在你的仓库里放 `screenshots.json`
（与 `package.json` 同级）+ 1-8 张图，然后在 README 里也引用同一批：

- README 顶部留了一行**注释掉的社交预览图**占位（`docs/social-preview.png`，1280×640）——
  图放好后把那两行注释去掉即可，仓库的 Social preview 也用同一张（Settings → General → Social preview）。
- 画布那几节（`## 🗂️ 画布面板`、`## 🤖 两个工具`）现在没有配图，放图时建议按参考插件
  [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) 的做法，一节一张、紧跟在小节标题下面。

```jsonc
// screenshots.json（路径相对本文件；也接受 {"screenshots": [...]} 写法）
[
  "assets/screenshot-1.png",
  "assets/screenshot-2.png"
]
```

规则：1-8 张；相对路径不能跳出插件目录（不能以 `/` 开头、不能有 `..`）；写绝对 URL 的话必须是
**GitHub 托管的 https**（第三方图床会被拒）。不声明也能过 —— 市场会退回从 README 抽图。

### 6. 发到 npm（已完成）

`dsh-drawai@0.1.0` 已在 registry 上（2026-09-16 发布，`npm view dsh-drawai` 可查，tarball shasum `a341ff5f…`）。
发了的好处是预构建安装跳过 `allowBuilds` 构建授权那一步 —— **发不发都不影响收录**。后续发版：

```sh
npm version patch                                  # 改版本号 + 打 tag
git push --follow-tags
npm publish                                        # 同版本号重复发会 E403
```

> **发布时踩的坑（记下来省得再撞）**：`npm login`（`auth-type=web`）留下的是一枚 **session token**，
> registry 不接受它发布，报
> `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
> —— 即使账号**没有开 2FA** 也一样（[npm/cli#9268](https://github.com/npm/cli/issues/9268)，至今 open）。
> 解法（issue 里多人验证有效）：去 <https://www.npmjs.com/settings/fourzkw/tokens> 建一枚
> **Granular Access Token** —— 权限 `Read and write`、包选 `All packages`（新包还不存在，选不到具体包）、
> **勾上 Bypass 2FA**、IP 范围留空 —— 然后：
>
> ```sh
> npm config set //registry.npmjs.org/:_authToken=npm_…   # 写进用户级 ~/.npmrc，别写进仓库
> npm publish
> ```
>
> 关键是**显式写进 `.npmrc`**：`npm token list` 里那枚 bypass-2fa token 不会被自动使用，
> npm 会继续用 session token（这就是为什么"建了 token 还是 403"）。发布完可以
> `npm config delete //registry.npmjs.org/:_authToken` 收回本地，再去网页 Revoke。

### 7. 提 PR

```sh
# fork awesome-dsh-plugin，然后
git clone https://github.com/<你>/awesome-dsh-plugin && cd awesome-dsh-plugin
# 新增一个文件，文件名 = owner__repo
#   data/plugins/fourzkw__dsh-drawai.yml
git checkout -b add-dsh-drawai && git add data/plugins/fourzkw__dsh-drawai.yml
git commit -m "Add fourzkw/dsh-drawai" && git push origin add-dsh-drawai
```

**不要手工改两个 README**（它们由 `data/plugins/*.yml` 生成），也**不要**动别人的条目 ——
PR 里只该有你这一个文件。一个 PR 最多 3 条，我们 1 条。

---

## 三、那份 yml 写什么（可直接粘）

```yaml
url: https://github.com/fourzkw/dsh-drawai
name: fourzkw/dsh-drawai
category: tools
description:
  en: 'An editable diagram canvas in the DSH sidebar plus two agent tools (diagram_read, diagram_apply) that read and edit the workspace in place, using native .drawio files: the canvas opens and saves them losslessly — cells it does not understand are preserved byte-for-byte — and a file-fingerprint revision powers optimistic locking against concurrent edits.'
  zh: 'DSH 侧边栏的可编辑画布，加两个模型工具（diagram_read、diagram_apply），直接读写工作区、载体是原生 .drawio 文件：无损写回让画布读不懂的单元逐字节保留，文件指纹 revision 支撑起对并发编辑的乐观锁。'
```

三条注意：

- **含 `: `（冒号加空格）必须加引号**，否则 YAML 会当成嵌套键 —— 上面 `en` 已经加了。
- **别写营销词，别报数字**：写"两个工具"就真的是两个；描述里的命令与 API 会被逐个对着代码核。
- `category`：`tools` 最贴合（带来的是两个模型工具 + 一块可编辑画布）。若维护者觉得更像界面增强，
  会直接改成 `ui`，**不会因此打回**。

---

## 四、peer 范围为什么长这样

```jsonc
"peerDependencies": {
  "@deepseek-ai/dsh-tools": ">=0.1.0-rc.1 <0.1.0 || >=0.1.5-rc.1 <0.2.0-0"
}
```

node-semver 只有当范围里**某个比较符与该版本的 `major.minor.patch` 元组完全一致、且自身带预发布标签**时，
才放行预发布版本。本机用真实 semver 对着三个版本跑过：

| peer 范围 | `0.1.0-rc.6` | `0.1.5-rc.2`（本机 harness） | `0.1.5` |
|---|---|---|---|
| `>=0.0.1-rc.1 <0.2.0`（看着宽） | ✗ | ✗ | ✓ |
| `>=0.0.0-0 <0.2.0-0`（"匹配一切"） | ✗ | ✗ | ✓ |
| `>=0.1.0-rc.1 <0.2.0-0` | ✓ | ✗ | ✓ |
| **`>=0.1.0-rc.1 <0.1.0 \|\| >=0.1.5-rc.1 <0.2.0-0`**（采用） | ✓ | ✓ | ✓ |

不这么写的后果是用户 `npm install` 时撞 `ERESOLVE` 还得手工绕 —— 而这个范围用户根本看不见原因。

---

## 五、合并前维护者会看什么（对着原文）

CI 通过只是**前置条件**。评审逐条看的是：

| # | 看什么 | 我们这边的答案 |
|---|---|---|
| 1 | 代码是否与条目声明一致（含数字与 API 名） | 两个工具、ops 名与 `lib/index.js` 一致；描述里没有数字 |
| 2 | 分类是否合理 | `tools`；不贴切会被直接改，不打回 |
| 3 | 是不是真代码 | `src/` 13.3k 行 + 五份自测（`npm test` 1472 项断言全绿），`lib/` 是可运行产物 |
| 4 | **是否已被现有条目覆盖** | ⚠️ 见下 |
| 5 | 源码有没有可疑行为 | 无网络请求、无凭据、无安装期脚本；只读写工作区 `.drawio` |
| 6 | PR 有没有动别人的条目 | 只加一个文件 |
| 7 | 是不是纯聚合包 | 不是：自带渲染器 + 工具 + 布局 |
| 8 | 依赖是否指向原作者 | 没有第三方依赖 |

### 关于第 4 条（要正面回答的一点）

`jean3690/dsh-drawio` 已经在 `tools` 类里，它与我们**共用同一种文件格式**（`.drawio`），但那不是同一件事：
那边是一个 drawio 工具集 + 嵌官方编辑器的画板，我们是一块**自己实现的画布**，`.drawio` 只是它的原生载体
（所以画布存出来的文件能直接被 drawio 打开）。原文的规矩是 *"规则不是先来后到，规则是谁更好"*，
只要"确实做了新东西"就会被收录，但描述里要让人一眼看出差别。

**所以这一条的正确姿势是：按"一块画布 + 两个工具"来写，把 `.drawio` 写成一个能力
（读写原生文件、不用导入导出），而不是身份（"又一个 drawio 插件"）。**

| 差异点 | dsh-drawai 的做法 |
|---|---|
| 画布 | 自己实现的渲染器与编辑器（纯 SVG + DOM，无 iframe、无外部编辑器资源） |
| 模型能看见什么 | 工具 + 文件 + **用户此刻的选区**、每个单元的 layer/parent、`revision`、页面尺寸 |
| 写回 | **逐单元外科手术式**（读不懂的单元逐字节保留，有断言；原样保存 = 文件一个字节不变） |
| 并发编辑 | 文件指纹 `expectRevision`，对不上就报错且不写盘 |
| 互操作 | 文件就是原生 `.drawio`，用 drawio / diagrams.net 直接打开继续编辑，不需要导入导出 |

`category` 也可以考虑 `ui`（它带来的是一整块右栏画布 + 两个模型工具），不贴切维护者会直接改，不打回。

---

## 六、PR 之后

- CI 会依次查：条目数（≤3）→ 从仓库 `package.json` 读 `dsh.bundle` → 仓库年龄 → `awesome-lint` 与站点构建。
- 失败会在 PR 上写明要改什么；**在同一分支推送修复即可，不用重开 PR**。
- 反馈以 PR 评论给出（常因描述不准确被打回 —— 改那一行就收录，不是否定插件）。
- 合并后站点与市场**自动重建**，通常一天内生效。
- 收录**不是**安全审查：README 顶部的警告对所有条目一视同仁。
