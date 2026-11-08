# vendored demo 依赖

`upstream/demos/*/index.html` 的 importmap 和 `<script src>` 指向 `/node_modules/*`。这些包不在
视频运行时（`src/motion/runtime/package.json`）的依赖里，装到用户机器上就无从服务，于是
`mg_style action:"frames"` 直接报「依赖没装在本机」（issue #27）。

这里按**原包内路径**放好被引用的构建产物，`src/motion/style-frames.js` 在服务 `/node_modules/*`
时先查视频运行时、再回落到本目录，所以用户什么都不用装。

```
modules/<包名>/<包内原路径>
```

| 包 | 版本 | 文件 | 许可证 |
| --- | --- | --- | --- |
| d3 | 7.9.0 | `d3/dist/d3.min.js` | ISC（见 `d3/LICENSE`） |
| topojson-client | 3.1.0 | `topojson-client/dist/topojson-client.min.js` | ISC（见 `topojson-client/LICENSE`） |
| opentype.js | 1.3.4 | `opentype.js/dist/opentype.mjs` | MIT（见 `opentype.js/LICENSE`） |
| simplex-noise | 4.0.3 | `simplex-noise/dist/esm/simplex-noise.js` | MIT（见 `simplex-noise/LICENSE`） |

- 只用到的文件放进来了，没有整包拷（约 780 KB）。
- 目录叫 `modules` 而不是 `node_modules`：npm 打包会无条件跳过任何名为 `node_modules` 的目录，
  那样 vendored 文件进不了 tarball。`.gitignore` / `.npmignore` 里给了 `dist/` 的例外规则，
  否则这几个文件会被当成构建产物忽略。
- `opentype.js` 1.3.4 的 ESM 构建叫 `dist/opentype.module.js`，demo 按 `dist/opentype.mjs` 引用，
  所以这里用前者的内容放到后者的文件名下；升级时按同样规则替换。
- `three` 不在这里：视频运行时的依赖清单已包含 three 0.183.2，`/node_modules/three/*` 由运行时提供。
- 升级包时同步改本表版本号，并重跑 `node tools/check-package.mjs`（它校验这几个文件是否存在）。
