import { potrace, init as initPotrace } from "../vendor/esm-potrace-wasm/index.js";
import { initGenerator, switchTab } from "./generator.js";

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  threshold: 128, brightness: 0, contrast: 0, smooth: 1.5,
  grain: 18, grainSize: 1.5, generations: 1, spread: 0, dust: 0, cleanup: 6,
  size: 1600, flip: false, invert: false,
  inkColor: "#111111", paperColor: "#efe9dc", seed: 1,
};

// Color pairs pulled from Broken Vow pieces
const SWATCHES = [
  { ink: "#111111", paper: "#efe9dc", name: "Black on bone" },
  { ink: "#f5ea00", paper: "#121212", name: "Yellow on black" },
  { ink: "#221607", paper: "#5378a8", name: "Brown on blue" },
  { ink: "#f2f2f2", paper: "#2a2a2a", name: "White on charcoal" },
  { ink: "#111111", paper: "#ffffff", name: "Black on white" },
];

const SLIDERS = ["threshold", "brightness", "contrast", "smooth", "grain", "grainSize",
  "generations", "spread", "dust", "cleanup"];

const STORE_KEY = "copier.settings.v1";
let s = { ...DEFAULTS, ...loadSettings() };

let source = null;        // the loaded image (ImageBitmap)
let sourceName = "copier";
let gray = null, gw = 0, gh = 0;
let ink = null;           // latest Uint8Array mask (1 = ink)
let jobId = 0, pending = false, running = false;
let comparing = false;

const view = $("view");
const vctx = view.getContext("2d");
const worker = new Worker(new URL("./worker.js", import.meta.url));

// ---------- settings ----------

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode etc. */ }
}

function syncControls() {
  for (const k of SLIDERS) {
    const el = $(k);
    el.value = s[k];
    el.parentElement.querySelector("output").textContent = s[k];
  }
  $("size").value = String(s.size);
  $("inkColor").value = s.inkColor;
  $("paperColor").value = s.paperColor;
  $("flipBtn").setAttribute("aria-pressed", s.flip);
  $("invertBtn").setAttribute("aria-pressed", s.invert);
}

// ---------- loading ----------

async function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) return setStatus("That isn't an image file.");
  try {
    source = await createImageBitmap(file);
  } catch {
    return setStatus("Couldn't read that image.");
  }
  sourceName = (file.name || "copier").replace(/\.[^.]+$/, "") || "copier";
  switchTab("copier");
  $("empty").hidden = true;
  view.hidden = false;
  document.querySelector(".panel").classList.remove("no-image");
  setStatus("");
  rebuildGray();
}

function rebuildGray() {
  if (!source) return;
  // Scale to the chosen detail size (small scans get upscaled so settings behave the same)
  const f = s.size / Math.max(source.width, source.height);
  gw = Math.max(1, Math.round(source.width * f));
  gh = Math.max(1, Math.round(source.height * f));
  const c = new OffscreenCanvas(gw, gh);
  const cx = c.getContext("2d");
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, gw, gh); // transparent PNGs become white paper
  if (s.flip) { cx.translate(gw, 0); cx.scale(-1, 1); }
  cx.imageSmoothingQuality = "high";
  cx.drawImage(source, 0, 0, gw, gh);
  const d = cx.getImageData(0, 0, gw, gh).data;
  gray = new Float32Array(gw * gh);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  }
  view.width = gw;
  view.height = gh;
  schedule();
}

// ---------- processing ----------

function schedule() {
  if (!gray) return;
  pending = true;
  if (!running) run();
}

function run() {
  if (!pending) return;
  pending = false;
  running = true;
  $("busy").hidden = false;
  const id = ++jobId;
  const { threshold, brightness, contrast, smooth, grain, grainSize, generations,
    spread, dust, cleanup, invert, seed } = s;
  worker.postMessage({
    id, gray, w: gw, h: gh,
    p: { threshold, brightness, contrast, smooth, grain, grainSize, generations,
      spread, dust, cleanup, invert, seed },
  });
}

worker.onmessage = (e) => {
  running = false;
  const { ink: mask, w, h } = e.data;
  if (w === gw && h === gh) {
    ink = mask;
    draw();
  }
  if (pending) run();
  else $("busy").hidden = true;
};

worker.onerror = (e) => {
  running = false;
  $("busy").hidden = true;
  setStatus("Processing failed: " + (e.message || "unknown error"));
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function renderMask(ctx, w, h, inkHex, paperHex) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const [ir, ig, ib] = hexToRgb(inkHex);
  const paper = paperHex ? hexToRgb(paperHex) : null;
  for (let i = 0, j = 0; i < ink.length; i++, j += 4) {
    if (ink[i]) { d[j] = ir; d[j + 1] = ig; d[j + 2] = ib; d[j + 3] = 255; }
    else if (paper) { d[j] = paper[0]; d[j + 1] = paper[1]; d[j + 2] = paper[2]; d[j + 3] = 255; }
    // else: fully transparent
  }
  ctx.putImageData(img, 0, 0);
}

function draw() {
  if (!ink) return;
  if (comparing) {
    vctx.save();
    vctx.clearRect(0, 0, gw, gh);
    if (s.flip) { vctx.translate(gw, 0); vctx.scale(-1, 1); }
    vctx.drawImage(source, 0, 0, gw, gh);
    vctx.restore();
    return;
  }
  renderMask(vctx, gw, gh, s.inkColor, s.paperColor);
}

// ---------- export ----------

function maskCanvas(inkHex, paperHex) {
  const c = document.createElement("canvas");
  c.width = gw; c.height = gh;
  renderMask(c.getContext("2d"), gw, gh, inkHex, paperHex);
  return c;
}

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

let potraceReady = null;
async function exportSVG() {
  if (!ink) return;
  setStatus("Tracing vector…");
  $("svgBtn").disabled = true;
  try {
    potraceReady ??= initPotrace();
    await potraceReady;
    const paths = await potrace(maskCanvas("#000000", "#ffffff"), {
      turdsize: 2, turnpolicy: 4, alphamax: 1, opticurve: 1, opttolerance: 0.2,
      pathonly: true, extractcolors: false,
    });
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${gw}" height="${gh}" viewBox="0 0 ${gw} ${gh}">\n` +
      // potrace paths are in tenth-pixel units with a flipped y axis
      `<g transform="translate(0,${gh}) scale(0.1,-0.1)" fill="${s.inkColor}">\n` +
      `<path d="${paths.join(" ")}"/>\n</g>\n</svg>\n`;
    download(new Blob([svg], { type: "image/svg+xml" }), `${sourceName}-copier.svg`);
    setStatus(`Saved ${sourceName}-copier.svg`);
  } catch (err) {
    console.error(err);
    setStatus("Vector export failed: " + err.message);
  } finally {
    $("svgBtn").disabled = false;
  }
}

function pngBlob() {
  return new Promise((res) => maskCanvas(s.inkColor, null).toBlob(res, "image/png"));
}

async function exportPNG() {
  if (!ink) return;
  download(await pngBlob(), `${sourceName}-copier.png`);
  setStatus(`Saved ${sourceName}-copier.png`);
}

async function copyPNG() {
  if (!ink) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob() })]);
    setStatus("Copied. Paste into Photoshop with ⌘V.");
  } catch (err) {
    setStatus("Couldn't copy: " + err.message);
  }
}

function setStatus(msg) { $("status").textContent = msg; }

// ---------- wiring ----------

for (const k of SLIDERS) {
  $(k).addEventListener("input", (e) => {
    s[k] = Number(e.target.value);
    e.target.parentElement.querySelector("output").textContent = s[k];
    saveSettings();
    schedule();
  });
}

$("size").addEventListener("change", (e) => { s.size = Number(e.target.value); saveSettings(); rebuildGray(); });
$("flipBtn").addEventListener("click", () => { s.flip = !s.flip; syncControls(); saveSettings(); rebuildGray(); });
$("invertBtn").addEventListener("click", () => { s.invert = !s.invert; syncControls(); saveSettings(); schedule(); });
$("reshuffleBtn").addEventListener("click", () => { s.seed = (Math.random() * 1e9) | 0; saveSettings(); schedule(); });

const cmp = $("compareBtn");
const startCompare = () => { comparing = true; draw(); };
const endCompare = () => { if (comparing) { comparing = false; draw(); } };
cmp.addEventListener("pointerdown", startCompare);
cmp.addEventListener("pointerup", endCompare);
cmp.addEventListener("pointerleave", endCompare);

for (const k of ["inkColor", "paperColor"]) {
  $(k).addEventListener("input", (e) => { s[k] = e.target.value; saveSettings(); draw(); });
}

const sw = $("swatches");
for (const p of SWATCHES) {
  const b = document.createElement("button");
  b.className = "swatch";
  b.title = p.name;
  b.setAttribute("aria-label", p.name);
  b.style.background = p.paper;
  const dot = document.createElement("span");
  dot.style.background = p.ink;
  b.append(dot);
  b.addEventListener("click", () => {
    s.inkColor = p.ink; s.paperColor = p.paper;
    syncControls(); saveSettings(); draw();
  });
  sw.append(b);
}

$("svgBtn").addEventListener("click", exportSVG);
$("pngBtn").addEventListener("click", exportPNG);
$("copyBtn").addEventListener("click", copyPNG);
$("resetBtn").addEventListener("click", () => {
  const keep = { inkColor: s.inkColor, paperColor: s.paperColor, size: s.size };
  s = { ...DEFAULTS, ...keep };
  syncControls(); saveSettings(); rebuildGray();
});

$("openBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });

const stage = $("stage");
window.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("dragging"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) stage.classList.remove("dragging"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("dragging");
  loadFile(e.dataTransfer.files[0]);
});
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) loadFile(item.getAsFile());
});

// Space bar = peek at original
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && source && !$("copierPanel").hidden &&
      !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(e.target.tagName)) {
    e.preventDefault();
    startCompare();
  }
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") endCompare(); });

document.querySelector(".panel").classList.add("no-image");
syncControls();
initGenerator({ onUse: loadFile });
