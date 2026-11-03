// Shared editor adapter. Inputs/outputs are document coordinates, independent of DOM/mxGraph.
import { routingModeOf, styleGet, stylePatch, jettyFromStyle } from '../style-kernel.js'

const ROUTE_CLEARANCE = 16
const ROUTE_SPACING = 14
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const finitePoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)

export function routingBoxes(doc) {
  const hidden = new Set((doc.layers || []).filter((layer) => layer.visible === false).map((layer) => layer.id))
  return doc.nodes.filter((node) => !hidden.has(node.layer)).map((node) => ({
    id: node.id, node,
    geo: { x: Number(node.x) || 0, y: Number(node.y) || 0, w: Number(node.w) || 170, h: Number(node.h) || 60 },
  }))
}

function constraint(edge, end) {
  const prefix = end === 'source' ? 'exit' : 'entry'
  const x = styleGet(edge.style || '', prefix + 'X', null)
  const y = styleGet(edge.style || '', prefix + 'Y', null)
  if (x === null || y === null || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return null
  return { x: Number(x), y: Number(y) }
}

function terminal(edge, end, boxes) {
  const id = end === 'source' ? edge.from : edge.to
  const box = boxes.find((item) => item.id === id)
  if (box) return box
  const point = end === 'source' ? edge.sourcePoint : edge.targetPoint
  return finitePoint(point) ? { id: null, geo: { ...point, w: 0, h: 0 } } : null
}

function border(geo, toward, pin) {
  if (pin) return { x: geo.x + pin.x * geo.w, y: geo.y + pin.y * geo.h }
  if (!geo.w || !geo.h) return { x: geo.x, y: geo.y }
  const center = { x: geo.x + geo.w / 2, y: geo.y + geo.h / 2 }
  const dx = toward.x - center.x, dy = toward.y - center.y
  // SegmentConnector semantics: use the channel through the first/last waypoint.
  if (toward.x >= geo.x && toward.x <= geo.x + geo.w && (toward.y <= geo.y || toward.y >= geo.y + geo.h)) {
    return { x: toward.x, y: toward.y <= geo.y ? geo.y : geo.y + geo.h }
  }
  if (toward.y >= geo.y && toward.y <= geo.y + geo.h && (toward.x <= geo.x || toward.x >= geo.x + geo.w)) {
    return { x: toward.x <= geo.x ? geo.x : geo.x + geo.w, y: toward.y }
  }
  if (Math.abs(dx) * geo.h >= Math.abs(dy) * geo.w) return { x: dx < 0 ? geo.x : geo.x + geo.w, y: center.y }
  return { x: center.x, y: dy < 0 ? geo.y : geo.y + geo.h }
}

export function storedRoute(edge, boxes) {
  const source = terminal(edge, 'source', boxes), target = terminal(edge, 'target', boxes)
  if (!source || !target) return null
  const points = (edge.points || []).filter(finitePoint)
  const center = (box) => ({ x: box.geo.x + box.geo.w / 2, y: box.geo.y + box.geo.h / 2 })
  const a = border(source.geo, points[0] || center(target), constraint(edge, 'source'))
  const b = border(target.geo, points[points.length - 1] || a, constraint(edge, 'target'))
  return [a, ...points.map((p) => ({ ...p })), b].filter((p, i, all) => !i || !same(p, all[i - 1]))
}

function segmentHits(a, b, geo, margin = 0) {
  return Math.min(a.x, b.x) < geo.x + geo.w + margin - 0.01 && Math.max(a.x, b.x) > geo.x - margin + 0.01 &&
    Math.min(a.y, b.y) < geo.y + geo.h + margin - 0.01 && Math.max(a.y, b.y) > geo.y - margin + 0.01
}

function obstaclesFor(edge, boxes) {
  const ends = [terminal(edge, 'source', boxes), terminal(edge, 'target', boxes)].filter(Boolean)
  const isContainer = (box) => styleGet(box.node?.style || '', 'container', '0') === '1' ||
    styleGet(box.node?.style || '', 'shape', '') === 'swimlane' || boxes.some((child) => child.node?.parent === box.id)
  return boxes.filter((box) => ends.some((end) => end.id === box.id) || !isContainer(box) || !ends.some((end) =>
    end.geo.x >= box.geo.x && end.geo.y >= box.geo.y && end.geo.x + end.geo.w <= box.geo.x + box.geo.w && end.geo.y + end.geo.h <= box.geo.y + box.geo.h))
}

export function validRoute(path, edge, boxes, clearance = 0) {
  if (!path || path.length < 2 || !path.every(finitePoint)) return false
  const obstacles = obstaclesFor(edge, boxes)
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) return false
    if (obstacles.some((box) => segmentHits(a, b, box.geo, box.id === edge.from || box.id === edge.to ? 0 : clearance))) return false
    if (i > 1) {
      const prev = path[i - 2]
      if ((a.x - prev.x) * (b.x - a.x) + (a.y - prev.y) * (b.y - a.y) < -0.01) return false
    }
  }
  return true
}

const routeLength = (path) => path.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - path[i].x) + Math.abs(p.y - path[i].y), 0)
const signature = (edge) => [edge.from, edge.to, edge.sourcePoint, edge.targetPoint, edge.style]

/** Incremental invalidation considers attached edges AND paths near old/new obstacles. */
export function affectedRoutes(before, next, oldBoxes, boxes) {
  const old = new Map(oldBoxes.map((box) => [box.id, box]))
  const current = new Map(boxes.map((box) => [box.id, box]))
  const changed = new Set([...old.keys(), ...current.keys()].filter((id) => !same(old.get(id)?.geo, current.get(id)?.geo)))
  const regions = [...changed].flatMap((id) => [old.get(id), current.get(id)].filter(Boolean))
  const previous = new Map((before?.edges || []).map((edge) => [edge.id, edge]))
  const hidden = new Set((next.layers || []).filter((layer) => layer.visible === false).map((layer) => layer.id))
  const affected = new Set()
  for (const edge of next.edges) {
    if (routingModeOf(edge) !== 'auto' || hidden.has(edge.layer) || (edge.from && edge.from === edge.to)) continue
    const prev = previous.get(edge.id)
    const path = storedRoute(prev || edge, oldBoxes.length ? oldBoxes : boxes)
    const missing = !Array.isArray(edge.points) && styleGet(edge.style || '', 'drawaiRouteStatus', null) !== 'ok'
    if (!before && !missing && validRoute(storedRoute(edge, boxes), edge, boxes)) continue
    if ((!before && (missing || !validRoute(storedRoute(edge, boxes), edge, boxes))) || (before && (!prev || !same(signature(prev), signature(edge)))) ||
      changed.has(edge.from) || changed.has(edge.to) || regions.some((box) => path?.some((p, i) => i && segmentHits(path[i - 1], p, box.geo, ROUTE_CLEARANCE + 1)))) {
      affected.add(edge.id)
    }
  }
  // Include siblings at the same terminals in one solve so their lanes can be separated.
  const terminals = new Set(next.edges.filter((edge) => affected.has(edge.id)).flatMap((edge) => [edge.from, edge.to]).filter(Boolean))
  if (before) for (const edge of next.edges) {
    if (routingModeOf(edge) === 'auto' && !hidden.has(edge.layer) && edge.from !== edge.to &&
      (terminals.has(edge.from) || terminals.has(edge.to))) affected.add(edge.id)
  }
  return affected
}

export function createOrthogonalRouter(getRuntime) {
  let solves = 0
  function solve(edges, boxes) {
    if (!edges.length) return {}
    const { Avoid, AvoidRouting } = getRuntime()
    if (!Avoid?.Router || !AvoidRouting?.computeRoutes) throw new Error('自动避障引擎未就绪')
    const vertices = boxes.map((box) => ({ id: box.id, ...box.geo }))
    const descriptors = edges.map((edge) => {
      const source = terminal(edge, 'source', boxes), target = terminal(edge, 'target', boxes)
      const pin = (end) => { const p = constraint(edge, end); return p && AvoidRouting.constraintForPoint(p.x, p.y) }
      return { id: edge.id, source: source?.id ?? '__free-source:' + edge.id, target: target?.id ?? '__free-target:' + edge.id,
        sourcePoint: source?.id ? undefined : edge.sourcePoint, targetPoint: target?.id ? undefined : edge.targetPoint,
        sourceConstraint: pin('source'), targetConstraint: pin('target'),
        sourceJetty: jettyFromStyle(edge.style || '', 'source') ?? 10,
        targetJetty: jettyFromStyle(edge.style || '', 'target') ?? 10 }
    })
    const result = Object.create(null)
    let pending = descriptors
    for (const clearance of [ROUTE_CLEARANCE, 8, 4, 2]) {
      if (!pending.length) break
      solves++
      const routes = AvoidRouting.computeRoutes(Avoid, vertices, pending, { shapeBufferDistance: clearance, idealNudgingDistance: ROUTE_SPACING })
      const failed = []
      for (const descriptor of pending) {
        const edge = edges.find((item) => item.id === descriptor.id)
        const points = routes[descriptor.id]
        if (Array.isArray(points) && validRoute(storedRoute({ ...edge, points }, boxes), edge, boxes)) result[edge.id] = Array.from(points, (p) => ({ x: p.x, y: p.y }))
        else failed.push(descriptor)
      }
      pending = failed
    }
    return result
  }

  function update(before, next, options = {}) {
    const boxes = options.boxes || routingBoxes(next)
    const oldBoxes = options.beforeBoxes || (before ? routingBoxes(before) : [])
    const affected = affectedRoutes(before, next, oldBoxes, boxes)
    const accepted = new Set()
    for (const edge of next.edges) {
      const preview = edge.__routePreview
      delete edge.__routePreview
      if (!affected.has(edge.id)) continue
      if (Array.isArray(preview) && preview.length >= 2) {
        const trial = { ...edge, points: preview.slice(1, -1) }
        if (same(storedRoute(trial, boxes), preview) && validRoute(preview, edge, boxes)) {
          edge.points = trial.points
          edge.style = stylePatch(edge.style || '', { drawaiRouteStatus: 'ok' })
          accepted.add(edge.id)
          continue
        }
      }
      // A rigid group move translates its internal routes unless an outside shape blocks them.
      const previous = before?.edges.find((item) => item.id === edge.id)
      if (!previous || !Array.isArray(previous.points)) continue
      const a0 = terminal(previous, 'source', oldBoxes), b0 = terminal(previous, 'target', oldBoxes)
      const a1 = terminal(edge, 'source', boxes), b1 = terminal(edge, 'target', boxes)
      if (!a0 || !b0 || !a1 || !b1 || !a0.id || !b0.id || !same(signature(previous), signature(edge))) continue
      const dx = a1.geo.x - a0.geo.x, dy = a1.geo.y - a0.geo.y
      if ((!dx && !dy) || b1.geo.x - b0.geo.x !== dx || b1.geo.y - b0.geo.y !== dy ||
        a0.geo.w !== a1.geo.w || a0.geo.h !== a1.geo.h || b0.geo.w !== b1.geo.w || b0.geo.h !== b1.geo.h) continue
      const points = previous.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
      if (validRoute(storedRoute({ ...edge, points }, boxes), edge, boxes, ROUTE_CLEARANCE)) {
        edge.points = points
        accepted.add(edge.id)
      }
    }
    const edges = next.edges.filter((edge) => affected.has(edge.id) && !accepted.has(edge.id)).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const routes = solve(edges, boxes)
    const failed = [], routed = [...accepted]
    for (const edge of edges) {
      const points = routes[edge.id]
      const candidate = Array.isArray(points) ? { ...edge, points } : null
      const path = candidate && storedRoute(candidate, boxes)
      if (validRoute(path, edge, boxes)) {
        // Keep a legal existing corridor for small gains, independent of frame rate.
        const previous = before?.edges.find((item) => item.id === edge.id)
        const oldPath = previous && storedRoute(previous, boxes)
        if (edges.length === 1 && previous && same(signature(previous), signature(edge)) && validRoute(oldPath, edge, boxes, 2) &&
          oldPath.length <= path.length && routeLength(oldPath) <= routeLength(path) + 16) {
          edge.points = (previous.points || []).map((p) => ({ ...p }))
        } else edge.points = points.map((p) => ({ ...p }))
        edge.style = stylePatch(edge.style || '', { drawaiRouteStatus: 'ok' })
        routed.push(edge.id)
      } else {
        edge.style = stylePatch(edge.style || '', { drawaiRouteStatus: 'blocked' })
        failed.push(edge.id)
      }
    }
    return { affected: [...affected], routed, failed, solves }
  }
  return { update, solve, get solves() { return solves } }
}
