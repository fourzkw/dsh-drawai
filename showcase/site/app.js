(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const sections = $$('.style');
  const indexItems = $$('.index-item');
  const bySlug = new Map(sections.map((section) => [section.id, section]));
  const search = $('#search');
  const searchStatus = $('#search-status');
  const now = $('#now');
  const toastEl = $('#toast');
  let toastTimer = 0;
  let loadToken = 0;

  const TABS = new Set(['prompt', 'brief', 'src', 'use']);

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('is-visible'), 1600);
  }

  async function copyText(text) {
    const value = String(text ?? '');
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      area.remove();
    }
    toast('已复制');
  }

  /* ---------- tabs + deep links ---------- */

  function parseHash() {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return null;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }

    const colon = decoded.indexOf(':');
    if (colon === -1) return { slug: decoded, tab: 'prompt', path: null };

    const slug = decoded.slice(0, colon);
    const rest = decoded.slice(colon + 1);
    if (rest.startsWith('src/')) return { slug, tab: 'src', path: rest.slice(4) || null };
    if (TABS.has(rest)) return { slug, tab: rest, path: null };
    return { slug, tab: 'prompt', path: null };
  }

  function setHash(section, tab, filePath = null) {
    let next = '#' + section.id;
    if (tab !== 'prompt') {
      next += ':' + tab;
      if (tab === 'src' && filePath) next += '/' + filePath;
    }
    if (window.location.hash !== next) {
      history.replaceState(null, '', next);
    }
  }

  function openTab(section, tab, filePath = null, updateHash = true) {
    if (!TABS.has(tab)) tab = 'prompt';
    const buttons = $$('.tab', section);
    const panes = $$('.pane', section);

    buttons.forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });

    panes.forEach((pane) => {
      const active = pane.dataset.pane === tab;
      pane.classList.toggle('is-active', active);
      pane.hidden = !active;
    });

    if (tab === 'src') {
      const source = $('.source', section);
      if (source) {
        if (filePath) {
          loadFile(source, filePath);
        } else if (source.dataset.loaded !== '1' && source.dataset.first) {
          loadFile(source, source.dataset.first);
        }
      }
    }

    if (updateHash) setHash(section, tab, filePath);
  }

  function applyHash(scroll) {
    const state = parseHash();
    if (!state) return;
    const section = bySlug.get(state.slug);
    if (!section) return;

    if (section.hidden) {
      if (search) search.value = '';
      applySearch();
    }

    openTab(section, state.tab, state.path, false);
    if (scroll) {
      window.requestAnimationFrame(() => {
        section.scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    }
  }

  function initTabs() {
    $$('.tabs').forEach((tablist) => {
      const section = tablist.closest('.style');
      if (!section) return;
      const buttons = $$('.tab', tablist);

      buttons.forEach((button, index) => {
        button.addEventListener('click', () => openTab(section, button.dataset.tab));
        button.addEventListener('keydown', (event) => {
          const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!delta) return;
          event.preventDefault();
          const target = buttons[(index + delta + buttons.length) % buttons.length];
          target.focus();
          target.click();
        });
      });
    });
  }

  /* ---------- source browser ---------- */

  function renderCode(pre, text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    pre._raw = text;

    if (lines.length > 5000) {
      pre.textContent = text;
      return;
    }

    const fragment = document.createDocumentFragment();
    lines.forEach((line, index) => {
      const row = document.createElement('span');
      row.className = 'cline';
      const number = document.createElement('span');
      number.className = 'ln';
      number.textContent = String(index + 1);
      number.setAttribute('aria-hidden', 'true');
      const code = document.createElement('span');
      code.className = 'lc';
      code.textContent = line.length ? line : ' ';
      row.append(number, code);
      fragment.append(row);
    });
    pre.replaceChildren(fragment);
  }

  function encodePath(filePath) {
    return String(filePath).split('/').map(encodeURIComponent).join('/');
  }

  async function loadFile(source, filePath) {
    if (!source || !filePath) return;
    const token = ++loadToken;
    const pre = $('.code', source);
    const pathLabel = $('.code-path', source);
    const link = $('.code-link', source);
    const base = source.dataset.base;
    if (!pre || !base) return;

    const buttons = $$('.file', source);
    const button = buttons.find((item) => item.dataset.path === filePath) || null;
    buttons.forEach((item) => item.classList.toggle('is-active', item === button));

    if (pathLabel) pathLabel.textContent = filePath;
    if (link) {
      if (button?.dataset.url) {
        link.href = button.dataset.url;
        link.hidden = false;
      } else {
        link.hidden = true;
        link.removeAttribute('href');
      }
    }

    pre.textContent = '加载中…';

    try {
      const response = await fetch(base + '/' + encodePath(filePath), { cache: 'no-cache' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = await response.text();
      if (token !== loadToken) return;
      renderCode(pre, text);
      if (pathLabel) {
        const count = text.replace(/\r\n?/g, '\n').split('\n').length;
        pathLabel.textContent = filePath + ' · ' + count + ' 行';
      }
      source.dataset.loaded = '1';
      source.dataset.current = filePath;
    } catch (error) {
      if (token !== loadToken) return;
      pre.textContent = '加载失败：' + error.message + '\n\n如果是本地打开，请用 npm run showcase:dev 启动静态服务器。';
      pre._raw = pre.textContent;
    }
  }

  function initSource() {
    $$('.source').forEach((source) => {
      $$('.file', source).forEach((button) => {
        button.addEventListener('click', () => {
          const section = source.closest('.style');
          if (section) openTab(section, 'src', button.dataset.path);
        });
      });
    });
  }

  /* ---------- search ---------- */

  function applySearch() {
    if (!search) return;
    const query = search.value.trim().toLowerCase();
    let shown = 0;

    sections.forEach((section) => {
      const match = !query || (section.dataset.search || '').includes(query);
      section.hidden = !match;
      if (match) shown += 1;
    });

    indexItems.forEach((item) => {
      const section = bySlug.get(item.dataset.slug);
      item.hidden = !section || section.hidden;
    });

    if (searchStatus) {
      searchStatus.hidden = !query;
      searchStatus.textContent = query
        ? `显示 ${shown} / ${sections.length} 种风格 · Esc 清空`
        : '';
    }
  }

  function initSearch() {
    if (!search) return;
    search.addEventListener('input', applySearch);
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        search.value = '';
        applySearch();
        search.blur();
      }
      if (event.key === 'Enter') {
        const first = sections.find((section) => !section.hidden);
        if (first) first.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      }
    });

    document.addEventListener('keydown', (event) => {
      const tag = document.activeElement?.tagName || '';
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
        event.preventDefault();
        search.focus();
        search.select();
      }
    });
  }

  /* ---------- scrollspy + video ---------- */

  function setActive(section) {
    indexItems.forEach((item) => item.classList.toggle('is-active', item.dataset.slug === section.id));
    if (!now) return;
    const number = $('.style-num', section)?.textContent.trim() || '';
    const title = $('h2', section)?.textContent.trim() || '';
    now.textContent = (number ? number + ' · ' : '') + title;
  }

  function initScrollspy() {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setActive(entry.target);
        } else {
          $$('video', entry.target).forEach((video) => video.pause());
        }
      });
    }, { rootMargin: '-18% 0px -66% 0px', threshold: 0 });

    sections.forEach((section) => observer.observe(section));
  }

  function initVideos() {
    document.addEventListener('play', (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      $$('video').forEach((other) => {
        if (other !== video) other.pause();
      });
    }, true);

    $$('.player').forEach((player) => {
      const video = $('video', player);
      const button = $('[data-play]', player);
      if (!video || !button) return;

      button.addEventListener('click', () => {
        video.play().catch(() => {});
      });
      video.addEventListener('play', () => { button.hidden = true; });
      video.addEventListener('ended', () => { button.hidden = false; });
    });
  }

  /* ---------- copy ---------- */

  function initCopy() {
    document.addEventListener('click', (event) => {
      const copyButton = event.target.closest('[data-copy]');
      if (copyButton) {
        const target = document.getElementById(copyButton.dataset.copy);
        if (target) copyText(target._raw ?? target.textContent);
        return;
      }

      const swatch = event.target.closest('.swatch[data-hex]');
      if (swatch) copyText(swatch.dataset.hex);
    });
  }

  /* ---------- boot ---------- */

  initTabs();
  initSource();
  initSearch();
  initScrollspy();
  initVideos();
  initCopy();

  applyHash(true);
  window.addEventListener('hashchange', () => applyHash(false));
})();
