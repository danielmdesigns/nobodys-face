// Copier image processing. Runs off the main thread so sliders stay smooth.
// Input: grayscale Float32Array (0 = black, 255 = white) + settings.
// Output: Uint8Array mask where 1 = ink.

self.onmessage = (e) => {
  const { id, gray, w, h, p } = e.data;
  const ink = processImage(gray, w, h, p);
  self.postMessage({ id, ink, w, h }, [ink.buffer]);
};

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

function processImage(src, w, h, p) {
  const n = w * h;
  const scale = Math.max(w, h) / 1600; // keep effects consistent at any detail size
  const rng = mulberry32(p.seed);
  let v = new Float32Array(src);

  // Brightness / contrast
  const c = Math.pow(2, p.contrast / 50);
  const b = p.brightness * 1.28;
  for (let i = 0; i < n; i++) v[i] = (v[i] - 128) * c + 128 + b;

  // Smooth away fine photographic detail
  if (p.smooth > 0) blur(v, w, h, p.smooth * scale);

  const t = p.threshold;
  const grainCell = Math.max(1, p.grainSize * scale);

  // Copy generations: blur, add toner noise, push contrast — a copy of a copy
  for (let g = 0; g < p.generations; g++) {
    blur(v, w, h, 1.1 * scale);
    addNoise(v, w, h, 22, Math.max(1, 1.5 * scale), rng);
    for (let i = 0; i < n; i++) v[i] = (v[i] - t) * 1.7 + t;
  }

  // Grain right before the threshold breaks up edges into speckle
  if (p.grain > 0) addNoise(v, w, h, p.grain * 1.6, grainCell, rng);

  let ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = v[i] < t ? 1 : 0;

  // Ink spread: positive = toner bleed, negative = starved / thin
  const spread = Math.round(Math.abs(p.spread) * scale);
  if (p.spread > 0 && spread > 0) ink = dilate(ink, w, h, spread);
  if (p.spread < 0 && spread > 0) ink = invertMask(dilate(invertMask(ink), w, h, spread));

  // Remove tiny islands of ink and tiny holes
  const minArea = Math.round(p.cleanup * scale * scale);
  if (minArea > 0) {
    removeSmall(ink, w, h, 1, minArea);
    removeSmall(ink, w, h, 0, minArea);
  }

  // Dust and toner specks
  if (p.dust > 0) addDust(ink, w, h, p.dust, scale, rng);

  if (p.invert) for (let i = 0; i < n; i++) ink[i] ^= 1;
  return ink;
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

// Value noise with a given cell size, bilinearly interpolated.
function addNoise(v, w, h, amount, cell, rng) {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = (rng() - 0.5) * 2 * amount;
  if (cell <= 1) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) v[y * w + x] += grid[y * gw + x];
    return;
  }
  for (let y = 0; y < h; y++) {
    const gy = y / cell, y0 = gy | 0, fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = x / cell, x0 = gx | 0, fx = gx - x0;
      const i = y0 * gw + x0;
      const top = grid[i] + (grid[i + 1] - grid[i]) * fx;
      const bot = grid[i + gw] + (grid[i + gw + 1] - grid[i + gw]) * fx;
      v[y * w + x] += top + (bot - top) * fy;
    }
  }
}

function invertMask(m) {
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] ^ 1;
  return out;
}

// Grow ink by r pixels (round-ish brush: square pass then diamond pass).
function dilate(m, w, h, r) {
  let out = dilateSquare(m, w, h, Math.max(1, Math.round(r * 0.7)));
  if (r > 1) out = dilateSquare(out, w, h, Math.max(1, Math.round(r * 0.3)));
  return out;
}

function dilateSquare(m, w, h, r) {
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x <= r && x < w; x++) count += m[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = count > 0 ? 1 : 0;
      if (x + r + 1 < w) count += m[row + x + r + 1];
      if (x - r >= 0) count -= m[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= r && y < h; y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = count > 0 ? 1 : 0;
      if (y + r + 1 < h) count += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) count -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

// Flood-fill connected regions of `val`; flip any smaller than minArea.
function removeSmall(m, w, h, val, minArea) {
  const seen = new Uint8Array(m.length);
  const stack = new Int32Array(m.length);
  const region = [];
  for (let start = 0; start < m.length; start++) {
    if (seen[start] || m[start] !== val) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    region.length = 0;
    let big = false;
    while (sp > 0) {
      const i = stack[--sp];
      if (!big) {
        region.push(i);
        if (region.length >= minArea) big = true;
      }
      const x = i % w;
      const nbrs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of nbrs) {
        if (j >= 0 && j < m.length && !seen[j] && m[j] === val) {
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
    }
    if (!big) for (const i of region) m[i] = val ^ 1;
  }
}

function addDust(m, w, h, amount, scale, rng) {
  const count = Math.round(amount * amount * 0.6 * scale * scale);
  for (let k = 0; k < count; k++) {
    const cx = rng() * w, cy = rng() * h;
    const r = (0.6 + rng() * rng() * 3.5) * scale;
    const val = rng() < 0.75 ? 1 : 0; // mostly toner specks, some white drop-outs
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 0 || x >= w) continue;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) m[y * w + x] = val;
      }
    }
  }
}
