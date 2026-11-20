/**
 * Minimal static server for apps/pwa/dist, to try the PWA locally.
 * http://localhost counts as a secure context, so Web Serial works in
 * Chrome / Edge on this computer (the paired ELM327 shows up as a COM port).
 *
 * Usage: node serve.mjs [port]   (default 5173)
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.argv[2] || process.env.PORT || 5173);
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav',
};

http.createServer(async (req, res) => {
    const rel = path.posix.normalize('/' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    let file = path.join(dist, rel);
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    try {
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(await readFile(file));
    } catch {
        res.writeHead(404).end('not found');
    }
}).listen(port, '127.0.0.1', () => console.log(`PWA: http://localhost:${port}  (abre en Chrome o Edge)`));
