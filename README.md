# Soknik

Late-night copy shop for Broken Vow artwork: make faces and skulls, run them through the copier, rough up type on the press. (Kinko's, backwards.)

## Copier

Turns a photo into photocopier-style one-color art: threshold, grain, copy-of-a-copy
degradation, ink spread, dust. Exports a vector SVG or a transparent PNG.

## Generator

Makes photos of faces and skulls lit hard for the copier, using OpenAI's image
API (pay-as-you-go, separate from a ChatGPT subscription). Pick subject, pose,
expression, hair, skull parts, light and background, then send any result to the
copier. A "From a reference" mode takes up to 3 photos as a guide for pose and camera angle only, and makes a new image in the same style. Every image is saved in `generated/` (not uploaded to GitHub) with the
settings used.

Setup: put your OpenAI API key in `.env` (copy `.env.example`). It never leaves
this Mac; the browser talks to `server.py`, which talks to OpenAI.

## Press

Rough up type, logos, vectors or artwork like a worn printing press: rough edges,
ink spread, worn ink, roller streaks, specks, wobble and slice shift. Presets run from
*Barely* (just a slightly imperfect edge) to *Wrecked*, and **Overall amount** dials any
of them up or down. Keeps your colors (or one ink color), drops the paper out, and exports
a PNG with a clear background or a one-color SVG. Transparent PNGs work best; screenshots
on a plain background work too. The Copier's **Rough it up in Press** button sends its
result straight over.

## Use it online

Hosted on GitHub Pages at https://danielmdesigns.github.io/soknik/. Paste your OpenAI key into the box on the
Make tool once per browser; it's saved only in that browser (never on the
site or in this repo), and generated images are kept in that browser too.

## Run it locally

```bash
python3 server.py
```

Then open http://127.0.0.1:5173

Vector tracing uses [esm-potrace-wasm](https://github.com/tomayac/esm-potrace-wasm)
(GPL-2.0, vendored in `vendor/`).
