import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Rebase only changes known to consist of generated-node patches. Unknown
// edits remain revision conflicts, never a license to overwrite a snapshot.
export function createTaskPatchJournal() {
  const cache = new Map()
  const fileOf = (path) => join(dirname(path), '.drawai-cache', 'task-patches', createHash('sha256').update(path.toLowerCase()).digest('hex') + '.json')
  function entries(path) {
    if (!cache.has(path)) {
      let values = []
      try { values = JSON.parse(readFileSync(fileOf(path), 'utf8')) } catch {}
      cache.set(path, Array.isArray(values) ? values.slice(-32) : [])
    }
    return cache.get(path)
  }
  return {
    record(path, from, to, page, added = [], removed = [], removedNodes = []) {
      const list = entries(path); list.push({ from, to, page, added, removed, removedNodes }); if (list.length > 32) list.shift()
      const file = fileOf(path); mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file + '.tmp', JSON.stringify(list)); renameSync(file + '.tmp', file)
    },
    between(path, from, to, page) {
      const list = entries(path), changes = []; let revision = from
      for (let attempt = 0; revision !== to && attempt < 32; attempt++) {
        const entry = list.find((item) => item.from === revision)
        if (!entry) return null
        if (entry.page === page) changes.push(entry)
        revision = entry.to
      }
      if (revision !== to) return null
      return { added: changes.flatMap((item) => item.added), removed: changes.flatMap((item) => item.removed), changes }
    },
  }
}

export function applyTaskPatches(doc, patch, strict = false) {
  const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
  for (const change of patch.changes || [patch]) {
    const removed = new Set(change.removed || [])
    if (strict) {
      for (const before of change.removedNodes || []) {
        const current = doc.nodes.find((node) => node.id === before.id)
        if (current && stable(current) !== stable(before)) throw new Error('后台撤销与本地节点编辑冲突，本地编辑已保留')
      }
      if ((doc.edges || []).some((edge) => removed.has(edge.from) || removed.has(edge.to))) throw new Error('后台撤销与本地连线冲突，本地编辑已保留')
    }
    doc.nodes = doc.nodes.filter((node) => !removed.has(node.id))
    if (Array.isArray(doc.drawOrder)) doc.drawOrder = doc.drawOrder.filter((id) => !removed.has(id))
    for (const node of change.added || []) if (!doc.nodes.some((item) => item.id === node.id)) {
      doc.nodes.push(JSON.parse(JSON.stringify(node)))
      if (Array.isArray(doc.drawOrder) && !doc.drawOrder.includes(node.id)) doc.drawOrder.push(node.id)
    }
  }
  return doc
}
