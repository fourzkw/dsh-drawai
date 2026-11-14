#!/usr/bin/env node
/**
 * 下载 mg-styles-15 的参考片并转码成展示站用的 720p 短片。
 *
 *   node tools/showcase-media.mjs                 # 全量
 *   node tools/showcase-media.mjs --force         # 忽略缓存/已生成文件
 *   node tools/showcase-media.mjs --only 09-bauhaus
 *   node tools/showcase-media.mjs --check         # 只校验已有产物
 *
 * 源片来自 catalog.commit 固定的 upstream commit（MIT）。生成物落在
 * showcase/media/，不进 git；Pages 构建时重新生成或命中 .cache/showcase。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MG = path.join(ROOT, 'src', 'motion', 'mgstyles');
const SHOWCASE = path.join(ROOT, 'showcase');
const MEDIA = path.join(SHOWCASE, 'media');
const MANIFEST = path.join(MEDIA, 'manifest.json');
const CACHE_ROOT = path.join(ROOT, '.cache', 'showcase');

const UPSTREAM_REPO = 'https://github.com/Vincentwei1021/mg-styles-15';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const force = hasFlag('--force');
const checkOnly = hasFlag('--check');
const only = valueOf('--only');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const curl = process.env.CURL || 'curl';

const catalog = JSON.parse(fs.readFileSync(path.join(MG, 'catalog.json'), 'utf8'));
const styles = catalog.styles;
const commit = catalog.commit;
const cacheDir = path.join(CACHE_ROOT, commit);

function slugList() {
  const films = styles.filter((style) => style.slug !== '23-ink-wash').map((style) => style.slug);
  if (!only) return films;
  if (!films.includes(only)) throw new Error(`--only 只接受有上游参考片的 slug：${films.join(', ')}`);
  return [only];
}

function ensureTool(command, name, hint) {
  const result = spawnSync(command, name === 'ffmpeg' ? ['-version'] : ['--version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error(`找不到 ${name}（${command}）。${hint}`);
  }
}

function ensureFfmpeg() {
  ensureTool(ffmpeg, 'ffmpeg', '请安装 ffmpeg 或设置 FFMPEG 环境变量。');
  ensureTool(curl, 'curl', '请安装 curl 或设置 CURL 环境变量。');
}

function download(url, destination) {
  const temporary = destination + '.part';
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const result = spawnSync(curl, [
    '-L',
    '--fail',
    '--silent',
    '--show-error',
    '--retry', '3',
    '--retry-delay', '2',
    '--connect-timeout', '20',
    '--output', temporary,
    url,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  if (result.error || result.status !== 0) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    throw new Error(`下载失败（curl exit ${result.status ?? '?'}）：${url}`);
  }
  fs.renameSync(temporary, destination);
  return fs.statSync(destination).size;
}

function cachedDownload(url, file) {
  if (!force && fs.existsSync(file) && fs.statSync(file).size > 128 * 1024) {
    return fs.statSync(file).size;
  }
  const size = download(url, file);
  console.log(`[media] 下载 ${path.basename(file)} · ${(size / 1024 / 1024).toFixed(1)} MB`);
  return size;
}

function runFfmpeg(argv, label) {
  const result = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...argv], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const tail = (result.stderr || '').trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`${label} 失败（ffmpeg exit ${result.status}）\n${tail}`);
  }
}

async function transcode(style) {
  const slug = style.slug;
  const sourceVideo = path.join(cacheDir, `${slug}.mp4`);
  const sourcePoster = path.join(cacheDir, `${slug}.jpg`);
  const outVideo = path.join(MEDIA, `${slug}.mp4`);
  const outPoster = path.join(MEDIA, `${slug}.jpg`);

  const videoUrl = `${UPSTREAM_REPO.replace('github.com', 'raw.githubusercontent.com')}/${commit}/videos/${slug}.mp4`;
  const posterUrl = `${UPSTREAM_REPO.replace('github.com', 'raw.githubusercontent.com')}/${commit}/videos/${slug}.jpg`;

  console.log(`[media] ${slug} · 取源片`);
  await cachedDownload(videoUrl, sourceVideo);

  const portrait = style.rhythm?.aspect === '9:16';
  const scale = portrait ? 'scale=-2:1280:flags=lanczos' : 'scale=1280:-2:flags=lanczos';
  const width = portrait ? 720 : 1280;
  const height = portrait ? 1280 : 720;

  if (force || !fs.existsSync(outVideo)) {
    runFfmpeg([
      '-i', sourceVideo,
      '-t', String(style.rhythm?.duration || 10),
      '-vf', scale,
      '-c:v', 'libx264', '-crf', '25', '-preset', 'slow', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-movflags', '+faststart',
      outVideo,
    ], `${slug} 视频转码`);
  }

  if (force || !fs.existsSync(outPoster)) {
    try {
      await cachedDownload(posterUrl, sourcePoster);
      runFfmpeg([
        '-i', sourcePoster,
        '-vf', scale,
        '-frames:v', '1',
        '-q:v', '4',
        outPoster,
      ], `${slug} 封面转码`);
    } catch (error) {
      console.warn(`[media] ${slug} 没有可用封面，改从视频抽帧：${error.message}`);
      runFfmpeg([
        '-ss', '1',
        '-i', sourceVideo,
        '-frames:v', '1',
        '-vf', scale,
        '-q:v', '4',
        outPoster,
      ], `${slug} 抽封面`);
    }
  }

  const bytes = fs.statSync(outVideo).size;
  const sha256 = createHash('sha256').update(fs.readFileSync(outVideo)).digest('hex');

  console.log(`[media] ${slug} · ${width}×${height} · ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  return {
    slug,
    film: true,
    video: `media/${slug}.mp4`,
    poster: `media/${slug}.jpg`,
    w: width,
    h: height,
    duration: style.rhythm?.duration || 10,
    bytes,
    sha256,
    source: `${UPSTREAM_REPO}/blob/${commit}/videos/${slug}.mp4`,
    license: 'MIT',
  };
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) {
    return {
      version: 1,
      source: 'mg-styles-15',
      commit,
      license: 'MIT',
      generatedAt: null,
      films: [],
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return {
      version: 1,
      source: 'mg-styles-15',
      commit,
      license: 'MIT',
      generatedAt: null,
      ...parsed,
      films: Array.isArray(parsed.films) ? parsed.films : Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (error) {
    throw new Error(`manifest.json 解析失败：${error.message}`);
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(MEDIA, { recursive: true });
  const films = styles.map((style) => {
    const existing = manifest.films.find((item) => item.slug === style.slug);
    if (style.slug === '23-ink-wash') {
      return {
        slug: style.slug,
        film: false,
        video: null,
        poster: null,
        note: '上游 mg-styles-15 没有这支风格；配方来自 huashu-art-motion。',
      };
    }
    return existing || null;
  }).filter(Boolean);

  const next = {
    version: 1,
    source: 'mg-styles-15',
    commit,
    license: 'MIT',
    generatedAt: new Date().toISOString(),
    films,
  };
  const tmp = MANIFEST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, MANIFEST);
  console.log(`[media] 写 ${path.relative(ROOT, MANIFEST)} · ${films.filter((item) => item.film).length} 条参考片`);
}

function check() {
  const manifest = readManifest();
  const problems = [];

  for (const style of styles) {
    const item = manifest.films.find((film) => film.slug === style.slug);
    if (!item) {
      problems.push(`${style.slug}: manifest 缺条目`);
      continue;
    }
    if (item.film === false) continue;
    for (const key of ['video', 'poster']) {
      const file = item[key];
      if (!file || !fs.existsSync(path.join(SHOWCASE, file))) {
        problems.push(`${style.slug}: 缺少 ${key} ${file || ''}`);
      }
    }
  }

  if (problems.length) {
    console.error('[media] 检查失败：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[media] 检查通过 · ${manifest.films.filter((item) => item.film).length} 条参考片 · commit ${commit.slice(0, 8)}`);
}

async function main() {
  if (checkOnly) {
    check();
    return;
  }

  ensureFfmpeg();
  fs.mkdirSync(MEDIA, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const manifest = readManifest();
  const results = [];

  for (const slug of slugList()) {
    const style = styles.find((item) => item.slug === slug);
    if (!style) throw new Error(`catalog 里找不到 ${slug}`);
    const film = await transcode(style);
    results.push(film);
    const index = manifest.films.findIndex((item) => item.slug === slug);
    if (index >= 0) manifest.films[index] = film;
    else manifest.films.push(film);
    writeManifest(manifest);
  }

  writeManifest(manifest);
  console.log(`[media] 完成 · ${results.length} 条`);
}

main().catch((error) => {
  console.error(`[media] ${error.message}`);
  process.exitCode = 1;
});
