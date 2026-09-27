import * as THREE from 'three';
import { mk } from './builder';
import type { WCtx } from './context';
import { RNG } from './rng';
import { building, type BSpec, type Face, type DoorSpec, BASE, FH } from './buildings';
import {
  Frame, fb, fg, coverSides, crate, crateStack, pallet, palletStack, barrel, barrelGroup, gasCylinder, tire, tireStack, jersey,
  sandbagWall, sandbagNest, hesco, rubble, debris, trashBags, cardboard, cinderStack, acUnit, waterTank, genset, dumpster,
  container, fenceCorrugated, table, chair, clothesline, hangCloth, streetLight, powerPole, cable, sacks,
} from './props';
import { pickup, sedan } from './vehicles';
import { palm, shrub, planter } from './vegetation';
import { pad, softGround, sidewalk, roadDressingZ, sandDrift, manhole, outerTerrain } from './ground';
import { horizon } from './horizon';
import { cylBetween, paint } from './geo';
import { D } from './textures';

/**
 * "Old Town" — compact 3-lane map (~104 x 132 m playable).
 *   West lane : zig-zag back alley (x -32..-19) with tight corners and exterior stairs.
 *   Centre    : main market street (x -7..7) opening into a market plaza (x -14..14, z -12..12).
 *   East lane : service road (x 19..26) + walled compound with courtyard, house and roof access.
 *   Spawns    : south street (player, z ~ +62) and north street (enemy, z ~ -62).
 * North = -Z. Ground level y = 0, sidewalks/plaza/floors y = 0.15, storey 3.2 m.
 */
export const BOUNDS = { x0: -46, x1: 54, z0: -66, z1: 66 };

type Opt = {
  enter?: boolean; upper?: boolean; shops?: Face[]; blank?: Face[];
  doors?: { f: Face; at: number; w?: number; kind?: DoorSpec['kind'] }[];
  stairs?: { kind: 'interior' } | { kind: 'exterior'; f: Face; at: number; dir: 1 | -1 };
  balconies?: { f: Face; floor: number; at: number; w?: number }[];
  parapet?: BSpec['parapet']; roofProps?: boolean; simple?: boolean;
};

function uOf(x0: number, z0: number, x1: number, z1: number, f: Face, at: number) {
  return f === 's' ? at - x0 : f === 'n' ? x1 - at : f === 'e' ? z1 - at : at - z0;
}

function B(w: WCtx, x0: number, z0: number, x1: number, z1: number, floors: number, style: BSpec['style'], seed: number, o: Opt = {}) {
  const spec: BSpec = {
    x0, z0, x1, z1, floors, style, seed,
    enter: o.enter, upper: o.upper, shops: o.shops, blank: o.blank, parapet: o.parapet, roofProps: o.roofProps, simple: o.simple,
    doors: o.doors?.map((d) => ({ f: d.f, u: uOf(x0, z0, x1, z1, d.f, d.at), w: d.w, kind: d.kind })),
    balconies: o.balconies?.map((b) => ({ f: b.f, floor: b.floor, u: uOf(x0, z0, x1, z1, b.f, b.at), w: b.w })),
  };
  if (o.stairs?.kind === 'interior') spec.stairs = { kind: 'interior' };
  else if (o.stairs?.kind === 'exterior') {
    const s = o.stairs;
    spec.stairs = { kind: 'exterior', f: s.f, u0: uOf(x0, z0, x1, z1, s.f, s.at), dir: (s.f === 's' || s.f === 'w' ? s.dir : -s.dir) as 1 | -1 };
  }
  building(w, spec);
}

export function buildMap(w: WCtx) {
  const rng = w.rng;
  const R = (salt: number) => rng.fork(salt);

  // ------------------------------------------------------------------ ground
  outerTerrain(w);
  softGround(w, mk('dirt', 0), BOUNDS.x0 - 16, BOUNDS.z0 - 16, BOUNDS.x1 + 16, BOUNDS.z1 + 16, 0.0, 0.06, 3);
  // main street asphalt
  pad(w, mk('asphalt', 0), -4.5, -66, 4.5, -12, 0.012);
  pad(w, mk('asphalt', 1), -4.5, 12, 4.5, 66, 0.012);
  // cross + spawn streets
  pad(w, mk('asphalt', 2), -19, -34, 19, -28, 0.012);
  pad(w, mk('asphalt', 2), -19, 28, 19, 34, 0.012);
  pad(w, mk('asphalt', 1), -19, 58, 19, 66, 0.012);
  pad(w, mk('asphalt', 0), -19, -66, 19, -58, 0.012);
  // alley + service road paving (cracked concrete) and dirt lots
  pad(w, mk('concrete_dirty', 2), -25, -58, -19, -15, 0.02);
  pad(w, mk('concrete_dirty', 3), -25, 15, -19, 58, 0.02);
  pad(w, mk('concrete_dirty', 1), -32, -15, -26, 15, 0.02);
  pad(w, mk('concrete_dirty', 2), -32, -15, -19, -12, 0.02);
  pad(w, mk('concrete_dirty', 2), -32, 12, -19, 15, 0.02);
  softGround(w, mk('gravel', 1), 19.2, -58, 25.8, 58, 0.02, 0.05, 11);
  softGround(w, mk('sand', 2), 26.5, -19.5, 51.5, 19.5, 0.02, 0.1, 12);
  pad(w, mk('concrete_floor', 2), 20, -2, 26, 2, 0.03);
  const up = new THREE.Vector3(0, 1, 0);
  roadDressingZ(w, -4.5, 4.5, -66, -12, R(1));
  roadDressingZ(w, -4.5, 4.5, 12, 66, R(2));
  for (const [z0, z1] of [[-34, -28], [28, 34], [58, 66], [-66, -58]] as const) {
    const r = R(z0 + 200);
    for (let i = 0; i < 16; i++) w.decal(r.pick([D.CRACKS, D.OIL, D.DIRT, D.SAND, D.SAND]), new THREE.Vector3(r.range(-18, 18), 0.012, r.range(z0 + 0.5, z1 - 0.5)), up, r.range(1.5, 3.5), r.range(1.5, 3.5), r.range(0, 6), 0.004);
    manhole(w, r.range(-15, -8), (z0 + z1) / 2, r);
    // sand spill where asphalt ends
    for (const ex of [-19, 19]) for (let k = 0; k < 3; k++) w.decal(D.SAND, new THREE.Vector3(ex + r.jit(1.5), 0.02, r.range(z0 + 1, z1 - 1)), up, r.range(2, 4), r.range(2, 4), r.range(0, 6), 0.006);
  }
  // crosswalks at plaza entrances
  for (const zc of [-14.2, 14.2]) for (let i = 0; i < 7; i++) w.decal(D.LINE, new THREE.Vector3(-3.6 + i * 1.2, 0.012, zc), up, 0.55, 2.6, 0, 0.004);
  // sidewalks along main street blocks
  for (const [z0, z1] of [[-58, -34], [-28, -12], [12, 28], [34, 58]] as const) {
    sidewalk(w, -7, z0, -4.5, z1, 'x1', R(z0 + 7));
    sidewalk(w, 4.5, z0, 7, z1, 'x0', R(z0 + 9));
  }
  // plaza
  plaza(w, R(3));

  // ------------------------------------------------------------------ buildings
  // South block (player side)
  B(w, -19, 46, -7, 58, 3, 'plaster', 101, { enter: true, shops: ['e'], doors: [{ f: 's', at: -13 }, { f: 'w', at: 52 }], blank: ['n'], balconies: [{ f: 'e', floor: 2, at: 52 }] });
  B(w, -19, 34, -7, 46, 2, 'brick', 102, { enter: true, shops: ['e'], doors: [{ f: 'n', at: -12 }, { f: 'w', at: 40 }], blank: ['s'], parapet: 'rebar' });
  B(w, -44, 46, -25, 58, 3, 'concrete', 103, { doors: [{ f: 'e', at: 52 }], blank: ['w', 'n'], shops: ['s'] });
  B(w, -44, 34, -25, 46, 2, 'plaster', 104, { enter: true, doors: [{ f: 'e', at: 40 }, { f: 'n', at: -42.5 }], blank: ['w', 's'], stairs: { kind: 'exterior', f: 'n', at: -27.2, dir: -1 }, roofProps: true, parapet: 'plain' });
  B(w, 7, 46, 19, 58, 3, 'plaster', 105, { enter: true, shops: ['w'], doors: [{ f: 's', at: 13 }, { f: 'e', at: 50 }], blank: ['n'], parapet: 'stepped' });
  B(w, 7, 34, 19, 46, 2, 'concrete', 106, { shops: ['w'], blank: ['s'], balconies: [{ f: 'w', floor: 1, at: 40 }], doors: [{ f: 'e', at: 40 }] });
  B(w, 26, 46, 52, 58, 3, 'brick', 107, { doors: [{ f: 'w', at: 52 }], blank: ['e'], shops: ['s'] });
  B(w, 26, 34, 40, 46, 2, 'plaster', 108, { enter: true, doors: [{ f: 'w', at: 40 }, { f: 'n', at: 33 }, { f: 'e', at: 38 }], blank: ['s'], parapet: 'low' });

  // South-mid
  B(w, -19, 12, -7, 28, 2, 'plaster', 201, { enter: true, upper: true, stairs: { kind: 'interior' }, shops: ['e'], doors: [{ f: 'n', at: -10.5, kind: 'double' }, { f: 'w', at: 22 }, { f: 's', at: -14 }], balconies: [{ f: 'e', floor: 1, at: 20 }] });
  B(w, -44, 15, -25, 28, 3, 'brick', 202, { doors: [{ f: 'e', at: 22 }, { f: 's', at: -33 }], blank: ['w'] });
  B(w, 7, 12, 19, 28, 2, 'brick', 203, { enter: true, shops: ['w'], doors: [{ f: 'n', at: 12.5 }, { f: 'e', at: 17 }, { f: 's', at: 11 }], stairs: { kind: 'exterior', f: 'e', at: 26.6, dir: -1 }, roofProps: true, parapet: 'plain' });

  // Plaza band
  B(w, -26, -12, -14, -1, 2, 'plaster', 301, { enter: true, doors: [{ f: 'e', at: -6.5, kind: 'double' }, { f: 'w', at: -5 }, { f: 's', at: -20.5 }], balconies: [{ f: 'e', floor: 1, at: -6.5 }], parapet: 'stepped' });
  B(w, -26, 1.5, -14, 12, 3, 'concrete', 302, { enter: true, shops: ['e'], doors: [{ f: 'n', at: -17.5 }, { f: 'w', at: 8 }] });
  B(w, -44, -15, -32, 0, 2, 'plaster', 303, { enter: true, doors: [{ f: 'e', at: -14.1 }], blank: ['w', 'n', 's'], stairs: { kind: 'exterior', f: 'e', at: -1.0, dir: -1 }, roofProps: true, parapet: 'plain' });
  B(w, -44, 0, -32, 15, 3, 'brick', 304, { doors: [{ f: 'e', at: 7 }], blank: ['w', 's', 'n'] });
  B(w, 14, -12, 20, -2, 2, 'plaster', 305, { enter: true, shops: ['w'], doors: [{ f: 'e', at: -7 }], parapet: 'stepped' });
  B(w, 14, 2, 20, 12, 2, 'brick', 306, { enter: true, shops: ['w'], doors: [{ f: 'e', at: 7 }] });

  // North-mid
  B(w, -19, -28, -7, -12, 3, 'plaster', 401, { enter: true, shops: ['e'], doors: [{ f: 's', at: -11 }, { f: 'w', at: -22 }, { f: 'n', at: -14 }] });
  B(w, -44, -28, -25, -15, 2, 'brick', 402, { doors: [{ f: 'e', at: -20 }, { f: 'n', at: -35 }], blank: ['w'], parapet: 'rebar' });
  B(w, 7, -28, 19, -12, 2, 'plaster', 403, { enter: true, upper: true, stairs: { kind: 'interior' }, shops: ['w'], doors: [{ f: 's', at: 12.5, kind: 'double' }, { f: 'e', at: -20 }, { f: 'n', at: 15 }], balconies: [{ f: 'w', floor: 1, at: -22 }] });

  // North block (enemy side)
  B(w, -19, -58, -7, -47, 3, 'brick', 501, { shops: ['e'], blank: ['s'], doors: [{ f: 'n', at: -13 }] });
  B(w, -19, -47, -7, -34, 2, 'plaster', 502, { enter: true, shops: ['e'], doors: [{ f: 'w', at: -40 }, { f: 's', at: -13 }], blank: ['n'], balconies: [{ f: 'e', floor: 1, at: -40 }] });
  B(w, -44, -58, -25, -46, 3, 'plaster', 503, { doors: [{ f: 'e', at: -52 }], blank: ['w', 's'], shops: ['n'] });
  B(w, -44, -46, -25, -34, 2, 'concrete', 504, { enter: true, doors: [{ f: 'e', at: -40 }, { f: 's', at: -42.5 }], blank: ['w', 'n'], stairs: { kind: 'exterior', f: 's', at: -27.2, dir: -1 }, roofProps: true, parapet: 'plain' });
  B(w, 7, -58, 19, -46, 3, 'concrete', 505, { enter: true, shops: ['w'], doors: [{ f: 'n', at: 13 }, { f: 'e', at: -52 }], blank: ['s'], parapet: 'stepped' });
  B(w, 7, -46, 19, -34, 2, 'brick', 506, { shops: ['w'], doors: [{ f: 'e', at: -40 }], blank: ['n'] });
  B(w, 26, -58, 52, -46, 2, 'brick', 507, { doors: [{ f: 'w', at: -52 }], blank: ['e', 's'], shops: ['n'], parapet: 'rebar' });
  B(w, 26, -46, 40, -34, 3, 'plaster', 508, { enter: true, doors: [{ f: 'w', at: -40 }, { f: 's', at: 33 }, { f: 'e', at: -38 }], blank: ['n'] });

  compound(w, R(4));
  backdrop(w, R(5));

  // ------------------------------------------------------------------ dressing per lane
  mainStreet(w, R(6));
  alley(w, R(7));
  serviceRoad(w, R(8));
  crossStreets(w, R(9));
  spawns(w, R(10));
  utilities(w, R(11));
  horizon(w, R(12));

  // ------------------------------------------------------------------ boundary (invisible)
  const H = 60;
  w.b.colBox((BOUNDS.x0 + BOUNDS.x1) / 2, H / 2, BOUNDS.z0 - 0.5, BOUNDS.x1 - BOUNDS.x0 + 2, H, 1, 'concrete');
  w.b.colBox((BOUNDS.x0 + BOUNDS.x1) / 2, H / 2, BOUNDS.z1 + 0.5, BOUNDS.x1 - BOUNDS.x0 + 2, H, 1, 'concrete');
  w.b.colBox(BOUNDS.x0 - 0.5, H / 2, 0, 1, H, BOUNDS.z1 - BOUNDS.z0 + 2, 'concrete');
  w.b.colBox(BOUNDS.x1 + 0.5, H / 2, 0, 1, H, BOUNDS.z1 - BOUNDS.z0 + 2, 'concrete');

  // ------------------------------------------------------------------ enemy spawns (ground + reachable roofs)
  const roof2 = BASE + 2 * FH;
  const es: [number, number, number][] = [
    [-2, 0, -62], [10, 0, -61], [-12, 0, -62], [-22, 0.02, -40], [-30, 0, -31], [22.5, 0.02, -40], [33, 0, -30],
    [45, 0.02, -16], [-37, roof2, -6], [13, roof2, 20], [46, roof2, -2], [12, BASE + FH, -18],
  ];
  for (const [x, y, z] of es) w.enemySpawns.push(new THREE.Vector3(x, y, z));
}

// ====================================================================== plaza
function plaza(w: WCtx, rng: RNG) {
  const up = new THREE.Vector3(0, 1, 0);
  // raised paved square (y 0.15) with border band
  w.b.boxMM(mk('tile_floor', 1), -14, -0.05, -12, 14, BASE, 12);
  w.b.colBox(0, (BASE - 0.05) / 2, 0, 28, BASE + 0.05, 24, 'tile');
  w.ground.push({ x0: -14, z0: -12, x1: 14, z1: 12, h: BASE });
  for (const z of [-12, 12]) {
    for (let i = 0; i < 28; i++) w.b.box(i % 2 ? mk('concrete', 1) : mk('concrete_dirty', 1), -13.5 + i, BASE / 2 - 0.02, z - Math.sign(z) * 0.1, 0.99, BASE + 0.07, 0.2);
  }
  // inner paving field in a different material
  w.b.boxMM(mk('concrete_floor', 1), -9, BASE, -7, 9, BASE + 0.01, 7);
  for (let i = 0; i < 30; i++) w.decal(rng.pick([D.DIRT, D.SAND, D.CRACKS, D.OIL, D.PAPERS, D.DIRT]), new THREE.Vector3(rng.range(-13, 13), BASE + 0.01, rng.range(-11, 11)), up, rng.range(1.2, 3.5), rng.range(1.2, 3.5), rng.range(0, 6), 0.006);
  // monument / dry fountain (central hard cover)
  fountain(w, 0, BASE, 0, rng);
  // palms in planters at corners
  planter(w, -11.5, BASE, -9.5, rng, true);
  planter(w, 11.3, BASE, 9.2, rng, true);
  planter(w, 11.2, BASE, -9.4, rng, false);
  planter(w, -11.2, BASE, 9.6, rng, true);
  // market stalls — west row facing east, east row facing west
  for (const [x, z, ry] of [[-9.5, -5, Math.PI / 2], [-9.5, -1.8, Math.PI / 2], [-9.5, 4.2, Math.PI / 2], [9.6, -4.5, -Math.PI / 2], [9.6, 1.5, -Math.PI / 2], [9.6, 4.7, -Math.PI / 2]] as const) stall(w, x, BASE, z, ry, rng);
  // burned car across the plaza (mid cover)
  sedan(w, -4.2, BASE, 6.8, 0.35, rng, true);
  // cafe tables near WC2 shops
  for (const [x, z] of [[-12.3, 8.4], [-12.4, 6.1]] as const) {
    table(w, x, BASE, z, rng.range(0, 1), rng, 0.8, 0.8);
    chair(w, x + 0.7, BASE, z + 0.2, -1.5 + rng.jit(0.4), rng);
    chair(w, x - 0.2, BASE, z - 0.7, 0.2 + rng.jit(0.4), rng);
  }
  // crates, barrels, sandbags for cover rhythm
  crateStack(w, 4.2, BASE, -8.6, 0.2, rng, true);
  sandbagWall(w, 5.8, BASE, 7.6, 0.1, 3.2, 6, rng, 0.35);
  barrelGroup(w, -6.3, BASE, -9.3, rng);
  jersey(w, 2.5, 0.0, 13.2, 0.05, 3, 1);
  jersey(w, -2.4, 0.0, -13.3, -0.08, 3, 2);
  pallet(w, 6.9, BASE, -2.2, 0.3, 1);
  palletStack(w, 7.2, BASE, -0.4, 1.3, 3, rng);
  cardboard(w, 6.5, BASE, 2.5, rng, 4);
  trashBags(w, 13, BASE, -0.6, 3, rng);
  debris(w, -1, BASE, -4, 5, 14, rng);
  // bollards at road entries
  for (const zc of [-12.4, 12.4]) for (let i = 0; i < 5; i++) {
    const g = new THREE.CylinderGeometry(0.1, 0.12, 0.85, 10);
    w.b.addT(mk('concrete', 2), g, -3.6 + i * 1.8, BASE + 0.425, zc, 0);
    w.b.colBox(-3.6 + i * 1.8, BASE + 0.425, zc, 0.24, 0.85, 0.24, 'concrete');
  }
  // lamp posts in plaza
  streetLight(w, -13.3, BASE, -2.5, 0);
  streetLight(w, 13.3, BASE, -1.0, Math.PI);
}

function fountain(w: WCtx, x: number, y: number, z: number, rng: RNG) {
  const n = 8, R0 = 2.6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const L = 2 * R0 * Math.tan(Math.PI / n) + 0.05;
    w.b.box(mk('concrete', 1), x + Math.cos(a) * R0, y + 0.35, z + Math.sin(a) * R0, 0.4, 0.7, L, { ry: -a, col: true });
    w.b.box(mk('plaster_white', 2), x + Math.cos(a) * R0, y + 0.73, z + Math.sin(a) * R0, 0.55, 0.07, L + 0.1, { ry: -a });
    const cp = new THREE.Vector3(x + Math.cos(a + Math.PI / n) * (R0 + 0.8), y, z + Math.sin(a + Math.PI / n) * (R0 + 0.8));
    w.addCover(cp.x, y, cp.z, Math.cos(a + Math.PI / n), Math.sin(a + Math.PI / n));
  }
  // basin filled with sand & junk
  w.b.box(mk('sand', 2), x, y + 0.12, z, R0 * 1.8, 0.2, R0 * 1.8, { ry: Math.PI / 8 });
  // pedestal + damaged obelisk
  w.b.box(mk('concrete', 3), x, y + 0.6, z, 1.4, 1.2, 1.4, { col: true });
  w.b.box(mk('plaster_white', 1), x, y + 1.25, z, 1.55, 0.1, 1.55);
  w.b.box(mk('concrete', 0), x, y + 2.9, z, 0.7, 3.2, 0.7, { col: true, ry: 0.02 });
  w.b.box(mk('concrete', 2), x + 0.05, y + 4.55, z, 0.55, 0.3, 0.55, { rz: 0.15, ry: 0.4 });
  w.decal(D.BULLETS, new THREE.Vector3(x, y + 2.8, z + 0.35), new THREE.Vector3(0, 0, 1), 0.8, 1.2, 0, 0.004);
  w.decal(D.GRAFFITI_B, new THREE.Vector3(x - 0.72, y + 0.65, z), new THREE.Vector3(-1, 0, 0), 1.2, 1.1, 0, 0.004);
  rubble(w, x + 1.6, y + 0.2, z - 1.2, 0.7, rng, true, false);
  debris(w, x, y + 0.22, z, 1.8, 8, rng);
}

/** Market stall: timber frame, counter with produce crates, fluttering tarp roof. */
function stall(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG) {
  const f = new Frame(x, y, z, ry);
  const W = rng.range(2.4, 3.0), Dp = 1.9;
  const post = mk('wood_planks', rng.int(0, 3));
  const hf = 2.45, hb = 2.15;
  for (const sx of [-1, 1]) {
    fb(w, f, post, sx * (W / 2 - 0.05), hf / 2, Dp / 2 - 0.05, 0.08, hf, 0.08, true);
    fb(w, f, post, sx * (W / 2 - 0.05), hb / 2, -Dp / 2 + 0.05, 0.08, hb, 0.08, true);
    fb(w, f, post, sx * (W / 2 - 0.05), (hf + hb) / 2 - 0.03, 0, 0.06, 0.06, Dp, false, Math.atan2(hf - hb, Dp));
  }
  fb(w, f, post, 0, hf - 0.03, Dp / 2 - 0.05, W, 0.07, 0.07);
  fb(w, f, post, 0, hb - 0.03, -Dp / 2 + 0.05, W, 0.07, 0.07);
  // counter (front)
  const ctr = mk(rng.chance(0.5) ? 'wood_pallet' : 'plywood', rng.int(0, 3));
  fb(w, f, ctr, 0, 0.84, Dp / 2 - 0.45, W - 0.1, 0.05, 0.85);
  fb(w, f, ctr, 0, 0.42, Dp / 2 - 0.06, W - 0.1, 0.8, 0.04);
  for (const sx of [-1, 1]) fb(w, f, ctr, sx * (W / 2 - 0.12), 0.42, Dp / 2 - 0.45, 0.04, 0.84, 0.8);
  w.b.colBox(f.wx(0, Dp / 2 - 0.45), y + 0.45, f.wz(0, Dp / 2 - 0.45), W, 0.9, 0.9, 'wood', ry);
  // produce crates on the counter
  const nC = Math.floor((W - 0.2) / 0.55);
  for (let i = 0; i < nC; i++) {
    const lx = -W / 2 + 0.35 + i * 0.55;
    const tilt = -0.25;
    fb(w, f, mk('wood_pallet', rng.int(0, 2)), lx, 0.95, Dp / 2 - 0.4, 0.5, 0.16, 0.38, false, tilt);
    produce(w, f, lx, 1.03, Dp / 2 - 0.4, rng, tilt);
  }
  // goods under / behind
  sacks(w, f.wx(0, -0.5), y, f.wz(0, -0.5), ry, rng, 3);
  if (rng.chance(0.6)) crate(w, f.wx(W / 2 + 0.45, 0.3), y, f.wz(W / 2 + 0.45, 0.3), ry + rng.jit(0.3), 0.55, 0.4, 0.45, 'ply', true, rng.int(0, 3));
  // tarp roof (flutter)
  const cols = [0x2f5f8f, 0x3d6b44, 0xb8b1a0, 0x8d3328, 0xc58f2e, 0x5a5f66];
  const col = new THREE.Color(rng.pick(cols));
  const tw = W + 0.5, td = Dp + 0.6;
  const g = new THREE.PlaneGeometry(tw, td, 8, 6);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const weight = new Float32Array(pos.count);
  const slope = (hf - hb) / Dp;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), lz = pos.getZ(i);
    const u = (lx + tw / 2) / tw, v = (lz + td / 2) / td;
    const sag = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.12;
    const overhang = Math.max(0, Math.abs(lz) - Dp / 2) * 0.6; // droop beyond frame
    pos.setY(i, (hb + hf) / 2 + 0.05 + lz * slope - sag - overhang);
    weight[i] = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.6 + (Math.abs(lz) > Dp / 2 ? 0.8 : 0) + (Math.abs(lx) > W / 2 ? 0.5 : 0);
  }
  g.computeVertexNormals();
  paint(g, col.clone().multiplyScalar(0.9));
  g.rotateY(ry);
  g.translate(x, y, z);
  w.addFlutter('custom:cloth', g, weight, new THREE.Vector3(0.2, 1, 0.1), 0.06);
  // hanging goods from front beam
  for (let i = 0; i < rng.int(1, 4); i++) {
    const p = f.p(rng.range(-W / 2 + 0.3, W / 2 - 0.3), hf - 0.05, Dp / 2 - 0.02);
    hangCloth(w, p.x, p.y, p.z, ry, rng.range(0.25, 0.5), rng.range(0.4, 0.8), new THREE.Color(rng.pick([0x9e3b2a, 0x2c4a7a, 0xd9c9a0, 0x456b3a, 0x5a2b52])));
  }
  coverSides(w, f, W / 2, Dp / 2, false, true);
  const back = f.p(0, 0, -Dp / 2 - 0.6), bn = f.d(0, -1);
  w.addCover(back.x, y, back.z, bn.x, bn.z);
  w.decal(D.PAPERS, f.p(0, 0.01, Dp / 2 + 0.5), new THREE.Vector3(0, 1, 0), 2.5, 1.5, rng.range(0, 6));
}

const PRODUCE = [0xd8741c, 0xb3261e, 0x5f8a2a, 0x3b2a4f, 0xd9b53a, 0x7da33a, 0x9c3a2a, 0xe6c46a];
function produce(w: WCtx, f: Frame, lx: number, ly: number, lz: number, rng: RNG, tilt: number) {
  const color = new THREE.Color(rng.pick(PRODUCE));
  const r = rng.range(0.035, 0.06);
  const n = Math.round(0.4 / (r * 2)) * Math.round(0.3 / (r * 2));
  for (let i = 0; i < n; i++) {
    const g = new THREE.SphereGeometry(r, 6, 4);
    paint(g, color.clone().multiplyScalar(rng.range(0.8, 1.1)));
    const px = lx - 0.2 + r + ((i % Math.round(0.4 / (r * 2))) * r * 2) + rng.jit(0.005);
    const pz = lz - 0.15 + r + Math.floor(i / Math.round(0.4 / (r * 2))) * r * 2;
    const dz = pz - lz;
    fg(w, f, 'custom:produce', g, px, ly + r * 0.8 - dz * Math.sin(-tilt) * 1.0 + rng.jit(0.01), pz, 0, 0, 0, 'keep');
  }
}

// ====================================================================== main street
function mainStreet(w: WCtx, rng: RNG) {
  // Cover rhythm down the street (alternating sides, ~10-14 m apart)
  pickup(w, -2.8, 0, -44, Math.PI / 2 + 0.12, rng, 'car_paint_white');
  sedan(w, 2.6, 0, 43.5, -Math.PI / 2 + 0.25, rng, true);
  sedan(w, 3.1, 0, -21, Math.PI / 2 - 0.06, rng, false, 'car_paint_red');
  jersey(w, -2.6, 0, 22, 0.08, 3, 0);
  jersey(w, -1.2, 0, 24.6, 0.9, 3, 1, false);
  sandbagWall(w, 2.4, 0, 18.5, -0.06, 3.5, 7, rng, 0.25);
  hesco(w, 3.0, 0, -32, 0, 3, rng);
  crateStack(w, -3.4, 0, 51, 1.4, rng, true);
  barrelGroup(w, 3.6, 0, 37.5, rng);
  rubble(w, -2.8, 0, 38, 1.4, rng);
  rubble(w, 3.5, 0, -50, 1.1, rng);
  jersey(w, 1.5, 0, -39, -0.3, 3, 3);
  sandbagWall(w, -3.0, 0, -26.2, 0.1, 3.0, 6, rng, -0.2);
  tireStack(w, 3.8, 0, 26.3, rng);
  debris(w, 0, 0, 48, 4, 12, rng);
  debris(w, 0, 0, -45, 4, 12, rng);
  debris(w, -1, 0, 20, 3, 8, rng);
  // sidewalk clutter
  for (const [x, z] of [[-6.2, 55], [6.1, 36], [-6.3, -36.5], [6.2, -55], [-6.1, 26.5], [6.2, -14]] as const) {
    const r = rng.fork(x * 10 + z);
    const t = r.int(0, 4);
    if (t === 0) gasCylinder(w, x, BASE, z, r);
    else if (t === 1) { crate(w, x, BASE, z, r.range(0, 1), 0.7, 0.5, 0.6, 'wood', true, r.int(0, 3)); cardboard(w, x, BASE, z + 0.8, r, 2); }
    else if (t === 2) trashBags(w, x, BASE, z, 3, r);
    else if (t === 3) { table(w, x, BASE, z, 0, r, 0.8, 0.8); chair(w, x - 0.2, BASE, z + 0.7, 3, r); chair(w, x + 0.1, BASE, z - 0.7, 0.2, r); }
    else barrel(w, x, BASE, z, r);
  }
  for (const [x, z] of [[-6.6, 30.5], [6.7, -31], [6.6, 31], [-6.7, -31.5]] as const) {
    // corner shrubs & sand where sidewalk ends
    shrub(w, x, 0, z, rng, 0.9);
  }
  // palms on sidewalks
  palm(w, 6.2, BASE, 44, rng, 7.5);
  palm(w, -6.1, BASE, -46, rng, 8.2);
  palm(w, -6.2, BASE, 17.5, rng, 6.8);
}

// ====================================================================== west alley
function alley(w: WCtx, rng: RNG) {
  const y = 0.02;
  // north segment x -25..-19, z -58..-15
  dumpster(w, -23.4, y, -52, Math.PI / 2, rng);
  trashBags(w, -20.2, y, -44, 4, rng);
  crateStack(w, -24, y, -37.5, Math.PI / 2, rng);
  cinderStack(w, -20, y, -25, 0.1, rng);
  barrelGroup(w, -23.5, y, -18.5, rng);
  rubble(w, -20.4, y, -48.5, 1.0, rng);
  palletStack(w, -24.1, y, -31.5, 0.2, 4, rng);
  debris(w, -22, y, -40, 2.5, 18, rng);
  // jog corners
  tireStack(w, -30.8, y, -13.2, rng);
  gasCylinder(w, -20.3, y, -13.5, rng);
  gasCylinder(w, -20.6, y, -13.2, rng, true);
  // middle segment x -32..-26, z -12..12
  rubble(w, -27, y, -2.6, 1.3, rng);
  crateStack(w, -30.8, y, 3.5, Math.PI / 2, rng, true);
  trashBags(w, -26.8, y, 9.5, 3, rng);
  barrel(w, -31.2, y, -9.8, rng);
  barrel(w, -30.6, y, -10.4, rng);
  cardboard(w, -27.2, y, 4.5, rng, 3);
  debris(w, -29, y, 0, 2.5, 18, rng);
  // south segment x -25..-19, z 15..58
  dumpster(w, -20.4, y, 30.8, -Math.PI / 2, rng);
  crateStack(w, -24.1, y, 42.6, Math.PI / 2 + 0.1, rng);
  rubble(w, -21, y, 49.5, 1.2, rng);
  cinderStack(w, -24.2, y, 18, 1.4, rng);
  trashBags(w, -24, y, 35.5, 4, rng);
  debris(w, -22, y, 40, 2.5, 20, rng);
  tireStack(w, -20.2, y, 55, rng);
  // sand drifts at wall bases
  sandDrift(w, -25, -45, 8, 1.2, 0.35, Math.PI / 2, rng, y);
  sandDrift(w, -19, -22, 6, 1.0, 0.3, -Math.PI / 2, rng, y);
  sandDrift(w, -32, 6, 7, 1.3, 0.4, Math.PI / 2, rng, y);
  sandDrift(w, -26, -8, 3.5, 0.9, 0.3, -Math.PI / 2, rng, y);
  sandDrift(w, -25, 25, 6, 1.1, 0.35, Math.PI / 2, rng, y);
  sandDrift(w, -19, 44, 5, 1.0, 0.3, -Math.PI / 2, rng, y);
  // shrubs growing from cracks
  shrub(w, -24.6, y, -27, rng, 0.7);
  shrub(w, -31.6, y, -4, rng, 0.8);
  shrub(w, -19.5, y, 36, rng, 0.6);
  // overhead: clotheslines + cables across the alley
  for (const [z, h] of [[-42, 4.2], [-24, 5.0], [22, 4.6], [45, 5.3], [53.5, 7.4]] as const) clothesline(w, new THREE.Vector3(-25, h, z), new THREE.Vector3(-19, h + rng.jit(0.3), z + rng.jit(1)), rng, 0.3);
  for (const [x0, x1, z, h] of [[-32, -26, -6, 5.3], [-32, -26, 8, 4.4]] as const) clothesline(w, new THREE.Vector3(x0, h, z), new THREE.Vector3(x1, h + rng.jit(0.3), z + rng.jit(1)), rng, 0.25);
  for (let z = -55; z < 56; z += 7) {
    if (z > -14 && z < 14) continue;
    for (let k = 0; k < rng.int(1, 3); k++) cable(w, new THREE.Vector3(-25, 5.4 + rng.jit(0.6), z + rng.jit(2)), new THREE.Vector3(-19, 5.6 + rng.jit(0.6), z + rng.jit(2)), rng.range(0.3, 0.7), 0.011);
  }
  for (let z = -10; z < 12; z += 6) cable(w, new THREE.Vector3(-32, 5.8, z), new THREE.Vector3(-26, 5.9, z + rng.jit(2)), 0.5, 0.011);
  // wall AC units low in alley
  for (const [x, z, ry] of [[-25 + 0.25, -33, Math.PI / 2], [-19 - 0.25, -41, -Math.PI / 2], [-26 + 0.25, 3, Math.PI / 2], [-19 - 0.25, 25.5, -Math.PI / 2]] as const) acUnit(w, x - Math.sin(ry) * 0.02, 2.4, z, ry, rng, true);
  // puddle/oil + papers
  for (let i = 0; i < 20; i++) {
    const z = rng.range(-56, 56);
    const x = z > -12 && z < 12 ? rng.range(-31, -27) : rng.range(-24.5, -19.5);
    w.decal(rng.pick([D.OIL, D.DIRT, D.PAPERS, D.SAND]), new THREE.Vector3(x, 0.045, z), new THREE.Vector3(0, 1, 0), rng.range(1, 2.5), rng.range(1, 2.5), rng.range(0, 6), 0.004);
  }
}

// ====================================================================== service road (east of inner block)
function serviceRoad(w: WCtx, rng: RNG) {
  const y = 0.02;
  container(w, 22.8, y, -49, Math.PI / 2 + 0.03, rng);
  palletStack(w, 21, y, -41, 0.3, 5, rng);
  barrelGroup(w, 24.6, y, -24, rng);
  sandbagWall(w, 22.6, y, -9, Math.PI / 2 - 0.1, 3.2, 6, rng, 0.3);
  crateStack(w, 20.4, y, 11, Math.PI / 2, rng);
  tireStack(w, 25.1, y, 25.2, rng);
  rubble(w, 21.3, y, 39.5, 1.3, rng);
  dumpster(w, 24.3, y, 52.5, Math.PI / 2, rng);
  debris(w, 22.5, y, 30, 3, 18, rng);
  debris(w, 22.5, y, -30, 3, 18, rng);
  sandDrift(w, 19, -44, 8, 1.2, 0.4, -Math.PI / 2, rng, y);
  sandDrift(w, 19, 42, 6, 1.1, 0.35, -Math.PI / 2, rng, y);
  shrub(w, 25.4, y, -16, rng, 1.1);
  shrub(w, 25.2, y, 44, rng, 0.9);
  palm(w, 24.8, y, 31, rng, 8.8);
  // lots north/south of the compound
  fenceCorrugated(w, 27, -22.5, 38, -22.5, 2.1, rng);
  sedan(w, 44.5, y, -25, 0.4, rng, true);
  rubble(w, 31, y, -25.5, 1.6, rng);
  tireStack(w, 49.5, y, -26.5, rng);
  fenceCorrugated(w, 40, 22.5, 51.5, 22.5, 2.1, rng);
  crateStack(w, 30, y, 25, 0.2, rng, true);
  gasCylinder(w, 47, y, 25.5, rng);
  gasCylinder(w, 47.4, y, 25.7, rng);
  barrelGroup(w, 44, y, 26, rng);
  // east yards (enclosed by corrugated fences)
  fenceCorrugated(w, 40.2, 34.2, 51.8, 34.2, 2.2, rng);
  container(w, 46, y, 40, 0.05, rng, true);
  palletStack(w, 42.5, y, 44.5, 0.2, 6, rng);
  fenceCorrugated(w, 40.2, -34.2, 51.8, -34.2, 2.2, rng);
  genset(w, 45, y, -40, 0.1);
  crateStack(w, 42.5, y, -44, 0, rng);
  sandDrift(w, 52, -40, 8, 1.4, 0.45, -Math.PI / 2, rng, y);
}

// ====================================================================== compound
function compound(w: WCtx, rng: RNG) {
  const x0 = 26, x1 = 52, z0 = -20, z1 = 20;
  const wallKey = mk('plaster_worn', 2), cap = mk('concrete', 1);
  const H = 2.8, T = 0.35;
  const seg = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const ry = Math.atan2(-(bz - az), bx - ax);
    const cx = (ax + bx) / 2, cz = (az + bz) / 2;
    w.b.box(wallKey, cx, H / 2, cz, len, H, T, { ry, col: true });
    w.b.box(cap, cx, H + 0.04, cz, len + 0.05, 0.08, T + 0.1, { ry });
    w.b.box(mk('concrete_dirty', 1), cx, 0.3, cz, len, 0.6, T + 0.06, { ry });
    // pilasters
    const n = Math.floor(len / 3.2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      w.b.box(wallKey, ax + (bx - ax) * t, H / 2 + 0.1, az + (bz - az) * t, 0.45, H + 0.2, T + 0.12, { ry });
    }
    // razor wire coil on top
    const coils = Math.floor(len / 0.35);
    const pts: THREE.Vector3[] = [];
    const tx = (bx - ax) / len, tz = (bz - az) / len;
    for (let i = 0; i <= coils * 6; i++) {
      const t = i / 6;
      const a = t * Math.PI * 2;
      const along = (t / coils) * len;
      pts.push(new THREE.Vector3(ax + tx * along - tz * Math.cos(a) * 0.22, H + 0.3 + Math.sin(a) * 0.22, az + tz * along + tx * Math.cos(a) * 0.22));
    }
    if (len > 2) {
      const curve = new THREE.CatmullRomCurve3(pts);
      w.b.add(mk('metal_bare', 3), new THREE.TubeGeometry(curve, pts.length, 0.006, 3, false));
    }
    // grime + graffiti outside
    const ox = tz, oz = -tx;
    for (let i = 0; i < len / 3.5; i++) {
      const t = (i + 0.5) / (len / 3.5);
      for (const sgn of [-1, 1]) w.decal(D.GRIME, new THREE.Vector3(ax + (bx - ax) * t + ox * sgn * (T / 2 + 0.03), 0.8, az + (bz - az) * t + oz * sgn * (T / 2 + 0.03)), new THREE.Vector3(ox * sgn, 0, oz * sgn), len / (len / 3.5) + 0.05, 1.6, 0, 0.004);
    }
    if (len > 6 && rng.chance(0.7)) {
      const t = rng.range(0.3, 0.7);
      w.decal(rng.pick([D.GRAFFITI_A, D.GRAFFITI_B, D.STENCIL]), new THREE.Vector3(ax + (bx - ax) * t - ox * (T / 2 + 0.03), 1.4, az + (bz - az) * t - oz * (T / 2 + 0.03)), new THREE.Vector3(-ox, 0, -oz), 2.0, 2.0, 0, 0.004);
    }
  };
  const gate = (x: number, z: number, ry: number, width: number) => {
    const f = new Frame(x, 0, z, ry);
    for (const s of [-1, 1]) {
      fb(w, f, mk('concrete', 2), s * (width / 2 + 0.3), 1.7, 0, 0.6, 3.4, 0.6, true);
      fb(w, f, mk('plaster_white', 1), s * (width / 2 + 0.3), 3.45, 0, 0.75, 0.12, 0.75);
      // open steel leaf
      const hinge = f.p(s * (width / 2), 0, 0);
      const leaf = new Frame(hinge.x, 0, hinge.z, ry + s * (Math.PI / 2 + 0.35) + Math.PI * (s > 0 ? 1 : 0));
      const lw = width / 2 - 0.05;
      fb(w, leaf, mk('metal_painted_blue', 1), lw / 2, 1.2, 0, lw, 2.2, 0.05, true);
      for (let i = 0; i < 5; i++) fb(w, leaf, mk('metal_painted_blue', 2), lw / 2, 0.35 + i * 0.45, 0.04, lw - 0.1, 0.05, 0.03);
    }
  };
  // perimeter with gates: west (z -2.5..2.5), north (x 33..38), south (x 33..38)
  seg(x0, z0, 33, z0); seg(38, z0, x1, z0);
  seg(x0, z1, 33, z1); seg(38, z1, x1, z1);
  seg(x0, z0, x0, -2.5); seg(x0, 2.5, x0, z1);
  seg(x1, z0, x1, z1);
  gate(35.5, z0, 0, 5);
  gate(35.5, z1, Math.PI, 5);
  gate(x0, 0, Math.PI / 2, 5);
  // main house with exterior stair to roof (courtyard side)
  B(w, 40, -12, 51.6, 6, 2, 'plaster', 601, { enter: true, doors: [{ f: 'n', at: 45 }, { f: 's', at: 46.5 }, { f: 'w', at: -10.2 }], stairs: { kind: 'exterior', f: 'w', at: 5.2, dir: -1 }, roofProps: true, parapet: 'stepped', blank: ['e'], balconies: [{ f: 's', floor: 1, at: 44 }] });
  // shed
  B(w, 27, 10, 33, 19.6, 1, 'brick', 602, { enter: true, doors: [{ f: 'e', at: 15, kind: 'double' }], blank: ['w', 's'], parapet: 'low' });
  // guard hut by the north gate
  B(w, 27, -19.6, 31, -15.6, 1, 'concrete', 603, { enter: true, doors: [{ f: 'e', at: -17.2 }], blank: ['w', 'n'], parapet: 'low' });
  // courtyard dressing
  pickup(w, 34.5, 0.02, -8, Math.PI / 2 + 0.3, rng, 'car_paint_white', true);
  carport(w, 34.5, -8, rng);
  hesco(w, 31, 0.02, 4.5, Math.PI / 2, 3, rng);
  sandbagNest(w, 45, BASE + 2 * FH, 3.5, Math.PI, rng);
  genset(w, 38.5, 0.02, 12.5, 0.1);
  barrelGroup(w, 49.8, 0.02, 12.5, rng);
  crateStack(w, 37.5, 0.02, 17.4, 0, rng, true);
  waterTowerSteel(w, 49, 0.02, -16.5, rng);
  palm(w, 29.5, 0.02, -5, rng, 8.5);
  palm(w, 38.2, 0.02, 7.3, rng, 7.2);
  shrub(w, 28.5, 0.02, 7.8, rng, 1.2);
  shrub(w, 46.5, 0.02, 9.5, rng, 1.0);
  clothesline(w, new THREE.Vector3(41, 2.2, 9.5), new THREE.Vector3(51.4, 2.3, 9.8), rng, 0.2);
  for (const x of [41, 51.4]) w.b.box(mk('metal_rusty', 1), x, 1.15, 9.6, 0.05, 2.3, 0.05);
  tireStack(w, 28.2, 0.02, -12.5, rng);
  cinderStack(w, 33.5, 0.02, 14, 0.3, rng);
  debris(w, 38, 0.02, 0, 7, 30, rng);
  sandDrift(w, 52, 0, 14, 1.4, 0.45, -Math.PI / 2, rng, 0.02);
  sandDrift(w, 26.2, 12, 7, 1.2, 0.4, Math.PI / 2, rng, 0.02);
  sandDrift(w, 38, 20, 7, 1.0, 0.35, Math.PI, rng, 0.02);
}

function carport(w: WCtx, x: number, z: number, rng: RNG) {
  const hx = 3.4, hz = 1.8;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    w.b.add(mk('metal_rusty', 1), cylBetween(new THREE.Vector3(x + sx * hx, 0, z + sz * hz), new THREE.Vector3(x + sx * hx, sz > 0 ? 2.6 : 2.9, z + sz * hz), 0.05, 6));
    w.b.colBox(x + sx * hx, 1.4, z + sz * hz, 0.1, 2.8, 0.1, 'metal');
  }
  for (const sz of [-1, 1]) w.b.box(mk('metal_rusty', 2), x, sz > 0 ? 2.62 : 2.92, z + sz * hz, hx * 2 + 0.2, 0.1, 0.08);
  const sheetKey = mk('metal_corrugated', 1);
  const f = new Frame(x, 0, z, 0);
  const slope = Math.atan2(0.3, hz * 2);
  for (let i = 0; i < 7; i++) {
    const lx = -hx - 0.1 + i * 1.0 + 0.5;
    fb(w, f, sheetKey, lx, 2.8, 0, 1.02, 0.02, hz * 2 + 0.6, false, -slope, rng.jit(0.02));
  }
}

function waterTowerSteel(w: WCtx, x: number, y: number, z: number, rng: RNG) {
  const H = 7.5, s = 1.4;
  const key = mk('metal_rusty', 2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    w.b.add(key, cylBetween(new THREE.Vector3(x + sx * s * 1.15, y, z + sz * s * 1.15), new THREE.Vector3(x + sx * s, y + H, z + sz * s), 0.06, 6));
    w.b.colBox(x + sx * s, y + H / 2, z + sz * s, 0.15, H, 0.15, 'metal');
  }
  for (let k = 1; k <= 3; k++) {
    const hy = y + (H * k) / 4;
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
      w.b.add(key, cylBetween(new THREE.Vector3(x + ax * s * 1.05, hy, z + az * s * 1.05), new THREE.Vector3(x + bx * s * 1.05, hy, z + bz * s * 1.05), 0.03, 4));
      w.b.add(key, cylBetween(new THREE.Vector3(x + ax * s * 1.1, hy - H / 4, z + az * s * 1.1), new THREE.Vector3(x + bx * s * 1.05, hy, z + bz * s * 1.05), 0.018, 4));
    }
  }
  // ladder
  for (let i = 0; i < 24; i++) w.b.box(mk('metal_bare', 2), x + s + 0.12, y + 0.3 * i + 0.2, z, 0.03, 0.03, 0.4);
  w.b.box(mk('metal_bare', 2), x + s + 0.12, y + H / 2, z - 0.2, 0.03, H, 0.03);
  w.b.box(mk('metal_bare', 2), x + s + 0.12, y + H / 2, z + 0.2, 0.03, H, 0.03);
  w.b.box(mk('metal_diamond_plate', 1), x, y + H + 0.05, z, s * 2.4, 0.1, s * 2.4, { col: true });
  waterTank(w, x, y + H + 0.1, z, rng, false);
  const g = new THREE.CylinderGeometry(1.3, 1.3, 2.2, 16);
  w.b.addT(mk('metal_painted_blue', 1), g, x, y + H + 1.3, z);
}

// ====================================================================== cross streets / spawns
function crossStreets(w: WCtx, rng: RNG) {
  // north cross street z -34..-28
  sedan(w, -12.5, 0, -30.8, 0.1, rng, false, 'car_paint_white');
  jersey(w, 10.8, 0, -31, 1.45, 3, 2);
  rubble(w, -30, 0, -31.6, 1.5, rng);
  barrelGroup(w, -40, 0, -29.8, rng);
  crateStack(w, 30.5, 0, -30.6, 0.1, rng);
  sandbagWall(w, -3.5, 0, -30.2, 0.02, 3.2, 5, rng, 0.2);
  debris(w, -5, 0, -31, 8, 20, rng);
  // south cross street z 28..34
  sedan(w, 12.2, 0, 31.4, Math.PI - 0.15, rng, true);
  jersey(w, -11, 0, 31, 1.6, 3, 0);
  rubble(w, 30.5, 0, 31.2, 1.4, rng);
  crateStack(w, -31, 0, 30.2, 0.05, rng, true);
  sandbagWall(w, 3.2, 0, 30.8, 0.0, 3.2, 5, rng, -0.2);
  tireStack(w, -40.5, 0, 32.7, rng);
  debris(w, 5, 0, 31, 8, 20, rng);
  sandDrift(w, -44, 31, 5, 1.4, 0.5, Math.PI / 2, rng, 0);
  sandDrift(w, 52, 31, 5, 1.4, 0.5, -Math.PI / 2, rng, 0);
  sandDrift(w, -44, -31, 5, 1.4, 0.5, Math.PI / 2, rng, 0);
  sandDrift(w, 52, -31, 5, 1.4, 0.5, -Math.PI / 2, rng, 0);
}

function spawns(w: WCtx, rng: RNG) {
  // south (player): HESCO line + sandbag checkpoints + container
  hesco(w, -7.5, 0, 60.5, 0, 4, rng);
  hesco(w, 9.5, 0, 60.5, 0, 3, rng);
  container(w, 34, 0, 62, 0.02, rng);
  pickup(w, -29, 0, 62.3, 0.05, rng, 'car_paint_white');
  sandbagNest(w, 1.2, 0, 60.4, 0, rng);
  palletStack(w, 21.5, 0, 62, 0.3, 4, rng);
  barrelGroup(w, -38.5, 0, 63, rng);
  crate(w, 15.4, 0, 63.5, 0.1, 1.1, 0.9, 0.9, 'mil', true, 1);
  crate(w, 16.6, 0, 63.6, -0.1, 1.1, 0.9, 0.9, 'mil', true, 2);
  crate(w, 16, 0.9, 63.55, 0.2, 1.0, 0.8, 0.85, 'mil', true, 0);
  // north (enemy)
  container(w, -33, 0, -62, 0.04, rng, true);
  jersey(w, -4, 0, -60.5, 0, 3, 1);
  jersey(w, 4, 0, -60.8, 0.1, 3, 2);
  sedan(w, 13.5, 0, -61.8, 0.05, rng, true);
  hesco(w, 36, 0, -61, 0, 4, rng);
  sandbagWall(w, 25, 0, -61, 0, 3.4, 6, rng, 0.3);
  rubble(w, -18.5, 0, -61.8, 1.4, rng);
  crateStack(w, 46, 0, -62.5, 0, rng, true);
  debris(w, 0, 0, -62, 10, 25, rng);
  debris(w, 0, 0, 62, 10, 25, rng);
}

// ====================================================================== utilities: poles, cables, lights
function utilities(w: WCtx, rng: RNG) {
  const poleTops: { side: number; tops: THREE.Vector3[]; z: number }[] = [];
  let i = 0;
  for (const z of [-56, -40, -24, 17, 25, 40, 55]) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * 6.3;
    const { tops } = powerPole(w, x, BASE, z, 0, rng);
    poleTops.push({ side, tops, z });
    // service drops to facades
    for (let k = 0; k < rng.int(1, 3); k++) {
      const fx = side * 7.05, fz = z + rng.jit(6);
      cable(w, tops[k % tops.length], new THREE.Vector3(fx, rng.range(5.2, 6.3), fz), rng.range(0.3, 0.7), 0.009);
    }
    i++;
  }
  // span cables pole-to-pole across and along the street (skip the plaza gap)
  for (let k = 0; k < poleTops.length - 1; k++) {
    const a = poleTops[k], b = poleTops[k + 1];
    if (a.z < 0 && b.z > 0) continue;
    for (let c = 0; c < 4; c++) cable(w, a.tops[c], b.tops[3 - c], rng.range(0.7, 1.3), 0.011);
  }
  // street lights (other side from poles)
  for (const [x, z, ry] of [[6.3, -48, Math.PI], [-6.3, -32, 0], [6.3, -18, Math.PI], [-6.3, 21, 0], [6.3, 30.5, Math.PI], [-6.3, 48, 0]] as const) streetLight(w, x, BASE, z, ry);
  // cables across alleys at plaza passage + service road
  for (const z of [-0.3, 0.8]) cable(w, new THREE.Vector3(-26, 5.8, z), new THREE.Vector3(-14, 6.1, z + 0.4), 0.8, 0.012);
  for (const z of [-1, 1.2]) cable(w, new THREE.Vector3(14, 6.0, z), new THREE.Vector3(26, 3.0, z + 0.5), 0.6, 0.012);
  for (let z = -52; z < 55; z += 9) cable(w, new THREE.Vector3(19, 5.5 + rng.jit(0.5), z), new THREE.Vector3(26, 5.8 + rng.jit(0.5), z + rng.jit(2)), 0.5, 0.011);
  void fg; void coverSides; void hangCloth;
}

// ====================================================================== backdrop ring
function backdrop(w: WCtx, rng: RNG) {
  let seed = 900;
  const row = (x0: number, z0: number, x1: number, z1: number, alongX: boolean, face: Face) => {
    let p = alongX ? x0 : z0;
    const end = alongX ? x1 : z1;
    while (p < end - 4) {
      const len = Math.min(end - p, rng.range(9, 17));
      const floors = rng.int(2, 4);
      const style = rng.pick(['plaster', 'concrete', 'brick', 'plaster'] as const);
      const inset = rng.range(0, 1.2);
      const blank: Face[] = (['n', 's', 'e', 'w'] as Face[]).filter((f) => f !== face);
      if (alongX) {
        const zz0 = face === 's' ? z0 : z0 + inset, zz1 = face === 's' ? z1 - inset : z1;
        B(w, p, zz0, p + len, zz1, floors, style, seed++, { simple: true, blank, shops: rng.chance(0.4) ? [face] : undefined });
      } else {
        const xx0 = face === 'e' ? x0 : x0 + inset, xx1 = face === 'e' ? x1 - inset : x1;
        B(w, xx0, p, xx1, p + len, floors, style, seed++, { simple: true, blank, shops: rng.chance(0.4) ? [face] : undefined });
      }
      p += len;
    }
  };
  row(-60, -80, 68, -66.5, true, 's');
  row(-60, 66.5, 68, 80, true, 'n');
  row(-60, -66.5, -46.5, 66.5, false, 'e');
  row(54.5, -66.5, 68, 66.5, false, 'w');
}
