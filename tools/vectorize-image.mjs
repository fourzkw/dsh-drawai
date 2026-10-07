// tools/vectorize-image.mjs
// 逐像素矢量化：读真实像素 → 分区 → 轮廓 → SVG。
// 依赖 DSH profile 里的 sharp 取 raw 像素（也可指到任何已装 sharp 的路径）。
//
// 用法:
//   node tools/vectorize-image.mjs --in <png> --out-svg <svg> [--out-preview <png>]
//        [--k 12] [--ss 3] [--rdp 1.0] [--min-area 10] [--bg-tol 10] [--bg-bright 238]
//        [--budget 50000] [--sharp <dir>] [--json <path>]

import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const IN = arg('in');
const OUT_SVG = arg('out-svg');
const OUT_PREVIEW = arg('out-preview', null);
const OUT_LABELMAP = arg('out-labelmap', null);
const OUT_JSON = arg('json', null);
const K = Number(arg('k', 12));
const SS = Number(arg('ss', 3));
const RDP_EPS0 = Number(arg('rdp', 1.0));
const MIN_AREA = Number(arg('min-area', 10));
const BG_TOL = Number(arg('bg-tol', 10));
const BG_BRIGHT = Number(arg('bg-bright', 238));
const BUDGET = Number(arg('budget', 50000));
const SHARP_DIR = arg('sharp', 'C:/Users/86476/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp');
if (!IN || !OUT_SVG) {
  console.error('need --in and --out-svg');
  process.exit(2);
}

const req = createRequire(import.meta.url);
const sharp = req(SHARP_DIR);

/* ---------------- load pixels ---------------- */
const img = sharp(IN, { failOn: 'none' }).ensureAlpha(); // 保住 alpha（截图底色可能靠 alpha 表达）
const meta0 = await img.metadata();
const { data: raw, info } = await img.raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels; // C = 4 (RGBA)
console.log(JSON.stringify({ step: 'load', file: path.basename(IN), meta: { w: meta0.width, h: meta0.height, ch: meta0.channels, space: meta0.space, hasAlpha: meta0.hasAlpha }, raw: { w: W, h: H, c: C }, bytes: raw.length }));

const rgb = new Uint8Array(W * H * 3);
const alpha = new Uint8Array(W * H);
for (let i = 0, p = 0, q = 0; i < W * H; i++, p += C, q += 3) {
  const a = C === 4 ? raw[p + 3] : 255;
  // 透明像素视作白底（背景）
  const inv = a === 255 ? 0 : (255 - a) / 255;
  for (let c = 0; c < 3; c++) {
    const v = raw[p + c];
    rgb[q + c] = a === 255 ? v : Math.round(v * (1 - inv) + 255 * inv);
  }
  alpha[i] = a;
}

/* ---------------- ① 四边泛洪判背景 ---------------- */
const isBg = new Uint8Array(W * H);
{
  const nearWhite = (i) => {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (alpha[i] < 16) return true; // 全透明
    return mx >= BG_BRIGHT && mx - mn <= BG_TOL; // 近白/近灰
  };
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (isBg[i]) return;
    if (!nearWhite(i)) return;
    isBg[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i - x) / W;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
}
let bgCount = 0;
for (let i = 0; i < W * H; i++) if (isBg[i]) bgCount++;
console.log(JSON.stringify({ step: 'background', bgPixels: bgCount, total: W * H, ratio: +(bgCount / (W * H)).toFixed(4) }));

// 背景代表色 = 背景像素均值
let bgMean = [255, 255, 255];
{
  let n = 0, s = [0, 0, 0];
  for (let i = 0; i < W * H; i++) if (isBg[i]) { s[0] += rgb[i * 3]; s[1] += rgb[i * 3 + 1]; s[2] += rgb[i * 3 + 2]; n++; }
  if (n) bgMean = s.map((v) => Math.round(v / n));
}

/* ---------------- ② k-means K=12，用全部（非背景）像素 ---------------- */
const fgIdx = [];
for (let i = 0; i < W * H; i++) if (!isBg[i]) fgIdx.push(i);
console.log(JSON.stringify({ step: 'foreground', fgPixels: fgIdx.length }));

function kmeans(samples, k, iters, seed) {
  // samples: Float64Array(n*3)
  const n = samples.length / 3;
  let rnd = seed >>> 0;
  const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  // k-means++ 初始化
  const cent = [];
  cent.push([samples[(Math.floor(rand() * n)) * 3], samples[(Math.floor(rand() * n)) * 3 + 1], samples[(Math.floor(rand() * n)) * 3 + 2]]);
  const d2 = new Float64Array(n).fill(Infinity);
  while (cent.length < k) {
    let sum = 0;
    const last = cent[cent.length - 1];
    for (let i = 0; i < n; i++) {
      const dr = samples[i * 3] - last[0], dg = samples[i * 3 + 1] - last[1], db = samples[i * 3 + 2] - last[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    let t = rand() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { t -= d2[i]; if (t <= 0) { pick = i; break; } }
    cent.push([samples[pick * 3], samples[pick * 3 + 1], samples[pick * 3 + 2]]);
  }
  const assign = new Uint8Array(n);
  const sum = new Float64Array(k * 3);
  const cnt = new Int32Array(k);
  let inertia = 0;
  for (let it = 0; it < iters; it++) {
    sum.fill(0); cnt.fill(0); inertia = 0;
    for (let i = 0; i < n; i++) {
      const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - cent[c][0], dg = g - cent[c][1], db = b - cent[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best; inertia += bd;
      sum[best * 3] += r; sum[best * 3 + 1] += g; sum[best * 3 + 2] += b; cnt[best]++;
    }
    for (let c = 0; c < k; c++) {
      if (!cnt[c]) { // 空簇 → 抢一个最远的样本
        let far = 0, fd = -1;
        for (let i = 0; i < n; i += 7) {
          const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
          const dr = r - cent[c][0], dg = g - cent[c][1], db = b - cent[c][2];
          const d = dr * dr + dg * dg + db * db;
          if (d > fd) { fd = d; far = i; }
        }
        cent[c] = [samples[far * 3], samples[far * 3 + 1], samples[far * 3 + 2]];
      } else {
        cent[c] = [sum[c * 3] / cnt[c], sum[c * 3 + 1] / cnt[c], sum[c * 3 + 2] / cnt[c]];
      }
    }
  }
  return { cent, assign, inertia };
}

let result = null;
{
  const n = fgIdx.length;
  const samples = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = fgIdx[i];
    samples[i * 3] = rgb[s * 3]; samples[i * 3 + 1] = rgb[s * 3 + 1]; samples[i * 3 + 2] = rgb[s * 3 + 2];
  }
  for (let seed = 1; seed <= 3; seed++) {
    const r = kmeans(samples, K, 24, seed * 2654435761);
    if (!result || r.inertia < result.inertia) result = r;
  }
}
// 调色板：0 = 背景，1..K = 前景簇
const palette = [bgMean, ...result.cent.map((c) => c.map((v) => Math.round(Math.max(0, Math.min(255, v)))))];
const fgLabel = new Uint8Array(fgIdx.length);
fgLabel.set(result.assign);
console.log(JSON.stringify({ step: 'kmeans', k: K, inertia: Math.round(result.inertia), palette: palette.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')) }));

/* ---------------- ③ 3× 超采样逐样本归类 ---------------- */
// 双线性放大 SS 倍，然后每个样本归类到最近调色板色
const SW = W * SS, SH = H * SS;
function sampleRgb(fx, fy, out) {
  const x = Math.min(W - 1, Math.max(0, fx)), y = Math.min(H - 1, Math.max(0, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  for (let c = 0; c < 3; c++) {
    const v00 = rgb[(y0 * W + x0) * 3 + c], v10 = rgb[(y0 * W + x1) * 3 + c];
    const v01 = rgb[(y1 * W + x0) * 3 + c], v11 = rgb[(y1 * W + x1) * 3 + c];
    out[c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
  }
}
const NC = K + 1;
const grid = new Uint8Array(SW * SH); // 调色板下标
{
  const px = [0, 0, 0];
  for (let y = 0; y < SH; y++) {
    const fy = (y + 0.5) / SS - 0.5;
    for (let x = 0; x < SW; x++) {
      const fx = (x + 0.5) / SS - 0.5;
      sampleRgb(fx, fy, px);
      let best = 0, bd = Infinity;
      for (let c = 0; c < NC; c++) {
        const p = palette[c];
        const dr = px[0] - p[0], dg = px[1] - p[1], db = px[2] - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      grid[y * SW + x] = best;
    }
  }
}
console.log(JSON.stringify({ step: 'classify', grid: [SW, SH], samples: SW * SH }));

/* ---------------- 3×3 众数滤波 ---------------- */
{
  const hist = new Int16Array(NC);
  const next = new Uint8Array(grid.length);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      hist.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= SH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= SW) continue;
          hist[grid[yy * SW + xx]]++;
        }
      }
      let best = grid[y * SW + x], bc = 0;
      for (let c = 0; c < NC; c++) if (hist[c] > bc) { bc = hist[c]; best = c; }
      next[y * SW + x] = best;
    }
  }
  grid.set(next);
}
console.log(JSON.stringify({ step: 'mode-filter', done: true }));

/* ---------------- 降回原分辨率（每 SS×SS 块取多数） ---------------- */
const labels = new Uint8Array(W * H);
{
  const hist = new Int16Array(NC);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      hist.fill(0);
      for (let dy = 0; dy < SS; dy++) {
        const yy = y * SS + dy;
        for (let dx = 0; dx < SS; dx++) hist[grid[yy * SW + x * SS + dx]]++;
      }
      let best = 0, bc = -1;
      for (let c = 0; c < NC; c++) if (hist[c] > bc) { bc = hist[c]; best = c; }
      labels[y * W + x] = best;
    }
  }
}
{
  const cnt = new Int32Array(NC);
  for (let i = 0; i < W * H; i++) cnt[labels[i]]++;
  console.log(JSON.stringify({ step: 'downsample', areaByLabel: Array.from(cnt) }));
}

/* ---------------- 连通域：< min-area 并入邻色 ---------------- */
function connectedComponents(labelArr, w, h, pred) {
  const comp = new Int32Array(w * h).fill(-1);
  const comps = []; // {label, area, pixels:[]}
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (comp[i] !== -1) continue;
    if (!pred(i)) continue;
    const id = comps.length;
    const px = [];
    comp[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(); px.push(p);
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          if (dx && dy) { // 对角：要求有公共正交邻，避免穿角连通
            if (labelArr[y * w + xx] !== labelArr[p] || labelArr[yy * w + x] !== labelArr[p]) continue;
          }
          const q = yy * w + xx;
          if (comp[q] !== -1) continue;
          if (!pred(q)) continue;
          comp[q] = id; stack.push(q);
        }
      }
    }
    comps.push({ label: labelArr[i], area: px.length, pixels: px });
  }
  return { comp, comps };
}

let mergeRounds = 0, mergedPixels = 0;
for (let round = 0; round < 12; round++) {
  const cc = connectedComponents(labels, W, H, (i) => labels[i] !== 0);
  const small = cc.comps.filter((c) => c.area < MIN_AREA && c.label !== 0);
  if (!small.length) break;
  mergeRounds++;
  const reassign = new Map();
  for (const c of small) {
    // 邻域里出现最多的其它颜色
    const hist = new Int32Array(NC);
    for (const p of c.pixels) {
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const l = labels[yy * W + xx];
          if (l !== c.label) hist[l]++;
        }
      }
    }
    let best = 0, bc = -1;
    for (let l = 0; l < NC; l++) if (hist[l] > bc) { bc = hist[l]; best = l; }
    if (bc <= 0) best = c.label;
    reassign.set(c, best);
  }
  for (const [c, l] of reassign) for (const p of c.pixels) { labels[p] = l; }
  mergedPixels += small.reduce((a, c) => a + c.area, 0);
}
console.log(JSON.stringify({ step: 'despeckle', rounds: mergeRounds, mergedPixels, minArea: MIN_AREA }));

if (OUT_LABELMAP) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const c = palette[labels[i]];
    buf[i * 3] = c[0]; buf[i * 3 + 1] = c[1]; buf[i * 3 + 2] = c[2];
  }
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(OUT_LABELMAP);
  console.log(JSON.stringify({ step: 'labelmap', out: OUT_LABELMAP }));
}

/* ---------------- ④ 每色轮廓：裂缝跟随 + RDP ---------------- */
// 连通域（区域 = 颜色 + 4-连通）→ 沿格边跟随出闭合环；外环与洞给出相反绕向。
// 用 4-连通与裂缝跟随保持一致：对角相接的像素在裂缝图里不是同一个区域（否则左转规则会卡住）。
function traceRegions() {
  const comp = new Int32Array(W * H).fill(-1);
  const regions = new Map(); // id -> {label, area}
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (comp[i] !== -1) continue;
    const label = labels[i];
    const id = regions.size;
    let area = 0;
    comp[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(); area++;
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          if (dx && dy) continue; // 4-连通
          const q = yy * W + xx;
          if (comp[q] !== -1 || labels[q] !== label) continue;
          comp[q] = id; stack.push(q);
        }
      }
    }
    regions.set(id, { label, area });
  }
  // id → src,dst 边表（把 dst 映射成 (x,y) 方便取坐标）
  const out = new Map(); // "x,y" -> edge[]
  const key = (x, y) => y * (W + 1) + x;
  const outMap = new Map();
  const push = (sx, sy, dx, dy) => {
    const k = key(sx, sy);
    let arr = outMap.get(k);
    if (!arr) { arr = []; outMap.set(k, arr); }
    arr.push({ dx, dy, id: -1 });
  };
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : comp[y * W + x];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = comp[y * W + x];
      // 右边：两区域的水平边界，线沿 x+1 竖直。区域在左时方向朝下，在右时方向朝上。
      {
        const rid = at(x + 1, y);
        if (rid !== id) {
          if (id >= 0) { let a = outMap.get(key(x + 1, y + 1)); if (!a) { a = []; outMap.set(key(x + 1, y + 1), a); } a.push({ dx: 0, dy: -1, id }); }
          if (rid >= 0) { let a = outMap.get(key(x + 1, y)); if (!a) { a = []; outMap.set(key(x + 1, y), a); } a.push({ dx: 0, dy: 1, id: rid }); }
        }
      }
      // 下边：两区域的竖直边界，线沿 y+1 水平。区域在上时方向朝右，在下时方向朝左。
      {
        const did = at(x, y + 1);
        if (did !== id) {
          if (id >= 0) { let a = outMap.get(key(x, y + 1)); if (!a) { a = []; outMap.set(key(x, y + 1), a); } a.push({ dx: 1, dy: 0, id }); }
          if (did >= 0) { let a = outMap.get(key(x + 1, y + 1)); if (!a) { a = []; outMap.set(key(x + 1, y + 1), a); } a.push({ dx: -1, dy: 0, id: did }); }
        }
      }
    }
  }
  // 跟随：在格点处「左转优先」（区域在左），才能贴着边界走完整圈
  const loopsByRegion = new Map();
  const walkLog = [];
  const ORDER = ['u', 'l', 'd', 'r'];
  const turnOrder = (inDx, inDy) => {
    if (inDy === -1) return ORDER;              // 向上走 → 左转是左，再上、下、右
    if (inDx === -1) return ['d', 'l', 'u', 'r']; // 向左走 → 左转是下
    if (inDy === 1) return ['r', 'd', 'l', 'u'];  // 向下走 → 左转是右
    return ['u', 'r', 'd', 'l'];                  // 向右走 → 左转是上
  };
  const DIRV = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };
  for (const [startK, arr] of outMap) {
    while (arr.length) {
      const e0 = arr.pop();
      const pts = [];
      let cx = startK % (W + 1), cy = (startK - cx) / (W + 1);
      let e = e0;
      let guard = 0;
      let stop = 'closed';
      while (e && guard++ < 4 * (W + 1) * (H + 1)) {
        pts.push([cx, cy]);
        cx += e.dx; cy += e.dy;
        const k = key(cx, cy);
        const list = outMap.get(k);
        if (!list || !list.length) { e = null; stop = `dead-end@${cx},${cy}`; break; }
        // 先看这一圈是否闭合（回到起点且正好是起始边）
        if (k === startK && list.includes(e0)) {
          list.splice(list.indexOf(e0), 1);
          e = null; stop = 'closed';
          break;
        }
        let pick = -1;
        for (const turn of turnOrder(e.dx, e.dy)) {
          const [vx, vy] = DIRV[turn];
          const i = list.findIndex((x) => x.id === e.id && x.dx === vx && x.dy === vy);
          if (i >= 0) { pick = i; break; }
        }
        if (pick < 0) { e = null; stop = `no-leftturn@${cx},${cy}`; break; }
        e = list.splice(pick, 1)[0];
      }
      if (guard >= 4 * (W + 1) * (H + 1)) stop = 'guard';
      if (pts.length < 3) continue;
      walkLog.push(stop);
      // 有符号面积（shoelace，逆时针为正）
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        s += ax * by - bx * ay;
      }
      const id = e0.id;
      if (id < 0) continue;
      let list2 = loopsByRegion.get(id);
      if (!list2) { list2 = []; loopsByRegion.set(id, list2); }
      list2.push({ pts, area: s / 2 });
    }
  }
  return { comp, regions, loopsByRegion, walkLog, outMap };
}
const didTrace = (() => { const r = traceRegions(); return r; })();
const { regions, loopsByRegion, walkLog, outMap } = didTrace;
if (arg('debug-trace', null)) {
  let nonEmpty = 0, totalE = 0;
  for (const [, arr] of outMap) { if (arr.length) { nonEmpty++; totalE += arr.length; } }
  console.log('EDGEDBG corners=' + outMap.size + ' nonEmptyAfterWalk=' + nonEmpty + ' remainingEdges=' + totalE);
}
if (arg('out-edges', null)) {
  const dump = { W, H, corners: [] };
  for (const [k, arr] of outMap) {
    dump.corners.push({ k, x: k % (W + 1), y: (k - (k % (W + 1))) / (W + 1), edges: arr.map((e) => [e.dx, e.dy, e.id]) });
  }
  writeFileSync(arg('out-edges'), JSON.stringify(dump));
  console.log(JSON.stringify({ step: 'edge-dump', corners: dump.corners.length }));
}
if (arg('out-loops', null)) {
  const all = [];
  for (const [id, loops] of loopsByRegion) for (const l of loops) all.push({ id, label: regions.get(id).label, area: l.area, pts: l.pts });
  writeFileSync(arg('out-loops'), JSON.stringify(all));
  console.log(JSON.stringify({ step: 'loop-dump', loops: all.length }));
}
console.log(JSON.stringify({ step: 'trace', regions: regions.size, loops: Array.from(loopsByRegion.values()).reduce((a, l) => a + l.length, 0) }));
{ // 逐像素精确性：每个环的有符号面积应当等于它所属连通域的像素数（有洞环除外）
  let exact = 0, soft = 0;
  for (const [id, loops] of loopsByRegion) {
    const regionArea = regions.get(id).area;
    for (const l of loops) (Math.abs(Math.abs(l.area) - regionArea) < 0.5 ? exact++ : soft++);
  }
  const reasons = new Map();
  for (const s of walkLog) { const k = s.replace(/-?\d+/g, 'N'); reasons.set(k, (reasons.get(k) || 0) + 1); }
  console.log(JSON.stringify({ step: 'exactness', loopsAreaEqualToRegion: exact, loopsPartOfBiggerRegion: soft, walkStops: [...reasons.entries()] }));
}
if (arg('debug-trace', null)) {
  const areas = [...regions.entries()].map(([id, r]) => [id, r.label, r.area]).sort((a, b) => b[2] - a[2]);
  console.log('TOP REGION AREAS', JSON.stringify(areas.slice(0, 8)));
  const la = [];
  for (const [id, loops] of loopsByRegion) for (const l of loops) la.push([id, loops.length, l.pts.length, +l.area.toFixed(1), Math.abs(Math.abs(l.area) - regions.get(id).area) < 0.5]);
  la.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
  console.log('TOP LOOP AREAS', JSON.stringify(la.slice(0, 8)));
  const match = la.filter((a) => a[4]).length;
  console.log('loops whose |area| == region area:', match, 'of', la.length);
  console.log('total region area', areas.reduce((a, b) => a + b[2], 0), 'sum |loop area|', Math.round(la.reduce((a, b) => a + Math.abs(b[3]), 0)));
  const hist = new Map();
  for (const s of walkLog) { const k = s.replace(/-?\d+/g, 'N'); hist.set(k, (hist.get(k) || 0) + 1); }
  console.log('walk stop reasons', JSON.stringify([...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)));
  console.log('first dead-ends', JSON.stringify(walkLog.filter((s) => s.startsWith('dead')).slice(0, 5)));
}

/* ---------------- ⑤ 生成 SVG（每色一条 path，nonzero） ---------------- */
// 按色聚合：外环（有符号面积 < 0，顺时针）与洞（> 0）分开
const byColor = new Map(); // label -> {outer:[], hole:[], area}
for (const [id, loops] of loopsByRegion) {
  const label = regions.get(id).label;
  let entry = byColor.get(label);
  if (!entry) { entry = { outer: [], hole: [], area: 0 }; byColor.set(label, entry); }
  for (const l of loops) {
    if (l.area < 0) entry.outer.push(l); else entry.hole.push(l);
  }
  entry.area += regions.get(id).area;
}
const fmtN = (v) => { const r = Math.round(v); return Object.is(r, -0) ? 0 : r; };

// 闭合曲线 RDP：先取一对最远点把环断开，两端各自简化
function rdpOpen(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const [x0, y0] = points[i0], [x1, y1] = points[i1];
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let best = -1, bd = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = points[i];
      let d;
      if (len2 === 0) d = (px - x0) ** 2 + (py - y0) ** 2;
      else {
        let t = ((px - x0) * dx + (py - y0) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = (px - (x0 + t * dx)) ** 2 + (py - (y0 + t * dy)) ** 2;
      }
      if (d > bd) { bd = d; best = i; }
    }
    if (bd > eps2) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}
function rdpClosed(pts, eps) {
  const n = pts.length;
  if (n < 4) return pts.slice();
  let i0 = 0;
  for (let i = 1; i < n; i++) if (pts[i][0] < pts[i0][0] || (pts[i][0] === pts[i0][0] && pts[i][1] < pts[i0][1])) i0 = i;
  let i1 = i0, bd = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i][0] - pts[i0][0]) ** 2 + (pts[i][1] - pts[i0][1]) ** 2;
    if (d > bd) { bd = d; i1 = i; }
  }
  if (i1 === i0) return pts.slice();
  const segA = [], segB = [];
  for (let i = i0; ; i = (i + 1) % n) { segA.push(pts[i]); if (i === i1) break; }
  for (let i = i1; ; i = (i + 1) % n) { segB.push(pts[i]); if (i === i0) break; }
  const a = rdpOpen(segA, eps), b = rdpOpen(segB, eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

// 编码：RDP/折点简化后，起点用绝对 M，其余用小写相对增量（先取整再判断是否为 0！）。
// 每 RADIX 段重新用绝对 L 锚定，避免相对增量取整误差累积。
const mkNum = (prec) => {
  const f = Math.pow(10, prec);
  return (v) => { const r = Math.round(v * f) / f; return Object.is(r, -0) ? '0' : String(r); };
};
function encPath(pts, prec, radix) {
  const num = mkNum(prec);
  if (pts.length < 3) return null;
  let d = 'M' + num(pts[0][0]) + ' ' + num(pts[0][1]);
  let px = pts[0][0], py = pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const x = pts[i][0], y = pts[i][1];
    if (radix && i % radix === 0) { d += 'L' + num(x) + ' ' + num(y); }
    else {
      const f = Math.pow(10, prec);
      const rx = Math.round((x - px) * f) / f, ry = Math.round((y - py) * f) / f;
      if (rx === 0 && ry === 0) { px = x; py = y; continue; }
      if (rx === 0) d += 'l0 ' + num(ry);
      else if (ry === 0) d += 'l' + num(rx) + ' 0';
      else d += 'l' + num(rx) + ' ' + num(ry);
    }
    px = x; py = y;
  }
  return d + 'z';
}

function renderPath(loops, holeMin, eps, prec, radix) {
  let d = '';
  let emitted = 0;
  for (const l of loops) {
    if (Math.abs(l.area) < holeMin) continue;
    const pts0 = l.area > 0 ? l.pts.slice().reverse() : l.pts; // 洞反向 → nonzero 挖空
    const pts = eps > 0 ? rdpClosed(pts0, eps) : pts0;
    if (pts.length < 4) continue;
    const seg = encPath(pts, prec, radix);
    if (!seg) continue;
    d += seg; emitted++;
  }
  return { d, emitted };
}

const order = Array.from(byColor.entries()).sort((a, b) => b[1].area - a[1].area);
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const buildSvg = (holeMin, eps, prec, radix) => {
  let paths = '';
  let bodies = '';
  let loopsOut = 0;
  for (const [label, e] of order) {
    const r = renderPath(e.outer.concat(e.hole), holeMin, eps, prec, radix);
    if (!r.d) continue;
    loopsOut += r.emitted;
    bodies += r.d;
    paths += `<path fill='${hex(palette[label])}' fill-rule='nonzero' d='${r.d}'/>`;
  }
  return { svg: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}'>${paths}</svg>`, bodies, loopsOut };
};

const doDebug = !!arg('debug-trace', null);
// 默认参数：RDP eps=2.0（像素级误差上限 2px）、坐标 1 位小数、保留 >=4px² 的环。
// 这样每个色层的 path 合起来约 4 万字符，node 内容进 drawio 后整份文件仍只有几十 KB。
const EPS = Number(arg('eps', 2.0));
const PREC = Number(arg('prec', 1));
const HOLE_MIN = Number(arg('hole-min', 4));
const r = buildSvg(HOLE_MIN, EPS, PREC, 8);
const svg = r.svg, bodies = r.bodies, loopsOut = r.loopsOut;
const strategy = `rdp=${EPS}/prec=${PREC}/holes>=${HOLE_MIN}px2`;
if (doDebug) console.log('BUILD', strategy, 'chars=' + svg.length, 'loops=' + loopsOut);
console.log(JSON.stringify({ step: 'svg', chars: svg.length, bodyChars: bodies.length, loopsOut, strategy, budget: BUDGET }));


// 最小百分号编码：只动 % < > # "（drawio 与浏览器都能解；其余原样，省字节）
const encoded = svg.replace(/%/g, '%25').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23').replace(/"/g, '%22');
const dataUri = 'data:image/svg+xml,' + encoded;
const style = 'shape=image;imageAspect=0;image=' + dataUri;
console.log(JSON.stringify({ step: 'encode', svgChars: svg.length, encodedChars: encoded.length, styleChars: style.length }));

if (OUT_SVG) writeFileSync(OUT_SVG, svg);
writeFileSync(OUT_SVG.replace(/\.svg$/i, '') + '.style.txt', style, 'utf8');

/* ---------------- 自检：把 SVG 栅格化回来跟原图比 ---------------- */
if (OUT_PREVIEW) {
  try {
    const resvgReq = createRequire('D:/_Project/drawAi/node_modules/@resvg/resvg-js/index.js');
    const { Resvg } = resvgReq('@resvg/resvg-js');
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: W } });
    const png = r.render().asPng();
    writeFileSync(OUT_PREVIEW, png);
    const prev = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, n = 0, big = 0;
    for (let i = 0; i < W * H; i++) {
      const a = prev.data[i * 4], b = prev.data[i * 4 + 1], c = prev.data[i * 4 + 2];
      const dr = a - rgb[i * 3], dg = b - rgb[i * 3 + 1], db = c - rgb[i * 3 + 2];
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      sum += d; n++; if (d > 60) big++;
    }
    console.log(JSON.stringify({ step: 'selfcheck', previewPng: OUT_PREVIEW, meanRgbDist: +(sum / n).toFixed(2), pctFarPixels: +(100 * big / n).toFixed(2) }));
  } catch (e) {
    console.log(JSON.stringify({ step: 'selfcheck', error: String(e && e.message || e) }));
  }
}

if (OUT_JSON) {
  writeFileSync(OUT_JSON, JSON.stringify({
    w: W, h: H, k: K, palette: palette.map(hex), strategy,
    svgChars: svg.length, styleChars: style.length,
    areaByLabel: (() => { const c = new Int32Array(NC); for (let i = 0; i < W * H; i++) c[labels[i]]++; return Array.from(c); })(),
  }, null, 2));
}
console.log('OK ' + OUT_SVG);
