// 把矢量化的 SVG 内容节点写进 .drawio：用 lib/mxfile.js 的 parseMxfile + applyDocToMxfile
// 和 lib/style-kernel.js 的 styleWithSvgMarkup 无损落盘（不手改文件文本）。
//
// 用法: node tools/write-svg-node.mjs <file.drawio> <image.svg> [x y w h] [--id n1] [--remove n2,n3]
//   --id      改写已有节点（保持 id / 图层 / 位置不动，只换内容和尺寸）
//   --remove  顺手删掉列出的节点（逗号分隔）
import { readFileSync, writeFileSync } from 'node:fs';
import { parseMxfile, applyDocToMxfile } from '../lib/mxfile.js';
import { styleWithSvgMarkup } from '../lib/style-kernel.js';

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf('--' + name);
  return i < 0 ? null : argv[i + 1];
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [drawioPath, svgPath, xArg, yArg, wArg, hArg] = positional;
if (!drawioPath || !svgPath) {
  console.error('用法: node tools/write-svg-node.mjs <file.drawio> <image.svg> [x y w h] [--id n1] [--remove n2]');
  process.exit(2);
}
const markup = readFileSync(svgPath, 'utf8');
const original = readFileSync(drawioPath, 'utf8');
const doc = parseMxfile(original).doc;

const W = Number(wArg || 499), H = Number(hArg || 847);
const x = xArg === undefined ? 175 : Number(xArg);
const y = yArg === undefined ? 125 : Number(yArg);

const style = styleWithSvgMarkup('', markup, 0); // imageAspect=0 = 拉伸铺满
const targetId = flag('id');
const removeIds = (flag('remove') || '').split(',').map((s) => s.trim()).filter(Boolean);

let id = targetId, action = 'update';
if (!id) {
  const used = new Set(doc.nodes.map((n) => String(n.id)));
  id = 'n1';
  let k = 1;
  while (used.has(id)) { k += 1; id = 'n' + k; }
  action = 'add';
}

doc.nodes = doc.nodes.slice();
const idx = doc.nodes.findIndex((n) => String(n.id) === String(id));
if (idx >= 0) {
  const keep = doc.nodes[idx];
  doc.nodes[idx] = Object.assign({}, keep, {
    label: '', style,
    x: xArg === undefined ? keep.x : x,
    y: yArg === undefined ? keep.y : y,
    w: W, h: H,
  });
} else {
  const node = { id, label: '', style, x, y, w: W, h: H };
  if (Array.isArray(doc.layers) && doc.layers.length > 0) node.layer = doc.layers[0].id;
  doc.nodes.push(node);
}
if (removeIds.length) {
  const drop = new Set(removeIds.map(String));
  doc.nodes = doc.nodes.filter((n) => !drop.has(String(n.id)));
}

const out = applyDocToMxfile(original, doc, { page: doc.meta.pageIndex });
writeFileSync(drawioPath, out.text, 'utf8');
console.log(JSON.stringify({
  ok: true, file: drawioPath, action, nodeId: id, size: [W, H],
  styleChars: style.length, fileChars: out.text.length,
  dropped: out.dropped, nodes: doc.nodes.map((n) => n.id),
  pinned: doc.meta.pinned === true,
}));
