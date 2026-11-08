#!/usr/bin/env node
// wb：把一条代码视频从"什么都没有"做到"能交付的成片"。
//
// 分工：这个文件只做分发与参数搬运；判断逻辑全在 lib/ 和 engine/ 里。
// 引擎是 DrawAI 插件那套的原样拷贝（engine/VENDOR.json 记着来源），
// 所以这里每一个子命令的行为都和插件里的同名工具一致——只是画布换成了目录。

import { readFileSync } from 'node:fs'
import { mirrorEnv } from '../lib/cli.mjs'

// 版本以 package.json 为准，别再手写一份（改版本时容易漏）。
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

mirrorEnv()

const { applyFfmpegEnv } = await import('../lib/ffmpeg.mjs')
// 先自己找 FFmpeg（不下载）：找到就把路径交给引擎，子进程也会继承。
// 找不到时引擎的 ensureFfmpeg 会开始下载并让命令看起来"卡住"，所以各命令自己 preflight。
applyFfmpegEnv()

const { parseArgs, setJson, fail, line } = await import('../lib/cli.mjs')

const argv = process.argv.slice(2)
const command = argv[0]
const rest = argv.slice(1)
const { flags, positional } = parseArgs(rest)
setJson(!!flags.json)

function help() {
  line(`wb — 用代码做视频（Remotion）· ${VERSION}

用法  wb <命令> [参数]

开工
  wb setup [--install]          检查环境（node / 素材 / 运行时 / ffmpeg）；--install 缺什么装什么
  wb doctor                     打印环境细节（路径、版本、素材根）
  wb create [--dir D]           建工程；--spec 1920x1080@30 / --duration 15 / --style <slug>
                                 --storyboard 表.md / --cards "卡:样式,卡:样式" / --prompt "这条片子要什么"
  wb open   [--dir D]           看工程：每段帧区间、卡片、音轨、字幕、已有产出
  wb spec   [read|validate|scaffold]   规格与时间轴自检；scaffold 写一张分镜表骨架
  wb theme  [--list|--name X]   换主题（写 theme.ts，场景里引用它的常量）

写与看
  wb preview [--dir D] [--frames 0,60] [--at 1.5,3] [--crop x,y,w,h]
                                出定调帧拼图；--crop 出 1:1 局部看画质
  wb render  [--frame N | --range 0,90] [--wait]
                                渲片：整片 film.mp4 / 样片 pilot.mp4 / 静帧
  wb render status|list|cancel|apply
                                任务进度、已渲任务、取消、把成片落到工程根目录
  wb status  [--dir D]          工程概览 + 最近任务
  wb qa      [--file X] [--freeze 1.2]
                                帧检：黑场、静止、闪烁、空白、顶边、削波
  wb export  [--draft] [--subtitles] [--name jianying]
                                导出剪映素材包（镜头已按时间轴切好）

声音
  wb voice   [list|plan|say|align] [--voice zh-CN-XiaoxiaoNeural] [--rate +8%]
                                旁白合成 + 字幕 + 镜头跟着句子走
  wb audio   [add|list|remove|analyze|apply]
                                音轨：加 BGM/音效、量拍点、把切点吸到拍子上
  wb sync    [bind|list|clear] [--music <cueId>] [--tolerance 2]
  wb verify                     成片音画对照验收
  wb sfx     [search|get|list]  搜/下载音效（Freesound）

素材与配方
  wb assets  [list|library|use|page|gather|collect|fetch|palette|crop|capture]
  wb card    [list|search|show] 镜头卡（124 张）；show 给出这张卡的正确用法与 demo
  wb style   [list|search|read|source|frames]  整片风格（14 种）

全局
  --json                        机器可读输出（同一条命令，不打印给人看的排版）
  --dir D                       工程目录（默认当前目录）

典型节奏
  wb create --style 09-bauhaus --spec 1920x1080@30 --duration 12
  # 写 scene-0.tsx …；wb preview --at 1,3 看定调帧
  wb render --range 0,90        # 3 秒样片，看过再往下
  wb render                      # 整片
  wb qa && wb export            # 帧检通过再交付`)
}

const COMMANDS = {
  async setup() { const m = await import('../lib/commands/studio.mjs'); await m.setup(flags) },
  async doctor() { const m = await import('../lib/commands/studio.mjs'); await m.doctor(flags) },
  async create() { const m = await import('../lib/commands/studio.mjs'); await m.create(flags, positional) },
  async open() { const m = await import('../lib/commands/studio.mjs'); await m.open(flags, positional) },
  async theme() { const m = await import('../lib/commands/studio.mjs'); await m.theme(flags, positional) },
  async status() { const m = await import('../lib/commands/studio.mjs'); await m.status(flags, positional) },
  async preview() { const m = await import('../lib/commands/studio.mjs'); await m.preview(flags, positional) },
  async qa() { const m = await import('../lib/commands/studio.mjs'); await m.qa(flags, positional) },
  async export() { const m = await import('../lib/commands/studio.mjs'); await m.exportPackageCommand(flags, positional) },
  async spec() {
    const action = ['read', 'validate', 'scaffold'].includes(positional[0]) ? positional[0] : 'read'
    const m = await import('../lib/commands/studio.mjs')
    await m.spec(positional[0] === action ? { ...flags, action } : flags, positional[0] === action ? positional.slice(1) : positional)
  },
  async render() {
    const action = ['status', 'list', 'cancel', 'apply'].includes(positional[0]) ? positional[0] : 'start'
    const m = await import('../lib/commands/studio.mjs')
    await m.render({ ...flags, action }, action === 'start' ? positional : positional.slice(1))
  },
  async assets() { const m = await import('../lib/commands/media.mjs'); await m.assets(flags, positional) },
  async sfx() { const m = await import('../lib/commands/media.mjs'); await m.sfx(flags, positional) },
  async audio() { const m = await import('../lib/commands/media.mjs'); await m.audio(flags, positional) },
  async sync() { const m = await import('../lib/commands/media.mjs'); await m.sync(flags, positional) },
  async verify() { const m = await import('../lib/commands/media.mjs'); await m.verify(flags, positional) },
  async voice() { const m = await import('../lib/commands/media.mjs'); await m.voice(flags, positional) },
  async card() { const m = await import('../lib/commands/catalog.mjs'); await m.card(flags, positional) },
  async style() { const m = await import('../lib/commands/catalog.mjs'); await m.style(flags, positional) },
}

try {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    help()
  } else if (command === 'version' || command === '--version' || command === '-v') {
    line(VERSION)
  } else if (command === '__render') {
    // 由 `wb render` 自己拉起来的后台进程；不是给人用的命令。
    const { runRenderJob } = await import('../lib/commands/render-job.mjs')
    const dir = String(flags.dir || process.cwd())
    const jobId = String(flags.job)
    const frames = flags.frames === undefined ? undefined : String(flags.frames).split(',').map(Number)
    const range = flags.range === undefined ? undefined : String(flags.range).split(',').map(Number)
    await runRenderJob({
      dir, jobId,
      kind: String(flags.kind || 'film'),
      operation: String(flags.operation || 'full'),
      output: String(flags.output),
      frames, range,
      onProgress: (message) => {
        if (!process.stderr.isTTY) return
        const percent = Math.round((message.progress || 0) * 100)
        const extra = message.frames ? ' · ' + message.frames.done + '/' + message.frames.total + ' 帧' + (message.frames.etaSeconds ? ' · 约 ' + Math.round(message.frames.etaSeconds) + 's 后完成' : '') : ''
        process.stderr.write('\r  ' + percent + '% ' + (message.phase || '') + extra + '          ')
      },
    })
    if (process.stderr.isTTY) process.stderr.write('\n')
  } else if (!COMMANDS[command]) {
    fail(new Error('没有这个命令：' + command + '\n`wb help` 看全部命令。'))
  } else {
    await COMMANDS[command]()
  }
} catch (error) {
  fail(error)
}
