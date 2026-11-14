#!/usr/bin/env node
/**
 * 把 src/motion/mgstyles 的 catalog / brief / prompt / demo 源码
 * 生成为 showcase/index.html（构建期静态 HTML，不依赖浏览器端数据渲染）。
 *
 * 生成物：
 *   showcase/index.html
 *   showcase/demos/<slug>/**    （文本源码，供“上游源码”页读取）
 *
 * 样片位默认留空；如果 showcase/media/manifest.json 配置了 DrawAI 自产样片，build 会读取并渲染。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MG = path.join(ROOT, 'src', 'motion', 'mgstyles');
const SHOWCASE = path.join(ROOT, 'showcase');
const TEMPLATE = path.join(SHOWCASE, 'template.html');
const OUTPUT = path.join(SHOWCASE, 'index.html');
const DEMOS_OUT = path.join(SHOWCASE, 'demos');
const MEDIA_MANIFEST = path.join(SHOWCASE, 'media', 'manifest.json');

const UPSTREAM_REPO = 'https://github.com/Vincentwei1021/mg-styles-15';
const DRAWAI_REPO = 'https://github.com/fourzkw/dsh-drawai';
const SITE_URL = (process.env.SHOWCASE_URL || 'https://fourzkw.github.io/dsh-drawai/styles/').replace(/\/?$/, '/');

const PALETTE_ROLES = ['page', 'surface', 'field', 'text', 'muted', 'accent', 'border'];
const ROLE_LABELS = {
  page: '纸 / 底',
  surface: '面',
  field: '场',
  text: '墨 / 字',
  muted: '次级',
  accent: '强调',
  border: '描边',
  extra: '补充',
};

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.html', '.htm', '.css', '.md', '.txt',
  '.svg', '.glsl', '.frag', '.vert', '.py', '.csv', '.xml', '.yml', '.yaml',
]);

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const sizeLabel = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const isHex = (value) => /^#[0-9a-f]{3,8}$/i.test(String(value));

function readText(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`缺少${label}：${path.relative(ROOT, file)}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function promptFile(style) {
  return path.join(MG, 'upstream', style.prompt);
}

function briefFile(style) {
  return path.join(MG, style.brief);
}

function promptSourceUrl(style) {
  if (style.origin?.source && style.origin.files?.[style.prompt]) {
    return `${style.origin.source}/blob/main/${encodeURI(style.origin.files[style.prompt])}`;
  }
  return `${UPSTREAM_REPO}/blob/${catalog.commit}/${style.prompt.split('/').map(encodeURIComponent).join('/')}`;
}

function demoSourceUrl(style, rel) {
  if (style.origin?.source && style.origin.files) {
    const mapped = style.origin.files[`demos/${style.slug}/${rel}`];
    if (mapped) return `${style.origin.source}/blob/main/${encodeURI(mapped)}`;
  }
  return `${UPSTREAM_REPO}/blob/${catalog.commit}/demos/${style.slug}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function collectDemoFiles(slug) {
  const root = path.join(MG, 'upstream', 'demos', slug);
  if (!fs.existsSync(root)) return { files: [], skipped: [] };

  const files = [];
  const skipped = [];

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const extension = path.extname(absolute).toLowerCase();
      const bytes = fs.statSync(absolute).size;

      if (!TEXT_EXT.has(extension)) {
        skipped.push({ relative, reason: '非文本文件' });
        continue;
      }
      if (bytes > 400 * 1024) {
        skipped.push({ relative, reason: `超过 400KB（${sizeLabel(bytes)}）` });
        continue;
      }

      const buffer = fs.readFileSync(absolute);
      if (buffer.subarray(0, 4096).includes(0)) {
        skipped.push({ relative, reason: '疑似二进制' });
        continue;
      }

      files.push({ relative, absolute, bytes, text: buffer.toString('utf8') });
    }
  };

  walk(root);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return { files, skipped };
}

function copyDemoFiles(slug, files) {
  const targetRoot = path.join(DEMOS_OUT, slug);
  for (const file of files) {
    const target = path.join(targetRoot, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.text, 'utf8');
  }
}

function renderBrief(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const intro = [];
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }

  const introText = intro.join('\n').replace(/^#\s+.*(?:\n)+/, '').trim();

  const parts = [];
  if (introText) {
    try {
      parts.push(`<div class="md">${marked.parse(introText)}</div>`);
    } catch {
      parts.push(`<div class="md"><p>${esc(introText)}</p></div>`);
    }
  }

  sections.forEach((section, index) => {
    const body = section.lines.join('\n');
    let html = '';
    try {
      html = marked.parse(body);
    } catch {
      html = `<p>${esc(body)}</p>`;
    }
    const open = index < 3 ? ' open' : '';
    parts.push(
      `<details class="brief-section"${open}>` +
        `<summary>${esc(section.title)}</summary>` +
        `<div class="md">${html}</div>` +
      `</details>`,
    );
  });

  return parts.join('\n');
}

function renderMarkdown(markdown) {
  try {
    return marked.parse(markdown);
  } catch {
    return `<p>${esc(markdown)}</p>`;
  }
}

function splitPrompt(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n').trim();
  const fence = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/.exec(text);

  if (!fence) {
    return { hasPrompt: false, body: text, guide: '', chars: text.length };
  }

  let guide = `${text.slice(0, fence.index)}${text.slice(fence.index + fence[0].length)}`.trim();
  guide = guide.replace(/(?:^|\n)##\s*提示词\s*$/u, '').trim();

  const howIndex = guide.indexOf('## 怎么用');
  if (howIndex > 0) {
    guide = guide.slice(howIndex).replace(/^##\s*怎么用\s*\n?/u, '').trim();
  }

  guide = guide.replace(/\]\((\.\.\/[^)\s]+)\)/g, (_, href) => {
    const target = href.replace(/^\.\.\//, '');
    return `](${UPSTREAM_REPO}/blob/${catalog.commit}/${target})`;
  });

  const body = fence[1].trim();
  return { hasPrompt: true, body, guide, chars: body.length };
}

function renderPrompt(style, markdown) {
  const { hasPrompt, body, guide, chars } = splitPrompt(markdown);
  const bodyId = `prompt-${style.slug}`;
  const source = esc(promptSourceUrl(style));
  const copyLabel = hasPrompt ? '复制提示词' : '复制配方';

  const toolbar = `
    <div class="prompt-bar">
      <div class="prompt-meta">
        <span class="prompt-kicker">${hasPrompt ? '上游写法' : '参考配方'}</span>
        <span>${chars} 字符</span>
      </div>
      <div class="prompt-actions">
        <a href="${source}" target="_blank" rel="noreferrer">原文 ↗</a>
        <button class="copy" type="button" data-copy="${bodyId}">${copyLabel}</button>
      </div>
    </div>`;

  if (!hasPrompt) {
    return `<div class="prompt-wrap">
      ${toolbar}
      <div class="md prompt-recipe">${renderMarkdown(markdown)}</div>
      <pre hidden id="${bodyId}">${esc(body)}</pre>
    </div>`;
  }

  return `<div class="prompt-wrap">
    ${toolbar}
    ${guide ? `<details class="prompt-guide" open>
      <summary>怎么用<span>使用说明</span></summary>
      <div class="md">${renderMarkdown(guide)}</div>
    </details>` : ''}
    <div class="prompt-body">
      <div class="prompt-body-head"><span>提示词正文</span><span class="prompt-count">${chars} 字符</span></div>
      <pre class="code prompt" id="${bodyId}">${esc(body)}</pre>
    </div>
  </div>`;
}

function renderPlayer(style, film) {
  const number = style.slug.slice(0, 2);
  const rhythm = style.rhythm || {};
  const portrait = rhythm.aspect === '9:16' || (film && film.h > film.w);
  const width = film?.w || (portrait ? 720 : 1280);
  const height = film?.h || (portrait ? 1280 : 720);
  const ratio = `${width} / ${height}`;

  const videoRel = film?.video || null;
  const posterRel = film?.poster || null;
  const upstream = /mg-styles-15/i.test(film?.source || '');
  const hasVideo = Boolean(
    film &&
    film.film !== false &&
    !upstream &&
    videoRel &&
    fs.existsSync(path.join(SHOWCASE, videoRel)),
  );
  const hasPoster = hasVideo && posterRel && fs.existsSync(path.join(SHOWCASE, posterRel));

  if (!hasVideo) {
    return {
      html: `<figure class="player" data-film="false" style="--ratio:${ratio}">
        <div class="poster-missing">
          <span class="ghost" aria-hidden="true">${esc(number)}</span>
          <div class="poster-missing-inner">
            <strong>${esc(style.name)}</strong>
            <p>样片位先留空，后续替换为 DrawAI 生成的样片。</p>
            <p class="small">film slot · pending</p>
          </div>
          <div class="poster-palette" aria-hidden="true">
            ${(style.colors || []).filter(isHex).slice(0, 8).map((color) => `<span style="--sw:${esc(color)}"></span>`).join('')}
          </div>
        </div>
        <figcaption><span>样片位 · 待补</span><span>${esc(rhythm.aspect || '16:9')}</span></figcaption>
      </figure>`,
      hasVideo: false,
      portrait,
    };
  }

  return {
    html: `<figure class="player" data-film="true" style="--ratio:${ratio}">
      <video controls playsinline preload="none" width="${width}" height="${height}"${hasPoster ? ` poster="${esc(posterRel)}"` : ''} aria-label="${esc(style.name)} 样片">
        <source src="${esc(videoRel)}" type="video/mp4">
      </video>
      <button class="play" type="button" data-play aria-label="播放 ${esc(style.name)} 样片">
        <span class="play-icon" aria-hidden="true">▶</span><span>播放样片</span>
      </button>
      <figcaption>
        <span class="badge">DrawAI 样片</span>
        <span>${width}×${height} · ${esc(String(rhythm.duration || 10))}s</span>
      </figcaption>
    </figure>`,
    hasVideo: true,
    portrait,
  };
}

function renderPalette(style) {
  const palette = style.palette || {};
  const entries = [];
  const seen = new Set();

  for (const role of PALETTE_ROLES) {
    const value = palette[role];
    if (!isHex(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([role, value]);
  }

  for (const [role, value] of Object.entries(palette)) {
    if (PALETTE_ROLES.includes(role) || !isHex(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([role, value]);
  }

  for (const value of style.colors || []) {
    if (!isHex(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(['extra', value]);
  }

  if (!entries.length) return '<p class="note">目录里没有可用色板。</p>';

  return `<div class="swatches">${entries.slice(0, 12).map(([role, value]) => `
    <button class="swatch" type="button" data-hex="${esc(value)}" title="复制 ${esc(value)}" aria-label="复制色值 ${esc(value)}">
      <span class="swatch-chip" style="--sw:${esc(value)}"></span>
      <span class="swatch-label">${esc(ROLE_LABELS[role] || role)}</span>
      <code>${esc(value)}</code>
    </button>`).join('')}</div>`;
}

function renderFacts(style, engines) {
  const rhythm = style.rhythm || {};
  const facts = [
    ['画幅', rhythm.aspect || '—'],
    ['帧率', rhythm.fps ? `${rhythm.fps} fps` : '—'],
    ['时长', rhythm.duration ? `${rhythm.duration} s` : '—'],
    ['BPM', rhythm.bpm ?? '—'],
    ['切点', rhythm.cutFrames ? `${rhythm.cutFrames} 帧` : '—'],
    ['引擎', engines.length ? engines.join(' + ') : '—'],
  ];

  return `<dl class="facts">${facts.map(([label, value]) => `
    <div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
}

function renderFonts(style) {
  const fonts = style.fonts;
  if (!fonts) return '<p class="note">目录里没有字体记录。</p>';

  if (typeof fonts === 'string') {
    return `<div class="chips"><span class="chip" title="${esc(fonts)}">${esc(fonts.split(',')[0].replace(/["']/g, ''))}</span></div>`;
  }

  const rows = [
    ['display', '标题'],
    ['text', '正文'],
    ['mono', '等宽'],
  ].filter(([key]) => fonts[key]);

  if (!rows.length) return '<p class="note">目录里没有字体记录。</p>';

  return `<div class="chips">${rows.map(([key, label]) => {
    const full = String(fonts[key]);
    const first = full.split(',')[0].replace(/["']/g, '').trim();
    return `<span class="chip" title="${esc(full)}">${esc(label)} · ${esc(first)}</span>`;
  }).join('')}</div>`;
}

function renderMotion(style) {
  const motion = style.motion || {};
  const chips = [];

  if (motion.transitions) {
    chips.push(`转场 ${motion.transitions === 'cut' ? '硬切' : motion.transitions === 'wipe' ? '擦除' : motion.transitions}`);
  }
  if (motion.camera) chips.push('相机运动');
  if (motion.impact) chips.push('冲击帧');
  if (motion.grain) chips.push(`颗粒 ${motion.grain}`);
  if (motion.motionBlur) {
    const blur = motion.motionBlur;
    chips.push(`运动模糊 ${blur.samples ?? '?'}× / ${blur.shutter ?? '?'}`);
  }
  if (motion.feather) chips.push('羽化');
  if (Array.isArray(motion.secondary) && motion.secondary.length) {
    chips.push(`次级 ${motion.secondary.join(' · ')}`);
  }

  if (!chips.length) return '<p class="note">没有记录动效默认值。</p>';
  return `<div class="chips">${chips.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}</div>`;
}

function renderSignature(style) {
  const signature = Array.isArray(style.signature) ? style.signature.slice(0, 6) : [];
  if (!signature.length) return '';
  return `<ul class="sig">${signature.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
}

function renderOrigin(style) {
  if (!style.origin) return '';
  const source = style.origin.source ? `<a href="${esc(style.origin.source)}" target="_blank" rel="noreferrer">${esc(style.origin.source.replace(/^https?:\/\//, ''))}</a>` : '';
  const note = style.origin.note ? `<br>${esc(style.origin.note)}` : '';
  const license = style.origin.license ? ` · ${esc(style.origin.license)}` : '';
  return `<p class="origin">配方来源：${source}${license}${note}</p>`;
}

function renderSource(style, demo) {
  const files = demo.files;
  if (!files.length) {
    return '<p class="note">这个风格没有 vendored 文本源码。</p>';
  }

  const first = files.find((file) => file.relative === 'index.html')
    || files.find((file) => file.relative === 'film.js')
    || files[0];

  const list = files.map((file) => {
    const url = demoSourceUrl(style, file.relative);
    return `<button class="file" type="button" data-path="${esc(file.relative)}" data-url="${esc(url)}">
      <span>${esc(file.relative)}</span><span class="fsize">${sizeLabel(file.bytes)}</span>
    </button>`;
  }).join('');

  const inkNote = style.slug === '23-ink-wash'
    ? '<p class="note">23 的 film.js 是上游节选，依赖全局 U/KIT/PAINT，不能独立运行；brush.js 为逐字收录。</p>'
    : '';

  return `${inkNote}<div class="source" data-base="demos/${esc(style.slug)}" data-first="${esc(first.relative)}">
    <div class="file-list">
      <div class="file-list-head">${files.length} 个文本文件 · 点击查看</div>
      ${list}
    </div>
    <div class="code-view">
      <div class="code-head">
        <span class="code-path">选择左侧文件</span>
        <span class="code-actions">
          <a class="code-link" target="_blank" rel="noreferrer" hidden>GitHub ↗</a>
          <button class="copy" type="button" data-copy="code-${esc(style.slug)}">复制</button>
        </span>
      </div>
      <pre class="code" id="code-${esc(style.slug)}"></pre>
    </div>
  </div>`;
}

function renderUsage(style) {
  const slug = style.slug;
  const commands = [
    ['读完整风格施工包', `mg_style {action:"read", slug:"${slug}"}`],
    ['抽参考帧', `mg_style {action:"frames", slug:"${slug}", count:8}`],
    ['建视频工程并套用风格', `motion_project {action:"create", nodeId:"<视频节点>", style:"${slug}"}`],
  ];

  const natural = `用 ${slug} 做一条 10 秒的「${style.name}」；先出 3–6 秒样片，确认节奏、色板和转场后再渲全片。`;

  const commandHtml = commands.map(([label, command], index) => {
    const id = `use-${slug}-${index}`;
    return `<div class="cmd">
      <div class="cmd-head"><span>${esc(label)}</span><button class="copy" type="button" data-copy="${id}">复制</button></div>
      <pre id="${id}">${esc(command)}</pre>
    </div>`;
  }).join('');

  const naturalId = `use-${slug}-nl`;
  return `<div class="usage">
    <p class="note">一条片子只接一种整片风格。先在画布上连一个「整片风格」节点，或让 <code>motion_project</code> 直接写 <code>theme.ts</code> / <code>STYLE.md</code>。</p>
    ${commandHtml}
    <div class="cmd">
      <div class="cmd-head"><span>自然语言起点</span><button class="copy" type="button" data-copy="${naturalId}">复制</button></div>
      <pre id="${naturalId}">${esc(natural)}</pre>
    </div>
  </div>`;
}

function renderSection(style, demo, film, mediaState) {
  const number = style.slug.slice(0, 2);
  const accent = isHex(style.palette?.accent) ? style.palette.accent : '#e8c547';
  const rhythm = style.rhythm || {};
  const engines = Array.isArray(style.engines) && style.engines.length ? style.engines : (style.engine ? [style.engine] : []);
  const portrait = rhythm.aspect === '9:16' || (film && film.h > film.w);
  const player = renderPlayer(style, film);
  if (player.hasVideo) mediaState.filmCount += 1;

  const searchText = [
    style.slug,
    style.name,
    style.en,
    style.heading,
    style.oneLiner,
    (style.tags || []).join(' '),
    (style.signature || []).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();

  const promptText = readText(promptFile(style), '提示词');
  const briefText = readText(briefFile(style), '移植说明');
  const briefHtml = renderBrief(briefText);

  const tabs = [
    ['prompt', '提示词'],
    ['brief', '移植说明'],
    ['src', '上游源码'],
    ['use', '在 DrawAI 中使用'],
  ];

  const tabButtons = tabs.map(([key, label], index) => {
    const tabId = `tab-${key}-${style.slug}`;
    const paneId = `pane-${key}-${style.slug}`;
    return `<button class="tab${index === 0 ? ' is-active' : ''}" type="button" role="tab"
      id="${tabId}" aria-controls="${paneId}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"
      data-tab="${key}">${esc(label)}</button>`;
  }).join('');

  const panes = `
    <section class="pane is-active" id="pane-prompt-${style.slug}" role="tabpanel" aria-labelledby="tab-prompt-${style.slug}" data-pane="prompt">
      ${renderPrompt(style, promptText)}
    </section>

    <section class="pane" id="pane-brief-${style.slug}" role="tabpanel" aria-labelledby="tab-brief-${style.slug}" data-pane="brief" hidden>
      <div class="pane-head">
        <p>DrawAI 移植说明 · ${esc(style.brief)}</p>
        <a href="${DRAWAI_REPO}/blob/develop/src/motion/mgstyles/${encodeURI(style.brief)}" target="_blank" rel="noreferrer">在 GitHub 打开 ↗</a>
      </div>
      <div class="brief">${briefHtml}</div>
    </section>

    <section class="pane" id="pane-src-${style.slug}" role="tabpanel" aria-labelledby="tab-src-${style.slug}" data-pane="src" hidden>
      ${renderSource(style, demo)}
    </section>

    <section class="pane" id="pane-use-${style.slug}" role="tabpanel" aria-labelledby="tab-use-${style.slug}" data-pane="use" hidden>
      ${renderUsage(style)}
    </section>`;

  return `<section class="style${portrait ? ' is-portrait' : ''}" id="${esc(style.slug)}" data-slug="${esc(style.slug)}" data-search="${esc(searchText)}" data-film="${player.hasVideo}" style="--accent:${esc(accent)}">
    <header class="style-head">
      <span class="style-num">${esc(number)}</span>
      <div class="style-title">
        <h2>${esc(style.name)}</h2>
        <p class="style-en">${esc(style.en)}</p>
        <p class="style-lede">${esc(style.oneLiner)}</p>
        <div class="tags">${(style.tags || []).slice(0, 10).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>
      </div>
      <a class="style-anchor" href="#${esc(style.slug)}" aria-label="链接到 ${esc(style.name)}">#</a>
    </header>

    <div class="style-body">
      <div class="stage">
        ${player.html}
        <div class="tabs" role="tablist" aria-label="${esc(style.name)} 内容">${tabButtons}</div>
        <div class="panes">${panes}</div>
      </div>
      <aside class="spec">
        ${renderFacts(style, engines)}

        <div class="spec-block">
          <h3>色板</h3>
          ${renderPalette(style)}
        </div>

        <div class="spec-block">
          <h3>字体</h3>
          ${renderFonts(style)}
          <p class="note">展示页不加载这些字体；成片请按移植说明里的内置字体或替代栈处理。</p>
        </div>

        <div class="spec-block">
          <h3>动效默认值</h3>
          ${renderMotion(style)}
        </div>

        <div class="spec-block">
          <h3>一眼认出</h3>
          ${renderSignature(style)}
        </div>

        ${style.engineNote ? `<div class="spec-block"><h3>引擎说明</h3><p class="note">${esc(style.engineNote)}</p></div>` : ''}
        ${renderOrigin(style)}
        ${style.shot ? `<p class="shot">上游成片：${esc(style.shot)}</p>` : ''}
      </aside>
    </div>
  </section>`;
}

/* ---------- load ---------- */

if (!fs.existsSync(TEMPLATE)) {
  throw new Error(`缺少模板：${path.relative(ROOT, TEMPLATE)}`);
}

const catalog = JSON.parse(readText(path.join(MG, 'catalog.json'), '目录'));
if (!Array.isArray(catalog.styles) || !catalog.styles.length) {
  throw new Error('catalog.json 里没有 styles');
}

let media = new Map();
if (fs.existsSync(MEDIA_MANIFEST)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(MEDIA_MANIFEST, 'utf8'));
    for (const item of manifest.films || manifest.items || []) {
      if (!item?.slug) continue;
      if (/mg-styles-15/i.test(item.source || '')) continue;
      media.set(item.slug, item);
    }
  } catch (error) {
    console.warn(`[showcase] 读取媒体 manifest 失败，按无媒体处理：${error.message}`);
  }
} else {
  console.warn('[showcase] 没有 showcase/media/manifest.json，所有样片位留空。');
}

fs.rmSync(DEMOS_OUT, { recursive: true, force: true });
fs.mkdirSync(DEMOS_OUT, { recursive: true });

const demoMap = new Map();
for (const style of catalog.styles) {
  const demo = collectDemoFiles(style.slug);
  demoMap.set(style.slug, demo);
  copyDemoFiles(style.slug, demo.files);
  if (demo.skipped.length) {
    console.log(`[showcase] ${style.slug}: 跳过 ${demo.skipped.length} 个文件（${demo.skipped.map((item) => item.relative).join(', ')}）`);
  }
}

const mediaState = { filmCount: 0 };
const sections = catalog.styles.map((style) => renderSection(style, demoMap.get(style.slug), media.get(style.slug), mediaState));

const index = catalog.styles.map((style) => `
  <a class="index-item" href="#${esc(style.slug)}" data-slug="${esc(style.slug)}">
    <span class="index-num">${esc(style.slug.slice(0, 2))}</span>
    <span class="index-name">${esc(style.name)}</span>
  </a>`).join('');

const firstFilm = [...media.values()].find((item) => item.film !== false && item.poster && fs.existsSync(path.join(SHOWCASE, item.poster)));
const ogImage = firstFilm ? new URL(firstFilm.poster, SITE_URL).toString() : '';
const ogImageMeta = ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : '';

const values = {
  SITE_URL,
  OG_IMAGE_META: ogImageMeta,
  INDEX: index,
  SECTIONS: sections.join('\n'),
  SOURCE_COMMIT_SHORT: String(catalog.commit || '').slice(0, 8),
  GENERATED_AT: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
};

let html = fs.readFileSync(TEMPLATE, 'utf8');
html = html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
  if (!(key in values)) throw new Error(`模板占位符没有值：${key}`);
  return values[key];
});

fs.writeFileSync(OUTPUT, html, 'utf8');

console.log(`[showcase] 写 ${path.relative(ROOT, OUTPUT)}`);
console.log(`[showcase] ${catalog.styles.length} 个风格 · ${mediaState.filmCount} 条样片 · ${fs.statSync(OUTPUT).size.toLocaleString()} bytes`);
