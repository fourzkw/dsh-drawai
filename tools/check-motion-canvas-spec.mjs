// 画布规格三块（【分镜表】/【风格】/【旁白】）的解析与校验回归。
//
// 这里守的是这次真出过的事故：分镜表被拆成"一镜一个文本节点"，
// 于是 motion_project 读不到分镜、apply 也回填错节点。
// 跑法：node tools/check-motion-canvas-spec.mjs
import assert from 'node:assert/strict'
import { buildMxfile, parseMxfile } from '../src/mxfile.js'

import {
  SPEC_MARKERS,
  findSpecNodes,
  parseFrames,
  parseStoryboard,
  readCanvasSpec,
  storyboardTable,
  validateCanvasSpec,
  scaffoldOps,
  parseNarration,
  parseStyle,
} from '../src/motion/canvas-spec.js'

let passed = 0
const ok = (label, value) => {
  passed += 1
  console.log('  ok ' + label + (value === undefined ? '' : '：' + value))
}

console.log('1) 帧区间解析')
{
  assert.equal(parseFrames('0–35f').durationFrames, 36)
  assert.equal(parseFrames('0–35f').startFrame, 0)
  assert.equal(parseFrames('288f').durationFrames, 288)
  assert.equal(parseFrames('7.2s', 30).durationFrames, 216)
  const half = parseFrames('0.0–0.5s', 24)
  assert.equal(half.startFrame, 0)
  assert.equal(half.durationFrames, 12)
  assert.equal(parseFrames('36–71f', 24).startFrame, 36)
  assert.equal(parseFrames('胡说'), null)
  ok('f / s / 区间 / 垃圾输入', '0–35f=36, 0.0–0.5s@24=12')
}

console.log('2) 分镜表生成 → 解析 往返一致')
{
  const table = storyboardTable([
    { intent: '静物开场', onScreen: '纸上横躺一支铅笔', copy: '' },
    { intent: '铅笔滚半圈', onScreen: '墨点炸开', copy: '（无字）' },
  ], { fps: 24, totalFrames: 288 })
  assert.ok(table.startsWith('| 镜头 | 帧区间 |'))
  const label = SPEC_MARKERS.storyboard + '\n' + table
  const parsed = parseStoryboard(label, { fps: 24 })
  assert.deepEqual(parsed.problems, [])
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rows[0].shot, 'shot-1')
  assert.equal(parsed.rows[0].durationFrames, 144)
  assert.equal(parsed.rows[1].startFrame, 144)
  assert.equal(parsed.rows[1].copy, '（无字）')
  ok('两行 / 288 帧均分', JSON.stringify(parsed.rows.map((row) => [row.shot, row.startFrame, row.durationFrames])))
}

console.log('3) 一镜一节点 → validate 报错')
{
  const doc = {
    nodes: [
      { id: 'n1', label: '《落笔》' },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: 'n' + (index + 3),
        label: (index * 0.5).toFixed(1) + '–' + ((index + 1) * 0.5).toFixed(1) + 's  镜' + (index + 1) + '｜某一镜',
      })),
      { id: 'n11', label: '《落笔》主片', data: { motion: { fps: 24, duration: 12 } } },
    ],
  }
  const found = findSpecNodes(doc)
  assert.equal(found.split.length, 8)
  const result = validateCanvasSpec(doc, { spec: { fps: 24, totalFrames: 288 } })
  assert.ok(result.errors.some((line) => line.includes('拆成了 8 条')))
  assert.ok(result.errors.some((line) => line.includes('缺【分镜表】')))
  ok('拆成 8 条被拦', result.errors.length + ' 条错误')
}

console.log('4) 合格的一张表 → validate 通过')
{
  const table = storyboardTable([
    { intent: '开场', onScreen: '铅笔', copy: '' },
    { intent: '起手', onScreen: '墨点', copy: '' },
  ], { fps: 24, totalFrames: 288 })
  const doc = {
    nodes: [
      { id: 'n3', label: SPEC_MARKERS.storyboard + '\n' + table },
      { id: 'n11', label: '主片', data: { motion: { fps: 24, duration: 12 } } },
    ],
  }
  const result = validateCanvasSpec(doc, { spec: { fps: 24, totalFrames: 288 } })
  assert.deepEqual(result.errors, [])
  assert.equal(result.read.storyboard.length, 2)
  ok('无错误', JSON.stringify(result.warnings))
}

console.log('5) 表帧数之和 ≠ 节点时长 → 报错')
{
  const table = storyboardTable([{ intent: 'a' }, { intent: 'b' }], { fps: 24, totalFrames: 288 })
  const doc = { nodes: [{ id: 'n3', label: SPEC_MARKERS.storyboard + '\n' + table }] }
  const result = validateCanvasSpec(doc, { spec: { fps: 24, totalFrames: 300 } })
  assert.ok(result.errors.some((line) => line.includes('各镜加起来是 288 帧')))
  ok('帧数对不上被拦')
}

console.log('6) 风格 / 旁白 解析')
{
  const style = parseStyle(SPEC_MARKERS.style + '\npage #F7F3EA\ntext #2B2B2B\nserif "Noto Serif SC"\nmaterials: kraft, ink')
  assert.deepEqual(style.tokens, { page: '#F7F3EA', text: '#2B2B2B' })
  assert.equal(style.fonts.serif, 'Noto Serif SC')
  assert.deepEqual(style.materials, ['kraft', 'ink'])
  const narration = parseNarration(SPEC_MARKERS.narration + '\n## shot-1\n一句话。\n又一句。\n## shot-2\n第二镜。')
  assert.equal(narration.sections.length, 2)
  assert.deepEqual(narration.sections[0].lines, ['一句话。', '又一句。'])
  ok('颜色 / 字体 / 材质 / 分节')
}

console.log('7) scaffold 只在缺的时候建，并选择不重叠的空位')
{
  const doc = { nodes: [{ id: 'n11', label: '主片', x: 900, y: 203, w: 880, h: 495 }] }
  const built = scaffoldOps(doc, { videoNode: doc.nodes[0], storyboard: [{ intent: 'a' }], narration: '## shot-1\n一句话。' })
  assert.equal(built.ops.length, 3)
  assert.equal(built.ops[0].shape, 'text')
  assert.ok(built.ops[0].x < 900)
  assert.ok(built.ops[0].label.startsWith(SPEC_MARKERS.storyboard))
  const again = scaffoldOps({ nodes: [...doc.nodes, { id: 'n3', label: built.ops[0].label }] }, { videoNode: doc.nodes[0], narration: '## shot-1\nx' })
  assert.ok(again.ops.every((op) => !op.label.startsWith(SPEC_MARKERS.storyboard)))
  ok('补缺不重复', '第二次只建 ' + again.ops.length + ' 个')
  const video = { id: 'movie', x: 700, y: 200, w: 880, h: 495 }
  const obstacle = { id: 'existing', x: 1720, y: 40, w: 700, h: 300 }
  const longRow = { intent: '很长的中文分镜描述'.repeat(20), onScreen: '纸纹与图形'.repeat(10) }
  const right = scaffoldOps({ nodes: [video, obstacle] }, { videoNode: video, storyboard: [longRow], narration: '测试旁白' }).ops
  assert.ok(right[0].x >= video.x + video.w + 100, '左侧空间不足时转到视频右侧')
  assert.ok(right[0].y >= obstacle.y + obstacle.h + 50, '避开右侧已有节点')
  assert.ok(right[0].h > built.ops[0].h, '长文字按换行估算更高的文本框')
  assert.ok(right.every((item, index) => !index || item.y >= right[index - 1].y + right[index - 1].h + 50), '规格区项目留足垂直间距')
  const wideVideo = { id: 'movie', x: 900, y: 200, w: 880, h: 495 }
  const leftBlocked = { id: 'left', x: 60, y: 40, w: 700, h: 1000 }
  const alternative = scaffoldOps({ nodes: [wideVideo, leftBlocked] }, { videoNode: wideVideo }).ops
  assert.ok(alternative[0].x >= wideVideo.x + wideVideo.w + 100 && alternative[0].y === 40, '左侧拥挤时选择右侧空位，而非堆到很远的下方')
  ok('靠左视频、已有节点和长文本均不重叠')
}

console.log('8) readCanvasSpec 汇总问题')
{
  const doc = { nodes: [{ id: 'n1', label: 'x' }] }
  const read = readCanvasSpec(doc, { fps: 30 })
  assert.ok(read.problems.some((line) => line.includes('还没有【分镜表】')))
  assert.equal(read.nodes.storyboard, null)
  ok('缺表提示')
}

console.log('9) 表格单元格转义兼容视频工程')
{
  const source = [
    { intent: '咖啡 | 茶\\点心\n第二行', onScreen: 'C:\\new\\assets', copy: '字面量 \\n 与 **星号** 和 `反引号`' },
    { intent: '下一镜', onScreen: '杯子', copy: '' },
  ]
  const label = SPEC_MARKERS.storyboard + '\n' + storyboardTable(source, { fps: 30, totalFrames: 60 })
  const marked = { nodes: [{ id: 'table', label, data: { drawaiTableEscaped: '1' } }] }
  const read = readCanvasSpec(marked, { fps: 30 })
  assert.deepEqual(read.problems, [])
  assert.equal(read.storyboard.length, 2)
  assert.equal(read.storyboard[0].intent, source[0].intent)
  assert.equal(read.storyboard[0].onScreen, source[0].onScreen)
  assert.equal(read.storyboard[0].copy, source[0].copy)
  assert.deepEqual(validateCanvasSpec(marked, { spec: { fps: 30, totalFrames: 60 } }).errors, [])
  const xml = buildMxfile({ version: 2, meta: {}, nodes: [{ ...marked.nodes[0], style: 'text;html=1;', x: 0, y: 0, w: 700, h: 200 }], edges: [] }).text
  const roundTrip = readCanvasSpec(parseMxfile(xml).doc, { fps: 30 })
  assert.equal(roundTrip.storyboard[0].intent, source[0].intent, '.drawio export/import retains table cell escapes')
  assert.equal(roundTrip.storyboard[0].onScreen, source[0].onScreen)

  // Historical labels had no escape marker: Windows paths and UNC paths must
  // not be reinterpreted just because the new editor supports escaped cells.
  const oldLabel = SPEC_MARKERS.storyboard + '\n| 镜头 | 帧区间 | 镜头卡 | 这一镜要做什么 | 屏幕上出现什么 | 文案 / 声音 |\n| --- | --- | --- | --- | --- | --- |\n| shot-1 | 0–29f | — | C:\\new\\test | \\\\server\\name | — |'
  const old = readCanvasSpec({ nodes: [{ id: 'old', label: oldLabel }] }, { fps: 30 })
  assert.equal(old.storyboard[0].intent, 'C:\\new\\test')
  assert.equal(old.storyboard[0].onScreen, '\\\\server\\name')
  const ops = scaffoldOps({ nodes: [] }, { storyboard: source, fps: 30, totalFrames: 60 }).ops
  assert.equal(ops[0].data.drawaiTableEscaped, '1')
  assert.equal(scaffoldOps({ nodes: [] }, { storyboard: oldLabel }).ops[0].data, undefined)
  assert.equal(storyboardTable(oldLabel).split('\n').filter(line => line.startsWith('| 镜头')).length, 1)
  ok('新表转义往返、历史原样解析、scaffold 标记及完整表格输入')
}

console.log('\n全部通过：' + passed + ' 组')
