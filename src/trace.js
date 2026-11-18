import { potrace, init as initPotrace } from "../vendor/esm-potrace-wasm/index.js";

let ready = null;

// canvas: black ink on white. Returns an SVG string with the ink in `color`.
export async function traceSVG(canvas, color) {
  ready ??= initPotrace();
  await ready;
  const { width: w, height: h } = canvas;
  const paths = await potrace(canvas, {
    turdsize: 2, turnpolicy: 4, alphamax: 1, opticurve: 1, opttolerance: 0.2,
    pathonly: true, extractcolors: false,
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
    // potrace paths are in tenth-pixel units with a flipped y axis
    `<g transform="translate(0,${h}) scale(0.1,-0.1)" fill="${color}">\n` +
    `<path d="${paths.join(" ")}"/>\n</g>\n</svg>\n`;
}

export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
