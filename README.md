# tools

Art tools for Broken Vow. Name is a placeholder.

## Copier

Turns a photo into photocopier-style one-color art: threshold, grain, copy-of-a-copy
degradation, ink spread, dust. Exports a vector SVG or a transparent PNG.

Run it locally:

```bash
python3 -m http.server 5173 --bind 127.0.0.1
```

Then open http://127.0.0.1:5173

Coming next: a face and skull generator that feeds straight into the copier.

Vector tracing uses [esm-potrace-wasm](https://github.com/tomayac/esm-potrace-wasm)
(GPL-2.0, vendored in `vendor/`).
