import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { MAX_FRAME_SVG_CHARS } from './media.js'

// Rendering must not acquire filesystem/network resources referenced by SVGs.
export function validateExportSvg(svg) {
  if (svg.length > MAX_FRAME_SVG_CHARS || !/<svg\b/i.test(svg)) throw new Error('导出帧不是有效尺寸的 SVG')
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|@import|<foreignObject\b/i.test(svg)) throw new Error('导出帧包含不支持的外部资源或 foreignObject')
  for (const match of svg.matchAll(/(?:\b(?:xlink:)?href)\s*=\s*(["'])(.*?)\1/gis)) {
    if (!/^(?:#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(match[2].trim())) throw new Error('导出帧不能引用外部图片或文件')
  }
  for (const match of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    if (!match[2].trim().startsWith('#')) throw new Error('导出帧不能引用外部 CSS 资源')
  }
}

export function renderExportFrame(svg, width, height) {
  validateExportSvg(svg)
  // Parse the actual document first: an invalid nested SVG image would
  // otherwise be silently omitted by the outer viewport wrapper.
  const normalized = new Resvg(svg, { font: { loadSystemFonts: /<text\b/i.test(svg) } }).toString()
  // Match drawImage(..., w, h): stretch the intrinsic SVG viewport to the
  // manifest dimensions, retaining its own viewBox/clip behavior inside it.
  const wrapper = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
    '<image width="100%" height="100%" preserveAspectRatio="none" href="data:image/svg+xml;base64,' +
    Buffer.from(normalized).toString('base64') + '"/></svg>'
  const image = new Resvg(wrapper, { background: 'white', font: { loadSystemFonts: false } }).render()
  if (image.width !== width || image.height !== height) throw new Error('宿主渲染尺寸与视频不一致')
  return image.asPng()
}

if (parentPort) {
  try {
    const root = realpathSync(workerData.dir)
    let bytes = 0, last = 0
    for (let index = 0; index < workerData.frames.length; index++) {
      const file = workerData.frames[index].file
      if (typeof file !== 'string' || isAbsolute(file)) throw new Error('导出帧路径无效')
      const absolute = realpathSync(resolve(root, file))
      const rel = relative(root, absolute)
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('导出帧路径超出媒体包')
      if (statSync(absolute).size > MAX_FRAME_SVG_CHARS * 4) throw new Error('导出帧 SVG 过大')
      const begin = performance.now()
      const png = renderExportFrame(readFileSync(absolute, 'utf8'), workerData.w, workerData.h)
      writeFileSync(join(workerData.temp, 'frame-' + String(index).padStart(8, '0') + '.png'), png)
      bytes += png.length
      parentPort.postMessage({ type: 'timing', ms: performance.now() - begin })
      if (Date.now() - last > 100 || index + 1 === workerData.frames.length) {
        parentPort.postMessage({ type: 'progress', rendered: index + 1, bytes }); last = Date.now()
      }
    }
    parentPort.postMessage({ type: 'done', rendered: workerData.frames.length, bytes })
  } catch (error) { parentPort.postMessage({ type: 'error', error: String(error.message || error) }) }
  parentPort.close()
}
