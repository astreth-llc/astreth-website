#!/usr/bin/env node
/**
 * Local preview of ./dist that behaves like Cloudflare's static hosting:
 *   - /about-us serves about-us.html, and /about-us.html or /about-us/ redirect to /about-us
 *   - rules in _redirects are applied
 *   - unknown paths get 404.html with a 404 status
 * Usage: npm run preview   (then open http://localhost:8788)
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT) || 8788;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

function loadRedirects() {
  const file = path.join(DIST, '_redirects');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [from, to, status] = line.split(/\s+/);
      return { from, to, status: Number(status) || 302 };
    });
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();

function send(res, status, file, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', ...extraHeaders });
  createReadStream(file).pipe(res);
}

function redirect(res, status, location) {
  res.writeHead(status, { Location: location });
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
  const query = url.search;

  for (const rule of loadRedirects()) {
    const splat = rule.from.endsWith('*') && pathname.startsWith(rule.from.slice(0, -1));
    if (pathname === rule.from || splat) {
      const target = splat ? rule.to.replace(':splat', pathname.slice(rule.from.length - 1)) : rule.to;
      return redirect(res, rule.status, target);
    }
  }

  const fsPath = path.join(DIST, pathname);
  if (!fsPath.startsWith(DIST)) return redirect(res, 302, '/');

  if (pathname.endsWith('/index.html')) return redirect(res, 307, pathname.slice(0, -'index.html'.length) + query);
  if (pathname.endsWith('.html')) return redirect(res, 307, pathname.slice(0, -'.html'.length) + query);

  if (pathname === '/') return send(res, 200, path.join(DIST, 'index.html'));

  if (pathname.endsWith('/')) {
    if (isFile(path.join(fsPath, 'index.html'))) return send(res, 200, path.join(fsPath, 'index.html'));
    if (isFile(`${fsPath.slice(0, -1)}.html`)) return redirect(res, 307, pathname.slice(0, -1) + query);
  } else {
    if (isFile(fsPath)) return send(res, 200, fsPath);
    if (isFile(`${fsPath}.html`)) return send(res, 200, `${fsPath}.html`);
    if (isFile(path.join(fsPath, 'index.html'))) return redirect(res, 307, `${pathname}/${query}`);
  }

  const notFound = path.join(DIST, '404.html');
  if (isFile(notFound)) return send(res, 404, notFound);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Previewing dist/ at http://localhost:${PORT}  (Ctrl+C to stop)`);
});
