#!/usr/bin/env node
/**
 * 回填（apply）的回归测试：两件事以前真出过事故。
 *
 *  1. 海报是 PNG data URI，却被当 SVG 文本又包一层 `data:image/svg+xml,…` —— 节点上空白。
 *     所以这里验 `styleWithMediaMarkup()` 按型别分派。
 *  2. 「样片回填到另建的样片节点」被忽略（apply 只认 job.nodeId），且样片用 range 渲染时
 *     写的就是 film.mp4，于是 4 秒样片被当成整片塞进主节点。
 *     所以这里验 `applyJobKind()`：主视频节点取 film、样片节点取 pilot、显式 source 优先。
 */
import { styleWithMediaMarkup, isRasterDataUri } from '../src/style-kernel.js'
import { applyJobKind } from '../src/motion/jobs.js'
import { normalizeManifest } from '../src/media.js'

let failed = 0
function ok(name, cond, extra) {
  if (cond) console.log('  ok ' + name)
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' —— ' + extra : '')) }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SVG = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#123"/></svg>'

console.log('1) 位图海报写成 image=，不再被包成 SVG')
{
  const style = styleWithMediaMarkup('shape=image;imageAspect=1', PNG, '0')
  ok('image= 就是 PNG data URI', style.includes('image=' + PNG), style.slice(0, 80))
  ok('没有 svg+xml 包裹', !style.includes('svg+xml'), style.slice(0, 80))
  ok('imageAspect=0', /imageAspect=0/.test(style))
  ok('shape=image', /shape=image/.test(style))
  ok('isRasterDataUri 认得它', isRasterDataUri(PNG) === true)
}

console.log('2) SVG 海报仍然走内嵌标记')
{
  const style = styleWithMediaMarkup('', SVG, '1')
  ok('是 svg+xml data URI', style.includes('data:image/svg+xml,'), style.slice(0, 60))
  ok('imageAspect=1', /imageAspect=1/.test(style))
  ok('isRasterDataUri 不认 SVG', isRasterDataUri('data:image/svg+xml,<svg/>') === false)
}

console.log('3) 空内容不动原 style')
{
  const style = styleWithMediaMarkup('rounded=1;fillColor=#fff', '', '1')
  ok('原样返回', style === 'rounded=1;fillColor=#fff', style)
}

console.log('4) 回填取哪种任务：主节点整片、样片节点样片')
{
  ok('主视频节点 → film', applyJobKind({ targetHasProject: true }) === 'film')
  ok('另建的样片节点 → pilot', applyJobKind({ targetHasProject: false }) === 'pilot')
  ok('显式 source=pilot 覆盖', applyJobKind({ source: 'pilot', targetHasProject: true }) === 'pilot')
  ok('显式 source=film 覆盖', applyJobKind({ source: 'film', targetHasProject: false }) === 'film')
}

console.log('5) raster clip pack 的时长要留得住（没有逐帧清单时不能被抹成 0）')
{
  const raster = normalizeManifest({ kind: 'raster', fps: 24, width: 1920, height: 1080, source: 'source.mp4', frames: [], duration: 12.1 })
  ok('duration 原样保留', raster.duration === 12.1, String(raster.duration))
  const withFrames = normalizeManifest({ kind: 'raster', fps: 24, width: 1920, height: 1080, frames: [{ file: 'a.png', t: 0 }, { file: 'b.png', t: 1 / 24 }], duration: 99 })
  ok('有逐帧清单时按清单算', Math.abs(withFrames.duration - 2 / 24) < 1e-9, String(withFrames.duration))
  const empty = normalizeManifest({ kind: 'raster' })
  ok('什么都没有时仍是 0', empty.duration === 0, String(empty.duration))
}

if (failed) { console.log('\n失败 ' + failed + ' 项'); process.exit(1) }
console.log('\n全部通过：5 组')
