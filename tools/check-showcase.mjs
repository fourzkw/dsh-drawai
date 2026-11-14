#!/usr/bin/env node
/**
 * 展示站构建产物检查：15 个风格、提示词/移植说明/源码、深链、媒体 manifest。
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
const notes = [];

function fail(message) {
  problems.push(message);
}

function exists(relative) {
  return fs.existsSync(path.join(SHOWCASE, relative));
}

if (!fs.existsSync(INDEX)) {
  fail('缺少 showcase/index.html（先跑 npm run showcase:build）');
} else {
  const html = fs.readFileSync(INDEX, 'utf8');

  if (/\{\{[A-Z_]+\}\}/.test(html)) fail('index.html 里还有未替换的模板占位符');
  if (/>(?:undefined|NaN)</.test(html)) fail('index.html 里出现 undefined / NaN');

  for (const style of styles) {
    const { slug } = style;

    if (!new RegExp(`id="${slug}"`).test(html)) fail(`${slug}: 页面里没有 section id`);
    if (!html.includes(`href="#${slug}"`)) fail(`${slug}: 索引里没有深链`);

    if (!fs.existsSync(path.join(MG, 'upstream', style.prompt))) fail(`${slug}: 缺少提示词 ${style.prompt}`);
    if (!fs.existsSync(path.join(MG, style.brief))) fail(`${slug}: 缺少移植说明 ${style.brief}`);

    const prompt = fs.readFileSync(path.join(MG, 'upstream', style.prompt), 'utf8');
    if (prompt.trim().length < 500) fail(`${slug}: 提示词过短（${prompt.trim().length} 字符）`);

    const brief = fs.readFileSync(path.join(MG, style.brief), 'utf8');
    if (!/^##\s+/m.test(brief)) fail(`${slug}: 移植说明没有二级标题`);

    const demoRoot = path.join(MG, 'upstream', 'demos', slug);
    if (!fs.existsSync(demoRoot)) fail(`${slug}: 缺少 vendored demo 目录`);

    const demoOut = path.join(SHOWCASE, 'demos', slug);
    if (!fs.existsSync(demoOut)) fail(`${slug}: 构建产物里没有 demos/${slug}`);
  }

  if (!exists('site/style.css')) fail('缺少 showcase/site/style.css');
  if (!exists('site/app.js')) fail('缺少 showcase/site/app.js');
  if (!exists('THIRD_PARTY_NOTICES.md')) fail('缺少 showcase/THIRD_PARTY_NOTICES.md');

  const tabs = (html.match(/class="tab/g) || []).length;
  if (tabs < styles.length * 4) fail(`tab 数量不足：${tabs}，至少 ${styles.length * 4}`);

  const promptWraps = (html.match(/class="prompt-wrap"/g) || []).length;
  if (promptWraps !== styles.length) fail(`提示词展示块数量应为 ${styles.length}，实际 ${promptWraps}`);

  const sections = (html.match(/class="style(?: |")/g) || []).length;
  if (sections < styles.length) fail(`section 数量不足：${sections}，至少 ${styles.length}`);

  if (html.includes('04-3d-render')) fail('页面里出现了 04-3d-render（插件不支持这个风格）');
  if (!new RegExp(`id="23-ink-wash"[^>]*data-film="false"`).test(html)) {
    // 属性顺序可能不同，退化为逐个检查
    const section = html.match(/<section[^>]*id="23-ink-wash"[^>]*>/);
    if (!section || !section[0].includes('data-film="false"')) fail('23-ink-wash 没有标记为无参考片');
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
  let filmCount = 0;

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
    if (film.sha256 && !/^[0-9a-f]{64}$/.test(film.sha256)) fail(`${film.slug}: sha256 格式不对`);
  }

  notes.push(`样片 manifest：${filmCount} 条已配置`);
} else {
  notes.push('样片：全部留空');
}

if (problems.length) {
  console.error('[showcase] 检查失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('[showcase] 检查通过');
  console.log(`  ${styles.length} 个风格 · ${styles.length * 4} 个 tab · ${fs.statSync(INDEX).size.toLocaleString()} bytes`);
  for (const note of notes) console.log(`  ${note}`);
}
