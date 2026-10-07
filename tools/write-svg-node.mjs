// 把矢量化的 SVG 内容节点写进 .drawio：用 lib/mxfile.js 的 parseMxfile + applyDocToMxfile
// 和 lib/style-kernel.js 的 styleWithSvgMarkup 无损落盘（不手改文件文本）。
import { readFileSync, writeFileSync } from 'node:fs';
import { parseMxfile, applyDocToMxfile } from '../lib/mxfile.js';
import { styleWithSvgMarkup } from '../lib/style-kernel.js';

const [, , drawioPath, svgPath, xArg, yArg, wArg, hArg] = process.argv;
if (!drawioPath || !svgPath) {
  console.error('用法: node tools/write-svg-node.mjs <file.drawio> <image.svg> [x y w h]');
  process.exit(2);
}
const markup = readFileSync(svgPath, 'utf8');
const original = readFileSync(drawioPath, 'utf8');
const before = parseMxfile(original);
const doc = before.doc;

const W = Number(wArg || 499), H = Number(hArg || 847);
const x = Number(xArg || 175), y = Number(yArg || 125);

// 分配一个没被占用的 id
const used = new Set(doc.nodes.map((n) => String(n.id)));
let id = 'n1', k = 1;
while (used.has(id)) { k += 1; id = 'n' + k; }

const node = {
  id,
  label: '',
  style: styleWithSvgMarkup('', markup, 0), // imageAspect=0 = 拉伸铺满
  x, y, w: W, h: H,
};
doc.nodes = doc.nodes.slice();
doc.nodes.push(node);
if (Array.isArray(doc.layers) && doc.layers.length > 0) node.layer = doc.layers[0].id;

const out = applyDocToMxfile(original, doc, { page: doc.meta.pageIndex });
writeFileSync(drawioPath, out.text, 'utf8');
console.log(JSON.stringify({
  ok: true, file: drawioPath, nodeId: id, at: [x, y], size: [W, H],
  styleChars: node.style.length, fileChars: out.text.length,
  dropped: out.dropped, nodes: doc.nodes.length,
  layer: node.layer === undefined ? null : node.layer,
  pinned: doc.meta.pinned === true,
}));
