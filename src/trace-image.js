/**
 * 逐像素矢量化 —— 把一张位图变成一段内嵌 SVG 标记（DrawAI 的 svg 内容节点用）。
 *
 * 这里只有**像素进、SVG 出**，不碰文件系统、不碰 ctx：宿主工具与命令行脚本共用同一份。
 *
 * 管线（每一步都能在返回的 metrics 里看到数字）：
 *   ① 工作图尺寸 = src/scale，再套 grid（宽）/ gridH（高）上限；透明像素合成到 bgColor
 *   ② 四边泛洪判背景（近白 / 近灰 / 全透明）→ 不画截图底色
 *   ③ 分层 k-means（colorsDark 暗色 + colorsFill 填充）定调色板；暗像素进保护区
 *   ④ 3× 超采样归类 → 条件众数（高对比跳过）→ despeckle / minRegionArea（保护区不并）
 *   ⑤ 每色按连通域取闭合轮廓：像素**格边**上的有向图 + 左转跟随（区域恒在左侧）
 *   ⑥ RDP + 预算阶梯（受保护环不因 minLoopArea 丢弃）→ 每色一条 <path fill-rule="nonzero">
 *
 * 为什么是"格边跟随"而不是 marching squares：标签图在鞍点（对角相接）处 marching squares
 * 要人为定连通性，而格边有向图本身就无歧义 —— 每条边只属于一个区域，走完一圈恰好回到起点。
 * 代价是必须用 4 连通分区（对角相接算两个区域），见下面 connectedRegions 的注释。
 */

/** 把一个范围的数夹进 [lo, hi]。 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** 相对亮度（0..255），用于线稿/保护区与众数对比。 */
function lumaRgb(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/* ────────────────────────── ① 背景 ────────────────────────── */

/**
 * 从四边泛洪标出背景。
 *
 * 判据是"近白/近灰"而不是"等于纯白"：截图和导出图的白底常带一点点色偏（#fdfdfc 这种），
 * 用纯白判会漏掉大片底色。泛洪（而不是全局阈值）保证只吃掉**与边界连通**的那一片 ——
 * 角色内部的白围裙不连边界，不会被误删。
 */
function markBackground(rgba, width, height, options) {
  const bright = options.bgBright
  const tol = options.bgTol
  const isBg = new Uint8Array(width * height)
  const stack = []

  function nearWhite(i) {
    const o = i * 4
    const a = rgba[o + 3]
    if (a < 16) return true // 全透明也算底色
    const r = rgba[o]
    const g = rgba[o + 1]
    const b = rgba[o + 2]
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b
    return mx >= bright && mx - mn <= tol
  }
  function push(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = y * width + x
    if (isBg[i] === 1) return
    if (!nearWhite(i)) return
    isBg[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < width; x += 1) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y)
    push(width - 1, y)
  }
  while (stack.length > 0) {
    const i = stack.pop()
    const x = i % width
    const y = (i - x) / width
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  return isBg
}

/* ────────────────────────── ② 调色板 ────────────────────────── */

/** 线性同余随机数（自带，避免依赖 Math.random 的可重复性问题）。 */
function makeRandom(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * k-means（k-means++ 初始化 + Lloyd 迭代）。
 *
 * 样本是 `Float64Array(n*3)` 的 RGB。空簇会去抢一个最远的样本，免得调色板里出现重复色。
 */
function kmeans(samples, k, iterations, seed) {
  const n = samples.length / 3
  const rand = makeRandom(seed)
  const cent = []
  // 首个质心的三个通道**各取一个随机样本**（不是同一个像素的三个通道）——
  // 与 tools/vectorize-image.mjs 的那份实现保持一致：两处跑同一张图必须给出同一份调色板，
  // 否则"命令行跑出来的"和"插件跑出来的"会是两张不一样的图。
  const r0 = Math.floor(rand() * n)
  const g0 = Math.floor(rand() * n)
  const b0 = Math.floor(rand() * n)
  cent.push([samples[r0 * 3], samples[g0 * 3 + 1], samples[b0 * 3 + 2]])
  const dist2 = new Float64Array(n).fill(Infinity)
  while (cent.length < k) {
    const last = cent[cent.length - 1]
    let sum = 0
    for (let i = 0; i < n; i += 1) {
      const dr = samples[i * 3] - last[0]
      const dg = samples[i * 3 + 1] - last[1]
      const db = samples[i * 3 + 2] - last[2]
      const d = dr * dr + dg * dg + db * db
      if (d < dist2[i]) dist2[i] = d
      sum += dist2[i]
    }
    let t = rand() * sum
    let pick = n - 1
    for (let i = 0; i < n; i += 1) {
      t -= dist2[i]
      if (t <= 0) {
        pick = i
        break
      }
    }
    cent.push([samples[pick * 3], samples[pick * 3 + 1], samples[pick * 3 + 2]])
  }

  const assign = new Uint8Array(n)
  const sum = new Float64Array(k * 3)
  const count = new Int32Array(k)
  let inertia = 0
  for (let iter = 0; iter < iterations; iter += 1) {
    sum.fill(0)
    count.fill(0)
    inertia = 0
    for (let i = 0; i < n; i += 1) {
      const r = samples[i * 3]
      const g = samples[i * 3 + 1]
      const b = samples[i * 3 + 2]
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < k; c += 1) {
        const dr = r - cent[c][0]
        const dg = g - cent[c][1]
        const db = b - cent[c][2]
        const d = dr * dr + dg * dg + db * db
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      assign[i] = best
      inertia += bestD
      sum[best * 3] += r
      sum[best * 3 + 1] += g
      sum[best * 3 + 2] += b
      count[best] += 1
    }
    for (let c = 0; c < k; c += 1) {
      if (count[c] === 0) {
        let far = 0
        let farD = -1
        for (let i = 0; i < n; i += 7) {
          const dr = samples[i * 3] - cent[c][0]
          const dg = samples[i * 3 + 1] - cent[c][1]
          const db = samples[i * 3 + 2] - cent[c][2]
          const d = dr * dr + dg * dg + db * db
          if (d > farD) {
            farD = d
            far = i
          }
        }
        cent[c] = [samples[far * 3], samples[far * 3 + 1], samples[far * 3 + 2]]
      } else {
        cent[c] = [sum[c * 3] / count[c], sum[c * 3 + 1] / count[c], sum[c * 3 + 2] / count[c]]
      }
    }
  }
  return { cent: cent, assign: assign, inertia: inertia }
}

/* ────────────────────────── ④ 轮廓 ────────────────────────── */

/**
 * 按颜色把像素分成 4 连通区域，并沿**格边**走出闭合环。
 *
 * 区域 = (颜色, 4 连通块)。用 4 连通是刻意的：一条格边只能属于一个区域，
 * 而对角相接的两个像素在格边图上本来就不相邻 —— 硬按 8 连通合并它们，左转规则会在
 * 那个"捏角点"处找不到出口。
 *
 * 边的方向是**区域恒在左侧**：右边界朝上、下边界朝左。方向给错的话整张图的入度就不等于
 * 出度，走一步就断在空气里（这个坑真实踩过：外环整圈变成一堆 3~4 个点的碎片）。
 */
function traceLoops(comp, width, height, regionCount) {
  const stride = width + 1
  const outMap = new Map()
  function addEdge(cornerX, cornerY, dx, dy, id) {
    const key = cornerY * stride + cornerX
    let list = outMap.get(key)
    if (list === undefined) {
      list = []
      outMap.set(key, list)
    }
    list.push({ dx: dx, dy: dy, id: id })
  }
  const at = function (x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return -1
    return comp[y * width + x]
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = comp[y * width + x]
      const right = at(x + 1, y)
      if (right !== id) {
        if (id >= 0) addEdge(x + 1, y + 1, 0, -1, id)
        if (right >= 0) addEdge(x + 1, y, 0, 1, right)
      }
      const down = at(x, y + 1)
      if (down !== id) {
        if (id >= 0) addEdge(x, y + 1, 1, 0, id)
        if (down >= 0) addEdge(x + 1, y + 1, -1, 0, down)
      }
    }
  }

  // 左转优先：向上→左、向左→下、向下→右、向右→上（区域始终在左手边）
  function turnOrder(dx, dy) {
    if (dy === -1) return [[-1, 0], [0, -1], [0, 1], [1, 0]] // 向上走：左转是左
    if (dx === -1) return [[0, 1], [-1, 0], [0, -1], [1, 0]] // 向左走：左转是下
    if (dy === 1) return [[1, 0], [0, 1], [-1, 0], [0, -1]] // 向下走：左转是右
    return [[0, -1], [1, 0], [0, 1], [-1, 0]] // 向右走：左转是上
  }

  const loopsByRegion = new Map()
  const guardMax = 4 * stride * (height + 1)
  outMap.forEach(function (arr, startKey) {
    while (arr.length > 0) {
      const first = arr.pop()
      const points = []
      let cx = startKey % stride
      let cy = (startKey - cx) / stride
      let edge = first
      let guard = 0
      while (edge !== null && guard < guardMax) {
        guard += 1
        points.push([cx, cy])
        cx += edge.dx
        cy += edge.dy
        const key = cy * stride + cx
        const list = outMap.get(key)
        if (list === undefined || list.length === 0) {
          edge = null
          break
        }
        if (key === startKey && list.indexOf(first) >= 0) {
          list.splice(list.indexOf(first), 1)
          edge = null
          break
        }
        let pick = -1
        const order = turnOrder(edge.dx, edge.dy)
        for (let t = 0; t < order.length && pick < 0; t += 1) {
          for (let i = 0; i < list.length; i += 1) {
            if (list[i].id === edge.id && list[i].dx === order[t][0] && list[i].dy === order[t][1]) {
              pick = i
              break
            }
          }
        }
        if (pick < 0) {
          edge = null
          break
        }
        edge = list.splice(pick, 1)[0]
      }
      if (points.length < 3) continue
      let signed = 0
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        signed += a[0] * b[1] - b[0] * a[1]
      }
      const id = first.id
      let list = loopsByRegion.get(id)
      if (list === undefined) {
        list = []
        loopsByRegion.set(id, list)
      }
      list.push({ points: points, area: signed / 2 })
    }
  })
  void regionCount
  return loopsByRegion
}

/**
 * 按颜色把面积 < minArea 的 4 连通小块并进**最相似的邻色**。
 *
 * 这一版是把参考实现的行为重写正确之后的形态：参考那份 flood fill **只查了谓词没查颜色**，
 * 于是"一块"其实横跨了多个颜色，碎块判据基本失效（实测它只找到 4 个碎块）；
 * 而朴素修好（按颜色分块 + 并进"出现最多的邻色"）会把大量孤立小斑点画成实心色块，
 * 保真度反而下降（meanDist 270→277）。所以这里的取舍是：
 *   · 按颜色分块 —— 判据要跟"看起来是不是同一块颜色"一致；
 *   · 并进**颜色最接近**的邻色，而不是"面积最多的"—— 边缘的过渡色应该并回它看起来最像的那一侧；
 *   · **不连锁**：一轮里对固定快照判一次，避免小块并进小块滚雪球。
 */
/**
 * 按颜色分块合并碎块。
 * @param {Uint8Array|null} protectMask 非空时：块内受保护像素过半，或该 label 本身是保护色 → 不合并
 * @param {Uint8Array|null} protectLabels 长度为 palette.length；1 = 该色永不被合并
 */
function despeckle(labels, width, height, palette, minArea, protectMask, protectLabels) {
  if (!(minArea > 0)) {
    return { mergedPixels: 0, blocksMerged: 0, blocks: 0, protectedSkipped: 0 }
  }
  const colorCount = palette.length
  const comp = new Int32Array(width * height).fill(-1)
  const stack = []
  let mergedPixels = 0
  let blocksMerged = 0
  let protectedSkipped = 0

  // 先把每块 4 连通区域找出来（一次，不随合并改变）
  const blocks = []
  for (let i = 0; i < width * height; i += 1) {
    if (comp[i] !== -1) continue
    const label = labels[i]
    const id = blocks.length
    const pixels = []
    comp[i] = id
    stack.push(i)
    while (stack.length > 0) {
      const p = stack.pop()
      pixels.push(p)
      const x = p % width
      const y = (p - x) / width
      if (x > 0 && comp[p - 1] === -1 && labels[p - 1] === label) {
        comp[p - 1] = id
        stack.push(p - 1)
      }
      if (x + 1 < width && comp[p + 1] === -1 && labels[p + 1] === label) {
        comp[p + 1] = id
        stack.push(p + 1)
      }
      if (y > 0 && comp[p - width] === -1 && labels[p - width] === label) {
        comp[p - width] = id
        stack.push(p - width)
      }
      if (y + 1 < height && comp[p + width] === -1 && labels[p + width] === label) {
        comp[p + width] = id
        stack.push(p + width)
      }
    }
    blocks.push({ label: label, pixels: pixels })
  }

  const hist = new Int32Array(colorCount)
  const plans = []
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b]
    if (block.pixels.length >= minArea) continue
    // 背景（label 0）不参与：它是"没画东西的地方"，并它等于把图啃出洞
    if (palette[block.label] === undefined) continue
    if (protectLabels !== null && protectLabels !== undefined && protectLabels[block.label] === 1) {
      protectedSkipped += 1
      continue
    }
    if (protectMask !== null && protectMask !== undefined) {
      let prot = 0
      for (let k = 0; k < block.pixels.length; k += 1) if (protectMask[block.pixels[k]] === 1) prot += 1
      if (prot * 2 >= block.pixels.length) {
        protectedSkipped += 1
        continue
      }
    }
    hist.fill(0)
    for (let k = 0; k < block.pixels.length; k += 1) {
      const p = block.pixels[k]
      const x = p % width
      const y = (p - x) / width
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const l = labels[yy * width + xx]
          if (l !== block.label) hist[l] += 1
        }
      }
    }
    // 邻色里挑"颜色最接近"的那个（距离同色则取出现更多的那个）
    let to = block.label
    let bestScore = null
    const src = palette[block.label]
    for (let l = 0; l < colorCount; l += 1) {
      if (hist[l] === 0 || l === 0 || l === block.label) continue
      const p = palette[l]
      const d = (src[0] - p[0]) ** 2 + (src[1] - p[1]) ** 2 + (src[2] - p[2]) ** 2
      const score = d - Math.min(hist[l], 60) // 出现得多算一点加成，但不至于压过颜色差异
      if (bestScore === null || score < bestScore) {
        bestScore = score
        to = l
      }
    }
    if (to === block.label) continue
    plans.push({ pixels: block.pixels, to: to })
  }
  for (let i = 0; i < plans.length; i += 1) {
    const pixels = plans[i].pixels
    for (let k = 0; k < pixels.length; k += 1) labels[pixels[k]] = plans[i].to
    mergedPixels += pixels.length
    blocksMerged += 1
  }
  return {
    mergedPixels: mergedPixels,
    blocksMerged: blocksMerged,
    blocks: blocks.length,
    protectedSkipped: protectedSkipped,
  }
}

/**
 * 分层调色板：暗像素单独 k-means（colorsDark），其余走 colorsFill。
 * colorsDark=0 时退回单次 k-means（与旧行为一致）。
 */
function buildPalette(work, fgIndex, colors, colorsDark, colorsFill, protectLuma, seeds) {
  const darkK = Math.max(0, Math.min(colors - 1, colorsDark))
  const fillK = Math.max(1, colors - darkK)
  // 显式 colorsFill 时以它为准（仍保证总和 = colors）
  const useFill = colorsFill > 0 ? Math.max(1, Math.min(colors, colorsFill)) : fillK
  const useDark = colorsFill > 0 ? Math.max(0, colors - useFill) : darkK

  if (useDark === 0 || !(protectLuma > 0)) {
    const samples = new Float64Array(fgIndex.length * 3)
    for (let i = 0; i < fgIndex.length; i += 1) {
      const o = fgIndex[i] * 4
      samples[i * 3] = work[o]
      samples[i * 3 + 1] = work[o + 1]
      samples[i * 3 + 2] = work[o + 2]
    }
    let best = null
    for (let s = 1; s <= seeds; s += 1) {
      const got = kmeans(samples, colors, 24, s * 2654435761)
      if (best === null || got.inertia < best.inertia) best = got
    }
    return {
      cents: best.cent,
      colorsDark: 0,
      colorsFill: colors,
      darkSamples: 0,
      fillSamples: fgIndex.length,
    }
  }

  const darkIdx = []
  const fillIdx = []
  for (let i = 0; i < fgIndex.length; i += 1) {
    const p = fgIndex[i]
    const o = p * 4
    if (lumaRgb(work[o], work[o + 1], work[o + 2]) <= protectLuma) darkIdx.push(p)
    else fillIdx.push(p)
  }

  // 某一侧为空时，把配额并给另一侧，避免空簇
  let kDark = useDark
  let kFill = useFill
  if (darkIdx.length === 0) {
    kFill = colors
    kDark = 0
  } else if (fillIdx.length === 0) {
    kDark = colors
    kFill = 0
  }

  const cents = []
  function runK(indexes, k, seedBase) {
    if (k <= 0 || indexes.length === 0) return
    const samples = new Float64Array(indexes.length * 3)
    for (let i = 0; i < indexes.length; i += 1) {
      const o = indexes[i] * 4
      samples[i * 3] = work[o]
      samples[i * 3 + 1] = work[o + 1]
      samples[i * 3 + 2] = work[o + 2]
    }
    const kk = Math.min(k, indexes.length)
    let best = null
    for (let s = 1; s <= seeds; s += 1) {
      const got = kmeans(samples, kk, 24, seedBase + s * 2654435761)
      if (best === null || got.inertia < best.inertia) best = got
    }
    for (let c = 0; c < best.cent.length; c += 1) cents.push(best.cent[c])
  }
  runK(darkIdx, kDark, 1)
  runK(fillIdx, kFill, 100)
  // 极端情况下簇数不足：用全体像素补满
  if (cents.length < colors) {
    const samples = new Float64Array(fgIndex.length * 3)
    for (let i = 0; i < fgIndex.length; i += 1) {
      const o = fgIndex[i] * 4
      samples[i * 3] = work[o]
      samples[i * 3 + 1] = work[o + 1]
      samples[i * 3 + 2] = work[o + 2]
    }
    const need = colors - cents.length
    const got = kmeans(samples, Math.min(colors, fgIndex.length), 24, 999 * 2654435761)
    for (let c = 0; c < got.cent.length && cents.length < colors; c += 1) cents.push(got.cent[c])
    void need
  }

  return {
    cents: cents.slice(0, colors),
    colorsDark: kDark,
    colorsFill: kFill,
    darkSamples: darkIdx.length,
    fillSamples: fillIdx.length,
  }
}

/* ────────────────────────── ⑤ 简化与编码 ────────────────────────── */

/** 把一条闭合折线在"一对最远点"处断开，两段各跑 Douglas-Peucker。 */
function simplifyClosed(points, epsilon) {
  const n = points.length
  if (n < 4 || epsilon <= 0) return points.slice()
  let i0 = 0
  for (let i = 1; i < n; i += 1) {
    if (points[i][0] < points[i0][0] || (points[i][0] === points[i0][0] && points[i][1] < points[i0][1])) i0 = i
  }
  let i1 = i0
  let best = -1
  for (let i = 0; i < n; i += 1) {
    const d = (points[i][0] - points[i0][0]) ** 2 + (points[i][1] - points[i0][1]) ** 2
    if (d > best) {
      best = d
      i1 = i
    }
  }
  if (i1 === i0) return points.slice()
  const segA = []
  const segB = []
  for (let i = i0; ; i = (i + 1) % n) {
    segA.push(points[i])
    if (i === i1) break
  }
  for (let i = i1; ; i = (i + 1) % n) {
    segB.push(points[i])
    if (i === i0) break
  }
  return simplifyOpen(segA, epsilon).slice(0, -1).concat(simplifyOpen(segB, epsilon).slice(0, -1))
}

function simplifyOpen(points, epsilon) {
  if (points.length < 3) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  const eps2 = epsilon * epsilon
  while (stack.length > 0) {
    const range = stack.pop()
    const i0 = range[0]
    const i1 = range[1]
    if (i1 <= i0 + 1) continue
    const x0 = points[i0][0]
    const y0 = points[i0][1]
    const x1 = points[i1][0]
    const y1 = points[i1][1]
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy
    let far = -1
    let farD = -1
    for (let i = i0 + 1; i < i1; i += 1) {
      const px = points[i][0]
      const py = points[i][1]
      let d
      if (len2 === 0) {
        d = (px - x0) ** 2 + (py - y0) ** 2
      } else {
        let t = ((px - x0) * dx + (py - y0) * dy) / len2
        t = clamp(t, 0, 1)
        d = (px - (x0 + t * dx)) ** 2 + (py - (y0 + t * dy)) ** 2
      }
      if (d > farD) {
        farD = d
        far = i
      }
    }
    if (farD > eps2) {
      keep[far] = 1
      stack.push([i0, far], [far, i1])
    }
  }
  const out = []
  for (let i = 0; i < points.length; i += 1) if (keep[i] === 1) out.push(points[i])
  return out
}

/**
 * 一条闭合环 → path 的 `d`。
 *
 * 起点用绝对 `M`，其余用小写相对 `l dx dy`（命令字母能省就省），**每 8 段用绝对 `L`
 * 重新锚定** —— 相对量取整后会累积误差，锚定把它按段清零。
 * 取整必须**先算再判零**：先判零后取整会写出 `l12`（本是 `l12 0`）或裸 `0` 这种非法 token，
 * 解析器会静默截断整条路径（这个坑真实踩过：图形只剩几个碎片）。
 */
function encodeLoop(points, precision) {
  const factor = Math.pow(10, precision)
  const round = function (v) {
    const r = Math.round(v * factor) / factor
    return Object.is(r, -0) ? 0 : r
  }
  const text = function (v) {
    const r = round(v)
    return String(r)
  }
  if (points.length < 3) return null
  let d = 'M' + text(points[0][0]) + ' ' + text(points[0][1])
  let px = points[0][0]
  let py = points[0][1]
  let emitted = 0
  for (let i = 1; i < points.length; i += 1) {
    const x = points[i][0]
    const y = points[i][1]
    if (i % 8 === 0) {
      d += 'L' + text(x) + ' ' + text(y)
    } else {
      const rx = round(x - px)
      const ry = round(y - py)
      if (rx === 0 && ry === 0) {
        px = x
        py = y
        continue
      }
      if (rx === 0) d += 'l0 ' + text(ry)
      else if (ry === 0) d += 'l' + text(rx) + ' 0'
      else d += 'l' + text(rx) + ' ' + text(ry)
      emitted += 1
    }
    px = x
    py = y
  }
  if (emitted < 2) return null
  return d + 'z'
}

/* ────────────────────────── 门面 ────────────────────────── */

/** 把 bgColor 规范成 [r,g,b]（数组或 #rrggbb；认不出就白）。 */
function parseBgColor(raw) {
  if (Array.isArray(raw) && raw.length >= 3) {
    return [
      clamp(Math.round(Number(raw[0])), 0, 255),
      clamp(Math.round(Number(raw[1])), 0, 255),
      clamp(Math.round(Number(raw[2])), 0, 255),
    ]
  }
  if (typeof raw === 'string') {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim())
    if (m) {
      const n = parseInt(m[1], 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
  }
  return [255, 255, 255]
}

/**
 * 工作图尺寸：先按 scale 降，再用 grid（宽）/ gridH（高，0=不限）做上限；超限等比压。
 * @returns {{width:number,height:number,scaleRequested:number,scaleApplied:number,grid:number,gridH:number,sizeNotes:string}}
 */
function resolveWorkSize(srcWidth, srcHeight, options) {
  const scaleRequested = Number(options.scale)
  const scaleRounded = Math.round(scaleRequested)
  const scaleApplied = scaleRounded >= 1 ? scaleRounded : 1
  const grid = Math.max(16, Math.round(Number(options.grid)))
  const gridHRaw = Number(options.gridH)
  const gridH = gridHRaw > 0 ? Math.max(16, Math.round(gridHRaw)) : 0

  const notes = []
  if (!(scaleRequested >= 1) || scaleRounded !== scaleApplied) {
    notes.push('scale clamped to ' + scaleApplied + ' (requested ' + scaleRequested + ')')
  }

  let width = Math.max(1, Math.round(srcWidth / scaleApplied))
  let height = Math.max(1, Math.round(srcHeight / scaleApplied))
  if (scaleApplied > 1) notes.push('scaleApplied ' + scaleApplied)

  const capH = gridH > 0 ? gridH : Infinity
  if (width > grid || height > capH) {
    const factor = Math.min(grid / width, capH / height)
    const nextW = Math.max(16, Math.round(width * factor))
    const nextH = Math.max(16, Math.round(height * factor))
    const parts = []
    if (width > grid) parts.push('width')
    if (height > capH) parts.push('height')
    notes.push('grid capped ' + parts.join('+') + ' (' + width + '×' + height + ' → ' + nextW + '×' + nextH + ')')
    width = nextW
    height = nextH
  }

  return {
    width: width,
    height: height,
    scaleRequested: scaleRequested,
    scaleApplied: scaleApplied,
    grid: grid,
    gridH: gridH,
    sizeNotes: notes.join('; '),
  }
}

/** 矢量化的默认参数（宿主工具与命令行共用）。 */
export const TRACE_DEFAULTS = {
  preset: 'default', // 命名预设，见 TRACE_PRESETS；显式字段覆盖预设
  colors: 12, // 前景调色板色数（背景另占 1 色）= colorsDark + colorsFill（auto）
  colorsDark: 3, // 暗色配额（线稿）；0 = 不分层，全体一次 k-means
  colorsFill: 0, // 填充色配额；0 = 自动 colors - colorsDark
  grid: 499, // 工作图宽度上限（px）；与 gridH 一起做等比封顶
  gridH: 0, // 工作图高度上限（px）；0 = 不限高（只卡宽，兼容旧行为）
  scale: 1, // 真降采样因子：work ≈ src/scale，再套 grid/gridH（=1 表示不按 scale 降）
  epsilon: 2.0, // RDP 简化容差（像素）
  precision: 1, // 坐标小数位
  minArea: 10, // despeckle：小于这个面积（像素²）的碎块并进邻色；0 = 关
  minRegionArea: 0, // despeckle 之后再按面积并区域；0 = 关（与 minArea 分开调）
  protectLuma: 110, // 亮度 ≤ 此值的前景像素受保护（不 despeckle / 不 ladder 丢环）；0 = 关
  majorityContrast: 40, // 局部亮度差 ≥ 此值则跳过众数滤波（保线稿）；0 = 全图滤波（旧行为）
  bgBright: 238, // 判"近白"的亮度下限
  bgTol: 10, // 判"近灰"的通道差上限
  bgColor: [255, 255, 255], // 透明/半透明像素合成底色（再进泛洪与 k-means）
  seeds: 3, // k-means 重启次数（取 inertia 最小）
  // SVG 上限（换算成 drawio style 里的 data URI 要塞得下）。宿主的硬上限是 250000 字符，
  // 且它自己会再留 2000 的余量 —— 所以这里直接对齐到 248000：整图的精细度就由这个预算决定
  // （预算越小，管线越要抬 epsilon、丢小环）。命令行想更省字符可显式传 --budget。
  maxBytes: 248000,
  includeLabels: false, // 额外返回"去碎块后"的标签图（调试/比对用；会额外占 width*height 字节的 base64）
}

/**
 * 命名预设：AI 先选场景，再按需覆盖单个字段。
 * 合并顺序：TRACE_DEFAULTS ← preset ← 显式字段。
 */
export const TRACE_PRESETS = {
  default: {},
  /** 插画 / 线稿：多留暗色、严保细线、轮廓更细 */
  lineart: {
    colorsDark: 4,
    protectLuma: 130,
    majorityContrast: 32,
    minArea: 4,
    epsilon: 1.5,
    precision: 2,
  },
  /** 照片 / 渐变：少暗色配额、碎块并多一点、轮廓可粗 */
  photo: {
    colors: 14,
    colorsDark: 1,
    protectLuma: 80,
    majorityContrast: 55,
    minArea: 16,
    epsilon: 2.5,
  },
  /** 图标 / 简单截图：少色 + 降采样，压字符数 */
  simple: {
    colors: 6,
    colorsDark: 2,
    scale: 2,
    grid: 320,
    epsilon: 3,
    minArea: 20,
    protectLuma: 100,
  },
}

/** 合法预设名列表（给报错 / 提示用）。 */
export const TRACE_PRESET_NAMES = Object.keys(TRACE_PRESETS)

/**
 * 合并默认值 + 预设 + 显式覆盖。未知 preset 抛错（让 AI 立刻改，而不是静默当 default）。
 * @returns {{options:object, preset:string}}
 */
export function resolveTraceOptions(rawOptions) {
  const raw = rawOptions === undefined || rawOptions === null ? {} : rawOptions
  const presetName = typeof raw.preset === 'string' && raw.preset.length > 0 ? raw.preset : 'default'
  if (TRACE_PRESETS[presetName] === undefined) {
    throw new Error(
      '未知 trace preset "' + presetName + '"；可用：' + TRACE_PRESET_NAMES.join(', '),
    )
  }
  const options = Object.assign({}, TRACE_DEFAULTS, TRACE_PRESETS[presetName], raw, { preset: presetName })
  return { options: options, preset: presetName }
}

/**
 * 根据 metrics 生成一句调参建议（给 AI 读，不是给用户的长文）。
 */
export function hintTraceTune(metrics) {
  if (metrics === undefined || metrics === null) return ''
  const hints = []
  const budget = Number(metrics.budget) || TRACE_DEFAULTS.maxBytes
  const chars = Number(metrics.svgChars) || 0
  if (chars > budget * 0.9 || Number(metrics.attempts) > 1) {
    hints.push('字符紧/触发预算阶梯 → 试 scale:2、加大 epsilon、减小 colors/grid，或 preset:"simple"')
  }
  if (Number(metrics.protectPixels) === 0 && metrics.preset !== 'photo') {
    hints.push('无暗像素保护区 → 插画线稿可试 preset:"lineart" 或提高 protectLuma')
  }
  if (Number(metrics.colorsDark) === 0 && Number(metrics.darkSamples) === 0 && metrics.preset === 'lineart') {
    hints.push('lineart 但没分到暗样本 → 提高 protectLuma 或检查原图对比度')
  }
  if (Number(metrics.majoritySkipped) === 0 && Number(metrics.majorityContrast) > 0) {
    hints.push('众数未跳过任何像素 → 图对比偏低，可减小 majorityContrast 或改 preset')
  }
  if (chars < budget * 0.35 && Number(metrics.scaleApplied) >= 2) {
    hints.push('字符很富余且已降采样 → 可 scale:1 或减小 epsilon 换保真')
  }
  if (hints.length === 0) {
    hints.push('指标正常；线稿糊/断可试 preset:"lineart"；要更省字符用 preset:"simple"')
  }
  return hints.join('；')
}

/**
 * 压缩给 AI 的结构化调参回执（diagram_apply.trace[]）。
 */
export function summarizeTraceForAi(metrics, extra) {
  const base = {
    preset: metrics.preset,
    image: extra && extra.image !== undefined ? extra.image : undefined,
    nodeId: extra && extra.nodeId !== undefined ? extra.nodeId : undefined,
    // 只描了原图的一块时才有：那块在原图里的位置与尺寸（像素）——
    // 模型据此知道"这次只覆盖了局部"，以及该按原图坐标把它摆到哪。
    crop: metrics.crop,
    source: metrics.source,
    work: metrics.work,
    scaleApplied: metrics.scaleApplied,
    sizeNotes: metrics.sizeNotes,
    colors: metrics.colors,
    colorsDark: metrics.colorsDark,
    colorsFill: metrics.colorsFill,
    protectPixels: metrics.protectPixels,
    majoritySkipped: metrics.majoritySkipped,
    paths: metrics.paths,
    loopsKept: metrics.loopsKept,
    loopsProtectedKept: metrics.loopsProtectedKept,
    regionsProtected: metrics.regionsProtected,
    svgChars: metrics.svgChars,
    budget: metrics.budget,
    attempts: metrics.attempts,
    exactPixelCoverage: metrics.exactPixelCoverage,
    options: metrics.optionsApplied,
    hint: metrics.tuneHint,
  }
  return base
}

/**
 * 位图 → SVG 标记。
 *
 * @param {{width:number,height:number,data:Buffer|Uint8Array}} raster RGBA8
 * @param {object} [rawOptions] 见 TRACE_DEFAULTS / TRACE_PRESETS（可用 preset）
 * @returns {{svg:string, metrics:object}}
 */
export function traceRasterToSvg(raster, rawOptions) {
  const resolved = resolveTraceOptions(rawOptions)
  const options = resolved.options
  const preset = resolved.preset
  const colors = Math.max(2, Math.min(24, Math.round(options.colors)))
  const colorsDark = Math.max(0, Math.min(colors, Math.round(options.colorsDark)))
  const colorsFillOpt = Math.max(0, Math.min(colors, Math.round(options.colorsFill)))
  const minArea = Math.max(0, Math.round(options.minArea))
  const minRegionArea = Math.max(0, Math.round(options.minRegionArea))
  const protectLuma = Math.max(0, Number(options.protectLuma))
  const majorityContrast = Math.max(0, Number(options.majorityContrast))
  const seeds = Math.max(1, Math.round(options.seeds))
  const bgColor = parseBgColor(options.bgColor)

  const srcWidth = raster.width
  const srcHeight = raster.height
  const rgba = raster.data

  const sized = resolveWorkSize(srcWidth, srcHeight, options)
  const width = sized.width
  const height = sized.height
  const scale = sized.scaleApplied

  // 降采样（面积平均）+ 把每个源像素先合成到 bgColor：一次写完，后面只认不透明的 width×height 工作图
  const work = new Uint8Array(width * height * 4)
  const bgR = bgColor[0]
  const bgG = bgColor[1]
  const bgB = bgColor[2]
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * srcHeight) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcHeight) / height))
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * srcWidth) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcWidth) / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const o = (yy * srcWidth + xx) * 4
          const srcA = rgba[o + 3]
          const af = srcA / 255
          const inv = 1 - af
          // RGB 先合成到 bgColor，避免半透明边缘带着脏 RGB；alpha 原样平均留给 nearWhite(a<16)
          r += rgba[o] * af + bgR * inv
          g += rgba[o + 1] * af + bgG * inv
          b += rgba[o + 2] * af + bgB * inv
          a += srcA
          n += 1
        }
      }
      const o = (y * width + x) * 4
      work[o] = Math.round(r / n)
      work[o + 1] = Math.round(g / n)
      work[o + 2] = Math.round(b / n)
      work[o + 3] = Math.round(a / n)
    }
  }

  // ② 背景 + 调色板
  const isBg = markBackground(work, width, height, options)
  const bgMean = [255, 255, 255]
  {
    let n = 0
    const sum = [0, 0, 0]
    for (let i = 0; i < width * height; i += 1) {
      if (isBg[i] === 0) continue
      sum[0] += work[i * 4]
      sum[1] += work[i * 4 + 1]
      sum[2] += work[i * 4 + 2]
      n += 1
    }
    if (n > 0) {
      bgMean[0] = Math.round(sum[0] / n)
      bgMean[1] = Math.round(sum[1] / n)
      bgMean[2] = Math.round(sum[2] / n)
    }
  }

  const fgIndex = []
  for (let i = 0; i < width * height; i += 1) if (isBg[i] === 0) fgIndex.push(i)
  if (fgIndex.length === 0) throw new Error('这张图整幅都是背景色（近白/近灰），没有可画的像素')

  // 保护区：暗前景像素（线稿）—— despeckle / ladder 都不动它们
  const protectMask = new Uint8Array(width * height)
  let protectPixels = 0
  if (protectLuma > 0) {
    for (let i = 0; i < fgIndex.length; i += 1) {
      const p = fgIndex[i]
      const o = p * 4
      if (lumaRgb(work[o], work[o + 1], work[o + 2]) <= protectLuma) {
        protectMask[p] = 1
        protectPixels += 1
      }
    }
  }

  const built = buildPalette(work, fgIndex, colors, colorsDark, colorsFillOpt, protectLuma, seeds)
  const palette = [bgMean]
  for (let c = 0; c < built.cents.length; c += 1) {
    palette.push([
      clamp(Math.round(built.cents[c][0]), 0, 255),
      clamp(Math.round(built.cents[c][1]), 0, 255),
      clamp(Math.round(built.cents[c][2]), 0, 255),
    ])
  }
  const colorCount = palette.length
  const protectLabels = new Uint8Array(colorCount)
  if (protectLuma > 0) {
    for (let c = 1; c < colorCount; c += 1) {
      const p = palette[c]
      if (lumaRgb(p[0], p[1], p[2]) <= protectLuma) protectLabels[c] = 1
    }
  }

  // ③ 超采样归类（双线性）→ 条件众数滤波 → 降回原分辨率
  const ss = 3
  const sw = width * ss
  const sh = height * ss
  const gridLabels = new Uint8Array(sw * sh)
  const paletteLuma = new Float64Array(colorCount)
  for (let c = 0; c < colorCount; c += 1) {
    paletteLuma[c] = lumaRgb(palette[c][0], palette[c][1], palette[c][2])
  }
  const px = [0, 0, 0]
  for (let y = 0; y < sh; y += 1) {
    const fy = (y + 0.5) / ss - 0.5
    for (let x = 0; x < sw; x += 1) {
      const fx = (x + 0.5) / ss - 0.5
      // 双线性取样（夹在边界内）
      const sx = clamp(fx, 0, width - 1)
      const sy = clamp(fy, 0, height - 1)
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(width - 1, x0 + 1)
      const y1 = Math.min(height - 1, y0 + 1)
      const tx = sx - x0
      const ty = sy - y0
      for (let c = 0; c < 3; c += 1) {
        const v00 = work[(y0 * width + x0) * 4 + c]
        const v10 = work[(y0 * width + x1) * 4 + c]
        const v01 = work[(y1 * width + x0) * 4 + c]
        const v11 = work[(y1 * width + x1) * 4 + c]
        px[c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
      }
      let bi = 0
      let bd = Infinity
      for (let c = 0; c < colorCount; c += 1) {
        const p = palette[c]
        const dr = px[0] - p[0]
        const dg = px[1] - p[1]
        const db = px[2] - p[2]
        const d = dr * dr + dg * dg + db * db
        if (d < bd) {
          bd = d
          bi = c
        }
      }
      gridLabels[y * sw + x] = bi
    }
  }

  const scratch = new Uint8Array(gridLabels.length)
  const hist = new Int32Array(colorCount + 1)
  let majoritySkipped = 0
  let majorityApplied = 0
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const self = gridLabels[y * sw + x]
      // 局部对比高（线稿边缘）→ 跳过众数，避免细线被邻色吃掉
      if (majorityContrast > 0) {
        let minL = paletteLuma[self]
        let maxL = minL
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy
          if (yy < 0 || yy >= sh) continue
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx
            if (xx < 0 || xx >= sw) continue
            const L = paletteLuma[gridLabels[yy * sw + xx]]
            if (L < minL) minL = L
            if (L > maxL) maxL = L
          }
        }
        if (maxL - minL >= majorityContrast) {
          scratch[y * sw + x] = self
          majoritySkipped += 1
          continue
        }
      }
      hist.fill(0)
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= sh) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= sw) continue
          hist[gridLabels[yy * sw + xx]] += 1
        }
      }
      let bi = self
      let bc = 0
      for (let c = 0; c < colorCount; c += 1) {
        if (hist[c] > bc) {
          bc = hist[c]
          bi = c
        }
      }
      scratch[y * sw + x] = bi
      majorityApplied += 1
    }
  }
  gridLabels.set(scratch)

  const labels = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      hist.fill(0)
      for (let dy = 0; dy < ss; dy += 1) {
        const yy = y * ss + dy
        for (let dx = 0; dx < ss; dx += 1) hist[gridLabels[yy * sw + x * ss + dx]] += 1
      }
      let bi = 0
      let bc = -1
      for (let c = 0; c < colorCount; c += 1) {
        if (hist[c] > bc) {
          bc = hist[c]
          bi = c
        }
      }
      labels[y * width + x] = bi
    }
  }

  // 背景色（label 0）只给泛洪底色用，且最终不画 path。
  // 白衣白底时，角色内部的白也会被最近邻归到 palette[0] —— 若不改回前景色，
  // 跳过绘制 label 0 就会把裙子/头发抠成透明洞。
  let fgRelabeledFromBg = 0
  let bgForced = 0
  for (let i = 0; i < width * height; i += 1) {
    if (isBg[i] === 1) {
      if (labels[i] !== 0) bgForced += 1
      labels[i] = 0
      continue
    }
    if (labels[i] !== 0) continue
    const o = i * 4
    let bi = 1
    let bd = Infinity
    for (let c = 1; c < colorCount; c += 1) {
      const p = palette[c]
      const dr = work[o] - p[0]
      const dg = work[o + 1] - p[1]
      const db = work[o + 2] - p[2]
      const d = dr * dr + dg * dg + db * db
      if (d < bd) {
        bd = d
        bi = c
      }
    }
    labels[i] = bi
    fgRelabeledFromBg += 1
  }

  const maskOrNull = protectPixels > 0 ? protectMask : null
  const labelsOrNull = protectLuma > 0 ? protectLabels : null
  const speckle = despeckle(labels, width, height, palette, minArea, maskOrNull, labelsOrNull)
  const regionMerge = despeckle(labels, width, height, palette, minRegionArea, maskOrNull, labelsOrNull)
  const labelDump = options.includeLabels === true
    ? {
        width: width, height: height, colors: colorCount,
        palette: palette.map(function (c) { return c.join(',') }),
        labels: Buffer.from(labels).toString('base64'),
      }
    : null

  // ④ 连通域 + 轮廓（记下区域是否受保护，供 ladder 保留细环）
  const comp = new Int32Array(width * height).fill(-1)
  const regionLabel = []
  const regionArea = []
  const regionProtected = []
  const stack = []
  for (let i = 0; i < width * height; i += 1) {
    if (comp[i] !== -1) continue
    const label = labels[i]
    const id = regionLabel.length
    let area = 0
    let prot = protectLabels[label] === 1 ? 1 : 0
    comp[i] = id
    stack.push(i)
    while (stack.length > 0) {
      const p = stack.pop()
      area += 1
      if (protectMask[p] === 1) prot = 1
      const x = p % width
      const y = (p - x) / width
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          if (dx !== 0 && dy !== 0) continue // 4 连通（与格边跟随一致）
          const q = yy * width + xx
          if (comp[q] !== -1 || labels[q] !== label) continue
          comp[q] = id
          stack.push(q)
        }
      }
    }
    regionLabel.push(label)
    regionArea.push(area)
    regionProtected.push(prot)
  }

  const loopsByRegion = traceLoops(comp, width, height, regionLabel.length)

  // ⑤ 每色一条 path：外环（面积<0，顺时针）+ 洞（>0，反向）；环带 protected 标记
  const byColor = []
  for (let c = 0; c < colorCount; c += 1) byColor.push({ outer: [], hole: [], area: 0 })
  loopsByRegion.forEach(function (loops, id) {
    const label = regionLabel[id]
    const bucket = byColor[label]
    const protectedLoop = regionProtected[id] === 1
    for (let i = 0; i < loops.length; i += 1) {
      const tagged = {
        points: loops[i].points,
        area: loops[i].area,
        protected: protectedLoop,
      }
      if (loops[i].area < 0) bucket.outer.push(tagged)
      else bucket.hole.push(tagged)
    }
    bucket.area += regionArea[id]
  })

  const hex = function (color) {
    let out = '#'
    for (let c = 0; c < 3; c += 1) out += color[c].toString(16).padStart(2, '0')
    return out
  }

  const order = []
  for (let c = 0; c < colorCount; c += 1) order.push(c)
  order.sort(function (a, b) {
    return byColor[b].area - byColor[a].area
  })

  let attempts = 0
  let pathCount = 0
  let loopCount = 0
  let loopsProtectedKept = 0
  let svg = ''
  // 超预算就逐步收紧：先抬 RDP 容差，再丢小洞（受保护环永不因 minLoopArea 丢弃）
  const ladder = [
    { epsilon: options.epsilon, minLoopArea: 4 },
    { epsilon: Math.max(options.epsilon, 2.5), minLoopArea: 4 },
    { epsilon: Math.max(options.epsilon, 3), minLoopArea: 9 },
    { epsilon: Math.max(options.epsilon, 3.5), minLoopArea: 25 },
    { epsilon: Math.max(options.epsilon, 4), minLoopArea: 64 },
  ]
  for (let step = 0; step < ladder.length; step += 1) {
    attempts = step + 1
    const plan = ladder[step]
    let body = ''
    pathCount = 0
    loopCount = 0
    loopsProtectedKept = 0
    for (let k = 0; k < order.length; k += 1) {
      // label 0 = 泛洪标出的截图底色：不画（SVG 该处透明）。
      // 若画成 path，角色左右两块互不连通的底色会进同一条 nonzero path，
      // 绕向抵消时会出现"一侧透明、一侧实心白"的假背景（插画发丝顶天立地时必现）。
      if (order[k] === 0) continue
      const bucket = byColor[order[k]]
      let d = ''
      const all = bucket.outer.concat(bucket.hole)
      for (let i = 0; i < all.length; i += 1) {
        const loop = all[i]
        if (!loop.protected && Math.abs(loop.area) < plan.minLoopArea) continue
        // 洞反向 → nonzero 里挖空
        const points = loop.area > 0 ? loop.points.slice().reverse() : loop.points
        const seg = encodeLoop(simplifyClosed(points, plan.epsilon), options.precision)
        if (seg === null) continue
        d += seg
        loopCount += 1
        if (loop.protected) loopsProtectedKept += 1
      }
      if (d === '') continue
      body += "<path fill='" + hex(palette[order[k]]) + "' fill-rule='nonzero' d='" + d + "'/>"
      pathCount += 1
    }
    svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + width + " " + height + "'>" + body + '</svg>'
    if (svg.length <= options.maxBytes) break
  }

  // 精确性度量：各色层覆盖的像素数之和 vs 图像总像素（格边轮廓下两者应当完全一致）
  let covered = 0
  for (let c = 0; c < colorCount; c += 1) covered += byColor[c].area
  const loopsTotal = { value: 0 }
  loopsByRegion.forEach(function (loops) {
    loopsTotal.value += loops.length
  })

  let paletteArea = 0
  for (let c = 0; c < colorCount; c += 1) paletteArea += byColor[c].area

  const optionsApplied = {
    preset: preset,
    colors: colors,
    colorsDark: colorsDark,
    colorsFill: colorsFillOpt,
    grid: sized.grid,
    gridH: sized.gridH,
    scale: scale,
    epsilon: options.epsilon,
    precision: options.precision,
    minArea: minArea,
    minRegionArea: minRegionArea,
    protectLuma: protectLuma,
    majorityContrast: majorityContrast,
  }

  const metrics = {
    preset: preset,
    source: { width: srcWidth, height: srcHeight },
    work: { width: width, height: height, scale: scale },
    scaleRequested: sized.scaleRequested,
    scaleApplied: sized.scaleApplied,
    grid: sized.grid,
    gridH: sized.gridH,
    bgColor: bgColor.slice(),
    sizeNotes: sized.sizeNotes,
    colors: colorCount - 1,
    colorsDark: built.colorsDark,
    colorsFill: built.colorsFill,
    darkSamples: built.darkSamples,
    fillSamples: built.fillSamples,
    protectLuma: protectLuma,
    protectPixels: protectPixels,
    fgRelabeledFromBg: fgRelabeledFromBg,
    bgForced: bgForced,
    majorityContrast: majorityContrast,
    majoritySkipped: majoritySkipped,
    majorityApplied: majorityApplied,
    palette: palette.map(hex),
    backgroundPixels: (function () {
      let n = 0
      for (let i = 0; i < width * height; i += 1) if (isBg[i] === 1) n += 1
      return n
    })(),
    foregroundPixels: fgIndex.length,
    despeckle: speckle,
    regionMerge: regionMerge,
    regions: regionLabel.length,
    regionsProtected: regionProtected.reduce(function (n, v) { return n + v }, 0),
    loops: loopsTotal.value,
    paths: pathCount,
    loopsKept: loopCount,
    loopsProtectedKept: loopsProtectedKept,
    drawnPixels: covered,
    totalPixels: width * height,
    exactPixelCoverage: covered === width * height,
    svgChars: svg.length,
    budget: options.maxBytes,
    attempts: attempts,
    paletteAreaSum: paletteArea,
    optionsApplied: optionsApplied,
  }
  metrics.tuneHint = hintTraceTune(metrics)

  return {
    svg: svg,
    labels: labelDump,
    metrics: metrics,
  }
}

/**
 * 把 SVG 标记编码进 drawio 的 `image=` 值（`data:image/svg+xml,<百分号编码>`）。
 *
 * 为什么用百分号编码而不是 base64：编码后的串里一个 `;` 都没有，而 drawio 与本内核的
 * style 解析都是按 `;` 分段 —— base64 形态的 `data:image/svg+xml;base64,` 那个分号是解析器的雷。
 * 这里编得比 JSON 严格一点（`<` `>` `#` `%` `"` 和空格），换来的好处是：不管宿主把它塞进
 * 属性还是直接写进 style，都不会有歧义。
 */
export function svgToImageValue(svg) {
  const encoded = String(svg)
    .replace(/%/g, '%25')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/#/g, '%23')
    .replace(/"/g, '%22')
    .replace(/ /g, '%20')
  return 'data:image/svg+xml,' + encoded
}
