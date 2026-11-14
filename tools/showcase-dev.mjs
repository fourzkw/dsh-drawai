#!/usr/bin/env node
/**
 * 展示站本地预览：静态托管 showcase/，支持 mp4 的 Range 请求。
 *
 *   node tools/showcase-dev.mjs
 *   PORT=4174 node tools/showcase-dev.mjs
 *   node tools/showcase-dev.mjs --open
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOWCASE = path.join(ROOT, 'showcase');
const INDEX = path.join(SHOWCASE, 'index.html');
const BUILD = path.join(ROOT, 'tools', 'showcase-build.mjs');

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const shouldOpen = process.argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

if (!fs.existsSync(INDEX)) {
  console.log('[showcase] 没有 index.html，先构建一次');
  const result = spawnSync(process.execPath, [BUILD], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

function sendText(response, status, text) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

function serve(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
  } catch {
    sendText(response, 400, 'Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const relative = pathname.replace(/^\/+/, '');
  const file = path.resolve(SHOWCASE, relative);

  if (file !== SHOWCASE && !file.startsWith(SHOWCASE + path.sep)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendText(response, 404, `Not found: ${pathname}`);
    return;
  }
  if (stat.isDirectory()) {
    const index = path.join(file, 'index.html');
    if (fs.existsSync(index)) {
      response.writeHead(302, { Location: pathname.replace(/\/?$/, '/') });
      response.end();
    } else {
      sendText(response, 404, `Not found: ${pathname}`);
    }
    return;
  }

  const extension = path.extname(file).toLowerCase();
  const type = MIME[extension] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };

  const range = request.headers.range;
  if (range && extension === '.mp4') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = String(end - start + 1);
        response.writeHead(206, headers);
        if (request.method === 'HEAD') {
          response.end();
        } else {
          fs.createReadStream(file, { start, end }).pipe(response);
        }
        return;
      }
    }
  }

  headers['Content-Length'] = String(stat.size);
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer(serve);
server.on('error', (error) => {
  console.error(`[showcase] ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}/`;
  console.log(`[showcase] ${url}`);
  if (shouldOpen) {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawnSync(command, args, { stdio: 'ignore', detached: true });
  }
});
