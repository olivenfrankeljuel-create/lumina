#!/usr/bin/env node
// Screenshot harness. Loads a page, waits for window.__shameless.ready, lets N frames render,
// optionally runs JS steps, and saves PNGs. Prints page console errors.
//
// Usage:
//   node tools/shot.mjs --port 5173 --path "/?shot=1" --out shots/game.png
//   node tools/shot.mjs --port 5181 --path "/?scene=weapon" --out shots/w.png --frames 30 --size 1600x900
//   Multiple shots: --step "js expression" --out a.png --step "js" --out b.png  (each --step runs before the next --out)
//   --fixed 0.016  sets window.__shameless.fixedDt for deterministic time
//   --wait-ms 500  extra wall-clock wait before each capture
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opts = { port: 5173, path: '/?shot=1', frames: 20, size: '1600x900', timeout: 240000, fixed: null, waitMs: 0 };
const plan = []; // {type:'step', js} | {type:'out', file}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = argv[i + 1];
  switch (a) {
    case '--port': opts.port = Number(v); i++; break;
    case '--path': opts.path = v; i++; break;
    case '--frames': opts.frames = Number(v); i++; break;
    case '--size': opts.size = v; i++; break;
    case '--timeout': opts.timeout = Number(v); i++; break;
    case '--fixed': opts.fixed = Number(v); i++; break;
    case '--wait-ms': opts.waitMs = Number(v); i++; break;
    case '--step': plan.push({ type: 'step', js: v }); i++; break;
    case '--out': plan.push({ type: 'out', file: v }); i++; break;
    default: console.error('unknown arg', a); process.exit(2);
  }
}
if (!plan.some((p) => p.type === 'out')) plan.push({ type: 'out', file: 'shots/shot.png' });
const [W, H] = opts.size.split('x').map(Number);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack ?? e.message}`));

const url = `http://127.0.0.1:${opts.port}${opts.path}`;
const t0 = Date.now();
try {
  await page.goto(url, { waitUntil: 'load', timeout: opts.timeout });
  if (opts.fixed) await page.evaluate((d) => { window.__shameless && (window.__shameless.fixedDt = d); }, opts.fixed);
  await page.waitForFunction(() => window.__shameless?.ready === true, null, { timeout: opts.timeout, polling: 250 });
  if (opts.fixed) await page.evaluate((d) => { window.__shameless.fixedDt = d; }, opts.fixed);
  const waitFrames = async (n) => {
    const start = await page.evaluate(() => window.__shameless.frame);
    await page.waitForFunction((t) => window.__shameless.frame >= t, start + n, { timeout: opts.timeout, polling: 100 });
  };
  await waitFrames(opts.frames);
  for (const p of plan) {
    if (p.type === 'step') {
      const r = await page.evaluate(`(async () => { ${p.js} })()`);
      if (r !== undefined) console.log('step result:', JSON.stringify(r));
    } else {
      await waitFrames(2);
      if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
      fs.mkdirSync(path.dirname(p.file), { recursive: true });
      await page.screenshot({ path: p.file });
      const fps = await page.evaluate(() => window.__shameless.frame);
      console.log(`saved ${p.file} (frame ${fps}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }
} catch (e) {
  console.error('SHOT FAILED:', e.message);
  const f = plan.find((p) => p.type === 'out').file.replace(/\.png$/, '.error.png');
  await page.screenshot({ path: f }).catch(() => {});
  console.error('error screenshot:', f);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log('--- page console errors/warnings ---\n' + [...new Set(errors)].slice(0, 40).join('\n'));
  await browser.close();
}
