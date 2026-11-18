// Press tab: rough up type, vectors and artwork like a worn printing press.
import { createZoom } from "./zoom.js";
import { traceSVG, download } from "./trace.js";
import { switchTab } from "./generator.js";

const $ = (id) => document.getElementById(id);

const SLIDERS = ["overall", "rough", "roughSize", "spread", "wear", "wearSize",
  "streaks", "specks", "wobble", "wobbleSize", "slice"];

// From barely there to completely wrecked
const PRESETS = {
  barely:      { label: "Barely",      rough: 14, roughSize: 2,   spread: 4,   wear: 5,  wearSize: 6,  streaks: 0,  specks: 3,  wobble: 4,  wobbleSize: 30, slice: 0 },
  letterpress: { label: "Letterpress", rough: 28, roughSize: 3,   spread: 25,  wear: 20, wearSize: 8,  streaks: 8,  specks: 10, wobble: 8,  wobbleSize: 24, slice: 0 },
  worn:        { label: "Worn",        rough: 42, roughSize: 3.5, spread: -15, wear: 48, wearSize: 10, streaks: 30, specks: 22, wobble: 10, wobbleSize: 28, slice: 0 },
  xerox:       { label: "Xeroxed",     rough: 60, roughSize: 2,   spread: 20,  wear: 28, wearSize: 4,  streaks: 15, specks: 55, wobble: 14, wobbleSize: 40, slice: 0 },
  trash:       { label: "Trash",       rough: 72, roughSize: 5,   spread: 15,  wear: 42, wearSize: 14, streaks: 35, specks: 50, wobble: 35, wobbleSize: 30, slice: 22 },
  wrecked:     { label: "Wrecked",     rough: 100, roughSize: 7,  spread: 30,  wear: 58, wearSize: 18, streaks: 55, specks: 85, wobble: 65, wobbleSize: 50, slice: 55 },
};
const presetValues = (key) => { const { label, ...v } = PRESETS[key]; return v; };

const DEFAULTS = {
  ...presetValues("letterpress"), preset: "letterpress", overall: 100,
  streakDir: "horizontal", colorMode: "original", bg: "clear",
  inkColor: "#111111", paperColor: "#efe9dc", size: 1600, seed: 1,
};

const STORE_KEY = "press.settings.v1";
let s = { ...DEFAULTS, ...load() };

let source = null, name = "press", w = 0, h = 0, hasResult = false;
let jobId = 0, pending = false, running = false, comparing = false;

const view = $("pressView");
const vctx = view.getContext("2d");
const inkLayer = document.createElement("canvas");
const worker = new Worker(new URL("./press-worker.js", import.meta.url));

export const pressZoom = createZoom(view);
export const pressHasImage = () => !!source;

function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* blocked */ } }
function status(msg) { $("pressStatus").textContent = msg; }

// ---------- loading ----------

export async function pressLoad(file) {
  if (!file || !file.type.startsWith("image/")) return status("That isn't an image file.");
  try { source = await createImageBitmap(file); } catch { return status("Couldn't read that image."); }
  name = (file.name || "press").replace(/\.[^.]+$/, "") || "press";
  if ($("pressPanel").hidden) switchTab("press");
  $("pressEmpty").hidden = true;
  view.hidden = false;
  $("zoombar").hidden = false;
  document.querySelector(".panel").classList.remove("no-art");
  status("");
  pressZoom.set(null);
  prepare();
}

function prepare() {
  if (!source) return;
  const f = s.size / Math.max(source.width, source.height);
  w = Math.max(1, Math.round(source.width * f));
  h = Math.max(1, Math.round(source.height * f));
  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext("2d");
  cx.imageSmoothingQuality = "high";
  cx.drawImage(source, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h).data;
  view.width = inkLayer.width = w;
  view.height = inkLayer.height = h;
  pressZoom.apply();
  hasResult = false;
  worker.postMessage({ type: "load", rgba: data.buffer, w, h }, [data.buffer]);
  schedule();
}

// ---------- processing ----------

function schedule() {
  if (!source) return;
  pending = true;
  if (!running) run();
}

function run() {
  if (!pending) return;
  pending = false;
  running = true;
  $("busy").hidden = false;
  worker.postMessage({ type: "run", id: ++jobId, p: { ...s } });
}

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "loaded") {
    // Opaque art: use its own paper color for the "Paper" background
    if (m.paper) { s.paperColor = rgbToHex(m.paper); syncControls(); save(); }
    return;
  }
  running = false;
  if (m.w === w && m.h === h) {
    inkLayer.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(m.rgba.buffer), w, h), 0, 0);
    hasResult = true;
    draw();
  }
  if (pending) run();
  else $("busy").hidden = true;
};

worker.onerror = (e) => {
  running = false;
  $("busy").hidden = true;
  status("Processing failed: " + (e.message || "unknown error"));
};

function compose(ctx, withBg) {
  ctx.clearRect(0, 0, w, h);
  if (withBg && s.bg === "paper") { ctx.fillStyle = s.paperColor; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(inkLayer, 0, 0);
}

function draw() {
  if (comparing && source) {
    vctx.clearRect(0, 0, w, h);
    vctx.drawImage(source, 0, 0, w, h);
    return;
  }
  if (hasResult) compose(vctx, true);
}

// ---------- export ----------

function pngBlob() {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  compose(c.getContext("2d"), true);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

async function exportPNG() {
  if (!hasResult) return;
  download(await pngBlob(), `${name}-press.png`);
  status(`Saved ${name}-press.png`);
}

async function copyPNG() {
  if (!hasResult) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob() })]);
    status("Copied. Paste into Photoshop with ⌘V.");
  } catch (err) {
    status("Couldn't copy: " + err.message);
  }
}

async function exportSVG() {
  if (!hasResult) return;
  status("Tracing vector…");
  $("pressSvgBtn").disabled = true;
  try {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d");
    const src = inkLayer.getContext("2d").getImageData(0, 0, w, h).data;
    const img = cx.createImageData(w, h);
    for (let j = 0; j < src.length; j += 4) {
      const v = src[j + 3] > 127 ? 0 : 255;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = v;
      img.data[j + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    const svg = await traceSVG(c, s.inkColor);
    download(new Blob([svg], { type: "image/svg+xml" }), `${name}-press.svg`);
    status(`Saved ${name}-press.svg`);
  } catch (err) {
    console.error(err);
    status("Vector export failed: " + err.message);
  } finally {
    $("pressSvgBtn").disabled = false;
  }
}

// ---------- controls ----------

function rgbToHex(c) { return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""); }

function matchingPreset() {
  return Object.keys(PRESETS).find((k) => Object.entries(presetValues(k)).every(([key, v]) => s[key] === v));
}

function syncControls() {
  for (const k of SLIDERS) {
    const el = $("p_" + k);
    el.value = s[k];
    el.parentElement.querySelector("output").textContent = k === "overall" ? `${s[k]}%` : s[k];
  }
  for (const k of ["streakDir", "colorMode", "bg"]) {
    for (const b of $("p_" + k).querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.v === s[k]);
  }
  const on = matchingPreset();
  for (const b of $("pressPresets").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.v === on);
  $("p_inkColor").value = s.inkColor;
  $("p_paperColor").value = s.paperColor;
  $("p_size").value = String(s.size);
}

function changed() { syncControls(); save(); schedule(); }

export function initPress() {
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement("button");
    b.dataset.v = key;
    b.textContent = p.label;
    b.addEventListener("click", () => { Object.assign(s, presetValues(key)); s.preset = key; changed(); });
    $("pressPresets").append(b);
  }

  for (const k of SLIDERS) {
    const el = $("p_" + k);
    el.addEventListener("input", () => { s[k] = Number(el.value); changed(); });
    // Double-click goes back to the preset you started from
    const label = el.parentElement;
    label.title = "Double-click to reset";
    label.addEventListener("dblclick", (e) => {
      e.preventDefault();
      s[k] = k === "overall" ? 100 : presetValues(s.preset in PRESETS ? s.preset : "letterpress")[k];
      changed();
    });
  }

  for (const k of ["streakDir", "colorMode", "bg"]) {
    for (const b of $("p_" + k).querySelectorAll("button")) {
      b.addEventListener("click", () => {
        s[k] = b.dataset.v;
        syncControls(); save();
        k === "bg" ? draw() : schedule();
      });
    }
  }

  $("p_inkColor").addEventListener("input", (e) => {
    s.inkColor = e.target.value;
    if (s.colorMode !== "mono") s.colorMode = "mono"; // picking an ink means you want one ink
    changed();
  });
  $("p_paperColor").addEventListener("input", (e) => {
    s.paperColor = e.target.value;
    s.bg = "paper";
    syncControls(); save(); draw();
  });
  $("p_size").addEventListener("change", (e) => { s.size = Number(e.target.value); save(); prepare(); });

  $("pressShuffle").addEventListener("click", () => { s.seed = (Math.random() * 1e9) | 0; save(); schedule(); });
  const cmp = $("pressCompare");
  const startCompare = () => { comparing = true; draw(); };
  const endCompare = () => { if (comparing) { comparing = false; draw(); } };
  cmp.addEventListener("pointerdown", startCompare);
  cmp.addEventListener("pointerup", endCompare);
  cmp.addEventListener("pointerleave", endCompare);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && source && !$("pressPanel").hidden &&
        !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(e.target.tagName)) {
      e.preventDefault();
      startCompare();
    }
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") endCompare(); });

  $("pressPngBtn").addEventListener("click", exportPNG);
  $("pressCopyBtn").addEventListener("click", copyPNG);
  $("pressSvgBtn").addEventListener("click", exportSVG);
  $("pressResetBtn").addEventListener("click", () => {
    const keep = { inkColor: s.inkColor, paperColor: s.paperColor, size: s.size, bg: s.bg, colorMode: s.colorMode };
    s = { ...DEFAULTS, ...keep };
    changed();
  });

  $("pressOpenBtn").addEventListener("click", () => $("pressFileInput").click());
  $("pressFileInput").addEventListener("change", (e) => { pressLoad(e.target.files[0]); e.target.value = ""; });

  document.querySelector(".panel").classList.add("no-art");
  syncControls();
}
