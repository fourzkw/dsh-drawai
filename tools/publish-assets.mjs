#!/usr/bin/env node
/**
 * 把 dist/ 里的素材包传到 GitHub Release。
 *
 * 三个包各发各的：
 *   node tools/publish-assets.mjs            # assets-v1 字体 + 素材库（约 145MB）
 *   node tools/publish-assets.mjs --demo     # demo-assets-v1 上游 demo 的共享数据（约 160KB）
 *   node tools/publish-assets.mjs --frames   # style-frames-<日期> 整片风格参考帧（约 40MB）
 *
 * 鉴权顺序：GITHUB_TOKEN 环境变量 → `git credential fill`（GCM 里存的 github.com 凭据）。
 * 只用来建 release / 传 asset，不打印 token。
 *
 * 用法：
 *   node tools/publish-assets.mjs --dry-run         # 只打印要做的事
 *   node tools/publish-assets.mjs --demo --dry-run
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ASSETS_LOCK } from '../src/motion/asset-pack-lock.js'
import { DEMO_ASSETS_LOCK } from '../src/motion/demo-assets-lock.js'
import { STYLE_FRAMES_LOCK } from '../src/motion/style-frames-lock.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO = 'fourzkw/dsh-drawai'
const API = 'https://api.github.com'
const UPLOAD = 'https://uploads.github.com'

const PACKS = {
  assets: {
    lock: ASSETS_LOCK,
    tag: `assets-${ASSETS_LOCK.version}`,
    title: `Motion assets ${ASSETS_LOCK.version}（字体 + 素材库）`,
    body: [
      '动效素材包：字体 46 个 + 素材库 116 个（纹理 / 乐器采样）。',
      '',
      '插件首次用到动效功能时自动下载，逐文件校验后落到 `~/.dsh/drawai-assets/' + ASSETS_LOCK.version + '/`，之后离线可用。',
      'npm 包里不再包含这些文件（147.6MB → 3.0MB）。',
      '',
      '- 打包：`node tools/build-assets-pack.mjs`',
      '- 发布：`node tools/publish-assets.mjs`',
    ].join('\n'),
    build: 'node tools/build-assets-pack.mjs',
  },
  demo: {
    lock: DEMO_ASSETS_LOCK,
    tag: `demo-assets-${DEMO_ASSETS_LOCK.version}`,
    title: `Demo assets ${DEMO_ASSETS_LOCK.version}（上游 demo 的共享数据）`,
    body: [
      '整片风格 demo 用到的数据文件，主要是 `demos/22-hud/assets/land-50m.json`',
      '（world-atlas 的世界地图拓扑，数据源 Natural Earth 公有领域，ISC 许可）。',
      '',
      '它只被 demo 用，进 npm 包等于让每个用户为看一个 demo 多下 530KB，所以单独发布。',
      '插件在 demo 第一次请求这个文件时下载、校验 sha256、落到',
      '`~/.dsh/drawai-assets/demo-' + DEMO_ASSETS_LOCK.version + '/`，之后离线可用。',
      '',
      '- 打包：`node tools/build-demo-assets-pack.mjs`',
      '- 发布：`node tools/publish-assets.mjs --demo`',
    ].join('\n'),
    build: 'node tools/build-demo-assets-pack.mjs',
  },
  frames: {
    lock: STYLE_FRAMES_LOCK,
    tag: `style-frames-${STYLE_FRAMES_LOCK.version}`,
    title: `Style reference frames ${STYLE_FRAMES_LOCK.version}（16 种整片风格的参考帧）`,
    body: [
      '整片风格参考帧：16 种风格共 ' + STYLE_FRAMES_LOCK.files + ' 个文件（126 张 jpg + 4 张 png + 每个风格的清单 + 上游许可与说明），约 40MB。',
      '',
      '它们取自上游 [Vincentwei1021/mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15) 的成片截帧',
      '（MIT，Copyright (c) 2026 Vincentwei1021），只作视觉参考：按主题独立设计，不照搬画面或分镜。',
      '画面里的第三方内容、字体可能另有许可；详见包内 `LICENSE-mg-styles-15.txt` 与 `README.md`。',
      '',
      '插件第一次读参考帧（`mg_style {action:"frames"}`）时自动下载，逐文件校验后落到',
      '`~/.dsh/drawai-style-reference-frames/' + STYLE_FRAMES_LOCK.collection + '/`，之后离线可用；',
      '也可以先跑 `mg_style {action:"install"}` 预下载。参考帧是可选的，没有它也能按风格施工包做片子。',
      '',
      '- 打包：`node tools/build-style-frames-pack.mjs`',
      '- 发布：`node tools/publish-assets.mjs --frames`',
    ].join('\n'),
    build: 'node tools/build-style-frames-pack.mjs',
  },
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const line = out.split('\n').find((item) => item.startsWith('password='))
    if (line) return line.slice('password='.length).trim()
  } catch { /* 没有凭据就走下面的报错 */ }
  throw new Error('没有 GitHub 凭据：设置 GITHUB_TOKEN，或先让 git 记住 github.com 的账号')
}

async function api(path, init = {}, useUpload = false) {
  const res = await fetch((useUpload ? UPLOAD : API) + path, {
    ...init,
    headers: {
      authorization: `token ${token()}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-drawai-release',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${json?.message || text.slice(0, 200)}`)
  return json
}

async function main() {
  const dry = process.argv.includes('--dry-run')
  const picked = process.argv.includes('--demo') ? 'demo' : process.argv.includes('--frames') ? 'frames' : 'assets'
  const pack = PACKS[picked]
  const { lock } = pack
  const FILE = join(ROOT, 'dist', lock.file)
  if (!existsSync(FILE)) throw new Error('找不到素材包：' + FILE + '（先跑 ' + pack.build + '）')
  const bytes = statSync(FILE).size
  if (bytes !== lock.bytes) throw new Error(`素材包大小与 lock 不一致（${bytes} ≠ ${lock.bytes}），先重新打包`)
  console.log(`素材包 ${lock.file}  ${(bytes / 1048576).toFixed(1)}MB  tag=${pack.tag}`)
  if (dry) return

  const releases = await api(`/repos/${REPO}/releases`)
  let release = releases.find((item) => item.tag_name === pack.tag)
  if (release) console.log('复用已有 release #' + release.id)
  else {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    release = await api(`/repos/${REPO}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: pack.tag,
        target_commitish: head,
        name: pack.title,
        body: pack.body,
      }),
    })
    console.log('新建 release #' + release.id)
  }

  const existing = (release.assets || []).find((item) => item.name === lock.file)
  if (existing) {
    if (existing.size === bytes) { console.log('asset 已存在且大小一致，跳过上传：' + existing.browser_download_url); return }
    await api(`/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' })
    console.log('删掉旧的同名 asset')
  }

  const started = Date.now()
  const asset = await api(`/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(lock.file)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip', 'content-length': String(bytes) },
    body: createReadStream(FILE),
    duplex: 'half',
  }, true)
  console.log(`上传完成 ${(bytes / 1048576).toFixed(1)}MB / ${((Date.now() - started) / 1000).toFixed(0)}s`)
  console.log(asset.browser_download_url)
}

await main()
