// Face & skull generator: turns dropdown settings into a photo prompt,
// asks the local server (server.py) to generate, and hands results to the copier.

import * as direct from "./direct.js";

const $ = (id) => document.getElementById(id);

// "server": running locally with server.py (key in .env, images in generated/)
// "direct": hosted (e.g. GitHub Pages), key and history live in this browser
let backend = null;
async function detectBackend() {
  if (backend) return backend;
  try {
    const r = await fetch("api/status", { cache: "no-store" });
    const j = r.ok && (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
    backend = j && "keySet" in j ? "server" : "direct";
  } catch {
    backend = "direct";
  }
  return backend;
}
const STORE_KEY = "generator.settings.v4";

const DEFAULTS = {
  subject: "woman", angle: "forward", tilt: "back", framing: "neck",
  expression: "stoic", eyes: "open", age: "20s", hair: "long", hairMotion: "wind",
  skullParts: "full", skullBone: "clean", skullCracks: "none", skullTeeth: "all",
  light: "above", background: "light", photo: "bw", notes: "",
  n: "1", quality: "low", model: "gpt-image-2.6-flare",
  mode: "settings", refWhat: "", refShape: "match",
};

let refs = []; // reference photos for "From a reference": [{ dataUrl, w, h }]

let s = { ...DEFAULTS, ...load() };
let busy = false;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ---------- prompt ----------

const ANGLE = {
  forward: "facing straight toward the camera",
  threeLeft: "head turned in three-quarter view toward the left of the frame",
  profileLeft: "in full side profile facing the left of the frame",
  threeRight: "head turned in three-quarter view toward the right of the frame",
  profileRight: "in full side profile facing the right of the frame",
};
const TILT = {
  level: "head level",
  back: "head tilted back with the chin raised, face angled up toward the light",
  down: "chin tucked down, face angled slightly toward the floor",
  side: "head tilted to one side",
};
const LIGHT = {
  above: "a single hard spotlight directly above and slightly in front",
  upperLeft: "a single hard light from the upper left",
  upperRight: "a single hard light from the upper right",
  side: "a single hard light from one side, leaving the other half of the face in deep shadow",
  below: "a single hard light from below, horror-style",
};
const EXPRESSION = {
  stoic: "a stoic, expressionless face, mouth closed",
  screaming: "screaming with the mouth wide open, face tense",
  anguish: "an anguished expression, brow furrowed, lips parted",
  serene: "a calm, serene expression",
  mouthOpen: "lips slightly parted, expression blank",
  defiant: "a defiant, hard stare",
};
const EYES = {
  open: "eyes open",
  closed: "eyes closed",
  up: "eyes rolled upward",
};
const AGE = { "20s": "in POSS twenties", "30s": "in POSS thirties", "40s": "in POSS forties", old: "in POSS late sixties, with lined skin" };
const HAIR = {
  none: "a completely bald head",
  shaved: "a shaved head",
  cropped: "very short cropped hair",
  short: "short hair",
  long: "long hair",
};
const HAIR_MOTION = {
  still: "",
  wind: "hair blowing hard to one side in a strong wind",
  windLeft: "hair blowing hard toward the left of the frame in a strong wind",
  windRight: "hair blowing hard toward the right of the frame in a strong wind",
  spread: "hair lifted and spread out wide to both sides of the head, fanned out as if floating or caught in an updraft",
  wet: "wet hair slicked back",
  messy: "messy, tangled hair",
};
const SKULL_HAIR = {
  none: "",
  shaved: "",
  cropped: "a thin layer of very short, dry hair",
  short: "short, dry, matted hair",
  long: "long, dry, stringy hair",
};
const FRAMING = {
  close: "tight close-up of the face, filling most of the frame",
  neck: "framed from the top of the head to the base of the neck",
  shoulders: "framed from the top of the head to the shoulders",
};
const SKULL_FRAMING = {
  close: "tight close-up, the bone filling most of the frame",
  neck: "the whole subject in frame, filling about two-thirds of it",
  shoulders: "the whole subject in frame with generous empty space around it",
};
const SKULL_PARTS = {
  full: "a complete real human skull with its lower jaw attached",
  noJaw: "a real human cranium with no lower jaw",
  jawOpen: "a complete real human skull with the lower jaw hanging open",
  jawOnly: "a single real human lower jawbone (mandible) with teeth, on its own",
};
const SKULL_BONE = {
  clean: "clean bone",
  weathered: "old, weathered, stained bone with chips and pits",
  ancient: "ancient, crumbling, eroded bone with flaking edges",
};
const SKULL_CRACKS = {
  none: "",
  some: "a few visible cracks running across it",
  heavy: "covered in deep cracks and fractures",
};
const SKULL_TEETH = {
  all: "",
  some: "several teeth missing",
  most: "most of the teeth missing, only a few left",
};

export function buildPrompt(o = s) {
  const human = o.subject !== "skull";
  const photo = o.photo === "bw" ? "black-and-white photograph" : "color photograph";
  const parts = [];

  if (human) {
    const who = o.subject === "woman" ? "a woman" : "a man";
    const bare = o.hair === "none" || o.hair === "shaved";
    const hair = [HAIR[o.hair], bare ? "" : HAIR_MOTION[o.hairMotion]].filter(Boolean).join(", ");
    parts.push(
      `A studio ${photo} of ${who} ${AGE[o.age].replace("POSS", o.subject === "woman" ? "her" : "his")}, ${ANGLE[o.angle]}, ${TILT[o.tilt]}.`,
      `${cap(EXPRESSION[o.expression])}, ${EYES[o.eyes]}. ${cap(hair)}.`,
      `Bare shoulders and neck, no jewelry, no makeup beyond natural skin.`,
    );
  } else {
    parts.push(
      `A studio ${photo} of ${SKULL_PARTS[o.skullParts]}: ${[SKULL_BONE[o.skullBone], SKULL_CRACKS[o.skullCracks], SKULL_TEETH[o.skullTeeth]].filter(Boolean).join(", ")};`,
      `${ANGLE[o.angle]}, ${o.tilt === "back" ? "tilted back, angled up toward the light" : TILT[o.tilt]}.`,
    );
    if (SKULL_HAIR[o.hair] && o.skullParts !== "jawOnly") {
      const motion = HAIR_MOTION[o.hairMotion];
      parts.push(`${cap(SKULL_HAIR[o.hair])} still attached to the top of the skull${motion ? `, ${motion}` : ""}.`);
    }
  }

  parts.push(
    `${cap(human ? FRAMING[o.framing] : SKULL_FRAMING[o.framing])}, centered, with a little space around the edges.`,
    `Lit by ${LIGHT[o.light]}. Strong chiaroscuro: deep black shadows`,
    human
      ? `in the eye sockets, under the brow, cheekbones, nose and jaw; bright clean highlights on the forehead, cheekbones, bridge of the nose and lips.`
      : `inside the eye sockets, nasal cavity and under the cheekbones and jaw; bright clean highlights on the top of the cranium, brow ridge, cheekbones and teeth.`,
    `Very high contrast with few mid-tones, so the image still reads clearly when reduced to pure black and white on a photocopier.`,
    o.background === "dark"
      ? `Plain, seamless, near-black background, with the subject's edges catching the light so they separate from it.`
      : `Plain, seamless, very light gray background, evenly lit.`,
    `Sharp focus, real photographic texture, 85mm lens. One subject only. No text, no props, no frame.`,
  );
  if (hasHair(o)) {
    parts.push(
      `IMPORTANT: do not crop or cut off the hair. The whole head and every strand of hair,`,
      `including the tips of any hair blowing outward, must be fully inside the frame, with plain background visible`,
      `beyond the outermost hair on the top and both sides. Zoom out as far as needed to fit all of it.`,
    );
  }
  if (human) parts.push(`An anonymous person, not a real or famous individual.`);
  if (o.notes.trim()) parts.push(`Details: ${o.notes.trim()}.`);
  return parts.join(" ");
}

// ---------- reference mode ----------

const REF_BACKGROUND = {
  light: "Plain, light, out-of-focus surroundings with nothing recognizable in them.",
  dark: "Plain, dark, out-of-focus surroundings with nothing recognizable in them, the subject's edges catching the light.",
};

export function buildReferencePrompt(o = s) {
  const photo = o.photo === "bw" ? "black-and-white photograph" : "color photograph";
  const what = o.refWhat.trim() || "the subject described by the current settings";
  return [
    `Create a brand-new, original ${photo}.`,
    `Use the attached reference image${refs.length === 1 ? "" : "s"} ONLY as a guide for the camera position, camera height and distance,`,
    `lens perspective, the subject's pose and body position, and the framing.`,
    `Do not copy the person, face, body details, clothing, tattoos, jewelry, text, logos, background or any other`,
    `specific content from the reference, and do not trace it.`,
    `\n\nWhat is in the new photograph: ${what}.`,
    `\n\nStyle: lit by ${LIGHT[o.light]}. Strong chiaroscuro: deep black shadows and bright, clean highlights that`,
    `define the shapes. Very high contrast with few mid-tones, so the image still reads clearly when reduced to pure`,
    `black and white on a photocopier. ${REF_BACKGROUND[o.background]}`,
    `Sharp focus, real photographic texture. No text, no logos, no frame.`,
    `IMPORTANT: do not crop or cut off the hair or the top of the head. Every strand of hair must be fully inside`,
    `the frame. Any person shown is anonymous, not a real or famous individual.`,
  ].join(" ").replace(/ \n\n/g, "\n\n");
}

function refSize(o) {
  const shapes = { square: "1024x1024", tall: "1024x1536", wide: "1536x1024" };
  if (o.refShape !== "match") return shapes[o.refShape];
  if (!refs.length) return "1024x1024";
  const ratio = refs[0].w / refs[0].h;
  return ratio > 1.2 ? shapes.wide : ratio < 0.83 ? shapes.tall : shapes.square;
}

const currentPrompt = () => (s.mode === "reference" ? buildReferencePrompt() : buildPrompt());
const currentSize = () => (s.mode === "reference" ? refSize(s) : sizeFor(s));

// Shrink reference photos before sending: plenty for pose, much faster to upload
function readRef(file) {
  return new Promise((resolve, reject) => {
    createImageBitmap(file).then((bmp) => {
      const f = Math.min(1, 1536 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * f);
      c.height = Math.round(bmp.height * f);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      resolve({ dataUrl: c.toDataURL("image/jpeg", 0.9), w: c.width, h: c.height });
    }, reject);
  });
}

async function addRefs(files) {
  const imgs = [...files].filter((f) => f.type.startsWith("image/"));
  for (const f of imgs) {
    if (refs.length >= 3) { $("genStatus").textContent = "Up to 3 reference photos."; break; }
    try { refs.push(await readRef(f)); } catch { $("genStatus").textContent = "Couldn't read one of those images."; }
  }
  renderRefs();
  sync();
}

function renderRefs() {
  $("refThumbs").replaceChildren(...refs.map((r, i) => {
    const d = document.createElement("div");
    d.className = "refthumb";
    const img = document.createElement("img");
    img.src = r.dataUrl;
    img.alt = `Reference ${i + 1}`;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove";
    x.setAttribute("aria-label", `Remove reference ${i + 1}`);
    x.addEventListener("click", () => { refs.splice(i, 1); renderRefs(); sync(); });
    d.append(img, x);
    return d;
  }));
  $("refDrop").classList.toggle("has-refs", refs.length > 0);
}

function wireRefs() {
  const drop = $("refDrop");
  drop.addEventListener("click", () => $("refInput").click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("refInput").click(); } });
  $("refInput").addEventListener("change", (e) => { addRefs(e.target.files); e.target.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  // Stop the drop here so it doesn't also open in the copier
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    drop.classList.remove("over");
    document.getElementById("stage").classList.remove("dragging");
    addRefs(e.dataTransfer.files);
  });
}

function cap(t) { return t ? t[0].toUpperCase() + t.slice(1) : t; }

function hasHair(o) {
  if (o.hair === "none" || o.hair === "shaved") return false;
  return !(o.subject === "skull" && o.skullParts === "jawOnly");
}

// Hair that blows out needs room, so widen the canvas instead of cropping it
function sizeFor(o) {
  if (o.subject === "skull" && o.skullParts === "jawOnly") return "1536x1024";
  if (hasHair(o) && o.hairMotion === "spread") return "1536x1024";
  if (hasHair(o) && ["wind", "windLeft", "windRight"].includes(o.hairMotion)) return "1024x1024";
  if (o.framing === "close") return "1024x1024";
  return "1024x1536";
}

function label(o) {
  if (o.subject === "skull") return `skull-${o.skullParts}`;
  return `${o.subject}-${o.expression}`;
}

// ---------- UI ----------

function sync() {
  for (const el of document.querySelectorAll("#genPanel [data-key]")) {
    const k = el.dataset.key;
    if (el.classList.contains("seg")) {
      for (const b of el.querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.v === s[k]);
    } else {
      el.value = s[k];
    }
  }
  const human = s.subject !== "skull";
  for (const el of document.querySelectorAll("#genPanel [data-mode], #genPanel [data-only]")) {
    const modeOk = !el.dataset.mode || el.dataset.mode === s.mode;
    const subjectOk = !el.dataset.only || (el.dataset.only === "human") === human;
    el.hidden = !(modeOk && subjectOk);
  }
  $("promptPreview").textContent = currentPrompt();
}

function wire() {
  for (const el of document.querySelectorAll("#genPanel [data-key]")) {
    const k = el.dataset.key;
    if (el.classList.contains("seg")) {
      el.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        s[k] = b.dataset.v;
        save(); sync();
      });
    } else {
      el.addEventListener(el.tagName === "TEXTAREA" ? "input" : "change", () => {
        s[k] = el.value; save(); sync();
      });
    }
  }
}

async function checkKey() {
  if ((await detectBackend()) === "direct") {
    const ok = direct.keyLooksSet();
    $("keyNote").hidden = true;
    $("keyBox").hidden = ok;
    $("keySet").hidden = !ok;
    return ok;
  }
  try {
    const { keySet } = await (await fetch("api/status", { cache: "no-store" })).json();
    $("keyNote").hidden = keySet;
    return keySet;
  } catch {
    return false;
  }
}

function wireKey() {
  $("keyForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const k = $("keyInput").value.trim();
    if (!direct.keyLooksSet(k)) {
      $("genStatus").textContent = "That doesn't look like an OpenAI key. It should start with sk-";
      return;
    }
    direct.setKey(k);
    $("keyInput").value = "";
    $("genStatus").textContent = "Key saved in this browser.";
    checkKey();
  });
  $("forgetKey").addEventListener("click", () => {
    direct.setKey("");
    $("genStatus").textContent = "Key removed from this browser.";
    checkKey();
  });
}

function tile(item, onUse) {
  const fig = document.createElement("figure");
  fig.className = "tile";
  const img = document.createElement("img");
  img.src = item.url;
  img.alt = item.name;
  img.loading = "lazy";
  const bar = document.createElement("figcaption");
  const use = document.createElement("button");
  use.className = "btn primary";
  use.textContent = "Use in copier";
  use.addEventListener("click", async () => {
    const blob = await (await fetch(item.url)).blob();
    onUse(new File([blob], item.name, { type: blob.type || "image/png" }));
  });
  const dl = document.createElement("a");
  dl.className = "btn";
  dl.href = item.url;
  dl.download = item.name;
  dl.textContent = "Save photo";
  bar.append(use, dl);
  fig.append(img, bar);
  return fig;
}

async function loadHistory(onUse, skip = new Set()) {
  try {
    const items = (await detectBackend()) === "direct"
      ? await direct.history()
      : (await (await fetch("api/history")).json()).items;
    const rest = items.filter((i) => !skip.has(i.name));
    const h = $("history");
    h.replaceChildren(...rest.map((i) => tile(i, onUse)));
    $("histTitle").hidden = rest.length === 0;
  } catch { /* server not running */ }
}

async function generate(onUse) {
  if (busy) return;
  if (!(await checkKey())) {
    $("genStatus").textContent = "Add your OpenAI key first (see the box at the top).";
    return;
  }
  busy = true;
  const btn = $("genBtn");
  btn.disabled = true;
  btn.textContent = "Generating…";
  const n = Number(s.n);
  const fromRef = s.mode === "reference";
  if (fromRef && !refs.length) {
    $("genStatus").textContent = "Add a reference photo first.";
    busy = false; btn.disabled = false; btn.textContent = "Generate";
    return;
  }
  $("genStatus").textContent = `Making ${n} image${n > 1 ? "s" : ""}. This usually takes 20–60 seconds.`;
  const results = $("results");
  results.replaceChildren(...Array.from({ length: n }, () => {
    const p = document.createElement("div");
    p.className = "tile placeholder";
    return p;
  }));
  try {
    const req = {
      prompt: currentPrompt(), model: s.model, quality: s.quality, n,
      size: currentSize(), label: fromRef ? "reference" : label(s), settings: s,
      images: fromRef ? refs.map((r) => r.dataUrl) : undefined,
    };
    let images;
    if ((await detectBackend()) === "direct") {
      const blobs = fromRef ? await direct.fromReference(req) : await direct.generate(req);
      if (!blobs.length) throw new Error("OpenAI returned no images.");
      images = await direct.saveImages(blobs, req.label, { prompt: req.prompt, size: req.size, quality: req.quality, settings: s });
    } else {
      const r = await fetch(fromRef ? "api/reference" : "api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
      images = data.images;
    }
    results.replaceChildren(...images.map((i) => tile(i, onUse)));
    $("genStatus").textContent = "Done. Pick one to send to the copier.";
    loadHistory(onUse, new Set(images.map((i) => i.name)));
  } catch (err) {
    results.replaceChildren();
    $("genStatus").textContent = err.message;
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = "Generate";
  }
}

// For making images inside ChatGPT (covered by a Plus plan) instead of the paid API
async function copyPrompt() {
  const shape = { "1024x1536": "tall portrait (2:3)", "1024x1024": "square", "1536x1024": "wide landscape (3:2)" }[currentSize()];
  const fromRef = s.mode === "reference";
  const n = Number(s.n);
  const text =
    `Generate ${n === 1 ? "an image" : `${n} separate image variations`}, ${shape}. ` +
    `Photorealistic, no illustration or drawing style.\n\n${currentPrompt()}`;
  try {
    await navigator.clipboard.writeText(text);
    $("genStatus").textContent =
      fromRef
        ? "Copied. In ChatGPT, attach your reference photo(s), paste the prompt, then drag the result onto this page."
        : "Copied. Paste it into ChatGPT, download the image, then drag it onto this page — it opens in the Copier.";
  } catch {
    $("genStatus").textContent = "Couldn't copy automatically. Open “See the prompt” below and copy it from there.";
  }
}

const TOOLS = {
  generate: ["Camera", "Generate a face or skull with hard, copier-ready light."],
  copier: ["Copier", "Threshold and photocopy grit, then export vector or PNG."],
  press: ["Press", "Rough up type, logos and artwork like a worn printing press."],
};

export function switchTab(name) {
  $("toolTitle").textContent = TOOLS[name][0];
  $("toolHint").textContent = TOOLS[name][1];
  for (const t of document.querySelectorAll(".rail [data-tab]")) {
    t.setAttribute("aria-selected", t.dataset.tab === name);
  }
  $("genPanel").hidden = name !== "generate";
  $("copierPanel").hidden = name !== "copier";
  $("pressPanel").hidden = name !== "press";
  $("stage").classList.toggle("gen-mode", name === "generate");
  $("stage").classList.toggle("press-mode", name === "press");
  window.dispatchEvent(new Event("tabchange"));
}

export function initGenerator({ onUse }) {
  const use = (file) => { switchTab("copier"); onUse(file); };
  for (const t of document.querySelectorAll(".rail [data-tab]")) {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  }
  wire();
  wireRefs();
  wireKey();
  sync();
  $("genBtn").addEventListener("click", () => generate(use));
  $("copyPromptBtn").addEventListener("click", copyPrompt);
  checkKey();
  loadHistory(use);
  window.addEventListener("focus", checkKey);
}
