#!/usr/bin/env node
// Builds tools/dragon/dragon.glb from tools/dragon/dragon.js in headless Chromium, then renders preview
// images of the re-imported GLB. Usage: node tools/dragon/build.mjs [--previews <dir>]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const pi = argv.indexOf('--previews');
const previewDir = pi >= 0 ? path.resolve(argv[pi + 1]) : null;

const html = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<style>html,body{margin:0;background:#000}</style></head>
<body><script type="module" src="/dragon.js"></script></body></html>`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.stack ?? e.message));
page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
await page.route('http://dragon.local/**', (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
  const file = p.startsWith('/three/') ? path.join(root, 'node_modules', p.slice(1)) : path.join(here, p.slice(1));
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
  return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(file) });
});
await page.goto('http://dragon.local/');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });

const b64 = await page.evaluate(() => window.__exportGLB());
const out = path.join(here, 'dragon.glb');
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
const stats = await page.evaluate(() => window.__stats);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KiB)`, stats);

if (previewDir) {
  fs.mkdirSync(previewDir, { recursive: true });
  await page.evaluate(() => window.__preview());
  const views = { front: [0.7, 0.15, 8.5], side: [Math.PI / 2, 0.05, 9], back: [-2.4, 0.35, 9], head: [0.9, 0.1, 1.6, 0, 2.1, 1.7] };
  for (const [name, v] of Object.entries(views)) {
    await page.evaluate((v) => window.__view(...v), v);
    await page.locator('canvas').screenshot({ path: path.join(previewDir, `${name}.png`) });
  }
  console.log('previews in', previewDir);
}
await browser.close();
