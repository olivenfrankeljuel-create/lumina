import * as THREE from 'three';

/** Geometry helpers used by the world generators. All return fresh geometries (callers consume them). */

/** Corrugated sheet in the XY plane (width along X, height along Y), ridges vertical, centred at origin. */
export function corrugated(w: number, h: number, pitch = 0.076, depth = 0.018, vertical = true): THREE.BufferGeometry {
  const seg = Math.max(4, Math.round((w / pitch) * 4));
  const g = new THREE.PlaneGeometry(w, h, seg, 1);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin((x / pitch) * Math.PI * 2) * depth * 0.5);
  }
  g.computeVertexNormals();
  if (!vertical) g.rotateZ(Math.PI / 2);
  return g;
}

/** Two-sided version: front + back copies (back flipped). */
export function twoSided(g: THREE.BufferGeometry, gap = 0.002): THREE.BufferGeometry {
  const back = g.clone();
  const idx = back.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  const n = back.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  back.translate(0, 0, -gap);
  const out = mergeTwo(g, back);
  return out;
}

export function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const aa = a.attributes[name] as THREE.BufferAttribute, bb = b.attributes[name] as THREE.BufferAttribute;
    if (!aa || !bb) continue;
    const arr = new Float32Array(aa.array.length + bb.array.length);
    arr.set(aa.array as Float32Array, 0);
    arr.set(bb.array as Float32Array, aa.array.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, aa.itemSize));
  }
  const ia = a.index ? Array.from(a.index.array) : [...Array(a.attributes.position.count).keys()];
  const ib = b.index ? Array.from(b.index.array) : [...Array(b.attributes.position.count).keys()];
  const off = a.attributes.position.count;
  out.setIndex(ia.concat(ib.map((i) => i + off)));
  return out;
}

/** Catenary curve points between a and b with sag (m) at the middle. */
export function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, n = 16): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    pts.push(p);
  }
  return pts;
}

export function tubeAlong(pts: THREE.Vector3[], r: number, radial = 4): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, Math.max(2, pts.length * 2), r, radial, false);
}

/** Cylinder between two points. */
export function cylBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, radial = 6, r2?: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2 ?? r, r, len, radial, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Quad with UVs mapped to an atlas rect, facing +Z, centred. */
export function atlasQuad(w: number, h: number, rect: [number, number, number, number], segW = 1, segH = 1): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, segW, segH);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, rect[0] + uv.getX(i) * (rect[2] - rect[0]), rect[1] + uv.getY(i) * (rect[3] - rect[1]));
  return g;
}

/** Set a constant vertex color on a geometry. */
export function paint(g: THREE.BufferGeometry, c: THREE.Color | number): THREE.BufferGeometry {
  const col = c instanceof THREE.Color ? c : new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Irregular closed polygon (jittered ellipse) as THREE.Shape points. */
export function blobPoints(cx: number, cy: number, rx: number, ry: number, rnd: () => number, n = 12, jag = 0.35): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 - jag * 0.5 + rnd() * jag;
    pts.push(new THREE.Vector2(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k));
  }
  return pts;
}

/** Displace vertices of a geometry with a function (in place). */
export function displace(g: THREE.BufferGeometry, fn: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Rounded (bevelled) box via ExtrudeGeometry of a rounded rect profile in XY, extruded along Z. */
export function roundedBox(w: number, h: number, d: number, r: number, seg = 2): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x0 = -w / 2 + r, x1 = w / 2 - r, y0 = -h / 2 + r, y1 = h / 2 - r;
  s.moveTo(x0, -h / 2);
  s.lineTo(x1, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, y0);
  s.lineTo(w / 2, y1);
  s.quadraticCurveTo(w / 2, h / 2, x1, h / 2);
  s.lineTo(x0, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, y1);
  s.lineTo(-w / 2, y0);
  s.quadraticCurveTo(-w / 2, -h / 2, x0, -h / 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: d - r * 2 > 0 ? d - r * 2 : d, bevelEnabled: d - r * 2 > 0, bevelThickness: r, bevelSize: 0, bevelSegments: seg, curveSegments: seg });
  g.translate(0, 0, -(d - r * 2 > 0 ? d - r * 2 : d) / 2);
  return g;
}

/** Extrude a 2D profile (XY points) along Z by depth, centred on Z. */
export function extrudeProfile(pts: [number, number][], depth: number, bevel = 0): THREE.BufferGeometry {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -(depth - bevel * 2) / 2);
  return g;
}
