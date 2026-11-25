// 多轨时间轴的宿主侧入口：纯编辑逻辑在 timeline-ops.js（浏览器预览也用它），
// 这里只补 node:crypto 的版本标识，保证工作台和宿主对同一份 timeline 算出同一个 revision。
import { createHash } from 'node:crypto'
import { normalizeTimeline, serializeTimeline } from './timeline-ops.js'

export * from './timeline-ops.js'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

/** 版本标识：不含 revision / sync.resolved 等派生字段，读写两侧按同一规范计算。 */
export function timelineRevision(timeline) {
  return createHash('sha256').update(stableStringify(serializeTimeline(timeline))).digest('hex').slice(0, 16)
}
