/**
 * Offline measurement + visualization of rendered sounds (dev only; imported by src/dev/scenes/audio.ts).
 * Loudness follows ITU-R BS.1770 K-weighting (momentary 400 ms blocks, gated integrated).
 */

export interface Metrics {
  name: string;
  variants: number;
  dur: number;
  ch: number;
  peakDb: number;
  clipped: number;
  dc: number;
  rmsDb: number;
  lufsM: number;
  lufsI: number;
  crestDb: number;
  attack50Ms: number;
  attack90Ms: number;
  peakAtMs: number;
  tail40: number;
  tail60: number;
  centroid: number;
  bands: Record<string, number>;
  varDb: number;
  /** Mean peak-to-trough (dB) of the 2 ms envelope within 80 ms windows near full level — "punch" in dense passages. */
  modDb: number;
}

const BANDS: [string, number, number][] = [['sub', 20, 60], ['low', 60, 250], ['lmid', 250, 1000], ['mid', 1000, 4000], ['high', 4000, 10000], ['air', 10000, 24000]];

export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function biquad(x: Float32Array, b: number[], a: number[]): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function kWeight(x: Float32Array, sr: number): Float32Array {
  let G = 3.999843853973347, fc = 1681.974450955533, Q = 0.7071752369554196;
  let A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc / sr, al = Math.sin(w0) / (2 * Q), cs = Math.cos(w0), sA = Math.sqrt(A);
  const b1 = [A * ((A + 1) + (A - 1) * cs + 2 * sA * al), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - 2 * sA * al)];
  const a1 = [(A + 1) - (A - 1) * cs + 2 * sA * al, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - 2 * sA * al];
  fc = 38.13547087602444; Q = 0.5003270373238773; G = 0; A = 1; w0 = 2 * Math.PI * fc / sr; al = Math.sin(w0) / (2 * Q); cs = Math.cos(w0);
  const b2 = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2];
  const a2 = [1 + al, -2 * cs, 1 - al];
  return biquad(biquad(x, b1, a1), b2, a2);
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

export function loudness(chans: Float32Array[], sr: number): { M: number; I: number } {
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
  const kw = chans.map((c) => {
    const padded = new Float32Array(Math.max(c.length, block)); padded.set(c);
    return kWeight(padded, sr);
  });
  const n = kw[0].length;
  const blocks: number[] = [];
  for (let s = 0; s + block <= n; s += hop) {
    let z = 0;
    for (const k of kw) { let acc = 0; for (let i = s; i < s + block; i++) acc += k[i] * k[i]; z += acc / block; }
    blocks.push(z);
  }
  if (!blocks.length) return { M: -120, I: -120 };
  const L = (z: number) => -0.691 + 10 * Math.log10(Math.max(1e-12, z));
  const M = Math.max(...blocks.map(L));
  const abs = blocks.filter((z) => L(z) > -70);
  if (!abs.length) return { M, I: -120 };
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = abs.filter((z) => L(z) > L(mean) - 10);
  const I = L(rel.reduce((a, b) => a + b, 0) / rel.length);
  return { M, I };
}

function mono(buf: AudioBuffer): Float32Array {
  const n = buf.length, out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
  return out;
}

/** 5 ms RMS envelope in dB. */
export function envelopeDb(buf: AudioBuffer, win = 0.005): { t: number[]; v: number[] } {
  const x = mono(buf), sr = buf.sampleRate, w = Math.max(1, Math.round(win * sr));
  const t: number[] = [], v: number[] = [];
  for (let s = 0; s < x.length; s += w) {
    let acc = 0, m = 0;
    for (let i = s; i < Math.min(x.length, s + w); i++) { acc += x[i] * x[i]; m++; }
    t.push(s / sr); v.push(db(Math.sqrt(acc / Math.max(1, m))));
  }
  return { t, v };
}

function bandSpectrum(x: Float32Array, sr: number): { bins: Float64Array; N: number } {
  const N = 4096;
  const acc = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s < Math.max(1, x.length - N / 2); s += N / 2) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < N && s + i < x.length; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  }
  void sr;
  return { bins: acc, N };
}

/** Third-octave band levels (dB) for variant comparison. */
function thirdOctave(x: Float32Array, sr: number): number[] {
  const { bins, N } = bandSpectrum(x, sr);
  const out: number[] = [];
  for (let f = 40; f < 16000; f *= Math.pow(2, 1 / 3)) {
    const lo = Math.floor((f / Math.pow(2, 1 / 6)) * N / sr), hi = Math.ceil((f * Math.pow(2, 1 / 6)) * N / sr);
    let e = 0; for (let k = lo; k <= hi && k < bins.length; k++) e += bins[k];
    out.push(10 * Math.log10(e + 1e-12));
  }
  return out;
}

export function analyze(name: string, bufs: AudioBuffer[]): Metrics {
  const buf = bufs[0], sr = buf.sampleRate;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  let peak = 0, peakIdx = 0, clipped = 0, dc = 0;
  for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    let sum = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a >= 0.999) clipped++; sum += d[i]; if (b === buf && a > peak) { peak = a; peakIdx = i; } }
    dc = Math.max(dc, Math.abs(sum / d.length));
  }
  // peak across all variants
  let peakAll = 0; for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) peakAll = Math.max(peakAll, Math.abs(d[i])); }
  // attack: onset (first sample above 1% of peak) → first sample above 50% / 90%
  const absMax = new Float32Array(buf.length);
  for (const d of chans) for (let i = 0; i < d.length; i++) absMax[i] = Math.max(absMax[i], Math.abs(d[i]));
  let onset = 0; while (onset < absMax.length && absMax[onset] < peak * 0.01) onset++;
  let i50 = onset; while (i50 < absMax.length && absMax[i50] < peak * 0.5) i50++;
  let i90 = onset; while (i90 < absMax.length && absMax[i90] < peak * 0.9) i90++;
  // tails from 5 ms envelope
  const env = envelopeDb(buf);
  const envPeak = Math.max(...env.v);
  const ePk = env.v.indexOf(envPeak);
  let l40 = ePk, l60 = ePk;
  for (let k = ePk; k < env.v.length; k++) { if (env.v[k] > envPeak - 40) l40 = k; if (env.v[k] > envPeak - 60) l60 = k; }
  // RMS over active region (envelope within 40 dB of peak)
  let acc = 0, m = 0;
  const x = mono(buf);
  const w = Math.round(0.005 * sr);
  for (let k = 0; k < env.v.length; k++) if (env.v[k] > envPeak - 40) { for (let i = k * w; i < Math.min(x.length, (k + 1) * w); i++) { acc += x[i] * x[i]; m++; } }
  const rms = Math.sqrt(acc / Math.max(1, m));
  const { M, I } = loudness(chans, sr);
  // spectrum
  const { bins, N } = bandSpectrum(x, sr);
  let tot = 0, cen = 0;
  for (let k = 1; k < bins.length; k++) { tot += bins[k]; cen += bins[k] * (k * sr / N); }
  const bands: Record<string, number> = {};
  for (const [bn, lo, hi] of BANDS) {
    let e = 0; for (let k = Math.floor(lo * N / sr); k < Math.min(bins.length, Math.ceil(hi * N / sr)); k++) e += bins[k];
    bands[bn] = 10 * Math.log10(e / tot + 1e-12);
  }
  // variation: RMS difference of third-octave spectra (level-normalized) between variant pairs
  let varDb = 0, pairs = 0;
  if (bufs.length > 1) {
    const specs = bufs.map((b) => { const s = thirdOctave(mono(b), sr); const mx = Math.max(...s); return s.map((v) => Math.max(v - mx, -60)); });
    for (let a = 0; a < specs.length; a++) for (let b = a + 1; b < specs.length; b++) {
      let d2 = 0; for (let k = 0; k < specs[a].length; k++) d2 += (specs[a][k] - specs[b][k]) ** 2;
      varDb += Math.sqrt(d2 / specs[a].length); pairs++;
    }
    varDb /= pairs;
  }
  const e2 = envelopeDb(buf, 0.002);
  const gmax = Math.max(...e2.v);
  let mod = 0, nm = 0;
  for (let k = 0; k + 40 <= e2.v.length; k += 20) {
    let mx = -200, mn = 200;
    for (let j = k; j < k + 40; j++) { mx = Math.max(mx, e2.v[j]); mn = Math.min(mn, e2.v[j]); }
    if (mx > gmax - 12) { mod += mx - mn; nm++; }
  }
  return {
    modDb: nm ? mod / nm : 0,
    name, variants: bufs.length, dur: buf.duration, ch: buf.numberOfChannels,
    peakDb: db(peakAll), clipped, dc, rmsDb: db(rms), lufsM: M, lufsI: I, crestDb: db(peak) - db(rms),
    attack50Ms: ((i50 - onset) / sr) * 1000, attack90Ms: ((i90 - onset) / sr) * 1000, peakAtMs: (peakIdx / sr) * 1000,
    tail40: (l40 - ePk) * 0.005, tail60: (l60 - ePk) * 0.005, centroid: cen / tot, bands, varDb,
  };
}

// ---------------- drawing ----------------

const CMAP = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
function cmap(u: number): [number, number, number] {
  u = Math.max(0, Math.min(1, u)) * (CMAP.length - 1);
  const i = Math.min(CMAP.length - 2, Math.floor(u)), f = u - i;
  const a = CMAP[i], b = CMAP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function drawSpectrogram(g: CanvasRenderingContext2D, buf: AudioBuffer, x0: number, y0: number, W: number, H: number, labels = true, t0 = 0, t1 = buf.duration) {
  const x = mono(buf), sr = buf.sampleRate;
  const N = 2048;
  const img = g.createImageData(W, H);
  const re = new Float64Array(N), im = new Float64Array(N);
  const fMin = 30, fMax = sr / 2;
  const rowBins: [number, number][] = [];
  for (let r = 0; r < H; r++) {
    const fa = fMin * Math.pow(fMax / fMin, (H - 1 - r) / H), fb = fMin * Math.pow(fMax / fMin, (H - r) / H);
    rowBins.push([Math.max(1, Math.floor(fa * N / sr)), Math.max(1, Math.ceil(fb * N / sr))]);
  }
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let wsum = 0; for (let i = 0; i < N; i++) wsum += win[i];
  for (let c = 0; c < W; c++) {
    const center = Math.round((t0 + ((t1 - t0) * c) / W) * sr);
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) { const j = center - N / 2 + i; re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0; }
    fft(re, im);
    for (let r = 0; r < H; r++) {
      const [a, b] = rowBins[r];
      let m = 0; for (let k = a; k <= b && k < N / 2; k++) m = Math.max(m, re[k] * re[k] + im[k] * im[k]);
      const dB = 10 * Math.log10(m / (wsum * wsum / 4) + 1e-14);
      const [R, G, B] = cmap((dB + 100) / 100);
      const o = (r * W + c) * 4;
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, x0, y0);
  if (labels) {
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = '11px monospace';
    for (const f of [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
      const y = y0 + H - 1 - (Math.log(f / fMin) / Math.log(fMax / fMin)) * H;
      g.fillRect(x0, y, 6, 1); g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x0 + 8, y + 4);
    }
  }
}

function drawWave(g: CanvasRenderingContext2D, buf: AudioBuffer, x0: number, y0: number, W: number, H: number, t0: number, t1: number, dots = false) {
  g.fillStyle = '#111'; g.fillRect(x0, y0, W, H);
  const mid = y0 + H / 2;
  g.strokeStyle = '#444'; g.beginPath(); g.moveTo(x0, mid); g.lineTo(x0 + W, mid); g.stroke();
  const ceil = Math.pow(10, -0.3 / 20);
  g.strokeStyle = '#a33'; g.setLineDash([4, 4]);
  for (const s of [-1, 1]) { g.beginPath(); g.moveTo(x0, mid - s * ceil * H / 2); g.lineTo(x0 + W, mid - s * ceil * H / 2); g.stroke(); }
  g.setLineDash([]);
  const sr = buf.sampleRate;
  const cols = ['#5cf', '#fc5'];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    g.strokeStyle = cols[c % 2]; g.globalAlpha = buf.numberOfChannels > 1 ? 0.6 : 1;
    const a = Math.floor(t0 * sr), b = Math.min(d.length, Math.ceil(t1 * sr));
    const spp = (b - a) / W;
    g.beginPath();
    if (spp <= 2 || dots) {
      for (let i = a; i < b; i++) { const px = x0 + ((i - a) / (b - a)) * W; const py = mid - d[i] * H / 2; if (i === a) g.moveTo(px, py); else g.lineTo(px, py); }
    } else {
      for (let px = 0; px < W; px++) {
        let mn = 1, mx = -1;
        for (let i = Math.floor(a + px * spp); i < Math.min(b, Math.floor(a + (px + 1) * spp)); i++) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); }
        if (mx < mn) continue;
        g.moveTo(x0 + px + 0.5, mid - mx * H / 2); g.lineTo(x0 + px + 0.5, mid - mn * H / 2 + 0.5);
      }
    }
    g.stroke();
  }
  g.globalAlpha = 1;
}

function drawEnvelopes(g: CanvasRenderingContext2D, bufs: AudioBuffer[], x0: number, y0: number, W: number, H: number, T: number) {
  g.fillStyle = '#111'; g.fillRect(x0, y0, W, H);
  g.font = '10px monospace';
  for (let dB = 0; dB >= -80; dB -= 20) {
    const y = y0 + (-dB / 80) * H;
    g.strokeStyle = '#333'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + W, y); g.stroke();
    g.fillStyle = '#777'; g.fillText(`${dB}dB`, x0 + 2, y + (dB === 0 ? 10 : -2));
  }
  const cols = ['#5cf', '#fc5', '#f6a', '#8f8', '#c9f', '#fa8'];
  bufs.forEach((b, i) => {
    const e = envelopeDb(b, 0.002);
    g.strokeStyle = cols[i % cols.length]; g.globalAlpha = 0.85; g.beginPath();
    e.t.forEach((t, k) => { const px = x0 + (t / T) * W, py = y0 + Math.min(1, -e.v[k] / 80) * H; if (k === 0) g.moveTo(px, py); else g.lineTo(px, py); });
    g.stroke();
  });
  g.globalAlpha = 1;
}

function timeAxis(g: CanvasRenderingContext2D, x0: number, y: number, W: number, T: number) {
  g.fillStyle = '#aaa'; g.font = '11px monospace';
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
  const step = steps.find((s) => T / s <= 12) ?? 5;
  for (let t = 0; t <= T + 1e-9; t += step) {
    const px = x0 + (t / T) * W;
    g.fillRect(px, y, 1, 4);
    g.fillText(step < 0.01 ? `${(t * 1000).toFixed(0)}ms` : step < 1 ? `${(t * 1000).toFixed(0)}ms` : `${t.toFixed(0)}s`, px + 2, y + 13);
  }
}

export function drawSheet(name: string, bufs: AudioBuffer[], m: Metrics, extra = ''): HTMLCanvasElement {
  const W = 1400, H = 860;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, W, H);
  const buf = bufs[0];
  const T = buf.duration;
  g.fillStyle = '#fff'; g.font = 'bold 16px monospace';
  g.fillText(`${name}  (${m.variants} var, ${m.ch}ch, ${(m.dur * 1000).toFixed(0)} ms)${extra}`, 10, 20);
  g.font = '12px monospace'; g.fillStyle = '#ccc';
  g.fillText(`peak ${m.peakDb.toFixed(2)} dBFS  clip ${m.clipped}  DC ${m.dc.toExponential(1)}  LUFS-M ${m.lufsM.toFixed(1)}  LUFS-I ${m.lufsI.toFixed(1)}  crest ${m.crestDb.toFixed(1)} dB  attack50 ${m.attack50Ms.toFixed(2)} ms  attack90 ${m.attack90Ms.toFixed(2)} ms  peak@ ${m.peakAtMs.toFixed(1)} ms  T40 ${m.tail40.toFixed(2)} s  T60 ${m.tail60.toFixed(2)} s`, 10, 40);
  g.fillText(`centroid ${m.centroid.toFixed(0)} Hz  bands(dB rel) ${Object.entries(m.bands).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ')}  variant-diff ${m.varDb.toFixed(2)} dB  punch(mod) ${m.modDb.toFixed(1)} dB`, 10, 56);
  // waveform full + inset of the first 25 ms
  g.fillStyle = '#888'; g.fillText('waveform (variant 0)', 10, 76); g.fillText('first 25 ms', 1010, 76);
  drawWave(g, buf, 10, 82, 990, 170, 0, T);
  timeAxis(g, 10, 252, 990, T);
  drawWave(g, buf, 1010, 82, 380, 170, 0, Math.min(T, 0.025), true);
  timeAxis(g, 1010, 252, 380, Math.min(T, 0.025));
  g.fillStyle = '#888'; g.fillText('RMS envelope, all variants (2 ms)', 10, 284);
  drawEnvelopes(g, bufs, 10, 290, 1380, 150, T);
  timeAxis(g, 10, 440, 1380, T);
  g.fillStyle = '#888'; g.fillText('spectrogram (variant 0), log freq, -100..0 dB', 10, 472);
  drawSpectrogram(g, buf, 10, 478, 1380, 360);
  timeAxis(g, 10, 838, 1380, T);
  return cv;
}

export function drawContact(items: { name: string; buf: AudioBuffer }[], cols = 5): HTMLCanvasElement {
  const cw = 300, ch = 150, pad = 18;
  const rows = Math.ceil(items.length / cols);
  const cv = document.createElement('canvas'); cv.width = cols * cw; cv.height = rows * (ch + pad);
  const g = cv.getContext('2d')!;
  g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, cv.width, cv.height);
  items.forEach((it, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + pad);
    drawSpectrogram(g, it.buf, x + 2, y + pad, cw - 4, ch - 40, false);
    drawWave(g, it.buf, x + 2, y + pad + ch - 40, cw - 4, 38, 0, it.buf.duration);
    g.fillStyle = '#fff'; g.font = '12px monospace'; g.fillText(`${it.name} ${(it.buf.duration * 1000).toFixed(0)}ms`, x + 4, y + 13);
  });
  return cv;
}
