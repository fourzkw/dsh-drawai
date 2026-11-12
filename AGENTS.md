# AGENTS.md

本文件约定这个仓库的 git 协作方式。所有自动化代理和协作者都按这里的规则提交、分支、合并。

## 分支

- 主线是 `develop`。功能、修复都从 `develop` 切出，不要直接从 `master` 切。
- **一个 issue 一个分支**，命名：
  - 修缺陷：`fix/issue-<编号>-<短描述>`，例如 `fix/issue-8-tool-registration`
  - 新功能：`feat/<短描述>`
  - 文档/杂务：`docs/<短描述>`、`chore/<短描述>`
- 不要在一个分支上叠加第二个 issue 的改动。已经混了的就留着等合并，新问题另开分支。
- **合并进 `develop`（或 PR 合并）之后**，再删本地和远端分支；合并前不删——分支删了提交就只剩 reflog，容易丢。
- 不 force push 已经推送过的分支。远端分支一旦被写脏（混入了别的提交），不要重写它，另起一个干净名字的分支走 PR。

## 构建产物

- `lib/` 是 `src/` 的构建产物：`node tools/build.mjs` 把 `src/index.js` 编成 `lib/index.js`，client 产物同样由 `src/style-kernel.js` + `src/client.js` 内联生成。**不要手改 `lib/`**。
- 改了 `src/` 就必须重新 build，并且 `src/` 与 `lib/` 放在**同一个提交**里；`node tools/check-package.mjs` 会校验两者是否同步。
- 构建可能顺带刷新与本次无关的过期文件（例如 `lib/motion/sync.js`）。用 `git checkout -- <file>` 还原，不要混进提交。
- 不提交：`dist/`、`*.tgz`、`.tmp/`、`tmp/`、构建缓存与临时画布。

## 提交

- 格式：`<type>(<scope>): <做了什么>`，type 取 `fix` / `feat` / `refactor` / `docs` / `test` / `chore` / `perf`。
- 标题用中文，一句话说清**结果**；正文写**原因、影响面、怎么验证的**。
- 一个提交只做一件事。顺手发现的问题要么单独提一个提交，要么不要带进来。
- 关联 issue 写在正文：`Refs #12` / `Closes #12`。
- 发布版本单独提交：`chore(release): 0.4.2`，同时更新 `package.json` 与构建产物，并打 tag。

## 提交前检查

按改动范围至少跑这些：

```powershell
node tools/build.mjs          # 改了 src/ 时
node tools/check-package.mjs  # 构建产物与源码同步、工具注册、诊断端点
npm test                      # 全量；或至少跑相关子集
```

动到视频/音频相关代码时，额外跑：

```powershell
npm run test:motion-sync
```

发版（打 tag、发布 npm）前额外跑：

```powershell
npm run release:check   # build + 构建产物同步 + check-package + npm test
```

tag 必须打在「构建产物已提交」的提交上。0.4.5 就是因为只改了 `src/motion/sync.js`、没重建 `lib/motion/sync.js`，让带旧参数的产物进了 npm 包（#43）。CI 同样会在构建后要求 `src`/`lib` 没有差异。

## 关于「修复完成」

一个 issue 只有在**合并进 `develop` 且验证通过**之后才算完成。此时才删分支。分支存在于本地、远端还没合并时，不要说「已修复」——尤其当问题只在报告人的机器上复现时，先给出取证手段（例如 `/drawai/api/diagnostics`），再谈修复。

## 远端与环境备注

- 远端：`github` = `https://github.com/fourzkw/dsh-drawai.git`（`develop` 为主线）。
- 本机 git 走 schannel 报 `SEC_E_NO_CREDENTIALS` 时，加 `-c http.sslBackend=openssl` 再试。
- 在受 ACL 限制的机器上，写 `.git`（切分支、提交）可能需要提权；网络需要走代理时同理。
