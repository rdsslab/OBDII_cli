/**
 * Build the PWA into apps/pwa/dist — no bundler, no dependencies.
 *
 *   dist/index.html              packages/ui/index.html + manifest + import map,
 *                                entry switched to src/main-direct.js (Web Serial)
 *   dist/src/**                  packages/ui/src (shared UI)
 *   dist/vendor/core/*.js        packages/core/src  (bare import "@obdii/core")
 *   dist/vendor/web-serial/*.js  packages/web-serial/src ("@obdii/web-serial")
 *   dist/manifest.webmanifest, dist/sw.js (offline cache), dist/icons/*
 *
 * All paths are relative, so it works at any sub-path (e.g. GitHub Pages
 * https://<user>.github.io/<repo>/).
 */
import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(here, 'dist');
const UI = path.join(root, 'packages/ui');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1. Shared UI, core and the Web Serial transport
await cp(path.join(UI, 'src'), path.join(dist, 'src'), { recursive: true });
await cp(path.join(root, 'packages/core/src'), path.join(dist, 'vendor/core'), {
    recursive: true,
    filter: (src) => !src.endsWith('sim-transport.js'),     // test/demo only
});
await cp(path.join(root, 'packages/web-serial/src'), path.join(dist, 'vendor/web-serial'), { recursive: true });
await cp(path.join(here, 'public'), dist, { recursive: true });

// 2. index.html for the PWA
const importMap = {
    imports: {
        '@obdii/core': './vendor/core/index.js',
        '@obdii/web-serial': './vendor/web-serial/index.js',
    },
};
let html = await readFile(path.join(UI, 'index.html'), 'utf8');
const entryRe = /\s*<!-- obdii:entry:start[^>]*-->[\s\S]*?<!-- obdii:entry:end -->/;
if (!entryRe.test(html)) throw new Error('Entry marker not found in packages/ui/index.html');
html = html.replace(entryRe, `
  <script type="importmap">${JSON.stringify(importMap)}</script>
  <script type="module" src="src/main-direct.js"></script>`);
html = html.replace('<link rel="icon" href="src/icon.svg" type="image/svg+xml">', [
    '<link rel="icon" href="icons/icon.svg" type="image/svg+xml">',
    '  <link rel="apple-touch-icon" href="icons/icon-any-192.png">',
    '  <link rel="manifest" href="manifest.webmanifest">',
    '  <meta name="description" content="Diagnóstico OBD2 / KWP2000 con un ELM327 por Web Serial (Bluetooth o USB)">',
].join('\n'));
await writeFile(path.join(dist, 'index.html'), html);

// 3. Offline cache: list every file and version the cache by content hash
async function walk(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await walk(p));
        else out.push(p);
    }
    return out;
}
const files = (await walk(dist)).filter(f => !f.endsWith('sw.js'));
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(f).update(await readFile(f));
const version = hash.digest('hex').slice(0, 12);
const assets = ['./', ...files.map(f => './' + path.relative(dist, f).split(path.sep).join('/'))];
const swTemplate = await readFile(path.join(here, 'sw.template.js'), 'utf8');
await writeFile(path.join(dist, 'sw.js'), swTemplate
    .replace('__VERSION__', version)
    .replace('__ASSETS__', JSON.stringify(assets, null, 2)));
await writeFile(path.join(dist, '.nojekyll'), '');

const size = (await Promise.all(files.map(f => stat(f)))).reduce((a, s) => a + s.size, 0);
console.log(`PWA built in apps/pwa/dist — ${files.length} files, ${(size / 1024).toFixed(0)} KB, cache ${version}`);
