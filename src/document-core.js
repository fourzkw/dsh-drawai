/* Shared document and transaction boundary; no filesystem or UI dependencies. */
import { normalizeDrawioDoc } from './style-kernel.js'

export function cloneDocument(value) {
  return JSON.parse(JSON.stringify(value))
}

export function emptyDocument() {
  return { version: 2, revision: '', meta: { layout: 'dagre-tb' }, nodes: [], edges: [],
    layers: [{ id: '1', name: '', visible: true, locked: false }] }
}

export function normalizeDocument(raw) {
  const source = raw && typeof raw === 'object' ? cloneDocument(raw) : {}
  const normalized = normalizeDrawioDoc(source)
  // Keep extension fields (including future creative metadata) outside XML attributes.
  return { ...source, ...normalized,
    nodes: normalized.nodes.map((node, i) => ({ ...source.nodes[i], ...node })),
    edges: normalized.edges.map((edge, i) => ({ ...source.edges[i], ...edge })) }
}

export function documentTransaction(current, mutate, options = {}) {
  if (options.expectRevision !== undefined && options.expectRevision !== current.revision) throw new Error('revision conflict')
  const draft = cloneDocument(current)
  const finish = (result) => ({ doc: draft, result })
  const result = mutate(draft)
  return result && typeof result.then === 'function' ? result.then(finish) : finish(result)
}
