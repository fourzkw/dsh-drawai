import { imageValueFromStyle, styleWithSvgMarkup, styleGet } from './style-kernel.js'
import { videoMetaFromData } from './media.js'

export function applyDrawingResult(doc, job, output) {
  const existing = doc.nodes.find((node) => node.data?.drawaiTaskId === job.id)
  if (existing) return existing
  const source = doc.nodes.find((node) => node.id === job.source.id)
  if (!source) throw new Error('来源节点已删除，结果已保留')
  const layer = (doc.layers || []).find((item) => item.id === source.layer)
  if (layer?.locked || source.locked || styleGet(source.style || '', 'locked', '0') === '1') throw new Error('来源图层或节点已锁定，结果已保留')
  const seen = new Set([source.id])
  for (let parent = source.parent; parent;) {
    if (seen.has(parent)) throw new Error('来源分组结构无效')
    seen.add(parent)
    const ancestor = doc.nodes.find((node) => node.id === parent)
    if (!ancestor) break
    if (ancestor.locked || styleGet(ancestor.style || '', 'locked', '0') === '1') throw new Error('来源分组已锁定，结果已保留')
    parent = ancestor.parent
  }
  if (job.kind === 'image' && imageValueFromStyle(source.style || '') !== job.source.image) throw new Error('原图已更改，结果已保留')
  if (job.kind === 'video' && videoMetaFromData(source.data)?.clip !== job.source.clip) throw new Error('原视频已更改，结果已保留')
  const id = 'draw-' + job.id
  if (doc.nodes.concat(doc.edges || [], doc.layers || [], doc.labels || []).some((cell) => cell.id === id)) throw new Error('绘制结果 ID 冲突')
  const node = { ...source, id, x: source.x + source.w + 24, data: { ...source.data, drawaiTaskId: job.id } }
  if (job.kind === 'image') node.style = styleWithSvgMarkup(source.style || '', output.svg, styleGet(source.style || '', 'imageAspect', '1'))
  else {
    node.label = (source.label || '视频') + ' · SVG 复刻'
    node.style = styleWithSvgMarkup(source.style || '', output.poster, '1')
    node.data = { ...node.data, drawaiMedia: '1', mediaKind: 'svg', mediaClip: output.clip,
      mediaFps: String(output.fps), mediaW: String(output.w), mediaH: String(output.h), mediaPosterFrame: '0' }
  }
  const order = Array.isArray(doc.drawOrder) ? doc.drawOrder.slice() : (doc.edges || []).concat(doc.nodes).map((item) => item.id)
  doc.nodes.push(node); doc.drawOrder = [...order.filter((value) => value !== id), id]
  return node
}
