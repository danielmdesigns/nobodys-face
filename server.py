#!/usr/bin/env python3
"""Local server for the tools app.

Serves the web page and forwards image-generation requests to OpenAI so the
API key stays on this Mac (read from .env, never sent to the browser).
Every generated image is saved in generated/ with the settings used.

Run:  python3 server.py   then open http://127.0.0.1:5173
"""

import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GEN_DIR = ROOT / "generated"
PORT = int(os.environ.get("PORT", "5173"))
OPENAI_URL = "https://api.openai.com/v1/images/generations"
OPENAI_EDIT_URL = "https://api.openai.com/v1/images/edits"
MAX_REFS = 3
MAX_BODY = 40 * 1024 * 1024

ALLOWED_MODELS = {"gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}
ALLOWED_SIZES = {"1024x1024", "1024x1536", "1536x1024"}
ALLOWED_QUALITY = {"low", "medium", "high"}


def read_key():
    """Read OPENAI_API_KEY from .env each time, so edits apply without a restart."""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            m = re.match(r"\s*OPENAI_API_KEY\s*=\s*(.*)\s*$", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    return os.environ.get("OPENAI_API_KEY", "").strip()


def key_looks_set(key):
    return key.startswith("sk-") and len(key) > 20


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def is_private(self):
        """Block hidden files (.env, .git…), server code, and anything outside the folder.
        Checked on the real file path, so encoded or ../ tricks don't get around it."""
        target = Path(self.translate_path(self.path)).resolve()
        try:
            rel = target.relative_to(ROOT)
        except ValueError:
            return True
        return any(part.startswith(".") for part in rel.parts) or target.suffix.lower() == ".py"

    def do_HEAD(self):
        if self.is_private():
            self.send_error(404)
            return
        super().do_HEAD()

    def do_GET(self):
        path = self.path.split("?")[0]
        if self.is_private():
            self.send_error(404)
            return
        if path == "/api/status":
            self.send_json(200, {"keySet": key_looks_set(read_key())})
            return
        if path == "/api/history":
            self.send_json(200, {"items": history()})
            return
        super().do_GET()

    def do_POST(self):
        if self.path not in ("/api/generate", "/api/reference"):
            self.send_error(404)
            return
        # Only accept requests from this page, not from other websites
        origin = self.headers.get("Origin", "")
        if origin and not re.match(r"^http://(127\.0\.0\.1|localhost):\d+$", origin):
            self.send_json(403, {"error": "Requests from other sites are blocked."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_BODY:
                self.send_json(413, {"error": "Reference images are too big."})
                return
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Bad request."})
            return

        key = read_key()
        if not key_looks_set(key):
            self.send_json(400, {"error": "No OpenAI key yet. Add it to the .env file in the nobodys-face folder."})
            return
        opts = clean_options(req)
        if not opts["prompt"]:
            self.send_json(400, {"error": "Empty prompt."})
            return

        try:
            if self.path == "/api/generate":
                images = generate(key, opts)
            else:
                refs = decode_refs(req.get("images", []))
                if not refs:
                    self.send_json(400, {"error": "Add at least one reference image."})
                    return
                images = from_reference(key, opts, refs)
        except OpenAIError as e:
            self.send_json(e.status, {"error": str(e)})
            return

        if not images:
            self.send_json(502, {"error": "OpenAI returned no images."})
            return
        self.send_json(200, {"images": save_images(images, req, opts)})


class OpenAIError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def clean_options(req):
    return {
        "prompt": str(req.get("prompt", "")).strip()[:6000],
        "model": req.get("model") if req.get("model") in ALLOWED_MODELS else "gpt-image-2.6-flare",
        "size": req.get("size") if req.get("size") in ALLOWED_SIZES else "1024x1536",
        "quality": req.get("quality") if req.get("quality") in ALLOWED_QUALITY else "medium",
        "n": max(1, min(4, int(req.get("n", 1)))),
    }


def call_openai(key, url, body, content_type):
    api_req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(api_req, timeout=300) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message", "")
        except Exception:
            msg = ""
        raise OpenAIError(e.code, f"OpenAI said: {msg or e.reason}")
    except urllib.error.URLError as e:
        raise OpenAIError(502, f"Couldn't reach OpenAI: {e.reason}")
    return [base64.b64decode(d["b64_json"]) for d in data.get("data", []) if d.get("b64_json")]


def generate(key, o):
    body = json.dumps({
        "model": o["model"], "prompt": o["prompt"], "size": o["size"],
        "quality": o["quality"], "n": o["n"], "output_format": "png",
    }).encode()
    return call_openai(key, OPENAI_URL, body, "application/json")


def decode_refs(items):
    """Reference photos arrive from the browser as data: URLs."""
    refs = []
    for i, item in enumerate(items[:MAX_REFS]):
        m = re.match(r"^data:(image/(png|jpeg|webp));base64,(.+)$", str(item), re.S)
        if not m:
            continue
        ext = "jpg" if m.group(2) == "jpeg" else m.group(2)
        refs.append((f"reference-{i + 1}.{ext}", m.group(1), base64.b64decode(m.group(3))))
    return refs


def from_reference(key, o, refs):
    """One request per image, run side by side, so 'how many' always works."""
    fields = {"model": o["model"], "prompt": o["prompt"], "size": o["size"],
              "quality": o["quality"], "output_format": "png"}
    body, ctype = multipart(fields, refs)
    with ThreadPoolExecutor(max_workers=o["n"]) as pool:
        results = list(pool.map(lambda _: call_openai(key, OPENAI_EDIT_URL, body, ctype), range(o["n"])))
    return [img for r in results for img in r]


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    for filename, mime, data in files:
        out += (f'--{boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="{filename}"\r\n'
                f"Content-Type: {mime}\r\n\r\n").encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def save_images(images, req, o):
    GEN_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    label = re.sub(r"[^a-z0-9]+", "-", str(req.get("label", "subject")).lower()).strip("-")[:40] or "subject"
    saved = []
    for i, png in enumerate(images):
        name = f"{stamp}-{label}-{i + 1}.png"
        (GEN_DIR / name).write_bytes(png)
        meta = {"prompt": o["prompt"], "model": o["model"], "size": o["size"], "quality": o["quality"],
                "references": len(req.get("images", [])), "settings": req.get("settings", {}), "created": stamp}
        (GEN_DIR / f"{name}.json").write_text(json.dumps(meta, indent=2))
        saved.append({"url": f"/generated/{name}", "name": name})
    return saved


def history():
    if not GEN_DIR.exists():
        return []
    files = sorted(GEN_DIR.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"url": f"/generated/{p.name}", "name": p.name} for p in files[:200]]


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Nobody's Face running at http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
