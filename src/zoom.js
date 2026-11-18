// Zoom + pan for a canvas inside the stage. One controller per tab (Copier, Press);
// the shared zoom bar, wheel and keys talk to whichever tab is showing.

const STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const $ = (id) => document.getElementById(id);

export function createZoom(view) {
  const stage = $("stage");
  let zoom = null; // null = fit to window, otherwise screen px per image px

  const fit = () => Math.min((stage.clientWidth - 56) / view.width, (stage.clientHeight - 56) / view.height, 1);
  const scale = () => zoom ?? fit();

  function apply(anchor) {
    if (!view.width) return;
    const before = anchor ? view.getBoundingClientRect() : null;
    if (zoom === null) {
      stage.classList.remove("zoomed", "pixels");
      view.style.width = view.style.height = "";
    } else {
      stage.classList.add("zoomed");
      stage.classList.toggle("pixels", zoom >= 2);
      view.style.width = `${Math.round(view.width * zoom)}px`;
      view.style.height = `${Math.round(view.height * zoom)}px`;
    }
    $("zoomLabel").textContent = zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`;
    if (before && zoom !== null) {
      const fx = (anchor.x - before.left) / before.width;
      const fy = (anchor.y - before.top) / before.height;
      const after = view.getBoundingClientRect();
      stage.scrollLeft += after.left + fx * after.width - anchor.x;
      stage.scrollTop += after.top + fy * after.height - anchor.y;
    }
  }

  function center() {
    const r = stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function set(z, anchor = center()) {
    zoom = z === null ? null : Math.min(8, Math.max(0.1, z));
    apply(anchor);
  }

  function step(dir, anchor) {
    const cur = scale();
    const next = dir > 0
      ? STEPS.find((z) => z > cur + 0.001) ?? 8
      : [...STEPS].reverse().find((z) => z < cur - 0.001) ?? 0.1;
    set(next, anchor);
  }

  // Drag to pan when zoomed in
  let pan = null;
  view.addEventListener("pointerdown", (e) => {
    if (zoom === null) return;
    pan = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    view.setPointerCapture(e.pointerId);
    stage.classList.add("panning");
  });
  view.addEventListener("pointermove", (e) => {
    if (!pan) return;
    stage.scrollLeft = pan.sl - (e.clientX - pan.x);
    stage.scrollTop = pan.st - (e.clientY - pan.y);
  });
  const endPan = () => { pan = null; stage.classList.remove("panning"); };
  view.addEventListener("pointerup", endPan);
  view.addEventListener("pointercancel", endPan);

  return { apply, set, step, scale };
}

// getActive() returns the zoom controller for the tab that's showing, or null
export function wireZoomBar(getActive) {
  const stage = $("stage");
  $("zoomIn").addEventListener("click", () => getActive()?.step(1));
  $("zoomOut").addEventListener("click", () => getActive()?.step(-1));
  $("zoomFit").addEventListener("click", () => getActive()?.set(null));
  $("zoom100").addEventListener("click", () => getActive()?.set(1));

  // Trackpad pinch, or ⌘/Ctrl + scroll, zooms toward the cursor
  stage.addEventListener("wheel", (e) => {
    const z = getActive();
    if (!(e.ctrlKey || e.metaKey) || !z) return;
    e.preventDefault();
    z.set(z.scale() * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
  }, { passive: false });

  // + / − zoom, 0 fits, 1 is actual pixels
  window.addEventListener("keydown", (e) => {
    const z = getActive();
    if (!z || e.metaKey || e.ctrlKey || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.key === "+" || e.key === "=") z.step(1);
    else if (e.key === "-" || e.key === "_") z.step(-1);
    else if (e.key === "0") z.set(null);
    else if (e.key === "1") z.set(1);
  });
}
