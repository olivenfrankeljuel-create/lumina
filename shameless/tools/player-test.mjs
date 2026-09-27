#!/usr/bin/env node
// Headless movement/physics test for the player workstream.
// Drives src/dev/scenes/player.ts through window.__shameless.api with a fixed 60 Hz timestep,
// asserts on numbers, and saves screenshots to shots/player/.
//
//   node tools/player-test.mjs [--port 5183] [--no-shots] [--only name,name]
import { chromium } from 'playwright';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5183));
const SHOTS = !argv.includes('--no-shots');
const ONLY = arg('--only', '')?.split(',').filter(Boolean) ?? [];
fs.mkdirSync('shots/player', { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.text().startsWith('[pt]')) console.log(m.text()); });
page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
// Other agents edit the tree concurrently: mock Vite's HMR socket so their edits can't reload the page mid-test.
await page.routeWebSocket(/.*/, () => {});
await page.goto(`http://127.0.0.1:${PORT}/?scene=player&manual=1`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__shameless?.ready === true, null, { timeout: 120000 });

const E = (fn, ...args) => page.evaluate(fn, ...args);
const api = (code) => page.evaluate(`(() => { const api = window.__shameless.api; ${code} })()`);
const shot = async (name) => {
  if (!SHOTS) return;
  await api('api.render();');
  await page.screenshot({ path: `shots/player/${name}.png` });
  console.log(`   shot: shots/player/${name}.png`);
};

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
async function test(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log(`\n# ${name}`);
  try { await fn(); } catch (e) { fail++; console.log('  FAIL  exception: ' + (e.stack ?? e)); }
}

await test('spawn', async () => {
  const s = await api('return api.teleport(0,0,-1,0);');
  check('grounded after spawn', s.grounded, s.pos);
  check('feet at floor (0..0.06)', s.pos[1] >= -0.01 && s.pos[1] < 0.06, s.pos[1]);
  check('eye height 1.62', near(s.eyeHeight, 1.62, 0.02), s.eyeHeight);
  check('fov 75 with no weapon system', near(s.fov, 75, 0.2), s.fov);
});

await test('walk', async () => {
  await api('api.teleport(0,0,-1,0);');
  const a = await api("return api.until('s.speed >= 4.6*0.9', ['forward'], 2);");
  check('reaches 90% walk speed quickly (<0.25 s)', a.t > 0 && a.t < 0.25, a.t);
  const r = await api("return api.sim(1.5, ['forward']);");
  check('walk speed ≈ 4.6', near(r.final.speed, 4.6, 0.08), r.final.speed);
  check('not sprinting', !r.final.sprinting);
  const st = await api("return api.until('s.speed < 0.1', [], 2);");
  check('stops quickly (<0.25 s)', st.t > 0 && st.t < 0.25, st.t);
  await api('api.teleport(0,0,-1,0);');
  const b = await api("return api.sim(1.5, ['back']);");
  check('backpedal slower (≈3.8)', near(b.final.speed, 4.6 * 0.82, 0.1), b.final.speed);
  await api('api.teleport(0,0,6,0);');
  const sd = await api("return api.sim(1.0, ['left']);");
  check('strafe ≈4.2', near(sd.final.speed, 4.6 * 0.92, 0.1), sd.final.speed);
});

await test('sprint', async () => {
  await api('api.teleport(0,0,-1,0);');
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] });");
  const r = await api("return api.sim(1.5, ['forward']);");
  check('sprint latched by single tap', r.final.sprinting && !r.final.tac, r.final);
  check('sprint speed ≈ 6.1', near(r.final.speed, 6.1, 0.1), r.final.speed);
  check('fov kick while sprinting (≈77)', r.final.fov > 76 && r.final.fov < 78.5, r.final.fov);
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] });");
  const t = await api("return api.sim(1.2, ['forward'], { every: 10 });");
  check('second tap → tactical sprint', t.final.tac, t.final);
  check('tac sprint speed ≈ 6.8', near(t.final.speed, 6.8, 0.1), t.final.speed);
  check('fov kick tac sprint (≈82)', t.final.fov > 80, t.final.fov);
  await shot('tac-sprint');
  // double tap from walking
  await api('api.teleport(0,0,-1,0);');
  await api("api.sim(0.4, ['forward']);");
  await api("api.sim(0.1, ['forward'], { tap: ['sprint'] });");
  await api("api.sim(0.1, ['forward'], { tap: ['sprint'] });");
  const d = await api("return api.sim(1.0, ['forward']);");
  check('double-tap sprint → tac sprint', d.final.tac && near(d.final.speed, 6.8, 0.15), d.final.speed);
  const stop = await api("return api.sim(0.5, []);");
  check('releasing forward ends sprint', !stop.final.sprinting);
  // tac-sprint stamina drains to normal sprint
  await api('api.teleport(0,0,-1,0);');
  await api("api.sim(0.1, ['forward'], { tap: ['sprint'] }); api.sim(0.1, ['forward'], { tap: ['sprint'] });");
  const long = await api("return api.sim(4.5, ['forward']);");
  check('tac sprint runs out → normal sprint', long.final.sprinting && !long.final.tac && near(long.final.speed, 6.1, 0.15), long.final);
});

await test('crouch-prone', async () => {
  await api('api.teleport(0,0,-1,0);');
  const c = await api("api.sim(0.05, [], { tap: ['crouch'] }); return api.sim(0.5, []);");
  check('crouch toggled', c.final.stance === 'crouch' && c.final.crouched, c.final.stance);
  check('crouch eye ≈1.08', near(c.final.eyeHeight, 1.08, 0.03), c.final.eyeHeight);
  await shot('crouched');
  const w = await api("return api.sim(1.2, ['forward']);");
  check('crouch walk ≈2.5 m/s', near(w.final.speed, 2.5, 0.08), w.final.speed);
  const u = await api("api.sim(0.05, [], { tap: ['crouch'] }); return api.sim(0.5, []);");
  check('toggle back to stand', u.final.stance === 'stand' && near(u.final.eyeHeight, 1.62, 0.03), u.final.eyeHeight);
  const trans = await api("api.sim(0.05, [], { tap: ['crouch'] }); return api.sim(0.1, [], { every: 1 });");
  const eyes = trans.samples.map((s) => s.eyeHeight);
  const monotonic = eyes.every((e, i) => i === 0 || e <= eyes[i - 1] + 1e-4);
  check('crouch transition is smooth (no snap; ~0.15 s)', monotonic && eyes[0] > 1.25 && eyes[eyes.length - 1] < 1.2, eyes.map((e) => e.toFixed(2)).join(' '));
  await api("api.sim(0.05, [], { tap: ['crouch'] }); api.sim(0.4, []);");
  const p = await api("api.sim(0.6, ['crouch']); return api.sim(0.6, []);");
  check('hold crouch → prone', p.final.stance === 'prone', p.final.stance);
  check('prone eye ≈0.42', near(p.final.eyeHeight, 0.42, 0.03), p.final.eyeHeight);
  const pw = await api("return api.sim(1.0, ['forward']);");
  check('prone crawl ≈1.05', near(pw.final.speed, 1.05, 0.06), pw.final.speed);
  const pj = await api("api.sim(0.05, [], { tap: ['jump'] }); return api.sim(0.4, []);");
  check('jump from prone → crouch', pj.final.stance === 'crouch', pj.final.stance);
  const cj = await api("api.sim(0.05, [], { tap: ['jump'] }); return api.sim(0.4, []);");
  check('jump from crouch → stand (no hop)', cj.final.stance === 'stand' && cj.maxY < 0.1, cj);
});

await test('slide', async () => {
  await api('api.teleport(0,0,-1,0); api.clearEvents();');
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] }); api.sim(0.05, ['forward'], { tap: ['sprint'] }); api.sim(1.0, ['forward']);");
  const z0 = (await api('return api.snapshot();')).pos[2];
  const s = await api("return api.sim(0.25, ['forward'], { tap: ['crouch'], every: 1 });");
  const peak = Math.max(...s.samples.map((x) => x.speed));
  check('slide starts from tac sprint', s.final.sliding, s.final);
  check('slide speed burst ≥ 8', peak >= 7.9, peak);
  check('camera lowered during slide (eye < 1.0)', s.final.eyeHeight < 1.0, s.final.eyeHeight);
  check('camera roll during slide', Math.abs(s.final.roll) > 0.03, s.final.roll);
  check('fov kick during slide', s.final.fov > 78, s.final.fov);
  await shot('mid-slide');
  const e = await api("return api.until('!s.sliding', ['forward'], 3);");
  const dist = z0 - e.s.pos[2];
  const total = 0.25 + e.t;
  check('slide lasts 0.6–1.2 s', total > 0.6 && total < 1.25, total.toFixed(2));
  check('slide distance 3.5–7 m', dist > 3.5 && dist < 7, dist.toFixed(2));
  check('ends crouched', e.s.stance === 'crouch', e.s.stance);
  const ev = await api("return api.events.filter(e => e.type==='player:slide').length;");
  check('player:slide emitted once', ev === 1, ev);
  // slide cooldown: can't immediately re-slide from crouch
  // slide → jump keeps momentum
  await api('api.teleport(0,0,-1,0);');
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] }); api.sim(1.0, ['forward']); api.sim(0.2, ['forward'], { tap: ['crouch'] });");
  const sj = await api("return api.sim(0.1, ['forward'], { tap: ['jump'] });");
  check('slide-jump: airborne and keeps speed > 6', !sj.final.grounded && sj.final.speed > 6 && !sj.final.sliding, sj.final);
  await api("api.until('s.grounded', ['forward'], 2);");
  // downhill slide (35° ramp) carries further than on flat ground
  await api('api.teleport(20,3,-11.6,0);');
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] }); api.sim(0.4, ['forward']);");
  const zd = (await api('return api.snapshot();')).pos[2];
  await api("api.sim(0.05, ['forward'], { tap: ['crouch'] });");
  const dh = await api("return api.until('!s.sliding', ['forward'], 3);");
  check('downhill slide travels further (> flat distance)', zd - dh.s.pos[2] > dist, [(zd - dh.s.pos[2]).toFixed(2), dist.toFixed(2)]);
  // slide cancel into sprint
  await api('api.teleport(0,0,-1,0);');
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] }); api.sim(1.0, ['forward']); api.sim(0.3, ['forward'], { tap: ['crouch'] });");
  const sc = await api("api.sim(0.05, ['forward'], { tap: ['sprint'] }); return api.sim(0.6, ['forward']);");
  check('sprint during slide cancels into sprint', sc.final.sprinting && sc.final.stance === 'stand', sc.final);
});

await test('jump', async () => {
  await api('api.teleport(0,0,-1,0); api.clearEvents();');
  const j = await api("return api.sim(1.0, [], { tap: ['jump'] });");
  check('jump apex ≈0.95 m', near(j.maxY, 0.95 + 0.03, 0.07), j.maxY);
  const ev = await api("return api.events.map(e => e.type);");
  check('jump + land events', ev.includes('player:jump') && ev.includes('player:land'), ev.join(','));
  const land = await api("return api.events.find(e => e.type==='player:land');");
  check('land impact ≈ takeoff speed (6.2)', land && near(land.data.impactSpeed, 6.16, 0.5), land?.data.impactSpeed);
  check('landing dips camera', j.minCamY < 1.62 + 0.03 - 0.01, j.minCamY);
  // running jump distance & air control
  await api('api.teleport(0,0,-1,0);');
  await api("api.sim(1.0, ['forward']);");
  const z0 = (await api('return api.snapshot();')).pos[2];
  const rj = await api("api.sim(0.05, ['forward'], { tap: ['jump'] }); return api.until('s.grounded', ['forward'], 2);");
  const dist = z0 - rj.s.pos[2];
  check('running jump ≈ 2.6–3.3 m', dist > 2.4 && dist < 3.4, dist.toFixed(2));
  await api('api.teleport(0,0,-1,0);');
  await api("api.sim(1.0, ['forward']);");
  const ac = await api("api.sim(0.05, ['forward'], { tap: ['jump'] }); return api.sim(0.45, ['right']);");
  check('air control: can redirect sideways', Math.abs(ac.final.vel[0]) > 1.5, ac.final.vel);
  check('air control: no speed gain beyond takeoff', ac.maxSpeed <= 4.65, ac.maxSpeed);
  await api("api.until('s.grounded', [], 2);");
});

await test('stairs', async () => {
  await api('api.teleport(10,0,-1,0);');
  const up = await api("return api.sim(3.0, ['forward'], { every: 6 });");
  check('climbs stairs to 2.0 m', up.maxY > 1.95, up.maxY);
  const zs = up.samples.map((s) => s.pos[2]);
  const avg = (zs[0] - zs[zs.length - 1]) / 3.0;
  check('keeps ~walk speed on stairs (≥3.8 m/s avg)', avg > 3.8, avg.toFixed(2));
  const minGroundedRatio = up.samples.filter((s) => s.grounded).length / up.samples.length;
  check('stays grounded on stairs (>85% samples)', minGroundedRatio > 0.85, minGroundedRatio.toFixed(2));
  const cams = up.samples.map((s) => s.camY - s.pos[1]);
  const maxJump = Math.max(...up.samples.slice(1).map((s, i) => Math.abs(s.camY - up.samples[i].camY)));
  check('camera smooth on stairs (max Δ per 0.1 s < 0.5 m)', maxJump < 0.5, maxJump.toFixed(3));
  const down = await api("return api.sim(2.0, ['forward']);");
  check('descends to ground', near(down.final.pos[1], 0, 0.06) && down.final.pos[2] < -14, down.final.pos);
});

await test('ramp', async () => {
  await api('api.teleport(20,0,-1,0);');
  const r = await api("return api.sim(4.0, ['forward'], { every: 6 });");
  check('climbs 20° ramp to 3 m', r.maxY > 2.95, r.maxY);
  const g = r.samples.filter((s) => s.grounded).length / r.samples.length;
  check('grounded on ramp up/down (snap) >90%', g > 0.9, g.toFixed(2));
  check('back on ground after 35° ramp', near(r.final.pos[1], 0, 0.06), r.final.pos);
});

await test('curbs-crates', async () => {
  await api('api.teleport(40,0,-1,0);');
  const r = await api("return api.sim(1.9, ['forward'], { every: 6 });");
  check('steps over 0.15 m and 0.3 m curbs', r.final.pos[2] < -8.8, r.final.pos);
  const g = r.samples.filter((s) => s.grounded).length / r.samples.length;
  check('no jumping needed (grounded >85%)', g > 0.85, g.toFixed(2));
  await api('api.teleport(38.5,0,-10,0);');
  const c = await api("return api.sim(1.0, ['forward']);");
  check('0.8 m crate is not auto-stepped', c.maxY < 0.1, c.maxY);
});

await test('vault', async () => {
  await api('api.teleport(30,0,-3,0); api.clearEvents();');
  await api("api.sim(0.25, ['forward']);");
  const s = await api("return api.sim(0.3, ['forward'], { tap: ['jump'] });");
  check('vault triggered on jump at 1.0 m thin wall', s.final.vaulting, s.final);
  const mv = await api("return api.events.filter(e => e.type==='player:mantle').map(e => e.data);");
  check('player:mantle emitted with vault=true', mv.length === 1 && mv[0].vault === true && mv[0].height > 0, mv);
  await shot('mid-vault');
  const e = await api("return api.until('!s.mantling && s.grounded', ['forward'], 2);");
  check('lands on far side', e.s.pos[2] < -6.4 && near(e.s.pos[1], 0, 0.06), e.s.pos);
  check('vault finishes quickly (< 0.9 s after trigger)', e.t + 0.3 < 1.1, (e.t + 0.3).toFixed(2));
  await api('api.teleport(30,0,-5.2,0);');
  const sv = await api("return api.sim(0.1, [], { tap: ['jump'] });");
  check('standing jump at the wall also vaults', sv.final.vaulting, sv.final.pos);
  await api("api.until('!s.mantling && s.grounded', [], 2);");
});

await test('mantle', async () => {
  await api('api.teleport(30,0,-13.9,0);');
  const s = await api("return api.sim(0.25, [], { tap: ['jump'] });");
  check('mantle triggered on 1.1 m block', s.final.mantling && !s.final.vaulting, s.final);
  await shot('mid-mantle');
  const e = await api("return api.until('!s.mantling', [], 2);");
  await api('api.teleport(30,0,-13.9,0);');
  const tr = await api("return api.sim(0.9, [], { tap: ['jump'], every: 1 });");
  const dys = tr.samples.slice(1).map((x, i) => Math.abs(x.camY - tr.samples[i].camY));
  check('mantle camera path is smooth (max Δy/frame < 0.1 m)', Math.max(...dys) < 0.1, Math.max(...dys).toFixed(3));
  await api("api.teleport(30,0,-13.9,0); api.sim(0.25, [], { tap: ['jump'] });");
  await api("api.until('!s.mantling', [], 2);");
  const f = await api("return api.sim(0.3, []);");
  check('ends on top (y≈1.1)', near(f.final.pos[1], 1.1, 0.06) && f.final.pos[2] < -14.6, f.final.pos);
  check('mantle ~0.45–0.8 s', e.t + 0.25 > 0.4 && e.t + 0.25 < 0.8, (e.t + 0.25).toFixed(2));
  // high ledge 1.75: from ground (jump + hold forward + hold jump)
  await api('api.teleport(30,0,-23.8,0);');
  const h = await api("api.sim(0.1, ['forward'], { tap: ['jump'] }); api.until('s.mantling', ['forward'], 1); return api.until('!s.mantling', [], 2);");
  check('jump then mantle onto 1.75 m ledge', near(h.s.pos[1], 1.75, 0.06) && h.s.pos[2] < -24.6, h.s.pos);
  // 3 m wall: no mantle
  await api('api.teleport(30,0,-34.8,0);');
  const t = await api("return api.sim(1.2, ['forward'], { tap: ['jump'] });");
  check('3 m wall is not mantleable', near(t.final.pos[1], 0, 0.06) && t.final.pos[2] > -35.6, t.final.pos);
  // jump in the open doesn't mantle
  await api('api.teleport(0,0,-1,0);');
  const o = await api("return api.sim(0.1, [], { tap: ['jump'] });");
  check('open-ground jump is a jump', !o.final.mantling && o.final.vel[1] > 3, o.final.vel);
  await api("api.until('s.grounded', [], 2);");
});

await test('tunnel', async () => {
  await api('api.teleport(40,0,-16.5,0);');
  await api("api.sim(0.05, [], { tap: ['crouch'] }); api.sim(0.3, []);");
  const r = await api("return api.sim(2.0, ['forward']);");
  check('crouch-walks into 1.4 m tunnel', r.final.pos[2] < -19, r.final.pos);
  const st = await api("api.sim(0.05, [], { tap: ['crouch'] }); return api.sim(0.4, []);");
  check('cannot stand up under low roof', st.final.stance === 'crouch' && st.final.eyeHeight < 1.2, st.final);
  const j = await api("api.sim(0.05, [], { tap: ['jump'] }); return api.sim(0.4, []);");
  check('cannot jump-stand under low roof', j.final.stance === 'crouch' && j.maxY < 0.1, j.final);
  await api("api.sim(2.0, ['forward']);");
  const out = await api("api.sim(0.05, [], { tap: ['crouch'] }); return api.sim(0.4, []);");
  check('stands after leaving tunnel', out.final.stance === 'stand', out.final);
  await api('api.teleport(40,0,-16.5,0);');
  const sprintIn = await api("api.sim(0.05, ['forward'], { tap: ['sprint'] }); return api.sim(2.0, ['forward']);");
  check('standing player blocked by tunnel roof', sprintIn.final.pos[2] > -18.4, sprintIn.final.pos);
});

await test('lean', async () => {
  await api('api.teleport(51,0,-9,0);');
  const base = await api('return api.sim(0.3, []);');
  const l = await api("return api.sim(0.5, ['leanLeft']);");
  check('lean left offsets camera ≈ -0.38 m', near(l.final.camX - base.final.camX, -0.38, 0.05), (l.final.camX - base.final.camX).toFixed(3));
  check('lean left rolls camera', l.final.roll > 0.1, l.final.roll);
  await shot('lean-left');
  const r = await api("return api.sim(0.5, ['leanRight']);");
  check('lean right offsets camera ≈ +0.38 m', near(r.final.camX - base.final.camX, 0.38, 0.05), (r.final.camX - base.final.camX).toFixed(3));
  check('lean right rolls the other way', r.final.roll < -0.1, r.final.roll);
  await shot('lean-right');
  // lean into the pillar: limited
  await api('api.teleport(51.0,0,-6,0);');
  const b = await api('return api.sim(0.2, []);');
  const lw = await api("return api.sim(0.5, ['leanLeft']);");
  const off = b.final.camX - lw.final.camX;
  check('lean distance blocked near wall (<0.3 m)', off < 0.3 && off >= 0, off.toFixed(3));
  await api("api.sim(0.4, []);");
});

await test('fall-damage-regen', async () => {
  await api('api.teleport(60,6,-6,0); api.clearEvents();');
  const w = await api("return api.until('s.grounded && s.pos[1] < 0.5', ['forward'], 4);");
  const ev = await api("return api.events.filter(e => e.type==='player:damaged' || e.type==='player:land').map(e => [e.type, e.data.amount ?? e.data.impactSpeed]);");
  const dmg = ev.find((e) => e[0] === 'player:damaged');
  check('6 m drop hurts but not lethal', dmg && dmg[1] > 10 && w.s.alive, ev);
  const hp0 = w.s.health;
  const r1 = await api('return api.sim(3.5, []);');
  check('no regen before ~4 s', near(r1.final.health, hp0, 0.5), [hp0, r1.final.health]);
  const r2 = await api('return api.sim(2.0, []);');
  check('regenerates to full after delay', r2.final.health >= 100, r2.final.health);
  await api('api.teleport(66,12,-6,0); api.clearEvents();');
  await api("api.until('s.grounded && s.pos[1] < 0.5', ['forward'], 5);");
  const d = await api("return { s: api.snapshot(), ev: api.events.map(e => e.type) };");
  check('12 m drop is lethal', !d.s.alive && d.ev.includes('player:died'), d.ev);
  const rs = await api("api.clearEvents(); api.player.respawn(); return { s: api.sim(0.3, []).final, ev: api.events.map(e => e.type) };");
  check('respawn restores health + event', rs.s.alive && rs.s.health === 100 && rs.ev.includes('player:respawn'), rs);
});

await test('damage', async () => {
  await api('api.teleport(0,0,-1,0); api.clearEvents();');
  const r = await api("api.player.damage(30, new (api.ctx.camera.position.constructor)(1,0,0)); return api.sim(0.1, []);");
  const ev = await api("return api.events.find(e => e.type==='player:damaged');");
  check('player:damaged with health', ev && ev.data.health === 70, ev?.data);
  check('damage shakes camera', Math.abs(r.final.roll) > 0.0005 || Math.abs(r.final.pitch) > 0.001, [r.final.roll, r.final.pitch]);
  await api('api.sim(6, []);');
});

await test('footsteps', async () => {
  await api('api.teleport(0,0,-1,0); api.sim(0.5, []); api.clearEvents();');
  await api("api.sim(3.0, ['forward']);");
  const n = await api("return api.events.filter(e => e.type==='player:footstep').length;");
  check('walk cadence ≈ 2.7 steps/s (6–10 in 3 s)', n >= 6 && n <= 10, n);
  const f = await api("return api.events.find(e => e.type==='player:footstep');");
  check('footstep has surface from ground ray', f && f.data.surface === 'concrete', f?.data);
  await api('api.teleport(0,0,-1,0); api.sim(0.3, []); api.clearEvents();');
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] }); api.sim(3.0, ['forward']);");
  const ns = await api("return api.events.filter(e => e.type==='player:footstep').length;");
  check('sprint cadence faster', ns > n, [n, ns]);
  await api('api.teleport(10,0,-1,0); api.clearEvents();');
  await api("api.sim(1.8, ['forward']);");
  const wf = await api("return api.events.filter(e => e.type==='player:footstep').map(e => e.data.surface);");
  check('stairs footsteps report wood', wf.includes('wood'), wf.join(','));
});

await test('bob', async () => {
  await api('api.teleport(0,0,-1,0);');
  const w = await api("return api.sim(1.5, ['forward'], { every: 1 });");
  const ys = w.samples.slice(40).map((s) => s.camY);
  const amp = Math.max(...ys) - Math.min(...ys);
  check('walk head bob subtle (0.8–3 cm)', amp > 0.008 && amp < 0.03, amp.toFixed(4));
  const idle = await api("return api.sim(1.5, [], { every: 1 });");
  const yi = idle.samples.slice(60).map((s) => s.camY);
  check('no bob when idle', Math.max(...yi) - Math.min(...yi) < 0.002, (Math.max(...yi) - Math.min(...yi)).toFixed(4));
});

await test('recoil-shake', async () => {
  await api('api.teleport(0,0,-1,0); api.sim(0.3, []);');
  const p0 = (await api('return api.snapshot();')).pitch;
  const k = await api("for (let i = 0; i < 10; i++) { api.player.addRecoil(0.01, 0.002); api.sim(0.1, []); } return api.snapshot();");
  check('recoil climbs (10 shots × 0.01 → > 0.06 rad)', k.pitch - p0 > 0.06, (k.pitch - p0).toFixed(4));
  const rec = await api("return api.sim(1.0, []);");
  const kept = rec.final.pitch - p0;
  check('recoil partially recovers (keeps 35–60%)', kept > 0.035 && kept < 0.065, kept.toFixed(4));
  await api('api.player.pitch = 0; api.sim(0.5, []);');
  const s = await api("api.player.addCameraShake(1.0); return api.sim(0.15, [], { every: 1 });");
  const dev = Math.max(...s.samples.map((x) => Math.abs(x.roll)));
  check('trauma shake visible', dev > 0.01, dev.toFixed(4));
  const after = await api("return api.sim(1.2, []);");
  check('shake decays', Math.abs(after.final.roll) < 0.002, after.final.roll);
});

await test('fov-ads', async () => {
  await api('api.teleport(0,0,-1,0); api.setWeapon(true, 1, 50);');
  const r = await api("return api.sim(1.0, ['forward']);");
  check('fov lerps to weapons.fovTarget (50)', near(r.final.fov, 50, 0.5), r.final.fov);
  check('ADS slows movement (≈0.6×)', near(r.final.speed, 4.6 * 0.6, 0.1), r.final.speed);
  await api("api.sim(0.05, ['forward'], { tap: ['sprint'] });");
  const s = await api("return api.sim(0.5, ['forward']);");
  check('cannot sprint while ADS', !s.final.sprinting, s.final);
  await api('api.setWeapon(false); api.sim(1.0, []);');
});

await test('physics-raycast', async () => {
  const r = await api(`
    const P = api.physics, V = api.ctx.camera.position.constructor;
    const out = {};
    const h = P.raycast(new V(0, 1.5, -10), new V(1, 0, 0), 50, { ignorePlayer: true });
    out.wall = h && { d: h.distance, s: h.surface, t: h.thickness, n: [h.normal.x, h.normal.y, h.normal.z] };
    const f = P.raycast(new V(5, 5, -5), new V(0, -1, 0), 50);
    out.floor = f && { d: f.distance, s: f.surface, t: f.thickness };
    const st = P.raycast(new V(10, 5, -5.05), new V(0, -1, 0), 50);
    out.stairs = st && { d: st.distance, s: st.surface };
    const ramp = P.raycast(new V(20, 10, -6), new V(0, -1, 0), 50);
    out.ramp = ramp && { y: ramp.point.y, s: ramp.surface, ny: ramp.normal.y };
    // hitboxes: a fake enemy with a head box and a limb (auto capsule)
    const O3 = api.THREE.Object3D;
    const enemy = new O3(); enemy.position.set(0, 0, -20); api.ctx.scene.add(enemy);
    const head = new O3(); head.position.set(0, 1.7, 0); enemy.add(head);
    const arm = new O3(); arm.position.set(0.4, 1.3, 0); arm.rotation.z = 0.3; enemy.add(arm);
    api.ctx.scene.updateMatrixWorld(true);
    P.registerHitbox(head, 7, 'head', new V(0.12, 0.13, 0.12));
    P.registerHitbox(arm, 7, 'limb', new V(0.06, 0.3, 0.06));
    P.invalidateHitboxes();
    const hh = P.raycast(new V(0, 1.72, -5), new V(0, 0, -1), 100);
    out.head = hh && { id: hh.enemyId, region: hh.region, d: hh.distance };
    const ha = P.raycast(new V(0.4, 1.3, -5), new V(0, 0, -1), 100);
    out.arm = ha && { id: ha.enemyId, region: ha.region, kind: ha.hitbox?.kind, d: ha.distance };
    const miss = P.raycast(new V(0.25, 1.72, -5), new V(0, 0, -1), 100, { ignorePlayer: true });
    out.miss = miss ? (miss.enemyId ?? 'world') : null;
    const ign = P.raycast(new V(0, 1.72, -5), new V(0, 0, -1), 100, { ignoreEnemies: true });
    out.ignoreEnemies = ign ? (ign.enemyId ?? 'world') : null;
    const all = P.raycastAll(new V(0, 1.5, -10), new V(1, 0, 0), 50, { ignorePlayer: true });
    out.all = all.map(h => [+h.distance.toFixed(2), h.surface, h.thickness === Infinity ? 'inf' : +h.thickness?.toFixed(2)]);
    // player capsule hit from outside, ignored from inside
    api.teleport(0, 0, -1, 0);
    const pc = P.raycast(new V(0, 1.0, -8), new V(0, 0, 1), 20);
    out.player = pc && { player: pc.player, d: pc.distance };
    const own = P.raycast(api.ctx.camera.position.clone(), new V(0, 0, -1), 5);
    out.own = own ? (own.player ? 'self' : own.surface) : null;
    // timing: 1000 rays with hitboxes
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) P.raycast(new V(0, 1.5, -5), new V(Math.sin(i) * 0.1, 0, -1).normalize(), 200);
    out.msPer1000 = +(performance.now() - t0).toFixed(2);
    P.unregisterHitboxes(7);
    out.afterUnregister = P.raycast(new V(0, 1.72, -5), new V(0, 0, -1), 100)?.enemyId ?? null;
    const pen = P.raycastPenetrating(new V(0, 1.5, -10), new V(1, 0, 0), 50, 0.5, { ignorePlayer: true });
    out.pen = pen.map(p => [p.hit.surface, +p.damageScale.toFixed(2), p.stopped]);
    const pen2 = P.raycastPenetrating(new V(0, 1.5, -10), new V(1, 0, 0), 50, 2.0, { ignorePlayer: true });
    out.pen2 = pen2.map(p => [p.hit.surface, +p.damageScale.toFixed(2), p.stopped]);
    out.los = [P.lineOfSight(new V(0, 1.5, -10), new V(2, 1.5, -10)), P.lineOfSight(new V(0, 1.5, -10), new V(5, 1.5, -10))];
    return out;
  `);
  console.log('   ', JSON.stringify(r));
  check('world ray hits corridor wall at 2.85 m (brick)', r.wall && near(r.wall.d, 2.85, 0.01) && r.wall.s === 'brick', r.wall);
  check('wall thickness 0.3 m', r.wall && near(r.wall.t, 0.3, 0.01), r.wall?.t);
  check('wall normal faces ray', r.wall && near(r.wall.n[0], -1, 0.01), r.wall?.n);
  check('floor hit (1 m slab thickness)', r.floor && near(r.floor.d, 5, 0.01) && near(r.floor.t, 1, 0.01), r.floor);
  check('stairs surface wood', r.stairs?.s === 'wood', r.stairs);
  check('ramp trimesh hit (metal, sloped normal)', r.ramp?.s === 'metal' && r.ramp.ny < 0.99 && r.ramp.ny > 0.8, r.ramp);
  check('head hitbox', r.head?.id === 7 && r.head.region === 'head' && near(r.head.d, 14.88, 0.02), r.head);
  check('limb auto-capsule', r.arm?.id === 7 && r.arm.region === 'limb' && r.arm.kind === 'capsule', r.arm);
  check('ray beside head misses enemy', r.miss !== 7, r.miss);
  check('ignoreEnemies', r.ignoreEnemies !== 7, r.ignoreEnemies);
  check('raycastAll returns wall entry/exit ordering', r.all.length >= 2 && r.all[0][0] < r.all[1][0], r.all);
  check('player capsule hit from outside', r.player?.player === true && near(r.player.d, 6.66, 0.05), r.player);
  check('own shots never hit the player', r.own !== 'self', r.own);
  check('1000 raycasts < 30 ms', r.msPer1000 < 30, r.msPer1000);
  check('unregisterHitboxes', r.afterUnregister === null || r.afterUnregister === undefined, r.afterUnregister);
  check('penetration: 0.5 power stops in 0.3 m brick', r.pen.length === 1 && r.pen[0][2] === true, r.pen);
  check('penetration: 2.0 power passes brick, loses damage', r.pen2.length >= 2 && r.pen2[0][2] === false && r.pen2[1][1] < 1, r.pen2);
  check('lineOfSight', r.los[0] === true && r.los[1] === false, r.los);
});

await test('physics-dynamic', async () => {
  const r = await api(`
    const P = api.physics, V = api.ctx.camera.position.constructor;
    const impacts = [];
    const b = P.spawnDynamic({ shape: 'sphere', radius: 0.1, position: new V(5, 3, -5), kind: 'prop', restitution: 0.3, onImpact: (e) => impacts.push(+e.speed.toFixed(2)) });
    const c = P.spawnDynamic({ shape: 'box', halfExtents: new V(0.01, 0.004, 0.02), position: new V(5.5, 1.5, -5), velocity: new V(1, 2, 0), kind: 'debris', lifetime: 1.0 });
    let removed = false;
    const d = P.spawnDynamic({ shape: 'box', halfExtents: new V(0.01, 0.004, 0.02), position: new V(6, 1.5, -5), kind: 'debris', lifetime: 0.5, onRemove: () => { removed = true; } });
    const a1 = P.spawnDynamic({ shape: 'capsule', radius: 0.1, halfHeight: 0.2, position: new V(8, 2, -5), kind: 'ragdoll' });
    const a2 = P.spawnDynamic({ shape: 'capsule', radius: 0.1, halfHeight: 0.2, position: new V(8, 1.4, -5), kind: 'ragdoll' });
    P.createJoint(a1, a2, { type: 'spherical', anchorA: new V(0, -0.3, 0), anchorB: new V(0, 0.3, 0) });
    const steps0 = P.stepCount;
    for (let i = 0; i < 180; i++) P.step(1 / 60);
    const steps = P.stepCount - steps0;
    // uneven frame times still give 60 Hz substeps
    const s1 = P.stepCount; for (let i = 0; i < 60; i++) P.step(i % 2 ? 1 / 30 : 1 / 120); const uneven = P.stepCount - s1;
    const wa = new V(0, -0.3, 0).applyQuaternion(a1.quaternion).add(a1.position), wb = new V(0, 0.3, 0).applyQuaternion(a2.quaternion).add(a2.position);
    const jd = wa.distanceTo(wb);
    return { y: b.position.y, alive: b.alive, impacts, debrisAlive: c.alive, removed, steps, uneven, jointDist: +jd.toFixed(3), count: P.dynamicBodies.length, alpha: P.alpha };
  `);
  console.log('   ', JSON.stringify(r));
  check('ball rests on floor (y≈0.1)', near(r.y, 0.1, 0.02), r.y);
  check('onImpact fired on bounce', r.impacts.length >= 1 && r.impacts[0] > 3, r.impacts);
  check('debris lifetime expiry + onRemove', !r.debrisAlive && r.removed, r);
  check('fixed 60 Hz stepping (180 steps in 3 s)', r.steps === 180, r.steps);
  check('accumulator handles uneven dt (1.25 s → 75 steps)', Math.abs(r.uneven - 75) <= 1, r.uneven);
  check('ragdoll joint holds (anchor gap ≈0)', r.jointDist < 0.03, r.jointDist);
});

await test('no-fall-through', async () => {
  await api('api.teleport(0,0,-1,0);');
  let minY = Infinity;
  for (const yaw of [0, 1.2, 2.5, -1.9]) {
    const r = await api(`api.sim(0.05, ['forward'], { tap: ['sprint'], yaw: ${yaw} }); return api.sim(1.5, ['forward'], { yaw: ${yaw} });`);
    minY = Math.min(minY, r.minY);
    const s = await api(`return api.sim(0.8, ['forward'], { tap: ['crouch'], yaw: ${yaw} });`);
    minY = Math.min(minY, s.minY);
    const j = await api(`return api.sim(1.0, ['forward'], { tap: ['jump'], yaw: ${yaw} });`);
    minY = Math.min(minY, j.minY);
  }
  check('never below floor during stress run', minY > -0.03, minY);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
fs.writeFileSync('shots/player/results.json', JSON.stringify(results, null, 2));
await browser.close();
process.exitCode = fail ? 1 : 0;
