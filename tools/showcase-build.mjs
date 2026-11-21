#!/usr/bin/env node
/**
 * 把 src/motion/mgstyles 的 catalog / brief，以及 showcase/native 的本地提示词
 * 生成为 showcase/index.html（构建期静态 HTML，不依赖浏览器端数据渲染）。
 *
 * 生成物：
 *   showcase/index.html
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
const MEDIA_MANIFEST = path.join(SHOWCASE, 'media', 'manifest.json');
const NATIVE_DIR = path.join(SHOWCASE, 'native');
const NATIVE_STYLES = path.join(NATIVE_DIR, 'styles.json');
const NATIVE_PROMPTS = path.join(NATIVE_DIR, 'prompts');
const NATIVE_TEMPLATE = path.join(NATIVE_DIR, 'prompt-template.md');
const NATIVE_START = path.join(NATIVE_DIR, 'start-prompt.txt');

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

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const isHex = (value) => /^#[0-9a-f]{3,8}$/i.test(String(value));

const formatSeconds = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}s`;
};

const displayNumber = (index) => String(index + 1).padStart(2, '0');

function readText(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`缺少${label}：${path.relative(ROOT, file)}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function readOptional(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function briefFile(style) {
  return path.join(MG, style.brief);
}

function cleanBrief(markdown) {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      if (!text) return true;
      if (/^>\s?/.test(text)) return false;
      if (/^上游\s*[:：]/.test(text)) return false;
      if (/^提示词原文用/.test(text)) return false;
      if (/^`?(?:\.\.\/)?(?:src\/motion\/mgstyles\/upstream\/)?demos\//.test(text)) return false;
      return true;
    });

  return lines
    .join('\n')
    .replace(/src\/motion\/mgstyles\/upstream\/demos\/[^\s`)]+/g, '参考实现')
    .replace(/`demos\/[^`]*`/g, '`参考实现`')
    .replace(/demos\/[a-z0-9-]+\//g, '参考实现/')
    .replace(/mg-styles-15/gi, '参考项目')
    .replace(/huashu-art-motion/gi, '参考项目')
    .replace(/upstream\/LICENSE/g, '许可')
    .replace(/上游/g, '参考实现')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderBrief(markdown) {
  const lines = cleanBrief(markdown).split('\n');
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

function nativePromptBody(markdown) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n').trim();
  // 必须匹配独立成行的标题：维护者说明里可能提到 `## 提示词全文`，按 indexOf 会切错。
  const match = /^##\s*提示词全文\s*$/m.exec(text);
  return match ? text.slice(match.index + match[0].length).trim() : text;
}

/* ---------- 通用制作模板 ---------- */

function templateFillBlock(body) {
  const start = body.indexOf('【本次内容】');
  if (start < 0) return '';
  const closing = body.indexOf('以上信息已经确定', start);
  if (closing < 0) return body.slice(start).trim();
  const stop = body.indexOf('\n\n', closing);
  return body.slice(start, stop < 0 ? body.length : stop).trim();
}

function templateSlots(fill) {
  const lines = fill.split('\n');
  const slots = [];

  lines.forEach((line, index) => {
    const match = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/.exec(line);
    if (!match) return;
    let hint = match[2].trim();
    if (!hint) hint = (lines[index + 1] || '').trim().replace(/^-\s*/, '');
    hint = hint.replace(/^\[/, '').replace(/\]$/, '').replace(/^填写/, '').trim();
    if (hint) slots.push([match[1].trim(), hint]);
  });

  return slots.slice(0, 10);
}

function templateSpec(style) {
  const rhythm = style.rhythm || {};
  const sizes = { '16:9': '1920×1080', '9:16': '1080×1920', '1:1': '1080×1080', '4:3': '1440×1080' };
  const size = sizes[rhythm.aspect] || '';
  if (!size) return '';
  const fps = rhythm.fps ? `${rhythm.fps} fps` : '';
  return [size, fps].filter(Boolean).join('、');
}

function renderTemplate(markdown, styleCount) {
  const body = nativePromptBody(markdown);
  if (!body) return '';

  const fill = templateFillBlock(body);
  const slots = templateSlots(fill);
  const lineCount = body.split('\n').length;

  const slotHtml = slots.map(([name, hint], index) => `
        <li class="slot">
          <span class="slot-num">${String(index + 1).padStart(2, '0')}</span>
          <span class="slot-body">
            <span class="slot-name">${esc(name)}</span>
            <span class="slot-hint">${esc(hint)}</span>
          </span>
        </li>`).join('');

  return `<section class="briefing" id="template" aria-labelledby="template-title">
  <div class="wrap">
    <header class="briefing-head">
      <p class="briefing-kicker">Template · 开工之前</p>
      <h2 id="template-title">通用制作模板</h2>
      <p class="briefing-lede">后面 ${styleCount} 节说明“这一支长什么样”，这份模板说明“这条片子怎么交”。把这几项填掉，整段发给 DrawAI：它会读完风格、做分镜、渲染、自检，再按交付报告回报。</p>
    </header>
    <div class="briefing-body">
      <div class="briefing-fill">
        <p class="briefing-label"><span>填空 ${slots.length} 项</span><span>Fill in</span></p>
        <ol class="slots">${slotHtml}
        </ol>
        <p class="briefing-note">模板用于填写新主题和交付要求；也可以按需参考各样片的提示词。</p>
      </div>
      <div class="briefing-doc">
        <div class="doc-bar">
          <p class="doc-meta"><span class="doc-kicker">模板正文</span><span>${body.length} 字符 · 复制后可改</span></p>
          <div class="doc-actions">
            <button class="copy" type="button" data-copy-fill title="只复制【本次内容】，方便和某一节的风格提示词拼着用">复制填空段</button>
            <button class="copy is-primary" type="button" data-copy="template-text">复制完整模板</button>
          </div>
        </div>
        <div class="doc-view" data-doc>
          <pre class="code doc-text" id="template-text">${esc(body)}</pre>
        </div>
        <button class="doc-toggle" type="button" data-expand aria-expanded="false" aria-controls="template-text">
          <span>展开全文</span><span class="doc-toggle-meta">${lineCount} 行</span>
        </button>
        <pre id="template-fill" hidden>${esc(fill)}</pre>
      </div>
    </div>
  </div>
</section>`;
}

/* ---------- 开始使用 ---------- */

function renderStart(prompt, slots, styleCount) {
  const text = String(prompt || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  const chips = slots.map(([name]) => `<span class="start-chip">${esc(name)}</span>`).join('');

  return `<section class="briefing start" id="start" aria-labelledby="start-title">
  <div class="wrap">
    <header class="briefing-head">
      <p class="briefing-kicker">Start · 第一次用</p>
      <h2 id="start-title">开始使用</h2>
      <p class="briefing-lede">三步开工：先把环境装好（只做一次），再填一份通用制作模板，最后挑一种风格。装环境那段话直接复制给 DrawAI，检查、下载、清单都由它来做。</p>
    </header>
    <ol class="start-steps">
      <li class="start-step">
        <div class="start-step-head">
          <span class="start-num">01</span>
          <div class="start-step-body">
            <h3 class="start-step-title">装环境 · 只做一次</h3>
            <p class="start-note">新装插件后，把下面这段发给 DrawAI：它会先读出还缺什么，再补齐视频运行时、FFmpeg、动效字体与素材包、整片风格参考帧，最后回报一张清单。约 550MB，装完落在 <code>~/.dsh</code>，重装插件不用重下。</p>
          </div>
        </div>
        <div class="briefing-doc start-doc">
          <div class="doc-bar">
            <p class="doc-meta"><span class="doc-kicker">环境提示词</span><span>先检查 · 再下载</span></p>
            <div class="doc-actions">
              <button class="copy is-primary" type="button" data-copy="start-prompt">复制提示词</button>
            </div>
          </div>
          <pre class="code prompt start-prompt" id="start-prompt">${esc(text)}</pre>
        </div>
        <ul class="start-points">
          <li><b>浏览器</b>：用本机的 Chrome 或 Edge；一个都没有时，渲染会自己下一个精简内核。</li>
          <li><b>随时复查</b>：说一句「motion_setup status」：只读当前状态，不会重复下载。</li>
          <li><b>之后还会补</b>：素材包和参考帧漏装也没关系，建工程或读某个风格时会自己补齐。</li>
        </ul>
      </li>
      <li class="start-step">
        <div class="start-step-head">
          <span class="start-num">02</span>
          <div class="start-step-body">
            <h3 class="start-step-title">填一份通用制作模板</h3>
            <p class="start-note">下面 ${slots.length} 项就是一条片子的全部交代。填完把整段发给 DrawAI，它会先读风格目录、做分镜表，再渲染和自检。</p>
          </div>
        </div>
        <ul class="start-chips">${chips}</ul>
        <p class="start-links"><a class="start-link" href="#template">去填模板 ↓</a><span>每个风格节的「用此风格创作」会先把风格、画幅与帧率、时长填好。</span></p>
      </li>
      <li class="start-step">
        <div class="start-step-head">
          <span class="start-num">03</span>
          <div class="start-step-body">
            <h3 class="start-step-title">挑一种风格开工</h3>
            <p class="start-note">下面 ${styleCount} 种整片视觉语言都带样片和中文提示词：先看样片挑气质，再决定是复制提示词当参考，还是直接在模板上填自己的主题。</p>
          </div>
        </div>
        <p class="start-links"><a class="start-link" href="#index">看风格索引 ↓</a><span>页面顶部也能按风格名、标签或关键词搜索。</span></p>
      </li>
    </ol>
    <div class="start-table">
      <p class="briefing-label"><span>它装了什么</span><span>What gets installed</span></p>
      <table>
        <thead><tr><th>组件</th><th>位置</th><th>体积</th><th>什么时候装</th></tr></thead>
        <tbody>
          <tr><td>视频运行时（Remotion + three）</td><td><code>~/.dsh/drawai-video-runtime/</code></td><td>约 260MB</td><td>第 01 步</td></tr>
          <tr><td>FFmpeg</td><td>本机已有就直接用，否则 <code>~/.dsh/drawai-ffmpeg/</code></td><td>约 110MB</td><td>第 01 步</td></tr>
          <tr><td>动效字体与素材库</td><td><code>~/.dsh/drawai-assets/v1/</code></td><td>约 145MB</td><td>第 01 步提前下；漏了会在建工程时补</td></tr>
          <tr><td>整片风格参考帧</td><td><code>~/.dsh/drawai-style-reference-frames/</code></td><td>约 40MB</td><td>同上；读某个风格时也会补</td></tr>
          <tr><td>浏览器</td><td>本机的 Chrome / Edge</td><td>—</td><td>装好即可，不用另外下</td></tr>
        </tbody>
      </table>
    </div>
    <div class="start-net">
      <p class="start-net-title">还要联网的几件事</p>
      <ul class="start-points">
        <li><b>音效</b>：按关键词去 freesound.org 找，要联网。</li>
        <li><b>旁白</b>：走 edge-tts（Python 3 + edge-tts）；拿不到时退回系统自带语音，离线也能出声。</li>
        <li><b>品牌素材</b>：按网站抓取，要联网；自有素材和截图直接放进画布。</li>
        <li><b>走代理</b>：素材包与参考帧认 <code>HTTPS_PROXY</code>；FFmpeg 那条不吃代理，用 <code>DRAWAI_FFMPEG_PATH</code> 指现成的；运行时用 <code>DRAWAI_RUNTIME_REGISTRY</code> 换镜像。</li>
      </ul>
    </div>
  </div>
</section>`;
}

function renderPrompt(style, markdown) {
  if (!markdown || !markdown.trim()) return '';

  const body = nativePromptBody(markdown);
  const bodyId = `prompt-${style.slug}`;
  const duration = Number(style.rhythm?.duration);
  const durationLabel = Number.isFinite(duration) && duration > 0 ? `${duration} 秒` : '';

  return `<div class="prompt-wrap">
    <div class="prompt-bar">
      <div class="prompt-meta">
        <span class="prompt-kicker">中文提示词</span>
        <span>${body.length} 字符</span>
      </div>
      <div class="prompt-actions">
        <button class="copy is-accent" type="button" data-copy="${bodyId}">复制原提示词</button>
        <button class="copy" type="button" data-template-style="${esc(style.slug)}"
          data-fill-style="${esc(`${style.name}（${style.slug}）`)}"
          data-fill-spec="${esc(templateSpec(style))}"
          data-fill-duration="${esc(durationLabel)}"
          title="复制模板，填写自己的主题">用此风格创作</button>
      </div>
    </div>
    <p class="prompt-hint">复制原提示词：参考或修改这支样片。用此风格创作：复制模板，填写自己的主题。</p>
    <details class="prompt-fold">
      <summary>提示词正文<span>展开 / 收起 · ${body.length} 字符</span></summary>
      <div class="prompt-fold-body">
        <pre class="code prompt" id="${bodyId}">${esc(body)}</pre>
      </div>
    </details>
  </div>`;
}

function renderPlayer(style, film, number) {
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
  const durationLabel = formatSeconds(film?.duration ?? rhythm.duration);

  if (!hasVideo) {
    return {
      html: `<figure class="player" data-film="false" style="--ratio:${ratio}">
        <div class="poster-missing">
          <span class="ghost" aria-hidden="true">${esc(number)}</span>
          <div class="poster-palette" aria-hidden="true">
            ${(style.colors || []).filter(isHex).slice(0, 8).map((color) => `<span style="--sw:${esc(color)}"></span>`).join('')}
          </div>
        </div>
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
      <figcaption>
        <span class="badge">DrawAI 样片</span>
        <span>${film?.title ? `${esc(film.title)} · ` : ''}${width}×${height} · ${durationLabel || '—'}</span>
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

function renderFacts(style, engines, film) {
  const rhythm = style.rhythm || {};
  const facts = [
    ['画幅', rhythm.aspect || '—'],
    ['帧率', rhythm.fps ? `${rhythm.fps} fps` : '—'],
    ['基准片长', formatSeconds(rhythm.duration) || '—'],
  ];

  if (film?.duration && Number(film.duration) !== Number(rhythm.duration)) {
    facts.push(['样片时长', formatSeconds(film.duration) || '—']);
  }

  facts.push(
    ['BPM', rhythm.bpm ?? '—'],
    ['切点', rhythm.cutFrames ? `${rhythm.cutFrames} 帧` : '—'],
    ['引擎', engines.length ? engines.join(' + ') : '—'],
  );

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
  if (motion.grain) {
    const value = motion.grain;
    chips.push(typeof value === 'string' || typeof value === 'number' ? `颗粒 ${value}` : '颗粒');
  }
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

function renderSection(style, film, mediaState, number) {
  const accent = isHex(style.palette?.accent) ? style.palette.accent : '#e8c547';
  const rhythm = style.rhythm || {};
  const engines = Array.isArray(style.engines) && style.engines.length ? style.engines : (style.engine ? [style.engine] : []);
  const portrait = rhythm.aspect === '9:16' || (film && film.h > film.w);
  const player = renderPlayer(style, film, number);
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

  const promptText = readOptional(path.join(NATIVE_PROMPTS, `${style.slug}.md`));
  const hasPrompt = Boolean(promptText && promptText.trim());
  const briefText = readText(briefFile(style), '移植说明');
  const briefHtml = renderBrief(briefText);

  const tabs = [
    ...(hasPrompt ? [['prompt', '提示词']] : []),
    ['brief', '移植说明'],
  ];

  const tabButtons = tabs.map(([key, label], index) => {
    const tabId = `tab-${key}-${style.slug}`;
    const paneId = `pane-${key}-${style.slug}`;
    return `<button class="tab${index === 0 ? ' is-active' : ''}" type="button" role="tab"
      id="${tabId}" aria-controls="${paneId}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"
      data-tab="${key}">${esc(label)}</button>`;
  }).join('');

  const panes = `
    ${hasPrompt ? `<section class="pane is-active" id="pane-prompt-${style.slug}" role="tabpanel" aria-labelledby="tab-prompt-${style.slug}" data-pane="prompt">
      ${renderPrompt(style, promptText)}
    </section>` : ''}

    <section class="pane${hasPrompt ? '' : ' is-active'}" id="pane-brief-${style.slug}" role="tabpanel" aria-labelledby="tab-brief-${style.slug}" data-pane="brief"${hasPrompt ? ' hidden' : ''}>
      <div class="brief">${briefHtml}</div>
    </section>

    `;

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
        ${renderFacts(style, engines, film)}

        <div class="spec-block">
          <h3>色板</h3>
          ${renderPalette(style)}
        </div>

        <div class="spec-block">
          <h3>字体</h3>
          ${renderFonts(style)}
        </div>

        <div class="spec-block">
          <h3>动效默认值</h3>
          ${renderMotion(style)}
        </div>

        <div class="spec-block">
          <h3>参考风格细节</h3>
          <p class="note">以下为参考风格的实现细节，不一定出现在上方样片中。</p>
          ${renderSignature(style)}
        </div>

        ${style.engineNote ? `<div class="spec-block"><h3>引擎说明</h3><p class="note">${esc(style.engineNote)}</p></div>` : ''}
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

const nativeStyles = fs.existsSync(NATIVE_STYLES)
  ? JSON.parse(readText(NATIVE_STYLES, '本地风格参数'))
  : {};
const styles = catalog.styles.map((style) => (
  nativeStyles[style.slug] ? { ...style, ...nativeStyles[style.slug] } : style
));

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

const mediaState = { filmCount: 0 };
const sections = styles.map((style, index) => renderSection(style, media.get(style.slug), mediaState, displayNumber(index)));

const index = styles.map((style, index) => `
  <a class="index-item" href="#${esc(style.slug)}" data-slug="${esc(style.slug)}">
    <span class="index-num">${esc(displayNumber(index))}</span>
    <span class="index-name">${esc(style.name)}</span>
  </a>`).join('');

const firstFilm = [...media.values()].find((item) => item.film !== false && item.poster && fs.existsSync(path.join(SHOWCASE, item.poster)));
const ogImage = firstFilm ? new URL(firstFilm.poster, SITE_URL).toString() : '';
const ogImageMeta = ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : '';

const templateMarkdown = readText(NATIVE_TEMPLATE, '通用制作模板');
const templateHtml = renderTemplate(templateMarkdown, styles.length);
if (!templateHtml) throw new Error('通用制作模板没有正文：showcase/native/prompt-template.md');

const startSlots = templateSlots(templateFillBlock(nativePromptBody(templateMarkdown)));
const startHtml = renderStart(readText(NATIVE_START, '开始使用提示词'), startSlots, styles.length);
if (!startHtml) throw new Error('开始使用提示词为空：showcase/native/start-prompt.txt');

const values = {
  SITE_URL,
  OG_IMAGE_META: ogImageMeta,
  STYLE_COUNT: String(styles.length),
  FILM_COUNT: String(mediaState.filmCount),
  PROMPT_COUNT: String(styles.filter((style) => readOptional(path.join(NATIVE_PROMPTS, `${style.slug}.md`))?.trim()).length),
  INDEX: index,
  SECTIONS: sections.join('\n'),
  TEMPLATE: templateHtml,
  START: startHtml,
};

let html = fs.readFileSync(TEMPLATE, 'utf8');
html = html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
  if (!(key in values)) throw new Error(`模板占位符没有值：${key}`);
  return values[key];
});

fs.writeFileSync(OUTPUT, html, 'utf8');

console.log(`[showcase] 写 ${path.relative(ROOT, OUTPUT)}`);
console.log(`[showcase] ${styles.length} 个风格 · ${mediaState.filmCount} 条样片 · ${fs.statSync(OUTPUT).size.toLocaleString()} bytes`);
