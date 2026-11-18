// Press: print-roughening for type, vectors and artwork.
// "load" prepares the image once (what's ink, what's paper, ink colors);
// "run" applies the roughening settings and returns RGBA ink on a clear background.

let src = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "load") {
    src = prepare(new Uint8ClampedArray(m.rgba), m.w, m.h);
    self.postMessage({ type: "loaded", id: m.id, paper: src.paper, transparent: src.transparent });
  } else if (m.type === "run" && src) {
    const rgba = roughen(src, m.p);
    self.postMessage({ type: "done", id: m.id, w: src.w, h: src.h, rgba }, [rgba.buffer]);
  }
};

// ---------- prepare ----------

function prepare(d, w, h) {
  const n = w * h;
  let clear = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) clear++;
  const transparent = clear > n * 0.01;
  const cov = new Float32Array(n);   // 0 = paper, 1 = full ink
  const col = new Uint8ClampedArray(n * 3);
  let paper = null;

  if (transparent) {
    for (let i = 0; i < n; i++) {
      cov[i] = d[i * 4 + 3] / 255;
      col[i * 3] = d[i * 4]; col[i * 3 + 1] = d[i * 4 + 1]; col[i * 3 + 2] = d[i * 4 + 2];
    }
  } else {
    paper = borderColor(d, w, h);
    const [pr, pg, pb] = paper;
    const dist = new Float32Array(n);
    const hist = new Uint32Array(443);
    let counted = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const dr = d[j] - pr, dg = d[j + 1] - pg, db = d[j + 2] - pb;
      dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist[i] > 24) { hist[dist[i] | 0]++; counted++; }
    }
    // "Full ink" = how far the strongest ink pixels sit from the paper
    let full = 255;
    if (counted) {
      let acc = 0;
      for (let k = 442; k >= 0; k--) { acc += hist[k]; if (acc >= counted * 0.05) { full = k; break; } }
    }
    full = Math.max(48, full * 0.9);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const c = Math.min(1, Math.max(0, (dist[i] - 10) / (full - 10)));
      cov[i] = c;
      // Undo the anti-alias blend with the paper so edges keep the true ink color
      for (let k = 0; k < 3; k++) {
        col[i * 3 + k] = c > 0.05 ? (d[j + k] - (1 - c) * paper[k]) / c : d[j + k];
      }
    }
  }

  fillColors(col, cov, w, h);
  return { w, h, cov, col, paper, transparent };
}

function borderColor(d, w, h) {
  const rs = [], gs = [], bs = [];
  const push = (x, y) => { const j = (y * w + x) * 4; rs.push(d[j]); gs.push(d[j + 1]); bs.push(d[j + 2]); };
  for (let x = 0; x < w; x += 2) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += 2) { push(0, y); push(w - 1, y); }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

// Pixels that are mostly paper borrow the color of nearby ink, so grown edges,
// wobble and specks get the right color.
function fillColors(col, cov, w, h) {
  const n = w * h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), wt = new Float32Array(n);
  let tr = 0, tg = 0, tb = 0, tw = 0;
  for (let i = 0; i < n; i++) {
    if (cov[i] > 0.5) {
      r[i] = col[i * 3]; g[i] = col[i * 3 + 1]; b[i] = col[i * 3 + 2]; wt[i] = 1;
      tr += r[i]; tg += g[i]; tb += b[i]; tw++;
    }
  }
  const avg = tw ? [tr / tw, tg / tw, tb / tw] : [17, 17, 17];
  const R = Math.max(8, Math.max(w, h) / 60);
  for (const a of [r, g, b, wt]) blur(a, w, h, R);
  for (let i = 0; i < n; i++) {
    if (cov[i] > 0.5) continue;
    if (wt[i] > 1e-3) {
      col[i * 3] = r[i] / wt[i]; col[i * 3 + 1] = g[i] / wt[i]; col[i * 3 + 2] = b[i] / wt[i];
    } else {
      col[i * 3] = avg[0]; col[i * 3 + 1] = avg[1]; col[i * 3 + 2] = avg[2];
    }
  }
}

// ---------- roughen ----------

function roughen(src, p) {
  const { w, h, cov, col } = src;
  const n = w * h;
  const S = Math.max(w, h) / 1600;          // effects look the same at any detail size
  const k = p.overall / 100;
  const amt = (v) => Math.min(2, Math.max(0, (v / 100) * k));
  const rng = mulberry32(p.seed);

  // 1. Wobble and slice shift: move where each pixel reads from
  const wob = 22 * S * Math.pow(amt(p.wobble), 1.6);
  const sl = amt(p.slice);
  const shift = new Float32Array(h);
  if (sl > 0) {
    for (let y = 0; y < h;) {
      const bh = Math.max(1, Math.round((2 + rng() * rng() * 60) * S));
      const off = rng() < 0.12 + sl * 0.5 ? (rng() * 2 - 1) * sl * sl * 70 * S : 0;
      for (let yy = y; yy < Math.min(h, y + bh); yy++) shift[yy] = off;
      y += bh;
    }
  }
  let warped = cov;
  const idx = new Int32Array(n);
  if (wob > 0.05 || sl > 0) {
    const cell = Math.max(2, p.wobbleSize * S);
    const nx = wob > 0.05 ? valueNoise(w, h, cell, cell, rng) : null;
    const ny = wob > 0.05 ? valueNoise(w, h, cell, cell, rng) : null;
    warped = new Float32Array(n);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const sx = x + shift[y] + (nx ? (nx[i] - 0.5) * 2 * wob : 0);
        const sy = y + (ny ? (ny[i] - 0.5) * 2 * wob : 0);
        warped[i] = sample(cov, w, h, sx, sy);
        idx[i] = clampI(Math.round(sy), h) * w + clampI(Math.round(sx), w);
      }
    }
  } else {
    for (let i = 0; i < n; i++) idx[i] = i;
  }

  // 2. Rough edges and ink spread: blur, add grit, cut at a threshold
  const ar = amt(p.rough);
  const sp = Math.max(-1.5, Math.min(1.5, (p.spread / 100) * k));
  const gritCell = Math.max(0.6, p.roughSize * S);
  const rb = (0.5 + p.roughSize * 0.6 * Math.min(1, ar * 3) + Math.abs(sp) * 5) * S;
  const v = new Float32Array(warped);
  blur(v, w, h, rb);
  if (ar > 0) {
    const n1 = valueNoise(w, h, gritCell, gritCell, rng);
    const n2 = valueNoise(w, h, gritCell * 3.5, gritCell * 3.5, rng);
    const gain = ar * 0.75;
    for (let i = 0; i < n; i++) {
      const g = 0.5 * n1[i] + 0.3 * n2[i] + 0.2 * rng();
      // Only near edges, so empty paper stays clean (specks handle stray ink)
      const near = Math.min(1, v[i] * 6) * Math.min(1, (1 - v[i]) * 6);
      v[i] += (g - 0.5) * 2 * gain * near;
    }
  }
  const thr = Math.min(0.92, Math.max(0.08, 0.5 - sp * 0.3));
  const aa = 0.035;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = smooth(thr - aa, thr + aa, v[i]);

  // 3. Worn ink: mottled patches where the ink didn't take
  const aw = amt(p.wear);
  if (aw > 0) {
    const cell = Math.max(1, p.wearSize * S);
    const m1 = valueNoise(w, h, cell, cell, rng);
    const m2 = valueNoise(w, h, cell * 0.3, cell * 0.3, rng);
    const cut = aw * 0.5;
    for (let i = 0; i < n; i++) {
      const g = 0.65 * m1[i] + 0.22 * m2[i] + 0.13 * rng();
      alpha[i] *= smooth(cut - 0.03, cut + 0.03, g);
    }
  }

  // 4. Streaks: thin dry lines from an uneven roller
  const as = amt(p.streaks);
  if (as > 0) {
    const along = 220 * S, across = 1.6 * S;
    const vert = p.streakDir === "vertical";
    const s1 = vert ? valueNoise(w, h, across, along, rng) : valueNoise(w, h, along, across, rng);
    const s2 = vert ? valueNoise(w, h, across * 3, along * 0.3, rng) : valueNoise(w, h, along * 0.3, across * 3, rng);
    const cut = as * 0.42;
    for (let i = 0; i < n; i++) {
      const g = 0.7 * s1[i] + 0.3 * s2[i];
      alpha[i] *= smooth(cut - 0.04, cut + 0.04, g);
    }
  }

  // 5. Specks: flecks of ink near the edges, and pinholes inside
  const ak = amt(p.specks);
  if (ak > 0) {
    const halo = new Float32Array(alpha);
    blur(halo, w, h, 12 * S);
    const count = Math.round(ak * n / 700);
    for (let c = 0; c < count; c++) {
      const x = (rng() * w) | 0, y = (rng() * h) | 0, i = y * w + x;
      const r = (0.5 + Math.pow(rng(), 3) * 3) * S * (1 + ak * 0.4);
      if (alpha[i] < 0.5 && halo[i] > 0.02 && rng() < halo[i] * 4) dot(alpha, idx, w, h, x, y, r, 1, i);
      else if (alpha[i] > 0.5 && rng() < 0.3) dot(alpha, idx, w, h, x, y, r * 0.8, 0, -1);
    }
  }

  // 6. Output: ink colors with alpha
  const out = new Uint8ClampedArray(n * 4);
  const mono = p.colorMode === "mono" ? hexToRgb(p.inkColor) : null;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = alpha[i];
    if (a <= 0.004) continue;
    if (mono) { out[j] = mono[0]; out[j + 1] = mono[1]; out[j + 2] = mono[2]; }
    else { const c = idx[i] * 3; out[j] = col[c]; out[j + 1] = col[c + 1]; out[j + 2] = col[c + 2]; }
    out[j + 3] = a * 255;
  }
  return out;
}

function dot(alpha, idx, w, h, cx, cy, r, val, colorFrom) {
  const R = Math.ceil(r + 1);
  for (let y = Math.max(0, cy - R); y <= Math.min(h - 1, cy + R); y++) {
    for (let x = Math.max(0, cx - R); x <= Math.min(w - 1, cx + R); x++) {
      const dd = Math.hypot(x - cx, y - cy);
      const a = Math.min(1, Math.max(0, r + 0.5 - dd));
      if (a <= 0) continue;
      const i = y * w + x;
      if (val) { if (a > alpha[i]) { alpha[i] = a; if (colorFrom >= 0) idx[i] = idx[colorFrom]; } }
      else alpha[i] *= 1 - a;
    }
  }
}

// ---------- helpers ----------

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function sample(a, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : a[yy * w + xx]);
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bot - top) * fy;
}

// Smooth value noise in 0..1 with separate cell sizes across and down
function valueNoise(w, h, cx, cy, rng) {
  cx = Math.max(0.5, cx); cy = Math.max(0.5, cy);
  const gw = Math.ceil(w / cx) + 2, gh = Math.ceil(h / cy) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const xi = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const f = x / cx; xi[x] = f | 0;
    const t = f - xi[x]; xf[x] = t * t * (3 - 2 * t);
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = y / cy, yi = f | 0;
    let t = f - yi; t = t * t * (3 - 2 * t);
    const r0 = yi * gw, r1 = r0 + gw;
    for (let x = 0; x < w; x++) {
      const a = r0 + xi[x], b = r1 + xi[x], fx = xf[x];
      const top = g[a] + (g[a + 1] - g[a]) * fx;
      const bot = g[b] + (g[b + 1] - g[b]) * fx;
      out[y * w + x] = top + (bot - top) * t;
    }
  }
  return out;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Three box blurs ≈ gaussian blur with the given radius.
function blur(v, w, h, radius) {
  const r = Math.max(1, Math.round(radius / 1.7));
  const tmp = new Float32Array(v.length);
  for (let k = 0; k < 3; k++) {
    boxH(v, tmp, w, h, r);
    boxV(tmp, v, w, h, r);
  }
}

function boxH(src, dst, w, h, r) {
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + clampI(x, w)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / d;
      sum += src[row + clampI(x + r + 1, w)] - src[row + clampI(x - r, w)];
    }
  }
}

function boxV(src, dst, w, h, r) {
  const d = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += src[clampI(y, h) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / d;
      sum += src[clampI(y + r + 1, h) * w + x] - src[clampI(y - r, h) * w + x];
    }
  }
}

function clampI(i, len) {
  return i < 0 ? 0 : i >= len ? len - 1 : i;
}
