#!/usr/bin/env node
// In-game audio integration check: loads /?scene=audio-game (full game + scripted events) and prints engine stats.
// Usage: node tools/audio-game.mjs [--port 5188]   (expects a dev server on the port, e.g. the no-HMR tools/audio-vite.config.mjs)
import { chromium } from 'playwright';
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 5188) || 5188;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || /\[audio\]/.test(m.text())) errors.push(`[${m.type()}] ${m.text()}`); });
try {
  await page.goto(`http://127.0.0.1:${port}/?scene=audio-game&q=0`, { timeout: 300000 });
  await page.waitForFunction(() => window.__shameless?.ready === true, null, { timeout: 600000, polling: 500 });
  await page.waitForFunction(() => window.__shameless.api.stats().phase === 'script', null, { timeout: 600000, polling: 500 });
  await page.waitForTimeout(8000);
  console.log(JSON.stringify(await page.evaluate(() => window.__shameless.api.stats()), null, 1));
} catch (e) { console.error('FAILED', e.message); process.exitCode = 1; }
finally { if (errors.length) console.log([...new Set(errors)].filter((e) => !/THREE\./.test(e)).slice(0, 20).join('\n')); await browser.close(); }
