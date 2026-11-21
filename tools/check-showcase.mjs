#!/usr/bin/env node
/**
 * 展示站构建产物检查：15 个风格、本地提示词/样片配对、移植说明、深链、媒体 manifest。
 *
 *   node tools/check-showcase.mjs
 *   node tools/check-showcase.mjs --allow-missing-media
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MG = path.join(ROOT, 'src', 'motion', 'mgstyles');
const SHOWCASE = path.join(ROOT, 'showcase');
const INDEX = path.join(SHOWCASE, 'index.html');
const MANIFEST = path.join(SHOWCASE, 'media', 'manifest.json');
const allowMissingMedia = process.argv.includes('--allow-missing-media');

const catalog = JSON.parse(fs.readFileSync(path.join(MG, 'catalog.json'), 'utf8'));
const styles = catalog.styles;
const problems = [];
const promptDir = path.join(SHOWCASE, 'native', 'prompts');
const promptStyles = styles.filter((style) => {
  const file = path.join(promptDir, `${style.slug}.md`);
  return fs.existsSync(file) && fs.statSync(file).size > 0;
});
const promptCount = promptStyles.length;
const expectedPromptSlugs = [
  '01-flat-vector', '02-line-art', '03-isometric', '05-cel-boil', '06-collage',
  '07-liquid', '08-morph', '09-bauhaus', '10-synthwave', '12-aurora-glass',
  '18-hanazi', '19-paperclip', '20-pixel', '22-hud', '23-ink-wash',
];
const notes = [`提示词：${promptCount} 条本地，${styles.length - promptCount} 个未提供（不显示提示词 tab）`];
let tabTotal = 0;

function fail(message) {
  problems.push(message);
}

function exists(relative) {
  return fs.existsSync(path.join(SHOWCASE, relative));
}

for (const slug of expectedPromptSlugs) {
  if (!promptStyles.some((style) => style.slug === slug)) fail(`缺少本地提示词：${slug}`);
}

if (!fs.existsSync(INDEX)) {
  fail('缺少 showcase/index.html（先跑 npm run showcase:build）');
} else {
  const html = fs.readFileSync(INDEX, 'utf8');
  // 引用块会保留原话（提示词提到“不照搬上游镜头”，模板正文提到“上游作品”），
  // 只检查引用块之外的页面文案。
  const htmlWithoutPrompts = html
    .replace(/<pre class="code prompt"[\s\S]*?<\/pre>/g, '')
    .replace(/<pre class="code doc-text"[\s\S]*?<\/pre>/g, '');

  if (/\{\{[A-Z_]+\}\}/.test(html)) fail('index.html 里还有未替换的模板占位符');
  if (/>(?:undefined|NaN)</.test(html)) fail('index.html 里出现 undefined / NaN');
  if (html.includes('[object Object]')) fail('index.html 里出现未格式化的对象');

  for (const style of styles) {
    const { slug } = style;

    if (!new RegExp(`id="${slug}"`).test(html)) fail(`${slug}: 页面里没有 section id`);
    if (!html.includes(`href="#${slug}"`)) fail(`${slug}: 索引里没有深链`);

    if (!fs.existsSync(path.join(MG, style.brief))) fail(`${slug}: 缺少移植说明 ${style.brief}`);

    const brief = fs.readFileSync(path.join(MG, style.brief), 'utf8');
    if (!/^##\s+/m.test(brief)) fail(`${slug}: 移植说明没有二级标题`);
  }

  if (!exists('site/style.css')) fail('缺少 showcase/site/style.css');
  if (!exists('site/app.js')) fail('缺少 showcase/site/app.js');
  if (!exists('THIRD_PARTY_NOTICES.md')) fail('缺少 showcase/THIRD_PARTY_NOTICES.md');

  const tabs = (html.match(/<button class="tab/g) || []).length;
  tabTotal = tabs;
  const expectedTabs = styles.length + promptCount;
  if (tabs !== expectedTabs) fail(`tab 数量应为 ${expectedTabs}，实际 ${tabs}`);

  const indexNumbers = [...html.matchAll(/class="index-num">(\d{2})</g)].map((match) => match[1]);
  const expectedNumbers = styles.map((_, index) => String(index + 1).padStart(2, '0'));
  if (indexNumbers.join(',') !== expectedNumbers.join(',')) {
    fail(`索引编号不是连续的 01–${String(styles.length).padStart(2, '0')}：${indexNumbers.join(',')}`);
  }

  if (html.includes('data-pane="src"')) fail('页面里仍有源码 pane');
  if (html.includes('data-tab="use"') || html.includes('data-pane="use"')) fail('页面里仍有“在 DrawAI 中使用”标签');
  if (htmlWithoutPrompts.includes('上游源码')) fail('页面里仍有“上游源码”');
  if (htmlWithoutPrompts.includes('上游成片')) fail('页面里仍有“上游成片”');
  if (htmlWithoutPrompts.includes('上游')) fail('页面里仍有“上游”字样');
  if (/mg-styles-15|huashu-art-motion/i.test(html)) fail('页面里仍有上游项目名');
  if (html.includes('原文 ↗')) fail('页面里仍有提示词原文链接');
  if (/待补|留空|film slot|pending/i.test(html)) fail('页面里仍有占位/待补文案');
  if (/briefs\/|在 GitHub 打开|风格库 ID/.test(html)) fail('页面里仍有内部路径或标识');
  if (/catalog [0-9a-f]{7,}|生成于/.test(html)) fail('页面里仍有构建元数据');
  if (html.includes('data-play')) fail('页面里仍有自定义播放按钮');

  const promptWraps = (html.match(/class="prompt-wrap"/g) || []).length;
  if (promptWraps !== promptCount) fail(`本地提示词展示块数量应为 ${promptCount}，实际 ${promptWraps}`);
  if (html.includes('prompt-empty')) fail('页面里仍有空提示词占位块');

  const promptFolds = (html.match(/class="prompt-fold"/g) || []).length;
  if (promptFolds !== promptCount) fail(`提示词折叠块数量应为 ${promptCount}，实际 ${promptFolds}`);
  if (/class="prompt-fold"[^>]*\bopen\b/.test(html)) fail('提示词折叠块不应该默认展开');
  if (/class="prompt-guide"[^>]*\bopen\b/.test(html)) fail('“怎么用”说明不应该默认展开');
  if (html.includes('You are the director')) fail('页面里仍有上游英文提示词');
  if (html.includes('## 怎么用')) fail('页面里仍有上游“怎么用”段落');
  if (html.includes('rubric.md')) fail('页面里仍有上游评分表引用');

  const promptCopies = (html.match(/data-copy="prompt-/g) || []).length;
  if (promptCopies !== promptCount) fail(`折叠状态下的复制按钮数量应为 ${promptCount}，实际 ${promptCopies}`);
  const promptActions = [...html.matchAll(/<div class="prompt-actions">([\s\S]*?)<\/div>/g)];
  if (promptActions.length !== promptCount || promptActions.some((match) => {
    const copy = match[1].indexOf('data-copy="prompt-');
    const create = match[1].indexOf('data-template-style=');
    return copy < 0 || create < 0 || copy > create || !match[1].includes('>复制原提示词</button>');
  })) fail('原提示词复制入口应排在风格创作入口之前');

  // 通用制作模板：正文、填空说明、复制入口和每节的创作入口都在。
  if (!/id="template"/.test(html)) fail('页面里没有通用制作模板区');
  if (!/id="template-text"/.test(html)) fail('通用制作模板没有正文');
  if (!/id="template-fill"/.test(html)) fail('通用制作模板没有可复制的填空段');
  if (!html.includes('data-copy-fill')) fail('通用制作模板缺少“复制填空段”按钮');
  const templateSlots = (html.match(/class="slot"/g) || []).length;
  if (templateSlots !== 7) fail(`通用制作模板填空项应为 7，实际 ${templateSlots}`);
  const templatePresets = (html.match(/data-template-style="/g) || []).length;
  if (templatePresets !== promptCount) fail(`“用此风格创作”按钮数量应为 ${promptCount}，实际 ${templatePresets}`);
  if (/data-fill-style=""/.test(html)) fail('“用此风格创作”按钮缺少本节风格名');
  if (!html.includes('href="#template"')) fail('页面里没有指向通用制作模板的入口链接');
  if (!exists('native/prompt-template.md')) fail('缺少 showcase/native/prompt-template.md');

  // 开始使用：环境提示词、三步入口、模板与索引链接。
  if (!/id="start"/.test(html)) fail('页面里没有开始使用区');
  if (!/id="start-prompt"/.test(html)) fail('开始使用没有环境提示词正文');
  if (!html.includes('data-copy="start-prompt"')) fail('开始使用缺少“复制提示词”按钮');
  const startSteps = (html.match(/class="start-step"/g) || []).length;
  if (startSteps !== 3) fail(`开始使用应为 3 步，实际 ${startSteps}`);
  const startSection = html.match(/<section class="briefing start"[\s\S]*?<\/section>/);
  if (!startSection) {
    fail('开始使用区结构不对（缺少 section.briefing.start）');
  } else {
    if (!startSection[0].includes('href="#template"')) fail('开始使用区没有指向通用制作模板的入口');
    if (!startSection[0].includes('href="#index"')) fail('开始使用区没有指向风格索引的入口');
  }
  if (!exists('native/start-prompt.txt')) {
    fail('缺少 showcase/native/start-prompt.txt');
  } else {
    const startPrompt = fs.readFileSync(path.join(SHOWCASE, 'native', 'start-prompt.txt'), 'utf8').replace(/\r\n?/g, '\n').trim();
    if (!startPrompt) fail('开始使用提示词为空');
    else if (!html.includes(startPrompt.slice(0, 24)) || !html.includes(startPrompt.slice(-24))) {
      fail('页面里的环境提示词与 native/start-prompt.txt 不一致（先跑 npm run showcase:build）');
    }
  }

  const sections = (html.match(/class="style(?: |")/g) || []).length;
  if (sections < styles.length) fail(`section 数量不足：${sections}，至少 ${styles.length}`);

  if (html.includes('04-3d-render')) fail('页面里出现了 04-3d-render（插件不支持这个风格）');

  for (const style of promptStyles) {
    const section = html.match(new RegExp(`<section[^>]*id="${style.slug}"[^>]*>`));
    if (!section || !section[0].includes('data-film="true"')) {
      fail(`${style.slug}: 有本地提示词但没有渲染样片（data-film="true"）`);
    }
  }

  const localRefs = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (!value || value.startsWith('#') || /^[a-z]+:/i.test(value) || value.startsWith('//')) continue;
    localRefs.add(value.split('#')[0].split('?')[0]);
  }
  for (const reference of localRefs) {
    if (!exists(reference)) fail(`页面引用了不存在的文件：${reference}`);
  }
}

let manifest = null;
if (fs.existsSync(MANIFEST)) {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    fail(`media/manifest.json 解析失败：${error.message}`);
  }
}

if (manifest) {
  const films = Array.isArray(manifest.films) ? manifest.films : Array.isArray(manifest.items) ? manifest.items : [];
  const expected = [
    '01-flat-vector', '02-line-art', '03-isometric', '05-cel-boil', '06-collage',
    '07-liquid', '08-morph', '09-bauhaus', '10-synthwave', '12-aurora-glass',
    '18-hanazi', '19-paperclip', '20-pixel', '22-hud', '23-ink-wash',
  ];
  let filmCount = 0;

  for (const slug of expected) {
    if (!films.some((film) => film?.slug === slug && film.film !== false)) {
      fail(`缺少已配置的 DrawAI 样片：${slug}`);
    }
  }

  for (const film of films) {
    if (!film?.slug || film.film === false) continue;
    if (/mg-styles-15/i.test(film.source || '')) {
      fail(`${film.slug}: 不应引用 mg-styles-15 的参考片`);
      continue;
    }
    filmCount += 1;
    for (const key of ['video', 'poster']) {
      if (!film[key]) fail(`${film.slug}: manifest 缺 ${key}`);
      else if (!exists(film[key])) fail(`${film.slug}: 媒体文件不存在 ${film[key]}`);
    }
    if (!Number.isFinite(Number(film.duration)) || Number(film.duration) <= 0) {
      fail(`${film.slug}: duration 必须是正数`);
    }
    if (!Number.isFinite(Number(film.w)) || Number(film.w) <= 0 || !Number.isFinite(Number(film.h)) || Number(film.h) <= 0) {
      fail(`${film.slug}: w / h 必须是正数`);
    }
    if (!Number.isFinite(Number(film.fps)) || Number(film.fps) <= 0) {
      fail(`${film.slug}: fps 必须是正数`);
    }
    if (!film.source) fail(`${film.slug}: manifest 缺 source`);
    if (!/^[0-9a-f]{64}$/.test(film.sha256 || '')) fail(`${film.slug}: sha256 必须是 64 位小写十六进制`);
  }

  for (const style of promptStyles) {
    if (!films.some((film) => film?.slug === style.slug && film.film !== false)) {
      fail(`${style.slug}: 有本地提示词但 manifest 没有对应样片`);
    }
  }

  const rendered = (fs.readFileSync(INDEX, 'utf8').match(/<figure class="player" data-film="true"/g) || []).length;
  if (rendered !== filmCount) fail(`页面渲染样片数 ${rendered} 与 manifest ${filmCount} 不一致`);

  notes.push(`样片 manifest：${filmCount} 条已配置`);
} else {
  notes.push('样片：没有 manifest');
}

if (problems.length) {
  console.error('[showcase] 检查失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('[showcase] 检查通过');
  console.log(`  ${styles.length} 个风格 · ${tabTotal} 个 tab · ${fs.statSync(INDEX).size.toLocaleString()} bytes`);
  for (const note of notes) console.log(`  ${note}`);
}
