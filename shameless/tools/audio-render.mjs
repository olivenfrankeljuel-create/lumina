#!/usr/bin/env node
// Audio verification harness. Loads /?scene=audio in headless Chromium, which synthesizes the whole
// sample bank offline, then exports every sound (all variants) as WAV + a waveform/envelope/spectrogram
// PNG, renders mix scenarios through the real engine graph, and prints a measurement table.
//
// Usage: node tools/audio-render.mjs [--port 5188] [--only rifle_core,tail_out] [--mix all|none|name,name] [--no-sounds] [--out shots/audio]
// Starts a vite dev server on the port if nothing is listening there.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const argv = process.argv.slice(2);
const opt = { nodyn: false, port: 5188, only: null, mix: 'all', sounds: true, out: 'shots/audio', contact: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = argv[i + 1];
  if (a === '--port') { opt.port = Number(v); i++; }
  else if (a === '--only') { opt.only = v.split(','); i++; }
  else if (a === '--mix') { opt.mix = v; i++; }
  else if (a === '--no-sounds') opt.sounds = false;
  else if (a === '--no-contact') opt.contact = false;
  else if (a === '--nodyn') opt.nodyn = true; // also render mixes without master compressor/limiter
  else if (a === '--out') { opt.out = v; i++; }
  else { console.error('unknown arg', a); process.exit(2); }
}
fs.mkdirSync(opt.out, { recursive: true });

const ping = () => new Promise((res) => {
  const r = http.get({ host: '127.0.0.1', port: opt.port, path: '/', timeout: 1000 }, (x) => { x.resume(); res(true); });
  r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); });
});

let server = null;
if (!(await ping())) {
  server = spawn('npx', ['vite', '--config', 'tools/audio-vite.config.mjs'], { env: { ...process.env, PORT: String(opt.port) }, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 500));
}

function writeWav(file, b64, ch, sr) {
  const data = Buffer.from(b64, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
const writePng = (file, dataUrl) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack ?? e.message}`));

const rows = [];
const load = async () => {
  await page.goto(`http://127.0.0.1:${opt.port}/?scene=audio`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__shameless?.ready === true, null, { timeout: 300000, polling: 250 });
};
// Evaluate with a reload-and-retry if the page navigated (e.g. a dev server reload).
const ev = async (fn, arg) => {
  for (let attempt = 0; ; attempt++) {
    try {
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('evaluate timeout (hung page)')), 150000); });
      try { return await Promise.race([page.evaluate(fn, arg), timeout]); } finally { clearTimeout(timer); }
    } catch (e) {
      if (attempt >= 2 || !/context was destroyed|navigation|__shameless|evaluate timeout/.test(e.message)) throw e;
      console.warn('page reloaded, retrying:', e.message.split('\n')[0]);
      await load();
    }
  }
};
try {
  await load();
  const info = await ev(() => ({ renderMs: window.__shameless.api.renderMs, criticalMs: window.__shameless.api.criticalMs, list: window.__shameless.api.list(), mixes: window.__shameless.api.mixList() }));
  console.log(`bank render: all ${info.renderMs.toFixed(0)} ms, critical tier ${info.criticalMs.toFixed(0)} ms, ${info.list.length} sounds`);

  if (opt.contact) {
    writePng(path.join(opt.out, '_contact.png'), await ev(() => window.__shameless.api.contact()));
    console.log(`saved ${opt.out}/_contact.png`);
  }
  if (opt.sounds) {
    for (const name of info.list) {
      if (opt.only && !opt.only.includes(name)) continue;
      const r = await ev((n) => ({ ...window.__shameless.api.exportSound(n), props: window.__shameless.api.props(n) }), name);
      writeWav(path.join(opt.out, `${name}.wav`), r.wav.b64, r.wav.ch, r.wav.sr);
      writePng(path.join(opt.out, `${name}.png`), r.png);
      rows.push({ ...r.metrics, ...r.props });
    }
  }
  const mixNames = opt.mix === 'none' ? [] : opt.mix === 'all' ? info.mixes : opt.mix.split(',');
  for (const [mi, name] of mixNames.entries()) {
    if (mi > 0 || opt.sounds) await load(); // fresh page per mix: long offline renders are flaky in a page that already rendered a lot
    for (const dyn of opt.nodyn ? [true, false] : [true]) {
      const r = await ev(async ([n, d]) => await window.__shameless.api.exportMix(n, d), [name, dyn]);
      const base = dyn ? name : `${name}_nodyn`;
      writeWav(path.join(opt.out, `${base}.wav`), r.wav.b64, r.wav.ch, r.wav.sr);
      writePng(path.join(opt.out, `${base}.png`), r.png);
      rows.push({ ...r.metrics, cat: 'MIX', bus: 'master', gainDb: 0, busDb: 0 });
    }
  }
} catch (e) {
  console.error('AUDIO RENDER FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log('--- page console errors/warnings ---\n' + [...new Set(errors)].slice(0, 30).join('\n'));
  await browser.close();
  if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); } } // only the server we spawned (its own process group)
}

if (rows.length) {
  const f = (v, d = 1, w = 6) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);
  const hdr = `${'sound'.padEnd(22)} ${'cat'.padEnd(8)} ${'var'.padStart(3)} ${'dur'.padStart(5)} ${'peak'.padStart(6)} clip ${'dc'.padStart(8)} ${'LUFSm'.padStart(6)} ${'play'.padStart(6)} ${'crest'.padStart(6)} ${'atk50'.padStart(6)} ${'atk90'.padStart(6)} ${'T40'.padStart(5)} ${'T60'.padStart(5)} ${'cent'.padStart(6)} ${'sub'.padStart(5)} ${'low'.padStart(5)} ${'lmid'.padStart(5)} ${'mid'.padStart(5)} ${'high'.padStart(5)} ${'air'.padStart(5)} ${'vdiff'.padStart(5)} ${'punch'.padStart(5)}`;
  const lines = [hdr, '-'.repeat(hdr.length)];
  for (const r of rows) {
    const play = r.lufsM + r.gainDb + r.busDb;
    lines.push(`${r.name.padEnd(22)} ${String(r.cat).padEnd(8)} ${String(r.variants).padStart(3)} ${f(r.dur, 2, 5)} ${f(r.peakDb, 2)} ${String(r.clipped).padStart(4)} ${r.dc.toExponential(1).padStart(8)} ${f(r.lufsM)} ${f(play)} ${f(r.crestDb)} ${f(r.attack50Ms, 2)} ${f(r.attack90Ms, 2)} ${f(r.tail40, 2, 5)} ${f(r.tail60, 2, 5)} ${f(r.centroid, 0)} ${f(r.bands.sub, 1, 5)} ${f(r.bands.low, 1, 5)} ${f(r.bands.lmid, 1, 5)} ${f(r.bands.mid, 1, 5)} ${f(r.bands.high, 1, 5)} ${f(r.bands.air, 1, 5)} ${f(r.varDb, 1, 5)} ${f(r.modDb, 1, 5)}`);
  }
  // category balance (as played: bank loudness + sound gain + bus gain)
  const cats = {};
  for (const r of rows) if (r.cat !== 'MIX') (cats[r.cat] ??= []).push(r.lufsM + r.gainDb + r.busDb);
  lines.push('', 'category balance (LUFS-M as played at 1 m, before master dynamics):');
  for (const [c, v] of Object.entries(cats)) lines.push(`  ${c.padEnd(9)} mean ${f(v.reduce((a, b) => a + b, 0) / v.length)}  min ${f(Math.min(...v))}  max ${f(Math.max(...v))}`);
  const txt = lines.join('\n');
  console.log(txt);
  fs.writeFileSync(path.join(opt.out, 'metrics.txt'), txt + '\n');
  fs.writeFileSync(path.join(opt.out, 'metrics.json'), JSON.stringify(rows, null, 1));
}
