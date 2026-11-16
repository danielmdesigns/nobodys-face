// "Hosted" mode, used when there's no local server (e.g. GitHub Pages):
// the browser talks to OpenAI directly with a key saved only in this browser,
// and generated images are kept in this browser's storage (IndexedDB).

const KEY_STORE = "nobodysface.openaiKey";
const API = "https://api.openai.com/v1/images";

export function getKey() {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
}
export function setKey(k) {
  try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch { /* blocked */ }
}
export const keyLooksSet = (k = getKey()) => k.startsWith("sk-") && k.length > 20;

async function openAI(path, init) {
  let r;
  try {
    r = await fetch(`${API}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${getKey()}`, ...(init.headers || {}) },
    });
  } catch {
    throw new Error("Couldn't reach OpenAI. Check your internet connection.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI said: ${data.error?.message || r.statusText}`);
  return (data.data || []).filter((d) => d.b64_json).map((d) => b64ToBlob(d.b64_json));
}

function b64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

export function generate({ model, prompt, size, quality, n }) {
  return openAI("generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size, quality, n, output_format: "png" }),
  });
}

// One request per image so "how many" always works with references
export async function fromReference({ model, prompt, size, quality, n, images }) {
  const blobs = await Promise.all(images.map((u) => fetch(u).then((r) => r.blob())));
  const one = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ model, prompt, size, quality, output_format: "png" })) fd.append(k, v);
    blobs.forEach((b, i) => fd.append("image[]", b, `reference-${i + 1}.jpg`));
    return openAI("edits", { method: "POST", body: fd });
  };
  const results = await Promise.all(Array.from({ length: n }, one));
  return results.flat();
}

// ---------- history in IndexedDB ----------

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("nobodys-face", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("images", { keyPath: "name" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction("images", mode);
    const out = fn(t.objectStore("images"));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  }));
}

const urls = new Map();
function toItem(rec) {
  if (!urls.has(rec.name)) urls.set(rec.name, URL.createObjectURL(rec.blob));
  return { url: urls.get(rec.name), name: rec.name };
}

export async function saveImages(blobs, label, meta) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const recs = blobs.map((blob, i) => ({
    name: `${stamp}-${label}-${i + 1}.png`, blob, created: Date.now(), meta,
  }));
  try {
    await tx("readwrite", (store) => recs.forEach((r) => store.put(r)));
  } catch { /* storage blocked: still show the images this session */ }
  return recs.map(toItem);
}

export async function history() {
  try {
    const all = await tx("readonly", (store) => store.getAll());
    return all.sort((a, b) => b.created - a.created).slice(0, 200).map(toItem);
  } catch {
    return [];
  }
}
